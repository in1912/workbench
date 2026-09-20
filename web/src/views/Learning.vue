<template>
  <div>
    <h2 class="page-title">学习 <span class="muted" style="font-size:13px">听写 · 视频 · 打字 · 练琴 · 心愿卡</span></h2>
    <!-- tab 栏直接由 TAB_DEFS 驱动（跳过 hidden 伪 tab），与权限表自动保持一致；受限 tab 带 🔒 -->
    <div class="tabs">
      <button v-for="t in visibleTabs" :key="t.key" :class="{ active: tab === t.key }" @click="switchTab(t.key)">
        {{ t.label }}<span v-if="t.restricted"> 🔒</span>
      </button>
    </div>

    <DictationPanel v-if="tab === 'dictation'" />
    <VStudyPanel v-else-if="tab === 'vstudy'" />
    <VLedgerPanel v-else-if="tab === 'vledger'" />
    <VSettingsPanel v-else-if="tab === 'vsettings'" />
    <VLogPanel v-else-if="tab === 'vlog'" />
    <!-- 打字赚钱 4 个 tab 并入（2026-09 v1.2.0） -->
    <PracticePanel v-else-if="tab === 'practice'" />
    <RecordsPanel v-else-if="tab === 'records'" />
    <MoneyPanel v-else-if="tab === 'money'" />
    <PayoutPanel v-else-if="tab === 'payout'" />
    <PianoPanel v-else-if="tab === 'piano'" />
    <WishPanel v-else-if="tab === 'wish'" />
    <TtsPanel v-else-if="tab === 'tts'" />
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { canTab, firstTab, TAB_DEFS } from '../tabs';
import DictationPanel from '../learning/DictationPanel.vue';
import TtsPanel from '../learning/TtsPanel.vue';
import VStudyPanel from '../learning/VStudyPanel.vue';
import VSettingsPanel from '../learning/VSettingsPanel.vue';
import VLogPanel from '../learning/VLogPanel.vue';
import VLedgerPanel from '../learning/VLedgerPanel.vue';
import PianoPanel from '../learning/PianoPanel.vue';
import WishPanel from '../learning/WishPanel.vue';
import PracticePanel from '../typing/PracticePanel.vue';
import RecordsPanel from '../typing/RecordsPanel.vue';
import MoneyPanel from '../typing/MoneyPanel.vue';
import PayoutPanel from '../typing/PayoutPanel.vue';

const route = useRoute();
const router = useRouter();

// 页内实际渲染的 tab（hidden 伪 tab 只进权限表；无权限的 tab 不显示按钮——canTab 同步过滤，
// 此前漏了这层导致受限 tab（兑现登记等）对所有人可见可点，2026-09 v1.2.9 修）
const visibleTabs = computed(() => (TAB_DEFS.learning || []).filter((t) => !t.hidden && canTab('learning', t.key)));
const tab = ref(firstTab('learning', 'dictation'));
// 支持 /learning?tab=xxx 直达（打字赚钱旧地址 /typing?tab=xxx 已重定向到这里），切 tab 时同步地址栏
function switchTab(t) {
  if (!canTab('learning', t)) return; // 双保险：按钮已按权限隐藏，此处防 URL/代码直达
  tab.value = t;
  router.replace({ query: { ...route.query, tab: t } });
}
watch(() => route.query.tab, (t) => {
  if (t && t !== tab.value && canTab('learning', String(t))) tab.value = String(t);
});
if (route.query.tab && canTab('learning', String(route.query.tab))) tab.value = String(route.query.tab);
</script>
