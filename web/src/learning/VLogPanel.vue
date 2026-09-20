<template>
  <div class="vlog">
    <!-- 学时看板 -->
    <div class="stat-row">
      <div class="card stat">
        <div class="stat-head">⏱ 累计学时 <b>{{ stats.total_hours.toFixed(1) }}</b> 小时</div>
        <div class="stat-grid">
          <div class="stat-col">
            <div class="col-title">学年学时</div>
            <div v-for="y in stats.by_year" :key="y.name" class="s-row">
              <span class="s-name">{{ y.name }}</span>
              <div class="s-bar"><div class="s-fill" :style="{ width: pct(y.hours, stats.by_year[0]?.hours) }"></div></div>
              <span class="s-val">{{ y.hours.toFixed(1) }}h</span>
            </div>
            <div v-if="!stats.by_year.length" class="empty-sm">暂无记录</div>
          </div>
          <div class="stat-col">
            <div class="col-title">学科学时</div>
            <div v-for="s in stats.by_subject" :key="s.name" class="s-row">
              <span class="s-name">{{ s.name }}</span>
              <div class="s-bar"><div class="s-fill alt" :style="{ width: pct(s.hours, stats.by_subject[0]?.hours) }"></div></div>
              <span class="s-val">{{ s.hours.toFixed(1) }}h</span>
            </div>
            <div v-if="!stats.by_subject.length" class="empty-sm">暂无记录</div>
          </div>
        </div>
      </div>
    </div>

    <!-- 学习记录表 -->
    <div class="card">
      <h3>学习记录 <span class="muted" style="font-size:12px; font-weight:400">视频按观看进度展示，文档按打开时间展示</span></h3>
      <table class="rec-table">
        <thead>
          <tr>
            <th style="width:46px">序号</th>
            <th style="width:90px">姓名</th>
            <th style="width:110px">学年</th>
            <th style="width:80px">学科</th>
            <th>文件（NAS 完整路径）</th>
            <th style="width:220px">进度 / 打开时间</th>
            <th style="width:120px">最后学习</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in records" :key="r.id">
            <td class="c">{{ (page - 1) * pageSize + i + 1 }}</td>
            <td>{{ r.user_name }}</td>
            <td><span class="badge blue">{{ r.school_year || '—' }}</span></td>
            <td><span class="badge amber">{{ r.subject || '—' }}</span></td>
            <td class="path" :title="r.path"><span class="k">{{ r.kind === 'media' ? '🎬' : '📄' }}</span> {{ r.path }}</td>
            <td>
              <div v-if="r.kind === 'media'" class="prog">
                <div class="p-bar"><div class="p-fill" :style="{ width: progress(r) + '%' }"></div></div>
                <span class="p-txt">{{ progress(r) }}% · {{ mins(r.position_sec) }}/{{ mins(r.duration_sec) }} 分钟</span>
              </div>
              <span v-else class="muted">打开于 {{ (r.opened_at || '').slice(0, 16) }}</span>
            </td>
            <td class="c muted">{{ (r.updated_at || '').slice(5, 16) }}</td>
          </tr>
          <tr v-if="!records.length"><td colspan="7"><div class="empty">暂无学习记录，去「视频教学」开始学习吧</div></td></tr>
        </tbody>
      </table>

      <!-- 分页：15/30/50 可选 + 上一页/下一页 -->
      <div class="pager">
        <span class="muted">共 {{ total }} 条</span>
        <label>每页
          <select v-model.number="pageSize" @change="page = 1; load()">
            <option :value="15">15</option><option :value="30">30</option><option :value="50">50</option>
          </select> 行
        </label>
        <button class="small" :disabled="page <= 1" @click="page--; load()">← 上一页</button>
        <span>第 {{ page }} / {{ totalPages || 1 }} 页</span>
        <button class="small" :disabled="page >= totalPages" @click="page++; load()">下一页 →</button>
      </div>
    </div>
  </div>
</template>

<script setup>
// 视频学习记录：本人记录列表（分页）+ 学年/学科学时看板
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';

const records = ref([]);
const stats = ref({ by_year: [], by_subject: [], total_hours: 0 });
const page = ref(1);
const pageSize = ref(15);
const total = ref(0);
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

const pct = (h, max) => (max > 0 ? Math.max(3, Math.round((h / max) * 100)) : 0);
const progress = (r) => (r.duration_sec > 0 ? Math.min(100, Math.round((r.position_sec / r.duration_sec) * 100)) : 0);
const mins = (sec) => Math.round((sec || 0) / 60);

async function load() {
  try {
    const r = await api.get(`/vstudy/records?page=${page.value}&pageSize=${pageSize.value}`);
    records.value = r.records || [];
    total.value = r.total || 0;
    if (page.value > totalPages.value) { page.value = totalPages.value; return load(); }
  } catch (e) { records.value = []; }
  try { stats.value = await api.get('/vstudy/stats'); } catch { /* 看板失败不拦列表 */ }
}
onMounted(load);
</script>

<style scoped>
.vlog { display: flex; flex-direction: column; gap: 12px; }
.stat-head { font-size: 14.5px; margin-bottom: 12px; }
.stat-head b { font-size: 19px; color: var(--amber); }
.stat-grid { display: flex; gap: 26px; flex-wrap: wrap; }
.stat-col { flex: 1; min-width: 260px; }
.col-title { font-size: 13px; color: var(--text3); margin-bottom: 8px; }
.s-row { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; font-size: 12.5px; }
.s-name { width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text2); flex-shrink: 0; }
.s-bar { flex: 1; height: 8px; border-radius: 5px; background: var(--bg3); border: 1px solid var(--border); overflow: hidden; }
.s-fill { height: 100%; background: var(--amber); }
.s-fill.alt { background: var(--accent); }
.s-val { width: 48px; text-align: right; color: var(--text3); flex-shrink: 0; }
.empty-sm { font-size: 12.5px; color: var(--text3); padding: 4px 0; }
.rec-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.rec-table th { text-align: left; font-size: 12.5px; color: var(--text3); font-weight: 500; padding: 7px 8px; border-bottom: 1px solid var(--border); }
.rec-table td { padding: 9px 8px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.rec-table .c { text-align: center; }
.rec-table .path { max-width: 340px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: ltr; }
.rec-table .path .k { margin-right: 4px; }
.prog { display: flex; flex-direction: column; gap: 3px; }
.p-bar { height: 9px; border-radius: 5px; background: var(--bg3); border: 1px solid var(--border); overflow: hidden; }
.p-fill { height: 100%; background: linear-gradient(90deg, var(--amber), #f0b13a); }
.p-txt { font-size: 11.5px; color: var(--text3); }
.pager { display: flex; align-items: center; gap: 14px; margin-top: 12px; font-size: 13px; flex-wrap: wrap; }
.pager select { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 4px 8px; }
.small { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 5px 12px; font-size: 13px; cursor: pointer; }
.small:disabled { opacity: .5; cursor: default; }
.muted { color: var(--text3); }
</style>
