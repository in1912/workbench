// 笔记公共逻辑（v1.9.39）：标题/标签提取、[[双链]] 解析、建笔记。
// 被三处共用：core.js 的笔记 CRUD、noteShareRoutes.js 的外部写入、vibeRoutes.js 的转写完成建笔记。
// 纯本地、零依赖（标签提取不调用 AI 模型）。

// 根据内容自动提取标题：优先取首句（截断 20 字），否则取开头
function extractTitle(content) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (!text) return '无标题笔记';
  const first = text.split(/[。！？!?\n；;]/)[0].trim();
  if (first) return first.slice(0, 20);
  return text.slice(0, 20);
}

// 自动标签：中文取 2 字组、英文取 ≥3 字母词，剔除含常见虚词字符的组后按词频排序。
// 短文本（≤300 字）出现 1 次即可，长文本要求 ≥2 次降噪；正文里命中的既有分类名额外加权。
const TAG_STOP_CHARS = new Set('的了着过是在有和与及或也就都而之其这那个我你他她它们不没会很更最把被给对从到中上下为以所如若但并等可该此能还要凡则且因使由'.split(''));
function extractTags(text, tdb, limit = 5) {
  const raw = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/[#>*`_~\-]/g, ' ')
    .replace(/\s+/g, ' ');
  const minCount = raw.length > 300 ? 2 : 1;
  const freq = new Map();
  for (const m of raw.matchAll(/[一-龥]{2,}/g)) {
    const run = m[0];
    for (let i = 0; i + 2 <= run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (TAG_STOP_CHARS.has(bg[0]) || TAG_STOP_CHARS.has(bg[1])) continue;
      freq.set(bg, (freq.get(bg) || 0) + 1);
    }
  }
  for (const m of raw.matchAll(/[A-Za-z][A-Za-z0-9]{2,}/g)) {
    const w = m[0].toLowerCase();
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  try {
    for (const { name } of tdb.prepare('SELECT name FROM note_categories').all()) {
      if (name && name !== 'general' && raw.includes(name)) freq.set(name, (freq.get(name) || 0) + 3);
    }
  } catch { /* 分类表缺失时忽略 */ }
  return [...freq.entries()]
    .filter(([w, c]) => c >= minCount && w.length <= 12)
    .sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length))
    .slice(0, limit)
    .map(([w]) => w)
    .join(',');
}

// 解析正文 [[标题]] → note_links（有向存储、无向查询）。保存时先清该笔记的出链再重建。
const WIKI_RE = /\[\[([^\[\]\n]{1,80})\]\]/g;
function syncNoteLinks(tdb, srcId, content) {
  const id = Number(srcId);
  tdb.prepare('DELETE FROM note_links WHERE src_note_id=?').run(id);
  const titles = new Set();
  for (const m of String(content || '').matchAll(WIKI_RE)) {
    const t = m[1].trim();
    if (t) titles.add(t);
  }
  if (!titles.size) return;
  const find = tdb.prepare('SELECT id FROM notes WHERE title=? LIMIT 1');
  const ins = tdb.prepare('INSERT OR IGNORE INTO note_links(src_note_id,dst_note_id) VALUES(?,?)');
  for (const t of titles) {
    const row = find.get(t);
    if (row && Number(row.id) !== id) ins.run(id, row.id);
  }
}

// 建一条笔记（统一入口：自动标题 + 自动标签 + 双链解析 + 可选关联录音）
function createNote(tdb, { title = '', content = '', category = 'general', summary = '', record_id = null } = {}) {
  const cat = category || 'general';
  const text = String(content || '');
  const r = tdb.prepare(
    'INSERT INTO notes(title,content,category,tags,summary,record_id) VALUES(?,?,?,?,?,?)'
  ).run(
    String(title || '').trim().slice(0, 60) || extractTitle(text),
    text, cat, extractTags(text, tdb), String(summary || '').slice(0, 500), record_id || null
  );
  const id = Number(r.lastInsertRowid);
  syncNoteLinks(tdb, id, text);
  return id;
}

module.exports = { extractTitle, extractTags, syncNoteLinks, createNote, WIKI_RE };
