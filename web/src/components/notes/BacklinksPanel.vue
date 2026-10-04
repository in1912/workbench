<template>
  <div class="bl">
    <section v-if="links.out?.length">
      <div class="hd">链接到（{{ links.out.length }}）</div>
      <a v-for="l in links.out" :key="'o' + l.id" class="li" href="javascript:;" @click="$emit('open', l.id)">{{ l.title || ('#' + l.id) }}</a>
    </section>
    <section v-if="links.in?.length">
      <div class="hd">被引用（{{ links.in.length }}）</div>
      <a v-for="l in links.in" :key="'i' + l.id" class="li" href="javascript:;" @click="$emit('open', l.id)">{{ l.title || ('#' + l.id) }}</a>
    </section>
    <section v-if="links.unresolved?.length">
      <div class="hd">未解析（{{ links.unresolved.length }}）</div>
      <div class="muted small" style="margin-bottom:4px">这些 [[标题]] 还没有对应的笔记，点一下就能建。</div>
      <a v-for="u in links.unresolved" :key="'u' + u.title" class="li miss" href="javascript:;" @click="$emit('create', u.title)">{{ u.title }} ＋</a>
    </section>
    <section v-if="links.unresolved_in?.length">
      <div class="hd">待建立的反向链（{{ links.unresolved_in.length }}）</div>
      <div class="muted small" style="margin-bottom:4px">别的笔记写了 [[{{ noteTitle }}]]，但标题还对不上。</div>
      <a v-for="u in links.unresolved_in" :key="'ui' + u.id" class="li miss" href="javascript:;" @click="$emit('open', u.id)">
        {{ u.title || ('#' + u.id) }} → {{ noteTitle }}
      </a>
    </section>
    <div v-if="empty" class="muted small">没有双向链接。正文里写 [[另一篇的标题]] 就会出现在这里。</div>
  </div>
</template>

<script setup>
// 出链 / 反链 / 未解析链接（v1.9.41）。
// 特意把「未解析」显式列出来：老版本是写完就丢，用户根本不知道自己写错过标题。
import { computed } from 'vue';

const props = defineProps({
  links: { type: Object, default: () => ({ out: [], in: [], unresolved: [], unresolved_in: [] }) },
  noteTitle: { type: String, default: '' },
});
defineEmits(['open', 'create']);

const empty = computed(() => {
  const l = props.links || {};
  return !(l.out?.length || l.in?.length || l.unresolved?.length || l.unresolved_in?.length);
});
</script>

<style scoped>
.bl { max-height: 100%; overflow-y: auto; }
section { margin-bottom: 10px; }
.hd { font-size: 11.5px; color: var(--text3); margin-bottom: 4px; }
.li { display: block; font-size: 12.5px; padding: 3px 6px; border-radius: 5px; color: var(--accent); text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.li:hover { background: var(--bg3); }
.li.miss { color: var(--text2); }
</style>
