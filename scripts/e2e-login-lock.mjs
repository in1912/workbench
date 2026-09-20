// 登录防爆破锁 + 登录日志 E2E（v1.3.3）：
// 临时锁（5 次锁 15 分钟，测试用 1.5s）→ 锁定期内正确密码也 403 → 过期自动恢复、计数清零；
// 永久锁（10 次）→ 正确密码也拒 → 管理员解锁恢复；
// 未知用户名不计数但记流水；IP 熔断（测试放宽到 999 次防自锁）；
// 日志字段（ip/地区=内网/失败行带尝试密码、成功行不带）+ 权限（非管理员 403）；
// UI：用户管理页锁定徽章 + 解锁按钮 + 登录日志卡片。
// 用法：node scripts/e2e-login-lock.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PORT = 3999, B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, 'data', 'tmp-e2e-login-lock'); // 子目录（勿放 data/ 根）

let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  <<< ' + extra}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
const srv = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
  cwd: ROOT,
  env: {
    ...process.env, PORT: String(PORT), DATA_DIR: DATA,
    DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456',
    TTS_ROOT: path.join(DATA, 'no-tts'),
    LOGIN_TEMP_LOCK_MS: '1500', // 临时锁 1.5 秒（加速）
    LOGIN_IP_FAILS: '999',      // IP 熔断放宽（全测试同 IP，防自锁）
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', (d) => console.error('[srv-err]', String(d).slice(0, 300)));
{
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`${B}/api/health`); if (r.ok) break; } catch { /* 未就绪 */ }
    if (Date.now() - t0 > 30000) { console.error('服务 30s 内未就绪'); srv.kill(); process.exit(1); }
    await sleep(500);
  }
}

const j = async (p, opt = {}) => {
  const r = await fetch(B + p, opt);
  let b = null; try { b = await r.json(); } catch { /* 非 JSON */ }
  return { s: r.status, b };
};
const post = (p, body, ha) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(ha || {}) }, body: JSON.stringify(body) });
const put = (p, body, ha) => j(p, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(ha || {}) }, body: JSON.stringify(body) });

// ---- 管理员登录（最先做，别被后面的失败污染） ----
const lg = await post('/api/auth/login', { username: 'admin', password: 'test123456' });
ck('管理员登录', lg.s === 200 && lg.b.token, JSON.stringify(lg.b).slice(0, 100));
const HA = { Authorization: 'Bearer ' + lg.b.token };

// ---- 建测试账号 ----
await post('/api/users', { username: 'victim', password: 'right-pass-1', role: 'user' }, HA);
await post('/api/users', { username: 'm2', password: 'm2-pass-123', role: 'user' }, HA);
const m2lg = await post('/api/auth/login', { username: 'm2', password: 'm2-pass-123' });
const MH = { Authorization: 'Bearer ' + m2lg.b.token };

// ---- 1) 临时锁：4 次失败正常 401，第 5 次触发锁 ----
for (let i = 1; i <= 4; i++) {
  const r = await post('/api/auth/login', { username: 'victim', password: 'wrong-' + i });
  ck(`第 ${i} 次失败 401 且未锁`, r.s === 401 && !/锁定/.test(r.b.error || ''), `${r.s} ${r.b.error}`);
}
const r5 = await post('/api/auth/login', { username: 'victim', password: 'wrong-5' });
ck('第 5 次失败提示临时锁定', r5.s === 401 && /临时锁定/.test(r5.b.error || ''), `${r5.s} ${r5.b.error}`);
// 锁定期内：正确密码也进不来（403/423 而非 200）
const rLock = await post('/api/auth/login', { username: 'victim', password: 'right-pass-1' });
ck('锁定期内正确密码也被拒', rLock.s === 423 && /临时锁定/.test(rLock.b.error || ''), `${rLock.s} ${rLock.b.error}`);
// 管理员视角：用户列表可见锁定状态
const users1 = await j('/api/users', { headers: HA });
const vRow = users1.b.find((u) => u.username === 'victim');
ck('用户列表带锁定状态', vRow && vRow.fail_count === 6 && !!vRow.locked_until && !vRow.lock_permanent, JSON.stringify(vRow).slice(0, 120));
// 过期自动恢复（1.5s 锁）：正确密码登录成功 + 计数清零
await sleep(1700);
const rBack = await post('/api/auth/login', { username: 'victim', password: 'right-pass-1' });
ck('临时锁过期后正确密码恢复登录', rBack.s === 200 && rBack.b.token, `${rBack.s} ${JSON.stringify(rBack.b).slice(0, 80)}`);
const users2 = await j('/api/users', { headers: HA });
ck('成功登录后失败计数清零', users2.b.find((u) => u.username === 'victim').fail_count === 0);

// ---- 2) 永久锁：连续 10 次失败 → 只能管理员解锁 ----
for (let i = 1; i <= 10; i++) await post('/api/auth/login', { username: 'victim', password: 'brute-' + i });
const users3 = await j('/api/users', { headers: HA });
const v3 = users3.b.find((u) => u.username === 'victim');
ck('10 次失败后永久锁定', v3 && v3.lock_permanent === 1 && v3.fail_count === 10, JSON.stringify(v3).slice(0, 120));
const rPerm = await post('/api/auth/login', { username: 'victim', password: 'right-pass-1' });
ck('永久锁内正确密码被拒(403)', rPerm.s === 403 && /解锁/.test(rPerm.b.error || ''), `${rPerm.s} ${rPerm.b.error}`);
ck('非管理员不可解锁', (await put('/api/users/' + v3.id + '/unlock', {}, MH)).s === 403);
const unl = await put('/api/users/' + v3.id + '/unlock', {}, HA);
ck('管理员解锁', unl.s === 200 && unl.b.ok, JSON.stringify(unl.b));
const rAfter = await post('/api/auth/login', { username: 'victim', password: 'right-pass-1' });
ck('解锁后正确密码恢复登录', rAfter.s === 200, `${rAfter.s} ${rAfter.b && rAfter.b.error}`);

// ---- 3) 未知用户名：不计数但记流水 ----
const rUnk = await post('/api/auth/login', { username: 'ghost-user-9', password: 'whatever' });
ck('未知用户名 401', rUnk.s === 401, `${rUnk.s}`);

// ---- 4) 登录日志内容与权限 ----
ck('非管理员不可看日志', (await j('/api/auth/login-logs', { headers: MH })).s === 403);
const logs = await j('/api/auth/login-logs?page=1&pageSize=50', { headers: HA });
ck('日志可查且有量', logs.s === 200 && logs.b.total >= 20, JSON.stringify(logs.b).slice(0, 80));
const rows = logs.b.rows;
const adminOk = rows.find((r) => r.success === 1 && r.username === 'admin');
ck('成功行：有 IP/地区、无密码', adminOk && adminOk.ip === '127.0.0.1' && adminOk.region === '内网' && adminOk.attempted_password == null, JSON.stringify(adminOk));
const failRow = rows.find((r) => r.success === 0 && r.username === 'victim' && r.reason === '密码错误');
ck('失败行：带尝试的密码', failRow && /^brute-/.test(failRow.attempted_password || ''), JSON.stringify(failRow));
const lockRow = rows.find((r) => r.success === 0 && /锁定/.test(r.reason || ''));
ck('锁定期内尝试有流水', !!lockRow, JSON.stringify(rows.slice(0, 3)));
const unkRow = rows.find((r) => r.username === 'ghost-user-9');
ck('未知用户名有流水(用户名不存在)', unkRow && unkRow.reason === '用户名不存在', JSON.stringify(unkRow));
const logsF = await j('/api/auth/login-logs?outcome=fail&page=1&pageSize=200', { headers: HA });
ck('outcome=fail 过滤：全为失败', logsF.b.rows.every((r) => r.success === 0) && logsF.b.total >= 18, `total=${logsF.b.total}`);

// ---- 5) UI：锁定徽章 + 解锁按钮 + 登录日志卡片 ----
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext();
  await ctx.addInitScript(([t, u]) => {
    localStorage.setItem('wb_token', t);
    localStorage.setItem('wb_user', u);
  }, [lg.b.token, JSON.stringify(lg.b.user)]);
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('dialog', (d) => d.accept().catch(() => {}));
  await page.goto(`${B}/#/users`);
  await page.waitForSelector('h3:has-text("登录日志")', { timeout: 15000 });
  ck('UI 登录日志卡片可见', (await page.locator('.log-table tbody tr').count()) > 0);
  ck('UI 日志含失败行红标', (await page.locator('.log-table .badge:has-text("失败")').count()) > 0);
  // 再锁一个账号验 UI 解锁
  for (let i = 1; i <= 10; i++) await post('/api/auth/login', { username: 'm2', password: 'x' + i });
  await page.reload();
  await page.waitForSelector('h3:has-text("用户列表")', { timeout: 15000 });
  ck('UI 永久锁定徽章', (await page.locator('span.badge:has-text("已锁定")').count()) === 1);
  const btn = page.locator('button:has-text("解锁")').first();
  await btn.waitFor({ timeout: 10000 });
  await btn.click();
  await page.waitForSelector('span.badge:has-text("已锁定")', { state: 'detached', timeout: 10000 });
  ck('UI 点击解锁后徽章消失', true);
  const m2again = await post('/api/auth/login', { username: 'm2', password: 'm2-pass-123' });
  ck('UI 解锁后该账号可登录', m2again.s === 200, `${m2again.s}`);
  ck('UI 零 pageerror', errs.length === 0, errs.slice(0, 2).join(' | ').slice(0, 200));
  await ctx.close();
} finally {
  await browser.close().catch(() => {});
}

srv.kill();
await sleep(800);
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
