<template>
  <div class="holiday-cal">
    <div class="row" style="justify-content:space-between; margin-bottom:8px; align-items:center">
      <span style="font-size:14px; font-weight:600; cursor:pointer" @click="changeMonth(0)">{{ year }}年{{ month }}月</span>
      <span class="row" style="gap:4px">
        <button class="small" @click="changeMonth(-1)">‹</button>
        <button class="small" @click="goToday">今</button>
        <button class="small" @click="changeMonth(1)">›</button>
      </span>
    </div>
    <div class="cal-head">
      <span v-for="d in weekLabels" :key="d" class="cal-lbl" :class="{ weekend: isWeekendLbl(d) }">{{ d }}</span>
    </div>
    <div class="cal-body">
      <div v-for="(cell, i) in cells" :key="i" class="cal-cell" :class="{
        blank: !cell, today: cell && cell.isToday, holiday: cell && cell.isHoliday, workday: cell && cell.isWorkday, bday: cell && cell.isBirthday
      }" :title="cell ? '点击到「待办与日程 → 日历」' : ''" @click="cell && gotoSchedule(cell.fullDate)">
        <span v-if="cell" class="cal-top">
          <span class="cal-day">{{ cell.day }}</span>
          <span v-if="cell.lunarLabel" class="cal-lunar" :class="{ term: cell.isTerm, first: cell.isLunarFirst }">{{ cell.lunarLabel }}</span>
        </span>
        <span v-if="cell && cell.holidayName" class="cal-name" :title="cell.fullDate + ' ' + cell.holidayName">{{ cell.holidayName }}</span>
        <span v-if="cell && cell.birthdayText" class="cal-bday" :title="cell.fullDate + ' ' + cell.birthdayText">🎂 {{ cell.birthdayText }}</span>
      </div>
    </div>
    <div class="row" style="gap:10px; margin-top:8px; font-size:11px; color:var(--text3); flex-wrap:wrap">
      <span><span class="dot dot-h"></span> 放假</span>
      <span><span class="dot dot-w"></span> 补班</span>
      <span><span class="dot dot-t"></span> 今天</span>
      <span><span class="dot dot-b"></span> 家人生日</span>
      <span class="jump-hint">点击日期 → 日程日历</span>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';

const router = useRouter();

const year = ref(new Date().getFullYear());
const month = ref(new Date().getMonth() + 1);
const holidays = ref({});
const lunarMap = ref({});   // { 'MM-DD': { lunar, term } }
const birthdays = ref([]);  // [{ name, date, lunarText }]
const weekStart = ref('monday');

const weekLabels = computed(() => {
  if (weekStart.value === 'sunday') return ['日','一','二','三','四','五','六'];
  return ['一','二','三','四','五','六','日'];
});
function isWeekendLbl(d) { return d === '日' || d === '六'; }

const todayStr = (() => {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
})();

// 生日按公历日期索引：{ 'YYYY-MM-DD': '张三(妈妈)' }
const bdayMap = computed(() => {
  const m = {};
  for (const b of birthdays.value) m[b.date] = b.relation ? `${b.name}·${b.relation}` : b.name;
  return m;
});

const cells = computed(() => {
  const first = new Date(year.value, month.value - 1, 1);
  let startDow = first.getDay(); // 0=Sun
  if (weekStart.value === 'monday') startDow = (startDow + 6) % 7;
  const daysInMonth = new Date(year.value, month.value, 0).getDate();
  const arr = [];
  for (let i = 0; i < startDow; i++) arr.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const mm = String(month.value).padStart(2,'0');
    const dd = String(d).padStart(2,'0');
    const fullDate = `${year.value}-${mm}-${dd}`;
    const h = holidays.value[`${mm}-${dd}`];
    const lu = lunarMap.value[`${mm}-${dd}`];
    const bday = bdayMap.value[fullDate];
    arr.push({
      day: d, fullDate,
      isToday: fullDate === todayStr,
      holidayName: h ? h.name : '',
      isHoliday: h ? h.holiday : false,
      isWorkday: h ? !h.holiday : false,
      // 农历标签：节气优先（绿色），初一显示月名，其余日名
      lunarLabel: lu ? (lu.term || lu.lunar) : '',
      isTerm: !!(lu && lu.term),
      isLunarFirst: !!(lu && /^(正|二|三|四|五|六|七|八|九|十|冬|腊|闰)/.test(lu.lunar || '')),
      birthdayText: bday || '',
      isBirthday: !!bday,
    });
  }
  while (arr.length % 7 !== 0) arr.push(null);
  return arr;
});

function changeMonth(delta) {
  let m = month.value + delta;
  let y = year.value;
  if (m < 1) { m = 12; y--; }
  if (m > 12) { m = 1; y++; }
  year.value = y; month.value = m;
  loadHolidays();
}
function goToday() {
  const n = new Date();
  year.value = n.getFullYear(); month.value = n.getMonth() + 1;
  loadHolidays();
}

// 点击日期 → 「待办与日程 → 日历」对应月份（看板日历只读，登记日程去那边）
function gotoSchedule(fullDate) {
  router.push(`/tasks?tab=cal&month=${fullDate.slice(0, 7)}`);
}

let lunarYearCache = '';
async function loadHolidays() {
  try {
    const d = await api.get(`/holidays?year=${year.value}`);
    holidays.value = d.holidays || {};
  } catch (e) { holidays.value = {}; }
  // 农历+生日整年数据（缓存当年，避免重复拉）
  if (lunarYearCache !== String(year.value)) {
    try {
      const l = await api.get(`/lunar/year?year=${year.value}`);
      lunarMap.value = l.lunar || {};
      birthdays.value = l.birthdays || [];
      lunarYearCache = String(year.value);
    } catch { lunarMap.value = {}; birthdays.value = []; }
  }
}

onMounted(async () => {
  try {
    const c = await api.get('/calendar/config');
    weekStart.value = c.weekStart || 'monday';
  } catch {}
  loadHolidays();
});
</script>

<style scoped>
.holiday-cal { font-size: 12px; }
.cal-head { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; margin-bottom: 4px; }
.cal-lbl { text-align: center; font-size: 11px; color: var(--text3); }
.cal-lbl.weekend { color: var(--red); }
.cal-body { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
.cal-cell { height: 44px; border-radius: 4px; display: flex; flex-direction: column; align-items: center; justify-content: center; position: relative; background: var(--bg3); overflow: hidden; }
.cal-cell.blank { background: transparent; }
.cal-cell:not(.blank) { cursor: pointer; }
.cal-cell:not(.blank):hover { outline: 1px solid var(--accent); }
.jump-hint { margin-left: auto; color: var(--accent); opacity: .75; }
.cal-cell.today { outline: 1.5px solid var(--accent); }
.cal-cell.holiday { background: rgba(52,211,153,.15); }
.cal-cell.workday { background: rgba(251,191,36,.15); }
.cal-cell.bday { outline: 1.5px dashed rgba(232, 120, 180, .55); }
.cal-top { display: flex; align-items: baseline; gap: 3px; }
.cal-day { font-size: 11px; color: var(--text2); line-height: 1; }
.cal-cell.today .cal-day { color: var(--accent); font-weight: 700; }
.cal-lunar { font-size: 9px; color: var(--text3); line-height: 1; }
.cal-lunar.term { color: var(--green); }
.cal-lunar.first { color: var(--text2); }
.cal-name { font-size: 9px; color: var(--text3); line-height: 1.2; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 2px; }
.cal-cell.holiday .cal-name { color: var(--green); }
.cal-cell.workday .cal-name { color: var(--amber); }
.cal-bday { font-size: 9px; color: #e878b4; line-height: 1.2; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 0 2px; }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 3px; }
.dot-h { background: rgba(52,211,153,.5); }
.dot-w { background: rgba(251,191,36,.5); }
.dot-t { background: var(--accent); }
.dot-b { background: rgba(232,120,180,.55); }
</style>
