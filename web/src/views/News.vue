<template>
  <div>
    <h2 class="page-title">每日新闻 <span class="muted" style="font-size:13px">百度热搜实时（10 分钟缓存） · 影视排行榜每天 09:00 刷新 · 榜单每日存档、永久留存 · 新闻每天 08:00 抓取（留存 90 天）</span></h2>
    <div class="row" style="margin-bottom:10px">
      <div class="tabs grow">
        <button v-for="c in cats" :key="c.key" :class="{active: cat===c.key}" @click="switchCat(c.key)">{{ c.label }}</button>
      </div>
      <button @click="refresh" :disabled="loading">{{ loading ? '刷新中...' : '立即刷新' }}</button>
    </div>

    <div class="row" style="margin-bottom:12px; flex-wrap:wrap">
      <select v-model="date" class="small" style="width:auto" @change="load">
        <option value="">今天（{{ today }}）</option>
        <option v-for="d in dates" :key="d" :value="d">{{ d }}</option>
      </select>
      <span v-if="isBoard" class="muted">榜单历史按日期永久翻阅（不清理）</span>
      <span v-else class="muted">历史新闻按日期翻阅（最近 90 天）</span>
    </div>

    <!-- 实时热搜分类筛选 -->
    <div v-if="cat==='hot'" class="row" style="flex-wrap:wrap; gap:6px; margin-bottom:12px">
      <button v-for="c in hotCatChips" :key="c" class="small cat-chip" :class="{on: hotCat===c}" @click="hotCat=c">{{ c }}<span class="muted" style="margin-left:4px">{{ countOf(c) }}</span></button>
    </div>

    <div v-if="msg" class="msg" :class="msgType">{{ msg }}</div>

    <!-- ===== 百度榜单（热搜/电影/电视剧） ===== -->
    <template v-if="isBoard">
      <div v-if="hotMeta" class="muted" style="margin-bottom:10px">
        {{ boardLabel }} · 共 {{ shownHotItems.length }} 条
        <template v-if="hotMeta.today">
          <template v-if="cat==='hot'"> · 实时数据（约 10 分钟缓存{{ hotMeta.saved ? `，已存档 ${hotMeta.saved} 条` : '' }}）</template>
          <template v-else> · 今日排行（每天 09:00 刷新一次{{ hotMeta.saved ? `，已存档 ${hotMeta.saved} 条` : '' }}）</template>
        </template>
        <template v-else> · 历史存档</template>
        <span v-if="hotMeta.source === 'sina'" class="badge" style="margin-left:6px">百度暂不可达，新浪要闻兜底</span>
        <span v-if="hotMeta.stale" class="badge" style="margin-left:6px">抓取失败，显示上次数据</span>
      </div>

      <!-- 实时热搜列表：排名 + 词条链接 + 摘要 + 指数（悬停封面） -->
      <div v-if="cat==='hot'">
        <div v-for="(h, i) in shownHotItems" :key="h.url" class="card hot-row" style="margin-bottom:8px">
          <span :class="['badge', h.rank <= 3 ? 'red' : 'blue']" style="min-width:28px; text-align:center; align-self:flex-start">{{ h.rank }}</span>
          <img v-if="h.img" :src="h.img" loading="lazy" class="hot-thumb" :alt="h.word" />
          <div class="grow" style="min-width:0">
            <a :href="h.url" target="_blank" rel="noopener" style="font-size:15px; font-weight:600; color:var(--text); text-decoration:none">{{ h.word }}</a>
            <div class="d muted" style="margin-top:4px; font-size:13px">{{ h.desc }}</div>
            <div class="row" style="margin-top:6px; gap:8px; flex-wrap:wrap">
              <span class="badge">{{ h.category }}</span>
              <span class="meta">热搜指数 {{ fmtHot(h.hotScore) }}</span>
            </div>
          </div>
        </div>
        <div v-if="!shownHotItems.length" class="card empty">
          {{ date ? `${date} 没有榜单记录（存档自 ${today} 起累积）` : '榜单加载中，点「立即刷新」重试' }}
        </div>
      </div>

      <!-- 电影/电视剧榜：封面 + 片名 + 类型 + 演员 + 摘要 + 指数 -->
      <div v-else-if="cat==='movie' || cat==='tv'">
        <div class="board-grid">
          <div v-for="h in shownHotItems" :key="h.url" class="card board-card">
            <a :href="h.url" target="_blank" rel="noopener" class="board-cover" :title="h.word">
              <img v-if="h.img" :src="h.img" loading="lazy" :alt="h.word" />
              <span v-else class="muted" style="display:flex; align-items:center; justify-content:center; height:100%">无封面</span>
              <span :class="['badge', h.rank <= 3 ? 'red' : 'blue']" class="board-rank">{{ h.rank }}</span>
            </a>
            <div style="padding:8px 10px">
              <a :href="h.url" target="_blank" rel="noopener" style="font-size:14.5px; font-weight:600; color:var(--text); text-decoration:none">{{ h.word }}</a>
              <div class="row" style="gap:6px; margin-top:6px; flex-wrap:wrap">
                <span v-if="h.extra?.['类型']" class="badge blue">类型：{{ h.extra['类型'] }}</span>
                <span class="meta">指数 {{ fmtHot(h.hotScore) }}</span>
              </div>
              <div v-if="h.extra?.['演员']" class="d" style="margin-top:5px; font-size:12.5px">演员：{{ h.extra['演员'] }}</div>
              <div class="d muted board-desc" style="margin-top:5px; font-size:12.5px" :title="h.desc">{{ h.desc }}</div>
            </div>
          </div>
        </div>
        <div v-if="!shownHotItems.length" class="card empty">
          {{ date ? `${date} 没有榜单记录（存档自 ${today} 起累积）` : '榜单加载中，点「立即刷新」重试' }}
        </div>
      </div>
    </template>

    <!-- ===== 普通新闻（科技/生活/本地） ===== -->
    <template v-else>
      <div v-if="items.length">
        <div class="muted" style="margin-bottom:10px">{{ viewLabel }} · 共 {{ items.length }} 条</div>
        <div v-for="(n,i) in items" :key="n.id" class="card" style="margin-bottom:12px">
          <div class="row" style="align-items:flex-start">
            <span class="badge blue">{{ i+1 }}</span>
            <div class="grow">
              <a :href="n.url" target="_blank" rel="noopener" style="font-size:15px; font-weight:600; color:var(--text); text-decoration:none">
                {{ n.title }}
              </a>
              <div style="margin-top:6px">{{ n.summary }}</div>
              <div class="row" style="margin-top:8px; gap:8px; flex-wrap:wrap">
                <span class="badge" :class="n.source_type === 'ai' ? 'src-ai' : 'src-rss'">{{ n.source_type === 'ai' ? 'AI搜索提炼' : 'RSS' }}</span>
                <span class="badge">来源：{{ n.source }}</span>
                <span class="badge" title="该条新闻抓取耗用的大模型 token：Tavily 为搜索 API（不走大模型），AI token 消耗为 0；如接入 LLM 概括/翻译，此处如实显示具体 token 数与模型名">AI：{{ n.ai_tokens || 0 }} token<template v-if="n.ai_model"> · {{ n.ai_model }}</template></span>
                <span class="muted" v-if="n.published_at">{{ fmtTime(n.published_at) }}</span>
                <span class="muted" v-if="n.fetched_at" title="抓取入库时间（区分早/午批次）">入库 {{ fmtTime(n.fetched_at) }}</span>
                <a v-if="n.url" :href="n.url" target="_blank" rel="noopener" class="link small">阅读原文 →</a>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="card empty">
        <template v-if="cat==='local' && city">
          今天暂无「{{ city }}」相关本地新闻（已按城市过滤），可点击「立即刷新」重试，或在设置中补充本地 RSS 源
        </template>
        <template v-else>{{ viewLabel }}暂无新闻，点击「立即刷新」抓取（首次抓取需连接外网；配置 AI 后自动生成中文摘要）</template>
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';

// tab 顺序：百度热搜在前，原新闻分类居中，影视排行榜殿后（每天 09:00 更新一次）
const cats = [
  { key: 'hot', label: '百度热搜' },
  { key: 'tech', label: '科技' },
  { key: 'life', label: '生活' },
  { key: 'local', label: '本地' },
  { key: 'movie', label: '电影排行榜' },
  { key: 'tv', label: '电视剧排行榜' },
];
// 页面 tab key → 百度 board 参数
const BOARD_OF = { hot: 'realtime', movie: 'movie', tv: 'teleplay' };
// 实时热搜分类（与后端 HOT_CATEGORIES 一致）
const hotCatChips = ['全部', '社会民生/体育', '科技/数码', '娱乐/文娱', '教育/时政', '其他热议'];

const cat = ref('hot');
const items = ref([]);
const hotItems = ref([]);
const hotMeta = ref(null);
const hotCat = ref('全部');
const dates = ref([]);
const date = ref('');
const loading = ref(false);
const msg = ref('');
const msgType = ref('ok');
const city = ref('');
const today = new Date().toISOString().slice(0, 10);

const isBoard = computed(() => !!BOARD_OF[cat.value]);
const boardLabel = computed(() => cats.find((c) => c.key === cat.value)?.label || '');
const currentLabel = computed(() => cats.find((c) => c.key === cat.value)?.label || '');
const viewLabel = computed(() => (date.value ? `${date.value} ${currentLabel.value}新闻` : `今天 ${currentLabel.value}新闻`));
// 热搜按分类筛选（其余榜直接全量）
const shownHotItems = computed(() => {
  if (cat.value !== 'hot' || hotCat.value === '全部') return hotItems.value;
  return hotItems.value.filter((h) => h.category === hotCat.value);
});
function countOf(c) {
  if (c === '全部') return hotItems.value.length;
  return hotItems.value.filter((h) => h.category === c).length;
}

async function load() {
  try {
    if (isBoard.value) {
      const b = BOARD_OF[cat.value];
      // 切板/切日期先清空：避免上一板（或另一板）的数据短暂套进当前模板渲染
      hotItems.value = [];
      hotMeta.value = null;
      const q = date.value ? `&date=${date.value}` : '';
      const r = await api.get(`/news/hotboard?board=${b}${q}`);
      // 请求期间可能又切了 tab：响应只写回仍属于当前板的
      if (BOARD_OF[cat.value] === b) {
        hotItems.value = r.items || [];
        hotMeta.value = r;
      }
      return;
    }
    const q = date.value ? `&date=${date.value}` : '';
    const d = await api.get(`/news?category=${cat.value}${q}`);
    items.value = d.items;
  } catch (e) {
    msg.value = '加载失败：' + e.message;
    msgType.value = 'err';
  }
}

async function loadDates() {
  // 历史日期列表非关键数据：失败只留空列表，不许把异常抛出去打断整页加载
  try {
    if (isBoard.value) {
      const d = await api.get(`/news/hotboard/dates?board=${BOARD_OF[cat.value]}`);
      dates.value = (d.dates || []).filter((x) => x !== today);
      return;
    }
    const d = await api.get('/news/dates');
    dates.value = (d.dates || []).filter((x) => x !== today);
  } catch { dates.value = []; }
}

async function switchCat(c) {
  cat.value = c;
  date.value = '';
  hotCat.value = '全部';
  await loadDates();
  await load();
}

async function refresh() {
  loading.value = true;
  msg.value = '';
  try {
    if (isBoard.value) {
      // 榜单：跳过缓存立即重抓当日（并刷新当日存档）
      const r = await api.get(`/news/hotboard?board=${BOARD_OF[cat.value]}&fresh=1`);
      // items 恒为数组（服务端 v1.9.2 已保证；前端再兜一层防 length 崩溃）
      hotItems.value = Array.isArray(r.items) ? r.items : [];
      hotMeta.value = r;
      date.value = '';
      msg.value = `已刷新，共 ${hotItems.value.length} 条${r.saved ? `，当日存档 ${r.saved} 条` : ''}`;
      await loadDates();
    } else {
      const r = await api.post('/news/refresh', { category: cat.value });
      const added = r.added?.[cat.value] ?? 0;
      msg.value = `刷新完成，新增 ${added} 条`;
      await loadDates();
      await load();
    }
    msgType.value = 'ok';
  } catch (e) {
    msg.value = '刷新失败：' + e.message;
    msgType.value = 'err';
  } finally {
    loading.value = false;
  }
}

function fmtTime(t) {
  if (!t) return '';
  return t.replace('T', ' ').slice(5, 16);
}
// 热搜指数格式化：7808883 → 780.9万
function fmtHot(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return String(v);
}

onMounted(async () => {
  await loadDates();
  await load();
  try {
    const w = await api.get('/weather');
    if (w.ok) city.value = w.city;
  } catch {}
});
</script>

<style scoped>
.badge.src-ai { background: rgba(79, 124, 247, .18); color: var(--accent); border: 1px solid var(--accent); font-weight: 600; }
.badge.src-rss { background: var(--bg3); color: var(--text3); }

/* 分类筛选 chip */
.cat-chip { border-radius: 14px; }
.cat-chip.on { background: var(--accent); color: #fff; border-color: var(--accent); }
.cat-chip.on .muted { color: rgba(255,255,255,.75); }

/* 实时热搜行 */
.hot-row { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; }
.hot-thumb { width: 104px; height: 68px; object-fit: cover; border-radius: 8px; flex-shrink: 0; margin-top: 2px; }

/* 电影/电视剧卡片网格 */
.board-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.board-card { overflow: hidden; display: flex; flex-direction: column; }
.board-cover { position: relative; display: block; aspect-ratio: 3/4; background: var(--bg3); }
.board-cover img { width: 100%; height: 100%; object-fit: cover; display: block; }
.board-rank { position: absolute; left: 8px; top: 8px; }
.board-desc { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
</style>
