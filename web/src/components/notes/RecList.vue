<template>
  <div class="reclist">
    <div class="row" style="margin-bottom:8px">
      <button class="primary small" @click="$emit('new-rec')">＋ 新增录音</button>
      <button class="small" @click="$emit('refresh')">刷新</button>
    </div>
    <div class="muted" style="font-size:11.5px; margin-bottom:8px">在这里录的音，转写完成后会自动生成一篇笔记（同时出现在「文件」里）</div>
    <div v-for="r in recs" :key="r.id" class="list-item" style="cursor:pointer; border-radius:8px; padding:8px 10px"
         @click="$emit('open-rec', r)">
      <div class="grow">
        <div class="t">🎙 {{ r.started_at || ('录音 #' + r.id) }}</div>
        <div class="meta">
          {{ String(r.fmt || '').toUpperCase() }} · {{ fmtDur(r.duration_sec) }} · {{ fmtSize(r.file_size) }} ·
          <b :style="{ color: recStatusColor(r) }">{{ recStatusText(r) }}</b>
          <span v-if="r.has_text"> · {{ r.transcript_chars }} 字</span>
        </div>
      </div>
    </div>
    <div v-if="!recs.length" class="empty">还没有录音</div>
  </div>
</template>

<script setup>
// 录音列表（v1.9.41）：从老 Notes.vue 原样搬过来的展示逻辑，行为与文案一字未改。
defineProps({ recs: { type: Array, default: () => [] } });
defineEmits(['open-rec', 'new-rec', 'refresh']);

function fmtDur(s) { const t = Math.max(0, Math.round(Number(s) || 0)); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; }
function fmtSize(b) { const n = Number(b) || 0; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }
const recStatusText = (r) => ({ pending: '待转写', running: '转写中…', done: '已生成', failed: '失败' }[r.status] || r.status || '—');
const recStatusColor = (r) => ({ running: '#60a5fa', done: '#34d399', failed: '#f87171' }[r.status] || 'inherit');
</script>

<style scoped>
.reclist .list-item { display: flex; align-items: center; gap: 8px; }
.reclist .t { font-size: 13px; }
.reclist .meta { font-size: 11.5px; color: var(--text2); margin-top: 2px; }
</style>
