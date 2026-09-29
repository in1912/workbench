<template>
  <!-- 全局搜索（原独立页，2026-09 v1.7.0 并入效率工具页最后一个 tab；右下角悬浮框带关键词直达） -->
  <div>
    <div class="card" style="margin-bottom:14px">
      <div class="row">
        <input v-model="q" placeholder="搜索笔记、待办、家庭事项、子女任务、学习记录、剪贴板、新闻..." class="grow" style="padding:11px 14px; font-size:15px"
               @keyup.enter="doSearch" @input="debounced" />
        <button class="primary" @click="doSearch">搜索</button>
      </div>
      <div class="muted" style="margin-top:8px">支持输入法直接打字搜索，按回车或停顿自动触发</div>
    </div>

    <div v-if="searching" class="muted" style="padding:10px">搜索中...</div>
    <div v-else-if="results.length">
      <div v-for="(r,i) in results" :key="i" class="card" style="margin-bottom:10px">
        <div class="row" style="align-items:flex-start">
          <span class="badge" :class="typeCls(r.type)">{{ r.type }}</span>
          <div class="grow">
            <div class="t" style="cursor:pointer" @click="r.to && goto(r.to)">{{ r.title }}</div>
            <div class="d" v-if="r.content">{{ plainText(r.content) }}</div>
            <div class="meta" v-if="r.time">{{ r.time }}</div>
          </div>
        </div>
      </div>
    </div>
    <div v-else-if="q" class="card empty">没有找到与「{{ q }}」相关的内容</div>
    <div v-else class="card empty">输入关键词开始搜索</div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { api } from '../api';
import { plainText } from '../utils/rich';

const router = useRouter();
const route = useRoute();
const q = ref('');
const results = ref([]);
const searching = ref(false);
let timer = null;

function goto(to) { router.push(to); }

async function doSearch() {
  const term = q.value.trim();
  if (!term) { results.value = []; return; }
  searching.value = true;
  try {
    const d = await api.get(`/search?q=${encodeURIComponent(term)}`);
    results.value = d.results;
  } finally {
    searching.value = false;
  }
}

function debounced() {
  clearTimeout(timer);
  timer = setTimeout(doSearch, 500);
}

// ?q= 直达搜索（右下角悬浮框带词跳转进来即自动执行；空输入点搜索只进本页不触发）
watch(() => route.query.q, (v) => {
  if (typeof v === 'string' && v.trim()) { q.value = v.trim(); doSearch(); }
});
onMounted(() => {
  const v = String(route.query.q || '').trim();
  if (v) { q.value = v; doSearch(); }
});

function typeCls(t) {
  return { 笔记: 'blue', 待办: 'amber', 家庭事项: 'green', 子女任务: 'amber', 学习记录: 'blue', 剪贴板: 'green', 新闻: 'red' }[t] || '';
}
</script>
