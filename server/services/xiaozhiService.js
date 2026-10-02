// 智能板（小智 Korvo2V3）配置 + 语音→米家桥接（v1.9.11）
// 职责：① 智能板 tab 配置读写（settings.xiaozhi_config）；
// ② 桥接密钥（settings.xiaozhi_bridge_key，照 vibe_client_key「key 即凭证」模式）；
// ③ 桥接调度：固件 MCP 工具 POST /api/xiaozhi/bridge（EXEMPT + key）→ 这里执行。
// 控制通道双份：direct=直接 MIoT setProp（默认，走工作台米家绑定）；
//   speaker=小爱智能屏转述（x10a execute-text-directive，自然语言由小爱解析，
//   可覆盖非开关类指令——备选通道，did/aiid 用户提供，siid 从 spec 自动探测）。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, getTenantDb, getSetting, setSetting, dataDir, routedDb } = require('../db');
const mihome = require('./mihomeService');
const searchService = require('./searchService');
const aiService = require('./aiService');
const hermesService = require('./hermesService');
const xiaozhiTools = require('./xiaozhiTools');
const { encrypt, decrypt } = require('./businessSkillService');

const CFG_KEY = 'xiaozhi_config';
const KEY_KEY = 'xiaozhi_bridge_key';
const AGENT_KEY_KEY = 'xiaozhi_agent_key';   // Hermes API key（AES-GCM 加密存；绝不随 getConfig 回给前端）
const MCP_TOKEN_KEY = 'xiaozhi_mcp_token';   // 官方 MCP 接入点 token（同上）
const PHOTO_PENDING_KEY = 'xiaozhi_photo_pending'; // 1=面板请求板子拍一张，板子轮询 poll 时消费
const PHOTO_DIR = path.join(dataDir, 'xiaozhi', 'photos'); // 相册落盘目录（文件名 = 时间戳.jpg，文件系统即索引）
const PHOTO_KEEP = 200; // 相册上限：超出时自动清最老的

// 默认配置与板子当前实况一致（小阳阳 + COM4 + 智能屏10 did）
const DEFAULT_CFG = {
  wake: { pinyin: 'xiao yang yang', display: '小阳阳', threshold: 20 },
  channel: 'direct', // direct | speaker —— 语音控米家的通道
  speaker: { did: '1149549826', siid_play: null, aiid_play: 3, siid_exec: null, aiid_exec: 4, piid_play: 1, piid_exec: 1 }, // siid 空=按 spec 自动探测
  bridge: { url: '' }, // 烧进固件的工作台桥接地址（含 /api/xiaozhi/bridge；空=构建时前端自动带当前访问地址）
  helper: { url: '' }, // 构建机地址（v1.9.12：无工具链环境【如 NAS 容器】从这里取固件，LAN 内 Windows 工作台）
  device_aliases: {}, // 语音别名对照表（v1.9.16：did → 别名；resolveDevice 与 list_devices 回包都认，纯映射不改设备真名）
  home_filter: 'all', // 设备一览默认显示的家庭（v1.9.17：'all'=全部；存家庭名，面板下拉选择）
  paths: {}, // 能力探测路径覆盖（admin 在面板改：srcDir/esptool/idfExportBat/idfGitDir/serialPort）
  // 语音查询工作台数据（v1.9.31）：uid=查谁的租户库（null=未配置，ask 直接回「没配」）
  query: { uid: null, max_results: 10, max_chars: 120, ai_timeout_ms: 6000 },
  // 对接 NAS Hermes agent（v1.9.31）：默认关闭；密钥单独存 AGENT_KEY_KEY，不放这里（getConfig 会整包回前端）。
  // base_url / model 给的是当前这台 NAS 的实测值（v1.9.31 轮次），面板里可改——
  // 产品化给别的用户用时，这两项就是「填自己家 agent 地址」的位置。密钥**不给默认值**，必须自己填。
  agent: {
    enabled: false, name: '贾维斯', aliases: [],
    base_url: 'http://192.168.110.105:8642', model: 'fnnas-feishu',
    require_name: true, rate_per_hour: 20, block_risky: true, sync_budget_ms: 8000,
  },
  // 官方 MCP 接入点（v1.9.31）：默认关闭；token 单独存 MCP_TOKEN_KEY（url 不含 token，可以明文存）
  mcp: { enabled: false, url: '' },
};

function getConfig() {
  const saved = getSetting(db, CFG_KEY, {}) || {};
  return {
    ...DEFAULT_CFG, ...saved,
    wake: { ...DEFAULT_CFG.wake, ...(saved.wake || {}) },
    speaker: { ...DEFAULT_CFG.speaker, ...(saved.speaker || {}) },
    bridge: { ...DEFAULT_CFG.bridge, ...(saved.bridge || {}) },
    helper: { ...DEFAULT_CFG.helper, ...(saved.helper || {}) },
    device_aliases: { ...(saved.device_aliases || {}) },
    paths: { ...(saved.paths || {}) },
    query: { ...DEFAULT_CFG.query, ...(saved.query || {}) },
    agent: { ...DEFAULT_CFG.agent, ...(saved.agent || {}) },
    mcp: { ...DEFAULT_CFG.mcp, ...(saved.mcp || {}) },
  };
}
function saveConfig(patch) {
  const cur = getConfig();
  const next = {
    ...cur, ...patch,
    wake: { ...cur.wake, ...(patch.wake || {}) },
    speaker: { ...cur.speaker, ...(patch.speaker || {}) },
    bridge: { ...cur.bridge, ...(patch.bridge || {}) },
    helper: { ...cur.helper, ...(patch.helper || {}) },
    // v1.9.25 修：patch 显式带 device_aliases 时用「替换」语义——合并会把已删除的别名键复活
    // （清空别名保存后看似成功、刷新还在的 bug；全量 map 只由 setDeviceAlias 构造，安全替换）
    device_aliases: patch.device_aliases !== undefined ? { ...patch.device_aliases } : { ...(cur.device_aliases || {}) },
    paths: { ...cur.paths, ...(patch.paths || {}) },
    query: { ...cur.query, ...(patch.query || {}) },
    // aliases 同 device_aliases：显式带就整体替换，否则合并会把已删的别名复活
    agent: { ...cur.agent, ...(patch.agent || {}), ...(patch.agent && patch.agent.aliases !== undefined ? { aliases: [...patch.agent.aliases] } : {}) },
    mcp: { ...cur.mcp, ...(patch.mcp || {}) },
  };
  setSetting(db, CFG_KEY, next);
  return next;
}

// ---------- 敏感凭证（v1.9.31） ----------
// Hermes API key 与接入点 token 都不放 xiaozhi_config——GET /xiaozhi/config 会把整个 config
// 原样回给前端。单独存 settings 键 + AES-256-GCM 加密，UI 只拿得到「配没配」的布尔。
function getAgentKey() { const v = getSetting(db, AGENT_KEY_KEY, ''); return v ? decrypt(v) : ''; }
function setAgentKey(plain) {
  const s = String(plain || '').trim();
  if (s) setSetting(db, AGENT_KEY_KEY, encrypt(s));
  return hasAgentKey();
}
function clearAgentKey() { setSetting(db, AGENT_KEY_KEY, ''); }
function hasAgentKey() { return !!getSetting(db, AGENT_KEY_KEY, ''); }

function getMcpToken() { const v = getSetting(db, MCP_TOKEN_KEY, ''); return v ? decrypt(v) : ''; }
function setMcpToken(plain) {
  const s = String(plain || '').trim();
  if (s) setSetting(db, MCP_TOKEN_KEY, encrypt(s));
  return hasMcpToken();
}
function hasMcpToken() { return !!getSetting(db, MCP_TOKEN_KEY, ''); }

// 给前端看的配置：补两个「配没配」布尔，绝不带密钥本身
function getPublicConfig() {
  const c = getConfig();
  return { ...c, agent: { ...c.agent, has_key: hasAgentKey() }, mcp: { ...c.mcp, token_set: hasMcpToken(), connected: mcpState.connected } };
}

// ---------- 别名登记（面板逐台编辑；语音解析按「真名/别名」同等匹配） ----------
function setDeviceAlias(did, alias) {
  const d = String(did || '').trim();
  if (!/^[\w.-]{1,64}$/.test(d)) throw new Error('did 格式不对');
  const a = String(alias || '').trim();
  if (a.length > 32) throw new Error('别名最长 32 个字');
  const aliases = { ...(getConfig().device_aliases || {}) };
  if (a) aliases[d] = a; else delete aliases[d]; // 空别名=解除登记
  saveConfig({ device_aliases: aliases });
  return aliases;
}

// ---------- 桥接密钥（32hex；&& ensureBridgeKey() 防空串匹配空串，照 vibe keyOk） ----------
function ensureBridgeKey() {
  let k = getSetting(db, KEY_KEY, '');
  if (!k) { k = crypto.randomBytes(16).toString('hex'); setSetting(db, KEY_KEY, k); }
  return k;
}
function rotateBridgeKey() {
  const k = crypto.randomBytes(16).toString('hex');
  setSetting(db, KEY_KEY, k);
  return k; // 轮换后旧固件立即失联，需重烧（面板会提示）
}
function bridgeKeyOk(req) {
  const k = String(req.get('x-wb-key') || req.query.k || req.body?.key || '');
  return !!k && k === ensureBridgeKey();
}

// ---------- 设备拍平（桥接给云端 AI 的紧凑形态；砍 urn/model 等省流量） ----------
// opts.includeParents（v1.9.25）：带上多路开关的父条目（is_parent=1、无开关）——只给面板「可控设备一览」
// 标注用；AI 桥接的 list_devices 仍用瘦身清单（父条目不可直接控，回包里只会占流量，v1.9.13 教训）。
const MAX_DEVICES = 150;
async function listDevicesForBridge(fresh = false, opts = {}) {
  const view = await mihome.getHomeView(!!fresh); // fresh=1 与「米家」tab 的强制同步同一条路
  const aliases = getConfig().device_aliases || {};
  const out = [];
  for (const h of view.homes || []) for (const r of h.rooms || []) for (const d of r.devices || []) {
    if (d.is_parent) {
      if (!opts.includeParents) continue; // 多路开关的父条目无外层开关，各分路有独立卡片
      out.push({ did: d.did, name: d.name, home: h.name, room: r.name, online: !!d.online, is_parent: true, sw: null, t: null, h: null, alias: null });
      if (out.length >= MAX_DEVICES) return out;
      continue;
    }
    out.push({
      did: d.did, name: d.name, home: h.name, room: r.name, online: !!d.online,
      sw: d.switch ? { siid: d.switch.siid, piid: d.switch.piid, v: d.switch.value === true } : null,
      t: d.env?.t?.value ?? null, h: d.env?.h?.value ?? null,
      alias: aliases[String(d.did)] || null, // 语音别名（v1.9.16）：真名之外的叫法
    });
    if (out.length >= MAX_DEVICES) return out;
  }
  return out;
}

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
// 别名接管（v1.9.18）：登记了别名的设备只认别名，本名退出匹配——重名设备给其中一台起别名即可消歧
const namesOf = (d) => (d.alias ? [d.alias] : [d.name]).filter(Boolean);
// 名称→设备解析：did 精确 > 名称/别名全等 > 唯一子串（含 房间+名称/别名 组合）；多义时返回候选让 AI 追问
function resolveDevice(devices, query) {
  const raw = String(query || '').trim();
  const q = norm(raw);
  if (!q) return { error: '设备名不能为空' };
  let hit = devices.find((d) => String(d.did) === raw || norm(d.did) === q);
  if (!hit) {
    const full = devices.filter((d) => namesOf(d).some((n) => norm(n) === q));
    if (full.length === 1) hit = full[0];
    else if (full.length > 1) return { error: ambiguous(full, raw) };
  }
  if (!hit) {
    const sub = devices.filter((d) => namesOf(d).some((n) => norm(n).includes(q) || norm(`${d.room}${n}`).includes(q)));
    if (sub.length === 1) hit = sub[0];
    else if (sub.length > 1) return { error: ambiguous(sub, raw) };
  }
  if (!hit) {
    // 喊了被别名顶替的本名：直接告诉用户新叫法（v1.9.18，重名消歧的引导）
    const renamed = devices.find((d) => d.alias && (norm(d.name) === q || norm(d.name).includes(q)));
    if (renamed) return { error: `「${renamed.name}」已登记语音别名，请叫它「${renamed.alias}」` };
    return { error: `没有找到叫「${raw}」的设备，可以说“列出家里的设备”查看全部名称` };
  }
  return { device: hit };
}
function ambiguous(list, raw) {
  const names = list.slice(0, 5).map((d) => `${d.room}的${d.alias || d.name}${d.alias ? '' : '（无别名）'}`);
  return `「${raw}」匹配到多台：${names.join('、')}${list.length > 5 ? ' 等' : ''}——给其中一台登记语音别名后可消歧`;
}

// ---------- 开关控制：direct 走 setProp；无开关点位/失败时若配有智能屏则转述兜底 ----------
async function controlDevice(query, action) {
  const act = String(action || '').trim().toLowerCase();
  const devices = await listDevicesForBridge();
  const r = resolveDevice(devices, query);
  if (r.error) return { ok: false, message: r.error };
  const d = r.device;
  if (!['on', 'off', 'toggle', '开', '关', '打开', '关闭'].includes(act)) {
    return { ok: false, message: 'action 只支持 on / off / toggle；复杂指令（调亮度/温度等）请用 exec_text' };
  }
  if (!d.online) return { ok: false, message: `${d.name}（${d.room}）当前离线，无法控制` };
  const wantOn = act === 'on' || act === '开' || act === '打开' ? true : act === 'off' || act === '关' || act === '关闭' ? false : !(d.sw && d.sw.v);
  const where = d.room === '未分区' ? '' : d.room;
  // 转述兜底：把结构化指令拼成自然语言走小爱（execute-text-directive 无结构化回执，尽力而为）
  const viaSpeaker = async (reason) => {
    const sp = await speakerAction('exec', `把${where}${d.name}${wantOn ? '打开' : '关闭'}`);
    if (sp.ok) return { ok: true, via: 'speaker', message: `${reason}；已改由小爱智能屏执行` };
    return { ok: false, message: `${reason}；智能屏转述也失败：${sp.message}` };
  };
  if (!d.sw) return viaSpeaker(`${d.name}没有开关属性`);
  try {
    await mihome.setProp(d.did, d.sw.siid, d.sw.piid, wantOn);
    return { ok: true, did: d.did, name: d.name, on: wantOn, message: `好的，已${wantOn ? '打开' : '关闭'}${where}${d.name}` };
  } catch (e) {
    return viaSpeaker(`直接控制失败（${e.message}）`);
  }
}

async function deviceStatus(query) {
  const devices = await listDevicesForBridge();
  const r = resolveDevice(devices, query);
  if (r.error) return { ok: false, message: r.error };
  const d = r.device;
  const parts = [`${d.room === '未分区' ? '' : d.room}${d.name}`, d.online ? '在线' : '离线'];
  if (d.sw) parts.push(d.sw.v ? '开着' : '关着');
  if (d.t != null) parts.push(`温度 ${d.t}°C`);
  if (d.h != null) parts.push(`湿度 ${d.h}%`);
  return { ok: true, did: d.did, online: d.online, on: d.sw ? d.sw.v : null, t: d.t, h: d.h, message: parts.join('，') };
}

// ---------- 智能屏 x10a：动作点位自动探测（action name play-text / execute-text-directive） ----------
// siid/aiid 以 spec 实测为准回填 config；探测失败（spec 拉不到）回退 config 手填值。
async function ensureSpeakerPoints(force) {
  const sp = { ...getConfig().speaker };
  const needPlay = force || !sp.siid_play || !sp.aiid_play;
  const needExec = force || !sp.siid_exec || !sp.aiid_exec;
  if (needPlay || needExec) {
    const spec = await mihome.getSpecByDid(sp.did);
    for (const s of spec.services || []) for (const a of s.actions || []) {
      if (needPlay && a.name === 'play-text') {
        sp.siid_play = s.siid; sp.aiid_play = a.aiid;
        sp.piid_play = Array.isArray(a.in) && a.in[0] && a.in[0].piid != null ? a.in[0].piid : 1;
      }
      if (needExec && a.name === 'execute-text-directive') {
        sp.siid_exec = s.siid; sp.aiid_exec = a.aiid;
        sp.piid_exec = Array.isArray(a.in) && a.in[0] && a.in[0].piid != null ? a.in[0].piid : 1;
      }
    }
    saveConfig({ speaker: sp });
  }
  return sp;
}
// kind: 'play'=播放文本（顺带成为工作台→智能屏 TTS 通道） | 'exec'=执行文本指令（小爱解析自然语言）
async function speakerAction(kind, text) {
  const cfg = getConfig();
  let sp = { ...cfg.speaker };
  if (kind === 'play' ? !sp.siid_play : !sp.siid_exec) {
    try { sp = await ensureSpeakerPoints(false); } catch (e) {
      return { ok: false, message: `智能屏动作点位未配置且自动探测失败（${e.message}），请在智能板配置里手动填 siid` };
    }
  }
  const siid = kind === 'play' ? sp.siid_play : sp.siid_exec;
  const aiid = kind === 'play' ? sp.aiid_play : sp.aiid_exec;
  const piid = kind === 'play' ? (sp.piid_play || 1) : (sp.piid_exec || 1);
  if (!siid || !aiid) return { ok: false, message: '智能屏动作点位缺失（siid 未配置），请先点「自动探测」或手填' };
  try {
    await mihome.callAction(sp.did, siid, aiid, [{ piid, value: text }]);
    return { ok: true, message: kind === 'play' ? '已发送到智能屏播报' : '已发给小爱解析执行（无结构化回执，以实际效果为准）' };
  } catch (e) {
    return { ok: false, message: `智能屏调用失败：${e.message}` };
  }
}

// ---------- 摄像头照片（v1.9.17：板子拍照 → POST /xiaozhi/photo 落盘；面板请求 → pending 标记 → 板子轮询消费） ----------
function setPhotoPending() { setSetting(db, PHOTO_PENDING_KEY, '1'); }
function listPhotos() {
  try {
    if (!fs.existsSync(PHOTO_DIR)) return [];
    return fs.readdirSync(PHOTO_DIR)
      .filter((f) => /^\d{10,14}(_\d+)?\.jpg$/.test(f)) // 白名单：文件名只认时间戳形态，顺带防目录穿越
      .map((f) => { const st = fs.statSync(path.join(PHOTO_DIR, f)); return { file: f, size: st.size, mtime: st.mtimeMs }; })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (e) {
    console.error('[xiaozhi] listPhotos', e.message);
    return [];
  }
}
function savePhoto(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 100) throw new Error('照片数据为空');
  if (buf.length > 4 * 1024 * 1024) throw new Error('照片超过 4MB 上限');
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('不是 JPEG 数据');
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  const file = `${Date.now()}.jpg`;
  fs.writeFileSync(path.join(PHOTO_DIR, file), buf);
  // 相册上限：超出清最老的（照片是可再生数据，保留最近 PHOTO_KEEP 张）
  const all = listPhotos();
  for (const old of all.slice(PHOTO_KEEP - 1)) {
    try { fs.unlinkSync(path.join(PHOTO_DIR, old.file)); } catch { /* 尽力而为 */ }
  }
  return { file, size: buf.length };
}
function deletePhoto(file) {
  if (!/^\d{10,14}(_\d+)?\.jpg$/.test(String(file || ''))) throw new Error('文件名不合法');
  const p = path.join(PHOTO_DIR, file);
  if (!fs.existsSync(p)) throw new Error('照片不存在');
  fs.unlinkSync(p);
}
function photoPath(file) {
  if (!/^\d{10,14}(_\d+)?\.jpg$/.test(String(file || ''))) throw new Error('文件名不合法');
  const p = path.join(PHOTO_DIR, file);
  if (!fs.existsSync(p)) throw new Error('照片不存在');
  return p;
}

// ---------- 板子 IP（v1.9.18 视频对话）：poll 自报优先，remoteAddress 兜底 ----------
// v1.9.20 实测：生产 NAS 的端口转发会改写来源地址（任何客户端 remoteAddress 恒 127.0.0.1），
// v1.9.20 固件起 poll 带 ip 字段自报；旧固件没有该字段则回退 socket 远端（本地 localhost 部署仍准确）。
const BOARD_IP_KEY = 'xiaozhi_device_ip';
const BOARD_SEEN_KEY = 'xiaozhi_device_ip_seen_at';
const isIpv4 = (s) => /^(\d{1,3}\.){3}\d{1,3}$/.test(s);
function noteBoardIp(socketIp, explicitIp) {
  const e = String(explicitIp || '').replace(/^::ffff:/, '').trim();
  const v = isIpv4(e) ? e : String(socketIp || '').replace(/^::ffff:/, '').trim();
  if (!isIpv4(v)) return; // 只认 IPv4（板子直连场景）
  setSetting(db, BOARD_IP_KEY, v);
  setSetting(db, BOARD_SEEN_KEY, String(Date.now()));
}
function getBoardInfo() {
  const ip = getSetting(db, BOARD_IP_KEY, '');
  const seen = Number(getSetting(db, BOARD_SEEN_KEY, '0')) || 0;
  return { ip, seen_at: seen, online: !!ip && Date.now() - seen < 90000 }; // 轮询周期 25s，3 个周期没来视为离线
}

// ---------- 对话记录（v1.9.19）：板子上报 stt/tts 攒批入库 + 面板分页读取 ----------
const CHATLOG_KEEP_MAX = 5000; // 容量上限（约数千轮对话），写满清最老——同照片相册的思路

function appendChatLog(messages) {
  const now = Date.now();
  const rows = [];
  for (const m of Array.isArray(messages) ? messages.slice(0, 64) : []) { // 单批上限防异常包
    const role = m && m.role === 'user' ? 'user' : 'assistant';
    const text = String((m && m.text) || '').trim().slice(0, 1000);
    if (!text) continue;
    let ts = Number(m && m.ts_ms);
    if (!Number.isFinite(ts) || ts < 1e12 || ts > now + 600000) ts = now; // 板钟未同步（1970）/超前用服务端时间
    rows.push([ts, role, text]);
  }
  if (!rows.length) return 0;
  const ins = db.prepare('INSERT INTO xiaozhi_chat_log (ts, role, text) VALUES (?, ?, ?)');
  for (const r of rows) ins.run(r[0], r[1], r[2]);
  const total = db.prepare('SELECT COUNT(*) c FROM xiaozhi_chat_log').get().c;
  if (total > CHATLOG_KEEP_MAX) {
    db.prepare('DELETE FROM xiaozhi_chat_log WHERE id IN (SELECT id FROM xiaozhi_chat_log ORDER BY id LIMIT ?)')
      .run(total - CHATLOG_KEEP_MAX);
  }
  return rows.length;
}

// 面板「对话记录」分页：默认最新一页（≈3 屏），向上滚动带 before_id 再取更早的
function listChatLog({ beforeId, limit } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const before = Number(beforeId) || null;
  const rows = before
    ? db.prepare('SELECT id, ts, role, text FROM xiaozhi_chat_log WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, lim + 1)
    : db.prepare('SELECT id, ts, role, text FROM xiaozhi_chat_log ORDER BY id DESC LIMIT ?').all(lim + 1);
  return { messages: rows.slice(0, lim).reverse(), has_more: rows.length > lim }; // 时间正序返回，prepend 用
}

// ========== 语音查询工作台数据 + 转交家里 agent（v1.9.31） ==========

// 语音回包体积预算：官方 MCP 接入点约 1024 字节上限，设备侧 MCP 也吃紧。
// 超了就把话再削短——宁可说半句，也不能整包被云端丢掉（丢了用户听到的是「发送失败」）。
const SPEECH_BYTE_CAP = 950;
function fitSpeech(obj) {
  if (!obj || typeof obj.message !== 'string') return obj;
  let m = obj.message;
  while (Buffer.byteLength(JSON.stringify({ ...obj, message: m }), 'utf8') > SPEECH_BYTE_CAP && m.length > 8) {
    m = m.slice(0, Math.max(8, Math.floor(m.length * 0.8))) + '…';
  }
  return { ...obj, message: m };
}

function clampSpeech(s, max = 200) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// 整句 → 关键词：云端 LLM 很可能把「我的笔记里关于张三的内容」整句塞进来，
// 而检索是 LIKE %q% 子串匹配，整句必然 0 结果。零结果时剥掉疑问词再搜一次兜底。
const QUESTION_WORDS = ['请问', '帮我', '给我', '我想', '我要', '有没有', '有木有', '是什么', '有什么', '查一下', '查查', '找一下', '找找', '看看', '告诉我', '搜索', '搜一下', '一下', '笔记里', '记录里', '关于', '我的', '家里', '的吗', '是不是', '怎么样', '呢', '吗', '的', '说下', '讲下', '列出', '列一下', '显示', '一共', '总共', '数量', '？', '?', '。'];
function stripQuestion(q) {
  let t = String(q || '');
  for (const w of QUESTION_WORDS) t = t.split(w).join(' ');
  return t.replace(/[，,。.、!！~～\s]+/g, ' ').trim();
}

// 检索候选串，按精确度递减：原句 → 剥离疑问词的整串 → 剥离后的单个词。
// 「剥离后逐个词」这一步是必须的：检索是 LIKE %x%（子串匹配），
// 「我的笔记里关于装修的内容是什么」剥完会剩「装修 内容」，整串拿去匹配一个字都搜不到
// ——e2e 实测踩到过。
// 中文没有词边界：剥完疑问词常常剩一坨连写的字。生产实测「帮我查一下我的笔记有几篇」
// 剥完是「笔记有几篇」——整串 LIKE 一个字都搜不到，于是当年就回「没找到」。
// 再切一层 n-gram（4→3→2 字，各自按原序）兜底：这串由此切出「笔记」，能命中。
function cjkGrams(s) {
  const out = [];
  for (const run of String(s || '').split(/[^一-龥A-Za-z0-9]+/)) {
    if (run.length < 2) continue;
    // 按「位置优先、长度次之」产出：靠前的字先切、同一个位置先长后短。
    // 「笔记有几篇」由此第 3 个候选就是「笔记」；若改成按长度分层（4 字切完再切 3 字），
    // 候选上限一截就把短的挤没了，等于白切。
    for (let i = 0; i < run.length; i++) {
      for (const n of [4, 3, 2]) {
        if (i + n <= run.length) out.push(run.slice(i, i + n));
      }
    }
  }
  return out;
}
function searchCandidates(q) {
  const out = [String(q || '').trim()];
  const stripped = stripQuestion(q);
  if (stripped && stripped !== out[0]) {
    out.push(stripped);
    const toks = stripped.split(/\s+/).filter((t) => t.length >= 2);
    if (toks.length > 1) out.push(...toks);
    out.push(...cjkGrams(stripped));   // 与上面重叠的会被 dedup 掉，重复的代价为零
  }
  return [...new Set(out.filter(Boolean))].slice(0, 16);
}
// 类别词兜底：说「我的日程」时，字面「日程」不在**任何一条**日程里（标题是「牙科复诊」），
// 子串匹配必然 0 结果——用户问的是「那张表里有什么」，不是「哪条里写了日程两个字」。
// 只在候选串全部落空后才走，正常命中的查询一点不受影响。
const CATEGORY_FALLBACK = [
  ['日程', ['日程', '安排', '行程', '会议'], (d) => {
    const q = (where, order) => `SELECT id, title AS title, COALESCE(desc,'') AS c, COALESCE(start_time,'') AS t
      FROM events ${where} ORDER BY ${order} LIMIT 10`;
    const up = d.prepare(q("WHERE COALESCE(start_time,'') >= datetime('now','localtime')", 'start_time ASC')).all();
    // 未来的一件都没有时才回看最近的过去几条（用户问「我的日程」多半也想知道刚过去的那几件）
    return up.length ? up : d.prepare(q('', 'start_time DESC')).all();
  }],
  ['笔记', ['笔记'], (d) => d.prepare('SELECT id, title AS title, content AS c, updated_at AS t FROM notes ORDER BY updated_at DESC LIMIT 10').all()],
  ['待办', ['待办', '任务', 'todo'], (d) => d.prepare(`SELECT id, title AS title, COALESCE(desc,'') AS c, COALESCE(due_date,'') AS t
    FROM todos WHERE COALESCE(done,0)=0 ORDER BY (COALESCE(due_date,'')='') ASC, due_date ASC LIMIT 10`).all()],
  ['邮件', ['邮件', '邮箱', '收件箱'], (d) => d.prepare(`SELECT id, subject AS title, COALESCE(body, snippet, '') AS c, COALESCE(date, fetched_at, '') AS t
    FROM emails ORDER BY id DESC LIMIT 10`).all()],
  ['文件', ['文件', '存档'], (d) => d.prepare("SELECT id, filename AS title, COALESCE(text_content,'') AS c, created_at AS t FROM files ORDER BY id DESC LIMIT 10").all()],
  ['账务', ['账务', '账单', '花销', '支出', '消费'], (d) => d.prepare(`SELECT id,
    COALESCE(NULLIF(counterparty,''), NULLIF(goods,''), '(无对方)') AS title,
    COALESCE(NULLIF(goods,''), NULLIF(remark,''), '') AS c,
    COALESCE(NULLIF(pay_time,''), create_time, '') AS t FROM pay_bills ORDER BY id DESC LIMIT 10`).all()],
];
function categoryResults(tdb, q) {
  const t = String(q || '');
  const out = [];
  for (const [label, words, run] of CATEGORY_FALLBACK) {
    if (!words.some((w) => t.includes(w))) continue;
    try {
      for (const r of run(tdb)) out.push({ type: label, id: r.id, title: r.title, content: r.c || '', time: r.t || '' });
    } catch (e) { console.error(`[xiaozhi] 类别兜底失败 ${label}`, e.message); }
  }
  return out;
}
// 依次试候选串，第一个有结果的就用；全落空再按「类别词」兜底
function searchWithFallback(tdb, q) {
  for (const c of searchCandidates(q)) {
    const results = searchService.search(tdb, c).results;
    if (results.length) return { results, used: c };
  }
  const byType = categoryResults(tdb, q);
  if (byType.length) return { results: byType, used: `类别「${byType[0].type}」` };
  return { results: [], used: String(q || '').trim() };
}

// 数量类问句（「有几篇笔记」「多少条待办」）只能靠 COUNT(*)：检索每类上限 10 条，
// 让 AI 去数检索结果必然数错——生产实测把 21 条笔记念成「找到三条」，用户当场就能听出来。
const COUNT_WORDS = ['几篇', '几条', '几个', '几项', '几件', '几笔', '几封', '多少次', '多少', '数量', '一共', '总共'];
function countIntent(q) {
  const t = String(q || '');
  return COUNT_WORDS.some((w) => t.includes(w));
}
// 全库计数（只数得动的几张主表）。表不存在就跳过——老库不一定每张都有，统计不是刚需。
function countAll(tdb) {
  const fdb = routedDb(tdb, 'family');
  const jobs = [
    ['笔记', tdb, 'notes'], ['待办', tdb, 'todos'], ['日程', tdb, 'events'],
    ['家庭事项', fdb, 'family_items'], ['子女任务', fdb, 'kid_tasks'],
    ['学习记录', tdb, 'learning_records'], ['剪贴板', tdb, 'clipboard_items'],
    ['邮件', tdb, 'emails'], ['文件', tdb, 'files'],
  ];
  const out = [];
  for (const [label, d, tbl] of jobs) {
    try {
      const r = d.prepare(`SELECT COUNT(*) AS n FROM ${tbl}`).get();
      if (r && Number(r.n) > 0) out.push(`${label} ${Number(r.n)} 条`);
    } catch { /* 表可能不存在 */ }
  }
  return out;
}

// uid 只从配置读（调用方——板子或云端——根本不知道 uid，不给自己开攻击面）。
// 必须查 users 表确认存在：getTenantDb 对任意数字会惰性建一个空库文件。
function configuredQueryUser() {
  const uid = Number(getConfig().query.uid);
  if (!Number.isInteger(uid) || uid <= 0) return null;
  return db.prepare('SELECT id, username FROM users WHERE id=? AND is_bot=0').get(uid) || null;
}

// 有没有配 AI（用于决定走 AI 归纳还是确定性拼串降级）
function aiReady(tdb) {
  try { return aiService.hasConfig(tdb); } catch { return false; }
}

// 确定性降级：不依赖 AI 也能念出一句有信息量的话
function digestResults(results) {
  const items = results.slice(0, 3).map((r) => `${r.type}《${String(r.title || '').trim().slice(0, 20)}》`);
  return `找到 ${results.length} 条：${items.join('、')}`;
}

function buildDigest(results, { maxResults = 10, maxChars = 120 } = {}) {
  return results.slice(0, maxResults)
    .map((r, i) => `${i + 1}. [${r.type}] ${String(r.title || '').trim().slice(0, 60)} — ${String(r.content || '').replace(/\s+/g, ' ').trim().slice(0, maxChars)}`)
    .join('\n')
    .slice(0, 1500);
}

const ASK_SYSTEM = '你是语音助手，下面是从用户个人数据库里检索到的条目。' +
  '用不超过 60 字的中文口语回答用户的问题，直接给结论。' +
  '不要 markdown、不要列表、不要引号、不要表情符号；不要复述问题、不要解释你是怎么查的。' +
  '问到数量时必须用给出的「全库计数」，不要自己数检索结果。检索结果里没有的就说没找到，不要编。';

async function askWorkbench(rawQ) {
  const q = String(rawQ || '').trim().slice(0, 200);
  if (!q) return { ok: false, message: '没听清要查什么，再说一遍' };

  const cfg = getConfig();
  // 点名优先：说话里带了 agent 的名字，即使云端错调了 ask 也自动改道（用户预期是「叫谁谁来办」）
  if (cfg.agent.enabled && xiaozhiTools.addressed(q, cfg.agent)) return delegateAgent(q, { via: 'ask-reroute' });

  const user = configuredQueryUser();
  if (!user) return { ok: false, message: '还没在智能板配置里指定要查谁的资料' };

  let tdb;
  try { tdb = getTenantDb(user.id); } catch (e) {
    return { ok: false, message: `打不开资料库：${e.message}` };
  }

  let results;
  try {
    ({ results } = searchWithFallback(tdb, q));
  } catch (e) {
    console.error('[xiaozhi] ask 检索失败', e.message);
    return { ok: false, message: '查资料出错了，稍后再试' };
  }
  // 「有几篇笔记」这类问句：条数只能来自 COUNT(*)，检索每类上限 10 条，让 AI 数会数错
  const counts = countIntent(q) ? countAll(tdb) : [];
  const countLine = counts.length ? `统计：${counts.join('、')}` : '';
  if (!results.length) {
    // 纯数量问句（「我记了几篇笔记」）本来就不该有检索命中，别回「没找到」
    if (countLine) return fitSpeech({ ok: true, message: countLine });
    return fitSpeech({ ok: true, message: `没找到和「${q.slice(0, 20)}」相关的记录` });
  }

  const qc = cfg.query;
  let message = countLine ? `${countLine}。${digestResults(results)}` : digestResults(results);
  if (aiReady(tdb)) {
    const digest = buildDigest(results, { maxResults: Number(qc.max_results) || 10, maxChars: Number(qc.max_chars) || 120 });
    const budget = Math.min(Math.max(Number(qc.ai_timeout_ms) || 6000, 500), 60000);
    const prompt = `问题：${q}\n\n` +
      (countLine ? `全库计数（口径最准，问数量时用它）：${counts.join('、')}\n\n` : '') +
      `检索结果：\n${digest}`;
    const r = await raceWithTimeout(
      aiService.chat(
        [{ role: 'system', content: ASK_SYSTEM }, { role: 'user', content: prompt }],
        { maxTokens: 120, temperature: 0.2, tdb },
      ),
      budget,
    );
    // AI 慢/出错都不算失败——确定性文案照样能念，比让用户干等或听「失败」强
    if (r.ok && r.value) message = r.value;
  }
  return fitSpeech({ ok: true, count: results.length, message: clampSpeech(message) });
}

// ---------- 转交家里 agent（三道闸 + 限流 + 审计 + 同步优先/智能屏补播兜底） ----------
const RISKY_RE = /(删除|删掉|删了|清空|格式化|关机|重启|重装|卸载|覆盖|写入|执行|运行|安装|rm\s|format|shutdown|reboot|drop\s+table|delete|remove)/i;

const agentHits = []; // 进程内滑动窗口即可——限流是防误触发风暴，不需要跨重启精确
function agentRateOk(perHour) {
  const now = Date.now();
  const cutoff = now - 3600 * 1000;
  while (agentHits.length && agentHits[0] < cutoff) agentHits.shift();
  if (agentHits.length && now - agentHits[agentHits.length - 1] < 5000) {
    return { ok: false, message: '刚收到一条，还在处理，稍等几秒再说' };
  }
  if (agentHits.length >= perHour) return { ok: false, message: `一小时最多转交 ${perHour} 次，稍后再试` };
  agentHits.push(now);
  return { ok: true };
}

function raceWithTimeout(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve({ hit: true, ok: false }); } }, ms);
    promise.then(
      (value) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: true, value }); } },
      (error) => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, error: error.message || String(error) }); } },
    );
  });
}

const AGENTLOG_KEEP_MAX = 2000;
function logAgent({ request, status, reason = '', result = '', mode = '', ms = 0 }) {
  try {
    db.prepare('INSERT INTO xiaozhi_agent_log (ts, request, status, reason, result, mode, ms) VALUES (?,?,?,?,?,?,?)')
      .run(Date.now(), String(request || '').slice(0, 200), status, String(reason || '').slice(0, 300), String(result || '').slice(0, 300), mode, Math.round(ms) || 0);
    const total = db.prepare('SELECT COUNT(*) c FROM xiaozhi_agent_log').get().c;
    if (total > AGENTLOG_KEEP_MAX) {
      db.prepare('DELETE FROM xiaozhi_agent_log WHERE id IN (SELECT id FROM xiaozhi_agent_log ORDER BY id LIMIT ?)')
        .run(total - AGENTLOG_KEEP_MAX);
    }
  } catch (e) { console.warn('[xiaozhi] 转交审计写入失败:', e.message); }
}
function listAgentLog({ beforeId, limit } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 30, 1), 200);
  const before = Number(beforeId) || null;
  const rows = before
    ? db.prepare('SELECT id, ts, request, status, reason, result, mode, ms FROM xiaozhi_agent_log WHERE id < ? ORDER BY id DESC LIMIT ?').all(before, lim + 1)
    : db.prepare('SELECT id, ts, request, status, reason, result, mode, ms FROM xiaozhi_agent_log ORDER BY id DESC LIMIT ?').all(lim + 1);
  return { entries: rows.slice(0, lim), has_more: rows.length > lim };
}

async function delegateAgent(rawText, { via = 'bridge' } = {}) {
  const ag = getConfig().agent;
  const text = String(rawText || '').trim().slice(0, 200);
  const t0 = Date.now();
  // 所有拒绝都走这里：留痕 + 回一句能被念出来的话
  const deny = (message, reason) => {
    logAgent({ request: text, status: 'rejected', reason, ms: Date.now() - t0 });
    return fitSpeech({ ok: false, message, rejected: true });
  };

  if (!text) return deny('要办什么？再说一遍', 'empty');
  if (!ag.enabled) return deny(`家里 agent 还没启用（去智能板配置页勾上「启用」）`, 'disabled');
  if (ag.require_name && !xiaozhiTools.addressed(text, ag)) {
    return deny(`要用「${ag.name}」这个名字叫我，我才去办`, 'not_addressed');
  }
  if (ag.block_risky && RISKY_RE.test(text)) {
    return deny('这条指令带危险操作，我先不转交——确认要办就去配置页关掉「危险词拦截」', 'risky');
  }
  if (!ag.base_url || !ag.model || !hasAgentKey()) {
    return deny('家里 agent 还没配全（地址 / 模型 / 密钥）', 'unconfigured');
  }
  const rl = agentRateOk(Math.min(Math.max(Number(ag.rate_per_hour) || 20, 1), 500));
  if (!rl.ok) return deny(rl.message, 'rate_limited');

  const budget = Math.min(Math.max(Number(ag.sync_budget_ms) || 8000, 1000), 120000);
  let p;
  try {
    p = hermesService.ask({ baseUrl: ag.base_url, apiKey: getAgentKey(), model: ag.model, text });
  } catch (e) {
    logAgent({ request: text, status: 'error', reason: e.message, ms: Date.now() - t0 });
    return fitSpeech({ ok: false, message: `联系不上${ag.name}：${e.message}` });
  }

  const r = await raceWithTimeout(p, budget);
  if (r.hit) {
    // 慢任务：先把「我去问了」回给板子（保住这轮对话），结果算完了由智能屏补播。
    // 注意这里**不 abort**——promise 继续跑，否则补播就没了。
    p.then((res) => {
      logAgent({ request: text, status: 'ok', result: res.content.slice(0, 300), mode: 'async', ms: Date.now() - t0 });
      speakerAction('play', clampSpeech(res.content)).catch(() => {});
    }).catch((e) => {
      logAgent({ request: text, status: 'error', reason: e.message, mode: 'async', ms: Date.now() - t0 });
      speakerAction('play', `${ag.name}那边出错了`).catch(() => {});
    });
    logAgent({ request: text, status: 'ok', result: '(已回执，等结果)', mode: 'async-receipt', ms: Date.now() - t0 });
    return fitSpeech({ ok: true, mode: 'async', message: `${ag.name}还在算，算好了我用智能屏告诉您` });
  }
  if (!r.ok) {
    logAgent({ request: text, status: 'error', reason: r.error, ms: Date.now() - t0 });
    return fitSpeech({ ok: false, message: `${ag.name}那边没办成：${r.error}` });
  }
  const content = clampSpeech(r.value.content);
  logAgent({ request: text, status: 'ok', result: content.slice(0, 300), mode: 'sync', ms: Date.now() - t0 });
  return fitSpeech({ ok: true, mode: 'sync', message: content });
}

// 通道 A（官方 MCP 接入点）的连接状态：由 xiaozhiMcpBridge 回写，面板读它显示状态灯。
// 放在这里而不是桥接模块内，是因为 getPublicConfig 要用，且避免路由层反向依赖桥接。
const mcpState = { connected: false, since: 0, last_error: '' };
function setMcpState(patch) { Object.assign(mcpState, patch); return { ...mcpState }; }
function getMcpState() { return { ...mcpState }; }

// ---------- 桥接统一入口（POST /xiaozhi/bridge，index.js EXEMPT + key） ----------
// 返回恒为业务 JSON（ok/message），HTTP 层只对密钥错回 403——固件侧好把 message 直接念给用户。
async function dispatch(op, body) {
  const b = body || {};
  try {
    if (op === 'ping') {
      const devices = await listDevicesForBridge();
      return { ok: true, message: `工作台在线，米家有 ${devices.length} 台可控设备`, devices: devices.length };
    }
    if (op === 'list_devices') {
      // 回包瘦身（v1.9.13）：只发 AI 需要的名字/房间/状态。板子 WiFi 弱信号（RSSI -70 实测）下
      // 14KB 全量列表要传 16 秒，会拖垮 MQTT 长连接——工具结果发不回云端，用户听到「发送失败」。
      // did / sw.siid / sw.piid 是服务端内部解析数据（control 在服务端重新拉全量），不出网；
      // 纯传感器（无开关无温湿度）整体省略——status 对它们本来也无话可说。
      const all = await listDevicesForBridge();
      const devices = [];
      for (const d of all) {
        if (!d.sw && d.t == null && d.h == null) continue;
        // 别名接管（v1.9.18）：name 给 AI 的就是用户嘴里的叫法——有别名的设备本名已退出匹配，
        // 清单里再列本名只会诱导 AI 拿它去调（然后被拒）
        const it = { name: d.alias || d.name, room: d.room, on: d.sw ? d.sw.v : null };
        if (d.t != null) it.t = d.t;
        if (d.h != null) it.h = d.h;
        devices.push(it);
      }
      const skipped = all.length - devices.length;
      return { ok: true, total: devices.length, devices, message: `共 ${devices.length} 台可控设备${skipped ? `（另有 ${skipped} 台纯传感器未列出）` : ''}` };
    }
    if (op === 'control') return await controlDevice(b.device, b.action);
    if (op === 'status') return await deviceStatus(b.device);
    if (op === 'exec_text' || op === 'exec') {
      const text = String(b.text || '').trim().slice(0, 200);
      if (!text) return { ok: false, message: 'text 不能为空' };
      const r = await speakerAction('exec', text);
      return { ...r, via: 'speaker' };
    }
    if (op === 'speak' || op === 'play') {
      const text = String(b.text || '').trim().slice(0, 200);
      if (!text) return { ok: false, message: 'text 不能为空' };
      return await speakerAction('play', text);
    }
    if (op === 'poll') {
      // 板子定期轮询（v1.9.17）：面板点「拍一张」置 pending，这里消费掉让板子立刻上传照片
      const wanted = getSetting(db, PHOTO_PENDING_KEY, '') === '1';
      if (wanted) setSetting(db, PHOTO_PENDING_KEY, '');
      return { ok: true, photo_requested: wanted, message: wanted ? '请拍照上传' : '' };
    }
    if (op === 'chatlog') {
      // 板子攒批上报的对话记录（v1.9.19）：空批也回 ok——让板子清掉重试，别死循环
      const n = appendChatLog(b.messages);
      return { ok: true, message: n ? `已记录 ${n} 条对话` : '' };
    }
    // v1.9.31：语音查工作台资料 / 转交家里 agent
    if (op === 'ask') return await askWorkbench(b.keywords || b.question || b.q || b.text);
    if (op === 'delegate') return await delegateAgent(b.request || b.text);
    return { ok: false, message: `未知操作 ${op || '(空)'}（支持 ping / list_devices / control / status / exec_text / speak / poll / chatlog / ask / delegate）` };
  } catch (e) {
    console.error('[xiaozhi] bridge', op, e.message);
    return { ok: false, message: `桥接处理失败：${e.message}` };
  }
}

module.exports = {
  getConfig, saveConfig, getPublicConfig, ensureBridgeKey, rotateBridgeKey, bridgeKeyOk,
  listDevicesForBridge, setDeviceAlias, dispatch, speakerAction, ensureSpeakerPoints,
  setPhotoPending, listPhotos, savePhoto, deletePhoto, photoPath,
  noteBoardIp, getBoardInfo, appendChatLog, listChatLog,
  // v1.9.31 新增：语音查询 / 转交 agent / 凭证 / 审计 / 接入点状态
  askWorkbench, delegateAgent, listAgentLog, stripQuestion, searchCandidates, searchWithFallback, configuredQueryUser,
  countIntent, countAll, cjkGrams,
  getAgentKey, setAgentKey, clearAgentKey, hasAgentKey,
  getMcpToken, setMcpToken, hasMcpToken,
  setMcpState, getMcpState,
};
