// 智能家居（米家）路由（v1.6.8；v1.6.9 适配小米回调白名单）
// 权限：整页归 smarthome；绑定/解绑归 settings tab；设备查询/控制为页内共享（登录 + 有页权限即可）。
// /mihome/callback 为小米 OAuth 回跳地址，在 index.js EXEMPT 免登录（只认 state 会话 + 一次性 code）。
// 小米只放行 homeassistant.local:8123 回调域名 → 主流程为 /mihome/bind/manual 手动回填（见 mihomeService 注释）。
const express = require('express');
const svc = require('../services/mihomeService');
const termsData = require('../services/mihomeTermsData');

const router = express.Router();
const asyncH = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error('[mihome]', e.message);
  res.status(502).json({ error: e.message || '米家云接口调用失败' });
});

function htmlPage(res, ok, title, detail) {
  res.status(ok ? 200 : 400).type('html').send(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">${ok ? '<meta http-equiv="refresh" content="2;url=/#/smart-home?tab=settings&bind=ok">' : ''}
<title>${title}</title><style>body{font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f4f6f9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#fff;border-radius:14px;padding:36px 44px;box-shadow:0 4px 24px rgba(0,0,0,.08);text-align:center;max-width:420px}
h2{margin:0 0 10px;font-size:20px;color:${ok ? '#16a34a' : '#dc2626'}}p{color:#555;font-size:14px;line-height:1.7;margin:0}</style></head>
<body><div class="card"><h2>${ok ? '✅ ' : '❌ '}${title}</h2><p>${detail}</p></div></body></html>`);
}

// ---------- 绑定状态 ----------
router.get('/mihome/status', (req, res) => {
  res.json(svc.status());
});

// ---------- 偏好（默认家庭 / 缓存刷新间隔等） ----------
router.get('/mihome/prefs', (req, res) => {
  res.json(svc.getPrefs());
});
router.put('/mihome/prefs', (req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.default_home != null) {
    if (typeof b.default_home !== 'string' || b.default_home.length > 64) {
      return res.status(400).json({ error: 'default_home 需为不超过 64 字的字符串' });
    }
    patch.default_home = b.default_home;
  }
  if (b.cache_ttl_min != null) { // v1.6.16：列表缓存后台静默更新间隔（分钟）
    const n = Number(b.cache_ttl_min);
    if (!Number.isInteger(n) || n < 1 || n > 1440) {
      return res.status(400).json({ error: 'cache_ttl_min 需为 1-1440 的整数（分钟）' });
    }
    patch.cache_ttl_min = n;
  }
  res.json(svc.setPrefs(patch));
});

// ---------- 设备实测词条词典（v1.6.16：详情页翻译回退 + 「参数翻译」tab 设备组） ----------
router.get('/mihome/terms', (req, res) => {
  res.json(termsData.getTerms());
});

// ---------- 生成扫码绑定二维码内容（授权页地址；回调固定用小米白名单域名） ----------
router.post('/mihome/bind/start', asyncH(async (req, res) => {
  const region = svc.REGIONS[req.body.region] ? req.body.region : 'cn';
  const cfg = svc.ensureDeviceKey();
  const state = svc.newBindSession(region, svc.OAUTH2_REDIRECT_URI);
  res.json({
    auth_url: svc.buildAuthUrl(cfg, svc.OAUTH2_REDIRECT_URI, state),
    state, region, expires_in: 600,
  });
}));

// ---------- 手动回填完成绑定：粘贴授权后浏览器地址栏网址（homeassistant.local 打不开，code 在地址里） ----------
router.post('/mihome/bind/manual', asyncH(async (req, res) => {
  const url = typeof req.body.url === 'string' ? req.body.url.trim() : '';
  let parsed;
  try { parsed = svc.parseCallbackUrl(url); } catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    await svc.completeBind(parsed.code, parsed.state);
    const s = svc.status();
    res.json({ ok: true, nickname: s.nickname, uid: s.uid });
  } catch (e) {
    res.status(400).json({ error: e.message }); // 会话过期/授权码无效 → 用户可读的中文提示
  }
}));

// ---------- 令牌注入（例外通道）：服务器出口 IP 被小米风控时，用户侧换取的令牌由此写入 ----------
// 请求体 {access_token, refresh_token, expires_in?, region?}；令牌 AES-GCM 加密落库，接口不回显。
router.post('/mihome/bind/token', asyncH(async (req, res) => {
  const b = req.body || {};
  if (!b.access_token || typeof b.access_token !== 'string') return res.status(400).json({ error: '缺少 access_token' });
  try {
    const s = await svc.completeBindTokens(b);
    res.json({ ok: true, bound: s.bound, nickname: s.nickname, expires_at: s.expires_at });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// ---------- 轮询绑定结果（设置页展示二维码期间每 3 秒查询） ----------
router.get('/mihome/bind/poll', (req, res) => {
  const s = svc.status();
  res.json({ bound: s.bound, nickname: s.nickname, uid: s.uid });
});

// ---------- 解绑 ----------
router.post('/mihome/unbind', asyncH(async (req, res) => {
  svc.unbind();
  res.json({ ok: true });
}));

// ---------- 网络诊断：服务器视角检查小米云链路（系统解析 vs DoH 钉定直连 + 假码探测） ----------
router.get('/mihome/diag', asyncH(async (req, res) => {
  res.json(await svc.diagnoseNetwork());
}));

// ---------- 立即续期（admin）：用 refresh_token 预先续期，验证续期链路是否可用 ----------
router.post('/mihome/refresh', asyncH(async (req, res) => {
  try {
    await svc.forceRefresh();
    const s = svc.status();
    res.json({ ok: true, expires_at: s.expires_at });
  } catch (e) {
    res.status(400).json({ error: e.message }); // 不清令牌，仅报告失败原因
  }
}));

// ---------- OAuth 回调（免登录）：换令牌落库 ----------
router.get('/mihome/callback', asyncH(async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return htmlPage(res, false, '授权被拒绝', `小米账号授权返回错误：${error}。可回到工作台重新生成二维码再试。`);
  if (!code) return htmlPage(res, false, '回调参数缺失', '未收到授权码（code），请回到工作台重新发起扫码绑定。');
  try {
    await svc.completeBind(String(code), String(state || ''));
    htmlPage(res, true, '米家账号绑定成功', '正在返回工作台「智能家居 → 设置」…如未自动跳转，可手动关闭本页。');
  } catch (e) {
    htmlPage(res, false, '绑定失败', `${e.message}。请回到工作台重新生成二维码再试。`);
  }
}));

// ---------- 家庭/房间/设备总览（含开关能力与当前值） ----------
router.get('/mihome/homes', asyncH(async (req, res) => {
  res.json(await svc.getHomeView(req.query.fresh === '1'));
}));

// ---------- 单设备能力描述（服务/属性/事件/动作全量） ----------
router.get('/mihome/device/spec', asyncH(async (req, res) => {
  const did = String(req.query.did || '');
  if (!did || did.length > 64) return res.status(400).json({ error: '缺少 did 参数' });
  res.json(await svc.getSpecByDid(did));
}));

// ---------- 属性读（详情页打开时批量拉当前值） ----------
router.post('/mihome/prop/get', asyncH(async (req, res) => {
  const params = Array.isArray(req.body.params) ? req.body.params : [];
  if (!params.length || params.length > 60) return res.status(400).json({ error: 'params 需为 1-60 个 {did,siid,piid}' });
  for (const p of params) {
    if (!p || typeof p.did !== 'string' || p.did.length > 64
      || !Number.isInteger(p.siid) || p.siid < 1 || p.siid > 99
      || !Number.isInteger(p.piid) || p.piid < 1 || p.piid > 99) {
      return res.status(400).json({ error: '存在非法的 did/siid/piid' });
    }
  }
  const result = await svc.getProps(params);
  res.json({ result });
}));

// ---------- 属性写（开关/亮度/模式等，单点写入） ----------
// 注意：该通道 prop/set 响应的项级 code 不可靠——2026-09-29 实测两台不同设备，命令均实际执行
// （回读值已变），项级却一律返回 code 1；官方 ha_xiaomi_home 同端点同样不检查项级 code。
// 因此判定以信封为准（非 0 会在服务层抛错），下发后回读校验兜底。
router.post('/mihome/prop/set', asyncH(async (req, res) => {
  const { did, siid, piid } = req.body || {};
  const value = req.body ? req.body.value : undefined;
  if (typeof did !== 'string' || !did || did.length > 64
    || !Number.isInteger(siid) || siid < 1 || siid > 99
    || !Number.isInteger(piid) || piid < 1 || piid > 99) {
    return res.status(400).json({ error: '参数需为 {did, siid, piid, value}' });
  }
  if (typeof value === 'string' && value.length > 200) return res.status(400).json({ error: 'value 字符串过长' });
  if (!['boolean', 'number', 'string'].includes(typeof value)) return res.status(400).json({ error: 'value 需为布尔/数值/字符串' });
  await svc.setProp(did, siid, piid, value); // 信封非 0 → 抛错走 asyncH
  let readBack;
  for (const delay of [700, 1800]) { // 回读两次兜底（设备/云端缓存可能延迟生效）
    await new Promise((ok) => setTimeout(ok, delay));
    try {
      const rs = await svc.getProps([{ did, siid, piid }]);
      const it = (rs || []).find((x) => x.siid === siid && x.piid === piid);
      if (it && it.code === 0 && it.value !== undefined) { readBack = it.value; break; }
    } catch { /* 回读失败重试一次 */ }
  }
  const ok = readBack === undefined || String(readBack) === String(value);
  if (ok) svc.updateCachedSwitchValue(did, siid, piid, readBack !== undefined ? readBack : value); // 同步缓存
  res.json({
    ok,
    message: ok ? (readBack !== undefined ? '已下发并确认' : '已下发') : `设备未生效（当前值 ${readBack}），请重试`,
    value: readBack,
  });
}));

// ---------- 动作调用（如播放铃声/查找设备） ----------
router.post('/mihome/action', asyncH(async (req, res) => {
  const { did, siid, aiid } = req.body || {};
  const inList = Array.isArray(req.body.in) ? req.body.in.slice(0, 20) : [];
  if (typeof did !== 'string' || !did || did.length > 64
    || !Number.isInteger(siid) || siid < 1 || siid > 99
    || !Number.isInteger(aiid) || aiid < 1 || aiid > 99) {
    return res.status(400).json({ error: '参数需为 {did, siid, aiid, in:[]}' });
  }
  for (const v of inList) {
    if (typeof v === 'string' && v.length > 200) return res.status(400).json({ error: 'in 参数字符串过长' });
    if (!['boolean', 'number', 'string'].includes(typeof v)) return res.status(400).json({ error: 'in 数组元素需为标量' });
  }
  try {
    const result = await svc.callAction(did, siid, aiid, inList);
    res.json({ ok: true, result });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
}));

// ---------- 摄像头直播（v1.6.16） ----------
// 取流状态：前端「监控」tab 进页面逐台调用；fresh=1 跳过服务端会话缓存强制重开。
// 返回的 playlist 指向下方代理（带 12 小时 HMAC 签名），hls.js 直接播。
router.get('/mihome/camera/live', asyncH(async (req, res) => {
  const did = String(req.query.did || '');
  if (!did || did.length > 64) return res.status(400).json({ error: '缺少 did 参数' });
  const s = await svc.startCameraLive(did, req.query.fresh === '1');
  const sign = svc.camSign(did, 12);
  res.json({
    did,
    live: !!s.hlsUrl,
    server_ok: s.ok, // 服务器侧已确认转码器就绪（false 时代理可能仍需几秒）
    err: s.err || '',
    at: s.at,
    playlist: s.hlsUrl ? `/api/mihome/cam/hls/${encodeURIComponent(did)}/playlist.m3u8?e=${sign.exp}&s=${sign.sig}` : '',
    rtsp: s.rtspUrl || '', // VLC 等播放器备用
  });
}));

// ---------- HLS 代理（免登录：e/s 限时签名即凭证；上游 m3u8 绑定创建会话的出口 IP，必须服务端代拉） ----------
// 播放列表：拉云端 m3u8，把分片行改写为本代理地址（签名随行透传），hls.js 全程只访问本站。
router.get('/mihome/cam/hls/:did/playlist.m3u8', asyncH(async (req, res) => {
  const { did } = req.params;
  if (!svc.camVerify(did, req.query.e, req.query.s)) {
    return res.status(403).type('text').send('链接已过期，请刷新监控页面重试');
  }
  try {
    const { sess, body } = await svc.fetchCamPlaylist(did);
    const e = req.query.e, s = req.query.s;
    const out = body.split('\n').map((line) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      const abs = new URL(t, sess.hlsUrl).href;
      return `/api/mihome/cam/hls/${encodeURIComponent(did)}/seg?u=${encodeURIComponent(abs)}&e=${e}&s=${s}`;
    }).join('\n');
    res.set('Content-Type', 'application/vnd.apple.mpegurl').set('Cache-Control', 'no-store').send(out);
  } catch (e) {
    res.status(502).type('text').send(e.message || '拉流失败');
  }
}));

// 视频分片：仅放行小米流媒体域名（服务内再校验一道），原样转发
router.get('/mihome/cam/hls/:did/seg', asyncH(async (req, res) => {
  const { did } = req.params;
  const u = String(req.query.u || '');
  if (!svc.camVerify(did, req.query.e, req.query.s)) {
    return res.status(403).type('text').send('链接已过期');
  }
  if (!/^https:\/\/[a-z0-9.-]+\.io\.mi\.com\//.test(u)) {
    return res.status(400).type('text').send('上游地址非法');
  }
  try {
    const buf = await svc.fetchCamSegment(u);
    res.set('Content-Type', 'video/mp2t').set('Cache-Control', 'no-store').send(buf);
  } catch (e) {
    res.status(502).type('text').send(e.message || '分片拉取失败');
  }
}));

// ---------- 摄像头条目原始字段探测（诊断：device_list_page 原始返回里找云端截图字段；输出脱敏） ----------
router.get('/mihome/debug/camraw', asyncH(async (req, res) => {
  res.json(await svc.debugCameraRaw());
}));

// ==================== 摄像头「看家事件」截图/录像（v1.6.19，micam：密码换 serviceToken 通道） ====================
// 凭证由本地登录工具注入（密码不落生产）；图片/录像经本站限时 HMAC 签名代理（<img>/hls.js 带不了登录头）。
const micam = require('../services/micamService');

router.get('/micam/status', (req, res) => {
  res.json(micam.status());
});

// 令牌注入（本地登录工具调用；归 settings tab 权限）：只收 {user_id, service_token, ssecurity}，不收密码
router.post('/micam/inject', asyncH(async (req, res) => {
  try {
    const s = micam.injectCreds(req.body || {});
    res.json({ ok: true, bound: s.bound, user_id: s.user_id, injected_at: s.injected_at });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));
router.post('/micam/unbind', (req, res) => {
  micam.clearCreds();
  res.json({ ok: true });
});

// 全部摄像头最近事件（监控 tab 卡片数据）：live 流仍走 /mihome/camera/live，这里补截图/录像
router.get('/micam/events', asyncH(async (req, res) => {
  const st = micam.status();
  const view = await svc.getHomeView(false);
  const out = [];
  for (const h of view.homes) for (const r of h.rooms) for (const d of r.devices) {
    if (!/^urn:miot-spec-v2:device:camera:/.test(d.urn || '')) continue;
    const item = { did: d.did, name: d.name, model: d.model, online: d.online, events: [], err: '' };
    if (st.bound) {
      try {
        const evs = await micam.getLatestEvents(d.did, 2);
        const sign = svc.camSign(d.did, 12);
        item.events = evs.map((e) => ({
          fileId: e.fileId,
          time: e.time,
          iso: e.time ? new Date(Number(e.time)).toISOString() : '',
          isAlarm: e.isAlarm,
          tags: e.tags,
          img: `/api/micam/img/${encodeURIComponent(d.did)}?fid=${encodeURIComponent(e.fileId)}&sto=${encodeURIComponent(e.stoId)}&e=${sign.exp}&s=${sign.sig}`,
          clip: `/api/micam/clip/${encodeURIComponent(d.did)}/playlist.m3u8?fid=${encodeURIComponent(e.fileId)}&alarm=${e.isAlarm ? 1 : 0}&m=${encodeURIComponent(d.model || '')}&e=${sign.exp}&s=${sign.sig}`,
        }));
      } catch (e) { item.err = e.message; }
    }
    out.push(item);
  }
  res.json({ bound: st.bound, user_id: st.user_id, injected_at: st.injected_at, cams: out });
}));

// 事件截图（免登录：限时 HMAC 签名即凭证；服务端拉密文图 + AES-256-CBC 解密出图）
router.get('/micam/img/:did', asyncH(async (req, res) => {
  const { did } = req.params;
  const fid = String(req.query.fid || '');
  const sto = String(req.query.sto || '');
  if (!svc.camVerify(did, req.query.e, req.query.s)) return res.status(403).type('text').send('链接已过期，请刷新监控页面');
  if (!/^[\w.-]{1,64}$/.test(fid) || !/^[\w.-]{1,64}$/.test(sto)) return res.status(400).type('text').send('参数非法');
  try {
    const buf = await micam.fetchEventImage(did, fid, sto);
    res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'private, max-age=300').send(buf);
  } catch (e) {
    res.status(502).type('text').send(e.message || '截图获取失败');
  }
}));

// 事件录像 m3u8 代理：拉签名播放列表 → 分片行改写为本站代理（签名随行透传），hls.js 全程只访问本站
router.get('/micam/clip/:did/playlist.m3u8', asyncH(async (req, res) => {
  const { did } = req.params;
  const fid = String(req.query.fid || '');
  const model = String(req.query.m || '');
  const isAlarm = req.query.alarm === '1';
  if (!svc.camVerify(did, req.query.e, req.query.s)) return res.status(403).type('text').send('链接已过期，请刷新监控页面');
  if (!/^[\w.-]{1,64}$/.test(fid) || !model || model.length > 64) return res.status(400).type('text').send('参数非法');
  try {
    const { url, body } = await micam.clipPlaylist(did, model, fid, isAlarm);
    const e = req.query.e, s = req.query.s;
    const out = body.split('\n').map((line) => {
      const t = line.trim();
      if (!t || t.startsWith('#')) return line;
      const abs = new URL(t, url).href;
      return `/api/micam/clip/${encodeURIComponent(did)}/seg?u=${encodeURIComponent(abs)}&e=${e}&s=${s}`;
    }).join('\n');
    res.set('Content-Type', 'application/vnd.apple.mpegurl').set('Cache-Control', 'no-store').send(out);
  } catch (e) {
    res.status(502).type('text').send(e.message || '录像片段获取失败');
  }
}));

// 事件录像分片：仅放行小米流媒体/图片 CDN 域名，原样转发
router.get('/micam/clip/:did/seg', asyncH(async (req, res) => {
  const { did } = req.params;
  const u = String(req.query.u || '');
  if (!svc.camVerify(did, req.query.e, req.query.s)) return res.status(403).type('text').send('链接已过期');
  if (!/^https:\/\/[a-z0-9.-]+\.(io\.mi\.com|mi-img\.com)\//.test(u)) {
    return res.status(400).type('text').send('上游地址非法');
  }
  try {
    const buf = await micam.fetchUpstreamBuf(u);
    res.set('Content-Type', 'video/mp2t').set('Cache-Control', 'no-store').send(buf);
  } catch (e) {
    res.status(502).type('text').send(e.message || '分片拉取失败');
  }
}));

// 诊断：device_list_page 原始条目（v1.6.23 临时，分路设备调查已收口 → v1.6.24 移除）

// ==================== 摄像头二次验证（v1.6.20：小米账号密码登录换凭证 + 注入目标） ====================
// 密码仅单次请求内存（micamLogin 模块内换凭证后即弃），不落盘不入日志；凭证存内存会话 30 分钟。
// v1.6.24：登录表单移入「设置」tab 并全站可用（外网/内网同样操作）；注入目标默认当前站点，
// 目标即本站时直接写库（无需再填本站账号密码）。
const micamLogin = require('../services/micamLogin');

// 登录（或带图片验证码重试）。已有 30 分钟内有效会话时免密续用（如仅补注入信息后重点按钮）。
router.post('/micam/login', asyncH(async (req, res) => {
  const b = req.body || {};
  const user = String(b.user || '').trim();
  const pass = String(b.pass || '');
  if (!user || !pass) {
    const c = micamLogin.takeCreds();
    if (c) return res.json({ ok: true, user_id: c.userId, reused: true });
    return res.status(400).json({ error: '请填小米账号和密码' });
  }
  if (user.length > 100 || pass.length > 128) return res.status(400).json({ error: '参数过长' });
  const r = await micamLogin.passportLogin(user, pass, String(b.captcha || '').trim());
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(r.ok ? { ok: true, user_id: micamLogin.takeCreds()?.userId || '' } : r);
}));

// 提交短信/邮件安全验证码（登录触发 need_verify 后）
router.post('/micam/verify', asyncH(async (req, res) => {
  const code = String((req.body || {}).code || '').trim();
  if (!/^\d{4,8}$/.test(code)) return res.status(400).json({ error: '请输入收到的 4-8 位数字验证码' });
  try {
    const c = await micamLogin.verifyCode(code);
    res.json({ ok: true, user_id: c.userId });
  } catch (e) {
    res.status(400).json({ error: e.message || '验证失败，请重试' });
  }
}));

// 把当前登录会话的凭证注入目标工作台；目标为本站（同源）或本机实例则直接写入本库（无需账号密码）
router.post('/micam/inject-target', asyncH(async (req, res) => {
  const b = req.body || {};
  const creds = micamLogin.takeCreds();
  if (!creds) return res.status(400).json({ error: '登录会话已过期（30 分钟），请重新登录' });
  let base = String(b.base || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base)) base = 'https://' + base;
  let u;
  try { u = new URL(base); } catch { return res.status(400).json({ error: '目标地址格式不正确' }); }
  if (!/^https?:$/.test(u.protocol) || !/^[a-z0-9.-]+(:\d+)?$/i.test(u.host)) {
    return res.status(400).json({ error: '目标地址格式不正确' });
  }
  try {
    const selfHost = String(req.headers.host || '').toLowerCase(); // 目标即本站（外网域名/内网 IP 都算）
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || (selfHost && u.host.toLowerCase() === selfHost)) {
      const s = micam.injectCreds({ user_id: creds.userId, service_token: creds.serviceToken, ssecurity: creds.ssecurity, region: 'cn' });
      return res.json({ ok: true, user_id: s.user_id, base: u.origin });
    }
    // 远程实例：用表单里的目标账号密码登录后注入（凭证只发往用户自己指定的工作台）
    const lr = await fetch(u.origin + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ username: String(b.user || ''), password: String(b.pass || '') }),
    });
    const lj = await lr.json().catch(() => ({}));
    if (!lj.token) return res.status(400).json({ error: '目标工作台账号或密码错误' });
    const ir = await fetch(u.origin + '/api/micam/inject', {
      method: 'POST', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + lj.token },
      body: JSON.stringify({ user_id: creds.userId, service_token: creds.serviceToken, ssecurity: creds.ssecurity, region: 'cn' }),
    });
    const ij = await ir.json().catch(() => ({}));
    if (!ir.ok || !ij.ok) return res.status(400).json({ error: ij.error || '注入失败（HTTP ' + ir.status + '）' });
    res.json({ ok: true, user_id: ij.user_id || creds.userId, base: u.origin });
  } catch (e) {
    res.status(502).json({ error: '目标工作台连接失败：' + (e.message || '网络错误') });
  }
}));

module.exports = router;
