// 敏感词检测 + 词库管理 + 法规库
const express = require('express');
const { db } = require('../db');

const router = express.Router();

const PLATFORMS = {
  common: '公共平台', douyin: '抖音', xiaohongshu: '小红书', kuaishou: '快手', weixin: '微信公众号',
};
const SEVERITY_ORDER = { '高': 0, '中': 1, '低': 2 };

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '需要管理员权限' });
  next();
}

// ---- 扫描 ----
// 词库缓存：表内容变化时失效
let wordCache = null;
function loadWords() {
  if (wordCache) return wordCache;
  const rows = db.prepare('SELECT word,platform,category,severity,description,suggestion FROM sensitive_words').all();
  // 长词优先（先匹配长词，避免"加微信"被"微信"抢占计数——各自独立统计，无抢占问题，但长词优先排序更稳）
  rows.sort((a, b) => b.word.length - a.word.length);
  wordCache = rows;
  return wordCache;
}
function invalidateWords() { wordCache = null; }

router.post('/scan', (req, res) => {
  const text = String((req.body || {}).text || '');
  if (!text.trim()) return res.status(400).json({ error: '请粘贴需要检测的文案' });
  if (text.length > 100000) return res.status(400).json({ error: '文案过长（上限 10 万字符）' });
  let platforms = Array.isArray((req.body || {}).platforms) ? (req.body.platforms || []) : [];
  platforms = [...new Set(platforms.filter(p => PLATFORMS[p]))];
  if (!platforms.length) platforms = ['common'];

  const words = loadWords().filter(w => platforms.includes(w.platform));
  const hits = [];
  const marks = []; // 每处命中的原文位置（历史页对照高亮用）：{s 起始, e 结束, w 词, v 严重度}
  for (const w of words) {
    let idx = text.indexOf(w.word);
    if (idx === -1) continue;
    let count = 0;
    const samples = [];
    while (idx !== -1 && count < 200) {
      count++;
      if (marks.length < 3000) marks.push({ s: idx, e: idx + w.word.length, w: w.word, v: w.severity });
      if (samples.length < 5) {
        samples.push(text.slice(Math.max(0, idx - 12), idx) + '【' + w.word + '】' + text.slice(idx + w.word.length, idx + w.word.length + 12));
      }
      idx = text.indexOf(w.word, idx + w.word.length);
    }
    hits.push({
      word: w.word, platform: w.platform, platform_label: PLATFORMS[w.platform],
      category: w.category, severity: w.severity, description: w.description,
      suggestion: w.suggestion, count, samples,
    });
  }
  hits.sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) || b.count - a.count);

  const stats = { total: hits.reduce((s, h) => s + h.count, 0), high: 0, med: 0, low: 0, words: hits.length };
  for (const h of hits) {
    if (h.severity === '高') stats.high += h.count;
    else if (h.severity === '中') stats.med += h.count;
    else stats.low += h.count;
  }

  const r = db.prepare(`INSERT INTO scan_records(user_id,text_len,platforms,total_hits,high_hits,med_hits,low_hits,original_text,detail)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(req.user.id, text.length, platforms.join(','), stats.total, stats.high, stats.med, stats.low,
    text, JSON.stringify({ hits: hits.slice(0, 100), marks }));

  res.json({ hits, marks, stats, text_len: text.length, scan_id: Number(r.lastInsertRowid), risk_level: stats.high > 0 ? '高' : (stats.med > 0 ? '中' : '低') });
});

// ---- 扫描历史 ----
router.get('/scans', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(50, Math.max(5, Number(req.query.size) || 15));
  const total = db.prepare('SELECT COUNT(*) c FROM scan_records WHERE user_id=?').get(req.user.id).c;
  const rows = db.prepare(`SELECT id,text_len,platforms,total_hits,high_hits,med_hits,low_hits,created_at
    FROM scan_records WHERE user_id=? ORDER BY id DESC LIMIT ? OFFSET ?`).all(req.user.id, size, (page - 1) * size);
  res.json({ total, page, size, rows });
});

router.get('/scans/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM scan_records WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  // detail 归一：旧版存 hits 数组，新版存 {hits, marks}
  let d = null;
  try { d = JSON.parse(row.detail); } catch { /* 保留 null */ }
  if (Array.isArray(d)) row.detail = { hits: d, marks: [] };
  else if (d && typeof d === 'object') row.detail = { hits: d.hits || [], marks: d.marks || [] };
  else row.detail = { hits: [], marks: [] };
  res.json({ record: row });
});

router.delete('/scans/:id', (req, res) => {
  const r = db.prepare('DELETE FROM scan_records WHERE id=? AND user_id=?').run(Number(req.params.id), req.user.id);
  if (!r.changes) return res.status(404).json({ error: '记录不存在' });
  res.json({ ok: true });
});

// ---- 词库 ----
router.get('/words', (req, res) => {
  const platform = String(req.query.platform || '').trim();
  const category = String(req.query.category || '').trim();
  const kw = String(req.query.kw || '').trim();
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(100, Math.max(10, Number(req.query.size) || 20));

  let where = 'WHERE 1=1';
  const args = [];
  if (platform && PLATFORMS[platform]) { where += ' AND platform=?'; args.push(platform); }
  if (category) { where += ' AND category=?'; args.push(category); }
  if (kw) { where += ' AND (word LIKE ? OR description LIKE ?)'; args.push(`%${kw}%`, `%${kw}%`); }

  const total = db.prepare(`SELECT COUNT(*) c FROM sensitive_words ${where}`).get(...args).c;
  const rows = db.prepare(`SELECT * FROM sensitive_words ${where} ORDER BY CASE severity WHEN '高' THEN 0 WHEN '中' THEN 1 ELSE 2 END, id DESC LIMIT ? OFFSET ?`)
    .all(...args, size, (page - 1) * size);
  const cats = db.prepare(`SELECT platform, category, COUNT(*) c FROM sensitive_words ${where} GROUP BY platform, category`).all(...args);
  res.json({ total, page, size, rows, cats, platforms: PLATFORMS });
});

// 新增（支持批量：每行一个词，格式 "词" 或 "词|分类|严重度"）
router.post('/words', adminOnly, (req, res) => {
  const b = req.body || {};
  const platform = PLATFORMS[b.platform] ? b.platform : 'common';
  const category = String(b.category || '未分类').trim().slice(0, 30) || '未分类';
  const severity = ['高', '中', '低'].includes(b.severity) ? b.severity : '中';
  const description = String(b.description || '').slice(0, 300);
  const suggestion = String(b.suggestion || '').slice(0, 300);

  const raw = String(b.word || '').trim();
  if (!raw) return res.status(400).json({ error: '请输入敏感词' });
  const lines = raw.split(/\r?\n/).map(x => x.trim()).filter(Boolean).slice(0, 200);

  const ins = db.prepare('INSERT INTO sensitive_words(word,platform,category,severity,description,suggestion,created_by) VALUES(?,?,?,?,?,?,?)');
  const exists = db.prepare('SELECT id FROM sensitive_words WHERE word=? AND platform=?');
  db.exec('BEGIN');
  let added = 0, skipped = 0;
  try {
    for (const line of lines) {
      const parts = line.split('|').map(x => x.trim());
      const word = parts[0].slice(0, 50);
      const cat = parts[1] ? parts[1].slice(0, 30) : category;
      const sev = ['高', '中', '低'].includes(parts[2]) ? parts[2] : severity;
      if (!word) continue;
      if (exists.get(word, platform)) { skipped++; continue; }
      ins.run(word, platform, cat, sev, description, suggestion, req.user.id);
      added++;
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  invalidateWords();
  res.json({ ok: true, added, skipped });
});

router.put('/words/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM sensitive_words WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: '词条不存在' });
  const b = req.body || {};
  db.prepare('UPDATE sensitive_words SET word=?,platform=?,category=?,severity=?,description=?,suggestion=? WHERE id=?').run(
    String(b.word || row.word).trim().slice(0, 50) || row.word,
    PLATFORMS[b.platform] ? b.platform : row.platform,
    String(b.category ?? row.category).slice(0, 30),
    ['高', '中', '低'].includes(b.severity) ? b.severity : row.severity,
    String(b.description ?? row.description).slice(0, 300),
    String(b.suggestion ?? row.suggestion).slice(0, 300),
    id,
  );
  invalidateWords();
  res.json({ word: db.prepare('SELECT * FROM sensitive_words WHERE id=?').get(id) });
});

router.delete('/words/:id', adminOnly, (req, res) => {
  const r = db.prepare('DELETE FROM sensitive_words WHERE id=?').run(Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: '词条不存在' });
  invalidateWords();
  res.json({ ok: true });
});

// ---- 法规库 ----
router.get('/regs', (req, res) => {
  const kw = String(req.query.kw || '').trim();
  const category = String(req.query.category || '').trim();
  let where = 'WHERE 1=1';
  const args = [];
  if (category) { where += ' AND category=?'; args.push(category); }
  if (kw) { where += ' AND (title LIKE ? OR summary LIKE ? OR key_points LIKE ?)'; args.push(`%${kw}%`, `%${kw}%`, `%${kw}%`); }
  const rows = db.prepare(`SELECT * FROM regs ${where} ORDER BY CASE category WHEN '法律' THEN 0 WHEN '行政法规' THEN 1 WHEN '部门规章' THEN 2 WHEN '规范性文件' THEN 3 ELSE 4 END, effective_date DESC`).all(...args);
  res.json({ regs: rows, categories: ['法律', '行政法规', '部门规章', '规范性文件', '行业规范'] });
});

router.get('/regs/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM regs WHERE id=?').get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: '法规不存在' });
  try { row.key_points = JSON.parse(row.key_points); } catch { /* 保留 */ }
  res.json({ reg: row });
});

router.post('/regs', adminOnly, (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: '请输入法规名称' });
  const kp = Array.isArray(b.key_points) ? b.key_points.map(x => String(x).slice(0, 300)) : [];
  const r = db.prepare(`INSERT INTO regs(title,category,issuer,doc_no,publish_date,effective_date,summary,key_points,url,note) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(title.slice(0, 200), String(b.category || '法律').slice(0, 30), String(b.issuer || '').slice(0, 200),
      String(b.doc_no || '').slice(0, 200), String(b.publish_date || '').slice(0, 50), String(b.effective_date || '').slice(0, 50),
      String(b.summary || '').slice(0, 1000), JSON.stringify(kp), String(b.url || '').slice(0, 500), String(b.note || '').slice(0, 500));
  res.json({ reg: db.prepare('SELECT * FROM regs WHERE id=?').get(r.lastInsertRowid) });
});

router.put('/regs/:id', adminOnly, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM regs WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: '法规不存在' });
  const b = req.body || {};
  const kp = Array.isArray(b.key_points) ? b.key_points.map(x => String(x).slice(0, 300))
    : (typeof b.key_points === 'string' ? b.key_points.split(/\r?\n/).map(x => x.trim()).filter(Boolean).slice(0, 20) : JSON.parse(row.key_points));
  db.prepare(`UPDATE regs SET title=?,category=?,issuer=?,doc_no=?,publish_date=?,effective_date=?,summary=?,key_points=?,url=?,note=?,updated_at=datetime('now','localtime') WHERE id=?`)
    .run(String(b.title || row.title).slice(0, 200), String(b.category || row.category).slice(0, 30),
      String(b.issuer ?? row.issuer).slice(0, 200), String(b.doc_no ?? row.doc_no).slice(0, 200),
      String(b.publish_date ?? row.publish_date).slice(0, 50), String(b.effective_date ?? row.effective_date).slice(0, 50),
      String(b.summary ?? row.summary).slice(0, 1000), JSON.stringify(kp),
      String(b.url ?? row.url).slice(0, 500), String(b.note ?? row.note).slice(0, 500), id);
  res.json({ reg: db.prepare('SELECT * FROM regs WHERE id=?').get(id) });
});

router.delete('/regs/:id', adminOnly, (req, res) => {
  const r = db.prepare('DELETE FROM regs WHERE id=?').run(Number(req.params.id));
  if (!r.changes) return res.status(404).json({ error: '法规不存在' });
  res.json({ ok: true });
});

module.exports = router;
