<template>
  <div class="piano">
    <!-- ============ 上：操作模块 ============ -->
    <div class="card ops">
      <div class="row" style="align-items:center; gap:10px; flex-wrap:wrap">
        <template v-if="recState === 'idle'">
          <button class="primary rec-btn" @click="startRec('audio')">🎤 开始录音</button>
          <button class="rec-btn vid" @click="startRec('video')">🎥 开始录像</button>
          <div class="size-chips" title="录像画面尺寸（160 更省空间，可随时改回 320）">
            <span class="sc-label">尺寸</span>
            <div class="grp">
              <button :class="['chip', videoSize === 160 ? 'on' : '']" @click="setSize(160)">160</button>
              <button :class="['chip', videoSize === 320 ? 'on' : '']" @click="setSize(320)">320</button>
            </div>
          </div>
        </template>
        <template v-else-if="recState === 'recording'">
          <span class="rec-dot" :title="recKind === 'video' ? '录像中' : '录音中'"></span>
          <span class="rec-time">● {{ recKind === 'video' ? `录像中 ${recSize}p` : '录音中' }} {{ fmtDur(recSecs) }}</span>
          <button class="rec-btn stop" @click="stopRec">⏹ 停止并保存</button>
          <video v-if="recKind === 'video'" ref="camPreview" class="cam-preview" muted playsinline></video>
        </template>
        <span v-else class="muted">{{ recKind === 'video' ? '视频' : '录音' }}上传中…</span>
        <span class="muted" style="font-size:12.5px">
          录音/录像各是独立按钮，点哪个就录哪种；录像默认 160 小画面（10 分钟约 8MB），可点「尺寸」换回 320（约 13MB）；停止后自动上传，录制时长计入练习时长，有效时长由有权限的成员确认后生效。
        </span>
      </div>
      <div v-if="recError" class="warn">{{ recError }}</div>
      <div class="guide">
        🎙 首次录音/录像需允许浏览器麦克风（录像还需摄像头）权限：点击地址栏左侧的 🔒 图标 →「网站设置」→ 麦克风/摄像头 →「允许」→ 刷新页面重试；
        录像请用 Chrome/Edge 电脑浏览器（手机浏览器对摄像头支持不一）。
      </div>
    </div>

    <!-- ============ 中：统计看板 ============ -->
    <div class="stat-row">
      <div class="stat"><div class="v">{{ fmtDur(stats.total_sec) }}</div><div class="k">累计总练习时长</div></div>
      <div class="stat"><div class="v">{{ fmtDur(stats.month_sec) }}</div><div class="k">本月练习时长</div></div>
      <div class="stat ok"><div class="v">{{ fmtDur(stats.valid_sec) }}</div><div class="k">有效时长</div></div>
      <div class="stat tool">
        <div class="k" style="margin-bottom:6px">统计成员</div>
        <select v-model.number="statUid" style="width:150px" @change="loadStats">
          <option v-for="u in users" :key="u.id" :value="u.id">{{ u.name }}</option>
        </select>
      </div>
    </div>

    <!-- ============ 下：明细列表 ============ -->
    <div class="card list">
      <h3>练琴明细 <span class="muted" style="font-size:12px; font-weight:400">音频点「▶ 播放」；视频点缩略图弹窗查看</span></h3>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>序号</th><th>有效性确认</th><th>成员</th><th>时间日期</th><th>登记时间</th>
              <th>有效时间</th><th>录音开始</th><th>录音结束</th><th>录音/录像</th><th>容量</th><th>删原文件</th><th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(r, i) in rows" :key="r.id">
              <td>{{ (page - 1) * pageSize + i + 1 }}</td>
              <td>
                <template v-if="canConfirm">
                  <label class="ck" title="勾选确认有效时长">
                    <input type="checkbox" style="width:auto" :checked="!!r.confirmed" @change="onConfirmToggle(r, $event)" />
                    <span v-if="r.confirmed" class="badge blue">已确认</span>
                  </label>
                </template>
                <span v-else-if="r.confirmed" class="badge blue">已确认</span>
                <span v-else class="muted">未确认</span>
              </td>
              <td>{{ r.user_name || '—' }}</td>
              <td>{{ dPart(r.started_at || r.created_at) }}</td>
              <td>{{ tPart(r.created_at) }}</td>
              <td>
                <span v-if="r.confirmed" class="ok-text">{{ fmtDur(r.valid_sec) }}</span>
                <span v-else class="muted">—</span>
              </td>
              <td>{{ tPart(r.started_at) || '—' }}</td>
              <td>{{ tPart(r.ended_at) || '—' }}</td>
              <td class="path-cell">
                <template v-if="r.file_deleted">
                  <span class="muted">— 原文件已清理 —</span>
                </template>
                <template v-else-if="r.kind === 'video'">
                  <img v-if="r.thumb" class="thumb" :src="r.thumb" title="点击放大查看视频" @click="openViewer(r)" />
                  <span v-else class="path play" title="点击查看视频" @click="openViewer(r)">🎬 查看</span>
                  <span class="path-txt" :title="r.file_path">{{ shortPath(r.file_path) }}</span>
                </template>
                <template v-else>
                  <span class="path play" :title="r.file_path" @click="togglePlay(r)">
                    {{ playingId === r.id ? '⏸ 播放中' : '▶ 播放' }}
                  </span>
                  <span class="path-txt" :title="r.file_path">{{ shortPath(r.file_path) }}</span>
                </template>
                <span v-if="!r.file_deleted && channel" class="lb" :class="{ ok: channel === 'local' }" :title="channel === 'local' ? '媒体经局域网直连读取' : '媒体经当前公网地址读取'">
                  {{ channel === 'local' ? '⚡内网' : '公网' }}
                </span>
              </td>
              <td>
                <span v-if="r.file_deleted" class="muted">—</span>
                <span v-else-if="r.file_size">{{ fmtSize(r.file_size) }}</span>
                <span v-else class="muted">—</span>
              </td>
              <td>
                <button v-if="canDel(r) && !r.file_deleted && r.file_path" class="icon-btn" title="删除原文件：保留练习记录，仅清理磁盘文件释放空间" @click="delFile(r)">🧹</button>
                <span v-else class="muted">—</span>
              </td>
              <td><button v-if="canDel(r)" class="icon-btn" title="删除" @click="delRec(r)">✕</button></td>
            </tr>
          </tbody>
        </table>
        <div v-if="!rows.length && !loading" class="empty">还没有录音记录，点上方「开始录音」练一曲吧</div>
      </div>
      <div class="row foot">
        <span class="muted" style="font-size:12px">共 {{ total }} 条</span>
        <span class="grow"></span>
        <button class="small" :disabled="page <= 1" @click="loadList(page - 1)">‹ 上一页</button>
        <span class="muted" style="font-size:12px">{{ page }} / {{ totalPages }}</span>
        <button class="small" :disabled="page >= totalPages" @click="loadList(page + 1)">下一页 ›</button>
        <select v-model.number="pageSize" title="每页条数" @change="loadList(1)">
          <option :value="15">15 行</option><option :value="30">30 行</option><option :value="50">50 行</option>
        </select>
      </div>
    </div>

    <!-- 有效时长填写弹窗：默认为本条录音时长，可修改保存 -->
    <div v-if="cf.show" class="modal-backdrop" @click.self="cf.show = false">
      <div class="modal" style="width:min(380px, 92vw)">
        <h3>确认有效时长</h3>
        <p class="muted" style="font-size:13px">
          {{ cf.row?.user_name }} · 录音时长 {{ fmtDur(cf.row?.duration_sec) }}（{{ tPart(cf.row?.started_at) }} ~ {{ tPart(cf.row?.ended_at) }}）
        </p>
        <div class="form-row"><label>有效时长（分钟）</label><input v-model.number="cf.minutes" type="number" min="0" step="0.1" style="width:140px" /></div>
        <div class="row" style="justify-content:flex-end; gap:8px">
          <button class="small" @click="cf.show = false">取消</button>
          <button class="primary" @click="saveConfirm">保存</button>
        </div>
      </div>
    </div>

    <!-- 视频查看弹窗：点列表缩略图放大播放 -->
    <div v-if="viewer.show" class="modal-backdrop" @click.self="closeViewer">
      <div class="modal viewer-modal">
        <div class="row" style="justify-content:space-between; align-items:center; gap:10px">
          <h3 style="margin:0">
            🎬 录像回放
            <span class="muted" style="font-size:12px; font-weight:400">
              {{ viewer.row?.user_name }} · {{ fmtDur(viewer.row?.duration_sec) }} · {{ fmtSize(viewer.row?.file_size) }}
            </span>
          </h3>
          <button class="small" @click="closeViewer">✕ 关闭</button>
        </div>
        <video class="viewer-video" controls autoplay playsinline :src="viewerSrc" @error="viewer.err = true"></video>
        <div v-if="viewer.err" class="warn">视频加载失败：原文件可能已被清理，或网络中断（内外网通道见列表徽标）。</div>
      </div>
    </div>

    <audio ref="audioEl" @ended="playingId = 0" @error="playingId = 0"></audio>
  </div>
</template>

<script setup>
// 练琴：浏览器录音（MediaRecorder）上传保存到全局上传目录 + 统计看板 + 明细列表 + 有效时长确认。
// 有效时长确认需要 pianoconfirm 受限权限（家长勾选，默认填录音时长可改）。
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { api } from '../api';
import { canTab } from '../tabs';
import { localState, probeLocalBase } from '../utils/localBase';

const me = () => { try { return JSON.parse(localStorage.getItem('wb_user') || 'null'); } catch { return null; } };
const canConfirm = canTab('learning', 'pianoconfirm');
const isAdmin = () => (me() || {}).role === 'admin';
const canDel = (r) => isAdmin() || r.user_id === (me() || {}).id;

// ---------- 列表 + 统计 ----------
const rows = ref([]);
const users = ref([]);
const page = ref(1);
const pageSize = ref(15);
const total = ref(0);
const loading = ref(false);
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
const stats = ref({ total_sec: 0, month_sec: 0, valid_sec: 0 });
const statUid = ref((me() || {}).id || 0);

async function loadList(p = 1) {
  loading.value = true;
  page.value = p;
  try {
    const r = await api.get(`/piano/records?page=${p}&pageSize=${pageSize.value}`);
    rows.value = r.rows || [];
    total.value = r.total || 0;
    if (Array.isArray(r.users) && r.users.length) users.value = r.users;
    queueBackfillThumbs();
  } catch { rows.value = []; total.value = 0; }
  loading.value = false;
}

// ---------- 缩略图回填：没抓到帧的老视频，进页面时客户端从视频文件抽一帧补上 ----------
// （缩略图是录制时客户端抓帧存的——相机冷启动的短录像常错过窗口；回填走本站相对地址，同源无 canvas 污染）
const thumbTried = new Set(); // 本会话已试过的记录 id（失败也不反复加载大视频）
function queueBackfillThumbs() {
  const todo = rows.value.filter((r) => r.kind === 'video' && !r.thumb && !r.file_deleted && !thumbTried.has(r.id)).slice(0, 8);
  (async () => { for (const r of todo) { thumbTried.add(r.id); await backfillThumb(r); } })(); // 串行省带宽
}
async function backfillThumb(r) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto';
  v.src = `/api/piano/file/${r.id}?token=${encodeURIComponent(localStorage.getItem('wb_token') || '')}`;
  try {
    await new Promise((res, rej) => { v.onloadeddata = res; v.onerror = rej; setTimeout(rej, 10000); });
    v.currentTime = Math.min(1, (v.duration || 2) / 2); // 抽第 1 秒（太短的视频取中点）
    await new Promise((res) => { v.onseeked = res; setTimeout(res, 1500); }); // seek 卡住也不致命：拿到哪帧算哪帧
    const c = document.createElement('canvas');
    c.width = 120;
    c.height = Math.max(1, Math.round((120 * v.videoHeight) / v.videoWidth) || 90);
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', 0.55);
    if (url.length > 1000) { await api.patch(`/piano/thumb/${r.id}`, { thumb: url }); r.thumb = url; }
  } catch { /* 下次进页面再试 */ }
  finally { v.removeAttribute('src'); try { v.load(); } catch { /* 释放 */ } }
}
async function loadStats() {
  try { stats.value = await api.get(`/piano/stats?user_id=${statUid.value}`); } catch { /* 忽略 */ }
}
async function delRec(r) {
  if (!confirm(`删除这条记录？（${r.user_name} · ${fmtDur(r.duration_sec)}，原文件会一并删除）`)) return;
  try { await api.del(`/piano/${r.id}`); await Promise.all([loadList(page.value), loadStats()]); }
  catch (e) { alert('删除失败：' + e.message); }
}
// 清理原文件：保留练习记录与有效时长，仅删磁盘文件释放空间
async function delFile(r) {
  if (!confirm(`删除该条原文件？（保留练习记录和有效时长，仅清理磁盘文件${r.file_size ? `（释放 ${fmtSize(r.file_size)}）` : ''}）`)) return;
  try { await api.del(`/piano/file/${r.id}`); await loadList(page.value); }
  catch (e) { alert('清理失败：' + e.message); }
}

// ---------- 有效性确认 ----------
const cf = ref({ show: false, row: null, minutes: 0 });
function onConfirmToggle(r, ev) {
  if (ev.target.checked) {
    cf.value = { show: true, row: r, minutes: Math.round((r.duration_sec / 60) * 10) / 10 }; // 默认=录音时长
    ev.target.checked = false; // 弹窗保存后才真正勾上（取消则维持未确认）
  } else {
    if (!confirm('取消该条的有效确认？（有效时长将清零）')) { ev.target.checked = true; return; }
    api.patch(`/piano/unconfirm/${r.id}`).then(() => loadList(page.value)).catch((e) => alert('操作失败：' + e.message));
  }
}
async function saveConfirm() {
  const sec = Math.max(0, Math.round((Number(cf.value.minutes) || 0) * 60));
  try {
    await api.patch(`/piano/confirm/${cf.value.row.id}`, { valid_sec: sec });
    cf.value.show = false;
    await Promise.all([loadList(page.value), loadStats()]);
  } catch (e) { alert('保存失败：' + e.message); }
}

// ---------- 录音/录像（两个独立按钮，点哪个录哪种；录像尺寸 160 默认/320 可选） ----------
const recState = ref('idle'); // idle | recording | uploading
const recKind = ref('audio'); // 本次录制的类型（audio|video，点按钮时定格）
const videoSize = ref(Number(localStorage.getItem('wb_piano_video_size')) === 320 ? 320 : 160); // 录像画面尺寸
const recSecs = ref(0);
const recError = ref('');
const camPreview = ref(null);
let mediaStream = null;
let recorder = null;
let recChunks = [];
let recTimer = null;
let recStartedAt = '';
let recSize = 160;         // 本次录像实际使用的尺寸（展示用，开录时定格）
let recThumb = '';         // 视频缩略图（base64 JPEG，开录后抓一帧）
function setSize(s) { videoSize.value = s; localStorage.setItem('wb_piano_video_size', String(s)); }

async function startRec(mode) {
  recError.value = '';
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    recError.value = '当前浏览器不支持录制，请使用 Chrome / Edge 浏览器'; return;
  }
  const isVideo = mode === 'video';
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia(isVideo
      ? { audio: true, video: { width: { ideal: videoSize.value }, height: { ideal: Math.round(videoSize.value * 0.75) }, frameRate: { ideal: 10 } } }
      : { audio: true });
  }
  catch (e) {
    recError.value = e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError'
      ? `浏览器已拒绝${isVideo ? '摄像头/麦克风' : '麦克风'}权限：点击地址栏左侧的 🔒 图标 → 网站设置 → ${isVideo ? '摄像头、麦克风' : '麦克风'} → 允许，然后重新录制`
      : e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError' || e.name === 'OverconstrainedError'
        ? `浏览器找不到${isVideo ? '摄像头或麦克风' : '麦克风'}设备（不是权限问题）：① 电脑需已插入/自带设备（台式机常无摄像头，可插 USB 摄像头）② Windows 设置→隐私→麦克风/摄像头 开关全开（含「允许桌面应用」）③ 声音设置→录制设备 未被禁用。改完地址栏输入 chrome://restart 重启浏览器再试`
        : e.name === 'NotReadableError'
          ? `摄像头/麦克风被其他程序占用（微信/腾讯会议/别的网页标签）：关掉占用它们的程序或标签页，再重新录制`
          : `无法访问${isVideo ? '摄像头/麦克风' : '麦克风'}：` + e.message;
    return;
  }
  recKind.value = isVideo ? 'video' : 'audio';
  recSize = isVideo ? videoSize.value : 0;
  recThumb = '';
  recChunks = [];
  let mime = '';
  if (isVideo) {
    mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus') ? 'video/webm;codecs=vp8,opus'
      : MediaRecorder.isTypeSupported('video/webm') ? 'video/webm' : '';
  } else {
    mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
  }
  // 低码率出小文件：160p=80kbps+音频24kbps≈13KB/s（10 分钟约 8MB）；320p=150kbps+24kbps≈22KB/s（约 13MB）
  const opts = { ...(mime ? { mimeType: mime } : {}) };
  if (isVideo) { opts.videoBitsPerSecond = videoSize.value >= 320 ? 150000 : 80000; opts.audioBitsPerSecond = 24000; }
  recorder = new MediaRecorder(mediaStream, opts);
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) recChunks.push(e.data); };
  recorder.onstop = uploadRec;
  recStartedAt = new Date().toLocaleString('sv').slice(0, 19);
  recorder.start();
  recState.value = 'recording'; // 预览 <video> 的 v-if 依赖此状态，必须先置位再挂画面
  recSecs.value = 0;
  recTimer = setInterval(() => { recSecs.value += 1; }, 1000);
  if (isVideo) { // 摄像头实时预览 + 抓一帧当列表缩略图（等 <video> 渲染出来）
    await nextTick();
    if (camPreview.value) {
      camPreview.value.srcObject = mediaStream;
      camPreview.value.play().catch(() => {});
      // 相机冷启动 videoWidth 可能几秒才就绪：错峰多轮尝试，短录像不再整个错过抓帧窗口
      setTimeout(() => grabThumb(8), 600);
      setTimeout(() => grabThumb(4), 2500);
      setTimeout(() => grabThumb(2), 5000);
    }
  }
}

// 从预览画面抓一帧生成小缩略图（等画面就绪，最多重试 tries 次；后抓到的帧覆盖——相机热身后画质更好）
function grabThumb(tries) {
  try {
    const v = camPreview.value;
    if (!v || !v.videoWidth) { if (tries > 0 && recState.value === 'recording') setTimeout(() => grabThumb(tries - 1), 300); return; }
    const c = document.createElement('canvas');
    c.width = 120;
    c.height = Math.max(1, Math.round((120 * v.videoHeight) / v.videoWidth));
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', 0.55);
    // toDataURL 对未就绪画面会吐出几十字节的空白串——长度兜底才算成功
    if (url.length > 1000 && recState.value === 'recording') recThumb = url;
  } catch { /* 缩略图失败不影响录制 */ }
}
function stopRec() {
  // 停录前最后补抓一帧：预览画面这时一定在播（几秒的短测试录像此前常错过抓帧窗口→列表只剩「查看」链接）
  if (recKind.value === 'video' && !recThumb) grabThumb(0);
  if (recorder && recorder.state !== 'inactive') recorder.stop(); // onstop → uploadRec
  if (recTimer) { clearInterval(recTimer); recTimer = null; }
}
async function uploadRec() {
  recState.value = 'uploading';
  try {
    const isVideo = recKind.value === 'video';
    const blob = new Blob(recChunks, { type: (recorder && recorder.mimeType) || (isVideo ? 'video/webm' : 'audio/webm') });
    if (blob.size < 1000 || recSecs.value < 1) throw new Error('录制太短，已丢弃');
    const fd = new FormData();
    fd.append('media', blob, `piano-${Date.now()}-${recKind.value}.webm`);
    fd.append('kind', recKind.value);
    if (isVideo && recThumb) fd.append('thumb', recThumb);
    fd.append('duration_sec', String(recSecs.value));
    fd.append('started_at', recStartedAt);
    fd.append('ended_at', new Date().toLocaleString('sv').slice(0, 19));
    const res = await fetch('/api/piano/upload', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + (localStorage.getItem('wb_token') || '') },
      body: fd,
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `上传失败 (${res.status})`);
    await Promise.all([loadList(1), loadStats()]);
  } catch (e) { alert('录制保存失败：' + e.message); }
  releaseMic();
  recState.value = 'idle';
}
function releaseMic() {
  if (mediaStream) { for (const t of mediaStream.getTracks()) t.stop(); mediaStream = null; }
  recorder = null;
}

// ---------- 录音播放（内外网通道跟随 localBase） ----------
const audioEl = ref(null);
const playingId = ref(0);
const channel = ref('');
let mediaBase = '';
function applyLocal() {
  const s = localState();
  mediaBase = s.base;
  channel.value = s.lan || s.ok ? 'local' : s.configured ? 'net' : '';
}
const onLocalEvt = () => applyLocal();
function togglePlay(r) {
  if (playingId.value === r.id) { try { audioEl.value.pause(); } catch {} playingId.value = 0; return; }
  playingId.value = r.id;
  nextTick(() => {
    audioEl.value.src = `${mediaBase}/api/piano/file/${r.id}?token=${encodeURIComponent(localStorage.getItem('wb_token') || '')}`;
    audioEl.value.play().catch(() => { playingId.value = 0; });
  });
}

// ---------- 视频查看弹窗（点缩略图放大播放；媒体源跟内外网通道） ----------
const viewer = ref({ show: false, row: null, err: false });
const viewerSrc = computed(() => viewer.value.row
  ? `${mediaBase}/api/piano/file/${viewer.value.row.id}?token=${encodeURIComponent(localStorage.getItem('wb_token') || '')}`
  : '');
function openViewer(r) { viewer.value = { show: true, row: r, err: false }; }
function closeViewer() {
  const v = document.querySelector('.viewer-video');
  if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch { /* 忽略 */ } }
  viewer.value = { show: false, row: null, err: false };
}

// ---------- 展示 ----------
const dPart = (t) => String(t || '').slice(0, 10);
const tPart = (t) => String(t || '').slice(11, 19);
function fmtDur(s) {
  const v = Math.round(Number(s) || 0);
  if (v < 60) return `${v} 秒`;
  if (v < 3600) return `${Math.floor(v / 60)} 分 ${v % 60} 秒`;
  return `${(v / 3600).toFixed(1)} 小时`;
}
function fmtSize(n) {
  const v = Number(n) || 0;
  if (!v) return '—';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}
const shortPath = (p) => {
  const s = String(p || '');
  return s.length > 42 ? '…' + s.slice(-40) : s;
};

onMounted(() => {
  loadList(1);
  loadStats();
  applyLocal();
  window.addEventListener('wb-local-base', onLocalEvt);
  probeLocalBase();
});
onBeforeUnmount(() => {
  window.removeEventListener('wb-local-base', onLocalEvt);
  if (recState.value === 'recording') stopRec();
  releaseMic();
  if (viewer.value.show) closeViewer();
  try { audioEl.value?.pause(); } catch { /* 忽略 */ }
});
</script>

<style scoped>
.ops { padding: 16px 18px; margin-bottom: 12px; }
.rec-btn { font-size: 15px; padding: 10px 24px; border: none; border-radius: 10px; background: var(--accent); color: #fff; cursor: pointer; }
.rec-btn.stop { background: #e5484d; }
.rec-dot { width: 12px; height: 12px; border-radius: 50%; background: #e5484d; animation: blink 1s infinite; }
@keyframes blink { 50% { opacity: .2; } }
.rec-time { font-weight: 600; color: #e5484d; }
.rec-btn.vid { background: #2e9e5b; }
.size-chips { display: inline-flex; align-items: center; gap: 6px; }
.size-chips .sc-label { font-size: 12px; color: var(--text3); }
.size-chips .grp { display: inline-flex; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
.size-chips .chip { padding: 8px 14px; border: none; background: var(--bg3); color: var(--text3); cursor: pointer; font-size: 13px; }
.size-chips .chip + .chip { border-left: 1px solid var(--border); }
.size-chips .chip.on { background: var(--accent); color: #fff; font-weight: 600; }
.cam-preview { width: 120px; border-radius: 8px; border: 1px solid var(--border); background: #000; }
.thumb { width: 48px; height: 36px; object-fit: cover; border-radius: 6px; border: 1px solid var(--border); cursor: zoom-in; flex-shrink: 0; }
.thumb:hover { border-color: var(--accent); }
.viewer-modal { width: min(640px, 94vw); }
.viewer-video { width: 100%; max-height: 70vh; margin-top: 10px; border-radius: 10px; background: #000; }
.warn { margin-top: 10px; font-size: 13px; color: var(--red, #e5484d); }
.guide { margin-top: 10px; padding: 8px 12px; border-radius: 8px; background: var(--bg3); font-size: 12px; color: var(--text3); line-height: 1.7; }
.stat-row { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 12px; }
.stat { flex: 1; min-width: 150px; background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px; }
.stat .v { font-size: 20px; font-weight: 700; }
.stat .k { font-size: 12.5px; color: var(--text3); margin-top: 4px; }
.stat.ok .v { color: var(--green, #2e9e5b); }
.stat.tool { flex: 0 0 auto; min-width: 190px; display: flex; flex-direction: column; justify-content: center; }
.list { padding: 16px 18px; }
.list h3 { margin-bottom: 10px; }
.tbl-wrap { overflow-x: auto; }
.tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.tbl th { text-align: left; font-weight: 500; color: var(--text3); padding: 6px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.tbl td { padding: 7px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.ck { cursor: pointer; display: inline-flex; align-items: center; gap: 5px; }
.ok-text { color: var(--green, #2e9e5b); font-weight: 600; }
.path-cell { display: flex; align-items: center; gap: 6px; max-width: 380px; }
.path.play { color: var(--accent); cursor: pointer; font-weight: 600; flex-shrink: 0; }
.path-txt { max-width: 240px; overflow: hidden; text-overflow: ellipsis; color: var(--text3); direction: rtl; text-align: left; }
.lb { font-size: 10.5px; padding: 1px 7px; border-radius: 10px; border: 1px solid var(--border); color: var(--text3); flex-shrink: 0; }
.lb.ok { color: var(--green, #2e9e5b); border-color: var(--green, #2e9e5b); }
.badge.blue { background: rgba(79, 124, 247, .15); color: var(--accent, #4f7cf7); border-radius: 10px; padding: 1px 8px; font-size: 11px; }
.foot { margin-top: 10px; align-items: center; gap: 8px; }
.small { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 6px 14px; font-size: 13px; cursor: pointer; }
.grow { flex: 1; }
.muted { color: var(--text3); }
</style>
