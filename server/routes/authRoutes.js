const express = require('express');
const path = require('path');
const fs = require('fs');
const { db, getTenantDb, closeTenantDb, tenantDbFile, dataDir, getShareFlags, setShareFlags, rebalanceFamilyShare, getSetting, setSetting } = require('../db');
const auth = require('../auth');
const dingtalkService = require('../services/dingtalkService');

const router = express.Router();
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
const PRIV_IP_RE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|localhost)/i;

const ipBanService = require('../services/ipBanService'); // IP 黑名单：clientIp 解析 + 增删查
const { clientIp } = ipBanService;

// 自动封禁（账号连续 10 次密码错误触发）：只封「从未成功登录过」的公网 IP——
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
}

// 登录（带防爆破锁：IP 熔断 → 账号永久锁 → 账号临时锁 → 密码校验；全程记流水）
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
      autoBanIp(ip, user.username); // 锁定期内硬闯满 10 次：同样封 IP
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
      if (perma) autoBanIp(ip, user.username); // 10 次锁号的同时封这个来源 IP
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
  getTenantDb(user.id); // 登录即惰性建租户库（幂等）
  res.json({
    token,
    user: {
      id: user.id, username: user.username, role: user.role,
      display_name: user.display_name || '', nickname: user.nickname || '',
      allowed_pages: JSON.parse(user.allowed_pages || '[]'),
      allowed_tabs: JSON.parse(user.allowed_tabs || '{}'),
    },
    theme: getSetting(getTenantDb(user.id), 'theme', '') || '', // 外观主题随账号：登录即应用
  });
});

// 当前用户信息（前端启动时恢复会话）
router.get('/auth/me', (req, res) => {
  // theme = 该账号保存的外观主题（前端刷新时应用，换设备登录同一账号也跟随）
  res.json({ user: req.user, theme: getSetting(req.tdb, 'theme', '') || '' });
});

// 外观主题：按用户保存（设置页「外观」卡调用）
router.post('/settings/theme', (req, res) => {
  const t = ['dark', 'light', 'purple', 'pink'].includes(req.body && req.body.theme) ? req.body.theme : 'dark';
  setSetting(req.tdb, 'theme', t);
  res.json({ ok: true, theme: t });
});

// 登出
router.post('/auth/logout', (req, res) => {
  auth.destroySession(req);
  res.json({ ok: true });
});

// ---------- 钉钉免登（工作台嵌在钉钉工作台里打开：免登码换本地账号） ----------
// 登录页探测：免登配置齐全才下发 corpId（前端拿它向钉钉 JSAPI 要免登码）；未配置保持普通账号密码登录
router.get('/auth/dingtalk-info', (req, res) => {
  const c = dingtalkService.getLoginConfig();
  res.json({ enabled: !!(c.corp_id && c.app_key && c.app_secret), corp_id: c.corp_id });
});
// 免登：免登码 → 钉钉 userid → 已绑定的本地账号 → 签发会话（响应结构与 /auth/login 一致）
router.post('/auth/dingtalk/login', async (req, res) => {
  try {
    const userid = await dingtalkService.useridByAuthCode((req.body || {}).code);
    const user = db.prepare("SELECT * FROM users WHERE dingtalk_userid=? AND (is_bot IS NULL OR is_bot=0)").get(userid);
    if (!user) {
      writeLoginLog({ username: '钉钉:' + String(userid || '').slice(0, 60), success: 0, reason: '钉钉免登失败（未绑定）', ip: clientIp(req), ua: req.headers['user-agent'] || '' });
      return res.status(403).json({ error: '该钉钉账号尚未绑定工作台账号：先在本页用账号密码登录一次即自动绑定，之后即可免登' });
    }
    const token = auth.createSession(user.id);
    getTenantDb(user.id);
    console.log(`[auth] 用户 ${user.username} 通过钉钉免登登录（userid: ${userid}）`);
    writeLoginLog({ username: user.username, user_id: user.id, success: 1, reason: '钉钉免登', ip: clientIp(req), ua: req.headers['user-agent'] || '' });
    res.json({
      token,
      user: {
        id: user.id, username: user.username, role: user.role,
        display_name: user.display_name || '', nickname: user.nickname || '',
        allowed_pages: JSON.parse(user.allowed_pages || '[]'),
        allowed_tabs: JSON.parse(user.allowed_tabs || '{}'),
      },
      theme: getSetting(getTenantDb(user.id), 'theme', '') || '',
    });
  } catch (e) {
    res.status(401).json({ error: '钉钉免登失败：' + e.message });
  }
});
// 绑定：登录后在钉钉内打开本页，前端静默取免登码调这里，把当前账号与钉钉 userid 关联
router.post('/auth/dingtalk/bind', async (req, res) => {
  try {
    const userid = await dingtalkService.useridByAuthCode((req.body || {}).code);
    const other = db.prepare('SELECT username FROM users WHERE dingtalk_userid=? AND id<>?').get(userid, req.user.id);
    if (other) return res.status(400).json({ error: `该钉钉账号已绑定用户「${other.username}」，如需换绑请先解绑` });
    db.prepare('UPDATE users SET dingtalk_userid=? WHERE id=?').run(userid, req.user.id);
    console.log(`[auth] 用户 ${req.user.username} 绑定钉钉免登（userid: ${userid}）`);
    res.json({ ok: true, userid });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
// 解绑免登（设置页「钉钉免登」卡）：只断开账号关联，不影响推送绑定
router.post('/auth/dingtalk/unbind', (req, res) => {
  db.prepare("UPDATE users SET dingtalk_userid='' WHERE id=?").run(req.user.id);
  console.log(`[auth] 用户 ${req.user.username} 解除钉钉免登绑定`);
  res.json({ ok: true });
});
// 本人免登绑定状态（设置页显示「已绑定」用；绑定在钉钉内首次密码登录时自动完成）
router.get('/auth/dingtalk-bind-status', (req, res) => {
  const u = db.prepare('SELECT dingtalk_userid FROM users WHERE id=?').get(req.user.id);
  res.json({ bound: !!(u && u.dingtalk_userid), userid: (u && u.dingtalk_userid) || '' });
});

// 修改自己的密码
router.post('/auth/password', (req, res) => {
  const { old_password, new_password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!auth.verifyPassword(old_password || '', user.password_hash)) {
    return res.status(400).json({ error: '原密码不正确' });
  }
  if (!new_password || String(new_password).length < 6) {
    return res.status(400).json({ error: '新密码至少 6 位' });
  }
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(auth.hashPassword(new_password), req.user.id);
  res.json({ ok: true });
});

// ---------- 用户管理（仅 admin） ----------
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
  next();
}

router.get('/users', adminOnly, (req, res) => {
  res.json(
    db.prepare('SELECT id, username, role, display_name, nickname, is_bot, allowed_pages, allowed_tabs, created_at, fail_count, locked_until, lock_permanent FROM users ORDER BY id').all()
      .map((u) => ({ ...u, allowed_pages: JSON.parse(u.allowed_pages || '[]'), allowed_tabs: JSON.parse(u.allowed_tabs || '{}') }))
  );
});

// allowed_tabs：页内 tab 级授权 {family:['family','kids'], ...}；只保留 TAB_PATHS 里存在的页与 tab
function sanitizeTabs(tabs) {
  const out = {};
  if (!tabs || typeof tabs !== 'object') return out;
  for (const [page, list] of Object.entries(tabs)) {
    const valid = (auth.TAB_PATHS[page] || []).map((t) => t[0]);
    out[page] = (Array.isArray(list) ? list : []).filter((t) => valid.includes(t));
  }
  return out;
}

router.post('/users', adminOnly, (req, res) => {
  const { username, password, role, display_name, nickname, allowed_pages, allowed_tabs } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
  try {
    const r = db.prepare('INSERT INTO users(username,password_hash,role,allowed_pages,allowed_tabs,display_name,nickname) VALUES(?,?,?,?,?,?,?)')
      .run(username, auth.hashPassword(password), role === 'admin' ? 'admin' : 'user',
        JSON.stringify(allowed_pages || []), JSON.stringify(sanitizeTabs(allowed_tabs)),
        display_name || '', nickname || '');
    res.json({ id: r.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: '用户名已存在' });
  }
});

router.put('/users/:id', adminOnly, (req, res) => {
  const { password, role, display_name, nickname, allowed_pages, allowed_tabs } = req.body || {};
  const cur = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '用户不存在' });
  // 禁止降级最后一个 admin
  if (cur.role === 'admin' && role && role !== 'admin') {
    const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;
    if (admins <= 1) return res.status(400).json({ error: '至少保留一个管理员' });
  }
  if (password) {
    if (String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(auth.hashPassword(password), req.params.id);
  }
  if (role) db.prepare('UPDATE users SET role=? WHERE id=?').run(role === 'admin' ? 'admin' : 'user', req.params.id);
  if (allowed_pages !== undefined) {
    db.prepare('UPDATE users SET allowed_pages=? WHERE id=?').run(JSON.stringify(allowed_pages), req.params.id);
  }
  if (allowed_tabs !== undefined) {
    db.prepare('UPDATE users SET allowed_tabs=? WHERE id=?').run(JSON.stringify(sanitizeTabs(allowed_tabs)), req.params.id);
  }
  // 姓名/昵称：显式传了才更新（允许单独清空，传 undefined 不动）
  if (display_name !== undefined) {
    db.prepare('UPDATE users SET display_name=? WHERE id=?').run(String(display_name || '').trim(), req.params.id);
  }
  if (nickname !== undefined) {
    db.prepare('UPDATE users SET nickname=? WHERE id=?').run(String(nickname || '').trim(), req.params.id);
  }
  res.json({ ok: true });
});

// 管理员重置任意用户密码（改自己请走「设置 → 修改密码」，需原密码）
router.put('/users/:id/password', adminOnly, (req, res) => {
  const { password } = req.body || {};
  const cur = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '用户不存在' });
  if (cur.is_bot) return res.status(400).json({ error: '系统成员（钉钉机器人）不可设置密码' });
  if (cur.id === req.user.id) return res.status(400).json({ error: '修改自己的密码请到「设置 → 修改密码」（需原密码）' });
  if (!password || String(password).length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(auth.hashPassword(password), cur.id);
  // 重置即踢掉该用户全部会话，必须用新密码重新登录
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(cur.id);
  console.log(`[auth] 管理员 ${req.user.username} 重置了用户 ${cur.username} 的密码`);
  res.json({ ok: true });
});

router.delete('/users/:id', adminOnly, (req, res) => {
  const cur = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '用户不存在' });
  if (cur.id === req.user.id) return res.status(400).json({ error: '不能删除自己' });
  if (cur.is_bot) return res.status(400).json({ error: '钉钉机器人是系统成员，不可删除' });
  if (cur.role === 'admin') {
    const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;
    if (admins <= 1) return res.status(400).json({ error: '至少保留一个管理员' });
  }
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  // 租户库归档：先关句柄（Windows 打开的文件无法移动），再搬入 data/archive/user-<uid>-<时间戳>/
  try {
    closeTenantDb(req.params.id);
    const tfile = tenantDbFile(req.params.id);
    if (fs.existsSync(tfile)) {
      const ts = new Date().toISOString().replace(/[-T:]/g, '').slice(0, 14);
      const dir = path.join(dataDir, 'archive', `user-${req.params.id}-${ts}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.renameSync(tfile, path.join(dir, path.basename(tfile)));
      console.log(`[auth] 已归档用户 ${cur.username} 的租户库 → data/archive/user-${req.params.id}-${ts}/`);
    }
  } catch (e) { console.warn('[auth] 归档租户库失败:', e.message); }
  res.json({ ok: true });
});

// 解锁被锁定的账号（仅 admin：用户管理列表「解锁」按钮；清失败计数与两种锁）
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

// ---------- IP 黑名单管理（仅 admin） ----------
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

// ---------- 模块共享设置（仅 admin：控制哪些模块的数据全租户共用） ----------
router.get('/share-config', adminOnly, (req, res) => {
  res.json(getShareFlags());
});
router.put('/share-config', adminOnly, (req, res) => {
  const before = getShareFlags();
  // 注意：只透传请求体里出现的键——setShareFlags 按键过滤，
  // 若在这里解构全量四键，未传的键会以 undefined 落库把开关清零
  setShareFlags(req.body || {});
  const after = getShareFlags();
  // 家庭与子女：开关切换时重平衡（关=共享底账归还管理员租户；开=以管理员当前数据重建底账）
  if (before.family !== after.family) {
    try { rebalanceFamilyShare(after.family); } catch (e) {
      console.warn('[share-config] 家庭数据重平衡失败:', e.message);
    }
  }
  // 切换不搬历史数据；news 独立→共享时主库可能还没今天的新闻，立即补抓一次
  if (!before.news && after.news) {
    require('../services/newsService').refreshAll(db, null)
      .then((r) => console.log('[share-config] 切回共享新闻，已补抓', r))
      .catch((e) => console.warn('[share-config] 共享新闻补抓失败:', e.message));
  }
  res.json(after);
});

module.exports = router;
