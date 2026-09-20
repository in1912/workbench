// UI 复现：日程表「共享给」用户选择器——点一下是否立即消失、能否选中成员
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
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript((t) => { localStorage.setItem('wb_token', t); }, [token]);
  await page.addInitScript((u) => { localStorage.setItem('wb_user', u); }, [JSON.stringify({ id: admin.id, username: admin.username, role: 'admin', allowed_pages: [], allowed_tabs: {} })]);
  await page.goto('http://localhost:3000/#/tasks');
  await page.waitForSelector('.cal, .calendar, .card', { timeout: 15000 });
  await page.waitForTimeout(1200);   // 等日历渲染 + contacts 加载

  // 打开新增日程弹窗：点「今天」单元格（含今天的日期格）
  const today = new Date().getDate();
  const dayCell = page.locator('.cal-day, [class*=day]', { hasText: String(today) }).first();
  await dayCell.click();
  await page.waitForSelector('.modal-card', { timeout: 8000 });
  ck('新增日程弹窗已打开', true);

  // 点击共享选择器
  await page.click('.share-row .up-box');
  await page.waitForTimeout(400);
  let visible = await page.isVisible('.up-drop');
  ck('点击后下拉立即仍可见（不消失）', visible, visible ? '' : '下拉 400ms 后不可见');
  const items = await page.locator('.up-item').count();
  ck('下拉里有成员可选（contacts 已加载）', items > 0, `items=${items}`);
  await page.screenshot({ path: 'Logs/tasks-share-picker.png' });

  if (items > 0) {
    await page.locator('.up-item').first().click();
    await page.waitForTimeout(300);
    const chips = await page.locator('.up-chip').count();
    ck('点选成员后出现选中 chip', chips > 0, `chips=${chips}`);
    const still = await page.isVisible('.up-drop');
    ck('多选模式下选人后下拉保持打开', still);
  }

  console.log(`\nUI ${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} catch (e) {
  console.log('测试异常:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
