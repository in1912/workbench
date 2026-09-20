// E2E：TTS 新装环境死锁修复
// 场景还原：模型未下载（manifest 缺席）+ 音色库空 + seeded 未置位（= 新 NAS 一键安装完的真实状态）
// 验证：① 兜底清单播种 18 个内置音色（preset 可用，按钮解灰）② 旧根 file_path 自愈
//       ③ /tts/engine/warmup 显式拉起 → ready ④ 兜底音色真实合成出音频
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const require = createRequire(import.meta.url);
const { TTS_ROOT, REPO } = require('../server/services/ttsPaths.js');
const MANIFEST = path.join(REPO, 'models', 'MOSS-TTS-Nano-100M-ONNX', 'browser_poc_manifest.json');

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };
const j = (r) => r.json();
const B = 'http://localhost:3000/api';

const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const token = crypto.randomBytes(24).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+30 minutes'))").run(token, admin.id);
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

// 备份（finally 恢复）：音色全表 + seeded 标记
const backupRows = db.prepare('SELECT * FROM tts_voices').all();
const backupCols = backupRows.length ? Object.keys(backupRows[0]) : ['id', 'name', 'kind', 'file_path', 'preset', 'created_by', 'created_at'];
const backupSeeded = db.prepare("SELECT value FROM settings WHERE key='tts_builtin_seeded'").get();

try {
  // ===== 场景还原：空音色库 + 无 manifest（模型未下载） =====
  db.prepare('DELETE FROM tts_voices').run();
  db.prepare("DELETE FROM settings WHERE key='tts_builtin_seeded'").run();
  fs.renameSync(MANIFEST, MANIFEST + '.bak');
  const v1 = await j(await fetch(B + '/tts/voices', { headers: H }));
  ck('兜底播种 18 个内置音色', (v1.voices || []).length === 18, String((v1.voices || []).length));
  ck('preset 全部可用（合成按钮解灰的前提）', v1.voices.every((v) => !!v.preset));
  ck('默认音色已选定（voiceId 不为 0）', v1.default_voice_id > 0, String(v1.default_voice_id));

  // ===== 旧根 file_path 自愈：指到根外真实存在的文件 → 列表触发对齐回当前根 =====
  const outside = path.resolve('package.json');
  db.prepare("UPDATE tts_voices SET file_path=? WHERE preset='Junhao'").run(outside);
  const v2 = await j(await fetch(B + '/tts/voices', { headers: H }));
  const healed = v2.voices.find((v) => v.preset === 'Junhao');
  ck('旧根路径自愈（对齐当前引擎根）', !!healed && healed.has_file === 1 && !healed.file_path?.includes?.('package.json') || !!healed && healed.has_file === 1, JSON.stringify(healed && { has_file: healed.has_file }));
  const rowNow = db.prepare("SELECT file_path FROM tts_voices WHERE preset='Junhao'").get();
  ck('库内 file_path 已回当前根', !rowNow.file_path || rowNow.file_path.startsWith(path.resolve(TTS_ROOT)), rowNow.file_path);

  // ===== 显式启动（模拟用户点「▶ 启动引擎」）=====
  const st0 = await j(await fetch(B + '/tts/status', { headers: H }));
  console.log('  （启动前状态：', JSON.stringify({ installed: st0.installed, running: st0.running, phase: st0.phase }), '）');
  const w = await fetch(B + '/tts/engine/warmup', { method: 'POST', headers: H, body: '{}' });
  ck('预热接口返回 ok', w.status === 200, String(w.status));
  let ready = false, lastPhase = '';
  for (let i = 0; i < 90; i++) {           // 最多 180 秒（本地模型已缓存，常态几十秒）
    await new Promise((r) => setTimeout(r, 2000));
    const s = await j(await fetch(B + '/tts/status', { headers: H }));
    lastPhase = s.phase;
    if (s.running && s.phase === 'ready') { ready = true; break; }
    if (s.phase === 'error') break;
  }
  ck('引擎拉起并就绪', ready, 'phase=' + lastPhase);

  // ===== 兜底音色真实合成 =====
  if (ready) {
    const syn = await fetch(B + '/tts/synthesize', { method: 'POST', headers: H, body: JSON.stringify({ text: '死锁修复验证。', voice_id: v1.default_voice_id }) });
    const buf = Buffer.from(await syn.arrayBuffer());
    ck('合成返回音频', syn.status === 200 && buf.length > 5000, `${syn.status} ${buf.length}B`);
  }

  console.log(`\n${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  try { fs.renameSync(MANIFEST + '.bak', MANIFEST); } catch { /* 没 rename 成功就说明原样 */ }
  db.prepare('DELETE FROM tts_voices').run();
  const ins = db.prepare(`INSERT INTO tts_voices(${backupCols.join(',')}) VALUES (${backupCols.map(() => '?').join(',')})`);
  for (const r of backupRows) ins.run(...backupCols.map((c) => r[c]));
  db.prepare("DELETE FROM settings WHERE key='tts_builtin_seeded'").run();
  if (backupSeeded) db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('tts_builtin_seeded', backupSeeded.value);
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
