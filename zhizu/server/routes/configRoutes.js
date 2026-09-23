// 算力配置（全局 admin + 个人覆盖）+ 我的资料
const express = require('express');
const { db, getSetting, setSetting } = require('../db');
const ai = require('../services/aiService');
const { encrypt } = require('../services/cryptoUtil');

const router = express.Router();

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}

// ---- 算力配置 ----
router.get('/ai', (req, res) => {
  const mine = {
    base: req.user.ai_base || '',
    model: req.user.ai_model || '',
    key_masked: req.user.ai_key ? '***' : '',
    configured: !!(req.user.ai_key && req.user.ai_base),
  };
  res.json({ global: ai.maskConfig(), personal: mine });
});

// 全局配置（admin）
router.put('/ai/global', adminOnly, (req, res) => {
  const b = req.body || {};
  if ('base' in b) setSetting('ai_base', String(b.base || '').trim().slice(0, 300));
  if ('model' in b) setSetting('ai_model', String(b.model || '').trim().slice(0, 100));
  if ('key' in b) setSetting('ai_key', encrypt(String(b.key || '').trim().slice(0, 200)));
  res.json({ global: ai.maskConfig() });
});

// 个人覆盖配置
router.put('/ai/personal', (req, res) => {
  if (req.user.role === 'guest') return res.status(403).json({ error: '受限用户不能配置个人算力，请联系管理员' });
  const b = req.body || {};
  const sets = [];
  const args = [];
  if ('base' in b) { sets.push('ai_base=?'); args.push(String(b.base || '').trim().slice(0, 300)); }
  if ('model' in b) { sets.push('ai_model=?'); args.push(String(b.model || '').trim().slice(0, 100)); }
  if ('key' in b) { sets.push('ai_key=?'); args.push(encrypt(String(b.key || '').trim().slice(0, 200))); }
  if (sets.length) {
    args.push(req.user.id);
    db.prepare(`UPDATE users SET ${sets.join(',')} WHERE id=?`).run(...args);
  }
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  res.json({
    personal: {
      base: u.ai_base || '', model: u.ai_model || '',
      key_masked: u.ai_key ? '***' : '',
      configured: !!(u.ai_key && u.ai_base),
    },
  });
});

// 清除个人覆盖（回落全局）
router.delete('/ai/personal', (req, res) => {
  db.prepare("UPDATE users SET ai_base='',ai_model='',ai_key='' WHERE id=?").run(req.user.id);
  res.json({ ok: true });
});

// 测试算力（用当前生效配置发一条真实消息）
router.post('/ai/test', async (req, res) => {
  const cfg = ai.resolveConfig(req.user);
  if (!cfg) return res.status(400).json({ error: '没有可用算力配置（全局或个人至少其一）' });
  const started = Date.now();
  try {
    const r = await ai.chat(cfg, [{ role: 'user', content: '你好，请回复"算力配置正常"五个字。' }], { timeout: 30000 });
    res.json({ ok: true, model: r.model, tokens: r.tokens, ms: Date.now() - started, reply: r.content.slice(0, 200), source: cfg.source });
  } catch (e) {
    res.status(502).json({ error: e.message, source: cfg.source });
  }
});

// 热门话题源开关（admin）
router.get('/hot-sources', (req, res) => {
  res.json({ sources: getSetting('hot_sources', { baidu: true, sina: true, ai: true }) });
});
router.put('/hot-sources', adminOnly, (req, res) => {
  const b = req.body || {};
  const cur = getSetting('hot_sources', { baidu: true, sina: true, ai: true });
  const next = { ...cur };
  for (const k of ['baidu', 'sina', 'ai']) if (k in b) next[k] = !!b[k];
  setSetting('hot_sources', next);
  res.json({ sources: next });
});

// ---- 我的资料 ----
router.put('/profile', (req, res) => {
  const b = req.body || {};
  const u = req.user;
  if ('display_name' in b) db.prepare('UPDATE users SET display_name=? WHERE id=?').run(String(b.display_name || '').slice(0, 50), u.id);
  if ('nickname' in b) db.prepare('UPDATE users SET nickname=? WHERE id=?').run(String(b.nickname || '').slice(0, 50), u.id);
  if ('bio' in b) db.prepare('UPDATE users SET bio=? WHERE id=?').run(String(b.bio || '').slice(0, 500), u.id);
  if ('industry_persona' in b) db.prepare('UPDATE users SET industry_persona=? WHERE id=?').run(String(b.industry_persona || '').slice(0, 2000), u.id);
  // AI 选题定时配置（受限用户不可用）
  if ('ai_topic_industries' in b || 'ai_topic_time' in b) {
    if (u.role === 'guest') return res.status(403).json({ error: '受限用户不能配置 AI 选题' });
    if ('ai_topic_industries' in b) {
      const arr = Array.isArray(b.ai_topic_industries)
        ? b.ai_topic_industries.map(x => String(x || '').trim().slice(0, 30)).filter(Boolean).slice(0, 12)
        : [];
      db.prepare('UPDATE users SET ai_topic_industries=? WHERE id=?').run(JSON.stringify(arr), u.id);
    }
    if ('ai_topic_time' in b) {
      const m = String(b.ai_topic_time || '').match(/^(\d{1,2}):(\d{2})$/);
      const norm = m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
      db.prepare('UPDATE users SET ai_topic_time=? WHERE id=?').run(norm, u.id);
    }
  }
  const fresh = db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
  const { publicUser } = require('./authRoutes');
  res.json({ user: publicUser(fresh) });
});

// 头像上传（dataURL，前端已压缩）
router.put('/avatar', (req, res) => {
  const dataUrl = String((req.body || {}).avatar || '');
  if (!dataUrl) { // 空 = 删除头像
    db.prepare("UPDATE users SET avatar='' WHERE id=?").run(req.user.id);
    return res.json({ ok: true, avatar: '' });
  }
  const m = dataUrl.match(/^data:(image\/(png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return res.status(400).json({ error: '头像格式不合法（仅支持 png/jpg/webp/gif）' });
  const buf = Buffer.from(m[3], 'base64');
  if (buf.length > 300 * 1024) return res.status(400).json({ error: '头像过大（压缩后应小于 300KB）' });
  db.prepare('UPDATE users SET avatar=? WHERE id=?').run(dataUrl, req.user.id);
  res.json({ ok: true, avatar: `/api/avatar/${req.user.id}?v=${Date.now()}` });
});

module.exports = { router };
