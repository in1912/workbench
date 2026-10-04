<template>
  <div class="outline">
    <div v-for="(h, i) in headings" :key="i" class="oh" :style="{ paddingLeft: (h.level - 1) * 10 + 6 + 'px' }"
         :title="h.text" @click="$emit('go', i)">{{ h.text }}</div>
    <div v-if="!headings.length" class="muted small" style="padding:6px">正文里还没有标题（用 # 开头写一行）</div>
  </div>
</template>

<script setup>
// 大纲（v1.9.41）：只列 H1–H6，点击让预览滚到对应位置。
defineProps({ headings: { type: Array, default: () => [] } });
defineEmits(['go']);
</script>

<style scoped>
.outline { max-height: 100%; overflow-y: auto; }
.oh { font-size: 12.5px; padding: 3px 6px; border-radius: 5px; cursor: pointer; color: var(--text2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oh:hover { background: var(--bg3); color: var(--text); }
</style>
