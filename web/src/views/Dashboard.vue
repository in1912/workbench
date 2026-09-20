<template>
  <div>
    <h2 class="page-title">今日看板
      <span class="muted" style="font-size:12px; font-weight:400">（拖动卡片标题可调整布局，自动保存）</span>
    </h2>
    <div v-if="err" class="msg err">{{ err }}</div>
    <div class="dash-masonry">
      <template v-for="key in layout" :key="key">
        <!-- 时钟（七段液晶数码管，纯 CSS 实现） -->
        <div v-if="key === 'clock'" :class="['card dash-card', { dragging: dragKey === key, 'drag-over': dragOverKey === key }]"
             draggable="true" @dragstart="onDragStart(key, $event)" @dragover.prevent="onDragOver(key)" @drop.prevent="onDrop(key)">
          <div class="clock-led">
            <div class="led-row">
              <template v-for="(d, i) in ledDigits" :key="i">
                <span class="led-digit">
                  <span v-for="s in 7" :key="s" class="led-seg" :class="['led-' + 'abcdefg'[s - 1], { on: (SEG_ON[+d] || ZERO)[s - 1] === 1 }]"></span>
                </span>
                <span v-if="i === 1 || i === 3" class="led-colon" :class="{ blink: colonBlink }"><i></i><i></i></span>
              </template>
            </div>
          </div>
          <div class="clock-led-date">{{ clockText.weekday }} · {{ clockText.date }}</div>
        </div>

        <!-- 天气 -->
        <div v-else-if="key === 'weather'" :class="['card dash-card', { dragging: dragKey === key, 'drag-over': dragOverKey === key }]"
             draggable="true" @dragstart="onDragStart(key, $event)" @dragover.prevent="onDragOver(key)" @drop.prevent="onDrop(key)">
          <h3 class="dash-title">天气 <span class="muted">{{ weather.city || '未配置城市' }}</span></h3>
          <div v-if="weather.ok">
            <div class="row" style="gap:14px; margin-bottom:10px">
              <div style="font-size:34px; font-weight:600">{{ weather.current.temp }}°</div>
              <div>
                <div>{{ weather.current.text }}</div>
                <div class="muted">湿度 {{ weather.current.humidity }}% · 风速 {{ weather.current.wind }} km/h</div>
              </div>
            </div>
            <div class="row" style="flex-wrap:wrap">
              <span v-for="d in weather.daily.slice(0,5)" :key="d.date" class="badge blue" style="font-size:12px">
                {{ weekday(d.date) }} {{ d.date.slice(5) }} {{ d.text }} {{ d.tmin }}~{{ d.tmax }}°
              </span>
            </div>
          </div>
          <div v-else class="muted">{{ weather.error || '加载中...' }}</div>
        </div>

        <!-- 通勤预计 -->
        <div v-else-if="key === 'commute'" :class="['card dash-card', { dragging: dragKey === key, 'drag-over': dragOverKey === key }]"
             draggable="true" @dragstart="onDragStart(key, $event)" @dragover.prevent="onDragOver(key)" @drop.prevent="onDrop(key)">
          <h3 class="dash-title">通勤预计 <span v-if="cm.mode_label" class="badge blue" style="font-size:11px">{{ cm.mode_label }}</span> <router-link to="/settings" class="link small">设置</router-link></h3>
          <template v-if="cm.ok">
            <div class="row" style="flex-wrap:wrap; gap:14px; margin-bottom:10px">
              <div>
                <span class="muted">上班 {{ cm.work_start }}</span>
                <div style="font-size:20px; font-weight:600">{{ cm.to_work.minutes }} <span style="font-size:12px">分钟</span></div>
                <div class="muted">预计 {{ cm.to_work.eta }} 到公司 · 最晚 {{ cm.to_work.depart_by }} 出发</div>
                <div class="d" style="color:var(--amber)">{{ workStatus }}</div>
                <div v-if="(cm.mode || 'driving') === 'driving'" class="d" style="font-size:12px; font-weight:600" :style="{ color: statusColor(toWorkTraffic) }">去公司路况：{{ statusLabel(toWorkTraffic) }}</div>
              </div>
              <div>
                <span class="muted">下班 {{ cm.work_end }}</span>
                <div style="font-size:20px; font-weight:600">{{ cm.to_home.minutes }} <span style="font-size:12px">分钟</span></div>
                <div class="muted">预计 {{ cm.to_home.eta }} 到家 · {{ cm.to_home.distance_km }} km</div>
                <div class="d" style="color:var(--green)">{{ endStatus }}</div>
                <div v-if="(cm.mode || 'driving') === 'driving'" class="d" style="font-size:12px; font-weight:600" :style="{ color: statusColor(toHomeTraffic) }">回家路况：{{ statusLabel(toHomeTraffic) }}</div>
              </div>
            </div>
          <div class="cm-map" id="cm-map"></div>
          <div class="row" style="flex-wrap:wrap; gap:8px; margin-top:6px; font-size:12px">
            <span class="muted">可拖动、滚轮缩放 · 蓝色为通勤路线</span>
            <button class="small" @click="loadCommute(true)" :disabled="cmLoading">↻ 手动刷新路况</button>
          </div>
            <div class="muted" style="margin-top:4px; font-size:12px">{{ cm.home }} ⇄ {{ cm.work }}</div>
          </template>
          <div v-else-if="cm.error" class="muted">{{ cm.error }}</div>
          <div v-else class="muted">加载中...</div>
        </div>

        <!-- 快捷启动 -->
        <div v-else-if="key === 'links'" :class="['card dash-card', { dragging: dragKey === key, 'drag-over': dragOverKey === key }]"
             draggable="true" @dragstart="onDragStart(key, $event)" @dragover.prevent="onDragOver(key)" @drop.prevent="onDrop(key)">
          <h3 class="dash-title">快捷启动 <router-link to="/tools" class="link small">管理</router-link></h3>
          <div class="grid" style="grid-template-columns:repeat(3,1fr); gap:2px">
            <a v-for="l in links" :key="l.id" :href="l.url" target="_blank" rel="noopener"
               class="list-item" style="border:none; padding:4px 3px; color:var(--text); text-decoration:none; font-size:12px">
              <span style="font-size:14px">{{ l.icon || '🔗' }}</span>
              <span class="t" style="font-size:12px">{{ l.name }}</span>
            </a>
          </div>
        </div>

        <!-- 今日待办 -->
        <div v-else-if="key === 'todos'" :class="['card dash-card', { dragging: dragKey === key, 'drag-over': dragOverKey === key }]"
             draggable="true" @dragstart="onDragStart(key, $event)" @dragover.prevent="onDragOver(key)" @drop.prevent="onDrop(key)">
          <h3 class="dash-title">今日待办 <span class="badge blue">{{ openTodos.length }} 项</span></h3>
          <div v-if="!openTodos.length" class="empty">暂无待办</div>
          <div v-for="t in openTodos" :key="t.id" class="list-item">
            <span class="check" :class="{done:t.done}" @click="toggleTodo(t)">{{ t.done ? '✓' : '○' }}</span>
            <div class="grow">
              <div :class="['t', {strike:t.done}]">{{ t.title }}</div>
              <div class="d" v-if="t.due_date">截止 {{ t.due_date }}</div>
            </div>
            <router-link to="/tasks" class="link small">全部</router-link>
          </div>
        </div>

        <!-- 今日日程：只显示今天（含今天进行中的跨日日程） -->
        <div v-else-if="key === 'events'" :class="['card dash-card', { dragging: dragKey === key, 'drag-over': dragOverKey === key }]"
             draggable="true" @dragstart="onDragStart(key, $event)" @dragover.prevent="onDragOver(key)" @drop.prevent="onDrop(key)">
          <h3 class="dash-title">今日日程 <span class="muted">{{ today }}</span> <router-link to="/tasks" class="link small">日历</router-link></h3>
          <div v-if="!todayEvents.length" class="empty">今天没有日程</div>
          <div v-for="e in todayEvents" :key="e.id" class="list-item" style="cursor:pointer" @click="gotoCalendar(e)">
            <div class="grow">
              <div class="t">{{ e.title }} <span v-if="isPastEvent(e)" class="badge" style="font-size:10px">已结束</span><span v-if="isMultiDay(e)" class="badge green" style="font-size:10px">跨日</span></div>
              <div class="d" v-if="e.start_time">{{ fmtTime(e.start_time) }} <span v-if="e.end_time">→ {{ fmtTime(e.end_time) }}</span></div>
              <div class="d" v-if="e.location">{{ e.location }}</div>
            </div>
          </div>
        </div>

        <!-- 科技新闻 -->
        <div v-else-if="key === 'news'" :class="['card dash-card', { dragging: dragKey === key, 'drag-over': dragOverKey === key }]"
             draggable="true" @dragstart="onDragStart(key, $event)" @dragover.prevent="onDragOver(key)" @drop.prevent="onDrop(key)">
          <h3 class="dash-title">科技新闻 <router-link to="/news" class="link small">更多</router-link></h3>
          <div v-for="n in news" :key="n.id" class="list-item">
            <div class="grow">
              <a :href="n.url" target="_blank" rel="noopener" class="link" style="text-decoration:none; color:var(--text)">{{ n.title }}</a>
              <div class="d">{{ n.summary }}</div>
              <div class="meta">来源：{{ n.source }}</div>
            </div>
          </div>
        </div>

        <!-- 百度热搜 -->
        <div v-else-if="key === 'hot'" :class="['card dash-card', { dragging: dragKey === key, 'drag-over': dragOverKey === key }]"
             draggable="true" @dragstart="onDragStart(key, $event)" @dragover.prevent="onDragOver(key)" @drop.prevent="onDrop(key)">
          <h3 class="dash-title">百度热搜 <a href="https://top.baidu.com/board?tab=realtime" target="_blank" rel="noopener" class="link small">完整榜单 ↗</a></h3>
          <div v-if="hotErr" class="empty">{{ hotErr }}</div>
          <div v-else-if="!hotNews.length" class="empty">加载中...</div>
          <div v-for="(h, i) in hotNews" :key="h.url" class="list-item" style="padding:5px 0" :title="h.desc">
            <span :class="['badge', i < 3 ? 'red' : 'blue']" style="min-width:24px; text-align:center; margin-right:8px">{{ i + 1 }}</span>
            <a :href="h.url" target="_blank" rel="noopener" class="grow" style="text-decoration:none; color:var(--text)">{{ h.word }}</a>
            <span class="meta" style="white-space:nowrap; margin-left:8px">{{ fmtHot(h.hotScore) }}</span>
          </div>
        </div>

        <!-- 子女学习 -->
        <div v-else-if="key === 'kids'" :class="['card dash-card', { dragging: dragKey === key, 'drag-over': dragOverKey === key }]"
             draggable="true" @dragstart="onDragStart(key, $event)" @dragover.prevent="onDragOver(key)" @drop.prevent="onDrop(key)">
          <h3 class="dash-title">子女学习 <router-link to="/family" class="link small">跟进</router-link></h3>
          <div v-if="!pendingKids.length" class="empty">暂无待完成任务</div>
          <div v-for="k in pendingKids" :key="k.id" class="list-item">
            <div class="grow">
              <div class="t">{{ k.kid_name || '孩子' }} · {{ plainText(k.content) }}</div>
              <div class="d" v-if="k.due_date">截止 {{ k.due_date }}</div>
            </div>
          </div>
        </div>

        <!-- 中国节日日历 -->
        <div v-else-if="key === 'holiday'" :class="['card dash-card', { dragging: dragKey === key, 'drag-over': dragOverKey === key }]"
             draggable="true" @dragstart="onDragStart(key, $event)" @dragover.prevent="onDragOver(key)" @drop.prevent="onDrop(key)">
          <h3 class="dash-title">中国节日日历</h3>
          <HolidayCalendar />
        </div>
      </template>

      <!-- 看板模块显隐（个人设置，只影响自己；固定在瀑布流最下方，不参与拖拽） -->
      <div class="card" style="break-inside:avoid">
        <h3>看板模块设置 <span class="muted" style="font-size:12px; font-weight:400">（个人显隐，只影响自己）</span></h3>
        <div v-if="!configurable.length" class="muted">暂无可配置模块</div>
        <div class="row" style="flex-wrap:wrap; gap:6px 16px">
          <label v-for="c in configurable" :key="c.key" style="cursor:pointer; display:flex; align-items:center; gap:6px; font-size:13px">
            <input type="checkbox" style="width:auto" :checked="isShown(c.key)" @change="toggleModule(c.key)" />
            {{ c.label }}
          </label>
        </div>
        <div v-if="globalDisabled.length" class="muted" style="font-size:12px; margin-top:8px">
          另有 {{ globalDisabled.length }} 个模块被管理员全局停用（设置 → 首页看板模块）
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch, nextTick, defineAsyncComponent } from 'vue';
import { useRouter } from 'vue-router';
import { plainText } from '../utils/rich';
import { api } from '../api';
const router = useRouter();
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
const HolidayCalendar = defineAsyncComponent(() => import('./HolidayCalendar.vue'));

const err = ref('');
const weather = ref({});
const links = ref([]);
const todos = ref([]);
const events = ref([]);
// 今日日程：严格只显示今天（开始日期=今天，或跨日日程覆盖今天）
const todayEvents = computed(() =>
  events.value.filter((e) => {
    const s = String(e.start_time || '').slice(0, 10);
    if (!s) return false;
    const end = e.end_date || s;
    return s <= today && today <= end;
  })
);
const news = ref([]);
const pendingKids = ref([]);
const cm = ref({});
const today = new Date().toISOString().slice(0, 10);
// 百度热搜（后端实时抓取 + 10 分钟缓存，接口 /news/hot）
const hotNews = ref([]);
const hotErr = ref('');

// ---------- 看板布局（拖拽排序 + 持久化 + 个人显隐） ----------
const DEFAULT_LAYOUT = ['clock', 'weather', 'commute', 'links', 'todos', 'events', 'news', 'hot', 'kids', 'holiday'];
const layout = ref([...DEFAULT_LAYOUT]);   // 实际渲染顺序（后端已过滤全局禁用+本人隐藏）
const allKeys = ref([...DEFAULT_LAYOUT]);  // 完整顺序（含隐藏模块：拖拽保存时合并，恢复不丢位置）
const hidden = ref([]);                    // 本人隐藏的模块
const cards = ref([]);                     // 模块注册表（/dashboard/modules）
const globalDisabled = ref([]);            // 管理员全局停用的模块
// 底部配置卡可配置的模块 = 全局未停用的（全局停用的归管理员管）
const configurable = computed(() => cards.value.filter((c) => !globalDisabled.value.includes(c.key)));
function isShown(key) { return !hidden.value.includes(key); }
async function toggleModule(key) {
  hidden.value = isShown(key) ? [...hidden.value, key] : hidden.value.filter((k) => k !== key);
  try {
    await api.post('/dashboard/hidden', { hidden: hidden.value });
    await loadLayout(); // 重新取渲染顺序（含隐藏模块的位置合并）
  } catch (e) { err.value = '模块显隐保存失败：' + e.message; }
}
const dragKey = ref('');
const dragOverKey = ref('');

// ---------- 电子时钟（七段液晶数码管，纯 CSS/DOM 实现，全兼容） ----------
const clockText = ref({ weekday: '', date: '', time: '', seconds: '' });
const ledDigits = ref(['0', '0', '0', '0', '0', '0']);
const colonBlink = ref(true);

// 七段映射（顺序：a上横 b右上竖 c右下竖 d下横 e左下竖 f左上竖 g中横）
const SEG_ON = [
  [1, 1, 1, 1, 1, 1, 0], // 0
  [0, 1, 1, 0, 0, 0, 0], // 1
  [1, 1, 0, 1, 1, 0, 1], // 2
  [1, 1, 1, 1, 0, 0, 1], // 3
  [0, 1, 1, 0, 0, 1, 1], // 4
  [1, 0, 1, 1, 0, 1, 1], // 5
  [1, 0, 1, 1, 1, 1, 1], // 6
  [1, 1, 1, 0, 0, 0, 0], // 7
  [1, 1, 1, 1, 1, 1, 1], // 8
  [1, 1, 1, 1, 0, 1, 1], // 9
];
const ZERO = SEG_ON[0];

function tickClock() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
  clockText.value = {
    weekday: '星期' + week,
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    seconds: pad(now.getSeconds()),
  };
  ledDigits.value = (pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds())).split('');
  colonBlink.value = now.getSeconds() % 2 === 0;
}

// ---------- 天气星期 ----------
function weekday(dateStr) {
  const w = ['日', '一', '二', '三', '四', '五', '六'][new Date(dateStr + 'T00:00:00').getDay()];
  return '周' + w;
}
function onDragStart(key) {
  dragKey.value = key;
  dragOverKey.value = '';
}
function onDragOver(key) {
  if (key !== dragKey.value) dragOverKey.value = key;
}
function onDrop(key) {
  dragOverKey.value = '';
  if (!dragKey.value || dragKey.value === key) return;
  const from = layout.value.indexOf(dragKey.value);
  const to = layout.value.indexOf(key);
  if (from < 0 || to < 0) return;
  layout.value.splice(from, 1);
  layout.value.splice(to, 0, dragKey.value);
  dragKey.value = '';
  saveLayout();
}
async function saveLayout() {
  // 保存完整顺序：可见模块的新顺序 + 当前未渲染的模块（隐藏/全局停用）按原相对顺序追加在后，
  // 这样重新显示某模块时位置可预期（排在最后），不会因中间隐藏过而丢失
  const visible = layout.value;
  const rest = allKeys.value.filter((k) => !visible.includes(k));
  try { await api.post('/dashboard/layout', { keys: [...visible, ...rest] }); } catch (e) { console.warn('[layout] 保存失败:', e.message); }
}

// ---------- 上下班时间计算 ----------
function minOfDay(t) {
  const [h, m] = String(t || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
const nowMin = ref(new Date().getHours() * 60 + new Date().getMinutes());

const departBy = computed(() => {
  const m = minOfDay(cm.value.work_start) - (cm.value.to_work?.minutes || 0);
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
});
const homeArrive = computed(() => {
  const m = minOfDay(cm.value.work_end) + (cm.value.to_home?.minutes || 0);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
});
const workStatus = computed(() => {
  const diff = minOfDay(cm.value.work_start) - nowMin.value;
  if (diff > 0) return diff >= 60 ? `距上班 ${Math.floor(diff / 60)} 小时 ${diff % 60} 分钟` : `距上班 ${diff} 分钟`;
  return `已过上班时间 ${-diff} 分钟`;
});
const endStatus = computed(() => {
  const diff = minOfDay(cm.value.work_end) - nowMin.value;
  if (diff > 0) return diff >= 60 ? `距下班 ${Math.floor(diff / 60)} 小时 ${diff % 60} 分钟` : `距下班 ${diff} 分钟`;
  return '已下班';
});

// ---------- 通勤地图 ----------
// 优先：高德 JS SDK（中文底图，GCJ-02 坐标与高德路线天然对齐，可缩放拖拽）
// 回退：Leaflet + /api/tile 代理 Esri（WGS-84 底图，需 GCJ→WGS 纠偏）
let map = null;        // Leaflet 实例
let amap = null;       // 高德地图实例
let routeLayer = null;
let markersLayer = null;

function gcj02ToWgs84(lng, lat) {
  const a = 6378245.0, ee = 0.00669342162296594323;
  const tLat = (x, y) => {
    let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    r += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
    r += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
    return r;
  };
  const tLng = (x, y) => {
    let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    r += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
    r += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
    return r;
  };
  const dlat = tLat(lng - 105.0, lat - 35.0);
  const dlng = tLng(lng - 105.0, lat - 35.0);
  const radlat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radlat);
  magic = 1 - ee * magic * magic;
  const sqrtmagic = Math.sqrt(magic);
  const mglat = lat + (dlat * 180.0) / ((a * (1 - ee)) / (magic * sqrtmagic) * Math.PI);
  const mglng = lng + (dlng * 180.0) / (a / sqrtmagic * Math.cos(radlat) * Math.PI);
  return [lng * 2 - mglng, lat * 2 - mglat];
}

function parseLoc(loc) {
  const [lng, lat] = String(loc).split(',').map(Number);
  return [lat, lng];
}

// 路况：0畅通 1缓行 2拥堵 3严重拥堵
const TRAFFIC_COLOR = { 0: '#34d399', 1: '#fbbf24', 2: '#fb923c', 3: '#f87171' };
const TRAFFIC_LABEL = { 0: '畅通', 1: '缓行', 2: '拥堵', 3: '严重拥堵' };
function segStatus(seg) { return (seg && Number(seg.status)) || 0; }
function worstStatus(traffic) {
  if (!Array.isArray(traffic) || !traffic.length) return -1;
  return traffic.reduce((m, s) => Math.max(m, segStatus(s)), 0);
}
function toWorkTraffic() { return worstStatus(cm.value.to_work?.traffic); }
function toHomeTraffic() { return worstStatus(cm.value.to_home?.traffic); }
function statusColor(s) { return s < 0 ? 'var(--text3)' : TRAFFIC_COLOR[s]; }
function statusLabel(s) { return s < 0 ? '暂无路况数据' : TRAFFIC_LABEL[s]; }

// ---------- 高德渲染（GCJ-02 直接用，无需纠偏） ----------
function renderAmap() {
  const el = document.getElementById('cm-map');
  if (!el || !window.AMap || !cm.value.ok) return false;
  const key = cm.value.config?.key;
  if (!key) return false;
  if (amap) { amap.destroy(); amap = null; }
  const home = String(cm.value.home_loc).split(',').map(Number);
  amap = new AMap.Map('cm-map', { zoom: 12, center: home });
  // 单色蓝色路线（分段拥堵着色视觉效果差——多段同为黄色时整条线糊成一片，故恢复单色；
  // 拥堵概览保留在看板文字：去公司路况/回家路况）
  const path = String(cm.value.to_work?.polyline || '')
    .split(';').filter(Boolean).map((p) => p.split(',').map(Number));
  if (path.length > 1) {
    const poly = new AMap.Polyline({
      path, strokeColor: '#4f7cf7', strokeWeight: 6, strokeOpacity: 0.9, lineJoin: 'round',
    });
    poly.setMap(amap);
    amap.setFitView([poly], false, [50, 50, 50, 50]);
  } else {
    amap.setZoomAndCenter(13, home);
  }
  const mk = (loc, fill) => new AMap.CircleMarker({
    center: String(loc).split(',').map(Number),
    radius: 10, strokeColor: '#fff', strokeWeight: 2, fillColor: fill, fillOpacity: 1,
  });
  mk(cm.value.home_loc, '#2dd4bf').setMap(amap);
  mk(cm.value.work_loc, '#4f7cf7').setMap(amap);
  return true;
}

// ---------- Leaflet 渲染（Esri 底图，WGS-84 需纠偏） ----------
function renderMap() {
  const el = document.getElementById('cm-map');
  if (!el || !cm.value.ok) return;
  if (amap) { amap.destroy(); amap = null; }
  if (!map) {
    map = L.map(el).setView([30, 120], 5);
    L.tileLayer('/api/tile?x={x}&y={y}&z={z}', {
      attribution: '© Esri', maxZoom: 18,
    }).addTo(map);
  }
  if (markersLayer) markersLayer.remove();
  if (routeLayer) routeLayer.remove();
  markersLayer = L.layerGroup().addTo(map);
  const poly = String(cm.value.to_work?.polyline || '')
    .split(';').filter(Boolean)
    .map((pair) => gcj02ToWgs84(...pair.split(',').map(Number)).reverse());
  routeLayer = L.polyline(poly, { color: '#4f7cf7', weight: 4, opacity: 0.85 }).addTo(map);
  L.circleMarker(gcj02ToWgs84(...String(cm.value.home_loc).split(',').map(Number)).reverse(),
    { radius: 8, color: '#fff', weight: 2, fillColor: '#2dd4bf', fillOpacity: 1 })
    .addTo(markersLayer).bindPopup('🏠 家');
  L.circleMarker(gcj02ToWgs84(...String(cm.value.work_loc).split(',').map(Number)).reverse(),
    { radius: 8, color: '#fff', weight: 2, fillColor: '#4f7cf7', fillOpacity: 1 })
    .addTo(markersLayer).bindPopup('🏢 公司');
  const bounds = routeLayer.getBounds();
  if (bounds.isValid()) map.fitBounds(bounds, { padding: [30, 30] });
  else map.setView(parseLoc(cm.value.home_loc), 12);
}

// 动态加载高德 JS SDK
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('加载失败'));
    document.head.appendChild(s);
  });
}
async function ensureAmap() {
  if (window.AMap) return true;
  try {
    const { key } = await api.get('/amap-key');
    if (!key) return false;
    await loadScript(`https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}`);
    return !!window.AMap;
  } catch (e) {
    console.warn('[map] 高德 SDK 加载失败，回退 Esri:', e.message);
    return false;
  }
}

watch(cm, async (v) => {
  if (!v.ok) return;
  await nextTick();
  try {
    const amapOk = await ensureAmap();
    if (amapOk && renderAmap()) return;
  } catch (e) {
    console.warn('[map] 高德渲染失败，回退 Esri:', e.message);
  }
  renderMap();
});

onMounted(() => {
  // 时钟与定时器最先启动：不依赖任何数据请求，保证页面不因接口慢而"卡住"
  tickClock();
  setInterval(tickClock, 1000);
  setInterval(() => { nowMin.value = new Date().getHours() * 60 + new Date().getMinutes(); }, 30000);
  // 数据加载全部异步独立执行，互不阻塞（任一接口慢/挂起不影响其他模块与时钟）
  loadOverview();
  loadWeather();
  loadCommute();
  loadLayout();
  loadModules();
  loadHotNews();
});

async function loadOverview() {
  try {
    const d = await api.get('/overview');
    links.value = d.links;
    todos.value = d.todos;
    events.value = d.events; // 后端已过滤为"今天"（含进行中的跨日）
    pendingKids.value = d.pendingKids;
    news.value = (await api.get('/news?category=tech&limit=5')).items;
  } catch (e) { err.value = e.message; }
}
// ---------- 今日日程卡片：时间标签与跳转 ----------
function fmtTime(t) { return t ? String(t).replace('T', ' ').slice(0, 16) : ''; }
function isPastEvent(e) {
  const s = String(e.start_time || '');
  if (!s) return false;
  const end = e.end_time || s;
  return String(end).replace('T', ' ') < new Date().toISOString().slice(0, 16).replace('T', ' ');
}
function isMultiDay(e) {
  return !!(e.end_date && String(e.start_time || '').slice(0, 10) < e.end_date);
}
// 点击日程 → 日程登记页（/tasks 的日程 tab，并定位到该日程所在月份）
function gotoCalendar(e) {
  const d = String(e.start_time || '').slice(0, 10);
  router.push({ path: '/tasks', query: { tab: 'cal', ...(d ? { month: d.slice(0, 7) } : {}) } });
}
async function loadWeather() {
  try { weather.value = await api.get('/weather'); } catch (e) { weather.value = { ok: false, error: e.message }; }
}
// ---------- 百度热搜卡片 ----------
async function loadHotNews() {
  try {
    const r = await api.get('/news/hot?limit=15');
    hotNews.value = r.items || [];
  } catch (e) { hotErr.value = '热搜加载失败：' + e.message; }
}
// 热度值格式化：7808883 → 780.9万
function fmtHot(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return String(v);
}
// 首页只展示未完成待办：勾选完成后该项立即从今日待办消除
const openTodos = computed(() => todos.value.filter((t) => !t.done));
// 首页待办勾选：点击圆圈切换完成状态
async function toggleTodo(t) {
  const next = !t.done;
  t.done = next;
  try {
    await api.patch(`/todos/${t.id}`, { done: next });
  } catch (e) {
    t.done = !next; // 失败回滚
    console.warn('[todo] 更新失败:', e.message);
  }
}
const cmLoading = ref(false);
async function loadCommute(force = false) {
  if (cmLoading.value) return;
  cmLoading.value = true;
  try {
    cm.value = await api.get(force ? '/commute?force=1' : '/commute');
  } catch (e) {
    cm.value = { error: e.message };
  } finally {
    cmLoading.value = false;
  }
}
async function loadLayout() {
  try {
    const l = await api.get('/dashboard/layout');
    if (Array.isArray(l.keys) && l.keys.length) layout.value = l.keys;
    if (Array.isArray(l.all) && l.all.length) allKeys.value = l.all;
    hidden.value = Array.isArray(l.hidden) ? l.hidden : [];
  } catch (e) { /* 默认布局 */ }
}
async function loadModules() {
  try {
    const m = await api.get('/dashboard/modules');
    cards.value = m.cards || [];
    globalDisabled.value = m.disabled || [];
  } catch (e) { /* 拿不到清单时配置卡显示"暂无可配置模块" */ }
}
</script>
