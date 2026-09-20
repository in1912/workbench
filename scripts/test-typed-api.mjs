// 打字互动 API 边界测试（一次性）：node scripts/test-typed-api.mjs
// 用临时宠物验证 water/snack/play 三类口令体可被识别、每类 3 次上限第 4 次拒绝，跑完即清理。
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const db = new DatabaseSync('data/workbench.sqlite');
const token = crypto.randomBytes(32).toString('hex');
db.prepare(`INSERT INTO sessions(token,user_id,expires_at) VALUES(?,1,datetime('now','localtime','+20 minutes'))`).run(token);
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
const post = (url, body) => fetch('http://localhost:3000/api' + url, { method: 'POST', headers: H, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

// 临时宠物（跑完删）
const created = await post('/pets', { name: '口令边界测试', species: 'pig', variant: 0, raise_mode: 'personal' });
const petId = created.data.id;
const results = [];
try {
  // 三类口令体各 1 次：water 无 item、snack 走 food、play 带 yarn
  for (const body of [{ type: 'water', typed: true }, { type: 'food', item: 'snack', typed: true }, { type: 'play', item: 'yarn', typed: true }]) {
    const r = await post(`/pets/${petId}/action`, body);
    results.push(`${body.type}${body.item ? ':' + body.item : ''} → ${r.status}${r.status !== 200 ? ' ' + (r.data.error || '') : ' ok=' + r.data.ok + ' typed=' + r.data.typed}`);
  }
  // 上限：play 再打 2 次（共3）→ 第 4 次应 400 报次数用完
  for (let i = 0; i < 3; i++) {
    const r = await post(`/pets/${petId}/action`, { type: 'play', item: 'yarn', typed: true });
    results.push(`play#${i + 2} → ${r.status}${r.status !== 200 ? ' ' + (r.data.error || '') : ''}`);
  }
  // 非法类型
  const bad = await post(`/pets/${petId}/action`, { type: 'scoop', typed: true });
  results.push(`scoop typed → ${bad.status} ${bad.data.error || ''}`);
  const st = await fetch('http://localhost:3000/api/pets/state', { headers: H }).then((r) => r.json());
  const p = st.pets.find((x) => x.id === petId);
  results.push('today_typed = ' + JSON.stringify(p.my.today_typed));
} finally {
  for (const t of ['pets', 'pet_members', 'pet_state', 'pet_poops', 'pet_stats', 'pet_logs']) {
    db.prepare(`DELETE FROM ${t} WHERE ${t === 'pets' ? 'id' : 'pet_id'}=?`).run(petId);
  }
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
console.log(results.join('\n'));
