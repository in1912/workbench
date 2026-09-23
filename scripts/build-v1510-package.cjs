// v1.5.10 升级包构建：效率工具默认落点=录音转写 + 「转写耗时」改名 + 操作列前移。
// 差分模式（同 v1.5.9）：新 dist 与【生产现状】逐文件 sha256 对比，只带变更文件且写进
// 【生产服务的 dist 目录名】原地覆盖。
// 注意：生产的 202609220406 目录已被 v1.5.9 差分包原地覆盖过，本地同名目录是旧内容——
// 对比基线必须用 v1.5.9 的构建目录 202609220528（其 index-ONhbONbT.js 与 http://localhost:3000/ 一致）。
// 纯前端批次：web/src 条目仅留档（apply 只落 web/dist/ 与 server/），无 server 文件。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(dataDir, 'upgrades');
const VERSION = 'v1.5.10';
const LIVE_DIST = '202609220406';  // 生产当前服务的 dist 目录名（写入目标）
const BASE_DIST = '202609220528'; // 生产现状对应的本地构建目录（对比基线）
const NEW_DIST = '202609220634';  // 本次新构建
const FILES = [
  'web/src/tabs.js',
  'web/src/views/Tools.vue',
  'web/src/components/VibeVoiceTab.vue', // 留档（apply 只落 web/dist/ 与 server/）
];
const hashBuf = (b) => crypto.createHash('sha256').update(b).digest('hex');
function localTs() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const distRoot = path.join(ROOT, 'web', 'dist');
const baseDir = path.join(distRoot, BASE_DIST);
const newDir = path.join(distRoot, NEW_DIST);
if (!fs.existsSync(path.join(baseDir, 'index.html'))) throw new Error('基线 dist 目录不存在：' + BASE_DIST);
if (!fs.existsSync(path.join(newDir, 'index.html'))) throw new Error('新 dist 目录不存在：' + NEW_DIST);

const baseline = getSetting(db, 'upgrade_baseline', { files: {}, updated_at: null });
const entries = [];
const manifest = [];
for (const rel of FILES) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) throw new Error(`文件不存在：${rel}`);
  const data = fs.readFileSync(abs);
  const hash = hashBuf(data);
  const old = (baseline.files || {})[rel];
  manifest.push({ path: rel, size: data.length, hash, status: !old ? 'new' : old === hash ? 'unchanged' : 'changed' });
  entries.push({ name: rel, data });
}

// 差分 dist：新构建与生产现状（基线目录）不同/缺的文件，写进生产服务的目录名（原地覆盖）
const listFiles = (dir, rel, out) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) listFiles(path.join(dir, ent.name), r, out);
    else out.push(r);
  }
};
const newFiles = [];
listFiles(newDir, '', newFiles);
let distDiff = 0;
for (const rel of newFiles) {
  const nb = fs.readFileSync(path.join(newDir, rel));
  const basePath = path.join(baseDir, rel);
  let same = false;
  try { same = fs.existsSync(basePath) && hashBuf(fs.readFileSync(basePath)) === hashBuf(nb); } catch { same = false; }
  if (!same) { entries.push({ name: `web/dist/${LIVE_DIST}/${rel}`, data: nb }); distDiff++; }
}

const now = new Date();
const meta = {
  version: VERSION,
  title: '效率工具默认进录音转写 + 列表「转写耗时」改名 + 操作列前移',
  content: [
    '效率工具页第一个 tab 改为「录音转写」，进入模块默认落该页（无该 tab 权限的受限用户自动落到其第一个有权限的 tab，深链 ?tab=xxx 不受影响）；',
    '录音文件列表「撰写耗时」列改名「转写耗时」（口径不变：从点「转写」到出结果的全程用时，含排队/引擎加载/推理；老记录与未转写显示 —）；',
    '列表「操作」列（转写/下载/播放/删除）从末列挪到「序号」后第二列。',
  ].join('\n'),
  dist: LIVE_DIST, files: manifest, dist_files: distDiff,
  created_at: now.toISOString(), created_by: 'admin',
};
const statusText = { new: '新增', changed: '修改', unchanged: '未变更' };
const md = [
  `# 升级包 ${VERSION}`, '',
  `- 标题：${meta.title}`,
  `- 时间：${now.toLocaleString('zh-CN')}`,
  `- 前端源码留档：${manifest.length} 个（纯前端批次，无 server 变更）`,
  `- 前端差分：${distDiff} 个文件（构建 ${NEW_DIST}，对比基线 ${BASE_DIST}=生产现状，写入线上目录 ${LIVE_DIST} 原地覆盖）`, '',
  '## 升级内容', '',
  meta.content, '',
  '## 文件清单', '',
  ...manifest.map((m) => `- ${m.path}（${statusText[m.status]}，${m.size}B）`),
  '',
].join('\n');
entries.unshift({ name: 'manifest.json', data: JSON.stringify(meta, null, 2) });
entries.unshift({ name: 'UPGRADE.md', data: md });

const zipBuf = buildZip(entries);
if (!fs.existsSync(PKG_DIR)) fs.mkdirSync(PKG_DIR, { recursive: true });
const pkgName = `${localTs()}_${VERSION}.zip`;
fs.writeFileSync(path.join(PKG_DIR, pkgName), zipBuf);

db.prepare(
  `INSERT INTO upgrade_logs(version,title,content,file_count,package_name,package_size,files_json,created_by,source)
   VALUES(?,?,?,?,?,?,?,?, 'package')`
).run(VERSION, meta.title, meta.content, manifest.length, pkgName, zipBuf.length,
  JSON.stringify(manifest.map((m) => ({ path: m.path, size: m.size, status: m.status }))), 'admin');

for (const m of manifest) baseline.files[m.path] = m.hash;
baseline.updated_at = now.toISOString();
setSetting(db, 'upgrade_baseline', baseline);
setSetting(db, 'current_version', VERSION);

console.log(`升级包已生成: ${pkgName}（${(zipBuf.length / 1024).toFixed(0)} KB，源码留档 ${manifest.length} + dist 差分 ${distDiff} 个文件）`);
console.log(`位置: ${path.join(PKG_DIR, pkgName)}`);
