// 钉钉自建应用推送：双通道。应用凭证（dingtalk_app）归主库、管理员配一次全员共享；个人绑定（dingtalk_push）归各租户库。token 缓存按 AppKey 区分。
//  - robot（默认，免费）：企业机器人单聊 /v1.0/robot/oToMessages/batchSend，消息出现在
//    与应用机器人的单聊会话里；需在开放平台给应用添加「机器人」能力（robotCode 默认同 AppKey）
//  - smartbot（官方「使用服务助手推送消息」）：/topapi/smartbot/msg/push，
//    前置条件为企业开通「员工服务台旗舰版」（付费）
// 消息中心每条新消息在接收人绑定并启用时异步转发（notifyUser），失败不影响站内消息。
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const zlib = require('zlib');
const { db, getSetting, setSetting, getTenantDb } = require('../db');

const tokenCaches = new Map();

// 应用级凭证（AppKey/AppSecret/通道/robotCode/AgentId）只存主库 dingtalk_app 一份，管理员配置一次、全员共享；
// 各人只在各自租户库 dingtalk_push 里存「绑定信息」（userid / enabled / bind_base / bound_*）。发送逻辑取 getConfig(d) 的合并视图。
function getAppConfig() {
  const c = getSetting(db, 'dingtalk_app', null) || {};
  return {
    app_key: c.app_key || '',
    app_secret: c.app_secret || '',
    mode: c.mode === 'smartbot' ? 'smartbot' : 'robot',
    robot_code: c.robot_code || '',
    agent_id: c.agent_id || '',
    owner_uid: Number(c.owner_uid) || 0,
  };
}
function saveAppConfig(cfg) {
  const cur = getAppConfig();
  setSetting(db, 'dingtalk_app', {
    app_key: (cfg && 'app_key' in cfg) ? String(cfg.app_key || '').trim() : cur.app_key,
    app_secret: (cfg && cfg.app_secret && cfg.app_secret !== '******') ? String(cfg.app_secret).trim() : cur.app_secret,
    mode: (cfg && cfg.mode) ? (cfg.mode === 'smartbot' ? 'smartbot' : 'robot') : cur.mode,
    robot_code: (cfg && 'robot_code' in cfg) ? String(cfg.robot_code || '').trim() : cur.robot_code,
    agent_id: (cfg && 'agent_id' in cfg) ? String(cfg.agent_id || '').trim() : cur.agent_id,
    owner_uid: (cfg && cfg.owner_uid) ? Number(cfg.owner_uid) : cur.owner_uid,
  });
}

// 一次性迁移：老版把应用凭证存在各租户 dingtalk_push 里；共享版改存主库 dingtalk_app。
// 启动时把「管理员租户」已配好的应用凭证提升到全局（只做一次，之后一律以全局为准）
function migrateAppConfig() {
  if (getAppConfig().app_key) return;
  const admins = db.prepare("SELECT id FROM users WHERE role='admin' AND is_bot=0 ORDER BY id").all();
  const cands = admins.length ? admins : db.prepare('SELECT id FROM users WHERE is_bot=0 ORDER BY id').all();
  for (const a of cands) {
    try {
      const c = getSetting(getTenantDb(a.id), 'dingtalk_push', null) || {};
      if (c.app_key && c.app_secret) {
        saveAppConfig({ app_key: c.app_key, app_secret: c.app_secret, mode: c.mode, robot_code: c.robot_code, agent_id: c.agent_id, owner_uid: a.id });
        console.log(`[dingtalk] 已将用户 #${a.id} 的应用凭证提升为全局共享配置`);
        return;
      }
    } catch { /* 租户库缺失等跳过 */ }
  }
}

// 个人绑定（各租户库 dingtalk_push：只存自己的 userid / 开关 / 回调地址，应用凭证走全局）
function saveBinding(d, cfg) {
  const cur = getSetting(d, 'dingtalk_push', null) || {};
  setSetting(d, 'dingtalk_push', {
    ...cur,
    userid: (cfg && 'userid' in cfg) ? String(cfg.userid || '').trim() : cur.userid,
    enabled: (cfg && 'enabled' in cfg) ? !!cfg.enabled : !!cur.enabled,
    bind_base: (cfg && 'bind_base' in cfg) ? String(cfg.bind_base || '').trim() : (cur.bind_base || ''),
  });
}

// 合并视图：应用级凭证（全局 dingtalk_app）+ 个人绑定（租户 dingtalk_push），供所有发送/接收逻辑统一取用
function getConfig(d) {
  const app = getAppConfig();
  const bind = getSetting(d, 'dingtalk_push', null) || {};
  return {
    app_key: app.app_key,
    app_secret: app.app_secret,
    mode: app.mode,
    robot_code: app.robot_code,
    agent_id: app.agent_id,
    userid: bind.userid || '',
    enabled: !!bind.enabled,
    bind_base: bind.bind_base || '',
    bound_nick: bind.bound_nick || '',
    bound_at: bind.bound_at || '',
    owner_uid: app.owner_uid,
  };
}

// 企业内部应用 accessToken（新旧版接口通用）：POST /v1.0/oauth2/accessToken
// 按 (appKey, appSecret) 泛化：推送（租户配置）与免登（全局配置）共用一套缓存
async function getTokenFor(appKey, appSecret) {
  if (!appKey || !appSecret) throw new Error('钉钉应用 AppKey / AppSecret 未配置');
  const now = Date.now();
  const cached = tokenCaches.get(appKey);
  if (cached && cached.token && cached.expire > now + 60000) return cached.token;
  const r = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey, appSecret }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.accessToken) throw new Error('钉钉 token 获取失败: ' + (j.message || 'HTTP ' + r.status));
  tokenCaches.set(appKey, { token: j.accessToken, expire: now + (j.expireIn || 7200) * 1000 });
  if (tokenCaches.size > 30) tokenCaches.delete(tokenCaches.keys().next().value); // 上限保护
  return j.accessToken;
}
async function getToken(d) {
  const cfg = getConfig(d);
  return getTokenFor(cfg.app_key, cfg.app_secret);
}
// 权限类 403 时清缓存：token 签发时刻的权限集是定格的，后台刚开通的权限旧 token 不带——
// 清掉后下次调用自动换新 token（否则要等 2 小时缓存自然过期，用户会以为开通没生效）
function dropTokenFor(appKey) {
  if (!appKey) return;
  tokenCaches.delete(appKey);
  oldTokenCaches.delete(appKey);
}

// 老版网关专用 token（oapi.dingtalk.com：media/upload、topapi/*、smartbot）：
// 必须用 gettoken 换取，与上面 v1.0/oauth2/accessToken 的新版 token【不通用】——
// 曾用新版 token 调 media/upload 导致图片上传必败（被 catch 吞掉，钉钉只收到 [图片N] 文字）
const oldTokenCaches = new Map();
async function getOldTokenFor(appKey, appSecret) {
  if (!appKey || !appSecret) throw new Error('钉钉应用 AppKey / AppSecret 未配置');
  const now = Date.now();
  const cached = oldTokenCaches.get(appKey);
  if (cached && cached.token && cached.expire > now + 60000) return cached.token;
  const r = await fetch('https://oapi.dingtalk.com/gettoken?appkey=' + encodeURIComponent(appKey) + '&appsecret=' + encodeURIComponent(appSecret), {
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (j.errcode !== 0 || !j.access_token) throw new Error('钉钉老版 token 获取失败: ' + (j.errmsg || 'HTTP ' + r.status));
  oldTokenCaches.set(appKey, { token: j.access_token, expire: now + (j.expires_in || 7200) * 1000 });
  if (oldTokenCaches.size > 30) oldTokenCaches.delete(oldTokenCaches.keys().next().value);
  return j.access_token;
}
async function getOldToken(d) {
  const cfg = getConfig(d);
  return getOldTokenFor(cfg.app_key, cfg.app_secret);
}

// 机器人单聊：sampleText 消息，单次最多 20 人（本服务只发给绑定的 1 人）；成功返回空对象，非 2xx 报错
async function sendRobot(d, token, text, robotCodeOverride) {
  const cfg = getConfig(d);
  let rc = String(robotCodeOverride || cfg.robot_code || cfg.app_key); // 新版机器人 robotCode ≠ AppKey（见 streamService 自动学习）
  for (let i = 0; i < 2; i++) {
    const r = await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify({
        robotCode: rc,
        userIds: [cfg.userid],
        msgKey: 'sampleText',
        msgParam: JSON.stringify({ content: text }),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (r.ok) return true;
    const j = await r.json().catch(() => ({}));
    // 权限类失败（403 / 500 unknownError）：换全新 token 重试一次（旧 token 不带刚开通的权限）
    const permish = r.status === 403 || (r.status >= 500 && String(j.code || '') === 'unknownError');
    if (permish && i === 0) {
      dropTokenFor(cfg.app_key);
      token = await getTokenFor(cfg.app_key, cfg.app_secret);
      continue;
    }
    throw new Error('钉钉机器人发送失败: ' + (j.message || 'HTTP ' + r.status));
  }
  return true;
}

// 服务助手（需员工服务台旗舰版）：oapi 旧版网关，access_token 走查询参数，errcode 判定
async function sendSmartbot(d, token, text) {
  const cfg = getConfig(d);
  const r = await fetch('https://oapi.dingtalk.com/topapi/smartbot/msg/push?access_token=' + encodeURIComponent(token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msg: { msgtype: 'text', text: { content: text } }, user_id_list: cfg.userid }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (j.errcode !== 0) {
    throw new Error(j.errmsg ? `钉钉服务助手返回 ${j.errcode}: ${j.errmsg}` : '钉钉服务助手请求失败: HTTP ' + r.status);
  }
  return true;
}

// 接收人租户配置已启用且绑定齐全才推；未绑定返回 false（静默跳过）
async function pushIfBound(d, text) {
  const cfg = getConfig(d);
  if (!cfg.enabled) return false;
  if (!cfg.app_key || !cfg.app_secret || !cfg.userid) return false;
  const clipped = String(text).slice(0, 2000);
  // 两条通道两种 token：smartbot 走 oapi 老网关（老 token），robot 走 v1.0 新接口（新 token）
  return cfg.mode === 'smartbot' ? sendSmartbot(d, await getOldToken(d), clipped) : sendRobot(d, await getToken(d), clipped);
}

// ---------- 图片推送（企业机器人通道） ----------
// 1) 上传媒体文件（旧版网关 multipart，须用老版 token）：返回 media_id（可复用，仅钉钉客户端内可用）
async function uploadMedia(d, buffer, mime) {
  const token = await getOldToken(d);
  const kind = String(mime || 'image/png').split('/')[1] || 'png';
  const ext = kind === 'jpeg' ? 'jpg' : kind; // 钉钉要求文件名 ≥5 字符且带扩展名
  const form = new FormData();
  form.append('media', new Blob([buffer], { type: mime || 'image/png' }), 'image.' + ext);
  const r = await fetch('https://oapi.dingtalk.com/media/upload?access_token=' + encodeURIComponent(token) + '&type=image', {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json().catch(() => ({}));
  if (j.errcode !== 0 || !j.media_id) {
    throw new Error(j.errmsg ? `钉钉媒体上传失败 ${j.errcode}: ${j.errmsg}` : '钉钉媒体上传失败: HTTP ' + r.status);
  }
  return j.media_id;
}
// 2) 工作通知发图：机器人单聊/服务助手官方都不支持图片消息（sampleImage 会报"不支持类型"），
//    企业内部应用发图的标准通道是「工作通知」asyncsend_v2（oapi 老网关、老 token、需应用自己的 AgentId，
//    权限默认开通）。media_id 必须与 agent_id 同属一个应用——uploadMedia 用的就是本应用凭证，天然满足
async function sendWorkNoticeImage(d, mediaId) {
  const cfg = getConfig(d);
  if (!cfg.agent_id) throw new Error('未配置 AgentId：图片走「工作通知」通道，请到钉钉开发者后台 → 应用详情 → 凭证与基础信息 复制 AgentId 填到下方');
  const r = await fetch('https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2?access_token='
    + encodeURIComponent(await getOldToken(d)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: Number(cfg.agent_id) || cfg.agent_id,
      userid_list: cfg.userid,
      msg: { msgtype: 'image', image: { media_id: mediaId } },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (j.errcode !== 0) throw new Error('钉钉工作通知(图片)发送失败 ' + (j.errcode ?? 'HTTP ' + r.status) + ': ' + (j.errmsg || '响应异常'));
  return true;
}
// 图片版 pushIfBound：与文字通道无关（工作通知是应用级能力，两种通道模式都能用）；
// 未配置 AgentId 时自动推送静默跳过（文字仍照发），测试按钮会给出明确指引
async function pushImageIfBound(d, buffer, mime) {
  const cfg = getConfig(d);
  if (!cfg.enabled || !cfg.app_key || !cfg.app_secret || !cfg.userid) return false;
  if (!cfg.agent_id) return false;
  const mediaId = await uploadMedia(d, buffer, mime);
  return sendWorkNoticeImage(d, mediaId);
}

// 工作通知发文字（日程提醒等定时推送专用）：配了 AgentId 走 asyncsend_v2 文本（默认通道，
// 出现在钉钉「工作通知」会话）；没配则回退普通文字通道（机器人单聊/服务助手），保证提醒总能送达
async function sendWorkNoticeText(d, text) {
  const cfg = getConfig(d);
  if (!cfg.enabled || !cfg.app_key || !cfg.app_secret || !cfg.userid) return false;
  if (!cfg.agent_id) return pushIfBound(d, text); // 未配 AgentId：退回原有文字通道
  const r = await fetch('https://oapi.dingtalk.com/topapi/message/corpconversation/asyncsend_v2?access_token='
    + encodeURIComponent(await getOldToken(d)), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      agent_id: Number(cfg.agent_id) || cfg.agent_id,
      userid_list: cfg.userid,
      msg: { msgtype: 'text', text: { content: String(text).slice(0, 2000) } },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (j.errcode !== 0) throw new Error('钉钉工作通知(文字)发送失败 ' + (j.errcode ?? 'HTTP ' + r.status) + ': ' + (j.errmsg || '响应异常'));
  return true;
}

// 工作通知版 notifyUser：按接收人自己的租户配置推送（日程提醒给共享成员用）
async function notifyUserWorkNotice(mainDb, toUid, text) {
  if (!mainDb.prepare('SELECT id FROM users WHERE id=?').get(Number(toUid))) return false;
  let tdb;
  try { tdb = getTenantDb(Number(toUid)); } catch { return false; }
  return sendWorkNoticeText(tdb, text);
}

// 生成一张 120x60 蓝色 PNG（「测试图片」按钮用；零依赖：手写 PNG 块 + zlib 压缩）
function makeTestPng() {
  const W = 120, H = 60;
  const raw = Buffer.alloc((W * 3 + 1) * H);
  let p = 0;
  for (let y = 0; y < H; y++) {
    raw[p++] = 0; // 每行 filter type 0（None）
    for (let x = 0; x < W; x++) { raw[p++] = 0x4f; raw[p++] = 0x7c; raw[p++] = 0xf7; }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit 真彩
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 消息转发入口：接收人须是平台用户，用其自己的租户配置推送（各人绑各人的钉钉）
async function notifyUser(mainDb, toUid, text) {
  if (!mainDb.prepare('SELECT id FROM users WHERE id=?').get(Number(toUid))) return false;
  let tdb;
  try { tdb = getTenantDb(Number(toUid)); } catch { return false; }
  return pushIfBound(tdb, text);
}

// 图片转发入口（直接给缓冲区版）：监控预警截图等非图床图片，用接收人自己的租户配置上传媒体并推送
async function notifyUserImageBuf(mainDb, toUid, buffer, mime) {
  if (!mainDb.prepare('SELECT id FROM users WHERE id=?').get(Number(toUid))) return false;
  let tdb;
  try { tdb = getTenantDb(Number(toUid)); } catch { return false; }
  return pushImageIfBound(tdb, buffer, mime);
}

// 图片转发入口：按 id 取家庭图床里的图（共享开在主库；关了则可能还在某人租户库，双查兜底），
// 用接收人自己的租户配置上传媒体并推送
async function notifyUserImage(mainDb, toUid, imageId) {
  if (!mainDb.prepare('SELECT id FROM users WHERE id=?').get(Number(toUid))) return false;
  let tdb;
  try { tdb = getTenantDb(Number(toUid)); } catch { return false; }
  // 配置了全局上传路径后贴图只落磁盘（data 列为空串）——网页显示走磁盘回退正常，
  // 但这里只读 data 列会拿到空数据，上传必败且被上层吞掉 = 「图片推送悄悄丢了」
  const row = mainDb.prepare('SELECT mime, data, storage_path FROM family_images WHERE id=?').get(Number(imageId))
    || tdb.prepare('SELECT mime, data, storage_path FROM family_images WHERE id=?').get(Number(imageId));
  if (!row) throw new Error('图片不存在: ' + imageId);
  const buf = (row.storage_path && fs.existsSync(row.storage_path))
    ? fs.readFileSync(row.storage_path)
    : Buffer.from(row.data || '', 'base64');
  if (!buf.length) throw new Error('图片数据为空: ' + imageId);
  return pushImageIfBound(tdb, buf, row.mime);
}

// 手机号 → 企业内 userid（绑定辅助；应用需开通通讯录只读权限，否则钉钉返回权限错误）
async function resolveMobile(d, mobile) {
  if (!String(mobile || '').trim()) throw new Error('手机号必填');
  const token = await getOldToken(d);
  const r = await fetch('https://oapi.dingtalk.com/topapi/v2/user/getbymobile?access_token=' + encodeURIComponent(token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mobile: String(mobile).trim() }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (j.errcode !== 0) throw new Error(j.errmsg ? `查询失败 ${j.errcode}: ${j.errmsg}` : '查询请求失败: HTTP ' + r.status);
  if (!j.result || !j.result.userid) throw new Error('该手机号未找到企业内 userid');
  return j.result.userid;
}

// ---------- 扫码绑定（钉钉扫码登录 OAuth2：授权页 → 回调 authCode → 用户 token → unionId → userid） ----------
// 票据存内存（单进程足够）：发起绑定的登录用户 uid + 生命周期；二维码内容 = 授权页 URL，state 即票据
const bindTickets = new Map(); // ticket -> {uid, base, createdAt, status:'pending'|'bound', lastError, userid, nick}
const BIND_TTL = 10 * 60 * 1000;

function sweepTickets() {
  const now = Date.now();
  for (const [k, t] of bindTickets) if (now - t.createdAt > BIND_TTL) bindTickets.delete(k);
}

const PRIVATE_HOST = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
  }
  return out;
}

// 回调基础地址：显式配置 > 请求来源（非 localhost 即视为手机可达：内网 IP 或公网域名）> 自动探测本机局域网 IP
// （手机扫码确认后由手机浏览器回调该地址，localhost/127.0.0.1 对手机不可达）
function resolveBindBase(d, origin) {
  const cfg = getConfig(d);
  if (cfg.bind_base) return String(cfg.bind_base).replace(/\/+$/, '');
  let o = null;
  try { o = new URL(origin || 'http://x'); } catch { o = null; }
  const host = o ? o.hostname : '';
  if (host && host !== 'localhost' && host !== '127.0.0.1' && host !== '0.0.0.0' && host !== '[::1]') return o.origin;
  const ip = lanIps()[0];
  const port = (o && o.port) || '3000';
  return ip ? `http://${ip}:${port}` : `http://127.0.0.1:${port}`;
}

// 发起绑定：校验凭证 → 生成票据与二维码内容（授权页 URL）
function createBindTicket(d, uid, origin) {
  const cfg = getConfig(d);
  if (!cfg.app_key || !cfg.app_secret) throw new Error('请先填写钉钉应用的 AppKey / AppSecret 并保存');
  sweepTickets();
  const ticket = crypto.randomBytes(16).toString('hex');
  const base = resolveBindBase(d, origin);
  const redirectUri = base + '/api/dingtalk/bind/callback';
  const qrUrl = 'https://login.dingtalk.com/oauth2/auth?redirect_uri=' + encodeURIComponent(redirectUri)
    + '&response_type=code&client_id=' + encodeURIComponent(cfg.app_key)
    + '&scope=openid&state=' + ticket + '&prompt=consent';
  bindTickets.set(ticket, { uid: Number(uid), base, createdAt: Date.now(), status: 'pending', lastError: '', userid: '', nick: '' });
  return { ticket, qr_url: qrUrl, redirect_base: base };
}

// 手机回调：authCode → 用户 accessToken → unionId（users/me）→ 企业 userid（getbyunionid）→ 落库
// 交换失败保留票据可重扫（authCode 一次性、授权页可重复确认），仅记录 lastError 供轮询端展示
async function bindCallback(ticket, authCode) {
  sweepTickets();
  const t = bindTickets.get(String(ticket || ''));
  if (!t) throw new Error('二维码已失效或不存在的票据');
  if (t.status === 'bound') return t;
  if (!authCode) throw new Error('缺少钉钉授权码 authCode');
  try {
    const tdb = getTenantDb(t.uid);
    const cfg = getConfig(tdb);
    // 1) authCode → 用户身份 token（授权码模式）
    const r1 = await fetch('https://api.dingtalk.com/v1.0/oauth2/userAccessToken', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: cfg.app_key, clientSecret: cfg.app_secret, code: authCode, grantType: 'authorization_code' }),
      signal: AbortSignal.timeout(15000),
    });
    const j1 = await r1.json().catch(() => ({}));
    if (!r1.ok || !j1.accessToken) throw new Error('换取用户身份失败: ' + (j1.message || 'HTTP ' + r1.status));
    // 2) 用户信息（昵称 + unionId）
    const r2 = await fetch('https://api.dingtalk.com/v1.0/contact/users/me', {
      headers: { 'x-acs-dingtalk-access-token': j1.accessToken },
      signal: AbortSignal.timeout(15000),
    });
    const j2 = await r2.json().catch(() => ({}));
    if (!r2.ok || !j2.unionId) throw new Error('获取钉钉用户信息失败: ' + (j2.message || 'HTTP ' + r2.status));
    // 3) unionId → 企业内 userid（应用需通讯录只读权限，且扫码人须在应用所属企业内）——oapi 老网关用老 token
    const token = await getOldToken(tdb);
    const r3 = await fetch('https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token=' + encodeURIComponent(token), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unionid: j2.unionId }),
      signal: AbortSignal.timeout(15000),
    });
    const j3 = await r3.json().catch(() => ({}));
    if (j3.errcode !== 0 || !j3.result || !j3.result.userid) {
      throw new Error(j3.errmsg ? `unionId 换 userid 失败 ${j3.errcode}: ${j3.errmsg}（扫码人需在应用所属企业内，且应用需通讯录读取权限）` : 'unionId 换 userid 请求失败');
    }
    // 4) 落库：写 userid/昵称/绑定时间并自动启用推送
    const cur = getSetting(tdb, 'dingtalk_push', null) || {};
    setSetting(tdb, 'dingtalk_push', {
      ...cur,
      userid: j3.result.userid,
      bound_nick: j2.nick || '',
      bound_unionid: j2.unionId,
      bound_at: new Date().toLocaleString('zh-CN', { hour12: false }),
      enabled: true,
    });
    t.status = 'bound';
    t.userid = j3.result.userid;
    t.nick = j2.nick || '';
    return t;
  } catch (e) {
    t.lastError = e.message;
    throw e;
  }
}

// 电脑端轮询绑定进度
function bindStatus(ticket) {
  sweepTickets();
  const t = bindTickets.get(String(ticket || ''));
  if (!t) return { status: 'expired', error: '' };
  return { status: t.status, error: t.lastError || '', userid: t.userid, nick: t.nick };
}

// 解绑：清 userid 与绑定信息（保留应用凭证/通道），停用推送
function unbind(d) {
  const cur = getSetting(d, 'dingtalk_push', null) || {};
  setSetting(d, 'dingtalk_push', {
    ...cur,
    userid: '', bound_nick: '', bound_unionid: '', bound_at: '', enabled: false,
  });
}

// ---------- 钉钉免登（工作台嵌在钉钉内打开：免登码换本地账号） ----------
// 全局配置归主库（dingtalk_login）：登录发生在此之前，取不到任何租户配置；
// 复用「钉钉推送」那套企业内部应用的 AppKey/AppSecret 即可，另需企业 corpId。
function getLoginConfig() {
  const c = getSetting(db, 'dingtalk_login', null) || {};
  return {
    corp_id: String(c.corp_id || '').trim(),
    app_key: String(c.app_key || '').trim(),
    app_secret: String(c.app_secret || '').trim(),
  };
}
function saveLoginConfig(cfg) {
  const cur = getSetting(db, 'dingtalk_login', null) || {};
  if (cfg && cfg.clear) { // 显式清除=停用免登（设置页未放按钮，留给接口/排查用）
    setSetting(db, 'dingtalk_login', { corp_id: '', app_key: '', app_secret: '' });
    return;
  }
  setSetting(db, 'dingtalk_login', {
    corp_id: String((cfg && cfg.corp_id) || cur.corp_id || '').trim(),
    app_key: String((cfg && cfg.app_key) || cur.app_key || '').trim(),
    app_secret: (cfg && cfg.app_secret && cfg.app_secret !== '******') ? String(cfg.app_secret).trim() : cur.app_secret,
  });
}
// 免登码（前端 dd.runtime.permission.requestAuthCode 取得）→ 企业内 userid。
// 应用需具备「企业成员信息」读取权限（企业内部应用默认的通讯录基础权限即可）。
async function useridByAuthCode(code) {
  const cfg = getLoginConfig();
  if (!cfg.corp_id || !cfg.app_key || !cfg.app_secret) {
    throw new Error('管理员尚未配置钉钉免登（设置 → 钉钉免登：corpId / AppKey / AppSecret）');
  }
  const token = await getOldTokenFor(cfg.app_key, cfg.app_secret); // oapi 老网关，须用老版 token
  const r = await fetch('https://oapi.dingtalk.com/topapi/v2/user/getuserinfo?access_token=' + encodeURIComponent(token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: String(code || '') }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (j.errcode !== 0 || !j.result || !j.result.userid) {
    throw new Error(j.errmsg ? `免登码换取用户失败 ${j.errcode}: ${j.errmsg}` : '免登码换取用户请求失败');
  }
  return j.result.userid;
}

// 下载机器人接收消息的文件内容（图片/语音/文件/视频）：downloadCode → 临时下载链接。
// 新网关 v1.0 接口、用新版 token；robotCode 必须是接收该消息的机器人（消息体自带，默认同 AppKey）。
// 「未知错误」即钉钉侧 system.error（官方错误码表标注为瞬时系统错误、可重试）：间隔 1s 重试一次；
// 错误信息带上 HTTP 状态码/错误码/请求 id，再出问题能直接定位（此前只回 message，细节全丢）
async function downloadRobotFileUrl(d, downloadCode, robotCode) {
  let token = await getToken(d);
  let lastErr = '';
  for (let i = 0; i < 2; i++) {
    const r = await fetch('https://api.dingtalk.com/v1.0/robot/messageFiles/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify({ downloadCode: String(downloadCode || ''), robotCode: String(robotCode || '') }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.downloadUrl) return j.downloadUrl;
    lastErr = `HTTP ${r.status}`
      + (j.code ? ` ${j.code}` : '') + (j.message ? ` ${j.message}` : '')
      + (j.requestid ? `（req ${j.requestid}）` : '');
    // 权限类失败：403（应用没开通 qyapi_robot_sendmsg，错误信息自带申请链接）或
    // 500 unknownError（真实下载码 + 缓存的旧 token 没带刚开通的权限就是这形态）——
    // 清 token 缓存换全新 token 立即重试一次，别让用户等 2 小时缓存自然过期
    const permish = r.status === 403 || (r.status >= 500 && String(j.code || '') === 'unknownError');
    if (permish && i === 0) {
      dropTokenFor(getConfig(d).app_key);
      token = await getToken(d);
      continue;
    }
    const transient = r.status >= 500 || String(j.code || '') === 'system.error';
    if (!transient || i === 1) break;
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error('获取文件下载链接失败: ' + lastErr);
}

module.exports = {
  getConfig, getAppConfig, saveAppConfig, saveBinding, migrateAppConfig, getToken, pushIfBound, notifyUser, notifyUserImage, notifyUserImageBuf, uploadMedia, resolveMobile,
  createBindTicket, bindCallback, bindStatus, unbind,
  getLoginConfig, saveLoginConfig, useridByAuthCode,
  makeTestPng, pushImageIfBound, sendWorkNoticeText, notifyUserWorkNotice, downloadRobotFileUrl, sendRobot,
};
