// UI 测试：设置 → SSL 自签名 tab（v1.2.13，跑 web/dist 构建产物）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'tmp-ssl-ui');
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

let browser;
try {
  const lj = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test123456' }) })).json();
  const TK = lj.token;
  await fetch(`${B}/api/users`, { method: 'POST', headers: { Authorization: 'Bearer ' + TK, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'u2', password: 'u234567', display_name: '二员' }) });
  const l2 = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'u2', password: 'u234567' }) })).json();

  const { chromium } = await import('playwright');
  browser = await chromium.launch();

  // ---------- 普通用户：看不到 SSL tab ----------
  const ctx2 = await browser.newContext();
  await ctx2.addInitScript((t) => { localStorage.setItem('wb_token', t); }, l2.token);
  await ctx2.addInitScript((u) => { localStorage.setItem('wb_user', u); }, JSON.stringify(l2.user));
  const p2 = await ctx2.newPage();
  await p2.goto(`${B}/#/settings`);
  await p2.waitForSelector('.tabs button');
  const tabs2 = await p2.locator('.tabs button').allTextContents();
  ck('普通用户只有常规设置 tab', tabs2.length === 1 && tabs2[0].includes('常规设置'), JSON.stringify(tabs2));
  await ctx2.close();

  // ---------- 管理员：完整流程 ----------
  const ctx = await browser.newContext();
  await ctx.addInitScript((t) => { localStorage.setItem('wb_token', t); }, TK);
  await ctx.addInitScript((u) => { localStorage.setItem('wb_user', u); }, JSON.stringify(lj.user));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept()); // 生成/重启的 confirm 全部接受
  await page.goto(`${B}/#/settings`);
  await page.waitForSelector('.tabs button');
  const tabs = await page.locator('.tabs button').allTextContents();
  ck('管理员 3 个 tab（常规/SSL/升级）', tabs.length === 3 && tabs.some((t) => t.includes('SSL 自签名')), JSON.stringify(tabs));

  await page.locator('.tabs button', { hasText: 'SSL 自签名' }).click();
  // 常规 tab 是 v-show（display:none 但仍在 DOM），必须锚定 SSL 卡片专属元素
  await page.waitForSelector('h3:has-text("当前签名")');
  ck('未配置时显示引导文案', (await page.locator('.empty', { hasText: '尚未配置证书' }).count()) === 1, '');

  // 生成表单：CN 预填了 location.hostname（127.0.0.1 不会预填 CN，SAN 也不会填回环）
  await page.fill('input[placeholder="your.domain.com"]', 'wb-ui.example.com');
  await page.fill('input[placeholder="192.168.1.10, nas.local"]', '192.168.9.9');
  await page.click('button:has-text("生成并替换证书")');
  // Settings 父页面有自己的 .msg（通勤提示等，v-show 隐藏也在 DOM）——flash 必须按文本锚定
  await page.waitForSelector('.msg:has-text("新证书已生成")', { timeout: 30000 }); // RSA 生成约 2-5 秒
  const flash1 = await page.locator('.msg:has-text("新证书已生成")').first().textContent();
  ck('生成成功 flash（含天数与覆盖）', /新证书已生成/.test(flash1) && /820/.test(flash1), flash1);

  // 状态卡刷新出证书信息
  await page.waitForSelector('.kv');
  const subj = await page.locator('.kv').first().textContent();
  ck('状态显示签发对象 CN', subj.includes('CN=wb-ui.example.com'), subj);
  const days = await page.locator('.kv .badge').first().textContent();
  ck('剩余天数徽章显示', /剩 \d+ 天/.test(days), days);
  const sanBadges = await page.locator('.kv .badge.blue').allTextContents();
  ck('SAN 徽章含附加 IP 与域名', sanBadges.some((s) => s.includes('192.168.9.9')) && sanBadges.some((s) => s.includes('wb-ui.example.com')), JSON.stringify(sanBadges));
  ck('待重启横幅显示', await page.locator('.msg', { hasText: '已替换' }).count() > 0);
  ck('下载/重启按钮可用', await page.locator('button:has-text("下载证书")').isEnabled() && await page.locator('button:has-text("重启服务")').isEnabled());

  // 说明卡
  const doc = await page.locator('.doc').textContent();
  ck('说明卡含路径与原理', doc.includes('/data/ssl') && doc.includes('同端口'), doc.slice(0, 80));

  // 服务端确认真证书落盘（UI 生成的）
  const st = await (await fetch(`${B}/api/ssl/status`, { headers: { Authorization: 'Bearer ' + TK } })).json();
  ck('服务端状态与 UI 一致（SAN 含 192.168.9.9）', st.configured && /192\.168\.9\.9/.test(st.san || ''), st.san);

  await page.screenshot({ path: 'Logs/ssl-panel.png', fullPage: true });
  ck('无 pageerror', errors.length === 0, errors.slice(0, 2).join(' | '));
  await ctx.close();
} catch (e) {
  fail++;
  console.error('  ✗ 脚本异常:', e.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  srv.kill();
  await sleep(600);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
}
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
