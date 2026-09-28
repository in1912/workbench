// 米家智能家居云服务（v1.6.8 新增「智能家居」页）
// 通道：小米账号 OAuth2 + api.io.mi.com 云端 MIoT 接口（个人自用，无企业开发者账号要求）。
//   - 扫码绑定：account.xiaomi.com/oauth2/authorize 授权页地址生成二维码，手机（小米账号已登录）
//     扫码确认后回跳本站回调，服务端用 code 换 access_token/refresh_token；
//   - 云 API：Bearer 令牌调用 /app/v2/*（家庭/设备/属性读写/动作），401 自动用 refresh_token 续期，
//     续期失败标记失效，前端提示重新扫码；
//   - 设备能力定义：miot-spec.org 公开描述文档（服务/属性/事件/动作），按 urn 缓存 24h。
// 绑定为全工作台共享（家庭共用一个米家账号），令牌 AES-256-GCM 加密存主库 settings，绝不明文出库。
const crypto = require('crypto');
const dns = require('dns');
const httpsLib = require('https');
const { db, getSetting, setSetting } = require('../db');

// ---------- 常量（协议参数取自小米官方公开实现，与本仓库其他模块一致走 node 内置 fetch） ----------
const OAUTH2_CLIENT_ID = '2882303761520251711'; // 小米 OAuth2 服务注册的智能家庭应用
const OAUTH2_AUTH_URL = 'https://account.xiaomi.com/oauth2/authorize';
// 回调白名单（2026-09-28 实测）：该 client_id 只放行 homeassistant.local:8123 域名（http/https、任意路径均可），
// 自定义域名/localhost 一律返回 invalid redirect uri。官方 Home Assistant 集成靠局域网 mDNS 解析该域名，
// 本站不在用户局域网内 → 授权后浏览器跳到该地址必然打不开，但 code/state 就在地址栏里，
// 由用户复制地址栏网址回填（POST /mihome/bind/manual）完成绑定。
const OAUTH2_REDIRECT_URI = 'http://homeassistant.local:8123/api/mihome/callback';
const OAUTH_API_HOST = 'ha.api.io.mi.com'; // cn 为裸域名，其他区域 <region>.ha.api.io.mi.com
const SPEC_URL = 'https://miot-spec.org/miot-spec-v2/instance?type=';
const PROFILE_URL = 'https://open.account.xiaomi.com/user/profile';
const REGIONS = { cn: '中国大陆', sg: '新加坡', de: '欧洲', i2: '印度', ru: '俄罗斯', us: '美国' };
const CFG_KEY = 'mihome_config';

// MIoT 状态码 → 中文提示（错误码格式 70xxxyzzz，取末 3 位 zzz 对照官方状态码表）
const MIOT_ERRORS = {
  1: '设备不存在', 2: '服务(service)不存在', 3: '属性(property)不存在或该设备不支持',
  4: '事件(event)不存在', 5: '动作(action)不存在', 6: '没找到设备描述', 8: '无效的属性/动作 ID',
  11: '设备离线', 13: '该属性不可读', 15: '动作执行错误', 23: '该属性不可写（只读）',
  25: '动作参数个数不匹配', 33: '该属性不支持订阅', 34: '动作返回值错误', 35: '动作参数错误',
  36: '设备操作超时（设备无响应）', 43: '属性值超出允许范围', 100: '设备当前状态不支持此操作',
  901: '令牌不存在或过期', 902: '令牌非法', 903: '授权过期', 905: '设备未绑定', 999: '功能未上线',
};
function miotErrorText(code) {
  if (code == null || code === 0) return '';
  const n = Number(code);
  const suffix = Math.abs(n) % 1000;
  return MIOT_ERRORS[suffix] || `米家接口错误码 ${n}`;
}

// ---------- 令牌加密（同 businessSkillService：AES-256-GCM，WORKBENCH_SECRET 派生） ----------
const SECRET = crypto.createHash('sha256')
  .update(process.env.WORKBENCH_SECRET || 'workbench-default-secret-change-me')
  .digest();
function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SECRET, iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  return `v1:${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}
function decrypt(stored) {
  if (!stored) return '';
  if (!stored.startsWith('v1:')) return stored; // 兼容旧明文
  const [, ivHex, tagHex, dataHex] = stored.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', SECRET, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

// ---------- 配置读写（主库 settings，键 mihome_config；令牌仅以密文落盘） ----------
function readCfg() {
  const c = getSetting(db, CFG_KEY, null) || {};
  return {
    region: REGIONS[c.region] ? c.region : 'cn',
    device_id: c.device_id || `ha.${crypto.randomUUID()}`,
    access_token: decrypt(c.access_token_enc || ''),
    refresh_token: decrypt(c.refresh_token_enc || ''),
    expires_at: c.expires_at || null,
    bound_at: c.bound_at || null,
    uid: c.uid || null,
    nickname: c.nickname || null,
  };
}
function writeCfg(patch) {
  const cur = getSetting(db, CFG_KEY, null) || {};
  const next = { ...cur, ...patch };
  if (!next.device_id) next.device_id = `ha.${crypto.randomUUID()}`;
  setSetting(db, CFG_KEY, next);
}
function ensureDeviceKey() {
  // device_id（客户端标识）首次生成后固定，米家侧按它识别同一客户端
  if (!getSetting(db, CFG_KEY, null)) writeCfg({ region: 'cn' });
  return readCfg();
}

// ---------- 绑定会话（内存；state → 元信息，10 分钟有效） ----------
// state 对齐官方 MIoTOauthClient：sha1("d="+device_id)，40 位十六进制、确定性——
// 小米可能把授权时的参数形状记进凭证并在换令牌时深层校验（-8 data type not valid 只在真码出现）。
const bindSessions = new Map();
function newBindSession(region, redirectUri) {
  const cfg = ensureDeviceKey();
  const state = crypto.createHash('sha1').update(`d=${cfg.device_id}`).digest('hex');
  bindSessions.set(state, { region, redirectUri, created: Date.now() });
  if (bindSessions.size > 50) {
    const now = Date.now();
    for (const [k, v] of bindSessions) if (now - v.created > 10 * 60 * 1000) bindSessions.delete(k);
  }
  return state;
}
function takeBindSession(state) {
  const s = bindSessions.get(String(state || ''));
  if (!s) return null;
  if (Date.now() - s.created > 10 * 60 * 1000) { bindSessions.delete(String(state)); return null; }
  return s;
}

// ---------- 小米域名网络通道（2026-09-28，GitHub Issue #64 同款问题） ----------
// get_token 报 -8 "data type not valid" 与参数无关：发起请求的机器若 DNS 把 ha.api.io.mi.com
// 解析到异常线路（污染/劫持/异常节点），请求会落到不认识该接口的后端。对策：小米域名一律经
// 公共 DoH（阿里/腾讯）解析出 IPv4 直连（SNI/Host 仍用域名，证书校验不变），解析缓存 10 分钟；
// DoH 不可用或直连失败时回退系统解析的普通 fetch，保证可用性优先。
const dnsCache = new Map(); // host → { ip, at }
async function dohResolve(host) {
  const hit = dnsCache.get(host);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.ip;
  for (const base of ['https://dns.alidns.com/resolve?name=', 'https://doh.pub/dns-query?name=']) {
    try {
      const r = await fetch(base + encodeURIComponent(host) + '&type=A', {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(4000),
      });
      const j = await r.json().catch(() => null);
      const ip = (j && j.Answer || []).filter((a) => a.type === 1 && /^\d+\.\d+\.\d+\.\d+$/.test(a.data)).map((a) => a.data).pop();
      if (ip) { dnsCache.set(host, { ip, at: Date.now() }); return ip; }
    } catch { /* 试下一个 DoH */ }
  }
  return null;
}

// 小米域名专用 http(s)：DoH 钉定 IPv4 直连；连接层失败回退普通 fetch（系统解析）
async function xiaomiHttp(url, opts = {}) {
  const u = new URL(url);
  const ip = /(^|\.)io\.mi\.com$|(^|\.)xiaomi\.com$/.test(u.hostname) ? await dohResolve(u.hostname) : null;
  if (!ip) return fetch(url, opts);
  try {
    return await new Promise((resolve, reject) => {
      const req = httpsLib.request({
        host: ip, port: 443, servername: u.hostname,
        path: u.pathname + u.search, method: (opts.method || 'GET').toUpperCase(),
        headers: { ...(opts.headers || {}), Host: u.hostname },
        timeout: opts.timeoutMs || 15000,
      }, (r) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => {
          const buf = Buffer.concat(chunks);
          const body = buf.toString('utf8');
          resolve({ status: r.statusCode, ok: r.statusCode >= 200 && r.statusCode < 300, text: async () => body, json: async () => JSON.parse(body), arrayBuffer: async () => buf });
        });
      });
      req.on('timeout', () => req.destroy(new Error('请求超时')));
      req.on('error', reject);
      if (opts.body != null) req.write(opts.body);
      req.end();
    });
  } catch (e) {
    if (e.message === '请求超时' || e.code === 'ECONNREFUSED' || e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT') {
      dnsCache.delete(u.hostname);
      // 回退系统解析；补硬超时（fetch 默认无上限，拉流地址不可达时会吊死到前置代理 502）
      return fetch(url, { ...opts, signal: AbortSignal.timeout(opts.timeoutMs || 15000) });
    }
    throw e;
  }
}

// 诊断（admin 接口）：系统解析 vs DoH 解析、出口 IP、假码探测两种通道的原始响应
async function diagnoseNetwork() {
  const out = { host: OAUTH_API_HOST, at: new Date().toISOString() };
  try { out.system_lookup = await dns.promises.lookup(OAUTH_API_HOST, { all: true }); } catch (e) { out.system_lookup = '失败: ' + e.message; }
  dnsCache.delete(OAUTH_API_HOST);
  out.doh_lookup = await dohResolve(OAUTH_API_HOST);
  try { const r = await fetch('https://myip.ipip.net/', { signal: AbortSignal.timeout(5000) }); out.egress = (await r.text()).trim().slice(0, 150); } catch (e) { out.egress = '查询失败: ' + e.message; }
  const fake = `{"client_id":${OAUTH2_CLIENT_ID},"redirect_uri":${JSON.stringify(OAUTH2_REDIRECT_URI)},"code":"FAKE_${'0'.repeat(30)}","device_id":"ha.diag-probe"}`;
  const probeUrl = `https://${OAUTH_API_HOST}/app/v2/ha/oauth/get_token?data=${encodeURIComponent(fake)}`;
  const hdr = { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'workbench-mihome/1.0.0 client/ha.diag-probe' };
  try { const r = await xiaomiHttp(probeUrl, { headers: hdr, timeoutMs: 15000 }); out.probe_pinned = { status: r.status, body: (await r.text()).slice(0, 200) }; } catch (e) { out.probe_pinned = '失败: ' + e.message; }
  try { const r = await fetch(probeUrl, { headers: hdr, signal: AbortSignal.timeout(15000) }); out.probe_system = { status: r.status, body: (await r.text()).slice(0, 200) }; } catch (e) { out.probe_system = '失败: ' + e.message; }
  return out;
}

// ---------- OAuth2 ----------
function apiHost(region) { return region === 'cn' ? OAUTH_API_HOST : `${region}.${OAUTH_API_HOST}`; }

function buildAuthUrl(cfg, redirectUri, state) {
  // 参数集与顺序对齐官方 MIoTOauthClient.gen_auth_url（含 skip_confirm；官方 urlencode(False)→'False'）
  const params = new URLSearchParams({
    redirect_uri: redirectUri,
    client_id: OAUTH2_CLIENT_ID,
    response_type: 'code',
    device_id: cfg.device_id,
    state,
    skip_confirm: 'False',
  });
  return `${OAUTH2_AUTH_URL}?${params.toString()}`;
}

// get_token：authorization code 或 refresh_token 换 access_token。
// 协议要点（对齐官方 MIoTOauthClient.__get_token_async）：参数序列化成 JSON 放进唯一的
// data= 查询参数（平铺传参小米返回 invalid params）；code 换令牌带 device_id，刷新不带；
// 刷新时 redirect_uri 必须与原授权一致。
// 注意：client_id 是 19 位大整数，超出 JS Number 安全整数范围（会丢精度 → invalid client），
// 故手拼 JSON、以原始数字字面量写入。
async function getToken(params) {
  const json = params.code
    ? `{"client_id":${OAUTH2_CLIENT_ID},"redirect_uri":${JSON.stringify(params.redirect_uri)},"code":${JSON.stringify(params.code)},"device_id":${JSON.stringify(params.device_id)}}`
    : `{"client_id":${OAUTH2_CLIENT_ID},"redirect_uri":${JSON.stringify(params.redirect_uri)},"refresh_token":${JSON.stringify(params.refresh_token)}}`;
  const url = `https://${apiHost(params.region)}/app/v2/ha/oauth/get_token?data=${encodeURIComponent(json)}`;
  const res = await xiaomiHttp(url, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // UA 对齐官方 MIoTOauthClient：ha_xiaomi_home/<版本> <系统信息> client/<device_id>
      'User-Agent': `ha_xiaomi_home/v1.2.0 Linux client/${params.device_id || 'ha.workbench'}`,
    },
    timeoutMs: 15000,
  });
  const body = await res.json().catch(() => ({}));
  const t = body.result || body;
  if (!res.ok || !t.access_token) {
    // -8 data type not valid（2026-09-28 实测定性）：小米对换令牌调用方出口 IP 的风控拒绝，
    // 与参数无关（同参数在用户家宽出口成功）；提示走用户侧换取 + 令牌注入通道。
    if (body.code === -8) {
      throw new Error(`换取访问令牌失败（服务器出口 IP 被小米风控拒绝；可在用户侧网络完成授权换取后，用令牌注入接口写入）`);
    }
    throw new Error(`换取访问令牌失败（HTTP ${res.status}${body.code != null ? ' code ' + body.code : ''} ${body.message || JSON.stringify(body).slice(0, 200)}）`);
  }
  return t; // {access_token, refresh_token, expires_in}
}

// 令牌直灌（网络受限环境的例外通道）：授权码换令牌若因服务器出口 IP 被小米风控拒绝，
// 在用户侧网络完成换取后，把令牌经本接口写入（AES-GCM 加密落库，绝不明文出库/出接口）。
async function completeBindTokens(t) {
  const access = String((t && t.access_token) || '');
  const refresh = String((t && t.refresh_token) || '');
  if (access.length < 30 || access.length > 600) throw new Error('access_token 格式不正确');
  if (refresh && (refresh.length < 30 || refresh.length > 600)) throw new Error('refresh_token 格式不正确');
  const region = REGIONS[t.region] ? t.region : 'cn';
  writeCfg({
    region,
    access_token_enc: encrypt(access),
    refresh_token_enc: encrypt(refresh),
    expires_at: new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000).toISOString(),
    bound_at: new Date().toISOString(),
  });
  // 昵称尽力而为（失败不影响绑定）
  try {
    const p = await fetchProfile(region, access);
    if (p && p.miliaoNick) writeCfg({ nickname: p.miliaoNick });
  } catch { /* 忽略 */ }
  return status();
}

// 手动回填：解析用户粘贴的授权回跳网址（homeassistant.local 打不开，但 code/state 在地址栏里）
function parseCallbackUrl(url) {
  const s = String(url || '').trim();
  if (!s) throw new Error('请粘贴授权后浏览器地址栏的完整网址');
  if (s.length > 1000) throw new Error('网址过长，请确认复制的是浏览器地址栏内容');
  const qs = s.includes('?') ? s.slice(s.indexOf('?') + 1) : s; // 兼容只粘贴查询串的情况
  const params = new URLSearchParams(qs);
  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) {
    throw new Error('网址里没有 code/state 参数：请复制授权后浏览器地址栏的完整网址（以 http://homeassistant.local 开头、带 ?code=…&state=…）');
  }
  if (code.length > 200 || state.length > 100) throw new Error('网址格式不正确');
  return { code, state };
}

// 授权回调落库（回调免登录，只认 state 会话 + 一次性 code）
async function completeBind(code, state) {
  const s = takeBindSession(state);
  if (!s) throw new Error('授权会话不存在或已过期，请回到工作台重新生成二维码');
  const cfg = ensureDeviceKey();
  const t = await getToken({ region: s.region, device_id: cfg.device_id, redirect_uri: s.redirect_uri, code: String(code) });
  writeCfg({
    region: s.region,
    access_token_enc: encrypt(t.access_token),
    refresh_token_enc: encrypt(t.refresh_token || ''),
    expires_at: new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000).toISOString(),
    bound_at: new Date().toISOString(),
    uid: null, nickname: null,
  });
  bindSessions.delete(String(state));
  // 昵称尽力而为（失败不影响绑定）
  try {
    const p = await fetchProfile(s.region, t.access_token);
    if (p && p.miliaoNick) writeCfg({ nickname: p.miliaoNick });
  } catch { /* 忽略 */ }
  return { ok: true };
}

async function fetchProfile(region, accessToken) {
  const qs = new URLSearchParams({ clientId: OAUTH2_CLIENT_ID, token: accessToken });
  const res = await xiaomiHttp(`${PROFILE_URL}?${qs.toString()}`, {
    headers: { 'User-Agent': `workbench-mihome/1.0.0 client/${readCfg().device_id}` },
    timeoutMs: 10000,
  });
  const body = await res.json().catch(() => ({}));
  if (body.code !== 0 || !body.data) throw new Error('获取小米账号信息失败');
  return body.data;
}

function unbind() {
  writeCfg({ access_token_enc: '', refresh_token_enc: '', expires_at: null, bound_at: null, uid: null, nickname: null });
  homeViewCache = { at: 0, data: null }; // 清设备缓存，避免换账号显示旧设备
  setSetting(db, VIEW_CACHE_KEY, null);
}

// ---------- 米家云 API（Bearer 令牌；401 自动刷新重试一次，再失败则解绑并提示重新扫码） ----------
async function rawApi(path, data, cfg) {
  const { status, body } = await rawApiDebug(path, data, cfg);
  if (status === 401) { const e = new Error('unauthorized'); e.status = 401; throw e; }
  if (status >= 400) throw new Error(`米家云接口异常（HTTP ${status}）`);
  if (body.code !== 0) throw new Error(`米家云接口错误 ${body.code}：${body.message || miotErrorText(body.code) || '未知错误'}`);
  return body.result;
}
// 原样返回 {status, body}，不校验不抛错（诊断 prop/set「设备不存在」误报用，v1.6.21 临时）
async function rawApiDebug(path, data, cfg) {
  const c = cfg || readCfg();
  const res = await xiaomiHttp(`https://${apiHost(c.region)}${path}`, {
    method: 'POST',
    headers: {
      'X-Client-BizId': 'haapi',
      'Content-Type': 'application/json',
      'Authorization': `Bearer${c.access_token}`, // 通道要求：Bearer 与令牌之间无空格
      'X-Client-AppId': OAUTH2_CLIENT_ID,
      'User-Agent': `ha_xiaomi_home/v1.2.0 Linux client/${c.device_id}`,
    },
    body: JSON.stringify(data),
    timeoutMs: 20000,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function tryRefresh() {
  const c = readCfg();
  if (!c.refresh_token) throw new Error('米家授权已失效，请重新扫码绑定');
  const t = await getToken({
    region: c.region, device_id: c.device_id,
    redirect_uri: OAUTH2_REDIRECT_URI, // 刷新时 redirect_uri 必须与原授权一致
    refresh_token: c.refresh_token,
  });
  writeCfg({
    access_token_enc: encrypt(t.access_token),
    refresh_token_enc: encrypt(t.refresh_token || ''),
    expires_at: new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000).toISOString(),
  });
}

// 主动续期（admin 接口）：提前验证续期链路；失败不清令牌
async function forceRefresh() {
  const c = readCfg();
  if (!c.refresh_token) throw new Error('无续期令牌，请重新完成绑定');
  await tryRefresh();
  return status();
}

async function api(path, data) {
  const c = readCfg();
  if (!c.access_token) throw new Error('尚未绑定小米账号，请先在「智能家居 → 设置」扫码绑定');
  try {
    return await rawApi(path, data, c);
  } catch (e) {
    if (e.status === 401) {
      try {
        await tryRefresh();
        return await rawApi(path, data);
      } catch {
        // 刷新失败不清令牌（可能只是出口 IP 受限，令牌仍有价值；彻底失效可手动解绑）
        throw new Error('米家授权续期失败，请到「智能家居 → 设置」重新完成绑定');
      }
    }
    throw e;
  }
}

// ---------- 家庭/设备 ----------
function parseHomes(list) {
  return (list || []).filter((h) => h && h.id != null && h.name != null).map((h) => ({
    id: String(h.id),
    name: String(h.name),
    uid: h.uid != null ? String(h.uid) : null,
    dids: (h.dids || []).map(String),
    rooms: (h.roomlist || []).filter((r) => r && r.id != null).map((r) => ({
      id: String(r.id), name: String(r.name || '未命名房间'), dids: (r.dids || []).map(String),
    })),
  }));
}

async function getHomeinfos() {
  let result = await api('/app/v2/homeroom/gethome', {
    limit: 150, fetch_share: true, fetch_share_dev: true, plat_form: 0, app_ver: 9,
  });
  let homes = parseHomes([...(result.homelist || []), ...(result.share_homelist || result.share_home_list || [])]);
  while (result.has_more && result.max_id) { // 家庭过多时翻页补齐
    result = await api('/app/v2/homeroom/get_dev_room_page', { limit: 150, max_id: String(result.max_id) });
    homes = homes.concat(parseHomes(result.homelist || []));
  }
  const uid = homes.find((h) => h.uid)?.uid || null;
  if (uid && readCfg().uid !== uid) writeCfg({ uid });
  return { homes, uid };
}

async function getDeviceInfos(dids) {
  const out = {};
  for (let i = 0; i < dids.length; i += 150) {
    const chunk = dids.slice(i, i + 150);
    let startDid = null;
    do {
      const data = { limit: 200, get_split_device: true, get_third_device: true, dids: chunk };
      if (startDid) data.start_did = startDid;
      const result = await api('/app/v2/home/device_list_page', data);
      for (const d of result.list || []) {
        if (d.did == null || !d.name) continue;
        out[String(d.did)] = {
          did: String(d.did),
          name: d.name,
          model: d.model || '',
          urn: d.spec_type || d.urn || '',
          online: !!d.isOnline,
          version: (d.extra && d.extra.fw_version) || '',
        };
      }
      startDid = result.has_more ? result.next_start_did : null;
    } while (startDid);
  }
  return out;
}

// 属性读：[{did,siid,piid}] 分批 50（datasource=1 走云端转发，离线/蓝牙设备也能读缓存值）
async function getProps(params) {
  const out = [];
  for (let i = 0; i < params.length; i += 50) {
    const r = await api('/app/v2/miotspec/prop/get', {
      datasource: 1,
      params: params.slice(i, i + 50).map((p) => ({ ...p, did: numDid(canonDid(p.did)) })),
    });
    out.push(...(r || []));
  }
  return out;
}
// did 上游要求数字类型：传字符串时 prop/set 命令仍会下发执行，但响应项报 code 1「设备不存在」，
// 造成「实际控制成功却提示失败、界面回退后同值重复下发」（2026-09-29 实测：set 后 get 值已变、响应 code=1）→ 统一转 Number。
function numDid(did) {
  return /^\d{1,20}$/.test(String(did)) ? Number(String(did)) : did;
}
// 分路(split)设备 did 归一化（v1.6.24）：多路开关在云端以「父did.sN」形式出现（device_list_page
// extra.split={parentId,moduleId}，pid=21），miotspec 通道不认该 did（读一律 -704083036 超时、
// 写信封成功但不执行，2026-09-29 实测）。实测 moduleId 即父设备的 siid（tofan-pxln4 模块 2-5 ↔
// 父 siid 2-5，set 父 siid5 → 值变+updateTime 跳变验证），分路 spec 又与父相同（卡片/详情页的
// siid 本来就是父作用域）→ 一律剥掉 .sN 后缀、按父 did + 原 siid 寻址。
function canonDid(did) {
  return String(did || '').replace(/\.s\d{1,4}$/, '');
}
function setProp(did, siid, piid, value) {
  return api('/app/v2/miotspec/prop/set', { params: [{ did: numDid(canonDid(did)), siid, piid, value }] });
}
function callAction(did, siid, aiid, inList) {
  return api('/app/v2/miotspec/action', { params: { did: numDid(canonDid(did)), siid, aiid, in: inList || [] } });
}

// ---------- MIoT-Spec 设备能力描述（miot-spec.org 公开；按 urn 缓存 24h） ----------
const specCache = new Map(); // urn → {spec, at}
async function getSpec(urn) {
  const hit = specCache.get(urn);
  if (hit && Date.now() - hit.at < 24 * 3600 * 1000) return hit.spec;
  const res = await fetch(SPEC_URL + encodeURIComponent(urn), { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`获取设备能力描述失败（HTTP ${res.status}）`);
  const inst = await res.json();
  if (!inst || !Array.isArray(inst.services)) throw new Error('设备能力描述格式异常');
  const spec = normalizeSpec(inst);
  specCache.set(urn, { spec, at: Date.now() });
  return spec;
}

function shortName(typeUrn) { return String(typeUrn || '').split(':')[3] || ''; }

function normalizeProp(p) {
  return {
    piid: p.iid,
    name: shortName(p.type),
    description: p.description || '',
    format: p.format || 'string',
    access: p.access || [],
    unit: p.unit || '',
    min: Array.isArray(p['value-range']) ? p['value-range'][0] : null,
    max: Array.isArray(p['value-range']) ? p['value-range'][1] : null,
    step: Array.isArray(p['value-range']) ? p['value-range'][2] : null,
    valueList: Array.isArray(p['value-list']) ? p['value-list'].map((v) => ({ value: v.value, description: v.description })) : null,
  };
}
function normalizeSpec(inst) {
  return {
    type: inst.type,
    description: inst.description || '',
    services: (inst.services || []).map((sv) => ({
      siid: sv.iid,
      name: shortName(sv.type),
      description: sv.description || '',
      properties: (sv.properties || []).map(normalizeProp),
      events: (sv.events || []).map((ev) => ({
        eiid: ev.iid, name: shortName(ev.type), description: ev.description || '',
        args: (ev.arguments || []).map(normalizeProp),
      })),
      actions: (sv.actions || []).map((ac) => ({
        aiid: ac.iid, name: shortName(ac.type), description: ac.description || '',
        in: (ac.in || []).map(normalizeProp),
        out: (ac.out || []).map(normalizeProp),
      })),
    })),
  };
}

// 开关能力判定：优先 switch 服务的 on 属性；其次任一可写 bool 属性（如灯的 brightness 前的 power）
function detectSwitch(spec) {
  if (!spec) return null;
  const svSwitch = spec.services.find((s) => s.name === 'switch');
  if (svSwitch) {
    const on = svSwitch.properties.find((p) => p.format === 'bool' && p.access.includes('write') && p.name === 'on')
      || svSwitch.properties.find((p) => p.format === 'bool' && p.access.includes('write'));
    if (on) return { siid: svSwitch.siid, piid: on.piid };
  }
  for (const sv of spec.services) {
    const p = sv.properties.find((x) => x.format === 'bool' && x.access.includes('write'));
    if (p) return { siid: sv.siid, piid: p.piid };
  }
  return null;
}

// 分路设备（父did.sN）的开关点（v1.6.26 修复）：detectSwitch 对分路一律返回第一个 switch 服务
// （siid2）→ 所有分路卡片都控制第一回路（用户实测：大客厅分路全打开同一盏灯）。分路的控制点
// 应为 siid=N（moduleId 即父 siid，2026-09-29 已实验定案），piid 取该 siid 服务下第一个可写
// bool 属性（同父模板结构，通常 piid1）；该 siid 无可写 bool 则不挂开关。
function splitSwitchPoint(spec, did) {
  const m = /\.s(\d{1,4})$/.exec(String(did));
  if (!m || !spec) return null;
  const sv = spec.services.find((s) => s.siid === Number(m[1]));
  const on = sv && sv.properties.find((p) => p.format === 'bool' && (p.access || []).includes('write'));
  return on ? { siid: sv.siid, piid: on.piid } : null;
}

// 环境量判定（温湿度计卡片直显，v1.6.21）：temperature / relative-humidity 属性位置
function detectEnv(spec) {
  if (!spec) return null;
  const out = {};
  for (const sv of spec.services) {
    for (const p of sv.properties) {
      if (!out.t && (p.name === 'temperature' || p.name === 'indoor-temperature')) out.t = { siid: sv.siid, piid: p.piid };
      if (!out.h && (p.name === 'relative-humidity' || p.name === 'humidity')) out.h = { siid: sv.siid, piid: p.piid };
    }
  }
  return out.t || out.h ? out : null;
}
// 仅温湿度/温度/湿度类传感器与空气净化器/空气检测仪/浴霸启用卡片直显
// （v1.6.24 增 zhimi.airpurifier.v6；v1.6.25 增浴霸——用户家 xiaomi.bhf_light.s1 为
// device:bath-heater，环境温度在 environment 服务 temperature 属性；其他品牌设备类型
// ptc-bath-heater 一并覆盖；网关/摄像头等也带 temperature 属性，避免误挂）
function isEnvSensor(urn) {
  return /device:[a-z-]*(temperature|humidity)[a-z-]*sensor/.test(urn || '')
    || /device:air-(purifier|monitor)/.test(urn || '')
    || /device:(ptc-)?bath-heater/.test(urn || '');
}

// ---------- 汇总视图（家庭 → 房间 → 设备卡片，含开关状态） ----------
// 持久缓存（settings 表）：命中立即返回（页面秒开，不再每次都拉云端）；
// 缓存超过 5 分钟在后台静默更新（下次进入即为新数据）；「刷新」按钮 fresh=1 强制拉云端并落库。
let homeViewCache = { at: 0, data: null };
let deviceUrnIndex = new Map(); // did → urn（详情页按 did 取 spec 用）
let bgRefreshing = false;
const VIEW_CACHE_KEY = 'mihome_homeview_cache';

async function getHomeView(fresh) {
  if (!homeViewCache.data) { // 进程重启后从持久缓存恢复
    const saved = getSetting(db, VIEW_CACHE_KEY, null);
    if (saved && saved.data) {
      homeViewCache = { at: saved.at || 0, data: saved.data };
      rebuildUrnIndex(saved.data);
    }
  }
  if (!fresh && homeViewCache.data) {
    const ttlMin = Number(getPrefs().cache_ttl_min) || 60; // v1.6.16：后台静默更新间隔可配（设置页，默认 60 分钟）
    if (Date.now() - homeViewCache.at > ttlMin * 60 * 1000 && !bgRefreshing) {
      bgRefreshing = true;
      buildHomeView().catch(() => { /* 后台更新失败静默，仍用旧缓存 */ })
        .finally(() => { bgRefreshing = false; });
    }
    return homeViewCache.data;
  }
  return buildHomeView();
}

function rebuildUrnIndex(view) {
  const m = new Map();
  for (const h of (view.homes || [])) for (const r of h.rooms) for (const d of r.devices) if (d.urn) m.set(d.did, d.urn);
  deviceUrnIndex = m;
}

// 本页写入开关成功后同步缓存值（避免下次进入显示旧状态）。
// 分路设备与父设备同一 siid 指同一物理回路（v1.6.24）：按 canonDid 匹配，父卡与分路卡一起同步。
function updateCachedSwitchValue(did, siid, piid, value) {
  const view = homeViewCache.data;
  if (!view) return;
  const cd = canonDid(did);
  let hit = false;
  for (const h of view.homes || []) for (const r of h.rooms) for (const d of r.devices) {
    if (canonDid(d.did) === cd && d.switch && d.switch.siid === siid && d.switch.piid === piid) { d.switch.value = value; hit = true; }
  }
  if (hit) setSetting(db, VIEW_CACHE_KEY, { at: homeViewCache.at, data: view });
}

async function buildHomeView() {
  const { homes, uid } = await getHomeinfos();
  const allDids = [...new Set(homes.flatMap((h) => h.dids.concat(h.rooms.flatMap((r) => r.dids))))].filter((d) => !d.startsWith('miwifi.'));
  const infos = await getDeviceInfos(allDids);

  // 规格并发加载（限流 6 路）
  const urns = [...new Set(Object.values(infos).map((d) => d.urn).filter(Boolean))];
  const specMap = new Map();
  for (let i = 0; i < urns.length; i += 6) {
    await Promise.all(urns.slice(i, i + 6).map(async (u) => {
      try { specMap.set(u, await getSpec(u)); } catch { specMap.set(u, null); }
    }));
  }

  // 批量读开关当前值（失败不阻塞列表展示）。分路(.sN)按父 did 读同 siid（v1.6.24）；
  // 分路的开关点用 splitSwitchPoint（siid=分路号，v1.6.26 修复「分路卡全控制第一回路」）
  const switchParams = [];
  const pending = new Map(); // did → {siid,piid}
  for (const [did, d] of Object.entries(infos)) {
    const spec = specMap.get(d.urn);
    let sw = detectSwitch(spec);
    if (/\.s\d{1,4}$/.test(did)) sw = splitSwitchPoint(spec, did); // 分路：siid=moduleId（覆盖 detectSwitch 的固定 siid2）
    if (sw) { switchParams.push({ did: canonDid(did), siid: sw.siid, piid: sw.piid }); pending.set(did, sw); }
  }
  const values = new Map(); // 'canonDid@siid' → value（父与分路共用同一次读取）
  try {
    const rs = await getProps(switchParams);
    for (const r of rs || []) {
      if (r.did == null) continue;
      values.set(`${canonDid(r.did)}@${r.siid}`, r.value);
    }
  } catch { /* 忽略：开关状态查询失败时卡片显示为未知 */ }

  // 批量读温湿度（传感器/空气净化器卡片直显，v1.6.21/24；失败不阻塞）
  const envPending = new Map(); // did → {t:{siid,piid}, h:{siid,piid}}
  const envParams = [];
  for (const [did, d] of Object.entries(infos)) {
    if (!isEnvSensor(d.urn)) continue;
    const env = detectEnv(specMap.get(d.urn));
    if (!env) continue;
    envPending.set(did, env);
    if (env.t) envParams.push({ did: canonDid(did), siid: env.t.siid, piid: env.t.piid });
    if (env.h) envParams.push({ did: canonDid(did), siid: env.h.siid, piid: env.h.piid });
  }
  const envValues = new Map(); // 'canonDid.t' / 'canonDid.h' → value
  try {
    const rs = await getProps(envParams);
    for (const r of rs || []) {
      if (r.did == null) continue;
      const env = envPending.get(String(r.did)) || envPending.get(canonDid(r.did));
      if (!env) continue;
      if (env.t && r.siid === env.t.siid && r.piid === env.t.piid) envValues.set(canonDid(r.did) + '.t', r.value);
      if (env.h && r.siid === env.h.siid && r.piid === env.h.piid) envValues.set(canonDid(r.did) + '.h', r.value);
    }
  } catch { /* 忽略 */ }

  // 分路父设备（v1.6.25）：did 被「父did.sN」分路引用的设备 → 前端卡片标注「父设备」且不显示外层开关
  //（各分路有自己的卡片；父卡点开进详情页可控制全部回路）
  const parentSet = new Set(allDids.filter((x) => /\.s\d{1,4}$/.test(x)).map((x) => canonDid(x)));

  const newIndex = new Map();
  const view = {
    uid, generated_at: new Date().toISOString(),
    homes: homes.map((h) => {
      const used = new Set();
      const rooms = h.rooms.map((r) => {
        r.dids.forEach((d) => used.add(d));
        return { id: r.id, name: r.name, devices: r.dids.map((d) => infos[d]).filter(Boolean) };
      });
      const loose = h.dids.filter((d) => !used.has(d)).map((d) => infos[d]).filter(Boolean);
      if (loose.length) rooms.push({ id: '__none', name: '未分区', devices: loose });
      for (const r of rooms) for (const d of r.devices) {
        d.is_parent = parentSet.has(d.did); // 有分路的父设备（卡片标注+外层不挂开关）
        const sw = pending.get(d.did) || null;
        const vk = canonDid(d.did) + '@' + (sw ? sw.siid : '');
        d.switch = sw ? { siid: sw.siid, piid: sw.piid, value: values.has(vk) ? values.get(vk) : null } : null;
        const env = envPending.get(d.did) || null;
        const ek = canonDid(d.did);
        d.env = env ? {
          t: env.t ? { siid: env.t.siid, piid: env.t.piid, value: envValues.has(ek + '.t') ? envValues.get(ek + '.t') : null } : null,
          h: env.h ? { siid: env.h.siid, piid: env.h.piid, value: envValues.has(ek + '.h') ? envValues.get(ek + '.h') : null } : null,
        } : null;
        if (d.urn) newIndex.set(d.did, d.urn);
      }
      return { id: h.id, name: h.name, rooms: rooms.filter((r) => r.devices.length) };
    }),
  };
  deviceUrnIndex = newIndex;
  homeViewCache = { at: Date.now(), data: view };
  setSetting(db, VIEW_CACHE_KEY, { at: homeViewCache.at, data: view }); // 持久化，重启不丢
  return view;
}

// 按 did 取能力描述：先确保设备列表已加载（有缓存），再查 did→urn 索引
async function getSpecByDid(did) {
  const d = String(did || '');
  if (!deviceUrnIndex.get(d)) await getHomeView(false); // 冷启动首查：拉一次列表建索引（10s 缓存内零成本）
  const urn = deviceUrnIndex.get(d);
  if (!urn) throw new Error('未找到该设备（可能已离线被移除），请刷新设备列表');
  return getSpec(urn);
}

// ---------- 摄像头直播（HLS 云端转码 + 本站代理，v1.6.16） ----------
// 实测（2026-09-28，生产 5 台摄像头）：带 camera-stream-for-google-home 服务的小米摄像头可经
// 云端转码出 HLS 直播流（start-hls-stream 动作 out[0] 即 m3u8 地址）；该地址绑定「创建会话的出口
// IP」（异网拉取 404）→ 浏览器直连不可行，由本服务代理拉流转发。alexa 服务的 image-snapshot
// 实测返回全账号统一的占位图（md5=文件名哈希），快照方案弃用；RTSP 地址仅作 VLC 备用透传。
const camSessions = new Map(); // did → { hlsUrl, rtspUrl, ok, err, at }
const camSignKey = crypto.createHash('sha256').update(SECRET).update('camhls').digest(); // 签名密钥自令牌密钥派生

function camSign(did, hours) {
  const exp = Date.now() + (hours || 12) * 3600 * 1000;
  const sig = crypto.createHmac('sha256', camSignKey).update(String(did) + '.' + exp).digest('hex').slice(0, 24);
  return { exp, sig };
}
function camVerify(did, exp, sig) {
  const e = Number(exp);
  return Number.isFinite(e) && e > Date.now() && /^[0-9a-f]{24}$/.test(String(sig || ''))
    && crypto.createHmac('sha256', camSignKey).update(String(did) + '.' + e).digest('hex').slice(0, 24) === sig;
}

// 开流（force=1 跳过 4 分钟会话缓存）：调 start-hls-stream 取转码地址，并在服务器侧探测就绪状态
async function startCameraLive(did, force) {
  const key = String(did);
  const hit = camSessions.get(key);
  if (!force && hit && hit.hlsUrl && Date.now() - hit.at < 4 * 60 * 1000) return hit;
  const spec = await getSpecByDid(key);
  let hlsUrl = '', rtspUrl = '', err = '';
  const svG = spec.services.find((s) => s.name === 'camera-stream-for-google-home');
  const svA = spec.services.find((s) => s.name === 'camera-stream-for-amazon-alexa');
  if (!svG && !svA) {
    err = '该设备型号未开放云端画面（仅部分小米摄像头支持）';
  } else {
    if (svG) {
      const act = (svG.actions || []).find((a) => a.name === 'start-hls-stream');
      if (!act) err = '该设备不支持 HLS 拉流';
      else {
        try {
          const r = await callAction(key, svG.siid, act.aiid, [1]);
          const out = (r && r.out) || [];
          if (r && r.code === 0 && typeof out[0] === 'string' && out[0].includes('.m3u8')) hlsUrl = out[0];
          else err = miotErrorText(r && r.code) || '取流失败';
        } catch (e) { err = e.message; }
      }
    }
    if (svA) { // RTSP 备用（浏览器播不了，给 VLC 用户复制用），失败不影响
      const act = (svA.actions || []).find((a) => a.name === 'start-rtsp-stream');
      if (act) { try { const r = await callAction(key, svA.siid, act.aiid, [1]); if (r && r.code === 0) rtspUrl = ((r.out || [])[0]) || ''; } catch { /* 忽略 */ } }
    }
  }
  // 服务器侧探测：转码器启动有几秒延迟，最多试 3 次（间隔 3s）
  let ok = false, probe = 0;
  if (hlsUrl) {
    for (let i = 0; i < 3 && !ok; i++) {
      if (i) await new Promise((r) => setTimeout(r, 3000));
      try { const p = await xiaomiHttp(hlsUrl, { timeoutMs: 5000 }); probe = p.status; if (p.ok) { await p.text(); ok = true; } } catch { probe = 0; }
    }
    if (!ok && !err) err = `云端转码未就绪（探测 HTTP ${probe}）`;
  }
  const sess = { hlsUrl, rtspUrl, ok, err, at: Date.now() };
  camSessions.set(key, sess);
  return sess;
}

// 拉播放列表（代理用；自动复用/新建会话）
async function fetchCamPlaylist(did) {
  const sess = await startCameraLive(did, false);
  if (!sess.hlsUrl) throw new Error(sess.err || '无可用流地址');
  const r = await xiaomiHttp(sess.hlsUrl, { timeoutMs: 8000 });
  if (!r.ok) throw new Error(`云端转码未就绪（HTTP ${r.status}），请稍后重试`);
  return { sess, body: await r.text() };
}
// 拉视频分片（代理用；仅放行小米流媒体域名，防 SSRF）
async function fetchCamSegment(url) {
  if (!/^https:\/\/[a-z0-9.-]+\.io\.mi\.com\//.test(String(url))) throw new Error('上游地址非法');
  const r = await xiaomiHttp(String(url), { timeoutMs: 15000 });
  if (!r.ok) throw new Error(`分片拉取失败（HTTP ${r.status}）`);
  return Buffer.from(await r.arrayBuffer());
}

// ---------- 摄像头条目原始字段探测（诊断：找 device_list_page 里是否带云端截图/缩略图 URL） ----------
// 背景：米家 App 首页摄像头卡片有缩略图，若该图来自本 OAuth 通道可见的接口（device_list_page 原始条目），
// 即可免密实现「最近画面」卡片。输出一律脱敏（token/secret/key 类字段不回显），字符串截断防日志膨胀。
function debugScrub(v, depth) {
  if (depth > 6) return '[层级过深]';
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => debugScrub(x, depth + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) o[k] = /token|secret|pass|key|credential/i.test(k) ? '[已脱敏]' : debugScrub(val, depth + 1);
    return o;
  }
  if (typeof v === 'string') return v.length > 600 ? v.slice(0, 600) + '…' : v;
  return v;
}
async function debugCameraRaw() {
  const view = await getHomeView(false);
  const camDids = [];
  for (const h of view.homes) for (const r of h.rooms) for (const d of r.devices) {
    if (/^urn:miot-spec-v2:device:camera:/.test(d.urn || '')) camDids.push(d.did);
  }
  const out = { at: new Date().toISOString(), count: camDids.length, dids: camDids, entries: [] };
  for (let i = 0; i < camDids.length; i += 10) {
    const r = await api('/app/v2/home/device_list_page', {
      limit: 200, get_split_device: true, get_third_device: true, dids: camDids.slice(i, i + 10),
    });
    for (const d of (r && r.list) || []) out.entries.push(debugScrub(d, 0));
  }
  return out;
}

function status() {
  const c = readCfg();
  return {
    bound: !!c.access_token,
    region: c.region,
    regions: REGIONS,
    uid: c.uid,
    nickname: c.nickname,
    bound_at: c.bound_at,
    expires_at: c.expires_at,
  };
}

// ---------- 偏好（默认家庭等；settings 表键 mihome_prefs） ----------
function getPrefs() { return getSetting(db, 'mihome_prefs', {}) || {}; }
function setPrefs(patch) { setSetting(db, 'mihome_prefs', { ...getPrefs(), ...patch }); return getPrefs(); }

module.exports = {
  REGIONS, OAUTH2_REDIRECT_URI, ensureDeviceKey, buildAuthUrl, newBindSession,
  completeBind, completeBindTokens, parseCallbackUrl, unbind, status, diagnoseNetwork, forceRefresh,
  getHomeView, getProps, setProp, callAction, getSpec, getSpecByDid, miotErrorText, getPrefs, setPrefs,
  updateCachedSwitchValue,
  startCameraLive, camSign, camVerify, fetchCamPlaylist, fetchCamSegment, debugCameraRaw, rawApiDebug,
  _internals: { readCfg, writeCfg, getToken, apiHost, normalizeSpec, detectSwitch, parseHomes, xiaomiHttp, dohResolve, canonDid, isEnvSensor, splitSwitchPoint },
};
