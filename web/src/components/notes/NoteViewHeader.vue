<template>
  <div class="note-head">
    <div class="line">
      <input v-model="note.title" class="title" placeholder="未命名" @keyup.enter="$emit('save')">
      <span v-if="dirty" class="dirty" title="有改动还没保存">未保存</span>
      <span v-else-if="savedAt" class="saved">已保存 {{ savedAt }}</span>
      <div class="row" style="margin-left:auto; gap:6px">
        <button class="primary" :disabled="saving" @click="$emit('save')">{{ saving ? '保存中…' : '保存' }}</button>
        <template v-if="note.id">
          <button class="small" @click="$emit('share')">🔗 分享</button>
          <button class="small" @click="$emit('manage')">分享 {{ shareStats.link_count }} 条 · 访问 {{ shareStats.view_total }} 次</button>
          <button class="small danger" @click="$emit('delete')">删除</button>
        </template>
      </div>
    </div>

    <div class="line wrap">
      <span class="muted small">文件夹</span>
      <select :value="note.folder_id ?? ''" style="width:auto; max-width:220px; padding:4px 8px"
              @change="$emit('move', $event.target.value === '' ? null : Number($event.target.value))">
        <option value="">（未归档）</option>
        <option v-for="f in folders" :key="f.id" :value="f.id">{{ '　'.repeat(f.depth) }}{{ f.name }}</option>
      </select>
      <button class="small" @click="$emit('manage-folders')">文件夹管理</button>

      <span class="sep" />

      <button class="small" :disabled="!note.id" @click="$emit('download-md')">下载 MD</button>
      <button class="small" :disabled="!note.id" @click="$emit('download-html')">下载 HTML</button>

      <AiAssistMenu :note="note" :disabled="!note.id"
                    @insert-text="(t) => $emit('insert-text', t)"
                    @replace-text="(t) => $emit('replace-text', t)" />

      <button v-if="note.record_id" class="small" @click="$emit('open-record')">🎙 打开录音页</button>
      <span v-if="note.daily_date" class="tag ok small">每日笔记 {{ note.daily_date }}</span>
      <span v-if="folderPath" class="muted small" style="margin-left:auto">{{ folderPath }}</span>
    </div>
  </div>
</template>

<script setup>
// 笔记头部（v1.9.41）：标题、归属文件夹、保存/删除、分享、导出、AI、录音跳转。
// 按钮全部平铺而不是藏进「更多」菜单 —— 这是自己用的工具，少一次点击比界面整洁重要。
import { computed } from 'vue';
import AiAssistMenu from './AiAssistMenu.vue';

const props = defineProps({
  note: { type: Object, required: true },
  folders: { type: Array, default: () => [] },
  dirty: { type: Boolean, default: false },
  saving: { type: Boolean, default: false },
  savedAt: { type: String, default: '' },
  shareStats: { type: Object, default: () => ({ link_count: 0, view_total: 0 }) },
});
defineEmits(['save', 'delete', 'move', 'share', 'manage', 'download-md', 'download-html',
  'manage-folders', 'open-record', 'insert-text', 'replace-text']);

const folderPath = computed(() => props.note.folder_path || '');
</script>

<style scoped>
.note-head { border-bottom: 1px solid var(--border); padding-bottom: 8px; margin-bottom: 10px; }
.line { display: flex; align-items: center; gap: 6px; }
.line + .line { margin-top: 6px; }
.line.wrap { flex-wrap: wrap; }
.title { font-size: 16px; font-weight: 600; flex: 1; min-width: 160px; background: transparent; border: 1px solid transparent; border-radius: 6px; padding: 4px 6px; color: var(--text); }
.title:hover { border-color: var(--border); }
.title:focus { border-color: var(--accent); background: var(--bg2); outline: none; }
.dirty { color: var(--amber); font-size: 11.5px; white-space: nowrap; }
.saved { color: var(--text3); font-size: 11.5px; white-space: nowrap; }
.sep { width: 1px; height: 16px; background: var(--border); margin: 0 4px; }
</style>
