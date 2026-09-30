// E2E：设置 → 飞牛应用 tab（v1.9.9）
// API：/fnos/info 元信息、/fnos/package 下载（大小+SHA256 与源文件一致、Content-Disposition 文件名）；
// 权限：pageForPath('/fnos')=settings → 无 settings 页权限的成员 403、有权限 200；
// UI：管理员见 tab + 下载按钮/安装步骤/当前通道；普通成员（无 settings 页）不见 tab。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '.');
const DATA = path.join(ROOT, 'data', 'tmp-fnos-e2e');
const PORT = 3999;
const B = `http://127.0.0.1:${PORT}`;
process.env.DATA_DIR = DATA;

let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  <<< ' + extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
const srv = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', (d) => console.error('[srv-err]', String(d).slice(0, 200)));
await sleep(3000);

// 源 fpk（server/fnos/ 内最新）做一致性基准
const fnosDir = path.join(ROOT, 'server', 'fnos');
const srcFpk = fs.readdirSync(fnosDir).filter((f) => f.endsWith('.fpk')).sort().pop();
const srcBuf = fs.readFileSync(path.join(fnosDir, srcFpk));
const srcSha = crypto.createHash('sha256').update(srcBuf).digest('hex');

let browser;
try {
  const lj = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test123456' }) })).json();
  const HA = { Authorization: 'Bearer ' + lj.token, 'Content-Type': 'application/json' };

  // ---------- A. 管理员：info + 下载 ----------
  let r = await fetch(`${B}/api/fnos/info`, { headers: HA });
  let j = await r.json();
  ck('A1 info 200 且带版本/大小/文件名', r.status === 200 && j.available === true && j.version === 'v1.9.8' && j.size === srcBuf.length && j.file === srcFpk, JSON.stringify(j).slice(0, 160));

  r = await fetch(`${B}/api/fnos/package`, { headers: HA });
  const buf = Buffer.from(await r.arrayBuffer());
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const cd = r.headers.get('content-disposition') || '';
  ck('A2 package 200 且字节级与源 fpk 一致', r.status === 200 && buf.length === srcBuf.length && sha === srcSha, `status=${r.status} size=${buf.length}/${srcBuf.length}`);
  ck('A3 Content-Disposition 带中文文件名（RFC 5987）', /filename\*=UTF-8''/.test(cd) && encodeURIComponent(srcFpk) === (cd.match(/filename\*=UTF-8''([^;]+)/) || [])[1], cd);

  // ---------- B. 权限 ----------
  await fetch(`${B}/api/users`, { method: 'POST', headers: HA, body: JSON.stringify({ username: 'u2', password: 'u234567', display_name: '受限员', allowed_pages: ['news'] }) });
  await fetch(`${B}/api/users`, { method: 'POST', headers: HA, body: JSON.stringify({ username: 'u3', password: 'u345678', display_name: '设置员', allowed_pages: ['settings'], allowed_tabs: { settings: ['fnos'] } }) });
  const l2 = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'u2', password: 'u234567' }) })).json();
  const l3 = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'u3', password: 'u345678' }) })).json();
  r = await fetch(`${B}/api/fnos/info`, { headers: { Authorization: 'Bearer ' + l2.token } });
  ck('B1 无 settings 页权限的成员 403', r.status === 403, `status=${r.status}`);
  r = await fetch(`${B}/api/fnos/info`, { headers: { Authorization: 'Bearer ' + l3.token } });
  ck('B2 有 settings+fnos tab 权限的成员 200', r.status === 200, `status=${r.status}`);

  // ---------- C. UI（跑 web/dist 构建产物） ----------
  const { chromium } = await import('playwright');
  browser = await chromium.launch();

  const ctx = await browser.newContext();
  await ctx.addInitScript((t) => { localStorage.setItem('wb_token', t); }, lj.token);
  await ctx.addInitScript((u) => { localStorage.setItem('wb_user', u); }, JSON.stringify(lj.user));
  const p = await ctx.newPage();
  await p.goto(`${B}/#/settings`);
  await p.waitForSelector('.tabs button');
  const tabBtn = p.locator('.tabs button', { hasText: '飞牛应用' });
  ck('C1 管理员可见「飞牛应用」tab', await tabBtn.count() === 1);
  await tabBtn.click();
  await p.waitForSelector('.fnos-panel');
  const panel = p.locator('.fnos-panel');
  const cards = panel.locator('.card');
  ck('C2 下载按钮在面板第一张卡片', await cards.first().locator('button.primary', { hasText: '下载 fpk 安装包' }).count() === 1);
  ck('C3 显示版本徽标与大小', await cards.first().locator('.badge.blue', { hasText: 'v1.9.8' }).count() === 1 && (await cards.first().innerText()).includes('MB'));
  ck('C4 显示当前访问通道（内网直连 127.0.0.1）', (await cards.first().innerText()).includes('内网直连'));
  ck('C5 安装步骤内容渲染', (await cards.nth(1).innerText()).includes('应用中心'));
  await p.screenshot({ path: path.join(ROOT, 'Logs', 'e2e-fnos-tab.png'), fullPage: true });

  // 普通成员（无 settings 页）：不见 tab
  const ctx2 = await browser.newContext();
  await ctx2.addInitScript((t) => { localStorage.setItem('wb_token', t); }, l2.token);
  await ctx2.addInitScript((u) => { localStorage.setItem('wb_user', u); }, JSON.stringify(l2.user));
  const p2 = await ctx2.newPage();
  await p2.goto(`${B}/#/settings`);
  await p2.waitForSelector('.tabs button');
  ck('C6 无权限成员不见「飞牛应用」tab', await p2.locator('.tabs button', { hasText: '飞牛应用' }).count() === 0);

  console.log(`\n== 飞牛应用 tab e2e: ${pass} 通过 / ${fail} 失败 ==`);
  process.exit(fail ? 1 : 0);
} catch (e) {
  console.error('e2e 异常：', e);
  process.exit(1);
} finally {
  if (browser) await browser.close().catch(() => {});
  srv.kill();
}
