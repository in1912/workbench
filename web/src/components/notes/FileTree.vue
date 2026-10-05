<template>
  <div class="ftree">
    <div v-for="f in nodes" :key="f.id">
      <div class="fnode" :class="{ over: dragOver === f.id }"
           :style="{ paddingLeft: depth * 12 + 4 + 'px' }"
           draggable="true"
           @click="$emit('toggle', f)"
           @contextmenu.prevent="$emit('menu', f, $event)"
           @dragstart="dragStart($event, 'folder', f.id)"
           @dragend="dragOver = null"
           @dragover="onOver($event, f.id)"
           @dragleave="dragOver = dragOver === f.id ? null : dragOver"
           @drop="onDrop($event, f.id)">
        <span class="caret">{{ isOpen(f.id) ? '▾' : '▸' }}</span>
        <span class="ico">📁</span>
        <span class="nm" :title="f.path || f.name">{{ f.name === 'general' ? '未分类' : f.name }}</span>
        <span v-if="f.intake_token" class="tag ok tiny" title="该文件夹已开对外写入通道">写</span>
        <span class="cnt muted" :title="cntTitle(f)">{{ f.note_count_total ?? (f.note_count || 0) }}</span>
      </div>

      <div v-if="isOpen(f.id)" class="fbody">
        <template v-if="f.children?.length || notesOf(f.id).length">
          <FileTree v-if="f.children?.length" :nodes="f.children" :depth="depth + 1"
                    :open="open" :notes="notes" :active-note-id="activeNoteId"
                    @toggle="$emit('toggle', $event)" @menu="(...a) => $emit('menu', ...a)"
                    @open-note="$emit('open-note', $event)" @new-note="$emit('new-note', $event)"
                    @move-note="(a, b) => $emit('move-note', a, b)" @move-folder="(a, b) => $emit('move-folder', a, b)" />
          <div v-for="n in notesOf(f.id)" :key="'n' + n.id" class="nnode"
               :class="{ active: n.id === activeNoteId }"
               :style="{ paddingLeft: (depth + 1) * 12 + 16 + 'px' }"
               draggable="true"
               @click.stop="$emit('open-note', n)"
               @dragstart="dragStart($event, 'note', n.id)"
               @dragend="dragOver = null">
            <span class="ico">{{ n.record_id ? '🎙' : (n.daily_date ? '📅' : '📄') }}</span>
            <span class="nm" :title="n.title">{{ n.title || '未命名' }}</span>
          </div>
          <div v-if="loading" class="muted tiny" :style="{ paddingLeft: (depth + 1) * 12 + 16 + 'px' }">载入中…</div>
        </template>
        <div v-else class="muted tiny" :style="{ paddingLeft: (depth + 1) * 12 + 16 + 'px' }">（空）</div>
      </div>
    </div>
    <div v-if="!nodes.length" class="muted small" style="padding:6px">还没有文件夹</div>
  </div>
</template>

<script setup>
// 文件夹 + 笔记递归树（v1.9.41）。
// 笔记按文件夹**懒加载**：个人库里可能上千条，一次全塞进左栏既慢又没意义，展开哪个文件夹才去要。
import { ref } from 'vue';

defineOptions({ name: 'FileTree' });
const props = defineProps({
  nodes: { type: Array, default: () => [] },
  depth: { type: Number, default: 0 },
  open: { type: Object, default: () => ({}) },      // { [folderId]: true }
  notes: { type: Object, default: () => ({}) },     // { [folderId]: [note] }
  loading: { type: Boolean, default: false },
  activeNoteId: { type: [Number, null], default: null },
});
const emit = defineEmits(['toggle', 'menu', 'open-note', 'new-note', 'move-note', 'move-folder']);

const dragOver = ref(null);
const isOpen = (id) => !!props.open[id];
// **只显示本层的笔记**。要来的列表是 `GET /notes?folder_id=<id>`，而这个接口默认**连子文件夹一起筛**
// （图谱、数据库视图要"含后代"是对的），于是展开父目录时，子目录里的笔记会被原样铺在下面、
// 展开子目录再出现一遍 —— 同一篇笔记在树里出现两次，看着像两条，删父层那条就把子目录里那条删了。
// 树里一篇笔记只该出现在它真正所属的那一级（右侧的行数徽标自 v1.10.19 起是「含后代」的累计口径，见 cntTitle）。
// 判空要宽容：folder_id 可能来自 JSON（数字或字符串）。
const notesOf = (id) => (props.notes[id] || []).filter((n) => Number(n.folder_id) === Number(id));

// 徽标显示**累计篇数**（本层 + 全部后代）：IM 归档的笔记都在孙层（IM连接/飞书/<连接器名>），
// 只看直属会把上两级显示成 0。直属与累计不一致时悬停可看两个口径（文件管理器的惯例）。
const cntTitle = (f) => (f.note_count_total > f.note_count
  ? `本层 ${f.note_count || 0} 篇，含子文件夹共 ${f.note_count_total} 篇`
  : `${f.note_count || 0} 篇`);

function dragStart(e, kind, id) {
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(kind === 'note' ? 'text/note-id' : 'text/folder-id', String(id));
  // 某些浏览器要求至少写一种 text/plain，否则拖拽直接不启动
  e.dataTransfer.setData('text/plain', String(id));
}

function hasType(e, t) {
  try { return Array.from(e.dataTransfer.types || []).includes(t); } catch { return false; }
}

function onOver(e, folderId) {
  const ok = hasType(e, 'text/note-id') || hasType(e, 'text/folder-id');
  if (!ok) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  dragOver.value = folderId;
}

function onDrop(e, folderId) {
  dragOver.value = null;
  const noteId = e.dataTransfer.getData('text/note-id');
  const fid = e.dataTransfer.getData('text/folder-id');
  if (noteId) { e.preventDefault(); e.stopPropagation(); emit('move-note', Number(noteId), folderId); return; }
  if (fid && Number(fid) !== folderId) { e.preventDefault(); e.stopPropagation(); emit('move-folder', Number(fid), folderId); }
}
</script>

<style scoped>
.fnode, .nnode { display: flex; align-items: center; gap: 4px; padding: 3px 4px; border-radius: 6px; cursor: pointer; font-size: 12.5px; }
.fnode:hover, .nnode:hover { background: var(--bg3); }
.fnode.over { background: var(--accent); color: #fff; }
.nnode.active { background: var(--bg3); color: var(--accent); }
.fnode .nm, .nnode .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.caret { width: 10px; font-size: 10px; color: var(--text3); }
.ico { font-size: 11.5px; }
.cnt { font-size: 10.5px; }
.tiny { font-size: 11px; }
</style>
