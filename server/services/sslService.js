// 自签名 HTTPS 证书服务：状态读取 / 生成 / 校验 / 备份落盘。
// 零依赖——手写 ASN.1 DER 最小编码器拼 X.509 v3 证书（RSA 2048 + SHA-256），
// 不引入 node-forge 等新 npm 包（新依赖要完整版升级包才进容器，见第十六批教训）。
// 证书与私钥放 <dataDir>/ssl/cert.pem|key.pem（Docker = /data/ssl 数据卷，升级/重建容器不丢）；
// index.js 启动时检测到证书即启用同端口 HTTP/HTTPS 自适应（v1.2.1 起）——
// 替换证书文件后必须重启服务才生效（本模块 status() 的 pending_restart 会提示）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir } = require('../db');

const SSL_DIR = path.join(dataDir, 'ssl');
const CERT_PATH = path.join(SSL_DIR, 'cert.pem');
const KEY_PATH = path.join(SSL_DIR, 'key.pem');
const MAX_DAYS = 825;   // Chrome/苹果对自签名证书的信任上限（超过会拒绝）
const REMIND_DAYS = 30; // 到期前 N 天开始提醒
const STARTED_AT = Date.now(); // 进程启动时刻：证书文件比它新 = 已替换待重启

// ---------- ASN.1 DER 最小编码器（只为拼一张自签名证书服务） ----------
function derLen(n) {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, (n >> 8) & 0xff, n & 0xff]);
}
function der(tag, content) {
  return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]);
}
const seq = (...parts) => der(0x30, Buffer.concat(parts));
const setOf = (...parts) => der(0x31, Buffer.concat(parts));
function int(buf) {
  const b = Buffer.from(buf);
  return der(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b); // 正数最高位为 1 时补 0 保持非负
}
function oid(s) {
  const parts = s.split('.').map(Number);
  const out = [parts[0] * 40 + parts[1]];
  for (let i = 2; i < parts.length; i++) {
    let v = parts[i];
    const stack = [v & 0x7f];
    v = Math.floor(v / 128);
    while (v > 0) { stack.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
    out.push(...stack.reverse());
  }
  return der(0x06, Buffer.from(out));
}
const NULL = Buffer.from([0x05, 0x00]);
const bitStr = (buf) => der(0x03, Buffer.concat([Buffer.from([0x00]), buf])); // 0 个未用位
const octet = (buf) => der(0x04, buf);
const utf8 = (s) => der(0x0c, Buffer.from(String(s), 'utf8'));
function utcTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return der(0x17, Buffer.from(
    p(d.getUTCFullYear() % 100) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z', 'ascii'));
}
// X.509 Name：O=…, CN=…（RDN 顺序即浏览器展示顺序）
const x509Name = (cn, org) => seq(
  ...(org ? [setOf(seq(oid('2.5.4.10'), utf8(org)))] : []),
  setOf(seq(oid('2.5.4.3'), utf8(cn))),
);
const sigAlg = () => seq(oid('1.2.840.113549.1.1.11'), NULL); // sha256WithRSAEncryption
const TRUE = der(0x01, Buffer.from([0xff]));

const IP_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

// 生成自签名证书。san 为混填列表（域名或 IPv4 自动分类）；CN 恒进 SAN（Chrome 只认 SAN 不认 CN），
// 并自动附赠 localhost / 127.0.0.1（本机调试用）。返回 {certPem, keyPem, dnsList, ipList, days}
function generateCert({ cn, org = '', san = [], days = 820 }) {
  cn = String(cn || '').trim();
  if (!cn) throw new Error('通用名称（CN）不能为空');
  if (!/^[a-zA-Z0-9.*-]+$/.test(cn)) throw new Error('CN 只能是域名/主机名（字母数字点横线）');
  days = Math.min(Math.max(1, Math.floor(Number(days) || 820)), MAX_DAYS);
  const extras = (Array.isArray(san) ? san : String(san || '').split(/[,，\s]+/))
    .map((s) => String(s).trim()).filter(Boolean);
  const dnsList = [...new Set([cn, ...extras.filter((s) => !IP_RE.test(s)), 'localhost'])];
  const ipList = [...new Set(['127.0.0.1', ...extras.filter((s) => IP_RE.test(s))])];

  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  // SubjectPublicKeyInfo：crypto 直接导出整段现成 DER 元素，无需自己编
  const spki = publicKey.export({ type: 'spki', format: 'der' });

  // 扩展：basicConstraints CA:FALSE（关键）/ keyUsage 数字签名+密钥加密（关键）/ EKU serverAuth / SAN
  const exts = seq(
    seq(oid('2.5.29.19'), TRUE, octet(seq())), // 空 SEQUENCE = CA:FALSE
    seq(oid('2.5.29.15'), TRUE, octet(der(0x03, Buffer.from([0x05, 0xa0])))), // digitalSignature|keyEncipherment
    seq(oid('2.5.29.37'), octet(seq(oid('1.3.6.1.5.5.7.3.1')))),
    seq(oid('2.5.29.17'), octet(seq(
      ...dnsList.map((d) => der(0x82, Buffer.from(d, 'ascii'))), // [2] dNSName
      ...ipList.map((ip) => der(0x87, Buffer.from(ip.split('.').map(Number)))), // [7] iPAddress
    ))),
  );

  const notBefore = new Date(Date.now() - 60 * 1000); // 往前拨 1 分钟，防设备时钟略快
  const notAfter = new Date(Date.now() + days * 86400000);
  const issuer = x509Name(cn, org);
  const tbs = seq(
    der(0xa0, int([2])), // version: v3（[0] EXPLICIT）
    int(crypto.randomBytes(16)), // serialNumber
    sigAlg(),
    issuer,
    seq(utcTime(notBefore), utcTime(notAfter)), // validity
    issuer, // 自签名：subject = issuer
    spki,
    der(0xa3, exts), // [3] EXPLICIT extensions
  );
  const signature = crypto.sign('RSA-SHA256', tbs, privateKey);
  const certDer = seq(tbs, sigAlg(), bitStr(signature));
  const b64 = certDer.toString('base64').replace(/(.{64})/g, '$1\n').trim();
  return {
    certPem: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    dnsList, ipList, days,
  };
}

// 证书与私钥是否配对（公钥一致）
function pubKeyMatch(cert, keyPem) {
  try {
    const a = cert.publicKey.export({ type: 'spki', format: 'der' });
    const b = crypto.createPublicKey(keyPem).export({ type: 'spki', format: 'der' });
    return a.equals(b);
  } catch { return false; }
}

// 旧证书备份到 ssl/backup-<时间戳>/（copy 而非 move：重启前旧文件始终可读）
function writePair(certPem, keyPem) {
  fs.mkdirSync(SSL_DIR, { recursive: true });
  const hasCert = fs.existsSync(CERT_PATH), hasKey = fs.existsSync(KEY_PATH);
  if (hasCert || hasKey) {
    const bk = path.join(SSL_DIR, 'backup-' + new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(bk, { recursive: true });
    if (hasCert) fs.copyFileSync(CERT_PATH, path.join(bk, 'cert.pem'));
    if (hasKey) fs.copyFileSync(KEY_PATH, path.join(bk, 'key.pem'));
  }
  fs.writeFileSync(CERT_PATH, certPem);
  fs.writeFileSync(KEY_PATH, keyPem);
}

// 当前证书状态（未配置/已配置/解析失败三态）
function status() {
  let certMs = 0, keyMs = 0;
  const fi = (p) => {
    try {
      const st = fs.statSync(p);
      if (p === CERT_PATH) certMs = st.mtime.getTime(); else keyMs = st.mtime.getTime();
      return { exists: true, size: st.size, mtime: st.mtime.toISOString() };
    } catch { return { exists: false }; }
  };
  const out = {
    dir: SSL_DIR, max_days: MAX_DAYS, remind_days: REMIND_DAYS,
    cert_file: fi(CERT_PATH), key_file: fi(KEY_PATH),
  };
  out.has_pair = out.cert_file.exists && out.key_file.exists;
  if (!out.cert_file.exists) return { ...out, configured: false };
  try {
    const certPem = fs.readFileSync(CERT_PATH, 'utf8');
    const c = new crypto.X509Certificate(certPem);
    const to = new Date(c.validTo).getTime();
    const daysLeft = Math.ceil((to - Date.now()) / 86400000);
    return {
      ...out, configured: true,
      subject: c.subject, issuer: c.issuer, ca: c.ca,
      valid_from: new Date(c.validFrom).toISOString(),
      valid_to: new Date(to).toISOString(),
      days_left: daysLeft,
      renew_after: new Date(to - REMIND_DAYS * 86400000).toISOString(), // 建议在到期前 30 天窗口内换新
      san: c.subjectAltName || '',
      key_matches: out.key_file.exists ? pubKeyMatch(c, fs.readFileSync(KEY_PATH, 'utf8')) : null,
      // 证书/私钥文件比进程启动新 = 替换后还没重启，对外仍在用旧证书
      pending_restart: Math.max(certMs, keyMs) > STARTED_AT,
    };
  } catch (e) {
    return { ...out, configured: true, error: '证书解析失败：' + e.message };
  }
}

module.exports = { generateCert, writePair, pubKeyMatch, status, CERT_PATH, KEY_PATH, SSL_DIR, MAX_DAYS, REMIND_DAYS };
