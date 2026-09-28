// 小米智能摄像头「看家事件」云服务（v1.6.19 新增，监控 tab 截图/录像）
// 背景：OAuth 授权通道（mihomeService）拿不到摄像头真实画面（HLS 转码不推流、快照是占位图、
// 设备列表无缩略图字段——2026-09-28 全部实测排除）。米家 App / hass-xiaomi-miot 的截图与录像
// 走另一套「智能摄像头业务接口」（business/processor.smartcamera.api.io.mi.com），凭证为小米账号
// 密码登录换来的 {serviceToken, ssecurity}（RC4 签名请求 + ssecurity 派生密钥解密图片）。
//
// 凭证策略（用户拍板「密码不存生产」）：密码登录只发生在用户本地网络的登录工具
// （scripts/micloud-login-tool.cjs）里，本服务只接收注入的 {userId, serviceToken, ssecurity}，
// AES-256-GCM 加密落库（密钥自 WORKBENCH_SECRET 派生，与米家 OAuth 令牌同规格隔离）。
// 凭证过期（通常数周）后监控页提示，重跑本地工具注入即可。密码永不上传、不落盘。
//
// 协议蓝本：hass-xiaomi-miot core/xiaomi_cloud.py + micloud 包 miutils.py（MIT），
// 关键算法：genNonce / signedNonce(sha256) / RC4(drop1024) / sha1Sign / 登录三步走。
const crypto = require('crypto');
const { db, getSetting, setSetting } = require('../db');

// ---------- 凭证加密（AES-256-GCM；密钥独立派生，不与米家 OAuth 令牌共用） ----------
const SECRET = crypto.createHash('sha256')
  .update(process.env.WORKBENCH_SECRET || 'workbench-default-secret-change-me')
  .update('micam')
  .digest();
function enc(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SECRET, iv);
  const out = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${out.toString('hex')}`;
}
function dec(stored) {
  if (!stored) return '';
  const [, ivHex, tagHex, dataHex] = String(stored).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', SECRET, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

const CFG_KEY = 'micam_creds';
function readCreds() {
  const c = getSetting(db, CFG_KEY, null) || {};
  return {
    region: ['cn', 'sg', 'de', 'i2', 'ru', 'us'].includes(c.region) ? c.region : 'cn',
    user_id: c.user_id || '',
    service_token: dec(c.service_token_enc || ''),
    ssecurity: dec(c.ssecurity_enc || ''),
    injected_at: c.injected_at || null,
  };
}

// 注入（本地登录工具调用）：只收令牌产物，绝不收密码
function injectCreds(t) {
  const user_id = String((t && t.user_id) || '').trim();
  const service_token = String((t && t.service_token) || '').trim();
  const ssecurity = String((t && t.ssecurity) || '').trim();
  const region = ['cn', 'sg', 'de', 'i2', 'ru', 'us'].includes(t && t.region) ? t.region : 'cn';
  if (!/^\d{1,20}$/.test(user_id)) throw new Error('user_id 需为数字（小米用户 ID）');
  if (service_token.length < 16 || service_token.length > 400) throw new Error('service_token 格式不正确');
  if (!/^[A-Za-z0-9+/=]{16,120}$/.test(ssecurity)) throw new Error('ssecurity 格式不正确（应为 base64）');
  setSetting(db, CFG_KEY, {
    region, user_id,
    service_token_enc: enc(service_token),
    ssecurity_enc: enc(ssecurity),
    injected_at: new Date().toISOString(),
  });
  eventsCache.clear(); // 换凭证清事件缓存
  return status();
}
function clearCreds() {
  setSetting(db, CFG_KEY, null);
  eventsCache.clear();
}
function status() {
  const c = readCreds();
  return { bound: !!c.service_token, user_id: c.user_id, region: c.region, injected_at: c.injected_at };
}
function requireCreds() {
  const c = readCreds();
  if (!c.service_token || !c.ssecurity) {
    throw new Error('摄像头事件凭证未注入：请在本地电脑运行 scripts/micloud-login-tool.cjs 完成登录注入');
  }
  return c;
}

// ---------- 米云协议（对齐 micloud miutils / hass-xiaomi-miot MiotCloud） ----------
function hostOf(host, region) {
  return region && region !== 'cn' ? `${region}.${host}` : host;
}
// gen_nonce：8 字节随机（带符号 int64 形状）+ (毫秒/60000) 的大端变长整数 → base64
function genNonce() {
  const millis = Date.now();
  const b = crypto.randomBytes(8); // 高位随机即可，服务端只做 base64 回解
  const part2 = Math.floor(millis / 60000);
  const len = Math.max(1, Math.ceil(part2.toString(2).length / 8));
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) buf[i] = Math.floor(part2 / 2 ** (8 * (len - 1 - i))) & 0xff;
  return Buffer.concat([b, buf]).toString('base64');
}
// signed_nonce = base64( sha256( b64d(ssecurity) + b64d(nonce) ) )
function signedNonce(ssecurity, nonce) {
  return crypto.createHash('sha256')
    .update(Buffer.from(ssecurity, 'base64')).update(Buffer.from(nonce, 'base64'))
    .digest('base64');
}
// RC4（先丢弃 1024 字节密钥流），加解密同函数
function rc4(keyBuf, data) {
  const S = new Uint8Array(256);
  for (let i = 0; i < 256; i++) S[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + S[i] + keyBuf[i % keyBuf.length]) & 0xff;
    [S[i], S[j]] = [S[j], S[i]];
  }
  const out = Buffer.allocUnsafe(data.length);
  let i = 0; j = 0;
  for (let n = 0; n < 1024 + data.length; n++) {
    i = (i + 1) & 0xff; j = (j + S[i]) & 0xff; [S[i], S[j]] = [S[j], S[i]];
    if (n >= 1024) out[n - 1024] = data[n - 1024] ^ S[(S[i] + S[j]) & 0xff]; // 前 1024 字节密钥流直接丢弃
  }
  return out;
}
const rc4B64 = (keyB64, data) => rc4(Buffer.from(keyB64, 'base64'), data);
// sha1_sign：[METHOD, path(去 /app 前缀), 按 key 插入序 k=v …, nonce] 以 & 连接 → sha1 → base64
function sha1Sign(method, url, dat, nonce) {
  let path = new URL(url).pathname;
  if (path.startsWith('/app/')) path = path.slice(4);
  const arr = [String(method).toUpperCase(), path];
  for (const [k, v] of Object.entries(dat)) arr.push(`${k}=${v}`);
  arr.push(nonce);
  return crypto.createHash('sha1').update(arr.join('&'), 'utf8').digest('base64');
}
// rc4_params：{data} → 加 rc4_hash__ 签名 → 逐值 RC4 加密 → 加密后整体再签 signature → 附 ssecurity/_nonce
function rc4Params(ssecurity, method, url, params) {
  const nonce = genNonce();
  const sn = signedNonce(ssecurity, nonce);
  const p = { ...params };
  p.rc4_hash__ = sha1Sign(method, url, p, sn);
  for (const k of Object.keys(p)) p[k] = rc4B64(sn, Buffer.from(p[k], 'utf8')).toString('base64');
  p.signature = sha1Sign(method, url, p, sn);
  p.ssecurity = ssecurity;
  p._nonce = nonce;
  return p;
}

const API_HEADERS = {
  'X-XIAOMI-PROTOCAL-FLAG-CLI': 'PROTOCAL-HTTP2',
  'Content-Type': 'application/x-www-form-urlencoded',
  'User-Agent': 'Android-7.1.1-1.0.0-ONEPLUS A3010-136-WORKBENCHAABCDEF APP/xiaomi.smarthome APPV/62830',
};
function apiCookies(c) {
  return {
    userId: String(c.user_id),
    yetAnotherServiceToken: c.service_token,
    serviceToken: c.service_token,
    locale: 'zh_CN', timezone: 'GMT+08:00', is_daylight: '0', dst_offset: '0',
    channel: 'MI_APP_STORE',
  };
}
const cookieHeader = (ck) => Object.entries(ck).map(([k, v]) => `${k}=${v}`).join('; ');

// ---------- 业务接口 ----------
const BIZ_HOST = 'business.smartcamera.api.io.mi.com';
const PROC_HOST = 'processor.smartcamera.api.io.mi.com';

// 通用签名 GET（响应为 RC4 密文时自动解密；返回 JSON 对象）
async function camApiGet(c, path, dataObj) {
  const url = `https://${hostOf(BIZ_HOST, c.region)}${path}`;
  const p = rc4Params(c.ssecurity, 'GET', url, { data: JSON.stringify(dataObj) });
  const qs = new URLSearchParams(p).toString();
  const res = await fetch(`${url}?${qs}`, {
    headers: { ...API_HEADERS, 'MIOT-ENCRYPT-ALGORITHM': 'ENCRYPT-RC4', 'Accept-Encoding': 'identity', Cookie: cookieHeader(apiCookies(c)) },
    signal: AbortSignal.timeout(15000),
  });
  let text = await res.text();
  if (!res.ok && !text) throw new Error(`摄像头云接口异常（HTTP ${res.status}）`);
  // 含 message 的明文错误直接解析；密文用请求 nonce 派生密钥解密
  if (text && !text.includes('message')) {
    try {
      text = rc4B64(signedNonce(c.ssecurity, p._nonce), Buffer.from(text, 'base64')).toString('utf8');
    } catch { /* 保底按原文解析 */ }
  }
  let j = null;
  try { j = JSON.parse(text); } catch { /* fallthrough */ }
  if (!j) throw new Error(`摄像头云接口响应异常（HTTP ${res.status}）`);
  if (j.code === 3 || /auth err|SERVICETOKEN_EXPIRED|invalid signature/i.test(j.message || '')) {
    throw new Error('摄像头事件凭证已过期：请在本地电脑重跑 scripts/micloud-login-tool.cjs 注入');
  }
  if (j.code !== 0 && j.code != null) throw new Error(`摄像头云接口错误 ${j.code}：${j.message || '未知'}`);
  return j;
}

// 最近事件（playUnits：fileId/imgStoreId/createTime/isAlarm/tags）
const eventsCache = new Map(); // did → { at, events: [] }
async function getLatestEvents(did, limit) {
  const c = requireCreds();
  const hit = eventsCache.get(String(did));
  if (hit && Date.now() - hit.at < 60 * 1000) return hit.events;
  const now = Date.now();
  const r = await camApiGet(c, '/miot/camera/app/v1/alarm/playlist/limit', {
    did: String(did),
    region: c.region.toUpperCase(),
    language: 'zh_CN',
    beginTime: now - 7 * 24 * 3600 * 1000,
    endTime: now + 1000,
    limit: limit || 3,
  });
  const units = (r && r.data && r.data.playUnits) || [];
  const events = units.map((u) => ({
    fileId: String(u.fileId != null ? u.fileId : ''),
    stoId: String(u.imgStoreId != null ? u.imgStoreId : ''),
    time: u.createTime || 0,
    isAlarm: !!u.isAlarm,
    tags: Array.isArray(u.tags) ? u.tags : [],
  })).filter((e) => e.fileId);
  eventsCache.set(String(did), { at: Date.now(), events });
  return events;
}

// 图片签名 URL（processor 域）：segmentIv 为客户端自生成随机 IV（图片 AES-256-CBC 解密用）
function buildImageUrl(c, did, fileId, stoId, ivB64) {
  const url = `https://${hostOf(PROC_HOST, c.region)}/miot/camera/app/v1/img`;
  const p = rc4Params(c.ssecurity, 'GET', url, {
    data: JSON.stringify({ did: String(did), fileId: String(fileId), stoId: String(stoId), segmentIv: ivB64 }),
  });
  p.yetAnotherServiceToken = c.service_token;
  return `${url}?${new URLSearchParams(p).toString()}`;
}
// 录像片段签名 URL（business 域 m3u8）
function buildM3u8Url(c, did, model, fileId, isAlarm) {
  const url = `https://${hostOf(BIZ_HOST, c.region)}/common/app/m3u8`;
  const p = rc4Params(c.ssecurity, 'GET', url, {
    data: JSON.stringify({ did: String(did), model: String(model || ''), fileId: String(fileId), isAlarm: !!isAlarm, videoCodec: 'H265' }),
  });
  p.yetAnotherServiceToken = c.service_token;
  return `${url}?${new URLSearchParams(p).toString()}`;
}

// 拉事件截图并解密（AES-256-CBC，key=b64d(ssecurity)，iv=自生成 segmentIv）；
// 结果按 fileId 内存缓存（10 分钟），避免每次进页面都打小米接口。
const imgCache = new Map(); // fileId → { at, buf }
async function fetchEventImage(did, fileId, stoId) {
  const c = requireCreds();
  const key = `${did}:${fileId}`;
  const hit = imgCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.buf;
  const iv = crypto.randomBytes(16);
  const url = buildImageUrl(c, did, fileId, stoId, iv.toString('base64'));
  const res = await fetch(url, { headers: { 'User-Agent': API_HEADERS['User-Agent'] }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`截图拉取失败（HTTP ${res.status}）`);
  const raw = Buffer.from(await res.arrayBuffer());
  let out = raw;
  try {
    const d = crypto.createDecipheriv('aes-256-cbc', Buffer.from(c.ssecurity, 'base64'), iv);
    out = Buffer.concat([d.update(raw), d.final()]);
  } catch { /* 解密失败按原图返回（个别事件可能未加密） */ }
  if (!(out.length > 2 && (out[0] === 0xff || out[0] === 0x89 || out[0] === 0x42))) {
    throw new Error('截图解密失败（凭证可能已过期）');
  }
  if (imgCache.size > 60) imgCache.clear();
  imgCache.set(key, { at: Date.now(), buf: out });
  return out;
}

// 拉事件 m3u8 文本 / 视频分片（仅放行小米流媒体与图片 CDN 域，防 SSRF）
const UPSTREAM_RE = /^https:\/\/[a-z0-9.-]+\.(io\.mi\.com|mi-img\.com)\//;
// 取事件录像播放列表（代理用）：{url, body}
async function clipPlaylist(did, model, fileId, isAlarm) {
  const c = requireCreds();
  const url = buildM3u8Url(c, did, model, fileId, isAlarm);
  return { url, body: await fetchM3u8Text(url) };
}
async function fetchM3u8Text(url) {
  if (!UPSTREAM_RE.test(url)) throw new Error('上游地址非法');
  const res = await fetch(url, { headers: { 'User-Agent': API_HEADERS['User-Agent'] }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`录像片段拉取失败（HTTP ${res.status}）`);
  return res.text();
}
async function fetchUpstreamBuf(url) {
  if (!UPSTREAM_RE.test(url)) throw new Error('上游地址非法');
  const res = await fetch(url, { headers: { 'User-Agent': API_HEADERS['User-Agent'] }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`分片拉取失败（HTTP ${res.status}）`);
  return Buffer.from(await res.arrayBuffer());
}

module.exports = {
  status, injectCreds, clearCreds, getLatestEvents, buildM3u8Url,
  fetchEventImage, fetchM3u8Text, fetchUpstreamBuf, clipPlaylist,
  _internals: { genNonce, signedNonce, rc4, sha1Sign, rc4Params },
};
