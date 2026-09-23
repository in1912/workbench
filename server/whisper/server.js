// Whisper 本地引擎 sidecar：把 whisper.cpp 的 whisper-cli（每次调用独立进程）
// 包成 OpenAI 兼容 /v1/chat/completions 服务，供工作台「录音转写」零改动调用（与 VibeASR/vLLM 同合约）。
// 零依赖（Node 内置 http/child_process），随升级包分发（server/ 前缀）。
//
// 用法: node server.js --bin <whisper-cli(.exe)> --model <ggml-xxx.bin>
//                 [--port 9655] [--threads 8] [--lang auto]
//
// whisper-cli 是一次性进程（无常驻协议）：每条请求 spawn 一次（模型从页缓存加载约 3~5 秒），
// 输出 -oj JSON（transcription[].timestamps/text）→ 归一成 VibeVoice 的 utterances 键名。
// 时间戳是 whisper 原生能力（BitNet 1.5B 没有的）；说话人字段恒为 1（whisper.cpp 的
// --diarize 只对双声道按声道能量二分，浏览器录音是单声道，不适用）。
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
const MODEL = opt('--model', '');
const PORT = Number(opt('--port', 9655)) || 9655;
const THREADS = Number(opt('--threads', 4)) || 4;
// 语言：auto=whisper 自动检测（安静/低质音频上可能误判，可在设置里固定 zh）
const LANG = opt('--lang', 'auto');

const log = (...a) => console.log(`[whisper-sidecar ${new Date().toLocaleTimeString('sv')}]`, ...a);

if (!BIN || !MODEL) {
  console.error('用法: node server.js --bin <whisper-cli> --model <ggml.bin> [--port 9655] [--threads 4] [--lang auto]');
  process.exit(1);
}
for (const [label, p] of [['引擎', BIN], ['模型', MODEL]]) {
  if (!fs.existsSync(p)) { console.error(`错误: ${label}不存在: ${p}`); process.exit(1); }
}

// ---------- 串行推理队列（whisper-cli 单次全量解码，串行防内存翻倍） ----------
let queueTail = Promise.resolve();
function enqueue(task) {
  const run = queueTail.then(task, task);
  queueTail = run.catch(() => {});
  return run;
}

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'whisper-'));

// 热词从工作台 prompt（"This is a X seconds audio, with extra info: <热词>…"）中提取
function extractHotwords(text) {
  const m = String(text || '').match(/with extra info:\s*(.+)/i);
  return m ? m[1].trim().slice(0, 500) : '';
}

// whisper-cli JSON → utterances（VibeVoice 键名：Start time/End time/Speaker ID/Content）
function parseWhisperJson(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  const segs = Array.isArray(j.transcription) ? j.transcription : [];
  const utter = segs.map((s) => ({
    // whisper 的时间戳是 "00:00:03,340"（逗号毫秒分隔），统一成点号
    'Start time': String(s.timestamps?.from || '').replace(',', '.'),
    'End time': String(s.timestamps?.to || '').replace(',', '.'),
    'Speaker ID': 1,
    Content: String(s.text || '').trim(),
  })).filter((x) => x.Content);
  if (!utter.length) throw new Error('未识别到语音内容（录音可能没有清晰人声，或语言设置不对）');
  return utter;
}

const MIME_EXT = {
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav',
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
  'audio/flac': 'flac', 'audio/ogg': 'ogg',
};

function runWhisper(file, hotwords) {
  return new Promise((resolve, reject) => {
    const base = path.join(TMP_DIR, crypto.randomUUID());
    // -bs 5 束搜索：turbo 解码器只有 4 层，beam5 与贪心几乎同速但更稳（实测 35.8s vs 36.3s）
    const cliArgs = ['-m', MODEL, '-f', file, '-l', LANG, '-oj', '-of', base, '-np', '-t', String(THREADS), '-bs', '5'];
    if (hotwords) cliArgs.push('--prompt', hotwords.replace(/[\r\n]+/g, ' '));
    const p = spawn(BIN, cliArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let err = '';
    let out = '';
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => {
      err += d;
      const t = String(d).trim();
      if (t) log('[engine]', t.split('\n').slice(-1)[0].slice(0, 160));
    });
    p.on('error', (e) => reject(new Error('引擎进程无法启动：' + e.message)));
    p.on('exit', (code, sig) => {
      const jsonFile = base + '.json';
      const audioFile = file;
      const cleanup = () => { for (const f of [jsonFile, audioFile]) fs.unlink(f, () => {}); };
      if (code !== 0) {
        cleanup();
        const hint = /whisper_model_load|load_model/i.test(out + err)
          ? '（模型加载失败：文件可能不完整，请在引擎页重新安装模型）' : '';
        return reject(new Error(`引擎退出码 ${code}${sig ? '/' + sig : ''}${hint}：${(err || out).split('\n').filter(Boolean).slice(-2).join(' | ').slice(0, 200)}`));
      }
      try {
        const utter = parseWhisperJson(jsonFile);
        cleanup();
        resolve(utter);
      } catch (e) {
        cleanup();
        reject(new Error('引擎输出解析失败：' + e.message));
      }
    });
  });
}

function doTranscribe(messages) {
  return enqueue(() => new Promise(async (resolve, reject) => {
    try {
      const user = (messages || []).find((m) => m.role === 'user');
      const content = Array.isArray(user?.content) ? user.content : [];
      const audioPart = content.find((c) => c.type === 'audio_url' && c.audio_url?.url?.startsWith('data:'));
      const textPart = content.find((c) => c.type === 'text');
      if (!audioPart) throw new Error('请求里没有音频数据');
      const m = audioPart.audio_url.url.match(/^data:([^;]+);base64,(.+)$/s);
      if (!m) throw new Error('音频 data URL 格式不对');
      const mime = m[1].toLowerCase();
      const ext = MIME_EXT[mime] || (/mp3/.test(mime) ? 'mp3' : /wav/.test(mime) ? 'wav' : /flac/.test(mime) ? 'flac' : /ogg/.test(mime) ? 'ogg' : '');
      if (!ext) throw new Error(`本地 Whisper 引擎只支持 WAV/MP3/FLAC/OGG 音频（收到 ${mime}），请把录音存成 WAV 或 MP3 格式`);
      const buf = Buffer.from(m[2], 'base64');
      if (!buf.length) throw new Error('音频数据为空');
      const file = path.join(TMP_DIR, crypto.randomUUID() + '.' + ext);
      fs.writeFileSync(file, buf);
      resolve(await runWhisper(file, extractHotwords(textPart?.text)));
    } catch (e) { reject(e); }
  }));
}

// ---------- HTTP 服务（与 vibeasr sidecar 同合约） ----------
const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    res.end(body);
  };
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/v1/health')) {
    return send(200, {
      ok: true, ready: true, engine: 'whisper.cpp (whisper-cli)',
      model: path.basename(MODEL), lang: LANG, threads: THREADS,
    });
  }
  if (req.method === 'GET' && req.url === '/v1/models') {
    return send(200, { data: [{ id: 'whisper-large-v3-turbo' }] });
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
        log(`转写完成 ${utter.length} 段 · ${(Date.now() - t0) / 1000 | 0}s`);
        send(200, {
          id: 'whisper-' + crypto.randomUUID(), object: 'chat.completion', created: Math.floor(Date.now() / 1000),
          model: j.model || 'whisper-large-v3-turbo',
          choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(utter) }, finish_reason: 'stop' }],
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

server.requestTimeout = 0;   // 整个请求用时上限（默认 5 分钟掐连接，弱 CPU 长音频会超）
server.headersTimeout = 0;   // 必须同时关：Node 要求 headersTimeout > requestTimeout
server.listen(PORT, '127.0.0.1', () => {
  log(`sidecar 监听 http://127.0.0.1:${PORT}（OpenAI 兼容）`);
  log(`引擎: ${BIN}`);
  log(`模型: ${MODEL} · 语言 ${LANG} · 线程 ${THREADS}`);
});
