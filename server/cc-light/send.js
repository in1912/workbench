// CC-LIGHT 指示灯命令发送器 (Claude Code / Codex CLI hooks 入口, 兼手动测试)
// 用法:
//   node send.js <mode>       直接指定模式 (demo/thinking/ai/busy/success/error/alarm/traffic/all/off)
//   node send.js post         PostToolUse: 读 stdin 钩子 JSON → 命令失败=error, 否则=ai
//   node send.js notify       Notification(Claude): 读 stdin JSON → 涉及权限确认=alarm
// 说明: 只发 UDP 给本机守护进程(daemon.py), 不等回复, 快进快出, 不阻塞工具调用。
//       两个 CLI 的事件 JSON 同构(tool_response 等字段同名), post 对两者通用。
'use strict';
const dgram = require('dgram');
const PORT = 7878;

function fire(mode) {
  const s = dgram.createSocket('udp4');
  s.send(Buffer.from('MODE:' + mode + '\n'), PORT, '127.0.0.1', () => {
    try { s.close(); } catch (e) {}
    process.exit(0);
  });
  // 兜底: UDP 到本机不会超过 2 秒
  setTimeout(() => process.exit(0), 2000).unref();
}

function readStdin(cb) {
  let raw = '';
  if (process.stdin.isTTY) return cb(raw);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => cb(raw));
  process.stdin.on('error', () => cb(raw));
}

const arg = (process.argv[2] || '').toLowerCase();

if (arg === 'post') {
  readStdin((raw) => {
    let m = 'ai';
    try {
      const j = JSON.parse(raw || '{}');
      const tr = j.tool_response ?? j.tool_result;   // Claude 字段 / WorkBuddy 字段
      const txt = typeof tr === 'string' ? tr : JSON.stringify(tr || '');
      if (
        /"is_error"\s*:\s*true/.test(txt) ||
        /"error"\s*:/.test(txt) ||
        /Exit code [1-9]\d*/i.test(txt) ||
        /command not found/i.test(txt) ||
        /Traceback \(most recent call last\)/.test(txt) ||
        /SyntaxError:|IndentationError:|ModuleNotFoundError:|FileNotFoundError:/.test(txt)
      ) m = 'error';
    } catch (e) {}
    fire(m);
  });
} else if (arg === 'notify') {
  readStdin((raw) => {
    let m = '';
    try {
      const j = JSON.parse(raw || '{}');
      const msg = String(j.message || '');
      // Claude Code 权限确认/等待输入 → 红黄警灯; 其余通知忽略(不改变当前灯态)
      if (/permission|approval|approve|允许|权限/i.test(msg)) m = 'alarm';
    } catch (e) {}
    if (m) fire(m);
    else process.exit(0);
  });
} else if (/^(demo|thinking|ai|busy|success|error|alarm|traffic|all|off)$/.test(arg)) {
  fire(arg);
} else {
  process.exit(0);
}
