// TTS 引擎一键安装器：把 MOSS-TTS-Nano 运行环境自动装进持久目录（Docker 为 /data/tts）。
// 流程：Miniconda 静默安装（Python 3.x + pip）→ pip 装依赖（清华镜像，torch 优先 CPU 源）→
//       获取 MOSS-TTS-Nano 仓库（优先升级包随附的副本，否则 GitHub 加速镜像下载）→ 部署 moss_server.py。
// 全程零手工 SSH：管理员在「语音配音」页点一键安装，前端轮询 /tts/engine/status 看进度。
// 网络策略刻意避开 GitHub（国内直连被污染、公共加速镜像限流不稳）：
//   Python 走 Miniconda（清华等高校镜像），依赖走 PyPI 镜像，模型走 hf-mirror（引擎侧）。
// 可用环境变量覆盖：TTS_PYPI_INDEX / TTS_CONDA_MIRROR / TTS_REPO_ZIP_URL / GH_MIRRORS
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { db, setSetting } = require('../db');
const { extractZip } = require('./zipService');
const { DATA_TTS, PROJECT_TTS, SERVER } = require('./ttsPaths');

// GitHub 资产仅在「仓库 zip 兜底下载」时使用（首选升级包随附副本，通常用不到）
const GH_MIRRORS = (process.env.GH_MIRRORS || 'https://ghproxy.net/https://github.com,https://gh-proxy.com/https://github.com')
  .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
function ghUrls(repoPath) {
  return [...GH_MIRRORS.map((m) => `${m}/${repoPath}`), 'https://github.com/' + repoPath];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 依赖清单：与本地已验证环境一致（onnx_tts_runtime 顶层 import torch/torchaudio，绕不开；
// WeTextProcessing 刻意不装——Windows 需编译且引擎已固定 enable_wetext=False）
const TORCH_PKGS = ['torch==2.7.0', 'torchaudio==2.7.0'];
const OTHER_PKGS = ['numpy', 'fastapi', 'uvicorn', 'python-multipart', 'sentencepiece', 'soundfile', 'onnxruntime', 'huggingface_hub'];
const PYPI_MIRROR = process.env.TTS_PYPI_INDEX || 'https://pypi.tuna.tsinghua.edu.cn/simple';
const PYPI_OFFICIAL = 'https://pypi.org/simple';
const TORCH_CPU_INDEX = 'https://download.pytorch.org/whl/cpu'; // Linux 默认轮子捆绑 CUDA（数 GB），CPU 源优先
const CONDA_MIRRORS = [process.env.TTS_CONDA_MIRROR, 'https://mirrors.tuna.tsinghua.edu.cn/anaconda/miniconda',
  'https://mirrors.bfsu.edu.cn/anaconda/miniconda', 'https://mirrors.ustc.edu.cn/anaconda/miniconda'].filter(Boolean);
const REPO_ZIP_PATH = 'OpenMOSS/MOSS-TTS-Nano/archive/refs/heads/main.zip';

const STEP_DEFS = [
  { key: 'prepare', label: '准备安装目录', weight: 4 },
  { key: 'python', label: '下载并安装 Python 环境（Miniconda）', weight: 26 },
  { key: 'deps', label: '安装依赖（torch / onnxruntime，体积较大）', weight: 48 },
  { key: 'repo', label: '获取 MOSS-TTS-Nano 仓库', weight: 18 },
  { key: 'deploy', label: '部署合成服务', weight: 4 },
];

// 安装状态（进程内存即可：容器重启 = 安装中断重来，各步骤幂等可续）
const state = {
  running: false, done: false, restarting: false,
  stepIndex: -1, progress: 0,
  error: '', startedAt: null, finishedAt: null,
  log: [],
};
function addLog(line) {
  const clean = String(line).split('\r').pop().replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').slice(0, 300);
  if (!clean.trim()) return;
  state.log.push(clean);
  if (state.log.length > 400) state.log.splice(0, state.log.length - 400);
}
function stepBase(i) { // 前 i 步的累计权重 → 百分比基线
  return STEP_DEFS.slice(0, i).reduce((s, d) => s + d.weight, 0);
}
const TOTAL_W = STEP_DEFS.reduce((s, d) => s + d.weight, 0);
function setStepProgress(frac) { // 当前步骤内进度 0~1 → 全局百分比
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

// ---------- 基础工具 ----------
async function download(url, dest, onBytes) {
  // 单源 5 分钟拿不下就换下一个（防被污染的直连挂死整个安装）
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(5 * 60 * 1000) });
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}：${url}`);
  const total = Number(r.headers.get('content-length')) || 0;
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 1024) throw new Error(`下载内容异常（${buf.length}B）：${url}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  if (onBytes) onBytes(buf.length, total || buf.length);
  return buf;
}

// 按候选顺序尝试下载（两轮，第二轮隔 15 秒——公共镜像偶发抖动），全部失败才抛错
async function downloadFirst(urls, dest, onBytes) {
  const errs = [];
  for (let round = 1; round <= 2; round++) {
    for (const u of urls) {
      try {
        addLog('下载：' + u);
        const buf = await download(u, dest, onBytes);
        return buf;
      } catch (e) { errs.push(`${u.slice(0, 90)} → ${e.message.slice(0, 80)}`); addLog('  失败，换下一个源：' + e.message.slice(0, 80)); }
    }
    if (round === 1 && urls.length) { addLog('第一轮全部失败，15 秒后重试一轮…'); await sleep(15000); }
  }
  throw new Error('所有下载源均失败：\n' + errs.slice(-4).join('\n'));
}

// 最小 tar.gz 解包器（512 字节头 + 八进制尺寸，ustar/GNU 常规格式足够）；
// Linux 下按 tar mode 位保留可执行权限
function extractTarGz(buf, destDir, strip = 1) {
  const tar = zlib.gunzipSync(buf);
  let off = 0;
  const files = [];
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break; // 连续空块 = 归档结束
    const name = h.toString('utf8', 0, 100).replace(/\0.*$/, '');
    const prefix = h.toString('utf8', 345, 500).replace(/\0.*$/, '');
    const size = parseInt(h.toString('utf8', 124, 136).replace(/[\0 ]/g, ''), 8) || 0;
    const mode = parseInt(h.toString('utf8', 100, 108).replace(/[\0 ]/g, ''), 8) || 0;
    const type = String.fromCharCode(h[156] || 48);
    off += 512;
    const full = (prefix ? prefix + '/' : '') + name;
    if (full && type !== '5' && !full.includes('pax_global_header')) { // 跳过目录头与全局头
      const parts = full.split('/').filter(Boolean).slice(strip);
      if (parts.length) {
        const dest = path.join(destDir, ...parts);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, tar.subarray(off, off + size));
        if (process.platform !== 'win32' && (mode & 0o111)) fs.chmodSync(dest, 0o755);
        files.push(dest);
      }
    }
    off += Math.ceil(size / 512) * 512;
  }
  if (!files.length) throw new Error('tar 包解析不到任何文件');
  return files;
}

// 子进程执行：输出逐行进安装日志；超时强杀
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts.spawn });
    let out = '';
    const push = (b) => { const s = b.toString(); out += s; addLog(s); };
    p.stdout.on('data', push);
    p.stderr.on('data', push);
    const timer = setTimeout(() => { try { p.kill(); } catch { /* 已退出 */ } reject(new Error(`命令超时（${opts.timeoutMin || 20} 分钟）：${cmd}`)); }, (opts.timeoutMin || 20) * 60 * 1000);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(cmd)} 退出码 ${code}：${out.slice(-400)}`));
    });
  });
}

// ---------- 安装流程 ----------
// 解释器位置：Windows Miniconda 为 <root>/python.exe，Linux 为 <root>/bin/python
function findPyAt(root) {
  return ['python.exe', path.join('bin', 'python')].map((p) => path.join(root, p)).find((p) => fs.existsSync(p));
}

async function install(opts = {}) {
  // 安装目标：持久卷（Docker 的 /data/tts）。TTS_INSTALL_DIR 仅供安装流程测试覆盖，
  // 生产不要设置（服务通过 ttsPaths 在重启后自动发现 data/tts 里的引擎）
  const target = process.env.TTS_INSTALL_DIR || DATA_TTS;
  const pyRoot = path.join(target, 'py');

  state.running = true; state.done = false; state.error = ''; state.restarting = false;
  state.stepIndex = 0; state.progress = 0; state.log = [];
  state.startedAt = new Date().toISOString(); state.finishedAt = null;
  addLog(`安装目标：${target}（${process.platform}-${process.arch}）`);
  try {
    // ① 准备目录
    for (const d of [target, path.join(target, 'voices'), path.join(target, 'cache'), path.join(target, 'tmp')]) fs.mkdirSync(d, { recursive: true });
    setStepProgress(1);

    // ② Python：Miniconda 静默安装（自带 pip；全部走国内镜像，不碰 GitHub）。
    //    刻意选内嵌 Python 3.12 的版本化安装包：latest 自带 3.13，而依赖链钉死的
    //    torch 2.7.0 只有 cp312 及以下轮子（文件名 py312 = 解释器版本，26.7.1-1 = 构建）
    state.stepIndex = 1;
    let py = findPyAt(pyRoot);
    if (py) { addLog('Python 环境已存在，跳过：' + py); }
    else {
      const pa = process.platform, ar = process.arch;
      let file = process.env.TTS_MINICONDA_FILE;
      if (!file) {
        if (pa === 'win32' && ar === 'x64') file = 'Miniconda3-py312_26.7.1-1-Windows-x86_64.exe';
        else if (pa === 'linux' && ar === 'x64') file = 'Miniconda3-py312_26.7.1-1-Linux-x86_64.sh';
        else if (pa === 'linux' && ar === 'arm64') file = 'Miniconda3-py312_26.7.1-1-Linux-aarch64.sh';
        else throw new Error(`不支持的系统：${pa}-${ar}（支持 Windows x64 与 Linux x64/arm64）`);
      }
      const installer = path.join(target, 'dl-miniconda' + (pa === 'win32' ? '.exe' : '.sh'));
      await downloadFirst(CONDA_MIRRORS.map((m) => `${m}/${file}`), installer, (got, total) => setStepProgress(0.7 * (got / total)));
      addLog('静默安装 Miniconda（约 1~2 分钟）…');
      if (pa === 'win32') {
        // NSIS 静默参数：/D 必须放最后且不带引号
        await run(installer, ['/S', '/InstallationType=JustMe', '/RegisterPython=0', '/AddToPath=0', '/D=' + pyRoot], { timeoutMin: 15 });
      } else {
        await run('bash', [installer, '-b', '-p', pyRoot], { timeoutMin: 15 });
      }
      fs.unlinkSync(installer);
      py = findPyAt(pyRoot);
      if (!py) throw new Error('Miniconda 安装后找不到 python 解释器');
      setStepProgress(1);
    }

    // ③ Python 依赖：源顺序按平台优化——Windows 的 PyPI 轮子本就只含 CPU（且国内镜像快），
    //    镜像优先省得等 CPU 专用源超时；Linux 默认轮子捆绑 CUDA（数 GB）必须 CPU 源优先
    state.stepIndex = 2;
    const pip = (pkgs, index) => run(py, ['-m', 'pip', 'install', '--no-warn-script-location', '--disable-pip-version-check',
      '--index-url', index, ...pkgs], { spawn: { env: { ...process.env, PIP_ROOT_USER_ACTION: 'ignore' } } });
    const torchOrder = process.platform === 'win32' ? [PYPI_MIRROR, TORCH_CPU_INDEX] : [TORCH_CPU_INDEX, PYPI_MIRROR];
    try { addLog(`安装 torch/torchaudio（${torchOrder[0] === TORCH_CPU_INDEX ? 'CPU 专用源' : '镜像'}）…`); await pip(TORCH_PKGS, torchOrder[0]); }
    catch (e1) {
      addLog('首选源失败，改用备用源重试：' + e1.message.slice(0, 120));
      await pip(TORCH_PKGS, torchOrder[1]);
    }
    try { addLog('安装其余依赖（镜像）…'); await pip(OTHER_PKGS, PYPI_MIRROR); }
    catch (e2) {
      addLog('镜像失败，改用官方 PyPI 重试：' + e2.message.slice(0, 120));
      await pip(OTHER_PKGS, PYPI_OFFICIAL);
    }
    setStepProgress(1);

    // ④ MOSS-TTS-Nano 仓库：优先用升级包随附副本（零外网依赖），没有才走 GitHub 加速镜像
    state.stepIndex = 3;
    const repo = path.join(target, 'MOSS-TTS-Nano');
    if (fs.existsSync(path.join(repo, 'onnx_tts_runtime.py'))) {
      addLog('仓库已存在，跳过（模型与缓存不受影响）');
    } else {
      const shipped = path.join(PROJECT_TTS, 'MOSS-TTS-Nano');
      if (fs.existsSync(path.join(shipped, 'onnx_tts_runtime.py'))) {
        addLog('使用升级包随附的仓库副本：' + shipped);
        fs.cpSync(shipped, repo, { recursive: true });
      } else {
        const urls = process.env.TTS_REPO_ZIP_URL ? [process.env.TTS_REPO_ZIP_URL] : ghUrls(REPO_ZIP_PATH);
        const buf = await downloadFirst(urls, path.join(target, 'dl-repo.zip'), (got, total) => setStepProgress(0.5 + 0.5 * (got / total)));
        const entries = extractZip(buf).filter((e) => e.name.startsWith('MOSS-TTS-Nano-main/'));
        if (!entries.length) throw new Error('仓库压缩包内容不符合预期');
        for (const e of entries) {
          const rel = e.name.slice('MOSS-TTS-Nano-main/'.length);
          if (!rel || rel.endsWith('/')) continue;
          const dest = path.join(repo, ...rel.split('/'));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, e.data);
        }
        fs.unlinkSync(path.join(target, 'dl-repo.zip'));
      }
      if (!fs.existsSync(path.join(repo, 'onnx_tts_runtime.py'))) throw new Error('仓库文件不完整（缺 onnx_tts_runtime.py）');
    }
    setStepProgress(1);

    // ⑤ 部署 sidecar 入口 + 记录版本
    state.stepIndex = 4;
    fs.copyFileSync(SERVER, path.join(target, 'moss_server.py'));
    setSetting(db, 'tts_engine_installed', { at: new Date().toISOString(), target, by: opts.by || '' });
    state.progress = 100; state.done = true; state.finishedAt = new Date().toISOString();
    addLog('安装完成。');
    // 默认自动重启进程让服务加载新引擎（Docker restart:always 会自动拉起；测试可传 restart:false）
    if (opts.restart !== false) {
      state.restarting = true;
      addLog('服务将在数秒后自动重启以加载引擎…');
      setTimeout(() => process.exit(0), 4000).unref();
    }
  } catch (e) {
    state.error = e.message;
    state.finishedAt = new Date().toISOString();
    addLog('安装失败：' + e.message);
    console.error('[tts-installer] 安装失败：', e.message);
  } finally {
    state.running = false;
  }
}

// API 入口：并发点击只跑一次；已在跑直接返回现状
function start(opts = {}) {
  if (state.running) return { ok: true, already: true };
  install(opts).catch((e) => { state.error = e.message; state.running = false; }); // install 自带 try/catch，这里兜底
  return { ok: true };
}

module.exports = { start, status, install };
