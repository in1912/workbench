// E2E：邮箱正文空行归一（v1.2.13）——段落间多个空行 → 恰好一个换行
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'tmp-email-body-e2e');
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
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456', TTS_ROOT: path.join(DATA, 'no-tts') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', (d) => console.error('[srv-err]', String(d).slice(0, 200)));
await sleep(3000);

try {
  const lj = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test123456' }) })).json();
  const TK = lj.token;
  await fetch(`${B}/api/emails/attach-config`, { headers: { Authorization: 'Bearer ' + TK } }); // 摸 req.tdb 惰性建表

  const reqSrv = createRequire(path.join(ROOT, 'server', 'services', 'dingtalkStreamService.js'));
  const { getTenantDb } = reqSrv('../db');
  const tdb = getTenantDb(lj.user.id);
  const ins = tdb.prepare(`INSERT INTO emails(folder,uid,subject,from_addr,body,date,attachments) VALUES(?,?,?,?,?,?,?)`);
  // ① 纯文本：段落间 3 个空行（\r\n×4）
  ins.run('inbox', 9001, 'E2E 多空行', 'a@x.com', '第一段。\r\n\r\n\r\n\r\n第二段。\r\n\r\n\r\n第三段。', '2026-09-06 10:00:00', '[]');
  // ② 单换行正常文（不该被破坏）
  ins.run('inbox', 9002, 'E2E 正常文', 'b@x.com', '甲行\n乙行\n丙行', '2026-09-06 10:01:00', '[]');

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addInitScript((t) => { localStorage.setItem('wb_token', t); }, TK);
  await ctx.addInitScript((u) => { localStorage.setItem('wb_user', u); }, JSON.stringify(lj.user));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${B}/#/email`);
  await page.waitForSelector('.list-item', { timeout: 15000 });

  await page.locator('.list-item', { hasText: 'E2E 多空行' }).click();
  await page.waitForSelector('.email-body', { timeout: 5000 });
  let txt = await page.locator('.email-body').evaluate((el) => el.textContent);
  ck('多空行归一为单换行', txt.includes('第一段。\n第二段。\n第三段。'), JSON.stringify(txt));
  ck('正文无连续空行', !/\n\s*\n/.test(txt), JSON.stringify(txt));

  await page.locator('.list-item', { hasText: 'E2E 正常文' }).click();
  await sleep(300);
  txt = await page.locator('.email-body').evaluate((el) => el.textContent);
  ck('原本单换行的正文不受影响', txt.includes('甲行\n乙行\n丙行'), JSON.stringify(txt));

  await page.screenshot({ path: 'Logs/email-body-norm.png' });
  ck('无 pageerror', errors.length === 0, errors.slice(0, 2).join(' | '));
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
