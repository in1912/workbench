// 数字人路由（v1.12.0）。全部数据落租户库（req.tdb 由 auth 中间件注入），/api 前缀挂载。
// 参考图 raw 端点同笔记附件：带登录态（或 ?token=）直取，供 <img>/卡片叠放与将来 Vivix 服务端取图。
const express = require('express');
const fs = require('fs');
const multer = require('multer');
const dh = require('../services/dhService');

const router = express.Router();
const int = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : d; };

// 与 noteRoutes 同款：10MB 上限 + 中文文件名 latin1→utf8 修复
const uploadOne = (field) => {
  const mw = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } }).single(field);
  return (req, res, next) => mw(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? '文件超过 10MB 上限' : `上传失败：${err.message}`;
      return res.status(400).json({ error: msg });
    }
    next();
  });
};
function fixUploadName(n) {
  const raw = String(n || '');
  if (!/[\u0080-ÿ]/.test(raw)) return raw;
  const dec = Buffer.from(raw, 'latin1').toString('utf8');
  return dec.includes('�') ? raw : dec;
}

const MAX_IMAGES = 8; // 每个数字人最多 8 张参考图（Vivix 建会话只取前 5 张，多出的供卡片预览）

function getPersona(tdb, id) {
  return tdb.prepare('SELECT * FROM dh_personas WHERE id=?').get(int(id, -1));
}
function personaBody(b) {
  const o = b || {};
  return {
    name: String(o.name || '').trim().slice(0, 60) || '数字人',
    type: dh.TYPES.includes(o.type) ? o.type : '女友',
    api_base: String(o.api_base || '').trim().slice(0, 200) || 'https://api.vivix.ai',
    model: String(o.model || '').trim().slice(0, 80) || 'vivix-a1-stream',
    voice_id: String(o.voice_id || '').trim().slice(0, 60) || 'longanhuan_v3.6',
    // 公网访问地址（v1.12.1）：https:// 开头、去尾斜杠；格式硬校验放 createSession（存时宽松，
    // 建会话时给出明确报错指路），这里只做基础规整
    public_base: String(o.public_base || '').trim().replace(/\/+$/, '').slice(0, 200),
    remark: String(o.remark || '').slice(0, 200),
    note: String(o.note || '').slice(0, 4000),
    persona: JSON.stringify(dh.sanitizePersona(o.persona)),
  };
}

// ---------- 元数据 + 角色列表（首次访问惰性种子） ----------
router.get('/dh/meta', (req, res) => {
  const tdb = req.tdb;
  dh.seedIfNeeded(tdb);
  dh.ensureDefault(tdb);
  res.json({
    voices: dh.VOICES, types: dh.TYPES,
    aspects: dh.ASPECTS, resolutions: dh.RESOLUTIONS,
    persona_defaults: dh.PERSONA_DEFAULTS,
    max_images: MAX_IMAGES,
    personas: dh.listPersonas(tdb),
  });
});

// ---------- 角色注册表 CRUD ----------
router.post('/dh/personas', (req, res) => {
  const tdb = req.tdb;
  const f = personaBody(req.body);
  const r = tdb.prepare(`INSERT INTO dh_personas(name,type,api_base,api_key,model,voice_id,public_base,remark,note,persona)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(f.name, f.type, f.api_base, String(req.body.api_key || '').trim().slice(0, 200),
    f.model, f.voice_id, f.public_base, f.remark, f.note, f.persona);
  dh.ensureDefault(tdb);
  res.json({ ok: true, id: Number(r.lastInsertRowid) });
});

router.put('/dh/personas/:id', (req, res) => {
  const tdb = req.tdb;
  const p = getPersona(tdb, req.params.id);
  if (!p) return res.status(404).json({ error: '数字人不存在' });
  const f = personaBody(req.body);
  // api_key：前端只在「填了新值」或「点了清除」时才带该字段（'', 清除）
  if (typeof req.body.api_key === 'string') {
    tdb.prepare(`UPDATE dh_personas SET name=?,type=?,api_base=?,api_key=?,model=?,voice_id=?,public_base=?,remark=?,note=?,persona=?,
      updated_at=datetime('now','localtime') WHERE id=?`)
      .run(f.name, f.type, f.api_base, req.body.api_key.trim().slice(0, 200), f.model, f.voice_id, f.public_base, f.remark, f.note, f.persona, p.id);
  } else {
    tdb.prepare(`UPDATE dh_personas SET name=?,type=?,api_base=?,model=?,voice_id=?,public_base=?,remark=?,note=?,persona=?,
      updated_at=datetime('now','localtime') WHERE id=?`)
      .run(f.name, f.type, f.api_base, f.model, f.voice_id, f.public_base, f.remark, f.note, f.persona, p.id);
  }
  res.json({ ok: true });
});

router.delete('/dh/personas/:id', (req, res) => {
  const tdb = req.tdb;
  const p = getPersona(tdb, req.params.id);
  if (p) {
    for (const im of tdb.prepare('SELECT * FROM dh_images WHERE persona_id=?').all(p.id)) {
      if (im.storage_path) { try { fs.unlinkSync(im.storage_path); } catch { /* 文件不在就算了 */ } }
    }
    tdb.prepare('DELETE FROM dh_images WHERE persona_id=?').run(p.id);
    tdb.prepare('DELETE FROM dh_history WHERE persona_id=?').run(p.id);
    tdb.prepare('DELETE FROM dh_personas WHERE id=?').run(p.id);
    dh.ensureDefault(tdb);
  }
  res.json({ ok: true });
});

// 设为默认人物（悬浮按钮/数字人界面的「当前」就是它）
router.post('/dh/personas/:id/default', (req, res) => {
  const tdb = req.tdb;
  const p = getPersona(tdb, req.params.id);
  if (!p) return res.status(404).json({ error: '数字人不存在' });
  tdb.prepare('UPDATE dh_personas SET is_default=0').run();
  tdb.prepare('UPDATE dh_personas SET is_default=1 WHERE id=?').run(p.id);
  res.json({ ok: true });
});

// ---------- 参考图 ----------
router.post('/dh/personas/:id/images', uploadOne('file'), (req, res) => {
  const tdb = req.tdb;
  const p = getPersona(tdb, req.params.id);
  if (!p) return res.status(404).json({ error: '数字人不存在' });
  const file = req.file;
  if (!file || !file.buffer || !file.buffer.length) return res.status(400).json({ error: '空文件' });
  if (!/^image\/(png|jpe?g|webp)$/i.test(file.mimetype || '')) {
    return res.status(400).json({ error: '仅支持 PNG / JPG / WEBP 图片' });
  }
  const cnt = tdb.prepare('SELECT COUNT(*) c FROM dh_images WHERE persona_id=?').get(p.id).c;
  if (cnt >= MAX_IMAGES) return res.status(400).json({ error: `每个数字人最多 ${MAX_IMAGES} 张参考图` });
  const name = fixUploadName(file.originalname || 'image').slice(0, 120);
  const r = dh.storeImage(tdb, p.id, { originalname: name, mimetype: file.mimetype, buffer: file.buffer });
  if (r.error) return res.status(400).json({ error: r.error });
  res.json({ ok: true, id: r.id });
});

// 改首图描述 / 排序（sort 越小越靠前）
router.put('/dh/images/:id', (req, res) => {
  const tdb = req.tdb;
  const im = tdb.prepare('SELECT * FROM dh_images WHERE id=?').get(int(req.params.id, -1));
  if (!im) return res.status(404).json({ error: '图片不存在' });
  tdb.prepare('UPDATE dh_images SET description=?, sort=? WHERE id=?')
    .run(String(req.body.description || '').slice(0, 500), int(req.body.sort, im.sort), im.id);
  res.json({ ok: true });
});

router.delete('/dh/images/:id', (req, res) => {
  const tdb = req.tdb;
  const im = tdb.prepare('SELECT * FROM dh_images WHERE id=?').get(int(req.params.id, -1));
  if (im) {
    if (im.storage_path) { try { fs.unlinkSync(im.storage_path); } catch { /* 文件不在就算了 */ } }
    tdb.prepare('DELETE FROM dh_images WHERE id=?').run(im.id);
  }
  res.json({ ok: true });
});

// 图片本体（<img src> 直取；将来 Vivix 服务端也要经它下载参考图）
router.get('/dh/images/:id/raw', (req, res) => {
  const im = req.tdb.prepare('SELECT * FROM dh_images WHERE id=?').get(int(req.params.id, -1));
  if (!im) return res.status(404).json({ error: '图片不存在' });
  res.setHeader('Content-Type', im.mime || 'image/png');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(im.orig_name || 'image')}`);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (im.storage_path && fs.existsSync(im.storage_path)) return fs.createReadStream(im.storage_path).pipe(res);
  if (im.data) return res.end(Buffer.from(im.data, 'base64'));
  res.status(404).json({ error: '图片内容已丢失' });
});

// ---------- 历史对话 ----------
router.get('/dh/history', (req, res) => {
  const tdb = req.tdb;
  const pid = int(req.query.persona_id, -1);
  if (!getPersona(tdb, pid)) return res.status(404).json({ error: '数字人不存在' });
  const limit = Math.min(1000, Math.max(1, int(req.query.limit, 200)));
  const rows = tdb.prepare(
    `SELECT * FROM (SELECT id,role,text,audio_file,ts FROM dh_history WHERE persona_id=? ORDER BY id DESC LIMIT ?)
     ORDER BY id ASC`
  ).all(pid, limit);
  res.json({ items: rows });
});

router.delete('/dh/history', (req, res) => {
  const tdb = req.tdb;
  const pid = int(req.query.persona_id, -1);
  tdb.prepare('DELETE FROM dh_history WHERE persona_id=?').run(pid);
  res.json({ ok: true });
});

// ---------- 文字试聊（工作台已配置的 AI + 人设 system；真实语音会话接入后同一张表） ----------
router.post('/dh/chat', async (req, res) => {
  try {
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: '说点什么吧' });
    const pid = int(req.body.persona_id, -1);
    const out = await dh.chat(req.tdb, pid, text);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ error: e.message || '对话失败' });
  }
});

// ---------- Vivix 会话配置预览（buildSessionJson 组装结果；建实时会话时用同一函数） ----------
router.get('/dh/personas/:id/preview', (req, res) => {
  const tdb = req.tdb;
  const p = getPersona(tdb, req.params.id);
  if (!p) return res.status(404).json({ error: '数字人不存在' });
  res.json({ session: dh.buildSessionJson(tdb, p) });
});

// ---------- 连通性测试：GET /v1/models（轻量，不建会话不烧额度） ----------
router.post('/dh/personas/:id/test', async (req, res) => {
  const p = getPersona(req.tdb, req.params.id);
  if (!p) return res.status(404).json({ error: '数字人不存在' });
  try { res.json(await dh.testKey(p)); } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ---------- 余额查询：GET /v1/balance（v1.12.3；端点存在但官方文档没写，形状宽松解析） ----------
router.get('/dh/personas/:id/balance', async (req, res) => {
  const p = getPersona(req.tdb, req.params.id);
  if (!p) return res.status(404).json({ error: '数字人不存在' });
  try { res.json(await dh.getBalance(p)); } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ---------- 实时会话（v1.12.1）：建会话（API Key 只在服务端；浏览器只拿拉流凭证） ----------
router.post('/dh/personas/:id/session', async (req, res) => {
  const tdb = req.tdb;
  const p = getPersona(tdb, req.params.id);
  if (!p) return res.status(404).json({ error: '数字人不存在' });
  try {
    const s = await dh.createSession(tdb, p);
    // 建会话的完整载荷（人设/参考图 URL）不出服务端；浏览器拿到的只有连接凭证
    res.json({
      ok: true,
      session_id: s.session_id,
      control: { url: s.control.url, client_secret: s.control.client_secret },
      trtc: (s.delivery && s.delivery.media && s.delivery.media.trtc) || null,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || '建会话失败' });
  }
});

// 结束实时会话（status 期望 closing/closed；失败时前端提示重试，auto_close 90 秒兜底）
router.post('/dh/personas/:id/session/close', async (req, res) => {
  const tdb = req.tdb;
  const p = getPersona(tdb, req.params.id);
  if (!p) return res.status(404).json({ error: '数字人不存在' });
  const sid = String(req.body.session_id || '').trim();
  if (!sid) return res.status(400).json({ error: '缺少 session_id' });
  try { res.json({ ok: true, status: await dh.closeSession(tdb, p, sid) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message || '关闭失败' }); }
});

// 实时会话落历史：live 会话里的用户文字与对方回复写进同一张 dh_history，
// 「聊天记录」页与右下角悬浮窗共用这张表（前端写完 bump histVer 互相通知重拉）
router.post('/dh/history', (req, res) => {
  const tdb = req.tdb;
  const pid = int(req.body.persona_id, -1);
  if (!getPersona(tdb, pid)) return res.status(404).json({ error: '数字人不存在' });
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: '空内容' });
  const role = req.body.role === 'assistant' ? 'assistant' : 'user';
  res.json({ ok: true, item: dh.addHistory(tdb, pid, role, text) });
});

// =====================================================================================
// 智能家居控制（v1.13.1）—— 数字人设置里的新 tab，控制「人工智能 → 米家」的设备
//
// 为什么新开 /dh/smarthome/* 而不是直接复用 /xiaozhi/*：
//   /xiaozhi 在 auth.js 里归「智能板」那个 tab，只有 dh 权限的人调不到。挂在 /dh 前缀下就自动
//   继承 smarthome.dh 的权限，不必动 auth.js。（漏这层映射会让权限静默失效——§4 的规矩）
//
// 数据是**同一份** xiaozhi_config（主库 settings，家庭共享，不是租户库）：控制通道 / 智能屏点位 /
// 家庭过滤 / 设备别名都只有一处。也就是说这一页和「智能板 → 语音控米家」改的是同一份配置，
// 两边任一处改完另一处刷新即见——面板里已如实写明，免得以为是两份。
//
// 这里刻意**不含**板子侧内容：桥接地址、桥接密钥、编译烧录、固件、串口、装机向导一律没有。
// =====================================================================================
const xiaozhiSvc = require('../services/xiaozhiService');

const asyncH = (fn) => (req, res) => Promise.resolve(fn(req, res))
  .catch((e) => { console.error('[dh/smarthome]', e.message); res.status(503).json({ error: e.message || '智能家居接口调用失败' }); });
function dhAdminOnly(req, res) {
  if (req.user.role !== 'admin') { res.status(403).json({ error: '仅管理员可操作' }); return false; }
  return true;
}
const dhNormName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');

// 设备一览 + 家庭清单 + 当前配置（一次拿全，面板不用发三次请求）
router.get('/dh/smarthome/devices', asyncH(async (req, res) => {
  const cfg = xiaozhiSvc.getPublicConfig();
  const base = { home_filter: cfg.home_filter || 'all', channel: cfg.channel || 'direct', speaker: cfg.speaker || {}, is_admin: req.user.role === 'admin' };
  try {
    const devices = await xiaozhiSvc.listDevicesForBridge(req.query.fresh === '1', { includeParents: true });
    const homes = [...new Set(devices.map((d) => d.home).filter(Boolean))];
    res.json({ bound: true, devices, homes, ...base });
  } catch (e) {
    // 未绑米家等：不 500，让面板能区分「没绑」和「绑了但没设备」
    res.json({ bound: false, devices: [], homes: [], message: e.message, ...base });
  }
}));

// 逐台快捷开关（登录 + dh 权限即可，与智能板面板同口径）
router.post('/dh/smarthome/control', asyncH(async (req, res) => {
  const did = String((req.body || {}).did || '').trim();
  const action = String((req.body || {}).action || '').trim();
  if (!/^[\w.-]{1,64}$/.test(did)) return res.status(400).json({ error: 'did 格式不对' });
  if (!['on', 'off', 'toggle'].includes(action)) return res.status(400).json({ error: 'action 只支持 on / off / toggle' });
  res.json(await xiaozhiSvc.dispatch('control', { device: did, action }));
}));

// 实时会话里的设备指令判定 + 执行（v1.13.3）。
// 为什么需要它：实时会话（说话 / 在数字人界面打字）的内容**不经过工作台服务器**——浏览器把
// 音视频与文字直连 Vivix 的 WSS 控制通道，回话也是 Vivix 的云端模型生成的。所以服务端只能
// 反过来被浏览器问一次：「这句是不是设备指令？」是就当场执行（与智能板同一条 mihome 链路），
// 把**真实回执**交给浏览器，由浏览器再喂给 Vivix 让它照实念（见 web/src/dhLive.js）。
// 不影响打字试聊：那条路（/dh/chat）自己就会截，不会走这里。
router.post('/dh/smarthome/command', asyncH(async (req, res) => {
  const text = String((req.body || {}).text || '').trim().slice(0, 200);
  if (!text) return res.status(400).json({ error: 'text 不能为空' });
  const ctl = await dh.tryDeviceControl(text);
  res.json(ctl ? { matched: true, control: ctl, message: String(ctl.message || '') } : { matched: false, message: '' });
}));

// 别名对照表（管理员；校验逻辑与 /xiaozhi/device-alias 同款：
// 别名等于本名起不到接管作用、两台同别名照样分不开，都在保存时拦下）
router.put('/dh/smarthome/alias', asyncH(async (req, res) => {
  if (!dhAdminOnly(req, res)) return;
  const did = String(req.body?.did || '').trim();
  const alias = String(req.body?.alias || '').trim();
  if (alias) {
    let devices = [];
    try { devices = await xiaozhiSvc.listDevicesForBridge(); } catch { /* 未绑米家：跳过交叉校验，仅做格式检查 */ }
    const me = devices.find((d) => String(d.did) === did);
    if (me && dhNormName(alias) === dhNormName(me.name)) {
      return res.status(400).json({ error: `别名「${alias}」和设备本名相同——起不到消歧作用，请换一个不同的叫法` });
    }
    const clash = devices.find((d) => String(d.did) !== did && d.alias && dhNormName(d.alias) === dhNormName(alias));
    if (clash) {
      return res.status(400).json({ error: `别名「${alias}」已被「${clash.room === '未分区' ? '' : clash.room + '的'}${clash.name}」占用——两台同别名还是分不开，请换个名字` });
    }
  }
  try { res.json({ ok: true, device_aliases: xiaozhiSvc.setDeviceAlias(did, alias) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));

// 控制通道 / 智能屏备用通道 / 家庭过滤（管理员）——校验与 /xiaozhi/config 逐条对齐
router.put('/dh/smarthome/config', asyncH(async (req, res) => {
  if (!dhAdminOnly(req, res)) return;
  const b = req.body || {};
  const patch = {};
  if (b.channel !== undefined) {
    if (!['direct', 'speaker'].includes(b.channel)) return res.status(400).json({ error: 'channel 只支持 direct（直接米家）/ speaker（智能屏转述）' });
    patch.channel = b.channel;
  }
  if (b.home_filter !== undefined) {
    const v = String(b.home_filter || '').trim();
    if (v.length > 32) return res.status(400).json({ error: '家庭名最长 32 个字' });
    patch.home_filter = v || 'all';
  }
  if (b.speaker) {
    const did = String(b.speaker.did || '').trim();
    if (!/^\d{1,20}$/.test(did)) return res.status(400).json({ error: '智能屏 did 需为纯数字' });
    const pt = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
    const sp = {
      did, siid_play: pt(b.speaker.siid_play), aiid_play: pt(b.speaker.aiid_play) || 3,
      siid_exec: pt(b.speaker.siid_exec), aiid_exec: pt(b.speaker.aiid_exec) || 4,
      piid_play: pt(b.speaker.piid_play) || 1, piid_exec: pt(b.speaker.piid_exec) || 1,
    };
    for (const [k, v] of Object.entries(sp)) {
      if (k === 'did') continue; // did 是纯数字字符串（走上面的正则），其余点位才要求整数
      if (v != null && !Number.isInteger(v)) return res.status(400).json({ error: `speaker.${k} 需为整数` });
    }
    patch.speaker = sp;
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: '没有可保存的字段' });
  const cfg = xiaozhiSvc.saveConfig(patch);
  res.json({ ok: true, config: { home_filter: cfg.home_filter || 'all', channel: cfg.channel || 'direct', speaker: cfg.speaker || {} } });
}));

// 智能屏点位自动探测 + 试播 / 试执行
router.post('/dh/smarthome/speaker-probe', asyncH(async (req, res) => {
  const sp = await xiaozhiSvc.ensureSpeakerPoints(true);
  res.json({
    ok: !!(sp.siid_play || sp.siid_exec),
    speaker: sp,
    message: sp.siid_play && sp.siid_exec
      ? `已定位：播放文本 siid${sp.siid_play}/aiid${sp.aiid_play}，执行指令 siid${sp.siid_exec}/aiid${sp.aiid_exec}`
      : 'spec 里没找到 play-text / execute-text-directive 动作，请手动填 siid',
  });
}));
router.post('/dh/smarthome/speaker-test', asyncH(async (req, res) => {
  const b = req.body || {};
  const text = String(b.text || '').trim().slice(0, 200);
  if (!text) return res.status(400).json({ error: 'text 不能为空' });
  res.json(await xiaozhiSvc.speakerAction(b.kind === 'exec' ? 'exec' : 'play', text));
}));

module.exports = router;
