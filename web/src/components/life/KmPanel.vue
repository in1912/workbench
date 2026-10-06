<template>
  <div class="km-root">
    <!-- ==================== 左栏：新建 / 文件夹树 / 地图列表 ==================== -->
    <aside class="km-side km-left" :style="{ width: leftW + 'px' }">
      <div class="km-card km-new">
        <button class="primary small km-fullbtn" :disabled="running" @click="creating = !creating">
          {{ creating ? '收起' : '＋ 新建知识地图' }}
        </button>
        <template v-if="creating">
          <textarea v-model="goalText" rows="3" style="width:100%; resize:vertical; margin-top:8px"
            placeholder="一句话说清目标，例如：能独立完成一个家庭 NAS 的部署与运维 / 能用 AI 辅助写出可发表的论文"></textarea>
          <div class="row" style="margin-top:6px">
            <button class="primary small" :disabled="running || goalText.trim().length < 4" @click="startBuild">
              {{ running ? '构建中…' : '🤖 开始构建' }}
            </button>
            <button class="small" :disabled="goalText.trim().length < 4" style="flex:0 0 auto"
                    title="把系统固化的导图框架提示词（拼上你的目标）复制出来，粘贴到外部 AI 工具也能按同一框架生成导图"
                    @click="togglePrompt">📋 获得提示词</button>
            <span class="muted small">约 1~3 分钟</span>
          </div>
          <div v-if="showPrompt" class="km-promptbox">
            <div class="row" style="margin-bottom:4px">
              <b class="small">外部 AI 提示词（系统框架 + 你的目标）</b>
              <button class="small" style="margin-left:auto" @click="copyPrompt">复制</button>
              <button class="ghost tiny" @click="showPrompt = false">✕</button>
            </div>
            <textarea ref="promptEl" readonly rows="9" style="width:100%; resize:vertical; font-size:12px"
                      :value="promptText" @focus="$event.target.select()"></textarea>
            <div class="muted small">粘贴到任何 AI 对话框发送，会得到 Markdown 技能树 + 7 大类资源表 + 图谱说明 + JSON 附件。</div>
          </div>
        </template>
        <div v-if="!hasAi" class="err-hint">AI 尚未配置：请先到「设置 → AI 模型」填写模型名称 / API 地址 / API Key。</div>
      </div>

      <div class="km-card km-tree-card">
        <div class="km-tree-head">
          <span>文件夹</span>
          <button class="ghost tiny" title="在当前选中的文件夹下新建子文件夹（选中「全部/未分类」时建在根）" @click="newFolder">＋</button>
        </div>
        <div class="km-frow" :class="{ on: folderSel === 'all' }" @click="folderSel = 'all'">
          <span class="km-fname">🗂 全部</span><span class="km-fcnt">{{ allMaps.length }}</span>
        </div>
        <div class="km-frow" :class="{ on: folderSel === 'none' }" @click="folderSel = 'none'">
          <span class="km-fname">📥 未分类</span><span class="km-fcnt">{{ countNone }}</span>
        </div>
        <div v-for="f in flatFolders" :key="f.id" class="km-frow" :class="{ on: folderSel === f.id }"
             :style="{ paddingLeft: 12 + f.depth * 15 + 'px' }" @click="folderSel = f.id">
          <span class="km-fname" :title="f.name">{{ f.name }}</span>
          <span class="km-fcnt">{{ f.map_total }}</span>
          <span class="km-fops">
            <button class="ghost tiny" title="重命名" @click.stop="renameFolder(f)">✎</button>
            <button class="ghost tiny" title="删除" @click.stop="removeFolder(f)">🗑</button>
          </span>
        </div>
      </div>

      <div class="km-card km-list-card">
        <div class="km-tree-head"><span>知识地图</span><span class="muted small">{{ shownMaps.length }} 张</span></div>
        <div v-if="!shownMaps.length" class="muted small" style="padding:6px 2px">（空）</div>
        <div v-for="m in shownMaps" :key="m.id" class="km-mrow" :class="{ on: map && map.id === m.id }" @click="selectMap(m.id)">
          <div class="km-mtitle">{{ m.title }}</div>
          <div class="muted small km-mgoal">{{ m.goal_text }}</div>
        </div>
      </div>
    </aside>

    <Splitter v-model="leftW" :min="200" :max="460" :default-width="260" @done="saveWidths" />

    <!-- ==================== 中栏：任务进度 / 工具条 / 导图画布 ==================== -->
    <main class="km-mid">
      <div v-if="job && job.state === 'running'" class="km-card km-jobbar">
        <div class="row" style="align-items:baseline">
          <b style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">
            正在构建：{{ job.goal_text }}
          </b>
          <span class="muted small" style="margin-left:auto; flex:0 0 auto">{{ job.stage_label }} · {{ job.progress }}% · 已进行 {{ fmtDur(elapsedS) }}</span>
          <button class="small" style="margin-left:10px; flex:0 0 auto" @click="cancelJob">取消</button>
        </div>
        <div class="bar"><div class="fill" :style="{ width: job.progress + '%' }"></div></div>
        <div class="muted small" style="margin-top:4px">
          任务在服务器后台运行，离开本页不中断，回来接着看。（任务保存在内存里，服务重启会丢失进行中的任务）
        </div>
        <div class="km-logbox">
          <div v-for="(l, i) in job.logs.slice(-8)" :key="i" class="logline">[{{ fmtClock(l.t) }}] {{ l.msg }}</div>
        </div>
      </div>

      <div v-if="map" class="km-card km-toolbar">
        <input v-model="editTitle" class="km-title-input" spellcheck="false" title="地图标题（失焦保存）"
               @blur="saveTitle" @keyup.enter="saveTitle">
        <select v-model="editFolder" class="km-fsel" title="所属文件夹" @change="saveMove">
          <option :value="null">未分类</option>
          <option v-for="f in flatFolders" :key="f.id" :value="f.id">{{ '　'.repeat(f.depth) }}{{ f.name }}</option>
        </select>
        <span class="km-sep"></span>
        <div class="pills">
          <button v-for="st in styles" :key="st.key" :class="{ on: map.style === st.key }"
                  :title="st.desc" @click="setStyle(st.key)">{{ st.label }}</button>
          <button v-if="recommended && recommended !== map.style" class="rec"
                  :title="'AI 推荐用「' + styleLabel(recommended) + '」展示这棵树'" @click="setStyle(recommended)">✨ AI 推荐</button>
        </div>
        <span class="km-sep"></span>
        <button class="small" :disabled="exporting" @click="downloadPng">⬇ PNG</button>
        <button class="small" :disabled="exporting" title="导出全部内容：主图 + 地图信息 + 子能力 + 成本表 + 数据来源 + 知识交集"
                @click="downloadPdf">⬇ PDF（全量）</button>
        <button class="small danger" @click="removeMap">🗑 删除</button>
        <div v-if="mapMeta" class="muted small km-metainfo">{{ mapMeta }}</div>
      </div>

      <div class="km-canvas" ref="canvasEl" @wheel.prevent="onWheel" @pointerdown="onPanStart">
        <svg v-if="nodes.length" class="km-svg">
          <g :transform="`translate(${view.tx},${view.ty}) scale(${view.k})`">
            <path v-for="(e, i) in edges" :key="'e' + i" :d="e.d" fill="none" :stroke="e.color" stroke-width="2" opacity="0.5" />
            <g v-for="(n, i) in nodes" :key="'n' + i" :transform="`translate(${n.x},${n.y})`"
               :opacity="selected ? (matchSel(n) ? 1 : 0.3) : 1" style="cursor:pointer" @click.stop="clickNode(n)">
              <title>{{ n.name }}{{ n.note ? '：' + n.note : '' }}</title>
              <rect :width="n.w" :height="n.h" rx="9" :fill="n.depth === 0 ? n.color : '#ffffff'" :stroke="n.color" stroke-width="1.6" />
              <text :x="13" :y="n.ty1" :font-size="n.depth === 0 ? 15 : 13.5" font-weight="600"
                    :fill="n.depth === 0 ? '#ffffff' : '#1f2430'">{{ n.disp }}</text>
              <text v-if="n.badge" :x="13" :y="n.ty2" font-size="11" fill="#8a93a6">{{ n.badge }}</text>
            </g>
          </g>
        </svg>
        <div v-else class="km-empty">
          <template v-if="job && job.state === 'running'">AI 正在构建技能树…（上方有进度）</template>
          <template v-else-if="job && job.state === 'error'">
            <div class="err-hint">构建失败：{{ job.error }}</div>
            <div class="km-logbox">
              <div v-for="(l, i) in job.logs" :key="i" class="logline">[{{ fmtClock(l.t) }}] {{ l.msg }}</div>
            </div>
          </template>
          <template v-else>
            还没有打开的知识地图
            <div class="muted" style="margin-top:6px">
              左上角输入一句话目标（想获得做什么任务的能力），AI 会生成一棵带【周期 / 程度 / 成本】的学习技能树，
              并配书籍、文档、课程等资源与右栏的知识交集。
            </div>
          </template>
        </div>
        <div v-if="nodes.length" class="km-zoomhint muted small">滚轮缩放 · 拖空白平移 · 点节点联动右栏</div>
      </div>
    </main>

    <Splitter v-model="rightW" :min="240" :max="560" :default-width="330" invert @done="saveWidths" />

    <!-- ==================== 右栏：数据来源 / 知识交集 / 子能力 / 成本 ==================== -->
    <aside class="km-side km-right" :style="{ width: rightW + 'px' }">
      <div class="km-rtabs">
        <button v-for="t in RTABS" :key="t.key" :class="{ on: rtab === t.key }" @click="rtab = t.key">{{ t.label }}</button>
      </div>
      <div class="km-rbody">
        <!-- 数据来源 -->
        <template v-if="rtab === 'src'">
          <div v-if="tree.summary" class="km-summary" :title="tree.summary">{{ tree.summary }}</div>
          <div v-if="selected" class="km-filter">
            节点：<b>{{ selected.name }}</b>
            <button class="ghost tiny" @click="selected = null">✕ 看全部</button>
          </div>
          <div v-if="!groupedRes.length" class="muted small">（AI 没有给出资源清单）</div>
          <template v-for="g in groupedRes" :key="g.type">
            <div class="km-group">{{ g.label }} <span class="muted small">{{ g.items.length }}</span></div>
            <div v-for="(r, i) in g.items" :key="i" class="km-res">
              <div class="km-rt">
                <a v-if="r.url" :href="r.url" target="_blank" rel="noopener">{{ resTitle(r) }}</a>
                <span v-else>{{ resTitle(r) }}</span>
              </div>
              <div class="muted small km-rmeta">
                <span v-if="r.author">{{ r.author }}</span><span v-if="r.source">· {{ r.source }}</span>
                <span v-if="r.version">· {{ r.version }}</span><span v-if="r.difficulty">· {{ r.difficulty }}</span>
              </div>
              <div class="muted small km-rmeta">
                <span v-if="r.prereq" title="先修要求">先修：{{ r.prereq }}</span>
                <span v-if="r.stage">· 阶段：{{ r.stage }}</span>
                <span v-if="r.credibility">· 可信度 {{ r.credibility }}</span>
                <span v-if="r.license">· {{ r.license }}</span>
              </div>
              <div v-if="r.skill" class="muted small km-rmeta">
                <span class="km-skilltag" title="挂靠技能，点击在导图中高亮" style="cursor:pointer"
                      @click="locateSkill(r.skill)">#{{ r.skill }}</span>
              </div>
            </div>
          </template>
        </template>

        <!-- 知识交集 -->
        <template v-else-if="rtab === 'links'">
          <div v-if="!map" class="muted small">先打开一张知识地图</div>
          <div v-else-if="linksLoading" class="muted small">检索中…</div>
          <template v-else-if="links">
            <div class="km-words">
              <span v-for="w in links.words" :key="w" class="km-word">{{ w }}</span>
            </div>
            <div class="muted small" style="margin:4px 0 8px">
              在你的 lifeOS 实体、笔记（不含 IM）、RSS 新闻、邮箱、IM 归档里按关键词找交集，点击跳回原文。
            </div>
            <div v-if="!links.groups.length" class="muted small">（没有可用关键词）</div>
            <template v-for="g in links.groups" :key="g.key">
              <div class="km-group">{{ g.label }} <span class="muted small">{{ g.items.length }}{{ g.total > g.items.length ? ' / 共 ' + g.total : '' }}</span></div>
              <div v-if="!g.items.length" class="muted small" style="padding:0 2px 6px">（无交集）</div>
              <div v-for="it in g.items" :key="g.key + it.kind + it.id" class="km-link"
                   :title="'命中「' + it.why + '」'" @click="jump(it)">
                <span class="km-linkt">{{ it.title }}</span><span class="muted small">「{{ it.why }}」</span>
              </div>
            </template>
          </template>
        </template>

        <!-- 子能力 -->
        <template v-else-if="rtab === 'sub'">
          <div v-if="!(tree.subskills || []).length && !(tree.advantages || []).length" class="muted small">（AI 没有给出）</div>
          <template v-if="(tree.subskills || []).length">
            <div class="km-group">需要扩展的子能力 <span class="muted small">{{ tree.subskills.length }}</span></div>
            <div v-for="(x, i) in tree.subskills" :key="'s' + i" class="km-res">
              <div class="km-rt">{{ x.name }}</div>
              <div v-if="x.why" class="muted small">{{ x.why }}</div>
            </div>
          </template>
          <template v-if="(tree.advantages || []).length">
            <div class="km-group">优势能力 <span class="muted small">{{ tree.advantages.length }}</span></div>
            <ul class="km-ul"><li v-for="(a, i) in tree.advantages" :key="'a' + i">{{ a }}</li></ul>
          </template>
        </template>

        <!-- 成本 -->
        <template v-else>
          <div class="km-group">每个知识点的投入 <span class="muted small">{{ flatNodes.length }} 项</span></div>
          <table class="km-cost">
            <thead><tr><th>知识点</th><th>周期</th><th>程度</th><th>成本</th></tr></thead>
            <tbody>
              <tr v-for="(n, i) in flatNodes" :key="i" :class="{ root: n.depth === 0 }">
                <td :style="{ paddingLeft: 6 + n.depth * 12 + 'px' }">{{ n.name }}</td>
                <td>{{ n.cycle || '—' }}</td><td>{{ n.level || '—' }}</td><td>{{ n.cost || '—' }}</td>
              </tr>
            </tbody>
          </table>
          <div class="muted small" style="margin-top:8px">
            共 {{ flatNodes.length }} 个知识点 · 有周期估计 {{ flatNodes.filter(n => n.cycle).length }} 项 · 有成本估计 {{ flatNodes.filter(n => n.cost).length }} 项。
            周期 / 成本是 AI 给的量级估计（供排优先级），不是报价。
          </div>
        </template>
      </div>
    </aside>
  </div>
</template>

<script setup>
// 知识地图（v1.11.0）——lifeOS「知识地图」页签。
// 三分栏（同笔记模块）：左 = 新建 + 文件夹树 + 地图列表；中 = 导图画布（五种布局 + pan/zoom +
// PNG/PDF 下载）；右 = 数据来源 / 知识交集 / 子能力 / 成本四个小页签。AI 生成走后台任务
// （同 AI复盘IM 的 jobs 轮询模型：POST 立即回任务号、1.5s 轮询快照、离开页面不中断）。
//
// v1.11.2：① 工具条显示地图元信息（模型 / token 用量 / 生成时间，用量随 tree JSON 落库）；
// ② PDF 升级全量导出（主图 + 地图信息 + 子能力/优势 + 成本表 + 数据来源 + 知识交集，
//   文字页 canvas 排字、每页一张 JPEG 进手写多页 PDF）；③ 书籍加权（📚 分组置顶、书名补《》）；
// ④ 获得提示词改用外部版（Markdown 树 + 7 大类资源表 + JSON 附件，与后端共用构建模型）。
// v1.11.3：进页默认打开最近制作的一张（按 created_at 挑最新，构建中不抢空态）。
//
// 画布口径：布局是纯函数 layoutTree(root, style) → { nodes, edges, bbox }——**坐标摆放与连线
// 生成分两步**（先摆完坐标再统一画边，sides 左右分组 / treeup 整树翻转都不会让边坐标失效）。
// 展示层（模板）与导出层（buildSvgString）共用同一布局函数与字号 / 估宽，两处视觉必然一致；
// 节点视觉全部用 SVG presentation attribute（不用 class / CSS 变量）——导出的独立 SVG 文档
// 里没有页面样式可用。
import { ref, reactive, computed, watch, onMounted, onUnmounted, inject, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../../api';
import Splitter from '../notes/Splitter.vue';

const emit = defineEmits(['toast']);
const router = useRouter();

const RTABS = [
  { key: 'src', label: '数据来源' }, { key: 'links', label: '知识交集' },
  { key: 'sub', label: '子能力' }, { key: 'cost', label: '成本' },
];

// ---------- 状态 ----------
const styles = ref([]);
const hasAi = ref(false);
const folders = ref([]);
const allMaps = ref([]);
const map = ref(null);          // 当前地图（tree 已解析）
const goalText = ref('');
const creating = ref(false);
const job = ref(null);
const tick = ref(0);
const exporting = ref(false);
const selected = ref(null);     // 导图选中节点（联动右栏资源过滤 + 高亮）
const rtab = ref('src');
const links = ref(null);
const linksLoading = ref(false);
const linksFor = ref(0);        // 已加载交集的地图 id
const leftW = ref(Number(localStorage.getItem('km.leftW')) || 260);
const rightW = ref(Number(localStorage.getItem('km.rightW')) || 330);
const promptTpl = ref('');
const showPrompt = ref(false);
const promptEl = ref(null);
const canvasEl = ref(null);
const view = reactive({ k: 1, tx: 0, ty: 0 });
let pollTimer = null, tickTimer = null, pollFails = 0, panState = null;

const running = computed(() => job.value?.state === 'running');
// 外部 AI 提示词：服务端下发的固化框架（meta.prompt_template，单一出处）+ 用户目标，
// 与后端 startJob 拼法同口径（不带给重试用的 NUDGE）
const promptText = computed(() => promptTpl.value
  ? promptTpl.value + `\n\n（学习目标）\n${goalText.value.trim()}` : '');
function togglePrompt() {
  showPrompt.value = !showPrompt.value;
  if (showPrompt.value) nextTick(() => { promptEl.value?.focus(); });
}
async function copyPrompt() {
  const t = promptText.value;
  try {
    await navigator.clipboard.writeText(t);
    emit('toast', '提示词已复制，去外部 AI 粘贴即可');
  } catch {
    // 非安全上下文（http 局域网直连）没有 clipboard API——退回选中文本让用户 Ctrl+C
    const el = promptEl.value;
    if (el) { el.focus(); el.select(); }
    const ok = document.execCommand('copy');
    emit('toast', ok ? '提示词已复制' : '已全选提示词，按 Ctrl+C 复制', ok ? '' : 'err');
  }
}
const elapsedS = computed(() => {
  tick.value;
  if (!job.value) return 0;
  return Math.max(0, Math.round(((job.value.finished_at || Date.now()) - job.value.started_at) / 1000));
});
const tree = computed(() => (map.value && map.value.tree) || {});
// 地图元信息（v1.11.2）：用了什么模型 / 多少 token / 生成时间。model 列与 created_at 一直在库，
// token 用量 v1.11.2 起随 tree JSON 落库——老图没有用量就只显示有的部分。
const mapMeta = computed(() => {
  if (!map.value) return '';
  const u = tree.value.usage || {};
  const parts = [];
  if (map.value.model) parts.push(`模型 ${map.value.model}`);
  if (u.total_tokens != null || u.completion_tokens != null) {
    parts.push(u.prompt_tokens != null || u.completion_tokens != null
      ? `输入 ${u.prompt_tokens ?? '?'} / 输出 ${u.completion_tokens ?? '?'} tokens`
      : `${u.total_tokens} tokens`);
  }
  if (map.value.created_at) parts.push(`${String(map.value.created_at).slice(0, 16)} 生成`);
  return parts.join(' · ');
});
const recommended = computed(() => tree.value.recommended_style || '');
const editTitle = ref('');
const editFolder = ref(null);

const flatFolders = computed(() => {
  const out = [];
  (function walk(nodes, depth) {
    for (const n of nodes || []) { out.push({ ...n, depth }); walk(n.children, depth + 1); }
  })(folders.value, 0);
  return out;
});
const countNone = computed(() => allMaps.value.filter((m) => m.folder_id == null).length);
const folderSel = ref('all');
const shownMaps = computed(() => {
  if (folderSel.value === 'all') return allMaps.value;
  if (folderSel.value === 'none') return allMaps.value.filter((m) => m.folder_id == null);
  const ids = new Set([Number(folderSel.value)]);
  (function collect(nodes) { for (const n of nodes || []) { ids.add(n.id); collect(n.children); } })(
    (folders.value.find((f) => f.id === Number(folderSel.value)) || {}).children);
  return allMaps.value.filter((m) => m.folder_id != null && ids.has(m.folder_id));
});

// =====================================================================
// 画布布局：树 → { nodes, edges, bbox }。五风格共用一套量宽 + 摆放：
//   pyramid  placeV（root 顶、向下）          边：父底→子顶
//   treeup   placeV 后整树上下翻转            边：父顶→子底
//   mindmap  placeH(dir=1)（root 左、向右）    边：父右→子左
//   sides    root 的子树左右分列（placeH ±1） 边：父左/右→子
//   radial   根在圆心，子树按叶子数分扇区外发散；同环挤了沿半径外推让位；
//            边 = 父中心→子中心直线（节点盒不透明，线藏在盒下，观感即放射树）
// =====================================================================
const FONT = "system-ui, 'Microsoft YaHei', 'PingFang SC', sans-serif";
const DEPTH_COLORS = ['#4a7dff', '#0f9d76', '#c47f17', '#8e5bd9', '#d9534f'];
const NH_GAP = 14;    // 兄弟节点间距
const LAYER_GAP = 72; // 层间距

function estTextW(t, size) {
  let w = 0;
  for (const ch of String(t || '')) w += ch.charCodeAt(0) > 255 ? size * 1.04 : size * 0.56;
  return w;
}
function clipText(t, maxW, size) {
  let w = 0, out = '';
  for (const ch of String(t || '')) {
    const cw = ch.charCodeAt(0) > 255 ? size * 1.04 : size * 0.56;
    if (w + cw > maxW) return out + '…';
    w += cw; out += ch;
  }
  return out;
}

function layoutTree(root, style) {
  // ① 量宽：显示节点（disp 截断名 / badge 徽章行 / w h）
  const mk = (n, depth) => {
    const isRoot = depth === 0;
    const badge = [n.cycle && '⏱ ' + n.cycle, n.level && '◆ ' + n.level, n.cost && '￥ ' + n.cost]
      .filter(Boolean).join('　');
    const innerW = Math.max(estTextW(n.name, isRoot ? 15 : 13.5), badge ? estTextW(badge, 11) + 6 : 0);
    const w = Math.min(264, Math.max(96, innerW + 26));
    const h = isRoot ? 56 : (badge ? 52 : 34);
    return {
      name: n.name, note: n.note || '', cycle: n.cycle || '', level: n.level || '', cost: n.cost || '',
      depth, color: DEPTH_COLORS[Math.min(depth, DEPTH_COLORS.length - 1)],
      disp: clipText(n.name, w - 26, isRoot ? 15 : 13.5),
      badge: clipText(badge, w - 26, 11),
      w, h, ty1: badge ? 22 : (isRoot ? 35 : 22), ty2: 41,
      children: (n.children || []).map((c) => mk(c, depth + 1)),
      _dir: 0,   // 连线方向：1 子在右 / -1 子在左 / 2 向下 / 3 向上
      x: 0, y: 0,
    };
  };
  const top = mk(root, 0);
  const nodes = [];
  (function flatten(n) { nodes.push(n); n.children.forEach(flatten); })(top);

  // ② 摆放坐标（只写 x/y，不画边）
  let cursor = 0;
  function placeH(n, x0, dir) {   // 水平子树：dir=1 向右 / -1 向左；叶子沿 cursor（y）均分
    n._dir = dir;
    n.x = dir > 0 ? x0 : x0 - n.w;
    const childX = dir > 0 ? n.x + n.w + LAYER_GAP : n.x - LAYER_GAP;
    if (!n.children.length) { n.y = cursor; cursor += n.h + NH_GAP; }
    else {
      n.children.forEach((c) => placeH(c, childX, dir));
      const first = n.children[0], last = n.children[n.children.length - 1];
      n.y = (first.y + first.h / 2 + last.y + last.h / 2) / 2 - n.h / 2;
    }
  }
  function placeV(n, y) {         // 垂直树：root 顶向下；叶子沿 cursor（x）均分
    n._dir = 2;
    n.y = y;
    if (!n.children.length) { n.x = cursor; cursor += n.w + NH_GAP; }
    else {
      n.children.forEach((c) => placeV(c, y + n.h + LAYER_GAP));
      const first = n.children[0], last = n.children[n.children.length - 1];
      n.x = (first.x + first.w / 2 + last.x + last.w / 2) / 2 - n.w / 2;
    }
  }

  if (style === 'pyramid' || style === 'treeup') {
    cursor = 0; placeV(top, 0);
    if (style === 'treeup') {   // 整树翻转：root 挪到底部
      const Ht = Math.max(...nodes.map((n) => n.y + n.h));
      for (const n of nodes) n.y = Ht - n.y - n.h;
      for (const n of nodes) n._dir = 3;
    }
  } else if (style === 'mindmap') {
    cursor = 0; placeH(top, 0, 1);
  } else if (style === 'radial') {
    // 角度按叶子数瓜分（叶子多的子树扇区大），深度 d 的环半径 RING0+(d-1)*RING_STEP；
    // 同环盒子挤到一起时只能沿半径外推（角度被父跨度钉死）
    const leafCount = (n) => (n.children.length ? n.children.reduce((a, c) => a + leafCount(c), 0) : 1);
    const RING0 = 280, RING_STEP = 300;
    (function assign(n, depth, a0, a1) {
      const cnt = leafCount(n);
      n._ang = (a0 + a1) / 2;
      n._r = depth === 0 ? 0 : RING0 + (depth - 1) * RING_STEP;
      let span = a0;
      for (const c of n.children) {
        const cs = (a1 - a0) * (leafCount(c) / cnt);
        assign(c, depth + 1, span, span + cs);
        span += cs;
      }
    })(top, 0, -Math.PI * 1.5, Math.PI / 2);   // 从正上方起顺时针整圈
    const sync = (n) => { n.x = Math.cos(n._ang) * n._r - n.w / 2; n.y = Math.sin(n._ang) * n._r - n.h / 2; };
    nodes.forEach(sync);
    const overlap = (p, q) => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
    for (let iter = 0; iter < 30; iter++) {
      let moved = false;
      const byDepth = new Map();
      for (const n of nodes) { if (!byDepth.has(n.depth)) byDepth.set(n.depth, []); byDepth.get(n.depth).push(n); }
      for (const arr of byDepth.values()) {
        for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
          const p = arr[i], q = arr[j];
          if (p._r === 0 || !overlap(p, q)) continue;
          if (q._r >= p._r) { q._r += 30; sync(q); } else { p._r += 30; sync(p); }
          moved = true;
        }
      }
      if (!moved) break;
    }
    for (const n of nodes) n._dir = 4;
  } else {   // sides：偶序子树向右、奇序向左，两半各自垂直居中对齐 root（root 中心 = 原点）
    const kids = top.children;
    const right = kids.filter((_, i) => i % 2 === 0);
    const left = kids.filter((_, i) => i % 2 === 1);
    const shift = (list, dy) => { for (const n of list) { (function sub(x) { x.y += dy; x.children.forEach(sub); })(n); } };
    cursor = -top.h / 2 - NH_GAP;   // 右半从 root 下方开始
    right.forEach((c) => placeH(c, Math.ceil(top.w / 2) + LAYER_GAP, 1));
    if (right.length) {
      const ys = right.flatMap((c) => { const arr = []; (function sub(x) { arr.push(x.y, x.y + x.h); x.children.forEach(sub); })(c); return arr; });
      shift(right, -(Math.min(...ys) + Math.max(...ys)) / 2);
    }
    cursor = -top.h / 2 - NH_GAP;   // 左半同样，从 root 下方开始
    left.forEach((c) => placeH(c, -Math.ceil(top.w / 2) - LAYER_GAP, -1));
    if (left.length) {
      const ys = left.flatMap((c) => { const arr = []; (function sub(x) { arr.push(x.y, x.y + x.h); x.children.forEach(sub); })(c); return arr; });
      shift(left, -(Math.min(...ys) + Math.max(...ys)) / 2);
    }
    top._dir = 0;   // root 的边方向按子节点各自 _dir（见下）
    top.x = -top.w / 2; top.y = -top.h / 2;
  }

  // ③ 统一画边（坐标已定，方向看每个子节点的 _dir）
  const edges = [];
  const byParent = new Map();
  for (const n of nodes) for (const c of n.children) byParent.set(c, n);
  for (const n of nodes) {
    for (const c of n.children) {
      const dir = c._dir;
      let x1, y1, x2, y2, d;
      if (dir === 4) {               // radial：父中心→子中心直线（盒子不透明，线藏在盒下）
        x1 = n.x + n.w / 2; y1 = n.y + n.h / 2;
        x2 = c.x + c.w / 2; y2 = c.y + c.h / 2;
        d = `M ${x1} ${y1} L ${x2} ${y2}`;
      } else if (dir === 2 || dir === 3) {   // 垂直（down: 父底→子顶；up: 父顶→子底）
        x1 = n.x + n.w / 2; x2 = c.x + c.w / 2;
        y1 = dir === 2 ? n.y + n.h : n.y;
        y2 = dir === 2 ? c.y : c.y + c.h;
        const my = (y1 + y2) / 2;
        d = `M ${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}`;
      } else {                        // 水平（1: 父右→子左；-1: 父左→子右）
        x1 = dir > 0 ? n.x + n.w : n.x; y1 = n.y + n.h / 2;
        x2 = dir > 0 ? c.x : c.x + c.w; y2 = c.y + c.h / 2;
        const mx = (x1 + x2) / 2;
        d = `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
      }
      edges.push({ d, color: c.color });
    }
  }

  // ④ bbox
  const minX = Math.min(...nodes.map((n) => n.x));
  const minY = Math.min(...nodes.map((n) => n.y));
  const maxX = Math.max(...nodes.map((n) => n.x + n.w));
  const maxY = Math.max(...nodes.map((n) => n.y + n.h));
  return { nodes, edges, bbox: { minX, minY, w: maxX - minX, h: maxY - minY } };
}

// 深拷贝用 JSON 往返：tree 来自响应式 store，structuredClone 咬不动 Proxy（DataCloneError，
// 直接把整个面板渲染炸掉——e2e 里真踩过）
const clone = (o) => JSON.parse(JSON.stringify(o));
const layout = computed(() => tree.value.root
  ? layoutTree(clone(tree.value.root), map.value.style)
  : { nodes: [], edges: [], bbox: null });
const nodes = computed(() => layout.value.nodes);
const edges = computed(() => layout.value.edges);

// ---------- pan / zoom / fit ----------
function fitView() {
  const el = canvasEl.value, bb = layout.value.bbox;
  if (!el || !bb || !bb.w) return;
  const cw = el.clientWidth, ch = el.clientHeight;
  const k = Math.max(0.08, Math.min(cw / bb.w, ch / bb.h, 1.2) * 0.92);
  view.k = k;
  view.tx = (cw - bb.w * k) / 2 - bb.minX * k;
  view.ty = (ch - bb.h * k) / 2 - bb.minY * k;
}
function onWheel(e) {
  const el = canvasEl.value; if (!el) return;
  const rect = el.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
  const k2 = Math.min(3, Math.max(0.08, view.k * f));
  view.tx = mx - (mx - view.tx) * (k2 / view.k);
  view.ty = my - (my - view.ty) * (k2 / view.k);
  view.k = k2;
}
function onPanStart(e) {
  if (e.button !== undefined && e.button !== 0) return;
  panState = { sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty };
  // 不 setPointerCapture：一旦捕获，后续 click 会被重定向到 canvas，节点上的 @click 全收不到
  //（e2e 真踩过：点节点右栏过滤条永远不出现）。窗口级 move/up 监听已经够拖出界外了。
  const move = (ev) => {
    if (!panState) return;
    view.tx = panState.tx + (ev.clientX - panState.sx);
    view.ty = panState.ty + (ev.clientY - panState.sy);
  };
  const up = () => {
    panState = null;
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// ---------- 导出（PNG / PDF；与展示共用 layoutTree，视觉一致） ----------
const esc = (t) => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function buildSvgString(scale) {
  const { nodes: ns, edges: es, bbox: bb } = layoutTree(clone(tree.value.root), map.value.style);
  const pad = 30;
  const W = Math.ceil(bb.w + pad * 2), H = Math.ceil(bb.h + pad * 2 + 26);
  const ox = -bb.minX + pad, oy = -bb.minY + pad + 22;
  const p = [];
  p.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W * scale}" height="${H * scale}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`);
  p.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  p.push(`<text x="${pad}" y="${18}" font-size="13" fill="#9aa3b5">${esc(map.value.title)} · 知识地图 · ${new Date().toLocaleDateString('zh-CN')}</text>`);
  for (const e of es) p.push(`<path d="${e.d}" transform="translate(${ox},${oy})" fill="none" stroke="${e.color}" stroke-width="2" opacity="0.5"/>`);
  for (const n of ns) {
    p.push(`<g transform="translate(${ox + n.x},${oy + n.y})">`);
    p.push(`<rect width="${n.w}" height="${n.h}" rx="9" fill="${n.depth === 0 ? n.color : '#ffffff'}" stroke="${n.color}" stroke-width="1.6"/>`);
    p.push(`<text x="13" y="${n.ty1}" font-size="${n.depth === 0 ? 15 : 13.5}" font-weight="600" fill="${n.depth === 0 ? '#ffffff' : '#1f2430'}">${esc(n.disp)}</text>`);
    if (n.badge) p.push(`<text x="13" y="${n.ty2}" font-size="11" fill="#8a93a6">${esc(n.badge)}</text>`);
    p.push('</g>');
  }
  p.push('</svg>');
  return { svg: p.join('\n'), W, H };
}

async function renderExportCanvas() {
  const scale = 2;
  const { svg, W, H } = buildSvgString(scale);
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('SVG 渲染失败')); img.src = url; });
    const cv = document.createElement('canvas');
    cv.width = W * scale; cv.height = H * scale;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    return cv;
  } finally { URL.revokeObjectURL(url); }
}

function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const safeName = (t) => String(t || '知识地图').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);

async function downloadPng() {
  if (exporting.value) return;
  exporting.value = true;
  try {
    const cv = await renderExportCanvas();
    const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
    saveBlob(blob, `${safeName(map.value.title)}.png`);
    emit('toast', 'PNG 已下载');
  } catch (e) { emit('toast', 'PNG 导出失败：' + (e.message || e), 'err'); }
  finally { exporting.value = false; }
}

// ---------- PDF 全量导出（v1.11.2）：不只主图，地图包含的全部信息都导出 ----------
// 页序：① 主图（A4 白底 + 头部标题/元信息）② 地图信息 + 子能力/优势 ③ 成本表
// ④ 数据来源（全部分组全部元数据）⑤ 知识交集（与已有资料的关联，含命中词）。
// 文字页的排字全走 canvas（浏览器字体，中文无障碍），每页一张 JPEG 嵌进手写多页 PDF（不引依赖）。
const A4W = 794, A4H = 1123, A4S = 2, MARGIN = 54;   // A4@96dpi 逻辑尺寸，2x 出图

function newReportPage() {
  const cv = document.createElement('canvas');
  cv.width = A4W * A4S; cv.height = A4H * A4S;
  const ctx = cv.getContext('2d');
  ctx.scale(A4S, A4S);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, A4W, A4H);
  ctx.textBaseline = 'top';
  return { cv, ctx, y: MARGIN };
}

// 按像素宽度断行（逐字符累加宽度；中文英文都适用，保留换行符）
function wrapText(ctx, text, maxW) {
  const lines = [];
  let line = '';
  for (const ch of String(text || '')) {
    if (ch === '\n') { lines.push(line); line = ''; continue; }
    if (line && ctx.measureText(line + ch).width > maxW) { lines.push(line); line = ch === ' ' ? '' : ch; }
    else line += ch;
  }
  lines.push(line);
  return lines;
}

function clipCanvasText(ctx, t, maxW) {
  let s = String(t || '');
  if (ctx.measureText(s).width <= maxW) return s;
  while (s.length && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s + '…';
}

// 主图页：A4 白底，头部标题 + 元信息行，主图按框缩放居中（与后面报告页同尺寸，翻阅连贯）
async function mapPageCanvas() {
  const src = await renderExportCanvas();   // 2x 白底主图（自带脚注行）
  const p = newReportPage();
  p.ctx.font = '700 19px ' + FONT; p.ctx.fillStyle = '#1f2430';
  p.ctx.fillText(clipCanvasText(p.ctx, map.value.title, A4W - MARGIN * 2 - 220), MARGIN, p.y);
  p.ctx.font = '10.5px ' + FONT; p.ctx.fillStyle = '#9aa3b5';
  p.ctx.textAlign = 'right';
  p.ctx.fillText(`${styleLabel(map.value.style)} · ${new Date().toLocaleDateString('zh-CN')} 导出`, A4W - MARGIN, p.y + 6);
  p.ctx.textAlign = 'left';
  p.y += 30;
  if (mapMeta.value) {
    p.ctx.font = '11px ' + FONT; p.ctx.fillStyle = '#6b7482';
    p.ctx.fillText(clipCanvasText(p.ctx, mapMeta.value, A4W - MARGIN * 2), MARGIN, p.y);
    p.y += 20;
  }
  const boxY = p.y + 6, boxW = A4W - MARGIN * 2, boxH = A4H - 36 - boxY;
  const k = Math.min(boxW / src.width, boxH / src.height);
  p.ctx.drawImage(src, (A4W - src.width * k) / 2, boxY, src.width * k, src.height * k);
  return p.cv;
}

// 报告页（②~⑤）：小节自动分页，页脚统一补「标题 · 第 X / Y 页」
function buildReportPages() {
  const pages = [];
  let pg = null;
  const BOTTOM = A4H - 40;
  const ensure = (need = 22) => {
    if (!pg || pg.y + need > BOTTOM) { pg = newReportPage(); pages.push(pg); }
    return pg;
  };
  const h2 = (t, cnt) => {
    const p = ensure(32);
    p.ctx.font = '700 14px ' + FONT; p.ctx.fillStyle = '#4a5568';
    p.ctx.fillText(cnt != null ? `${t}（${cnt}）` : t, MARGIN, p.y);
    p.ctx.strokeStyle = '#d8dee9'; p.ctx.beginPath();
    p.ctx.moveTo(MARGIN, p.y + 19); p.ctx.lineTo(A4W - MARGIN, p.y + 19); p.ctx.stroke();
    p.y += 28;
  };
  const para = (t, opt = {}) => {
    const size = opt.size || 12, color = opt.color || '#333a45', bold = opt.bold ? '700 ' : '';
    pg.ctx.font = `${bold}${size}px ${FONT}`;   // 先在当前页 ctx 上定字体量宽（各页字体一致）
    const lines = wrapText(pg.ctx, t, A4W - MARGIN * 2 - (opt.indent || 0));
    for (const ln of lines) {
      const p = ensure(size * 1.7);
      p.ctx.font = `${bold}${size}px ${FONT}`; p.ctx.fillStyle = color;
      p.ctx.fillText(ln, MARGIN + (opt.indent || 0), p.y);
      p.y += size * 1.65;
    }
  };

  // ② 地图信息
  const p0 = ensure(34);
  p0.ctx.font = '700 19px ' + FONT; p0.ctx.fillStyle = '#1f2430';
  p0.ctx.fillText(clipCanvasText(p0.ctx, map.value.title + ' · 导出报告', A4W - MARGIN * 2), MARGIN, p0.y);
  p0.y += 32;
  para(`目标：${map.value.goal_text || '—'}`);
  para(`生成信息：${mapMeta.value || '—'}`);
  if (tree.value.summary) para(`概要：${tree.value.summary}`);
  const kw = (tree.value.keywords || []).join('、');
  if (kw) para(`关键词：${kw}`);
  pg.y += 10;

  // ②b 子能力 / 优势能力
  const subs = tree.value.subskills || [], advs = tree.value.advantages || [];
  if (subs.length) {
    h2('需要扩展的子能力', subs.length);
    for (const x of subs) para(`· ${x.name}${x.why ? '——' + x.why : ''}`);
  }
  if (advs.length) {
    h2('优势能力', advs.length);
    for (const a of advs) para(`· ${a}`);
  }
  if (subs.length || advs.length) pg.y += 6;

  // ③ 成本表（逐节点四要素；跨页时重画表头）
  h2('成本（每个知识点的投入）', flatNodes.value.length);
  const cols = [
    { x: MARGIN, w: 290, t: '知识点' }, { x: MARGIN + 306, w: 150, t: '周期' },
    { x: MARGIN + 466, w: 105, t: '程度' }, { x: MARGIN + 579, w: 161, t: '成本' },
  ];
  const thead = () => {
    const p = ensure(26);
    p.ctx.font = '700 11.5px ' + FONT; p.ctx.fillStyle = '#6b7482';
    for (const c of cols) p.ctx.fillText(c.t, c.x, p.y);
    p.y += 17;
  };
  thead();
  for (const n of flatNodes.value) {
    if (pg.y + 20 > BOTTOM) thead();
    const p = ensure(19);
    p.ctx.font = (n.depth === 0 ? '700 ' : '') + '11.5px ' + FONT;
    p.ctx.fillStyle = n.depth === 0 ? '#1f2430' : '#333a45';
    p.ctx.fillText(clipCanvasText(p.ctx, n.name, cols[0].w - n.depth * 10), cols[0].x + n.depth * 10, p.y);
    p.ctx.font = '11px ' + FONT; p.ctx.fillStyle = '#4a5568';
    p.ctx.fillText(clipCanvasText(p.ctx, n.cycle, cols[1].w), cols[1].x, p.y);
    p.ctx.fillText(clipCanvasText(p.ctx, n.level, cols[2].w), cols[2].x, p.y);
    p.ctx.fillText(clipCanvasText(p.ctx, n.cost, cols[3].w), cols[3].x, p.y);
    p.y += 17;
  }
  pg.y += 10;

  // ④ 数据来源（全部分组、全部元数据；不受画布选中过滤影响）
  const all = tree.value.resources || [];
  h2('数据来源（学习资源）', all.length);
  const byType = new Map();
  for (const r of all) { if (!byType.has(r.type)) byType.set(r.type, []); byType.get(r.type).push(r); }
  const types = [...byType.keys()].sort((a, b) => {
    const ia = RES_ORDER.indexOf(a), ib = RES_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  for (const t of types) {
    ensure(24);
    para((t === 'book' ? '📚 ' : '') + resLabelOf(t) + `（${byType.get(t).length}）`, { bold: true, size: 12.5 });
    for (const r of byType.get(t)) {
      para(`· ${resTitle(r)}${r.author ? '　' + r.author : ''}`, { bold: true, size: 12 });
      const meta = [r.source, r.version, r.difficulty, r.prereq ? `先修：${r.prereq}` : '',
        r.stage ? `阶段：${r.stage}` : '', r.credibility ? `可信度：${r.credibility}` : '', r.license]
        .filter(Boolean).join(' · ');
      if (meta) para(meta, { size: 10.5, color: '#6b7482', indent: 14 });
      if (r.url) para(r.url, { size: 10.5, color: '#4a6fd0', indent: 14 });
      if (r.skill) para(`挂靠技能：${r.skill}`, { size: 10.5, color: '#6b7482', indent: 14 });
      pg.y += 3;
    }
  }

  // ⑤ 知识交集（没加载成功就整节省略，导出不因它失败）
  if (links.value && ((links.value.groups || []).length || (links.value.words || []).length)) {
    pg.y += 6;
    h2('知识交集（与已有资料的关联）');
    if ((links.value.words || []).length) para(`命中词：${links.value.words.join('、')}`, { size: 11, color: '#6b7482' });
    for (const g of links.value.groups || []) {
      ensure(24);
      para(`${g.label}（${g.items.length}${g.total > g.items.length ? ' / 共 ' + g.total : ''}）`, { bold: true, size: 12.5 });
      if (!g.items.length) para('（无交集）', { size: 10.5, color: '#9aa3b5', indent: 14 });
      for (const it of g.items) para(`· ${it.title}「${it.why}」`, { size: 11, indent: 14 });
    }
  }

  // 页脚统一补页码（页数此刻才知道，所以放最后画）
  pages.forEach((p, i) => {
    p.ctx.font = '10px ' + FONT; p.ctx.fillStyle = '#9aa3b5'; p.ctx.textAlign = 'center';
    p.ctx.fillText(`${map.value.title} · 知识地图导出 · 第 ${i + 2} / ${pages.length + 1} 页`, A4W / 2, A4H - 28);
    p.ctx.textAlign = 'left';
  });
  return pages.map((p) => p.cv);
}

// 最小多页 PDF：每页一张 JPEG（DCTDecode），页面尺寸 = 图像尺寸(pt)。手写二进制，不引依赖。
function minimalPdf(pages) {
  const enc = (str) => { const a = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 0xff; return a; };
  const parts = [enc('%PDF-1.4\n')];
  const offsets = [0];
  let pos = parts[0].length;
  const pushObj = (i, head, body, tail) => {
    offsets[i] = pos;
    const h = enc(`${i} 0 obj\n${head}`);
    parts.push(h); pos += h.length;
    if (body) { parts.push(body); pos += body.length; }
    const t = enc(tail);
    parts.push(t); pos += t.length;
  };
  const n = pages.length;
  const pageId = (i) => 3 + i, imgId = (i) => 3 + n + i, contId = (i) => 3 + 2 * n + i;
  pushObj(1, '<< /Type /Catalog /Pages 2 0 R >>', null, 'endobj\n');
  pushObj(2, `<< /Type /Pages /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] /Count ${n} >>`, null, 'endobj\n');
  pages.forEach((p, i) => {
    const W = +(p.w * 0.75).toFixed(2), H = +(p.h * 0.75).toFixed(2);
    pushObj(pageId(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /XObject << /Im${i} ${imgId(i)} 0 R >> >> /Contents ${contId(i)} 0 R >>`, null, 'endobj\n');
  });
  pages.forEach((p, i) => {
    pushObj(imgId(i), `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`, p.jpeg, '\nendstream\nendobj\n');
  });
  pages.forEach((p, i) => {
    const W = +(p.w * 0.75).toFixed(2), H = +(p.h * 0.75).toFixed(2);
    const content = `q ${W} 0 0 ${H} 0 0 cm /Im${i} Do Q`;
    pushObj(contId(i), `<< /Length ${content.length} >>\nstream\n${content}\nendstream`, null, 'endobj\n');
  });
  const maxId = 2 + 3 * n;
  const xrefPos = pos;
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxId; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  xref += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`;
  parts.push(enc(xref));
  const total = parts.reduce((a, p2) => a + p2.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p2 of parts) { out.set(p2, off); off += p2.length; }
  return out;
}

function canvasJpeg(cv, q = 0.9) {
  const dataUrl = cv.toDataURL('image/jpeg', q);
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

async function downloadPdf() {
  if (exporting.value) return;
  exporting.value = true;
  try {
    if (map.value && linksFor.value !== map.value.id) { try { await loadLinks(true); } catch { /* 交集拉不到就跳过该节 */ } }
    const cvs = [await mapPageCanvas(), ...buildReportPages()];
    const pages = cvs.map((cv) => ({ jpeg: canvasJpeg(cv), w: cv.width, h: cv.height }));
    saveBlob(new Blob([minimalPdf(pages)], { type: 'application/pdf' }), `${safeName(map.value.title)}.pdf`);
    emit('toast', `PDF 已下载（${pages.length} 页：主图 + 地图信息 + 子能力 + 成本 + 数据来源${links.value ? ' + 知识交集' : ''}）`);
  } catch (e) { emit('toast', 'PDF 导出失败：' + (e.message || e), 'err'); }
  finally { exporting.value = false; }
}

// ---------- 数据 ----------
async function loadMeta() {
  const m = await api.get('/life/km/meta');
  styles.value = m.styles || [];
  hasAi.value = !!m.has_ai;
  promptTpl.value = m.prompt_template || '';
}
async function loadFolders() { folders.value = await api.get('/life/km/folders'); }
async function loadMaps() { allMaps.value = await api.get('/life/km/maps'); }

async function selectMap(id) {
  try {
    map.value = await api.get(`/life/km/maps/${id}`);
    editTitle.value = map.value.title;
    editFolder.value = map.value.folder_id;
    selected.value = null;
    if (rtab.value === 'links') loadLinks(true);
    nextTick(fitView);
  } catch (e) { emit('toast', e.message, 'err'); }
}

async function saveTitle() {
  if (!map.value || editTitle.value.trim() === map.value.title) return;
  try {
    map.value = await api.put(`/life/km/maps/${map.value.id}`, { title: editTitle.value.trim() });
    loadMaps();
  } catch (e) { emit('toast', e.message, 'err'); }
}
async function saveMove() {
  if (!map.value) return;
  try {
    map.value = await api.put(`/life/km/maps/${map.value.id}`, { folder_id: editFolder.value });
    loadMaps(); loadFolders();
    emit('toast', '已移动');
  } catch (e) { emit('toast', e.message, 'err'); }
}
async function setStyle(key) {
  if (!map.value) return;
  try { map.value = await api.put(`/life/km/maps/${map.value.id}`, { style: key }); nextTick(fitView); }
  catch (e) { emit('toast', e.message, 'err'); }
}
const styleLabel = (k) => (styles.value.find((s) => s.key === k) || {}).label || k;

async function removeMap() {
  if (!map.value || !confirm(`删除知识地图《${map.value.title}》？不可恢复。`)) return;
  try {
    await api.del(`/life/km/maps/${map.value.id}`);
    map.value = null; links.value = null; linksFor.value = 0;
    loadMaps(); loadFolders();
    emit('toast', '已删除');
  } catch (e) { emit('toast', e.message, 'err'); }
}

// ---------- 文件夹 ----------
async function newFolder() {
  const name = prompt('新文件夹名：');
  if (!name || !name.trim()) return;
  const parent = typeof folderSel.value === 'number' ? folderSel.value : null;
  try {
    await api.post('/life/km/folders', { name: name.trim(), parent_id: parent });
    await loadFolders();
    emit('toast', '文件夹已创建');
  } catch (e) { emit('toast', e.message, 'err'); }
}
async function renameFolder(f) {
  const name = prompt('重命名文件夹：', f.name);
  if (!name || !name.trim() || name.trim() === f.name) return;
  try { await api.put(`/life/km/folders/${f.id}`, { name: name.trim() }); loadFolders(); }
  catch (e) { emit('toast', e.message, 'err'); }
}
// 删除前的预判（同 DomainsPanel 的做法）：列表数据里已有子文件夹与地图计数，先问清楚
// 再发请求——服务端 409 的 counts 不会跟着 api 层抛的 Error 走，别指望 catch 里读到。
async function removeFolder(f) {
  if ((f.children || []).length) {
    alert(`「${f.name}」下还有子文件夹，先删或移走它们再删这里。`);
    return;
  }
  const hasMaps = (f.map_total || 0) > 0;
  const q = hasMaps
    ? `删除文件夹「${f.name}」？\n\n它下面还有 ${f.map_total} 张知识地图，删除后地图会挪到「未分类」（地图本身不删）。`
    : `删除文件夹「${f.name}」？`;
  if (!confirm(q)) return;
  try {
    await api.del(`/life/km/folders/${f.id}${hasMaps ? '?force=1' : ''}`);
    if (folderSel.value === f.id) folderSel.value = 'all';
    await loadFolders(); await loadMaps();
    emit('toast', hasMaps ? '文件夹已删，地图已挪到未分类' : '已删除');
  } catch (e) { emit('toast', e.message, 'err'); }
}

// ---------- AI 构建任务（后台：POST 立即回任务号，1.5s 轮询） ----------
function stopTimers() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}
function startTimers() {
  stopTimers(); pollFails = 0;
  pollTimer = setInterval(async () => {
    try {
      const j = await api.get('/life/km/jobs/latest');
      pollFails = 0;
      job.value = j;
      if (!j) { stopTimers(); return; }
      if (j.state === 'done') {
        stopTimers();
        await loadMaps(); await loadFolders();
        creating.value = false; goalText.value = '';
        selectMap(j.result.map_id);
        emit('toast', `构建完成：《${j.result.title}》· ${j.result.node_count} 个技能节点 · ${j.result.resources} 条资源`);
      } else if (j.state === 'error') { stopTimers(); emit('toast', '构建失败：' + j.error, 'err'); }
      else if (j.state === 'cancelled') stopTimers();
    } catch { if (++pollFails >= 5) { stopTimers(); emit('toast', '进度查询连续失败，任务仍在后台运行，稍后回来刷新即可', 'err'); } }
  }, 1500);
  tickTimer = setInterval(() => { tick.value++; }, 1000);
}
async function startBuild() {
  if (running.value) return;
  try {
    const j = await api.post('/life/km/jobs', { goal_text: goalText.value.trim() });
    job.value = j;
    if (j.resumed) emit('toast', '上一次构建还在进行，已接上它的进度');
    startTimers();
  } catch (e) { emit('toast', e.message, 'err'); }
}
async function cancelJob() {
  try { await api.del('/life/km/jobs/latest'); emit('toast', '已取消构建'); }
  catch (e) { emit('toast', e.message, 'err'); }
}

// ---------- 右栏 ----------
const RES_ORDER = ['book', 'article', 'docs', 'course', 'opensource', 'paper', 'report', 'standard',
  'whitepaper', 'patent', 'api', 'dataset', 'podcast', 'talk', 'tool', 'platform', 'template', 'sop',
  'case', 'retro', 'internal', 'archive', 'expert', 'community', 'forum', 'cert'];
const groupedRes = computed(() => {
  const all = tree.value.resources || [];
  const filtered = selected.value
    ? all.filter((r) => r.skill === selected.value.name || (r.skill || '').includes(selected.value.name))
    : all;
  const by = new Map();
  for (const r of filtered) {
    if (!by.has(r.type)) by.set(r.type, []);
    by.get(r.type).push(r);
  }
  const order = [...by.keys()].sort((a, b) => {
    const ia = RES_ORDER.indexOf(a), ib = RES_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return order.map((k) => ({ type: k, label: k === 'book' ? '📚 ' + resLabelOf(k) : resLabelOf(k), items: by.get(k) }));
});
// 实体书籍展示时补书名号《》：新图由提示词直接带《》；老图（旧提示词生成的）在这里兜底包上；
// 标题里已出现《》的（AI 自己写过或带副书名）不再重复包，避免出现《《…》》。
const resTitle = (r) => {
  if (r.type !== 'book') return r.title;
  const t = String(r.title || '').trim();
  return t && !/[《》]/.test(t) ? `《${t}》` : t;
};
const resLabelOf = (k) => RES_LABELS[k] || k;
const RES_LABELS = {
  book: '书籍', article: '文章', standard: '规范', whitepaper: '白皮书', report: '行业报告',
  paper: '论文', patent: '专利', docs: '官方文档', api: 'API 文档', opensource: '开源项目',
  dataset: '数据集', course: '课程', podcast: '播客', talk: '会议演讲', template: '模板',
  sop: 'SOP', tool: '工具链', platform: '软件平台', case: '案例库', retro: '复盘库',
  internal: '内部文档', archive: '历史项目档案', expert: '专家导师', community: '社区',
  forum: '论坛', cert: '认证',
};

async function loadLinks(force = false) {
  if (!map.value || (linksLoading.value && !force)) return;
  if (!force && linksFor.value === map.value.id) return;
  linksLoading.value = true;
  try {
    links.value = await api.get(`/life/km/maps/${map.value.id}/links`);
    linksFor.value = map.value.id;
  } catch (e) { emit('toast', e.message, 'err'); }
  finally { linksLoading.value = false; }
}
watch(rtab, (v) => { if (v === 'links' && map.value) loadLinks(); });
watch(() => map.value && map.value.id, () => { links.value = null; linksFor.value = 0; });

const flatNodes = computed(() => {
  const out = [];
  (function walk(n, depth) {
    out.push({ name: n.name, cycle: n.cycle || '', level: n.level || '', cost: n.cost || '', depth });
    (n.children || []).forEach((c) => walk(c, depth + 1));
  })(tree.value.root || { name: '', children: [] });
  return out;
});

function matchSel(n) {
  return selected.value && (n === selected.value || n.name === selected.value.name);
}
function clickNode(n) {
  selected.value = selected.value && selected.value.name === n.name ? null : n;
  if (selected.value) { rtab.value = 'src'; }
}
function locateSkill(name) {
  const n = nodes.value.find((x) => x.name === name) || nodes.value.find((x) => name.includes(x.name) || x.name.includes(name));
  if (n) { selected.value = n; }
  else emit('toast', `导图里没有叫「${name}」的节点`);
}
function jump(it) {
  if (!it.jump) return;
  router.push(it.jump);
}

// ---------- 杂项 ----------
const fmtDur = (s) => (s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`);
const fmtClock = (ms) => {
  const d = new Date(ms), p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
function saveWidths() {
  localStorage.setItem('km.leftW', String(leftW.value));
  localStorage.setItem('km.rightW', String(rightW.value));
}
function onWinResize() { if (nodes.value.length) fitView(); }

// 本页全页自适应（同关系页）：挂载打开不限宽开关，卸载（切页签/离开 /life）自动关
const mainFull = inject('wbMainFull', null);

onMounted(async () => {
  if (mainFull) mainFull.value = true;
  window.addEventListener('resize', onWinResize);
  try { await loadMeta(); } catch (e) { emit('toast', e.message, 'err'); }
  try { await loadFolders(); } catch (e) { emit('toast', e.message, 'err'); }
  try { await loadMaps(); } catch (e) { emit('toast', e.message, 'err'); }
  // 重进页面：接上还在跑的任务；没有在跑的就默认打开最近制作的一张（v1.11.3 用户需求
  // 「知识地图页面，默认显示最近一次制作的知识地图」）。按 created_at 挑最新——列表本身按
  // updated_at 排，重命名/换风格会把老图顶到最上面，那不是「最近制作」；构建中不抢，
  // 画布留给「AI 正在构建技能树…」的空态说明。
  try {
    const j = await api.get('/life/km/jobs/latest');
    if (j) {
      job.value = j;
      if (j.state === 'running') startTimers();
    }
    if ((!job.value || job.value.state !== 'running') && !map.value && allMaps.value.length) {
      const newest = allMaps.value.reduce((a, b) => (String(b.created_at || '') > String(a.created_at || '') ? b : a));
      selectMap(newest.id);
    }
  } catch { /* 拿不到就算了 */ }
});
onUnmounted(() => {
  if (mainFull) mainFull.value = false;
  stopTimers();
  window.removeEventListener('resize', onWinResize);
});
</script>

<style scoped>
.km-root { display: flex; align-items: stretch; gap: 0;
  height: calc(100vh - 205px); min-height: 520px; margin-top: 10px; }
.km-side { display: flex; flex-direction: column; gap: 10px; min-width: 0; overflow: hidden; }
.km-mid { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.km-card { background: var(--bg2, #fff); border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }

/* 左栏 */
.km-new { flex: 0 0 auto; }
.km-fullbtn { width: 100%; }
.km-tree-card { flex: 0 0 auto; max-height: 40%; overflow: auto; }
.km-list-card { flex: 1 1 auto; overflow: auto; }
.km-tree-head { display: flex; align-items: center; justify-content: space-between;
  font-size: 12.5px; color: var(--text2); margin-bottom: 6px; }
.km-frow { display: flex; align-items: center; gap: 6px; padding: 4px 8px; border-radius: 6px;
  cursor: pointer; font-size: 13.5px; min-height: 28px; }
.km-frow:hover { background: rgba(127,127,127,.08); }
.km-frow.on { background: rgba(74,125,255,.12); }
.km-fname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.km-fcnt { font-size: 11.5px; color: var(--text2); }
.km-fops { display: none; gap: 2px; }
.km-frow:hover .km-fops { display: inline-flex; }
.km-frow:hover .km-fcnt { display: none; }
.km-mrow { padding: 7px 8px; border-radius: 8px; cursor: pointer; border: 1px solid transparent; }
.km-mrow:hover { background: rgba(127,127,127,.06); }
.km-mrow.on { border-color: var(--accent, #4a7dff); background: rgba(74,125,255,.08); }
.km-mtitle { font-weight: 600; font-size: 13.5px; }
.km-mgoal { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 中栏 */
.km-jobbar { flex: 0 0 auto; }
.km-toolbar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.km-title-input { font-weight: 700; font-size: 14.5px; border: 1px solid transparent; border-radius: 6px;
  padding: 4px 8px; min-width: 120px; max-width: 300px; background: transparent; color: var(--text); }
.km-title-input:hover, .km-title-input:focus { border-color: var(--border); background: var(--bg, #fff); outline: none; }
.km-fsel { max-width: 160px; }
.km-metainfo { flex: 1 1 100%; padding-top: 2px; color: var(--text2); }
.km-sep { width: 1px; height: 22px; background: var(--border); }
.km-toolbar .pills { display: flex; gap: 5px; flex-wrap: wrap; }
.km-toolbar .pills button, .km-toolbar .pills button.rec { padding: 4px 10px; border: 1px solid var(--border);
  background: transparent; color: var(--text2); border-radius: 999px; cursor: pointer; font-size: 12.5px; }
.km-toolbar .pills button.on { border-color: var(--accent, #4a7dff); color: var(--accent, #4a7dff); font-weight: 600; }
.km-toolbar .pills button.rec { color: #c47f17; border-color: #e3c08a; }
.km-canvas { flex: 1 1 auto; min-height: 300px; position: relative; border: 1px solid var(--border);
  border-radius: 10px; background: #fff; overflow: hidden; touch-action: none; cursor: grab; }
.km-svg { width: 100%; height: 100%; display: block; }
.km-empty { position: absolute; inset: 0; display: flex; flex-direction: column; gap: 8px;
  align-items: center; justify-content: center; color: var(--text2); padding: 30px; text-align: center; }
.km-zoomhint { position: absolute; right: 10px; bottom: 8px; pointer-events: none; opacity: .8; }
.km-logbox { margin-top: 8px; max-height: 130px; overflow-y: auto; border: 1px solid var(--border);
  border-radius: 8px; padding: 6px 10px; background: rgba(127,127,127,.06); font-size: 12px; line-height: 1.7; }
.logline { white-space: pre-wrap; word-break: break-all; }
.bar { height: 10px; border-radius: 999px; background: var(--border); overflow: hidden; margin-top: 8px; }
.bar .fill { height: 100%; background: var(--accent, #4a7dff); border-radius: 999px; transition: width .6s ease; }
.err-hint { color: #d93025; font-size: 13px; margin-top: 8px; }
.km-promptbox { margin-top: 8px; border: 1px dashed var(--border); border-radius: 8px; padding: 8px 10px;
  background: rgba(127,127,127,.05); }
.ghost { background: transparent; border: none; cursor: pointer; color: var(--text2); }
.tiny { font-size: 12px; padding: 1px 5px; }
.danger { color: #d93025; }

/* 右栏 */
.km-rtabs { display: flex; gap: 4px; flex-wrap: wrap; }
.km-rtabs button { padding: 5px 12px; border: 1px solid var(--border); background: var(--bg2, #fff);
  color: var(--text2); border-radius: 8px 8px 0 0; cursor: pointer; font-size: 13px; border-bottom: none; }
.km-rtabs button.on { color: var(--accent, #4a7dff); font-weight: 700; border-color: var(--accent, #4a7dff);
  background: var(--bg2, #fff); position: relative; top: 1px; }
.km-rbody { flex: 1 1 auto; overflow: auto; border-top: 1px solid var(--border); border-radius: 0 10px 10px 10px; }
.km-right .km-rbody { border-top-color: transparent; border-top-left-radius: 10px; }
.km-rtabs button.on + .km-rbody, .km-rbody { border-top: 1px solid var(--border); }
.km-summary { font-size: 12.5px; color: var(--text2); line-height: 1.6; margin-bottom: 8px;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.km-filter { display: flex; align-items: center; gap: 8px; background: rgba(74,125,255,.08);
  border-radius: 8px; padding: 6px 10px; font-size: 13px; margin-bottom: 8px; }
.km-group { font-size: 12.5px; font-weight: 700; color: var(--text2); margin: 12px 0 4px;
  border-bottom: 1px dashed var(--border); padding-bottom: 3px; }
.km-res { padding: 6px 2px; border-bottom: 1px solid rgba(127,127,127,.12); }
.km-rt { font-size: 13.5px; font-weight: 600; line-height: 1.5; }
.km-rt a { color: var(--accent, #4a7dff); }
.km-rmeta { line-height: 1.6; word-break: break-all; }
.km-skilltag { color: var(--accent, #4a7dff); }
.km-words { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 6px; }
.km-word { font-size: 11.5px; padding: 2px 8px; border-radius: 999px; background: rgba(127,127,127,.1);
  color: var(--text2); }
.km-link { padding: 6px 8px; border-radius: 8px; cursor: pointer; line-height: 1.5; }
.km-link:hover { background: rgba(74,125,255,.08); }
.km-linkt { font-size: 13px; font-weight: 600; }
.km-ul { margin: 0; padding-left: 18px; line-height: 1.8; font-size: 13.5px; }
.km-cost { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.km-cost th { text-align: left; color: var(--text2); font-weight: 600; padding: 4px 6px;
  border-bottom: 1px solid var(--border); }
.km-cost td { padding: 5px 6px; border-bottom: 1px solid rgba(127,127,127,.12); }
.km-cost tr.root td { font-weight: 700; }

@media (max-width: 980px) {
  .km-root { flex-direction: column; height: auto; }
  .km-side { width: 100% !important; }
  .km-canvas { min-height: 420px; }
}
</style>
