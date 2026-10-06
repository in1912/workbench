// E2E（v1.10.29 起；v1.10.30 改后台任务模型）：lifeOS「AI复盘IM」后端全链路。
//
// 覆盖：文件夹树 IM 篇数口径 / 标题时间快筛（范围外整篇不读、假阳性按行归零）/
//       行级时间过滤（老行不进语料）/ 语料只含子树（别的目录不串）/
//       引导词透传给 AI / JSON 解析加固（代码围栏）/ AI 未配置友好报错 /
//       **后台任务生命周期：POST /jobs 立即返回、轮询到 done、进行中快照（阶段/进度/日志）、
//       重复提交接上在跑任务（resumed）、取消（在途 AI 返回后丢弃结果）、重进页面用 latest 恢复** /
//       待办 → 行动（日=次日、周=+7、月=+30 截止，desc 带出处）/ 参数校验 / 无 life 权限 403。
//
// AI 是本地桩（http 服务）：按需回普通 JSON 或带 ```json 围栏的回包、可加延迟（验进行中状态），
// 并把收到的请求全部记下来——**语料内容断言靠读桩收到的请求体**（替身照猜的契约写、猜错也全绿；
// 子进程外部契约必须拿真输出对，桩在这里就是「AI 侧的真实输出」）。
import http from 'node:http';
import imReview from '../server/services/lifeImReviewService.js';
import { startServer, login, api, checker } from './_noteE2E.mjs';

const { ck, done } = checker();

// ---- 与 imService.fmtTime 同款：本地时区方法 + 分钟精度（与服务端同进程同 TZ，口径必然一致） ----
const fmtL = (ms) => {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const fmtD = (ms) => fmtL(ms).slice(0, 10);
const DAY = 86400000, HOUR = 3600000;

// ---- 假 AI（OpenAI 兼容）：记请求，回可切换的 payload，可设延迟（验进行中快照） ----
const calls = [];
const stubMode = { fence: false, delay: 0 };
const PAYLOAD = {
  summary: '概要-测试通过',
  highlights: ['重点-排期已定', '重点-有风险'],
  todos: [{ title: '回复张三合同', note: '10-06 张三催合同定稿' }, { title: '给李四发会议纪要', note: '10-06 李四等纪要' }],
};
const stub = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (c) => { buf += c; });
  req.on('end', () => {
    calls.push({ url: req.url, auth: req.headers.authorization || '', body: buf });
    const respond = () => {
      const content = stubMode.fence ? '```json\n' + JSON.stringify(PAYLOAD, null, 1) + '\n```' : JSON.stringify(PAYLOAD);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 100, completion_tokens: 221, total_tokens: 321 },
      }));
    };
    stubMode.delay ? setTimeout(respond, stubMode.delay) : respond();
  });
});
await new Promise((r) => stub.listen(3988, '127.0.0.1', r));

const srv = await startServer({ tag: 'imreview', port: 3987 });
const { B } = srv;

// ---- 任务助手：POST /jobs 立即回，轮询 latest 到终态 ----
const waitJob = async (A, { timeoutMs = 15000 } = {}) => {
  const t0 = Date.now();
  for (;;) {
    const r = await A.get('/life/im-review/jobs/latest');
    if (!r.body || r.body.state !== 'running') return r;
    if (Date.now() - t0 > timeoutMs) throw new Error('任务超时未完成: ' + JSON.stringify(r.body).slice(0, 240));
    await new Promise((s) => setTimeout(s, 120));
  }
};
const runJob = async (A, body) => {
  const r = await A.post('/life/im-review/jobs', body);
  if (r.status !== 200) return r;
  return waitJob(A);
};

try {
  const admin = await login(B, 'admin', 'test123456');
  const A = api(B, admin.H);

  // ---------- 0. 纯函数：标题时间戳解析 ----------
  ck('titleTs 解析标准标题', imReview.titleTs('张三-2026-10-06 09:18-公司A') === '2026-10-06 09:18',
    imReview.titleTs('张三-2026-10-06 09:18-公司A'));
  ck('titleTs 无时间戳标题返回空', imReview.titleTs('普通笔记') === '');

  // ---------- 1. 目录树：IM连接/飞书/测试A、IM连接/钉钉/测试Old、另一棵 IM连接2/测试B ----------
  // 注意：全新库会预置顶层「IM连接」（还有 general/工作/生活…种子目录）——IM 归档就长在它
  // 下面（生产同款形状）。同名再建会 400「同级下已有同名文件夹」，所以根目录**复用预置的那个**。
  const mkFolder = async (name, parent) => {
    const r = await A.post('/notes/folders', { name, parent_id: parent });
    if (!r.body.id) throw new Error(`建文件夹 ${name} 失败: ${JSON.stringify(r.body)}`);
    return r.body.id;
  };
  const seedTree = (await A.get('/notes/folders')).body;
  const findNode = (nodes, name) => {
    for (const n of nodes) {
      if (n.name === name) return n;
      const hit = findNode(n.children || [], name);
      if (hit) return hit;
    }
    return null;
  };
  const seedIm = findNode(seedTree, 'IM连接');
  const root1 = seedIm ? seedIm.id : await mkFolder('IM连接');
  const feishu = await mkFolder('飞书-e2e', root1);
  const fa = await mkFolder('测试A', feishu);
  const ding = await mkFolder('钉钉-e2e', root1);
  const fo = await mkFolder('测试Old', ding);
  const root2 = await mkFolder('IM连接2');
  const fb = await mkFolder('测试B', root2);

  // ---------- 2. 归档笔记（时间刻度：现在 / 1-3 小时前=范围内 / 40 天前=范围外） ----------
  const now = Date.now();
  const inT = (h) => fmtL(now - h * HOUR);
  const oldT = fmtL(now - 40 * DAY);
  const line = (t, who, text) => `- **${t}｜${who}**：${text}`;
  const note = (title, folder, lines) => A.post('/notes', {
    title, folder_id: folder,
    content: [`# 会话`, '', `- 会话 ID：\`oc_x\``, '', `## ${inT(1)} 同步（新增 ${lines.length} 条）`, '', ...lines].join('\n'),
  });

  // n1 张三：2 条新 + 2 条旧（行级过滤要留下新的、丢掉旧的）
  await note(`张三-${inT(2)}-测试A`, fa, [
    line(inT(2), '张三', 'INRANGE-近期A1：明天十点评审'),
    line(inT(1), '我', 'INRANGE-近期A2：我把材料发你'),
    line(oldT, '张三', 'OLDLINE-旧1：上个月的事'),
    line(oldT, '我', 'OLDLINE-旧2：更早的事'),
  ]);
  // n2 李四：3 条新
  await note(`李四-${inT(1)}-测试A`, fa, [
    line(inT(3), '李四', 'INRANGE-B1：合同定稿了'),
    line(inT(2), '李四', 'INRANGE-B2：等你回复'),
    line(inT(1), '我', 'INRANGE-B3：明天给'),
  ]);
  // n7 钱七：标题新、行全旧（生产实测的假阳性形状：官方 last_msg_time 把过滤掉的消息类型也计入）
  await note(`钱七-${inT(3)}-测试A`, fa, [line(oldT, '钱七', 'OLDLINE-假阳性')]);
  // n4 普通笔记：标题没有时间戳 → 快筛跳过（正文里有一行长成消息行也不算）
  await note('普通笔记（无时间戳标题）', fa, [line(inT(1), '某人', 'PLAINNOTE-LINE：不该被读到')]);
  // n3 王五：整篇旧（标题时间就旧 → 整篇不读）
  await note(`王五-${oldT}-测试A`, fo, [line(oldT, '王五', 'OLDLINE-整篇旧')]);
  // n5 赵六：另一棵树里的新笔记（不许串进来）
  await note(`赵六-${inT(1)}-测试B`, fb, [line(inT(1), '赵六', 'OTHERTREE-LINE：别棵树的内容')]);

  // ---------- 3. meta + AI 未配置的友好报错（任务创建是同步校验 → 立即 400） ----------
  let r = await A.get('/life/im-review/meta');
  ck('meta：4 档范围 + 默认引导词 + has_ai=false', r.status === 200 && r.body.ranges.length === 4
    && r.body.ranges.map((x) => x.days).join(',') === '1,7,14,30'
    && r.body.default_prompt.includes('"summary"') && r.body.has_ai === false, JSON.stringify(r.body).slice(0, 120));
  r = await A.post('/life/im-review/jobs', { folder_id: fa, days: 1 });
  ck('AI 未配置 → 400 且点名去哪配', r.status === 400 && /AI 尚未配置/.test(r.body.error), `${r.status} ${r.body.error}`);
  ck('没建任务时 latest 是 null', (await A.get('/life/im-review/jobs/latest')).body === null);

  // ---------- 4. 配上假 AI ----------
  r = await A.post('/ai/config', { model: 'stub-chat', base_url: 'http://127.0.0.1:3988/v1', api_key: 'sk-stub-e2e' });
  ck('配置假 AI 成功', r.status === 200 && r.body.ok, JSON.stringify(r.body));
  ck('meta.has_ai 变 true', (await A.get('/life/im-review/meta')).body.has_ai === true);

  // ---------- 5. 文件夹树的 IM 篇数口径 ----------
  r = await A.get('/life/im-review/folders');
  const find = (nodes, name) => {
    for (const n of nodes) {
      if (n.name === name) return n;
      const hit = find(n.children || [], name);
      if (hit) return hit;
    }
    return null;
  };
  const t1 = find(r.body, 'IM连接'), t2 = find(r.body, 'IM连接2');
  ck('IM连接 根累计 4 篇（测试A 3 + 测试Old 1；普通笔记不算）', t1 && t1.im_total === 4, String(t1 && t1.im_total));
  ck('测试A 直属 3 篇（钱七假阳性也在：标题认得出）', find(r.body, '测试A').im_count === 3, String(find(r.body, '测试A').im_count));
  ck('IM连接2 累计 1 篇', t2 && t2.im_total === 1, String(t2 && t2.im_total));

  // ---------- 6. 任务全流程：快筛 + 行级过滤 + 统计（含进行中快照） ----------
  stubMode.delay = 1200;   // 拉长 AI 段，验「进行中」的快照真的存在
  calls.length = 0;
  r = await A.post('/life/im-review/jobs', { folder_id: fa, days: 1 });
  ck('POST /jobs 立即返回 200 且 state=running', r.status === 200 && r.body.state === 'running' && r.body.id > 0,
    `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  const jMid = (await A.get('/life/im-review/jobs/latest')).body;
  ck('进行中快照：AI 阶段 / 进度在 40~94 之间（动态逼近，不到头）',
    jMid.state === 'running' && jMid.stage === 'ai' && jMid.progress >= 40 && jMid.progress < 95,
    JSON.stringify({ state: jMid.state, stage: jMid.stage, progress: jMid.progress }));
  ck('进行中快照：过程日志已记到语料那一步',
    jMid.logs.some((l) => /快筛：扫描 4 篇/.test(l.msg)) && jMid.logs.some((l) => /语料 \d+ 字/.test(l.msg))
    && jMid.logs.every((l) => !/AI 返回/.test(l.msg)),
    jMid.logs.map((l) => l.msg).join(' | ').slice(0, 200));
  ck('进行中快照：ai_started_at 在场（前端据此走「已等 N 秒」）', typeof jMid.ai_started_at === 'number');
  stubMode.delay = 0;
  r = await waitJob(A);
  ck('轮询到终态：done + 进度 100', r.body.state === 'done' && r.body.progress === 100
    && r.body.stage_label === '完成' && r.body.result, JSON.stringify(r.body).slice(0, 160));
  const b = r.body.result;
  ck('统计：扫描 4 / 快筛命中 3 / 会话 2（假阳性按行归零）',
    b.notes_scanned === 4 && b.notes_matched === 3 && b.conversations.length === 2,
    `scanned=${b.notes_scanned} matched=${b.notes_matched} convs=${b.conversations.length}`);
  ck('统计：消息 5 条（张三 2 + 李四 3，旧行不算）', b.lines_used === 5, String(b.lines_used));
  ck('范围回带：日报（1 天内）', b.range && b.range.days === 1 && b.range.label.includes('日报'));
  ck('AI 结果解析：概要/重点/待办', b.summary === '概要-测试通过' && b.highlights.length === 2
    && b.todos.length === 2 && b.todos[0].title === '回复张三合同', JSON.stringify(b.todos));
  ck('模型与 token 透出', b.model === 'stub-chat' && b.usage && b.usage.total_tokens === 321, JSON.stringify(b.usage));
  // matched 按标题时间新在前：李四(1小时前) > 张三(2小时前) > 钱七(3小时前)
  ck('完成日志齐：读取逐篇（新在前）+ AI 返回耗时 + 解析条数',
    r.body.logs.some((l) => /读取 1\/3：李四/.test(l.msg)) && r.body.logs.some((l) => /读取 2\/3：张三.*范围内消息 2 条/.test(l.msg))
    && r.body.logs.some((l) => /AI 返回：耗时/.test(l.msg))
    && r.body.logs.some((l) => /解析完成/.test(l.msg)), r.body.logs.map((l) => l.msg).join(' | ').slice(0, 240));

  // 语料断言：读桩收到的请求体（AI 侧真收到的才算数）
  const lastCall = () => { const c = calls[calls.length - 1]; return c ? JSON.parse(c.body) : null; };
  const sent = lastCall();
  const userMsg = sent && sent.messages[1].content;
  ck('桩收到 /v1/chat/completions + Bearer 密钥', calls.length > 0 && calls[0].url === '/v1/chat/completions'
    && calls[0].auth === 'Bearer sk-stub-e2e', JSON.stringify(calls[0] && calls[0].url));
  ck('语料含范围内的行', userMsg.includes('INRANGE-近期A1') && userMsg.includes('INRANGE-B3'));
  ck('语料不含旧行（行级过滤）', !userMsg.includes('OLDLINE-旧1') && !userMsg.includes('OLDLINE-假阳性'));
  ck('语料不含无时间戳标题的笔记与别棵树', !userMsg.includes('PLAINNOTE-LINE') && !userMsg.includes('OTHERTREE-LINE'));

  // ---------- 7. 重进页面恢复：latest 直接给 done + 结果 ----------
  r = await A.get('/life/im-review/jobs/latest');
  ck('重进页面：latest 仍是 done 且带 result（前端据此摆出结果）',
    r.body.state === 'done' && r.body.result.summary === '概要-测试通过' && typeof r.body.result.generated_at_ms === 'number',
    JSON.stringify(r.body.result && r.body.result.summary));

  // ---------- 8. 重复提交接上在跑的任务 + 取消（在途 AI 返回后丢弃） ----------
  stubMode.delay = 1600;
  const r1 = await A.post('/life/im-review/jobs', { folder_id: fa, days: 7 });
  const r2 = await A.post('/life/im-review/jobs', { folder_id: fa, days: 7 });
  ck('在跑时再提交 → 返回同一个任务且 resumed=true', r1.body.id === r2.body.id && r2.body.resumed === true
    && r2.body.state === 'running', `${r1.body.id}/${r2.body.id} ${r2.body.resumed}`);
  r = await A.del('/life/im-review/jobs/latest');
  ck('取消成功（state=cancelled）', r.body.ok === true && r.body.state === 'cancelled', JSON.stringify(r.body));
  ck('取消后再提交 → 可以开新任务（不挡）',
    (await A.post('/life/im-review/jobs', { folder_id: fa, days: 7 })).body.state === 'running');
  r = await A.del('/life/im-review/jobs/latest');
  ck('把新开的也取消掉（干净收场）', r.body.ok === true);
  stubMode.delay = 0;
  await new Promise((s) => setTimeout(s, 1800));   // 等在途的 AI 桩响应落地
  const jC = (await A.get('/life/im-review/jobs/latest')).body;
  ck('取消后 AI 返回 → 结果丢弃，终态仍是 cancelled 且日志说破',
    jC.state === 'cancelled' && jC.logs.some((l) => /结果丢弃|任务已取消/.test(l.msg)) && !jC.result,
    JSON.stringify({ state: jC.state, last: jC.logs.slice(-2).map((l) => l.msg) }));
  ck('取消一个没在跑的 → ok=false', (await A.del('/life/im-review/jobs/latest')).body.ok === false);

  // ---------- 9. 引导词透传 ----------
  r = await runJob(A, { folder_id: fa, days: 1, prompt: 'PROMPT-MARKER-XYZ：只要跟合同有关的' });
  ck('自定义引导词原样透传给 AI', r.body.state === 'done' && lastCall().messages[1].content.includes('PROMPT-MARKER-XYZ'));

  // ---------- 10. JSON 解析加固（```json 围栏） ----------
  stubMode.fence = true;
  r = await runJob(A, { folder_id: fa, days: 1 });
  ck('AI 回包带代码围栏仍解析成功', r.body.state === 'done' && r.body.result.summary === '概要-测试通过',
    JSON.stringify(r.body.result && r.body.result.summary));
  stubMode.fence = false;

  // ---------- 11. 参数校验（同步 400，不建任务） ----------
  ck('days=5 → 400', (await A.post('/life/im-review/jobs', { folder_id: fa, days: 5 })).status === 400);
  ck('缺 days → 400', (await A.post('/life/im-review/jobs', { folder_id: fa })).status === 400);
  ck('文件夹不存在 → 400', (await A.post('/life/im-review/jobs', { folder_id: 999999, days: 1 })).status === 400);

  // ---------- 12. 子树聚合 + 空范围（空语料是任务失败态，不是 400） ----------
  r = await runJob(A, { folder_id: root1, days: 30 });
  ck('从 IM连接 根跑：子树 5 篇扫描 / 命中 3（王五 40 天前连 30 天也不进）',
    r.body.state === 'done' && r.body.result.notes_scanned === 5 && r.body.result.notes_matched === 3,
    `scanned=${r.body.result && r.body.result.notes_scanned} matched=${r.body.result && r.body.result.notes_matched}`);
  ck('别棵树没串进来（会话数仍 2）', r.body.result.conversations.length === 2);
  r = await runJob(A, { folder_id: fo, days: 30 });
  ck('只有旧笔记的目录 → 任务失败态且带扫描统计',
    r.body.state === 'error' && /扫描 1 篇/.test(r.body.error) && /没有提取到任何聊天消息/.test(r.body.error),
    r.body.error);
  ck('失败也留了过程日志（快筛那条）', r.body.logs.some((l) => /快筛/.test(l.msg)));

  // ---------- 13. 待办 → 行动 ----------
  const dueOf = (days) => fmtD(now + days * DAY);
  ck('todos：非法 days → 400', (await A.post('/life/im-review/todos', { days: 5, items: [{ title: 'x' }] })).status === 400);
  ck('todos：空 items → 400', (await A.post('/life/im-review/todos', { days: 7, items: [] })).status === 400);
  ck('todos：空白标题 → 400', (await A.post('/life/im-review/todos', { days: 7, items: [{ title: '   ' }] })).status === 400);
  ck('todos：超 50 条 → 400', (await A.post('/life/im-review/todos', { days: 7, items: Array.from({ length: 51 }, () => ({ title: 'x' })) })).status === 400);

  r = await A.post('/life/im-review/todos', {
    days: 7,
    items: [{ title: '回复张三合同', note: '10-06 张三催合同定稿' }, { title: '给李四发会议纪要' }],
  });
  ck('周待办加入成功（2 条，截止今天+7）', r.status === 200 && r.body.created === 2 && r.body.due_date === dueOf(7),
    JSON.stringify(r.body));
  let acts = (await A.get(`/life/actions?task_type=daily_todo&from=${dueOf(7)}&to=${dueOf(7)}`)).body;
  ck('行动页查得到这 2 条（复用 todos）', acts.length === 2 && acts.some((a) => a.title === '回复张三合同'), JSON.stringify(acts.map((a) => a.title)));
  ck('行动 desc 带出处', acts.find((a) => a.title === '回复张三合同').desc.includes('张三催合同'), '');

  r = await A.post('/life/im-review/todos', { days: 1, items: [{ title: '日待办-例' }] });
  ck('日待办截止次日', r.body.due_date === dueOf(1), r.body.due_date);
  r = await A.post('/life/im-review/todos', { days: 30, items: [{ title: '月待办-例' }] });
  ck('月待办截止今天+30', r.body.due_date === dueOf(30), r.body.due_date);
  r = await A.post('/life/im-review/todos', { days: 14, items: [{ title: '双周待办-例' }] });
  ck('双周待办截止今天+14', r.body.due_date === dueOf(14), r.body.due_date);

  // ---------- 14. 权限：无 life 页的成员 403 ----------
  await fetch(`${B}/api/users`, {
    method: 'POST', headers: admin.H,
    body: JSON.stringify({ username: 'e2eimr', password: 'Imr123456', role: 'user', allowed_pages: ['notes'], allowed_tabs: {} }),
  });
  const u2 = await login(B, 'e2eimr', 'Imr123456');
  ck('无 life 权限 → meta 403', (await fetch(`${B}/api/life/im-review/meta`, { headers: u2.H })).status === 403);
  ck('无 life 权限 → 建任务 403', (await fetch(`${B}/api/life/im-review/jobs`, {
    method: 'POST', headers: u2.H, body: JSON.stringify({ folder_id: fa, days: 1 }),
  })).status === 403);
  ck('无 life 权限 → 查任务 403', (await fetch(`${B}/api/life/im-review/jobs/latest`, { headers: u2.H })).status === 403);
} finally {
  srv.stop();
  stub.close();
}

done();
