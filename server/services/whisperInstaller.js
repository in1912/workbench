// Whisper 引擎一键安装器：把 whisper.cpp 引擎装进持久目录（Docker 为 /data/whisper）。
// 流程：准备目录 → 引擎二进制（升级包随附：win-x64 MinGW / linux-x64 zig musl 静态）
//      → 下载 1 个 ggml 模型（large-v3-turbo q8_0 约 834MB，hf-mirror 断点续传）→ 启动常驻服务。
// 管理员在「录音转写」页点一键安装，前端轮询 /vibe/engine/status 看进度与日志。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { setSetting } = require('../db');
const paths = require('./whisperPaths');
const service = require('./whisperService');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STEP_DEFS = [
  { key: 'prepare', label: '准备安装目录', weight: 2 },
  { key: 'engine', label: '安装引擎程序', weight: 8 },
  { key: 'models', label: '下载语音模型（large-v3-turbo q8_0，约 834MB，断点续传）', weight: 88 },
  { key: 'deploy', label: '启动转写服务', weight: 2 },
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
  console.log('[whisper-install]', clean);
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

// ---------- 断点续传下载（fs.createWriteStream append + Range；与 vibeasrInstaller 同实现） ----------
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
        let total = have + Number(r.headers.get('content-length')) || 0;
        const cr = String(r.headers.get('content-range') || '').match(/\/(\d+)$/);
        if (cr) total = Number(cr[1]);
        if (!total || total < 1024) throw new Error('响应无有效长度');
        if (have >= total) { onProgress?.(total, total); return resolve(); }
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

// 可执行性冒烟测试：被信号杀死（SIGILL=指令集不兼容/SIGSEGV）=失败——坏二进制的症状。
// Linux 产物是 SSE3/SSSE3 基线的 musl 静态二进制（与 VibeASR 同配方，NAS Celeron 安全）。
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

// ---------- 安装流程 ----------
async function install(opts = {}) {
  const target = paths.DATA_WHISPER;
  state.running = true; state.done = false; state.error = '';
  state.stepIndex = 0; state.progress = 0; state.log = [];
  state.startedAt = new Date().toISOString(); state.finishedAt = null;
  addLog(`安装目标：${target}（${process.platform}-${process.arch}）`);
  try {
    // ① 准备目录
    for (const d of [target, paths.BIN_DIR, paths.MODELS_DIR]) fs.mkdirSync(d, { recursive: true });
    setStepProgress(1);

    // ② 引擎二进制（升级包随附；win=MinGW 静态单文件，linux=zig musl 静态）
    state.stepIndex = 1;
    const destBin = paths.BIN;
    if (fs.existsSync(destBin)) {
      addLog('引擎程序已存在，跳过（升级包随附的新版本在重装时才覆盖）');
    } else if (!fs.existsSync(paths.SHIPPED_BIN)) {
      throw new Error(`升级包未随附本平台引擎二进制（${path.relative(path.join(__dirname, '..', '..'), paths.SHIPPED_BIN)}）。请更新到最新版升级包。`);
    } else {
      fs.mkdirSync(paths.BIN_DIR, { recursive: true });
      fs.copyFileSync(paths.SHIPPED_BIN, destBin);
      if (process.platform !== 'win32') {
        fs.chmodSync(destBin, 0o755);
        await execCheck(destBin);
      }
      addLog('引擎程序已从升级包部署：' + destBin);
    }
    setStepProgress(1);

    // ③ 模型（hf-mirror 断点续传；只认“基本完整”的文件，残缺文件续传）
    state.stepIndex = 2;
    const have = fs.existsSync(paths.MODEL) ? fs.statSync(paths.MODEL).size : 0;
    if (have > 700 * 1024 * 1024) {
      addLog(`${paths.MODEL_FILE} 已存在（${(have / 1024 / 1024).toFixed(0)}MB），跳过`);
    } else {
      if (have > 0) addLog(`${paths.MODEL_FILE} 本地仅 ${(have / 1024 / 1024).toFixed(1)}MB（不完整），断点续传…`);
      addLog(`下载 ${paths.MODEL_FILE}（hf-mirror 国内镜像）…`);
      await downloadResumable(paths.MODEL_URL, paths.MODEL, (got, total) => {
        setStepProgress(got / total);
      });
      addLog(`${paths.MODEL_FILE} 下载完成（${(fs.statSync(paths.MODEL).size / 1024 / 1024).toFixed(0)}MB）`);
    }
    setStepProgress(1);

    // ④ 部署：记录版本 + 直接启动常驻服务（无需重启进程）
    state.stepIndex = 3;
    setSetting('whisper_engine_installed', { at: new Date().toISOString(), target, by: opts.by || '' });
    const r = service.start(opts.lang);
    if (!r.ok && !r.already) throw new Error('服务启动失败：' + (r.error || ''));
    addLog('安装完成，转写服务已启动');
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
