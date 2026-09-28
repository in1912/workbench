// v1.6.9 升级包：修复米家扫码绑定——适配小米 OAuth 回调白名单
//   背景（2026-09-28 生产实测）：小米对 client 2882303761520251711 的 redirect_uri 有白名单，
//   仅放行 homeassistant.local:8123 域名（http/https、任意路径），自定义域名/localhost 一律 invalid redirect uri。
//   官方 Home Assistant 靠局域网 mDNS 解析该域名；本站生产在远端 VPS，浏览器解析不了 →
//   改为固定白名单回调 + 授权后「复制打不开页面的地址栏网址 → 粘贴回填」完成绑定（POST /mihome/bind/manual）。
//   server：mihomeService.js（OAUTH2_REDIRECT_URI 常量 + parseCallbackUrl 手动回填解析）
//           mihomeRoutes.js（bind/start 用固定回调；新增 bind/manual 路由；删 redirectBase）
//   web 源码留档：SmartHome.vue（设置页改 4 步绑定流程 + 回填输入框）、tabs.js、nav.js、router/index.js
//   dist 差分：新构建 202609280929 对比基线 202609280918（=生产现状 v1.6.8），写入线上目录 202609220406 原地覆盖。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(dataDir, 'upgrades');
const LIVE_DIST = '202609220406'; // 生产当前服务的 dist 目录名（写入目标）
const BASE_DIST = '202609280918'; // 生产现状对应的本地构建目录（v1.6.8 构建）
const NEW_DIST = '202609280929';  // 本次新构建

const FILES = [
  'server/services/mihomeService.js', // 白名单回调常量 + 手动回填解析
  'server/routes/mihomeRoutes.js',    // bind/manual 路由
  'server/index.js',                  // 未变（沿用 v1.6.8 的 EXEMPT 与挂载）
  'server/auth.js',                   // 未变（沿用 v1.6.8 的页/tab 注册）
  'web/src/views/SmartHome.vue',      // 设置页 4 步绑定流程
  'web/src/tabs.js',                  // 留档：tab 定义
  'web/src/nav.js',                   // 留档：导航项
  'web/src/router/index.js',          // 留档：路由
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
  version: 'v1.6.9',
  title: '修复智能家居米家扫码绑定：适配小米回调白名单（授权链接回填）',
  content: [
    '问题：v1.6.8 生产扫码授权时小米提示 invalid redirect uri。经实测，小米 OAuth 对本应用只放行 homeassistant.local:8123 回调域名（官方 Home Assistant 固定回调，靠局域网 mDNS 解析），自定义域名一律拒绝。',
    '修复：授权回调固定改用小米白名单域名；授权成功后浏览器会跳到一个打不开的页面（homeassistant.local），授权码就在该页地址栏里——设置页改为 4 步引导：生成二维码 → 浏览器授权 → 复制打不开页面的地址栏网址 → 粘贴回填完成绑定。',
    '新增 POST /api/mihome/bind/manual：解析回填网址中的 code/state，校验绑定会话后换令牌落库（会话 10 分钟有效，错误均有中文提示）。',
    '保留原回调路由与轮询（若网络环境恰好能解析白名单域名到本站则仍可自动完成）。',
    '令牌存储/加密/设备控制逻辑不变，不改动既有业务数据。',
  ].join('\n'),
  dist: LIVE_DIST, files: manifest, dist_files: distDiff,
  created_at: now.toISOString(), created_by: 'admin',
};
const zipBuf = buildZip([
  { name: 'UPGRADE.md', data: ['# 升级包 v1.6.9', '',
    `- 标题：${meta.title}`, `- 时间：${now.toLocaleString('zh-CN')}`,
    `- 源码：${manifest.length} 个（2 个服务端修改，6 个留档）`,
    `- 前端差分：${distDiff} 个文件（构建 ${NEW_DIST}，对比基线 ${BASE_DIST}=生产现状，写入线上目录 ${LIVE_DIST} 原地覆盖）`, '',
    '## 绑定步骤（新版）', '',
    '1. 「智能家居 → 设置」→ 生成授权二维码。',
    '2. 手机浏览器扫一扫（不要用米家 App 的扫一扫），或在这台电脑的浏览器打开授权页。',
    '3. 登录小米账号并同意授权——之后页面会显示打不开（homeassistant.local），这是正常现象。',
    '4. 复制浏览器地址栏完整网址，回到设置页粘贴 → 点「完成绑定」。',
    '', '## 文件清单', '',
    ...manifest.map((m) => `- ${m.path}（${statusText[m.status]}，${m.size}B）`),
    `- web/dist/${LIVE_DIST}/**（差分 ${distDiff} 个）`, ''].join('\n') },
  { name: 'manifest.json', data: JSON.stringify(meta, null, 2) },
  ...entries,
]);
if (!fs.existsSync(PKG_DIR)) fs.mkdirSync(PKG_DIR, { recursive: true });
const zipName = `${localTs()}_v1.6.9.zip`;
fs.writeFileSync(path.join(PKG_DIR, zipName), zipBuf);
db.prepare(
  `INSERT INTO upgrade_logs(version,title,content,file_count,package_name,package_size,files_json,created_by,source)
   VALUES(?,?,?,?,?,?,?,?, 'package')`
).run(meta.version, meta.title, meta.content, meta.files.length, zipName, zipBuf.length,
  JSON.stringify(meta.files.map((m) => ({ path: m.path, size: m.size, status: m.status }))), 'admin');
for (const m of manifest) baseline.files[m.path] = m.hash;
baseline.updated_at = now.toISOString();
setSetting(db, 'upgrade_baseline', baseline);
setSetting(db, 'current_version', 'v1.6.9');
console.log(`已生成 ${zipName}（${(zipBuf.length / 1024).toFixed(0)} KB，源码 ${manifest.length} + dist 差分 ${distDiff}）`);
