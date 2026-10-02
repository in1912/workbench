// 官方小智 MCP 接入点桥接（v1.9.31）——通道 A
//
// 干什么：工作台 server 进程**出站**连到小智云给的 wss 接入点，在那里当一个 MCP 服务端。
// 于是「语音能调工作台」这件事不再需要烧固件——改配置重启即可，agent 改名也立即生效
// （tools/list 每次现算，描述里带的是当前配置的真名）。
//
// 为什么手写而不用现成 npm 包：交付链。升级包 apply 只覆盖拷贝 server/、不跑 npm install，
// 容器镜像基线又冻结在 2026-08-21（composeBuild 实测不重建镜像）——npm 依赖没有任何落地途径。
// Node 22 内置全局 WebSocket，MCP 就是一行一个 JSON-RPC，手写足够。
//
// 三条硬约束（都在下面兑现）：
//   ① 任何异常都不能冒泡打死 server —— 连不上只记状态，面板显示「未连接」。
//   ② 指数退避重连，配置改了主动重连（刷新 tools/list）。
//   ③ 默认关闭；用户在面板显式勾选才连。
const svc = require('./xiaozhiService');
const { buildTools } = require('./xiaozhiTools');

const PROTOCOL_VERSION = '2024-11-05';
const BACKOFF_MIN = 3000;
const BACKOFF_MAX = 300000;
// serverInfo.version 跟着 package.json 走：写死一个版本号，下次发版必忘（v1.9.32 改）
const PKG_VERSION = (() => { try { return require('../../package.json').version || '0.0.0'; } catch { return '0.0.0'; } })();

let ws = null;
let timer = null;
let backoff = BACKOFF_MIN;
let wanted = false;   // 配置层面「该连」——用于区分「主动断开」和「掉线待重连」
let seq = 1;

function log(...a) { console.log('[xiaozhi-mcp]', ...a); }

function setState(patch) { try { svc.setMcpState(patch); } catch { /* 状态回写失败不影响连接 */ } }

function endpoint(cfg) {
  const base = String((cfg.mcp && cfg.mcp.url) || '').trim();
  if (!base) return '';
  // 地址自带 token 就不再追加（否则拼成 ?token=A&token=B）。PUT 校验收紧后正常不会出现，
  // 但手工改过库/配置文件时仍要能连得上，不能拼出个残废 URL。
  if (/[?&]token=/i.test(base)) return base;
  const token = svc.getMcpToken();
  if (!token) return '';
  return base + (base.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

// ---------- JSON-RPC 服务端语义 ----------
function send(obj) {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(JSON.stringify(obj)); } catch (e) { log('发送失败', e.message); }
}
function reply(id, result) { if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, error: { code, message } }); }

function toolResult(message, isError) {
  return { content: [{ type: 'text', text: String(message || '') }], ...(isError ? { isError: true } : {}) };
}

async function callTool(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  if (name === 'self.workbench.ask') return svc.askWorkbench(a.keywords || a.question || a.q);
  if (name === 'self.workbench.delegate') return svc.delegateAgent(a.request || a.text);
  return { ok: false, message: `未知工具 ${name}` };
}

// 「收到一帧该回什么」——纯函数，不碰 socket，方便脱离网络单测
async function respond(msg) {
  const { id, method, params } = msg || {};
  if (!method) return null; // 响应帧（我们没发请求，忽略即可）
  if (method === 'initialize') {
    return { id, result: {
      protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'personal-workbench', version: PKG_VERSION },
    } };
  }
  if (method === 'notifications/initialized' || method === 'initialized') return null;
  if (method === 'ping') return { id, result: {} };
  if (method === 'tools/list') {
    // 每次现算：agent 改名后无需重连也能生效（这是通道 A 相对固件通道的关键优势）
    return { id, result: { tools: buildTools({ agent: svc.getConfig().agent }) } };
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const r = await callTool(name, args);
      return { id, result: toolResult(r && r.message, !(r && r.ok)) };
    } catch (e) {
      log('工具调用异常', name, e.message);
      return { id, result: toolResult(`工具执行失败：${e.message}`, true) };
    }
  }
  // notifications/* 不回；未知 request 回 method not found
  if (id !== undefined && id !== null && !String(method).startsWith('notifications/')) {
    return { id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
  return null;
}

async function handle(msg) {
  const r = await respond(msg);
  if (!r) return;
  if (r.error) return replyError(r.id, r.error.code, r.error.message);
  reply(r.id, r.result);
}

// ---------- 连接生命周期 ----------
function connect() {
  const cfg = svc.getConfig();
  const url = endpoint(cfg);
  if (!url) { setState({ connected: false, last_error: '未配置接入点地址或 token' }); return; }
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return; // 已连/正在连

  let sock;
  try { sock = new WebSocket(url); } catch (e) {
    setState({ connected: false, last_error: `建连失败：${e.message}` });
    return scheduleReconnect();
  }
  ws = sock;
  // 只有「当前这条」socket 的事件才写状态：配置变更会主动关旧连新，旧连接的 close/error
  // 是迟到的回音，若不加判据会把状态灯在已连上之后又打回「未连接」
  const current = () => ws === sock;
  sock.addEventListener('open', () => {
    if (!current()) return;
    backoff = BACKOFF_MIN;
    setState({ connected: true, since: Date.now(), last_error: '' });
    log('已连上接入点');
  });
  sock.addEventListener('message', (ev) => {
    if (!current()) return;
    let msg;
    const raw = typeof ev.data === 'string' ? ev.data : (ev.data && ev.data.toString ? ev.data.toString('utf8') : String(ev.data || ''));
    try { msg = JSON.parse(raw); } catch { log('收到非 JSON 帧，忽略', raw.slice(0, 120)); return; }
    if (Array.isArray(msg)) { msg.forEach((m) => handle(m).catch(() => {})); return; }
    handle(msg).catch((e) => log('处理帧异常', e.message));
  });
  sock.addEventListener('close', () => {
    if (!current()) return;
    setState({ connected: false });
    if (wanted) { log('连接断开，准备重连'); scheduleReconnect(); }
  });
  sock.addEventListener('error', (ev) => {
    if (!current()) return;
    const m = (ev && (ev.message || (ev.error && ev.error.message))) || '未知错误';
    setState({ connected: false, last_error: m });
    log('连接错误', m);
  });
}

function scheduleReconnect() {
  if (!wanted) return;
  if (timer) return;
  const delay = backoff;
  backoff = Math.min(backoff * 2, BACKOFF_MAX);
  timer = setTimeout(() => {
    timer = null;
    if (!wanted) return;
    if (!ws || ws.readyState > 1) connect();
  }, delay);
  // 定时器别拖住进程退出（server 常驻，但测试进程需要能自己结束）
  if (timer.unref) timer.unref();
  log(`将在 ${Math.round(delay / 1000)}s 后重连`);
}

function disconnect() {
  wanted = false;
  if (timer) { clearTimeout(timer); timer = null; }
  backoff = BACKOFF_MIN;
  if (ws) {
    try { ws.close(); } catch { /* 已断 */ }
    ws = null;
  }
  setState({ connected: false });
}

// 配置变化 / 启动时调用：该连就（重）连，不该连就断开。
// 配置改动后**主动重连**是必须的——tools/list 只有在重新握手时才会被云端重新拉取。
function sync(cfg) {
  try {
    const c = cfg || svc.getConfig();
    // 「该连」的判据就一条：endpoint() 拼得出完整 URL（地址有、且 token 有来源）
    const should = !!(c.mcp && c.mcp.enabled) && !!endpoint(c);
    if (!should) return disconnect();
    wanted = true;
    if (ws && ws.readyState === 1) {
      // 已连着但配置变了（比如 agent 改名、换了端点）：重连一次让云端重拉工具表
      log('配置已变，重连以刷新工具表');
      try { ws.close(); } catch { /* 已断 */ }
      ws = null;
    }
    connect();
  } catch (e) {
    log('sync 异常', e.message);
  }
}

module.exports = { sync, disconnect, connect, _handle: handle, _respond: respond };
