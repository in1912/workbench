<template>
  <!-- v1.12.4：原独立「AI 助手」页整页并入「人工智能」页的 llm 子 tab（改名「LLM在线模型」）。
       外层 SmartHome 已画页面标题，这里不再带自己的 page-title；组件内部逻辑原样。
       v1.13.1：接入 AI 脱敏 —— 【脱敏】按钮 + 右侧功能框（说明/规则/本轮对照关系）、
       气泡显示脱敏进度与复原结果、【发送】改名【回传】、Ctrl+回车 = 直接勾选脱敏发送。 -->
  <div>
    <div class="ai-chat-layout" :class="{ 'with-panel': desensOpen }">
      <!-- 会话列表 -->
      <div class="ai-sidebar">
        <button class="primary" style="width:100%; margin-bottom:10px" @click="newSession">＋ 新建对话</button>
        <div v-for="s in sessions" :key="s.id" class="ai-session" :class="{ active: s.id === currentId }" @click="openSession(s.id)">
          <div class="t">{{ s.title }}</div>
          <div class="d">{{ s.msg_count }} 条 · {{ (s.updated_at || '').slice(5, 16) }}</div>
          <button class="icon-btn ai-del" title="删除" @click.stop="delSession(s.id)">✕</button>
        </div>
        <div v-if="!sessions.length" class="muted" style="padding:10px; text-align:center">暂无对话记录</div>
      </div>

      <!-- 聊天区 -->
      <div class="card ai-chat-main">
        <div class="ai-chat-head">
          <div style="font-weight:600; font-size:14px">
            {{ currentTitle || '新对话' }}
            <button v-if="currentId" class="link small" style="margin-left:8px" @click="renameSession">重命名</button>
          </div>
          <div class="muted" style="font-size:12px">
            模型：<b>{{ stats.model || '未配置' }}</b> ·
            上下文：{{ stats.context_tokens.toLocaleString() }} tokens / {{ (stats.context_limit / 1000).toLocaleString() }}k
            <span v-if="stats.context_limit" style="color:var(--accent)">（{{ stats.percent }}%）</span>
          </div>
        </div>
        <div ref="chatBox" class="ai-chat-body">
          <div v-for="(m, i) in msgs" :key="i" style="display:flex; gap:10px; margin-bottom:12px"
               :style="{ flexDirection: m.role === 'user' ? 'row-reverse' : 'row' }">
            <span class="avatar" :style="m.role === 'user' ? 'background:rgba(79,124,247,.2); color:#8fb0ff' : 'background:rgba(45,212,191,.15); color:var(--accent2)'">
              {{ m.role === 'user' ? '我' : 'AI' }}
            </span>
            <div style="background:var(--bg3); padding:10px 14px; border-radius:12px; max-width:78%; white-space:pre-wrap; font-size:13.5px">
              <div v-if="m.image" style="margin-bottom:8px">
                <img :src="m.image" style="max-width:260px; max-height:200px; border-radius:8px; display:block" />
              </div>
              <div v-if="m.attNames && m.attNames.length" class="muted" style="font-size:11.5px; margin-bottom:6px">📎 {{ m.attNames.join('、') }}</div>
              {{ m.content }}
              <div v-if="m.maskCount" class="wm-badge" :class="m.role === 'user' ? 'in' : 'out'">
                {{ m.role === 'user' ? `🔒 已脱敏 ${m.maskCount} 项` : `🔓 已按对照表复原 ${m.maskCount} 项` }}
              </div>
              <div v-else-if="m.role === 'assistant' && m.maskSkipped" class="wm-badge warn">⚠️ {{ m.maskSkipped }}</div>
            </div>
          </div>
          <!-- 脱敏加密 / 复原的过程提醒：跟 AI 气泡同款排版，让用户知道「现在走到哪一步了」 -->
          <div v-if="aiBusy" class="ai-stage-wrap">
            <span class="avatar" style="background:rgba(45,212,191,.15); color:var(--accent2)">AI</span>
            <div class="ai-stage">{{ stage || '处理中...' }}</div>
          </div>
          <div v-if="!msgs.length" class="muted" style="text-align:center; padding:40px 0">
            输入问题开始对话；输入业务 Skill 引导词可直接执行任务。
          </div>
        </div>
        <!-- 附件暂存区 -->
        <div v-if="attachments.length" class="row" style="flex-wrap:wrap; gap:6px; margin-bottom:8px">
          <span v-for="(a, i) in attachments" :key="i" class="badge blue" style="cursor:pointer; display:inline-flex; align-items:center; gap:4px" @click="attachments.splice(i, 1)" title="点击移除">
            {{ a.kind === 'image' ? '🖼' : '📄' }} {{ a.name }} ✕
          </span>
        </div>
        <div class="row" style="align-items:stretch">
          <textarea v-model="aiInput" rows="2" placeholder="问任何问题；或输入业务 Skill 的引导词执行任务...（Ctrl+回车 = 直接脱敏发送）" class="grow"
                    style="align-self:stretch"
                    @keydown.ctrl.enter.prevent="sendChat(true)" @keydown.meta.enter.prevent="sendChat(true)"></textarea>
          <!-- 三个按钮同尺寸（用户要求：附件/脱敏与回传一样大） -->
          <div class="ai-btns">
            <button style="align-self:stretch; white-space:nowrap" title="上传文件或图片给 AI" @click="$refs.attInput.click()" :disabled="attBusy">{{ attBusy ? '解析中...' : '📎 附件' }}</button>
            <button class="mask-btn" :class="{ on: maskOn }" style="align-self:stretch; white-space:nowrap"
                    :title="maskOn ? '本轮已勾选脱敏，点击取消（右侧说明框用 ✕ 收起）' : '勾选后，发出的内容先脱敏、回复再复原；同时展开右侧说明框'"
                    @click="toggleMask">{{ maskOn ? '🔒 脱敏 ✓' : '🔒 脱敏' }}</button>
            <button class="primary" style="align-self:stretch; white-space:nowrap" @click="sendChat(false)" :disabled="aiBusy">回传</button>
          </div>
          <input ref="attInput" type="file" style="display:none" @change="onAttChange" multiple />
        </div>
      </div>

      <!-- 脱敏功能框（点【脱敏】按钮在右侧空白处展开） -->
      <AiDesensPanel v-if="desensOpen" :open="desensOpen" :types="dmeta.types" :cfg="dmeta.cfg"
                     :mapping="lastMapping" :count="lastCount" :skipped="lastSkipped"
                     @close="closePanel" />
    </div>
  </div>
</template>

<script setup>
import { ref, nextTick, onMounted, onUnmounted, watch, inject } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';
import AiDesensPanel from '../components/AiDesensPanel.vue';

const route = useRoute();
const sessions = ref([]);
const msgs = ref([]);
const currentId = ref(0);
const currentTitle = ref('');
const aiInput = ref('');
const aiBusy = ref(false);
const chatBox = ref(null);
const stats = ref({ model: '', context_tokens: 0, context_limit: 1000000, percent: 0 });
// 附件：{ kind: 'text'|'image', name, text?, url? }
const attachments = ref([]);
const attBusy = ref(false);

// ---- AI 脱敏（v1.13.1）----
const LS_MASK = 'aiChat.mask';
const LS_PANEL = 'aiChat.desensOpen';
const maskOn = ref(false);          // 本轮是否勾选脱敏（按钮状态）
const desensOpen = ref(false);      // 右侧功能框是否展开
const stage = ref('');              // 气泡上方的过程进度提醒
const dmeta = ref({ types: [], cfg: {} });
const lastMapping = ref([]);        // 本轮对照关系
const lastCount = ref(0);
const lastSkipped = ref('');        // 本轮没有对照关系的原因（未勾选 / 总开关关闭）

async function loadDesensMeta() {
  try {
    const d = await api.get('/ai/desensitize-meta');
    dmeta.value = {
      types: d.types || [],
      cfg: { ready: true, enabled: d.enabled, mask_numbers: d.mask_numbers, types: d.types_on || {}, fixed_count: d.fixed_count || 0 },
    };
  } catch (e) { /* 拿不到就只影响右边的规则摘要显示 */ }
}

// 面板展开时才解除 .main 的 1200px 封顶（同 lifeOS 领域/关系/知识地图页的 wbMainFull）
const mainFull = inject('wbMainFull', null);

// 点【脱敏】= 勾选/取消脱敏，并**同时**把右侧功能框延伸出来 / 收起（用户要求：按钮就在【回传】
// 旁边，一按右边多出说明与规则、以及本轮的对照关系）。两者的状态始终一致——勾着就有框、
// 取消就没框，不会出现「勾着但看不见对照」或「框还开着但已经不脱敏了」这种对不上的状态；
// 框上的 ✕ 与再点一次按钮同义。
function toggleMask() {
  maskOn.value = !maskOn.value;
  desensOpen.value = maskOn.value;
}
function closePanel() {
  desensOpen.value = false;
  maskOn.value = false;
}
watch(desensOpen, (v) => {
  if (mainFull) mainFull.value = !!v;
  localStorage.setItem(LS_PANEL, v ? '1' : '0');
});

async function onAttChange(e) {
  const list = [...(e.target.files || [])]; // 先快照：清空 value 会连带清空 FileList（Chrome 活对象）
  e.target.value = '';
  if (!list.length) return;
  attBusy.value = true;
  for (const f of list) {
    try {
      const fd = new FormData();
      fd.append('file', f);
      const r = await fetch('/api/ai/attachment', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + (localStorage.getItem('wb_token') || '') },
        body: fd,
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `上传失败 (${r.status})`);
      attachments.value.push(d);
    } catch (err) {
      alert(`「${f.name}」上传失败：${err.message}`);
    }
  }
  attBusy.value = false;
}

async function loadSessions() {
  try {
    const d = await api.get('/ai/sessions');
    sessions.value = d.sessions || [];
  } catch (e) { /* 忽略 */ }
}
async function openSession(id) {
  currentId.value = id;
  const d = await api.get(`/ai/sessions/${id}`);
  msgs.value = d.messages || [];
  currentTitle.value = d.session?.title || '';
  await refreshStats(id);
  await nextTick();
  scrollBottom();
}
async function refreshStats(id) {
  try {
    const s = await api.get(`/ai/sessions/${id}/stats`);
    stats.value = s;
  } catch (e) { /* 忽略 */ }
}
async function newSession() {
  const title = prompt('对话主题（回车使用默认）：');
  const r = await api.post('/ai/sessions', { title: title || '' });
  await loadSessions();
  await openSession(r.id);
}
async function delSession(id) {
  if (!confirm('删除该对话及其全部记录？')) return;
  await api.del(`/ai/sessions/${id}`);
  if (currentId.value === id) { currentId.value = 0; msgs.value = []; currentTitle.value = ''; stats.value = { model: '', context_tokens: 0, context_limit: 1000000, percent: 0 }; }
  await loadSessions();
}
async function renameSession() {
  const title = prompt('新的对话主题：', currentTitle.value);
  if (!title) return;
  await api.post(`/ai/sessions/${currentId.value}/title`, { title });
  currentTitle.value = title;
  await loadSessions();
}
// forceMask=true（Ctrl+回车）= 不管按钮状态，本轮直接脱敏发送
async function sendChat(forceMask = false) {
  const useMask = !!forceMask || maskOn.value;
  // Ctrl+回车 = 直接勾选【脱敏】并发出去（用户要求）——按钮与右侧功能框一起进到勾选态，
  // 这样发完立刻能在框里看到本轮的对照关系。
  if (forceMask) { maskOn.value = true; desensOpen.value = true; }
  const text = aiInput.value.trim();
  if ((!text && !attachments.value.length) || aiBusy.value) return;
  // 有附件：构造多模态 content（文本附件并入正文、图片走 image_url）
  const atts = attachments.value.splice(0);
  let userContent = text;
  let firstImage = null;
  const textAtts = [];
  for (const a of atts) {
    if (a.kind === 'image' && !firstImage) firstImage = a.url;
    else if (a.kind === 'image') {
      // 多图：并入文本描述（多数网关只支持单图，保守处理）
      textAtts.push(`[图片附件: ${a.name}]`);
    } else {
      textAtts.push(`【附件：${a.name}】\n${a.text}`);
    }
  }
  if (textAtts.length) userContent = (text ? text + '\n\n' : '') + textAtts.join('\n\n');
  const localMsg = { role: 'user', content: userContent, attNames: atts.map((a) => a.name) };
  if (firstImage) localMsg.image = firstImage;
  msgs.value.push(localMsg);
  const userIdx = msgs.value.length - 1;
  aiInput.value = '';
  aiBusy.value = true;
  // 每轮开始时重置右侧「本轮对照关系」
  lastMapping.value = [];
  lastCount.value = 0;
  lastSkipped.value = useMask ? '' : '本轮没有勾选脱敏，内容已原文发送（不会生成对照关系）。';
  stage.value = useMask ? '🔒 正在按规则脱敏…' : '处理中...';
  let maskApplied = false;
  scrollBottom();
  try {
    // 发送最近 6 条上下文（含刚加入的用户消息）；流式接收（SSE），推理模型边思考边输出
    const payload = msgs.value.slice(-6).map((m) => {
      if (m.role === 'user' && m.image) {
        // 多模态消息：text + image_url（OpenAI vision 格式）
        return {
          role: 'user',
          content: [
            { type: 'text', text: m.content },
            { type: 'image_url', image_url: { url: m.image } },
          ],
        };
      }
      return { role: m.role, content: m.content };
    });
    const token = localStorage.getItem('wb_token') || '';
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ messages: payload, session_id: currentId.value, stream: true, desensitize: useMask }),
      signal: AbortSignal.timeout(300000),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `请求失败 (${res.status})`);
    }
    let acc = '';
    msgs.value.push({ role: 'assistant', content: '' });
    const asstIdx = msgs.value.length - 1;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let doneInfo = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const json = line.slice(5).trim();
        if (!json) continue;
        try {
          const d = JSON.parse(json);
          // 服务端先把对照表发过来（面板立即显示本轮对照关系）
          if (d.mask) {
            if (d.mask.skipped) {
              lastSkipped.value = d.mask.reason || '脱敏已跳过';
              stage.value = '⚠️ ' + lastSkipped.value;
            } else {
              const cnt = Number(d.mask.count) || 0;
              lastMapping.value = d.mask.mapping || [];
              lastCount.value = cnt;
              maskApplied = cnt > 0;
              if (maskApplied) {
                msgs.value[userIdx].maskCount = cnt;
                stage.value = `🔒 已脱敏 ${cnt} 项，正在发送给在线模型…`;
              } else {
                stage.value = '未发现需要脱敏的内容，已原文发送…';
              }
            }
          }
          if (d.delta) {
            acc += d.delta;
            msgs.value[asstIdx].content = acc;
            if (maskApplied && stage.value.startsWith('🔒')) stage.value = '🔓 正在按对照表复原…';
          }
          if (d.done) doneInfo = d;
        } catch { /* 忽略 */ }
      }
      await nextTick();
      scrollBottom();
    }
    // 兜底：流结束时若 acc 为空但服务端返回了内容
    if (!acc && doneInfo?.content) acc = doneInfo.content;
    if (!acc) throw new Error('AI 返回内容为空，请重试一次');
    msgs.value[asstIdx].content = acc;
    if (maskApplied) msgs.value[asstIdx].maskCount = lastCount.value;
    if (doneInfo?.mask_skipped) {
      lastSkipped.value = doneInfo.mask_skipped;
      msgs.value[asstIdx].maskSkipped = doneInfo.mask_skipped;
    }
    // 刷新会话信息与统计
    const r = { session_id: doneInfo?.session_id || currentId.value };
    if (r.session_id && !currentId.value) currentId.value = r.session_id;
    if (r.session_id) {
      await refreshStats(r.session_id);
      await loadSessions();
      if (!currentTitle.value) {
        const d = await api.get(`/ai/sessions/${r.session_id}`);
        currentTitle.value = d.session?.title || '';
      }
    }
  } catch (e) {
    const msg = String(e.message || '');
    if (msg.includes('408') || msg.includes('timeout') || msg.includes('超时')) {
      msgs.value.push({ role: 'assistant', content: 'AI 响应超时（服务繁忙）。可稍后重发；流式输出已开启，通常不会出现此问题。' });
    } else {
      msgs.value.push({ role: 'assistant', content: '出错：' + msg });
    }
  } finally {
    aiBusy.value = false;
    stage.value = '';
    await nextTick();
    scrollBottom();
  }
}
function scrollBottom() {
  chatBox.value?.scrollTo({ top: chatBox.value.scrollHeight });
}

onMounted(async () => {
  if (mainFull) mainFull.value = desensOpen.value;
  // 勾选状态与功能框永远同进同出（上次勾着脱敏，重进这一页就把框一起还原出来）
  maskOn.value = localStorage.getItem(LS_MASK) === '1' || localStorage.getItem(LS_PANEL) === '1';
  desensOpen.value = maskOn.value;
  if (mainFull) mainFull.value = desensOpen.value;
  loadDesensMeta();
  // 默认显示配置的模型
  try {
    const cfg = await api.get('/ai/config');
    if (cfg.model) stats.value.model = cfg.model;
  } catch (e) { /* 忽略 */ }
  await loadSessions();
  const sid = Number(route.query.session) || 0;
  if (sid && sessions.value.some((s) => s.id === sid)) {
    await openSession(sid);
  }
});
watch(maskOn, (v) => localStorage.setItem(LS_MASK, v ? '1' : '0'));
onUnmounted(() => { if (mainFull) mainFull.value = false; });
</script>

<style scoped>
.ai-chat-layout { display: grid; grid-template-columns: 230px 1fr; gap: 14px; align-items: start; }
/* 脱敏框展开：右侧多一列（前面的尺寸一个都没缩——空出来的地方是原先 .main 的 1200px 封顶之外） */
.ai-chat-layout.with-panel { grid-template-columns: 230px minmax(380px, 1fr) 360px; }
/* 右侧空白够放下功能框时（190 侧栏 + 56 内边距 + 230 会话列 + 900 聊天列 + 360 面板 + 间距 ≈ 1764），
   聊天区**保持原有 900px 一分不让**（不写 1fr —— 否则窗口再宽一点聊天区就会被撑大，
   同样属于「动了现有尺寸」）。面板吃的是原先 1200px 封顶之外那片空白，多余的空隙留在最右边。
   窗口不够宽时退回上面的 minmax，面板从中间借宽度，绝不横向溢出。 */
@media (min-width: 1780px) {
  .ai-chat-layout.with-panel { grid-template-columns: 230px 900px 360px; justify-content: start; }
}
.ai-sidebar { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; max-height: calc(100vh - 140px); overflow-y: auto; }
.ai-session { position: relative; padding: 9px 26px 9px 10px; border-radius: 8px; cursor: pointer; margin-bottom: 4px; }
.ai-session:hover { background: var(--bg3); }
.ai-session.active { background: rgba(79,124,247,.15); }
.ai-session .t { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-session .d { font-size: 11px; color: var(--text3); margin-top: 2px; }
.ai-session .ai-del { position: absolute; right: 4px; top: 8px; font-size: 11px; opacity: .6; }
.ai-chat-main { display: flex; flex-direction: column; height: calc(100vh - 140px); }
.ai-chat-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--border); margin-bottom: 12px; flex-wrap: wrap; }
.ai-chat-body { flex: 1; overflow-y: auto; margin-bottom: 12px; }
/* 三个按钮一列：都 align-self:stretch，所以尺寸完全一致 */
.ai-btns { flex: 0 0 auto; display: flex; flex-direction: column; gap: 6px; }
.ai-btns .mask-btn.on { background: rgba(79,124,247,.18); border-color: var(--accent); color: #8fb0ff; }
.ai-stage-wrap { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; }
.ai-stage { background: var(--bg3); padding: 8px 14px; border-radius: 12px; font-size: 12.5px; color: var(--text2);
  animation: aiStagePulse 1.4s ease-in-out infinite; }
@keyframes aiStagePulse { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
.wm-badge { margin-top: 6px; font-size: 11px; padding-top: 5px; border-top: 1px dashed var(--border); color: var(--text3); }
.wm-badge.in { color: #8fb0ff; }
.wm-badge.out { color: var(--accent2); }
.wm-badge.warn { color: #e0a03a; }
@media (max-width: 700px) {
  .ai-chat-layout, .ai-chat-layout.with-panel { grid-template-columns: 1fr; }
  .ai-sidebar { max-height: 180px; }
  .ai-chat-main { height: calc(100vh - 260px); }
}
</style>
