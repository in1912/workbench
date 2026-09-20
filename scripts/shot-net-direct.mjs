// UI 复现：本地直连自动探测 —— 无论域名/IP 登录，后台探测设置的内网地址，可达即自动走内网。
// ① 公网域名登录 + 内网地址可达(127.0.0.1:3100 假 NAS) → 徽标变绿「内网」；学习页文档 fileUrl 走内网源
// ② 公网域名登录 + 内网地址不可达(127.0.0.1:3999) → 徽标蓝「外网」；文档回落当前源，通道显示「公网通道」
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';

const ROOT = 'D:/CC/tmp-vstudy-test';
fs.mkdirSync(ROOT, { recursive: true });
fs.writeFileSync(ROOT + '/sample.png', Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

// 假 NAS（内网直连目标）：/api/health 探测应答 + /api/vstudy/file 回图（均带 ACAO *）
const PNG = fs.readFileSync(ROOT + '/sample.png');
const stub = http.createServer((q, s) => {
  if (q.url.startsWith('/api/health')) {
    s.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' });
    s.end('{"ok":true}');
  } else if (q.url.startsWith('/api/vstudy/file')) {
    s.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'image/png' });
    s.end(PNG);
  } else { s.writeHead(404); s.end(); }
});
await new Promise((r) => stub.listen(3100, '127.0.0.1', r));

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const admin = db.prepare("SELECT id, username FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const token = crypto.randomBytes(32).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+20 minutes'))").run(token, admin.id);
const origRoot = db.prepare("SELECT value FROM settings WHERE key='vstudy_root'").get();
const origBase = db.prepare("SELECT value FROM settings WHERE key='local_base_url'").get();
const setS = (k, v) => db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)").run(k, v);
setS('vstudy_root', ROOT);

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };
const USER = JSON.stringify({ id: admin.id, username: admin.username, role: 'admin', allowed_pages: [], allowed_tabs: {} });

// 公网域名浏览器：host-resolver-rules 把假公网域名映射到本机
const wan = await chromium.launch({ args: ['--host-resolver-rules=MAP wan-test.example 127.0.0.1'] });
try {
  // ① 内网地址可达 → 徽标绿「内网」+ 文件走内网源
  setS('local_base_url', 'http://127.0.0.1:3100');
  const p1 = await wan.newPage({ viewport: { width: 1440, height: 900 } });
  await p1.addInitScript((t) => { localStorage.setItem('wb_token', t); }, [token]);
  await p1.addInitScript((u) => { localStorage.setItem('wb_user', u); }, [USER]);
  await p1.goto('http://wan-test.example:3000/#/dashboard');
  await p1.waitForSelector('.sidebar .logo .net-badge.lan', { timeout: 15000 });
  const b1 = p1.locator('.sidebar .logo .net-badge');
  ck('域名登录+内网可达：徽标显示「内网」', (await b1.textContent()).trim() === '内网');
  ck('徽标为绿色样式（.lan）', (await b1.getAttribute('class')).includes('lan'));
  const c1 = await p1.evaluate(() => JSON.parse(sessionStorage.getItem('wb_local_base') || 'null'));
  ck('探测缓存记录可达', !!(c1 && c1.ok && c1.base === 'http://127.0.0.1:3100'), JSON.stringify(c1));
  await p1.screenshot({ path: 'Logs/net-direct-wan-badge.png' });

  // 学习页：文档 fileUrl 应走内网源
  await p1.goto('http://wan-test.example:3000/#/learning?tab=vstudy');
  await p1.click('.big-start');
  await p1.click('.big-grid .big-btn >> nth=0');   // 选学年
  await p1.click('.big-grid .big-btn >> nth=0');   // 选学科 → 进入学习界面（目录树自动展开）
  await p1.waitForSelector('.vs-head .lb.ok', { timeout: 15000 });
  ck('学习页通道显示「本地直连」', (await p1.locator('.vs-head .lb.ok').textContent()).includes('本地直连'));
  await p1.click('.tree-children .row.doc >> nth=0');  // 打开 sample.png（文档预览区）
  await p1.waitForSelector('.doc-img', { timeout: 15000 });
  const s1 = await p1.locator('.doc-img').getAttribute('src');
  ck('文档地址已走内网直连源', s1.startsWith('http://127.0.0.1:3100/api/vstudy/file'), s1);
  await p1.screenshot({ path: 'Logs/net-direct-file.png' });
  await p1.close();

  // ② 内网地址不可达 → 徽标蓝「外网」+ 文档回落当前源
  setS('local_base_url', 'http://127.0.0.1:3999');   // 无进程监听
  const p2 = await wan.newPage({ viewport: { width: 1440, height: 900 } });
  await p2.addInitScript((t) => { localStorage.setItem('wb_token', t); }, [token]);
  await p2.addInitScript((u) => { localStorage.setItem('wb_user', u); }, [USER]);
  await p2.goto('http://wan-test.example:3000/#/dashboard');
  await p2.waitForSelector('.sidebar .logo .net-badge.wan', { timeout: 15000 });
  ck('域名登录+内网不可达：徽标显示「外网」', (await p2.locator('.sidebar .logo .net-badge').textContent()).trim() === '外网');
  // 徽标 .wan 是初始默认态，等后台探测真正落缓存后再校验（连接被拒很快，但仍是异步）
  await p2.waitForFunction(() => !!sessionStorage.getItem('wb_local_base'), null, { timeout: 10000 });
  const c2 = await p2.evaluate(() => JSON.parse(sessionStorage.getItem('wb_local_base') || 'null'));
  ck('探测缓存记录不可达', !!(c2 && !c2.ok), JSON.stringify(c2));

  await p2.goto('http://wan-test.example:3000/#/learning?tab=vstudy');
  await p2.click('.big-start');
  await p2.click('.big-grid .big-btn >> nth=0');
  await p2.click('.big-grid .big-btn >> nth=0');
  await p2.waitForSelector('.vs-head .lb:not(.ok)', { timeout: 15000 });
  ck('学习页通道显示「公网通道」', (await p2.locator('.vs-head .lb:not(.ok)').textContent()).includes('公网通道'));
  await p2.click('.tree-children .row.doc >> nth=0');
  await p2.waitForSelector('.doc-img', { timeout: 15000 });
  const s2 = await p2.locator('.doc-img').getAttribute('src');
  ck('文档回落当前访问源（相对地址=当前源）', s2.startsWith('/api/vstudy/file'), s2);
  await p2.close();

  console.log(`\nUI ${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} catch (e) {
  console.log('测试异常:', e.message);
  process.exitCode = 1;
} finally {
  await wan.close();
  stub.close();
  db.prepare("DELETE FROM settings WHERE key='vstudy_root'").run();
  if (origRoot) db.prepare("INSERT INTO settings(key,value) VALUES('vstudy_root',?)").run(origRoot.value);
  db.prepare("DELETE FROM settings WHERE key='local_base_url'").run();
  if (origBase) db.prepare("INSERT INTO settings(key,value) VALUES('local_base_url',?)").run(origBase.value);
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
