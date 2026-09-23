// VibeVoice-ASR 7B 代理路径 E2E（无 GPU：sidecar --proxy 直连「假 vLLM」，API 分发按 engine 隔离）
// 运行：node scripts/e2e-vibe7b-proxy.mjs   （需工作台已用含 vibe7b 的新代码启动，默认 3000）
//
// A) sidecar 代理模式：node server/vibeasr/server.js --proxy <假vLLM> --engine vibe7b --label VibeVoice-ASR-7B
//    → /health 就绪（透传假 vLLM 的 /v1/models）、/v1/chat/completions 原样转发 + 归一 utterances、假 vLLM 宕机 → /health ready=false
// B) API 分发：settings.client_engine=vibe7b → 任务入队带 engine=vibe7b → job/next 按引擎隔离领取（1.5B 领不到 7B）
//    → job/:id/result 回传 7B 结构化 → 落库 done（说话人分离 + 时间戳）
// finally：kill 假 vLLM/sidecar、删测试记录、恢复设置与客户端登记（绝不碰真实 1.5B/7B 引擎与既有数据）
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const BASE = process.env.WB_URL || 'http://127.0.0.1:3000';
const WAV = process.env.WAV || 'C:/Users/W/AppData/Local/Temp/wtest/tts-zh.wav';
const USER = process.env.WB_USER || 'admin';
const PASS = process.env.WB_PASS || 'admin123';
const MOCK_PORT = 9691;    // 假 vLLM（OpenAI 兼容）
const SIDECAR_PORT = 9692; // 测试用 7B sidecar（代理模式）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (cond, name, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? ' —— ' + extra : '')); }
};

// ---------- 登录 ----------
let token = '';
{
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
  const d = await r.json().catch(() => ({}));
  token = d.token || '';
  ok(!!token, `登录 ${USER}`, JSON.stringify(d).slice(0, 120));
}
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
const j = async (url, opt = {}) => {
  const r = await fetch(BASE + url, { ...opt, headers: { ...H, ...(opt.headers || {}) } });
  let d = null; try { d = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, d };
};

// ---------- 客户端登记密钥（主库 settings.vibe_client_key；读不到就现生成写回，与 server 进程一致） ----------
const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
function clientKey() {
  const row = db.prepare("SELECT value FROM settings WHERE key='vibe_client_key'").get();
  if (row) { try { return JSON.parse(row.value); } catch { return row.value; } }
  const k = crypto.randomBytes(16).toString('hex');
  db.prepare("INSERT INTO settings(key,value) VALUES('vibe_client_key',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(k));
  return k;
}
const KEY = clientKey();

// ---------- 快照（finally 恢复） ----------
const origSettings = (await j('/api/vibe/settings')).d;
const origClients = db.prepare("SELECT value FROM settings WHERE key='vibe_clients'").get();

// ---------- 假 vLLM：返回 7B 结构化 JSON（说话人 + 时间戳） ----------
const FAKE_UTT = [
  { 'Start time': '00:00:01.000', 'End time': '00:00:03.200', 'Speaker ID': 1, 'Content': '明天下午三点项目评审会' },
  { 'Start time': '00:00:03.200', 'End time': '00:00:05.500', 'Speaker ID': 2, 'Content': '在会议室见' },
];
let mockOpen = false;
const mock = http.createServer((req, res) => {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method === 'GET' && req.url === '/v1/models') return send(200, { data: [{ id: 'VibeVoice-ASR' }] });
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    return send(200, { choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(FAKE_UTT) }, finish_reason: 'stop' }] });
  }
  send(404, { error: { message: 'not found' } });
});

let sidecar = null, sidecarErr = '';
const kill = (p) => { try { p?.kill(); } catch { /* 已退出 */ } };

let recId = 0;
try {
  // ================= A) sidecar 代理模式（假 vLLM） =================
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r)); mockOpen = true;
  sidecar = spawn(process.execPath, [
    'server/vibeasr/server.js', '--proxy', `http://127.0.0.1:${MOCK_PORT}`,
    '--engine', 'vibe7b', '--label', 'VibeVoice-ASR-7B', '--port', String(SIDECAR_PORT),
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  sidecar.stderr.on('data', (d) => { sidecarErr += String(d); });

  // 等 sidecar 就绪（代理模式 /health 会实时探假 vLLM）
  let health = null;
  for (let i = 0; i < 25; i++) {
    health = await fetch(`http://127.0.0.1:${SIDECAR_PORT}/health`).then((r) => r.json()).catch(() => null);
    if (health && typeof health.ready === 'boolean') break;
    await sleep(300);
  }
  ok(health && health.ready === true, 'sidecar /health 就绪（代理到假 vLLM）', JSON.stringify(health));
  ok(health && /7B|vLLM/i.test(String(health.engine || '')), 'health.engine 标识 7B/vLLM', health && health.engine);
  ok(health && health.proxy === `http://127.0.0.1:${MOCK_PORT}`, 'health.proxy 指向假 vLLM', health && health.proxy);

  // 转发转写：OpenAI 合约 → 假 vLLM → 归一 utterances
  {
    const body = {
      model: 'vibevoice',
      messages: [
        { role: 'system', content: 'You are a helpful assistant that transcribes audio input into text output in JSON format.' },
        { role: 'user', content: [{ type: 'audio_url', audio_url: { url: 'data:audio/wav;base64,AAAA' } }, { type: 'text', text: 'This is a 5.50 seconds audio' }] },
      ],
      max_tokens: 32768, temperature: 0, top_p: 1, stream: false,
    };
    const r = await fetch(`http://127.0.0.1:${SIDECAR_PORT}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await r.json().catch(() => ({}));
    let utter = null; try { utter = JSON.parse(d?.choices?.[0]?.message?.content || ''); } catch { /* 解析失败 */ }
    ok(r.status === 200, 'sidecar 转发 /v1/chat/completions → 200', r.status);
    ok(Array.isArray(utter) && utter.length === 2, '返回归一 utterances（2 段）', (d?.choices?.[0]?.message?.content || '').slice(0, 120));
    ok(utter && utter[0].Content === '明天下午三点项目评审会' && utter[0]['Speaker ID'] === 1, '7B 结构化字段（Content/Speaker ID）保留', JSON.stringify(utter && utter[0]));
  }

  // 假 vLLM 宕机 → /health ready=false
  await new Promise((r) => mock.close(r)); mockOpen = false;
  {
    const h = await fetch(`http://127.0.0.1:${SIDECAR_PORT}/health`).then((r) => r.json()).catch(() => null);
    ok(h && h.ready === false, '假 vLLM 宕机后 /health ready=false', JSON.stringify(h));
  }

  // ================= B) API 分发（engine 隔离） =================
  {
    const put = await j('/api/vibe/settings', { method: 'PUT', body: JSON.stringify({ engine_mode: 'client', client_engine: 'vibe7b' }) });
    ok(put.d.engine_mode === 'client' && put.d.client_engine === 'vibe7b', '设置切 client+vibe7b', JSON.stringify(put.d));
  }
  ok((await j('/api/vibe/settings')).d.client_engine === 'vibe7b', 'settings 回读 client_engine=vibe7b');

  {
    const r = await fetch(BASE + '/api/vibe/client-register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: KEY, url: `http://127.0.0.1:${SIDECAR_PORT}`, host: 'e2e-7b-host', cores: 8, engine: 'vibe7b', gpu: 'RTX 3060 (e2e)' }) });
    const d = await r.json().catch(() => ({}));
    ok(d.ok === true, '登记 7B 客户端（engine=vibe7b）', JSON.stringify(d));
  }
  {
    const { d } = await j('/api/vibe/client-status');
    ok(!!d.engines?.vibeasr && !!d.engines?.vibe7b, 'client-status 返回两套引擎', JSON.stringify(d.engines && Object.keys(d.engines)));
    ok(d.engines?.vibe7b?.host === 'e2e-7b-host', '7B 客户端 host 已登记', d.engines?.vibe7b?.host);
    ok(/3060/.test(d.engines?.vibe7b?.gpu || ''), '7B 客户端 gpu 上报', d.engines?.vibe7b?.gpu);
    ok(d.client_engine === 'vibe7b' && d.online === true, '7B 客户端在线（client_engine=vibe7b）', JSON.stringify({ client_engine: d.client_engine, online: d.online }));
  }

  // 上传 → 转写 → 任务入队（带 engine=vibe7b）
  {
    const fd = new FormData();
    fd.append('audio', new Blob([readFileSync(WAV)], { type: 'audio/wav' }), 'e2e-7b.wav');
    fd.append('source', 'upload');
    fd.append('duration_hint', '7.4');
    const r = await fetch(BASE + '/api/vibe/upload', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd });
    const d = await r.json().catch(() => ({}));
    recId = d.id || 0;
    ok(recId > 0, `上传录音 id=${recId}`, JSON.stringify(d).slice(0, 100));
  }
  {
    const { d } = await j(`/api/vibe/transcribe/${recId}`, { method: 'POST' });
    ok(d.ok && d.status === 'running', '转写启动（client 模式入队）', JSON.stringify(d));
  }
  let jobRow = null;
  for (let i = 0; i < 30; i++) {
    jobRow = db.prepare("SELECT id, status, COALESCE(engine,'vibeasr') engine FROM vibe_jobs WHERE record_id=? ORDER BY id DESC LIMIT 1").get(recId);
    if (jobRow && jobRow.status === 'queued') break;
    await sleep(300);
  }
  ok(jobRow && jobRow.status === 'queued', '任务入队 queued', JSON.stringify(jobRow));
  ok(jobRow && jobRow.engine === 'vibe7b', '任务带 engine=vibe7b 标记', jobRow && jobRow.engine);

  // 隔离：1.5B 客户端领不到 7B 任务
  {
    const r = await fetch(BASE + '/api/vibe/job/next', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: KEY, engine: 'vibeasr', host: 'e2e-1p5' }) });
    ok(r.status === 204, '1.5B 客户端 job/next → 204（领不到 7B 任务）', r.status);
  }
  // 7B 客户端领取
  let jobId = 0;
  {
    const r = await fetch(BASE + '/api/vibe/job/next', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: KEY, engine: 'vibe7b', host: 'e2e-7b-host', cores: 8 }) });
    const d = await r.json().catch(() => ({}));
    jobId = d.id || 0;
    ok(r.status === 200 && jobId > 0, '7B 客户端 job/next 领到任务', `jobId=${jobId}`);
    ok(d.body && d.body.model === 'vibevoice' && Array.isArray(d.body.messages) && (d.body.messages[1]?.content || []).some((c) => c.type === 'audio_url'), '任务体含音频 data URL', JSON.stringify(d.body && { model: d.body.model, nMsg: d.body.messages?.length }));
  }
  {
    const r = await fetch(BASE + '/api/vibe/job/next', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: KEY, engine: 'vibe7b', host: 'e2e-7b-host' }) });
    ok(r.status === 204, '已领取后再次 job/next → 204', r.status);
  }
  // 回传 7B 结构化结果 → 落库 done
  {
    const r = await fetch(BASE + `/api/vibe/job/${jobId}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: KEY, ok: true, content: JSON.stringify(FAKE_UTT), model: 'VibeVoice-ASR-7B' }) });
    const d = await r.json().catch(() => ({}));
    ok(d.ok === true, '回传结果 ok', JSON.stringify(d));
  }
  {
    let row = null;
    for (let i = 0; i < 20; i++) {
      const list = (await j('/api/vibe/records?page=1&pageSize=5')).d;
      row = (list.rows || []).find((x) => x.id === recId);
      if (row && row.status !== 'running') break;
      await sleep(300);
    }
    ok(row && row.status === 'done', `转写落库 done（status=${row && row.status}）`, row && row.error);
    ok(!!row && /7B/.test(row.model || ''), `模型记录带 7B（${row && row.model}）`);
    const { d: t } = await j(`/api/vibe/transcript/${recId}`);
    ok(/说话人 2/.test(t.transcript_md || ''), '转写含说话人分离（说话人 2）', (t.transcript_md || '').slice(0, 160));
    ok(/\d{2}:\d{2}:\d{2}\.\d{3}/.test(t.transcript_md || ''), '时间戳（毫秒格式）存在', (t.transcript_md || '').slice(0, 160));
    ok(/明天下午三点项目评审会/.test(t.transcript_md || ''), '转写内容正确', (t.transcript_md || '').slice(0, 160));
  }
} finally {
  // ---------- 清理：kill 进程、删测试行、恢复设置/登记 ----------
  kill(sidecar);
  if (mockOpen) await new Promise((r) => { try { mock.close(r); } catch { r(); } });
  if (recId) {
    const { status } = await j(`/api/vibe/records/${recId}`, { method: 'DELETE' });
    console.log(`[清理] 删除测试记录 #${recId}: HTTP ${status}`);
  }
  await fetch(BASE + '/api/vibe/settings', { method: 'PUT', headers: H, body: JSON.stringify(origSettings) }).catch(() => {});
  console.log('[清理] 设置已恢复:', JSON.stringify({ engine_mode: origSettings.engine_mode, server_engine: origSettings.server_engine, client_engine: origSettings.client_engine }));
  if (origClients) db.prepare("INSERT INTO settings(key,value) VALUES('vibe_clients',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(origClients.value);
  else db.prepare("DELETE FROM settings WHERE key='vibe_clients'").run();
  if (sidecarErr) console.log('[sidecar stderr 摘要]', sidecarErr.split('\n').slice(0, 6).join(' | ').slice(0, 400));
  db.close();
}

console.log(`\nE2E ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
