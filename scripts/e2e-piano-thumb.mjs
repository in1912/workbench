// E2E（v1.2.10）：练琴视频缩略图
// 现象：60 秒录像有缩略图、5~6 秒的短录像没有——相机冷启动 videoWidth 几秒才就绪，
// 唯一一次 600ms 后的抓帧（重试到 ~3s）在短录像里整个错过 → 列表只剩「🎬 查看」链接。
// 修复：① 多轮错峰抓帧 + 停录前补抓（预览画面必在播）；② 老记录没 thumb 的，进页面时
// 客户端从视频文件抽一帧回填（PATCH /piano/thumb/:id）。
// 测试：Playwright 假摄像头（--use-fake-device-for-media-stream）真实走录制→停录→断言
// 缩略图；再清空 thumb 模拟老记录，刷新页面断言自动回填；另测 PATCH 接口权限/格式校验。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'tmp-piano-thumb-e2e');
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
  const admin = await login('admin', 'test123456');
  const A = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + admin.token };
  await fetch(`${B}/api/emails/attach-config`, { headers: A }); // 摸 req.tdb 惰性建表
  const reqSrv = createRequire(path.join(ROOT, 'server', 'routes', 'pianoRoutes.js'));
  const { db } = reqSrv('../db');
  const topVideo = () => db.prepare("SELECT * FROM piano_records WHERE kind='video' ORDER BY id DESC LIMIT 1").get();

  // ---------- UI：假摄像头真实录制一段短视频（4s）→ 必须带缩略图 ----------
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const ctx = await browser.newContext();
  await ctx.addInitScript((t) => { localStorage.setItem('wb_token', t); }, admin.token);
  await ctx.addInitScript((u) => { localStorage.setItem('wb_user', u); }, JSON.stringify(admin.user));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(`${B}/#/learning?tab=piano`);
  await page.waitForSelector('button:has-text("开始录像")', { timeout: 15000 });
  await page.click('button:has-text("开始录像")');
  await page.waitForSelector('.cam-preview', { timeout: 10000 });
  await sleep(4000); // 只录 4 秒：正是以前会错过抓帧窗口的短录像
  await page.click('button:has-text("停止并保存")');
  // 上传完成后列表刷新，最新一行的录像列应出现 img.thumb（而非「🎬 查看」链接）
  await page.waitForSelector('tbody tr:first-child img.thumb', { timeout: 20000 });
  ck('短录像（4s）上传后列表直接显示缩略图', true);
  const v1 = topVideo();
  ck('库里 thumb 已存（data:image/jpeg）', !!v1 && /^data:image\/jpeg;base64,/.test(v1.thumb) && v1.thumb.length > 1000,
    v1 && `thumb=${v1.thumb.length}B`);
  await page.screenshot({ path: 'Logs/piano-thumb-record.png', fullPage: false });

  // ---------- 回填：清空该行 thumb 模拟老记录 → 刷新页面自动补回 ----------
  db.prepare('UPDATE piano_records SET thumb=? WHERE id=?').run('', v1.id);
  await page.reload();
  await page.waitForSelector('.cam-preview, tbody tr', { timeout: 15000 }).catch(() => {});
  // 先出现「🎬 查看」回退态，随后回填完成翻成缩略图（视频加载+seek+PATCH+行内响应式更新）
  await page.waitForSelector('tbody tr:first-child img.thumb', { timeout: 25000 });
  ck('老记录（无 thumb）进页面自动回填缩略图', true);
  const v2 = topVideo();
  ck('回填已持久化到库', !!v2 && v2.thumb.length > 1000, v2 && `thumb=${v2.thumb.length}B`);
  await page.screenshot({ path: 'Logs/piano-thumb-backfill.png', fullPage: false });

  // ---------- PATCH /piano/thumb/:id 接口校验 ----------
  let r = await fetch(`${B}/api/piano/thumb/${v1.id}`, { method: 'PATCH', headers: A, body: JSON.stringify({ thumb: 'not-a-data-url' }) });
  ck('非法格式 400', r.status === 400, String(r.status));
  r = await fetch(`${B}/api/piano/thumb/99999`, { method: 'PATCH', headers: A, body: JSON.stringify({ thumb: 'data:image/jpeg;base64,AAAA' }) });
  ck('记录不存在 404', r.status === 404, String(r.status));
  // 他人记录 403：建普通用户 kid（无 piano tab 授权时接口也应被页/tab 权限拦）
  r = await fetch(`${B}/api/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'kid', password: 'Kid123456', role: 'user', allowed_pages: ['learning'], allowed_tabs: { learning: ['piano'] } }) });
  ck('创建成员 kid（学习页+练琴 tab）', r.status === 200, String(r.status));
  const kid = await login('kid', 'Kid123456');
  r = await fetch(`${B}/api/piano/thumb/${v1.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + kid.token },
    body: JSON.stringify({ thumb: 'data:image/jpeg;base64,AAAA' }),
  });
  ck('非本人/非管理员改他人缩略图 403', r.status === 403, String(r.status));
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
