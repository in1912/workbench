<template>
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal" style="width:min(720px,94vw); max-height:88vh; display:flex; flex-direction:column">
      <h3>🔗 批量反链</h3>
      <div class="muted" style="font-size:12.5px; margin-bottom:10px">
        按关键词搜出相关的一批笔记（匹配<b>标题或正文</b>），勾选后在每篇末尾的
        <code>## 关联笔记</code> 小节里<b>两两互加</b> <code>[[标题]]</code> 双链 ——
        让这一批笔记互相引用，而不是只指向同一篇枢纽。
        <br>重复执行<b>只补缺</b>：已经链过（包括你自己手写的同名链接）不会重复加；
        没有新链接要补的笔记一个字节都不动。
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
      </div>

      <div v-if="rows.length" class="bl-list">
        <label v-for="r in rows" :key="r.id" class="bl-row" :class="{ on: checked.has(r.id) }">
          <input type="checkbox" :checked="checked.has(r.id)" style="width:auto" @change="toggle(r.id)" />
          <span class="bl-title">{{ r.title }}</span>
          <span class="muted bl-meta">{{ r.folder_path || r.folder || '（未分组）' }} · {{ r.word_count || 0 }} 字</span>
        </label>
      </div>
      <div v-else-if="searched && !searching" class="muted" style="margin:12px 0">
        没有匹配的笔记。换个关键词试试。
      </div>

      <div class="row" style="margin-top:auto; padding-top:12px; gap:8px; justify-content:flex-end">
        <button class="small" @click="$emit('close')">关闭</button>
        <button class="small primary" :disabled="running || checked.size < 2" @click="run">
          {{ running ? '互链中…' : `添加互链（已选 ${checked.size} 篇）` }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { api } from '../../api';

const emit = defineEmits(['close', 'done']);

const q = ref('');
const rows = ref([]);
const checked = ref(new Set());
const searching = ref(false);
const searched = ref(false);
const running = ref(false);
const err = ref('');
const msg = ref('');

const allChecked = computed(() => rows.value.length > 0 && rows.value.every((r) => checked.value.has(r.id)));

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
  if (checked.value.size < 2 || running.value) return;
  err.value = ''; msg.value = '';
  running.value = true;
  try {
    const r = await api.post('/notes/backlink-mutual', { ids: [...checked.value] });
    msg.value = `互链完成：${r.updated} 篇笔记新增 ${r.links_added} 条链接`
      + (r.updated < checked.value.size ? `（其余 ${checked.value.size - r.updated} 篇本来就链齐了，没动）` : '');
    emit('done');
  } catch (e) {
    err.value = String((e && e.message) || e || '互链失败');
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
</style>
