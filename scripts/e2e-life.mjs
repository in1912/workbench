// E2E（v1.10.0）：人生管理系统后端全链路。
//
// 覆盖：周期键跨年 / KR 加权进度与 target=0 跳过 / 目标树进度自下而上 /
//       行动挂目标（todos 复用 + 自动建边）/ 习惯打卡幂等与连续天数 /
//       复盘周期唯一（重复提交是更新不是插新行）/ 复盘→SOP 沉淀 /
//       项目删除解绑任务 / 删目标树连带清边且不删行动 / 关系引擎图 / 权限 403。
//
// 隔离跑：独立 PORT + 独立 DATA_DIR，跑完即删；只按本次创建的 id 精确删，绝不整表 DELETE。
import svc from '../server/services/lifeService.js';
import { startServer, login, api, checker, j } from './_noteE2E.mjs';

const { ck, done } = checker();
const srv = await startServer({ tag: 'life', port: 3971 });
const { B } = srv;

try {
  const admin = await login(B, 'admin', 'test123456');
  const A = api(B, admin.H);

  // ---------- 0. 纯函数：周期键（跨年 ISO 周是设计档案点名要正确处理的地方） ----------
  ck('ISO 周 2026-01-01 = 2026-W01', svc.isoWeekKey(new Date(2026, 0, 1)) === '2026-W01', svc.isoWeekKey(new Date(2026, 0, 1)));
  ck('ISO 周 2027-01-01 归到上一年的 2026-W53', svc.isoWeekKey(new Date(2027, 0, 1)) === '2026-W53', svc.isoWeekKey(new Date(2027, 0, 1)));
  ck('periodKey week 与 isoWeekKey 一致', svc.periodKey('week', '2027-01-01') === '2026-W53');
  ck('periodKey quarter', svc.periodKey('quarter', '2026-10-05') === '2026Q4', svc.periodKey('quarter', '2026-10-05'));
  ck('periodKey month', svc.periodKey('month', '2026-10-05') === '2026-10');
  ck('periodKey day', svc.periodKey('day', '2026-10-05') === '2026-10-05');
  // target<=0 必须跳过而不是算出 NaN/Infinity
  ck('calcProgress 跳过 target=0（无 NaN）',
    (() => { const v = svc.calcProgress([{ target: 0, current: 5 }, { target: 10, current: 5 }]); return v === 0.5; })(),
    String(svc.calcProgress([{ target: 0, current: 5 }, { target: 10, current: 5 }])));
  ck('calcProgress 全为 0 目标时返回 0', svc.calcProgress([{ target: 0, current: 1 }]) === 0);
  ck('calcProgress 权重生效', svc.calcProgress([{ target: 10, current: 10, weight: 3 }, { target: 10, current: 0, weight: 1 }]) === 0.75);

  // ---------- 1. 元数据 + 领域种子 ----------
  let r = await A.get('/life/meta');
  ck('GET /life/meta 200 且含 levels/review_types', r.status === 200 && Array.isArray(r.body.levels) && Array.isArray(r.body.review_types), JSON.stringify(r.body).slice(0, 120));
  ck('meta 里实体类型含 goal/task/note', ['goal', 'task', 'note'].every((t) => r.body.entity_types.includes(t)), JSON.stringify(r.body.entity_types));
  r = await A.get('/life/domains');
  ck('GET /life/domains 返回 6 条种子领域', r.status === 200 && r.body.length === 6, `len=${r.body && r.body.length}`);
  const domainId = r.body[0].id;

  // ---------- 2. 目标 + KR 进度 ----------
  r = await A.post('/life/goals', { title: 'E2E 年度目标', level: 'year', domain_id: domainId, is_key: 1 });
  const yearGoal = r.body.id;
  ck('POST /life/goals 建年度目标', r.status === 200 && yearGoal > 0, JSON.stringify(r.body));

  r = await A.post(`/life/goals/${yearGoal}/krs`, { title: 'KR-完成度', target: 100, current: 40, unit: '%', weight: 2 });
  const kr1 = r.body.id;
  r = await A.post(`/life/goals/${yearGoal}/krs`, { title: 'KR-无目标值', target: 0, current: 9, weight: 99 });
  const kr2 = r.body.id;
  ck('POST /life/goals/:id/krs ×2', kr1 > 0 && kr2 > 0);

  r = await A.get(`/life/goals/${yearGoal}`);
  ck('目标详情进度 = 0.4（target=0 的 KR 被跳过，不吃掉权重）', Math.abs(r.body.progress - 0.4) < 1e-9, String(r.body.progress));
  ck('目标详情带 KR 列表 2 条', r.body.krs.length === 2, String(r.body.krs.length));
  ck('目标自动建了 belongs→领域 的边', r.body.links.out.some((e) => e.other.type === 'domain'), JSON.stringify(r.body.links.out));

  // 子目标 → 父目标进度取自子目标平均
  r = await A.post('/life/goals', { title: 'E2E 月度子目标', level: 'month', parent_id: yearGoal, domain_id: domainId });
  const childGoal = r.body.id;
  await A.post(`/life/goals/${childGoal}/krs`, { title: '子KR', target: 4, current: 3 }); // 0.75
  r = await A.get(`/life/goals/${yearGoal}`);
  // 规则：目标自己有量化 KR 时，进度**以 KR 为准**，不被子目标均值覆盖
  //（显式度量优先于派生均值；否则上面挂了 KPI 的目标会被下面的拆解"稀释"掉）
  ck('父目标有自己的 KR 时进度仍 = 0.4（KR 优先于子目标均值）', Math.abs(r.body.progress - 0.4) < 1e-9, String(r.body.progress));
  ck('父目标的 derives→子目标 边存在', r.body.links.out.some((e) => e.relation === 'derives' && e.other.type === 'goal'), JSON.stringify(r.body.links.out.map((e) => e.relation)));

  // 反过来：自己没有任何量化 KR 的父目标，进度取子目标均值（自下而上）
  r = await A.post('/life/goals', { title: 'E2E 无KR父目标', level: 'quarter' });
  const bareParent = r.body.id;
  await A.post('/life/goals', { title: 'E2E 无KR父目标的子', level: 'month', parent_id: bareParent });
  // /life/goals?parent_id=X 返回以 X 为根的一棵子树，子节点在 children 里
  const bareChild = (await A.get(`/life/goals?parent_id=${bareParent}`)).body[0].children[0].id;
  await A.post(`/life/goals/${bareChild}/krs`, { title: '子KR', target: 8, current: 6 }); // 0.75
  r = await A.get(`/life/goals/${bareParent}`);
  ck('无 KR 的父目标进度 = 子目标均值 0.75', Math.abs(r.body.progress - 0.75) < 1e-9, String(r.body.progress));
  // 叶子目标且无 KR：进度为 null（「未量化」），不是 0 —— 0 会被误读成「毫无进展」
  r = await A.get(`/life/goals/${bareChild}`);
  const leaf = await A.post('/life/goals', { title: 'E2E 光杆叶子', level: 'month' });
  r = await A.get(`/life/goals/${leaf.body.id}`);
  ck('既无 KR 又无子目标的叶子目标 progress=null', r.body.progress === null, String(r.body.progress));
  await A.del(`/life/goals/${bareParent}`);
  await A.del(`/life/goals/${leaf.body.id}`);
  ck('删掉临时目标后只剩余年目标+子目标', (await A.get('/life/goals')).body.length === 1, JSON.stringify((await A.get('/life/goals')).body.map((g) => g.id)));

  r = await A.get(`/life/goals?domain_id=${domainId}`);
  ck('目标树按领域筛出根节点', r.status === 200 && r.body.some((g) => g.id === yearGoal), JSON.stringify(r.body.map((g) => g.id)));

  // ---------- 3. 行动（复用 todos，不新表） ----------
  r = await A.post('/life/actions', { title: 'E2E 主线行动', task_type: 'main_line', goal_id: childGoal, main_line_date: svc.todayStr(), estimate_min: 30 });
  const actId = r.body.id;
  ck('POST /life/actions 建行动', r.status === 200 && actId > 0, JSON.stringify(r.body));
  r = await A.get(`/life/actions?goal_id=${childGoal}`);
  ck('行动按目标筛出 1 条', r.body.length === 1 && r.body[0].id === actId, JSON.stringify(r.body.map((x) => x.id)));
  ck('行动带上了 task_type/main_line_date', r.body[0].task_type === 'main_line' && r.body[0].main_line_date === svc.todayStr(), JSON.stringify(r.body[0]));

  r = await A.get(`/life/goals/${childGoal}`);
  ck('目标详情里带回挂在它下面的行动', r.body.actions.some((a) => a.id === actId), JSON.stringify(r.body.actions.map((a) => a.id)));
  ck('行动自动生成 supports→目标 的边', r.body.links.in.some((e) => e.other.type === 'task' && e.relation === 'supports'), JSON.stringify(r.body.links.in));

  r = await A.get('/life/today');
  ck('GET /life/today 主线里含刚建的行动', r.body.mainline.some((t) => t.id === actId), JSON.stringify(r.body.mainline.map((t) => t.id)));
  ck('today 返回 review_due 提示', ['day', 'week', null].includes(r.body.review_due), String(r.body.review_due));

  r = await A.put(`/life/actions/${actId}`, { done: 1, actual_min: 25 });
  ck('PUT /life/actions 标记完成 + 回填实际用时', r.body.done === 1 && r.body.actual_min === 25, JSON.stringify({ d: r.body.done, a: r.body.actual_min }));
  ck('改完成态不影响 goal_id 绑定', r.body.goal_id === childGoal, String(r.body.goal_id));

  // ---------- 4. 习惯 ----------
  r = await A.post('/life/habits', { title: 'E2E 习惯-晨跑', goal_id: yearGoal, cadence: 'daily' });
  const habitId = r.body.id;
  ck('POST /life/habits', r.status === 200 && habitId > 0, JSON.stringify(r.body));
  r = await A.post(`/life/habits/${habitId}/check`, {});
  ck('首次打卡 count=1', r.body.count === 1, JSON.stringify(r.body));
  r = await A.post(`/life/habits/${habitId}/check`, {}); // 同日重复点：幂等，不是新增行
  ck('同日重复打卡仍是 1（UNIQUE 兜底幂等）', r.body.count === 1, JSON.stringify(r.body));
  r = await A.post(`/life/habits/${habitId}/check`, { count: 3 });
  ck('改计数为 3', r.body.count === 3, JSON.stringify(r.body));
  r = await A.get('/life/habits');
  const h = r.body.find((x) => x.id === habitId);
  ck('习惯列表带 today_count=3 且 streak=1', h.today_count === 3 && h.streak === 1, JSON.stringify(h));
  r = await A.post(`/life/habits/${habitId}/check`, { count: 0 });
  ck('count=0 撤销当天打卡', r.body.count === 0, JSON.stringify(r.body));
  r = await A.get('/life/habits');
  ck('撤销后 today_count=0', r.body.find((x) => x.id === habitId).today_count === 0);

  // ---------- 5. 复盘：周期唯一 + 沉淀 SOP ----------
  r = await A.post('/life/reviews', { type: 'week', period_key: '2026-W41', did_well: 'A', next_action: '每天写 30 分钟' });
  const revId = r.body.id;
  ck('POST /life/reviews 首次 created=true', r.body.created === true, JSON.stringify(r.body));
  r = await A.post('/life/reviews', { type: 'week', period_key: '2026-W41', did_well: 'A+', learned: 'B' });
  ck('同周期重复提交是更新（同一 id，created=false）', r.body.created === false && r.body.id === revId, JSON.stringify(r.body));
  r = await A.get('/life/reviews?type=week');
  ck('周复盘只有 1 条且 did_well 已更新为 A+', r.body.filter((x) => x.period_key === '2026-W41').length === 1 && r.body.find((x) => x.period_key === '2026-W41').did_well === 'A+', JSON.stringify(r.body));

  r = await A.post(`/life/reviews/${revId}/to-sop`, {});
  const sopId = r.body.id;
  ck('复盘 → SOP 沉淀成功', r.status === 200 && sopId > 0, JSON.stringify(r.body));
  r = await A.get('/life/sops');
  const sop = r.body.find((x) => x.id === sopId);
  ck('SOP 取了复盘的 next_action 作步骤', sop && String(sop.steps).includes('30 分钟'), JSON.stringify(sop));
  r = await A.get(`/life/links/of/sop/${sopId}`);
  ck('SOP → 复盘 的 derives 边可追溯', r.body.out.some((e) => e.other.type === 'review' && e.relation === 'derives'), JSON.stringify(r.body.out));
  r = await A.post(`/life/sops/${sopId}/use`, {});
  ck('SOP 使用一次计数 +1 并记时间', r.body.use_count === 1 && !!r.body.last_used_at, JSON.stringify(r.body));

  // ---------- 6. 项目：删项目解绑任务、不删任务 ----------
  r = await A.post('/life/projects', { title: 'E2E 项目', goal_id: yearGoal, category: 'content' });
  const projId = r.body.id;
  ck('POST /life/projects', projId > 0, JSON.stringify(r.body));
  r = await A.post('/life/actions', { title: 'E2E 项目任务', task_type: 'project_task', project_id: projId });
  const ptask = r.body.id;
  r = await A.put(`/life/projects/${projId}`, { status: 'done' });
  ck('PUT /life/projects 改状态', r.body.status === 'done', JSON.stringify(r.body.status));
  r = await A.del(`/life/projects/${projId}`);
  ck('DELETE /life/projects 返回 removed=1', r.body.removed === 1, JSON.stringify(r.body));
  r = await A.get(`/life/actions?project_id=${projId}`);
  ck('项目删后行动仍在、但已解绑（筛不出）', r.body.length === 0);
  const all = await A.get('/life/actions?limit=500');
  ck('项目删后行动本身没被删掉', all.body.some((x) => x.id === ptask), '任务被误删了');

  // ---------- 7. 关系引擎图 ----------
  r = await A.get('/life/links');
  ck('GET /life/links 返回 nodes+edges', r.status === 200 && Array.isArray(r.body.nodes) && Array.isArray(r.body.edges), JSON.stringify(Object.keys(r.body || {})));
  ck('图里节点带 title/key/degree', r.body.nodes.every((n) => 'key' in n && 'degree' in n && typeof n.title === 'string'), JSON.stringify(r.body.nodes[0]));
  const gnode = r.body.nodes.find((n) => n.type === 'goal' && n.id === yearGoal);
  ck('年度目标在图中且有正度数', gnode && gnode.degree > 0, JSON.stringify(gnode));
  r = await A.get(`/life/links/neighbors/goal/${yearGoal}`);
  ck('neighbors 返回关联实体', r.status === 200 && r.body.length > 0, JSON.stringify(r.body).slice(0, 150));
  r = await A.get('/life/links/of/nosuchtype/1');
  ck('非法实体类型 400', r.status === 400, String(r.status));
  r = await A.post('/life/links', { src_type: 'goal', src_id: yearGoal, dst_type: 'goal', dst_id: yearGoal, relation: 'relates' });
  ck('自环建边被忽略但仍 200', r.status === 200, String(r.status));

  // ---------- 8. 删目标树：连子带孙删、清边、行动只解绑 ----------
  r = await A.del(`/life/goals/${yearGoal}`);
  ck('删年度目标 返回 removed=2（含子目标）', r.body.removed === 2, JSON.stringify(r.body));
  r = await A.get(`/life/goals/${childGoal}`);
  ck('子目标已随之删除（404）', r.status === 404, String(r.status));
  r = await A.get(`/life/actions?goal_id=${childGoal}`);
  ck('挂子目标的行动没被删，只是解绑', r.body.length === 0);
  const all2 = await A.get('/life/actions?limit=500');
  ck('行动本体仍在', all2.body.some((x) => x.id === actId), '行动被连带删了');
  const n2 = await A.get('/life/links');
  ck('删目标后没有指向已删目标的死边',
    !n2.body.edges.some((e) => e.target.startsWith('goal:') || e.source.startsWith('goal:')),
    JSON.stringify(n2.body.edges.filter((e) => e.target.startsWith('goal:') || e.source.startsWith('goal:'))));

  // ---------- 9. 仪表盘 ----------
  r = await A.get('/life/dashboard');
  ck('GET /life/dashboard 200 且字段齐全',
    r.status === 200 && typeof r.body.links_total === 'number' && typeof r.body.habits_total === 'number' && Array.isArray(r.body.notes_by_day),
    JSON.stringify(r.body).slice(0, 160));
  ck('dashboard 习惯总数含刚建的习惯', r.body.habits_total >= 1, String(r.body.habits_total));

  // ---------- 10. 权限：没有 life 页的用户必须 403 ----------
  r = await fetch(`${B}/api/users`, {
    method: 'POST', headers: admin.H,
    body: JSON.stringify({ username: 'e2elife', password: 'Life123456', role: 'user', allowed_pages: ['notes'], allowed_tabs: {} }),
  });
  const uid = (await j(r)).id;
  ck('创建只有笔记权限的用户', r.status === 200 && uid > 0, String(r.status));
  const u2 = await login(B, 'e2elife', 'Life123456');
  const U = api(B, u2.H);
  r = await U.get('/life/goals');
  ck('无 life 权限打 /life/goals → 403', r.status === 403, String(r.status));
  r = await U.get('/life/today');
  ck('无 life 权限打 /life/today → 403', r.status === 403, String(r.status));
  r = await U.get('/notes');
  ck('同一用户打 /notes 仍 200（没有误伤）', r.status === 200, String(r.status));

  // ---------- 11. 清理（只删本次创建的行，绝不整表 DELETE） ----------
  await A.del(`/life/habits/${habitId}`);
  await A.del(`/life/sops/${sopId}`);
  await A.del(`/life/reviews/${revId}`);
  await A.del(`/life/actions/${actId}`);
  await A.del(`/life/actions/${ptask}`);
  await A.del(`/life/krs/${kr1}`);
  await A.del(`/life/krs/${kr2}`);
  r = await A.get('/life/goals');
  ck('清理后目标树为空', r.body.length === 0, JSON.stringify(r.body.map((g) => g.id)));
} finally {
  srv.stop();
}

done();
