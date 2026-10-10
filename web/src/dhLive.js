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
  // v1.13.3 设备指令：实时会话的对话内容**不经过工作台服务器**（浏览器直连 Vivix 的 WSS），
  // 所以这里由浏览器先问服务端「这句是不是设备指令」——是就当场执行，拿真实回执回来，
  // 再包成一句「系统指令」喂回 Vivix 让它照实念。不这么办，Vivix 的云端模型就会顺着人设
  // 编「好哒哥哥，我去开！」（2026-10-10 生产实测：用户以为开了，设备纹丝不动）。
  let responding = false;        // 是否有回复正在生成（决定补话是立刻发还是等它收口）
  let queuedDeviceTurn = false;  // 系统指令已塞进上下文，等回复收口后触发它开口
  let deviceTimer = 0;
  // vw/vh=直播流的真实宽高（首帧后从 TRTC 塞进来的 video 元素量出）——舞台盒用它等比呈现，
  // 不再按人设 aspect 硬套（v1.12.2：竖流在 16:9 盒子里被 cover 裁成只剩中间条）
  const live = reactive({ on: false, busy: false, sessionId: '', status: '', err: '', needResume: false, micOn: false, vw: 0, vh: 0 });
  const liveText = ref('');
  const liveItems = ref([]); // 本次会话内的即时气泡（{role,text}；正式记录以 dh_history 为准）

  function pushLive(role, text) { liveItems.value.push({ role, text }); }

  // ---------- 设备指令（v1.13.3） ----------
  function deviceDirective(said, result) {
    return `【工作台系统指令·这句用户看不到】用户刚说的是「${said}」。`
      + `这条智能家居指令已由工作台系统执行完毕，真实结果：「${result}」。`
      + `请用你的口吻把「${result}」如实确认一句：不要说你做不到，也不要改动里面的房间名与设备名；`
      + `若结果里是「没找到」或「匹配到多台」，就照实转达，并请用户说清楚是哪一台。`;
  }
  function fireDeviceTurn() {
    if (!live.on || !queuedDeviceTurn) return;
    queuedDeviceTurn = false;
    wsSend({ type: 'response.create', response: { modalities: ['audio', 'text'] } });
  }
  // 把「真实回执」塞回会话：有回复在途就等它收口（completed 里补），否则稍等一拍再开口
  function injectDeviceTurn(said, result) {
    if (!live.on) return;
    wsSend({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: deviceDirective(said, result) }] },
    });
    queuedDeviceTurn = true;
    live.status = '设备指令已执行…';
    clearTimeout(deviceTimer);
    if (responding) return;
    deviceTimer = setTimeout(() => { if (!responding) fireDeviceTurn(); }, 600);
  }
  // 判一次「是不是设备指令」；命中就真执行（服务端调米家）并把回执交回来
  async function checkDeviceCommand(text) {
    try { return await api.post('/dh/smarthome/command', { text }); }
    catch { return null; }   // 判不了（未绑米家/网络抖动）就当普通对话，别拦着用户说话
  }

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
      return `语音合成上游失败（${code || 'TTS'}）——多半是当前音色在 Vivix 侧故障或额度不足，到「角色设置 → 基本信息」换个音色再开实时对话；未开实时时的文字试聊不受影响`;
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
      responding = true;
      deltaBuf += String(d.delta != null ? d.delta : '');
      live.status = '对方回应中…';
      scheduleFlush(); // 没有 completed 事件也兜底落一段（2.5 秒无新 delta 即收口）
    } else if (t === 'response.completed' || t === 'response.done') {
      responding = false;
      live.status = '实时';
      flushDelta();
      if (queuedDeviceTurn) fireDeviceTurn();   // 设备回执等这轮说完再补（见 injectDeviceTurn）
    } else if (t === 'conversation.item.created' && pendingRespond) {
      // 用户消息已被服务端确认 → 触发一次回复（音+字都要，文字回流进气泡区）
      pendingRespond = false; clearTimeout(respondTimer);
      wsSend({ type: 'response.create', response: { modalities: ['audio', 'text'] } });
    } else if (t === 'conversation.item.input_audio_transcription.completed') {
      // v1.12.4：用户语音转文字——Vivix 默认 ASR（中文 doubao，无需建会话时额外配置）把用户
      // 说的话以服务端事件回传（payload.transcript=整段文字）。与打字同款待遇：出用户气泡 +
      // POST /dh/history 落「聊天记录」。ASR 本就是实时会话的组成部分，展示/落库不额外耗积分。
      // 只认 .completed 整段结果；.delta（部分转写）与 .failed（转写失败）忽略——失败时语音
      // 对话本身不受影响（服务端照常理解语音），只是不出文字气泡。
      const tx = String(d.transcript != null ? d.transcript : '').trim();
      if (!tx) return;
      pushLive('user', tx);
      const p = getPersona();
      if (p) {
        api.post('/dh/history', { persona_id: p.id, role: 'user', text: tx })
          .then(() => { dhState.histVer++; })
          .catch(() => { /* 落库失败不影响会话进行 */ });
      }
      // v1.13.3：**说话**里的设备指令也接管——Vivix 已经听见了（拦不住），但工作台可以
      // 真去执行，并把真实结果塞回会话让它照实念。在此之前它多半已经顺着人设编了一句
      // 「好哒哥哥我去开」——那句是它的云端模型说的，工作台拦不住，只能接着把真相补上。
      checkDeviceCommand(tx).then((r) => { if (r && r.matched) injectDeviceTurn(tx, r.message); });
    } else if (t === 'session.closed') {
      flushDelta();
      live.on = false;
      live.err = closedReason(d.reason);
      cleanupLive();
    } else if (t === 'error') {
      // 「已有回复在生成中」这类良性拒绝不弹给用户看：设备回执的补话本来就等它收口再发
      const raw = String((d.error && (d.error.message || d.error)) || '');
      if (/already|in ?progress|active response|busy|conversation_item/i.test(raw)) { live.status = '实时'; return; }
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
    clearTimeout(deviceTimer);
    responding = false; queuedDeviceTurn = false;
    live.needResume = false; live.micOn = false; live.sessionId = ''; live.vw = 0; live.vh = 0;
    closingByUser = false;
    if (r) r.exitRoom().catch(() => {}).finally(() => { try { r.destroy(); } catch { /* 已销毁 */ } });
  }

  async function sendLive() {
    const t = liveText.value.trim();
    const p = getPersona();
    if (!t || !live.on || !p) return;
    liveText.value = '';
    pushLive('user', t);
    live.status = '已发送…';
    try {
      await api.post('/dh/history', { persona_id: p.id, role: 'user', text: t });
      dhState.histVer++;
    } catch { /* 落库失败不影响会话进行 */ }
    // v1.13.3：打字这条**完全由我们做主**——是设备指令就真执行，且**原句不发给 Vivix**，
    // 只发一句带真实回执的「系统指令」让它照实念（不会出现「编一句 + 补一句」的双声）。
    live.status = '检查设备指令…';
    const cmd = await checkDeviceCommand(t);
    const text = cmd && cmd.matched ? deviceDirective(t, cmd.message) : t;
    if (cmd && cmd.matched) live.status = '设备指令已执行…';
    wsSend({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
    });
    pendingRespond = true;
    clearTimeout(respondTimer); // created 事件 2 秒没到也照常触发回复，不卡对话
    respondTimer = setTimeout(() => {
      if (pendingRespond) {
        pendingRespond = false;
        wsSend({ type: 'response.create', response: { modalities: ['audio', 'text'] } });
      }
    }, 2000);
  }

  return { live, liveItems, liveText, startLive, stopLive, sendLive, resumePlay, toggleMic, cleanupLive, pushLive };
}
