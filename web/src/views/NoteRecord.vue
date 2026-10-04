<template>
  <div>
    <div class="row" style="align-items:center; margin-bottom:14px">
      <button class="small" @click="$router.push('/notes')">← 返回笔记</button>
      <h2 class="page-title" style="margin:0">🎙 录音笔记</h2>
    </div>

    <!-- 按钮区 -->
    <div class="card" style="margin-bottom:14px">
      <div class="row" style="gap:8px; flex-wrap:wrap; align-items:center">
        <button v-if="recState !== 'recording'" class="primary" :disabled="anyBusy || saveStage === 'done'" @click="startRec">● 开始录音</button>
        <template v-else>
          <button class="danger" @click="stopRec">■ 停止录音 {{ fmtDur(recSecs) }}</button>
          <span v-if="wakeOk" class="muted" style="font-size:12px">🔒 屏幕已保持常亮</span>
          <span v-else class="muted" style="font-size:12px; color:#d97706">⚠️ 请保持屏幕常亮、勿切后台</span>
        </template>
        <select v-model="recFmt" :disabled="recState !== 'idle' || !!rid" class="small" style="width:auto; padding:4px 8px">
          <option value="wav">WAV（无损，体积大）</option>
          <option value="mp3">MP3（更小）</option>
        </select>
        <template v-if="recFmt === 'mp3'">
          <select v-model.number="mp3Rate" :disabled="recState !== 'idle' || !!rid" class="small" style="width:auto; padding:4px 8px">
            <option :value="16000">16 kHz</option>
            <option :value="22050">22.05 kHz</option>
            <option :value="44100">44.1 kHz</option>
          </select>
          <select v-model.number="mp3Kbps" :disabled="recState !== 'idle' || !!rid" class="small" style="width:auto; padding:4px 8px">
            <option :value="32">32 kbps</option>
            <option :value="64">64 kbps</option>
            <option :value="128">128 kbps</option>
          </select>
        </template>
        <button :disabled="!rid || detail.status === 'running' || anyBusy" @click="transcribe">转写</button>
        <button :disabled="!rid" @click="downloadAudio">下载</button>
        <button :disabled="!rid" @click="playing = !playing">{{ playing ? '收起播放' : '播放' }}</button>
        <button class="danger" :disabled="!rid" @click="del">删除</button>
      </div>
      <!-- 保存进度：整理录音 → 编译生成文件 → 上传服务器 → 服务器确认（与「效率工具 → 录音转写」同一套） -->
      <div v-if="saveStage" class="save-box">
        <div class="sp-steps">
          <template v-for="(s, si) in SAVE_STEPS" :key="s.k">
            <span v-if="si > 0" class="sp-arrow">›</span>
            <span class="sp-step" :class="stepCls(s.k)">{{ stepIcon(s.k) }} {{ s.label }}</span>
          </template>
        </div>
        <div class="pbar"><div class="pfill" :style="{ width: savePct + '%' }"></div></div>
        <div v-if="saveStage === 'done'" class="sp-note ok">
          ✅ 已保存 <b>{{ saveFile.name }}</b>（{{ fmtSize(saveFile.size) }} · 用时 {{ saveFile.took }} 秒）——已生成录音记录，点「转写」即可生成文字。
        </div>
        <div v-else class="sp-note">{{ saveMsg }} <b class="sp-warn">处理中请勿关闭或切换页面（离开会中断）</b></div>
      </div>
      <div v-if="recWarn" class="muted" style="margin-top:8px; font-size:12.5px; color:#d97706">⚠ {{ recWarn }}</div>
      <div v-if="recError" class="msg err" style="margin-top:10px">{{ recError }}</div>
      <audio v-if="playing && rid" :src="audioSrc" controls autoplay style="width:100%; margin-top:10px"></audio>
    </div>

    <!-- 信息区 -->
    <div class="card" style="margin-bottom:14px" v-if="rid">
      <div class="info-grid">
        <div><span>开始/上传时间</span>{{ detail.started_at || '—' }}</div>
        <div><span>结束时间</span>{{ detail.ended_at || '—' }}</div>
        <div><span>录音时长</span>{{ detail.duration_sec ? fmtDur(detail.duration_sec) : '—' }}</div>
        <div><span>转写状态</span><b :style="{color: statusColor}">{{ statusText }}</b></div>
        <div><span>是否生成文本</span>{{ detail.transcript_chars ? `是（${detail.transcript_chars} 字）` : '否' }}</div>
        <div><span>转写耗时</span>{{ detail.elapsed_ms ? fmtElapsed(detail.elapsed_ms) : '—' }}</div>
        <div><span>使用模型</span>{{ detail.model || '—' }}</div>
        <div><span>容量</span>{{ fmtSize(detail.file_size) }}</div>
        <div style="grid-column:1/-1"><span>文件路径</span><code style="font-size:11.5px; word-break:break-all">{{ detail.file_path || '—' }}</code></div>
      </div>
      <div v-if="detail.status === 'running'" style="margin-top:12px">
        <div class="tp-bar big"><div class="tp-fill" :class="{ indet: transPct() < 0 }" :style="transPct() >= 0 ? { width: transPct() + '%' } : {}"></div></div>
        <div class="muted" style="font-size:12.5px">
          ⏳ 转写中{{ transPct() >= 0 ? ' ' + transPct() + '%' : '' }} · 已用 {{ transElapsed() }} 秒<template v-if="transEta()"> · {{ transEta() }}</template>。<b>转写在服务器进行，此期间可以离开页面</b>，回来会自动接着刷新（长录音可能需要几分钟）。
        </div>
      </div>
      <div v-if="detail.error" class="msg err" style="margin-top:10px">{{ detail.error }}</div>
    </div>
    <div v-else class="card" style="margin-bottom:14px">
      <div class="empty">按「开始录音」录一段，停止后自动保存。保存完点「转写」生成文字。</div>
    </div>

    <!-- 笔记文本 -->
    <div class="card" style="margin-bottom:14px" v-if="rid">
      <div class="row" style="margin-bottom:8px; align-items:center">
        <b>笔记文本</b>
        <select v-model="noteCategory" class="small" style="width:auto; padding:4px 8px; margin-left:8px">
          <option v-for="c in categories" :key="c.name" :value="c.name">{{ c.name === 'general' ? '未分类' : c.name }}</option>
        </select>
        <span class="muted" style="font-size:12px">标题保存时自动生成</span>
        <button class="primary small" style="margin-left:auto" :disabled="!note" @click="saveNote">保存文本</button>
      </div>
      <textarea v-model="noteContent" rows="14" placeholder="转写完成后文字会自动填到这里，也可以手动修改"
                style="font-family:ui-monospace,Consolas,monospace"></textarea>
      <div class="tabs" style="margin:8px 0">
        <button :class="{active: noteMode==='edit'}" @click="noteMode='edit'">编辑</button>
        <button :class="{active: noteMode==='preview'}" @click="noteMode='preview'">预览</button>
      </div>
      <div v-if="noteMode==='preview'" class="markdown-body" v-html="renderedNote"></div>
    </div>

    <!-- 算力来源 -->
    <div class="card">
      <b>算力来源</b>
      <div class="muted" style="font-size:12px; margin:6px 0 10px">与「效率工具 → 录音转写」共用同一份配置，改这里即改全局。</div>
      <div class="row" style="gap:8px; flex-wrap:wrap; margin-bottom:10px">
        <button v-for="m in modes" :key="m.v" class="small" :class="{primary: cfg.engine_mode === m.v}" @click="setMode(m.v)">{{ m.label }}</button>
      </div>
      <div v-if="cfg.engine_mode === 'server'" class="row" style="gap:8px; flex-wrap:wrap; margin-bottom:8px">
        <button class="small" :class="{primary: cfg.server_engine==='whisper'}" @click="setServerEngine('whisper')">Whisper large-v3-turbo（默认）</button>
        <button class="small" :class="{primary: cfg.server_engine==='vibeasr'}" @click="setServerEngine('vibeasr')">VibeVoice-ASR</button>
        <select v-model="cfg.whisper_lang" @change="saveCfg" class="small" style="width:auto; padding:4px 8px">
          <option v-for="l in langs" :key="l.v" :value="l.v">{{ l.label }}</option>
        </select>
      </div>
      <div v-else-if="cfg.engine_mode === 'client'" class="row" style="gap:8px; flex-wrap:wrap; margin-bottom:8px">
        <button class="small" :class="{primary: cfg.client_engine==='vibeasr'}" @click="setClientEngine('vibeasr')">VibeASR 1.5B（纯 CPU，默认）</button>
        <button class="small" :class="{primary: cfg.client_engine==='vibe7b'}" @click="setClientEngine('vibe7b')">VibeVoice-ASR 7B（需显卡）</button>
      </div>
      <div v-else class="row" style="gap:8px; flex-wrap:wrap; margin-bottom:8px">
        <input v-model="cfg.base_url" placeholder="http://192.168.1.10:8000" style="flex:1; min-width:220px">
        <input v-model="cfg.model" placeholder="模型名" style="width:150px">
        <button class="small" @click="saveCfg">保存</button>
      </div>
      <div class="muted" style="font-size:12px">当前：{{ modeLabel }}<span v-if="engineStatus"> · 引擎{{ engineStatus }}</span></div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { marked } from 'marked';
import { api, rawUrl, GATEWAY_ACTIVE } from '../api';
import { toWavBlob } from '../learning/audioWav';
import { ensureLame, webmToMp3 } from '../learning/audioMp3';

const route = useRoute();
const router = useRouter();

const rid = ref(route.params.id ? Number(route.params.id) : null);
const detail = ref({});
const note = ref(null);
const noteContent = ref('');
const noteCategory = ref('general');
const noteMode = ref('edit');
const categories = ref([]);
const playing = ref(false);
const busy = ref(false);

// ---- 录音 ----
const recFmt = ref('wav');
const mp3Rate = ref(16000);
const mp3Kbps = ref(64);
const recState = ref('idle'); // idle | recording | converting | saving
const recSecs = ref(0);
const recError = ref('');
let mediaStream = null;
let recorder = null;
let recChunks = [];
let recTimer = null;
let recStartedAt = '';

// ---- 保存进度（录音结束后：整理 → 编译生成 → 上传服务器 → 服务器确认）----
// 与「效率工具 → 录音转写」共用的同一套阶段机，进度条口径也一致
const SAVE_STEPS = [
  { k: 'decode', label: '① 整理录音' },
  { k: 'encode', label: '② 编译生成文件' },
  { k: 'upload', label: '③ 上传服务器' },
];
const saveStage = ref('');          // '' | decode | encode | upload | server | done
const savePct = ref(0);             // 0-100（decode 0-15 / encode 15-45 / upload 45-99 / done 100）
const saveMsg = ref('');            // 进度文字（不与本页 saveNote() 保存笔记的按钮重名）
const saveFile = ref({ name: '', size: 0, took: 0 });
let saveDoneTimer = null;
let decodeFakeTimer = null;         // 解码黑盒阶段的缓慢推进动画（decodeAudioData 无法分段）
const saveBusy = computed(() => ['decode', 'encode', 'upload', 'server'].includes(saveStage.value));
const anyBusy = computed(() => saveBusy.value || busy.value);
function setStage(s, pct, note) { saveStage.value = s; savePct.value = pct; saveMsg.value = note || ''; }
function startDecodeStage() {
  setStage('decode', Math.max(1, savePct.value), '整理录音数据（汇总分片、解码、重采样）…');
  if (decodeFakeTimer) clearInterval(decodeFakeTimer);
  decodeFakeTimer = setInterval(() => {
    if (saveStage.value === 'decode') savePct.value = Math.min(14, savePct.value + 0.7);
  }, 300);
}
function stopDecodeStage() { if (decodeFakeTimer) { clearInterval(decodeFakeTimer); decodeFakeTimer = null; } }
function finishSave(name, size, tookSec) {
  setStage('done', 100, '');
  saveFile.value = { name, size, took: tookSec };
  if (saveDoneTimer) clearTimeout(saveDoneTimer);
  saveDoneTimer = setTimeout(() => { if (saveStage.value === 'done') { saveStage.value = ''; savePct.value = 0; } }, 9000);
}
const stepCls = (k) => {
  const order = ['decode', 'encode', 'upload', 'server', 'done'];
  const cur = order.indexOf(saveStage.value === 'done' ? 'upload' : saveStage.value);
  const mine = order.indexOf(k);
  if (saveStage.value === 'done' || mine < cur) return 'ok';
  if (mine === cur) return 'cur';
  return '';
};
const stepIcon = (k) => { const c = stepCls(k); return c === 'ok' ? '✓' : c === 'cur' ? '⟳' : '○'; };

// ---- 手机防断续三件套：屏幕常亮（Wake Lock）+ 每秒分片 + 切后台检测 ----
// 手机浏览器锁屏/切后台会冻结页面，MediaRecorder 跟着停 → 录音一段一段没有声音。
const wakeOk = ref(false);
const recWarn = ref('');
let wakeLock = null;
let recHidden = false;
async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
    wakeOk.value = !!wakeLock;
    wakeLock?.addEventListener?.('release', () => { wakeLock = null; wakeOk.value = false; });
  } catch { wakeOk.value = false; } // 老内核（部分钉钉/企微 webview）不支持 → 走「请保持常亮」提示
}
function releaseWake() {
  try { wakeLock?.release?.(); } catch { /* ignore */ }
  wakeLock = null; wakeOk.value = false;
}
function onVisChange() {
  if (recState.value !== 'recording') return;
  if (document.visibilityState === 'hidden') {
    recHidden = true;   // 部分浏览器后台仍录，但多数会暂停/丢弃这段
    releaseWake();      // 系统此时会强制释放锁，同步一下状态
  } else {
    keepAwake();        // 回前台重新申请
    if (recHidden) recWarn.value = '刚才页面进入后台/锁屏，这段录音可能断续——录音期间请保持屏幕亮着；长时间录音建议用手机录音 App 录完再上传';
  }
}
// 保存/上传期间离开页面会中断——挂 beforeunload 守卫（原生确认框）
function onBusyUnload(e) { e.preventDefault(); e.returnValue = ''; }
watch(anyBusy, (b) => { if (b) window.addEventListener('beforeunload', onBusyUnload); else window.removeEventListener('beforeunload', onBusyUnload); });

const nowStr = () => new Date().toLocaleString('sv').slice(0, 19);

async function startRec() {
  recError.value = '';
  recWarn.value = '';
  setStage('', 0, '');
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    recError.value = '当前浏览器不支持录制，请使用 Chrome / Edge'; return;
  }
  // MP3 编码器先加载好再开麦：不然录完才发现加载失败，白录一段
  if (recFmt.value === 'mp3') {
    try { await ensureLame(); } catch (e) { recError.value = e.message; return; }
  }
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    recError.value = e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError'
      ? '浏览器已拒绝麦克风权限：地址栏左侧 🔒 → 网站设置 → 麦克风 → 允许，再重试'
      : e.name === 'NotFoundError' ? '找不到麦克风设备：检查系统录音设备是否被禁用'
        : e.name === 'NotReadableError' ? '麦克风被其他程序占用（微信/会议软件）：关掉再试'
          : '无法访问麦克风：' + e.message;
    return;
  }
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
  recChunks = [];
  recorder = new MediaRecorder(mediaStream, mime ? { mimeType: mime } : {});
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  recorder.onstop = saveRec;
  recStartedAt = nowStr();
  recorder.start(1000); // 每秒一片：长录音不易在个别内核上丢整段
  recState.value = 'recording';
  recSecs.value = 0;
  recHidden = false;
  recTimer = setInterval(() => { recSecs.value += 1; }, 1000);
  document.addEventListener('visibilitychange', onVisChange);
  keepAwake(); // 屏幕常亮：锁屏会让 MediaRecorder 停摆，录出无声片段
}
function stopRec() {
  if (recorder && recorder.state !== 'inactive') recorder.stop(); // onstop → saveRec
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
}
async function saveRec() {
  const t0 = Date.now();
  const endedAt = nowStr();
  recState.value = 'converting';
  startDecodeStage();
  try {
    const webm = new Blob(recChunks, { type: (recorder && recorder.mimeType) || 'audio/webm' });
    if (webm.size < 1000 || recSecs.value < 1) throw new Error('录制太短，已丢弃');
    let blob;
    if (recFmt.value === 'mp3') {
      blob = await webmToMp3(webm, mp3Rate.value, mp3Kbps.value, (p) => {
        // p 0~1 全程：0~0.4 解码重采样（黑盒，靠动画推进），0.4~1 编码（真实进度）
        if (p < 0.4) { if (saveStage.value === 'decode') savePct.value = Math.min(14, Math.max(savePct.value, (p / 0.4) * 15)); }
        else { stopDecodeStage(); setStage('encode', 15 + Math.floor(((p - 0.4) / 0.6) * 30), `MP3 编码中 ${Math.floor(((p - 0.4) / 0.6) * 100)}%…`); }
      });
      stopDecodeStage();
    } else {
      blob = await toWavBlob(webm);
      stopDecodeStage();
      setStage('encode', 45, 'WAV 文件已生成');
    }
    const name = `note-${Date.now()}.${recFmt.value}`;
    recState.value = 'saving';
    setStage('upload', 45, `开始上传（文件 ${fmtSize(blob.size)}）…`);
    const r = await uploadBlob(blob, name, recStartedAt, endedAt, recSecs.value, (p, loaded, total) => {
      if (p < 1) setStage('upload', 45 + Math.floor(p * 54), `已上传 ${fmtSize(loaded)} / ${fmtSize(total)}（${Math.floor(p * 100)}%）`);
      else setStage('server', 99, '上传完成，服务器接收确认中…');
    });
    finishSave(name, blob.size, Math.max(1, Math.round((Date.now() - t0) / 1000)));
    rid.value = r.id;
    await router.replace(`/notes/rec/${r.id}`);
    await load();
  } catch (e) {
    stopDecodeStage();
    setStage('', 0, '');
    recError.value = '保存失败：' + e.message;
  } finally {
    releaseMic();
    recState.value = 'idle';
  }
}
function releaseMic() {
  if (mediaStream) { for (const t of mediaStream.getTracks()) t.stop(); mediaStream = null; }
  recorder = null;
  document.removeEventListener('visibilitychange', onVisChange);
  releaseWake();
}
// XHR 上传（只有 XHR 拿得到上传字节进度，fetch 不行）；onProg(p, loaded, total) 0~1
// from_notes=1 标记「来自笔记页」→ 转写完成后自动建笔记 + 推系统消息
function uploadBlob(blob, name, startedAt, endedAt, hint, onProg) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('audio', blob, name);
    fd.append('source', 'record');
    fd.append('started_at', startedAt);
    fd.append('ended_at', endedAt);
    fd.append('duration_hint', String(Math.round((Number(hint) || 0) * 10) / 10));
    fd.append('from_notes', '1');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', rawUrl('/api/vibe/upload')); // rawUrl 已补网关前缀 + ?token=
    // fnOS 网关校验 Authorization 头（带头即拒），网关部署下不发；?token= 已够认证
    if (!GATEWAY_ACTIVE) xhr.setRequestHeader('Authorization', 'Bearer ' + (localStorage.getItem('wb_token') || ''));
    xhr.responseType = 'json';
    xhr.timeout = 10 * 60 * 1000; // 大文件/慢网络 10 分钟兜底
    if (onProg && xhr.upload) {
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total) onProg(e.loaded / e.total, e.loaded, e.total); };
      xhr.upload.onload = () => onProg(1, 0, 0);
    }
    xhr.onload = () => {
      const d = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300) resolve(d);
      else reject(new Error(d.error || `上传失败 (${xhr.status})`));
    };
    xhr.ontimeout = () => reject(new Error('上传超时（10 分钟）'));
    xhr.onerror = () => reject(new Error('网络错误，上传中断'));
    xhr.send(fd);
  });
}

// ---- 转写 ----
let pollTimer = null;
async function transcribe() {
  busy.value = true;
  try {
    await api.post(`/vibe/transcribe/${rid.value}`);
    detail.value = { ...detail.value, status: 'running', run_ms: Date.now() };
    startPoll();
  } catch (e) { recError.value = e.message; } finally { busy.value = false; }
}

// ---- 转写进度（与「效率工具 → 录音转写」同一套估算口径）----
// 已用时间 / (音频时长 × 历史 RTF + 引擎加载余量 6 秒)；拿不到起点或时长即返回 -1（转不定进度条）
let progTimer = null;
const rtfEst = ref(0);
const nowTick = ref(Date.now());
function startProgTick() {
  if (progTimer) return;
  nowTick.value = Date.now();
  progTimer = setInterval(() => { nowTick.value = Date.now(); }, 1000); // 每秒本地推进，不发请求
}
function stopProgTick() { if (progTimer) { clearInterval(progTimer); progTimer = null; } }
function transPct() {
  const d = detail.value;
  if (!d || !d.run_ms || !Number(d.duration_sec)) return -1;
  const elapsed = nowTick.value - Number(d.run_ms);
  if (elapsed < 0) return -1;
  const rtf = rtfEst.value || 4;   // 无历史样本时按 4× 音频时长估
  const estTotal = Number(d.duration_sec) * rtf * 1000 + 6000;
  return Math.max(3, Math.min(95, Math.round((elapsed / estTotal) * 100)));
}
const transElapsed = () => (detail.value && detail.value.run_ms ? Math.max(0, Math.round((nowTick.value - Number(detail.value.run_ms)) / 1000)) : 0);
function transEta() {
  if (!rtfEst.value || !detail.value || !detail.value.duration_sec) return '';
  const left = Math.max(0, Math.round(Number(detail.value.duration_sec) * rtfEst.value + 6 - transElapsed()));
  return left > 0 ? `预计还约 ${left} 秒` : '即将完成（长录音较慢，请稍候）';
}

function startPoll() {
  stopPoll();
  startProgTick();
  pollTimer = setInterval(async () => {
    if (rid.value) {
      const d = await api.get(`/vibe/transcript/${rid.value}`).catch(() => null);
      if (d) detail.value = d;
      if (!d || d.status !== 'running') {
        stopPoll();
        // 转写完成 → 立刻拉一次系统消息（不必等 60s 轮询）
        window.dispatchEvent(new Event('wb-messages-check'));
        await load();
      }
    }
  }, 3000);
}
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } stopProgTick(); }

// ---- 下载 / 删除 ----
function downloadAudio() {
  const a = document.createElement('a');
  a.href = rawUrl(`/api/vibe/audio/${rid.value}`);
  a.download = '';
  document.body.appendChild(a); a.click(); a.remove();
}
async function del() {
  if (!confirm('删除这条录音笔记？录音文件与转写结果会一并删除（关联的笔记条目也会移除）。')) return;
  try {
    if (note.value) await api.del(`/notes/${note.value.id}`).catch(() => {});
    await api.del(`/vibe/records/${rid.value}`);
    router.push('/notes');
  } catch (e) { alert(e.message); }
}

// ---- 笔记文本 ----
const renderedNote = computed(() => marked.parse(noteContent.value || ''));
async function saveNote() {
  if (!note.value) return;
  try {
    await api.put(`/notes/${note.value.id}`, { content: noteContent.value, category: noteCategory.value });
    await load();
    alert('已保存');
  } catch (e) { alert(e.message); }
}

// ---- 算力来源（与效率工具→录音转写共用 settings.vibe_settings） ----
const cfg = ref({ engine_mode: 'server', server_engine: 'whisper', client_engine: 'vibeasr', whisper_lang: 'auto', base_url: '', model: 'vibevoice' });
const engineStatus = ref('');
const modes = [
  { v: 'server', label: '🖥 服务器引擎' },
  { v: 'client', label: '💻 客户端电脑' },
  { v: 'custom', label: '🔗 自定义服务' },
];
const langs = [
  { v: 'auto', label: '自动' }, { v: 'zh', label: '中文' }, { v: 'en', label: '英文' }, { v: 'ja', label: '日文' }, { v: 'ko', label: '韩文' },
];
const modeLabel = computed(() => {
  if (cfg.value.engine_mode === 'client') return cfg.value.client_engine === 'vibe7b' ? '客户端 VibeVoice-ASR 7B' : '客户端 VibeASR 1.5B';
  if (cfg.value.engine_mode === 'custom') return '自定义服务 ' + (cfg.value.base_url || '（未填地址）');
  return cfg.value.server_engine === 'vibeasr' ? '服务器 VibeVoice-ASR' : '服务器 Whisper large-v3-turbo';
});
async function loadCfg() {
  try { cfg.value = { ...cfg.value, ...(await api.get('/vibe/settings')) }; } catch { /* 用默认 */ }
  try {
    const st = await api.get('/vibe/engine/status');
    const e = (st.engines || {})[st.server_engine === 'vibeasr' ? 'vibeasr' : 'whisper'] || {};
    engineStatus.value = e.installed ? (e.service ? '（运行中）' : '（已安装，未运行）') : '（未安装）';
  } catch { engineStatus.value = ''; }
}
async function saveCfg() {
  try {
    await api.put('/vibe/settings', cfg.value);
  } catch (e) { alert(e.message); }
}
function setMode(m) { cfg.value.engine_mode = m; saveCfg(); }
function setServerEngine(m) { cfg.value.server_engine = m; saveCfg(); }
function setClientEngine(m) { cfg.value.client_engine = m; saveCfg(); }

// ---- 工具 ----
function fmtDur(s) { const t = Math.max(0, Math.round(Number(s) || 0)); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; }
function fmtElapsed(ms) { const s = Math.max(0, Math.round(Number(ms) / 1000)); return s >= 60 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${s} 秒`; }
function fmtSize(b) { const n = Number(b) || 0; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }
const statusText = computed(() => ({ pending: '待转写', running: '转写中…', done: '已生成', failed: '失败' }[detail.value.status] || '—'));
const statusColor = computed(() => ({ running: 'var(--blue, #60a5fa)', done: 'var(--green, #34d399)', failed: 'var(--red, #f87171)' }[detail.value.status] || 'inherit'));
const audioSrc = computed(() => (rid.value ? rawUrl(`/api/vibe/audio/${rid.value}?inline=1`) : ''));

async function load() {
  if (!rid.value) return;
  try {
    detail.value = await api.get(`/vibe/transcript/${rid.value}`);
    rtfEst.value = Number(detail.value.rtf_est) || 0; // 估速系数（详情接口 v1.9.40 起返回）
  } catch (e) { recError.value = e.message; }
  try {
    const n = await api.get(`/notes/by-record/${rid.value}`);
    note.value = n && n.id ? n : null;
    if (note.value) { noteContent.value = note.value.content || ''; noteCategory.value = note.value.category || 'general'; }
  } catch { note.value = null; }
  if (detail.value.status === 'running') startPoll();
}

onMounted(async () => {
  try { categories.value = await api.get('/notes/categories'); } catch { categories.value = []; }
  await loadCfg();
  await load();
});
onBeforeUnmount(() => {
  stopPoll();
  if (saveDoneTimer) { clearTimeout(saveDoneTimer); saveDoneTimer = null; }
  stopDecodeStage();
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
  // 录音中途离开：拦掉 onstop 的保存回调（不然会在卸载中发起上传），只收麦与释放常亮
  if (recorder && recorder.state !== 'inactive') { recorder.onstop = null; recorder.stop(); }
  releaseMic();
});
watch(() => route.params.id, () => { rid.value = route.params.id ? Number(route.params.id) : null; load(); });
</script>

<style scoped>
.info-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px 18px; font-size: 13px; }
.info-grid > div span { display: block; font-size: 12px; color: var(--text2); margin-bottom: 2px; }
/* 保存进度（与「效率工具 → 录音转写」同一套样式） */
.save-box { margin-top: 10px; max-width: 620px; }
.sp-steps { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12.5px; margin-bottom: 2px; }
.sp-step { padding: 2px 10px; border-radius: 12px; background: rgba(128, 128, 128, .12); color: var(--text2); }
.sp-step.cur { background: rgba(79, 124, 247, .16); color: var(--accent, #4f7cf7); font-weight: 600; }
.sp-step.ok { background: rgba(46, 158, 91, .13); color: var(--green, #2e9e5b); }
.sp-arrow { color: #9aa0a6; }
.pbar { height: 9px; border-radius: 6px; background: rgba(128, 128, 128, .16); overflow: hidden; margin: 8px 0 7px; }
.pfill { height: 100%; border-radius: 6px; background: var(--accent, #4f7cf7); transition: width .25s ease; }
.sp-note { font-size: 12.5px; color: var(--text2); }
.sp-note.ok { color: var(--green, #2e9e5b); }
.sp-warn { color: #d97706; }
/* 转写进度条（不确定进度时走 .indet 滑动动画），与「效率工具 → 录音转写」同一套 */
.tp-bar { height: 6px; border-radius: 4px; background: rgba(128, 128, 128, .18); overflow: hidden; position: relative; }
.tp-fill { height: 100%; border-radius: 4px; background: var(--accent, #4f7cf7); transition: width .6s ease; }
.tp-fill.indet { width: 40%; animation: tp-slide 1.2s infinite linear; }
@keyframes tp-slide { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }
.tp-bar.big { height: 10px; max-width: 460px; margin: 6px 0 8px; }
</style>
