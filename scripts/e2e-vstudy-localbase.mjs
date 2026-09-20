// E2E：本地直连设置（API + 通道行为）
// ① /settings/local-base：管理员保存/格式校验/清空；非管理员 403；GET 回读
// ② /settings/lan-addrs：管理员拿到建议列表（至少含 loopback 之外的候选或空数组），非管理员 403
// ③ /vstudy/file 跨源支持：ACAO * 头 + OPTIONS 预检 204（flv.js/文档解析跨源读取的前提）
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';

const ROOT = 'D:/CC/tmp-vstudy-test';
fs.mkdirSync(ROOT, { recursive: true });
fs.writeFileSync(ROOT + '/sample.png', Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

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
const origRoot = db.prepare("SELECT value FROM settings WHERE key='vstudy_root'").get();
db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('vstudy_root',?)").run(ROOT);

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };
const B = 'http://localhost:3000/api';

try {
  // ① 保存与校验
  let r = await fetch(B + '/settings/local-base', { method: 'POST', headers: HA, body: JSON.stringify({ base: 'http://127.0.0.1:3000' }) });
  ck('管理员保存合法地址', r.status === 200, String(r.status));
  r = await fetch(B + '/settings/local-base', { headers: HA });
  ck('GET 回读已保存地址', (await r.json()).base === 'http://127.0.0.1:3000');
  r = await fetch(B + '/settings/local-base', { method: 'POST', headers: HA, body: JSON.stringify({ base: 'ftp://1.2.3.4' }) });
  ck('非法协议被拒（400）', r.status === 400, String(r.status));
  r = await fetch(B + '/settings/local-base', { method: 'POST', headers: HA, body: JSON.stringify({ base: 'http://1.2.3.4/path/x' }) });
  ck('带路径被拒（400）', r.status === 400, String(r.status));
  if (member) {
    r = await fetch(B + '/settings/local-base', { method: 'POST', headers: HM, body: JSON.stringify({ base: 'http://1.2.3.4:1' }) });
    ck('非管理员保存被拒（403）', r.status === 403, String(r.status));
  } else console.log('  （库中无普通成员账号，跳过 403 用例）');

  // ② 局域网建议
  r = await fetch(B + '/settings/lan-addrs', { headers: HA });
  const la = await r.json();
  ck('lan-addrs 返回数组', r.status === 200 && Array.isArray(la.addrs), JSON.stringify(la).slice(0, 80));
  if (member) {
    r = await fetch(B + '/settings/lan-addrs', { headers: HM });
    ck('lan-addrs 非管理员 403', r.status === 403, String(r.status));
  }

  // ③ CORS（跨源读取前提）
  r = await fetch(B + '/vstudy/file?path=sample.png&token=' + tA, { headers: { Origin: 'http://lan.example:8080', Range: 'bytes=0-9' } });
  ck('文件响应带 ACAO *（跨源可读）', r.headers.get('access-control-allow-origin') === '*', String(r.headers.get('access-control-allow-origin')));
  ck('Expose 头含 Content-Range', (r.headers.get('access-control-expose-headers') || '').includes('Content-Range'));
  await r.body.cancel();
  const pre = await fetch(B + '/vstudy/file?path=sample.png&token=' + tA, {
    method: 'OPTIONS',
    headers: { Origin: 'http://lan.example:8080', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization, range' },
  });
  ck('OPTIONS 预检 204 + 放行 Authorization/Range', pre.status === 204
    && /authorization/i.test(pre.headers.get('access-control-allow-headers') || ''), `${pre.status} ${pre.headers.get('access-control-allow-headers')}`);

  // 清空 = 停用
  r = await fetch(B + '/settings/local-base', { method: 'POST', headers: HA, body: JSON.stringify({ base: '' }) });
  ck('清空停用', r.status === 200 && (await r.json()).base === '');
  r = await fetch(B + '/settings/local-base', { headers: HA });
  ck('清空后回读为空', (await r.json()).base === '');

  console.log(`\n${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  db.prepare("DELETE FROM settings WHERE key='vstudy_root'").run();
  if (origRoot) db.prepare("INSERT INTO settings(key,value) VALUES('vstudy_root',?)").run(origRoot.value);
  db.prepare('DELETE FROM sessions WHERE token IN (?,?)').run(tA, tM);
}
