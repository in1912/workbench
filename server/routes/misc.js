const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// 多租户路由选库约定：
//  - 业务数据（邮件/文件/AI会话/业务系统/档案/待办模板/看板布局…）→ req.tdb（租户库）
//  - 可共享模块（新闻/节假日/AI配置/高德Key）→ routedDb(req.tdb, flag)：开关开=主库（adminOnly 写），关=租户库自配
const { db, getSetting, setSetting, getShareFlags, routedDb, getAmapKey, getTenantDb } = require('../db');
const newsService = require('../services/newsService');
const weatherService = require('../services/weatherService');
const emailService = require('../services/emailService');
const aiService = require('../services/aiService');
const feishuService = require('../services/feishuService');
const dingtalkService = require('../services/dingtalkService');
const messageService = require('../services/messageService');
const storagePaths = require('../services/storagePaths');
const multer = require('multer');
const fileTextService = require('../services/fileTextService');
const shApp = require('../shApp'); // 智能家居独立应用的身份常量（sh 模式下的名称/版本兜底）
const desensitizeService = require('../services/desensitizeService'); // AI 数据脱敏（LLM在线模型对话接入，v1.13.1）
// 上传中间件（文件存档 / AI 附件共用）：内存暂存，限 20MB
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// 中文文件名乱码修复：multer/busboy 把浏览器发来的 UTF-8 文件名按 latin1 解码
// （"测试.docx" → "æµ‹è¯•.docx"）。还原 = 按 latin1 取回原始字节再按 UTF-8 解码；
// 若名称本来就是正确的 UTF-8，重转会出现替换符（�）或不变，此时保持原样。
// 同时在读取处也做一次（自愈已入库的乱码行）。
function fixMojibakeName(name) {
  if (!name) return name;
  try {
    const converted = Buffer.from(name, 'latin1').toString('utf8');
    return converted === name || converted.includes('�') ? name : converted;
  } catch { return name; }
}

// 共享模块的写操作守卫：开关开启时仅管理员可改（关闭后各租户自配）
function denySharedWrite(req, res, flag, label) {
  if (getShareFlags()[flag] && req.user.role !== 'admin') {
    res.status(403).json({ error: `「${label}」由管理员统一配置，如需自定义请联系管理员` });
    return true;
  }
  return false;
}

const router = express.Router();
router.use(express.json());

// ---------- 系统信息（免登录：登录页/标题需要显示系统名称；系统键永在主库） ----------
router.get('/system-info', (req, res) => {
  // 运行模式（v2.0.0）：smarthome = 智能家居独立应用（免登录、精简模块），workbench = 全能工作台。
  // 前端分流用（智能家居入口页据此不回登录页）；也便于运维一眼看出容器跑的是哪一个
  const SH = process.env.WB_MODE === 'smarthome';
  res.json({
    mode: SH ? 'smarthome' : 'workbench',
    // 名称/版本兜底按模式分：独立应用空库首启时若回「全能工作台 / v1.9.8」，会让人以为装错了包
    //（settings 里没有 current_version 键时走兜底值，见 server/shApp.js 的注释）
    name: getSetting('system_name', SH ? shApp.displayName : '全能工作台'),
    name_en: getSetting('system_name_en', SH ? shApp.displayNameEn : 'Workbench'),
    version: getSetting('current_version', '') || (SH ? shApp.version : 'v1.9.8'),
    // 运行时探针：容器里的 Node 版本只有到这里才问得到（无 SSH 环境排障用）。
    // ws=false 意味着 Node < 22.4（内置全局 WebSocket 那时还没默认开启）——智能板
    // 「官方 MCP 接入点」通道依赖它，会是「面板显示未连接但看不出原因」的根因
    node: process.version,
    ws: typeof globalThis.WebSocket === 'function',
  });
});

// ---------- 前端错误上报（v1.9.3 诊断：全局 errorHandler sendBeacon 上来，内存环存最近 50 条） ----------
// 无 SSH 环境排障用：设置页「前端错误上报」卡可查（仅管理员）。不上报则空，零开销。
const CLIENT_ERRORS = [];
router.post('/client-errors', (req, res) => {
  const { msg, stack, page, ts } = req.body || {};
  if (!msg) return res.status(400).json({ error: '缺少错误信息' });
  CLIENT_ERRORS.unshift({
    ts: Number(ts) || Date.now(),                    // 前端发生时刻（误差=时钟差）
    at: new Date().toLocaleString('zh-CN', { hour12: false }), // 服务端接收时刻
    user: req.user.username, page: String(page || ''), msg: String(msg).slice(0, 300),
    stack: String(stack || '').split('\n').slice(0, 6).join(' ⏎ ').slice(0, 600),
  });
  if (CLIENT_ERRORS.length > 50) CLIENT_ERRORS.length = 50;
  console.log(`[wb-client] ${req.user.username} ${page || ''} | ${String(msg).slice(0, 120)}`);
  res.json({ ok: true });
});
router.get('/client-errors', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可查看' });
  res.json({ errors: CLIENT_ERRORS });
});
router.delete('/client-errors', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
  CLIENT_ERRORS.length = 0;
  res.json({ ok: true });
});
// 保存系统名称（管理员：系统级配置全员可见）
router.post('/settings/system', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '系统名称由管理员设置' });
  const name = String(req.body.name || '').trim();
  const name_en = String(req.body.name_en || '').trim();
  if (name) setSetting('system_name', name.slice(0, 30));
  if (name_en) setSetting('system_name_en', name_en.slice(0, 50));
  res.json({ ok: true });
});

// ---------- 新闻（可共享：开=主库统一抓取/配置，关=各租户自配自抓） ----------
router.get('/news', (req, res) => {
  const cat = req.query.category || 'tech';
  const date = req.query.date || null;
  // 每天抓两次（08:00/13:00）增量入库，一天每类可能有 10~20 条——默认给满 20 条
  // 保证当天抓过的都看得到（原来写死 5 条会把早上那次挤出显示窗口）；
  // 看板卡片等要短列表的调用方用 ?limit=5 显式收紧（1~20）
  const limit = Math.min(20, Math.max(1, Number(req.query.limit) || 20));
  const d = routedDb(req.tdb, 'news');
  // local 城市过滤始终按"请求者租户"的天气城市（共享库无法按单一城市抓取，查询期过滤）
  const city = (getSetting(req.tdb, 'weather', {}) || {}).city || null;
  const items = newsService.getDailyNews(d, cat, limit, date, city);
  res.json({ category: cat, date: date || 'today', items });
});
router.get('/news/dates', (req, res) => {
  res.json({ dates: newsService.getDates(routedDb(req.tdb, 'news')) });
});
router.post('/news/refresh', async (req, res) => {
  if (denySharedWrite(req, res, 'news', '新闻源')) return;
  try {
    const { category } = req.body;
    const d = routedDb(req.tdb, 'news');
    // 共享库一次抓取不按城市过滤（各租户展示时再按自己城市过滤）；独立库按本租户城市抓
    const shared = !!getShareFlags().news;
    const city = shared ? null : ((getSetting(req.tdb, 'weather', {}) || {}).city || null);
    const result = category ? { [category]: await newsService.refreshCategory(d, category, city) } : await newsService.refreshAll(d, city);
    res.json({ ok: true, added: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
router.get('/news/sources', (req, res) => {
  res.json(newsService.getSources(routedDb(req.tdb, 'news')));
});
router.post('/news/sources', (req, res) => {
  if (denySharedWrite(req, res, 'news', '新闻源')) return;
  newsService.setSources(routedDb(req.tdb, 'news'), req.body.sources);
  res.json({ ok: true });
});
// 新闻搜索配置（Tavily：base_url / path / api_key）
router.get('/news/search-config', (req, res) => {
  const c = newsService.getSearchConfig(routedDb(req.tdb, 'news'));
  res.json({ base_url: c.base_url, path: c.path, api_key: c.api_key ? '******' : '', configured: !!c.api_key });
});
router.post('/news/search-config', (req, res) => {
  if (denySharedWrite(req, res, 'news', '新闻源')) return;
  const { base_url, path, api_key } = req.body || {};
  const cur = newsService.getSearchConfig(routedDb(req.tdb, 'news'));
  const finalKey = api_key && api_key !== '******' ? api_key : cur.api_key;
  newsService.setSearchConfig(routedDb(req.tdb, 'news'), { base_url, path, api_key: finalKey });
  res.json({ ok: true });
});
// 百度热搜榜（首页卡片）：实时抓取 + 10 分钟缓存；查看时顺手落当日快照（历史永久留存）
router.get('/news/hot', async (req, res) => {
  try {
    const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 15));
    res.json(await newsService.getHotBoard(routedDb(req.tdb, 'news'), 'realtime', { limit }));
  } catch (e) {
    res.status(503).json({ error: '百度热搜获取失败：' + e.message });
  }
});
// 百度榜单（新闻页 tab：热搜/电影/电视剧）：今天=实时抓取+当日快照落库（fresh=1 跳过缓存）；
// 历史日期=读库永久翻阅。limit 默认 60（实时榜全量 ~51 条，能抓的都给）
router.get('/news/hotboard', async (req, res) => {
  try {
    const board = ['realtime', 'movie', 'teleplay'].includes(req.query.board) ? req.query.board : 'realtime';
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : null;
    const limit = Math.min(60, Math.max(1, Number(req.query.limit) || 60));
    const r = await newsService.getHotBoard(routedDb(req.tdb, 'news'), board, { date, limit, force: req.query.fresh === '1' });
    res.json({ items: [], ...r });   // items 恒为数组（v1.9.2）：外网抓取异常时不许缺键，前端 r.items.length 才不会炸
  } catch (e) {
    res.status(503).json({ error: '榜单获取失败：' + e.message });
  }
});
// 榜单有存档的历史日期（永久，不截 90 天）
router.get('/news/hotboard/dates', (req, res) => {
  const board = ['realtime', 'movie', 'teleplay'].includes(req.query.board) ? req.query.board : 'realtime';
  res.json({ dates: newsService.getHotBoardDates(routedDb(req.tdb, 'news'), board) });
});

// ---------- 天气（城市归租户；缓存按经纬度天然隔离） ----------
router.get('/weather', async (req, res) => {
  res.json(await weatherService.getWeather(req.tdb, req.query.force === '1'));
});
router.post('/weather/geocode', async (req, res) => {
  try {
    const loc = await weatherService.geocode(req.body.city);
    res.json({ ok: true, ...loc });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- 邮箱（每人可配自己的邮箱，全部归租户库） ----------
router.get('/emails', async (req, res) => {
  try {
    const mails = await emailService.listEmails(req.tdb, 30, { accountId: Number(req.query.account) || 1 });
    res.json({ mails });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// 多邮箱账号管理（v1.7.0）：label 即邮箱页 tab 名；密码只写不读（has_pass 标记已配）
router.get('/emails/accounts', (req, res) => {
  res.json({ accounts: emailService.accountsView(req.tdb) });
});
router.post('/emails/accounts', (req, res) => {
  try {
    const id = emailService.saveAccount(req.tdb, null, req.body || {});
    res.json({ id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
router.put('/emails/accounts/:id', (req, res) => {
  try {
    emailService.saveAccount(req.tdb, Number(req.params.id), req.body || {});
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
router.delete('/emails/accounts/:id', (req, res) => {
  const acc = emailService.getAccount(req.tdb, Number(req.params.id));
  if (!acc) return res.status(404).json({ error: '账号不存在' });
  emailService.deleteAccount(req.tdb, Number(req.params.id));
  res.json({ ok: true });
});
// 新邮件提醒设置（弹窗 / 提示音）
router.get('/emails/notify', (req, res) => {
  res.json(emailService.getNotifyCfg(req.tdb));
});
router.put('/emails/notify', (req, res) => {
  emailService.saveNotifyCfg(req.tdb, req.body || {});
  res.json(emailService.getNotifyCfg(req.tdb));
});
// 关键词标签规则（邮件内容检索命中 → 标题前标签，每封只取第一个命中）
router.get('/emails/tags', (req, res) => {
  res.json({ rules: emailService.getTagRules(req.tdb) });
});
router.put('/emails/tags', (req, res) => {
  try { res.json({ rules: emailService.saveTagRules(req.tdb, (req.body || {}).rules) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
// 批量已读 / 批量移动（v1.7.0 列表多选）；清空垃圾箱服务端一次删完
router.post('/emails/batch-seen', (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  emailService.batchSeen(req.tdb, ids);
  res.json({ ok: true, n: ids.length });
});
router.post('/emails/batch-move', (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  try {
    emailService.batchMove(req.tdb, ids, req.body && req.body.to);
    res.json({ ok: true, n: ids.length });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
router.post('/emails/purge-trash', (req, res) => {
  const acc = Number(req.query.account) || 0;
  if (acc) req.tdb.prepare(`DELETE FROM emails WHERE account_id=? AND folder='trash'`).run(acc);
  else req.tdb.prepare(`DELETE FROM emails WHERE folder='trash'`);
  res.json({ ok: true });
});
router.get('/emails/local', (req, res) => {
  const pageSize = Math.min(1000, Math.max(1, Number(req.query.pageSize) || 20));
  const page = Math.max(1, Number(req.query.page) || 1);
  const folder = ['inbox', 'sent', 'trash', 'draft'].includes(req.query.folder) ? req.query.folder : 'inbox';
  const q = (req.query.q || '').trim();
  const accountId = Number(req.query.account) || undefined;
  const { total, rows } = emailService.listFolder(req.tdb, folder, { q, page, pageSize, accountId });
  // 收件箱未读数（账号 tab 角标；与列表同条件统计，仅 folder=inbox 时才算）
  let unread = 0;
  if (folder === 'inbox') {
    const accCond = accountId ? `AND account_id=${Number(accountId)}` : '';
    const like = `%${q}%`;
    const cond = q ? `AND (subject LIKE ? OR from_addr LIKE ? OR to_addr LIKE ? OR body LIKE ?)` : '';
    const params = q ? [like, like, like, like] : [];
    unread = req.tdb.prepare(`SELECT COUNT(*) c FROM emails WHERE folder='inbox' ${accCond} AND seen=0 ${cond}`).get(...params).c;
  }
  res.json({ mails: rows, total, page, pageSize, folder, unread });
});
router.post('/emails/:uid/seen', (req, res) => {
  emailService.markSeen(req.tdb, req.params.uid, Number(req.query.account) || Number(req.body && req.body.account) || 0);
  res.json({ ok: true });
});
// 邮件移入文件夹（垃圾箱/恢复/彻底删除）
router.post('/emails/:id/move', (req, res) => {
  const id = Number(req.params.id);
  const to = req.body.to;
  const cur = req.tdb.prepare('SELECT * FROM emails WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: '邮件不存在' });
  if (to === 'delete') {
    req.tdb.prepare('DELETE FROM emails WHERE id=?').run(id); // 彻底删除（垃圾箱里的"删除"）
  } else if (to === 'trash') {
    req.tdb.prepare(`UPDATE emails SET folder='trash', deleted_at=datetime('now','localtime') WHERE id=?`).run(id);
  } else if (['inbox', 'sent', 'draft'].includes(to)) {
    req.tdb.prepare(`UPDATE emails SET folder=?, deleted_at=NULL WHERE id=?`).run(to, id);
  } else {
    return res.status(400).json({ error: '无效文件夹' });
  }
  res.json({ ok: true });
});
// 发送邮件（SMTP；multipart 可带附件，v1.7.1——前端 FormData，字段名 attachments，单个 ≤20MB、最多 10 个）
router.post('/emails/send', upload.array('attachments', 10), async (req, res) => {
  try {
    const { to, cc, subject, text, draftId, accountId } = req.body || {};
    const attachments = (req.files || []).map((f) => ({
      filename: fixMojibakeName(f.originalname),
      contentType: f.mimetype,
      buf: f.buffer,
    }));
    const r = await emailService.sendMail(req.tdb, { to, cc, subject, text, accountId, attachments });
    if (draftId) req.tdb.prepare('DELETE FROM emails WHERE id=? AND folder=?').run(Number(draftId), 'draft');
    res.json(r);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
// 存草稿
router.post('/emails/draft', (req, res) => {
  try {
    const id = emailService.saveDraft(req.tdb, req.body || {});
    res.json({ id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
// SMTP 测试
router.post('/emails/send-test', async (req, res) => {
  try {
    const cfg = emailService.getAccount(req.tdb, Number(req.body && req.body.accountId) || 1) || {};
    const r = await emailService.sendMail(req.tdb, { to: cfg.smtp_user, subject: '工作台发信测试', text: '这是一封来自个人工作台的 SMTP 测试邮件，收到即说明发件配置正确。', accountId: cfg.id });
    res.json({ ...r, to: cfg.smtp_user });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
// 签名（GET 掩码无关，直接原文返回给本人使用）
router.get('/emails/signature', (req, res) => {
  const cfg = emailService.getAccount(req.tdb, Number(req.query.account) || 1) || {};
  res.json({ signature: cfg.signature || '', from_name: cfg.smtp_from_name || '', trash_keep_days: cfg.trash_keep_days || 30 });
});

// ---------- 邮件附件存储配置（NAS 路径，归租户） ----------
router.get('/emails/attach-config', (req, res) => {
  res.json(emailService.getAttachConfig(req.tdb));
});
router.post('/emails/attach-config', (req, res) => {
  emailService.saveAttachConfig(req.tdb, req.body || {});
  res.json({ ok: true });
});

// ---------- 文件存档存储配置（NAS 路径，归租户；与邮件附件同法） ----------
router.get('/settings/files-dir', (req, res) => {
  const c = getSetting(req.tdb, 'files_storage', null) || {};
  res.json({ dir: c.dir || '' });
});
router.post('/settings/files-dir', (req, res) => {
  const dir = String((req.body && req.body.dir) || '').trim();
  if (dir) {
    try { fs.mkdirSync(dir, { recursive: true }); }
    catch (e) { return res.status(400).json({ error: '目录不可用：' + e.message }); }
  }
  setSetting(req.tdb, 'files_storage', { dir });
  res.json({ ok: true, dir });
});
// 全局默认上传保存路径（主库全局设置，仅管理员可改）：
// 未单独配置目录的上传（家庭图床 / AI 聊天附件 / 账单导入，及文件存档、邮件附件的专属目录留空时）默认保存到这里
router.get('/settings/upload-root', (req, res) => {
  res.json({ dir: storagePaths.getUploadRoot() });
});
router.post('/settings/upload-root', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可配置全局上传路径' });
  const dir = String((req.body && req.body.dir) || '').trim();
  if (dir) {
    try { fs.mkdirSync(dir, { recursive: true }); }
    catch (e) { return res.status(400).json({ error: '目录创建失败：' + e.message }); }
    try { const probe = path.join(dir, '.wb-write-test'); fs.writeFileSync(probe, 'ok'); fs.unlinkSync(probe); }
    catch (e) { return res.status(400).json({ error: '目录不可写：' + e.message }); }
  }
  storagePaths.saveUploadRoot(dir);
  res.json({ ok: true, dir });
});

// ---------- 本地直连地址（全局，仅管理员可改） ----------
// 家庭设备与 NAS 同一局域网时，视频教学的大文件（视频/音频/PDF）优先从这个地址读取
// （局域网直连比公网穿透隧道快得多）。前端使用前先探测 /api/health 可达性，
// 不可达自动回落当前访问地址；只允许 http(s)://主机[:端口] 形式（不带路径）。
router.get('/settings/local-base', (req, res) => {
  res.json({ base: getSetting(db, 'local_base_url', '') || '' });
});
router.post('/settings/local-base', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可配置本地直连地址' });
  const base = String((req.body && req.body.base) || '').trim().replace(/\/+$/, '');
  if (base && !/^https?:\/\/[^\s/?#]+$/.test(base)) {
    return res.status(400).json({ error: '地址格式应为 http://IP:端口（不带路径），如 http://192.168.1.50:21716' });
  }
  setSetting(db, 'local_base_url', base);
  res.json({ ok: true, base });
});

// ---------- 多平台访问地址（自 family-learning v3.0 移植；「设置 → 多平台」分享访问用） ----------
// 外网地址：花生壳/内网穿透等公网入口，登录即可读（分享页要展示），仅管理员可改
router.get('/settings/external-base', (req, res) => {
  res.json({
    external: getSetting(db, 'external_base_url', '') || '',
    lan: getSetting(db, 'local_base_url', '') || '',
  });
});
router.post('/settings/external-base', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可配置外网访问地址' });
  const base = String((req.body && req.body.external) || '').trim().replace(/\/+$/, '');
  if (base && !/^https?:\/\/[^\s/?#]+$/.test(base)) {
    return res.status(400).json({ error: '地址格式应为 http(s)://域名[:端口]（不带路径），如 https://your.domain.com' });
  }
  setSetting(db, 'external_base_url', base);
  res.json({ ok: true, external: base });
});
// 填表建议：服务进程所在网卡的 IPv4 地址（Docker 部署时是容器内网地址，仅供参考）
router.get('/settings/lan-addrs', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可查看' });
  const port = String((req.headers.host || '').split(':')[1] || process.env.PORT || 3000);
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (/^(lo|docker|veth|br-)/i.test(name)) continue;
      const u = `http://${ni.address}:${port}`;
      if (!out.includes(u)) out.push(u);
    }
  }
  res.json({ addrs: out });
});
// 附件下载：/api/emails/:id/attachments/:idx（按 attachments JSON 下标）
router.get('/emails/:id/attachments/:idx', (req, res) => {
  const row = req.tdb.prepare('SELECT attachments FROM emails WHERE id=?').get(req.params.id);
  if (!row || !row.attachments) return res.status(404).json({ error: '无附件' });
  let list;
  try { list = JSON.parse(row.attachments); } catch { return res.status(500).json({ error: '附件信息损坏' }); }
  const att = list[Number(req.params.idx)];
  if (!att) return res.status(404).json({ error: '附件不存在' });
  if (!att.stored || !att.path) return res.status(404).json({ error: '附件未落盘（请先在「设置」配置附件存储目录，再重新拉取邮件）' });
  const full = emailService.attachmentFullPath(req.tdb, att.path);
  if (!full) return res.status(404).json({ error: '附件目录未配置' });
  res.download(full, att.filename);
});
// 补拉附件：强制重拉最近 N 封「登记过附件但结果为空」的邮件（v1.2.5 前的 '[]' 毒化行），
// 解析器修复后老邮件靠它翻案；也可在 body 传 {limit:10~100} 控制范围
router.post('/emails/refetch-attachments', async (req, res) => {
  try {
    const n = Math.min(100, Math.max(10, Number(req.body?.limit) || 50));
    const r = await emailService.listEmails(req.tdb, n, { force: true, accountId: Number(req.body?.account) || 1 });
    const atts = r.reduce((s, m) => s + (Array.isArray(m.attachments) ? m.attachments.length : 0), 0);
    res.json({ ok: true, mails: r.length, attachments: atts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- 邮件通讯录（租户） ----------
router.get('/contacts', (req, res) => {
  const q = (req.query.q || '').trim();
  const like = `%${q}%`;
  const rows = q
    ? req.tdb.prepare('SELECT * FROM email_contacts WHERE name LIKE ? OR email LIKE ? OR remark LIKE ? ORDER BY id DESC LIMIT 200').all(like, like, like)
    : req.tdb.prepare('SELECT * FROM email_contacts ORDER BY id DESC LIMIT 200').all();
  res.json(rows);
});
router.post('/contacts', (req, res) => {
  const { name, email, remark } = req.body || {};
  if (!email || !String(email).trim()) return res.status(400).json({ error: '邮箱地址不能为空' });
  const r = req.tdb.prepare('INSERT INTO email_contacts(name,email,remark) VALUES(?,?,?)')
    .run((name || '').trim(), String(email).trim(), (remark || '').trim());
  res.json({ id: Number(r.lastInsertRowid) });
});
router.delete('/contacts/:id', (req, res) => {
  req.tdb.prepare('DELETE FROM email_contacts WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- 业务系统（凭据加密 + Skill 体系，归租户） ----------
const skillService = require('../services/businessSkillService');

router.get('/business', (req, res) => {
  res.json(req.tdb.prepare('SELECT * FROM business_systems ORDER BY id').all().map(skillService.sanitizeSystem));
});
router.post('/business', (req, res) => {
  const { name, url, type, token, description, username, password } = req.body;
  const r = req.tdb.prepare(
    'INSERT INTO business_systems(name,url,type,token,description,username,password) VALUES(?,?,?,?,?,?,?)'
  ).run(name, url || '', type || 'web', token || '', description || '',
    username || '', skillService.encrypt(password || ''));
  res.json({ id: r.lastInsertRowid });
});
router.put('/business/:id', (req, res) => {
  const { name, url, type, token, description, username, password } = req.body;
  const cur = req.tdb.prepare('SELECT * FROM business_systems WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '系统不存在' });
  const finalPass = password && password !== '******' ? skillService.encrypt(password) : cur.password;
  req.tdb.prepare(
    'UPDATE business_systems SET name=?, url=?, type=?, token=?, description=?, username=?, password=? WHERE id=?'
  ).run(name, url || '', type || 'web', token || '', description || '',
    username !== undefined ? username : (cur.username || ''), finalPass, req.params.id);
  res.json({ ok: true });
});
router.delete('/business/:id', (req, res) => {
  req.tdb.prepare('DELETE FROM business_systems WHERE id=?').run(req.params.id);
  req.tdb.prepare('DELETE FROM business_skills WHERE system_id=?').run(req.params.id);
  skillService.registerAllTenantSkillJobs();
  res.json({ ok: true });
});
// 通用 API 代理：经业务系统凭据转发请求
router.post('/business/:id/proxy', async (req, res) => {
  const sys = req.tdb.prepare('SELECT * FROM business_systems WHERE id=?').get(req.params.id);
  if (!sys) return res.status(404).json({ error: '系统不存在' });
  const { path, method, body, headers } = req.body || {};
  const target = sys.url.replace(/\/+$/, '') + (path || '');
  try {
    const r = await fetch(target, {
      method: method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...(sys.token ? { Authorization: `Bearer ${sys.token}` } : {}),
        ...(sys.username ? { Authorization: 'Basic ' + Buffer.from(`${sys.username}:${skillService.decrypt(sys.password)}`).toString('base64') } : {}),
        ...(headers || {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const text = await r.text();
    res.status(r.status).json({ status: r.status, body: text });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

// ---------- 业务 Skill（租户） ----------
router.get('/business/skills', (req, res) => {
  const { system_id } = req.query;
  res.json(skillService.listSkills(req.tdb, system_id ? Number(system_id) : null));
});
router.post('/business/skills', (req, res) => {
  try {
    const id = skillService.saveSkill(req.tdb, req.body);
    res.json({ id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
router.put('/business/skills/:id', (req, res) => {
  try {
    skillService.saveSkill(req.tdb, { ...req.body, id: Number(req.params.id) });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
router.delete('/business/skills/:id', (req, res) => {
  skillService.deleteSkill(req.tdb, Number(req.params.id));
  res.json({ ok: true });
});
// 立即执行一个 Skill
router.post('/business/skills/:id/run', async (req, res) => {
  try {
    const result = await skillService.runSkillById(req.tdb, Number(req.params.id));
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- AI（配置可共享：开=主库统一（adminOnly 写），关=租户自配；会话数据永远归租户） ----------
router.get('/ai/config', (req, res) => {
  const c = aiService.getConfig(req.tdb);
  res.json({
    model: c.model, base_url: c.base_url, api_key: c.api_key ? '******' : '',
    vision_model: c.vision_model || '', vision_base_url: c.vision_base_url || '', vision_api_key: c.vision_api_key ? '******' : '',
  });
});
router.post('/ai/config', (req, res) => {
  if (denySharedWrite(req, res, 'ai_config', 'AI 配置')) return;
  const { model, base_url, api_key, vision_model, vision_base_url, vision_api_key } = req.body;
  const cur = aiService.getConfig(req.tdb);
  // 前端回传的是掩码 '******'，此时保留原 key 不覆盖
  const finalKey = api_key && api_key !== '******' ? api_key : cur.api_key;
  const finalVKey = vision_api_key && vision_api_key !== '******' ? vision_api_key : cur.vision_api_key;
  routedDb(req.tdb, 'ai_config').prepare(
    "UPDATE ai_config SET model=?, base_url=?, api_key=?, vision_model=?, vision_base_url=?, vision_api_key=?, updated_at=datetime('now','localtime') WHERE id=1"
  ).run(
    model || '', base_url || '', finalKey || '',
    vision_model || '', vision_base_url || '', finalVKey || ''
  );
  res.json({ ok: true });
});
// AI 账户余额查询（DeepSeek 等部分服务商开放余额接口）
router.get('/ai/balance', async (req, res) => {
  try {
    const cfg = aiService.getConfig(req.tdb);
    if (!cfg.api_key) return res.json({ ok: false, error: '未配置 API Key' });
    const base = cfg.base_url.replace(/\/+$/, '');
    // 根据服务商推断余额接口；DeepSeek 官方提供 /user/balance
    let url = null;
    if (/deepseek/i.test(base)) url = 'https://api.deepseek.com/user/balance';
    const balanceUrl = getSetting(routedDb(req.tdb, 'ai_config'), 'ai_balance_url', '');
    if (balanceUrl) url = balanceUrl;
    if (!url) return res.json({ ok: false, error: '该服务商暂无通用余额接口，可在设置中填写自定义余额接口' });
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.api_key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    const data = await r.json();
    if (!r.ok) return res.json({ ok: false, error: `余额接口错误 ${r.status}` });
    const info = data.balance_infos?.[0];
    if (info) {
      return res.json({ ok: true, total: info.total_balance, granted: info.granted_balance, currency: info.currency || 'CNY', raw: data });
    }
    // 通用兜底：尝试常见字段
    const total = data.total_balance ?? data.balance ?? data.available ?? null;
    if (total !== null) return res.json({ ok: true, total, currency: data.currency || 'CNY', raw: data });
    return res.json({ ok: true, raw: data });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});
router.post('/ai/balance-url', (req, res) => {
  if (denySharedWrite(req, res, 'ai_config', 'AI 配置')) return;
  setSetting(routedDb(req.tdb, 'ai_config'), 'ai_balance_url', (req.body || {}).url || '');
  res.json({ ok: true });
});
// ---------- AI 对话会话（分主题持久化，归租户） ----------
router.get('/ai/sessions', (req, res) => {
  const rows = req.tdb.prepare(`
    SELECT s.id, s.title, s.model, s.created_at, s.updated_at,
           (SELECT COUNT(*) FROM ai_messages m WHERE m.session_id = s.id) AS msg_count,
           (SELECT COUNT(*) FROM ai_messages m WHERE m.session_id = s.id AND m.role='user') AS user_count
    FROM ai_sessions s ORDER BY s.updated_at DESC LIMIT 100
  `).all();
  res.json({ sessions: rows });
});
router.post('/ai/sessions', (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 30) || '新对话';
  const r = req.tdb.prepare("INSERT INTO ai_sessions(title, model, updated_at) VALUES(?,?,datetime('now','localtime'))")
    .run(title, aiService.getConfig(req.tdb).model || '');
  res.json({ id: Number(r.lastInsertRowid) });
});
router.get('/ai/sessions/:id', (req, res) => {
  const s = req.tdb.prepare('SELECT * FROM ai_sessions WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  const msgs = req.tdb.prepare('SELECT id, role, content, created_at FROM ai_messages WHERE session_id=? ORDER BY id').all(req.params.id);
  res.json({ session: s, messages: msgs });
});
router.delete('/ai/sessions/:id', (req, res) => {
  req.tdb.prepare('DELETE FROM ai_messages WHERE session_id=?').run(req.params.id);
  req.tdb.prepare('DELETE FROM ai_sessions WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
router.post('/ai/sessions/:id/title', (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 30);
  if (!title) return res.status(400).json({ error: '标题不能为空' });
  req.tdb.prepare("UPDATE ai_sessions SET title=?, updated_at=datetime('now','localtime') WHERE id=?").run(title, req.params.id);
  res.json({ ok: true });
});
// AI 上下文 token 统计：取该会话全部消息字符数估算（中文字符≈1 token，英文 4 字符≈1 token）
router.get('/ai/sessions/:id/stats', (req, res) => {
  const s = req.tdb.prepare('SELECT model FROM ai_sessions WHERE id=?').get(req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  const msgs = req.tdb.prepare('SELECT role, content FROM ai_messages WHERE session_id=? ORDER BY id').all(req.params.id);
  let chars = 0;
  for (const m of msgs) chars += String(m.content || '').length;
  // 中文/全角按 1 token，英文/数字按 4 字符 1 token 估算
  const cjk = (String(msgs.map((m) => m.content).join('')).match(/[一-鿿　-〿＀-￯]/g) || []).length;
  const ascii = chars - cjk;
  const tokens = Math.round(cjk + ascii / 4);
  const limit = 1000000; // 1000k 上下文
  res.json({
    model: s.model || aiService.getConfig(req.tdb).model || '',
    context_tokens: tokens,
    context_limit: limit,
    percent: Math.round((tokens / limit) * 1000) / 10,
  });
});
// ---- AI 脱敏（LLM在线模型对话接入） ----
// 把消息数组里所有「文本槽位」抽出来：多条消息共用一张对照表，同一个名字在整轮里只有一个代码
//（否则 AI 读到 ORG-7K2M9 和 PER-3QW8Z 两个代码会当成两个人，用户也看不懂对照表）。
function desensSlots(msgs) {
  const slots = [];
  for (const m of msgs || []) {
    if (Array.isArray(m.content)) {
      for (const p of m.content) if (p && p.type === 'text') slots.push({ m, p });
    } else if (typeof m.content === 'string') {
      slots.push({ m, p: null });
    }
  }
  return slots;
}
function desensApply(slots, masked) {
  slots.forEach((s, i) => { if (s.p) s.p.text = masked[i]; else s.m.content = masked[i]; });
}

// 脱敏面板要的规则摘要。**故意不复用 /api/desensitize/meta**：那条归「效率工具」页权限，
// 而这里属于「人工智能 → LLM在线模型」，两处权限互不隶属 —— 借道会让没有效率工具权限的人拿不到
// 自己的规则说明（甚至误以为脱敏没生效）。走 /ai/* 前缀即自动继承 smarthome.llm 权限（见 auth.js）。
router.get('/ai/desensitize-meta', (req, res) => {
  try {
    const cfg = desensitizeService.getConfig(req.tdb);
    res.json({
      types: desensitizeService.TYPES,
      enabled: cfg.enabled !== false,
      mask_numbers: !!cfg.mask_numbers,
      types_on: cfg.types || {},
      fixed_count: Array.isArray(cfg.fixed_terms) ? cfg.fixed_terms.length : 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/ai/chat', async (req, res) => {
  try {
    const tdb = req.tdb;
    const { messages, session_id } = req.body;
    const last = messages?.[messages.length - 1];
    let sessionId = Number(session_id) || 0;
    // 多模态 content（[ {type:'text'...}, {type:'image_url'...} ]）取文本部分做标题/持久化/引导词
    const flatContent = (c) => {
      if (Array.isArray(c)) return c.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      return String(c || '');
    };
    const lastText = last ? flatContent(last.content) : '';
    // 无会话时自动创建
    if (!sessionId) {
      const title = last && last.role === 'user' ? lastText.slice(0, 18) : '新对话';
      const r = tdb.prepare("INSERT INTO ai_sessions(title, model, updated_at) VALUES(?,?,datetime('now','localtime'))")
        .run(title, aiService.getConfig(tdb).model || '');
      sessionId = Number(r.lastInsertRowid);
    }
    // 持久化用户消息（存文本部分；图片只随请求发送不入库）
    if (last && last.role === 'user') {
      const storeText = Array.isArray(last.content)
        ? lastText + (last.content.some((p) => p.type === 'image_url') ? '\n[图片]' : '')
        : lastText;
      tdb.prepare('INSERT INTO ai_messages(session_id, role, content) VALUES(?,?,?)').run(sessionId, 'user', storeText);
    }
    // 引导词触发：用户输入命中某个业务 Skill 名称时，直接执行该任务
    if (last && last.role === 'user') {
      const hit = skillService.matchSkill(tdb, lastText);
      if (hit) {
        const sys = tdb.prepare('SELECT name FROM business_systems WHERE id=?').get(hit.system_id);
        const result = await skillService.runSkill(tdb, hit);
        const content = `已执行业务任务「${hit.name}」（${sys?.name || '业务系统'}）\n\n${result}`;
        tdb.prepare('INSERT INTO ai_messages(session_id, role, content) VALUES(?,?,?)').run(sessionId, 'assistant', content);
        tdb.prepare("UPDATE ai_sessions SET updated_at=datetime('now','localtime') WHERE id=?").run(sessionId);
        return res.json({ content, skill: hit.name, session_id: sessionId });
      }
    }
    // ---- AI 脱敏：本轮要发出去的文本先换成代码（本地纯规则，不调 AI、不联网）----
    // 说明：用户消息已在上面按原文落库（本地库留真名），这里只改发往在线模型的那一份。
    // 命中业务 Skill 的分支在上面就 return 了 —— 那是本地任务通道，不发在线模型，故不经脱敏。
    const wantMask = !!req.body.desensitize;
    let maskInfo = null;
    if (wantMask) {
      const opts = desensitizeService.optionsFrom(tdb);
      if (!opts.enabled) {
        // 总开关关着 —— 如实告知，绝不假装脱敏
        maskInfo = { skipped: true, reason: 'AI脱敏总开关处于关闭状态（效率工具 → AI脱敏）' };
      } else {
        const slots = desensSlots(messages);
        const r = desensitizeService.encodeMany(slots.map((s) => (s.p ? s.p.text : s.m.content)), opts);
        desensApply(slots, r.masked);
        maskInfo = { mapping: r.mapping, count: r.count };
      }
    }
    const maskMapping = maskInfo && !maskInfo.skipped ? maskInfo.mapping : [];
    // 已发出去的复原文本长度：流式过程中用它算「这一块新增了什么」
    let sentLen = 0;

    // 流式对话：SSE 逐块转发（推理模型边思考边输出，连接持续活跃，避免网关无活动超时 408）
    if (req.body.stream) {
      const cfg = aiService.getConfig(tdb);
      const isMultimodal = messages?.some((m) => Array.isArray(m.content));
      // 文本模型（DeepSeek 官方等）不接受 image_url：配了视觉模型时转发到视觉端点，
      // 否则降级为纯文本（图片转成占位说明，至少不报错）
      let upstream = { base: cfg.base_url.replace(/\/+$/, ''), key: cfg.api_key, model: cfg.model };
      let sendMessages = messages;
      if (isMultimodal) {
        if (cfg.vision_model && (cfg.vision_base_url || cfg.base_url) && (cfg.vision_api_key || cfg.api_key)) {
          upstream = {
            base: (cfg.vision_base_url || cfg.base_url).replace(/\/+$/, ''),
            key: cfg.vision_api_key || cfg.api_key,
            model: cfg.vision_model,
          };
        } else {
          sendMessages = messages.map((m) => ({
            role: m.role,
            content: Array.isArray(m.content)
              ? m.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n') + '\n（附带的图片当前模型无法查看：请在「设置→AI配置」配置视觉模型）'
              : m.content,
          }));
        }
      }
      const upRes = await fetch(aiService.chatEndpoint(upstream.base), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${upstream.key}` },
        body: JSON.stringify({ model: upstream.model, messages: sendMessages, max_tokens: 4096, temperature: 0.7, stream: true, reasoning_effort: 'low' }),
        signal: AbortSignal.timeout(240000),
      });
      if (!upRes.ok) {
        const body = await upRes.text().catch(() => '');
        return res.status(500).json({ error: `AI 接口错误 ${upRes.status}: ${body.slice(0, 200)}` });
      }
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      // 先把手里的对照表交给前端（面板要立刻显示「本轮对照关系」）
      if (wantMask) res.write(`data: ${JSON.stringify({ mask: maskInfo })}\n\n`);
      // 增量复原：AI 的回复里可能有 ORG-7K2M9 这种代码，中途切开会把代码断成两截显示出乱码。
      // 所以尾巴留 maxCode 个字符不发，等下一个 chunk 补齐。
      //
      // ⚠️ 光留 maxCode 个字符**不够**：留出的那段里如果再往前走一点正好跨着一个代码的开头，
      // 那半个代码（`ORG-CZ`）会被当普通文本先发出去；等代码补齐、这一遍 decode 把它换成真名，
      // 已经发走的那截却永远停在那里 —— 前端拼出来的文本和 done.content 对不上（实测症状：
      // 气泡里显示「联系人 ORG-CZR3公司 …」）。所以还要**把尾巴上那个半截代码整个扣住不发**
      // （v1.13.1 e2e「所有 delta 拼起来 == 最终 content」当场抓到这个 bug）。
      const maxCode = maskMapping.reduce((n, m) => Math.max(n, String(m.code || '').length), 0);
      const maskCodes = maskMapping.map((m) => String(m.code || '')).filter(Boolean);
      const safeHeadLen = (s) => {
        let i = s.length;
        while (i > 0 && /[A-Za-z0-9-]/.test(s[i - 1])) i--;   // 回退到最后一个 token 的开头
        const frag = s.slice(i);
        return frag && maskCodes.some((c) => c.length > frag.length && c.startsWith(frag)) ? i : s.length;
      };
      const reader = upRes.body.getReader();
      const decoder = new TextDecoder();
      let full = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          for (const line of chunk.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const json = line.slice(5).trim();
            if (!json || json === '[DONE]') continue;
            try {
              const d = JSON.parse(json);
              const delta = d.choices?.[0]?.delta?.content || '';
              if (delta) {
                full += delta;
                if (maskMapping.length) {
                  const safe = Math.max(0, full.length - maxCode);
                  const head = full.slice(0, safeHeadLen(full.slice(0, safe)));
                  const dec = desensitizeService.decode(head, maskMapping);
                  if (dec.length > sentLen) {
                    res.write(`data: ${JSON.stringify({ delta: dec.slice(sentLen) })}\n\n`);
                    sentLen = dec.length;
                  }
                } else {
                  res.write(`data: ${JSON.stringify({ delta })}\n\n`);
                }
              }
            } catch { /* 跳过无法解析的行 */ }
          }
        }
      } finally {
        // 收尾：把留在缓冲里的尾巴也复原发出去
        let shown = full;
        if (maskMapping.length) {
          shown = desensitizeService.decode(full, maskMapping);
          if (shown.length > sentLen) res.write(`data: ${JSON.stringify({ delta: shown.slice(sentLen) })}\n\n`);
          sentLen = shown.length;
        }
        // 保存完整回复（存复原后的真名 —— 本地库不留代码）
        if (shown) tdb.prepare('INSERT INTO ai_messages(session_id, role, content) VALUES(?,?,?)').run(sessionId, 'assistant', shown);
        tdb.prepare("UPDATE ai_sessions SET updated_at=datetime('now','localtime') WHERE id=?").run(sessionId);
        if (maskMapping.length) {
          try {
            desensitizeService.record(tdb, {
              scope: 'llm_chat', ref: String(sessionId), userId: req.user && req.user.id,
              mapping: maskMapping, maskedText: full, maskedPreview: full.slice(0, 400), status: 'sent',
            });
          } catch { /* 留痕失败不影响对话 */ }
        }
        res.write(`data: ${JSON.stringify({ done: true, content: shown, masked: maskMapping.length > 0, mask_skipped: maskInfo && maskInfo.skipped ? maskInfo.reason : '' })}\n\n`);
        res.end();
      }
      return;
    }
    // 非流式：同样先脱敏再发、回包复原
    const rawText = await aiService.chat(messages, { maxTokens: 4096, reasoningEffort: 'low', tdb });
    const text = maskMapping.length ? desensitizeService.decode(rawText, maskMapping) : rawText;
    tdb.prepare('INSERT INTO ai_messages(session_id, role, content) VALUES(?,?,?)').run(sessionId, 'assistant', text);
    tdb.prepare("UPDATE ai_sessions SET updated_at=datetime('now','localtime') WHERE id=?").run(sessionId);
    if (maskMapping.length) {
      try {
        desensitizeService.record(tdb, {
          scope: 'llm_chat', ref: String(sessionId), userId: req.user && req.user.id,
          mapping: maskMapping, maskedText: rawText, maskedPreview: rawText.slice(0, 400), status: 'sent',
        });
      } catch { /* 留痕失败不影响对话 */ }
    }
    res.json({
      content: text, session_id: sessionId,
      masked: maskMapping.length > 0, count: maskMapping.length, mapping: maskMapping,
      mask_skipped: maskInfo && maskInfo.skipped ? maskInfo.reason : '',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// AI 附件上传：文件 → 文字提取；图片 → base64（vision 多模态）
// 返回可直接并入 OpenAI messages 的 content 结构
router.post('/ai/attachment', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const { mimetype, buffer } = req.file;
    const originalname = fixMojibakeName(req.file.originalname);
    // 全局默认上传路径已配置 → 附件留档一份（尽力而为，不影响返回）
    storagePaths.bestEffortSave('ai-attachments', originalname, buffer, `t${req.user.id}_`);
    const isImage = /^image\//.test(mimetype || '') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(originalname || '');
    if (isImage) {
      return res.json({
        kind: 'image',
        name: originalname,
        url: `data:${mimetype || 'image/png'};base64,${buffer.toString('base64')}`,
      });
    }
    // 文档类：内置提取文字（PDF/Word/Excel/文本）
    const r = fileTextService.extractText(originalname, mimetype, buffer);
    if (!r.text || !r.text.trim()) {
      return res.status(400).json({ error: `「${originalname}」无法提取文字（${r.engine}）` });
    }
    res.json({ kind: 'text', name: originalname, text: r.text.slice(0, 30000), engine: r.engine });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/ai/summarize', async (req, res) => {
  try {
    const { text, instruction } = req.body;
    const out = await aiService.summarize(text, instruction || '请用 80 字以内一句话概括以下内容', req.tdb);
    res.json({ content: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
// 学习复盘：AI 根据最近学习记录生成复盘草稿
router.post('/ai/review', async (req, res) => {
  try {
    const rows = req.tdb.prepare(
      "SELECT record_date, content, gains, problems FROM learning_records ORDER BY id DESC LIMIT 20"
    ).all();
    if (!rows.length) return res.json({ content: '还没有学习记录，先去记录几次学习内容吧。' });
    const data = rows.map((r) => `[${r.record_date}] ${r.content}｜收获:${r.gains || '无'}｜问题:${r.problems || '无'}`).join('\n');
    const out = await aiService.chat([
      { role: 'system', content: '你是学习复盘教练。基于用户的学习记录，生成一份结构化的中文复盘：包含「本周进展总结 / 主要收获 / 遇到的问题 / 下周改进计划」四个部分，简洁具体，直接输出内容。' },
      { role: 'user', content: data },
    ], { maxTokens: 1200, tdb: req.tdb });
    res.json({ content: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 设置（聚合：分库取值 + 共享开关状态） ----------
router.get('/settings', (req, res) => {
  const ai = aiService.getConfig(req.tdb);
  res.json({
    email: emailService.getConfig(req.tdb),
    weather: getSetting(req.tdb, 'weather', {}),
    news_sources: newsService.getSources(routedDb(req.tdb, 'news')),
    ai: { model: ai.model, base_url: ai.base_url },
    share: getShareFlags(), // 前端据此禁用共享模块的编辑（非管理员）
  });
});
router.post('/settings/email', (req, res) => {
  emailService.saveConfig(req.tdb, req.body);
  res.json({ ok: true });
});
router.post('/settings/weather', (req, res) => {
  setSetting(req.tdb, 'weather', { city: req.body.city, lat: req.body.lat, lon: req.body.lon });
  res.json({ ok: true });
});

// ---------- 地图瓦片代理（无状态，免登录） ----------
// 高德/腾讯瓦片对非浏览器请求返回占位图（服务端拉不到真图）；Esri World Street Map
// 服务端可拉真图（WGS-84 坐标系）。经同源 /api/tile 代理给前端，带内存缓存。
const tileCache = new Map();
router.get('/tile', async (req, res) => {
  const { x, y, z } = req.query;
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) {
    res.type('image/jpeg').send(tileCache.get(key));
    return;
  }
  // Esri World Street Map：tile/{z}/{y}/{x}（XYZ 顺序，与 Leaflet 一致）
  const url = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) return res.status(503).end();
    const buf = Buffer.from(await r.arrayBuffer());
    if (tileCache.size > 500) tileCache.clear();
    tileCache.set(key, buf);
    res.type('image/jpeg').send(buf);
  } catch (e) {
    res.status(503).end();
  }
});

// ---------- 静态地图（子进程渲染：底图+路线+标记，单图输出） ----------
// 渲染在独立进程执行（server/mapWorker.js），耗时/异常完全不影响主服务事件循环。
// 遗留免登录端点（前端已改用瓦片+JS 渲染）：多租户后通勤地址归租户库，
// 无请求上下文时取第一个管理员的通勤地址 + 主库共享高德 Key 渲染。
const { execFile } = require('child_process');
const os = require('os');
const MAP_CACHE = new Map(); // 配置指纹 → { t, png }
router.get('/map-static', async (req, res) => {
  try {
    const admin = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
    const cfg = admin ? getSetting(getTenantDb(admin.id), 'commute', {}) : {};
    const key = getAmapKey(db);
    if (!cfg.home || !cfg.work || !key) return res.status(400).json({ error: '通勤未配置（设置 → 通勤）' });
    const finger = `${cfg.home}|${cfg.work}|${key}`;
    const hit = MAP_CACHE.get(finger);
    if (!req.query.force && hit && Date.now() - hit.t < 10 * 60 * 1000) {
      res.set('Cache-Control', 'max-age=600');
      res.type('image/png').send(hit.png);
      return;
    }
    const outPath = path.join(os.tmpdir(), `qgmap-${Date.now()}-${Math.floor(Math.random() * 100000)}.png`);
    await new Promise((resolve, reject) => {
      execFile(process.execPath, [path.join(__dirname, '..', 'mapWorker.js'), JSON.stringify({ home: cfg.home, work: cfg.work, key }), outPath], {
        timeout: 45000, windowsHide: true, cwd: path.join(__dirname, '..'),
      }, (err) => (err ? reject(new Error(err.message || '渲染超时')) : resolve()));
    });
    const png = fs.readFileSync(outPath);
    fs.unlink(outPath, () => {});
    MAP_CACHE.set(finger, { t: Date.now(), png });
    res.set('Cache-Control', 'max-age=600');
    res.type('image/png').send(png);
  } catch (e) {
    res.status(500).json({ error: '地图渲染失败: ' + e.message });
  }
});

// ---------- 通勤（地图路线预计时间：地址/时间归租户，高德 Key 按开关路由） ----------
const commuteService = require('../services/commuteService');
router.get('/commute', async (req, res) => {
  const cfg = commuteService.getConfig(req.tdb);
  try {
    // 整体超时保护：高德链路（定位/路线/交通态势）最坏可能数十秒，超时返回错误而非挂起
    const data = await Promise.race([
      commuteService.calcCommute(req.tdb, req.query.force === '1'),
      new Promise((_, rej) => setTimeout(() => rej(new Error('通勤查询超时，请稍后重试')), 25000)),
    ]);
    res.json({ config: cfg, ...data });
  } catch (e) {
    res.json({ config: cfg, ok: false, error: e.message });
  }
});
router.post('/commute', (req, res) => {
  // 高德 Key 是共享配置：开关开启时非管理员不可改 key（home/work/时间人人可改自己的）
  if (req.body && req.body.key !== undefined && getShareFlags().amap_key && req.user.role !== 'admin') {
    return res.status(403).json({ error: '高德 Key 由管理员统一配置' });
  }
  commuteService.saveConfig(req.tdb, req.body);
  // 刷新时刻变了：重排通勤定时任务（惰性 require 避免循环依赖）
  try { require('../scheduler').rescheduleCommute(); } catch (e) { /* scheduler 未初始化时忽略 */ }
  res.json({ ok: true });
});
// 高德 key（供前端加载高德 JS SDK 渲染中文地图；受登录保护）
router.get('/amap-key', (req, res) => {
  res.json({ key: getAmapKey(req.tdb) });
});

// ---------- AI 推送（Skill 结果留存，按业务系统查看；归租户） ----------
router.get('/pushes/systems', (req, res) => {
  // 列出所有业务系统 + 各自推送条数/最近时间（切换窗口数据源，自动含新增系统）
  const rows = req.tdb.prepare(`
    SELECT s.id, s.name,
      (SELECT COUNT(*) FROM skill_pushes p WHERE p.system_id = s.id) AS push_count,
      (SELECT MAX(created_at) FROM skill_pushes p WHERE p.system_id = s.id) AS last_push
    FROM business_systems s ORDER BY s.id
  `).all();
  res.json({ systems: rows });
});
router.get('/pushes', (req, res) => {
  const systemId = Number(req.query.system_id) || 0;
  const rows = req.tdb.prepare(
    'SELECT id, system_id, skill_name, columns, rows, created_at FROM skill_pushes WHERE system_id=? ORDER BY created_at DESC, id DESC LIMIT 30'
  ).all(systemId);
  res.json({
    pushes: rows.map((r) => ({ ...r, columns: JSON.parse(r.columns || '[]'), rows: JSON.parse(r.rows || '[]') })),
  });
});

// ---------- 飞书推送配置（归租户） ----------
router.get('/feishu/config', (req, res) => {
  const c = feishuService.getConfig(req.tdb);
  res.json({ app_id: c.app_id, app_secret: c.app_secret ? '******' : '', targets: c.targets || [] });
});
router.post('/feishu/config', (req, res) => {
  feishuService.saveConfig(req.tdb, req.body || {});
  res.json({ ok: true });
});
router.get('/feishu/chats', async (req, res) => {
  try { res.json({ chats: await feishuService.listChats(req.tdb) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/feishu/test', async (req, res) => {
  try {
    // 用表格卡片测试（table 组件：无 "--" 分隔行，自带表头底色）
    await feishuService.sendTableAll(req.tdb, '工作台推送测试', ['模块', '状态', '说明'], [
      ['飞书机器人', '正常', '连通性 OK'],
      ['表格组件', '正常', '无 -- 分隔行'],
      ['表头底色', '正常', 'violet 主题'],
    ]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- 钉钉推送配置（归租户） ----------
router.get('/dingtalk/config', (req, res) => {
  const c = dingtalkService.getConfig(req.tdb);
  const app = dingtalkService.getAppConfig();
  res.json({ app_key: c.app_key, app_secret: c.app_secret ? '******' : '', mode: c.mode, robot_code: c.robot_code, agent_id: c.agent_id, userid: c.userid, enabled: c.enabled, bind_base: c.bind_base, bound_nick: c.bound_nick, bound_at: c.bound_at, app_configured: !!(app.app_key && app.app_secret) });
});
router.post('/dingtalk/config', (req, res) => {
  // 应用凭证（AppKey/AppSecret/通道/robotCode/AgentId）由管理员统一配置到全局、全员共享；
  // 个人绑定（userid/开关/回调地址）仍各人各存。非管理员即使传了 app 字段也会被忽略。
  if (req.user && req.user.role === 'admin') dingtalkService.saveAppConfig({ ...req.body, owner_uid: req.user.id });
  dingtalkService.saveBinding(req.tdb, req.body || {});
  require('../services/dingtalkStreamService').rescan(); // 凭证/开关变更即时调整机器人长连接
  res.json({ ok: true });
});
router.post('/dingtalk/test', async (req, res) => {
  try {
    const mode = dingtalkService.getConfig(req.tdb).mode;
    const ok = await dingtalkService.pushIfBound(req.tdb, `【个人工作台】钉钉推送测试（${mode === 'smartbot' ? '服务助手' : '机器人单聊'}通道）\n收到本条说明绑定与通道都正常。`);
    if (!ok) return res.status(400).json({ error: '未启用或未绑定：需填 AppKey/AppSecret/userid 并勾选启用' });
    res.json({ ok: true });
  } catch (e) {
    const smart = dingtalkService.getConfig(req.tdb).mode === 'smartbot';
    res.status(500).json({ error: e.message + (smart ? '（服务助手通道需企业开通员工服务台旗舰版）' : '') });
  }
});
// 测试图片通道：内置小图走完整链路（媒体上传 + 工作通知 asyncsend_v2），一键验证图片推送
router.post('/dingtalk/test-image', async (req, res) => {
  try {
    const cfg = dingtalkService.getConfig(req.tdb);
    if (!cfg.agent_id) return res.status(400).json({ error: '未配置 AgentId：机器人单聊通道官方不支持图片，图片改走「工作通知」通道，请到钉钉开发者后台 → 应用详情 → 凭证与基础信息 复制 AgentId 填到设置里并保存' });
    const ok = await dingtalkService.pushImageIfBound(req.tdb, dingtalkService.makeTestPng(), 'image/png');
    if (!ok) return res.status(400).json({ error: '未启用或未绑定：请先填 AppKey/AppSecret、扫码绑定并勾选启用' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/dingtalk/resolve-mobile', async (req, res) => {
  try { res.json({ userid: await dingtalkService.resolveMobile(req.tdb, (req.body || {}).mobile) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- 钉钉扫码绑定 ----------
router.post('/dingtalk/bind/ticket', (req, res) => {
  try { res.json(dingtalkService.createBindTicket(req.tdb, req.user.id, req.get('origin'))); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.get('/dingtalk/bind/status', (req, res) => {
  res.json(dingtalkService.bindStatus(req.query.ticket));
});
router.post('/dingtalk/unbind', (req, res) => {
  dingtalkService.unbind(req.tdb);
  res.json({ ok: true });
});

// ---------- 钉钉免登配置（全局，归主库：登录前就要用，只能存主库；仅 admin） ----------
router.get('/dingtalk/login-config', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可查看' });
  const c = dingtalkService.getLoginConfig();
  res.json({ corp_id: c.corp_id, app_key: c.app_key, app_secret: c.app_secret ? '******' : '' });
});
router.post('/dingtalk/login-config', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可配置' });
  try {
    dingtalkService.saveLoginConfig(req.body || {});
    // 返回保存后的值供前端回填（防"保存成功但重开页面不回显"被误判为没存上）
    const c = dingtalkService.getLoginConfig();
    res.json({ ok: true, corp_id: c.corp_id, app_key: c.app_key, configured: !!(c.corp_id && c.app_key && c.app_secret) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// 手机端授权回调（免登录，票据即凭证；兼容 authCode/code 两种参数名）
router.get('/dingtalk/bind/callback', async (req, res) => {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = (ok, title, detail) =>
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>钉钉绑定</title><style>body{font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;'
    + 'background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}'
    + '.box{background:#1e293b;padding:36px 30px;border-radius:16px;max-width:86%;text-align:center;box-shadow:0 10px 30px rgba(0,0,0,.35)}'
    + 'h1{font-size:20px;margin:0 0 10px}p{color:#94a3b8;font-size:14px;line-height:1.7;margin:0;word-break:break-all}</style></head><body>'
    + `<div class="box"><h1>${title}</h1><p>${detail}</p></div></body></html>`;
  const authCode = req.query.authCode || req.query.code;
  try {
    const r = await dingtalkService.bindCallback(req.query.state, authCode);
    try { require('../services/dingtalkStreamService').rescan(); } catch {} // 凭证已就绪，同步刷新机器人长连接
    res.type('html').send(html(true, '✅ 绑定成功', esc(`已绑定钉钉账号「${r.nick || r.userid}」，工作台消息将推送到你的钉钉。可关闭此页面回到电脑端查看。`)));
  } catch (e) {
    res.status(400).type('html').send(html(false, '❌ 绑定失败', esc(e.message) + '<br/>请回到电脑端刷新二维码后重试。'));
  }
});

// ---------- 定时推送配置（归租户） ----------
router.get('/schedules', (req, res) => {
  res.json({ schedules: skillService.listSchedules(req.tdb) });
});
router.post('/schedules', (req, res) => {
  try {
    const id = skillService.saveSchedule(req.tdb, req.body);
    res.json({ id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
router.delete('/schedules/:id', (req, res) => {
  skillService.deleteSchedule(req.tdb, Number(req.params.id));
  res.json({ ok: true });
});
router.post('/schedules/:id/run', async (req, res) => {
  try { await skillService.runScheduleNow(req.tdb, Number(req.params.id)); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- 节假日服务（数据源可共享：开=主库统一配置（adminOnly 写），关=租户自配） ----------
const holidayService = require('../services/holidayService');
const lunarService = require('../services/lunarService');
router.get('/holidays', async (req, res) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const data = await holidayService.getHolidays(req.tdb, year);
    // 附加：家人生日（按农历生日映射到该年公历）+ 农历/节气由前端按日计算（/lunar/year 批量给）
    res.json({ holidays: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 整年农历+节气+家人生日（一次给全，日历组件直接查表）
// ---------- 信用卡账单/还款日（归租户） ----------
// 多卡配置存 settings.credit_cards：[{ id, name, bill_day, repay_day, repay_offset, show_in_calendar }]
// bill_day/repay_day：每月几号（1-31，31 在小月自动取月末）；repay_offset：还款日距账单日天数（可空，填了以 offset 为准）
function getCreditCards(tdb) {
  return getSetting(tdb, 'credit_cards', []);
}
router.get('/credit-cards', (req, res) => {
  res.json({ cards: getCreditCards(req.tdb) });
});
router.post('/credit-cards', (req, res) => {
  const cards = Array.isArray(req.body && req.body.cards) ? req.body.cards : [];
  const clean = cards.filter((c) => c && c.name && Number(c.bill_day) >= 1 && Number(c.bill_day) <= 31).map((c, i) => ({
    id: c.id || i + 1,
    name: String(c.name).slice(0, 30),
    bill_day: Math.min(31, Math.max(1, Number(c.bill_day) || 1)),
    // repay_day 与 repay_offset 二选一：offset 优先，否则用 repay_day
    repay_offset: Number(c.repay_offset) > 0 ? Math.min(60, Number(c.repay_offset)) : 0,
    repay_day: Number(c.repay_day) > 0 ? Math.min(31, Number(c.repay_day)) : 0,
    show_in_calendar: c.show_in_calendar ? 1 : 0,
  }));
  setSetting(req.tdb, 'credit_cards', clean);
  res.json({ ok: true, count: clean.length });
});
// 映射某年的账单/还款日期（供日历显示）：返回 [{ date, name, type: 'bill'|'repay', card }]
router.get('/credit-cards/schedule', (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const out = [];
  const p = (n) => String(n).padStart(2, '0');
  for (const c of getCreditCards(req.tdb)) {
    if (!c.show_in_calendar) continue;
    for (let m = 1; m <= 12; m++) {
      const daysInMonth = new Date(year, m, 0).getDate();
      const clamp = (d) => `${year}-${p(m)}-${p(Math.min(d, daysInMonth))}`;
      const billDate = clamp(c.bill_day);
      out.push({ date: billDate, name: `${c.name}账单日`, type: 'bill', card: c.name });
      // 还款日：offset 优先（可能跨月）；否则同月 repay_day
      if (c.repay_offset > 0) {
        const b = new Date(year, m - 1, Math.min(c.bill_day, daysInMonth));
        const r = new Date(b.getTime() + c.repay_offset * 86400000);
        out.push({ date: `${r.getFullYear()}-${p(r.getMonth() + 1)}-${p(r.getDate())}`, name: `${c.name}还款日`, type: 'repay', card: c.name });
      } else if (c.repay_day > 0) {
        out.push({ date: clamp(c.repay_day), name: `${c.name}还款日`, type: 'repay', card: c.name });
      }
    }
  }
  res.json({ schedule: out });
});

router.get('/lunar/year', (req, res) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const p = (n) => String(n).padStart(2, '0');
    const out = {};
    const d = new Date(year, 0, 1);
    const end = new Date(year, 11, 31);
    while (d <= end) {
      const ds = `${year}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      out[ds.slice(5)] = lunarService.lunarLabelOf(ds);
      d.setDate(d.getDate() + 1);
    }
    // 家人生日：family_profiles 的农历生日 → 当年公历日期（随 family 共享开关选库）
    const fdb = routedDb(req.tdb, 'family');
    const profiles = fdb.prepare("SELECT * FROM family_profiles WHERE lunar_birthday != ''").all();
    const birthdays = [];
    for (const f of profiles) {
      const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(f.lunar_birthday || '').trim());
      if (!m) continue;
      const lm = Number(m[1]), ld = Number(m[2]);
      const solar = lunarService.lunar2solar(year, lm, ld, false);
      if (solar) birthdays.push({ name: f.name, relation: f.relation || '', date: solar, lunarText: `${lunarService.LMONTH[lm - 1]}月${lunarService.lunarDayName(ld)}` });
    }
    // 农历生日跨公历年：如农历十一月生日可能落在公历 year 年末（属于农历 year-1 年的冬月/腊月）
    // 处理：把农历 (year-1) 年的冬月/腊月生日也映射进来（它们的公历日期落在本公历年）
    const profilesAll = fdb.prepare("SELECT * FROM family_profiles WHERE lunar_birthday != ''").all();
    for (const f of profilesAll) {
      const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(f.lunar_birthday || '').trim());
      if (!m || Number(m[1]) < 11) continue; // 只看冬月/腊月
      const solar2 = lunarService.lunar2solar(year - 1, Number(m[1]), Number(m[2]), false);
      if (solar2 && solar2.startsWith(String(year))) {
        birthdays.push({ name: f.name, relation: f.relation || '', date: solar2, lunarText: `${lunarService.LMONTH[Number(m[1]) - 1]}月${lunarService.lunarDayName(Number(m[2]))}` });
      }
    }
    res.json({ lunar: out, birthdays });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// 公历 → 农历换算（档案页填公历生日时自动算农历）
router.get('/lunar/convert', (req, res) => {
  const ds = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ds)) return res.status(400).json({ error: '日期格式 YYYY-MM-DD' });
  const lu = lunarService.solar2lunar(ds);
  // animal：生肖（按农历年，前端编辑弹窗实时预览用）
  res.json({ lunar: `${lu.monthName}${lu.dayName}`, key: lu.key, isLeap: lu.isLeap, term: lunarService.solarTermOf(ds), year: lu.year, animal: lunarService.animalOf(ds) });
});
router.get('/holidays/config', (req, res) => {
  res.json(holidayService.getConfig(req.tdb));
});
router.post('/holidays/config', (req, res) => {
  if (denySharedWrite(req, res, 'holiday', '节假日数据源')) return;
  holidayService.saveConfig(req.tdb, req.body || {});
  res.json({ ok: true });
});

// ---------- 短消息（跨租户：主库；成员互发 + 各模块推送留存） ----------
router.get('/messages/contacts', (req, res) => {
  res.json({ users: messageService.listContacts(db, req.user.id) });
});
router.get('/messages/unread', (req, res) => {
  res.json({ messages: messageService.unread(db, req.user.id) });
});
router.post('/messages/read-all', (req, res) => {
  messageService.markAllRead(db, req.user.id);
  res.json({ ok: true });
});
// 与某成员的沟通记录（双向、按时间正序；默认最近 1 天，before_id 向上翻页加载更早历史）
router.get('/messages', (req, res) => {
  const other = Number(req.query.user_id || 0);
  if (!other) return res.json({ messages: [], hasMore: false });
  const r = messageService.conversation(db, req.user.id, other, {
    before_id: Number(req.query.before_id) || 0,
    limit: Number(req.query.limit) || 50,
  });
  res.json({ messages: r.rows, hasMore: r.hasMore });
});
// 发送站内消息：to_users 数组（群发，可含自己）或 to_user 单发
router.post('/messages', (req, res) => {
  const { to_user, to_users, subject, content } = req.body || {};
  if (!String(content || '').trim()) return res.status(400).json({ error: '内容必填' });
  const ids = Array.isArray(to_users) && to_users.length
    ? [...new Set(to_users.map(Number))]
    : [Number(to_user || 0)];
  if (!ids.length || ids.some((id) => !id)) return res.status(400).json({ error: '收件人必填' });
  const valid = ids.filter((id) => db.prepare('SELECT id FROM users WHERE id=?').get(id));
  if (!valid.length) return res.status(400).json({ error: '收件用户不存在' });
  const sent = valid
    .map((id) => messageService.send(db, {
      from_user: req.user.id, to_user: id,
      subject: String(subject || '').trim(), content: String(content).trim(), module: 'message',
    }))
    .filter(Boolean);
  res.json({ ids: sent, count: sent.length, id: sent[0] });
});
// ---------- 桌面通知代理·EXEMPT 端点（免登录；key+uid 双校验，照剪贴板代理模式） ----------
// ⚠ 必须注册在 `/messages/:id/read` 之前：`:id` 参数路由会先吞掉 POST /messages/agent/read（id='agent'），
// 而 EXEMPT 请求没有 req.user → 老路由直接崩 500
function notifyAgentUser(q) {
  const uid = Number(q.uid) || 0;
  const key = String(q.key || '');
  if (!uid || !key) return null;
  const u = db.prepare('SELECT id, notify_key, notify_autoplay FROM users WHERE id=?').get(uid);
  return u && u.notify_key && u.notify_key === key ? u : null;
}
// 轮询新消息：id > after 且未读（网页端已读过的不再弹）；语音带 base64 供自动播放
router.get('/messages/agent/poll', (req, res) => {
  const u = notifyAgentUser(req.query);
  if (!u) return res.status(403).json({ error: '密钥不正确' });
  const after = Number(req.query.after) || 0;
  const rows = db.prepare(
    `SELECT m.*, COALESCE(NULLIF(u2.display_name, ''), u2.username) AS from_name FROM messages m
     LEFT JOIN users u2 ON u2.id = m.from_user
     WHERE m.to_user = ? AND m.id > ? AND m.read_at IS NULL ORDER BY m.id LIMIT 15`
  ).all(u.id, after);
  const messages = rows.map((r) => {
    const o = {
      id: r.id,
      subject: String(r.subject || ''),
      content: r.is_voice ? '' : String(r.content || '').slice(0, 400),
      from_name: r.from_name || `用户${r.from_user}`,
      module_label: messageService.MODULE_LABELS[r.module] || r.module,
      created_at: r.created_at,
      is_voice: !!r.is_voice,
      voice_secs: Number(r.voice_secs) || 0,
      voice_text: String(r.voice_text || '').slice(0, 200),
    };
    if (r.is_voice) {
      try {
        const f = messageService.voiceFile(r.id);
        if (fs.existsSync(f)) {
          const size = fs.statSync(f).size;
          if (size > 0 && size <= 3 * 1024 * 1024) o.voice_b64 = fs.readFileSync(f).toString('base64');
        }
      } catch { /* 文件读不了就只弹文字 */ }
    }
    return o;
  });
  res.json({ ok: true, autoplay: u.notify_autoplay !== 0, messages, last_id: rows.length ? rows[rows.length - 1].id : after });
});
// 弹窗被点击 → 标记已读（打开消息页由代理本地完成；打开会话本身也会自动已读，这里是点击即已读的语义）
router.post('/messages/agent/read', (req, res) => {
  const b = req.body || {};
  const u = notifyAgentUser(b);
  if (!u) return res.status(403).json({ error: '密钥不正确' });
  messageService.markRead(db, u.id, Number(b.id) || 0);
  res.json({ ok: true });
});

router.post('/messages/:id/read', (req, res) => {
  messageService.markRead(db, req.user.id, Number(req.params.id));
  res.json({ ok: true });
});

// ---------- 语音消息（v1.9.24）：WAV 16k 单声道 ≤60s，base64 JSON 上传（≤12mb 限制内） ----------
// 前端 MediaRecorder → 解码重采样 16k mono PCM16 编 WAV（SoundPlayer 任意 Windows 可播、转写引擎原生输入）
router.post('/messages/voice', (req, res) => {
  const b = req.body || {};
  const b64 = String(b.wav_b64 || '').replace(/^data:[^,]+,/, '');
  const secs = Math.max(0, Math.min(60, Number(b.secs) || 0));
  let buf;
  try { buf = Buffer.from(b64, 'base64'); } catch { return res.status(400).json({ error: '语音数据无效' }); }
  if (!buf || buf.length < 44) return res.status(400).json({ error: '缺少语音数据' });
  if (buf.length > 2.5 * 1024 * 1024) return res.status(400).json({ error: '语音过长（上限 60 秒）' });
  if (buf.subarray(0, 4).toString('ascii') !== 'RIFF' || buf.subarray(8, 12).toString('ascii') !== 'WAVE') {
    return res.status(400).json({ error: '仅支持 WAV 语音' });
  }
  const ids = Array.isArray(b.to_users) && b.to_users.length ? [...new Set(b.to_users.map(Number))] : [Number(b.to_user || 0)];
  if (!ids.length || ids.some((id) => !id)) return res.status(400).json({ error: '收件人必填' });
  const valid = ids.filter((id) => db.prepare('SELECT id FROM users WHERE id=?').get(id));
  if (!valid.length) return res.status(400).json({ error: '收件用户不存在' });
  // v1.9.25：语音条不带主题时默认「某某发出的语音信息」（列表页/弹窗不再显示干巴巴的空标题）
  const subject = String(b.subject || '').trim() || `${messageService.userName(db, req.user.id)}发出的语音信息`;
  const sent = valid
    .map((id) => messageService.send(db, {
      from_user: req.user.id, to_user: id, subject, content: '',
      module: 'message', is_voice: 1, voice_secs: secs,
    }))
    .filter(Boolean);
  if (!sent.length) return res.status(500).json({ error: '发送失败' });
  // 语音文件按消息 id 命名（群发每条一份拷贝，60s WAV ≤1.9MB 量级可接受）
  fs.mkdirSync(path.dirname(messageService.voiceFile(sent[0])), { recursive: true });
  for (const id of sent) fs.writeFileSync(messageService.voiceFile(id), buf);
  // 异步自动转文字（引擎可用时；群发共用同一段语音，转一次写全部）
  setImmediate(async () => {
    try {
      const text = await messageService.transcribeVoice(db, sent[0]);
      if (sent.length > 1) {
        // 群发各条同步转写结果与溯源（模型/耗时）——只转第一条，其余复制
        const src = db.prepare('SELECT voice_model, voice_ms FROM messages WHERE id=?').get(sent[0]);
        const ph = sent.map(() => '?').join(',');
        db.prepare(`UPDATE messages SET voice_state='done', voice_text=?, voice_model=?, voice_ms=? WHERE id IN (${ph}) AND is_voice=1`)
          .run(text, src?.voice_model || '', src?.voice_ms || 0, ...sent);
      }
    } catch (e) {
      const ph = sent.map(() => '?').join(',');
      db.prepare(`UPDATE messages SET voice_state='failed' WHERE id IN (${ph}) AND is_voice=1`).run(...sent);
      console.warn('[messages] 语音自动转写失败 #' + sent[0] + ':', e.message);
    }
  });
  res.json({ ids: sent, count: sent.length, id: sent[0] });
});

// 语音文件本体（<audio> 经 ?token= 鉴权，同监控截图模式；支持 Range 探测——纯 chunked 200 会被 <audio> 判为不可播）
router.get('/messages/voice/:id', (req, res) => {
  const row = db.prepare('SELECT id, from_user, to_user, is_voice FROM messages WHERE id=?').get(Number(req.params.id) || 0);
  if (!row || !row.is_voice) return res.status(404).json({ error: '语音不存在' });
  if (req.user.role !== 'admin' && req.user.id !== row.from_user && req.user.id !== row.to_user) {
    return res.status(403).json({ error: '只有会话双方可播放' });
  }
  const file = messageService.voiceFile(row.id);
  if (!fs.existsSync(file)) return res.status(404).json({ error: '语音文件缺失' });
  const size = fs.statSync(file).size;
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  const range = String(req.headers.range || '');
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m) {
    const start = m[1] ? Math.max(0, Math.min(Number(m[1]), size - 1)) : 0;
    const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (start <= end) {
      res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
  }
  res.setHeader('Content-Length', String(size));
  fs.createReadStream(file).pipe(res);
});

// 手动（重）转文字：消息页语音气泡下的「未转写，点我转文字」
router.post('/messages/voice/:id/transcribe', async (req, res) => {
  const row = db.prepare('SELECT id, from_user, to_user, is_voice FROM messages WHERE id=?').get(Number(req.params.id) || 0);
  if (!row || !row.is_voice) return res.status(404).json({ error: '语音不存在' });
  if (req.user.role !== 'admin' && req.user.id !== row.from_user && req.user.id !== row.to_user) {
    return res.status(403).json({ error: '只有会话双方可转写' });
  }
  try {
    const text = await messageService.transcribeVoice(db, row.id);
    const r2 = db.prepare('SELECT voice_model, voice_ms FROM messages WHERE id=?').get(row.id);
    res.json({ ok: true, voice_text: text, voice_model: r2?.voice_model || '', voice_ms: r2?.voice_ms || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 桌面通知代理（v1.9.24）：右下角弹窗 = 网页弹窗同款；点击 = 已读 + 打开消息页 ----------
// 下载来源优先内嵌服务器地址（内网打开=内网地址，外网打开=外网地址，同监控/剪贴板代理）
function notifyBaseUrl(req) {
  const clean = (u) => String(u || '').replace(/\/+$/, '');
  const org = clean(req.get('origin'));
  if (/^https?:\/\//i.test(org)) return org;
  const ref = clean(String(req.get('referer') || '').replace(/^(https?:\/\/[^/?#]+).*$/i, '$1'));
  if (/^https?:\/\//i.test(ref)) return ref;
  const xfp = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  return `${xfp || req.protocol}://${req.get('host')}`;
}
// 每用户接入密钥（首次下载脚本时生成；key+uid 即凭证，照剪贴板代理模式）
function notifyKeyOf(userId) {
  let u = db.prepare('SELECT id, notify_key FROM users WHERE id=?').get(Number(userId));
  if (!u) return '';
  if (!u.notify_key) {
    const k = crypto.randomBytes(16).toString('hex');
    db.prepare('UPDATE users SET notify_key=? WHERE id=?').run(k, u.id);
    return k;
  }
  return u.notify_key;
}

// PS 5.1 注意（沿用剪贴板代理/监控代理踩坑结论）：中文须 UTF-8 BOM（下载时服务端补）；
// TLS 信任回调用编译型 C#（脚本块形式在 TLS 线程炸）；弹窗点击用 Register-ObjectEvent
// （-Action 在事件子系统跑，MessageData 传同步哈希表实现「当前展示消息」的跨事件读写）。
const NOTIFY_PS = [
  '# 全能工作台·桌面消息通知代理（由「短消息」页生成，按下载来源内嵌服务器地址）',
  '# 双击安装脚本后常驻：有新短消息时从屏幕右下角弹窗（内容与网页右下角弹窗一致）；',
  '# 点击弹窗任意位置 = 标记已读并打开浏览器进入消息页。语音消息按设置自动播放声音。',
  '# 安装位置：%LOCALAPPDATA%\\WorkbenchNotify；当前用户开机自启，无需管理员权限。',
  '# 卸载：短消息页下载卸载脚本双击，或 powershell -ExecutionPolicy Bypass -File 本文件 -Remove',
  'param([switch]$Remove)',
  "$Server = '__SERVER__'",
  "$Key    = '__KEY__'",
  "$Uid    = __UID__",
  "$RunName = 'WorkbenchNotify'",
  "$Dir = Join-Path $env:LOCALAPPDATA 'WorkbenchNotify'",
  "$LogFile = Join-Path $Dir 'agent.log'",
  "$StateFile = Join-Path $Dir 'state.txt'",
  "function Log([string]$m) { try { if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 256KB)) { Remove-Item $LogFile -Force -ErrorAction SilentlyContinue }; Add-Content -Path $LogFile -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m) -Encoding UTF8 -ErrorAction SilentlyContinue } catch {} }",
  '',
  'if ($Remove) {',
  "  Log 'uninstall'",
  "  Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name $RunName -ErrorAction SilentlyContinue",
  "  Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like ('*' + $Dir + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  '  Remove-Item $Dir -Recurse -Force -ErrorAction SilentlyContinue',
  "  Write-Host '已卸载桌面消息通知代理'",
  '  exit',
  '}',
  '',
  '# --- 安装分支：不从安装目录运行时，先落位再转常驻 ---',
  'if ($PSCommandPath -and (-not $PSCommandPath.StartsWith($Dir))) {',
  '  New-Item -ItemType Directory -Force -Path $Dir | Out-Null',
  "  Log ('installing from ' + $PSCommandPath)",
  "  Copy-Item $PSCommandPath (Join-Path $Dir 'notify.ps1') -Force",
  "  $cmd = 'powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"' + (Join-Path $Dir 'notify.ps1') + '\"'",
  "  New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name $RunName -Value $cmd -PropertyType String -Force | Out-Null",
  "  Write-Host ('安装完成（' + $Dir + '）：新短消息将在屏幕右下角弹窗，已设为开机自启')",
  "  Start-Process -FilePath 'powershell.exe' -ArgumentList ('-STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"' + (Join-Path $Dir 'notify.ps1') + '\"')",
  '  exit',
  '}',
  '',
  '# --- 常驻分支：轮询新消息 → 右下角弹窗；点击 = 已读 + 打开消息页 ---',
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
  '# 工作台可能是内网自签名 HTTPS（按下载来源内嵌）：编译型 C# 回调放行证书（脚本块形式会在 TLS 线程炸）',
  "if (-not ('NotifyTlsTrust' -as [type])) {",
  "  Add-Type -TypeDefinition 'using System.Net; using System.Security.Cryptography.X509Certificates; public class NotifyTlsTrust : ICertificatePolicy { public bool CheckValidationResult(ServicePoint sp, X509Certificate cert, WebRequest req, int problem) { return true; } }'",
  '}',
  '[System.Net.ServicePointManager]::CertificatePolicy = New-Object NotifyTlsTrust',
  '# 本机代理会掐断内网请求，强制直连',
  '[System.Net.WebRequest]::DefaultWebProxy = $null',
  '# 单实例互斥',
  "$mtx = New-Object System.Threading.Mutex($false, 'Global\\WorkbenchNotify')",
  'if (-not $mtx.WaitOne(0)) { exit }',
  '',
  '$last = 0',
  'try { if (Test-Path $StateFile) { $last = [int](Get-Content $StateFile -Raw) } } catch {}',
  "# 同步哈希表：弹窗点击事件（-Action 子作用域）与主循环共享'当前展示的消息/退出标志/播放器引用'",
  "$state = @{ cur = $null; player = $null; srv = $Server; key = $Key; uid = [int]$Uid; exit = $false }",
  '',
  '$notify = New-Object System.Windows.Forms.NotifyIcon',
  '$notify.Icon = [System.Drawing.SystemIcons]::Information',
  "$notify.Text = '全能工作台·消息通知'",
  '$notify.Visible = $true',
  '$menu = New-Object System.Windows.Forms.ContextMenu',
  "$miExit = New-Object System.Windows.Forms.MenuItem('退出')",
  '[void]$menu.MenuItems.Add($miExit)',
  '$notify.ContextMenu = $menu',
  '',
  '# 托盘图标右键「退出」',
  "Register-ObjectEvent -InputObject $miExit -EventName Click -SourceIdentifier WbNotifyExit -MessageData $state -Action { $Event.MessageData['exit'] = $true } | Out-Null",
  '# 点击弹窗任意位置 = 已读 + 打开消息页',
  'Register-ObjectEvent -InputObject $notify -EventName BalloonTipClicked -SourceIdentifier WbNotifyClick -MessageData $state -Action {',
  '  $s = $Event.MessageData',
  "  $m = $s['cur']",
  '  if ($m) {',
  "    $s['cur'] = $null",
  '    try {',
  "      $body = @{ key = $s['key']; uid = $s['uid']; id = [int]$m.id } | ConvertTo-Json",
  "      Invoke-RestMethod -Method Post -Uri ($s['srv'] + '/api/messages/agent/read') -ContentType 'application/json; charset=utf-8' -Body $body | Out-Null",
  '    } catch {}',
  "    try { Start-Process ($s['srv'] + '/#/messages') } catch {}",
  '  }',
  '} | Out-Null',
  '',
  "Log ('notify agent started -> ' + $Server + ' (uid ' + $Uid + ', last ' + $last + ')')",
  '',
  'function Play-Voice($m) {',
  '  try {',
  '    if (-not $m.voice_b64) { return }',
  "    $wav = Join-Path $env:TEMP ('wb-voice-' + $m.id + '.wav')",
  '    [IO.File]::WriteAllBytes($wav, [Convert]::FromBase64String($m.voice_b64))',
  '    $p = New-Object System.Media.SoundPlayer($wav)',
  "    $state['player'] = $p",
  '    $p.Play()',
  "  } catch { Log ('voice play failed: ' + $_.Exception.Message) }",
  '}',
  '',
  'while (-not $state[\'exit\']) {',
  '  try {',
  "    $r = Invoke-RestMethod -Uri ($Server + '/api/messages/agent/poll?uid=' + $Uid + '&key=' + $Key + '&after=' + $last)",
  '    if ($r.ok) {',
  '      foreach ($m in @($r.messages)) {',
  '        if ([int]$m.id -gt $last) { $last = [int]$m.id; try { Set-Content -Path $StateFile -Value $last -Encoding ASCII } catch {} }',
  "        $title = '[' + $m.module_label + '] ' + [string]$m.subject",
  "        if (-not $m.subject) { $title = '[' + $m.module_label + '] 新消息' }",
  '        if ($title.Length -gt 60) { $title = $title.Substring(0, 60) }',
  "        $body = [string]$m.from_name + ' · ' + [string]$m.created_at",
  '        if ($m.is_voice) {',
  '          $vtxt = \'\'',
  '          if ($m.voice_text) { $vtxt = ([string]$m.voice_text).Trim() }',
  "          $body = $body + [Environment]::NewLine + '[语音 ' + [Math]::Ceiling([double]$m.voice_secs) + ' 秒] ' + $vtxt",
  '        } else {',
  "          $body = $body + [Environment]::NewLine + ([string]$m.content).Trim()",
  '        }',
  "        if ($body.Length -gt 230) { $body = $body.Substring(0, 230) + '...' }",
  '        if ($r.autoplay -and $m.is_voice) { Play-Voice $m }',
  "        $state['cur'] = $m",
  '        $notify.BalloonTipTitle = $title',
  '        $notify.BalloonTipText = $body',
  '        $notify.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info',
  '        $notify.ShowBalloonTip(15000)',
  "        Log ('popup #' + $m.id + ' from ' + $m.from_name)",
  '        $deadline = (Get-Date).AddSeconds(15)',
  "        while ((Get-Date) -lt $deadline -and $null -ne $state['cur'] -and -not $state['exit']) { Start-Sleep -Milliseconds 250 }",
  "        $state['cur'] = $null",
  '      }',
  '    }',
  "  } catch { Log ('poll failed: ' + $_.Exception.Message) }",
  '  $end = (Get-Date).AddSeconds(20)',
  "  while ((Get-Date) -lt $end -and -not $state['exit']) { Start-Sleep -Milliseconds 500 }",
  '}',
  '',
  "Log 'notify agent exit'",
  'try { $notify.Visible = $false; $notify.Dispose() } catch {}',
].join('\n');

// 安装脚本 = 自解压 .cmd（ASCII 头 + base64 载荷，双击即装；cmd 内嵌中文经传参必乱码，故载荷走 base64）
function notifyInstallCmd(ps1) {
  const b64 = Buffer.from('﻿' + ps1, 'utf8').toString('base64'); // PS 5.1 无 BOM 按 ANSI 解析中文
  return [
    '@echo off',
    'setlocal',
    'set "WORK=%TEMP%\\wb-notify-setup"',
    'if exist "%WORK%" rmdir /s /q "%WORK%"',
    'mkdir "%WORK%"',
    "powershell -NoProfile -ExecutionPolicy Bypass -Command \"$l = Get-Content -LiteralPath '%~f0'; $i = [Array]::IndexOf($l, ('::WB-' + 'PAYLOAD::')); if ($i -lt 0 -or $i -ge $l.Count - 1) { Write-Host 'payload missing'; exit 1 }; [IO.File]::WriteAllBytes($env:WORK + '\\notify-setup.ps1', [Convert]::FromBase64String(($l[($i + 1)..($l.Count - 1)] -join '')))\"",
    'if errorlevel 1 goto :err',
    'powershell -STA -NoProfile -ExecutionPolicy Bypass -File "%WORK%\\notify-setup.ps1"',
    'echo.',
    'pause',
    'exit /b',
    ':err',
    'echo Install failed.',
    'pause',
  ].join('\r\n') + '\r\n::WB-PAYLOAD::\r\n' + b64 + '\r\n';
}
// 卸载自包含（不依赖当初的 ps1；$PID 排除自身——卸载命令行里含目录名会自匹配）
const NOTIFY_UNINSTALL_CMD = [
  '@echo off',
  "powershell -NoProfile -ExecutionPolicy Bypass -Command \"& { $dir = Join-Path $env:LOCALAPPDATA 'WorkbenchNotify'; Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'WorkbenchNotify' -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like ('*' + $dir + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep 1; Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue; if (Test-Path $dir) { Write-Host 'Some files are locked, please reboot and run again' } else { Write-Host 'Workbench notify agent uninstalled' } }\"",
  'pause',
].join('\r\n');

// 脚本三件套下发（登录即可——每个成员给自己的电脑装；ps1 内嵌下载来源地址 + 每用户密钥 + uid）
router.get('/messages/agent/script', (req, res) => {
  const t = String(req.query.type || '');
  if (t === 'install') {
    const ps = NOTIFY_PS.replace(/__SERVER__/g, notifyBaseUrl(req)).replace(/__KEY__/g, notifyKeyOf(req.user.id)).replace(/__UID__/g, String(req.user.id));
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="notify-setup.cmd"');
    return res.end(notifyInstallCmd(ps));
  }
  if (t === 'uninstall') {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="notify-uninstall.cmd"');
    return res.end(NOTIFY_UNINSTALL_CMD);
  }
  if (t === 'ps1') {
    const ps = NOTIFY_PS.replace(/__SERVER__/g, notifyBaseUrl(req)).replace(/__KEY__/g, notifyKeyOf(req.user.id)).replace(/__UID__/g, String(req.user.id));
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="notify.ps1"');
    return res.end('﻿' + ps); // UTF-8 BOM
  }
  res.status(400).json({ error: '未知类型' });
});

// 自动播放偏好（语音消息弹窗时直接播声音；服务端存每用户设置，代理轮询时带回）
router.get('/messages/agent/prefs', (req, res) => {
  const u = db.prepare('SELECT notify_autoplay FROM users WHERE id=?').get(req.user.id);
  res.json({ autoplay: !u || u.notify_autoplay !== 0 });
});
router.put('/messages/agent/prefs', (req, res) => {
  const off = req.body && (req.body.autoplay === 0 || req.body.autoplay === false);
  db.prepare('UPDATE users SET notify_autoplay=? WHERE id=?').run(off ? 0 : 1, req.user.id);
  res.json({ ok: true, autoplay: !off });
});

// ---------- 页面列表排序（全局：管理员统一设置，全员共用同一套侧边栏顺序） ----------
router.get('/nav-order', (req, res) => {
  const o = getSetting(db, 'page_order', []);
  const labels = getSetting(db, 'page_labels', {});
  res.json({ order: Array.isArray(o) ? o : [], labels: labels && typeof labels === 'object' ? labels : {} });
});
router.put('/nav-order', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '页面排序由管理员统一设置' });
  const body = req.body || {};
  const order = Array.isArray(body.order) ? body.order.map((k) => String(k)).filter(Boolean).slice(0, 100) : [];
  setSetting(db, 'page_order', order);
  res.json({ order });
});

// ---------- 页面菜单中文名改名（全局：管理员统一设置，全员共用；值为空 = 恢复默认，不入库） ----------
router.put('/nav-labels', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '菜单改名由管理员统一设置' });
  const body = req.body || {};
  const src = body.labels && typeof body.labels === 'object' ? body.labels : {};
  const labels = {};
  for (const [k, v] of Object.entries(src)) {
    const name = String(v == null ? '' : v).trim();
    if (name) labels[String(k)] = name.slice(0, 20);
  }
  setSetting(db, 'page_labels', labels);
  res.json({ labels });
});

// ---------- 家庭人员档案（随 family 共享开关选库） ----------
router.get('/family-profiles', (req, res) => {
  const rows = routedDb(req.tdb, 'family').prepare('SELECT * FROM family_profiles ORDER BY id').all();
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  for (const r of rows) {
    // 星座由公历生日按月日计算；生肖按农历年（春节分界）计算
    r.zodiac = lunarService.zodiacOf(r.solar_birthday);
    r.animal = lunarService.animalOf(r.solar_birthday);
    // 年龄：公历周岁（今年-出生年，生日未过减1）；虚岁 = 周岁 + 1（出生即1岁）
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(r.solar_birthday || '').trim());
    if (m) {
      const by = Number(m[1]);
      const passed = todayStr.slice(5) >= `${m[2]}-${m[3]}`; // 今年生日是否已过
      r.age_solar = now.getFullYear() - by - (passed ? 0 : 1);
      r.age_nominal = r.age_solar + 1;
    } else {
      r.age_solar = null;
      r.age_nominal = null;
    }
  }
  res.json(rows);
});
router.post('/family-profiles', (req, res) => {
  const { name, relation, solar_birthday, lunar_birthday, remark } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '姓名不能为空' });
  // 农历生日缺省时由公历生日换算（公历生日只是登记/换算依据）
  let lunar = (lunar_birthday || '').trim();
  if (!lunar && solar_birthday && /^\d{4}-\d{2}-\d{2}$/.test(solar_birthday)) {
    lunar = lunarService.solar2lunar(solar_birthday).key;
  }
  const r = routedDb(req.tdb, 'family').prepare('INSERT INTO family_profiles(name,relation,solar_birthday,lunar_birthday,remark) VALUES(?,?,?,?,?)')
    .run(String(name).trim(), (relation || '').trim(), (solar_birthday || '').trim(), lunar, (remark || '').trim());
  res.json({ id: Number(r.lastInsertRowid), lunar_birthday: lunar });
});
router.put('/family-profiles/:id', (req, res) => {
  const cur = routedDb(req.tdb, 'family').prepare('SELECT * FROM family_profiles WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '档案不存在' });
  const { name, relation, solar_birthday, lunar_birthday, remark } = req.body || {};
  // 只填公历生日时自动补农历
  let lunar = lunar_birthday !== undefined ? lunar_birthday : cur.lunar_birthday;
  if (solar_birthday && /^\d{4}-\d{2}-\d{2}$/.test(solar_birthday) && (!lunar || lunar === '')) {
    const lu = lunarService.solar2lunar(solar_birthday);
    lunar = lu.key;
  }
  routedDb(req.tdb, 'family').prepare('UPDATE family_profiles SET name=?, relation=?, solar_birthday=?, lunar_birthday=?, remark=? WHERE id=?')
    .run(
      name !== undefined ? String(name).trim() : cur.name,
      relation !== undefined ? relation : cur.relation,
      solar_birthday !== undefined ? solar_birthday : cur.solar_birthday,
      lunar, remark !== undefined ? remark : cur.remark,
      req.params.id
    );
  res.json({ ok: true });
});
router.delete('/family-profiles/:id', (req, res) => {
  routedDb(req.tdb, 'family').prepare('DELETE FROM family_profiles WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
// 日历周起始日配置（归租户）
router.get('/calendar/config', (req, res) => {
  const v = getSetting(req.tdb, 'calendar', { weekStart: 'monday' });
  res.json(v);
});
router.post('/calendar/config', (req, res) => {
  const b = req.body || {};
  setSetting(req.tdb, 'calendar', { weekStart: b.weekStart === 'sunday' ? 'sunday' : 'monday' });
  res.json({ ok: true });
});

// ---------- 文件存档（归租户） ----------

router.get('/files', (req, res) => {
  const q = (req.query.q || '').trim();
  // 列表直接带 text_content（截断到 5000 字）供前端预览展示；文件名乱码读取时自愈
  const SQL = "SELECT id, filename, file_type, file_size, ai_parsed, parse_engine, created_at, substr(text_content, 1, 5000) AS text_content FROM files";
  const rows = q
    ? req.tdb.prepare(`${SQL} WHERE filename LIKE ? OR text_content LIKE ? ORDER BY id DESC LIMIT 200`).all(`%${q}%`, `%${q}%`)
    : req.tdb.prepare(`${SQL} ORDER BY id DESC LIMIT 200`).all();
  res.json({ files: rows.map((r) => ({ ...r, filename: fixMojibakeName(r.filename) })) });
});

router.post('/files/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    const { mimetype, size, buffer } = req.file;
    const originalname = fixMojibakeName(req.file.originalname);
    const useAI = req.body.ai === 'true' || req.body.ai === true;

    // 设置里配置了目录 → 文件落盘、库里只留元数据（storage_path）；留空 → 回落全局默认上传路径 {root}/files；
    // 都没配 → 内容 base64 存库（旧行为）。文件名加 t<uid>_ 时间戳前缀防撞名；落盘失败静默回退存库，不影响上传
    const filesDir = String((getSetting(req.tdb, 'files_storage', null) || {}).dir || '').trim() || storagePaths.uploadSubDir('files') || '';
    let storagePath = '';
    if (filesDir) {
      try {
        fs.mkdirSync(filesDir, { recursive: true });
        const safe = originalname.replace(/[\\/:*?"<>|\r\n]+/g, '_').slice(-80) || 'file';
        storagePath = path.join(filesDir, `t${req.user.id}_${Date.now()}_${safe}`);
        fs.writeFileSync(storagePath, buffer);
      } catch (e) { storagePath = ''; }
    }

    // 第一层：内置文字提取（PDF/Word/Excel/文本类，零依赖）
    let rawText = '';
    let engine = '';
    try {
      const r = fileTextService.extractText(originalname, mimetype, buffer);
      rawText = r.text;
      engine = r.engine;
    } catch (e) { engine = 'error'; }

    // 第二层：勾选 AI 时，把提取文字交给 AI 精炼（或对纯文本直接精炼）
    let textContent = rawText;
    let aiParsed = 0;
    if (useAI && aiService.hasConfig(req.tdb) && rawText) {
      try {
        textContent = await aiService.summarize(rawText.slice(0, 6000), '请提取并整理以下文件的核心内容，保留关键信息（数字、日期、人名、条款、结论等），输出结构化中文摘要', req.tdb);
        aiParsed = 1;
      } catch (e) {
        textContent = rawText; // AI 失败时保留内置提取结果
      }
    }
    const r = req.tdb.prepare('INSERT INTO files(filename, file_type, file_size, content, text_content, ai_parsed, parse_engine, storage_path) VALUES(?,?,?,?,?,?,?,?)')
      .run(originalname, mimetype || '', size, storagePath ? '' : buffer.toString('base64'), textContent, aiParsed, engine, storagePath);
    res.json({ id: Number(r.lastInsertRowid), ai_parsed: aiParsed, engine, text_len: textContent.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/files/:id', (req, res) => {
  const f = req.tdb.prepare('SELECT id, filename, file_type, file_size, text_content, ai_parsed, parse_engine, created_at FROM files WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).json({ error: '文件不存在' });
  f.filename = fixMojibakeName(f.filename);
  res.json(f);
});

// 读取文件字节：优先磁盘（storage_path 有值且文件在），否则回退库内 base64（老数据 / 落盘文件丢失）
function fileBuffer(f) {
  if (f.storage_path && fs.existsSync(f.storage_path)) return fs.readFileSync(f.storage_path);
  return Buffer.from(f.content || '', 'base64');
}

router.get('/files/:id/download', (req, res) => {
  const f = req.tdb.prepare('SELECT * FROM files WHERE id=?').get(req.params.id);
  if (!f) return res.status(404).json({ error: '文件不存在' });
  const buf = fileBuffer(f);
  const name = fixMojibakeName(f.filename);
  // RFC 5987：filename* 支持 UTF-8 中文，filename 兜底 ASCII
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Content-Type', f.file_type || 'application/octet-stream');
  res.send(buf);
});

router.delete('/files/:id', (req, res) => {
  // 落盘文件随记录一起删（文件丢失不阻塞删行）
  const f = req.tdb.prepare('SELECT storage_path FROM files WHERE id=?').get(req.params.id);
  if (f && f.storage_path) { try { fs.unlinkSync(f.storage_path); } catch {} }
  req.tdb.prepare('DELETE FROM files WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// 文件重新解析：mode='builtin'（内置提取）| 'ai'（AI 识别）
// AI 识别两条路：有文字可提取的（乱码/散乱）→ 文字交 LLM 整理；无文字的 PDF → Chromium 渲染截图 + 视觉识别
router.post('/files/:id/reparse', async (req, res) => {
  try {
    const f = req.tdb.prepare('SELECT * FROM files WHERE id=?').get(req.params.id);
    if (!f) return res.status(404).json({ error: '文件不存在' });
    const mode = (req.body && req.body.mode) || 'ai';
    const buf = fileBuffer(f);

    if (mode === 'builtin') {
      const r = fileTextService.extractText(fixMojibakeName(f.filename), f.file_type, buf);
      req.tdb.prepare('UPDATE files SET text_content=?, parse_engine=? WHERE id=?').run(r.text, r.engine, f.id);
      return res.json({ ok: true, engine: r.engine, chars: r.text.length });
    }

    // mode = 'ai'
    if (!aiService.hasConfig(req.tdb)) return res.status(400).json({ error: 'AI 尚未配置，请先到「设置 → AI 配置」填写' });
    const isPdf = /\.pdf$/i.test(f.filename) || f.file_type === 'application/pdf';
    let text = '';
    let engine = '';
    // 先内置提取一次：有文字（哪怕乱序）→ 交给 LLM 整理，比视觉识别快且省
    const builtin = fileTextService.extractText(fixMojibakeName(f.filename), f.file_type, buf);
    if (builtin.text && builtin.text.trim().length >= 20) {
      text = await aiService.summarize(builtin.text.slice(0, 6000),
        '请把以下从文件中提取的文字整理成通顺可读的正文（修正乱序与乱码字符，保留全部实质内容、数字、日期、标题层级），直接输出整理后的正文。', req.tdb);
      engine = 'ai-text';
    } else if (isPdf) {
      // 无文字层（扫描/图片型 PDF）→ Chromium 渲染 + 视觉识别
      const pdfOcr = require('../services/pdfOcrService');
      const r = await pdfOcr.ocrPdf(buf, { maxPages: 4, tdb: req.tdb });
      text = r.text;
      engine = `ai-vision(${r.pages}页)`;
    } else {
      return res.status(400).json({ error: '该文件既无文字层也不是 PDF，暂不支持 AI 识别' });
    }
    if (!text || !text.trim()) return res.status(500).json({ error: 'AI 识别结果为空，请重试' });
    req.tdb.prepare('UPDATE files SET text_content=?, parse_engine=?, ai_parsed=1 WHERE id=?').run(text, engine, f.id);
    res.json({ ok: true, engine, chars: text.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 每日默认待办模板（归租户） ----------
router.get('/todos/default', (req, res) => {
  res.json({ items: getSetting(req.tdb, 'default_todos', []) });
});
router.post('/todos/default', (req, res) => {
  const list = (req.body.items || []).filter((t) => t && t.title && t.title.trim());
  setSetting(req.tdb, 'default_todos', list.map((t) => ({ title: String(t.title).trim(), priority: t.priority || 2 })));
  res.json({ ok: true, count: list.length });
});

// ---------- 看板布局（模块顺序持久化，归租户：每人首页自己排） ----------
const DASHBOARD_DEFAULT_LAYOUT = ['clock', 'weather', 'commute', 'links', 'todos', 'events', 'news', 'hot', 'kids', 'holiday'];
// 看板模块注册表（全局增减/个人显隐的配置界面用；key 与前端卡片 v-if 分支一一对应）
const DASHBOARD_CARDS = [
  { key: 'clock', label: '电子时钟' },
  { key: 'weather', label: '天气' },
  { key: 'commute', label: '通勤预计' },
  { key: 'links', label: '快捷启动' },
  { key: 'todos', label: '今日待办' },
  { key: 'events', label: '今日日程' },
  { key: 'news', label: '科技新闻' },
  { key: 'hot', label: '百度热搜' },
  { key: 'kids', label: '子女学习' },
  { key: 'holiday', label: '节日日历' },
];
const DASHBOARD_KEYS = DASHBOARD_CARDS.map((c) => c.key);

// GET /dashboard/layout：
//  keys  = 实际渲染顺序（已过滤全局禁用 + 本人隐藏）
//  all   = 未过滤的完整顺序（前端拖拽保存时把隐藏模块合并回完整顺序，恢复显示不丢位置）
//  hidden= 本人隐藏的模块（看板底部配置卡回显）
router.get('/dashboard/layout', (req, res) => {
  const saved = getSetting(req.tdb, 'dashboard_layout', null);
  let keys = Array.isArray(saved) && saved.length ? saved : [...DASHBOARD_DEFAULT_LAYOUT];
  // 新增模块自动补入（如新增 clock），保证旧布局也能看到新模块
  for (const k of DASHBOARD_DEFAULT_LAYOUT) {
    if (!keys.includes(k)) keys = [k, ...keys];
  }
  // 全局增减（主库 dashboard_modules=禁用清单）+ 个人显隐（租户 dashboard_hidden）
  const gDisabled = new Set(getSetting('dashboard_modules', []) || []);
  const uHidden = new Set(getSetting(req.tdb, 'dashboard_hidden', []) || []);
  res.json({
    keys: keys.filter((k) => !gDisabled.has(k) && !uHidden.has(k)),
    all: keys,
    hidden: [...uHidden],
  });
});
router.post('/dashboard/layout', (req, res) => {
  const keys = (req.body.keys || []).filter((k) => DASHBOARD_KEYS.includes(k));
  setSetting(req.tdb, 'dashboard_layout', keys.length ? keys : DASHBOARD_DEFAULT_LAYOUT);
  res.json({ ok: true });
});
// 个人显隐（归租户，只影响自己）
router.post('/dashboard/hidden', (req, res) => {
  const hidden = [...new Set((req.body.hidden || []).filter((k) => DASHBOARD_KEYS.includes(k)))];
  setSetting(req.tdb, 'dashboard_hidden', hidden);
  res.json({ ok: true, hidden });
});
// 看板模块清单 + 全局禁用清单（登录即可读：看板底部个人配置卡也用它；写仅管理员）
router.get('/dashboard/modules', (req, res) => {
  res.json({ cards: DASHBOARD_CARDS, disabled: getSetting('dashboard_modules', []) || [] });
});
router.put('/dashboard/modules', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '看板模块由管理员统一配置' });
  const disabled = [...new Set((req.body.disabled || []).filter((k) => DASHBOARD_KEYS.includes(k)))];
  if (disabled.length >= DASHBOARD_KEYS.length) {
    return res.status(400).json({ error: '至少保留一个看板模块' });
  }
  setSetting('dashboard_modules', disabled);
  res.json({ ok: true, disabled });
});

module.exports = router;
