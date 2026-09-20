<!-- 像素十字架墓碑：宠物去世后替代本体展示（宠物页卡片 + 悬浮窗共用）。
     与 PixelPet 同款 canvas 像素画法；底部一圈土丘，十字架浅灰描边。 -->
<template>
  <div class="px-cross" :style="{ width: 22 * size + 'px', height: 20 * size + 'px' }">
    <canvas ref="cvs"></canvas>
  </div>
</template>

<script setup>
import { onMounted, ref } from 'vue';

const props = defineProps({ size: { type: Number, default: 2 } });
const cvs = ref(null);

// 12 列 × 13 行：十字架（上）+ 土丘（下）；. 透明 / g 石灰岩 / d 石灰岩暗部 / w 高光 / s 土 / t 草
const GRID = [
  '....gggg....',
  '....gwwg....',
  '....gwwg....',
  'gggggwwggggg',
  'gwwgwwwwgwwg',
  'gddggwwggddg',
  'gggggwwggggg',
  '....gwwg....',
  '....gddg....',
  '....gddg....',
  '..ssssssss..',
  '.stttttttts.',
  '..ssssssss..',
];
const PAL = { g: '#9aa3ad', d: '#6d747c', w: '#c9d2da', s: '#6b4a33', t: '#5d9e58' };

onMounted(() => {
  const c = cvs.value;
  c.width = GRID[0].length * props.size;
  c.height = GRID.length * props.size;
  const g = c.getContext('2d');
  GRID.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === '.') return;
    g.fillStyle = PAL[ch] || '#9aa3ad';
    g.fillRect(x * props.size, y * props.size, props.size, props.size);
  }));
});
</script>

<style scoped>
.px-cross { display: flex; align-items: center; justify-content: center; opacity: 0.92;
  animation: cross-fade 2.4s ease-in-out infinite; }
@keyframes cross-fade { 0%, 100% { opacity: .92 } 50% { opacity: .72 } }
</style>
