<template>
  <div class="card">
    <h3>使用流程 <span class="muted" style="font-weight:400">一圈跑通；点任一格可直接跳到那一页</span></h3>

    <!-- 手搓 SVG 流程图（不引图库）：坐标写死在 nodes/edges 里，改文案只动数据不动画法 -->
    <svg class="flow" :viewBox="`0 0 ${W} ${H}`" role="img" aria-label="lifeOS 使用流程图">
      <defs>
        <marker id="life-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" class="head" />
        </marker>
        <marker id="life-arrow-on" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" class="head-on" />
        </marker>
      </defs>

      <path v-for="(e, i) in edges" :key="'e' + i" :d="e.d" class="edge"
            :class="{ loop: e.loop }" :marker-end="e.loop ? 'url(#life-arrow-on)' : 'url(#life-arrow)'" />

      <text class="loop-note" x="938" y="162" text-anchor="end">← 反哺：回改目标 / KR</text>

      <g v-for="n in nodes" :key="n.id" class="node" :class="{ hub: n.hub }"
         role="button" tabindex="0"
         @click="$emit('go', n.tab)" @keydown.enter.prevent="$emit('go', n.tab)" @keydown.space.prevent="$emit('go', n.tab)">
        <rect :x="n.x" :y="n.y" :width="n.w" :height="n.h" rx="10" />
        <text class="nt" :x="n.x + 16" :y="n.y + 22">{{ n.title }}</text>
        <text v-if="n.sub" class="ns" :x="n.x + 16" :y="n.y + 41">{{ n.sub }}</text>
      </g>
    </svg>

    <div class="legend">
      <div class="lg"><b>进度永不落库</b>：目标进度一律由关键结果（及子目标）现算——所以仪表盘上的数和明细永远一致，不存在「显示 70% 但底下没几条」。改 KR 的当前值，目标进度当场跟着动。</div>
      <div class="lg"><b>删了要顺手清边</b>：删目标 / 行动 / 项目时，它们之间的关系边会一并删掉，关系图不会留下连不到任何东西的孤岛。</div>
      <div class="lg"><b>行动就是工作台的待办</b>：lifeOS 的「行动」复用工作台的 todos 表（只多挂了目标、项目、领域等几列）——在待办页勾掉的，这里也是完成状态，反之亦然。</div>
      <div class="lg"><b>先跑起来再补齐</b>：最小闭环是「领域 → 目标 → KR → 行动 → 今日完成 → 复盘」；习惯、项目、关系图都是锦上添花，缺了不影响主循环。</div>
    </div>
  </div>
</template>

<script setup>
// 人生模块「使用流程」页（v1.10.1）：一张流程图 + 四条须知，放在 tab 栏最后。
// 坐标全部手写，不引图库——这与整个人生模块「零重型外部依赖」的取舍一致。
defineEmits(['go']);

const W = 980;
const H = 726;

// 三列宽 260 的居中主列（x=360），左右各一个 380 的分叉格
const nodes = [
  { id: 'today',   x: 360, y: 8,   w: 260, h: 52, title: '① 今日',        sub: '每天从这里出发',            tab: 'today',    hub: true },
  { id: 'domains', x: 360, y: 82,  w: 260, h: 52, title: '② 领域',        sub: '六个领域，长期不变',        tab: 'domains' },
  { id: 'goals',   x: 360, y: 156, w: 260, h: 52, title: '③ 目标',        sub: '挂在某个领域下',            tab: 'goals' },
  { id: 'krs',     x: 360, y: 230, w: 260, h: 52, title: '④ 关键结果 KR', sub: '进度由 KR 现算，不落库',    tab: 'goals' },
  { id: 'actions', x: 360, y: 304, w: 260, h: 52, title: '⑤ 行动',        sub: '写进待办，复用工作台 todos', tab: 'actions' },
  { id: 'projects',x: 60,  y: 384, w: 380, h: 62, title: '⑥ 项目',        sub: '跨目标、多步骤的活儿',      tab: 'projects' },
  { id: 'habits',  x: 540, y: 384, w: 380, h: 62, title: '⑦ 习惯',        sub: '每天打卡，看连续天数',      tab: 'habits' },
  { id: 'reviews', x: 360, y: 472, w: 260, h: 52, title: '⑧ 复盘',        sub: '周 / 月回看：哪里没跑动',   tab: 'reviews' },
  { id: 'sops',    x: 360, y: 546, w: 260, h: 52, title: '⑨ 沉淀 SOP',    sub: '把有效做法固化成清单',      tab: 'reviews' },
  { id: 'graph',   x: 360, y: 620, w: 260, h: 52, title: '⑩ 关系图',      sub: '看连接，把孤立的点接回去',  tab: 'graph' },
];

const edges = [
  { d: 'M490,60 V82' },
  { d: 'M490,134 V156' },
  { d: 'M490,208 V230' },
  { d: 'M490,282 V304' },
  // 行动往下分叉成「项目 / 习惯」两条并行支线
  { d: 'M490,356 V368' },
  { d: 'M490,368 H250 V384' },
  { d: 'M490,368 H730 V384' },
  // 两支再并回「复盘」
  { d: 'M250,446 V460 H490 V472' },
  { d: 'M730,446 V460 H490 V472' },
  { d: 'M490,524 V546' },
  { d: 'M490,598 V620' },
  // 闭环：关系图 → 右侧上行 → 回改目标（虚线，和实线区分开）
  { d: 'M490,672 V704 H948 V182 H620', loop: true },
];
</script>

<style scoped>
.flow { width: 100%; height: auto; display: block; margin: 12px 0 4px; }
.edge { fill: none; stroke: var(--text3); stroke-width: 1.6; }
.edge.loop { stroke: var(--accent); stroke-dasharray: 6 4; opacity: .85; }
.head { fill: var(--text3); }
.head-on { fill: var(--accent); }
.loop-note { font-size: 12px; fill: var(--accent); }
.node { cursor: pointer; }
.node rect { fill: var(--bg2); stroke: var(--border); stroke-width: 1.4; transition: stroke .15s, fill .15s; }
.node:hover rect, .node:focus-visible rect { stroke: var(--accent); fill: var(--bg3); }
.node.hub rect { fill: var(--bg3); stroke: var(--accent); }
.node:focus { outline: none; }
.nt { font-size: 14px; font-weight: 600; fill: var(--text); }
.ns { font-size: 12px; fill: var(--text3); }
.legend { display: grid; gap: 6px; margin-top: 12px; font-size: 12.5px; color: var(--text2); }
.lg b { color: var(--text); }
</style>
