<template>
  <div>
    <h2 class="page-title">待办与日程</h2>
    <div class="tabs">
      <button v-if="canTab('tasks','cal')" :class="{active: tab==='cal'}" @click="tab='cal'">日历</button>
      <button v-if="canTab('tasks','todo')" :class="{active: tab==='todo'}" @click="tab='todo'">待办事项</button>
    </div>

    <!-- ============ 待办事项 ============ -->
    <template v-if="tab==='todo'">
      <div class="card">
        <h3>待办列表 <span class="badge blue">{{ todos.filter(t=>!t.done).length }} 项未完成</span></h3>
        <div v-for="t in todos" :key="t.id" class="list-item">
          <span class="check" :class="{done:t.done}" @click="toggle(t)">{{ t.done ? '✓' : '○' }}</span>
          <div class="grow">
            <div :class="['t', {strike:t.done}]">{{ t.title }}</div>
            <div class="d" v-if="t.desc">{{ t.desc }}</div>
            <div class="meta" v-if="t.due_date">截止：{{ t.due_date }}</div>
          </div>
          <span class="badge" :class="prioCls(t.priority)">{{ prioText(t.priority) }}</span>
          <button class="icon-btn" title="编辑" @click="editTodo(t)">✎</button>
          <button class="icon-btn" @click="remove(t)">✕</button>
        </div>
        <div v-if="!todos.length" class="empty">暂无待办</div>
      </div>
    </template>

    <!-- ============ 日历（批量登记 + 日历网格 + 弹窗） ============ -->
    <template v-else>
      <div class="card" style="margin-bottom:12px">
        <h3>批量登记 <span class="muted" style="font-size:12px">每行一条日程，回车分行；插入到所选日期的日历（默认当天）</span></h3>
        <div class="row" style="align-items:center; gap:8px; margin-bottom:8px">
          <span class="muted" style="font-size:12.5px; white-space:nowrap">日期</span>
          <input v-model="batchDate" type="date" style="width:150px" title="点选修改日程日期，默认当天" />
        </div>
        <textarea v-model="batchText" rows="5" placeholder="例如：&#10;上午 客户拜访&#10;下午 提交周报&#10;晚上 健身房" style="margin-bottom:8px"></textarea>
        <div class="row">
          <button class="primary" @click="addBatch">插入日程</button>
          <span class="muted" style="font-size:12px; align-self:center">{{ batchLines.length }} 条</span>
        </div>
      </div>
      <div class="card" style="margin-bottom:12px">
        <div class="row" style="justify-content:space-between; margin-bottom:10px">
          <button class="small" @click="shiftMonth(-1)">‹ 上月</button>
          <b>{{ calYear }} 年 {{ calMonth + 1 }} 月</b>
          <button class="small" @click="shiftMonth(1)">下月 ›</button>
        </div>
        <div class="cal-grid">
          <div v-for="w in weekLabels" :key="w" class="cal-week">{{ w }}</div>
          <div v-for="(d, i) in calDays" :key="i" class="cal-cell"
               :class="{ 'cal-empty': !d, 'cal-today': d === todayStr, 'cal-has': d && (dayEvents[d] || []).length, 'cal-holiday': d && isHolidayDate(d), 'cal-workday': d && isWorkdayDate(d) }"
               @click="d && openAdd(d)">
            <div class="cal-day">
              {{ d ? Number(d.slice(8)) : '' }}
              <span v-if="d && lunarOf(d)" class="cal-lunar" :class="{ term: lunarOf(d).term }">{{ lunarOf(d).term || lunarOf(d).lunar }}</span>
              <span v-if="d && holidayInfo(d)" class="cal-hol-name" :title="holidayInfo(d).desc || holidayInfo(d).name">{{ holidayInfo(d).name }}</span>
            </div>
            <div v-if="d && bdayOf(d)" class="cal-bday-row">🎂 {{ bdayOf(d) }}</div>
            <div v-for="c in cardsOf(d)" :key="c.name" class="cal-card-evt" :class="c.type">
              {{ c.type === 'bill' ? '🧾' : '💳' }} {{ c.name }}
            </div>
            <div v-if="d" class="cal-evts">
              <div v-for="e in (dayEvents[d] || []).slice(0, 3)" :key="e.id" class="cal-evt"
                   :class="evtCls(e, d)" :title="evtTitle(e, d)" @click.stop="openEdit(e)">
                <span v-if="spanMark(e, d) === 'start'" class="cal-span-start">▶</span>
                <span v-if="isShared(e)" class="cal-shared" title="共享日程">🔗</span><span v-if="!isAllDay(e) && spanMark(e, d) !== 'mid'" class="cal-evt-time">{{ String(e.start_time || '').slice(11, 16) }}</span>{{ e.title }}
                <span v-if="spanMark(e, d) === 'mid'" class="cal-span-mid">↔</span>
                <span v-if="spanMark(e, d) === 'end'" class="cal-span-end">◀</span>
              </div>
              <div v-if="(dayEvents[d] || []).length > 3" class="cal-more" @click.stop="openList(d)">
                +{{ (dayEvents[d] || []).length - 3 }} 更多
              </div>
            </div>
          </div>
        </div>
        <div class="muted" style="font-size:12px; margin-top:8px">
          点击日期 = 新增日程；点击日程标题 = 查看/编辑内容。◀▶ 跨日日程首尾标记；◀▶ 之间日期同一日程连续显示（↔）。
          <span style="color:var(--green)">绿色底=法定假日</span> · <span style="color:var(--amber)">黄底=调休补班</span>
        </div>
      </div>

      <!-- 弹窗 -->
      <div v-if="modal.show" class="modal-mask" @click.self="closeModal">
        <div class="card modal-card">
          <!-- 新增 -->
          <template v-if="modal.type === 'add'">
            <h3>新增日程</h3>
            <input v-model="modal.form.title" placeholder="标题" />
            <textarea v-model="modal.form.desc" rows="3" placeholder="内容（可选）"></textarea>
            <div class="row" style="align-items:center; gap:6px; flex-wrap:wrap">
              <input v-model="modal.form.date" type="date" style="width:150px" />
              <input v-model="modal.form.start_time" type="time" title="开始（留空=全天）" style="width:100px" />
              <span class="muted">~</span>
              <input v-model="modal.form.end_time" type="time" title="结束（默认+1h，可改）" style="width:100px" />
            </div>
            <div class="row" style="align-items:center; gap:6px; flex-wrap:wrap; margin-top:6px">
              <span class="muted" style="font-size:12.5px; white-space:nowrap">跨日至</span>
              <input v-model="modal.form.end_date" type="date" title="结束日期（晚于开始日期才生效）" style="width:150px" />
              <button v-if="modal.form.end_date" class="icon-btn" title="清除跨日" @click="modal.form.end_date = ''">✕</button>
            </div>
            <input v-model="modal.form.location" placeholder="地点（可选）" />
            <label class="ck-row" title="按日程开始时间提前 15 分钟，通过钉钉工作通知推送到自己钉钉">
              <input v-model="modal.form.remind_push" type="checkbox" /> 钉钉提醒：开始前 15 分钟推送到我的钉钉
            </label>
            <div class="row share-row">
              <span class="muted" style="font-size:12.5px; white-space:nowrap">共享给</span>
              <UserPicker v-model="modal.form.shared_to" :users="contacts" placeholder="选择成员（可查看，不可编辑）；共享后同步钉钉提醒" style="flex:1" />
            </div>
            <div class="muted" style="font-size:12px">清空开始时间=全天；填「跨日至」且晚于开始日期 = 跨日日程（日历中 ▶…◀ 连接显示）。</div>
            <div class="row" style="justify-content:flex-end; gap:8px">
              <button class="small" @click="closeModal">取消</button>
              <button class="primary" @click="saveAdd">保存</button>
            </div>
          </template>
          <!-- 查看/编辑 -->
          <template v-if="modal.type === 'edit' && modal.event">
            <h3>日程详情
              <span v-if="isShared(modal.event)" class="badge green" style="font-size:11px">🔗 {{ modal.event.owner_name }} 共享</span>
              <span v-if="isAllDay(modal.event)" class="badge blue" style="font-size:11px">全天</span><span v-if="isMultiDay(modal.event)" class="badge green" style="font-size:11px">跨日</span>
            </h3>
            <!-- 他人共享的日程：只读查看，不可编辑修改 -->
            <template v-if="isShared(modal.event)">
              <div class="ro-box">
                <div class="t" style="font-weight:600">{{ modal.form.title }}</div>
                <div class="d">时间：{{ roTime(modal.event) }}</div>
                <div class="d" v-if="modal.form.location">地点：{{ modal.form.location }}</div>
                <pre v-if="modal.form.desc" class="ro-desc">{{ modal.form.desc }}</pre>
                <div class="muted" style="font-size:12px">这是 {{ modal.event.owner_name }} 共享的日程：仅可查看，不可编辑修改；开始前 15 分钟会同步钉钉提醒你。</div>
              </div>
              <div class="row" style="justify-content:flex-end"><button class="small" @click="closeModal">关闭</button></div>
            </template>
            <template v-else>
              <input v-model="modal.form.title" placeholder="标题" />
              <textarea v-model="modal.form.desc" rows="5" placeholder="内容"></textarea>
              <div class="row" style="align-items:center; gap:6px; flex-wrap:wrap">
                <input v-model="modal.form.date" type="date" style="width:150px" />
                <input v-model="modal.form.start_time" type="time" style="width:100px" />
                <span class="muted">~</span>
                <input v-model="modal.form.end_time" type="time" style="width:100px" />
              </div>
              <div class="row" style="align-items:center; gap:6px; flex-wrap:wrap; margin-top:6px">
                <span class="muted" style="font-size:12.5px; white-space:nowrap">跨日至</span>
                <input v-model="modal.form.end_date" type="date" title="结束日期（晚于开始日期才生效）" style="width:150px" />
                <button v-if="modal.form.end_date" class="icon-btn" title="清除跨日" @click="modal.form.end_date = ''">✕</button>
              </div>
              <input v-model="modal.form.location" placeholder="地点" />
            <label class="ck-row" title="按日程开始时间提前 15 分钟，通过钉钉工作通知推送到自己钉钉">
              <input v-model="modal.form.remind_push" type="checkbox" /> 钉钉提醒：开始前 15 分钟推送到我的钉钉
            </label>
            <div class="row share-row">
              <span class="muted" style="font-size:12.5px; white-space:nowrap">共享给</span>
              <UserPicker v-model="modal.form.shared_to" :users="contacts" placeholder="选择成员（可查看，不可编辑）；共享后同步钉钉提醒" style="flex:1" />
            </div>
              <div class="row" style="justify-content:space-between">
                <button class="small" style="color:#f87171" @click="delEvent(modal.event.id)">删除</button>
                <div class="row" style="gap:8px">
                  <button class="small" @click="closeModal">取消</button>
                  <button class="primary" @click="saveEdit">保存</button>
                </div>
              </div>
            </template>
          </template>
          <!-- 列表（超过3条） -->
          <template v-if="modal.type === 'list'">
            <h3>{{ modal.date }} 全部日程（{{ modal.events.length }}）</h3>
            <div v-for="e in modal.events" :key="e.id" class="list-item" style="cursor:pointer" @click="openEdit(e)">
              <div class="grow">
                <div class="t">{{ e.title }}</div>
                <div class="d">{{ isAllDay(e) ? '全天' : fmtDT(e.start_time) }}</div>
              </div>
            </div>
            <div class="row" style="justify-content:flex-end"><button class="small" @click="closeModal">关闭</button></div>
          </template>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
import { nextTick, ref, computed, watch, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';
import { canTab, firstTab } from '../tabs';
import UserPicker from '../components/UserPicker.vue';
const route = useRoute();

const tab = ref(firstTab('tasks', 'cal'));
// 成员选择器数据源（日程共享给谁）
const contacts = ref([]);
async function loadContacts() {
  // 接口返回 {users:[...]}——曾把整个对象当数组传给 UserPicker，下拉一打开就
  // 渲染崩溃（users.filter is not a function），表现为「点一下就消失、选不了人」
  try { const r = await api.get('/messages/contacts'); contacts.value = Array.isArray(r) ? r : (r.users || []); }
  catch { contacts.value = []; }
}
const isShared = (e) => !!(e && e.shared);
function parseSharedIds(e) { try { const a = JSON.parse(e.shared_to || '[]'); return Array.isArray(a) ? a.map(Number) : []; } catch { return []; } }
function roTime(e) {
  const s = String(e.start_time || '');
  const day = s.slice(0, 10);
  const st = s.includes('T') ? s.slice(11, 16) : '';
  const et = e.end_time && String(e.end_time).includes('T') ? String(e.end_time).slice(11, 16) : '';
  let t = st ? `${day} ${st}${et ? '~' + et : ''}` : `${day}（全天）`;
  if (e.end_date && e.end_date > day) t += ` ~ ${e.end_date}`;
  return t;
}
const todos = ref([]);
const events = ref([]);
const batchText = ref('');

// 日历
const today = new Date();
const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const calYear = ref(today.getFullYear());
const calMonth = ref(today.getMonth());
// 批量登记的日程日期：默认当天，点选日期框可改
const batchDate = ref(todayStr);
// 周起始日（设置页可配：周一 / 周日）
const weekStart = ref('monday');
const weekLabels = computed(() => (weekStart.value === 'sunday' ? ['日','一','二','三','四','五','六'] : ['一','二','三','四','五','六','日']));
// 节假日数据（与首页看板同一数据源）：{ 'MM-DD': { name, holiday, desc } }
const holidays = ref({});

const batchLines = computed(() => batchText.value.split('\n').map((s) => s.trim()).filter(Boolean));

// 日历网格（含补位；起始列按周起始日配置）
const calDays = computed(() => {
  const first = new Date(calYear.value, calMonth.value, 1);
  let startWeek = first.getDay(); // 0=周日
  if (weekStart.value === 'monday') startWeek = (startWeek + 6) % 7;
  const daysInMonth = new Date(calYear.value, calMonth.value + 1, 0).getDate();
  const arr = [];
  for (let i = 0; i < startWeek; i++) arr.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    arr.push(`${calYear.value}-${String(calMonth.value + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  while (arr.length % 7 !== 0) arr.push(null);
  return arr;
});

function holidayInfo(dateStr) {
  return holidays.value[dateStr.slice(5)] || null;
}
function isHolidayDate(dateStr) {
  const h = holidayInfo(dateStr);
  return !!h && !!h.holiday;
}
function isWorkdayDate(dateStr) {
  const h = holidayInfo(dateStr);
  return !!h && !h.holiday; // 周末调休补班（holiday=false 的节日记录）
}

// 事件按日期分组：跨日日程铺满 [开始日, 结束日] 每一天
const dayEvents = computed(() => {
  const map = {};
  for (const e of events.value) {
    const start = String(e.start_time || '').slice(0, 10);
    if (!start) continue;
    const end = e.end_date && e.end_date > start ? e.end_date : start;
    for (const d of dateRange(start, end)) {
      (map[d] = map[d] || []).push(e);
    }
  }
  return map;
});
// 日期区间迭代（YYYY-MM-DD 字符串）
function* dateRange(a, b) {
  const d = new Date(a + 'T00:00:00');
  const end = new Date(b + 'T00:00:00');
  let guard = 0;
  while (d <= end && guard < 400) {
    yield `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    d.setDate(d.getDate() + 1);
    guard++;
  }
}
function isMultiDay(e) {
  return !!(e && e.end_date && String(e.start_time || '').slice(0, 10) < e.end_date);
}
// 跨日日程在某天的位置标记：start=首日 mid=中间 end=末日
function spanMark(e, d) {
  if (!isMultiDay(e)) return '';
  const s = String(e.start_time || '').slice(0, 10);
  if (d === s) return 'start';
  if (d === e.end_date) return 'end';
  return 'mid';
}
function evtCls(e, d) {
  const mark = spanMark(e, d);
  return {
    'is-shared': isShared(e),
    allday: isAllDay(e),
    'span-start': mark === 'start',
    'span-mid': mark === 'mid',
    'span-end': mark === 'end',
  };
}
function evtTitle(e, d) {
  const mark = spanMark(e, d);
  const pos = mark === 'start' ? '（第1天起）' : mark === 'end' ? '（最后一天）' : mark === 'mid' ? '（跨日中）' : '';
  return e.title + (e.end_date ? `　${String(e.start_time || '').slice(0, 10)} ~ ${e.end_date}` : '') + pos + (isShared(e) ? `（${e.owner_name} 共享，只读）` : '');
}

function shiftMonth(n) {
  let m = calMonth.value + n;
  let y = calYear.value;
  if (m < 0) { m = 11; y--; }
  if (m > 11) { m = 0; y++; }
  calMonth.value = m;
  calYear.value = y;
  loadHolidays();
}
async function loadHolidays() {
  try {
    const d = await api.get(`/holidays?year=${calYear.value}`);
    holidays.value = d.holidays || {};
  } catch { holidays.value = {}; }
  loadLunar();
}
// 农历+节气+家人生日（整年缓存）
const lunarMap = ref({});
const bdays = ref([]);
let lunarCacheYear = '';
async function loadLunar() {
  if (lunarCacheYear === String(calYear.value)) return;
  try {
    const l = await api.get(`/lunar/year?year=${calYear.value}`);
    lunarMap.value = l.lunar || {};
    bdays.value = l.birthdays || [];
    lunarCacheYear = String(calYear.value);
  } catch { lunarMap.value = {}; bdays.value = []; }
  loadCardEvents();
}
function lunarOf(dateStr) { return lunarMap.value[dateStr.slice(5)] || null; }
function bdayOf(dateStr) {
  const b = bdays.value.find((x) => x.date === dateStr);
  return b ? (b.relation ? `${b.name}·${b.relation}` : b.name) : '';
}

// 信用卡账单/还款日（settings 开关控制；虚拟日程，与真实日程合并显示）
const cardEvents = ref([]); // [{ date, name, type: 'bill'|'repay', card }]
async function loadCardEvents() {
  try {
    const d = await api.get(`/credit-cards/schedule?year=${calYear.value}`);
    cardEvents.value = d.schedule || [];
  } catch { cardEvents.value = []; }
}
// 某日的卡事件
function cardsOf(dateStr) {
  return cardEvents.value.filter((c) => c.date === dateStr);
}
function isAllDay(e) {
  if (!e) return false;
  const s = String(e.start_time || '');
  return !s || !s.includes('T') || !s.includes(':');
}
function fmtDT(t) { return t ? String(t).replace('T', ' ').slice(0, 16) : ''; }

// ---------- 时间工具 ----------
function defaultTimes() {
  const n = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const start = `${pad(n.getHours())}:${pad(n.getMinutes())}`;
  const e = new Date(n.getTime() + 3600000);
  return { start_time: start, end_time: `${pad(e.getHours())}:${pad(e.getMinutes())}` };
}
function addHour(t) {
  const d = new Date(`2000-01-01T${t}:00`);
  d.setHours(d.getHours() + 1);
  const pad = (x) => String(x).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// 由表单生成入库的 start_time/end_time：填了时间→"YYYY-MM-DDTHH:MM"；全天→纯日期；无日期→null
function buildTimes(f) {
  const date = f.date || null;
  const st = f.start_time ? `${date}T${f.start_time}` : date;
  let et = null;
  if (f.start_time) et = f.end_time ? `${date}T${f.end_time}` : `${date}T${addHour(f.start_time)}`;
  return { st, et };
}

// ---------- 弹窗 ----------
const modal = ref({ show: false, type: '', date: '', event: null, events: [], form: { title: '', desc: '', date: '', start_time: '', end_time: '', end_date: '', location: '', remind_push: true, shared_to: [] } });
function openAdd(date) {
  suppressEndAuto = true;
  modal.value = { show: true, type: 'add', date, event: null, events: [], form: { title: '', desc: '', date, location: '', end_date: '', remind_push: true, shared_to: [], ...defaultTimes() } };
  nextTick(() => { suppressEndAuto = false; });
}
function openEdit(e) {
  const s = String(e.start_time || '');
  const st = s.includes('T') ? s.slice(11, 16) : '';
  const et = e.end_time && String(e.end_time).includes('T') ? String(e.end_time).slice(11, 16) : '';
  suppressEndAuto = true;
  modal.value = { show: true, type: 'edit', date: s.slice(0, 10), event: e, events: [], form: { title: e.title || '', desc: e.desc || '', date: s.slice(0, 10), start_time: st, end_time: et, end_date: e.end_date || '', location: e.location || '', remind_push: !!e.remind_push, shared_to: parseSharedIds(e) } };
  nextTick(() => { suppressEndAuto = false; });
}
function openList(date) {
  modal.value = { show: true, type: 'list', date, event: null, events: dayEvents.value[date] || [], form: {} };
}
function closeModal() { modal.value.show = false; }

async function saveAdd() {
  const f = modal.value.form;
  if (!f.title.trim()) return;
  const { st, et } = buildTimes(f);
  await api.post('/events', { title: f.title.trim(), desc: f.desc, location: (f.location || '').trim(), start_time: st, end_time: et, end_date: f.end_date || null, remind_push: f.remind_push !== false, shared_to: f.shared_to || [] });
  closeModal();
  await load();
}
async function saveEdit() {
  const f = modal.value.form;
  const e = modal.value.event;
  if (!e || !f.title.trim()) return;
  const { st, et } = buildTimes(f);
  await api.put(`/events/${e.id}`, { title: f.title.trim(), desc: f.desc, location: (f.location || '').trim(), start_time: st, end_time: et, end_date: f.end_date || null, remind_push: f.remind_push !== false, shared_to: f.shared_to || [] });
  closeModal();
  await load();
}
async function delEvent(id) {
  if (!confirm('删除该日程？')) return;
  await api.del(`/events/${id}`);
  closeModal();
  await load();
}
// 开始时间改动 → 结束自动+1h；清空开始 → 结束清空（suppressEndAuto：打开弹窗回填表单时不触发，避免冲掉载入的结束时间）
let suppressEndAuto = false;
watch(() => modal.value.form.start_time, (nv) => {
  if (suppressEndAuto) return;
  if (modal.value.show && modal.value.type !== 'list') modal.value.form.end_time = nv ? addHour(nv) : '';
});

// ---------- 待办（不变） ----------
async function load() {
  // 各数据源独立容错：无对应 tab 权限时接口 403，不能拖垮其他 tab
  try { todos.value = await api.get('/todos'); } catch { todos.value = []; }
  try { events.value = await api.get('/events'); } catch { events.value = []; }
}
// 批量登记：每行一条全天日程，插入到所选日期（默认当天）的日历
async function addBatch() {
  const lines = batchLines.value;
  if (!lines.length) return;
  const date = batchDate.value || todayStr;
  for (const title of lines) {
    await api.post('/events', { title, start_time: date, end_time: null, end_date: null });
  }
  batchText.value = '';
  // 日历切到插入日期所在月，插入即可见
  const [y, m] = date.split('-').map(Number);
  if (y && m) {
    const changed = y !== calYear.value || m - 1 !== calMonth.value;
    calYear.value = y;
    calMonth.value = m - 1;
    if (changed) loadHolidays();
  }
  await load();
}
async function editTodo(t) {
  const title = prompt('修改待办内容：', t.title);
  if (title === null) return;
  const due = prompt('修改截止日期（YYYY-MM-DD，留空清除）：', t.due_date || todayStr);
  if (due === null) return;
  await api.patch(`/todos/${t.id}`, { title: title.trim() || t.title, due_date: due.trim() || null });
  await load();
}
async function toggle(t) { t.done = !t.done; await api.patch(`/todos/${t.id}`, { done: t.done }); }
async function remove(t) { await api.del(`/todos/${t.id}`); await load(); }
function prioText(p) { return ['', '高', '中', '低'][p] || '中'; }
function prioCls(p) { return ['', 'red', 'amber', ''][p] || ''; }

onMounted(async () => {
  // 看板跳转参数：?tab=cal&month=2026-08 直接落在日历页对应月份（无该 tab 权限则忽略）
  if (route.query.tab === 'cal' && canTab('tasks', 'cal')) tab.value = 'cal';
  if (route.query.month && /^\d{4}-\d{2}$/.test(route.query.month)) {
    const [y, m] = route.query.month.split('-').map(Number);
    calYear.value = y;
    calMonth.value = m - 1;
  }
  await load();
  loadContacts();
  try {
    const c = await api.get('/calendar/config');
    weekStart.value = c.weekStart || 'monday';
  } catch {}
  loadHolidays();
});
</script>

<style scoped>
.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 4px; }
.cal-week { text-align: center; font-size: 12px; color: var(--text3); padding: 4px 0; }
.cal-cell { min-height: 92px; border-radius: 8px; padding: 4px 6px; background: var(--bg3); font-size: 12px; cursor: pointer; display: flex; flex-direction: column; gap: 3px; overflow: hidden; }
.cal-cell.cal-empty { background: transparent; cursor: default; min-height: 0; }
.cal-cell:hover:not(.cal-empty) { outline: 1px solid var(--border); }
.cal-cell.cal-today .cal-day { color: var(--accent); font-weight: 700; }
.cal-day { font-size: 12px; color: var(--text2); }
.cal-evts { display: flex; flex-direction: column; gap: 2px; min-height: 0; }
.cal-evt { background: var(--bg2); border-left: 3px solid var(--accent); padding: 1px 4px; border-radius: 3px; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.cal-evt.allday { border-left-color: var(--accent2); }
.cal-evt-time { color: var(--text3); margin-right: 3px; }
.cal-evt:hover { background: rgba(79, 124, 247, .25); }
/* 跨日日程连接效果：首尾 ▶◀ 标记 + 中间日期圆角抹平（视觉连续） */
.cal-evt.span-mid { border-left-color: var(--accent2); background: var(--bg2); opacity: .92; border-radius: 0; border-right: 2px solid var(--accent2); }
.cal-evt.span-start { border-radius: 3px 0 0 3px; border-right: 2px solid var(--accent2); }
.cal-evt.span-end { border-radius: 0 3px 3px 0; border-left: none; border-right: 2px solid var(--accent2); padding-left: 6px; }
.cal-span-start, .cal-span-end, .cal-span-mid { color: var(--accent2); font-size: 10px; margin: 0 2px; }
/* 节假日/补班日期底色（同看板节日日历） */
.cal-cell.cal-holiday { background: rgba(52, 211, 153, .12); }
.cal-cell.cal-workday { background: rgba(251, 191, 36, .12); }
.cal-hol-name { font-size: 10px; color: var(--green); margin-left: 3px; }
.cal-cell.cal-workday .cal-hol-name { color: var(--amber); }
.cal-lunar { font-size: 10px; color: var(--text3); margin-left: 3px; }
.cal-lunar.term { color: var(--green); }
.cal-bday-row { font-size: 10px; color: #e878b4; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 信用卡账单/还款日：账单=蓝 还款=橙红 */
.cal-card-evt { font-size: 10px; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-radius: 3px; padding: 0 3px; }
.cal-card-evt.bill { color: #7ba6f7; background: rgba(79, 124, 247, .12); }
.cal-card-evt.repay { color: #f8a170; background: rgba(251, 146, 60, .15); }
.cal-more { font-size: 11px; color: var(--accent); padding: 0 4px; cursor: pointer; }
/* 共享日程：绿色边 + 🔗 标记（只读，来自其他成员） */
.cal-evt.is-shared { border-left-color: var(--green); background: rgba(52, 211, 153, .1); }
.cal-shared { font-size: 10px; margin-right: 2px; }
.ck-row { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text2); cursor: pointer; }
.share-row { align-items: flex-start; }
.ro-box { background: var(--bg3); border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; gap: 6px; font-size: 13.5px; }
.ro-desc { white-space: pre-wrap; word-break: break-all; font: inherit; margin: 0; }
.modal-mask { position: fixed; inset: 0; background: rgba(0, 0, 0, .45); display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 16px; }
.modal-card { width: 100%; max-width: 440px; max-height: 86vh; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
.modal-card input, .modal-card textarea { width: 100%; box-sizing: border-box; }
</style>
