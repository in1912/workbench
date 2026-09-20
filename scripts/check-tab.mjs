import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const token = crypto.randomBytes(32).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+5 minutes'))").run(token, admin.id);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.addInitScript((t) => {
  localStorage.setItem('wb_token', t);
  localStorage.setItem('wb_user', JSON.stringify({ id: 1, username: 'admin', role: 'admin', allowed_pages: [], allowed_tabs: {} }));
}, [token]);
try {
  await page.goto('http://localhost:3000/#/learning');
  await page.waitForTimeout(1200);
  const tabs = await page.locator('.tabs button').allTextContents();
  console.log('tab顺序:', JSON.stringify(tabs));
  console.log(tabs[0].trim() === '中英文听写' ? '✓ 听写在第一位' : '✗ 第一位是 ' + tabs[0]);
  console.log(await page.locator('.dict textarea').count() ? '✓ 默认落在听写编辑页' : '✗ 默认页不是听写');
  await page.screenshot({ path: 'Logs/dictation-first-tab.png' });
} finally { await browser.close(); db.prepare('DELETE FROM sessions WHERE token=?').run(token); }
