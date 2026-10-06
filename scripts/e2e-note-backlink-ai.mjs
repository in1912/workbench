// E2E（v1.10.31）：批量链接 · 「AI 连接」全链路。
//
// 覆盖：AI 未配置友好报错 / 链接状态筛选（从未链接过 vs 有过链接——note_links 两侧口径）/
//       文件夹子树隔离（别棵树不串）/ 语料只含候选（标题 + 摘要在场、已链接的不进）/
//       分组校验（编造编号丢弃、重复入组只认第一组、组内重复编号去重、不足 2 篇的组丢弃）/
//       **后台任务生命周期**（POST 立即返、轮询到 done、resumed、取消丢弃、重开弹窗 GET latest 恢复）/
//       解析失败自动重试 / 拿一组的 ids 走互链真落链（AI 只筛不写——写的是老互链端点）/
//       链完的笔记在「从未链接过」里消失、在「有过链接」里出现 / 参数校验 / 无 notes 页权限 403。
//
// AI 是本地桩（OpenAI 兼容）：回包可切（正常/坏 JSON/延迟），并记录收到的请求体——
// 语料断言读桩真实收到的东西（替身照猜的契约、猜错也全绿；桩在这里就是「AI 侧的真实输出」）。
import http from 'node:http';
import { startServer, login, api, checker } from './_noteE2E.mjs';

const { ck, done } = checker();

// ---- 假 AI：记请求；PAYLOAD 按「本轮要喂给服务的分组剧本」可换 ----
const calls = [];
const stubMode = { delay: 0, badTimes: 0 };
let PAYLOAD = { groups: [] };
const stub = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (c) => { buf += c; });
  req.on('end', () => {
    calls.push({ url: req.url, auth: req.headers.authorization || '', body: buf });
    const respond = () => {
      const bad = stubMode.badTimes > 0;
      if (bad) stubMode.badTimes--;
      const content = bad ? '好的，我来帮您把这批笔记整理一下。整体来看……（散文，不是 JSON）' : JSON.stringify(PAYLOAD);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 200, completion_tokens: 180, total_tokens: 380 },
      }));
    };
    stubMode.delay ? setTimeout(respond, stubMode.delay) : respond();
  });
});
await new Promise((r) => stub.listen(3989, '127.0.0.1', r));

const srv = await startServer({ tag: 'blai', port: 3986 });
const { B } = srv;

const waitJob = async (A, { timeoutMs = 15000 } = {}) => {
  const t0 = Date.now();
  for (;;) {
    const r = await A.get('/notes/backlink-ai/jobs/latest');
    if (!r.body || r.body.state !== 'running') return r;
    if (Date.now() - t0 > timeoutMs) throw new Error('任务超时未完成: ' + JSON.stringify(r.body).slice(0, 240));
    await new Promise((s) => setTimeout(s, 120));
  }
};
const runJob = async (A, body) => {
  const r = await A.post('/notes/backlink-ai/jobs', body);
  if (r.status !== 200) return r;
  return waitJob(A);
};

try {
  const admin = await login(B, 'admin', 'test123456');
  const A = api(B, admin.H);

  // ---------- 1. 数据：装修 3 篇 / Vite 2 篇 / 孤儿 1 篇 / 预链好的 2 篇（D 组） ----------
  const tree = (await A.get('/notes/folders')).body;
  const find = (nodes, name) => { for (const n of nodes) { if (n.name === name) return n; const h = find(n.children || [], name); if (h) return h; } return null; };
  const mkFolder = async (name, parent) => {
    const r = await A.post('/notes/folders', { name, parent_id: parent });
    if (!r.body.id) throw new Error(`建文件夹 ${name} 失败: ${JSON.stringify(r.body)}`);
    return r.body.id;
  };
  const seedIm = find(tree, 'IM连接');
  const root = seedIm ? seedIm.id : await mkFolder('IM连接', null);
  const fa = await mkFolder('AI连接A', root);
  const fb = await mkFolder('AI连接B');   // 别棵树
  const mkNote = (title, folder, content) => A.post('/notes', { title, folder_id: folder, content: `# ${title}\n\n${content}` });
  const [a1, a2, a3] = await Promise.all([
    mkNote('装修-预算', fa, '装修预算 15 万，水电改造优先'),
    mkNote('装修-水电', fa, '水电走顶，装修师傅下周进场'),
    mkNote('装修-瓷砖', fa, '瓷砖选了灰色系，装修风格统一'),
  ]);
  const [b1, b2] = await Promise.all([
    mkNote('Vite-入门', fa, 'Vite 笔记：dev server 与 HMR'),
    mkNote('Vite-插件', fa, 'Vite 笔记：写一个插件'),
  ]);
  const c1 = await mkNote('孤儿笔记', fa, '内容谁也不相关');
  const [d1, d2] = await Promise.all([
    mkNote('旧链-上', fa, '已经互相链接过的一对'),
    mkNote('旧链-下', fa, '同上'),
  ]);
  await A.post('/notes/backlink-mutual', { ids: [d1.body.id, d2.body.id] });   // D 组提前成「有过链接」

  // ---------- 2. AI 未配置 → 400 ----------
  let r = await A.get('/notes/backlink-ai/meta');
  ck('meta：三种筛选 + has_ai=false', r.status === 200 && r.body.scopes.map((s) => s.key).join(',') === 'unlinked,linked,all'
    && r.body.has_ai === false && r.body.max_notes === 300, JSON.stringify(r.body).slice(0, 120));
  r = await A.post('/notes/backlink-ai/jobs', { scope: 'unlinked' });
  ck('AI 未配置 → 400 且指路设置页', r.status === 400 && /AI 尚未配置/.test(r.body.error), `${r.status} ${r.body.error}`);
  ck('没建任务时 latest 是 null', (await A.get('/notes/backlink-ai/jobs/latest')).body === null);

  // ---------- 3. 配假 AI ----------
  r = await A.post('/ai/config', { model: 'stub-chat', base_url: 'http://127.0.0.1:3989/v1', api_key: 'sk-stub-blai' });
  ck('配置假 AI 成功', r.status === 200 && r.body.ok, JSON.stringify(r.body));
  ck('meta.has_ai 变 true', (await A.get('/notes/backlink-ai/meta')).body.has_ai === true);

  // ---------- 4. 首轮分析：unlinked + 子树 fa ----------
  PAYLOAD = {
    groups: [
      { keyword: '装修', note_ids: [a1.body.id, a2.body.id, a3.body.id], reason: '都是装修相关' },
      { keyword: 'Vite', note_ids: [b1.body.id, b2.body.id, b2.body.id], reason: 'Vite 笔记两篇' },   // 组内重复编号 → 去重
      { keyword: '编造', note_ids: [a1.body.id, 999999], reason: '一个已被认领、一个不存在' },          // → 不足 2 篇丢弃
    ],
  };
  calls.length = 0;
  r = await runJob(A, { scope: 'unlinked', folder_id: fa });
  ck('分析完成 done + 进度 100', r.body.state === 'done' && r.body.progress === 100 && r.body.stage_label === '完成',
    JSON.stringify(r.body).slice(0, 160));
  const b = r.body.result;
  ck('候选口径：从未链接过 × 子树 = 6 篇（预链好的 D 组被筛掉）', b.notes_candidates === 6, String(b.notes_candidates));
  ck('分组校验：2 组存活（编造组丢弃）、组内重复去重',
    b.groups.length === 2 && b.groups[0].keyword === '装修' && b.groups[0].note_ids.length === 3
    && b.groups[1].note_ids.length === 2, JSON.stringify(b.groups.map((g) => [g.keyword, g.note_ids])));
  ck('分组带标题与理由（弹窗直接可读）',
    b.groups[0].notes[0].title === '装修-预算' && b.groups[0].reason === '都是装修相关', JSON.stringify(b.groups[0]).slice(0, 160));
  ck('组按篇数降序', b.groups[0].note_ids.length >= b.groups[1].note_ids.length);
  ck('覆盖篇数与模型/tokens 回带', b.notes_grouped === 5 && b.model === 'stub-chat' && b.usage.total_tokens === 380,
    JSON.stringify({ grouped: b.notes_grouped, model: b.model }));
  const sent = JSON.parse(calls[calls.length - 1].body);
  const userMsg = sent.messages[1].content;
  ck('语料只含候选：标题 + 摘要在场、已链接的与孤儿不混进分组',
    userMsg.includes('装修-预算') && userMsg.includes('15 万') && userMsg.includes('Vite-入门') && userMsg.includes('孤儿笔记'),
    JSON.stringify(calls[0].url));
  ck('语料每篇带 [编号]（AI 只能拿编号说事）', /\[\d+\] 装修-预算/.test(userMsg));

  // ---------- 5. 拿一组的 ids 走互链：AI 只筛、写的是老互链端点 ----------
  r = await A.post('/notes/backlink-mutual', { ids: b.groups[0].note_ids });
  ck('执行组①互链：3 篇互加 6 条链接', r.body.updated === 3 && r.body.links_added === 6, JSON.stringify(r.body).slice(0, 160));
  const n1 = (await A.get(`/notes/${a1.body.id}`)).body;
  ck('正文真有 [[链接]]（落「## 关联笔记」小节）', n1.content.includes('## 关联笔记') && n1.content.includes('[[装修-水电]]') && n1.content.includes('[[装修-瓷砖]]'));

  // ---------- 6. 链接状态口径翻面：装修组进了「有过链接」、退出「从未链接过」 ----------
  PAYLOAD = { groups: [] };
  r = await runJob(A, { scope: 'unlinked', folder_id: fa });
  ck('再筛「从未链接过」：装修 3 篇已退出（候选 3 = Vite2+孤儿）',
    r.body.state === 'done' && r.body.result.notes_candidates === 3, String(r.body.result && r.body.result.notes_candidates));
  r = await runJob(A, { scope: 'linked', folder_id: fa });
  ck('筛「有过链接」：正好 5 篇（装修 3 + 旧链 2）', r.body.result.notes_candidates === 5,
    String(r.body.result.notes_candidates));
  ck('空分组是合法结果（宁缺毋滥）', r.body.result.groups.length === 0 && r.body.result.notes_grouped === 0);

  // ---------- 7. 全库范围：别棵树的笔记也进候选 ----------
  await mkNote('别棵树-Vite-3', fb, 'Vite 笔记：构建优化');
  r = await runJob(A, { scope: 'all', folder_id: 0 });
  ck('folder_id=0 全库：别棵树也算（种子笔记都在）', r.body.state === 'done' && r.body.result.notes_candidates > 6,
    String(r.body.result.notes_candidates));

  // ---------- 8. 任务生命周期：resumed + 取消丢弃 + 重开恢复 ----------
  stubMode.delay = 1500;
  const r1 = await A.post('/notes/backlink-ai/jobs', { scope: 'all', folder_id: 0 });
  const r2 = await A.post('/notes/backlink-ai/jobs', { scope: 'all', folder_id: 0 });
  ck('POST 立即返 running + 在跑时再提交 resumed=true',
    r1.body.state === 'running' && r1.body.id === r2.body.id && r2.body.resumed === true,
    `${r1.body.state}/${r1.body.id}/${r2.body.id}/${r2.body.resumed}`);
  const mid = (await A.get('/notes/backlink-ai/jobs/latest')).body;
  ck('进行中快照：AI 阶段 / 进度 20~94 / 日志在场', mid.stage === 'ai' && mid.progress >= 20 && mid.progress < 95
    && mid.logs.some((l) => /扫描/.test(l.msg)), JSON.stringify({ stage: mid.stage, progress: mid.progress }));
  r = await A.del('/notes/backlink-ai/jobs/latest');
  ck('取消成功', r.body.ok === true && r.body.state === 'cancelled', JSON.stringify(r.body));
  ck('取消没在跑的 → ok=false', (await A.del('/notes/backlink-ai/jobs/latest')).body.ok === false);
  stubMode.delay = 0;
  await new Promise((s) => setTimeout(s, 1700));   // 等在途 AI 返回
  const jC = (await A.get('/notes/backlink-ai/jobs/latest')).body;
  ck('取消后 AI 返回 → 结果丢弃、终态 cancelled', jC.state === 'cancelled' && !jC.result
    && jC.logs.some((l) => /结果丢弃|已取消/.test(l.msg)), jC.state);

  // ---------- 9. 解析失败自动重试 ----------
  PAYLOAD = { groups: [{ keyword: 'Vite', note_ids: [b1.body.id, b2.body.id], reason: '两篇 Vite' }] };
  stubMode.badTimes = 1;
  r = await runJob(A, { scope: 'all', folder_id: 0 });
  ck('第 1 次不是 JSON → 自动重试后成功', r.body.state === 'done' && r.body.result.groups.length === 1
    && r.body.logs.some((l) => /自动重试一次/.test(l.msg)), r.body.error);
  const sent2 = JSON.parse(calls[calls.length - 1].body);
  ck('重试请求带更严格的 JSON 指令', sent2.messages[1].content.includes('你上一次的输出不是合法 JSON'));
  stubMode.badTimes = 2;
  r = await runJob(A, { scope: 'all', folder_id: 0 });
  ck('两次都坏 → 任务失败态', r.body.state === 'error' && /不是合法 JSON/.test(r.body.error), r.body.error);
  stubMode.badTimes = 0;

  // ---------- 10. 参数校验与边界 ----------
  ck('scope 非法 → 400', (await A.post('/notes/backlink-ai/jobs', { scope: 'whatever' })).status === 400);
  ck('文件夹不存在 → 400', (await A.post('/notes/backlink-ai/jobs', { scope: 'all', folder_id: 999999 })).status === 400);
  const lone = await mkFolder('AI连接-单篇', root);
  await mkNote('单篇目录里唯一的笔记', lone, '凑不够一组');
  r = await runJob(A, { scope: 'all', folder_id: lone });
  ck('候选不足 2 篇 → 任务失败态（文案带数量）',
    r.body.state === 'error' && /候选笔记只有 1 篇/.test(r.body.error), r.body.error);

  // ---------- 11. 重开弹窗：GET latest 直接给上次结果 ----------
  const jLast = (await A.get('/notes/backlink-ai/jobs/latest')).body;
  ck('重开弹窗能拿到上一份快照（state+result）', jLast.state === 'error' || jLast.state === 'done', jLast.state);

  // ---------- 12. 权限：无 notes 页的成员 403 ----------
  await fetch(`${B}/api/users`, {
    method: 'POST', headers: admin.H,
    body: JSON.stringify({ username: 'e2eblai', password: 'Blai123456', role: 'user', allowed_pages: ['life'], allowed_tabs: {} }),
  });
  const u2 = await login(B, 'e2eblai', 'Blai123456');
  ck('无 notes 权限 → meta 403', (await fetch(`${B}/api/notes/backlink-ai/meta`, { headers: u2.H })).status === 403);
  ck('无 notes 权限 → 建分析任务 403', (await fetch(`${B}/api/notes/backlink-ai/jobs`, {
    method: 'POST', headers: u2.H, body: JSON.stringify({ scope: 'all' }),
  })).status === 403);
  ck('无 notes 权限 → 查任务 403', (await fetch(`${B}/api/notes/backlink-ai/jobs/latest`, { headers: u2.H })).status === 403);
} finally {
  srv.stop();
  stub.close();
}

done();
