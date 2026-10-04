<template>
  <div v-if="loading" class="empty">加载中…</div>
  <template v-else>
    <!-- 关键目标：只显示 is_key —— 原文「真正决定结果的 20%」，每天看到的就是这几条 -->
    <div v-if="data.key_goals && data.key_goals.length" class="card">
      <h3>重点目标
        <button class="small" @click="$emit('go', 'goals')">全部目标 →</button>
      </h3>
      <div v-for="g in data.key_goals" :key="g.id" class="krow">
        <span class="kname">{{ g.title }}</span>
        <div class="bar"><div class="bar-in" :style="{ width: barW(g.progress), background: pctColor(g.progress) }"></div></div>
        <span class="kval" :style="{ color: pctColor(g.progress) }">{{ pct(g.progress) }}</span>
      </div>
    </div>

    <div class="grid g2">
      <!-- 今日主线 -->
      <div class="card">
        <h3>今日主线
          <span class="muted" style="font-weight:400">{{ data.date }}</span>
        </h3>
        <div v-if="!data.mainline.length" class="empty">
          今天还没定主线
          <div style="margin-top:10px"><button class="small" @click="$emit('go', 'actions')">去安排 →</button></div>
        </div>
        <div v-for="t in data.mainline" :key="t.id" class="list-item">
          <span class="t" :class="{ strike: t.done }">{{ t.title }}</span>
          <span class="meta">
            <span v-if="t.estimate_min" class="muted">{{ t.estimate_min }}分</span>
            <button class="small" @click="toggle(t)">{{ t.done ? '撤销' : '完成' }}</button>
          </span>
        </div>
      </div>

      <!-- 今日到期（未完成的日常待办） -->
      <div class="card">
        <h3>今天到期</h3>
        <div v-if="!data.due.length" class="empty">没有今天到期的待办</div>
        <div v-for="t in data.due" :key="t.id" class="list-item">
          <span class="t">{{ t.title }}</span>
          <span class="meta">
            <span class="badge" :class="t.priority === 1 ? 'red' : (t.priority === 3 ? 'blue' : 'amber')">{{ prioLabel(t.priority) }}</span>
            <button class="small" @click="toggle(t)">完成</button>
          </span>
        </div>
      </div>

      <!-- 习惯打卡 -->
      <div class="card">
        <h3>习惯打卡
          <button class="small" @click="$emit('go', 'habits')">管理 →</button>
        </h3>
        <div v-if="!data.habits.length" class="empty">还没有习惯</div>
        <div v-for="h in data.habits" :key="h.id" class="list-item">
          <span class="t">{{ h.title }}</span>
          <span class="meta">
            <span v-if="h.streak" class="muted">连续 {{ h.streak }} 天</span>
            <button class="small" :class="{ primary: !h.done }" @click="check(h, h.done ? 0 : 1)">
              {{ h.done ? '已打卡 ✓' : '打卡' }}
            </button>
          </span>
        </div>
      </div>

      <!-- 复盘提示 -->
      <div class="card">
        <h3>该复盘了</h3>
        <div v-if="!data.review_due" class="empty">今天的复盘已经写完，很好。</div>
        <template v-else>
          <p class="small" style="color:var(--text2); margin-bottom:10px">
            {{ data.review_due === 'day' ? '今天还没写日复盘。' : '本周还没写周复盘。' }}
            复盘不是记录，是把做过的事<b>炼成经验</b>——顺着写下一步动作，它能一键沉淀成 SOP。
          </p>
          <button class="primary small" @click="$emit('go', 'reviews')">
            {{ data.review_due === 'day' ? '写今天的日复盘' : '写本周的周复盘' }}
          </button>
        </template>
        <div v-if="data.review_week_key" class="muted" style="margin-top:10px">本周周期键：{{ data.review_week_key }}</div>
      </div>
    </div>
  </template>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../../api';
import { pct, pctColor, hasPct } from './lifeUtils';

const emit = defineEmits(['go', 'toast']);
const data = ref({ date: '', mainline: [], due: [], habits: [], key_goals: [], review_due: null, review_week_key: '' });
const loading = ref(true);

const PRIO = { 1: '高', 2: '中', 3: '低' };
const prioLabel = (p) => PRIO[p] || '中';
const barW = (v) => (hasPct(v) ? Math.round(Number(v) * 100) + '%' : '0%');

async function reload() {
  loading.value = true;
  try {
    data.value = await api.get('/life/today');
  } catch (e) {
    emit('toast', e.message, 'err');
  } finally {
    loading.value = false;
  }
}

async function toggle(t) {
  try {
    await api.put(`/life/actions/${t.id}`, { done: t.done ? 0 : 1 });
    await reload();
    emit('toast', t.done ? '已撤销' : '已完成');
  } catch (e) { emit('toast', e.message, 'err'); }
}

async function check(h, count) {
  try {
    await api.post(`/life/habits/${h.id}/check`, { count });
    await reload();
  } catch (e) { emit('toast', e.message, 'err'); }
}

onMounted(reload);
defineExpose({ reload });
</script>

<style scoped>
.krow { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
.kname { flex: 0 0 42%; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kval { flex: 0 0 52px; text-align: right; font-size: 12px; font-variant-numeric: tabular-nums; }
.bar { flex: 1; height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; }
.bar-in { height: 100%; border-radius: 3px; transition: width .25s; }
</style>
