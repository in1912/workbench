<template>
  <div class="split">
    <!-- ==================== 第一列：来源与范围 + 引导词（可折叠）+ 整理进度 ==================== -->
    <div>
      <div class="card" style="margin-bottom:14px">
        <h3>复盘来源与范围</h3>
        <div class="row" style="flex-wrap:wrap">
          <select v-model="folderId" class="grow" style="min-width:220px" title="选 IM 归档所在的文件夹（含全部子文件夹）">
            <option v-for="f in folderOptions" :key="f.id" :value="f.id">{{ f.label }}</option>
          </select>
        </div>
        <div class="pills" style="margin:10px 0">
          <button v-for="r in ranges" :key="r.days" :class="{ on: days === r.days }"
                  :title="'整理最近 ' + r.days + ' 天的聊天记录'" @click="days = r.days">{{ r.label }}</button>
        </div>
        <div class="row">
          <button class="primary" :disabled="!folderId || running" @click="run">
            {{ running ? '整理中…（可离开本页）' : '🤖 生成复盘' }}
          </button>
          <button v-if="running" class="small" @click="cancel">取消整理</button>
          <span v-if="res && !running" class="muted small">
            扫描 {{ res.notes_scanned }} 篇 · 快筛命中 {{ res.notes_matched }} 篇 · {{ res.conversations.length }} 个会话 · {{ res.lines_used }} 条消息
            <span v-if="res.truncated" class="badge warn" title="聊天记录太多，已按会话保留最新的部分">已截断</span>
          </span>
        </div>
        <div v-if="meta && !meta.has_ai" class="err-hint">AI 尚未配置：请先到「设置 → AI 模型」填写模型名称 / API 地址 / API Key。</div>
        <div v-else class="muted" style="margin-top:8px">
          只读取标题时间在范围内的归档笔记（范围外的整篇跳过、不占读取量）；改过标题的归档笔记认不出时间戳，也会被跳过。
          AI 用的是工作台总配置的模型{{ res && res.model ? '（' + res.model + '）' : '' }}，一轮可能要几分钟，任务在服务器后台跑，离开本页不中断。
        </div>
      </div>

      <!-- 数据脱敏（v1.13.0）：默认折叠。本页只放**一个开关 + 本轮对照显示**，
           规则配置（识别类型 / 固定关键词 / 数值是否脱敏）在「效率工具 → AI脱敏」里。 -->
      <div class="card" style="margin-bottom:14px">
        <h3 class="foldhead">
          <span class="ft" @click="maskOpen = !maskOpen">
            <span class="caret">{{ maskOpen ? '▾' : '▸' }}</span>数据脱敏
          </span>
          <span class="muted" style="font-weight:400;font-size:12.5px">{{ maskOn ? '本次开启' : '本次关闭' }}</span>
        </h3>
        <label class="row" style="gap:8px;cursor:pointer">
          <input type="checkbox" v-model="maskOn" style="width:auto" />
          <span>本次喂给 AI 前脱敏<span class="muted">（把聊天里的公司 / 人名 / 部门 / 群名 / 账号等换成本轮随机代码，AI 返回后再自动拼回原词）</span></span>
        </label>
        <div class="muted small" style="margin-top:6px">规则在「效率工具 → AI脱敏」里配置；这里只决定本次用不用。</div>
        <div v-show="maskOpen">
          <template v-if="job && job.mask && job.mask.mapping.length">
            <label class="fl">本轮对照表<span class="muted" style="font-weight:400">{{ job.mask.count }} 项（AI 只看到右列的代码）</span></label>
            <div class="maptable">
              <div v-for="(m, i) in job.mask.mapping" :key="i" class="maprow">
                <span class="badge blue">{{ typeLabel(m.type) }}</span>
                <span class="term">{{ m.term }}</span>
                <span class="arrow">→</span>
                <code>{{ m.code }}</code>
              </div>
            </div>
          </template>
          <div v-else-if="job && running" class="muted small" style="margin-top:8px">
            脱敏在「组装语料」之后、调用 AI 之前进行，对照表稍后出现在这里…
          </div>
          <div v-else class="muted small" style="margin-top:8px">
            本轮还没有脱敏记录。勾上开关再点「生成复盘」，这里会列出「哪个名词 → 哪个随机代码」。
          </div>
        </div>
      </div>

      <!-- 引导词：默认收起，点标题展开；复制按钮收起时也在（不用展开就能复制当前引导词） -->
      <div class="card" style="margin-bottom:14px">
        <h3 class="foldhead">
          <span class="ft" :title="promptOpen ? '收起' : '展开查看 / 编辑引导词'" @click="promptOpen = !promptOpen">
            <span class="caret">{{ promptOpen ? '▾' : '▸' }}</span>引导词（可编辑）
          </span>
          <span class="row" style="gap:6px; flex:0 0 auto">
            <button class="small" title="把当前引导词复制到剪贴板（不展开也能复制）" @click="copyPrompt">📋 复制</button>
            <button v-if="promptOpen" class="small" title="放弃你的修改，恢复系统默认引导词" @click="resetPrompt">恢复默认</button>
          </span>
        </h3>
        <div v-show="promptOpen">
          <textarea ref="promptEl" v-model="prompt" rows="12" style="width:100%; resize:vertical"
                    placeholder="告诉 AI 怎么整理这份复盘（输出的 JSON 结构保留 summary / highlights / todos 三个字段即可被右侧界面识别）"></textarea>
          <div class="muted" style="margin-top:6px">改完立即生效（只存在你自己的浏览器里），不影响其他成员。</div>
        </div>
      </div>

      <!-- 整理进度（v1.11.5 从右列挪到左列下方）：有任务才出现 -->
      <div v-if="job" class="card">
        <h3>整理进度
          <span class="muted" style="font-weight:400;font-size:12.5px">{{ jobLabel }}</span>
        </h3>
        <div class="bar"><div class="fill" :style="{ width: job.progress + '%' }"></div></div>
        <div class="row" style="margin-top:6px">
          <span class="muted small">
            {{ job.progress }}% · 已进行 {{ fmtDur(elapsedS) }}
            <template v-if="running && job.stage === 'ai'"> · AI 已等 {{ tick && aiWaitS }} 秒（上游越慢越久，可先去干别的）</template>
          </span>
          <button v-if="running" class="small" style="margin-left:auto" @click="cancel">取消整理</button>
        </div>
        <div class="muted small" style="margin-top:4px">任务在服务器后台运行，离开本页不中断，回来接着看。（任务保存在内存里，服务重启会丢失进行中的任务）</div>
        <div ref="logsEl" class="logs">
          <div v-for="(l, i) in job.logs" :key="i" class="logline">[{{ fmtClock(l.t) }}] {{ l.msg }}</div>
        </div>
        <div v-if="job.state === 'error'" class="err-hint" style="margin-top:8px">失败：{{ job.error }}</div>
      </div>
    </div>

    <!-- ==================== 第二列：复盘结果（框架常显，生成后逐段填进来） ==================== -->
    <div>
      <div class="card">
        <h3>复盘结果
          <span v-if="!res" class="muted" style="font-weight:400; font-size:12.5px">（待生成）</span>
        </h3>
        <div v-if="!res" class="muted small" style="margin:-4px 0 2px">
          框架先摆好，生成后结果直接填进下面三段。选好来源与范围点「🤖 生成复盘」即可（日报看最近 1 天，周报 / 月报看 7 / 30 天）。
        </div>

        <label class="fl">沟通概要</label>
        <p v-if="res" class="sum">{{ res.summary || '（AI 没有给出概要）' }}</p>
        <p v-else class="sum muted">（待生成——AI 整理的整体沟通概要会放在这段）</p>

        <label class="fl">沟通重点
          <span class="muted" style="font-weight:400">{{ res ? res.highlights.length + ' 条' : '待生成' }}</span>
        </label>
        <ol v-if="res && res.highlights.length" class="hl">
          <li v-for="(h, i) in res.highlights" :key="i">{{ h }}</li>
        </ol>
        <div v-else class="muted">{{ res ? '（无）' : '（待生成——沟通里的关键事会逐条列在这里）' }}</div>

        <label class="fl">待办事项参考
          <span class="muted" style="font-weight:400">{{ res ? res.todos.length + ' 条' : '待生成' }}</span>
          <template v-if="res && res.todos.length">
            · <a href="javascript:void(0)" @click.prevent="pickAll">{{ checked.size === res.todos.length ? '全不选' : '全选' }}</a>
          </template>
        </label>
        <div v-if="res && !res.todos.length" class="muted">（聊天里没有明确要跟进的事项）</div>
        <div v-else-if="!res" class="muted">（待生成——聊天里可跟进的事项会列在这里，勾选后一键加入「行动」）</div>
        <template v-if="res">
          <div v-for="(t, i) in res.todos" :key="i" class="todo" :class="{ added: added.has(i) }">
            <label class="trow">
              <input type="checkbox" :checked="checked.has(i)" :disabled="added.has(i) || busyAdd"
                     style="width:auto; flex:0 0 auto" @change="toggle(i)" />
              <span class="t">{{ t.title }}</span>
              <span v-if="added.has(i)" class="badge green">✓ 已加入</span>
            </label>
            <div v-if="t.note" class="muted small note">{{ t.note }}</div>
          </div>
          <div v-if="res.todos.length" class="row" style="margin-top:10px">
            <button class="primary small" :disabled="!checked.size || busyAdd" @click="addTodos">
              {{ busyAdd ? '加入中…' : `加入行动（${checked.size}）` }}
            </button>
            <span class="muted small">截止 {{ duePreview }}（{{ dueDesc }}）· 建为「日常待办」，到「行动」页可再挂目标 / 改日期</span>
          </div>

          <div class="muted small" style="margin-top:12px; border-top:1px solid var(--border); padding-top:8px">
            生成于 {{ res.generated_at }}{{ res.usage && res.usage.total_tokens != null ? ` · ${res.usage.total_tokens} tokens` : '' }}
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
// AI复盘IM（v1.10.29）——lifeOS「AI复盘IM」页签：选 IM 归档文件夹 + 天数范围 → 后台任务整理 →
// 结果三段（概要 / 重点 / 待办）+ 待办一键加入「行动」。任务模型 v1.10.30 起：POST 立即回任务号、
// 1.5s 轮询快照、离开本页不中断。
//
// v1.11.5 页面重排（用户需求）：① 两列重分布——第一列 = 来源与范围 + 引导词（折叠）+ 整理进度，
// 第二列 = 复盘结果；② 引导词默认收起、点标题展开，「📋 复制」不展开也能复制当前引导词
// （clipboard API 失败时自动展开全选走 execCommand 兜底——http 局域网非安全上下文没有 clipboard）；
// ③ 复盘结果框架常显（概要 / 重点 / 待办三段占位摆好，不再「还没有生成」整块盖住）；
// ④ 整页全宽自适应（wbMainFull 同领域/关系/知识地图页）+ 两列 minmax(380px,1fr) 均分屏宽。
import { ref, computed, onMounted, onUnmounted, watch, nextTick, inject } from 'vue';
import { api } from '../../api';

const emit = defineEmits(['toast']);
const meta = ref(null);
const ranges = ref([]);
const folders = ref([]);
const folderId = ref(null);
const days = ref(1);
const prompt = ref('');
const promptOpen = ref(false);   // v1.11.5：引导词默认收起，点标题展开
const promptEl = ref(null);
const maskOn = ref(false);       // v1.13.0：本次喂给 AI 前是否脱敏（默认关，记在本地）
const maskOpen = ref(false);     // 脱敏卡默认折叠
const typeLabel = (k) => ({ org: '公司', person: '人名', dept: '部门', group: '群名', acct: '账号', pwd: '密码', apikey: 'KEY', email: '邮箱', phone: '手机', idcard: '身份证', custom: '自定义', numbers: '数值' }[k] || k);
const res = ref(null);
const busyAdd = ref(false);
const checked = ref(new Set());
const added = ref(new Set());
const job = ref(null);       // 后台任务快照（v1.10.30：生成在服务端跑，这里只是展示）
const tick = ref(0);         // 每秒走字（已进行 / AI 已等），驱动 computed 重算
const logsEl = ref(null);
const LS_KEY = 'lifeImReview.prompt';
let pollTimer = null, tickTimer = null, pollFails = 0;

const running = computed(() => job.value?.state === 'running');
const elapsedS = computed(() => {
  tick.value;   // 依赖 tick，每秒重算
  if (!job.value) return 0;
  const end = job.value.finished_at || Date.now();
  return Math.max(0, Math.round((end - job.value.started_at) / 1000));
});
const aiWaitS = computed(() => {
  tick.value;
  const t0 = job.value?.ai_started_at;
  return t0 ? Math.max(0, Math.round((Date.now() - t0) / 1000)) : 0;
});
const jobLabel = computed(() => {
  const map = { done: '已完成', error: '失败', cancelled: '已取消', running: '' };
  return `${job.value?.stage_label || ''}${map[job.value?.state] || ''}`.trim();
});

// 文件夹下拉：整棵树摊平，缩进表示层级，标出该子树里 IM 归档笔记的篇数
const folderOptions = computed(() => {
  const out = [];
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      out.push({ id: n.id, label: `${'　'.repeat(depth)}${n.name}（${n.im_total} 篇）`, total: n.im_total });
      walk(n.children || [], depth + 1);
    }
  };
  walk(folders.value, 0);
  return out;
});

// 截止日预览：与后端同一口径（今天 + days；日=次日、周=+7、双周=+14、月=+30）
const duePreview = computed(() => {
  const d = new Date();
  d.setDate(d.getDate() + Number(days.value));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
});
const dueDesc = computed(() => ({ 1: '次日', 7: '次日后的 7 天窗口', 14: '次日后的 14 天窗口', 30: '次日后的 30 天窗口' }[days.value] || ''));

const fmtDur = (s) => (s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`);
const fmtClock = (ms) => {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

function toggle(i) {
  const s = new Set(checked.value);
  s.has(i) ? s.delete(i) : s.add(i);
  checked.value = s;
}
function pickAll() {
  const list = res.value ? res.value.todos : [];
  checked.value = checked.value.size === list.length ? new Set() : new Set(list.map((_, i) => i));
}

// v1.11.5：快捷复制引导词（收起时也能复制）。非安全上下文（http 局域网直连）没有 clipboard API——
// 自动展开并全选，让 execCommand / Ctrl+C 兜底（同知识地图「获得提示词」的做法）
async function copyPrompt() {
  const t = prompt.value || '';
  if (!t) { emit('toast', '引导词还是空的', 'err'); return; }
  try {
    await navigator.clipboard.writeText(t);
    emit('toast', '引导词已复制');
  } catch {
    promptOpen.value = true;
    await nextTick();
    const el = promptEl.value;
    if (el) { el.focus(); el.select(); }
    const ok = document.execCommand('copy');
    emit('toast', ok ? '引导词已复制' : '已全选引导词，按 Ctrl+C 复制', ok ? '' : 'err');
  }
}

// ---------- 后台任务（v1.10.30）：POST 立即回任务号，1.5s 轮询拿快照 ----------
function stopTimers() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}
function startTimers() {
  stopTimers();
  pollFails = 0;
  pollTimer = setInterval(async () => {
    try {
      const j = await api.get('/life/im-review/jobs/latest');
      pollFails = 0;
      job.value = j;
      if (j && j.state === 'running') scrollLogs();
      if (!j) { stopTimers(); return; }
      if (j.state === 'done') {
        stopTimers();
        applyResult(j.result);
        emit('toast', `整理完成：${j.result.conversations.length} 个会话 · ${j.result.lines_used} 条消息`);
      } else if (j.state === 'error') {
        stopTimers();
        emit('toast', j.error || '整理失败', 'err');
      } else if (j.state === 'cancelled') {
        stopTimers();
      }
    } catch { if (++pollFails >= 5) { stopTimers(); emit('toast', '进度查询连续失败，任务仍在后台运行，稍后回来刷新即可', 'err'); } }
  }, 1500);
  tickTimer = setInterval(() => { tick.value++; }, 1000);
}
function scrollLogs() { nextTick(() => { if (logsEl.value) logsEl.value.scrollTop = logsEl.value.scrollHeight; }); }

async function run() {
  if (!folderId.value || running.value) return;
  try {
    const j = await api.post('/life/im-review/jobs', {
      folder_id: folderId.value, days: days.value, prompt: prompt.value,
      desensitize: maskOn.value,   // v1.13.0：本次是否先脱敏再喂 AI
    });
    job.value = j;
    if (j.resumed) emit('toast', '上一次整理还在进行，已接上它的进度');
    startTimers();
  } catch (e) {
    emit('toast', e.message, 'err');
  }
}
async function cancel() {
  try {
    const r = await api.del('/life/im-review/jobs/latest');
    if (r.ok) { emit('toast', '已取消整理'); }
    else emit('toast', '没有在进行的任务', 'err');
  } catch (e) { emit('toast', e.message, 'err'); }
}

function applyResult(r) {
  if (!r) return;
  res.value = { ...r, generated_at: r.generated_at_ms ? new Date(r.generated_at_ms).toLocaleString('zh-CN') : '' };
  checked.value = new Set();
  added.value = new Set();
}

async function addTodos() {
  const list = res.value ? res.value.todos : [];
  const items = [...checked.value].sort((a, b) => a - b).map((i) => list[i]).filter(Boolean);
  if (!items.length || busyAdd.value) return;
  busyAdd.value = true;
  try {
    const r = await api.post('/life/im-review/todos', { days: days.value, items });
    added.value = new Set([...added.value, ...items.map((t) => list.indexOf(t))]);
    checked.value = new Set();
    emit('toast', `已加入 ${r.created} 条行动 · 截止 ${r.due_date}`);
  } catch (e) {
    emit('toast', e.message, 'err');
  } finally {
    busyAdd.value = false;
  }
}

function resetPrompt() {
  localStorage.removeItem(LS_KEY);
  if (meta.value) prompt.value = meta.value.default_prompt;
  emit('toast', '已恢复默认引导词');
}

// 用户改过的引导词记在本地；「恢复默认」清掉
watch(prompt, (v) => { if (v) localStorage.setItem(LS_KEY, v); });
// 脱敏开关也记在本地（多数人一旦选了就长期想用同一个选择）
const LS_MASK = 'lifeImReview.mask';
watch(maskOn, (v) => localStorage.setItem(LS_MASK, v ? '1' : '0'));
watch(() => job.value && job.value.logs.length, scrollLogs);

// 本页全页自适应（同领域/关系/知识地图页）：挂载打开不限宽开关，卸载（切页签/离开 /life）自动关
const mainFull = inject('wbMainFull', null);

onMounted(async () => {
  if (mainFull) mainFull.value = true;
  maskOn.value = localStorage.getItem(LS_MASK) === '1';
  try {
    meta.value = await api.get('/life/im-review/meta');
    ranges.value = meta.value.ranges || [];
    prompt.value = localStorage.getItem(LS_KEY) || meta.value.default_prompt || '';
  } catch (e) { emit('toast', e.message, 'err'); }
  try {
    folders.value = await api.get('/life/im-review/folders');
    const first = folderOptions.value.find((f) => f.total > 0);
    if (first) folderId.value = first.id;
    else if (folderOptions.value.length) folderId.value = folderOptions.value[0].id;
  } catch (e) { emit('toast', e.message, 'err'); }
  // 重进页面：接上还在跑的任务；上次跑完的直接把结果摆出来
  try {
    const j = await api.get('/life/im-review/jobs/latest');
    if (j) {
      job.value = j;
      if (j.state === 'running') startTimers();
      else if (j.state === 'done') applyResult(j.result);
    }
  } catch { /* 拿不到就算了，不影响选源 */ }
});
onUnmounted(() => {
  if (mainFull) mainFull.value = false;
  stopTimers();
});
</script>

<style scoped>
/* v1.11.5：两列均分屏宽（整页全宽由 wbMainFull 解除 .main 的 1200px 封顶）；
   min 380 = 每个矩形框比旧版（320）加宽一档，1fr 随屏幕自适应拉开 */
.split { display: grid; grid-template-columns: minmax(380px, 1fr) minmax(380px, 1fr); gap: 16px; align-items: start; }
@media (max-width: 1080px) { .split { grid-template-columns: 1fr; } }
.foldhead { cursor: pointer; }
.foldhead .ft { display: inline-flex; align-items: center; gap: 2px; min-width: 0; user-select: none; }
.foldhead .ft:hover { color: var(--accent, #4a7dff); }
.caret { display: inline-block; width: 14px; flex: 0 0 auto; color: var(--text2); font-size: 12px; }
.fl { display: block; font-size: 12.5px; color: var(--text2); margin: 10px 0 4px; }
.pills { display: flex; flex-wrap: wrap; gap: 6px; }
.pills button { padding: 5px 12px; border: 1px solid var(--border); background: transparent; color: var(--text2);
  border-radius: 999px; cursor: pointer; font-size: 13px; }
.pills button.on { border-color: var(--accent, #4a7dff); color: var(--accent, #4a7dff); font-weight: 600; }
.sum { white-space: pre-wrap; line-height: 1.7; margin: 0; }
.hl { margin: 0; padding-left: 20px; line-height: 1.8; }
.todo { border-top: 1px solid var(--border); padding: 8px 0; }
.todo:first-of-type { border-top: none; }
.todo.added { opacity: 0.65; }
.trow { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
.trow .t { flex: 1; min-width: 0; line-height: 1.5; }
.note { margin: 3px 0 0 24px; }
.err-hint { color: #d93025; font-size: 13px; margin-top: 8px; }
/* v1.13.0 脱敏对照表：等宽代码列，长表内滚 */
.maptable { margin-top: 6px; max-height: 240px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px; }
.maprow { display: flex; align-items: center; gap: 8px; padding: 4px 10px; font-size: 12.5px; border-bottom: 1px solid var(--border); }
.maprow:last-child { border-bottom: none; }
.maprow .term { flex: 1; min-width: 0; word-break: break-all; }
.maprow .arrow { color: var(--text3); }
.maprow code { background: var(--bg3); border-radius: 4px; padding: 1px 6px; font-size: 12px; white-space: nowrap; }
.badge.warn { background: #b26a00; color: #fff; }
.bar { height: 10px; border-radius: 999px; background: var(--border); overflow: hidden; }
.bar .fill { height: 100%; background: var(--accent, #4a7dff); border-radius: 999px; transition: width .6s ease; }
.logs { margin-top: 8px; max-height: 200px; overflow-y: auto; border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 10px; background: rgba(127,127,127,.06); font-size: 12px; line-height: 1.7; }
.logline { white-space: pre-wrap; word-break: break-all; }
</style>
