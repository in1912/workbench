<template>
  <div class="wb">
    <div class="wtop">
      <select :value="boardId || ''" style="width:170px" @change="switchBoard(Number($event.target.value))">
        <option v-for="b in boards" :key="b.id" :value="b.id">{{ b.name }}</option>
      </select>
      <button class="small" @click="newBoard">＋ 白板</button>
      <template v-if="boardId">
        <button class="small" @click="renameBoard">改名</button>
        <button class="small danger" @click="delBoard">删除</button>
        <span class="sep" />
        <button class="small" @click="addText">＋ 文本</button>
        <button class="small" @click="addLink">＋ 链接</button>
        <button class="small" @click="pickFile">＋ 图片</button>
        <select v-model.number="addNoteId" style="width:190px" @change="addNoteCard()">
          <option :value="0">＋ 笔记卡片…</option>
          <option v-for="n in notes" :key="n.id" :value="n.id">{{ n.title || '未命名' }}</option>
        </select>
        <span class="sep" />
        <button class="small" :disabled="!undoStack.length" @click="undo">撤销</button>
        <button class="small" @click="resetView">适配</button>
        <span class="muted small">{{ savedText }}</span>
      </template>
      <input ref="fileEl" type="file" accept="image/*" style="display:none" @change="onFile">
    </div>

    <div v-if="!boardId" class="center-hint">
      <div>还没有白板。</div>
      <button class="primary small" style="margin-top:8px" @click="newBoard">新建第一块白板</button>
    </div>

    <div v-else class="wcanvas" ref="wrapEl"
         @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointerleave="onUp"
         @wheel.prevent="onWheel" @contextmenu.prevent>
      <canvas ref="cv" />
      <div class="layer" :style="layerStyle">
        <div v-for="it in items" :key="it.id ?? it._k" class="wcard"
             :data-k="it._k"
             :class="{ sel: it.id != null && it.id === selId, dragging: drag?.item === it }"
             :style="cardStyle(it)"
             @pointerdown.stop="startDrag($event, it)">
          <div class="hd">
            <span class="kind">{{ KIND[it.type] || it.type }}</span>
            <button class="x" title="删除卡片" @pointerdown.stop @click.stop="delCard(it)">×</button>
          </div>

          <div class="bd" @dblclick.stop="onCardOpen(it)">
            <template v-if="it.type === 'image'">
              <img v-if="it.attachment_id" :src="rawUrl(`/api/notes/attachments/${it.attachment_id}/raw`)" alt="">
              <span v-else class="muted small">图片已丢失</span>
            </template>
            <a v-else-if="it.type === 'webpage'" :href="safeHref(it.url)" target="_blank" rel="noopener noreferrer" @pointerdown.stop>{{ it.url }}</a>
            <template v-else-if="it.type === 'text'">
              <textarea :value="it.text" @input="it.text = $event.target.value; touch()" @pointerdown.stop
                        placeholder="写点什么…" />
            </template>
            <template v-else>
              <div class="nt">{{ it.note_title || ('笔记 #' + it.note_id) }}</div>
              <div v-if="it.note_summary" class="muted small">{{ String(it.note_summary).slice(0, 90) }}</div>
            </template>
          </div>

          <button class="anchor" title="从这里拖到另一张卡片建立连线"
                  @pointerdown.stop="startEdge($event, it)" />
          <span class="rs" @pointerdown.stop="startResize($event, it)" />
        </div>
      </div>
      <div v-if="!items.length" class="center-hint">空白板。用上面的按钮加卡片；从卡片右边缘的小圆点拖到另一张卡片可以连线。</div>
    </div>
  </div>
</template>

<script setup>
// 白板（v1.9.41）：Canvas 画连线 + DOM 层放卡片。
//
// 分工的原因：卡片要显示实时标题、图片、可编辑文本，这些用 DOM 最省事；而连线只在拖拽时变化，
// 用 Canvas 一笔笔画比维护几十个 SVG 元素轻。坐标统一用「世界坐标」，视口 {x,y,zoom} 落库，
// 于是缩放和拖动只是改一个 transform，卡片内容不受影响。
//
// 这一版**不做**：旋转、分组、画框、多选、协作、折线连线。都是能让体积翻倍但个人用不上的东西。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { api, rawUrl } from '../../api';

const props = defineProps({ notes: { type: Array, default: () => [] } });
const emit = defineEmits(['open-note']);

const KIND = { note: '📄 笔记', text: '✎ 文本', image: '🖼 图片', webpage: '🔗 链接' };

const boards = ref([]);
const boardId = ref(null);
const items = ref([]);
const edges = ref([]);
const vp = ref({ x: 0, y: 0, zoom: 1 });
const selId = ref(null);
const drag = ref(null);
const savedText = ref('');
const addNoteId = ref(0);
const fileEl = ref(null);
const removed = ref([]); // 本轮待删的卡片 id，随下一次 layout 提交
const cv = ref(null);
const wrapEl = ref(null);
let keySeq = 0;
const newKey = () => `local${++keySeq}`;

const layerStyle = computed(() => ({
  transform: `translate(${-vp.value.x * vp.value.zoom}px, ${-vp.value.y * vp.value.zoom}px) scale(${vp.value.zoom})`,
}));
const cardStyle = (it) => ({
  left: (Number(it.x) || 0) + 'px', top: (Number(it.y) || 0) + 'px',
  width: (Number(it.w) || 240) + 'px', height: (Number(it.h) || 130) + 'px',
  background: it.color || 'var(--bg2)',
});
const safeHref = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '#');

// ---------- 撤销（只记 add / move / resize / delete 这类结构变化，不记文本输入） ----------
const undoStack = ref([]);
function snapshot() { undoStack.value.push(JSON.stringify(items.value)); if (undoStack.value.length > 50) undoStack.value.shift(); }
function undo() {
  const s = undoStack.value.pop();
  if (!s) return;
  items.value = JSON.parse(s);
  scheduleSave();
}

// ---------- 取数 ----------
async function loadBoards() {
  try { boards.value = await api.get('/notes/boards'); } catch { boards.value = []; }
  if (!boards.value.length) { boardId.value = null; items.value = []; edges.value = []; return; }
  const hit = boards.value.find((b) => b.id === boardId.value) || boards.value[0];
  await switchBoard(hit.id);
}

async function switchBoard(id) {
  if (!Number.isFinite(id)) return;
  flushNow(); // 切板前把没落盘的改动推上去，否则切回来就丢了
  boardId.value = id;
  try {
    const b = await api.get(`/notes/boards/${id}`);
    items.value = (b.items || []).map((i) => ({ ...i, _k: newKey() }));
    edges.value = b.edges || [];
    vp.value = { x: Number(b.viewport?.x) || 0, y: Number(b.viewport?.y) || 0, zoom: Number(b.viewport?.zoom) || 1 };
    undoStack.value = [];
    savedText.value = '';
    dirty = false;
    drawEdges();
  } catch (e) { alert('打开白板失败：' + e.message); }
}

async function newBoard() {
  const name = prompt('白板名称', '新白板');
  if (name === null) return;
  try {
    const r = await api.post('/notes/boards', { name: name.trim() || '新白板' });
    await loadBoards();
    await switchBoard(Number(r.id));
  } catch (e) { alert(e.message); }
}
async function renameBoard() {
  const cur = boards.value.find((b) => b.id === boardId.value);
  const name = prompt('白板名称', cur?.name || '');
  if (name === null || !name.trim()) return;
  try { await api.put(`/notes/boards/${boardId.value}`, { name: name.trim() }); } catch (e) { alert(e.message); return; }
  loadBoards();
}
async function delBoard() {
  if (!confirm('删除这块白板？上面的卡片与连线会一起删掉（卡片指向的笔记不受影响）。')) return;
  try { await api.del(`/notes/boards/${boardId.value}`); } catch (e) { alert(e.message); return; }
  boardId.value = null;
  await loadBoards();
}

// ---------- 落盘（800ms 防抖；新增卡片要等回包才知道服务端 id） ----------
let timer = null;
let dirty = false;
function touch() { dirty = true; scheduleSave(); }
function scheduleSave() {
  clearTimeout(timer);
  timer = setTimeout(saveLayout, 800);
}
async function saveLayout() {
  if (!boardId.value || !dirty) return;
  const known = items.value.filter((i) => i.id != null);
  const fresh = items.value.filter((i) => i.id == null);
  const payload = {
    items: items.value.map((i) => ({
      id: i.id ?? undefined, type: i.type, note_id: i.note_id ?? null, attachment_id: i.attachment_id ?? null,
      text: i.text || '', url: i.url || '', x: Number(i.x) || 0, y: Number(i.y) || 0,
      w: Number(i.w) || 240, h: Number(i.h) || 130, z: Number(i.z) || 0, color: i.color || '',
    })),
    edges: edges.value.map((e) => ({ from_item_id: e.from_item_id, to_item_id: e.to_item_id, label: e.label || '' })),
    removed_items: removed.value,
    viewport: vp.value,
  };
  try {
    await api.put(`/notes/boards/${boardId.value}/layout`, payload);
    // 新增卡片的 id 回填：接口不回 id，但插入顺序 = 数组顺序、自增 id 递增，
    // 所以「本地的无 id 卡片」与「服务端新出现的 id 从小到大」是一一对应的。
    if (fresh.length) {
      const b = await api.get(`/notes/boards/${boardId.value}`);
      const serverIds = (b.items || []).map((i) => i.id);
      const have = new Set([...known.map((i) => i.id), ...fresh.map((i) => i.id).filter((x) => x != null)]);
      const added = serverIds.filter((id) => !have.has(id)).sort((a, b2) => a - b2);
      fresh.forEach((it, i) => { if (added[i] != null) it.id = added[i]; });
      // 服务端会把新插入的卡片排在后面，这里按 id 重新认一遍 note_title 等 join 出来的字段
      const byId = new Map((b.items || []).map((i) => [i.id, i]));
      for (const it of items.value) if (it.id != null && byId.has(it.id)) Object.assign(it, { note_title: byId.get(it.id).note_title, note_summary: byId.get(it.id).note_summary });
    }
    removed.value = [];
    dirty = false;
    savedText.value = '已保存 ' + new Date().toTimeString().slice(0, 8);
  } catch (e) { savedText.value = '保存失败：' + e.message; }
}
function flushNow() {
  clearTimeout(timer);
  if (dirty) saveLayout();
}

// ---------- 卡片 ----------
function centerOf() { const el = wrapEl.value; return el ? { x: el.clientWidth / 2, y: el.clientHeight / 2 } : { x: 400, y: 300 }; }
function worldCenter() { const c = centerOf(); return { x: vp.value.x + c.x / vp.value.zoom - 120, y: vp.value.y + c.y / vp.value.zoom - 65 }; }

function addText() {
  snapshot();
  const p = worldCenter();
  items.value.push({ _k: newKey(), type: 'text', text: '', x: p.x, y: p.y, w: 220, h: 120, z: items.value.length });
  touch();
}
function addLink() {
  const url = prompt('链接地址（http/https）', 'https://');
  if (!url || !/^https?:\/\//i.test(url)) return;
  snapshot();
  const p = worldCenter();
  items.value.push({ _k: newKey(), type: 'webpage', url, x: p.x, y: p.y, w: 200, h: 90, z: items.value.length });
  touch();
}
function addNoteCard() {
  const id = Number(addNoteId.value);
  if (!id) return;
  const n = props.notes.find((x) => x.id === id);
  snapshot();
  const p = worldCenter();
  items.value.push({ _k: newKey(), type: 'note', note_id: id, note_title: n?.title || '', note_summary: n?.summary || '', x: p.x, y: p.y, w: 240, h: 120, z: items.value.length });
  addNoteId.value = 0;
  touch();
}
function pickFile() { fileEl.value?.click(); }
async function onFile(e) {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (f.size > 10 * 1024 * 1024) { alert('图片不能超过 10MB'); return; }
  const p = worldCenter();
  try {
    const r = await api.upload(`/notes/boards/${boardId.value}/image`, { x: p.x, y: p.y }, [{ name: 'file', file: f }]);
    items.value.push({ _k: newKey(), id: Number(r.id), type: 'image', attachment_id: Number(r.attachment_id), x: p.x, y: p.y, w: 260, h: 180, z: items.value.length });
    dirty = true; scheduleSave();
  } catch (err) { alert('上传失败：' + err.message); }
}
function delCard(it) {
  if (!confirm('删除这张卡片？')) return;
  snapshot();
  if (it.id != null) removed.value.push(it.id);
  edges.value = edges.value.filter((e) => e.from_item_id !== it.id || e.to_item_id !== it.id);
  items.value = items.value.filter((x) => x !== it);
  touch();
  drawEdges();
}
function onCardOpen(it) {
  if (it.type === 'note' && it.note_id) emit('open-note', Number(it.note_id));
  else if (it.type === 'webpage' && /^https?:\/\//i.test(it.url || '')) window.open(it.url, '_blank', 'noopener');
}

// ---------- 拖动 / 缩放 ----------
function evPos(e) { const r = wrapEl.value.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
function startDrag(e, it) {
  if (e.button !== undefined && e.button !== 0) return;
  if (!e.target.closest('.hd') && it.type !== 'note') return; // 文本/图片卡只从标题栏拖，免得点正文时误拖
  const p = evPos(e);
  drag.value = { item: it, sx: p.x, sy: p.y, ox: Number(it.x) || 0, oy: Number(it.y) || 0, moved: false };
  selId.value = it.id ?? null;
  wrapEl.value.setPointerCapture?.(e.pointerId);
  e.preventDefault();
}
function startResize(e, it) {
  const p = evPos(e);
  drag.value = { item: it, resize: true, sx: p.x, sy: p.y, ow: Number(it.w) || 240, oh: Number(it.h) || 130 };
  wrapEl.value.setPointerCapture?.(e.pointerId);
  e.preventDefault();
}
function onDown(e) {
  if (e.target !== wrapEl.value && !e.target.classList.contains('layer') && e.target.tagName !== 'CANVAS') return;
  selId.value = null;
  drag.value = { pan: true, sx: e.clientX, sy: e.clientY, vx: vp.value.x, vy: vp.value.y };
  wrapEl.value.setPointerCapture?.(e.pointerId);
}
function onMove(e) {
  const d = drag.value;
  if (!d) return;
  if (d.pan) {
    vp.value = { ...vp.value, x: d.vx - (e.clientX - d.sx) / vp.value.zoom, y: d.vy - (e.clientY - d.sy) / vp.value.zoom };
    drawEdges(); touch();
    return;
  }
  const p = evPos(e);
  if (d.resize) {
    d.item.w = Math.max(120, d.ow + (p.x - d.sx) / vp.value.zoom);
    d.item.h = Math.max(70, d.oh + (p.y - d.sy) / vp.value.zoom);
    drawEdges(); touch();
    return;
  }
  if (d.item) {
    d.moved = true;
    d.item.x = d.ox + (p.x - d.sx) / vp.value.zoom;
    d.item.y = d.oy + (p.y - d.sy) / vp.value.zoom;
    scheduleSave();
  }
}
function onUp(e) {
  const d = drag.value;
  drag.value = null;
  try { wrapEl.value.releasePointerCapture?.(e.pointerId); } catch { /* 忽略 */ }
  if (!d) return;
  if (d.item && d.moved) { snapshot(); touch(); }
  if (d.item && !d.moved) selId.value = d.item.id ?? null;
  if (d.pan) { touch(); }
  drawEdges();
}

// ---------- 连线 ----------
let edgeFrom = null;
let tempEdge = null;
function startEdge(e, it) {
  if (it.id == null) { alert('先把这张卡片保存一下（约 1 秒）再连线'); return; }
  edgeFrom = it;
  const p = evPos(e);
  tempEdge = { x: p.x, y: p.y };
  wrapEl.value.setPointerCapture?.(e.pointerId);
  document.addEventListener('pointermove', edgeMove);
  document.addEventListener('pointerup', edgeUp, { once: true });
}
function edgeMove(e) { const p = evPos(e); tempEdge = { x: p.x, y: p.y }; drawEdges(); }
function edgeUp(e) {
  document.removeEventListener('pointermove', edgeMove);
  const r = wrapEl.value.getBoundingClientRect();
  const target = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.wcard');
  const host = target ? items.value.find((i) => i._k === target.dataset.k) : null;
  if (edgeFrom && host && host.id != null && host.id !== edgeFrom.id) {
    const dup = edges.value.some((x) => x.from_item_id === edgeFrom.id && x.to_item_id === host.id);
    if (!dup) { edges.value.push({ from_item_id: edgeFrom.id, to_item_id: host.id, label: '' }); touch(); }
  }
  edgeFrom = null; tempEdge = null;
  drawEdges();
}

function drawEdges() {
  const c = cv.value, wrap = wrapEl.value;
  if (!c || !wrap) return;
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const pos = (it) => ({ x: (Number(it.x) + Number(it.w) / 2 - vp.value.x) * vp.value.zoom, y: (Number(it.y) + Number(it.h) / 2 - vp.value.y) * vp.value.zoom });
  const byId = new Map(items.value.filter((i) => i.id != null).map((i) => [i.id, i]));
  g.strokeStyle = 'rgba(120,160,230,.75)';
  g.lineWidth = 1.6;
  for (const e of edges.value) {
    const a = byId.get(e.from_item_id), b = byId.get(e.to_item_id);
    if (!a || !b) continue;
    const p = pos(a), q = pos(b);
    g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke();
    g.fillStyle = 'rgba(120,160,230,.9)';
    g.beginPath(); g.arc(q.x, q.y, 3.5, 0, Math.PI * 2); g.fill();
  }
  if (edgeFrom && tempEdge) {
    const p = pos(edgeFrom);
    g.setLineDash([5, 4]);
    g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(tempEdge.x, tempEdge.y); g.stroke();
    g.setLineDash([]);
  }
}

// ---------- 视口 ----------
function onWheel(e) {
  const p = evPos(e);
  const before = { x: p.x / vp.value.zoom + vp.value.x, y: p.y / vp.value.zoom + vp.value.y };
  const zoom = Math.max(0.2, Math.min(3, vp.value.zoom * Math.exp(-e.deltaY * 0.0012)));
  vp.value = { zoom, x: before.x - p.x / zoom, y: before.y - p.y / zoom };
  drawEdges(); touch();
}
function resetView() {
  vp.value = { x: 0, y: 0, zoom: 1 };
  drawEdges(); touch();
}

let ro = null;
onMounted(async () => {
  await loadBoards();
  ro = new ResizeObserver(() => drawEdges());
  if (wrapEl.value) ro.observe(wrapEl.value);
  drawEdges();
});
onBeforeUnmount(() => {
  if (ro) ro.disconnect();
  clearTimeout(timer);
  flushNow();
});
defineExpose({ reload: loadBoards });
</script>

<style scoped>
/* position:relative 是必需的：里面的 .center-hint 用 inset:0 定位，根容器不定位时它会以更外层的
   定位祖先为基准，一路铺到整个中间区（实测 x 从 218 起、宽 1154 —— **连笔记左栏一起盖住**），
   于是「还没有白板」时整页点不动。GraphView 那边同样的写法靠 pointer-events:none 侥幸躲过，这里是真挡。 */
.wb { display: flex; flex-direction: column; flex: 1; min-height: 0; position: relative; }
.wtop { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; margin-bottom: 6px; }
.sep { width: 1px; height: 16px; background: var(--border); margin: 0 3px; }
.wcanvas { position: relative; flex: 1; min-height: 0; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--bg2); touch-action: none; cursor: grab; }
.wcanvas canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
.layer { position: absolute; inset: 0; transform-origin: 0 0; }
.wcard { position: absolute; border: 1px solid var(--border); border-radius: 8px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,.18); }
.wcard.sel { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(79,124,247,.35); }
.wcard .hd { display: flex; align-items: center; gap: 4px; font-size: 10.5px; color: var(--text3); padding: 2px 4px 2px 6px; background: rgba(127,127,127,.10); cursor: move; }
.wcard .hd .kind { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wcard .hd .x { border: none; background: none; color: var(--text3); cursor: pointer; font-size: 13px; line-height: 1; padding: 0 3px; border-radius: 4px; }
.wcard .hd .x:hover { background: var(--red); color: #fff; }
.wcard .bd { flex: 1; min-height: 0; padding: 5px 7px; overflow: hidden; display: flex; flex-direction: column; }
.wcard .bd .nt { font-size: 13px; font-weight: 600; }
.wcard .bd textarea { flex: 1; min-height: 0; border: none; background: transparent; resize: none; font-size: 12.5px; color: var(--text); outline: none; padding: 0; }
.wcard .bd img { width: 100%; height: 100%; object-fit: contain; }
.wcard .bd a { font-size: 12px; color: var(--accent); word-break: break-all; }
.anchor { position: absolute; right: -7px; top: 50%; width: 12px; height: 12px; margin-top: -6px; border-radius: 50%; border: 2px solid var(--accent); background: var(--bg2); cursor: crosshair; padding: 0; }
.rs { position: absolute; right: 0; bottom: 0; width: 12px; height: 12px; cursor: nwse-resize; background: linear-gradient(135deg, transparent 45%, var(--text3) 45%, var(--text3) 60%, transparent 60%); }
.center-hint { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--text3); font-size: 13px; text-align: center; padding: 0 20px; }
</style>
