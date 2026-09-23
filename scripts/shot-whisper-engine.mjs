// UI 目检：录音转写页 Whisper 服务器引擎（首选位、语言选择、三按钮、切换回 VibeASR）
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const token = crypto.randomBytes(32).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+10 minutes'))").run(token, admin.id);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.addInitScript((t) => {
  localStorage.setItem('wb_token', t);
  localStorage.setItem('wb_user', JSON.stringify({ id: 1, username: 'admin', role: 'admin', allowed_pages: [], allowed_tabs: {} }));
}, [token]);

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };

try {
  await page.goto('http://localhost:3000/#/tools?tab=vibe');
  await page.waitForSelector('.mode-switch');
  ck('算力来源=服务器引擎选中', await page.locator('.mode-switch button', { hasText: '服务器引擎' }).evaluate((el) => el.classList.contains('on')));

  // 服务器引擎选择器：Whisper 排第一且选中
  const engSwitch = page.locator('.card', { has: page.locator('h3', { hasText: '算力来源' }) }).locator('.mode-switch').nth(1);
  const engBtns = engSwitch.locator('button');
  ck('引擎选择器有 2 个按钮', (await engBtns.count()) === 2);
  ck('Whisper 排第一位', (await engBtns.nth(0).innerText()).includes('Whisper large-v3-turbo'));
  ck('Whisper 选中（首选）', await engBtns.nth(0).evaluate((el) => el.classList.contains('on')));
  ck('VibeASR 排第二', (await engBtns.nth(1).innerText()).includes('VibeVoice-ASR'));

  // Whisper 分支内容
  const card = page.locator('.card', { has: page.locator('h3', { hasText: '算力来源' }) });
  ck('识别语言下拉存在', await card.locator('select', { has: page.locator('option', { hasText: '中文' }) }).isVisible());
  ck('引擎就绪徽标', (await card.locator('.badge').allInnerTexts()).some((s) => s.includes('引擎就绪')));
  ck('停止按钮', await card.locator('button', { hasText: '停止' }).isVisible());
  ck('删除模型按钮', await card.locator('button', { hasText: '删除模型' }).isVisible());
  ck('删除模型说明=0.9GB', (await card.locator('.muted', { hasText: '删除模型：' }).innerText()).includes('0.9GB'));
  ck('按需加载提示', (await card.locator('.muted', { hasText: '按需加载模型' }).innerText()).includes('3~5 秒'));

  // 模型下载说明卡：Whisper 首选行在最上
  const modelCard = page.locator('.card', { has: page.locator('h3', { hasText: '模型下载说明' }) });
  const rows = modelCard.locator('.model-row');
  ck('首选行=Whisper（第一行）', (await rows.nth(0).innerText()).includes('Whisper large-v3-turbo'));
  ck('首选行标签', (await rows.nth(0).locator('.model-tag').innerText()).includes('首选'));
  ck('BitNet 行改备选', (await rows.nth(1).innerText()).includes('备选'));

  await page.screenshot({ path: 'Logs/whisper-engine-tab.png', fullPage: false });

  // 切到 VibeASR：文案与按钮跟随
  await engBtns.nth(1).click();
  await page.waitForTimeout(1200);
  ck('切到 VibeASR 后选中', await engBtns.nth(1).evaluate((el) => el.classList.contains('on')));
  ck('VibeASR 删除模型说明=1.7GB', (await card.locator('.muted', { hasText: '删除模型：' }).innerText()).includes('1.7GB'));
  ck('Whisper 专属提示隐藏', !(await card.locator('.muted', { hasText: '按需加载模型' }).isVisible().catch(() => false)));
  // 切回 Whisper（恢复首选展示，也是用户进页面的默认状态）
  await engBtns.nth(0).click();
  await page.waitForTimeout(1200);
  ck('切回 Whisper', await engBtns.nth(0).evaluate((el) => el.classList.contains('on')));

  console.log(`\nUI ${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  await browser.close();
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
