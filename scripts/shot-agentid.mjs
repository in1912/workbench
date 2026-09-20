// 目检设置页钉钉卡：AgentId 输入行 + 按钮提示已更新（管理员身份）
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const db = new DatabaseSync('data/workbench.sqlite');
const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const token = crypto.randomBytes(32).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+5 minutes'))").run(token, admin.id);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript((t) => {
  localStorage.setItem('wb_token', t);
  localStorage.setItem('wb_user', JSON.stringify({ id: 1, username: 'admin', role: 'admin', allowed_pages: [], allowed_tabs: {} }));
}, [token]);

await page.goto('http://localhost:3000/#/settings');
await page.waitForTimeout(1500);
// 滚到钉钉推送卡
const card = page.locator('.card', { has: page.locator('h3', { hasText: '钉钉推送' }) }).first();
await card.scrollIntoViewIfNeeded();
const agentRow = card.locator('.form-row', { hasText: 'AgentId' });
console.log('AgentId 行可见:', await agentRow.isVisible());
console.log('AgentId placeholder:', await agentRow.locator('input').getAttribute('placeholder'));
const btn = card.locator('button', { hasText: '测试图片' });
console.log('测试图片按钮 title:', await btn.getAttribute('title'));
console.log('说明文字含工作通知:', (await card.locator('.muted').first().innerText()).includes('工作通知'));
// 点一下测试图片，验证反馈条(sticky)给出 AgentId 指引
await btn.click();
await page.waitForTimeout(800);
const banner = page.locator('.msg');
console.log('反馈条:', (await banner.innerText()).slice(0, 80));
await card.screenshot({ path: 'Logs/dingtalk-agentid.png' });

await browser.close();
db.prepare('DELETE FROM sessions WHERE token=?').run(token);
console.log('done');
