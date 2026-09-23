// v1.6.1 升级包构建：录音保存三节点进度条 + 转写进度条（估算）。
// 差分模式：新 dist 202609230342 与生产现状（= v1.6.0 构建目录 202609220755）对比，
// 变更文件写进线上目录 202609220406 原地覆盖。含 server 变更（vibeRoutes：records 加 run_ms/rtf_est、transcript 加 run_ms）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(dataDir, 'upgrades');
const VERSION = 'v1.6.1';
const LIVE_DIST = '202609220406';  // 生产当前服务的 dist 目录名（写入目标，v1.5.9 起被多包原地覆盖）
const BASE_DIST = '202609220755'; // 生产现状对应的本地构建目录（对比基线 = v1.6.0 的新构建）
const NEW_DIST = '202609230342';  // 本次新构建（进度条前端）
const FILES = [
  'server/routes/vibeRoutes.js',        // records 返回 run_ms + rtf_est（历史 RTF 中位数）；transcript 返回 run_ms
  'web/src/components/VibeVoiceTab.vue', // 保存三节点进度 + 转写进度条 + beforeunload 守卫 + 上传百分比
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
  title: '录音保存三节点进度条 + 转写进度显示：整理→编译生成→上传服务器，可感知进度',
  content: [
    '录音停止后显示三节点步骤条（① 整理录音 ② 编译生成文件 ③ 上传服务器）+ 总进度条：解码阶段动画推进，MP3 编码按块真实进度（分块让出主线程、长录音页面不卡），上传改 XHR 显示真实字节进度（已传/总量/百分比）；上传文件也显示百分比。',
    '处理中挂 beforeunload 守卫并显示「请勿关闭或切换页面」；完成后显示文件名/大小/用时与「现在可以安全离开页面」提示。',
    '转写过程进度：列表行内迷你进度条 + 详情区大进度条，按历史转写速度（RTF 中位数 rtf_est）估算百分比与剩余时间，每秒推进；详情区明确提示「转写在服务器进行，此期间可以离开页面」。',
  ].join('\n'),
  dist: LIVE_DIST, files: manifest, dist_files: distDiff,
  created_at: now.toISOString(), created_by: 'admin',
};
const statusText = { new: '新增', changed: '修改', unchanged: '未变更' };
const md = [
  `# 升级包 ${VERSION}`, '',
  `- 标题：${meta.title}`,
  `- 时间：${now.toLocaleString('zh-CN')}`,
  `- 前端源码留档：${manifest.length} 个（含 server 变更）`,
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
