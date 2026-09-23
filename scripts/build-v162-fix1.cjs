// v1.6.2-fix1 微补丁：补齐 v1.6.2 主包遗漏的 zhizu/server/routes/sensitiveRoutes.js。
// 根因：zhizu/server/index.js 顶层 require('./routes/sensitiveRoutes')，主包 ZHIZU_FILES
// 清单漏列该文件 → 容器内子进程启动即 Cannot find module → 连崩 6 次后 zhizuService 放弃
// 拉起 → /zhizu/ 永久 503。本地 zhizu/ 文件齐全故冒烟未暴露。
// 生产白名单已含 zhizu/（v1.6.2-pre 已应用），单文件包可直接落盘；apply 自带 gracefulRestart，
// 容器重启后 zhizuService 全新 start() → 子进程带全文件引导。
const fs = require('fs');
const path = require('path');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');

const FILES = [
  'zhizu/server/routes/sensitiveRoutes.js', // 补漏：顶层 require 缺它子进程秒崩（503 根因）
  'zhizu/server/index.js',                  // listen 绑定 ZHIZU_HOST（嵌入时仅 127.0.0.1，不对局域网开口）
  'server/services/zhizuService.js',        // spawn 传 ZHIZU_HOST=127.0.0.1
];
const VERSION = 'v1.6.2-fix1';

function localTs() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const crypto = require('crypto');
const hashBuf = (b) => crypto.createHash('sha256').update(b).digest('hex');
const baseline = getSetting(db, 'upgrade_baseline', { files: {}, updated_at: null });

const now = new Date();
const manifest = FILES.map((rel) => {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) throw new Error('文件不存在：' + rel);
  const data = fs.readFileSync(abs);
  const hash = hashBuf(data);
  return { path: rel, size: data.length, hash, status: 'new' };
});
const meta = {
  version: VERSION,
  title: '智作平台补漏：sensitiveRoutes.js（/zhizu/ 503 根因修复）',
  content: 'v1.6.2 主包遗漏 zhizu/server/routes/sensitiveRoutes.js（文案审查路由），子进程顶层 require 缺文件启动即崩，/zhizu/ 持续 503。本包补齐该文件，应用重启后智作平台子服务应正常监听。',
  files: manifest, created_at: now.toISOString(), created_by: 'admin',
};
const md = [
  `# 升级包 ${VERSION}`, '',
  `- 标题：${meta.title}`, `- 时间：${now.toLocaleString('zh-CN')}`, '',
  '## 说明', '', meta.content, '',
  ...manifest.map((m) => `- ${m.path}（新增，${m.size}B）`), '',
].join('\n');

const zipBuf = buildZip([
  { name: 'UPGRADE.md', data: md },
  { name: 'manifest.json', data: JSON.stringify(meta, null, 2) },
  ...manifest.map((m) => ({ name: m.path, data: fs.readFileSync(path.join(ROOT, m.path)) })),
]);
const pkgDir = path.join(dataDir, 'upgrades');
if (!fs.existsSync(pkgDir)) fs.mkdirSync(pkgDir, { recursive: true });
const name = `${localTs()}_${VERSION}.zip`;
fs.writeFileSync(path.join(pkgDir, name), zipBuf);
db.prepare(
  `INSERT INTO upgrade_logs(version,title,content,file_count,package_name,package_size,files_json,created_by,source)
   VALUES(?,?,?,?,?,?,?,?, 'package')`
).run(VERSION, meta.title, meta.content, manifest.length, name, zipBuf.length,
  JSON.stringify(manifest.map((m) => ({ path: m.path, size: m.size, status: m.status }))), 'admin');
for (const m of manifest) baseline.files[m.path] = m.hash;
baseline.updated_at = now.toISOString();
setSetting(db, 'upgrade_baseline', baseline);
setSetting(db, 'current_version', VERSION);
console.log(`已生成 ${name}（${(zipBuf.length / 1024).toFixed(0)} KB，${manifest.length} 个文件）：${path.join(pkgDir, name)}`);
