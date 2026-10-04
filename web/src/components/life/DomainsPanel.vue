<template>
  <div v-if="loading" class="empty">加载中…</div>
  <div v-else class="grid g3">
    <div v-for="d in list" :key="d.id" class="card">
      <h3>
        <span><span class="material-icons" style="font-size:18px; vertical-align:-3px">{{ d.icon }}</span> {{ d.name }}</span>
        <span class="muted" style="font-weight:400">{{ d.goals.length }} 个目标</span>
      </h3>
      <div class="row" style="margin-bottom:10px">
        <div class="bar"><div class="bar-in" :style="{ width: hasPct(d.avg_progress) ? Math.round(d.avg_progress * 100) + '%' : '0%', background: pctColor(d.avg_progress) }"></div></div>
        <span :style="{ color: pctColor(d.avg_progress), fontSize: '12.5px' }">{{ pct(d.avg_progress) }}</span>
      </div>
      <div v-if="!d.goals.length" class="empty" style="padding:10px 0">这个领域还没有目标</div>
      <div v-for="g in d.goals.slice(0, 5)" :key="g.id" class="list-item">
        <span class="t" :class="{ strike: g.status === 'done' }">{{ g.title }}</span>
        <span class="meta" :style="{ color: pctColor(g.progress) }">{{ pct(g.progress) }}</span>
      </div>
      <div v-if="d.goals.length > 5" class="muted" style="margin-top:6px">还有 {{ d.goals.length - 5 }} 个…</div>
      <div class="row" style="margin-top:10px">
        <span class="badge gray">项目 {{ d.projects }}</span>
        <span class="badge gray">习惯 {{ d.habits }}</span>
        <span class="badge gray">SOP {{ d.sops }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../../api';
import { pct, pctColor, hasPct } from './lifeUtils';

const emit = defineEmits(['toast']);
const list = ref([]);
const loading = ref(true);

onMounted(async () => {
  try {
    const doms = await api.get('/life/domains');
    // 每个领域一次详情请求：领域只有个位数，不值得为它加一个聚合端点
    list.value = await Promise.all(doms.map((d) => api.get(`/life/domains/${d.id}`)));
  } catch (e) {
    emit('toast', e.message, 'err');
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.bar { flex: 1; height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; }
.bar-in { height: 100%; border-radius: 3px; transition: width .25s; }
</style>
