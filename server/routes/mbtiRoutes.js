// 心理测试（多测试版 v1.2.24）：H5（静态托管在 /mbti/index.html）的记录同步 + 管理接口。
// 归属「效率工具 → 心理测试」tab（auth.js TAB_PATHS.tools）。
// 公开端点 /mbti/public/:id 在 index.js EXEMPT 名单里（免登录）：
//   分享链接 = 域名 + /mbti/index.html#/result/<档案ID>，档案 ID 为长随机串，
//   即"知道链接即可查看"的能力链接模型——与飞牛 FPK 版的分享意图一致，但接收方无需任何登录。
// 写操作（同步/配置/删除）需登录；两个列表与 AI 授权勾选仅管理员。
// AI 深度分析：按 H5 档案编号（uid）授权（mbti_user_info.ai_authorized），
//   代理调用工作台统一 ai_config（模型/地址/Key 均在服务端，H5 不再保存任何 Key）。
const express = require('express');
const { db, getSetting, setSetting } = require('../db');
const aiService = require('../services/aiService');
const auth = require('../auth');
const router = express.Router();

// 可选登录：/mbti/records 等写入口在 EXEMPT 免登录名单内（H5 测试者多未登录工作台），
// 全局中间件不会设 req.user——这里带 token 就解析，管理端点（adminOnly）对登录管理员照常放行
router.use((req, res, next) => {
  if (!req.user) {
    try { req.user = auth.resolveUser(req) || undefined; } catch { /* 无 token/坏 token 按匿名 */ }
  }
  next();
});

const PREFIX_KEY = 'mbti_share_prefix';
const ENABLED_KEY = 'mbti_enabled'; // 对外开关：'0' = H5 页面与全部免登录接口 403，管理端不受影响
function isEnabled() {
  return String(getSetting(db, ENABLED_KEY, '1') || '1') !== '0';
}
function rejectDisabled(req, res) {
  if (isEnabled()) return false;
  res.status(403).json({ error: '该测试中心已停用，暂不对外提供测试' });
  return true;
}
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UID_RE = /^U\d{6,12}$/; // H5 档案编号 U + 9 位数字

function adminOnly(req, res) {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: '仅管理员可操作' });
    return false;
  }
  return true;
}

// H5 上报的 finishedAt 是 toISOString() 的 UTC ISO（如 2026-09-10T09:21:00.000Z），
// 原样入库会让列表显示比北京时间早 8 小时。转成服务器本地 'YYYY-MM-DD HH:mm:ss'，
// 与 updated_at（datetime('now','localtime')）同一时区基准
function toLocalDb(iso) {
  if (iso == null || iso === '') return null;
  const d = new Date(String(iso));
  const p = n => String(n).padStart(2, '0');
  if (isNaN(d)) return String(iso).slice(0, 19).replace('T', ' ');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
    + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

// ---------- 免登录读取单条档案（分享链接接收方） ----------
router.get('/mbti/public/:id', (req, res) => {
  if (rejectDisabled(req, res)) return;
  const id = String(req.params.id || '');
  if (!ID_RE.test(id)) return res.status(404).json({ error: '记录不存在' });
  const row = db.prepare('SELECT data FROM mbti_records WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  try {
    res.json(JSON.parse(row.data));
  } catch (e) {
    res.status(500).json({ error: '记录数据损坏' });
  }
});

// ---------- 运行时门禁探测（EXEMPT 免登录）：H5 已加载页面的停用检查 ----------
// 题目全在 JS 里、纯客户端可作答：静态 403 只拦得住「新打开」的访客，拦不住已开着的标签页。
// H5 轮询本端点（启动即查 + 15s 一轮 + 切回前台即查），停用后整页锁定。无敏感数据。
router.get('/mbti/gate', (req, res) => res.json({ enabled: isEnabled() }));

// ---------- 分享域名前缀（登录可读；写仅管理员；留空 = 用当前访问地址） ----------
router.get('/mbti/config', (req, res) => {
  res.json({ prefix: String(getSetting(db, PREFIX_KEY, '') || ''), enabled: isEnabled() });
});

router.put('/mbti/config', (req, res) => {
  if (!adminOnly(req, res)) return;
  const b = req.body || {};
  let cur = String(getSetting(db, PREFIX_KEY, '') || '');
  if ('prefix' in b) { // 显式传才算（含空串=清空）；只切开关时不碰前缀
    const p = String(b.prefix || '').trim().replace(/\/+$/, '');
    if (p) {
      if (!/^https?:\/\/[^\s]+$/i.test(p)) {
        return res.status(400).json({ error: '前缀须为 http(s):// 开头的地址（如 https://your.domain.com），或留空使用当前访问地址' });
      }
      if (p.length > 200) return res.status(400).json({ error: '前缀过长' });
    }
    setSetting(db, PREFIX_KEY, p);
    cur = p;
  }
  if ('enabled' in b) setSetting(db, ENABLED_KEY, (b.enabled === false || b.enabled === 0 || b.enabled === '0') ? '0' : '1');
  res.json({ ok: true, prefix: cur, enabled: isEnabled() });
});

// ---------- H5 完成测试 / AI 分析后同步（免登录：档案号 uid 即凭证；登录则记归属） ----------
router.post('/mbti/records', (req, res) => {
  if (rejectDisabled(req, res)) return;
  const b = req.body || {};
  const id = String(b.id || '');
  if (!ID_RE.test(id)) return res.status(400).json({ error: '档案 ID 不合法' });
  const data = JSON.stringify(b);
  if (data.length > 300000) return res.status(400).json({ error: '档案数据过大' });
  // 已登录：档案归属校验（防覆盖他人档案）；匿名（手机直开 H5 未登录工作台）：
  // 覆盖需知道长随机档案 ID（不可猜，与公开读取同一能力模型），放行
  const exist = db.prepare('SELECT user_id FROM mbti_records WHERE id=?').get(id);
  if (exist && req.user && exist.user_id !== 0 && exist.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '该档案属于其他用户' });
  }
  const testId = String(b.testId || (b.version ? 'mbti' : '') || '');
  const ownerName = req.user
    ? (req.user.display_name || req.user.username || '')
    : String((b.userInfo || {}).nickname || ''); // 匿名：用 H5 昵称占位，列表不显示「用户#0」
  db.prepare(`
    INSERT INTO mbti_records(id, user_id, user_name, uid, version, type, name, test_id, test_title, summary, finished_at, data)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      user_name=excluded.user_name, uid=excluded.uid, version=excluded.version,
      type=excluded.type, name=excluded.name, test_id=excluded.test_id,
      test_title=excluded.test_title, summary=excluded.summary,
      finished_at=excluded.finished_at,
      data=excluded.data, updated_at=datetime('now','localtime')
  `).run(
    id, (exist ? exist.user_id : (req.user ? req.user.id : 0)), ownerName,
    String(b.uid || ''), String(b.version || ''), String(b.type || ''),
    String(b.name || ''), testId,
    String(b.testTitle || (testId === 'mbti' ? 'MBTI 职业性格测试' : '')),
    String(b.summary || b.type || ''),
    b.finishedAt ? toLocalDb(b.finishedAt) : null, data
  );
  // H5「我的」资料随档案一起带到（以最近一次提交为准，管理员列表可见）
  const info = b.userInfo;
  if (info && info.uid && UID_RE.test(String(info.uid))) {
    upsertUserInfo(String(info.uid), info, false);
  }
  res.json({ ok: true });
});

// ---------- 用户测试列表（管理员；服务端分页，默认 15 行；?uid=U… 按档案号筛选） ----------
router.get('/mbti/records', (req, res) => {
  if (!adminOnly(req, res)) return;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.max(5, Math.min(100, parseInt(req.query.pageSize, 10) || 15));
  const uidIn = parseInt(req.query.user_id, 10);
  const userFilter = Number.isFinite(uidIn) && uidIn > 0 ? uidIn : 0;
  const uidFilter = UID_RE.test(String(req.query.uid || '')) ? String(req.query.uid) : '';
  const conds = [];
  const bind = [];
  if (userFilter > 0) { conds.push('user_id = ?'); bind.push(userFilter); }
  if (uidFilter) { conds.push('uid = ?'); bind.push(uidFilter); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM mbti_records ${where}`).get(...bind).c;
  const rows = db.prepare(`
    SELECT id, user_id, user_name, uid, version, type, name, test_id, test_title, summary, finished_at, updated_at
    FROM mbti_records ${where}
    ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?
  `).all(...bind, pageSize, (page - 1) * pageSize);
  res.json({ total, page, pageSize, rows });
});

// ---------- 系统用户列表（管理员；按 H5 档案编号 uid 分组：有记录的 + 只填了资料的） ----------
router.get('/mbti/users', (req, res) => {
  if (!adminOnly(req, res)) return;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.max(5, Math.min(100, parseInt(req.query.pageSize, 10) || 15));
  const total = db.prepare(`
    SELECT COUNT(*) c FROM (
      SELECT uid FROM mbti_records WHERE uid != '' GROUP BY uid
      UNION
      SELECT uid FROM mbti_user_info WHERE uid != ''
    )
  `).get().c;
  // UNION 两段：①有测试记录的 uid（统计次数/最近测试）②只填过资料、还没做过测试的 uid（count=0）——
  // 只填资料没测试的人也必须出现在列表里，否则管理员看不到「保存了资料」这件事
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT r.uid,
             MAX(r.user_name) AS user_name,
             MAX(r.user_id) AS user_id,
             COUNT(*) AS count,
             MAX(r.updated_at) AS last_at,
             SUM(CASE WHEN r.test_id = 'mbti' OR r.test_id = '' THEN 1 ELSE 0 END) AS mbti_count,
             SUM(CASE WHEN r.ai_analysis_done = 1 THEN 1 ELSE 0 END) AS ai_count,
             i.nickname, i.name AS real_name, i.age, i.gender, i.job, i.hobbies,
             i.ai_authorized
      FROM mbti_records r
      LEFT JOIN mbti_user_info i ON i.uid = r.uid
      WHERE r.uid != ''
      GROUP BY r.uid
      UNION ALL
      SELECT i2.uid, '', 0, 0, NULL, 0, 0,
             i2.nickname, i2.name, i2.age, i2.gender, i2.job, i2.hobbies, i2.ai_authorized
      FROM mbti_user_info i2
      WHERE i2.uid != '' AND NOT EXISTS (SELECT 1 FROM mbti_records WHERE uid = i2.uid)
    ) ORDER BY last_at DESC LIMIT ? OFFSET ?
  `).all(pageSize, (page - 1) * pageSize);
  res.json({ total, page, pageSize, rows });
});

// ---------- 删除测试人员（管理员）：档案资料 + 该档案号的全部测试记录 ----------
router.delete('/mbti/users/:uid', (req, res) => {
  if (!adminOnly(req, res)) return;
  const uid = String(req.params.uid || '');
  if (!UID_RE.test(uid)) return res.status(400).json({ error: '档案编号不合法' });
  const r = db.prepare('DELETE FROM mbti_records WHERE uid=?').run(uid);
  db.prepare('DELETE FROM mbti_user_info WHERE uid=?').run(uid);
  res.json({ ok: true, uid, deleted_records: r.changes });
});

// ---------- 删除档案（管理员） ----------
router.delete('/mbti/records/:id', (req, res) => {
  if (!adminOnly(req, res)) return;
  const r = db.prepare('DELETE FROM mbti_records WHERE id=?').run(String(req.params.id || ''));
  if (!r.changes) return res.status(404).json({ error: '记录不存在' });
  res.json({ ok: true });
});

// ==================== 个人资料入库（H5「我的」保存资料 → 工作台用户列表） ====================

// uid 资料 upsert：与已有行按字段合并（后来只带部分字段的同步不得清空已存的完整资料）；
// fromAdmin=true 时允许带 ai_authorized（普通用户不可自行授权）
function upsertUserInfo(uid, info, fromAdmin) {
  const i = info || {};
  const str = v => String(v == null ? '' : v).slice(0, 100);
  const exist = db.prepare('SELECT * FROM mbti_user_info WHERE uid=?').get(uid) || {};
  const merged = k => str(i[k]) || String(exist[k] == null ? '' : exist[k]).slice(0, 100);
  const aiFlag = fromAdmin && (i.ai_authorized === 1 || i.ai_authorized === true || i.ai_authorized === '1')
    ? 1
    : (exist.ai_authorized || 0);
  db.prepare(`
    INSERT INTO mbti_user_info(uid, nickname, name, age, gender, job, hobbies, ai_authorized, updated_at)
    VALUES(?,?,?,?,?,?,?,?, datetime('now','localtime'))
    ON CONFLICT(uid) DO UPDATE SET
      nickname=excluded.nickname, name=excluded.name, age=excluded.age, gender=excluded.gender,
      job=excluded.job, hobbies=excluded.hobbies, ai_authorized=excluded.ai_authorized,
      updated_at=datetime('now','localtime')
  `).run(
    uid, merged('nickname'), merged('name'), merged('age'), merged('gender'), merged('job'), merged('hobbies'), aiFlag
  );
}

// H5 保存资料（免登录）：匿名（手机直开 H5）直接放行——档案号即凭证；
// 已登录则做归属校验（该编号已有档案时须属于当前账号，防止改别人的资料）
router.post('/mbti/user-info', (req, res) => {
  if (rejectDisabled(req, res)) return;
  const b = req.body || {};
  const uid = String(b.uid || '');
  if (!UID_RE.test(uid)) return res.status(400).json({ error: '档案编号不合法' });
  if (req.user) {
    const owner = db.prepare('SELECT user_id FROM mbti_records WHERE uid=? ORDER BY updated_at DESC LIMIT 1').get(uid);
    if (owner && owner.user_id !== 0 && owner.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: '该档案编号属于其他用户' });
    }
  }
  upsertUserInfo(uid, b, false);
  res.json({ ok: true });
});

// ==================== AI 深度分析（按 uid 授权，服务端代理 ai_config） ====================

function aiAuthorized(uid) {
  if (!uid) return false;
  const row = db.prepare('SELECT ai_authorized FROM mbti_user_info WHERE uid=?').get(String(uid));
  return !!(row && row.ai_authorized);
}

// 授权探测（登录）：H5 结果页 / 「我的」列表据此显示按钮
router.get('/mbti/ai-auth', (req, res) => {
  if (rejectDisabled(req, res)) return;
  const uid = String(req.query.uid || '');
  res.json({ ok: UID_RE.test(uid) && aiAuthorized(uid) });
});

// 授权开关（管理员）：系统用户列表勾选
router.put('/mbti/users/:uid/ai-auth', (req, res) => {
  if (!adminOnly(req, res)) return;
  const uid = String(req.params.uid || '');
  if (!UID_RE.test(uid)) return res.status(400).json({ error: '档案编号不合法' });
  const on = (req.body || {}).authorized === true || (req.body || {}).authorized === 1;
  db.prepare(`
    INSERT INTO mbti_user_info(uid, ai_authorized, updated_at)
    VALUES(?,?, datetime('now','localtime'))
    ON CONFLICT(uid) DO UPDATE SET ai_authorized=excluded.ai_authorized, updated_at=datetime('now','localtime')
  `).run(uid, on ? 1 : 0);
  res.json({ ok: true, uid, ai_authorized: on ? 1 : 0 });
});

// 深度分析代理（免登录，真正的闸门是管理员按 uid 的授权）：档案须存在 + uid 已授权
// → aiService.chat（走统一 ai_config）→ 结果写回档案
router.post('/mbti/ai-analysis', async (req, res) => {
  if (rejectDisabled(req, res)) return;
  const b = req.body || {};
  const id = String(b.id || '');
  const uid = String(b.uid || '');
  const prompt = String(b.prompt || '');
  if (!ID_RE.test(id) || !UID_RE.test(uid)) return res.status(400).json({ error: '参数不合法' });
  if (prompt.length < 50) return res.status(400).json({ error: '分析内容过短' });
  if (prompt.length > 60000) return res.status(400).json({ error: '分析内容过长' });
  const row = db.prepare('SELECT user_id, data, ai_analysis_done, test_id FROM mbti_records WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: '档案不存在（请先完成一次测试并同步）' });
  if (req.user && row.user_id !== 0 && row.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: '该档案属于其他用户' });
  }
  // AI 深度分析仅限 4 大主测（MBTI/霍兰德/DISC/九型）——趣味测试不提供
  {
    let tid = String(row.test_id || '');
    if (!tid) { try { const j = JSON.parse(row.data || '{}'); tid = String(j.testId || (j.version ? 'mbti' : '')); } catch (e) { /* 忽略 */ } }
    if (!['mbti', 'holland', 'disc', 'enneagram'].includes(tid)) {
      return res.status(400).json({ error: '趣味测试不提供 AI 深度分析' });
    }
  }
  if (!aiAuthorized(uid)) return res.status(403).json({ error: '未开通 AI 分析授权，请联系管理员' });
  try {
    const text = await aiService.chat(
      [
        { role: 'system', content: '你是专业的心理测评分析师。基于用户提供的测试作答明细与结果做完整、深入、友善的分析，输出 Markdown，不要输出与心理分析无关的内容。' },
        { role: 'user', content: prompt },
      ],
      { maxTokens: 4096, temperature: 0.7, tdb: req.tdb || db } // 匿名请求无 req.tdb：ai_config 默认共享主库
    );
    // 服务端持久化（H5 端也会再同步一次，两边一致）
    try {
      const j = JSON.parse(row.data || '{}');
      j.aiAnalysis = text;
      j.aiAnalysisAt = new Date().toISOString();
      db.prepare("UPDATE mbti_records SET data=?, ai_analysis_done=1, updated_at=datetime('now','localtime') WHERE id=?")
        .run(JSON.stringify(j), id);
    } catch (e) { /* 档案 JSON 异常不影响返回 */ }
    res.json({ ok: true, text });
  } catch (e) {
    res.status(503).json({ error: 'AI 调用失败：' + (e.message || '未知错误') });
  }
});

module.exports = router;
