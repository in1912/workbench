// v1.6.0 升级包构建：录音转写新增「VibeVoice-ASR 7B 完整版」客户端引擎（带显卡电脑可选）
// + 算力来源设置下移与列表同宽 + 录音/上传合并单框 + 各模块同宽 + 引擎列迁移顺序缺陷修复。
// 差分模式（同 v1.5.10）：新 dist 与【生产现状】逐文件 sha256 对比，只带变更文件且写进
// 【生产服务的 dist 目录名】原地覆盖。
// 生产现状对应本地构建目录 = v1.5.10 的新构建目录 202609220634（生产 202609220406 已被其原地覆盖）。
// 本次含 server 源码变更（vibe7b 引擎分发 + 客户端拉取模式 + 引擎列迁移修复），非纯前端批次。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(dataDir, 'upgrades');
const VERSION = 'v1.6.0';
const LIVE_DIST = '202609220406';  // 生产当前服务的 dist 目录名（写入目标）
const BASE_DIST = '202609220634'; // 生产现状对应的本地构建目录（对比基线 = v1.5.10 的新构建）
const NEW_DIST = '202609220755';  // 本次新构建（含 7B 前端）
const FILES = [
  'server/index.js',            // /vibe/job 加入 EXEMPT（客户端拉取模式领任务/回传无需登录）
  'server/db.js',               // vibe_jobs 引擎列（CREATE TABLE 补列 + 迁移后再建索引，修复重启崩溃）
  'server/routes/vibeRoutes.js', // 7B 引擎分发/客户端下载 vibe7b-repo.zip/引擎隔离领取
  'server/routes/upgradeRoutes.js', // 补 whisper 引擎二进制落点说明（随包注释，无功能改动）
  'server/services/vibeasrService.js', // 1.5B sidecar 快速崩溃退避（15s 内 ≥3 次转 5 分钟重试）
  'server/vibeasr/server.js',   // 7B sidecar 代理模式（--proxy 直连 WSL vLLM）
  'server/vibe7b-repo.zip',     // 7B 客户端部署包（WSL2 一键脚本 + vLLM 配置，162KB）
  'web/src/components/VibeVoiceTab.vue', // 7B 引擎选项 + 算力来源下移 + 录音/上传合并 + 模块同宽
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
  title: '录音转写新增 VibeVoice-ASR 7B 完整版（客户端 GPU）+ 算力来源下移 + 录音/上传合并 + 引擎列迁移修复',
  content: [
    '新增「VibeVoice-ASR 7B 完整版」客户端引擎：带 NVIDIA 显卡的客户端电脑可选 7B 完整版（WSL2 + vLLM 本地推理），说话人分离更准；无显卡电脑继续用 1.5B 量化版（纯 CPU）。用户在「算力来源」里自行选择用哪个引擎转写。',
    '「算力来源」设置区移到录音文件列表下方，与列表同宽。',
    '「录音」按钮与「上传录音」合并到同一个矩形框内，左右分开。',
    '页面各模块统一宽度。',
    '服务端修复 vibe_jobs 引擎列迁移顺序缺陷（旧库重启崩溃）+ 7B 客户端拉取模式与引擎隔离（1.5B 领不到 7B 任务，反之亦然）。',
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
console.log(`位置: ${path.join(PKG_DIR, pkgName)}`);
