<template>
  <div class="nshell" :class="{ narrow }">
    <!-- 顶部：横向标签条 + 全局动作 -->
    <div class="ns-top">
      <TabStack @closed="onTabClosed" />
      <div class="ns-top-act">
        <!-- 窄屏（<900px）左栏变成浮动抽屉，这个 ☰ 是它唯一的入口（v1.10.2 补上）：
             在此之前 leftOpen 只被赋过 false，窄屏下文件树/分区/视图入口根本打不开 -->
        <button v-if="narrow" class="small" :title="leftOpen ? '收起左栏' : '展开左栏（文件树 / 搜索 / 标签 / 视图）'"
                @click="leftOpen = !leftOpen">☰</button>
        <button class="small" title="新建笔记（Alt+N）" @click="newNote()">＋ 新建</button>
        <button class="small" title="快速切换（Ctrl/⌘+O）" @click="openSwitcher()">🔍 切换</button>
        <button class="small" title="命令面板（Ctrl/⌘+Shift+P）" @click="openPalette()">⌘ 面板</button>
        <!-- IM连接（v1.10.5，需求③）：以本人身份授权，把 IM 聊天记录归档成笔记。
             放在【新建】【切换】【面板】之后，右侧那个 ⇥ 是布局开关，留在最右边。 -->
        <button class="small" title="IM连接：授权飞书等 IM，把聊天记录归档成笔记" @click="imOpen = true">🔗 IM连接</button>
        <!-- 批量链接（v1.10.24 互链；v1.10.28 循环链 + 取消链接）：搜一批相关笔记批量加/清 [[双链]] -->
        <button class="small" title="批量链接：按关键词搜一批笔记，两两互加 [[双链]] / 按顺序串成循环链 / 批量取消链接" @click="blOpen = true">🕸 批量链接</button>
        <button class="small" :title="rightOpen ? '收起右栏' : '展开右栏'" @click="toggleRight()">{{ rightOpen ? '⇥' : '⇤' }}</button>
      </div>
    </div>

    <div class="ns-body">
      <!-- 窄屏遮罩（v1.10.2 补 ☰ 时漏想的一处）：它必须只盖「正文区」。
           1.10.2 上线后真机点检发现：遮罩 position:fixed + inset:0 会连顶栏一起盖住，
           于是 ☰ 自己（title 写着「收起左栏」）以及 新建/切换/面板/⇤ 在抽屉打开期间全都点不动 ——
           点哪都只关抽屉。改成 absolute 贴在 .ns-body 上，顶栏就一直是活的。 -->
      <div v-if="narrow && leftOpen" class="ns-scrim" @click="leftOpen = false" />
      <aside v-if="!narrow || leftOpen" class="ns-pane ns-left" :style="{ width: narrow ? '78vw' : leftW + 'px' }">
        <NotesSidebar
          :section="section" :tree="folderTree" :open-folders="openFolders" :notes-by-folder="notesByFolder"
          :loading-notes="loadingNotes" :any-open="anyFolderOpen" :list="list" :search-q="searchQ"
          :search-mode="searchMode" :search-active="searchRan" :tags="tags" :bookmarks="bookmarks"
          :templates="templates" :recs="recs" :active-note-id="activeNoteId" :label-of="labelOf"
          :stats="stats"
          @update:section="section = $event"
          @update:search-q="searchQ = $event"
          @update:search-mode="searchMode = $event"
          @search="runSearch" @clear-search="clearSearch"
          @new-note="newNote()" @daily="openDaily()" @switcher="openSwitcher()" @palette="openPalette()"
          @open-note="openNoteTab" @toggle-folder="toggleFolder" @folder-menu="() => (folderModal = true)"
          @new-folder="newFolder" @toggle-folders="toggleFolders"
          @move-note="moveNote" @move-folder="moveFolder"
          @filter-tag="filterByTag" @open-bookmark="openBookmark" @del-bookmark="delBookmark"
          @new-template="editTemplate(null)" @use-template="useTemplate" @edit-template="editTemplate"
          @del-template="delTemplate" @load-recs="loadRecs" @open-rec="openRec" @new-rec="newRec"
          @open-view="openView" @manage-folders="folderModal = true" />
      </aside>

      <!-- v1.10.5：条件里的 leftOpen 去掉。leftOpen 只在窄屏由 ☰ 赋值，
           大屏下它恒为 false —— 于是这根分隔条**从来没在大屏渲染过**，左栏只读不可拖。
           左栏在大屏是常驻的（<aside> 的判断是 !narrow || leftOpen），分隔条跟着它走即可。 -->
      <Splitter v-if="!narrow" v-model="leftW" :min="180" :max="560" :default-width="300"
                @done="savePaneWidths" />

      <section class="ns-pane ns-center">
        <template v-if="activeKind === 'note' && activeDoc">
          <NoteViewHeader :note="activeDoc.note" :folders="flatFolders" :dirty="!!activeTab?.dirty"
                          :saving="!!activeDoc.saving" :saved-at="activeDoc.savedAt" :share-stats="activeDoc.shareStats"
                          :autosave="autoSave"
                          @toggle-autosave="toggleAutosave"
                          @save="saveTab(activeKey)" @delete="delNote" @move="moveActive" @share="shareOpen = true"
                          @manage="manageOpen = true" @download-md="downloadNoteMd(activeDoc.note)"
                          @download-html="downloadNoteHtml(activeDoc.note, catLabel)"
                          @open-record="openRecordPage"
                          @insert-text="(t) => editorRef?.insertText(t)"
                          @replace-text="(t) => editorRef?.replaceText(t)" />
          <NoteEditor ref="editorRef" :note="activeDoc.note" :mode="activeDoc.mode" :resolve-wiki="resolveWiki"
                      :titles="allTitles" :doc-key="activeKey"
                      @update:mode="activeDoc.mode = $event" @save="saveTab(activeKey)"
                      @open-note="openNoteById" @new-note="(t) => newNote(t)" />
          <div v-if="activeDoc.note.summary" class="sumbox">
            <b>概要</b>
            <div style="margin-top:4px">{{ activeDoc.note.summary }}</div>
            <div v-if="activeDoc.note.keywords" class="muted small" style="margin-top:4px">关键词：{{ activeDoc.note.keywords }}</div>
          </div>
          <div v-if="activeDoc.note.record_id" class="muted small" style="margin-top:6px">
            🎙 这条来自录音转写 <a href="javascript:;" @click="openRecordPage">打开录音页</a>
          </div>
        </template>

        <template v-else-if="activeKind === 'rec'">
          <RecList :recs="recs" @open-rec="openRec" @new-rec="newRec" @refresh="loadRecs" />
        </template>

        <template v-else-if="activeKind === 'graph'">
          <GraphView :folders="flatFolders" @open-note="openNoteById" />
        </template>

        <template v-else-if="activeKind === 'query'">
          <DatabaseView :folders="flatFolders" :prop-defs="propDefs" @open-note="openNoteById" />
        </template>

        <template v-else-if="activeKind === 'timeline'">
          <TimelineView @open-note="openNoteById" />
        </template>

        <template v-else-if="activeKind === 'board'">
          <WhiteboardView :notes="allTitles" @open-note="openNoteById" />
        </template>

        <template v-else-if="activeKind === 'stats'">
          <StatsPanel :stats="stats" @loaded="(s) => (stats = s)" />
        </template>

        <template v-else-if="activeKind === 'help'">
          <NotesHelp @open-note="openHelpNote" />
        </template>

        <div v-else-if="activeKind" class="placeholder">
          <div class="ph-t">{{ activeTab?.title }}</div>
          <div class="muted small">该视图尚未接入。</div>
        </div>

        <div v-else class="placeholder">
          <div class="ph-t">还没有打开任何页签</div>
          <div class="muted small">
            从左栏选一篇笔记，或按 <b>{{ IS_MAC ? '⌘' : 'Ctrl' }}+O</b> 快速切换 / <b>{{ IS_MAC ? '⌥' : 'Alt' }}+N</b> 新建。
          </div>
          <div class="row" style="gap:6px; margin-top:12px">
            <button class="primary small" @click="newNote()">＋ 新建笔记</button>
            <button class="small" @click="openDaily()">打开今日笔记</button>
          </div>
        </div>
      </section>

      <Splitter v-if="!narrow && rightOpen" v-model="rightW" invert :min="200" :max="900" :default-width="600"
                @done="savePaneWidths" />

      <aside v-if="rightOpen" class="ns-pane ns-right" :style="{ width: narrow ? '84vw' : rightW + 'px' }">
        <NotesRightPanel :mode="rightMode" :headings="headings" :prop-defs="propDefs"
                         :active-note-id="activeNoteId"
                         :props-of="activeDoc?.note?.props || {}" :links="activeDoc?.links || {}"
                         :note-title="activeDoc?.note?.title || ''" :tags="tags" :stats="stats"
                         @update:mode="rightMode = $event" @collapse="toggleRight" @go-heading="goHeading"
                         @set-prop="setProp" @manage-props="propsModal = true" @open-note="openNoteById"
                         @create-note="(t) => newNote(t)" @filter-tag="filterByTag"
                         @open-full-graph="openView('graph')" />
      </aside>
    </div>

    <!-- ===== 弹窗 ===== -->
    <NoteShareDialog v-if="shareOpen && activeDoc?.note?.id" :note="activeDoc.note"
                     @close="shareOpen = false" @created="reloadShareStats" />
    <NoteShareManage v-if="manageOpen && activeDoc?.note?.id" :note="activeDoc.note" @close="manageOpen = false" />
    <CategoryManageModal v-if="folderModal" :folders="flatFolders" :external="external"
                         @close="folderModal = false" @changed="reloadFolders" />
    <!-- IM连接（v1.10.5）：同步出来的笔记直接在这里打开页签，不用去文件树里找 -->
    <ImConnectModal v-if="imOpen" @close="imOpen = false"
                    @open-note="(id) => { imOpen = false; openNoteTab(id); }" />
    <!-- 批量反链（v1.10.24）：互链改动的是别的笔记的正文，打开着的页签要跟着刷新 -->
    <BatchBacklinkModal v-if="blOpen" @close="blOpen = false" @done="onBacklinked" />

    <!-- 属性定义管理 -->
    <div v-if="propsModal" class="modal-backdrop" @click.self="propsModal = false">
      <div class="modal" style="width:min(620px,94vw); max-height:86vh; overflow-y:auto">
        <h3>笔记属性</h3>
        <div class="muted small" style="margin-bottom:10px">定义之后，右侧「属性」面板就能逐篇填值，数据库查询里也能用 <code>prop.键名</code> 过滤。</div>
        <div v-if="propErr" class="msg err">{{ propErr }}</div>
        <div class="row" style="gap:6px; margin-bottom:10px">
          <input v-model="newProp.key" placeholder="键名（英文，如 status）" style="flex:1">
          <input v-model="newProp.label" placeholder="显示名（如 状态）" style="flex:1">
          <select v-model="newProp.type" style="width:110px">
            <option value="text">文本</option><option value="number">数字</option>
            <option value="date">日期</option><option value="select">单选</option><option value="checkbox">勾选</option>
          </select>
          <button class="primary" @click="addProp">添加</button>
        </div>
        <div v-for="d in propDefs" :key="d.id" class="card" style="background:var(--bg3); border:none; margin-bottom:6px">
          <div class="row" style="gap:6px; align-items:center">
            <b style="font-size:12.5px">{{ d.label || d.key }}</b>
            <span class="muted small">{{ d.key }} · {{ d.type }}</span>
            <span v-if="d.type === 'select' && d.options?.length" class="muted small">{{ d.options.join(' / ') }}</span>
            <button class="small danger" style="margin-left:auto" @click="delProp(d)">删除</button>
          </div>
        </div>
        <div v-if="!propDefs.length" class="muted small">还没有定义任何属性。</div>
        <div class="row" style="justify-content:flex-end; margin-top:8px"><button @click="propsModal = false">关闭</button></div>
      </div>
    </div>

    <!-- 模板编辑 -->
    <div v-if="tplModal" class="modal-backdrop" @click.self="tplModal = false">
      <div class="modal" style="width:min(680px,94vw)">
        <h3>{{ tplForm.id ? '编辑模板' : '新建模板' }}</h3>
        <div class="muted small" style="margin-bottom:8px">可用占位符：<code v-pre>{{date}}</code> <code v-pre>{{time}}</code> <code v-pre>{{title}}</code></div>
        <div v-if="tplErr" class="msg err">{{ tplErr }}</div>
        <input v-model="tplForm.name" placeholder="模板名（如 闪念笔记）" style="margin-bottom:8px">
        <textarea v-model="tplForm.content" rows="12" style="font-family:ui-monospace,Consolas,monospace"></textarea>
        <div class="row" style="justify-content:flex-end; gap:6px; margin-top:8px">
          <button @click="tplModal = false">取消</button>
          <button class="primary" @click="saveTemplate">保存</button>
        </div>
      </div>
    </div>

    <!-- 快速切换器 -->
    <div v-if="switcherOpen" class="modal-backdrop" @click.self="switcherOpen = false">
      <div class="modal" style="width:min(560px,94vw)">
        <input ref="swInput" v-model="swQ" placeholder="跳到哪篇笔记？（输入即筛，回车打开）"
               style="margin-bottom:8px" @keydown.down.prevent="swMove(1)" @keydown.up.prevent="swMove(-1)"
               @keydown.enter.prevent="swPick()" @keydown.esc="switcherOpen = false">
        <div class="swlist">
          <div v-for="(r, i) in swResults" :key="r.id" class="swrow" :class="{ on: i === swIdx }"
               @click="swPick(i)">
            <span class="nm" v-html="hl(r.title || '未命名', r.idx)" />
            <span class="muted small">{{ r.folder_path || '' }}</span>
          </div>
          <div v-if="!swResults.length" class="swrow" :class="{ on: true }" @click="swCreate()">
            没有匹配 → 新建「{{ swQ }}」
          </div>
        </div>
      </div>
    </div>

    <!-- 命令面板 -->
    <div v-if="paletteOpen" class="modal-backdrop" @click.self="paletteOpen = false">
      <div class="modal" style="width:min(560px,94vw)">
        <input ref="palInput" v-model="palQ" placeholder="输入命令…" style="margin-bottom:8px"
               @keydown.down.prevent="palMove(1)" @keydown.up.prevent="palMove(-1)"
               @keydown.enter.prevent="palRun()" @keydown.esc="paletteOpen = false">
        <div class="swlist">
          <div v-for="(c, i) in palResults" :key="c.t" class="swrow" :class="{ on: i === palIdx }" @click="palRun(i)">
            <span class="nm">{{ c.t }}</span>
            <span class="muted small">{{ c.key ? prettyShortcut(c) : '' }}</span>
          </div>
        </div>
      </div>
    </div>

  </div>
</template>

<script setup>
// 笔记三栏外壳（v1.9.41）——数据与交互的唯一所有者。
//
// 分工：左栏只负责「显示与派发事件」，右栏只负责「显示」，中间是编辑器；
// 所有取数、保存、拖拽、快捷键、路由 query 都收在这一层，避免状态散落在三个组件里各说各话。
//
// 两个刻意的取舍：
// ① 只有**当前激活的**笔记渲染编辑器实例，切页签时正文从 docs 里取回 —— 不重开、不丢未保存的改动；
// ② 已经有 id 的笔记改动后 3 秒自动落盘（草稿仍需手动保存，因为还没有 id 可写）。
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router';
import { api } from '../../api';
import { useNotesTabs } from '../../composables/useNotesTabs';
import { useShortcut, prettyShortcut, IS_MAC } from '../../composables/useShortcuts';
import { fuzzyFilter, highlight } from '../../utils/fuzzy';
import { extractHeadings } from '../../utils/markdown';
import { downloadNoteMd, downloadNoteHtml } from '../../utils/noteDownload';
import { loadExternalBase } from '../../utils/noteShare';
import NoteShareDialog from '../NoteShareDialog.vue';
import NoteShareManage from '../NoteShareManage.vue';
import NotesSidebar from './NotesSidebar.vue';
import NotesRightPanel from './NotesRightPanel.vue';
import NotesHelp from './NotesHelp.vue';
import DatabaseView from './DatabaseView.vue';
import TimelineView from './TimelineView.vue';
import GraphView from './GraphView.vue';
import WhiteboardView from './WhiteboardView.vue';
import StatsPanel from './StatsPanel.vue';
import NoteViewHeader from './NoteViewHeader.vue';
import NoteEditor from './NoteEditor.vue';
import TabStack from './TabStack.vue';
import Splitter from './Splitter.vue';
import RecList from './RecList.vue';
import CategoryManageModal from './CategoryManageModal.vue';
import ImConnectModal from './ImConnectModal.vue';
import BatchBacklinkModal from './BatchBacklinkModal.vue';

const route = useRoute();
const router = useRouter();
const { tabs, activeKey, active: activeTab, openNote, openDraft, openUnique, activate, close, setDirty, patchByNoteId, docs, getDoc, setDoc, hasDirty, closeNote } = useNotesTabs();

// ---------- 布局 ----------
// v1.10.5（需求⑧）：默认宽度整体调大 —— 左栏 260→300、右栏（大纲/图谱那列）300→600（翻一倍）。
// 存档带版本号 v=2：**没有版本号的旧存档一律忽略一次**，否则浏览器里那个旧默认值（300）
// 会把新默认值原地盖掉，用户看到的是「改了跟没改一样」。代价是用户之前手拖过的宽度也重置一次。
const paneW = (() => {
  try {
    const o = JSON.parse(localStorage.getItem('notes.paneWidths') || '{}');
    return Number(o && o.v) === 2 ? o : {};
  } catch { return {}; }
})();
const leftW = ref(Number(paneW.left) || 300);
const rightW = ref(Number(paneW.right) || 600);
const rightOpen = ref(localStorage.getItem('notes.rightOpen') !== '0');
const leftOpen = ref(false);
const narrow = ref(false);
function savePaneWidths() { try { localStorage.setItem('notes.paneWidths', JSON.stringify({ v: 2, left: leftW.value, right: rightW.value })); } catch { /* 忽略 */ } }
function toggleRight() { rightOpen.value = !rightOpen.value; try { localStorage.setItem('notes.rightOpen', rightOpen.value ? '1' : '0'); } catch { /* 忽略 */ } }
function onResize() {
  const was = narrow.value;
  narrow.value = window.innerWidth < 900;
  if (was && !narrow.value) leftOpen.value = false;
}
onMounted(() => {
  onResize();
  window.addEventListener('resize', onResize);
  document.body.classList.add('notes-shell'); // 放开 .main 的 1200px 上限（见文件底部全局样式）
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  document.body.classList.remove('notes-shell');
});

// ---------- 左栏数据 ----------
const sections = ['files', 'search', 'tags', 'bookmarks', 'templates', 'recs'];
const section = ref('files');
const folderTree = ref([]);
// 展开状态存档带版本号 v=2：无版本号的旧存档是「每次进页面强制展开全部顶层」时代的产物，
// 不是用户的手动选择——升级后忽略一次，从「默认收起」重新开始（与 paneWidths 同一套办法）。
const openFolders = ref((() => {
  try {
    const o = JSON.parse(localStorage.getItem('notes.openFolders') || '{}');
    return Number(o && o.v) === 2 && o.open && typeof o.open === 'object' ? o.open : {};
  } catch { return {}; }
})());
const notesByFolder = ref({});
const loadingNotes = ref(false);
const list = ref([]);
const tags = ref([]);
const bookmarks = ref([]);
const templates = ref([]);
const recs = ref([]);
const propDefs = ref([]);
const stats = ref({});
const external = ref('');
const titleIndex = ref(new Map());

const searchQ = ref('');
const searchMode = ref('keyword');
const searchRan = ref(false);

const flatFolders = computed(() => {
  const out = [];
  const walk = (nodes, depth) => {
    for (const f of nodes || []) { out.push({ ...f, depth }); walk(f.children, depth + 1); }
  };
  walk(folderTree.value, 0);
  return out;
});
const anyFolderOpen = computed(() => Object.values(openFolders.value).some(Boolean));   // 有任一文件夹开着 → 按钮显示「收起全部」
const catLabel = (n) => (n === 'general' ? '未分类' : (n || ''));
const labelOf = (n) => n.folder_path || catLabel(n.category) || '';

// ---------- 页签 / 当前文档 ----------
const activeDoc = computed(() => (activeTab.value ? getDoc(activeTab.value.key) : null));
// 白板的新增卡片选择器要一份「所有笔记」清单，直接复用快速切换器已经加载的标题索引
const allTitles = computed(() => Array.from(titleIndex.value.values()));
const activeKind = computed(() => activeTab.value?.kind || '');
const activeNoteId = computed(() => activeDoc.value?.note?.id ?? activeTab.value?.noteId ?? null);
const headings = computed(() => extractHeadings(activeDoc.value?.note?.content || ''));

const editorRef = ref(null);
const shareOpen = ref(false);
const manageOpen = ref(false);
const folderModal = ref(false);
const propsModal = ref(false);
const imOpen = ref(false);   // IM连接（v1.10.5）
const blOpen = ref(false);   // 批量反链（v1.10.24）
const tplModal = ref(false);
const tplForm = ref({ id: null, name: '', content: '' });
const tplErr = ref('');
const propErr = ref('');
const newProp = ref({ key: '', label: '', type: 'text' });
const rightMode = ref('outline');

function makeDoc(n) {
  return {
    note: n,
    // v1.10.2 先改成「默认编辑态」，v1.10.3 又按用户后来的要求改回**默认预览**：
    // 打开先看渲染结果，想改就在预览正文上双击（NoteEditor 里挂的 dblclick）直接进编辑，
    // 进去时光标仍落在开头（makeState 的 selection:0，那是更早一版的需求，两者不冲突）。
    mode: 'preview',
    dirty: false,
    saving: false,
    savedAt: '',
    base: { title: n.title || '', content: n.content || '', props: JSON.stringify(n.props || {}) },
    links: { out: [], in: [], unresolved: [], unresolved_in: [] },
    shareStats: { link_count: 0, view_total: 0 },
  };
}

// 打一篇笔记的页签（录音笔记仍然跳到录音页，保持老行为）
// force=true 时不跳录音页：**只给「进页面时自动打开最近一篇」用**。否则最近改动的若是录音产生的笔记，
// 一进笔记页就被弹去录音页——用户看到的是「没打开笔记」，而不是「打开了最近那篇」。
async function openNoteTab(n, force = false) {
  if (!n) return;
  if (n.record_id && !force) { router.push(`/notes/rec/${n.record_id}`); return; }
  const id = Number(n.id ?? n);
  if (!Number.isFinite(id)) return;
  const t = openNote(id, n.title || '未命名');
  if (narrow.value) leftOpen.value = false;
  if (getDoc(t.key)) return;
  try {
    const full = await api.get(`/notes/${id}`);
    setDoc(t.key, makeDoc(full));
    patchByNoteId(id, { title: full.title || '未命名' });
    loadSide(t.key, id);
  } catch (e) { alert('打开失败：' + e.message); close(t.key); }
}
function openNoteById(id) { openNoteTab({ id }); }
function openHelpNote(payload) {
  const id = typeof payload === 'object' ? payload?.id : payload;
  if (id) openNoteById(Number(id));
}

async function loadSide(key, id) {
  const d = getDoc(key);
  if (!d || !id) return;
  try { d.links = await api.get(`/notes/${id}/backlinks`); } catch { /* 双链失败不挡编辑 */ }
  try {
    const s = await api.get(`/notes/shares/note/${id}`);
    d.shareStats = { link_count: s.link_count || 0, view_total: s.view_total || 0 };
  } catch { d.shareStats = { link_count: 0, view_total: 0 }; }
}
async function reloadShareStats() { if (activeTab.value?.noteId) loadSide(activeTab.value.key, activeTab.value.noteId); }

// 批量反链（v1.10.24）改的是一批笔记的正文：打开着的页签就地刷新（不重置预览/编辑态），
// 左栏列表/标签/统计跟上。**带未保存编辑的页签跳过**——别把用户正在写的东西冲掉。
async function onBacklinked(r) {
  const ids = new Set(((r && r.details) || []).map((d) => Number(d.id)).filter(Boolean));
  if (!ids.size) return;
  for (const t of tabs.value) {
    if (t.kind !== 'note' || !ids.has(Number(t.noteId))) continue;
    const d = getDoc(t.key);
    if (!d || d.dirty) continue;
    try {
      const full = await api.get(`/notes/${t.noteId}`);
      d.note.content = full.content;
      d.note.word_count = full.word_count;
      d.note.updated_at = full.updated_at;
      d.base = { title: full.title || '', content: full.content || '', props: JSON.stringify(full.props || {}) };
      loadSide(t.key, t.noteId);
    } catch { /* 单篇刷新失败不挡其余 */ }
  }
  reloadOpenFolders(); loadTags(); loadStats();
}

// ---------- 保存 ----------
let autoTimer = null;
// v1.12.6（用户需求④）：自动保存可关（头部「保存」旁边的开关，存档在 localStorage）。
// 关掉后只有手动保存 / Ctrl+S 落盘；离开笔记页时 onBeforeRouteLeave 的「还有没保存」确认仍兜底。
const autoSave = ref(localStorage.getItem('notes.autosave') !== '0');
function toggleAutosave() {
  autoSave.value = !autoSave.value;
  try { localStorage.setItem('notes.autosave', autoSave.value ? '1' : '0'); } catch { /* 忽略 */ }
  clearTimeout(autoTimer); autoTimer = null;
  // 刚重新打开自动保存：当前这篇若有未保存改动，立刻排一轮，别等下一次按键
  const t = activeTab.value; const d = t && getDoc(t.key);
  if (autoSave.value && t?.noteId && d
    && (d.note.content !== d.base.content || d.note.title !== d.base.title
      || JSON.stringify(d.note.props || {}) !== d.base.props)) scheduleAutosave(t.key);
}
function scheduleAutosave(key) {
  if (!autoSave.value) return;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => saveTab(key, true), 3000);
}

async function saveTab(key, silent = false) {
  const d = getDoc(key);
  const t = tabs.value.find((x) => x.key === key);
  if (!d || !t) return;
  // 上一轮还在路上又到了下一轮（保存期间用户继续打字 + 网络慢）：排到 3 秒后重试，
  // 否则这个 timer 白烧，期间的改动要等到下一次按键才会再触发保存
  if (d.saving) { if (silent && t.noteId) scheduleAutosave(key); return; }
  d.saving = true;
  try {
    const body = {
      title: d.note.title || '', content: d.note.content || '',
      folder_id: d.note.folder_id ?? null, props: d.note.props || {}, tags: d.note.tags,
    };
    let id = t.noteId;
    if (id) await api.put(`/notes/${id}`, body);
    else { const r = await api.post('/notes', body); id = Number(r.id); t.noteId = id; delete t.draft; }
    const full = await api.get(`/notes/${id}`);
    // v1.12.6（用户报障②③）：**不再** Object.assign(d, makeDoc(full)) 整个换掉 d.note。
    // 旧实现在 PUT+GET 两段网络延迟之后把 d.note 换成回包对象——保存期间用户又打/删的字
    // 比回包新，NoteEditor 的 watch 一看 note 换了对象、内容却比编辑器 doc 旧，就走
    // syncContent() 全量替换：删掉的整行「复活」（报障③）、光标被钳到旧文本长度上跳走（报障②）。
    // 现在 d.note 对象身份不变、title/content/props 保持本地最新值，只就地更新服务端派生字段；
    // 保存期间的新改动 local ≠ base → dirty 保持，下面排下一轮自动保存补上。
    d.note.id = id;
    if ((d.note.title || '') === (body.title || '')) d.note.title = full.title ?? d.note.title;
    if ((d.note.content || '') === (body.content || '')) d.note.content = full.content ?? d.note.content;
    if (JSON.stringify(d.note.props || {}) === JSON.stringify(body.props || {})) d.note.props = full.props ?? d.note.props;
    if (full.word_count != null) d.note.word_count = full.word_count;
    if (full.updated_at) d.note.updated_at = full.updated_at;
    if (Array.isArray(full.tags)) d.note.tags = full.tags;
    if (full.summary) { d.note.summary = full.summary; d.note.keywords = full.keywords; }
    // 草稿首次保存（POST）后 note 对象缺的展示字段就地补上（旧实现靠 makeDoc(full) 自然带进）
    if (full.created_at) d.note.created_at = full.created_at;
    if (full.folder_path != null) d.note.folder_path = full.folder_path;
    if (full.record_id != null) d.note.record_id = full.record_id;
    if (full.daily_date) d.note.daily_date = full.daily_date;
    // base = 服务端真身：保存期间有新改动的话 local ≠ base，dirty 重新点亮
    d.base = { title: full.title || '', content: full.content || '', props: JSON.stringify(full.props || {}) };
    d.savedAt = new Date().toTimeString().slice(0, 8);
    t.title = d.note.title || full.title || '未命名';
    const stillChanged = d.note.title !== d.base.title || d.note.content !== d.base.content
      || JSON.stringify(d.note.props || {}) !== d.base.props;
    setDirty(key, stillChanged);
    if (stillChanged && t.noteId) scheduleAutosave(key);
    // 标题/标签变了，树、列表、双链索引、统计都得跟着变
    titleIndex.value.set(String(full.title || '').trim(), { id, title: full.title });
    loadSide(key, id);
    reloadFolders(true);
    loadTags();
    if (section.value === 'files') reloadOpenFolders();
    if (!silent) { /* 手动保存也给同样的反馈 */ }
  } catch (e) {
    if (!silent) alert('保存失败：' + e.message);
    else d.savedAt = '';
  } finally { d.saving = false; }
}

// 改动 → 脏标记 + 自动保存（草稿不自动存：还没有 id）
watch(
  () => {
    const d = activeDoc.value;
    return d ? `${activeKey.value}|${d.note.title}|${d.note.content}|${JSON.stringify(d.note.props || {})}` : '';
  },
  () => {
    const d = activeDoc.value;
    const t = activeTab.value;
    if (!d || !t) return;
    const changed = d.note.title !== d.base.title || d.note.content !== d.base.content
      || JSON.stringify(d.note.props || {}) !== d.base.props;
    setDirty(t.key, changed);
    if (t.title !== (d.note.title || '未命名')) t.title = d.note.title || '未命名';
    if (changed && t.noteId) scheduleAutosave(t.key);
  }
);

function newNote(title) {
  const t = openDraft(title || '');
  setDoc(t.key, makeDoc({ title: title || '', content: '', props: {}, folder_id: section.value === 'files' ? null : null }));
  if (narrow.value) leftOpen.value = false;
  nextTick(() => editorRef.value?.focus());
}
function onTabClosed(t) { if (t?.kind === 'note') { /* 文档已随页签释放 */ } }
function openRec(r) { router.push(`/notes/rec/${r.id}`); }
function newRec() { router.push('/notes/rec/'); }

async function delNote() {
  const d = activeDoc.value; const t = activeTab.value;
  if (!d || !t?.noteId) { close(t?.key); return; }
  if (!confirm('确认删除这篇笔记？')) return;
  try { await api.del(`/notes/${t.noteId}`); } catch (e) { alert('删除失败：' + e.message); return; }
  const id = t.noteId;
  closeNote(id);
  titleIndex.value.forEach((v, k) => { if (v.id === id) titleIndex.value.delete(k); });
  reloadFolders(true); loadTags(); loadBookmarks();
}

function moveActive(fid) {
  const d = activeDoc.value; const t = activeTab.value;
  if (!d) return;
  d.note.folder_id = fid;
  const f = flatFolders.value.find((x) => x.id === fid);
  d.note.folder_path = f ? f.path : '';
  d.dirty = true;
  setDirty(t.key, true);
  if (t.noteId) saveTab(t.key, true); else { /* 草稿：保存时一起写 */ }
  reloadFolders(true);
}
function openRecordPage() {
  const rid = activeDoc.value?.note?.record_id;
  if (rid) router.push(`/notes/rec/${rid}`);
}
function setProp(k, v) {
  const d = activeDoc.value;
  if (!d) return;
  d.note.props = { ...(d.note.props || {}), [k]: v };
}
function goHeading(i) { editorRef.value?.scrollToHeading(i); }

// ---------- 文件夹 ----------
async function reloadFolders(silent) {
  try { folderTree.value = await api.get('/notes/folders'); }
  catch (e) { if (!silent) alert('读取文件夹失败：' + e.message); }
  if (silent) reloadOpenFolders();
}
function persistOpen() { try { localStorage.setItem('notes.openFolders', JSON.stringify({ v: 2, open: openFolders.value })); } catch { /* 忽略 */ } }
async function toggleFolder(f) {
  openFolders.value[f.id] = !openFolders.value[f.id];
  persistOpen();
  if (openFolders.value[f.id]) await loadFolderNotes(f.id);
}
async function loadFolderNotes(fid) {
  loadingNotes.value = true;
  try { notesByFolder.value[fid] = await api.get(`/notes?lean=1&limit=500&folder_id=${fid}`); }
  catch { notesByFolder.value[fid] = []; }
  finally { loadingNotes.value = false; }
}
function reloadOpenFolders() {
  for (const [id, on] of Object.entries(openFolders.value)) if (on) loadFolderNotes(Number(id));
}
// 收起/展开全部（v1.10.24）：按钮文案随状态切换。展开 = 全部顶层（子级保持各自存档的展开状态）。
// 旧版「收起全部」常量 disabled：它要求**所有层级**（含每个子文件夹）都展开才可点，
// 而自动展开只铺顶层——按钮于是从来没生效过。
function toggleFolders() {
  if (anyFolderOpen.value) {
    openFolders.value = {};
  } else {
    for (const f of folderTree.value) { openFolders.value[f.id] = true; loadFolderNotes(f.id); }
  }
  persistOpen();
}
async function newFolder(parentId) {
  const name = prompt('新文件夹名称' + (parentId ? '（将建在选中的文件夹里）' : ''));
  if (!name || !name.trim()) return;
  try {
    const r = await api.post('/notes/folders', { name: name.trim(), parent_id: parentId || null });
    await reloadFolders(true);
    if (parentId) { openFolders.value[parentId] = true; persistOpen(); loadFolderNotes(parentId); }
  } catch (e) { alert('新建失败：' + e.message); }
}
async function moveNote(noteId, folderId) {
  try { await api.put(`/notes/${noteId}/move`, { folder_id: folderId }); }
  catch (e) { alert('移动失败：' + e.message); }
  const d = getDoc(activeTab.value?.key);
  if (d && d.note.id === noteId) {
    d.note.folder_id = folderId;
    const f = flatFolders.value.find((x) => x.id === folderId);
    d.note.folder_path = f ? f.path : '';
  }
  reloadFolders(true); loadFolderNotes(folderId);
}
async function moveFolder(id, parentId) {
  try { await api.put(`/notes/folders/${id}`, { parent_id: parentId }); }
  catch (e) { alert('移动失败：' + e.message); }
  reloadFolders(true);
}

// ---------- 标签 / 书签 / 模板 / 属性 ----------
async function loadTags() { try { tags.value = await api.get('/notes/tags'); } catch { tags.value = []; } }
async function loadBookmarks() { try { bookmarks.value = await api.get('/notes/bookmarks'); } catch { bookmarks.value = []; } }
async function delBookmark(b) {
  if (b.kind !== 'note' || !b.note_id) return;
  try { await api.put(`/notes/${b.note_id}/bookmark`, { on: false, kind: b.kind, anchor: b.anchor || '' }); } catch { /* 忽略 */ }
  loadBookmarks();
}
function openBookmark(b) {
  if (b.note_id) openNoteById(Number(b.note_id));
}
async function loadTemplates() { try { templates.value = await api.get('/notes/templates'); } catch { templates.value = []; } }
async function loadProps() { try { propDefs.value = await api.get('/notes/properties'); } catch { propDefs.value = []; } }
async function loadStats() { try { stats.value = await api.get('/notes/stats'); } catch { stats.value = {}; } }

function editTemplate(t) { tplErr.value = ''; tplForm.value = t ? { id: t.id, name: t.name, content: t.content || '' } : { id: null, name: '', content: '' }; tplModal.value = true; }
async function saveTemplate() {
  const f = tplForm.value;
  if (!f.name.trim()) { tplErr.value = '模板名不能为空'; return; }
  try {
    if (f.id) await api.put(`/notes/templates/${f.id}`, { name: f.name.trim(), content: f.content });
    else await api.post('/notes/templates', { name: f.name.trim(), content: f.content });
    tplModal.value = false;
    loadTemplates();
  } catch (e) { tplErr.value = e.message; }
}
async function delTemplate(t) {
  if (!confirm(`删除模板「${t.name}」？`)) return;
  try { await api.del(`/notes/templates/${t.id}`); } catch (e) { alert(e.message); }
  loadTemplates();
}
async function useTemplate(t) {
  try {
    const r = await api.post('/notes/from-template', { template_id: t.id });
    await openNoteTab({ id: Number(r.id) });
  } catch (e) { alert('从模板新建失败：' + e.message); }
}
async function addProp() {
  propErr.value = '';
  const p = newProp.value;
  if (!p.key.trim()) { propErr.value = '键名不能为空'; return; }
  try {
    await api.post('/notes/properties', { key: p.key.trim(), label: p.label.trim(), type: p.type });
    newProp.value = { key: '', label: '', type: 'text' };
    loadProps();
  } catch (e) { propErr.value = e.message; }
}
async function delProp(d) {
  if (!confirm(`删除属性「${d.label || d.key}」？笔记里已填的值会保留。`)) return;
  try { await api.del(`/notes/properties/${d.id}`); } catch (e) { alert(e.message); }
  loadProps();
}

// ---------- 搜索 ----------
async function runSearch({ mode, q } = {}) {
  const m = mode || searchMode.value;
  const kw = q === undefined ? searchQ.value : q;
  searchMode.value = m; searchQ.value = kw;
  section.value = 'search';
  try {
    const d = await api.get(`/notes/search?mode=${encodeURIComponent(m)}&q=${encodeURIComponent(kw)}`);
    list.value = d.rows || [];
    searchRan.value = true;
  } catch (e) { list.value = []; searchRan.value = true; alert('搜索失败：' + e.message); }
}
function clearSearch() { searchQ.value = ''; searchRan.value = false; list.value = []; }
function filterByTag(tag) { searchMode.value = 'tag'; searchQ.value = tag; runSearch({ mode: 'tag', q: tag }); }

// ---------- 录音 ----------
async function loadRecs() {
  try {
    const d = await api.get('/vibe/records?pageSize=100');
    recs.value = (d.rows || []).filter((r) => r.from_notes);
  } catch { recs.value = []; }
}

// ---------- 每日笔记 / 视图页签 ----------
async function openDaily() {
  try {
    const r = await api.post('/notes/daily', {});
    await openNoteTab({ id: Number(r.note?.id || r.id), title: r.note?.title });
    refreshAfterDaily();
  } catch (e) { alert('打开今日笔记失败：' + e.message); }
}
function refreshAfterDaily() { reloadFolders(true); loadStats(); }

const VIEW_LABEL = { graph: '🕸 知识图谱', timeline: '🕒 时间线', query: '🗃 数据库', board: '🧩 白板', help: '❓ 使用说明', stats: '📊 统计' };
function openView(kind) {
  if (kind === 'help') { rightMode.value = 'help'; }
  openUnique(kind, { title: VIEW_LABEL[kind] || kind });
  if (narrow.value) leftOpen.value = false;
}

// ---------- 双链解析 ----------
let titlesLoaded = false;
async function loadTitles() {
  try {
    const rows = await api.get('/notes/titles');
    const m = new Map();
    for (const r of rows) { const k = String(r.title || '').trim(); if (k && !m.has(k)) m.set(k, { id: Number(r.id), title: r.title }); }
    titleIndex.value = m; titlesLoaded = true;
  } catch { /* 双链降级成「都是未命中」，不影响编辑 */ }
}
function resolveWiki(title) { return titleIndex.value.get(String(title || '').trim()) || null; }

// ---------- 快速切换器 / 命令面板 ----------
const switcherOpen = ref(false);
const swQ = ref('');
const swIdx = ref(0);
const swInput = ref(null);
const swResults = computed(() => fuzzyFilter(swQ.value, Array.from(titleIndex.value.values()), { key: 'title', limit: 40 })
  .map((r) => ({ ...r.item, idx: r.idx })));
function hl(text, idx) { return highlight(String(text || ''), idx || []); }
function openSwitcher() { switcherOpen.value = true; swQ.value = ''; swIdx.value = 0; nextTick(() => swInput.value?.focus()); }
function swMove(d) { const n = swResults.value.length; if (!n) return; swIdx.value = (swIdx.value + d + n) % n; }
function swPick(i) {
  const k = i === undefined ? swIdx.value : i;
  const r = swResults.value[k];
  switcherOpen.value = false;
  if (r) openNoteById(r.id); else swCreate();
}
async function swCreate() {
  const t = swQ.value.trim();
  switcherOpen.value = false;
  if (!t) return;
  newNote(t);
}

const paletteOpen = ref(false);
const palQ = ref('');
const palIdx = ref(0);
const palInput = ref(null);
// 只列**拦得住**的组合键：Ctrl+N / Ctrl+W 是浏览器窗口级的，preventDefault 无效，
// 挂上去只会让用户顺手关掉整个工作台，所以改用 Alt+N，闭合页签交给命令面板和页签上的 ×。
const COMMANDS = [
  { t: '新建笔记', key: 'n', alt: true, run: () => newNote() },
  { t: '打开今日笔记', key: 'p', ctrl: true, run: () => openDaily() },
  { t: '快速切换笔记', key: 'o', ctrl: true, run: () => openSwitcher() },
  { t: '保存当前笔记', key: 's', ctrl: true, run: () => activeTab.value && saveTab(activeTab.value.key) },
  { t: '关闭当前页签', run: () => activeTab.value && close(activeTab.value.key) },
  { t: '切换 编辑 / 分屏 / 预览 / 源码', run: () => { const d = activeDoc.value; if (!d) return; const NEXT = { edit: 'split', split: 'preview', preview: 'source', source: 'edit' }; d.mode = NEXT[d.mode] || 'edit'; } },
  { t: '知识图谱', run: () => openView('graph') },
  { t: '时间线', run: () => openView('timeline') },
  { t: '数据库查询', run: () => openView('query') },
  { t: '白板', run: () => openView('board') },
  { t: '统计', run: () => openView('stats') },
  { t: '使用说明', run: () => openView('help') },
  { t: '文件夹管理', run: () => { folderModal.value = true; } },
  { t: '笔记属性定义', run: () => { propsModal.value = true; } },
  { t: '新建模板', run: () => editTemplate(null) },
  { t: '下载当前笔记 Markdown', run: () => activeDoc.value && downloadNoteMd(activeDoc.value.note) },
  { t: '下载当前笔记 HTML', run: () => activeDoc.value && downloadNoteHtml(activeDoc.value.note, catLabel) },
];
const palResults = computed(() => fuzzyFilter(palQ.value, COMMANDS, { key: 't', limit: 30 }).map((r) => r.item));
function openPalette() { paletteOpen.value = true; palQ.value = ''; palIdx.value = 0; nextTick(() => palInput.value?.focus()); }
function palMove(d) { const n = palResults.value.length; if (!n) return; palIdx.value = (palIdx.value + d + n) % n; }
function palRun(i) { const c = palResults.value[i === undefined ? palIdx.value : i]; if (!c) return; paletteOpen.value = false; c.run(); }

// ---------- 快捷键（只在笔记页挂载期间生效） ----------
useShortcut({ key: 'o', ctrl: true, description: '快速切换笔记', handler: openSwitcher });
useShortcut({ key: 'p', ctrl: true, description: '打开今日笔记', handler: openDaily });
useShortcut({ key: 'p', ctrl: true, shift: true, description: '命令面板', handler: openPalette });
useShortcut({ key: 'n', alt: true, description: '新建笔记', handler: () => newNote() });
useShortcut({ key: 's', ctrl: true, allowInField: true, description: '保存当前笔记', handler: () => activeTab.value && saveTab(activeTab.value.key) });
useShortcut({ key: 'f', ctrl: true, allowInField: true, description: '搜索笔记', handler: () => { section.value = 'search'; } });

// ---------- 路由 query（?note= / ?newtitle= / ?rec=1） ----------
async function handleQuery() {
  const q = route.query;
  if (q.rec) { openUnique('rec', { title: '🎙 录音' }); section.value = 'recs'; loadRecs(); }
  if (q.note) await openNoteTab({ id: Number(q.note) });
  else if (q.newtitle) newNote(String(q.newtitle));
}
watch(() => route.query, handleQuery);
onBeforeRouteLeave(() => {
  if (!hasDirty()) return true;
  return confirm('还有没保存的笔记，确定离开？');
});

// ---------- 初始化 ----------
onMounted(async () => {
  await Promise.all([reloadFolders(true), loadTitles(), loadTags(), loadBookmarks(), loadTemplates(), loadProps(), loadStats(), loadRecs()]);
  external.value = await loadExternalBase();
  try { list.value = await api.get('/notes?lean=1&limit=200'); } catch { list.value = []; }
  // v1.10.24：默认**收起**，只把「最近编辑的那篇」所在的文件夹链路（含所有上级）展开 ——
  // 刚写的东西在树上找得到，其余目录不再每次进页面全部铺开（老版是强制展开全部顶层，
  // 用户收起过的状态也会被盖掉，「收起全部」按完下次进来又全开）。
  const byId = new Map(flatFolders.value.map((f) => [f.id, f]));
  const last = (list.value || [])[0];
  for (let f = last && last.folder_id != null ? byId.get(Number(last.folder_id)) : null, guard = 0;
       f && guard++ < 64; f = f.parent_id == null ? null : byId.get(Number(f.parent_id))) {
    if (!openFolders.value[f.id]) { openFolders.value[f.id] = true; loadFolderNotes(f.id); }
  }
  persistOpen();
  await handleQuery();
  if (!activeTab.value) {
    // 打开最近修改的那一篇：list 是 /notes 的返回，服务端已按 updated_at DESC 排序，取第一条即可。
    // force=true —— 就算它是录音产生的笔记也在笔记页打开，不弹去录音页（见 openNoteTab 注释）。
    const first = list.value[0];
    if (first) await openNoteTab(first, true);
  }
});
defineExpose({ handleQuery });
</script>

<style scoped>
/* 高度 = 视口 − .main 的上下内边距（22+60）：正好铺满一屏而不顶出页面滚动条 */
.nshell { display: flex; flex-direction: column; height: calc(100vh - 82px); min-height: 420px; position: relative; }
@media (max-width: 900px) { .nshell { height: calc(100vh - 170px); } }
.ns-top { display: flex; align-items: flex-end; gap: 8px; }
.ns-top-act { display: flex; gap: 4px; margin-left: auto; padding-bottom: 3px; }
.ns-body { display: flex; flex: 1; min-height: 0; padding-top: 6px; position: relative; }
.ns-pane { min-width: 0; min-height: 0; }
.ns-left { display: flex; flex-direction: column; border-right: 1px solid var(--border); padding-right: 8px; overflow: hidden; }
.ns-right { border-left: 1px solid var(--border); padding-left: 8px; overflow: hidden; }
.ns-center { flex: 1; display: flex; flex-direction: column; padding: 0 8px; overflow: hidden; }
.placeholder { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; color: var(--text3); }
.ph-t { font-size: 15px; color: var(--text2); }
.sumbox { margin-top: 8px; background: var(--bg3); border-radius: 8px; padding: 8px 10px; font-size: 13px; }
.swlist { max-height: 50vh; overflow-y: auto; }
.swrow { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 6px; cursor: pointer; font-size: 13px; }
.swrow .nm { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.swrow.on { background: var(--bg3); }
.swrow :deep(mark) { background: var(--amber); color: #000; border-radius: 2px; }
/* 遮罩贴在 .ns-body 上（不是视口）：只盖正文区，顶栏的 ☰ 与其它按钮在抽屉打开时依然可点。
   z-index 7 要**高于两个浮动面板（6）**：1.10.2 上线后点检发现，窄屏下左抽屉（78vw）+ 右面板
   正好铺满整屏，遮罩在 6 下面一点都露不出来 —— 于是「点空白处关抽屉」也做不到，
   只剩刷新页面一条路。抬到面板之上，抽屉本身（8）再抬到遮罩之上，两个关闭手势就都通了。 */
.ns-scrim { position: absolute; inset: 0; background: rgba(0,0,0,.4); z-index: 7; }
.narrow .ns-left { position: fixed; top: 60px; bottom: 0; left: 0; z-index: 8; background: var(--bg); padding: 8px; box-shadow: 0 0 24px rgba(0,0,0,.4); }
.narrow .ns-right { position: fixed; top: 60px; bottom: 0; right: 0; z-index: 6; background: var(--bg); padding: 8px; box-shadow: 0 0 24px rgba(0,0,0,.4); }
</style>

<style>
/* 笔记壳要三栏，1200px 的正文栏宽会把中间挤没 —— 只在笔记页放开页面宽度上限。
   用非 scoped 块是因为要改的是外层 .main，scoped 样式到不了那里；类名由外壳挂载时挂到 body。 */
body.notes-shell .main { max-width: none; }
</style>
