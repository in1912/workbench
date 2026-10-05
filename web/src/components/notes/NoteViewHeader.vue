<template>
  <div class="note-head">
    <!-- v1.10.8：这一行也要允许换行。⑧ 把右栏从 300 加到 600 之后，中间栏只剩 300 多 px，
         标题输入框（min-width 160px）和右侧那排按钮塞不进一行 —— 原来只有第二行是 .line.wrap，
         于是「分享 0 条 · 访问 0 次」被一个字一个字竖着排下来（真机截图里一眼就看到了）。
         配上下面那条 button{flex:0 0 auto; white-space:nowrap}：宁可让按钮整体掉到下一行，
         也不要把它压成竖排单字。 -->
    <div class="line wrap">
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
      <!-- v1.10.2：这一行要塞下「时间」，做了三处减法 ——
           ① 不写「文件夹」二字（右边的下拉本身就是答案）；
           ② 不重复放「文件夹管理」按钮（左栏底部 viewbar 里有一个，命令面板里也有）；
           ③ 右下角那条与下拉取值重复的文件夹路径也不再画。 -->
      <select :value="note.folder_id ?? ''" title="归属文件夹" class="folder-pick"
              @change="$emit('move', $event.target.value === '' ? null : Number($event.target.value))">
        <option value="">（未归档）</option>
        <!-- 与左栏文件树同一个显示规则：老种子文件夹 general 一律叫「未分类」（FileTree 里也是这么画的） -->
        <option v-for="f in folders" :key="f.id" :value="f.id">{{ '　'.repeat(f.depth) }}{{ f.name === 'general' ? '未分类' : f.name }}</option>
      </select>

      <span class="sep" />

      <button class="small" :disabled="!note.id" @click="$emit('download-md')">下载 MD</button>
      <button class="small" :disabled="!note.id" @click="$emit('download-html')">下载 HTML</button>

      <AiAssistMenu :note="note" :disabled="!note.id"
                    @insert-text="(t) => $emit('insert-text', t)"
                    @replace-text="(t) => $emit('replace-text', t)" />

      <!-- 时间（v1.10.2）：原来独占一行，现在跟在「AI 总结/续写/翻译」后面，省一行高度。
           库里存的是 SQLite 的 localtime 字符串（YYYY-MM-DD HH:MM:SS），原样显示，不做时区换算。
           为了让整行真的一行放得下，年份只在「不是今年」时才画（完整时间戳挂在 title 上，
           鼠标一停就能看到），且用「创建 / 修改」两个短词代替「创建于 / 最后修改」。 -->
      <template v-if="note.id">
        <span class="muted small nowrap" :title="'创建于 ' + (note.created_at || '—')">创建 {{ fmtTime(note.created_at) }}</span>
        <span class="muted small nowrap" :title="'最后修改 ' + (note.updated_at || '—')">修改 {{ fmtTime(note.updated_at) }}</span>
      </template>

      <button v-if="note.record_id" class="small" @click="$emit('open-record')">🎙 打开录音页</button>
      <span v-if="note.daily_date" class="tag ok small">每日笔记 {{ note.daily_date }}</span>
    </div>
  </div>
</template>

<script setup>
// 笔记头部（v1.9.41；v1.10.2 起时间并进「AI 总结 / 续写 / 翻译」那一行）：
// 标题、归属文件夹、保存/删除、分享、导出、AI、录音跳转。
// 按钮全部平铺而不是藏进「更多」菜单 —— 这是自己用的工具，少一次点击比界面整洁重要。
import AiAssistMenu from './AiAssistMenu.vue';

defineProps({
  note: { type: Object, required: true },
  folders: { type: Array, default: () => [] },
  dirty: { type: Boolean, default: false },
  saving: { type: Boolean, default: false },
  savedAt: { type: String, default: '' },
  shareStats: { type: Object, default: () => ({ link_count: 0, view_total: 0 }) },
});
defineEmits(['save', 'delete', 'move', 'share', 'manage', 'download-md', 'download-html',
  'open-record', 'insert-text', 'replace-text']);

const THIS_YEAR = String(new Date().getFullYear());

// '2026-10-05 08:12:33' → '10-05 08:12'（今年的）/ '2025-10-05 08:12'（往年的）。
// 缺值一律显示「—」而不是空白（老笔记可能没有这一列）。完整值在 span 的 title 上。
function fmtTime(s) {
  const t = String(s || '').trim();
  if (!t) return '—';
  const full = t.length >= 16 ? t.slice(0, 16) : t;
  return full.startsWith(THIS_YEAR) ? full.slice(5) : full;
}
</script>

<style scoped>
.note-head { border-bottom: 1px solid var(--border); padding-bottom: 8px; margin-bottom: 10px; }
.line { display: flex; align-items: center; gap: 6px; }
.line + .line { margin-top: 6px; }
.line.wrap { flex-wrap: wrap; }
/* 头部这排按钮（保存 / 🔗分享 / 分享 N 条 · 访问 N 次 / 删除）一律不许被压扁：
   「分享 0 条 · 访问 0 次」是一整句话，flex 一挤就变成竖排单字。宁可整排换行。 */
.note-head .row > button { flex: 0 0 auto; white-space: nowrap; }
.title { font-size: 16px; font-weight: 600; flex: 1; min-width: 160px; background: transparent; border: 1px solid transparent; border-radius: 6px; padding: 4px 6px; color: var(--text); }
.title:hover { border-color: var(--border); }
.title:focus { border-color: var(--accent); background: var(--bg2); outline: none; }
/* 文件夹下拉是本行唯一的「可伸缩件」：宽了限到 130px，窄了先压它，而不是把「创建/修改」挤到第二行
   （完整名字在下拉里、以及悬停的 title 上都看得到） */
.folder-pick { width: auto; flex: 0 1 auto; min-width: 88px; max-width: 130px; padding: 4px 8px; }
.dirty { color: var(--amber); font-size: 11.5px; white-space: nowrap; }
.saved { color: var(--text3); font-size: 11.5px; white-space: nowrap; }
.sep { width: 1px; height: 16px; background: var(--border); margin: 0 4px; }
.nowrap { white-space: nowrap; }
</style>
