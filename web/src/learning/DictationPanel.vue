<template>
  <div class="dict">
    <!-- ============ 编辑态：录入内容 ============ -->
    <template v-if="!session">
      <div class="card">
        <h3>听写内容 <span class="muted" style="font-size:12px; font-weight:400">每行一条 · 中英文均可</span></h3>
        <textarea v-model="content" rows="10" placeholder="例如：&#10;apple&#10;美丽的&#10;extraordinary&#10;欲穷千里目" @change="saveDraft"></textarea>
        <div class="d-row">
          <span class="cnt">共 <b>{{ items.length }}</b> 条</span>
          <label>播报方式
            <select v-model="cfg.mode">
              <option value="auto">全自动（间隔等待）</option>
              <option value="step">逐条暂停（手动下一题）</option>
            </select>
          </label>
          <label v-if="cfg.mode === 'auto'">间隔
            <input v-model.number="cfg.interval" type="number" min="3" max="300" style="width:70px"> 秒
          </label>
        </div>
        <div class="d-row">
          <label>播报音色
            <select v-model="voiceId">
              <option v-if="!voices.length" :value="0">加载中…</option>
              <option v-for="v in voices" :key="v.id" :value="v.id">{{ v.name }}{{ v.id === defaultVoiceId ? '（默认）' : '' }}</option>
            </select>
          </label>
          <button class="small" :disabled="!voiceId" @click="previewVoice">试听音色</button>
          <router-link to="/learning?tab=tts" class="muted" style="font-size:12px; align-self:center">管理音色（录音克隆）→</router-link>
          <span class="grow"></span>
          <button class="primary" :disabled="!items.length || !voiceId" @click="start">开始听写</button>
        </div>
        <div class="muted" style="font-size:12px; margin-top:8px">点击开始后会先把全部条目的语音合成完（带进度条），播放过程中逐条零等待。
          播放中可用键盘快捷键：<kbd>空格</kbd> 下一题 · <kbd>←</kbd>/<kbd>↑</kbd> 重播本条。</div>
      </div>

      <!-- ============ 听写历史：每次生成的内容存档，点击行直接调取该次内容重新听写 ============ -->
      <div class="card hist">
        <h3>听写历史 <span class="muted" style="font-size:12px; font-weight:400">每次生成自动存档 · 点击行可直接调取该次内容重新听写</span></h3>
        <div class="hist-wrap">
          <table class="hist-tbl">
            <thead>
              <tr><th>序号</th><th>时间</th><th>音色</th><th>词条内容（全部）</th><th>条数</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in hist.records" :key="r.id" class="hist-row" title="点击调取该次内容重新听写" @click="recall(r)">
                <td>{{ (hist.page - 1) * hist.pageSize + i + 1 }}</td>
                <td class="nowrap">{{ r.created_at }}</td>
                <td class="nowrap">{{ r.voice_name || '—' }}</td>
                <td><div class="chips"><span v-for="(w, j) in wordsOf(r)" :key="j" class="chip">{{ w }}</span></div></td>
                <td>{{ r.count }}</td>
                <td><button class="small del" title="删除这条记录" @click.stop="removeRec(r)">删除</button></td>
              </tr>
            </tbody>
          </table>
          <div v-if="histLoading" class="empty">加载中…</div>
          <div v-else-if="!hist.records.length" class="empty">暂无听写记录，点上方「开始听写」后自动存档</div>
        </div>
        <div class="d-row hist-foot">
          <span class="cnt">共 <b>{{ hist.total }}</b> 条</span>
          <label>每页
            <select :value="hist.pageSize" @change="changePageSize">
              <option :value="15">15</option><option :value="30">30</option><option :value="50">50</option>
            </select> 行
          </label>
          <span class="grow"></span>
          <button class="small" :disabled="hist.page <= 1" @click="loadHist(hist.page - 1)">‹ 上一页</button>
          <span class="cnt">{{ hist.page }} / {{ maxPage }}</span>
          <button class="small" :disabled="hist.page >= maxPage" @click="loadHist(hist.page + 1)">下一页 ›</button>
        </div>
      </div>
    </template>

    <!-- ============ 准备态：一次性预合成全部语音（进度条） ============ -->
    <template v-else-if="session.preloading">
      <div class="card run prep">
        <div class="run-top">
          <div class="run-count">
            <b>{{ session.prepared }}</b><span class="sep">/</span><b class="total">{{ session.total }}</b>
          </div>
          <div class="run-label">已合成 / 总条数</div>
        </div>
        <div class="pbar"><div class="pfill" :style="{ width: prepPct + '%' }"></div></div>
        <div class="run-status">
          ⏳ 正在提前合成全部听写语音（{{ prepPct }}%），完成后自动开始——播放过程中无需等待
          <div v-if="engLine" class="muted" style="font-size:12.5px; margin-top:4px">{{ engLine }}</div>
        </div>
        <div class="run-btns">
          <button class="small danger" @click="stop">取消准备</button>
        </div>
      </div>
    </template>

    <!-- ============ 听写态：原文全部隐藏，只显示进度 ============ -->
    <template v-else>
      <div class="card run">
        <div class="run-top">
          <div class="run-count">
            <b>{{ session.done }}</b><span class="sep">/</span><b class="total">{{ session.total }}</b>
          </div>
          <div class="run-label">已播放 / 总条数</div>
        </div>
        <div class="dots">
          <span v-for="i in session.total" :key="i" class="dot" :class="{ done: i <= session.done, cur: i === session.idx + 1 }"></span>
        </div>

        <div class="run-status">
          <template v-if="session.finished">🎉 听写完成！共 {{ session.total }} 条</template>
          <template v-else-if="session.preparing">⏳ 正在准备第 {{ session.idx + 1 }} 条语音…</template>
          <template v-else-if="session.playing">🔊 正在播报第 {{ session.idx + 1 }} 条…</template>
          <template v-else-if="session.paused">⏸ 已暂停</template>
          <template v-else-if="cfg.mode === 'auto' && session.countdown != null">⏳ {{ session.countdown }} 秒后播报下一条</template>
          <template v-else-if="cfg.mode === 'step'">✋ 第 {{ session.idx + 1 }} 条已播完，准备好后点「下一题」</template>
        </div>

        <div class="run-btns">
          <button v-if="!session.finished && !session.preparing" class="small" @click="replay">↺ 重播本条</button>
          <button v-if="cfg.mode === 'auto' && !session.finished && !session.preparing" class="small" @click="togglePause">{{ session.paused ? '▶ 继续' : '⏸ 暂停' }}</button>
          <button v-if="!session.finished" class="primary" :disabled="session.preparing" @click="next">下一题 ›</button>
          <button class="small danger" @click="stop">结束听写</button>
        </div>
        <div class="kbd-tip">快捷键：<kbd>空格</kbd> 下一题 · <kbd>←</kbd>/<kbd>↑</kbd> 重播本条</div>
      </div>
    </template>
    <audio ref="audio" @ended="onEnded"></audio>
    <audio ref="prevAudio" hidden></audio>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../api';

const getToken = () => localStorage.getItem('wb_token') || '';

const content = ref(localStorage.getItem('wb_dictation_draft') || '');
const cfg = ref({ mode: 'auto', interval: 30 });
const voices = ref([]);
const voiceId = ref(0);
const defaultVoiceId = ref(0);
const eng = ref(null);       // 准备期间的引擎状态（只用于提示文案）
const session = ref(null);   // { idx, done, total, playing, paused, preparing, countdown, finished, preloading, prepared }
const audio = ref(null);
const prevAudio = ref(null);

const items = computed(() => content.value.split('\n').map((s) => s.trim()).filter(Boolean));
const prepPct = computed(() => (session.value && session.value.total ? Math.round((session.value.prepared / session.value.total) * 100) : 0));
let urlCache = new Map(); // index -> objectURL（听写结束回收）
let countdownTimer = null;
let engTimer = null;

const saveDraft = () => localStorage.setItem('wb_dictation_draft', content.value);

// ---------- 听写历史（每次生成的内容存档；点行调取该次内容与配置重新听写） ----------
const hist = ref({ page: 1, pageSize: Number(localStorage.getItem('wb_dictation_pagesize')) || 15, total: 0, records: [] });
const histLoading = ref(false);
const maxPage = computed(() => Math.max(1, Math.ceil(hist.value.total / hist.value.pageSize)));
async function loadHist(page = 1) {
  histLoading.value = true;
  try {
    const d = await api.get(`/tts/dictation-history?page=${page}&pageSize=${hist.value.pageSize}`);
    hist.value = { page: Math.min(d.page || page, Math.max(1, Math.ceil((d.total || 0) / hist.value.pageSize))) || 1, pageSize: hist.value.pageSize, total: d.total || 0, records: d.records || [] };
  } catch { /* 历史加载失败不阻塞录入 */ }
  histLoading.value = false;
}
function changePageSize(e) {
  hist.value.pageSize = Number(e.target.value) || 15;
  try { localStorage.setItem('wb_dictation_pagesize', String(hist.value.pageSize)); } catch { /* 私密模式 */ }
  loadHist(1);
}
const wordsOf = (r) => String(r.content || '').split('\n').map((s) => s.trim()).filter(Boolean);
// 调取该次内容重新听写：还原录入内容 + 播报配置 + 音色（音色已删则沿用当前默认）
function recall(r) {
  content.value = r.content;
  saveDraft();
  cfg.value = { mode: r.mode === 'step' ? 'step' : 'auto', interval: r.interval || 30 };
  if (r.voice_id && voices.value.some((v) => v.id === r.voice_id)) voiceId.value = r.voice_id;
  start();
}
async function removeRec(r) {
  if (!confirm('删除这条听写记录？')) return;
  try {
    await api.del(`/tts/dictation-history/${r.id}`);
    // 删的是本页最后一条且不在第一页时回退一页，避免停在空页
    if (hist.value.records.length === 1 && hist.value.page > 1) loadHist(hist.value.page - 1);
    else loadHist(hist.value.page);
  } catch (e) { alert('删除失败：' + e.message); }
}

async function load() {
  try {
    const [v, c] = await Promise.all([api.get('/tts/voices'), api.get('/tts/dictation-config')]);
    voices.value = v.voices || [];
    defaultVoiceId.value = v.default_voice_id || 0;
    voiceId.value = defaultVoiceId.value || (voices.value[0] ? voices.value[0].id : 0);
    if (c && c.mode) cfg.value = { mode: c.mode, interval: c.interval || 30 };
  } catch { /* 音色/配置加载失败不阻塞录入 */ }
}

function previewVoice() {
  const v = voices.value.find((x) => x.id === voiceId.value);
  if (!v || !v.has_file) return alert('该音色没有参考录音，可直接开始听写试听效果');
  prevAudio.value.src = `/api/tts/ref-audio/${v.id}?token=${encodeURIComponent(getToken())}`;
  prevAudio.value.play().catch(() => alert('试听失败：' + v.name));
}

// 引擎状态提示（仅准备阶段显示；状态接口只探测不拉起，不影响引擎）
const engLine = computed(() => {
  const s = eng.value;
  if (!s) return '语音引擎检测中…';
  if (!s.installed) return '语音引擎未安装';
  if (!s.running) return '语音引擎启动中…（首次约 30 秒，请稍候）';
  return {
    loading: '语音引擎加载模型中…（首次约 30 秒，请稍候）',
    downloading: '语音引擎下载模型中（首次，需几分钟）…',
    error: '语音引擎故障：' + (s.error || '未知'),
  }[s.phase] || '';
});

function pollEngine() {
  clearInterval(engTimer);
  engTimer = setInterval(async () => {
    if (!session.value || !session.value.preloading) return clearInterval(engTimer);
    try { eng.value = await api.get('/tts/status'); } catch { /* 探测失败不提示 */ }
  }, 2000);
}

// ---------- 播放管线 ----------
async function audioFor(i) {
  if (urlCache.has(i)) return urlCache.get(i);
  const blob = await api.blob('/tts/synthesize', { text: items.value[i], voice_id: voiceId.value });
  const url = URL.createObjectURL(blob);
  urlCache.set(i, url);
  return url;
}

async function playIdx(i, { replay = false } = {}) {
  clearInterval(countdownTimer);
  const s = session.value;
  s.idx = i;
  s.countdown = null;
  s.playing = false;
  s.finished = false;
  s.preparing = true;
  s.paused = false;
  try {
    audio.value.src = await audioFor(i);
    if (!replay) s.done = Math.max(s.done, i + 1);
    s.preparing = false;
    await audio.value.play();
    s.playing = true;
  } catch (e) {
    s.preparing = false;
    s.playing = false;
    alert('语音准备失败：' + e.message);
  }
}

function onEnded() {
  const s = session.value;
  if (!s) return;
  s.playing = false;
  s.paused = false;
  if (s.idx + 1 >= s.total) { s.finished = true; return; }
  if (cfg.value.mode === 'auto') startCountdown();
}

function startCountdown() {
  const s = session.value;
  s.countdown = cfg.value.interval;
  countdownTimer = setInterval(() => {
    if (!s || s.paused || s.finished) return;
    s.countdown -= 1;
    if (s.countdown <= 0) { clearInterval(countdownTimer); playIdx(s.idx + 1); }
  }, 1000);
}

function next() {
  const s = session.value;
  if (!s || s.preparing) return;
  if (s.idx + 1 >= s.total) { s.finished = true; clearInterval(countdownTimer); return; }
  playIdx(s.idx + 1);
}

function replay() { playIdx(session.value.idx, { replay: true }); }

// 快捷键（仅听写运行态）：空格=下一题，←/↑=重播本条。
// preventDefault 挡掉空格滚动页面和按钮聚焦触发，避免一次按键走两遍
function onKeydown(e) {
  const s = session.value;
  if (!s || s.preloading || s.finished) return;
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); next(); }
  else if (e.code === 'ArrowLeft' || e.code === 'ArrowUp') { e.preventDefault(); if (!s.preparing) replay(); }
}

function togglePause() {
  const s = session.value;
  if (s.playing) { audio.value.pause(); s.playing = false; s.paused = true; }
  else { audio.value.play(); s.paused = false; s.playing = true; }
}

// 开始听写：先一次性合成全部条目（进度条可见），再进入播放——播放阶段逐条零等待
async function start() {
  saveDraft();
  try { await api.post('/tts/dictation-config', { mode: cfg.value.mode, interval: cfg.value.interval }); } catch { /* 配置保存失败不拦听写 */ }
  if (voiceId.value !== defaultVoiceId.value) {
    try { await api.post('/tts/manage/default', { voice_id: voiceId.value }); defaultVoiceId.value = voiceId.value; } catch { /* 非管理 tab 用户静默跳过 */ }
  }
  const list = items.value;
  // 每次生成存档：内容 + 播报配置 + 音色快照（列表点击可整份调取重听）
  try {
    const v = voices.value.find((x) => x.id === voiceId.value);
    await api.post('/tts/dictation-history', { content: list.join('\n'), mode: cfg.value.mode, interval: cfg.value.interval, voice_id: voiceId.value, voice_name: v ? v.name : '' });
    loadHist(1);   // 新记录置顶，回到第一页展示
  } catch { /* 存档失败不拦听写 */ }
  session.value = { idx: 0, done: 0, total: list.length, playing: false, paused: false, preparing: false, countdown: null, finished: false, preloading: true, prepared: 0 };
  pollEngine();
  for (let i = 0; i < list.length; i++) {
    if (!session.value || !session.value.preloading) return; // 已取消
    try {
      await audioFor(i);
    } catch (e) {
      // 偶发失败（引擎中途重启等）等 1.5 秒重试一次：synthesize 会自动重新拉起引擎
      try {
        await new Promise((r) => setTimeout(r, 1500));
        if (!session.value || !session.value.preloading) return;
        await audioFor(i);
      } catch (e2) {
        stop();
        alert(`语音准备失败（第 ${i + 1} 条）：${e2.message || e.message}`);
        return;
      }
    }
    session.value.prepared = i + 1;
  }
  session.value.preloading = false;
  playIdx(0);
}

function stop() {
  clearInterval(countdownTimer);
  clearInterval(engTimer);
  audio.value.pause();
  session.value = null;
  urlCache.forEach((u) => URL.revokeObjectURL(u));
  urlCache = new Map();
}

onMounted(load);
onMounted(() => loadHist(1));
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => { window.removeEventListener('keydown', onKeydown); stop(); });
</script>

<style scoped>
.dict textarea { width: 100%; box-sizing: border-box; }
.d-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 10px; }
.d-row .cnt { font-size: 13px; color: var(--text2); }
.d-row .cnt b { color: var(--amber); font-size: 16px; }
.d-row label { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text2); }
.d-row select, .d-row input { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; font-size: 13px; }
.grow { flex: 1; }
.run { text-align: center; padding: 34px 20px 26px; }
.run-top { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.run-count { font-size: 54px; font-weight: 700; color: var(--amber); line-height: 1; }
.run-count .sep, .run-count .total { color: var(--text3); font-size: 30px; font-weight: 600; }
.run-label { font-size: 13px; color: var(--text3); }
.pbar { height: 12px; border-radius: 7px; background: var(--bg3); border: 1px solid var(--border); overflow: hidden; margin: 18px auto 6px; max-width: 420px; }
.pfill { height: 100%; background: linear-gradient(90deg, var(--amber), #f0b13a); transition: width .25s; }
.dots { display: flex; justify-content: center; gap: 7px; flex-wrap: wrap; margin: 18px 0 14px; }
.dot { width: 11px; height: 11px; border-radius: 50%; background: var(--bg3); border: 1px solid var(--border); }
.dot.done { background: var(--amber); border-color: var(--amber); }
.dot.cur { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(59, 130, 246, .18); }
.run-status { min-height: 26px; font-size: 15px; color: var(--text2); margin: 14px 0 16px; }
.run-btns { display: flex; justify-content: center; gap: 10px; flex-wrap: wrap; }
.run-btns .danger { color: var(--red); }
.kbd-tip { margin-top: 14px; font-size: 12.5px; color: var(--text3); }
kbd { display: inline-block; padding: 1px 7px; border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 5px; background: var(--bg3); font-size: 11.5px; font-family: inherit; color: var(--text2); }
.primary { background: var(--accent); color: #fff; border: none; border-radius: 8px; padding: 8px 20px; font-size: 13.5px; cursor: pointer; }
.primary:disabled { opacity: .5; cursor: default; }
.small { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 7px 16px; font-size: 13px; cursor: pointer; }
.small:disabled { opacity: .5; cursor: default; }

/* ---------- 听写历史列表 ---------- */
.hist { margin-top: 12px; }
.hist-wrap { overflow-x: auto; }
.hist-tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
.hist-tbl th { text-align: left; color: var(--text3); font-weight: 500; font-size: 12px; padding: 6px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.hist-tbl td { padding: 7px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
.hist-row { cursor: pointer; }
.hist-row:hover { background: var(--bg3); }
.hist-tbl .nowrap { white-space: nowrap; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; max-width: 640px; }
.chip { display: inline-block; padding: 1px 9px; border-radius: 11px; background: var(--bg3); border: 1px solid var(--border); font-size: 12.5px; line-height: 1.6; word-break: break-all; }
.hist-row:hover .chip { background: var(--bg2); }
.hist-foot { margin-top: 10px; }
.del { color: var(--red); }
.empty { padding: 18px; text-align: center; color: var(--text3); font-size: 13px; }
</style>
