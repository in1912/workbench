<template>
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal" style="width:min(640px,94vw)">
      <h3>分享管理</h3>
      <div class="muted" style="font-size:12.5px; margin-bottom:14px">
        {{ note.title || '未命名' }} · 共 <b>{{ stats.link_count }}</b> 条分享链接 · 累计访问 <b>{{ stats.view_total }}</b> 次
      </div>

      <div v-if="err" class="msg err">{{ err }}</div>
      <div v-if="!items.length" class="empty">还没有分享链接</div>

      <div v-for="s in items" :key="s.id" class="card" style="background:var(--bg3); border:none; margin-bottom:10px">
        <div class="row" style="gap:8px; flex-wrap:wrap; align-items:center">
          <span class="tag" :class="s.disabled ? '' : 'ok'" style="font-size:11.5px">{{ stateText(s) }}</span>
          <span class="muted" style="font-size:12px">{{ s.mode === 'snapshot' ? '快照' : '活链接' }}</span>
          <span class="muted" style="font-size:12px">{{ s.with_audio ? '· 含录音' : '' }}</span>
          <span class="muted" style="font-size:12px">· 有效期 {{ s.expires_at ? s.expires_at.slice(0, 10) : '不限' }}</span>
          <span class="muted" style="font-size:12px">· 访问 {{ s.views }} 次</span>
          <span class="muted" style="font-size:12px">· 最后 {{ s.last_view_at ? s.last_view_at.slice(5, 16) : '—' }}</span>
        </div>
        <div class="row" style="gap:6px; margin-top:8px; flex-wrap:wrap">
          <button class="small" @click="copy(s)">{{ copiedId === s.id ? '已复制 ✓' : '复制链接' }}</button>
          <select class="small" value="" @change="setExp(s, $event)" style="width:auto; padding:3px 6px">
            <option value="" disabled>改有效期…</option>
            <option value="7">改为 7 天</option>
            <option value="30">改为 30 天</option>
            <option value="0">改为不限</option>
          </select>
          <button class="small" @click="toggle(s)">{{ s.disabled ? '开启访问' : '关闭访问' }}</button>
          <button class="small danger" @click="remove(s)">删除</button>
        </div>
      </div>

      <div class="row" style="justify-content:flex-end">
        <button @click="$emit('close')">关闭</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api';
import { loadExternalBase, shareLink, copyText } from '../utils/noteShare';

const props = defineProps({ note: { type: Object, required: true } });
defineEmits(['close']);

const items = ref([]);
const stats = ref({ link_count: 0, view_total: 0 });
const err = ref('');
const copiedId = ref(null);
const external = ref('');

function localNow() { return new Date().toLocaleString('sv').slice(0, 19); }
function stateText(s) {
  if (s.disabled) return '已关闭';
  if (s.expires_at && s.expires_at <= localNow()) return '已过期';
  return '有效';
}
async function load() {
  try {
    const d = await api.get(`/notes/shares/note/${props.note.id}`);
    items.value = d.items || [];
    stats.value = { link_count: d.link_count || 0, view_total: d.view_total || 0 };
  } catch (e) { err.value = e.message; }
}
async function copy(s) {
  const ok = await copyText(shareLink(external.value, s.token, s.code));
  if (!ok) return alert('复制失败，请手动复制');
  copiedId.value = s.id;
  setTimeout(() => { if (copiedId.value === s.id) copiedId.value = null; }, 2000);
}
async function setExp(s, ev) {
  const days = ev.target.value;
  ev.target.value = ''; // 复位为占位项（后端不存原始天数，无法回显）
  try {
    await api.put(`/notes/shares/${s.id}`, { expires_days: Number(days) });
    await load();
  } catch (e) { err.value = e.message; }
}
async function toggle(s) {
  try {
    await api.put(`/notes/shares/${s.id}`, { disabled: s.disabled ? 0 : 1 });
    await load();
  } catch (e) { err.value = e.message; }
}
async function remove(s) {
  if (!confirm('删除这条分享链接？该链接将立即失效。')) return;
  try {
    await api.del(`/notes/shares/${s.id}`);
    await load();
  } catch (e) { err.value = e.message; }
}

onMounted(async () => {
  external.value = await loadExternalBase();
  await load();
});
</script>
