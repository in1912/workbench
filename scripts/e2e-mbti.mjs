// E2E（心理测试 MBTI 集成，v1.2.23）：
// ① API：免登录分享 /api/mbti/public/:id（404/200）、未登录 401、前缀配置读写（非管理员 403）、
//    档案同步 + 归属校验（他人改同 ID 403 / 管理员可改）、管理列表分页（默认 15 行）与用户分组、删除（非管理员 403）。
// ② UI：管理员进「效率工具 → 心理测试」——tab 可见、iframe 加载 H5、前缀保存、两列表渲染与翻页。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'tmp-mbti-e2e');
const PORT = 3996;
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
// 全新库冷启动要跑一堆迁移，固定 sleep 不够——轮询 /api/health 直到就绪（上限 30s）
{
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${B}/api/health`);
      if (r.ok) break;
    } catch { /* 未就绪 */ }
    if (Date.now() - t0 > 30000) { console.error('服务 30s 内未就绪'); srv.kill(); process.exit(1); }
    await sleep(500);
  }
}

const login = async (u, p) => (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json();
const H = (t, json = true) => ({ ...(json ? { 'Content-Type': 'application/json' } : {}), Authorization: 'Bearer ' + t });
// 构造 H5 同步白名单同构的 payload（js/server.js workbench 分支）
const rec = (id, name, type, ver = '93') => ({
  id, uid: 'uid-' + id, version: ver, type, name, scores: {}, stats: {}, answers: [],
  startedAt: '', finishedAt: '2026-09-10T10:00:00.000Z', durationMin: 12,
  aiAnalysis: '', aiAnalysisAt: '', userInfo: { uid: 'uid-' + id, nickname: name, name, age: '', gender: '', job: '', hobbies: '' }, syncedAt: '',
});

try {
  const admin = await login('admin', 'test123456');
  const A = H(admin.token);
  ck('管理员登录', !!admin.token);

  // ---------- 免登录公开端点 ----------
  let r = await fetch(`${B}/api/mbti/public/PMTU-not-exist`);
  ck('未登录查不存在的档案 → 404', r.status === 404, String(r.status));
  r = await fetch(`${B}/api/mbti/public/bad%20id%21%40%23`);
  ck('非法 ID（含空格/符号）→ 404', r.status === 404, String(r.status));

  // ---------- 认证门槛 ----------
  r = await fetch(`${B}/api/mbti/records`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(rec('PMTU-x1', 'X', 'INTJ')) });
  ck('未登录同步档案 → 401', r.status === 401, String(r.status));
  r = await fetch(`${B}/api/mbti/config`);
  ck('未登录读配置 → 401', r.status === 401, String(r.status));

  // ---------- 配置读写 ----------
  r = await fetch(`${B}/api/mbti/config`, { headers: A });
  let j = await r.json();
  ck('管理员读配置默认空前缀', r.status === 200 && j.prefix === '', JSON.stringify(j));
  r = await fetch(`${B}/api/mbti/config`, { method: 'PUT', headers: { ...A, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: 'https://example.com/' }) });
  ck('管理员保存前缀（去尾斜杠）', r.status === 200, String(r.status));
  r = await fetch(`${B}/api/mbti/config`, { headers: A });
  j = await r.json();
  ck('前缀已存为去斜杠形式', j.prefix === 'https://example.com', JSON.stringify(j));
  r = await fetch(`${B}/api/mbti/config`, { method: 'PUT', headers: { ...A, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: '不是网址' }) });
  ck('非法前缀 → 400', r.status === 400, String(r.status));
  await fetch(`${B}/api/mbti/config`, { method: 'PUT', headers: { ...A, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: '' }) }); // 还原为空

  // ---------- 建普通用户 u1/u2（全页面开放） ----------
  const mk = async (name) => {
    const res = await fetch(`${B}/api/users`, { method: 'POST', headers: { ...A, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: name.toUpperCase() + '123456', role: 'user', allowed_pages: [] }) });
    return (await res.json()).id;
  };
  await mk('u1'); await mk('u2');
  const u1 = await login('u1', 'U1123456');
  const u2 = await login('u2', 'U2123456');
  const T1 = H(u1.token), T2 = H(u2.token);

  // ---------- 同步 + 归属 ----------
  r = await fetch(`${B}/api/mbti/records`, { method: 'POST', headers: { ...T1, 'Content-Type': 'application/json' }, body: JSON.stringify(rec('PMTU-own1', '张三', 'INTJ')) });
  ck('u1 同步档案 → 200', r.status === 200, String(r.status) + ' ' + (await r.text()).slice(0, 120));
  r = await fetch(`${B}/api/mbti/public/PMTU-own1`);
  j = await r.json();
  ck('未登录打开分享链接数据 → 200 且含档案', r.status === 200 && j.name === '张三' && j.id === 'PMTU-own1', JSON.stringify(j).slice(0, 120));
  r = await fetch(`${B}/api/mbti/records`, { method: 'POST', headers: { ...T2, 'Content-Type': 'application/json' }, body: JSON.stringify(rec('PMTU-own1', '冒名', 'ESFP')) });
  ck('u2 覆盖 u1 的档案 → 403（归属保护）', r.status === 403, String(r.status));
  r = await fetch(`${B}/api/mbti/records`, { method: 'POST', headers: { ...A, 'Content-Type': 'application/json' }, body: JSON.stringify(rec('PMTU-own1', '张三改', 'INTP')) });
  ck('管理员可改任意档案', r.status === 200, String(r.status));

  // ---------- 权限边界：普通用户的管理接口 ----------
  r = await fetch(`${B}/api/mbti/records`, { headers: T1 });
  ck('u1 拉管理列表 → 403（adminOnly）', r.status === 403, String(r.status));
  r = await fetch(`${B}/api/mbti/users`, { headers: T1 });
  ck('u1 拉用户列表 → 403', r.status === 403, String(r.status));
  r = await fetch(`${B}/api/mbti/records/PMTU-own1`, { method: 'DELETE', headers: T1 });
  ck('u1 删档案 → 403', r.status === 403, String(r.status));

  // ---------- 分页：u1 共 20 份档案（默认 15 行） ----------
  for (let i = 2; i <= 21; i++) {
    const res = await fetch(`${B}/api/mbti/records`, { method: 'POST', headers: { ...T1, 'Content-Type': 'application/json' }, body: JSON.stringify(rec('PMTU-p' + String(i).padStart(2, '0'), '分页' + i, 'INFJ')) });
    if (res.status !== 200) { ck(`同步第 ${i} 份`, false, String(res.status)); break; }
  }
  r = await fetch(`${B}/api/mbti/records`, { headers: A });
  j = await r.json();
  ck('列表 total=21（own1 + 20）且首页 15 行', j.total === 21 && j.rows.length === 15 && j.page === 1 && j.pageSize === 15, `total=${j.total} rows=${j.rows?.length}`);
  r = await fetch(`${B}/api/mbti/records?page=2&pageSize=15`, { headers: A });
  j = await r.json();
  ck('第 2 页剩 6 行', j.rows.length === 6, String(j.rows?.length));
  r = await fetch(`${B}/api/mbti/records?page=1&user_id=${u1.user.id}`, { headers: A });
  j = await r.json();
  ck('按 user_id 过滤 → 21 份', j.total === 21, String(j.total));
  ck('行数据不含大 JSON（data 列剥离）', !('data' in (j.rows[0] || {})), JSON.stringify(j.rows[0] || {}).slice(0, 100));

  // ---------- 用户分组 ----------
  r = await fetch(`${B}/api/mbti/users`, { headers: A });
  j = await r.json();
  const g1 = j.rows.find((x) => x.user_id === u1.user.id);
  ck('用户分组：u1 共 21 次', g1 && g1.count === 21, JSON.stringify(j.rows));
  r = await fetch(`${B}/api/mbti/users`, { headers: A });
  j = await r.json();
  ck('用户分组含 u2 = 0 条不出现在列表', !j.rows.some((x) => x.user_id === u2.user.id), JSON.stringify(j.rows));

  // ---------- 删除 ----------
  r = await fetch(`${B}/api/mbti/records/PMTU-p21`, { method: 'DELETE', headers: A });
  ck('管理员删除 → 200', r.status === 200, String(r.status));
  r = await fetch(`${B}/api/mbti/public/PMTU-p21`);
  ck('删除后分享链接立即 404', r.status === 404, String(r.status));

  // ---------- H5 静态托管 ----------
  r = await fetch(`${B}/mbti/index.html`);
  ck('H5 静态页 /mbti/index.html → 200', r.status === 200 && (await r.text()).includes('MBTI'), String(r.status));

  // ---------- UI（Playwright） ----------
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addInitScript((t) => { localStorage.setItem('wb_token', t); }, admin.token);
  await ctx.addInitScript((u) => { localStorage.setItem('wb_user', u); }, JSON.stringify(admin.user));
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${B}/#/tools?tab=mbti`);
  await page.waitForSelector('.tabs button', { timeout: 15000 });
  const btns = await page.locator('.tabs button').allTextContents();
  ck('「心理测试」tab 按钮可见', btns.some((t) => t.includes('心理测试')), btns.join(','));

  const frameEl = page.locator('iframe[title="MBTI 心理测试"]');
  ck('iframe 渲染', (await frameEl.count()) === 1);
  const frame = page.frame({ url: /\/mbti\/index\.html/ }) || (await frameEl.elementHandle()).contentFrame();
  await frame.waitForSelector('#app *', { timeout: 15000 });
  ck('H5 在 iframe 内渲染（#app 有内容）', (await frame.locator('#app *').count()) > 0);
  // App 启动期桌面/移动两套布局的 router-view 切换会造成短暂的组件重挂载（iframe 重载、输入框被新实例覆盖），
  // 稳态后一切正常（e2e-mbti-debug.mjs 已验证）——这里等启动抖动过去再断言
  await sleep(1500);
  const h5mode = await frame.evaluate(() => window.MBTI_SERVER && window.MBTI_SERVER.mode());
  ck('H5 识别为 workbench 模式', h5mode === 'workbench', String(h5mode));

  // 前缀保存
  const pfxInput = page.locator('input[placeholder*="vicp.fun"]');
  await pfxInput.fill('https://e2e.example.com');
  const dbgVal = await pfxInput.inputValue();
  console.log('  [dbg] fill 后输入框值:', dbgVal);
  await page.click('button:has-text("保存")');
  await sleep(600);
  const sample = await page.locator('.muted:has-text("拼接示例")').textContent();
  ck('前缀保存后示例更新', (sample || '').includes('https://e2e.example.com/mbti/index.html#/result/'), (sample || '').slice(0, 160));
  r = await fetch(`${B}/api/mbti/config`, { headers: A });
  j = await r.json();
  ck('服务端前缀已更新', j.prefix === 'https://e2e.example.com', JSON.stringify(j));
  await fetch(`${B}/api/mbti/config`, { method: 'PUT', headers: { ...A, 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix: '' }) }); // 还原

  // 两个列表 + 分页
  await page.waitForSelector('.mbti-table', { timeout: 10000 });
  const rowCount = await page.locator('.mbti-table').nth(1).locator('tbody tr').count();
  ck('用户测试列表首页 15 行', rowCount === 15, String(rowCount));
  const pagerTxt = await page.locator('.muted:has-text("共 20 条")').textContent();
  ck('分页信息「共 20 条 · 第 1/2 页」', /共 20 条 · 第 1\/2 页/.test(pagerTxt || ''), pagerTxt || '');
  await page.locator('button:has-text("下一页")').last().click();
  await sleep(600);
  const rowCount2 = await page.locator('.mbti-table').nth(1).locator('tbody tr').count();
  ck('下一页剩 5 行', rowCount2 === 5, String(rowCount2));
  const usersTable = await page.locator('.mbti-table').nth(0).locator('tbody tr').count();
  ck('系统用户列表渲染（管理员 1 人）', usersTable >= 1, String(usersTable));
  ck('页面无 JS 报错', errs.length === 0, errs.join(' | ').slice(0, 200));
  await ctx.close();
  await browser.close();

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error('E2E 异常:', e);
  process.exitCode = 1;
} finally {
  srv.kill();
  await sleep(500);
  fs.rmSync(DATA, { recursive: true, force: true });
}
