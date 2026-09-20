// E2E：TTS 引擎构建标识与旧进程替换
// 场景①（用户 NAS 现状复刻）：9640 上挂一个无 build 标识、无 /shutdown 的旧引擎
//        → warmup 应给出「旧版 TTS 引擎进程…请重启服务/容器」的明确报错，而不是原样转发旧引擎的错误
// 场景②：挂一个 build 过期但带 /shutdown 的旧引擎 → warmup 自动请它退出并拉起真引擎
//        → 最终 ready 且 build 与随包脚本一致
// 场景③：/tts/status 带出 build 字段（面板显示「引擎 build xxx」的数据源）
import { DatabaseSync } from 'node:sqlite';
import { spawn, execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const require = createRequire(import.meta.url);
const { SERVER } = require('../server/services/ttsPaths.js');

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };
const j = (r) => r.json();
const B = 'http://localhost:3000/api';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WANT = (/^ENGINE_BUILD\s*=\s*["']([^"']+)["']/m.exec(fs.readFileSync(SERVER, 'utf8')) || [])[1] || '';

const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const token = crypto.randomBytes(24).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+40 minutes'))").run(token, admin.id);
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

function killPort9640() {
  try {
    const out = execSync('netstat -ano | grep ":9640" | grep LISTENING', { shell: 'bash' }).toString();
    const pid = out.trim().split('\n')[0].trim().split(/\s+/).pop();
    if (pid) execSync('taskkill //PID ' + pid + ' //F', { shell: 'bash' });
    return !!pid;
  } catch { return false; }
}

async function waitPort(up, ms = 15000) {
  for (let i = 0; i < ms / 300; i++) {
    try { await fetch('http://127.0.0.1:9640/health', { signal: AbortSignal.timeout(800) }); return up; } catch {}
    if (!up) return true;
    await sleep(300);
  }
  return !up;
}

async function status() { return j(await fetch(B + '/tts/status', { headers: H })); }

try {
  ck('随包脚本带 ENGINE_BUILD 标识', !!WANT, '未从 moss_server.py 解析到 ENGINE_BUILD');

  // ===== 场景①：最旧的引擎（无标识、无 /shutdown）→ 明确报错 =====
  killPort9640(); await sleep(800);
  const fake1 = spawn(process.execPath, ['D:/CC/tmp-fake-tts-engine.mjs', 'old'], { stdio: 'ignore' });
  ck('旧引擎(无标识)已挂上 9640', await waitPort(true));
  let r = await fetch(B + '/tts/engine/warmup', { method: 'POST', headers: H, body: '{}' });
  let body = await j(r);
  ck('warmup 拒绝旧引擎（500）', r.status === 500, String(r.status));
  ck('报错指明「旧版 TTS 引擎进程」并给出重启指引',
    /旧版 TTS 引擎进程/.test(body.error || '') && /重启服务\/容器/.test(body.error || ''), body.error);
  fake1.kill(); await sleep(600);

  // ===== 场景②：带过期 build 的旧引擎 → 自动替换为真引擎 =====
  const fake2 = spawn(process.execPath, ['D:/CC/tmp-fake-tts-engine.mjs', 'stale'], { stdio: 'ignore' });
  ck('旧引擎(过期标识)已挂上 9640', await waitPort(true));
  r = await fetch(B + '/tts/engine/warmup', { method: 'POST', headers: H, body: '{}' });
  ck('warmup 自动替换旧引擎（拉起真引擎）', r.status === 200, r.status + ' ' + JSON.stringify(await j(r).catch(() => ({}))));
  let ready = false, s = null;
  for (let i = 0; i < 90; i++) {           // 本地模型完整，ready 约 1 分钟内
    await sleep(2000);
    s = await status();
    if (s.running && s.phase === 'ready') { ready = true; break; }
    if (s.phase === 'error') { console.log('  引擎报错:', s.error); break; }
  }
  ck('替换后的真引擎就绪', ready, 'phase=' + (s && s.phase));
  ck('运行中引擎 build 与随包脚本一致', !!(s && s.build === WANT), `status.build=${s && s.build} want=${WANT}`);

  // ===== 场景③：status 接口带 build 字段 =====
  ck('/tts/status 暴露 build 字段', !!(s && s.build));

  console.log(`\n${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  killPort9640(); // 收尾清引擎，不留后台进程
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
