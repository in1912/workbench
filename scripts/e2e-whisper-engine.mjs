// Whisper 服务器引擎 E2E（本地 3000 全链路：设置/状态分发/真实转写/启停/安装幂等）
// 运行：node scripts/e2e-whisper-engine.mjs   （需 data/whisper 已装好引擎与 q8_0 模型）
// 真实转写用 SAPI TTS 清晰语音 wav（-l zh 时转写完美，见 /tmp/wtest outT1）。
import { readFileSync } from 'node:fs';

const BASE = process.env.WB_URL || 'http://127.0.0.1:3000';
const WAV = process.env.WAV || 'C:/Users/W/AppData/Local/Temp/wtest/tts-zh.wav';
const USER = process.env.WB_USER || 'admin';
const PASS = process.env.WB_PASS || 'admin123';

let token = '';
const HA = { Authorization: 'Bearer ' + token };
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`); }
};
const j = async (url, opt = {}) => {
  const r = await fetch(BASE + url, { ...opt, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(opt.headers || {}) } });
  let d = null;
  try { d = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, d };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 0. 登录 ----------
{
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
  const d = await r.json().catch(() => ({}));
  token = d.token || '';
  ok(!!token, `登录 ${USER}`, JSON.stringify(d).slice(0, 120));
}

// ---------- 1. 设置：whisper 首选（本机库可能残留 custom 模式，显式切回 server） ----------
{
  const { d } = await j('/api/vibe/settings');
  if (d.engine_mode !== 'server' || d.server_engine !== 'whisper') {
    const { d: d2 } = await j('/api/vibe/settings', { method: 'PUT', body: JSON.stringify({ engine_mode: 'server', server_engine: 'whisper' }) });
    ok(d2.engine_mode === 'server' && d2.server_engine === 'whisper', '切到 server+whisper（本机曾残留 custom）', JSON.stringify(d2));
  }
  const { d: d3 } = await j('/api/vibe/settings');
  ok(d3.server_engine === 'whisper', 'server_engine=whisper（首选）', JSON.stringify(d3));
  ok(d3.engine_mode === 'server', 'engine_mode=server');
  ok(d3.whisper_lang === 'auto' || d3.whisper_lang === 'zh', `whisper_lang 合法（当前 ${d3.whisper_lang}）`);
}

// ---------- 2. 引擎状态：两套引擎一次带回，顶层=选中引擎 ----------
{
  const { d } = await j('/api/vibe/engine/status');
  ok(!!d.engines?.whisper && !!d.engines?.vibeasr, 'status 返回 engines.{whisper,vibeasr}');
  ok(d.server_engine === 'whisper', 'status.server_engine=whisper');
  ok(d.engines.whisper.installed === true, 'whisper 引擎已装（bin+模型就位）');
  ok(d.port === d.engines.whisper.port, '顶层 port 跟随选中引擎');
  ok(Array.isArray(d.engines.whisper.install.steps) && d.engines.whisper.install.steps.length === 4, 'whisper 安装步骤 4 步');
}

// ---------- 3. 语言切换 → sidecar 以 zh 重启 ----------
{
  const { d } = await j('/api/vibe/settings', { method: 'PUT', body: JSON.stringify({ whisper_lang: 'zh' }) });
  ok(d.whisper_lang === 'zh', '保存 whisper_lang=zh');
  await sleep(5000); // 等旧 sidecar 退净、新的拉起
  for (let i = 0; i < 15; i++) {
    try {
      const h = await fetch('http://127.0.0.1:9655/health').then((r) => r.json()).catch(() => null);
      if (h && h.ready) { ok(h.lang === 'zh', `sidecar 以 zh 重启（health.lang=${h.lang}）`); break; }
    } catch { /* 重试 */ }
    await sleep(1000);
    if (i === 14) ok(false, 'sidecar 以 zh 重启', '15s 内 9655 未就绪');
  }
  // 非法语言被拒（回落当前值）
  const { d: d2 } = await j('/api/vibe/settings', { method: 'PUT', body: JSON.stringify({ whisper_lang: 'xx' }) });
  ok(d2.whisper_lang === 'zh', '非法语言被白名单拒绝');
}

// ---------- 4. 真实转写全链路（上传 → server 模式 whisper → done） ----------
let recId = 0;
{
  const fd = new FormData();
  const buf = readFileSync(WAV);
  fd.append('audio', new Blob([buf], { type: 'audio/wav' }), 'whisper-e2e.wav');
  fd.append('source', 'upload');
  fd.append('started_at', '2026-09-22 12:00:00');
  fd.append('ended_at', '2026-09-22 12:00:08');
  const r = await fetch(BASE + '/api/vibe/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
  const d = await r.json().catch(() => ({}));
  recId = d.id || 0;
  ok(recId > 0, `上传录音 id=${recId}`, JSON.stringify(d).slice(0, 120));
}
{
  const { d } = await j(`/api/vibe/transcribe/${recId}`, { method: 'POST' });
  ok(d.ok && d.status === 'running', '转写已启动（server+whisper 分发）');
  let row = null;
  for (let i = 0; i < 90; i++) { // 最长 90s（本机 RTF≈5，7.4s 音频约 36s + 模型加载 3~5s）
    await sleep(2000);
    const { d: list } = await j('/api/vibe/records?page=1&pageSize=5');
    row = (list.rows || []).find((x) => x.id === recId);
    if (row && row.status !== 'running') break;
  }
  ok(row && row.status === 'done', `转写完成（status=${row && row.status}）`, row && row.error || '');
  ok(!!row && row.has_text === 1, '生成文本标记');
  ok(!!row && /whisper/i.test(row.model || ''), `模型记录带 whisper（${row && row.model}）`);
  const { d: t } = await j(`/api/vibe/transcript/${recId}`);
  ok(/明天下午3点|项目评审会|会议室/.test(t.transcript_md || ''), '转写内容正确（清晰中文语音）', (t.transcript_md || '').slice(0, 200));
  ok(/\d{2}:\d{2}:\d{2}\.\d{3}/.test(t.transcript_md || ''), '时间戳存在（点号毫秒格式）');
  ok(/说话人 1/.test(t.transcript_md || ''), '说话人字段=1（单声道无分离）');
}

// ---------- 5. 启停（engine 参数分发） ----------
{
  const { d } = await j('/api/vibe/engine/stop', { method: 'POST', body: JSON.stringify({ engine: 'whisper' }) });
  ok(d.ok, '停止 whisper 服务');
  await sleep(1500);
  let st = await j('/api/vibe/engine/status').then((r) => r.d);
  ok(st.engines.whisper.service.running === false, 'whisper 服务已停');
  const { d: d2 } = await j('/api/vibe/engine/start', { method: 'POST', body: JSON.stringify({ engine: 'whisper' }) });
  ok(d2.ok, '启动 whisper 服务');
  let ready = false;
  for (let i = 0; i < 15; i++) {
    st = await j('/api/vibe/engine/status').then((r) => r.d);
    if (st.engines.whisper.service.ready) { ready = true; break; }
    await sleep(1000);
  }
  ok(ready, 'whisper 服务重新就绪');
}

// ---------- 6. 一键安装幂等（引擎+模型已在 → 各步跳过 → done，且服务被拉起） ----------
{
  const { d } = await j('/api/vibe/engine/install', { method: 'POST', body: JSON.stringify({ engine: 'whisper' }) });
  ok(d.ok, '触发一键安装（幂等路径）');
  let done = false, inst = null;
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    inst = (await j('/api/vibe/engine/status').then((r) => r.d)).engines.whisper.install;
    if (!inst.running && (inst.done || inst.error)) break;
  }
  ok(inst && inst.done && !inst.error, `安装完成（progress=${inst && inst.progress}%）`, inst && inst.error);
  ok(inst && inst.log.some((l) => /已存在，跳过/.test(l)), '已装组件被跳过（幂等）');
}

// ---------- 7. 取消安装（清除失败状态） ----------
{
  const { status, d } = await j('/api/vibe/engine/install-reset', { method: 'POST', body: JSON.stringify({ engine: 'whisper' }) });
  ok(status === 200 && d.ok, 'install-reset 清除安装状态');
  const st = await j('/api/vibe/engine/status').then((r) => r.d);
  ok(st.engines.whisper.install.progress === 0 && !st.engines.whisper.install.done, '状态已归零');
}

// ---------- 8. 旧客户端兼容：不带 engine 参数 → 落到 vibeasr，别误伤 whisper ----------
{
  const { d } = await j('/api/vibe/engine/stop', { method: 'POST', body: JSON.stringify({}) });
  ok(d.ok, '无 engine 参数的 stop 走 legacy（vibeasr）');
  const st = await j('/api/vibe/engine/status').then((r) => r.d);
  ok(st.engines.whisper.service.running === true || st.engines.whisper.service.ready === true, 'whisper 未被误停');
}

// ---------- 清理：只删本次测试行 ----------
if (recId) {
  const { status } = await j(`/api/vibe/records/${recId}`, { method: 'DELETE' });
  ok(status === 200, `清理测试记录 #${recId}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
