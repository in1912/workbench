<template>
  <!-- [v1.13.1] LLM在线模型对话的「脱敏」功能框（点【脱敏】按钮在右侧展开）。
       纯展示组件：脱敏本身在服务端做（本地纯规则，不调 AI、不联网），这里只负责
       说明原理、亮出当前规则、并把「本轮对照关系」摆给用户看。 -->
  <div class="card desens-panel" :class="{ open }">
    <div class="dp-head">
      <div style="font-weight:600; font-size:13.5px">🔒 AI 脱敏</div>
      <button class="icon-btn" title="收起" @click="$emit('close')">✕</button>
    </div>

    <!-- ① 说明与原理 -->
    <div class="dp-sec">
      <div class="dp-t">说明与原理</div>
      <p class="dp-p">
        打开脱敏后，你发出去的内容会先在本机把<b>专有名词</b>换成随机代码（形如
        <code>ORG-7K2M9</code>），在线模型看到的是代码；它回话时再把代码<b>按对照表拼回真名</b>，
        所以聊天框里看到的一直是真名。
      </p>
      <p class="dp-p">
        整个过程是<b>本机纯规则匹配</b>——不调用任何 AI、不联网、不上传对照表。同一轮里同一个名字
        只会有一个代码；<b>每一轮重新随机</b>，所以跨轮代码不通用。
      </p>
      <p class="dp-p dp-warn">
        图片附件（截图/照片）走的是图片通道，<b>无法脱敏</b>，会原样发给模型。要保密的内容请用文字发。
      </p>
    </div>

    <!-- ② 规则摘要 -->
    <div class="dp-sec">
      <div class="dp-t">
        当前规则
        <span class="muted" style="font-weight:400; margin-left:6px">（在「效率工具 → AI脱敏」里改）</span>
      </div>
      <div v-if="cfg.ready && !cfg.enabled" class="dp-off">
        ⚠️ 脱敏总开关处于<b>关闭</b>状态（效率工具 → AI脱敏）。现在点脱敏发送不会生效，系统会如实告知。
      </div>
      <div class="dp-chips">
        <span v-for="t in types" :key="t.key" class="dp-chip" :class="{ on: cfg.types && cfg.types[t.key] !== false }"
              :title="t.hint || ''">{{ t.label }}</span>
      </div>
      <div class="dp-meta">
        数值脱敏：<b>{{ cfg.mask_numbers ? '已开' : '关' }}</b>
        <span class="muted">（开了 AI 可能会算错，默认关）</span>
        · 固定关键词：<b>{{ cfg.fixed_count || 0 }}</b> 条
      </div>
    </div>

    <!-- ③ 本轮对照关系 -->
    <div class="dp-sec">
      <div class="dp-t">本轮对照关系<span v-if="count" class="muted">（共 {{ count }} 项）</span></div>
      <div v-if="skipped" class="dp-off">{{ skipped }}</div>
      <div v-else-if="!mapping.length" class="muted" style="font-size:12px">
        还没有发送过。勾选【脱敏】后发送，这里会列出本轮真名 ↔ 代码的对照。
      </div>
      <div v-else class="dp-table">
        <div v-for="(m, i) in mapping" :key="i" class="dp-row">
          <span class="dp-type">{{ typeLabel(m.type) }}</span>
          <span class="dp-term" :title="m.term">{{ m.term }}</span>
          <span class="dp-arrow">→</span>
          <span class="dp-code">{{ m.code }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
const props = defineProps({
  open: { type: Boolean, default: false },
  types: { type: Array, default: () => [] },
  cfg: { type: Object, default: () => ({}) },
  mapping: { type: Array, default: () => [] },
  count: { type: Number, default: 0 },
  skipped: { type: String, default: '' },
});
defineEmits(['close']);

const TYPE_LABEL = { numbers: '数值' };
function typeLabel(k) {
  if (!k) return '其它';
  const t = props.types.find((x) => x.key === k);
  return t ? t.label : (TYPE_LABEL[k] || k);
}
</script>

<style scoped>
.desens-panel { height: calc(100vh - 140px); overflow-y: auto; padding: 12px; }
.dp-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.dp-sec { border-top: 1px solid var(--border); padding-top: 10px; margin-top: 10px; }
.dp-sec:first-of-type { border-top: 0; margin-top: 0; padding-top: 0; }
.dp-t { font-size: 12.5px; font-weight: 600; color: var(--text2); margin-bottom: 6px; }
.dp-p { font-size: 12px; line-height: 1.7; color: var(--text2); margin: 0 0 6px; }
.dp-p b { color: var(--text); }
.dp-p code { background: var(--bg3); padding: 0 3px; border-radius: 3px; font-size: 11.5px; }
.dp-warn { color: #e0a03a; }
.dp-off { font-size: 12px; line-height: 1.6; color: #e0a03a; background: rgba(224,160,58,.1);
  border-radius: 6px; padding: 6px 8px; margin-bottom: 6px; }
.dp-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.dp-chip { font-size: 11px; padding: 1px 7px; border-radius: 10px; background: var(--bg3);
  color: var(--text3); border: 1px solid transparent; }
.dp-chip.on { background: rgba(79,124,247,.16); color: #8fb0ff; border-color: rgba(79,124,247,.35); }
.dp-meta { font-size: 11.5px; color: var(--text3); line-height: 1.6; }
.dp-meta b { color: var(--text2); }
.dp-table { max-height: 42vh; overflow-y: auto; }
.dp-row { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 4px 0;
  border-bottom: 1px dashed var(--border); }
.dp-row:last-child { border-bottom: 0; }
.dp-type { flex: 0 0 auto; font-size: 10.5px; padding: 0 5px; border-radius: 8px;
  background: rgba(45,212,191,.14); color: var(--accent2); }
.dp-term { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dp-arrow { flex: 0 0 auto; color: var(--text3); }
.dp-code { flex: 0 0 auto; font-family: ui-monospace, Consolas, monospace; font-size: 11.5px;
  color: var(--accent); word-break: break-all; }
</style>
