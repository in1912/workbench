// 一次性协议探针：摸清官方小智 MCP 接入点的 wss 到底怎么握手（v1.9.31 Phase 0）
//
// 用途：在投入 xiaozhiMcpBridge 之前，用最小代码验证「通不通」，并把每一帧原样留档。
//   node scripts/spike-xiaozhi-mcp.mjs "wss://api.xiaozhi.me/mcp/?token=xxx"
//   （token 也可以走环境变量 XZ_TOKEN；地址里带 token 时二选一）
//
// 判定标准：
//   · 收到 initialize / tools/list 请求并成功回包 → 通，走通道 A（不用烧固件）
//   · 连不上 / 握手被拒 / 一直是哑的 → 不通，走通道 B（固件）
//
// 两件事同时做，因为不能确定谁是握手发起方：
//   ① 当服务端：谁来请求就按 MCP 规范回（initialize / tools/list / tools/call / ping）
//   ② 8 秒内没人来：主动发一次 initialize + tools/list，看云端认不认
// 每一帧都写 Logs/spike-mcp-frames.jsonl，事后可复盘。
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const rawUrl = process.argv[2] || process.env.XZ_URL || '';
const token = process.env.XZ_TOKEN || '';
if (!rawUrl) {
  console.error('用法: node scripts/spike-xiaozhi-mcp.mjs "wss://api.xiaozhi.me/mcp/" [--token=xxx]');
  process.exit(2);
}
const argTok = process.argv.find((a) => a.startsWith('--token='));
const finalToken = token || (argTok ? argTok.slice(8) : '');
const url = finalToken && !/[?&]token=/.test(rawUrl)
  ? rawUrl + (rawUrl.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(finalToken)
  : rawUrl;

const LOG_DIR = path.join(process.cwd(), 'Logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'spike-mcp-frames.jsonl');
const t0 = Date.now();
const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
function record(dir, data) {
  const row = { t: new Date().toISOString(), dir, data };
  fs.appendFileSync(LOG_FILE, JSON.stringify(row) + '\n');
  const s = typeof data === 'string' ? data : JSON.stringify(data);
  console.log(`${ts()} ${dir} ${s.length > 500 ? s.slice(0, 500) + '…' : s}`);
}

console.log(`探针启动 → ${url.replace(/token=[^&]+/, 'token=***')}`);
console.log(`帧记录 → ${LOG_FILE}\n`);

const TOOLS = [
  {
    name: 'self.workbench.ask',
    description: '查询用户个人数据库（笔记/待办/邮件/文件等）。传简短关键词，别传整句。',
    inputSchema: { type: 'object', properties: { keywords: { type: 'string' } }, required: ['keywords'] },
  },
  {
    name: 'self.workbench.delegate',
    description: '把任务转交用户家里的私人 agent。仅在用户点名时调用。',
    inputSchema: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'] },
  },
];

let seq = 1;
let sawTraffic = false;

const ws = new WebSocket(url);

function send(obj) {
  record('<<', obj);
  try { ws.send(JSON.stringify(obj)); } catch (e) { console.error('发送失败', e.message); }
}
function reply(id, result) { if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, result }); }

async function handle(msg) {
  sawTraffic = true;
  const { id, method, params } = msg || {};
  if (!method) return;
  console.log(`   ↳ method=${method}${id !== undefined ? ` id=${id}` : ' (notification)'}`);
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: (params && params.protocolVersion) || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'personal-workbench-spike', version: '0.0.1' },
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') return reply(id, {});
  if (method === 'tools/list') return reply(id, { tools: TOOLS });
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    // 探云端对「工具执行耗时」的容忍上限：让 ask 支持 sleep_ms
    const sleep = Number(args.sleep_ms) || 0;
    if (sleep > 0) {
      console.log(`   ↳ 故意睡 ${sleep} ms，看云端多久放弃…`);
      await new Promise((r) => setTimeout(r, sleep));
    }
    return reply(id, {
      content: [{ type: 'text', text: `探针收到 ${name}，参数 ${JSON.stringify(args)}${sleep ? `，已睡 ${sleep}ms` : ''}` }],
    });
  }
  if (id !== undefined && id !== null && !String(method).startsWith('notifications/')) {
    return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

ws.addEventListener('open', () => {
  console.log(`${ts()} ✅ WebSocket 已连上\n`);
  // 8 秒静默则主动试探（我们不知道谁该先开口）
  setTimeout(() => {
    if (sawTraffic) { console.log(`\n${ts()} 云端一直在说话，说明我们是服务端 —— 不用主动发起。`); return; }
    console.log(`\n${ts()} 8 秒没动静，主动发一次 initialize + tools/list 试探…`);
    send({ jsonrpc: '2.0', id: seq++, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'spike', version: '0.0.1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: seq++, method: 'tools/list' });
  }, 8000);
});
ws.addEventListener('message', (ev) => {
  const raw = typeof ev.data === 'string' ? ev.data : String(ev.data || '');
  let msg;
  try { msg = JSON.parse(raw); } catch { record('>>', `[非 JSON] ${raw}`); return; }
  record('>>', msg);
  if (Array.isArray(msg)) { msg.forEach((m) => handle(m).catch((e) => console.error(e.message))); return; }
  handle(msg).catch((e) => console.error('处理帧异常', e.message));
});
ws.addEventListener('error', (ev) => {
  const m = (ev && (ev.message || (ev.error && ev.error.message))) || '未知（看 close 事件）';
  console.error(`${ts()} ❌ 连接错误: ${m}`);
});
ws.addEventListener('close', (ev) => {
  console.log(`\n${ts()} 连接关闭: code=${ev.code} reason=${ev.reason || '(空)'}`);
  console.log(`帧记录已存 ${LOG_FILE}`);
  console.log(sawTraffic ? '结论：有过双向流量 —— 协议基本可用，细看帧内容。' : '结论：全程没有收到任何帧 —— 要么握手方式不对，要么 token/地址不对。');
  process.exit(0);
});

// 90 秒后自己收摊，别挂着
setTimeout(() => {
  console.log(`\n${ts()} 90 秒到，主动退出。`);
  try { ws.close(); } catch { /* 已断 */ }
  process.exit(0);
}, 90000);
