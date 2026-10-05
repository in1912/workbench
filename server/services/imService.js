// IM 连接器（v1.10.5，需求①~⑤）：以**用户身份**授权，把该用户自己的聊天记录拉成笔记。
//
// ============ 合规红线（写在最前面，免得后来者走捷径） ============
//   只走 IM 官方开放平台的 OpenAPI + 官方 OAuth 2.0 授权码流程。
//   **绝不**逆向抓包、**绝不**模拟客户端 / 复用 Cookie、**绝不**用爬虫拉聊天记录。
//   任何「绕过官方授权直接读本地数据库」的路子都不做——哪怕技术上更省事。
//   用户随时可以在界面上解除授权；解除时删掉令牌（已经拉下来的笔记是他自己要的存档，留着）。
//
// ============ 为什么是「用户身份」而不是群机器人 ============
//   群机器人只能读到「机器人被拉进的群」里的**新**消息，拿不到个人单聊，也不是「我自己的记录」。
//   飞书开放平台支持 user_access_token 读**该用户所在会话**（含单聊与群聊）的消息，
//   对应权限：im:message.p2p_msg:get_as_user（单聊）+ im:message.group_msg:get_as_user（群聊）。
//   ⚠️ 已知边界（真机遇到时按这里排查，错误码文案集中在 feishuErrText）：
//     · 230002 官方文档写的是「机器人不在群组中」，但那是**应用身份**那条路的约束；
//       2026-04-29 起官方明确 user_access_token 可取该用户所在会话（含外部单聊与群聊）的消息，
//       不再要求机器人进群 —— 用户身份下撞到它更像「你自己也不在这个会话里」；
//     · 231203 群开了保密模式（禁止复制）—— 该群读不到；
//     · 231204 对外共享/关联组织 —— 2026-04-29 起该限制已取消。
//   会话列表默认**不含单聊**（公开文档明文），列单聊靠未公开但官方 CLI 在用的 types=p2p,group
//   （见 listAllChats），拿不到时界面还有「手动添加会话 ID」兜底。
//
// ============ 钉钉走的是另一条官方通道（v1.10.22） ============
//   钉钉没有公开的「用户身份读会话」OpenAPI，官方给的通道是 dws CLI（OAuth 设备流 + 官方 MCP 网关，
//   报文在网关侧加密、CLI 本地解密 —— 所以没法绕开 CLI 直连，只能子进程调用）。
//   传输层在 server/services/dingtalkDws.js；凭证由 CLI 自己加密存在
//   dataDir/dws-config/<连接器id>/，**im_connectors 里不落任何钉钉令牌** ——
//   publicConnector 的 authorized 对钉钉只看 status。登录走设备流（前端展示验证链接 + 授权码），
//   同步流程（目录/排版/标签/增量游标/分轮预算）与飞书共用同一套代码，
//   钉钉消息先映射成飞书形状（dingtalkDws.projectToFeishuShape）再进同一条管线。
//
// ============ 企业微信走的也是官方 CLI 通道（v1.10.25） ============
//   与钉钉同构：官方 wecom-cli（npm @wecom/cli，Rust 二进制）+ 智能机器人凭证（Bot ID + Secret），
//   机器人代授权人读其会话。传输层在 server/services/wecomCli.js；凭证由 CLI 自己加密存在
//   dataDir/wecom-config/<连接器id>/（目录自包含，整目录可迁移），im_connectors 里只存
//   Bot ID / Secret（复用 app_id / app_secret 两列，publicConnector 照样擦掉）。
//   官方两条硬边界（详见 wecomCli.js 文件头）：>10 人的组织整个 chat 服务被拒（853006）；
//   回溯窗只有 7 天（850016）—— 增量归档没问题，补不了老历史。群聊自动发现，单聊官方没有
//   枚举接口，靠「添加单聊」+ contact users search 按联系人登记。
//
// ============ 数据与凭证放哪 ============
//   im_connectors / im_chats / im_sync_logs 都在**租户库**（每个用户一个私有 sqlite），
//   所以 app_secret / access_token / refresh_token 存租户库 = 存在用户自己的库里；
//   但**任何返回给前端的对象都必须先过 publicConnector() 擦掉这三个字段**。
//   im_oauth_states 在**主库**：OAuth 回跳那条请求上没有工作台登录态（非网关部署时令牌只在
//   localStorage），只能靠一次性 state 反查「这是哪个用户的哪条连接器」。state 10 分钟过期、用完即删。
const crypto = require('node:crypto');
const db = require('../db');
const noteService = require('./noteService');
const dws = require('./dingtalkDws');
const wecom = require('./wecomCli');

const FEISHU_API = 'https://open.feishu.cn/open-apis';
// 授权入口在 **accounts** 域名下，且参数名是 client_id（值才是 App ID）。
// 老的 open.feishu.cn/open-apis/authen/v1/index（参数 app_id）**不支持 scope**，别用。
const FEISHU_AUTHORIZE = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
// 换票 / 刷新都走 v3（v2 的 open-apis/authen/v2/oauth/token 已被官方标注历史版本）。
// 它俩的响应形状一样：**顶层**字段 + code=0（不在 data 里）。请求体用 form-urlencoded。
const FEISHU_TOKEN = 'https://accounts.feishu.cn/oauth/v3/token';
// 用户身份读取会话消息所需的最小权限集：列自己所在的群 + 读单聊 + 读群聊。
// 前两个 scope 也要一并申请，否则列会话列表这一步就 403（应用身份与用户身份的 scope 不通用）。
// **offline_access 不能漏**：不给它，换票响应里根本没有 refresh_token，
// 而 user_access_token 只有约 2 小时寿命 —— 漏了的表现是「授权成功，两小时后同步全部 401，只能重新授权」。
// （用它的前提是开放平台里也开通了 offline_access 权限，否则用户授权时报 20027。）
const FEISHU_SCOPES = [
  'im:chat:readonly',
  'im:message:readonly',
  'im:message.p2p_msg:get_as_user',
  'im:message.group_msg:get_as_user',
  'offline_access',
].join(' ');

// 平台清单。tag 是归档笔记自动挂上的平台标签（#飞书 / #钉钉 / #企业微信），**单独一个字段**
// 而不是复用 name：标签是写进库里的事实，name 只是界面文案 —— 哪天想把 name 改成「飞书（Lark）」，
// 标签不该跟着变。
// auth 是授权形态：feishu=应用凭证 + OAuth 授权码回跳；dingtalk=官方 CLI 设备流扫码（无应用凭证）；
// wecom=智能机器人凭证（Bot ID + Secret，服务端 PTY 桥代填，无回调地址）。
const PROVIDERS = {
  feishu: {
    key: 'feishu', name: '飞书', folder: '飞书', tag: '飞书', ready: true, auth: 'oauth',
    hint: '自建应用 + 用户在浏览器里点一次授权。可授权多个企业（多家飞书各建一条连接器）。',
  },
  dingtalk: {
    key: 'dingtalk', name: '钉钉', folder: '钉钉', tag: '钉钉', ready: true, auth: 'device',
    hint: '官方 dws CLI 通道：扫码授权（OAuth 设备流），不用自建应用。需要企业管理员在钉钉开放平台开启「允许成员通过 CLI 访问个人数据」。已知边界：单聊历史走官方消息搜索通道，个别组织没开通「消息搜索」权限时单聊会同步失败（群聊不受影响），报错会写进该会话的失败原因里。',
  },
  wecom: {
    key: 'wecom', name: '企业微信', folder: '企业微信', tag: '企业微信', ready: true, auth: 'credentials',
    hint: '官方 wecom-cli 通道：智能机器人凭证（Bot ID + Secret），点「验证授权」即可，不用回调地址。官方两条硬边界：① 聊天记录拉取只对 10 人及以下的组织开放（大组织会被官方拒绝）；② 只能拉最近 7 天的消息，老历史补不了。群聊自动发现；单聊官方没有列表接口，用「添加单聊」按联系人登记。',
  },
};

// ---------- 小工具 ----------
const nowMs = () => Date.now();
const enc = (s) => encodeURIComponent(String(s == null ? '' : s));

function bad(msg, code = 400) { const e = new Error(msg); e.code = code; return e; }

/** 只读的一次性 state：主库表，10 分钟过期 */
function purgeStates() {
  try { db.db.prepare("DELETE FROM im_oauth_states WHERE created_at < datetime('now','localtime','-10 minutes')").run(); } catch { /* 表还没建好就算了 */ }
}
function newState(uid, connectorId) {
  purgeStates();
  const st = crypto.randomBytes(24).toString('hex');
  db.db.prepare('INSERT INTO im_oauth_states(state,uid,connector_id) VALUES(?,?,?)').run(st, Number(uid), Number(connectorId));
  return st;
}
function takeState(state) {
  purgeStates();
  const row = db.db.prepare('SELECT * FROM im_oauth_states WHERE state=?').get(String(state || ''));
  if (!row) return null;
  db.db.prepare('DELETE FROM im_oauth_states WHERE state=?').run(String(state));
  return { uid: Number(row.uid), connectorId: Number(row.connector_id) };
}

function fmtTime(ms) {
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
const shortId = (id) => String(id || '').slice(-6);

// ---------- 连接器 CRUD ----------
function getConnector(tdb, id) { return tdb.prepare('SELECT * FROM im_connectors WHERE id=?').get(Number(id)); }

function publicConnector(c) {
  if (!c) return null;
  const p = PROVIDERS[c.provider] || { name: c.provider, ready: false };
  const { app_secret, access_token, refresh_token, ...rest } = c; // eslint-disable-line no-unused-vars
  return {
    ...rest, id: Number(c.id),
    provider_name: p.name,
    folder_id: c.folder_id == null ? null : Number(c.folder_id),
    // 钉钉/企业微信的令牌在 CLI 自己的加密目录里（im_connectors 不存），所以只认 status；
    // 飞书还是老口径：授权过且手里有 access_token。
    authorized: c.status === 'authorized' && (c.provider === 'dingtalk' || c.provider === 'wecom' || !!c.access_token),
    has_secret: !!app_secret,
    expires_at_ms: Number(c.expires_at) || 0,
  };
}

function listConnectors(tdb) {
  return tdb.prepare('SELECT * FROM im_connectors ORDER BY id').all().map(publicConnector);
}

function createConnector(tdb, b = {}) {
  const provider = String(b.provider || 'feishu');
  const p = PROVIDERS[provider];
  if (!p) throw bad('不认识的 IM 平台');
  if (!p.ready) throw bad(`${p.name}暂时接不了：${p.hint}`);
  // 钉钉：没有应用凭证这一说（官方 CLI 设备流），建完就是一条「待扫码」的空壳，
  // 身份信息等登录成功后由 dingtalkLoginProgress 落库。
  if (provider === 'dingtalk') {
    const r = tdb.prepare("INSERT INTO im_connectors(provider,label,status) VALUES(?,?,'new')")
      .run(provider, String(b.label || '').trim());
    return publicConnector(getConnector(tdb, Number(r.lastInsertRowid)));
  }
  // 企业微信：智能机器人凭证两件套（Bot ID + Secret），复用 app_id / app_secret 两列存，
  // 没有回调地址；建完是「待验证」，点「验证授权」走 PTY 桥把凭证灌给 CLI。
  if (provider === 'wecom') {
    const botId = String(b.app_id || '').trim();
    if (!botId) throw bad('请填智能机器人的 Bot ID');
    const secret = String(b.app_secret || '').trim();
    if (!secret) throw bad('请填智能机器人的 Secret');
    const r = tdb.prepare("INSERT INTO im_connectors(provider,label,app_id,app_secret,status) VALUES(?,?,?,?,'new')")
      .run(provider, String(b.label || '').trim(), botId, secret);
    return publicConnector(getConnector(tdb, Number(r.lastInsertRowid)));
  }
  const appId = String(b.app_id || '').trim();
  if (!appId) throw bad('请填自建应用的 App ID');
  const secret = String(b.app_secret || '').trim();
  if (!secret) throw bad('请填自建应用的 App Secret');
  const redirect = String(b.redirect_uri || '').trim();
  if (!/^https?:\/\//.test(redirect)) throw bad('回调地址要是一个完整 URL（飞书那边也必须登记同一个，必须完全一致）');
  const r = tdb.prepare(
    'INSERT INTO im_connectors(provider,label,app_id,app_secret,redirect_uri,status) VALUES(?,?,?,?,?,?)'
  ).run(provider, String(b.label || '').trim(), appId, secret, redirect, 'new');
  return publicConnector(getConnector(tdb, Number(r.lastInsertRowid)));
}

function updateConnector(tdb, id, b = {}) {
  const cur = getConnector(tdb, id);
  if (!cur) return null;
  const isDing = cur.provider === 'dingtalk';   // 钉钉没有应用凭证三件套，那些校验与重置都跳过
  const isWecom = cur.provider === 'wecom';     // 企业微信有 Bot ID/Secret（存 app_id/app_secret），但没有回调地址
  const label = b.label === undefined ? cur.label : String(b.label || '').trim();
  const appId = b.app_id === undefined ? cur.app_id : String(b.app_id || '').trim();
  // 前端拿到的 app_secret 永远是空的；只有真的传了新串才覆盖（避免「保存一下就清空」）
  const secret = (b.app_secret === undefined || b.app_secret === '' || b.app_secret === '******')
    ? cur.app_secret : String(b.app_secret).trim();
  const redirect = b.redirect_uri === undefined ? cur.redirect_uri : String(b.redirect_uri || '').trim();
  if (redirect && !/^https?:\/\//.test(redirect)) throw bad('回调地址要是一个完整 URL');
  if (!isDing && !appId) throw bad(isWecom ? 'Bot ID 不能为空' : 'App ID 不能为空');
  // 换了 app_id / secret → 旧令牌作废，必须重新授权（钉钉无应用凭证，恒为 false；
  // 企业微信换 Bot ID/Secret 同样要重新点「验证授权」，wecomInitAuth 会先清掉 CLI 旧凭证）
  const changedApp = !isDing && (appId !== cur.app_id || secret !== cur.app_secret);

  // 定时同步（v1.10.14，需求③）：每条连接器各设各的。校验放在这里而不是路由，
  // 是因为调度器直接读库，库里存着坏时刻（比如「25:99」）会让它每分钟空转一次。
  const autoSync = b.auto_sync === undefined ? (Number(cur.auto_sync) ? 1 : 0) : (b.auto_sync ? 1 : 0);
  const autoFreq = b.auto_freq === undefined ? String(cur.auto_freq || 'daily') : String(b.auto_freq || 'daily');
  if (!['daily', 'weekly'].includes(autoFreq)) throw bad('定时同步的频率只能是每天或每周');
  // 个小时写法（「8:30」）先补零成「08:30」再校验 —— 校验用的正则**必须和 autoSyncSlot 里那个一模一样**。
  // 曾经这里是 /^([01]?\d|2[0-3]):[0-5]\d$/（放行单数字小时），而取时点那边要求两位：结果是
  // API 直接把 8:30 存进库 → autoSyncSlot 认不出 → 返回空 → 这条连接器**开着开关却永远不跑**。
  // 补零不是「夹取」：夹取是把 25:99 悄悄变成 23:59（改了时刻），补零是同一个时刻换一种写法。
  const autoTime = (b.auto_time === undefined ? String(cur.auto_time || '08:00') : String(b.auto_time || '08:00'))
    .replace(/^(\d):/, '0$1:');
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(autoTime)) throw bad('定时同步的时间要写成 HH:MM（24 小时制）');
  const autoWeekday = b.auto_weekday === undefined
    ? Math.min(7, Math.max(1, Number(cur.auto_weekday) || 1))
    : Math.min(7, Math.max(1, Number(b.auto_weekday) || 1));
  const autoDays = b.auto_days === undefined
    ? Math.min(3650, Math.max(1, Number(cur.auto_days) || 30))
    : Math.min(3650, Math.max(1, Number(b.auto_days) || 30));
  // 归档正文排版（v1.10.18）。显式白名单：库里存了别的值（手改过库 / 老版本）一律当 desc 处理，
  // 免得一个拼错的串被存进去之后，前端那个「新消息在最上面」的勾选框显示的和实际行为对不上。
  const noteOrder = b.note_order === undefined
    ? (String(cur.note_order || 'desc') === 'asc' ? 'asc' : 'desc')
    : (String(b.note_order) === 'asc' ? 'asc' : 'desc');

  tdb.prepare(
    `UPDATE im_connectors SET label=?,app_id=?,app_secret=?,redirect_uri=?,
       auto_sync=?,auto_freq=?,auto_time=?,auto_weekday=?,auto_days=?,note_order=?,
       ${changedApp ? "access_token='',refresh_token='',expires_at='',status='new',tenant_key='',user_open_id='',user_name=''," : ''}
       last_error='' WHERE id=?`
  ).run(label, appId, secret, redirect, autoSync, autoFreq, autoTime, autoWeekday, autoDays, noteOrder, Number(id));
  // 改了排版方向 → 立刻把这批笔记规整一遍，用户不用等下一次同步才看到效果
  if (noteOrder !== String(cur.note_order || 'desc')) {
    try { normalizeImNotes(tdb, Number(id)); } catch { /* 规整失败不影响保存 */ }
  }
  const fresh = getConnector(tdb, id);
  // 备注名是目录名的来源 → 改名后目录跟着改名（只 UPDATE 名字，目录 id 不变，
  // 所以里面笔记的归属不受影响；还没建过目录的等首次同步时用新名字建）。
  if (label !== cur.label) syncConnectorFolderName(tdb, fresh);
  return publicConnector(getConnector(tdb, id));
}

function deleteConnector(tdb, id) {
  const cur = getConnector(tdb, id);
  if (!cur) return null;
  // 钉钉/企业微信：连接器没了，CLI 那份凭证目录也一并清掉（异步清，不挡删除本身）
  if (cur.provider === 'dingtalk') dws.dwsLogout(cur.id).catch(() => {});
  if (cur.provider === 'wecom') wecom.wecomLogout(cur.id).catch(() => {});
  tdb.prepare('DELETE FROM im_chats WHERE connector_id=?').run(Number(id));
  tdb.prepare('DELETE FROM im_sync_logs WHERE connector_id=?').run(Number(id));
  tdb.prepare('DELETE FROM im_connectors WHERE id=?').run(Number(id));
  return { id: Number(id), label: cur.label, provider: cur.provider };
}

/** 解除授权：只丢令牌与状态，连接器配置和已导出的笔记都留着（重新点授权即可再来一次） */
async function revokeConnector(tdb, id) {
  const cur = getConnector(tdb, id);
  if (!cur) return null;
  if (cur.provider === 'dingtalk' || cur.provider === 'wecom') {
    // 钉钉/企业微信的令牌在 CLI 的加密目录里：让 CLI 退出登录，再把整个目录删掉（身份字段也清空，
    // 因为目录没了、下次登录会重新写）。飞书侧保持老口径：只清令牌，身份识别码留着。
    if (cur.provider === 'dingtalk') await dws.dwsLogout(cur.id);
    else await wecom.wecomLogout(cur.id);
    tdb.prepare("UPDATE im_connectors SET access_token='',refresh_token='',expires_at='',status='new',tenant_key='',user_open_id='',user_name='',last_error='' WHERE id=?").run(Number(id));
  } else {
    tdb.prepare("UPDATE im_connectors SET access_token='',refresh_token='',expires_at='',status='new',last_error='' WHERE id=?").run(Number(id));
  }
  return publicConnector(getConnector(tdb, id));
}

// ---------- 授权 ----------
/** 钉钉设备流登录：三个包装给路由用（启动 / 查进度 / 取消），身份落库发生在「查进度」里 ——
 *  那是前端登录面板每 2 秒都会打的接口，登录成功的瞬间正好被它看见。 */
function dingtalkLoginStart(tdb, id) {
  const c = getConnector(tdb, id);
  if (!c) throw bad('连接器不存在', 404);
  if (c.provider !== 'dingtalk') throw bad('这条连接器不是钉钉');
  if (!dws.dwsReady()) throw bad('服务器上没找到钉钉 dws CLI。请安装 dingtalk-workspace-cli，或把对应平台的 dws 二进制放到数据目录 dws/bin/（升级包已随附 linux 版）');
  const r = dws.dwsStartLogin(c.id);
  return { started: !!r.started, already: !!r.already };
}

async function dingtalkLoginProgress(tdb, id) {
  const c = getConnector(tdb, id);
  if (!c) throw bad('连接器不存在', 404);
  const p = await dws.dwsLoginProgress(c.id);
  // 登录成功 → 把身份写进连接器（企业名/用户名/openDingTalkId —— 最后那个用于识别「我」，
  // 消息里发送者用的是 openDingTalkId 这一族 ID，拿 user_id 对不上）。只在状态翻转的那一刻写一次。
  if (p.authenticated && c.status !== 'authorized') {
    const ident = p.identity || {};
    const self = await dws.dwsSelfIdentity(c.id);
    tdb.prepare("UPDATE im_connectors SET status='authorized',tenant_key=?,user_name=?,user_open_id=?,last_error='' WHERE id=?")
      .run(ident.corp_name || '', ident.user_name || self.name || '', self.open_dingtalk_id || ident.user_id || '', c.id);
    log(tdb, c.id, 'info', `钉钉登录成功：${ident.corp_name || '未知企业'}${ident.user_name ? ' / ' + ident.user_name : ''}`);
  }
  return { ...p, connector: publicConnector(getConnector(tdb, c.id)) };
}

function dingtalkLoginCancel(tdb, id) {
  const c = getConnector(tdb, id);
  if (!c) throw bad('连接器不存在', 404);
  return dws.dwsCancelLogin(c.id);
}

/**
 * 企业微信：验证授权。用表单里存的 Bot ID + Secret 走一次 PTY 授权桥（auth init --manual），
 * 成功后把授权人身份（userid + 姓名，从响应信封解析）落库 —— 「我」的识别全靠它。
 * 最后再探一次会话枚举：>10 人的组织**授权本身能成功**、但 chat 服务会被拒（853006），
 * 这个矛盾不在验证时点破，用户就会在「明明授权了」和「同步被拒」之间打转 ——
 * 探测结果走 warning 返回给前端显示，状态仍是 authorized（授权确实是好的）。
 */
async function wecomVerify(tdb, id) {
  const c = getConnector(tdb, id);
  if (!c) throw bad('连接器不存在', 404);
  if (c.provider !== 'wecom') throw bad('这条连接器不是企业微信');
  if (!wecom.wecomReady()) throw bad('服务器上没找到 wecom CLI。请安装 @wecom/cli，或把对应平台的 wecom-cli 二进制放到数据目录 wecom/bin/（升级包已随附 linux 版）');
  if (!c.app_id || !c.app_secret) throw bad('先填好机器人的 Bot ID 和 Secret 再验证');
  const r = await wecom.wecomInitAuth(c.id, c.app_id, c.app_secret);
  const st = await wecom.wecomAuthStatus(c.id);
  if (!st.authenticated) {
    // CLI 的报错在 PTY 输出里，取最后一个非空行当原因（前面的都是提示词回显；
    // 先剥掉 dialoguer 的 ANSI 转义，否则遮罩行会混进「最后一个非空行」里）
    const detail = String(r.output || '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').split('\n').map((s) => s.trim()).filter(Boolean).pop() || '';
    const msg = ('企业微信授权失败' + (detail ? '：' + detail : '')).slice(0, 300);
    tdb.prepare("UPDATE im_connectors SET status='error',last_error=? WHERE id=?").run(msg, c.id);
    log(tdb, c.id, 'error', msg);
    throw bad(msg, 400);
  }
  const ident = await wecom.wecomSelfIdentity(c.id) || {};
  tdb.prepare("UPDATE im_connectors SET status='authorized',user_open_id=?,user_name=?,last_error='' WHERE id=?")
    .run(String(ident.user_id || ''), String(ident.user_name || ''), c.id);
  let warning = '';
  try {
    await wecom.wecomListChatsFor(c.id, 1);
  } catch (e) {
    warning = String(e.message || e).slice(0, 300);
    tdb.prepare('UPDATE im_connectors SET last_error=? WHERE id=?').run(warning, c.id);
  }
  log(tdb, c.id, 'info', `企业微信授权成功${ident.user_name ? '：' + ident.user_name : ''}${warning ? '；⚠ ' + warning : ''}`);
  return { connector: publicConnector(getConnector(tdb, c.id)), warning };
}

/** 企业微信：按姓名搜组织成员（「添加单聊」的选择器用）。只读。 */
async function wecomSearchContacts(tdb, id, keywords) {
  const c = getConnector(tdb, id);
  if (!c) throw bad('连接器不存在', 404);
  if (c.provider !== 'wecom') throw bad('这条连接器不是企业微信');
  const st = await wecom.wecomAuthStatus(c.id);
  if (!st.authenticated) throw bad('企业微信还没验证授权，先点「验证授权」');
  return wecom.wecomContactSearch(c.id, keywords);
}

function authorizeUrl(tdb, uid, id) {
  const c = getConnector(tdb, id);
  if (!c) throw bad('连接器不存在', 404);
  if ((PROVIDERS[c.provider] || {}).auth === 'device') throw bad('钉钉不用应用凭证授权，点「扫码登录钉钉」走设备流');
  if ((PROVIDERS[c.provider] || {}).auth === 'credentials') throw bad('企业微信不用回调授权，点「验证授权」把机器人凭证灌给官方 CLI');
  if (!c.app_id || !c.app_secret) throw bad('先填好 App ID / App Secret 再授权');
  if (!c.redirect_uri) throw bad('先填好回调地址再授权');
  const state = newState(uid, c.id);
  return `${FEISHU_AUTHORIZE}?client_id=${enc(c.app_id)}&response_type=code`
    + `&redirect_uri=${enc(c.redirect_uri)}&scope=${enc(FEISHU_SCOPES)}&state=${enc(state)}`;
}

// v3 的 oauth/token 用 form-urlencoded（v2 才是 json；文档说 v3 也兼容 json，但以 form 为准）
async function postToken(body) {
  const r = await fetch(FEISHU_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(20000),
  });
  let j = null;
  try { j = await r.json(); } catch { /* 非 JSON 走下面统一报错 */ }
  if (!j) throw bad(`飞书换票接口返回了非 JSON（HTTP ${r.status}）`, 502);
  return j;
}

// v3 换票成功时是**顶层**字段 + code=0（不在 data 里）；失败时同样给 code + error/error_description。
// 有效期一律按返回的 expires_in 算 —— 官方明确 expires_in / refresh_token_expires_in 都是「非固定值」。
function pickToken(j) {
  if (j.code !== 0 || !j.access_token) {
    const msg = j.error_description || j.msg || j.error || '未知错误';
    const e = bad(`飞书换取令牌失败：${msg}（code=${j.code}）`, 502);
    e.feishuCode = j.code;
    throw e;
  }
  return {
    access_token: j.access_token,
    refresh_token: j.refresh_token || '',
    expires_in: Number(j.expires_in) || 7200,
  };
}

/** 授权码 → 用户令牌；顺手把用户身份与企业识别码（tenant_key）记下来 */
async function exchangeCode(conn, code) {
  const j = await postToken({
    grant_type: 'authorization_code',
    client_id: conn.app_id,
    client_secret: conn.app_secret,
    code: String(code),
    redirect_uri: conn.redirect_uri,
  });
  return pickToken(j);
}

/** 用 access_token 拿用户信息：tenant_key 就是「IM 授权企业的识别码」 */
async function fetchUserInfo(accessToken) {
  const r = await fetch(`${FEISHU_API}/authen/v1/user_info`, {
    headers: { Authorization: 'Bearer ' + accessToken },
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => null);
  if (!j || j.code !== 0) throw bad(`读取飞书用户信息失败：${(j && j.msg) || '未知错误'}`, 502);
  const d = j.data || {};
  return { name: d.name || '', open_id: d.open_id || '', tenant_key: d.tenant_key || '', avatar: d.avatar_url || '' };
}

/**
 * OAuth 回跳（免登录路由调用）：state → 用户/连接器 → 换令牌 → 落库。
 * 返回 { ok, message, uid }，路由据此渲染一张极简 HTML 页面（用户在手机/浏览器里看到的）。
 */
async function handleCallback(code, state) {
  const st = takeState(state);
  if (!st) return { ok: false, message: '授权链接已过期或已被使用，请回到工作台重新点「授权」' };
  if (!code) return { ok: false, message: '飞书没有带回授权码（可能你点了拒绝授权）' };
  const tdb = db.getTenantDb(st.uid);
  const conn = getConnector(tdb, st.connectorId);
  if (!conn) return { ok: false, message: '连接器已被删除' };
  try {
    const tok = await exchangeCode(conn, code);
    const u = await fetchUserInfo(tok.access_token);
    const exp = nowMs() + tok.expires_in * 1000;
    tdb.prepare(
      `UPDATE im_connectors SET access_token=?,refresh_token=?,expires_at=?,tenant_key=?,
         user_open_id=?,user_name=?,status='authorized',last_error='' WHERE id=?`
    ).run(tok.access_token, tok.refresh_token, String(exp), u.tenant_key, u.open_id, u.name, conn.id);
    log(tdb, conn.id, 'info', `授权成功：${u.name || u.open_id}（企业 ${u.tenant_key || '未知'}）`);
    return { ok: true, uid: st.uid, message: `授权成功${u.name ? '，' + u.name : ''}`, name: u.name, tenant: u.tenant_key };
  } catch (e) {
    tdb.prepare("UPDATE im_connectors SET status='error',last_error=? WHERE id=?").run(String(e.message || e).slice(0, 300), conn.id);
    log(tdb, conn.id, 'error', '授权失败：' + (e.message || e));
    return { ok: false, uid: st.uid, message: '换取令牌失败：' + (e.message || e) };
  }
}

/** 到点就用 refresh_token 换新的。两个有效期都**不固定**（令牌约 2 小时、refresh 示例 7 天），
 *  一律按上次返回的 expires_in 算；refresh_token 是一次性的，换完必须存回新的那一个。
 *  另有硬规则：用户授权满 365 天必须重新走一次授权，刷不过去（20037）。 */
async function ensureToken(tdb, conn) {
  if (conn.access_token && Number(conn.expires_at) > nowMs() + 120000) return conn.access_token;
  if (!conn.refresh_token) {
    // 常见原因之一：授权时没申请 offline_access，换票响应里就没有 refresh_token
    throw bad('授权已失效（没有可用的刷新令牌），请重新点「授权」', 400);
  }
  const j = await postToken({
    grant_type: 'refresh_token',
    client_id: conn.app_id,
    client_secret: conn.app_secret,
    refresh_token: conn.refresh_token,
  });
  try {
    const tok = pickToken(j);
    const exp = nowMs() + tok.expires_in * 1000;
    tdb.prepare('UPDATE im_connectors SET access_token=?,refresh_token=?,expires_at=?,status=?,last_error=? WHERE id=?')
      .run(tok.access_token, tok.refresh_token || conn.refresh_token, String(exp), 'authorized', '', conn.id);
    return tok.access_token;
  } catch (e) {
    tdb.prepare("UPDATE im_connectors SET status='expired',last_error=? WHERE id=?").run(String(e.message).slice(0, 300), conn.id);
    throw bad('飞书授权已过期，请重新点「授权」', 400);
  }
}

// ---------- 飞书接口 ----------
async function feishuGet(token, path, params) {
  const url = new URL(FEISHU_API + path);
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(25000) });
  const j = await r.json().catch(() => null);
  if (!j) throw bad(`飞书接口返回了非 JSON（HTTP ${r.status}）`, 502);
  if (j.code !== 0) {
    const e = bad(feishuErrText(j, r), 502);
    e.feishuCode = j.code;
    throw e;
  }
  return j.data || {};
}

/** 把飞书的错误码翻译成「用户能照着做」的话（这几个是真机上会撞到的边界）。
 *  第二个参数是 fetch 的 Response，只为了在限流时读官方那两个响应头：
 *  `x-ogw-ratelimit-reset` = 还要等多少秒恢复（官方文档说这就是解除限频的最好办法）。 */
function feishuErrText(j, r) {
  const code = Number(j.code);
  const base = `飞书接口错误 ${j.code}：${j.msg || ''}`;
  // 限流专用话术：把「等多久」直接算出来告诉用户，而不是让他自己猜「稍后」是多久。
  const reset = r && r.headers ? Number(r.headers.get('x-ogw-ratelimit-reset')) : NaN;
  const wait = Number.isFinite(reset) && reset > 0 ? `官方建议等约 ${Math.ceil(reset)} 秒再重试` : '官方建议稍等再重试';
  const throttle = (extra) => `${base}（${extra}。${wait}；这次同步没做成的事不会白费 —— 进度是按会话逐个记的，'
    + '已经拉完的下次跳过、没拉完的从上次的位置接着拉）`;
  // 230002 的字面意思是「机器人不在群组中」，但那是**应用身份**那条路的约束：
  // 2026-04-29 起，官方明确 user_access_token 可以取该用户所在会话（含外部单聊/群聊）的消息，
  // 不再要求机器人进群。用户身份下撞到它，更可能是「这个会话用户自己也不在/已被移出」。
  if (code === 230002) return `${base}（读不到这个会话 —— 确认你自己还在这个群里；应用身份读群消息才要求把机器人拉进群，用户身份不需要）`;
  // 232025「Bot ability is not activated」：**跟授权、跟权限范围都不是一回事**。
  // 整组 im/v1/* 接口在飞书那边挂在「机器人」这个应用能力下 —— 哪怕我们全程用的是
  // user_access_token（用户身份），只要应用没在开发者后台加过「机器人」能力，调 /im/v1/chats
  // 也会被这一步挡住。真机撞到的样子很迷惑：连接器显示「已授权」、用户也是对的，
  // 一点同步就报这个。所以话必须说清楚「去哪点、点什么、要不要发布」。
  if (code === 232025) {
    return `${base}（应用没开「机器人」能力 —— 去飞书开放平台 → 你的应用 → 「添加应用能力」→ 勾上「机器人」，`
      + '然后**发布版本**（等审批通过）再回来同步。注意这跟授权是两码事：授权那步只给了用户身份和权限范围，'
      + 'IM 这组接口本身还要求应用具备机器人能力，所以这里显示「已授权」也会照报这个错）';
  }
  if (code === 231203) return `${base}（这个群开了保密模式，禁止复制消息，官方接口读不到）`;
  if (code === 231204) return `${base}（这个应用开了「对外共享/关联组织」。2026-04-29 起该限制已取消，若仍报此错请确认应用的对外共享状态或联系开放平台）`;
  if (code === 99991672 || code === 99991679) return `${base}（应用没开对应的用户身份权限，去开放平台勾上 im:message.p2p_msg:get_as_user / im:message.group_msg:get_as_user 并发布版本）`;
  if (code === 20027) return `${base}（授权链接里带了应用后台没开通的权限，去开放平台把这几个权限都申请了再授权）`;
  if (code === 20037) return `${base}（用户授权已满 365 天，刷新令牌不再可用，必须重新点「授权」）`;
  // 限流。官方文档：超限返回 HTTP 429（部分旧接口是 400），业务码 99991400
  //「request trigger frequency limit」；**消息类 API 返回的是 230020**，两个都得接住。
  // 官方明确这**只是拒绝请求、不是封号/封应用** —— 封禁/下架/清退是另一套「安全违规」规范，
  // 与调用频率无关（《频控策略》整篇只描述 429 + 响应头 + 重试，没有一个字提封禁）。
  // 已知上限：im/v1/chats、im/v1/messages、OAuth v3 令牌接口都是 1000 次/分 & 50 次/秒，
  // 维度是「每个 API × 每个应用 × 每个租户」；本工具串行拉取、每页间隔 220ms（≈4.5 次/秒），
  // 只有上限的十分之一左右，正常情况下撞不到。
  if (code === 99991400 || code === 230020 || code === 1000005 || code === 90217) {
    return throttle('触发接口频控');
  }
  // 月调用量总额度用尽：这个**重试没有意义**，必须跟限流分开说，否则用户会一直重试。
  if (code === 99991403) {
    return `${base}（这个应用本月的 API 调用总量配额已用完 —— 重试没用，等下月 1 号额度刷新，`
      + '或去开放平台看能不能提额；认证与授权类接口不占这个额度）';
  }
  return base;
}

/**
 * 列用户所在的会话（分页拉全）。
 *
 * 公开文档写明 `/im/v1/chats` **不返回单聊（p2p）**，但官方 CLI 的实现里给同一个接口传了
 * `types=p2p,group` —— 用户身份下能把单聊也列出来（单聊行带 chat_mode=p2p / p2p_target_id）。
 * 这条**没写进公开 REST 文档**，所以不赌它：先带 types 试一次，接口不认就退回不带参数的调用。
 * 万一两种情况都拿不全，界面上还有「手动添加会话 ID」这个兜底入口。
 */
async function listAllChats(token, maxChats = 200) {
  const out = [];
  let pageToken = '';
  let withTypes = true;   // 第一次带上 types；这一轮里只要被拒过一次就整轮退回
  let p2pNote = '';
  for (let i = 0; i < 30; i++) {
    const params = { page_size: 100, page_token: pageToken, user_id_type: 'open_id' };
    let data = null;
    if (withTypes) {
      try {
        data = await feishuGet(token, '/im/v1/chats', { ...params, types: 'p2p,group' });
      } catch (e) {
        withTypes = false;
        p2pNote = `会话列表不带 types=p2p,group（${e.message}），已退回只列群聊`;
      }
    }
    if (!data) data = await feishuGet(token, '/im/v1/chats', params);
    out.push(...(data.items || []));
    if (!data.has_more || !data.page_token || out.length >= maxChats) break;
    pageToken = data.page_token;
    await sleep(220);   // 官方有频控，页与页之间让一让
  }
  return { items: out.slice(0, maxChats), p2pNote, withTypes };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 消息正文 → 一行可读文本（文本/富文本/其它类型的占位说明） */
function msgText(m) {
  const type = m.msg_type || '';
  let body = {};
  try { body = JSON.parse((m.body && m.body.content) || '{}'); } catch { body = {}; }
  if (type === 'text') return String(body.text || '').trim();
  if (type === 'post') {
    // 富文本：title + 每个段落里 tag=text/a 的文本
    const langs = body.content || body;
    const blocks = [];
    if (body.title) blocks.push(String(body.title));
    const walk = (arr) => {
      for (const el of (Array.isArray(arr) ? arr : [])) {
        if (!el) continue;
        if (typeof el.text === 'string') blocks.push(el.text);
        if (Array.isArray(el.content)) walk(el.content);
      }
    };
    if (Array.isArray(langs)) walk(langs);
    else for (const k of Object.keys(langs || {})) walk(langs[k]);
    return blocks.join(' ').replace(/\s+/g, ' ').trim();
  }
  if (type === 'image') return '[图片]';
  if (type === 'file') return `[文件 ${body.file_name || ''}]`;
  if (type === 'audio') return '[语音]';
  if (type === 'media') return `[视频 ${body.file_name || ''}]`;
  if (type === 'sticker') return '[表情]';
  if (type === 'share_chat') return '[分享的群名片]';
  if (type === 'share_user') return '[分享的个人名片]';
  if (type === 'system') return '';
  return `[${type || '未知消息'}]`;
}

function isCountable(m) {
  const type = m.msg_type || '';
  if (type === 'system') return false;
  const t = msgText(m);
  return !!t || type === 'image' || type === 'file' || type === 'audio' || type === 'media' || type === 'sticker';
}

/** 拉一个会话的消息（升序分页，直到时间窗结束或条数上限） */
async function pullMessages(token, chatId, { startSec, endSec, maxMsgs = 2000 }) {
  const out = [];
  let pageToken = '';
  for (let i = 0; i < 60; i++) {
    const data = await feishuGet(token, '/im/v1/messages', {
      container_id_type: 'chat', container_id: chatId,
      start_time: startSec, end_time: endSec,
      sort_type: 'ByCreateTimeAsc', page_size: 50, page_token: pageToken,
    });
    const items = data.items || [];
    out.push(...items);
    if (!data.has_more || !data.page_token || out.length >= maxMsgs) break;
    pageToken = data.page_token;
    await sleep(220);
  }
  return out.slice(0, maxMsgs);
}

// ---------- 落地文件夹（v1.10.14 改版） ----------
/** 确保 parent 下有一个叫 name 的子目录，返回它的 id。幂等靠 note_folders 的 UNIQUE(parent_id,name)。 */
function ensureChildFolder(tdb, parentId, name) {
  tdb.prepare('INSERT OR IGNORE INTO note_folders(name,parent_id) VALUES(?,?)').run(String(name), Number(parentId));
  const row = tdb.prepare('SELECT id FROM note_folders WHERE parent_id=? AND name=?').get(Number(parentId), String(name));
  return row ? Number(row.id) : null;
}

/** 连接器的目录名：备注名 → 企业识别码 → 「连接器 N」。 */
function folderNameFor(conn) {
  return String(conn.label || '').trim() || String(conn.tenant_key || '').trim() || `连接器 ${conn.id}`;
}

/**
 * 一条连接器落在笔记树里的位置：**IM连接 / 飞书 / <备注名>**。
 *
 * v1.10.13 及以前是按**平台**分的（IM连接 / 飞书），于是两家不同企业的飞书（两条连接器）
 * 全落进同一个「飞书」目录混在一起 —— 用户 2026-10-05 报的就是这个。
 * 现在按**连接器**分：一层平台名（分组用），一层连接器自己的目录。
 *
 * 目录**用到才建**（首次同步时才出现），所以没跑通的平台不会在笔记树里留下空目录。
 * 两条连接器重名时后面那条自动加「（2）」，绝不把两家企业的记录合进一个目录
 * —— 备注名是用户自己起的，不能因为重名就悄悄合并。
 */
function connectorFolderId(tdb, conn) {
  const p = PROVIDERS[conn.provider] || {};
  const root = tdb.prepare("SELECT id FROM note_folders WHERE parent_id IS NULL AND name='IM连接'").get();
  if (!root) return null;   // 正常不会发生：ddl 里有种子；真没有就落到「未分类」
  const prov = ensureChildFolder(tdb, Number(root.id), p.folder || '其他');
  if (prov == null) return Number(root.id);
  const base = folderNameFor(conn);
  let name = base;
  for (let n = 2; n <= 99; n++) {
    const row = tdb.prepare('SELECT id FROM note_folders WHERE parent_id=? AND name=?').get(prov, name);
    if (!row) break;                                                   // 这个名字空着，可以用
    if (Number(row.id) === Number(conn.folder_id)) return Number(row.id); // 就是自己那个目录
    name = `${base}（${n}）`;                                           // 被别人占了，换一个后缀再试
  }
  const id = ensureChildFolder(tdb, prov, name);
  return id == null ? prov : id;
}

/** 把这条连接器名下**已经归档的笔记**搬进 folderId。
 *  归属靠 im_chats.note_id 认（数据本来就有），**不靠标题猜、不看时间范围** —— 猜错就会把
 *  别人的笔记搬走（两家飞书的记录混在同一个目录里，光看标题是分不出来的）。
 *  会话记录被删掉的那些（note_id 丢了）原地不动：宁可少搬，不可搬错。 */
function moveConnectorNotes(tdb, conn, folderId) {
  if (folderId == null) return 0;
  const rows = tdb.prepare('SELECT note_id FROM im_chats WHERE connector_id=? AND note_id IS NOT NULL').all(Number(conn.id));
  const upd = tdb.prepare('UPDATE notes SET folder_id=? WHERE id=? AND folder_id IS NOT ?');
  let n = 0;
  for (const r of rows) n += upd.run(Number(folderId), Number(r.note_id), Number(folderId)).changes;
  return n;
}

/** 备注名改了 → 把这条连接器的目录跟着改名（目录 id 不变，所以里面笔记的归属不受影响）。
 *  还没建过目录（folder_id 为空）就什么都不做 —— 首次同步时自然会用新名字建出来。 */
function syncConnectorFolderName(tdb, conn) {
  if (!conn.folder_id) return '';
  const f = tdb.prepare('SELECT * FROM note_folders WHERE id=?').get(Number(conn.folder_id));
  if (!f) return '';
  const want = folderNameFor(conn);
  if (String(f.name) === want) return want;
  const parent = Number(f.parent_id);
  let name = want;
  for (let n = 2; n <= 99; n++) {
    const row = tdb.prepare('SELECT id FROM note_folders WHERE parent_id=? AND name=?').get(parent, name);
    if (!row) break;
    name = `${want}（${n}）`;
  }
  tdb.prepare('UPDATE note_folders SET name=? WHERE id=?').run(name, Number(conn.folder_id));
  return name;
}

// ---------- 归档正文的排版（v1.10.18）----------
// 用户 2026-10-05 的原话：「希望拉取的内容时间按倒序显示，最新的内容在最上面，从上往下按时间线看
// 更老的记录，这样才不用翻到最底下看新内容。」
//
// 正文结构 = **抬头**（我们自己生成的那几行）+ 若干**同步段**。每个同步段的标题长得像
// `## 2026-10-05 20:12 同步（新增 2 条）`，段内每行长得像 `- **20:12｜我**：...`。
// 两种行都带 `YYYY-MM-DD HH:MM` 前缀，而**这个前缀的字典序就是时间序**（定宽、零填充），
// 所以「按时间排」= 直接比字符串，不用解析日期、也不用管时区。
//
// 为什么按时间戳重排、而不是「把数组反过来」：反过来只对一次有效 —— 同一篇笔记被规整两遍
// 就会把顺序又倒回去。按时间戳排是**幂等**的，跑多少遍结果都一样，切换排序方向也只是换个方向排。
//
// 唯一的安全网：重排前后「非空行的多重集」必须一模一样（一行不多、一行不少）。
// 对不上就把原文原样返回 —— 聊天正文里万一有一行恰好长成段标题的样子，最坏也只是这篇不重排。
const SYNC_HEAD_RE = /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) 同步（新增 \d+ 条）$/;
const MSG_LINE_RE = /^- \*\*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})｜/;
const TS_OF = (line) => {
  const m = MSG_LINE_RE.exec(line);
  return m ? m[1] : '';
};
const cmpStr = (a, b) => (a < b ? -1 : (a > b ? 1 : 0));

/** 拆成 { head: 抬头行[], sections: 同步段[][] }（每段含它自己的标题行）。 */
function splitImSections(content) {
  const lines = String(content || '').split('\n');
  const marks = [];
  for (let i = 0; i < lines.length; i++) if (SYNC_HEAD_RE.test(lines[i])) marks.push(i);
  if (!marks.length) return { head: lines, sections: [] };
  const head = lines.slice(0, marks[0]);
  const sections = marks.map((start, k) => lines.slice(start, k + 1 < marks.length ? marks[k + 1] : lines.length));
  return { head, sections };
}

/** 非空行的多重集（去空白、排序）。用来证明重排没丢行、没造行。 */
function lineBag(s) {
  return String(s || '').split('\n').map((x) => x.trim()).filter(Boolean).sort();
}
function sameLineBag(a, b) {
  const x = lineBag(a), y = lineBag(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** 抬头 + 各段拼回正文（段间空一行，末尾补一个换行）。 */
function joinImSections(head, sections) {
  const h = head.join('\n').replace(/\s+$/, '');
  const body = sections.map((s) => s.join('\n').replace(/\s+$/, '')).filter(Boolean).join('\n\n');
  return body ? `${h}\n\n${body}\n` : `${h}\n`;
}

/** 把段列表排成 desc（新在前）/ asc（新在后）。段之间比段标题那行，段内交给 sortSectionLines。 */
function orderedSections(sections, desc) {
  const asc = sections.slice().sort((a, b) => cmpStr(a[0], b[0]));
  return (desc ? asc.slice().reverse() : asc).map((s) => sortSectionLines(s, desc));
}

/** 段内按时间戳排。认不出时间戳的行（理论上是段里我们自己写的说明行）保持原相对次序、沉到最后。 */
function sortSectionLines(sec, desc) {
  const headLine = sec[0];
  const bullets = sec.slice(1).filter((l) => l.trim() !== '');
  const stamped = bullets.filter((l) => MSG_LINE_RE.test(l));
  const other = bullets.filter((l) => !MSG_LINE_RE.test(l));
  stamped.sort((a, b) => cmpStr(TS_OF(a), TS_OF(b)));   // 同分钟靠 Array.sort 的稳定性保持原有先后
  if (desc) stamped.reverse();
  return [headLine, '', ...stamped, ...other];
}

/** 把整篇正文规整成 desc（新在上）/ asc（新在下）。没有同步段就原样返回；自检不过也原样返回。 */
function orderImNoteContent(content, desc) {
  const text = String(content || '');
  const { head, sections } = splitImSections(text);
  if (!sections.length) return text;
  const out = joinImSections(head, orderedSections(sections, desc));
  return sameLineBag(text, out) ? out : text;
}

/**
 * 归档笔记的抬头（唯一定义处）。**同步新写一篇**和**规整老笔记**必须用同一个 ——
 * 否则两边各写一份，改了一处忘了另一处，老笔记的抬头就永远停在旧口径上
 * （v1.10.15 那个「保存侧与读取侧两个正则」的教训是同一类）。
 */
function imHeaderBlock(conn, chat, desc, tag) {
  const p = PROVIDERS[(conn && conn.provider) || ''] || {};
  const t = String(tag || '').trim();
  return [
    `# ${chat.chat_name || chat.chat_id}`,
    '',
    `- 来源：${p.name || conn.provider}${conn.user_name ? '（' + conn.user_name + '）' : ''}`,
    `- 授权企业：${conn.tenant_key || conn.label || '未知'}`,
    `- 会话类型：${chat.chat_mode === 'p2p' ? '单聊' : (chat.chat_mode || '未知')}`,
    `- 会话 ID：\`${chat.chat_id}\``,
    ...(t ? [`- 标签：#${t}`] : []),
    '',
    desc
      ? '> 本笔记由工作台「IM 连接」按官方授权自动归档，**新消息排在最上面**，越往下越早。'
      : '> 本笔记由工作台「IM 连接」按官方授权自动归档，每次同步把新消息追加在下面。',
  ].join('\n');
}

/** 抬头里「我们写的」那几种行：`# 标题`、`- 来源/授权企业/会话类型/会话 ID/标签：`、`> 说明`、空行。
 *  注意 `# 标题` 要求 `#` 后有空格 —— 用户自己插的 `#公司` 这种行内标签**不算我们的**，得原样留着。 */
function isOursHeadLine(line) {
  const s = String(line || '').trim();
  if (s === '') return true;
  return /^#\s/.test(s) || /^-\s*(来源|授权企业|会话类型|会话 ID|标签)：/.test(s) || /^>/.test(s);
}

/**
 * 换掉归档笔记的抬头（同步段原样保留）。
 *
 * 老笔记的抬头是旧版写的：少了 `- 标签：#飞书` 那一行，末行的说明还写着
 * 「每次同步把新消息追加在下面」—— 改成倒序之后这句话就是错的了。
 *
 * 只动**我们自己写的那块抬头**：得先认出它（第一行是 `# 标题`、抬头里有 `- 会话 ID：`），
 * 认不出来（用户把这篇整个重写过）就整篇不碰。段是**原样传进 joinImSections 的**，
 * 所以不存在丢行的可能，不需要再比一次行集合。
 *
 * 抬头里**用户自己加的行**（例如紧跟标题的 `#公司` 行内标签）也原样留着 —— 只换我们那几行，
 * 位置也保留（挨着标题那几行还在挨着标题）。重建抬头时整块丢掉是最容易犯的错：
 * 那行 `#公司` 一丢，笔记的标签就从「行内」掉成「词频自动」，下次改动正文就被整批重算掉了。
 */
function refreshImHeader(content, headerText) {
  const text = String(content || '');
  const want = String(headerText || '').replace(/\s+$/, '');
  const { head, sections } = splitImSections(text);
  const ours = sections.length > 0 && !!want && head.length > 0
    && /^#\s+\S/.test(head[0]) && head.some((l) => /^- 会话 ID：/.test(l));
  if (!ours) return { content: text, changed: false, ours: false };
  const extra = head.filter((l) => l.trim() !== '' && !isOursHeadLine(l));
  const wantLines = want.split('\n');
  const out = joinImSections([wantLines[0], ...extra, ...wantLines.slice(1)], sections);
  return { content: out, changed: out !== text, ours: true };
}

/** 把一个新的同步段并进正文：desc 排在最上面，否则接在最下面。
 *  自检拿「老实追加」（老正文 + 新段）当基准 —— 它是这次操作的**全集**，比对它就等于
 *  「新段进了正文，且老正文一行没动」。对不上就退回老实追加，绝不冒丢正文的险。 */
function mergeImBlock(content, block, desc) {
  const text = String(content || '');
  const sec = String(block || '').trim();
  if (!sec) return text;
  const plainAppend = `${text.replace(/\s+$/, '')}\n\n${sec}\n`;
  try {
    const { head, sections } = splitImSections(text);
    const list = desc ? [sec.split('\n'), ...sections] : [...sections, sec.split('\n')];
    const out = joinImSections(head, list);
    return sameLineBag(out, plainAppend) ? out : plainAppend;
  } catch {
    return plainAppend;
  }
}

/** 归档笔记自动挂的平台标签（#飞书 / #钉钉 / #企业微信）。 */
function platformTagOf(conn) {
  const p = PROVIDERS[(conn && conn.provider) || ''] || {};
  return String(p.tag || p.name || '').trim();
}

/** 这条连接器的正文排版方向：**只有显式存了 'asc' 才正序**，其余（含老库补列后的空值）一律倒序。 */
function noteOrderDesc(conn) {
  return String((conn && conn.note_order) || 'desc') !== 'asc';
}

/**
 * 把平台标签钉在归档笔记上。
 *
 * 走 **manual** 那一档（不是把 `#飞书` 写进正文当行内标签）有两个原因：
 *  ① 正文是用户的聊天记录，不该被我们塞进一行我们的标记；
 *  ② manual 标签在 syncNoteTags 里是「先来的占住」，不会被正文重算冲掉。
 * 关键是**先读回库里已有的 manual 标签再并上平台标签** —— 直接传 [tag] 会把用户
 * 自己在这篇笔记上打的标签全冲掉（syncNoteTags 收到显式数组就等于「手动标签就这些」）。
 */
function applyImTags(tdb, noteId, content, tag) {
  const t = String(tag || '').trim();
  if (!t) return;
  const id = Number(noteId);
  const manual = tdb.prepare("SELECT tag FROM note_tags WHERE note_id=? AND source='manual'").all(id).map((r) => r.tag);
  if (!manual.includes(t)) manual.push(t);
  noteService.syncNoteTags(tdb, id, content, manual);
}

function upsertImNote(tdb, { noteId, folderId, title, block, headerBlock, desc = true, tag = '' }) {
  if (noteId) {
    const cur = tdb.prepare('SELECT * FROM notes WHERE id=?').get(Number(noteId));
    if (cur) {
      let content = mergeImBlock(String(cur.content || ''), block, desc);
      content = orderImNoteContent(content, desc);   // 顺手把老段也规整成同一方向
      // 抬头也顺手刷成当前口径（改方向、补平台标签都会让老抬头过时）。
      // 认不出是我们写的抬头（用户整篇重写过）就一分不碰。
      const rf = refreshImHeader(content, headerBlock);
      if (rf.changed) content = rf.content;
      tdb.prepare(`UPDATE notes SET title=?,content=?,folder_id=?,word_count=?,updated_at=datetime('now','localtime') WHERE id=?`)
        .run(title, content, folderId, noteService.extractWordCount(content), Number(noteId));
      noteService.syncNoteLinks(tdb, Number(noteId), content);
      applyImTags(tdb, Number(noteId), content, tag);
      return Number(noteId);
    }
  }
  const content = orderImNoteContent(`${headerBlock}\n\n${String(block || '').trim()}\n`, desc);
  const id = noteService.createNote(tdb, { title, content, folder_id: folderId });
  applyImTags(tdb, id, content, tag);
  return id;
}

function log(tdb, connectorId, level, message) {
  try {
    tdb.prepare('INSERT INTO im_sync_logs(connector_id,level,message) VALUES(?,?,?)')
      .run(connectorId == null ? null : Number(connectorId), level, String(message).slice(0, 1000));
    // 每个连接器只留最近 200 条，别把租户库撑大
    tdb.prepare('DELETE FROM im_sync_logs WHERE connector_id=? AND id NOT IN (SELECT id FROM im_sync_logs WHERE connector_id=? ORDER BY id DESC LIMIT 200)')
      .run(Number(connectorId), Number(connectorId));
  } catch { /* 记日志失败不能影响主流程 */ }
}

function listLogs(tdb, connectorId, limit = 100) {
  return tdb.prepare('SELECT * FROM im_sync_logs WHERE connector_id=? ORDER BY id DESC LIMIT ?')
    .all(Number(connectorId), Number(limit)).map((r) => ({ ...r, id: Number(r.id) }));
}

function listChats(tdb, connectorId) {
  return tdb.prepare('SELECT * FROM im_chats WHERE connector_id=? ORDER BY chat_mode, chat_name, id')
    .all(Number(connectorId))
    .map((c) => ({ ...c, id: Number(c.id), connector_id: Number(c.connector_id), note_id: c.note_id == null ? null : Number(c.note_id), msg_count: Number(c.msg_count) || 0 }));
}

/** 手动登记一个会话（官方列群接口不含单聊，作为兜底入口） */
function addChat(tdb, connectorId, { chat_id, chat_name = '', chat_mode = '' }) {
  const c = getConnector(tdb, connectorId);
  if (!c) throw bad('连接器不存在', 404);
  const id = String(chat_id || '').trim();
  if (!id) throw bad('会话 ID 不能为空');
  tdb.prepare('INSERT OR IGNORE INTO im_chats(connector_id,chat_id,chat_name,chat_mode) VALUES(?,?,?,?)')
    .run(Number(connectorId), id, String(chat_name || '').trim(), String(chat_mode || '').trim());
  return listChats(tdb, connectorId);
}

function delChat(tdb, id) {
  const r = tdb.prepare('DELETE FROM im_chats WHERE id=?').run(Number(id));
  return r.changes;
}

// ---------- 同步前的估算（需求：同步会话量之前要有个提醒）----------
// 为什么要有这一步：一次同步要按会话逐个翻页拉历史，几十个会话就是上百次接口调用，
// 而飞书对 im/v1/messages 有频控（超限返回 99991400）。这些调用是我们替用户发出去的，
// 用户有权在按下去之前知道「要发多少请求、大概跑多久、被限流会怎样」——而不是点完等在那儿。
//
// 只读：不碰任何数据，纯粹根据已登记的会话与游标算一遍。
const PAGE_SIZE = 50;        // im/v1/messages 的 page_size
const PACE_MS = 220;         // 页与页之间的固定间隔（syncConnector 里 sleep 的就是这个）
const MAX_PAGES_PER_CHAT = 60;
const SYNC_MAX_MSGS_PER_CHAT = 2000;

function syncPreview(tdb, connectorId, { sinceDays = 30 } = {}) {
  const conn = getConnector(tdb, connectorId);
  if (!conn) throw bad('连接器不存在', 404);
  const days = Number.isFinite(Number(sinceDays)) && Number(sinceDays) > 0 ? Math.min(Number(sinceDays), 3650) : 30;
  // 钉钉的估算单独一支：会话列表一页 100 条、消息页间隔 200ms（dws --page-delay，跟实跑参数一致），
  // 单聊走官方搜索通道、群聊走 +chat-messages，请求数口径与飞书版相同（列表 + 每会话至少一次）。
  if (conn.provider === 'dingtalk') {
    const chats = listChats(tdb, conn.id);
    const incremental = chats.filter((c) => c.last_msg_time).length;
    const initial = chats.length - incremental;
    const listReq = Math.max(1, Math.ceil(chats.length / 100));
    const reqMin = listReq + chats.length;
    const reqMax = listReq + incremental + initial * 60;
    const sec = (n) => Math.round((n * 200) / 1000);
    return {
      provider: conn.provider,
      authorized: conn.status === 'authorized',
      since_days: days,
      chats: chats.length,
      incremental, initial,
      max_msgs_per_chat: SYNC_MAX_MSGS_PER_CHAT,
      pace_ms: 200,
      est_requests_min: reqMin,
      est_requests_max: reqMax,
      est_seconds_min: sec(reqMin),
      est_seconds_max: sec(reqMax),
      resume: '同步进度按会话逐个记录。中途被限流或中断不会丢数据 —— 已经拉完的会话下次会跳过，没跑完的从上次的位置继续。',
      already_synced: chats.filter((c) => c.last_sync_at).length,
    };
  }
  // 企业微信单独一支：页间隔 150ms（wecomCli 翻页 sleep，跟实跑一致）；since_days 上限 7
  //（官方只让拉最近 7 天，填更多也只会被裁掉 —— 预检里就说破，别让用户以为能补老历史）。
  if (conn.provider === 'wecom') {
    const chats = listChats(tdb, conn.id);
    const incremental = chats.filter((c) => c.last_msg_time).length;
    const initial = chats.length - incremental;
    const reqMin = 1 + chats.length;
    const reqMax = 1 + incremental + initial * 60;
    const sec = (n) => Math.round((n * 150) / 1000);
    return {
      provider: conn.provider,
      authorized: conn.status === 'authorized',
      since_days: Math.min(days, 7),
      chats: chats.length,
      incremental, initial,
      max_msgs_per_chat: SYNC_MAX_MSGS_PER_CHAT,
      pace_ms: 150,
      est_requests_min: reqMin,
      est_requests_max: reqMax,
      est_seconds_min: sec(reqMin),
      est_seconds_max: sec(reqMax),
      resume: '同步进度按会话逐个记录。企业微信官方只允许拉最近 7 天的消息（老历史补不了）；群聊自动发现，单聊要用「添加单聊」按联系人登记。',
      already_synced: chats.filter((c) => c.last_sync_at).length,
    };
  }
  const chats = listChats(tdb, conn.id);
  // 有游标 = 只取比游标新的消息（正常一次请求就完事）；没游标 = 首次同步，要拉最近 days 天的历史
  const incremental = chats.filter((c) => c.last_msg_time).length;
  const initial = chats.length - incremental;
  const listReq = Math.max(1, Math.ceil(chats.length / 100));   // 会话列表本身也要翻页（page_size=100）
  // 下限：列表 + 每个会话至少一次消息请求。上限：首次同步的会话按最坏情况翻满（每次 50 条）。
  const reqMin = listReq + chats.length;
  const reqMax = listReq + incremental + initial * MAX_PAGES_PER_CHAT;
  const sec = (n) => Math.round((n * PACE_MS) / 1000);
  return {
    provider: conn.provider,
    authorized: !!conn.authorized,
    since_days: days,
    chats: chats.length,
    incremental, initial,
    max_msgs_per_chat: SYNC_MAX_MSGS_PER_CHAT,
    pace_ms: PACE_MS,
    est_requests_min: reqMin,
    est_requests_max: reqMax,
    est_seconds_min: sec(reqMin),
    est_seconds_max: sec(reqMax),
    // 这条是给用户吃定心丸的：游标是**每个会话各自**记的，中途被限流只影响没跑完的那几个，
    // 下次同步会从各自的位置接着拉，不会从头再来、也不会重复落库。
    resume: '同步进度按会话逐个记录。中途被限流或中断不会丢数据 —— 已经拉完的会话下次会跳过，没跑完的从上次的位置继续。',
    already_synced: chats.filter((c) => c.last_sync_at).length,
  };
}

// ---------- 定时同步（v1.10.14，需求③） ----------
// 时区：**写死 UTC+8**。用户设的「每天 08:00」说的是国内时间，而服务器时区不一定是东八区
// （容器里常常就是 UTC）——如果按服务器本地时间算，用户设 08:00、实际半夜跑。
// 中国没有夏令时，固定偏移就是准的，也不需要在 Windows 上折腾 IANA 时区数据。
// 两个字符串（时点与「上次自动跑」）都用这个口径生成，比较永远自洽，与服务器时区无关。
const CST_OFFSET_MS = 8 * 3600 * 1000;
const two = (n) => String(n).padStart(2, '0');
/** 把 epoch 毫秒写成「北京时间的 'YYYY-MM-DD HH:MM:SS'」。 */
function cstStamp(ms) {
  const d = new Date(Number(ms) + CST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} `
    + `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
}

/**
 * 这条连接器**最近一次该跑的时刻**（北京时间字符串）；没开定时、或时刻填得不成样子时返回 ''。
 *
 * 为什么算「最近一个时点」而不是「此刻正好等于时点」：
 *   ① 调度是每分钟巡检一次，判「过点没到点」比判「正好是那一分钟」稳得多（时钟误差、任务拥挤都不怕）；
 *   ② 服务器在那会儿正好没开着（升级、重启、断电）→ 起来之后仍然判定为「已过点、还没跑」，自动补跑。
 * 代价是最多多补跑一次：停机三天也只在起来后跑一次，不会连补三天（这是想要的行为）。
 */
function autoSyncSlot(conn, now = Date.now()) {
  if (!Number(conn.auto_sync)) return '';
  // 严格判：**不做夹取**。写成「23:59 夹一下」看着更宽容，实际是把一个填错的时刻悄悄
  // 变成另一个时刻（25:99 → 23:59），用户以为设的是那个点、其实半夜在跑。宁可返回空 = 不跑。
  // （updateConnector 用同一条规则拦输入，这里是防老数据/手改库。）
  const m = String(conn.auto_time || '').match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!m) return '';
  const hh = Number(m[1]), mi = Number(m[2]);
  const cstNow = Number(now) + CST_OFFSET_MS;                       // 用 getUTC* 读出来就是北京时间
  const d = new Date(cstNow);
  let slot = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh, mi, 0, 0);
  if (String(conn.auto_freq || 'daily') === 'weekly') {
    const want = Math.min(7, Math.max(1, Number(conn.auto_weekday) || 1)); // 1=周一 … 7=周日
    const today = d.getUTCDay() || 7;                                     // getUTCDay(): 0=周日 → 记成 7
    let back = (today - want + 7) % 7;
    if (back === 0 && cstNow < slot) back = 7;                            // 本周那次还没到 → 算上周那天
    slot -= back * 86400000;
  } else if (cstNow < slot) {
    slot -= 86400000;                                                     // 今天还没到点 → 算昨天
  }
  // 只做过整天的加减、全程用 UTC 字段读，所以这个「伪 UTC」表示是精确的
  const s = new Date(slot);
  return `${s.getUTCFullYear()}-${two(s.getUTCMonth() + 1)}-${two(s.getUTCDate())} `
    + `${two(s.getUTCHours())}:${two(s.getUTCMinutes())}:00`;
}

/** 到点没有：最近一个时点已经过去，而上次自动跑还在它之前（auto_last_at 为空 = 从没跑过 → 立刻到点）。
 *  两边都是北京时间 'YYYY-MM-DD HH:MM:SS'，直接比字符串。 */
function autoSyncDue(conn, now = Date.now()) {
  const slot = autoSyncSlot(conn, now);
  if (!slot) return false;
  return String(conn.auto_last_at || '') < slot;
}

// 周几的中文名（界面上直接显示，1=周一 … 7=周日）
const WEEKDAY_CN = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日'];

// ---------- 同步互斥（v1.10.14） ----------
// 定时任务和手动点「同步」如果撞在一起，两边会拉到同一批消息、各自追加一遍
//（每个会话的游标是拉完之后才写的，中间那段窗口两边都以为对方还没拉过）。
// 一把进程内的锁把同一条连接器的同步串起来：后来者直接被告知「正在同步」，不排队。
// 单进程部署下这就够了；哪天真多实例部署，也只会退化成「偶尔重复一段」，不会丢数据。
const syncLocks = new Set();
function lockSync(id) { const k = Number(id); if (syncLocks.has(k)) return false; syncLocks.add(k); return true; }
function unlockSync(id) { syncLocks.delete(Number(id)); }

// ---------- 同步 ----------
/**
 * IM 归档笔记的标题 = **对方名称-日期时间-连接器备注名**（2026-10-06 用户定的新规则）。
 *  · 对方名称：单聊是对方的显示名、群聊是群名（都来自会话列表的 name 字段）；列表没给名字时
 *    退回会话 ID —— 绝不能因为少一个字段就拼出 `-2026-10-05 11:53-` 这种半截标题。
 *  · 日期时间：该会话本轮**最后一条消息**的时间（一条都没有时取当前时间），精确到分钟。
 *  · 备注名：连接器 label（「IM 连接」里用户自己起的名）；空则退回授权企业识别码，再空退回
 *    会话 ID。会话的稳定身份（chat_id）仍在笔记正文抬头的「- 会话 ID：」一行里，一个不少。
 *    （历史上第三段放过「授权企业识别码」「会话 ID」，这次按用户口径统一成备注名。）
 */
function chatTitle(conn, chat, lastMs) {
  const id = String(chat.chat_id || '').trim();
  const who = String(chat.chat_name || '').trim() || id || '未知会话';
  const tag = String((conn && conn.label) || '').trim() || String((conn && conn.tenant_key) || '').trim() || id || '未命名连接器';
  return `${who}-${fmtTime(lastMs) || fmtTime(nowMs())}-${tag}`;
}

/**
 * 同步一条连接器：列会话 → 逐个会话拉新消息 → 追加到「一会话一篇」的笔记里。
 * 增量靠 im_chats.last_msg_time（毫秒），重复点同步不会重复落库。
 *
 * **为什么要分轮（budgetMs / round）**：生产站 cc.in1912.cc 前面是 Cloudflare，
 * 它对回源请求有约 100 秒的读超时；一旦超时，Cloudflare 会掐掉连接并回一张自己的 HTML 错误页
 *（前端看到的是「HTTP 502，非 JSON：<!DOCTYPE html>…」）。而首次同步几十上百个会话，
 * 按每页 220ms 算很容易跑过 100 秒 —— 于是整次同步白做，用户只看到一张错误页。
 * 现在的做法：一次 HTTP 请求只干 budgetMs 毫秒的活（默认 45 秒，留足余量），干不完就带着
 * 「还剩多少」正常返回，由前端接着发下一次请求，直到 done=true。**进度不用额外存**：
 * 每个会话的 last_msg_time 游标本来就在库里，再加一个 round 标记本轮已经处理过谁，
 * 所以中途被掐也不会重复拉、不会漏。
 */
/** 分轮同步的核心规则：这一轮该处理哪些会话。
 *  本轮开始之后被处理过的（last_sync_at >= round）一律跳过 —— 否则每续跑一轮，
 *  都要把已经拉完的会话再向飞书问一遍，几十个会话能把时间预算全耗在重复询问上。
 *  两条时间戳都出自 SQLite 的 datetime('now','localtime')、同为 'YYYY-MM-DD HH:MM:SS'，
 *  所以直接做字符串比较既正确又不用碰时区。
 *  抽成纯函数是为了能直接测这条规则 —— 它是分轮同步里唯一容易写错的地方，而真跑一次同步要真令牌。 */
function chatsForRound(chats, rnd) {
  return chats.filter((c) => !(c.last_sync_at && String(c.last_sync_at) >= rnd));
}

async function syncConnector(tdb, connectorId, { sinceDays = 30, maxChats = 200, maxMsgsPerChat = 2000, budgetMs = 45000, round = '' } = {}) {
  const conn = getConnector(tdb, connectorId);
  if (!conn) throw bad('连接器不存在', 404);
  if (conn.provider !== 'feishu' && conn.provider !== 'dingtalk' && conn.provider !== 'wecom') throw bad('这个平台还没实现同步');
  const isDing = conn.provider === 'dingtalk';
  const isWecom = conn.provider === 'wecom';
  const t0 = Date.now();
  // 钉钉/企业微信不在这里换令牌：CLI 自己管刷新（令牌在它的加密目录里）。同步前先做一次只读登录态检查。
  const token = (isDing || isWecom) ? null : await ensureToken(tdb, conn);
  // 续跑（前端把上一轮返回的 round 带回来）时，这一轮就是同一个 round。
  // **这个时间戳一律由 SQLite 生成**，不自己用 JS 拼：它要跟 last_sync_at（同一列、
  // 同样是 datetime('now','localtime') 写的）做字符串比较，两边出自同一个时钟才不会有
  // 「Node 的时区跟 SQLite 的不一致 → 全部会话都被判成本轮已处理 → 同步 0 条」这种坑。
  const firstRound = !round;
  const rnd = round || tdb.prepare("SELECT datetime('now','localtime') AS r").get().r;

  const stat = { chats: 0, messages: 0, notes: 0, skipped: 0, errors: [], round: rnd, done: true, remaining: 0, total: 0 };
  // 1) 会话列表（先把接口能被调通这件事记下来，出错时日志里能一眼看出卡在哪一步）
  //    只在第一轮拉：续跑的轮次直接接上，省掉重复的列表翻页，也让续跑更快。
  if (firstRound) {
    let remote = [];
    try {
      if (isDing) {
        // 先花一次只读检查确认登录态（令牌刷新 CLI 自己做）；失效就把状态写回界面再抛，
        // 别让用户看着一排会话「同步失败：CLI 执行失败」猜原因。
        const st = await dws.dwsAuthStatus(conn.id);
        if (!st.authenticated) {
          tdb.prepare("UPDATE im_connectors SET status='expired' WHERE id=?").run(conn.id);
          // 捎上最近一次登录失败的真原因（如果有过）：比如「组织没开 CLI 数据访问权限」——
          // 那种情况重新扫码也过不了，得先去钉钉后台开开关。只说「登录已失效」会把人困在
          // 「明明授权成功了却一直报失效」里（2026-10-06 生产就这么卡过一轮）。
          const why = dws.dwsLastLoginError(conn.id);
          throw bad('钉钉登录已失效，请到「IM 连接」里重新扫码登录' + (why ? `：${why}` : ''));
        }
      } else if (isWecom) {
        // 同款预检：凭证失效（853004 一族）趁列表阶段就把状态写回、给出去向，
        // 而不是让每个会话都失败一遍。
        const st = await wecom.wecomAuthStatus(conn.id);
        if (!st.authenticated) {
          tdb.prepare("UPDATE im_connectors SET status='expired' WHERE id=?").run(conn.id);
          throw bad('企业微信授权已失效，请到「IM 连接」里重新点「验证授权」');
        }
      }
      const got = isDing
        ? await dws.dwsListChatsFor(conn.id, maxChats)
        : isWecom
          ? await wecom.wecomListChatsFor(conn.id, maxChats)
          : await listAllChats(token, maxChats);
      remote = got.items;
      if (got.p2pNote) log(tdb, conn.id, 'warn', got.p2pNote);
      const p2p = remote.filter((c) => String(c.chat_mode || '') === 'p2p').length;
      log(tdb, conn.id, 'info', `会话列表：${(PROVIDERS[conn.provider] || {}).name || conn.provider}返回 ${remote.length} 个会话（其中单聊 ${p2p} 个）`);
    } catch (e) {
      log(tdb, conn.id, 'error', '拉会话列表失败：' + (e.message || e));
      tdb.prepare('UPDATE im_connectors SET last_error=?,last_sync_at=datetime(\'now\',\'localtime\') WHERE id=?')
        .run(String(e.message || e).slice(0, 300), conn.id);
      throw e;
    }
    // 远端会话登记（已存在的保留游标不覆盖）
    for (const c of remote) {
      if (!c || !c.chat_id) continue;
      tdb.prepare('INSERT OR IGNORE INTO im_chats(connector_id,chat_id,chat_name,chat_mode) VALUES(?,?,?,?)')
        .run(conn.id, String(c.chat_id), String(c.name || ''), String(c.chat_mode || ''));
      tdb.prepare('UPDATE im_chats SET chat_name=? WHERE connector_id=? AND chat_id=? AND (chat_name IS NULL OR chat_name=\'\')')
        .run(String(c.name || ''), conn.id, String(c.chat_id));
    }
  }

  // 本轮要处理的会话：本轮开始时已经同步过的那些（last_sync_at >= round）跳过 —— 这是「分轮」
  // 真正省时间的地方，否则每续跑一轮都要把已经拉完的会话再问一遍飞书。
  // 注意 last_sync_at 与 round 同为 'YYYY-MM-DD HH:MM:SS'，直接字符串比较。
  const all = listChats(tdb, conn.id);
  const chats = chatsForRound(all, rnd);
  stat.total = all.length;
  stat.remaining = chats.length;
  const endSec = Math.floor(nowMs() / 1000);
  const folderId = connectorFolderId(tdb, conn);
  if (conn.folder_id != null && Number(conn.folder_id) !== Number(folderId)) {
    // 目录变了（比如这一版把「按平台分」改成「按连接器分」）→ 老笔记要跟着搬，
    // 否则它们在树里还挂在旧目录，用户看到的就是「两家飞书还是混在一起」。
    moveConnectorNotes(tdb, conn, folderId);
  }
  if (Number(conn.folder_id || 0) !== Number(folderId)) tdb.prepare('UPDATE im_connectors SET folder_id=? WHERE id=?').run(folderId, conn.id);

  for (let i = 0; i < chats.length; i++) {
    const chat = chats[i];
    // 时间预算到了、而且后面还有没处理的会话 → 收工，把剩下的留给下一次请求。
    if (Date.now() - t0 > budgetMs) { stat.done = false; break; }
    stat.remaining = chats.length - i;
    stat.chats++;
    try {
      const since = chat.last_msg_time
        ? Math.floor((Number(chat.last_msg_time) + 1) / 1000)
        : Math.floor((nowMs() - Math.max(1, sinceDays) * 86400000) / 1000);
      const items = isDing
        ? await dws.dwsPullMessages(conn.id, chat, { startSec: since, endSec, maxMsgs: maxMsgsPerChat })
        : isWecom
          ? await wecom.wecomPullMessages(conn.id, chat, { startMs: since * 1000, endMs: endSec * 1000, maxMsgs: maxMsgsPerChat })
          : await pullMessages(token, chat.chat_id, { startSec: since, endSec, maxMsgs: maxMsgsPerChat });
      const fresh = items.filter((m) => isCountable(m) && Number(m.create_time) > Number(chat.last_msg_time || 0));
      if (!fresh.length) {
        stat.skipped++;
        tdb.prepare("UPDATE im_chats SET last_sync_at=datetime('now','localtime'),last_error='' WHERE id=?").run(chat.id);
        continue;
      }
      const lastMs = Number(fresh[fresh.length - 1].create_time);
      const lines = fresh.map((m) => {
        // 钉钉/企业微信的消息带发送者姓名（群里有名字比「群成员_xx9f27」可读得多）；飞书没有，维持短 ID。
        const who = (conn.user_open_id && m.sender && m.sender.id === conn.user_open_id)
          ? '我'
          : (chat.chat_mode === 'p2p'
            ? '对方'
            : ((isDing || isWecom) && m.sender && m.sender.name ? String(m.sender.name) : '群成员_' + shortId(m.sender && m.sender.id)));
        return `- **${fmtTime(m.create_time)}｜${who}**：${msgText(m)}`;
      }).join('\n');
      const block = `## ${fmtTime(lastMs)} 同步（新增 ${fresh.length} 条）\n\n${lines}`;
      // 段内先按时间正序拼（拉回来本来就是正序），落库方向交给 orderImNoteContent 按每行自带的时间戳
      // 统一排 —— 段内和段外共用同一套规则，不会一处倒一处不倒。
      const desc = noteOrderDesc(conn);
      const tag = platformTagOf(conn);
      const header = imHeaderBlock(conn, chat, desc, tag);

      const noteId = upsertImNote(tdb, {
        noteId: chat.note_id ? Number(chat.note_id) : null,
        folderId, title: chatTitle(conn, chat, lastMs), block, headerBlock: header,
        desc, tag,
      });
      if (chat.note_id == null) stat.notes++;
      tdb.prepare(`UPDATE im_chats SET note_id=?,last_msg_time=?,msg_count=msg_count+?,last_sync_at=datetime('now','localtime'),last_error='' WHERE id=?`)
        .run(noteId, String(lastMs), fresh.length, chat.id);
      stat.messages += fresh.length;
    } catch (e) {
      const msg = String(e.message || e).slice(0, 300);
      stat.errors.push(`${chat.chat_name || chat.chat_id}：${msg}`);
      tdb.prepare("UPDATE im_chats SET last_error=?,last_sync_at=datetime('now','localtime') WHERE id=?").run(msg, chat.id);
      log(tdb, conn.id, 'error', `会话「${chat.chat_name || chat.chat_id}」同步失败：${msg}`);
    }
  }
  if (stat.done) stat.remaining = 0;
  // 分轮时**只有真跑完才清 last_error**：中途那几轮如果顺手清掉，
  // 上一轮失败的原因会在界面上一闪而过地消失，用户看不到到底哪儿坏了。
  if (stat.done) {
    tdb.prepare("UPDATE im_connectors SET last_sync_at=datetime('now','localtime'),last_error=? WHERE id=?")
      .run(stat.errors.length ? `${stat.errors.length} 个会话失败：${stat.errors[0]}`.slice(0, 300) : '', conn.id);
    log(tdb, conn.id, stat.errors.length ? 'warn' : 'info',
      `同步完成：${stat.chats} 个会话，新增 ${stat.messages} 条消息${stat.notes ? `，新建 ${stat.notes} 篇笔记` : ''}${stat.errors.length ? `，${stat.errors.length} 个失败` : ''}`);
  } else {
    tdb.prepare("UPDATE im_connectors SET last_sync_at=datetime('now','localtime') WHERE id=?").run(conn.id);
    log(tdb, conn.id, 'info', `同步进行中：本轮处理 ${stat.chats} 个会话，还剩 ${stat.remaining} 个（分批是为了避开网关的超时上限，会自动接着跑）`);
  }
  return stat;
}

/**
 * 一次性数据迁移（v1.10.14，**幂等**，服务启动时逐租户跑一遍）。
 *
 * 做两件事：
 *  ① 按连接器建好 `IM连接/<平台>/<备注名>` 目录，并把该连接器名下已归档的笔记搬进去
 *     —— 上一版按平台分，两家飞书的记录全堆在「飞书」里，这就是用户 2026-10-05 报的 bug；
 *  ② 删掉「没跑通就不该存在」的空目录（钉钉 / 企业微信 / 其他）—— 它们是 v1.10.5 的种子，
 *     现在改成「用到才建」，所以老库里这几行得清掉（ddl 里的种子也一并删了，否则重启又回来）。
 *     只删**真的空**的（没笔记、没子目录）：用户要是自己往里放过东西，原样留着。
 *
 * 为什么放在这里而不是 db.js：imService `require('../db')`，在 db.js 初始化途中被 require 会
 * 拿到半成品的 exports（循环依赖），所以只能在库加载完之后调（现在由 index.js 在启动钩子里调）。
 */
function migrateImFolders(tdb) {
  let moved = 0, removed = 0;
  for (const conn of tdb.prepare('SELECT * FROM im_connectors ORDER BY id').all()) {
    const fid = connectorFolderId(tdb, conn);
    if (fid == null) continue;
    moved += moveConnectorNotes(tdb, conn, fid);
    if (Number(conn.folder_id || 0) !== Number(fid)) {
      tdb.prepare('UPDATE im_connectors SET folder_id=? WHERE id=?').run(fid, Number(conn.id));
    }
  }
  const root = tdb.prepare("SELECT id FROM note_folders WHERE parent_id IS NULL AND name='IM连接'").get();
  if (root) {
    // 显式名单，不是「删掉所有空目录」：后者在新库上会把「飞书」也删掉（那一刻它还没子目录），
    // 下次同步又建回来，白白闪一下。
    const del = tdb.prepare('DELETE FROM note_folders WHERE id=?');
    const hasNote = tdb.prepare('SELECT 1 FROM notes WHERE folder_id=? LIMIT 1');
    const hasChild = tdb.prepare('SELECT 1 FROM note_folders WHERE parent_id=? LIMIT 1');
    for (const name of ['钉钉', '企业微信', '其他']) {
      const f = tdb.prepare('SELECT id FROM note_folders WHERE parent_id=? AND name=?').get(Number(root.id), name);
      if (!f) continue;
      if (hasNote.get(Number(f.id)) || hasChild.get(Number(f.id))) continue;  // 有东西就绝不删
      removed += del.run(Number(f.id)).changes;
    }
  }
  return { moved, removed };
}

/**
 * 一次性规整（v1.10.18，**幂等**）：服务启动时逐租户跑一遍；某条连接器改了排版方向时也会单独调它。
 *
 *  ① 给已归档的笔记补上平台标签（#飞书 / #钉钉 / #企业微信）—— 老笔记建于这一版之前，标签要补；
 *  ② 按每条连接器的 note_order 把正文排成倒序（老笔记是「新消息追加在下面」，用户要反过来）；
 *  ③ 把抬头换成 `imHeaderBlock` 现在写的那份 —— 老抬头少了 `- 标签：#飞书`，末行的说明
 *     还写着「每次同步把新消息追加在下面」，倒序之后这句话就是错的。
 *
 * 归属只认 `im_chats.note_id`（库里本来就有的权威关系），**不按目录扫** —— 连接器目录里可能有
 * 用户自己建的笔记，那不是该动的东西。规整**不碰 updated_at**：否则每重启一次，所有 IM 笔记
 * 都会一起涌到文件夹最前面，把「最近改过」这个信号毁掉。
 */
function normalizeImNotes(tdb, onlyConnectorId = null) {
  let tagged = 0, reordered = 0, headered = 0;
  const conns = onlyConnectorId == null
    ? tdb.prepare('SELECT * FROM im_connectors ORDER BY id').all()
    : tdb.prepare('SELECT * FROM im_connectors WHERE id=?').all(Number(onlyConnectorId));
  const upd = tdb.prepare('UPDATE notes SET content=?,word_count=? WHERE id=?');
  // 认的是**手动**那一档：老笔记里可能早就因为词频被「自动标签」加过一个 `飞书`，
  // 但自动标签是随正文重算的（用户一旦打上任何手动/行内标签就会被整批换掉）。
  // 所以这里要把它**升级成手动标签**，这样平台标签才经得起之后的正文改动 ——
  // 升级过一次之后再跑就查到 manual 了，仍然是幂等的。
  const hasTag = tdb.prepare("SELECT 1 FROM note_tags WHERE note_id=? AND tag=? AND source='manual'");
  for (const conn of conns) {
    const desc = noteOrderDesc(conn);
    const tag = platformTagOf(conn);
    const rows = tdb.prepare('SELECT id,note_id,chat_id,chat_name,chat_mode FROM im_chats WHERE connector_id=? AND note_id IS NOT NULL').all(Number(conn.id));
    for (const r of rows) {
      const n = tdb.prepare('SELECT id,content FROM notes WHERE id=?').get(Number(r.note_id));
      if (!n) continue;
      const before = String(n.content || '');
      let after = orderImNoteContent(before, desc);
      if (after !== before) reordered++;
      const rf = refreshImHeader(after, imHeaderBlock(conn, r, desc, tag));
      if (rf.changed) { after = rf.content; headered++; }
      if (after !== before) upd.run(after, noteService.extractWordCount(after), Number(n.id));
      if (tag && !hasTag.get(Number(n.id), tag)) { applyImTags(tdb, Number(n.id), after, tag); tagged++; }
    }
  }
  return { tagged, reordered, headered };
}

module.exports = {
  PROVIDERS, FEISHU_SCOPES, WEEKDAY_CN,
  listConnectors, createConnector, updateConnector, deleteConnector, revokeConnector,
  authorizeUrl, handleCallback, ensureToken,
  dingtalkLoginStart, dingtalkLoginProgress, dingtalkLoginCancel,
  wecomVerify, wecomSearchContacts,
  listChats, addChat, delChat, listLogs, syncConnector, syncPreview, chatsForRound,
  publicConnector, chatTitle,
  connectorFolderId, folderNameFor, migrateImFolders, moveConnectorNotes, normalizeImNotes,
  platformTagOf, noteOrderDesc, splitImSections, orderImNoteContent, mergeImBlock, sameLineBag,
  imHeaderBlock, refreshImHeader,
  autoSyncSlot, autoSyncDue, cstStamp, lockSync, unlockSync,
};
