// UI 目检：本地直连通道（本地可达 → 文件走本地前缀 + 「本地直连」徽标；不可达 → 回落当前源 + 「公网通道」）
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';

const ROOT = 'D:/CC/tmp-vstudy-test';
fs.mkdirSync(ROOT, { recursive: true });
fs.writeFileSync(ROOT + '/sample.png', Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const admin = db.prepare("SELECT id, username FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const token = crypto.randomBytes(32).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+20 minutes'))").run(token, admin.id);
const origRoot = db.prepare("SELECT value FROM settings WHERE key='vstudy_root'").get();
db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('vstudy_root',?)").run(ROOT);

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };

async function browsePage(browser) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript((t) => { localStorage.setItem('wb_token', t); }, [token]);
  await page.addInitScript((u) => { localStorage.setItem('wb_user', u); }, [JSON.stringify({ id: admin.id, username: admin.username, role: 'admin', allowed_pages: [], allowed_tabs: {} })]);
  await page.goto('http://localhost:3000/#/learning?tab=vstudy');
  await page.waitForSelector('.vstudy .card', { timeout: 15000 });
  await page.click('.big-start');
  await page.click('.big-btn', { hasText: '学年' });
  await page.click('.big-btn');
  await page.waitForSelector('.vs-body', { timeout: 10000 });
  await page.waitForSelector('.node .row', { timeout: 10000 });
  return page;
}

const browser = await chromium.launch();
try {
  // ===== 场景 A：本地地址可达（127.0.0.1:3000 就是本机服务）=====
  db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('local_base_url','http://127.0.0.1:3000')").run();
  let page = await browsePage(browser);
  await page.click('.node .row', { hasText: 'sample.png' });
  await page.waitForSelector('.doc-img', { timeout: 10000 });
  await page.waitForSelector('.lb.ok', { timeout: 8000 });
  const srcA = await page.getAttribute('.doc-img', 'src');
  ck('可达：图片 src 走本地前缀', (srcA || '').startsWith('http://127.0.0.1:3000/api/vstudy/file'), srcA);
  ck('可达：显示「⚡ 本地直连」徽标', (await page.textContent('.lb')) === '⚡ 本地直连');
  await page.screenshot({ path: 'Logs/vstudy-localbase.png' });
  await page.close();

  // ===== 场景 B：本地地址不可达（127.0.0.1:9 无服务）→ 回落当前源 =====
  db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('local_base_url','http://127.0.0.1:9')").run();
  page = await browsePage(browser);   // 新页面 = 新 sessionStorage，强制重新探测
  await page.click('.node .row', { hasText: 'sample.png' });
  await page.waitForSelector('.doc-img', { timeout: 10000 });
  await page.waitForSelector('.lb:not(.ok)', { timeout: 8000 });
  const srcB = await page.getAttribute('.doc-img', 'src');
  ck('不可达：图片 src 回落当前源（相对地址）', (srcB || '').startsWith('/api/vstudy/file') || (srcB || '').includes('localhost:3000/api/vstudy/file'), srcB);
  ck('不可达：显示「公网通道」徽标', (await page.textContent('.lb')) === '公网通道');
  await page.close();

  console.log(`\nUI ${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  await browser.close();
  db.prepare("DELETE FROM settings WHERE key='local_base_url'").run();
  db.prepare("DELETE FROM settings WHERE key='vstudy_root'").run();
  if (origRoot) db.prepare("INSERT INTO settings(key,value) VALUES('vstudy_root',?)").run(origRoot.value);
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
