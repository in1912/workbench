<template>
  <!-- 数字人手机模型浮层（v1.12.0）：最外层、页面最右侧；高度自适应视口（上下留出顶栏与右下角搜索框），
       画面比例以视频宽度为准（aspect-ratio 按人设配置，width:100% 时高度自定），
       绝不遮住右下角搜索框（bottom 起在搜索框上方）。 -->
  <div class="dh-phone-wrap">
    <div class="dh-phone">
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

      <!-- 画面区：实时视频位（v1 以首图占位；比例=视频宽度×人设 aspect，随宽度自适应高度） -->
      <div class="dhp-stage" :style="{ aspectRatio: aspectCss }">
        <img v-if="frontImg" class="dhp-video" :src="imgSrc(frontImg)" alt="" draggable="false" />
        <div v-else class="dhp-stage-empty">先去「智能家居 → 数字人 → 设置」上传参考图</div>
        <div class="dhp-live"><i></i>实时画面：配置 Vivix API Key 并通过连通测试后接入</div>
        <div v-if="persona" class="dhp-caption">{{ persona.persona.opening }}</div>
      </div>

      <!-- 对话区：气泡（对方=语音气泡样式预留，v1 文字试聊走工作台 AI） -->
      <div class="dhp-chat" ref="chatEl">
        <div v-if="!items.length" class="dhp-chat-empty">还没有对话，跟{{ persona ? persona.name : 'TA' }}说句话吧</div>
        <div v-for="m in items" :key="m.id" class="dhp-row" :class="m.role">
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

      <!-- 输入区 -->
      <div class="dhp-input">
        <input v-model="text" :disabled="!persona || sending" placeholder="说点什么…"
          @keyup.enter="send" />
        <button :disabled="!persona || sending || !text.trim()" @click="send">
          <span class="material-icons" style="font-size:16px">send</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick } from 'vue';
import { api, rawUrl } from '../api';
import { dhState, dhDefault, dhRefresh } from '../dhState';

const persona = computed(() => dhDefault());
const frontImg = computed(() => (persona.value && persona.value.images.length ? persona.value.images[0] : null));
// 画面比例以宽度为准：9:16→9/16、16:9→16/9、1:1→1（CSS aspect-ratio）
const aspectCss = computed(() => {
  const a = persona.value ? persona.value.persona.aspect : '16:9';
  const [w, h] = a.split(':').map(Number);
  return Number.isFinite(w) && Number.isFinite(h) && h ? `${w} / ${h}` : '16 / 9';
});

const items = ref([]);
const text = ref('');
const sending = ref(false);
const chatEl = ref(null);

function imgSrc(im) { return rawUrl(im.url); }
function close() { dhState.phoneOpen = false; }

async function loadHistory() {
  if (!persona.value) return;
  try {
    const r = await api.get('/dh/history?persona_id=' + persona.value.id + '&limit=100');
    items.value = r.items || [];
    scrollBottom();
  } catch { /* 静默 */ }
}

async function send() {
  const t = text.value.trim();
  if (!t || !persona.value || sending.value) return;
  sending.value = true;
  items.value.push({ id: 'u' + Date.now(), role: 'user', text: t });
  text.value = '';
  scrollBottom();
  try {
    const r = await api.post('/dh/chat', { persona_id: persona.value.id, text: t });
    if (r.user) items.value.push(r.user);
    if (r.assistant) items.value.push(r.assistant);
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
});
</script>

<style scoped>
/* 定位：最外层、页面最右侧；上不碰顶栏（top:68px）、下不遮右下角搜索框（bottom:76px），
   高度自适应视口；宽屏右侧约 2/5 空白区正好容纳 */
.dh-phone-wrap {
  position: fixed; right: 16px; top: 68px; bottom: 76px; z-index: 1145;
  display: flex; align-items: flex-end; pointer-events: none;
}
.dh-phone {
  pointer-events: auto;
  width: min(320px, calc(100vw - 32px));
  max-height: 100%;
  display: flex; flex-direction: column;
  background: var(--bg2, #fff); color: var(--text, #222);
  border: 1px solid var(--border, rgba(128,128,128,.3)); border-radius: 22px;
  box-shadow: 0 14px 48px rgba(0,0,0,.4);
  overflow: hidden;
}

/* 顶部 */
.dhp-head { display: flex; align-items: center; gap: 9px; padding: 10px 12px; border-bottom: 1px solid var(--border, rgba(128,128,128,.2)); flex-shrink: 0; }
.dhp-avatar { width: 34px; height: 34px; border-radius: 50%; object-fit: cover; background: rgba(128,128,128,.2); }
.dhp-avatar-empty { display: inline-flex; align-items: center; justify-content: center; color: var(--muted); font-size: 19px; }
.dhp-title { flex: 1; min-width: 0; line-height: 1.3; }
.dhp-title b { font-size: 14px; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dhp-title small { font-size: 11px; color: var(--muted); display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dhp-close { border: none; background: transparent; color: var(--muted); font-size: 15px; cursor: pointer; padding: 4px 7px; border-radius: 7px; }
.dhp-close:hover { background: rgba(128,128,128,.15); color: var(--text); }

/* 画面区：视频比例以宽度为准（aspect-ratio 随人设），超高时限高滚动不影响手机总高 */
.dhp-stage { position: relative; width: 100%; flex-shrink: 0; max-height: 46%; overflow: hidden; background: #000; }
.dhp-video { width: 100%; height: 100%; object-fit: cover; display: block; }
.dhp-stage-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #aaa; font-size: 12px; padding: 12px; text-align: center; }
.dhp-live { position: absolute; left: 8px; top: 8px; font-size: 10.5px; color: #fff; background: rgba(0,0,0,.5); border-radius: 8px; padding: 2px 8px; }
.dhp-live i { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #ec6496; margin-right: 5px; animation: dhpPulse 1.6s infinite; }
@keyframes dhpPulse { 0%,100% { opacity: .35; } 50% { opacity: 1; } }
.dhp-caption { position: absolute; left: 10px; bottom: 8px; right: 10px; font-size: 12.5px; color: #fff;
  background: rgba(0,0,0,.45); border-radius: 9px; padding: 4px 10px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 对话区 */
.dhp-chat { flex: 1; min-height: 70px; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
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
