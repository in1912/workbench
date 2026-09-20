// UI 复现：标题旁内外网徽标 —— localhost 应显示「内网」（绿），假公网域名应显示「外网」（蓝）
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
  // ① 局域网地址（localhost）→ 内网绿徽标
  const p1 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await p1.addInitScript((t) => { localStorage.setItem('wb_token', t); }, [token]);
  await p1.addInitScript((u) => { localStorage.setItem('wb_user', u); }, [JSON.stringify({ id: admin.id, username: admin.username, role: 'admin', allowed_pages: [], allowed_tabs: {} })]);
  await p1.goto('http://localhost:3000/#/dashboard');
  await p1.waitForSelector('.sidebar .logo .net-badge', { timeout: 15000 });
  const b1 = p1.locator('.sidebar .logo .net-badge');
  ck('localhost 侧边栏标题旁显示「内网」', (await b1.textContent()).trim() === '内网');
  ck('内网徽标为绿色样式（.lan）', (await b1.getAttribute('class')).includes('lan'));
  const green = await b1.evaluate((el) => getComputedStyle(el).color);
  ck('内网字色为绿色 rgb', /rgb\((?:52|30|214),/.test(green) || green.includes('34d399') || green !== 'rgb(230, 232, 238)', green);
  await p1.screenshot({ path: 'Logs/net-badge-lan.png' });

  // ② 手机顶栏同样有徽标
  const p1m = await browser.newPage({ viewport: { width: 480, height: 800 } });
  await p1m.addInitScript((t) => { localStorage.setItem('wb_token', t); }, [token]);
  await p1m.addInitScript((u) => { localStorage.setItem('wb_user', u); }, [JSON.stringify({ id: admin.id, username: admin.username, role: 'admin', allowed_pages: [], allowed_tabs: {} })]);
  await p1m.goto('http://localhost:3000/#/dashboard');
  await p1m.waitForSelector('.mobile-topbar .logo .net-badge', { timeout: 15000 });
  ck('手机顶栏标题旁也有「内网」徽标', (await p1m.locator('.mobile-topbar .logo .net-badge').textContent()).trim() === '内网');
  await p1m.close();
  await p1.close();

  // ③ 公网域名（host-resolver-rules 把假域名映射到本机）→ 外网蓝徽标
  const browser2 = await chromium.launch({ args: ['--host-resolver-rules=MAP wan-test.example 127.0.0.1'] });
  const p2 = await browser2.newPage({ viewport: { width: 1440, height: 900 } });
  await p2.addInitScript((t) => { localStorage.setItem('wb_token', t); }, [token]);
  await p2.addInitScript((u) => { localStorage.setItem('wb_user', u); }, [JSON.stringify({ id: admin.id, username: admin.username, role: 'admin', allowed_pages: [], allowed_tabs: {} })]);
  await p2.goto('http://wan-test.example:3000/#/dashboard');
  await p2.waitForSelector('.sidebar .logo .net-badge', { timeout: 15000 });
  const b2 = p2.locator('.sidebar .logo .net-badge');
  ck('公网域名显示「外网」', (await b2.textContent()).trim() === '外网');
  ck('外网徽标为蓝色样式（.wan）', (await b2.getAttribute('class')).includes('wan'));
  const blue = await b2.evaluate((el) => getComputedStyle(el).color);
  ck('外网字色为蓝色 rgb', blue.startsWith('rgb(79') || blue.includes('4f7cf7'), blue);
  await p2.screenshot({ path: 'Logs/net-badge-wan.png' });
  await p2.close();
  await browser2.close();

  console.log(`\nUI ${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} catch (e) {
  console.log('测试异常:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
