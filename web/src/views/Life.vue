<template>
  <div>
    <h2 class="page-title">lifeOS
      <span class="muted" style="font-size:12px; font-weight:400">目标 · 行动 · 复盘 · 习惯 · 项目 · 关系</span>
    </h2>

    <div v-if="msg" class="msg" :class="msgType">{{ msg }}</div>

    <div class="tabs">
      <button v-for="t in visibleTabs" :key="t.key"
              :class="{ active: tab === t.key }" @click="go(t.key)">{{ t.label }}</button>
    </div>

    <!-- 每个面板自己拉自己的数据：切 tab 才发请求，不会一次性打十几个接口 -->
    <TodayPanel   v-if="tab === 'today'"   ref="dash" @go="go" @toast="toast" />
    <GoalsPanel   v-else-if="tab === 'goals'"   @toast="toast" />
    <ActionsPanel v-else-if="tab === 'actions'" @toast="toast" />
    <HabitsPanel  v-else-if="tab === 'habits'"  @toast="toast" />
    <ReviewsPanel v-else-if="tab === 'reviews'" @toast="toast" />
    <ImReviewPanel v-else-if="tab === 'aimreview'" @toast="toast" />
    <ProjectsPanel v-else-if="tab === 'projects'" @toast="toast" />
    <DomainsPanel v-else-if="tab === 'domains'" @toast="toast" />
    <GraphPanel   v-else-if="tab === 'graph'"   @toast="toast" />
    <GuidePanel   v-else-if="tab === 'guide'"   @go="go" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import { canTab, firstTab, TAB_DEFS } from '../tabs';
import TodayPanel from '../components/life/TodayPanel.vue';
import GoalsPanel from '../components/life/GoalsPanel.vue';
import ActionsPanel from '../components/life/ActionsPanel.vue';
import HabitsPanel from '../components/life/HabitsPanel.vue';
import ReviewsPanel from '../components/life/ReviewsPanel.vue';
import ImReviewPanel from '../components/life/ImReviewPanel.vue';
import ProjectsPanel from '../components/life/ProjectsPanel.vue';
import DomainsPanel from '../components/life/DomainsPanel.vue';
import GraphPanel from '../components/life/GraphPanel.vue';
import GuidePanel from '../components/life/GuidePanel.vue';

const route = useRoute();
const defs = TAB_DEFS.life || [];
const visibleTabs = computed(() => defs.filter((t) => canTab('life', t.key)));
const tab = ref(firstTab('life', (route.query.tab && defs.some((d) => d.key === route.query.tab)) ? route.query.tab : 'today'));
const dash = ref(null);
const msg = ref('');
const msgType = ref('ok');
let msgTimer = null;

function toast(text, type = 'ok') {
  msg.value = text;
  msgType.value = type;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { msg.value = ''; }, 3200);
}

function go(key) {
  if (!canTab('life', key)) return;
  tab.value = key;
}

// 切回「今日」时重新拉一次：可能在别的 tab 里刚建了目标/打了卡
watch(tab, (v) => { if (v === 'today') nextTick(() => dash.value && dash.value.reload && dash.value.reload()); });
onMounted(() => {
  // 支持外部跳转 #/life?tab=goals
  if (route.query.tab && canTab('life', route.query.tab)) tab.value = route.query.tab;
});
</script>
