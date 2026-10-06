<template>
  <div ref="wrapEl" class="dom-wrap" :style="colsH ? { height: colsH + 'px' } : {}">
    <!-- 顶栏：一句话说明 + 新增领域（就地展开的表单，不弹窗；高度不变，列不会跳） -->
    <div class="dom-top">
      <span class="muted small" style="flex:1; min-width:200px">
        每个领域一条竖列；列内「已达成」排在最下面，超过 3 条自动折叠。
      </span>
      <template v-if="adding">
        <input v-model="newName" class="dom-new-name" placeholder="领域名称（最多 20 字）"
               maxlength="20" @keyup.enter="doAdd" @keyup.esc="adding = false" />
        <select v-model="newIcon" style="width:150px" title="图标">
          <option v-for="ic in ICONS" :key="ic" :value="ic">{{ ic }}</option>
        </select>
        <button class="small" @click="doAdd">确定</button>
        <button class="small" @click="adding = false">取消</button>
      </template>
      <button v-else class="small" @click="startAdd">＋ 新增领域</button>
    </div>

    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="!list.length" class="empty">还没有领域，点右上角「＋ 新增领域」建一个</div>
    <div v-else ref="colsEl" class="dom-cols">
      <section v-for="d in list" :key="d.id" class="dom-col"
               :class="{ dragging: dragId === d.id, 'drop-left': overId === d.id && overSide === 'left' && dragId !== d.id,
                         'drop-right': overId === d.id && overSide === 'right' && dragId !== d.id }"
               @dragover="onColDragOver(d, $event)" @drop.prevent="onColDrop(d, $event)"
               @dragleave="if (overId === d.id && dragId !== d.id) { overId = 0; overSide = ''; }">
        <header class="dom-head">
          <div class="dom-titlerow">
            <span class="drag-h" draggable="true" title="按住拖动，调整领域顺序"
                  @dragstart="onHDragStart(d, $event)" @dragend="onDragEnd">⇄</span>
            <span class="material-icons ic">{{ d.icon }}</span>
            <input v-if="editing === d.id" ref="nameIn" v-model="draft" class="dom-name-in" maxlength="20"
                   @keyup.enter="saveRename(d)" @keyup.esc="cancelRename" @blur="saveRename(d)" />
            <template v-else>
              <b class="dom-name" :title="d.name + '（双击改名）'" @dblclick="startRename(d)">{{ d.name }}</b>
              <span class="dom-acts">
                <button class="small" title="重命名领域" @click="startRename(d)">✏️</button>
                <button class="small" title="删除领域" @click="delDomain(d)">🗑</button>
              </span>
            </template>
          </div>
          <!-- 需求⑪：项目 / 习惯 / SOP 从卡片底部挪到领域标题旁边 -->
          <div class="dom-badges">
            <span class="badge gray" title="该领域下的项目数">项目 {{ d.projects }}</span>
            <span class="badge gray" title="该领域下的习惯数（不含已归档）">习惯 {{ d.habits }}</span>
            <span class="badge gray" title="该领域下的 SOP 数（不含已归档）">SOP {{ d.sops }}</span>
            <span class="badge gray" title="该领域下的目标数（不含已归档）">{{ d.goals.length }} 个目标</span>
          </div>
          <div class="row dom-prog">
            <div class="bar">
              <div class="bar-in"
                   :style="{ width: hasPct(d.avg_progress) ? Math.round(d.avg_progress * 100) + '%' : '0%', background: pctColor(d.avg_progress) }" />
            </div>
            <span :style="{ color: pctColor(d.avg_progress), fontSize: '12.5px' }">{{ pct(d.avg_progress) }}</span>
          </div>
        </header>

        <div class="dom-body">
          <div v-if="!d.goals.length" class="empty" style="padding:10px 0">这个领域还没有目标</div>
          <template v-else>
            <div v-for="g in activeGoals(d)" :key="g.id" class="list-item">
              <span class="t" :title="g.title">{{ g.title }}</span>
              <span class="meta" :style="{ color: pctColor(g.progress) }">{{ pct(g.progress) }}</span>
            </div>
            <template v-if="doneGoals(d).length">
              <div class="dom-sep"><span>已达成 {{ doneGoals(d).length }}</span></div>
              <div v-for="g in shownDone(d)" :key="g.id" class="list-item">
                <span class="t strike" :title="g.title">{{ g.title }}</span>
                <span class="meta" :style="{ color: pctColor(g.progress) }">{{ pct(g.progress) }}</span>
              </div>
              <button v-if="doneGoals(d).length > DONE_SHOW" class="small dom-more" @click="toggleExp(d.id)">
                {{ expanded[d.id] ? '－ 收起' : `＋ 展开其余 ${doneGoals(d).length - DONE_SHOW} 条` }}
              </button>
            </template>
          </template>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup>
// 领域面板（需求⑩⑪⑫，v1.10.5）：从「3 列矩阵卡片」改成「一领域一竖列」的看板式布局。
//
// 三条需求的落点：
// ⑩ 领域可改名 / 新增 / 删除；删除时先看领域里有没有目标 —— **有未达成的目标就删不掉**
//    （服务端 svc.deleteDomain 是硬闸，这里只是提前把话说清楚）；
//    项目/习惯/SOP 挂着时弹确认，确认后删除领域，它们的「领域」被清空（记录本身不删）。
// ⑪ 竖列外框**拉到浏览器底部**：高度不是写死的 calc(100vh - Npx)，而是挂载后用
//    getBoundingClientRect 量出自己离视口顶部多远，再算 innerHeight - top；窗口缩放、
//    父容器尺寸变化（比如上面弹出一条 toast）都会重量一次，所以不会被写死的偏移量坑到。
// ⑫ 已达成（status='done'）排在该领域最后；超过 3 条折叠，点「＋ 展开其余 N 条」才展开。
//
// v1.10.20：整页全页自适应（.main 的 1200px 封顶对本页解除，见 inject('wbMainFull')），
// 单张领域卡片宽度翻倍（.dom-col 的 basis/下限/上限三个值一起 ×2）。
import { ref, onMounted, onBeforeUnmount, nextTick, inject } from 'vue';
import { api } from '../../api';
import { pct, pctColor, hasPct } from './lifeUtils';

const emit = defineEmits(['toast']);
const list = ref([]);
const loading = ref(true);
const DONE_SHOW = 3;

// 图标白名单与后端 lifeService.DOMAIN_ICONS 一致（本地 Material Icons 字体里确实有这些字形）
const ICONS = ['flag', 'work', 'savings', 'favorite', 'home', 'group', 'trending_up', 'school',
  'fitness_center', 'menu_book', 'psychology', 'public', 'star', 'attach_money',
  'self_improvement', 'diversity_3', 'lightbulb', 'rocket_launch'];

const wrapEl = ref(null);
const colsH = ref(0);
const adding = ref(false);
const newName = ref('');
const newIcon = ref('flag');
const editing = ref(0);
const draft = ref('');
const nameIn = ref(null);
const expanded = ref({});
let ro = null;

// v1.10.20：本页全页自适应。App.vue 的 .main 默认 1200px 封顶，这里挂载时打开不限宽开关、
// 卸载时关掉 —— 切到别的页签 / 离开 /life 时本面板必然卸载（Life.vue 是 v-else-if 链），
// 所以不需要额外清理路径；inject 拿不到（理论上有别的宿主）就静默跳过，样式退回封顶。
const mainFull = inject('wbMainFull', null);

async function load() {
  const doms = await api.get('/life/domains');
  // 每个领域一次详情请求：领域只有个位数，不值得为它加一个聚合端点
  list.value = await Promise.all(doms.map((d) => api.get(`/life/domains/${d.id}`)));
}

onMounted(async () => {
  if (mainFull) mainFull.value = true;   // 本页不限宽（见 inject 处注释）
  try { await load(); } catch (e) { emit('toast', e.message, 'err'); } finally { loading.value = false; }
  await nextTick();
  measure();
  window.addEventListener('resize', measure, { passive: true });
  // 父容器尺寸一变（toast 弹出来把标签栏顶下去、窗口缩放、字体变化）就重量高度
  if (typeof ResizeObserver !== 'undefined' && wrapEl.value?.parentElement) {
    ro = new ResizeObserver(measure);
    ro.observe(wrapEl.value.parentElement);
  }
});
onBeforeUnmount(() => {
  if (mainFull) mainFull.value = false;
  window.removeEventListener('resize', measure);
  if (ro) { ro.disconnect(); ro = null; }
});

// 需求⑪：竖条外框拉到「浏览器底部」。量的是**整个面板**左上角离视口顶部的距离，
// 算出的高度给 .dom-wrap（不是给 .dom-cols）—— 顶栏（说明文字 + 新增按钮）占了多高，
// 就由 flex 自己扣掉，剩下的全给竖列。v1.10.5 第一版把高度直接给了 .dom-cols，
// 于是「顶栏那 34px」被算了两遍，列底边冒到视口外 4px（点检时量出来的）。
// 留 26px 底部余量。
function measure() {
  const el = wrapEl.value;
  if (!el) return;
  const top = el.getBoundingClientRect().top;
  const h = Math.max(320, Math.round(window.innerHeight - top - 26));
  if (h !== colsH.value) colsH.value = h;
}

const activeGoals = (d) => d.goals.filter((g) => g.status !== 'done');
const doneGoals = (d) => d.goals.filter((g) => g.status === 'done');
const shownDone = (d) => (expanded.value[d.id] ? doneGoals(d) : doneGoals(d).slice(0, DONE_SHOW));
function toggleExp(id) { expanded.value = { ...expanded.value, [id]: !expanded.value[id] }; }

// ---------- 新增 ----------
function startAdd() { adding.value = true; newName.value = ''; newIcon.value = 'flag'; }
async function doAdd() {
  const name = newName.value.trim();
  if (!name) { emit('toast', '领域名称不能为空', 'err'); return; }
  try {
    await api.post('/life/domains', { name, icon: newIcon.value });
    adding.value = false;
    await load();
    emit('toast', `已新增领域「${name}」`);
  } catch (e) { emit('toast', e.message, 'err'); }
}

// ---------- 改名 ----------
async function startRename(d) {
  editing.value = d.id;
  draft.value = d.name;
  await nextTick();
  const el = Array.isArray(nameIn.value) ? nameIn.value[0] : nameIn.value;
  if (el) { el.focus(); el.select && el.select(); }
}
function cancelRename() { editing.value = 0; draft.value = ''; }
async function saveRename(d) {
  if (editing.value !== d.id) return;   // 已经被 Enter/Esc 处理过（blur 会再进来一次）
  const name = draft.value.trim();
  if (!name || name === d.name) { cancelRename(); return; }
  editing.value = 0;
  try {
    await api.put(`/life/domains/${d.id}`, { name });
    await load();
    emit('toast', `已改名为「${name}」`);
  } catch (e) { emit('toast', e.message, 'err'); }
}

// ---------- 拖拽排序（v1.10.34）----------
// 模式与 Dashboard 卡片一致（HTML5 DnD + splice 重排），两点横向列表特有的处理：
// ① draggable 挂在 ⇄ 把手上而不是整卡——领域卡片很大，整卡可拖会和横向滚动、
//    列内目标列表的滚轮/选择误触打架；
// ② 落点按「指针在目标卡左半 / 右半」决定插到它前面还是后面（格子布局是替换式，
//    一维列表要分左右半才有自然的「挪一格」手感）。
// 拖到容器左右边缘自动横滚：dragover 拖着不动也会持续触发，天然就是滚动循环。
const colsEl = ref(null);
const dragId = ref(0);
const overId = ref(0);
const overSide = ref('');

function onHDragStart(d, e) {
  dragId.value = d.id;
  overId.value = 0; overSide.value = '';
  try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(d.id)); } catch { /* 老 webview */ }
}
function onDragEnd() { dragId.value = 0; overId.value = 0; overSide.value = ''; }

function onColDragOver(d, e) {
  if (!dragId.value || d.id === dragId.value) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const r = e.currentTarget.getBoundingClientRect();
  overId.value = d.id;
  overSide.value = (e.clientX - r.left) < r.width / 2 ? 'left' : 'right';
  // 边缘自动横滚（6 个领域 1920 宽必有横向滚动，拖不到远端的卡等于功能没有）
  const box = colsEl.value?.getBoundingClientRect();
  if (box) {
    const EDGE = 70;
    if (e.clientX > box.right - EDGE) colsEl.value.scrollLeft += 16;
    else if (e.clientX < box.left + EDGE) colsEl.value.scrollLeft -= 16;
  }
}

async function onColDrop(d) {
  // dragleave 可能在 drop 前把 overId 清掉，落点回退用 drop 事件自己的目标卡（side 默认插前面）
  const from = dragId.value, target = overId.value || d.id, side = overId.value ? overSide.value : 'left';
  onDragEnd();
  if (!from || !target || from === target) return;
  const arr = list.value;
  const moved = arr.find((x) => x.id === from);
  const ti = arr.findIndex((x) => x.id === target);
  if (!moved || ti < 0) return;
  arr.splice(arr.indexOf(moved), 1);
  let at = arr.findIndex((x) => x.id === target);
  if (side === 'right') at += 1;
  arr.splice(at, 0, moved);
  await saveOrder();
}

async function saveOrder() {
  try {
    const doms = await api.put('/life/domains/reorder', { ids: list.value.map((x) => x.id) });
    // 服务端按同一口径回的新清单（顺序即事实）；失败走 catch 重拉，不留半新半旧
    list.value = await Promise.all(doms.map((x) => api.get(`/life/domains/${x.id}`)));
    emit('toast', '领域顺序已保存');
  } catch (e) { emit('toast', e.message, 'err'); await load(); }
}

// ---------- 删除 ----------
// 服务端有两道闸（有目标一律拒绝；项目/习惯/SOP 要 force），这里按同一套规矩提前问清楚，
// 免得用户点了确认才被服务端拒回来。
async function delDomain(d) {
  if (d.goals.length) {
    confirm(`「${d.name}」下还有 ${d.goals.length} 个目标，先把这些目标删掉（或改到别的领域）再删除领域。`);
    return;
  }
  const others = [];
  if (d.projects) others.push(`${d.projects} 个项目`);
  if (d.habits) others.push(`${d.habits} 个习惯`);
  if (d.sops) others.push(`${d.sops} 条 SOP`);
  const tail = others.length
    ? `\n\n它下面还有 ${others.join('、')}，删除领域会把它们的「领域」清空（记录本身不删）。`
    : '';
  if (!confirm(`删除领域「${d.name}」？${tail}`)) return;
  try {
    await api.del(`/life/domains/${d.id}${others.length ? '?force=1' : ''}`);
    await load();
    emit('toast', `已删除领域「${d.name}」`);
  } catch (e) { emit('toast', e.message, 'err'); }
}
</script>

<style scoped>
.dom-wrap { display: flex; flex-direction: column; min-height: 0; }
.dom-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 10px; flex: 0 0 auto; }
.dom-new-name { width: 200px; }
/* 一条领域一列。列宽有下限（内容不至于被挤成一条），空间不够就横向滚动。
   flex:1 + min-height:0：高度由 .dom-wrap 定（见 measure()），顶栏占多少自己拿多少，
   剩下的全给列 —— 不这么写就得自己去减顶栏高度，减错一点列就冒到视口外面去。 */
.dom-cols { flex: 1 1 auto; min-height: 0; display: flex; gap: 12px; align-items: stretch; overflow-x: auto; overflow-y: hidden; padding-bottom: 4px; }
.dom-col {
  /* v1.10.20：页面全页自适应（.main 不再封 1200px）+ 卡片宽度翻倍 —— 三个值一起翻：
     basis 250→500、下限 168→336、上限 420→840。
     宽屏（1920，正文区 ≈ 1674px）下 6 个领域 6×336+5×12=2076 > 1674，吃不满就横向滚动，
     每卡 336 ≈ 旧版封顶容器（正文 1144px）里 ~180 的 1.9 倍；领域少于 6 个时自动长宽、
     上限 840 防止单卡傻宽。窄窗口（1366 笔记本，正文 ≈ 1120px）下排不下 3 张 336 → 横向滚动，
     不硬挤（卡片变窄会回到徽章换行、标题省略号的老问题，翻倍就没意义了）。 */
  flex: 1 1 500px; min-width: 336px; max-width: 840px;
  display: flex; flex-direction: column; min-height: 0;
  border: 1px solid var(--border); border-radius: 10px; background: var(--bg2); overflow: hidden;
}
.dom-head { padding: 10px 12px 8px; border-bottom: 1px solid var(--border); background: var(--bg); }
.dom-titlerow { display: flex; align-items: center; gap: 6px; }
.dom-titlerow .ic { font-size: 18px; color: var(--accent); flex: 0 0 auto; }
.dom-name { font-size: 14px; font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: text; }
.dom-name-in { flex: 1; min-width: 0; font-size: 14px; font-weight: 600; padding: 2px 6px; }
.dom-acts { display: flex; gap: 2px; flex: 0 0 auto; }
.dom-acts button { padding: 1px 5px; font-size: 11.5px; }
.dom-badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 7px; }
.dom-badges .badge { font-size: 11px; padding: 1px 7px; }
.dom-prog { margin-top: 8px; }
.dom-prog .bar { flex: 1; height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; }
.dom-prog .bar-in { height: 100%; border-radius: 3px; transition: width .25s; }
.dom-body { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 10px 12px; }
.dom-sep { display: flex; align-items: center; gap: 8px; margin: 10px 0 6px; color: var(--text3); font-size: 11.5px; }
.dom-sep::before, .dom-sep::after { content: ''; flex: 1; height: 1px; background: var(--border); }
.dom-more { width: 100%; margin-top: 4px; }
/* 拖拽排序（v1.10.34）：⇄ 把手可拖，卡片自身是 drop 目标（dragover 里按指针左右半判插前/插后） */
.drag-h { flex: 0 0 auto; cursor: grab; color: var(--text3); font-size: 13px; padding: 0 2px; user-select: none; }
.drag-h:hover { color: var(--accent); }
.drag-h:active { cursor: grabbing; }
.dom-col.dragging { opacity: .45; }
.dom-col.drop-left { box-shadow: -3px 0 0 var(--accent); }
.dom-col.drop-right { box-shadow: 3px 0 0 var(--accent); }
</style>
