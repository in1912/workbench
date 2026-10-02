// MOSS-TTS-Nano 接入层：按需拉起 Python 常驻合成服务（tts/moss_server.py，127.0.0.1:9640），
// 管理全局音色库（参考音频 = 音色本体），并做合成缓存（音色+文本 哈希落盘，听写重跑秒回）。
// 集成方式按飞书文档《离线本地配音》：uv 建 Python 3.12 独立环境 + 仓库 ONNX CPU 推理
//（等价于文档的 conda 步骤；Windows 上 WeTextProcessing 装不上，sidecar 固定 enable_wetext=False 绕开，
//  该库懒加载不受影响）。
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { db, getSetting, setSetting } = require('../db');
// 路径统一由 ttsPaths 解析：环境变量 > 持久卷（/data/tts，一键安装器的目标）> 项目 tts/
const { TTS_ROOT, PY, SERVER, REPO, VOICES_DIR, CACHE_DIR } = require('./ttsPaths');
const REPO_AUDIO = path.join(REPO, 'assets', 'audio');
const PORT = Number(process.env.MOSS_TTS_PORT || 9640);
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child = null;            // Python 子进程（随工作台启停）
let bootPromise = null;      // 拉起去重：并发请求共享一次启动
let lastRespawnAt = 0;       // 引擎报错后的重启冷却
const inflight = new Map();  // 合成去重：同 key 并发只算一次

function installed() {
  // 入口脚本随代码分发必然存在，真正要装的是 venv 解释器与推理仓库
  return !!PY && fs.existsSync(path.join(REPO, 'onnx_tts_runtime.py'));
}

// 随包引擎脚本的构建标识（moss_server.py 内 ENGINE_BUILD 常量）：与运行中进程上报的
// 比对，识别“升级换了文件但 9640 上还是旧代码进程”的悬案（症状：报错文案不随升级变化）
const ENGINE_BUILD_RE = /^ENGINE_BUILD\s*=\s*["']([^"']+)["']/m;
function expectedEngineBuild() {
  try {
    const m = ENGINE_BUILD_RE.exec(fs.readFileSync(SERVER, 'utf8'));
    return m ? m[1] : '';
  } catch { return ''; }
}

// ---------- Python 常驻服务生命周期 ----------
async function health(fast) {
  try {
    const r = await fetch(BASE + '/health', { signal: AbortSignal.timeout(fast ? 1200 : 4000) });
    return await r.json();
  } catch { return null; }
}

async function ensureServer() {
  let h = await health(true);
  // 旧引擎进程识别：升级换了脚本但端口上的进程还是旧代码（本地开发重启 Node 也不会
  // 带走 Python 子进程）。build 不一致 → 请它退出（POST /shutdown）后重新拉起；
  // 旧引擎连该端点都没有时，给出可执行的明确指引而不是让用户对着一成不变的报错猜。
  const want = expectedEngineBuild();
  if (h && want && (!h.build || h.build !== want)) {
    try { await fetch(BASE + '/shutdown', { method: 'POST', signal: AbortSignal.timeout(2000) }); } catch { /* 旧引擎无此端点 */ }
    await sleep(1500);
    h = await health(true);
    if (h && (!h.build || h.build !== want)) {
      throw new Error(`端口 ${PORT} 上是旧版 TTS 引擎进程（运行中 build=${h.build || '无标识'}，随包代码 build=${want}），无法自动替换：请重启服务/容器后再点「启动引擎」`);
    }
  }
  // 引擎报错（如模型下载失败）时杀掉重启一次（60 秒冷却，避免每请求反复重试拖垮机器）
  if (h && h.phase === 'error' && child && Date.now() - lastRespawnAt > 60 * 1000) {
    lastRespawnAt = Date.now();
    child.kill(); child = null; h = null;
  }
  if (h) return h;
  if (!installed()) throw new Error('TTS 引擎未安装：请到「效率工具 → 语音配音」页一键安装（或先完成环境安装）');
  if (!bootPromise) {
    bootPromise = (async () => {
      fs.mkdirSync(path.join(TTS_ROOT, 'tmp'), { recursive: true });
      // 日志目录随引擎根走（Docker 为 /data/Logs）：data 卷里未必已存在，openSync 不会自建父目录
      fs.mkdirSync(path.join(TTS_ROOT, '..', 'Logs'), { recursive: true });
      const logFd = fs.openSync(path.join(TTS_ROOT, '..', 'Logs', 'tts-server.log'), 'a');
      // 首次运行需从 HuggingFace 下载模型；直连常被墙，默认走 hf-mirror 镜像（可用环境变量覆盖）
      // MOSS_TTS_ROOT 把 sidecar 根定位到实际引擎目录；HF_HOME 落在引擎目录内（随持久卷保存）
      child = spawn(PY, [SERVER], {
        stdio: ['ignore', logFd, logFd],
        env: {
          ...process.env,
          MOSS_TTS_ROOT: TTS_ROOT,
          HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
          HF_HOME: path.join(TTS_ROOT, 'hf-cache'),
          // 禁用 hf_xet（Rust 加速下载器）：新版 huggingface_hub 在 Linux 自动携带，
          // 但它对 hf-mirror 镜像构建下载请求会报「Reqwest error: builder error」——
          // 大权重文件（LFS 存储）全部失败、小文件正常，正是首次下载半成品的根源。
          // 禁用后走普通 HTTP 分段下载（镜像兼容，断点续传不受影响）。
          HF_HUB_DISABLE_XET: process.env.HF_HUB_DISABLE_XET || '1',
        },
      });
      child.on('exit', (code) => {
        child = null; bootPromise = null;
        // 排查用：sidecar 意外退出（听写中途引擎重载的根源）时在日志留痕
        try {
          fs.appendSync(path.join(TTS_ROOT, '..', 'Logs', 'tts-server.log'),
            `[node ${new Date().toLocaleString('sv')}] sidecar 退出 code=${code}\n`);
        } catch { /* 日志写不进就算了 */ }
      });
      for (let i = 0; i < 45; i++) {           // 等端口起来（模型加载在其后台线程，不阻塞端口）
        const h2 = await health(true);
        if (h2) return h2;
        await sleep(1000);
      }
      throw new Error('TTS 服务启动超时：详见 Logs/tts-server.log');
    })().finally(() => { bootPromise = null; });
  }
  return bootPromise;
}

// 等模型就绪（首次会先自动下载 ONNX 模型约 670MB，视网速可能超过本等待窗口）
async function waitReady(timeoutMs = 15 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const h = await ensureServer();
    if (h.phase === 'ready') return h;
    if (h.phase === 'error') throw new Error('TTS 引擎初始化失败：' + (h.error || '未知错误'));
    if (Date.now() > deadline) {
      throw new Error(h.phase === 'downloading'
        ? `TTS 模型仍在下载（约 670MB，仅首次）：请到「效率工具 → 语音配音」或「家庭管理 → 儿童故事」点「启动引擎」观察进度，下载完成后重试`
        : 'TTS 引擎就绪超时（' + h.phase + '）');
    }
    await sleep(2000);
  }
}

// ---------- 音色库 ----------
// 内置音色从模型 manifest（browser_poc_manifest.json）播种：18 个官方音色（中/英/日），
// preset=模型内预编码名；wav 在 assets/ 里存在时 file_path 一并记下（可直接试听参考录音）。
// 模型只在首次合成时才下载，而音色库播种原本依赖模型目录里的 manifest——不兜底就是
// 「音色库空 → 合成按钮全灰 → 永远触发不了首次合成」的死锁。故 manifest 缺席时用
// 内置清单（模型仓库的静态镜像）先建库：preset 合成不依赖 wav，按钮立刻可用；
// 模型到位后（manifest 出现）自动补全/对齐参考录音路径（顺带治愈跨 NAS 迁移留下的旧根路径）。
const BUILTIN_FALLBACK = [
  { voice: 'Junhao', display_name: 'CN 欢迎关注模思智能', group: 'Chinese Male', audio_file: 'zh_1.wav' },
  { voice: 'Zhiming', display_name: 'CN 京味胡同闲聊', group: 'Chinese Male', audio_file: 'zh_3.wav' },
  { voice: 'Weiguo', display_name: 'CN 说书', group: 'Chinese Male', audio_file: 'zh_10.wav' },
  { voice: 'Xiaoyu', display_name: 'CN 明星', group: 'Chinese Female', audio_file: 'zh_11.wav' },
  { voice: 'Yuewen', display_name: 'CN 机车', group: 'Chinese Female', audio_file: 'zh_4.wav' },
  { voice: 'Lingyu', display_name: 'CN 深夜电台', group: 'Chinese Female', audio_file: 'zh_6.wav' },
  { voice: 'Trump', display_name: 'EN Trump', group: 'English Male', audio_file: 'en_1.wav' },
  { voice: 'Ava', display_name: 'EN The Bitter Lesson', group: 'English Female', audio_file: 'en_2.wav' },
  { voice: 'Bella', display_name: 'EN A Gentle Reminder', group: 'English Female', audio_file: 'en_3.wav' },
  { voice: 'Adam', display_name: 'EN English News', group: 'English Male', audio_file: 'en_4.wav' },
  { voice: 'Nathan', display_name: 'EN The Quiet Motion of the World', group: 'English Male', audio_file: 'en_8.wav' },
  { voice: 'Soyo', display_name: 'JP Soyo', group: 'Japanese Female', audio_file: 'jp_1.wav' },
  { voice: 'Saki', display_name: 'JP Saki', group: 'Japanese Female', audio_file: 'jp_2.wav' },
  { voice: 'Mortis', display_name: 'JP Mortis', group: 'Japanese Female', audio_file: 'jp_3.wav' },
  { voice: 'Umiri', display_name: 'JP Umiri', group: 'Japanese Female', audio_file: 'jp_4.wav' },
  { voice: 'Mei', display_name: 'JP Togawa', group: 'Japanese Female', audio_file: 'jp_5.wav' },
  { voice: 'Anon', display_name: 'JP Anon', group: 'Japanese Female', audio_file: 'jp_6.wav' },
  { voice: 'Arisa', display_name: 'JP Arisa', group: 'Japanese Female', audio_file: 'jp_7.wav' },
];
function ensureSeeded() {
  const manifest = path.join(TTS_ROOT, 'MOSS-TTS-Nano', 'models', 'MOSS-TTS-Nano-100M-ONNX', 'browser_poc_manifest.json');
  let manifestVoices = [];
  try {
    manifestVoices = JSON.parse(fs.readFileSync(manifest, 'utf8')).builtin_voices || [];
  } catch { /* 模型未下载：走内置兜底清单 */ }
  const voices = manifestVoices.length ? manifestVoices : BUILTIN_FALLBACK;
  const groupLabel = {
    'Chinese Male': '中文男声', 'Chinese Female': '中文女声',
    'English Male': '英文男声', 'English Female': '英文女声',
    'Japanese Male': '日文男声', 'Japanese Female': '日文女声',
  };
  const have = new Set(db.prepare("SELECT preset FROM tts_voices WHERE kind='builtin'").all().map((r) => r.preset));
  const ins = db.prepare('INSERT INTO tts_voices(name, kind, file_path, preset) VALUES (?, ?, ?, ?)');
  const upd = db.prepare('UPDATE tts_voices SET file_path=? WHERE preset=? AND file_path!=?');
  for (const v of voices) {
    if (!v.voice) continue;
    const flavor = String(v.display_name || '').replace(/^(CN|EN|JP)\s*/u, '');
    const name = `${groupLabel[v.group] || v.group || '内置'} · ${v.voice}` + (flavor && flavor !== v.voice ? `（${flavor}）` : '');
    const wav = v.audio_file && fs.existsSync(path.join(REPO_AUDIO, v.audio_file)) ? path.join(REPO_AUDIO, v.audio_file) : '';
    if (!have.has(v.voice)) ins.run(name, 'builtin', wav, v.voice);
    else if (wav) upd.run(wav, v.voice, wav); // 补填/对齐参考录音（旧根失效自愈）
  }
  // 仅 manifest 真正到位后才置完成位；兜底播种保持“待补”状态，模型下载完自动补全
  if (manifestVoices.length) setSetting(db, 'tts_builtin_seeded', 1);
}

function listVoices() {
  ensureSeeded();
  return db.prepare(`SELECT id, name, kind, preset, created_at,
    CASE WHEN file_path != '' THEN 1 ELSE 0 END AS has_file
    FROM tts_voices ORDER BY kind='builtin' DESC, id`).all();
}

function getVoice(id) {
  ensureSeeded();
  return db.prepare('SELECT * FROM tts_voices WHERE id=?').get(Number(id));
}

function defaultVoiceId(tdb) {
  const useDb = tdb || db;
  const v = getVoice(getSetting(useDb, 'tts_default_voice', 0));
  if (v) return v.id;
  const first = db.prepare("SELECT id FROM tts_voices ORDER BY kind='builtin' DESC, id LIMIT 1").get();
  return first ? first.id : 0;
}

function setDefaultVoice(tdb, id) {
  if (!getVoice(id)) throw new Error('音色不存在');
  setSetting(tdb, 'tts_default_voice', Number(id));
}

function addVoice(name, filePath, createdBy) {
  const r = db.prepare('INSERT INTO tts_voices(name, kind, file_path, created_by) VALUES (?, ?, ?, ?)')
    .run(String(name || '').trim() || '我的音色', 'upload', filePath, createdBy || null);
  return r.lastInsertRowid;
}

function removeVoice(id) {
  const v = getVoice(id);
  if (!v) throw new Error('音色不存在');
  if (v.kind === 'builtin') throw new Error('内置示例音色不可删除');
  db.prepare('DELETE FROM tts_voices WHERE id=?').run(v.id);
  try { fs.unlinkSync(v.file_path); } catch { /* 文件已不在就算了 */ }
}

// ---------- 合成（带缓存） ----------
function cacheKey(voiceId, text) {
  return crypto.createHash('sha256').update(`${voiceId}\n${text}`).digest('hex') + '.wav';
}

// 缓存体积封顶：超过 600MB 按 mtime 淘汰最旧到 400MB 以下（听写重跑靠缓存，不值得无限增长）
function evictCache() {
  try {
    const files = fs.readdirSync(CACHE_DIR).map((f) => {
      const p = path.join(CACHE_DIR, f);
      return { p, size: fs.statSync(p).size, mtime: fs.statSync(p).mtimeMs };
    });
    let total = files.reduce((s, f) => s + f.size, 0);
    if (total < 600 * 1024 * 1024) return;
    for (const f of files.sort((a, b) => a.mtime - b.mtime)) {
      if (total < 400 * 1024 * 1024) break;
      fs.unlinkSync(f.p); total -= f.size;
    }
  } catch { /* 清理失败不影响主流程 */ }
}

// 返回合成音频的磁盘路径（缓存命中直接返回；未命中经 Python 服务生成后落缓存）
async function synthesize(voiceId, text) {
  const voice = getVoice(voiceId) || getVoice(defaultVoiceId(null));
  if (!voice) throw new Error('音色库为空：请先在「语音配音」tab 上传或添加音色');
  // 参考音频必须在当前引擎根内：跨 NAS 迁移后旧行 file_path 可能指向恰好存在的旧根副本
  // （如升级包随附的 /app/tts），文件虽在但会被 moss_server 路径围栏拒——越界按“无参考录音”走 preset
  const inRoot = (p) => { try { return path.resolve(p).startsWith(path.resolve(TTS_ROOT) + path.sep); } catch { return false; } };
  const hasFile = !!(voice.file_path && inRoot(voice.file_path) && fs.existsSync(voice.file_path));
  if (!hasFile && !voice.preset) throw new Error(`音色参考音频丢失：${voice.name}`);
  const txt = String(text || '').trim();
  if (!txt) throw new Error('合成文本不能为空');
  if (txt.length > 2000) throw new Error('文本过长（>2000 字符）');

  const key = cacheKey(voice.id, txt);
  const cacheFile = path.join(CACHE_DIR, key);
  if (fs.existsSync(cacheFile)) return cacheFile;

  let p = inflight.get(key);
  if (!p) {
    p = (async () => {
      await waitReady();
      const r = await fetch(BASE + '/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // 优先参考音频（上传音色必有文件；内置音色 wav 缺失时走模型预编码 preset）
        body: JSON.stringify(hasFile
          ? { text: txt, prompt_audio_path: voice.file_path }
          : { text: txt, voice: voice.preset }),
        signal: AbortSignal.timeout(5 * 60 * 1000),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        throw new Error('语音合成失败：' + (j.detail || 'HTTP ' + r.status));
      }
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 200) throw new Error('语音合成失败：输出音频异常');
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(cacheFile, buf);
      evictCache();
      return cacheFile;
    })();
    inflight.set(key, p);
    p.finally(() => inflight.delete(key));
  }
  return p;
}

async function status() {
  const h = await health(true);
  return {
    installed: installed(),
    running: !!h,
    phase: h ? h.phase : 'stopped',
    build: h ? (h.build || '') : '',
    error: h ? h.error : '',
    detail: h ? h.detail : '',
    voice_count: (ensureSeeded(), db.prepare('SELECT COUNT(*) c FROM tts_voices').get().c),
  };
}

module.exports = {
  installed, status, ensureServer, waitReady,
  listVoices, getVoice, defaultVoiceId, setDefaultVoice, addVoice, removeVoice,
  synthesize, VOICES_DIR,
};
