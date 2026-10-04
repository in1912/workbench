<template>
  <div class="editor" :class="{ empty: !note }">
    <MarkdownToolbar v-if="note" :get-textarea="() => taEl" @image="$emit('image')">
      <span class="muted" style="font-size:11.5px; white-space:nowrap">{{ words }} 字</span>
      <div class="modes">
        <button v-for="m in MODES" :key="m.k" class="mbtn" :class="{ on: mode === m.k }" :title="m.title"
                @click="$emit('update:mode', m.k)">{{ m.t }}</button>
      </div>
    </MarkdownToolbar>

    <div v-if="note" class="body" :class="mode">
      <textarea v-show="mode !== 'preview'" ref="taEl" v-model="note.content"
                class="ta" spellcheck="false"
                placeholder="支持 Markdown；用 [[另一篇笔记的标题]] 建立双链，#标签 归类（标题写 `# ` 开头）"
                @keydown="onKeydown" />
      <div v-show="mode !== 'edit'" ref="previewEl" class="markdown-body preview" v-html="rendered" @click="onPreviewClick" />
    </div>
    <div v-else class="empty-hint">选择或新建一篇笔记</div>
  </div>
</template>

<script setup>
// 编辑器（v1.9.41）：textarea + 编辑/分屏/预览三态。
// 不做所见即所得 —— 这一版的目标是「Markdown 源文 + 即时预览」，富文本编辑器是另一个量级的工作。
import { ref, computed, watch, nextTick } from 'vue';
import MarkdownToolbar from './MarkdownToolbar.vue';
import { renderMarkdown, wordCount } from '../../utils/markdown';

const props = defineProps({
  note: { type: Object, default: null },
  mode: { type: String, default: 'edit' },
  resolveWiki: { type: Function, default: () => null },
});
const emit = defineEmits(['update:mode', 'image', 'open-note', 'new-note', 'save']);

const MODES = [
  { k: 'edit', t: '编辑', title: '只看正文' },
  { k: 'split', t: '分屏', title: '左边写、右边看' },
  { k: 'preview', t: '预览', title: '只看渲染结果' },
];

const taEl = ref(null);
const previewEl = ref(null);
const words = computed(() => wordCount(props.note?.content || ''));
const rendered = computed(() => renderMarkdown(props.note?.content || '', { resolveWiki: props.resolveWiki }));

// 预览里点双链：命中的开页签，未命中的带着标题去新建（与老版一致）
function onPreviewClick(e) {
  const a = e.target.closest?.('a');
  if (!a) return;
  const miss = a.dataset.wikiNew;
  if (miss) { e.preventDefault(); emit('new-note', miss); return; }
  const hit = a.dataset.wikiNote;
  if (hit) { e.preventDefault(); emit('open-note', Number(hit)); return; }
  // 预览里的外链交给浏览器新窗口打开；markdown 内部锚点不拦
}

function onKeydown(e) {
  // Ctrl/Cmd+S 保存：编辑器自己拦（快捷键表里也注册了，但这里保证光标在 textarea 里时一定生效）
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); emit('save'); }
}

// 预览区滚到与正文对应的位置这件事不做 —— 按标题行做比例映射在长文里反而更飘。
// 大纲面板负责「点标题跳过去」，那是精确的。
defineExpose({ scrollToHeading, insertText, replaceText, focus });

// AI 结果回填：插入到光标处 / 整篇替换。都走 textarea 的原生 setRangeText，
// 这样撤销栈（Ctrl+Z）还能正常回退 —— 直接改 v-model 会把历史记录冲掉。
async function insertText(text) {
  const s = String(text || '');
  if (!s) return;
  await ensureEditMode();
  const ta = taEl.value;
  if (!ta) return;
  ta.focus();
  const pos = ta.selectionStart ?? ta.value.length;
  const sep = pos > 0 && !/\n$/.test(ta.value.slice(0, pos)) ? '\n\n' : '';
  try { ta.setRangeText(sep + s, ta.selectionEnd ?? pos, ta.selectionEnd ?? pos, 'end'); }
  catch { props.note.content = (props.note.content || '') + sep + s; }
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

async function replaceText(text) {
  await ensureEditMode();
  const ta = taEl.value;
  if (!ta) return;
  ta.focus();
  try { ta.setRangeText(String(text || ''), 0, ta.value.length, 'end'); }
  catch { props.note.content = String(text || ''); }
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

function focus() { try { taEl.value?.focus(); } catch { /* 忽略 */ } }

// 纯预览模式下没有 textarea，先切到分屏（左侧就是可编辑的源文）
async function ensureEditMode() {
  if (props.mode === 'preview') { emit('update:mode', 'split'); await nextTick(); }
}

// 大纲点击 → 在预览区里找第 n 个同名标题并滚过去（预览可能没渲染，先切过去再说）
async function scrollToHeading(index) {
  if (props.mode === 'edit') emit('update:mode', 'split');
  await nextTick();
  const root = previewEl.value;
  if (!root) return;
  const hs = root.querySelectorAll('h1,h2,h3,h4,h5,h6');
  const el = hs[index];
  if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

// 切到预览模式时把光标位置记住，切回来还落在原处（长文里很实用）
let caret = 0;
watch(() => props.mode, async (m, old) => {
  if (m === 'edit' && old !== 'edit') {
    await nextTick();
    const ta = taEl.value;
    if (ta) { ta.focus(); try { ta.setSelectionRange(caret, caret); } catch { /* 忽略 */ } }
  } else if (m !== 'edit' && taEl.value) {
    caret = taEl.value.selectionStart ?? 0;
  }
});
</script>

<style scoped>
.editor { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.editor.empty { border: 1px dashed var(--border); border-radius: 8px; }
.body { display: flex; flex: 1; min-height: 0; gap: 10px; }
.body.edit .ta, .body.preview .preview { flex: 1; }
.body.split .ta, .body.split .preview { flex: 1 1 50%; min-width: 0; }
.ta {
  border: 1px solid var(--border); border-radius: 0 0 8px 8px; padding: 12px;
  font-family: ui-monospace, Consolas, monospace; font-size: 13.5px; line-height: 1.7;
  resize: none; background: var(--bg2); color: var(--text);
}
.body.split .ta { border-radius: 0 0 0 8px; }
.preview { border: 1px solid var(--border); border-radius: 0 0 8px 8px; padding: 12px 16px; overflow-y: auto; background: var(--bg2); }
.body.split .preview { border-radius: 0 0 8px 0; }
.empty-hint { color: var(--text3); text-align: center; padding: 40px 0; }
.modes { display: flex; gap: 2px; margin-left: 8px; }
.mbtn { font-size: 11.5px; padding: 2px 8px; border-radius: 5px; border: 1px solid var(--border); background: transparent; color: var(--text2); cursor: pointer; }
.mbtn.on { background: var(--accent); color: #fff; border-color: var(--accent); }
:deep(.wl) { color: var(--accent); text-decoration: none; border-bottom: 1px dashed currentColor; cursor: pointer; }
:deep(.wl-miss) { color: var(--text2); border-bottom: 1px dashed var(--border); }
:deep(mark) { background: var(--amber); color: #000; border-radius: 2px; }
</style>
