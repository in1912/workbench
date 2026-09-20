<!-- 像素宠物画布渲染组件。
     逐像素绘制 pixelPets.buildParts() 组装好的部件，按 z 序叠加；
     动画状态机：idle 呼吸常驻 + 闲置小动作随机调度 + 强制动画队列（喂食/玩耍/吃药等）；
     点击命中检测（头/耳/身体/爪子/尾巴）自动播放对应反应；生病背面模式；成长圈数整体放大；
     自定义 GIF 宠物回退为固定宽高比 <img> 显示。 -->
<template>
  <div v-if="gif" class="pet-gif" :style="gifStyle"><img :src="gif" alt="宠物" /></div>
  <canvas v-else ref="cv" :class="{ clickable: interactive }" @click="onClick"></canvas>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { GRIDS, SPRITES } from '../pets/pixelSprites.js';
import { buildParts, headGridOf, paletteOf, ANIMS, pickIdle, HIT_AREAS, HIT_REACTIONS } from '../pets/pixelPets.js';

const props = defineProps({
  species: { type: String, default: 'dog' },
  variant: { type: Number, default: 0 },
  sick: { type: Boolean, default: false },
  rings: { type: Number, default: 0 },      // 成长圈数（0~6，每圈整体放大 8%）
  gif: { type: String, default: '' },       // 自定义 GIF 地址（设置后不再用画布）
  size: { type: Number, default: 4 },       // 每个逻辑像素的 CSS 尺寸（px）
  interactive: { type: Boolean, default: true },
});
const emit = defineEmits(['hit', 'anim-end']);

// ---- 画布常量（与 scripts/preview-pets.mjs 一致）：宠物坐标原点在左上，地面 y=28 ----
const BASE_W = 42, BASE_H = 40, GROUND = 28, CX = 21;
const FACE_PARTS = ['eyeL', 'eyeR', 'nose', 'mouth', 'muzzle', 'trunk', 'pouch', 'stripeH'];
const dpr = Math.min(2, window.devicePixelRatio || 1);

const cv = ref(null);
let ctx = null, raf = 0;
let parts = [];
// 动画状态（rAF 内部使用，无需响应式）
let forced = null;      // 强制动画 { name, arg, start, end, def }
let idleAnim = null;    // 闲置小动作 { def, start, end }
let nextIdle = 0, nextBlink = 0, blinkUntil = 0;

watch(() => [props.species, props.variant], () => { parts = buildParts(props.species); });
watch(() => props.sick, () => { idleAnim = null; }); // 生病时只播 sickIdle

const gifStyle = computed(() => ({ width: Math.round(42 * props.size) + 'px', height: Math.round(40 * props.size) + 'px' }));

// ---------- 颜色 ----------
function mix(hex, hex2, k) {
  const h = (c) => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  const a = h(hex), b = h(hex2);
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(',')})`;
}
function palOf(flags) {
  const pal = paletteOf(props.species, props.variant);
  if (!flags.pale) return pal;
  const P = {};
  for (const [k, v] of Object.entries(pal)) P[k] = typeof v === 'string' && v[0] === '#' ? mix(v, '#c9cdd4', 0.45) : v;
  return P;
}

// ---------- 位姿合成：idle 基线 +（生病 / 强制 / 闲置小动作）逐层叠加，眨眼最后覆盖 ----------
function poseAt(t) {
  const layers = [ANIMS.idle.fn(0, t)];
  if (props.sick) layers.push(ANIMS.sickIdle.fn(0, t));
  if (forced && t >= forced.end) { const f = forced; forced = null; emit('anim-end', f.name); }
  if (forced) layers.push(forced.def.fn((t - forced.start) / forced.def.dur, t, forced.arg));
  if (idleAnim && t >= idleAnim.end) idleAnim = null;
  if (idleAnim) layers.push(idleAnim.def.fn((t - idleAnim.start) / idleAnim.def.dur, t));
  if (t > nextBlink) { blinkUntil = t + 140; nextBlink = t + 2600 + Math.random() * 3200; }

  const merged = { parts: {}, flags: {}, sprites: [], fx: [] };
  layers.forEach((m, i) => {
    for (const [k, v] of Object.entries(m.parts || {})) {
      const s = merged.parts[k] || (merged.parts[k] = { dx: 0, dy: 0, hide: false });
      s.dx += v.dx || 0; s.dy += v.dy || 0; if (v.hide) s.hide = true;
    }
    if (i > 0) Object.assign(merged.flags, m.flags || {});
    if (m.sprites) merged.sprites.push(...m.sprites);
    if (m.fx) merged.fx.push(...m.fx);
  });
  if (t < blinkUntil && !merged.flags.back && !merged.flags.eyesClosed && !merged.flags.eyesHappy) merged.flags.eyesClosed = true;
  return merged;
}

// ---------- 主循环 ----------
function frame() {
  raf = requestAnimationFrame(frame);
  if (props.gif || !cv.value) return;
  if (!ctx) ctx = cv.value.getContext('2d');
  if (!parts.length) parts = buildParts(props.species);

  // 闲置小动作调度：每 5~9 秒随机一个（强制动画 / 生病期间跳过）
  const now = performance.now();
  if (now > nextIdle && !forced && !props.sick) {
    const def = ANIMS[pickIdle()];
    idleAnim = { def, start: now, end: now + def.dur };
    nextIdle = now + 5000 + Math.random() * 4000;
  }

  const { parts: pose, flags, sprites, fx } = poseAt(now);
  const scale = 1 + (props.rings || 0) * 0.08;
  const W = Math.max(1, Math.ceil(BASE_W * scale)), H = Math.max(1, Math.ceil(BASE_H * scale));
  const ps = props.size;
  const bw = Math.round(W * ps * dpr), bh = Math.round(H * ps * dpr);
  if (cv.value.width !== bw || cv.value.height !== bh) { cv.value.width = bw; cv.value.height = bh; }
  cv.value.style.width = Math.round(W * ps) + 'px';
  cv.value.style.height = Math.round(H * ps) + 'px';
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, bw, bh);

  // 宠物坐标 → 位图像素（取整，保证硬像素无缝）
  const toX = (v) => Math.round((W / 2 + (v - CX) * scale) * ps * dpr);
  const toY = (v) => Math.round((H - 6 + (v - GROUND) * scale) * ps * dpr);
  const px = (x, y, w = 1, h = 1) =>
    ctx.fillRect(toX(x), toY(y), Math.max(1, toX(x + w) - toX(x)), Math.max(1, toY(y + h) - toY(y)));

  // 地面阴影
  ctx.fillStyle = 'rgba(60,50,40,0.16)';
  ctx.beginPath();
  ctx.ellipse((toX(CX - 11) + toX(CX + 11)) / 2, toY(GROUND + 1.4), 11 * scale * ps * dpr, 1.5 * ps * dpr, 0, 0, Math.PI * 2);
  ctx.fill();

  // 部件（buildParts 已按 z 序排好）
  const P = palOf(flags);
  const back = !!flags.back;
  const drawGrid = (grid, x, y, pal, alpha) => {
    if (alpha != null) ctx.globalAlpha = alpha;
    for (let gy = 0; gy < grid.length; gy++) {
      const row = grid[gy];
      for (let gx = 0; gx < row.length; gx++) {
        const c = row[gx];
        if (c === '.') continue;
        const col = pal[c];
        if (!col) continue;
        ctx.fillStyle = col;
        px(x + gx, y + gy);
      }
    }
    if (alpha != null) ctx.globalAlpha = 1;
  };

  for (const part of parts) {
    const m = pose[part.name] || {};
    if (m.hide || (back && FACE_PARTS.includes(part.name))) continue;
    let grid = part.grid;
    if (part.name === 'head') grid = back ? GRIDS.headBack : headGridOf(props.species);
    else if (part.name === 'eyeL' || part.name === 'eyeR') grid = flags.eyesHappy ? GRIDS.eyeHappy : flags.eyesClosed ? GRIDS.eyeClosed : GRIDS.eye;
    else if (part.name === 'mouth') grid = flags.mouthOpen ? GRIDS.mouthOpen : GRIDS.mouth;
    let dx = m.dx || 0, dy = m.dy || 0;
    if ((part.name === 'eyeL' || part.name === 'eyeR') && flags.eyesShift) dx += Math.round(flags.eyesShift);
    drawGrid(grid, part.x + dx, part.y + dy, P);
  }
  // 腮红 / 怒眉（画在脸部件之后）
  if (!back && flags.blush) { ctx.globalAlpha = 0.6; ctx.fillStyle = P.p; px(4, 10, 2, 1); px(14, 10, 2, 1); ctx.globalAlpha = 1; }
  if (!back && flags.angry) { ctx.fillStyle = P.k; px(6, 4, 2, 1); px(11, 4, 2, 1); }

  // 动画精灵（食物/玩具）与特效（爱心/音符…）
  for (const s of [...sprites, ...fx]) {
    const sp = SPRITES[s.key];
    if (sp) drawGrid(sp.grid, s.x, s.y, sp.palette, s.alpha);
  }
}

// ---------- 点击命中检测 ----------
function onClick(e) {
  if (!props.interactive || props.gif || !cv.value) return;
  const rect = cv.value.getBoundingClientRect();
  const scale = 1 + (props.rings || 0) * 0.08;
  const W = Math.max(1, Math.ceil(BASE_W * scale)), H = Math.max(1, Math.ceil(BASE_H * scale));
  const lx = CX + ((e.clientX - rect.left) / props.size - W / 2) / scale;
  const ly = GROUND + ((e.clientY - rect.top) / props.size - (H - 6)) / scale;
  for (const a of HIT_AREAS) {
    if (lx >= a.x0 && lx <= a.x1 && ly >= a.y0 && ly <= a.y1) {
      emit('hit', a.name, a.label);
      if (!forced && HIT_REACTIONS[a.name]) playAnim(HIT_REACTIONS[a.name]);
      return;
    }
  }
  emit('hit', 'miss', '');
}

// ---------- 对外 API ----------
/** 播放指定动画（ANIMS key），可带参数（如 feed 的 rice/banana）；返回动画时长后 resolve 的 Promise */
function playAnim(name, arg) {
  const def = ANIMS[name];
  if (!def || !def.dur || props.gif) return Promise.resolve(false);
  idleAnim = null;
  const start = performance.now();
  forced = { name, arg, start, end: start + def.dur, def };
  return new Promise((resolve) => setTimeout(() => resolve(true), def.dur));
}
function stopAnim() { forced = null; idleAnim = null; }
defineExpose({ playAnim, stopAnim });

onMounted(() => {
  parts = buildParts(props.species);
  raf = requestAnimationFrame(frame);
});
onBeforeUnmount(() => cancelAnimationFrame(raf));
</script>

<style scoped>
canvas { display: block; }
canvas.clickable { cursor: pointer; }
.pet-gif { display: flex; align-items: flex-end; justify-content: center; }
.pet-gif img { max-width: 100%; max-height: 100%; }
</style>
