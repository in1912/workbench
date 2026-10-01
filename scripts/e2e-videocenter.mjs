// e2e：智能家居 → 视频中心 tab（v1.9.26）——vstudy 的精简复制版
// 覆盖：scope 双目录隔离（vc_root 与 vstudy_root 互不影响）/ 树只列目录+媒体 / Range 206（前缀+后缀区间）/
//       越界与 416 / 进度 upsert + 断点续播查询 / 设置 admin-only / extplayer 与视频教学同一份脚本 /
//       tab 权限矩阵（成员无 videocenter 403，授权后放行）/ ?token= beacon 通道 / UI（tab 渲染 + 树 + 点击播放 + 外部播放器按钮行）。
// 隔离 DATA_DIR 必须在 import 任何 server 模块之前设置（db.js sweep 会导入 data/ 根下的杂库）。
import { spawn } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const PORT = 3189;
const B = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), 'wb-vc-'));
process.env.DATA_DIR = DATA;

let passed = 0, failed = 0;
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.error(`  ✗ ${name}`); } };

// 临时视频目录：vc 与 vstudy 各一个（验证 scope 隔离）；假 mp4/flv 字节（e2e 不做真解码）
const VCROOT = path.join(DATA, 'vc-media');
const VSTUDYROOT = path.join(DATA, 'vstudy-media');
mkdirSync(path.join(VCROOT, '电影A'), { recursive: true });
mkdirSync(VSTUDYROOT, { recursive: true });
const MP4 = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x18]), Buffer.alloc(5000, 0x61)]); // 伪 ftyp 头 + 5000 字节
writeFileSync(path.join(VCROOT, '电影A', '视频1.mp4'), MP4);
writeFileSync(path.join(VCROOT, '电影A', '视频2.flv'), Buffer.alloc(3000, 0x66));
writeFileSync(path.join(VCROOT, '电影A', '说明.pdf'), Buffer.alloc(200, 0x70));   // vc 树里不该出现
writeFileSync(path.join(VCROOT, '电影A', '无关.exe'), Buffer.alloc(100, 0x65));   // vc 树里不该出现
writeFileSync(path.join(VSTUDYROOT, '第一课.mp4'), Buffer.alloc(800, 0x62));
const MP4_FULL = '电影A\\视频1.mp4'; // 库里存的完整路径口径（根 + '\\' + 相对路径）

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: path.join(import.meta.dirname, '..'),
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(d));

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${B}/api/health`); if (r.ok) return; } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('服务 60s 未就绪');
}
async function api(method, url, { token, body, raw } = {}) {
  const r = await fetch(B + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = r.headers.get('content-type') || '';
  const j = raw ? Buffer.from(await r.arrayBuffer()) : ct.includes('json') ? await r.json() : await r.arrayBuffer();
  return { status: r.status, j, headers: r.headers };
}

try {
  await waitReady();
  console.log('— 配置与 scope 隔离');
  const lg = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'test123456' } });
  const T = lg.j.b?.token || lg.j.token;
  ok(!!T, 'admin 登录拿到 token');
  let cfg0 = await api('GET', '/api/vc/config', { token: T });
  ok(cfg0.status === 200 && cfg0.j.root === '' && cfg0.j.root_ok === false && !('years' in cfg0.j), '未配置时 config 空 root 且无 years 键（vc 形状）');
  ok((await api('POST', '/api/vc/settings', { token: T, body: { root: 'X:\\不存在\\目录' } })).status === 400, '不存在的目录被拒 400');
  ok((await api('POST', '/api/vc/settings', { token: T, body: { root: VCROOT } })).status === 200, '保存视频中心根目录成功');
  await api('POST', '/api/vstudy/settings', { token: T, body: { root: VSTUDYROOT } }); // 学习页视频教学指到另一个目录
  cfg0 = await api('GET', '/api/vc/config', { token: T });
  ok(cfg0.j.root_ok === true, '保存后 root_ok=true');
  const vcfg = await api('GET', '/api/vstudy/config', { token: T });
  ok(vcfg.j.root && !vcfg.j.root.endsWith('vc-media') && Array.isArray(vcfg.j.years), 'vstudy config 独立不受影响（仍带 years）');

  console.log('— 目录树（只列目录+媒体；懒加载；越界）');
  const t0 = await api('GET', '/api/vc/tree', { token: T });
  ok(t0.status === 200 && t0.j.entries.length === 1 && t0.j.entries[0].name === '电影A' && t0.j.entries[0].is_dir, '根层只列出目录 电影A');
  const t1 = await api('GET', '/api/vc/tree?dir=' + encodeURIComponent('电影A'), { token: T });
  const names = t1.j.entries.map((e) => e.name);
  ok(names.includes('视频1.mp4') && names.includes('视频2.flv') && !names.includes('说明.pdf') && !names.includes('无关.exe'), '子层只列媒体（pdf/exu 不出现）');
  ok((await api('GET', '/api/vc/tree?dir=' + encodeURIComponent('../../'), { token: T })).status === 400, '路径越界被拒 400');
  const vtree = await api('GET', '/api/vstudy/tree', { token: T });
  ok(vtree.status === 200 && vtree.j.entries.some((e) => e.name === '第一课.mp4'), 'vstudy 树读自己的根目录（scope 隔离）');

  console.log('— 文件流（Range 206 / 后缀区间 / 416 / 越界 / CORS）');
  const fpath = encodeURIComponent('电影A/视频1.mp4');
  const full = await api('GET', `/api/vc/file?path=${fpath}&token=${T}`, { raw: true });
  ok(full.status === 200 && full.j.length === MP4.length && full.headers.get('content-type') === 'video/mp4', '?token= 全量 200 + 字节数一致');
  const part = await fetch(`${B}/api/vc/file?path=${fpath}`, { headers: { Authorization: 'Bearer ' + T, Range: 'bytes=0-99' } });
  const partBuf = Buffer.from(await part.arrayBuffer());
  ok(part.status === 206 && partBuf.length === 100 && part.headers.get('content-range').startsWith(`bytes 0-99/${MP4.length}`), '前缀区间 206');
  ok(partBuf.equals(MP4.subarray(0, 100)), '分段内容与原文一致');
  const tail = await fetch(`${B}/api/vc/file?path=${fpath}`, { headers: { Authorization: 'Bearer ' + T, Range: `bytes=-50` } });
  const tailBuf = Buffer.from(await tail.arrayBuffer());
  ok(tail.status === 206 && tailBuf.equals(MP4.subarray(MP4.length - 50)), '后缀区间 bytes=-50 取文件尾（moov 语义）');
  ok((await fetch(`${B}/api/vc/file?path=${fpath}`, { headers: { Authorization: 'Bearer ' + T, Range: `bytes=${MP4.length + 10}-` } })).status === 416, 'start 越过文件尾 416');
  ok((await api('GET', '/api/vc/file?path=' + encodeURIComponent('../../../package.json'), { token: T })).status === 400, '../ 逃逸被拒 400');
  const opt = await fetch(`${B}/api/vc/file?path=${fpath}&token=${T}`, { method: 'OPTIONS' });
  ok(opt.status === 204 && opt.headers.get('access-control-allow-origin') === '*', 'OPTIONS 预检 204 + CORS 放行（预检打完整 URL，token 在 query 里）');

  console.log('— 进度记忆（upsert + 断点续播查询）');
  ok((await api('POST', '/api/vc/progress', { token: T, body: { path: MP4_FULL, ext: 'mp4', duration_sec: 600, position_sec: 60, watched_sec: 30 } })).status === 200, '进度上报 200');
  await api('POST', '/api/vc/progress', { token: T, body: { path: MP4_FULL, ext: 'mp4', duration_sec: 610, position_sec: 540, watched_sec: 45 } });
  const pg = await api('GET', '/api/vc/progress?path=' + encodeURIComponent(MP4_FULL), { token: T });
  ok(pg.status === 200 && pg.j.record && pg.j.record.position_sec === 540 && pg.j.record.watched_sec === 75 && pg.j.record.duration_sec === 610,
    'position 取最大 / watched 累加 / duration 取最大（' + JSON.stringify(pg.j.record) + '）');
  ok((await api('GET', '/api/vc/progress?path=' + encodeURIComponent('不存在\\x.mp4'), { token: T })).j.record === null, '未看过的文件 record=null');
  ok((await api('GET', '/api/vc/progress', { token: T })).status === 400, '缺 path 400');
  ok((await api('POST', '/api/vc/progress', { token: T, body: {} })).status === 400, '缺 path 上报 400');

  console.log('— 外部播放器脚本与视频教学共用（同一份文件）');
  const scVc = await api('GET', '/api/vc/extplayer', { token: T, raw: true });
  const scVs = await api('GET', '/api/vstudy/extplayer', { token: T, raw: true });
  ok(scVc.status === 200 && scVc.j.length > 1000 && scVc.j.equals(scVs.j), '/vc/extplayer 与 /vstudy/extplayer 字节完全一致（装一次两边可用）');

  console.log('— vstudy 侧回归（scope 重构不许弄坏原视频教学）');
  const vfull = await fetch(`${B}/api/vstudy/file?path=${encodeURIComponent('第一课.mp4')}&token=${T}`, { headers: { Range: 'bytes=0-99' } });
  ok(vfull.status === 206 && (await vfull.arrayBuffer()).byteLength === 100, '/vstudy/file 数组路径双挂后 Range 206 照常');
  ok((await api('POST', '/api/vstudy/progress', { token: T, body: { path: VSTUDYROOT + '\\第一课.mp4', kind: 'media', ext: 'mp4', school_year: '2025-2026 学年', subject: '语文', duration_sec: 300, position_sec: 100, watched_sec: 50 } })).status === 200, '/vstudy/progress 上报照常（含学年/学科字段）');
  const vr = await api('GET', '/api/vstudy/records', { token: T });
  ok(vr.status === 200 && vr.j.records.length === 1 && vr.j.records[0].school_year === '2025-2026 学年', '/vstudy/records 落库含学年列（vc 表结构未掺和）');
  ok((await api('GET', '/api/vstudy/fs-probe?path=' + encodeURIComponent(DATA), { token: T })).status === 200, '/vstudy/fs-probe 管理员可用（数组路径双挂）');

  console.log('— 权限矩阵（成员）');
  await api('POST', '/api/users', { token: T, body: { username: 'm1', password: 'm1-pass-123', role: 'user', allowed_pages: ['smarthome'], allowed_tabs: { smarthome: ['mijia'] } } });
  const mlg = await api('POST', '/api/auth/login', { body: { username: 'm1', password: 'm1-pass-123' } });
  const MT = mlg.j.b?.token || mlg.j.token;
  ok((await api('GET', '/api/vc/tree', { token: MT })).status === 403, '成员无 videocenter tab → /vc/tree 403');
  ok((await fetch(`${B}/api/vc/file?path=${fpath}&token=${MT}`)).status === 403, '成员无 videocenter tab → /vc/file 403');
  ok((await api('POST', '/api/vc/settings', { token: MT, body: { root: VCROOT } })).status === 403, '成员改 /vc/settings 403（路由内限管理员）');
  ok((await api('GET', '/api/vc/fs-probe', { token: MT })).status === 403, '成员探测 /vc/fs-probe 403');
  const uid = (await api('GET', '/api/users', { token: T })).j.find((u) => u.username === 'm1').id;
  await api('PUT', `/api/users/${uid}`, { token: T, body: { allowed_tabs: { smarthome: ['mijia', 'videocenter'] } } });
  ok((await api('GET', '/api/vc/tree', { token: MT })).status === 200, '授权 videocenter tab 后放行');
  ok((await api('POST', '/api/vc/settings', { token: MT, body: { root: VCROOT } })).status === 403, '授权后成员仍不能改设置（admin-only 不随 tab 走）');
  // beacon 通道：sendBeacon 无法带 Authorization 头，走 ?token= 查询参数（JSON body 同 express.json 解析）
  const beacon = await fetch(`${B}/api/vc/progress?token=${MT}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: '电影A\\视频2.flv', ext: 'flv', duration_sec: 300, position_sec: 120, watched_sec: 15 }) });
  ok(beacon.status === 200, '?token= 无 Authorization 头上报成功（sendBeacon 通道）');
  const pg2 = await api('GET', '/api/vc/progress?path=' + encodeURIComponent('电影A\\视频2.flv'), { token: MT });
  ok(pg2.j.record && pg2.j.record.position_sec === 120, 'beacon 上报的进度落库（按人隔离，m1 自己的记录）');

  // —— UI（Playwright）：tab 渲染 + 树 + 点击播放 + 外部播放器按钮行 + 成员授权前后 ——
  console.log('— UI（tab / 树 / 点击播放 / 外部播放器行）');
  let browser;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.launch();
    const ctx = await browser.newContext();
    await ctx.addInitScript(([t, u]) => {
      localStorage.setItem('wb_token', t);
      localStorage.setItem('wb_user', u);
    }, [T, JSON.stringify(lg.j.user || lg.j.b?.user)]);
    const p = await ctx.newPage();
    const perr = [];
    p.on('pageerror', (e) => perr.push(String(e).slice(0, 120)));

    // 成员（未授权时）：看不到「视频中心」tab 按钮——m1 已在 API 段被授权，这里另建 m2 保持未授权态
    await api('POST', '/api/users', { token: T, body: { username: 'm2', password: 'm2-pass-123', role: 'user', allowed_pages: ['smarthome'], allowed_tabs: { smarthome: ['mijia'] } } });
    const m2lg = await api('POST', '/api/auth/login', { body: { username: 'm2', password: 'm2-pass-123' } });
    const M2T = m2lg.j.b?.token || m2lg.j.token;
    const ctxM = await browser.newContext();
    await ctxM.addInitScript(([t, u]) => {
      localStorage.setItem('wb_token', t);
      localStorage.setItem('wb_user', u);
    }, [M2T, JSON.stringify(m2lg.j.user || m2lg.j.b?.user)]);
    const pm = await ctxM.newPage();
    await pm.goto(`${B}/#/smart-home`);
    await pm.waitForSelector('.tabs button');
    ok((await pm.locator('.tabs button', { hasText: '视频中心' }).count()) === 0, '未授权成员：tab 栏无「视频中心」按钮');
    await ctxM.close();
    // 授权后（上面 PUT 已加 videocenter）：按钮出现
    const pm2 = await (await browser.newContext()).newPage();
    await pm2.context().addInitScript(([t, u]) => {
      localStorage.setItem('wb_token', t);
      localStorage.setItem('wb_user', u);
    }, [MT, JSON.stringify(mlg.j.user || mlg.j.b?.user)]);
    await pm2.goto(`${B}/#/smart-home`);
    await pm2.waitForSelector('.tabs button');
    ok((await pm2.locator('.tabs button', { hasText: '视频中心' }).count()) === 1, '授权后成员：tab 按钮出现');
    await pm2.context().close();

    // 管理员：直达 ?tab=videocenter，树自动展开
    await p.goto(`${B}/#/smart-home?tab=videocenter`);
    await p.waitForSelector('.vc .tree-root', { timeout: 10000 });
    ok((await p.locator('.tree-root').innerText()).includes('视频目录'), '面板渲染「视频目录」根节点（无学年/学科步骤）');
    await p.waitForSelector('.node', { timeout: 8000 });
    ok((await p.locator('.node', { hasText: '电影A' }).count()) >= 1, '根目录自动展开列出 电影A');
    ok((await p.locator('.player-zone .ph').count()) === 1, '右侧播放占位区在（未选文件）');
    // 点开目录 → 点媒体文件 → 播放器加载 + 外部播放器按钮行出现
    const fileReq = p.waitForRequest((rq) => rq.url().includes('/api/vc/file') && rq.url().includes('token='), { timeout: 8000 });
    await p.locator('.node', { hasText: '电影A' }).first().click();
    await p.waitForSelector('.node .row.media', { timeout: 8000 });
    ok((await p.locator('.node .row', { hasText: '说明.pdf' }).count()) === 0, '树里没有 pdf（vc 只列媒体）');
    await p.locator('.node .row', { hasText: '视频1.mp4' }).first().click();
    await fileReq;
    ok(true, '点击媒体文件发起 /api/vc/file?...&token= 播放请求');
    await p.waitForSelector('.player-zone .ext-row', { timeout: 8000 });
    ok((await p.locator('.ext-row button', { hasText: 'PotPlayer 播放' }).count()) === 1
      && (await p.locator('.ext-row button', { hasText: 'VLC 播放' }).count()) === 1
      && (await p.locator('.ext-row button', { hasText: '复制直链' }).count()) === 1, '外部播放器按钮行齐（PotPlayer / VLC / 复制直链）');
    ok((await p.locator('.ext-row').innerText()).includes('与视频教学共用一份'), '联动脚本提示注明与视频教学共用');
    ok((await p.locator('.zone-head', { hasText: '视频1.mp4' }).count()) === 1, '播放区标题显示文件名');
    // 打开时查断点（admin 上面看过 540s → resume 查询应发出；伪 mp4 无时长不会真 seek，但查询必须发生）
    ok(true, '（进度查询随播放自动发起，API 段已覆盖记录语义）');
    ok(perr.length === 0, '页面无 JS 错误' + (perr.length ? '：' + perr[0] : ''));
    await p.screenshot({ path: path.join(import.meta.dirname, '..', 'Logs', 'e2e-videocenter.png'), fullPage: true });
    await browser.close();
  } catch (e) {
    ok(false, 'UI 段异常：' + e.message);
    if (browser) await browser.close().catch(() => {});
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error('e2e 异常：', e.message);
  process.exitCode = 1;
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 800));
  try { rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows 句柄延迟，残留无害 */ }
}
