// 录音转写（效率工具 tab）：浏览器录音/上传音频 → VibeVoice-ASR 说话人分离转写。
// 模型侧走 OpenAI 兼容 /v1/chat/completions（vllm_plugin 部署，音频 data URL 内联），
// 服务地址/模型/热词在页面底部「VibeVoice 设置」里配置（settings.vibe_settings，全局共享）。
// 权限：随 tools 页 vibe tab；列表全家共享（与练琴一致），转写/删除仅本人或管理员。
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const multer = require('multer');
const { db, dataDir, getSetting, setSetting } = require('../db');
const storagePaths = require('../services/storagePaths');
const { audioDuration, AUDIO_MIME } = require('../lib/audioMeta');
const paths = require('../services/vibeasrPaths');
const service = require('../services/vibeasrService');
const installer = require('../services/vibeasrInstaller');
// Whisper（whisper.cpp large-v3-turbo）：与 VibeASR 同构的第二套服务器引擎，首选
const whisperPaths = require('../services/whisperPaths');
const whisperService = require('../services/whisperService');
const whisperInstaller = require('../services/whisperInstaller');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 500 * 1024 * 1024 } });

const userLabel = (u) => (u && (u.display_name || u.nickname || u.username)) || `用户#${u && u.id}`;
const nowStr = () => new Date().toLocaleString('sv').slice(0, 19);

// ---------- 设置 ----------
// engine_mode：server=服务器内解析（本机引擎）| client=客户端电脑算力（D:\LLM 一键包）| custom=自定义 vLLM 服务
// server_engine：server 模式下用哪套引擎——whisper（large-v3-turbo，首选/默认）| vibeasr（BitNet 1.5B）
// client_engine：client 模式下任务发给哪套客户端引擎——vibeasr（1.5B BitNet 纯 CPU，任意 Windows 电脑）
//               | vibe7b（VibeVoice-ASR 7B 完整版，需 NVIDIA 显卡的电脑，WSL2+vLLM 运行，说话人分离+时间戳）
// whisper_lang：Whisper 识别语言。auto 在安静/低质手机录音上可能误判语言（幻觉），固定 zh 更稳
const WHISPER_LANGS = ['auto', 'zh', 'en', 'yue', 'ja', 'ko', 'de', 'fr', 'es', 'ru', 'it', 'pt', 'vi', 'th', 'ar'];
function getVibeSettings() {
  const s = getSetting('vibe_settings', {}) || {};
  const mode = ['server', 'client', 'custom'].includes(s.engine_mode) ? s.engine_mode
    : (s.base_url ? 'custom' : 'server');
  return {
    engine_mode: mode,
    server_engine: s.server_engine === 'vibeasr' ? 'vibeasr' : 'whisper',
    client_engine: s.client_engine === 'vibe7b' ? 'vibe7b' : 'vibeasr',
    whisper_lang: WHISPER_LANGS.includes(s.whisper_lang) ? s.whisper_lang : 'auto',
    base_url: String(s.base_url || '').replace(/\/+$/, ''),
    model: String(s.model || 'vibevoice'),
    hotwords: String(s.hotwords || '').slice(0, 500),
    timeout_min: Math.max(1, Math.min(120, Number(s.timeout_min) || 30)),
    client_url: String(s.client_url || '').replace(/\/+$/, '').slice(0, 300),
  };
}
router.get('/vibe/settings', (req, res) => res.json(getVibeSettings()));
router.put('/vibe/settings', (req, res) => {
  const cur = getVibeSettings();
  const b = req.body || {};
  const next = {
    engine_mode: ['server', 'client', 'custom'].includes(b.engine_mode) ? b.engine_mode : cur.engine_mode,
    server_engine: b.server_engine === 'vibeasr' ? 'vibeasr' : (b.server_engine === 'whisper' ? 'whisper' : cur.server_engine),
    client_engine: b.client_engine === 'vibe7b' ? 'vibe7b' : (b.client_engine === 'vibeasr' ? 'vibeasr' : cur.client_engine),
    whisper_lang: WHISPER_LANGS.includes(b.whisper_lang) ? b.whisper_lang : cur.whisper_lang,
    base_url: String(b.base_url ?? cur.base_url).trim().slice(0, 300),
    model: String(b.model ?? cur.model).trim().slice(0, 100) || 'vibevoice',
    hotwords: String(b.hotwords ?? cur.hotwords).slice(0, 500),
    timeout_min: Math.max(1, Math.min(120, Number(b.timeout_min) || cur.timeout_min)),
    client_url: String(b.client_url ?? cur.client_url).trim().replace(/\/+$/, '').slice(0, 300),
  };
  setSetting('vibe_settings', next);
  // Whisper 语言改了 → 重启 sidecar 让 --lang 生效（whisper-cli 按请求 spawn，语言参数在 sidecar 上）
  if (next.whisper_lang !== cur.whisper_lang && whisperService.status().running) {
    whisperService.stop();
    setTimeout(() => { try { whisperService.start(next.whisper_lang); } catch { /* 自愈兜底 */ } }, 3000).unref?.();
  }
  res.json(getVibeSettings());
});

// ---------- 引擎（服务器内解析：一键安装 / 状态 / 启停 / 删除模型） ----------
// engine 参数选引擎：'whisper'（首选）| 'vibeasr'；缺省按 vibeasr 处理（旧缓存前端的按钮不带参数）
function engineKit(req) {
  const e = String((req.body && req.body.engine) || req.query.engine || 'vibeasr');
  return e === 'whisper'
    ? { name: 'whisper', paths: whisperPaths, service: whisperService, installer: whisperInstaller }
    : { name: 'vibeasr', paths, service, installer };
}
router.get('/vibe/engine/status', async (req, res) => {
  const cfg = getVibeSettings();
  const pack = async (p, s, i) => {
    const st = s.status();
    if (st.running) await s.health(2500); // 顺带刷新 ready 位
    return { installed: p.engineReady(), service: s.status(), install: i.status(), port: p.PORT };
  };
  const engines = {
    whisper: await pack(whisperPaths, whisperService, whisperInstaller),
    vibeasr: await pack(paths, service, installer),
  };
  res.json({ ...engines[cfg.server_engine], engines, server_engine: cfg.server_engine });
});
router.post('/vibe/engine/install', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可安装引擎' });
  const kit = engineKit(req);
  const opts = { by: userLabel(req.user) || req.user.username };
  if (kit.name === 'whisper') opts.lang = getVibeSettings().whisper_lang; // 安装完按设置的语言启动
  res.json(kit.installer.start(opts));
});
// 清除安装失败状态（页面「取消安装」按钮）：收起挂在页面上的失败进度条与日志
router.post('/vibe/engine/install-reset', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  const r = engineKit(req).installer.reset();
  if (!r.ok) return res.status(400).json({ error: r.error });
  res.json({ ok: true });
});
router.post('/vibe/engine/start', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  const kit = engineKit(req);
  res.json(kit.name === 'whisper' ? kit.service.start(getVibeSettings().whisper_lang) : kit.service.start());
});
router.post('/vibe/engine/stop', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员' });
  res.json(engineKit(req).service.stop());
});
// 删除模型文件（whisper 约 0.9GB / vibeasr 约 1.7GB）：服务器 CPU 带不动引擎（转写奇慢）时的卸载出口。
// 只删 models/（二进制保留、随时可重新一键安装只补模型）；先停引擎释放文件占用。
router.post('/vibe/engine/remove-models', async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可删除模型' });
  const kit = engineKit(req);
  kit.service.stop(); // sidecar 退出（vibeasr 连带引擎进程；whisper 等在跑的单次调用自然结束，模型句柄随进程释放）
  await new Promise((r) => setTimeout(r, 2500));
  const targets = [];
  if (fs.existsSync(kit.paths.MODELS_DIR)) {
    for (const f of fs.readdirSync(kit.paths.MODELS_DIR)) targets.push(path.join(kit.paths.MODELS_DIR, f)); // 含下载中的残留
  }
  let freed = 0;
  const errs = [];
  for (const p of targets) {
    try { freed += fs.statSync(p).size; fs.unlinkSync(p); } catch (e) { errs.push(`${path.basename(p)}: ${e.message}`); }
  }
  if (errs.length) return res.status(500).json({ error: '部分文件删除失败（引擎进程可能还没退干净，几秒后重试）：' + errs.join('；'), freed });
  console.log(`[vibe] ${userLabel(req.user) || req.user.username} 删除 ${kit.name} 模型 ${kit.paths.MODELS_DIR}（释放 ${(freed / 1024 ** 3).toFixed(2)}GB）`);
  res.json({ ok: true, freed });
});

// 客户端机器登记密钥（生成安装包时内嵌，登记时校验）
function getClientKey() {
  let k = getSetting('vibe_client_key', '');
  if (!k) { k = crypto.randomBytes(16).toString('hex'); setSetting('vibe_client_key', k); }
  return k;
}
// 客户端登记（v1.6.0 起按引擎分卡）：vibeasr=1.5B BitNet 纯CPU | vibe7b=7B vLLM(WSL2)。
// 两套引擎可装在不同电脑上同时在线（比如一台老电脑跑 1.5B、一台 3060 电脑跑 7B），任务按 client_engine 分发。
// 旧 settings 键 vibe_client_info（单引擎时代）不再读——1.5B 客户端重新注册即恢复，无需迁移。
function getClients() {
  const m = getSetting('vibe_clients', null) || {};
  const out = {};
  for (const e of ['vibeasr', 'vibe7b']) {
    const v = m[e] || {};
    out[e] = {
      url: String(v.url || '').slice(0, 300),
      host: String(v.host || '').slice(0, 60),
      cores: Number(v.cores) || 0,
      gpu: String(v.gpu || '').slice(0, 80),
      last_seen: Number(v.last_seen) || 0,
    };
  }
  return out;
}
const clientOnline = (c) => Date.now() - (Number(c && c.last_seen) || 0) < 15 * 60 * 1000;
const ENGINE_LABEL = { vibeasr: 'VibeASR 1.5B', vibe7b: 'VibeVoice-ASR 7B' };
const ENGINE_TIP = {
  vibeasr: '客户端引擎离线：请在装了「客户端一键部署包（1.5B）」的电脑上运行 setup（或等它开机自启），装完自动回连',
  vibe7b: '7B 客户端离线：请在装了「7B 部署包（带 NVIDIA 显卡的电脑）」上运行 setup（或等它开机自启）',
};

// 转写后端解析：按 engine_mode 决定 base_url（server 模式按 server_engine 选引擎并确保就绪）
async function resolveBackend(cfg) {
  if (cfg.engine_mode === 'server') {
    if (cfg.server_engine === 'whisper') {
      if (!whisperPaths.engineReady()) throw new Error('Whisper 服务器引擎未安装：请在下方引擎卡点「一键安装」（约 0.9GB 模型，装一次即可）');
      await whisperService.ensureReady(cfg.whisper_lang);
      return { base_url: `http://127.0.0.1:${whisperPaths.PORT}`, model: 'whisper-large-v3-turbo' };
    }
    if (!paths.engineReady()) throw new Error('VibeASR 服务器引擎未安装：请在下方引擎卡点「一键安装」（约 1.7GB 模型，装一次即可）');
    await service.ensureReady();
    return { base_url: `http://127.0.0.1:${paths.PORT}`, model: 'vibevoice' };
  }
  if (cfg.engine_mode === 'client') {
    // 拉取模式：客户端引擎多半在外网/NAT 后（它回填的内网 IP 服务器永远连不到），
    // 任务由 runTranscribe 入队、客户端主动回连领取——这里只校验所选引擎在线（15 分钟内有心跳/领取）
    const e = cfg.client_engine === 'vibe7b' ? 'vibe7b' : 'vibeasr';
    if (!clientOnline(getClients()[e])) throw new Error(ENGINE_TIP[e]);
    return { base_url: getClients()[e].url, model: 'vibevoice' };
  }
  if (!cfg.base_url) throw new Error('未配置转写服务地址（算力来源卡→自定义服务）');
  return { base_url: cfg.base_url, model: cfg.model || 'vibevoice' };
}

// 连通性测试：按当前模式测对应目标
router.get('/vibe/health', async (req, res) => {
  const cfg = getVibeSettings();
  try {
    if (cfg.engine_mode === 'client') {
      // 拉取模式：不反连客户端 IP（外网/NAT 后永远连不到），改测「所选引擎最近是否回连过」
      const engines = getClients();
      const e = cfg.client_engine === 'vibe7b' ? 'vibe7b' : 'vibeasr';
      if (!clientOnline(engines[e])) {
        return res.status(502).json({ error: ENGINE_TIP[e] + '（15 分钟内无心跳）' });
      }
      return res.json({ ok: true, mode: 'client', models: ['vibevoice'], pull: true, engine: e, engine_label: ENGINE_LABEL[e] });
    }
    const { base_url } = await resolveBackend(cfg);
    const r = await fetch(base_url + '/v1/models', { signal: AbortSignal.timeout(cfg.engine_mode === 'server' ? 15000 : 6000) });
    if (!r.ok) return res.status(502).json({ error: `服务可达但返回 ${r.status}（确认服务已启动）` });
    const d = await r.json().catch(() => ({}));
    const models = (d.data || []).map((m) => m.id).slice(0, 10);
    res.json({ ok: true, mode: cfg.engine_mode, models });
  } catch (e) {
    res.status(502).json({ error: '连不上：' + e.message });
  }
});

// ---------- 录音文件落盘（优先全局默认上传路径 {root}/vibe-recordings） ----------
function saveAudio(file) {
  const safe = String(file.originalname || 'recording.wav').replace(/[\\/:*?"<>|\r\n\t]+/g, '_').slice(-80) || 'recording.wav';
  const name = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}_${safe}`;
  let dir = storagePaths.uploadSubDir('vibe-recordings');
  if (!dir) { dir = path.join(dataDir, 'vibe-recordings'); fs.mkdirSync(dir, { recursive: true }); }
  const full = path.join(dir, name);
  fs.writeFileSync(full, file.buffer);
  return full;
}

// ---------- 上传（系统内录音 & 手动上传共用；multipart audio 字段） ----------
router.post('/vibe/upload', upload.any(), (req, res) => {
  const file = (req.files || []).find((f) => f.buffer && f.buffer.length);
  if (!file) return res.status(400).json({ error: '缺少音频文件' });
  const ext = (path.extname(file.originalname || '') || '.wav').toLowerCase().replace('.', '');
  let duration = audioDuration(file.buffer, ext); // 服务端读文件判定时长（需求：上传的按文件算）
  const hint = Number(req.body.duration_hint) || 0;
  if (!duration && hint > 0) duration = hint;    // 非 WAV/MP3 时回落客户端解码时长
  if (!duration) duration = Math.max(0, Number(req.body.duration_sec) || 0); // 录音兜底：起止时间差
  const source = req.body.source === 'upload' ? 'upload' : 'record';
  // Blob 无显式类型时 multer 收到 application/octet-stream，按扩展名兜底（<audio> 播放需要正确 mime）
  const mime = file.mimetype && file.mimetype !== 'application/octet-stream' ? file.mimetype : (AUDIO_MIME[ext] || file.mimetype || 'application/octet-stream');
  let full = '';
  try { full = saveAudio(file); } catch (e) { return res.status(500).json({ error: '保存失败：' + e.message }); }
  const u = db.prepare('SELECT display_name, nickname, username FROM users WHERE id=?').get(req.user.id);
  const info = db.prepare(`INSERT INTO vibe_records(user_id,user_name,source,fmt,started_at,ended_at,duration_sec,file_path,file_mime,file_size)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.id, userLabel(u), source, ['wav', 'mp3'].includes(ext) ? ext : (ext || 'wav'),
      String(req.body.started_at || '').slice(0, 19) || nowStr(),
      String(req.body.ended_at || '').slice(0, 19) || nowStr(),
      duration, full, mime, file.buffer.length);
  res.json({ ok: true, id: Number(info.lastInsertRowid), duration_sec: Math.round(duration * 10) / 10 });
});

// ---------- 列表（全家共享；按保存时间倒序） ----------
// 拉取模式兜底：客户端离线时没人调 /vibe/job/next，超时的 running 记录就没人置失败——列表查询顺带清扫
function sweepStaleJobs() {
  const leaseMs = Math.max(1, getVibeSettings().timeout_min) * 60 * 1000;
  const running = db.prepare("SELECT id FROM vibe_records WHERE status='running'").all();
  if (!running.length) return;
  const expireBefore = Date.now() - leaseMs;
  for (const r of running) {
    const j = db.prepare('SELECT id, status, created_at FROM vibe_jobs WHERE record_id=? ORDER BY id DESC LIMIT 1').get(r.id);
    if (j && (j.status === 'queued' || j.status === 'claimed') && Number(j.created_at) < expireBefore) {
      db.prepare("UPDATE vibe_records SET status='failed', error=? WHERE id=? AND status='running'")
        .run(`转写超时（${Math.round(leaseMs / 60000)} 分钟）：客户端引擎未在时限内完成（离线或过慢）`, r.id);
      db.prepare("UPDATE vibe_jobs SET status='failed', error='timeout', req_body='' WHERE id=?").run(j.id);
    }
  }
}

router.get('/vibe/records', (req, res) => {
  try { sweepStaleJobs(); } catch { /* 清扫失败不挡列表 */ }
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.max(5, Math.min(100, parseInt(req.query.pageSize, 10) || 5));
  const total = db.prepare('SELECT COUNT(*) c FROM vibe_records').get().c;
  const rows = db.prepare(`SELECT id,user_name,source,fmt,started_at,ended_at,duration_sec,file_mime,file_size,file_path,fmt AS file_fmt,
    status,run_ms,CASE WHEN status='done' AND transcript_md<>'' THEN 1 ELSE 0 END has_text,transcript_chars,model,elapsed_ms,transcribed_at,error,created_at
    FROM vibe_records ORDER BY id DESC LIMIT ? OFFSET ?`).all(pageSize, (page - 1) * pageSize);
  // 转写速度估算（最近 10 次成功转写 elapsed/duration 中位数 RTF），供前端转写进度条估时
  let rtf_est = 0;
  try {
    const hist = db.prepare(`SELECT elapsed_ms,duration_sec FROM vibe_records
      WHERE status='done' AND elapsed_ms>0 AND duration_sec>=5 ORDER BY id DESC LIMIT 10`).all();
    if (hist.length) {
      const rs = hist.map((h) => h.elapsed_ms / 1000 / h.duration_sec).sort((a, b) => a - b);
      const mid = rs[Math.floor(rs.length / 2)];
      if (mid >= 0.05 && mid <= 600) rtf_est = Math.round(mid * 100) / 100;
    }
  } catch { /* 估算失败不挡列表 */ }
  res.json({ total, page, pageSize, rows, rtf_est });
});

const getRow = (id) => db.prepare('SELECT * FROM vibe_records WHERE id=?').get(Number(id) || 0);
const canTouch = (req, row) => req.user.role === 'admin' || row.user_id === req.user.id;

// ---------- 转写（异步执行，前端轮询列表状态） ----------
const VIBE_SYSTEM = 'You are a helpful assistant that transcribes audio input into text output in JSON format.';

function buildMarkdown(utter, meta) {
  const speakers = [...new Set(utter.map((x) => String(x['Speaker ID'] ?? x.speaker ?? 1)))];
  const lines = [
    `# 录音转写结果`,
    ``,
    `- 时长 **${fmtDur(meta.duration)}** · 识别说话人 **${speakers.length}** 人 · 模型 \`${meta.model}\` · ${meta.time}`,
    ``,
    `---`,
    ``,
  ];
  for (const it of utter) {
    const s = String(it['Start time'] ?? it.start ?? '');
    const e = String(it['End time'] ?? it.end ?? '');
    const sp = String(it['Speaker ID'] ?? it.speaker ?? 1);
    const text = String(it.Content ?? it.text ?? '').trim();
    if (!text) continue;
    lines.push(`**[说话人 ${sp}]** \`${s} → ${e}\``, ``, text, ``);
  }
  return lines.join('\n');
}
function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// 模型返回的 content → utterances 数组（容错：剥 ```json 围栏、截取最外层 []）
function parseUtterances(content) {
  let t = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const i = t.indexOf('['), j = t.lastIndexOf(']');
  if (i >= 0 && j > i) t = t.slice(i, j + 1);
  const arr = JSON.parse(t);
  if (!Array.isArray(arr) || !arr.length) throw new Error('模型未返回转写内容');
  return arr;
}

// 长转写 POST（node:http 直连）：undici fetch 有内置 headersTimeout=5 分钟——本地引擎转写
// 完才发响应头，弱 CPU 上轻松超 5 分钟，fetch 会以 "fetch failed" 掐断。http.request 无此内建超时。
function postJsonLong(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('转写服务响应解析失败：' + e.message)); }
        } else reject(new Error(`服务返回 ${res.statusCode}：${buf.slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`转写服务超时（${Math.round(timeoutMs / 60000)} 分钟）`)));
    req.end(body);
  });
}

// 转写结果落库（直连/拉取两条路共用）：content=模型返回的 utterances 文本；重复结果静默忽略
function finishTranscribe(rowId, content, model) {
  const row = getRow(rowId);
  if (!row || row.status !== 'running') return; // 已被超时置失败或另一路已写完——不覆盖
  const utter = parseUtterances(content);
  const chars = utter.reduce((s, x) => s + String(x.Content ?? x.text ?? '').replace(/\s/g, '').length, 0);
  const md = buildMarkdown(utter, { duration: row.duration_sec || 0, model, time: nowStr() });
  // 转写耗时：从进入 running（点转写）到完成，含排队/引擎加载/推理（拉取模式含客户端回连等待）
  const elapsed = Number(row.run_ms) > 0 ? Date.now() - Number(row.run_ms) : 0;
  db.prepare(`UPDATE vibe_records SET status='done', transcript_md=?, transcript_json=?, transcript_chars=?, transcribed_at=?, model=?, elapsed_ms=?, error='' WHERE id=?`)
    .run(md, JSON.stringify(utter), chars, nowStr(), model, elapsed, rowId);
}

async function runTranscribe(rowId) {
  const row = getRow(rowId);
  if (!row || row.status === 'running') return;
  const cfg = getVibeSettings();
  db.prepare("UPDATE vibe_records SET status='running', error='', run_ms=? WHERE id=?").run(Date.now(), rowId);
  try {
    const backend = await resolveBackend(cfg); // server 模式会等引擎加载完（最长 2 分钟）；client 模式校验客户端在线
    const buf = fs.readFileSync(row.file_path);
    const mime = row.file_mime && row.file_mime !== 'application/octet-stream' ? row.file_mime : (AUDIO_MIME[row.fmt] || 'audio/wav');
    const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
    const dur = row.duration_sec || 0;
    const hot = cfg.hotwords.trim();
    const prompt = hot
      ? `This is a ${dur.toFixed(2)} seconds audio, with extra info: ${hot}\n\nPlease transcribe it with these keys: Start time, End time, Speaker ID, Content`
      : `This is a ${dur.toFixed(2)} seconds audio, please transcribe it with these keys: Start time, End time, Speaker ID, Content`;
    const body = JSON.stringify({
      model: backend.model,
      messages: [
        { role: 'system', content: VIBE_SYSTEM },
        { role: 'user', content: [{ type: 'audio_url', audio_url: { url: dataUrl } }, { type: 'text', text: prompt }] },
      ],
      max_tokens: 32768, temperature: 0, top_p: 1, stream: false,
    });
    if (cfg.engine_mode === 'client') {
      // 拉取模式：任务进队列，客户端引擎主动回连领取（它可能在外网/NAT 后，服务器直连它的 IP 永远不通）；
      // 结果经 /vibe/job/:id/result 回传 → finishTranscribe 落库，记录状态由前端轮询感知。
      // 任务带 engine 标记：1.5B 与 7B 客户端各领各的（两台电脑可同时在线，算力来源卡里选谁就发给谁）
      const engine = cfg.client_engine === 'vibe7b' ? 'vibe7b' : 'vibeasr';
      db.prepare("INSERT INTO vibe_jobs(record_id, req_body, status, engine, created_at) VALUES(?,?,'queued',?,?)").run(rowId, body, engine, Date.now());
      return;
    }
    const d = await postJsonLong(backend.base_url + '/v1/chat/completions', body, cfg.timeout_min * 60 * 1000);
    // postJsonLong 已在非 2xx 时 reject 并解析好 JSON——这里 d 就是解析结果，别再按 Response 用
    finishTranscribe(rowId, d.choices?.[0]?.message?.content ?? '', backend.model + (cfg.engine_mode === 'server' ? '（服务器引擎）' : ''));
  } catch (e) {
    db.prepare("UPDATE vibe_records SET status='failed', error=? WHERE id=? AND status='running'").run(String(e.message).slice(0, 500), rowId);
  }
}

router.post('/vibe/transcribe/:id', async (req, res) => {
  const row = getRow(req.params.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  if (!canTouch(req, row)) return res.status(403).json({ error: '只有本人或管理员可转写' });
  if (row.status === 'running') return res.json({ ok: true, status: 'running' });
  if (!fs.existsSync(row.file_path || '')) return res.status(400).json({ error: '音频文件已不存在' });
  runTranscribe(row.id); // 后台执行，不阻塞响应
  res.json({ ok: true, status: 'running' });
});

// ---------- 详情（转写文本） ----------
router.get('/vibe/transcript/:id', (req, res) => {
  const row = getRow(req.params.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  res.json({
    id: row.id, status: row.status, run_ms: row.run_ms || 0, transcript_md: row.transcript_md || '',
    transcript_chars: row.transcript_chars, model: row.model, error: row.error,
    transcribed_at: row.transcribed_at, duration_sec: row.duration_sec,
  });
});

// ---------- 导出 ----------
const safeName = (row, ext) => `转写-${String(row.started_at || row.created_at || '').replace(/[-: ]/g, '')}-${row.id}.${ext}`;

// 导出音频原文件（?inline=1 时以播放形态返回：inlineDisposition，供 <audio> 标签直接播放）
// 必须支持 Range/206 + Content-Length（同练琴 /piano/file/:id）：手机 Safari/微信/钉钉 webview 播放
// <audio> 前会发 Range: bytes=0-1 探测，纯 chunked 200（无长度无区间）会被判为无法播放——
// 手机端「播放显示错误不出声」的根因；桌面 Chrome 对 chunked 宽容所以电脑上一直正常。
router.get('/vibe/audio/:id', (req, res) => {
  const row = getRow(req.params.id);
  if (!row || !fs.existsSync(row.file_path || '')) return res.status(404).json({ error: '文件不存在' });
  let st; try { st = fs.statSync(row.file_path); } catch { return res.status(404).json({ error: '录音文件不可读' }); }
  // 旧数据可能存了 octet-stream，按实际扩展名兜底（inline 播放需要正确 mime）
  const mime = row.file_mime && row.file_mime !== 'application/octet-stream' ? row.file_mime : (AUDIO_MIME[row.fmt] || row.file_mime || 'application/octet-stream');
  res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');
  const disp = req.query.inline === '1' ? 'inline' : 'attachment';
  res.setHeader('Content-Disposition', `${disp}; filename*=UTF-8''${encodeURIComponent(path.basename(row.file_path))}`);
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range));
    let start = 0, end = st.size - 1;
    if (m && m[1]) {
      start = parseInt(m[1], 10);
      if (m[2]) end = Math.min(parseInt(m[2], 10), st.size - 1);
    } else if (m && m[2]) {
      start = Math.max(0, st.size - parseInt(m[2], 10)); // 后缀区间 bytes=-N = 末尾 N 字节（end 保持 size-1）
    }
    if (!m || start >= st.size || start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${st.size}`);
      return res.end();
    }
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(row.file_path, { start, end }).pipe(res);
  } else {
    res.setHeader('Content-Length', st.size);
    fs.createReadStream(row.file_path).pipe(res);
  }
});

// 导出文本（从 utterances 重建干净文本；无 JSON 时用 markdown 原文）
function toPlainText(row) {
  try {
    const utter = JSON.parse(row.transcript_json || '[]');
    if (Array.isArray(utter) && utter.length) {
      return utter.map((x) => `[${x['Start time'] ?? ''}→${x['End time'] ?? ''}] 说话人${x['Speaker ID'] ?? 1}：${String(x.Content ?? '').trim()}`).join('\n');
    }
  } catch { /* 走 markdown 兜底 */ }
  return String(row.transcript_md || '').replace(/^#{1,6}\s*/gm, '').replace(/\*\*|`/g, '');
}

router.get('/vibe/export/:id', (req, res) => {
  const row = getRow(req.params.id);
  if (!row || row.status !== 'done' || !row.transcript_md) return res.status(400).json({ error: '该记录还没有转写文本' });
  const fmt = req.query.format === 'word' ? 'word' : 'txt';
  const text = toPlainText(row);
  if (fmt === 'txt') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName(row, 'txt'))}`);
    return res.send(text);
  }
  // Word：HTML 包裹 .doc（Word/WPS 直接打开，含基本排版）
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = esc(text).replace(/\n/g, '<br>');
  const html = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"><title>录音转写</title></head>
<body style="font-family:'Microsoft YaHei';font-size:12pt;line-height:1.8">
<h2>录音转写 · ${esc(String(row.started_at || ''))}（时长 ${fmtDur(row.duration_sec)}）</h2><hr>${body}
</body></html>`;
  res.setHeader('Content-Type', 'application/msword; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName(row, 'doc'))}`);
  res.send(html);
});

// ---------- 删除（连带音频文件） ----------
router.delete('/vibe/records/:id', (req, res) => {
  const row = getRow(req.params.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  if (!canTouch(req, row)) return res.status(403).json({ error: '只有本人或管理员可删除' });
  try { if (row.file_path && fs.existsSync(row.file_path)) fs.unlinkSync(row.file_path); } catch { /* 尽力删 */ }
  db.prepare('DELETE FROM vibe_records WHERE id=?').run(row.id);
  res.json({ ok: true });
});

// ---------- 客户端电脑算力：一键部署包（同「电脑监控」代理模式：按下载来源内嵌地址） ----------
function baseUrl(req) {
  const clean = (u) => String(u || '').replace(/\/+$/, '');
  const org = clean(req.get('origin'));
  if (/^https?:\/\//i.test(org)) return org;
  const ref = clean(String(req.get('referer') || '').replace(/^(https?:\/\/[^/?#]+).*$/i, '$1'));
  if (/^https?:\/\//i.test(ref)) return ref;
  const xfp = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  return `${xfp || req.protocol}://${req.get('host')}`;
}

// 可下发文件清单：客户端部署包固定发 Windows 引擎——优先项目随包分发的 vibeasr/win-x64
// （Linux 生产容器自身引擎是源码编译的 linux 产物，不能也不该发给 Windows 客户端），
// 没有再退回本机安装目录（Windows 服务器自装后两者内容相同）。外加 sidecar 脚本。
function clientFileList() {
  const dir = fs.existsSync(paths.SHIPPED_WIN_EXE) ? paths.SHIPPED_WIN_DIR : paths.BIN_DIR;
  const files = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) if (/\.(exe|dll)$/i.test(f)) files.push({ name: f, size: fs.statSync(path.join(dir, f)).size, tag: 'engine' });
  }
  if (fs.existsSync(paths.SIDECAR)) files.push({ name: 'server.js', size: fs.statSync(paths.SIDECAR).size, tag: 'sidecar' });
  return { files, dir };
}

// 登记密钥校验
const keyOk = (req) => String(req.query.k || req.body?.key || '') === getClientKey() && getClientKey();

// 客户端安装包（仅 admin 下载；脚本内嵌下载来源地址与登记密钥）
const NODE_VER = '22.14.0';
const PS_TEMPLATE = [
  '# 个人工作台·录音转写 客户端引擎部署脚本（由「效率工具→录音转写」页生成）',
  '# 在本机运行 = 安装转写引擎到 D:\\LLM\\vibeasr（D 盘不可用时 C:\\LLM\\vibeasr），装完自动回连工作台。',
  '# 卸载：powershell -ExecutionPolicy Bypass -File 本文件 -Remove',
  'param([switch]$Remove)',
  "$Server = '__SERVER__'",
  "$Key    = '__KEY__'",
  "$RunName = 'WorkbenchVibeASR'",
  "if (-not (Test-Path 'D:\\')) { $Base = 'C:\\LLM' } else { $Base = 'D:\\LLM' }",
  "$Dir = Join-Path $Base 'vibeasr'",
  "$LogFile = Join-Path $Dir 'agent.log'",
  "function Log([string]$m) { try { Add-Content -Path $LogFile -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m) -ErrorAction SilentlyContinue } catch {} }",
  '',
  'if ($Remove) {',
  "  Log 'uninstall'",
  "  Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name $RunName -ErrorAction SilentlyContinue",
  "  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ('*' + $Dir + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  "  Remove-Item $Dir -Recurse -Force -ErrorAction SilentlyContinue",
  "  Write-Host '已卸载客户端转写引擎'",
  '  exit',
  '}',
  '',
  '# --- 安装分支：不从安装目录运行时，先落位再转常驻 ---',
  'if ($PSCommandPath -and (-not $PSCommandPath.StartsWith($Dir))) {',
  '  New-Item -ItemType Directory -Force -Path $Dir | Out-Null',
  "  Log ('installing from ' + $PSCommandPath)",
  "  Copy-Item $PSCommandPath (Join-Path $Dir 'setup.ps1') -Force",
  "  $cmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"' + (Join-Path $Dir 'setup.ps1') + '\"'",
  "  New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name $RunName -Value $cmd -PropertyType String -Force | Out-Null",
  "  Write-Host ('安装到 ' + $Dir + ' 完成，开始下载引擎与模型（约 1.8GB，窗口会自动隐藏，进度见 agent.log / service.log）')",
  "  Start-Process -FilePath 'powershell.exe' -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"' + (Join-Path $Dir 'setup.ps1') + '\"')",
  '  exit',
  '}',
  '',
  '# --- 常驻分支：下载组件 → 启动引擎 → 注册回工作台 → 看护 ---',
  '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
  '# 工作台可能是内网自签名 HTTPS（按下载来源内嵌）：编译型 C# 回调放行证书（脚本块形式会在 TLS 线程炸）',
  "if (-not ('VibeTlsTrust' -as [type])) {",
  "  Add-Type -TypeDefinition 'using System.Net; using System.Security.Cryptography.X509Certificates; public class VibeTlsTrust : ICertificatePolicy { public bool CheckValidationResult(ServicePoint sp, X509Certificate cert, WebRequest req, int problem) { return true; } }'",
  '}',
  '[System.Net.ServicePointManager]::CertificatePolicy = New-Object VibeTlsTrust',
  '# 本机代理会掐断内网请求，强制直连',
  '[System.Net.WebRequest]::DefaultWebProxy = $null',
  '# 单实例互斥',
  "$mtx = New-Object System.Threading.Mutex($false, 'Global\\WorkbenchVibeASR')",
  'if (-not $mtx.WaitOne(0)) { exit }',
  '',
  '# 函数名绝不能叫 Curl：PS 5.1 里 curl 是 Invoke-WebRequest 的内建别名，别名优先级高于函数，会被遮蔽',
  '# DlUrl=小文件全新下载（-f：HTTP 错误绝不静默写成文件——曾把 404 JSON 当 DLL 写盘，引擎 0xC0000135 崩溃循环）',
  '# DlUrlResume=模型大文件断点续传（不带 -f：已完整文件续传得 416，curl exit 0 无操作通过，实测验证）',
  'function DlUrl([string]$url, [string]$out) {',
  "  & curl.exe -sS -L -f --retry 5 --retry-delay 3 --retry-all-errors -o $out $url",
  "  if ($LASTEXITCODE -ne 0) { throw ('download failed: ' + $url + ' exit=' + $LASTEXITCODE) }",
  '}',
  'function DlUrlResume([string]$url, [string]$out) {',
  "  & curl.exe -sS -L --retry 5 --retry-delay 3 --retry-all-errors -C - -o $out $url",
  "  if ($LASTEXITCODE -ne 0) { throw ('download failed: ' + $url + ' exit=' + $LASTEXITCODE) }",
  '}',
  '',
  'try {',
  "  # 1) Node 运行时（npmmirror 国内镜像）",
  "  if (-not (Test-Path (Join-Path $Dir 'node.exe'))) {",
  "    Log 'downloading node.exe'",
  "    $nz = Join-Path $Dir 'node.zip'",
  "    DlUrl 'https://registry.npmmirror.com/-/binary/node/v__NODEVER__/node-v__NODEVER__-win-x64.zip' $nz",
  "    Expand-Archive -Path $nz -DestinationPath (Join-Path $Dir 'node-pkg') -Force",
  "    Move-Item (Join-Path (Join-Path $Dir 'node-pkg') ('node-v__NODEVER__-win-x64/node.exe')) (Join-Path $Dir 'node.exe') -Force",
  "    Remove-Item $nz, (Join-Path $Dir 'node-pkg') -Recurse -Force -ErrorAction SilentlyContinue",
  '  }',
  "  # 2) 引擎二进制 + sidecar（从工作台下载，带登记密钥）",
  "  $list = Invoke-RestMethod -Uri ($Server + '/api/vibe/client-download?list=1&k=' + $Key)",
  "  $eng = Join-Path $Dir 'engine'",
  '  New-Item -ItemType Directory -Force -Path $eng, (Join-Path $Dir \'models\') | Out-Null',
  '  foreach ($f in $list.files) {',
  "    $dest = if ($f.name -eq 'server.js') { Join-Path $Dir 'server.js' } else { Join-Path $eng $f.name }",
  "    if ((Test-Path $dest) -and ((Get-Item $dest).Length -eq $f.size)) { continue }",
  "    Log ('downloading ' + $f.name)",
  "    # 文件名必须 URL 编码：libstdc++-6.dll 里的 + 不编码会被服务端解成空格（曾 404 → 坏 DLL → 引擎崩溃循环）",
  "    DlUrl ($Server + '/api/vibe/client-download?f=' + [uri]::EscapeDataString($f.name) + '&k=' + $Key) $dest",
  "    if ((Get-Item $dest).Length -ne [long]$f.size) { throw ('size mismatch: ' + $f.name + ' expect ' + $f.size + ' got ' + (Get-Item $dest).Length) }",
  '  }',
  "  # 3) 模型（hf-mirror 直下，断点续传；两文件共约 1.7GB）",
  "  $models = @(",
  "    @{ n = 'vibeasr-vae-encoder-i8_s.gguf';    u = 'https://hf-mirror.com/microsoft/VibeVoice-ASR-BitNet/resolve/main/vibeasr-vae-encoder-i8_s.gguf' },",
  "    @{ n = 'vibeasr-lm-i2_s-embed-q6_k.gguf'; u = 'https://hf-mirror.com/microsoft/VibeVoice-ASR-BitNet/resolve/main/vibeasr-lm-i2_s-embed-q6_k.gguf' }",
  '  )',
  '  foreach ($m in $models) {',
  "    $dest = Join-Path (Join-Path $Dir 'models') $m.n",
  "    $try = 0",
  '    while ($try -lt 30) {',
  '      $try++',
  '      try { DlUrlResume $m.u $dest; break }',
  "      catch { Log ('model retry ' + $try + ': ' + $_.Exception.Message); Start-Sleep 5 }",
  '    }',
  '  }',
  "  # 3b) 防火墙不用管：拉取模式下服务器从不反向连接客户端（客户端在外网/NAT 后也连不到），",
  "  #     一切流量都是本机主动出站到工作台（https:// 域名），Windows 默认放行出站",
  "  # 4) 启动引擎 sidecar（监听 0.0.0.0:9650 供本机调试 + --pull 拉取模式主动回连工作台领任务）",
  "  $cores = [Environment]::ProcessorCount",
  "  $threads = [Math]::Max(2, [Math]::Min(8, $cores - 1))",
  "  # 变量名绝不能叫 $args：那是 PS 自动变量，函数内 $args 指函数自己的参数表（空），",
  "  # 曾导致 Start-Process -ArgumentList 收到空值报「无法对参数ArgumentList执行参数验证」",
  "  $engArgs = @('server.js', '--bin', (Join-Path $eng 'asr_stream_server.exe'),",
  "    '--vae', (Join-Path (Join-Path $Dir 'models') 'vibeasr-vae-encoder-i8_s.gguf'),",
  "    '--lm',  (Join-Path (Join-Path $Dir 'models') 'vibeasr-lm-i2_s-embed-q6_k.gguf'),",
  "    '--port', '9650', '--host', '127.0.0.1', '--threads', [string]$threads,",
  "    '--pull', $Server, '--pkey', $Key)",
  "  function StartEngine { Start-Process -FilePath (Join-Path $Dir 'node.exe') -ArgumentList $script:engArgs -WorkingDirectory $Dir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Dir 'service.log') -RedirectStandardError (Join-Path $Dir 'service.err.log') }",
  '  StartEngine',
  "  Log 'engine started'",
  "  # 5) 注册回工作台（自动回填客户端地址，用户零配置）",
  '  $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike \'127.*\' -and $_.PrefixOrigin -ne \'WellKnown\' } | Select-Object -First 1).IPAddress',
  "  $regBody = @{ key = $Key; url = ('http://' + $ip + ':9650'); host = $env:COMPUTERNAME; cores = $cores } | ConvertTo-Json",
  '  for ($i = 0; $i -lt 10; $i++) {',
  '    try {',
  "      Invoke-RestMethod -Method Post -Uri ($Server + '/api/vibe/client-register') -ContentType 'application/json' -Body $regBody | Out-Null",
  '      break',
  '    } catch { Start-Sleep 10 }',
  '  }',
  "  Log 'registered'",
  '  # 6) 看护循环：进程死了拉起，每 10 分钟刷新登记（工作台显示在线状态）',
  '  for (;;) {',
  '    Start-Sleep 30',
  "    if (-not (Get-Process -Name 'node' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ($Dir + '*') })) { StartEngine; Log 'engine restarted' }",
  '    if ((Get-Date).Minute % 10 -eq 0) {',
  '      try { Invoke-RestMethod -Method Post -Uri ($Server + \'/api/vibe/client-register\') -ContentType \'application/json\' -Body $regBody | Out-Null } catch {}',
  '    }',
  '  }',
  '} catch {',
  "  Log ('FATAL ' + $_.Exception.Message)",
  "  Write-Host ('部署失败：' + $_.Exception.Message + '（详见 ' + $LogFile + '）')",
  '}',
].join('\n').replace(/__NODEVER__/g, NODE_VER);

const INSTALL_BAT = [
  '@echo off',
  'cd /d "%~dp0"',
  'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0vibeasr-setup.ps1"',
  'pause',
].join('\r\n');

// 卸载脚本：自包含（不依赖当初的 setup.ps1 还在），清 Run 自启 + 杀引擎/看护进程 + 删目录。
// 全 ASCII（bat 内嵌中文经 cmd 传参必乱码）；$PID 排除自身防自杀（卸载命令行里含目录名，会自匹配）。
const UNINSTALL_BAT = [
  '@echo off',
  'powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $base = \'D:\\LLM\'; if (-not (Test-Path \'D:\\\')) { $base = \'C:\\LLM\' }; $dir = Join-Path $base \'vibeasr\'; Remove-ItemProperty -Path \'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\' -Name \'WorkbenchVibeASR\' -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like (\'*\' + $dir + \'*\') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep 1; Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue; if (Test-Path $dir) { Write-Host \'Some files are locked, please reboot and run again\' } else { Write-Host \'WorkbenchVibeASR client engine uninstalled\' } }"',
  'pause',
].join('\r\n');

// ---------- 7B 客户端（VibeVoice-ASR 7B 完整版，带 NVIDIA 显卡的电脑） ----------
// 7B 模型只有 Linux vLLM 能跑（无 Windows 轮子）：Windows 侧经 WSL2 运行——
// PS1 负责 Windows 端（下载/node sidecar/注册/看护），bash 脚本在 WSL 内装 Miniconda+vLLM+模型并起服务（127.0.0.1:9660）。
// 端口分工：9650=1.5B sidecar | 9651=7B sidecar | 9660=WSL 内 vLLM（WSL2 自动把 localhost 双向转发到 Windows）。
// 下载源全用国内镜像（hf-mirror / tsinghua PyPI / tuna Miniconda / npmmirror node），断点续传，全程无 GitHub 依赖。
const WSL_SETUP_SH = `#!/usr/bin/env bash
# VibeVoice-ASR 7B WSL2 安装脚本（Windows 侧 setup.ps1 自动调用，也可手动：wsl -u root -e bash wsl-setup.sh /mnt/d/LLM/vibe7b）
# 幂等：vLLM 已在跑→秒退；缺什么补什么；模型/安装包断点续传（curl -C -）。
# 进度看本文件同目录 setup.log（/opt/vibevoice7b/setup.log）；vLLM 运行日志在 /opt/vibevoice7b/vllm.log。
set -u
WIN_DIR="$1"
[ -z "$WIN_DIR" ] && WIN_DIR=/mnt/d/LLM/vibe7b
ROOT=/opt/vibevoice7b
CONDA="$ROOT/miniconda"
MODEL="$ROOT/model"
PORT=9660
# 12GB 显存（RTX 3060 档）调优：bf16 权重 8.67GB，余量给 KV cache；显存更大的机器可调高 GPU_UTIL/MAX_LEN
GPU_UTIL=0.92
MAX_LEN=32768
MAX_SEQS=4
VLLM_VER=0.14.1
PYPI=https://pypi.tuna.tsinghua.edu.cn/simple
mkdir -p "$ROOT" "$MODEL"
exec >> "$ROOT/setup.log" 2>&1
echo "=== \$(date '+%F %T') wsl-setup start (win_dir=$WIN_DIR) ==="

vllm_up() { curl -sf "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1; }
if vllm_up; then echo "vllm already running, nothing to do"; exit 0; fi

# GPU 检查：WSL2 用 Windows 侧 NVIDIA 驱动（WSL 内不装 Linux 驱动）；识别不到 = WSL1 或没装 Windows 驱动
if ! command -v nvidia-smi >/dev/null 2>&1 || ! nvidia-smi >/dev/null 2>&1; then
  echo "FATAL: WSL 内识别不到 NVIDIA GPU——请在 Windows 上安装 NVIDIA 显卡驱动（WSL2 会自动透传）；若用的是 WSL1 请转 WSL2（wsl --set-default-version 2）"
  exit 1
fi

# 1) 系统依赖：ffmpeg（音频转码）、curl（下载）、unzip（解 repo）、libsndfile1（librosa 兜底）
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq || true
apt-get install -y -qq ffmpeg curl unzip libsndfile1 >/dev/null 2>&1 || apt-get install -y ffmpeg curl unzip libsndfile1
command -v ffmpeg >/dev/null 2>&1 || { echo "FATAL: ffmpeg 安装失败（apt 源问题？换个网络再跑一次，脚本幂等）"; exit 1; }

# 2) Miniconda（tuna 镜像，Python 3.12——vLLM/torch 轮子最高 cp312；文件名内嵌 py 版本，勿用 latest）
if [ ! -x "$CONDA/bin/python" ]; then
  MC=Miniconda3-py312_26.7.1-1-Linux-x86_64.sh
  ok=0
  for i in 1 2 3 4 5; do
    curl -C - -fL -o "$ROOT/$MC" "https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda/$MC" && { ok=1; break; }
    echo "miniconda download retry $i"; sleep 5
  done
  [ "$ok" = 1 ] || { echo "FATAL: Miniconda 下载失败（tuna 镜像不可达？）"; exit 1; }
  bash "$ROOT/$MC" -b -p "$CONDA" || { echo "FATAL: Miniconda 安装失败"; exit 1; }
fi
PIP="$CONDA/bin/pip"; PY="$CONDA/bin/python"

# 3) 仓库子集（vibevoice+vllm_plugin+pyproject）：pip install -e 注册 vLLM 插件入口；
#    --no-deps 避开仓库里的 TTS 重依赖（gradio/diffusers 等，转写用不到）
mkdir -p "$ROOT/repo"
if [ ! -f "$ROOT/repo/pyproject.toml" ] || [ ! -d "$ROOT/repo/vibevoice" ] || [ ! -d "$ROOT/repo/vllm_plugin" ]; then
  unzip -oq "$WIN_DIR/repo.zip" -d "$ROOT/repo" || { echo "FATAL: repo.zip 解压失败（$WIN_DIR/repo.zip 在吗？）"; exit 1; }
fi
"$PIP" install -q --no-deps --index-url "$PYPI" -e "$ROOT/repo" || { echo "FATAL: vllm_plugin 注册失败"; exit 1; }

# 4) Python 依赖：vllm 0.14.1（官方文档指定版本，带 CUDA torch 轮子，共约 6GB）+ librosa/scipy（音频前端）
ok=0
for i in 1 2 3; do
  "$PIP" install -q --index-url "$PYPI" "vllm==$VLLM_VER" librosa scipy && { ok=1; break; }
  echo "pip vllm install retry $i"; sleep 10
done
[ "$ok" = 1 ] || { echo "FATAL: pip 安装 vllm==$VLLM_VER 失败（tuna PyPI 不可达？网络恢复后重跑，幂等）"; exit 1; }
[ -x "$CONDA/bin/vllm" ] || { echo "FATAL: vllm 可执行未就位"; exit 1; }

# 5) 模型（HF 官方 VibeVoice-ASR：config + 索引 + 8 个 bf16 分片共 8.67GB；hf-mirror 断点续传）
BASE=https://hf-mirror.com/microsoft/VibeVoice-ASR/resolve/main
for f in config.json model.safetensors.index.json \\
         model-00001-of-00008.safetensors model-00002-of-00008.safetensors model-00003-of-00008.safetensors model-00004-of-00008.safetensors \\
         model-00005-of-00008.safetensors model-00006-of-00008.safetensors model-00007-of-00008.safetensors model-00008-of-00008.safetensors; do
  ok=0
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -C - -fL -o "$MODEL/$f" "$BASE/$f" && { ok=1; break; }
    echo "model $f download retry $i"; sleep 5
  done
  [ "$ok" = 1 ] && [ -s "$MODEL/$f" ] || { echo "FATAL: 模型文件下载失败 $f（网络恢复后重跑续传，已完成的不重下）"; exit 1; }
done

# 6) tokenizer（HF 仓库不带 tokenizer 文件，官方工具从 Qwen2.5-7B 生成并注入音频 token；HF_ENDPOINT 指镜像）
if [ ! -f "$MODEL/tokenizer.json" ]; then
  HF_ENDPOINT=https://hf-mirror.com "$PY" -m vllm_plugin.tools.generate_tokenizer_files --output "$MODEL" || { echo "FATAL: tokenizer 生成失败"; exit 1; }
fi

# 7) 起 vLLM（官方 start_server.py 同款参数，按 12GB 显存调小 max-model-len/max-num-seqs/gpu-memory-utilization）
echo "=== \$(date '+%F %T') starting vllm on :$PORT（加载 8.7GB 权重需几分钟） ==="
nohup "$CONDA/bin/vllm" serve "$MODEL" \\
  --served-model-name vibevoice --trust-remote-code --dtype bfloat16 \\
  --max-num-seqs $MAX_SEQS --max-model-len $MAX_LEN --gpu-memory-utilization $GPU_UTIL \\
  --no-enable-prefix-caching --enable-chunked-prefill --chat-template-content-format openai \\
  --host 0.0.0.0 --port $PORT >> "$ROOT/vllm.log" 2>&1 &
# 等就绪（权重加载 + CUDA 初始化最长 20 分钟）
for i in \$(seq 1 240); do
  vllm_up && { echo "=== \$(date '+%F %T') vllm ready ==="; exit 0; }
  sleep 5
done
echo "FATAL: vllm 20 分钟未就绪——看 $ROOT/vllm.log（常见：显存不足→把本文件顶部 GPU_UTIL 调到 0.85、MAX_LEN 调到 16384 再跑）"
exit 1
`;

const PS_TEMPLATE_7B = [
  '# 个人工作台·录音转写 VibeVoice-ASR 7B 客户端引擎部署脚本（带 NVIDIA 显卡的 Windows 电脑）',
  '# 7B 完整版只有 Linux vLLM 能跑：本脚本在 WSL2(Ubuntu) 里装 Miniconda+vLLM+模型（约 15GB 下载），',
  '# Windows 侧只跑 node sidecar（9651 端口，转发 WSL 内 vLLM 9660 并回连工作台领任务）。',
  '# 前置：Win10/11 + NVIDIA 显卡（8GB 显存可跑、12GB 稳）+ WSL2。没启用 WSL：管理员 PowerShell 运行 wsl --install ，重启电脑（首次进 Ubuntu 设置用户名密码）后再跑本脚本。',
  '# 进度：WSL 内 /opt/vibevoice7b/setup.log（wsl -u root cat /opt/vibevoice7b/setup.log）；Windows 侧 D:\\LLM\\vibe7b\\agent.log。',
  '# 卸载：powershell -ExecutionPolicy Bypass -File 本文件 -Remove',
  'param([switch]$Remove)',
  "$Server = '__SERVER__'",
  "$Key    = '__KEY__'",
  "$RunName = 'WorkbenchVibeASR7B'",
  "if (-not (Test-Path 'D:\\')) { $Base = 'C:\\LLM' } else { $Base = 'D:\\LLM' }",
  "$Dir = Join-Path $Base 'vibe7b'",
  "$LogFile = Join-Path $Dir 'agent.log'",
  "function Log([string]$m) { try { Add-Content -Path $LogFile -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m) -ErrorAction SilentlyContinue } catch {} }",
  '',
  'if ($Remove) {',
  "  Log 'uninstall'",
  "  Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name $RunName -ErrorAction SilentlyContinue",
  "  Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like ('*' + $Dir + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  "  # 停 WSL 里的 vLLM（尽力；wsl -e 直接执行，不经 bash 免转义）",
  "  try { & wsl.exe -u root -e pkill -f vibevoice7b } catch {}",
  "  try { & wsl.exe -u root -e pkill -f 'vllm serve' } catch {}",
  "  Remove-Item $Dir -Recurse -Force -ErrorAction SilentlyContinue",
  "  Write-Host '已卸载 7B 客户端引擎（Windows 侧）。WSL 内 /opt/vibevoice7b 保留（约 15GB，彻底清理：wsl -u root rm -rf /opt/vibevoice7b）'",
  '  exit',
  '}',
  '',
  '# --- 安装分支：不从安装目录运行时，先落位再转常驻 ---',
  'if ($PSCommandPath -and (-not $PSCommandPath.StartsWith($Dir))) {',
  '  New-Item -ItemType Directory -Force -Path $Dir | Out-Null',
  "  Log ('installing from ' + $PSCommandPath)",
  "  Copy-Item $PSCommandPath (Join-Path $Dir 'setup.ps1') -Force",
  "  $cmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"' + (Join-Path $Dir 'setup.ps1') + '\"'",
  "  New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name $RunName -Value $cmd -PropertyType String -Force | Out-Null",
  "  Write-Host ('安装到 ' + $Dir + ' 完成，开始准备 WSL2 环境与模型（约 15GB，窗口自动隐藏；进度见 WSL 内 /opt/vibevoice7b/setup.log）')",
  "  Start-Process -FilePath 'powershell.exe' -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"' + (Join-Path $Dir 'setup.ps1') + '\"')",
  '  exit',
  '}',
  '',
  '# --- 常驻分支：检查 WSL → 下载组件 → WSL 内安装 → 启动 sidecar → 注册 → 看护 ---',
  '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
  '# 工作台可能是内网自签名 HTTPS（按下载来源内嵌）：编译型 C# 回调放行证书（脚本块形式会在 TLS 线程炸）',
  "if (-not ('VibeTlsTrust7B' -as [type])) {",
  "  Add-Type -TypeDefinition 'using System.Net; using System.Security.Cryptography.X509Certificates; public class VibeTlsTrust7B : ICertificatePolicy { public bool CheckValidationResult(ServicePoint sp, X509Certificate cert, WebRequest req, int problem) { return true; } }'",
  '}',
  '[System.Net.ServicePointManager]::CertificatePolicy = New-Object VibeTlsTrust7B',
  '[System.Net.WebRequest]::DefaultWebProxy = $null',
  '# 单实例互斥（与 1.5B 引擎锁名不同——两套引擎可装在同一台电脑）',
  "$mtx = New-Object System.Threading.Mutex($false, 'Global\\WorkbenchVibeASR7B')",
  'if (-not $mtx.WaitOne(0)) { exit }',
  '',
  '# Windows 路径 → WSL /mnt 路径（D:\\LLM\\vibe7b → /mnt/d/LLM/vibe7b）',
  'function WslPath([string]$p) {',
  "  $x = $p -replace '\\\\', '/'",
  "  if ($x -match '^([A-Za-z]):/(.*)$') { return ('/mnt/' + $Matches[1].ToLower() + $Matches[2]) }",
  '  return $x',
  '}',
  '# 函数名绝不能叫 Curl：PS 5.1 里 curl 是 Invoke-WebRequest 的内建别名；-f 防 HTTP 错误静默写成文件',
  'function DlUrl([string]$url, [string]$out) {',
  "  & curl.exe -sS -L -f --retry 5 --retry-delay 3 --retry-all-errors -o $out $url",
  "  if ($LASTEXITCODE -ne 0) { throw ('download failed: ' + $url + ' exit=' + $LASTEXITCODE) }",
  '}',
  '',
  'try {',
  "  # 0) WSL 可用性：wsl -e echo 通不通（未装/装完没重启会失败）。输出是 UTF-16 混乱编码，剥掉空字节再匹配",
  "  Log 'checking wsl'",
  "  $wslProbe = (& wsl.exe -u root -e echo wsl-ok) 2>$null | Out-String",
  "  $wslProbe = $wslProbe -replace ([string][char]0), ''",
  "  if ($LASTEXITCODE -ne 0 -or $wslProbe -notmatch 'wsl-ok') {",
  "    Log 'FATAL wsl not available'",
  "    Write-Host ''",
  "    Write-Host '未检测到可用的 WSL2（7B 引擎在 WSL 里运行）。请按以下步骤启用后重跑本脚本：'",
  "    Write-Host '  1. 管理员 PowerShell 运行：wsl --install'",
  "    Write-Host '  2. 重启电脑；首次进 Ubuntu 设置用户名密码（本脚本用 root 运行，不受影响）'",
  "    Write-Host '  3. 重新双击 install-vibe7b.bat'",
  "    exit",
  '  }',
  "  # 1) Node 运行时（npmmirror 国内镜像；与 1.5B 各自独立一份）",
  "  if (-not (Test-Path (Join-Path $Dir 'node.exe'))) {",
  "    Log 'downloading node.exe'",
  "    $nz = Join-Path $Dir 'node.zip'",
  "    DlUrl 'https://registry.npmmirror.com/-/binary/node/v__NODEVER__/node-v__NODEVER__-win-x64.zip' $nz",
  "    Expand-Archive -Path $nz -DestinationPath (Join-Path $Dir 'node-pkg') -Force",
  "    Move-Item (Join-Path (Join-Path $Dir 'node-pkg') ('node-v__NODEVER__-win-x64/node.exe')) (Join-Path $Dir 'node.exe') -Force",
  "    Remove-Item $nz, (Join-Path $Dir 'node-pkg') -Recurse -Force -ErrorAction SilentlyContinue",
  '  }',
  "  # 2) sidecar + 仓库子集 + WSL 安装脚本（从工作台下载，带登记密钥）",
  "  Log 'downloading sidecar/repo/wsl-setup'",
  "  DlUrl ($Server + '/api/vibe/client-download?f=server.js&k=' + $Key) (Join-Path $Dir 'server.js')",
  "  DlUrl ($Server + '/api/vibe/client-download?f=vibe7b-repo.zip&k=' + $Key) (Join-Path $Dir 'repo.zip')",
  "  DlUrl ($Server + '/api/vibe/client-download?f=vibe7b-setup.sh&k=' + $Key) (Join-Path $Dir 'wsl-setup.sh')",
  "  # 3) WSL 内安装（apt/Miniconda/vLLM/模型 8.7GB，全镜像源断点续传；幂等——已就绪时秒退，开机自启每次都跑一遍即自然自愈）",
  "  Log 'wsl setup start（首次约 30~60 分钟，进度：wsl -u root cat /opt/vibevoice7b/setup.log）'",
  "  & wsl.exe -u root -e bash (WslPath (Join-Path $Dir 'wsl-setup.sh')) (WslPath $Dir)",
  "  if ($LASTEXITCODE -ne 0) { throw ('WSL 内安装失败 exit=' + $LASTEXITCODE + '——看 WSL 内 /opt/vibevoice7b/setup.log 末尾的 FATAL 行') }",
  "  Log 'wsl setup done'",
  "  # 4) sidecar（代理模式：转发 WSL vLLM 9660，本地不跑 BitNet；9651 与 1.5B 的 9650 区分，两引擎可同机共存）",
  "  $cores = [Environment]::ProcessorCount",
  "  $gpu = ''",
  "  try { $gpu = ([string]((& nvidia-smi --query-gpu=name --format=csv,noheader) 2>$null | Select-Object -First 1)).Trim() } catch {}",
  "  # 变量名绝不能叫 $args：PS 自动变量（1.5B 部署包踩过：函数内 $args 是函数参数表→Start-Process 收到空值）",
  "  $engArgs = @('server.js', '--proxy', 'http://127.0.0.1:9660',",
  "    '--pull', $Server, '--pkey', $Key,",
  "    '--engine', 'vibe7b', '--label', 'VibeVoice-ASR-7B',",
  "    '--port', '9651', '--host', '127.0.0.1')",
  "  function StartEngine { Start-Process -FilePath (Join-Path $Dir 'node.exe') -ArgumentList $script:engArgs -WorkingDirectory $Dir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Dir 'service.log') -RedirectStandardError (Join-Path $Dir 'service.err.log') }",
  '  StartEngine',
  "  Log 'engine started'",
  "  # 5) 注册回工作台（engine=vibe7b 分卡登记；gpu 名随登记上报，页面上能看到显卡型号）",
  '  $ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike \'127.*\' -and $_.PrefixOrigin -ne \'WellKnown\' } | Select-Object -First 1).IPAddress',
  "  $regBody = @{ key = $Key; url = ('http://' + $ip + ':9651'); host = $env:COMPUTERNAME; cores = $cores; engine = 'vibe7b'; gpu = $gpu } | ConvertTo-Json",
  '  for ($i = 0; $i -lt 10; $i++) {',
  '    try {',
  "      Invoke-RestMethod -Method Post -Uri ($Server + '/api/vibe/client-register') -ContentType 'application/json' -Body $regBody | Out-Null",
  '      break',
  '    } catch { Start-Sleep 10 }',
  '  }',
  "  Log 'registered'",
  '  # 6) 看护：sidecar 死了拉起；sidecar /health 连续 6 次失败（3 分钟）= WSL 里 vLLM 挂了 → 重跑 wsl-setup（幂等重启 vLLM）',
  '  $bad = 0',
  '  for (;;) {',
  '    Start-Sleep 30',
  "    if (-not (Get-Process -Name 'node' -ErrorAction SilentlyContinue | Where-Object { $_.Path -like ($Dir + '*') })) { StartEngine; Log 'engine restarted' }",
  '    try {',
  "      $null = Invoke-RestMethod -Uri 'http://127.0.0.1:9651/health' -TimeoutSec 10",
  '      $bad = 0',
  '    } catch {',
  '      $bad++',
  "      Log ('health fail x' + $bad)",
  "      if ($bad -ge 6) { $bad = 0; Log 'rerun wsl setup to restart vllm'; try { & wsl.exe -u root -e bash (WslPath (Join-Path $Dir 'wsl-setup.sh')) (WslPath $Dir) } catch {} }",
  '    }',
  '    if ((Get-Date).Minute % 10 -eq 0) {',
  '      try { Invoke-RestMethod -Method Post -Uri ($Server + \'/api/vibe/client-register\') -ContentType \'application/json\' -Body $regBody | Out-Null } catch {}',
  '    }',
  '  }',
  '} catch {',
  "  Log ('FATAL ' + $_.Exception.Message)",
  "  Write-Host ('部署失败：' + $_.Exception.Message + '（详见 ' + $LogFile + ' 与 WSL 内 /opt/vibevoice7b/setup.log）')",
  '}',
].join('\n').replace(/__NODEVER__/g, NODE_VER);

const INSTALL_BAT_7B = [
  '@echo off',
  'cd /d "%~dp0"',
  'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0vibe7b-setup.ps1"',
  'pause',
].join('\r\n');

// 卸载 7B：清 Run 自启 + 杀 Windows 侧进程 + 停 WSL 内 vLLM + 删 Windows 目录（WSL 内 /opt/vibevoice7b 保留，提示手动清）
const UNINSTALL_BAT_7B = [
  '@echo off',
  'powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $base = \'D:\\LLM\'; if (-not (Test-Path \'D:\\\')) { $base = \'C:\\LLM\' }; $dir = Join-Path $base \'vibe7b\'; Remove-ItemProperty -Path \'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\' -Name \'WorkbenchVibeASR7B\' -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like (\'*\' + $dir + \'*\') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; & wsl.exe -u root -e pkill -f vibevoice7b 2>$null; & wsl.exe -u root -e pkill -f \'vllm serve\' 2>$null; Start-Sleep 1; Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue; if (Test-Path $dir) { Write-Host \'Some files are locked, please reboot and run again\' } else { Write-Host \'WorkbenchVibeASR 7B client engine uninstalled (WSL /opt/vibevoice7b kept, remove manually if needed)\' } }"',
  'pause',
].join('\r\n');

router.get('/vibe/client-files', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可下载部署包' });
  const type = String(req.query.type || '');
  const seven = req.query.engine === 'vibe7b'; // 7B 客户端包（带 NVIDIA 显卡的电脑）；缺省=1.5B 纯 CPU 包
  if (type === 'setup') {
    const ps = (seven ? PS_TEMPLATE_7B : PS_TEMPLATE).replace(/__SERVER__/g, baseUrl(req)).replace(/__KEY__/g, getClientKey());
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${seven ? 'vibe7b-setup.ps1' : 'vibeasr-setup.ps1'}"`);
    return res.end('\uFEFF' + ps); // UTF-8 BOM：PS 5.1 无 BOM 会按 ANSI 解析中文
  }
  if (type === 'install') {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${seven ? 'install-vibe7b.bat' : 'install-vibeasr.bat'}"`);
    return res.end(seven ? INSTALL_BAT_7B : INSTALL_BAT);
  }
  if (type === 'uninstall') {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${seven ? 'uninstall-vibe7b.bat' : 'uninstall-vibeasr.bat'}"`);
    return res.end(seven ? UNINSTALL_BAT_7B : UNINSTALL_BAT);
  }
  res.status(400).json({ error: '未知类型' });
});

// 引擎组件下发（部署脚本专用，密钥校验；浏览器登录态访问不了也不该访问）
router.get('/vibe/client-download', (req, res) => {
  if (!keyOk(req)) return res.status(403).json({ error: '密钥不对' });
  if (req.query.list === '1') return res.json(clientFileList());
  const name = String(req.query.f || '');
  // 7B 客户端三件：sidecar 同款 server.js + 仓库子集 zip（pip install -e 用）+ WSL 安装 bash 脚本（字符串直出）
  if (name === 'vibe7b-setup.sh') {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="vibe7b-setup.sh"');
    return res.end(Buffer.from(WSL_SETUP_SH, 'utf8'));
  }
  if (name === 'vibe7b-repo.zip') {
    const p = path.join(__dirname, '..', 'vibe7b-repo.zip');
    if (!fs.existsSync(p)) return res.status(404).json({ error: '服务端缺 vibe7b-repo.zip（服务器未升级到本版本）' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="vibe7b-repo.zip"');
    return fs.createReadStream(p).pipe(res);
  }
  const { dir } = clientFileList();
  // 文件名白名单 [\w.+-]（libstdc++-6.dll 名字里有 +）；旧部署脚本不编码直接拼 URL——
  // query 里的 + 被解码成空格（libstdc  -6.dll），曾 404 把 JSON 当 DLL 写盘 → 引擎 0xC0000135 崩溃循环。
  // 服务端空格换回 + 再试一次兼容旧脚本；新脚本（v1.5.7+）已改 [uri]::EscapeDataString 编码文件名。
  const pick = (n) => (dir && /^[\w.+-]+\.(exe|dll)$/i.test(n) && fs.existsSync(path.join(dir, n)) ? path.join(dir, n) : '');
  const file = name === 'server.js' ? paths.SIDECAR : (pick(name) || pick(name.replace(/ /g, '+')));
  if (!file) return res.status(404).json({ error: '文件不存在：' + name });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(file)}"`);
  fs.createReadStream(file).pipe(res);
});

// 客户端登记/心跳：校验密钥，按 engine 分卡登记（1.5B 与 7B 各自一份地址/在线状态，可同时在线）
router.post('/vibe/client-register', (req, res) => {
  const b = req.body || {};
  if (String(b.key || '') !== getClientKey()) return res.status(403).json({ error: '密钥不对' });
  const engine = b.engine === 'vibe7b' ? 'vibe7b' : 'vibeasr'; // 老部署包不带 engine → 1.5B（唯一存在的老引擎）
  const url = String(b.url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[\w.-]+:\d+$/i.test(url)) return res.status(400).json({ error: '地址格式不对' });
  const clients = getClients();
  clients[engine] = {
    ...clients[engine], url,
    host: String(b.host || clients[engine].host).slice(0, 60),
    cores: Number(b.cores) || clients[engine].cores,
    gpu: String(b.gpu ?? clients[engine].gpu).slice(0, 80),
    last_seen: Date.now(),
  };
  setSetting('vibe_clients', clients);
  if (engine === 'vibeasr') {
    // 兼容老字段 client_url：1.5B 回填的地址同步写一份（UI 已不再展示，仅留作过渡）
    const cfg = getVibeSettings();
    if (cfg.client_url !== url) setSetting('vibe_settings', { ...cfg, client_url: url });
  }
  res.json({ ok: true });
});

// 客户端状态（UI 显示两台引擎各自的在线/地址/显卡）
router.get('/vibe/client-status', (req, res) => {
  const engines = getClients();
  const cfg = getVibeSettings();
  const cur = cfg.client_engine === 'vibe7b' ? 'vibe7b' : 'vibeasr';
  res.json({ engines, client_engine: cur, online: clientOnline(engines[cur]) });
});

// ---------- 拉取模式：客户端领任务 / 回传结果（EXEMPT 免登录，key 即凭证） ----------
// 客户端引擎常驻循环每 4 秒领一次；领取动作本身就是心跳（顺带刷新该引擎的在线状态）。
// engine 路由：7B sidecar 带 engine=vibe7b 只领 7B 任务；老 1.5B sidecar 不带参数默认 vibeasr（向后兼容）。
router.post('/vibe/job/next', (req, res) => {
  if (!keyOk(req)) return res.status(403).json({ error: '密钥不对' });
  const engine = (req.body && req.body.engine) === 'vibe7b' ? 'vibe7b' : 'vibeasr';
  const clients = getClients();
  clients[engine] = {
    ...clients[engine], last_seen: Date.now(),
    host: String((req.body && req.body.host) || clients[engine].host).slice(0, 60),
    cores: Number((req.body && req.body.cores)) || clients[engine].cores,
  };
  setSetting('vibe_clients', clients);
  try { sweepStaleJobs(); } catch { /* 清扫失败不挡领取 */ }
  const job = db.prepare("SELECT id, req_body FROM vibe_jobs WHERE status='queued' AND COALESCE(engine,'vibeasr')=? ORDER BY id LIMIT 1").get(engine);
  if (!job) return res.status(204).end();
  db.prepare("UPDATE vibe_jobs SET status='claimed', claimed_at=? WHERE id=?").run(Date.now(), job.id);
  res.json({ id: job.id, body: JSON.parse(job.req_body) });
});

// 客户端回传结果：ok=true 带 content（utterances 文本）与 model；ok=false 带 error
router.post('/vibe/job/:id/result', (req, res) => {
  if (!keyOk(req)) return res.status(403).json({ error: '密钥不对' });
  const b = req.body || {};
  const job = db.prepare('SELECT * FROM vibe_jobs WHERE id=?').get(Number(req.params.id) || 0);
  if (!job || job.status === 'done') return res.json({ ok: true, ignored: true }); // 重复回传/已超时作废——幂等
  db.prepare("UPDATE vibe_jobs SET status=?, error=?, req_body='', finished_at=? WHERE id=?")
    .run(b.ok ? 'done' : 'failed', b.ok ? '' : String(b.error || '').slice(0, 500), Date.now(), job.id);
  if (b.ok) {
    try {
      finishTranscribe(job.record_id, String(b.content ?? ''), String(b.model || 'vibevoice') + '（客户端算力）');
    } catch (e) {
      db.prepare("UPDATE vibe_records SET status='failed', error=? WHERE id=? AND status='running'").run(String(e.message).slice(0, 500), job.record_id);
    }
  } else {
    db.prepare("UPDATE vibe_records SET status='failed', error=? WHERE id=? AND status='running'")
      .run(String(b.error || '客户端转写失败').slice(0, 500), job.record_id);
  }
  res.json({ ok: true });
});

module.exports = router;
