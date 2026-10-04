// 关系引擎（v1.10.0，人生管理系统 M1）——整套系统的地基。
//
// 原文反复强调「护城河在连接，不在功能」：单个目标/任务/笔记市面上都有，壁垒是**它们之间的自动关联**。
// 工作台此前只有笔记内部有双链（note_links），目标/任务/复盘/项目彼此互不相识。本模块补上这一层。
//
// 与 note_links 的分工（**别合并**）：
//   note_links      = 笔记**正文里**的 [[标题]] 解析结果，带未解析链接、别名、双链语法语义 → 归笔记模块
//   life_links（本表）= 跨模块的显式边（目标→领域、任务→目标、复盘→目标…）→ 归人生管理系统
// 两者互不干扰：笔记挂到目标上走 life_links，笔记之间互链仍走 note_links。
//
// 设计要点：
//  · 有向存储、无向查询 —— 查询一律「出边 UNION 入边」，调用方不用关心方向。
//  · 类型/关系词白名单在**服务层**校验，不在 DDL 加 CHECK（CHECK 要改就得重建表）。
//  · 五元组 UNIQUE 让自动建链可重复执行（INSERT OR IGNORE），重启/重跑不会产生重复边。

// 实体类型 → 标题解析。title 为 **SQL 表达式**（不是列名），因为有的表要 COALESCE 兜底。
// 表不在租户库 / 行已删除时，标题解析失败只返回 null（前端显示 #类型:id），不抛错——
// 关系引擎不该因为某个模块没权限或表缺失就整页报错。
const ENTITY = {
  goal: { table: 'life_goals', title: 'title' },
  kr: { table: 'life_key_results', title: 'title' },
  task: { table: 'todos', title: 'title' },
  habit: { table: 'life_habits', title: 'title' },
  project: { table: 'life_projects', title: 'title' },
  note: { table: 'notes', title: 'title' },
  domain: { table: 'life_domains', title: 'name' },
  sop: { table: 'life_sops', title: 'scenario' },
  bill: { table: 'pay_bills', title: "COALESCE(NULLIF(goods,''), NULLIF(counterparty,''), '')" },
  family: { table: 'family_items', title: 'title' },
  kid: { table: 'kids', title: 'name' },
  skill: { table: 'business_skills', title: 'name' },
  file: { table: 'files', title: 'filename' },
  review: { table: 'life_reviews', title: null }, // 无标题列，合成「周复盘 2026-W40」
};

// 关系词就这 6 个，够用且不会长成垃圾场。
const RELATIONS = ['belongs', 'supports', 'produces', 'derives', 'reviews', 'relates'];
const RELATION_LABEL = {
  belongs: '属于', supports: '支撑', produces: '产出',
  derives: '派生', reviews: '复盘', relates: '相关',
};

const TYPES = Object.keys(ENTITY);
const isType = (t) => Object.prototype.hasOwnProperty.call(ENTITY, t) && ENTITY[t] != null;
const isRelation = (r) => RELATIONS.includes(r);

function bad(msg, code = 400) {
  return Object.assign(new Error(msg), { code });
}

/**
 * 建一条边。幂等（五元组唯一，重复调用无副作用）。
 * @returns {boolean} true=新建 / false=已存在（两者都是成功，调用方一般忽略）
 */
function link(tdb, srcType, srcId, dstType, dstId, relation = 'relates', note = '') {
  if (!isType(srcType)) throw bad(`未知实体类型：${srcType}`);
  if (!isType(dstType)) throw bad(`未知实体类型：${dstType}`);
  if (!isRelation(relation)) throw bad(`未知关系词：${relation}`);
  const a = Number(srcId), b = Number(dstId);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw bad('实体 id 必须是数字');
  // 自环（同类型同 id 指向自己）没有意义，直接当成功忽略，避免页面上出现「自己关联自己」
  if (srcType === dstType && a === b) return false;
  const r = tdb.prepare(
    `INSERT OR IGNORE INTO life_links(src_type,src_id,dst_type,dst_id,relation,note)
     VALUES(?,?,?,?,?,?)`
  ).run(srcType, a, dstType, b, relation, note || '');
  return r.changes > 0;
}

/** 删一条边（指定关系词）；不传 relation 则删这对实体之间的**所有**关系词 */
function unlink(tdb, srcType, srcId, dstType, dstId, relation = null) {
  const a = Number(srcId), b = Number(dstId);
  if (relation) {
    return tdb.prepare(
      `DELETE FROM life_links WHERE src_type=? AND src_id=? AND dst_type=? AND dst_id=? AND relation=?`
    ).run(srcType, a, dstType, b, relation).changes;
  }
  return tdb.prepare(
    `DELETE FROM life_links WHERE src_type=? AND src_id=? AND dst_type=? AND dst_id=?`
  ).run(srcType, a, dstType, b).changes;
}

/**
 * 实体被删除时清掉它两端的**所有**边。
 * 这是关系引擎最容易漏的一处：漏了就会攒下指向不存在实体的死边，
 * 之后每个「关联」面板都要靠 null 标题兜底，图谱上还会出现幽灵节点。
 * **每个删除端点都必须调它。**
 */
function purgeEntity(tdb, type, id) {
  const n = Number(id);
  return tdb.prepare(
    `DELETE FROM life_links WHERE (src_type=? AND src_id=?) OR (dst_type=? AND dst_id=?)`
  ).run(type, n, type, n).changes;
}

/** 一次清多个（删目标树、删项目连带任务等场景） */
function purgeMany(tdb, type, ids) {
  let n = 0;
  for (const id of ids) n += purgeEntity(tdb, type, id);
  return n;
}

/** 批量取标题：按 type 分组各查一次，避免 N+1 */
function fetchTitles(tdb, pairs) {
  const byType = new Map();
  for (const { type, id } of pairs) {
    if (!isType(type)) continue;
    if (!byType.has(type)) byType.set(type, new Set());
    byType.get(type).add(Number(id));
  }
  const out = new Map(); // key = `${type}:${id}` → title
  for (const [type, ids] of byType) {
    const def = ENTITY[type];
    const list = [...ids].filter((n) => Number.isFinite(n));
    if (!list.length) continue;
    const ph = list.map(() => '?').join(',');
    try {
      if (!def.title) {
        // review：合成标题（period_key 已经是给用户看的形状）
        const rows = tdb.prepare(`SELECT id, type, period_key FROM ${def.table} WHERE id IN (${ph})`).all(...list);
        const LBL = { day: '日', week: '周', month: '月', quarter: '季', year: '年' };
        for (const r of rows) out.set(`${type}:${r.id}`, `${LBL[r.type] || ''}复盘 ${r.period_key}`);
      } else {
        const rows = tdb.prepare(`SELECT id, ${def.title} AS t FROM ${def.table} WHERE id IN (${ph})`).all(...list);
        for (const r of rows) out.set(`${type}:${r.id}`, r.t || '');
      }
    } catch { /* 表缺失/无权限：标题留空，不影响其它类型 */ }
  }
  return out;
}

/**
 * 取某实体的全部关联（出边 + 入边），标题已回填。
 * @returns {{out:Array,in:Array}} 每条 = {id, relation, relation_label, dir, other:{type,id,title}, note}
 */
function linksOf(tdb, type, id) {
  const n = Number(id);
  const out = tdb.prepare(
    `SELECT * FROM life_links WHERE src_type=? AND src_id=? ORDER BY id DESC`
  ).all(type, n);
  const inn = tdb.prepare(
    `SELECT * FROM life_links WHERE dst_type=? AND dst_id=? ORDER BY id DESC`
  ).all(type, n);
  const pairs = [
    ...out.map((e) => ({ type: e.dst_type, id: e.dst_id })),
    ...inn.map((e) => ({ type: e.src_type, id: e.src_id })),
  ];
  const titles = fetchTitles(tdb, pairs);
  const dec = (e, dir) => {
    const oType = dir === 'out' ? e.dst_type : e.src_type;
    const oId = Number(dir === 'out' ? e.dst_id : e.src_id);
    return {
      id: e.id, relation: e.relation, relation_label: RELATION_LABEL[e.relation] || e.relation,
      dir, note: e.note || '',
      other: { type: oType, id: oId, title: titles.get(`${oType}:${oId}`) || '' },
    };
  };
  return { out: out.map((e) => dec(e, 'out')), in: inn.map((e) => dec(e, 'in')) };
}

/** 只要「我关联了谁、谁关联了我」的扁平列表（图谱/统计用） */
function neighbors(tdb, type, id) {
  const { out, in: inn } = linksOf(tdb, type, id);
  return [...out, ...inn].map((e) => ({ ...e.other, relation: e.relation, dir: e.dir }));
}

/**
 * 全类型关系图（前端图画布用）。
 * 只取前 max 条边（个人量级几百条，2000 够；超了先截断再算度数，避免图上噪声）。
 */
function graph(tdb, { types = null, max = 800, focus = null } = {}) {
  let sql = 'SELECT * FROM life_links';
  const args = [];
  if (Array.isArray(types) && types.length) {
    const ph = types.map(() => '?').join(',');
    sql += ` WHERE src_type IN (${ph}) OR dst_type IN (${ph})`;
    args.push(...types, ...types);
  }
  sql += ' ORDER BY id DESC LIMIT ?';
  args.push(Math.max(1, Math.min(5000, Number(max) || 800)));
  const edges = tdb.prepare(sql).all(...args);

  const deg = new Map(); // key → {in,out}
  const bump = (k, d) => { const o = deg.get(k) || { in: 0, out: 0 }; o[d]++; deg.set(k, o); };
  for (const e of edges) {
    bump(`${e.src_type}:${e.src_id}`, 'out');
    bump(`${e.dst_type}:${e.dst_id}`, 'in');
  }
  const nodes = [...deg.entries()].map(([k, d]) => {
    const [type, idStr] = k.split(':');
    return { type, id: Number(idStr), degree: d.in + d.out, in_degree: d.in, out_degree: d.out };
  });
  const titles = fetchTitles(tdb, nodes);
  for (const n of nodes) {
    n.title = titles.get(`${n.type}:${n.id}`) || '';
    n.key = `${n.type}:${n.id}`;
  }
  const linked = new Set(nodes.map((n) => n.key));
  const visEdges = edges
    .map((e) => ({ source: `${e.src_type}:${e.src_id}`, target: `${e.dst_type}:${e.dst_id}`, relation: e.relation }))
    .filter((e) => linked.has(e.source) && linked.has(e.target));
  return { nodes, edges: visEdges, truncated: edges.length >= args[args.length - 1] && edges.length > 0 };
}

module.exports = {
  ENTITY, TYPES, RELATIONS, RELATION_LABEL,
  isType, isRelation,
  link, unlink, purgeEntity, purgeMany,
  linksOf, neighbors, fetchTitles, graph,
};
