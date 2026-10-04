// 笔记 v1.9.41 系列 e2e 的公共脚手架。
//
// 每个用例都起一个**隔离的服务器**（独立 PORT + 独立 DATA_DIR，跑完就删），
// 绝不去碰 data/workbench.sqlite —— 新功能会重建表结构，拿真库当试验场风险不划算。
// 这套写法照抄 scripts/e2e-tab-perm-pets-page.mjs。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const j = async (r) => {
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { __raw: t.slice(0, 200) }; }
};

export function checker() {
  const s = { pass: 0, fail: 0, ck: null, done: null };
  s.ck = (name, cond, extra = '') => {
    cond ? s.pass++ : s.fail++;
    console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  <<< ' + String(extra).slice(0, 200)}`);
  };
  s.done = () => {
    console.log(`\n${s.pass} 通过, ${s.fail} 失败`);
    if (s.fail) process.exitCode = 1;
    return s.fail === 0;
  };
  return s;
}

// tag 决定临时目录名与端口，各用例取不同的值避免打架
export async function startServer({ tag, port }) {
  // 目录名带时间戳：上一次跑挂掉留下的临时目录不会让这一次直接 EPERM 起不来
  const DATA = path.join(ROOT, 'data', `tmp-note-e2e-${tag}-${Date.now()}`);
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const srv = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), DATA_DIR: DATA,
      DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456',
      TTS_ROOT: path.join(DATA, 'no-tts'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => console.error('[srv-err]', String(d).slice(0, 400)));
  // 脚本被 Ctrl-C / 被上下文掐掉时也别把子进程丢在后台占着端口与临时目录
  process.on('exit', () => { try { srv.kill('SIGKILL'); } catch { /* 已退 */ } });
  const B = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${B}/api/health`)).ok) { up = true; break; } } catch { /* 还没起来 */ }
    await sleep(250);
  }
  if (!up) throw new Error(`服务器 ${port} 启动超时`);
  return {
    B, DATA, srv,
    stop() {
      try { srv.kill('SIGKILL'); } catch { /* 已退 */ }
      // Windows 上进程刚被 kill 时句柄还没释放，rmSync 会失败；退避重试几次再放弃
      for (let i = 0; i < 10; i++) {
        try { fs.rmSync(DATA, { recursive: true, force: true }); return; } catch { /* 再等等 */ }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
      }
    },
  };
}

export async function login(B, username, password) {
  const r = await fetch(`${B}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const d = await j(r);
  if (!d.token) throw new Error(`登录失败 ${username}: ${JSON.stringify(d)}`);
  return { token: d.token, user: d.user, H: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + d.token } };
}

// 常用简写：带 JSON 的 GET/POST/PUT/DELETE
export function api(B, H) {
  const go = (method) => async (p, body) => {
    const r = await fetch(B + '/api' + p, {
      method,
      headers: H,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await j(r), raw: r };
  };
  return {
    get: go('GET'), post: go('POST'), put: go('PUT'), del: go('DELETE'),
  };
}
