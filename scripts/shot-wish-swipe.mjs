// UI E2E：心愿卡多图（v1.2.21）
// ① 看板/列表「⧉N」多图角标 ② 放大画廊触屏滑动翻页（含滑动不误关） ③ 屏幕按钮/键盘回归
// ④ App 版本看门狗：system-info 版本变化 → 提示条 + 3 秒后自动刷新（升级自愈）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'tmp-wish-ui');
const PORT = 3997;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  <<< ' + extra}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1x1 PNG（三种颜色仅用于区分；src 断言按图片 id 区分，像素不参与断言）
const PNG_A = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
const srv = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456', TTS_ROOT: path.join(DATA, 'no-tts') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', () => {});
await sleep(2500);

try {
  // ---- 数据准备：3 张图 + 1 个心愿产品 ----
  let r = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test123456' }) });
  const lj = await r.json();
  ck('登录', r.status === 200 && !!lj.token);
  const HA = { Authorization: 'Bearer ' + lj.token, 'Content-Type': 'application/json' };
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const ir = await fetch(`${B}/api/family-images`, { method: 'POST', headers: HA, body: JSON.stringify({ data: PNG_A }) });
    const ij = await ir.json();
    ck(`上传图 ${i + 1}`, ir.status === 200 && !!ij.id);
    ids.push(ij.id);
  }
  r = await fetch(`${B}/api/wish/manage`, {
    method: 'POST', headers: HA,
    body: JSON.stringify({ name: 'E2E多图滑动手表', description: '滑动翻页用', market_price: 99, family_price: 59, note: '', image_ids: ids, cover_id: ids[0] }),
  });
  ck('登记心愿产品(3图)', r.status === 200, String(r.status));

  // ---- Playwright ----
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ hasTouch: true }); // 移动端触屏上下文
  // 版本看门狗拦截：先回 v-e2e-a，flip 置 true 后回 v-e2e-b
  let flip = false;
  await ctx.route('**/api/system-info', async (route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ name: 'E2E工作台', name_en: 'E2E', version: flip ? 'v-e2e-b' : 'v-e2e-a' }),
    });
  });
  const token = lj.token;
  const user = JSON.stringify(lj.user || {});
  await ctx.addInitScript((t) => { localStorage.setItem('wb_token', t); }, token);
  await ctx.addInitScript((u) => { localStorage.setItem('wb_user', u); }, user);
  await ctx.addInitScript(() => { window.__loads = (window.__loads || 0) + 1; }); // 每次加载计数（断言刷新/不循环）
  const page = await ctx.newPage();
  let docLoads = 0;
  page.on('load', () => { docLoads++; }); // 文档加载计数（reload 检测；window 属性不跨加载持久，不能用）
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(`${B}/#/learning?tab=wish`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.kb-card', { timeout: 15000 });
  await page.waitForTimeout(600);

  // ① 多图角标
  const badge = page.locator('.kb-img .multi');
  ck('看板角标显示 ⧉3', (await badge.textContent()) === '⧉3', await badge.textContent().catch(() => '(无)'));
  const listBadge = page.locator('.mini-img .multi');
  ck('列表角标显示 ⧉3', (await listBadge.textContent()) === '⧉3');

  // ② 放大 + 触屏滑动
  await page.locator('.kb-img').first().click();
  await page.waitForTimeout(400);
  const zoomEl = page.locator('.zoom');
  ck('放大层出现', await zoomEl.isVisible());
  const src1 = await zoomEl.getAttribute('src');
  ck('计数 1 / 3', (await page.locator('.zct').textContent()).trim() === '1 / 3');

  // 派发触屏事件（TouchEvent 构造器 Chromium 可用）：在遮罩层上左滑 120px → 下一张
  const swipe = async (dx) => page.evaluate((d) => {
    const el = document.querySelector('.modal-backdrop');
    const mk = (x) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 300 });
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [mk(200)], bubbles: true }));
    el.dispatchEvent(new TouchEvent('touchend', { changedTouches: [mk(200 + d)], bubbles: true }));
  }, dx);
  await swipe(-120);
  await page.waitForTimeout(300);
  const src2 = await zoomEl.getAttribute('src');
  ck('左滑 → 第 2 张', src2 !== src1, `${(src1 || '').slice(-14)} → ${(src2 || '').slice(-14)}`);
  ck('计数 2 / 3', (await page.locator('.zct').textContent()).trim() === '2 / 3');
  ck('滑动后画廊未误关', await zoomEl.isVisible());

  await swipe(120);
  await page.waitForTimeout(300);
  const src3 = await zoomEl.getAttribute('src');
  ck('右滑 → 回第 1 张', src3 === src1);

  // ③ 屏幕按钮 + 键盘回归
  await page.locator('.znv.next').click();
  await page.waitForTimeout(250);
  ck('点 › 翻页', (await zoomEl.getAttribute('src')) !== src1);
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(250);
  ck('键盘 ← 回退', (await zoomEl.getAttribute('src')) === src1);

  // 轻点图片关闭（touch 位移 3px → 不算滑动）
  await page.evaluate(() => {
    const el = document.querySelector('.zoom');
    const mk = (x) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 300 });
    el.dispatchEvent(new TouchEvent('touchstart', { touches: [mk(200)], bubbles: true }));
    el.dispatchEvent(new TouchEvent('touchend', { changedTouches: [mk(203)], bubbles: true }));
  });
  await page.locator('.zoom').click(); // 轻点关闭
  await page.waitForTimeout(300);
  ck('轻点图片关闭画廊', !(await zoomEl.isVisible().catch(() => false)));

  // ④ 版本看门狗：切版本 → 提示条 + 自动刷新
  await page.evaluate(() => { window.__marker = 'old'; });
  flip = true;
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // 触发立即检查
  const tip = page.locator('.upgrade-tip');
  ck('升级提示条出现', await tip.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false), await tip.textContent().catch(() => '(无)'));
  ck('提示文案含新版本号', (await tip.textContent().catch(() => '')).includes('v-e2e-b'));
  const reloaded = await page.waitForFunction(() => !window.__marker, null, { timeout: 10000 }).then(() => true).catch(() => false);
  ck('3 秒后自动刷新', reloaded);
  if (reloaded) {
    await sleep(4000); // 再等 4 秒确认不会循环刷新（刷新后基线=v-e2e-b，与服务端一致）
    ck('只刷新一次、不循环刷新', docLoads === 2, `docLoads=${docLoads}`);
  }

  await page.screenshot({ path: 'Logs/wish-swipe.png' });
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
