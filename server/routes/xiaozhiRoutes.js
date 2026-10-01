// 智能板（小智 Korvo2V3）路由（v1.9.11）
// 权限：整组归 smarthome 页 xiaozhi tab（auth.js pageForPath + TAB_PATHS 两处已登记）。
// /xiaozhi/bridge 在 index.js EXEMPT 免登录（板端固件无登录态，key 即凭证，照 /vibe/job 模式）；
// /xiaozhi/firmware 同样 EXEMPT（v1.9.12：密钥或管理员，供无工具链环境从构建机代理取固件）；
// 配置保存/密钥轮换/构建/烧录/串口探测为管理员操作；工具与固件下载有 tab 权限即可。
const express = require('express');
const fs = require('fs');
const path = require('path');
const httpGet = require('http').get; // MJPEG 长连接代理（板子是纯 http 内网地址）
const { Readable } = require('stream');
const auth = require('../auth');
const svc = require('../services/xiaozhiService');
const paths = require('../services/xiaozhiPaths');
const builder = require('../services/xiaozhiBuilder');
const { buildZip } = require('../services/zipService');

const router = express.Router();
const asyncH = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error('[xiaozhi]', e.message);
  res.status(503).json({ error: e.message || '智能板接口调用失败' });
});
function adminOnly(req, res) {
  if (req.user.role !== 'admin') { res.status(403).json({ error: '仅管理员可操作' }); return false; }
  return true;
}

// ---------- 能力探测（登录即可；NAS/Docker 上自动降级为「文档 + 工具下载」模式） ----------
router.get('/xiaozhi/capabilities', (req, res) => {
  res.json(paths.detect(svc.getConfig()));
});

// ---------- 配置（读：有 tab 权限即可，key 只给管理员；写：管理员） ----------
router.get('/xiaozhi/config', (req, res) => {
  res.json({
    config: svc.getConfig(),
    bridge_key: req.user.role === 'admin' ? svc.ensureBridgeKey() : undefined,
  });
});
router.put('/xiaozhi/config', (req, res) => {
  if (!adminOnly(req, res)) return;
  const b = req.body || {};
  const patch = {};
  if (b.wake) {
    const pinyin = String(b.wake.pinyin || '').trim().toLowerCase();
    const display = String(b.wake.display || '').trim();
    const th = Number(b.wake.threshold);
    if (!/^[a-zü:0-9][a-zü:0-9 ]{1,30}$/.test(pinyin)) return res.status(400).json({ error: '唤醒词拼音格式不对：小写字母+空格分隔，如 xiao yang yang' });
    if (!display || display.length > 12) return res.status(400).json({ error: '唤醒词显示名需为 1-12 个字' });
    if (!Number.isInteger(th) || th < 1 || th > 99) return res.status(400).json({ error: '唤醒阈值需为 1-99 的整数（越小越灵敏，误唤醒多就调大）' });
    patch.wake = { pinyin, display, threshold: th };
  }
  if (b.channel) {
    if (!['direct', 'speaker'].includes(b.channel)) return res.status(400).json({ error: 'channel 只支持 direct（直接米家）/ speaker（智能屏转述）' });
    patch.channel = b.channel;
  }
  if (b.speaker) {
    const did = String(b.speaker.did || '').trim();
    if (!/^\d{1,20}$/.test(did)) return res.status(400).json({ error: '智能屏 did 需为纯数字' });
    const pt = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
    const sp = {
      did, siid_play: pt(b.speaker.siid_play), aiid_play: pt(b.speaker.aiid_play) || 3,
      siid_exec: pt(b.speaker.siid_exec), aiid_exec: pt(b.speaker.aiid_exec) || 4,
      piid_play: pt(b.speaker.piid_play) || 1, piid_exec: pt(b.speaker.piid_exec) || 1,
    };
    for (const [k, v] of Object.entries(sp)) {
      if (k === 'did') continue; // did 是纯数字字符串，走上面的正则；其余点位才要求整数
      if (v != null && !Number.isInteger(v)) return res.status(400).json({ error: `speaker.${k} 需为整数` });
    }
    patch.speaker = sp;
  }
  if (b.bridge) {
    const url = String(b.bridge.url || '').trim();
    if (url && !/^https?:\/\/[\w.:%-]+(:\d+)?(\/[\w./%:-]*)?$/.test(url)) return res.status(400).json({ error: '桥接地址格式不对（http(s)://…/api/xiaozhi/bridge）' });
    patch.bridge = { url };
  }
  if (b.helper) {
    const url = String(b.helper.url || '').trim();
    if (url && !/^https?:\/\/[\w.:%-]+(:\d+)?(\/[\w./%:-]*)?$/.test(url)) return res.status(400).json({ error: '构建机地址格式不对（http://局域网IP:3000）' });
    patch.helper = { url };
  }
  if (b.home_filter !== undefined) {
    const v = String(b.home_filter || '').trim();
    if (v.length > 32) return res.status(400).json({ error: '家庭名最长 32 个字' });
    patch.home_filter = v || 'all'; // 空=全部
  }
  if (b.paths) {
    const allow = ['srcDir', 'esptool', 'idfExportBat', 'idfGitDir', 'serialPort'];
    const out = {};
    for (const k of allow) {
      if (b.paths[k] === undefined) continue;
      const v = String(b.paths[k] || '').trim();
      if (v.length > 260) return res.status(400).json({ error: `paths.${k} 路径过长` });
      if (v) out[k] = v;
    }
    patch.paths = out;
  }
  res.json({ config: svc.saveConfig(patch) });
});

// ---------- 桥接密钥轮换（旧固件立即失联，需重烧——面板会提示） ----------
router.post('/xiaozhi/bridge-key/reset', (req, res) => {
  if (!adminOnly(req, res)) return;
  res.json({ bridge_key: svc.rotateBridgeKey() });
});

// ---------- 桥接统一入口（板端固件 MCP 工具调用；EXEMPT + key，恒回业务 JSON 好让 AI 直接念） ----------
router.post('/xiaozhi/bridge', (req, res) => {
  if (!svc.bridgeKeyOk(req)) return res.status(403).json({ ok: false, message: '桥接密钥不对（轮换后需重烧固件）' });
  const op = String((req.body || {}).op || '');
  if (op === 'poll') svc.noteBoardIp(req.socket.remoteAddress); // 板子 25s 一poll，顺手刷新 IP（v1.9.18 视频对话直达用）
  svc.dispatch(op, req.body)
    .then((r) => res.json(r))
    .catch((e) => res.status(503).json({ ok: false, message: '桥接处理失败：' + e.message }));
});

// ---------- 可控设备（面板预览用；走登录态不走 key；与「米家」tab 同源，fresh=1 强刷云端） ----------
router.get('/xiaozhi/devices', asyncH(async (req, res) => {
  try {
    const devices = await svc.listDevicesForBridge(req.query.fresh === '1');
    // v1.9.17：家庭清单（默认家庭下拉用）随设备一起给，保持单一数据源
    const homes = [...new Set(devices.map((d) => d.home).filter(Boolean))];
    res.json({ bound: true, devices, homes });
  } catch (e) {
    // 未绑定米家等：设备空着但别 500——面板要能区分「未绑定」和「绑了但没可控设备」
    res.json({ bound: false, devices: [], homes: [], message: e.message });
  }
}));

// ---------- 快捷开关（v1.9.17：设备一览逐台通断测试；登录+tab 即可，复用语音 control 全逻辑） ----------
router.post('/xiaozhi/device-control', asyncH(async (req, res) => {
  const did = String((req.body || {}).did || '').trim();
  const action = String((req.body || {}).action || '').trim();
  if (!/^[\w.-]{1,64}$/.test(did)) return res.status(400).json({ error: 'did 格式不对' });
  if (!['on', 'off', 'toggle'].includes(action)) return res.status(400).json({ error: 'action 只支持 on / off / toggle' });
  res.json(await svc.dispatch('control', { device: did, action })); // did 精确匹配直达（resolveDevice 首选 did 全等）
}));

// ---------- 设备别名登记（v1.9.16：did → 别名；v1.9.18 别名接管本名 + 保存校验） ----------
// 校验（v1.9.18，真实踩坑：两台本名都叫「门口台灯」，别名又登记成本名/两台同别名——照样分不开）：
// 别名=本名起不到接管作用、别名与其它设备的别名重复则两台同抢一个叫法，都在保存时拦下。
const normName = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
router.put('/xiaozhi/device-alias', asyncH(async (req, res) => {
  if (!adminOnly(req, res)) return;
  const did = String(req.body?.did || '').trim();
  const alias = String(req.body?.alias || '').trim();
  if (alias) {
    let devices = [];
    try { devices = await svc.listDevicesForBridge(); } catch { /* 未绑米家等：跳过交叉校验，仅做格式检查 */ }
    const me = devices.find((d) => String(d.did) === did);
    if (me && normName(alias) === normName(me.name)) {
      return res.status(400).json({ error: `别名「${alias}」和设备本名相同——起不到消歧作用，请换一个不同的叫法` });
    }
    const clash = devices.find((d) => String(d.did) !== did && d.alias && normName(d.alias) === normName(alias));
    if (clash) {
      return res.status(400).json({ error: `别名「${alias}」已被「${clash.room === '未分区' ? '' : clash.room + '的'}${clash.name}」占用——两台同别名还是分不开，请换个名字` });
    }
  }
  try {
    const aliases = svc.setDeviceAlias(did, alias);
    res.json({ ok: true, device_aliases: aliases });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// ---------- 摄像头照片（v1.9.17） ----------
// 上传：板子固件 POST 二进制 JPEG（index.js EXEMPT + 桥接密钥，同 bridge 的 key 即凭证模式）。
// 全局 express.json 不解析 image/jpeg，路由级 express.raw 接住 Buffer（content-type 带上 octet-stream 兜底固件侧忘设头）。
router.post('/xiaozhi/photo', express.raw({ type: ['image/jpeg', 'application/octet-stream'], limit: '5mb' }), (req, res) => {
  if (!svc.bridgeKeyOk(req)) return res.status(403).json({ ok: false, error: '桥接密钥不对' });
  try {
    const saved = svc.savePhoto(req.body);
    console.log(`[xiaozhi] 板子上传照片 ${saved.file}（${(saved.size / 1024).toFixed(0)} KB）`);
    res.json({ ok: true, file: saved.file, size: saved.size, message: '照片已存入工作台相册' });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// 列表 / 单图 / 删除：登录 + tab 即可看（家庭相册性质）；删除限管理员
router.get('/xiaozhi/photos', (req, res) => res.json({ photos: svc.listPhotos() }));
router.get('/xiaozhi/photos/:file', (req, res) => {
  try { res.sendFile(svc.photoPath(req.params.file)); } catch (e) { res.status(404).json({ error: e.message }); }
});
router.delete('/xiaozhi/photos/:file', (req, res) => {
  if (!adminOnly(req, res)) return;
  try { svc.deletePhoto(req.params.file); res.json({ ok: true }); } catch (e) { res.status(404).json({ error: e.message }); }
});

// 面板「请求板子拍一张」：置 pending，板子轮询 poll 时消费并上传（最迟一个轮询周期）
router.post('/xiaozhi/photo-request', (req, res) => {
  svc.setPhotoPending();
  res.json({ ok: true, message: '已请求拍照——板子最迟约 30 秒内上传（须已烧录 v1.9.17 固件并连着网）' });
});

// ---------- 视频对话（v1.9.18）：工作台代理板子 81 端口的 MJPEG 流与对话指令 ----------
// 代理的必要性：生产页是 https，直连板子 http://IP:81 会被浏览器当混合内容拦掉；板端校验桥接密钥，
// 由服务端注入 key——密钥不出网到浏览器。板子 IP 来自 poll 时记录的 remoteAddress。
// GET /xiaozhi/video：MJPEG 流（<img> 走 ?token= 查询参数，同家庭图床/照片先例）
router.get('/xiaozhi/video', (req, res) => {
  const b = svc.getBoardInfo();
  if (!b.ip) return res.status(503).json({ error: '还不知道板子的 IP——板子连着网并已烧录 v1.9.18 固件后会自动登记（最多等 1 分钟）' });
  const url = `http://${b.ip}:81/video?k=${encodeURIComponent(svc.ensureBridgeKey())}`;
  const upstream = httpGet(url, (r) => {
    if (r.statusCode !== 200) {
      res.status(502).json({ error: `板子视频服务无响应（HTTP ${r.statusCode}）——需已烧录 v1.9.18 固件` });
      r.resume(); // 丢弃余下数据
      return;
    }
    res.writeHead(200, {
      'Content-Type': r.headers['content-type'] || 'multipart/x-mixed-replace;boundary=frame',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no', // 过反代/网关时禁缓冲，流式推帧
    });
    r.pipe(res);
  });
  upstream.on('error', (e) => {
    if (res.headersSent) return res.end();
    res.status(502).json({ error: `连不上板子视频服务（${b.ip}:81）：${e.message}——板子离线或固件未升级` });
  });
  req.on('close', () => upstream.destroy()); // 网页关掉 <img>（断流）即拆上游连接，板子停止推帧省 CPU
});

// POST /xiaozhi/chat {on:1|0}：转发到板子 /chat（触发 StartListening/StopListening，毫秒级——比 poll 快得多）
router.post('/xiaozhi/chat', asyncH(async (req, res) => {
  const b = svc.getBoardInfo();
  if (!b.ip) return res.status(503).json({ error: '还不知道板子的 IP——板子连着网并已烧录 v1.9.18 固件后会自动登记（最多等 1 分钟）' });
  const on = (req.body || {}).on ? 1 : 0;
  try {
    const r = await fetch(`http://${b.ip}:81/chat?k=${encodeURIComponent(svc.ensureBridgeKey())}&on=${on}`, {
      signal: AbortSignal.timeout(4000),
    });
    const t = await r.text();
    res.status(r.statusCode).type('json').send(t); // 板端 {ok,message} 原样透传
  } catch (e) {
    res.status(502).json({ ok: false, error: `连不上板子（${b.ip}:81）：${e.message}——板子离线或固件未升级` });
  }
}));

// GET /xiaozhi/board：板子 IP / 在线状态（面板显示与排障）
router.get('/xiaozhi/board', (req, res) => res.json(svc.getBoardInfo()));

// ---------- 智能屏动作点位自动探测 + 试播/转述测试（登录 + tab 即可） ----------
router.post('/xiaozhi/speaker-probe', asyncH(async (req, res) => {
  const sp = await svc.ensureSpeakerPoints(true);
  res.json({ ok: !!(sp.siid_play || sp.siid_exec), speaker: sp, message: sp.siid_play && sp.siid_exec ? `已定位：播放文本 siid${sp.siid_play}/aiid${sp.aiid_play}，执行指令 siid${sp.siid_exec}/aiid${sp.aiid_exec}` : 'spec 里没找到 play-text / execute-text-directive 动作，请手动填 siid' });
}));
router.post('/xiaozhi/speaker-test', asyncH(async (req, res) => {
  const b = req.body || {};
  const text = String(b.text || '').trim().slice(0, 200);
  if (!text) return res.status(400).json({ error: 'text 不能为空' });
  res.json(await svc.speakerAction(b.kind === 'exec' ? 'exec' : 'play', text));
}));

// ---------- 工具下载（CH343 驱动整包 zip + 串口脚本单文件；zipService 已处理 UTF-8 文件名） ----------
const TOOLS_DIR = path.join(__dirname, '..', 'xiaozhi', 'tools');
const DRIVER_NOTE = [
  'CH343 USB 串口驱动（Korvo2V3 开发板配套）安装说明',
  '=====================================================',
  '',
  '1. Windows 10/11 大多免驱：插上板子出现「USB-Enhanced-SERIAL CH343 (COMx)」即无需安装。',
  '2. 识别不到串口时：进入 CH341SER 文件夹，右键「以管理员身份运行」SETUP.EXE → INSTALL。',
  '3. 装完拔插一次 USB，设备管理器「端口(COM 和 LPT)」出现 CH343 即成功。',
  '4. serial_read.py：查看板子运行日志（需已装 Python + pyserial）：',
  '   python serial_read.py COM4 30   （读 COM4 共 30 秒，波特率默认 115200）',
].join('\r\n');

function walkDir(dir, prefix, out) {
  for (const name of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walkDir(p, `${prefix}${name}/`, out);
    else out.push({ name: prefix + name, data: fs.readFileSync(p) });
  }
  return out;
}
function dirSize(dir) {
  let n = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    n += st.isDirectory() ? dirSize(p) : st.size;
  }
  return n;
}
const TOOLS = [
  { name: 'ch343-driver', desc: 'CH343 USB 串口驱动（Korvo2V3 配套，含 32/64 位安装包 + 安装说明）', dir: 'ch343-driver' },
  { name: 'serial_read.py', desc: '串口日志脚本（pyserial 直读，UTF-8 不乱码；配网/烧录后排障用）' },
];
router.get('/xiaozhi/tools', (req, res) => {
  res.json({
    tools: TOOLS.map((t) => {
      try {
        const p = path.join(TOOLS_DIR, t.dir || t.name);
        return { ...t, size: t.dir ? dirSize(p) : fs.statSync(p).size };
      } catch {
        return { ...t, size: 0, missing: true };
      }
    }),
  });
});
router.get('/xiaozhi/tools/:name', (req, res) => {
  const t = TOOLS.find((x) => x.name === req.params.name); // 白名单，杜绝路径穿越
  if (!t) return res.status(404).json({ error: '没有这个工具' });
  const src = path.join(TOOLS_DIR, t.dir || t.name);
  try {
    if (t.dir) {
      const entries = walkDir(src, `${t.name}/`, []);
      entries.push({ name: `${t.name}/安装说明.txt`, data: Buffer.from(DRIVER_NOTE, 'utf8') });
      res.set('Content-Type', 'application/zip');
      res.set('Content-Disposition', 'attachment; filename="ch343-driver.zip"');
      return res.send(buildZip(entries));
    }
    res.download(src, t.name);
  } catch (e) {
    res.status(404).json({ error: '工具文件缺失：' + e.message });
  }
});

// ---------- 固件下载（data 缓存优先，其次源码 build 目录；固件不入 git/升级包） ----------
// EXEMPT（index.js）后全局中间件不再解析登录态，这里自带双通道凭证：
// 桥接密钥（x-wb-key 头 / ?k=，供无工具链环境从构建机互取固件，两台机器密钥一致）或管理员令牌。
// 本机无产物且配了 helper.url（构建机）时代理拉取并透传流。
router.get('/xiaozhi/firmware', asyncH(async (req, res) => {
  const k = req.get('x-wb-key') || req.query.k;
  const user = auth.resolveUser(req);
  const keyOk = !!(k && svc.bridgeKeyOk(req));
  if (!keyOk && !(user && user.role === 'admin')) {
    return res.status(403).json({ error: '固件下载需管理员登录或桥接密钥' });
  }
  const cfg = svc.getConfig();
  const d = paths.detect(cfg);
  if (d.firmware.available) return res.download(d.firmware.path, 'xiaozhi-korvo2v3-merged.bin');
  const helper = String((cfg.helper && cfg.helper.url) || '').trim().replace(/\/+$/, '');
  if (!helper) return res.status(404).json({ error: '本机没有固件产物（无工具链环境），也没配置构建机地址——管理员在「构建机地址」里填装了 ESP-IDF 的工作台地址' });
  let r;
  try {
    r = await fetch(helper + '/api/xiaozhi/firmware?k=' + encodeURIComponent(svc.ensureBridgeKey()), {
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    return res.status(502).json({ error: `连不上构建机（${helper}）：${e.cause && e.cause.code ? e.cause.code : e.message}——确认那台电脑的工作台开着、地址没填错` });
  }
  if (!r.ok) {
    let msg = 'HTTP ' + r.status;
    try { msg = ((await r.text()) || '').slice(0, 200) || msg; } catch { /* 保底用状态码 */ }
    return res.status(502).json({ error: `从构建机（${helper}）取固件失败：${msg}` });
  }
  res.setHeader('Content-Disposition', 'attachment; filename="xiaozhi-korvo2v3-merged.bin"');
  const len = r.headers.get('content-length');
  if (len) res.setHeader('Content-Length', len);
  Readable.fromWeb(r.body).pipe(res);
}));

// ---------- 串口枚举 / 芯片探测 / 构建烧录（管理员） ----------
router.get('/xiaozhi/ports', asyncH(async (req, res) => {
  if (!adminOnly(req, res)) return;
  res.json(await builder.listPorts());
}));
router.post('/xiaozhi/probe', asyncH(async (req, res) => {
  if (!adminOnly(req, res)) return;
  const port = String((req.body || {}).port || '').trim();
  if (!/^(COM\d+|\/dev\/.+)$/.test(port)) return res.status(400).json({ error: '串口名格式不对（如 COM4）' });
  res.json(await builder.probeChip(port));
}));
router.post('/xiaozhi/build', (req, res) => {
  if (!adminOnly(req, res)) return;
  try {
    res.json(builder.start(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});
router.get('/xiaozhi/build/status', (req, res) => res.json(builder.status()));
router.post('/xiaozhi/build/reset', (req, res) => {
  try { builder.reset(); res.json({ ok: true }); } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
