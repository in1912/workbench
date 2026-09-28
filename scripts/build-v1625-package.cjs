// v1.6.25 升级包（用户需求两项）：
//   ①父设备卡片标注：有分路（父did.sN）的父设备在外层卡片左上角高亮「父设备」角标，且外层不显示开关
//     （各分路已有独立卡片可控制；父卡点开进详情页可控全部回路）——顺带消除父卡与分路卡控制同一回路的重复感。
//   ②浴霸卡片直显环境温度：isEnvSensor 增 device:bath-heater / device:ptc-bath-heater
//     （用户家 xiaomi.bhf_light.s1 环境温度在 environment 服务 temperature 属性，实测可读）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(dataDir, 'upgrades');
const LIVE_DIST = '202609220406';
const BASE_DIST = '202609281818'; // v1.6.24 已上线的构建（=生产现状）
const NEW_DIST = '202609281840';

const FILES = [
  'server/services/mihomeService.js', // parentSet 标记 is_parent + isEnvSensor 增浴霸
  'web/src/views/SmartHome.vue',      // 父设备角标 + 外层卡片不挂开关
  'data/test-mihome-api.js',          // 测试（48 项）
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
  version: 'v1.6.25',
  title: '父设备卡片高亮标注（外层不加开关）+ 浴霸卡片直显环境温度',
  content: [
    '调整（用户需求）：多路开关的父设备（did 被分路 父did.sN 引用，全屋共 10 台：pxln4×3、2pro2/2pro3×6、controller.86v1×1）在外层卡片左上角高亮「父设备」角标，且外层卡片不再显示开关——各分路已有独立卡片可直接控制，父卡点开进详情页可控制全部回路；顺带消除父卡与分路卡控制同一物理回路的重复感（如 客厅射灯/电视射灯）。',
    '新增（用户需求）：浴霸类设备（device:bath-heater / ptc-bath-heater）卡片直显环境温度——用户家 公卫米家智能浴霸S1（xiaomi.bhf_light.s1）环境温度在 environment 服务 temperature 属性，已实测可读。',
    '测试：API 48 项 / UI 19 项全过（本地）。',
  ].join('\n'),
  dist: LIVE_DIST, files: manifest, dist_files: distDiff,
  created_at: now.toISOString(), created_by: 'admin',
};
const zipBuf = buildZip([
  { name: 'UPGRADE.md', data: ['# 升级包 v1.6.25', '',
    `- 标题：${meta.title}`, `- 时间：${now.toLocaleString('zh-CN')}`,
    `- 源码：${manifest.length} 个`, `- 前端差分：${distDiff} 个文件（构建 ${NEW_DIST}，基线 ${BASE_DIST}）`, '',
    '## 验证要点', '',
    '1. 智能家居 → 米家：客厅射灯/大客厅/主卧灯等 10 台父设备卡片左上角显示「父设备」角标、无外层开关',
    '2. 公卫米家智能浴霸S1 卡片显示环境温度（°C）',
    '3. 分路设备（电视射灯等）卡片开关仍正常控制', ''].join('\n') },
  { name: 'manifest.json', data: JSON.stringify(meta, null, 2) },
  ...entries,
]);
if (!fs.existsSync(PKG_DIR)) fs.mkdirSync(PKG_DIR, { recursive: true });
const zipName = `${localTs()}_v1.6.25.zip`;
fs.writeFileSync(path.join(PKG_DIR, zipName), zipBuf);
db.prepare(
  `INSERT INTO upgrade_logs(version,title,content,file_count,package_name,package_size,files_json,created_by,source)
   VALUES(?,?,?,?,?,?,?,?, 'package')`
).run(meta.version, meta.title, meta.content, meta.files.length, zipName, zipBuf.length,
  JSON.stringify(meta.files.map((m) => ({ path: m.path, size: m.size, status: m.status }))), 'admin');
for (const m of manifest) baseline.files[m.path] = m.hash;
baseline.updated_at = now.toISOString();
setSetting(db, 'upgrade_baseline', baseline);
setSetting(db, 'current_version', 'v1.6.25');
console.log(`已生成 ${zipName}（${(zipBuf.length / 1024).toFixed(0)} KB，源码 ${manifest.length} + dist 差分 ${distDiff}）`);
