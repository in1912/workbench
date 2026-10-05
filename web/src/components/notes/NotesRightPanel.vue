<template>
  <div class="rp">
    <div class="rp-tabs">
      <button v-for="m in MODES" :key="m.k" :class="{ on: mode === m.k }" :title="m.title"
              @click="$emit('update:mode', m.k)">{{ m.t }}</button>
      <button class="collapse" title="收起右栏" @click="$emit('collapse')">›</button>
    </div>

    <!-- 图谱那一档要铺满右栏高度：canvas 是 height:100%，父级必须是能定高的 flex 列
         （默认的 overflow-y:auto / block 流里，flex:1 不起作用，画布会塌成 0 高） -->
    <div class="rp-body" :class="{ 'rp-body-fill': mode === 'graph' }">
      <template v-if="mode === 'tabs'"><TabStack vertical /></template>
      <template v-else-if="mode === 'outline'"><OutlinePanel :headings="headings" @go="$emit('go-heading', $event)" /></template>
      <template v-else-if="mode === 'graph'">
        <!-- 本篇的知识图谱（v1.10.3）：只画「这篇 + 一跳/两跳邻居」，
             取数走 GET /notes/graph/local/:id（服务端才算得出邻居，前端拿不到全图也不影响）。
             要求来自用户：「右侧框增加一个按钮【图谱】，放在大纲后面，显示本篇文章的知识图谱连接」。 -->
        <GraphView v-if="activeNoteId" compact :focus-note-id="activeNoteId"
                   @open-note="$emit('open-note', $event)" @open-full="$emit('open-full-graph')" />
        <div v-else class="muted small">先打开一篇笔记，这里会画出它的链接关系。</div>
      </template>
      <template v-else-if="mode === 'props'">
        <PropertiesPanel :defs="propDefs" :values="propsOf" @set="(k, v) => $emit('set-prop', k, v)" @manage="$emit('manage-props')" />
      </template>
      <template v-else-if="mode === 'links'">
        <BacklinksPanel :links="links" :note-title="noteTitle" @open="$emit('open-note', $event)" @create="$emit('create-note', $event)" />
      </template>
      <template v-else-if="mode === 'tags'">
        <div>
          <div v-for="t in tags" :key="t.tag" class="tagrow" @click="$emit('filter-tag', t.tag)">
            <span class="tag small">{{ t.tag }}</span><span class="muted small">{{ t.count }}</span>
          </div>
          <div v-if="!tags.length" class="muted small">还没有标签。正文里写 #标签 即可。</div>
        </div>
      </template>
      <template v-else-if="mode === 'stats'">
        <div class="stat">
          <div class="big">{{ stats.total_words || 0 }}</div><div class="muted small">总字数</div>
          <div class="big" style="margin-top:8px">{{ stats.total_notes || 0 }}</div><div class="muted small">笔记数</div>
          <div class="big" style="margin-top:8px">{{ stats.today_words || 0 }}</div><div class="muted small">今日写了 {{ stats.today_notes || 0 }} 篇</div>
          <div class="big" style="margin-top:8px">{{ stats.streak_days || 0 }} 天</div><div class="muted small">连续打卡（最长 {{ stats.longest_streak || 0 }} 天）</div>
          <div v-if="stats.by_folder?.length" style="margin-top:10px">
            <div class="muted small" style="margin-bottom:4px">按顶层文件夹</div>
            <div v-for="f in stats.by_folder" :key="f.folder" class="tagrow">
              <span class="small">{{ f.folder }}</span>
              <span class="muted small">{{ f.count }} 篇 · {{ f.words }} 字</span>
            </div>
          </div>
        </div>
      </template>
      <template v-else-if="mode === 'help'">
        <NotesHelp inline @open-note="$emit('open-note', $event)" />
      </template>
    </div>
  </div>
</template>

<script setup>
// 右栏容器（v1.9.41）：大纲 / 属性 / 链接 / 标签 / 堆叠标签页 / 统计 / 速查。
// 一行一个模式，切换只是换组件，不做嵌套路由（右栏的选择不需要进浏览器历史）。
import TabStack from './TabStack.vue';
import OutlinePanel from './OutlinePanel.vue';
import GraphView from './GraphView.vue';
import PropertiesPanel from './PropertiesPanel.vue';
import BacklinksPanel from './BacklinksPanel.vue';
import NotesHelp from './NotesHelp.vue';

defineProps({
  mode: { type: String, default: 'outline' },
  activeNoteId: { type: [Number, null], default: null },
  headings: { type: Array, default: () => [] },
  propDefs: { type: Array, default: () => [] },
  propsOf: { type: Object, default: () => ({}) },
  links: { type: Object, default: () => ({}) },
  noteTitle: { type: String, default: '' },
  tags: { type: Array, default: () => [] },
  stats: { type: Object, default: () => ({}) },
});
defineEmits(['update:mode', 'collapse', 'go-heading', 'set-prop', 'manage-props', 'open-note', 'create-note',
  'filter-tag', 'open-full-graph']);

const MODES = [
  { k: 'outline', t: '大纲', title: '正文标题导航' },
  { k: 'graph', t: '图谱', title: '本篇的知识图谱（一跳 / 两跳邻居）' },
  { k: 'links', t: '链接', title: '出链 / 反链 / 未解析' },
  { k: 'props', t: '属性', title: '自定义属性' },
  { k: 'tags', t: '标签', title: '全部标签' },
  { k: 'tabs', t: '页签', title: '竖排的标签页（名字完整可见）' },
  { k: 'stats', t: '统计', title: '字数与打卡' },
  { k: 'help', t: '说明', title: '使用说明' },
];
</script>

<style scoped>
.rp { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.rp-tabs { display: flex; gap: 2px; flex-wrap: wrap; border-bottom: 1px solid var(--border); padding-bottom: 6px; margin-bottom: 8px; }
.rp-tabs button { font-size: 11.5px; padding: 2px 8px; border-radius: 5px; border: 1px solid transparent; background: transparent; color: var(--text2); cursor: pointer; }
.rp-tabs button:hover { background: var(--bg3); color: var(--text); }
.rp-tabs button.on { background: var(--accent); color: #fff; }
.rp-tabs .collapse { margin-left: auto; border-color: var(--border); }
.rp-body { flex: 1; min-height: 0; overflow-y: auto; }
.rp-body-fill { display: flex; flex-direction: column; overflow: hidden; }
.tagrow { display: flex; justify-content: space-between; align-items: center; gap: 6px; padding: 3px 5px; border-radius: 5px; cursor: pointer; }
.tagrow:hover { background: var(--bg3); }
.stat .big { font-size: 18px; font-weight: 600; }
</style>
