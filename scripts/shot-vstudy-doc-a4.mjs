// UI 目检：视频教学文档预览默认 A4 比例整页 + video preload=auto
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';

const ROOT = 'D:/CC/tmp-vstudy-test';
fs.mkdirSync(ROOT, { recursive: true });
// 1x1 PNG（内容不重要，验证视口尺寸）
fs.writeFileSync(ROOT + '/sample.png', Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
fs.writeFileSync(ROOT + '/notes.txt', 'A4 视口测试'.repeat(200));

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const admin = db.prepare("SELECT id, username FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const token = crypto.randomBytes(32).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+20 minutes'))").run(token, admin.id);
const orig = db.prepare("SELECT value FROM settings WHERE key='vstudy_root'").get();
db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('vstudy_root',?)").run(ROOT);

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript((t) => { localStorage.setItem('wb_token', t); }, [token]);
await page.addInitScript((u) => { localStorage.setItem('wb_user', u); }, [JSON.stringify({ id: admin.id, username: admin.username, role: 'admin', allowed_pages: [], allowed_tabs: {} })]);

async function browse() {
  await page.goto('http://localhost:3000/#/learning?tab=vstudy');
  await page.waitForSelector('.vstudy .card', { timeout: 15000 });
  await page.click('.big-start');
  await page.click('.big-btn', { hasText: '学年' });   // 第一个学年按钮
  await page.click('.big-btn');                          // 第一个学科按钮
  await page.waitForSelector('.vs-body', { timeout: 10000 });
  await page.waitForSelector('.node .row', { timeout: 10000 });
}

try {
  await browse();
  ck('video 元素 preload=auto（提前缓冲起播）', (await page.getAttribute('video', 'preload')) === 'auto');

  // ---- 图片：doc-page A4 视口 ----
  await page.click('.node .row', { hasText: 'sample.png' });
  await page.waitForSelector('.doc-page', { timeout: 10000 });
  await page.waitForTimeout(600);
  let box = await page.locator('.doc-page').boundingBox();
  const ratio = box.height / box.width;
  ck('doc-page 默认高宽比 ≥ 1.35（A4≈1.414）', ratio >= 1.35, `ratio=${ratio.toFixed(2)} ${box.width}x${box.height}`);
  ck('doc-page 高度 ≥ 560px（窄窗兜底）', box.height >= 560, String(box.height));
  await page.screenshot({ path: 'Logs/vstudy-doc-a4.png' });

  // ---- 文本文档同样拿到 A4 视口 ----
  await page.click('.node .row', { hasText: 'notes.txt' });
  await page.waitForSelector('.doc-text', { timeout: 10000 });
  await page.waitForTimeout(400);
  box = await page.locator('.doc-page').boundingBox();
  ck('txt 文档同样 A4 视口', box.height / box.width >= 1.35, `ratio=${(box.height / box.width).toFixed(2)}`);

  console.log(`\nUI ${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  await browser.close();
  db.prepare("DELETE FROM settings WHERE key='vstudy_root'").run();
  if (orig) db.prepare("INSERT INTO settings(key,value) VALUES('vstudy_root',?)").run(orig.value);
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
