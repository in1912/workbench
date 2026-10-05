// 钉钉 dws CLI 的 e2e 替身（v1.10.22）。
//
// 怎么被用起来（scripts/e2e-im-dingtalk.mjs）：
//   DWS_PATH=<node.exe>、NODE_OPTIONS=--require <本文件> —— 于是「dws 二进制」其实是 node，
//   每次 spawn 都先加载本文件；带着 DWS_CONFIG_DIR 的就是 dws 子进程，按 argv 化身 CLI 后
//   process.exit(0)（绝不让 node 走到「把 auth/chat 当主脚本加载」那一步）。
//   服务器本体没有 DWS_CONFIG_DIR，加载了也直接 return，零影响。
//   Windows 上 spawn .cmd 会 EINVAL、.js 会 ENOENT —— 不引入真二进制时这是唯一可替换的路子。
//
// 认的输出口径全部从真 CLI（v1.0.63）源码钉来，别凭感觉改：
//   · 业务命令 = 信封 {ok,outcome,data,meta}；auth 那组是自有一层 {success,authenticated,...}
//   · 设备流登录的人话输出在 **stderr**：验证链接 + 「授权码: XXXX-XXXX」（extractLoginBits 认这个）
//   · 会话列表 data.conversations[{openConversationId,conversationName,conversationType:'group'|'direct'}]
//   · 群消息 data.messages[...]（列表投影）；搜索 data.conversationMessagesList[].messages（按会话分组）
//   · 消息行 {messageId,messageType,text,createTime(ms),senderId|sender,quotedMessage,resourceRefs}
if (!process.env.DWS_CONFIG_DIR) return;   // 服务器本体 / 其它 node 子进程：原样放行

const fs = require('node:fs');
const path = require('node:path');
const cfg = String(process.env.DWS_CONFIG_DIR);
const dataDir = path.resolve(cfg, '..', '..');   // cfg = <dataDir>/dws-config/<连接器id>
// 「dws」其实是 node：第一个子命令词（auth/chat/contact）会被 node 当成主脚本、解析成
// 绝对路径塞进 argv[1]，后面才是 process.argv.slice(2)。按 basename 认出来、用原名接回去。
const SUBCMDS = new Set(['auth', 'chat', 'contact']);
const a1 = String(process.argv[1] || '');
const args = SUBCMDS.has(path.basename(a1)) ? [path.basename(a1), ...process.argv.slice(2)] : process.argv.slice(2);

// 每次调用记一笔账：e2e 拿它断言「群走 +chat-messages / 单聊走 search-advanced / 配置目录按连接器隔离 /
// 随包根证书真的喂给了 CLI（SSL_CERT_FILE，容器缺系统 CA 的修法）」
try {
  fs.appendFileSync(path.join(dataDir, 'dws-stub-calls.jsonl'),
    JSON.stringify({ cmd: args.join(' '), args, cfg, ca: process.env.SSL_CERT_FILE || '' }) + '\n');
} catch { /* 记账失败不能影响扮演 */ }

const TOKEN = path.join(cfg, 'token.json');       // 「已登录」的标记（真 CLI 是加密令牌，这里只是个标记）
const DEVICE = path.join(cfg, 'device-flow.json');
const ANCHOR = path.join(cfg, 'anchor.json');
const SELF_ID = 'D-e2e-self-0001';                // 与 get-self 返回的一致 → 服务器据此把发送者识别成「我」

const out = (o) => { process.stdout.write(JSON.stringify(o) + '\n'); };
const env = (data, meta) => out({ ok: true, outcome: 'success', data, meta: meta || {} });
const fail = (type, message) => out({ ok: false, outcome: 'failure', error: { type, message } });

// 消息时间的锚点：第一次调用钉死，之后每次进程都读同一个值 —— 时间戳跨调用稳定，
// 「第二轮同步只取新消息」才不会因为 now 相对漂移把老消息又算成新的。
const base = (() => {
  try { return JSON.parse(fs.readFileSync(ANCHOR, 'utf8')).t0 - 3600e3; }
  catch {
    const t0 = Date.now();
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(ANCHOR, JSON.stringify({ t0 }));
    return t0 - 3600e3;
  }
})();

const flag = (name) => { const i = args.indexOf(name); return i >= 0 && i + 1 < args.length ? args[i + 1] : ''; };
// 每个会话的第几次拉取：n>=2 时多给一条「新消息」（模拟有增量）
const pullCount = (cid) => {
  const f = path.join(cfg, 'pull-' + cid + '.count');
  let n = 0;
  try { n = Number(fs.readFileSync(f, 'utf8')) || 0; } catch { /* 第一次 */ }
  fs.writeFileSync(f, String(n + 1));
  return n + 1;
};

// ---------- auth（自己的输出形状，不是信封） ----------
if (args[0] === 'auth' && args[1] === 'status') {
  // 设备流的「用户在手机上确认」一步：登录进程写下的 device-flow.json，被随后的 status 轮询
  // 看到时升级成令牌 —— 轮询节奏即确认时机，替身不需要真的等 15 分钟。
  if (!fs.existsSync(TOKEN) && fs.existsSync(DEVICE)) { try { fs.renameSync(DEVICE, TOKEN); } catch { /* 下次再升 */ } }
  if (fs.existsSync(TOKEN)) {
    process.stdout.write(JSON.stringify({
      success: true, authenticated: true, token_valid: true,
      corp_id: 'ding-e2e-corp', corp_name: '测试企业',
      user_id: 'u-e2e-001', user_name: '测试用户',
      expires_at: new Date(Date.now() + 86400e3).toISOString(), message: '已登录',
    }) + '\n');
  } else {
    process.stdout.write(JSON.stringify({ success: true, authenticated: false, message: '未登录', reason: 'no_token', hint: '' }) + '\n');
  }
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'login') {
  // 失败路径（生产实测 2026-10-06，输出形状照抄生产日志）：组织没开「允许成员通过 CLI
  // 访问个人数据」——OAuth 扫码那步先打出「授权成功!」，最后 Step 4 被拒、exit 2。
  // e2e 在连接器配置目录里放一个 fail-login 标记文件就走上这条路。
  if (fs.existsSync(path.join(cfg, 'fail-login'))) {
    process.stderr.write([
      '● Step 1: 请求设备授权码...', '',
      '  授权码: E2E1-FAIL', '  授权码将在 900 秒后过期。', '',
      '● Step 2: 等待用户授权...', '  ● [1] 轮询中... (5s) 授权成功!', '',
      '● Step 3: 使用授权码换取 Access Token...', '● Step 4: 检查组织 CLI 授权状态...', '',
      '⚠️  您暂无 CLI 数据访问权限', '   当前组织未授权您通过 CLI 访问个人数据。', '',
      '   组织主管理员：温泉', '   请联系组织主管理员开启后重新登录。', '',
      '   管理员操作入口：https://open-dev.dingtalk.com/fe/old#/developerSettings', '',
      JSON.stringify({ error: { actions: ['dws doctor --json'], category: 'auth', code: 2, message: 'device authorization failed: 您暂无 CLI 数据访问权限，请联系管理员开启' } }, null, 2),
    ].join('\n') + '\n');
    process.exit(2);
  }
  process.stderr.write('设备授权：在浏览器打开链接并用钉钉确认\n');
  process.stderr.write('https://login.dingtalk.com/oauth2/device/verify.htm?client_id=dws-e2e&user_code=E2E1-ABCD\n');
  process.stderr.write('授权码: E2E1-ABCD\n');
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(DEVICE, JSON.stringify({ code: 'E2E1-ABCD', at: Date.now() }));
  process.exit(0);
}
if (args[0] === 'auth' && args[1] === 'logout') {
  for (const f of [TOKEN, DEVICE]) { try { fs.rmSync(f, { force: true }); } catch { /* 没有就算了 */ } }
  env({ logged_out: true });
  process.exit(0);
}

// ---------- contact ----------
if (args[0] === 'contact' && args[1] === 'user' && args[2] === 'get-self') {
  if (!fs.existsSync(TOKEN)) { fail('auth', '未登录'); process.exit(0); }
  env({ result: { openDingTalkId: SELF_ID, userId: 'u-e2e-001', name: '测试用户' } });
  process.exit(0);
}

// ---------- 会话列表 ----------
if (args[0] === 'chat' && args[1] === '+conversation-list') {
  // 故意慢一点：给「两发并发同步、后到那发吃 409」留出窗口。
  // 必须是**同步**等待（Atomics.wait）—— 不能 setTimeout：preload 一返回 node 就去加载
  // 主脚本（chat）并当场 MODULE_NOT_FOUND 退出，定时器永远等不到。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
  env({
    count: 2, complete: true, hasMore: false, stopReason: 'source_complete', partial: false,
    conversations: [
      { openConversationId: 'cidE2EGROUP0000000001', conversationName: '钉钉测试群', conversationType: 'group' },
      { openConversationId: 'cidE2EP2P00000000002', conversationName: '王五', conversationType: 'direct' },
    ],
  }, { count: 2, operation: 'conversation_list', pagination: { hasMore: false } });
  process.exit(0);
}

// ---------- 拉消息 ----------
// 群（列表投影形状）。覆盖：字符串 sender、对象 sender、引用回复、图片、增量新消息
const groupMsgs = (n) => [
  { messageId: 'm-g1', messageType: 'text', text: '群聊第一条', createTime: base, senderId: 'D-e2e-zhangsan', sender: '张三' },
  { messageId: 'm-g2', messageType: 'text', text: '', createTime: base + 60e3, senderId: SELF_ID, sender: '测试用户', quotedMessage: { text: '被引用的原句' } },
  { messageId: 'm-g3', messageType: 'picture', createTime: base + 120e3, sender: { name: '李四', id: 'D-e2e-lisi' }, resourceRefs: [{ name: '图片.png' }] },
  ...(n >= 2 ? [{ messageId: 'm-g4n' + n, messageType: 'text', text: '群里新来的', createTime: base + 120e3 + 60e3 * (n - 1), senderId: 'D-e2e-zhao', sender: '赵六' }] : []),
];
// 单聊（搜索视图形状，按会话分组）。覆盖：文件、同 ID 重复行（必须被去重）、增量新消息
const p2pMsgs = (n) => [
  { messageId: 'm-p1', messageType: 'text', text: '单聊你好', createTime: base, senderId: 'D-e2e-peer', sender: '王五' },
  { messageId: 'm-p1', messageType: 'text', text: '重复行不该出现两次', createTime: base + 30e3, senderId: 'D-e2e-peer', sender: '王五' },
  { messageId: 'm-p2', messageType: 'file', createTime: base + 120e3, senderId: 'D-e2e-peer', resourceRefs: [{ name: '报表.xlsx' }] },
  ...(n >= 2 ? [{ messageId: 'm-p3n' + n, messageType: 'text', text: '单聊新消息', createTime: base + 120e3 + 60e3 * (n - 1), senderId: 'D-e2e-peer', sender: '王五' }] : []),
];

if (args[0] === 'chat' && args[1] === '+chat-messages') {
  const cid = flag('--group');
  if (!fs.existsSync(TOKEN)) { fail('auth', '未登录'); process.exit(0); }
  if (cid.startsWith('cidE2ECRASH')) { process.stdout.write('stub: 这不是 JSON\n'); process.exit(1); }   // 单会话失败隔离用
  const rows = groupMsgs(pullCount(cid));
  env({ messages: rows, count: rows.length, complete: true }, { count: rows.length, operation: 'chat_messages' });
  process.exit(0);
}
if (args[0] === 'chat' && args[1] === 'message' && args[2] === 'search-advanced') {
  const cid = flag('--conversation-ids');
  if (!fs.existsSync(TOKEN)) { fail('auth', '未登录'); process.exit(0); }
  const rows = p2pMsgs(pullCount(cid));
  env({ conversationMessagesList: [{ conversationId: cid, messages: rows }], count: rows.length }, { count: rows.length, operation: 'message_search' });
  process.exit(0);
}

// 兜底：没认识的子命令 —— 按非 JSON 处理，让上层如实报「CLI 没有返回 JSON」
process.stdout.write('stub: unknown command ' + args.join(' ') + '\n');
process.exit(1);
