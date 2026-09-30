#!/usr/bin/env node
// WorkBuddy hook → Agent light 指示灯转发器（自包含，装进 WorkBuddy 插件目录用）
// 与 Claude/Codex 共用同一条链路: forward.mjs → UDP 127.0.0.1:7878(MODE:词) → daemon.py → BLE → 板子
// 规则(照 WorkBuddy 插件规范): 永远 exit 0; 失败静默——灯是辅助显示, 不能阻塞 AI 会话。
// 单测: echo '{"hook_event_name":"Stop"}' | node workbuddy-forward.mjs   → 板子变绿灯
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.CODEBUDDY_PLUGIN_ROOT || path.dirname(here);

// ---- 配置（插件目录里 light-config.json 可随时改, 无需动 hooks.json）----
let cfg = { host: '127.0.0.1', port: 7878 };
try { cfg = { ...cfg, ...JSON.parse(fs.readFileSync(path.join(ROOT, 'light-config.json'), 'utf8')) }; } catch {}

// ---- WorkBuddy 事件 → Agent light 灯效模式 ----
// 与 Claude 侧一致: SessionStart→demo 轮播(自带自检), Stop→success, SessionEnd→off;
// PostToolUse 先按 ai 处理, 命中失败启发式则 error; Notification→alarm(启发式, 可在
// hooks.json 里加 matcher 收窄)。
const MAP = {
  SessionStart: 'demo',
  UserPromptSubmit: 'thinking',
  PreToolUse: 'busy',
  PostToolUse: 'ai',
  Stop: 'success',
  Notification: 'alarm',
  SessionEnd: 'off',
};

// PostToolUse 失败启发式(WorkBuddy 字段是 tool_result, Claude 是 tool_response, 都认)
const FAIL_RE = /"is_error"\s*:\s*true|"error"\s*:|exit code\s*[1-9]\d*|command not found|traceback \(most recent call last\)|syntaxerror:|modulenotfounderror:|filenotfounderror:|permission denied|failed|denied/i;

// ---- 兜底强退(钩子超时 5s, 脚本自保 2.5s) ----
setTimeout(() => process.exit(0), 2500);

let raw = '';
if (process.stdin.isTTY) process.exit(0); // 手动双击运行: 无输入直接退
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  let mode = '';
  try {
    const j = JSON.parse(raw || '{}');
    const ev = j.hook_event_name || '';
    mode = MAP[ev] || '';
    if (ev === 'PostToolUse') {
      const r = j.tool_result ?? j.tool_response ?? '';
      if (FAIL_RE.test(typeof r === 'string' ? r : JSON.stringify(r))) mode = 'error';
    }
  } catch { /* 解析失败就什么都不发, 保持当前灯态 */ }
  if (mode) {
    try {
      const s = dgram.createSocket('udp4');
      s.send(Buffer.from('MODE:' + mode + '\n'), cfg.port, cfg.host, () => {
        try { s.close(); } catch {}
        process.exit(0);
      });
    } catch { process.exit(0); }
  } else {
    process.exit(0);
  }
});
