<template>
  <div class="sp">
    <div v-if="msg" class="msg" :class="msgType">{{ msg }}</div>

    <!-- ============ 工具条 ============ -->
    <div class="card" style="margin-bottom:14px">
      <h3>
        📖 儿童故事
        <span class="badge blue">{{ total }} 篇</span>
        <span class="sp-def">默认音色：<b>{{ meta.default_voice_name || '（音色库未就绪）' }}</b></span>
      </h3>
      <div class="muted" style="margin-bottom:10px">
        导入 txt / md 文本，或让 AI 现编一篇；点<b>文字转音频</b>用选中音色朗读成一段 WAV（可播放、可下载）。
        故事与音频全家共用一份（跟着「家庭共享」开关走）。<b>点故事名</b>可看全文。
      </div>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <input ref="fileEl" type="file" accept=".txt,.md,.markdown,text/plain" style="display:none" @change="onPick" />
        <button class="small" @click="fileEl.click()">📄 导入 txt / md</button>
        <button class="small" @click="openGen">✨ AI 生成故事</button>
        <button class="small primary" :disabled="!checkedIds.length || busy.tts" @click="synthChecked">
          🔊 文字转音频<span v-if="checkedIds.length">（{{ checkedIds.length }} 条）</span>
        </button>
        <span class="sp-sep"></span>
        <span class="muted">音色</span>
        <select v-model.number="voiceId" style="width:auto;max-width:230px" @change="saveVoice">
          <option v-for="v in meta.voices" :key="v.id" :value="v.id">{{ v.name }}</option>
        </select>
        <!-- 引擎没起来时就在音色旁边直接把引擎拉起来（v1.9.38），不用再跑去「效率工具 → 语音配音」 -->
        <button v-if="canStartEngine" class="small" :disabled="warming" :title="engineHint" @click="warmup">
          {{ warming ? '启动中…' : (enginePhase === 'error' ? '↻ 重试启动引擎' : '▶ 启动引擎') }}
        </button>
        <span v-if="engineRunning && !engineReady" class="muted">{{ enginePhaseText }}</span>
        <span class="grow"></span>
        <input v-model="q" placeholder="搜故事名 / 概要" style="width:170px" @keyup.enter="load(1)" />
        <button class="small" @click="load(1)">🔍 搜索</button>
        <button class="small" @click="load(page)">⟳ 刷新</button>
      </div>
      <div v-if="engineWarn" class="sp-warn">⚠️ {{ engineWarn }}</div>
      <div v-if="busy.tts" class="sp-warn">🔊 {{ busyText }}</div>
    </div>

    <!-- ============ 列表 ============ -->
    <div class="card">
      <div v-if="rows.length" class="sp-wrap">
        <table class="sp-tb">
          <thead>
            <tr>
              <th style="width:34px"><input type="checkbox" :checked="allChecked" @change="toggleAll($event.target.checked)" /></th>
              <th style="width:48px">序号</th>
              <th style="width:200px">故事名称</th>
              <th>概要</th>
              <th style="width:104px">导入日期</th>
              <th style="width:86px">是否转音频</th>
              <th style="width:74px">音频时长</th>
              <th style="width:150px">音频使用音色</th>
              <th style="width:220px">音频播放</th>
              <th style="width:168px">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in rows" :key="r.id">
              <td><input type="checkbox" :value="r.id" v-model="checkedIds" /></td>
              <td class="muted">{{ (page - 1) * pageSize + i + 1 }}</td>
              <td>
                <a class="sp-link" :title="'点击查看全文：' + r.title" @click="openDetail(r)">{{ r.title }}</a>
                <span v-if="r.source === 'ai'" class="sp-src" title="AI 生成">AI</span>
              </td>
              <td class="sp-sum" :title="r.summary">{{ r.summary || '—' }}</td>
              <td class="muted" style="white-space:nowrap">{{ (r.created_at || '').slice(0, 10) }}</td>
              <td>
                <span v-if="r.audio_path" class="badge green">已转音频</span>
                <span v-else class="badge">未转</span>
              </td>
              <td style="white-space:nowrap">{{ r.audio_path ? fmtDur(r.audio_sec) : '—' }}</td>
              <td class="sp-voice">{{ r.audio_path ? (r.voice_name || '—') : '—' }}</td>
              <td>
                <!-- <audio> 带不了 Authorization 头，走 ?token= 查询参数（同家庭图床/练琴录音） -->
                <audio v-if="r.audio_path" controls preload="none" :src="audioUrl(r)" style="width:100%;height:32px"></audio>
                <span v-else class="muted">—</span>
              </td>
              <td style="white-space:nowrap">
                <button class="small" :disabled="busy.tts" :title="r.audio_path ? '重新合成（换当前音色）' : '用当前音色朗读成音频'" @click="synthOne(r)">
                  {{ r.audio_path ? '重转' : '转音频' }}
                </button>
                <button v-if="r.audio_path" class="small" title="下载音频文件" @click="dl(r)">下载</button>
                <button class="small danger" title="删除条目并删除音频文件" @click="del(r)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="empty">{{ q ? `没有匹配「${q}」的故事` : '还没有故事：点上面「导入 txt / md」或「AI 生成故事」加一篇' }}</div>

      <div v-if="total > 0" class="row" style="justify-content:flex-end; align-items:center; gap:8px; margin-top:10px">
        <span class="muted" style="font-size:12px">共 {{ total }} 条 · 第 {{ page }} / {{ pages }} 页</span>
        <button class="small" :disabled="page <= 1" @click="go(page - 1)">◀ 上一页</button>
        <button class="small" :disabled="page >= pages" @click="go(page + 1)">下一页 ▶</button>
        <span class="muted" style="font-size:12px">每页</span>
        <select v-model.number="pageSize" style="width:auto" @change="onPageSize">
          <option v-for="n in PAGE_SIZES" :key="n" :value="n">{{ n }}</option>
        </select>
        <span class="muted" style="font-size:12px">条</span>
      </div>
    </div>

    <!-- ============ 全文弹窗 ============ -->
    <div v-if="detail.show" class="modal-backdrop" @click.self="detail.show = false">
      <div class="modal" style="width:min(720px, 94vw)">
        <h3>{{ detail.row.title || '故事' }}</h3>
        <div class="muted" style="margin-bottom:8px">
          {{ (detail.row.created_at || '').slice(0, 16) }}
          · {{ detail.row.source === 'ai' ? 'AI 生成' : detail.row.source === 'import' ? '导入' : '手工录入' }}
          · {{ (detail.row.content || '').length }} 字
          <template v-if="detail.row.audio_path"> · 音频 {{ fmtDur(detail.row.audio_sec) }}（{{ detail.row.voice_name }}）</template>
        </div>
        <div v-if="detail.row.audio_path" style="margin-bottom:10px">
          <audio controls preload="none" :src="audioUrl(detail.row)" style="width:100%"></audio>
        </div>
        <div class="sp-body">{{ detail.row.content }}</div>
        <div class="row" style="justify-content:flex-end; gap:8px; margin-top:14px">
          <button class="small" :disabled="busy.tts" @click="synthOne(detail.row); detail.show = false">
            {{ detail.row.audio_path ? '🔊 重转音频' : '🔊 文字转音频' }}
          </button>
          <button class="small" @click="detail.show = false">关闭</button>
        </div>
      </div>
    </div>

    <!-- ============ AI 生成弹窗 ============ -->
    <div v-if="gen.show" class="modal-backdrop" @click.self="gen.show = false">
      <div class="modal" style="width:min(460px, 92vw)">
        <h3>✨ AI 生成故事</h3>
        <div>
          <div class="form-row">
            <label>风格（留「随机」则由 AI 自己挑）</label>
            <select v-model="gen.style" style="width:100%">
              <option value="">🎲 随机</option>
              <option v-for="s in meta.styles" :key="s" :value="s">{{ s }}</option>
            </select>
          </div>
          <div class="form-row">
            <label>主题要求（可留空，由 AI 随机想一个）</label>
            <input v-model="gen.topic" placeholder="如：一只不敢下水的小鸭子" maxlength="60" @keyup.enter="doGen" />
          </div>
          <div class="muted">生成约 {{ meta.max_chars }} 字以内，直接入库到列表；不喜欢可以删掉重来。</div>
        </div>
        <div class="row" style="justify-content:flex-end; gap:8px; margin-top:14px">
          <button class="small" :disabled="gen.busy" @click="doGen(true)">🎲 随机来一个</button>
          <button class="small primary" :disabled="gen.busy" @click="doGen(false)">{{ gen.busy ? '生成中…' : '生成' }}</button>
          <button class="small" :disabled="gen.busy" @click="gen.show = false">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
// 儿童故事（v1.9.36）——家庭管理页新 tab。
// 服务端：server/routes/storyRoutes.js（/api/story/*）+ server/services/storyService.js。
// 列表走服务端分页（默认 15 行，可选 5/15/30/50/100），故事名/概要模糊搜；
// 音频是 WAV（服务端合成的成品拷在 data/story-audio/，不随合成缓存淘汰）。
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { api } from '../api';

const PAGE_SIZES = [5, 15, 30, 50, 100];
const token = () => encodeURIComponent(localStorage.getItem('wb_token') || '');

const msg = ref('');
const msgType = ref('ok');
function flash(text, type = 'ok') { msg.value = text; msgType.value = type; if (type === 'ok') setTimeout(() => { if (msg.value === text) msg.value = ''; }, 5000); }

const meta = ref({ voices: [], styles: [], default_voice_id: 0, default_voice_name: '', max_chars: 900, engine: {} });
const rows = ref([]);
const total = ref(0);
const page = ref(1);
const pageSize = ref(15);
const q = ref('');
const checkedIds = ref([]);
const voiceId = ref(0);
const fileEl = ref(null);
const busy = ref({ tts: false });
const busyText = ref('');
const detail = ref({ show: false, row: {} });
const gen = ref({ show: false, style: '', topic: '', busy: false });

const pages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
const allChecked = computed(() => rows.value.length > 0 && checkedIds.value.length === rows.value.length);

// 引擎状态（v1.9.38：不再把用户赶去「效率工具 → 语音配音」，音色旁边直接就能启动）
const engine = computed(() => meta.value.engine || {});
const enginePhase = computed(() => String(engine.value.phase || ''));
const engineReady = computed(() => enginePhase.value === 'ready');
const warming = ref(false);
let engineTimer = null; let engineTicks = 0;
// 未启动 / 启动失败（=可重试）时才给按钮；下载中、加载中只显示进度文字，不重复给按钮
const canStartEngine = computed(() => !!engine.value.installed && !engineReady.value
  && ['', 'stopped', 'error'].includes(enginePhase.value));
// 引擎没就绪时提前说清楚（否则用户点「转音频」只会拿到一句引擎报错）。
// 已安装的情况下不再说这句——旁边就是「▶ 启动引擎」，指路文字纯属噪音，
// 而且引擎一旦启动（下载中/加载中）这段必须消失（用户明确要求）。
const engineWarn = computed(() => {
  if (engineReady.value) return '';
  if (!engine.value.installed) return '音频引擎未安装：去「效率工具 → 语音配音」点一键安装后，这里才能把文字转成音频。';
  return '';
});
const PHASE_TEXT = { downloading: '模型下载中（约 670MB，仅首次）…', loading: '模型加载中…', starting: '启动中…', warming: '预热中…' };
const enginePhaseText = computed(() => PHASE_TEXT[enginePhase.value] || `引擎状态：${enginePhase.value}`);
const engineRunning = computed(() => !!engine.value.installed && !!enginePhase.value
  && !engineReady.value && !canStartEngine.value);
const engineHint = computed(() => {
  if (enginePhase.value === 'error') return '上次启动失败，点这里重试' + (engine.value.error ? '：' + engine.value.error : '');
  return '启动音频引擎（首次需下载约 670MB 语音模型）';
});

const fmtDur = (s) => {
  const n = Math.round(Number(s) || 0);
  if (!n) return '0:00';
  const m = Math.floor(n / 60);
  return `${m}:${String(n % 60).padStart(2, '0')}`;
};
const audioUrl = (r) => `/api/story/${r.id}/audio?token=${token()}`;

async function loadMeta() {
  try {
    meta.value = await api.get('/story/meta');
    // 音色优先级：本地记住的选择 > 服务端默认（中文女声 · Xiaoyu（明星））
    const saved = Number(localStorage.getItem('story_voice') || 0);
    const ok = (id) => meta.value.voices.some((v) => Number(v.id) === Number(id));
    voiceId.value = ok(saved) ? saved : (meta.value.default_voice_id || (meta.value.voices[0] || {}).id || 0);
  } catch (e) { flash('音色/风格读取失败：' + e.message, 'err'); }
}
function saveVoice() { try { localStorage.setItem('story_voice', String(voiceId.value)); } catch { /* 隐私模式 */ } }

// 启动音频引擎：首次要下 ~670MB 模型，POST 只负责把进程拉起来，进度靠轮询 /story/meta 的 engine.phase。
// 轮询只覆盖 engine 字段——绝不调 loadMeta()（那会重算 voiceId，把用户刚选的音色改掉）。
async function warmup() {
  if (warming.value) return;
  warming.value = true;
  try {
    await api.post('/tts/engine/warmup', {});
    flash('音频引擎正在启动，首次需下载约 670MB 模型，期间可以离开本页。');
    pollEngine();
  } catch (e) {
    flash('引擎启动失败：' + e.message, 'err');
  } finally { warming.value = false; }
}
function pollEngine() {
  if (engineTimer) clearTimeout(engineTimer);
  engineTicks = 0;
  const tick = async () => {
    engineTicks++;
    try {
      const m = await api.get('/story/meta');
      if (m && m.engine) meta.value = { ...meta.value, engine: m.engine };
    } catch { /* 轮询失败不打扰用户，下一轮再试 */ }
    const p = enginePhase.value;
    if (p === 'ready') { engineTimer = null; flash('音频引擎已就绪，现在可以把文字转成音频了。'); return; }
    if (p === 'error') { engineTimer = null; flash('音频引擎启动失败：' + (engine.value.error || '未知错误'), 'err'); return; }
    if (p === 'stopped') { engineTimer = null; return; }   // 进程没起来：按钮会自己回来，等用户重试
    if (engineTicks > 400) { engineTimer = null; return; }  // 20 分钟上限，别无限轮询
    engineTimer = setTimeout(tick, 3000);
  };
  engineTimer = setTimeout(tick, 1500);
}
onUnmounted(() => { if (engineTimer) clearTimeout(engineTimer); });

async function load(p = page.value) {
  try {
    const r = await api.get(`/story?page=${p}&page_size=${pageSize.value}&q=${encodeURIComponent(q.value.trim())}`);
    rows.value = r.stories || [];
    total.value = r.total || 0;
    page.value = r.page || 1;
    checkedIds.value = [];
  } catch (e) { flash('列表加载失败：' + e.message, 'err'); }
}
const go = (p) => { const t = Math.min(Math.max(1, p), pages.value); if (t !== page.value) load(t); };
// 改每页条数：即使当前就在第 1 页也必须重拉（否则条数变了列表不刷新）
const onPageSize = () => load(1);
const toggleAll = (on) => { checkedIds.value = on ? rows.value.map((r) => r.id) : []; };

async function openDetail(r) {
  try {
    detail.value = { show: true, row: await api.get(`/story/${r.id}`).then((d) => d.story) };
  } catch (e) { flash('读取全文失败：' + e.message, 'err'); }
}

// ---------- 文字转音频 ----------
// 逐条串行（合成是 CPU 密集的，同机并发只会互相拖慢）；每转完一条刷新列表拿时长/音色
async function synth(list) {
  if (!list.length) return;
  busy.value.tts = true;
  let okN = 0;
  try {
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      busyText.value = `正在合成音频 ${i + 1}/${list.length}：${r.title}（首次合成含引擎冷启动，可能要等几分钟）`;
      try {
        // 合成可能几十秒~几分钟（首含模型加载），走 300s 超时的 postSlow
        await api.postSlow(`/story/${r.id}/tts`, { voice_id: voiceId.value || null });
        okN++;
      } catch (e) {
        flash(`「${r.title}」转音频失败：${e.message}`, 'err');
        break; // 引擎类错误（未装/未起）后面每条都会同样失败，不再空转
      }
    }
    if (okN) flash(`已生成 ${okN} 条音频`);
  } finally {
    busy.value.tts = false;
    busyText.value = '';
    load(page.value);
  }
}
const synthOne = (r) => synth([r]);
const synthChecked = () => {
  const list = rows.value.filter((r) => checkedIds.value.includes(r.id));
  if (!list.length) return;
  if (list.length > 1 && !confirm(`确定把选中的 ${list.length} 篇依次转成音频？\n（一条一条合成，故事越长越慢，请勿关闭页面）`)) return;
  synth(list);
};

async function del(r) {
  if (!confirm(`删除「${r.title}」？\n音频文件会一起删掉，不能恢复。`)) return;
  try {
    await api.del(`/story/${r.id}`);
    flash('已删除');
    // 删掉本页最后一条时回退一页（否则停在空页上）
    load(rows.value.length === 1 && page.value > 1 ? page.value - 1 : page.value);
  } catch (e) { flash('删除失败：' + e.message, 'err'); }
}

async function dl(r) {
  try { await api.download(`/story/${r.id}/download`); }
  catch (e) { flash('下载失败：' + e.message, 'err'); }
}

async function onPick(ev) {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = ''; // 同一文件可重复选（否则第二次 change 不触发）
  if (!f) return;
  if (f.size > 5 * 1024 * 1024) return flash('文件超过 5MB，请拆分后再导入', 'err');
  try {
    const r = await api.upload('/story/import', {}, [{ name: 'file', file: f }]);
    flash(`已导入「${r.story.title}」`);
    load(1);
  } catch (e) { flash('导入失败：' + e.message, 'err'); }
}

function openGen() {
  // 音色库为空只影响「转音频」，不影响生成——所以这里不拦
  gen.value = { show: true, style: '', topic: '', busy: false };
}
async function doGen(random) {
  if (gen.value.busy) return;
  gen.value.busy = true;
  try {
    const r = await api.post('/story/gen', { style: random ? '' : gen.value.style, topic: random ? '' : gen.value.topic.trim() });
    gen.value.show = false;
    flash(`已生成《${r.story.title}》`);
    load(1);
  } catch (e) { flash('生成失败：' + e.message, 'err'); }
  finally { gen.value.busy = false; }
}

onMounted(() => { loadMeta(); load(1); });
</script>

<style scoped>
.sp-def { font-weight: 400; font-size: 12.5px; color: var(--text3); margin-left: 6px; }
.sp-sep { width: 1px; height: 18px; background: var(--border); margin: 0 2px; }
.sp-warn { margin-top: 8px; font-size: 12.5px; color: var(--amber, #d08700); }
.sp-wrap { overflow-x: auto; }
.sp-tb { width: 100%; border-collapse: collapse; font-size: 13px; }
.sp-tb th { text-align: left; padding: 8px 10px; border-bottom: 2px solid var(--border); color: var(--text3); white-space: nowrap; }
.sp-tb td { padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.sp-tb tbody tr:hover td { background: rgba(79, 124, 247, .08); }
/* 名称太长时省略号截断，鼠标悬停看全名（点开弹窗看全文） */
.sp-link { color: var(--accent); cursor: pointer; display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; vertical-align: bottom; }
.sp-link:hover { text-decoration: underline; }
.sp-src { margin-left: 5px; font-size: 10px; padding: 0 4px; border-radius: 4px; background: rgba(79, 124, 247, .18); color: #8fb0ff; }
.sp-sum { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text2); }
.sp-voice { max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sp-body { max-height: 52vh; overflow: auto; white-space: pre-wrap; line-height: 1.75; background: var(--bg2, rgba(0, 0, 0, .06)); border-radius: 8px; padding: 12px 14px; font-size: 13.5px; }
</style>
