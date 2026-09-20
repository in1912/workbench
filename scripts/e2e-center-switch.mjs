// 三测评中心「对外开关」E2E（v1.3.2）：
// API：默认开 → PUT 关 → 静态页/免登录接口全 403、管理端不受影响、跨中心互不影响、
//      部分更新语义（切开关不清前缀）、非管理员 403 → 重开恢复。
// UI：管理员切开关 → iframe 消失/恢复 + 停用横幅。
// 用法：node scripts/e2e-center-switch.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PORT = 3999, B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, 'data', 'tmp-e2e-center-switch'); // 子目录（勿放 data/ 根）

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
const HA = { Authorization: 'Bearer ' + lg.b.token };

// ---- 默认状态：三中心全开 ----
for (const t of ['dep', 'pro', 'mbti']) {
  const r = await fetch(`${B}/${t}/index.html`);
  ck(`默认 ${t} 静态页 200`, r.status === 200, String(r.status));
}
const cfg0 = await j('/api/dep/config', { headers: HA });
ck('config 默认 enabled=true', cfg0.s === 200 && cfg0.b.enabled === true, JSON.stringify(cfg0.b));

// ---- 建 1 个普通成员（验非管理员不可改开关） ----
await post('/api/users', { username: 'm1', password: 'm1-pass-123', role: 'user' }, HA);
const ml = await post('/api/auth/login', { username: 'm1', password: 'm1-pass-123' });
const MH = { Authorization: 'Bearer ' + ml.b.token };
ck('非管理员 PUT config 403', (await put('/api/dep/config', { enabled: false }, MH)).s === 403);

// ---- dep 关闭 ----
const off = await put('/api/dep/config', { enabled: false }, HA);
ck('PUT enabled:false', off.s === 200 && off.b.enabled === false, JSON.stringify(off.b));
ck('dep 静态页 403', (await fetch(`${B}/dep/index.html`)).status === 403);
ck('dep 根路径 403', (await fetch(`${B}/dep/`)).status === 403);
ck('dep 静态资产 403', (await fetch(`${B}/dep/js/app.js`)).status === 403);
ck('dep 分享读取 403', (await j('/api/dep/public/whatever123')).s === 403);
ck('dep 匿名写档案 403', (await post('/api/dep/records', { id: 'e2esw1', uid: 'U123456789' })).s === 403);
ck('dep 资料写入 403', (await post('/api/dep/user-info', { uid: 'U123456789', nickname: 'x' })).s === 403);
ck('dep AI 授权探测 403', (await j('/api/dep/ai-auth?uid=U123456789')).s === 403);
ck('dep AI 分析 403', (await post('/api/dep/ai-analysis', { id: 'e2esw1', uid: 'U123456789', prompt: 'x'.repeat(60) })).s === 403);
ck('dep 管理列表不受影响', (await j('/api/dep/records?page=1', { headers: HA })).s === 200);
ck('pro/mbti 不受 dep 影响', (await fetch(`${B}/pro/index.html`)).status === 200 && (await fetch(`${B}/mbti/index.html`)).status === 200);

// ---- mbti 独立关闭 ----
await put('/api/mbti/config', { enabled: false }, HA);
ck('mbti 静态页 403（独立开关）', (await fetch(`${B}/mbti/index.html`)).status === 403);
ck('pro 仍 200', (await fetch(`${B}/pro/index.html`)).status === 200);
await put('/api/mbti/config', { enabled: true }, HA);
ck('mbti 重开恢复 200', (await fetch(`${B}/mbti/index.html`)).status === 200);

// ---- 部分更新语义：切开关不清前缀 ----
await put('/api/dep/config', { prefix: 'https://example.com' }, HA);
await put('/api/dep/config', { enabled: true }, HA);
const cfg1 = await j('/api/dep/config', { headers: HA });
ck('切开关后前缀保留', cfg1.s === 200 && cfg1.b.prefix === 'https://example.com' && cfg1.b.enabled === true, JSON.stringify(cfg1.b));
await put('/api/dep/config', { prefix: '' }, HA); // 清掉

// ---- 重开恢复写入 ----
const rec = await post('/api/dep/records', { id: 'e2esw1', uid: 'U123456789', testId: 'd01', testTitle: 'E2E', type: '轻度', userInfo: { uid: 'U123456789', nickname: '开关测试' } });
ck('重开后匿名写档案 200', rec.s === 200, JSON.stringify(rec.b).slice(0, 120));

// ---- UI：管理员切开关 ----
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
  await page.goto(`${B}/#/tools?tab=dep`);
  await page.waitForSelector('h3:has-text("分享域名前缀")', { timeout: 15000 });
  const sw = page.locator('label', { hasText: '对外测试开关' }).locator('input[type=checkbox]');
  await sw.waitFor({ timeout: 10000 });
  ck('UI 开关可见且默认开', await sw.isChecked());
  ck('UI iframe 存在', (await page.locator('iframe').count()) === 1);
  await sw.click();
  await page.waitForSelector('h3:has-text("已停用")', { timeout: 10000 });
  ck('UI 关闭后 iframe 消失+停用横幅', (await page.locator('iframe').count()) === 0);
  const http = await page.evaluate(async () => (await fetch('/dep/index.html')).status);
  ck('UI 会话内静态页 403', http === 403, String(http));
  await sw.click();
  await page.waitForSelector('iframe', { timeout: 10000 });
  ck('UI 重开 iframe 恢复', (await page.locator('iframe').count()) === 1);
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
