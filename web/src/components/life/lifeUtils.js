// 人生管理系统（v1.10.0）前端共用的小工具与常量。
//
// 这些标签**故意在前端也留一份**（后端 /life/meta 也给）：meta 要联网才拿得到，
// 而列表里每一行都要用它们渲染，等 meta 回来再渲染会让整页先闪一下空白。
// 新增枚举值时两边一起改；后端的 meta 才是「唯一真相」，这里只是渲染缓存。

export const LEVEL_LABEL = { vision: '愿景', year: '年度', quarter: '季度', month: '月度' };
export const LEVEL_ORDER = ['vision', 'year', 'quarter', 'month'];
export const REVIEW_LABEL = { day: '日复盘', week: '周复盘', month: '月复盘', quarter: '季复盘', year: '年复盘' };
export const TASK_TYPE_LABEL = { daily_todo: '日常待办', main_line: '主线任务', project_task: '项目任务' };
export const PROJECT_CAT_LABEL = { work: '工作', side_business: '副业', content: '内容', product: '产品', delivery: '交付' };
export const GOAL_STATUS_LABEL = { active: '进行中', done: '已达成', paused: '已暂停', archived: '已归档' };
export const RELATION_LABEL = { belongs: '属于', supports: '支撑', produces: '产出', derives: '派生', reviews: '复盘', relates: '相关' };
export const ENTITY_LABEL = {
  goal: '目标', kr: '关键结果', task: '行动', habit: '习惯', project: '项目', note: '笔记',
  domain: '领域', sop: 'SOP', bill: '账单', family: '家庭', kid: '子女', skill: '技能',
  file: '文件', review: '复盘',
};

export const p2 = (n) => String(n).padStart(2, '0');
export const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`; };

/**
 * 进度 → 显示文本。**null 必须显示成「未量化」而不是 0%**：
 * 「没有 KR 也没有子目标」和「有目标但一点没做」是两回事，显示成 0% 会让人误判。
 */
export function pct(v) {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return '未量化';
  return Math.round(Number(v) * 100) + '%';
}
export function hasPct(v) { return v !== null && v !== undefined && !Number.isNaN(Number(v)); }

/** 进度条颜色：低=红 中=琥珀 高=绿（未量化时用灰） */
export function pctColor(v) {
  if (!hasPct(v)) return 'var(--text3)';
  const n = Number(v);
  if (n >= 0.7) return 'var(--green)';
  if (n >= 0.3) return 'var(--amber)';
  return 'var(--red)';
}

/** 目标树 → 扁平数组（带 depth，供缩进渲染）；已经是一棵树时用 */
export function flattenTree(nodes, depth = 0, out = []) {
  for (const n of nodes || []) {
    out.push({ ...n, _depth: depth });
    if (n.children && n.children.length) flattenTree(n.children, depth + 1, out);
  }
  return out;
}

export function shortDate(s) { return String(s || '').slice(0, 10); }
export function shortDateTime(s) { return String(s || '').replace('T', ' ').slice(0, 16); }

/** 关联项 → 可读标题（后端已回填 title；review 这类无标题列的后端会合成） */
export function entityTitle(e) {
  const t = e && e.other ? e.other : e;
  if (!t) return '';
  if (t.title) return t.title;
  return `${ENTITY_LABEL[t.type] || t.type} #${t.id}`;
}
