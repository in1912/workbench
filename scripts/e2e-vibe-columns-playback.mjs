// E2E：录音转写列表新增「撰写耗时 / 使用模型」两列 + 手机播放修复（Range/206）。
// A) API：上传测试 wav → Range 矩阵（0-1 / 后缀 -N / 越界 416 / 无 Range 200+Content-Length）
//    → server+whisper+zh 真实转写 → 断言 elapsed_ms>0、model 含 whisper、records 行带新字段
// B) UI：表头两列、行内容、播放弹窗（audio 无 error、可解码）
// finally：只删自建测试行 + 设置按快照原样恢复（绝不全表 DELETE）
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const BASE = 'http://localhost:3000';
const WAV = 'C:/Users/W/AppData/Local/Temp/wtest/tts-zh.wav';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lr = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
const tok = (await lr.json()).token;
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok };
console.log('[0] 登录成功');

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };

// ---- A) API ----
const orig = await (await fetch(BASE + '/api/vibe/settings', { headers: H })).json();
console.log('[1] 原设置:', JSON.stringify({ engine_mode: orig.engine_mode, server_engine: orig.server_engine, whisper_lang: orig.whisper_lang }));

const buf = readFileSync(WAV);
let myId = 0;
try {
  const fd = new FormData();
  fd.append('audio', new Blob([buf], { type: 'audio/wav' }), 'e2e-cols.wav');
  fd.append('source', 'upload');
  fd.append('duration_hint', '7.4');
  const up = await (await fetch(BASE + '/api/vibe/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + tok }, body: fd })).json();
  myId = up.id;
  ck('上传测试录音', !!myId, JSON.stringify(up));

  // Range 矩阵（inline 播放形态）
  const aUrl = `${BASE}/api/vibe/audio/${myId}?inline=1&token=${tok}`;
  const r01 = await fetch(aUrl, { headers: { Range: 'bytes=0-1' } });
  const b01 = Buffer.from(await r01.arrayBuffer());
  ck('bytes=0-1 → 206', r01.status === 206, r01.status);
  ck('  Content-Range 头', (r01.headers.get('content-range') || '') === `bytes 0-1/${buf.length}`, r01.headers.get('content-range'));
  ck('  正文=文件头 2 字节 RI', b01.length === 2 && b01.equals(buf.subarray(0, 2)), b01.toString('hex'));
  ck('  Accept-Ranges: bytes', r01.headers.get('accept-ranges') === 'bytes');

  const rSuf = await fetch(aUrl, { headers: { Range: `bytes=-50` } });
  const bSuf = Buffer.from(await rSuf.arrayBuffer());
  ck('后缀 bytes=-50 → 206 末尾 50 字节', rSuf.status === 206 && bSuf.length === 50 && bSuf.equals(buf.subarray(buf.length - 50)), `${rSuf.status} ${bSuf.length}B`);

  const rMid = await fetch(aUrl, { headers: { Range: 'bytes=100-199' } });
  const bMid = Buffer.from(await rMid.arrayBuffer());
  ck('中段 bytes=100-199', rMid.status === 206 && bMid.equals(buf.subarray(100, 200)), `${rMid.status} ${bMid.length}B`);

  const r416 = await fetch(aUrl, { headers: { Range: `bytes=${buf.length + 10}-` } });
  ck('越界 → 416 + bytes */N', r416.status === 416 && (r416.headers.get('content-range') || '') === `bytes */${buf.length}`, r416.status + ' ' + r416.headers.get('content-range'));

  const rFull = await fetch(aUrl);
  ck('无 Range → 200', rFull.status === 200, rFull.status);
  ck('  Content-Length=文件大小', Number(rFull.headers.get('content-length')) === buf.length, rFull.headers.get('content-length'));
  ck('  Content-Type=audio/wav', (rFull.headers.get('content-type') || '').includes('audio/wav'), rFull.headers.get('content-type'));
  await rFull.arrayBuffer();

  // 转写（真实本地 Whisper 引擎）
  await fetch(BASE + '/api/vibe/settings', { method: 'PUT', headers: H, body: JSON.stringify({ ...orig, engine_mode: 'server', server_engine: 'whisper', whisper_lang: 'zh' }) });
  console.log('[2] 临时切 server+whisper+zh，开始转写…');
  await fetch(BASE + `/api/vibe/transcribe/${myId}`, { method: 'POST', headers: H, body: '{}' });
  const t0 = Date.now();
  let row = null;
  for (let i = 0; i < 90; i++) { // 最长 4.5 分钟
    await sleep(3000);
    const list = await (await fetch(BASE + '/api/vibe/records?page=1&pageSize=10', { headers: H })).json();
    row = (list.rows || []).find((x) => x.id === myId);
    if (row && row.status !== 'running') break;
  }
  ck('转写完成 done', row && row.status === 'done', row && row.status + ' ' + (row && row.error));
  ck('elapsed_ms 字段>0（撰写耗时）', Number(row && row.elapsed_ms) > 0, JSON.stringify(row && row.elapsed_ms));
  ck('  elapsed 与真实耗时同量级', row && Math.abs(Number(row.elapsed_ms) - (Date.now() - t0)) < 120000, row && row.elapsed_ms);
  ck('model 字段含 whisper（使用模型）', /whisper/i.test(String(row && row.model)), row && row.model);
  const tr = await (await fetch(BASE + `/api/vibe/transcript/${myId}`, { headers: H })).json();
  ck('转写内容正确', /明天下午3点|项目评审会|会议室/.test(tr.transcript_md || ''), (tr.transcript_md || '').slice(0, 80));

  // ---- B) UI ----
  const db = new DatabaseSync('data/workbench.sqlite');
  db.exec('PRAGMA busy_timeout = 8000');
  const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
  const uiTok = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+10 minutes'))").run(uiTok, admin.id);
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.addInitScript((t) => {
      localStorage.setItem('wb_token', t);
      localStorage.setItem('wb_user', JSON.stringify({ id: 1, username: 'admin', role: 'admin', allowed_pages: [], allowed_tabs: {} }));
    }, [uiTok]);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(BASE + '/#/tools?tab=vibe');
    await page.waitForSelector('.tbl th');
    await sleep(1200);

    const heads = await page.locator('.tbl th').allInnerTexts();
    ck('UI 表头含「撰写耗时」', heads.includes('撰写耗时'), JSON.stringify(heads));
    ck('UI 表头含「使用模型」', heads.includes('使用模型'));
    ck('UI 共 12 列', heads.length === 12, heads.length);

    const myRow = page.locator('.tbl tbody tr', { hasText: 'e2e-cols' });
    await myRow.waitFor({ timeout: 8000 });
    const cells = await myRow.locator('td').allInnerTexts();
    // 列序：…转写状态(5) 是否生成文本(6) 撰写耗时(7) 使用模型(8) 容量(9)…
    ck('行内撰写耗时非 —', (cells[7] || '').trim() !== '—' && /秒|分/.test(cells[7] || ''), cells[7]);
    ck('行内使用模型=whisper', /whisper/i.test(cells[8] || ''), cells[8]);

    // 播放弹窗：audio 加载成功（无 error、能解码）
    await myRow.locator('button', { hasText: '播放' }).click();
    await page.waitForSelector('.player-box audio');
    const audioOk = await page.waitForFunction(() => {
      const a = document.querySelector('.player-box audio');
      return a && a.error === null && a.readyState >= 2 && isFinite(a.duration) && a.duration > 0;
    }, { timeout: 15000 }).then(() => true).catch(() => false);
    ck('播放器可加载解码（无 error）', audioOk);
    ck('播放器无错误提示文案', !(await page.locator('.player-box .err').count()));
    await page.locator('.player-box audio').evaluate((a) => { a.pause(); });
    await page.screenshot({ path: 'Logs/vibe-columns-playback.png' });

    ck('UI 无 pageerror', !errors.length, errors.join('; ').slice(0, 200));
  } finally {
    await browser.close();
    db.prepare('DELETE FROM sessions WHERE token=?').run(uiTok);
  }
} finally {
  if (myId) {
    const del = await fetch(BASE + `/api/vibe/records/${myId}`, { method: 'DELETE', headers: H });
    console.log('[清理] 删除测试行 #' + myId + ': HTTP ' + del.status);
  }
  await fetch(BASE + '/api/vibe/settings', { method: 'PUT', headers: H, body: JSON.stringify(orig) });
  console.log('[清理] 设置已恢复:', JSON.stringify({ engine_mode: orig.engine_mode, server_engine: orig.server_engine, whisper_lang: orig.whisper_lang }));
}

console.log(`\nE2E ${pass} 通过, ${fail} 失败`);
if (fail) process.exitCode = 1;
