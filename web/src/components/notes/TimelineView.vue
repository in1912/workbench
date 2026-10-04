<template>
  <div class="tl">
    <div class="row" style="gap:6px; flex-wrap:wrap; align-items:center; margin-bottom:8px">
      <select v-model="field" style="width:130px" @change="load()">
        <option value="updated">按更新时间</option><option value="created">按创建时间</option>
        <option value="daily">按日记日期</option>
      </select>
      <select v-model="gran" style="width:110px" @change="load()">
        <option value="day">按天</option><option value="week">按周</option><option value="month">按月</option>
      </select>
      <input v-model="from" type="date" style="width:150px" @change="load()">
      <span class="muted small">→</span>
      <input v-model="to" type="date" style="width:150px" @change="load()">
      <button class="small" @click="from = ''; to = ''; load()">清空范围</button>
      <span class="muted" style="margin-left:auto; font-size:12px">{{ total }} 篇 · {{ totalWords }} 字</span>
    </div>

    <div class="tlwrap">
      <div class="bars">
        <div v-for="b in bars" :key="b.bucket" class="bar" :title="`${b.bucket}：${b.count} 篇 / ${b.words} 字`">
          <div class="bcol" :style="{ height: b.h + 'px' }" />
          <div class="blab">{{ b.short }}</div>
        </div>
        <div v-if="!bars.length" class="empty">这段时间还没有笔记</div>
      </div>

      <div class="tlbody">
        <div v-for="b in bucketsDesc" :key="b.bucket" class="bucket" :class="{ on: openBucket === b.bucket }">
          <div class="bhead" @click="toggle(b)">
            <span class="bk">{{ b.bucket }}</span>
            <span class="muted small">{{ b.count }} 篇 · {{ b.words }} 字</span>
            <span class="muted small" style="margin-left:auto">{{ canDrill ? (openBucket === b.bucket ? '收起' : '展开') : '' }}</span>
          </div>
          <div v-if="openBucket === b.bucket" class="blist">
            <div v-if="loadingN" class="muted small" style="padding:4px 8px">载入中…</div>
            <a v-for="n in bucketNotes" :key="n.id" class="bnote" href="javascript:;" @click="$emit('open-note', n.id)">
              {{ n.title || '未命名' }}
              <span class="muted small">{{ String(n.updated_at || '').slice(0, 16) }}</span>
            </a>
            <div v-if="!loadingN && !bucketNotes.length" class="muted small" style="padding:4px 8px">（没有笔记）</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
// 时间线（v1.9.41）：直方图 + 分桶列表。
//
// 用原生 div 画柱子而不是引图表库：柱子就是「每桶一个 div，高度按比例」，几十行代码的事，
// 再引一个图表依赖不值得。桶数很多时只画最近 90 个，避免柱子细成一条线。
import { ref, computed, onMounted } from 'vue';
import { api } from '../../api';

defineEmits(['open-note']);

const field = ref('updated');
const gran = ref('day');
const from = ref('');
const to = ref('');
const buckets = ref([]);
const err = ref('');
const openBucket = ref('');
const bucketNotes = ref([]);
const loadingN = ref(false);

const total = computed(() => buckets.value.reduce((s, b) => s + (b.count || 0), 0));
const totalWords = computed(() => buckets.value.reduce((s, b) => s + (b.words || 0), 0));
const bucketsDesc = computed(() => [...buckets.value].reverse());
const canDrill = computed(() => gran.value !== 'week'); // 周桶是 '2026-W14'，落不到日期范围上

const bars = computed(() => {
  const list = buckets.value.slice(-90);
  const max = Math.max(1, ...list.map((b) => b.count || 0));
  return list.map((b) => ({
    bucket: b.bucket, count: b.count, words: b.words,
    h: Math.max(3, Math.round((b.count || 0) / max * 90)),
    short: String(b.bucket).replace(/^\d{2}(\d{2})-/, '$1-').replace(/^(\d{4})-0?(\d+)-0?(\d+)$/, '$2/$3'),
  }));
});

async function load() {
  err.value = '';
  openBucket.value = '';
  const qs = [`field=${field.value}`, `granularity=${gran.value}`];
  if (from.value) qs.push('from=' + from.value);
  if (to.value) qs.push('to=' + to.value);
  try {
    const d = await api.get(`/notes/timeline?${qs.join('&')}`);
    buckets.value = d.buckets || [];
  } catch (e) { err.value = e.message; buckets.value = []; }
}

async function toggle(b) {
  if (!canDrill.value) return;
  if (openBucket.value === b.bucket) { openBucket.value = ''; return; }
  openBucket.value = b.bucket;
  bucketNotes.value = [];
  loadingN.value = true;
  try {
    let f = b.bucket, t = b.bucket;
    if (gran.value === 'month') { f = `${b.bucket}-01`; t = `${b.bucket}-31`; }
    const col = field.value === 'daily' ? 'daily' : field.value === 'created' ? 'created' : 'updated';
    bucketNotes.value = await api.get(`/notes?lean=1&limit=300&date_field=${col}&from=${f}&to=${t}`);
  } catch (e) { err.value = e.message; }
  finally { loadingN.value = false; }
}

onMounted(load);
defineExpose({ load });
</script>

<style scoped>
.tl { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.tlwrap { flex: 1; min-height: 0; overflow-y: auto; }
.bars { display: flex; align-items: flex-end; gap: 2px; height: 110px; padding: 6px 4px; border-bottom: 1px solid var(--border); overflow-x: auto; }
.bar { display: flex; flex-direction: column; justify-content: flex-end; align-items: center; flex: 0 0 auto; min-width: 10px; }
.bcol { width: 8px; background: var(--accent); border-radius: 2px 2px 0 0; opacity: .75; }
.bar:hover .bcol { opacity: 1; }
.blab { font-size: 9px; color: var(--text3); white-space: nowrap; transform: rotate(-45deg); margin-top: 3px; height: 26px; }
.bucket { border-bottom: 1px solid var(--border); }
.bhead { display: flex; align-items: center; gap: 8px; padding: 6px 8px; cursor: pointer; border-radius: 6px; }
.bhead:hover { background: var(--bg3); }
.bucket.on .bhead { background: var(--bg3); }
.bk { font-size: 13px; font-variant-numeric: tabular-nums; }
.blist { padding: 2px 0 6px 14px; }
.bnote { display: flex; justify-content: space-between; gap: 8px; padding: 3px 8px; border-radius: 5px; font-size: 12.5px; color: var(--accent); text-decoration: none; }
.bnote:hover { background: var(--bg3); }
</style>
