// 复现「点测试图片没有任何反应」：真实浏览器点按钮，捕获 网络请求/页面反馈/反馈条可见性
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const BASE = 'http://localhost:3000';
const db = new DatabaseSync('data/workbench.sqlite');
db.prepare("INSERT OR IGNORE INTO users(username,password_hash,role,allowed_pages,allowed_tabs,is_bot) VALUES('rich_e2e','','user','[]','{}',0)").run();
const uid = db.prepare("SELECT id FROM users WHERE username='rich_e2e'").get().id;
const token = crypto.randomBytes(32).toString('hex');
db.prepare(`INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,'2030-01-01 00:00:00')`).run(token, uid);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const reqs = [];
page.on('request', (r) => { if (r.url().includes('dingtalk/test')) reqs.push(r.method() + ' ' + r.url().replace(BASE, '')); });
page.on('response', async (r) => { if (r.url().includes('dingtalk/test')) { let b = ''; try { b = JSON.stringify(await r.json()); } catch {} reqs.push('  ← ' + r.status() + ' ' + b.slice(0, 120)); } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 150)));
page.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 150)); });
await page.addInitScript(([t, u]) => {
  localStorage.setItem('wb_token', t);
  localStorage.setItem('wb_user', JSON.stringify({ id: u, username: 'rich_e2e', role: 'user', allowed_pages: [], allowed_tabs: {} }));
}, [token, uid]);

await page.goto(BASE + '/#/settings');
await page.waitForSelector('.card');
// 滚到钉钉推送卡
await page.locator('h3:has-text("钉钉推送")').scrollIntoViewIfNeeded();
const btn = page.locator('button:has-text("测试图片")');
console.log('按钮存在:', await btn.count(), '· 可见:', await btn.isVisible().catch(() => false));
await btn.click();
await page.waitForTimeout(800);
const banner = page.locator('.msg');
const cnt = await banner.count();
if (cnt) {
  const text = (await banner.first().textContent()).trim();
  const box = await banner.first().boundingBox();
  console.log('反馈条:', JSON.stringify(text.slice(0, 80)));
  console.log('反馈条位置 y=', box ? Math.round(box.y) : 'N/A', '· 视口高 900 · 在视口内:', box ? (box.y >= 0 && box.y < 900) : 'N/A');
  await page.screenshot({ path: 'Logs/testimg-after-click.png' });
} else {
  console.log('反馈条: 无（msg 元素未渲染）');
  await page.screenshot({ path: 'Logs/testimg-after-click.png' });
}
console.log('网络请求:', JSON.stringify(reqs, null, 1));

await browser.close();
db.prepare('DELETE FROM sessions WHERE token=?').run(token);
db.prepare('DELETE FROM users WHERE id=?').run(uid);
console.log('done');
