<template>
  <!-- v1.10.9：这个根类原来是 "sidebar"，跟 App.vue 里那套**全局侧栏**的样式撞了名。
       style.css:117 的 .sidebar 写着 width:190px / position:sticky / height:100vh / border-right，
       于是笔记页左栏的内容被**死死钉在 190px 宽的一个小框里** —— 拖分隔条时外层 .ns-left
       确实在变宽（300→560），里面这一层却一动不动，看起来就是「拉宽了没反应，还是个小框」。
       scoped 样式压不过那条全局规则里独有的属性（width / position / height），改名是唯一的干净解法。 -->
  <div class="ns-side">
    <div class="row" style="gap:4px; margin-bottom:8px">
      <button class="primary small" @click="$emit('new-note')">＋ 新建</button>
      <button class="small" title="打开今天的日记（Ctrl/⌘+P）" @click="$emit('daily')">今日笔记</button>
      <button class="small" title="快速切换（Ctrl/⌘+O）" @click="$emit('switcher')">🔍</button>
      <button class="small" title="命令面板（Ctrl/⌘+Shift+P）" @click="$emit('palette')">⌘</button>
    </div>

    <div class="sectabs">
      <button v-for="s in SECTIONS" :key="s.k" :class="{ on: section === s.k }" :title="s.title"
              @click="$emit('update:section', s.k)">{{ s.t }}</button>
    </div>

    <div class="sbody">
      <!-- 文件：文件夹树 -->
      <template v-if="section === 'files'">
        <div class="row" style="margin-bottom:6px">
          <button class="small" @click="$emit('new-folder', null)">＋ 顶层文件夹</button>
          <button class="small" @click="$emit('toggle-folders')">{{ anyOpen ? '收起全部' : '展开全部' }}</button>
        </div>
        <FileTree :nodes="tree" :open="openFolders" :notes="notesByFolder" :loading="loadingNotes"
                  :active-note-id="activeNoteId"
                  @toggle="$emit('toggle-folder', $event)" @menu="(f, e) => $emit('folder-menu', f, e)"
                  @open-note="$emit('open-note', $event)"
                  @move-note="(a, b) => $emit('move-note', a, b)" @move-folder="(a, b) => $emit('move-folder', a, b)" />
      </template>

      <!-- 搜索 -->
      <template v-else-if="section === 'search'">
        <SearchBox :model-value="searchQ" :mode="searchMode"
                   @update:model-value="$emit('update:searchQ', $event)"
                   @update:mode="$emit('update:searchMode', $event)"
                   @search="$emit('search', $event)" />
        <div v-if="searchActive" class="row" style="margin:8px 0 4px">
          <span class="muted small">找到 {{ list.length }} 条</span>
          <button class="small" style="margin-left:auto" @click="$emit('clear-search')">清除</button>
        </div>
        <NoteList v-if="searchActive" :notes="list" :active-note-id="activeNoteId" :label-of="labelOf"
                  empty-text="没找到匹配的笔记" @open-note="$emit('open-note', $event)" />
        <div v-else class="muted small" style="margin-top:8px">输入关键词开始搜索。右侧「数据库」页签可以用表单拼更复杂的条件。</div>
      </template>

      <!-- 标签 -->
      <template v-else-if="section === 'tags'">
        <div v-for="t in tags" :key="t.tag" class="trow" @click="$emit('filter-tag', t.tag)">
          <span class="tag small">{{ t.tag }}</span><span class="muted small">{{ t.count }}</span>
        </div>
        <div v-if="!tags.length" class="muted small">还没有标签。正文里写 #标签 即可。</div>
      </template>

      <!-- 书签 -->
      <template v-else-if="section === 'bookmarks'">
        <div v-for="b in bookmarks" :key="b.id" class="brow" @click="$emit('open-bookmark', b)">
          <span class="nm">{{ b.label || b.title || b.anchor || ('#' + (b.note_id || b.folder_id)) }}</span>
          <button class="x" title="取消收藏" @click.stop="$emit('del-bookmark', b)">×</button>
        </div>
        <div v-if="!bookmarks.length" class="muted small">还没有书签。在笔记头部点 ★ 收藏。</div>
      </template>

      <!-- 模板 -->
      <template v-else-if="section === 'templates'">
        <div class="row" style="margin-bottom:6px"><button class="small" @click="$emit('new-template')">＋ 新建模板</button></div>
        <div v-for="t in templates" :key="t.id" class="brow">
          <span class="nm" :title="t.content">{{ t.name }}</span>
          <button class="x" title="用这个模板建笔记" @click.stop="$emit('use-template', t)">用</button>
          <button class="x" title="编辑" @click.stop="$emit('edit-template', t)">✎</button>
          <button class="x" title="删除" @click.stop="$emit('del-template', t)">×</button>
        </div>
        <div v-if="!templates.length" class="muted small">还没有模板。闪念 / 文献 / 永久笔记都靠「模板 + 标签」来区分。</div>
      </template>

      <!-- 录音 -->
      <template v-else-if="section === 'recs'">
        <RecList :recs="recs" @open-rec="$emit('open-rec', $event)" @new-rec="$emit('new-rec')" @refresh="$emit('load-recs')" />
      </template>
    </div>

    <div class="sfoot">
      <div v-if="stats && stats.total_notes != null" class="sstat" title="今日写作 / 连续打卡（点开看统计）"
           @click="$emit('open-view', 'stats')">
        <span>今日 {{ stats.today_words || 0 }} 字</span>
        <span v-if="stats.streak_days">🔥 连续 {{ stats.streak_days }} 天</span>
      </div>
      <button v-for="v in VIEWS" :key="v.k" class="vbtn" :title="v.title" @click="$emit('open-view', v.k)">{{ v.t }}</button>
      <button class="vbtn" title="文件夹 / 外部写入令牌管理" @click="$emit('manage-folders')">⚙ 文件夹管理</button>
    </div>
  </div>
</template>

<script setup>
// 左栏（v1.9.41）：文件树 / 搜索 / 标签 / 书签 / 模板 / 录音 六个分区 + 底部视图入口。
// 标签、书签、模板三块是纯列表，直接写在这里而不是各拆一个组件 —— 拆出去只会多出三份 props 声明，
// 逻辑一行都不会变少（真正有逻辑的树、列表、搜索框已各自独立成组件）。
import FileTree from './FileTree.vue';
import NoteList from './NoteList.vue';
import SearchBox from './SearchBox.vue';
import RecList from './RecList.vue';

defineProps({
  section: { type: String, default: 'files' },
  tree: { type: Array, default: () => [] },
  openFolders: { type: Object, default: () => ({}) },
  notesByFolder: { type: Object, default: () => ({}) },
  loadingNotes: { type: Boolean, default: false },
  anyOpen: { type: Boolean, default: false },
  list: { type: Array, default: () => [] },
  searchQ: { type: String, default: '' },
  searchMode: { type: String, default: 'keyword' },
  searchActive: { type: Boolean, default: false },
  tags: { type: Array, default: () => [] },
  bookmarks: { type: Array, default: () => [] },
  templates: { type: Array, default: () => [] },
  recs: { type: Array, default: () => [] },
  activeNoteId: { type: [Number, null], default: null },
  labelOf: { type: Function, default: (n) => n.folder_path || n.category || '' },
  stats: { type: Object, default: () => ({}) },
});
defineEmits(['update:section', 'update:searchQ', 'update:searchMode', 'search', 'clear-search',
  'new-note', 'daily', 'switcher', 'palette', 'open-note', 'toggle-folder', 'folder-menu',
  'new-folder', 'toggle-folders', 'move-note', 'move-folder', 'filter-tag',
  'open-bookmark', 'del-bookmark', 'new-template', 'use-template', 'edit-template', 'del-template',
  'load-recs', 'open-rec', 'new-rec', 'open-view', 'manage-folders']);

const SECTIONS = [
  { k: 'files', t: '文件', title: '文件夹与笔记' },
  { k: 'search', t: '搜索', title: '关键词 / 标签 / 路径 / 正则' },
  { k: 'tags', t: '标签', title: '全部标签' },
  { k: 'bookmarks', t: '书签', title: '收藏的笔记与段落' },
  { k: 'templates', t: '模板', title: '笔记模板' },
  { k: 'recs', t: '录音', title: '录音转写生成的笔记' },
];
const VIEWS = [
  { k: 'graph', t: '🕸 图谱', title: '知识图谱' },
  { k: 'timeline', t: '🕒 时间线', title: '按时间回看' },
  { k: 'query', t: '🗃 数据库', title: 'Dataview 查询' },
  { k: 'board', t: '🧩 白板', title: '白板' },
  { k: 'help', t: '❓ 说明', title: '使用说明' },
];
</script>

<style scoped>
/* 撑满外层 .ns-left（那个宽度才是拖拽控制的），所以这里**不写 width**，只写布局与高度。
   v1.10.9 起类名从 .sidebar 改成 .ns-side：原来的名字会命中全局侧栏的 width:190px，
   拖宽左栏时内容不跟着变宽。 */
.ns-side { display: flex; flex-direction: column; flex: 1; min-width: 0; height: 100%; min-height: 0; }
/* 顶部那排「＋ 新建 / 今日笔记 / 🔍 / ⌘」：左栏默认 300px 时**恰好放得下**（≈240px 内容宽），
   不加 nowrap 的话四个按钮会被 flex 均分压扁 —— 「＋ 新建」被拆成三行竖排、「今日笔记」也变竖的。
   v1.10.5 真机点检时截图里看到的（默认宽度从 260 加宽到 300 之后本该更好看，结果一样难看）。 */
.ns-side > .row:first-child > button { flex: 0 0 auto; white-space: nowrap; }
.sectabs { display: flex; gap: 2px; flex-wrap: wrap; border-bottom: 1px solid var(--border); padding-bottom: 5px; margin-bottom: 8px; }
.sectabs button { font-size: 11.5px; padding: 2px 7px; border-radius: 5px; border: 1px solid transparent; background: transparent; color: var(--text2); cursor: pointer; }
.sectabs button:hover { background: var(--bg3); color: var(--text); }
.sectabs button.on { background: var(--accent); color: #fff; }
.sbody { flex: 1; min-height: 0; overflow-y: auto; }
.trow, .brow { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-radius: 5px; cursor: pointer; font-size: 12.5px; }
.trow:hover, .brow:hover { background: var(--bg3); }
.trow { justify-content: space-between; }
.brow .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.brow .x { border: none; background: none; color: var(--text3); cursor: pointer; font-size: 12px; padding: 0 3px; border-radius: 4px; }
.brow .x:hover { color: var(--accent); background: var(--bg2); }
.sfoot { border-top: 1px solid var(--border); padding-top: 6px; margin-top: 6px; display: flex; flex-wrap: wrap; gap: 3px; }
.sstat { flex: 0 0 100%; display: flex; gap: 10px; font-size: 11.5px; color: var(--text2); padding: 2px 4px 4px; cursor: pointer; border-radius: 5px; }
.sstat:hover { background: var(--bg3); color: var(--text); }
.vbtn { font-size: 11.5px; padding: 3px 8px; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--text2); cursor: pointer; }
.vbtn:hover { background: var(--bg3); color: var(--text); }
</style>
