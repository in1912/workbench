// 人生管理系统 API（v1.10.0）——**本模块独占 `/api/life/*`，不再往 core.js 里加任何人生相关端点**。
//
// 为什么全部收在一个前缀下：auth.js 的 pageForPath 是按前缀映射页面的，
// 前缀越少，权限就越不容易漏（漏了 = 静默降级成「仅需登录」）。这里只要一行 `p.startsWith('/life')`。
//
// 注册顺序的硬规矩（Express 会把静态段当参数吞掉）：
//   `/life/goals` 必须排在 `/life/goals/:id` 之前；`/life/links` 排在 `/life/links/of/...` 之前。
const express = require('express');
const svc = require('../services/lifeService');
const link = require('../services/lifeLinkService');
const imReview = require('../services/lifeImReviewService');

const router = express.Router();

// 数字参数解析：非法输入一律 400，别让它变成 NaN 溜进 SQL 变成「查不到」这种静默失败
function int(v, field = 'id') {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    const e = new Error(`${field} 必须是整数`);
    e.code = 400;
    throw e;
  }
  return n;
}

// 统一的处理包装：服务层抛的 {code:400} 变成 400，其余记日志并 500
// v1.10.5：补 409 通道（删领域时「里面还有东西」用，带 counts / can_force 给前端弹确认）
// v1.10.29：补 async 通道（AI复盘IM 的 preview 要等 AI 返回）——handler 返回 Promise 时
// 拒绝也走同一个错误映射；同步 handler（原有全部）行为一字不变。
function ok(fn) {
  const fail = (res, e) => {
    if (res.headersSent) return;
    if (e && e.code === 400) return res.status(400).json({ error: e.message });
    if (e && e.code === 404) return res.status(404).json({ error: e.message });
    if (e && e.code === 409) {
      return res.status(409).json({
        error: e.message,
        ...(e.counts ? { counts: e.counts } : {}),
        ...(e.canForce ? { can_force: true } : {}),
      });
    }
    console.error('[life]', req.method, req.originalUrl, e);
    res.status(500).json({ error: '服务端错误：' + (e && e.message ? e.message : '未知') });
  };
  return (req, res) => {
    try {
      const pr = fn(req, res);
      if (pr && typeof pr.catch === 'function') pr.catch((e) => fail(res, e));
    } catch (e) {
      fail(res, e);
    }
  };
}

// 删除实体前先确认存在，返回 404 而不是静默 200（否则前端以为删掉了）
function mustExist(tdb, sql, id, label) {
  const row = tdb.prepare(sql).get(id);
  if (!row) { const e = new Error(`${label}不存在`); e.code = 404; throw e; }
  return row;
}

const notFound = (res, label = '对象') => res.status(404).json({ error: `${label}不存在` });

// ---------- 元数据（前端下拉框的选项来源，别在前端硬编码） ----------
router.get('/life/meta', ok((req, res) => {
  res.json({
    levels: [
      { key: 'vision', label: '愿景' }, { key: 'year', label: '年度' },
      { key: 'quarter', label: '季度' }, { key: 'month', label: '月度' },
    ],
    review_types: [
      { key: 'day', label: '日复盘' }, { key: 'week', label: '周复盘' },
      { key: 'month', label: '月复盘' }, { key: 'quarter', label: '季复盘' }, { key: 'year', label: '年复盘' },
    ],
    task_types: [
      { key: 'daily_todo', label: '日常待办' }, { key: 'main_line', label: '主线任务' },
      { key: 'project_task', label: '项目任务' },
    ],
    project_categories: [
      { key: 'work', label: '工作' }, { key: 'side_business', label: '副业' },
      { key: 'content', label: '内容' }, { key: 'product', label: '产品' }, { key: 'delivery', label: '交付' },
    ],
    habit_cadences: [
      { key: 'daily', label: '每天' }, { key: 'weekly', label: '每周' }, { key: 'monthly', label: '每月' },
    ],
    entity_types: link.TYPES,
    relations: link.RELATIONS.map((r) => ({ key: r, label: link.RELATION_LABEL[r] })),
    client_date: svc.todayStr(),
  });
}));

// ---------- 今日 / 仪表盘 ----------
router.get('/life/today', ok((req, res) => res.json(svc.today(req.tdb, req.query.date))));
router.get('/life/dashboard', ok((req, res) =>
  res.json(svc.dashboard(req.tdb, { days: Number(req.query.days) || 30 }))));

// ---------- 领域 ----------
router.get('/life/domains', ok((req, res) =>
  res.json(svc.listDomains(req.tdb, { includeArchived: req.query.archived === '1' }))));
router.get('/life/domains/:id', ok((req, res) => {
  const d = svc.domainOverview(req.tdb, int(req.params.id));
  if (!d) return notFound(res, '领域');
  res.json(d);
}));
// 领域增删改（v1.10.5，需求⑩）。删除的两道闸写在 svc.deleteDomain 里：
// 有未归档目标 → 409（force 也不行）；项目/习惯/SOP 挂着 → 409 报数，?force=1 才解引用。
router.post('/life/domains', ok((req, res) =>
  res.json({ id: svc.createDomain(req.tdb, req.body || {}) })));
router.put('/life/domains/:id', ok((req, res) => {
  const d = svc.updateDomain(req.tdb, int(req.params.id), req.body || {});
  if (!d) return notFound(res, '领域');
  res.json(d);
}));
router.delete('/life/domains/:id', ok((req, res) => {
  const r = svc.deleteDomain(req.tdb, int(req.params.id), { force: req.query.force === '1' });
  if (!r) return notFound(res, '领域');
  res.json({ ok: true, ...r });
}));

// ---------- 目标 ----------
router.get('/life/goals', ok((req, res) => {
  const { level, domain_id, status, parent_id } = req.query;
  res.json(svc.goalTree(req.tdb, { level, domain_id, status, parent_id }));
}));
router.post('/life/goals', ok((req, res) =>
  res.json({ id: svc.createGoal(req.tdb, req.body || {}) })));
router.get('/life/goals/:id', ok((req, res) => {
  const g = svc.goalDetail(req.tdb, int(req.params.id));
  if (!g) return notFound(res, '目标');
  res.json(g);
}));
router.put('/life/goals/:id', ok((req, res) => {
  const g = svc.updateGoal(req.tdb, int(req.params.id), req.body || {});
  if (!g) return notFound(res, '目标');
  res.json(g);
}));
// 删目标 = 连同子目标一起删（子树），但**不删**挂在它下面的行动/项目/习惯，只解绑
router.delete('/life/goals/:id', ok((req, res) =>
  res.json({ removed: svc.deleteGoal(req.tdb, int(req.params.id)) })));

// KR
router.post('/life/goals/:id/krs', ok((req, res) => {
  const id = svc.createKr(req.tdb, int(req.params.id), req.body || {});
  if (!id) return notFound(res, '目标');
  res.json({ id });
}));
router.put('/life/krs/:id', ok((req, res) => {
  const k = svc.updateKr(req.tdb, int(req.params.id), req.body || {});
  if (!k) return notFound(res, '关键结果');
  res.json(k);
}));
router.delete('/life/krs/:id', ok((req, res) =>
  res.json({ removed: svc.deleteKr(req.tdb, int(req.params.id)) })));

// ---------- 行动（底层就是 todos） ----------
router.get('/life/actions', ok((req, res) => res.json(svc.listActions(req.tdb, req.query))));
router.post('/life/actions', ok((req, res) =>
  res.json({ id: svc.createAction(req.tdb, req.body || {}) })));
router.put('/life/actions/:id', ok((req, res) => {
  const a = svc.updateAction(req.tdb, int(req.params.id), req.body || {});
  if (!a) return notFound(res, '行动');
  res.json(a);
}));
router.delete('/life/actions/:id', ok((req, res) =>
  res.json({ removed: svc.deleteAction(req.tdb, int(req.params.id)) })));

// ---------- 习惯 ----------
router.get('/life/habits', ok((req, res) => {
  const list = svc.listHabits(req.tdb, { includeArchived: req.query.archived === '1' });
  const today = svc.todayStr();
  res.json(list.map((h) => {
    const log = req.tdb.prepare('SELECT count FROM life_habit_logs WHERE habit_id=? AND date=?').get(h.id, today);
    return { ...h, today_count: log ? Number(log.count) : 0, streak: svc.habitStreak(req.tdb, h.id, today) };
  }));
}));
router.post('/life/habits', ok((req, res) =>
  res.json({ id: svc.createHabit(req.tdb, req.body || {}) })));
router.put('/life/habits/:id', ok((req, res) => {
  const h = svc.updateHabit(req.tdb, int(req.params.id), req.body || {});
  if (!h) return notFound(res, '习惯');
  res.json(h);
}));
router.delete('/life/habits/:id', ok((req, res) =>
  res.json({ removed: svc.deleteHabit(req.tdb, int(req.params.id)) })));
// 打卡（幂等：同一天重复点只更新计数；count=0 表示撤销当天打卡）
router.post('/life/habits/:id/check', ok((req, res) => {
  const id = int(req.params.id);
  mustExist(req.tdb, 'SELECT id FROM life_habits WHERE id=?', id, '习惯');
  const { date, count } = req.body || {};
  res.json(svc.checkHabit(req.tdb, id, date, count == null ? 1 : count));
}));

// ---------- 复盘 ----------
router.get('/life/reviews', ok((req, res) => res.json(svc.listReviews(req.tdb, req.query))));
router.post('/life/reviews', ok((req, res) => res.json(svc.saveReview(req.tdb, req.body || {}))));
router.delete('/life/reviews/:id', ok((req, res) => {
  const id = int(req.params.id);
  mustExist(req.tdb, 'SELECT id FROM life_reviews WHERE id=?', id, '复盘');
  req.tdb.prepare('DELETE FROM life_reviews WHERE id=?').run(id);
  link.purgeEntity(req.tdb, 'review', id);
  res.json({ removed: 1 });
}));
// 「下一步动作」沉淀成 SOP（复盘 → SOP 的可追溯链条）
router.post('/life/reviews/:id/to-sop', ok((req, res) => {
  const sid = svc.reviewToSop(req.tdb, int(req.params.id), req.body || {});
  if (!sid) return notFound(res, '复盘');
  res.json({ id: sid });
}));

// ---------- 项目 ----------
router.get('/life/projects', ok((req, res) => res.json(svc.listProjects(req.tdb, req.query))));
router.post('/life/projects', ok((req, res) =>
  res.json({ id: svc.createProject(req.tdb, req.body || {}) })));
router.put('/life/projects/:id', ok((req, res) => {
  const p = svc.updateProject(req.tdb, int(req.params.id), req.body || {});
  if (!p) return notFound(res, '项目');
  res.json(p);
}));
router.delete('/life/projects/:id', ok((req, res) =>
  res.json({ removed: svc.deleteProject(req.tdb, int(req.params.id)) })));

// ---------- SOP ----------
router.get('/life/sops', ok((req, res) =>
  res.json(svc.listSops(req.tdb, { domain_id: req.query.domain_id, includeArchived: req.query.archived === '1' }))));
router.post('/life/sops', ok((req, res) =>
  res.json({ id: svc.createSop(req.tdb, req.body || {}) })));
router.put('/life/sops/:id', ok((req, res) => {
  const s = svc.updateSop(req.tdb, int(req.params.id), req.body || {});
  if (!s) return notFound(res, 'SOP');
  res.json(s);
}));
router.delete('/life/sops/:id', ok((req, res) =>
  res.json({ removed: svc.deleteSop(req.tdb, int(req.params.id)) })));
router.post('/life/sops/:id/use', ok((req, res) => {
  const s = svc.useSop(req.tdb, int(req.params.id));
  if (!s) return notFound(res, 'SOP');
  res.json(s);
}));

// ---------- AI复盘IM（v1.10.29 起；v1.10.30 改后台任务模型） ----------
// 静态段注册在 /life/links 之前不冲突（前缀 im-review 无 :id 争抢）。
// v1.10.30：生成改后台任务——POST /jobs 立即回任务号（AI 真实耗时可达数分钟，同步 POST
// 会被前端 180s / 网关 ~100s 超时腰斩成「网络连接失败」）；GET jobs/latest 轮询拿快照
// （重进页面恢复进度），DELETE 取消。ok() 的 async 通道保留（历史 handler 可能用）。
router.get('/life/im-review/meta', ok((req, res) => res.json(imReview.meta(req.tdb))));
router.get('/life/im-review/folders', ok((req, res) => res.json(imReview.listImFolders(req.tdb))));
router.post('/life/im-review/jobs', ok((req, res) =>
  res.json(imReview.startJob(req.tdb, String(req.user.id), req.body || {}))));
router.get('/life/im-review/jobs/latest', ok((req, res) =>
  res.json(imReview.getJob(String(req.user.id)))));
router.delete('/life/im-review/jobs/latest', ok((req, res) =>
  res.json(imReview.cancelJob(String(req.user.id)))));
router.post('/life/im-review/todos', ok((req, res) =>
  res.json(imReview.createTodos(req.tdb, req.body || {}))));

// ---------- 关系引擎 ----------
// 静态段必须排在 `/life/links/of/...` 之前
router.get('/life/links', ok((req, res) => {
  const types = req.query.types ? String(req.query.types).split(',').filter(Boolean) : null;
  res.json(link.graph(req.tdb, { types, max: Number(req.query.max) || 800 }));
}));
router.get('/life/links/of/:type/:id', ok((req, res) => {
  if (!link.isType(req.params.type)) return res.status(400).json({ error: '未知实体类型' });
  res.json(link.linksOf(req.tdb, req.params.type, int(req.params.id)));
}));
router.get('/life/links/neighbors/:type/:id', ok((req, res) => {
  if (!link.isType(req.params.type)) return res.status(400).json({ error: '未知实体类型' });
  res.json(link.neighbors(req.tdb, req.params.type, int(req.params.id)));
}));
router.post('/life/links', ok((req, res) => {
  const { src_type, src_id, dst_type, dst_id, relation, note } = req.body || {};
  link.link(req.tdb, src_type, int(src_id, 'src_id'), dst_type, int(dst_id, 'dst_id'), relation || 'relates', note);
  res.json({ ok: true });
}));
router.delete('/life/links/:id', ok((req, res) => {
  const id = int(req.params.id);
  const row = req.tdb.prepare('SELECT * FROM life_links WHERE id=?').get(id);
  if (!row) return notFound(res, '关联');
  link.unlink(req.tdb, row.src_type, row.src_id, row.dst_type, row.dst_id, row.relation);
  res.json({ removed: 1 });
}));

module.exports = router;
