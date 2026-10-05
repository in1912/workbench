// 企业微信 IM 传输层：官方 wecom-cli 子进程桥（v1.10.25）。
//
// ============ 通道性质（2026-10-06 实测调研钉死，写集成前必读） ============
//   企业微信「用户授权 → 读个人聊天记录」没有公开 OpenAPI（会话存档是企业级付费通道），
//   官方给的通道是 wecom CLI（npm 包 @wecom/cli，Rust 二进制）：智能机器人凭证
//   （Bot ID + Secret）授权，机器人**代授权人**读其会话。服务目录由服务端 discovery 动态下发，
//   官方文档（README/skills/101750）**全都没写**读历史这组命令 —— 契约以 `--help` 实测为准：
//     · chat groups list   按时间窗枚举有消息的会话（**目前仅群聊**；单聊没有枚举原语）
//     · chat messages list 按会话拉消息（**单聊传对方成员 userid**、群聊传群会话 ID）
//   两条硬边界（服务端硬执行，报错见 wecomErrText）：
//     · 回溯窗只有 **7 天**（begin_time 早于 7 天前直接拒）→ 增量归档没问题，补不了老历史；
//     · **10 人门槛**：>10 人的组织整个 chat 服务被拒（853006 "this tool is not available
//       for your corporation"），个人/小团队（≤10 人）才可用。
//
// ============ 授权：为什么是 PTY 桥 ============
//   `auth init --manual`（输入 Bot ID + Secret）**要求 TTY**，管道 stdin 直接被拒
//   （ValidationError 893001「手动输入需要终端」）。而生产容器里没有交互终端：
//     · Linux（node:22-slim）用 util-linux 的 `script -qec <cmd> /dev/null` 分配 PTY ——
//       util-linux 是 Debian essential 包，slim 镜像自带，无新增依赖；
//     · Windows（本地开发）用 python + pywinpty（server/wecom/auth-tty.py，装过即用）。
//   喂法两平台同构：盯输出，见到 Bot ID 提示写第一行、见到 Secret 提示写第二行。
//   凭证落在 WECOM_CLI_CONFIG_DIR 指定的每连接器独立目录里（credentials.enc +
//   .encryption_key 都在同一目录）→ 目录自包含，整目录拷贝即可迁移（优于钉钉 dws 的设备绑定）。
//
// ============ 只读白名单 ============
//   本模块只会拼出这些子命令：auth show、chat groups list、chat messages list、
//   contact users search。**发送/撤回类（message send / message aibot send）一律不碰**
//   —— 这是归档通道，不是发消息通道（与钉钉侧同一条红线）。
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { dataDir } = require('../db');

// 二进制解析顺序沿用 dingtalkDws 的定式：
//   WECOM_PATH 环境变量（本地开发指向任意位置）> dataDir/wecom/bin（手工放置）
//   > server/wecom/<plat>-<arch>（升级包随附）> PATH 里的 wecom-cli（npm 全局装的 wrapper）。
const PROJECT_WECOM = path.join(__dirname, '..', 'wecom');
const PLAT_DIR = process.platform === 'win32' ? 'win' : process.platform;
const BIN_NAME = process.platform === 'win32' ? 'wecom-cli.exe' : 'wecom-cli';
const DATA_BIN = path.join(dataDir, 'wecom', 'bin', BIN_NAME);
const SHIPPED_BIN = path.join(PROJECT_WECOM, `${PLAT_DIR}-${process.arch}`, BIN_NAME);
// Windows 上 npm 全局装出来的是 wecom-cli.cmd（shell shim），直接 spawn('wecom-cli') 会 ENOENT
const WIN_WRAPPER = path.join(process.env.APPDATA || '', 'npm', 'wecom-cli.cmd');

const chmodDone = new Set();
function ensureExec(p) {
  if (process.platform === 'win32' || !p || chmodDone.has(p)) return;
  try { fs.chmodSync(p, 0o755); chmodDone.add(p); } catch { /* 只读位置就算了，还有 PATH 兜底 */ }
}

function wecomBinary() {
  const p = process.env.WECOM_PATH;
  if (p && fs.existsSync(p)) { ensureExec(p); return p; }
  if (fs.existsSync(DATA_BIN)) { ensureExec(DATA_BIN); return DATA_BIN; }
  if (fs.existsSync(SHIPPED_BIN)) { ensureExec(SHIPPED_BIN); return SHIPPED_BIN; }
  if (process.platform === 'win32' && fs.existsSync(WIN_WRAPPER)) return WIN_WRAPPER;
  return '';   // 空串 = 交给 PATH 兜底（spawn('wecom-cli')，posix 上找得动）
}
function wecomReady() {
  return !!wecomBinary() || !!whichSync();
}
/** Windows 没有自带 which：用 fs 按常见后缀扫一遍 PATH（只为「装没装」的提示，不追求完备） */
function whichSync() {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try { const f = path.join(dir, 'wecom-cli' + ext); if (fs.existsSync(f)) return f; } catch { /* 无权限的目录跳过 */ }
    }
  }
  return '';
}

const configDirFor = (connectorId) => path.join(dataDir, 'wecom-config', String(Number(connectorId)));

/** CLI 子进程的环境：每连接器独立配置目录（凭证、加密密钥、discovery 缓存全在里面） */
function childEnv(connectorId) {
  return { ...process.env, WECOM_CLI_CONFIG_DIR: configDirFor(connectorId) };
}

/** .cmd 走 shell:true 时 node 只做字符串拼接、不转义参数（DEP0190）—— 时间串
 *  （'YYYY-MM-DD HH:MM:SS'）和 --json 的 JSON 体都带空格/引号，不自己加引号就会在
 *  cmd 那一层被拆碎（实测 --begin-time 只剩日期，后面的时间成了独立参数）。
 *  规则：含空格或引号的参数整体加引号，参数内的引号按 cmd 的规矩双写；
 *  目标进程（node/Rust CLI）按 Windows 标准规则解析时双写引号还原成一个字面引号。 */
function shellQuoteArg(a) {
  const s = String(a);
  if (!/[\s"]/.test(s)) return s;
  return '"' + s.replace(/"/g, '""') + '"';
}

/** 跑一次 wecom-cli 命令并收集输出（照 dingtalkDws.runDws 的形状返回） */
function runWecom(connectorId, args, { timeoutMs = 120000 } = {}) {
  const bin = wecomBinary();
  const env = childEnv(connectorId);
  return new Promise((resolve) => {
    let child;
    try {
      // .cmd shim 必须 shell:true 才跑得动（参数要自己转义，见 shellQuoteArg）；真二进制直接 spawn
      child = bin.endsWith('.cmd')
        ? spawn(bin, args.map(shellQuoteArg), { env, windowsHide: true, shell: true })
        : spawn(bin || 'wecom-cli', args, { env, windowsHide: true });
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

/** stdout → JSON。CLI 的业务输出和错误都打在 stdout（日志走 stderr），非 JSON 返回 null。 */
function parseJsonOut(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * 把 CLI 响应剥成纯业务体：每个响应都带 security_notice / extra_identity_context
 * 两个信封字段（CLI 设计给 LLM 用的注入防护语境，跟业务无关），落库前必须剥掉 ——
 * 尤其 extra_identity_context 里有内部 ID，绝不能跟着消息正文进笔记。
 * 顺手把授权人身份抽出来（见 parseIdentity）。
 */
function stripEnvelope(j) {
  if (!j || typeof j !== 'object') return { data: j, identity: null };
  const { security_notice, extra_identity_context, ...rest } = j; // eslint-disable-line no-unused-vars
  return { data: rest, identity: parseIdentity(extra_identity_context) };
}

/** 从 extra_identity_context 解析授权人（「我」的识别全靠它 —— CLI 没有单独的 whoami 命令）。
 *  原文形如「机器人身份：\n名字：IM对接工作台\nID：aib…\n授权真人用户身份：\n名字：温培泉  \nID：wo7…」 */
function parseIdentity(ctx) {
  const t = String(ctx || '');
  if (!t) return null;
  const m = t.match(/授权真人用户身份：\s*\n名字：([^\n]*)\nID：(\S+)/);
  if (!m) return null;
  return { user_name: m[1].trim(), user_id: m[2] };
}

/** 错误 → 用户能照着做的中文话术（对齐 feishuErrText / dwsErrText 的角色） */
function wecomErrText(errObj, raw) {
  const e = errObj || {};
  const code = Number(e.code);
  const msg = String(e.message || e.errmsg || (raw && raw.errmsg) || '').trim();
  // 10 人门槛：>10 人组织整个 chat 服务被拒。这个错在「授权成功」之后才冒出来
  // （授权本身不挑组织规模），不把话说明白用户会在「明明授权了」和「同步被拒」之间打转。
  if (code === 853006 || /not available for your corporation/i.test(msg)) {
    return '企业微信官方限制：聊天记录拉取能力只对 10 人及以下的个人/小团队组织开放，'
      + '这个机器人所在的企业超过 10 人，拉不了会话与消息（其他能力不受影响）。'
      + '要归档企业微信记录，需要在一个小团队组织里另建机器人。';
  }
  if (code === 850016) return '企业微信官方只允许拉取最近 7 天的消息，更早的历史拿不到（时间窗已自动裁到 7 天内，这条一般不该出现）';
  if (code === 853004) return '企业微信访问令牌已失效，请到「IM 连接」里重新点「验证授权」';
  if (code === 853001 || /凭证|secret|bot id/i.test(msg)) return `企业微信凭证没被接受：${msg.slice(0, 120)}`;
  return (msg || '企业微信 CLI 执行失败').slice(0, 200);
}

/**
 * 业务输出统一出口：成功给剥过信封的 body，失败抛带 wecom 上下文的 Error。
 * CLI 的错误有两种形状，都得认（实测 853006 是业务 errcode 透传、不是 {error} 信封）：
 *   ① CLI 自身：{ error: { type, code, message } }（893xxx 段）
 *   ② 后台业务：顶层 errcode/errmsg 直出（如 853006 / 40058）
 */
function unwrapWecom(res) {
  const j = parseJsonOut(res.stdout);
  if (!j) {
    const e = new Error(`企业微信 CLI 没有返回 JSON（exit=${res.code}${res.timedOut ? '，超时被杀' : ''}）：${String(res.stderr || res.stdout || '').slice(0, 160)}`);
    e.code = 502; e.wecom = { exit: res.code, stderr: String(res.stderr || '').slice(0, 500) };
    throw e;
  }
  const errCode = Number(j.errcode);
  if (j.error || (errCode && errCode !== 0)) {
    const e = new Error(wecomErrText(j.error || { code: errCode, message: j.errmsg }, j));
    e.code = (j.error && Number(j.error.code) === 853004) || errCode === 853004 ? 401 : 502;
    e.wecom = j.error || { code: errCode, message: j.errmsg };
    throw e;
  }
  return stripEnvelope(j);
}

// ---------- 登录态 ----------
/** 只读查授权状态：auth show --status 输出单行 authorized/unauthorized */
async function wecomAuthStatus(connectorId) {
  const res = await runWecom(connectorId, ['auth', 'show', '--status'], { timeoutMs: 30000 });
  const s = String(res.stdout || '').trim().toLowerCase();
  return { authenticated: s === 'authorized', raw: s };
}

// ---------- PTY 授权桥 ----------
/**
 * 用 Bot ID + Secret 跑一次 `auth init --manual`（要 TTY，见文件头）。
 * 返回 { ok, output, errorText }；成功与否以随后的 wecomAuthStatus 为准（这里只管喂完收工）。
 */
function wecomInitAuth(connectorId, botId, secret) {
  const bin = wecomBinary();
  // 已有凭证时 CLI 会多弹一层「覆盖确认」，PTY 桥只会喂两问（Bot ID / Secret），卡在第三问上
  // 就是超时。凭证本来就从表单来，直接清掉旧目录最干净（调研时切凭证就是这么做的）。
  try { fs.rmSync(configDirFor(connectorId), { recursive: true, force: true }); } catch { /* 删不掉就赌覆盖确认不弹 */ }
  fs.mkdirSync(configDirFor(connectorId), { recursive: true });
  const env = childEnv(connectorId);
  return new Promise((resolve) => {
    let child;
    try {
      if (process.platform === 'win32') {
        // Windows：python + pywinpty（随包脚本 server/wecom/auth-tty.py；没装 pywinpty 会明确报错）
        const script = path.join(PROJECT_WECOM, 'auth-tty.py');
        child = spawn('python', [script, bin || 'wecom-cli', configDirFor(connectorId), String(botId), String(secret)], { env, windowsHide: true });
      } else {
        // Linux：util-linux 的 script 分配 PTY（Debian essential，slim 镜像自带）
        const cmd = `${bin || 'wecom-cli'} auth init --manual`;
        child = spawn('script', ['-qec', cmd, '/dev/null'], { env });
      }
    } catch (e) {
      resolve({ ok: false, output: '', errorText: String(e && e.message || e) });
      return;
    }
    let out = '', err = '', done = false;
    let sentId = false, sentSecret = false;
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退 */ } }, 90000);
    // 喂入分工：Windows 的喂入在 auth-tty.py 里做（python 盯 PTY 回显写 PTY），
    // 这里再往 python 的 stdin 写没人读；Linux 的 script 直通 PTY，喂入就在这里做。
    const canFeed = process.platform !== 'win32';
    const feed = (chunk) => {
      if (!canFeed) return;
      // 盯 PTY 回显找提示词：dialoguer 的提示带 "Bot ID" / "Secret" 字样（本机实测）。
      // 注意回显里输入的值也会出现（如已填的 Bot ID 字符串含 "Secret" 的极端命名），
      // 所以 Secret 只在已经输完 Bot ID 之后才认。
      if (!sentId && /Bot ID/.test(chunk)) {
        setTimeout(() => { try { child.stdin.write(String(botId) + '\n'); } catch { /* 已关 */ } }, 300);
        sentId = true;
        return;
      }
      if (sentId && !sentSecret && /Secret/.test(chunk)) {
        setTimeout(() => { try { child.stdin.write(String(secret) + '\n'); } catch { /* 已关 */ } }, 300);
        sentSecret = true;
      }
    };
    child.stdout.on('data', (d) => { const s = d.toString(); if (out.length < 20000) out += s; feed(s); });
    child.stderr.on('data', (d) => { if (err.length < 10000) err += d.toString(); });
    const finish = (code) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ ok: Number(code) === 0, output: (out + '\n' + err).slice(-4000), errorText: '' });
    };
    child.on('error', (e) => finish(-1));
    child.on('close', finish);
  });
}

/** 退出登录 = 整目录删掉（凭证 + 密钥都在里面；目录自包含，删了就是干净登出） */
async function wecomLogout(connectorId) {
  try { fs.rmSync(configDirFor(connectorId), { recursive: true, force: true }); } catch { /* 删不掉就算了，下次 init 会覆盖 */ }
  return { done: true };
}

// ---------- 时间口径 ----------
// CLI 的 begin_time/end_time/send_time 全是「北京时间 'YYYY-MM-DD HH:MM:SS'」字符串，
// 而容器时区是 UTC —— 千万别用 Date.parse（它按本地时区解释无时区串，容器里差 8 小时）。
const CST_OFFSET_MS = 8 * 3600 * 1000;
const two = (n) => String(n).padStart(2, '0');
/** 北京时间字符串 ← epoch 毫秒（全程 UTC 字段读，不碰服务器本地时区） */
function cstTime(ms) {
  const d = new Date(Number(ms) + CST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
}
/** epoch 毫秒 ← 北京时间字符串（显式按 +08:00 解析） */
function parseCst(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return 0;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) - CST_OFFSET_MS;
}

// ---------- 会话发现 ----------
/**
 * 按时间窗枚举有消息的会话（chat groups list，**仅群聊** —— 单聊没有枚举原语，
 * 界面上靠「添加单聊」+ contact users search 补）。返回形状对齐飞书 listAllChats。
 * 窗口取「now-7d 之内」：CLI 硬性只认最近 7 天，更早的传了也是被拒。
 */
async function wecomListChatsFor(connectorId, maxChats = 200) {
  const now = Date.now();
  // 留 1 小时余量：边界整 7 天可能被「早于 7 天前」拒掉（实测口径未必精确到秒）
  const begin = cstTime(now - (7 * 86400000 - 3600000));
  const end = cstTime(now);
  const items = [];
  let cursor = '';
  for (let i = 0; i < 30; i++) {
    const args = ['chat', 'groups', 'list', '--begin-time', begin, '--end-time', end];
    if (cursor) args.push('--cursor', cursor);
    const res = await runWecom(connectorId, args, { timeoutMs: 120000 });
    const body = unwrapWecom(res);
    const chats = body.data.chats || [];
    for (const c of chats) {
      if (!c || !c.chat_id) continue;
      items.push({
        chat_id: String(c.chat_id),
        name: String(c.chat_name || c.name || ''),
        chat_mode: 'group',
      });
    }
    if (!body.data.has_more || !body.data.next_cursor || items.length >= maxChats) break;
    cursor = String(body.data.next_cursor);
    await sleep(150);
  }
  return { items: items.slice(0, maxChats), p2pNote: '企业微信官方只提供群聊的会话枚举；单聊要用「添加单聊」按联系人补' };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 拉消息 ----------
/**
 * 拉一个会话自 startMs 起的新消息（chat messages list），投影成**飞书消息形状**
 * （msg_type/body/sender/create_time 毫秒），复用 imService 里同一套
 * msgText / isCountable / 「我 vs 对方」逻辑。单聊的 chat_id 列里存的就是对方 userid，
 * 命令口径一致（单聊传对方成员的 userid），直接透传。
 */
async function wecomPullMessages(connectorId, chat, { startMs, endMs, maxMsgs = 2000 }) {
  // 窗口裁进 7 天内（CLI 硬边界）：起点再早也只准从 7 天前起
  const floor = Date.now() - (7 * 86400000 - 3600000);
  const begin = cstTime(Math.max(Number(startMs) || 0, floor));
  const end = cstTime(Math.min(Number(endMs) || Date.now(), Date.now()));
  const out = [];
  let cursor = '';
  for (let i = 0; i < 60; i++) {
    const args = ['chat', 'messages', 'list', '--chat-id', String(chat.chat_id), '--begin-time', begin, '--end-time', end];
    if (cursor) args.push('--cursor', cursor);
    const res = await runWecom(connectorId, args, { timeoutMs: 300000 });
    const body = unwrapWecom(res);
    const rows = body.data.messages || [];
    for (const m of rows) out.push(projectToFeishuShape(m));
    if (!body.data.has_more || !body.data.next_cursor || out.length >= maxMsgs) break;
    cursor = String(body.data.next_cursor);
    await sleep(150);
  }
  out.sort((a, b) => Number(a.create_time) - Number(b.create_time));
  return out.slice(0, maxMsgs);
}

/** 单条 wecom 消息（CLI 形状）→ 飞书形状。send_time 是北京时间字符串，显式按 +08:00 解析。 */
function projectToFeishuShape(m) {
  const ms = parseCst(m.send_time);
  // 消息类型对齐飞书口径：text 同名；voice→audio；video→media；mixed 拼成文本（飞书侧没这个类型）
  const mt = String(m.msg_type || 'text');
  let msgType = 'text';
  let content = { text: String((m.text && m.text.content) || '') };
  if (mt === 'image') { msgType = 'image'; content = {}; }
  else if (mt === 'voice') { msgType = 'audio'; content = {}; }
  else if (mt === 'video') { msgType = 'media'; content = {}; }
  else if (mt === 'file') { msgType = 'file'; content = { file_name: (m.file && (m.file.file_name || m.file.name)) || '' }; }
  else if (mt === 'mixed') {
    // 图文混排：文本段拼接，图片段用占位 —— 别丢顺序
    const parts = (Array.isArray(m.mixed && m.mixed.items) ? m.mixed.items : []).map((it) => (
      it && it.msg_type === 'text' && it.text ? String(it.text.content || '') : '[图片]'
    ));
    msgType = 'text';
    content = { text: parts.join(' ') };
  }
  return {
    message_id: `${ms}-${String(m.user_name || '')}`.slice(0, 64),   // CLI 不给消息 ID，用时间+发送者拼一个去重键
    msg_type: msgType,
    body: { content: JSON.stringify(content) },
    create_time: ms,
    sender: { id: String(m.userid || ''), name: String(m.user_name || '') },   // wecom 直接给发送者姓名
  };
}

// ---------- 通讯录搜索（添加单聊用） ----------
/** 按姓名搜组织成员，给前端「添加单聊」做选择器。只读。 */
async function wecomContactSearch(connectorId, keywords, limit = 20) {
  const res = await runWecom(connectorId, ['contact', 'users', 'search', '--json', JSON.stringify({ keywords: [String(keywords || '').trim()] })], { timeoutMs: 60000 });
  const body = unwrapWecom(res);
  return (body.data.users || []).slice(0, Number(limit) || 20).map((u) => ({
    userid: String(u.userid || ''),
    name: String(u.name || ''),
    alias: String(u.alias || ''),
    departments: Array.isArray(u.departments) ? u.departments.map(String) : [],
  }));
}

/** 验证授权顺带拿一次身份：随便跑一个最便宜的只读命令，从响应信封里解析授权人 ID。
 *  chat groups list 的窗口给最小合法值（now-7d ~ now），0 会话也带 extra_identity_context。 */
async function wecomSelfIdentity(connectorId) {
  try {
    const res = await runWecom(connectorId, ['chat', 'groups', 'list', '--begin-time', cstTime(Date.now() - (7 * 86400000 - 3600000)), '--end-time', cstTime(Date.now())], { timeoutMs: 60000 });
    const body = unwrapWecom(res);
    return body.identity || null;
  } catch { return null; }   // 拿不到就算了，只影响「我」的识别精度（都显示成群成员/对方）
}

module.exports = {
  wecomBinary, wecomReady, configDirFor,
  runWecom, parseJsonOut, unwrapWecom, stripEnvelope, wecomErrText,
  wecomAuthStatus, wecomInitAuth, wecomLogout,
  wecomListChatsFor, wecomPullMessages, wecomContactSearch, wecomSelfIdentity,
  cstTime, parseCst, projectToFeishuShape,
};
