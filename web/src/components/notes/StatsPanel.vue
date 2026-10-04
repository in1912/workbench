<template>
  <div class="st">
    <div class="stop">
      <select v-model.number="days" style="width:120px" @change="load()">
        <option :value="30">最近 30 天</option><option :value="90">最近 90 天</option>
        <option :value="365">最近一年</option><option :value="3650">全部</option>
      </select>
      <button class="small" @click="load()">刷新</button>
      <span v-if="err" class="muted small">{{ err }}</span>
      <span class="muted small" style="margin-left:auto">{{ data.by_day?.length || 0 }} 天有记录</span>
    </div>

    <div class="sbody">
      <div class="cards">
        <div class="card"><div class="k">笔记总数</div><div class="v">{{ data.total_notes || 0 }}</div></div>
        <div class="card"><div class="k">总字数</div><div class="v">{{ num(data.total_words) }}</div></div>
        <div class="card"><div class="k">今日</div><div class="v">{{ data.today_words || 0 }} <small>字 / {{ data.today_notes || 0 }} 篇</small></div></div>
        <div class="card"><div class="k">连续打卡</div><div class="v">{{ data.streak_days || 0 }} <small>天</small></div></div>
        <div class="card"><div class="k">最长连续</div><div class="v">{{ data.longest_streak || 0 }} <small>天</small></div></div>
        <div class="card"><div class="k">有记录的天数</div><div class="v">{{ data.active_days || 0 }}</div></div>
      </div>

      <div class="sect">
        <div class="sh">每日写作字数</div>
        <canvas ref="cv" class="chart" />
      </div>

      <div class="sect">
        <div class="sh">按文件夹分布（顶层）</div>
        <div v-for="f in data.by_folder || []" :key="f.folder" class="frow">
          <span class="fname">{{ f.folder }}</span>
          <div class="fbar"><i :style="{ width: pctOf(f.count) + '%' }" /></div>
          <span class="fnum">{{ f.count }} 篇 · {{ num(f.words) }} 字</span>
        </div>
        <div v-if="!(data.by_folder || []).length" class="muted small">还没有数据。</div>
      </div>
    </div>
  </div>
</template>

<script setup>
// 统计插件（v1.9.41）：一张卡片墙 + 一条每日字数曲线 + 文件夹分布。
//
// 曲线用 Canvas 手画：一年 365 个点，用 div 画柱子会撑出几百个节点，Canvas 一次画完最省事。
// 数据全部来自 GET /notes/stats，它走的是预存好的 word_count 列，不会去扫正文。
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { api } from '../../api';

const props = defineProps({ stats: { type: Object, default: null } });
const emit = defineEmits(['loaded']);

const days = ref(90);
const data = ref({});
const err = ref('');
const cv = ref(null);
let ro = null;

const maxCount = computed(() => Math.max(1, ...(data.value.by_folder || []).map((f) => f.count || 0)));
const pctOf = (c) => Math.round(((c || 0) / maxCount.value) * 100);
const num = (n) => Number(n || 0).toLocaleString('en-US');

async function load() {
  err.value = '';
  try {
    data.value = await api.get(`/notes/stats?days=${days.value}`);
    emit('loaded', data.value);
  } catch (e) { err.value = e.message; }
  await nextTick();
  draw();
}

function draw() {
  const c = cv.value;
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth || 600, h = c.clientHeight || 160;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const rows = data.value.by_day || [];
  if (!rows.length) return;
  const max = Math.max(1, ...rows.map((r) => r.w || 0));
  const pad = { l: 6, r: 6, t: 8, b: 18 };
  const iw = Math.max(1, w - pad.l - pad.r), ih = h - pad.t - pad.b;
  const x = (i) => pad.l + (rows.length === 1 ? iw / 2 : (i / (rows.length - 1)) * iw);
  const y = (v) => pad.t + ih - (Number(v) || 0) / max * ih;

  g.strokeStyle = 'rgba(127,140,160,.25)';
  g.lineWidth = 1;
  g.beginPath(); g.moveTo(pad.l, y(0)); g.lineTo(w - pad.r, y(0)); g.stroke();

  g.beginPath();
  rows.forEach((r, i) => (i ? g.lineTo(x(i), y(r.w)) : g.moveTo(x(i), y(r.w))));
  g.strokeStyle = 'hsl(212 62% 58%)';
  g.lineWidth = 1.6;
  g.stroke();
  g.lineTo(x(rows.length - 1), y(0)); g.lineTo(x(0), y(0)); g.closePath();
  g.fillStyle = 'rgba(79,124,247,.14)';
  g.fill();

  g.fillStyle = 'rgba(150,160,175,.9)';
  g.font = '10px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
  g.textBaseline = 'top';
  g.textAlign = 'left';
  g.fillText(String(rows[0].d || ''), pad.l, h - 14);
  g.textAlign = 'right';
  g.fillText(String(rows[rows.length - 1].d || ''), w - pad.r, h - 14);
  g.textAlign = 'left';
  g.fillText('峰值 ' + num(max) + ' 字/天', pad.l + 2, pad.t);
}

watch(() => props.stats, (v) => { if (v && Object.keys(v).length && !Object.keys(data.value).length) data.value = v; });
onMounted(async () => {
  if (props.stats && Object.keys(props.stats).length) data.value = props.stats;
  await load();
  ro = new ResizeObserver(() => draw());
  if (cv.value) ro.observe(cv.value);
});
onBeforeUnmount(() => { if (ro) ro.disconnect(); });
defineExpose({ load });
</script>

<style scoped>
.st { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.stop { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 8px; }
.sbody { flex: 1; min-height: 0; overflow-y: auto; padding-right: 4px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 8px; }
.card { border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: var(--bg2); }
.card .k { font-size: 11.5px; color: var(--text3); }
.card .v { font-size: 20px; font-weight: 600; font-variant-numeric: tabular-nums; }
.card .v small { font-size: 11.5px; font-weight: 400; color: var(--text3); }
.sect { margin-top: 14px; }
.sh { font-size: 12.5px; color: var(--text2); margin-bottom: 6px; }
.chart { width: 100%; height: 160px; display: block; border: 1px solid var(--border); border-radius: 8px; background: var(--bg2); }
.frow { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 12.5px; }
.fname { width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fbar { flex: 1; height: 8px; background: var(--bg3); border-radius: 4px; overflow: hidden; }
.fbar i { display: block; height: 100%; background: var(--accent); opacity: .8; }
.fnum { width: 140px; text-align: right; color: var(--text3); font-variant-numeric: tabular-nums; }
</style>
