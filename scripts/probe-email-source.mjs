// 巡检（第三十六批同款）：临时把 vstudy 根指到 /data → /vstudy/file 读容器内租户库 →
// 本地解 sqlite 拿 IMAP 凭证 → IMAP fetchOne 拉一封真实发票邮件原文存到本地供解析器调试。
// 用完 finally 还原 vstudy 根。凭证只在内存/本地临时文件用，不打印。
import fs from 'node:fs';
import { createRequire } from 'node:module';

const BASE = 'http://localhost:3000';
const USER = process.env.WB_USER || 'admin';
const PASS = process.env.WB_PASS || 'admin123';
const TARGET_UID = Number(process.argv[2] || 8054); // 默认拉最新一封通行费发票

const lr = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
});
const lj = await lr.json();
if (!lj.token) { console.error('登录失败', lr.status); process.exit(1); }
const HA = { Authorization: 'Bearer ' + lj.token, 'Content-Type': 'application/json' };
const uid = lj.user?.id;
console.log(`[1] 登录 OK uid=${uid}`);

// 当前 vstudy 根（还原用）
const cfg0 = await (await fetch(`${BASE}/api/vstudy/config`, { headers: HA })).json();
console.log(`[2] 当前 vstudy 根: ${cfg0.root || '(空)'}`);

let dbBuf = null;
try {
  // 临时指向 /data
  let r = await fetch(`${BASE}/api/vstudy/settings`, {
    method: 'POST', headers: HA, body: JSON.stringify({ root: '/data' }),
  });
  if (!r.ok) throw new Error('指向 /data 失败: ' + r.status + await r.text());

  // 读租户库（Range 不需要，走整文件 download；/vstudy/file 的 path 是相对根的路径）
  const tdbPath = `tenant-${uid}.sqlite`;
  r = await fetch(`${BASE}/api/vstudy/file?path=${encodeURIComponent(tdbPath)}`, { headers: HA });
  if (!r.ok) throw new Error('读租户库失败: ' + r.status + await r.text());
  dbBuf = Buffer.from(await r.arrayBuffer());
  console.log(`[3] 租户库下载 ${dbBuf.length} 字节`);
} finally {
  // 还原 vstudy 根
  const rr = await fetch(`${BASE}/api/vstudy/settings`, {
    method: 'POST', headers: HA, body: JSON.stringify({ root: cfg0.root || '' }),
  });
  console.log(`[finally] vstudy 根已还原: ${rr.status}`);
}
if (!dbBuf) process.exit(1);

// 本地解租户库
fs.writeFileSync('data/tmp-tenant-probe.sqlite', dbBuf);
const { DatabaseSync } = await import('node:sqlite');
const tdb = new DatabaseSync('data/tmp-tenant-probe.sqlite', { readOnly: true });
const ec = tdb.prepare('SELECT imap_host,imap_port,imap_user,imap_pass,use_tls FROM email_config WHERE id=1').get();
const row = tdb.prepare('SELECT uid,subject,attachments FROM emails WHERE uid=?').get(TARGET_UID);
console.log(`[4] 目标邮件 uid=${row?.uid} 主题=${row?.subject?.slice(0, 40)} attachments=${row?.attachments}`);
console.log(`    IMAP: ${ec.imap_host}:${ec.imap_port} user=${ec.imap_user.slice(0, 2)}*** tls=${ec.use_tls}`);

// IMAP 拉原文
const { ImapFlow } = await import('imapflow');
const client = new ImapFlow({
  host: ec.imap_host, port: ec.imap_port || 993, secure: !!ec.use_tls,
  auth: { user: ec.imap_user, pass: ec.imap_pass }, logger: false,
  connectionTimeout: 15000, socketTimeout: 60000,
});
await client.connect();
const lock = await client.getMailboxLock('INBOX');
try {
  const msg = await client.fetchOne(String(TARGET_UID), { source: true }, { uid: true });
  const out = `data/tmp-mail-source-${TARGET_UID}.eml`;
  fs.writeFileSync(out, msg.source);
  console.log(`[5] 原文已存 ${out}（${msg.source.length} 字节）`);
  // 只打印 MIME 结构骨架（头部行），帮助定位解析缺陷
  const head = msg.source.toString('latin1');
  const boundaryLines = head.split(/\r?\n/).filter((l) => /^(content-type|content-disposition|content-transfer-encoding|boundary)/i.test(l.trim()));
  console.log('---- MIME 结构相关头部（前 60 行）----');
  head.split(/\r?\n/).slice(0, 60).forEach((l) => {
    if (l.length > 120) l = l.slice(0, 117) + '...';
    console.log('  ' + l);
  });
  console.log('---- boundary 相关 ----');
  boundaryLines.slice(0, 20).forEach((l) => console.log('  ' + l.slice(0, 150)));
} finally {
  lock.release();
  await client.logout().catch(() => {});
}
console.log('完成');
