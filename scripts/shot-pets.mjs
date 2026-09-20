// 电子宠物端到端截图验证：node scripts/shot-pets.mjs [baseUrl]
// 登录 → 悬浮宠物/粪便 → 宠物页 5 个 tab → 交互动作，收集控制台错误。
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:3100';
const OUT = 'Logs/pet-shots';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

const shot = (name) => page.screenshot({ path: `${OUT}/${name}.png` });

// 登录
await page.goto(BASE + '/#/login');
await page.fill('input[placeholder="用户名"]', 'admin');
await page.fill('input[placeholder="密码"]', '123456');
await page.click('button.primary');
await page.waitForURL(/#\/(?!login)/, { timeout: 10000 });
await page.waitForTimeout(1200);

// 1. 首页：悬浮宠物 + 粪便覆盖层
await shot('01-dashboard-float');
const petBox = page.locator('.float-pet');
console.log('悬浮宠物出现:', await petBox.count() === 1);
console.log('粪便块数:', await page.locator('img.poop').count());

// 悬停展开环绕按钮
await petBox.hover();
await page.waitForTimeout(600);
await shot('02-orbit-buttons');
console.log('环绕按钮数:', await page.locator('.obtn').count());

// 点宠物头部（命中反应）
await page.mouse.click(1330, 700);
await page.waitForTimeout(500);

// 陪它玩子菜单
await petBox.hover();
await page.waitForTimeout(400);
const playBtn = page.locator('.obtn', { hasText: '陪它玩' });
if (await playBtn.count()) {
  await playBtn.click();
  await page.waitForTimeout(400);
  await shot('03-play-menu');
  const yarn = page.locator('.play-menu button', { hasText: '毛线球' });
  if (await yarn.count()) { await yarn.click(); await page.waitForTimeout(1500); await shot('04-play-yarn'); await page.waitForTimeout(3200); }
}

// 铲一块屎（元素有浮动动画，直接派发 click 事件最可靠）
const poop = page.locator('img.poop').first();
if (await poop.count()) {
  await poop.dispatchEvent('click');
  await page.waitForTimeout(1500);
  await shot('05-scooped');
  console.log('铲屎后剩余:', await page.locator('img.poop').count());
}

// 2. 宠物页各 tab
await page.goto(BASE + '/#/pets');
await page.waitForTimeout(1000);
await shot('10-pets-tab');
console.log('宠物卡片数:', await page.locator('.pet-card').count());

await page.click('.tabs button:has-text("每日打卡")');
await page.waitForTimeout(600);
await shot('11-checkin');

await page.click('.tabs button:has-text("养育记录")');
await page.waitForTimeout(600);
await shot('12-records');

await page.click('.tabs button:has-text("设置与预览")');
await page.waitForTimeout(600);
// 播放一个喂香蕉预览
const bananaBtn = page.locator('.prev-group button', { hasText: '香蕉' });
if (await bananaBtn.count()) { await bananaBtn.click(); await page.waitForTimeout(1200); }
await shot('13-settings-preview');

await page.click('.tabs button:has-text("宠物分配")');
await page.waitForTimeout(600);
await shot('14-assign');

// 3. 生病背面视图（管理页直接看 sick 状态——测试库狗已吃药恢复，这里验证组件参数即可）
await page.click('.tabs button:has-text("设置与预览")');
await page.waitForTimeout(400);
const sickBox = page.locator('.prev-stage label', { hasText: '生病' });
if (await sickBox.count()) {
  await sickBox.click();
  await page.waitForTimeout(800);
  await shot('15-sick-back');
}

console.log('\n控制台/页面错误:', errors.length ? '\n' + errors.join('\n') : '无');
await browser.close();
process.exit(errors.length ? 1 : 0);
