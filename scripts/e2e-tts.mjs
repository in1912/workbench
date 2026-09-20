// E2E：语音合成/音色库/听写配置 全链路（管理员会话直插 sessions 表，测完清理）
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000'); // 服务端也会写主库（调度器），抢锁时等一下而不是立刻炸
const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const token = crypto.randomBytes(32).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+10 minutes'))").run(token, admin.id);
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
const B = 'http://localhost:3000/api';

let pass = 0, fail = 0;
function ck(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra); }
}

try {
  // 1) 音色列表：播种 18 个内置音色（含 preset 与 has_file）
  const v = await (await fetch(B + '/tts/voices', { headers: H })).json();
  ck('内置音色播种 18 个', (v.voices || []).length === 18 && v.voices.every((x) => x.kind === 'builtin'), JSON.stringify((v.voices || []).length));
  ck('有默认音色', !!v.default_voice_id);
  const withFile = v.voices.find((x) => x.has_file);
  const presetOnly = v.voices.find((x) => !x.has_file);
  ck('部分内置音色带参考录音', !!withFile && !!presetOnly);
  const origDefault = v.default_voice_id;

  // 2) 无 token 401
  const noauth = await fetch(B + '/tts/voices');
  ck('未登录 401', noauth.status === 401);

  // 3) 引擎状态（不拉起，只探测）
  const st0 = await (await fetch(B + '/tts/status', { headers: H })).json();
  ck('状态接口可用', st0 && typeof st0.installed === 'boolean' && typeof st0.voice_count === 'number', JSON.stringify(st0).slice(0, 80));

  // 4) 合成（首条会拉起 Python 引擎+加载模型，耗时较长）——参考音频音色
  console.log('  … 合成第 1 条（含引擎冷启动，最长 3 分钟）');
  const t0 = Date.now();
  const r1 = await fetch(B + '/tts/synthesize', { method: 'POST', headers: H, body: JSON.stringify({ text: '春眠不觉晓，处处闻啼鸟。', voice_id: withFile.id }) });
  ck('合成(wav参考) HTTP 200', r1.ok, 'HTTP ' + r1.status);
  const b1 = Buffer.from(await r1.arrayBuffer());
  ck('返回 RIFF WAV', b1.length > 40000 && b1.slice(0, 4).toString('ascii') === 'RIFF', `${b1.length}B`);
  console.log(`    首条耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s（含引擎启动）`);

  // 5) 同文本再合成 → 命中缓存（秒回）
  const t2 = Date.now();
  const r2 = await fetch(B + '/tts/synthesize', { method: 'POST', headers: H, body: JSON.stringify({ text: '春眠不觉晓，处处闻啼鸟。', voice_id: withFile.id }) });
  const b2 = Buffer.from(await r2.arrayBuffer());
  ck('缓存命中秒回', r2.ok && Date.now() - t2 < 1500 && b2.equals(b1), `${Date.now() - t2}ms`);

  // 6) 合成（preset-only 音色：无 wav 走模型预编码）
  const r3 = await fetch(B + '/tts/synthesize', { method: 'POST', headers: H, body: JSON.stringify({ text: 'Hello dictation test.', voice_id: presetOnly.id }) });
  const b3 = Buffer.from(await r3.arrayBuffer());
  ck('合成(preset音色) RIFF WAV', r3.ok && b3.slice(0, 4).toString('ascii') === 'RIFF', 'HTTP ' + r3.status);

  // 7) 参考音频试听
  const r4 = await fetch(`${B}/tts/ref-audio/${withFile.id}?token=${token}`);
  ck('参考音频可听', r4.ok && (await r4.arrayBuffer()).byteLength > 1000);

  // 8) 听写配置读写 + 校验边界
  const cfgDef = await (await fetch(B + '/tts/dictation-config', { headers: H })).json();
  ck('听写默认配置 auto/30秒', cfgDef.mode === 'auto' && cfgDef.interval === 30, JSON.stringify(cfgDef));
  await fetch(B + '/tts/dictation-config', { method: 'POST', headers: H, body: JSON.stringify({ mode: 'step', interval: 999 }) });
  const cfg2 = await (await fetch(B + '/tts/dictation-config', { headers: H })).json();
  ck('间隔上限钳制 300', cfg2.mode === 'step' && cfg2.interval === 300, JSON.stringify(cfg2));
  await fetch(B + '/tts/dictation-config', { method: 'POST', headers: H, body: JSON.stringify({ mode: 'auto', interval: 30 }) });

  // 9) 上传音色（用仓库 zh_1.wav 当克隆参考）→ 合成 → 清理
  const ref = fs.readFileSync('tts/MOSS-TTS-Nano/assets/audio/zh_1.wav');
  const up = await (await fetch(B + '/tts/manage/upload', { method: 'POST', headers: H, body: JSON.stringify({ name: 'E2E测试音色', data_base64: ref.toString('base64') }) })).json();
  ck('上传音色', !!up.id, JSON.stringify(up));
  const r5 = await fetch(B + '/tts/synthesize', { method: 'POST', headers: H, body: JSON.stringify({ text: '这是上传音色的克隆合成。', voice_id: up.id }) });
  const b5 = Buffer.from(await r5.arrayBuffer());
  ck('克隆音色合成 RIFF WAV', r5.ok && b5.slice(0, 4).toString('ascii') === 'RIFF');
  const del = await fetch(`${B}/tts/manage/voice/${up.id}`, { method: 'DELETE', headers: H });
  ck('删除上传音色', del.ok);
  const v2 = await (await fetch(B + '/tts/voices', { headers: H })).json();
  ck('删除后音色回到 18 个', v2.voices.length === 18);
  ck('默认音色未被改动', v2.default_voice_id === origDefault);

  // 10) 引擎状态应显示运行中
  const st1 = await (await fetch(B + '/tts/status', { headers: H })).json();
  ck('引擎状态=运行中', st1.running && st1.phase === 'ready', JSON.stringify(st1).slice(0, 80));

  console.log(`\n${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  // 清理上传音色残留（若 delete 断言前抛错）
  db.prepare("DELETE FROM tts_voices WHERE name='E2E测试音色'").run();
}
