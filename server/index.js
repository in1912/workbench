const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const express = require('express');
const { onImported, getTenantDb, dataDir } = require('./db');
const ipBan = require('./services/ipBanService');
const auth = require('./auth');
const coreRoutes = require('./routes/core');
const miscRoutes = require('./routes/misc');
const payRoutes = require('./routes/payRoutes');
const upgradeRoutes = require('./routes/upgradeRoutes');
const petRoutes = require('./routes/petRoutes');
const typingRoutes = require('./routes/typingRoutes');
const ttsRoutes = require('./routes/ttsRoutes');
const vstudyRoutes = require('./routes/vstudyRoutes');
const pianoRoutes = require('./routes/pianoRoutes');
const vibeRoutes = require('./routes/vibeRoutes');
const wishRoutes = require('./routes/wishRoutes');
// 三大测试中心（mbti/dep/pro）v1.8.0 已随「私有项目」页整体移除，迁至独立项目 Private_Mini
const sslRoutes = require('./routes/sslRoutes');
const monitorRoutes = require('./routes/monitorRoutes');
const mihomeRoutes = require('./routes/mihomeRoutes');
const authRoutes = require('./routes/authRoutes');
const scheduler = require('./scheduler');
const dingtalkStream = require('./services/dingtalkStreamService');

const app = express();
// IP 黑名单（v1.3.4）：全站第一道闸——被封禁的 IP 连静态页都拿不到 403（含登录接口）。
// 放在 express.json 之前：被拒请求连请求体都不解析。名单在 ipBanService 内存快照，增删即时生效。
app.use((req, res, next) => {
  if (ipBan.isBanned(ipBan.clientIp(req))) {
    if (req.path.startsWith('/api')) return res.status(403).json({ error: '该 IP 已被系统封禁，禁止访问' });
    return res.status(403).type('text/html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;padding:40px;text-align:center;color:#555"><h2>⛔ 403</h2><p>该 IP 已被系统封禁，禁止访问本系统。</p></body>');
  }
  next();
});

// 智作平台（文案库，v1.6.2）：子进程随工作台启动，对外仅暴露同源路径 /zhizu（效率工具→智作平台 iframe 嵌入）。
// 必须挂在 express.json 之前：请求体原样透传给子进程解析（含 multipart），代理不做任何改写；
// 其登录/角色体系（wk_token）独立于工作台（wb_token），同源 iframe 下互不干扰。
const zhizu = require('./services/zhizuService');
app.use('/zhizu', zhizu.proxy);
zhizu.start();

app.use(express.json({ limit: '12mb' })); // 家庭图床图片以 base64 JSON 提交（原图上限 5MB ≈ base64 6.7MB）

// 花生壳 HTTP 型映射会直接掐掉 PATCH 方法的连接（实测 GET/POST/PUT/DELETE 均可达、PATCH 必断）；
// 前端 api.patch 改发 PUT + X-HTTP-Method: PATCH 头，这里在路由分发前还原为 PATCH，全部 PATCH 路由零改动。
app.use((req, res, next) => {
  if (req.method === 'PUT' && req.headers['x-http-method'] === 'PATCH') req.method = 'PATCH';
  next();
});

// 花生壳中转声明 keep-alive 却在每个响应后杀连接，客户端复用死套接字 → "failed to fetch" 阵发失败；
// 显式 Connection: close 让每个请求走全新连接（实测全新连接 100% 可达），局域网直连握手开销可忽略。
app.use((req, res, next) => {
  res.setHeader('Connection', 'close');
  next();
});

// 全局认证：除登录/健康检查外，所有 /api 接口都需要登录；并校验页面权限
// 注意：req.path 在挂载于 /api 的中间件中是相对路径（如 /auth/login、/health）
// 匹配规则：全等，或 req.path 以 条目+/ 开头
// （v1.8.0：mbti/dep/pro 测试中心免登录前缀已随「私有项目」页移除，迁至独立项目 Private_Mini）
const EXEMPT = ['/auth/login', '/health', '/tile', '/map-static', '/system-info', '/dingtalk/bind/callback', '/auth/dingtalk-info', '/auth/dingtalk/login',
  '/monitor/agent/config', '/monitor/agent/shot',
  '/clipboard/agent-register', '/clipboard/agent-push', // 剪贴板采集代理（key+uid 即凭证：登记/推送，v1.6.2）
  '/vibe/client-download', '/vibe/client-register', '/vibe/job', // 录音转写客户端（key 即凭证：引擎下发/登记回连/拉取模式领任务回传结果）
  '/mihome/callback', // 米家 OAuth 回跳（小米浏览器重定向落地，无工作台登录态；只认 state 会话 + 一次性 code）
  '/pets/desktop']; // 桌面宠物（key 即凭证：state/frame/action）
app.use('/api', (req, res, next) => {
  if (EXEMPT.some((e) => req.path === e || req.path.startsWith(e + '/'))) return next();
  const user = auth.resolveUser(req);
  if (!user) return res.status(401).json({ error: '未登录或会话已过期' });
  const page = auth.pageForPath(req.path);
  const tab = page ? auth.tabForPath(page, req.path) : null;
  if (!auth.canAccess(user, page, tab)) {
    return res.status(403).json({ error: '当前账号无权访问该功能' });
  }
  req.user = user;
  // 多租户：注入该用户的租户库（首次访问惰性创建 data/tenant-<uid>.sqlite）
  req.tdb = getTenantDb(user.id);
  next();
});

// API 路由
app.use('/api', authRoutes);
app.use('/api', coreRoutes);
app.use('/api', miscRoutes);
app.use('/api', payRoutes);
app.use('/api', upgradeRoutes);
app.use('/api', petRoutes);
app.use('/api', typingRoutes);
app.use('/api', ttsRoutes);
app.use('/api', vstudyRoutes);
app.use('/api', pianoRoutes);
app.use('/api', vibeRoutes);
app.use('/api', wishRoutes);
app.use('/api', monitorRoutes);
app.use('/api', mihomeRoutes);
app.use('/api/ssl', sslRoutes);

// 健康检查（本地直连探测端点：公网页面要跨源 fetch 本地地址的 /api/health 判断可达性，放行跨源读取）
app.get('/api/health', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ ok: true, time: new Date().toISOString() });
});

// 托管前端构建产物：web/dist 下可能累积多个时间戳子目录，每次请求时解析最新的（重建前端后无需重启服务）
const webDistRoot = path.join(__dirname, '..', 'web', 'dist');
function latestDist() {
  try {
    const subs = fs.readdirSync(webDistRoot)
      .filter((f) => fs.statSync(path.join(webDistRoot, f)).isDirectory() && fs.existsSync(path.join(webDistRoot, f, 'index.html')))
      .sort();
    if (subs.length) return path.join(webDistRoot, subs[subs.length - 1]);
  } catch { /* dist 目录不存在 */ }
  return null;
}
let webDist = latestDist();
if (webDist) {
  // 静态处理器按目录缓存：目录变了才重建（正常请求零开销）
  let staticDir = '', staticHandler = null;
  const staticFor = (dir) => {
    if (dir !== staticDir) { staticDir = dir; staticHandler = express.static(dir); }
    return staticHandler;
  };
  // 强制不缓存：避免浏览器/预览面板加载旧版前端（每次构建产物 hash 变化）
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
    }
    next();
  });
  app.use((req, res, next) => {
    const dir = latestDist() || webDist;
    staticFor(dir)(req, res, next);
  });
  app.get(/^(?!\/api).*/, (req, res) => res.sendFile(path.join(latestDist() || webDist, 'index.html')));
  console.log('[web] 前端静态资源已加载:', webDist, '（后续构建自动生效）');
} else {
  console.log('[web] 未找到前端构建产物，仅 API 模式（请先执行 npm run build:web）');
}

const PORT = process.env.PORT || 3000;

// ---------- HTTPS（自签名证书支持）：data/ssl/cert.pem + key.pem 存在即启用 ----------
// 同一端口 HTTP/HTTPS 自适应：前置 net 服务嗅探首字节（TLS 握手 = 0x16），
// 转给内部 https 端口，其余走内部 http 端口——老的 http 访问（局域网书签/花生壳）不受影响，
// https://同端口 可同时用。证书放数据卷（容器内 /data/ssl），升级/重建容器都不丢。
// （不用 emit('connection') 直塞 https 服务：Node 24 实测 TLS 握手挂起）
const SSL_CERT = path.join(dataDir, 'ssl', 'cert.pem');
const SSL_KEY = path.join(dataDir, 'ssl', 'key.pem');
// 端口要等 listening 回调里才拿得到（listen 是异步的，立即 address() 是 null）
const listenLocal = (srv) => new Promise((resolve, reject) => {
  srv.once('error', reject);
  srv.listen(0, '127.0.0.1', () => resolve(srv.address().port));
});
(async () => {
  // 优雅重启的接替进程：稍等父进程（800ms 后退出）先释放端口，再开始监听
  if (process.env.WB_GRACEFUL_RESTART === '1') {
    await new Promise((r) => setTimeout(r, 1200));
  }
  let dualServer = false;
  try {
    if (fs.existsSync(SSL_CERT) && fs.existsSync(SSL_KEY)) {
      const httpsInner = https.createServer({ cert: fs.readFileSync(SSL_CERT), key: fs.readFileSync(SSL_KEY) }, app);
      const httpInner = http.createServer(app);
      const [tcpPort, tlsPort] = await Promise.all([listenLocal(httpInner), listenLocal(httpsInner)]);
      net.createServer((socket) => {
        socket.once('data', (buf) => {
          const target = net.connect(buf[0] === 0x16 ? tlsPort : tcpPort, '127.0.0.1');
          // 首段必须立即入队（连接建立前排队，flush 严格按入队顺序）——
          // 若等 connect 事件才写，body 的后续段可能先到先写，字节乱序打坏
          // multipart/大 POST（2MB 上传 8/8 复现，repro-sniff-order.mjs）
          target.write(buf);
          target.on('error', () => socket.destroy());
          socket.on('error', () => target.destroy());
          socket.pipe(target);
          target.pipe(socket);
        });
        socket.on('error', () => socket.destroy()); // 端口扫描/TLS 探测容错，不炸进程
      }).listen(PORT, () => {
        console.log(`[server] 个人工作台已启动（HTTP/HTTPS 同端口自适应）: http(s)://localhost:${PORT}`);
        console.log(`[server] HTTPS 证书: ${SSL_CERT}（内部转发 tcp:${tcpPort}/tls:${tlsPort}）`);
      });
      dualServer = true;
    }
  } catch (e) {
    console.warn('[server] 读取 data/ssl 证书失败，本次以纯 HTTP 启动：', e.message);
  }
  if (!dualServer) {
    app.listen(PORT, () => {
      console.log(`[server] 个人工作台已启动: http://localhost:${PORT}`);
    });
  }
})();

// 初始化流程（初始账号/定时任务）等待历史数据导入完成后执行，
// 避免空库阶段误建初始账号（导入 users 表后会跳过）
onImported(() => {
  auth.initAdmin();
  scheduler.init();
  dingtalkStream.start(); // 钉钉机器人长连接（接收群里 @机器人 的消息）
});

process.on('uncaughtException', (e) => console.error('[error]', e.message));
process.on('unhandledRejection', (e) => console.error('[error]', e.message));
