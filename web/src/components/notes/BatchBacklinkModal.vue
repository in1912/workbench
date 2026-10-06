<template>
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal" style="width:min(720px,94vw); max-height:88vh; display:flex; flex-direction:column">
      <h3>🔗 批量链接</h3>

      <!-- 四种批量操作（v1.10.24 互链；v1.10.28 循环链 / 取消链接；v1.10.31 AI 连接） -->
      <div class="row" style="gap:14px; flex-wrap:wrap; margin-bottom:8px">
        <label v-for="m in MODES" :key="m.key" class="bl-mode" :class="{ on: mode === m.key }">
          <input type="radio" style="width:auto" :checked="mode === m.key" @change="mode = m.key" />
          {{ m.label }}
        </label>
      </div>

      <div class="muted" style="font-size:12.5px; margin-bottom:10px">
        <template v-if="mode === 'mutual'">
          按关键词搜出相关的一批笔记（匹配<b>标题或正文</b>），勾选后在每篇末尾的
          <code>## 关联笔记</code> 小节里<b>两两互加</b> <code>[[标题]]</code> 双链 ——
          让这一批笔记互相引用，而不是只指向同一篇枢纽。
          <br>重复执行<b>只补缺</b>：已经链过（包括你自己手写的同名链接）不会重复加；
          没有新链接要补的笔记一个字节都不动。
        </template>
        <template v-else-if="mode === 'chain'">
          按列表顺序把勾选的笔记<b>串成一条环</b>：每篇只在 <code>## 关联笔记</code> 小节里加
          <b>一条</b>指向下一篇的 <code>[[标题]]</code> 链接、<b>末篇链回首篇</b> ——
          适合系列、连载、日记这类有先后关系的笔记，顺着一条线读到底，
          不会像互链那样把整批标题都塞进每一篇。
          <br>列表里的序号就是串链顺序（可在搜索后用「倒序」翻转）；重复执行<b>只补缺</b>，已链过的不会重复加。
        </template>
        <template v-else-if="mode === 'ai'">
          不用你敲关键词：<b>AI 通读候选笔记（标题 + 摘要），提炼关键字和标签、把内容相关的分成组</b>；
          你挑一组确认后，再用「两两互链 / 循环链」执行 —— <b>AI 只筛不写</b>，落链接的还是前两种操作
          （幂等、可撤销，规矩一样）。可先筛「从未链接过」（等待链接的笔记）或「有过链接」的。
          分析在服务器后台跑，关掉这个弹窗不中断，重新打开接着看。
        </template>
        <template v-else>
          清掉勾选笔记 <code>## 关联笔记</code> 小节里的链接条目，小节清空后小节头也不留 ——
          是前两个操作的<b>逆操作</b>。
          <br><b>只清整行就是 <code>- [[标题]]</code> 的条目</b>：正文里你自己手写的
          <code>[[链接]]</code>、以及带说明文字的条目（如「- 相关：[[xx]]」）一律不动；
          没有可清条目的笔记一个字节都不动。
        </template>
      </div>

      <!-- 关键词搜索（前三种种模式用） -->
      <div v-if="mode !== 'ai'" class="row" style="gap:6px; flex-wrap:wrap; align-items:center">
        <input v-model="q" placeholder="关键词，如「装修」「Vite 笔记」" style="flex:1; min-width:220px"
               @keydown.enter.prevent="search" />
        <button class="small" :disabled="searching || !q.trim()" @click="search">{{ searching ? '搜索中…' : '搜索' }}</button>
      </div>

      <!-- AI 连接：范围 + 筛选 + 分析按钮 + 进度 + 分组结果 -->
      <template v-else>
        <div v-if="aiMeta && !aiMeta.has_ai" class="msg err" style="margin-bottom:8px">
          AI 尚未配置：请先到「设置 → AI 模型」填写模型名称 / API 地址 / API Key。
        </div>
        <div class="row" style="gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:8px">
          <select v-model="aiFolder" class="grow" style="min-width:200px; flex:1"
                  title="在哪个范围里找候选笔记（含全部子文件夹）" :disabled="aiRunning">
            <option v-for="f in aiFolderOptions" :key="f.id" :value="f.id">{{ f.label }}</option>
          </select>
          <div class="pills" style="gap:4px">
            <button v-for="s in aiScopes" :key="s.key" class="pill" :class="{ on: aiScope === s.key }"
                    :title="s.hint" :disabled="aiRunning" @click="aiScope = s.key">{{ s.label }}</button>
          </div>
          <button class="small primary" :disabled="aiRunning || (aiMeta && !aiMeta.has_ai)" @click="aiAnalyze">
            {{ aiRunning ? '分析中…（可先去干别的）' : '🤖 AI 分析' }}
          </button>
          <button v-if="aiRunning" class="small" @click="aiCancel">取消</button>
        </div>

        <!-- 进度卡（后台任务快照；关弹窗不中断，重开接着看） -->
        <div v-if="aiJob && aiJob.state === 'running'" class="ai-prog">
          <div class="row" style="align-items:center; gap:8px">
            <span class="muted small" style="flex:1">{{ aiJob.stage_label }} · {{ aiJob.progress }}%</span>
            <span class="muted small">已进行 {{ fmtDur(aiElapsedS) }}<template v-if="aiJob.stage === 'ai'"> · AI 已等 {{ aiWaitS }} 秒</template></span>
          </div>
          <div class="bar"><div class="fill" :style="{ width: aiJob.progress + '%' }"></div></div>
          <div ref="aiLogsEl" class="ai-logs">
            <div v-for="(l, i) in aiJob.logs" :key="i" class="logline">[{{ fmtClock(l.t) }}] {{ l.msg }}</div>
          </div>
        </div>
        <div v-if="aiJob && aiJob.state === 'error'" class="msg err">分析失败：{{ aiJob.error }}</div>
        <div v-if="aiJob && aiJob.state === 'cancelled'" class="muted small">已取消分析（重新点「AI 分析」可再来）。</div>

        <!-- 分组结果：每组可勾、可倒序、按组执行互链/循环链 -->
        <div v-if="aiGroups.length" class="muted small" style="margin:6px 0 2px">
          AI 分出 {{ aiGroups.length }} 组、覆盖 {{ aiGroupedCount }} / {{ aiJob.result.notes_candidates }} 篇候选
          （{{ aiJob.result.scope_label }}<template v-if="aiJob.result.folder_id"> · {{ aiJob.result.folder_name }}</template>）。
          挑一组核对后执行；不合适的组直接忽略就好。
        </div>
        <div v-if="aiGroups.length" class="ai-groups">
          <div v-for="(g, gi) in aiGroups" :key="gi" class="ai-group">
            <div class="row" style="gap:8px; align-items:center; flex-wrap:wrap">
              <span class="ai-kw">{{ g.keyword }}</span>
              <span class="muted small">{{ g.note_ids.length }} 篇</span>
              <span class="muted small grow" style="flex:1; min-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap"
                    :title="g.reason">{{ g.reason }}</span>
              <button class="small" title="循环链按列表顺序串，翻转让顺序反过来" @click="aiRev[gi] = !aiRev[gi]">⇅ 倒序</button>
              <button class="small primary" :disabled="aiBusy === gi || aiPick(gi).size < 2" @click="aiRunGroup(gi, 'mutual')">
                互链已勾选（{{ aiPick(gi).size }}）
              </button>
              <button class="small primary" :disabled="aiBusy === gi || aiPick(gi).size < 2" @click="aiRunGroup(gi, 'chain')">
                循环链已勾选（{{ aiPick(gi).size }}）
              </button>
            </div>
            <div class="ai-notes">
              <label v-for="n in aiGroupNotes(gi)" :key="n.id" class="bl-row" :class="{ on: aiPick(gi).has(n.id) }">
                <input type="checkbox" :checked="aiPick(gi).has(n.id)" style="width:auto" @change="aiToggle(gi, n.id)" />
                <span class="bl-title">{{ n.title }}</span>
              </label>
            </div>
            <div v-if="aiMsgs[gi]" class="muted small" style="margin-top:4px">{{ aiMsgs[gi] }}</div>
          </div>
        </div>
        <div v-else-if="aiJob && aiJob.state === 'done'" class="muted" style="margin:10px 0">
          AI 认为这批候选里没有明显值得互相链接的组合（宁缺毋滥）。换个筛选范围或文件夹再试。
        </div>
      </template>

      <div v-if="err" class="msg err">{{ err }}</div>
      <div v-if="msg" class="msg ok">{{ msg }}</div>

      <div v-if="rows.length" style="margin:10px 0 4px; display:flex; align-items:center; gap:10px; flex-wrap:wrap">
        <label style="display:flex; align-items:center; gap:4px; font-size:13px">
          <input type="checkbox" :checked="allChecked" style="width:auto" @change="toggleAll" /> 全选
        </label>
        <span class="muted" style="font-size:12.5px">搜到 {{ rows.length }} 篇，已勾选 {{ checked.size }} 篇</span>
        <button v-if="mode === 'chain'" class="small" title="循环链按列表顺序串，翻转它让顺序反过来（如搜索默认新的在前、系列要从旧往新读时）"
                @click="rows = [...rows].reverse()">⇅ 倒序</button>
      </div>

      <div v-if="rows.length" class="bl-list">
        <label v-for="r in rows" :key="r.id" class="bl-row" :class="{ on: checked.has(r.id) }">
          <input type="checkbox" :checked="checked.has(r.id)" style="width:auto" @change="toggle(r.id)" />
          <span v-if="mode === 'chain' && chainPos.has(r.id)" class="bl-badge" :class="{ off: !checked.has(r.id) }"
                :title="checked.has(r.id) ? `串链顺序第 ${chainPos.get(r.id)} 篇` : '未勾选，不参与串链'">{{ chainPos.get(r.id) }}</span>
          <span class="bl-title">{{ r.title }}</span>
          <span class="muted bl-meta">{{ r.folder_path || r.folder || '（未分组）' }} · {{ r.word_count || 0 }} 字</span>
        </label>
      </div>
      <div v-else-if="searched && !searching && mode !== 'ai'" class="muted" style="margin:12px 0">
        没有匹配的笔记。换个关键词试试。
      </div>

      <div class="row" style="margin-top:auto; padding-top:12px; gap:8px; justify-content:flex-end">
        <button class="small" @click="$emit('close')">关闭</button>
        <button v-if="mode !== 'ai'" class="small primary" :disabled="running || checked.size < minNeed" @click="run">
          {{ running ? runDoing : runLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, nextTick } from 'vue';
import { api } from '../../api';

const emit = defineEmits(['close', 'done']);

const MODES = [
  { key: 'mutual', label: '两两互链' },
  { key: 'chain', label: '循环链接' },
  { key: 'ai', label: 'AI 连接' },
  { key: 'clear', label: '取消链接' },
];

const mode = ref('mutual');
const q = ref('');
const rows = ref([]);
const checked = ref(new Set());
const searching = ref(false);
const searched = ref(false);
const running = ref(false);
const err = ref('');
const msg = ref('');

const allChecked = computed(() => rows.value.length > 0 && rows.value.every((r) => checked.value.has(r.id)));
// 循环链的顺序 = 勾选行在列表里的展示顺序；序号徽标按勾选集合重排（取消勾选后后面的自动顶上）
const chainPos = computed(() => {
  const m = new Map();
  if (mode.value !== 'chain') return m;
  let i = 0;
  for (const r of rows.value) if (checked.value.has(r.id)) m.set(r.id, ++i);
  return m;
});
const minNeed = computed(() => (mode.value === 'clear' ? 1 : 2));
const runLabel = computed(() => ({
  mutual: `添加互链（已选 ${checked.value.size} 篇）`,
  chain: `串成循环链（已选 ${checked.value.size} 篇）`,
  clear: `取消链接（已选 ${checked.value.size} 篇）`,
})[mode.value]);
const runDoing = computed(() => ({ mutual: '互链中…', chain: '串链中…', clear: '取消中…' })[mode.value]);

async function search() {
  if (!q.value.trim()) return;
  err.value = ''; msg.value = '';
  searching.value = true; searched.value = true;
  try {
    const r = await api.get(`/notes/search?mode=keyword&q=${encodeURIComponent(q.value.trim())}&limit=200`);
    rows.value = r.rows || [];
    checked.value = new Set(rows.value.map((x) => x.id));   // 默认全选：批量场景下多半就是要全要
  } catch (e) {
    rows.value = []; checked.value = new Set();
    err.value = String((e && e.message) || e || '搜索失败');
  } finally {
    searching.value = false;
  }
}

function toggle(id) {
  const s = new Set(checked.value);
  s.has(id) ? s.delete(id) : s.add(id);
  checked.value = s;
}
function toggleAll() {
  checked.value = allChecked.value ? new Set() : new Set(rows.value.map((r) => r.id));
}

async function run() {
  if (checked.value.size < minNeed.value || running.value) return;
  err.value = ''; msg.value = '';
  running.value = true;
  try {
    const ep = { mutual: '/notes/backlink-mutual', chain: '/notes/backlink-chain', clear: '/notes/backlink-clear' }[mode.value];
    // 循环链按展示顺序传 ids（数组顺序 = 链的顺序）；另两种与顺序无关
    const ids = mode.value === 'chain'
      ? rows.value.filter((r) => checked.value.has(r.id)).map((r) => r.id)
      : [...checked.value];
    const r = await api.post(ep, { ids });
    if (mode.value === 'mutual') {
      msg.value = `互链完成：${r.updated} 篇笔记新增 ${r.links_added} 条链接`
        + (r.updated < checked.value.size ? `（其余 ${checked.value.size - r.updated} 篇本来就链齐了，没动）` : '');
    } else if (mode.value === 'chain') {
      msg.value = `循环链完成：${r.updated} 篇各补 1 条「下一篇」链接`
        + (r.updated < checked.value.size ? `（其余 ${checked.value.size - r.updated} 篇已经链过，没动）` : '');
    } else {
      msg.value = `取消完成：${r.updated} 篇共移除 ${r.links_removed} 条链接`
        + (r.updated < checked.value.size ? `（其余 ${checked.value.size - r.updated} 篇没有可清的条目，没动）` : '');
    }
    emit('done');
  } catch (e) {
    err.value = String((e && e.message) || e || '操作失败');
  } finally {
    running.value = false;
  }
}

// ---------- AI 连接（v1.10.31）：分析是后台任务，落链接复用互链/循环链 ----------
const aiMeta = ref(null);
const aiScopes = [
  { key: 'unlinked', label: '从未链接过', hint: 'note_links 里两侧都没出现过的笔记——等待链接的那批' },
  { key: 'linked', label: '有过链接', hint: '已经出现在双链关系里的笔记（含别人链它）' },
  { key: 'all', label: '全部', hint: '不按链接状态筛' },
];
const aiScope = ref('unlinked');
const aiFolder = ref(0);          // 0 = 全库
const aiFolderOptions = ref([{ id: 0, label: '全库笔记' }]);
const aiJob = ref(null);
const aiTick = ref(0);
const aiLogsEl = ref(null);
const aiChecks = ref({});          // 组序号 → Set(笔记 id)
const aiRev = ref({});             // 组序号 → 是否倒序（影响循环链顺序）
const aiMsgs = ref({});
const aiBusy = ref(-1);
let aiTimer = null, aiTicker = null, aiFails = 0;

const aiRunning = computed(() => aiJob.value?.state === 'running');
const aiGroups = computed(() => (aiJob.value?.state === 'done' && aiJob.value.result?.groups) || []);
const aiGroupedCount = computed(() => aiJob.value?.result?.notes_grouped ?? 0);
const aiElapsedS = computed(() => {
  aiTick.value;
  const j = aiJob.value;
  if (!j) return 0;
  return Math.max(0, Math.round(((j.finished_at || Date.now()) - j.started_at) / 1000));
});
const aiWaitS = computed(() => {
  aiTick.value;
  const t0 = aiJob.value?.ai_started_at;
  return t0 ? Math.max(0, Math.round((Date.now() - t0) / 1000)) : 0;
});
const fmtDur = (s) => (s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`);
const fmtClock = (ms) => {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

function aiStopTimers() {
  if (aiTimer) { clearInterval(aiTimer); aiTimer = null; }
  if (aiTicker) { clearInterval(aiTicker); aiTicker = null; }
}
function aiStartTimers() {
  aiStopTimers();
  aiFails = 0;
  aiTimer = setInterval(async () => {
    try {
      const j = await api.get('/notes/backlink-ai/jobs/latest');
      aiFails = 0;
      aiJob.value = j;
      if (!j) { aiStopTimers(); return; }
      if (j.state === 'running') nextTick(() => { if (aiLogsEl.value) aiLogsEl.value.scrollTop = aiLogsEl.value.scrollHeight; });
      else aiStopTimers();
    } catch { if (++aiFails >= 5) { aiStopTimers(); err.value = '进度查询连续失败，任务仍在后台运行，稍后重开本弹窗即可'; } }
  }, 1500);
  aiTicker = setInterval(() => { aiTick.value++; }, 1000);
}

async function aiAnalyze() {
  if (aiRunning.value) return;
  err.value = ''; msg.value = '';
  try {
    const j = await api.post('/notes/backlink-ai/jobs', { scope: aiScope.value, folder_id: aiFolder.value });
    aiJob.value = j;
    aiChecks.value = {}; aiRev.value = {}; aiMsgs.value = {};
    aiStartTimers();
  } catch (e) {
    err.value = String((e && e.message) || e || '发起分析失败');
  }
}
async function aiCancel() {
  try { await api.del('/notes/backlink-ai/jobs/latest'); } catch { /* 没在跑就算了 */ }
}

// 组内勾选（默认全选）：aiChecks 里没有的组视为「全选」，第一次取消勾选才落 Set
function aiPick(gi) {
  const g = aiGroups.value[gi] || [];
  const s = aiChecks.value[gi];
  return s || new Set(g.note_ids);
}
function aiToggle(gi, id) {
  const cur = new Set(aiPick(gi));
  cur.has(id) ? cur.delete(id) : cur.add(id);
  aiChecks.value = { ...aiChecks.value, [gi]: cur };
}
function aiGroupNotes(gi) {
  const list = (aiGroups.value[gi]?.notes || []).slice();
  return aiRev.value[gi] ? list.reverse() : list;   // 循环链按展示顺序串，⇅ 翻转
}
async function aiRunGroup(gi, kind) {
  const ids = aiGroupNotes(gi).filter((n) => aiPick(gi).has(n.id)).map((n) => n.id);
  if (ids.length < 2 || aiBusy.value === gi) return;
  aiBusy.value = gi;
  try {
    const r = await api.post(kind === 'mutual' ? '/notes/backlink-mutual' : '/notes/backlink-chain', { ids });
    aiMsgs.value = { ...aiMsgs.value, [gi]: kind === 'mutual'
      ? `✓ 互链完成：${r.updated} 篇新增 ${r.links_added} 条链接${r.updated < ids.length ? `（其余 ${ids.length - r.updated} 篇本来就链齐了）` : ''}`
      : `✓ 循环链完成：${r.updated} 篇各补 1 条「下一篇」链接${r.updated < ids.length ? `（其余 ${ids.length - r.updated} 篇已经链过）` : ''}` };
    emit('done');
    // 这组已执行完 → 默认取消勾选，避免顺手重复点（幂等反正也不会加重复链接）
    aiChecks.value = { ...aiChecks.value, [gi]: new Set() };
  } catch (e) {
    aiMsgs.value = { ...aiMsgs.value, [gi]: '✗ ' + String((e && e.message) || e || '执行失败') };
  } finally {
    aiBusy.value = -1;
  }
}

onMounted(async () => {
  // AI 连接首屏数据：meta + 文件夹下拉（默认选「IM连接」根——这个功能多半用在 IM 归档上）
  try { aiMeta.value = await api.get('/notes/backlink-ai/meta'); } catch { aiMeta.value = null; }
  try {
    const tree = await api.get('/notes/folders');
    const flat = [{ id: 0, label: '全库笔记', depth: 0 }];
    const walk = (nodes, depth) => {
      for (const n of nodes) {
        flat.push({ id: n.id, label: `${'　'.repeat(depth)}${n.name}（${n.note_count_total ?? n.note_count ?? 0} 篇）`, depth });
        walk(n.children || [], depth + 1);
      }
    };
    walk(tree, 0);
    aiFolderOptions.value = flat;
    const im = flat.find((f) => f.depth === 0 && f.label.startsWith('IM连接'));
    if (im) aiFolder.value = im.id;
  } catch { /* 下拉拿不到就用全库 */ }
  // 重开弹窗：接上还在跑的分析 / 上次的分析结果直接摆出来
  try {
    const j = await api.get('/notes/backlink-ai/jobs/latest');
    if (j) {
      aiJob.value = j;
      mode.value = 'ai';
      if (j.state === 'running') aiStartTimers();
    }
  } catch { /* 没有就算了 */ }
});
onUnmounted(aiStopTimers);
</script>

<style scoped>
.bl-list { overflow-y: auto; border: 1px solid var(--border, #e0e0e0); border-radius: 8px; min-height: 60px; max-height: 44vh; margin-bottom: 6px; }
.bl-row { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--border, #eee); cursor: pointer; }
.bl-row:last-child { border-bottom: none; }
.bl-row.on { background: var(--bg3, #f5f7fa); }
.bl-title { font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bl-meta { font-size: 12px; margin-left: auto; white-space: nowrap; }
.bl-mode { display: flex; align-items: center; gap: 4px; font-size: 13px; padding: 3px 10px; border: 1px solid var(--border, #e0e0e0); border-radius: 14px; cursor: pointer; }
.bl-mode.on { background: var(--bg3, #f5f7fa); border-color: var(--accent, #4a7dff); }
/* 循环链的顺序徽标：勾选行亮、未勾选压暗（还在列表里但不参与串链） */
.bl-badge { flex: none; min-width: 20px; height: 20px; line-height: 20px; text-align: center; font-size: 11.5px; border-radius: 10px; background: var(--accent, #4a7dff); color: #fff; padding: 0 4px; }
.bl-badge.off { background: var(--border, #d8d8d8); color: var(--muted, #999); }
/* AI 连接 */
.pills { display: flex; flex-wrap: wrap; gap: 6px; }
.pill { padding: 4px 12px; border: 1px solid var(--border, #e0e0e0); background: transparent; color: var(--text2, #666);
  border-radius: 999px; cursor: pointer; font-size: 12.5px; }
.pill.on { border-color: var(--accent, #4a7dff); color: var(--accent, #4a7dff); font-weight: 600; }
.ai-prog { border: 1px solid var(--border, #e0e0e0); border-radius: 8px; padding: 8px 10px; margin-bottom: 8px; }
.bar { height: 8px; border-radius: 999px; background: var(--border, #e0e0e0); overflow: hidden; margin: 6px 0; }
.fill { height: 100%; background: var(--accent, #4a7dff); border-radius: 999px; transition: width .6s ease; }
.ai-logs { max-height: 120px; overflow-y: auto; font-size: 12px; line-height: 1.7; color: var(--text2, #666);
  background: rgba(127,127,127,.06); border-radius: 6px; padding: 6px 8px; }
.logline { white-space: pre-wrap; word-break: break-all; }
.ai-groups { overflow-y: auto; max-height: 40vh; display: flex; flex-direction: column; gap: 8px; margin-bottom: 6px; }
.ai-group { border: 1px solid var(--border, #e0e0e0); border-radius: 8px; padding: 8px 10px; }
.ai-kw { flex: none; font-size: 12.5px; font-weight: 600; color: #fff; background: var(--accent, #4a7dff);
  border-radius: 10px; padding: 2px 10px; }
.ai-notes { border: 1px solid var(--border, #eee); border-radius: 6px; margin-top: 6px; max-height: 160px; overflow-y: auto; }
</style>
