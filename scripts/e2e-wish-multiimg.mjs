// E2E：心愿卡多图上传 + 封面设置（v1.2.4）
// API：image_ids 数组落库/封面校验/旧单图 image_id 兼容/无效 id 过滤/9 张上限
// UI：多选上传→缩略图→点图设封面→✕移除→保存→看板封面→放大画廊左右切换/键盘
// 用法：node scripts/e2e-wish-multiimg.mjs  （隔离 DATA_DIR 起服务，测完自动清理）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'tmp-wish-e2e');
const PORT = 3999;
const B = `http://127.0.0.1:${PORT}`;
const ADMIN = { username: 'admin', password: 'test123456' };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const pngBuf = Buffer.from(PNG.split(',')[1], 'base64');

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
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: ADMIN.username, DEFAULT_ADMIN_PASSWORD: ADMIN.password, TTS_ROOT: path.join(DATA, 'no-tts') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', (d) => console.error('[srv-err]', String(d).slice(0, 300)));
await sleep(2500);

try {
  let r = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN) });
  const lj = await r.json();
  ck('管理员登录', r.status === 200 && !!lj.token, JSON.stringify(lj).slice(0, 120));
  const HA = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lj.token };

  // ---------- 1. 传 3 张图 ----------
  const imgIds = [];
  for (let i = 0; i < 3; i++) {
    r = await fetch(`${B}/api/family-images`, { method: 'POST', headers: HA, body: JSON.stringify({ data: PNG }) });
    const j = await r.json();
    ck(`图 ${i + 1} 上传`, r.status === 200 && j.id > 0);
    imgIds.push(j.id);
  }
  const [a, b, c] = imgIds;

  // ---------- 2. 建产品：3 图 + 指定 b 为封面 ----------
  r = await fetch(`${B}/api/wish/manage`, { method: 'POST', headers: HA, body: JSON.stringify({ name: 'E2E多图产品', image_ids: [a, b, c], cover_id: b }) });
  const pj = await r.json();
  ck('多图产品创建', r.status === 200 && pj.ok, JSON.stringify(pj).slice(0, 120));
  const pid = pj.id;

  const findP = async () => {
    const j = await (await fetch(`${B}/api/wish/products`, { headers: HA })).json();
    return (j.products || []).find((p) => p.id === pid);
  };
  let row = await findP();
  ck('images 封面优先 [b,a,c]', JSON.stringify(row.images) === JSON.stringify([b, a, c]), JSON.stringify(row.images));
  ck('cover_id=b', row.cover_id === b);
  ck('旧字段 image_id=封面', row.image_id === b);

  // ---------- 3. 改封面为 c ----------
  r = await fetch(`${B}/api/wish/manage/${pid}`, { method: 'PUT', headers: HA, body: JSON.stringify({ name: 'E2E多图产品', image_ids: [a, b, c], cover_id: c }) });
  ck('改封面 PUT 200', r.status === 200);
  row = await findP();
  ck('封面改为 c 生效', row.images[0] === c && row.cover_id === c, JSON.stringify(row.images));

  // ---------- 4. 旧单图兼容（只传 image_id） ----------
  r = await fetch(`${B}/api/wish/manage`, { method: 'POST', headers: HA, body: JSON.stringify({ name: 'E2E旧单图', image_id: a }) });
  const legacyId = (await r.json()).id;
  const legacy = (await (await fetch(`${B}/api/wish/products`, { headers: HA })).json()).products.find((p) => p.id === legacyId);
  ck('旧单图自动归一化 [a]', JSON.stringify(legacy.images) === JSON.stringify([a]) && legacy.cover_id === a);

  // ---------- 5. 无效 id 过滤 + 封面回退 + 上限 9 ----------
  r = await fetch(`${B}/api/wish/manage`, { method: 'POST', headers: HA, body: JSON.stringify({ name: 'E2E过滤', image_ids: [a, 999999, a, b], cover_id: 888888 }) });
  const fid = (await r.json()).id;
  const frow = (await (await fetch(`${B}/api/wish/products`, { headers: HA })).json()).products.find((p) => p.id === fid);
  ck('无效 id 过滤+去重', JSON.stringify(frow.images) === JSON.stringify([a, b]), JSON.stringify(frow.images));
  ck('非法封面回退为首图', frow.cover_id === a);

  const ten = [];
  for (let i = 0; i < 10; i++) {
    const j = await (await fetch(`${B}/api/family-images`, { method: 'POST', headers: HA, body: JSON.stringify({ data: PNG }) })).json();
    ten.push(j.id);
  }
  r = await fetch(`${B}/api/wish/manage`, { method: 'POST', headers: HA, body: JSON.stringify({ name: 'E2E上限', image_ids: ten }) });
  const capId = (await r.json()).id;
  const capRow = (await (await fetch(`${B}/api/wish/products`, { headers: HA })).json()).products.find((p) => p.id === capId);
  ck('上限 9 张', capRow.images.length === 9, String(capRow.images.length));

  // ---------- UI：多选上传 → 封面 → 移除 → 保存 → 画廊 ----------
  console.log('\n== UI（Playwright） ==');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addInitScript((t) => { localStorage.setItem('wb_token', t); }, lj.token);
  await ctx.addInitScript((u) => { localStorage.setItem('wb_user', u); }, JSON.stringify(lj.user || { id: 1, username: 'admin', role: 'admin' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${B}/#/learning?tab=wish`);
  await page.waitForSelector('.wish .setup h3', { timeout: 15000 });
  await page.waitForTimeout(500);

  // 多选上传 3 张
  await page.setInputFiles('.setup input[type=file]', [
    { name: 'w1.png', mimeType: 'image/png', buffer: pngBuf },
    { name: 'w2.png', mimeType: 'image/png', buffer: pngBuf },
    { name: 'w3.png', mimeType: 'image/png', buffer: pngBuf },
  ]);
  await page.waitForFunction(() => document.querySelectorAll('.wish .thumbs .th').length === 3, null, { timeout: 15000 });
  ck('多选上传 3 缩略图', true);

  // 点第 2 张设为封面
  await page.locator('.wish .thumbs .th').nth(1).locator('img').click();
  await page.waitForTimeout(300);
  ck('第 2 张变封面', await page.locator('.wish .thumbs .th.cover').count() === 1
    && (await page.locator('.wish .thumbs .th').nth(0).locator('img').getAttribute('src')) === (await page.locator('.wish .up img').getAttribute('src')));

  // 移除第 3 张（现在索引 2）
  await page.locator('.wish .thumbs .th').nth(2).locator('.rm').click();
  await page.waitForTimeout(300);
  ck('✕ 移除一张剩 2', await page.locator('.wish .thumbs .th').count() === 2);

  // 填名保存
  await page.locator('.wish .setup input[placeholder="产品名称"]').fill('E2E界面多图');
  await page.locator('.wish .setup button.primary').click();
  await page.waitForFunction(() => [...document.querySelectorAll('.wish .kb-name')].some((el) => el.textContent.includes('E2E界面多图')), null, { timeout: 15000 });
  ck('产品已登记上看板', true);

  // 看板卡片显示封面
  const card = page.locator('.kb-card', { hasText: 'E2E界面多图' });
  ck('卡片封面可渲染', await card.locator('.kb-img img').evaluate((el) => el.naturalWidth > 0));

  // 点击放大 → 画廊 1/2 → 下一张 → Esc 关
  await card.locator('.kb-img').click();
  ck('画廊计数 1/2', (await page.locator('.zct').textContent()).trim() === '1 / 2');
  await page.locator('.znv.next').click();
  ck('下一张 2/2', (await page.locator('.zct').textContent()).trim() === '2 / 2');
  await page.keyboard.press('ArrowLeft');
  ck('键盘 ← 回 1/2', (await page.locator('.zct').textContent()).trim() === '1 / 2');
  await page.keyboard.press('Escape');
  ck('Esc 关闭画廊', (await page.locator('.zct').count()) === 0);

  // 编辑回显 2 张缩略图
  await page.locator('.wish .list tr', { hasText: 'E2E界面多图' }).locator('button', { hasText: '编辑' }).click();
  await page.waitForTimeout(400);
  ck('编辑回显 2 张', await page.locator('.wish .thumbs .th').count() === 2);
  await page.locator('.wish .setup button', { hasText: '取消编辑' }).click();

  ck('无 pageerror', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
} catch (e) {
  fail++;
  console.error('  ✗ 脚本异常:', e.message);
} finally {
  srv.kill();
  await sleep(600);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows 句柄延迟，留下次清 */ }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
