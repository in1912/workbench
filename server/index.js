const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const express = require('express');
const { onImported, getTenantDb, dataDir, ensureLocalUser, forEachTenant } = require('./db');
const ipBan = require('./services/ipBanService');
const auth = require('./auth');
const coreRoutes = require('./routes/core');
const miscRoutes = require('./routes/misc');
const payRoutes = require('./routes/payRoutes');
const upgradeRoutes = require('./routes/upgradeRoutes');
const petRoutes = require('./routes/petRoutes');
const typingRoutes = require('./routes/typingRoutes');
const ttsRoutes = require('./routes/ttsRoutes');
const storyRoutes = require('./routes/storyRoutes');
const vstudyRoutes = require('./routes/vstudyRoutes');
const pianoRoutes = require('./routes/pianoRoutes');
const vibeRoutes = require('./routes/vibeRoutes');
const wishRoutes = require('./routes/wishRoutes');
// 三大测试中心（mbti/dep/pro）v1.8.0 已随「私有项目」页整体移除，迁至独立项目 Private_Mini
const sslRoutes = require('./routes/sslRoutes');
const monitorRoutes = require('./routes/monitorRoutes');
const mihomeRoutes = require('./routes/mihomeRoutes');
const ccLightRoutes = require('./routes/ccLightRoutes');
const xiaozhiRoutes = require('./routes/xiaozhiRoutes');
const dhRoutes = require('./routes/dhRoutes');
const dhService = require('./services/dhService'); // 数字人参考图签名令牌校验（v1.12.1，鉴权中间件里用）
const fnosRoutes = require('./routes/fnosRoutes');
const authRoutes = require('./routes/authRoutes');
const flashToolRoutes = require('./routes/flashToolRoutes');
const noteRoutes = require('./routes/noteRoutes'); // 笔记知识系统（v1.9.41）：所有 /notes/* 的唯一所有者
const noteShareRoutes = require('./routes/noteShareRoutes'); // 笔记分享 + 外部写入令牌（v1.9.39）
const lifeRoutes = require('./routes/lifeRoutes'); // 人生管理系统（v1.10.0）：所有 /life/* 的唯一所有者
const imRoutes = require('./routes/imRoutes'); // IM 连接器（v1.10.5）：所有 /im/* 的唯一所有者（含免登回跳 /im/callback）
const imService = require('./services/imService'); // 启动时要用一次：IM 落地文件夹改版的一次性迁移（v1.10.14）
const scheduler = require('./scheduler');
const dingtalkStream = require('./services/dingtalkStreamService');

// ---------- 运行模式（v2.0.0）：workbench（默认，全能工作台）/ smarthome（智能家居独立应用） ----------
// 同一个仓库、同一份源码产出两个 fnOS 应用：智能家居应用只挂载它需要的路由、不启定时任务与子进程，
// 并且注入内置本地账号做到免登录。详见 CLAUDE.md §6。
const SH_MODE = process.env.WB_MODE === 'smarthome';
if (SH_MODE) console.log('[mode] 智能家居独立应用模式（WB_MODE=smarthome）：免登录 + 精简路由');

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
// 智能家居独立应用里没有「智作平台」，不启子进程也不挂代理（省内存，也避免它去找不存在的目录）
if (!SH_MODE) {
  const zhizu = require('./services/zhizuService');
  app.use('/zhizu', zhizu.proxy);
  zhizu.start();
}

app.use(express.json({ limit: '12mb' })); // 家庭图床图片以 base64 JSON 提交（原图上限 5MB ≈ base64 6.7MB）

// 花生壳 HTTP 型映射会直接掐掉 PATCH 方法的连接（实测 GET/POST/PUT/DELETE 均可达、PATCH 必断）；
// 前端 api.patch 改发 PUT + X-HTTP-Method: PATCH 头，这里在路由分发前还原为 PATCH，全部 PATCH 路由零改动。
app.use((req, res, next) => {
  if (req.method === 'PUT' && (req.headers['x-http-method'] === 'PATCH' || String(req.query._method || '').toUpperCase() === 'PATCH')) req.method = 'PATCH';
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
const EXEMPT = ['/auth/login', '/auth/fnos-login', '/health', '/tile', '/map-static', '/system-info', '/dingtalk/bind/callback', '/auth/dingtalk-info', '/auth/dingtalk/login',
  '/monitor/agent/config', '/monitor/agent/shot',
  '/clipboard/agent-register', '/clipboard/agent-push', // 剪贴板采集代理（key+uid 即凭证：登记/推送，v1.6.2）
  '/messages/agent/poll', '/messages/agent/read', // 短消息桌面通知代理（v1.9.24：每用户 key+uid 即凭证：轮询新消息/点击已读）
  '/vibe/client-download', '/vibe/client-register', '/vibe/job', // 录音转写客户端（key 即凭证：引擎下发/登记回连/拉取模式领任务回传结果）
  '/mihome/callback', // 米家 OAuth 回跳（小米浏览器重定向落地，无工作台登录态；只认 state 会话 + 一次性 code）
  '/xiaozhi/bridge', // 智能板桥接（v1.9.11：板端固件 MCP 工具回连，key 即凭证，照 /vibe/job 模式）
  '/xiaozhi/firmware', // 智能板固件下载（v1.9.12：同一桥接密钥或管理员令牌，路由内自校验；无工具链环境从构建机代理）
  '/xiaozhi/photo', // 智能板照片上传（v1.9.17：固件 POST 二进制 JPEG，路由级 raw 解析 + 桥接密钥自校验）
  '/im/callback', // IM 连接器 OAuth 回跳（v1.10.5，飞书那边跳回来，没有工作台登录态；只认一次性 state）
  '/pets/desktop', // 桌面宠物（key 即凭证：state/frame/action）
  '/share', '/note-intake']; // 笔记分享（token+4位码即凭证）/ 外部写入令牌（v1.9.39）。⚠️ 路由内一律 403/404，绝不 401
app.use('/api', (req, res, next) => {
  // 数字人参考图公网直取（v1.12.1）：Vivix 服务器建会话时要下载 source_images 的 URL，它没有
  // 工作台登录态——URL 里带 dhService 签发的短时签名令牌（?it=，只绑这一张图、2 小时有效）。
  // 只放行 GET /dh/images/:id/raw 且令牌合法这一条（令牌里的 uid 反查租户库注入 req.tdb）；
  // 图片的改/删与其余 /dh/* 仍走下面的登录闸。伪造/过期令牌一律 403（同 /share 的口径）。
  if (req.method === 'GET' && /^\/dh\/images\/\d+\/raw$/.test(req.path) && typeof req.query.it === 'string') {
    const imgId = Number(req.path.split('/')[3]);
    const hit = dhService.resolveImageToken(req.query.it, imgId);
    if (!hit) return res.status(403).json({ error: '图片令牌无效或已过期' });
    req.tdb = getTenantDb(hit.uid);
    return next();
  }
  if (EXEMPT.some((e) => req.path === e || req.path.startsWith(e + '/'))) return next();
  // 智能家居独立应用：无登录页，直接注入内置本地账号（管理员），所有 /api 一律放行。
  // 这是「全免登」的实现点——网关内与局域网直连端口走同一段代码，行为一致。
  if (SH_MODE) {
    req.user = ensureLocalUser();
    req.tdb = getTenantDb(req.user.id);
    return next();
  }
  const user = auth.resolveUser(req);
  if (!user) {
    // 网关链路 401 取证（v1.9.2）：只记令牌「形态」不记内容，写 server.log 供真机排障
    // （判断网关到底对 头/query/cookie 做了什么：剥头？追加同名参数变数组？连 cookie 也不转发？）
    if (req.viaGateway) {
      const tq = req.query.token;
      console.log(`[fnos] 401 ${req.method} ${req.path} | 头=${(req.headers.authorization || '无').slice(0, 16)} | query=${tq === undefined ? '无' : Array.isArray(tq) ? `数组x${tq.length}` : '字符串'} | cookie=${/wb_token=/.test(req.headers.cookie || '') ? '有' : '无'}`);
    }
    return res.status(401).json({ error: '未登录或会话已过期' });
  }
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

// ---------- 智能家居独立应用：接口白名单闸门（v2.0.0）----------
// 免登录的代价是**后端必须自己守住「哪些端点存在」**。coreRoutes / miscRoutes 是超级杂货铺
// （笔记、邮箱、账务、文件存档、联系人、设置……全塞在这两个文件里），而智能家居真正要用的只有
// 其中两个：/system-info（顶栏探活）与 /messages/contacts（智能板「查谁的资料」的用户选择器）。
// 免登录 + 全量挂载 = 同网段任何人都能读走邮箱和笔记（e2e 的 A5 组就是照这个写的），
// 所以白名单之外一律 404 —— 前端本来也没有入口，不算功能缩水。
// 注意：本闸门在 EXEMPT 判断之后，故对免登录端点同样生效（/pets/desktop、/vibe/job 之类
// 在这个应用里确实不存在，就该 404 而不是让它们去撞未挂载的路由）。
const SH_API_ALLOW = [
  '/health',            // 前端跨源可达性探测
  '/system-info',       // 顶栏在线状态 / 名称版本
  '/auth/me',           // 拿内置本地账号（登录接口 /auth/login 故意不在名单里：本应用没有登录页）
  '/messages/contacts', // 用户选择器数据源（misc.js 里的）
  '/mihome', '/cclight', '/xiaozhi', '/vc', '/flashtool',
  '/dh',                // 数字人（v1.12.0，智能家居第二个 tab）：角色注册表/参考图/历史/试聊/连通测试
];
app.use('/api', (req, res, next) => {
  if (!SH_MODE) return next();
  const p = req.path;
  if (SH_API_ALLOW.some((a) => p === a || p.startsWith(a + '/'))) return next();
  res.status(404).json({ error: '该功能不在「智能家居」应用中' });
});

// API 路由
app.use('/api', authRoutes);
app.use('/api', coreRoutes);
app.use('/api', noteRoutes); // 笔记知识系统（v1.9.41）：/notes/* 全部端点。必须排在 noteShareRoutes 之前，/notes/shares/* 仍是它的
app.use('/api', noteShareRoutes); // 笔记分享 /share/n/:token（免登录）+ 管理 /notes/shares/*（继承笔记页权限）+ 外部写入 /note-intake/:token（v1.9.39）
app.use('/api', lifeRoutes); // 人生管理系统（v1.10.0）：目标/行动/复盘/习惯/项目/领域/SOP/关系引擎，全部在 /life/* 下
app.use('/api', imRoutes); // IM 连接器（v1.10.5）：/im/*（连接器/授权/同步/日志）+ 免登回跳 /im/callback
app.use('/api', miscRoutes); // 含 /system-info、前端错误上报、文件存档/搜索等通用接口
app.use('/api', mihomeRoutes);
app.use('/api', ccLightRoutes);
app.use('/api', xiaozhiRoutes);
app.use('/api', dhRoutes); // 数字人（v1.12.0）：/dh/*（角色注册表/参考图/历史对话/Vivix 会话预览）
app.use('/api', vstudyRoutes); // 视频中心（智能家居最后一个 tab）用的 /vc 接口
app.use('/api', flashToolRoutes); // 本地烧录工具包（v2.0.0 新增）
app.use('/api', fnosRoutes);
if (!SH_MODE) {
  // 以下模块在智能家居独立应用里不存在：不挂路由 = 请求 404，前端也没有入口
  app.use('/api', payRoutes);
  app.use('/api', upgradeRoutes);
  app.use('/api', petRoutes);
  app.use('/api', typingRoutes);
  app.use('/api', ttsRoutes);
  app.use('/api', storyRoutes);
  app.use('/api', pianoRoutes);
  app.use('/api', vibeRoutes);
  app.use('/api', wishRoutes);
  app.use('/api', monitorRoutes);
  app.use('/api/ssl', sslRoutes);
}

// 小智官方 MCP 接入点（v1.9.31，通道 A）：默认关闭，用户在智能板配置页勾选才连。
// 出站 wss 连接由 xiaozhiMcpBridge 自己管理（退避重连 + 异常不上抛）；
// 延后 2 秒再连，别和启动期的建库/定时任务抢时间。
setTimeout(() => {
  try { require('./services/xiaozhiMcpBridge').sync(); } catch (e) { console.warn('[server] 小智接入点启动失败:', e.message); }
}, 2000).unref?.();

// 健康检查（本地直连探测端点：公网页面要跨源 fetch 本地地址的 /api/health 判断可达性，放行跨源读取）
app.get('/api/health', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ ok: true, time: new Date().toISOString() });
});

// 托管前端构建产物：web/dist（主工作台）/ web/dist-sh（智能家居应用，v2.0.0）下都可能累积多个
// 时间戳子目录，每次请求时解析最新的（重建前端后无需重启服务）。两个 dist 树严格分开：
// 根目录由运行模式决定，主应用的 latestDist() 绝不会误选到 sh 的产物（入口 html 名也不同）。
const webDistRoot = path.join(__dirname, '..', 'web', SH_MODE ? 'dist-sh' : 'dist');
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

const PORT = process.env.PORT || (SH_MODE ? 7778 : 3000);

// ---------- 飞牛 fnOS 统一网关（v1.9.0）：/app/{appname} 前缀 + Unix Socket ----------
// fnOS 桌面入口 /app/qgworkbench 的请求经 NAS 登录态校验后，转发到应用 target/app.sock，
// 并注入可信用户头（X-Trim-Username/Userid/Isadmin）。这里把整套 app 挂到前缀下（剥前缀复用全部路由与静态资源），
// 并打 viaGateway 标记——该标记只在网关链路上设置，直连 TCP 端口伪造 X-Trim 头无效。
// 免登开号逻辑见 routes/authRoutes.js 的 /auth/fnos-login（只认 viaGateway 请求）。
const FNOS_PREFIX = process.env.FNOS_PREFIX || '';
const FNOS_APP_SOCK = process.env.FNOS_APP_SOCK || '';
if (FNOS_PREFIX && FNOS_APP_SOCK) {
  const gatewayApp = express();
  gatewayApp.use(FNOS_PREFIX, (req, res, next) => { req.viaGateway = true; next(); }, app);
  try { fs.unlinkSync(FNOS_APP_SOCK); } catch { /* 首次启动无残留 socket */ }
  const gwSrv = http.createServer(gatewayApp);
  gwSrv.listen(FNOS_APP_SOCK, () => {
    try { fs.chmodSync(FNOS_APP_SOCK, 0o666); } catch { /* Windows/权限差异，尽力而为 */ }
    console.log(`[fnos] 统一网关已监听: ${FNOS_APP_SOCK}（前缀 ${FNOS_PREFIX}）`);
  });
  gwSrv.on('error', (e) => console.warn('[fnos] 网关 Socket 监听失败（不影响 TCP 端口服务）:', e.message));
}
// 本地调试/线上诊断：FNOS_GATEWAY_TCP_PORT=4001 时把同一套网关入口挂到 TCP 端口，
// 可用 curl 带 X-Trim-* 头直接验证免登全链路（不经 Unix Socket）
if (FNOS_PREFIX && process.env.FNOS_GATEWAY_TCP_PORT) {
  const dbgApp = express();
  dbgApp.use(FNOS_PREFIX, (req, res, next) => { req.viaGateway = true; next(); }, app);
  dbgApp.listen(Number(process.env.FNOS_GATEWAY_TCP_PORT), () => {
    console.log(`[fnos] 网关调试端口: http://localhost:${process.env.FNOS_GATEWAY_TCP_PORT}${FNOS_PREFIX}/`);
  });
}

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
  if (SH_MODE) {
    // 独立应用：不建初始管理员（走内置本地账号），不跑定时任务，不连钉钉
    ensureLocalUser();
    console.log('[mode] 智能家居应用就绪：免登录，无需账号');
    return;
  }
  auth.initAdmin();
  // IM 落地文件夹改版（v1.10.14）：老库里按平台分的目录要拆成「按连接器分」，
  // 并把已归档的笔记搬到各自连接器的目录下。**放在这里而不是 db.js**：imService 依赖 db，
  // 在 db.js 初始化途中 require 它会拿到半成品的 exports（循环依赖）。migrateImFolders 幂等，
  // 重启跑多少遍都是同一结果（第二次 moved=0、removed=0）。
  forEachTenant((d, uid, username) => {
    try {
      const r = imService.migrateImFolders(d);
      if (r.moved || r.removed) console.log(`[im] 落地文件夹迁移(${username})：搬到连接器目录 ${r.moved} 篇，清掉空目录 ${r.removed} 个`);
    } catch (e) { console.warn(`[im] 落地文件夹迁移跳过(${username}):`, e.message); }
    // 归档笔记规整（v1.10.18）：补平台标签（#飞书）+ 按各连接器的 note_order 把正文排成倒序
    // + 把抬头换成当前口径（老抬头少了 `- 标签：#飞书`，末行说明还写着「追加在下面」）。
    // 同样幂等：规整过之后再跑，tagged / reordered / headered 都是 0。
    try {
      const r = imService.normalizeImNotes(d);
      if (r.tagged || r.reordered || r.headered) {
        console.log(`[im] 归档笔记规整(${username})：补标签 ${r.tagged} 篇，重排 ${r.reordered} 篇，刷新抬头 ${r.headered} 篇`);
      }
    } catch (e) { console.warn(`[im] 归档笔记规整跳过(${username}):`, e.message); }
  });
  scheduler.init();
  dingtalkStream.start(); // 钉钉机器人长连接（接收群里 @机器人 的消息）
});

process.on('uncaughtException', (e) => console.error('[error]', e.message));
process.on('unhandledRejection', (e) => console.error('[error]', e.message));
