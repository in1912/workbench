<template>
  <div class="card" style="margin-bottom:14px">
    <div class="row" style="flex-wrap:wrap">
      <input v-model="draft.title" class="grow" placeholder="新项目名，例如：做一门写作课" @keyup.enter="create" />
      <select v-model="draft.category" style="width:104px">
        <option v-for="(lab, k) in PROJECT_CAT_LABEL" :key="k" :value="k">{{ lab }}</option>
      </select>
      <select v-model="draft.goal_id" style="max-width:200px">
        <option :value="null">不挂目标</option>
        <option v-for="g in goals" :key="g.id" :value="g.id">{{ g.title }}</option>
      </select>
      <button class="primary small" :disabled="!draft.title.trim()" @click="create">添加</button>
    </div>
  </div>

  <div class="row" style="margin-bottom:12px; flex-wrap:wrap">
    <select v-model="filter.status" style="width:120px" @change="load">
      <option value="">全部状态</option>
      <option value="active">进行中</option>
      <option value="done">已完成</option>
      <option value="paused">已暂停</option>
    </select>
    <select v-model="filter.category" style="width:120px" @change="load">
      <option value="">全部类别</option>
      <option v-for="(lab, k) in PROJECT_CAT_LABEL" :key="k" :value="k">{{ lab }}</option>
    </select>
    <span class="grow"></span>
    <span class="muted">{{ list.length }} 个项目</span>
  </div>

  <div v-if="loading" class="empty">加载中…</div>
  <div v-else-if="!list.length" class="empty">还没有项目</div>
  <div v-else class="grid g2">
    <div v-for="p in list" :key="p.id" class="card">
      <h3>
        <input v-model="p.title" class="inline-title" @change="save(p)" />
        <span class="badge" :class="statusBadge(p.status)">{{ GOAL_STATUS_LABEL[p.status] || p.status }}</span>
      </h3>
      <div class="row" style="flex-wrap:wrap; margin-bottom:8px">
        <select v-model="p.category" style="width:100px" @change="save(p)">
          <option v-for="(lab, k) in PROJECT_CAT_LABEL" :key="k" :value="k">{{ lab }}</option>
        </select>
        <select v-model="p.status" style="width:100px" @change="save(p)">
          <option value="active">进行中</option>
          <option value="done">已完成</option>
          <option value="paused">已暂停</option>
        </select>
        <select v-model="p.goal_id" style="max-width:190px" @change="save(p)">
          <option :value="null">不挂目标</option>
          <option v-for="g in goals" :key="g.id" :value="g.id">{{ g.title }}</option>
        </select>
      </div>
      <p v-if="p.description" class="small muted" style="margin-bottom:8px">{{ p.description }}</p>
      <div class="row">
        <span v-if="p.due_date" class="muted small">截止 {{ shortDate(p.due_date) }}</span>
        <span class="grow"></span>
        <button class="small danger" @click="remove(p)">删</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../../api';
import { PROJECT_CAT_LABEL, GOAL_STATUS_LABEL, flattenTree, shortDate } from './lifeUtils';

const emit = defineEmits(['toast']);
const list = ref([]);
const goals = ref([]);
const loading = ref(true);
const filter = ref({ status: '', category: '' });
const draft = ref({ title: '', category: 'work', goal_id: null });

const statusBadge = (s) => ({ active: 'green', done: 'blue', paused: 'amber' }[s] || 'gray');

async function load() {
  loading.value = true;
  try {
    const q = new URLSearchParams();
    if (filter.value.status) q.set('status', filter.value.status);
    if (filter.value.category) q.set('category', filter.value.category);
    list.value = await api.get('/life/projects' + (q.toString() ? '?' + q : ''));
  } catch (e) { emit('toast', e.message, 'err'); } finally { loading.value = false; }
}

async function create() {
  const t = draft.value.title.trim();
  if (!t) return;
  try {
    await api.post('/life/projects', { title: t, category: draft.value.category, goal_id: draft.value.goal_id });
    draft.value.title = '';
    await load();
    emit('toast', '已创建');
  } catch (e) { emit('toast', e.message, 'err'); }
}

async function save(p) {
  try {
    await api.put(`/life/projects/${p.id}`, {
      title: p.title, category: p.category, status: p.status, goal_id: p.goal_id,
    });
    await load();
  } catch (e) { emit('toast', e.message, 'err'); }
}

async function remove(p) {
  if (!confirm(`删除项目「${p.title}」？\n挂在它下面的行动不会被删，只是解除绑定。`)) return;
  try {
    await api.del(`/life/projects/${p.id}`);
    await load();
    emit('toast', '已删除');
  } catch (e) { emit('toast', e.message, 'err'); }
}

onMounted(async () => {
  try { goals.value = flattenTree(await api.get('/life/goals')); } catch { /* 无目标也能用 */ }
  await load();
});
</script>

<style scoped>
.inline-title { background: transparent; border: 1px solid transparent; border-radius: 6px; padding: 2px 5px; color: inherit; font-size: 14px; font-weight: 600; flex: 1; }
.inline-title:hover, .inline-title:focus { border-color: var(--border); }
</style>
