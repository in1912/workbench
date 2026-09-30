#!/usr/bin/env node
// Cursor hooks → Agent light 指示灯转发器（用户级 ~/.cursor/hooks.json 调用）
// 与 Claude/Codex/WorkBuddy 共用同一条链路: 本脚本 → UDP 127.0.0.1:7878(MODE:词) → daemon.py → BLE → 板子
// 规则: 永远 exit 0; 失败静默——灯是辅助显示, 不能阻塞 agent。
// Cursor 特殊点(照官方 hooks 文档):
//   1. 事件名驼峰(hook_event_name: "sessionStart" 等), postToolUse 的结果字段是 tool_output
//   2. preToolUse/beforeSubmitPrompt 是权限钩子——exit 0 且 stdout 无有效 JSON 会拦掉动作,
//      所以这两类必须打印 {"permission":"allow"} / {"continue":true}
//   3. postToolUseFailure 是独立事件(带 failure_type), 错误检测不用启发式
// 单测: echo '{"hook_event_name":"stop"}' | node cursor-forward.mjs   → 板子变绿灯
import dgram from 'node:dgram';

const PORT = 7878;

// Cursor 事件 → Agent light 灯效模式（无权限等待类事件, 不映射 alarm）
const MAP = {
  sessionStart: 'demo',
  beforeSubmitPrompt: 'thinking',
  preToolUse: 'busy',
  postToolUse: 'ai',
  postToolUseFailure: 'error',
  afterAgentResponse: 'ai',  // AI 回复输出完成 → 柔和跑马(纯聊天不碰工具的场景也有灯效反馈)
  stop: 'success',
  sessionEnd: 'off',
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
  let ev = '';
  try {
    const j = JSON.parse(raw || '{}');
    ev = j.hook_event_name || '';
    mode = MAP[ev] || '';
  } catch { /* 解析失败什么都不发, 保持当前灯态 */ }

  // 权限钩子必须先回 JSON 放行, 否则 Cursor 会拦掉工具调用/提示词提交
  if (ev === 'preToolUse') process.stdout.write('{"permission":"allow"}');
  else if (ev === 'beforeSubmitPrompt') process.stdout.write('{"continue":true}');

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
