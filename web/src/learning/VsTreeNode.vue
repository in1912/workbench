<template>
  <div class="node">
    <div class="row" :class="entry.kind" @click="click">
      <span v-if="entry.is_dir" class="ico">{{ open ? '📂' : '📁' }}</span>
      <span v-else class="ico">{{ icon }}</span>
      <span class="name" :title="entry.name">{{ entry.name }}</span>
    </div>
    <div v-if="entry.is_dir && open" class="children">
      <div v-if="loading" class="muted ld">加载中…</div>
      <div v-else-if="error" class="muted ld err">{{ error }}</div>
      <template v-else>
        <VsTreeNode v-for="c in children" :key="c.name" :entry="c" :parent="childPath" />
        <div v-if="!children.length" class="muted ld">（空目录）</div>
      </template>
    </div>
  </div>
</template>

<script setup>
// 目录树节点：懒加载展开；文件点击回调经 provide/inject 注入（递归组件逐层 emit 太啰嗦）
import { computed, inject, ref } from 'vue';
import { api } from '../api';

const props = defineProps({ entry: Object, parent: String });
const selectFile = inject('vstudySelectFile');
const open = ref(false);
const loading = ref(false);
const error = ref('');
const children = ref([]);

const childPath = computed(() => (props.parent ? props.parent + '/' + props.entry.name : props.entry.name));
const icon = computed(() => ({ media: '🎬', doc: '📄', other: '·' })[props.entry.kind] || '·');

async function click() {
  if (!props.entry.is_dir) {
    if (props.entry.kind !== 'other') selectFile(childPath.value, props.entry);
    return;
  }
  open.value = !open.value;
  if (open.value && !children.value.length && !error.value) {
    loading.value = true;
    try {
      const r = await api.get('/vstudy/tree?dir=' + encodeURIComponent(childPath.value));
      children.value = r.entries || [];
    } catch (e) { error.value = e.message; }
    loading.value = false;
  }
}
</script>

<style scoped>
.node { font-size: 13px; }
.row { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 6px; cursor: pointer; }
.row:hover { background: var(--bg3); }
.row .ico { flex-shrink: 0; }
.row .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row.media .name { color: var(--text); }
.row.doc .name { color: var(--text2); }
.row.other { opacity: .4; cursor: default; }
.children { margin-left: 14px; border-left: 1px dashed var(--border); padding-left: 4px; }
.ld { padding: 3px 6px; font-size: 12px; }
.ld.err { color: var(--red); }
</style>
