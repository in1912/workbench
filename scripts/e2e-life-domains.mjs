// E2E（v1.10.5，需求⑩）：领域的改名 / 新增 / 删除，含「有目标不许删」这道硬闸。
// 隔离服务器（独立 DATA_DIR），不碰 data/workbench.sqlite。
import { startServer, login, api, checker } from './_noteE2E.mjs';

const { B, stop } = await startServer({ tag: 'lifedom', port: 3992 });
const s = checker();
const admin = await login(B, 'admin', 'test123456');
const A = api(B, admin.H);
const createdGoals = [];
const createdProjects = [];

try {
  // ---------- ① 种子与列表 ----------
  let r = await A.get('/life/domains');
  s.ck('GET /life/domains 返回 6 个默认领域', r.status === 200 && r.body.length === 6, JSON.stringify((r.body || []).map((d) => d.name)));
  const names = r.body.map((d) => d.name);
  s.ck('默认领域是 事业/财务/健康/家庭/关系/个人成长',
    JSON.stringify(names) === JSON.stringify(['事业', '财务', '健康', '家庭', '关系', '个人成长']), JSON.stringify(names));
  const work = r.body.find((d) => d.name === '事业');

  // ---------- ② 新增 ----------
  r = await A.post('/life/domains', { name: '副业', icon: 'rocket_launch' });
  const biz = r.body.id;
  s.ck('新增领域成功', r.status === 200 && biz > 0, JSON.stringify(r.body));
  r = await A.post('/life/domains', { name: '副业' });
  s.ck('重名 → 400', r.status === 400 && /已经有/.test(r.body.error || ''), JSON.stringify(r.body));
  r = await A.post('/life/domains', { name: '   ' });
  s.ck('空名 → 400', r.status === 400, JSON.stringify(r.body));
  r = await A.post('/life/domains', { name: 'a'.repeat(21) });
  s.ck('超过 20 字 → 400', r.status === 400, JSON.stringify(r.body));
  r = await A.post('/life/domains', { name: '带怪图标的领域', icon: 'not-a-real-icon' });
  s.ck('不认识的图标退回 flag（不报错、也不会渲染成一串字母）',
    r.status === 200 && (await A.get('/life/domains')).body.find((d) => d.id === r.body.id).icon === 'flag');

  // ---------- ③ 改名 ----------
  r = await A.put(`/life/domains/${biz}`, { name: '副业与投资' });
  s.ck('改名成功', r.status === 200 && r.body.name === '副业与投资', JSON.stringify(r.body));
  r = await A.put(`/life/domains/${biz}`, { name: '健康' });
  s.ck('改成别人已用的名字 → 400', r.status === 400, JSON.stringify(r.body));
  r = await A.put(`/life/domains/${biz}`, { name: '副业与投资' });
  s.ck('改成自己原来的名字不算重名', r.status === 200, JSON.stringify(r.body));
  r = await A.put('/life/domains/999999', { name: 'x' });
  s.ck('改不存在的领域 → 404', r.status === 404, String(r.status));

  // ---------- ④ 空领域可以直接删 ----------
  r = await A.del(`/life/domains/${biz}`);
  s.ck('删掉空领域', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
  r = await A.del(`/life/domains/${biz}`);
  s.ck('重复删 → 404', r.status === 404, String(r.status));

  // ---------- ⑤ 有目标 → 一律删不掉（force 也不行） ----------
  r = await A.post('/life/goals', { title: '年度营收翻倍', level: 'year', domain_id: work.id });
  const goalId = r.body.id;
  createdGoals.push(goalId);
  s.ck('在「事业」下建一个目标', r.status === 200 && goalId > 0, JSON.stringify(r.body));
  r = await A.del(`/life/domains/${work.id}`);
  s.ck('有目标的领域：删 → 409', r.status === 409, `${r.status} ${JSON.stringify(r.body)}`);
  s.ck('409 里带 counts.goals 与可读提示', r.body.counts && r.body.counts.goals === 1 && /还有 1 个目标/.test(r.body.error || ''), JSON.stringify(r.body));
  r = await A.del(`/life/domains/${work.id}?force=1`);
  s.ck('加 force 也删不掉（需求⑩：目标必须先删掉/改走）', r.status === 409, `${r.status} ${JSON.stringify(r.body)}`);

  // 把目标改到别的领域，就能删了
  r = await A.put(`/life/goals/${goalId}`, { domain_id: null });
  s.ck('把目标移出该领域', r.status === 200, JSON.stringify(r.body));

  // ---------- ⑥ 项目/习惯/SOP 挂着 → 先 409 报数，force 才放行并解引用 ----------
  r = await A.post('/life/projects', { title: '副业选品', domain_id: work.id });
  const projId = r.body.id;
  createdProjects.push(projId);
  s.ck('在「事业」下建一个项目', r.status === 200 && projId > 0, JSON.stringify(r.body));
  r = await A.del(`/life/domains/${work.id}`);
  s.ck('只有项目挂着时：不加 force → 409 且带 can_force', r.status === 409 && r.body.can_force === true, `${r.status} ${JSON.stringify(r.body)}`);
  s.ck('提示里点名是哪些东西', /1 个项目/.test(r.body.error || ''), r.body.error);

  // 先证明「领域↔项目」这条边真的存在，否则下面「不留残线」是句空话
  const of = await A.get(`/life/links/of/project/${projId}`);
  s.ck('项目与领域之间有真实的关系边（belongs）',
    of.status === 200 && [...(of.body.out || []), ...(of.body.in || [])]
      .some((l) => l.other.type === 'domain' && l.other.id === work.id && l.relation === 'belongs'),
    JSON.stringify(of.body));
  const before = (await A.get('/life/domains')).body.length;

  r = await A.del(`/life/domains/${work.id}?force=1`);
  s.ck('force=1 → 删除成功并报出清掉了什么', r.status === 200 && r.body.cleared && r.body.cleared.projects === 1, JSON.stringify(r.body));
  r = await A.get('/life/projects');
  const proj = (r.body || []).find((p) => p.id === projId);
  s.ck('项目本身没被删，只是领域被清空', r.status === 200 && !!proj && (proj.domain_id === null || proj.domain_id === undefined),
    JSON.stringify(proj || null));
  const g = await A.get('/life/links?types=domain,project');
  s.ck('删领域后没有残留的关系边（图谱里不留指着空气的线）',
    g.status === 200 && !(g.body.edges || []).some((e) => e.source === `domain:${work.id}` || e.target === `domain:${work.id}`),
    JSON.stringify((g.body.edges || []).slice(0, 5)));
  r = await A.get('/life/domains');
  s.ck('领域列表少了一个', r.body.length === before - 1, `${before} → ${r.body.length}`);

  // ---------- ⑦ 领域概览仍然正常（前端竖列布局的取数口） ----------
  const fam = r.body.find((d) => d.name === '家庭');
  r = await A.get(`/life/domains/${fam.id}`);
  s.ck('GET /life/domains/:id 仍返回 goals/projects/habits/sops/avg_progress',
    r.status === 200 && Array.isArray(r.body.goals) && typeof r.body.projects === 'number'
    && typeof r.body.habits === 'number' && typeof r.body.sops === 'number' && 'avg_progress' in r.body,
    JSON.stringify(Object.keys(r.body || {})));

  // ---------- ⑧ 权限：/life/* 归 life 页 ----------
  const anon = await fetch(`${B}/api/life/domains`);
  s.ck('未登录访问 /life/domains → 401', anon.status === 401, String(anon.status));
} catch (e) {
  console.error('用例异常：', e && e.stack ? e.stack : e);
  s.ck('用例未抛异常', false, String(e && e.message));
} finally {
  // 只删本次建的，绝不整表 DELETE
  for (const id of createdGoals) { try { await A.del(`/life/goals/${id}`); } catch { /* 已删 */ } }
  for (const id of createdProjects) { try { await A.del(`/life/projects/${id}`); } catch { /* 已删 */ } }
  s.done();
  stop();
}
