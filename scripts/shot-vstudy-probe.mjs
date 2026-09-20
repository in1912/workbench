// UI 目检：视频教学设置 →「浏览容器目录」按钮 → 探测框出现、条目可点开下级、用此目录回填输入框
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const admin = db.prepare("SELECT id, username FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const token = crypto.randomBytes(32).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+20 minutes'))").run(token, admin.id);

let pass = 0, fail = 0;
// 「用此目录」会真实保存 vstudy_root —— 备份，finally 还原
const origRoot = db.prepare("SELECT value FROM settings WHERE key='vstudy_root'").get();
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript((t) => { localStorage.setItem('wb_token', t); }, [token]);
await page.addInitScript((u) => { localStorage.setItem('wb_user', u); }, [JSON.stringify({ id: admin.id, username: admin.username, role: 'admin', allowed_pages: [], allowed_tabs: {} })]);

try {
  await page.goto('http://localhost:3000/#/learning?tab=vsettings');
  await page.waitForSelector('.vset .card', { timeout: 15000 });
  const probeBtn = page.locator('.probe > button');
  ck('「浏览容器目录」按钮出现', await probeBtn.isVisible());
  await probeBtn.click();
  await page.waitForSelector('.probe-box', { timeout: 10000 });
  ck('探测框出现并显示当前路径', (await page.locator('.probe-head b').innerText()).length > 0);
  ck('目录条目渲染', (await page.locator('.probe-item.dir').count()) > 0, String(await page.locator('.probe-item.dir').count()));
  await page.screenshot({ path: 'Logs/vstudy-probe.png' });

  // 点开第一个目录 → 路径切换到下级；再回上级
  const firstDir = page.locator('.probe-item.dir').first();
  const name = await firstDir.innerText();
  await firstDir.click();
  await page.waitForFunction((n) => {
    const b = document.querySelector('.probe-head b');
    return b && b.textContent.includes(n.replace('📁', '').trim());
  }, name, { timeout: 10000 }).then(() => ck('点开目录进入下级', true)).catch(() => ck('点开目录进入下级', false));
  const up = page.locator('.probe-head .mini');
  ck('「上级」链接出现', await up.isVisible());
  await up.click();
  await page.waitForTimeout(800);
  ck('回到上级后「用此目录」可点', await page.locator('.probe-head button', { hasText: '用此目录' }).isVisible());

  // 用此目录：回填输入框并触发保存（显示已保存）
  await page.locator('.probe-head button', { hasText: '用此目录' }).click();
  await page.waitForSelector('.test-result.ok', { timeout: 8000 });
  ck('用此目录 → 输入框回填并保存成功', true);
  const val = await page.locator('.vset input.grow').first().inputValue();
  ck('输入框值为探测路径', !!val && val.length > 0, val);

  console.log(`\nUI ${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  await browser.close();
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  db.prepare("DELETE FROM settings WHERE key='vstudy_root'").run();
  if (origRoot) db.prepare("INSERT INTO settings(key,value) VALUES('vstudy_root',?)").run(origRoot.value);
}
