// v1.6.26 升级包（bug 修复，纯服务端，无前端变更）：
//   分路卡片开关全部控制第一回路（用户实测：大客厅分路 走廊灯/门灯/吊灯/玄关灯 卡片打开的都是同一盏灯）。
//   根因：detectSwitch 对分路设备也固定返回第一个 switch 服务（siid2），v1.6.24 的 canonDid 只修了 did 寻址。
//   修复：新增 splitSwitchPoint——分路开关点 siid=分路号（moduleId 即父 siid，已实验定案），
//   piid 取该 siid 服务下第一个可写 bool；该 siid 无可写 bool 则不挂开关。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(dataDir, 'upgrades');
const LIVE_DIST = '202609220406';
const BASE_DIST = '202609281840'; // v1.6.25 已上线的构建（=生产现状，本次无前端变更）
const NEW_DIST = '202609281840'; // 同一构建：dist 差分为 0，仅上服务端文件

const FILES = [
  'server/services/mihomeService.js', // splitSwitchPoint：分路开关点 siid=分路号
  'data/test-mihome-api.js',          // 测试（52 项，含 splitSwitchPoint/detectSwitch 对照）
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
  version: 'v1.6.26',
  title: '修复：分路设备卡片开关全部控制第一回路（大客厅分路全打开同一盏灯）',
  content: [
    '修复（用户实测反馈：大客厅下的 走廊灯/门灯/吊灯/玄关灯 等分路卡片，打开的都是同一个开关）：根因是 detectSwitch 对分路设备也固定返回第一个 switch 服务（siid2）——v1.6.24 的分路修复只归一化了 did 寻址（.sN→父did），开关点位没跟着分路走，导致所有分路卡片都控制第一回路（当时用 .s2 验证恰好 siid=分路号=2，掩盖了问题）。修复：新增 splitSwitchPoint，分路设备开关点 siid=分路号（moduleId 即父 siid，此前已实验定案），piid 取该 siid 服务下第一个可写 bool 属性；该 siid 无可写 bool 属性的分路不挂外层开关。',
    '纯服务端修复，无前端变更（卡片直接使用服务端下发的开关点位）。',
    '测试：API 52 项全过（新增 splitSwitchPoint/detectSwitch 对照 4 项）。',
  ].join('\n'),
  dist: LIVE_DIST, files: manifest, dist_files: distDiff,
  created_at: now.toISOString(), created_by: 'admin',
};
const zipBuf = buildZip([
  { name: 'UPGRADE.md', data: ['# 升级包 v1.6.26', '',
    `- 标题：${meta.title}`, `- 时间：${now.toLocaleString('zh-CN')}`,
    `- 源码：${manifest.length} 个`, `- 前端差分：${distDiff} 个文件（无前端变更，构建同基线 ${BASE_DIST}）`, '',
    '## 验证要点', '',
    '1. 智能家居 → 米家：大客厅下各分路（走廊灯/门灯/吊灯/玄关灯）卡片开关应各控各的灯',
    '2. 其余父设备（客厅射灯/主卧灯等）的分路同理', ''].join('\n') },
  { name: 'manifest.json', data: JSON.stringify(meta, null, 2) },
  ...entries,
]);
if (!fs.existsSync(PKG_DIR)) fs.mkdirSync(PKG_DIR, { recursive: true });
const zipName = `${localTs()}_v1.6.26.zip`;
fs.writeFileSync(path.join(PKG_DIR, zipName), zipBuf);
db.prepare(
  `INSERT INTO upgrade_logs(version,title,content,file_count,package_name,package_size,files_json,created_by,source)
   VALUES(?,?,?,?,?,?,?,?, 'package')`
).run(meta.version, meta.title, meta.content, meta.files.length, zipName, zipBuf.length,
  JSON.stringify(meta.files.map((m) => ({ path: m.path, size: m.size, status: m.status }))), 'admin');
for (const m of manifest) baseline.files[m.path] = m.hash;
baseline.updated_at = now.toISOString();
setSetting(db, 'upgrade_baseline', baseline);
setSetting(db, 'current_version', 'v1.6.26');
console.log(`已生成 ${zipName}（${(zipBuf.length / 1024).toFixed(0)} KB，源码 ${manifest.length} + dist 差分 ${distDiff}）`);
