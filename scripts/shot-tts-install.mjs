// UI 目检：语音配音页「未安装」状态下的一键安装入口（对 TTS_ROOT 指向的空环境）
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const admin = db.prepare("SELECT id, username, display_name FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const token = crypto.randomBytes(32).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+10 minutes'))").run(token, admin.id);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript((t) => {
  localStorage.setItem('wb_token', t);
  localStorage.setItem('wb_user', JSON.stringify({ id: 1, username: 'admin', role: 'admin', allowed_pages: [], allowed_tabs: {} }));
}, [token]);

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };

try {
  await page.goto('http://localhost:3000/#/learning?tab=tts');
  await page.waitForSelector('.tts');
  ck('引擎状态=未安装', (await page.locator('.pill').first().innerText()) === '未安装');
  ck('一键安装按钮可见', await page.locator('button', { hasText: '一键安装 TTS 引擎' }).isVisible());
  ck('安装提示说明', (await page.locator('.inst-tip').innerText()).includes('仅需一次'));
  await page.screenshot({ path: 'Logs/tts-install-entry.png' });
  console.log(`\nUI ${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  await browser.close();
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
