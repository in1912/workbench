<template>
  <!-- 数字人手机模型浮层（v1.12.1）：最外层、页面最右侧；高度自适应视口（上下留出顶栏与右下角搜索框），
       画面为竖屏 9:16 并占满剩余高度（对话区让位、可被压缩），整机默认 460px 宽、
       左下角把手可拖拽自由拉宽（localStorage 记住），绝不遮住右下角搜索框。
       v1.12.1：打开即触发实时对话——配了 Vivix Key 自动建会话 + TRTC 拉流，输入走会话通道。 -->
  <div class="dh-phone-wrap">
    <div class="dh-phone" :style="{ width: phoneW + 'px' }">
      <!-- 顶部：人物名 + 类型 + 关闭 -->
      <div class="dhp-head">
        <img v-if="frontImg" class="dhp-avatar" :src="imgSrc(frontImg)" alt="" />
        <span v-else class="material-icons dhp-avatar dhp-avatar-empty">smart_toy</span>
        <div class="dhp-title">
          <b>{{ persona ? persona.name : '数字人' }}</b>
          <small>{{ persona ? persona.type + ' · ' + persona.persona.opening : '尚未配置' }}</small>
        </div>
        <button class="dhp-close" title="收起" @click="close">✕</button>
      </div>
      <!-- 左下角拖拽把手：向左拖变宽、向右拖变窄 -->
      <div class="dhp-resize" title="拖拽调整宽度" @pointerdown="startResize">↔</div>

      <!-- 画面区：竖屏 9:16，flex 占满剩余高度。v1.12.1 起打开悬浮窗即触发实时会话：
           配了 Vivix Key 自动建会话 + TRTC 拉流（视频顶替海报）；没配 Key 保持海报 + 文字试聊 -->
      <div class="dhp-stage">
        <img v-if="frontImg && !live.on" class="dhp-video" :src="imgSrc(frontImg)" alt="" draggable="false" />
        <div v-if="!frontImg && !live.on" class="dhp-stage-empty">先去「智能家居 → 数字人 → 设置」上传参考图</div>
        <!-- 实时画面容器（常驻 DOM，TRTC 往里塞 video） -->
        <div v-show="live.on" class="dhp-video-box" id="dh-live-view-phone"></div>
        <div class="dhp-live" :class="{ onair: live.on }"><i></i>{{ liveBadge }}</div>
        <button v-if="live.needResume" class="dhp-resume" @click="resumePlay">▶ 开启画面声音</button>
        <div v-if="live.err" class="dhp-live-err">⚠ {{ live.err }}</div>
        <div v-if="persona && !live.on" class="dhp-caption">{{ persona.persona.opening }}</div>
      </div>

      <!-- 对话区：气泡。实时会话期间显示本次会话的即时气泡；未开流时显示历史记录 -->
      <div class="dhp-chat" ref="chatEl">
        <div v-if="!shownItems.length" class="dhp-chat-empty">还没有对话，跟{{ persona ? persona.name : 'TA' }}说句话吧</div>
        <div v-for="m in shownItems" :key="m.id" class="dhp-row" :class="m.role">
          <!-- 对方说话：语音气泡样式（有 audio_file 时显示波纹；v1 文字先落文本气泡） -->
          <template v-if="m.role === 'assistant'">
            <img v-if="frontImg" class="dhp-mini-avatar" :src="imgSrc(frontImg)" alt="" />
            <div class="dhp-bubble" :class="{ voice: !!m.audio_file }" :title="m.audio_file ? '语音消息（播放待接入）' : ''">
              <template v-if="m.audio_file"><span class="dhp-wave"><i v-for="n in 7" :key="n"></i></span><span class="dhp-voice-len">{{ Math.ceil((m.text || '').length / 3) }}"</span></template>
              <template v-else>{{ m.text }}</template>
            </div>
          </template>
          <template v-else>
            <div class="dhp-bubble">{{ m.text }}</div>
          </template>
        </div>
        <div v-if="sending" class="dhp-row assistant"><span class="dhp-typing">…</span></div>
      </div>

      <!-- 输入区：实时会话中走 WSS（对方开口念出来），未开流走工作台 AI 文字试聊 -->
      <div class="dhp-input">
        <input v-model="liveText" :disabled="!persona || sending" :placeholder="live.on ? '打字对 TA 说…（对方会念出来）' : '说点什么…'"
          @keyup.enter="send" />
        <button :disabled="!persona || sending || !liveText.trim()" @click="send">
          <span class="material-icons" style="font-size:16px">send</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import { api, rawUrl } from '../api';
import { dhState, dhDefault, dhRefresh } from '../dhState';
import { useDhLive } from '../dhLive';

const persona = computed(() => dhDefault());
const frontImg = computed(() => (persona.value && persona.value.images.length ? persona.value.images[0] : null));

// 实时会话（v1.12.1）：与 DhPanel 数字人界面共用 dhLive composable（服务端建会话 → WSS + TRTC）
const { live, liveItems, liveText, startLive, stopLive, sendLive, resumePlay } = useDhLive({
  viewId: 'dh-live-view-phone',      // TRTC 渲染容器（模板里 #dh-live-view-phone）
  getPersona: () => persona.value,
});
// 角标文案：实时中（带状态）/ 配了 Key 未开 / 未配 Key 提示
const liveBadge = computed(() => {
  if (live.on) return '实时' + (live.status && live.status !== '实时' ? ' · ' + live.status : '');
  if (persona.value && persona.value.hasKey) return live.busy ? '实时 · 连接中…' : '实时 · 未开启';
  return '实时画面：配置 Vivix API Key 后自动接入';
});
// 显示哪份气泡：实时会话期间用本次会话的即时气泡（对方边说边出字），未开流用历史记录
const shownItems = computed(() => (live.on ? liveItems.value : items.value));

// 整机宽度：默认 460，可拖拽自由拉宽（clamp 到视口），localStorage 记住
const W_KEY = 'dhPhoneW';
const clampW = (w) => Math.min(Math.max(Number(w) || 460, 340), Math.max(340, window.innerWidth - 32));
const phoneW = ref(clampW(localStorage.getItem(W_KEY)));

function startResize(e) {
  e.preventDefault();
  const el = e.currentTarget;
  el.setPointerCapture(e.pointerId);
  const startX = e.clientX, startW = phoneW.value;
  const onMove = (ev) => { phoneW.value = clampW(startW + (startX - ev.clientX)); };
  const onUp = () => {
    el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp);
    localStorage.setItem(W_KEY, String(phoneW.value));
  };
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
}

const items = ref([]);
const sending = ref(false);
const chatEl = ref(null);

function imgSrc(im) { return rawUrl(im.url); }
// 收起悬浮窗：先把服务端会话显式关掉（烧额度的会话不挂机），再收窗
async function close() {
  await stopLive();
  dhState.phoneOpen = false;
}

async function loadHistory() {
  if (!persona.value) return;
  try {
    const r = await api.get('/dh/history?persona_id=' + persona.value.id + '&limit=100');
    items.value = r.items || [];
    scrollBottom();
  } catch { /* 静默 */ }
}

async function send() {
  // 实时会话中：走 WSS 通道（对方开口念出来，文字同步落历史）
  if (live.on) { await sendLive(); scrollBottom(); return; }
  const t = liveText.value.trim();
  if (!t || !persona.value || sending.value) return;
  sending.value = true;
  items.value.push({ id: 'u' + Date.now(), role: 'user', text: t });
  liveText.value = '';
  scrollBottom();
  try {
    const r = await api.post('/dh/chat', { persona_id: persona.value.id, text: t });
    if (r.user) items.value.push(r.user);
    if (r.assistant) items.value.push(r.assistant);
    dhState.histVer++; // 落库了，通知「聊天记录」页等其他入口重拉历史
  } catch (e) {
    items.value.push({ id: 'e' + Date.now(), role: 'assistant', text: '（' + e.message + '）' });
  } finally {
    sending.value = false;
    scrollBottom();
  }
}

function scrollBottom() {
  nextTick(() => { if (chatEl.value) chatEl.value.scrollTop = chatEl.value.scrollHeight; });
}

onMounted(async () => {
  if (!dhState.loaded) await dhRefresh();
  await loadHistory();
  // v1.12.1：打开悬浮窗即触发实时对话——配了 Key 自动建会话拉流（没配则保持海报+文字试聊）
  if (persona.value && persona.value.hasKey) startLive();
});
onBeforeUnmount(() => { stopLive(); }); // 组件卸载兜底（正常路径 close 已先关过）
// 「聊天记录」页那边发过消息（histVer 变化）→ 重拉，两处记录一致
watch(() => dhState.histVer, loadHistory);
// 实时气泡有新增（对方边说边出字）→ 跟着滚到底
watch(() => liveItems.value.length, () => scrollBottom());
</script>

<style scoped>
/* 定位：最外层、页面最右侧；上不碰顶栏（top:68px）、下不遮右下角搜索框（bottom:76px），
   高度自适应视口且撑满该区间；宽度由拖拽控制（默认 460px） */
.dh-phone-wrap {
  position: fixed; right: 16px; top: 68px; bottom: 76px; z-index: 1145;
  display: flex; pointer-events: none;
}
.dh-phone {
  pointer-events: auto;
  width: 460px; max-width: calc(100vw - 32px); height: 100%;
  display: flex; flex-direction: column; position: relative;
  background: var(--bg2, #fff); color: var(--text, #222);
  border: 1px solid var(--border, rgba(128,128,128,.3)); border-radius: 22px;
  box-shadow: 0 14px 48px rgba(0,0,0,.4);
  overflow: hidden;
}
/* 拖拽把手：左下角，向左拖变宽 */
.dhp-resize {
  position: absolute; left: 0; bottom: 0; width: 26px; height: 30px; z-index: 3;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; color: var(--muted); cursor: ew-resize; touch-action: none;
  border-top-right-radius: 8px; user-select: none; opacity: .55;
}
.dhp-resize:hover { opacity: 1; background: rgba(128,128,128,.14); }

/* 顶部 */
.dhp-head { display: flex; align-items: center; gap: 9px; padding: 10px 12px; border-bottom: 1px solid var(--border, rgba(128,128,128,.2)); flex-shrink: 0; }
.dhp-avatar { width: 34px; height: 34px; border-radius: 50%; object-fit: cover; background: rgba(128,128,128,.2); }
.dhp-avatar-empty { display: inline-flex; align-items: center; justify-content: center; color: var(--muted); font-size: 19px; }
.dhp-title { flex: 1; min-width: 0; line-height: 1.3; }
.dhp-title b { font-size: 14px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dhp-title small { font-size: 11px; color: var(--muted); display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dhp-close { border: none; background: transparent; color: var(--muted); font-size: 15px; cursor: pointer; padding: 4px 7px; border-radius: 7px; }
.dhp-close:hover { background: rgba(128,128,128,.15); color: var(--text); }

/* 画面区：竖屏 9:16，占满剩余高度（对话区可让位）；图片 cover 填满不变形 */
.dhp-stage { position: relative; width: 100%; flex: 1 1 auto; min-height: 0;
  aspect-ratio: 9 / 16; overflow: hidden; background: #000; }
.dhp-video { width: 100%; height: 100%; object-fit: cover; display: block; }
.dhp-stage-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #aaa; font-size: 12px; padding: 12px; text-align: center; }
.dhp-live { position: absolute; left: 8px; top: 8px; font-size: 10.5px; color: #fff; background: rgba(0,0,0,.5); border-radius: 8px; padding: 2px 8px; max-width: calc(100% - 16px); }
.dhp-live i { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #ec6496; margin-right: 5px; animation: dhpPulse 1.6s infinite; }
.dhp-live.onair { background: rgba(30,158,104,.88); }
.dhp-live.onair i { background: #fff; }
/* 实时画面（v1.12.1）：TRTC 渲染容器铺满画面区 */
.dhp-video-box { position: absolute; inset: 0; background: #000; }
.dhp-video-box :deep(video) { width: 100%; height: 100%; object-fit: cover; display: block; }
.dhp-resume { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  border: none; background: rgba(236,100,150,.92); color: #fff; border-radius: 999px; padding: 7px 16px;
  font-size: 12.5px; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.45); }
.dhp-live-err { position: absolute; left: 8px; right: 8px; bottom: 38px; font-size: 11px; line-height: 1.55;
  color: #ffc2cd; background: rgba(0,0,0,.66); border-radius: 8px; padding: 5px 9px; }
@keyframes dhpPulse { 0%,100% { opacity: .35; } 50% { opacity: 1; } }
.dhp-caption { position: absolute; left: 10px; bottom: 8px; right: 10px; font-size: 12.5px; color: #fff;
  background: rgba(0,0,0,.45); border-radius: 9px; padding: 4px 10px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 对话区：让位给画面（最多占 1/3，空对话时只留提示位） */
.dhp-chat { flex: 0 1 auto; min-height: 84px; max-height: 32%; overflow-y: auto;
  padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.dhp-chat-empty { color: var(--muted); font-size: 12px; text-align: center; margin: auto; padding: 10px; }
.dhp-row { display: flex; align-items: flex-end; gap: 6px; }
.dhp-row.user { justify-content: flex-end; }
.dhp-mini-avatar { width: 22px; height: 22px; border-radius: 50%; object-fit: cover; flex-shrink: 0; }
.dhp-bubble { max-width: 78%; padding: 6px 11px; border-radius: 12px; font-size: 13px; line-height: 1.5;
  word-break: break-word; white-space: pre-wrap; background: rgba(128,128,128,.16); border-top-left-radius: 4px; }
.dhp-row.user .dhp-bubble { background: rgba(79,124,247,.85); color: #fff; border-top-left-radius: 12px; border-top-right-radius: 4px; }
/* 语音气泡（微信样式）：波纹 + 时长，接入语音后点击可播 */
.dhp-bubble.voice { display: inline-flex; align-items: center; gap: 8px; min-width: 84px; cursor: pointer; }
.dhp-wave { display: inline-flex; align-items: center; gap: 2px; height: 14px; }
.dhp-wave i { width: 2.5px; border-radius: 2px; background: currentColor; opacity: .8; }
.dhp-wave i:nth-child(1) { height: 5px; } .dhp-wave i:nth-child(2) { height: 9px; } .dhp-wave i:nth-child(3) { height: 13px; }
.dhp-wave i:nth-child(4) { height: 8px; } .dhp-wave i:nth-child(5) { height: 12px; } .dhp-wave i:nth-child(6) { height: 6px; } .dhp-wave i:nth-child(7) { height: 10px; }
.dhp-voice-len { font-size: 11.5px; opacity: .85; }
.dhp-typing { padding: 6px 12px; border-radius: 12px; background: rgba(128,128,128,.16); font-size: 13px; color: var(--muted); }

/* 输入区 */
.dhp-input { display: flex; gap: 7px; padding: 9px 10px; border-top: 1px solid var(--border, rgba(128,128,128,.2)); flex-shrink: 0; }
.dhp-input input { flex: 1; min-width: 0; border: 1px solid var(--border, rgba(128,128,128,.3)); background: transparent;
  color: var(--text); border-radius: 9px; padding: 7px 11px; font-size: 13px; outline: none; }
.dhp-input input:focus { border-color: rgba(236,100,150,.6); }
.dhp-input button { border: none; background: rgba(236,100,150,.85); color: #fff; border-radius: 9px;
  width: 36px; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.dhp-input button:disabled { opacity: .45; cursor: default; }
</style>
