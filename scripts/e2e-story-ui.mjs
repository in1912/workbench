// e2e：家庭管理 → 儿童故事 tab 的界面（v1.9.36）
// 覆盖：tab 按钮与深链、十列表头、默认 15 行/分页量 5-15-30-50-100、模糊搜、点条目开全文弹窗、
//       AI 生成弹窗、导入入口、删除（连带确认框）、未转音频时的占位、无 JS 报错。
// 隔离 DATA_DIR 起服务，故事用接口灌；不碰任何真实数据。
//   node scripts/e2e-story-ui.mjs
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const PORT = 3195;
const B = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), 'wb-storyui-'));
process.env.DATA_DIR = DATA;

let passed = 0, failed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: path.join(import.meta.dirname, '..'),
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, TTS_ROOT: path.join(DATA, 'tts'), DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; if (process.env.E2E_VERBOSE) process.stdout.write(d); });
server.stderr.on('data', (d) => { serverLog += d; if (process.env.E2E_VERBOSE) process.stderr.write(d); });

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${B}/api/health`)).ok) return; } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('服务 60s 未就绪');
}
async function api(method, url, { token, body } = {}) {
  const r = await fetch(B + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, j: ct.includes('json') ? await r.json() : await r.text() };
}

let br = null;
try {
  await waitReady();
  const lg = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'test123456' } });
  const T = lg.j.b?.token || lg.j.token;
  ok(!!T, 'admin 登录拿到 token');
  // 灌 18 条（默认每页 15 → 2 页；每页 5 → 4 页），再补一条能被「小猪」搜到的
  for (let i = 1; i <= 18; i++) {
    await api('POST', '/api/story', { token: T, body: { title: `E2E故事${String(i).padStart(2, '0')}`, content: `第 ${i} 篇的正文内容，用来验证列表与分页。` } });
  }
  await api('POST', '/api/story', { token: T, body: { title: '三只小猪盖房子', content: '三只小猪各自盖了一座房子。' } });
  ok(true, '灌入 19 条测试故事');

  const { chromium } = await import('playwright');
  br = await chromium.launch();
  const ctx = await br.newContext();
  await ctx.addInitScript(([t, u]) => {
    localStorage.setItem('wb_token', t);
    localStorage.setItem('wb_user', u);
  }, [T, JSON.stringify(lg.j.user)]);
  const p = await ctx.newPage();
  const perr = [];
  p.on('pageerror', (e) => perr.push(String(e).slice(0, 160)));
  p.on('dialog', (d) => d.accept());   // 删除确认框一律确认

  console.log('— 页签与深链');
  await p.goto(`${B}/#/family?tab=story`);
  await p.waitForSelector('.sp-tb', { timeout: 15000 });
  ok(true, '深链 #/family?tab=story 直达儿童故事面板');
  const tabBtns = await p.locator('.tabs button').allInnerTexts();
  ok(tabBtns.includes('儿童故事'), '家庭管理页签栏出现「儿童故事」', tabBtns.join('/'));
  ok(tabBtns.indexOf('儿童故事') > tabBtns.indexOf('家庭人员档案'), '页签排在「家庭人员档案」之后');
  ok((await p.locator('.tabs button.active').innerText()) === '儿童故事', '深链进来默认选中该页签');

  console.log('— 表头（用户指定的十列）');
  const heads = (await p.locator('.sp-tb thead th').allInnerTexts()).map((s) => s.trim());
  for (const h of ['序号', '故事名称', '概要', '导入日期', '是否转音频', '音频时长', '音频使用音色', '音频播放', '操作']) {
    ok(heads.includes(h), `表头有「${h}」`, heads.join('|'));
  }
  ok((await p.locator('.sp-tb thead input[type=checkbox]').count()) === 1, '表头有全选框');

  console.log('— 列表内容与默认分页');
  ok((await p.locator('.sp-tb tbody tr').count()) === 15, '默认每页 15 行', String(await p.locator('.sp-tb tbody tr').count()));
  ok((await p.locator('.sp-tb tbody tr').first().locator('td').nth(1).innerText()).trim() === '1', '序号从 1 开始（跨页连续）');
  const firstRow = p.locator('.sp-tb tbody tr').first();
  ok((await firstRow.locator('td').nth(2).innerText()).includes('三只小猪盖房子'), '最新一条排在最前（id 倒序）');
  ok((await firstRow.locator('td').nth(4).innerText()).length === 10, '导入日期是 YYYY-MM-DD 十位');
  ok((await firstRow.locator('.badge').innerText()).includes('未转'), '未转音频显示「未转」标签');
  ok((await firstRow.locator('td').nth(6).innerText()).trim() === '—', '没音频时时长占位「—」');
  ok((await firstRow.locator('audio').count()) === 0, '没音频时不渲染播放控件');
  ok(/共 19 条 · 第 1 \/ 2 页/.test(await p.locator('.card').last().innerText()), '分页信息「共 19 条 · 第 1/2 页」');

  console.log('— 分页量 5/15/30/50/100');
  const sizeSel = p.locator('.card').last().locator('select');
  const opts = await sizeSel.locator('option').allInnerTexts();
  ok(JSON.stringify(opts.map((s) => s.trim())) === JSON.stringify(['5', '15', '30', '50', '100']), '每页量选项 5/15/30/50/100', opts.join(','));
  await sizeSel.selectOption('5');
  await p.waitForFunction(() => document.querySelectorAll('.sp-tb tbody tr').length === 5, null, { timeout: 8000 });
  ok(true, '改成每页 5 行后列表跟着刷新（改条数必须重拉，v1.9.28 踩过的坑）');
  ok(/第 1 \/ 4 页/.test(await p.locator('.card').last().innerText()), '19 条 ÷ 5 = 4 页');
  await sizeSel.selectOption('15');
  await p.waitForFunction(() => document.querySelectorAll('.sp-tb tbody tr').length === 15, null, { timeout: 8000 });
  await p.locator('.card').last().locator('button', { hasText: '下一页' }).click();
  await p.waitForFunction(() => /第 2 \/ 2 页/.test(document.body.innerText), null, { timeout: 8000 });
  ok((await p.locator('.sp-tb tbody tr').count()) === 4, '第 2 页 4 行（19-15）');
  ok((await p.locator('.sp-tb tbody tr').first().locator('td').nth(1).innerText()).trim() === '16', '第 2 页序号从 16 续排');
  ok(await p.locator('.card').last().locator('button', { hasText: '下一页' }).isDisabled(), '最后一页「下一页」置灰');

  console.log('— 模糊搜索');
  await p.locator('.card').first().locator('input[placeholder="搜故事名 / 概要"]').fill('小猪');
  await p.locator('.card').first().locator('button', { hasText: '🔍 搜索' }).click();
  await p.waitForFunction(() => document.querySelectorAll('.sp-tb tbody tr').length === 1, null, { timeout: 8000 });
  ok(true, '搜「小猪」只剩 1 行（故事名模糊匹配）');
  ok((await p.locator('.sp-tb tbody tr').first().innerText()).includes('三只小猪'), '命中的正是那条');
  await p.locator('.card').first().locator('input[placeholder="搜故事名 / 概要"]').fill('正文内容');
  await p.locator('.card').first().locator('button', { hasText: '🔍 搜索' }).click();
  await p.waitForFunction(() => /共 18 条/.test(document.body.innerText), null, { timeout: 8000 });
  ok(true, '搜「正文内容」（只在概要里出现）命中 18 条');
  await p.locator('.card').first().locator('input[placeholder="搜故事名 / 概要"]').fill('');
  await p.locator('.card').first().locator('button', { hasText: '🔍 搜索' }).click();
  await p.waitForFunction(() => /共 19 条/.test(document.body.innerText), null, { timeout: 8000 });

  console.log('— 点条目看全文');
  await p.locator('.sp-link').first().click();
  await p.waitForSelector('.modal-backdrop .sp-body', { timeout: 8000 });
  const body = await p.locator('.modal-backdrop .sp-body').innerText();
  ok(body.includes('三只小猪各自盖了一座房子'), '全文弹窗显示完整正文', body.slice(0, 40));
  ok((await p.locator('.modal-backdrop .modal h3').innerText()).includes('三只小猪盖房子'), '弹窗标题是故事名');
  ok((await p.locator('.modal-backdrop').innerText()).includes('转音频'), '弹窗里有「文字转音频」按钮');
  await p.locator('.modal-backdrop .modal button', { hasText: '关闭' }).click();
  await p.waitForFunction(() => document.querySelectorAll('.modal-backdrop').length === 0, null, { timeout: 5000 });

  console.log('— AI 生成弹窗');
  await p.locator('button', { hasText: '✨ AI 生成故事' }).click();
  await p.waitForSelector('.modal-backdrop select', { timeout: 5000 });
  const styleOpts = await p.locator('.modal-backdrop select option').allInnerTexts();
  ok(styleOpts[0].includes('随机') && styleOpts.length === 7, '风格下拉 = 随机 + 6 个预设', styleOpts.join(','));
  ok((await p.locator('.modal-backdrop input[placeholder*="小鸭子"]').count()) === 1, '有「主题要求」输入框');
  ok((await p.locator('.modal-backdrop button', { hasText: '🎲 随机来一个' }).count()) === 1, '有「🎲 随机来一个」按钮');
  await p.locator('.modal-backdrop .modal button', { hasText: '取消' }).click();
  await p.waitForFunction(() => document.querySelectorAll('.modal-backdrop').length === 0, null, { timeout: 5000 });

  console.log('— 导入入口与转音频按钮');
  const fileInput = p.locator('input[type=file]');
  ok((await fileInput.count()) === 1, '导入用的文件选择器已渲染（按钮点了才唤起）');
  ok(/txt/.test(await fileInput.getAttribute('accept')), 'accept 限定纯文本类', await fileInput.getAttribute('accept'));
  const batchBtn = p.locator('.card').first().locator('button', { hasText: '文字转音频' });
  ok(await batchBtn.isDisabled(), '没勾选任何条目时「文字转音频」置灰');
  await p.locator('.sp-tb tbody tr').first().locator('input[type=checkbox]').check();
  ok(!(await batchBtn.isDisabled()), '勾选一条后「文字转音频（1 条）」可用');
  ok((await batchBtn.innerText()).includes('1 条'), '按钮上显示选中条数');
  await p.locator('.sp-tb thead input[type=checkbox]').check();
  ok((await batchBtn.innerText()).includes('15 条'), '表头全选框一次选中本页 15 条');
  await p.locator('.sp-tb thead input[type=checkbox]').uncheck();
  // 引擎在隔离环境里必然未安装 → 面板要给出可执行的提示，而不是让用户对着报错猜
  ok(/音频引擎未安装/.test(await p.locator('.sp-warn').first().innerText()), '引擎未就绪时提前给出安装指引');

  console.log('— 删除');
  const before = await p.locator('.sp-tb tbody tr').count();
  const delTitle = await p.locator('.sp-tb tbody tr').first().locator('td').nth(2).innerText();
  await p.locator('.sp-tb tbody tr').first().locator('button', { hasText: '删除' }).click();
  await p.waitForFunction((t) => !document.body.innerText.includes(t), delTitle, { timeout: 8000 });
  ok(true, '删除后该行从列表消失（确认框已确认）');
  // 删完仍剩 18 条 > 每页 15 → 首页照旧满页（第 2 页补一条上来），所以行数不减才对
  ok(before === 15 && (await p.locator('.sp-tb tbody tr').count()) === 15, '首页从第 2 页补位，仍是满页 15 行');
  ok(/共 18 条/.test(await p.locator('.card').last().innerText()), '总数同步刷新为 18');

  ok(perr.length === 0, '页面无 JS 错误' + (perr.length ? '：' + perr[0] : ''));
} catch (e) {
  failed++;
  console.error('  ✗ 未捕获异常:', e.message);
  if (serverLog) console.error(serverLog.slice(-1500));
} finally {
  try { if (br) await br.close(); } catch { /* 已关 */ }
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows 占用，忽略 */ }
  console.log(`\n${failed === 0 ? '✅' : '❌'} 通过 ${passed} / 失败 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}
