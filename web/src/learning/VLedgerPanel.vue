<template>
  <div class="vledger">
    <!-- 统计看板：生效/扣减（历史 + 本月），默认当前用户，可下拉切换成员 -->
    <div class="stat-row">
      <div class="stat ok"><div class="v">{{ fmtDur(stats.hist_eff) }}</div><div class="k">历史有效时长</div></div>
      <div class="stat ok"><div class="v">{{ fmtDur(stats.month_eff) }}</div><div class="k">本月有效时长</div></div>
      <div class="stat bad"><div class="v">{{ fmtDur(stats.hist_bad) }}</div><div class="k">历史无效时长</div></div>
      <div class="stat bad"><div class="v">{{ fmtDur(stats.month_bad) }}</div><div class="k">本月无效时长</div></div>
      <div class="stat tool">
        <div class="k" style="margin-bottom:6px">查看成员</div>
        <select v-model.number="uid" style="width:150px" @change="load(1)">
          <option v-for="u in users" :key="u.id" :value="u.id">{{ u.name }}</option>
        </select>
      </div>
    </div>

    <!-- 流水明细：生效与扣减各有独立流水行 -->
    <div class="card list">
      <h3>学时流水明细 <span class="muted" style="font-size:12px; font-weight:400">视频教学的全部学时增减账：生效与扣减（注意力检测未确认）分列记账</span></h3>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>序号</th><th>日期</th><th>用户</th><th>类型</th><th>时长</th>
              <th>文件路径</th><th>学年</th><th>科目</th><th>开始时间</th><th>关闭时间</th><th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in rows" :key="r.id" :class="{ pen: r.entry_type === 'penalty' }">
              <td>{{ (page - 1) * pageSize + i + 1 }}</td>
              <td>{{ dPart(r.created_at) }}</td>
              <td>{{ r.user_name || '—' }}</td>
              <td>
                <span class="badge" :class="r.entry_type === 'penalty' ? 'red' : 'green'">{{ r.entry_type === 'penalty' ? '扣减' : '生效' }}</span>
                <span v-if="r.complete" class="badge blue" title="观看了视频时长的 90% 以上">完整</span>
              </td>
              <td class="dur" :class="{ neg: r.delta_sec < 0 }">{{ fmtDur(Math.abs(r.delta_sec)) }}</td>
              <td class="path" :title="r.path">{{ r.path || '—' }}</td>
              <td>{{ r.school_year || '—' }}</td>
              <td>{{ r.subject || '—' }}</td>
              <td>{{ tPart(r.started_at) || '—' }}</td>
              <td>{{ tPart(r.ended_at) || '—' }}</td>
              <td class="reason">{{ r.reason || '' }}</td>
            </tr>
          </tbody>
        </table>
        <div v-if="!rows.length && !loading" class="empty">暂无学时流水，去「视频教学」开始学习吧</div>
      </div>
      <div class="row foot">
        <span class="muted" style="font-size:12px">共 {{ total }} 条</span>
        <span class="grow"></span>
        <button class="small" :disabled="page <= 1" @click="load(page - 1)">‹ 上一页</button>
        <span class="muted" style="font-size:12px">{{ page }} / {{ totalPages }}</span>
        <button class="small" :disabled="page >= totalPages" @click="load(page + 1)">下一页 ›</button>
        <select v-model.number="pageSize" title="每页条数" @change="load(1)">
          <option :value="15">15 行</option><option :value="30">30 行</option><option :value="50">50 行</option>
        </select>
      </div>
    </div>
  </div>
</template>

<script setup>
// 学时记账：视频教学全部学时流水的流水账（生效/扣减明细 + 有效无效看板）
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';

const me = () => { try { return JSON.parse(localStorage.getItem('wb_user') || 'null'); } catch { return null; } };
const uid = ref((me() || {}).id || 0);
const users = ref([]);
const rows = ref([]);
const page = ref(1);
const pageSize = ref(15);
const total = ref(0);
const loading = ref(false);
const stats = ref({ hist_eff: 0, month_eff: 0, hist_bad: 0, month_bad: 0 });
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));

async function load(p = 1) {
  loading.value = true;
  page.value = p;
  try {
    const r = await api.get(`/vstudy/ledger?page=${p}&pageSize=${pageSize.value}&user_id=${uid.value}`);
    rows.value = r.rows || [];
    total.value = r.total || 0;
    stats.value = r.stats || stats.value;
    if (Array.isArray(r.users) && r.users.length) users.value = r.users;
  } catch (e) {
    rows.value = []; total.value = 0;
  }
  loading.value = false;
}

const dPart = (t) => String(t || '').slice(0, 10);
const tPart = (t) => String(t || '').slice(11, 19);
function fmtDur(s) {
  const v = Math.round(Number(s) || 0);
  if (v < 60) return `${v} 秒`;
  if (v < 3600) return `${Math.floor(v / 60)} 分 ${v % 60} 秒`;
  return `${(v / 3600).toFixed(1)} 小时`;
}

onMounted(() => load(1));
</script>

<style scoped>
.stat-row { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 12px; }
.stat { flex: 1; min-width: 150px; background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
.stat .v { font-size: 20px; font-weight: 700; }
.stat .k { font-size: 12.5px; color: var(--text3); margin-top: 4px; }
.stat.ok .v { color: var(--green, #2e9e5b); }
.stat.bad .v { color: var(--red, #e5484d); }
.stat.tool { flex: 0 0 auto; min-width: 190px; display: flex; flex-direction: column; justify-content: center; }
.list { padding: 16px 18px; }
.list h3 { margin-bottom: 10px; }
.tbl-wrap { overflow-x: auto; }
.tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.tbl th { text-align: left; font-weight: 500; color: var(--text3); padding: 6px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.tbl td { padding: 7px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.tbl tr.pen td { background: rgba(229, 72, 77, 0.05); }
.dur { font-weight: 600; }
.dur.neg { color: var(--red, #e5484d); }
.path { max-width: 300px; overflow: hidden; text-overflow: ellipsis; }
.reason { max-width: 220px; overflow: hidden; text-overflow: ellipsis; color: var(--text3); }
.badge.red { background: #e5484d; color: #fff; border-radius: 10px; padding: 1px 8px; font-size: 11px; }
.badge.green { background: #2e9e5b; color: #fff; border-radius: 10px; padding: 1px 8px; font-size: 11px; }
.badge.blue { background: rgba(79, 124, 247, .15); color: var(--accent, #4f7cf7); border-radius: 10px; padding: 1px 8px; font-size: 11px; margin-left: 4px; }
.foot { margin-top: 10px; align-items: center; gap: 8px; }
.small { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 6px 14px; font-size: 13px; cursor: pointer; }
.grow { flex: 1; }
.muted { color: var(--text3); }
</style>
