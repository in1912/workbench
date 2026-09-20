// UI 目检：语音配音页「▶ 启动引擎」按钮（已安装未启动时出现）→ 点击后状态灯变运行中
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
// addInitScript 第二参是单个实参：单元素数组字符串化后即 token 本身（多元素数组会变 "token,[object Object]"）
await page.addInitScript((t) => { localStorage.setItem('wb_token', t); }, [token]);
await page.addInitScript((u) => { localStorage.setItem('wb_user', u); }, [JSON.stringify({ id: admin.id, username: admin.username, role: 'admin', allowed_pages: [], allowed_tabs: {} })]);

try {
  await page.goto('http://localhost:3000/#/learning?tab=tts');
  await page.waitForSelector('.tts .card', { timeout: 15000 });
  await page.waitForTimeout(1200);
  const pill = page.locator('.eng .pill');
  const warmBtn = page.locator('.warm button', { hasText: '启动引擎' });
  ck('状态灯为未启动', (await pill.innerText()).includes('未启动'));
  ck('「启动引擎」按钮出现', await warmBtn.isVisible());
  await page.screenshot({ path: 'Logs/tts-warmup-stopped.png' });
  await warmBtn.click();
  // 引擎拉起 + 模型加载（本地已缓存模型，几十秒内）
  await page.waitForFunction(() => {
    const t = document.querySelector('.eng .pill');
    return t && /运行中|加载模型|下载模型/.test(t.textContent);
  }, null, { timeout: 120000 });
  ck('点击后状态灯进入运行/加载态', /运行中|加载模型|下载模型/.test(await pill.innerText()), await pill.innerText());
  await page.screenshot({ path: 'Logs/tts-warmup.png' });

  console.log(`\nUI ${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  await browser.close();
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
