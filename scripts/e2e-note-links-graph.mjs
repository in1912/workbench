// E2E（v1.9.41）：双链（未解析 → 转正）、改名留别名、反链面板、删除后退回未解析、图谱与局部图。
import { startServer, login, api, checker } from './_noteE2E.mjs';

const { B, stop } = await startServer({ tag: 'links', port: 3972 });
const s = checker();
const A = api(B, (await login(B, 'admin', 'test123456')).H);
const created = [];

try {
  // ---------- ① 未解析双链不再被静默丢弃 ----------
  let r = await A.post('/notes', { title: 'E2E来源', content: '先引用 [[E2E目标]]，再引用 [[永远不会有的笔记]]。' });
  const src = r.body.id; created.push(src);
  s.ck('建来源笔记', r.status === 200 && src > 0, JSON.stringify(r.body));

  r = await A.get(`/notes/${src}/backlinks`);
  s.ck('两个目标都还没建 → 都进未解析', r.body.unresolved.length === 2, JSON.stringify(r.body.unresolved));
  s.ck('未解析里带着标题原文', r.body.unresolved.some((u) => u.title === 'E2E目标'), JSON.stringify(r.body.unresolved));
  s.ck('此时没有真链接', r.body.out.length === 0, JSON.stringify(r.body.out));

  // ---------- ② 建目标 → 未解析自动转正 ----------
  r = await A.post('/notes', { title: 'E2E目标', content: '目标正文' });
  const dst = r.body.id; created.push(dst);
  r = await A.get(`/notes/${src}/backlinks`);
  s.ck('建目标后自动转成真链接', r.body.out.length === 1 && r.body.out[0].id === dst, JSON.stringify(r.body.out));
  s.ck('未解析里只剩真正不存在的那个', r.body.unresolved.length === 1 && r.body.unresolved[0].title === '永远不会有的笔记', JSON.stringify(r.body.unresolved));

  r = await A.get(`/notes/${dst}/backlinks`);
  s.ck('目标侧看到反链', r.body.in.length === 1 && r.body.in[0].id === src, JSON.stringify(r.body.in));

  // 老契约 GET /notes/:id/links 仍是数组
  r = await A.get(`/notes/${src}/links`);
  s.ck('老契约 /links 仍是数组且带 dir', Array.isArray(r.body) && r.body.length === 1 && r.body[0].dir === 'out', JSON.stringify(r.body));

  // ---------- ③ 改名留别名：[[旧标题]] 不断链 ----------
  r = await A.put(`/notes/${dst}`, { title: 'E2E目标改', content: '目标正文' });
  s.ck('目标改名', r.status === 200, JSON.stringify(r.body));
  r = await A.get(`/notes/${src}/backlinks`);
  s.ck('改名后原链接仍在（存的是 id，不是标题）', r.body.out.length === 1 && r.body.out[0].id === dst, JSON.stringify(r.body.out));
  r = await A.post('/notes', { title: 'E2E别名验证', content: '引用 [[E2E目标]]（旧标题）。' });
  const aliasSrc = r.body.id; created.push(aliasSrc);
  r = await A.get(`/notes/${aliasSrc}/backlinks`);
  s.ck('用旧标题写 [[…]] 也能解析到改名后的笔记（别名生效）', r.body.out.length === 1 && r.body.out[0].id === dst, JSON.stringify(r.body.out));

  // ---------- ④ 删除目标 → 来源退回未解析（反链不会凭空消失） ----------
  await A.del(`/notes/${dst}`);
  created.splice(created.indexOf(dst), 1);
  r = await A.get(`/notes/${src}/backlinks`);
  s.ck('删掉目标后来源的链接退回未解析', r.body.out.length === 0 && r.body.unresolved.some((u) => u.title === 'E2E目标改'), JSON.stringify(r.body.unresolved));
  r = await A.get(`/notes/${aliasSrc}/backlinks`);
  s.ck('别名来源也退回未解析（标题用改名后的）', r.body.unresolved.some((u) => u.title === 'E2E目标改'), JSON.stringify(r.body.unresolved));

  // ---------- ⑤ 自链不建边 ----------
  r = await A.post('/notes', { title: 'E2E自链', content: '自己引用自己 [[E2E自链]]。' });
  const self = r.body.id; created.push(self);
  r = await A.get(`/notes/${self}/backlinks`);
  s.ck('自链既不建边也不记未解析', r.body.out.length === 0 && r.body.unresolved.length === 0, JSON.stringify(r.body));

  // ---------- ⑥ 图谱：节点度数 / 孤岛 ----------
  r = await A.post('/notes', { title: 'E2E枢纽', content: 'x' });
  const hub = r.body.id; created.push(hub);
  const spokes = [];
  for (let i = 1; i <= 3; i++) {
    r = await A.post('/notes', { title: `E2E辐条${i}`, content: `指向 [[E2E枢纽]] 的笔记` });
    spokes.push(r.body.id); created.push(r.body.id);
  }
  r = await A.post('/notes', { title: 'E2E孤岛', content: '谁都不引用，也没人引用我' });
  const island = r.body.id; created.push(island);

  r = await A.get('/notes/graph');
  const g = r.body;
  s.ck('图谱返回 nodes/edges/total', r.status === 200 && Array.isArray(g.nodes) && Array.isArray(g.edges) && typeof g.total === 'number', JSON.stringify({ n: g.nodes.length, e: g.edges.length, t: g.total }));
  const hubNode = g.nodes.find((n) => n.id === hub);
  s.ck('枢纽的入度 = 3', hubNode && hubNode.in_degree === 3 && hubNode.degree === 3, JSON.stringify(hubNode));
  const islandNode = g.nodes.find((n) => n.id === island);
  s.ck('孤岛度数为 0（前端据此画空心点）', islandNode && islandNode.degree === 0, JSON.stringify(islandNode));
  const spokeNode = g.nodes.find((n) => n.id === spokes[0]);
  s.ck('辐条出度 = 1', spokeNode && spokeNode.out_degree === 1 && spokeNode.in_degree === 0, JSON.stringify(spokeNode));
  s.ck('节点带顶层文件夹分组（配色维度）', g.nodes.every((n) => typeof n.group === 'string' && n.group), JSON.stringify(g.nodes[0] && g.nodes[0].group));

  // ---------- ⑦ 局部图：只取 N 跳邻居 ----------
  r = await A.get(`/notes/graph/local/${hub}?depth=1`);
  const lg = r.body;
  s.ck('局部图以该笔记为中心', lg.center === hub, JSON.stringify(lg.center));
  s.ck('depth=1 收到 3 个邻居 + 中心共 4 个节点', lg.nodes.length === 4, JSON.stringify(lg.nodes.map((n) => n.title)));
  s.ck('局部图不含无关节点（孤岛不在里面）', !lg.nodes.some((n) => n.id === island), JSON.stringify(lg.nodes.map((n) => n.id)));
  s.ck('局部图边数 3', lg.edges.length === 3, String(lg.edges.length));

  // ---------- ⑧ 图谱筛选：按文件夹 ----------
  r = await A.get('/notes/folders');
  const life = r.body.find((f) => f.name === '生活');
  r = await A.post('/notes', { title: 'E2E生活笔记', content: '生活正文', folder_id: life.id });
  const lifeNote = r.body.id; created.push(lifeNote);
  r = await A.get(`/notes/graph?folder_id=${life.id}`);
  s.ck('图谱按文件夹筛选', r.body.nodes.length === 1 && r.body.nodes[0].id === lifeNote, JSON.stringify(r.body.nodes.map((n) => n.title)));

  // ---------- ⑨ 清理 ----------
  for (const id of created) await A.del(`/notes/${id}`);
} finally {
  stop();
  s.done();
}
