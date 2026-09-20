const crypto = require('crypto');
const { db } = require('./db');

// ---------- 密码哈希（scrypt + 随机盐，绝不存明文） ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const calc = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(calc, 'hex'), Buffer.from(hash, 'hex'));
}

// ---------- 会话 ----------
const SESSION_DAYS = 7;
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(
    `INSERT INTO sessions(token,user_id,expires_at)
     VALUES(?,?,datetime('now','localtime','+${SESSION_DAYS} days'))`
  ).run(token, userId);
  return token;
}
function resolveUser(req) {
  const header = req.headers.authorization || '';
  // Bearer 头优先；<img> 等标签请求带不了自定义头，退回 ?token= 查询参数（富文本图片 URL 场景）
  const token = header.startsWith('Bearer ') ? header.slice(7) : String(req.query.token || '');
  if (!token) return null;
  const row = db.prepare(
    `SELECT u.id, u.username, u.role, u.display_name, u.nickname, u.allowed_pages, u.allowed_tabs
     FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token=? AND s.expires_at > datetime('now','localtime')`
  ).get(token);
  return row ? {
    ...row,
    allowed_pages: JSON.parse(row.allowed_pages || '[]'),
    allowed_tabs: JSON.parse(row.allowed_tabs || '{}'),
  } : null;
}
function destroySession(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token) db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
// 清理过期会话（启动时调用）
function cleanupSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now','localtime')").run();
}

// ---------- 页面权限 ----------
// 页面 key → 后端 API 路径前缀（注意：入参是相对 /api 的路径，如 /notes）
const PAGES = ['dashboard', 'search', 'news', 'email', 'notes', 'tasks', 'family', 'learning', 'tools', 'business', 'ai', 'files', 'pay', 'pets', 'settings'];

function pageForPath(p) {
  if (p.startsWith('/overview')) return 'dashboard';
  if (p.startsWith('/search')) return 'search';
  if (p.startsWith('/news')) return 'news';
  if (p.startsWith('/emails')) return 'email';
  if (p.startsWith('/contacts')) return 'email'; // 邮箱页「通讯录」tab（email_contacts 表）
  if (p.startsWith('/notes')) return 'notes';
  if (p.startsWith('/todos') || p.startsWith('/events')) return 'tasks';
  if (p.startsWith('/family') || p.startsWith('/kids') || p.startsWith('/kid-tasks') || p.startsWith('/family-profiles') || p.startsWith('/lunar')) return 'family';
  // 学习计划/学习记录/复盘已移到「效率工具」页（2026-09 v1.2.0）
  if (p.startsWith('/learning') || p.startsWith('/reviews')) return 'tools';
  if (p.startsWith('/tts')) return 'learning'; // 语音合成（听写播报/语音配音）归学习页
  if (p.startsWith('/vstudy')) return 'learning'; // 视频教学（目录/播放/记录/设置/学时流水）归学习页
  if (p.startsWith('/clipboard') || p.startsWith('/links')) return 'tools';
  if (p.startsWith('/mbti')) return 'tools'; // 职业测试（MBTI H5 同步/管理；免登录的 /mbti/public/* 在 EXEMPT，不经过这里）
  if (p.startsWith('/dep')) return 'tools'; // 抑郁测试中心（v1.3.0，/api/dep/*；免登录端点在 EXEMPT）
  if (p.startsWith('/pro')) return 'tools'; // 专业心理测试中心（v1.3.0，/api/pro/*；免登录端点在 EXEMPT）
  if (p.startsWith('/monitor')) return 'tools'; // Computer monitoring (v1.3.5): Tools page last tab, bound to tools page permission (otherwise any logged-in user could read screenshots)
  if (p.startsWith('/business') || p.startsWith('/business/skills')) return 'business';
  if (p.startsWith('/ai')) return 'ai';
  if (p.startsWith('/pushes') || p.startsWith('/schedules')) return 'business'; // 原「AI 推送」页已并入业务系统页
  if (p.startsWith('/files')) return 'files';
  // 日历公共数据（看板「中国节日日历」与「待办与日程 → 日历」共用）：仅需登录，不绑页面权限。
  // 曾挂在 files 页下——没开「文件存档」权限的成员，日历上节假日全部消失
  if (p.startsWith('/holidays') || p.startsWith('/calendar')) return null;
  if (p.startsWith('/pay')) return 'pay';
  if (p.startsWith('/pets')) return 'pets'; // 电子宠物（悬浮窗的 state/action 不绑 tab，整页共享）
  if (p.startsWith('/typing')) return 'learning'; // 打字赚钱 4 个 tab 已并入学习页
  if (p.startsWith('/credit')) return 'learning'; // 赊账兑换（兑现登记/记录页共用列表）
  if (p.startsWith('/piano')) return 'learning'; // 练琴录音
  if (p.startsWith('/wish')) return 'learning'; // 心愿卡
  if (p.startsWith('/upgrade')) return 'upgrade';
  if (p.startsWith('/users')) return 'users';
  if (p.startsWith('/settings') || p.startsWith('/roles')) return 'settings';
  return null;
}

// ---------- 页内 tab 级授权 ----------
// 页 → [{tab, 前缀[]}]（前缀相对 /api，匹配规则：相等或 path 以 前缀+/ 开头；顺序敏感，长前缀放前面）
// 前缀以 '=' 开头表示仅全等匹配（如 '=/pets' 只匹配 POST /pets 领养，不影响 /pets/state 等共享端点）
// 未列出的端点（如 GET /learning 整页数据）属页级共享，不做 tab 校验
const TAB_PATHS = {
  family: [
    ['family', ['/family']],
    ['kids', ['/kids', '/kid-tasks']],
    ['profiles', ['/family-profiles']], // /lunar 是 Tasks 日历共用工具接口，不绑 tab
  ],
  tasks: [
    ['todo', ['/todos']],
    ['cal', ['/events', '/calendar']],
  ],
  email: [
    ['mail', ['/emails']],
    ['contacts', ['/contacts']],
  ],
  learning: [
    // 听写为纯前端流程：合成/状态/音色列表/参考音频/听写偏好均为页内共享端点（不绑 tab）
    ['dictation', []],
    // 视频教学：浏览/播放/进度上报/注意力检测为页内共享端点（数据按人隔离，不绑 tab）
    ['vstudy', []],
    // 学时记账：本人流水只读（user_id 切换查看他人时服务端按登录人过滤，仍只读）
    ['vledger', ['=/vstudy/ledger']],
    // 视频教学设置（NAS 根目录、学年学科字典）归设置 tab
    ['vsettings', ['/vstudy/settings']],
    ['vlog', []],
    // 打字赚钱 4 tab 并入学习页（2026-09 v1.2.0）：练习上报/记录/日历只读/兑现登记
    ['practice', ['=/typing/progress']],
    ['records', ['=/typing/records']],
    ['money', ['=/typing/summary']], // 赚钱日历只读（费率随 summary.config 下发展示）
    // 兑现登记是受限 tab：费率设置、赊账登记也归它管（/credit/manage）
    ['payout', ['/typing/payouts', '/typing/config', '/credit/manage']],
    // 练琴有效时长确认：受限（有权限成员才能勾选有效），放前面截获，独立于 piano tab
    ['pianoconfirm', ['/piano/confirm']],
    // 练琴：录音上传/列表/统计/播放
    ['piano', ['/piano']],
    // 心愿卡：产品浏览与打卡（GET /wish/products 也绑 tab，受限用户不见数据）
    ['wish', ['=/wish/checkin', '=/wish/products']],
    // 心愿卡设置（上传/改/删产品）：受限，独立于 wish tab
    ['wishset', ['/wish/manage']],
    // 语音配音：音色库管理与引擎安装（安装接口内部再限管理员）归本 tab；独立合成走共享的 /tts/synthesize
    ['tts', ['/tts/manage', '/tts/engine']],
  ],
  pay: [
    ['dash', ['/pay/dashboard', '/pay/rank', '/pay/ai-analysis']],
    ['cats', ['/pay/categories', '/pay/cycle', '/pay/fixed']],
    ['import', ['/pay/import', '/pay/train', '/pay/classify-ai']],
    ['bills', ['/pay/bills']],
    ['budget', ['/pay/budgets', '/pay/budget-compare']],
  ],
  business: [
    ['skill', ['/business/skills']],
    ['sys', ['/business']],
    ['push', ['/pushes']],   // 原「AI 推送」页的两个 tab 并入业务系统
    ['config', ['/schedules']],
  ],
  tools: [
    // 三大测试中心排前（v1.3.0）：抑郁测试 / 专业心理测试 / 职业测试（原「心理测试」改名）
    // 三个中心接口同构：档案同步 / 分享前缀 / 管理列表（免登录的 /xxx/public/:id 不经过权限校验）
    ['dep', ['/dep/records', '/dep/users', '/dep/config']],
    ['pro', ['/pro/records', '/pro/users', '/pro/config']],
    ['mbti', ['/mbti/records', '/mbti/users', '/mbti/config']],
    ['clip', ['/clipboard']],
    ['links', ['/links']],
    // monitor (v1.3.5)
    ['monitor', ['/monitor']],
    // 学习计划/学习记录/复盘 3 个 tab 从学习页移来（2026-09 v1.2.0）
    ['plans', ['/learning/plans']],
    ['records', ['/learning/records']],
    ['review', ['/reviews']],
  ],
  pets: [
    // 主查看 tab（宠物列表/喂养/悬浮窗）：整页共享端点不绑路径，空数组=仅作授权表勾选项
    // （缺这条时 sanitizeTabs 会剥掉 'pets' 键 → 授权表勾了保存再打开还是空白）
    ['pets', []],
    ['adopt', ['=/pets']], // POST /pets 领养新宠物（「领养宠物」tab 专属）
    ['checkin', ['/pets/checkins', '/pets/checkin']],
    ['records', ['/pets/records']],
    ['settings', ['/pets/config', '/pets/gif']],
    ['assign', ['/pets/assign', '/pets/members']],
  ],
};

// 受限 tab：默认对所有人关闭（admin 除外），即使 allowed_pages 为空（=全开放）也必须在用户管理里
// 显式勾选授权才可访问。用于「兑现登记」「心愿卡设置」「练琴确认」这类涉及真金白银/家长权限的功能，
// 以及「视频教学设置」（NAS 根目录/学年学科字典属全家配置，2026-09 v1.2.9 加入）。
const RESTRICTED_TABS = { learning: ['payout', 'wishset', 'pianoconfirm', 'vsettings'] };

// 路径属于某页的哪个 tab；null = 共享端点 / 该页无 tab 细分
function tabForPath(page, p) {
  const defs = TAB_PATHS[page];
  if (!defs) return null;
  for (const [tab, prefixes] of defs) {
    for (const pre of prefixes) {
      if (pre.startsWith('=')) {
        if (p === pre.slice(1)) return tab; // '=' 前缀 = 仅全等匹配
      } else if (p === pre || p.startsWith(pre + '/')) {
        return tab;
      }
    }
  }
  return null;
}

function canAccess(user, page, tab) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (!page) return true; // 未映射页面的接口仅需登录
  // 受限 tab：必须显式授权，不受「allowed_pages 为空 = 全开」的宽松规则影响
  if (tab && (RESTRICTED_TABS[page] || []).includes(tab)) {
    const list = (user.allowed_tabs || {})[page];
    return Array.isArray(list) && list.includes(tab);
  }
  const allowed = user.allowed_pages || [];
  // tab 级细分只在页面受限（allowed_pages 非空）时生效：
  // allowed_pages 为空 = 全部开放，残留的 tab 配置不得暗中收紧
  if (Array.isArray(allowed) && allowed.length > 0) {
    if (!allowed.includes(page)) return false;
    if (tab) {
      const tabs = user.allowed_tabs || {};
      if (tabs && typeof tabs === 'object' && page in tabs) {
        const list = tabs[page];
        if (Array.isArray(list) && !list.includes(tab)) return false; // 空数组 = 该页所有 tab 都不开
      }
    }
  }
  return true;
}

// ---------- 初始管理员 ----------
function initAdmin() {
  cleanupSessions();
  // 只统计真实用户：dingtalk_bot 虚拟成员在 db.js 模块加载时已先行插入，
  // 若按全表计数，全新库将永远不会创建初始管理员（无法登录）
  const count = db.prepare('SELECT COUNT(*) c FROM users WHERE is_bot=0').get().c;
  if (count === 0) {
    const uname = process.env.DEFAULT_ADMIN || 'admin';
    const upass = process.env.DEFAULT_ADMIN_PASSWORD || '123456';
    db.prepare('INSERT INTO users(username,password_hash,role,allowed_pages) VALUES(?,?,?,?)')
      .run(uname, hashPassword(upass), 'admin', '[]');
    console.log(`[auth] 已创建初始管理员 ${uname}（密码 ${upass}，请登录后立即修改）`);
  }
}

module.exports = {
  hashPassword, verifyPassword, createSession, resolveUser, destroySession,
  PAGES, pageForPath, canAccess, tabForPath, TAB_PATHS, RESTRICTED_TABS, initAdmin,
};
