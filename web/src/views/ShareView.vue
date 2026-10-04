<template>
  <div class="share-wrap">
    <div class="share-card">
      <template v-if="state === 'loading'"><div class="empty">加载中...</div></template>

      <template v-else-if="state === 'error'">
        <div class="share-err">
          <div style="font-size:34px; margin-bottom:10px">🔒</div>
          <div style="font-size:16px; margin-bottom:6px">{{ errMsg }}</div>
          <div class="muted" style="font-size:12.5px">如果链接是别人发给你的，请让对方重新分享一条。</div>
        </div>
      </template>

      <template v-else>
        <h1 class="share-title">{{ data.title || '未命名笔记' }}</h1>
        <div class="share-meta">
          <span v-if="data.category">{{ data.category }}</span>
          <span v-if="data.mode === 'snapshot'" class="tag">快照</span>
          <span v-if="tags.length" class="muted">{{ tags.join(' · ') }}</span>
        </div>
        <div v-if="data.summary" class="share-summary">{{ data.summary }}</div>
        <audio v-if="data.has_audio" :src="audioSrc" controls preload="none" style="width:100%; margin:10px 0"></audio>
        <div class="markdown-body" v-html="rendered"></div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { marked } from 'marked';
import { api, rawUrl } from '../api';

const route = useRoute();
const state = ref('loading');
const errMsg = ref('');
const data = ref({});

const tags = computed(() => String(data.value.tags || '').split(',').map((s) => s.trim()).filter(Boolean));
const rendered = computed(() => marked.parse(data.value.content || ''));
const audioSrc = computed(() => rawUrl(`/api/share/n/${route.params.token}/audio?c=${encodeURIComponent(route.query.c || '')}`));

onMounted(async () => {
  try {
    const c = route.query.c || '';
    data.value = await api.get(`/share/n/${route.params.token}?c=${encodeURIComponent(c)}`);
    state.value = 'ready';
  } catch (e) {
    errMsg.value = e.message || '链接不可用';
    state.value = 'error';
  }
});
</script>

<style scoped>
.share-wrap { min-height: 100vh; background: var(--bg); padding: 28px 14px; display: flex; justify-content: center; }
.share-card { width: min(820px, 100%); background: var(--bg2); border: 1px solid var(--border); border-radius: 14px; padding: 26px 28px; }
.share-title { font-size: 21px; margin-bottom: 8px; }
.share-meta { display: flex; gap: 10px; align-items: center; font-size: 12.5px; color: var(--text2); margin-bottom: 10px; }
.share-summary { background: var(--bg3); border-radius: 8px; padding: 10px 13px; font-size: 13px; color: var(--text2); margin-bottom: 12px; }
.share-err { text-align: center; padding: 40px 10px; }
</style>
