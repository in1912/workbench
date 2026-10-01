<template>
  <div class="vc">
    <!-- ============ 根目录未配置：引导（管理员可去设置页配置） ============ -->
    <div v-if="!cfg.root_ok" class="card vc-empty">
      <div class="ph">
        🎞 视频中心<br>
        <b>{{ cfg.root ? '视频目录不可访问：' + cfg.root : '尚未配置智能家居视频路径' }}</b>
        <div style="font-size:12px">
          {{ isAdmin ? '到「设置 → 智能家居视频路径」填写 NAS 目录后即可浏览播放' : '请联系管理员在「设置」页的「智能家居视频路径」配置视频目录' }}
        </div>
      </div>
    </div>

    <!-- ============ 主界面：左目录树 + 右播放器（无学年/学科、无文档预览、无注意力点检） ============ -->
    <div v-else class="vc-body">
      <div class="vc-head">
        <span class="cur">🎞 视频中心</span>
        <!-- 通道指示：配置了本地直连才显示，让「现在走哪条路」一眼可见 -->
        <span v-if="channel === 'local'" class="lb ok" title="视频正从局域网直连读取（更快）">⚡ 本地直连</span>
        <span v-else-if="channel === 'net'" class="lb" title="本地地址不可达，已回落当前公网地址">公网通道</span>
      </div>
      <div class="vc-main">
        <div class="tree card">
          <div class="tree-root" @click="toggleRoot">{{ rootOpen ? '📂' : '📁' }} 视频目录</div>
          <div v-if="rootOpen" class="tree-children">
            <div v-if="treeLoading" class="muted ld">加载中…</div>
            <div v-else-if="treeError" class="muted ld err">{{ treeError }}</div>
            <template v-else>
              <VsTreeNode v-for="e in rootEntries" :key="e.name" :entry="e" parent="" base="/vc" />
              <div v-if="!rootEntries.length" class="muted ld">（目录为空）</div>
            </template>
          </div>
        </div>

        <div class="card zone player-zone">
          <div v-if="curMedia" class="zone-head">
            🎬 {{ curMedia.name }}
            <span class="muted" style="font-size:12px">{{ curMedia.ext.toUpperCase() }}</span>
            <span v-if="resumeInfo" class="lb resume" title="按上次观看位置自动续播">{{ resumeInfo }}</span>
            <span class="grow"></span>
            <label class="lp" :title="'本文件所在文件夹内的媒体依次循环播放（' + playlist.length + ' 个）'">
              <input type="checkbox" v-model="loopPlay"> 🔁 文件夹内循环
            </label>
            <button class="small" @click="closeMedia">✕ 关闭</button>
          </div>
          <video v-show="curMedia" ref="videoEl" controls controlslist="nodownload" preload="auto" @timeupdate="onTimeUpdate" @pause="flushMedia" @ended="onEnded"></video>
          <div v-if="!curMedia" class="ph">🎞 视频播放区（mp4 · flv · webm）／ 🎵 音频（mp3）<br><span style="font-size:12px">在左侧目录点击媒体文件开始播放，进度自动记忆、下次从这里续播</span></div>

          <!-- ============ 播放历史（一人一份，倒序；点任意一行即重新打开该文件） ============ -->
          <div class="his">
            <div class="his-head">
              <span class="his-title">🕘 播放历史</span>
              <span class="muted" style="font-size:12px">共 {{ hisTotal }} 条</span>
              <span class="grow"></span>
              <button class="small" @click="loadHistory(hisPage)">↻ 刷新</button>
            </div>
            <table class="his-tb">
              <thead>
                <tr><th class="c-time">时间</th><th class="c-dir">文件夹</th><th class="c-name">文件名</th><th class="c-path">完整路径</th></tr>
              </thead>
              <tbody>
                <tr v-for="r in hisRows" :key="r.id" class="his-row" :class="{ cur: curMedia && r.path === displayPath(curMedia.rel) }"
                    :title="'点击播放：' + r.path" @click="openFromHistory(r)">
                  <td class="c-time" :title="r.updated_at || ''">{{ fmtTime(r.updated_at) }}</td>
                  <td class="c-dir" :title="r.folder">{{ r.folder || '—' }}</td>
                  <td class="c-name" :title="r.name">{{ r.name }}</td>
                  <td class="c-path" :title="r.path">{{ r.path }}</td>
                </tr>
                <tr v-if="!hisRows.length"><td colspan="4" class="muted ld">暂无播放记录——点开任意视频后这里会出现记录</td></tr>
              </tbody>
            </table>
            <div class="his-page">
              <button class="small" :disabled="hisPage <= 1" @click="hisGo(hisPage - 1)">◀ 上一页</button>
              <span class="muted" style="font-size:12px">第 {{ hisPage }} / {{ hisPages }} 页</span>
              <button class="small" :disabled="hisPage >= hisPages" @click="hisGo(hisPage + 1)">下一页 ▶</button>
              <span class="grow"></span>
              <span class="muted" style="font-size:12px">每页</span>
              <select v-model.number="hisPageSize" @change="onPageSize">
                <option v-for="n in PAGE_SIZES" :key="n" :value="n">{{ n }}</option>
              </select>
              <span class="muted" style="font-size:12px">条</span>
            </div>
          </div>

          <!-- 外部播放器调起（放在播放历史下方）：浏览器 <video> 解不动 HEVC 10bit/4K，交给本地播放器硬解；
               联动脚本与「学习 → 视频教学」共用同一份（协议注册全局幂等，装一次两边都能用） -->
          <div class="ext-row">
            <template v-if="curMedia">
              <button class="small" @click="openExternal('potplayer')">▶ PotPlayer 播放</button>
              <button class="small" @click="openExternal('vlc')">▶ VLC 播放</button>
              <button class="small" @click="copyMediaUrl">🔗 复制直链</button>
            </template>
            <span class="muted ext-tip">
              HEVC / 10bit / 4K 请用外部播放器（浏览器解不动）；首次使用先<a href="#" @click.prevent="dlExtSetup">⬇ 安装联动脚本</a>（与视频教学共用一份，装过即免，自动识别已装的播放器，免管理员）；
              还没装播放器？下载 <a href="https://www.videolan.org/" target="_blank" rel="noopener">VLC media player</a> ·
              <a href="https://potplayer.daum.net/" target="_blank" rel="noopener">PotPlayer</a>
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
// 视频中心（v1.9.26）：视频教学的精简版，挂在智能家居页最后一个 tab。
// 保留：目录树 + Range 播放 + flv.js + 本地直连 + 外部播放器联动 + 进度记忆（断点续播）。
// 去掉：学年/学科选择、文档预览、注意力点检、学时记账、学习会话/历史列表。
// 进度口径与 vstudy 相同：position=历史最大播放位置、watched=实际观看增量，15 秒一批上报。
import { computed, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';
import { api } from '../api';
import { localState, probeLocalBase, sameOriginBase } from '../utils/localBase';
import VsTreeNode from '../learning/VsTreeNode.vue';

const getToken = () => localStorage.getItem('wb_token') || '';
const isAdmin = (() => { try { return (JSON.parse(localStorage.getItem('wb_user') || '{}') || {}).role === 'admin'; } catch { return false; } })();

const cfg = ref({ root: '', root_ok: false });
const rootOpen = ref(false);
const rootEntries = ref([]);
const treeLoading = ref(false);
const treeError = ref('');

const videoEl = ref(null);
const curMedia = ref(null);          // { rel, name, ext }
const resumeInfo = ref('');          // 断点续播提示（「已从 12:34 续播」）

// ---------- 播放历史（vc_records，一人一份；倒序分页） ----------
const PAGE_SIZES = [5, 10, 15, 30, 50];
const hisRows = ref([]);
const hisTotal = ref(0);
const hisPage = ref(1);
const hisPageSize = ref(5);          // 默认 5 条/页
const hisPages = computed(() => Math.max(1, Math.ceil(hisTotal.value / hisPageSize.value)));

// ---------- 文件夹内循环播放 ----------
const loopPlay = ref(localStorage.getItem('vc_loop') !== '0'); // 默认开启
const playlist = ref([]);            // 当前文件夹内的媒体列表（不含子文件夹）
watch(loopPlay, (v) => { try { localStorage.setItem('vc_loop', v ? '1' : '0'); } catch { /* 隐私模式 */ } });

let flvPlayer = null;
let flushTimer = null;
let track = null;                    // { last, watched, maxPos, dur }
let beaconHandler = null;
let mediaSeq = 0;                    // 快速换文件时丢弃旧 loadedmetadata 回调的序号

// ---------- 本地直连（大文件走局域网；探测结果与视频教学共享 utils/localBase.js） ----------
const channel = ref('');            // 'local' | 'net' | ''（未配置本地地址）
let mediaBase = '';
function applyLocal() {
  const s = localState();
  mediaBase = s.base;
  channel.value = s.lan || s.ok ? 'local' : s.configured ? 'net' : '';
}
const onLocalEvt = () => applyLocal();

// mediaBase 为空（本就在内网）时兜底同源绝对前缀——外部播放器协议调起与「复制直链」必须拿到完整 URL
const fileUrl = (rel, download = false) =>
  `${mediaBase || sameOriginBase()}/api/vc/file?path=${encodeURIComponent(rel)}${download ? '&download=1' : ''}&token=${encodeURIComponent(getToken())}`;

// VsTreeNode 的点击回调（inject 键与视频教学同名——同一时刻只挂一个面板，不冲突）
provide('vstudySelectFile', (rel, entry) => {
  if (entry.kind === 'media') playMedia(rel, entry); // 视频中心只播媒体（树里也只有目录和媒体）
});

async function loadCfg() {
  try { cfg.value = await api.get('/vc/config'); } catch { /* 失败保持 root_ok=false 的引导态 */ }
}

// ---------- 目录树 ----------
async function toggleRoot() {
  rootOpen.value = !rootOpen.value;
  if (rootOpen.value && !rootEntries.value.length && !treeError.value) {
    treeLoading.value = true;
    try { rootEntries.value = (await api.get('/vc/tree')).entries || []; }
    catch (e) { treeError.value = e.message; }
    treeLoading.value = false;
  }
}

// ---------- 播放历史 ----------
function fmtTime(s) { return String(s || '').replace('T', ' ').slice(0, 16); } // 秒级截掉，列更紧凑
async function loadHistory(page = hisPage.value) {
  try {
    const r = await api.get(`/vc/records?page=${page}&pageSize=${hisPageSize.value}`);
    hisRows.value = r.records || [];
    hisTotal.value = r.total || 0;
    hisPage.value = r.page || 1;
  } catch { /* 历史拉取失败不阻塞播放 */ }
}
function hisGo(p) {
  const t = Math.min(Math.max(1, p), hisPages.value);
  if (t === hisPage.value) return;
  loadHistory(t);
}
// 改分页量：即使当前就在第 1 页也必须重拉（否则每页条数变了列表不刷新）
function onPageSize() { loadHistory(1); }
// 打开文件时建档：无进度也留一条，刚点开的文件立刻排到历史最上面
async function touchOpen(rel, ext) {
  try { await api.post('/vc/open', { path: displayPath(rel), ext: String(ext || '') }); } catch { /* 建档失败不影响播放 */ }
  loadHistory(hisPage.value);
}
// 历史里存的是完整路径（根 + 相对路径）——反推相对路径才能重新打开；目录改过 → null
function relFromDisplay(full) {
  const norm = (x) => String(x || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const root = norm(cfg.value.root);
  const s = norm(full);
  if (!root) return s;
  if (s === root) return '';
  return s.startsWith(root + '/') ? s.slice(root.length + 1) : null;
}
function openFromHistory(r) {
  const rel = relFromDisplay(r.path);
  if (rel === null) { alert('这条记录不在当前视频目录内（目录配置可能已变），无法打开：\n' + r.path); return; }
  const name = r.name || rel.split('/').pop();
  const ext = String(r.ext || name.split('.').pop() || '').toLowerCase();
  playMedia(rel, { name, ext, kind: 'media' });
}

// ---------- 媒体播放（mp4/mp3 原生；flv 用 flv.js 转封装）+ 断点续播 ----------
function displayPath(rel) {
  const root = (cfg.value.root || '').replace(/[\\/]+$/, '');
  return root ? root + '\\' + rel : rel; // 与 vstudy 同口径：库里存根目录开头的完整路径
}
function fmtPos(sec) {
  const v = Math.floor(Number(sec) || 0);
  const h = Math.floor(v / 3600), m = Math.floor((v % 3600) / 60), s = v % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
async function playMedia(rel, entry) {
  flushMedia(); // 结算上一个文件的进度
  destroyFlv();
  const mySeq = ++mediaSeq;
  curMedia.value = { rel, name: entry.name, ext: entry.ext };
  const url = fileUrl(rel);
  track = { last: 0, watched: 0, maxPos: 0, dur: 0 };
  resumeInfo.value = '';
  loadPlaylist(dirOf(rel));            // 当前文件夹内的媒体列表（循环播放用，不含子文件夹）
  touchOpen(rel, entry.ext);           // 建档 + 刷新播放历史（无进度也留一条）
  // 断点续播：上次看到 >30s 且未到时长 95% 才续（接近看完的从头播）
  let seekTo = 0;
  try {
    const prev = await api.get('/vc/progress?path=' + encodeURIComponent(displayPath(rel)));
    const pos = prev && prev.record ? Number(prev.record.position_sec) || 0 : 0;
    const dur0 = prev && prev.record ? Number(prev.record.duration_sec) || 0 : 0;
    if (pos > 30 && (dur0 <= 0 || pos < dur0 * 0.95)) seekTo = pos;
  } catch { /* 查询失败从头播，不影响打开 */ }
  const v = videoEl.value;
  if (!v) return;
  v.addEventListener('loadedmetadata', function onMeta() {
    v.removeEventListener('loadedmetadata', onMeta);
    if (mySeq !== mediaSeq || !seekTo || seekTo >= (v.duration || 1e9)) return; // 已换文件/时长异常 → 丢弃
    try {
      v.currentTime = seekTo;
      track.last = seekTo;                    // 跳过的部分不计观看增量
      track.maxPos = Math.max(track.maxPos, seekTo);
      resumeInfo.value = '⏱ 已从 ' + fmtPos(seekTo) + ' 续播';
    } catch { /* 个别浏览器 seek 太早抛错，从头播 */ }
  });
  if (entry.ext === 'flv') {
    try {
      const flvjs = (await import('flv.js')).default;
      if (!flvjs.isSupported()) throw new Error('当前浏览器不支持 FLV 播放，请用 Chrome/Edge');
      // enableStashBuffer:false —— 关掉起播前置缓冲池，收到即喂给解码器，点开就播；
      // seekType:'range' 走 206 分段按需取，拖进度条不用等整段
      flvPlayer = flvjs.createPlayer({ type: 'flv', isLive: false, url },
        { enableStashBuffer: false, stashInitialSize: 128, seekType: 'range', lazyLoad: true });
      flvPlayer.attachMediaElement(v);
      flvPlayer.load();
      v.play().catch(() => {});
    } catch (e) { curMedia.value = null; alert(e.message); }
  } else {
    v.src = url;
    v.play().catch(() => {});
  }
}
function destroyFlv() {
  if (flvPlayer) { try { flvPlayer.destroy(); } catch { /* 已销毁 */ } flvPlayer = null; }
}
// ---------- 文件夹内循环播放（当前文件夹内的媒体，不含子文件夹；默认开） ----------
function dirOf(rel) {
  const s = String(rel || '').replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i) : '';
}
async function loadPlaylist(dir) {
  try {
    const r = await api.get('/vc/tree?dir=' + encodeURIComponent(dir));
    playlist.value = (r.entries || []).filter((e) => e.kind === 'media')
      .map((e) => ({ rel: dir ? dir + '/' + e.name : e.name, name: e.name, ext: e.ext, kind: 'media' }));
  } catch { playlist.value = []; }
}
function playNextInFolder() {
  const list = playlist.value, cur = curMedia.value;
  if (!list.length || !cur) return;
  let i = list.findIndex((x) => x.rel === cur.rel);
  i = i < 0 ? 0 : (i + 1) % list.length; // 最后一个回到第一个；只有一个文件就自身重播
  const next = list[i];
  if (next) playMedia(next.rel, next);
}
function closeMedia() {
  flushMedia();
  mediaSeq++; // 让挂在 video 上的续播回调（若有）失效
  destroyFlv();
  videoEl.value.removeAttribute('src');
  videoEl.value.load();
  curMedia.value = null;
  resumeInfo.value = '';
  playlist.value = [];
  track = null;
}
// 外部播放器调起：potplayer:// vlc:// 协议交给本地播放器硬解（与视频教学同一套注册脚本）
function openExternal(proto) {
  if (!curMedia.value) return;
  try { flushMedia(); if (videoEl.value) videoEl.value.pause(); } catch { /* 忽略暂停失败 */ }
  window.location.href = proto + ':' + fileUrl(curMedia.value.rel);
}
async function copyMediaUrl() {
  if (!curMedia.value) return;
  const url = fileUrl(curMedia.value.rel);
  try { await navigator.clipboard.writeText(url); alert('直链已复制，可在 PotPlayer/VLC「打开网络串流」中粘贴'); }
  catch { prompt('复制以下直链：', url); }
}
// 与视频教学共用同一份脚本（服务端两个端点回同一个文件，装一次两边都能调起）
function dlExtSetup() { api.download('/vc/extplayer', 'register-external-player.cmd').catch(() => {}); }
function onTimeUpdate() {
  const v = videoEl.value;
  if (!v || !track || !curMedia.value) return;
  const t = v.currentTime;
  if (!v.seeking && !v.paused) {
    const d = t - track.last;
    if (d > 0 && d <= 2.5) track.watched += d; // 跳进度/拖动条/续播 seek 产生的巨大间隔不计
  }
  track.last = t;
  track.maxPos = Math.max(track.maxPos, t);
  if (v.duration && isFinite(v.duration)) track.dur = v.duration;
}
function onEnded() {
  if (track && videoEl.value) { track.maxPos = Math.max(track.maxPos, videoEl.value.duration || track.maxPos); }
  flushMedia();
  if (loopPlay.value) playNextInFolder(); // 循环开启时接播文件夹内下一个
}

async function flushMedia() {
  if (!curMedia.value || !track) return;
  const body = {
    path: displayPath(curMedia.value.rel), ext: curMedia.value.ext,
    duration_sec: Math.round(track.dur), position_sec: Math.round(track.maxPos),
    watched_sec: Math.round(track.watched),
  };
  track.watched = 0;
  if (body.watched_sec <= 0 && body.position_sec <= 0) return; // 无增量不写库
  try { await api.post('/vc/progress', body); } catch { /* 上报失败丢本批，下一批再补 */ }
}

// ---------- 收尾 ----------
function stopAll() {
  flushMedia();
  closeMedia();
  if (flushTimer) { clearInterval(flushTimer); flushTimer = null; }
}
onMounted(async () => {
  await loadCfg();
  if (cfg.value.root_ok) {
    if (!rootOpen.value) toggleRoot();          // 进页直接展开根目录
    loadHistory(1);                             // 播放历史第一页
    flushTimer = setInterval(flushMedia, 15000); // 15 秒一批上报进度
  }
  applyLocal();
  window.addEventListener('wb-local-base', onLocalEvt);
  probeLocalBase();
  // 页面被关闭/刷新时用 sendBeacon 补最后一笔（无法带 Authorization 头，走 ?token=）
  beaconHandler = () => {
    if (!curMedia.value || !track || (track.watched <= 0 && track.maxPos <= 0)) return;
    const b = { path: displayPath(curMedia.value.rel), ext: curMedia.value.ext, duration_sec: Math.round(track.dur), position_sec: Math.round(track.maxPos), watched_sec: Math.round(track.watched) };
    try { navigator.sendBeacon(`/api/vc/progress?token=${encodeURIComponent(getToken())}`, new Blob([JSON.stringify(b)], { type: 'application/json' })); } catch { /* 尽力而为 */ }
  };
  window.addEventListener('beforeunload', beaconHandler);
});
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', beaconHandler);
  window.removeEventListener('wb-local-base', onLocalEvt);
  stopAll();
});
</script>

<style scoped>
.vc-empty { padding: 40px 20px; }
.vc-head { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
.vc-head .cur { font-size: 14.5px; font-weight: 600; }
.lb { margin-left: auto; font-size: 11.5px; padding: 2px 10px; border-radius: 10px; border: 1px solid var(--border); color: var(--text3); }
.lb.ok { color: var(--green); border-color: var(--green); }
.zone-head .lb.resume { margin-left: 0; color: var(--accent); border-color: var(--accent); }
.vc-main { display: flex; gap: 12px; align-items: stretch; }
.tree { width: 25%; min-width: 230px; max-height: 74vh; overflow: auto; padding: 10px; }
.tree-root { font-weight: 600; padding: 5px 6px; cursor: pointer; border-radius: 6px; }
.tree-root:hover { background: var(--bg3); }
.tree-children { margin-left: 6px; }
.zone { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.zone-head { display: flex; align-items: center; gap: 10px; font-size: 13.5px; margin-bottom: 8px; }
.zone-head .grow { flex: 1; }
/* 播放器（下方还挂着播放历史与外部播放器行，高度收一点） */
.player-zone video { width: 100%; max-height: 56vh; background: #000; border-radius: 8px; }
/* 文件夹内循环开关（播放中显示在标题行） */
.zone-head .lp { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--text3); cursor: pointer; user-select: none; white-space: nowrap; }
.zone-head .lp input { margin: 0; cursor: pointer; }
/* ---------- 播放历史 ---------- */
.his { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 8px; }
.his-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.his-title { font-size: 13.5px; font-weight: 600; }
.his-tb { width: 100%; border-collapse: collapse; font-size: 12.5px; table-layout: fixed; }
.his-tb th { text-align: left; font-weight: 600; color: var(--text3); font-size: 12px; padding: 4px 6px; border-bottom: 1px solid var(--border); }
.his-tb td { padding: 5px 6px; border-bottom: 1px solid var(--border); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.his-tb .c-time { width: 120px; color: var(--text3); font-size: 12px; }
.his-tb .c-dir { width: 16%; color: var(--text2); }
.his-tb .c-name { width: 26%; }
.his-tb .c-path { color: var(--text3); font-size: 12px; }
.his-row { cursor: pointer; }
.his-row:hover { background: var(--bg3); }
.his-row.cur td { color: var(--accent); }
.his-page { display: flex; align-items: center; gap: 8px; padding: 8px 0 2px; }
.his-page button, .his-head button { white-space: nowrap; }
.his-page select { flex: 0 0 auto; width: auto; background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 3px 6px; font-size: 12.5px; }
/* 外部播放器按钮行（置于播放历史下方）：HEVC 10bit/4K 交给本地播放器 */
.ext-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; padding: 10px 0 2px; border-top: 1px solid var(--border); margin-top: 4px; }
.ext-row .ext-tip { font-size: 12px; line-height: 1.7; }
.ext-tip a { color: var(--accent); }
.ph { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; color: var(--text3); font-size: 14px; min-height: 260px; text-align: center; }
.small { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 6px 14px; font-size: 13px; cursor: pointer; text-decoration: none; }
.grow { flex: 1; }
.muted { color: var(--text3); }
.ld { padding: 3px 6px; font-size: 12px; }
.ld.err { color: var(--red); }
</style>
