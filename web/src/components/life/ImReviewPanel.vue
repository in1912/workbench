<template>
  <div class="split">
    <!-- 左：来源/范围/引导词 -->
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
          <button class="primary" :disabled="!folderId || busy" @click="run">
            {{ busy ? 'AI 整理中…（可能要几十秒）' : '🤖 生成复盘' }}
          </button>
          <span v-if="res" class="muted small">
            扫描 {{ res.notes_scanned }} 篇 · 快筛命中 {{ res.notes_matched }} 篇 · {{ res.conversations.length }} 个会话 · {{ res.lines_used }} 条消息
            <span v-if="res.truncated" class="badge warn" title="聊天记录太多，已按会话保留最新的部分">已截断</span>
          </span>
        </div>
        <div v-if="meta && !meta.has_ai" class="err-hint">AI 尚未配置：请先到「设置 → AI 模型」填写模型名称 / API 地址 / API Key。</div>
        <div v-else class="muted" style="margin-top:8px">
          只读取标题时间在范围内的归档笔记（范围外的整篇跳过、不占读取量）；改过标题的归档笔记认不出时间戳，也会被跳过。
          AI 用的是工作台总配置的模型{{ res && res.model ? '（' + res.model + '）' : '' }}。
        </div>
      </div>

      <div class="card">
        <h3>引导词（可编辑）
          <button class="small" title="放弃你的修改，恢复系统默认引导词" @click="resetPrompt">恢复默认</button>
        </h3>
        <textarea v-model="prompt" rows="12" style="width:100%; resize:vertical"
                  placeholder="告诉 AI 怎么整理这份复盘（输出的 JSON 结构保留 summary / highlights / todos 三个字段即可被下方界面识别）"></textarea>
        <div class="muted" style="margin-top:6px">改完立即生效（只存在你自己的浏览器里），不影响其他成员。</div>
      </div>
    </div>

    <!-- 右：结果 -->
    <div class="card">
      <h3>复盘结果</h3>
      <div v-if="!res" class="empty">
        还没有生成
        <div class="muted" style="margin-top:6px">选好文件夹与范围，点「生成复盘」。日报看最近 1 天，周报 / 月报分别看 7 / 30 天。</div>
      </div>
      <template v-else>
        <label class="fl">沟通概要</label>
        <p class="sum">{{ res.summary || '（AI 没有给出概要）' }}</p>

        <label class="fl">沟通重点 <span class="muted" style="font-weight:400">{{ res.highlights.length }} 条</span></label>
        <ol v-if="res.highlights.length" class="hl">
          <li v-for="(h, i) in res.highlights" :key="i">{{ h }}</li>
        </ol>
        <div v-else class="muted">（无）</div>

        <label class="fl">待办事项参考
          <span class="muted" style="font-weight:400">{{ res.todos.length }} 条</span>
          <template v-if="res.todos.length">
            · <a href="javascript:void(0)" @click.prevent="pickAll">{{ checked.size === res.todos.length ? '全不选' : '全选' }}</a>
          </template>
        </label>
        <div v-if="!res.todos.length" class="muted">（聊天里没有明确要跟进的事项）</div>
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
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { api } from '../../api';

const emit = defineEmits(['toast']);
const meta = ref(null);
const ranges = ref([]);
const folders = ref([]);
const folderId = ref(null);
const days = ref(1);
const prompt = ref('');
const res = ref(null);
const busy = ref(false);
const busyAdd = ref(false);
const checked = ref(new Set());
const added = ref(new Set());
const LS_KEY = 'lifeImReview.prompt';

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

function toggle(i) {
  const s = new Set(checked.value);
  s.has(i) ? s.delete(i) : s.add(i);
  checked.value = s;
}
function pickAll() {
  const list = res.value ? res.value.todos : [];
  checked.value = checked.value.size === list.length ? new Set() : new Set(list.map((_, i) => i));
}

async function run() {
  if (!folderId.value || busy.value) return;
  busy.value = true;
  try {
    const r = await api.post('/life/im-review/preview', {
      folder_id: folderId.value, days: days.value, prompt: prompt.value,
    });
    r.generated_at = new Date().toLocaleString('zh-CN');
    res.value = r;
    checked.value = new Set();
    added.value = new Set();
    emit('toast', `整理完成：${r.conversations.length} 个会话 · ${r.lines_used} 条消息`);
  } catch (e) {
    emit('toast', e.message, 'err');
  } finally {
    busy.value = false;
  }
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

onMounted(async () => {
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
});
</script>

<style scoped>
.split { display: grid; grid-template-columns: minmax(320px, 1fr) minmax(320px, 1fr); gap: 14px; align-items: start; }
@media (max-width: 900px) { .split { grid-template-columns: 1fr; } }
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
.badge.warn { background: #b26a00; color: #fff; }
</style>
