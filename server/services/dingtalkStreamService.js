// 钉钉机器人 Stream 长连接（官方 dingtalk-stream SDK）：
//   收：单聊消息按发件人路由——senderStaffId（企业 userid）匹配各成员「钉钉推送」的绑定，
//       命中进 TA 自己的「短消息 → 钉钉」会话；群聊 @机器人 仍归应用归属人
//       （同应用多人配置只连一条，先到先得；此前不路由，家人的单聊全进了管理员信箱）。
//   发：消息页给「钉钉」成员发消息 = 机器人发回该成员自己的会话
//       （sessionWebhook 优先；单聊过期走企业机器人单发接口，群聊走群消息接口）。
// 依赖容错：常规升级包只携带 server/ 与 web/dist/，目标容器 node_modules 若尚未安装
// dingtalk-stream（v1.0.7 新增的依赖），裸 require 会让服务起不来——缺失时只停用
// 机器人接收，不影响启动与其他功能（完整版升级包会把依赖打进 server/node_modules）
let DWClient = null;
try { ({ DWClient } = require('dingtalk-stream')); } catch { DWClient = null; }
const { db, getTenantDb, getSetting, setSetting, ensureDingtalkBot, dataDir, routedDb } = require('../db');
const fs = require('fs');
const path = require('path');
const dingtalk = require('./dingtalkService');
const messageService = require('./messageService');
const storagePaths = require('./storagePaths');

const TOPIC_ROBOT = '/v1.0/im/bot/messages/get';
// 主库 settings：每个成员最近一次与机器人会话的信息（回复通道），按人隔离——
// 全局共用一份时，任何人在工作台发消息都会打到别人最后所在的钉钉会话（串台）
const stateKey = (uid) => `dingtalk_robot_state_u${Number(uid)}`;

const streams = new Map(); // appKey -> { client, ownerUid, name }
let started = false;
let botIdCache = 0;

function botId() {
  if (!botIdCache) {
    const r = db.prepare("SELECT id FROM users WHERE username='dingtalk_bot' AND is_bot=1").get();
    botIdCache = r ? r.id : 0;
  }
  return botIdCache;
}

// 图片字节魔数嗅探：下载回来的内容未必真是图片，认不出就拒绝入库
function sniffImageMime(b) {
  if (!b || b.length < 12) return '';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.slice(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  if (b.slice(0, 4).toString('latin1') === 'RIFF' && b.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (b.slice(0, 2).toString('latin1') === 'BM') return 'image/bmp';
  return '';
}

// 富文本消息体里的文字段要按 HTML 转义（displayHtml 见 img 即按富文本原样渲染，不转义）
function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' };

// 下载码 → 临时链接 → 图片字节 → 家庭图床 family_images（随 family 共享开关路由），返回图片 id
// （消息体渲染为 <img src="/api/family-images/N">，前端 displayHtml 补 ?token=）
// pictureDownloadCode 与 downloadCode 双码依次尝试——真实报文里两个字段都可能给，
// 哪个能用随钉钉版本而异（排除收图 500 时加的兼容），全失败抛最后一个错误
async function downloadRobotImage(ownerUid, p, ...codeCandidates) {
  const codes = [...new Set(codeCandidates.map((c) => String(c || '').trim()).filter(Boolean))];
  const robotCode = String(p.robotCode || '');
  if (!codes.length) throw new Error('消息缺少图片下载码');
  if (!robotCode) throw new Error('消息缺少 robotCode');
  const tdb = getTenantDb(Number(ownerUid));
  let lastErr = null;
  for (const code of codes) {
    try {
      const downUrl = await dingtalk.downloadRobotFileUrl(tdb, code, robotCode);
      return await saveRobotImage(ownerUid, downUrl);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('图片下载失败');
}
async function saveRobotImage(ownerUid, downUrl) {
  const r = await fetch(downUrl, { signal: AbortSignal.timeout(30000), redirect: 'follow' });
  if (!r.ok) throw new Error('下载图片失败: HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > 10 * 1024 * 1024) throw new Error('图片超过 10MB');
  const mime = sniffImageMime(buf);
  if (!mime) throw new Error('内容不是支持的图片格式（png/jpg/gif/webp/bmp）');
  // 配了全局上传目录就落盘（省数据库体积），失败静默回退存库；
  // 图片随 family 共享开关路由到对应库的 family_images（与家庭事项「通知」同库，前端可直接渲染）
  let spath = '';
  try { spath = storagePaths.bestEffortSave('family-images', `dingtalk.${IMG_EXT[mime]}`, buf, `dt${ownerUid}_`); } catch {}
  const ins = routedDb(getTenantDb(Number(ownerUid)), 'family')
    .prepare('INSERT INTO family_images(mime,size,data,storage_path) VALUES(?,?,?,?)')
    .run(mime, buf.length, spath ? '' : buf.toString('base64'), spath);
  return Number(ins.lastInsertRowid);
}

// 纯图片消息 → 富文本消息体
async function pictureMessageHtml(ownerUid, p, sender) {
  const c = p.content || {};
  const imgId = await downloadRobotImage(ownerUid, p, c.pictureDownloadCode, c.downloadCode);
  return `发来图片<br><img src="/api/family-images/${imgId}">`;
}

// 富文本消息（文字+图片混合）：逐段转义文字 / 下载图片，单图失败不影响其余段落
async function richTextMessageHtml(ownerUid, p, sender) {
  const parts = (p.content && Array.isArray(p.content.richText)) ? p.content.richText : [];
  if (!parts.length) throw new Error('富文本内容为空');
  const segs = [];
  for (const q of parts) {
    if (q && typeof q.text === 'string' && q.text) { segs.push(escHtml(q.text)); continue; }
    const code = (q && (q.pictureDownloadCode || q.downloadCode)) || '';
    if (!code) continue;
    try {
      const imgId = await downloadRobotImage(ownerUid, p, q.pictureDownloadCode, q.downloadCode);
      segs.push(`<img src="/api/family-images/${imgId}">`);
    } catch (e) {
      segs.push(`[图片下载失败：${escHtml(e.message)}]`);
    }
  }
  return segs.join('<br>');
}

const inflightMsgs = new Set(); // 图片下载中的 msgId：行还没入库，去重查询查不到，先挡住钉钉重推

// 单聊按发件人路由：senderStaffId（企业内 userid）在各成员租户库「钉钉推送」的绑定里找同应用的 userid，
// 命中 → 消息进 TA 自己的信箱；未绑定/未命中回落应用归属人。群聊不路由（@谁的都是群消息，归归属人）
function routeUidByStaff(appKey, senderStaffId) {
  const staff = String(senderStaffId || '');
  if (!staff) return 0;
  const app = dingtalk.getAppConfig();
  if (!app.app_key || app.app_key !== String(appKey || '')) return 0;
  for (const u of db.prepare('SELECT id FROM users WHERE is_bot=0 ORDER BY id').all()) {
    try {
      const cfg = dingtalk.getConfig(getTenantDb(u.id));
      if (cfg.userid === staff) return u.id;
    } catch { /* 租户库异常跳过 */ }
  }
  return 0;
}

// 收到一条机器人消息：msgId 去重（Stream 未 ack 会重推）→ 按发件人定归属 → 记录回复通道 →
// 入库为「钉钉」发来的消息。文字消息同步入库；图片/富文本要先经下载接口取回（秒级）——
// 先 ack、后台落库，失败兜底一条文字提示，绝不静默丢消息（返回值 .async 供测试等待后台任务）
function processRobotMessage(ownerUid, p, appKey) {
  if (!botId()) return { ok: false, reason: '机器人成员未初始化' };
  const msgId = String(p.msgId || '');
  if (msgId && inflightMsgs.has(msgId)) return { ok: true, reason: '重复推送（处理中）' };
  if (msgId && routedDb(getTenantDb(Number(ownerUid)), 'family').prepare("SELECT id FROM family_items WHERE ext_id=?").get(msgId)) {
    return { ok: false, reason: '重复推送已忽略' };
  }
  const mt = String(p.msgtype || 'text');
  const text = String((p && p.text && p.text.content) || '').trim();
  if (mt === 'text' && !text) return { ok: false, reason: '空消息' };
  const sender = String(p.senderNick || '钉钉成员');
  // 单聊按发件人路由到本人信箱（此前一律归归属人，家人的消息全进管理员会话）
  let routeUid = Number(ownerUid);
  if (String(p.conversationType || '') === '1') {
    const hit = routeUidByStaff(appKey, p.senderStaffId);
    if (hit) routeUid = hit;
  }
  // 机器人编码自动学习：新版机器人的 robotCode ≠ AppKey（推送/单发用 AppKey 会报「robot 不存在」）。
  // 消息里的 robotCode 是钉钉认的权威值——发现与应用配置不一致就写回全局应用配置
  try {
    const rc = String(p.robotCode || '');
    if (rc) {
      const app = dingtalk.getAppConfig();
      if (app.app_key && app.app_key === String(appKey || '') && app.robot_code !== rc) {
        dingtalk.saveAppConfig({ robot_code: rc });
      }
    }
  } catch { /* 学习失败不影响收消息 */ }
  // 会话信息按人存主库：回复时 sessionWebhook 新鲜则直发，单聊过期走机器人单发、群聊走群消息接口
  setSetting(db, stateKey(routeUid), {
    owner_uid: Number(ownerUid),
    conversation_id: String(p.conversationId || ''),
    conversation_type: String(p.conversationType || ''),
    robot_code: String(p.robotCode || ''),
    session_webhook: String(p.sessionWebhook || ''),
    session_webhook_expire: Number(p.sessionWebhookExpiredTime || 0),
    title: String(p.conversationTitle || ''),
    updated_at: new Date().toLocaleString('zh-CN', { hour12: false }),
  });
  // 钉钉发来的消息统一落到「家庭事项 → 通知」板（不再进短消息），全员可见；
  // 图片已下载到 family_images，title 用 /api/family-images/N 引用（前端 displayHtml 补 ?token=）
  const pushFamily = (content) => {
    const fdb = routedDb(getTenantDb(Number(ownerUid)), 'family');
    const r = fdb.prepare('INSERT INTO family_items(title,desc,item_date,status,created_by,created_by_name,ext_id) VALUES(?,?,?,?,?,?,?)')
      .run(content, '', new Date().toLocaleDateString('sv'), 'todo', botId(), sender, msgId);
    return Number(r.lastInsertRowid);
  };
  if (mt === 'text') return { ok: true, id: pushFamily(escHtml(text)) };
  if (mt === 'picture' || mt === 'richText') {
    // 调试：真实报文落盘（收图 500 排查用；报文不含任何凭证，downloadCode 数分钟即失效）
    try {
      fs.appendFileSync(path.join(dataDir, 'dingtalk-pic-debug.log'),
        `[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${JSON.stringify(p)}\n`);
    } catch { /* 日志失败不影响业务 */ }
    if (msgId) inflightMsgs.add(msgId);
    const task = (async () => {
      try {
        const content = mt === 'picture' ? await pictureMessageHtml(ownerUid, p, sender)
          : await richTextMessageHtml(ownerUid, p, sender);
        return { ok: true, id: pushFamily(content) };
      } catch (e) {
        console.warn(`[dingtalk-stream] ${mt === 'picture' ? '图片' : '富文本'}消息入库失败，降级为文字提示:`, e.message);
        return { ok: true, id: pushFamily(`[${mt === 'picture' ? '图片' : '富文本'}消息接收失败：${escHtml(e.message)}]`) };
      } finally {
        if (msgId) inflightMsgs.delete(msgId);
      }
    })();
    return { ok: true, async: task };
  }
  // 语音/视频/文件（仅人与机器人单聊会推）：暂不展示内容，文字提示收到了
  const KIND = { audio: '语音', video: '视频', file: '文件' };
  return { ok: true, id: pushFamily(`[收到一条${KIND[mt] || mt}消息，暂不支持查看]`) };
}

// 消息页 →「钉钉」成员：把内容经机器人发回该成员自己的会话（带发送人署名）
// 通道 1：本人会话的 sessionWebhook（约 2 小时有效，免 token，单聊/群聊通用）
// 通道 2：单聊 webhook 过期/从未收过消息 → 企业机器人单发 oToMessages/batchSend
//         （发到本人绑定的钉钉，永不过期；须先在「设置 → 钉钉推送」绑定）
// 通道 3：群聊 → groupMessages/send。全部不可用返回 false（messageService 回执失败提示）
async function robotReply(fromUid, text) {
  const st = getSetting(db, stateKey(fromUid), null) || {};
  const who = messageService.userName(db, fromUid);
  const content = `【工作台·${who}】${String(text || '').trim()}`.slice(0, 2000);
  const wh = String(st.session_webhook || '');
  if (wh && Number(st.session_webhook_expire || 0) > Date.now() + 30000) {
    const r = await fetch(wh, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'text', text: { content } }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (j.errcode !== 0) throw new Error(`sessionWebhook 回复失败 ${j.errcode}: ${j.errmsg || 'HTTP ' + r.status}`);
    return true;
  }
  // 单聊（或还没有任何会话记录）：直接单发到本人绑定的钉钉
  if (String(st.conversation_type) !== '2') {
    const d = getTenantDb(Number(fromUid));
    const cfg = dingtalk.getConfig(d);
    if (cfg.app_key && cfg.app_secret && cfg.userid) {
      // robotCode 用消息里学到的真实编码（新版机器人编码 ≠ AppKey，用 AppKey 会报「robot 不存在」）
      await dingtalk.sendRobot(d, await dingtalk.getToken(d), content, String(st.robot_code || ''));
      return true;
    }
    return false; // 本人没绑定钉钉：让 messageService 回执「未送达」
  }
  if (st.conversation_id && st.robot_code) {
    const token = await dingtalk.getToken(getTenantDb(Number(st.owner_uid || fromUid)));
    const r = await fetch('https://api.dingtalk.com/v1.0/robot/groupMessages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify({
        robotCode: st.robot_code, openConversationId: st.conversation_id,
        msgKey: 'sampleText', msgParam: JSON.stringify({ content }),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error('群消息发送失败: ' + (j.message || 'HTTP ' + r.status));
    }
    return true;
  }
  return false;
}

// 唯一的一份全局钉钉应用（凭证齐全才建长连接）。
// 注意：接收不依赖 enabled 开关——enabled 只控制「消息推送出去」；只要全局凭证在，
// 群里 @机器人 的消息就进站内（想彻底停接收就由管理员清空 AppKey/AppSecret）
function desiredConfigs() {
  const out = new Map();
  const app = dingtalk.getAppConfig();
  if (app.app_key && app.app_secret) {
    const owner = db.prepare('SELECT username FROM users WHERE id=?').get(app.owner_uid);
    out.set(app.app_key, { ownerUid: app.owner_uid || 1, name: owner ? owner.username : '钉钉应用', secret: app.app_secret });
  }
  return out;
}

// 对齐当前配置：断开凭证被清空的应用，为新应用建长连接（配置保存/定时扫描都会走到这里）
function rescan() {
  if (!DWClient) return 0; // 依赖未安装：接收停用（start 处已提示）
  const want = desiredConfigs();
  for (const [key, s] of streams) {
    if (!want.has(key)) {
      console.log(`[dingtalk-stream] 断开应用 ${key.slice(0, 6)}…（已停用或凭证清空）`);
      try { s.client.disconnect(); } catch {}
      streams.delete(key);
    } else {
      s.ownerUid = want.get(key).ownerUid; // 归属人可能变化（更小 uid 启用了同一应用）
    }
  }
  for (const [key, info] of want) {
    if (streams.has(key)) continue;
    const client = new DWClient({ clientId: key, clientSecret: info.secret, debug: false, keepAlive: true });
    client.registerCallbackListener(TOPIC_ROBOT, (msg) => {
      // CALLBACK 分支 SDK 不会自动应答：必须手动 ack，否则钉钉 60s 后会重推同一条
      let ack = { status: 'SUCCESS', message: 'OK' };
      try {
        const cur = streams.get(key);
        const r = processRobotMessage(cur ? cur.ownerUid : info.ownerUid, JSON.parse(msg.data || '{}'), key);
        if (!r.ok) console.log(`[dingtalk-stream] 消息未入库：${r.reason}`);
      } catch (e) {
        console.warn('[dingtalk-stream] 处理机器人消息失败:', e.message);
        ack = { status: 'LATER', message: e.message };
      }
      try { client.socketCallBackResponse(msg.headers && msg.headers.messageId, ack); } catch {}
    });
    streams.set(key, { client, ownerUid: info.ownerUid, name: info.name });
    client.connect().then(() => {
      console.log(`[dingtalk-stream] 应用 ${key.slice(0, 6)}… 长连接已建立（归属 ${info.name}）：群里 @机器人 的消息将进入「短消息 → 钉钉」`);
    }).catch((e) => {
      console.warn(`[dingtalk-stream] 应用 ${key.slice(0, 6)}… 连接失败（SDK 将自动重连）:`, e.message);
    });
  }
  return want.size;
}

function start() {
  if (started) return;
  started = true;
  ensureDingtalkBot(db); // 多租户迁移/历史导入后再补一次（幂等）
  dingtalk.migrateAppConfig(); // 老版各租户自配的应用凭证提升到全局（一次性）
  if (!DWClient) {
    console.log('[dingtalk-stream] 未安装 dingtalk-stream 依赖：机器人消息接收停用（其余功能不受影响；用「完整版升级包」升级可带上依赖）');
    return;
  }
  if (!rescan()) console.log('[dingtalk-stream] 暂无已配置凭证的钉钉应用（在「设置 → 钉钉推送」填 AppKey/AppSecret 后，群里 @机器人 的消息会出现在「短消息 → 钉钉」；机器人能力需在开放平台选择 Stream 模式）');
  setInterval(() => { try { rescan(); } catch {} }, 5 * 60 * 1000).unref?.();
}

module.exports = { start, rescan, processRobotMessage, robotReply, botId };
