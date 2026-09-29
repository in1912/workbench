// 生产部署脚本：node scripts/deploy-package.mjs <升级包.zip路径> [期望版本]
// 流程：登录 → 上传 /api/upgrade/apply（容器自动重启）→ 轮询 /api/system-info 到版本一致。
// 目标地址与账号密码一律走环境变量（不写默认值，避免仓库泄漏部署目标）：
//   WB_URL=https://你的域名 WB_USER=账号 WB_PASS=密码 node scripts/deploy-package.mjs <zip> [版本]
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

const BASE = process.env.WB_URL || '';
const USER = process.env.WB_USER || '';
const PASS = process.env.WB_PASS || '';
if (!BASE || !USER || !PASS) {
  console.error('缺少 WB_URL / WB_USER / WB_PASS 环境变量（目标工作台地址与登录凭证）');
  process.exit(1);
}

const zipPath = process.argv[2];
const wantVer = process.argv[3] || '';
if (!zipPath || !fs.existsSync(zipPath)) {
  console.error('用法：node scripts/deploy-package.mjs <升级包.zip路径> [期望版本，如 v1.2.2]');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) 登录拿 token
const lr = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: USER, password: PASS }),
});
const lj = await lr.json().catch(() => ({}));
const token = lj.token || lj.data?.token;
if (!lr.ok || !token) { console.error('登录失败:', lr.status, JSON.stringify(lj)); process.exit(1); }
console.log(`[1] 登录成功（${lj.user?.username || lj.user?.display_name || USER}）`);
const HA = { Authorization: 'Bearer ' + token };

// 2) 上传升级包（服务端应用后 process.exit → Docker restart:always 拉起）
// 注意：不能用 fetch 一把梭。生产 v1.2.1 的 HTTP/HTTPS 同端口嗅探器有首段乱序 bug
// （等 connect 才写首段，大 body 的后续段先到就打乱字节序）——这里手动构造 multipart，
// 先 flushHeaders 只发请求头，停 120ms（让嗅探器的内部 connect 先完成），再发 body。
async function uploadApply() {
  const boundary = '----wbdeploy' + Date.now();
  const name = path.basename(zipPath);
  const data = fs.readFileSync(zipPath);
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/zip\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const u = new URL('/api/upgrade/apply', BASE);
  const mod = u.protocol === 'https:' ? https : http; // 支持 https 域名部署（自签证书宽松校验：目标本就是自己的服务器）
  return new Promise((resolve, reject) => {
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname, method: 'POST',
      rejectUnauthorized: false,
      headers: {
        ...HA,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': head.length + data.length + tail.length,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.flushHeaders();        // 请求头单独成段先走（嗅探器的首段）
    setTimeout(() => {         // 等 sniff→connect 完成，再按序发 body
      req.write(head);
      req.write(data);
      req.end(tail);
    }, 120);
  });
}

let applyRes = null;
for (let i = 0; i < 3; i++) {
  try {
    applyRes = await uploadApply();
    if (applyRes.status < 500) break;
  } catch (e) { // 容器重启瞬间连接被切，属预期
    console.log(`    上传连接异常（${e.message}），${i < 2 ? '重试' : '放弃'}…`);
    await sleep(3000);
  }
}
console.log(`[2] 应用升级包: HTTP ${applyRes?.status} ${applyRes?.text?.slice(0, 300)}`);

// 3) 轮询版本（重启窗口内请求可能失败，忽略后重试）
let info = null;
for (let i = 0; i < 30; i++) {
  try {
    const r = await fetch(`${BASE}/api/system-info`, { headers: HA });
    if (r.ok) {
      info = await r.json().catch(() => ({}));
      if (!wantVer || info.version === wantVer) break;
    }
  } catch { /* 重启中 */ }
  await sleep(3000);
}
console.log(`[3] 当前生产版本: ${info?.version ?? '（未知）'}${wantVer ? `（期望 ${wantVer}）` : ''}`);
if (wantVer && info?.version !== wantVer) process.exit(1);
console.log('部署完成。');
