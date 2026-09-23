// 智作平台（文案库）子服务（v1.6.2）：随工作台进程启动，作为效率工具→智作平台 tab 的载体。
// 形态：工作台 spawn 一个子进程跑 zhizu/server/index.js（Node，仅依赖 express，复用工作台 node_modules），
// 监听内部 127.0.0.1 端口（默认 9608）；对外一切流量走工作台同源路径 /zhizu/* 反向代理（剥前缀转发），
// 用户不需要知道、也访问不到额外端口。前端以 iframe 嵌入 /zhizu/，文案库自带登录/角色体系原样保留。
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const DIR = process.env.ZHIZU_DIR || path.join(ROOT, 'zhizu');
const ENTRY = path.join(DIR, 'server', 'index.js');
const PORT = Number(process.env.ZHIZU_PORT || 9608);

let child = null;
let stopping = false;
let fails = 0; // 连续退出次数（>5 次不再拉起，防崩溃循环）

// 探测内部端口是否已有「新版」智作平台在跑（响应的 HTML 必须带 /zhizu/ 资源前缀，
// 旧版独立部署没有 /zhizu 挂载，误复用会导致资源 404）
function probe() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/zhizu/', timeout: 2500 }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve(res.statusCode === 200 && buf.includes('/zhizu/')));
      res.on('error', () => resolve(false));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function spawnChild() {
  // 子进程继承工作台环境；DATA_DIR 命名空间化：容器内 /data 卷 → /data/zhizu（随卷持久化），
  // 本地未设 DATA_DIR 时子服务用自己默认的 zhizu/data（不入升级包、不进生产）
  const env = { ...process.env, PORT: String(PORT), ZHIZU_HOST: '127.0.0.1' }; // 仅本机回环：子服务不对外开口，一切流量走 /zhizu 代理
  if (process.env.DATA_DIR) env.DATA_DIR = path.join(process.env.DATA_DIR, 'zhizu');
  child = spawn(process.execPath, [ENTRY], {
    cwd: DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const tag = (b) => String(b).split('\n').filter(Boolean).map((l) => console.log('[zhizu] ' + l)).join('');
  child.stdout.on('data', tag);
  child.stderr.on('data', tag);
  // 跑稳 60 秒视为一次成功启动，清零失败计数
  const okTimer = setTimeout(() => { fails = 0; }, 60000);
  okTimer.unref?.();
  child.on('exit', (code) => {
    clearTimeout(okTimer);
    child = null;
    if (stopping) return;
    fails++;
    if (fails > 5) return console.error(`[zhizu] 子进程连续退出 ${fails} 次，已停止自动拉起（重启工作台可重试）`);
    console.log(`[zhizu] 子进程退出（code=${code}），5 秒后自动重启`);
    setTimeout(spawnChild, 5000).unref?.();
  });
  console.log(`[zhizu] 智作平台已随工作台启动（内部 127.0.0.1:${PORT}，对外路径 /zhizu）`);
}

async function start() {
  if (!fs.existsSync(ENTRY)) return console.log('[zhizu] 未找到 zhizu/ 目录（智作平台未随包部署），跳过');
  if (await probe()) return console.log(`[zhizu] 检测到 127.0.0.1:${PORT} 已有智作平台在运行，直接复用`);
  spawnChild();
}

// 反向代理中间件：挂在 /zhizu（Express 已剥掉挂载前缀，req.url 是剩余路径，如 '/'、'/api/x'、'/assets/y.js'）。
// 子服务的静态资源挂在 /zhizu、API 在根 /api，两条路径按下表还原成子进程视角的完整路径：
//   /zhizu/            → req.url '/'           → 子进程 '/zhizu/'   （静态首页）
//   /zhizu/assets/x.js → req.url '/assets/x.js' → 子进程 '/zhizu/assets/x.js'
//   /zhizu/api/x       → req.url '/api/x'       → 子进程 '/api/x'    （API 原样）
// （若把 '/' 原样转发，子进程会 302 到 /zhizu/ 造成重定向死循环。）
// 必须挂在 express.json 之前——请求体原样透传，由子进程自行解析。
// 无 body 大小限制（xlsx 导入走子进程自己的 3mb 限制）；LLM 生成较慢，不设代理超时。
function proxy(req, res) {
  const target = /^\/api(\/|$)/.test(req.url) ? req.url : '/zhizu' + req.url;
  const headers = { ...req.headers, host: `127.0.0.1:${PORT}` };
  const up = http.request({ host: '127.0.0.1', port: PORT, method: req.method, path: target, headers }, (ur) => {
    res.writeHead(ur.statusCode, ur.headers);
    ur.pipe(res);
  });
  up.on('error', (e) => {
    console.warn('[zhizu] 代理失败:', e.message);
    if (res.headersSent) return res.destroy();
    // 子进程多半还在启动：给个 3 秒自刷新页，iframe 场景下用户无感等它就绪
    res.status(503).type('html').send('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3"><body style="font-family:system-ui;padding:40px;text-align:center;color:#888">智作平台正在启动，请稍候…</body>');
  });
  req.pipe(up);
}

// 工作台退出时带走子进程（升级重启不留孤儿；被强杀时孤儿由下次启动的 probe 复用兜底）
process.on('exit', () => {
  stopping = true;
  try { child && child.kill(); } catch { /* 尽力 */ }
});

module.exports = { start, proxy };
