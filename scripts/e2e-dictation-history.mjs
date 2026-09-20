// E2E：听写历史 API（保存/快照回读/分页 15·30·50/删除/租户隔离）
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const admin = db.prepare("SELECT id, username FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const member = db.prepare("SELECT id FROM users WHERE role!='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const tA = crypto.randomBytes(24).toString('hex');
const tM = crypto.randomBytes(24).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+15 minutes'))").run(tA, admin.id);
if (member) db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+15 minutes'))").run(tM, member.id);
const HA = { Authorization: 'Bearer ' + tA, 'Content-Type': 'application/json' };
const HM = { Authorization: 'Bearer ' + tM, 'Content-Type': 'application/json' };

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };
const B = 'http://localhost:3000/api';
const created = [];   // 本次测试创建的记录 id（finally 清理）

try {
  // 基线：测试前管理员已有的记录数（断言全部按增量算，不动真实数据）
  const base = (await (await fetch(B + '/tts/dictation-history?page=1&pageSize=1', { headers: HA })).json()).total;

  // ① 保存 + 快照回读
  let r = await fetch(B + '/tts/dictation-history', { method: 'POST', headers: HA, body: JSON.stringify({ content: 'apple\r\nbanana\r\n\r\n美丽的', mode: 'step', interval: 8, voice_id: 3, voice_name: '妈妈' }) });
  let d = await r.json();
  ck('保存返回 id 与条数', r.status === 200 && d.ok && d.id > 0 && d.count === 3, JSON.stringify(d));
  created.push(d.id);
  r = await fetch(B + '/tts/dictation-history?page=1&pageSize=15', { headers: HA });
  d = await r.json();
  const top = (d.records || [])[0] || {};
  ck('CRLF/空行归一化 + 快照字段回读', top.content === 'apple\nbanana\n美丽的' && top.mode === 'step' && top.interval === 8 && top.voice_id === 3 && top.voice_name === '妈妈' && top.count === 3, JSON.stringify(top));
  r = await fetch(B + '/tts/dictation-history', { method: 'POST', headers: HA, body: JSON.stringify({ content: '   ' }) });
  ck('空内容被拒（400）', r.status === 400, String(r.status));

  // ② 分页：再造 20 条 → 总数 base+21
  for (let i = 1; i <= 20; i++) {
    const rr = await fetch(B + '/tts/dictation-history', { method: 'POST', headers: HA, body: JSON.stringify({ content: '词' + i }) });
    created.push((await rr.json()).id);
  }
  r = await fetch(B + '/tts/dictation-history?page=1&pageSize=15', { headers: HA });
  d = await r.json();
  const T = base + 21;
  ck(`每页 15 条（共 ${T}）`, d.total === T && d.records.length === Math.min(15, T), `${d.records.length}/${d.total}`);
  ck('新记录置顶（第一条=最后创建）', d.records[0].content === '词20', d.records[0].content);
  r = await fetch(B + '/tts/dictation-history?page=2&pageSize=15', { headers: HA });
  d = await r.json();
  ck('第 2 页承接余量', d.records.length === Math.max(0, T - 15), String(d.records.length));
  for (const ps of [30, 50]) {
    r = await fetch(B + `/tts/dictation-history?page=1&pageSize=${ps}`, { headers: HA });
    d = await r.json();
    ck(`每页 ${ps} 全量`, d.records.length === Math.min(ps, T), String(d.records.length));
  }

  // ③ 删除
  const delId = created[created.length - 1];
  r = await fetch(B + `/tts/dictation-history/${delId}`, { method: 'DELETE', headers: HA });
  ck('删除成功（deleted=1）', r.status === 200 && (await r.json()).deleted === 1);
  created.pop();
  r = await fetch(B + '/tts/dictation-history?page=1&pageSize=1', { headers: HA });
  ck('删除后总数减一', (await r.json()).total === T - 1);

  // ④ 租户隔离（历史存各人租户库，互相不可见）
  if (member) {
    r = await fetch(B + '/tts/dictation-history?page=1&pageSize=50', { headers: HM });
    ck('成员看不到管理员的记录', (await r.json()).total === 0);
    const rm = await fetch(B + '/tts/dictation-history', { method: 'POST', headers: HM, body: JSON.stringify({ content: '成员词' }) });
    const mid = (await rm.json()).id;
    r = await fetch(B + `/tts/dictation-history/${mid}`, { method: 'DELETE', headers: HM });
    ck('成员可删自己的记录', (await r.json()).deleted === 1);
  } else console.log('  （库中无普通成员账号，跳过隔离用例）');

  console.log(`\n${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  for (const id of created) await fetch(B + `/tts/dictation-history/${id}`, { method: 'DELETE', headers: HA }).catch(() => {});
  db.prepare('DELETE FROM sessions WHERE token IN (?,?)').run(tA, tM);
}
