// E2E：「Agent红绿灯」放回智能家居页 cclight 子 tab（v1.9.23，v1.9.22 曾升格独立页后回迁）
// API：pageForPath('/cclight')=smarthome + TAB_PATHS.smarthome.cclight → 单 tab 语义：
//   开 smarthome 页 + 勾 cclight → /cclight/files 200；没勾 → 403。
// 反向迁移（重启触发 db.js 幂等迁移 cclight_back_v1923）植入 v1.9.22 形态验证授权回平：
//   u1 pages=[smarthome,cclight]+tabs{smarthome:[mijia],cclight:[3子]} → [smarthome]+smarthome:[mijia,cclight]；
//   u2 pages=[cclight]+tabs{cclight:[intro]} → [smarthome]+smarthome:[cclight]（补页只给单 tab 不扩权）；
//   u3 cclight:[]（空细分=原本不可见）→ 不平移 cclight；u4 页外死键 tabs.cclight → 删除不补页。
// UI：智能家居页 5 个 tab（Agent红绿灯在智能板之后）、面板三段子 tab（localStorage.cc_sub 记忆）、
//   旧地址 /cc-light 重定向 /smart-home?tab=cclight、侧栏无独立入口。
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

  // ---------- 第一阶段：建用户（v1.9.23 形态：cclight 是 smarthome 的合法 tab 键）----------
  srv = await boot();
  const HJ = { 'Content-Type': 'application/json' };
  let lj = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: HJ, body: JSON.stringify({ username: 'admin', password: 'test123456' }) })).json();
  const A = { ...HJ, Authorization: 'Bearer ' + lj.token };

  // uA：开 smarthome 页 + 勾 cclight（新形态能建能存——sanitizeTabs 按 TAB_PATHS.smarthome 认这个键）
  await fetch(`${B}/api/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'uA', password: 'ua123456', allowed_pages: ['smarthome'], allowed_tabs: { smarthome: ['mijia', 'cclight'] } }) });
  // uB：开 smarthome 页但没勾 cclight
  await fetch(`${B}/api/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'uB', password: 'ub123456', allowed_pages: ['smarthome'], allowed_tabs: { smarthome: ['mijia'] } }) });
  // uC/uD：先按新形态建号（第二阶段服务已停，用 sqlite 植入 v1.9.22 形态覆盖）
  await fetch(`${B}/api/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'uC', password: 'uc123456', allowed_pages: ['smarthome'], allowed_tabs: { smarthome: ['mijia'] } }) });
  await fetch(`${B}/api/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'uD', password: 'ud123456', allowed_pages: ['smarthome'], allowed_tabs: { smarthome: ['mijia'] } }) });

  let r = await fetch(`${B}/api/cclight/files`, { headers: A });
  let j = await r.json();
  ck('A1 admin /cclight/files 200 且清单非空', r.status === 200 && Array.isArray(j.files) && j.files.length > 0, `status=${r.status}`);

  const tA = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: HJ, body: JSON.stringify({ username: 'uA', password: 'ua123456' }) })).json();
  const tB = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: HJ, body: JSON.stringify({ username: 'uB', password: 'ub123456' }) })).json();
  r = await fetch(`${B}/api/cclight/files`, { headers: { Authorization: 'Bearer ' + tA.token } });
  ck('A2 uA（smarthome.cclight）200', r.status === 200, `status=${r.status}`);
  r = await fetch(`${B}/api/cclight/files`, { headers: { Authorization: 'Bearer ' + tB.token } });
  ck('A3 uB（smarthome 无 cclight 键）403', r.status === 403, `status=${r.status}`);

  r = await fetch(`${B}/api/users`, { headers: A });
  const usersArr = await r.json();
  const uA0 = (Array.isArray(usersArr) ? usersArr : usersArr.users || []).find((x) => x.username === 'uA');
  ck('A4 新形态授权存得住（smarthome 含 cclight 键）', Array.isArray(uA0?.allowed_tabs?.smarthome) && uA0.allowed_tabs.smarthome.includes('cclight'), JSON.stringify(uA0?.allowed_tabs));

  // ---------- 第二阶段：植入 v1.9.22 形态授权（独立页）→ 重启触发反向迁移 ----------
  srv.kill();
  await sleep(900);
  {
    const { DatabaseSync } = await import('node:sqlite');
    const sdb = new DatabaseSync(path.join(DATA, 'workbench.sqlite'));
    const set = (n, pages, tabs) => sdb.prepare('UPDATE users SET allowed_pages=?, allowed_tabs=? WHERE username=?').run(JSON.stringify(pages), JSON.stringify(tabs), n);
    set('uA', ['smarthome', 'cclight'], { smarthome: ['mijia'], cclight: ['intro', 'download', 'install'] }); // 升格迁移的典型产物
    set('uB', ['cclight'], { cclight: ['intro'] });                                                       // 只开过独立页
    set('uC', ['smarthome', 'cclight'], { smarthome: ['mijia'], cclight: [] });                           // 空细分=内容本就不可见
    set('uD', ['smarthome'], { smarthome: ['mijia'], cclight: ['intro'] });                               // 页外死键
    // 第一阶段启动已消费过迁移 guard——删掉才等价于「刚从 v1.9.22 升上来的旧库」
    sdb.prepare("DELETE FROM settings WHERE key='cclight_back_v1923'").run();
    sdb.close();
  }
  srv = await boot();

  r = await fetch(`${B}/api/users`, { headers: A });
  const us = await r.json();
  const g = (n) => (Array.isArray(us) ? us : us.users || []).find((x) => x.username === n);
  const uA = g('uA'), uB = g('uB'), uC = g('uC'), uD = g('uD');

  ck('B1 uA 独立页剥除、cclight 平移进 smarthome 细分', JSON.stringify(uA?.allowed_pages) === '["smarthome"]' && uA?.allowed_tabs?.smarthome?.join(',') === 'mijia,cclight' && !('cclight' in (uA?.allowed_tabs || {})), JSON.stringify(uA?.allowed_pages) + ' ' + JSON.stringify(uA?.allowed_tabs));
  ck('B2 uB 补 smarthome 页且只给 cclight 单 tab（不扩权）', JSON.stringify(uB?.allowed_pages) === '["smarthome"]' && uB?.allowed_tabs?.smarthome?.join(',') === 'cclight', JSON.stringify(uB?.allowed_pages) + ' ' + JSON.stringify(uB?.allowed_tabs));
  ck('B3 uC 空细分不平移（内容本就不可见）', JSON.stringify(uC?.allowed_pages) === '["smarthome"]' && uC?.allowed_tabs?.smarthome?.join(',') === 'mijia' && !('cclight' in (uC?.allowed_tabs || {})), JSON.stringify(uC?.allowed_tabs));
  ck('B4 uD 页外死键删除、其余不动', JSON.stringify(uD?.allowed_pages) === '["smarthome"]' && uD?.allowed_tabs?.smarthome?.join(',') === 'mijia' && !('cclight' in (uD?.allowed_tabs || {})), JSON.stringify(uD?.allowed_tabs));

  const tA2 = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: HJ, body: JSON.stringify({ username: 'uA', password: 'ua123456' }) })).json();
  const tB2 = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: HJ, body: JSON.stringify({ username: 'uB', password: 'ub123456' }) })).json();
  const tC2 = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: HJ, body: JSON.stringify({ username: 'uC', password: 'uc123456' }) })).json();
  r = await fetch(`${B}/api/cclight/files`, { headers: { Authorization: 'Bearer ' + tA2.token } });
  ck('B5 uA 迁移后仍可下载（200）', r.status === 200, `status=${r.status}`);
  r = await fetch(`${B}/api/cclight/files`, { headers: { Authorization: 'Bearer ' + tB2.token } });
  ck('B6 uB 迁移后仍可下载（200）', r.status === 200, `status=${r.status}`);
  r = await fetch(`${B}/api/cclight/files`, { headers: { Authorization: 'Bearer ' + tC2.token } });
  ck('B7 uC 迁移后依旧不可见（403）', r.status === 403, `status=${r.status}`);

  // ---------- 第三阶段：UI ----------
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addInitScript((t) => { localStorage.setItem('wb_token', t); }, lj.token);
  await ctx.addInitScript((u) => { localStorage.setItem('wb_user', u); }, JSON.stringify(lj.user));
  const p = await ctx.newPage();

  await p.goto(`${B}/#/smart-home?tab=cclight`);
  await p.waitForSelector('.page-title');
  ck('C1 智能家居页 5 个 tab，Agent红绿灯在智能板之后', (await p.locator('h2.page-title').innerText()) === '智能家居'
    && (await p.locator('.tabs button').allInnerTexts()).join('|') === '米家|参数翻译|智能板|Agent红绿灯|设置', await p.locator('.tabs').innerText());
  ck('C2 Agent红绿灯按钮处于激活态', (await p.locator('.tabs button.active').innerText()) === 'Agent红绿灯');

  await p.waitForSelector('.ccp-tabs button');
  ck('C3 面板三段子 tab（功能介绍/下载安装包/安装步骤）', (await p.locator('.ccp-tabs button').allInnerTexts()).map((t) => t.trim().replace(/^[^一-龥A-Za-z0-9]+\s*/, '')).join('|') === '功能介绍|下载安装包|安装步骤', await p.locator('.ccp-tabs').innerText());
  await p.waitForSelector('img.cc-demo');
  ck('C4 功能介绍含示例图与灯效对照表', (await p.locator('img.cc-demo').count()) === 1 && (await p.locator('table.cc-table').first().innerText()).includes('轮播演示'));
  await p.screenshot({ path: path.join(ROOT, 'Logs', 'e2e-cclight-intro.png'), fullPage: true });

  await p.locator('.ccp-tabs button', { hasText: '下载安装包' }).click();
  await p.waitForSelector('.cc-file');
  ck('C5 下载页：子文件清单渲染 + 双打包按钮', await p.locator('.cc-file').count() > 5 && (await p.locator('.cc-file').first().innerText()).includes('KB')
    && await p.locator('button', { hasText: '打包下载（Windows' }).count() === 1 && await p.locator('button', { hasText: '打包下载（macOS' }).count() === 1);

  await p.locator('.ccp-tabs button', { hasText: '安装步骤' }).click();
  const installTxt = await p.evaluate(() => document.body.innerText);
  ck('C6 安装页：① 刷版 / ② 电脑钩子 / ③ 蓝牙配对', installTxt.includes('① 怎么刷版') && installTxt.includes('flash-firmware.cmd')
    && installTxt.includes('② 怎么装电脑中的钩子') && installTxt.includes('③ 怎么做板子的蓝牙配对') && installTxt.includes('Agent light'));
  ck('C7 安装页：参考文档（外链 ≥ 5 条）', await p.locator('.cc-refs a').count() >= 5);
  await p.screenshot({ path: path.join(ROOT, 'Logs', 'e2e-cclight-install.png'), fullPage: true });

  // 子 tab 记忆：切到「下载安装包」刷新仍在该段（localStorage.cc_sub）
  await p.locator('.ccp-tabs button', { hasText: '下载安装包' }).click();
  await p.reload();
  await p.waitForSelector('.cc-file');
  ck('C8 子 tab 用 localStorage 记忆（刷新仍停在下载页）', (await p.locator('.ccp-tabs button.on').innerText()).includes('下载安装包') && await p.locator('.cc-file').count() > 5);

  // 旧地址 /cc-light（v1.9.22 独立页时期的书签）重定向到 /smart-home?tab=cclight
  await p.goto(`${B}/#/cc-light`);
  await p.waitForSelector('.page-title');
  await sleep(600);
  ck('C9 旧地址 /cc-light → /smart-home?tab=cclight', p.url().includes('#/smart-home') && p.url().includes('tab=cclight') && (await p.locator('.tabs button.active').innerText()) === 'Agent红绿灯', p.url());

  // 侧栏不再有独立入口
  ck('C10 侧栏无「Agent红绿灯」独立入口', await p.locator('a').filter({ hasText: 'Agent红绿灯' }).count() === 0, '侧栏仍有链接');

  // 受限成员（uB：只有 cclight 一个 tab）——按钮可见、面板可用、三段全开（单 tab 语义无子段权限）
  const ctx2 = await browser.newContext();
  await ctx2.addInitScript((t) => { localStorage.setItem('wb_token', t); }, tB2.token);
  await ctx2.addInitScript((u) => { localStorage.setItem('wb_user', u); }, JSON.stringify(tB2.user));
  const p2 = await ctx2.newPage();
  await p2.goto(`${B}/#/smart-home`);
  await p2.waitForSelector('.tabs button');
  ck('C11 uB 只见授权的 Agent红绿灯 tab（无米家/设置）', (await p2.locator('.tabs button').allInnerTexts()).join('|') === 'Agent红绿灯', await p2.locator('.tabs').innerText());
  await p2.locator('.tabs button', { hasText: 'Agent红绿灯' }).click();
  await p2.waitForSelector('.ccp-tabs button');
  ck('C12 uB 面板三段全开（单 tab 语义）', await p2.locator('.ccp-tabs button').count() === 3, await p2.locator('.ccp-tabs').innerText());

  // 未授权成员（uC）：无按钮（API 403 已在 B7 验证）
  const ctx3 = await browser.newContext();
  await ctx3.addInitScript((t) => { localStorage.setItem('wb_token', t); }, tC2.token);
  await ctx3.addInitScript((u) => { localStorage.setItem('wb_user', u); }, JSON.stringify(tC2.user));
  const p3 = await ctx3.newPage();
  await p3.goto(`${B}/#/smart-home`);
  await p3.waitForSelector('.tabs button');
  ck('C13 uC 不见 Agent红绿灯按钮', await p3.locator('.tabs button', { hasText: 'Agent红绿灯' }).count() === 0, await p3.locator('.tabs').innerText());

  console.log(`\n== Agent红绿灯回迁智能家居 e2e: ${pass} 通过 / ${fail} 失败 ==`);
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
