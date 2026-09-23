// VibeASR BitNet 引擎服务：常驻 Node sidecar（server/vibeasr/server.js），
// sidecar 再持有 asr_stream_server 引擎进程——模型只加载一次，之后每条转写请求走内存引擎。
// 对 vibeRoutes 暴露 OpenAI 兼容地址 http://127.0.0.1:<port>，与 vLLM 7B 服务同合约。
// 崩溃自愈：sidecar 意外退出后 10s 自动拉起；引擎意外退出由 sidecar 自己负责重启。
const { spawn } = require('child_process');
const fs = require('fs');
const paths = require('./vibeasrPaths');

const state = {
  child: null,          // sidecar 子进程
  running: false,       // sidecar 进程存活
  ready: false,         // sidecar HTTP 可用（引擎 ---READY---）
  startedAt: null,
  lastError: '',
  restarts: 0,
};
let fastCrashes = 0;    // 连续快速崩溃计数（15s 内退出；≥3 次转 5 分钟退避重试）

function status() {
  return {
    installed: paths.engineReady(),
    running: state.running,
    ready: state.ready,
    pid: state.child ? state.child.pid : null,
    startedAt: state.startedAt,
    lastError: state.lastError,
    restarts: state.restarts,
    port: paths.PORT,
    bin: paths.BIN,
    url: `http://127.0.0.1:${paths.PORT}`,
  };
}

// sidecar 健康探测（引擎加载需数十秒，ready 才表示可转写）
async function health(timeoutMs = 4000) {
  try {
    const r = await fetch(`http://127.0.0.1:${paths.PORT}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    const d = await r.json().catch(() => ({}));
    state.ready = !!d.ready;
    return d;
  } catch (e) {
    state.ready = false;
    return { ok: false, error: e.message };
  }
}

function start() {
  if (!paths.engineReady()) { state.lastError = '引擎未安装（缺二进制或模型）'; return { ok: false, error: state.lastError }; }
  if (state.child && state.child.exitCode === null) return { ok: true, already: true };
  try {
    const child = spawn(process.execPath, [
      paths.SIDECAR,
      '--bin', paths.BIN,
      '--vae', paths.VAE,
      '--lm', paths.LM,
      '--port', String(paths.PORT),
      '--host', '127.0.0.1', // 只监听本机（工作台服务端转发；不直接暴露给局域网）
      '--threads', String(paths.THREADS),
    ], { detached: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    state.child = child;
    state.running = true;
    state.startedAt = new Date().toISOString();
    state.lastError = '';
    const onOut = (b) => {
      for (const line of String(b).split('\n')) {
        const t = line.trim();
        if (!t) continue;
        if (/引擎就绪/.test(t)) state.ready = true;
        else if (/引擎进程退出|转写失败|listen EACCES|EADDRINUSE/.test(t)) state.lastError = t.slice(0, 200);
        console.log('[vibeasr]', t.slice(0, 300));
      }
    };
    child.stdout.on('data', onOut);
    child.stderr.on('data', onOut);
    const spawnAt = Date.now();
    child.on('exit', (code) => {
      state.running = false; state.ready = false;
      state.child = null;
      // 意外退出（非 stop() 主动停）→ 10s 后自愈拉起；主动停止标记 code=null 由 stop() 设置。
      // 连续快速崩溃（秒级退出=根本起不来，如端口被占 EACCES/EADDRINUSE）→ 退避到 5 分钟一次，避免无限刷屏
      if (code !== null && !stopping) {
        state.restarts += 1;
        fastCrashes = Date.now() - spawnAt < 15_000 ? fastCrashes + 1 : 0;
        const delay = fastCrashes >= 3 ? 300_000 : 10_000;
        state.lastError = `sidecar 退出 code=${code}，${Math.round(delay / 1000)} 秒后自动重启`
          + (fastCrashes >= 3 ? '（连续快速崩溃，疑似端口被占等环境问题，已降频重试）' : '');
        setTimeout(() => { if (!stopping) start(); }, delay).unref?.();
      }
    });
    return { ok: true };
  } catch (e) {
    state.lastError = e.message;
    return { ok: false, error: e.message };
  }
}

let stopping = false;
function stop() {
  stopping = true;
  try { state.child?.kill(); } catch { /* ignore */ }
  state.child = null; state.running = false; state.ready = false;
  setTimeout(() => { stopping = false; }, 2000).unref?.();
  return { ok: true };
}

// 转写前确保就绪：sidecar 不在 → 拉起；在但引擎未 ready → 轮询等待（最长 120s）
async function ensureReady(waitMs = 120_000) {
  const started = start();
  if (!started.ok && !started.already) throw new Error(started.error || '引擎启动失败');
  const t0 = Date.now();
  for (;;) {
    const h = await health(3000);
    if (h.ready) return true;
    if (!state.running && !state.child) throw new Error(state.lastError || 'sidecar 未存活');
    if (Date.now() - t0 > waitMs) throw new Error('引擎加载超时（模型大，首次加载需 30~90 秒）');
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// 进程启动时：引擎已装好则自动拉起（Docker restart / 服务重启后无需人工干预）
if (paths.engineReady()) {
  setTimeout(() => start(), 3000).unref?.();
}

module.exports = { status, health, start, stop, ensureReady };
