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

module.exports = router;
