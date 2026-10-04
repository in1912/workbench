// Dataview 式笔记查询（v1.9.41）——**受限语法，不是裸 SQL**，所有值一律参数绑定。
//
//   expr  := term (("AND"|"OR") term)*        从左到右结合，整体加括号，无优先级歧义
//   term  := field op value | "#" tag | "[[" title "]]"
//   field := title|content|tag|folder|category|created|updated|bookmarked|words|prop.KEY|link
//   op    := = | != | ~ | > | < | >= | <=     （~ = LIKE 模糊）
//   value := "字符串" | '字符串' | 裸串 | 数字 | YYYY-MM-DD
//
// 未知字段/操作符 → { error }（路由转 400）；子句数上限 10；limit 默认 200 / 上限 1000。
// 两种入口：{ text } 走上面的文本语法；{ where:[{field,op,value}], join } 走结构化（数据库视图的表单用）。
const { folderSubtreeIds, folderMap } = require('./noteService');

const FIELDS = new Set(['title', 'content', 'tag', 'folder', 'category', 'created', 'updated',
  'bookmarked', 'words', 'link']);
const OPS = new Set(['=', '!=', '~', '>', '<', '>=', '<=']);
const MAX_CLAUSES = 10;
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 200;
const PROP_KEY_RE = /^[A-Za-z0-9_一-龥-]{1,30}$/;

// ---------- 文本语法 ----------
function tokenize(s) {
  const out = [];
  const STOP = '()';
  const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (isSpace(c)) { i++; continue; }
    if (c === '(' || c === ')') { out.push({ t: c }); i++; continue; }
    if (c === '#') {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_一-龥-]/.test(s[j])) j++;
      if (j === i + 1) return { error: '# 后面要跟标签名' };
      out.push({ t: 'tag', v: s.slice(i + 1, j) }); i = j; continue;
    }
    if (c === '[' && s[i + 1] === '[') {
      const j = s.indexOf(']]', i + 2);
      if (j < 0) return { error: '[[ 没有闭合的 ]]' };
      const v = s.slice(i + 2, j).trim();
      if (!v) return { error: '[[]] 里要写标题' };
      out.push({ t: 'link', v }); i = j + 2; continue;
    }
    if (c === '"' || c === "'") {
      const j = s.indexOf(c, i + 1);
      if (j < 0) return { error: `引号 ${c} 没有闭合` };
      out.push({ t: 'str', v: s.slice(i + 1, j) }); i = j + 1; continue;
    }
    const opm = /^(>=|<=|!=|=|~|>|<)/.exec(s.slice(i));
    if (opm) { out.push({ t: 'op', v: opm[1] }); i += opm[1].length; continue; }
    let j = i;
    while (j < s.length && !isSpace(s[j]) && !STOP.includes(s[j]) && !'><=!~'.includes(s[j])) j++;
    const w = s.slice(i, j);
    const up = w.toUpperCase();
    if (up === 'AND' || up === 'OR') out.push({ t: up });
    else if (w) out.push({ t: 'word', v: w });
    i = j;
  }
  return { tokens: out };
}

// 文本 → 扁平子句序列 [{join:'AND'|'OR'|null, clause}]（结构化表单直接产出同样的形状）
function parseText(text) {
  const tk = tokenize(String(text || ''));
  if (tk.error) return { error: tk.error };
  const ts = tk.tokens;
  if (!ts.length) return { error: '查询不能为空' };
  const clauses = [];
  let i = 0;
  let expectJoin = false;
  while (i < ts.length) {
    const tk0 = ts[i];
    if (expectJoin) {
      if (tk0.t !== 'AND' && tk0.t !== 'OR') return { error: '两个条件之间要用 AND 或 OR 连接' };
      clauses.push({ join: tk0.t });
      i++;
      expectJoin = false;
      continue;
    }
    if (tk0.t === 'tag') { clauses.push({ clause: { field: 'tag', op: '=', value: tk0.v } }); i++; expectJoin = true; continue; }
    if (tk0.t === 'link') { clauses.push({ clause: { field: 'link', op: '=', value: tk0.v } }); i++; expectJoin = true; continue; }
    if (tk0.t === '(' || tk0.t === ')') return { error: '暂不支持括号分组，请用从左到右的 AND / OR 串联' };
    if (tk0.t !== 'word') return { error: `看不懂的记号：${tk0.v ?? tk0.t}` };
    const field = tk0.v;
    const opTok = ts[i + 1];
    const valTok = ts[i + 2];
    if (!opTok || opTok.t !== 'op') return { error: `字段 ${field} 后面要跟比较符（= != ~ > < >= <=）` };
    if (!valTok || !(valTok.t === 'word' || valTok.t === 'str')) return { error: `比较符 ${opTok.v} 后面要跟一个值` };
    clauses.push({ clause: { field, op: opTok.v, value: valTok.v } });
    i += 3;
    expectJoin = true;
  }
  // 收尾时最后落下的必须是个条件，不能是悬空的连接词
  if (clauses.length && !clauses[clauses.length - 1].clause) return { error: '表达式不能以 AND / OR 结尾' };
  return { clauses };
}

// 单条子句 → 参数化 SQL 片段
function compileClause(tdb, { field, op, value }) {
  const f = String(field || '').trim();
  const base = f.split('.')[0].toLowerCase();
  const opOk = OPS.has(op);
  if (!opOk) return { error: `不支持的操作符 ${op}` };
  const like = op === '~';
  const cmp = (col, v) => ({ sql: `${col} ${like ? 'LIKE' : op} ?`, params: [like ? `%${v}%` : v] });
  const truthy = (v) => ['1', 'true', 'yes', '是', 'y'].includes(String(v).toLowerCase());

  if (base === 'title') return cmp('n.title', value);
  if (base === 'content') return cmp('n.content', value);
  if (base === 'created') return cmp('n.created_at', value);
  if (base === 'updated') return cmp('n.updated_at', value);
  if (base === 'words') {
    const num = Number(value);
    if (!Number.isFinite(num)) return { error: 'words 的值要是数字' };
    return { sql: `n.word_count ${op} ?`, params: [num] };
  }
  if (base === 'bookmarked') {
    const want = truthy(value) ? (op === '!=' ? 0 : 1) : (op === '!=' ? 1 : 0);
    return {
      sql: `${want ? '' : 'NOT '}EXISTS (SELECT 1 FROM note_bookmarks b WHERE b.note_id=n.id AND b.kind='note')`,
      params: [],
    };
  }
  if (base === 'tag') {
    return like
      ? { sql: 'EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id=n.id AND t.tag LIKE ?)', params: [`%${value}%`] }
      : { sql: `EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id=n.id AND t.tag ${op === '!=' ? '<>' : '='} ?)`, params: [value] };
  }
  if (base === 'link') {
    return { sql: 'EXISTS (SELECT 1 FROM note_links l JOIN notes d ON d.id=l.dst_note_id WHERE l.src_note_id=n.id AND d.title = ?)', params: [value] };
  }
  if (base === 'folder' || base === 'category') {
    // 先按完整路径找（'工作/2026'），再回落到顶层名字（'工作'）。
    // 命中后**连子文件夹一起**取（与 GET /notes?folder_id= 的行为一致）。
    const want = String(value);
    const map = folderMap(tdb);
    // 认三种写法：完整路径（工作/2026）、顶层名（工作）、任意层级的文件夹名（2026）。
    // 名字在多处重名时取并集——对使用者来说「找叫这个名字的文件夹」比「只认第一个」更符合直觉。
    const hits = [];
    for (const f of map.byId.values()) if (f.path === want) hits.push(f.id);
    if (!hits.length) for (const f of map.byId.values()) if (f.name === want) hits.push(f.id);
    if (!hits.length) return { sql: '1=0', params: [] }; // 没有这个文件夹 → 空集，而不是报错
    const idSet = new Set();
    for (const id of hits) for (const x of folderSubtreeIds(tdb, id)) idSet.add(x);
    const ids = [...idSet];
    const neg = op === '!=' || op === '<>';
    return { sql: `n.folder_id ${neg ? 'NOT IN' : 'IN'} (${ids.map(() => '?').join(',')})`, params: ids };
  }
  if (base === 'prop') {
    const key = f.slice(f.indexOf('.') + 1);
    if (!PROP_KEY_RE.test(key)) return { error: `属性名不合法：${key}` };
    return { sql: `json_extract(n.props, '$."${key}"') ${like ? 'LIKE' : op} ?`, params: [like ? `%${value}%` : value] };
  }
  return { error: `未知字段：${field}（可用：title/content/tag/folder/created/updated/bookmarked/words/link/prop.键名）` };
}

// 主入口：返回 { where, params, limit, offset, order } 或 { error }
function buildQuery(tdb, body = {}) {
  const b = body || {};
  let clauses;
  if (Array.isArray(b.where)) {
    clauses = b.where.map((c) => ({ clause: c }));
    // 结构化表单里的 join 是整体一个，展开成子句之间的连接符
    const join = String(b.join || 'AND').toUpperCase() === 'OR' ? 'OR' : 'AND';
    clauses = clauses.flatMap((c, i) => (i === 0 ? [c] : [{ join }, c]));
  } else if (typeof b.text === 'string' && b.text.trim()) {
    const p = parseText(b.text);
    if (p.error) return { error: p.error };
    clauses = p.clauses;
  } else {
    return { error: '缺少查询条件（text 或 where）' };
  }
  const terms = clauses.filter((c) => c.clause);
  if (!terms.length) return { error: '查询不能为空' };
  if (terms.length > MAX_CLAUSES) return { error: `条件过多（上限 ${MAX_CLAUSES} 个）` };

  const params = [];
  let sql = '';
  let idx = 0;
  // 连接词是**独立的记号**（{join:'OR'} 单独占一格，不带 clause），
  // 它管的是「它后面那个条件」怎么跟前面接起来——所以要先记下来，不能从条件自己身上找 join。
  let pending = null;
  for (const c of clauses) {
    if (c.join) { pending = c.join; continue; }
    if (!c.clause) continue;
    const r = compileClause(tdb, c.clause);
    if (r.error) return { error: r.error };
    const piece = `(${r.sql})`;
    if (idx === 0) sql = piece;
    else sql = `(${sql} ${pending === 'OR' ? 'OR' : 'AND'} ${piece})`;
    params.push(...r.params);
    pending = null;
    idx++;
  }

  const sortMap = { created: 'n.created_at', updated: 'n.updated_at', title: 'n.title', words: 'n.word_count', folder: 'n.folder_id' };
  const order = sortMap[String(b.sort || 'updated').toLowerCase()] || 'n.updated_at';
  const dir = String(b.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(b.limit) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(b.offset) || 0);
  return { where: sql, params, order, dir, limit, offset };
}

module.exports = { buildQuery, parseText, compileClause, MAX_LIMIT, DEFAULT_LIMIT, MAX_CLAUSES };
