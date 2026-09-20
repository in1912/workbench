// UI 目检：赊账兑换列表凭证图 → 内联缩略图 + 点击页内放大（v1.2.7）
// 旧：凭证列是「查看」超链接（target=_blank 跳新页）；新：44px 缩略图，点击弹层放大，Esc/点击关闭。
// 数据：隔离服务 + POST /api/family-images 造真图 + POST /api/credit/manage 造一条带凭证、一条不带。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'tmp-credit-ui');
const PORT = 3999;
const B = `http://127.0.0.1:${PORT}`;

process.env.DATA_DIR = DATA; // 必须在 import server 模块之前

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
await sleep(2500);

try {
  let r = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test123456' }) });
  const lj = await r.json();
  ck('登录', r.status === 200 && !!lj.token);
  const A = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lj.token };
  await fetch(`${B}/api/emails/attach-config`, { headers: A }); // 摸 req.tdb 惰性建表

  // 造真图（makeTestPng 零依赖 120×60 蓝色 PNG）+ 两条赊账（一带凭证一无）
  const reqSrv = createRequire(path.join(ROOT, 'server', 'services', 'dingtalkStreamService.js'));
  const png = reqSrv('./dingtalkService').makeTestPng();
  const pj = await (await fetch(`${B}/api/family-images`, { method: 'POST', headers: A, body: JSON.stringify({ data: 'data:image/png;base64,' + png.toString('base64') }) })).json();
  ck('上传凭证图', pj.id > 0, JSON.stringify(pj));
  r = await fetch(`${B}/api/credit/manage`, { method: 'POST', headers: A, body: JSON.stringify({ user_id: lj.user.id, amount: -12.5, content: 'E2E凭证缩略', note: '', image_id: pj.id }) });
  ck('登记带凭证赊账', r.status === 200, String(r.status));
  r = await fetch(`${B}/api/credit/manage`, { method: 'POST', headers: A, body: JSON.stringify({ user_id: lj.user.id, amount: -3, content: 'E2E无图', note: '' }) });
  ck('登记无凭证赊账', r.status === 200, String(r.status));

  // UI
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addInitScript((t) => { localStorage.setItem('wb_token', t); }, lj.token);
  await ctx.addInitScript((u) => { localStorage.setItem('wb_user', u); }, JSON.stringify(lj.user));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(`${B}/#/learning?tab=records`);
  await page.waitForSelector('.credit-box tbody tr', { timeout: 15000 });

  const withImg = page.locator('.credit-box tbody tr', { hasText: 'E2E凭证缩略' });
  const noImg = page.locator('.credit-box tbody tr', { hasText: 'E2E无图' });
  ck('带凭证行有缩略图容器', (await withImg.locator('.mini-img').count()) === 1);
  const thumb = withImg.locator('.mini-img img');
  const nw = await thumb.evaluate((el) => el.naturalWidth);
  ck('缩略图真实加载（naturalWidth>0）', nw > 0, String(nw));
  ck('无凭证行显示 —', (await noImg.locator('.mini-img').count()) === 0 && (await noImg.textContent()).includes('—'));
  ck('不再有「查看」链接', (await page.locator('.credit-box a').count()) === 0);

  // 点击放大 → Esc 关闭 → 再开 → 点图关闭
  await withImg.locator('.mini-img').click();
  await page.waitForSelector('.zoom-img', { timeout: 5000 });
  const zw = await page.locator('.zoom-img').evaluate((el) => el.naturalWidth);
  ck('放大图可见且真实加载', zw > 0, String(zw));
  await page.keyboard.press('Escape');
  ck('Esc 关闭放大层', (await page.locator('.zoom-img').count()) === 0);
  await withImg.locator('.mini-img').click();
  await page.waitForSelector('.zoom-img', { timeout: 5000 });
  await page.locator('.zoom-img').click();
  ck('点击图片关闭放大层', (await page.locator('.zoom-img').count()) === 0);

  // ---- 兑现登记页签（PayoutPanel）同样式验证：旧「查看」链接残留就是这里 ----
  await page.goto(`${B}/#/learning?tab=payout`);
  const poCard = page.locator('.po-card', { hasText: '赊账兑换列表' });
  const poRow = poCard.locator('tbody tr', { hasText: 'E2E凭证缩略' });
  await poRow.waitFor({ timeout: 15000 }); // 两张表同 class，须等赊账列表具体行（异步晚于兑现记录表）
  ck('兑现登记：带凭证行有缩略图容器', (await poRow.locator('.mini-img').count()) === 1);
  const poThumb = poRow.locator('.mini-img img');
  const pnw = await poThumb.evaluate((el) => el.naturalWidth);
  ck('兑现登记：缩略图真实加载', pnw > 0, String(pnw));
  ck('兑现登记：不再有「查看」链接', (await poCard.locator('a', { hasText: '查看' }).count()) === 0);
  await poRow.locator('.mini-img').click();
  await page.waitForSelector('.zoom-img', { timeout: 5000 });
  const pzw = await page.locator('.zoom-img').evaluate((el) => el.naturalWidth);
  ck('兑现登记：放大图真实加载', pzw > 0, String(pzw));
  await page.keyboard.press('Escape');
  ck('兑现登记：Esc 关闭放大层', (await page.locator('.zoom-img').count()) === 0);

  await page.screenshot({ path: 'Logs/credit-thumb.png', fullPage: false });
  ck('无 pageerror', errors.length === 0, errors.slice(0, 2).join(' | '));
  await browser.close();
} catch (e) {
  fail++;
  console.error('  ✗ 脚本异常:', e.message);
} finally {
  srv.kill();
  await sleep(600);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
}
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
