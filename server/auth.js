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
  // 令牌多通道逐候选尝试（v1.9.2 定型）：
  // ① Authorization: Bearer 头（常规部署主通道；fnOS 网关会替换成 NAS 自己的凭证，可能无效）
  // ② ?token= 查询参数（<img> 直链场景；网关若追加同名参数，express 会解析成数组——逐个试）
  // ③ wb_token Cookie（fnOS 网关连查询参数也改写时的最后兜底，登录时随响应下发）
  // 任一候选命中有效会话即通过；都不行才 401。
  const candidates = [];
  if (header.startsWith('Bearer ')) candidates.push(header.slice(7));
  const q = req.query.token;
  if (typeof q === 'string') candidates.push(q);
  else if (Array.isArray(q)) candidates.push(...q.filter(Boolean).map(String));
  const ck = /(?:^|;\s*)wb_token=([A-Za-z0-9]+)/.exec(req.headers.cookie || '');
  if (ck) candidates.push(ck[1]);
  for (const token of candidates) {
    if (!token) continue;
    const row = db.prepare(
      `SELECT u.id, u.username, u.role, u.display_name, u.nickname, u.allowed_pages, u.allowed_tabs
       FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token=? AND s.expires_at > datetime('now','localtime')`
    ).get(token);
    if (row) return {
      ...row,
      allowed_pages: JSON.parse(row.allowed_pages || '[]'),
      allowed_tabs: JSON.parse(row.allowed_tabs || '{}'),
    };
  }
  return null;
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
// v1.10.10（需求⑨）：'pets' 从页面清单里去掉 —— 电子宠物整页并入「效率工具」页的 tab，
// 授权键变成 tools 页下的 'pets'。存量授权由 db.js 的 migratePetsIntoTools 一次性平移。
const PAGES = ['dashboard', 'news', 'email', 'notes', 'tasks', 'family', 'learning', 'tools', 'ai', 'smarthome', 'settings', 'life'];
// v1.9.22 曾把「Agent红绿灯」升格独立页；v1.9.23 放回智能家居页 cclight 子 tab（授权由 db.js 幂等迁移回平）
// v1.8.0：「私有项目」页（mbti/dep/pro 三大测试中心）已整体移除，迁至独立项目 Private_Mini；
// 历史 allowed_pages/allowed_tabs 里残留的 'private' 键无害（不再有页面/接口映射到它）

function pageForPath(p) {
  if (p.startsWith('/overview')) return 'dashboard';
  // v1.7.0 模块重组：全局搜索/文件存档并入「效率工具」页 tab
  if (p.startsWith('/search')) return 'tools';
  if (p.startsWith('/news')) return 'news';
  if (p.startsWith('/emails')) return 'email';
  if (p.startsWith('/contacts')) return 'email'; // 邮箱页「通讯录」tab（email_contacts 表）
  if (p.startsWith('/notes')) return 'notes';
  // IM 连接器（v1.10.5）：记录落成笔记、界面入口也在笔记页 → 归 notes 页权限。
  // ⚠️ 少这一行 = 静默变成「仅需登录」。免登的回跳 /im/callback 在 index.js EXEMPT 里，不走这里。
  if (p.startsWith('/im')) return 'notes';
  // 人生管理系统（v1.10.0）：整套 /api/life/* 归独立侧栏页「人生」。
  // 与 /links（快捷启动，归 tools）不冲突：/li**f**e 与 /li**n**ks 在第 4 个字符就分开了。
  if (p.startsWith('/life')) return 'life';
  if (p.startsWith('/todos') || p.startsWith('/events')) return 'tasks';
  // /story = 家庭管理页「儿童故事」tab（v1.9.36）。漏了这条就落 null=仅需登录，权限形同虚设（v1.9.9 fnos 踩过）
  if (p.startsWith('/family') || p.startsWith('/kids') || p.startsWith('/kid-tasks') || p.startsWith('/family-profiles') || p.startsWith('/lunar') || p.startsWith('/story')) return 'family';
  // 学习计划/学习记录/复盘已移到「效率工具」页（2026-09 v1.2.0）
  if (p.startsWith('/learning') || p.startsWith('/reviews')) return 'tools';
  // 语音合成接口跨页共享：听写播报（学习页）与语音配音（效率工具页，2026-09 v1.6.5 移入）都用
  // 合成/音色/状态 → 仅需登录（同 /holidays 跨页共享先例）；音色库管理与引擎安装绑 tools.tts tab
  if (p.startsWith('/tts/manage') || p.startsWith('/tts/engine')) return 'tools';
  if (p.startsWith('/tts')) return null;
  if (p.startsWith('/vstudy')) return 'learning'; // 视频教学（目录/播放/记录/设置/学时流水）归学习页
  // 视频中心（v1.9.26）：vstudy 的精简版（无学年学科/学时/注意力），归智能家居页 videocenter tab
  if (p.startsWith('/vc')) return 'smarthome';
  if (p.startsWith('/clipboard') || p.startsWith('/links')) return 'tools';
  // mbti/dep/pro 测试中心接口 v1.8.0 已随「私有项目」页卸载（迁至独立项目 Private_Mini），不再映射
  if (p.startsWith('/monitor')) return 'tools'; // Computer monitoring (v1.3.5): Tools page last tab, bound to tools page permission (otherwise any logged-in user could read screenshots)
  // 智能家居（v1.6.8）：米家设备总览/属性读写/能力描述为页内共享；
  // /mihome/callback 在 index.js EXEMPT 免登录名单里（OAuth 回跳无登录态），不经过这里
  if (p.startsWith('/mihome')) return 'smarthome';
  // Agent红绿灯（CC-LIGHT）：挂智能家居页 cclight tab（v1.9.22 曾升格独立页，v1.9.23 放回）
  if (p.startsWith('/cclight')) return 'smarthome';
  // 智能板（小智 Korvo2V3，v1.9.11）：装机/唤醒词/桥接归智能家居页 xiaozhi tab；
  // /xiaozhi/bridge 在 index.js EXEMPT 免登录（板端固件回连，key 即凭证），不经过这里
  if (p.startsWith('/xiaozhi')) return 'smarthome';
  // 业务系统改名「推送任务」并入效率工具页（2026-09 v1.7.0）
  if (p.startsWith('/business')) return 'tools';
  if (p.startsWith('/ai')) return 'ai';
  if (p.startsWith('/pushes') || p.startsWith('/schedules')) return 'tools'; // 原「AI 推送」页并入的推送 tab
  if (p.startsWith('/files')) return 'tools'; // 文件存档并入效率工具页（v1.7.0）
  // 日历公共数据（看板「中国节日日历」与「待办与日程 → 日历」共用）：仅需登录，不绑页面权限。
  // 曾挂在 files 页下——没开「文件存档」权限的成员，日历上节假日全部消失
  if (p.startsWith('/holidays') || p.startsWith('/calendar')) return null;
  if (p.startsWith('/pay')) return 'family'; // 个人账务并入「家庭管理」页（v1.7.0）
  // 电子宠物（v1.10.10 需求⑨）：整页并入「效率工具」，/api/pets/* 归 tools 页 → tools.pets tab。
  // ⚠️ 写成 'pets' 页（而不是 'tools'）会让这套接口**静默变成仅需登录**：PAGES 里已经没有 'pets' 了，
  //    权限表也不再有任何东西能勾到它 —— 所以这一行必须跟着页面一起改。
  if (p.startsWith('/pets')) return 'tools';
  if (p.startsWith('/typing')) return 'learning'; // 打字赚钱 4 个 tab 已并入学习页
  if (p.startsWith('/credit')) return 'learning'; // 赊账兑换（兑现登记/记录页共用列表）
  if (p.startsWith('/piano')) return 'learning'; // 练琴录音
  if (p.startsWith('/wish')) return 'learning'; // 心愿卡
  if (p.startsWith('/upgrade')) return 'upgrade';
  if (p.startsWith('/users')) return 'settings'; // 用户管理并入「设置」页 tab（v1.7.0，路由内部再限管理员）
  if (p.startsWith('/fnos')) return 'settings'; // 飞牛应用 fpk 下载归「设置」页飞牛应用 tab（v1.9.9）
  if (p.startsWith('/settings') || p.startsWith('/roles')) return 'settings';
  return null;
}

// ---------- 页内 tab 级授权 ----------
// 页 → [{tab, 前缀[]}]（前缀相对 /api，匹配规则：相等或 path 以 前缀+/ 开头；顺序敏感，长前缀放前面）
// 前缀以 '=' 开头表示仅全等匹配（如 '=/pets' 只匹配 POST /pets 领养，不影响 /pets/state 等共享端点）
// 未列出的端点（如 GET /learning 整页数据）属页级共享，不做 tab 校验
const TAB_PATHS = {
  // 人生管理系统（v1.10.0）：八个 tab 的接口全在 /life/* 之下，且**不细分**——
  // 目标是「一个人自己的第二大脑」，把一个目标拆给两个 tab 各自授权没有意义。
  // 键仍然要列全：缺键时用户的 allowed_tabs 里勾过的 tab 会被 sanitizeTabs 剥掉。
  life: [
    ['today', []], ['goals', []], ['actions', []], ['habits', []],
    ['reviews', []], ['aimreview', []],   // AI复盘IM（v1.10.29）：紧挨复盘页之后；接口仍走 life 页前缀闸
    ['projects', []], ['domains', []], ['graph', []],
    ['km', []],      // 知识地图（v1.11.0）：空数组 = 只有授权勾选项，接口走 life 页前缀闸
    ['guide', []],   // 使用流程（v1.10.1）：空数组 = 只有授权勾选项，不约束任何接口
  ],
  family: [
    ['family', ['/family']],
    ['kids', ['/kids', '/kid-tasks']],
    ['profiles', ['/family-profiles']], // /lunar 是 Tasks 日历共用工具接口，不绑 tab
    // 个人账务从独立页并入（2026-09 v1.7.0）：'pay' 为可见 tab 键（空数组=仅授权表勾选项，
    // 无独立 API 前缀），下面 5 个细分键继续约束子功能接口
    ['pay', []],
    ['dash', ['/pay/dashboard', '/pay/rank', '/pay/ai-analysis']],
    ['cats', ['/pay/categories', '/pay/cycle', '/pay/fixed']],
    ['import', ['/pay/import', '/pay/train', '/pay/classify-ai']],
    ['bills', ['/pay/bills']],
    ['budget', ['/pay/budgets', '/pay/budget-compare']],
    ['story', ['/story']],   // 儿童故事（v1.9.36）
  ],
  tasks: [
    ['todo', ['/todos']],
    ['cal', ['/events', '/calendar']],
  ],
  email: [
    // 邮箱设置 tab（v1.7.0）：账号管理/标签规则/提醒设置；长前缀在前，避免被 mail 的 /emails 截获
    ['esettings', ['/emails/accounts', '/emails/tags', '/emails/notify', '/settings/email']],
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
  ],
  tools: [
    ['clip', ['/clipboard']],
    ['links', ['/links']],
    // monitor (v1.3.5)
    ['monitor', ['/monitor']],
    // 电子宠物（v1.10.10 需求⑨）：整页从独立侧栏页并入本页的一个 tab。
    // 前缀直接写 /pets（一网打尽列表/喂养/悬浮窗 state/action/领养 POST /pets/…/打卡/记录/设置/分配），
    // 也就是原来 pets 页那六个 tab 键的路径全归到这一个键上 —— 页内那六个子 tab 现在只是 UI 分段。
    ['pets', ['/pets']],
    // 学习计划/学习记录/复盘 3 个 tab（2026-09 v1.2.0 从学习页移来）**v1.10.10 按用户要求去掉**：
    // 界面上没有入口了，这里的 plans/records/review 三个键一并删掉；
    // 端点（/learning/plans、/learning/records、/reviews）与数据都还在，只是回到「页级共享、不细分」。
    // 录音转写（VibeVoice-ASR）：录音/上传/列表/转写/导出/设置
    ['vibe', ['/vibe']],
    // 语音配音从「学习」页移来（2026-09 v1.6.5）：音色库管理与引擎安装（安装接口内部再限管理员）；
    // 共享的合成/音色/状态在 pageForPath 已放行为仅需登录（听写播报也用）
    ['tts', ['/tts/manage', '/tts/engine']],
    // 业务系统（改名「推送任务」）整页并入（2026-09 v1.7.0）：'business' 为可见 tab 键（空数组=仅
    // 授权表勾选项），sys/skill/push/config 细分键继续约束子功能接口
    ['business', []],
    ['skill', ['/business/skills']],
    ['sys', ['/business']],
    ['push', ['/pushes']],
    ['config', ['/schedules']],
    // 文件存档整页并入（2026-09 v1.7.0）
    ['files', ['/files']],
    // 全局搜索整页并入（2026-09 v1.7.0）
    ['search', ['/search']],
  ],
  settings: [
    // 用户管理并入「设置」页（2026-09 v1.7.0）：/users 端点路由内部再限管理员
    ['users', ['/users']],
    // 飞牛应用 fpk 下载（v1.9.9）：设置页「飞牛应用」tab
    ['fnos', ['/fnos']],
  ],
  // v1.10.10（需求⑨）：原来的 pets 页整块没了，端点全部并入下面的 tools 页（见 tools 里的 'pets' 一行）。
  // 智能家居（v1.6.8）：米家总览/控制整页共享；绑定与解绑归「设置」tab
  // v1.6.29：移除「监控」tab 与摄像头事件凭证通道（micam 路由已删，历史 allowed_tabs 里的 monitor 键无害）
  smarthome: [
    ['mijia', []],
    ['terms', []],
    ['xiaozhi', ['/xiaozhi']],
    // Agent红绿灯（v1.9.23 放回本页）：/cclight 文件清单/单文件/打包下载整块归这一个 tab；
    // 面板内 功能介绍/下载安装包/安装步骤 三段为纯 UI 子页，无独立权限键
    ['cclight', ['/cclight']],
    ['settings', ['/mihome/bind', '/mihome/unbind']],
    // 视频中心（v1.9.26）：本页最后一个 tab——/vc 整块（tree/file/progress/extplayer/config/settings/fs-probe）；
    // 其中 /vc/settings 是全家配置，路由内部再限管理员（无 vstudy 那样的独立受限子 tab）
    ['videocenter', ['/vc']],
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
    const upass = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';
    db.prepare('INSERT INTO users(username,password_hash,role,allowed_pages) VALUES(?,?,?,?)')
      .run(uname, hashPassword(upass), 'admin', '[]');
    console.log(`[auth] 已创建初始管理员 ${uname}（密码 ${upass}，请登录后立即修改）`);
  }
}

module.exports = {
  hashPassword, verifyPassword, createSession, resolveUser, destroySession,
  PAGES, pageForPath, canAccess, tabForPath, TAB_PATHS, RESTRICTED_TABS, initAdmin,
};
