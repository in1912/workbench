// E2E（v1.10.22）：钉钉 IM 连接器 —— 官方 dws CLI 通道的全链路（不联网，CLI 是替身）。
//
// 替身机制见 scripts/dws-stub.cjs 头注释：DWS_PATH=node.exe + NODE_OPTIONS=--require 替身，
// 每次「dws」子进程其实都是 node 先跑替身。替身认的输出口径从真 CLI 源码钉来，
// 所以这里跑通的就是真传输层（spawn / DWS_CONFIG_DIR 隔离 / 信封拆包 / 设备流输出解析）。
//
// 覆盖：平台清单 / 免凭证建连接器 / 设备流登录与身份落库 / 未登录闸 /
//       组织开关未开的失败路径（面板/同步预检/last_error 三处都带真原因）/
//       会话发现登记 / 群聊与单聊的拉取路由（按调用记账断言）/
//       同步→笔记（标题规则 / IM连接/钉钉/<备注名> 目录 / #钉钉 标签 / 倒序排版 /
//       我-识别 / 消息类型渲染 / 同 ID 去重）/ 增量第二轮 / 排版方向切换 /
//       并发 409 / 单会话失败隔离 / 解除授权（CLI 目录一起清）/ 重新登录 / 删除连接器。
import fs from 'node:fs';
import path from 'node:path';
import { startServer, login, api, checker, ROOT } from './_noteE2E.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STUB = (ROOT + '/scripts/dws-stub.cjs').replace(/\\/g, '/');
process.env.DWS_PATH = process.execPath;                                        // 「dws 二进制」= node
process.env.NODE_OPTIONS = ((process.env.NODE_OPTIONS || '') + ' --require ' + STUB).trim();

const { B, DATA, stop } = await startServer({ tag: 'im-ding', port: 3997 });
const s = checker();
const admin = await login(B, 'admin', 'test123456');
const A = api(B, admin.H);

const callsLog = () => {
  try {
    return fs.readFileSync(path.join(DATA, 'dws-stub-calls.jsonl'), 'utf8').trim().split('\n')
      .filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
};
const cfgDir = (id) => path.join(DATA, 'dws-config', String(id));
const noteOf = async (id) => (await A.get('/notes/' + id)).body;

try {
  // ---------- ① 平台清单 ----------
  let r = await A.get('/im/providers');
  const dt = (r.body || []).find((p) => p.key === 'dingtalk') || {};
  s.ck('钉钉在平台清单里且 ready', r.status === 200 && dt.ready === true, JSON.stringify(r.body.map((p) => [p.key, p.ready])));
  s.ck('钉钉标注为设备流授权（前端表单按它分叉）', dt.auth === 'device', String(dt.auth));
  s.ck('钉钉的 hint 讲的是 CLI 通道与边界（界面「怎么准备」靠它）', /CLI/.test(dt.hint || ''), String(dt.hint || '').slice(0, 80));
  s.ck('企业微信在平台清单里且 ready（v1.10.25 起走官方 wecom-cli 通道）', ((r.body || []).find((p) => p.key === 'wecom') || {}).ready === true);

  // ---------- ② 建连接器：不需要任何应用凭证 ----------
  r = await A.post('/im/connectors', { provider: 'dingtalk', label: '公司钉钉', app_id: 'cli_不该被存', app_secret: 'x' });
  const id = r.body.id;
  s.ck('只起个备注名就能建钉钉连接器', r.status === 200 && id > 0, JSON.stringify(r.body));
  s.ck('顺手塞进来的应用凭证不会被存（钉钉没有这一说）', r.body.app_id === '' && r.body.has_secret === false, JSON.stringify({ a: r.body.app_id, s: r.body.has_secret }));
  s.ck('新建即「未授权」（等扫码）', r.body.status === 'new' && r.body.authorized === false);
  r = await A.post(`/im/connectors/${id}/authorize`, {});
  s.ck('钉钉连接器点「去授权」→ 400 并指去设备流', r.status === 400 && /设备流|扫码/.test(r.body.error || ''), JSON.stringify(r.body));

  // ---------- ③ 没登录就同步：预检把状态打回 expired ----------
  r = await A.post(`/im/connectors/${id}/sync`, { since_days: 30 });
  s.ck('未登录就同步 → 400 且提示重新扫码', r.status === 400 && /钉钉登录已失效|重新扫码/.test(r.body.error || ''), JSON.stringify(r.body));
  r = await A.get('/im/connectors');
  s.ck('同步预检把连接器标成 expired（登录失效在界面上看得见）', ((r.body || []).find((c) => c.id === id) || {}).status === 'expired');

  // ---------- ④ 预检估算（钉钉口径：pace 200ms、会话列表每页 100） ----------
  r = await A.get(`/im/connectors/${id}/sync-preview?since_days=30`);
  s.ck('sync-preview 返回钉钉口径（pace 200ms）', r.status === 200 && r.body.pace_ms === 200 && r.body.provider === 'dingtalk', JSON.stringify(r.body));
  s.ck('还没有会话时估算 = 会话列表 1 次', r.body.est_requests_min === 1 && r.body.est_requests_max === 1, JSON.stringify([r.body.est_requests_min, r.body.est_requests_max]));

  // ---------- ⑤ 设备流登录：发起 → 轮询 → 身份落库 ----------
  r = await A.post(`/im/connectors/${id}/dingtalk-login`, {});
  s.ck('POST dingtalk-login 发起成功', r.status === 200 && r.body.started === true, JSON.stringify(r.body));
  let lp = null;
  for (let i = 0; i < 40; i++) {
    lp = (await A.get(`/im/connectors/${id}/dingtalk-login`)).body;
    if (lp && !lp.running && lp.authenticated) break;
    await sleep(250);
  }
  s.ck('GET dingtalk-login 轮询到登录完成（authenticated=true）', !!lp && lp.authenticated === true && lp.running === false, JSON.stringify(lp).slice(0, 160));
  s.ck('登录面板拿到了官方验证链接（替身按真 CLI 的 stderr 格式给）', /https:\/\/login\.dingtalk\.com\/oauth2\/device\/verify\.htm\?/.test((lp || {}).url || ''), String((lp || {}).url || ''));
  s.ck('登录面板拿到了授权码', ((lp || {}).code || '') === 'E2E1-ABCD', String((lp || {}).code || ''));
  const c1 = (lp || {}).connector || {};
  s.ck('身份在「成功被看见」的那一刻落库（状态/企业/用户/openDingTalkId）',
    c1.status === 'authorized' && c1.authorized === true && c1.tenant_key === '测试企业' && c1.user_name === '测试用户' && c1.user_open_id === 'D-e2e-self-0001',
    JSON.stringify({ s: c1.status, t: c1.tenant_key, u: c1.user_name, o: c1.user_open_id }));
  s.ck('令牌本体没进工作台库（在 CLI 自己的加密目录里）', c1.has_secret === false && !c1.access_token);
  r = await A.get(`/im/connectors/${id}/logs`);
  s.ck('日志里记了登录成功（企业名）', (r.body || []).some((l) => /钉钉登录成功/.test(l.message || '') && /测试企业/.test(l.message || '')));
  s.ck('CLI 的令牌落在按连接器隔离的目录里', fs.existsSync(path.join(cfgDir(id), 'token.json')));

  // ---------- ⑥ 别的平台不许走钉钉登录 ----------
  r = await A.post('/im/connectors', { provider: 'feishu', label: '公司飞书', app_id: 'cli_x', app_secret: 'sec', redirect_uri: B + '/api/im/callback' });
  const fid = r.body.id;
  r = await A.post(`/im/connectors/${fid}/dingtalk-login`, {});
  s.ck('飞书连接器点钉钉登录 → 400', r.status === 400 && /不是钉钉/.test(r.body.error || ''), JSON.stringify(r.body));

  // ---------- ⑦ 同步：发现 + 群/单聊分流 + 单会话失败隔离 ----------
  r = await A.post(`/im/connectors/${id}/chats`, { chat_id: 'cidE2ECRASH0000001', chat_name: '坏会话', chat_mode: 'group' });
  s.ck('手动登记一个「CLI 会吐非 JSON」的会话（单会话失败隔离用）', r.status === 200 && r.body.length === 1);
  r = await A.post(`/im/connectors/${id}/sync`, { since_days: 30 });
  const st1 = r.body || {};
  s.ck('同步整体 200 且跑完', r.status === 200 && st1.done === true, JSON.stringify(st1).slice(0, 160));
  s.ck('三个会话都处理了（发现的 2 个 + 手动 1 个）', st1.chats === 3 && st1.total === 3, JSON.stringify({ c: st1.chats, t: st1.total }));
  s.ck('坏会话只坏它自己：其余会话照常落库', st1.errors.length === 1 && st1.messages === 5 && st1.notes === 2, JSON.stringify({ e: st1.errors, m: st1.messages, n: st1.notes }));
  r = await A.get(`/im/connectors/${id}/logs`);
  s.ck('会话列表日志是钉钉口径（参数化过的那行）', (r.body || []).some((l) => /会话列表：钉钉返回 2 个会话（其中单聊 1 个）/.test(l.message || '')));

  // 拉取路由：群走 +chat-messages、单聊走 search-advanced —— 最容易悄悄退化的分叉，按调用记账钉死
  const calls1 = callsLog();
  const listCall = calls1.find((c) => c.args.includes('+chat-list'));
  s.ck('会话列表用的 +chat-list，且 --types group,p2p（真实 CLI 默认只回群聊，漏了 p2p 单聊全丢）',
    !!listCall && listCall.args.includes('--page-all') && listCall.args.includes('--types') && listCall.args[listCall.args.indexOf('--types') + 1] === 'group,p2p',
    JSON.stringify(listCall && listCall.args));
  const gCall = calls1.find((c) => c.args.includes('+chat-messages') && c.args.includes('cidE2EGROUP0000000001'));
  s.ck('群聊拉取走 chat +chat-messages --group <cid>，范围模式不带 --direction（真实 CLI 互斥校验）',
    !!gCall && gCall.args.includes('--group') && gCall.args.includes('--start') && !gCall.args.includes('--direction'), JSON.stringify(gCall && gCall.args));
  const pCall = calls1.find((c) => c.args.includes('search-advanced') && c.args.includes('cidE2EP2P00000000002'));
  s.ck('单聊拉取走 chat message search-advanced --conversation-ids', !!pCall && pCall.args.includes('--conversation-ids'), JSON.stringify(pCall && pCall.args));
  s.ck('所有 CLI 调用都发生在本连接器自己的 DWS_CONFIG_DIR 里（多账号不互踩）',
    calls1.length > 0 && calls1.every((c) => c.cfg === cfgDir(id)), JSON.stringify([...new Set(calls1.map((c) => c.cfg))]));
  const caExpect = path.join(ROOT, 'server', 'dws', 'ca-bundle.crt');
  s.ck('每次 CLI 调用都带上了随包根证书（SSL_CERT_FILE；容器缺系统 CA 会 x509 unknown authority）',
    calls1.length > 0 && calls1.every((c) => c.ca === caExpect), JSON.stringify([...new Set(calls1.map((c) => c.ca))]));

  r = await A.get(`/im/connectors/${id}/chats`);
  const gRow = (r.body || []).find((c) => c.chat_id === 'cidE2EGROUP0000000001');
  const pRow = (r.body || []).find((c) => c.chat_id === 'cidE2EP2P00000000002');
  const xRow = (r.body || []).find((c) => c.chat_id === 'cidE2ECRASH0000001');
  s.ck('两个会话都登记上并各挂了笔记', !!gRow && !!pRow && !!gRow.note_id && !!pRow.note_id, JSON.stringify((r.body || []).map((c) => [c.chat_id, c.note_id])));
  s.ck('会话计数：群 3 条、单聊 2 条', (gRow || {}).msg_count === 3 && (pRow || {}).msg_count === 2, JSON.stringify([gRow && gRow.msg_count, pRow && pRow.msg_count]));
  s.ck('坏会话留下失败原因，正常会话 last_error 为空', /JSON/.test((xRow || {}).last_error || '') && !((gRow || {}).last_error || ''), JSON.stringify((xRow || {}).last_error));

  // ---------- ⑦b 组织没开「允许成员通过 CLI 访问个人数据」：失败原因要一路亮到用户脸上 ----------
  // 生产实测（2026-10-06）：OAuth 扫码那步会先打出「授权成功!」，最后 Step 4 被组织开关拒掉、
  // exit 2。原来面板只说「登录没有完成（超时或被取消）」，用户就在「授权成功」和「登录已失效」
  // 之间打转。现在要求：登录面板、同步预检报错、卡片 last_error 三处都带上可执行的真原因。
  // （放在 calls1 断言之后：这条连接器的登录调用会进替身记账，别污染上面的 cfg/ca 全称断言。）
  r = await A.post('/im/connectors', { provider: 'dingtalk', label: '没开开关的公司' });
  const idNo = r.body.id;
  fs.mkdirSync(path.join(DATA, 'dws-config', String(idNo)), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'dws-config', String(idNo), 'fail-login'), '1');
  r = await A.post(`/im/connectors/${idNo}/dingtalk-login`, {});
  s.ck('组织开关没开：登录照样能发起（失败发生在扫码之后那一步）', r.status === 200 && r.body.started === true, JSON.stringify(r.body));
  await sleep(400);   // 替身当场以 exit 2 退出
  const lpF = (await A.get(`/im/connectors/${idNo}/dingtalk-login`)).body;
  s.ck('登录面板亮出可执行原因（开管理员开关），不再猜「超时或被取消」',
    lpF.authenticated === false && /允许成员通过钉钉 CLI 访问个人数据/.test(lpF.errorText || '') && /温泉/.test(lpF.errorText || ''),
    String(lpF.errorText || '').slice(0, 220));
  r = await A.post(`/im/connectors/${idNo}/sync`, { since_days: 7 });
  s.ck('同步预检的报错捎上真原因（重新扫码也过不了的事，得把开关说清楚）',
    r.status === 400 && /钉钉登录已失效/.test(r.body.error || '') && /允许成员通过钉钉 CLI 访问个人数据/.test(r.body.error || ''),
    JSON.stringify(r.body).slice(0, 240));
  r = await A.get('/im/connectors');
  s.ck('卡片上的 last_error 也带原因', /允许成员通过钉钉 CLI 访问个人数据/.test((((r.body || []).find((c) => c.id === idNo)) || {}).last_error || ''),
    String((((r.body || []).find((c) => c.id === idNo)) || {}).last_error || '').slice(0, 220));
  r = await A.del(`/im/connectors/${idNo}`);
  s.ck('删掉失败路径的临时连接器', r.status === 200, JSON.stringify(r.body));

  // ---------- ⑦c CLI 回错误信封（裸 {error} + exit 0）：必须当失败抛，不许「0 个会话 = 成功」 ----------
  // 2026-10-06 生产缺陷的回归钉：真实 CLI 对认不出的捷径/被拒的参数回 裸 {error:{...}} 且 exit 0，
  // 旧代码只认 j.data → 解析成空列表 → 同步「成功」且 0 会话（两条连接器全空就是这么来的）。
  r = await A.post('/im/connectors', { provider: 'dingtalk', label: '信封错的公司' });
  const idErr = r.body.id;
  r = await A.post(`/im/connectors/${idErr}/dingtalk-login`, {});
  await sleep(400);   // 替身当场写 device-flow 标记；随后的 auth status 轮询把它升成令牌
  fs.writeFileSync(path.join(DATA, 'dws-config', String(idErr), 'fail-list'), '1');
  r = await A.post(`/im/connectors/${idErr}/sync`, { since_days: 7 });
  s.ck('CLI 错误信封 → 同步明确失败（不再静默成功 0 会话）',
    r.status >= 400 && /模拟未知捷径/.test(r.body.error || ''), JSON.stringify(r.body).slice(0, 240));
  r = await A.get('/im/connectors');
  s.ck('错误信封的原因留在卡片 last_error 上', /模拟未知捷径/.test((((r.body || []).find((c) => c.id === idErr)) || {}).last_error || ''),
    String((((r.body || []).find((c) => c.id === idErr)) || {}).last_error || '').slice(0, 200));
  r = await A.del(`/im/connectors/${idErr}`);
  s.ck('删掉错误信封路径的临时连接器', r.status === 200, JSON.stringify(r.body));

  // ---------- ⑦d 防静默两道闸：形状漂移 / 时间字段漂移必须大声失败，不许「0 条 = 跳过」 ----------
  // 2026-10-06 生产缺陷（会话名能拉到、内容拉不到）的另一半根因模拟：CLI 真在翻页（每会话 ~50 秒），
  // 但解析层认不出真实输出形状 / 字段名 → 静默按「0 条新消息」跳过 → 笔记一个不建、游标一个不推进。
  // 闸①：账本声明 count>0 却一行都认不出 → 抛错（带顶层字段名样本）；闸②：行认出但时间全解析失败 → 抛错（带首行字段名）。
  r = await A.post('/im/connectors', { provider: 'dingtalk', label: '形状漂移公司' });
  const idDrift = r.body.id;
  r = await A.post(`/im/connectors/${idDrift}/dingtalk-login`, {});
  await sleep(400);
  fs.writeFileSync(path.join(DATA, 'dws-config', String(idDrift), 'shape-drift'), '1');
  r = await A.post(`/im/connectors/${idDrift}/sync`, { since_days: 7 });
  s.ck('闸①形状漂移：会话级失败被抛出（不再静默 0 条）',
    r.status === 200 && (r.body.errors || []).some((e) => /声明 5 条但一条都没认出来/.test(e) && /weirdRows/.test(e)),
    JSON.stringify(r.body).slice(0, 240));
  r = await A.get('/im/connectors');
  s.ck('闸①的原因带字段名样本、留在卡片 last_error 上',
    /声明 5 条但一条都没认出来/.test((((r.body || []).find((c) => c.id === idDrift)) || {}).last_error || ''),
    String((((r.body || []).find((c) => c.id === idDrift)) || {}).last_error || '').slice(0, 240));
  fs.rmSync(path.join(DATA, 'dws-config', String(idDrift), 'shape-drift'));
  fs.writeFileSync(path.join(DATA, 'dws-config', String(idDrift), 'time-drift'), '1');
  await sleep(1200);   // 分轮规则按秒比较 last_sync_at 与 round：两轮贴在同一秒里，会话会被判「本轮已处理」而跳过
  r = await A.post(`/im/connectors/${idDrift}/sync`, { since_days: 7 });
  s.ck('闸②时间字段漂移：同样大声失败（带首行字段名）',
    r.status === 200 && (r.body.errors || []).some((e) => /时间字段全部解析失败/.test(e) && /sentAt/.test(e)),
    JSON.stringify(r.body).slice(0, 240));
  r = await A.del(`/im/connectors/${idDrift}`);
  s.ck('删掉漂移演算的临时连接器', r.status === 200, JSON.stringify(r.body));

  // ---------- ⑧ 笔记本体：目录 / 标题 / 标签 / 抬头 / 排版 / 我-识别 / 消息类型 ----------
  const gn = await noteOf(gRow.note_id);
  const pn = await noteOf(pRow.note_id);
  s.ck('群笔记落在 IM连接/钉钉/<备注名>', gn.folder_path === 'IM连接/钉钉/公司钉钉', gn.folder_path);
  s.ck('单聊笔记也在同一个连接器目录', pn.folder_path === 'IM连接/钉钉/公司钉钉', pn.folder_path);
  s.ck('标题规则：对方姓名-日期时间-连接器备注名（群）', /^钉钉测试群-\d{4}-\d{2}-\d{2} \d{2}:\d{2}-公司钉钉$/.test(gn.title || ''), gn.title);
  s.ck('标题规则（单聊，姓名=会话列表里的对方名）', /^王五-\d{4}-\d{2}-\d{2} \d{2}:\d{2}-公司钉钉$/.test(pn.title || ''), pn.title);
  s.ck('平台标签挂在 manual 档（不吃正文重算）', (gn.tags || []).includes('钉钉') && (pn.tags || []).includes('钉钉'), JSON.stringify([gn.tags, pn.tags]));
  s.ck('抬头：来源=钉钉（测试用户）、授权企业、会话 ID、标签行',
    gn.content.includes('- 来源：钉钉（测试用户）') && gn.content.includes('- 授权企业：测试企业')
    && gn.content.includes('- 会话 ID：`cidE2EGROUP0000000001`') && gn.content.includes('- 标签：#钉钉'));
  s.ck('抬头写明「新消息排在最上面」', gn.content.includes('新消息排在最上面'));
  const gLines = gn.content.split('\n').filter((l) => l.startsWith('- **'));
  s.ck('群笔记 3 条消息行：我（引用）/张三/李四（图片）各就各位',
    gLines.length === 3 && gLines.some((l) => /｜我\*\*：引用：被引用的原句$/.test(l))
      && gLines.some((l) => /｜张三\*\*：群聊第一条$/.test(l)) && gLines.some((l) => /｜李四\*\*：\[图片\]$/.test(l)),
    JSON.stringify(gLines));
  s.ck('段内倒序：最新的李四排在张三前面', gn.content.indexOf('李四') < gn.content.indexOf('张三'), '');
  const pLines = pn.content.split('\n').filter((l) => l.startsWith('- **'));
  s.ck('单聊笔记 2 条消息行（同 ID 的重复行被去重）', pLines.length === 2, JSON.stringify(pLines));
  s.ck('单聊的发送者统一叫「对方」，文件消息带文件名', pLines.every((l) => /｜对方\*\*：/.test(l)) && pLines.some((l) => l.endsWith('[文件 报表.xlsx]')), JSON.stringify(pLines));
  s.ck('单聊抬头：会话类型=单聊', pn.content.includes('- 会话类型：单聊'));

  // ---------- ⑨ 排版方向切换（共享的 normalizeImNotes 对钉钉笔记同样生效） ----------
  r = await A.put(`/im/connectors/${id}`, { note_order: 'asc' });
  s.ck('切到 asc 成功', r.status === 200 && r.body.note_order === 'asc');
  const gnAsc = await noteOf(gRow.note_id);
  s.ck('切完后老笔记立刻重排成正序（张三在李四前）', gnAsc.content.indexOf('张三') < gnAsc.content.indexOf('李四'), '');
  r = await A.put(`/im/connectors/${id}`, { note_order: 'desc' });
  const gnDesc = await noteOf(gRow.note_id);
  s.ck('切回 desc 又变回倒序', gnDesc.content.indexOf('李四') < gnDesc.content.indexOf('张三'), '');

  // ---------- ⑩ 预检估算（有进度之后：2 增量 + 1 首次） ----------
  r = await A.get(`/im/connectors/${id}/sync-preview?since_days=30`);
  const pv = r.body || {};
  s.ck('估算下限：列表 1 页 + 每会话至少 1 次 = 4', pv.est_requests_min === 4, String(pv.est_requests_min));
  s.ck('估算上限：首次同步的会话按翻满 60 页算（1+2+60=63）', pv.est_requests_max === 63, String(pv.est_requests_max));
  s.ck('耗时按 200ms/请求折算（4→1s、63→13s）', pv.est_seconds_min === 1 && pv.est_seconds_max === 13, JSON.stringify([pv.est_seconds_min, pv.est_seconds_max]));

  // ---------- ⑪ 第二轮同步：只取新消息 ----------
  // 先隔 1 秒以上：chatsForRound 按「last_sync_at >= round 就跳过」判本轮该做谁，
  // 两次同步落在同一秒里会把所有会话都判成「本轮已处理」（真实行为，不是缺陷）。
  await sleep(1100);
  r = await A.post(`/im/connectors/${id}/sync`, { since_days: 30 });
  const st2 = r.body || {};
  s.ck('第二轮只新增 2 条（每会话 1 条），不新建笔记', st2.messages === 2 && st2.notes === 0 && st2.done === true, JSON.stringify(st2).slice(0, 140));
  const gn2 = await noteOf(gRow.note_id);
  const heads = gn2.content.split('\n').filter((l) => /^## .+ 同步（新增 /.test(l));
  s.ck('群笔记现在有两个同步段，新的排在最上面', heads.length === 2 && /新增 1 条/.test(heads[0]) && gn2.content.indexOf(heads[0]) < gn2.content.indexOf(heads[1]), JSON.stringify(heads));
  s.ck('新段里是赵六那条新消息', gn2.content.includes('｜赵六**：群里新来的'), '');
  s.ck('老段原样还在（张三那条没丢）', gn2.content.includes('｜张三**：群聊第一条'), '');
  r = await A.get(`/im/connectors/${id}/chats`);
  const g2 = (r.body || []).find((c) => c.chat_id === 'cidE2EGROUP0000000001');
  const p2 = (r.body || []).find((c) => c.chat_id === 'cidE2EP2P00000000002');
  s.ck('游标推进：群 4 条、单聊 3 条', (g2 || {}).msg_count === 4 && (p2 || {}).msg_count === 3, JSON.stringify([g2 && g2.msg_count, p2 && p2.msg_count]));

  // ---------- ⑫ 并发互斥：同一条连接器同时只跑一个同步 ----------
  const [ra, rb] = await Promise.all([
    A.post(`/im/connectors/${id}/sync`, { since_days: 30 }),
    A.post(`/im/connectors/${id}/sync`, { since_days: 30 }),
  ]);
  const codes = [ra.status, rb.status].sort();
  s.ck('两发并发同步：一发 200、另一发 409（明确说正在同步）', codes[0] === 200 && codes[1] === 409 && /正在同步/.test((ra.body.error || '') + (rb.body.error || '')), JSON.stringify(codes));

  // ---------- ⑬ 解除授权：CLI 目录一起清、状态回 new、同步被预检拦下 ----------
  r = await A.post(`/im/connectors/${id}/revoke`, {});
  s.ck('解除授权回到 new，身份字段清空', r.status === 200 && r.body.status === 'new' && r.body.authorized === false && r.body.user_name === '' && r.body.tenant_key === '', JSON.stringify(r.body).slice(0, 160));
  s.ck('CLI 的凭证目录被整目录删掉', !fs.existsSync(cfgDir(id)));
  r = await A.get(`/im/connectors/${id}/dingtalk-login`);
  s.ck('登录态确实没了（替身的 auth status 读不到令牌）', r.status === 200 && r.body.authenticated === false, JSON.stringify(r.body).slice(0, 120));
  r = await A.post(`/im/connectors/${id}/sync`, { since_days: 30 });
  s.ck('解除授权后同步 → 400 钉钉登录已失效', r.status === 400 && /钉钉登录已失效/.test(r.body.error || ''), JSON.stringify(r.body));
  r = await A.get('/im/connectors');
  s.ck('状态标成 expired（重新扫码后才会翻回来）', ((r.body || []).find((c) => c.id === id) || {}).status === 'expired');

  // ---------- ⑭ 重新登录 + 删除连接器 ----------
  r = await A.post(`/im/connectors/${id}/dingtalk-login`, {});
  let lp2 = null;
  for (let i = 0; i < 40; i++) {
    lp2 = (await A.get(`/im/connectors/${id}/dingtalk-login`)).body;
    if (lp2 && !lp2.running && lp2.authenticated) break;
    await sleep(250);
  }
  s.ck('重新扫码又回到已授权', (((lp2 || {}).connector) || {}).status === 'authorized', JSON.stringify(((lp2 || {}).connector) || {}).slice(0, 120));
  s.ck('CLI 凭证目录重新建了出来', fs.existsSync(path.join(cfgDir(id), 'token.json')));
  r = await A.del(`/im/connectors/${id}`);
  s.ck('删除连接器成功', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
  // 删除接口对 CLI 凭证目录是**异步清**（不让删除本身被 CLI 卡住），这里轮询等它清完
  let dirGone = false;
  for (let i = 0; i < 20; i++) { dirGone = !fs.existsSync(cfgDir(id)); if (dirGone) break; await sleep(150); }
  s.ck('删除时 CLI 凭证目录一并清掉（异步，稍等即清）', dirGone);
  r = await A.del(`/im/connectors/${fid}`);
  s.ck('顺手删掉本轮的飞书连接器', r.status === 200, String(r.status));
} catch (e) {
  console.error('用例异常：', e && e.stack ? e.stack : e);
  s.ck('用例未抛异常', false, String(e && e.message));
} finally {
  s.done();
  stop();
}
