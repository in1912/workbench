<template>
  <div class="records">
    <div v-if="users && users.length" class="rc-picker">
      <span>查看成员：</span>
      <select v-model="uid" @change="load">
        <option :value="me.id">{{ me.name }}（自己）</option>
        <option v-for="u in users.filter((x) => x.id !== me.id)" :key="u.id" :value="u.id">{{ u.name }}</option>
      </select>
    </div>

    <div class="rc-cards">
      <div class="rc-card"><b>{{ fmtDur(totals.seconds) }}</b><span>累计练习时长</span></div>
      <div class="rc-card"><b>{{ totals.correct }}</b><span>累计打对（字/字母）</span></div>
      <div class="rc-card"><b>{{ totals.wrong }}</b><span>累计打错（1个扣3个）</span></div>
      <div class="rc-card"><b :class="{ neg: totals.net < 0 }">{{ totals.net ?? 0 }}</b><span>有效字数（打对−3×打错）</span></div>
      <div class="rc-card"><b>{{ totals.accuracy == null ? '—' : totals.accuracy + '%' }}</b><span>平均正确率</span></div>
    </div>

    <!-- 打字每日记录（默认 15 行，可 15/30/50 翻页） -->
    <table class="rc-table">
      <thead>
        <tr><th>序号</th><th>日期</th><th>练习时长</th><th>打对</th><th>打错</th><th>有效字数</th><th>正确率</th></tr>
      </thead>
      <tbody>
        <tr v-for="(d, i) in pageList" :key="d.day">
          <td>{{ (page - 1) * pageSize + i + 1 }}</td>
          <td>{{ d.day }}<span v-if="d.day === today" class="today">今天</span></td>
          <td>{{ fmtDur(d.seconds) }}</td>
          <td class="ok">{{ d.correct }}</td>
          <td class="bad">{{ d.wrong }}</td>
          <td :class="d.net < 0 ? 'bad' : 'ok'">{{ d.net }}</td>
          <td>{{ d.correct + d.wrong ? Math.round(d.correct / (d.correct + d.wrong) * 100) + '%' : '—' }}</td>
        </tr>
        <tr v-if="!days.length"><td colspan="7" class="empty">最近 {{ range }} 天还没有练习记录，去「打字」打一局吧～</td></tr>
      </tbody>
    </table>
    <div v-if="days.length" class="rc-pager">
      <span class="muted" style="font-size:12px">共 {{ days.length }} 条</span>
      <span class="grow"></span>
      <button class="small" :disabled="page <= 1" @click="page--">‹ 上一页</button>
      <span class="muted" style="font-size:12px">{{ page }} / {{ totalPages }}</span>
      <button class="small" :disabled="page >= totalPages" @click="page++">下一页 ›</button>
      <select v-model.number="pageSize" title="每页条数">
        <option :value="15">15 行</option><option :value="30">30 行</option><option :value="50">50 行</option>
      </select>
    </div>

    <!-- 赊账兑换列表（只读；勾选平账在「兑现登记」里操作） -->
    <div class="credit-box">
      <h3>赊账兑换 <span class="muted" style="font-size:12px; font-weight:400">只读查看 · 平账勾选请到「兑现登记」</span></h3>
      <table class="rc-table">
        <thead>
          <tr><th>序号</th><th>日期时间</th><th>成员</th><th>月份</th><th>金额</th><th>内容</th><th>备注</th><th>凭证</th><th>状态</th></tr>
        </thead>
        <tbody>
          <tr v-for="(c, i) in creditPageList" :key="c.id" :class="{ settled: c.settled }">
            <td>{{ (creditPage - 1) * creditSize + i + 1 }}</td>
            <td :class="{ strike: c.settled }">{{ c.created_at }}</td>
            <td :class="{ strike: c.settled }">{{ c.user_name }}</td>
            <td :class="{ strike: c.settled }">{{ c.period }}</td>
            <td :class="{ strike: c.settled }" class="bad">¥{{ Number(c.amount).toFixed(2) }}</td>
            <td :class="{ strike: c.settled }">{{ c.content || '—' }}</td>
            <td :class="{ strike: c.settled }">{{ c.note || '—' }}</td>
            <td>
              <div v-if="c.image_id" class="mini-img" title="点击放大" @click="zoomId = c.image_id"><img :src="imgUrl(c.image_id)" alt="凭证" /></div>
              <span v-else class="muted">—</span>
            </td>
            <td>
              <span v-if="c.settled" class="badge ok">已平账{{ c.settled_at ? ' · ' + c.settled_at : '' }}</span>
              <span v-else class="badge wait">待兑现</span>
            </td>
          </tr>
          <tr v-if="!creditRows.length"><td colspan="9" class="empty">暂无赊账兑换记录</td></tr>
        </tbody>
      </table>
      <div v-if="creditRows.length" class="rc-pager">
        <span class="muted" style="font-size:12px">共 {{ creditTotal }} 条</span>
        <span class="grow"></span>
        <button class="small" :disabled="creditPage <= 1" @click="loadCredit(creditPage - 1)">‹ 上一页</button>
        <span class="muted" style="font-size:12px">{{ creditPage }} / {{ creditTotalPages }}</span>
        <button class="small" :disabled="creditPage >= creditTotalPages" @click="loadCredit(creditPage + 1)">下一页 ›</button>
        <select v-model.number="creditSize" title="每页条数" @change="loadCredit(1)">
          <option :value="15">15 行</option><option :value="30">30 行</option><option :value="50">50 行</option>
        </select>
      </div>
    </div>

    <!-- 凭证图片放大查看（点击图片/遮罩/Esc 关闭） -->
    <div v-if="zoomId" class="modal-backdrop" @click.self="zoomId = null">
      <img class="zoom-img" :src="imgUrl(zoomId)" alt="凭证" @click="zoomId = null" />
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from '../api';

const days = ref([]);
const totals = ref({ seconds: 0, correct: 0, wrong: 0, net: 0, accuracy: null });
const users = ref(null);
const uid = ref(0);
const range = 366; // 拉一年，翻页才有内容
const today = new Date().toLocaleDateString('sv').slice(0, 10);
const me = computed(() => {
  const u = JSON.parse(localStorage.getItem('wb_user') || 'null');
  return { id: u ? u.id : 0, name: '自己' };
});

// ---------- 打字列表分页（15/30/50，客户端切页） ----------
const page = ref(1);
const pageSize = ref(15);
const totalPages = computed(() => Math.max(1, Math.ceil(days.value.length / pageSize.value)));
const pageList = computed(() => days.value.slice((Math.min(page.value, totalPages.value) - 1) * pageSize.value, Math.min(page.value, totalPages.value) * pageSize.value));
watch(pageSize, () => { page.value = 1; });

// ---------- 赊账兑换只读列表（服务端分页） ----------
const creditRows = ref([]);
const creditTotal = ref(0);
const creditPage = ref(1);
const creditSize = ref(15);
const creditTotalPages = computed(() => Math.max(1, Math.ceil(creditTotal.value / creditSize.value)));
const creditPageList = computed(() => creditRows.value);
const imgUrl = (id) => `/api/family-images/${id}?token=${encodeURIComponent(localStorage.getItem('wb_token') || '')}`;
// 凭证缩略图点击放大（Esc 关闭）
const zoomId = ref(null);
const onZoomKey = (e) => { if (e.key === 'Escape') zoomId.value = null; };
onMounted(() => window.addEventListener('keydown', onZoomKey));
onUnmounted(() => window.removeEventListener('keydown', onZoomKey));
async function loadCredit(p = 1) {
  creditPage.value = p;
  try {
    const r = await api.get(`/credit/list?page=${p}&pageSize=${creditSize.value}`);
    creditRows.value = r.rows || [];
    creditTotal.value = r.total || 0;
  } catch { creditRows.value = []; creditTotal.value = 0; }
}

function fmtDur(sec) {
  if (!sec) return '0 分';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} 分`;
  return `${Math.floor(m / 60)} 时 ${m % 60} 分`;
}

async function load() {
  const q = uid.value && uid.value !== me.value.id ? `?user_id=${uid.value}&days=${range}` : `?days=${range}`;
  const d = await api.get('/typing/records' + q);
  days.value = d.days || [];
  totals.value = d.totals || { seconds: 0, correct: 0, wrong: 0, net: 0, accuracy: null };
  users.value = d.users || null;
  if (!uid.value) uid.value = d.user_id;
  page.value = 1;
}
onMounted(() => { load(); loadCredit(1); });
</script>

<style scoped>
.rc-picker { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text2); margin-bottom: 12px; }
.rc-picker select { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 3px 8px; }
.rc-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 14px; }
.rc-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 14px; text-align: center; display: flex; flex-direction: column; gap: 4px; }
.rc-card b { font-size: 20px; color: var(--amber); }
.rc-card b.neg { color: var(--red); }
.rc-card span { font-size: 12px; color: var(--text3); }
.rc-table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
.rc-table th { text-align: left; color: var(--text3); font-weight: 500; font-size: 12.5px; padding: 6px 10px; border-bottom: 1.5px solid var(--border); white-space: nowrap; }
.rc-table td { padding: 8px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.rc-table .ok { color: var(--green); font-weight: 600; }
.rc-table .bad { color: var(--red); }
.today { font-size: 11px; color: var(--accent); margin-left: 6px; border: 1px solid var(--accent); border-radius: 6px; padding: 0 5px; }
.rc-pager { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.rc-pager .small { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 5px 12px; font-size: 12.5px; cursor: pointer; }
.grow { flex: 1; }
.muted { color: var(--text3); }
.credit-box { margin-top: 18px; border-top: 1.5px dashed var(--border); padding-top: 12px; }
.credit-box h3 { margin-bottom: 8px; }
.strike { text-decoration: line-through; color: var(--text3); }
.badge { font-size: 11px; border-radius: 10px; padding: 1px 8px; }
.badge.ok { background: rgba(46, 158, 91, .12); color: var(--green); }
.badge.wait { background: rgba(251, 191, 36, .15); color: #b7791f; }
.mini-img { width: 44px; height: 44px; border-radius: 8px; overflow: hidden; cursor: zoom-in; background: var(--bg3);
  display: flex; align-items: center; justify-content: center; flex: none; }
.mini-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
.zoom-img { max-width: 92vw; max-height: 84vh; border-radius: 12px; box-shadow: 0 10px 40px rgba(0, 0, 0, .4); cursor: zoom-out; }
</style>
