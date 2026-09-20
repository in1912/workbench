// 通用多测试引擎：霍兰德 / DISC / 九型人格（专业测评） + 趣味测试 7 种计分引擎
// 数据来源：js/tests-data.js（PSY_TESTS）与 fun/*.json（FUN_INDEX 懒加载）
(function () {
  'use strict';

  const PSY = () => window.PSY_TESTS || {};
  const clean = s => String(s == null ? '' : s).trim();

  // ---------- 趣味测试题库懒加载（fun/<id>.json，带内存缓存） ----------
  const funCache = {};
  // 选项 key 归一化：branch 类题库的 opts 缺 key 字段（渲染按钮 data-k 为空 → 点击失配），
  // 数字 key（scale 分值等）转字符串（dataset 取出恒为字符串）；缺 key 按序补 A/B/C…
  function normalizeFun(t) {
    const fix = (opts) => (opts || []).map((o, i) => Object.assign({}, o, {
      key: o.key != null ? String(o.key) : String.fromCharCode(65 + i),
    }));
    if (t.opts) t.opts = fix(t.opts);
    (t.questions || []).forEach(q => { if (q.opts) q.opts = fix(q.opts); });
    if (t.globalOpts) t.globalOpts = fix(t.globalOpts);
    if (t.options) t.options = fix(t.options);
    return t;
  }
  function loadFun(id) {
    if (funCache[id]) return Promise.resolve(funCache[id]);
    const base = (window.MBTI_SERVER && window.MBTI_SERVER.mode() === 'workbench') ? '/mbti/' : './';
    return fetch(base + 'fun/' + id + '.json').then(r => {
      if (!r.ok) throw new Error('题库加载失败(' + r.status + ')');
      return r.json();
    }).then(t => { funCache[id] = normalizeFun(t); return t; });
  }

  // ---------- 趣味引擎计分：返回 {title, text, dims?, score?, perq?, html 可自行组装} ----------
  function runFun(test, answers) {
    // answers: { n: optionKey } 或 single/perq/order 用 { 1: key } / { q: rank.. }
    const byEngine = {
      branch: runBranch, tally: runTally, points: runPoints,
      single: runSingle, perq: runPerq, order: runOrder, scale: runScale,
    };
    const fn = byEngine[test.engine];
    if (!fn) throw new Error('未知引擎 ' + test.engine);
    return fn(test, answers);
  }

  // 跳转引擎：逐题跟随 next / res
  function runBranch(t, answers) {
    const qmap = {}; t.questions.forEach(q => (qmap[q.n] = q));
    let cur = t.entry || 1, steps = [];
    for (let i = 0; i < 100; i++) {
      const q = qmap[cur];
      if (!q) break;
      const key = answers[q.n];
      const opt = (q.opts || []).find(o => o.key === key);
      if (!opt) break;
      steps.push({ n: q.n, text: q.text, opt });
      if (opt.res) {
        const r = t.results[opt.res] || {};
        return mkRes(t, r.title || ('结果 ' + opt.res), r.text || '', { steps, resKey: opt.res });
      }
      if (!opt.next) break;
      cur = opt.next;
    }
    return mkRes(t, '未完成', '作答不完整，无法得出结果。', { steps });
  }

  // 计数引擎：按字母或 dim 统计（乐嘉 tallyBy:'dim'）
  function runTally(t, answers) {
    const counts = {};
    t.questions.forEach(q => {
      const key = answers[q.n];
      const opt = (q.opts || []).find(o => o.key === key);
      if (!opt) return;
      const k = t.tallyBy === 'dim' ? (opt.dim || opt.key) : opt.key;
      counts[k] = (counts[k] || 0) + 1;
    });
    const sorted = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const top = sorted[0];
    const r = (t.results || {})[top] || {};
    return mkRes(t, r.title || (t.tallyName ? '主' + t.tallyName + '：' + top : top), r.text || (r.advantage || []).join('\n'), {
      counts, sorted: sorted.map(k => ({ key: k, n: counts[k] })),
      extra: r.disadvantage ? { advantage: r.advantage, disadvantage: r.disadvantage, rule: t.rule } : null,
      steps: t.questions.map(q => ({ n: q.n, text: q.text, opt: (q.opts || []).find(o => o.key === answers[q.n]) })),
    });
  }

  // 计分引擎：选项分值求和（或 globalOpts）→ 分数段
  // t.indexMult：标准分系数（SDS/SAS 粗分×1.25 取整）——区间按标准分匹配，结果同时带粗分 r.score 与标准分 r.index
  // t.scoreOffset：总分加常数（如马基雅维里量表 Mach-IV = 条目和 + 20，总分 40-160）
  function runPoints(t, answers) {
    let sum = 0;
    const steps = [];
    t.questions.forEach(q => {
      const key = answers[q.n];
      const opt = (q.opts || []).find(o => o.key === key) || ((t.globalOpts || []).find(o => o.key === key));
      const sc = opt ? (opt.score || 0) : 0;
      sum += sc;
      steps.push({ n: q.n, text: q.text, opt, score: sc });
    });
    const total = sum + (t.scoreOffset || 0);
    const idx = t.indexMult ? Math.floor(sum * t.indexMult) : null;
    const match = idx != null ? idx : total;
    const range = (t.ranges || []).find(r => match >= r.min && match <= r.max) || (t.ranges || [])[(t.ranges || []).length - 1];
    const unit = t.unit || '分';
    const extra = { score: total, unit, range, counts: null, steps };
    if (idx != null) extra.index = idx;
    return mkRes(t, (range && range.title) || (match + unit), (range && range.text) || '', extra);
  }

  // 单题引擎
  function runSingle(t, answers) {
    const key = answers[1];
    const opt = (t.opts || []).find(o => o.key === key);
    const r = (t.results || {})[key] || {};
    return mkRes(t, r.title || (opt ? opt.text : ''), r.text || '', { resKey: key, steps: [{ n: 1, text: t.question, opt }] });
  }

  // 每题解读引擎：逐题给出选项解读
  function runPerq(t, answers) {
    const perq = [];
    t.questions.forEach(q => {
      const key = answers[q.n];
      const opt = (q.opts || []).find(o => o.key === key);
      perq.push({ n: q.n, text: q.text, title: q.title || '', opt: opt ? opt.text : '', interp: (q.interp || {})[key] || '此项暂无官方解读，凭直觉的选择也反映你的直觉倾向。' });
    });
    return mkRes(t, '逐题解读完成', '', { perq });
  }

  // 排序引擎（猜吵架类）：A/B/C 按可能性排序 → 组合键
  function runOrder(t, answers) {
    // answers: { 1: 'A', 2: 'B', 3: 'C' } 表示第1可能选A、第2可能选B、第3可能选C
    const key = [1, 2, 3].map(i => answers[i]).filter(Boolean).join('');
    const r = (t.results || {})[key] || {};
    return mkRes(t, r.title || key, r.text || '', { resKey: key, steps: [{ n: 1, text: t.question, opt: null }] });
  }

  // 量表引擎：选项分值（globalOpts 1-5 级等）→ 维度得分 + 总分
  // t.resultBy: 'topDim'（默认，职业价值观式：看最看重哪些维度）
  //           | 'totalRange'（总分落段 + 维度均分，如 SCL-90 等临床量表）
  //           | 'dimsRanges'（各维度按均分落段判读，总分无意义，如 QSA 自杀态度问卷）
  // t.posThresh：阳性项目判定阈值（默认 2 = 单项分 ≥2 计 1 个阳性项目）
  // q.rev：反向计分题（QSA 等），分值 = globalOpts 最小分 + 最大分 − 原分
  function runScale(t, answers) {
    const gopts = t.globalOpts || [];
    const gscores = gopts.map(o => (o.score != null ? o.score : parseInt(o.key, 10) || 0));
    const gFlip = gscores.length ? Math.min(...gscores) + Math.max(...gscores) : 0;
    const dims = {};
    Object.keys(t.dims || {}).forEach(k => (dims[k] = Object.assign({}, t.dims[k], { key: k, score: 0, count: 0 })));
    let total = 0, pos = 0;
    const posThresh = t.posThresh != null ? t.posThresh : 2;
    const steps = [];
    t.questions.forEach(q => {
      const v = answers[q.n];
      if (v == null) return;
      const opt = gopts.find(o => o.key === String(v)) || null;
      let sc = opt ? (opt.score != null ? opt.score : parseInt(v, 10) || 0) : (parseInt(v, 10) || 0);
      if (q.rev && gopts.length) sc = gFlip - sc; // 反向题
      total += sc;
      if (sc >= posThresh) pos++;
      const d = dims[q.dim];
      if (d) { d.score += sc; d.count++; }
      steps.push({ n: q.n, text: q.text, opt: opt ? opt.text : String(v), score: sc, rev: !!q.rev });
    });
    Object.values(dims).forEach(d => { d.mean = d.count ? +(d.score / d.count).toFixed(2) : 0; });
    const sorted = Object.values(dims).sort((a, b) => b.score - a.score);
    const top3 = sorted.slice(0, 3);
    if (t.resultBy === 'totalRange' && (t.ranges || []).length) {
      const range = t.ranges.find(r => total >= r.min && total <= r.max) || t.ranges[t.ranges.length - 1];
      return mkRes(t, (range && range.title) || (total + (t.unit || '分')), (range && range.text) || '', {
        dims: sorted, top3, score: total, unit: t.unit || '分', range, positive: pos, steps,
      });
    }
    if (t.resultBy === 'dimsRanges' && (t.dimRanges || []).length) {
      // 每个维度按均分落 t.dimRanges 段（如 QSA：≤2.5 认可 / 2.5-3.5 矛盾 / ≥3.5 反对）
      const rows = (t.dimOrder || Object.keys(t.dims || {})).map(k => dims[k]).filter(Boolean).map(d => {
        const r = t.dimRanges.find(x => d.mean >= x.min && d.mean <= x.max) || t.dimRanges[t.dimRanges.length - 1];
        return { key: d.key, name: d.name, mean: d.mean, title: (r && r.title) || '', text: (r && r.text) || '' };
      });
      return mkRes(t, rows.map(r => r.title).join(' · '), (t.summaryText || '') + rows.map(r => '【' + r.name + '·均分 ' + r.mean + '】' + (r.text || r.title)).join('\n'), {
        dims: sorted, top3, score: total, unit: t.unit || '分', dimRows: rows, steps,
      });
    }
    return mkRes(t, '你最看重：' + top3.map(d => d.name).join('、'), '', { dims: sorted, top3, steps });
  }

  function mkRes(t, title, text, extra) {
    return Object.assign({
      testId: t.id, testTitle: t.title, engine: t.engine,
      title: title || '', text: text || '',
    }, extra || {});
  }

  // ---------- 专业测评：霍兰德 ----------
  function runHolland(answers) {
    const H = PSY().holland;
    const counts = { R: 0, I: 0, A: 0, S: 0, E: 0, C: 0 };
    H.questions.forEach(q => {
      if (answers[q.n] === 1 || answers[q.n] === '1' || answers[q.n] === '是') counts[q.dim]++;
    });
    const sorted = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const code = sorted.slice(0, 3).join('');
    const topDim = H.dims[sorted[0]] || {};
    const careers = H.careerMap[code] || '';
    return {
      testId: 'holland', testTitle: '霍兰德职业兴趣测试', engine: 'holland',
      title: code + ' 型（' + sorted.slice(0, 3).map(k => (H.dims[k] || {}).name || k).join('·') + '）',
      text: topDim.traits || '',
      counts, sorted: sorted.map(k => ({ key: k, n: counts[k], name: (H.dims[k] || {}).name || k })),
      code, careers, topDim,
      top3: sorted.slice(0, 3).map(k => H.dims[k]).filter(Boolean),
    };
  }

  // ---------- 专业测评：DISC ----------
  function runDisc(answers) {
    const D = PSY().disc;
    const counts = { D: 0, I: 0, S: 0, C: 0 };
    D.groups.forEach((g, gi) => {
      const key = answers[gi + 1];
      const st = g.find(x => x.t !== '' && x.dim === key) || g.find(x => x.dim === key);
      if (st) counts[key]++;
    });
    const sorted = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const mains = sorted.filter(k => counts[k] > 10); // 原版规则：>10 分为显性因子
    const keyList = mains.length ? mains : [sorted[0]];
    const detail = keyList.map(k => D.dims[k]).filter(Boolean);
    return {
      testId: 'disc', testTitle: 'DISC 性格测试', engine: 'disc',
      title: keyList.map(k => (D.dims[k] || {}).name || k).join(' + '),
      text: (detail[0] && (detail[0].headline + '。' + detail[0].emotion)) || '',
      counts, sorted: sorted.map(k => ({ key: k, n: counts[k], name: (D.dims[k] || {}).name || k })),
      keyList, detail, rule: D.rule,
    };
  }

  // ---------- 专业测评：九型人格 ----------
  function runEnneagram(answers) {
    const E = PSY().enneagram;
    const counts = {};
    for (let i = 1; i <= 9; i++) counts[i] = 0;
    E.questions.forEach(q => {
      if (answers[q.n] === 1 || answers[q.n] === '1' || answers[q.n] === '是') counts[q.dim]++;
    });
    const sorted = Object.keys(counts).map(Number).sort((a, b) => counts[b] - counts[a]);
    const top = sorted[0];
    const ty = (E.types || {})[top] || {};
    return {
      testId: 'enneagram', testTitle: '九型人格测试', engine: 'enneagram',
      title: '第 ' + top + ' 型 · ' + (ty.name || ''),
      text: (ty.paragraphs || []).join('\n'),
      counts, sorted: sorted.map(k => ({ key: k, n: counts[k], name: ((E.types || {})[k] || {}).name || ('第' + k + '型') })),
      type: ty, wing: sorted[1] ? ('相邻侧翼可参考第 ' + sorted[1] + ' 型') : '',
    };
  }

  // ---------- 测试元信息（主测 + 趣味统一查询） ----------
  function mainTests() {
    return (PSY().registry || []).map(r => {
      const data = PSY()[r.id];
      return {
        id: r.id, icon: r.icon, title: r.title, tagline: r.tagline, brief: r.brief, qc: r.qc,
        count: data ? (data.questions ? data.questions.length : (data.groups ? data.groups.length : 0)) : 0,
      };
    });
  }
  function funTests() { return (window.FUN_INDEX || []).slice(); }
  function testInfo(id) {
    const m = mainTests().find(t => t.id === id);
    if (m) return m;
    const f = funTests().find(t => t.id === id);
    if (f) return { id: f.id, icon: '🎲', title: f.title, tagline: (f.intro || '').slice(0, 30), brief: f.intro || '', qc: f.qc + ' 题', engine: f.engine, count: f.qc };
    return null;
  }

  // 引擎中文名（列表角标）
  const ENGINE_LABEL = {
    branch: '情景跳转', tally: '类型计数', points: '计分制', single: '单题速测',
    perq: '逐题解析', order: '排序测写', scale: '量表',
    holland: '专业测评', disc: '专业测评', enneagram: '专业测评', mbti: '专业测评',
  };
  function engineLabel(e) { return ENGINE_LABEL[e] || '趣味测试'; }

  window.MBTI_ENGINES = {
    loadFun, runFun, runHolland, runDisc, runEnneagram,
    mainTests, funTests, testInfo, engineLabel,
  };
})();
