// UI 目检：邮件附件置顶 + 标题「📎 附件 N」标签（v1.2.6）
// 隔离服务 + 直接往 emails 表插两封测试邮件（一带附件一无附件）→ Playwright 断言 + 截图
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'tmp-email-ui');
const PORT = 3999;
const B = `http://127.0.0.1:${PORT}`;

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
srv.stderr.on('data', () => {});
await sleep(2500);

try {
  // 登录（触发租户库创建）
  let r = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test123456' }) });
  const lj = await r.json();
  ck('登录', r.status === 200 && !!lj.token);
  // 租户库 DDL 惰性初始化：先打一个走 req.tdb 的接口把表建出来
  await fetch(`${B}/api/emails/attach-config`, { headers: { Authorization: 'Bearer ' + lj.token } });

  // 直插两封测试邮件（uid 唯一）
  // 注意：全新库 dingtalk_bot 占 uid=1，admin 是 uid=2 → 租户库文件名按实际 uid 拼
  const tdb = new DatabaseSync(path.join(DATA, `tenant-${lj.user.id}.sqlite`));
  tdb.prepare(`INSERT INTO emails(uid,subject,from_addr,date,seen,folder,body,attachments) VALUES(?,?,?,?,0,'inbox',?,?)`)
    .run(9001, 'E2E带附件发票', 'fapiao@test.cn', '2026-09-06T02:00:00', '发票正文内容 ABC',
      JSON.stringify([{ filename: '发票.zip', size: 349039, path: '', stored: 1 }]));
  tdb.prepare(`INSERT INTO emails(uid,subject,from_addr,date,seen,folder,body,attachments) VALUES(?,?,?,?,0,'inbox',?,?)`)
    .run(9002, 'E2E无附件营销', 'ad@test.cn', '2026-09-06T01:00:00', '营销正文', '[]');
  tdb.close();

  // UI
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addInitScript((t) => { localStorage.setItem('wb_token', t); }, lj.token);
  await ctx.addInitScript((u) => { localStorage.setItem('wb_user', u); }, JSON.stringify(lj.user || { id: 1, username: 'admin', role: 'admin' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(`${B}/#/email`);
  await page.waitForSelector('.list-item', { timeout: 15000 });

  // 1) 标题行标签：带附件的显示「📎 附件 1」，无附件的不显示
  const withAtt = page.locator('.list-item', { hasText: 'E2E带附件发票' });
  const noAtt = page.locator('.list-item', { hasText: 'E2E无附件营销' });
  ck('带附件：标题行显示 📎 附件 1', await withAtt.locator('.att-tag').textContent() === '📎 附件 1');
  ck('无附件：无标签', (await noAtt.locator('.att-tag').count()) === 0);
  const titleAttr = await withAtt.locator('.att-tag').getAttribute('title');
  ck('悬停 title 列文件名', (titleAttr || '').includes('发票.zip'), String(titleAttr));

  // 2) 展开后附件块在正文上方（.email-body 是 .list-item 的兄弟节点，openId 唯一 → 全页只有一个）
  await withAtt.click();
  await page.waitForTimeout(400);
  const body = page.locator('.email-body');
  const html = await body.innerHTML();
  ck('附件块在正文之前', html.indexOf('📎 附件') >= 0 && html.indexOf('📎 附件') < html.indexOf('发票正文内容 ABC'));
  ck('附件块带底部分隔线', html.includes('border-bottom'));
  ck('附件文件名可见', (await body.textContent()).includes('发票.zip'));

  await page.screenshot({ path: 'Logs/email-att-top.png', fullPage: false });
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
