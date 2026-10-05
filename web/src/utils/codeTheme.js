// 笔记编辑器（CodeMirror 6）的外观：主题、语法配色、以及「代码块按语言上色」用的语言表。
//
// 颜色一律走 CSS 变量（--syn-*，声明在 web/src/style.css），四个主题各有一套 ——
// 换主题时编辑器**不重建**，颜色自己就跟着变了（CM 的样式表里存的是 var(...) 而不是色值）。
//
// 语言表是**手挑的**，不是整包 @codemirror/language-data：那一包会把 143 种语言的解析器
// 全部切成懒加载 chunk 打进 web/dist，而每个升级包都要背着它们。这里留了日常真会写进
// 笔记的 22 种；写别的语言只是不上色，不影响阅读和编辑。
import { EditorView } from '@codemirror/view';
import { HighlightStyle, LanguageDescription, LanguageSupport, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';

// ---------- 编辑器外框（字体、行高、光标、选区、补全下拉）----------
export const cmBaseTheme = EditorView.theme({
  // 高度交给外面的 flex 容器决定（见 NoteEditor.vue 的 .cm-wrap）
  '&': { color: 'var(--text)', backgroundColor: 'var(--bg2)', fontSize: '13.5px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, Consolas, "Courier New", monospace',
    lineHeight: '1.7',
    overflow: 'auto',
  },
  '.cm-content': { padding: '12px 12px 40px', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)', borderLeftWidth: '2px' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--syn-sel)',
  },
  '.cm-placeholder': { color: 'var(--text3)' },
  // [[ 的标题补全下拉
  '.cm-tooltip': {
    backgroundColor: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--text)',
    borderRadius: '6px', boxShadow: '0 6px 20px rgba(0,0,0,.28)',
  },
  '.cm-tooltip-autocomplete > ul': { maxHeight: '16em', fontFamily: 'inherit' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '3px 10px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent)', color: '#fff' },
  '.cm-completionLabel': { fontSize: '13px' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '700' },
}, { dark: false });

// ---------- 语法配色 ----------
// 注意顺序：**后面的规则优先级更高**（CM 文档：同一元素命中多条时，写在后面的胜出）。
// 所以先写「一类东西的默认样子」，再写例外。
export const cmHighlightStyle = HighlightStyle.define([
  { tag: tags.contentSeparator, color: 'var(--syn-mark)' },
  { tag: tags.quote, color: 'var(--syn-quote)', fontStyle: 'italic' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--syn-mark)' },
  { tag: tags.monospace, color: 'var(--syn-code)' },
  { tag: [tags.link, tags.url], color: 'var(--syn-link)' },
  { tag: tags.heading, color: 'var(--syn-hn)', fontWeight: '600' },
  { tag: [tags.heading1, tags.heading2], color: 'var(--syn-h1)', fontWeight: '700' },

  // 代码块（各语言共用这套 tag）
  { tag: tags.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: tags.keyword, color: 'var(--syn-keyword)' },
  { tag: [tags.modifier, tags.self, tags.operatorKeyword], color: 'var(--syn-keyword)' },
  { tag: tags.string, color: 'var(--syn-string)' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--syn-number)' },
  { tag: [tags.definition(tags.variableName), tags.function(tags.variableName), tags.function(tags.propertyName), tags.macroName], color: 'var(--syn-func)' },
  { tag: [tags.typeName, tags.className, tags.namespace], color: 'var(--syn-type)' },
  { tag: [tags.propertyName, tags.attributeName, tags.attributeValue], color: 'var(--syn-prop)' },
  { tag: tags.tagName, color: 'var(--syn-keyword)' },
  { tag: [tags.operator, tags.derefOperator], color: 'var(--syn-op)' },
  { tag: [tags.punctuation, tags.bracket, tags.separator], color: 'var(--syn-punc)' },

  // —— 以下两条**必须放在最后** ——
  // Markdown 的结构符号（#、*、`、[、]、- 这些「标记本身」）压暗，正文才跳得出来。
  // 但标记节点同时带着所属内容的 tag（标题的 # 也带 heading1，强调的 * 也带 emphasis），
  // 而 CM 的规则是「写在后面的赢」—— 想只压暗标记、不动内容，就只能把它放到最后。
  { tag: tags.meta, color: 'var(--syn-mark)' },
  { tag: tags.processingInstruction, color: 'var(--syn-mark)' },
  { tag: tags.invalid, color: 'var(--red)' },
]);

export const cmSyntax = syntaxHighlighting(cmHighlightStyle);

// ---------- 代码块语言表（```js 这种信息串 → 按需动态加载解析器）----------
// 注意 ①：每个 import(...) 都必须是**字面量路径**，Vite 才能把对应解析器切成独立 chunk。
// 注意 ②（v1.10.2 上线后真机点检抓到的坑，务必别改回去）：
//   load() 必须返回 **LanguageSupport**，不能返回裸的 Language。
//   lang-markdown 解析代码围栏时走的是
//     `found.support ? found.support.language.parser : ParseContext.getSkippingParser(found.load())`
//   —— 它读的是 support.language。而 StreamLanguage.define() 返回的是 StreamLanguage（一个 Language
//   子类，自己带 parser，但**没有 .language**）：第一次解析时 support 还是 undefined 走跳过分支没事，
//   等懒加载完成后 support 被填上，下一次解析就变成 undefined.parser → 抛
//   「Cannot read properties of undefined (reading 'parser')」，整个代码块的高亮从那一刻起就是坏的。
//   所以 legacy-modes 那批（shell/dockerfile/diff/toml/properties/nginx）**必须**包一层 LanguageSupport。
const legacy = (lang) => new LanguageSupport(lang);
export const codeLanguages = [
  LanguageDescription.of({ name: 'javascript', alias: ['js', 'jsx', 'mjs', 'cjs', 'node'], extensions: ['js', 'jsx', 'mjs', 'cjs'], load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })) }),
  LanguageDescription.of({ name: 'typescript', alias: ['ts', 'tsx'], extensions: ['ts', 'tsx'], load: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })) }),
  LanguageDescription.of({ name: 'json', alias: ['jsonc'], extensions: ['json'], load: () => import('@codemirror/lang-json').then((m) => m.json()) }),
  LanguageDescription.of({ name: 'html', alias: ['htm'], extensions: ['html', 'htm'], load: () => import('@codemirror/lang-html').then((m) => m.html()) }),
  LanguageDescription.of({ name: 'css', alias: ['scss', 'less'], extensions: ['css', 'scss', 'less'], load: () => import('@codemirror/lang-css').then((m) => m.css()) }),
  LanguageDescription.of({ name: 'python', alias: ['py'], extensions: ['py'], load: () => import('@codemirror/lang-python').then((m) => m.python()) }),
  LanguageDescription.of({ name: 'sql', alias: ['mysql', 'postgres', 'sqlite'], extensions: ['sql'], load: () => import('@codemirror/lang-sql').then((m) => m.sql()) }),
  LanguageDescription.of({ name: 'xml', alias: ['svg'], extensions: ['xml', 'svg'], load: () => import('@codemirror/lang-xml').then((m) => m.xml()) }),
  LanguageDescription.of({ name: 'yaml', alias: ['yml'], extensions: ['yaml', 'yml'], load: () => import('@codemirror/lang-yaml').then((m) => m.yaml()) }),
  LanguageDescription.of({ name: 'java', alias: [], extensions: ['java'], load: () => import('@codemirror/lang-java').then((m) => m.java()) }),
  LanguageDescription.of({ name: 'c', alias: ['cpp', 'c++', 'h', 'hpp', 'cc'], extensions: ['c', 'cpp', 'cc', 'h', 'hpp'], load: () => import('@codemirror/lang-cpp').then((m) => m.cpp()) }),
  LanguageDescription.of({ name: 'rust', alias: ['rs'], extensions: ['rs'], load: () => import('@codemirror/lang-rust').then((m) => m.rust()) }),
  LanguageDescription.of({ name: 'go', alias: ['golang'], extensions: ['go'], load: () => import('@codemirror/lang-go').then((m) => m.go()) }),
  LanguageDescription.of({ name: 'php', alias: [], extensions: ['php'], load: () => import('@codemirror/lang-php').then((m) => m.php()) }),
  LanguageDescription.of({ name: 'vue', alias: ['vue3'], extensions: ['vue'], load: () => import('@codemirror/lang-vue').then((m) => m.vue()) }),
  LanguageDescription.of({ name: 'markdown', alias: ['md'], extensions: ['md'], load: () => import('@codemirror/lang-markdown').then((m) => m.markdown()) }),
  LanguageDescription.of({ name: 'shell', alias: ['sh', 'bash', 'zsh', 'console', 'shell-session'], load: () => import('@codemirror/legacy-modes/mode/shell').then((m) => legacy(StreamLanguage.define(m.shell))) }),
  LanguageDescription.of({ name: 'dockerfile', alias: ['docker'], load: () => import('@codemirror/legacy-modes/mode/dockerfile').then((m) => legacy(StreamLanguage.define(m.dockerFile))) }),
  LanguageDescription.of({ name: 'diff', alias: ['patch'], load: () => import('@codemirror/legacy-modes/mode/diff').then((m) => legacy(StreamLanguage.define(m.diff))) }),
  LanguageDescription.of({ name: 'toml', alias: [], extensions: ['toml'], load: () => import('@codemirror/legacy-modes/mode/toml').then((m) => legacy(StreamLanguage.define(m.toml))) }),
  LanguageDescription.of({ name: 'properties', alias: ['ini', 'conf', 'env'], load: () => import('@codemirror/legacy-modes/mode/properties').then((m) => legacy(StreamLanguage.define(m.properties))) }),
  LanguageDescription.of({ name: 'nginx', alias: [], load: () => import('@codemirror/legacy-modes/mode/nginx').then((m) => legacy(StreamLanguage.define(m.nginx))) }),
];
