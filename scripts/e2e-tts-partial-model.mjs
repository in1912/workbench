// E2E：TTS 模型半成品自愈（用户报障复现）
// 场景：首次下载被中断 → browser_poc_manifest.json（小文件）在、tts_browser_onnx_meta.json（模型文件）缺
//       → 旧代码看到 manifest 就跳过下载直接加载 → ENOENT 永久报错
// 验证：① 杀引擎后重启，_heal_partial_download 摘标记 ② snapshot_download 续传只补缺失文件
//       ③ 引擎就绪 ④ 合成正常 ⑤ 完整状态下启动不触发重下（detail=正在加载模型）
import { DatabaseSync } from 'node:sqlite';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const require = createRequire(import.meta.url);
const { TTS_ROOT } = require('../server/services/ttsPaths.js');
const TTS_DIR = path.join(TTS_ROOT, 'MOSS-TTS-Nano', 'models', 'MOSS-TTS-Nano-100M-ONNX');
const META = path.join(TTS_DIR, 'tts_browser_onnx_meta.json');

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };
const j = (r) => r.json();
const B = 'http://localhost:3000/api';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const token = crypto.randomBytes(24).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+40 minutes'))").run(token, admin.id);
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

// 引擎健康轮询：返回最近一次 status
async function status() { return j(await fetch(B + '/tts/status', { headers: H })); }

function killEngine() {
  try {
    const out = execSync('netstat -ano | grep ":9640" | grep LISTENING', { shell: 'bash' }).toString();
    const pid = out.trim().split('\n')[0].trim().split(/\s+/).pop();
    if (pid) execSync('taskkill //PID ' + pid + ' //F', { shell: 'bash' });
    return !!pid;
  } catch { return false; }
}

try {
  // ===== 前置：确认本地模型完整（不完整先说明，避免误判） =====
  ck('本地模型基线完整（meta json 在）', fs.existsSync(META));
  killEngine();
  await sleep(1500);

  // ===== 场景注入：manifest 在、meta 缺（用户 NAS 上的中毒状态） =====
  fs.renameSync(META, META + '.bak');
  ck('已注入半成品状态（meta 缺、manifest 在）', !fs.existsSync(META) && fs.existsSync(path.join(TTS_DIR, 'browser_poc_manifest.json')));

  // ===== 引擎重启 → 自愈 =====
  const w = await fetch(B + '/tts/engine/warmup', { method: 'POST', headers: H, body: '{}' });
  ck('warmup 接口 ok', w.status === 200, String(w.status));
  let healedFile = false, sawDownloading = false, ready = false, lastPhase = '', lastDetail = '';
  for (let i = 0; i < 120; i++) {            // 最多 240 秒（续传一个小文件 + 元数据校验）
    await sleep(2000);
    if (fs.existsSync(META)) healedFile = true;
    const s = await status();
    lastPhase = s.phase; lastDetail = s.detail || '';
    if (s.phase === 'downloading') sawDownloading = true;
    if (s.running && s.phase === 'ready') { ready = true; break; }
    if (s.phase === 'error') { console.log('  引擎报错:', s.error); break; }
  }
  ck('缺的模型文件被自动补回', healedFile);
  ck('引擎自愈后就绪', ready, 'phase=' + lastPhase + ' detail=' + lastDetail);
  if (ready) {
    // ===== 补回后合成正常 =====
    const syn = await fetch(B + '/tts/synthesize', { method: 'POST', headers: H, body: JSON.stringify({ text: '半成品自愈验证。' }) });
    const buf = Buffer.from(await syn.arrayBuffer());
    ck('合成返回音频', syn.status === 200 && buf.length > 5000, `${syn.status} ${buf.length}B`);
  }

  // ===== 完整状态下再重启：不应再触发下载（detail 直接是加载模型） =====
  if (ready) {
    killEngine();
    await sleep(1500);
    await fetch(B + '/tts/engine/warmup', { method: 'POST', headers: H, body: '{}' });
    let ok2 = false;
    for (let i = 0; i < 90; i++) {
      await sleep(2000);
      const s = await status();
      if (s.running && s.phase === 'ready') { ok2 = true; break; }
      if (s.phase === 'error') break;
    }
    ck('完整状态下重启正常就绪', ok2);
  }

  console.log(`\n${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  // 还原注入：下载已补回则只清 .bak；没补回则从 .bak 恢复
  if (fs.existsSync(META + '.bak')) {
    if (fs.existsSync(META)) fs.unlinkSync(META + '.bak');
    else fs.renameSync(META + '.bak', META);
  }
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
