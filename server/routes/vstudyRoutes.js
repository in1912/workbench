// 视频教学：NAS 学习目录浏览（目录树 + 流媒体 Range 播放 + 文档在线预览）+ 学习记录 + 设置。
// 权限：目录/文件/进度/记录为页内共享端点（数据按人隔离）；设置写操作（/vstudy/settings/*）归「视频教学设置」tab。
// 路径安全：所有文件访问都被关在配置的 NAS 根目录内（resolve 后必须仍以根目录开头，防 ../ 逃逸）。
const express = require('express');
const fs = require('fs');
const path = require('path');
const { db, getSetting, setSetting } = require('../db');
const router = express.Router();

// ---------- 扩展名分类（前端面板同名常量保持一致） ----------
const MEDIA_EXTS = ['mp4', 'flv', 'mp3', 'webm', 'm4v', 'm4a', 'wav', 'aac', 'ogg'];
const DOC_EXTS = ['pdf', 'doc', 'docx', 'txt', 'md', 'jpg', 'jpeg', 'png', 'gif', 'bmp', 'xls', 'xlsx', 'csv'];
const MIME = {
  mp4: 'video/mp4', flv: 'video/x-flv', webm: 'video/webm', m4v: 'video/mp4',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac', ogg: 'audio/ogg',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  gif: 'image/gif', bmp: 'image/bmp', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const DEFAULT_YEARS = ['2025-2026 学年', '2026-2027 学年'];
const DEFAULT_SUBJECTS = ['语文', '数学', '英语', '物理', '化学', '生物', '历史', '地理', '政治'];

function rootDir() { return String(getSetting(db, 'vstudy_root', '') || '').trim(); }

// 把前端传来的相对路径安全拼进根目录；越界/根未配置返回 null
function resolveInRoot(rel) {
  const root = rootDir();
  if (!root) return null;
  const full = path.resolve(root, '.' + path.sep + String(rel || '').replace(/\\/g, '/').replace(/^\/+/, ''));
  const normRoot = path.resolve(root) + path.sep;
  if (full !== path.resolve(root) && !full.startsWith(normRoot)) return null;
  return full;
}

// ---------- 设置（全局配置，主库存放） ----------
router.get('/vstudy/config', (req, res) => {
  res.json({
    root: rootDir(),
    root_ok: (() => { const r = rootDir(); return !!r && fs.existsSync(r); })(),
    years: getSetting(db, 'vstudy_years', null) || DEFAULT_YEARS,
    subjects: getSetting(db, 'vstudy_subjects', null) || DEFAULT_SUBJECTS,
  });
});

// 保存设置：{ root?, years?, subjects?}；root 变更时校验目录存在可读
router.post('/vstudy/settings', (req, res) => {
  const b = req.body || {};
  if (b.root !== undefined) {
    const r = String(b.root || '').trim();
    if (r && !fs.existsSync(r)) return res.status(400).json({ error: `目录不存在或不可访问：${r}。Docker/NAS 部署时这里填「容器内路径」——NAS 上的目录需先在 Docker 里映射进容器（例如宿主机 /vol2/1000/媛媛学习 映射为 /study，然后这里填 /study）；\\\\NAS\\share 之类的网络路径在容器内无法访问。Windows 直跑则填本机目录（如 D:\\学习资料）` });
    setSetting(db, 'vstudy_root', r);
  }
  if (Array.isArray(b.years)) setSetting(db, 'vstudy_years', b.years.map((s) => String(s).trim()).filter(Boolean));
  if (Array.isArray(b.subjects)) setSetting(db, 'vstudy_subjects', b.subjects.map((s) => String(s).trim()).filter(Boolean));
  res.json({ ok: true });
});

// ---------- 路径探针（管理员）：Docker 部署时帮用户找到容器内真实可见的映射路径 ----------
// 只返回存在性与一层目录结构，不读任何文件内容；Windows 本机直跑同样可用（从盘符根起探）
router.get('/vstudy/fs-probe', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可探测' });
  const raw = String(req.query.path || '').trim();
  const p = raw ? path.resolve(raw) : (process.platform === 'win32' ? path.resolve('/') : '/');
  let exists = false, isDir = false, entries = [], err = '';
  try { const st = fs.statSync(p); exists = true; isDir = st.isDirectory(); } catch { err = '路径在容器内不存在'; }
  if (exists && isDir) {
    try {
      entries = fs.readdirSync(p, { withFileTypes: true })
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'zh'))
        .slice(0, 150);
    } catch (e) { err = '读取目录失败：' + e.message; }
  }
  const parent = path.dirname(p);
  res.json({ path: p, exists, is_dir: isDir, parent: parent === p ? '' : parent, entries, error: err });
});

// ---------- 目录树（懒加载一层） ----------
router.get('/vstudy/tree', (req, res) => {
  const full = resolveInRoot(req.query.dir || '');
  if (!full) return res.status(400).json({ error: rootDir() ? '路径越界' : '尚未配置学习目录，请先到「视频教学设置」填写 NAS 路径' });
  let names;
  try { names = fs.readdirSync(full); }
  catch (e) { return res.status(400).json({ error: '读取目录失败：' + e.message }); }
  const entries = [];
  for (const name of names) {
    if (name.startsWith('.') || name.startsWith('~$')) continue; // 隐藏文件与 Office 锁文件
    const p = path.join(full, name);
    let isDir = false, size = 0;
    try { const st = fs.statSync(p); isDir = st.isDirectory(); size = st.size; } catch { continue; }
    const ext = isDir ? '' : (name.split('.').pop() || '').toLowerCase();
    entries.push({ name, is_dir: isDir, ext, size, kind: isDir ? 'dir' : MEDIA_EXTS.includes(ext) ? 'media' : DOC_EXTS.includes(ext) ? 'doc' : 'other' });
  }
  entries.sort((a, b) => (b.is_dir - a.is_dir) || a.name.localeCompare(b.name, 'zh'));
  res.json({ dir: String(req.query.dir || ''), entries });
});

// ---------- 外部播放器联动注册脚本（potplayer:// vlc:// 协议，写 HKCU 免管理员） ----------
// 页面「PotPlayer / VLC 播放」按钮首次使用前下载双击：自动探测已装播放器并注册协议，
// 之后点按钮浏览器即调起本地播放器直接播服务器直链（?token= 鉴权 + Range 均已支持）。
router.get('/vstudy/extplayer', (req, res) => {
  const p = path.join(__dirname, '..', 'vstudy-extplayer.cmd');
  if (!fs.existsSync(p)) return res.status(404).json({ error: '脚本缺失' });
  res.download(p, 'register-external-player.cmd');
});

// ---------- 文件流（视频拖动条/FLV 依赖 HTTP Range，必须实现 206 分段） ----------
// 本地直连：页面源（公网域名）与文件源（局域网地址）不同源——媒体元素加载不受限，
// 但 flv.js（fetch+Range）与文档解析（fetch+Authorization）跨源读取需要 CORS 放行。
// 鉴权仍在 ?token=，无 token 的跨源请求拿不到内容，放行 * 无泄露面。
router.options('/vstudy/file', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Range, Content-Type');
  res.status(204).end();
});
router.get('/vstudy/file', (req, res) => {
  const full = resolveInRoot(req.query.path || '');
  if (!full) return res.status(400).json({ error: '路径越界或未配置根目录' });
  let st;
  try { st = fs.statSync(full); } catch { return res.status(404).json({ error: '文件不存在' }); }
  if (st.isDirectory()) return res.status(400).json({ error: '这是一个目录' });
  const ext = (full.split('.').pop() || '').toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const name = path.basename(full);
  res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`);

  const range = req.headers.range;
  // 边下边播关键点：① 206 分段 ② 后缀区间 bytes=-N 必须取文件末尾 N 字节——
  // MP4 的 moov 元数据常在文件尾（手机/录屏导出），Safari 靠后缀区间读它；
  // 语义实现错（从头返回）会让浏览器退化为整文件下载完再播。
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range));
    let start = 0, end = st.size - 1;
    if (m) {
      if (m[1] === '' && m[2] !== '') {
        const n = parseInt(m[2], 10);
        if (!n || n <= 0) return res.status(416).setHeader('Content-Range', `bytes */${st.size}`).end();
        start = Math.max(0, st.size - n);
      } else {
        start = m[1] ? parseInt(m[1], 10) : 0;
        end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      }
    }
    if (start >= st.size) return res.status(416).setHeader('Content-Range', `bytes */${st.size}`).end();
    end = Math.min(end, st.size - 1);
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
    res.setHeader('Content-Length', end - start + 1);
    if (res.socket) res.socket.setNoDelay(true); // 小分段（moov 探测）立即发出
    fs.createReadStream(full, { start, end, highWaterMark: 1024 * 1024 }).pipe(res);
  } else {
    res.setHeader('Content-Length', st.size);
    if (res.socket) res.socket.setNoDelay(true);
    fs.createReadStream(full, { highWaterMark: 1024 * 1024 }).pipe(res);
  }
});

// ---------- 学时流水结算（vstudy_ledger） ----------
// 会话三列跟踪：watched_sec=累计观看；ledger_sec=已写入流水的生效秒数；penalty_sec=已扣减秒数。
// 中途结转：未入账 = watched_sec - ledger_sec ≥ 300s 时落一笔生效流水（长视频中途退出不丢账）；
// 关闭会话时全额结转。任意时刻 Σ(流水 delta) = ledger_sec - penalty_sec，最终收敛到 watched_sec - penalty_sec。
// complete=1：观看 ≥90% 视频时长即完整学习（100 分钟视频看满 90 分钟按全程计）。
function settleSessionLedger(sid, final = false) {
  if (!sid) return;
  const s = db.prepare('SELECT * FROM vstudy_sessions WHERE id=?').get(sid);
  if (!s) return;
  const unledgered = (s.watched_sec || 0) - (s.ledger_sec || 0);
  const complete = (s.duration_sec || 0) > 0 && (s.watched_sec || 0) >= (s.duration_sec || 0) * 0.9 ? 1 : 0;
  if (unledgered >= (final ? 1 : 300)) {
    db.prepare(`INSERT INTO vstudy_ledger(user_id, user_name, session_id, path, kind, school_year, subject,
      delta_sec, entry_type, reason, complete, started_at, ended_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,COALESCE(?, datetime('now','localtime')))`)
      .run(s.user_id, s.user_name, s.id, s.path, s.kind, s.school_year, s.subject,
        unledgered, 'earn', '', complete, s.started_at, s.ended_at || null);
    db.prepare('UPDATE vstudy_sessions SET ledger_sec = ledger_sec + ? WHERE id=?').run(unledgered, sid);
  }
  // 完整学习结论以最终数据为准：回写该会话全部生效流水（含此前中途结转的行）
  if (final) {
    db.prepare(`UPDATE vstudy_ledger SET complete=?, reason=CASE WHEN ?=1 THEN '完整学习（观看≥90%时长）' ELSE reason END
      WHERE session_id=? AND entry_type='earn'`).run(complete, complete, sid);
  }
}

// 注意力检测扣减：ratio=0.5（弹出 5 秒内未点击，扣已进行学时的一半）/ 1（持续未确认，扣光本会话）
router.post('/vstudy/attention', (req, res) => {
  const sid = Number((req.body || {}).session_id) || 0;
  const ratio = Number((req.body || {}).ratio) >= 1 ? 1 : 0.5;
  if (sid <= 0) return res.status(400).json({ error: '缺少 session_id' });
  const s = db.prepare('SELECT * FROM vstudy_sessions WHERE id=? AND user_id=?').get(sid, req.user.id);
  if (!s) return res.status(404).json({ error: '学习会话不存在' });
  settleSessionLedger(sid, true); // 先结转未入账秒数，保证「已进行的学时」基数准确
  const s2 = db.prepare('SELECT * FROM vstudy_sessions WHERE id=?').get(sid);
  const accrued = Math.max(0, (s2.watched_sec || 0) - (s2.penalty_sec || 0));
  const cut = Math.min(accrued, Math.round(accrued * ratio));
  if (cut > 0) {
    const reason = ratio >= 1 ? '注意力检测持续未确认，扣减本会话全部学时' : '注意力检测 5 秒内未确认，扣减一半学时';
    db.prepare(`INSERT INTO vstudy_ledger(user_id, user_name, session_id, path, kind, school_year, subject,
      delta_sec, entry_type, reason, started_at, ended_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,COALESCE(?, datetime('now','localtime')))`)
      .run(s2.user_id, s2.user_name, s2.id, s2.path, s2.kind, s2.school_year, s2.subject,
        -cut, 'penalty', reason, s2.started_at, s2.ended_at || null);
    db.prepare('UPDATE vstudy_sessions SET penalty_sec = penalty_sec + ? WHERE id=?').run(cut, sid);
  }
  res.json({ ok: true, cut_sec: cut });
});

// ---------- 学时记账：全部用户的流水账（默认当前用户，可切换；含生效/扣减四项看板） ----------
router.get('/vstudy/ledger', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.max(5, Math.min(100, parseInt(req.query.pageSize, 10) || 15));
  const uidIn = parseInt(req.query.user_id, 10);
  const uid = Number.isFinite(uidIn) && uidIn > 0 ? uidIn : req.user.id; // 0/缺省 = 当前用户
  const where = uid > 0 ? 'WHERE user_id = ?' : '';
  const bind = uid > 0 ? [uid] : [];
  const total = db.prepare(`SELECT COUNT(*) c FROM vstudy_ledger ${where}`).get(...bind).c;
  const rows = db.prepare(`
    SELECT * FROM vstudy_ledger ${where}
    ORDER BY id DESC LIMIT ? OFFSET ?
  `).all(...bind, pageSize, (page - 1) * pageSize);
  const month = new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0');
  const stat = (entry, mon) => db.prepare(`
    SELECT COALESCE(SUM(ABS(delta_sec)),0) v FROM vstudy_ledger
    ${uid > 0 ? 'WHERE user_id = ? AND' : 'WHERE'} entry_type = ?
    ${mon ? "AND strftime('%Y-%m', created_at) = ?" : ''}
  `).get(...(uid > 0 ? [uid, entry, ...(mon ? [mon] : [])] : [entry, ...(mon ? [mon] : [])])).v;
  const users = db.prepare('SELECT id, display_name, username FROM users WHERE is_bot=0 ORDER BY id').all()
    .map((u) => ({ id: u.id, name: u.display_name || u.username }));
  res.json({
    total, page, pageSize, rows, users,
    stats: {
      hist_eff: stat('earn', ''), month_eff: stat('earn', month),
      hist_bad: stat('penalty', ''), month_bad: stat('penalty', month),
    },
  });
});

// ---------- 学习进度上报（前端周期性小增量上报；upsert 一人一文件一行） ----------
router.post('/vstudy/progress', (req, res) => {
  const b = req.body || {};
  const p = String(b.path || '');
  if (!p) return res.status(400).json({ error: '缺少 path' });
  const kind = b.kind === 'doc' ? 'doc' : 'media';
  const dur = Math.max(0, Number(b.duration_sec) || 0);
  const pos = Math.max(0, Math.min(Number(b.position_sec) || 0, dur || 1e9));
  const delta = Math.max(0, Math.min(Number(b.watched_sec) || 0, 3600)); // 单次增量封顶 1 小时，防脏数据
  const user = db.prepare('SELECT display_name, username FROM users WHERE id=?').get(req.user.id);
  db.prepare(`
    INSERT INTO vstudy_records(user_id, user_name, path, kind, ext, school_year, subject,
      duration_sec, position_sec, watched_sec, opened_at, updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))
    ON CONFLICT(user_id, path) DO UPDATE SET
      duration_sec = MAX(vstudy_records.duration_sec, excluded.duration_sec),
      position_sec = MAX(vstudy_records.position_sec, excluded.position_sec),
      watched_sec  = vstudy_records.watched_sec + excluded.watched_sec,
      school_year  = excluded.school_year, subject = excluded.subject,
      updated_at   = datetime('now','localtime')
  `).run(req.user.id, (user && (user.display_name || user.username)) || '', p, kind,
    String(b.ext || ''), String(b.school_year || ''), String(b.subject || ''), dur, pos, delta);
  // 带 session_id：把本次增量累进学习会话；ended_at 随每次上报刷新（≈ 最后活跃/关闭时间），
  // 不能带 ended_at IS NULL 条件——首次上报就会盖章，会把后续累加全部挡掉
  const sid = Number(b.session_id) || 0;
  if (sid > 0) {
    db.prepare(`UPDATE vstudy_sessions SET watched_sec = watched_sec + ?, duration_sec = MAX(duration_sec, ?),
      ended_at = datetime('now','localtime')
      WHERE id=? AND user_id=?`).run(delta, dur, sid, req.user.id);
    settleSessionLedger(sid); // 中途结转：未入账 ≥5 分钟即落一笔生效流水
  }
  res.json({ ok: true });
});

// ---------- 学习会话（历史学习列表的数据源：每打开一个文件 = 一次会话） ----------
// 打开文件时调用：先结清该文件此前未关闭的会话（异常退出遗留），再建档返回会话 id
router.post('/vstudy/session/open', (req, res) => {
  const b = req.body || {};
  const p = String(b.path || '');
  if (!p) return res.status(400).json({ error: '缺少 path' });
  const user = db.prepare('SELECT display_name, username FROM users WHERE id=?').get(req.user.id);
  // 补结转：上次异常退出（浏览器关闭/断网）留下的未入账会话流水在此结清
  for (const st of db.prepare(`SELECT id FROM vstudy_sessions WHERE user_id=? AND watched_sec - ledger_sec >= 300 LIMIT 10`).all(req.user.id)) {
    db.prepare(`UPDATE vstudy_sessions SET ended_at = COALESCE(ended_at, datetime('now','localtime')) WHERE id=?`).run(st.id);
    settleSessionLedger(st.id, true);
  }
  db.prepare(`UPDATE vstudy_sessions SET ended_at = datetime('now','localtime')
    WHERE user_id=? AND path=? AND ended_at IS NULL`).run(req.user.id, p);
  const r = db.prepare(`INSERT INTO vstudy_sessions(user_id, user_name, path, kind, ext, school_year, subject)
    VALUES(?,?,?,?,?,?,?)`).run(req.user.id, (user && (user.display_name || user.username)) || '', p,
    b.kind === 'doc' ? 'doc' : 'media', String(b.ext || ''), String(b.school_year || ''), String(b.subject || ''));
  res.json({ id: Number(r.lastInsertRowid) });
});

// 关闭文件/离开页面时调用：盖章关闭时间（已盖章则不动；无 Authorization 头场景可走 ?token=）
router.post('/vstudy/session/close', (req, res) => {
  const sid = Number((req.body || {}).id) || 0;
  if (sid > 0) {
    db.prepare(`UPDATE vstudy_sessions SET ended_at = datetime('now','localtime')
      WHERE id=? AND user_id=? AND ended_at IS NULL`).run(sid, req.user.id);
    settleSessionLedger(sid, true); // 关闭会话：剩余观看秒数全额结转入账
  }
  res.json({ ok: true });
});

// ---------- 历史学习列表（只看本人，按开始时间倒序分页） ----------
router.get('/vstudy/sessions', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.max(5, Math.min(50, parseInt(req.query.pageSize, 10) || 10));
  const total = db.prepare('SELECT COUNT(*) c FROM vstudy_sessions WHERE user_id=?').get(req.user.id).c;
  const sessions = db.prepare(`
    SELECT * FROM vstudy_sessions WHERE user_id=?
    ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?
  `).all(req.user.id, pageSize, (page - 1) * pageSize);
  res.json({ total, page, pageSize, sessions });
});

// ---------- 学习记录列表（只看本人；分页） ----------
router.get('/vstudy/records', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.max(5, Math.min(100, parseInt(req.query.pageSize, 10) || 15));
  const total = db.prepare('SELECT COUNT(*) c FROM vstudy_records WHERE user_id=?').get(req.user.id).c;
  const records = db.prepare(`
    SELECT * FROM vstudy_records WHERE user_id=?
    ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?
  `).all(req.user.id, pageSize, (page - 1) * pageSize);
  res.json({ total, page, pageSize, records });
});

// ---------- 学时看板：按学年/学科汇总观看秒数 ----------
router.get('/vstudy/stats', (req, res) => {
  const rows = db.prepare('SELECT school_year, subject, watched_sec FROM vstudy_records WHERE user_id=?').all(req.user.id);
  const byYear = new Map(), bySubject = new Map();
  for (const r of rows) {
    const h = (r.watched_sec || 0) / 3600;
    if (r.school_year) byYear.set(r.school_year, (byYear.get(r.school_year) || 0) + h);
    if (r.subject) bySubject.set(r.subject, (bySubject.get(r.subject) || 0) + h);
  }
  const fmt = (m) => [...m.entries()].map(([name, hours]) => ({ name, hours })).sort((a, b) => b.hours - a.hours);
  res.json({ by_year: fmt(byYear), by_subject: fmt(bySubject), total_hours: rows.reduce((s, r) => s + (r.watched_sec || 0), 0) / 3600 });
});

module.exports = router;
