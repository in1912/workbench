<template>
  <div class="money">
    <div class="mn-head">
      <div class="mn-nav">
        <button @click="shiftMonth(-1)">‹</button>
        <b>{{ month }}</b>
        <button :disabled="month === nowMonth" @click="shiftMonth(1)">›</button>
      </div>
      <select v-if="users && users.length" v-model="uid" @change="load">
        <option v-for="u in users" :key="u.id" :value="u.id">{{ u.name }}{{ u.id === myId ? '（自己）' : '' }}</option>
      </select>
    </div>

    <!-- 合并统计：打字 + 视频教学学时 + 练琴（奖励/兑现均为三类合计） -->
    <div class="mn-cards">
      <div class="mn-card"><b>{{ fmtDur(totals.seconds) }}</b><span>本月打字练习时长</span></div>
      <div class="mn-card"><b :class="{ neg: totals.net < 0 }">{{ totals.net ?? 0 }} 字</b><span>本月有效字数（打对−3×打错）</span></div>
      <div class="mn-card blue"><b>{{ fmtDur(totals.video_hist_sec) }}</b><span>历史视频学时</span></div>
      <div class="mn-card blue"><b>{{ fmtDur(totals.video_month_sec) }}</b><span>本月视频学时</span></div>
      <div class="mn-card vio"><b>{{ fmtDur(totals.piano_total_sec) }}</b><span>练琴累计总练习时长</span></div>
      <div class="mn-card vio"><b>{{ fmtDur(totals.piano_month_sec) }}</b><span>练琴本月练习时长</span></div>
      <div class="mn-card vio"><b>{{ fmtDur(totals.piano_valid_sec) }}</b><span>练琴有效时长</span></div>
      <div class="mn-card gold"><b :class="{ neg: totals.money < 0 }">¥{{ (totals.money ?? 0).toFixed(2) }}</b><span>本月奖励（打字+视频+练琴）</span></div>
      <div class="mn-card"><b>¥{{ (totals.paid ?? 0).toFixed(2) }}</b><span>已兑现</span></div>
      <div class="mn-card hot"><b>¥{{ (totals.pending ?? 0).toFixed(2) }}</b><span>待兑现</span></div>
    </div>

    <div class="mn-calendar">
      <div v-for="w in WEEKS" :key="w" class="mn-week">{{ w }}</div>
      <div v-for="(c, i) in cells" :key="i" class="mn-day" :class="{ blank: !c, today: c && c.day === today, has: c && c.data }">
        <template v-if="c">
          <span class="d">{{ c.date }}</span>
          <template v-if="c.data">
            <b class="m" :class="{ neg: c.data.money < 0 }">¥{{ c.data.money.toFixed(2) }}</b>
            <span class="s">{{ subLines(c.data) }}</span>
          </template>
        </template>
      </div>
    </div>

    <div class="mn-rate">
      奖励标准（合计 = 打字 + 视频 + 练琴）：
      每 {{ config.reward_chars }} 个有效字 = {{ config.reward_yuan }} 元；
      视频教学每 {{ config.video_reward_minutes }} 分钟学时 = {{ config.video_reward_yuan }} 元；
      练琴每 {{ config.piano_reward_hours }} 小时有效时长 = {{ config.piano_reward_yuan }} 元
      <span class="tip">（在「兑现登记」中设置）</span>
      <template v-if="(totals.advanced ?? 0) > 0">
        <span class="adv">本月已赊账 ¥{{ totals.advanced.toFixed(2) }}（计入待兑现扣减）</span>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';

const WEEKS = ['日', '一', '二', '三', '四', '五', '六'];
const nowMonth = new Date().toLocaleDateString('sv').slice(0, 7);
const today = new Date().toLocaleDateString('sv').slice(0, 10);
const myId = (JSON.parse(localStorage.getItem('wb_user') || 'null') || {}).id;

const month = ref(nowMonth);
const uid = ref(myId || 0);
const users = ref(null);
const daysMap = ref({});
const totals = ref({ seconds: 0, correct: 0, net: 0, money: 0, paid: 0, advanced: 0, pending: 0,
  video_hist_sec: 0, video_month_sec: 0, piano_total_sec: 0, piano_month_sec: 0, piano_valid_sec: 0 });
const config = ref({ reward_chars: 100, reward_yuan: 2, video_reward_minutes: 60, video_reward_yuan: 1, piano_reward_hours: 1, piano_reward_yuan: 3 });

const cells = computed(() => {
  const [y, m] = month.value.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const start = first.getDay();
  const cnt = new Date(y, m, 0).getDate();
  const out = [];
  for (let i = 0; i < start; i++) out.push(null);
  for (let d = 1; d <= cnt; d++) {
    const day = `${month.value}-${String(d).padStart(2, '0')}`;
    out.push({ date: d, day, data: daysMap.value[day] });
  }
  return out;
});

function fmtDur(sec) {
  const mm = Math.round((sec || 0) / 60);
  if (!mm) return '0 分';
  return mm < 60 ? `${mm} 分` : `${Math.floor(mm / 60)} 时 ${mm % 60} 分`;
}
// 日历小字：打字字数 / 视频学时 / 练琴时长（只显示当天有量的项）
function subLines(d) {
  const parts = [];
  if (d.net) parts.push(`${d.net}字`);
  if (d.video_sec) parts.push(`视频${Math.round(d.video_sec / 60)}分`);
  if (d.piano_sec) parts.push(`练琴${Math.round(d.piano_sec / 60)}分`);
  if (d.seconds) parts.push(`打字${Math.round(d.seconds / 60)}分`);
  return parts.join(' · ');
}
function shiftMonth(delta) {
  const [y, m] = month.value.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  month.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  load();
}

async function load() {
  const q = [];
  if (month.value !== nowMonth) q.push('month=' + month.value);
  if (uid.value && uid.value !== myId) q.push('user_id=' + uid.value);
  const d = await api.get('/typing/summary' + (q.length ? '?' + q.join('&') : ''));
  const map = {};
  (d.days || []).forEach((x) => { map[x.day] = x; });
  daysMap.value = map;
  totals.value = { seconds: 0, correct: 0, net: 0, money: 0, paid: 0, advanced: 0, pending: 0, ...(d.totals || {}) };
  config.value = { reward_chars: 100, reward_yuan: 2, video_reward_minutes: 60, video_reward_yuan: 1, piano_reward_hours: 1, piano_reward_yuan: 3, ...(d.config || {}) };
  users.value = d.users || null;
  if (!uid.value) uid.value = d.user_id;
}
onMounted(load);
</script>

<style scoped>
.mn-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.mn-nav { display: flex; align-items: center; gap: 10px; font-size: 16px; }
.mn-nav button { background: var(--bg3); border: 1px solid var(--border); color: var(--text); width: 28px; height: 28px; border-radius: 8px; cursor: pointer; font-size: 16px; }
.mn-nav button:disabled { opacity: .4; cursor: default; }
.mn-head select { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 3px 8px; }
.mn-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 14px; }
.mn-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 12px; text-align: center; display: flex; flex-direction: column; gap: 3px; }
.mn-card b { font-size: 17px; }
.mn-card span { font-size: 11.5px; color: var(--text3); }
.mn-card.gold b { color: var(--amber); }
.mn-card.hot b { color: var(--green); }
.mn-card.blue b { color: var(--accent); }
.mn-card.vio b { color: #8b5cf6; }
.mn-calendar { display: grid; grid-template-columns: repeat(7, 1fr); gap: 5px; margin-bottom: 14px; }
.mn-week { text-align: center; font-size: 12px; color: var(--text3); padding: 4px 0; }
.mn-day { min-height: 66px; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 5px 7px; display: flex; flex-direction: column; gap: 2px; }
.mn-day.blank { background: transparent; border-color: transparent; }
.mn-day .d { font-size: 12.5px; color: var(--text2); }
.mn-day.today { border-color: var(--accent); }
.mn-day.today .d { color: var(--accent); }
.mn-day.has { border-color: rgba(251, 191, 36, .5); background: rgba(251, 191, 36, .06); }
.mn-day .m { font-size: 14px; color: var(--amber); }
.mn-day .m.neg, .mn-card b.neg { color: var(--red); }
.mn-day .s { font-size: 10.5px; color: var(--text3); line-height: 1.4; }
.mn-rate { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 13px; color: var(--text2); padding: 10px 12px; background: var(--bg2); border: 1px dashed var(--border); border-radius: 10px; }
.mn-rate .tip { color: var(--text3); font-size: 12px; }
.mn-rate .adv { color: var(--red); font-size: 12.5px; }
@media (max-width: 640px) { .mn-day { min-height: 52px; padding: 3px 4px; } .mn-day .m { font-size: 12px; } .mn-day .s { display: none; } }
</style>
