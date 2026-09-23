// UI 冒烟（v1.5.10）：效率工具默认落点=录音转写（tab 排第一）+ 列表「转写耗时」改名 + 操作列挪到序号后
// 只读断言，不产生任何数据
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
const BASE = 'http://localhost:3000';
const errors = [];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript((t) => { localStorage.setItem('wb_token', t); }, [token]);
  await page.addInitScript((u) => { localStorage.setItem('wb_user', u); }, [JSON.stringify({ id: admin.id, username: admin.username, role: 'admin', allowed_pages: [], allowed_tabs: {} })]);

  // 1) 进效率工具（不带 ?tab）：默认应落在录音转写
  await page.goto(BASE + '/#/tools');
  await page.waitForSelector('.tabs button', { timeout: 15000 });
  await page.waitForTimeout(1200); // App 启动抖动跨过
  const tabs = await page.$$eval('.tabs button', (bs) => bs.map((b) => b.textContent.trim()));
  ck('tab 顺序第一个=录音转写', tabs[0] === '录音转写', JSON.stringify(tabs.slice(0, 3)));
  const firstActive = await page.$eval('.tabs button', (b) => b.classList.contains('active'));
  ck('默认落在录音转写（active）', firstActive);
  ck('URL 未带 tab 参数（真默认）', !page.url().includes('tab='), page.url());
  ck('录音转写面板渲染', (await page.locator('h3:has-text("录音文件列表")').count()) === 1);

  // 2) 表头：序号后是操作；撰写耗时→转写耗时；操作不再在末尾
  await page.waitForSelector('.tbl thead th', { timeout: 10000 });
  const ths = await page.$$eval('.tbl thead th', (ts) => ts.map((t) => t.textContent.trim()));
  ck('第 2 列=操作', ths[1] === '操作', JSON.stringify(ths));
  ck('含「转写耗时」列', ths.includes('转写耗时'));
  ck('无「撰写耗时」残留', !ths.includes('撰写耗时'));
  ck('末列=文件路径（操作已挪走）', ths[ths.length - 1] === '文件路径', ths[ths.length - 1]);

  // 3) 数据行：序号后的第二格是 4 个操作按钮
  const rows = await page.$$('.tbl tbody tr');
  if (rows.length) {
    const tds = await rows[0].$$eval('td', (ts) => ts.map((t) => t.textContent.trim()));
    const btns = await rows[0].$$eval('td:nth-child(2) button', (bs) => bs.map((b) => b.textContent.trim()));
    ck('首行第 2 格含 4 个操作按钮', btns.length === 4 && ['转写', '下载', '播放', '删除'].every((x) => btns.includes(x)), JSON.stringify(btns));
    ck('第 2 格不再是中文姓名', !/录音|上传/.test(tds[1] || ''), tds[1]);
  } else {
    console.log('  （本地无录音行，行级断言跳过）');
  }

  // 4) 深链仍可用：?tab=clip 落剪贴板
  await page.goto(BASE + '/#/tools?tab=clip');
  await page.waitForTimeout(900);
  const clipActive = await page.$$eval('.tabs button', (bs) => bs.find((b) => b.textContent.trim() === '剪贴板')?.classList.contains('active') || false);
  ck('?tab=clip 深链仍落剪贴板', clipActive);

  ck('零 pageerror', errors.length === 0, errors.join(' | '));
} finally {
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  db.close();
  await browser.close();
}
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
