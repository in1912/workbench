<template>
  <div class="splitter" :class="{ dragging }" @pointerdown="start" @dblclick="$emit('update:modelValue', defaultWidth)">
    <span class="grip" />
  </div>
</template>

<script setup>
// 分栏拖拽条（v1.9.41）。只负责「拖了多少像素」，宽度怎么夹取由父级决定。
// 用 Pointer Events 而不是 mouse*：触屏笔记本 / 平板上也能拖。
import { ref } from 'vue';

const props = defineProps({
  modelValue: { type: Number, default: 260 },
  min: { type: Number, default: 180 },
  max: { type: Number, default: 640 },
  defaultWidth: { type: Number, default: 260 },
  // 右侧栏：往左拖 = 变宽，所以 delta 取反
  invert: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue', 'done']);

const dragging = ref(false);

function start(e) {
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();
  const startX = e.clientX;
  const startW = props.modelValue;
  const el = e.currentTarget;
  dragging.value = true;
  try { el.setPointerCapture(e.pointerId); } catch { /* 老浏览器没有就算了 */ }
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';

  const move = (ev) => {
    const raw = (ev.clientX - startX) * (props.invert ? -1 : 1) + startW;
    emit('update:modelValue', Math.max(props.min, Math.min(props.max, Math.round(raw))));
  };
  const up = () => {
    dragging.value = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    emit('done');
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}
</script>

<style scoped>
.splitter {
  width: 6px; flex: 0 0 6px; cursor: col-resize; position: relative;
  border-radius: 3px; touch-action: none;
}
.splitter:hover, .splitter.dragging { background: var(--accent); opacity: .45; }
.grip { position: absolute; inset: 40% 2px; border-radius: 2px; background: var(--border); }
.splitter:hover .grip, .splitter.dragging .grip { background: transparent; }
</style>
