// E2E：练琴录像功能（v1.2.3）
// 后端：视频上传（kind/thumb/file_size）+ 容量回显 + Range 播放 + 清理原文件（保留记录）+ 权限 + 老字段兼容
// UI（Playwright 假摄像头）：🎥 录像→预览→停止上传→列表缩略图/容量→点击弹窗播放→🧹清理→🎤录音回归
// 用法：node scripts/e2e-piano-video.mjs  （隔离 DATA_DIR 起服务，测完自动清理）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'tmp-piano-e2e');
const PORT = 3999;
const B = `http://127.0.0.1:${PORT}`;
const ADMIN = { username: 'admin', password: 'test123456' };

let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  <<< ' + extra}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });

// ---------- 起隔离服务（空库：不会连生产钉钉 Stream） ----------
const srv = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: ADMIN.username, DEFAULT_ADMIN_PASSWORD: ADMIN.password, TTS_ROOT: path.join(DATA, 'no-tts') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', (d) => console.error('[srv-err]', String(d).slice(0, 300)));
await sleep(2500);

try {
  // ---------- 登录 ----------
  let r = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ADMIN) });
  const lj = await r.json();
  ck('管理员登录', r.status === 200 && !!lj.token, JSON.stringify(lj).slice(0, 120));
  const HA = { Authorization: 'Bearer ' + lj.token };

  // ---------- 1. 视频上传 ----------
  const videoBytes = crypto.randomBytes(64 * 1024); // 64KB 假 webm（服务端不校验容器内容）
  const thumbData = 'data:image/jpeg;base64,' + Buffer.from('fakejpegbytes').toString('base64');
  const mp = new FormData();
  mp.append('media', new Blob([videoBytes], { type: 'video/webm' }), 'piano-123-video.webm');
  mp.append('kind', 'video');
  mp.append('thumb', thumbData);
  mp.append('duration_sec', '95');
  mp.append('started_at', '2026-09-06 10:00:00');
  mp.append('ended_at', '2026-09-06 10:01:35');
  r = await fetch(`${B}/api/piano/upload`, { method: 'POST', headers: HA, body: mp });
  const vj = await r.json();
  ck('视频上传成功', r.status === 200 && vj.ok && vj.kind === 'video', JSON.stringify(vj).slice(0, 150));
  ck('上传返回容量', vj.file_size === videoBytes.length, `${vj.file_size} vs ${videoBytes.length}`);
  const videoId = vj.id;
  const videoPath = vj.file_path;
  ck('视频文件已落盘', !!videoPath && fs.existsSync(videoPath), videoPath);

  // ---------- 2. 列表回显 ----------
  r = await fetch(`${B}/api/piano/records`, { headers: HA });
  const recs = await r.json();
  const row = (recs.rows || []).find((x) => x.id === videoId);
  ck('列表含视频行', !!row);
  ck('kind=video', row && row.kind === 'video');
  ck('缩略图已存', row && row.thumb === thumbData, (row && row.thumb || '').slice(0, 40));
  ck('容量列有值', row && row.file_size === videoBytes.length);

  // ---------- 3. Range 播放（弹窗 video 依赖） ----------
  r = await fetch(`${B}/api/piano/file/${videoId}?token=${lj.token}`, { headers: { Range: 'bytes=10-35' } });
  const ranged = Buffer.from(await r.arrayBuffer());
  ck('Range 206 且字节一致', r.status === 206 && ranged.equals(videoBytes.subarray(10, 36)), `status=${r.status} len=${ranged.length}`);
  ck('Content-Type=video/webm', (r.headers.get('content-type') || '') === 'video/webm', r.headers.get('content-type'));

  // ---------- 4. 音频上传（新字段 media + 老字段 audio 各一次） ----------
  const audioBytes = crypto.randomBytes(8 * 1024);
  for (const [fieldName, label] of [['media', '新字段 media'], ['audio', '老字段 audio']]) {
    const mp2 = new FormData();
    mp2.append(fieldName, new Blob([audioBytes], { type: 'audio/webm' }), 'piano-audio.webm');
    mp2.append('duration_sec', '30');
    const rr = await fetch(`${B}/api/piano/upload`, { method: 'POST', headers: HA, body: mp2 });
    const jj = await rr.json();
    ck(`音频上传（${label}）`, rr.status === 200 && jj.kind === 'audio' && jj.file_size === audioBytes.length, JSON.stringify(jj).slice(0, 120));
  }

  // ---------- 5. 清理原文件（保留记录） ----------
  r = await fetch(`${B}/api/piano/file/${videoId}`, { method: 'DELETE', headers: HA });
  ck('清理原文件 200', r.status === 200, String(r.status));
  ck('磁盘文件已删', !fs.existsSync(videoPath));
  r = await fetch(`${B}/api/piano/records`, { headers: HA });
  const row2 = (await r.json()).rows.find((x) => x.id === videoId);
  ck('记录保留且 file_deleted=1', row2 && row2.file_deleted === 1 && row2.duration_sec === 95);
  r = await fetch(`${B}/api/piano/file/${videoId}?token=${lj.token}`);
  ck('清理后播放 404', r.status === 404);
  r = await fetch(`${B}/api/piano/file/${videoId}`, { method: 'DELETE', headers: HA });
  ck('重复清理幂等', r.status === 200, String(r.status));

  // ---------- 6. 方法还原中间件 + Connection: close（花生壳中转掐 PATCH 的对策） ----------
  // PUT + X-HTTP-Method: PATCH → 服务端还原为 PATCH 命中 PATCH 路由（404 记录不存在 = 路由已命中）
  r = await fetch(`${B}/api/piano/confirm/999999`, { method: 'PUT', headers: { ...HA, 'Content-Type': 'application/json', 'X-HTTP-Method': 'PATCH' }, body: JSON.stringify({ valid_sec: 60 }) });
  ck('PUT+还原头 命中 PATCH 路由', r.status === 404 && (await r.json()).error === '记录不存在', String(r.status));
  // 真实 PATCH 依旧直通（局域网/本地直连路径不受影响）
  r = await fetch(`${B}/api/piano/confirm/999999`, { method: 'PATCH', headers: { ...HA, 'Content-Type': 'application/json' }, body: JSON.stringify({ valid_sec: 60 }) });
  ck('原生 PATCH 依旧可用', r.status === 404, String(r.status));
  // 无还原头的 PUT 不该命中 PATCH 路由（piano 无 PUT 路由 → 404 但错误文案不同/同 404；此处只验证不炸）
  r = await fetch(`${B}/api/piano/confirm/999999`, { method: 'PUT', headers: { ...HA, 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
  ck('裸 PUT 不误伤', r.status === 404, String(r.status));
  // 响应带 Connection: close（防中转死套接字复用）
  ck('响应头 Connection: close', (r.headers.get('connection') || '').includes('close'), r.headers.get('connection') || '(无)');

  // ---------- 7. 权限：他人不可清理 ----------
  r = await fetch(`${B}/api/users`, { method: 'POST', headers: { ...HA, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'p2', password: '123456a', role: 'user' }) });
  ck('建普通用户', r.status === 200, String(r.status));
  r = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'p2', password: '123456a' }) });
  const t2 = (await r.json()).token;
  const mp3 = new FormData();
  mp3.append('media', new Blob([crypto.randomBytes(4096)], { type: 'video/webm' }), 'x.webm');
  mp3.append('kind', 'video'); mp3.append('duration_sec', '10');
  const up2 = await (await fetch(`${B}/api/piano/upload`, { method: 'POST', headers: { Authorization: 'Bearer ' + t2 }, body: mp3 })).json();
  ck('普通用户可上传自己的', up2.ok === true, JSON.stringify(up2).slice(0, 100));
  r = await fetch(`${B}/api/piano/file/${up2.id}`, { method: 'DELETE', headers: HA });
  ck('管理员可清他人文件', r.status === 200, String(r.status));
  // p2 再传一条，试着清 admin 的（此时 admin 那条已清理，重传一条）
  const mp4 = new FormData();
  mp4.append('media', new Blob([crypto.randomBytes(4096)], { type: 'audio/webm' }), 'y.webm');
  mp4.append('duration_sec', '5');
  const up3 = await (await fetch(`${B}/api/piano/upload`, { method: 'POST', headers: HA, body: mp4 })).json();
  r = await fetch(`${B}/api/piano/file/${up3.id}`, { method: 'DELETE', headers: { Authorization: 'Bearer ' + t2 } });
  ck('他人清理被拒 403', r.status === 403, String(r.status));

  // ---------- UI：假摄像头完整录像流程 ----------
  console.log('\n== UI（Playwright 假摄像头） ==');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await browser.newContext();
  await ctx.addInitScript((t) => { localStorage.setItem('wb_token', t); }, lj.token);
  await ctx.addInitScript((u) => { localStorage.setItem('wb_user', u); }, JSON.stringify(lj.user || { id: 1, username: 'admin', role: 'admin' }));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${B}/#/learning?tab=piano`);
  await page.waitForSelector('.piano .list h3', { timeout: 15000 });
  await page.waitForTimeout(600);

  ck('录音/录像两个独立按钮', (await page.locator('button.rec-btn:has-text("开始录音")').count()) === 1 && (await page.locator('button.rec-btn:has-text("开始录像")').count()) === 1);
  ck('尺寸选择 160/320', await page.locator('.size-chips .chip').count() === 2);
  ck('默认 160 小规格', (await page.locator('.size-chips .chip.on').textContent()).trim() === '160');
  await page.locator('.size-chips .chip', { hasText: '320' }).click();
  ck('可切回 320', (await page.locator('.size-chips .chip.on').textContent()).trim() === '320');
  await page.locator('.size-chips .chip', { hasText: '160' }).click();
  const before = (await page.locator('.piano tbody tr').count());

  // 录像 4 秒（直接点「开始录像」按钮，无需先切模式）
  await page.locator('button.rec-btn:has-text("开始录像")').click();
  await page.waitForSelector('.rec-time:has-text("录像中")', { timeout: 8000 });
  ck('摄像头预览出现', await page.locator('.cam-preview').count() === 1);
  await page.waitForTimeout(4200); // ≥3s 录制 + 缩略图抓帧（600ms 后）
  await page.locator('button:has-text("停止并保存")').click();
  await page.waitForFunction(() => document.querySelector('.rec-btn') && document.querySelector('.rec-btn').textContent.includes('开始'), null, { timeout: 20000 });
  await page.waitForTimeout(1200);
  const after = (await page.locator('.piano tbody tr').count());
  ck('新增一行记录', after === before + 1, `after=${after} before=${before}`);

  const firstRow = page.locator('.piano tbody tr').first();
  const thumb = firstRow.locator('img.thumb');
  ck('视频行显示缩略图', await thumb.count() === 1);
  if (await thumb.count()) {
    ck('缩略图可渲染', await thumb.evaluate((el) => el.naturalWidth > 0));
  }
  const sizeTxt = (await firstRow.locator('td').nth(9).textContent() || '').trim();
  ck('容量列有值', /\d+(\.\d+)?\s*(B|KB|MB)/.test(sizeTxt), sizeTxt);

  // 点击缩略图 → 弹窗播放
  await thumb.click();
  const vvideo = page.locator('.viewer-video');
  ck('弹窗视频出现', await vvideo.count() === 1 && (await vvideo.getAttribute('src') || '').includes('/api/piano/file/'));
  await page.waitForTimeout(800);
  ck('视频可播放', await vvideo.evaluate((el) => el.readyState >= 2 && el.videoWidth > 0).catch(() => false), 'readyState/videoWidth');
  await page.locator('.viewer-modal button:has-text("关闭")').click();
  ck('弹窗关闭', await page.locator('.viewer-video').count() === 0);

  // 🧹 清理原文件
  const broom = firstRow.locator('button.icon-btn[title*="原文件"]');
  ck('清理按钮存在', await broom.count() === 1);
  await broom.click();
  await page.waitForTimeout(800);
  const pathTxt = (await firstRow.locator('td').nth(8).textContent() || '');
  ck('行显示原文件已清理', pathTxt.includes('已清理'), pathTxt.trim().slice(0, 40));
  ck('清理后容量列 —', (await firstRow.locator('td').nth(9).textContent()).trim() === '—');

  // 🎤 录音回归（直接点「开始录音」按钮）
  await page.locator('button.rec-btn:has-text("开始录音")').click();
  await page.waitForSelector('.rec-time:has-text("录音中")', { timeout: 8000 });
  await page.waitForTimeout(2500);
  await page.locator('button:has-text("停止并保存")').click();
  await page.waitForFunction(() => document.querySelector('.rec-btn') && document.querySelector('.rec-btn').textContent.includes('开始'), null, { timeout: 20000 });
  await page.waitForTimeout(1200);
  const audioRow = page.locator('.piano tbody tr').first();
  ck('音频行 ▶播放（非缩略图）', await audioRow.locator('.path.play').count() === 1 && await audioRow.locator('img.thumb').count() === 0);

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
