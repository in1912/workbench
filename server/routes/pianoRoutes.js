// 练琴：浏览器录音上传（保存到全局默认上传路径）+ 明细列表 + 统计 + 音频流播放 + 有效时长确认。
// 权限：录音/列表/统计/播放随学习页（piano tab，数据全家共享只读+本人录音）；
//       有效时长确认 PATCH /piano/confirm/:id 是受限端点（pianoconfirm，家长/有权限成员显式授权）。
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { db, dataDir } = require('../db');
const storagePaths = require('../services/storagePaths');
const router = express.Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
const userLabel = (u) => (u && (u.display_name || u.nickname || u.username)) || `用户#${u && u.id}`;
const monthStr = () => new Date().toLocaleDateString('sv').slice(0, 7);

// 录音落盘：优先全局默认上传保存路径 {root}/piano-recordings；未配置时回落 data/piano-recordings
function saveRecording(file) {
  const safe = String(file.originalname || 'recording.webm').replace(/[\\/:*?"<>|\r\n\t]+/g, '_').slice(-80) || 'recording.webm';
  const name = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${safe}`;
  const dir = storagePaths.uploadSubDir('piano-recordings') || (() => {
    const p = path.join(dataDir, 'piano-recordings');
    fs.mkdirSync(p, { recursive: true });
    return p;
  })();
  const full = path.join(dir, name);
  fs.writeFileSync(full, file.buffer);
  return full;
}

// ---------- 上传一条录音/录像（multipart：media 字段（旧版 audio 也兼容）+ 文本字段） ----------
// 录像额外带 kind=video + thumb（base64 JPEG 缩略图，客户端开录后抓一帧生成）
router.post('/piano/upload', upload.any(), (req, res) => {
  const file = (req.files || []).find((f) => f.buffer && f.buffer.length);
  if (!file) return res.status(400).json({ error: '缺少录音/录像文件' });
  const dur = Math.max(0, Math.min(Number(req.body.duration_sec) || 0, 6 * 3600));
  if (dur < 1) return res.status(400).json({ error: '录制时长无效' });
  const mime = String(file.mimetype || '');
  const kind = mime.startsWith('video/') || String(req.body.kind || '').trim() === 'video' ? 'video' : 'audio';
  let thumb = '';
  if (kind === 'video') {
    const t = String(req.body.thumb || '');
    if (/^data:image\/(jpeg|png);base64,/.test(t) && t.length <= 300000) thumb = t; // 小图（~5KB），超限丢弃不报错
  }
  let full = '';
  try { full = saveRecording(file); }
  catch (e) { return res.status(500).json({ error: '录制文件保存失败：' + e.message }); }
  const u = db.prepare('SELECT display_name, nickname, username FROM users WHERE id=?').get(req.user.id);
  const info = db.prepare(`INSERT INTO piano_records(user_id, user_name, duration_sec, started_at, ended_at, file_path, file_mime, kind, thumb, file_size)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, userLabel(u), dur,
      String(req.body.started_at || '').slice(0, 19) || new Date().toLocaleString('sv').slice(0, 19),
      String(req.body.ended_at || '').slice(0, 19) || new Date().toLocaleString('sv').slice(0, 19),
      full, mime || (kind === 'video' ? 'video/webm' : 'audio/webm'), kind, thumb, file.buffer.length);
  res.json({ ok: true, id: Number(info.lastInsertRowid), file_path: full, kind, file_size: file.buffer.length });
});

// ---------- 明细列表（全家共享，分页；可按成员过滤） ----------
router.get('/piano/records', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.max(5, Math.min(100, parseInt(req.query.pageSize, 10) || 15));
  const uid = Number(req.query.user_id) || 0;
  const where = uid > 0 ? 'WHERE user_id = ?' : '';
  const bind = uid > 0 ? [uid] : [];
  const total = db.prepare(`SELECT COUNT(*) c FROM piano_records ${where}`).get(...bind).c;
  const rows = db.prepare(`SELECT * FROM piano_records ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...bind, pageSize, (page - 1) * pageSize);
  // 老数据没有 file_size：文件还在就从磁盘补一个真实值（只读，不回写库）
  for (const r of rows) {
    if (!r.file_size && r.file_path && !r.file_deleted) {
      try { r.file_size = fs.statSync(r.file_path).size; } catch { r.file_size = 0; }
    }
  }
  const users = db.prepare('SELECT id, display_name, nickname, username FROM users WHERE is_bot=0 ORDER BY id').all()
    .map((u) => ({ id: u.id, name: userLabel(u) }));
  res.json({ total, page, pageSize, rows, users });
});

// ---------- 统计看板（默认当前用户；?user_id= 指定成员） ----------
router.get('/piano/stats', (req, res) => {
  const uid = Number(req.query.user_id) || req.user.id;
  const t = db.prepare(`SELECT
      COALESCE(SUM(duration_sec),0) total_sec,
      COALESCE(SUM(CASE WHEN strftime('%Y-%m', COALESCE(NULLIF(started_at,''), created_at))=? THEN duration_sec ELSE 0 END),0) month_sec,
      COALESCE(SUM(CASE WHEN confirmed=1 THEN valid_sec ELSE 0 END),0) valid_sec
    FROM piano_records WHERE user_id=?`).get(monthStr(), uid);
  res.json({ user_id: uid, total_sec: t.total_sec, month_sec: t.month_sec, valid_sec: t.valid_sec });
});

// ---------- 录音/录像播放（流式；?token= 供 <audio>/<video> 无 Authorization 头场景；支持 Range 拖动） ----------
router.get('/piano/file/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM piano_records WHERE id=?').get(Number(req.params.id) || 0);
  if (!row || row.file_deleted || !row.file_path || !fs.existsSync(row.file_path))
    return res.status(404).json({ error: '文件不存在（可能已被清理或迁移）' });
  let st; try { st = fs.statSync(row.file_path); } catch { return res.status(404).json({ error: '录音文件不可读' }); }
  res.setHeader('Content-Type', row.file_mime || 'audio/webm');
  res.setHeader('Accept-Ranges', 'bytes');
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range));
    let start = 0, end = st.size - 1;
    if (m && m[1]) start = parseInt(m[1], 10);
    if (m && m[2]) end = Math.min(parseInt(m[2], 10), st.size - 1);
    if (start >= st.size) return res.status(416).setHeader('Content-Range', `bytes */${st.size}`).end();
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(row.file_path, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', st.size);
    fs.createReadStream(row.file_path).pipe(res);
  }
});

// ---------- 有效时长确认（受限：pianoconfirm） ----------
// body: { valid_sec } —— 默认为录音时长（前端弹窗预填），可修改后保存；重复确认 = 更新数值
router.patch('/piano/confirm/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM piano_records WHERE id=?').get(Number(req.params.id) || 0);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  const valid = Math.max(0, Math.min(Number(req.body.valid_sec) || row.duration_sec, row.duration_sec));
  const me = db.prepare('SELECT display_name, nickname, username FROM users WHERE id=?').get(req.user.id);
  db.prepare(`UPDATE piano_records SET valid_sec=?, confirmed=1, confirmed_by=?, confirmed_by_name=?,
    confirmed_at=datetime('now','localtime') WHERE id=?`)
    .run(valid, req.user.id, userLabel(me), row.id);
  res.json({ ok: true });
});

// 取消确认（误操作回退；同样受限）
router.patch('/piano/unconfirm/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM piano_records WHERE id=?').get(Number(req.params.id) || 0);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  db.prepare(`UPDATE piano_records SET confirmed=0, confirmed_by=NULL, confirmed_by_name=NULL, confirmed_at=NULL, valid_sec=0 WHERE id=?`)
    .run(row.id);
  res.json({ ok: true });
});

// 补录视频缩略图（admin 或本人）：老录像没抓到帧的，客户端从视频文件抽一帧回填（v1.2.10）
router.patch('/piano/thumb/:id', (req, res) => {
  const row = db.prepare('SELECT id, user_id FROM piano_records WHERE id=?').get(Number(req.params.id) || 0);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id)
    return res.status(403).json({ error: '仅管理员或本人可补缩略图' });
  const t = String(req.body.thumb || '');
  if (!/^data:image\/(jpeg|png);base64,/.test(t) || t.length > 300000)
    return res.status(400).json({ error: '缩略图格式不符（须为 base64 JPEG/PNG 小图）' });
  db.prepare('UPDATE piano_records SET thumb=? WHERE id=?').run(t, row.id);
  res.json({ ok: true });
});

// 清理原文件（admin 或本人）：删磁盘上的音/视频文件释放存储，保留练习记录与有效时长
router.delete('/piano/file/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM piano_records WHERE id=?').get(Number(req.params.id) || 0);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id)
    return res.status(403).json({ error: '仅管理员或本人可清理原文件' });
  if (row.file_deleted) return res.json({ ok: true, already: true });
  try { if (row.file_path) fs.unlinkSync(row.file_path); } catch { /* 文件已不在则忽略 */ }
  db.prepare('UPDATE piano_records SET file_deleted=1 WHERE id=?').run(row.id);
  res.json({ ok: true });
});

// 删除录音（admin 或本人；同时尽力删除磁盘文件）
router.delete('/piano/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM piano_records WHERE id=?').get(Number(req.params.id) || 0);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id)
    return res.status(403).json({ error: '仅管理员或本人可删除' });
  db.prepare('DELETE FROM piano_records WHERE id=?').run(row.id);
  try { if (row.file_path) fs.unlinkSync(row.file_path); } catch { /* 文件已不在则忽略 */ }
  res.json({ ok: true });
});

module.exports = router;
