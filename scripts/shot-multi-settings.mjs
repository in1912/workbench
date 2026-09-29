// UI 冒烟（设置→多平台 tab，自 family-learning v3.0 移植版）：分享访问/地址配置/电视版/电视模式预览/非管理员视角
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const admin = db.prepare("SELECT id, username FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const tA = crypto.randomBytes(32).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+20 minutes'))").run(tA, admin.id);
// 临时普通成员
db.prepare("INSERT INTO users(username,password_hash,role,allowed_pages,is_bot) VALUES('e2e_multi_u','','user','[]',0)").run();
const uRow = db.prepare("SELECT id FROM users WHERE username='e2e_multi_u'").get();
const tU = crypto.randomBytes(32).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+20 minutes'))").run(tU, uRow.id);

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };
const BASE = 'http://localhost:3000';

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  await page.addInitScript((t) => { localStorage.setItem('wb_token', t); }, [tA]);
  await page.addInitScript((u) => { localStorage.setItem('wb_user', u); }, [JSON.stringify({ id: admin.id, username: admin.username, role: 'admin', allowed_pages: [], allowed_tabs: {} })]);

  await page.goto(BASE + '/#/settings');
  await page.waitForSelector('.tabs button', { timeout: 15000 });
  const tabs = await page.locator('.tabs button').allTextContents();
  ck('设置页出现「多平台」tab（最后一个）', tabs[tabs.length - 1].includes('多平台'), JSON.stringify(tabs));
  await page.locator('.tabs button:has-text("多平台")').click();
  await page.waitForSelector('.multi-panel', { timeout: 8000 });

  console.log('— 分享访问 —');
  await page.waitForSelector('.zone-line .badge', { timeout: 8000 });
  const zoneTxt = (await page.locator('.zone-line .badge').first().textContent()).trim();
  ck('localhost 判定为内网环境', zoneTxt.includes('内网'), zoneTxt);
  const rows = page.locator('.addr-row');
  ck('两个地址行都显示', (await rows.count()) === 2, String(await rows.count()));
  const lanAddr = (await rows.nth(0).locator('.addr-text').textContent()).trim();
  ck('内网地址 = 当前地址 http://localhost:3000', lanAddr === BASE, lanAddr);
  ck('内网行当前通道高亮 + 复制按钮', (await rows.nth(0).getAttribute('class')).includes('cur') && await rows.nth(0).locator('button:has-text("复制链接")').count() === 1);
  const wanAddr = (await rows.nth(1).locator('.addr-text').textContent()).trim();
  ck('外网行显示未配置提示', wanAddr.includes('未配置'), wanAddr.slice(0, 30));
  ck('打开方式说明两种', (await page.locator('.tip-card').first().textContent()).includes('微信/钉钉里收到链接') && (await page.locator('.tip-card').first().textContent()).includes('直接抄地址'));

  console.log('— 地址配置（管理员） —');
  const cfg = page.locator('.card:has(h3:has-text("地址配置"))');
  ck('管理员看到地址配置卡', (await cfg.count()) === 1);
  ck('外网+内网两个配置项', await cfg.locator('input').count() === 2);
  await cfg.locator('input').first().fill('https://e2-test.example.com');
  await cfg.locator('button:has-text("保存")').first().click();
  await page.waitForTimeout(600);
  const wan1 = (await page.locator('.addr-row').nth(1).locator('.addr-text').textContent()).trim();
  ck('保存外网地址后分享区立即显示', wan1 === 'https://e2-test.example.com', wan1);
  const saved = db.prepare("SELECT value FROM settings WHERE key='external_base_url'").get();
  ck('external_base_url 已落库（工作台 settings 值为 JSON 编码存储）', saved && (saved.value === '"https://e2-test.example.com"' || saved.value === 'https://e2-test.example.com'), JSON.stringify(saved));
  // 还原：清空
  await cfg.locator('input').first().fill('');
  await cfg.locator('button:has-text("保存")').first().click();
  await page.waitForTimeout(600);
  ck('清空后恢复未配置提示', (await page.locator('.addr-row').nth(1).locator('.addr-text').textContent()).includes('未配置'));
  await page.screenshot({ path: 'Logs/multi-settings-share.png', fullPage: true });

  console.log('— 电视版 —');
  await page.locator('.mp-subtabs button:has-text("电视版")').click();
  await page.waitForSelector('a.primary.dl', { timeout: 8000 });
  const href = await page.locator('a.primary.dl').getAttribute('href');
  ck('APK 下载链接 /tv/family-learning-tv.apk', href === '/tv/family-learning-tv.apk', String(href));
  { const apkHead = await page.request.head(BASE + href); const sc = typeof apkHead.status === 'function' ? apkHead.status() : apkHead.status; ck('APK 可下载（200）', sc === 200, String(sc)); }
  ck('安装步骤三步说明', (await page.locator('.tip-card').textContent()).includes('①') && (await page.locator('.tip-card').textContent()).includes('③'));
  await page.locator('button:has-text("预览电视模式")').click();
  await page.waitForSelector('body.tv-mode', { timeout: 5000 });
  ck('body.tv-mode 已开启', true);
  await page.locator('.mp-subtabs button').first().focus();
  const before = await page.evaluate(() => document.activeElement && (document.activeElement.textContent || document.activeElement.tagName));
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => document.activeElement && (document.activeElement.textContent || document.activeElement.tagName));
  ck('→ 方向键移动焦点', before !== after, `${before} → ${after}`);
  await page.locator('button.tv-exit-btn').click();
  await page.waitForTimeout(300);
  ck('退出电视模式恢复正常', (await page.locator('body.tv-mode').count()) === 0);
  await page.screenshot({ path: 'Logs/multi-settings-tv.png', fullPage: true });

  console.log('— 非管理员视角 —');
  const page2 = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  await page2.addInitScript((t) => { localStorage.setItem('wb_token', t); }, [tU]);
  await page2.addInitScript((u) => { localStorage.setItem('wb_user', u); }, [JSON.stringify({ id: uRow.id, username: 'e2e_multi_u', role: 'user', allowed_pages: [], allowed_tabs: {} })]);
  await page2.goto(BASE + '/#/settings');
  await page2.waitForSelector('.tabs button', { timeout: 15000 });
  const tabs2 = await page2.locator('.tabs button').allTextContents();
  ck('普通成员也看到「多平台」tab', tabs2.some((t) => t.includes('多平台')), JSON.stringify(tabs2));
  await page2.locator('.tabs button:has-text("多平台")').click();
  await page2.waitForSelector('.multi-panel', { timeout: 8000 });
  ck('普通成员能看分享地址', (await page2.locator('.addr-row').count()) === 2);
  ck('普通成员看不到地址配置卡', (await page2.locator('.card:has(h3:has-text("地址配置"))').count()) === 0);

  console.log(`\n${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  try {
    db.prepare("DELETE FROM settings WHERE key='external_base_url' AND value='https://e2-test.example.com'").run();
  } catch { /* 不在就算了 */ }
  db.prepare('DELETE FROM sessions WHERE token IN (?,?)').run(tA, tU);
  db.prepare("DELETE FROM users WHERE username='e2e_multi_u'").run();
  await browser.close();
}
