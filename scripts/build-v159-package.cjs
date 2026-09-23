// v1.5.9 升级包构建：录音转写列表新增「撰写耗时/使用模型」两列 + 手机播放修复（Range/206）。
// 差分模式（同 v1.5.4/v1.5.8）：新 dist 与线上 dist（202609220406）逐文件 sha256 对比，
// 只带变更文件且写进【线上 dist 目录名】原地覆盖——新开目录会因缺 assets 全 200 回落 index.html，
// 且全量 dist ~8MB 贴近 Cloudflare 524 红线。
// server 文件走 server/ 前缀（apply 白名单放行真落盘）；.vue 源码仅留档。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(dataDir, 'upgrades');
const VERSION = 'v1.5.9';
const LIVE_DIST = '202609220406'; // 生产当前服务的 dist（index-CAb0QGc9.js 已与 http://localhost:3000/ 核对一致）
const NEW_DIST = '202609220528';
const FILES = [
  'server/db.js',
  'server/routes/vibeRoutes.js',
  'web/src/components/VibeVoiceTab.vue', // 留档（apply 只落 web/dist/ 与 server/）
];
const hashBuf = (b) => crypto.createHash('sha256').update(b).digest('hex');
function localTs() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const distRoot = path.join(ROOT, 'web', 'dist');
const liveDir = path.join(distRoot, LIVE_DIST);
const newDir = path.join(distRoot, NEW_DIST);
if (!fs.existsSync(path.join(liveDir, 'index.html'))) throw new Error('线上 dist 目录不存在：' + LIVE_DIST);
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

// 差分 dist：新构建里与线上不同/线上没有的文件，写进线上目录名（原地覆盖 + 补新 hash 文件）
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
  const livePath = path.join(liveDir, rel);
  let same = false;
  try { same = fs.existsSync(livePath) && hashBuf(fs.readFileSync(livePath)) === hashBuf(nb); } catch { same = false; }
  if (!same) { entries.push({ name: `web/dist/${LIVE_DIST}/${rel}`, data: nb }); distDiff++; }
}

const now = new Date();
const meta = {
  version: VERSION,
  title: '录音转写：列表新增撰写耗时/使用模型两列 + 手机播放修复',
  content: [
    '列表新增「撰写耗时」（点转写到出结果全程：排队+引擎加载+推理；老记录与未转写显示 —）与「使用模型」两列；',
    '修复手机端播放录音报错不出声：/vibe/audio 补 Range/206 + Content-Length（手机 Safari/webview 播放 <audio> 前发 Range 探测，纯 chunked 流被判无法播放；桌面 Chrome 宽容所以电脑正常）；',
    '播放弹窗加错误提示与 webview 自动播放兜底；vibe_records 表加 run_ms/elapsed_ms 两列（应用后自动迁移）。',
  ].join('\n'),
  dist: LIVE_DIST, files: manifest, dist_files: distDiff,
  created_at: now.toISOString(), created_by: 'admin',
};
const statusText = { new: '新增', changed: '修改', unchanged: '未变更' };
const md = [
  `# 升级包 ${VERSION}`, '',
  `- 标题：${meta.title}`,
  `- 时间：${now.toLocaleString('zh-CN')}`,
  `- 服务端文件：${manifest.length} 个（db.js 加列迁移 + vibeRoutes.js）`,
  `- 前端差分：${distDiff} 个文件（构建 ${NEW_DIST}，写入线上目录 ${LIVE_DIST} 原地覆盖）`, '',
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

console.log(`升级包已生成: ${pkgName}（${(zipBuf.length / 1024).toFixed(0)} KB，源码 ${manifest.length} + dist 差分 ${distDiff} 个文件）`);
console.log(`位置: ${path.join(PKG_DIR, pkgName)}`);
