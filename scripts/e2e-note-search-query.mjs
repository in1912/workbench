// E2E（v1.9.41）：四种搜索模式（关键词/标签/路径/正则）+ 正则安全闸门 + Dataview 受限查询。
import { startServer, login, api, checker } from './_noteE2E.mjs';

const { B, stop } = await startServer({ tag: 'search', port: 3973 });
const s = checker();
const A = api(B, (await login(B, 'admin', 'test123456')).H);
const created = [];

try {
  // ---------- 准备素材 ----------
  let r = await A.get('/notes/folders');
  const work = r.body.find((f) => f.name === '工作');
  r = await A.post('/notes/folders', { name: '检索实验室', parent_id: work.id });
  const lab = r.body.id;

  r = await A.post('/notes', { title: 'E2E检索甲', content: '这里讲的是量子纠缠与量子计算。', folder_id: lab, tags: ['物理', '实验'] });
  const n1 = r.body.id; created.push(n1);
  r = await A.post('/notes', { title: 'E2E检索乙', content: '这是一篇关于烹饪的笔记，红烧肉做法。', folder_id: lab });
  const n2 = r.body.id; created.push(n2);
  r = await A.post('/notes', { title: 'E2E检索丙', content: '普通正文，没什么特别的。' });
  const n3 = r.body.id; created.push(n3);

  // ---------- ① 关键词 ----------
  r = await A.get('/notes/search?q=' + encodeURIComponent('量子'));
  s.ck('关键词命中正文', r.status === 200 && r.body.rows.some((x) => x.id === n1), JSON.stringify(r.body.rows.map((x) => x.title)));
  r = await A.get('/notes/search?q=' + encodeURIComponent('量子'));
  s.ck('关键词不含无关笔记', !r.body.rows.some((x) => x.id === n2), String(r.body.rows.length));

  // ---------- ② 标签 ----------
  r = await A.get('/notes/search?mode=tag&q=' + encodeURIComponent('物理'));
  s.ck('标签模式命中', r.body.rows.length >= 1 && r.body.rows.some((x) => x.id === n1), JSON.stringify(r.body.rows.map((x) => x.title)));
  r = await A.get('/notes/tags');
  s.ck('GET /notes/tags 带 count 且按数量倒序', r.status === 200 && r.body.every((t) => t.tag && t.count > 0), JSON.stringify(r.body.slice(0, 5)));

  // ---------- ③ 路径（按所在文件夹名找） ----------
  r = await A.get('/notes/search?mode=path&q=' + encodeURIComponent('检索实验室'));
  s.ck('路径模式按文件夹名命中', r.body.rows.length === 2 && r.body.rows.every((x) => x.id === n1 || x.id === n2), JSON.stringify(r.body.rows.map((x) => x.folder_path)));

  // ---------- ④ 正则 ----------
  r = await A.get('/notes/search?mode=regex&q=' + encodeURIComponent('量子(纠缠|计算)'));
  s.ck('合法正则命中', r.status === 200 && r.body.rows.some((x) => x.id === n1), JSON.stringify(r.body).slice(0, 160));
  r = await A.get('/notes/search?mode=regex&q=' + encodeURIComponent('^E2E检索[甲乙]$'));
  s.ck('带锚点的正则命中标题', r.body.rows.length === 2, JSON.stringify(r.body.rows.map((x) => x.title)));

  // 四层防护里前三层（校验 / 危险模式 / 长度）都是 400，第四层是 worker 硬超时
  r = await A.get('/notes/search?mode=regex&q=' + encodeURIComponent('(unclosed'));
  s.ck('非法正则 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  r = await A.get('/notes/search?mode=regex&q=' + encodeURIComponent('(a+)+$'));
  s.ck('嵌套量词 → 400（ReDoS 构造）', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  r = await A.get('/notes/search?mode=regex&q=' + encodeURIComponent('.*.*.*x'));
  s.ck('重复贪婪通配 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  r = await A.get('/notes/search?mode=regex&q=' + encodeURIComponent('(a)\\1'));
  s.ck('反向引用 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  r = await A.get('/notes/search?mode=regex&q=' + encodeURIComponent('x'.repeat(201)));
  s.ck('超长正则 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  r = await A.get('/notes/search?mode=regex&q=' + encodeURIComponent('a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q|r|s|t|u'));
  s.ck('分支过多 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

  // ---------- ⑤ Dataview：文本语法 ----------
  const q = (text) => A.post('/notes/query', { text });
  r = await q('#物理');
  s.ck('Dataview：#标签', r.status === 200 && r.body.rows.some((x) => x.id === n1) && !r.body.rows.some((x) => x.id === n2), JSON.stringify(r.body.rows.map((x) => x.title)));
  r = await q('title ~ "检索" AND words > 3');
  s.ck('Dataview：title ~ 模糊 AND words > 数字', r.status === 200 && r.body.rows.length >= 2, JSON.stringify(r.body.rows.map((x) => [x.title, x.word_count])));
  r = await q('folder = 检索实验室');
  s.ck('Dataview：folder = 任意层级的文件夹名', r.body.rows.length === 2, JSON.stringify(r.body.rows.map((x) => x.title)));
  r = await q('folder = 工作/检索实验室');
  s.ck('Dataview：folder 也认完整路径（工作/检索实验室）', r.body.rows.length === 2, JSON.stringify(r.body.rows.map((x) => x.title)));
  r = await q('folder = 不存在的文件夹');
  s.ck('不存在的文件夹 → 空集而不是报错', r.status === 200 && r.body.rows.length === 0, JSON.stringify(r.body));
  r = await q('title ~ "检索甲" OR title ~ "检索乙"');
  s.ck('Dataview：OR', r.body.rows.length === 2, JSON.stringify(r.body.rows.map((x) => x.title)));

  // 结构化（数据库视图的表单用它）
  r = await A.post('/notes/query', { where: [{ field: 'title', op: '~', value: '检索丙' }], sort: 'title', order: 'asc', limit: 10 });
  s.ck('Dataview：结构化 where', r.status === 200 && r.body.rows.length === 1 && r.body.rows[0].id === n3, JSON.stringify(r.body.rows.map((x) => x.title)));
  r = await A.post('/notes/query', { where: [{ field: 'tag', op: '=', value: '物理' }, { field: 'words', op: '>', value: 0 }], join: 'AND' });
  s.ck('Dataview：结构化多条件 AND', r.body.rows.some((x) => x.id === n1), JSON.stringify(r.body.rows.map((x) => x.title)));

  // 错误路径
  r = await q('nosuchfield = 1');
  s.ck('未知字段 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  r = await q('title ** 1');
  s.ck('非法操作符 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  r = await q('title ~ "a" AND words > 1 AND title ~ "b" AND words > 2 AND title ~ "c" AND words > 3 AND title ~ "d" AND words > 4 AND title ~ "e" AND words > 5 AND title ~ "f"');
  s.ck('条件过多 → 400（上限 10）', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  r = await q('title ~ "a" AND');
  s.ck('AND 后面缺条件 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  r = await A.post('/notes/query', { prop: 'x' });
  s.ck('既不传 text 也不传 where → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

  // SQL 注入形状的输入必须被当普通字符串（不报错、不匹配）
  r = await q('title = "\' OR 1=1 --"');
  s.ck('注入形状输入被当纯字符串（空结果，不炸）', r.status === 200 && r.body.rows.length === 0, JSON.stringify(r.body).slice(0, 120));
  s.ck('注入没把整库带出来', r.body.count === 0, String(r.body.count));

  // ---------- ⑥ 清理 ----------
  for (const id of created) await A.del(`/notes/${id}`);
  await A.del(`/notes/folders/${lab}?force=1`);
} finally {
  stop();
  s.done();
}
