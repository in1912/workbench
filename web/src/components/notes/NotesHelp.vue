<template>
  <div class="help" :class="{ inline }">
    <h3>笔记模块速查</h3>

    <h4>怎么分工：文件夹管「在哪」，标签管「是什么」</h4>
    <ul>
      <li><b>文件夹</b>是一棵树，一篇笔记只属于一个文件夹 —— 用来回答"这条东西存在哪儿"。</li>
      <li><b>标签</b>可以有任意多个 —— 用来回答"这条东西是什么"。正文里写 <code>#物理</code> 就算打上标签，右侧「属性」里也能手动加。</li>
      <li>闪念 / 文献 / 永久笔记不做成硬性类型，用<b>模板 + 标签</b>组合：先选模板建笔记，再让它带上对应标签。</li>
    </ul>

    <h4>双链：<code>[[另一篇的标题]]</code></h4>
    <ul>
      <li>写 <code>[[某标题]]</code> 就会建立链接。目标已经存在 → 点进去；不存在 → 右侧「链接」面板的<b>未解析</b>里会列出来，点一下就能建。</li>
      <li><b>键入 <code>[[</code> 会直接列出已有笔记的标题</b>，边打边筛，选中后自动补上 <code>]]</code>（工具栏那个 <code>[[ ]]</code> 按钮也会弹这个列表）。</li>
      <li>笔记改名时会留下<b>别名</b>，老的 <code>[[旧标题]]</code> 不会断。</li>
      <li>被引用关系在右侧「链接」面板看（出链 / 反链）；<b>「图谱」</b>面板则把这一篇的全部连接画成一张小图（1 跳 / 2 跳可切，点圆点直接跳过去）。</li>
    </ul>

    <h4>编辑器：编辑 / 分屏 / 预览 / 源码</h4>
    <ul>
      <li>打开一篇笔记先给<b>预览</b>；<b>在正文上双击就切进编辑</b>，光标落在开头（不会跑到文末）。</li>
      <li><b>编辑</b>与<b>分屏</b>里，Markdown 与代码块都是<b>边写边有色</b>的；代码块写 <code>```js</code> 这种信息串就会按对应语言上色。</li>
      <li><b>预览</b>只看渲染结果；<b>源码</b>是「代码预览」——只看带配色的 Markdown 源文，只读不可改。</li>
      <li>代码块支持的语言：js / ts / json / html / css / python / sql / xml / yaml / java / c / c++ / rust / go / php / vue / markdown / shell / dockerfile / diff / toml / ini / nginx。别的语言只是不上色，不影响阅读。</li>
    </ul>

    <h4>搜索的四种模式</h4>
    <ul>
      <li><b>关键词</b>：标题 + 正文 + 标签模糊匹配（中文直接子串，不需要分词）。</li>
      <li><b>标签</b>：按标签精确找。</li>
      <li><b>路径</b>：按所在文件夹找，会连子文件夹一起算。</li>
      <li><b>正则</b>：给高级用法，跑在后台线程里并带 1.5 秒硬超时，不会把页面拖死。</li>
    </ul>

    <h4>数据库视图（Dataview）</h4>
    <p>形如 <code>title ~ "周报" AND words &gt; 200</code>，字段有
      <code>title / content / tag / folder / created / updated / bookmarked / words / prop.属性名</code>，
      操作符 <code>= != ~ &gt; &lt; &gt;= &lt;=</code>，连接词 <code>AND / OR</code>（最多 10 个条件）。
      也可以从表单里选，两种写法等价。</p>

    <h4>图谱怎么看</h4>
    <ul>
      <li>颜色 = <b>顶层文件夹</b>；连线 = 双链。</li>
      <li><b>空心灰点</b> = 孤岛（没有任何链接进出的笔记）；<b>带环的点</b> = 枢纽（被引用次数在前 10%）。</li>
      <li>滚轮缩放、拖拽平移、拖点钉住；双击某个点进入它的局部图（只看 N 跳邻居）。</li>
    </ul>

    <h4>白板</h4>
    <ul>
      <li>卡片有两类常用：<b>笔记卡</b>（始终显示笔记的最新标题，点开就是原笔记 —— 是活链接，不是复制品）、<b>文本卡</b>。</li>
      <li>拖动卡片后会自动保存（防抖 0.8 秒），刷新页面位置还在。</li>
    </ul>

    <h4>每日笔记</h4>
    <p>左栏「今日笔记」或 <kbd>Ctrl/⌘ + P</kbd> 打开今天的日记，同一天只会有一条（重复点不会建出第二篇）。
      想让它自动带模板，在「设置」里选好模板即可。</p>

    <h4>插件</h4>
    <ul>
      <li><b>统计</b>：左栏底部一直显示「今日 N 字 · 连续 N 天」，点它进统计页（字数曲线、文件夹分布、最长连续）。</li>
      <li><b>日历</b>：日程页右上角有「显示笔记」开关，打开后每天的格子里会补上当天写过的笔记标题，点标题直接跳过来。</li>
      <li><b>AI 辅助</b>：笔记头部「AI ▾」可以总结 / 续写 / 翻译，结果能插到光标处或整篇替换。</li>
    </ul>

    <h4>快捷键</h4>
    <table class="kbd-table">
      <tr v-for="s in shortcuts" :key="s.key + String(s.ctrl) + String(s.shift)">
        <td><kbd>{{ s.pretty }}</kbd></td><td>{{ s.desc }}</td>
      </tr>
    </table>
    <p class="muted small">在编辑框里打字时，只有明确标了「编辑区可用」的快捷键会触发，普通按键不受影响。
      浏览器自带的打印（<kbd>Ctrl/⌘ + P</kbd>）在笔记页里被占用成了「打开今日笔记」，需要打印请用浏览器菜单。</p>
  </div>
</template>

<script setup>
// 使用说明（v1.9.41 第 13 条）。
// 快捷键表优先读**运行时注册表**，读不到（说明还没挂载）才用兜底表 —— 手写的文档表一定会过期。
import { computed } from 'vue';
import { listShortcuts, prettyShortcut } from '../../composables/useShortcuts';

defineProps({ inline: { type: Boolean, default: false } });
defineEmits(['open-note']);

const FALLBACK = [
  { key: 'o', ctrl: true, desc: '快速切换笔记' },
  { key: 'p', ctrl: true, desc: '打开 / 新建今日笔记' },
  { key: 'n', alt: true, desc: '新建笔记' },
  { key: 's', ctrl: true, desc: '保存当前笔记（编辑区可用）' },
  { key: 'p', ctrl: true, shift: true, desc: '命令面板' },
];

const shortcuts = computed(() => {
  const live = listShortcuts().filter((s) => s.description);
  const src = live.length ? live : FALLBACK;
  return src.map((s) => ({ ...s, desc: s.description || s.desc, pretty: prettyShortcut(s) }));
});
</script>

<style scoped>
.help { padding: 14px 16px; max-width: 720px; line-height: 1.75; font-size: 13px; }
.help.inline { padding: 4px 6px; font-size: 12.5px; }
h3 { font-size: 15px; margin-bottom: 10px; }
h4 { font-size: 13px; margin: 14px 0 6px; color: var(--accent); }
ul { padding-left: 20px; }
li { margin: 3px 0; }
code { background: var(--bg3); padding: 1px 5px; border-radius: 4px; font-size: .92em; }
kbd { background: var(--bg3); border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px; padding: 0 5px; font-size: 11.5px; }
.kbd-table { border-collapse: collapse; margin-top: 6px; }
.kbd-table td { padding: 3px 12px 3px 0; font-size: 12.5px; }
</style>
