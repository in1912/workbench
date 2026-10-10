<template>
  <span class="ai-wrap">
    <button v-for="a in ACTIONS" :key="a.k" class="small" :disabled="disabled || loading" :title="a.title"
            @click="start(a.k)">{{ loading && cur === a.k ? '…' : a.t }}</button>

    <!-- 第一步：确认是否脱敏（v1.13.0） -->
    <div v-if="phase === 'ask'" class="modal-backdrop" @click.self="close">
      <div class="modal" style="width:min(560px,94vw)">
        <h3>AI {{ labelOf(cur) }} · 发送前确认</h3>
        <p class="muted" style="line-height:1.8;margin:0 0 12px">
          本次要把笔记内容发给「设置 → AI 模型」里的 AI。要不要<b>先脱敏</b>？
          脱敏会在本机把公司名 / 人名 / 部门 / 群名 / 账号 / API KEY 等专有名词换成随机代码再发送，
          AI 返回后自动按对照表拼回原词。
        </p>
        <div class="muted small" style="margin-bottom:14px">
          脱敏规则在「效率工具 → AI脱敏」里配置（识别类型 / 固定关键词 / 数值是否脱敏）。
        </div>
        <div class="row" style="justify-content:flex-end;gap:6px">
          <button class="small" @click="close">取消</button>
          <button class="small" @click="send(false)">不脱敏，直接发送</button>
          <button class="primary" :disabled="loading" @click="preview">{{ loading ? '预演中…' : '先脱敏再发送' }}</button>
        </div>
      </div>
    </div>

    <!-- 第二步：显示对照表，确认后再发 -->
    <div v-if="phase === 'preview'" class="modal-backdrop" @click.self="phase = 'ask'">
      <div class="modal" style="width:min(720px,94vw);max-height:86vh;overflow-y:auto">
        <h3>脱敏对照表 <span class="muted" style="font-weight:400;font-size:12.5px">{{ mapping.length }} 项 · AI 只看到右列代码</span></h3>
        <div v-if="err" class="msg err">{{ err }}</div>
        <template v-else>
          <div v-if="disabled" class="muted">
            AI脱敏总开关是关的（在「效率工具 → AI脱敏」里打开），本次将原样发送。
          </div>
          <div v-else-if="!mapping.length" class="muted">没有识别到需要替换的专有名词，本次将原样发送。</div>
          <table v-else class="tb">
            <thead><tr><th>类型</th><th>原名</th><th>随机代码</th></tr></thead>
            <tbody>
              <tr v-for="(m, i) in mapping" :key="i">
                <td><span class="badge blue">{{ typeLabel(m.type) }}</span></td>
                <td>{{ m.term }}</td>
                <td><code>{{ m.code }}</code></td>
              </tr>
            </tbody>
          </table>
          <details style="margin-top:12px">
            <summary class="muted" style="cursor:pointer">看看脱敏后要发给 AI 的文本</summary>
            <pre class="out">{{ maskedPreview }}</pre>
          </details>
        </template>
        <div class="row" style="margin-top:14px;justify-content:flex-end;gap:6px">
          <button class="small" @click="phase = 'ask'">返回</button>
          <button class="primary" :disabled="loading" @click="send(true)">{{ loading ? '发送中…' : '确认发送' }}</button>
        </div>
      </div>
    </div>

    <!-- 第三步：结果（原行为不变） -->
    <div v-if="phase === 'result'" class="modal-backdrop" @click.self="close">
      <div class="modal" style="width:min(720px,94vw); max-height:86vh; overflow-y:auto">
        <h3>AI {{ labelOf(cur) }}<span v-if="masked" class="badge green" style="margin-left:8px">已脱敏还原</span></h3>
        <div v-if="err" class="msg err">{{ err }}</div>
        <div v-else class="markdown-body" style="max-height:46vh; overflow:auto; border:1px solid var(--border); border-radius:8px; padding:10px 12px; background:var(--bg3)"
             v-html="rendered" />
        <div class="row" style="margin-top:12px; justify-content:flex-end; gap:6px">
          <span class="muted small" style="margin-right:auto">{{ model }}<template v-if="usage"> · {{ usage.total_tokens || 0 }} tokens</template></span>
          <button class="small" :disabled="!result" @click="copy">复制</button>
          <button class="small" :disabled="!result" @click="$emit('replace-text', result); close()">替换正文</button>
          <button class="primary" :disabled="!result" @click="$emit('insert-text', result); close()">插入到光标处</button>
          <button @click="close">关闭</button>
        </div>
      </div>
    </div>
  </span>
</template>

<script setup>
// AI 辅助写作（v1.9.41 插件之一）：总结 / 续写 / 翻译。
// 结果**不落库**，由使用者决定插入还是替换 —— AI 直接改正文是很容易让人丢稿的设计。
//
// v1.13.0：点按钮先弹「发送前确认」——可选「直接发送」或「先脱敏再发送」。选了脱敏就走
// /ai-assist/preview 拿对照表给用户过目，确认后再带 session_id 调 /ai-assist（服务端用那份
// 已脱敏的文本发 AI、返回前复原真名）。不带 session_id 时后端行为与本功能上线前逐字一致。
import { ref, computed } from 'vue';
import { api } from '../../api';
import { renderMarkdown } from '../../utils/markdown';
import { copyText } from '../../utils/noteShare';

const props = defineProps({
  note: { type: Object, required: true },
  disabled: { type: Boolean, default: false },
  // 翻译优先用选中文本（没有就用全文），由外壳把编辑器的选区喂进来
  getSelection: { type: Function, default: () => '' },
});
const emit = defineEmits(['insert-text', 'replace-text']);

const ACTIONS = [
  { k: 'summarize', t: 'AI 总结', title: '总结这篇笔记的要点（150 字内）' },
  { k: 'continue', t: '续写', title: '顺着正文往下写' },
  { k: 'translate', t: '翻译', title: '翻译成英文（有选中就只翻选中的）' },
];
const labelOf = (k) => (ACTIONS.find((a) => a.k === k) || {}).t || '';
const typeLabel = (k) => ({ org: '公司', person: '人名', dept: '部门', group: '群名', acct: '账号', pwd: '密码', apikey: 'KEY', email: '邮箱', phone: '手机', idcard: '身份证', custom: '自定义', numbers: '数值' }[k] || k);

const phase = ref('');         // '' | ask | preview | result
const loading = ref(false);
const cur = ref('');
const result = ref('');
const err = ref('');
const model = ref('');
const usage = ref(null);
const masked = ref(false);
const sessionId = ref(0);
const mapping = ref([]);
const maskedPreview = ref('');
const disabled = ref(false);   // 总开关关着（服务端如实回报，不当成「没识别到」糊过去）
const rendered = computed(() => renderMarkdown(result.value || '', { wikiStyle: 'plain' }));

// 本次要发给 AI 的文本：翻译优先用选中文本，其余用全文（与后端 buildAssistPrompt 同口径）
function bodyFor(action) {
  const body = { action };
  if (action === 'translate') {
    const sel = props.getSelection ? String(props.getSelection() || '') : '';
    if (sel.trim()) body.selection = sel;
  }
  return body;
}

function start(action) {
  if (props.disabled || loading.value) return;
  cur.value = action;
  err.value = ''; result.value = ''; model.value = ''; usage.value = null;
  masked.value = false; sessionId.value = 0; mapping.value = []; maskedPreview.value = ''; disabled.value = false;
  phase.value = 'ask';
}
function close() { if (!loading.value) phase.value = ''; }

// 第一步的「先脱敏再发送」：只预演，不调 AI
async function preview() {
  if (loading.value) return;
  loading.value = true; err.value = '';
  try {
    const r = await api.post(`/notes/${props.note.id}/ai-assist/preview`, bodyFor(cur.value));
    mapping.value = r.mapping || [];
    maskedPreview.value = r.masked_preview || '';
    sessionId.value = r.session_id || 0;
    disabled.value = !!r.disabled;
    phase.value = 'preview';
  } catch (e) { err.value = e.message || '脱敏预演失败'; }
  finally { loading.value = false; }
}

async function send(useMask) {
  if (loading.value) return;
  loading.value = true; err.value = '';
  try {
    const body = bodyFor(cur.value);
    if (useMask && sessionId.value) body.session_id = sessionId.value;
    const r = await api.post(`/notes/${props.note.id}/ai-assist`, body);
    result.value = r.result || '';
    model.value = r.model || '';
    usage.value = r.usage || null;
    masked.value = !!r.masked;
    phase.value = 'result';
  } catch (e) {
    err.value = e.message || 'AI 调用失败';
    // 预演阶段出错就留在预演弹窗（能看到错因），否则落到结果弹窗
    phase.value = phase.value === 'preview' ? 'preview' : 'result';
  } finally { loading.value = false; }
}

async function copy() {
  const ok = await copyText(result.value);
  if (!ok) alert('复制失败，请手动选中复制');
}
</script>

<style scoped>
.ai-wrap { display: inline-flex; gap: 4px; }
.tb { width: 100%; border-collapse: collapse; font-size: 13px; }
.tb th, .tb td { border-bottom: 1px solid var(--border); padding: 6px 10px; text-align: left; vertical-align: top; }
.tb th { color: var(--text2); font-weight: 600; font-size: 12px; }
.tb code { background: var(--bg3); border-radius: 4px; padding: 1px 6px; font-size: 12px; }
.out { white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto; margin-top: 8px;
  border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; background: var(--bg3);
  font-size: 12px; line-height: 1.6; }
</style>
