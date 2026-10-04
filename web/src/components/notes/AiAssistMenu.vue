<template>
  <span class="ai-wrap">
    <button v-for="a in ACTIONS" :key="a.k" class="small" :disabled="disabled || loading" :title="a.title"
            @click="run(a.k)">{{ loading && cur === a.k ? '…' : a.t }}</button>

    <div v-if="open" class="modal-backdrop" @click.self="open = false">
      <div class="modal" style="width:min(720px,94vw); max-height:86vh; overflow-y:auto">
        <h3>AI {{ labelOf(cur) }}</h3>
        <div v-if="err" class="msg err">{{ err }}</div>
        <div v-else class="markdown-body" style="max-height:46vh; overflow:auto; border:1px solid var(--border); border-radius:8px; padding:10px 12px; background:var(--bg3)"
             v-html="rendered" />
        <div class="row" style="margin-top:12px; justify-content:flex-end; gap:6px">
          <span class="muted small" style="margin-right:auto">{{ model }}<template v-if="usage"> · {{ usage.total_tokens || 0 }} tokens</template></span>
          <button class="small" :disabled="!result" @click="copy">复制</button>
          <button class="small" :disabled="!result" @click="$emit('replace-text', result); open = false">替换正文</button>
          <button class="primary" :disabled="!result" @click="$emit('insert-text', result); open = false">插入到光标处</button>
          <button @click="open = false">关闭</button>
        </div>
      </div>
    </div>
  </span>
</template>

<script setup>
// AI 辅助写作（v1.9.41 插件之一）：总结 / 续写 / 翻译。
// 结果**不落库**，由使用者决定插入还是替换 —— AI 直接改正文是很容易让人丢稿的设计。
import { ref, computed } from 'vue';
import { api } from '../../api';
import { renderMarkdown } from '../../utils/markdown';
import { copyText } from '../../utils/noteShare';

const props = defineProps({
  note: { type: Object, required: true },
  disabled: { type: Boolean, default: false },
  // 翻译优先用选中文本（没有就用全文），由外壳把编辑器的选区喂进来
  getSelection: { type: Function, default: () => '' },
});
const emit = defineEmits(['insert-text', 'replace-text']);

const ACTIONS = [
  { k: 'summarize', t: 'AI 总结', title: '总结这篇笔记的要点（150 字内）' },
  { k: 'continue', t: '续写', title: '顺着正文往下写' },
  { k: 'translate', t: '翻译', title: '翻译成英文（有选中就只翻选中的）' },
];
const labelOf = (k) => (ACTIONS.find((a) => a.k === k) || {}).t || '';

const open = ref(false);
const loading = ref(false);
const cur = ref('');
const result = ref('');
const err = ref('');
const model = ref('');
const usage = ref(null);
const rendered = computed(() => renderMarkdown(result.value || '', { wikiStyle: 'plain' }));

async function run(action) {
  if (props.disabled || loading.value) return;
  cur.value = action;
  loading.value = true;
  err.value = '';
  result.value = '';
  try {
    const body = { action };
    if (action === 'translate') {
      const sel = props.getSelection ? String(props.getSelection() || '') : '';
      if (sel.trim()) body.selection = sel;
    }
    const r = await api.post(`/notes/${props.note.id}/ai-assist`, body);
    result.value = r.result || '';
    model.value = r.model || '';
    usage.value = r.usage || null;
    open.value = true;
  } catch (e) {
    err.value = e.message || 'AI 调用失败';
    open.value = true;
  } finally {
    loading.value = false;
  }
}
async function copy() {
  const ok = await copyText(result.value);
  if (!ok) alert('复制失败，请手动选中复制');
}
</script>

<style scoped>
.ai-wrap { display: inline-flex; gap: 4px; }
</style>
