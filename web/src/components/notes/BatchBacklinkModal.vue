<template>
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal" style="width:min(720px,94vw); max-height:88vh; display:flex; flex-direction:column">
      <h3>🔗 批量链接</h3>

      <!-- 三种批量操作（v1.10.24 互链；v1.10.28 循环链 / 取消链接） -->
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
        <template v-else>
          清掉勾选笔记 <code>## 关联笔记</code> 小节里的链接条目，小节清空后小节头也不留 ——
          是前两个操作的<b>逆操作</b>。
          <br><b>只清整行就是 <code>- [[标题]]</code> 的条目</b>：正文里你自己手写的
          <code>[[链接]]</code>、以及带说明文字的条目（如「- 相关：[[xx]]」）一律不动；
          没有可清条目的笔记一个字节都不动。
        </template>
      </div>

      <div class="row" style="gap:6px; flex-wrap:wrap; align-items:center">
        <input v-model="q" placeholder="关键词，如「装修」「Vite 笔记」" style="flex:1; min-width:220px"
               @keydown.enter.prevent="search" />
        <button class="small" :disabled="searching || !q.trim()" @click="search">{{ searching ? '搜索中…' : '搜索' }}</button>
      </div>

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
      <div v-else-if="searched && !searching" class="muted" style="margin:12px 0">
        没有匹配的笔记。换个关键词试试。
      </div>

      <div class="row" style="margin-top:auto; padding-top:12px; gap:8px; justify-content:flex-end">
        <button class="small" @click="$emit('close')">关闭</button>
        <button class="small primary" :disabled="running || checked.size < minNeed" @click="run">
          {{ running ? runDoing : runLabel }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { api } from '../../api';

const emit = defineEmits(['close', 'done']);

const MODES = [
  { key: 'mutual', label: '两两互链' },
  { key: 'chain', label: '循环链接' },
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
</style>
