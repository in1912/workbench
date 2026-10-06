<template>
  <div class="editor" :class="{ empty: !note }">
    <MarkdownToolbar v-if="note" :get-textarea="() => taShim" :busy="uploading > 0" @image="pickImage">
      <span class="muted" style="font-size:11.5px; white-space:nowrap">{{ words }} 字</span>
      <div class="modes">
        <button v-for="m in MODES" :key="m.k" class="mbtn" :class="{ on: mode === m.k }" :title="m.title"
                @click="$emit('update:mode', m.k)">{{ m.t }}</button>
      </div>
    </MarkdownToolbar>

    <div v-if="note" class="body" :class="mode">
      <div v-show="mode !== 'preview'" ref="hostEl" class="cm-wrap" />
      <div v-show="showPreview" ref="previewEl" class="markdown-body preview" v-html="rendered"
           :title="mode === 'preview' ? '双击正文即可编辑这一篇' : ''"
           @click="onPreviewClick" @dblclick="onPreviewDblClick" />
    </div>
    <div v-else class="empty-hint">选择或新建一篇笔记</div>
    <!-- 工具栏 🖼 的文件选择框（v1.10.33）：隐藏的常驻 input，选完即清 value，同一文件可重复插入。
         不限 accept：图片插 ![]()、其他文件插 []() 下载链接，后端 note_attachments 本就收任意文件 -->
    <input ref="fileEl" type="file" multiple hidden @change="onFiles">
  </div>
</template>

<script setup>
// 编辑器（v1.10.2）：CodeMirror 6 + 编辑 / 分屏 / 预览 / 源码 四态。
//
// 为什么从 textarea 换过来：① 编辑时就能看见语法配色（需求②）；② 键入 [[ 直接列出历史笔记标题
// （需求④）；③ 长文的光标 / 滚动 / 撤销栈比 textarea 稳。
// MarkdownToolbar **一行没改** —— 它拿到的是一个「长得像 textarea」的适配器（taShim）：
// value / selectionStart / setSelectionRange / focus / dispatchEvent 都照旧能用。
//
// 一条纪律：**不要**把 props.note 的整体 identity 当重建信号。自动保存后外壳会把 d.note 换成
// 一个新对象（内容一模一样），那时重建 EditorView 会把光标弹回开头 —— 用户正在打字，当场炸。
// 所以只有「页签 key 变了」（切到另一篇）才重建；同一篇下内容对不上（AI 整篇替换 / 服务端规范化）
// 走不动光标的原地同步。
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, drawSelection, dropCursor, highlightSpecialChars, placeholder as cmPlaceholder } from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, indentWithTab } from '@codemirror/commands';
import { indentOnInput, bracketMatching } from '@codemirror/language';
import { autocompletion, completionKeymap, startCompletion } from '@codemirror/autocomplete';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { cmBaseTheme, cmSyntax, codeLanguages } from '../../utils/codeTheme';
import MarkdownToolbar from './MarkdownToolbar.vue';
import { renderMarkdown, wordCount } from '../../utils/markdown';
import { htmlToMarkdown } from '../../utils/htmlToMd';
import { api } from '../../api';

const props = defineProps({
  note: { type: Object, default: null },
  mode: { type: String, default: 'edit' },
  resolveWiki: { type: Function, default: () => null },
  // 已有笔记的标题（快速切换器那份索引），给 [[ 的补全用
  titles: { type: Array, default: () => [] },
  // 页签 key：同一篇笔记从草稿变成已保存时 key 不变，用它判断「是不是换了一篇」
  docKey: { type: String, default: '' },
});
const emit = defineEmits(['update:mode', 'open-note', 'new-note', 'save']);

const MODES = [
  { k: 'edit', t: '编辑', title: '只看正文（带语法配色）' },
  { k: 'split', t: '分屏', title: '左边写、右边看' },
  { k: 'preview', t: '预览', title: '只看渲染结果' },
  { k: 'source', t: '源码', title: '代码预览：只看带配色的 Markdown 源文，只读不可编辑' },
];

const hostEl = ref(null);
const previewEl = ref(null);
const words = computed(() => wordCount(props.note?.content || ''));
const rendered = computed(() => renderMarkdown(props.note?.content || '', { resolveWiki: props.resolveWiki }));
const showPreview = computed(() => props.mode === 'split' || props.mode === 'preview');

let view = null;
let loadedKey = null;
const editableComp = new Compartment();   // 只读态（源码模式）靠它切换，不用重建 EditorView
const readOnlyComp = new Compartment();

const titleList = computed(() => props.titles
  .map((t) => (typeof t === 'string' ? t : t && t.title))
  .map((t) => String(t || '').trim())
  .filter(Boolean));

// 输入 [[ 之后的补全源：只列已有标题，不猜、不自动选第一条（标题多时误选比多打一个字更烦）
function wikiSource(ctx) {
  const before = ctx.matchBefore(/\[\[[^\]\n]*$/);
  if (!before) return null;
  const list = titleList.value;
  if (!list.length) return null;
  const from = before.from + 2;
  return {
    from,
    options: list.map((t) => ({ label: t, type: 'text' })),
    validFor: /^[^\]\n]*$/,
  };
}

// 选中标题后补上收尾的 ]]，但用户自己已经打了一半就不要重复
function applyWiki(v, completion, from, to) {
  const tail = v.state.sliceDoc(to, to + 2) === ']]' ? '' : ']]';
  const insert = completion.label + tail;
  v.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    userEvent: 'input.complete',
  });
}

function buildExtensions() {
  const ro = props.mode === 'source';
  return [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    // 代码块（```js 这种）按信息串动态加载对应语言的解析器，见 utils/codeTheme.js 的语言表
    markdown({ base: markdownLanguage, codeLanguages }),
    autocompletion({ override: [wikiSource], icons: false }),
    cmPlaceholder('支持 Markdown；用 [[另一篇笔记的标题]] 建立双链（键入 [[ 会列出历史标题），#标签 归类'),
    cmBaseTheme,
    cmSyntax,
    editableComp.of(EditorView.editable.of(!ro)),
    readOnlyComp.of(EditorState.readOnly.of(ro)),
    keymap.of([
      { key: 'Mod-s', preventDefault: true, run: () => { emit('save'); return true; } },
      ...completionKeymap,
      ...defaultKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged && props.note) props.note.content = u.state.doc.toString();
    }),
  ];
}

function makeState(content) {
  return EditorState.create({
    doc: content || '',
    selection: { anchor: 0 },   // 需求①：光标永远落在开头，不是文末
    extensions: buildExtensions(),
  });
}

function createView() {
  if (view || !hostEl.value) return;
  view = new EditorView({ state: makeState(props.note?.content), parent: hostEl.value });
  // 富文本粘贴（v1.11.6）：捕获相位，必须跑在 CM 自己的 contentDOM 处理器之前（见 onPaste 注释）
  view.dom.addEventListener('paste', onPaste, true);
  view.scrollDOM.scrollTop = 0;
  applyMode(props.mode);
  view.focus();
}

function destroyView() {
  if (view) { view.dom.removeEventListener('paste', onPaste, true); view.destroy(); view = null; }
}

// 换了一篇：整个 state 重来（撤销栈也翻篇，不会把上一篇的编辑退回来）
function reloadDoc() {
  if (!view) { createView(); return; }
  view.setState(makeState(props.note?.content));
  view.scrollDOM.scrollTop = 0;
  applyMode(props.mode);
  view.focus();
}

// 同一篇、但内容与编辑器对不上（AI 整篇替换、服务端规范化）：原地换掉，光标尽量保住
function syncContent(text) {
  if (!view) return;
  const sel = view.state.selection.main;
  const len = view.state.doc.length;
  const next = String(text || '');
  view.dispatch({
    changes: { from: 0, to: len, insert: next },
    selection: { anchor: Math.min(sel.anchor, next.length), head: Math.min(sel.head, next.length) },
  });
}

const keyOf = () => props.docKey || (props.note && props.note.id != null ? 'n' + props.note.id : '');

watch(() => props.note, async () => {
  if (!props.note) { destroyView(); loadedKey = null; return; }
  await nextTick();
  if (!hostEl.value) return;
  const k = keyOf();
  if (!view) { createView(); loadedKey = k; return; }
  if (k && k !== loadedKey) { loadedKey = k; reloadDoc(); return; }
  if ((props.note.content || '') !== view.state.doc.toString()) syncContent(props.note.content);
}, { immediate: true });

function applyMode(m) {
  if (!view) return;
  const ro = m === 'source';
  view.dispatch({ effects: [
    editableComp.reconfigure(EditorView.editable.of(!ro)),
    readOnlyComp.reconfigure(EditorState.readOnly.of(ro)),
  ] });
}

watch(() => props.mode, async (m) => {
  applyMode(m);
  if (!view || m === 'preview') return;
  // 刚从 display:none 里出来，量一次真实尺寸，否则长文的换行位置会算错
  await nextTick();
  view.requestMeasure();
  if (m !== 'split') view.focus();
});

onBeforeUnmount(destroyView);

// ---------- 预览 ----------
// 预览里点双链：命中的开页签，未命中的带着标题去新建（与老版一致）
function onPreviewClick(e) {
  const a = e.target.closest?.('a');
  if (!a) return;
  const miss = a.dataset.wikiNew;
  if (miss) { e.preventDefault(); emit('new-note', miss); return; }
  const hit = a.dataset.wikiNote;
  if (hit) { e.preventDefault(); emit('open-note', Number(hit)); return; }
}

// 需求（v1.10.3）：默认展示是预览页，**在预览正文上双击直接进编辑**。
// 落在链接上的双击交给单击那条路（点链接是「跳过去」，不该顺手把当前这篇切进编辑态）。
function onPreviewDblClick(e) {
  if (e.target.closest?.('a')) return;
  if (props.mode === 'preview') emit('update:mode', 'edit');
}

defineExpose({ scrollToHeading, insertText, replaceText, focus });

// ---------- 给 MarkdownToolbar 的 textarea 适配器 ----------
// 工具栏只会做四件事：读 value / 写 value / 读 selectionStart,selectionEnd / 写完派发 input 事件。
const taShim = {
  get value() { return view ? view.state.doc.toString() : (props.note?.content || ''); },
  set value(v) {
    if (!view) return;
    const cur = view.state.doc.toString();
    if (cur === v) return;
    view.dispatch({ changes: { from: 0, to: cur.length, insert: String(v ?? '') } });
  },
  get selectionStart() { return view ? Math.min(view.state.selection.main.from, view.state.selection.main.to) : 0; },
  get selectionEnd() { return view ? Math.max(view.state.selection.main.from, view.state.selection.main.to) : 0; },
  focus() { view?.focus(); },
  setSelectionRange(a, b) {
    if (!view) return;
    view.dispatch({ selection: { anchor: a, head: b === undefined ? a : b } });
    // 点工具栏的「[[ ]]」按钮后，光标前正好是 [[ —— 顺手把历史标题的选择框弹出来（需求④）
    if (a >= 2 && view.state.sliceDoc(a - 2, a) === '[[') startCompletion(view);
  },
  // 工具栏写完 value 已经产生了一次 CM 事务（内容已回写到 note.content），这里不用再做什么
  dispatchEvent() {},
};

// ---------- AI 回填 ----------
// 都走 CM 的 dispatch，撤销栈（Ctrl+Z）还能正常回退
async function insertText(text) {
  const s = String(text || '');
  if (!s) return;
  await ensureEditable();
  if (!view) return;
  const { from, to } = view.state.selection.main;
  const sep = from > 0 && !/\n$/.test(view.state.sliceDoc(0, from)) ? '\n\n' : '';
  view.dispatch({
    changes: { from, to, insert: sep + s },
    selection: { anchor: from + sep.length + s.length },
    effects: EditorView.scrollIntoView(from + sep.length + s.length, { y: 'nearest' }),
  });
  view.focus();
}

async function replaceText(text) {
  await ensureEditable();
  if (!view) return;
  const next = String(text || '');
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: next },
    selection: { anchor: next.length },
  });
  view.focus();
}

function focus() { try { view?.focus(); } catch { /* 忽略 */ } }

// 预览 / 源码模式都不是「能编辑的正文」，先切回能编辑的那一态
async function ensureEditable() {
  if (props.mode === 'preview') { emit('update:mode', 'split'); await nextTick(); applyMode(props.mode); }
  else if (props.mode === 'source') { emit('update:mode', 'edit'); await nextTick(); applyMode(props.mode); }
}

// ---------- 插入图片 / 附件（v1.10.33）----------
// 工具栏 🖼 的链路此前从未接通（事件转发到外壳却没人监听，点了没反应），本版在编辑器内部闭环：
// 选文件 → POST /notes/attachments（后端 multer 10MB 上限）→ 光标处插入 ![文件名](直链)。
// 正文里存裸路径 /api/notes/attachments/<id>/raw，预览由 renderMarkdown 统一补登录态（?token=）。
const fileEl = ref(null);
const uploading = ref(0);
function pickImage() { if (!uploading.value) fileEl.value?.click(); }
async function onFiles(e) {
  const files = [...(e.target.files || [])];
  e.target.value = ''; // 清掉选择，同一文件可重复插入
  for (const f of files) await uploadAndInsert(f);
}

// 单文件上传 + 插入（工具栏选文件 / 粘贴截图文件 / 富文本里的 data:URI 图共用）
async function uploadAndInsert(f) {
  uploading.value++;
  try {
    const r = await api.upload('/notes/attachments',
      { note_id: props.note && props.note.id != null ? String(props.note.id) : '' },
      [{ name: 'file', file: f }]);
    const alt = String(f.name || '附件').replace(/[[\]\n]/g, ' ').trim() || '附件';
    await insertText(/^image\//.test(f.type) ? `![${alt}](${r.url})` : `[${alt}](${r.url})`);
  } catch (err) {
    alert('「' + (f.name || '文件') + '」上传失败：' + err.message);
  }
  uploading.value--;
}

// ---------- 粘贴富文本 / 截图（v1.11.6）----------
// 从网页复制带图文章 → 直接 Ctrl+V：text/html 转成 Markdown 插入，图片全部转存成
// 自己的附件直链（data:URI 走本地上传端点；远程 URL 浏览器直拉会撞 CORS，交服务端
// POST /notes/attachments/from-url 代取）。一条都不满足就放行浏览器默认粘贴。
// ⚠️ 必须挂在 view.dom 的**捕获相位**（createView 里第三个参数 true）：CodeMirror 自己
// 在 contentDOM 上处理 paste——会把 text/plain 同步插进文档再 preventDefault，冒泡监听
// 跑不过它，结果「转换后的 Markdown」和「剪贴板纯文本」各插一份。劫持时 stopPropagation
// 让 CM 根本看不到这个事件；不劫持的分支什么都不动，CM 照旧。
// 两条 guard：① 源码模式只读，自定义插入会绕过只读态 → 放行；② CodeMirror 自己复制
// 的剪贴板里也有 text/html（带 cm-line/cm-editor/cm-content class 的语法高亮 HTML），
// 照转会把代码块缩进搅乱 → 认出来放行走默认，text/plain 原文进编辑器。
function onPaste(e) {
  if (!view || !props.note || props.mode === 'source') return;
  const dt = e.clipboardData;
  if (!dt) return;
  const imgs = [...(dt.files || [])].filter((f) => /^image\//.test(f.type));
  if (imgs.length) {
    e.preventDefault(); e.stopPropagation();
    void (async () => { for (const f of imgs) await uploadAndInsert(f); })();
    return;
  }
  const html = (dt.getData('text/html') || '').trim();
  if (html && html.length > 30 && !/cm-(?:line|content|editor)/.test(html)) {
    e.preventDefault(); e.stopPropagation();
    void pasteRich(html, dt.getData('text/plain') || '');
  }
}

async function pasteRich(html, plain) {
  uploading.value++;
  try {
    const md = await htmlToMarkdown(html, { resolveImage: resolvePastedImage });
    if (md && md.trim()) await insertText(md);
    else if (plain) await insertText(plain);
  } catch (err) {
    if (plain) await insertText(plain);   // 转换炸了也别把用户的东西丢掉
    alert('富文本粘贴转换失败，已按纯文本插入：' + (err && err.message ? err.message : err));
  }
  uploading.value--;
}

// htmlToMarkdown 拿到 <img> 时来问「最终地址用哪个」；返回 null = 保留原地址
async function resolvePastedImage({ src, alt }) {
  try {
    if (/^data:image\//i.test(src)) {
      const blob = await (await fetch(src)).blob();
      const f = new File([blob], dataUriName(src, alt), { type: blob.type || 'image/png' });
      const r = await api.upload('/notes/attachments',
        { note_id: props.note && props.note.id != null ? String(props.note.id) : '' },
        [{ name: 'file', file: f }]);
      return r.url;
    }
    if (/^https?:\/\//i.test(src)) {
      const r = await api.post('/notes/attachments/from-url',
        { url: src, note_id: props.note && props.note.id != null ? String(props.note.id) : '' });
      return r.url;
    }
  } catch { return null; }   // 转存失败不拦整篇粘贴，正文里保留原地址
  return null;
}

// data:URI 图的文件名：alt 能用就用 alt，扩展名从 MIME 推
function dataUriName(src, alt) {
  const m = /^data:image\/([\w.+-]+)\s*[;,]/i.exec(src);
  const ext = ({ jpeg: 'jpg', 'svg+xml': 'svg' })[m ? m[1].toLowerCase() : ''] || (m ? m[1].toLowerCase() : 'png');
  const base = String(alt || '').replace(/[\\/:*?"<>|\r\n/[\]]/g, ' ').trim().slice(0, 40);
  return (base || '粘贴的图片') + '.' + ext;
}

// 大纲点击 → 在源文里数到第 n 个标题（跳过围栏代码块，与 utils/markdown.js 的 extractHeadings 同口径）
async function scrollToHeading(index) {
  if (props.mode === 'preview') { emit('update:mode', 'split'); await nextTick(); applyMode(props.mode); }
  if (!view) return;
  const doc = view.state.doc;
  let n = -1;
  let fence = null;
  for (let i = 1; i <= doc.lines; i++) {
    const text = doc.line(i).text;
    const f = /^\s*(```|~~~)/.exec(text);
    if (f) { if (fence === f[1]) fence = null; else if (!fence) fence = f[1]; continue; }
    if (fence) continue;
    if (!/^#{1,6}\s+\S/.test(text)) continue;
    n++;
    if (n === index) {
      const pos = doc.line(i).from;
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: 'start' }),
      });
      return;
    }
  }
}
</script>

<style scoped>
.editor { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.editor.empty { border: 1px dashed var(--border); border-radius: 8px; }
.body { display: flex; flex: 1; min-height: 0; gap: 10px; }
/* CodeMirror 必须有个「高度确定」的盒子，否则长文滚不动。 */
.cm-wrap {
  position: relative; flex: 1 1 50%; min-width: 0; min-height: 0;
  border: 1px solid var(--border); border-radius: 0 0 8px 8px; overflow: hidden; background: var(--bg2);
}
.body.edit .cm-wrap, .body.source .cm-wrap { flex: 1 1 100%; }
.body.split .cm-wrap { border-radius: 0 0 0 8px; }
/* 必须给 .cm-editor 一个**确定高度**（= 这个盒子），高度链路才通：
   .cm-editor(定高) → .cm-scroller{height:100%} → 内部滚动条。
   注意 ②（v1.10.2 上线、v1.10.4 才真正修好；别再改回绝对定位）：
   v1.10.2 这里写的是 `position: absolute; inset: 0` —— **它从来没生效过**：
   @codemirror/view 的基础主题里 `.cm-editor { position: relative !important }`
   （带 !important，谁也别想覆盖它），所以 editor 的高度仍然由内容决定：
   一篇 200 行的笔记会把 .cm-editor 撑到 4708px，塞在 609px 的 .cm-wrap 里被 overflow:hidden 裁掉，
   而 .cm-scroller 因为自身盒子跟内容一样高**永远不会滚动** —— 用户看到「只能看到前 36 行、
   往下滚不动」。短笔记看不出来，长笔记必现。改成 height:100% 之后靠的是标准的
   「定高父级 + 子元素溢出滚动」链路，跟 CM 自带主题不打架。 */
.cm-wrap :deep(.cm-editor) { height: 100%; }
/* 源码模式（只读）比正文淡一点，一眼看出「这不是在编辑」 */
.body.source .cm-wrap :deep(.cm-content) { color: var(--text2); }
.preview {
  flex: 1 1 50%; min-width: 0; min-height: 0;
  border: 1px solid var(--border); border-radius: 0 0 8px 8px; padding: 12px 16px;
  overflow-y: auto; background: var(--bg2);
}
.body.preview .preview { flex: 1 1 100%; }
.body.split .preview { border-radius: 0 0 8px 0; }
.empty-hint { color: var(--text3); text-align: center; padding: 40px 0; }
.modes { display: flex; gap: 2px; margin-left: 8px; }
.mbtn { font-size: 11.5px; padding: 2px 8px; border-radius: 5px; border: 1px solid var(--border); background: transparent; color: var(--text2); cursor: pointer; }
.mbtn.on { background: var(--accent); color: #fff; border-color: var(--accent); }
:deep(.wl) { color: var(--accent); text-decoration: none; border-bottom: 1px dashed currentColor; cursor: pointer; }
:deep(.wl-miss) { color: var(--text2); border-bottom: 1px dashed var(--border); }
:deep(mark) { background: var(--amber); color: #000; border-radius: 2px; }
</style>
