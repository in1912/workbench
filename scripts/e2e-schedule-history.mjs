// E2E：① 视频教学学习会话（open/progress 累加/close 幂等/重开自动结账/历史列表隔离）
//      ② 日程提醒与共享（remind_push 默认开/共享成员可见只读 404/提醒窗口巡检/改时间重置/共享站内通知）
// 提醒巡检通过 require 服务端 eventRemindService 直接跑（不依赖 cron 整分触发）；
// 临时用户 A/B 无钉钉配置 → 巡检推送静默跳过，不会打扰真实成员。
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const { getTenantDb, closeTenantDb } = await import('../server/db.js');

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };
const j = (r) => r.json();
const B = 'http://localhost:3000/api';

// 临时用户 A（日程主人/学习者）、B（共享成员）；真实成员一律不碰
const mkUser = (name) => {
  db.prepare("INSERT INTO users(username,password_hash,role,allowed_pages,is_bot) VALUES(?,'','user','[]',0)").run(name);
  return db.prepare('SELECT id FROM users WHERE username=?').get(name).id;
};
const uidA = mkUser('e2e_tmp_a'), uidB = mkUser('e2e_tmp_b');
const mkTok = (uid) => {
  const t = crypto.randomBytes(24).toString('hex');
  db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+30 minutes'))").run(t, uid);
  return t;
};
const tA = mkTok(uidA), tB = mkTok(uidB);
const H = (t) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + t });
const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const tAdm = mkTok(admin.id);

// 本地时间格式化 → 'YYYY-MM-DDTHH:MM'（events.start_time 入库格式）
function localDT(minFromNow) {
  const d = new Date(Date.now() + minFromNow * 60000);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const today = () => localDT(0).slice(0, 10);

try {
  // ================= ① 视频教学学习会话 =================
  console.log('① 视频教学：学习会话与历史列表');
  const PATH = 'D:/e2e/vstudy/语文/第一课.mp4';
  const s1 = await j(await fetch(B + '/vstudy/session/open', { method: 'POST', headers: H(tA), body: JSON.stringify({ path: PATH, kind: 'media', ext: 'mp4', school_year: '2025-2026 学年', subject: '语文' }) }));
  ck('打开会话返回 id', Number(s1.id) > 0, JSON.stringify(s1));
  let row = db.prepare('SELECT * FROM vstudy_sessions WHERE id=?').get(s1.id);
  ck('会话建档（开始时间有/关闭时间空）', !!row && !!row.started_at && !row.ended_at && row.school_year === '2025-2026 学年' && row.subject === '语文');

  await fetch(B + '/vstudy/progress', { method: 'POST', headers: H(tA), body: JSON.stringify({ path: PATH, kind: 'media', ext: 'mp4', school_year: '2025-2026 学年', subject: '语文', duration_sec: 600, position_sec: 60, watched_sec: 30, session_id: s1.id }) });
  await fetch(B + '/vstudy/progress', { method: 'POST', headers: H(tA), body: JSON.stringify({ path: PATH, kind: 'media', ext: 'mp4', school_year: '2025-2026 学年', subject: '语文', duration_sec: 600, position_sec: 120, watched_sec: 45, session_id: s1.id }) });
  row = db.prepare('SELECT * FROM vstudy_sessions WHERE id=?').get(s1.id);
  ck('进度累进会话（30+45=75 秒）', row.watched_sec === 75, String(row.watched_sec));
  ck('关闭时间随活跃刷新', !!row.ended_at);

  const s2 = await j(await fetch(B + '/vstudy/session/open', { method: 'POST', headers: H(tA), body: JSON.stringify({ path: PATH, kind: 'media', ext: 'mp4', school_year: '2025-2026 学年', subject: '语文' }) }));
  ck('重开生成新会话', Number(s2.id) > 0 && Number(s2.id) !== Number(s1.id));
  row = db.prepare('SELECT * FROM vstudy_sessions WHERE id=?').get(s1.id);
  ck('旧会话自动结账（ended_at 保留）', !!row.ended_at);

  await fetch(B + '/vstudy/session/close', { method: 'POST', headers: H(tA), body: JSON.stringify({ id: s2.id }) });
  const closed1 = db.prepare('SELECT ended_at FROM vstudy_sessions WHERE id=?').get(s2.id).ended_at;
  await new Promise((r) => setTimeout(r, 1100)); // 等 1 秒再关一次，验证幂等不移动时间戳
  await fetch(B + '/vstudy/session/close', { method: 'POST', headers: H(tA), body: JSON.stringify({ id: s2.id }) });
  const closed2 = db.prepare('SELECT ended_at FROM vstudy_sessions WHERE id=?').get(s2.id).ended_at;
  ck('重复关闭幂等（时间戳不动）', closed1 === closed2, `${closed1} vs ${closed2}`);

  // 他人不能关/续我的会话：B 的 progress 挂在 A 的 session 上应无效
  await fetch(B + '/vstudy/progress', { method: 'POST', headers: H(tB), body: JSON.stringify({ path: PATH, kind: 'media', ext: 'mp4', watched_sec: 99, session_id: s1.id }) });
  row = db.prepare('SELECT watched_sec FROM vstudy_sessions WHERE id=?').get(s1.id);
  ck('他人 progress 不污染我的会话', row.watched_sec === 75, String(row.watched_sec));

  const listA = await j(await fetch(B + '/vstudy/sessions?page=1&pageSize=10', { headers: H(tA) }));
  ck('历史列表 2 条且倒序（新会话在前）', listA.total === 2 && listA.sessions[0].id === Number(s2.id), JSON.stringify(listA.total));
  ck('列表字段齐全', ['path', 'school_year', 'subject', 'watched_sec', 'started_at', 'ended_at'].every((k) => k in listA.sessions[0]));
  const listB = await j(await fetch(B + '/vstudy/sessions?page=1&pageSize=10', { headers: H(tB) }));
  ck('只能看自己的历史（B 为空）', listB.total === 0, String(listB.total));

  // ================= ② 日程：提醒 + 共享 =================
  console.log('② 日程：钉钉提醒与共享');
  // 1) 新增（不传 remind_push → 默认开；共享给 B）
  const ev1 = await j(await fetch(B + '/events', { method: 'POST', headers: H(tA), body: JSON.stringify({ title: 'E2E 提醒日程', desc: '测试提前15分钟提醒', location: '会议室', start_time: localDT(20), end_time: null, end_date: null, shared_to: [uidB] }) }));
  const ev2 = await j(await fetch(B + '/events', { method: 'POST', headers: H(tA), body: JSON.stringify({ title: 'E2E 不提醒', start_time: localDT(10), end_time: null, end_date: null, remind_push: false }) }));
  const tdbA = getTenantDb(uidA);
  const r1 = tdbA.prepare('SELECT * FROM events WHERE id=?').get(ev1.id);
  const r2 = tdbA.prepare('SELECT * FROM events WHERE id=?').get(ev2.id);
  ck('remind_push 默认开', r1.remind_push === 1, String(r1.remind_push));
  ck('remind_push 可关', r2.remind_push === 0);
  ck('shared_to 落库', JSON.parse(r1.shared_to || '[]').includes(uidB), r1.shared_to);

  // 2) 共享可见性：B 能看到（只读标记+主人名），B 改不了（404），管理员看不到
  const evB = await j(await fetch(B + '/events', { headers: H(tB) }));
  const shared = evB.find((e) => e.id === Number(ev1.id));
  ck('共享成员可见', !!shared);
  ck('带只读标记与主人名', shared && shared.shared === 1 && shared.owner_name === 'e2e_tmp_a', JSON.stringify(shared && shared.owner_name));
  const putB = await fetch(B + `/events/${ev1.id}`, { method: 'PUT', headers: H(tB), body: JSON.stringify({ title: '篡改' }) });
  ck('共享成员不可编辑（404 隔离）', putB.status === 404, String(putB.status));
  const evAdm = await j(await fetch(B + '/events', { headers: H(tAdm) }));
  ck('未共享者看不到', !evAdm.some((e) => e.title === 'E2E 提醒日程')); // 不能按 id 比：各租户库自增 id 会撞

  // 3) 共享站内通知（messageService 落主库 messages，module=event）
  const msg = db.prepare("SELECT id FROM messages WHERE to_user=? AND module='event' AND ref_id=?").get(uidB, Number(ev1.id));
  ck('共享即发站内通知', !!msg);

  // 4) 提醒巡检（直接跑服务逻辑）
  const remind = await import('../server/services/eventRemindService.js');
  await remind.checkAll();
  await new Promise((r) => setTimeout(r, 300));
  ck('+20min 未进窗口不提醒', !tdbA.prepare('SELECT remind_sent_at FROM events WHERE id=?').get(ev1.id).remind_sent_at);

  // 手动盖章后：不改时间不重置；改时间重置
  tdbA.prepare("UPDATE events SET remind_sent_at='2020-01-01 00:00:00' WHERE id=?").run(ev1.id);
  await fetch(B + `/events/${ev1.id}`, { method: 'PUT', headers: H(tA), body: JSON.stringify({ location: '会议室2' }) });
  ck('非时间字段编辑不重置提醒', tdbA.prepare('SELECT remind_sent_at FROM events WHERE id=?').get(ev1.id).remind_sent_at === '2020-01-01 00:00:00');
  await fetch(B + `/events/${ev1.id}`, { method: 'PUT', headers: H(tA), body: JSON.stringify({ start_time: localDT(10) }) });
  ck('改开始时间重置提醒', !tdbA.prepare('SELECT remind_sent_at FROM events WHERE id=?').get(ev1.id).remind_sent_at);

  await remind.checkAll();
  await new Promise((r) => setTimeout(r, 300));
  ck('+10min 进入窗口已提醒（盖章）', !!tdbA.prepare('SELECT remind_sent_at FROM events WHERE id=?').get(ev1.id).remind_sent_at);
  ck('remind_push=0 的不提醒', !tdbA.prepare('SELECT remind_sent_at FROM events WHERE id=?').get(ev2.id).remind_sent_at);
  // 重新打开提醒 → 重置
  await fetch(B + `/events/${ev1.id}`, { method: 'PUT', headers: H(tA), body: JSON.stringify({ remind_push: false }) });
  tdbA.prepare("UPDATE events SET remind_sent_at='2020-01-01 00:00:00' WHERE id=?").run(ev1.id);
  await fetch(B + `/events/${ev1.id}`, { method: 'PUT', headers: H(tA), body: JSON.stringify({ remind_push: true }) });
  ck('重新打开提醒也重置', !tdbA.prepare('SELECT remind_sent_at FROM events WHERE id=?').get(ev1.id).remind_sent_at);

  console.log(`\n${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  // 清理：会话/消息/临时用户/临时租户库（服务进程可能缓存句柄，文件删不掉就留着空壳）
  db.prepare('DELETE FROM sessions WHERE user_id IN (?,?)').run(uidA, uidB);
  db.prepare('DELETE FROM sessions WHERE token=?').run(tAdm);
  db.prepare("DELETE FROM messages WHERE to_user IN (?,?) OR from_user IN (?,?)").run(uidA, uidB, uidA, uidB);
  db.prepare('DELETE FROM vstudy_sessions WHERE user_id IN (?,?)').run(uidA, uidB);
  db.prepare('DELETE FROM vstudy_records WHERE user_id IN (?,?)').run(uidA, uidB);
  for (const uid of [uidA, uidB]) {
    try {
      const t = getTenantDb(uid);
      t.prepare('DELETE FROM events').run();
      closeTenantDb(uid);
    } catch { /* 无库或已关 */ }
    db.prepare('DELETE FROM users WHERE id=?').run(uid);
    for (const f of [`data/tenant-${uid}.sqlite`]) {
      try { fs.unlinkSync(f); } catch { /* 服务进程占用则留空壳（内容已清） */ }
    }
  }
}
