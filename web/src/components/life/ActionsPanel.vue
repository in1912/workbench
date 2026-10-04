<template>
  <div class="row" style="margin-bottom:12px; flex-wrap:wrap">
    <select v-model="filter.task_type" style="width:120px" @change="load">
      <option value="">全部类型</option>
      <option v-for="(lab, k) in TASK_TYPE_LABEL" :key="k" :value="k">{{ lab }}</option>
    </select>
    <select v-model="filter.done" style="width:112px" @change="load">
      <option value="0">未完成</option>
      <option value="1">已完成</option>
      <option value="">全部</option>
    </select>
    <label class="small" style="display:flex; align-items:center; gap:4px; cursor:pointer; white-space:nowrap; flex:0 0 auto">
      <input type="checkbox" v-model="onlyToday" style="width:auto" @change="load" /> 只看今天
    </label>
    <span class="grow"></span>
    <span class="muted">{{ list.length }} 条</span>
  </div>

  <div class="card">
    <div class="row" style="margin-bottom:12px; flex-wrap:wrap">
      <input v-model="draft.title" class="grow" placeholder="新建行动，回车即建" @keyup.enter="create" />
      <select v-model="draft.task_type" style="width:120px">
        <option v-for="(lab, k) in TASK_TYPE_LABEL" :key="k" :value="k">{{ lab }}</option>
      </select>
      <select v-model="draft.goal_id" style="max-width:200px">
        <option :value="null">不挂目标</option>
        <option v-for="g in goals" :key="g.id" :value="g.id">{{ g.title }}</option>
      </select>
      <button class="primary small" :disabled="!draft.title.trim()" @click="create">添加</button>
    </div>

    <div v-if="loading" class="empty">加载中…</div>
    <div v-else-if="!list.length" class="empty">没有符合条件的行动</div>
    <div v-for="a in list" :key="a.id" class="list-item">
      <span class="t" :class="{ strike: a.done }">
        <input type="checkbox" :checked="!!a.done" style="margin-right:8px; vertical-align:middle" @change="toggle(a)" />
        <input v-model="a.title" class="inline-title" @change="save(a)" />
      </span>
      <span class="meta">
        <span v-if="a.goal_id" class="badge blue" :title="'挂在目标 #' + a.goal_id">{{ goalTitle(a.goal_id) }}</span>
        <span class="badge" :class="typeBadge(a.task_type)">{{ TASK_TYPE_LABEL[a.task_type] || a.task_type }}</span>
        <span v-if="a.main_line_date" class="badge green" title="这天的主线">主线 {{ shortDate(a.main_line_date) }}</span>
        <input type="date" :value="a.due_date ? String(a.due_date).slice(0, 10) : ''" style="width:132px"
               @change="a.due_date = $event.target.value; save(a)" />
        <input type="date" :value="a.main_line_date ? String(a.main_line_date).slice(0, 10) : ''" style="width:132px"
               title="设为某天的主线" @change="a.main_line_date = $event.target.value; save(a)" />
        <button class="small danger" @click="remove(a)">删</button>
      </span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../../api';
import { TASK_TYPE_LABEL, flattenTree, shortDate, todayStr } from './lifeUtils';

const emit = defineEmits(['toast']);
const list = ref([]);
const goals = ref([]);
const loading = ref(true);
const onlyToday = ref(false);
const filter = ref({ task_type: '', done: '0' });
const draft = ref({ title: '', task_type: 'daily_todo', goal_id: null });

const goalTitle = (id) => (goals.value.find((g) => g.id === Number(id)) || {}).title || ('目标 #' + id);
const typeBadge = (t) => ({ main_line: 'green', project_task: 'blue', daily_todo: 'gray' }[t] || 'gray');

async function load() {
  loading.value = true;
  try {
    const q = new URLSearchParams();
    if (filter.value.task_type) q.set('task_type', filter.value.task_type);
    if (filter.value.done !== '') q.set('done', filter.value.done);
    if (onlyToday.value) q.set('due_date', todayStr());
    list.value = await api.get('/life/actions?' + q);
  } catch (e) { emit('toast', e.message, 'err'); } finally { loading.value = false; }
}

async function create() {
  const t = draft.value.title.trim();
  if (!t) return;
  try {
    await api.post('/life/actions', {
      title: t, task_type: draft.value.task_type,
      goal_id: draft.value.goal_id, due_date: todayStr(),
    });
    draft.value.title = '';
    await load();
    emit('toast', '已添加');
  } catch (e) { emit('toast', e.message, 'err'); }
}

async function save(a) {
  try {
    await api.put(`/life/actions/${a.id}`, {
      title: a.title, done: a.done, due_date: a.due_date, main_line_date: a.main_line_date,
    });
    await load();
  } catch (e) { emit('toast', e.message, 'err'); }
}

async function toggle(a) {
  a.done = a.done ? 0 : 1;
  await save(a);
}

async function remove(a) {
  if (!confirm(`删除行动「${a.title}」？`)) return;
  try {
    await api.del(`/life/actions/${a.id}`);
    await load();
  } catch (e) { emit('toast', e.message, 'err'); }
}

onMounted(async () => {
  try {
    goals.value = flattenTree(await api.get('/life/goals'));
  } catch { /* 目标拉不到就只显示 id */ }
  await load();
});
</script>

<style scoped>
/* 这一行东西多（勾选框 / 标题 / 目标 / 类型 / 主线 / 两个日期 / 删）：
   允许折行，再让标题吃掉剩余宽度——否则标题会被挤到只剩几十像素，根本读不出写了什么。
   全局 CSS 给所有 input 设了 width:100%（含 checkbox），所以勾选框得单独改回 auto，
   不然它会独占一行、把标题顶到下一行去。 */
.list-item { flex-wrap: wrap; }
.list-item .t { flex: 1 1 260px; min-width: 0; display: flex; align-items: center; }
.list-item .t input[type="checkbox"] { width: auto; flex: 0 0 auto; }
.inline-title { background: transparent; border: 1px solid transparent; border-radius: 6px; padding: 2px 5px; color: inherit; font-size: 13px; flex: 1; min-width: 0; }
.inline-title:hover, .inline-title:focus { border-color: var(--border); }
</style>
