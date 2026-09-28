// v1.6.19 升级包：摄像头「看家事件」截图/录像（密码换 serviceToken 通道，注入式：密码不存生产）
//   背景：OAuth 通道拿不到摄像头画面（HLS 转码 404 / 快照占位图 / 设备列表无缩略图，v1.6.18 收口）。
//   用户拍板方案 B-无密码驻留：本地登录工具（scripts/micloud-login-tool.cjs，浏览器 127.0.0.1:9607）
//   用小米账号密码换 {userId, serviceToken, ssecurity}（micloud/hass-xiaomi-miot 同协议：serviceLogin
//   三步 + RC4-drop1024 签名 + sha1 签名），注入生产；密码只在本地内存，不落盘不上传。
//   server：micamService.js（新增：凭证 AES-GCM 存储、事件接口、图片 AES-256-CBC 解密、m3u8/分片代理）
//           mihomeRoutes.js（/micam/status|inject|unbind|events|img|clip 代理，复用 camhls HMAC 签名）
//           index.js（EXEMPT /micam/img /micam/clip：<img>/hls.js 带不了登录头）
//           auth.js（/micam 归 smarthome 页；inject/unbind 归设置 tab）
//   web：SmartHome.vue（监控卡片：直播→事件截图回落+时间角标；弹窗三模式 live/clip/image；
//         设置 tab 凭证卡片：状态/清空/本地工具注入指引）
//   dist 差分：新构建 202609281602 对比基线 202609281327（=生产现状 v1.6.18 无前端变更），写入 202609220406。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(dataDir, 'upgrades');
const LIVE_DIST = '202609220406';
const BASE_DIST = '202609281327';
const NEW_DIST = '202609281602';

const FILES = [
  'server/services/micamService.js',    // 新增：米云智能摄像头协议 + 凭证存储 + 图片解密
  'server/services/mihomeService.js',   // v1.6.18 诊断接口（本次未变，留档）
  'server/routes/mihomeRoutes.js',      // /micam/* 路由
  'server/index.js',                    // EXEMPT 增 /micam/img /micam/clip
  'server/auth.js',                     // /micam 页归属与 tab 权限
  'web/src/views/SmartHome.vue',        // 监控截图卡片 + 弹窗三模式 + 设置凭证卡片
  'scripts/micloud-login-tool.cjs',     // 新增：本地登录注入工具（密码不落盘）
  'scripts/micloud登录.bat',             // 新增：Windows 双击入口
  'data/test-mihome-api.js',            // 测试（+10 项 micam，共 36）
  'data/test-mihome-ui.js',             // 测试（+1 项凭证卡片，共 15）
];

const hashBuf = (b) => crypto.createHash('sha256').update(b).digest('hex');
function localTs() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const distRoot = path.join(ROOT, 'web', 'dist');
if (!fs.existsSync(path.join(distRoot, NEW_DIST, 'index.html'))) throw new Error('新 dist 目录不存在：' + NEW_DIST);
if (!fs.existsSync(path.join(distRoot, BASE_DIST, 'index.html'))) throw new Error('基线 dist 目录不存在：' + BASE_DIST);

const baseline = getSetting(db, 'upgrade_baseline', { files: {}, updated_at: null });
const statusText = { new: '新增', changed: '修改', unchanged: '未变更' };
const manifest = FILES.map((rel) => {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) throw new Error(`文件不存在：${rel}`);
  const data = fs.readFileSync(abs);
  const hash = hashBuf(data);
  const old = (baseline.files || {})[rel];
  return { path: rel, size: data.length, hash, status: !old ? 'new' : old === hash ? 'unchanged' : 'changed' };
});
const entries = manifest.map((m) => ({ name: m.path, data: fs.readFileSync(path.join(ROOT, m.path)) }));

function listFiles(dir, rel, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) listFiles(path.join(dir, ent.name), r, out);
    else out.push(r);
  }
}
const newFiles = [];
listFiles(path.join(distRoot, NEW_DIST), '', newFiles);
let distDiff = 0;
for (const rel of newFiles) {
  const nb = fs.readFileSync(path.join(distRoot, NEW_DIST, rel));
  const basePath = path.join(distRoot, BASE_DIST, rel);
  let same = false;
  try { same = fs.existsSync(basePath) && hashBuf(fs.readFileSync(basePath)) === hashBuf(nb); } catch { same = false; }
  if (!same) { entries.push({ name: `web/dist/${LIVE_DIST}/${rel}`, data: nb }); distDiff++; }
}

const now = new Date();
const meta = {
  version: 'v1.6.19',
  title: '摄像头看家事件截图/录像（监控画面墙补全：密码换凭证通道，密码不存服务器）',
  content: [
    '监控 tab 补全：云端直播被小米拦截的摄像头（当前全部 5 台）改为显示「最近一次看家事件截图」（带事件时间角标），点击画面弹出放大窗口并播放该段事件录像（m3u8 经本站代理，浏览器直接播）；直播流哪天开放则自动优先直播。',
    '通道说明：摄像头真实画面只认小米智能摄像头云接口（hass-xiaomi-miot 同款协议：serviceLogin 三步 + RC4-drop1024/SHA1 签名 + 图片 AES-256-CBC 解密），OAuth 授权拿不到（已全面实测收口）。按用户拍板「密码不存生产」：新增本地登录注入工具 scripts/micloud-login-tool.cjs（双击 scripts\\micloud登录.bat），小米账号密码只在本机内存中换凭证（userId/serviceToken/ssecurity），注入生产后即弃；生产仅存 AES-256-GCM 加密凭证，密码永不落盘。',
    '设置 tab 新增「摄像头事件凭证」卡片：状态/注入时间/一键清空 + 本地工具使用指引；凭证过期（约数周）监控页会明确提示，重跑本地工具注入即可。',
    '安全：截图/录像经 12 小时限时 HMAC 签名代理（<img>/hls.js 带不了登录头）；分片仅放行小米流媒体/图片 CDN 域名（防 SSRF）；接口不回显任何令牌。',
    '测试：API 36 项 / UI 15 项全过（本地）。',
  ].join('\n'),
  dist: LIVE_DIST, files: manifest, dist_files: distDiff,
  created_at: now.toISOString(), created_by: 'admin',
};
const zipBuf = buildZip([
  { name: 'UPGRADE.md', data: ['# 升级包 v1.6.19', '',
    `- 标题：${meta.title}`, `- 时间：${now.toLocaleString('zh-CN')}`,
    `- 源码：${manifest.length} 个（2 个新增 + 5 个修改 + 3 个测试/留档）`,
    `- 前端差分：${distDiff} 个文件（构建 ${NEW_DIST}，对比基线 ${BASE_DIST}=生产现状，写入线上目录 ${LIVE_DIST} 原地覆盖）`, '',
    '## 使用（一次性）', '',
    '1. 本地电脑双击 `scripts\\micloud登录.bat`（或 node scripts/micloud-login-tool.cjs）',
    '2. 页面里输入小米账号密码（可能出验证码）→ 工作台地址/账号/密码 → 登录并注入',
    '3. 工作台「监控」tab 点刷新，每台摄像头显示最近事件画面；点击播放事件录像', '',
    '## 文件清单', '',
    ...manifest.map((m) => `- ${m.path}（${statusText[m.status]}，${m.size}B）`),
    `- web/dist/${LIVE_DIST}/**（差分 ${distDiff} 个）`, ''].join('\n') },
  { name: 'manifest.json', data: JSON.stringify(meta, null, 2) },
  ...entries,
]);
if (!fs.existsSync(PKG_DIR)) fs.mkdirSync(PKG_DIR, { recursive: true });
const zipName = `${localTs()}_v1.6.19.zip`;
fs.writeFileSync(path.join(PKG_DIR, zipName), zipBuf);
db.prepare(
  `INSERT INTO upgrade_logs(version,title,content,file_count,package_name,package_size,files_json,created_by,source)
   VALUES(?,?,?,?,?,?,?,?, 'package')`
).run(meta.version, meta.title, meta.content, meta.files.length, zipName, zipBuf.length,
  JSON.stringify(meta.files.map((m) => ({ path: m.path, size: m.size, status: m.status }))), 'admin');
for (const m of manifest) baseline.files[m.path] = m.hash;
baseline.updated_at = now.toISOString();
setSetting(db, 'upgrade_baseline', baseline);
setSetting(db, 'current_version', 'v1.6.19');
console.log(`已生成 ${zipName}（${(zipBuf.length / 1024).toFixed(0)} KB，源码 ${manifest.length} + dist 差分 ${distDiff}）`);
