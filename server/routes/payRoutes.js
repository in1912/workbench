// 个人账务路由：账单导入/流水/科目/预算/看板统计/AI 分类（账务数据归各租户库）
const express = require('express');
const { getSetting, setSetting } = require('../db');
const payService = require('../services/payService');
const aiService = require('../services/aiService');
const storagePaths = require('../services/storagePaths');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } });

const router = express.Router();
router.use(express.json());

// ---------- 账单导入 ----------
// 支付宝 CSV（GB18030；表头 4 行附加信息；----- 起尾部丢弃；交易号去重）
router.post('/pay/import', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '未收到文件' });
    // 全局默认上传路径已配置 → 导入的账单原件留档一份（尽力而为，不影响导入）
    storagePaths.bestEffortSave('imports', req.file.originalname || 'bill.csv', req.file.buffer, `t${req.user.id}_`);
    const rows = payService.parseAlipayCsv(req.file.buffer);
    if (!rows.length) return res.status(400).json({ error: '未解析到有效数据行（检查格式：支付宝交易记录明细 CSV）' });
    const r = payService.importRows(req.tdb, rows, { sourceFile: req.file.originalname });
    res.json({ ok: true, parsed: rows.length, ...r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// 训练导入：xlsx（手动归类账单 sheet2 明细含类型列）→ 学习科目特征
// 前端把解析好的 [{type, counterparty, goods}] 发来（xlsx 解析复用 fileTextService 的 unzip）
router.post('/pay/train', (req, res) => {
  try {
    const rows = req.body.rows || [];
    if (!rows.length) return res.status(400).json({ error: '无训练数据' });
    const r = payService.learnFromLabeled(req.tdb, rows);
    res.json({ ok: true, ...r });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- 消费类型识别 ----------
// AI 批量补分类（未分类的支出）：把 (对方,商品) 组合分组给 AI，返回 科目名
router.post('/pay/classify-ai', async (req, res) => {
  try {
    if (!aiService.hasConfig(req.tdb)) return res.status(400).json({ error: 'AI 尚未配置（设置 → AI 配置）' });
    const pending = payService.pendingUnclassified(req.tdb, Number(req.body && req.body.limit) || 150);
    if (!pending.length) return res.json({ ok: true, classified: 0 });
    // 压缩：同 (对方+商品前12字) 只问一次
    const groups = new Map();
    for (const p of pending) {
      const key = `${p.counterparty}|${String(p.goods || '').slice(0, 12)}`;
      if (!groups.has(key)) groups.set(key, { key, ids: [], counterparty: p.counterparty, goods: p.goods });
      groups.get(key).ids.push(p.id);
    }
    const cats = req.tdb.prepare('SELECT name FROM pay_categories').all().map((c) => c.name);
    const list = [...groups.values()].slice(0, 120);
    const lines = list.map((g, i) => `${i}. 对方[${g.counterparty}] 商品[${String(g.goods || '').slice(0, 30)}]`);
    const prompt = `任务：给支付宝流水分类。
可用科目：${cats.join('、')}。都不贴切时可新建不超过4字中文科目。
示例输入：
0. 对方[春晓(王小萍)] 商品[亲情卡]
1. 对方[中国石化] 商品[加油]
示例输出（只输出这种 JSON，无其他任何字符）：
[{"i":0,"c":"买菜"},{"i":1,"c":"车"}]
现在分类以下 ${list.length} 条：
${lines.join('\n')}`;
    let parsed = [];
    let out = '';
    for (let attempt = 0; attempt < 2 && !parsed.length; attempt++) {
      out = await aiService.chat([
        { role: 'system', content: '你是分类引擎。只输出 JSON 数组，第一个字符必须是 [，最后一个字符必须是 ]。不要解释、不要思考过程。' },
        { role: 'user', content: prompt },
      ], { maxTokens: 4000, temperature: 0.1, tdb: req.tdb });
      // 提取第一个 [ 到最后一个 ] 之间内容再解析；失败退回逐对象提取
      const start = out.indexOf('['), end = out.lastIndexOf(']');
      if (start >= 0 && end > start) {
        try {
          const arr = JSON.parse(out.slice(start, end + 1).replace(/，/g, ',').replace(/：/g, ':'));
          if (Array.isArray(arr)) parsed = arr.filter((x) => x && x.i !== undefined && x.c);
        } catch { /* 继续逐对象提取 */ }
      }
      if (!parsed.length) {
        for (const m of out.matchAll(/\{\s*["'“”]i["'”"]\s*[:：]\s*(\d+)\s*,\s*["'“”]c["'”"]\s*[:：]\s*["'“”]([^"'””}]{1,12})["'””]\s*\}/g)) {
          parsed.push({ i: Number(m[1]), c: m[2].trim() });
        }
      }
    }
    if (!parsed.length) throw new Error('AI 返回无法解析：' + out.slice(0, 120));
    let classified = 0;
    const upd = req.tdb.prepare("UPDATE pay_bills SET category=?, category_src='ai' WHERE id=?");
    for (const item of parsed) {
      const g = list[Number(item.i)];
      if (!g || !item.c) continue;
      for (const id of g.ids) { upd.run(String(item.c).slice(0, 12), id); classified++; }
    }
    res.json({ ok: true, classified, groups: list.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 手动改单条流水科目
router.put('/pay/bills/:id/category', (req, res) => {
  const { category } = req.body || {};
  if (!category) return res.status(400).json({ error: '科目不能为空' });
  req.tdb.prepare("UPDATE pay_bills SET category=?, category_src='manual' WHERE id=?").run(String(category).slice(0, 20), req.params.id);
  res.json({ ok: true });
});

// ---------- 流水查询 ----------
router.get('/pay/bills', (req, res) => {
  const { q, category, month, inout, page = 1, pageSize = 50 } = req.query;
  const conds = [];
  const params = [];
  if (q) { conds.push('(counterparty LIKE ? OR goods LIKE ? OR trade_no LIKE ?)'); const like = `%${q}%`; params.push(like, like, like); }
  if (category) { conds.push('category=?'); params.push(category); }
  if (month) { conds.push("substr(create_time,1,7)=?"); params.push(month); }
  if (inout) { conds.push('inout=?'); params.push(inout); }
  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
  const total = req.tdb.prepare(`SELECT COUNT(*) c FROM pay_bills ${where}`).get(...params).c;
  const rows = req.tdb.prepare(`SELECT * FROM pay_bills ${where} ORDER BY create_time DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, Number(pageSize), (Number(page) - 1) * Number(pageSize));
  res.json({ total, page: Number(page), pageSize: Number(pageSize), bills: rows });
});
// 手动补流水（并入主流水；只需金额+科目，商品名选填）
router.post('/pay/bills', (req, res) => {
  const { amount, category, goods, date } = req.body || {};
  const amt = Number(amount);
  if (!amt || amt <= 0) return res.status(400).json({ error: '金额需大于 0' });
  if (!category) return res.status(400).json({ error: '科目不能为空' });
  const d = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : new Date().toISOString().slice(0, 10);
  const r = req.tdb.prepare(`INSERT INTO pay_bills(trade_no,create_time,goods,amount,inout,status,category,category_src,is_expense)
    VALUES(?,?,?,?,?,?,?,?,1)`)
    .run(`MAN-${Date.now()}-${Math.floor(Math.random() * 1000)}`, `${d} 00:00:00`, (goods || '').trim(), amt, '支出', '手动', String(category).slice(0, 20), 'manual');
  res.json({ id: Number(r.lastInsertRowid) });
});
router.delete('/pay/bills/:id', (req, res) => {
  req.tdb.prepare('DELETE FROM pay_bills WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- 科目设置 ----------
router.get('/pay/categories', (req, res) => {
  const cats = req.tdb.prepare('SELECT * FROM pay_categories ORDER BY id').all();
  // 每科目近12个月累计（参考）
  for (const c of cats) {
    c.total_12m = req.tdb.prepare("SELECT COALESCE(SUM(amount),0) t FROM pay_bills WHERE is_expense=1 AND category=? AND create_time >= datetime('now','localtime','-365 day')").get(c.name).t;
  }
  res.json(cats);
});
router.post('/pay/categories', (req, res) => {
  const { name, keywords } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: '科目名不能为空' });
  const r = req.tdb.prepare('INSERT OR IGNORE INTO pay_categories(name,keywords) VALUES(?,?)')
    .run(String(name).trim().slice(0, 20), (keywords || '').trim());
  if (!r.changes) return res.status(400).json({ error: '科目已存在' });
  res.json({ id: Number(r.lastInsertRowid) });
});
router.put('/pay/categories/:id', (req, res) => {
  const cur = req.tdb.prepare('SELECT * FROM pay_categories WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '科目不存在' });
  const { name, keywords, is_fixed, fixed_amount, note } = req.body || {};
  req.tdb.prepare('UPDATE pay_categories SET name=?, keywords=?, is_fixed=?, fixed_amount=?, note=? WHERE id=?')
    .run(
      name !== undefined ? String(name).trim().slice(0, 20) : cur.name,
      keywords !== undefined ? keywords : cur.keywords,
      is_fixed !== undefined ? (is_fixed ? 1 : 0) : cur.is_fixed,
      fixed_amount !== undefined ? Number(fixed_amount) || 0 : cur.fixed_amount,
      note !== undefined ? note : cur.note,
      req.params.id
    );
  res.json({ ok: true });
});
router.delete('/pay/categories/:id', (req, res) => {
  req.tdb.prepare('DELETE FROM pay_categories WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// 每月固定支出：立即注入指定月份
router.post('/pay/fixed/inject', (req, res) => {
  const { year, month } = req.body || {};
  const y = Number(year) || new Date().getFullYear();
  const m = Number(month) || new Date().getMonth() + 1;
  const added = payService.injectFixed(req.tdb, y, m);
  res.json({ ok: true, added });
});

// 核算月周期设置（每月几日 ~ 次月几日）
router.get('/pay/cycle', (req, res) => {
  res.json(getSetting(req.tdb, 'pay_cycle', { start_day: 1 }));
});
router.post('/pay/cycle', (req, res) => {
  const d = Math.min(28, Math.max(1, Number(req.body && req.body.start_day) || 1));
  setSetting(req.tdb, 'pay_cycle', { start_day: d });
  res.json({ ok: true, start_day: d });
});

// ---------- 看板统计 ----------
router.get('/pay/dashboard', (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const month = Number(req.query.month) || new Date().getMonth() + 1;
  const natural = payService.monthStats(req.tdb, year, month, 'natural');
  const cycle = payService.monthStats(req.tdb, year, month, 'cycle');
  const yr = payService.yearStats(req.tdb, year);
  res.json({
    year, month,
    naturalMonth: { from: natural.from, to: natural.to, rows: natural.rows },
    cycleMonth: { from: cycle.from, to: cycle.to, rows: cycle.rows },
    year: yr,
    monthsImported: natural.monthsImported,
  });
});
router.get('/pay/rank', (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  res.json({
    month: payService.topRank(req.tdb, year, 'month'),
    quarter: payService.topRank(req.tdb, year, 'quarter'),
    year: payService.topRank(req.tdb, year, 'year'),
  });
});

// ---------- 预算 ----------
router.get('/pay/budgets', (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const rows = req.tdb.prepare('SELECT * FROM pay_budgets WHERE year=? ORDER BY month, category').all(year);
  const cats = req.tdb.prepare('SELECT name FROM pay_categories ORDER BY id').all().map((c) => c.name);
  res.json({ year, budgets: rows, categories: cats });
});
// 批量：设置某科目全年 12 个月同额（或指定月）
router.post('/pay/budgets', (req, res) => {
  const { year, category, amount, month, all } = req.body || {};
  const y = Number(year) || new Date().getFullYear();
  if (!category) return res.status(400).json({ error: '科目不能为空' });
  const amt = Number(amount) || 0;
  if (all) {
    const stmt = req.tdb.prepare('INSERT INTO pay_budgets(year,month,category,amount) VALUES(?,?,?,?) ON CONFLICT(year,month,category) DO UPDATE SET amount=excluded.amount');
    const tx = req.tdb.transaction(() => { for (let m = 1; m <= 12; m++) stmt.run(y, m, category, amt); });
    tx();
    return res.json({ ok: true, months: 12 });
  }
  const m = Math.min(12, Math.max(1, Number(month) || 1));
  req.tdb.prepare('INSERT INTO pay_budgets(year,month,category,amount) VALUES(?,?,?,?) ON CONFLICT(year,month,category) DO UPDATE SET amount=excluded.amount')
    .run(y, m, category, amt);
  res.json({ ok: true, months: 1 });
});
router.delete('/pay/budgets/:id', (req, res) => {
  req.tdb.prepare('DELETE FROM pay_budgets WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
// 预算 vs 实际（自然月）
router.get('/pay/budget-compare', (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const month = Number(req.query.month) || new Date().getMonth() + 1;
  const budgets = req.tdb.prepare('SELECT category, amount FROM pay_budgets WHERE year=? AND month=?').all(year, month);
  const actualRows = payService.monthStats(req.tdb, year, month, 'natural').rows;
  const actualMap = {};
  for (const r of actualRows) actualMap[r.category || '未分类'] = r.total;
  const out = budgets.map((b) => ({ category: b.category, budget: b.amount, actual: actualMap[b.category] || 0, diff: (actualMap[b.category] || 0) - b.amount }));
  // 没预算但有实际支出的科目也列出
  for (const [c, v] of Object.entries(actualMap)) {
    if (!budgets.find((b) => b.category === c)) out.push({ category: c, budget: 0, actual: v, diff: v });
  }
  res.json({ year, month, rows: out.sort((a, b) => b.diff - a.diff) });
});

// ---------- AI 智能分析 ----------
router.post('/pay/ai-analysis', async (req, res) => {
  try {
    if (!aiService.hasConfig(req.tdb)) return res.status(400).json({ error: 'AI 尚未配置（设置 → AI 配置）' });
    const year = Number(req.body && req.body.year) || new Date().getFullYear();
    const month = Number(req.body && req.body.month) || new Date().getMonth() + 1;
    const stats = payService.monthStats(req.tdb, year, month, 'natural');
    const rank = payService.topRank(req.tdb, year, 'month');
    const budgets = req.tdb.prepare('SELECT category, amount FROM pay_budgets WHERE year=? AND month=?').all(year, month);
    const summary = [
      `本月（${stats.from}~${stats.to}）支出科目统计：`,
      ...stats.rows.map((r) => `${r.category}: ${r.total.toFixed(2)}元/${r.cnt}笔`),
      '',
      `预算：${budgets.length ? budgets.map((b) => `${b.category} ${b.amount}元`).join('、') : '（未设置）'}`,
    ].join('\n');
    const out = await aiService.chat([
      { role: 'system', content: '你是个人财务分析助手，用简洁中文输出，条目化，不超过 250 字。' },
      { role: 'user', content: `请分析以下个人月度支出结构，指出主要消费去向、异常或可优化点，给出 2-3 条具体建议：\n${summary}` },
    ], { maxTokens: 500, temperature: 0.4, tdb: req.tdb });
    res.json({ content: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
