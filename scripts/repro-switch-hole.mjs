// 复现「无论是否勾选允许对外访问，预览链接都能操作」（第 4a 项排查）
// 场景 A：管理页 UI——关开关后 iframe/按钮/横幅状态
// 场景 B：关开关前 H5 已在另一标签页加载（= 分享链接接收方页面在内存里）→ 关开关后能否继续做测试
// 场景 C：关开关后全新打开 H5（应 403）
import { chromium } from 'playwright';

const BASE = process.env.BASE || 'http://127.0.0.1:3000';
const USER = process.env.WB_USER || 'admin';
const PASS = process.env.WB_PASS || 'admin123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (p, n) => p.screenshot({ path: `Logs/switch-hole-${n}.png`, fullPage: false });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });

// ---- 登录 ----
const page = await ctx.newPage();
await page.goto(BASE + '/#/login');
await page.fill('input[type=password]', '');
await page.evaluate(([u, p]) => {
  const un = document.querySelector('input[type=text], input:not([type])');
  if (un) un.value = u;
  const pw = document.querySelector('input[type=password]');
  if (pw) pw.value = p;
}, [USER, PASS]);
await page.fill('input[type=password]', PASS);
// 用户名框可能是第一个 input
const unEl = page.locator('input').first();
await unEl.fill(USER);
await page.click('button.primary, button:has-text("登录"), button:has-text("登 录")').catch(() => {});
await page.waitForTimeout(1500);
await page.evaluate((t) => localStorage.setItem('wb_token', t), await page.evaluate(() => localStorage.getItem('wb_token')));
console.log('[login] url =', page.url());

// ---- 场景 B 前置：先在独立页面打开 H5（开关当前是开）----
const h5 = await ctx.newPage();
await h5.goto(BASE + '/dep/index.html');
await h5.waitForTimeout(1200);
console.log('[B0] H5 fresh open (enabled):', h5.url(), 'title=', await h5.title());
await shot(h5, 'b0-h5-enabled');

// ---- 场景 A：管理页关开关 ----
await page.goto(BASE + '/#/private?tab=dep');
await page.waitForTimeout(1500);
const chk = page.locator('input[type=checkbox]').first();
const before = await chk.isChecked();
console.log('[A1] 开关初始:', before);
await chk.uncheck();
await page.waitForTimeout(800);
const after = await chk.isChecked();
console.log('[A2] 取消勾选后:', after);
const banner = await page.locator('text=已停用').count();
const iframe = await page.locator('iframe').count();
console.log('[A3] 停用横幅:', banner, ' iframe:', iframe);
await shot(page, 'a3-admin-disabled');

// ---- 场景 C：全新打开 H5 ----
const fresh = await ctx.newPage();
const resp = await fresh.goto(BASE + '/dep/index.html').catch((e) => null);
console.log('[C1] 关后 fresh GET /dep/index.html:', resp ? resp.status() : 'nav-failed');
await shot(fresh, 'c1-fresh-403');
await fresh.close();

// ---- 场景 B：已加载的 H5 继续操作 ----
// 在 H5 里导航到测试中心列表并尝试开始一个测试
await h5.bringToFront().catch(() => {});
await h5.evaluate(() => { location.hash = '#/testhub'; });
await h5.waitForTimeout(800);
console.log('[B1] 已加载 H5 导航 #/testhub:', h5.url());
await shot(h5, 'b1-h5-testhub-after-disable');
// 尝试点击第一个测试进入
const item = h5.locator('a, button, .item, .card, li').filter({ hasText: /抑郁|量表|测试/ }).first();
if (await item.count()) {
  await item.click({ timeout: 3000 }).then(() => console.log('[B2] 点击测试项成功（仍可操作！）')).catch((e) => console.log('[B2] 点击失败:', e.message.slice(0, 80)));
  await h5.waitForTimeout(1000);
  await shot(h5, 'b2-h5-inside-test');
  const bodyText = (await h5.locator('body').innerText().catch(() => '')).slice(0, 200).replace(/\n/g, ' | ');
  console.log('[B3] H5 页面内容:', bodyText);
} else {
  console.log('[B2] 未找到可点的测试项');
}

// ---- 收尾：恢复开关 ----
await page.bringToFront().catch(() => {});
const chk2 = page.locator('input[type=checkbox]').first();
if (!(await chk2.isChecked())) { await chk2.check(); await page.waitForTimeout(600); }
console.log('[restore] 开关恢复为:', await page.locator('input[type=checkbox]').first().isChecked());
await browser.close();
