// 小米账号密码登录（serviceLogin 三步 + 验证码 + 短信/邮件安全验证）→ 摄像头事件凭证（v1.6.20）
//
// 定位：「摄像头二次验证」tab 的服务端。用户拍板「密码不存生产」：本模块只应在【本地实例】上被
// 调用（前端在生产站点隐藏表单并引导到 localhost），密码只在单次请求内存中换凭证，
// 绝不落盘、绝不写日志；换到的 {userId, serviceToken, ssecurity} 仅存内存会话（30 分钟），
// 由 /micam/inject-target 注入目标工作台后即弃。
//
// 协议蓝本：micloud 包（MIT, Sammy Svensson）+ hass-xiaomi-miot xiaomi_cloud.py（MIT，verify_ticket 流程）。
// 短信/邮件验证：登录触发 need_verify 时，用 verify_url 换 identity_session（GET identity/list），
// POST /identity/auth/verifyPhone|verifyEmail（body 带 ticket=验证码）→ {code:0, location} → 跟随拿
// serviceToken → 再跑一次 step1 补 ssecurity。验证码是用户在自己手机/浏览器完成验证后收到的。
const crypto = require('crypto');

const ACCOUNT_BASE = 'https://account.xiaomi.com';
const CREDS_TTL = 30 * 60 * 1000;   // 登录会话（内存凭证）有效期
const VERIFY_TTL = 15 * 60 * 1000;  // 待安全验证状态有效期

// 单会话模型（本地实例单管理员，足够）；进程重启即清空
const session = {
  jar: new Map(),                                            // 账号体系 cookie（deviceId/passToken/identity_session…）
  agentId: Array.from({ length: 13 }, () => 'ABCDEF'[Math.floor(Math.random() * 6)]).join(''),
  creds: null,                                               // { userId, serviceToken, ssecurity }
  credsAt: 0,
  captcha: { ick: '' },
  pendingVerify: null,                                       // { url, at }
};

const UA = `Android-7.1.1-1.0.0-ONEPLUS A3010-136-${session.agentId} APP/xiaomi.smarthome APPV/62830`;

// ---------- 极简 cookie jar + 手动跟随重定向（serviceToken 在中途某一跳的 Set-Cookie 上） ----------
function cookieHeader() {
  return [...session.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
function absorbCookies(res) {
  for (const line of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) session.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
async function req(url, opts = {}) {
  let u = url;
  for (let hop = 0; hop < 8; hop++) {
    const res = await fetch(u, {
      ...opts, redirect: 'manual', signal: opts.signal || AbortSignal.timeout(20000),
      headers: { 'User-Agent': UA, ...(session.jar.size ? { Cookie: cookieHeader() } : {}), ...(opts.headers || {}) },
    });
    absorbCookies(res);
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) return res;
      u = new URL(loc, u).href;
      continue;
    }
    return res;
  }
  throw new Error('小米服务重定向次数过多');
}

// ---------- 登录三步（sid=xiaomiio） ----------
function parseJson(text) {
  try { return JSON.parse(String(text).replace('&&&START&&&', '')); } catch { return null; }
}
async function loginStep1() {
  session.jar.set('sdkVersion', '3.8.6');
  session.jar.set('deviceId', session.agentId);
  const res = await req(`${ACCOUNT_BASE}/pass/serviceLogin?sid=xiaomiio&_json=true`);
  return parseJson(await res.text()) || {};
}
async function loginStep2(user, pass, captcha, qs, sign) {
  const body = new URLSearchParams({
    user,
    hash: crypto.createHash('md5').update(pass, 'utf8').digest('hex').toUpperCase(),
    callback: '',
    sid: 'xiaomiio',
    qs: qs || '',
    _sign: sign || '',
  });
  const query = { _json: 'true' };
  if (captcha) {
    body.set('captCode', captcha);
    query._dc = String(Date.now());
    if (session.captcha.ick) session.jar.set('ick', session.captcha.ick);
  }
  const res = await req(`${ACCOUNT_BASE}/pass/serviceLoginAuth2?${new URLSearchParams(query)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  return parseJson(await res.text()) || {};
}
async function loginStep3(location) {
  const res = await req(location);
  await res.text().catch(() => '');
  if (!session.jar.has('serviceToken')) throw new Error('登录成功但未取到 serviceToken（账号可能需要在 App 侧确认）');
}
function setCreds(s2) {
  session.creds = {
    userId: String(s2.userId || session.jar.get('userId') || ''),
    serviceToken: session.jar.get('serviceToken'),
    ssecurity: s2.ssecurity,
  };
  session.credsAt = Date.now();
}

// 完整登录：返回 {ok} / {need_captcha, img, hint} / {need_verify, url} / {error}
async function doLogin(user, pass, captcha) {
  const s1 = await loginStep1();
  if (!s1.qs && s1.code === 0 && s1.location) { // 会话仍有效，直接走第三步
    await loginStep3(s1.location);
  } else {
    const s2 = await loginStep2(user, pass, captcha, s1.qs, s1._sign);
    if (s2.location && s2.ssecurity) {
      await loginStep3(s2.location);
      setCreds(s2);
      return { ok: true };
    }
    if (s2.notificationUrl) { // 需要安全验证（短信/邮件）
      session.pendingVerify = {
        url: /^http/.test(s2.notificationUrl) ? s2.notificationUrl : ACCOUNT_BASE + s2.notificationUrl,
        at: Date.now(),
      };
      return { need_verify: true, url: session.pendingVerify.url };
    }
    if (s2.captchaUrl) {
      const cu = /^http/.test(s2.captchaUrl) ? s2.captchaUrl : ACCOUNT_BASE + s2.captchaUrl;
      const res = await req(cu);
      const buf = Buffer.from(await res.arrayBuffer());
      session.captcha.ick = session.jar.get('ick') || '';
      return { need_captcha: true, img: `data:image/jpeg;base64,${buf.toString('base64')}`, hint: s2.code === 87001 ? '验证码不对，已换新图，请重填' : '' };
    }
    if (s2.code === 70016 || s2.code === 20003 || s2.code === 70002) return { error: '小米账号或密码错误（code ' + s2.code + '）' };
    return { error: `登录失败（code ${s2.code ?? '未知'} ${s2.description || ''}）`.trim() };
  }
  // 走到这说明 step1 直接给了有效会话；ssecurity 只在 step2 响应里，由 ensureCreds 兜底
  if (!session.jar.has('serviceToken')) return { error: '登录会话异常，请重试' };
  return { ok: true, reused: true };
}

// step1 会话复用路径拿不到 ssecurity：清 cookie 强制一次完整登录
async function passportLogin(user, pass, captcha) {
  try {
    const r = await doLogin(user, pass, captcha);
    if (r.ok && (!session.creds || !session.creds.ssecurity)) {
      session.jar.clear();
      return doLogin(user, pass, captcha);
    }
    return r;
  } catch (e) {
    return { error: '小米账号服务连接失败：' + (e.message || '网络错误') };
  }
}

// ---------- 短信/邮件安全验证（hass-xiaomi-miot verify_ticket 同流程） ----------
// 用户在自己手机/浏览器完成安全验证并收到验证码后，把验证码提交到这里。
async function verifyCode(code) {
  const pv = session.pendingVerify;
  if (!pv || Date.now() - pv.at > VERIFY_TTL) {
    throw new Error('没有待完成的安全验证（或已超时 15 分钟），请重新登录');
  }
  if (!pv.url.includes('fe/service/identity/authStart')) {
    throw new Error('该验证链接不支持自动提交，请在手机上完成验证后回来重新登录一次');
  }
  // identity/list：拿 identity_session（进入 jar）+ 可用验证方式 {flag, options}
  const res = await req(pv.url.replace('fe/service/identity/authStart', 'identity/list'));
  const listData = parseJson(await res.text()) || {};
  if (!session.jar.has('identity_session')) throw new Error('验证会话获取失败，请重试');
  const options = Array.isArray(listData.options) && listData.options.length
    ? listData.options : [listData.flag || 4];
  let last = null;
  for (const flag of options) { // 4=手机短信 8=邮件，逐个试（验证码只属于其中一个通道）
    const api = flag === 8 ? '/identity/auth/verifyEmail' : flag === 4 ? '/identity/auth/verifyPhone' : null;
    if (!api) continue;
    const r = await req(`${ACCOUNT_BASE}${api}?_dc=${Date.now()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _flag: String(flag), ticket: String(code), trust: 'false', _json: 'true' }).toString(),
    });
    const j = parseJson(await r.text()) || {};
    last = j;
    if (j.code === 0 && j.location) {
      // 验证通过：跟随 location 拿 serviceToken，再 step1 补 ssecurity、step3 落定
      await req(j.location).then((x) => x.text()).catch(() => '');
      const s1 = await loginStep1();
      if (s1.code === 0 && s1.location && s1.ssecurity) {
        await loginStep3(s1.location);
        setCreds(s1);
        session.pendingVerify = null;
        return session.creds;
      }
      throw new Error('验证成功但获取凭证失败，请重新登录一次');
    }
  }
  throw new Error((last && (last.description || last.msg)) || '验证码不正确或已过期，请重试');
}

// ---------- 对外 ----------
// 取当前登录会话的凭证（30 分钟内有效）；过期返回 null。调用方（路由）负责注入，不回显令牌。
function takeCreds() {
  if (session.creds && session.creds.serviceToken && session.creds.ssecurity
    && Date.now() - session.credsAt < CREDS_TTL) return { ...session.creds };
  return null;
}
function reset() {
  session.jar.clear();
  session.creds = null;
  session.credsAt = 0;
  session.pendingVerify = null;
  session.captcha.ick = '';
}

module.exports = { passportLogin, verifyCode, takeCreds, reset };
