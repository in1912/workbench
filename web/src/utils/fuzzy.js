// 模糊匹配（v1.9.41）：快速切换器（Ctrl+O）与命令面板（Ctrl+Shift+P）共用。
//
// 打分规则偏「人找笔记」的直觉：连续命中最贵、开头命中次之、分词边界（空格 / - _ / . / 中英交界）
// 再次之；不匹配返回 -1。中文没有词边界，所以整串出现在标题里时直接给一个高权重，
// 这也是「输入两三个汉字就希望置顶」的常见用法。

const SEP = /[\s\-_/.·、，,（）()[\]{}:：]/;

function isBoundary(s, i) {
  if (i === 0) return true;
  const prev = s[i - 1];
  if (SEP.test(prev)) return true;
  // 中英/数字交界也算边界：笔记「周报weekly」输入 w 应该算开头
  const a = /[a-z0-9]/.test(prev);
  const b = /[a-z0-9]/.test(s[i]);
  return a !== b;
}

/**
 * 给一次匹配打分。
 * @returns {{score:number, idx:number[]}|null} 不匹配返回 null
 */
export function fuzzyMatch(query, target) {
  const q = String(query ?? '').trim();
  const t = String(target ?? '');
  if (!q) return { score: 0, idx: [] };
  const ql = q.toLowerCase();
  const tl = t.toLowerCase();

  // 整串命中：直接给高分，位置越靠前越高
  const at = tl.indexOf(ql);
  if (at >= 0) {
    const idx = Array.from({ length: ql.length }, (_, i) => at + i);
    let score = 100 + ql.length * 10;
    if (at === 0) score += 60;
    else if (isBoundary(tl, at)) score += 30;
    else score -= Math.min(20, at);
    score -= t.length * 0.05; // 同样命中，短名字优先
    return { score, idx };
  }

  // 子序列匹配（贪心，但每个查询字符只在当前位置之后找，保证顺序）
  let ti = 0;
  const idx = [];
  let score = 0;
  let prev = -2;
  for (const ch of ql) {
    const found = tl.indexOf(ch, ti);
    if (found < 0) return null;
    idx.push(found);
    score += 6;
    if (found === prev + 1) score += 14;      // 与上一个命中相邻
    else if (isBoundary(tl, found)) score += 8;
    if (found === 0) score += 10;
    score -= Math.min(6, Math.max(0, found - prev - 1)) * 0.5; // 中间跳过的字符越多扣一点
    prev = found;
    ti = found + 1;
  }
  if (ql.length > 1 && ql.length / t.length > 0.6) score += 12; // 查询几乎覆盖全文
  score -= t.length * 0.05;
  return { score, idx };
}

/**
 * 过滤 + 排序。
 * @param {string} query
 * @param {Array} items
 * @param {{key?:string|Function, limit?:number}} [opts]
 * @returns {Array<{item:any, score:number, idx:number[]}>} 空查询按原顺序全量返回
 */
export function fuzzyFilter(query, items, opts = {}) {
  const key = typeof opts.key === 'function' ? opts.key : (x) => (opts.key ? x[opts.key] : x);
  const list = Array.isArray(items) ? items : [];
  const q = String(query ?? '').trim();
  if (!q) {
    const all = list.map((item) => ({ item, score: 0, idx: [] }));
    return opts.limit ? all.slice(0, opts.limit) : all;
  }
  const out = [];
  for (const item of list) {
    const m = fuzzyMatch(q, key(item));
    if (m) out.push({ item, score: m.score, idx: m.idx });
  }
  out.sort((a, b) => b.score - a.score);
  return opts.limit ? out.slice(0, opts.limit) : out;
}

// 把命中的字符位置合到 <mark> 里（切换器/面板的结果高亮）。
// 只在「位置数组严格递增且都命中」的前提下用，越界一律忽略。
export function highlight(text, idx) {
  const s = String(text ?? '');
  const set = new Set(Array.isArray(idx) ? idx : []);
  let out = '';
  for (let i = 0; i < s.length; i++) out += set.has(i) ? `<mark>${esc(s[i])}</mark>` : esc(s[i]);
  return out;
}
const esc = (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c);
