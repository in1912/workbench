// 文案库 - AI短视频文案创作管理系统
const express = require('express');
const path = require('path');
const fs = require('fs');
const { router: authRouter, resolveUser } = require('./routes/authRoutes');
const { router: genRouter } = require('./routes/genRoutes');
const { router: configRouter } = require('./routes/configRoutes');
const { router: hotRouter } = require('./routes/hotRoutes');
const sensitiveRouter = require('./routes/sensitiveRoutes');
const { seedSensitive } = require('./sensitiveSeed');
const { db, getSetting, setSetting } = require('./db');
const { encrypt } = require('./services/cryptoUtil');
const { startTopicScheduler } = require('./services/topicScheduler');

// 敏感词库/法规库首次初始化
seedSensitive();

// 存量明文密钥迁移为 AES-256-GCM 加密（幂等：已带 enc:v1: 前缀的跳过）
(function migrateKeys() {
  try {
    const g = getSetting('ai_key', '');
    if (g && !String(g).startsWith('enc:v1:')) setSetting('ai_key', encrypt(String(g)));
    const rows = db.prepare("SELECT id, ai_key FROM users WHERE ai_key IS NOT NULL AND ai_key!=''").all();
    const upd = db.prepare('UPDATE users SET ai_key=? WHERE id=?');
    let n = 0;
    for (const u of rows) {
      if (!String(u.ai_key).startsWith('enc:v1:')) { upd.run(encrypt(String(u.ai_key)), u.id); n++; }
    }
    if (n || (g && !String(g).startsWith('enc:v1:'))) console.log('[文案库] 存量明文密钥已迁移为加密存储');
  } catch (e) { console.error('[文案库] 密钥迁移失败:', e.message); }
})();

const app = express();
const PORT = process.env.PORT || 9608;

app.use(express.json({ limit: '3mb' }));

// ---- 鉴权中间件（/api/auth/login 除外）----
const EXEMPT = ['/auth/login', '/health'];
app.use('/api', (req, res, next) => {
  if (EXEMPT.includes(req.path)) return next();
  const user = resolveUser(req);
  if (!user) return res.status(401).json({ error: '未登录或会话已过期' });
  req.user = user;
  next();
});

app.use('/api/auth', authRouter);
app.use('/api/gen', genRouter);
app.use('/api', configRouter); // /api/ai* /api/profile /api/avatar /api/hot-sources
app.use('/api/hot', hotRouter);
app.use('/api/sensitive', sensitiveRouter);

app.get('/api/health', (req, res) => res.json({ ok: true, name: 'wenanku', ts: Date.now() }));

// ---- 前端静态（v1.4：构建 base=/zhizu/，静态挂在 /zhizu 前缀下）----
// 两种运行方式共用一套产物：独立运行（本机 9608）时 / 302 到 /zhizu/；
// 被个人工作台反向代理（效率工具→智作平台）时，代理剥掉 /zhizu 前缀后转发，路由与静态恰好对齐。
const WEB_DIST = path.join(__dirname, '..', 'web', 'dist');
if (fs.existsSync(WEB_DIST)) {
  app.use('/zhizu', express.static(WEB_DIST));
  app.get(/^\/(?!api|health|zhizu).*/, (req, res) => res.redirect('/zhizu/'));
}

// 嵌入工作台时由 zhizuService 传 ZHIZU_HOST=127.0.0.1（仅进程内部通道，不对局域网开口）；
// 独立运行缺省 0.0.0.0 保持文案库单机部署的局域网可达性
const HOST = process.env.ZHIZU_HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`[文案库] 服务已启动: http://localhost:${PORT}`);
  startTopicScheduler(); // 每日定时 AI 选题
});
