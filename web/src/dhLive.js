// 实时对话 composable（v1.12.1）：DhPanel「数字人界面」与 DhPhone 右下角悬浮窗共用。
// 链路：服务端建 Vivix 会话（API Key 只在服务端）→ 浏览器 WSS 控制通道 + TRTC 拉流。
// 契约=docs.vivix.ai（TRTC 官方接入示例 + client-events）：enterRoom(autoReceiveVideo:false)，
// REMOTE_VIDEO_AVAILABLE 且 userId=publisher_user_id 才 startRemoteVideo；AUTOPLAY_FAILED 存
// resume 回调做一键恢复；文字=conversation.item.create（等 created 再 response.create，要
// audio+text）；对方文字=response.output_text.delta 流式累积；session.closed 带 reason。
// 每一句都 POST /dh/history 落库并 bump dhState.histVer——「聊天记录」页与悬浮窗同步可见。
// 注意：服务端同一数字人只保一个在途会话（重复 start 会先补关旧的），两处界面同时开流时
// 后开的会把先开的顶掉（先开的 WSS 断开、界面回到未开启态）——v1.12.1 接受此口径。
import { reactive, ref } from 'vue';
import { api } from './api';
import { dhState } from './dhState';

let TRTCLib = null; // trtc-sdk-v5 按需加载（1.1MB 懒分块），不进首屏包

export function useDhLive({ viewId, getPersona }) {
  let ws = null, rtc = null;
  const resumes = new Set();
  let closingByUser = false, deltaBuf = '', deltaTimer = 0, respondTimer = 0, pendingRespond = false;
  let dimTimer = 0;
  // vw/vh=直播流的真实宽高（首帧后从 TRTC 塞进来的 video 元素量出）——舞台盒用它等比呈现，
  // 不再按人设 aspect 硬套（v1.12.2：竖流在 16:9 盒子里被 cover 裁成只剩中间条）
  const live = reactive({ on: false, busy: false, sessionId: '', status: '', err: '', needResume: false, micOn: false, vw: 0, vh: 0 });
  const liveText = ref('');
  const liveItems = ref([]); // 本次会话内的即时气泡（{role,text}；正式记录以 dh_history 为准）

  function pushLive(role, text) { liveItems.value.push({ role, text }); }

  function scheduleFlush() { clearTimeout(deltaTimer); deltaTimer = setTimeout(flushDelta, 2500); }
  async function flushDelta() {
    clearTimeout(deltaTimer);
    const t = deltaBuf.trim();
    deltaBuf = '';
    if (!t || !getPersona()) return;
    pushLive('assistant', t);
    try {
      await api.post('/dh/history', { persona_id: getPersona().id, role: 'assistant', text: t });
      dhState.histVer++;
    } catch { /* 落库失败不影响会话进行 */ }
  }

  function closedReason(r) {
    return {
      client: '会话已结束',
      disconnected_timeout: '连接断开超时，会话自动结束',
      interaction_idle: '长时间没有互动，会话自动结束',
      max_duration: '达到会话时长上限（默认 20 分钟），会话结束',
      server_maintenance: 'Vivix 服务端维护，会话结束',
    }[r] || `会话已结束（${r || '未知原因'}）`;
  }

  function wsSend(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  // 2026-10-07 生产定案：Vivix 报 505001/AUDIO_PREPARE_UPSTREAM_ERROR 是**输出侧 TTS 上游失败**
  // （纯文字回复同样复现，与麦克风无关；当时是音色 longwanxiao_v3.6 上游损坏）。映射成人话指路，
  // 别让用户误以为是麦克风/网络问题。
  function friendlyErr(e) {
    const msg = String((e && (e.message || e)) || '控制通道收到错误事件');
    const code = e && e.code ? String(e.code) : '';
    if (/AUDIO_PREPARE_UPSTREAM_ERROR|505001/.test(msg + ' ' + code)) {
      return `语音合成上游失败（${code || 'TTS'}）——多半是当前音色在 Vivix 侧故障或额度不足，到「设置 → 基本信息」换个音色再开实时对话；未开实时时的文字试聊不受影响`;
    }
    return msg;
  }

  // 首帧后量流的真实宽高（TRTC 把 <video> 塞进 view 容器；loadedmetadata 前 videoWidth=0）
  function watchStreamSize() {
    clearInterval(dimTimer);
    let tries = 0;
    dimTimer = setInterval(() => {
      tries++;
      const v = document.getElementById(viewId) && document.getElementById(viewId).querySelector('video');
      if (v && v.videoWidth > 0) { live.vw = v.videoWidth; live.vh = v.videoHeight; clearInterval(dimTimer); }
      else if (tries > 80 || !live.on) clearInterval(dimTimer); // ~48 秒还没首帧就放弃（保持人设比例）
    }, 600);
  }

  function onControlEvent(ev) {
    let d; try { d = JSON.parse(ev.data); } catch { return; }
    const t = d.type || '';
    if (t === 'response.output_text.delta') {
      deltaBuf += String(d.delta != null ? d.delta : '');
      live.status = '对方回应中…';
      scheduleFlush(); // 没有 completed 事件也兜底落一段（2.5 秒无新 delta 即收口）
    } else if (t === 'response.completed' || t === 'response.done') {
      live.status = '实时';
      flushDelta();
    } else if (t === 'conversation.item.created' && pendingRespond) {
      // 用户消息已被服务端确认 → 触发一次回复（音+字都要，文字回流进气泡区）
      pendingRespond = false; clearTimeout(respondTimer);
      wsSend({ type: 'response.create', response: { modalities: ['audio', 'text'] } });
    } else if (t === 'session.closed') {
      flushDelta();
      live.on = false;
      live.err = closedReason(d.reason);
      cleanupLive();
    } else if (t === 'error') {
      live.err = friendlyErr(d.error);
    }
  }

  function openControl(c) {
    return new Promise((resolve, reject) => {
      const u = new URL(c.url);
      u.searchParams.set('token', c.client_secret);
      let w;
      try { w = new WebSocket(u.toString()); } catch { return reject(new Error('控制通道地址无法连接')); }
      ws = w;
      const timer = setTimeout(() => { try { w.close(); } catch { /* 已断 */ } reject(new Error('控制通道连接超时（15 秒）')); }, 15000);
      w.onopen = () => { clearTimeout(timer); resolve(); };
      w.onerror = () => { clearTimeout(timer); reject(new Error('控制通道连接失败（网络或凭证问题）')); };
      w.onmessage = onControlEvent;
      w.onclose = () => {
        if (ws !== w) return; // cleanup 已接管，不算异常断开
        flushDelta();
        live.on = false;
        live.err = '控制通道断开——会话可能已结束，可重新开启实时对话';
        cleanupLive();
      };
    });
  }

  async function joinRoom(m) {
    if (!m || !m.user_sig || m.room_id == null) throw new Error('会话未返回 TRTC 拉流凭证（delivery.media.trtc 缺失）');
    if (!TRTCLib) TRTCLib = (await import('trtc-sdk-v5')).default;
    rtc = TRTCLib.create();
    rtc.on(TRTCLib.EVENT.ERROR, (e) => { live.err = String((e && e.message) || e || 'TRTC 错误'); });
    rtc.on(TRTCLib.EVENT.AUTOPLAY_FAILED, (e) => { if (e && e.resume) resumes.add(e.resume); live.needResume = true; });
    rtc.on(TRTCLib.EVENT.REMOTE_VIDEO_AVAILABLE, ({ userId, streamType }) => {
      if (userId === m.publisher_user_id) {
        rtc.startRemoteVideo({ userId, streamType, view: viewId }).catch((e2) => { live.err = '拉流失败：' + (e2.message || e2); });
      }
    });
    rtc.on(TRTCLib.EVENT.FIRST_VIDEO_FRAME, ({ userId }) => {
      if (userId === m.publisher_user_id) { live.status = '实时'; live.needResume = false; }
    });
    await rtc.enterRoom({
      sdkAppId: Number(m.sdk_app_id), userId: m.user_id, userSig: m.user_sig,
      strRoomId: String(m.room_id), scene: TRTCLib.TYPE.SCENE_RTC, autoReceiveVideo: false,
    });
  }

  function resumePlay() {
    for (const r of resumes) { try { r(); } catch { /* 单个失败不拦其余 */ } }
    resumes.clear();
    live.needResume = false;
  }

  async function toggleMic() {
    if (!rtc) return;
    try {
      if (live.micOn) { await rtc.stopLocalAudio(); live.micOn = false; }
      else { await rtc.startLocalAudio(); live.micOn = true; }
    } catch (e) {
      live.err = '麦克风操作失败：' + (e.message || e) + '（可先用文字对话）';
    }
  }

  async function startLive() {
    const p = getPersona();
    if (!p || live.busy || live.on) return;
    live.busy = true; live.err = ''; live.status = '建立会话…';
    try {
      const s = await api.post(`/dh/personas/${p.id}/session`, {});
      live.sessionId = s.session_id;
      live.status = '连接控制通道…';
      await openControl(s.control);
      live.status = '进入房间…';
      await joinRoom(s.trtc);
      live.on = true;
      live.status = '实时';
      watchStreamSize();
    } catch (e) {
      live.err = e.message || '建立会话失败';
      live.status = '';
      live.on = false;
      cleanupLive();
    } finally {
      live.busy = false;
    }
  }

  async function stopLive() {
    if (live.busy) return;
    live.busy = true;
    closingByUser = true;
    try {
      if (live.sessionId && getPersona()) {
        try {
          await api.post(`/dh/personas/${getPersona().id}/session/close`, { session_id: live.sessionId });
        } catch (e) {
          live.err = '关闭请求未成功：' + e.message + '（断开 90 秒后会话也会自动结束，不影响额度兜底）';
        }
      }
    } finally {
      cleanupLive();
      live.busy = false;
    }
  }

  // 本地资源全量释放（显式结束/出错/会话被关/组件卸载共用；服务端会话由 close 端点或 auto_close 收）
  function cleanupLive() {
    flushDelta();
    const w = ws; ws = null;
    if (w) { w.onclose = w.onerror = w.onmessage = null; try { w.close(); } catch { /* 已断 */ } }
    const r = rtc; rtc = null;
    resumes.clear();
    clearInterval(dimTimer);
    live.needResume = false; live.micOn = false; live.sessionId = ''; live.vw = 0; live.vh = 0;
    closingByUser = false;
    if (r) r.exitRoom().catch(() => {}).finally(() => { try { r.destroy(); } catch { /* 已销毁 */ } });
  }

  async function sendLive() {
    const t = liveText.value.trim();
    const p = getPersona();
    if (!t || !live.on || !p) return;
    wsSend({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: t }] },
    });
    pendingRespond = true;
    clearTimeout(respondTimer); // created 事件 2 秒没到也照常触发回复，不卡对话
    respondTimer = setTimeout(() => {
      if (pendingRespond) {
        pendingRespond = false;
        wsSend({ type: 'response.create', response: { modalities: ['audio', 'text'] } });
      }
    }, 2000);
    liveText.value = '';
    pushLive('user', t);
    live.status = '已发送…';
    try {
      await api.post('/dh/history', { persona_id: p.id, role: 'user', text: t });
      dhState.histVer++;
    } catch { /* 落库失败不影响会话进行 */ }
  }

  return { live, liveItems, liveText, startLive, stopLive, sendLive, resumePlay, toggleMic, cleanupLive, pushLive };
}
