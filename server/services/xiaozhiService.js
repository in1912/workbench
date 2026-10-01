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
const { db, getSetting, setSetting, dataDir } = require('../db');
const mihome = require('./mihomeService');

const CFG_KEY = 'xiaozhi_config';
const KEY_KEY = 'xiaozhi_bridge_key';
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
    device_aliases: { ...cur.device_aliases, ...(patch.device_aliases || {}) },
    paths: { ...cur.paths, ...(patch.paths || {}) },
  };
  setSetting(db, CFG_KEY, next);
  return next;
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
const MAX_DEVICES = 150;
async function listDevicesForBridge(fresh = false) {
  const view = await mihome.getHomeView(!!fresh); // fresh=1 与「米家」tab 的强制同步同一条路
  const aliases = getConfig().device_aliases || {};
  const out = [];
  for (const h of view.homes || []) for (const r of h.rooms || []) for (const d of r.devices || []) {
    if (d.is_parent) continue; // 多路开关的父条目无外层开关，各分路有独立卡片
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
    return { ok: false, message: `未知操作 ${op || '(空)'}（支持 ping / list_devices / control / status / exec_text / speak / poll / chatlog）` };
  } catch (e) {
    console.error('[xiaozhi] bridge', op, e.message);
    return { ok: false, message: `桥接处理失败：${e.message}` };
  }
}

module.exports = {
  getConfig, saveConfig, ensureBridgeKey, rotateBridgeKey, bridgeKeyOk,
  listDevicesForBridge, setDeviceAlias, dispatch, speakerAction, ensureSpeakerPoints,
  setPhotoPending, listPhotos, savePhoto, deletePhoto, photoPath,
  noteBoardIp, getBoardInfo, appendChatLog, listChatLog,
};
