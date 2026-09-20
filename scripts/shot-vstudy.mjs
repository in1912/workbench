// UI 目检：视频教学全流程（设置根目录→开始学习→选学年学科→目录树→播放mp4→预览txt→学习记录）
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const admin = db.prepare("SELECT id, display_name, username FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const token = crypto.randomBytes(32).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+10 minutes'))").run(token, admin.id);
const TEST_ROOT = path.resolve('data/vstudy-test');

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.addInitScript((t) => {
  localStorage.setItem('wb_token', t);
  localStorage.setItem('wb_user', JSON.stringify({ id: 1, username: 'admin', role: 'admin', allowed_pages: [], allowed_tabs: {} }));
}, [token]);

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };

try {
  // ===== 设置页：配置 NAS 根目录 =====
  await page.goto('http://localhost:3000/#/learning?tab=vsettings');
  await page.waitForTimeout(1000);
  ck('设置页可见', await page.locator('h3', { hasText: 'NAS 学习目录' }).isVisible());
  await page.locator('.vset input >> nth=0').fill(TEST_ROOT);
  await page.locator('button', { hasText: '测试连接' }).click();
  await page.waitForFunction(() => (document.querySelector('.test-result') || {}).textContent && document.querySelector('.test-result').textContent.includes('✓'), null, { timeout: 10000 });
  ck('测试连接成功', true);
  await page.locator('button', { hasText: '保存目录' }).click();
  await page.waitForTimeout(600);

  // ===== 视频教学页：开始学习 → 学年 → 学科 =====
  await page.locator('.tabs button', { hasText: '视频教学' }).first().click();
  await page.waitForSelector('.vstudy');
  ck('开始学习大按钮', await page.locator('.big-start').isVisible());
  await page.locator('.big-start').click();
  await page.waitForSelector('.big-grid');
  ck('学年大按钮展示', (await page.locator('.big-btn').allTextContents()).some((t) => t.includes('2025-2026')));
  await page.locator('.big-btn', { hasText: '2025-2026' }).click();
  await page.waitForTimeout(300);
  await page.locator('.big-btn', { hasText: '语文' }).click();
  await page.waitForSelector('.vs-body');
  ck('进入学习界面（目录+播放+文档三区）', await page.locator('.tree').isVisible() && await page.locator('.player-zone').isVisible() && await page.locator('.doc-zone').isVisible());
  ck('目录树自动展开', (await page.locator('.tree .row').allTextContents()).some((t) => t.includes('语文')));

  // 点开「语文」文件夹 → 点 mp4 播放
  await page.locator('.tree .row', { hasText: '语文' }).first().click();
  await page.waitForTimeout(800);
  await page.locator('.tree .row', { hasText: '第一课.mp4' }).click();
  await page.waitForSelector('.player-zone video', { timeout: 15000 });
  ck('视频元素加载', (await page.locator('.player-zone video').getAttribute('src') || '').includes('/api/vstudy/file'));
  await page.waitForFunction(() => { const v = document.querySelector('.player-zone video'); return v && v.currentTime > 0.5; }, null, { timeout: 20000 });
  ck('mp4 实际播放中', true);
  await page.screenshot({ path: 'Logs/vstudy-playing.png' });

  // 切到文档 → 上区视频关闭结算，下区显示 txt 内容
  await page.locator('.tree .row', { hasText: '笔记.txt' }).click();
  await page.waitForTimeout(1200);
  const docText = await page.locator('.doc-zone').innerText();
  ck('txt 在下区预览', docText.includes('课堂笔记'));
  ck('媒体/文档分区正确', (await page.locator('.doc-zone .doc-text').count()) === 1);
  await page.screenshot({ path: 'Logs/vstudy-doc.png' });

  // xlsx 预览（SheetJS 转 HTML 表格）
  await page.locator('.tree .row', { hasText: '成绩表.xlsx' }).click();
  await page.waitForTimeout(1500);
  ck('xlsx 表格预览', (await page.locator('.doc-zone .doc-html td').count()) > 0 && (await page.locator('.doc-zone').innerText()).includes('小明'));
  // jpg 预览
  await page.locator('.tree .row', { hasText: '插图.jpg' }).click();
  await page.waitForTimeout(800);
  ck('jpg 图片预览', (await page.locator('.doc-zone .doc-img').count()) === 1);
  // flv 播放（flv.js MSE 解码，走 206 Range 分段）
  await page.locator('.tree .row', { hasText: '英语' }).first().click();
  await page.waitForTimeout(800);
  await page.locator('.tree .row', { hasText: '教学.flv' }).click();
  await page.waitForSelector('.player-zone video', { timeout: 15000 });
  await page.waitForFunction(() => { const v = document.querySelector('.player-zone video'); return v && v.currentTime > 0.3; }, null, { timeout: 25000 });
  ck('flv 实际播放中（flv.js）', true);
  await page.screenshot({ path: 'Logs/vstudy-flv.png' });

  // ===== 视频学习记录页 =====
  await page.locator('.tabs button', { hasText: '视频学习记录' }).click();
  await page.waitForSelector('.vlog');
  await page.waitForTimeout(800);
  const rows = await page.locator('.rec-table tbody tr').allInnerTexts();
  ck('记录出现 4 行', rows.length === 4, String(rows.length));
  ck('序号列从 1 开始', rows[0].split('\t')[0].trim() === '1');
  ck('姓名在最前', rows.some((r) => r.includes(admin.display_name || admin.username)), admin.display_name || admin.username);
  ck('完整路径展示', rows.some((r) => r.includes('第一课.mp4') && r.includes(TEST_ROOT.split('\\').pop())));
  ck('媒体行带进度条', (await page.locator('.rec-table .p-bar').count()) === 1);
  ck('文档行显示打开时间', rows.some((r) => r.includes('打开于')));
  ck('看板学科学时', (await page.locator('.stat-col').nth(1).innerText()).includes('语文'));
  ck('默认每页 15', (await page.locator('.pager select').inputValue()) === '15');

  console.log(`\nUI ${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  await browser.close();
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  db.prepare('DELETE FROM vstudy_records WHERE user_id=?').run(admin.id);
}
