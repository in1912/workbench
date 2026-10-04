<template>
  <div>
    <div class="row" style="align-items:center; margin-bottom:14px">
      <button class="small" @click="$router.push('/notes')">← 返回笔记</button>
      <h2 class="page-title" style="margin:0">🎙 录音笔记</h2>
    </div>

    <!-- 按钮区 -->
    <div class="card" style="margin-bottom:14px">
      <div class="row" style="gap:8px; flex-wrap:wrap; align-items:center">
        <button :class="recState === 'recording' ? 'danger' : 'primary'" :disabled="busy" @click="recState === 'recording' ? stopRec() : startRec()">
          {{ recState === 'recording' ? `■ 停止录音 ${fmtDur(recSecs)}` : '● 开始录音' }}
        </button>
        <select v-model="recFmt" :disabled="recState === 'recording' || !!rid" class="small" style="width:auto; padding:4px 8px">
          <option value="wav">WAV</option>
          <option value="webm">WebM（原始，体积小）</option>
        </select>
        <button :disabled="!rid || detail.status === 'running' || busy" @click="transcribe">转写</button>
        <button :disabled="!rid" @click="downloadAudio">下载</button>
        <button :disabled="!rid" @click="playing = !playing">{{ playing ? '收起播放' : '播放' }}</button>
        <button class="danger" :disabled="!rid" @click="del">删除</button>
        <span v-if="recState !== 'idle'" class="muted" style="font-size:12.5px">{{ recHint }}</span>
      </div>
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
import { api, rawUrl } from '../api';
import { toWavBlob } from '../learning/audioWav';

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
const recState = ref('idle'); // idle | recording | converting | uploading
const recSecs = ref(0);
const recError = ref('');
const recHint = ref('');
let mediaStream = null;
let recorder = null;
let recChunks = [];
let recTimer = null;
let recStartedAt = '';

const nowStr = () => new Date().toLocaleString('sv').slice(0, 19);

async function startRec() {
  recError.value = '';
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    recError.value = '当前浏览器不支持录制，请使用 Chrome / Edge'; return;
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
  recHint.value = '录音中…请保持屏幕亮着';
  recTimer = setInterval(() => { recSecs.value += 1; }, 1000);
}
function stopRec() {
  if (recorder && recorder.state !== 'inactive') recorder.stop(); // onstop → saveRec
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
}
async function saveRec() {
  const endedAt = nowStr();
  recState.value = 'converting';
  recHint.value = '整理录音数据…';
  try {
    const webm = new Blob(recChunks, { type: (recorder && recorder.mimeType) || 'audio/webm' });
    if (webm.size < 1000 || recSecs.value < 1) throw new Error('录制太短，已丢弃');
    const blob = recFmt.value === 'wav' ? await toWavBlob(webm) : webm;
    const name = `note-${Date.now()}.${recFmt.value}`;
    recState.value = 'uploading';
    recHint.value = `上传中（${fmtSize(blob.size)}）…`;
    const r = await uploadBlob(blob, name, recStartedAt, endedAt, recSecs.value);
    rid.value = r.id;
    await router.replace(`/notes/rec/${r.id}`);
    await load();
  } catch (e) {
    recError.value = '保存失败：' + e.message;
  } finally {
    releaseMic();
    recState.value = 'idle';
    recHint.value = '';
  }
}
function releaseMic() {
  if (mediaStream) { for (const t of mediaStream.getTracks()) t.stop(); mediaStream = null; }
  recorder = null;
}
// XHR 上传（要字节进度）；free_notes=1 标记「来自笔记页」→ 转写完成后自动建笔记 + 推系统消息
function uploadBlob(blob, name, startedAt, endedAt, hint) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('audio', blob, name);
    fd.append('source', 'record');
    fd.append('started_at', startedAt);
    fd.append('ended_at', endedAt);
    fd.append('duration_hint', String(Math.round((Number(hint) || 0) * 10) / 10));
    fd.append('from_notes', '1');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', rawUrl('/api/vibe/upload'));
    xhr.responseType = 'json';
    xhr.timeout = 10 * 60 * 1000;
    xhr.onload = () => {
      const d = xhr.response || {};
      if (xhr.status >= 200 && xhr.status < 300) resolve(d);
      else reject(new Error(d.error || `上传失败 (${xhr.status})`));
    };
    xhr.ontimeout = () => reject(new Error('上传超时'));
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
    detail.value = { ...detail.value, status: 'running' };
    startPoll();
  } catch (e) { recError.value = e.message; } finally { busy.value = false; }
}
function startPoll() {
  stopPoll();
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
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

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
onBeforeUnmount(stopPoll);
watch(() => route.params.id, () => { rid.value = route.params.id ? Number(route.params.id) : null; load(); });
</script>

<style scoped>
.info-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 10px 18px; font-size: 13px; }
.info-grid > div span { display: block; font-size: 12px; color: var(--text2); margin-bottom: 2px; }
</style>
