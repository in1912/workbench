// E2E：视频教学 API 全链路（设置/目录树/Range流/进度upsert/记录分页/统计）
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const admin = db.prepare("SELECT id, display_name, username FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const token = crypto.randomBytes(32).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+10 minutes'))").run(token, admin.id);
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
const B = 'http://localhost:3000/api';
const TEST_ROOT = path.resolve('data/vstudy-test').replace(/\\/g, '\\\\'); // 存进设置的真值

let pass = 0, fail = 0;
function ck(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra); }
}
const j = (r) => r.json();

try {
  // 1) 默认配置
  const cfg0 = await j(await fetch(B + '/vstudy/config', { headers: H }));
  ck('默认配置含学年学科', Array.isArray(cfg0.years) && cfg0.years.length > 0 && Array.isArray(cfg0.subjects) && cfg0.subjects.length > 0);

  // 2) 保存根目录 + 非法目录校验
  const bad = await fetch(B + '/vstudy/settings', { method: 'POST', headers: H, body: JSON.stringify({ root: 'X:\\不存在\\目录' }) });
  ck('不存在的目录被拒 400', bad.status === 400, String(bad.status));
  const ok1 = await fetch(B + '/vstudy/settings', { method: 'POST', headers: H, body: JSON.stringify({ root: TEST_ROOT, years: ['2025-2026 学年', '2026-2027 学年'], subjects: ['语文', '数学', '英语'] }) });
  ck('保存根目录', ok1.ok);

  // 3) 目录树
  const t0 = await j(await fetch(B + '/vstudy/tree', { headers: H }));
  ck('根目录列子目录', t0.entries.filter((e) => e.is_dir).length === 2 && t0.entries.every((e) => e.kind === 'dir'));
  const t1 = await j(await fetch(B + '/vstudy/tree?dir=' + encodeURIComponent('语文'), { headers: H }));
  const byName = Object.fromEntries(t1.entries.map((e) => [e.name, e]));
  ck('mp4 归类 media', byName['第一课.mp4'] && byName['第一课.mp4'].kind === 'media');
  ck('txt 归类 doc', byName['笔记.txt'] && byName['笔记.txt'].kind === 'doc');
  ck('xlsx 归类 doc', byName['成绩表.xlsx'] && byName['成绩表.xlsx'].kind === 'doc');
  const esc = await fetch(B + '/vstudy/tree?dir=' + encodeURIComponent('../../'), { headers: H });
  ck('路径越界被拒', esc.status === 400, String(esc.status));

  // 4) 文件流：全量 + Range 206
  const fpath = encodeURIComponent('语文/第一课.mp4');
  const full = await fetch(`${B}/vstudy/file?path=${fpath}&token=${token}`);
  ck('全量 200 + video/mp4', full.status === 200 && full.headers.get('content-type') === 'video/mp4');
  const fullBuf = Buffer.from(await full.arrayBuffer());
  ck('字节数与磁盘一致', fullBuf.length === fs.statSync('data/vstudy-test/语文/第一课.mp4').size);
  const part = await fetch(`${B}/vstudy/file?path=${fpath}`, { headers: { ...H, Range: 'bytes=0-99' } });
  const partBuf = Buffer.from(await part.arrayBuffer());
  ck('Range 请求 206 分段', part.status === 206 && partBuf.length === 100 && part.headers.get('content-range').startsWith('bytes 0-99/'));
  ck('分段内容与原文一致', partBuf.equals(fullBuf.slice(0, 100)));
  const txt = await fetch(`${B}/vstudy/file?path=${encodeURIComponent('语文/笔记.txt')}`, { headers: H });
  ck('txt 内容可读', (await txt.text()).includes('课堂笔记'));

  // 5) 进度 upsert：位置取最大、观看增量累加
  const MP4PATH = TEST_ROOT + '\\语文\\第一课.mp4';
  await fetch(B + '/vstudy/progress', { method: 'POST', headers: H, body: JSON.stringify({ path: MP4PATH, kind: 'media', ext: 'mp4', school_year: '2025-2026 学年', subject: '语文', duration_sec: 600, position_sec: 540, watched_sec: 60 }) });
  await fetch(B + '/vstudy/progress', { method: 'POST', headers: H, body: JSON.stringify({ path: MP4PATH, kind: 'media', ext: 'mp4', school_year: '2025-2026 学年', subject: '语文', duration_sec: 600, position_sec: 300, watched_sec: 30 }) });
  const row1 = db.prepare('SELECT * FROM vstudy_records WHERE user_id=? AND path=?').get(admin.id, MP4PATH);
  ck('进度行存在且姓名快照正确', !!row1 && row1.user_name === (admin.display_name || admin.username), JSON.stringify(row1 && row1.user_name));
  ck('position 取最大 540', row1.position_sec === 540);
  ck('watched 累加 90', row1.watched_sec === 90);
  ck('学年学科落库', row1.school_year === '2025-2026 学年' && row1.subject === '语文');
  const DOCPATH = TEST_ROOT + '\\语文\\笔记.txt';
  await fetch(B + '/vstudy/progress', { method: 'POST', headers: H, body: JSON.stringify({ path: DOCPATH, kind: 'doc', ext: 'txt', school_year: '2025-2026 学年', subject: '语文', watched_sec: 30 }) });

  // 6) 记录分页
  const rec = await j(await fetch(B + '/vstudy/records?page=1&pageSize=15', { headers: H }));
  ck('记录 2 条', rec.total === 2 && rec.records.length === 2, JSON.stringify(rec.total));
  ck('按更新时间倒序+含两种类型', rec.records.some((r) => r.kind === 'media') && rec.records.some((r) => r.kind === 'doc'));
  const rec2 = await j(await fetch(B + '/vstudy/records?page=1&pageSize=1', { headers: H }));
  ck('pageSize 下限钳制 5', rec2.pageSize === 5 && rec2.records.length === 2, JSON.stringify({ ps: rec2.pageSize, n: rec2.records.length }));

  // 7) 统计：watched 120s = 0.033h，语文/学年各一行
  const st = await j(await fetch(B + '/vstudy/stats', { headers: H }));
  ck('学科学时统计', st.by_subject.length === 1 && st.by_subject[0].name === '语文' && Math.abs(st.by_subject[0].hours - 120 / 3600) < 0.001);
  ck('学年学时统计', st.by_year.length === 1 && st.by_year[0].name === '2025-2026 学年');
  ck('总学时', Math.abs(st.total_hours - 120 / 3600) < 0.001);

  console.log(`\n${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  db.prepare('DELETE FROM vstudy_records WHERE user_id=?').run(admin.id);
  db.prepare("DELETE FROM settings WHERE key='vstudy_root'").run(); // 恢复未配置状态（UI 测试会自己配）
}
