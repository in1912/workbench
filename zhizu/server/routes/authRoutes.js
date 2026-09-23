// 认证 + 用户管理
const express = require('express');
const crypto = require('crypto');
const { db } = require('../db');

const router = express.Router();

// ---- 密码哈希 scrypt ----
function hashPwd(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pwd), salt, 32).toString('hex');
  return `${salt}:${h}`;
}
function verifyPwd(pwd, stored) {
  const [salt, h] = String(stored || '').split(':');
  if (!salt || !h) return false;
  const calc = crypto.scryptSync(String(pwd), salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(h));
}

const SESSION_DAYS = 14;

// 首次启动引导管理员
function initAdmin() {
  const row = db.prepare('SELECT COUNT(*) c FROM users').get();
  if (row.c === 0) {
    db.prepare('INSERT INTO users(username,password_hash,role,display_name) VALUES(?,?,?,?)')
      .run('admin', hashPwd(process.env.DEFAULT_ADMIN_PASSWORD || 'admin123'), 'admin', '管理员');
    console.log('[文案库] 已创建默认管理员 admin / ' + (process.env.DEFAULT_ADMIN_PASSWORD || 'admin123'));
  }
}
initAdmin();

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, role: u.role,
    display_name: u.display_name, nickname: u.nickname, bio: u.bio,
    avatar: u.avatar ? `/api/avatar/${u.id}` : '',
    industry_persona: u.industry_persona,
    ai_topic_industries: (() => { try { return JSON.parse(u.ai_topic_industries || '[]'); } catch { return []; } })(),
    ai_topic_time: u.ai_topic_time || '',
    has_personal_ai: !!(u.ai_key && u.ai_base),
    created_at: u.created_at,
  };
}

function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  db.prepare('INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)')
    .run(token, userId, expires.toISOString());
  return token;
}

// 登录
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(String(username || '').trim());
  if (!u || !verifyPwd(password, u.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = createSession(u.id);
  res.json({ token, user: publicUser(u) });
});

// 会话解析（供 index.js 中间件用）
function resolveUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || '');
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token=? AND s.expires_at > datetime('now')`).get(token);
  return row || null;
}

// 当前用户
router.get('/me', (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// 修改自己的密码
router.put('/password', (req, res) => {
  const { old_password, new_password } = req.body || {};
  if (!verifyPwd(old_password, req.user.password_hash)) return res.status(400).json({ error: '原密码错误' });
  if (!new_password || String(new_password).length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPwd(new_password), req.user.id);
  res.json({ ok: true });
});

// 登出
router.post('/logout', (req, res) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  res.json({ ok: true });
});

// ---- 用户管理（admin）----
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}

router.get('/users', adminOnly, (req, res) => {
  const rows = db.prepare('SELECT * FROM users ORDER BY id').all();
  res.json({ users: rows.map(publicUser) });
});

// 角色归一：admin 管理员 / user 普通用户 / guest 受限用户（仅浏览，不能消耗 AI 算力）
const normRole = (r) => (r === 'admin' || r === 'guest') ? r : 'user';

router.post('/users', adminOnly, (req, res) => {
  const { username, password, display_name, role } = req.body || {};
  const name = String(username || '').trim();
  if (!/^[a-zA-Z0-9_一-龥]{2,30}$/.test(name)) return res.status(400).json({ error: '用户名 2-30 位（字母数字下划线中文）' });
  if (!password || String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (db.prepare('SELECT id FROM users WHERE username=?').get(name)) return res.status(400).json({ error: '用户名已存在' });
  const r = db.prepare('INSERT INTO users(username,password_hash,role,display_name) VALUES(?,?,?,?)')
    .run(name, hashPwd(password), normRole(role), String(display_name || '').slice(0, 50));
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
  res.json({ user: publicUser(u) });
});

router.put('/users/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  const b = req.body || {};
  if ('display_name' in b) db.prepare('UPDATE users SET display_name=? WHERE id=?').run(String(b.display_name || '').slice(0, 50), id);
  if ('role' in b) {
    if (u.id === req.user.id && b.role !== 'admin') return res.status(400).json({ error: '不能取消自己的管理员身份' });
    db.prepare('UPDATE users SET role=? WHERE id=?').run(normRole(b.role), id);
  }
  if (b.password) {
    if (String(b.password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hashPwd(b.password), id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(id); // 重置即踢下线
  }
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)) });
});

router.delete('/users/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: '不能删除自己' });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) return res.status(404).json({ error: '用户不存在' });
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
  db.prepare('DELETE FROM gen_records WHERE user_id=?').run(id);
  res.json({ ok: true });
});

// ---- 头像（<img> 无法带 Authorization，走 ?token=）----
router.get('/avatar/:uid', (req, res) => {
  const u = resolveUser(req); // 复用 token 解析（支持 query token）
  if (!u) return res.status(401).json({ error: '未登录' });
  const target = db.prepare('SELECT avatar FROM users WHERE id=?').get(Number(req.params.uid));
  const dataUrl = target && target.avatar;
  const m = dataUrl && dataUrl.match(/^data:(image\/[a-z+]+);base64,(.+)$/);
  if (!m) return res.status(404).json({ error: '无头像' });
  res.set('Content-Type', m[1]);
  res.set('Cache-Control', 'private, max-age=300');
  res.send(Buffer.from(m[2], 'base64'));
});

module.exports = { router, resolveUser, publicUser, hashPwd };
