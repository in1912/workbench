<template>
  <div class="gv">
    <!-- 紧凑态（右栏「图谱」页签）：只画「本篇 + 邻居」，工具栏换成一跳/两跳与适配 -->
    <div v-if="compact" class="gtop">
      <button class="small" :class="{ on: depth === 1 }" title="只画直接相连的笔记" @click="setDepth(1)">1 跳</button>
      <button class="small" :class="{ on: depth === 2 }" title="再往外一层" @click="setDepth(2)">2 跳</button>
      <button class="small" :disabled="!viewNodes.length" @click="fit">适配</button>
      <button class="small" title="打开整页图谱（也能从左边栏的「图谱」进）" @click="$emit('open-full')">全屏</button>
      <span class="muted small" style="margin-left:auto">
        {{ viewNodes.length }} 点 / {{ viewEdges.length }} 边{{ truncated ? '（已截断）' : '' }}
      </span>
    </div>

    <div v-else class="gtop">
      <input v-model="q" placeholder="只看标题/正文含…" style="width:170px" @keyup.enter="reload">
      <select v-model="folderId" style="width:150px" @change="reload">
        <option value="">全部文件夹</option>
        <option v-for="f in folders" :key="f.id" :value="f.id">{{ '　'.repeat(f.depth) }}{{ f.name }}</option>
      </select>
      <button class="small" @click="reload">查询</button>
      <span class="sep" />
      <button class="small" :class="{ on: islandOnly }" :disabled="!islandCount" @click="islandOnly = !islandOnly; applyView()">
        只看孤岛（{{ islandCount }}）
      </button>
      <button class="small" :disabled="!hubCount" @click="focusHubs">居中集散点（{{ hubCount }}）</button>
      <button v-if="focusId" class="small" @click="clearFocus">← 退出聚焦</button>
      <button class="small" @click="releaseAll">释放钉住</button>
      <button class="small" :disabled="!viewNodes.length" @click="fit">适配窗口</button>
      <span class="muted small" style="margin-left:auto">
        {{ viewNodes.length }} 点 / {{ viewEdges.length }} 边{{ truncated ? '（已按上限截断）' : '' }}
      </span>
    </div>

    <div class="gwrap" ref="wrapEl">
      <canvas ref="cv" @wheel.prevent="onWheel" @pointerdown="onDown" @pointermove="onMove"
              @pointerup="onUp" @pointerleave="onUp" @dblclick="onDblClick" />
      <div v-if="hoverTip" class="tip" :style="{ left: hoverTip.x + 'px', top: hoverTip.y + 'px' }">{{ hoverTip.text }}</div>
      <div v-if="loading" class="center-hint">载入中…</div>
      <div v-else-if="!viewNodes.length" class="center-hint">
        没有可画的节点。正文里写 <code>[[另一篇的标题]]</code> 就会连起来。
      </div>
      <!-- 只有自己一个点（一条链接都没有）：点照画（空心=孤岛），但上面补一句怎么连起来更好 -->
      <div v-else-if="compact && !viewEdges.length" class="lonely-hint">
        这篇还没有链接：正文里写 <code>[[另一篇的标题]]</code> 就会连起来
      </div>
      <div class="glegen">
        <span v-for="g in groups" :key="g" class="lg"><i :style="{ background: colorOf(g, groups) }" />{{ g }}</span>
        <span v-if="islandCount" class="lg"><i class="hollow" />孤岛（无链接）</span>
        <span v-if="hubCount" class="lg"><i class="ring" />集散点（度数前 10%）</span>
      </div>
    </div>
  </div>
</template>

<script setup>
// 知识图谱（v1.9.41）：d3-force 算布局 + 自己用 Canvas 2D 画。
//
// 为什么不用现成的图组件：我们要的语义（孤岛空心、集散点加环、悬停压暗其余、双击聚焦）
// 都要自己接管渲染循环才顺；d3-force 只出坐标，画的方式由我们定。Canvas 撑得住几千点，SVG 不行。
//
// 布局跑完 300 tick 就 stop()，静止时不吃 CPU；只有拖拽/数据变化才重启。
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide } from 'd3-force';
import { api } from '../../api';
import { buildAdjacency, degreeStats, subgraph, colorOf as hueOf, collectGroups } from '../../utils/graphData';

const props = defineProps({
  folders: { type: Array, default: () => [] },
  focusNoteId: { type: [Number, null], default: null },
  // 紧凑态：右栏「图谱」页签用。取数换成 GET /notes/graph/local/:id（服务端只回「本篇 + N 跳邻居」），
  // 工具栏收成「1 跳/2 跳/适配/全屏」，双击不再改聚焦（本来就是局部图）。
  compact: { type: Boolean, default: false },
});
const emit = defineEmits(['open-note', 'open-full']);

const colorOf = hueOf;
const wrapEl = ref(null);
const cv = ref(null);
const q = ref('');
const folderId = ref('');
const loading = ref(false);
const truncated = ref(false);
const baseNodes = ref([]);
const baseEdges = ref([]);
const viewNodes = ref([]);
const viewEdges = ref([]);
const islandOnly = ref(false);
const focusId = ref(props.focusNoteId || null);
const depth = ref(1);
const hoverTip = ref(null);

const groups = computed(() => collectGroups(baseNodes.value));
const stats = computed(() => degreeStats(baseNodes.value));
const hubCount = computed(() => stats.value.hubs.size);
const islandCount = computed(() => stats.value.islands.size);

// ---------- 取数 ----------
async function reload() {
  loading.value = true;
  try {
    if (props.compact) {
      const id = Number(props.focusNoteId);
      if (!id) { baseNodes.value = []; baseEdges.value = []; applyView(); return; }
      const d = await api.get(`/notes/graph/local/${id}?depth=${depth.value}`);
      baseNodes.value = d.nodes || [];
      baseEdges.value = d.edges || [];
      truncated.value = !!d.truncated;
      // 把「本篇」标成选中：白色外圈 + 一定画标题，一眼能认出中心是哪篇
      selId = Number(d.center) || id;
      applyView();
      await nextTick();
      requestAnimationFrame(() => fit());   // 右栏是后来才铺开的，第一帧量出来的宽高可能是 0
      return;
    }
    const qs = [];
    if (q.value.trim()) qs.push('q=' + encodeURIComponent(q.value.trim()));
    if (folderId.value !== '') qs.push('folder_id=' + encodeURIComponent(folderId.value));
    const d = await api.get('/notes/graph' + (qs.length ? '?' + qs.join('&') : ''));
    baseNodes.value = d.nodes || [];
    baseEdges.value = d.edges || [];
    truncated.value = !!d.truncated;
    applyView();
  } catch (e) { baseNodes.value = []; baseEdges.value = []; alert('读取图谱失败：' + e.message); }
  finally { loading.value = false; }
}
function setDepth(n) { if (depth.value === n) return; depth.value = n; reload(); }

function applyView() {
  let ns = baseNodes.value;
  let es = baseEdges.value;
  if (islandOnly.value) {
    ns = ns.filter((n) => !(Number(n.degree) || 0));
    es = [];
  }
  if (focusId.value) {
    const s = subgraph(ns, es, focusId.value, 2);
    ns = s.nodes; es = s.edges;
  }
  viewNodes.value = ns;
  viewEdges.value = es;
  buildSim();
}

// ---------- 仿真 ----------
let sim = null;
let snodes = [];   // 仿真用的节点副本（带 x/y/vx/vy）
let sedges = [];
let dirty = true;
let hoverId = null;
let selId = null;
let raf = 0;

function radiusOf(n) { return 4 + 2 * Math.log2(1 + (Number(n.degree) || 0)); }

function buildSim() {
  if (sim) { sim.stop(); sim = null; }
  snodes = viewNodes.value.map((n) => ({ ...n }));
  sedges = viewEdges.value.map((e) => ({ source: Number(e.source), target: Number(e.target) }));
  if (!snodes.length) { dirty = true; return; }
  const heavy = snodes.length > 800; // 上千点时省掉逐点碰撞与标签，先保证能拖得动
  sim = forceSimulation(snodes)
    .force('link', forceLink(sedges).id((d) => d.id).distance((d) => 40 + Math.min(120, (Number(d.source.degree) || 0) * 4)))
    .force('charge', forceManyBody().strength(heavy ? -60 : -120))
    .force('center', forceCenter(0, 0))
    .force('collide', heavy ? null : forceCollide(6));
  sim.stop();
  for (let i = 0; i < 300; i++) sim.tick();
  sim.on('tick', () => { dirty = true; });
  fit();
  dirty = true;
}

// 拖拽时把仿真加热；拖完必须把 alphaTarget 归零，否则仿真永远退不了火（一直 rAF 重绘 = 白烧 CPU）
function heat() { if (sim) sim.alphaTarget(0.3).restart(); }
function cool() { if (sim) { sim.alphaTarget(0); sim.alpha(0.3).restart(); } }

// ---------- 视图变换 ----------
const view = ref({ x: 0, y: 0, k: 1 });
function csize() { const c = cv.value; return c ? { w: c.clientWidth, h: c.clientHeight } : { w: 800, h: 600 }; }
function toScreen(p) { const { w, h } = csize(); return { x: (p.x - view.value.x) * view.value.k + w / 2, y: (p.y - view.value.y) * view.value.k + h / 2 }; }
function toWorld(sx, sy) { const { w, h } = csize(); return { x: (sx - w / 2) / view.value.k + view.value.x, y: (sy - h / 2) / view.value.k + view.value.y }; }

function fit() {
  if (!snodes.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of snodes) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); }
  const { w, h } = csize();
  const k = Math.max(0.1, Math.min(2, Math.min(w / (maxX - minX + 120), h / (maxY - minY + 120))));
  view.value = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, k };
  dirty = true;
}
function resetView() { view.value = { x: 0, y: 0, k: 1 }; dirty = true; }
function clearFocus() { focusId.value = null; applyView(); }
function focusHubs() {
  const hubs = stats.value.hubs;
  const hub = snodes.filter((n) => hubs.has(n.id)).sort((a, b) => (b.degree || 0) - (a.degree || 0))[0];
  if (!hub) return;
  view.value = { x: hub.x, y: hub.y, k: Math.max(1, view.value.k) };
  dirty = true;
}
function releaseAll() { for (const n of snodes) { n.fx = null; n.fy = null; } cool(); }

// ---------- 绘制 ----------
function draw() {
  const c = cv.value;
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const { k } = view.value;
  // id → 节点 的索引每帧建一次：直接 find() 是 O(点×边)，上千点时会明显掉帧
  const byId = new Map(snodes.map((n) => [n.id, n]));
  const adj = buildAdjacency(viewEdges.value);
  const cur = hoverId != null ? hoverId : selId;
  const nearCur = cur != null ? (adj.get(cur) || new Set()) : null;
  const groupList = groups.value;

  // 先线后点
  g.lineWidth = Math.max(0.5, 1 * k);
  for (const e of viewEdges.value) {
    const a = byId.get(Number(e.source));
    const b = byId.get(Number(e.target));
    if (!a || !b) continue;
    const p = toScreen(a), q2 = toScreen(b);
    const lit = cur == null || (cur === a.id || cur === b.id || (nearCur && (nearCur.has(a.id) || nearCur.has(b.id))));
    g.strokeStyle = lit ? 'rgba(120,160,230,.55)' : 'rgba(140,150,170,.14)';
    g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q2.x, q2.y); g.stroke();
  }

  const showLabel = k > 0.6 && snodes.length <= 800;
  g.font = '11px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'top';
  for (const n of snodes) {
    const p = toScreen(n);
    if (p.x < -40 || p.y < -40 || p.x > w + 40 || p.y > h + 40) continue;
    const r = radiusOf(n) * Math.max(0.75, Math.min(1.6, k));
    const lit = cur == null || n.id === cur || (nearCur && nearCur.has(n.id));
    g.globalAlpha = lit ? 1 : 0.22;
    const color = colorOf(n.group, groupList);
    if (!(Number(n.degree) || 0)) {
      g.fillStyle = 'transparent';
      g.strokeStyle = '#8b93a5'; g.lineWidth = 1.4;
      g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2); g.stroke();
    } else {
      g.fillStyle = color;
      g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2); g.fill();
      if (stats.value.hubs.has(n.id)) { g.strokeStyle = '#fff'; g.lineWidth = 1.6; g.beginPath(); g.arc(p.x, p.y, r + 2.5, 0, Math.PI * 2); g.stroke(); }
    }
    if (n.id === cur) { g.strokeStyle = '#fff'; g.lineWidth = 2; g.beginPath(); g.arc(p.x, p.y, r + 4, 0, Math.PI * 2); g.stroke(); }
    if (showLabel || n.id === cur || stats.value.hubs.has(n.id)) {
      g.fillStyle = 'rgba(230,235,245,.92)';
      g.fillText(String(n.title || '').slice(0, 18), p.x, p.y + r + 3);
    }
    g.globalAlpha = 1;
  }
}

function loop() { if (dirty) { dirty = false; draw(); } raf = requestAnimationFrame(loop); }

function pick(sx, sy) {
  const scale = Math.max(0.75, Math.min(1.6, view.value.k));
  for (let i = snodes.length - 1; i >= 0; i--) { // 倒序 = 后画的在上面，先命中
    const n = snodes[i];
    const p = toScreen(n);
    const r = radiusOf(n) * scale + 3;
    if ((p.x - sx) ** 2 + (p.y - sy) ** 2 <= r * r) return n;
  }
  return null;
}

// ---------- 交互 ----------
let drag = null;
function evPos(e) { const r = cv.value.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

function onDown(e) {
  const p = evPos(e);
  const n = pick(p.x, p.y);
  userAdjusted = true;   // 从这里起用户接管视角，resize 不再自动适配
  cv.value.setPointerCapture?.(e.pointerId);
  if (n) {
    drag = { node: n, moved: false, sx: p.x, sy: p.y };
    n.fx = n.x; n.fy = n.y;
    selId = n.id;
    heat();
  } else {
    drag = { pan: true, sx: p.x, sy: p.y, vx: view.value.x, vy: view.value.y };
  }
  dirty = true;
}

function onMove(e) {
  const p = evPos(e);
  if (drag?.node) {
    drag.moved = true;
    const w = toWorld(p.x, p.y);
    drag.node.fx = w.x; drag.node.fy = w.y;
    drag.node.x = w.x; drag.node.y = w.y;
    dirty = true;
    return;
  }
  if (drag?.pan) {
    view.value = { ...view.value, x: drag.vx - (p.x - drag.sx) / view.value.k, y: drag.vy - (p.y - drag.sy) / view.value.k };
    dirty = true;
    return;
  }
  const n = pick(p.x, p.y);
  if ((n?.id ?? null) !== hoverId) { hoverId = n ? n.id : null; dirty = true; }
  hoverTip.value = n ? { x: p.x + 12, y: p.y + 10, text: `${n.title || '未命名'}（${n.degree || 0} 条链接）` } : null;
  cv.value.style.cursor = n ? 'pointer' : 'grab';
}

function onUp(e) {
  if (drag?.node) {
    const n = drag.node;
    cool(); // 保留 fx/fy（钉住），但让仿真退火
    if (!drag.moved) { selId = n.id; emit('open-note', n.id); } // 单击（没拖动）打开笔记
  }
  drag = null;
  try { cv.value.releasePointerCapture?.(e.pointerId); } catch { /* 忽略 */ }
}

function onDblClick(e) {
  if (props.compact) return;   // 紧凑态本来就是局部图，双击再聚焦没有意义
  const p = evPos(e);
  const n = pick(p.x, p.y);
  if (n) { focusId.value = n.id; applyView(); }
}

function onWheel(e) {
  const p = evPos(e);
  userAdjusted = true;
  const before = toWorld(p.x, p.y);
  const k = Math.max(0.1, Math.min(8, view.value.k * Math.exp(-e.deltaY * 0.0012)));
  const { w, h } = csize();
  // 让光标下的那个世界坐标点在缩放前后停在原地
  const x = before.x - (p.x - w / 2) / k;
  const y = before.y - (p.y - h / 2) / k;
  view.value = { x, y, k };
  dirty = true;
}

// ---------- 生命周期 ----------
let ro = null;
let userAdjusted = false;   // 用户自己缩放过/平移过就不再去抢他的视角
onMounted(async () => {
  raf = requestAnimationFrame(loop);
  // 观察器必须**先挂上再取数**：紧凑态（右栏）第一次量出来的宽高是 0 —— 面板是切到「图谱」
  // 那一刻才铺开的。如果先 await reload() 再 observe，那次 0→真实尺寸的变化已经过去了，
  // 观察器一辈子等不到回调，fit() 用的还是 0 宽，图就缩在角上。
  ro = new ResizeObserver(() => {
    dirty = true;
    if (props.compact && !userAdjusted && snodes.length) fit();
  });
  if (wrapEl.value) ro.observe(wrapEl.value);
  await reload();
});
onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  if (ro) ro.disconnect();
  if (sim) sim.stop();
});
watch(() => props.focusNoteId, (v) => {
  // 紧凑态：换笔记 = 换一篇的局部图，得重新取数（不是在同一张全局图上换聚焦）
  if (props.compact) { if (v) reload(); else { baseNodes.value = []; baseEdges.value = []; applyView(); } return; }
  focusId.value = v || null;
  if (baseNodes.value.length) applyView();
});
defineExpose({ reload, focusNote: (id) => { focusId.value = Number(id); applyView(); } });
</script>

<style scoped>
.gv { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.gtop { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
.gtop button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
.sep { width: 1px; height: 16px; background: var(--border); margin: 0 3px; }
.gwrap { position: relative; flex: 1; min-height: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--bg2); }
canvas { display: block; width: 100%; height: 100%; touch-action: none; cursor: grab; }
.center-hint { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--text3); font-size: 13px; pointer-events: none; text-align: center; padding: 0 20px; }
.lonely-hint { position: absolute; left: 6px; right: 6px; top: 6px; color: var(--text3); font-size: 11.5px; text-align: center; pointer-events: none; line-height: 1.5; }
.tip { position: absolute; background: rgba(20,22,28,.92); color: #fff; font-size: 12px; padding: 3px 8px; border-radius: 6px; pointer-events: none; white-space: nowrap; z-index: 2; }
.glegen { position: absolute; left: 8px; bottom: 8px; display: flex; gap: 10px; flex-wrap: wrap; max-width: calc(100% - 16px); font-size: 11px; color: var(--text2); background: rgba(0,0,0,.25); padding: 4px 8px; border-radius: 6px; }
.lg { display: flex; align-items: center; gap: 4px; }
.lg i { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.lg i.hollow { background: transparent; border: 1.4px solid #8b93a5; width: 7px; height: 7px; }
.lg i.ring { background: var(--accent); box-shadow: 0 0 0 2px rgba(255,255,255,.7); }
</style>
