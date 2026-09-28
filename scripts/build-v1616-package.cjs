// v1.6.16 升级包：摄像头监控直播 tab + 全量参数翻译（设备实测词典）+ 缓存刷新间隔可配
//   需求（2026-09-28 用户）：① 缓存后台静默更新间隔 5 分钟 → 1 小时，且设置页可按分钟配置；
//   ② 监控预览独立 tab：3 列自适应画面墙，能直播直接播（云端 HLS→本站代理），点击放大播放；
//   ③ 生产环境遍历全部设备参数，翻译后存入参数翻译并给设备做翻译。
//   server：mihomeTermsData.js（新增：123 台生产设备 52 规格全量提取的 1313 词条人工翻译词典）
//           mihomeService.js（TTL 走 prefs.cache_ttl_min 默认 60；摄像头 HLS 云端取流 start-hls-stream +
//           会话缓存 + 就绪探测；camSign/camVerify 限时 HMAC 签名；fetchCamPlaylist/fetchCamSegment 代理拉流；
//           xiaomiHttp 响应补 arrayBuffer）
//           mihomeRoutes.js（GET /mihome/terms 词典下发；prefs 增 cache_ttl_min 校验；GET /mihome/camera/live；
//           /mihome/cam/hls 播放列表改写+分片转发免登录代理）
//           index.js（EXEMPT 增 /mihome/cam/hls：hls.js 拉流带不了登录头，限时签名即凭证）
//           auth.js（TAB_PATHS.smarthome 增 monitor/terms tab，页内共享）
//   web：SmartHome.vue（监控 tab 3 列画面墙 + 半透明播放按钮 + 放大弹窗 + RTSP 复制；
//         hls.js 懒加载、Safari 原生 HLS、离开页面销毁实例；设置 tab 缓存刷新间隔输入；
//         词典双层查词 zh2 = 内置静态 + 设备实测；参数翻译 tab 增「设备实测词条」组）
//        tabs.js（smarthome 增 monitor tab）
//   dist 差分：新构建 202609281311 对比基线 202609281040（=生产现状 v1.6.15），写入线上目录 202609220406 原地覆盖。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(dataDir, 'upgrades');
const LIVE_DIST = '202609220406'; // 生产当前服务的 dist 目录名（写入目标）
const BASE_DIST = '202609281040'; // 生产现状对应的本地构建目录（v1.6.15 构建）
const NEW_DIST = '202609281311';  // 本次新构建

const FILES = [
  'server/services/mihomeTermsData.js', // 新增：设备实测词条词典（1313 词条）
  'server/services/mihomeService.js',   // 缓存 TTL 可配 + 摄像头取流/签名/代理拉流 + arrayBuffer
  'server/routes/mihomeRoutes.js',      // terms 词典 + prefs 校验 + camera/live + HLS 代理
  'server/index.js',                    // EXEMPT 增 /mihome/cam/hls
  'server/auth.js',                     // smarthome 增 monitor/terms tab
  'web/src/views/SmartHome.vue',        // 监控 tab + 设置缓存间隔 + 双层查词
  'web/src/tabs.js',                    // smarthome 增 monitor tab
  'web/src/miotTerms.js',               // 留档（未变）
  'web/src/nav.js',                     // 留档（未变）
  'web/src/router/index.js',            // 留档（未变）
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
  version: 'v1.6.16',
  title: '摄像头监控直播（画面墙+放大播放）+ 全量设备参数翻译 + 缓存刷新间隔可配',
  content: [
    '新增「监控」tab：家里全部摄像头 3 列自适应画面墙；支持的型号直接播放云端 HLS 实时画面（经服务器代理转发，兼容所有网络），画面上有半透明播放按钮，点击弹出放大窗口播放、可暂停/音量/复制 RTSP 地址；不支持云端直播的型号显示原因说明。实测：门口/阳台两台可直播，客厅取流被小米拒绝，婴儿床/儿童房型号未开放云端画面。',
    '全量参数翻译：遍历生产 123 台设备、52 个规格，提取全部未翻译英文参数（服务/属性/动作/事件名 802 个 + 枚举值 511 个）人工翻译成 1313 条词典，存入服务端并下发；设备详情页名称与枚举值双层查词（内置词典 + 设备实测词典），基本消灭英文参数；「参数翻译」tab 新增「设备实测词条」分组，可搜索。',
    '缓存刷新间隔可配：设备列表缓存后台静默更新的间隔从固定 5 分钟改为默认 60 分钟，设置页可按分钟输入（1-1440），保存即时生效。',
    '直播安全：拉流地址仅放行小米流媒体域名（防 SSRF）；hls.js 拉流用 12 小时限时 HMAC 签名作凭证，不暴露登录态。',
  ].join('\n'),
  dist: LIVE_DIST, files: manifest, dist_files: distDiff,
  created_at: now.toISOString(), created_by: 'admin',
};
const zipBuf = buildZip([
  { name: 'UPGRADE.md', data: ['# 升级包 v1.6.16', '',
    `- 标题：${meta.title}`, `- 时间：${now.toLocaleString('zh-CN')}`,
    `- 源码：${manifest.length} 个（1 个新增词典 + 4 个服务端修改 + 1 个前端主修改 + 4 个留档）`,
    `- 前端差分：${distDiff} 个文件（构建 ${NEW_DIST}，对比基线 ${BASE_DIST}=生产现状 v1.6.15，写入线上目录 ${LIVE_DIST} 原地覆盖）`, '',
    '## 变更点', '',
    '1. 监控 tab：云端 HLS 直播（start-hls-stream 动作取转码地址；实测地址绑定出口 IP，浏览器直连 404 → 服务器代理拉流+改写播放列表）。',
    '2. 全量翻译：mihomeTermsData.js 1313 词条；详情页/词典双层查词；/mihome/terms 下发。',
    '3. 缓存间隔：prefs.cache_ttl_min（1-1440 分钟，默认 60），设置页可改。',
    '', '## 文件清单', '',
    ...manifest.map((m) => `- ${m.path}（${statusText[m.status]}，${m.size}B）`),
    `- web/dist/${LIVE_DIST}/**（差分 ${distDiff} 个）`, ''].join('\n') },
  { name: 'manifest.json', data: JSON.stringify(meta, null, 2) },
  ...entries,
]);
if (!fs.existsSync(PKG_DIR)) fs.mkdirSync(PKG_DIR, { recursive: true });
const zipName = `${localTs()}_v1.6.16.zip`;
fs.writeFileSync(path.join(PKG_DIR, zipName), zipBuf);
db.prepare(
  `INSERT INTO upgrade_logs(version,title,content,file_count,package_name,package_size,files_json,created_by,source)
   VALUES(?,?,?,?,?,?,?,?, 'package')`
).run(meta.version, meta.title, meta.content, meta.files.length, zipName, zipBuf.length,
  JSON.stringify(meta.files.map((m) => ({ path: m.path, size: m.size, status: m.status }))), 'admin');
for (const m of manifest) baseline.files[m.path] = m.hash;
baseline.updated_at = now.toISOString();
setSetting(db, 'upgrade_baseline', baseline);
setSetting(db, 'current_version', 'v1.6.16');
console.log(`已生成 ${zipName}（${(zipBuf.length / 1024).toFixed(0)} KB，源码 ${manifest.length} + dist 差分 ${distDiff}）`);
