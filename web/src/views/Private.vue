<template>
  <div>
    <h2 class="page-title">私有项目</h2>
    <div class="tabs">
      <button v-if="canTab('private','dep')" :class="{active: tab==='dep'}" @click="switchTab('dep')">抑郁测试</button>
      <button v-if="canTab('private','pro')" :class="{active: tab==='pro'}" @click="switchTab('pro')">心理测试</button>
      <button v-if="canTab('private','mbti')" :class="{active: tab==='mbti'}" @click="switchTab('mbti')">职业测试</button>
    </div>

    <!-- 三大测评中心（自「效率工具」页移来，2026-09 v1.6.2；共用 TestCenterTab 组件） -->
    <TestCenterTab v-if="tab==='dep'" center="dep" />
    <TestCenterTab v-else-if="tab==='pro'" center="pro" />
    <TestCenterTab v-else center="mbti" />
  </div>
</template>

<script setup>
import { ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { canTab, firstTab } from '../tabs';
import TestCenterTab from '../components/TestCenterTab.vue';

const route = useRoute();
const router = useRouter();
const tab = ref(firstTab('private', 'dep'));
// 支持 /private?tab=xxx 直达；切 tab 时同步地址栏
function switchTab(t) {
  tab.value = t;
  router.replace({ query: { ...route.query, tab: t } });
}
watch(() => route.query.tab, (t) => {
  if (t && t !== tab.value && canTab('private', String(t))) tab.value = String(t);
});
if (route.query.tab && canTab('private', String(route.query.tab))) tab.value = String(route.query.tab);
</script>
