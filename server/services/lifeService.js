// 人生管理系统领域逻辑（v1.10.0，M2 目标 / M3 行动 / M4 复盘 / M5 领域 / M6 项目 / M8 SOP）。
//
// 分层：本文件只做业务规则与 SQL；HTTP 形状在 routes/lifeRoutes.js；跨模块的边在 lifeLinkService。
//
// 两条贯穿全局的纪律：
//  ① **进度永不落列** —— 目标的进度一律由 life_key_results 现算。存一列就一定会与 KR 不一致。
//  ② **删实体必清边** —— 任何删除都调 lifeLinkService.purgeEntity，否则攒下死边。
const link = require('./lifeLinkService');

// ---------- 日期/周期 ----------
const p2 = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const todayStr = () => fmtDate(new Date());
function addDays(d, n) { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date();
}

/**
 * ISO 8601 周编号（YYYY-Www）。**跨年周必须正确归属**：12/31 可能属于下一年的第 1 周，
 * 1/1 也可能属于上一年的第 52/53 周 —— 这正是设计档案里点名的坑。
 * 做法是标准技巧：先挪到本周四，那天的年份即 ISO 年。
 */
function isoWeekKey(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = t.getUTCFullYear();
  const yStart = new Date(Date.UTC(y, 0, 1));
  const week = Math.ceil(((t - yStart) / 86400000 + 1) / 7);
  return `${y}-W${p2(week)}`;
}

const REVIEW_TYPES = ['day', 'week', 'month', 'quarter', 'year'];
/** 复盘周期键：一个周期一条（period_key 与 type 组合唯一） */
function periodKey(type, dateStr) {
  const d = dateStr ? parseDate(dateStr) : new Date();
  const y = d.getFullYear(), m = d.getMonth() + 1;
  switch (type) {
    case 'day': return fmtDate(d);
    case 'week': return isoWeekKey(d);
    case 'month': return `${y}-${p2(m)}`;
    case 'quarter': return `${y}Q${Math.ceil(m / 3)}`;
    case 'year': return String(y);
    default: return fmtDate(d);
  }
}

// ---------- 目标进度 ----------
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * KR 列表 → 0~1 进度（加权平均）。
 * target<=0 的 KR 视为「未设置目标值」，**跳过且不计入权重** —— 否则会产生 NaN 并顺着目标树往上污染。
 */
function calcProgress(krs) {
  let num = 0, den = 0;
  for (const k of krs || []) {
    const t = Number(k.target) || 0;
    if (t <= 0) continue;
    const c = Number(k.current) || 0;
    const w = Number(k.weight);
    const weight = Number.isFinite(w) && w > 0 ? w : 1;
    num += weight * clamp01(c / t);
    den += weight;
  }
  return den > 0 ? num / den : 0;
}
const hasKrTarget = (krs) => (krs || []).some((k) => (Number(k.target) || 0) > 0);

// ---------- 目标 ----------
function goalRow(tdb, id) {
  return tdb.prepare('SELECT * FROM life_goals WHERE id=?').get(Number(id)) || null;
}
function krsOf(tdb, goalId) {
  return tdb.prepare('SELECT * FROM life_key_results WHERE goal_id=? ORDER BY sort_order, id').all(Number(goalId));
}

/**
 * 给一批目标算进度，自下而上：
 *  有 KR（且至少一个设了目标值）→ 用 KR 加权平均；
 *  没有 → 取子目标进度的平均（叶子无 KR 则进度为 null = 未知，前端显示「未量化」而不是 0）。
 * 返回 Map<id, number|null>
 */
function progressMap(tdb, goals) {
  const byParent = new Map();
  for (const g of goals) {
    const p = g.parent_id == null ? null : Number(g.parent_id);
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(g);
  }
  const krsByGoal = new Map();
  if (goals.length) {
    const ph = goals.map(() => '?').join(',');
    for (const k of tdb.prepare(`SELECT * FROM life_key_results WHERE goal_id IN (${ph})`).all(...goals.map((g) => g.id))) {
      const gid = Number(k.goal_id);
      if (!krsByGoal.has(gid)) krsByGoal.set(gid, []);
      krsByGoal.get(gid).push(k);
    }
  }
  const out = new Map();
  const visit = (g) => {
    const mine = krsByGoal.get(Number(g.id)) || [];
    if (hasKrTarget(mine)) { const v = calcProgress(mine); out.set(Number(g.id), v); return v; }
    const kids = byParent.get(Number(g.id)) || [];
    const vals = kids.map(visit).filter((v) => v != null);
    const v = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    out.set(Number(g.id), v);
    return v;
  };
  for (const g of byParent.get(null) || []) visit(g);
  // 兜底：parent_id 指向已删目标的孤儿，也要有值
  for (const g of goals) if (!out.has(Number(g.id))) visit(g);
  return out;
}

/** 目标树（根 → 子）。filter: {level, domain_id, status, parent_id} */
function goalTree(tdb, { level, domain_id, status, parent_id } = {}) {
  const where = [];
  const args = [];
  if (level) { where.push('level=?'); args.push(level); }
  if (domain_id != null && domain_id !== '') { where.push('domain_id=?'); args.push(Number(domain_id)); }
  if (status) { where.push('status=?'); args.push(status); }
  const rows = tdb.prepare(
    `SELECT * FROM life_goals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY sort_order, id`
  ).all(...args);
  const prog = progressMap(tdb, rows);
  const norm = (g) => ({ ...g, id: Number(g.id), parent_id: g.parent_id == null ? null : Number(g.parent_id),
    progress: prog.get(Number(g.id)) ?? null, children: [] });
  const nodes = rows.map(norm);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const roots = [];
  for (const n of nodes) {
    if (parent_id !== undefined) { // 只要某节点的子树
      if (n.id === Number(parent_id)) roots.push(n);
      else if (n.parent_id != null && byId.has(n.parent_id)) byId.get(n.parent_id).children.push(n);
    } else if (n.parent_id != null && byId.has(n.parent_id)) byId.get(n.parent_id).children.push(n);
    else roots.push(n);
  }
  return roots;
}

/** 目标详情：本体 + KR + 进度 + 子目标 + 关联（行动/笔记/复盘…全从关系引擎来） */
function goalDetail(tdb, id) {
  const g = goalRow(tdb, id);
  if (!g) return null;
  const krs = krsOf(tdb, id);
  const children = tdb.prepare('SELECT * FROM life_goals WHERE parent_id=? ORDER BY sort_order, id').all(Number(id));
  const prog = progressMap(tdb, [g, ...children]);
  const actions = tdb.prepare('SELECT * FROM todos WHERE goal_id=? ORDER BY done, priority, id').all(Number(id));
  return {
    ...g, id: Number(g.id),
    parent_id: g.parent_id == null ? null : Number(g.parent_id),
    krs: krs.map((k) => ({ ...k, id: Number(k.id), goal_id: Number(k.goal_id) })),
    progress: prog.get(Number(g.id)) ?? null,
    children: children.map((c) => ({ ...c, id: Number(c.id), progress: prog.get(Number(c.id)) ?? null })),
    actions: actions.map((a) => ({ ...a, id: Number(a.id) })),
    links: link.linksOf(tdb, 'goal', id),
  };
}

/** 同步目标的两条固定边（父子 derives、领域 belongs）。改父/改领域时先清后建。 */
function syncGoalLinks(tdb, g) {
  const id = Number(g.id);
  tdb.prepare(`DELETE FROM life_links WHERE src_type='goal' AND src_id=? AND relation='derives'`).run(id);
  tdb.prepare(`DELETE FROM life_links WHERE src_type='goal' AND src_id=? AND relation='belongs'`).run(id);
  if (g.parent_id != null) link.link(tdb, 'goal', Number(g.parent_id), 'goal', id, 'derives');
  if (g.domain_id != null) link.link(tdb, 'goal', id, 'domain', Number(g.domain_id), 'belongs');
}

function createGoal(tdb, b) {
  const r = tdb.prepare(
    `INSERT INTO life_goals(title,description,level,parent_id,domain_id,period_key,status,is_key,sort_order)
     VALUES(?,?,?,?,?,?,?,?,?)`
  ).run(
    String(b.title || '').trim() || '未命名目标', b.description || '',
    b.level || 'month', b.parent_id == null || b.parent_id === '' ? null : Number(b.parent_id),
    b.domain_id == null || b.domain_id === '' ? null : Number(b.domain_id),
    b.period_key || periodKey(b.level === 'year' ? 'year' : b.level === 'quarter' ? 'quarter' : 'month'),
    b.status || 'active', b.is_key ? 1 : 0, Number(b.sort_order) || 0
  );
  const id = Number(r.lastInsertRowid);
  syncGoalLinks(tdb, goalRow(tdb, id));
  return id;
}

function updateGoal(tdb, id, b) {
  const cur = goalRow(tdb, id);
  if (!cur) return null;
  const pick = (v, old) => (v === undefined ? old : (v === '' || v === null ? null : v));
  tdb.prepare(
    `UPDATE life_goals SET title=?,description=?,level=?,parent_id=?,domain_id=?,period_key=?,
       status=?,is_key=?,sort_order=?,updated_at=datetime('now','localtime') WHERE id=?`
  ).run(
    b.title ?? cur.title, b.description ?? cur.description, b.level ?? cur.level,
    pick(b.parent_id, cur.parent_id), pick(b.domain_id, cur.domain_id),
    b.period_key ?? cur.period_key, b.status ?? cur.status,
    b.is_key === undefined ? cur.is_key : (b.is_key ? 1 : 0),
    b.sort_order === undefined ? cur.sort_order : Number(b.sort_order) || 0, Number(id)
  );
  const g = goalRow(tdb, id);
  syncGoalLinks(tdb, g);
  return g;
}

/** 取某目标的整棵子树 id（含自己）——删目标要连子目标一起删 */
function goalSubtreeIds(tdb, id) {
  const all = tdb.prepare('SELECT id, parent_id FROM life_goals').all();
  const kids = new Map();
  for (const g of all) {
    const p = g.parent_id == null ? null : Number(g.parent_id);
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(Number(g.id));
  }
  const out = [];
  (function walk(n) { out.push(n); for (const c of kids.get(n) || []) walk(c); })(Number(id));
  return out;
}

function deleteGoal(tdb, id) {
  const ids = goalSubtreeIds(tdb, id);
  const ph = ids.map(() => '?').join(',');
  tdb.prepare(`DELETE FROM life_key_results WHERE goal_id IN (${ph})`).run(...ids);
  // 行动/项目不删，只解绑（删目标不该连带删掉用户记下的任务）
  tdb.prepare(`UPDATE todos SET goal_id=NULL WHERE goal_id IN (${ph})`).run(...ids);
  tdb.prepare(`UPDATE life_projects SET goal_id=NULL WHERE goal_id IN (${ph})`).run(...ids);
  tdb.prepare(`UPDATE life_habits SET goal_id=NULL WHERE goal_id IN (${ph})`).run(...ids);
  tdb.prepare(`DELETE FROM life_goals WHERE id IN (${ph})`).run(...ids);
  for (const i of ids) link.purgeEntity(tdb, 'goal', i);
  return ids.length;
}

// ---------- KR ----------
function createKr(tdb, goalId, b) {
  if (!goalRow(tdb, goalId)) return null;
  // 默认值（v1.10.1）：只给「没传」的调用方补，显式传 0 仍然是 0（e2e 用它测「目标值为 0 的 KR 跳过」）。
  // 目标值就是进度的分母（当前值/目标值），默认 100、当前值默认 0 —— 也就是「按百分比衡量」的默认姿势，
  // 用户觉得 100 不合适随时改；忘了填也不会得到一条 0/0 的哑 KR（旧默认 target=0 会让进度算不出来）。
  const target = b.target === undefined ? 100 : Number(b.target) || 0;
  const r = tdb.prepare(
    `INSERT INTO life_key_results(goal_id,title,target,current,unit,weight,sort_order) VALUES(?,?,?,?,?,?,?)`
  ).run(Number(goalId), String(b.title || '').trim() || '未命名 KR', target,
    Number(b.current) || 0, b.unit || '', Number(b.weight) || 1, Number(b.sort_order) || 0);
  const id = Number(r.lastInsertRowid);
  link.link(tdb, 'kr', id, 'goal', Number(goalId), 'belongs');
  return id;
}
function updateKr(tdb, id, b) {
  const cur = tdb.prepare('SELECT * FROM life_key_results WHERE id=?').get(Number(id));
  if (!cur) return null;
  tdb.prepare(
    `UPDATE life_key_results SET title=?,target=?,current=?,unit=?,weight=?,sort_order=? WHERE id=?`
  ).run(b.title ?? cur.title, b.target === undefined ? cur.target : Number(b.target) || 0,
    b.current === undefined ? cur.current : Number(b.current) || 0,
    b.unit ?? cur.unit, b.weight === undefined ? cur.weight : Number(b.weight) || 1,
    b.sort_order === undefined ? cur.sort_order : Number(b.sort_order) || 0, Number(id));
  return tdb.prepare('SELECT * FROM life_key_results WHERE id=?').get(Number(id));
}
function deleteKr(tdb, id) {
  const r = tdb.prepare('DELETE FROM life_key_results WHERE id=?').run(Number(id));
  link.purgeEntity(tdb, 'kr', id);
  return r.changes;
}

// ---------- 行动（就是 todos，不另起表；加目标/项目/类型/估时维度） ----------
const ACTION_FIELDS = ['task_type', 'goal_id', 'project_id', 'estimate_min', 'actual_min', 'main_line_date'];
const normNull = (v) => (v === '' || v === undefined ? undefined : (v === null ? null : v));

function syncActionLinks(tdb, row) {
  const id = Number(row.id);
  tdb.prepare(`DELETE FROM life_links WHERE src_type='task' AND src_id=? AND relation IN ('supports','belongs')`).run(id);
  if (row.goal_id != null) link.link(tdb, 'task', id, 'goal', Number(row.goal_id), 'supports');
  if (row.project_id != null) link.link(tdb, 'task', id, 'project', Number(row.project_id), 'belongs');
}

function createAction(tdb, b) {
  const r = tdb.prepare(
    `INSERT INTO todos(title,"desc",due_date,priority,task_type,goal_id,project_id,estimate_min,actual_min,main_line_date)
     VALUES(?,?,?,?,?,?,?,?,?,?)`
  ).run(String(b.title || '').trim() || '未命名待办', b.desc || '', b.due_date || null, Number(b.priority) || 2,
    b.task_type || 'daily_todo', normNull(b.goal_id) ?? null, normNull(b.project_id) ?? null,
    normNull(b.estimate_min) ?? null, normNull(b.actual_min) ?? null, normNull(b.main_line_date) ?? null);
  const id = Number(r.lastInsertRowid);
  syncActionLinks(tdb, tdb.prepare('SELECT * FROM todos WHERE id=?').get(id));
  return id;
}

function updateAction(tdb, id, b) {
  const cur = tdb.prepare('SELECT * FROM todos WHERE id=?').get(Number(id));
  if (!cur) return null;
  const merged = { ...cur };
  for (const f of ACTION_FIELDS) if (b[f] !== undefined) merged[f] = normNull(b[f]);
  tdb.prepare(
    `UPDATE todos SET title=?, "desc"=?, due_date=?, priority=?, done=?,
       task_type=?,goal_id=?,project_id=?,estimate_min=?,actual_min=?,main_line_date=? WHERE id=?`
  ).run(b.title ?? cur.title, b.desc ?? cur.desc,
    b.due_date !== undefined ? (b.due_date || null) : cur.due_date,
    b.priority === undefined ? cur.priority : Number(b.priority) || 2,
    b.done === undefined ? cur.done : (b.done ? 1 : 0),
    merged.task_type || 'daily_todo', merged.goal_id ?? null, merged.project_id ?? null,
    merged.estimate_min ?? null, merged.actual_min ?? null, merged.main_line_date ?? null, Number(id));
  const row = tdb.prepare('SELECT * FROM todos WHERE id=?').get(Number(id));
  syncActionLinks(tdb, row);
  return row;
}

function deleteAction(tdb, id) {
  const r = tdb.prepare('DELETE FROM todos WHERE id=?').run(Number(id));
  link.purgeEntity(tdb, 'task', id);
  return r.changes;
}

/** 行动列表：支持按目标/项目/类型/日期/完成态筛 */
function listActions(tdb, q = {}) {
  const where = [];
  const args = [];
  const eq = (col, v) => { if (v !== undefined && v !== '' && v !== null) { where.push(`${col}=?`); args.push(v); } };
  eq('goal_id', q.goal_id == null ? undefined : Number(q.goal_id));
  eq('project_id', q.project_id == null ? undefined : Number(q.project_id));
  eq('task_type', q.task_type);
  eq('main_line_date', q.main_line_date);
  if (q.due_date) { where.push('due_date=?'); args.push(q.due_date); }
  if (q.done !== undefined && q.done !== '') { where.push('done=?'); args.push(q.done === '1' || q.done === 1 || q.done === true ? 1 : 0); }
  if (q.from) { where.push('due_date>=?'); args.push(q.from); }
  if (q.to) { where.push('due_date<=?'); args.push(q.to); }
  const limit = Math.max(1, Math.min(2000, Number(q.limit) || 500));
  return tdb.prepare(
    `SELECT * FROM todos ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY done, (main_line_date IS NULL), main_line_date DESC, priority, id DESC LIMIT ?`
  ).all(...args, limit);
}

// ---------- 习惯 ----------
function listHabits(tdb, { includeArchived = false } = {}) {
  const rows = tdb.prepare(
    `SELECT * FROM life_habits ${includeArchived ? '' : 'WHERE archived=0'} ORDER BY id`
  ).all();
  return rows.map((h) => ({ ...h, id: Number(h.id) }));
}

function habitStreak(tdb, habitId, today = todayStr()) {
  const set = new Set(tdb.prepare('SELECT date FROM life_habit_logs WHERE habit_id=?').all(Number(habitId)).map((r) => r.date));
  // 今天还没打卡不该把连续天数清零（一天还没过完），所以从昨天起算
  let d = parseDate(today);
  if (!set.has(fmtDate(d))) d = addDays(d, -1);
  let n = 0;
  while (set.has(fmtDate(d))) { n++; d = addDays(d, -1); }
  return n;
}

function createHabit(tdb, b) {
  const r = tdb.prepare(
    `INSERT INTO life_habits(title,goal_id,domain_id,cadence,target_per_period) VALUES(?,?,?,?,?)`
  ).run(String(b.title || '').trim() || '未命名习惯',
    normNull(b.goal_id) ?? null, normNull(b.domain_id) ?? null,
    b.cadence || 'daily', Number(b.target_per_period) || 1);
  const id = Number(r.lastInsertRowid);
  const row = tdb.prepare('SELECT * FROM life_habits WHERE id=?').get(id);
  if (row.goal_id != null) link.link(tdb, 'habit', id, 'goal', Number(row.goal_id), 'supports');
  if (row.domain_id != null) link.link(tdb, 'habit', id, 'domain', Number(row.domain_id), 'belongs');
  return id;
}

function updateHabit(tdb, id, b) {
  const cur = tdb.prepare('SELECT * FROM life_habits WHERE id=?').get(Number(id));
  if (!cur) return null;
  tdb.prepare('UPDATE life_habits SET title=?,goal_id=?,domain_id=?,cadence=?,target_per_period=?,archived=? WHERE id=?').run(
    b.title ?? cur.title, b.goal_id === undefined ? cur.goal_id : (normNull(b.goal_id) ?? null),
    b.domain_id === undefined ? cur.domain_id : (normNull(b.domain_id) ?? null),
    b.cadence ?? cur.cadence, b.target_per_period === undefined ? cur.target_per_period : Number(b.target_per_period) || 1,
    b.archived === undefined ? cur.archived : (b.archived ? 1 : 0), Number(id));
  const row = tdb.prepare('SELECT * FROM life_habits WHERE id=?').get(Number(id));
  tdb.prepare(`DELETE FROM life_links WHERE src_type='habit' AND src_id=? AND relation IN ('supports','belongs')`).run(Number(id));
  if (row.goal_id != null) link.link(tdb, 'habit', Number(id), 'goal', Number(row.goal_id), 'supports');
  if (row.domain_id != null) link.link(tdb, 'habit', Number(id), 'domain', Number(row.domain_id), 'belongs');
  return row;
}

function deleteHabit(tdb, id) {
  tdb.prepare('DELETE FROM life_habit_logs WHERE habit_id=?').run(Number(id));
  const r = tdb.prepare('DELETE FROM life_habits WHERE id=?').run(Number(id));
  link.purgeEntity(tdb, 'habit', id);
  return r.changes;
}

/** 打卡：同一天重复点由 UNIQUE(habit_id,date) 兜底（幂等）。
 *  ⚠️ **绝不能写 `Number(count) || 1`** —— 0 是合法入参（= 撤销当天打卡），
 *  用 `||` 兜底会把「撤销」静默变成「打卡一次」，用户在界面上点取消反而多记一笔。 */
function checkHabit(tdb, habitId, date, count = 1) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : todayStr();
  const raw = Number(count);
  const c = Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 1;
  if (c === 0) { tdb.prepare('DELETE FROM life_habit_logs WHERE habit_id=? AND date=?').run(Number(habitId), d); return { date: d, count: 0 }; }
  tdb.prepare(
    `INSERT INTO life_habit_logs(habit_id,date,count) VALUES(?,?,?)
     ON CONFLICT(habit_id,date) DO UPDATE SET count=excluded.count`
  ).run(Number(habitId), d, c);
  return { date: d, count: c };
}

// ---------- 复盘 ----------
function listReviews(tdb, { type, from, to, limit = 200 } = {}) {
  const where = [];
  const args = [];
  if (type) { where.push('type=?'); args.push(type); }
  if (from) { where.push('period_key>=?'); args.push(from); }
  if (to) { where.push('period_key<=?'); args.push(to); }
  return tdb.prepare(
    `SELECT * FROM life_reviews ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY period_key DESC LIMIT ?`
  ).all(...args, Math.max(1, Math.min(1000, Number(limit) || 200)));
}

/** 写复盘：周期唯一 → 已存在就是**更新**（幂等，不用先查再插） */
function saveReview(tdb, b) {
  const type = REVIEW_TYPES.includes(b.type) ? b.type : 'week';
  const pk = b.period_key || periodKey(type, b.date);
  const exist = tdb.prepare('SELECT * FROM life_reviews WHERE type=? AND period_key=?').get(type, pk);
  if (exist) {
    tdb.prepare(
      `UPDATE life_reviews SET did_well=?,did_bad=?,learned=?,next_action=?,mood=?,alignment=?,
         updated_at=datetime('now','localtime') WHERE id=?`
    ).run(b.did_well ?? exist.did_well, b.did_bad ?? exist.did_bad, b.learned ?? exist.learned,
      b.next_action ?? exist.next_action,
      b.mood === undefined ? exist.mood : (b.mood === null || b.mood === '' ? null : Number(b.mood)),
      b.alignment === undefined ? exist.alignment : (b.alignment === null || b.alignment === '' ? null : Number(b.alignment)),
      Number(exist.id));
    return { id: Number(exist.id), created: false, period_key: pk };
  }
  const r = tdb.prepare(
    `INSERT INTO life_reviews(type,period_key,did_well,did_bad,learned,next_action,mood,alignment) VALUES(?,?,?,?,?,?,?,?)`
  ).run(type, pk, b.did_well || '', b.did_bad || '', b.learned || '', b.next_action || '',
    b.mood === null || b.mood === '' || b.mood === undefined ? null : Number(b.mood),
    b.alignment === null || b.alignment === '' || b.alignment === undefined ? null : Number(b.alignment));
  return { id: Number(r.lastInsertRowid), created: true, period_key: pk };
}

/**
 * 「下一步动作」沉淀为 SOP —— 原文「复盘再把结果沉淀成经验和 SOP」的那一步。
 * 同时把复盘→SOP 的边写进关系引擎，让这条因果可追溯。
 */
function reviewToSop(tdb, reviewId, b = {}) {
  const rv = tdb.prepare('SELECT * FROM life_reviews WHERE id=?').get(Number(reviewId));
  if (!rv) return null;
  const LBL = { day: '日', week: '周', month: '月', quarter: '季', year: '年' };
  const sid = createSop(tdb, {
    scenario: b.scenario || `${LBL[rv.type] || ''}复盘沉淀 ${rv.period_key}`,
    steps: b.steps || rv.next_action || '',
  });
  link.link(tdb, 'sop', sid, 'review', Number(reviewId), 'derives');
  return sid;
}

// ---------- 项目 ----------
function listProjects(tdb, { status, goal_id, domain_id, category } = {}) {
  const where = [];
  const args = [];
  const eq = (c, v) => { if (v !== undefined && v !== '' && v !== null) { where.push(`${c}=?`); args.push(v); } };
  eq('status', status); eq('category', category);
  eq('goal_id', goal_id == null ? undefined : Number(goal_id));
  eq('domain_id', domain_id == null ? undefined : Number(domain_id));
  return tdb.prepare(
    `SELECT * FROM life_projects ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY status, id DESC`
  ).all(...args);
}

function syncProjectLinks(tdb, row) {
  const id = Number(row.id);
  tdb.prepare(`DELETE FROM life_links WHERE src_type='project' AND src_id=? AND relation IN ('supports','belongs')`).run(id);
  if (row.goal_id != null) link.link(tdb, 'project', id, 'goal', Number(row.goal_id), 'supports');
  if (row.domain_id != null) link.link(tdb, 'project', id, 'domain', Number(row.domain_id), 'belongs');
}

function createProject(tdb, b) {
  const r = tdb.prepare(
    `INSERT INTO life_projects(title,category,goal_id,domain_id,status,period_key,due_date,description)
     VALUES(?,?,?,?,?,?,?,?)`
  ).run(String(b.title || '').trim() || '未命名项目', b.category || 'work',
    normNull(b.goal_id) ?? null, normNull(b.domain_id) ?? null, b.status || 'active',
    b.period_key || '', b.due_date || null, b.description || '');
  const id = Number(r.lastInsertRowid);
  syncProjectLinks(tdb, tdb.prepare('SELECT * FROM life_projects WHERE id=?').get(id));
  return id;
}

function updateProject(tdb, id, b) {
  const cur = tdb.prepare('SELECT * FROM life_projects WHERE id=?').get(Number(id));
  if (!cur) return null;
  tdb.prepare(
    `UPDATE life_projects SET title=?,category=?,goal_id=?,domain_id=?,status=?,period_key=?,due_date=?,
       description=?,updated_at=datetime('now','localtime') WHERE id=?`
  ).run(b.title ?? cur.title, b.category ?? cur.category,
    b.goal_id === undefined ? cur.goal_id : (normNull(b.goal_id) ?? null),
    b.domain_id === undefined ? cur.domain_id : (normNull(b.domain_id) ?? null),
    b.status ?? cur.status, b.period_key ?? cur.period_key,
    b.due_date !== undefined ? (b.due_date || null) : cur.due_date,
    b.description ?? cur.description, Number(id));
  const row = tdb.prepare('SELECT * FROM life_projects WHERE id=?').get(Number(id));
  syncProjectLinks(tdb, row);
  return row;
}

function deleteProject(tdb, id) {
  // 项目下的任务不删，只解绑（照删目标的做法）
  tdb.prepare('UPDATE todos SET project_id=NULL WHERE project_id=?').run(Number(id));
  const r = tdb.prepare('DELETE FROM life_projects WHERE id=?').run(Number(id));
  link.purgeEntity(tdb, 'project', id);
  return r.changes;
}

// ---------- SOP ----------
function listSops(tdb, { domain_id, includeArchived = false } = {}) {
  const where = [];
  const args = [];
  if (domain_id != null && domain_id !== '') { where.push('domain_id=?'); args.push(Number(domain_id)); }
  if (!includeArchived) where.push('archived=0');
  return tdb.prepare(
    `SELECT * FROM life_sops ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY last_used_at DESC, id DESC`
  ).all(...args);
}

function createSop(tdb, b) {
  const r = tdb.prepare(
    `INSERT INTO life_sops(scenario,steps,source_review_id,ai_prompt,domain_id) VALUES(?,?,?,?,?)`
  ).run(String(b.scenario || '').trim() || '未命名 SOP', b.steps || '',
    normNull(b.source_review_id) ?? null, b.ai_prompt || '', normNull(b.domain_id) ?? null);
  return Number(r.lastInsertRowid);
}

function updateSop(tdb, id, b) {
  const cur = tdb.prepare('SELECT * FROM life_sops WHERE id=?').get(Number(id));
  if (!cur) return null;
  tdb.prepare('UPDATE life_sops SET scenario=?,steps=?,ai_prompt=?,domain_id=?,archived=? WHERE id=?').run(
    b.scenario ?? cur.scenario, b.steps ?? cur.steps, b.ai_prompt ?? cur.ai_prompt,
    b.domain_id === undefined ? cur.domain_id : (normNull(b.domain_id) ?? null),
    b.archived === undefined ? cur.archived : (b.archived ? 1 : 0), Number(id));
  return tdb.prepare('SELECT * FROM life_sops WHERE id=?').get(Number(id));
}

function deleteSop(tdb, id) {
  const r = tdb.prepare('DELETE FROM life_sops WHERE id=?').run(Number(id));
  link.purgeEntity(tdb, 'sop', id);
  return r.changes;
}

/** 「用一次」：计数 + 记最后使用时间，让 SOP 真的被复用（原文的意图） */
function useSop(tdb, id) {
  const r = tdb.prepare(
    `UPDATE life_sops SET use_count=use_count+1, last_used_at=datetime('now','localtime') WHERE id=?`
  ).run(Number(id));
  if (!r.changes) return null;
  return tdb.prepare('SELECT * FROM life_sops WHERE id=?').get(Number(id));
}

// ---------- 领域 ----------
function listDomains(tdb, { includeArchived = false } = {}) {
  return tdb.prepare(
    `SELECT * FROM life_domains ${includeArchived ? '' : 'WHERE archived=0'} ORDER BY sort_order, id`
  ).all().map((d) => ({ ...d, id: Number(d.id) }));
}

/** 领域概览：该领域下的目标/项目/习惯数 + 目标平均进度（原文的「领域健康度」最小可用版） */
function domainOverview(tdb, id) {
  const dom = tdb.prepare('SELECT * FROM life_domains WHERE id=?').get(Number(id));
  if (!dom) return null;
  const goals = tdb.prepare('SELECT * FROM life_goals WHERE domain_id=? AND status<>? ORDER BY sort_order, id')
    .all(Number(id), 'archived');
  const prog = progressMap(tdb, goals);
  const vals = goals.map((g) => prog.get(Number(g.id))).filter((v) => v != null);
  return {
    ...dom, id: Number(dom.id),
    goals: goals.map((g) => ({ ...g, id: Number(g.id), progress: prog.get(Number(g.id)) ?? null })),
    avg_progress: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
    projects: tdb.prepare('SELECT COUNT(*) c FROM life_projects WHERE domain_id=?').get(Number(id)).c,
    habits: tdb.prepare('SELECT COUNT(*) c FROM life_habits WHERE domain_id=? AND archived=0').get(Number(id)).c,
    sops: tdb.prepare('SELECT COUNT(*) c FROM life_sops WHERE domain_id=? AND archived=0').get(Number(id)).c,
  };
}

// ---------- 今日 / 仪表盘 ----------
/**
 * 今日：主线任务 + 今日到期 + 习惯打卡态 + 该写还没写的复盘。
 * 这是原文「每天从这里出发，又反哺到这里」的入口。
 */
function today(tdb, date) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? date : todayStr();
  const mainline = tdb.prepare(
    'SELECT * FROM todos WHERE main_line_date=? ORDER BY done, priority, id'
  ).all(d);
  const due = tdb.prepare(
    `SELECT * FROM todos WHERE done=0 AND due_date=? AND (main_line_date IS NULL OR main_line_date<>?)
     ORDER BY priority, id`
  ).all(d, d);
  const habits = listHabits(tdb).map((h) => {
    const log = tdb.prepare('SELECT count FROM life_habit_logs WHERE habit_id=? AND date=?').get(h.id, d);
    return { ...h, today_count: log ? Number(log.count) : 0, done: !!log, streak: habitStreak(tdb, h.id, d) };
  });
  // 该写还没写的复盘：日复盘看今天，周复盘看本周 —— 只提示最近一级
  const weekKey = periodKey('week', d);
  const hasWeek = !!tdb.prepare("SELECT id FROM life_reviews WHERE type='week' AND period_key=?").get(weekKey);
  const hasDay = !!tdb.prepare("SELECT id FROM life_reviews WHERE type='day' AND period_key=?").get(d);
  const keyGoals = tdb.prepare("SELECT * FROM life_goals WHERE is_key=1 AND status='active' ORDER BY sort_order, id LIMIT 5").all();
  const prog = progressMap(tdb, keyGoals);
  return {
    date: d,
    mainline: mainline.map((t) => ({ ...t, id: Number(t.id) })),
    due: due.map((t) => ({ ...t, id: Number(t.id) })),
    habits,
    review_due: !hasDay ? 'day' : (!hasWeek ? 'week' : null),
    review_week_key: weekKey,
    key_goals: keyGoals.map((g) => ({ ...g, id: Number(g.id), progress: prog.get(Number(g.id)) ?? null })),
  };
}

/** 仪表盘聚合（原文「一个清晰的仪表盘」）：目标推进 + 行动 + 复利曲线 */
function dashboard(tdb, { days = 30 } = {}) {
  const goals = tdb.prepare("SELECT * FROM life_goals WHERE status='active'").all();
  const prog = progressMap(tdb, goals);
  const vals = goals.map((g) => prog.get(Number(g.id))).filter((v) => v != null);
  const openTodos = tdb.prepare('SELECT COUNT(*) c FROM todos WHERE done=0').get().c;
  const habits = listHabits(tdb);
  const checkedToday = tdb.prepare(
    'SELECT COUNT(*) c FROM life_habit_logs WHERE date=? AND habit_id IN (SELECT id FROM life_habits WHERE archived=0)'
  ).get(todayStr()).c;
  // 复利曲线：近 N 天每天的笔记数与行动完成数（两个最直观的「每天在积累」信号）
  const notesByDay = tdb.prepare(
    `SELECT substr(created_at,1,10) d, COUNT(*) c FROM notes
     WHERE created_at >= date('now','localtime',?) GROUP BY d ORDER BY d`
  ).all(`-${Number(days) || 30} days`);
  return {
    goals_total: goals.length,
    goals_avg_progress: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
    key_goals: goals.filter((g) => g.is_key).map((g) => ({ id: Number(g.id), title: g.title, progress: prog.get(Number(g.id)) ?? null })),
    open_todos: openTodos,
    habits_total: habits.length,
    habits_checked_today: checkedToday,
    domains: listDomains(tdb).length,
    reviews_total: tdb.prepare('SELECT COUNT(*) c FROM life_reviews').get().c,
    sops_total: tdb.prepare('SELECT COUNT(*) c FROM life_sops WHERE archived=0').get().c,
    links_total: tdb.prepare('SELECT COUNT(*) c FROM life_links').get().c,
    notes_by_day: notesByDay.map((r) => ({ date: r.d, count: Number(r.c) })),
  };
}

module.exports = {
  p2, fmtDate, todayStr, addDays, parseDate, isoWeekKey, periodKey, REVIEW_TYPES,
  calcProgress, progressMap, hasKrTarget,
  goalTree, goalDetail, createGoal, updateGoal, deleteGoal, goalSubtreeIds, goalRow, krsOf,
  createKr, updateKr, deleteKr,
  createAction, updateAction, deleteAction, listActions,
  listHabits, createHabit, updateHabit, deleteHabit, checkHabit, habitStreak,
  listReviews, saveReview, reviewToSop,
  listProjects, createProject, updateProject, deleteProject,
  listSops, createSop, updateSop, deleteSop, useSop,
  listDomains, domainOverview,
  today, dashboard,
};
