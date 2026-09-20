// E2E（v1.2.9）：① 学习页受限 tab 可见性——visibleTabs 之前没按 canTab 过滤，
// 兑现登记/视频教学设置对无权限用户可见可点；vsettings 新入受限名单（前后端）。
// ② 宠物养育记录「最近动态」客户端分页（默认 15 行，可切 15/30/50，上下页）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'tmp-perm-pets-e2e');
const PORT = 3999;
const B = `http://127.0.0.1:${PORT}`;

process.env.DATA_DIR = DATA; // 必须在 import server 模块之前

let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  <<< ' + extra}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
const srv = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456', TTS_ROOT: path.join(DATA, 'no-tts') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', (d) => console.error('[srv-err]', String(d).slice(0, 300)));
await sleep(2500);

const login = async (u, p) => (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json();

try {
  // ---------- 管理员建受限用户 lim：学习页开放多个 tab，但不含 vsettings/payout ----------
  const admin = await login('admin', 'test123456');
  const A = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + admin.token };
  await fetch(`${B}/api/emails/attach-config`, { headers: A }); // 摸 req.tdb 惰性建表
  const TABS = { learning: ['dictation', 'practice', 'records', 'money', 'piano', 'wish', 'vlog', 'vledger', 'tts'] };
  let r = await fetch(`${B}/api/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'lim', password: 'Lim123456', role: 'user', allowed_pages: ['learning'], allowed_tabs: TABS }) });
  const limId = (await r.json()).id;
  ck('创建受限用户 lim', r.status === 200 && limId > 0, String(r.status));

  // ---------- API 层：未授权用户打受限接口必须 403 ----------
  const lim = await login('lim', 'Lim123456');
  const L = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lim.token };
  r = await fetch(`${B}/api/typing/payouts`, { headers: L });
  ck('lim 打兑现接口 403（原有受限语义）', r.status === 403, String(r.status));
  r = await fetch(`${B}/api/vstudy/settings`, { method: 'POST', headers: L, body: JSON.stringify({ root: 'D:/nope' }) });
  ck('lim 改视频教学设置 403（vsettings 新受限）', r.status === 403, String(r.status));
  r = await fetch(`${B}/api/typing/records`, { headers: L });
  ck('lim 打字记录仍 200（正常 tab 不受影响）', r.status === 200, String(r.status));

  // ---------- 宠物分页数据：领养 + 直插 18 条动态 ----------
  r = await fetch(`${B}/api/pets`, { method: 'POST', headers: A, body: JSON.stringify({ name: 'E2E猫', species: 'cat', raise_mode: 'family' }) });
  const petId = (await r.json()).id;
  ck('领养测试宠物', r.status === 200 && petId > 0, String(r.status));
  const reqSrv = createRequire(path.join(ROOT, 'server', 'routes', 'petRoutes.js'));
  const { db } = reqSrv('../db');
  const ins = db.prepare('INSERT INTO pet_logs(pet_id,user_id,action,detail,affection_delta) VALUES(?,?,?,?,?)');
  for (let i = 1; i <= 18; i++) ins.run(petId, admin.user.id, 'food', `E2E动态${String(i).padStart(2, '0')}`, 1);

  // ---------- UI ----------
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();

  // ① 未授权用户：tab 按钮不可见 + URL 直达被拦
  const ctx1 = await browser.newContext();
  await ctx1.addInitScript((t) => { localStorage.setItem('wb_token', t); }, lim.token);
  await ctx1.addInitScript((u) => { localStorage.setItem('wb_user', u); }, JSON.stringify(lim.user));
  const p1 = await ctx1.newPage();
  const errs1 = [];
  p1.on('pageerror', (e) => errs1.push(e.message));
  await p1.goto(`${B}/#/learning`);
  await p1.waitForSelector('.tabs button', { timeout: 15000 });
  let btns = await p1.locator('.tabs button').allTextContents();
  ck('lim 看不见「兑现登记」按钮', !btns.some((t) => t.includes('兑现登记')), btns.join(','));
  ck('lim 看不见「视频教学设置」按钮', !btns.some((t) => t.includes('视频教学设置')));
  ck('lim 正常 tab 仍在（听写/打字）', btns.some((t) => t.includes('听写')) && btns.some((t) => t.includes('打字')));
  await p1.goto(`${B}/#/learning?tab=payout`);
  await sleep(800);
  const dp1 = await p1.locator('.payout').count();
  const dp2 = await p1.locator('text=登记已结算兑现').count();
  ck('lim URL 直达兑现登记被拦（面板未渲染）', dp1 === 0 && dp2 === 0, `.payout=${dp1} h3=${dp2} url=${p1.url()}`);
  await ctx1.close();

  // ---------- 授权保存：勾上 payout+vsettings 后可用（须在未授权 UI 断言之后：App 启动会把 wb_user 同步成库内最新授权） ----------
  r = await fetch(`${B}/api/users/${limId}`, { method: 'PUT', headers: A, body: JSON.stringify({ allowed_pages: ['learning'], allowed_tabs: { learning: [...TABS.learning, 'payout', 'vsettings'] } }) });
  ck('更新 lim 授权', r.status === 200, String(r.status));
  const lim2 = await login('lim', 'Lim123456');
  const L2 = { Authorization: 'Bearer ' + lim2.token };
  r = await fetch(`${B}/api/typing/payouts`, { headers: L2 });
  ck('授权后兑现接口 200', r.status === 200, String(r.status));
  r = await fetch(`${B}/api/vstudy/settings`, { method: 'POST', headers: { ...L2, 'Content-Type': 'application/json' }, body: JSON.stringify({ root: 'C:/Windows' }) });
  ck('授权后视频教学设置接口放行', r.status === 200, String(r.status));

  // ② lim 重新登录（已授权）：两个受限 tab 回来
  const ctx2 = await browser.newContext();
  await ctx2.addInitScript((t) => { localStorage.setItem('wb_token', t); }, lim2.token);
  await ctx2.addInitScript((u) => { localStorage.setItem('wb_user', u); }, JSON.stringify(lim2.user));
  const p2 = await ctx2.newPage();
  await p2.goto(`${B}/#/learning?tab=payout`);
  await p2.waitForSelector('.payout', { timeout: 15000 });
  ck('授权后兑现登记面板可进', true);
  btns = await p2.locator('.tabs button').allTextContents();
  ck('授权后「兑现登记」「视频教学设置」按钮都可见', btns.some((t) => t.includes('兑现登记')) && btns.some((t) => t.includes('视频教学设置')), btns.join(','));
  await ctx2.close();

  // ③ admin：全量可见
  const ctx3 = await browser.newContext();
  await ctx3.addInitScript((t) => { localStorage.setItem('wb_token', t); }, admin.token);
  await ctx3.addInitScript((u) => { localStorage.setItem('wb_user', u); }, JSON.stringify(admin.user));
  const p3 = await ctx3.newPage();
  const errs3 = [];
  p3.on('pageerror', (e) => errs3.push(e.message));
  await p3.goto(`${B}/#/learning`);
  await p3.waitForSelector('.tabs button', { timeout: 15000 });
  btns = await p3.locator('.tabs button').allTextContents();
  ck('admin 全量可见（含两个受限 tab）', btns.some((t) => t.includes('兑现登记')) && btns.some((t) => t.includes('视频教学设置')));

  // ④ 宠物最近动态分页（admin）
  await p3.goto(`${B}/#/pets?tab=records`);
  await p3.waitForSelector('.log-pager', { timeout: 15000 });
  ck('默认 15 行', (await p3.locator('.log-row').count()) === 15, String(await p3.locator('.log-row').count()));
  ck('计数与页码（共 18 条 · 1/2）', (await p3.locator('.log-pager').textContent()).includes('共 18 条') && (await p3.locator('.log-pager').textContent()).includes('1 / 2'));
  ck('首页行是最新动态 E2E动态18', (await p3.locator('.log-row').first().textContent()).includes('E2E动态18'));
  await p3.locator('.log-pager button:not([disabled])', { hasText: '下一页' }).click();
  await sleep(300);
  ck('下一页剩 3 行（E2E动态03..01）', (await p3.locator('.log-row').count()) === 3 && (await p3.locator('.log-row').first().textContent()).includes('E2E动态03'));
  await p3.locator('.log-pager select').selectOption('50');
  await sleep(300);
  ck('切 50 行/页 → 一页 18 行', (await p3.locator('.log-row').count()) === 18 && (await p3.locator('.log-pager').textContent()).includes('1 / 1'));
  await p3.screenshot({ path: 'Logs/pets-log-pager.png', fullPage: false });
  ck('无 pageerror', errs1.length === 0 && errs3.length === 0, [...errs1, ...errs3].slice(0, 2).join(' | '));
  await ctx3.close();
  await browser.close();
} catch (e) {
  fail++;
  console.error('  ✗ 脚本异常:', e.message);
} finally {
  srv.kill();
  await sleep(600);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
}
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
