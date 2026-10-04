// 笔记分享 + 外部写入令牌（v1.9.39）
//
// 免登录端点（在 server/index.js 的 EXEMPT 里）：
//   GET  /share/n/:token?c=码        读分享内容（token + 4 位码 双校验）
//   GET  /share/n/:token/audio?c=码  分享附带的录音（Range 流式）
//   POST /note-intake/:token         外部系统/AI 推入一条笔记（只写，无任何读/删端点）
//   ⚠️ 这些端点一律返回 403/404，绝不 401 —— 前端 handle401() 会把访客弹去 #/login
//
// 登录态端点（挂在 /notes 前缀下 → 自动继承「笔记」页权限）：
//   GET/POST /notes/shares/note/:id   列/建 该笔记的分享链接
//   PUT/DELETE /notes/shares/:sid     改有效期/关闭访问、删除
//
// 匿名请求没有租户上下文 → 靠 token 逐租户反查（只遍历已存在的租户库文件，不凭空建库）
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, getTenantDb, tenantDbFile } = require('../db');

const router = express.Router();

// 4 位混合码：大小写字母 + 数字，剔除 I/l/1/O/o/0 等易混字符（粘贴/手抄不容易错）
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
function randomCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return s;
}
function localNow() {
  return new Date().toLocaleString('sv').slice(0, 19); // YYYY-MM-DD HH:MM:SS（本地时区，与 SQLite localtime 一致）
}

// ---- 暴力破解限流（内存，进程内；token+IP 维度，10 分钟 10 次） ----
const failLog = new Map();
const RL_WINDOW = 10 * 60 * 1000;
const RL_MAX = 10;
function tooMany(key) {
  const e = failLog.get(key);
  if (!e) return false;
  if (Date.now() > e.until) { failLog.delete(key); return false; }
  return e.n >= RL_MAX;
}
function recordFail(key) {
  if (failLog.size > 2000) failLog.clear(); // 防内存无限增长（正常永远到不了）
  const now = Date.now();
  const e = failLog.get(key);
  if (!e || now > e.until) failLog.set(key, { n: 1, until: now + RL_WINDOW });
  else e.n += 1;
}

// 逐租户查找（匿名请求无租户上下文）。只打开已存在的库文件，避免给没用过工作台的账号凭空建库
function findAcrossTenants(fn) {
  const users = db.prepare('SELECT id, username FROM users WHERE is_bot=0 ORDER BY id').all();
  for (const u of users) {
    let file; try { file = tenantDbFile(u.id); } catch { continue; }
    if (!fs.existsSync(file)) continue;
    let t; try { t = getTenantDb(u.id); } catch { continue; }
    let hit; try { hit = fn(t, u); } catch { continue; }
    if (hit) return hit;
  }
  return null;
}

// 校验一个分享请求（token + 码 + 未关闭 + 未过期）；不合法时返回 { err: [status, msg] }
function authorize(req) {
  const token = String(req.params.token || '');
  if (!token || token.length < 16) return { err: [404, '链接不存在或已失效'] };
  const rlKey = `${token}|${req.ip}`;
  if (tooMany(rlKey)) return { err: [429, '尝试过于频繁，请稍后再试'] };
  const found = findAcrossTenants((tdb) => {
    const s = tdb.prepare('SELECT * FROM note_shares WHERE token=?').get(token);
    return s ? { share: s, tdb } : null;
  });
  if (!found) return { err: [404, '链接不存在或已失效'] };
  const { share, tdb } = found;
  if (share.disabled) return { err: [403, '该分享已被关闭'] };
  if (share.expires_at && share.expires_at <= localNow()) return { err: [403, '该分享已过期'] };
  const code = String(req.query.c || '');
  if (!code || code !== share.code) { recordFail(rlKey); return { err: [403, '访问密码不正确'] }; }
  return { share, tdb };
}

// ---------- 免登录：读分享内容 ----------
router.get('/share/n/:token', (req, res) => {
  const a = authorize(req);
  if (a.err) return res.status(a.err[0]).json({ error: a.err[1] });
  const { share, tdb } = a;
  let title, content, category, tags, summary, recordId;
  if (share.mode === 'snapshot') {
    title = share.snapshot_title; content = share.snapshot_body;
    category = ''; tags = ''; summary = '';
    recordId = tdb.prepare('SELECT record_id FROM notes WHERE id=?').get(share.note_id)?.record_id || null;
  } else {
    const note = tdb.prepare('SELECT * FROM notes WHERE id=?').get(share.note_id);
    if (!note) return res.status(404).json({ error: '笔记已被删除' });
    ({ title, content, category, tags, summary, record_id: recordId } = note);
  }
  tdb.prepare("UPDATE note_shares SET views=views+1, last_view_at=datetime('now','localtime') WHERE id=?").run(share.id);
  res.json({
    title, content, category, tags, summary,
    mode: share.mode,
    has_audio: !!(share.with_audio && recordId),
    views: Number(share.views) + 1,
  });
});

// ---------- 免登录：分享附带的录音（Range 流式，照 vibeRoutes 的 /vibe/audio/:id） ----------
router.get('/share/n/:token/audio', (req, res) => {
  const a = authorize(req);
  if (a.err) return res.status(a.err[0]).json({ error: a.err[1] });
  const { share, tdb } = a;
  if (!share.with_audio) return res.status(404).json({ error: '该分享未包含音频' });
  const note = tdb.prepare('SELECT record_id FROM notes WHERE id=?').get(share.note_id);
  if (!note || !note.record_id) return res.status(404).json({ error: '录音不存在' });
  const rec = db.prepare('SELECT * FROM vibe_records WHERE id=?').get(note.record_id);
  if (!rec || !rec.file_path || !fs.existsSync(rec.file_path)) return res.status(404).json({ error: '录音文件不存在' });
  let st; try { st = fs.statSync(rec.file_path); } catch { return res.status(404).json({ error: '录音文件不可读' }); }
  res.setHeader('Content-Type', rec.file_mime && rec.file_mime !== 'application/octet-stream' ? rec.file_mime : 'audio/webm');
  res.setHeader('Accept-Ranges', 'bytes');
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range));
    let start = 0, end = st.size - 1;
    if (m && m[1]) { start = parseInt(m[1], 10); if (m[2]) end = Math.min(parseInt(m[2], 10), st.size - 1); }
    else if (m && m[2]) start = Math.max(0, st.size - parseInt(m[2], 10));
    if (!m || start >= st.size || start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${st.size}`);
      return res.end();
    }
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(rec.file_path, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', st.size);
    fs.createReadStream(rec.file_path).pipe(res);
  }
});

// ---------- 免登录：外部系统/AI 推入一条笔记（只写） ----------
router.post('/note-intake/:token', (req, res) => {
  const token = String(req.params.token || '');
  if (!token || token.length < 16) return res.status(403).json({ error: '令牌无效' });
  const found = findAcrossTenants((tdb) => {
    // v1.9.41：写入令牌从「分类」改挂「文件夹」（note_categories 已退役成死表）
    const c = tdb.prepare("SELECT * FROM note_folders WHERE intake_token=? AND intake_token<>''").get(token);
    return c ? { cat: { ...c, id: Number(c.id) }, tdb } : null;
  });
  if (!found) return res.status(403).json({ error: '令牌无效' });
  const b = req.body || {};
  const title = String(b.title ?? '').slice(0, 60);
  const summary = String(b.summary ?? '').slice(0, 500);
  let content = String(b.content ?? '');
  const time = String(b.time ?? b.timestamp ?? '').slice(0, 40);
  if (!content.trim() && !summary.trim() && !title.trim()) return res.status(400).json({ error: '内容为空' });
  content = content.slice(0, 200000);
  if (time) content = `${content}\n\n> 来源时间：${time}`;
  const noteService = require('../services/noteService');
  const id = noteService.createNote(found.tdb, {
    title: title || extractFrom(summary, content),
    content, folder_id: found.cat.id, summary,
  });
  res.json({ ok: true, id, category: found.cat.name });
});
function extractFrom(summary, content) {
  return String(summary || content || '').replace(/\s+/g, ' ').trim().slice(0, 20);
}

// ---------- 登录态：分享管理（/notes 前缀 → 继承「笔记」页权限） ----------
router.get('/notes/shares/note/:id', (req, res) => {
  const rows = req.tdb.prepare('SELECT * FROM note_shares WHERE note_id=? ORDER BY id DESC').all(req.params.id);
  res.json({
    link_count: rows.length,
    view_total: rows.reduce((s, r) => s + (r.views || 0), 0),
    items: rows,
  });
});

router.post('/notes/shares/note/:id', (req, res) => {
  const note = req.tdb.prepare('SELECT * FROM notes WHERE id=?').get(req.params.id);
  if (!note) return res.status(404).json({ error: '笔记不存在' });
  const b = req.body || {};
  const mode = b.mode === 'snapshot' ? 'snapshot' : 'live';
  const days = [7, 30].includes(Number(b.expires_days)) ? Number(b.expires_days) : 0; // 0 = 不限
  const withAudio = b.with_audio ? 1 : 0;
  const token = crypto.randomBytes(18).toString('base64url'); // 24 字符，不可猜
  const code = randomCode();
  const r = req.tdb.prepare(
    `INSERT INTO note_shares(note_id,token,code,mode,snapshot_title,snapshot_body,with_audio,expires_at)
     VALUES(?,?,?,?,?,?,?,${days ? `datetime('now','localtime','+${days} days')` : 'NULL'})`
  ).run(
    note.id, token, code, mode,
    mode === 'snapshot' ? note.title : '', mode === 'snapshot' ? note.content : '', withAudio
  );
  const row = req.tdb.prepare('SELECT * FROM note_shares WHERE id=?').get(r.lastInsertRowid);
  res.json({ id: Number(r.lastInsertRowid), token, code, mode, with_audio: withAudio, expires_at: row.expires_at });
});

router.put('/notes/shares/:sid', (req, res) => {
  const cur = req.tdb.prepare('SELECT * FROM note_shares WHERE id=?').get(req.params.sid);
  if (!cur) return res.status(404).json({ error: '分享不存在' });
  const b = req.body || {};
  const disabled = b.disabled !== undefined ? (b.disabled ? 1 : 0) : cur.disabled;
  const withAudio = b.with_audio !== undefined ? (b.with_audio ? 1 : 0) : cur.with_audio;
  let expiresAt = cur.expires_at;
  if (b.expires_days !== undefined) {
    const days = [7, 30].includes(Number(b.expires_days)) ? Number(b.expires_days) : 0;
    expiresAt = days
      ? req.tdb.prepare(`SELECT datetime('now','localtime','+${days} days') AS e`).get().e
      : null;
  }
  req.tdb.prepare('UPDATE note_shares SET disabled=?, expires_at=?, with_audio=? WHERE id=?')
    .run(disabled, expiresAt, withAudio, cur.id);
  res.json({ ok: true, disabled, expires_at: expiresAt, with_audio: withAudio });
});

router.delete('/notes/shares/:sid', (req, res) => {
  req.tdb.prepare('DELETE FROM note_shares WHERE id=?').run(req.params.sid);
  res.json({ ok: true });
});

module.exports = router;
