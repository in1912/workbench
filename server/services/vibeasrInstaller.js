// VibeASR BitNet 引擎一键安装器：把转写引擎装进持久目录（Docker 为 /data/vibeasr）。
// 流程：准备目录 → 引擎二进制（优先升级包随附的编译产物；Linux 无预编译时现场编译）
//      → 下载 2 个 GGUF 模型（hf-mirror，断点续传，共约 1.7GB）→ 部署并直接启动常驻服务。
// 与 TTS 安装器的差别：无 Python 环境；装完即用（sidecar 直接拉起，无需重启进程）。
// 管理员在「录音转写」页点一键安装，前端轮询 /vibe/engine/status 看进度与日志。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { setSetting } = require('../db');
const paths = require('./vibeasrPaths');
const service = require('./vibeasrService');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STEP_DEFS = [
  { key: 'prepare', label: '准备安装目录', weight: 2 },
  { key: 'engine', label: '安装引擎程序', weight: 18 },
  { key: 'models', label: '下载语音模型（约 1.7GB，断点续传）', weight: 76 },
  { key: 'deploy', label: '启动转写服务', weight: 4 },
];

const state = {
  running: false, done: false,
  stepIndex: -1, progress: 0,
  error: '', startedAt: null, finishedAt: null,
  log: [],
};
function addLog(line) {
  const clean = String(line).split('\r').pop().replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').slice(0, 300);
  if (!clean.trim()) return;
  state.log.push(clean);
  if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
  console.log('[vibeasr-install]', clean);
}
function stepBase(i) { return STEP_DEFS.slice(0, i).reduce((s, d) => s + d.weight, 0); }
const TOTAL_W = STEP_DEFS.reduce((s, d) => s + d.weight, 0);
function setStepProgress(frac) {
  state.progress = Math.min(99, Math.round(((stepBase(state.stepIndex) + (frac || 0) * STEP_DEFS[state.stepIndex].weight) / TOTAL_W) * 100));
}
function status() {
  return {
    ...state,
    steps: STEP_DEFS.map((d, i) => ({
      ...d,
      state: i < state.stepIndex ? 'done'
        : i === state.stepIndex ? (state.running ? 'active' : state.error ? 'failed' : 'done')
          : 'pending',
    })),
    log: state.log.slice(-40),
  };
}

// ---------- 断点续传下载（fs.createWriteStream append + Range） ----------
function downloadResumable(url, dest, onProgress, { maxRetry = 8 } = {}) {
  return new Promise(async (resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    for (let attempt = 1; attempt <= maxRetry; attempt++) {
      try {
        const have = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
        const r = await fetch(url, {
          headers: have ? { Range: `bytes=${have}-` } : {},
          redirect: 'follow',
          signal: AbortSignal.timeout(120_000), // 单次 2 分钟无响应算失败重连
        });
        if (r.status === 416) { onProgress?.(have, have); return resolve(); } // Range 越界=本地已完整，直接成功
        if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status}`);
        // 总长度：Content-Range 尾部 > content-length（206 时是剩余长度）
        let total = have + Number(r.headers.get('content-length')) || 0;
        const cr = String(r.headers.get('content-range') || '').match(/\/(\d+)$/);
        if (cr) total = Number(cr[1]);
        if (!total || total < 1024) throw new Error('响应无有效长度');
        if (have >= total) { onProgress?.(total, total); return resolve(); } // 已下完（上次成功）
        // fetch 的 body 是 web ReadableStream（无 .on/.pipe），只能异步迭代；背压用 drain 等
        const out = fs.createWriteStream(dest, { flags: 'a' });
        let got = have;
        let lastLog = 0;
        try {
          for await (const c of r.body) {
            got += c.length;
            if (!out.write(Buffer.from(c))) await new Promise((r2) => out.once('drain', r2));
            const now = Date.now();
            if (now - lastLog > 3000) { lastLog = now; onProgress?.(got, total); }
          }
          await new Promise((r2, r3) => out.end((e) => (e ? r3(e) : r2())));
          if (got >= total) { onProgress?.(got, total); resolve(); }
          else { addLog(`  连接中断（${got}/${total}），续传重试…`); reject(new Error('incomplete')); }
        } catch (e2) {
          out.destroy();
          throw e2;
        }
      } catch (e) {
        if (attempt >= maxRetry) return reject(new Error(`${path.basename(dest)} 下载失败：${e.message}`));
        addLog(`  第 ${attempt} 次尝试失败（${e.message.slice(0, 90)}），5 秒后断点续传…`);
        await sleep(5000);
      }
    }
  });
}

// 可执行性冒烟测试：只看能否启动（ENOEXEC/缺动态库走 error 事件），退出码不要求 0；
// 但被信号杀死（SIGILL=指令集不兼容/SIGSEGV）算失败——这正是坏二进制的症状。
// 静态 musl 二进制理论上任何 Linux 都能跑，这一步是兜底可见性（坏包早失败早发现）。
function execCheck(bin) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; clearTimeout(timer); fn(arg); } };
    const p = spawn(bin, ['--help']);
    const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } done(resolve); }, 5000);
    p.on('error', (e) => done(reject, new Error('引擎二进制无法执行（' + e.message + '）——请把此日志反馈给管理员')));
    p.on('exit', (code, sig) => {
      if (sig && sig !== 'SIGTERM') done(reject, new Error(`引擎二进制启动即崩溃（${sig}，常见原因：CPU 指令集不兼容）——请把此日志反馈给管理员`));
      else done(resolve);
    });
  });
}

// ---------- Linux：无预编译产物时现场编译（apt + codeload 源码，约 10~20 分钟） ----------
// 仅在升级包没随附 Linux 二进制（vibeasr/linux-x64/，zig 静态 musl 交叉编译产物）时走。
async function buildLinuxEngine(binDir) {
  const src = path.join(paths.DATA_VIBEASR, 'src');
  const urls = [
    'https://gh-proxy.com/https://codeload.github.com/microsoft/VibeASR.cpp/tar.gz/refs/heads/main',
    'https://codeload.github.com/microsoft/VibeASR.cpp/tar.gz/refs/heads/main',
  ];
  await run('apt-get', ['update'], { timeoutMin: 10, root: true });
  await run('apt-get', ['install', '-y', '--no-install-recommends', 'build-essential', 'cmake', 'ninja-build', 'ca-certificates'], { timeoutMin: 20, root: true });
  fs.rmSync(src, { recursive: true, force: true });
  fs.mkdirSync(src, { recursive: true });
  let ok = false;
  for (const u of urls) {
    try { await downloadResumable(u, path.join(paths.DATA_VIBEASR, 'dl-src.tgz'), null); ok = true; break; }
    catch (e) { addLog('源码下载失败，换源：' + e.message.slice(0, 80)); }
  }
  if (!ok) throw new Error('VibeASR.cpp 源码下载失败（所有源）');
  await run('tar', ['xzf', path.join(paths.DATA_VIBEASR, 'dl-src.tgz'), '-C', src, '--strip-components=1'], { timeoutMin: 5 });
  // 子模块 3rdparty/llama.cpp（固定 commit）同样走 codeload
  const sub = path.join(src, '3rdparty', 'llama.cpp');
  fs.mkdirSync(sub, { recursive: true });
  const llamaUrls = [
    'https://gh-proxy.com/https://codeload.github.com/ggml-org/llama.cpp/tar.gz/a2fdadc20285df2dce90402fca9264a93a8eb32f',
    'https://codeload.github.com/ggml-org/llama.cpp/tar.gz/a2fdadc20285df2dce90402fca9264a93a8eb32f',
  ];
  ok = false;
  for (const u of llamaUrls) {
    try { await downloadResumable(u, path.join(paths.DATA_VIBEASR, 'dl-llama.tgz'), null); ok = true; break; }
    catch (e) { addLog('llama.cpp 下载失败，换源：' + e.message.slice(0, 80)); }
  }
  if (!ok) throw new Error('llama.cpp 子模块下载失败（所有源）');
  await run('tar', ['xzf', path.join(paths.DATA_VIBEASR, 'dl-llama.tgz'), '-C', sub, '--strip-components=1'], { timeoutMin: 5 });
  addLog('开始编译 asr_stream_server（10~20 分钟，请耐心）…');
  await run('cmake', ['-B', 'build', '-G', 'Ninja', '-DCMAKE_BUILD_TYPE=Release'], { cwd: src, timeoutMin: 10 });
  await run('cmake', ['--build', 'build', '--target', 'asr_stream_server'], { cwd: src, timeoutMin: 40 });
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(path.join(src, 'build', 'bin', 'asr_stream_server'), path.join(binDir, 'asr_stream_server'));
  fs.chmodSync(path.join(binDir, 'asr_stream_server'), 0o755);
}

// 子进程执行（root=true 时 Linux 下加 sudo —— Docker 里通常已是 root，不加重试直接跑）
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const push = (b) => { const s = b.toString(); out += s; addLog(s); };
    p.stdout.on('data', push);
    p.stderr.on('data', push);
    const timer = setTimeout(() => { try { p.kill(); } catch { /* ignore */ } reject(new Error(`命令超时（${opts.timeoutMin || 20} 分钟）：${cmd}`)); }, (opts.timeoutMin || 20) * 60 * 1000);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('exit', (code) => { clearTimeout(timer); code === 0 ? resolve(out) : reject(new Error(`${path.basename(cmd)} 退出码 ${code}：${out.slice(-300)}`)); });
  });
}

// ---------- 安装流程 ----------
async function install(opts = {}) {
  const target = paths.DATA_VIBEASR;
  state.running = true; state.done = false; state.error = '';
  state.stepIndex = 0; state.progress = 0; state.log = [];
  state.startedAt = new Date().toISOString(); state.finishedAt = null;
  addLog(`安装目标：${target}（${process.platform}-${process.arch}）`);
  try {
    // ① 准备目录
    for (const d of [target, paths.BIN_DIR, paths.MODELS_DIR]) fs.mkdirSync(d, { recursive: true });
    setStepProgress(1);

    // ② 引擎二进制
    state.stepIndex = 1;
    const destBin = paths.BIN;
    if (fs.existsSync(destBin)) {
      addLog('引擎程序已存在，跳过（升级包随附的新版本在重装时才覆盖）');
    } else if (process.platform === 'win32') {
      if (!fs.existsSync(paths.SHIPPED_BIN)) {
        throw new Error('升级包未随附 Windows 引擎二进制（vibeasr/win-x64/asr_stream_server.exe）。请重新下载完整升级包，或在服务器本机按模型下载说明里的 VibeASR.cpp 自行编译。');
      }
      // 整目录拷贝（exe + mingw 运行时 DLL 一起带走）
      fs.cpSync(paths.SHIPPED_BIN_DIR, paths.BIN_DIR, { recursive: true });
      addLog('引擎程序已从升级包部署：' + destBin);
    } else if (fs.existsSync(paths.SHIPPED_BIN)) {
      // Linux：优先用升级包随附的静态二进制（zig musl 交叉编译，无 glibc/发行版依赖）。
      // 不走 apt 现场编译：生产 NAS 拉 Debian 源极慢，实测 apt-get update 10 分钟超时挂掉。
      fs.cpSync(paths.SHIPPED_BIN_DIR, paths.BIN_DIR, { recursive: true });
      for (const f of fs.readdirSync(paths.BIN_DIR)) {
        if (/\.(exe|dll)$/i.test(f)) continue; // win-x64 内容混入时不可执行，跳过
        try { fs.chmodSync(path.join(paths.BIN_DIR, f), 0o755); } catch { /* 尽力 */ }
      }
      addLog('引擎程序已从升级包部署（Linux 静态版）：' + destBin);
      await execCheck(destBin);
    } else {
      addLog('Linux 无预编译产物，现场编译（需要外网，约 10~20 分钟）…');
      await buildLinuxEngine(paths.BIN_DIR);
    }
    setStepProgress(1);

    // ③ 模型（hf-mirror 断点续传；两个文件分开计进度）
    state.stepIndex = 2;
    const models = [
      { name: paths.MODEL_FILES.vae, dest: paths.VAE, weight: 0.42 },
      { name: paths.MODEL_FILES.lm, dest: paths.LM, weight: 0.58 },
    ];
    for (const m of models) {
      // 只认“基本完整”的文件（两文件均为 700MB+）：失败尝试可能留下 0 字节/残缺文件，盲跳过会让引擎加载即崩
      const have = fs.existsSync(m.dest) ? fs.statSync(m.dest).size : 0;
      if (have > 600 * 1024 * 1024) {
        addLog(`${m.name} 已存在（${(have / 1024 / 1024).toFixed(0)}MB），跳过`);
        setStepProgress(m.weight); continue;
      }
      if (have > 0) addLog(`${m.name} 本地仅 ${(have / 1024 / 1024).toFixed(1)}MB（不完整），断点续传…`);
      addLog(`下载 ${m.name}（hf-mirror 国内镜像）…`);
      await downloadResumable(paths.MODEL_URL_BASE + m.name, m.dest, (got, total) => {
        state.progress = Math.min(99, Math.round(((stepBase(2) + (models.slice(0, models.indexOf(m)).reduce((s, x) => s + x.weight, 0) + m.weight * (got / total)) * STEP_DEFS[2].weight) / TOTAL_W) * 100));
      });
      addLog(`${m.name} 下载完成（${(fs.statSync(m.dest).size / 1024 / 1024).toFixed(0)}MB）`);
    }
    setStepProgress(1);

    // ④ 部署：记录版本 + 直接启动常驻服务（无需重启进程）
    state.stepIndex = 3;
    setSetting('vibe_engine_installed', { at: new Date().toISOString(), target, by: opts.by || '' });
    const r = service.start();
    if (!r.ok && !r.already) throw new Error('服务启动失败：' + (r.error || ''));
    addLog('安装完成，转写服务已启动（引擎首次加载约 30~90 秒）');
    state.progress = 100; state.done = true; state.finishedAt = new Date().toISOString();
  } catch (e) {
    state.error = e.message;
    state.finishedAt = new Date().toISOString();
    addLog('安装失败：' + e.message);
  } finally {
    state.running = false;
  }
}

function start(opts = {}) {
  if (state.running) return { ok: true, already: true };
  install(opts).catch((e) => { state.error = e.message; state.running = false; });
  return { ok: true };
}

// 清除失败状态（页面「取消安装」按钮）：只在非运行中允许——
// 安装失败后进度条+日志会一直挂在页面上，重装前用户可一键收起回到初始态
function reset() {
  if (state.running) return { ok: false, error: '安装正在进行中，不能取消' };
  state.done = false;
  state.stepIndex = -1;
  state.progress = 0;
  state.error = '';
  state.startedAt = null;
  state.finishedAt = null;
  state.log = [];
  return { ok: true };
}

module.exports = { start, status, reset };
