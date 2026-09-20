// 生产巡检：读 tenant-1.sqlite（生产管理员=uid1）的 dingtalk_push 配置
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const BASE = 'http://localhost:3000';
const DIR = 'D:/CC/personal-workbench/data/tmp-probe-main';
fs.mkdirSync(DIR, { recursive: true });

const lr = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
const { token } = await lr.json();
const HA = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

const oldCfg = await (await fetch(BASE + '/api/vstudy/config', { headers: HA })).json();
console.log('vstudy 根(原):', oldCfg.root || '(空)');
try {
  await fetch(BASE + '/api/vstudy/settings', { method: 'POST', headers: HA, body: JSON.stringify({ root: '/data' }) });
  const r = await fetch(`${BASE}/api/vstudy/file?path=${encodeURIComponent('tenant-1.sqlite')}&download=1&token=${encodeURIComponent(token)}`);
  if (r.status !== 200) {
    console.log('tenant-1.sqlite HTTP', r.status);
  } else {
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(`${DIR}/tenant-1.sqlite`, buf);
    console.log('tenant-1.sqlite', buf.length, 'bytes');
    const db = new DatabaseSync(`${DIR}/tenant-1.sqlite`, { readOnly: true });
    const row = db.prepare("SELECT value FROM settings WHERE key='dingtalk_push'").get();
    if (row) {
      const c = JSON.parse(row.value);
      console.log('生产 dingtalk_push:');
      console.log('  app_key   =', c.app_key);
      console.log('  robot_code=', c.robot_code, c.robot_code === c.app_key ? '(=AppKey)' : '(≠AppKey!)');
      console.log('  agent_id  =', c.agent_id ? '已填(' + c.agent_id + ')' : '(空)');
      console.log('  userid    =', c.userid, '| enabled:', c.enabled, '| mode:', c.mode);
      console.log('  有secret  =', !!c.app_secret);
    } else console.log('生产无 dingtalk_push 配置');
    db.close();
  }
} finally {
  await fetch(BASE + '/api/vstudy/settings', { method: 'POST', headers: HA, body: JSON.stringify({ root: oldCfg.root || '' }) });
  console.log('vstudy 根已还原');
}
