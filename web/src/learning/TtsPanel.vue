<template>
  <div class="tts">
    <!-- 引擎状态 -->
    <div class="card">
      <div class="eng">
        <span class="pill" :class="engClass">{{ engText }}</span>
        <span v-if="status && status.build" class="muted" style="font-size:11px; flex-shrink:0">引擎 build {{ status.build }}</span>
        <span class="muted eng-tip">引擎：MOSS-TTS-Nano（ONNX 本地离线推理 · Apache 2.0）——完全在本机运行，断网可用；
          声音克隆：给一段 10~30 秒的录音，合成语音就是录音里的音色。听写播报也用这里选定的音色。</span>
      </div>
      <!-- 故障详情/阶段进度直接展示在此（此前只有一个红色「故障」，具体原因要去听写页才看得到） -->
      <div v-if="status && status.running && status.phase === 'error'" class="eng-err">⚠ {{ status.error || '引擎初始化失败' }}</div>
      <div v-else-if="status && status.running && status.detail" class="muted eng-det">{{ status.detail }}</div>
      <!-- 已安装未启动：给一个显式启动入口（服务重启后 15 秒会自动预热；此处可立即手动拉起） -->
      <div v-if="status && status.installed && !status.running" class="warm">
        <button class="primary" :disabled="warming" @click="warmup">{{ warming ? '启动中…' : '▶ 启动引擎' }}</button>
        <span class="muted" style="font-size:12px">服务每次重启后会自动预热（约半分钟就绪），也可在此立即拉起；首次启动需下载语音模型（约几百 MB，仅一次）。</span>
      </div>
      <!-- 未安装：一键安装（新 NAS/新环境部署入口，仅管理员） -->
      <div v-if="status && !status.installed" class="inst">
        <template v-if="isAdmin">
          <div class="inst-head">
            <button class="primary" :disabled="inst.running || inst.restarting" @click="startInstall">
              {{ inst.running ? '安装中…' : '⬇ 一键安装 TTS 引擎' }}
            </button>
            <span class="muted inst-tip">自动下载 Python 环境与依赖（约 1~2GB，仅需一次；完成后服务自动重启）</span>
          </div>
          <div v-if="inst.running || inst.done || inst.error" class="inst-body">
            <div class="i-steps">
              <div v-for="s in inst.steps || []" :key="s.key" class="i-step" :class="s.state">
                <span class="i-mark">{{ { done: '✓', active: '⏳', failed: '✗' }[s.state] || '·' }}</span>{{ s.label }}
              </div>
            </div>
            <div class="i-bar"><div class="i-fill" :style="{ width: (inst.progress || 0) + '%' }"></div></div>
            <div class="i-meta">
              <span>{{ inst.progress || 0 }}%</span>
              <span v-if="inst.restarting" class="muted">✓ 安装完成，服务重启中…约 10 秒后本页自动刷新</span>
              <span v-else-if="inst.error" class="i-err">安装失败：{{ inst.error }}（可直接重试；反复失败请把下方日志截图反馈）</span>
              <span v-else-if="inst.done" class="muted">✓ 安装完成</span>
            </div>
            <pre v-if="(inst.log || []).length" class="i-log">{{ inst.log.slice(-6).join('\n') }}</pre>
          </div>
        </template>
        <div v-else class="muted" style="font-size:12.5px">引擎未安装，请联系管理员在此页一键安装。</div>
      </div>
    </div>

    <!-- 独立配音：任意文本 → 所选音色朗读 -->
    <div class="card">
      <h3>文字转语音</h3>
      <textarea v-model="text" rows="4" placeholder="输入任意文字，用所选音色生成语音（中英文均可）"></textarea>
      <div class="t-row">
        <label>音色
          <select v-model="voiceId">
            <option v-if="!voices.length" :value="0">加载中…</option>
            <option v-for="v in voices" :key="v.id" :value="v.id">{{ v.name }}{{ v.id === defaultVoiceId ? '（听写默认）' : '' }}</option>
          </select>
        </label>
        <button class="primary" :disabled="!text.trim() || !voiceId || generating" @click="generate">{{ generating ? '生成中…' : '生成语音' }}</button>
      </div>
      <div v-if="genUrl" class="gen-out">
        <audio :src="genUrl" controls></audio>
        <button class="small" @click="downloadGen">下载 WAV</button>
      </div>
    </div>

    <!-- 音色库：内置 + 上传/录音克隆 -->
    <div class="card">
      <h3>音色库 <span class="muted" style="font-size:12px; font-weight:400">听写播报用的音色在这里选择和克隆</span></h3>
      <div class="v-list">
        <div v-for="v in voices" :key="v.id" class="v-item">
          <div class="grow">
            <div class="t">
              <span class="badge" :class="v.kind === 'builtin' ? 'blue' : 'green'">{{ v.kind === 'builtin' ? '内置' : '上传' }}</span>
              {{ v.name }}
              <span v-if="v.id === defaultVoiceId" class="badge amber">听写默认</span>
            </div>
          </div>
          <audio v-if="v.has_file" class="v-prev" :src="refUrl(v)" controls preload="none"></audio>
          <button v-else class="small" disabled title="该音色无参考录音，可直接生成试听">无参考录音</button>
          <button class="small" @click="setDefault(v)" :disabled="v.id === defaultVoiceId">设为默认</button>
          <button v-if="v.kind !== 'builtin'" class="icon-btn" @click="del(v)">✕</button>
        </div>
        <div v-if="!voices.length" class="empty">音色库为空</div>
      </div>

      <div class="up-box">
        <h4>添加音色（声音克隆）</h4>
        <div class="muted" style="font-size:12px; margin-bottom:8px">上传或录制一段 10~30 秒清晰人声（mp3/wav/录音均可，浏览器自动转码），
          之后所有合成都用这个音色。</div>
        <div class="t-row">
          <input v-model="newName" placeholder="音色名称，如：妈妈的声音" class="grow" />
          <input type="file" accept="audio/*" ref="fileInput" style="display:none" @change="onFile" />
          <button class="small" @click="$refs.fileInput.click()">选择音频文件</button>
          <button class="small" :disabled="recording" @click="toggleRecord">{{ recording ? `停止录音（${recSec}s）` : '🎤 开始录音' }}</button>
        </div>
        <div v-if="pendingName" class="muted" style="font-size:12.5px; margin-top:6px">
          已就绪：{{ pendingName }}（{{ pendingSec }} 秒） <a class="mini" @click="clearPending">清除</a>
          <button class="primary" style="margin-left:10px" :disabled="saving" @click="upload">{{ saving ? '上传中…' : '上传音色' }}</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../api';
import { toWavBlob, startRecording, blobToBase64 } from './audioWav';

const getToken = () => localStorage.getItem('wb_token') || '';
const text = ref('');
const voiceId = ref(0);
const voices = ref([]);
const defaultVoiceId = ref(0);
const status = ref(null);
const generating = ref(false);
const genUrl = ref('');
const newName = ref('');
const pending = ref(null); // {name, blob, sec}
const recording = ref(false);
const recSec = ref(0);
const saving = ref(false);
const fileInput = ref(null);
let rec = null, recTimer = null, statusTimer = null;

// ---------- 引擎一键安装（管理员） ----------
const isAdmin = (() => { try { return (JSON.parse(localStorage.getItem('wb_user') || '{}') || {}).role === 'admin'; } catch { return false; } })();
const inst = ref({ running: false, done: false, error: '', progress: 0, steps: [], log: [], restarting: false });
let instTimer = null, reloadTimer = null;

async function pollInst() {
  clearTimeout(instTimer);
  try { inst.value = await api.get('/tts/engine/status'); } catch { /* 轮询失败下次再试 */ }
  if (inst.value.running) {
    instTimer = setTimeout(pollInst, 2000);
  } else if (inst.value.done) {
    await refreshStatus(); // 装完（未重启模式下）引擎即刻可用
    if (inst.value.restarting) reloadTimer = setTimeout(() => location.reload(), 10000);
  }
}
async function startInstall() {
  try { await api.post('/tts/engine/install', {}); } catch (e) { return alert(e.message); }
  instTimer = setTimeout(pollInst, 1500);
}

const pendingName = computed(() => (pending.value ? pending.value.name : ''));
const pendingSec = computed(() => (pending.value ? pending.value.sec : 0));

const engText = computed(() => {
  const s = status.value;
  if (!s) return '检测中…';
  if (!s.installed) return '未安装';
  if (!s.running) return '未启动（服务启动后自动预热，约半分钟就绪）';
  return { ready: '运行中', loading: '加载模型中…', downloading: '下载模型中（首次）', error: '故障', stopped: '未启动' }[s.phase] || s.phase;
});
const engClass = computed(() => {
  const s = status.value;
  if (!s || !s.running || s.phase === 'error') return 'bad';
  return s.phase === 'ready' ? 'ok' : 'wait';
});

// 显式启动引擎：调完立刻轮询状态（refreshStatus 自带“运行中且未就绪”的续轮询）
const warming = ref(false);
async function warmup() {
  warming.value = true;
  try {
    await api.post('/tts/engine/warmup', {});
    statusTimer = setTimeout(refreshStatus, 1500);
  } catch (e) { alert('引擎启动失败：' + e.message); }
  finally { warming.value = false; }
}

const refUrl = (v) => `/api/tts/ref-audio/${v.id}?token=${encodeURIComponent(getToken())}`;

async function load() {
  try {
    const v = await api.get('/tts/voices');
    voices.value = v.voices || [];
    defaultVoiceId.value = v.default_voice_id || 0;
    if (!voiceId.value) voiceId.value = defaultVoiceId.value || (voices.value[0] ? voices.value[0].id : 0);
  } catch (e) { /* 列表加载失败由状态条提示 */ }
}

async function refreshStatus() {
  try {
    status.value = await api.get('/tts/status');
    if (status.value.running && status.value.phase !== 'ready' && status.value.phase !== 'error') {
      statusTimer = setTimeout(refreshStatus, 3000); // 启动/下载期间轮询
    }
  } catch { status.value = null; }
}

async function generate() {
  generating.value = true;
  genUrl.value = '';
  try {
    const blob = await api.blob('/tts/synthesize', { text: text.value.trim(), voice_id: voiceId.value });
    if (genUrl.value) URL.revokeObjectURL(genUrl.value);
    genUrl.value = URL.createObjectURL(blob);
  } catch (e) {
    alert('生成失败：' + e.message);
    refreshStatus();
  }
  generating.value = false;
}

function downloadGen() {
  const a = document.createElement('a');
  a.href = genUrl.value;
  a.download = '语音.wav';
  a.click();
}

async function setDefault(v) {
  try {
    await api.post('/tts/manage/default', { voice_id: v.id });
    defaultVoiceId.value = v.id;
  } catch (e) { alert(e.message); }
}

async function del(v) {
  if (!confirm(`删除音色「${v.name}」？`)) return;
  try {
    await api.del(`/tts/manage/voice/${v.id}`);
    await load();
  } catch (e) { alert(e.message); }
}

// ---------- 上传 / 录音 ----------
async function onFile(e) {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  await setPending(f.name.replace(/\.[a-z0-9]+$/i, ''), f);
}

async function setPending(name, blob) {
  try {
    const wav = await toWavBlob(blob);
    const sec = Math.round(await wavSeconds(wav));
    if (sec < 3) return alert('音频太短（' + sec + ' 秒），参考录音建议 10~30 秒');
    if (sec > 60) return alert('音频太长（' + sec + ' 秒），请裁剪到 30 秒左右（克隆参考不宜过长）');
    pending.value = { name: newName.value.trim() || name, blob: wav, sec };
    if (newName.value.trim()) newName.value = '';
  } catch {
    alert('音频解码失败：请换一个文件，或直接用录音');
  }
}

async function wavSeconds(wav) {
  return new Promise((resolve) => {
    const a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = () => { resolve(a.duration || 0); a.src = ''; };
    a.onerror = () => resolve(0);
    a.src = URL.createObjectURL(wav);
  });
}

function toggleRecord() {
  if (recording.value) { rec && rec.stop(); return; }
  rec = startRecording();
  recording.value = true;
  recSec.value = 0;
  recTimer = setInterval(() => {
    recSec.value += 1;
    if (recSec.value >= 30) rec.stop(); // 克隆参考以 30 秒为限
  }, 1000);
  rec.promise.then(async (blob) => {
    clearInterval(recTimer);
    recording.value = false;
    await setPending('我的录音 ' + new Date().toLocaleDateString('sv'), blob);
  }).catch(() => { clearInterval(recTimer); recording.value = false; alert('录音失败：浏览器未授权麦克风'); });
}

function clearPending() { pending.value = null; }

async function upload() {
  if (!pending.value) return;
  saving.value = true;
  try {
    const data_base64 = await blobToBase64(pending.value.blob);
    const r = await api.post('/tts/manage/upload', { name: pending.value.name, data_base64 });
    pending.value = null;
    await load();
    if (r.id) { voiceId.value = r.id; }
  } catch (e) { alert('上传失败：' + e.message); }
  saving.value = false;
}

onMounted(async () => {
  await Promise.all([load(), refreshStatus()]);
  if (isAdmin) pollInst(); // 进页时若安装正在进行（如刷新了页面），续上看进度
});
onBeforeUnmount(() => {
  clearTimeout(statusTimer);
  clearTimeout(instTimer);
  clearTimeout(reloadTimer);
  clearInterval(recTimer);
  if (genUrl.value) URL.revokeObjectURL(genUrl.value);
});
</script>

<style scoped>
.tts { display: flex; flex-direction: column; gap: 12px; }
.tts textarea { width: 100%; box-sizing: border-box; }
.eng { display: flex; align-items: flex-start; gap: 10px; }
.pill { flex-shrink: 0; font-size: 12px; border-radius: 10px; padding: 3px 12px; border: 1px solid var(--border); }
.pill.ok { color: var(--green); border-color: var(--green); }
.pill.wait { color: var(--amber); border-color: var(--amber); }
.pill.bad { color: var(--red); border-color: var(--red); }
.eng-tip { font-size: 12.5px; line-height: 1.7; }
.eng-err { margin-top: 8px; font-size: 12.5px; line-height: 1.7; color: var(--red); word-break: break-all; }
.eng-det { margin-top: 8px; font-size: 12.5px; line-height: 1.7; }
.warm { margin-top: 12px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.inst { margin-top: 12px; }
.inst-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.inst-tip { font-size: 12.5px; }
.inst-body { margin-top: 10px; padding: 12px; border: 1px dashed var(--border); border-radius: 8px; background: var(--bg3); }
.i-steps { display: flex; flex-direction: column; gap: 3px; margin-bottom: 10px; }
.i-step { font-size: 12.5px; color: var(--text3); }
.i-step.done { color: var(--green); }
.i-step.active { color: var(--text); font-weight: 600; }
.i-step.failed { color: var(--red); }
.i-mark { display: inline-block; width: 18px; }
.i-bar { height: 8px; border-radius: 4px; background: var(--border); overflow: hidden; }
.i-fill { height: 100%; background: var(--accent); transition: width .5s; }
.i-meta { display: flex; gap: 14px; align-items: center; margin-top: 6px; font-size: 12.5px; flex-wrap: wrap; }
.i-err { color: var(--red); }
.i-log { margin: 8px 0 0; font-size: 11.5px; line-height: 1.6; color: var(--text3); white-space: pre-wrap; word-break: break-all; max-height: 110px; overflow: auto; }
.t-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 10px; }
.t-row label { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text2); }
.t-row select, .t-row input { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font-size: 13px; }
.t-row .grow { flex: 1; min-width: 180px; }
.gen-out { display: flex; align-items: center; gap: 12px; margin-top: 10px; flex-wrap: wrap; }
.v-list { display: flex; flex-direction: column; }
.v-item { display: flex; align-items: center; gap: 10px; padding: 9px 0; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.v-item .t { font-size: 13.5px; }
.v-prev { height: 30px; max-width: 260px; }
.up-box { margin-top: 14px; padding-top: 12px; border-top: 1px dashed var(--border); }
.up-box h4 { font-size: 13.5px; margin-bottom: 6px; }
.mini { color: var(--accent); cursor: pointer; text-decoration: underline; font-size: 12px; }
.primary { background: var(--accent); color: #fff; border: none; border-radius: 8px; padding: 8px 20px; font-size: 13.5px; cursor: pointer; }
.primary:disabled { opacity: .5; cursor: default; }
.small { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 7px 14px; font-size: 13px; cursor: pointer; }
.small:disabled { opacity: .5; cursor: default; }
</style>
