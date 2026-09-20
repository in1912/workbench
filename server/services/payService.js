// 个人账务：支付宝账单解析 + 消费科目识别 + 统计
const { db, getSetting, setSetting } = require('../db');

// ---------- 支付宝 CSV 解析 ----------
// 格式（GB18030 编码）：0-3 行单据头，第 4 行表头，第 5 行起数据，'-----' 行起单据尾（含该行全部丢弃）
// 列：交易号,商家订单号,交易创建时间,付款时间,最近修改时间,交易来源地,类型,交易对方,商品名称,金额（元）,收/支,交易状态,服务费（元）,成功退款（元）,备注,资金状态,（尾逗号空列）
function parseAlipayCsv(buffer) {
  // GB18030 解码（支付宝导出默认 GBK 系）
  let text;
  try { text = new TextDecoder('gb18030').decode(buffer); }
  catch { text = buffer.toString('utf8'); }
  const lines = text.split(/\r?\n/);
  // 找表头行（含"交易号"且含"金额"）
  let headerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    if (/交易号/.test(lines[i]) && /金额/.test(lines[i])) { headerIdx = i; break; }
  }
  if (headerIdx < 0) throw new Error('未找到表头行（需含"交易号"和"金额"列）——请确认是支付宝导出的 CSV');
  const header = splitCsvLine(lines[headerIdx]).map((s) => s.trim().replace(/\t/g, ''));
  const col = (name) => header.findIndex((h) => h.replace(/\s/g, '').includes(name.replace(/\s/g, '')));
  const cTrade = col('交易号'), cMerchant = col('商家订单号'), cCreate = col('交易创建时间'), cPay = col('付款时间'), cModify = col('最近修改时间'),
    cSource = col('交易来源地'), cType = col('类型'), cParty = col('交易对方'), cGoods = col('商品名称'),
    cAmount = col('金额'), cInOut = col('收/支'), cStatus = col('交易状态'), cFee = col('服务费'),
    cRefund = col('成功退款'), cRemark = col('备注'), cFund = col('资金状态');
  // 数据行：表头下一行起，遇以 '----' 开头的行停止（该行及之后全是尾部附加信息）
  const rows = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^-{5,}/.test(line.trim())) break; // '-----------' 结尾行
    let cells = splitCsvLine(line);
    if (cells.length > header.length) {
      // 溢出处理：把 cGoods 到 cRemark 之间的多余单元格合并（商品名/备注内含逗号）
      const overflow = cells.length - header.length;
      if (cGoods >= 0 && cRemark > cGoods) {
        const merged = cells.splice(cGoods, overflow + 1).join(',');
        cells.splice(cGoods, 0, merged);
      } else cells = cells.slice(0, header.length);
    }
    const g = (idx) => (idx >= 0 && idx < cells.length ? cells[idx].replace(/\t/g, '').trim() : '');
    const tradeNo = g(cTrade);
    if (!tradeNo || !/^\d/.test(tradeNo)) continue; // 非数据行
    rows.push({
      trade_no: tradeNo,
      merchant_no: g(cMerchant),
      create_time: normDate(g(cCreate)),
      pay_time: normDate(g(cPay)),
      modify_time: normDate(g(cModify)),
      source: g(cSource),
      tx_type: g(cType),
      counterparty: g(cParty),
      goods: g(cGoods),
      amount: Math.round((parseFloat(g(cAmount).replace(/[^\d.\-]/g, '')) || 0) * 100) / 100,
      inout: g(cInOut),
      status: g(cStatus),
      fee: parseFloat(g(cFee)) || 0,
      refund: parseFloat(g(cRefund)) || 0,
      remark: g(cRemark),
      fund_status: g(cFund),
    });
  }
  return rows;
}
// CSV 行拆分：支持双引号包裹字段（引号内逗号不算分隔、"" 转义）
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

// 日期归一化：兼容 '2025-09-19 00:20:15' / '2026/5/19 16:18' / '2026-05-19' → 'YYYY-MM-DD[ HH:mm[:ss]]'
function normDate(s) {
  const t = String(s || '').trim().replace(/\//g, '-');
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(t);
  if (!m) return '';
  const p = (n) => String(n).padStart(2, '0');
  const date = `${m[1]}-${p(m[2])}-${p(m[3])}`;
  if (m[4] !== undefined) return `${date} ${p(m[4])}:${m[5]}${m[6] ? ':' + m[6] : ':00'}`;
  return date;
}

// ---------- 科目识别 ----------
// 泛化词（渠道/平台/支付方式）：出现在大量不同科目里，不能单独作为归类依据
// （例："淘宝""美团""支付宝网站""外卖订单" 在买菜/家庭/温泉/装修…里都出现）
const GENERIC_WORDS = new Set([
  '淘宝', '淘宝闪购', '天猫', '支付宝网站', '支付宝', '美团', '饿了么', '闲鱼', '拼多多',
  '其他（包括阿里巴巴和外部商家）', '其他', '即时到账交易', '支付宝担保交易', '外部商家',
  '二维码支付', '收钱码收款', '医保支付(不含自费)', 'App Store & Apple Music', 'App Store & Apple Music；',
]);
function isGenericWord(w) {
  const t = String(w || '').trim();
  if (!t) return true;
  if (GENERIC_WORDS.has(t)) return true;
  // 形如 x***5 / t** / sa**店 的打码账户名：泛化且不独特
  if (/\*{2,}/.test(t)) return true;
  // 含"外卖订单""寄件费"字样的通用动作词（匹配面太广）
  if (/外卖订单$/.test(t) && t.length <= 20 && !/[（(]/.test(t)) return true;
  return false;
}

// 规则优先（关键词命中），未命中走 AI（由路由层调用 aiService），AI 也未定 → '未分类'
// 特征匹配范围：交易对方 + 商品名称 + 交易来源；只用专有特征词（泛化词不算命中）
function classifyBill(d, bill) {
  const cats = d.prepare('SELECT name, keywords FROM pay_categories').all();
  const hay = `${bill.counterparty || ''} ${bill.goods || ''} ${bill.source || ''}`;
  // 只收集非泛化特征词；命中最长的一个（更具体优先，如"春晓(王小萍)"优先于"王小萍"）
  let best = null;
  for (const c of cats) {
    const kws = String(c.keywords || '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    for (const k of kws) {
      if (isGenericWord(k)) continue;
      if (hay.includes(k)) {
        if (!best || k.length > best.kw.length) best = { category: c.name, src: 'rule', kw: k };
      }
    }
  }
  return best;
}

// 初始科目库（从用户 2025-2026 历史账单 1854 条训练提炼；交易对方→科目 的强规律）
const DEFAULT_CATEGORIES = [
  { name: '买菜', keywords: '春晓(王小萍),张姐蔬菜,叮咚买菜,三江购物,山姆会员,大块头食品,开市客' },
  { name: '家庭', keywords: '中国平安,拼多多平台,百亿,淘宝闪购,美团,饿了么,天猫,沃尔玛,华润万家' },
  { name: '餐饮', keywords: '蜜雪冰城,柠季,故里炸鸡,继光香香鸡,阿甘锅盔,面馆,小吃,餐饮,烤肉,火锅' },
  { name: '个人消费', keywords: '闲鱼,1973,服装,理发,美发,英子美发' },
  { name: '亲情', keywords: '君颖,亲情卡转账,转账' },
  { name: '子女', keywords: '温怀瑾,阳阳,媛媛,KKV,玩具,文具' },
  { name: '车', keywords: '中国石化,中国石油,加油站,高速,绕城,收费站,停车,滴滴,曹操出行,地铁,公交' },
  { name: '水电煤', keywords: '水务环境,供电局,电业局,新奥燃气,兴光燃气,燃气,供电,水务' },
  { name: '通讯', keywords: '中国联通,中国电信,中国移动,话费,宽带,阿里云' },
  { name: '住房', keywords: '财政局,税务局,物业,中海物业,房贷' },
  { name: '医疗', keywords: '医院,药房,药店,诊所,医药' },
  { name: '旅行', keywords: '酒店,民宿,景区,旅行,航空,机票,火车票,去哪儿,飞猪,文旅' },
  { name: '装修', keywords: '地板,建材,装修,五金,灯具,卫浴,甄金' },
  { name: '人情', keywords: '礼品,花店,红包' },
  { name: '退款', keywords: '退押金' },
];
function seedCategories(d = db) {
  const has = d.prepare('SELECT COUNT(*) c FROM pay_categories').get().c;
  if (has) return;
  for (const c of DEFAULT_CATEGORIES) {
    d.prepare('INSERT OR IGNORE INTO pay_categories(name,keywords) VALUES(?,?)').run(c.name, c.keywords);
  }
  console.log('[pay] 初始科目库已生成（' + DEFAULT_CATEGORIES.length + ' 类，基于历史账单训练）');
}

// ---------- 导入 ----------
function importRows(d, rows, { sourceFile = '' } = {}) {
  const insert = d.prepare(`
    INSERT OR IGNORE INTO pay_bills(trade_no,merchant_no,create_time,pay_time,modify_time,source,tx_type,counterparty,goods,
      amount,inout,status,fee,refund,remark,fund_status,category,category_src,is_expense,source_file)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  let inserted = 0, dup = 0, expense = 0, aiPending = 0;
  const tx = d.transaction(() => {
    for (const r of rows) {
      const isExp = r.inout === '支出' && r.amount > 0 ? 1 : 0;
      let category = '';
      let src = '';
      if (isExp) {
        const hit = classifyBill(d, r);
        if (hit) { category = hit.category; src = hit.src; }
        else { category = '未分类'; src = ''; aiPending++; }
      }
      const res = insert.run(
        r.trade_no || null, r.merchant_no, r.create_time, r.pay_time, r.modify_time || '', r.source, r.tx_type, r.counterparty, r.goods,
        r.amount, r.inout, r.status, r.fee, r.refund, r.remark, r.fund_status,
        category, src, isExp, sourceFile
      );
      if (res.changes > 0) { inserted++; if (isExp) expense++; }
      else dup++;
    }
  });
  tx();
  return { inserted, dup, expense, aiPending };
}

// 批量 AI 补分类：取未分类的支出流水，按对方+商品名分组压缩后让 AI 归类
function pendingUnclassified(d, limit = 200) {
  return d.prepare("SELECT id, counterparty, goods, amount FROM pay_bills WHERE is_expense=1 AND (category='' OR category='未分类') ORDER BY id DESC LIMIT ?").all(limit);
}

// ---------- 统计 ----------
// 月度科目统计：按交易创建时间的月份；period: 'natural'(自然月) | 'cycle'(核算月)
function monthStats(d, year, month, period = 'natural') {
  const cfg = getSetting(d, 'pay_cycle', { start_day: 1 });
  let from, to;
  if (period === 'cycle' && Number(cfg.start_day) !== 1) {
    const sd = Math.min(31, Math.max(1, Number(cfg.start_day) || 1));
    // 核算月：上月 sd 日 ~ 本月 sd-1 日（month 为核算月号）
    const fy = month === 1 ? year - 1 : year;
    const fm = month === 1 ? 12 : month - 1;
    const dim = new Date(fy, fm, 0).getDate();
    from = `${fy}-${p2(fm)}-${p2(Math.min(sd, dim))}`;
    const dim2 = new Date(year, month, 0).getDate();
    to = `${year}-${p2(month)}-${p2(Math.min(sd - 1 === 0 ? dim2 : sd - 1, dim2))}`;
  } else {
    from = `${year}-${p2(month)}-01`;
    to = `${year}-${p2(month)}-${p2(new Date(year, month, 0).getDate())}`;
  }
  const rows = d.prepare(`
    SELECT category, COUNT(*) cnt, SUM(amount) total FROM pay_bills
    WHERE is_expense=1 AND substr(create_time,1,10) BETWEEN ? AND ?
    GROUP BY category ORDER BY total DESC
  `).all(from, to);
  const monthsImported = distinctMonths(d);
  return { from, to, rows, monthsImported };
}
function p2(n) { return String(n).padStart(2, '0'); }
function distinctMonths(d) {
  const rows = d.prepare("SELECT DISTINCT substr(create_time,1,7) m FROM pay_bills WHERE create_time != '' ORDER BY m").all();
  return rows.map((r) => r.m);
}
// 年度统计 + 每月曲线
function yearStats(d, year) {
  const rows = d.prepare(`
    SELECT substr(create_time,1,7) ym, category, SUM(amount) total
    FROM pay_bills WHERE is_expense=1 AND substr(create_time,1,4)=?
    GROUP BY ym, category ORDER BY ym, total DESC
  `).all(String(year));
  const months = {};
  for (const r of rows) {
    (months[r.ym] = months[r.ym] || []).push({ category: r.category || '未分类', total: r.total });
  }
  const byCategory = {};
  for (const r of rows) byCategory[r.category || '未分类'] = (byCategory[r.category || '未分类'] || 0) + r.total;
  return { months, byCategory, totalMonths: Object.keys(months).length };
}
// 排行：scope month/quarter/year
function topRank(d, year, scope) {
  let from, to;
  const now = new Date();
  if (scope === 'month') {
    from = `${year}-${p2(now.getMonth() + 1)}-01`;
    to = `${year}-${p2(now.getMonth() + 1)}-${p2(new Date(year, now.getMonth() + 1, 0).getDate())}`;
  } else if (scope === 'quarter') {
    const q = Math.floor(now.getMonth() / 3);
    from = `${year}-${p2(q * 3 + 1)}-01`;
    const lm = q * 3 + 3;
    to = `${year}-${p2(lm)}-${p2(new Date(year, lm, 0).getDate())}`;
  } else {
    from = `${year}-01-01`;
    to = `${year}-12-31`;
  }
  return d.prepare(`
    SELECT category, COUNT(*) cnt, SUM(amount) total FROM pay_bills
    WHERE is_expense=1 AND substr(create_time,1,10) BETWEEN ? AND ?
    GROUP BY category ORDER BY total DESC LIMIT 10
  `).all(from, to);
}

// 固定支出注入某月（手动补流水；去重：同月同科目同金额的 fixed 只加一条）
function injectFixed(d, year, month) {
  const fixed = d.prepare('SELECT * FROM pay_categories WHERE is_fixed=1 AND fixed_amount>0').all();
  const ym = `${year}-${p2(month)}`;
  let added = 0;
  for (const f of fixed) {
    const exists = d.prepare(
      "SELECT COUNT(*) c FROM pay_bills WHERE category_src='fixed' AND category=? AND substr(create_time,1,7)=?"
    ).get(f.name, ym).c;
    if (exists) continue;
    const dim = new Date(year, month, 0).getDate();
    d.prepare(`INSERT INTO pay_bills(trade_no,create_time,goods,amount,inout,status,category,category_src,is_expense)
      VALUES(?,?,?,?,?,?,?,?,1)`)
      .run(`FIXED-${ym}-${f.id}`, `${ym}-${p2(dim)} 00:00:00`, `每月固定支出（${f.note || f.name}）`, f.fixed_amount, '支出', '固定', f.name, 'fixed');
    added++;
  }
  return added;
}

// 训练账单（xlsx sheet2 明细带类型列）→ 学习科目特征：更新/插入 pay_categories 的 keywords
// 特征来源：交易对方（最强）、商品名称（次之）、交易来源（辅助）——同科目下出现 ≥2 次 → 特征词
function learnFromLabeled(d, rows) {
  // rows: [{ type, counterparty, goods, source }]
  const byType = {}; // type -> { word: [字段类型, 次数] }
  const BAD_TYPE = new Set(['支出', '收入', '已支出', '已收入', '待支出', '待收入', '不计收支', '']);
  for (const r of rows) {
    const t = String(r.type || '').trim();
    if (BAD_TYPE.has(t)) continue; // 收支标记不是科目名
    const slot = (byType[t] = byType[t] || {});
    const feed = (word, weight) => {
      const w = String(word || '').trim();
      if (!w || w.length < 2 || w.length > 24) return;
      if (isGenericWord(w)) return; // 泛化词（淘宝/美团/打码名）不学
      if (!slot[w]) slot[w] = [weight, 0];
      slot[w][1] += 1;
    };
    feed(r.counterparty, 3); // 交易对方最强
    feed(String(r.goods || '').slice(0, 24), 2); // 商品名（截断，避免长尾噪词）
    feed(r.source, 1); // 交易来源（如"淘宝"/"支付宝网站"——多为泛词会被滤掉）
  }
  let catsAdded = 0, kwsAdded = 0;
  for (const [type, words] of Object.entries(byType)) {
    let cat = d.prepare('SELECT * FROM pay_categories WHERE name=?').get(type);
    if (!cat) {
      d.prepare('INSERT INTO pay_categories(name,keywords,note) VALUES(?,?,?)').run(type, '', '历史账单训练生成');
      cat = d.prepare('SELECT * FROM pay_categories WHERE name=?').get(type);
      catsAdded++;
    }
    // 强特征：出现≥2次；按 权重×次数 排序取前 40（交易对方优先、高频商品名次之）
    const strong = Object.entries(words)
      .filter(([, [, n]]) => n >= 2)
      .sort((a, b) => (b[1][0] * b[1][1]) - (a[1][0] * a[1][1]))
      .map(([w]) => w);
    const existing = String(cat.keywords || '').split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const merged = [...new Set([...strong, ...existing])].slice(0, 40);
    if (merged.length !== existing.length) {
      d.prepare('UPDATE pay_categories SET keywords=? WHERE id=?').run(merged.join(','), cat.id);
      kwsAdded += merged.length - existing.length;
    }
  }
  return { types: Object.keys(byType).length, catsAdded, kwsAdded };
}

module.exports = {
  parseAlipayCsv, importRows, classifyBill, seedCategories, pendingUnclassified,
  monthStats, yearStats, topRank, injectFixed, learnFromLabeled, distinctMonths,
};
