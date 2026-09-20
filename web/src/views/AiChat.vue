<template>
  <div>
    <h2 class="page-title">AI 助手</h2>
    <div class="ai-chat-layout">
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
            </div>
          </div>
          <div v-if="aiBusy" class="muted">处理中...</div>
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
        <div class="row">
          <textarea v-model="aiInput" rows="2" placeholder="问任何问题；或输入业务 Skill 的引导词执行任务..." class="grow"
                    @keydown.ctrl.enter="sendChat" @keydown.meta.enter="sendChat"></textarea>
          <div style="display:flex; flex-direction:column; gap:6px">
            <button class="small" style="align-self:stretch" title="上传文件或图片给 AI" @click="$refs.attInput.click()" :disabled="attBusy">{{ attBusy ? '解析中...' : '📎 附件' }}</button>
            <button class="primary" style="align-self:stretch" @click="sendChat" :disabled="aiBusy">发送</button>
          </div>
          <input ref="attInput" type="file" style="display:none" @change="onAttChange" multiple />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, nextTick, onMounted, computed } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';

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
async function sendChat() {
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
  aiInput.value = '';
  aiBusy.value = true;
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
      body: JSON.stringify({ messages: payload, session_id: currentId.value, stream: true }),
      signal: AbortSignal.timeout(300000),
    });
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `请求失败 (${res.status})`);
    }
    let acc = '';
    msgs.value.push({ role: 'assistant', content: '' });
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
          if (d.delta) { acc += d.delta; msgs.value[msgs.value.length - 1].content = acc; }
          if (d.done) doneInfo = d;
        } catch { /* 忽略 */ }
      }
      await nextTick();
      scrollBottom();
    }
    // 兜底：流结束时若 acc 为空但服务端返回了内容
    if (!acc && doneInfo?.content) acc = doneInfo.content;
    if (!acc) throw new Error('AI 返回内容为空，请重试一次');
    msgs.value[msgs.value.length - 1].content = acc;
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
    await nextTick();
    scrollBottom();
  }
}
function scrollBottom() {
  chatBox.value?.scrollTo({ top: chatBox.value.scrollHeight });
}

onMounted(async () => {
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
</script>

<style scoped>
.ai-chat-layout { display: grid; grid-template-columns: 230px 1fr; gap: 14px; align-items: start; }
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
@media (max-width: 700px) {
  .ai-chat-layout { grid-template-columns: 1fr; }
  .ai-sidebar { max-height: 180px; }
  .ai-chat-main { height: calc(100vh - 260px); }
}
</style>
