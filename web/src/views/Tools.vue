<template>
  <div>
    <h2 class="page-title">效率工具</h2>
    <div class="tabs">
      <!-- 录音转写（v1.10.10，需求⑨）：**第一个** tab，也是本页默认落点。 -->
      <button v-if="canTab('tools','vibe')" :class="{active: tab==='vibe'}" @click="switchTab('vibe')">录音转写</button>
      <!-- 智作平台（文案库，v1.6.2）：iframe 嵌同源 /zhizu/，自带登录/角色，随工作台进程启动 -->
      <button v-if="canTab('tools','zhizu')" :class="{active: tab==='zhizu'}" @click="switchTab('zhizu')">智作平台</button>
      <button v-if="canTab('tools','clip')" :class="{active: tab==='clip'}" @click="switchTab('clip')">剪贴板</button>
      <button v-if="canTab('tools','links')" :class="{active: tab==='links'}" @click="switchTab('links')">快捷启动</button>
      <!-- v1.10.10（需求⑨）：原来在这里的「学习计划 / 学习记录 / 复盘」三个 tab 已按用户要求去掉 -->
      <button v-if="canTab('tools','monitor')" :class="{active: tab==='monitor'}" @click="switchTab('monitor')">电脑监控</button>
      <button v-if="canTab('tools','tts')" :class="{active: tab==='tts'}" @click="switchTab('tts')">语音配音</button>
      <!-- 电子宠物（v1.10.10，需求⑨）：原独立侧栏页整体并入本页，六个子 tab 在面板内部 -->
      <button v-if="canTab('tools','pets')" :class="{active: tab==='pets'}" @click="switchTab('pets')">电子宠物</button>
      <!-- 推送任务（原「业务系统」独立页整页并入，2026-09 v1.7.0；内含 4 个子 tab，任一子 tab 有权限即可见） -->
      <button v-if="canBusiness" :class="{active: tab==='business'}" @click="switchTab('business')">推送任务</button>
      <!-- 文件存档（原独立页并入）：倒数第二个 tab -->
      <button v-if="canTab('tools','files')" :class="{active: tab==='files'}" @click="switchTab('files')">文件存档</button>
      <!-- 全局搜索（原独立页并入）：最后一个 tab（右下角悬浮搜索框直达） -->
      <button v-if="canTab('tools','search')" :class="{active: tab==='search'}" @click="switchTab('search')">全局搜索</button>
    </div>

    <!-- ============ 智作平台（文案库整体嵌入，v1.6.2） ============ -->
    <template v-if="tab==='zhizu'">
      <div class="zhizu-card">
        <div v-if="zhizuLoading" class="muted" style="padding:48px; text-align:center">智作平台加载中…（服务随工作台自动启动，首次约需几秒）</div>
        <!-- src 补网关前缀（v1.9.2）：fnOS 网关下硬编码 /zhizu/ 会打到 NAS 根路径 404（「智作平台找不到」） -->
        <iframe v-show="!zhizuLoading" :src="prefixUrl('/zhizu/')" class="zhizu-frame" title="智作平台" @load="zhizuLoading = false"></iframe>
      </div>
    </template>

    <template v-else-if="tab==='clip'">
      <div class="card" style="margin-bottom:12px">
        <h3>🖥 剪贴板采集 <span class="muted" style="font-size:12px; font-weight:400">Windows 电脑把系统剪贴板自动推送到本页（仅脚本采集）</span></h3>
        <div v-if="meAdmin" class="row" style="gap:10px; flex-wrap:wrap">
          <button class="primary" @click="dlClip('setup')">⬇ 下载采集脚本 (ps1)</button>
          <button class="primary" @click="dlClip('install')">⬇ 下载安装批处理 (bat)</button>
          <button class="primary" @click="dlClip('uninstall')">⬇ 下载卸载脚本 (bat)</button>
        </div>
        <div class="muted" style="margin-top:8px; font-size:12.5px; line-height:1.8">
          安装：两个文件（clipboard-setup.ps1 + install-clipboard.bat）放同一文件夹，双击 install-clipboard.bat 即完成——装到
          <code>%LOCALAPPDATA%\WorkbenchClipboard</code>，开机自动采集，无需管理员权限；卸载双击 uninstall-clipboard.bat。<br />
          脚本按<b>本次下载所用的地址</b>（IP 或域名）自动连接；采集内容进入下载账号（管理员）的剪贴板列表。<span v-if="!meAdmin">脚本下载需管理员账号。</span>
        </div>
        <!-- 已登记电脑：点击计算机名即筛选该电脑的记录（再点一次取消） -->
        <div v-if="clipDevices.length" style="margin-top:10px; border-top:1px dashed var(--border); padding-top:8px">
          <div class="muted" style="font-size:11.5px; margin-bottom:4px">点击计算机名查看该电脑的记录：</div>
          <div v-for="d in clipDevices" :key="d.id" class="clip-dev clip-dev-click"
               :class="{ 'clip-dev-active': clipFilter.device === d.host }"
               @click="pickDevice(d.host)">
            <span class="badge" :class="clipOnline(d) ? 'green' : 'red'">{{ clipOnline(d) ? '在线' : '离线' }}</span>
            <b style="font-size:13px">💻 {{ d.host }}</b>
            <span class="muted" style="font-size:12px">最近上报 {{ fmtTs(d.last_seen) }} · 累计推送 {{ d.push_count }} 条</span>
            <span v-if="clipFilter.device === d.host" class="muted" style="font-size:11px">← 正在查看，点击取消</span>
          </div>
        </div>
      </div>
      <!-- 筛选栏：关键字 / 电脑 / 时间范围 -->
      <div class="card" style="margin-bottom:12px">
        <div class="row" style="flex-wrap:wrap; gap:8px; align-items:flex-end">
          <div class="form-row grow" style="min-width:200px">
            <label>搜索关键字</label>
            <input v-model="clipFilter.q" placeholder="内容包含的关键字…" @keyup.enter="clipSearch" />
          </div>
          <div class="form-row" style="flex:0 0 170px">
            <label>电脑</label>
            <select v-model="clipFilter.device" @change="clipSearch">
              <option value="">全部电脑</option>
              <option v-for="d in clipDevices" :key="d.id" :value="d.host">{{ d.host }}</option>
            </select>
          </div>
          <div class="form-row" style="flex:0 0 155px">
            <label>开始日期</label>
            <input type="date" v-model="clipFilter.start" @change="clipSearch" />
          </div>
          <div class="form-row" style="flex:0 0 155px">
            <label>结束日期</label>
            <input type="date" v-model="clipFilter.end" @change="clipSearch" />
          </div>
          <button class="primary" @click="clipSearch">🔍 搜索</button>
          <button class="small" @click="clipReset">重置</button>
        </div>
      </div>
      <div class="card">
        <div class="row" style="justify-content:space-between; margin-bottom:8px; flex-wrap:wrap; gap:8px">
          <span class="muted" style="font-size:12px">共 {{ clipTotal }} 条{{ clipFilter.device ? ' · ' + clipFilter.device : '' }}</span>
          <div class="row" style="gap:6px; align-items:center">
            <span class="muted" style="font-size:12px">每页</span>
            <select v-model.number="clipSize" style="width:64px" @change="clipSearch">
              <option v-for="n in [5, 15, 30, 50, 100]" :key="n" :value="n">{{ n }}</option>
            </select>
            <span class="muted" style="font-size:12px">条</span>
          </div>
        </div>
        <div v-for="c in clips" :key="c.id" class="list-item">
          <div class="grow">
            <!-- 来源电脑在前、时间在后、内容在下一行（2026-09 用户要求：内容前要有登记的电脑与时间） -->
            <div class="meta" style="margin-bottom:3px">
              <span class="badge blue">💻 {{ c.device || '未知来源' }}</span> · {{ c.created_at?.slice(0,19) }}
            </div>
            <div style="white-space:pre-wrap; word-break:break-word">{{ c.content }}</div>
          </div>
          <button class="small" @click="copy(c.content)">复制</button>
          <button class="icon-btn" @click="delClip(c)">✕</button>
        </div>
        <div v-if="!clips.length" class="empty">暂无剪贴板记录（仅收脚本采集）</div>
        <!-- 分页：前后翻页 + 每页条数 -->
        <div v-if="clipPages > 1" class="row" style="justify-content:center; gap:10px; margin-top:10px; align-items:center">
          <button class="small" :disabled="clipPage <= 1" @click="clipGoPage(clipPage - 1)">← 上一页</button>
          <span class="muted" style="font-size:12.5px">第 {{ clipPage }} / {{ clipPages }} 页</span>
          <button class="small" :disabled="clipPage >= clipPages" @click="clipGoPage(clipPage + 1)">下一页 →</button>
        </div>
      </div>
    </template>

    <template v-else-if="tab==='links'">
      <div class="card" style="margin-bottom:12px">
        <div class="row">
          <input v-model="link.name" placeholder="名称" style="width:150px" />
          <input v-model="link.url" placeholder="URL（https://...）" class="grow" />
          <input v-model="link.icon" placeholder="图标(emoji)" style="width:110px" />
          <select v-model="link.category" style="width:110px">
            <option value="general">常用</option>
            <option value="work">工作</option>
            <option value="study">学习</option>
            <option value="life">生活</option>
          </select>
          <button class="primary" @click="addLink">添加</button>
        </div>
      </div>
      <div class="card">
        <div class="grid g3">
          <a v-for="l in links" :key="l.id" :href="l.url" target="_blank" rel="noopener"
             class="list-item" style="border:1px solid var(--border); border-radius:10px; padding:14px; text-decoration:none; color:var(--text)">
            <div style="font-size:26px; margin-bottom:6px">{{ l.icon || '🔗' }}</div>
            <div class="t">{{ l.name }}</div>
            <div class="meta">{{ l.category }} · {{ host(l.url) }}</div>
            <div style="margin-top:8px; display:flex; justify-content:flex-end">
              <button class="icon-btn" @click.prevent="delLink(l)">✕</button>
            </div>
          </a>
        </div>
        <div v-if="!links.length" class="empty">暂无快捷应用，添加常用网址即可一键打开</div>
      </div>
    </template>

    <!-- ============ 三大测评中心已移至「私有项目」页（2026-09 v1.6.2） ============ -->
    <!-- v1.10.10（需求⑨）：原「学习计划 / 学习记录 / 复盘」三个 tab 的中段标记整块删除。
         后端 /learning/plans、/learning/records、/reviews 三个端点与它们的表**都还在**，
         数据一条没动，只是界面上不再有入口。 -->

    <!-- ============ 电脑监控（v1.3.5） ============ -->
    <MonitorPanel v-else-if="tab==='monitor'" />

    <!-- ============ 语音配音（自学习页移来，2026-09 v1.6.5） ============ -->
    <TtsPanel v-else-if="tab==='tts'" />

    <!-- ============ 录音转写（VibeVoice-ASR，默认 tab） ============ -->
    <VibeVoiceTab v-else-if="tab==='vibe'" />

    <!-- ============ 电子宠物（原独立侧栏页整页并入，v1.10.10 需求⑨） ============ -->
    <PetsPanel v-else-if="tab==='pets'" embedded :sub="String(route.query.sub || '')" />

    <!-- ============ 推送任务（原「业务系统」页整页并入，v1.7.0） ============ -->
    <BusinessPanel v-else-if="tab==='business'" />

    <!-- ============ 文件存档（原独立页并入，v1.7.0） ============ -->
    <FilesPanel v-else-if="tab==='files'" />

    <!-- ============ 全局搜索（原独立页并入，v1.7.0；?q= 带词自动执行） ============ -->
    <SearchPanel v-else-if="tab==='search'" />

    <!-- ============ 兜底 ============ -->
    <!-- v1.10.10 之前这里是「复盘」的 v-else 分支。复盘去掉后不能再拿它兜底（否则任意未匹配的
         tab key 都会渲染出复盘表单），改成一句提示。tab 已在 script 里用 TAB_DEFS 校验过，
         正常路径到不了这里；真到了（旧书签 /tools?tab=dep 之类）也只是这一句，不会白屏。 -->
    <div v-else class="card muted" style="padding:24px; text-align:center">
      这个 tab 已经不在「效率工具」里了（或没有对应权限）—— 请从上面的 tab 栏重新选一个。
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
// marked 随「复盘」tab 一起去掉了（那是本页唯一用到 markdown 渲染的地方）
import { api, prefixUrl } from '../api';
import { canTab, firstTab, TAB_DEFS } from '../tabs';
import MonitorPanel from '../components/MonitorPanel.vue';
import VibeVoiceTab from '../components/VibeVoiceTab.vue';
import TtsPanel from '../learning/TtsPanel.vue';
// v1.7.0 整页并入的三个原独立页（组件内部自带子 tab 与数据加载）
import BusinessPanel from './Business.vue';
import FilesPanel from './Files.vue';
import SearchPanel from './Search.vue';
// 电子宠物（v1.10.10，需求⑨）：原独立页整页并入本页的一个 tab（embedded 少画一层页标题）
import PetsPanel from './Pets.vue';

const route = useRoute();
const router = useRouter();

// v1.10.10（需求⑨）：默认落点改回**录音转写**（用户要求「效率工具默认进入后显示录音转写」）。
// 2026-09-23 曾按当时的要求改成智作平台，现在按新要求改回来；录音转写同时是 tab 栏第一个。
const tab = ref(firstTab('tools', 'vibe'));
// 支持 /tools?tab=xxx 直达；切 tab 时同步地址栏（旧的 /learning?tab=plans 之类会落在兜底提示上）
// canTab 对管理员「未知 key」也放行（allowedTabs=null），必须再用 TAB_DEFS 校验 key 真实存在——
// 否则旧收藏 /tools?tab=dep（已移入私有项目）会把 tab 置成不存在的键，无高亮且内容落进兜底分支
const isToolsTab = (t) => TAB_DEFS.tools.some((d) => d.key === t);
function switchTab(t) {
  tab.value = t;
  // sub 只对「电子宠物」有意义（那是它内部子 tab 的落点参数）；切走时一并清掉，
  // 免得地址栏里留着一个已经无关的 sub，回头再点电子宠物又被拽回旧子 tab。
  const q = { ...route.query, tab: t };
  if (t !== 'pets') delete q.sub;
  router.replace({ query: q });
}
watch(() => route.query.tab, (t) => {
  if (t) {
    if (t !== tab.value && isToolsTab(String(t)) && canTab('tools', String(t))) { tab.value = String(t); load(); }
    return;
  }
  // 地址栏里没有 tab 了（最常见的是在 /tools?tab=pets 上点侧栏「效率工具」——
  // 同文档内的 hash 跳转不会重挂组件，tab 会一直停在旧值）→ 回到默认落点。
  tab.value = firstTab('tools', 'vibe');
});
if (route.query.tab && isToolsTab(String(route.query.tab)) && canTab('tools', String(route.query.tab))) tab.value = String(route.query.tab);

const clips = ref([]);
const clipDevices = ref([]);
// 剪贴板分页 + 筛选（v1.6.6：默认 15 条/页，可 5/15/30/50/100；关键字/电脑/时间范围）
const clipTotal = ref(0);
const clipPage = ref(1);
const clipSize = ref(15);
const clipFilter = ref({ device: '', q: '', start: '', end: '' });
const clipPages = computed(() => Math.max(1, Math.ceil(clipTotal.value / clipSize.value)));
const meAdmin = (() => { try { return JSON.parse(localStorage.getItem('wb_user') || '{}').role === 'admin'; } catch { return false; } })();
// 推送任务按钮可见性：整页键 'business' 或任一子 tab 键（sys/skill/push/config）有权限即可见
// （老用户授权迁移后细分键挂在 tools 下，没有单独的 'business' 键）
const canBusiness = computed(() =>
  canTab('tools', 'business') || ['sys', 'skill', 'push', 'config'].some((k) => canTab('tools', k)));
const links = ref([]);
const link = ref({ name: '', url: '', icon: '', category: 'general' });

// ---------- 智作平台（v1.6.2） ----------
const zhizuLoading = ref(true);

// ---------- 剪贴板采集（v1.6.2） ----------
function dlClip(type) {
  api.download(`/clipboard/agent?type=${type}`).catch((e) => alert('下载失败：' + e.message));
}
const clipOnline = (d) => Date.now() - (Number(d.last_seen) || 0) < 15 * 60 * 1000; // 15 分钟内有上报=在线（与服务端一致）
const fmtTs = (ms) => (Number(ms) > 0 ? new Date(Number(ms)).toLocaleString('sv').slice(0, 19) : '—');

// ---------- 学习计划 / 学习记录 / 复盘：v1.10.10（需求⑨）已整块移除 ----------
// 三个 tab 的表单、列表与请求函数（/learning、/learning/plans、/learning/records、/reviews、
// /ai/review）全部删掉，连带 data/reviews/plan/rec/reviewDraft/reviewPeriod/aiLoading 这几个 ref。
// 后端端点与数据没动 —— 想恢复只要把中段标记和这几个函数加回来。

async function load() {
  // 各数据源独立容错：无对应 tab 权限时接口 403，不能拖垮其他 tab
  // （推送任务/文件存档/全局搜索的数据在各自组件内加载）
  try { await loadClips(); } catch { clips.value = []; clipTotal.value = 0; }
  try { if (canTab('tools', 'clip')) clipDevices.value = await api.get('/clipboard/devices'); } catch { clipDevices.value = []; }
  try { links.value = await api.get('/links'); } catch { links.value = []; }
}

// 剪贴板：服务端分页拉取（筛选条件变化一律回到第 1 页）
async function loadClips() {
  const f = clipFilter.value;
  const qs = new URLSearchParams({
    page: String(clipPage.value), size: String(clipSize.value),
    device: f.device || '', q: f.q || '', start: f.start || '', end: f.end || '',
  });
  const d = await api.get('/clipboard?' + qs.toString());
  clips.value = d.items || [];
  clipTotal.value = d.total || 0;
}
function clipSearch() { clipPage.value = 1; loadClips(); }
function clipReset() { clipFilter.value = { device: '', q: '', start: '', end: '' }; clipPage.value = 1; loadClips(); }
function clipGoPage(n) {
  if (n < 1 || n > clipPages.value || n === clipPage.value) return;
  clipPage.value = n;
  loadClips();
}
// 点击上方计算机名：筛选该电脑（再点一次取消）
function pickDevice(host) {
  clipFilter.value.device = clipFilter.value.device === host ? '' : host;
  clipSearch();
}
async function delClip(c) {
  await api.del(`/clipboard/${c.id}`);
  // 当前页删空后自动前翻一页（保持停留在有效页）
  if (clips.value.length === 1 && clipPage.value > 1) clipPage.value -= 1;
  await loadClips();
}
function copy(text) {
  navigator.clipboard?.writeText(text).then(() => {});
}

async function addLink() {
  if (!link.value.name.trim() || !link.value.url.trim()) return;
  await api.post('/links', link.value);
  link.value = { name: '', url: '', icon: '', category: 'general' };
  await load();
}
async function delLink(l) { await api.del(`/links/${l.id}`); await load(); }
function host(url) {
  try { return new URL(url).hostname.replace('www.', ''); } catch { return url; }
}

onMounted(load);
</script>

<style scoped>
/* 智作平台 iframe：占满内容区剩余高度（文案库暗紫主题整页嵌入） */
.zhizu-card { border: 1px solid var(--border); border-radius: 12px; overflow: hidden; background: #14061f; }
.zhizu-frame { width: 100%; height: calc(100vh - 205px); min-height: 620px; border: 0; display: block; }
/* 剪贴板采集：已登记电脑行 */
.clip-dev { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 12.5px; flex-wrap: wrap; }
.clip-dev-click { cursor: pointer; border-radius: 8px; padding: 2px 8px; margin: 2px 0; transition: background .15s; }
.clip-dev-click:hover { background: var(--bg2, rgba(0,0,0,.05)); }
.clip-dev-active { background: var(--bg2, rgba(0,0,0,.08)); outline: 1px solid var(--border); }
</style>
