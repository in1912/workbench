// 本地验证：修复后的嗅探器（首段立即入队）对 TLS 分支是否正常。
// 复刻 index.js 双端口结构：net 前置 → 内部 http / https（127.0.0.1 随机端口），
// 用生产同款自签名证书（data/ssl）起 https，再 curl -k 走 TLS + 大 POST 走 HTTP。
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FRONT_PORT = 3992;
const CERT = path.resolve('data/ssl/cert.pem');
const KEY = path.resolve('data/ssl/key.pem');
if (!fs.existsSync(CERT) || !fs.existsSync(KEY)) { console.error('缺少本地证书 data/ssl/*.pem'); process.exit(1); }

const handler = (req, res) => {
  if (req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const buf = Buffer.concat(chunks);
      res.end(JSON.stringify({ len: buf.length, sha: crypto.createHash('sha256').update(buf).digest('hex') }));
    });
    return;
  }
  res.end('ok');
};
const httpInner = http.createServer(handler);
const httpsInner = https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, handler);
const listenLocal = (srv) => new Promise((r, j) => { srv.once('error', j); srv.listen(0, '127.0.0.1', () => r(srv.address().port)); });
const [tcpPort, tlsPort] = await Promise.all([listenLocal(httpInner), listenLocal(httpsInner)]);

const front = net.createServer((socket) => {
  socket.once('data', (buf) => {
    const target = net.connect(buf[0] === 0x16 ? tlsPort : tcpPort, '127.0.0.1');
    target.write(buf); // 修复写法：与 server/index.js 当前代码一致
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
    socket.pipe(target);
    target.pipe(socket);
  });
  socket.on('error', () => socket.destroy());
});
await new Promise((r) => front.listen(FRONT_PORT, r));
console.log(`front :${FRONT_PORT} -> tcp:${tcpPort} tls:${tlsPort}`);
console.log('请另开终端执行：');
console.log(`  curl -sk https://localhost:${FRONT_PORT}/api/system-info`);
console.log(`  node -e "fetch('http://localhost:${FRONT_PORT}/x',{method:'POST',body:require('crypto').randomBytes(2e6)}).then(r=>r.text()).then(console.log)"`);
// 留 25 秒窗口给外部探测
setTimeout(() => { front.close(); httpInner.close(); httpsInner.close(); process.exit(0); }, 25000);
