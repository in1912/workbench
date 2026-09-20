// UI 目检：设置页「全局默认上传保存路径」卡片（管理员可见、保存成功回显、非管理员不显示）
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const admin = db.prepare("SELECT id, username FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const token = crypto.randomBytes(32).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+20 minutes'))").run(token, admin.id);

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// addInitScript 第二参是单个参数：单元素数组会被字符串化（多元素会变 "token,[object Object]"）
await page.addInitScript((t) => { localStorage.setItem('wb_token', t); }, [token]);
await page.addInitScript((u) => { localStorage.setItem('wb_user', u); }, [JSON.stringify({ id: admin.id, username: admin.username, role: 'admin', allowed_pages: [], allowed_tabs: {} })]);

try {
  await page.goto('http://localhost:3000/#/settings');
  await page.waitForSelector('.card', { timeout: 15000 });
  await page.waitForTimeout(1200);
  const card = page.locator('.card', { hasText: '全局默认上传保存路径' });
  ck('设置卡片可见（管理员）', await card.isVisible());
  ck('说明含子目录分类', (await card.innerText()).includes('family-images') && (await card.innerText()).includes('ai-attachments'));
  const input = card.locator('input');
  ck('输入框留空（未配置）', (await input.inputValue()) === '');
  await input.fill('D:\\cc\\personal-workbench\\data\\ui-up-root');
  await card.locator('button', { hasText: '保存路径' }).click();
  await page.waitForTimeout(600);
  ck('保存成功提示', (await page.locator('body').innerText()).includes('全局上传路径已保存'));
  ck('库里已生效', db.prepare("SELECT value FROM settings WHERE key='upload_root'").get()?.value.includes('ui-up-root'));
  await page.screenshot({ path: 'Logs/settings-upload-root.png' });
  // 恢复未配置状态
  await input.fill('');
  await card.locator('button', { hasText: '保存路径' }).click();
  await page.waitForTimeout(400);
  ck('清空恢复', !db.prepare("SELECT value FROM settings WHERE key='upload_root'").get() || JSON.parse(db.prepare("SELECT value FROM settings WHERE key='upload_root'").get().value) === '');

  console.log(`\nUI ${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  await browser.close();
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  db.prepare("DELETE FROM settings WHERE key='upload_root'").run();
}
