// IP 黑名单 + 通勤出行方式 E2E（v1.3.4）：
// 封禁生命周期（封→全站 403（含静态页与 health）→解封恢复）；守卫（回环不可封/不可封自己 IP/非管理员 403）；
// 自动封禁（10 次密码错误封来源 IP；回环与「曾成功登录过」的 IP 不自动封）；
// 通勤 mode 配置回读 + 非法值归一；UI：设置→登录日志 tab（黑名单+日志+封禁按钮）+ 通勤出行方式。
// 用法：node scripts/e2e-ip-ban-commute.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PORT = 3999, B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, 'data', 'tmp-e2e-ip-ban'); // 子目录（勿放 data/ 根）

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
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456', TTS_ROOT: path.join(DATA, 'no-tts') },
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

// 带自定义 X-Forwarded-For 的请求（模拟不同来源 IP；服务端 clientIp 以 XFF 首段为准）
const xf = async (ip, p, opt = {}) => {
  const r = await fetch(B + p, { ...opt, headers: { 'X-Forwarded-For': ip, ...(opt.headers || {}) } });
  let b = null; try { b = await r.json(); } catch { /* 非 JSON */ }
  return { s: r.status, b };
};
const j = async (p, opt = {}) => {
  const r = await fetch(B + p, opt);
  let b = null; try { b = await r.json(); } catch { /* 非 JSON */ }
  return { s: r.status, b };
};
const post = (p, body, ha) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(ha || {}) }, body: JSON.stringify(body) });
const put = (p, body, ha) => j(p, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...(ha || {}) }, body: JSON.stringify(body) });

// ---- 登录 ----
const lg = await post('/api/auth/login', { username: 'admin', password: 'test123456' });
ck('管理员登录', lg.s === 200 && lg.b.token);
const HA = { Authorization: 'Bearer ' + lg.b.token, 'Content-Type': 'application/json' };
await post('/api/users', { username: 'm1', password: 'm1-pass-123', role: 'user' }, HA);
const m1lg = await post('/api/auth/login', { username: 'm1', password: 'm1-pass-123' });
const MH = { Authorization: 'Bearer ' + m1lg.b.token, 'Content-Type': 'application/json' };

// ---- 1) 封禁生命周期 ----
ck('初始黑名单为空', (await j('/api/ip-bans', { headers: HA })).b.bans.length === 0);
const ban1 = await put('/api/ip-bans/203.0.113.9', { note: 'E2E 手动封禁' }, HA);
ck('管理员封禁公网 IP', ban1.s === 200 && ban1.b.ok, JSON.stringify(ban1.b));
ck('被禁 IP 打 /api/health 也 403', (await xf('203.0.113.9', '/api/health')).s === 403);
ck('被禁 IP 打登录接口 403', (await xf('203.0.113.9', '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test123456' }) })).s === 403);
ck('被禁 IP 打静态页 403', (await xf('203.0.113.9', '/')).s === 403);
ck('其他 IP 不受影响', (await xf('198.51.100.1', '/api/health')).s === 200 && (await j('/api/health')).s === 200);
const del1 = await j('/api/ip-bans/203.0.113.9', { method: 'DELETE', headers: HA });
ck('解封恢复访问', del1.s === 200 && (await xf('203.0.113.9', '/api/health')).s === 200);

// ---- 2) 守卫 ----
ck('回环地址不可封', (await put('/api/ip-bans/127.0.0.1', {}, HA)).s === 400);
ck('不可封自己当前 IP', (await xf('198.51.100.7', '/api/ip-bans/198.51.100.7', { method: 'PUT', headers: HA, body: JSON.stringify({}) })).s === 400);
ck('IP 格式校验', (await put('/api/ip-bans/not-an-ip', {}, HA)).s === 400);
ck('非管理员不可看黑名单', (await j('/api/ip-bans', { headers: MH })).s === 403);
ck('非管理员不可封禁', (await put('/api/ip-bans/203.0.113.9', {}, MH)).s === 403);
ck('非管理员不可解封', (await j('/api/ip-bans/203.0.113.9', { method: 'DELETE', headers: MH })).s === 403);

// ---- 3) 自动封禁（10 次密码错误） ----
await post('/api/users', { username: 'v2', password: 'v2-pass-123', role: 'user' }, HA);
for (let i = 1; i <= 10; i++) {
  await xf('198.51.100.66', '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'v2', password: 'x' + i }) });
}
const bans1 = (await j('/api/ip-bans', { headers: HA })).b.bans;
const auto = bans1.find((b) => b.ip === '198.51.100.66');
ck('10 次失败自动封禁来源 IP', !!auto && auto.created_by === '系统' && /自动封禁/.test(auto.note), JSON.stringify(bans1));
ck('被自动封禁的 IP 全站 403', (await xf('198.51.100.66', '/api/health')).s === 403);

// ---- 4) 不自动封的两种情况 ----
// 4a. 回环（花生壳穿透=全站共用）：本机已有成功登录，双保险
await post('/api/users', { username: 'v3', password: 'v3-pass-123', role: 'user' }, HA);
for (let i = 1; i <= 10; i++) await post('/api/auth/login', { username: 'v3', password: 'y' + i });
const bans2 = (await j('/api/ip-bans', { headers: HA })).b.bans;
ck('回环来源不自动封', !bans2.find((b) => /127\.|::1/.test(b.ip)), JSON.stringify(bans2));
// 4b. 曾成功登录过的公网 IP（自己人换网络/手滑）：m1 先从 .99 成功登录一次，再从 .99 爆破 v3
await xf('198.51.100.99', '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'm1', password: 'm1-pass-123' }) });
for (let i = 1; i <= 10; i++) {
  await xf('198.51.100.99', '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'v3', password: 'z' + i }) });
}
const bans3 = (await j('/api/ip-bans', { headers: HA })).b.bans;
ck('曾成功登录的 IP 不自动封', !bans3.find((b) => b.ip === '198.51.100.99'), JSON.stringify(bans3));
ck('该 IP 仍可访问（没误封）', (await xf('198.51.100.99', '/api/health')).s === 200);

// ---- 5) 通勤出行方式 ----
await post('/api/commute', { home: '测试市测试路1号', work: '测试大厦', mode: 'electrobike' }, HA);
let cmc = (await j('/api/commute', { headers: HA })).b.config;
ck('通勤方式保存 electrobike', cmc.mode === 'electrobike', JSON.stringify(cmc));
await post('/api/commute', { mode: 'garbage-value' }, HA);
cmc = (await j('/api/commute', { headers: HA })).b.config;
ck('非法方式归一为 driving', cmc.mode === 'driving', JSON.stringify(cmc));

// ---- 6) UI：设置 → 登录日志 tab + 通勤出行方式 ----
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
  await page.goto(`${B}/#/settings`);
  await page.click('button:has-text("登录日志")');
  await page.waitForSelector('h3:has-text("IP 黑名单")', { timeout: 15000 });
  ck('UI 黑名单卡片可见', true);
  await page.waitForSelector('h3:has-text("登录日志")', { timeout: 10000 });
  ck('UI 日志卡片有行', (await page.locator('.ll-table tbody tr').count()) > 0);
  ck('UI 内网行无封禁按钮（防自锁）', (await page.locator('.ll-table tr', { hasText: '127.0.0.1' }).locator('button:has-text("封禁")').count()) === 0);
  ck('UI 公网行有封禁按钮', (await page.locator('.ll-table button:has-text("封禁")').count()) > 0);
  ck('UI 黑名单含自动封禁条目', (await page.locator('table').first().locator('td:has-text("198.51.100.66")').count()) === 1);
  // 手动加一个 + 解封
  await page.fill('input[placeholder*="IP 地址"]', '203.0.113.77');
  await page.click('button:has-text("加入黑名单")');
  await page.waitForSelector('table td:has-text("203.0.113.77")', { timeout: 10000 });
  ck('UI 手动加入黑名单', true);
  const row77 = page.locator('tr', { has: page.locator('td:has-text("203.0.113.77")') });
  await row77.locator('button:has-text("解封")').click();
  await page.waitForSelector('table td:has-text("203.0.113.77")', { state: 'detached', timeout: 10000 });
  ck('UI 解封移除', true);
  // 通勤出行方式
  await page.click('button:has-text("常规设置")');
  await page.waitForSelector('h3:has-text("通勤（地图预计时间）")', { timeout: 10000 });
  // 按选项值精确定位「出行方式」下拉（设置页有多个 select）
  await page.locator('select:has(option[value="electrobike"])').selectOption('walking');
  await page.click('button:has-text("保存并计算")');
  await sleep(800);
  cmc = (await j('/api/commute', { headers: HA })).b.config;
  ck('UI 保存出行方式 walking', cmc.mode === 'walking', JSON.stringify(cmc));
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
