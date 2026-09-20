// 隔离复现：index.js 的 HTTP/HTTPS 同端口嗅探转发，对「多段到达的 POST 大 body」是否乱序/丢字节。
// 用法：node scripts/repro-sniff-order.mjs [old|fixed]   （old=v1.2.1 线上写法：connect 后才 write 首段；fixed=立即 write）
import net from 'node:net';
import http from 'node:http';
import crypto from 'node:crypto';

const MODE = process.argv[2] === 'fixed' ? 'fixed' : 'old';
const FRONT_PORT = 3991;

// 内部 http 服务：收完整 body，回显 sha256 + 长度
const inner = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    res.end(JSON.stringify({ len: buf.length, sha: crypto.createHash('sha256').update(buf).digest('hex') }));
  });
});

const listenLocal = (srv) => new Promise((r, j) => { srv.once('error', j); srv.listen(0, '127.0.0.1', () => r(srv.address().port)); });
const tcpPort = await listenLocal(inner);

const front = net.createServer((socket) => {
  socket.once('data', (buf) => {
    const target = net.connect(tcpPort, '127.0.0.1');
    if (MODE === 'old') {
      // v1.2.1 线上写法：等 connect 事件才转发首段——后续段若先到，写入顺序颠倒
      target.on('connect', () => target.write(buf));
    } else {
      // 修复写法：立即入队（连接建立前排队，flush 严格按入队顺序）
      target.write(buf);
    }
    target.on('error', () => socket.destroy());
    socket.on('error', () => target.destroy());
    socket.pipe(target);
    target.pipe(socket);
  });
  socket.on('error', () => socket.destroy());
});
await new Promise((r) => front.listen(FRONT_PORT, r));
console.log(`[${MODE}] front :${FRONT_PORT} -> inner :${tcpPort}`);

// 客户端：POST 2MB 伪随机 body（多 TCP 段）
let pass = 0, fail = 0;
for (let i = 0; i < 8; i++) {
  const body = crypto.randomBytes(2 * 1024 * 1024);
  const want = crypto.createHash('sha256').update(body).digest('hex');
  try {
    const r = await fetch(`http://127.0.0.1:${FRONT_PORT}/echo`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body });
    const j = await r.json().catch(() => ({ len: -1, sha: 'parse-error' }));
    const ok = r.status === 200 && j.len === body.length && j.sha === want;
    ok ? pass++ : fail++;
    console.log(`  #${i + 1} HTTP ${r.status} len=${j.len}/${body.length} ${ok ? 'OK' : 'MISMATCH sha=' + j.sha.slice(0, 12) + ' want=' + want.slice(0, 12)}`);
  } catch (e) {
    fail++;
    console.log(`  #${i + 1} 请求异常: ${e.message}${e.cause ? ' / ' + e.cause.message : ''}`);
  }
}
console.log(`[${MODE}] 结果: ${pass} 通过 / ${fail} 失败`);
front.close(); inner.close();
process.exit(fail ? 1 : 0);
