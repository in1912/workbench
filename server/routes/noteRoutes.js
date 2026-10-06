// 笔记知识系统（v1.9.41）—— 所有 /notes/* 的唯一所有者。
//
// v1.9.39 时笔记 CRUD 与分类管理挤在 core.js 里，与别的模块共用 router，静态段
// （/notes/categories）必须靠书写顺序躲开 /notes/:id。集中到一个 router 后，所有静态段
// 明确排在 /notes/:id 之前，Express「静态段被 /:id 吞掉」这个坑从结构上消失。
//
// ⚠️ 所有路径必须以 /notes 开头：auth.js 的 pageForPath 靠前缀判断这是「笔记」页权限，
//    写成别的前缀会静默降级成「仅需登录」。
// ⚠️ /notes/shares/* 仍在 noteShareRoutes.js（免登分享 + 分享管理），本文件不碰。
//
// 列表接口保持向后兼容：GET /notes 返回原始行（tags 是逗号串、category 是缓存列），
// 只额外补一个 folder_path；详情接口 GET /notes/:id 是饰化后的形状（props 为对象、tags 为数组）。
const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { getSetting, setSetting, tenantDbFile, tenantIdOf } = require('../db');
const storagePaths = require('../services/storagePaths');
const noteService = require('../services/noteService');
const { buildQuery } = require('../services/noteQueryService');
const { buildGraph, localGraph } = require('../services/noteGraphService');
const { stats: noteStats, localToday } = require('../services/noteStatsService');
const { validateRegex, regexScan } = require('../services/safeRegex');

const {
  extractTitle, syncNoteTags, syncNoteLinks, resolveUnresolvedFor,
  folderMap, folderSubtreeIds, createNote, deleteNote, decorateNote,
  fillTemplate, ensureDailyNote,
} = noteService;

const router = express.Router();

// ---------- 小工具 ----------
const int = (v, d = null) => { const n = Number(v); return Number.isFinite(n) ? Math.trunc(n) : d; };
const bool = (v) => ['1', 'true', 'yes', 'on', '是'].includes(String(v).toLowerCase());
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// 列表行补一个 folder_path（不改动 tags/category 的既有形状）
function withFolderPath(rows, map) {
  return rows.map((r) => {
    const f = r.folder_id == null ? null : map.byId.get(Number(r.folder_id));
    return { ...r, folder_path: f ? f.path : '' };
  });
}

function folderOr404(tdb, id) {
  const f = tdb.prepare('SELECT * FROM note_folders WHERE id=?').get(id);
  return f ? { ...f, id: Number(f.id) } : null;
}

// 同一父节点下取一个不撞名的名字（删除文件夹时上提子级用；顶层有部分唯一索引，撞名会直接报错）
function uniqueNameInParent(tdb, parentId, name) {
  const taken = (n) => (parentId == null
    ? tdb.prepare('SELECT id FROM note_folders WHERE parent_id IS NULL AND name=?').get(n)
    : tdb.prepare('SELECT id FROM note_folders WHERE parent_id=? AND name=?').get(parentId, n));
  if (!taken(name)) return name;
  for (let i = 2; i < 200; i++) { const n = `${name} ${i}`; if (!taken(n)) return n; }
  return `${name} ${Date.now()}`;
}

// 上传：笔记附件 / 白板图片各用一份 10MB 上限的 multer（**不是** upgrade 那个 100MB 的实例）
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

// multer/busboy 默认按 latin1 解 originalname，中文文件名会变成「ç¹.png」这种乱码。
// 只要能原样 UTF-8 解回来就换回去（解不回来就说明本来就不是被误解的，保持原样）。
function fixUploadName(n) {
  const raw = String(n || '');
  if (!/[\u0080-ÿ]/.test(raw)) return raw;
  const dec = Buffer.from(raw, 'latin1').toString('utf8');
  return dec.includes('�') ? raw : dec;
}

// 存一份附件：优先落磁盘（storagePaths），没配上传根目录或写盘失败则退回 base64 入库。
// 落库的兜底只对大文件设限，避免把十几 MB 的 base64 塞进 SQLite。
function storeAttachment(tdb, noteId, file) {
  const name = fixUploadName((file && file.originalname) || 'file').slice(0, 120);
  const mime = String((file && file.mimetype) || 'application/octet-stream').slice(0, 80);
  const buf = (file && file.buffer) || Buffer.alloc(0);
  if (!buf.length) return { error: '空文件' };
  const uid = tenantIdOf(tdb);
  const p = storagePaths.bestEffortSave('note-assets', name, buf, uid != null ? `t${uid}_` : '');
  let data = '';
  if (!p) {
    if (buf.length > 4 * 1024 * 1024) return { error: '未配置上传目录，无法保存大于 4MB 的附件' };
    data = buf.toString('base64');
  }
  const r = tdb.prepare(
    'INSERT INTO note_attachments(note_id,filename,mime,size,storage_path,data) VALUES(?,?,?,?,?,?)'
  ).run(noteId || null, name, mime, buf.length, p || '', data);
  return { id: Number(r.lastInsertRowid), url: `/api/notes/attachments/${r.lastInsertRowid}/raw`, filename: name, mime, size: buf.length };
}


// ============================================================
// 一、笔记列表与 CRUD
// ============================================================

// 笔记列表。?q=&category=&folder_id=&tag=&from=&to=&date_field=&bookmarked=&limit=&offset=&lean=
// lean=1 只取列表需要的列（不带正文），供新版三栏前端用；不传则保持老行为（SELECT *）。
const LEAN_COLS = 'id,title,category,folder_id,tags,summary,props,word_count,record_id,daily_date,created_at,updated_at';
router.get('/notes', (req, res) => {
  const tdb = req.tdb;
  const conds = [];
  const args = [];
  const q = String(req.query.q || '').trim();
  if (q) { conds.push('(title LIKE ? OR content LIKE ? OR tags LIKE ?)'); args.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  // ?category= 是 v1.9.39 的老契约（按 notes.category 缓存列精确匹配），原样保留
  const cat = String(req.query.category || '').trim();
  if (cat) { conds.push('category = ?'); args.push(cat); }
  // ?folder_id= 走多级文件夹：默认连子文件夹一起筛；folder_id=none 表示未归档
  const fidRaw = req.query.folder_id;
  if (fidRaw !== undefined && fidRaw !== '' && fidRaw !== null) {
    if (String(fidRaw) === 'none') {
      conds.push('folder_id IS NULL');
    } else {
      const ids = folderSubtreeIds(tdb, int(fidRaw, -1));
      if (!ids.length) return res.json([]);
      conds.push(`folder_id IN (${ids.map(() => '?').join(',')})`);
      args.push(...ids);
    }
  }
  const tag = String(req.query.tag || '').trim();
  if (tag) { conds.push('id IN (SELECT note_id FROM note_tags WHERE tag=?)'); args.push(tag); }
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const col = ({ created: 'created_at', updated: 'updated_at', daily: 'daily_date' })[String(req.query.date_field || 'updated')] || 'updated_at';
  if (from) { conds.push(`date(${col}) >= date(?)`); args.push(from); }
  if (to) { conds.push(`date(${col}) <= date(?)`); args.push(to); }
  if (bool(req.query.bookmarked)) conds.push("EXISTS (SELECT 1 FROM note_bookmarks b WHERE b.note_id=notes.id AND b.kind='note')");
  // 未转写的录音笔记（列表里要能单独过滤出来）
  if (bool(req.query.has_record)) conds.push('record_id IS NOT NULL');
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  const cols = bool(req.query.lean) ? LEAN_COLS : '*';
  const limit = Math.min(2000, Math.max(1, int(req.query.limit, 1000)));
  const offset = Math.max(0, int(req.query.offset, 0));
  const rows = tdb.prepare(`SELECT ${cols} FROM notes${where} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...args, limit, offset);
  res.json(withFolderPath(rows, folderMap(tdb)));
});

// 快速切换器的标题缓存
router.get('/notes/titles', (req, res) => {
  const q = String(req.query.q || '').trim();
  const rows = q
    ? req.tdb.prepare('SELECT id,title,folder_id,updated_at FROM notes WHERE title LIKE ? ORDER BY updated_at DESC LIMIT 2000').all(`%${q}%`)
    : req.tdb.prepare('SELECT id,title,folder_id,updated_at FROM notes ORDER BY updated_at DESC LIMIT 5000').all();
  const map = folderMap(req.tdb);
  res.json(rows.map((r) => {
    const f = r.folder_id == null ? null : map.byId.get(Number(r.folder_id));
    return { ...r, id: Number(r.id), folder_path: f ? f.path : '' };
  }));
});

// ⚠️ GET /notes/:id 故意放在文件最末尾：它是两段的通配路由，任何两段的静态路径
//   （/notes/tags、/notes/folders、/notes/stats…）只要注册在它后面就会被吞成 id="tags"。

router.post('/notes', (req, res) => {
  const b = req.body || {};
  const id = createNote(req.tdb, {
    title: b.title, content: b.content || '', category: b.category,
    folder_id: b.folder_id, tags: b.tags, props: b.props,
    summary: b.summary, record_id: b.record_id, daily_date: b.daily_date,
  });
  res.json({ id });
});

// 保存正文。顺序有讲究：先写基础字段 → 标签 → 双链 → 未解析转正。
// 数字闸门：/notes/:id 是两段路径的通配，会把后面注册的两段静态路径（如 PUT /notes/settings）吞掉。
// 放行非数字 id 交给后面的路由，是这类「静态段被 :id 吃掉」问题的结构性解法。
router.put('/notes/:id', (req, res, next) => {
  if (!/^\d+$/.test(String(req.params.id))) return next();
  const tdb = req.tdb;
  const id = int(req.params.id, -1);
  const cur = tdb.prepare('SELECT * FROM notes WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '笔记不存在' });
  const b = req.body || {};
  const content = b.content !== undefined ? String(b.content) : cur.content;
  const title = (b.title !== undefined ? String(b.title).trim().slice(0, noteService.TITLE_MAX) : '') || extractTitle(content);
  // 归属：folder_id 优先，其次老调用方传来的 category 名，都没有则保持原样
  let fid = b.folder_id !== undefined ? (b.folder_id === null ? null : int(b.folder_id, null)) : cur.folder_id;
  if (b.folder_id === undefined && b.category !== undefined) {
    const f = tdb.prepare('SELECT id FROM note_folders WHERE name=? AND parent_id IS NULL').get(String(b.category));
    if (f) fid = Number(f.id);
  }
  const fname = fid == null ? '' : (tdb.prepare('SELECT name FROM note_folders WHERE id=?').get(fid) || {}).name || '';
  const props = b.props !== undefined
    ? JSON.stringify(b.props && typeof b.props === 'object' && !Array.isArray(b.props) ? b.props : {})
    : cur.props || '{}';
  const summary = b.summary !== undefined ? String(b.summary).slice(0, 500) : cur.summary;

  // 改名留别名：[[旧标题]] 仍能解析到这篇（顺手把老的未解析链接一起转正）
  if (title !== cur.title && cur.title) {
    try { tdb.prepare('INSERT OR IGNORE INTO note_aliases(note_id,alias) VALUES(?,?)').run(id, cur.title); } catch { /* 别名撞车就算了 */ }
  }
  tdb.prepare(
    `UPDATE notes SET title=?, content=?, category=?, folder_id=?, props=?, summary=?,
       word_count=?, updated_at=datetime('now','localtime') WHERE id=?`
  ).run(title, content, fname, fid, props, summary, noteService.extractWordCount(content), id);
  syncNoteTags(tdb, id, content, b.tags); // b.tags 为 undefined → 沿用库里已有的手动标签
  syncNoteLinks(tdb, id, content);
  resolveUnresolvedFor(tdb, id, title);
  if (title !== cur.title && cur.title) resolveUnresolvedFor(tdb, id, cur.title);
  res.json({ ok: true, id, title });
});

// 只改归属：不重跑标签/双链（拖树移动是高频操作，全量重算没必要）
router.put('/notes/:id/move', (req, res) => {
  const tdb = req.tdb;
  const id = int(req.params.id, -1);
  const cur = tdb.prepare('SELECT id FROM notes WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '笔记不存在' });
  const fid = req.body && req.body.folder_id !== undefined && req.body.folder_id !== null ? int(req.body.folder_id, null) : null;
  const fname = fid == null ? '' : (tdb.prepare('SELECT name FROM note_folders WHERE id=?').get(fid) || {}).name || '';
  tdb.prepare("UPDATE notes SET folder_id=?, category=?, updated_at=datetime('now','localtime') WHERE id=?").run(fid, fname, id);
  res.json({ ok: true, folder_id: fid });
});

// 书签：笔记 / 标题 / 文件夹三种（?kind=note|heading|folder）
router.put('/notes/:id/bookmark', (req, res) => {
  const tdb = req.tdb;
  const id = int(req.params.id, -1);
  if (!tdb.prepare('SELECT id FROM notes WHERE id=?').get(id)) return res.status(404).json({ error: '笔记不存在' });
  const b = req.body || {};
  const on = b.on === undefined ? true : bool(b.on);
  const kind = ['heading', 'folder'].includes(String(b.kind)) ? String(b.kind) : 'note';
  const anchor = String(b.anchor || '').slice(0, 120);
  tdb.prepare("DELETE FROM note_bookmarks WHERE kind=? AND note_id=? AND anchor=?").run(kind, id, anchor);
  if (on) {
    tdb.prepare('INSERT INTO note_bookmarks(kind,note_id,folder_id,anchor,label) VALUES(?,?,?,?,?)')
      .run(kind, id, b.folder_id === undefined ? null : int(b.folder_id, null), anchor, String(b.label || '').slice(0, 60));
  }
  res.json({ ok: true, bookmarked: on });
});

router.delete('/notes/:id', (req, res, next) => {
  if (!/^\d+$/.test(String(req.params.id))) return next(); // 同 PUT /notes/:id：别吞掉两段静态路径
  deleteNote(req.tdb, int(req.params.id, -1)); // 级联清分享/链接/标签/别名/附件；**绝不碰 vibe_records 与音频**
  res.json({ ok: true });
});

// 双向链接（老契约，保持数组形状；新版用 /backlinks）
router.get('/notes/:id/links', (req, res) => {
  const id = int(req.params.id, -1);
  const rows = req.tdb.prepare(`
    SELECT dst_note_id AS id, 'out' AS dir FROM note_links WHERE src_note_id = ?
    UNION ALL
    SELECT src_note_id AS id, 'in'  AS dir FROM note_links WHERE dst_note_id = ?
  `).all(id, id);
  const get = req.tdb.prepare('SELECT id, title, category FROM notes WHERE id=?');
  res.json(rows.map((r) => { const n = get.get(r.id); return n ? { ...n, dir: r.dir } : null; }).filter(Boolean));
});

// 反链面板：出链 / 反链 / 未解析（写了 [[标题]] 但目标还不存在）
router.get('/notes/:id/backlinks', (req, res) => {
  const tdb = req.tdb;
  const id = int(req.params.id, -1);
  if (!tdb.prepare('SELECT id FROM notes WHERE id=?').get(id)) return res.status(404).json({ error: '笔记不存在' });
  const sel = 'SELECT n.id, n.title, n.category, n.folder_id, n.updated_at';
  const out = tdb.prepare(`${sel} FROM note_links l JOIN notes n ON n.id=l.dst_note_id WHERE l.src_note_id=? ORDER BY n.updated_at DESC`).all(id);
  const inc = tdb.prepare(`${sel} FROM note_links l JOIN notes n ON n.id=l.src_note_id WHERE l.dst_note_id=? ORDER BY n.updated_at DESC`).all(id);
  const unresolved = tdb.prepare('SELECT id, title FROM note_unresolved_links WHERE src_note_id=? ORDER BY title').all(id);
  const unresolvedIn = tdb.prepare('SELECT src_note_id AS id, title FROM note_unresolved_links WHERE title=(SELECT title FROM notes WHERE id=?)').all(id);
  res.json({ out, in: inc, unresolved, unresolved_in: unresolvedIn });
});

// 录音笔记页用：按 vibe_records.id 反查关联的笔记条目（未转写时还没建，返回 {}）
router.get('/notes/by-record/:rid', (req, res) => {
  const row = req.tdb.prepare('SELECT * FROM notes WHERE record_id=? ORDER BY id DESC LIMIT 1').get(req.params.rid);
  res.json(row || {});
});

// AI 概要 + 关键词：生成结果落库（summary/keywords/ai_at），刷新不丢
router.post('/notes/:id/ai-meta', async (req, res) => {
  try {
    const row = req.tdb.prepare('SELECT * FROM notes WHERE id=?').get(int(req.params.id, -1));
    if (!row) return res.status(404).json({ error: '笔记不存在' });
    const text = String(row.content || '').slice(0, 8000);
    if (!text.trim()) return res.status(400).json({ error: '笔记内容为空' });
    const aiService = require('../services/aiService');
    if (!aiService.hasConfig(req.tdb)) return res.status(400).json({ error: '未配置 AI 模型' });
    const summary = await aiService.summarize(text, '请用 150 字以内总结这篇笔记的核心要点，直接输出总结，不要前后缀。', req.tdb);
    let keywords = '';
    try {
      keywords = await aiService.summarize(text, '提取这篇笔记的 5 个关键词，用中文逗号分隔，只输出关键词，不要解释。', req.tdb);
      keywords = String(keywords || '').replace(/[，,、\s]+/g, ',').replace(/^,|,$/g, '').slice(0, 120);
    } catch { /* 关键词失败不影响概要 */ }
    req.tdb.prepare("UPDATE notes SET summary=?, keywords=?, ai_at=datetime('now','localtime') WHERE id=?")
      .run(String(summary || '').slice(0, 500), keywords, row.id);
    res.json({ summary: String(summary || ''), keywords });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// AI 辅助写作：总结 / 续写 / 翻译（结果不落库，由前端决定插入还是替换）
router.post('/notes/:id/ai-assist', async (req, res) => {
  const b = req.body || {};
  const action = String(b.action || 'summarize');
  const row = req.tdb.prepare('SELECT * FROM notes WHERE id=?').get(int(req.params.id, -1));
  if (!row) return res.status(404).json({ error: '笔记不存在' });
  const content = String(row.content || '');
  const selection = String(b.selection || '');
  const src = selection || content;
  if (!src.trim()) return res.status(400).json({ error: '没有可处理的正文' });
  let prompt;
  if (action === 'summarize') {
    prompt = `请用 150 字以内总结下面这篇笔记的核心要点，直接输出总结本身，不要任何前后缀。\n\n${src.slice(0, 8000)}`;
  } else if (action === 'continue') {
    prompt = `请顺着下面这段笔记的思路继续写下去，保持原有的语气、人称与 Markdown 结构，只输出续写的内容，不要重复原文，也不要解释。\n\n${src.slice(-2000)}`;
  } else if (action === 'translate') {
    prompt = `请把下面的内容翻译成英文，保留 Markdown 结构与代码块，只输出译文，不要解释。\n\n${src.slice(0, 6000)}`;
  } else {
    return res.status(400).json({ error: `不支持的 action：${action}` });
  }
  const aiService = require('../services/aiService');
  if (!aiService.hasConfig(req.tdb)) return res.status(400).json({ error: '未配置 AI 模型' });
  try {
    const r = await aiService.chatEx(
      [{ role: 'system', content: '你是中文写作助手，输出直接可用，不要客套话。' }, { role: 'user', content: prompt }],
      { maxTokens: 1500, temperature: action === 'translate' ? 0.3 : 0.7, tdb: req.tdb }
    );
    res.json({ ok: true, action, result: String(r.content || ''), model: r.model || '', usage: r.usage || null });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ============================================================
// 二、文件夹（多级树）。/notes/categories 是它的顶层兼容外壳（老契约 + 外部写入令牌）
// ============================================================

router.get('/notes/folders', (req, res) => {
  const tdb = req.tdb;
  const map = folderMap(tdb);
  const cnt = new Map(tdb.prepare('SELECT folder_id, COUNT(*) c FROM notes WHERE folder_id IS NOT NULL GROUP BY folder_id')
    .all().map((r) => [Number(r.folder_id), r.c]));
  // 累计篇数（本层 + 全部后代）：左栏树的徽标用这个口径。IM 归档的笔记都在孙层
  // （IM连接/飞书/<连接器名>），直属口径会把上两级显示成 0，看着像空目录。
  // note_count 保持直属语义不动——删除 409 提示、分类管理弹窗这些消费方要的就是"本层有几篇"。
  const total = new Map();
  const sumOf = (f, depth) => {
    const own = cnt.get(f.id) || 0;
    if (depth > 64) return own; // 深度上限：防数据异常造成的死循环（与 folderMap 同款保险）
    const t = own + f.children.reduce((acc, c) => acc + sumOf(c, depth + 1), 0);
    total.set(f.id, t);
    return t;
  };
  map.roots.forEach((f) => sumOf(f, 0));
  const mk = (f, depth) => {
    if (depth > 64) return null;
    return {
      id: f.id, name: f.name, parent_id: f.parent_id == null ? null : Number(f.parent_id),
      sort_order: f.sort_order, intake_token: f.intake_token || '', path: f.path, created_at: f.created_at,
      note_count: cnt.get(f.id) || 0,
      note_count_total: total.get(f.id) || 0,
      children: f.children.map((c) => mk(c, depth + 1)).filter(Boolean),
    };
  };
  res.json(map.roots.map((f) => mk(f, 0)).filter(Boolean));
});

router.post('/notes/folders', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: '文件夹名不能为空' });
  const pid = b.parent_id === undefined || b.parent_id === null ? null : int(b.parent_id, null);
  if (pid != null && !folderOr404(req.tdb, pid)) return res.status(404).json({ error: '父文件夹不存在' });
  const maxRow = pid == null
    ? req.tdb.prepare('SELECT MAX(sort_order) m FROM note_folders WHERE parent_id IS NULL').get()
    : req.tdb.prepare('SELECT MAX(sort_order) m FROM note_folders WHERE parent_id=?').get(pid);
  const order = b.sort_order !== undefined && Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : (Number(maxRow.m) || 0) + 1;
  const r = req.tdb.prepare('INSERT OR IGNORE INTO note_folders(name,parent_id,sort_order) VALUES(?,?,?)').run(name, pid, order);
  if (!r.changes) return res.status(400).json({ error: '同级下已有同名文件夹' });
  res.json({ id: Number(r.lastInsertRowid) });
});

router.put('/notes/folders/:id', (req, res) => {
  const tdb = req.tdb;
  const id = int(req.params.id, -1);
  const cur = folderOr404(tdb, id);
  if (!cur) return res.status(404).json({ error: '文件夹不存在' });
  const b = req.body || {};
  const name = b.name !== undefined ? (String(b.name).trim().slice(0, 40) || cur.name) : cur.name;
  const pid = b.parent_id !== undefined ? (b.parent_id === null ? null : int(b.parent_id, null)) : cur.parent_id;
  const order = b.sort_order !== undefined ? (Number(b.sort_order) || 0) : cur.sort_order;
  // 移动防成环：从新父节点往上走，撞到自己就拒绝
  if (pid != null) {
    if (pid === id) return res.status(400).json({ error: '不能把文件夹移动到它自己下面' });
    let p = folderOr404(tdb, pid), guard = 0;
    if (!p) return res.status(404).json({ error: '父文件夹不存在' });
    while (p && p.parent_id != null && guard++ < 64) {
      if (Number(p.parent_id) === id) return res.status(400).json({ error: '不能移动到自己的子文件夹里' });
      p = folderOr404(tdb, Number(p.parent_id));
    }
  }
  const dup = pid == null
    ? tdb.prepare('SELECT id FROM note_folders WHERE parent_id IS NULL AND name=? AND id<>?').get(name, id)
    : tdb.prepare('SELECT id FROM note_folders WHERE parent_id=? AND name=? AND id<>?').get(pid, name, id);
  if (dup) return res.status(400).json({ error: '同级下已有同名文件夹' });
  // 令牌动作：gen=生成/轮换（外部写入通道），clear=收回。老分类接口只认顶层，这里对任意层级都开放。
  let token = cur.intake_token || '';
  if (b.token_action === 'gen') token = crypto.randomBytes(16).toString('hex');
  else if (b.token_action === 'clear') token = '';
  tdb.prepare('UPDATE note_folders SET name=?, parent_id=?, sort_order=?, intake_token=? WHERE id=?')
    .run(name, pid, order, token, id);
  // 改名同步 notes.category 缓存列——v1.9.39 那个「分类改名后笔记从筛选器里消失」的 bug 就出在这儿
  if (name !== cur.name) tdb.prepare('UPDATE notes SET category=? WHERE folder_id=?').run(name, id);
  res.json({ ok: true, id, name, parent_id: pid, intake_token: token });
});

// 删除文件夹。有笔记或子文件夹 → 409（带条数），force=1 才真删。
// force 后：子文件夹上提到本文件夹的父级（顶层撞名的自动加后缀），笔记 folder_id 置空（真·未归档）。
router.delete('/notes/folders/:id', (req, res) => {
  const tdb = req.tdb;
  const id = int(req.params.id, -1);
  const cur = folderOr404(tdb, id);
  if (!cur) return res.status(404).json({ error: '文件夹不存在' });
  const used = tdb.prepare('SELECT COUNT(*) c FROM notes WHERE folder_id=?').get(id).c;
  const kids = tdb.prepare('SELECT id FROM note_folders WHERE parent_id=?').all(id).length;
  if ((used || kids) && req.query.force !== '1') {
    return res.status(409).json({ error: `该文件夹下还有 ${used} 条笔记、${kids} 个子文件夹`, count: used, children: kids, need_force: true });
  }
  const tx = tdb.transaction(() => {
    for (const k of tdb.prepare('SELECT id, name FROM note_folders WHERE parent_id=?').all(id)) {
      const newName = uniqueNameInParent(tdb, cur.parent_id, k.name);
      tdb.prepare('UPDATE note_folders SET parent_id=?, name=? WHERE id=?').run(cur.parent_id, newName, k.id);
      if (newName !== k.name) tdb.prepare('UPDATE notes SET category=? WHERE folder_id=?').run(newName, k.id);
    }
    tdb.prepare('UPDATE notes SET folder_id=NULL WHERE folder_id=?').run(id);
    tdb.prepare('DELETE FROM note_folders WHERE id=?').run(id);
  });
  tx();
  res.json({ ok: true, moved: used, children: kids });
});

// ---------- 老契约：分类 = 顶层文件夹 ----------
router.get('/notes/categories', (req, res) => {
  const tdb = req.tdb;
  const rows = tdb.prepare('SELECT * FROM note_folders WHERE parent_id IS NULL ORDER BY sort_order, id').all();
  const map = new Map(tdb.prepare('SELECT folder_id, COUNT(*) c FROM notes WHERE folder_id IS NOT NULL GROUP BY folder_id')
    .all().map((r) => [Number(r.folder_id), r.c]));
  res.json(rows.map((r) => ({ ...r, id: Number(r.id), note_count: map.get(Number(r.id)) || 0 })));
});

router.post('/notes/categories', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 20);
  if (!name) return res.status(400).json({ error: '分类名不能为空' });
  const maxRow = req.tdb.prepare('SELECT MAX(sort_order) m FROM note_folders WHERE parent_id IS NULL').get();
  const order = req.body.sort_order !== undefined && Number.isFinite(Number(req.body.sort_order))
    ? Number(req.body.sort_order) : (Number(maxRow.m) || 0) + 1;
  const r = req.tdb.prepare('INSERT OR IGNORE INTO note_folders(name,parent_id,sort_order) VALUES(?,NULL,?)').run(name, order);
  if (!r.changes) return res.status(400).json({ error: '该分类已存在' });
  res.json({ id: Number(r.lastInsertRowid) });
});

router.put('/notes/categories/:id', (req, res) => {
  const tdb = req.tdb;
  const id = int(req.params.id, -1);
  const cur = tdb.prepare('SELECT * FROM note_folders WHERE id=? AND parent_id IS NULL').get(id);
  if (!cur) return res.status(404).json({ error: '分类不存在' });
  const b = req.body || {};
  // 令牌动作：gen=生成/轮换（外部写入通道），clear=收回
  let token = cur.intake_token || '';
  if (b.token_action === 'gen') token = crypto.randomBytes(16).toString('hex');
  else if (b.token_action === 'clear') token = '';
  const name = b.name !== undefined ? (String(b.name).trim().slice(0, 20) || cur.name) : cur.name;
  const order = b.sort_order !== undefined ? (Number(b.sort_order) || 0) : cur.sort_order;
  if (name !== cur.name && tdb.prepare('SELECT id FROM note_folders WHERE parent_id IS NULL AND name=? AND id<>?').get(name, id)) {
    return res.status(400).json({ error: '分类名已被占用' });
  }
  tdb.prepare('UPDATE note_folders SET name=?, sort_order=?, intake_token=? WHERE id=?').run(name, order, token, id);
  if (name !== cur.name) tdb.prepare('UPDATE notes SET category=? WHERE folder_id=?').run(name, id);
  res.json({ ok: true, intake_token: token });
});

router.delete('/notes/categories/:id', (req, res) => {
  const tdb = req.tdb;
  const id = int(req.params.id, -1);
  const cur = tdb.prepare('SELECT * FROM note_folders WHERE id=? AND parent_id IS NULL').get(id);
  if (!cur) return res.status(404).json({ error: '分类不存在' });
  if (cur.name === 'general') return res.status(400).json({ error: '「未分类」不可删除' });
  const used = tdb.prepare('SELECT COUNT(*) c FROM notes WHERE folder_id=?').get(id).c;
  if (used && req.query.force !== '1') {
    return res.status(409).json({ error: `该分类下还有 ${used} 条笔记`, count: used, need_force: true });
  }
  const tx = tdb.transaction(() => {
    if (used) {
      const g = tdb.prepare("SELECT id FROM note_folders WHERE name='general' AND parent_id IS NULL").get();
      if (g) tdb.prepare("UPDATE notes SET folder_id=?, category='general' WHERE folder_id=?").run(Number(g.id), id);
      else tdb.prepare('UPDATE notes SET folder_id=NULL WHERE folder_id=?').run(id);
    }
    // 子文件夹挂到 general 下（老分类没有子级，这条只是防御）
    const g2 = tdb.prepare("SELECT id FROM note_folders WHERE name='general' AND parent_id IS NULL").get();
    for (const k of tdb.prepare('SELECT id, name FROM note_folders WHERE parent_id=?').all(id)) {
      const newName = uniqueNameInParent(tdb, g2 ? Number(g2.id) : null, k.name);
      tdb.prepare('UPDATE note_folders SET parent_id=?, name=? WHERE id=?').run(g2 ? Number(g2.id) : null, newName, k.id);
      if (newName !== k.name) tdb.prepare('UPDATE notes SET category=? WHERE folder_id=?').run(newName, k.id);
    }
    tdb.prepare('DELETE FROM note_folders WHERE id=?').run(id);
  });
  tx();
  res.json({ ok: true, moved: used });
});

// ============================================================
// 三、标签 / 书签 / 属性 / 模板
// ============================================================

router.get('/notes/tags', (req, res) => {
  const rows = req.tdb.prepare(
    'SELECT tag, COUNT(*) count FROM note_tags GROUP BY tag ORDER BY count DESC, tag LIMIT 1000'
  ).all();
  res.json(rows.map((r) => ({ tag: r.tag, count: r.count })));
});

router.put('/notes/:id/tags', (req, res) => {
  const tdb = req.tdb;
  const id = int(req.params.id, -1);
  const row = tdb.prepare('SELECT * FROM notes WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: '笔记不存在' });
  const raw = (req.body && req.body.tags) || [];
  const tags = (Array.isArray(raw) ? raw : String(raw).split(',')).map((t) => String(t).trim()).filter(Boolean);
  const final = syncNoteTags(tdb, id, row.content || '', tags);
  res.json({ ok: true, tags: final });
});

router.get('/notes/bookmarks', (req, res) => {
  const tdb = req.tdb;
  const kind = String(req.query.kind || '').trim();
  const where = kind ? ' WHERE b.kind=?' : '';
  const rows = tdb.prepare(
    `SELECT b.*, n.title, n.folder_id, f.name AS folder_name
     FROM note_bookmarks b LEFT JOIN notes n ON n.id=b.note_id
     LEFT JOIN note_folders f ON f.id=COALESCE(b.folder_id, n.folder_id)${where}
     ORDER BY b.created_at DESC, b.id DESC LIMIT 500`
  ).all(...(kind ? [kind] : []));
  res.json(rows.map((r) => ({ ...r, id: Number(r.id) })));
});

const PROP_TYPES = new Set(['text', 'number', 'date', 'select', 'checkbox']);

router.get('/notes/properties', (req, res) => {
  const defs = req.tdb.prepare('SELECT * FROM note_property_defs ORDER BY sort_order, id').all();
  res.json(defs.map((d) => {
    let options = [];
    try { options = JSON.parse(d.options || '[]') || []; } catch { options = []; }
    return { ...d, id: Number(d.id), options };
  }));
});

router.post('/notes/properties', (req, res) => {
  const b = req.body || {};
  const key = String(b.key || '').trim().slice(0, 30);
  if (!key) return res.status(400).json({ error: '属性名不能为空' });
  const type = PROP_TYPES.has(String(b.type)) ? String(b.type) : 'text';
  const options = JSON.stringify(Array.isArray(b.options) ? b.options.map((o) => String(o).slice(0, 40)) : []);
  const maxRow = req.tdb.prepare('SELECT MAX(sort_order) m FROM note_property_defs').get();
  const order = b.sort_order !== undefined && Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : (Number(maxRow.m) || 0) + 1;
  const r = req.tdb.prepare('INSERT OR IGNORE INTO note_property_defs(key,label,type,options,sort_order) VALUES(?,?,?,?,?)')
    .run(key, String(b.label || '').slice(0, 40), type, options, order);
  if (!r.changes) return res.status(400).json({ error: '该属性名已存在' });
  res.json({ id: Number(r.lastInsertRowid) });
});

router.put('/notes/properties/:id', (req, res) => {
  const tdb = req.tdb;
  const id = int(req.params.id, -1);
  const cur = tdb.prepare('SELECT * FROM note_property_defs WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '属性不存在' });
  const b = req.body || {};
  const key = b.key !== undefined ? (String(b.key).trim().slice(0, 30) || cur.key) : cur.key;
  const type = b.type !== undefined && PROP_TYPES.has(String(b.type)) ? String(b.type) : cur.type;
  const options = b.options !== undefined
    ? JSON.stringify(Array.isArray(b.options) ? b.options.map((o) => String(o).slice(0, 40)) : [])
    : cur.options;
  if (key !== cur.key && tdb.prepare('SELECT id FROM note_property_defs WHERE key=? AND id<>?').get(key, id)) {
    return res.status(400).json({ error: '该属性名已存在' });
  }
  tdb.prepare('UPDATE note_property_defs SET key=?, label=?, type=?, options=?, sort_order=? WHERE id=?')
    .run(key, b.label !== undefined ? String(b.label).slice(0, 40) : cur.label, type, options,
      b.sort_order !== undefined ? (Number(b.sort_order) || 0) : cur.sort_order, id);
  res.json({ ok: true });
});

router.delete('/notes/properties/:id', (req, res) => {
  // 只删定义，笔记里 notes.props 上残留的键留着（删定义不该顺手改用户的正文数据）
  req.tdb.prepare('DELETE FROM note_property_defs WHERE id=?').run(int(req.params.id, -1));
  res.json({ ok: true });
});

router.get('/notes/templates', (req, res) => {
  res.json(req.tdb.prepare('SELECT * FROM note_templates ORDER BY sort_order, id').all()
    .map((r) => ({ ...r, id: Number(r.id) })));
});

router.post('/notes/templates', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: '模板名不能为空' });
  const maxRow = req.tdb.prepare('SELECT MAX(sort_order) m FROM note_templates').get();
  const order = b.sort_order !== undefined && Number.isFinite(Number(b.sort_order)) ? Number(b.sort_order) : (Number(maxRow.m) || 0) + 1;
  const r = req.tdb.prepare('INSERT INTO note_templates(name,content,folder_id,sort_order) VALUES(?,?,?,?)')
    .run(name, String(b.content || '').slice(0, 200000), b.folder_id === undefined ? null : int(b.folder_id, null), order);
  res.json({ id: Number(r.lastInsertRowid) });
});

router.put('/notes/templates/:id', (req, res) => {
  const tdb = req.tdb;
  const id = int(req.params.id, -1);
  const cur = tdb.prepare('SELECT * FROM note_templates WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '模板不存在' });
  const b = req.body || {};
  tdb.prepare("UPDATE note_templates SET name=?, content=?, folder_id=?, sort_order=?, updated_at=datetime('now','localtime') WHERE id=?")
    .run(b.name !== undefined ? (String(b.name).trim().slice(0, 40) || cur.name) : cur.name,
      b.content !== undefined ? String(b.content).slice(0, 200000) : cur.content,
      b.folder_id !== undefined ? (b.folder_id === null ? null : int(b.folder_id, null)) : cur.folder_id,
      b.sort_order !== undefined ? (Number(b.sort_order) || 0) : cur.sort_order, id);
  res.json({ ok: true });
});

router.delete('/notes/templates/:id', (req, res) => {
  req.tdb.prepare('DELETE FROM note_templates WHERE id=?').run(int(req.params.id, -1));
  res.json({ ok: true });
});

// 从模板建笔记：{{date}} {{time}} {{title}} 三个占位符
router.post('/notes/from-template', (req, res) => {
  const tdb = req.tdb;
  const b = req.body || {};
  const t = tdb.prepare('SELECT * FROM note_templates WHERE id=?').get(int(b.template_id, -1));
  if (!t) return res.status(404).json({ error: '模板不存在' });
  const now = new Date();
  const date = now.toLocaleString('sv').slice(0, 10);
  const time = now.toTimeString().slice(0, 5);
  const title = String(b.title || '').trim().slice(0, noteService.TITLE_MAX) || String(t.name || '').slice(0, noteService.TITLE_MAX);
  const content = fillTemplate(b.content !== undefined ? b.content : t.content, { date, time, title });
  const id = createNote(tdb, {
    title, content,
    folder_id: b.folder_id !== undefined ? b.folder_id : t.folder_id,
    category: b.category, tags: b.tags, props: b.props,
  });
  res.json({ id });
});

// ============================================================
// 四、搜索 / 查询
// ============================================================

// 四种模式：keyword（关键词）/ tag（标签）/ path（所在文件夹路径）/ regex（正则，走 worker 硬超时）
router.get('/notes/search', async (req, res) => {
  const tdb = req.tdb;
  const mode = String(req.query.mode || 'keyword');
  const q = String(req.query.q || '');
  const limit = Math.min(1000, Math.max(1, int(req.query.limit, 200)));
  if (!q.trim() && mode !== 'path') return res.json({ mode, rows: [], count: 0 });
  const fmap = folderMap(tdb);
  const base = 'SELECT id,title,category,folder_id,tags,summary,word_count,record_id,daily_date,created_at,updated_at FROM notes';

  if (mode === 'tag') {
    const rows = tdb.prepare(`${base} WHERE id IN (SELECT note_id FROM note_tags WHERE tag LIKE ?) ORDER BY updated_at DESC LIMIT ?`)
      .all(`%${q}%`, limit);
    return res.json({ mode, rows: withFolderPath(rows, fmap), count: rows.length });
  }
  if (mode === 'path') {
    const ids = [];
    // ⚠️ 用 byId 而不是 rows：folderMap 的 rows 是原始库行，path 只挂在 byId 里的那份对象上
    for (const f of fmap.byId.values()) if (f.path.includes(q)) ids.push(...folderSubtreeIds(tdb, f.id));
    const uniq = [...new Set(ids)];
    if (!uniq.length) return res.json({ mode, rows: [], count: 0 });
    const rows = tdb.prepare(`${base} WHERE folder_id IN (${uniq.map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT ?`)
      .all(...uniq, limit);
    return res.json({ mode, rows: withFolderPath(rows, fmap), count: rows.length });
  }
  if (mode === 'regex') {
    const v = validateRegex(q, String(req.query.flags || 'i'));
    if (v.error) return res.status(400).json({ error: v.error });
    const uid = tenantIdOf(tdb);
    const dbPath = uid != null ? tenantDbFile(uid) : tenantDbFile(req.user.id);
    const scan = await regexScan({
      dbPath, sql: 'SELECT id,title,content FROM notes ORDER BY updated_at DESC LIMIT 2000',
      pattern: v.pattern, flags: v.flags, limit,
    });
    if (scan.degraded || scan.error) return res.status(400).json({ error: scan.error || '正则扫描不可用' });
    if (!scan.ids.length) return res.json({ mode, rows: [], count: 0, timed_out: !!scan.timed_out });
    const rows = tdb.prepare(`${base} WHERE id IN (${scan.ids.map(() => '?').join(',')})`).all(...scan.ids);
    const order = new Map(scan.ids.map((id, i) => [Number(id), i]));
    rows.sort((a, b) => (order.get(Number(a.id)) ?? 0) - (order.get(Number(b.id)) ?? 0));
    return res.json({ mode, rows: withFolderPath(rows, fmap), count: rows.length, timed_out: !!scan.timed_out, scanned: scan.scanned });
  }
  const rows = tdb.prepare(`${base} WHERE (title LIKE ? OR content LIKE ? OR tags LIKE ?) ORDER BY updated_at DESC LIMIT ?`)
    .all(`%${q}%`, `%${q}%`, `%${q}%`, limit);
  res.json({ mode: 'keyword', rows: withFolderPath(rows, fmap), count: rows.length });
});

// Dataview 式查询：{text} 走文本语法，{where:[...], join, sort, order, limit, offset} 走结构化
router.post('/notes/query', (req, res) => {
  const tdb = req.tdb;
  const b = req.body || {};
  const q = buildQuery(tdb, b);
  if (q.error) return res.status(400).json({ error: q.error });
  const rows = tdb.prepare(
    `SELECT n.id,n.title,n.category,n.folder_id,n.tags,n.summary,n.props,n.word_count,n.record_id,n.daily_date,n.created_at,n.updated_at
     FROM notes n WHERE ${q.where} ORDER BY ${q.order} ${q.dir} LIMIT ? OFFSET ?`
  ).all(...q.params, q.limit, q.offset);
  res.json({ rows: withFolderPath(rows, folderMap(tdb)), count: rows.length, limit: q.limit, offset: q.offset });
});

// 【批量反链】（v1.10.24）：给一组笔记两两互加 [[标题]] 链接，落在每篇的「## 关联笔记」小节。
// 幂等（已链过不重复加）、没有新链接的笔记不动；副作用与手动保存同口径（词数/标签/双链重算）。
router.post('/notes/backlink-mutual', (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids : [];
  try {
    res.json(noteService.backlinkMutual(req.tdb, ids));
  } catch (e) {
    res.status(e.code === 400 || e.code === 404 ? e.code : 500).json({ error: e.message || '批量反链失败' });
  }
});

// 【循环链】（v1.10.28）：按 ids 顺序串成一条环——每篇只补一条指向下一篇的 [[标题]]，末篇链回首篇。
// ids 的数组顺序就是链的顺序（前端按勾选行的展示顺序传）；幂等与副作用同互链。
router.post('/notes/backlink-chain', (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids : [];
  try {
    res.json(noteService.backlinkChain(req.tdb, ids));
  } catch (e) {
    res.status(e.code === 400 || e.code === 404 ? e.code : 500).json({ error: e.message || '循环链接失败' });
  }
});

// 【批量取消链接】（v1.10.28）：清掉所选笔记「## 关联笔记」小节里的链接条目（互链/循环链的逆操作）。
// 只清整行是 - [[标题]] 的条目；正文手写的 [[链接]] 与带说明文字的条目不动；小节清空后节头也不留。
router.post('/notes/backlink-clear', (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids : [];
  try {
    res.json(noteService.backlinkClear(req.tdb, ids));
  } catch (e) {
    res.status(e.code === 400 || e.code === 404 ? e.code : 500).json({ error: e.message || '取消链接失败' });
  }
});

// ============================================================
// 五、图谱 / 统计 / 时间线 / 日历 / 每日笔记 / 设置
// ============================================================

router.get('/notes/graph', (req, res) => {
  res.json(buildGraph(req.tdb, {
    folderId: req.query.folder_id ? int(req.query.folder_id, null) : null,
    tag: String(req.query.tag || ''), q: String(req.query.q || ''),
    max: int(req.query.max, 2000),
  }));
});

router.get('/notes/graph/local/:id', (req, res) => {
  const g = localGraph(req.tdb, int(req.params.id, -1), int(req.query.depth, 1), int(req.query.limit, 300));
  if (!g) return res.status(404).json({ error: '笔记不存在' });
  res.json(g);
});

router.get('/notes/stats', (req, res) => {
  res.json(noteStats(req.tdb, { days: int(req.query.days, 365) }));
});

router.get('/notes/timeline', (req, res) => {
  const tdb = req.tdb;
  const field = String(req.query.field || 'updated');
  const col = ({ created: 'created_at', updated: 'updated_at', daily: 'daily_date' })[field] || 'updated_at';
  const gran = String(req.query.granularity || 'day');
  const expr = gran === 'month' ? `substr(${col},1,7)` : gran === 'week' ? `strftime('%Y-W%W', ${col})` : `date(${col})`;
  const conds = [`${col} IS NOT NULL`];
  const args = [];
  if (req.query.from) { conds.push(`date(${col}) >= date(?)`); args.push(String(req.query.from)); }
  if (req.query.to) { conds.push(`date(${col}) <= date(?)`); args.push(String(req.query.to)); }
  const rows = tdb.prepare(
    `SELECT ${expr} AS bucket, COUNT(*) count, COALESCE(SUM(word_count),0) words
     FROM notes WHERE ${conds.join(' AND ')} GROUP BY bucket ORDER BY bucket`
  ).all(...args);
  res.json({ field, granularity: gran, buckets: rows });
});

// 日历插件用：按天列出笔记标题（有 daily_date 用它，否则用更新日期）
router.get('/notes/by-day', (req, res) => {
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return res.status(400).json({ error: 'from/to 需要 YYYY-MM-DD' });
  const rows = req.tdb.prepare(
    `SELECT id, title, folder_id, daily_date, updated_at, COALESCE(daily_date, date(updated_at)) AS d
     FROM notes WHERE COALESCE(daily_date, date(updated_at)) BETWEEN ? AND ?
     ORDER BY d, id LIMIT 5000`
  ).all(from, to);
  const out = {};
  for (const r of rows) { (out[r.d] || (out[r.d] = [])).push({ id: Number(r.id), title: r.title, folder_id: r.folder_id == null ? null : Number(r.folder_id), daily: !!r.daily_date }); }
  res.json(out);
});

router.get('/notes/daily', (req, res) => {
  const tdb = req.tdb;
  let date = String(req.query.date || '').trim();
  if (!DATE_RE.test(date)) date = localToday();
  const row = tdb.prepare('SELECT * FROM notes WHERE daily_date=?').get(date);
  res.json({ date, note: row ? decorateNote(tdb, row) : null });
});

// 每日笔记：幂等（同一天只会有一条，靠 notes.daily_date 的部分唯一索引兜并发）
// 创建逻辑在 noteService.ensureDailyNote 里，scheduler 的自动创建走同一份。
router.post('/notes/daily', (req, res) => {
  const tdb = req.tdb;
  const b = req.body || {};
  let date = String(b.date || '').trim();
  if (!DATE_RE.test(date)) date = localToday();
  const cfg = getSetting(tdb, 'daily_note', null) || {};
  const template = cfg.template_id ? tdb.prepare('SELECT content FROM note_templates WHERE id=?').get(int(cfg.template_id, -1)) : null;
  const r = ensureDailyNote(tdb, date, {
    title: b.title,
    content: b.content !== undefined ? String(b.content) : undefined,
    folder_id: b.folder_id !== undefined ? b.folder_id : cfg.folder_id,
    template,
  });
  res.json({ id: r.id, created: r.created, date, note: decorateNote(tdb, r.row) });
});

router.get('/notes/settings', (req, res) => {
  const d = getSetting(req.tdb, 'daily_note', null) || {};
  res.json({
    daily_note: {
      auto_create: !!d.auto_create,
      folder_id: d.folder_id == null ? null : Number(d.folder_id),
      template_id: d.template_id == null ? null : Number(d.template_id),
    },
  });
});

router.put('/notes/settings', (req, res) => {
  const cur = getSetting(req.tdb, 'daily_note', null) || {};
  const b = (req.body && req.body.daily_note) || {};
  const next = {
    auto_create: b.auto_create !== undefined ? bool(b.auto_create) : !!cur.auto_create,
    folder_id: b.folder_id !== undefined ? (b.folder_id === null ? null : int(b.folder_id, null)) : (cur.folder_id ?? null),
    template_id: b.template_id !== undefined ? (b.template_id === null ? null : int(b.template_id, null)) : (cur.template_id ?? null),
  };
  setSetting(req.tdb, 'daily_note', next);
  res.json({ ok: true, daily_note: next });
});

// ============================================================
// 六、附件
// ============================================================

router.post('/notes/attachments', uploadOne('file'), (req, res) => {
  const noteId = int((req.body && req.body.note_id) ?? req.query.note_id, null);
  const r = storeAttachment(req.tdb, noteId, req.file);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r);
});

router.get('/notes/attachments/:id/raw', (req, res) => {
  const a = req.tdb.prepare('SELECT * FROM note_attachments WHERE id=?').get(int(req.params.id, -1));
  if (!a) return res.status(404).json({ error: '附件不存在' });
  res.setHeader('Content-Type', a.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(a.filename || 'file')}`);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (a.storage_path && fs.existsSync(a.storage_path)) return fs.createReadStream(a.storage_path).pipe(res);
  if (a.data) return res.end(Buffer.from(a.data, 'base64'));
  res.status(404).json({ error: '附件内容已丢失' });
});

router.delete('/notes/attachments/:id', (req, res) => {
  const tdb = req.tdb;
  const a = tdb.prepare('SELECT * FROM note_attachments WHERE id=?').get(int(req.params.id, -1));
  if (a) {
    tdb.prepare('UPDATE note_board_items SET attachment_id=NULL WHERE attachment_id=?').run(a.id);
    if (a.storage_path) { try { fs.unlinkSync(a.storage_path); } catch { /* 文件不在就算了 */ } }
    tdb.prepare('DELETE FROM note_attachments WHERE id=?').run(a.id);
  }
  res.json({ ok: true });
});

// ============================================================
// 七、白板
// ============================================================

router.get('/notes/boards', (req, res) => {
  const rows = req.tdb.prepare('SELECT * FROM note_boards ORDER BY updated_at DESC, id DESC').all();
  res.json(rows.map((r) => ({ ...r, id: Number(r.id) })));
});

router.post('/notes/boards', (req, res) => {
  const name = String((req.body && req.body.name) || '新白板').trim().slice(0, 40) || '新白板';
  const r = req.tdb.prepare('INSERT INTO note_boards(name,viewport) VALUES(?,?)')
    .run(name, JSON.stringify({ x: 0, y: 0, zoom: 1 }));
  res.json({ id: Number(r.lastInsertRowid), name });
});

router.get('/notes/boards/:id', (req, res) => {
  const tdb = req.tdb;
  const id = int(req.params.id, -1);
  const b = tdb.prepare('SELECT * FROM note_boards WHERE id=?').get(id);
  if (!b) return res.status(404).json({ error: '白板不存在' });
  // 笔记卡实时 join 标题（白板永远是活链接，不是冻结副本）
  const items = tdb.prepare(
    `SELECT i.*, n.title AS note_title, n.summary AS note_summary, a.filename AS attachment_name
     FROM note_board_items i
     LEFT JOIN notes n ON n.id=i.note_id
     LEFT JOIN note_attachments a ON a.id=i.attachment_id
     WHERE i.board_id=? ORDER BY i.z, i.id`
  ).all(id);
  const edges = tdb.prepare('SELECT * FROM note_board_edges WHERE board_id=? ORDER BY id').all(id);
  res.json({
    ...b, id,
    viewport: (() => { try { return JSON.parse(b.viewport || '{}') || {}; } catch { return {}; } })(),
    items: items.map((i) => ({ ...i, id: Number(i.id) })),
    edges: edges.map((e) => ({ ...e, id: Number(e.id) })),
  });
});

router.put('/notes/boards/:id', (req, res) => {
  const tdb = req.tdb;
  const id = int(req.params.id, -1);
  const cur = tdb.prepare('SELECT * FROM note_boards WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '白板不存在' });
  const b = req.body || {};
  const name = b.name !== undefined ? (String(b.name).trim().slice(0, 40) || cur.name) : cur.name;
  const viewport = b.viewport !== undefined
    ? JSON.stringify(b.viewport && typeof b.viewport === 'object' ? b.viewport : {})
    : (cur.viewport || '');
  tdb.prepare("UPDATE note_boards SET name=?, viewport=?, updated_at=datetime('now','localtime') WHERE id=?")
    .run(name, viewport, id);
  res.json({ ok: true });
});

router.delete('/notes/boards/:id', (req, res) => {
  const tdb = req.tdb;
  const id = int(req.params.id, -1);
  const tx = tdb.transaction(() => {
    tdb.prepare('DELETE FROM note_board_edges WHERE board_id=?').run(id);
    tdb.prepare('DELETE FROM note_board_items WHERE board_id=?').run(id);
    tdb.prepare('DELETE FROM note_boards WHERE id=?').run(id);
  });
  tx();
  res.json({ ok: true });
});

// 批量落盘：前端 800ms 防抖后把整块状态推过来（items upsert + removed 删除 + edges 重建），单事务
router.put('/notes/boards/:id/layout', (req, res) => {
  const tdb = req.tdb;
  const id = int(req.params.id, -1);
  if (!tdb.prepare('SELECT id FROM note_boards WHERE id=?').get(id)) return res.status(404).json({ error: '白板不存在' });
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];
  const edges = Array.isArray(b.edges) ? b.edges : [];
  if (items.length > 500 || edges.length > 1000) return res.status(400).json({ error: '白板内容过多（卡片上限 500、连线上限 1000）' });
  const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
  const upItem = tdb.prepare(
    `UPDATE note_board_items SET type=?,note_id=?,attachment_id=?,text=?,url=?,x=?,y=?,w=?,h=?,z=?,color=? WHERE id=? AND board_id=?`
  );
  const insItem = tdb.prepare(
    `INSERT INTO note_board_items(board_id,type,note_id,attachment_id,text,url,x,y,w,h,z,color) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const delItem = tdb.prepare('DELETE FROM note_board_items WHERE id=? AND board_id=?');
  const tx = tdb.transaction(() => {
    for (const rid of (Array.isArray(b.removed_items) ? b.removed_items : [])) {
      tdb.prepare('DELETE FROM note_board_edges WHERE board_id=? AND (from_item_id=? OR to_item_id=?)').run(id, int(rid, -1), int(rid, -1));
      delItem.run(int(rid, -1), id);
    }
    for (const it of items) {
      const type = ['text', 'image', 'webpage'].includes(String(it.type)) ? String(it.type) : 'note';
      const vals = [type, int(it.note_id, null), int(it.attachment_id, null), String(it.text || '').slice(0, 4000),
        String(it.url || '').slice(0, 500), num(it.x), num(it.y), num(it.w, 240), num(it.h, 120), int(it.z, 0), String(it.color || '').slice(0, 20)];
      if (it.id) upItem.run(...vals, int(it.id, -1), id);
      else insItem.run(id, ...vals);
    }
    if (b.replace_edges !== false) tdb.prepare('DELETE FROM note_board_edges WHERE board_id=?').run(id);
    const insEdge = tdb.prepare('INSERT INTO note_board_edges(board_id,from_item_id,to_item_id,label) VALUES(?,?,?,?)');
    for (const e of edges) insEdge.run(id, int(e.from_item_id, -1), int(e.to_item_id, -1), String(e.label || '').slice(0, 80));
    tdb.prepare("UPDATE note_boards SET viewport=?, updated_at=datetime('now','localtime') WHERE id=?")
      .run(b.viewport !== undefined ? JSON.stringify(b.viewport) : '', id);
  });
  tx();
  res.json({ ok: true, items: items.length, edges: edges.length });
});

// 往白板上贴一张图：先落附件，再建一张 image 卡
router.post('/notes/boards/:id/image', uploadOne('file'), (req, res) => {
  const tdb = req.tdb;
  const id = int(req.params.id, -1);
  if (!tdb.prepare('SELECT id FROM note_boards WHERE id=?').get(id)) return res.status(404).json({ error: '白板不存在' });
  const a = storeAttachment(tdb, null, req.file);
  if (a.error) return res.status(400).json({ error: a.error });
  const x = Number((req.body && req.body.x) || 0) || 0;
  const y = Number((req.body && req.body.y) || 0) || 0;
  const r = tdb.prepare("INSERT INTO note_board_items(board_id,type,attachment_id,x,y,w,h) VALUES(?,?,?,?,?,?,?)")
    .run(id, 'image', a.id, x, y, 260, 180);
  res.json({ id: Number(r.lastInsertRowid), attachment_id: a.id, url: a.url });
});

// ============================================================
// 八、通配路由（**必须最后注册**，见上方说明）
// ============================================================

// 单篇：饰化形状（props 对象 / tags 数组 / 文件夹路径）
router.get('/notes/:id', (req, res) => {
  const row = req.tdb.prepare('SELECT * FROM notes WHERE id=?').get(int(req.params.id, -1));
  if (!row) return res.status(404).json({ error: '笔记不存在' });
  res.json(decorateNote(req.tdb, row));
});

module.exports = router;
