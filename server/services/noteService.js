// 笔记公共逻辑（v1.9.41 知识系统版）
// 被四处共用：noteRoutes.js 的笔记 CRUD、noteShareRoutes.js 的外部写入、
//             vibeRoutes.js 的转写完成建笔记、scheduler 的每日笔记。
// 纯本地、零依赖（标签提取不调用 AI 模型）。
const fs = require('fs');

// 根据内容自动提取标题：优先取首句（截断 20 字），否则取开头
function extractTitle(content) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (!text) return '无标题笔记';
  const first = text.split(/[。！？!?\n；;]/)[0].trim();
  if (first) return first.slice(0, 20);
  return text.slice(0, 20);
}

// 自动标签：中文取 2 字组、英文取 ≥3 字母词，剔除含常见虚词字符的组后按词频排序。
// 短文本（≤300 字）出现 1 次即可，长文本要求 ≥2 次降噪；正文里命中的**文件夹名**额外加权。
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
    // v1.9.41：加权词从「分类名」改为「文件夹名」（多级树里所有层级的名字都算）
    for (const { name } of tdb.prepare('SELECT name FROM note_folders').all()) {
      if (name && name !== 'general' && raw.includes(name)) freq.set(name, (freq.get(name) || 0) + 3);
    }
  } catch { /* 文件夹表缺失时忽略 */ }
  return [...freq.entries()]
    .filter(([w, c]) => c >= minCount && w.length <= 12)
    .sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length))
    .slice(0, limit)
    .map(([w]) => w);
}

// 行内标签 #标签（用户手写的才是「真标签」，权重高于自动提取的）。
// 前导字符限制：必须是行首或空白/括号/常见标点，这样 `# 一级标题`（井号后有空格）不会被误收。
const INLINE_TAG_RE = /(^|[\s(（[【,，。;；!！?？:：、])#([A-Za-z0-9_一-龥]{1,30})/g;
function extractInlineTags(content) {
  const out = new Set();
  for (const m of String(content || '').matchAll(INLINE_TAG_RE)) out.add(m[2]);
  return [...out];
}

// 字数：中日韩表意文字逐字计 + 拉丁/数字按词计（与前端 utils/markdown.js.wordCount 同一口径）
function extractWordCount(text) {
  const s = String(text || '');
  const cjk = (s.match(/[㐀-䶿一-鿿぀-ヿ가-힯]/g) || []).length;
  const latin = (s.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
  return cjk + latin;
}

// 标签落库：手动标签 ∪ 行内 #标签 ∪ 自动标签 → 重写 note_tags，并把 notes.tags 逗号串同步为缓存。
// notes.tags 保留是因为 searchService 与 ?q= 都直接 LIKE 它，改成联表反而更慢（个人量级）。
//
// manualTags 传 undefined = 「沿用库里已有的手动标签」——这是保存正文时的正确行为：
// 正文一变，inline/auto 重算，但用户手打上去的标签不会被冲掉（靠 note_tags.source 区分）。
// 返回最终标签数组。
function syncNoteTags(tdb, noteId, content, manualTags) {
  const id = Number(noteId);
  let manual = manualTags;
  if (manual === undefined || manual === null) {
    manual = tdb.prepare("SELECT tag FROM note_tags WHERE note_id=? AND source='manual'").all(id).map((r) => r.tag);
  }
  const text = String(content || '');
  const seen = new Set();
  const rows = [];
  const add = (t, src) => {
    const v = String(t || '').trim().replace(/^#/, '').slice(0, 30);
    if (v && !seen.has(v)) { seen.add(v); rows.push([v, src]); }
  };
  // 顺序即优先级：先来的占住这个 tag（UNIQUE(note_id,tag)），后到的来源被忽略
  for (const t of (Array.isArray(manual) ? manual : String(manual || '').split(','))) add(t, 'manual');
  for (const t of extractInlineTags(text)) add(t, 'inline');
  // 自动标签只是「快速记录」的兜底：用户一旦用手动标签或 #行内标签表过态，
  // 就不再往上糊自动词——否则标签面板里删掉的自动标签，下次保存又会长回来。
  if (!rows.length) for (const t of extractTags(text, tdb)) add(t, 'auto');
  const final = rows.slice(0, 40);
  tdb.prepare('DELETE FROM note_tags WHERE note_id=?').run(id);
  const ins = tdb.prepare('INSERT OR IGNORE INTO note_tags(note_id,tag,source) VALUES(?,?,?)');
  for (const [t, s] of final) ins.run(id, t, s);
  tdb.prepare('UPDATE notes SET tags=? WHERE id=?').run(final.map((r) => r[0]).join(','), id);
  return final.map((r) => r[0]);
}

// ---------- 双链 ----------
const WIKI_RE = /\[\[([^\[\]\n]{1,80})\]\]/g;

// 标题 → 笔记 id：先查真标题，再回退别名（改名后 [[旧标题]] 仍能解析）
function resolveTitle(tdb, title) {
  const t = String(title || '').trim();
  if (!t) return null;
  const n = tdb.prepare('SELECT id FROM notes WHERE title=? ORDER BY id LIMIT 1').get(t);
  if (n) return Number(n.id);
  const a = tdb.prepare('SELECT note_id FROM note_aliases WHERE alias=? LIMIT 1').get(t);
  return a ? Number(a.note_id) : null;
}

// 解析正文 [[标题]] → note_links；**解析不到的落 note_unresolved_links**（旧版是静默丢弃）。
// 有向存储、无向查询；保存时先清该笔记的出链与未解析链接再重建。
function syncNoteLinks(tdb, srcId, content) {
  const id = Number(srcId);
  tdb.prepare('DELETE FROM note_links WHERE src_note_id=?').run(id);
  tdb.prepare('DELETE FROM note_unresolved_links WHERE src_note_id=?').run(id);
  const titles = new Set();
  for (const m of String(content || '').matchAll(WIKI_RE)) {
    const t = m[1].trim();
    if (t) titles.add(t);
  }
  if (!titles.size) return;
  const insLink = tdb.prepare('INSERT OR IGNORE INTO note_links(src_note_id,dst_note_id) VALUES(?,?)');
  const insUn = tdb.prepare('INSERT OR IGNORE INTO note_unresolved_links(src_note_id,title) VALUES(?,?)');
  for (const t of titles) {
    const dst = resolveTitle(tdb, t);
    if (dst && dst !== id) insLink.run(id, dst);
    else if (!dst) insUn.run(id, t); // 自链既不建边也不记未解析
  }
}

// 笔记新建/改名后调用：把别处指向这个标题的未解析链接「转正」成真链接。
// 返回转正的条数。
function resolveUnresolvedFor(tdb, noteId, title) {
  const id = Number(noteId);
  const t = String(title || '').trim();
  if (!t) return 0;
  const rows = tdb.prepare('SELECT id, src_note_id FROM note_unresolved_links WHERE title=?').all(t);
  if (!rows.length) return 0;
  const ins = tdb.prepare('INSERT OR IGNORE INTO note_links(src_note_id,dst_note_id) VALUES(?,?)');
  const del = tdb.prepare('DELETE FROM note_unresolved_links WHERE id=?');
  let n = 0;
  for (const r of rows) {
    if (Number(r.src_note_id) !== id) { ins.run(r.src_note_id, id); n++; }
    del.run(r.id);
  }
  return n;
}

// ---------- 文件夹树 ----------
// 全量取一次做内存树（个人量级几百个文件夹，比递归 CTE 好读也好调）
function folderMap(tdb) {
  const rows = tdb.prepare('SELECT * FROM note_folders ORDER BY sort_order, id').all();
  const byId = new Map(rows.map((r) => [Number(r.id), { ...r, id: Number(r.id), children: [] }]));
  const roots = [];
  for (const f of byId.values()) {
    const p = f.parent_id == null ? null : byId.get(Number(f.parent_id));
    if (p) p.children.push(f); else roots.push(f);
  }
  const pathOf = (f) => {
    const parts = [f.name];
    let cur = f, guard = 0;
    while (cur.parent_id != null && guard++ < 64) {
      const p = byId.get(Number(cur.parent_id));
      if (!p) break;
      parts.unshift(p.name);
      cur = p;
    }
    return parts.join('/');
  };
  for (const f of byId.values()) f.path = pathOf(f);
  return { byId, roots, rows };
}

// 某文件夹 + 全部后代的 id（?folder_id= 默认连子文件夹一起筛）
function folderSubtreeIds(tdb, folderId) {
  const { byId } = folderMap(tdb);
  const start = byId.get(Number(folderId));
  if (!start) return [];
  const out = [];
  const walk = (f, depth) => {
    if (depth > 64) return; // 深度上限：防数据异常造成的死循环
    out.push(f.id);
    for (const c of f.children) walk(c, depth + 1);
  };
  walk(start, 0);
  return out;
}

// ---------- 建/删 ----------
// 建一条笔记（统一入口：自动标题 + 标签 + 双链 + 可选关联录音）。
// folder_id 缺省时按 category 名字找顶层文件夹，再兜到 general——老调用方（转写建笔记传
// category:'general'、外部写入传分类名）无需改动即落到正确文件夹。
function createNote(tdb, {
  title = '', content = '', folder_id = null, category = '', tags = [], props = null,
  summary = '', record_id = null, daily_date = null,
} = {}) {
  const text = String(content || '');
  let fid = Number(folder_id) || null;
  if (!fid && category) {
    const f = tdb.prepare('SELECT id FROM note_folders WHERE name=? AND parent_id IS NULL').get(String(category));
    if (f) fid = Number(f.id);
  }
  if (!fid) {
    const g = tdb.prepare("SELECT id FROM note_folders WHERE name='general' AND parent_id IS NULL").get();
    fid = g ? Number(g.id) : null;
  }
  const fname = fid ? (tdb.prepare('SELECT name FROM note_folders WHERE id=?').get(fid) || {}).name || '' : '';
  const finalTitle = String(title || '').trim().slice(0, 60) || extractTitle(text);
  const r = tdb.prepare(
    `INSERT INTO notes(title,content,category,folder_id,tags,summary,props,record_id,daily_date,word_count)
     VALUES(?,?,?,?,?,?,?,?,?,?)`
  ).run(
    finalTitle, text, fname, fid, '', String(summary || '').slice(0, 500),
    JSON.stringify(props && typeof props === 'object' && !Array.isArray(props) ? props : {}),
    record_id || null, daily_date || null, extractWordCount(text)
  );
  const id = Number(r.lastInsertRowid);
  syncNoteTags(tdb, id, text, tags);
  syncNoteLinks(tdb, id, text);
  resolveUnresolvedFor(tdb, id, finalTitle);
  return id;
}

// 模板占位符：{{date}} {{time}} {{title}}。从模板建笔记与每日笔记共用同一套替换，
// 否则同一个模板从两个入口进来会得到不同结果。
function fillTemplate(tpl, vars = {}) {
  return String(tpl || '')
    .replace(/\{\{date\}\}/g, vars.date || '')
    .replace(/\{\{time\}\}/g, vars.time || '')
    .replace(/\{\{title\}\}/g, vars.title || '');
}

// 每日笔记的「按日期幂等创建」：POST /notes/daily 与 scheduler 的自动创建共用这一份，
// 免得两处各写一遍模板替换。daily_date 上有部分唯一索引，并发插入靠它兜底。
// overrides.content 传了就不再套模板（用户在编辑器里手存过内容的情形）。
function ensureDailyNote(tdb, date, { title = '', content, folder_id = null, template = null } = {}) {
  const exist = tdb.prepare('SELECT * FROM notes WHERE daily_date=?').get(date);
  if (exist) return { id: Number(exist.id), created: false, row: exist };
  const finalTitle = String(title || '').trim() || `${date} 日记`;
  let text;
  if (content !== undefined && content !== null) text = String(content);
  else if (template && template.content) text = fillTemplate(template.content, { date, time: new Date().toTimeString().slice(0, 5), title: finalTitle });
  else text = `# ${date}\n\n`;
  try {
    const id = createNote(tdb, { title: finalTitle, content: text, folder_id, daily_date: date });
    return { id, created: true, row: tdb.prepare('SELECT * FROM notes WHERE id=?').get(id) };
  } catch (e) {
    const again = tdb.prepare('SELECT * FROM notes WHERE daily_date=?').get(date);
    if (again) return { id: Number(again.id), created: false, row: again };
    throw e;
  }
}

// 删一条笔记 + 级联。**绝不碰 vibe_records / 音频文件**——那是用户真实录音，
// 留在「效率工具 → 录音转写」里可查（这是 v1.9.39 就定下的规矩）。
function deleteNote(tdb, noteId) {
  const id = Number(noteId);
  const row = tdb.prepare('SELECT id, title FROM notes WHERE id=?').get(id);
  if (!row) return null;
  // 先把「谁链到我这」记下来：笔记没了，它们的 [[标题]] 要退回未解析（否则反链凭空消失）
  const inbound = tdb.prepare('SELECT src_note_id FROM note_links WHERE dst_note_id=?').all(id);
  const atts = tdb.prepare('SELECT id, storage_path FROM note_attachments WHERE note_id=?').all(id);
  for (const a of atts) {
    tdb.prepare('UPDATE note_board_items SET attachment_id=NULL WHERE attachment_id=?').run(a.id);
    if (a.storage_path) { try { fs.unlinkSync(a.storage_path); } catch { /* 文件不在就算了 */ } }
  }
  tdb.prepare('DELETE FROM note_attachments WHERE note_id=?').run(id);
  tdb.prepare('DELETE FROM note_shares WHERE note_id=?').run(id);
  tdb.prepare('DELETE FROM note_links WHERE src_note_id=? OR dst_note_id=?').run(id, id);
  tdb.prepare('DELETE FROM note_tags WHERE note_id=?').run(id);
  tdb.prepare('DELETE FROM note_aliases WHERE note_id=?').run(id);
  tdb.prepare('DELETE FROM note_unresolved_links WHERE src_note_id=?').run(id);
  tdb.prepare("DELETE FROM note_bookmarks WHERE kind='note' AND note_id=?").run(id);
  tdb.prepare('UPDATE note_board_items SET note_id=NULL WHERE note_id=?').run(id);
  tdb.prepare('DELETE FROM notes WHERE id=?').run(id);
  if (row.title) {
    const ins = tdb.prepare('INSERT OR IGNORE INTO note_unresolved_links(src_note_id,title) VALUES(?,?)');
    for (const s of inbound) ins.run(s.src_note_id, row.title);
  }
  return { id, title: row.title, attachments: atts.length };
}

// 把库里一行 notes 装饰成前端要的形状：props 解对象、tags 解数组、带文件夹路径
function decorateNote(tdb, row, fmap = null) {
  if (!row) return row;
  const map = fmap || folderMap(tdb);
  let props = {};
  try { props = JSON.parse(row.props || '{}') || {}; } catch { props = {}; }
  const f = row.folder_id == null ? null : map.byId.get(Number(row.folder_id));
  return {
    ...row,
    props,
    tags: String(row.tags || '').split(',').map((s) => s.trim()).filter(Boolean),
    folder_id: row.folder_id == null ? null : Number(row.folder_id),
    folder: f ? f.name : '',
    folder_path: f ? f.path : '',
  };
}

module.exports = {
  extractTitle, extractTags, extractInlineTags, extractWordCount,
  syncNoteTags, syncNoteLinks, resolveTitle, resolveUnresolvedFor,
  folderMap, folderSubtreeIds,
  createNote, deleteNote, decorateNote,
  fillTemplate, ensureDailyNote,
  WIKI_RE, INLINE_TAG_RE,
};
