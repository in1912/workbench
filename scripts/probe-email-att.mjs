// 生产邮件附件诊断：登录 → 附件目录配置 → 收件箱行(attachments 值) → 触发补拉 → 再查对比
const BASE = 'http://localhost:3000';
const USER = process.env.WB_USER || 'admin';
const PASS = process.env.WB_PASS || 'admin123';

const lr = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
});
const lj = await lr.json();
if (!lj.token) { console.error('登录失败', lr.status, JSON.stringify(lj)); process.exit(1); }
const HA = { Authorization: 'Bearer ' + lj.token, 'Content-Type': 'application/json' };
console.log('[1] 登录 OK');

// 附件目录配置
const ac = await (await fetch(`${BASE}/api/emails/attach-config`, { headers: HA })).json();
console.log('[2] 附件目录配置:', JSON.stringify(ac));

// 收件箱行
async function dump(tag) {
  const r = await fetch(`${BASE}/api/emails/local?folder=inbox&pageSize=30&page=1`, { headers: HA });
  const j = await r.json();
  console.log(`[${tag}] 收件箱 total=${j.total}`);
  for (const m of (j.mails || []).slice(0, 30)) {
    let att = m.attachments;
    let attDesc = 'NULL';
    if (att !== null && att !== undefined && att !== '') {
      try {
        const list = JSON.parse(att);
        attDesc = list.length ? `JSON ${list.length} 个: ${list.map(a => `${a.filename}(${a.size}B,stored=${a.stored},path=${a.path || '空'})`).join(' | ').slice(0, 150)}` : "'[]' 空数组";
      } catch { attDesc = `坏JSON: ${String(att).slice(0, 60)}`; }
    } else if (att === '') attDesc = "'' 空串";
    console.log(`  uid=${m.uid} ${String(m.date || '').slice(0, 16)} 附件列=${attDesc}`);
    console.log(`    主题: ${(m.subject || '').slice(0, 60)} | 正文长度=${(m.body || '').length}`);
  }
  return j;
}
await dump('3');
