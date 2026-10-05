<template>
  <div ref="cardEl" class="card graph-card" :style="boxH ? { height: boxH + 'px' } : {}">
    <h3>
      关系图
      <span style="display:flex; gap:6px; align-items:center">
        <span class="muted" style="font-weight:400">{{ nodes.length }} 个节点 · {{ edges.length }} 条关联</span>
        <button class="small" @click="reload">重新布局</button>
      </span>
    </h3>

    <div class="legend">
      <span v-for="(c, t) in COLORS" :key="t" class="lg">
        <i :style="{ background: c }"></i>{{ ENTITY_LABEL[t] || t }}
      </span>
      <span class="grow"></span>
      <span class="muted">滚轮缩放 · 拖动平移 · 点节点看它连了谁</span>
    </div>

    <div ref="wrap" class="canvas-wrap">
      <canvas ref="cv" @wheel.prevent="onWheel" @mousedown="onDown"></canvas>
      <div v-if="!loading && !nodes.length" class="empty" style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center">
        还没有任何关联<br /><span class="muted">去目标/行动/笔记上连几条，这里就会长出来</span>
      </div>
      <div v-if="loading" class="empty" style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center">正在算布局…</div>
    </div>

    <div v-if="picked" class="pick">
      <span class="badge blue">{{ ENTITY_LABEL[picked.type] || picked.type }}</span>
      <b>{{ picked.title || ('#' + picked.id) }}</b>
      <span class="muted">关联 {{ picked.degree }} 条（收到 {{ picked.in_degree }} / 发出 {{ picked.out_degree }}）</span>
      <span class="grow"></span>
      <button class="small" @click="picked = null">关闭</button>
    </div>
    <div class="muted foot" style="margin-top:8px">
      孤立的点（一条关联都没有）不会出现在这里——它们恰恰说明有些东西还被你单独搁着，没接到任何目标上。
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount, nextTick, inject } from 'vue';
import { api } from '../../api';
import { ENTITY_LABEL } from './lifeUtils';

const emit = defineEmits(['toast']);
const wrap = ref(null);
const cv = ref(null);
const cardEl = ref(null);
const boxH = ref(0);
const nodes = ref([]);
const edges = ref([]);
const loading = ref(true);
const picked = ref(null);

const COLORS = {
  goal: '#4f7cf7', task: '#34d399', project: '#fbbf24', habit: '#a78bfa',
  note: '#9aa4b2', domain: '#f87171', sop: '#22d3ee', kr: '#6366f1',
  review: '#fb923c', bill: '#e879f9', family: '#f472b6', kid: '#facc15',
  skill: '#4ade80', file: '#94a3b8',
};
const colorOf = (t) => COLORS[t] || '#94a3b8';

let view = { x: 0, y: 0, k: 1 };
let hover = null;
let dragging = null;
let raf = 0;

// ---------- 布局：手写力导向，不引第三方库 ----------
// 引 d3-force 只是省 100 行代码，却要给升级包多带一个依赖（应用内升级不跑 npm install），
// 而这里的量级（个人库几百个节点）用最朴素的 O(n²) 斥力完全够。
function layout(ns, es, w, h) {
  const N = ns.length;
  if (N > 600) {
    // 节点太多时不做 n² 斥力，直接撒成同心环，保证画得出来也不卡
    ns.forEach((n, i) => {
      const a = (i / N) * Math.PI * 2, r = Math.min(w, h) * 0.38;
      n.x = w / 2 + Math.cos(a) * r; n.y = h / 2 + Math.sin(a) * r;
    });
    return;
  }
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2, r = Math.min(w, h) * 0.3;
    ns[i].x = w / 2 + Math.cos(a) * r + (Math.random() - 0.5) * 12;
    ns[i].y = h / 2 + Math.sin(a) * r + (Math.random() - 0.5) * 12;
  }
  const idx = new Map(ns.map((n, i) => [n.key, i]));
  const links = es.map((e) => ({ a: idx.get(e.source), b: idx.get(e.target) })).filter((l) => l.a !== undefined && l.b !== undefined);
  const REP = 5200, SPRING = 0.012, LEN = 92, CENTER = 0.006;
  for (let it = 0; it < 320; it++) {
    // 斥力
    for (let i = 0; i < N; i++) {
      const a = ns[i];
      for (let j = i + 1; j < N; j++) {
        const b = ns[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const f = REP / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f, fy = (dy / d) * f;
        a.x += fx; a.y += fy; b.x -= fx; b.y -= fy;
      }
    }
    // 弹簧
    for (const l of links) {
      const a = ns[l.a], b = ns[l.b];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const f = (d - LEN) * SPRING;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.x += fx; a.y += fy; b.x -= fx; b.y -= fy;
    }
    // 向心
    for (const n of ns) { n.x += (w / 2 - n.x) * CENTER; n.y += (h / 2 - n.y) * CENTER; }
  }
}

// v1.10.21：画布高度不再按宽度折算、不再封 560px —— 卡片整体量出自己离视口顶部多远，
// 高度 = innerHeight - top - 26（和领域面板 measure() 同一套）。.graph-card 是纵向 flex，
// 标题/图例/选中信息条固定高，剩下的全给画布（.canvas-wrap flex:1）。
function measure() {
  const el = cardEl.value;
  if (!el) return;
  const top = el.getBoundingClientRect().top;
  const h = Math.max(360, Math.round(window.innerHeight - top - 26));
  if (h !== boxH.value) boxH.value = h;
}

function fit() {
  const el = wrap.value;
  if (!el) return { w: 600, h: 420 };
  return { w: el.clientWidth || 600, h: Math.max(320, el.clientHeight || 420) };
}

function draw() {
  const c = cv.value, el = wrap.value;
  if (!c || !el) return;
  const { w, h } = fit();
  const dpr = window.devicePixelRatio || 1;
  c.width = w * dpr; c.height = h * dpr;
  c.style.width = w + 'px'; c.style.height = h + 'px';
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.save();
  ctx.translate(view.x, view.y);
  ctx.scale(view.k, view.k);

  const pos = new Map(nodes.value.map((n) => [n.key, n]));
  const isHot = (key) => hover && (hover === key || edges.value.some((e) =>
    (e.source === hover && e.target === key) || (e.target === hover && e.source === key)));

  // 先线后点
  for (const e of edges.value) {
    const a = pos.get(e.source), b = pos.get(e.target);
    if (!a || !b) continue;
    const hot = hover && (e.source === hover || e.target === hover);
    ctx.strokeStyle = hot ? 'rgba(79,124,247,.85)' : 'rgba(148,163,184,.28)';
    ctx.lineWidth = hot ? 1.8 : 1;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  for (const n of nodes.value) {
    const r = 3.5 + 2.2 * Math.log2(1 + n.degree);
    ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = colorOf(n.type);
    ctx.globalAlpha = hover && !isHot(n.key) ? 0.25 : 1;
    ctx.fill();
    if (n.type === 'goal') { ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.globalAlpha = ctx.globalAlpha * 0.6; ctx.stroke(); }
    ctx.globalAlpha = 1;
  }
  // 标签：整体放大或悬停时才画，否则一团糊
  if (view.k > 0.75 || hover) {
    ctx.font = '11px system-ui, sans-serif';
    ctx.textAlign = 'center';
    for (const n of nodes.value) {
      if (view.k <= 0.75 && !isHot(n.key)) continue;
      const t = (n.title || '').slice(0, 12) || `#${n.id}`;
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillText(t, n.x + 1, n.y - (3.5 + 2.2 * Math.log2(1 + n.degree)) - 4);
      ctx.fillStyle = isHot(n.key) ? '#fff' : 'rgba(226,232,240,.9)';
      ctx.fillText(t, n.x, n.y - (3.5 + 2.2 * Math.log2(1 + n.degree)) - 5);
    }
  }
  ctx.restore();
}

function hit(mx, my) {
  const wx = (mx - view.x) / view.k, wy = (my - view.y) / view.k;
  let best = null, bd = 1e9;
  for (const n of nodes.value) {
    const d = Math.hypot(n.x - wx, n.y - wy);
    const r = 3.5 + 2.2 * Math.log2(1 + n.degree) + 6;
    if (d < r && d < bd) { bd = d; best = n; }
  }
  return best;
}

let panning = null;
function onDown(e) {
  const rect = cv.value.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const n = hit(mx, my);
  if (n) { picked.value = n; hover = n.key; draw(); return; }
  panning = { mx, my, ox: view.x, oy: view.y, moved: false };
  picked.value = null;
  const move = (ev) => {
    if (!panning) return;
    panning.moved = true;
    view.x = panning.ox + (ev.clientX - rect.left - panning.mx);
    view.y = panning.oy + (ev.clientY - rect.top - panning.my);
    draw();
  };
  const up = () => { panning = null; window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function onWheel(e) {
  const rect = cv.value.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const k2 = Math.max(0.15, Math.min(6, view.k * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
  // 以光标为中心缩放：保持光标下的世界坐标不动
  view.x = mx - ((mx - view.x) / view.k) * k2;
  view.y = my - ((my - view.y) / view.k) * k2;
  view.k = k2;
  draw();
}

function onMove(e) {
  const rect = cv.value.getBoundingClientRect();
  const n = hit(e.clientX - rect.left, e.clientY - rect.top);
  const k = n ? n.key : null;
  if (k !== hover) { hover = k; draw(); }
}

async function reload() {
  loading.value = true;
  try {
    const g = await api.get('/life/links');
    nodes.value = g.nodes;
    edges.value = g.edges;
    await nextTick();
    const { w, h } = fit();
    layout(nodes.value, edges.value, w, h);
    view = { x: 0, y: 0, k: 1 };
    picked.value = null;
    draw();
  } catch (e) {
    emit('toast', e.message, 'err');
  } finally {
    loading.value = false;
  }
}

const onResize = () => { if (nodes.value.length) { measure(); const { w, h } = fit(); layout(nodes.value, edges.value, w, h); draw(); } };

// v1.10.21：本页全页自适应（不封 1200px 宽、画布撑满到视口底部）。App.vue 的 .main 默认
// 1200px 封顶，这里挂载时打开不限宽开关、卸载时关掉 —— 切到别的页签 / 离开 /life 时本面板
// 必然卸载（Life.vue 是 v-else-if 链）；inject 拿不到就静默跳过，样式退回封顶。
const mainFull = inject('wbMainFull', null);

let ro = null;
onMounted(() => {
  if (mainFull) mainFull.value = true;   // 本页不限宽（见 inject 处注释）
  measure();
  reload();
  window.addEventListener('resize', onResize);
  cv.value.addEventListener('mousemove', onMove);
  // 父容器尺寸一变（toast 把标签栏顶下去、字体变化）就重量高度；只重画不重排 ——
  // toast 只挪几十像素，整图重新布局会让节点每次提示都洗一次牌。
  if (typeof ResizeObserver !== 'undefined' && cardEl.value?.parentElement) {
    ro = new ResizeObserver(() => { measure(); draw(); });
    ro.observe(cardEl.value.parentElement);
  }
});
onBeforeUnmount(() => {
  if (mainFull) mainFull.value = false;
  window.removeEventListener('resize', onResize);
  if (cv.value) cv.value.removeEventListener('mousemove', onMove);
  if (ro) { ro.disconnect(); ro = null; }
  cancelAnimationFrame(raf);
});
</script>

<style scoped>
/* v1.10.21：整卡纵向 flex + 外层量高（measure() 给 :style 高度）—— 标题/图例/选中条固定高，
   画布拿走剩下的全部高度；不写死 calc(100vh - Npx) 就不会被「上面多了条 toast」这类偏移坑到。 */
.graph-card { display: flex; flex-direction: column; min-height: 0; }
.graph-card h3, .legend, .pick, .foot { flex: 0 0 auto; }
.canvas-wrap { position: relative; width: 100%; flex: 1 1 auto; min-height: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
canvas { display: block; cursor: grab; }
.legend { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 10px; font-size: 12px; color: var(--text2); }
.lg { display: inline-flex; align-items: center; gap: 4px; }
.lg i { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.pick { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; }
</style>
