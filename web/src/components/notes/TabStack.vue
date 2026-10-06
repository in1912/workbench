<template>
  <div class="tabstack" :class="{ vertical }">
    <div v-for="t in tabs" :key="t.key" class="tab" :class="{ active: t.key === activeKey }"
         :title="t.title" @click="activate(t.key)" @auxclick.middle.prevent="askClose(t)">
      <span class="ico">{{ iconOf(t) }}</span>
      <span class="name">{{ t.title || '未命名' }}</span>
      <span v-if="t.dirty" class="dot" title="未保存">•</span>
      <button class="x" title="关闭" @click.stop="askClose(t)">×</button>
    </div>
    <div v-if="!tabs.length" class="none muted">{{ vertical ? '没有打开的页签' : '' }}</div>
  </div>
</template>

<script setup>
// 标签页条（v1.9.41）：顶部横向 / 右栏竖向共用同一份列表（useNotesTabs 单例）。
import { useNotesTabs } from '../../composables/useNotesTabs';

defineProps({ vertical: { type: Boolean, default: false } });
const emit = defineEmits(['closed']);

const { tabs, activeKey, activate, close } = useNotesTabs();

const ICONS = { note: '📄', rec: '🎙', graph: '🕸', timeline: '🕒', query: '🗃', stats: '📊', board: '🧩', help: '❓' };
const iconOf = (t) => ICONS[t.kind] || '📄';

function askClose(t) {
  if (t.dirty && !confirm(`「${t.title || '未命名'}」还没保存，仍然关闭？`)) return;
  close(t.key);
  emit('closed', t);
}
</script>

<style scoped>
.tabstack { display: flex; gap: 4px; overflow-x: auto; align-items: stretch; }
.tabstack.vertical { flex-direction: column; overflow-x: hidden; overflow-y: auto; gap: 2px; }
.tab {
  display: flex; align-items: center; gap: 6px; flex: 0 0 auto;
  /* v1.10.34：半框（上/左/右有线、底边不闭合、上圆角）改全框闭合线条，其余形态不动 */
  padding: 5px 8px; font-size: 12.5px; border-radius: 8px;
  border: 1px solid var(--border); cursor: pointer;
  background: var(--bg2); color: var(--text2); max-width: 200px;
}
.tabstack.vertical .tab { max-width: none; }
.tab:hover { color: var(--text); }
.tab.active { background: var(--bg3); color: var(--text); border-color: var(--accent); }
.tab .ico { font-size: 12px; }
.tab .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tab .dot { color: var(--amber); font-size: 16px; line-height: 0; }
.tab .x {
  border: none; background: none; color: var(--text3); cursor: pointer;
  font-size: 14px; line-height: 1; padding: 0 2px; border-radius: 4px;
}
.tab .x:hover { background: var(--red); color: #fff; }
.none { padding: 8px; }
</style>
