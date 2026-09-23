// VibeASR BitNet 本地引擎 sidecar：把 VibeASR.cpp 的 asr_stream_server（stdin/stdout 协议）
// 包成 OpenAI 兼容 /v1/chat/completions 服务，供工作台「录音转写」零改动调用（与 vLLM 7B 同合约）。
// 零依赖（Node 内置 http/child_process），可独立拷到任意机器运行（客户端一键部署包同款）。
//
// 用法: node server.js --bin <asr_stream_server(.exe)> --vae <vae.gguf> --lm <lm.gguf>
//                 [--port 9650] [--host 0.0.0.0] [--threads 4]
//
// 引擎协议（src/asr_server.cpp）:
//   启动加载模型 → stdout "---READY---"
//   stdin  每行: 音频文件路径 | CONTEXT:<热词> | EXIT
//   stdout "---ACK---"(CONTEXT 确认) | 内容 + "---END---"(chunk 结束, --no-token-stream 模式)
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');

// ---------- CLI 参数 ----------
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const BIN = opt('--bin', '');
const VAE = opt('--vae', '');
const LM = opt('--lm', '');
const PORT = Number(opt('--port', 9650)) || 9650;
const HOST = opt('--host', '0.0.0.0');
const THREADS = Number(opt('--threads', 4)) || 4;
// 拉取模式：客户端引擎多半在外网/NAT 后（工作台服务器永远连不到本机 IP），反过来主动回连领任务
const PULL = opt('--pull', '');   // 工作台地址（如 https://your.domain.com）
const PKEY = opt('--pkey', '');   // 登记密钥（部署包内嵌）
// 代理模式（7B 客户端）：本地不跑 BitNet，把 /v1/chat/completions 原样转发给 WSL2 里的 vLLM
// （VibeVoice-ASR 7B 只有 Linux vLLM 能跑，Windows 侧经 WSL2 localhost 转发直连 127.0.0.1:9660）
const PROXY = opt('--proxy', '');                       // vLLM 地址（如 http://127.0.0.1:9660）
const ENGINE = opt('--engine', 'vibeasr');              // 引擎标识（工作台按它分发任务：vibeasr|vibe7b）
const LABEL = opt('--label', 'VibeVoice-ASR-BitNet');   // 结果里显示的模型名（7B 传 VibeVoice-ASR-7B）

const log = (...a) => console.log(`[vibeasr-sidecar ${new Date().toLocaleTimeString('sv')}]`, ...a);

if (!PROXY && (!BIN || !VAE || !LM)) {
  console.error('用法: node server.js --bin <asr_stream_server> --vae <vae.gguf> --lm <lm.gguf> [--port 9650] [--threads 4]');
  console.error('  或:  node server.js --proxy http://127.0.0.1:9660 [--engine vibe7b] [--label VibeVoice-ASR-7B] [--port 9651]');
  process.exit(1);
}
if (!PROXY) for (const [label, p] of [['引擎', BIN], ['VAE 模型', VAE], ['LM 模型', LM]]) {
  if (!fs.existsSync(p)) { console.error(`错误: ${label}不存在: ${p}`); process.exit(1); }
}

// ---------- 引擎子进程 ----------
let engine = null;
let ready = false;
let lastError = '';
let lastContext = null;          // 上次下发的热词（相同则跳过 CONTEXT）
let stdoutBuf = '';              // 行缓冲
let collector = null;            // 当前请求的输出收集器 {chunks, resolve, reject, timer}

function startEngine() {
  const cmd = spawn(BIN, [
    '--vae-model', VAE, '--lm-model', LM, '-t', String(THREADS),
    '--greedy', '--no-token-stream',
    // 注意：1.5B BitNet 模型只输出纯文本（说话人+时间戳 JSON 是 7B 模型能力，
    // --prompt-format json 会让 1.5B 直接停住只出 1 个 token）
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  engine = cmd;
  cmd.stdout.setEncoding('utf8');
  cmd.stderr.setEncoding('utf8');
  cmd.stdout.on('data', onStdout);
  cmd.stderr.on('data', (d) => {
    const t = String(d).trim();
    if (t) log('[engine]', t.split('\n').slice(-2).join(' | '));
  });
  cmd.on('exit', (code) => {
    ready = false;
    lastError = `引擎进程退出 code=${code}`;
    log('[engine]', lastError);
    if (collector) { collector.reject(new Error(lastError)); collector = null; }
    // 冷却重启（引擎意外退出时自愈，60s 内只重试一次）
    if (!shuttingDown) {
      setTimeout(() => { if (!shuttingDown && !ready) startEngine(); }, 15_000).unref?.();
    }
  });
  return cmd;
}

function onStdout(data) {
  stdoutBuf += data;
  let idx;
  while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, idx).replace(/\r$/, '');
    stdoutBuf = stdoutBuf.slice(idx + 1);
    handleLine(line);
  }
}
function handleLine(line) {
  if (line === '---READY---') { ready = true; lastError = ''; log('引擎就绪'); return; }
  if (line === '---ACK---') return; // CONTEXT 确认
  if (!collector) return;
  if (line === '---END---') {
    const c = collector; collector = null;
    if (c.timer) clearTimeout(c.timer);
    const text = c.chunks.join('\n').trim();
    if (/^\[ERROR\]/.test(text)) c.reject(new Error(text.replace(/^\[ERROR\]\s*/, '')));
    else c.resolve(text);
    return;
  }
  collector.chunks.push(line);
}

// 等待引擎就绪（最长 120s：模型加载需数十秒）
function waitReady(ms = 120_000) {
  if (ready) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('引擎加载超时')), ms);
    const iv = setInterval(() => {
      if (ready) { clearTimeout(t); clearInterval(iv); resolve(); }
      else if (!engine || engine.exitCode !== null) { clearTimeout(t); clearInterval(iv); reject(new Error(lastError || '引擎进程已退出')); }
    }, 250);
  });
}

// ---------- 串行推理队列 ----------
let queueTail = Promise.resolve();
function enqueue(task) {
  const run = queueTail.then(task, task); // 前一个无论成败都继续
  queueTail = run.catch(() => {});
  return run;
}

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vibeasr-'));

// ---------- 代理模式的 HTTP 转发（node:http/https 直连，无内建超时——7B 在 12G 卡上一条长音频也可能跑十几分钟） ----------
function proxyJson(method, urlPath, body, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(PROXY);
    const lib = u.protocol === 'https:' ? require('https') : http;
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: urlPath, method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        let j = null;
        try { j = buf ? JSON.parse(buf) : null; } catch { /* 保持 null */ }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(j);
        else reject(new Error(`vLLM HTTP ${res.statusCode}: ${(j?.error?.message || j?.detail || buf || '').slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    if (timeoutMs > 0) req.setTimeout(timeoutMs, () => req.destroy(new Error('vLLM 连接超时')));
    if (payload) req.write(payload);
    req.end();
  });
}

// 代理模式健康检查：vLLM 起来才有 /v1/models（3s 快探，别把 pull 心跳拖死）
async function proxyHealthy() {
  try { await proxyJson('GET', '/v1/models', undefined, 3000); return { ok: true, ready: true, error: '' }; }
  catch (e) { return { ok: false, ready: false, error: e.message }; }
}

// 代理模式转写：请求体原样转发给 vLLM（工作台按 7B 合约构造的 messages 直通），content 回来后统一走 normalizeUtterances
async function proxyTranscribe(j) {
  const r = await proxyJson('POST', '/v1/chat/completions', j);
  const content = r?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('vLLM 未返回转写内容' + (r?.choices?.[0]?.finish_reason ? `（finish_reason=${r.choices[0].finish_reason}）` : ''));
  }
  return normalizeUtterances(content);
}

// 热词从工作台 prompt（"This is a X seconds audio, with extra info: <热词>…"）中提取
function extractHotwords(text) {
  const m = String(text || '').match(/with extra info:\s*(.+)/i);
  return m ? m[1].trim().slice(0, 500) : '';
}

// 引擎输出 → utterances 数组（7B vLLM 键名：Start time/End time/Speaker ID/Content）。
// 1.5B BitNet 输出纯文本 → 包装成单条转写（无说话人/时间戳，那是 7B 的能力）；
// 7B（vLLM/自定义服务）输出 JSON 数组 → 只做键名归一。
function normalizeUtterances(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const i = raw.indexOf('['), j = raw.lastIndexOf(']');
  const jsonPart = i >= 0 && j > i ? raw.slice(i, j + 1) : '';
  if (jsonPart) {
    try {
      const arr = JSON.parse(jsonPart);
      if (Array.isArray(arr) && arr.length) {
        return arr.map((x) => ({
          'Start time': x['Start time'] ?? x.Start ?? x.start ?? '',
          'End time': x['End time'] ?? x.End ?? x.end ?? '',
          'Speaker ID': x['Speaker ID'] ?? x.Speaker ?? x.speaker ?? 1,
          Content: String(x.Content ?? x.content ?? x.text ?? '').trim(),
        })).filter((x) => x.Content);
      }
    } catch { /* 不是 JSON，走纯文本 */ }
  }
  // 纯文本（BitNet）：整段作为一条转写
  if (!raw) throw new Error('模型未返回转写内容');
  return [{ 'Start time': '', 'End time': '', 'Speaker ID': 1, Content: raw }];
}

const MIME_EXT = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3' };

function doTranscribe(messages) {
  // 代理模式（7B）：串行队列同样生效（vLLM 单卡并发有限，逐条转发），但内部不走 BitNet 子进程
  if (PROXY) return enqueue(() => proxyTranscribe({ model: 'vibevoice', messages }));
  return enqueue(() => new Promise(async (resolve, reject) => {
    try {
      await waitReady();
      const user = (messages || []).find((m) => m.role === 'user');
      const content = Array.isArray(user?.content) ? user.content : [];
      const audioPart = content.find((c) => c.type === 'audio_url' && c.audio_url?.url?.startsWith('data:'));
      const textPart = content.find((c) => c.type === 'text');
      if (!audioPart) throw new Error('请求里没有音频数据');
      const m = audioPart.audio_url.url.match(/^data:([^;]+);base64,(.+)$/s);
      if (!m) throw new Error('音频 data URL 格式不对');
      const mime = m[1].toLowerCase();
      const ext = MIME_EXT[mime] || (/mp3/.test(mime) ? 'mp3' : /wav/.test(mime) ? 'wav' : '');
      if (!ext) throw new Error(`本地 BitNet 引擎只支持 WAV/MP3 音频（收到 ${mime}），请把录音存成 WAV 或 MP3 格式`);
      const buf = Buffer.from(m[2], 'base64');
      if (!buf.length) throw new Error('音频数据为空');
      const file = path.join(TMP_DIR, crypto.randomUUID() + '.' + ext);
      fs.writeFileSync(file, buf);

      // 热词变化时先下发 CONTEXT（引擎 ---ACK--- 确认；无热词时空串同样需要同步）
      const hot = extractHotwords(textPart?.text);
      if (hot !== lastContext) {
        engine.stdin.write('CONTEXT:' + hot.replace(/[\r\n]+/g, ' ') + '\n');
        lastContext = hot;
      }
      collector = {
        chunks: [], resolve: (text) => {
          fs.unlink(file, () => {});
          try { resolve(normalizeUtterances(text)); }
          catch (e) { reject(new Error('引擎输出解析失败：' + e.message)); }
        },
        reject: (e) => { fs.unlink(file, () => {}); reject(e); },
        timer: null,
      };
      engine.stdin.write(file + '\n');
    } catch (e) { reject(e); }
  }));
}

// ---------- HTTP 服务 ----------
// 转写可能远超 Node 18+ 默认 requestTimeout（5 分钟会直接掐断连接 → 工作台侧 fetch failed），
// 弱 CPU 上 7 秒音频都可能跑几分钟；禁用服务器侧超时，超时控制交给工作台的 timeout_min
const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(body);
  };
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/v1/health')) {
    if (PROXY) return proxyHealthy().then((h) => send(h.ok ? 200 : 503, { ...h, engine: LABEL + ' (vLLM)', proxy: PROXY }));
    return send(200, { ok: ready, ready, engine: 'VibeVoice-ASR-BitNet (VibeASR.cpp)', threads: THREADS, error: lastError });
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    return send(200, { data: [{ id: 'vibevoice' }, { id: 'vibevoice-bitnet' }] });
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 600 * 1024 * 1024) req.destroy(); }); // 600MB 上限（base64 后）
    req.on('end', async () => {
      let j = {};
      try { j = JSON.parse(body || '{}'); } catch { return send(400, { error: { message: 'JSON 解析失败' } }); }
      const t0 = Date.now();
      try {
        const utter = await doTranscribe(j.messages);
        const text = JSON.stringify(utter);
        log(`转写完成 ${utter.length} 段 · ${(Date.now() - t0) / 1000 | 0}s`);
        send(200, {
          id: 'vibeasr-' + crypto.randomUUID(), object: 'chat.completion', created: Math.floor(Date.now() / 1000),
          model: j.model || 'vibevoice',
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      } catch (e) {
        log('转写失败:', e.message);
        send(500, { error: { message: e.message } });
      }
    });
    return;
  }
  send(404, { error: { message: 'not found' } });
});

let shuttingDown = false;
function shutdown() {
  shuttingDown = true;
  try { engine?.stdin?.write('EXIT\n'); } catch { /* ignore */ }
  setTimeout(() => { try { engine?.kill(); } catch { /* ignore */ } process.exit(0); }, 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.requestTimeout = 0;   // 整个请求用时上限（默认 5 分钟掐连接）
server.headersTimeout = 0;   // 必须同时关：Node 要求 headersTimeout > requestTimeout
server.listen(PORT, HOST, () => {
  log(`sidecar 监听 http://${HOST}:${PORT}（OpenAI 兼容，工作台服务地址填这个）`);
  if (PROXY) {
    log(`代理模式: ${PROXY}（引擎 ${ENGINE} · ${LABEL}——转发给 vLLM，本地不跑 BitNet）`);
  } else {
    log(`引擎: ${BIN}`);
    log(`VAE: ${VAE}`);
    log(`LM: ${LM} · 线程 ${THREADS}`);
    startEngine();
  }
  if (PULL && PKEY) startPullLoop();
});

// ---------- 拉取模式：每 4 秒向工作台领任务，领到就本地转写再回传（全程出站 HTTPS，穿 NAT） ----------
function startPullLoop() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const post = (p, obj) => fetch(PULL.replace(/\/+$/, '') + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj),
  });
  log(`拉取模式: ${PULL}（主动回连领任务，无需工作台访问本机 IP——外网/NAT 环境可用）`);
  (async () => {
    for (;;) {
      try {
        // 领取动作即心跳（工作台据 last_seen 判在线）；host/cores/engine 顺带刷新登记信息
        const r = await post('/api/vibe/job/next', { key: PKEY, host: os.hostname(), cores: os.cpus().length, engine: ENGINE });
        if (r.status === 204) { await sleep(4000); continue; }        // 无任务
        if (!r.ok) { await sleep(8000); continue; }                   // 暂时性错误（网关/密钥被改）——退避重试
        const j = await r.json();
        const t0 = Date.now();
        try {
          const utter = await doTranscribe(j.body.messages);          // 引擎未就绪会在内部等 waitReady（代理模式直转 vLLM）
          log(`拉取任务 #${j.id} 转写完成 ${utter.length} 段 · ${(Date.now() - t0) / 1000 | 0}s`);
          await post(`/api/vibe/job/${j.id}/result`, { key: PKEY, ok: true, content: JSON.stringify(utter), model: PROXY ? LABEL : j.body.model });
        } catch (e) {
          log(`拉取任务 #${j.id} 失败: ${e.message}`);
          await post(`/api/vibe/job/${j.id}/result`, { key: PKEY, ok: false, error: e.message }).catch(() => {});
        }
        continue;                                                     // 立即再领（可能还有排队任务）
      } catch { await sleep(8000); }                                  // 工作台不可达——稍后重试
    }
  })();
}
