// E2E：短消息 v1.9.24 —— ①电脑桌面通知代理（脚本下发/EXEMPT key+uid 轮询/点击已读/自动播放偏好）
// ②语音消息（WAV 上传/落库/Range 播放/权限/自动转写降级/多人群发/微信式气泡/右下角弹窗）。
// 转写引擎在 e2e 环境不安装：自动/手动转写走「引擎未安装」的优雅失败路径（voice_state=failed）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'tmp-messages-e2e');
const PORT = 3998;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  <<< ' + extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const boot = async () => {
  const s = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456', TTS_ROOT: path.join(DATA, 'no-tts') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.stdout.on('data', () => {});
  s.stderr.on('data', (d) => console.error('[srv-err]', String(d).slice(0, 200)));
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); return s; }
    catch { /* 未就绪 */ }
  }
  throw new Error('server not ready in 20s');
};

// 16k 单声道 PCM16 正弦波 WAV（与服务端校验、代理播放、转写引擎输入同格式）
function makeWav(secs = 1.5, rate = 16000) {
  const n = Math.floor(secs * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 8000), 44 + i * 2);
  return buf;
}

let srv, browser;
try {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  srv = await boot();
  const HJ = { 'Content-Type': 'application/json' };
  let lj = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: HJ, body: JSON.stringify({ username: 'admin', password: 'test123456' }) })).json();
  const A = { ...HJ, Authorization: 'Bearer ' + lj.token };
  await fetch(`${B}/api/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'uA', password: 'ua123456', allowed_pages: [] }) });
  await fetch(`${B}/api/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'uB', password: 'ub123456', allowed_pages: [] }) });
  const tA = (await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: HJ, body: JSON.stringify({ username: 'uA', password: 'ua123456' }) })).json());
  const tB = (await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: HJ, body: JSON.stringify({ username: 'uB', password: 'ub123456' }) })).json());
  const HA = { ...HJ, Authorization: 'Bearer ' + tA.token };
  const HB = { ...HJ, Authorization: 'Bearer ' + tB.token };
  const adminId = lj.user.id, uAId = tA.user.id;

  // ---------- 语音消息 API ----------
  await fetch(`${B}/api/messages`, { method: 'POST', headers: A, body: JSON.stringify({ to_user: uAId, subject: '文本测试', content: '你好 uA' }) });

  const wav = makeWav(1.5);
  let r = await fetch(`${B}/api/messages/voice`, { method: 'POST', headers: A, body: JSON.stringify({ to_user: uAId, subject: '语音测试', wav_b64: wav.toString('base64'), secs: 1.5 }) });
  let j = await r.json();
  ck('T1 语音上传 200 返回消息 id', r.status === 200 && j.id > 0, JSON.stringify(j));
  const vId = j.id;

  r = await fetch(`${B}/api/messages?user_id=${adminId}`, { headers: HA });
  j = await r.json();
  const vm = (j.messages || []).find((m) => m.id === vId);
  ck('T2 会话里语音条字段齐（is_voice/secs/state）', vm && vm.is_voice === 1 && vm.voice_secs === 1.5 && vm.voice_state !== undefined, JSON.stringify(vm));
  ck('T3 文字消息与语音消息共存', (j.messages || []).some((m) => m.subject === '文本测试' && m.content === '你好 uA'));

  r = await fetch(`${B}/api/messages/${vId}/read`, { method: 'POST', headers: HA }); // 标已读，避免后面弹窗断言受干扰
  r = await fetch(`${B}/api/messages/voice/${vId}`, { headers: HA });
  ck('T4 语音本体 200 audio/wav + RIFF 头', r.status === 200 && (r.headers.get('content-type') || '').includes('audio/wav')
    && Buffer.from(await r.arrayBuffer()).subarray(0, 4).toString('ascii') === 'RIFF');
  r = await fetch(`${B}/api/messages/voice/${vId}`, { headers: { ...HA, Range: 'bytes=0-1' } });
  ck('T5 Range 探测 206（<audio> 可播的前提）', r.status === 206 && (r.headers.get('content-range') || '').startsWith('bytes 0-1/'), `${r.status} ${r.headers.get('content-range')}`);
  r = await fetch(`${B}/api/messages/voice/${vId}`, { headers: HB });
  ck('T6 会话外的用户 403', r.status === 403, `status=${r.status}`);

  r = await fetch(`${B}/api/messages/voice/${vId}/transcribe`, { method: 'POST', headers: HA });
  j = await r.json();
  ck('T7 无引擎时手动转写优雅失败（提示装引擎，不崩）', r.status === 500 && /引擎未安装/.test(j.error || ''), `${r.status} ${JSON.stringify(j)}`);

  // 群发：一语音两收件人（各自一条消息、文件各一份）
  r = await fetch(`${B}/api/messages/voice`, { method: 'POST', headers: A, body: JSON.stringify({ to_users: [uAId, tB.user.id], wav_b64: wav.toString('base64'), secs: 2 }) });
  j = await r.json();
  ck('T8 群发语音 count=2', r.status === 200 && j.count === 2, JSON.stringify(j));

  // v1.9.25：不带主题的语音 → 默认「<发送人>发出的语音信息」（列表/弹窗不再空标题）
  r = await fetch(`${B}/api/messages/voice`, { method: 'POST', headers: A, body: JSON.stringify({ to_user: uAId, wav_b64: wav.toString('base64'), secs: 1 }) });
  j = await r.json();
  // 用发送人（admin）视角读同一条会话——uA 视角会把她收到的未读全标已读，殃及后面 B3 的轮询断言
  const j9 = await (await fetch(`${B}/api/messages?user_id=${uAId}`, { headers: A })).json();
  const m9 = (j9.messages || []).find((m) => m.id === j.id);
  ck('T9 空主题语音默认「admin发出的语音信息」', r.status === 200 && j.id > 0 && m9 && m9.subject === 'admin发出的语音信息', JSON.stringify(m9));

  // ---------- 桌面通知代理 ----------
  r = await fetch(`${B}/api/messages/agent/script?type=install`, { headers: A });
  const cmdBuf = Buffer.from(await r.arrayBuffer());
  const cmdTxt = cmdBuf.toString('utf8');
  ck('A1 安装脚本 200 octet-stream + ASCII 头', r.status === 200 && cmdTxt.startsWith('@echo off') && cmdTxt.includes('::WB-PAYLOAD::'));
  const marker = cmdTxt.lastIndexOf('::WB-PAYLOAD::'); // 头部 PS 命令里的标记是拼接形式（'::WB-'+'PAYLOAD::'），真标记在最后
  const b64 = cmdTxt.slice(marker + '::WB-PAYLOAD::'.length).trim();
  const psBuf = Buffer.from(b64, 'base64');
  const psTxt = psBuf.toString('utf8');
  ck('A2 载荷 UTF-8 BOM（PS5.1 中文必需，三字节 EF BB BF）', psBuf.subarray(0, 3).toString('hex') === 'efbbbf', psBuf.subarray(0, 3).toString('hex'));
  ck('A3 ps1 内嵌下载来源地址 + uid', psTxt.includes(`$Server = '${B}'`) && psTxt.includes(`$Uid    = ${adminId}`), psTxt.split('\n').slice(5, 8).join('|'));
  const keyM = /\$Key\s+= '([0-9a-f]{32})'/.exec(psTxt);
  ck('A4 ps1 内嵌 32hex 每用户密钥', !!keyM);
  const agentKey = keyM ? keyM[1] : '';
  ck('A5 常驻分支齐全（TLS C# 回调/互斥/弹窗点击已读/开机自启）',
    psTxt.includes('NotifyTlsTrust') && psTxt.includes('Global\\WorkbenchNotify') && psTxt.includes('BalloonTipClicked')
    && psTxt.includes('/api/messages/agent/read') && psTxt.includes('CurrentVersion\\Run'), '关键词缺失');

  r = await fetch(`${B}/api/messages/agent/script?type=ps1`, { headers: HA });
  const ps2 = Buffer.from(await r.arrayBuffer());
  ck('A6 裸 ps1 下载带 BOM（二进制保真）', ps2.subarray(0, 3).toString('hex') === 'efbbbf');
  const keyA = /\$Key\s+= '([0-9a-f]{32})'/.exec(ps2.toString('utf8'));
  ck('A7 每用户密钥各不同（admin≠uA）', keyA && keyA[1] !== agentKey);
  const uAKey = keyA ? keyA[1] : '';

  r = await fetch(`${B}/api/messages/agent/script?type=uninstall`, { headers: A });
  const un = (await r.text());
  ck('A8 卸载脚本自包含（Run 键 + WorkbenchNotify 目录 + 按目录杀进程）', un.includes('WorkbenchNotify') && un.includes('CurrentVersion\\Run') && un.includes('Win32_Process'));
  r = await fetch(`${B}/api/messages/agent/script?type=xx`, { headers: A });
  ck('A9 未知类型 400', r.status === 400);

  // 轮询：无 key/错 key 403；对 key 返回未读新消息（语音带 base64）。
  // 注意 T2 打开会话已把 admin→uA 的旧消息自动标已读——这里补发一条新文本专门验证轮询载荷
  await fetch(`${B}/api/messages`, { method: 'POST', headers: A, body: JSON.stringify({ to_user: uAId, subject: '', content: '弹窗文字内容测试' }) });
  r = await fetch(`${B}/api/messages/agent/poll?uid=${adminId}&after=0`);
  ck('B1 无 key 403（EXEMPT 但需凭证）', r.status === 403);
  r = await fetch(`${B}/api/messages/agent/poll?uid=${adminId}&key=0000000000000000000000000000dead&after=0`);
  ck('B2 错 key 403', r.status === 403);
  r = await fetch(`${B}/api/messages/agent/poll?uid=${uAId}&key=${uAKey}&after=0`);
  j = await r.json();
  const voicePoll = (j.messages || []).find((m) => m.is_voice);
  ck('B3 uA 代理轮询拿到未读语音（b64 + autoplay 默认开）', r.status === 200 && j.ok && j.autoplay === true && voicePoll && voicePoll.voice_b64
    && Math.ceil(voicePoll.voice_secs) >= 1, JSON.stringify(j).slice(0, 200));
  ck('B4 文字消息内容在轮询载荷里（网页弹窗同款内容）', (j.messages || []).some((m) => m.content === '弹窗文字内容测试'));
  const pollId = voicePoll ? voicePoll.id : 0;
  const lastId = j.last_id || 0;

  r = await fetch(`${B}/api/messages/agent/read`, { method: 'POST', headers: HJ, body: JSON.stringify({ key: uAKey, uid: uAId, id: pollId }) });
  ck('B5 弹窗点击已读（key+uid 凭证）', r.status === 200 && (await r.json()).ok === true);
  r = await fetch(`${B}/api/messages/agent/poll?uid=${uAId}&key=${uAKey}&after=0`);
  j = await r.json();
  ck('B6 已读后不再弹出（与网页弹窗同步）', !(j.messages || []).some((m) => m.id === pollId));
  r = await fetch(`${B}/api/messages/agent/poll?uid=${uAId}&key=${uAKey}&after=${lastId}`);
  j = await r.json();
  ck('B7 after=last_id 增量轮询为空', r.status === 200 && (j.messages || []).length === 0);

  r = await fetch(`${B}/api/messages/agent/prefs`, { method: 'PUT', headers: HA, body: JSON.stringify({ autoplay: false }) });
  r = await fetch(`${B}/api/messages/agent/prefs`, { headers: HA });
  j = await r.json();
  ck('B8 自动播放偏好可关（默认开→关）', j.autoplay === false, JSON.stringify(j));
  r = await fetch(`${B}/api/messages/agent/poll?uid=${uAId}&key=${uAKey}&after=0`);
  j = await r.json();
  ck('B9 轮询回传 autoplay=false', j.autoplay === false);
  await fetch(`${B}/api/messages/agent/prefs`, { method: 'PUT', headers: HA, body: JSON.stringify({ autoplay: true }) }); // 复原默认开（UI 断言用）

  // ---------- UI ----------
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addInitScript((t) => { localStorage.setItem('wb_token', t); }, tA.token);
  await ctx.addInitScript((u) => { localStorage.setItem('wb_user', u); }, JSON.stringify(tA.user));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.error('  [page-error]', String(e).slice(0, 200)));
  p.on('console', (m) => { if (m.type() === 'error') console.error('  [console-error]', m.text().slice(0, 200)); });

  await p.goto(`${B}/#/messages`);
  await p.waitForSelector('.card');
  ck('U1 页面底部有「电脑桌面通知」卡：安装/卸载按钮 + 自动播放勾选', (await p.locator('h3').filter({ hasText: '电脑桌面通知' }).count()) === 1
    && await p.locator('button', { hasText: '下载安装脚本' }).count() === 1
    && await p.locator('button', { hasText: '下载卸载脚本' }).count() === 1
    && await p.locator('.card input[type=checkbox]').first().isChecked());
  ck('U2 卡上标注当前内嵌地址', (await p.locator('.card', { hasText: '电脑桌面通知' }).innerText()).includes(B));

  // 会话里的语音气泡：明确点 admin 那一行（列表第一行未必是 admin——无未读时排序不定）
  await p.locator('.list-item', { hasText: 'admin' }).first().click();
  await p.waitForSelector('.bubble', { timeout: 8000 });
  await sleep(400);
  const bubbleCount = await p.locator('.bubble').count();
  const voiceCount = await p.locator('.voice-msg').count();
  ck('U3 微信式语音气泡渲染（▶ + 秒数）', voiceCount >= 1
    && (await p.locator('.voice-msg .vm-secs').first().innerText()).match(/^\d+"$/), `bubbles=${bubbleCount} voice=${voiceCount}`);
  if (!voiceCount) await p.screenshot({ path: path.join(ROOT, 'Logs', 'e2e-messages-debug.png'), fullPage: true });
  ck('U4 转写失败态显示「未转写 · 点我转文字」按钮', await p.locator('button.vm-tag', { hasText: '未转写' }).count() >= 1);
  const voiceReq = p.waitForRequest((rq) => rq.url().includes('/api/messages/voice/') && rq.url().includes('token='), { timeout: 6000 });
  await p.locator('.voice-msg').first().click();
  await voiceReq;
  ck('U5 点击气泡发起播放请求（?token= 通道）', true);

  // 右下角弹窗：admin 再发一条语音给 uA → dispatch 检查事件 → toast 显示 🎤 语音
  await fetch(`${B}/api/messages/voice`, { method: 'POST', headers: A, body: JSON.stringify({ to_user: uAId, wav_b64: makeWav(1).toString('base64'), secs: 1 }) });
  await p.evaluate(() => window.dispatchEvent(new CustomEvent('wb-messages-check')));
  await p.waitForSelector('.msg-toast', { timeout: 6000 });
  await sleep(400);
  ck('U6 网页弹窗对语音消息显示 🎤 语音（不显示空内容）', await p.locator('.msg-toast').filter({ hasText: '语音' }).count() >= 1,
    (await p.locator('.msg-toast').allInnerTexts()).join('||').slice(0, 160));

  // 语音转写手动重试（无引擎 → 红条提示，不崩）
  await p.locator('button.vm-tag', { hasText: '未转写' }).first().click();
  await p.waitForSelector('.msg.err', { timeout: 6000 });
  ck('U7 手动转写失败提示红条（含引擎未安装说明）', ((await p.locator('.msg.err').first().innerText())).includes('引擎未安装'));
  await p.screenshot({ path: path.join(ROOT, 'Logs', 'e2e-messages-voice.png'), fullPage: true });

  console.log(`\n== 短消息语音+桌面通知 e2e: ${pass} 通过 / ${fail} 失败 ==`);
} catch (e) {
  fail++;
  console.error('e2e 异常：', e);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (srv) srv.kill();
  await sleep(700);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
}
process.exit(fail ? 1 : 0);
