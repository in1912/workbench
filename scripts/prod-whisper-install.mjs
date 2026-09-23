// 生产 Whisper 引擎安装 + 真实转写验证（Linux whisper-cli 首次真机运行）：
// 1) 一键安装（拷贝随包 linux 二进制 + execCheck 指令集冒烟 + 834MB 模型 hf-mirror 续传下载）
// 2) 临时切 server+whisper+zh → 上传清晰中文 wav → 转写 → 校验 → 删除测试行 → 恢复原设置
import { readFileSync } from 'node:fs';

const BASE = 'http://localhost:3000';
const WAV = 'C:/Users/W/AppData/Local/Temp/wtest/tts-zh.wav';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const lr = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
const t = (await lr.json()).token;
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t };
console.log('[0] 登录成功');

// 原设置快照（测完原样恢复——生产的 engine_mode 可能是 client 拉取模式，不能动）
const orig = await (await fetch(BASE + '/api/vibe/settings', { headers: H })).json();
console.log('[1] 原设置:', JSON.stringify({ engine_mode: orig.engine_mode, server_engine: orig.server_engine, whisper_lang: orig.whisper_lang }));

let st = await (await fetch(BASE + '/api/vibe/engine/status', { headers: H })).json();
console.log('[2] 引擎状态: whisper.installed=' + st.engines.whisper.installed + ' vibeasr.installed=' + st.engines.vibeasr.installed + ' server_engine=' + st.server_engine);

if (!st.engines.whisper.installed) {
  console.log('[3] 触发一键安装…');
  await fetch(BASE + '/api/vibe/engine/install', { method: 'POST', headers: H, body: JSON.stringify({ engine: 'whisper' }) });
  let last = '';
  for (let i = 0; i < 240; i++) { // 最长 20 分钟（834MB 视 NAS 带宽）
    await sleep(5000);
    st = await (await fetch(BASE + '/api/vibe/engine/status', { headers: H })).json().catch(() => st);
    const ins = st.engines?.whisper?.install;
    if (!ins) continue;
    const line = `${ins.progress}% ${ins.error ? 'ERR:' + ins.error : (ins.running ? 'running' : 'stopped')}`;
    if (line !== last) { console.log('    ' + line + ' | ' + (ins.log.slice(-1)[0] || '')); last = line; }
    if (!ins.running && (ins.done || ins.error)) break;
  }
  const ins = st.engines.whisper.install;
  if (!ins.done) { console.log('[3] 安装未完成:', ins.error || JSON.stringify(ins).slice(0, 200)); process.exit(1); }
  console.log('[3] 安装完成 ✓');
} else {
  console.log('[3] 引擎已装，跳过安装');
}

// 临时切换（保留原值用于恢复）
const tmp = { ...orig, engine_mode: 'server', server_engine: 'whisper', whisper_lang: 'zh' };
await fetch(BASE + '/api/vibe/settings', { method: 'PUT', headers: H, body: JSON.stringify(tmp) });
console.log('[4] 临时切 server+whisper+zh');

try {
  const fd = new FormData();
  fd.append('audio', new Blob([readFileSync(WAV)], { type: 'audio/wav' }), 'prod-whisper-test.wav');
  fd.append('source', 'upload');
  fd.append('duration_hint', '7.4');
  const up = await (await fetch(BASE + '/api/vibe/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + t }, body: fd })).json();
  console.log('[5] 上传测试录音 id=' + up.id);
  await fetch(BASE + `/api/vibe/transcribe/${up.id}`, { method: 'POST', headers: H, body: '{}' });
  console.log('[6] 转写已启动（NAS CPU 上 7.4s 音频可能要几分钟）…');
  const t0 = Date.now();
  let row = null;
  for (let i = 0; i < 120; i++) { // 最长 10 分钟
    await sleep(5000);
    const list = await (await fetch(BASE + '/api/vibe/records?page=1&pageSize=10', { headers: H })).json();
    row = (list.rows || []).find((x) => x.id === up.id);
    if (row && row.status !== 'running') break;
    if (i % 6 === 5) console.log(`    ${Math.round((Date.now() - t0) / 1000)}s status=${row ? row.status : '?'}`);
  }
  const secs = Math.round((Date.now() - t0) / 1000);
  if (!row || row.status !== 'done') {
    console.log('[6] 转写失败/超时:', row && row.error, `（${secs}s）`);
  } else {
    const tr = await (await fetch(BASE + `/api/vibe/transcript/${up.id}`, { headers: H })).json();
    const good = /明天下午3点|项目评审会|会议室/.test(tr.transcript_md || '');
    console.log(`[6] 转写完成 ✓ 耗时 ${secs}s（RTF≈${(secs / 7.4).toFixed(1)}） 内容正确=${good}`);
    console.log('    摘要:', (tr.transcript_md || '').replace(/\s+/g, ' ').slice(0, 160));
    if (!good) { console.log('    ⚠ 内容不匹配，完整输出:', tr.transcript_md); }
  }
  // 只删本次创建的测试行
  const del = await fetch(BASE + `/api/vibe/records/${up.id}`, { method: 'DELETE', headers: H });
  console.log('[7] 清理测试行 #' + up.id + ': HTTP ' + del.status);
} finally {
  // 恢复原设置（engine_mode/server_engine/whisper_lang 全部按快照回放）
  const restore = { ...orig, engine_mode: orig.engine_mode, server_engine: orig.server_engine === 'vibeasr' ? 'vibeasr' : 'whisper', whisper_lang: orig.whisper_lang || 'auto' };
  await fetch(BASE + '/api/vibe/settings', { method: 'PUT', headers: H, body: JSON.stringify(restore) });
  console.log('[8] 设置已恢复:', JSON.stringify({ engine_mode: restore.engine_mode, server_engine: restore.server_engine, whisper_lang: restore.whisper_lang }));
}
