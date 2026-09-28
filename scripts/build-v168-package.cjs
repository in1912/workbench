// v1.6.8 升级包：智能家居（米家）模块
//   server：mihomeService.js（OAuth2 绑定/令牌加密/家庭设备总览/属性读写/MIoT-Spec 能力描述/错误码中文映射）
//           mihomeRoutes.js（status/bind/callback/homes/spec/prop get set/action 路由）
//           index.js（EXEMPT 加 /mihome/callback + 挂载路由）、auth.js（PAGES 加 smarthome + tab 映射）
//   web 源码留档：SmartHome.vue（新页）、tabs.js、nav.js、router/index.js
//   dist 差分：新构建 202609280911 对比基线 202609280806（=生产现状 v1.6.7），写入线上目录 202609220406 原地覆盖。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(dataDir, 'upgrades');
const LIVE_DIST = '202609220406'; // 生产当前服务的 dist 目录名（写入目标）
const BASE_DIST = '202609280806'; // 生产现状对应的本地构建目录（v1.6.7 构建）
const NEW_DIST = '202609280918';  // 本次新构建

const FILES = [
  'server/services/mihomeService.js', // 新增：米家云服务
  'server/routes/mihomeRoutes.js',    // 新增：路由
  'server/index.js',                  // EXEMPT + 挂载
  'server/auth.js',                   // smarthome 页注册
  'web/src/views/SmartHome.vue',      // 留档：新页面
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
  version: 'v1.6.8',
  title: '智能家居：米家设备扫码绑定与云端控制',
  content: [
    '新增「智能家居」页（侧边栏「我的宠物」下方），含「米家」「设置」两个 tab。',
    '设置 tab：选服务区域 → 生成小米账号 OAuth2 授权二维码 → 手机（已登录小米账号）扫码确认 → 自动完成绑定；支持复制授权链接、解绑（清空令牌）。',
    '访问令牌/刷新令牌 AES-256-GCM 加密存储，接口响应与日志中不出现；到期自动用 refresh_token 续期，续期失败自动回到未绑定态提示重新扫码。',
    '米家 tab：按「家庭 → 房间」展示方形设备卡片（设备名/图标/在线状态）；有开关能力的设备卡片右下角显示圆形开关按钮（无开关能力不显示），点击即开/关。',
    '点击卡片弹出详情：展示该设备全部 MIoT 开放能力——服务的属性（当前值读取 + 布尔开关/枚举下拉/数值范围写入）、动作（带参数表单执行）、事件（列表展示），含错误码中文提示（设备离线/属性不支持/值超范围等）。',
    '通道与边界：小米账号 OAuth2 + 米家云端 MIoT 接口，纯云端调用；仅操作账号下已在米家 App 绑定的成品设备；绑定对全工作台共享，页面权限在「用户管理 → 智能家居」控制。',
    '本次升级只新增代码与页面，不改动既有业务数据。',
  ].join('\n'),
  dist: LIVE_DIST, files: manifest, dist_files: distDiff,
  created_at: now.toISOString(), created_by: 'admin',
};
const zipBuf = buildZip([
  { name: 'UPGRADE.md', data: ['# 升级包 v1.6.8', '',
    `- 标题：${meta.title}`, `- 时间：${now.toLocaleString('zh-CN')}`,
    `- 源码：${manifest.length} 个（新增 2 个服务端文件，4 个 web 源码留档）`,
    `- 前端差分：${distDiff} 个文件（构建 ${NEW_DIST}，对比基线 ${BASE_DIST}=生产现状，写入线上目录 ${LIVE_DIST} 原地覆盖）`, '',
    '## 升级内容', '', meta.content, '',
    '## 绑定与使用', '',
    '1. 升级后进入「智能家居 → 设置」，确认服务区域（默认中国大陆），点「生成绑定二维码」。',
    '2. 手机浏览器扫一扫（小米浏览器/Safari/Chrome/微信，已登录小米账号）扫码 → 确认授权 → 页面自动完成绑定并跳到米家 tab。注意：米家 App 的「扫一扫」只认设备配网码，不识别网址二维码，不要用它扫。',
    '3. 卡片右下角圆形按钮 = 开/关；点卡片本体 = 详情弹窗（全部属性/动作/事件）。',
    '', '## 文件清单', '',
    ...manifest.map((m) => `- ${m.path}（${statusText[m.status]}，${m.size}B）`),
    `- web/dist/${LIVE_DIST}/**（差分 ${distDiff} 个）`, ''].join('\n') },
  { name: 'manifest.json', data: JSON.stringify(meta, null, 2) },
  ...entries,
]);
if (!fs.existsSync(PKG_DIR)) fs.mkdirSync(PKG_DIR, { recursive: true });
const zipName = `${localTs()}_v1.6.8.zip`;
fs.writeFileSync(path.join(PKG_DIR, zipName), zipBuf);
db.prepare(
  `INSERT INTO upgrade_logs(version,title,content,file_count,package_name,package_size,files_json,created_by,source)
   VALUES(?,?,?,?,?,?,?,?, 'package')`
).run(meta.version, meta.title, meta.content, meta.files.length, zipName, zipBuf.length,
  JSON.stringify(meta.files.map((m) => ({ path: m.path, size: m.size, status: m.status }))), 'admin');
for (const m of manifest) baseline.files[m.path] = m.hash;
baseline.updated_at = now.toISOString();
setSetting(db, 'upgrade_baseline', baseline);
setSetting(db, 'current_version', 'v1.6.8');
console.log(`已生成 ${zipName}（${(zipBuf.length / 1024).toFixed(0)} KB，源码 ${manifest.length} + dist 差分 ${distDiff}）`);
