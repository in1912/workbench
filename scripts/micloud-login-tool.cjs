#!/usr/bin/env node
// 小米账号本地登录 + 摄像头事件凭证注入工具（v1.6.19，配合 server/services/micamService.js）
//
// 为什么存在：摄像头真实画面（截图/录像）只认小米「智能摄像头业务接口」，凭证需用账号密码
// 走 App 登录协议换取（OAuth 授权拿不到，2026-09-28 已全面实测）。经用户拍板「密码不存生产」：
// 本工具只在【本地电脑（家里网络）】运行，密码仅存内存用于换凭证，换到的
// {userId, serviceToken, ssecurity} 注入生产工作台后即弃。凭证过期（通常数周）重跑本工具。
//
// 用法：node scripts/micloud-login-tool.cjs  （或双击 scripts\micloud登录.bat）
// 浏览器自动打开 http://127.0.0.1:9607 ，按页面提示操作。
// 协议蓝本：micloud 包（MIT, Sammy Svensson）+ hass-xiaomi-miot xiaomi_cloud.py（MIT）。
const http = require('http');
const crypto = require('crypto');
const { exec } = require('child_process');

const PORT = 9607;
const ACCOUNT_BASE = 'https://account.xiaomi.com';

// ---------- 会话状态（仅内存；进程退出即清空，密码绝不落盘） ----------
const state = {
  jar: new Map(),          // 账号体系 cookie（deviceId/sdkCode/passToken…）
  agentId: Array.from({ length: 13 }, () => 'ABCDEF'[Math.floor(Math.random() * 6)]).join(''),
  creds: null,             // 登录成功后的 { userId, serviceToken, ssecurity }
  captcha: { img: '', ick: '', qs: '', sign: '' },
};
const UA = `Android-7.1.1-1.0.0-ONEPLUS A3010-136-${state.agentId} APP/xiaomi.smarthome APPV/62830`;

// ---------- 极简 cookie jar ----------
function cookieHeader() {
  return [...state.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}
function absorbCookies(res) {
  for (const line of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) state.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
// 手动跟随重定向（逐跳吸收 Set-Cookie；serviceToken 就在中途某一跳上）
async function req(url, opts = {}) {
  let u = url;
  for (let hop = 0; hop < 8; hop++) {
    const res = await fetch(u, {
      ...opts, redirect: 'manual',
      headers: { 'User-Agent': UA, ...(state.jar.size ? { Cookie: cookieHeader() } : {}), ...(opts.headers || {}) },
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
  throw new Error('重定向次数过多');
}

// ---------- 登录三步（sid=xiaomiio） ----------
function parseJson(text) {
  try { return JSON.parse(String(text).replace('&&&START&&&', '')); } catch { return null; }
}
async function loginStep1() {
  state.jar.set('sdkVersion', '3.8.6');
  state.jar.set('deviceId', state.agentId);
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
    if (state.captcha.ick) state.jar.set('ick', state.captcha.ick);
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
  if (!state.jar.has('serviceToken')) throw new Error('登录成功但未取到 serviceToken（账号可能需要在 App 侧确认）');
  return state.jar.get('serviceToken');
}

// 完整登录：返回 {ok} 或 {need_captcha, img} 或 {need_verify, url} 或 {error}
async function doLogin(user, pass, captcha) {
  const s1 = await loginStep1();
  if (!s1.qs && s1.code === 0 && s1.location) { // 会话仍有效，直接走第三步
    await loginStep3(s1.location);
  } else {
    const s2 = await loginStep2(user, pass, captcha, s1.qs, s1._sign);
    if (s2.location && s2.ssecurity) {
      await loginStep3(s2.location);
      state.creds = {
        userId: String(s2.userId || state.jar.get('userId') || ''),
        serviceToken: state.jar.get('serviceToken'),
        ssecurity: s2.ssecurity,
      };
      return { ok: true };
    }
    if (s2.notificationUrl) {
      return { need_verify: /^http/.test(s2.notificationUrl) ? s2.notificationUrl : ACCOUNT_BASE + s2.notificationUrl };
    }
    if (s2.captchaUrl) {
      const cu = /^http/.test(s2.captchaUrl) ? s2.captchaUrl : ACCOUNT_BASE + s2.captchaUrl;
      const res = await req(cu);
      const buf = Buffer.from(await res.arrayBuffer());
      state.captcha.ick = state.jar.get('ick') || '';
      state.captcha.qs = s1.qs; state.captcha.sign = s1._sign;
      return { need_captcha: true, img: `data:image/jpeg;base64,${buf.toString('base64')}`, hint: s2.code === 87001 ? '验证码不对，已换新图，请重填' : '' };
    }
    if (s2.code === 70016 || s2.code === 20003 || s2.code === 70002) return { error: '小米账号或密码错误（code ' + s2.code + '）' };
    return { error: `登录失败（code ${s2.code ?? '未知'} ${s2.description || ''}）` };
  }
  // 走到这说明 step1 直接给了有效会话
  if (!state.jar.has('serviceToken')) return { error: '登录会话异常，请重试' };
  return { ok: true, reused: true };
}

// 登录成功但走 reuse 分支时，ssecurity 需要再补一次完整登录拿（ssecurity 只在 step2 响应里）
async function ensureCreds(user, pass, captcha) {
  const r = await doLogin(user, pass, captcha);
  if (r.ok && (!state.creds || !state.creds.ssecurity)) {
    // step1 会话复用路径拿不到 ssecurity：清 cookie 强制完整登录一次
    state.jar.clear();
    state.jar.set('sdkVersion', '3.8.6'); state.jar.set('deviceId', state.agentId);
    return doLogin(user, pass, captcha);
  }
  return r;
}

// ---------- 注入生产 ----------
async function doInject(base, u, p) {
  if (!state.creds || !state.creds.serviceToken) throw new Error('请先完成小米账号登录');
  let origin = String(base || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(origin)) origin = 'https://' + origin;
  const lr = await fetch(origin + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: p }),
  });
  const lj = await lr.json().catch(() => ({}));
  if (!lj.token) throw new Error('工作台账号或密码错误');
  const ir = await fetch(origin + '/api/micam/inject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lj.token },
    body: JSON.stringify({
      user_id: state.creds.userId, service_token: state.creds.serviceToken,
      ssecurity: state.creds.ssecurity, region: 'cn',
    }),
  });
  const ij = await ir.json().catch(() => ({}));
  if (!ir.ok || !ij.ok) throw new Error(ij.error || '注入失败（HTTP ' + ir.status + '）');
  const sr = await fetch(origin + '/api/micam/status', { headers: { Authorization: 'Bearer ' + lj.token } });
  const sj = await sr.json().catch(() => ({}));
  if (!sj.bound) throw new Error('注入后校验失败，请重试');
  return { user_id: sj.user_id || state.creds.userId };
}

// ---------- 页面与接口 ----------
const PAGE = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>小米摄像头凭证 · 本地登录注入</title><style>
body{font-family:system-ui,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f4f6f9;display:flex;justify-content:center;padding:30px 14px;margin:0}
.card{background:#fff;border-radius:14px;padding:26px 30px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:520px;width:100%}
h2{margin:0 0 6px;font-size:19px}p.sub{color:#666;font-size:13px;margin:0 0 16px;line-height:1.7}
label{display:block;font-size:13px;color:#444;margin:12px 0 4px}
input{width:100%;box-sizing:border-box;padding:9px 11px;border-radius:9px;border:1px solid #ccc;font-size:14px}
button{margin-top:18px;width:100%;padding:11px;border:none;border-radius:9px;background:#4f8cff;color:#fff;font-size:15px;cursor:pointer}
button:disabled{opacity:.6;cursor:default}
#cap img{height:52px;border-radius:6px;border:1px solid #ddd;margin-top:4px}
.sec{margin-top:20px;padding-top:14px;border-top:1px dashed #ddd}
.sec h3{margin:0 0 2px;font-size:15px}
#log{margin-top:14px;font-size:13px;line-height:1.8;white-space:pre-wrap}
.ok{color:#16a34a}.err{color:#dc2626}.warn{color:#b45309}
a{color:#4f8cff}
</style></head><body><div class="card">
<h2>小米摄像头凭证 · 本地登录注入</h2>
<p class="sub">用小米账号密码换取摄像头「看家事件截图/录像」凭证并注入工作台。
密码只在本页提交、只在本工具内存中换凭证，不保存、不上传生产服务器；注入完成后即可关闭本页。
凭证一般数周有效，监控页提示过期时重跑本工具。</p>

<div class="sec"><h3>① 小米账号登录</h3>
<label>小米账号（手机号/邮箱/小米 ID）</label><input id="xu" autocomplete="username">
<label>小米密码</label><input id="xp" type="password" autocomplete="current-password">
<div id="cap" style="display:none"><label>验证码（下图字符）</label><img id="capimg"><input id="xc" placeholder="输入图中字符"></div>
</div>

<div class="sec"><h3>② 注入到工作台</h3>
<label>工作台地址</label><input id="base" value="http://localhost:3000">
<label>工作台账号</label><input id="wu" autocomplete="username">
<label>工作台密码</label><input id="wp" type="password" autocomplete="current-password">
</div>

<button id="go">登录并注入</button>
<div id="log"></div>
<script>
const $ = (i) => document.getElementById(i);
const log = (m, c) => { $('log').innerHTML += '<div class="' + (c || '') + '">' + m + '</div>'; };
$('go').onclick = async () => {
  const b = $('go'); b.disabled = true; b.textContent = '处理中…'; $('log').innerHTML = '';
  try {
    const xu = $('xu').value.trim(), xp = $('xp').value;
    if (!xu || !xp) throw new Error('请填小米账号和密码');
    log('① 正在登录小米账号（从本机/家里网络出口）…');
    let r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: xu, pass: xp, captcha: $('xc').value.trim() }) }).then((x) => x.json());
    if (r.need_captcha) {
      $('cap').style.display = 'block'; $('capimg').src = r.img; $('xc').value = '';
      log(r.hint ? '验证码不对，已换新图，请重填后再次点击' : '需要验证码：输入图中字符后再点一次按钮', 'warn');
      b.disabled = false; b.textContent = '继续'; return;
    }
    if (r.need_verify) {
      log('小米要求安全验证：请在手机上打开 <a href="' + r.need_verify + '" target="_blank">这个链接</a> 完成验证，然后回来再点一次按钮', 'warn');
      b.disabled = false; b.textContent = '已验证，继续'; return;
    }
    if (r.error) throw new Error(r.error);
    log('登录成功（userId ' + (r.user_id || '') + '），已取得凭证', 'ok');
    $('cap').style.display = 'none';
    const base = $('base').value.trim(), wu = $('wu').value.trim(), wp = $('wp').value;
    if (!base || !wu || !wp) throw new Error('请填工作台地址/账号/密码');
    log('② 正在注入 ' + base + ' …');
    const j = await fetch('/api/inject', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base, user: wu, pass: wp }) }).then((x) => x.json());
    if (!j.ok) throw new Error(j.error || '注入失败');
    log('注入成功 ✓ 已绑定用户 ' + (j.user_id || ''), 'ok');
    log('现在可以关闭本页，到工作台「监控」tab 点刷新查看摄像头截图/录像。', 'ok');
    b.textContent = '完成 ✓';
  } catch (e) {
    log(e.message, 'err'); b.disabled = false; b.textContent = '重试';
  }
};
</script></div></body></html>`;

const server = http.createServer(async (rq, rs) => {
  const url = new URL(rq.url, 'http://127.0.0.1');
  const json = (code, obj) => { rs.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); rs.end(JSON.stringify(obj)); };
  const readBody = () => new Promise((ok) => {
    let b = '';
    rq.on('data', (c) => (b += c));
    rq.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { ok({}); } });
  });
  try {
    if (rq.method === 'GET' && url.pathname === '/') {
      rs.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); rs.end(PAGE); return;
    }
    if (rq.method === 'POST' && url.pathname === '/api/login') {
      const b = await readBody();
      if (!b.user || !b.pass) return json(400, { error: '参数缺失' });
      const r = await ensureCreds(String(b.user), String(b.pass), b.captcha ? String(b.captcha) : '');
      return json(200, r.ok ? { ok: true, user_id: state.creds.userId } : r);
    }
    if (rq.method === 'POST' && url.pathname === '/api/inject') {
      const b = await readBody();
      try { const r = await doInject(b.base, b.user, b.pass); json(200, { ok: true, user_id: r.user_id }); }
      catch (e) { json(400, { error: e.message }); }
      return;
    }
    rs.writeHead(404); rs.end('not found');
  } catch (e) {
    json(500, { error: e.message || '服务异常' });
  }
});
server.listen(PORT, '127.0.0.1', () => {
  const u = `http://127.0.0.1:${PORT}`;
  console.log(`小米摄像头凭证登录工具已启动：${u}`);
  console.log('按页面提示完成「小米账号登录 + 注入工作台」后关闭本窗口即可。');
  console.log('（密码只在内存中换凭证，不保存；Ctrl+C 退出）');
  const open = process.platform === 'win32' ? `start "" "${u}"` : process.platform === 'darwin' ? `open "${u}"` : `xdg-open "${u}"`;
  exec(open, () => {});
});
