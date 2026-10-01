<template>
  <div>
    <h2 class="page-title">短消息</h2>
    <div v-if="msg" class="msg" :class="msgType">{{ msg }}</div>

    <div class="grid" style="grid-template-columns:260px 1fr; gap:14px; align-items:start">
      <!-- 成员列表 -->
      <div class="card">
        <h3>成员</h3>
        <div v-for="u in contacts" :key="u.id" class="list-item" :class="{ sel: cur === u.id }" style="cursor:pointer" @click="open(u.id)">
          <div class="grow">
            <div class="t">
              <span class="avatar" style="width:26px; height:26px; font-size:12px; margin-right:6px; vertical-align:middle">{{ avatarOf(u) }}</span>
              {{ nameOf(u) }}<span v-if="subOf(u)" class="muted" style="font-size:11px">（{{ subOf(u) }}）</span><span v-if="u.is_self" class="muted" style="font-size:11px">（我）</span>
            </div>
            <div class="d">{{ u.is_self ? '写给自己的备忘' : (u.is_bot ? '钉钉机器人 · 与机器人的钉钉会话' : (u.role === 'admin' ? '管理员' : '成员')) }}</div>
          </div>
          <span v-if="u.unread" class="badge red">{{ u.unread }}</span>
        </div>
        <div v-if="!contacts.length" class="empty">暂无成员（可在「用户管理」添加）</div>
      </div>

      <!-- 会话 + 发送 -->
      <div class="card">
        <template v-if="cur">
          <div class="row" style="justify-content:space-between; align-items:center; margin-bottom:10px">
            <h3 style="margin:0">
              {{ curIsSelf ? '写给自己的备忘' : `与 ${curName} 的沟通记录` }}
              <span v-if="curIsBot" class="badge blue" style="font-size:11px; vertical-align:middle">钉钉会话：在此发送 = 机器人发到你的钉钉（群消息则发回群里）</span>
            </h3>
            <button class="small" @click="markAllRead">全部已读</button>
          </div>
          <div ref="histEl" class="history" style="max-height:400px; overflow-y:auto; padding:4px; margin-bottom:12px" @scroll="onScroll" @load.capture="onImgLoad">
            <!-- 动态加载：默认只装最近 1 天，滚动条拉到顶部自动加载更早历史 -->
            <div v-if="hasMore" class="muted" style="text-align:center; font-size:12px; padding:6px 0; cursor:pointer" @click="loadOlder">
              {{ loadingOlder ? '加载更早消息中…' : '↑ 拉到顶部自动加载更早消息（点击也可加载）' }}
            </div>
            <div v-else-if="msgs.length" class="muted" style="text-align:center; font-size:12px; padding:6px 0">— 没有更早的消息了 —</div>
            <div v-for="m in msgs" :key="m.id" class="bubble" :class="{ mine: m.mine }">
              <div class="meta" style="font-size:11px; margin-bottom:3px">
                <b>{{ m.mine ? (curIsSelf ? '我·备忘' : '我') : m.from_name }}</b> · {{ m.created_at }}
                <span v-if="m.module !== 'message'" class="badge blue" style="font-size:10px; margin-left:4px">来自{{ m.module_label }}</span>
                <span v-if="m.mine && !curIsSelf && m.read_at" class="muted" style="margin-left:4px">已读</span>
                <span v-else-if="m.mine && !curIsSelf" class="muted" style="margin-left:4px">未读</span>
              </div>
              <div v-if="m.subject" style="font-size:13px; font-weight:600; margin-bottom:2px">{{ m.subject }}</div>
              <!-- 语音条（v1.9.24）：点击播放（可重复播放，微信式）；下方常驻转写文字/转写按钮 -->
              <div v-if="m.is_voice" class="voice-msg" :class="{ playing: playingId === m.id }" @click="playVoice(m)">
                <span class="vm-icon">{{ playingId === m.id ? '⏸' : '▶' }}</span>
                <span class="vm-bar" :style="{ width: (36 + Math.min(120, Math.ceil(m.voice_secs || 1) * 4)) + 'px' }"></span>
                <span class="vm-secs">{{ Math.ceil(m.voice_secs || 1) }}"</span>
              </div>
              <div v-else class="rich" style="font-size:13px; word-break:break-word" v-html="displayHtml(m.content)"></div>
              <div v-if="m.is_voice" class="vm-text">
                <template v-if="m.voice_text">{{ m.voice_text }}</template>
                <button v-else-if="m.voice_state === 'pending'" class="vm-tag" disabled>转写中…</button>
                <button v-else class="vm-tag" @click="retranscribe(m)">未转写 · 点我转文字</button>
                <!-- v1.9.25：转写溯源小字——所用模型 + 转写耗时 -->
                <div v-if="m.voice_text && m.voice_model" class="vm-meta">{{ m.voice_model }} · {{ (Math.max(0, m.voice_ms || 0) / 1000).toFixed(1) }} 秒转写</div>
              </div>
            </div>
            <div v-if="!msgs.length" class="empty" style="padding:30px 0">暂无沟通记录，发第一条消息吧</div>
          </div>
        </template>
        <div v-else class="empty" style="padding:14px 0">
          左侧点成员查看沟通记录，或直接在下方选收件人发送（可发给自己当备忘，可多选群发）。
          消息永久留存，未读会在右下角弹窗提醒。
        </div>

        <!-- 发送区（随时可用） -->
        <div class="form-row"><label>收件人（可搜索、多选、含自己{{ contacts.some((u) => u.is_bot) ? '，含钉钉机器人' : '' }}）</label><UserPicker v-model="recipients" :users="contacts" multiple include-bots placeholder="搜索并选择收件人…" /></div>
        <div class="form-row"><label>主题（可选）</label><input v-model="draft.subject" placeholder="消息主题" @keyup.enter="send" /></div>
        <div class="form-row"><label>内容（文字，或用下方按钮录语音）</label><textarea v-model="draft.content" rows="3" placeholder="输入消息内容…（Ctrl+Enter 发送）" @keydown.ctrl.enter="send"></textarea></div>
        <div class="row" style="align-items:center; gap:10px; flex-wrap:wrap; margin-top:2px">
          <button v-if="!recording" class="btn" :disabled="recBusy" @click="startRec">🎤 录语音</button>
          <template v-else>
            <span class="rec-live"><i></i> 录音中 {{ recSecs }}"（上限 60"，到时自动发送）</span>
            <button class="btn" @click="stopRec(true)">✔ 发送语音</button>
            <button class="btn ghost" @click="stopRec(false)">取消</button>
          </template>
          <span v-if="recBusy" class="muted" style="font-size:12px">语音处理中…</span>
          <span style="flex:1"></span>
          <button class="primary" :disabled="sending || recording" @click="send">{{ sending ? '发送中...' : '发送' }}</button>
        </div>
      </div>
    </div>

    <!-- 电脑桌面通知（v1.9.24）：装一个常驻代理，右下角弹窗=网页弹窗同款；点击=已读+打开消息页 -->
    <div class="card" style="margin-top:14px">
      <h3>电脑桌面通知（可选）</h3>
      <p class="muted" style="font-size:13px; margin:0 0 10px">
        在你的 Windows 电脑上装一个小代理（双击即装，无需管理员权限，随系统自动启动）：有新消息时从屏幕右下角弹窗提醒，
        内容与网页右下角弹窗一致；<b>点击弹窗任意位置 = 标记已读并自动打开浏览器进入消息页</b>。
        脚本按你当前打开工作台的网络路径内嵌地址——内网打开装的就是内网地址，外网打开装的就是外网地址（当前：<b>{{ locationOrigin }}</b>）。
      </p>
      <div class="row" style="align-items:center; gap:10px; flex-wrap:wrap">
        <button class="btn" @click="dlAgent('install')">下载安装脚本（notify-setup.cmd）</button>
        <button class="btn ghost" @click="dlAgent('uninstall')">下载卸载脚本</button>
        <label style="font-size:13px; display:flex; align-items:center; gap:6px; cursor:pointer">
          <input type="checkbox" v-model="autoplay" @change="saveAutoplay" /> 语音消息弹出时自动播放声音
        </label>
      </div>
      <p class="muted" style="font-size:12px; margin:10px 0 0">
        安装：下载后直接双击运行（SmartScreen 提示时选「更多信息 → 仍要运行」）；卸载随时双击卸载脚本即可。
        代理只连接你自己的工作台地址，语音消息在弹窗的同时直接播放（上面的勾选控制，默认开）。
      </p>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted } from 'vue';
import { api } from '../api';
import UserPicker from '../components/UserPicker.vue';
import { displayHtml } from '../utils/rich';

const msg = ref('');
const msgType = ref('ok');
function flash(text, type = 'ok') { msg.value = text; msgType.value = type; setTimeout(() => (msg.value = ''), 4000); }

const contacts = ref([]);
const cur = ref(0);
const msgs = ref([]);
// 动态加载状态：默认只装最近 1 天，hasMore=还有更早历史；histEl=会话滚动容器
const hasMore = ref(false);
const loadingOlder = ref(false);
const histEl = ref(null);
const recipients = ref([]); // 发送收件人（可多选、可含自己）
const draft = ref({ subject: '', content: '' });
const sending = ref(false);
const curUser = computed(() => contacts.value.find((u) => u.id === cur.value));
const curName = computed(() => (curUser.value ? nameOf(curUser.value) : ''));
const curIsSelf = computed(() => !!curUser.value?.is_self);
const curIsBot = computed(() => !!curUser.value?.is_bot);

// 显示名：中文姓名优先，空则回退用户名（与 UserPicker 一致）
function nameOf(u) { return (u?.display_name || '').trim() || u?.username || ''; }
// 次要标注：用户名（有姓名且不同时）· 昵称
function subOf(u) {
  const name = (u?.display_name || '').trim();
  const parts = [];
  if (name && name !== u.username) parts.push(u.username);
  if ((u?.nickname || '').trim()) parts.push(u.nickname.trim());
  return parts.join(' · ');
}
// 头像字：姓名/用户名首字（英文取大写首字母）
function avatarOf(u) {
  const name = (u?.display_name || '').trim() || u?.username || '?';
  return /[a-zA-Z]/.test(name[0]) ? name[0].toUpperCase() : name[0];
}

async function loadContacts() {
  try { contacts.value = (await api.get('/messages/contacts')).users || []; }
  catch { contacts.value = []; }
}
async function open(id) {
  cur.value = id;
  recipients.value = [id]; // 默认发给当前会话对象（可再改/加）
  try {
    // 接口默认只回最近 1 天（一天内没有则回落最近 50 条）；hasMore 表示还有更早历史可翻
    const r = await api.get(`/messages?user_id=${id}`);
    msgs.value = r.messages || [];
    hasMore.value = !!r.hasMore;
    // 接口取回即把对方发来的未读标已读（返回行是标记前的快照，read_at 为空 = 刚被标已读的）
    // 打开会话自动已读的只有对方发来的（自己的备忘不自动已读，弹窗保留到点「已读」）
    const justRead = msgs.value.filter((m) => !m.read_at && !m.mine).map((m) => m.id);
    if (justRead.length) window.dispatchEvent(new CustomEvent('wb-messages-read', { detail: { ids: justRead } }));
    await nextTick();
    stick = true;
    scrollToBottom(); // 最新一条在底部，打开会话直接看到
    // 会话里的图片（钉钉图床等）在 nextTick 之后才异步加载、撑高容器，会把视口顶回
    // 当天的第一条——延迟再贴一次底，图片 load 事件也会逐张补滚（见 onImgLoad）
    setTimeout(() => { if (stick && cur.value === id) scrollToBottom(); }, 350);
  } catch { msgs.value = []; hasMore.value = false; }
  await loadContacts(); // 刷新未读角标
}

// ---------- 动态加载（向上翻历史） ----------
// 贴底状态：视口在底部附近才自动跟滚（新消息/图片加载），用户往上翻历史时不打扰
let stick = true;
function nearBottom() {
  const el = histEl.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}
function scrollToBottom() { const el = histEl.value; if (el) el.scrollTop = el.scrollHeight; }
// load 不冒泡但走捕获阶段：容器上捕获 img 的 load，图片撑高后若仍贴底则补滚到底
function onImgLoad() { if (stick) scrollToBottom(); }
async function loadOlder() {
  if (!hasMore.value || loadingOlder.value || !msgs.value.length) return;
  loadingOlder.value = true;
  stick = false; // 正在向上翻历史，停用自动跟滚
  const el = histEl.value;
  const oldHeight = el ? el.scrollHeight : 0;
  try {
    const r = await api.get(`/messages?user_id=${cur.value}&before_id=${msgs.value[0].id}`);
    const rows = r.messages || [];
    hasMore.value = !!r.hasMore;
    if (rows.length) {
      msgs.value = [...rows, ...msgs.value];
      await nextTick();
      // 保持视口停在原来看的位置（新内容插在上方，scrollTop 补上增高部分）
      if (el) el.scrollTop = el.scrollHeight - oldHeight;
    }
  } catch { /* 网络失败可再拉 */ }
  loadingOlder.value = false;
}
function onScroll() {
  const el = histEl.value;
  if (!el) return;
  stick = nearBottom();
  if (el.scrollTop <= 30) loadOlder();
}
// 只追加最新消息（发送后刷新尾部，不重置已加载的历史）
async function refreshTail() {
  if (!cur.value) { await loadContacts(); return; }
  try {
    const r = await api.get(`/messages?user_id=${cur.value}`);
    const rows = r.messages || [];
    hasMore.value = hasMore.value || !!r.hasMore;
    if (!msgs.value.length) {
      msgs.value = rows;
      stick = true;
      await nextTick();
      scrollToBottom();
    } else {
      const have = new Set(msgs.value.map((m) => m.id));
      const fresh = rows.filter((m) => !have.has(m.id));
      if (fresh.length) {
        msgs.value = [...msgs.value, ...fresh];
        await nextTick();
        if (stick) scrollToBottom(); // 用户翻在历史里时不强拉到底
      }
    }
  } catch { /* 忽略，角标照常刷新 */ }
  await loadContacts();
}
async function send() {
  if (!recipients.value.length) { flash('请选择收件人', 'err'); return; }
  if (!draft.value.content.trim()) { flash('内容不能为空', 'err'); return; }
  sending.value = true;
  try {
    const targets = recipients.value.map(Number);
    await api.post('/messages', { to_users: targets, subject: draft.value.subject.trim(), content: draft.value.content.trim() });
    draft.value = { subject: '', content: '' };
    const me = JSON.parse(localStorage.getItem('wb_user') || 'null');
    const toBot = contacts.value.some((u) => u.is_bot && targets.includes(u.id));
    if (me && targets.includes(me.id)) {
      flash('已发送（发给了自己=备忘，右下角将弹出提醒，点「已读」后消失）');
      window.dispatchEvent(new CustomEvent('wb-messages-check')); // 自己的备忘立即弹窗
    } else if (toBot) {
      flash('已发送（内容由钉钉机器人发到你的钉钉；发送失败会在会话里提示）');
    } else {
      flash(`已发送给 ${targets.length} 位收件人（对方登录后/在线时右下角弹出提醒）`);
    }
    if (cur.value && targets.includes(cur.value)) await refreshTail();
    else await loadContacts();
  } catch (e) { flash('发送失败: ' + e.message, 'err'); }
  finally { sending.value = false; }
}
async function markAllRead() {
  try {
    await api.post('/messages/read-all');
    window.dispatchEvent(new CustomEvent('wb-messages-read', { detail: { all: true } })); // 右下角弹窗全部收起
    // 本地把对方发来的消息补上已读标记（不重置已向上加载的历史）
    const now = new Date().toLocaleString('sv').slice(0, 19);
    msgs.value = msgs.value.map((m) => (!m.mine && !m.read_at ? { ...m, read_at: now } : m));
    await loadContacts();
    flash('已全部标记为已读');
  } catch (e) { flash('操作失败: ' + e.message, 'err'); }
}

onMounted(loadContacts);

// ---------- 语音消息（v1.9.24）：录音 → 重采样 16k 单声道 PCM16 WAV → base64 上传 ----------
// WAV 是刻意选择：桌面代理 SoundPlayer 任意 Windows 直接可播 + 转写引擎原生输入格式，无需解码器
// v1.9.25：录音方法对齐「效率工具 → 录音转写」（VibeVoiceTab）——autoGainControl 自动增益、
// 显式 opus 编码、每秒分片、分场景权限报错；此前无增益无分片，录出来的音量小且个别内核丢整段。
const recording = ref(false);
const recSecs = ref(0);
const recBusy = ref(false);
let mediaStream = null;
let mediaRec = null;
let recChunks = [];
let recTimer = null;
let recT0 = 0;
let recSend = false; // 停止时是否发送（false=取消）
async function startRec() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { flash('当前浏览器不支持录音，请使用 Chrome / Edge 浏览器', 'err'); return; }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    flash(e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError'
      ? '浏览器已拒绝麦克风权限：点击地址栏左侧 🔒 图标 → 网站设置 → 麦克风 → 允许，然后重新录制'
      : e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError'
        ? '找不到麦克风设备：检查 Windows 设置→隐私→麦克风 是否开启，声音设置→录制设备 是否被禁用'
        : e.name === 'NotReadableError'
          ? '麦克风被其他程序占用（微信/腾讯会议/别的网页标签）：关掉后再试'
          : '无法访问麦克风：' + (e.message || e.name), 'err');
    return;
  }
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
  recChunks = [];
  try { mediaRec = new MediaRecorder(mediaStream, mime ? { mimeType: mime } : {}); }
  catch { flash('录音组件初始化失败', 'err'); stopTracks(); return; }
  mediaRec.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  mediaRec.onstop = onRecStop;
  mediaRec.start(1000); // 每秒一片：边录边出数据，个别内核上不易丢整段（同 VibeVoiceTab）
  recording.value = true;
  recSecs.value = 0;
  recT0 = Date.now();
  recTimer = setInterval(() => {
    recSecs.value = Math.floor((Date.now() - recT0) / 1000);
    if (recSecs.value >= 60) stopRec(true); // 60 秒到点自动发送
  }, 250);
}
function stopTracks() {
  if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null; }
  mediaRec = null;
}
function stopRec(sendIt) {
  if (!mediaRec || mediaRec.state === 'inactive') { recording.value = false; return; }
  recSend = sendIt;
  clearInterval(recTimer);
  recTimer = null;
  try { mediaRec.stop(); } catch { /* 已经停了 */ }
}
async function onRecStop() {
  const sendIt = recSend;
  recSend = false;
  const blob = new Blob(recChunks, { type: (mediaRec && mediaRec.mimeType) || 'audio/webm' });
  const secs = Math.max(1, Math.min(60, Math.round((Date.now() - recT0) / 1000)));
  stopTracks();
  recording.value = false;
  if (!sendIt) return; // 取消
  if (blob.size < 1000 || secs < 1) { flash('录音太短，请重录', 'err'); return; }
  if (!recipients.value.length) { flash('请先选择收件人', 'err'); return; }
  recBusy.value = true;
  try {
    const wavB64 = await encodeWav16k(blob);
    const targets = recipients.value.map(Number);
    await api.post('/messages/voice', { to_users: targets, subject: draft.value.subject.trim(), wav_b64: wavB64, secs });
    draft.value.subject = '';
    flash('语音已发送（服务器会自动转文字，稍后刷新可见）');
    if (cur.value && targets.includes(cur.value)) await refreshTail();
    else await loadContacts();
  } catch (e) { flash('语音发送失败：' + e.message, 'err'); }
  recBusy.value = false;
}
// webm/opus 解码 → OfflineAudioContext 渲染（内建抗混叠重采样 + 自动混单声道）→ PCM16 WAV → base64。
// v1.9.25 前是手写线性插值降采样（48k→16k 无低通，高频镜像混进语音段——转写/听感受损的根因之一）。
async function encodeWav16k(blob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  try {
    const aud = await ac.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.max(1, Math.ceil(aud.duration * 16000));
    const off = new OfflineAudioContext(1, frames, 16000); // 1 声道 16k：浏览器自己做高质量重采样与混音
    const src = off.createBufferSource();
    src.buffer = aud;
    src.connect(off.destination);
    src.start();
    const mono = (await off.startRendering()).getChannelData(0);
    const pcm = new Int16Array(mono.length);
    for (let i = 0; i < mono.length; i++) {
      const s = Math.max(-1, Math.min(1, mono[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    const header = new ArrayBuffer(44);
    const v = new DataView(header);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); ws(8, 'WAVE'); ws(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    ws(36, 'data'); v.setUint32(40, pcm.length * 2, true);
    const u8 = new Uint8Array(header.byteLength + pcm.length * 2);
    u8.set(new Uint8Array(header), 0);
    u8.set(new Uint8Array(pcm.buffer), 44);
    let bin = '';
    for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    return btoa(bin);
  } finally { ac.close(); }
}

// ---------- 语音播放（单实例复用，可重复播放）+ 手动转文字 ----------
let audioEl = null;
const playingId = ref(0);
function playVoice(m) {
  if (playingId.value === m.id && audioEl) { audioEl.pause(); playingId.value = 0; return; }
  if (audioEl) { audioEl.pause(); audioEl = null; }
  const token = localStorage.getItem('wb_token') || '';
  audioEl = new Audio(`/api/messages/voice/${m.id}?token=${encodeURIComponent(token)}`);
  audioEl.onended = () => { playingId.value = 0; };
  audioEl.onerror = () => { playingId.value = 0; flash('语音播放失败', 'err'); };
  playingId.value = m.id;
  audioEl.play().catch(() => { playingId.value = 0; flash('语音播放失败', 'err'); });
}
async function retranscribe(m) {
  if (m.voice_state === 'pending') return;
  m.voice_state = 'pending';
  try {
    const r = await api.post(`/messages/voice/${m.id}/transcribe`, {});
    m.voice_text = r.voice_text || '';
    m.voice_state = 'done';
    m.voice_model = r.voice_model || m.voice_model || '';
    m.voice_ms = r.voice_ms ?? m.voice_ms ?? 0;
  } catch (e) { m.voice_state = 'failed'; flash('转写失败：' + e.message, 'err'); }
}

// ---------- 电脑桌面通知卡（v1.9.24） ----------
const autoplay = ref(true);
const locationOrigin = (typeof location !== 'undefined' ? location.origin : '');
async function loadAgentPrefs() {
  try { autoplay.value = !!(await api.get('/messages/agent/prefs')).autoplay; } catch { /* 默认开 */ }
}
async function saveAutoplay() {
  try {
    await api.put('/messages/agent/prefs', { autoplay: autoplay.value });
    flash(autoplay.value ? '语音消息将在电脑弹窗时自动播放声音' : '已关闭自动播放');
  } catch (e) { flash('保存失败：' + e.message, 'err'); }
}
function dlAgent(t) {
  api.download(`/messages/agent/script?type=${t}`, t === 'install' ? 'notify-setup.cmd' : 'notify-uninstall.cmd')
    .catch((e) => flash('下载失败：' + e.message, 'err'));
}
onMounted(loadAgentPrefs);
</script>

<style scoped>
.list-item.sel { background: rgba(79, 124, 247, 0.12); border-radius: 8px; }
.badge.red { background: #e5484d; color: #fff; border-radius: 10px; padding: 1px 8px; font-size: 11px; }
.bubble { max-width: 78%; margin-bottom: 10px; padding: 8px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg3); }
.bubble.mine { margin-left: auto; background: rgba(79, 124, 247, 0.14); border-color: rgba(79, 124, 247, 0.35); }
/* 语音条（微信式）：播放条随秒数变长，点击播放/暂停 */
.voice-msg { display: inline-flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 8px; cursor: pointer; user-select: none; background: rgba(128, 128, 128, 0.1); }
.voice-msg:hover { background: rgba(128, 128, 128, 0.18); }
.bubble.mine .voice-msg { background: rgba(79, 124, 247, 0.12); }
.bubble.mine .voice-msg:hover { background: rgba(79, 124, 247, 0.2); }
.vm-icon { font-size: 15px; line-height: 1; }
/* v1.9.25：不再镜像翻转——自己发的语音三角也尖朝右（微信实际样式，旧版翻成朝左是错的） */
.vm-bar { height: 14px; border-radius: 7px; background: repeating-linear-gradient(135deg, rgba(79, 124, 247, 0.65) 0 3px, rgba(79, 124, 247, 0.3) 3px 6px); min-width: 36px; }
.vm-secs { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.voice-msg.playing .vm-bar { background: repeating-linear-gradient(135deg, #1e9e68 0 3px, rgba(30, 158, 104, 0.45) 3px 6px); }
/* 语音转写文字 / 转写按钮 */
.vm-text { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--border); font-size: 12.5px; white-space: pre-wrap; word-break: break-word; color: var(--text); opacity: 0.92; }
.vm-meta { margin-top: 3px; font-size: 11px; color: var(--muted); opacity: .85; white-space: normal; }
.vm-tag { border: 1px dashed rgba(79, 124, 247, 0.5); background: transparent; color: rgba(79, 124, 247, 0.9); font-size: 12px; padding: 3px 10px; border-radius: 999px; cursor: pointer; }
.vm-tag:hover { background: rgba(79, 124, 247, 0.12); }
.vm-tag[disabled] { cursor: default; opacity: 0.6; }
/* 录音中的呼吸红点 */
.rec-live { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: #e5484d; }
.rec-live i { width: 10px; height: 10px; border-radius: 50%; background: #e5484d; animation: recblink 1s infinite; }
@keyframes recblink { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
@media (max-width: 720px) {
  .grid { grid-template-columns: 1fr !important; }
}
</style>
