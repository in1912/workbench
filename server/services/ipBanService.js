// IP 黑名单服务（v1.3.4）：被封禁的 IP 一律 403（静态页 + 全部 API，含登录）。
// 来源两种：① 管理员在「设置 → 登录日志」里手动封禁（日志行「封禁」按钮或黑名单卡片添加）；
// ② 账号连续密码错误 10 次触发永久锁定时自动封禁（见 authRoutes.autoBanIp）。
// 注意生产环境经花生壳穿透：全部访客 IP 都是 127.0.0.1（回环）——回环地址永不可封，
// 否则等于把整站（包括管理员自己）锁在门外。是否曾成功登录过的 IP 也不自动封（防自己人手滑自锁）。
const { db } = require('../db');

// 回环地址（本机/花生壳穿透共用出口）——永不封禁
const LOOPBACK_RE = /^(127\.|::1$|localhost$|0\.0\.0\.0$)/i;

// 客户端 IP：优先反向代理注入的 X-Forwarded-For 首段，其次 socket 地址；去掉 IPv6 映射前缀
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (xf || req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

// 内存快照：每请求 O(1) 查询，增删时整体重载（黑名单量级极小）
let banned = new Set();
function refresh() {
  banned = new Set(db.prepare('SELECT ip FROM ip_bans').all().map((r) => String(r.ip || '').trim()));
}
function isBanned(ip) { return banned.has(String(ip || '').trim()); }

function ban(ip, note, by) {
  const clean = String(ip || '').trim().slice(0, 64);
  if (!clean) throw new Error('IP 不能为空');
  db.prepare('INSERT INTO ip_bans(ip, note, created_by, created_at) VALUES (?,?,?,datetime(\'now\',\'localtime\')) ' +
    'ON CONFLICT(ip) DO UPDATE SET note=excluded.note, created_by=excluded.created_by')
    .run(clean, String(note || '').slice(0, 200), String(by || '').slice(0, 100));
  refresh();
  return clean;
}

function unban(ip) {
  const r = db.prepare('DELETE FROM ip_bans WHERE ip=?').run(String(ip || '').trim());
  refresh();
  return r.changes > 0;
}

function list() {
  return db.prepare('SELECT ip, note, created_by, created_at FROM ip_bans ORDER BY rowid DESC').all();
}

refresh();
module.exports = { clientIp, isBanned, ban, unban, list, LOOPBACK_RE };
