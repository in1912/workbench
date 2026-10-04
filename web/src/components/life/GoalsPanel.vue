<template>
  <div class="row" style="margin-bottom:12px; flex-wrap:wrap">
    <select v-model="filter.level" style="width:118px" @change="loadTree">
      <option value="">全部层级</option>
      <option v-for="l in LEVEL_ORDER" :key="l" :value="l">{{ LEVEL_LABEL[l] }}</option>
    </select>
    <select v-model="filter.domain_id" style="width:150px" @change="loadTree">
      <option value="">全部领域</option>
      <option v-for="d in domains" :key="d.id" :value="d.id">{{ d.name }}</option>
    </select>
    <select v-model="filter.status" style="width:112px" @change="loadTree">
      <option value="active">进行中</option>
      <option value="">全部状态</option>
      <option value="done">已达成</option>
      <option value="paused">已暂停</option>
    </select>
    <span class="grow"></span>
    <button class="primary small" @click="openCreate(null)">＋ 新建目标</button>
  </div>

  <div class="split">
    <!-- 左：目标树 -->
    <div class="card tree-card">
      <h3>目标树 <span class="muted" style="font-weight:400">{{ flat.length }} 条</span></h3>
      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="!flat.length" class="empty">还没有目标<br /><span class="muted">先立一个年度目标，再往下拆季度和月度</span></div>
      <div v-for="g in flat" :key="g.id" class="tree-row" :class="{ active: current && current.id === g.id }"
           :style="{ paddingLeft: (g._depth * 14 + 8) + 'px' }" @click="select(g.id)">
        <span class="badge" :class="levelBadge(g.level)">{{ LEVEL_LABEL[g.level] || g.level }}</span>
        <span class="gname" :class="{ strike: g.status === 'done' }" :title="g.title">{{ g.title }}</span>
        <span v-if="g.is_key" class="badge red" title="重点目标（只显示在仪表盘）">重点</span>
        <span class="gprog" :style="{ color: pctColor(g.progress) }">{{ pct(g.progress) }}</span>
      </div>
    </div>

    <!-- 右：详情 -->
    <div class="card">
      <div v-if="!current" class="empty" style="padding:40px 0">左边选一个目标看详情</div>
      <template v-else>
        <h3>
          <input v-model="form.title" class="title-input" @change="saveGoal" />
          <span style="display:flex; gap:6px">
            <button class="small danger" @click="removeGoal">删除</button>
          </span>
        </h3>

        <div class="row" style="flex-wrap:wrap; margin-bottom:10px">
          <select v-model="form.level" @change="saveGoal">
            <option v-for="l in LEVEL_ORDER" :key="l" :value="l">{{ LEVEL_LABEL[l] }}</option>
          </select>
          <select v-model="form.domain_id" @change="saveGoal">
            <option :value="null">不归属领域</option>
            <option v-for="d in domains" :key="d.id" :value="d.id">{{ d.name }}</option>
          </select>
          <select v-model="form.status" @change="saveGoal">
            <option v-for="(lab, k) in GOAL_STATUS_LABEL" :key="k" :value="k">{{ lab }}</option>
          </select>
          <label class="small" style="display:flex; align-items:center; gap:4px; cursor:pointer; white-space:nowrap; flex:0 0 auto">
            <input type="checkbox" :checked="!!form.is_key" style="width:auto" @change="form.is_key = $event.target.checked ? 1 : 0; saveGoal()" />
            重点目标
          </label>
          <span class="muted">周期 {{ form.period_key || '—' }}</span>
        </div>

        <div class="row" style="margin-bottom:14px">
          <div class="bar"><div class="bar-in" :style="{ width: hasPct(current.progress) ? Math.round(current.progress * 100) + '%' : '0%', background: pctColor(current.progress) }"></div></div>
          <span :style="{ color: pctColor(current.progress), fontSize: '13px' }">{{ pct(current.progress) }}</span>
        </div>
        <div v-if="current.children && current.children.length" class="muted" style="margin:-8px 0 12px">
          有 {{ current.children.length }} 个子目标，进度由子目标与 KR 自动算出（不落库，永远和明细一致）。
        </div>

        <!-- KR -->
        <h3 style="margin-top:6px">关键结果 KR
          <button class="small" @click="addKr">＋ 加一条</button>
        </h3>
        <div v-if="!current.krs.length" class="empty" style="padding:12px 0">
          没有量化指标的目标无法衡量。<span class="muted">加一条「目标值 / 当前值」，进度就会自动算出来。</span>
        </div>
        <div v-for="k in current.krs" :key="k.id" class="kr-row">
          <input v-model="k.title" class="grow" @change="saveKr(k)" />
          <input v-model.number="k.current" type="number" step="any" style="width:78px" @change="saveKr(k)" />
          <span class="muted">/</span>
          <input v-model.number="k.target" type="number" step="any" style="width:78px" @change="saveKr(k)" />
          <input v-model="k.unit" placeholder="单位" style="width:56px" @change="saveKr(k)" />
          <span class="krpct" :style="{ color: krColor(k) }">{{ krPct(k) }}</span>
          <button class="small danger" @click="removeKr(k)">删</button>
        </div>

        <!-- 挂在目标下的行动 -->
        <h3 style="margin-top:16px">支撑这个目标的行动
          <span class="muted" style="font-weight:400">{{ (current.actions || []).length }} 条</span>
        </h3>
        <div v-if="!(current.actions || []).length" class="empty" style="padding:12px 0">还没有行动</div>
        <div v-for="a in current.actions" :key="a.id" class="list-item">
          <span class="t" :class="{ strike: a.done }">{{ a.title }}</span>
          <span class="meta">
            <span v-if="a.due_date" class="muted">{{ shortDate(a.due_date) }}</span>
            <button class="small" @click="toggleAction(a)">{{ a.done ? '撤销' : '完成' }}</button>
          </span>
        </div>
        <div class="row" style="margin-top:10px">
          <input v-model="newAction" class="grow" placeholder="加一条行动，回车即建（自动挂到这个目标上）" @keyup.enter="addAction" />
          <button class="small" :disabled="!newAction.trim()" @click="addAction">添加</button>
        </div>

        <!-- 关联 -->
        <h3 style="margin-top:16px">关联</h3>
        <LinkPanel :type="'goal'" :id="current.id" :links="current.links || { out: [], in: [] }"
                   @toast="(m, t) => $emit('toast', m, t)" @changed="select(current.id)" />
      </template>
    </div>
  </div>

  <!-- 新建目标 -->
  <div v-if="creating" class="modal-backdrop" @click.self="creating = null">
    <div class="modal card">
      <h3>新建目标</h3>
      <div class="row" style="margin-bottom:10px">
        <input v-model="creating.title" class="grow" placeholder="目标标题，例如：今年把副业做到月入 1 万" @keyup.enter="doCreate" />
      </div>
      <div class="row" style="margin-bottom:10px">
        <select v-model="creating.level" style="width:118px">
          <option v-for="l in LEVEL_ORDER" :key="l" :value="l">{{ LEVEL_LABEL[l] }}</option>
        </select>
        <select v-model="creating.domain_id" style="width:150px">
          <option :value="null">不归属领域</option>
          <option v-for="d in domains" :key="d.id" :value="d.id">{{ d.name }}</option>
        </select>
        <label class="small" style="display:flex; align-items:center; gap:4px; cursor:pointer; white-space:nowrap; flex:0 0 auto">
          <input type="checkbox" v-model="creating.is_key" style="width:auto" /> 重点目标
        </label>
      </div>
      <div class="row" style="margin-bottom:10px">
        <select v-model="creating.parent_id">
          <option :value="null">（顶层目标）</option>
          <option v-for="g in flat" :key="g.id" :value="g.id">挂在「{{ g.title }}」下</option>
        </select>
      </div>
      <div class="row">
        <span class="grow"></span>
        <button @click="creating = null">取消</button>
        <button class="primary" :disabled="!creating.title.trim()" @click="doCreate">创建</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../../api';
import { LEVEL_LABEL, LEVEL_ORDER, GOAL_STATUS_LABEL, pct, pctColor, hasPct, flattenTree, shortDate } from './lifeUtils';
import LinkPanel from './LinkPanel.vue';

const emit = defineEmits(['toast']);
const domains = ref([]);
const tree = ref([]);
const flat = computed(() => flattenTree(tree.value));
const loading = ref(true);
const filter = ref({ level: '', domain_id: '', status: 'active' });
const current = ref(null);
const form = ref({});
const creating = ref(null);
const newAction = ref('');

const levelBadge = (l) => ({ vision: 'red', year: 'amber', quarter: 'blue', month: 'green' }[l] || 'gray');
function krPct(k) { const t = Number(k.target) || 0; return t > 0 ? Math.round(Math.min(1, (Number(k.current) || 0) / t) * 100) + '%' : '—'; }
function krColor(k) {
  const t = Number(k.target) || 0;
  if (t <= 0) return 'var(--text3)';
  return pctColor(Math.min(1, (Number(k.current) || 0) / t));
}

async function loadTree() {
  loading.value = true;
  try {
    const q = new URLSearchParams();
    if (filter.value.level) q.set('level', filter.value.level);
    if (filter.value.domain_id !== '') q.set('domain_id', filter.value.domain_id);
    if (filter.value.status) q.set('status', filter.value.status);
    tree.value = await api.get('/life/goals' + (q.toString() ? '?' + q : ''));
  } catch (e) { emit('toast', e.message, 'err'); } finally { loading.value = false; }
}

async function select(id) {
  try {
    const g = await api.get(`/life/goals/${id}`);
    current.value = g;
    form.value = { ...g, domain_id: g.domain_id === null ? null : Number(g.domain_id) };
  } catch (e) { emit('toast', e.message, 'err'); }
}

async function saveGoal() {
  try {
    await api.put(`/life/goals/${current.value.id}`, {
      title: form.value.title, level: form.value.level,
      domain_id: form.value.domain_id, status: form.value.status, is_key: form.value.is_key ? 1 : 0,
    });
    await loadTree();
    await select(current.value.id);
  } catch (e) { emit('toast', e.message, 'err'); }
}

async function removeGoal() {
  const kids = (current.value.children || []).length;
  const warn = kids
    ? `「${current.value.title}」下面还有 ${kids} 个子目标，会一起删掉。\n挂在它下面的行动/项目不会被删，只是解除绑定。\n\n确定删除？`
    : `确定删除「${current.value.title}」？挂在它下面的行动不会被删，只是解除绑定。`;
  if (!confirm(warn)) return;
  try {
    const r = await api.del(`/life/goals/${current.value.id}`);
    current.value = null;
    await loadTree();
    emit('toast', `已删除 ${r.removed} 个目标`);
  } catch (e) { emit('toast', e.message, 'err'); }
}

function openCreate(parentId) {
  creating.value = { title: '', level: parentId ? 'month' : 'year', domain_id: null, parent_id: parentId, is_key: false };
}
async function doCreate() {
  try {
    const r = await api.post('/life/goals', {
      title: creating.value.title, level: creating.value.level,
      domain_id: creating.value.domain_id === '' ? null : creating.value.domain_id,
      parent_id: creating.value.parent_id === '' ? null : creating.value.parent_id,
      is_key: creating.value.is_key ? 1 : 0,
    });
    const id = r.id;
    creating.value = null;
    await loadTree();
    await select(id);
    emit('toast', '目标已创建');
  } catch (e) { emit('toast', e.message, 'err'); }
}

async function addKr() {
  try {
    await api.post(`/life/goals/${current.value.id}/krs`, { title: '新 KR', target: 0, current: 0 });
    await select(current.value.id);
    await loadTree();
  } catch (e) { emit('toast', e.message, 'err'); }
}
async function saveKr(k) {
  try {
    await api.put(`/life/krs/${k.id}`, { title: k.title, target: k.target, current: k.current, unit: k.unit });
    await select(current.value.id);
    await loadTree();
  } catch (e) { emit('toast', e.message, 'err'); }
}
async function removeKr(k) {
  if (!confirm(`删除 KR「${k.title}」？`)) return;
  try {
    await api.del(`/life/krs/${k.id}`);
    await select(current.value.id);
    await loadTree();
  } catch (e) { emit('toast', e.message, 'err'); }
}

async function addAction() {
  const t = newAction.value.trim();
  if (!t) return;
  try {
    await api.post('/life/actions', { title: t, task_type: 'project_task', goal_id: current.value.id });
    newAction.value = '';
    await select(current.value.id);
  } catch (e) { emit('toast', e.message, 'err'); }
}
async function toggleAction(a) {
  try {
    await api.put(`/life/actions/${a.id}`, { done: a.done ? 0 : 1 });
    await select(current.value.id);
  } catch (e) { emit('toast', e.message, 'err'); }
}

onMounted(async () => {
  try { domains.value = await api.get('/life/domains'); } catch { /* 领域拿不到不影响目标 */ }
  await loadTree();
});
</script>

<style scoped>
.split { display: grid; grid-template-columns: minmax(240px, 340px) 1fr; gap: 14px; align-items: start; }
@media (max-width: 900px) { .split { grid-template-columns: 1fr; } }
.tree-card { max-height: 72vh; overflow: auto; }
.tree-row { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.tree-row:hover { background: var(--hover, rgba(127,127,127,.08)); }
.tree-row.active { background: rgba(79,124,247,.15); }
.gname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gprog { font-size: 12px; font-variant-numeric: tabular-nums; }
.title-input { font-size: 14px; font-weight: 600; flex: 1; background: transparent; border: 1px solid transparent; border-radius: 6px; padding: 3px 6px; color: inherit; }
.title-input:hover, .title-input:focus { border-color: var(--border); background: var(--card2, transparent); }
.kr-row { display: flex; align-items: center; gap: 6px; padding: 4px 0; }
.krpct { width: 48px; text-align: right; font-size: 12px; font-variant-numeric: tabular-nums; }
.bar { flex: 1; height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; }
.bar-in { height: 100%; border-radius: 3px; transition: width .25s; }
</style>
