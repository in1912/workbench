// v1.5.8 Whisper 引擎升级包构建：node scripts/build-whisper-package.cjs
// 包内 = whisper 服务端 7 文件（sidecar + 双平台 whisper-cli 二进制 + 3 个 service + 路由）
//        + 最新 web/dist 快照。所有条目都在 server/ 与 web/dist/ 前缀下——旧容器
//        的应用白名单（applyTargetPath）原样放行，不存在 v1.5.0 的新前缀鸡生蛋问题。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(dataDir, 'upgrades');
const VERSION = 'v1.5.8';
const FILES = [
  'server/whisper/server.js',
  'server/whisper/win-x64/whisper-cli.exe',
  'server/whisper/linux-x64/whisper-cli',
  'server/services/whisperPaths.js',
  'server/services/whisperService.js',
  'server/services/whisperInstaller.js',
  'server/routes/vibeRoutes.js',
];
const hashBuf = (b) => crypto.createHash('sha256').update(b).digest('hex');
function localTs() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const distRoot = path.join(ROOT, 'web', 'dist');
const dist = fs.readdirSync(distRoot)
  .filter((f) => fs.statSync(path.join(distRoot, f)).isDirectory() && fs.existsSync(path.join(distRoot, f, 'index.html')))
  .sort().pop();
if (!dist) throw new Error('未找到前端构建产物');

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
let distFiles = 0;
const addDir = (dir, rel) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) addDir(path.join(dir, ent.name), r);
    else { entries.push({ name: `web/dist/${dist}/${r}`, data: fs.readFileSync(path.join(dir, ent.name)) }); distFiles++; }
  }
};
addDir(path.join(distRoot, dist), '');

const now = new Date();
const meta = {
  version: VERSION,
  title: '录音转写新增 Whisper large-v3-turbo 服务器引擎（首选）',
  content: [
    '新增 OpenAI whisper-large-v3-turbo（whisper.cpp 引擎，纯 CPU）：服务器引擎首选，带时间戳/多语言，说话人恒为 1；',
    '一键安装（834MB q8_0 模型 hf-mirror 断点续传）、终止安装、卸载模型与 VibeASR 同款三按钮；',
    '识别语言可设（安静手机录音建议固定中文）；随包分发 win-x64/linux-x64 静态 whisper-cli；VibeASR 保留为备选。',
  ].join('\n'),
  dist, files: manifest, dist_files: distFiles,
  created_at: now.toISOString(), created_by: 'admin',
};
const statusText = { new: '新增', changed: '修改', unchanged: '未变更' };
const md = [
  `# 升级包 ${VERSION}`, '',
  `- 标题：${meta.title}`,
  `- 时间：${now.toLocaleString('zh-CN')}`,
  `- 服务端文件：${manifest.length} 个`,
  `- 前端构建快照：${dist}（${distFiles} 个文件）`, '',
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

console.log(`升级包已生成: ${pkgName}（${(zipBuf.length / 1024 / 1024).toFixed(2)} MB，源码 ${manifest.length} + dist ${distFiles} 个文件）`);
console.log(`位置: ${path.join(PKG_DIR, pkgName)}`);
