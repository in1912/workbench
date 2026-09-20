// 目检打字记录 + 赚钱日历的有效字数展示（管理员身份，看真实数据）
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const db = new DatabaseSync('data/workbench.sqlite');
const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const token = crypto.randomBytes(32).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+10 minutes'))").run(token, admin.id);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript((t) => {
  localStorage.setItem('wb_token', t);
  localStorage.setItem('wb_user', JSON.stringify({ id: 1, username: 'admin', role: 'admin', allowed_pages: [], allowed_tabs: {} }));
}, [token]);

await page.goto('http://localhost:3000/#/typing?tab=records');
await page.waitForTimeout(1500);
console.log('URL:', page.url());
console.log('body前300字:', (await page.locator('body').innerText()).replace(/\n+/g, ' | ').slice(0, 300));
await page.waitForSelector('.rc-table');
console.log('记录卡片:', await page.locator('.rc-card').allTextContents().then(a => a.map(s => s.trim().replace(/\s+/g, ' '))));
console.log('表格表头:', await page.locator('.rc-table th').allTextContents());
console.log('首行:', await page.locator('.rc-table tbody tr').first().textContent().then(s => s.trim().replace(/\s+/g, ' ')));
await page.screenshot({ path: 'Logs/typing-records-net.png' });

await page.goto('http://localhost:3000/#/typing?tab=money');
await page.waitForSelector('.mn-cards');
console.log('日历卡片:', await page.locator('.mn-card').allTextContents().then(a => a.map(s => s.trim().replace(/\s+/g, ' '))));
console.log('费率说明:', (await page.locator('.mn-rate').textContent()).trim().replace(/\s+/g, ' '));
await page.screenshot({ path: 'Logs/typing-money-net.png' });

// 兑现登记预览行（选成员触发 preview）
await page.goto('http://localhost:3000/#/typing?tab=payout');
await page.waitForSelector('.po-form');
const opt = page.locator('.po-form select option').nth(1);
if (await opt.count()) { await page.locator('.po-form select').selectOption({ index: 1 }); await page.waitForTimeout(600); }
const pv = await page.locator('.po-preview').textContent().catch(() => '(无预览)');
console.log('兑现预览:', pv.trim().replace(/\s+/g, ' '));
await page.screenshot({ path: 'Logs/typing-payout-net.png' });

await browser.close();
db.prepare('DELETE FROM sessions WHERE token=?').run(token);
console.log('done');
