<template>
  <div class="nlist">
    <div v-for="n in notes" :key="n.id" class="list-item" :class="{ active: n.id === activeNoteId }"
         :style="{ borderRadius: '8px', padding: '8px 10px', cursor: 'pointer' }"
         @click="$emit('open-note', n)"
         @contextmenu.prevent="$emit('menu', n, $event)">
      <div class="grow">
        <div class="t">{{ n.daily_date ? '📅 ' : (n.record_id ? '🎙 ' : '') }}{{ n.title || '未命名' }}</div>
        <div class="meta">{{ labelOf(n) }} · {{ String(n.updated_at || '').slice(5, 16) }}</div>
        <div v-if="tagsOf(n).length" class="meta" style="margin-top:3px">
          <span v-for="t in tagsOf(n).slice(0, 6)" :key="t" class="tag" style="font-size:10.5px; margin-right:4px">{{ t }}</span>
          <span v-if="tagsOf(n).length > 6" class="muted" style="font-size:10.5px">+{{ tagsOf(n).length - 6 }}</span>
        </div>
      </div>
      <span v-if="n.bookmarked" class="star" title="已加书签">★</span>
    </div>
    <div v-if="!notes.length" class="empty">{{ emptyText || '还没有笔记' }}</div>
  </div>
</template>

<script setup>
// 扁平笔记列表（v1.9.41）：沿用老版 list-item 的外观，保证视觉不突变。
// 列表接口返回的 tags 是逗号串（后端为兼容老调用方保留的形状），详情里才是数组，这里两种都认。
defineProps({
  notes: { type: Array, default: () => [] },
  activeNoteId: { type: [Number, null], default: null },
  emptyText: { type: String, default: '' },
  labelOf: { type: Function, default: (n) => n.folder_path || n.category || '' },
});
defineEmits(['open-note', 'menu']);

const tagsOf = (n) => (Array.isArray(n.tags) ? n.tags : String(n.tags || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
</script>

<style scoped>
.nlist { display: flex; flex-direction: column; }
.nlist .list-item { display: flex; align-items: center; gap: 8px; }
.nlist .list-item .t { font-size: 13.5px; }
.nlist .list-item .meta { font-size: 11.5px; color: var(--text2); margin-top: 2px; }
.nlist .list-item.active { background: var(--bg3); }
.star { color: var(--amber); font-size: 12px; }
</style>
