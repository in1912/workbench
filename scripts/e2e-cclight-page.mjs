// E2E：「Agent红绿灯」独立页（v1.9.22，从智能家居子 tab 升格）
// API：pageForPath('/cclight')=cclight → admin 200；迁移（重启触发 db.js 幂等迁移）：
//   u1（pages=smarthome + tabs.smarthome 含 cclight）→ 补 cclight 页 + tabs.cclight 三键 + smarthome 死键清除；
//   u3（pages=smarthome + tabs 不含 cclight）→ 不补页；u1 可达 /cclight/files、u3 403。
// UI：三个子 tab（功能介绍含示例图与灯效表 / 下载安装包含子文件清单 / 安装步骤含 ①刷版②钩子③蓝牙配对 与参考文档）；
//   旧深链 /smart-home?tab=cclight 重定向 /cc-light；智能家居页不再有 Agent红绿灯 tab；侧栏有独立入口。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'tmp-cclight-e2e');
const PORT = 3999;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  <<< ' + extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const boot = async () => {
  const s = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456', TTS_ROOT: path.join(DATA, 'no-tts') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.stdout.on('data', () => {});
  s.stderr.on('data', (d) => console.error('[srv-err]', String(d).slice(0, 200)));
  // 就绪探测：轮询 /api/auth/login 的 401/400（连得上即可）——固定 sleep 在冷启动机器上不可靠
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); return s; } catch { /* 未就绪 */ }
  }
  throw new Error('server not ready in 20s');
};

let srv, browser;
try {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  // ---------- 第一阶段：建用户（旧授权形态），admin 探 API ----------
  srv = await boot();
  const HJ = { 'Content-Type': 'application/json' };
  let lj = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: HJ, body: JSON.stringify({ username: 'admin', password: 'test123456' }) })).json();
  const A = { ...HJ, Authorization: 'Bearer ' + lj.token };

  // 模拟 v1.9.21 形态的用户：u1 开了 smarthome 页且勾过 cclight 子 tab；u3 开了 smarthome 页但没勾 cclight
  await fetch(`${B}/api/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'u1', password: 'u123456', allowed_pages: ['smarthome'], allowed_tabs: { smarthome: ['mijia', 'cclight'] } }) });
  await fetch(`${B}/api/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'u3', password: 'u345678', allowed_pages: ['smarthome'], allowed_tabs: { smarthome: ['mijia'] } }) });

  let r = await fetch(`${B}/api/cclight/files`, { headers: A });
  let j = await r.json();
  ck('A1 admin /cclight/files 200 且清单非空', r.status === 200 && Array.isArray(j.files) && j.files.length > 0, `status=${r.status}`);

  // ---------- 第二阶段：植入 v1.9.21 旧形态授权（API 建不成——新 sanitizeTabs 会剥掉 smarthome.cclight 死键）→ 重启触发迁移 ----------
  srv.kill();
  await sleep(900);
  {
    const { DatabaseSync } = await import('node:sqlite');
    const sdb = new DatabaseSync(path.join(DATA, 'workbench.sqlite'));
    sdb.prepare("UPDATE users SET allowed_pages='[\"smarthome\"]', allowed_tabs='{\"smarthome\":[\"mijia\",\"cclight\"]}' WHERE username='u1'").run();
    sdb.prepare("UPDATE users SET allowed_pages='[\"smarthome\"]', allowed_tabs='{\"smarthome\":[\"mijia\"]}' WHERE username='u3'").run();
    // 第一阶段启动已消费过迁移 guard——删掉才等价于「刚从 v1.9.21 升上来的旧库」
    sdb.prepare("DELETE FROM settings WHERE key='cclight_page_v1922'").run();
    sdb.close();
  }
  srv = await boot();

  r = await fetch(`${B}/api/users`, { headers: A });
  const users = await r.json();
  const g = (n) => (Array.isArray(users) ? users : users.users || []).find((x) => x.username === n);
  const u1 = g('u1'), u3 = g('u3');
  ck('B1 u1 迁移后补上 cclight 页（紧随 smarthome）', Array.isArray(u1?.allowed_pages) && u1.allowed_pages.includes('cclight') && u1.allowed_pages.indexOf('cclight') === u1.allowed_pages.indexOf('smarthome') + 1, JSON.stringify(u1?.allowed_pages));
  ck('B2 u1 tabs.cclight = 三子 tab 全开', Array.isArray(u1?.allowed_tabs?.cclight) && u1.allowed_tabs.cclight.join(',') === 'intro,download,install', JSON.stringify(u1?.allowed_tabs));
  ck('B3 u1 tabs.smarthome 死键已清（只余 mijia）', Array.isArray(u1?.allowed_tabs?.smarthome) && u1.allowed_tabs.smarthome.join(',') === 'mijia', JSON.stringify(u1?.allowed_tabs?.smarthome));
  ck('B4 u3（原本没勾 cclight）不补页', Array.isArray(u3?.allowed_pages) && !u3.allowed_pages.includes('cclight'), JSON.stringify(u3?.allowed_pages));

  const t1 = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: HJ, body: JSON.stringify({ username: 'u1', password: 'u123456' }) })).json();
  const t3 = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: HJ, body: JSON.stringify({ username: 'u3', password: 'u345678' }) })).json();
  r = await fetch(`${B}/api/cclight/files`, { headers: { Authorization: 'Bearer ' + t1.token } });
  ck('B5 u1（迁得 cclight 页）200', r.status === 200, `status=${r.status}`);
  r = await fetch(`${B}/api/cclight/files`, { headers: { Authorization: 'Bearer ' + t3.token } });
  ck('B6 u3（无 cclight 页）403', r.status === 403, `status=${r.status}`);

  // 保存回路：新形态三子 tab 能存住（sanitizeTabs 按 TAB_PATHS 过滤，缺键会被剥）
  const u1id = u1.id;
  r = await fetch(`${B}/api/users/${u1id}`, { method: 'PUT', headers: A, body: JSON.stringify({ allowed_pages: ['cclight'], allowed_tabs: { cclight: ['intro', 'download'] } }) });
  ck('B7 PUT 新形态授权 200', r.status === 200, `status=${r.status}`);
  const u1b = (await (await fetch(`${B}/api/users`, { headers: A })).json()).find((x) => x.id === u1id);
  ck('B8 回读 tabs.cclight 保留 2 键', Array.isArray(u1b?.allowed_tabs?.cclight) && u1b.allowed_tabs.cclight.join(',') === 'intro,download', JSON.stringify(u1b?.allowed_tabs));

  // ---------- 第三阶段：UI ----------
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addInitScript((t) => { localStorage.setItem('wb_token', t); }, lj.token);
  await ctx.addInitScript((u) => { localStorage.setItem('wb_user', u); }, JSON.stringify(lj.user));
  const p = await ctx.newPage();

  await p.goto(`${B}/#/cc-light`);
  await p.waitForSelector('.page-title');
  ck('C1 页标题 + 三个子 tab', (await p.locator('h2.page-title').innerText()) === 'Agent红绿灯' && await p.locator('.tabs button').count() === 3, await p.locator('.tabs').innerText());
  ck('C2 子 tab 顺序 = 功能介绍/下载安装包/安装步骤', (await p.locator('.tabs button').allInnerTexts()).join('|') === '功能介绍|下载安装包|安装步骤');
  await p.waitForSelector('img.cc-demo');
  ck('C3 功能介绍含示例图与灯效对照表', (await p.locator('img.cc-demo').count()) === 1 && (await p.locator('table.cc-table').first().innerText()).includes('轮播演示'));
  await p.screenshot({ path: path.join(ROOT, 'Logs', 'e2e-cclight-intro.png'), fullPage: true });

  await p.locator('.tabs button', { hasText: '下载安装包' }).click();
  await p.waitForSelector('.cc-file');
  ck('C4 下载页：子文件清单渲染（文件名+大小+下载按钮）', await p.locator('.cc-file').count() > 5 && (await p.locator('.cc-file').first().innerText()).includes('KB'));
  ck('C5 下载页：Windows/macOS 打包按钮', await p.locator('button', { hasText: '打包下载（Windows' }).count() === 1 && await p.locator('button', { hasText: '打包下载（macOS' }).count() === 1);

  await p.locator('.tabs button', { hasText: '安装步骤' }).click();
  const installTxt = await p.evaluate(() => document.body.innerText);
  ck('C6 安装页：① 怎么刷版', installTxt.includes('① 怎么刷版') && installTxt.includes('flash-firmware.cmd'));
  ck('C7 安装页：② 怎么装电脑中的钩子', installTxt.includes('② 怎么装电脑中的钩子') && installTxt.includes('cc-light-install-all.cmd'));
  ck('C8 安装页：③ 蓝牙配对（无需系统配对说明）', installTxt.includes('③ 怎么做板子的蓝牙配对') && installTxt.includes('Agent light'));
  ck('C9 安装页：参考文档（外链 ≥ 5 条）', await p.locator('.cc-refs a').count() >= 5);
  await p.screenshot({ path: path.join(ROOT, 'Logs', 'e2e-cclight-install.png'), fullPage: true });

  // 旧深链重定向
  await p.goto(`${B}/#/smart-home?tab=cclight`);
  await p.waitForSelector('h2.page-title');
  await sleep(600);
  ck('C10 旧深链 /smart-home?tab=cclight → /cc-light', p.url().includes('#/cc-light'), p.url());

  // 智能家居页不再有 Agent红绿灯 tab
  await p.goto(`${B}/#/smart-home?tab=mijia`);
  await p.waitForSelector('.tabs button');
  ck('C11 智能家居页无 Agent红绿灯 tab', await p.locator('.tabs button', { hasText: 'Agent红绿灯' }).count() === 0, await p.locator('.tabs').innerText());

  // 侧栏独立入口
  ck('C12 侧栏有「Agent红绿灯」入口', await p.locator('a').filter({ hasText: 'Agent红绿灯' }).count() >= 1, '侧栏未找到链接');

  // 受限成员（只剩 intro/download）：不见安装步骤 tab（重新登录拿 B7 改权后的新 user 对象）
  const t1b = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: HJ, body: JSON.stringify({ username: 'u1', password: 'u123456' }) })).json();
  const ctx2 = await browser.newContext();
  await ctx2.addInitScript((t) => { localStorage.setItem('wb_token', t); }, t1b.token);
  await ctx2.addInitScript((u) => { localStorage.setItem('wb_user', u); }, JSON.stringify(t1b.user));
  const p2 = await ctx2.newPage();
  await p2.goto(`${B}/#/cc-light`);
  await p2.waitForSelector('.tabs button');
  ck('C13 u1 只见授权的 2 个子 tab（无安装步骤）', await p2.locator('.tabs button').count() === 2 && await p2.locator('.tabs button', { hasText: '安装步骤' }).count() === 0, await p2.locator('.tabs').innerText());

  console.log(`\n== Agent红绿灯独立页 e2e: ${pass} 通过 / ${fail} 失败 ==`);
} catch (e) {
  fail++;
  console.error('e2e 异常：', e);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (srv) srv.kill();
  await sleep(700);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
}
process.exit(fail ? 1 : 0);
