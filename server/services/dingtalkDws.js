// 钉钉 IM 传输层：官方 dws CLI 子进程桥（v1.10.22）。
//
// ============ 为什么是子进程而不是直连 OpenAPI ============
//   钉钉个人聊天记录**没有公开的 OpenAPI**（应用级 token 只能读机器人被 @ 的消息；
//   「会话内容存档」是企业级付费通道）。官方给的唯一「用户身份读自己会话」通道是
//   dws CLI（共创阶段）：OAuth 设备流登录 + 私有 MCP 网关，报文加密、本地解密 ——
//   所以只能以子进程方式调二进制、解析 `--format json` 的输出，没法绕开 CLI 直连。
//   合规口径与飞书侧一致：只走官方通道（官方 OAuth + 官方网关），不逆向、不抓包、
//   不模拟客户端；解除授权时删掉本地令牌，已归档的笔记保留。
//
// ============ 账号隔离：每条连接器一个 DWS_CONFIG_DIR ============
//   dws 的多账号靠「当前 profile」全局状态 + --profile 选择器，业务命令没有 --profile。
//   与其在共享目录里切来切去（两条连接器并发同步会互相踩），不如每条连接器给一个
//   独立配置目录 dataDir/dws-config/<connectorId>/：登录、令牌、当前 profile 全在里面，
//   天然隔离，也便于「解除授权 = 整目录删掉」。
//   注意：令牌文件由 CLI 按机器指纹加密，目录挪到别的机器解不开（同一台机器上没事）。
//
// ============ 只读白名单 ============
//   本模块只会拼出这些子命令：auth status/login/logout、chat +conversation-list、
//   chat +chat-messages、chat message search-advanced、contact user get-self。
//   **发送/撤回/编辑类命令一律不碰** —— 这是归档通道，不是发消息通道。
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { dataDir } = require('../db');

// 二进制的解析顺序沿用 whisperPaths 的定式：
//   DWS_PATH 环境变量（本地开发指向任意位置）> dataDir/dws/bin（手工放置，可覆盖随包版本）
//   > server/dws/<plat>-<arch>（升级包随附 —— server/ 前缀天然过升级白名单）> PATH 里的 dws。
const PROJECT_DWS = path.join(__dirname, '..', 'dws');
const PLAT_DIR = process.platform === 'win32' ? 'win' : process.platform;
const BIN_NAME = process.platform === 'win32' ? 'dws.exe' : 'dws';
const DATA_BIN = path.join(dataDir, 'dws', 'bin', BIN_NAME);
const SHIPPED_BIN = path.join(PROJECT_DWS, `${PLAT_DIR}-${process.arch}`, BIN_NAME);

// 生产容器（精简镜像）常见**没有系统 CA 根**：Go 的 crypto/x509 不像 Node 自带 Mozilla 根集合，
// 系统池为空时连 mcp.dingtalk.com 都过不了 —— x509: certificate signed by unknown authority。
// 升级包随带一份 Mozilla 根证书（server/dws/ca-bundle.crt，含钉钉链的 GlobalSign Root R46），
// 通过 SSL_CERT_FILE 喂给 CLI（Go 在 Linux 认这个环境变量）；用户自己设了的不覆盖。
const CA_BUNDLE = path.join(PROJECT_DWS, 'ca-bundle.crt');

/** CLI 子进程的环境：每连接器独立配置目录 + （需要时）随包根证书 */
function childEnv(connectorId) {
  const env = { ...process.env, DWS_CONFIG_DIR: configDirFor(connectorId) };
  if (!env.SSL_CERT_FILE && fs.existsSync(CA_BUNDLE)) env.SSL_CERT_FILE = CA_BUNDLE;
  return env;
}

// 随包/手放的二进制在 linux 上常常没有可执行位（升级落盘与上传都是 0644），
// 解析到就顺手补一次 0o755（只在非 Windows 做；chmod 失败不拦解析，spawn 失败自然报错）。
const chmodDone = new Set();
function ensureExec(p) {
  if (process.platform === 'win32' || !p || chmodDone.has(p)) return;
  try { fs.chmodSync(p, 0o755); chmodDone.add(p); } catch { /* 只读位置就算了，还有 PATH 兜底 */ }
}

function dwsBinary() {
  const p = process.env.DWS_PATH;
  if (p && fs.existsSync(p)) { ensureExec(p); return p; }
  if (fs.existsSync(DATA_BIN)) { ensureExec(DATA_BIN); return DATA_BIN; }
  if (fs.existsSync(SHIPPED_BIN)) { ensureExec(SHIPPED_BIN); return SHIPPED_BIN; }
  return '';   // 空串 = 交给 PATH 兜底（spawn('dws')）
}
function dwsReady() {
  return !!dwsBinary() || !!whichSync();
}
/** Windows 没有自带 which：用 fs 按常见后缀扫一遍 PATH（只为「装没装」的提示，不追求完备） */
function whichSync() {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try { const f = path.join(dir, 'dws' + ext); if (fs.existsSync(f)) return f; } catch { /* 无权限的目录跳过 */ }
    }
  }
  return '';
}

const configDirFor = (connectorId) => path.join(dataDir, 'dws-config', String(Number(connectorId)));

/**
 * 跑一次 dws 命令并解析输出。业务命令的输出是统一信封 {ok,outcome,data,meta,error}，
 * auth status 那组是自己的一层 {success,authenticated,...} —— 这里只做「跑完 + 收字」，
 * 信封拆包交给调用方（两类形状分开解，不猜）。
 */
function runDws(connectorId, args, { timeoutMs = 120000 } = {}) {
  const bin = dwsBinary();
  const env = childEnv(connectorId);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin || 'dws', args, { env, windowsHide: true });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e && e.message || e), timedOut: false, spawnFail: true });
      return;
    }
    let out = '', err = '', done = false, timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* 已经退了 */ }
    }, Math.max(1000, timeoutMs));
    child.stdout.on('data', (d) => { if (out.length < 4e6) out += d.toString(); });
    child.stderr.on('data', (d) => { if (err.length < 1e6) err += d.toString(); });
    child.on('error', (e) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ code: -1, stdout: out, stderr: err + String(e && e.message || e), timedOut, spawnFail: true });
    });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ code: code == null ? -1 : code, stdout: out, stderr: err, timedOut, spawnFail: false });
    });
  });
}

/** 把 stdout 解析成 JSON 对象；不是 JSON（或空）就返回 null。登录轮询那种人话输出走 stderr，不受影响。 */
function parseJsonOut(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/** 信封里的 error → 给用户看的中文短句（对齐 feishuErrText 的角色，不是复述堆栈） */
function dwsErrText(errObj, fallback = '钉钉 CLI 执行失败') {
  const e = errObj || {};
  const msg = String(e.message || e.hint || '').trim();
  const hint = String(e.hint || '').trim();
  const type = String(e.type || e.category || '');
  if (type === 'auth') return `钉钉登录已失效，请重新扫码登录${msg ? '（' + msg.slice(0, 120) + '）' : ''}`;
  if (type === 'permission') return `钉钉权限不足：${hint || msg || '需要的权限没开通（或主管理员未允许 CLI 访问个人数据）'}`.slice(0, 200);
  if (e.retryAfterSeconds || /rate|限流|频繁/.test(msg)) return `触发钉钉限流，请稍后再试${e.retryAfterSeconds ? `（${e.retryAfterSeconds} 秒后）` : ''}`;
  return (hint || msg || fallback).slice(0, 200);
}

/** 业务信封统一出口：成功给 {ok:true,data,meta}，失败抛带 dws 上下文的 Error */
function unwrapEnvelope(res) {
  const j = parseJsonOut(res.stdout);
  if (!j) {
    const e = new Error(`钉钉 CLI 没有返回 JSON（exit=${res.code}${res.timedOut ? '，超时被杀' : ''}）：${String(res.stderr || '').slice(0, 160)}`);
    e.code = 502; e.dws = { exit: res.code, stderr: String(res.stderr || '').slice(0, 500) };
    throw e;
  }
  if (j.ok === false || j.outcome === 'failure' || (!j.ok && j.error)) {
    const e = new Error(dwsErrText(j.error));
    e.code = (j.error && j.error.type === 'auth') ? 401 : 502;
    e.dws = j.error;
    throw e;
  }
  return j;
}

// ---------- 登录态 ----------
/** 只读查登录态：auth status --readonly（不会迁移/修复本地状态，适合被反复调） */
async function dwsAuthStatus(connectorId) {
  const res = await runDws(connectorId, ['auth', 'status', '--readonly', '--format', 'json'], { timeoutMs: 30000 });
  const j = parseJsonOut(res.stdout);
  if (j && typeof j.authenticated === 'boolean') {
    return {
      authenticated: j.authenticated && j.token_valid !== false,
      corp_id: String(j.corp_id || ''), corp_name: String(j.corp_name || ''),
      user_id: String(j.user_id || ''), user_name: String(j.user_name || ''),
      expires_at: String(j.expires_at || ''), message: String(j.message || ''), reason: String(j.reason || ''),
    };
  }
  return { authenticated: false, corp_id: '', corp_name: '', user_id: '', user_name: '', expires_at: '', message: '无法读取登录状态', reason: 'unreadable' };
}

/** 登录成功后补一次自我介绍：拿 openDingTalkId（消息里发送者用的是这一族 ID，user_id 对不上） */
async function dwsSelfIdentity(connectorId) {
  const res = await runDws(connectorId, ['contact', 'user', 'get-self', '--format', 'json'], { timeoutMs: 30000 });
  try {
    const j = unwrapEnvelope(res);
    const d = j.data || {};
    const inner = d.result || d.user || d;
    return {
      open_dingtalk_id: String(inner.openDingTalkId || inner.openDingtalkId || inner.unionId || ''),
      user_id: String(inner.userId || inner.userid || ''),
      name: String(inner.name || inner.nick || ''),
    };
  } catch { return { open_dingtalk_id: '', user_id: '', name: '' }; }   // 拿不到就算了，只影响「我」的识别精度
}

// ---------- 设备流登录（进行中的登录进程挂在内存 Map 里，一条连接器同时只允许一个） ----------
const logins = new Map();   // connectorId -> { child, output, exitCode, startedAt, finished }
const LOGIN_MAX_MS = 15 * 60 * 1000;   // 授权码本身 900 秒过期，等再久也没意义

function dwsStartLogin(connectorId) {
  const key = String(Number(connectorId));
  const cur = logins.get(key);
  if (cur && cur.exitCode == null) return { started: false, already: true };
  const bin = dwsBinary();
  const env = childEnv(connectorId);
  fs.mkdirSync(path.dirname(configDirFor(connectorId)), { recursive: true });
  let child;
  try {
    child = spawn(bin || 'dws', ['auth', 'login', '--device', '--no-browser', '--format', 'json'], { env, windowsHide: true });
  } catch (e) {
    return { started: false, error: String(e && e.message || e) };
  }
  const st = { child, output: '', exitCode: null, startedAt: Date.now(), finished: false };
  logins.set(key, st);
  child.stdout.on('data', (d) => { if (st.output.length < 20000) st.output += d.toString(); });
  child.stderr.on('data', (d) => { if (st.output.length < 20000) st.output += d.toString(); });
  const finish = (code) => { st.exitCode = code; st.finished = true; try { child.kill(); } catch { /* 已退 */ } };
  child.on('error', () => finish(-1));
  child.on('close', (code) => finish(code == null ? -1 : code));
  setTimeout(() => { if (!st.finished) finish(-1); }, LOGIN_MAX_MS).unref?.();
  return { started: true };
}

function dwsCancelLogin(connectorId) {
  const key = String(Number(connectorId));
  const st = logins.get(key);
  if (!st) return { cancelled: false };
  if (!st.finished) { try { st.child.kill(); } catch { /* 已退 */ } }
  logins.delete(key);
  return { cancelled: true };
}

/** 从登录输出里抽「给用户看的两口」：验证链接（已带授权码）+ 授权码本身 */
function extractLoginBits(text) {
  const t = String(text || '');
  const url = (t.match(/https:\/\/login\.dingtalk\.com\/oauth2\/device\/verify\.htm\?\S+/) || [])[ 0 ] || '';
  const code = (t.match(/授权码[:：]\s*([A-Z0-9]{4}-[A-Z0-9]{4})/) || [])[ 1 ] || '';
  return { url, code };
}

async function dwsLoginProgress(connectorId) {
  const key = String(Number(connectorId));
  const st = logins.get(key) || null;
  const bits = st ? extractLoginBits(st.output) : { url: '', code: '' };
  // 进程结束 ≠ 登录成功（也可能超时/取消）；以 auth status 为准
  let status = null;
  if (!st || st.finished) status = await dwsAuthStatus(connectorId);
  return {
    running: !!st && !st.finished,
    url: bits.url, code: bits.code,
    output: st ? String(st.output).slice(-4000) : '',
    exitCode: st ? st.exitCode : null,
    authenticated: status ? status.authenticated : false,
    identity: status && status.authenticated ? status : null,
  };
}

/** 退出登录并清空本地凭证目录（笔记不动 —— 与飞书侧解除授权的口径一致） */
async function dwsLogout(connectorId) {
  dwsCancelLogin(connectorId);
  try { await runDws(connectorId, ['auth', 'logout', '--format', 'json'], { timeoutMs: 30000 }); } catch { /* 令牌已坏时 logout 报错无所谓，下面直接删目录 */ }
  try { fs.rmSync(configDirFor(connectorId), { recursive: true, force: true }); } catch { /* 删不掉就算了，下次登录会覆盖 */ }
  return { done: true };
}

// ---------- 会话发现 ----------
/**
 * 列当前账号的全部会话（单聊 + 群聊）。对齐飞书 listAllChats 的返回形状：
 * { items: [{ chat_id, name, chat_mode: 'p2p'|'group' }], p2pNote }。
 * conversationType 下层给 'direct'/'group'，这里归一成飞书口径。
 */
async function dwsListChatsFor(connectorId, maxChats = 200) {
  const res = await runDws(connectorId, ['chat', '+conversation-list', '--page-all', '--limit', '100', '--page-delay', '200', '--format', 'json'], { timeoutMs: 120000 });
  const j = unwrapEnvelope(res);
  const d = j.data || {};
  const convs = Array.isArray(d.conversations) ? d.conversations : [];
  const items = convs
    .filter((c) => c && c.openConversationId)
    .slice(0, maxChats)
    .map((c) => ({
      chat_id: String(c.openConversationId),
      name: String(c.conversationName || ''),
      chat_mode: String(c.conversationType) === 'direct' ? 'p2p' : 'group',
    }));
  const partialNote = (d.partial || (d.stopReason && !['source_complete', 'single_page', 'result_limit'].includes(String(d.stopReason))))
    ? `会话列表未拉全（${d.stopReason}${d.hasMore ? '，还有下一页' : ''}），下次同步会接着登记`
    : '';
  return { items, p2pNote: partialNote };
}

// ---------- 拉消息 ----------
/**
 * 拉一个会话自 startSec 起的新消息，映射成**飞书消息形状**（msg_type/body/sender/create_time 毫秒），
 * 让 imService 里同一套 msgText / isCountable / 「我 vs 对方」逻辑原样复用。
 *
 * 群聊走 chat +chat-messages --group <cid>；单聊那条路 CLI 只认 --user/--open-dingtalk-id
 * （会话 ID 进不去），改走 chat message search-advanced --conversation-ids —— 它按官方说明
 * 「群聊或单聊均可」，代价是依赖「消息搜索」权限（个别组织没开通时单聊会同步失败并如实报错）。
 */
async function dwsPullMessages(connectorId, chat, { startSec, endSec, maxMsgs = 2000, pageLimit = 60 }) {
  const startIso = new Date(Number(startSec) * 1000).toISOString();
  const endIso = new Date(Number(endSec) * 1000 - 1).toISOString();
  const isP2p = String(chat.chat_mode || '') === 'p2p';
  const args = isP2p
    ? ['chat', 'message', 'search-advanced', '--conversation-ids', String(chat.chat_id), '--start', startIso, '--end', endIso, '--page-all', '--page-delay', '200', '--format', 'json']
    : ['chat', '+chat-messages', '--group', String(chat.chat_id), '--start', startIso, '--direction', 'newer', '--page-all', '--page-limit', String(pageLimit), '--max-items', String(maxMsgs), '--page-delay', '200', '--no-reactions', '--format', 'json'];
  const res = await runDws(connectorId, args, { timeoutMs: 300000 });
  const j = unwrapEnvelope(res);
  return normalizeDwsMessages(j.data, maxMsgs);
}

/** CLI 的两种消息视图（列表投影 / 搜索视图）→ 飞书形状。容错取行：messages、
 *  conversationMessagesList[].messages（搜索按会话分组）、list/items 等常见信封都认。 */
function normalizeDwsMessages(data, maxMsgs) {
  const d = data || {};
  let rows = [];
  if (Array.isArray(d.conversationMessagesList)) {
    for (const g of d.conversationMessagesList) {
      if (g && Array.isArray(g.messages)) rows.push(...g.messages);
    }
  }
  if (!rows.length) {
    for (const k of ['messages', 'list', 'items', 'records']) {
      if (Array.isArray(d[k])) { rows = d[k]; break; }
      const inner = d[k];
      if (inner && Array.isArray(inner.messages)) { rows = inner.messages; break; }
    }
  }
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const id = String(r.messageId || r.message_id || '');
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    out.push(projectToFeishuShape(r));
  }
  out.sort((a, b) => Number(a.create_time) - Number(b.create_time));
  return out.slice(0, maxMsgs);
}

/** 单条 dws 消息 → 飞书形状。时间统一成毫秒数（飞书口径）；文本类预先渲染成可读文本。 */
function projectToFeishuShape(m) {
  const ms = Number(m.createTime ?? m.create_time ?? m.sendTime ?? 0) || 0;
  const mt = String(m.messageType ?? m.msgType ?? m.msg_type ?? 'text');
  const senderId = String(m.senderId ?? (m.sender && (m.sender.id || m.sender.openDingTalkId)) ?? '');
  const senderName = typeof m.sender === 'string' ? m.sender : String((m.sender && m.sender.name) || m.senderNick || '');
  const rawText = String(m.text ?? '');
  const type = mt.toLowerCase();
  // 文件/图片/音视频：dws 给 resourceRefs（带名字的取名字），正文给占位
  const res = Array.isArray(m.resourceRefs) ? m.resourceRefs : [];
  const resName = (res.find((x) => x && x.name) || {}).name || '';
  let msgType = 'text';
  let content = { text: rawText };
  if (type === 'picture' || type === 'img' || type === 'image') { msgType = 'image'; }
  else if (type === 'audio' || type === 'voice') { msgType = 'audio'; }
  else if (type === 'video') { msgType = 'media'; }
  else if (type === 'file') { msgType = 'file'; content = { file_name: resName }; }
  else {
    // 文本类：引用回复补上「引用了什么」，合并转发展开成一条说明行
    let text = rawText;
    const q = m.quotedMessage;
    if (q && typeof q === 'object') {
      const qt = String(q.text || '').trim();
      if (qt) text = text ? `${text}（引用：${qt.slice(0, 80)}）` : `引用：${qt.slice(0, 80)}`;
    }
    const fwd = Array.isArray(m.forwarded) ? m.forwarded : [];
    if (fwd.length) {
      text = text ? `${text} [转发聊天记录 ${fwd.length} 条]` : `[转发聊天记录 ${fwd.length} 条]`;
    }
    if (m.cryptoLayer && !rawText) text = '[加密消息，本环境无法解密]';
    msgType = 'text';
    content = { text };
  }
  return {
    message_id: String(m.messageId || m.message_id || ''),
    msg_type: msgType,
    body: { content: JSON.stringify(content) },
    create_time: ms,
    sender: { id: senderId, name: senderName },
  };
}

module.exports = {
  dwsBinary, dwsReady, configDirFor,
  runDws, parseJsonOut, unwrapEnvelope, dwsErrText,
  dwsAuthStatus, dwsSelfIdentity,
  dwsStartLogin, dwsCancelLogin, dwsLoginProgress, dwsLogout,
  dwsListChatsFor, dwsPullMessages, normalizeDwsMessages,
};
