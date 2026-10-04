<template>
  <div class="md-toolbar">
    <button v-for="b in inlineBtns" :key="b.t" class="md-btn" :title="b.title" @click="wrap(b.pre, b.suf, b.ph)">{{ b.t }}</button>
    <span class="sep" />
    <button v-for="b in lineBtns" :key="b.t" class="md-btn" :title="b.title"
            @click="b.insert ? insert(b.insert) : linePrefix(b.pre)">{{ b.t }}</button>
    <span class="sep" />
    <button class="md-btn" title="双向链接 [[笔记标题]]" @click="wrap('[[', ']]', '笔记标题')">[[ ]]</button>
    <button class="md-btn" title="行内标签 #标签" @click="insertTag">#</button>
    <button class="md-btn" title="插入附件 / 图片" @click="$emit('image')">🖼</button>
    <span class="grow" />
    <slot />
  </div>
</template>

<script setup>
// Markdown 工具栏（v1.9.41）。
// 直接操作 textarea 的 value + 派发 input 事件，而不是往 v-model 上做加法：
// 选区/光标位置只有 DOM 知道，绕开 DOM 拼字符串必然出现「光标跳到末尾」这类恼人问题。
const props = defineProps({
  getTextarea: { type: Function, required: true },
});
defineEmits(['image']);

const inlineBtns = [
  { t: 'B', title: '加粗 **文字**', pre: '**', suf: '**', ph: '加粗' },
  { t: 'I', title: '斜体 *文字*', pre: '*', suf: '*', ph: '斜体' },
  { t: 'S', title: '删除线 ~~文字~~', pre: '~~', suf: '~~', ph: '删除' },
  { t: '`', title: '行内代码 `code`', pre: '`', suf: '`', ph: 'code' },
  { t: '🔗', title: '链接 [文字](网址)', pre: '[', suf: '](https://)', ph: '链接文字' },
];
const lineBtns = [
  { t: 'H1', title: '一级标题', pre: '# ' },
  { t: 'H2', title: '二级标题', pre: '## ' },
  { t: 'H3', title: '三级标题', pre: '### ' },
  { t: '•', title: '无序列表', pre: '- ' },
  { t: '1.', title: '有序列表', pre: '1. ' },
  { t: '❝', title: '引用', pre: '> ' },
  { t: '☑', title: '待办', pre: '- [ ] ' },
  { t: '─', title: '分隔线', insert: '\n---\n' },
];
// 行前缀的识别规则：加了新的就先把旧的剥掉（H1 点 H2 = 换级别，不是叠加）
const PREFIX_RE = /^(#{1,6}\s+|>\s+|- \[[ x]\]\s+|[-*]\s+|\d+\.\s+)/;

function ta() { return props.getTextarea ? props.getTextarea() : null; }

// 把改动写回 textarea 并让 v-model 感知（input 事件冒泡到 @input 处理器）
function apply(el, value, selStart, selEnd) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.focus();
  el.setSelectionRange(selStart, selEnd);
}

function wrap(pre, suf, ph) {
  const el = ta();
  if (!el) return;
  const s = el.selectionStart ?? 0; const e = el.selectionEnd ?? 0;
  const v = el.value;
  const sel = v.slice(s, e) || ph || '';
  // 已有同款包裹就先脱掉（B 按钮再点一次等于取消加粗）
  const doubled = v.slice(Math.max(0, s - pre.length), s) === pre && v.slice(e, e + suf.length) === suf;
  if (doubled) return apply(el, v.slice(0, s - pre.length) + sel + v.slice(e + suf.length), s - pre.length, s - pre.length + sel.length);
  const next = v.slice(0, s) + pre + sel + suf + v.slice(e);
  return apply(el, next, s + pre.length, s + pre.length + sel.length);
}

// 行前缀：多行选区逐行加前缀；全部已有同前缀就取消（换标题级别 = 剥掉旧的再加新的）
function linePrefix(pre) {
  const el = ta();
  if (!el) return;
  const v = el.value;
  const s = el.selectionStart ?? 0; const e = el.selectionEnd ?? 0;
  const from = v.lastIndexOf('\n', s - 1) + 1;
  let to = v.indexOf('\n', e);
  if (to < 0) to = v.length;
  const lines = v.slice(from, to).split('\n');
  const allHave = lines.every((l) => !l.trim() || l.startsWith(pre));
  const out = lines.map((l) => {
    if (!l.trim()) return l;
    const bare = l.replace(PREFIX_RE, '');
    return allHave ? bare : pre + bare;
  }).join('\n');
  return apply(el, v.slice(0, from) + out + v.slice(to), from, from + out.length);
}

// 在光标处插一段固定文本（分隔线这种不是行前缀，不能走 linePrefix）
function insert(text) {
  const el = ta();
  if (!el) return;
  const s = el.selectionStart ?? 0; const e = el.selectionEnd ?? 0;
  const v = el.value;
  const next = v.slice(0, s) + text + v.slice(e);
  const p = s + text.length;
  return apply(el, next, p, p);
}

function insertTag() {
  const el = ta();
  if (!el) return;
  const s = el.selectionStart ?? 0; const e = el.selectionEnd ?? 0;
  const v = el.value;
  const sel = v.slice(s, e).replace(/^#/, '') || '标签';
  const lead = s > 0 && !/\s/.test(v[s - 1]) ? ' ' : '';
  const next = v.slice(0, s) + lead + '#' + sel + ' ' + v.slice(e);
  const p = s + lead.length + 1;
  return apply(el, next, p, p + sel.length);
}
</script>

<style scoped>
.md-toolbar { display: flex; gap: 3px; align-items: center; flex-wrap: wrap; padding: 5px 6px; border: 1px solid var(--border); border-bottom: none; border-radius: 8px 8px 0 0; background: var(--bg2); }
.md-btn { padding: 2px 7px; min-width: 26px; font-size: 12px; line-height: 1.6; background: transparent; border: 1px solid transparent; border-radius: 5px; color: var(--text2); cursor: pointer; }
.md-btn:hover { background: var(--bg3); color: var(--text); border-color: var(--border); }
.sep { width: 1px; height: 16px; background: var(--border); margin: 0 3px; }
.grow { flex: 1; }
</style>
