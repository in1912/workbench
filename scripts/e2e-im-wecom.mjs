// E2E（v1.10.25）：企业微信 IM 连接器 —— 官方 wecom-cli 通道的全链路（不联网，CLI 是替身）。
//
// 替身机制见 scripts/wecom-stub.cjs 头注释：WECOM_PATH=<e2e 现写的 .cmd 壳>，壳里 node --require
// 替身。认的口径从真 CLI（@wecom/cli 1.3.4）实测钉来（信封/853006/850016/仅群聊枚举/7 天窗/
// 游标分页），所以这里跑通的就是真传输层（spawn .cmd + shell:true / WECOM_CLI_CONFIG_DIR 隔离 /
// 信封剥离 / PTY 授权桥）。
//
// 覆盖：平台清单 / 凭证建连接器 / 未验证闸 / 验证授权（PTY 桥喂 Bot ID+Secret、身份落库、
//       10 人门槛提前探测）/ 错凭证失败路径 / 联系人搜索+登记单聊 / 群聊自动发现 /
//       同步→笔记（标题规则 / IM连接/企业微信/<备注名> 目录 / #企业微信 标签 / 倒序排版 /
//       我-识别 / 消息类型渲染 / 游标分页 / 7 天窗钳位）/ 增量第二轮 / 853006 门槛 /
//       并发 409 / 单会话失败隔离 / 解除授权（CLI 目录整删）/ 重新验证 / 删除连接器。
import fs from 'node:fs';
import path from 'node:path';
import { startServer, login, api, checker, ROOT } from './_noteE2E.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 「wecom-cli 二进制」= 一个 .cmd 壳（真 CLI 在 Windows 上也是 npm 装的 .cmd，服务器走的同一条路：
// runWecom 认 .cmd → shell:true；PTY 桥认 .cmd → cmd /c 包裹）。壳里给 node 一个真实主脚本 ——
// 不能让 node 直接扮 CLI：node 会把 argv[1]（'auth'/'chat'）当主脚本去解析，而这在 --require
// 替身运行之前就已定死（node 24 实测 Cannot find module 'auth'）。化身本身仍在 --require 的替身里做。
const STUB = (ROOT + '/scripts/wecom-stub.cjs').replace(/\\/g, '/');
const BINDIR = path.join(ROOT, 'data', `tmp-wecom-cli-${process.pid}`);
fs.rmSync(BINDIR, { recursive: true, force: true });
fs.mkdirSync(BINDIR, { recursive: true });
const ENTRY = (BINDIR + '\\entry.cjs').replace(/\\/g, '/');
fs.writeFileSync(ENTRY, '// no-op 主脚本：给 node 一个可解析的入口，CLI 化身在 --require 的替身里\n');
fs.writeFileSync(path.join(BINDIR, 'wecom-cli.cmd'), `@echo off\r\n"${process.execPath}" --require "${STUB}" "${ENTRY}" %*\r\n`);
process.env.WECOM_PATH = path.join(BINDIR, 'wecom-cli.cmd');

const { B, DATA, stop } = await startServer({ tag: 'im-wecom', port: 3998 });
const s = checker();
const admin = await login(B, 'admin', 'test123456');
const A = api(B, admin.H);

const callsLog = () => {
  try {
    return fs.readFileSync(path.join(DATA, 'wecom-stub-calls.jsonl'), 'utf8').trim().split('\n')
      .filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
};
const cfgDir = (id) => path.join(DATA, 'wecom-config', String(id));
const noteOf = async (id) => (await A.get('/notes/' + id)).body;
// 'YYYY-MM-DD HH:MM:SS'（北京时间串）→ epoch ms，与服务器/替身同口径（+08:00）
const cstMs = (t) => Date.parse(t.replace(' ', 'T') + '+08:00');

try {
  // ---------- ① 平台清单 ----------
  let r = await A.get('/im/providers');
  const wc = (r.body || []).find((p) => p.key === 'wecom') || {};
  s.ck('企业微信在平台清单里且 ready（调研改判后正式接入）', r.status === 200 && wc.ready === true, JSON.stringify(r.body.map((p) => [p.key, p.ready])));
  s.ck('企业微信标注为凭证授权（前端表单按它分叉出 Bot ID/Secret）', wc.auth === 'credentials', String(wc.auth));
  s.ck('hint 讲清官方两条硬边界（10 人门槛 / 7 天窗）', /10 人/.test(wc.hint || '') && /7 天/.test(wc.hint || ''), String(wc.hint || '').slice(0, 120));

  // ---------- ② 建连接器：机器人凭证两件套 ----------
  r = await A.post('/im/connectors', { provider: 'wecom', label: '缺凭证' });
  s.ck('不填 Bot ID → 400 且话术说「智能机器人」', r.status === 400 && /Bot ID/.test(r.body.error || ''), JSON.stringify(r.body));
  r = await A.post('/im/connectors', { provider: 'wecom', label: '公司企微', app_id: 'aib-e2e-bot-0001', app_secret: 'e2e-secret-0001' });
  const id = r.body.id;
  s.ck('Bot ID + Secret 建连接器成功', r.status === 200 && id > 0, JSON.stringify(r.body));
  s.ck('凭证存住了但接口不回明文（has_secret 标记）', r.body.has_secret === true && !r.body.app_secret, JSON.stringify({ s: r.body.has_secret }));
  s.ck('新建即「未授权」（等点验证）', r.body.status === 'new' && r.body.authorized === false);
  r = await A.post(`/im/connectors/${id}/authorize`, {});
  s.ck('企业微信连接器点「去授权」→ 400 并指去验证授权（不走回调）', r.status === 400 && /验证授权/.test(r.body.error || ''), JSON.stringify(r.body));

  // ---------- ③ 没验证就同步：预检把状态打回 ----------
  r = await A.post(`/im/connectors/${id}/sync`, { since_days: 30 });
  s.ck('未验证就同步 → 400 且提示重新点「验证授权」', r.status === 400 && /企业微信授权已失效|验证授权/.test(r.body.error || ''), JSON.stringify(r.body));
  r = await A.get('/im/connectors');
  s.ck('同步预检把连接器标成 expired（界面上看得见）', ((r.body || []).find((c) => c.id === id) || {}).status === 'expired');

  // ---------- ④ 预检估算（wecom 口径：pace 150ms、since_days 钳到 7） ----------
  r = await A.get(`/im/connectors/${id}/sync-preview?since_days=30`);
  s.ck('sync-preview 返回 wecom 口径（pace 150ms）', r.status === 200 && r.body.pace_ms === 150 && r.body.provider === 'wecom', JSON.stringify(r.body));
  s.ck('官方 7 天窗在预检就说破：since_days 30 被钳成 7', r.body.since_days === 7, String(r.body.since_days));
  s.ck('还没有会话时估算 = 会话列表 1 次', r.body.est_requests_min === 1 && r.body.est_requests_max === 1, JSON.stringify([r.body.est_requests_min, r.body.est_requests_max]));

  // ---------- ⑤ 验证授权：PTY 桥喂凭证 + 身份落库 + 门槛探测 ----------
  r = await A.post(`/im/connectors/${id}/wecom-verify`, {});
  s.ck('验证授权成功（HTTP 200）', r.status === 200 && r.body.connector && r.body.connector.authorized === true, JSON.stringify(r.body).slice(0, 200));
  const c1 = (r.body || {}).connector || {};
  s.ck('授权人身份从响应信封解析并落库（「我」的识别全靠它）',
    c1.status === 'authorized' && c1.user_name === '测试用户' && c1.user_open_id === 'W-e2e-self-0001',
    JSON.stringify({ s: c1.status, u: c1.user_name, o: c1.user_open_id }));
  s.ck('小团队组织没有 10 人门槛警告', !((r.body || {}).warning || ''), String((r.body || {}).warning || ''));
  s.ck('令牌本体没进工作台库（在 CLI 自己的加密目录里）', c1.has_secret === true && !c1.access_token);
  s.ck('CLI 的凭证落在按连接器隔离的目录里', fs.existsSync(path.join(cfgDir(id), 'credentials.enc')));
  r = await A.get(`/im/connectors/${id}/logs`);
  s.ck('日志里记了授权成功（授权人姓名）', (r.body || []).some((l) => /企业微信授权成功：测试用户/.test(l.message || '')));

  // ---------- ⑥ 错凭证：失败原因要一路亮到用户脸上 ----------
  r = await A.post('/im/connectors', { provider: 'wecom', label: '错凭证企微', app_id: 'aib-e2e-bot-0001', app_secret: 'wrong-secret' });
  const id2 = r.body.id;
  r = await A.post(`/im/connectors/${id2}/wecom-verify`, {});
  s.ck('错 Secret 验证 → 400 且带上 CLI 的真原因（凭证无效）', r.status === 400 && /凭证无效/.test(r.body.error || ''), JSON.stringify(r.body).slice(0, 240));
  r = await A.get('/im/connectors');
  const c2 = ((r.body || []).find((c) => c.id === id2) || {});
  s.ck('失败路径：状态 error、last_error 带原因', c2.status === 'error' && /凭证无效/.test(c2.last_error || ''), JSON.stringify({ s: c2.status, e: c2.last_error }));
  r = await A.get(`/im/connectors/${id2}/wecom-contacts?q=王`);
  s.ck('没验证授权的连接器搜联系人 → 400 指去先验证', r.status === 400 && /验证授权/.test(r.body.error || ''), JSON.stringify(r.body));
  r = await A.del(`/im/connectors/${id2}`);
  s.ck('删掉错凭证的临时连接器', r.status === 200, JSON.stringify(r.body));

  // ---------- ⑦ 联系人搜索 + 登记单聊 + 坏会话 ----------
  r = await A.get(`/im/connectors/${id}/wecom-contacts?q=王`);
  s.ck('按姓名搜到成员（userid 给单聊登记用）', r.status === 200 && (r.body || []).length === 1 && r.body[0].userid === 'W-e2e-wangwu' && r.body[0].name === '王五', JSON.stringify(r.body));
  r = await A.get(`/im/connectors/${id}/wecom-contacts?q=不存在的人`);
  s.ck('搜不到人 = 空数组（不是报错）', r.status === 200 && (r.body || []).length === 0, JSON.stringify(r.body));
  r = await A.post(`/im/connectors/${id}/chats`, { chat_id: 'W-e2e-wangwu', chat_name: '王五', chat_mode: 'p2p' });
  s.ck('登记单聊成功（企业微信单聊没有列表接口，只能这么补）', r.status === 200 && r.body.length === 1, JSON.stringify(r.body));
  r = await A.post(`/im/connectors/${id}/chats`, { chat_id: 'wrE2ECRASH00000001', chat_name: '坏会话', chat_mode: 'group' });
  s.ck('手动登记一个「CLI 会吐非 JSON」的会话（单会话失败隔离用）', r.status === 200 && r.body.length === 2);

  // ---------- ⑧ 同步：群聊自动发现 + 拉取 + 落笔记 ----------
  r = await A.post(`/im/connectors/${id}/sync`, { since_days: 30 });
  const st1 = r.body || {};
  s.ck('同步整体 200 且跑完', r.status === 200 && st1.done === true, JSON.stringify(st1).slice(0, 160));
  s.ck('四个会话都处理了（发现 2 群 + 登记 2 条）', st1.chats === 4 && st1.total === 4, JSON.stringify({ c: st1.chats, t: st1.total }));
  s.ck('坏会话只坏它自己：其余照常落库（2 群各 4 条 + 单聊 2 条）', st1.errors.length === 1 && st1.messages === 10 && st1.notes === 3, JSON.stringify({ e: st1.errors, m: st1.messages, n: st1.notes }));
  r = await A.get(`/im/connectors/${id}/chats`);
  const gRow = (r.body || []).find((c) => c.chat_id === 'wrE2EGROUP00000001');
  const pRow = (r.body || []).find((c) => c.chat_id === 'W-e2e-wangwu');
  const xRow = (r.body || []).find((c) => c.chat_id === 'wrE2ECRASH00000001');
  s.ck('会话登记齐、笔记挂上', !!gRow && !!pRow && !!gRow.note_id && !!pRow.note_id, JSON.stringify((r.body || []).map((c) => [c.chat_id, c.note_id])));
  s.ck('会话计数：群 4 条、单聊 2 条', (gRow || {}).msg_count === 4 && (pRow || {}).msg_count === 2, JSON.stringify([gRow && gRow.msg_count, pRow && pRow.msg_count]));
  s.ck('坏会话留下失败原因，正常会话 last_error 为空', /JSON/.test((xRow || {}).last_error || '') && !((gRow || {}).last_error || ''), JSON.stringify((xRow || {}).last_error));
  r = await A.get(`/im/connectors/${id}/logs`);
  s.ck('会话列表日志：企业微信返回 2 个会话（都是群聊）', (r.body || []).some((l) => /会话列表：企业微信返回 2 个会话（其中单聊 0 个）/.test(l.message || '')));

  // 拉取口径（记账断言）：群/单聊同走 messages list、游标真的翻页、目录隔离、7 天窗钳位
  const calls1 = callsLog().filter((c) => c.cfg === cfgDir(id) && c.args[0] === 'chat');
  const listCall = calls1.find((c) => c.args[1] === 'groups');
  s.ck('会话枚举走 chat groups list 且带 --begin-time/--end-time（时间窗模式）',
    !!listCall && listCall.args.includes('--begin-time') && listCall.args.includes('--end-time'), JSON.stringify(listCall && listCall.args));
  const gCall = calls1.find((c) => c.args[1] === 'messages' && c.args.includes('wrE2EGROUP00000001'));
  const pCall = calls1.find((c) => c.args[1] === 'messages' && c.args.includes('W-e2e-wangwu'));
  s.ck('群聊拉取走 chat messages list --chat-id <群会话ID>', !!gCall && gCall.args.includes('--chat-id'), JSON.stringify(gCall && gCall.args));
  s.ck('单聊拉取也走 messages list，--chat-id 传的是对方 userid（官方口径）', !!pCall && pCall.args.includes('--chat-id') && pCall.args.includes('W-e2e-wangwu'), JSON.stringify(pCall && pCall.args));
  s.ck('游标分页真的翻页了（第二页带 --cursor）', calls1.some((c) => c.args[1] === 'messages' && c.args.includes('--cursor') && c.args.includes('e2e-page-2')),
    JSON.stringify(calls1.filter((c) => c.args.includes('--cursor')).map((c) => c.args.join(' '))));
  s.ck('所有 CLI 调用都发生在本连接器自己的 WECOM_CLI_CONFIG_DIR 里（多账号不互踩）',
    callsLog().length > 0 && calls1.every((c) => c.cfg === cfgDir(id)), JSON.stringify([...new Set(callsLog().map((c) => c.cfg))]));
  const win7d = calls1.filter((c) => c.args.includes('--begin-time')).every((c) => {
    const t = cstMs(c.args[c.args.indexOf('--begin-time') + 1]);
    return t > 0 && (Date.now() - t) < 7 * 86400e3 + 300e3;   // 钳位=7d-1h，留 5 分钟松量
  });
  s.ck('传给 CLI 的 begin-time 全部落在 7 天内（服务器先把窗钳进官方上限）', win7d,
    JSON.stringify(calls1.filter((c) => c.args.includes('--begin-time')).map((c) => c.args[c.args.indexOf('--begin-time') + 1])));

  // ---------- ⑨ 笔记本体：目录 / 标题 / 标签 / 抬头 / 排版 / 我-识别 / 消息类型 ----------
  const gn = await noteOf(gRow.note_id);
  const pn = await noteOf(pRow.note_id);
  s.ck('群笔记落在 IM连接/企业微信/<备注名>', gn.folder_path === 'IM连接/企业微信/公司企微', gn.folder_path);
  s.ck('单聊笔记也在同一个连接器目录', pn.folder_path === 'IM连接/企业微信/公司企微', pn.folder_path);
  s.ck('标题规则：对方名称-日期时间-连接器备注名（群）', /^企微测试群-\d{4}-\d{2}-\d{2} \d{2}:\d{2}-公司企微$/.test(gn.title || ''), gn.title);
  s.ck('标题规则（单聊，姓名=登记时给的名字）', /^王五-\d{4}-\d{2}-\d{2} \d{2}:\d{2}-公司企微$/.test(pn.title || ''), pn.title);
  s.ck('平台标签挂在 manual 档（#企业微信，不吃正文重算）', (gn.tags || []).includes('企业微信') && (pn.tags || []).includes('企业微信'), JSON.stringify([gn.tags, pn.tags]));
  s.ck('抬头：来源=企业微信（测试用户）、授权企业、会话 ID、标签行',
    gn.content.includes('- 来源：企业微信（测试用户）') && gn.content.includes('- 授权企业：公司企微')
    && gn.content.includes('- 会话 ID：`wrE2EGROUP00000001`') && gn.content.includes('- 标签：#企业微信'));
  s.ck('抬头写明「新消息排在最上面」', gn.content.includes('新消息排在最上面'));
  const gLines = gn.content.split('\n').filter((l) => l.startsWith('- **'));
  s.ck('群笔记 4 条消息行：我/张三/王五（图片）/我（文件）各就各位',
    gLines.length === 4 && gLines.some((l) => /｜我\*\*：群聊第一条$/.test(l))
      && gLines.some((l) => /｜张三\*\*：群里的消息$/.test(l)) && gLines.some((l) => /｜王五\*\*：\[图片\]$/.test(l))
      && gLines.some((l) => /｜我\*\*：\[文件 报表\.xlsx\]$/.test(l)),
    JSON.stringify(gLines));
  s.ck('段内倒序：最新的（文件）排在张三前面', gn.content.indexOf('[文件 报表.xlsx]') < gn.content.indexOf('张三'), '');
  const pLines = pn.content.split('\n').filter((l) => l.startsWith('- **'));
  s.ck('单聊笔记 2 条消息行：对方（文本）/我（语音）', pLines.length === 2
    && pLines.some((l) => /｜对方\*\*：单聊你好$/.test(l)) && pLines.some((l) => /｜我\*\*：\[语音\]$/.test(l)), JSON.stringify(pLines));
  s.ck('单聊抬头：会话类型=单聊', pn.content.includes('- 会话类型：单聊'));

  // ---------- ⑩ 排版方向切换（共享的 normalizeImNotes 对企微笔记同样生效） ----------
  r = await A.put(`/im/connectors/${id}`, { note_order: 'asc' });
  s.ck('切到 asc 成功', r.status === 200 && r.body.note_order === 'asc');
  const gnAsc = await noteOf(gRow.note_id);
  s.ck('切完后老笔记立刻重排成正序（张三在文件前）', gnAsc.content.indexOf('张三') < gnAsc.content.indexOf('[文件 报表.xlsx]'), '');
  r = await A.put(`/im/connectors/${id}`, { note_order: 'desc' });
  const gnDesc = await noteOf(gRow.note_id);
  s.ck('切回 desc 又变回倒序', gnDesc.content.indexOf('[文件 报表.xlsx]') < gnDesc.content.indexOf('张三'), '');

  // ---------- ⑪ 第二轮同步：只取新消息 ----------
  await sleep(1100);   // chatsForRound 按 last_sync_at>=round 判本轮做谁，同一秒会判成已处理
  r = await A.post(`/im/connectors/${id}/sync`, { since_days: 30 });
  const st2 = r.body || {};
  s.ck('第二轮只新增 3 条（每会话 1 条），不新建笔记', st2.messages === 3 && st2.notes === 0 && st2.done === true, JSON.stringify(st2).slice(0, 140));
  const gn2 = await noteOf(gRow.note_id);
  const heads = gn2.content.split('\n').filter((l) => /^## .+ 同步（新增 /.test(l));
  s.ck('群笔记现在有两个同步段，新的排在最上面', heads.length === 2 && /新增 1 条/.test(heads[0]) && gn2.content.indexOf(heads[0]) < gn2.content.indexOf(heads[1]), JSON.stringify(heads));
  s.ck('新段里是 mixed 投影成的文本（图文混排占位）', gn2.content.includes('图文混排的新消息 [图片]'), '');
  s.ck('老段原样还在（张三那条没丢）', gn2.content.includes('｜张三**：群里的消息'), '');
  r = await A.get(`/im/connectors/${id}/chats`);
  const g2 = (r.body || []).find((c) => c.chat_id === 'wrE2EGROUP00000001');
  const p2 = (r.body || []).find((c) => c.chat_id === 'W-e2e-wangwu');
  s.ck('游标推进：群 5 条、单聊 3 条', (g2 || {}).msg_count === 5 && (p2 || {}).msg_count === 3, JSON.stringify([g2 && g2.msg_count, p2 && p2.msg_count]));
  const pn2 = await noteOf(pRow.note_id);
  s.ck('单聊新消息是视频占位', pn2.content.includes('｜对方**：[视频'), JSON.stringify(pn2.content.split('\n').filter((l) => l.includes('视频'))));

  // ---------- ⑫ 预检估算（有进度之后：3 个增量会话 + 1 个从没成功的） ----------
  r = await A.get(`/im/connectors/${id}/sync-preview?since_days=30`);
  const pv = r.body || {};
  s.ck('估算下限：列表 1 次 + 每会话 1 次 = 5（增量不翻页）', pv.est_requests_min === 5, JSON.stringify([pv.est_requests_min, pv.est_requests_max]));
  s.ck('坏会话没游标 → 按首次同步口径给上限（1 + 3 增量 + 1×60 页）', pv.est_requests_max === 64, JSON.stringify([pv.est_requests_min, pv.est_requests_max]));

  // ---------- ⑬ 并发互斥：同一条连接器同时只跑一个同步 ----------
  const [ra, rb] = await Promise.all([
    A.post(`/im/connectors/${id}/sync`, { since_days: 30 }),
    A.post(`/im/connectors/${id}/sync`, { since_days: 30 }),
  ]);
  const codes = [ra.status, rb.status].sort();
  s.ck('两发并发同步：一发 200、另一发 409（明确说正在同步）', codes[0] === 200 && codes[1] === 409 && /正在同步/.test((ra.body.error || '') + (rb.body.error || '')), JSON.stringify(codes));

  // ---------- ⑭ 10 人门槛（853006）：授权是好的、chat 服务被拒 —— 要提前点破 ----------
  // 标记写在 dataDir 层（替身按连接器名认）：放 cfg 目录里会被重新验证授权时的「清旧凭证」抹掉
  const gate = path.join(DATA, 'wecom-fail-gate-' + String(id));
  fs.writeFileSync(gate, '1');
  r = await A.post(`/im/connectors/${id}/sync`, { since_days: 7 });
  s.ck('大组织同步 → 502 且话术讲清 10 人门槛（可执行）', r.status === 502 && /10 人及以下/.test(r.body.error || ''), JSON.stringify(r.body).slice(0, 240));
  r = await A.get('/im/connectors');
  s.ck('门槛原因留在卡片 last_error 上', /10 人及以下/.test((((r.body || []).find((c) => c.id === id)) || {}).last_error || ''),
    String((((r.body || []).find((c) => c.id === id)) || {}).last_error || '').slice(0, 220));
  r = await A.post(`/im/connectors/${id}/wecom-verify`, {});
  s.ck('大组织再点「验证授权」：授权本身成功（authorized 仍是 true）', r.status === 200 && r.body.connector && r.body.connector.authorized === true, JSON.stringify(r.body).slice(0, 160));
  s.ck('但 warning 把门槛说破（授权≠能拉，别让用户在中间打转）', /10 人及以下/.test((r.body || {}).warning || ''), String((r.body || {}).warning || '').slice(0, 200));
  fs.rmSync(gate, { force: true });

  // ---------- ⑮ 解除授权：CLI 目录整删、状态回 new、同步被预检拦下 ----------
  r = await A.post(`/im/connectors/${id}/revoke`, {});
  s.ck('解除授权回到 new，身份字段清空', r.status === 200 && r.body.status === 'new' && r.body.authorized === false && r.body.user_name === '' && r.body.user_open_id === '', JSON.stringify(r.body).slice(0, 160));
  s.ck('CLI 的凭证目录被整目录删掉', !fs.existsSync(cfgDir(id)));
  r = await A.post(`/im/connectors/${id}/sync`, { since_days: 30 });
  s.ck('解除授权后同步 → 400 企业微信授权已失效', r.status === 400 && /企业微信授权已失效/.test(r.body.error || ''), JSON.stringify(r.body));
  r = await A.get('/im/connectors');
  s.ck('状态标成 expired（重新验证后才翻回来）', ((r.body || []).find((c) => c.id === id) || {}).status === 'expired');

  // ---------- ⑯ 重新验证 + 删除连接器 ----------
  r = await A.post(`/im/connectors/${id}/wecom-verify`, {});
  s.ck('重新验证又回到已授权（PTY 桥可重复走）', r.status === 200 && r.body.connector && r.body.connector.authorized === true, JSON.stringify(r.body).slice(0, 120));
  s.ck('CLI 凭证目录重新建了出来', fs.existsSync(path.join(cfgDir(id), 'credentials.enc')));
  r = await A.del(`/im/connectors/${id}`);
  s.ck('删除连接器成功', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
  let dirGone = false;
  for (let i = 0; i < 20; i++) { dirGone = !fs.existsSync(cfgDir(id)); if (dirGone) break; await sleep(150); }
  s.ck('删除时 CLI 凭证目录也异步清掉了', dirGone);
  r = await A.get('/im/connectors');
  s.ck('连接器列表里没有了', !((r.body || []).some((c) => c.id === id)));
} catch (e) {
  s.ck('e2e 异常中断', false, String(e && e.stack || e).slice(0, 400));
} finally {
  await stop();
  try { fs.rmSync(BINDIR, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放，下次跑会先清 */ }
  s.done();
}
