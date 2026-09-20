// 生产巡检（第三十六批法）：临时把 vstudy 根指到 /data → 下载主库 → 读 dingtalk_robot_state_u* → 还原根
// 目的：拿到真实消息 payload 里的 robotCode（batchSend 报「robot 不存在」，怀疑机器人编码≠AppKey）
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const BASE = 'http://localhost:3000';
const DIR = 'D:/CC/personal-workbench/data/tmp-probe-main';
fs.mkdirSync(DIR, { recursive: true });

const lr = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
const { token } = await lr.json();
const HA = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

// 1. 记住原根
const oldSettings = await (await fetch(BASE + '/api/vstudy/config', { headers: HA })).json();
console.log('当前 vstudy 根:', oldSettings.root || '(空)');

try {
  // 2. 临时指到 /data
  await fetch(BASE + '/api/vstudy/settings', { method: 'POST', headers: HA, body: JSON.stringify({ root: '/data' }) });

  // 3. 下载主库（+wal 若有）
  for (const name of ['qg-final.sqlite', 'qg-final.sqlite-wal']) {
    const r = await fetch(`${BASE}/api/vstudy/file?path=${encodeURIComponent(name)}&download=1&token=${encodeURIComponent(token)}`);
    if (r.status !== 200) { console.log(name, 'HTTP', r.status, '（跳过）'); continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(`${DIR}/${name}`, buf);
    console.log(name, buf.length, 'bytes');
  }

  // 4. 本地读 settings
  const db = new DatabaseSync(`${DIR}/qg-final.sqlite`, { readOnly: true });
  const rows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'dingtalk_robot_state_%'").all();
  for (const r of rows) {
    const v = JSON.parse(r.value);
    console.log(`\n[${r.key}]`);
    console.log('  robot_code     =', v.robot_code);
    console.log('  conv_type/id   =', v.conversation_type, '/', v.conversation_id);
    console.log('  title          =', v.title, '| owner_uid:', v.owner_uid, '| updated:', v.updated_at);
    console.log('  webhook 新鲜?  =', Number(v.session_webhook_expire || 0) > Date.now());
  }
  db.close();
} finally {
  // 5. 还原
  await fetch(BASE + '/api/vstudy/settings', { method: 'POST', headers: HA, body: JSON.stringify({ root: oldSettings.root || '' }) });
  console.log('\nvstudy 根已还原为:', oldSettings.root || '(空)');
}
