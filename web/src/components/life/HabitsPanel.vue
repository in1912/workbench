<template>
  <div class="card" style="margin-bottom:14px">
    <div class="row" style="flex-wrap:wrap">
      <input v-model="draft.title" class="grow" placeholder="新习惯，例如：每天走 8000 步" @keyup.enter="create" />
      <select v-model="draft.cadence" style="width:110px">
        <option value="daily">每天</option>
        <option value="weekly">每周</option>
        <option value="monthly">每月</option>
      </select>
      <select v-model="draft.goal_id" style="max-width:200px">
        <option :value="null">不挂目标</option>
        <option v-for="g in goals" :key="g.id" :value="g.id">{{ g.title }}</option>
      </select>
      <button class="primary small" :disabled="!draft.title.trim()" @click="create">添加</button>
      <label class="small" style="display:flex; align-items:center; gap:4px; cursor:pointer; white-space:nowrap; flex:0 0 auto">
        <input type="checkbox" v-model="showArchived" style="width:auto" @change="load" /> 含已归档
      </label>
    </div>
  </div>

  <div v-if="loading" class="empty">加载中…</div>
  <div v-else-if="!list.length" class="empty">还没有习惯</div>
  <div v-else class="grid g2">
    <div v-for="h in list" :key="h.id" class="card">
      <h3>
        <input v-model="h.title" class="inline-title" @change="save(h)" />
        <span class="muted" style="font-weight:400">{{ CADENCE[h.cadence] || h.cadence }}</span>
      </h3>
      <div class="row" style="margin-bottom:10px">
        <span class="badge" :class="h.streak > 0 ? 'green' : 'gray'">连续 {{ h.streak }} 天</span>
        <span v-if="h.goal_id" class="badge blue">{{ goalTitle(h.goal_id) }}</span>
        <span class="grow"></span>
        <span class="muted" v-if="h.today_count">今日 {{ h.today_count }} 次</span>
      </div>
      <div class="row">
        <button class="small" :class="{ primary: !h.today_count }" @click="check(h, h.today_count ? 0 : 1)">
          {{ h.today_count ? '撤销今日打卡' : '今日打卡' }}
        </button>
        <button class="small" @click="check(h, (h.today_count || 0) + 1)">＋1</button>
        <span class="grow"></span>
        <button class="small" @click="archive(h)">{{ h.archived ? '恢复' : '归档' }}</button>
        <button class="small danger" @click="remove(h)">删</button>
      </div>
      <div v-if="h.archived" class="muted" style="margin-top:8px">已归档（不再出现在今日打卡里）</div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../../api';
import { flattenTree } from './lifeUtils';

const emit = defineEmits(['toast']);
const CADENCE = { daily: '每天', weekly: '每周', monthly: '每月' };
const list = ref([]);
const goals = ref([]);
const loading = ref(true);
const showArchived = ref(false);
const draft = ref({ title: '', cadence: 'daily', goal_id: null });

const goalTitle = (id) => (goals.value.find((g) => g.id === Number(id)) || {}).title || ('目标 #' + id);

async function load() {
  loading.value = true;
  try {
    list.value = await api.get('/life/habits' + (showArchived.value ? '?archived=1' : ''));
  } catch (e) { emit('toast', e.message, 'err'); } finally { loading.value = false; }
}

async function create() {
  const t = draft.value.title.trim();
  if (!t) return;
  try {
    await api.post('/life/habits', { title: t, cadence: draft.value.cadence, goal_id: draft.value.goal_id });
    draft.value.title = '';
    await load();
    emit('toast', '已添加');
  } catch (e) { emit('toast', e.message, 'err'); }
}

async function save(h) {
  try {
    await api.put(`/life/habits/${h.id}`, { title: h.title });
    await load();
  } catch (e) { emit('toast', e.message, 'err'); }
}

async function check(h, count) {
  try {
    await api.post(`/life/habits/${h.id}/check`, { count });
    await load();
  } catch (e) { emit('toast', e.message, 'err'); }
}

async function archive(h) {
  try {
    await api.put(`/life/habits/${h.id}`, { archived: h.archived ? 0 : 1 });
    await load();
  } catch (e) { emit('toast', e.message, 'err'); }
}

async function remove(h) {
  if (!confirm(`删除习惯「${h.title}」？打卡记录会一起删掉。\n（只想停掉的话用「归档」，历史记录会留着）`)) return;
  try {
    await api.del(`/life/habits/${h.id}`);
    await load();
  } catch (e) { emit('toast', e.message, 'err'); }
}

onMounted(async () => {
  try { goals.value = flattenTree(await api.get('/life/goals')); } catch { /* 无目标也能用 */ }
  await load();
});
</script>

<style scoped>
/* 全局给 input 设了 width:100%，在 h3 这一行会把右边的「每天」挤成竖排两个字——
   让标题吃掉剩余宽度、节奏标签不许换行。 */
h3 .inline-title { flex: 1; min-width: 0; }
h3 > span.muted { white-space: nowrap; flex: 0 0 auto; }
.inline-title { background: transparent; border: 1px solid transparent; border-radius: 6px; padding: 2px 5px; color: inherit; font-size: 14px; font-weight: 600; }
.inline-title:hover, .inline-title:focus { border-color: var(--border); }
</style>
