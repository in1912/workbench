// E2E：TTS 引擎一键安装全流程（真实安装到独立草稿目录，不动本机现有引擎与 data/tts）
// 前置：server 以 TTS_ROOT=<scratch> TTS_INSTALL_DIR=<scratch> 启动。
// 流程：API 触发安装（restart:false）→ 轮询到 done → 校验产物（Python/仓库/moss_server）→
//       由外部脚本 junction 复用已下载模型后再验证 ready+合成。
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const admin = db.prepare("SELECT id, username FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const token = crypto.randomBytes(32).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+60 minutes'))").run(token, admin.id);
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
const B = 'http://localhost:3000/api';
const SCRATCH = process.env.TTS_E2E_ROOT || path.resolve('tts-e2e');

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };
const j = (r) => r.json();

try {
  // 0) 起始状态：scratch 为空 → 未安装
  const st0 = await j(await fetch(B + '/tts/engine/status', { headers: H }));
  ck('初始未安装', st0.installed === false && st0.running === false);
  ck('/tts/status 也未安装', (await j(await fetch(B + '/tts/status', { headers: H }))).installed === false);

  // 1) 非管理员被拒（403）
  const fam = db.prepare("SELECT id FROM users WHERE role!='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
  if (fam) {
    const ftok = crypto.randomBytes(32).toString('hex');
    db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+5 minutes'))").run(ftok, fam.id);
    const r403 = await fetch(B + '/tts/engine/install', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + ftok }, body: '{}' });
    ck('非管理员 403', r403.status === 403, String(r403.status));
    db.prepare('DELETE FROM sessions WHERE token=?').run(ftok);
  }

  // 2) 触发安装（restart:false 避免测试机被重启）；重复触发应幂等返回
  const r1 = await fetch(B + '/tts/engine/install', { method: 'POST', headers: H, body: JSON.stringify({ restart: false }) });
  ck('触发安装 200', r1.ok);
  const r2 = await fetch(B + '/tts/engine/install', { method: 'POST', headers: H, body: JSON.stringify({ restart: false }) });
  ck('并发触发幂等', (await j(r2)).already === true);

  // 3) 轮询至完成（真实下载 Miniconda/依赖，分钟级）
  let done = null, last = '';
  const t0 = Date.now();
  while (Date.now() - t0 < 40 * 60 * 1000) {
    const s = await j(await fetch(B + '/tts/engine/status', { headers: H }));
    const line = `${s.progress}% ${s.stepIndex} ${s.error}`;
    if (line !== last) { last = line; console.log(`  … ${s.progress}% 步骤${s.stepIndex + 1}/${(s.steps || []).length} ${s.error || ''}`); }
    if (!s.running) { done = s; break; }
    await new Promise((r) => setTimeout(r, 5000));
  }
  ck('安装完成（无错误）', !!done && done.done === true && !done.error, done ? done.error : '40 分钟超时');

  // 4) 产物校验
  ck('Python 解释器就位', fs.existsSync(path.join(SCRATCH, 'py', 'python.exe')) || fs.existsSync(path.join(SCRATCH, 'py', 'bin', 'python')));
  ck('仓库代码就位', fs.existsSync(path.join(SCRATCH, 'MOSS-TTS-Nano', 'onnx_tts_runtime.py')));
  ck('moss_server.py 部署', fs.existsSync(path.join(SCRATCH, 'moss_server.py')));
  ck('目录结构完整', ['voices', 'cache', 'tmp'].every((d) => fs.existsSync(path.join(SCRATCH, d))));
  ck('进度 100%', done && done.progress === 100);

  console.log(`\n${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
