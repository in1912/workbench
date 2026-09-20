// v1.3.3 补丁：登录防爆破锁 + 登录日志。
// 1) db.js：login_logs 表（主库） + users 三列（fail_count/locked_until/lock_permanent）
// 2) authRoutes.js：/auth/login 重写（IP 熔断 + 账号 5 次锁 15 分钟 + 10 次永久锁），
//    PUT /users/:id/unlock（管理员解锁）、GET /auth/login-logs（流水查询）、
//    GET /users 带锁定状态、钉钉免登也记流水
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..');

function rep(file, oldStr, newStr, tag, expect = 1) {
  let t = fs.readFileSync(file, 'utf8');
  const n = t.split(oldStr).length - 1;
  if (n !== expect) { console.error(`[FAIL] ${path.basename(file)} 「${tag}」匹配 ${n} 处（期望 ${expect}），中止不改`); process.exit(1); }
  fs.writeFileSync(file, t.replace(oldStr, newStr));
  console.log(`[ok] ${path.basename(file)} 「${tag}」`);
}

// ============ db.js ============
const dbf = path.join(R, 'server', 'db.js');
rep(dbf,
`CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  expires_at TEXT
);`,
`CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  expires_at TEXT
);
-- 登录日志（v1.3.3）：每次登录尝试的流水（成功+失败），登录页爆破取证用。
-- attempted_password 只在失败时记录（看清攻击者在试什么）；成功登录不落密码，防止日志变成明文口令表。
-- region 归属地：内网 IP 直接标「内网」，公网 IP 异步查 ip-api.com 回填（尽力而为，查不到留空）。
CREATE TABLE IF NOT EXISTS login_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now','localtime')),
  username TEXT DEFAULT '',
  user_id INTEGER,
  success INTEGER NOT NULL DEFAULT 0,
  reason TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  region TEXT DEFAULT '',
  user_agent TEXT DEFAULT '',
  attempted_password TEXT
);`,
'login_logs DDL');

rep(dbf,
`addCol(db, 'users', 'dingtalk_userid', "TEXT DEFAULT ''");`,
`addCol(db, 'users', 'dingtalk_userid', "TEXT DEFAULT ''");
// 登录防爆破锁（v1.3.3，users 仅主库）：fail_count=连续失败次数（登录成功清零）；
// locked_until=临时锁定到期时间（ISO）；lock_permanent=1 时只能管理员在「用户管理」点解锁
addCol(db, 'users', 'fail_count', 'INTEGER NOT NULL DEFAULT 0');
addCol(db, 'users', 'locked_until', "TEXT DEFAULT ''");
addCol(db, 'users', 'lock_permanent', 'INTEGER NOT NULL DEFAULT 0');`,
'users lock columns');

// ============ authRoutes.js ============
const af = path.join(R, 'server', 'routes', 'authRoutes.js');
rep(af,
`const router = express.Router();
router.use(express.json());`,
`const router = express.Router();
router.use(express.json());

// ---------- 登录防爆破锁 + 登录日志（v1.3.3） ----------
// 账号级（持久化 users 表）：连续失败 5 次锁 15 分钟（锁定期内正确密码也进不来）；累计 10 次永久锁定，
//   只能管理员在「用户管理」点「解锁」人工处理。登录成功即清零。
// IP 级（内存熔断）：15 分钟内任意用户名累计失败 15 次 → 该 IP 再锁 15 分钟（防拿不存在的用户名爆破绕过账号锁）。
// 阈值可用环境变量覆盖（E2E 用小值加速）。
const LOCK_CFG = {
  tempFails: parseInt(process.env.LOGIN_TEMP_FAILS || '5', 10),
  tempMs: parseInt(process.env.LOGIN_TEMP_LOCK_MS || String(15 * 60 * 1000), 10),
  permaFails: parseInt(process.env.LOGIN_PERMA_FAILS || '10', 10),
  ipFails: parseInt(process.env.LOGIN_IP_FAILS || '15', 10),
  ipMs: parseInt(process.env.LOGIN_IP_LOCK_MS || String(15 * 60 * 1000), 10),
};
const ipFailTimes = new Map(); // ip -> 失败时间戳[]（滑动窗口）
const PRIV_IP_RE = /^(127\\.|10\\.|192\\.168\\.|172\\.(1[6-9]|2\\d|3[01])\\.|::1|localhost)/i;

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (xf || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

// 归属地缓存（ip -> 地区文案，'' = 查过但失败）。内网直接「内网」不外查。
const regionCache = new Map();
function writeLoginLog({ username, user_id: uid, success, reason, ip: ipIn, ua, attempted_password: tried }) {
  const r = db.prepare(
    "INSERT INTO login_logs(ts, username, user_id, success, reason, ip, region, user_agent, attempted_password) VALUES (datetime('now','localtime'),?,?,?,?,?,?,?,?)"
  ).run(String(username || '').slice(0, 100), uid || null, success ? 1 : 0, String(reason || '').slice(0, 100),
    String(ipIn || '').slice(0, 64), '', String(ua || '').slice(0, 250),
    tried == null ? null : String(tried).slice(0, 100));
  const id = Number(r.lastInsertRowid);
  const ip = String(ipIn || '');
  if (!ip) return id;
  if (PRIV_IP_RE.test(ip)) {
    db.prepare('UPDATE login_logs SET region=? WHERE id=?').run('内网', id);
  } else if (regionCache.has(ip)) {
    const reg = regionCache.get(ip);
    if (reg) db.prepare('UPDATE login_logs SET region=? WHERE id=?').run(reg, id);
  } else {
    regionCache.set(ip, ''); // 先占位防并发重复外查
    fetch('http://ip-api.com/json/' + encodeURIComponent(ip) + '?fields=status,country,regionName,city&lang=zh-CN', { signal: AbortSignal.timeout(3500) })
      .then((x) => x.json())
      .then((j) => {
        const reg = j && j.status === 'success' ? [j.country, j.regionName, j.city].filter(Boolean).join(' ') : '未知';
        regionCache.set(ip, reg);
        db.prepare('UPDATE login_logs SET region=? WHERE id=?').run(reg, id);
      })
      .catch(() => {});
  }
  // 流水滚动：最多保留 3000 条，防无限膨胀
  db.prepare('DELETE FROM login_logs WHERE id <= (SELECT id FROM login_logs ORDER BY id DESC LIMIT 1 OFFSET 3000)').run();
  return id;
}`,
'lock helpers');

rep(af,
`// 登录
router.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username || '');
  if (!user || !auth.verifyPassword(password || '', user.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = auth.createSession(user.id);
  getTenantDb(user.id); // 登录即惰性建租户库（幂等）`,
`// 登录（带防爆破锁：IP 熔断 → 账号永久锁 → 账号临时锁 → 密码校验；全程记流水）
router.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const uname = String(username || '').slice(0, 100);
  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || '';

  // 1) IP 级熔断（滑动窗口内失败过多：连密码都不校验，防「不存在用户名」式爆破）
  const now = Date.now();
  const fl = (ipFailTimes.get(ip) || []).filter((t) => now - t < LOCK_CFG.ipMs);
  if (fl.length >= LOCK_CFG.ipFails) {
    writeLoginLog({ username: uname, success: 0, reason: 'IP 熔断（失败过于频繁）', ip, ua });
    return res.status(429).json({ error: '尝试过于频繁，请约 ' + Math.ceil(LOCK_CFG.ipMs / 60000) + ' 分钟后再试' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username=? AND (is_bot IS NULL OR is_bot=0)').get(uname);

  // 2) 账号永久锁：只能管理员在「用户管理」解锁
  if (user && user.lock_permanent) {
    writeLoginLog({ username: uname, user_id: user.id, success: 0, reason: '永久锁定期内尝试', ip, ua });
    return res.status(403).json({ error: '账号已锁定（连续失败 ' + LOCK_CFG.permaFails + ' 次），请联系管理员在「用户管理」中解锁' });
  }
  // 3) 账号临时锁：锁定期内正确密码也进不来（爆破者无法探测密码对错）；
  //    锁定期内的继续尝试照样计数——第 10 次直接升永久锁（防「等 15 分钟再试 5 次」的慢速爆破）
  if (user && user.locked_until && new Date(user.locked_until).getTime() > now) {
    const failCount = (user.fail_count || 0) + 1;
    const min = Math.max(1, Math.ceil((new Date(user.locked_until).getTime() - now) / 60000));
    if (failCount >= LOCK_CFG.permaFails) {
      db.prepare("UPDATE users SET fail_count=?, locked_until='', lock_permanent=1 WHERE id=?").run(failCount, user.id);
      writeLoginLog({ username: uname, user_id: user.id, success: 0, reason: '锁定期内继续尝试，升为永久锁定', ip, ua });
      return res.status(403).json({ error: '密码连续失败 ' + failCount + ' 次，账号已锁定，请联系管理员在「用户管理」中解锁' });
    }
    db.prepare('UPDATE users SET fail_count=? WHERE id=?').run(failCount, user.id);
    writeLoginLog({ username: uname, user_id: user.id, success: 0, reason: '临时锁定期内尝试', ip, ua });
    return res.status(423).json({ error: '密码连续失败 ' + failCount + ' 次，账号已临时锁定，请约 ' + min + ' 分钟后再试', locked: true, retry_after_min: min });
  }

  // 4) 密码校验：失败计数升档（5 次 → 临时锁 15 分钟；10 次 → 永久锁）
  if (!user || !auth.verifyPassword(password || '', user.password_hash)) {
    let msg = '用户名或密码错误';
    if (user) {
      const failCount = (user.fail_count || 0) + 1;
      let lockedUntil = '', perma = 0;
      if (failCount >= LOCK_CFG.permaFails) {
        perma = 1;
        msg = '密码连续失败 ' + failCount + ' 次，账号已锁定，请联系管理员在「用户管理」中解锁';
      } else if (failCount >= LOCK_CFG.tempFails) {
        lockedUntil = new Date(now + LOCK_CFG.tempMs).toISOString();
        msg = '密码连续失败 ' + failCount + ' 次，账号已临时锁定 ' + Math.round(LOCK_CFG.tempMs / 60000) + ' 分钟';
      }
      db.prepare('UPDATE users SET fail_count=?, locked_until=?, lock_permanent=? WHERE id=?').run(failCount, lockedUntil, perma, user.id);
    }
    fl.push(now);
    ipFailTimes.set(ip, fl);
    writeLoginLog({ username: uname, user_id: user ? user.id : null, success: 0, reason: user ? '密码错误' : '用户名不存在', ip, ua, attempted_password: password });
    return res.status(401).json({ error: msg, fail_count: user ? (user.fail_count || 0) + 1 : undefined });
  }

  // 5) 成功：清失败计数（永久锁到不了这一步），记流水（成功不落密码）
  db.prepare("UPDATE users SET fail_count=0, locked_until='', lock_permanent=0 WHERE id=?").run(user.id);
  writeLoginLog({ username: user.username, user_id: user.id, success: 1, reason: '登录成功', ip, ua });
  const token = auth.createSession(user.id);
  getTenantDb(user.id); // 登录即惰性建租户库（幂等）`,
'login handler');

rep(af,
`    if (!user) {
      return res.status(403).json({ error: '该钉钉账号尚未绑定工作台账号：先在本页用账号密码登录一次即自动绑定，之后即可免登' });
    }`,
`    if (!user) {
      writeLoginLog({ username: '钉钉:' + String(userid || '').slice(0, 60), success: 0, reason: '钉钉免登失败（未绑定）', ip: clientIp(req), ua: req.headers['user-agent'] || '' });
      return res.status(403).json({ error: '该钉钉账号尚未绑定工作台账号：先在本页用账号密码登录一次即自动绑定，之后即可免登' });
    }`,
'dingtalk fail log');

rep(af,
'    console.log(`[auth] 用户 ${user.username} 通过钉钉免登登录（userid: ${userid}）`);',
'    console.log(`[auth] 用户 ${user.username} 通过钉钉免登登录（userid: ${userid}）`);\n    writeLoginLog({ username: user.username, user_id: user.id, success: 1, reason: \'钉钉免登\', ip: clientIp(req), ua: req.headers[\'user-agent\'] || \'\' });',
'dingtalk success log');

rep(af,
`  db.prepare('SELECT id, username, role, display_name, nickname, is_bot, allowed_pages, allowed_tabs, created_at FROM users ORDER BY id')`,
`  db.prepare('SELECT id, username, role, display_name, nickname, is_bot, allowed_pages, allowed_tabs, created_at, fail_count, locked_until, lock_permanent FROM users ORDER BY id')`,
'GET users columns');

rep(af,
`// ---------- 模块共享设置（仅 admin：控制哪些模块的数据全租户共用） ----------`,
`// 解锁被锁定的账号（仅 admin：用户管理列表「解锁」按钮；清失败计数与两种锁）
router.put('/users/:id/unlock', adminOnly, (req, res) => {
  const cur = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '用户不存在' });
  db.prepare("UPDATE users SET fail_count=0, locked_until='', lock_permanent=0 WHERE id=?").run(cur.id);
  console.log('[auth] 管理员 ' + req.user.username + ' 解锁了用户 ' + cur.username);
  res.json({ ok: true });
});

// 登录日志（仅 admin）：成功+失败流水。失败行带尝试的密码（取证），成功行密码列为空。
router.get('/auth/login-logs', adminOnly, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.max(10, Math.min(200, parseInt(req.query.pageSize, 10) || 30));
  // outcome 只接受白名单三值，映射成固定 SQL 片段，无注入面
  const cond = req.query.outcome === 'success' ? 'WHERE success=1' : req.query.outcome === 'fail' ? 'WHERE success=0' : '';
  const total = db.prepare('SELECT COUNT(*) c FROM login_logs ' + cond).get().c;
  const rows = db.prepare('SELECT id, ts, username, user_id, success, reason, ip, region, attempted_password, user_agent FROM login_logs ' + cond + ' ORDER BY id DESC LIMIT ? OFFSET ?')
    .all(pageSize, (page - 1) * pageSize);
  res.json({ total, page, pageSize, rows });
});

// ---------- 模块共享设置（仅 admin：控制哪些模块的数据全租户共用） ----------`,
'unlock + logs endpoints');

console.log('全部补丁完成');
