// 生产智作平台验证：node scripts/prod-zhizu-verify.mjs
// 部署 v1.6.2-fix1 后跑：/zhizu/ 首页、静态资产、health、经代理登录默认管理员。
import fs from 'node:fs';

const BASE = process.env.WB_URL || 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) 管理员登录工作台（仅用于 system-info 版本确认）
const lr = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: process.env.WB_USER || 'admin', password: process.env.WB_PASS || 'admin123' }),
});
const lj = await lr.json().catch(() => ({}));
const HA = { Authorization: 'Bearer ' + (lj.token || lj.data?.token || '') };
const si = await fetch(`${BASE}/api/system-info`, { headers: HA }).then((r) => r.json()).catch(() => ({}));
console.log(`[0] 工作台版本: ${si.version ?? '未知'}`);

// 2) /zhizu/ 首页（允许子进程启动窗口，最多试 10 轮）
let html = '';
for (let i = 0; i < 10; i++) {
  const r = await fetch(`${BASE}/zhizu/`).catch(() => null);
  if (r && r.ok) { html = await r.text(); console.log(`[1] /zhizu/ 200（第 ${i + 1} 轮探到）`); break; }
  console.log(`[1] /zhizu/ ${r ? r.status : 'fetch failed'}，5s 后重试…`);
  await sleep(5000);
}
if (!html.includes('/zhizu/')) { console.error('!! /zhizu/ 未返回智作平台首页'); process.exit(1); }
const asset = (html.match(/(?:src|href)="(\/zhizu\/assets\/[^"]+)"/) || [])[1];
if (asset) {
  const ar = await fetch(`${BASE}${asset}`);
  console.log(`[2] 静态资产 ${asset.split('/').pop()}: ${ar.status}（${ar.headers.get('content-type')}）`);
}

// 3) health
const hr = await fetch(`${BASE}/zhizu/api/health`).catch(() => null);
console.log(`[3] /zhizu/api/health: ${hr ? hr.status + ' ' + (await hr.text()).slice(0, 120) : 'fetch failed'}`);

// 4) 经代理登录智作平台默认管理员（生产全新库，默认 admin/admin123）
const zl = await fetch(`${BASE}/zhizu/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
}).catch(() => null);
const zj = zl ? await zl.json().catch(() => ({})) : {};
console.log(`[4] 智作平台登录 admin: HTTP ${zl ? zl.status : 'fetch failed'} → ${JSON.stringify(zj).slice(0, 160)}`);
console.log(zl && zl.ok ? '\n全部通过。提醒：生产智作平台是全新库（默认 admin/admin123），请登录后立即改密。' : '\n有未通过项。');
