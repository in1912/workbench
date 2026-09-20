// 电脑监控（v1.3.5）：Windows 端 PowerShell 代理每 N 分钟上传屏幕截图（480px JPEG），
// 服务端落库/落盘、按批做视觉 AI 概括、预警关键字命中推送站内消息（自动转钉钉）、
// 由截图时间序列推导开关机时段（首末截图时间；按每张截图「当时生效的间隔」判定超阈=新一次开机）。
// v1.4.7：间隔/分辨率支持设备级覆盖（monitor_devices.interval/width，NULL=跟随全局默认）。
// v1.4.8：监控配置全量设备级（AI 开关/频率、保留天数、预警关键字/推送对象/冷却，其余键存 cfg_json），
//         设备列表显示排序（sort_order）；预警命中截图经钉钉工作消息发图推送。
const fs = require('node:fs');
const crypto = require('node:crypto');
const { db, getSetting, setSetting } = require('../db');
const storagePaths = require('./storagePaths');
const messageService = require('./messageService');
const dingtalkService = require('./dingtalkService');
const aiService = require('./aiService');

const CFG_KEY = 'monitor_cfg';
const DEFAULT_CFG = {
  access_key: '',     // 代理接入密钥（安装包内嵌）
  interval: 3,        // 截图间隔（分钟）
  width: 480,         // 截图分辨率（宽，像素）：320/480/720/1080
  ai_enabled: 0,      // 是否启用 AI 分析（默认关闭，用户自行开启）
  ai_every: 10,       // 每累计 N 张未分析截图触发一轮分析
  retention_days: 14, // 截图保留天数
  keywords: [],       // 预警关键字（命中 AI 概括文本即推送）
  alert_users: [],    // 预警推送目标用户 uid
  alert_cooldown: 30, // 同设备同关键字冷却（分钟），防轰炸
};
const WIDTHS = [320, 480, 720, 1080];

function getConfig() {
  let cfg = {};
  try { cfg = JSON.parse(getSetting(db, CFG_KEY, '{}') || '{}'); } catch { /* 容错 */ }
  const out = { ...DEFAULT_CFG, ...cfg };
  if (!out.access_key) { // 首次访问自动生成接入密钥
    out.access_key = crypto.randomBytes(12).toString('hex');
    setSetting(db, CFG_KEY, JSON.stringify(out));
  }
  return out;
}

function saveConfig(patch) {
  const cur = getConfig();
  const next = { ...cur };
  if (patch.access_key === '__regen__') next.access_key = crypto.randomBytes(12).toString('hex');
  const num = (v, min, max, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : dflt;
  };
  if ('interval' in patch) next.interval = num(patch.interval, 1, 120, 3);
  if ('width' in patch) next.width = WIDTHS.includes(Number(patch.width)) ? Number(patch.width) : 480;
  if ('ai_enabled' in patch) next.ai_enabled = patch.ai_enabled ? 1 : 0;
  if ('ai_every' in patch) next.ai_every = num(patch.ai_every, 1, 50, 10);
  if ('retention_days' in patch) next.retention_days = num(patch.retention_days, 1, 180, 14);
  if ('alert_cooldown' in patch) next.alert_cooldown = num(patch.alert_cooldown, 0, 1440, 30);
  if ('keywords' in patch) {
    const arr = Array.isArray(patch.keywords) ? patch.keywords : String(patch.keywords || '').split(/[,，\s]+/);
    next.keywords = [...new Set(arr.map((s) => String(s).trim()).filter(Boolean))].slice(0, 30);
  }
  if ('alert_users' in patch) {
    const ids = (Array.isArray(patch.alert_users) ? patch.alert_users : []).map(Number).filter(Boolean);
    // 只留真实存在的非机器人用户
    const rows = db.prepare('SELECT id FROM users WHERE is_bot=0').all();
    const ok = new Set(rows.map((r) => r.id));
    next.alert_users = [...new Set(ids.filter((i) => ok.has(i)))].slice(0, 20);
  }
  setSetting(db, CFG_KEY, JSON.stringify(next));
  return next;
}

function nowStr() { return new Date().toLocaleString('sv'); }

// ---------- 设备 ----------
// 单独配置的其余键（cfg_json）：解析失败/未设置 = 空对象（全部跟随全局）
function devExtra(dev) {
  try { return JSON.parse((dev && dev.cfg_json) || '{}') || {}; } catch { return {}; }
}
// 设备是否启用了单独配置（任一覆盖存在：interval/width/ai_enabled 列或 cfg_json）
function isSolo(dev) {
  return !!(dev && ((dev.interval !== null && dev.interval !== undefined)
    || (dev.width !== null && dev.width !== undefined)
    || dev.ai_enabled === 1 || dev.ai_enabled === 0
    || dev.cfg_json));
}
// 设备实际生效配置：单独配置优先（v1.4.8 全量：间隔/分辨率/AI 开关/频率/保留天数/关键字/推送对象/冷却），未设置回落全局默认
function effCfg(dev, cfg) {
  const di = Number(dev && dev.interval);
  const dw = Number(dev && dev.width);
  const da = dev ? dev.ai_enabled : undefined; // null/undefined=未覆盖（跟随全局）；1/0=设备级开关
  const o = devExtra(dev);
  const num = (v, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : null;
  };
  const ae = num(o.ai_every, 1, 50);
  const rd = num(o.retention_days, 1, 180);
  const ac = num(o.alert_cooldown, 0, 1440);
  return {
    interval: Number.isFinite(di) && di >= 1 ? Math.min(120, Math.round(di)) : cfg.interval,
    width: WIDTHS.includes(dw) ? dw : (cfg.width || 480),
    ai_enabled: da === 1 || da === 0 ? Number(da) : (cfg.ai_enabled ? 1 : 0),
    ai_every: ae === null ? (cfg.ai_every || 10) : ae,
    retention_days: rd === null ? (cfg.retention_days || 14) : rd,
    keywords: Array.isArray(o.keywords) ? o.keywords.map((s) => String(s).trim()).filter(Boolean) : (cfg.keywords || []),
    alert_users: Array.isArray(o.alert_users) ? o.alert_users.map(Number).filter(Boolean) : (cfg.alert_users || []),
    alert_cooldown: ac === null ? (cfg.alert_cooldown ?? 30) : ac,
  };
}

function ensureDevice(id, computerName) {
  const row = db.prepare('SELECT * FROM monitor_devices WHERE id=?').get(id);
  if (row) {
    if (computerName && computerName !== row.computer_name) {
      db.prepare('UPDATE monitor_devices SET computer_name=? WHERE id=?').run(computerName, id);
    }
    return row;
  }
  db.prepare('INSERT INTO monitor_devices(id, name, computer_name, created_at, last_seen) VALUES(?,?,?,?,?)')
    .run(id, '电脑-' + String(id).slice(-4), computerName || '', nowStr(), nowStr());
  return db.prepare('SELECT * FROM monitor_devices WHERE id=?').get(id);
}

function listDevices() {
  // 设了显示序号（1~99）的设备按序号排前面；未设（0/NULL）的按接入先后跟在后面
  const rows = db.prepare('SELECT * FROM monitor_devices ORDER BY (COALESCE(sort_order, 0) = 0), COALESCE(sort_order, 0), created_at').all();
  const cnt = db.prepare('SELECT device_id, COUNT(*) c, MAX(ts) last_ts, SUM(ai_tokens) tokens FROM monitor_shots GROUP BY device_id').all();
  const m = new Map(cnt.map((r) => [r.device_id, r]));
  const cfg = getConfig();
  return rows.map((r) => {
    const eff = effCfg(r, cfg);
    return {
      ...r,
      shot_count: (m.get(r.id) || {}).c || 0,
      last_shot: (m.get(r.id) || {}).last_ts || '',
      ai_tokens: (m.get(r.id) || {}).tokens || 0, // 历史总 AI 耗用 token
      cfg_solo: isSolo(r) ? 1 : 0, // 是否启用了单独配置（前端弹窗模式与设备行标记用）
      interval_eff: eff.interval, // 实际生效值（前端展示用）
      width_eff: eff.width,
      ai_eff: eff.ai_enabled,
      ai_every_eff: eff.ai_every,
      retention_days_eff: eff.retention_days,
      keywords_eff: eff.keywords,
      alert_users_eff: eff.alert_users,
      alert_cooldown_eff: eff.alert_cooldown,
    };
  });
}

// ---------- 截图 ----------
function shotBuf(row) {
  if (row.storage_path) {
    try { return fs.readFileSync(row.storage_path); } catch { /* 文件丢了回退库内 base64 */ }
  }
  try { return Buffer.from(row.data || '', 'base64'); } catch { return null; }
}

function addShot(deviceId, buf, shotInterval) {
  const path = storagePaths.bestEffortSave('monitor-shots', deviceId + '.jpg', buf, '');
  const data = path ? '' : buf.toString('base64'); // 未配上传根目录/写盘失败 → 落库兜底
  const ivl = Number(shotInterval) >= 1 ? Math.round(Number(shotInterval)) : null; // 记录当时生效间隔，开关机会话推导依据
  const r = db.prepare('INSERT INTO monitor_shots(device_id, ts, storage_path, data, shot_interval) VALUES(?,?,?,?,?)')
    .run(deviceId, nowStr(), path, data, ivl);
  db.prepare('UPDATE monitor_devices SET last_seen=? WHERE id=?').run(nowStr(), deviceId);
  return r.lastInsertRowid;
}

function listShots(deviceId, page, pageSize) {
  const total = db.prepare('SELECT COUNT(*) c FROM monitor_shots WHERE device_id=?').get(deviceId).c;
  const items = db.prepare('SELECT id, device_id, ts, ai_text, ai_at, ai_tokens, alert_hit FROM monitor_shots WHERE device_id=? ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?')
    .all(deviceId, pageSize, (page - 1) * pageSize);
  // ai_enabled 供前端区分"未开启/待分析"占位文案（设备级覆盖优先，未设置回落全局）
  const dev = db.prepare('SELECT * FROM monitor_devices WHERE id=?').get(deviceId);
  return { total, items, ai_enabled: effCfg(dev, getConfig()).ai_enabled };
}

// ---------- 开关机时段（由截图时间序列推导） ----------
// 规则：相邻两张截图的间隔 > 「前一张截图当时生效的截图间隔 ×2 + 3 分钟缓冲」即视为一次新的开机；
// 一段连续会话的首张截图时间 = 开机时间，末张 = 关机时间。
// 每张截图上报时记录了当时生效的间隔（shot_interval 列）——之后全局/设备间隔改动不会误伤历史推导；
// v1.4.7 之前的旧行没有该列，按长期默认 30 分钟推导（宽松合并，宁可合并不误拆）。
const LEGACY_INTERVAL = 30;

function listSessions(deviceId) {
  const rows = db.prepare('SELECT ts, ai_tokens, shot_interval FROM monitor_shots WHERE device_id=? ORDER BY ts, id').all(deviceId);
  const toMin = (s) => {
    const [d, t] = String(s).split(' ');
    const [Y, M, D] = (d || '').split('-').map(Number);
    const [h, mi] = (t || '0:0').split(':').map(Number);
    return ((Date.UTC(Y, (M || 1) - 1, D || 1) / 60000) || 0) + (h || 0) * 60 + (mi || 0);
  };
  const out = [];
  let cur = null;
  let curIvl = LEGACY_INTERVAL; // 当前会话最后一张截图的当时间隔（决定下一段 gap 的阈值）
  for (const r of rows) {
    const mins = toMin(r.ts);
    if (cur && mins - cur.lastMin > curIvl * 2 + 3) { out.push(cur); cur = null; }
    if (!cur) cur = { start: r.ts, end: r.ts, count: 1, tokens: r.ai_tokens || 0, lastMin: mins };
    else { cur.end = r.ts; cur.count++; cur.tokens += r.ai_tokens || 0; cur.lastMin = mins; }
    curIvl = Number(r.shot_interval) >= 1 ? Number(r.shot_interval) : LEGACY_INTERVAL;
  }
  if (cur) out.push(cur);
  const dur = (s) => {
    const m = Math.max(0, toMin(s.end) - toMin(s.start));
    return m >= 60 ? `${Math.floor(m / 60)} 小时 ${m % 60} 分` : `${m} 分钟`;
  };
  return out.reverse().map((s, i) => ({ no: i + 1, start: s.start, end: s.end, duration: dur(s), shots: s.count, tokens: s.tokens }));
}

// ---------- AI 分析 + 预警 ----------
const analyzing = new Set();      // 设备级串行（防同一设备并行多轮分析）
const alertLast = new Map();      // `${dev}|${kw}` → 最近一次推送时间戳（冷却防轰炸）

// 屏幕概括（走统一 AI 配置的视觉模型，与 PDF 图片识读同一套 vision_* 配置）
async function describeShot(buf) {
  const cfg = aiService.getConfig(null);
  const vModel = cfg.vision_model || cfg.model;
  const vBase = (cfg.vision_base_url || cfg.base_url || '').replace(/\/+$/, '');
  const vKey = cfg.vision_api_key || cfg.api_key;
  if (!vModel || !vBase || !vKey) throw new Error('AI 视觉模型未配置：请到「设置 → AI 配置」填写视觉模型');
  const res = await fetch(aiService.chatEndpoint(vBase), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${vKey}` },
    body: JSON.stringify({
      model: vModel,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '这是一张 Windows 电脑屏幕截图。请用一两句话概括屏幕上正在发生什么（正在使用的软件/网站/游戏与内容主题），并尽量列出可见的窗口或标签页标题。直接输出概括文字，不要任何前缀。' },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + buf.toString('base64') } },
        ],
      }],
      max_tokens: 300, temperature: 0.2,
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`视觉模型接口错误 ${res.status}: ${t.slice(0, 160)}`);
  }
  const data = await res.json();
  // 推理模型偶发 content 为空但内容在 reasoning_content（同 aiService.chat 的兜底）
  const msg = data.choices?.[0]?.message;
  const out = String(msg?.content || msg?.reasoning_content || '').trim();
  if (!out) throw new Error('视觉模型返回内容为空');
  const tokens = Number(data.usage?.total_tokens) || 0; // 本次调用 token 耗用（接口未返回则记 0）
  return { text: out, tokens };
}

function firstAdminId() {
  const r = db.prepare("SELECT id FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
  return r ? r.id : 1;
}

// 预警检查（每张分析完的截图）：keywords/alert_users/alert_cooldown 均取该设备生效配置（v1.4.8 设备级覆盖）。
// 命中即双通道推送：站内信（messageService 自动转钉钉文字）+ 截图本体经钉钉「工作通知」发图（需配置 AgentId）
function alertCheck(device, eff, buf, shotId, ts, text) {
  if (!eff.keywords.length || !eff.alert_users.length) return;
  const now = Date.now();
  const hits = eff.keywords.filter((kw) => text.includes(kw));
  if (!hits.length) return;
  // 命中过预警的截图打标：保留期清理永不删除（只能手动删），推送是否在冷却期不影响打标
  if (shotId) db.prepare('UPDATE monitor_shots SET alert_hit=1 WHERE id=?').run(shotId);
  for (const kw of hits) {
    const key = device.id + '|' + kw;
    const last = alertLast.get(key) || 0;
    if (now - last < eff.alert_cooldown * 60000) continue; // 冷却期内不重复推
    alertLast.set(key, now);
    const subject = `电脑监控预警：${device.name} 命中「${kw}」`;
    const content = `【${device.name}】${ts} 的屏幕截图命中预警关键字「${kw}」。\nAI 概括：${text.slice(0, 300)}\n（截图已通过钉钉工作消息推送）`;
    for (const uid of eff.alert_users) {
      try {
        messageService.send(db, { from_user: firstAdminId(), to_user: uid, subject, content, module: 'monitor' });
      } catch (e) { console.warn('[monitor] 预警消息发送失败:', e.message); }
      // 截图经钉钉工作通知发图（异步自兜底；未绑定/未配 AgentId 静默跳过，文字仍送达）
      if (buf && buf.length) {
        dingtalkService.notifyUserImageBuf(db, uid, buf, 'image/jpeg')
          .catch((e) => console.warn(`[monitor] 预警截图钉钉推送失败(用户${uid}):`, e.message));
      }
    }
  }
}

// 每次上传后调用：未分析张数达到该设备生效的 ai_every 触发一轮（逐张分析，单轮最多 20 张防长尾）
// AI 开关/频率均设备级覆盖优先（v1.4.8）：关掉的设备不再消耗 AI 分析额度
async function maybeAnalyze(deviceId) {
  const cfg = getConfig();
  if (analyzing.has(deviceId)) return;
  const dev = db.prepare('SELECT * FROM monitor_devices WHERE id=?').get(deviceId);
  const eff = effCfg(dev, cfg);
  if (!eff.ai_enabled) return;
  const pending = db.prepare('SELECT COUNT(*) c FROM monitor_shots WHERE device_id=? AND ai_text IS NULL').get(deviceId).c;
  if (pending < eff.ai_every) return;
  analyzing.add(deviceId);
  setImmediate(async () => {
    try {
      const rows = db.prepare('SELECT id, ts FROM monitor_shots WHERE device_id=? AND ai_text IS NULL ORDER BY ts, id LIMIT 20').all(deviceId);
      for (const row of rows) {
        const full = db.prepare('SELECT * FROM monitor_shots WHERE id=?').get(row.id);
        const buf = shotBuf(full);
        if (!buf) { db.prepare('UPDATE monitor_shots SET ai_text=?, ai_at=? WHERE id=?').run('（截图数据缺失）', nowStr(), row.id); continue; }
        try {
          const { text, tokens } = await describeShot(buf);
          db.prepare('UPDATE monitor_shots SET ai_text=?, ai_at=?, ai_tokens=? WHERE id=?').run(text.slice(0, 1000), nowStr(), tokens, row.id);
          alertCheck(ensureDevice(deviceId, ''), effCfg(dev, getConfig()), buf, row.id, row.ts, text);
        } catch (e) {
          // 失败置占位文本（不无限重试）；一轮失败不中断后续图片
          console.warn(`[monitor] AI 分析失败(${deviceId}#${row.id}):`, e.message);
          db.prepare('UPDATE monitor_shots SET ai_text=?, ai_at=? WHERE id=?').run('（AI 分析失败：' + String(e.message).slice(0, 120) + '）', nowStr(), row.id);
        }
      }
    } finally { analyzing.delete(deviceId); }
  });
}

// ---------- 保留期清理（scheduler 每日调用；命中过预警的截图永久保留，仅手动删除） ----------
// 保留天数按各设备生效配置（v1.4.8 设备级覆盖），逐设备清理
function cleanup() {
  const cfg = getConfig();
  const devs = db.prepare('SELECT * FROM monitor_devices').all();
  let total = 0;
  for (const dev of devs) {
    const days = Math.max(1, effCfg(dev, cfg).retention_days);
    const old = db.prepare("SELECT id, storage_path FROM monitor_shots WHERE device_id=? AND alert_hit=0 AND ts < datetime('now', 'localtime', ?)")
      .all(dev.id, '-' + days + ' days');
    for (const r of old) {
      if (r.storage_path) { try { fs.unlinkSync(r.storage_path); } catch { /* 已不在 */ } }
      db.prepare('DELETE FROM monitor_shots WHERE id=?').run(r.id);
    }
    total += old.length;
  }
  return total;
}

// 手动删除截图（单张/批量，含预警命中永久保留的）：先取 storage_path 删磁盘文件，再删行；返回实际删除数
function deleteShots(ids) {
  const list = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
  if (!list.length) return 0;
  const ph = list.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, storage_path FROM monitor_shots WHERE id IN (${ph})`).all(...list);
  for (const r of rows) { if (r.storage_path) { try { fs.unlinkSync(r.storage_path); } catch { /* 已不在 */ } } }
  return db.prepare(`DELETE FROM monitor_shots WHERE id IN (${ph})`).run(...list).changes;
}

module.exports = { getConfig, saveConfig, ensureDevice, effCfg, listDevices, addShot, listShots, shotBuf, listSessions, maybeAnalyze, cleanup, deleteShots };
