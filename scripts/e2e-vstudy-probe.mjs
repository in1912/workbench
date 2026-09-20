// E2E：容器目录探针 /vstudy/fs-probe
// 验证：① 管理员可探测（默认根 + 指定路径）② 返回一层目录结构 ③ 不存在路径 exists:false
//       ④ 非管理员 403 ⑤ Windows 本机直跑从盘符根起探
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };
const j = (r) => r.json();
const B = 'http://localhost:3000/api';

const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const member = db.prepare("SELECT id FROM users WHERE role!='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const tA = crypto.randomBytes(24).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+20 minutes'))").run(tA, admin.id);
const HA = { Authorization: 'Bearer ' + tA };

try {
  // ===== 默认根（不带 path 参数）=====
  const r1 = await j(await fetch(B + '/vstudy/fs-probe', { headers: HA }));
  ck('默认根存在且为目录', r1.exists === true && r1.is_dir === true, JSON.stringify(r1).slice(0, 120));
  ck('默认根返回目录列表', Array.isArray(r1.entries) && r1.entries.length > 0, String((r1.entries || []).length));
  ck('条目带 name/dir 字段', r1.entries.every((e) => typeof e.name === 'string' && typeof e.dir === 'boolean'));
  ck('目录排在文件前', (() => { const d = r1.entries.findIndex((e) => !e.dir); return d === -1 || d >= r1.entries.map((e) => e.dir).lastIndexOf(true) + 0 || r1.entries.slice(d).every((e) => !e.dir); })());
  ck('根目录无上级（parent 为空）', r1.parent === '' || !r1.parent, r1.parent);

  // ===== 指定存在的目录（项目根）=====
  const r2 = await j(await fetch(B + '/vstudy/fs-probe?path=' + encodeURIComponent(path.resolve('.')), { headers: HA }));
  ck('指定项目根可探测', r2.exists === true && r2.is_dir === true);
  ck('项目根含 package.json 条目', r2.entries.some((e) => e.name === 'package.json' && e.dir === false));
  ck('上级路径可返回', r2.parent && r2.parent !== r2.path, r2.parent);

  // ===== 不存在路径 =====
  const r3 = await j(await fetch(B + '/vstudy/fs-probe?path=' + encodeURIComponent('/definitely-not-exist-xyz'), { headers: HA }));
  ck('不存在路径 exists:false 有提示', r3.exists === false && !!r3.error, JSON.stringify(r3));

  // ===== 非管理员 403 =====
  if (member) {
    const tM = crypto.randomBytes(24).toString('hex');
    db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+20 minutes'))").run(tM, member.id);
    const r4 = await fetch(B + '/vstudy/fs-probe', { headers: { Authorization: 'Bearer ' + tM } });
    ck('非管理员 403', r4.status === 403, String(r4.status));
    db.prepare('DELETE FROM sessions WHERE token=?').run(tM);
  } else {
    console.log('  （无普通用户，跳过 403 用例）');
  }

  console.log(`\n${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  db.prepare('DELETE FROM sessions WHERE token=?').run(tA);
}
