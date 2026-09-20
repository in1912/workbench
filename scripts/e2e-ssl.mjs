// E2E：设置 → SSL 自签名（v1.2.13）
// API 全链路：状态三态 / 生成（SAN 分类、天数钳制、ASN.1 证书用 node:crypto 解析回验 + openssl 交叉验证）/
// 下载 / 上传替换（配对校验）/ restart 探针（restart:false 不真退出）/ 非管理员 403
import { spawn, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'tmp-ssl-e2e');
const PORT = 3999;
const B = `http://127.0.0.1:${PORT}`;
process.env.DATA_DIR = DATA;

let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  <<< ' + extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
const srv = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', (d) => console.error('[srv-err]', String(d).slice(0, 200)));
await sleep(3000);

try {
  // ---------- 登录 ----------
  const lj = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test123456' }) })).json();
  const TK = lj.token;
  const HA = { Authorization: 'Bearer ' + TK, 'Content-Type': 'application/json' };

  // A1 初始状态：未配置
  let r = await fetch(`${B}/api/ssl/status`, { headers: HA });
  let j = await r.json();
  ck('A1 未配置时 status 200 且 configured=false', r.status === 200 && j.configured === false, JSON.stringify(j).slice(0, 120));

  // A2 非管理员 403
  await fetch(`${B}/api/users`, { method: 'POST', headers: HA, body: JSON.stringify({ username: 'u2', password: 'u234567', display_name: '二员' }) });
  const l2 = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'u2', password: 'u234567' }) })).json();
  const H2 = { Authorization: 'Bearer ' + l2.token, 'Content-Type': 'application/json' };
  r = await fetch(`${B}/api/ssl/status`, { headers: H2 });
  ck('A2a 普通用户 status 403', r.status === 403);
  r = await fetch(`${B}/api/ssl/generate`, { method: 'POST', headers: H2, body: JSON.stringify({ cn: 'x.example.com' }) });
  ck('A2b 普通用户 generate 403', r.status === 403);

  // A3 生成：SAN 混填自动分类 + 附加 localhost/127.0.0.1
  r = await fetch(`${B}/api/ssl/generate`, { method: 'POST', headers: HA, body: JSON.stringify({ cn: 'wb-test.example.com', san: ['192.168.50.10', 'alt.example.com'], days: 820, org: 'E2E Test' }) });
  j = await r.json();
  ck('A3a 生成成功', r.status === 200 && j.ok === true, JSON.stringify(j).slice(0, 160));
  ck('A3b 域名 SAN 分类（cn+附加+localhost）', (j.dns || []).includes('wb-test.example.com') && j.dns.includes('alt.example.com') && j.dns.includes('localhost'), JSON.stringify(j.dns));
  ck('A3c IP SAN 分类（附加+127.0.0.1）', (j.ips || []).includes('192.168.50.10') && j.ips.includes('127.0.0.1'), JSON.stringify(j.ips));

  // A4 文件落盘 + node:crypto 解析回验（ASN.1 编码正确性的硬校验）
  const certPem1 = fs.readFileSync(path.join(DATA, 'ssl', 'cert.pem'), 'utf8');
  const keyPem1 = fs.readFileSync(path.join(DATA, 'ssl', 'key.pem'), 'utf8');
  const c = new X509Certificate(certPem1);
  ck('A4a node:crypto 能解析（DER 结构正确）', c.subject.includes('CN=wb-test.example.com'), c.subject);
  ck('A4b SAN 完整（域名+IP）', /DNS:wb-test\.example\.com/.test(c.subjectAltName) && /DNS:alt\.example\.com/.test(c.subjectAltName)
    && /DNS:localhost/.test(c.subjectAltName) && /192\.168\.50\.10/.test(c.subjectAltName) && /127\.0\.0\.1/.test(c.subjectAltName), c.subjectAltName);
  ck('A4c 非 CA 证书（叶子证书）', c.ca === false);
  ck('A4d 有效期 ≈ 820 天', Math.abs((new Date(c.validTo) - Date.now()) / 86400000 - 820) < 2, String((new Date(c.validTo) - Date.now()) / 86400000));
  ck('A4e 私钥为 PKCS#8 PEM', keyPem1.includes('-----BEGIN PRIVATE KEY-----'));

  // A5 openssl 交叉验证（本机 git-bash 自带；没有则跳过）
  try {
    execSync('openssl version', { stdio: 'ignore' });
    const txt = execSync(`openssl x509 -in "${path.join(DATA, 'ssl', 'cert.pem')}" -noout -text`, { encoding: 'utf8' });
    ck('A5a openssl 解析通过且含 serverAuth EKU', /TLS Web Server Authentication/.test(txt));
    ck('A5b openssl 校验 CA:FALSE + SAN', /CA:FALSE/.test(txt) && /DNS:wb-test\.example\.com/.test(txt));
    const verify = execSync(`openssl verify -CAfile "${path.join(DATA, 'ssl', 'cert.pem')}" "${path.join(DATA, 'ssl', 'cert.pem')}"`, { encoding: 'utf8' });
    ck('A5c openssl 自签名自验通过', /OK/.test(verify), verify.trim());
  } catch (e) {
    console.log('  （openssl 不可用，跳过交叉验证）');
  }

  // A6 状态：已配置 + 待重启标记
  r = await fetch(`${B}/api/ssl/status`, { headers: HA });
  j = await r.json();
  ck('A6a status configured=true 且剩余天数 >818', j.configured === true && j.days_left > 818, JSON.stringify({ d: j.days_left }));
  ck('A6b pending_restart=true（文件比进程新）', j.pending_restart === true);
  ck('A6c key_matches=true', j.key_matches === true);
  ck('A6d renew_after = 到期前 30 天', Math.abs(new Date(j.renew_after) - (new Date(j.valid_to) - 30 * 86400000)) < 60000);

  // A7 下载
  r = await fetch(`${B}/api/ssl/file/cert`, { headers: HA });
  let t = await r.text();
  ck('A7a 下载 cert.pem', r.status === 200 && t.startsWith('-----BEGIN CERTIFICATE-----'));
  r = await fetch(`${B}/api/ssl/file/key`, { headers: HA });
  t = await r.text();
  ck('A7b 下载 key.pem', r.status === 200 && t.startsWith('-----BEGIN PRIVATE KEY-----'));
  r = await fetch(`${B}/api/ssl/file/cert`, { headers: H2 });
  ck('A7c 普通用户下载 403', r.status === 403);

  // A8 天数钳制 825
  r = await fetch(`${B}/api/ssl/generate`, { method: 'POST', headers: HA, body: JSON.stringify({ cn: 'clamp.example.com', days: 3000 }) });
  j = await r.json();
  ck('A8 days=3000 被钳到 825', j.days === 825, String(j.days));

  // A9 上传替换：不配对 400 / 配对成功
  const fd = new FormData();
  fd.append('cert', new Blob([certPem1]), 'cert.pem');
  fd.append('key', new Blob([fs.readFileSync(path.join(DATA, 'ssl', 'key.pem'), 'utf8')]), 'key.pem'); // 此时 key 是第二次生成的，与 cert1 不配对
  r = await fetch(`${B}/api/ssl/upload`, { method: 'POST', headers: { Authorization: 'Bearer ' + TK }, body: fd });
  j = await r.json();
  ck('A9a 证书私钥不配对 → 400', r.status === 400 && /不匹配/.test(j.error || ''), JSON.stringify(j));

  const fd2 = new FormData();
  fd2.append('cert', new Blob([certPem1]), 'cert.pem');
  fd2.append('key', new Blob([keyPem1]), 'key.pem');
  r = await fetch(`${B}/api/ssl/upload`, { method: 'POST', headers: { Authorization: 'Bearer ' + TK }, body: fd2 });
  j = await r.json();
  ck('A9b 配对上传成功', r.status === 200 && j.ok === true, JSON.stringify(j).slice(0, 120));
  ck('A9c 上传后状态回到第一张证书', j.status && j.status.subject && j.status.subject.includes('CN=wb-test.example.com'), j.status && j.status.subject);

  // A9d 备份目录存在（第 2 次生成覆盖第 1 张 + 上传覆盖第 2 张 = 2 份；不配对的上传被拒、不产生备份）
  const backups = fs.readdirSync(path.join(DATA, 'ssl')).filter((f) => f.startsWith('backup-'));
  ck('A9d 旧证书自动备份 ≥2 份', backups.length >= 2, String(backups.length));

  // A10 restart 探针：restart:false 不真退出
  r = await fetch(`${B}/api/ssl/restart`, { method: 'POST', headers: HA, body: JSON.stringify({ restart: false }) });
  j = await r.json();
  ck('A10a restart 探针返回 ok', r.status === 200 && j.ok === true);
  await sleep(1500);
  r = await fetch(`${B}/api/health`);
  ck('A10b 服务仍存活（未真退出）', r.status === 200);

  // A11 缺参校验
  r = await fetch(`${B}/api/ssl/generate`, { method: 'POST', headers: HA, body: JSON.stringify({}) });
  j = await r.json();
  ck('A11 CN 为空 → 400', r.status === 400 && /CN/.test(j.error || ''), JSON.stringify(j));
} catch (e) {
  fail++;
  console.error('  ✗ 脚本异常:', e.message);
} finally {
  srv.kill();
  await sleep(600);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
}
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
