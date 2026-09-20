// v1.3.4 补丁：IP 黑名单 + 登录日志搬设置页 + 通勤出行方式。
// 1) db.js：ip_bans 表（主库）
// 2) index.js：封禁检查中间件（最前，静态页+全部 API 全拦）
// 3) authRoutes.js：clientIp 换用 ipBanService；10 次失败自动封 IP；GET/PUT/DELETE /ip-bans 管理端点
// 4) commuteService.js：mode（driving/walking/bicycling/electrobike）贯通 config→route→缓存→结果
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

// ============ db.js：ip_bans 表 ============
rep(path.join(R, 'server', 'db.js'),
`  attempted_password TEXT
);`,
`  attempted_password TEXT
);
-- IP 黑名单（v1.3.4）：被封禁的 IP 一律 403（含静态页与全部 API）。
-- 来源：管理员在「设置 → 登录日志」手动封禁，或账号连续 10 次密码错误时自动封禁（回环/曾成功登录的 IP 不自动封）。
CREATE TABLE IF NOT EXISTS ip_bans (
  ip TEXT PRIMARY KEY,
  note TEXT DEFAULT '',
  created_by TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);`,
'ip_bans DDL');

// ============ index.js：封禁中间件（必须最先） ============
rep(path.join(R, 'server', 'index.js'),
`const app = express();
app.use(express.json({ limit: '12mb' }));`,
`const app = express();
// IP 黑名单（v1.3.4）：全站第一道闸——被封禁的 IP 连静态页都拿不到 403（含登录接口）。
// 放在 express.json 之前：被拒请求连请求体都不解析。名单在 ipBanService 内存快照，增删即时生效。
app.use((req, res, next) => {
  if (ipBan.isBanned(ipBan.clientIp(req))) {
    if (req.path.startsWith('/api')) return res.status(403).json({ error: '该 IP 已被系统封禁，禁止访问' });
    return res.status(403).type('text/html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;padding:40px;text-align:center;color:#555"><h2>⛔ 403</h2><p>该 IP 已被系统封禁，禁止访问本系统。</p></body>');
  }
  next();
});
app.use(express.json({ limit: '12mb' }));`,
'ban middleware');

// index.js 引入 ipBanService（挂在 db 引入之后）
rep(path.join(R, 'server', 'index.js'),
`const { db, onImported, getTenantDb, dataDir, getSetting } = require('./db');`,
`const { db, onImported, getTenantDb, dataDir, getSetting } = require('./db');
const ipBan = require('./services/ipBanService');`,
'import ipBan');

// ============ authRoutes.js ============
const af = path.join(R, 'server', 'routes', 'authRoutes.js');

// clientIp 换用服务里的（去重：本地实现删掉，指向 ipBanService）
rep(af,
`function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (xf || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}`,
`const { clientIp } = require('../services/ipBanService'); // IP 解析与黑名单共用一份（XFF 优先）`,
'clientIp dedupe');

// 自动封禁助手（挂在 writeLoginLog 定义之后、首个使用点之前）
rep(af,
`// 归属地缓存（ip -> 地区文案，'' = 查过但失败）。内网直接「内网」不外查。`,
`// 自动封禁（账号连续 10 次密码错误触发）：只封「从未成功登录过」的公网 IP——
// 回环（花生壳穿透=全站共用）与曾正常登录的 IP（自己人手滑）都不自动封，防自锁整站。
function autoBanIp(ip, username) {
  try {
    if (!ip || ipBanService.LOOPBACK_RE.test(ip)) return false;
    const hadSuccess = db.prepare('SELECT 1 FROM login_logs WHERE ip=? AND success=1 LIMIT 1').get(ip);
    if (hadSuccess) return false;
    ipBanService.ban(ip, '自动封禁：账号「' + String(username || '').slice(0, 50) + '」连续 ' + LOCK_CFG.permaFails + ' 次密码错误', '系统');
    console.log('[auth] 自动封禁 IP ' + ip + '（账号 ' + username + ' 连续 ' + LOCK_CFG.permaFails + ' 次密码错误）');
    return true;
  } catch (e) { console.warn('[auth] 自动封禁失败:', e.message); return false; }
}

// 归属地缓存（ip -> 地区文案，'' = 查过但失败）。内网直接「内网」不外查。`,
'autoBanIp helper');

// 引入 ipBanService（clientIp 之外还要用 ban/unban/list）
rep(af,
`const { clientIp } = require('../services/ipBanService'); // IP 解析与黑名单共用一份（XFF 优先）`,
`const ipBanService = require('../services/ipBanService'); // IP 黑名单：clientIp 解析 + 增删查
const { clientIp } = ipBanService;`,
'import ipBanService');

// 永久锁触发点 ①：密码失败分支
rep(af,
`      db.prepare('UPDATE users SET fail_count=?, locked_until=?, lock_permanent=? WHERE id=?').run(failCount, lockedUntil, perma, user.id);`,
`      db.prepare('UPDATE users SET fail_count=?, locked_until=?, lock_permanent=? WHERE id=?').run(failCount, lockedUntil, perma, user.id);
      if (perma) autoBanIp(ip, user.username); // 10 次锁号的同时封这个来源 IP`,
'autoBan call 1');

// 永久锁触发点 ②：锁定期内继续尝试升永久
rep(af,
`      db.prepare("UPDATE users SET fail_count=?, locked_until='', lock_permanent=1 WHERE id=?").run(failCount, user.id);`,
`      db.prepare("UPDATE users SET fail_count=?, locked_until='', lock_permanent=1 WHERE id=?").run(failCount, user.id);
      autoBanIp(ip, user.username); // 锁定期内硬闯满 10 次：同样封 IP`,
'autoBan call 2');

// IP 黑名单管理端点（仅 admin）：挂在登录日志端点之后
rep(af,
`// ---------- 模块共享设置（仅 admin：控制哪些模块的数据全租户共用） ----------`,
`// ---------- IP 黑名单管理（仅 admin） ----------
router.get('/ip-bans', adminOnly, (req, res) => {
  res.json({ bans: ipBanService.list() });
});
// 封禁：不得封回环地址（花生壳穿透下全站共用 = 自锁整站）；不得封自己当前访问 IP（把自己锁在门外）
router.put('/ip-bans/:ip', adminOnly, (req, res) => {
  const ip = String(req.params.ip || '').trim().slice(0, 64);
  if (!/^[0-9a-fA-F.:]+$/.test(ip)) return res.status(400).json({ error: 'IP 格式不正确' });
  if (ipBanService.LOOPBACK_RE.test(ip)) {
    return res.status(400).json({ error: '回环/本机地址不可封禁：内网穿透部署下它是全站（含管理员）的共用出口，封了等于把整站锁死' });
  }
  const myIp = clientIp(req);
  if (ip === myIp) {
    return res.status(400).json({ error: '不能封禁自己当前访问使用的 IP（' + myIp + '），否则你会立即被锁在门外' });
  }
  ipBanService.ban(ip, (req.body && req.body.note) || '', req.user.username);
  console.log('[auth] 管理员 ' + req.user.username + ' 封禁了 IP ' + ip);
  res.json({ ok: true, ip });
});
router.delete('/ip-bans/:ip', adminOnly, (req, res) => {
  const ok = ipBanService.unban(req.params.ip);
  console.log('[auth] 管理员 ' + req.user.username + (ok ? ' 解封了 IP ' : ' 试图解封不存在的 IP ') + req.params.ip);
  res.json({ ok });
});

// ---------- 模块共享设置（仅 admin：控制哪些模块的数据全租户共用） ----------`,
'ip-bans endpoints');

// ============ commuteService.js：出行方式 ============
const cf = path.join(R, 'server', 'services', 'commuteService.js');

rep(cf,
`const DEFAULT_REFRESH_TIMES = ['07:00', '17:00'];`,
`const DEFAULT_REFRESH_TIMES = ['07:00', '17:00'];
// 出行方式（v1.3.4）：首页通勤时间按此选路线类型。driving=v3驾车(带路况) / walking=v3步行 /
// bicycling=v3骑行 / electrobike=v5电动车（失败自动回落骑行）
const MODES = ['driving', 'walking', 'bicycling', 'electrobike'];
const MODE_LABELS = { driving: '驾车', walking: '步行', bicycling: '骑自行车', electrobike: '电动车' };
function normMode(m) { return MODES.includes(m) ? m : 'driving'; }`,
'mode constants');

rep(cf,
`function getConfig(d) {
  const c = getSetting(d, 'commute', {
    home: '', work: '', work_start: '09:00', work_end: '18:00', refresh_times: DEFAULT_REFRESH_TIMES,
  });`,
`function getConfig(d) {
  const c = getSetting(d, 'commute', {
    home: '', work: '', work_start: '09:00', work_end: '18:00', refresh_times: DEFAULT_REFRESH_TIMES, mode: 'driving',
  });`,
'getConfig mode default');

rep(cf,
`  setSetting(d, 'commute', {
    home: (cfg.home || '').trim(),
    work: (cfg.work || '').trim(),
    work_start: cfg.work_start || '09:00',
    work_end: cfg.work_end || '18:00',
    refresh_times: times,
  });`,
`  setSetting(d, 'commute', {
    home: (cfg.home || '').trim(),
    work: (cfg.work || '').trim(),
    work_start: cfg.work_start || '09:00',
    work_end: cfg.work_end || '18:00',
    refresh_times: times,
    mode: normMode(cfg.mode), // 出行方式：驾车/步行/骑自行车/电动车
  });`,
'saveConfig mode');

rep(cf,
`const cacheKeyOf = (home, work) => \`\${home}|\${work}\`;`,
`const cacheKeyOf = (home, work, mode) => \`\${home}|\${work}|\${normMode(mode)}\`;`,
'cache key with mode');

rep(cf,
`async function route(key, origin, destination) {
  const url =
    \`https://restapi.amap.com/v3/direction/driving?key=\${encodeURIComponent(key)}\` +
    \`&origin=\${origin}&destination=\${destination}&strategy=10\`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const data = await res.json();
  if (data.status !== '1' || !data.route?.paths?.length) {
    throw new Error('路线规划失败：' + (data.info || '未知错误'));
  }
  const p = data.route.paths[0];`,
`async function route(key, origin, destination, mode = 'driving') {
  mode = normMode(mode);
  // 各方式 API：驾车 v3（带策略）；步行/骑行 v3；电动车 v5（个别 Key 未开通时回落骑行）
  const base = 'https://restapi.amap.com';
  const qs = \`?key=\${encodeURIComponent(key)}&origin=\${origin}&destination=\${destination}\`;
  const url =
    mode === 'walking' ? base + '/v3/direction/walking' + qs :
    mode === 'bicycling' ? base + '/v3/direction/bicycling' + qs :
    mode === 'electrobike' ? base + '/v5/direction/electrobike' + qs :
    base + '/v3/direction/driving' + qs + '&strategy=10';
  let res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  let data = await res.json();
  if ((data.status !== '1' && data.status !== 1) || !data.route?.paths?.length) {
    if (mode === 'electrobike') {
      // v5 电动车未开通/失败：回落 v3 骑行（时间略保守但不至于不可用）
      res = await fetch(base + '/v3/direction/bicycling' + qs, { signal: AbortSignal.timeout(15000) });
      data = await res.json();
    }
    if ((data.status !== '1' && data.status !== 1) || !data.route?.paths?.length) {
      throw new Error('路线规划失败：' + (data.info || data.msg || '未知错误'));
    }
  }
  // v3 与 v5 的 path 结构差异吸收：duration 可能在 path.duration（v3）或 path.cost.duration（v5）
  const p = data.route.paths[0];`,
'route by mode');

rep(cf,
`  return {
    duration_sec: Number(p.duration) || 0,
    distance_m: Number(p.distance) || 0,
    polyline: points.join(';'),
    steps,
  };`,
`  return {
    duration_sec: Number(p.duration) || Number(p.cost?.duration) || 0,
    distance_m: Number(p.distance) || 0,
    polyline: points.join(';'),
    steps,
  };`,
'duration v5 compat');

rep(cf,
`  const cfg = getConfig(d);
  const cache = cacheOf(cacheKeyOf(cfg.home, cfg.work));`,
`  const cfg = getConfig(d);
  const cache = cacheOf(cacheKeyOf(cfg.home, cfg.work, cfg.mode));`,
'calcCommute cache key');

rep(cf,
`    const [toWork, toHome] = await Promise.all([
      route(cfg.key, homeLoc, workLoc),
      route(cfg.key, workLoc, homeLoc),
    ]);
    // 路线级实时路况：按路线经过的道路名查交通态势（免费 API），只覆盖自己路线
    const trafficMap = await roadTraffic(cfg.key, adcode, [
      ...toWork.steps.map((s) => s.name),
      ...toHome.steps.map((s) => s.name),
    ]);`,
`    const mode = normMode(cfg.mode);
    const [toWork, toHome] = await Promise.all([
      route(cfg.key, homeLoc, workLoc, mode),
      route(cfg.key, workLoc, homeLoc, mode),
    ]);
    // 路线级实时路况：仅驾车有意义（步行/骑行不受机动车路况影响，还能省接口配额）——直接空表
    const trafficMap = mode === 'driving'
      ? await roadTraffic(cfg.key, adcode, [...toWork.steps.map((s) => s.name), ...toHome.steps.map((s) => s.name)])
      : {};`,
'traffic only driving');

rep(cf,
`    const data = {
      ok: true,
      home: cfg.home,
      work: cfg.work,`,
`    const data = {
      ok: true,
      home: cfg.home,
      work: cfg.work,
      mode,
      mode_label: MODE_LABELS[mode],`,
'result mode label');

console.log('全部补丁完成');
