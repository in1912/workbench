<template>
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal" style="width:min(860px,94vw); max-height:86vh; overflow-y:auto">
      <h3>文件夹管理</h3>
      <div class="muted" style="font-size:12.5px; margin-bottom:12px">
        文件夹可增可删可改名、可以嵌套。「未分类」不可删除。
        给某个文件夹生成令牌后，外部 AI / 系统就能往这个文件夹写入笔记（只写，不可读）。
      </div>
      <div v-if="err" class="msg err">{{ err }}</div>

      <div class="row" style="gap:6px; margin-bottom:12px">
        <input v-model="newName" placeholder="新文件夹名称" style="flex:1" @keyup.enter="add(null)">
        <button class="primary" @click="add(null)">新增顶层</button>
      </div>

      <div v-for="f in folders" :key="f.id" class="card" style="background:var(--bg3); border:none; margin-bottom:8px">
        <div class="row" style="gap:6px; flex-wrap:wrap; align-items:center">
          <span class="muted" style="font-size:12px; min-width:0">{{ '　'.repeat(f.depth) }}</span>
          <input :value="f.name" :disabled="f.name === 'general'" style="width:150px" @change="rename(f, $event.target.value)">
          <input :value="f.sort_order" type="number" style="width:70px" title="排序（小的在前）" @change="sort(f, $event.target.value)">
          <select :value="f.parent_id ?? ''" style="width:150px" title="上级文件夹" @change="move(f, $event.target.value)">
            <option value="">（顶层）</option>
            <option v-for="p in parentOptions(f)" :key="p.id" :value="p.id">{{ '　'.repeat(p.depth) }}{{ p.name }}</option>
          </select>
          <span class="muted" style="font-size:12px">{{ f.note_count }} 篇</span>
          <span v-if="f.intake_token" class="tag ok" style="font-size:11px">已开写入令牌</span>
          <div class="row" style="margin-left:auto; gap:6px">
            <button class="small" @click="newName = ''; add(f.id)">＋ 子文件夹</button>
            <button class="small" @click="token(f, f.intake_token ? 'clear' : 'gen')">
              {{ f.intake_token ? '清除令牌' : '生成写入令牌' }}
            </button>
            <button class="small danger" :disabled="f.name === 'general'" @click="del(f)">删除</button>
          </div>
        </div>
        <div v-if="f.intake_token" class="row" style="gap:6px; margin-top:8px; align-items:center">
          <code style="flex:1; font-size:11px; word-break:break-all">{{ link(f.intake_token) }}</code>
          <button class="small" @click="copy(f.intake_token)">复制</button>
        </div>
      </div>

      <div class="row" style="justify-content:flex-end"><button @click="$emit('close')">关闭</button></div>
    </div>
  </div>
</template>

<script setup>
// 文件夹管理（v1.9.41）：把老版「分类管理」弹窗整体搬过来，端点从 /notes/categories 换成 /notes/folders，
// 于是有了多级树（老分类只能一层）。令牌生成/清除、复制写入地址的交互一字未改。
import { ref } from 'vue';
import { api } from '../../api';
import { intakeLink, copyText } from '../../utils/noteShare';

const props = defineProps({
  folders: { type: Array, default: () => [] },   // 扁平列表，带 depth / parent_id / note_count / intake_token
  external: { type: String, default: '' },
});
const emit = defineEmits(['close', 'changed']);

const newName = ref('');
const err = ref('');

const link = (t) => intakeLink(props.external, t);

async function run(fn) {
  err.value = '';
  try { await fn(); emit('changed'); }
  catch (e) { err.value = e.message || '操作失败'; emit('changed'); }
}

async function add(parentId) {
  const name = newName.value.trim();
  if (!name) { err.value = '请先填名称'; return; }
  await run(async () => { await api.post('/notes/folders', { name, parent_id: parentId }); newName.value = ''; });
}
const rename = (f, name) => run(async () => { await api.put(`/notes/folders/${f.id}`, { name: String(name).trim() }); });
const sort = (f, order) => run(async () => { await api.put(`/notes/folders/${f.id}`, { sort_order: Number(order) || 0 }); });
const move = (f, pid) => run(async () => { await api.put(`/notes/folders/${f.id}`, { parent_id: pid === '' ? null : Number(pid) }); });

async function token(f, action) {
  if (action === 'clear' && !confirm('清除令牌后，之前发出的写入地址立即失效，外部系统无法再写入。继续？')) return;
  await run(async () => { await api.put(`/notes/folders/${f.id}`, { token_action: action }); });
}
async function copy(t) {
  const ok = await copyText(link(t));
  if (!ok) alert('复制失败，请手动选中复制');
}
async function del(f) {
  err.value = '';
  try { await api.del(`/notes/folders/${f.id}`); }
  catch (e) {
    if (!String(e.message).includes('还有')) { err.value = e.message; return; }
    if (!confirm(`该文件夹下还有笔记或子文件夹。删除后子文件夹会提升到上一层，笔记会变成「未归档」。继续删除？`)) return;
    try { await api.del(`/notes/folders/${f.id}?force=1`); } catch (e2) { err.value = e2.message; return; }
  }
  emit('changed');
}

// 不能把自己或自己的后代当上级（后端也会拒，这里先挡掉，省得用户白点一次报错）
function parentOptions(f) {
  const banned = new Set([f.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const x of props.folders) {
      if (x.parent_id != null && banned.has(x.parent_id) && !banned.has(x.id)) { banned.add(x.id); grew = true; }
    }
  }
  return props.folders.filter((x) => !banned.has(x.id));
}
</script>
