// 优雅重启：退出前先拉起一个分离（detached）的自身副本接管服务。
// 背景：原实现是裸 process.exit(0)，依赖 Docker restart:always 拉起——容器内没问题，
// 但本机直跑（start.bat / 裸 node）没有守护进程，退出即服务死亡
// （2026-09-15 用户本机换 SSL 证书后点「重启」服务直接没了，踩中此坑）。
// 行为：spawn 分离子进程（同 argv/cwd/env，附 WB_GRACEFUL_RESTART=1 让子进程延迟监听、
// 等父进程先释放端口），800ms 后父进程退出。
// Docker 语义不变：PID 1 退出 → 容器停止（子进程一并被杀）→ restart:always 重新拉起。
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function gracefulRestart(tag) {
  try {
    // 子进程输出落日志（ detached 无控制台，不落盘就什么都看不到）
    let out;
    try {
      fs.mkdirSync(path.join(process.cwd(), 'Logs'), { recursive: true });
      out = fs.openSync(path.join(process.cwd(), 'Logs', 'restart-child.log'), 'a');
    } catch { /* 日志开不了就静默 */ }
    const child = spawn(process.execPath, process.argv.slice(1), {
      cwd: process.cwd(),
      env: { ...process.env, WB_GRACEFUL_RESTART: '1' },
      detached: true,
      stdio: out ? ['ignore', out, out] : 'ignore',
    });
    child.unref();
    console.log(`[restart] ${tag || '服务重启'}：已拉起接替进程 pid=${child.pid}，本进程即将退出`);
  } catch (e) {
    console.warn('[restart] 拉起接替进程失败（将依赖外部守护拉起）:', e.message);
  }
  setTimeout(() => process.exit(0), 800);
}

module.exports = { gracefulRestart };
