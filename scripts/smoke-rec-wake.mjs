// 录音防断续优化冒烟：假麦克风真录音 → 常亮提示 → 模拟切后台警告 → 停止保存 → 清理测试行
import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
let fails = 0;
const ok = (name, cond) => { console.log(cond ? `✓ ${name}` : `✗ ${name}`); if (!cond) fails++; };

// API 登录拿 token/user
const lr = await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const lj = await lr.json();
const H = { Authorization: 'Bearer ' + lj.token };

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const ctx = await browser.newContext();
await ctx.addInitScript(([t, u]) => {
  localStorage.setItem('wb_token', t);
  localStorage.setItem('wb_user', u);
}, [lj.token, JSON.stringify(lj.user)]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(BASE + '/#/tools?vibe');
await page.waitForTimeout(1500);
// 进录音转写 tab（按钮文本）
const tabBtn = page.locator('button', { hasText: '录音转写' }).first();
await tabBtn.waitFor({ timeout: 8000 });
await tabBtn.click();
await page.waitForTimeout(800);

// 开始录音
await page.locator('button', { hasText: '开始录音' }).first().click();
await page.waitForTimeout(1200);
ok('录音计时出现', await page.locator('.rec-time').first().isVisible());
const hintText = await page.locator('.rec-time').first().locator('..').textContent();
ok('常亮提示出现（锁或警告）', /屏幕已保持常亮|请保持屏幕常亮/.test(hintText || ''));
ok('wakeLock 状态文本二选一', /🔒 屏幕已保持常亮/.test(hintText || '') || /⚠️ 请保持屏幕常亮/.test(hintText || ''));

// 模拟切后台再回来：覆写 visibilityState 派发事件
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
});
await page.waitForTimeout(300);
await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
});
await page.waitForTimeout(400);
const warnText = await page.locator('.card').first().textContent();
ok('切后台警告出现', /刚才页面进入后台/.test(warnText || ''));

// 多录 2 秒再停
await page.waitForTimeout(2000);
const before = await (await fetch(BASE + '/api/vibe/records?pageSize=100', { headers: H })).json();
const beforeIds = new Set(before.rows.map((r) => r.id));
await page.locator('button', { hasText: '停止并保存' }).first().click();
await page.waitForTimeout(2500); // 转码+上传

const after = await (await fetch(BASE + '/api/vibe/records?pageSize=100', { headers: H })).json();
const newRow = after.rows.find((r) => !beforeIds.has(r.id));
ok('录音已保存成新记录', !!newRow);
if (newRow) {
  ok('时长≥3秒（分片未丢）', Number(newRow.duration_sec) >= 3, `duration=${newRow.duration_sec}`);
  const del = await fetch(BASE + `/api/vibe/records/${newRow.id}`, { method: 'DELETE', headers: H });
  ok('清理测试行', del.status === 200);
}
ok('无 pageerror', errors.length === 0, errors.join(';'));

await browser.close();
console.log(fails ? `FAILS: ${fails}` : 'ALL_OK');
process.exit(fails ? 1 : 0);
