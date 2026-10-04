// E2E（v1.9.41）：多级文件夹树 + 分类兼容外壳 + 外部写入令牌改挂文件夹 + 权限。
// 隔离服务器（独立 DATA_DIR），不碰 data/workbench.sqlite。
import { startServer, login, api, checker } from './_noteE2E.mjs';

const { B, stop } = await startServer({ tag: 'folders', port: 3971 });
const s = checker();
const admin = await login(B, 'admin', 'test123456');
const A = api(B, admin.H);
const created = []; // 本次建的笔记，先删笔记再删文件夹

try {
  // ---------- ① 种子与树 ----------
  let r = await A.get('/notes/folders');
  const roots = r.body;
  s.ck('GET /notes/folders 返回数组', r.status === 200 && Array.isArray(roots), JSON.stringify(r.body).slice(0, 120));
  s.ck('6 个顶层文件夹已播种', roots.length >= 6 && roots.some((f) => f.name === 'general'), JSON.stringify(roots.map((f) => f.name)));
  s.ck('顶层节点带 note_count 与 children', roots.every((f) => typeof f.note_count === 'number' && Array.isArray(f.children)), JSON.stringify(roots[0]));

  const general = roots.find((f) => f.name === 'general');
  const work = roots.find((f) => f.name === '工作');
  const life = roots.find((f) => f.name === '生活');

  // ---------- ② 建子文件夹 / 同级重名 / 跨父同名 ----------
  r = await A.post('/notes/folders', { name: '2026', parent_id: work.id });
  const work2026 = r.body.id;
  s.ck('建子文件夹（工作/2026）', r.status === 200 && work2026 > 0, JSON.stringify(r.body));
  r = await A.post('/notes/folders', { name: '2026', parent_id: work.id });
  s.ck('同级重名被拒（400）', r.status === 400, String(r.status));
  r = await A.post('/notes/folders', { name: '2026', parent_id: life.id });
  const life2026 = r.body.id;
  s.ck('不同父下同名允许（生活/2026）', r.status === 200 && life2026 > 0, JSON.stringify(r.body));
  r = await A.post('/notes/folders', { name: '工作', parent_id: null });
  s.ck('顶层重名被拒（部分唯一索引兜住 NULL 父级）', r.status === 400, String(r.status));

  r = await A.get('/notes/folders');
  const tree = r.body;
  const w = tree.find((f) => f.id === work.id);
  s.ck('子文件夹挂在正确的父下', !!w && w.children.some((c) => c.id === work2026), JSON.stringify(w && w.children.map((c) => c.name)));
  s.ck('节点带完整路径', w.children.find((c) => c.id === work2026).path === '工作/2026', JSON.stringify(tree[1]));

  // ---------- ③ 成环拒绝 ----------
  r = await A.put(`/notes/folders/${work.id}`, { parent_id: work2026 });
  s.ck('把父移到自己的子下被拒（400）', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  r = await A.put(`/notes/folders/${work2026}`, { name: '2026', parent_id: work2026 });
  s.ck('把文件夹移到它自己下被拒（400）', r.status === 400, String(r.status));

  // ---------- ④ 建笔记落对文件夹 + ?folder_id= 含子树 ----------
  r = await A.post('/notes', { title: 'E2E工作2026笔记', content: '正文', folder_id: work2026 });
  const n1 = r.body.id; created.push(n1);
  s.ck('POST /notes 指定 folder_id', r.status === 200 && n1 > 0, JSON.stringify(r.body));
  r = await A.get(`/notes?folder_id=${work.id}`);
  s.ck('?folder_id= 连子文件夹一起筛', r.body.some((n) => n.id === n1), JSON.stringify(r.body.map((n) => n.title)));
  r = await A.get(`/notes?folder_id=${life.id}`);
  s.ck('另一个文件夹筛不到它', !r.body.some((n) => n.id === n1), String(r.body.length));
  r = await A.get(`/notes?folder_id=${work2026}`);
  s.ck('精确到子文件夹也筛得到', r.body.some((n) => n.id === n1));

  s.ck('列表补充 folder_path', r.body[0].folder_path === '工作/2026', r.body[0].folder_path);
  s.ck('老契约 category 缓存列同步为叶子名', r.body[0].category === '2026', r.body[0].category);

  // ---------- ⑤ 移动笔记只改归属 ----------
  r = await A.put(`/notes/${n1}/move`, { folder_id: general.id });
  s.ck('PUT /notes/:id/move 改归属', r.status === 200 && r.body.folder_id === general.id, JSON.stringify(r.body));
  r = await A.get(`/notes/${n1}`);
  s.ck('详情反映新文件夹与路径', r.body.folder_path === 'general' && r.body.folder_id === general.id, JSON.stringify({ p: r.body.folder_path }));
  s.ck('详情 tags 是数组、props 是对象', Array.isArray(r.body.tags) && r.body.props && typeof r.body.props === 'object', JSON.stringify({ t: r.body.tags }));

  // ---------- ⑥ 改名同步 category（v1.9.39 的老 bug） ----------
  r = await A.put(`/notes/folders/${general.id}`, { name: '未分类' });
  s.ck('顶层文件夹改名', r.status === 200, String(r.status));
  r = await A.get(`/notes/${n1}`);
  s.ck('改名后笔记的 category 缓存同步（老 bug 已修）', r.body.category === '未分类', r.body.category);
  // 改回去，免得分支里到处是「未分类」的假设被打破
  await A.put(`/notes/folders/${general.id}`, { name: 'general' });

  // ---------- ⑦ 删文件夹：409 → force ----------
  r = await A.post('/notes', { title: 'E2E待删文件夹里的笔记', content: 'x', folder_id: work2026 });
  const n2 = r.body.id; created.push(n2);
  r = await A.del(`/notes/folders/${work2026}`);
  s.ck('删有笔记的文件夹返回 409 + 条数', r.status === 409 && r.body.count === 1 && r.body.need_force === true, JSON.stringify(r.body));
  r = await A.del(`/notes/folders/${work2026}?force=1`);
  s.ck('force=1 删除并报告迁移条数', r.status === 200 && r.body.moved === 1, JSON.stringify(r.body));
  r = await A.get(`/notes/${n2}`);
  s.ck('force 后笔记变成未归档（folder_id=NULL）', r.body.folder_id === null, JSON.stringify(r.body.folder_id));
  r = await A.get(`/notes?folder_id=none`);
  s.ck('?folder_id=none 能筛出未归档', r.body.some((n) => n.id === n2));

  // ---------- ⑧ 删有子文件夹的父：子级上提（不复用 work，它这会儿已经空了） ----------
  r = await A.post('/notes/folders', { name: 'E2E父', parent_id: null });
  const par = r.body.id;
  r = await A.post('/notes/folders', { name: 'E2E子', parent_id: par });
  const kid = r.body.id;
  s.ck('建父子两级', par > 0 && kid > 0, JSON.stringify({ par, kid }));
  r = await A.del(`/notes/folders/${par}`);
  s.ck('删有子文件夹的父返回 409', r.status === 409 && r.body.children === 1, JSON.stringify(r.body));
  r = await A.del(`/notes/folders/${par}?force=1`);
  s.ck('force 删父成功', r.status === 200, JSON.stringify(r.body));
  r = await A.get('/notes/folders');
  s.ck('子文件夹被上提到顶层而不是被连坐删掉',
    r.body.some((f) => f.id === kid && f.parent_id === null), JSON.stringify(r.body.map((f) => [f.name, f.parent_id])));
  await A.del(`/notes/folders/${kid}?force=1`);

  // ---------- ⑨ 分类兼容外壳（老前端仍在用） ----------
  r = await A.get('/notes/categories');
  s.ck('GET /notes/categories 仍有 note_count', r.status === 200 && r.body.every((c) => typeof c.note_count === 'number'), JSON.stringify(r.body[0]));
  r = await A.post('/notes/categories', { name: 'E2E外壳分类' });
  const catId = r.body.id;
  s.ck('POST /notes/categories 等价于建顶层文件夹', r.status === 200 && catId > 0, JSON.stringify(r.body));

  // ---------- ⑩ 写入令牌改挂文件夹（noteShareRoutes 改表后的回归） ----------
  r = await A.put(`/notes/categories/${catId}`, { token_action: 'gen' });
  const tok = r.body.intake_token;
  s.ck('生成写入令牌（32 位 hex）', r.status === 200 && /^[0-9a-f]{32}$/.test(String(tok)), JSON.stringify(r.body));
  r = await fetch(`${B}/api/note-intake/${tok}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '外部推入', content: '来自外部系统' }),
  });
  const pushed = await r.json();
  s.ck('免登录写入成功', r.status === 200 && pushed.ok === true && pushed.id > 0, JSON.stringify(pushed));
  created.push(pushed.id);
  r = await A.get(`/notes?category=E2E外壳分类`);
  s.ck('推入的笔记落在该文件夹', r.body.length === 1 && r.body[0].id === pushed.id, JSON.stringify(r.body.map((n) => n.title)));

  // 令牌挂到**子文件夹**上也要能用（老分类是平的，新树是深的）
  r = await A.put(`/notes/categories/${catId}`, { token_action: 'clear' });
  s.ck('清除令牌', r.status === 200 && r.body.intake_token === '', JSON.stringify(r.body));
  r = await fetch(`${B}/api/note-intake/${tok}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'x' }) });
  s.ck('清除后原令牌失效（403，不是 401）', r.status === 403, String(r.status));

  // ---------- ⑪ 权限：没有「笔记」页权限的成员一律 403 ----------
  // allowed_pages 为空数组 = 全开（auth.js canAccess），所以必须给一个不含 notes 的显式清单
  r = await A.post('/users', { username: 'note-e2e-noperm', password: 'Np123456', role: 'user', allowed_pages: ['dashboard'] });
  s.ck('建无权限成员', r.status === 200 && r.body.id > 0, JSON.stringify(r.body).slice(0, 120));
  const np = await login(B, 'note-e2e-noperm', 'Np123456');
  const N = api(B, np.H);
  for (const [name, call] of [['/notes/folders', () => N.get('/notes/folders')], ['/notes/tags', () => N.get('/notes/tags')], ['/notes/graph', () => N.get('/notes/graph')], ['/notes/stats', () => N.get('/notes/stats')]]) {
    const rr = await call();
    s.ck(`无权限打 ${name} 返回 403`, rr.status === 403, String(rr.status));
  }

  // ---------- ⑫ 清理 ----------
  for (const id of created) await A.del(`/notes/${id}`);
  await A.del(`/notes/categories/${catId}?force=1`);
  await A.del(`/notes/folders/${life2026}?force=1`);
  await A.del(`/notes/folders/${work2026}?force=1`);
} finally {
  stop();
  s.done();
}
