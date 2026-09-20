// E2E：/vstudy/file 流式播放语义（边下边播的前提）
// 核心回归：后缀区间 bytes=-N 必须返回文件【末尾】N 字节——MP4 moov 常在文件尾，
// Safari 靠它读元数据；实现错（从头返回）会退化为整文件下载完才播。
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';

const ROOT = 'D:/CC/tmp-vstudy-test';
const FILE = ROOT + '/sample.mp4';
if (!fs.existsSync(FILE)) {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(FILE, crypto.randomBytes(5_000_000));
}
const local = fs.readFileSync(FILE);
const SIZE = local.length;

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const token = crypto.randomBytes(24).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+15 minutes'))").run(token, admin.id);
const orig = db.prepare("SELECT value FROM settings WHERE key='vstudy_root'").get();
db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('vstudy_root',?)").run(ROOT);

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };
const url = `http://localhost:3000/api/vstudy/file?path=sample.mp4&token=${token}`;
const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

try {
  // 中段区间：内容必须与本地文件对应切片一致
  let r = await fetch(url, { headers: { Range: 'bytes=100-199' } });
  let buf = Buffer.from(await r.arrayBuffer());
  ck('中段区间 206 + 长度正确', r.status === 206 && buf.length === 100, `${r.status} ${buf.length}`);
  ck('中段区间 Content-Range 正确', r.headers.get('content-range') === `bytes 100-199/${SIZE}`, r.headers.get('content-range'));
  ck('中段区间内容与源文件一致', eq([...buf], [...local.subarray(100, 200)]));

  // 开放区间 bytes=0-
  r = await fetch(url, { headers: { Range: 'bytes=0-' } });
  ck('开放区间返回 206 整段声明', r.status === 206 && r.headers.get('content-range') === `bytes 0-${SIZE - 1}/${SIZE}`, r.headers.get('content-range'));
  await r.body.cancel();

  // ★ 后缀区间 bytes=-100：末尾 100 字节（Safari 读 moov 的关键语义）
  r = await fetch(url, { headers: { Range: 'bytes=-100' } });
  buf = Buffer.from(await r.arrayBuffer());
  ck('后缀区间返回 206 + 长度 100', r.status === 206 && buf.length === 100, `${r.status} ${buf.length}`);
  ck('后缀区间 Content-Range 指向文件末尾', r.headers.get('content-range') === `bytes ${SIZE - 100}-${SIZE - 1}/${SIZE}`, r.headers.get('content-range'));
  ck('后缀区间内容 = 源文件末尾 100 字节', eq([...buf], [...local.subarray(SIZE - 100)]));

  // 后缀区间超过文件大小：clamp 到 0 起（整个文件）
  r = await fetch(url, { headers: { Range: 'bytes=-99999999' } });
  ck('超大后缀区间 clamp 为整文件', r.status === 206 && r.headers.get('content-range') === `bytes 0-${SIZE - 1}/${SIZE}`, r.headers.get('content-range'));
  await r.body.cancel();

  // 起点越界：416
  r = await fetch(url, { headers: { Range: `bytes=${SIZE + 10}-` } });
  ck('起点越界返回 416', r.status === 416, String(r.status));

  // 无 Range：200 完整 + Accept-Ranges
  r = await fetch(url);
  ck('无 Range 返回 200 + Accept-Ranges', r.status === 200 && r.headers.get('accept-ranges') === 'bytes' && Number(r.headers.get('content-length')) === SIZE, `${r.status} ${r.headers.get('content-length')}`);
  await r.body.cancel();

  console.log(`\n${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  db.prepare("DELETE FROM settings WHERE key='vstudy_root'").run();
  if (orig) db.prepare("INSERT INTO settings(key,value) VALUES('vstudy_root',?)").run(orig.value);
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
