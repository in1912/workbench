<template>
  <!-- 数字人参考图·固定预览（v1.12.0）：上传的参考图按 sort 叠成一摞卡片，
       默认看最前面那张；点左半边=翻回上一张，点右半边=翻向下一张。
       用途：挑首图（最前面那张=Vivix 建会话的第一张源图=开场白载体）与整体效果预览。 -->
  <div class="dh-deck" :style="{ height: height }">
    <div v-if="!images.length" class="dh-deck-empty">还没有参考图——先在上方上传</div>
    <template v-else>
      <!-- 叠放层：后面的卡片右移+微旋转探出，营造一摞卡片的厚度 -->
      <div v-for="(im, i) in shown" :key="im.id" class="dh-card" :style="cardStyle(i)">
        <img :src="imgSrc(im)" :alt="im.orig_name" loading="lazy" draggable="false" />
        <div v-if="i === shown.length - 1" class="dh-card-tag">
          {{ index + 1 }}/{{ images.length }} · {{ im.orig_name }}
          <i v-if="index === 0" class="front">首图</i>
        </div>
      </div>
      <!-- 左右点击热区（叠在最上层的卡片两侧） -->
      <button class="dh-zone left" :disabled="index === 0" title="上一张" @click.stop="page(-1)">‹</button>
      <button class="dh-zone right" :disabled="index >= images.length - 1" title="下一张" @click.stop="page(1)">›</button>
    </template>
  </div>
</template>

<script setup>
// props.images：dh_images 的公开 DTO（含 url=/api/dh/images/:id/raw，需带 token 的直链走 rawUrl）
import { computed, ref, watch } from 'vue';
import { rawUrl } from '../api';

const props = defineProps({
  images: { type: Array, default: () => [] },
  height: { type: String, default: '300px' },
});

const index = ref(0);
watch(() => props.images, () => { index.value = 0; });

function imgSrc(im) { return rawUrl(im.url); }
function page(d) {
  const n = index.value + d;
  if (n >= 0 && n < props.images.length) index.value = n;
}

// 只渲染窗口附近的卡片（正面 1 张 + 后面探出 3 张），其余不画
const shown = computed(() => {
  const arr = props.images.slice(index.value);
  return arr.slice(0, 4).reverse(); // 反转后正面卡是数组最后一个（最后画、盖在最上）
});
function cardStyle(idxInShown) {
  const depthFromFront = shown.value.length - 1 - idxInShown; // 最后一个=正面卡（depth 0）
  // depthFromFront=0 是当前正面卡；往后每张右移 26px、微转 4°、略暗
  const d = depthFromFront;
  return {
    transform: `translate(${d * 26}px, ${d * 5}px) rotate(${d * 4}deg) scale(${1 - d * 0.03})`,
    filter: d ? `brightness(${1 - d * 0.16})` : 'none',
    zIndex: 10 - d,
    pointerEvents: 'none',
  };
}
</script>

<style scoped>
.dh-deck { position: relative; width: 100%; max-width: 560px; min-height: 200px; user-select: none; }
.dh-deck-empty {
  width: 100%; height: 100%; display: flex; align-items: center; justify-content: center;
  color: var(--muted); font-size: 13px; border: 1px dashed var(--border, rgba(128,128,128,.35));
  border-radius: 14px; padding: 30px 10px;
}
.dh-card {
  position: absolute; inset: 0; border-radius: 14px; overflow: hidden;
  border: 1px solid var(--border, rgba(128,128,128,.3));
  background: var(--card-bg, rgba(128,128,128,.08));
  box-shadow: 0 8px 26px rgba(0,0,0,.28);
  transition: transform .25s, filter .25s;
}
.dh-card img { width: 100%; height: 100%; object-fit: contain; display: block; background: rgba(0,0,0,.22); }
.dh-card-tag {
  position: absolute; left: 10px; bottom: 10px; font-size: 11.5px; color: #fff;
  background: rgba(0,0,0,.55); border-radius: 8px; padding: 3px 9px;
  max-width: calc(100% - 20px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.dh-card-tag .front { font-style: normal; background: rgba(236,100,150,.9); border-radius: 6px; padding: 1px 6px; margin-left: 6px; font-weight: 600; }
/* 左右翻页热区：半透明圆形按钮悬停在卡片两侧 */
.dh-zone {
  position: absolute; top: 50%; transform: translateY(-50%); z-index: 30;
  width: 34px; height: 34px; border-radius: 50%; border: none; cursor: pointer;
  background: rgba(0,0,0,.42); color: #fff; font-size: 20px; line-height: 1;
  display: flex; align-items: center; justify-content: center; transition: background .15s;
}
.dh-zone:hover:not(:disabled) { background: rgba(0,0,0,.66); }
.dh-zone:disabled { opacity: .25; cursor: default; }
.dh-zone.left { left: 8px; }
.dh-zone.right { right: 8px; }
</style>
