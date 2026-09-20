// 三测试中心「点进去做卷」E2E（v1.3.1 修复回归）：
// H5 点量表卡 → 测试须知页 → 开始测试 → 答题页渲染题面与选项；
// 工作台 tab 改名「心理测试」 + iframe 指向 /pro/。
// 用法：node scripts/e2e-center-click.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PORT = 3999, B = `http://127.0.0.1:${PORT}`;
const DATA = path.join(ROOT, 'data', 'tmp-e2e-center-click'); // 子目录（勿放 data/ 根：历史库清扫陷阱）

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
{
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`${B}/api/health`); if (r.ok) break; } catch { /* 未就绪 */ }
    if (Date.now() - t0 > 30000) { console.error('服务 30s 内未就绪'); srv.kill(); process.exit(1); }
    await sleep(500);
  }
}

// 中心 × 题库：进入须知页 → 开始 → 答题页（题面卡 + 至少 2 个选项 + 标题标签）
const CASES = [
  ['dep', 'd01', '抑郁'],
  ['dep', 'd14', 'SCL-90（scale 引擎）'],
  ['pro', 'p107', 'Mach-IV'],
  ['pro', 'p102', 'DSQ（scale 引擎）'],
  ['mbti', 'f001', '趣味（回归）'],
];

const browser = await chromium.launch();
try {
  for (const [tag, id, label] of CASES) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(`${B}/${tag}/index.html#/testhub`);
    await page.waitForSelector(`a.fun-item[href="#/start/${id}"]`, { timeout: 10000 });
    await page.click(`a.fun-item[href="#/start/${id}"]`);
    const hasStart = await page.waitForSelector('#btn-begin', { timeout: 8000 }).then(() => true).catch(() => false);
    ck(`[${tag}/${id}] ${label}：进入测试须知页`, hasStart);
    if (hasStart) {
      await page.click('#btn-begin');
      await page.waitForSelector('.q-card', { timeout: 8000 }).catch(() => {});
      const nChoice = await page.locator('button.choice').count().catch(() => 0);
      const titleTag = await page.locator('.fun-title-tag').first().textContent().catch(() => '');
      ck(`[${tag}/${id}] 答题页渲染（${nChoice} 个选项 · ${String(titleTag).slice(0, 18)}）`, nChoice >= 2 && !!titleTag);
    }
    ck(`[${tag}/${id}] 无页面错误`, errs.length === 0, errs.join(' | ').slice(0, 200));
    await ctx.close();
  }

  // 工作台 tab：改名「心理测试」，iframe 指 /pro/
  const login = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test123456' }) })).json();
  const ctx = await browser.newContext();
  await ctx.addInitScript((t) => { localStorage.setItem('wb_token', t); }, login.token);
  await ctx.addInitScript((u) => { localStorage.setItem('wb_user', u); }, JSON.stringify(login.user));
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  await page.goto(`${B}/#/tools`);
  await sleep(1500); // App 启动期桌面/移动布局切换抖动（第六十二批坑）
  const tabs = await page.locator('.tabs button').allTextContents();
  ck('工具页 tab 含「心理测试」且无「专业心理测试」', tabs.some(t => t.trim() === '心理测试') && !tabs.some(t => t.includes('专业心理测试')), tabs.join('/'));
  const order = ['抑郁测试', '心理测试', '职业测试'].map(l => tabs.findIndex(t => t.trim() === l));
  ck('tab 顺序：抑郁 → 心理 → 职业 排前 3', order[0] >= 0 && order[0] < order[1] && order[1] < order[2] && order.every(i => i >= 0 && i < 3), order.join(','));
  await page.click('.tabs button:has-text("心理测试")');
  await sleep(1200);
  const src = await page.locator('iframe').first().getAttribute('src').catch(() => '');
  ck('心理测试 tab iframe 指向 /pro/index.html', src.startsWith('/pro/'), src);
  ck('工作台页无页面错误', errs.length === 0, errs.join(' | ').slice(0, 200));
  await ctx.close();
} finally {
  await browser.close();
  srv.kill();
  await sleep(800);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows 句柄延迟释放，残留待下次清理 */ }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
