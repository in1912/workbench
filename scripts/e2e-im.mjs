// E2E（v1.10.5）：IM 连接器——连接器 CRUD / 授权 URL / 免登回跳 / 会话与日志 / 文件夹种子 / 权限。
//
// 不联网：**不真的去调飞书**。这一版能自证的边界是「配置面」——
//   · 表建出来了、种子文件夹在了、令牌不外泄、参数校验与状态机对；
//   · 免登回跳只认一次性 state（拿假 state 只会得到一张「授权没完成」的页面，不会 500）。
// 真机授权必须人点一次同意，不在 e2e 范围内（上线后用真应用验证）。
// 隔离服务器（独立 DATA_DIR），不碰 data/workbench.sqlite。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer, login, api, checker, ROOT } from './_noteE2E.mjs';

const { B, stop } = await startServer({ tag: 'im', port: 3991 });
const s = checker();
const admin = await login(B, 'admin', 'test123456');
const A = api(B, admin.H);

try {
  // ---------- ① 平台清单 ----------
  let r = await A.get('/im/providers');
  s.ck('GET /im/providers 返回三家', r.status === 200 && r.body.length === 3, JSON.stringify(r.body).map ? '' : String(r.status));
  // v1.10.22 起钉钉也 ready（官方 dws CLI 通道）；企业微信仍然没有个人通道
  s.ck('三个平台都 ready（企业微信 v1.10.25 起接入）', r.body.filter((p) => p.ready).map((p) => p.key).join(',') === 'feishu,dingtalk,wecom',
    JSON.stringify(r.body.map((p) => [p.key, p.ready])));
  s.ck('未实现的平台带「为什么」', r.body.filter((p) => !p.ready).every((p) => (p.hint || '').length > 10));

  // ---------- ② 新建连接器的校验 ----------
  const good = { provider: 'feishu', label: '公司飞书', app_id: 'cli_test123', app_secret: 'sec_test_abc',
    redirect_uri: `${B}/api/im/callback` };
  r = await A.post('/im/connectors', { ...good, app_secret: '' });
  s.ck('缺 App Secret → 400', r.status === 400, String(r.status));
  r = await A.post('/im/connectors', { ...good, redirect_uri: 'not-a-url' });
  s.ck('回调地址不是 URL → 400', r.status === 400, String(r.status));
  r = await A.post('/im/connectors', { ...good, provider: 'wecom' });
  // v1.10.25 起企微接入（官方 wecom-cli + 机器人凭证）：塞进来的 App ID/Secret 被 Bot ID/Secret
  // 校验放行（App ID 非空即算 Bot ID）；建出来是 new 状态，立刻删掉别污染后面的计数。
  // 企微自己的完整链路（验证授权/同步/笔记）在 e2e-im-wecom.mjs 里单独跑。
  s.ck('企微建连接器走 Bot ID/Secret 口径（详测见 e2e-im-wecom）', r.status === 200 && r.body.status === 'new', JSON.stringify(r.body));
  if (r.status === 200) await A.del('/im/connectors/' + r.body.id);
  r = await A.post('/im/connectors', { ...good, provider: 'dingtalk' });
  s.ck('钉钉建连接器不需要应用凭证（顺手塞的也不存）→ 200', r.status === 200 && r.body.app_id === '', JSON.stringify(r.body));
  if (r.status === 200) await A.del('/im/connectors/' + r.body.id);   // 立刻删掉，别污染后面的「两条」计数

  r = await A.post('/im/connectors', good);
  const id = r.body.id;
  s.ck('建飞书连接器成功', r.status === 200 && id > 0, JSON.stringify(r.body));
  s.ck('返回体**不含** app_secret / access_token / refresh_token',
    !('app_secret' in r.body) && !('access_token' in r.body) && !('refresh_token' in r.body),
    Object.keys(r.body).join(','));
  s.ck('返回体带 has_secret 与 provider_name', r.body.has_secret === true && r.body.provider_name === '飞书');
  s.ck('新建的连接器是「未授权」态', r.body.authorized === false && r.body.status === 'new');

  // 再来一条（同一平台可授权多次：多家企业的飞书）
  r = await A.post('/im/connectors', { ...good, label: '个人飞书', app_id: 'cli_test456', app_secret: 'sec2' });
  const id2 = r.body.id;
  s.ck('同一平台可以建第二条连接器（多企业）', r.status === 200 && id2 > id, JSON.stringify(r.body));
  r = await A.get('/im/connectors');
  s.ck('GET /im/connectors 返回两条', r.body.length === 2, JSON.stringify(r.body.map((c) => c.label)));
  s.ck('列表里也擦掉了密钥', r.body.every((c) => !('app_secret' in c) && !('access_token' in c)));

  // ---------- ③ 改名 / 改 app 凭证会作废令牌 ----------
  r = await A.put(`/im/connectors/${id}`, { label: '公司飞书（改）' });
  s.ck('改名成功且密钥不变', r.status === 200 && r.body.label === '公司飞书（改）' && r.body.has_secret === true, JSON.stringify(r.body));
  r = await A.put(`/im/connectors/${id}`, { app_id: 'cli_changed' });
  s.ck('换 App ID 后回到未授权态（旧令牌作废）', r.status === 200 && r.body.status === 'new' && r.body.authorized === false, JSON.stringify(r.body));
  r = await A.put(`/im/connectors/${id}`, { label: '公司飞书' });
  s.ck('没传 app_secret 时不会把密钥清掉', r.body.has_secret === true);

  // 归档正文的排版方向（v1.10.18）：默认倒序、能切、坏值进不去
  s.ck('新建的连接器默认「新消息排在最上面」（note_order=desc）', r.body.note_order === 'desc', String(r.body.note_order));
  r = await A.put(`/im/connectors/${id}`, { note_order: 'asc' });
  s.ck('能把排版方向切成 asc（新消息追加在下面）', r.status === 200 && r.body.note_order === 'asc', String(r.body.note_order));
  r = await A.put(`/im/connectors/${id}`, { note_order: 'desc' });
  s.ck('能切回 desc', r.status === 200 && r.body.note_order === 'desc', String(r.body.note_order));
  r = await A.put(`/im/connectors/${id}`, { note_order: 'DROP TABLE notes' });
  s.ck('★ 坏值不会被存进去（白名单，落回 desc）', r.status === 200 && r.body.note_order === 'desc', String(r.body.note_order));
  s.ck('列表接口也带 note_order 字段',
    (await A.get('/im/connectors')).body.every((c) => c.note_order === 'desc' || c.note_order === 'asc'));

  // ---------- ④ 授权 URL ----------
  r = await A.post(`/im/connectors/${id}/authorize`, {});
  const url = r.body.url || '';
  s.ck('authorize 返回一个 URL', r.status === 200 && url.startsWith('https://'), url);
  s.ck('URL 里 client_id = app_id', url.includes('client_id=cli_changed'), url);
  s.ck('授权入口是 accounts.feishu.cn 的 v1/authorize（不是老的 open-apis/authen/v1/index）',
    url.startsWith('https://accounts.feishu.cn/open-apis/authen/v1/authorize?') && url.includes('response_type=code'), url);
  s.ck('URL 里带回调地址与 state', url.includes('redirect_uri=') && /state=[0-9a-f]{32,}/.test(url), url);
  s.ck('URL 里请求了用户身份的四个权限',
    url.includes('im%3Amessage.p2p_msg%3Aget_as_user') && url.includes('im%3Amessage.group_msg%3Aget_as_user')
    && url.includes('im%3Achat%3Areadonly') && url.includes('im%3Amessage%3Areadonly'), url);
  // 漏了 offline_access 就不会有 refresh_token，令牌两小时后过期只能重新授权 —— 这条必须钉住
  s.ck('URL 里带 offline_access（否则换不到 refresh_token，2 小时后同步必然失败）',
    url.includes('offline_access'), url);

  // ---------- ⑤ 免登回跳（假 state） ----------
  let raw = await fetch(`${B}/api/im/callback?code=fake&state=${'0'.repeat(48)}`);
  let html = await raw.text();
  s.ck('带假 state 的回跳：HTTP 200 + HTML', raw.status === 200 && (raw.headers.get('content-type') || '').includes('text/html'), String(raw.status));
  s.ck('假 state 不会泄露任何东西，只说「授权没完成」', html.includes('授权没完成') && !html.includes('fake'), html.slice(0, 120));
  raw = await fetch(`${B}/api/im/callback`);
  s.ck('回跳是免登的（未登录不 401）', raw.status === 200, String(raw.status));

  // ---------- ⑥ 同步前的状态闸 ----------
  r = await A.post(`/im/connectors/${id}/sync`, { since_days: 30 });
  s.ck('未授权就同步 → 400 且提示重新授权', r.status === 400 && /授权/.test(r.body.error || ''), JSON.stringify(r.body));
  r = await A.post('/im/connectors/999999/sync', {});
  s.ck('同步不存在的连接器 → 404', r.status === 404, String(r.status));
  // v1.10.8 分轮同步：续跑时前端会把服务端上一轮返回的 round 原样带回来。这里只证明
  // 「多带一个 round 不会把接口打崩」，走的还是同一个未授权 400（同步本身要真令牌，不在 e2e 范围）。
  r = await A.post(`/im/connectors/${id}/sync`, { since_days: 30, round: '2026-10-05 12:00:00' });
  s.ck('续跑带上 round 参数不会变成 500', r.status === 400, String(r.status));
  r = await A.post(`/im/connectors/${id}/sync`, { since_days: 30, round: { evil: 1 } });
  s.ck('round 传非字符串也不会 500（服务端只认字符串）', r.status === 400, String(r.status));

  // ---------- ⑦ 会话：手动登记 / 列表 / 移除 ----------
  r = await A.post(`/im/connectors/${id}/chats`, { chat_id: 'oc_e2e_test_chat', chat_name: '测试群', chat_mode: 'group' });
  s.ck('手动登记会话成功', r.status === 200 && r.body.length === 1 && r.body[0].chat_id === 'oc_e2e_test_chat', JSON.stringify(r.body));
  const chatRowId = r.body[0].id;
  r = await A.post(`/im/connectors/${id}/chats`, { chat_id: 'oc_e2e_test_chat' });
  s.ck('同一个 chat_id 重复登记不会变两条（游标不能被覆盖）', r.body.length === 1, JSON.stringify(r.body.map((c) => c.chat_id)));
  r = await A.post(`/im/connectors/${id}/chats`, { chat_id: '' });
  s.ck('空 chat_id → 400', r.status === 400, String(r.status));
  r = await A.get(`/im/connectors/${id2}/chats`);
  s.ck('另一条连接器看不到这条会话（按连接器隔离）', r.body.length === 0, JSON.stringify(r.body));

  // ---------- ⑧ 日志 ----------
  r = await A.get(`/im/connectors/${id}/logs`);
  s.ck('GET /im/connectors/:id/logs 返回数组', r.status === 200 && Array.isArray(r.body), String(r.status));

  // ---------- ⑧之二 同步前预检（v1.10.8；只读，不产生任何请求到飞书） ----------
  r = await A.get(`/im/connectors/${id}/sync-preview`);
  s.ck('GET /im/connectors/:id/sync-preview 返回估算', r.status === 200 && r.body && typeof r.body.chats === 'number', JSON.stringify(r.body).slice(0, 160));
  const pv = r.body || {};
  // 此时这条连接器里只登记了 oc_e2e_test_chat 一条，且从没同步过 ⇒ 1 个「首次同步」会话。
  s.ck('预估的会话数 = 已登记的会话数', pv.chats === 1, String(pv.chats));
  s.ck('没同步过的会话算「首次同步」（要按 since_days 拉历史）', pv.incremental === 0 && pv.initial === 1, `incremental=${pv.incremental} initial=${pv.initial}`);
  // 请求下限 = 会话列表 1 次 + 每个会话至少 1 次消息
  s.ck('请求次数下限 = 会话列表 + 会话数', pv.est_requests_min === 1 + pv.chats, `${pv.est_requests_min} vs ${1 + pv.chats}`);
  s.ck('请求次数上限 ≥ 下限', pv.est_requests_max >= pv.est_requests_min, `${pv.est_requests_max} / ${pv.est_requests_min}`);
  s.ck('耗时估算与 220ms 的页间隔一致', pv.pace_ms === 220 && pv.est_seconds_min === Math.round((pv.est_requests_min * 220) / 1000), `pace=${pv.pace_ms} min=${pv.est_seconds_min}`);
  s.ck('预检里带了「按会话记进度、中断不丢」的说明', typeof pv.resume === 'string' && pv.resume.length > 10, String(pv.resume).slice(0, 40));
  s.ck('预检默认范围 30 天', pv.since_days === 30, String(pv.since_days));
  r = await A.get(`/im/connectors/${id}/sync-preview?since_days=99999`);
  s.ck('since_days 超上限被夹到 3650', r.body.since_days === 3650, String(r.body.since_days));
  r = await A.get(`/im/connectors/${id}/sync-preview?since_days=0`);
  s.ck('since_days 非法值回落 30', r.body.since_days === 30, String(r.body.since_days));
  r = await A.get('/im/connectors/999999/sync-preview');
  s.ck('预检不存在的连接器 → 404', r.status === 404, String(r.status));
  const anonPv = await fetch(`${B}/api/im/connectors/${id}/sync-preview`);
  s.ck('未登录访问 sync-preview → 401', anonPv.status === 401, String(anonPv.status));
  // 只读闸门：预检之后会话数不该变（怕以后有人把「顺手拉一次会话列表」写进预检里）
  r = await A.get(`/im/connectors/${id}/chats`);
  s.ck('预检是只读的：没有多出/少掉会话', r.body.length === 1, JSON.stringify(r.body.map((c) => c.chat_id)));

  // ---------- ⑧之三 分轮同步的取舍规则（纯函数，不联网） ----------
  // 真跑一次同步要真令牌，但「本轮该处理谁」这条规则是纯的，可以直接测：
  // 时间戳格式 'YYYY-MM-DD HH:MM:SS'，全部出自 SQLite 的 datetime('now','localtime')。
  //
  // ⚠️ 这些纯函数**不能在本进程里 require imService**：它 `require('../db')`，而本进程没设
  //    DATA_DIR —— 那样会打开并迁移 data/workbench.sqlite（真库）。之前这里就是直接
  //    `await import(...)` 的，等于每次跑 e2e 都拿真库当试验场。现在统一挪到 ⑫ 那个
  //    子进程里（DATA_DIR 指向临时目录）。

  // ---------- ⑧之四 定时同步的配置面（v1.10.14，需求③） ----------
  // 真跑一次定时任务要真令牌，但「配置怎么存、坏值拦不拦、每条连接器是不是各存各的」
  // 全都能在 HTTP 层验完 —— 这几条正是最容易悄悄坏掉的地方。
  r = await A.get('/im/connectors');
  const c1 = r.body.find((c) => c.id === id);
  s.ck('新建的连接器默认不开定时同步', Number(c1.auto_sync) === 0, JSON.stringify({ auto_sync: c1.auto_sync }));
  s.ck('默认频率=每天 08:00、范围 30 天', c1.auto_freq === 'daily' && c1.auto_time === '08:00' && Number(c1.auto_days) === 30,
    JSON.stringify({ f: c1.auto_freq, t: c1.auto_time, d: c1.auto_days }));

  r = await A.put(`/im/connectors/${id}`, { auto_sync: 1, auto_freq: 'weekly', auto_time: '21:30', auto_weekday: 3, auto_days: 90 });
  s.ck('开定时同步并设成「每周三 21:30 / 90 天」', r.status === 200
    && Number(r.body.auto_sync) === 1 && r.body.auto_freq === 'weekly' && r.body.auto_time === '21:30'
    && Number(r.body.auto_weekday) === 3 && Number(r.body.auto_days) === 90, JSON.stringify(r.body).slice(0, 200));
  // 关键：**每条连接器各存各的** —— 改了第一条，第二条必须还是默认值
  const c2 = (await A.get('/im/connectors')).body.find((c) => c.id === id2);
  s.ck('★ 定时设置是按连接器分开存的：另一条仍是默认（没被带着一起改）',
    Number(c2.auto_sync) === 0 && c2.auto_time === '08:00' && Number(c2.auto_days) === 30,
    JSON.stringify({ id2: { s: c2.auto_sync, t: c2.auto_time, d: c2.auto_days } }));

  r = await A.put(`/im/connectors/${id}`, { auto_time: '25:99' });
  s.ck('非法时刻（25:99）→ 400，不会存进库让调度器每分钟空转', r.status === 400 && /HH:MM/.test(r.body.error || ''), JSON.stringify(r.body));
  r = await A.put(`/im/connectors/${id}`, { auto_time: '8:5' });
  s.ck('不成形的时刻（8:5）→ 400', r.status === 400, JSON.stringify(r.body));
  // 「8:30」是同一个时刻的另一种写法：**补零存成 08:30**。这条以前会漏 —— 保存侧当时放行单数字小时，
  // 而 autoSyncSlot 那边要求两位，结果库里存着 8:30 → 取时点返回空 → **开着开关却永远不跑**。
  // 所以这里不只看到 400/200，还要断言**存回去的值是取时点那侧能读懂的写法**。
  r = await A.put(`/im/connectors/${id}`, { auto_time: '8:30' });
  s.ck('★ 个位小时（8:30）被补零成 08:30 存下（存进库的必须能被取时点那侧读懂）',
    r.status === 200 && r.body.auto_time === '08:30', JSON.stringify({ status: r.status, t: r.body.auto_time }));
  r = await A.put(`/im/connectors/${id}`, { auto_time: '0:05' });
  s.ck('★ 0:05 → 00:05（个位小时一律补零，不是只在 8 点这一种情况上打补丁）',
    r.status === 200 && r.body.auto_time === '00:05', JSON.stringify({ status: r.status, t: r.body.auto_time }));
  r = await A.put(`/im/connectors/${id}`, { auto_time: '21:30' });
  r = await A.put(`/im/connectors/${id}`, { auto_freq: 'hourly' });
  s.ck('不认识的频率 → 400', r.status === 400, JSON.stringify(r.body));
  r = await A.put(`/im/connectors/${id}`, { auto_weekday: 99, auto_days: 99999 });
  s.ck('周几/天数越界被夹进合法区间（7 / 3650）',
    Number(r.body.auto_weekday) === 7 && Number(r.body.auto_days) === 3650,
    JSON.stringify({ w: r.body.auto_weekday, d: r.body.auto_days }));
  r = await A.put(`/im/connectors/${id}`, { auto_weekday: 3, auto_days: 90, auto_time: '21:30' });
  s.ck('改回正常值', Number(r.body.auto_weekday) === 3 && Number(r.body.auto_days) === 90, JSON.stringify({ w: r.body.auto_weekday, d: r.body.auto_days }));
  // 关掉开关后其余设置要留着（用户只是想暂停，不是想清空配置）
  r = await A.put(`/im/connectors/${id}`, { auto_sync: 0 });
  s.ck('关掉开关不会把时点/范围清空（只是暂停）',
    Number(r.body.auto_sync) === 0 && r.body.auto_time === '21:30' && Number(r.body.auto_days) === 90,
    JSON.stringify({ s: r.body.auto_sync, t: r.body.auto_time, d: r.body.auto_days }));
  r = await A.put(`/im/connectors/${id}`, { auto_sync: 1 });
  s.ck('重新打开后设置还在', Number(r.body.auto_sync) === 1 && r.body.auto_time === '21:30', JSON.stringify({ s: r.body.auto_sync, t: r.body.auto_time }));

  // ---------- ⑨ 笔记文件夹：只种顶层，子目录**用到才建**（v1.10.14） ----------
  r = await A.get('/notes/folders');
  const imRoot = (r.body || []).find((f) => f.name === 'IM连接' && f.parent_id === null);
  s.ck('笔记树里有顶层「IM连接」文件夹', !!imRoot, JSON.stringify((r.body || []).map((f) => f.name)));
  const subs = (imRoot ? imRoot.children : []).map((c) => c.name).sort();
  // v1.10.5 那种「先把 飞书/钉钉/企业微信/其他 四个目录建好」的种子已经删了：
  // 钉钉/企业微信根本跑不通，空目录挂在树上只会让人以为「是不是快好了」。
  // 现在目录在**第一次同步**时才出现（IM连接/<平台>/<连接器备注名>）。
  s.ck('IM连接 下面不再有空壳子目录（用到才建）', subs.length === 0, JSON.stringify(subs));

  // ---------- ⑩ 解除授权 / 删除 ----------
  r = await A.post(`/im/connectors/${id}/revoke`, {});
  s.ck('解除授权：状态回到未授权，配置还在', r.status === 200 && r.body.authorized === false && r.body.app_id === 'cli_changed', JSON.stringify(r.body));
  r = await A.del(`/im/chats/${chatRowId}`);
  s.ck('移除会话', r.status === 200 && r.body.deleted === 1, JSON.stringify(r.body));
  r = await A.del(`/im/connectors/${id2}`);
  s.ck('删除连接器', r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
  r = await A.get('/im/connectors');
  s.ck('删完只剩一条', r.body.length === 1, JSON.stringify(r.body.map((c) => c.label)));
  r = await A.del('/im/connectors/999999');
  s.ck('删不存在的连接器 → 404', r.status === 404, String(r.status));

  // ---------- ⑪ 权限：/im/* 归 notes 页 ----------
  const anon = await fetch(`${B}/api/im/connectors`);
  s.ck('未登录访问 /im/connectors → 401', anon.status === 401, String(anon.status));
  const anon2 = await fetch(`${B}/api/im/providers`);
  s.ck('未登录访问 /im/providers → 401', anon2.status === 401, String(anon2.status));

  // 普通成员（没有 notes 页权限）→ 403：这是「pageForPath 少写一行就静默降级」的回归闸门。
  // allowed_pages 为空数组 = 全开，所以必须给一个不含 notes 的显式清单。
  r = await A.post('/users', { username: 'im-e2e-noperm', password: 'Np123456', role: 'user', allowed_pages: ['dashboard'] });
  s.ck('建无笔记权限的成员', r.status === 200 && r.body.id > 0, JSON.stringify(r.body).slice(0, 120));
  if (r.status === 200 && r.body.id > 0) {
    const u = await login(B, 'im-e2e-noperm', 'Np123456');
    const U = api(B, u.H);
    const rr = await U.get('/im/connectors');
    s.ck('没有 notes 页权限的成员访问 /im/* → 403', rr.status === 403, String(rr.status));
    const rr2 = await U.get('/notes/folders');
    s.ck('该成员确实也没有笔记权限（上面那个 403 才有意义）', rr2.status === 403, String(rr2.status));
    await A.del(`/users/${r.body.id}`);
  }

  // ---------- ⑫ 纯函数与一次性迁移：另起子进程，DATA_DIR 指到临时库 ----------
  // 真同步要联网调飞书，e2e 里没有网络，所以把这些不依赖网络的规则单独拎出来测：
  //   · chatTitle（标题规则）· chatsForRound（分轮取舍）· autoSyncSlot/autoSyncDue（定时时点）
  //   · connectorFolderId / migrateImFolders（落地目录 + 老数据搬迁）
  // ⚠️ 千万**不能在本进程 require imService**：它 `require('../db')`，而本进程没设 DATA_DIR，
  //    那样会打开并迁移 data/workbench.sqlite（真库）。所以另起一个子进程，DATA_DIR 指到临时目录。
  //
  // ★ 子进程故意跑在 **TZ=UTC** 下：定时同步的时点是按北京时间（UTC+8）算的，
  //   如果哪天有人把它改成「服务器本地时间」，在开发机（东八区）上照样全绿、
  //   到了 UTC 的容器里就变成半夜跑 —— 这里就是要让那种错误当场现形。
  const TMP_TITLE = path.join(ROOT, 'data', `tmp-note-e2e-im-title-${Date.now()}`);
  const CHILD = `
process.env.DATA_DIR = ${JSON.stringify(TMP_TITLE)};
const path = require('path');
const ROOT = ${JSON.stringify(ROOT)};
const dbm = require(path.join(ROOT, 'server', 'db.js'));
const im = require(path.join(ROOT, 'server', 'services', 'imService.js'));
const d = dbm.db;

// ---- ① 标题规则（对方名称-日期时间-连接器备注名） ----
// ⚠️ 这里的连接器声明别叫 conn —— 下面时点算法那段已经有 const conn = function (o)…，撞名直接 SyntaxError
const connT = { label: '字留地', tenant_key: '企业识别码X' };
const cases = [
  ['单聊取对方姓名', { chat_id: 'oc_abc123', chat_name: '张三', chat_mode: 'p2p' }, Date.parse('2026-10-05T11:53:07')],
  ['群聊取群名', { chat_id: 'oc_grp999', chat_name: '研发一组', chat_mode: 'group' }, Date.parse('2026-10-05T09:05:00')],
  ['没名字退回会话 ID', { chat_id: 'oc_noname', chat_name: '', chat_mode: 'p2p' }, Date.parse('2026-10-05T08:00:00')],
  ['时间戳非法时取当前时间', { chat_id: 'oc_badts', chat_name: '李四' }, NaN],
];
console.log('__TITLE__' + JSON.stringify(cases.map(function (c) { return { name: c[0], title: im.chatTitle(connT, c[1], c[2]) }; })));
// 备注名缺失时的兜底链：企业识别码 → 会话 ID（别拼出空尾巴）
console.log('__TITLE2__' + JSON.stringify([
  im.chatTitle({ label: '', tenant_key: 'tk_777' }, { chat_id: 'oc_1', chat_name: '王五' }, Date.parse('2026-10-05T10:00:00')),
  im.chatTitle({ label: '', tenant_key: '' }, { chat_id: 'oc_2', chat_name: '赵六' }, Date.parse('2026-10-05T10:00:00')),
]));

// ---- ② 分轮规则 ----
const RND = '2026-10-05 12:00:00';
const mk = function (v) { return { chat_id: 'oc_x', last_sync_at: v }; };
const roundCases = [
  [mk(null), true, '从没同步过的会话要处理'],
  [mk(''), true, 'last_sync_at 是空串也当没同步过'],
  [mk('2026-10-05 11:59:59'), true, '本轮之前同步过的要再看一遍新消息（增量的入口）'],
  [mk(RND), false, '正好落在本轮起点上的跳过'],
  [mk('2026-10-05 12:00:01'), false, '本轮已经处理过的必须跳过，否则每续跑一轮都白问一遍'],
  [mk('2026-10-05 23:59:59'), false, '同一天的晚些时候也跳过'],
  [mk('2026-10-06 00:00:01'), false, '晚于本轮的开始时间一律跳过'],
];
console.log('__ROUND__' + JSON.stringify({
  bad: roundCases.filter(function (c) { return (im.chatsForRound([c[0]], RND).length === 1) !== c[1]; }).map(function (c) { return c[2]; }),
  order: im.chatsForRound([mk(null), mk('2026-10-05 12:00:01'), mk(null)], RND).length,
}));

// ---- ③ 定时同步的时点算法（下面这些 ISO 串都带 +08:00，与运行环境时区无关）----
const at = function (s) { return Date.parse(s); };
const conn = function (o) { const b = { auto_sync: 1, auto_freq: 'daily', auto_time: '08:00', auto_weekday: 1, auto_days: 30 }; for (const k in o) b[k] = o[k]; return b; };
const slotCases = [
  ['每天 08:00 / 当天 07:00 → 昨天', conn({}), at('2026-10-05T07:00:00+08:00'), '2026-10-04 08:00:00'],
  ['每天 08:00 / 当天 08:00 → 今天', conn({}), at('2026-10-05T08:00:00+08:00'), '2026-10-05 08:00:00'],
  ['每天 08:00 / 当天 23:59 → 今天', conn({}), at('2026-10-05T23:59:00+08:00'), '2026-10-05 08:00:00'],
  ['每天 08:00 / 当天 09:00 → 今天（TZ=UTC 下按服务器时间算会错成昨天）', conn({}), at('2026-10-05T09:00:00+08:00'), '2026-10-05 08:00:00'],
  ['每周三 21:00 / 周一 10:00 → 上周三', conn({ auto_freq: 'weekly', auto_time: '21:00', auto_weekday: 3 }), at('2026-10-05T10:00:00+08:00'), '2026-09-30 21:00:00'],
  ['每周三 21:00 / 周三 20:00 → 上周三（本周那次还没到）', conn({ auto_freq: 'weekly', auto_time: '21:00', auto_weekday: 3 }), at('2026-10-07T20:00:00+08:00'), '2026-09-30 21:00:00'],
  ['每周三 21:00 / 周三 21:30 → 今天', conn({ auto_freq: 'weekly', auto_time: '21:00', auto_weekday: 3 }), at('2026-10-07T21:30:00+08:00'), '2026-10-07 21:00:00'],
  ['每周日 09:00 / 周日 09:00 → 今天（周日 = 7 不能算成 0）', conn({ auto_freq: 'weekly', auto_time: '09:00', auto_weekday: 7 }), at('2026-10-11T09:00:00+08:00'), '2026-10-11 09:00:00'],
  ['没开定时开关 → 没有时点', conn({ auto_sync: 0 }), at('2026-10-05T09:00:00+08:00'), ''],
  ['时刻填坏了 → 没有时点（宁可不动，也不能瞎跑）', conn({ auto_time: '25:99' }), at('2026-10-05T09:00:00+08:00'), ''],
];
const dueCases = [
  ['从没自动跑过 → 到点', '', true],
  ['上次正好跑在这个时点 → 不到点（不重复跑）', '2026-10-05 08:00:00', false],
  ['上次是更早的时点 → 到点', '2026-10-04 08:00:00', true],
];
console.log('__SLOTS__' + JSON.stringify({
  bad: slotCases.filter(function (c) { return im.autoSyncSlot(c[1], c[2]) !== c[3]; })
    .map(function (c) { return c[0] + '：期望 ' + c[3] + '，实际 ' + JSON.stringify(im.autoSyncSlot(c[1], c[2])); }),
  total: slotCases.length,
  dueBad: dueCases.filter(function (c) { return im.autoSyncDue(conn({ auto_last_at: c[1] }), at('2026-10-05T09:00:00+08:00')) !== c[2]; })
    .map(function (c) { return c[0]; }),
  stamp: im.cstStamp(at('2026-10-05T09:00:00+08:00')),
}));

// ---- ④ 落地目录 + 老数据搬迁（造一个「老结构」的库来验）----
// 老结构：所有连接器的 folder_id 都指向平台目录「飞书」；树上还挂着钉钉/企业微信/其他三个空目录。
const lastId = function (r) { return Number(r.lastInsertRowid); };
const mkFolder = function (name, parent) {
  d.prepare('INSERT INTO note_folders(name,parent_id) VALUES(?,?)').run(name, parent);
  return Number(d.prepare('SELECT id FROM note_folders WHERE parent_id=? AND name=?').get(parent, name).id);
};
const root = d.prepare("SELECT id FROM note_folders WHERE parent_id IS NULL AND name='IM连接'").get();
if (!root) throw new Error('库里没有 IM连接 顶层目录');
const feishu = mkFolder('飞书', Number(root.id));
const ding = mkFolder('钉钉', Number(root.id));
mkFolder('企业微信', Number(root.id));
mkFolder('其他', Number(root.id));
// 钉钉目录里放一篇「用户自己放进去的」笔记 → 它不空，绝不能被当成空目录清掉
const keptNote = lastId(d.prepare("INSERT INTO notes(title,content,folder_id) VALUES('用户手放的','x',?)").run(ding));
const addConn = function (label, tenant) {
  return lastId(d.prepare("INSERT INTO im_connectors(provider,label,app_id,app_secret,redirect_uri,tenant_key,status,folder_id) VALUES('feishu',?,?,'s','http://x/api/im/callback',?,'authorized',?)")
    .run(label, 'cli_' + tenant, tenant, feishu));
};
const ca = addConn('字留地-飞书个人', 'tkA');
const cb = addConn('公司飞书', 'tkB');
const addNote = function (cid, chatId, title) {
  const nid = lastId(d.prepare('INSERT INTO notes(title,content,folder_id) VALUES(?,?,?)').run(title, 'body', feishu));
  d.prepare('INSERT INTO im_chats(connector_id,chat_id,chat_name,note_id) VALUES(?,?,?,?)').run(cid, chatId, title, nid);
  return nid;
};
const na = addNote(ca, 'oc_a', '甲群');
const nb = addNote(cb, 'oc_b', '乙群');
const fpath = function (fid) {
  const f = d.prepare('SELECT * FROM note_folders WHERE id=?').get(fid);
  if (!f) return null;
  const p = f.parent_id == null ? null : d.prepare('SELECT * FROM note_folders WHERE id=?').get(f.parent_id);
  return (p ? p.name + '/' : '') + f.name;
};
const mig = im.migrateImFolders(d);
const notePath = function (nid) { return fpath(d.prepare('SELECT folder_id FROM notes WHERE id=?').get(nid).folder_id); };
const again = im.migrateImFolders(d);
const dup = addConn('公司飞书', 'tkC');   // 第三条：备注名跟第二条撞了
const connRow = function (id2) { return d.prepare('SELECT * FROM im_connectors WHERE id=?').get(id2); };
console.log('__FOLDERS__' + JSON.stringify({
  moved: mig.moved, removed: mig.removed,
  connPaths: d.prepare('SELECT * FROM im_connectors WHERE id IN (?,?) ORDER BY id').all(ca, cb).map(function (c) { return c.label + ' → ' + fpath(c.folder_id); }),
  notePaths: [notePath(na), notePath(nb)],
  keptNote: notePath(keptNote),
  leftOver: d.prepare('SELECT name FROM note_folders WHERE parent_id=?').all(Number(root.id)).map(function (x) { return x.name; }).sort(),
  againMoved: again.moved, againRemoved: again.removed,
  dupPath: fpath(im.connectorFolderId(d, connRow(dup))),
  stable: Number(im.connectorFolderId(d, connRow(ca))) === Number(connRow(ca).folder_id),
}));

// ---- ⑤ 归档正文的排版（v1.10.18）：新消息排在最上面 + 平台标签 ----
// 正文 = 抬头 + 若干「## <时间> 同步（新增 N 条）」段，段内每行是「- **<时间>｜谁**：…」。
// ⚠️ 段标题写的是**该段最新一条**的时间，所以只能「按段」判单调 —— 把它和段内行拼成一条
// 全局序列再断言递减，会永远失败（第一版断言就是这么写错的）。
var HEAD = ['# 张三', '', '- 来源：飞书（我）', '- 会话 ID：\`oc_x\`', '- 标签：#飞书', '',
  '> 本笔记由工作台「IM 连接」按官方授权自动归档，**新消息排在最上面**，越往下越早。'].join('\\n');
var blk = function (stamp, msgs) {
  return '## ' + stamp + ' 同步（新增 ' + msgs.length + ' 条）\\n\\n'
    + msgs.map(function (m) { return '- **' + m[0] + '｜' + m[1] + '**：' + m[2]; }).join('\\n');
};
var B1 = blk('2026-10-04 09:00', [['2026-10-04 09:00', '对方', 'a'], ['2026-10-04 09:02', '我', 'b']]);
var B2 = blk('2026-10-05 20:12', [['2026-10-05 20:11', '对方', 'x'], ['2026-10-05 20:12', '我', 'y']]);
var B3 = blk('2026-10-06 08:00', [['2026-10-06 08:00', '对方', 'z']]);
// 走**真实路径**：merge 之后每次都要 orderImNoteContent（upsertImNote 就是这么写的）
var body = HEAD + '\\n';
[B1, B2, B3].forEach(function (B) { body = im.orderImNoteContent(im.mergeImBlock(body, B, true), true); });
var secsOf = function (s) {
  return im.splitImSections(s).sections.map(function (sec) {
    return {
      head: (sec[0].match(/^## (\\S+ \\S+) 同步/) || [])[1],
      msgs: sec.slice(1).filter(function (l) { return l.trim(); })
        .map(function (l) { return (l.match(/^- \\*\\*(\\S+ \\S+)｜/) || [])[1]; }),
    };
  });
};
var descOk = function (arr) { return arr.every(function (t, i) { return i === 0 || arr[i - 1] >= t; }); };
var upOk = function (arr) { return arr.every(function (t, i) { return i === 0 || arr[i - 1] <= t; }); };
var SD = secsOf(body);
var ascBody = im.orderImNoteContent(body, false);
var SA = secsOf(ascBody);
// 老笔记：旧版是「新消息一路追加在下面」，规整后要翻过来
var legacy = HEAD + '\\n\\n' + B1 + '\\n\\n' + B2 + '\\n';
var legacyFixed = im.orderImNoteContent(legacy, true);
// 兜底：正文里混进一行「像段标题」的东西时，新段不能丢
var trap = HEAD + '\\n\\n- **2026-10-04 09:00｜对方**：夹着一行\\n## 2026-10-04 09:01 同步（新增 1 条）\\n- **2026-10-04 09:02｜我**：b\\n';
var trapped = im.mergeImBlock(trap, B2, true);
console.log('__ORDER__' + JSON.stringify({
  descHeads: SD.map(function (x) { return x.head; }),
  descOk: SD.length === 3 && descOk(SD.map(function (x) { return x.head; }))
    && SD.every(function (x) { return x.msgs.length > 0 && descOk(x.msgs); }),
  topIsNewest: SD[0] && SD[0].msgs[0],
  headFirst: body.split('\\n')[0],
  idempotent: im.orderImNoteContent(body, true) === body,
  ascOk: SA.length === 3 && upOk(SA.map(function (x) { return x.head; }))
    && SA.every(function (x) { return upOk(x.msgs); }),
  lossless: im.sameLineBag(body, ascBody) && im.sameLineBag(ascBody, im.orderImNoteContent(ascBody, true)),
  legacyTop: (legacyFixed.match(/^- \\*\\*(\\S+ \\S+)｜/m) || [])[1],
  legacyLossless: im.sameLineBag(legacy, legacyFixed),
  trapKept: im.sameLineBag(trapped, trap.replace(/\\s+$/, '') + '\\n\\n' + B2 + '\\n'),
  tags: ['feishu', 'dingtalk', 'wecom', 'nope'].map(function (p) { return im.platformTagOf({ provider: p }); }),
  orderDefaults: [im.noteOrderDesc({}), im.noteOrderDesc({ note_order: 'asc' }), im.noteOrderDesc({ note_order: 'xx' })],
}));

// ---- ⑥ 平台标签 + 启动规整（走**真库**：im_chats.note_id → 笔记）----
// 甲群那篇先改回「老版的顺序」（早的在最上），并让用户自己打过 #重要 标签：
// 规整必须①把它翻成倒序 ②把 #飞书 并上去而**不冲掉** #重要。
d.prepare('UPDATE notes SET content=?, tags=? WHERE id=?').run(HEAD + '\\n\\n' + B1 + '\\n\\n' + B2 + '\\n', '重要', na);
d.prepare("INSERT INTO note_tags(note_id,tag,source) VALUES(?,'重要','manual')").run(na);
// 乙群那篇模拟「词频自动标签早就加过一个 飞书」的老状态：规整要把它**升级成手动标签**，
// 否则它会被下一次正文改动整批换掉（自动标签是随正文重算的）。
d.prepare("INSERT INTO note_tags(note_id,tag,source) VALUES(?,'飞书','auto')").run(nb);
// 用户把某篇整个重写过：抬头第一行是标题、但**没有**「- 会话 ID：」那一行 →
// 认不出是我们写的抬头，那就一个字节都不许动（规整只能碰我们自己写的块）。
var nu = lastId(d.prepare('INSERT INTO notes(title,content,folder_id) VALUES(?,?,?)')
  .run('用户重写的', '# 我的标题\\n\\n## 2026-10-04 09:00 同步（新增 1 条）\\n\\n- **2026-10-04 09:00｜对方**：a\\n', feishu));
d.prepare('INSERT INTO im_chats(connector_id,chat_id,chat_name,note_id) VALUES(?,?,?,?)').run(ca, 'oc_u', '用户重写的', nu);
var nuBefore = String(d.prepare('SELECT content FROM notes WHERE id=?').get(nu).content);
// 另一篇：抬头是**我们写的**（有「- 会话 ID：」），但用户在标题底下自己插了一行行内标签
// （井号后面没有空格，所以不算我们写的标题行）。刷抬头只能换我们那几行，这行必须原样留着。
var nv = lastId(d.prepare('INSERT INTO notes(title,content,folder_id) VALUES(?,?,?)')
  .run('带用户加的行', '# 戊群\\n#公司\\n\\n- 来源：飞书\\n- 会话 ID：\`oc_v\`\\n\\n'
    + '> 本笔记由工作台「IM 连接」按官方授权自动归档，每次同步把新消息追加在下面。\\n\\n'
    + '## 2026-10-04 09:00 同步（新增 1 条）\\n\\n- **2026-10-04 09:00｜对方**：a\\n', feishu));
d.prepare('INSERT INTO im_chats(connector_id,chat_id,chat_name,note_id) VALUES(?,?,?,?)').run(ca, 'oc_v', '戊群', nv);
var updBefore = d.prepare('SELECT updated_at FROM notes WHERE id=?').get(na).updated_at;
var n1 = im.normalizeImNotes(d);
var tagsOf = function (nid) {
  return d.prepare('SELECT tag FROM note_tags WHERE note_id=? ORDER BY tag').all(nid).map(function (r) { return r.tag; });
};
var naContent = String(d.prepare('SELECT content FROM notes WHERE id=?').get(na).content);
// 只有段（不含抬头）参与比对：这次连抬头都要换，拿整篇比就分不清「该改的抬头」和「不该动的段」
var secsOnly = function (s) {
  return im.splitImSections(s).sections.map(function (x) { return x.join('\\n').replace(/\\s+$/, ''); });
};
var naWant = im.orderImNoteContent(HEAD + '\\n\\n' + B1 + '\\n\\n' + B2 + '\\n', true);
var n2 = im.normalizeImNotes(d);
console.log('__TAGS__' + JSON.stringify({
  first: n1,
  second: n2,
  naTags: tagsOf(na),
  nbTags: tagsOf(nb),
  nbSources: d.prepare('SELECT tag,source FROM note_tags WHERE note_id=? ORDER BY tag').all(nb),
  keptTags: tagsOf(keptNote),
  nuTags: tagsOf(nu),
  naTop: (naContent.match(/^- \\*\\*(\\S+ \\S+)｜/m) || [])[1],
  naHead: naContent.split('\\n')[0],
  naHeader: im.splitImSections(naContent).head.join('\\n').replace(/\\s+$/, ''),
  naHeaderWant: im.imHeaderBlock(connRow(ca), { chat_id: 'oc_a', chat_name: '甲群', chat_mode: '' }, true, '飞书'),
  naMsgs: (naContent.match(/^- \\*\\*/gm) || []).length,
  naSecsKept: JSON.stringify(secsOnly(naContent)) === JSON.stringify(secsOnly(naWant)),
  nvHead: im.splitImSections(String(d.prepare('SELECT content FROM notes WHERE id=?').get(nv).content)).head,
  nvTags: tagsOf(nv),
  nbUntouched: String(d.prepare('SELECT content FROM notes WHERE id=?').get(nb).content) === 'body',
  nuUntouched: String(d.prepare('SELECT content FROM notes WHERE id=?').get(nu).content) === nuBefore,
  keptUntouched: String(d.prepare('SELECT content FROM notes WHERE id=?').get(keptNote).content) === 'x',
  updKept: d.prepare('SELECT updated_at FROM notes WHERE id=?').get(na).updated_at === updBefore,
}));
`;
  try {
    const res = spawnSync(process.execPath, ['--no-warnings', '-e', CHILD],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TZ: 'UTC' } });
    if (res.status !== 0) throw new Error((res.stderr || '').slice(0, 300));
    // 子进程里 require 出来的 db.js 自己也会往 stdout 打日志（而且是 require 之后异步打的），
    // 所以不能拿"最后一行"当结果 —— 用标记行认。
    const pick = (mark) => {
      const line = String(res.stdout).split(/\r?\n/).find((l) => l.startsWith(mark));
      if (!line) throw new Error('子进程没打出 ' + mark + ' 结果行：' + String(res.stdout).slice(0, 200));
      return JSON.parse(line.slice(mark.length));
    };
    const rows = pick('__TITLE__');
    const byName = Object.fromEntries(rows.map((x) => [x.name, x.title]));
    s.ck('标题 = 对方姓名-日期时间-连接器备注名（单聊）',
      byName['单聊取对方姓名'] === '张三-2026-10-05 11:53-字留地', JSON.stringify(byName));
    s.ck('群聊的「对方姓名」位取群名',
      byName['群聊取群名'] === '研发一组-2026-10-05 09:05-字留地', byName['群聊取群名']);
    s.ck('会话没有名字时退回会话 ID（绝不拼出 `-时间-` 这种半截标题）',
      byName['没名字退回会话 ID'] === 'oc_noname-2026-10-05 08:00-字留地', byName['没名字退回会话 ID']);
    s.ck('时间戳非法时用当前时间兜底，标题依然成三段',
      /^李四-\d{4}-\d{2}-\d{2} \d{2}:\d{2}-字留地$/.test(byName['时间戳非法时取当前时间'] || ''),
      byName['时间戳非法时取当前时间']);
    const t2 = pick('__TITLE2__');
    s.ck('备注名缺失时兜到企业识别码、再兜到会话 ID',
      t2[0] === '王五-2026-10-05 10:00-tk_777' && t2[1] === '赵六-2026-10-05 10:00-oc_2', JSON.stringify(t2));
    s.ck('★ 标题里不再出现平台名（旧规则是「飞书-时间-企业识别码」）',
      rows.every((x) => !String(x.title).startsWith('飞书-')), JSON.stringify(rows));

    const rd = pick('__ROUND__');
    s.ck('分轮规则：该处理的处理、本轮已处理过的跳过', rd.bad.length === 0, rd.bad.join(' | ') || '7 个用例全对');
    s.ck('分轮规则保持原顺序（不乱序、不丢会话）', rd.order === 2, String(rd.order));

    // ★ 定时同步的时点：子进程跑在 TZ=UTC 下 —— 按服务器本地时间算就会错的那几条在这里现形
    const sl = pick('__SLOTS__');
    s.ck('★ 定时时点按北京时间算（子进程 TZ=UTC，10 条用例：每天/每周/周日/开关关/坏值）',
      sl.bad.length === 0, sl.bad.join(' | ') || `${sl.total} 条全对`);
    s.ck('★ 「到点没到点」判定：没跑过要跑、刚跑过不重复跑', sl.dueBad.length === 0, sl.dueBad.join(' | ') || '3 条全对');
    s.ck('自动跑的时刻写成北京时间字符串（与服务器时区无关）', sl.stamp === '2026-10-05 09:00:00', sl.stamp);

    // ★ 落地目录：两家飞书必须进两个不同目录（用户 2026-10-05 报的就是它们混在一起）
    const fd = pick('__FOLDERS__');
    s.ck('★ 两条飞书连接器各自一个子目录，名字取备注名',
      JSON.stringify(fd.connPaths) === JSON.stringify(['字留地-飞书个人 → 飞书/字留地-飞书个人', '公司飞书 → 飞书/公司飞书']),
      JSON.stringify(fd.connPaths));
    s.ck('★ 已归档的笔记跟着连接器搬家（靠 im_chats.note_id 认，不靠猜）',
      JSON.stringify(fd.notePaths) === JSON.stringify(['飞书/字留地-飞书个人', '飞书/公司飞书']), JSON.stringify(fd.notePaths));
    s.ck('迁移搬了 2 篇、清了 2 个空目录（企业微信/其他）', fd.moved === 2 && fd.removed === 2,
      JSON.stringify({ moved: fd.moved, removed: fd.removed }));
    s.ck('★ 有内容的目录绝不清（钉钉里那篇用户手放的笔记还在原处）',
      fd.keptNote === 'IM连接/钉钉', String(fd.keptNote));
    s.ck('迁移后 IM连接 下面只剩 飞书 + 钉钉', JSON.stringify(fd.leftOver) === JSON.stringify(['飞书', '钉钉'].sort()),
      JSON.stringify(fd.leftOver));
    s.ck('迁移是幂等的（再跑一遍：0 搬 0 清）', fd.againMoved === 0 && fd.againRemoved === 0,
      JSON.stringify({ moved: fd.againMoved, removed: fd.againRemoved }));
    s.ck('★ 两条连接器备注名撞车时也不合进一个目录（自动加「（2）」）',
      fd.dupPath === '飞书/公司飞书（2）', String(fd.dupPath));
    s.ck('反复算目录不会新建重复目录（返回的还是原来那个 id）', fd.stable === true, String(fd.stable));

    // ★ 归档正文的排版（v1.10.18）：用户要「最新的排在最上面」，不用翻到底下看新消息
    const od = pick('__ORDER__');
    s.ck('★ 段按时间从新到旧（最新的同步在最上面）',
      od.descOk === true, `段序列=${JSON.stringify(od.descHeads)}`);
    s.ck('★ 整篇第一条消息就是全局最新的那条（打开就能看到新内容）',
      od.topIsNewest === '2026-10-06 08:00', String(od.topIsNewest));
    s.ck('抬头的 `# 标题` 仍在最上面（只动消息顺序，不动抬头）',
      od.headFirst === '# 张三', String(od.headFirst));
    s.ck('★ 重复规整结果一模一样（幂等，重启多少次都不会漂）', od.idempotent === true, String(od.idempotent));
    s.ck('★ 换成正序（关掉开关）时段与段内都从旧到新（退回老样子）', od.ascOk === true, String(od.ascOk));
    s.ck('★ 换方向只改顺序、一行内容都不丢',
      od.lossless === true, String(od.lossless));
    s.ck('★ 老笔记（新消息本来是追加在下面）规整后被翻过来',
      od.legacyTop === '2026-10-05 20:12', String(od.legacyTop));
    s.ck('老笔记规整后一行不丢', od.legacyLossless === true, String(od.legacyLossless));
    s.ck('★ 正文里出现「像段标题」的行时，新同步段照样不会丢（自检兜底）',
      od.trapKept === true, String(od.trapKept));
    s.ck('平台 → 标签：飞书/钉钉/企业微信，不认识的平台不硬塞',
      JSON.stringify(od.tags) === JSON.stringify(['飞书', '钉钉', '企业微信', '']), JSON.stringify(od.tags));
    s.ck('只有显式存了 asc 才是正序，空值/坏值一律倒序',
      JSON.stringify(od.orderDefaults) === JSON.stringify([true, false, true]), JSON.stringify(od.orderDefaults));

    // ★ 标签 + 启动规整走真库（im_chats.note_id → 笔记）
    const tg = pick('__TAGS__');
    s.ck('★ 规整给已归档的笔记补上 #飞书（im_chats 认得的 4 篇都补到）',
      tg.first.tagged === 4, JSON.stringify(tg.first));
    s.ck('★ 老笔记的正文被翻成倒序（只翻那篇要翻的）', tg.first.reordered === 1, JSON.stringify(tg.first));
    s.ck('★ 补标签**不会冲掉**用户自己打的标签（#重要 还在）',
      JSON.stringify(tg.naTags) === JSON.stringify(['重要', '飞书']), JSON.stringify(tg.naTags));
    s.ck('另一篇也带上了 #飞书', JSON.stringify(tg.nbTags) === JSON.stringify(['飞书']), JSON.stringify(tg.nbTags));
    s.ck('★ 老笔记里「词频自动加的 #飞书」被升级成手动标签（否则下次改正文就被整批换掉）',
      JSON.stringify(tg.nbSources) === JSON.stringify([{ tag: '飞书', source: 'manual' }]), JSON.stringify(tg.nbSources));
    s.ck('★ 规整只碰 im_chats 认得的笔记：用户手放进目录的笔记一个标签都不加',
      tg.keptTags.length === 0 && tg.keptUntouched === true, JSON.stringify(tg.keptTags));
    s.ck('规整后那篇的正文是倒序的（第一条是 20:12）', tg.naTop === '2026-10-05 20:12', String(tg.naTop));
    s.ck('★ 存量笔记的抬头被换成当前口径（标题回到会话名，不再是老标题）',
      tg.naHead === '# 甲群', String(tg.naHead));
    s.ck('★★ 抬头就是 `imHeaderBlock` 现在写的那份（同步新写 / 规整老笔记**共用同一个定义**）',
      tg.naHeader === tg.naHeaderWant, `实际=${JSON.stringify(String(tg.naHeader).slice(0, 200))}`);
    s.ck('★ 换过的抬头里有「- 标签：#飞书」，旧版那句「每次同步把新消息追加在下面」已消失',
      /- 标签：#飞书/.test(tg.naHeader) && !/追加在下面/.test(tg.naHeader)
      && /新消息排在最上面/.test(tg.naHeader), JSON.stringify(String(tg.naHeader).slice(-120)));
    s.ck('★ 只刷抬头：同步段逐字没变、4 条消息一条不少',
      tg.naSecsKept === true && tg.naMsgs === 4, `段相同=${tg.naSecsKept} 消息数=${tg.naMsgs}`);
    s.ck('★ 抬头刷新只碰「我们写的」那几篇（na + nv 两篇）', tg.first.headered === 2, JSON.stringify(tg.first));
    // 抬头里用户自己插的行（`#公司`，`#` 后没空格 → 不是我们写的标题）绝不能被整块重建冲掉。
    // 冲掉的下场不只是少一行：标签会从「行内」掉成「词频自动」，下次改正文就被整批重算掉。
    s.ck('★★ 抬头里用户自己加的行原样留着（`#公司` 还在，且仍挨着标题）',
      tg.nvHead[1] === '#公司', JSON.stringify(tg.nvHead));
    s.ck('★ 那篇的抬头也补上了标签行 / 换掉了旧说明',
      tg.nvHead.includes('- 标签：#飞书') && tg.nvHead.some((l) => /新消息排在最上面/.test(l))
      && !tg.nvHead.some((l) => /追加在下面/.test(l)), JSON.stringify(tg.nvHead));
    s.ck('★ 用户整篇重写过的笔记（抬头里没有「- 会话 ID：」）正文一个字节都没动',
      tg.nuUntouched === true, String(tg.nuUntouched));
    s.ck('★ 但它的平台标签照样补上（标签看的是「这篇是哪个平台归档来的」，与正文归谁写无关）',
      JSON.stringify(tg.nuTags) === JSON.stringify(['飞书']), JSON.stringify(tg.nuTags));
    s.ck('★ 规整**不碰 updated_at**（否则每次重启所有 IM 笔记都会涌到文件夹最前面）',
      tg.updKept === true, String(tg.updKept));
    s.ck('★ 再规整一遍：0 补标签 0 重排 0 刷抬头（重启不会反复折腾）',
      tg.second.tagged === 0 && tg.second.reordered === 0 && tg.second.headered === 0, JSON.stringify(tg.second));
  } catch (e) {
    s.ck('纯函数 / 迁移用例未抛异常', false, String(e && e.message));
  } finally {
    try { fs.rmSync(TMP_TITLE, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Windows 句柄延迟 */ }
  }
} catch (e) {
  console.error('用例异常：', e && e.stack ? e.stack : e);
  s.ck('用例未抛异常', false, String(e && e.message));
} finally {
  s.done();
  stop();
}
