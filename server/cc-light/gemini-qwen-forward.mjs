#!/usr/bin/env node
// Gemini CLI / Qwen Code hooks → Agent light 指示灯转发器(统一一个文件服务两家)
//   ~/.gemini/settings.json 与 ~/.qwen/settings.json 的 hooks 段调用
// 与其他 agent 共用同一条链路: 本脚本 → UDP 127.0.0.1:7878(MODE:词) → daemon.py → BLE → 板子
// 规则: 永远 exit 0; stdout 一个字都不打印(两家官方都规定 stdout 只能是 JSON,
//       观察型钩子输出为空 + exit 0 = 默认放行); 失败静默——灯是辅助显示, 不阻塞 agent。
// 两家事件名不同(已对照官方 hooks 文档核实):
//   Gemini CLI: SessionStart/BeforeAgent/BeforeTool/AfterTool/AfterAgent/Notification/SessionEnd
//     - Notification.notification_type 目前只有 "ToolPermission"(权限等待) → alarm
//     - AfterTool.tool_response 自带结构化 error 字段 → 失败检测不用正则启发式
//     - timeout 单位是毫秒(安装器写 5000)
//   Qwen Code(Gemini CLI 兄弟分支, 但事件沿 Claude 命名):
//     SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/PostToolUseFailure/Stop/StopFailure/
//     PermissionRequest/Notification/SessionEnd
//     - PostToolUseFailure 是独立失败事件 → 精准红灯; StopFailure = API 出错 → 红灯
//     - PermissionRequest = 权限弹窗出现 → alarm; Notification 只认 permission_prompt
//     - 命令钩子支持 async:true(后台执行不阻塞主流程), 安装器已开启
// 单测: echo '{"hook_event_name":"Stop"}' | node gemini-qwen-forward.mjs   → 板子变绿灯
import dgram from 'node:dgram';

const PORT = 7878;

// hook_event_name → 灯效(两家命名混排; 特判的事件不在表里)
const MAP = {
  SessionStart: 'demo',        // 会话开启(两家同名)
  SessionEnd: 'off',           // 会话结束(两家同名)
  BeforeAgent: 'thinking',     // Gemini: 用户提交提示词, 规划前
  UserPromptSubmit: 'thinking',// Qwen:   用户提交提示词
  BeforeTool: 'busy',          // Gemini: 即将执行工具
  PreToolUse: 'busy',          // Qwen:   即将执行工具
  AfterTool: null,             // Gemini: 工具结束 → 读 tool_response.error 特判(结构化)
  PostToolUse: 'ai',           // Qwen:   工具成功执行(失败走下面的独立事件)
  PostToolUseFailure: 'error', // Qwen:   工具失败(独立事件, 无需启发式)
  StopFailure: 'error',        // Qwen:   API/网络错误中断回合
  Stop: 'success',             // Qwen:   回合完成
  AfterAgent: 'success',       // Gemini: 回合最终回复完成
  PermissionRequest: 'alarm',  // Qwen:   权限弹窗等待确认 → 红黄警灯
};

// ---- 兜底强退 ----
setTimeout(() => process.exit(0), 2500);

let raw = '';
if (process.stdin.isTTY) process.exit(0);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  let mode = '';
  try {
    const j = JSON.parse(raw || '{}');
    const ev = j.hook_event_name || '';
    if (ev === 'AfterTool') {
      // Gemini 结构化失败检测: tool_response.error 字段存在即失败, 不做正则
      const tr = j.tool_response;
      mode = (tr && tr.error) ? 'error' : 'ai';
    } else if (ev === 'Notification') {
      // Gemini: notification_type="ToolPermission"; Qwen: "permission_prompt"
      // 其余通知(idle_prompt/auth_success 等)不改变当前灯态
      const t = String(j.notification_type || '');
      if (t === 'ToolPermission' || t === 'permission_prompt') mode = 'alarm';
    } else {
      mode = MAP[ev] || '';
    }
  } catch { /* 解析失败什么都不发, 保持当前灯态 */ }

  const done = () => process.exit(0);
  if (mode) {
    try {
      const s = dgram.createSocket('udp4');
      s.send(Buffer.from('MODE:' + mode + '\n'), PORT, '127.0.0.1', () => {
        try { s.close(); } catch {}
        done();
      });
    } catch { done(); }
  } else {
    done();
  }
});
