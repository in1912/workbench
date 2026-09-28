// v1.6.24 升级包（三项修复/调整）：
//   ①分路(split)设备控制修复：多路开关在云端以「父did.sN」出现（如 景瑞上府·电视射灯 2103022063.s2），
//     miotspec 通道不认该 did（读超时/写不执行）→ 一律归一化为父 did + 原 siid 寻址。
//     实测定案（2026-09-29 生产验证）：moduleId 即父设备 siid（tofan-pxln4 模块2-5 ↔ 父 siid2-5，
//     set 父 siid5 → 值变+updateTime 跳变）；卡片/详情页的 siid 本就是父作用域，剥后缀即可。
//   ②「摄像头二次验证」并入设置 tab，全站可用：表单外网/内网地址同样操作（原 localhost 限制解除，
//     用户拍板）；注入目标默认本站（当前访问地址），目标即本站时免本站账号密码直接写库；
//     UI 文案去掉 localhost / localhost:3000 硬编码；旧链接 ?tab=verify 自动落到设置 tab。
//   ③空气净化器/空气检测仪卡片直显温湿度（isEnvSensor 扩展 air-purifier/air-monitor）。
//   附：移除 v1.6.23 临时诊断路由 /mihome/debug/devraw。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(dataDir, 'upgrades');
const LIVE_DIST = '202609220406';
const BASE_DIST = '202609281655'; // v1.6.23 已上线的构建（=生产现状）
const NEW_DIST = '202609281818';

const FILES = [
  'server/services/mihomeService.js', // canonDid 分路归一化 + isEnvSensor 扩展 + 缓存同步/批量读按父 did
  'server/routes/mihomeRoutes.js',    // inject-target 同源直写本库；移除 devraw 临时路由
  'server/auth.js',                   // verify tab 路径并入 settings
  'web/src/tabs.js',                  // 移除 verify tab 项
  'web/src/views/SmartHome.vue',      // 二次验证表单并入设置 tab（全站可用，去域名硬编码）
  'data/test-mihome-api.js',          // 测试（47 项）
  'data/test-mihome-ui.js',           // 测试（19 项）
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
  version: 'v1.6.24',
  title: '修复分路开关（蓝牙网关多路设备）无法控制 + 二次验证并入设置页全站可用 + 空气净化器卡片显温湿度',
  content: [
    '修复（用户反馈：景瑞上府·客厅·电视射灯等经中枢蓝牙网关的开关没反应）：多路开关在米家云端拆成「父did.sN」分路设备（pid=21，extra.split={parentId,moduleId}），miotspec 读/写通道都不认该 did（读一律 -704083036 超时、写信封成功但不执行）。定位过程：生产实测 SET 分路 siid5 无任何状态变化、枚举父设备真实服务布局确认仅 siid2-5 四路开关、控制实验 SET 父 siid5 → 值变+updateTime 跳变 → 定案 moduleId 即父设备 siid。修复：prop/get、prop/set、action 的 did 一律归一化剥掉 .sN 后缀按父 did 寻址（分路 spec 与父相同，卡片/详情页 siid 本就是父作用域）；设备列表批量读与缓存同步按父 did+siid 匹配（父卡与分路卡状态一致）。',
    '调整（用户拍板：该页外网内网都能用、不出现生产域名、卡片放设置页下）：「摄像头二次验证」独立 tab 移除，登录+注入表单并入「设置」tab 的摄像头事件凭证卡片；任何访问地址（公网域名/内网 IP/localhost）下同样操作；注入目标默认本站（当前访问地址），目标即本站时免填本站账号密码直接写库；页面文案不再出现 localhost / localhost:3000（通用措辞「本站（当前访问地址）」）；旧链接 ?tab=verify 自动落到设置页。安全不变：小米密码仅内存换凭证不落盘，凭证 AES-256-GCM 加密存储。',
    '新增：空气净化器/空气检测仪类设备卡片直显温度/湿度（用户需求，如 zhimi.airpurifier.v6）；网关/摄像头等仍不挂载。',
    '清理：移除 v1.6.23 的临时诊断路由 /mihome/debug/devraw。',
    '测试：API 47 项 / UI 19 项全过（本地）。',
  ].join('\n'),
  dist: LIVE_DIST, files: manifest, dist_files: distDiff,
  created_at: now.toISOString(), created_by: 'admin',
};
const zipBuf = buildZip([
  { name: 'UPGRADE.md', data: ['# 升级包 v1.6.24', '',
    `- 标题：${meta.title}`, `- 时间：${now.toLocaleString('zh-CN')}`,
    `- 源码：${manifest.length} 个`, `- 前端差分：${distDiff} 个文件（构建 ${NEW_DIST}，基线 ${BASE_DIST}）`, '',
    '## 验证要点', '',
    '1. 智能家居 → 景瑞上府 → 客厅：电视射灯卡片开关应能控制（分路设备修复），开关状态与其他分路互不干扰',
    '2. 智能家居 → 设置：摄像头事件凭证卡片内直接完成小米账号登录注入（外网/内网同样操作），无生产域名提示',
    '3. 空气净化器（如 77791970）卡片显示温度/湿度', ''].join('\n') },
  { name: 'manifest.json', data: JSON.stringify(meta, null, 2) },
  ...entries,
]);
if (!fs.existsSync(PKG_DIR)) fs.mkdirSync(PKG_DIR, { recursive: true });
const zipName = `${localTs()}_v1.6.24.zip`;
fs.writeFileSync(path.join(PKG_DIR, zipName), zipBuf);
db.prepare(
  `INSERT INTO upgrade_logs(version,title,content,file_count,package_name,package_size,files_json,created_by,source)
   VALUES(?,?,?,?,?,?,?,?, 'package')`
).run(meta.version, meta.title, meta.content, meta.files.length, zipName, zipBuf.length,
  JSON.stringify(meta.files.map((m) => ({ path: m.path, size: m.size, status: m.status }))), 'admin');
for (const m of manifest) baseline.files[m.path] = m.hash;
baseline.updated_at = now.toISOString();
setSetting(db, 'upgrade_baseline', baseline);
setSetting(db, 'current_version', 'v1.6.24');
console.log(`已生成 ${zipName}（${(zipBuf.length / 1024).toFixed(0)} KB，源码 ${manifest.length} + dist 差分 ${distDiff}）`);
