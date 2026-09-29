// 智能家居（米家）路由（v1.6.8；v1.6.29 移除摄像头直播/事件截图通道——小米云已停 HLS 出流）
// 权限：整页归 smarthome；绑定/解绑归 settings tab；设备查询/控制为页内共享（登录 + 有页权限即可）。
// /mihome/callback 为小米 OAuth 回跳地址，在 index.js EXEMPT 免登录（只认 state 会话 + 一次性 code）。
// 小米只放行 homeassistant.local:8123 回调域名 → 主流程为 /mihome/bind/manual 手动回填（见 mihomeService 注释）。
const express = require('express');
const svc = require('../services/mihomeService');
const termsData = require('../services/mihomeTermsData');

const router = express.Router();
const asyncH = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error('[mihome]', e.message);
  res.status(503).json({ error: e.message || '米家云接口调用失败' });
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

// ---------- 隧道状态码透传探针（v1.6.27 诊断：实测 cloudflare tunnel 会把源站 502 替换成自己的错误页） ----------
// 用法 /mihome/debug/tunnel?status=500 —— 原样回显该状态码，供外部验证哪些码能穿过隧道。
router.get('/mihome/debug/tunnel', (req, res) => {
  const n = Number(req.query.status);
  const code = [200, 400, 401, 403, 404, 418, 500, 502, 503, 504].includes(n) ? n : 200;
  res.status(code).json({ echo: code });
});

module.exports = router;
