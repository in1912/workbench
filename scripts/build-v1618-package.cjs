// v1.6.18 升级包：监控诊断接口（探查 device_list_page 原始条目是否含摄像头云端截图/缩略图 URL）
//   背景：监控直播被小米云端转码拦住（m3u8 恒 404），用户问「连截图都获取不了吗」并指出 HA 也能拿截图。
//   已核实：HA 官方 OAuth 集成无摄像头功能；能出截图的 hass-xiaomi-miot 走密码登录换 serviceToken。
//   本包加一条免登录脱敏诊断路由 GET /mihome/debug/camraw：拉 device_list_page 原始摄像头条目回显，
//   验证米家 App 首页摄像头卡片的缩略图是否来自本 OAuth 通道可见字段（若是 → 免密实现「最近画面」卡片）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(dataDir, 'upgrades');
const LIVE_DIST = '202609220406'; // 生产当前服务的 dist 目录名（前端无变更，不写 dist）
const DIST = '202609281327';      // 当前最新前端构建（仅用于校验存在）

const FILES = [
  'server/services/mihomeService.js', // 新增 debugCameraRaw + debugScrub（脱敏探测）
  'server/routes/mihomeRoutes.js',    // 新增 GET /mihome/debug/camraw
];

const hashBuf = (b) => crypto.createHash('sha256').update(b).digest('hex');
function localTs() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

if (!fs.existsSync(path.join(ROOT, 'web', 'dist', DIST, 'index.html'))) throw new Error('前端构建目录不存在：' + DIST);

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

const now = new Date();
const meta = {
  version: 'v1.6.18',
  title: '监控诊断：摄像头云端字段探测（免密截图可行性验证）',
  content: [
    '直播被小米云端转码拦截（m3u8 恒 404）后，追加验证「截图」路线：新增诊断接口 GET /api/mihome/debug/camraw，拉取 device_list_page 摄像头条目的原始完整字段（脱敏输出），确认米家 App 首页摄像头卡片缩略图是否走本 OAuth 通道可见字段。若存在可用图片 URL，下一步免密实现监控卡片「最近画面」展示。',
    '无前端变更；接口仅登录可访问，输出剥离 token/secret/key 类字段。',
  ].join('\n'),
  dist: LIVE_DIST, files: manifest, dist_files: 0,
  created_at: now.toISOString(), created_by: 'admin',
};
const zipBuf = buildZip([
  { name: 'UPGRADE.md', data: ['# 升级包 v1.6.18', '',
    `- 标题：${meta.title}`, `- 时间：${now.toLocaleString('zh-CN')}`,
    `- 源码：${manifest.length} 个（服务端 2 个修改，无前端变更）`, '',
    '## 变更点', '',
    '1. mihomeService.js：debugCameraRaw（device_list_page 原始摄像头条目）+ debugScrub 脱敏。',
    '2. mihomeRoutes.js：GET /mihome/debug/camraw 诊断路由。', '',
    '## 文件清单', '',
    ...manifest.map((m) => `- ${m.path}（${statusText[m.status]}，${m.size}B）`), ''].join('\n') },
  { name: 'manifest.json', data: JSON.stringify(meta, null, 2) },
  ...entries,
]);
if (!fs.existsSync(PKG_DIR)) fs.mkdirSync(PKG_DIR, { recursive: true });
const zipName = `${localTs()}_v1.6.18.zip`;
fs.writeFileSync(path.join(PKG_DIR, zipName), zipBuf);
db.prepare(
  `INSERT INTO upgrade_logs(version,title,content,file_count,package_name,package_size,files_json,created_by,source)
   VALUES(?,?,?,?,?,?,?,?, 'package')`
).run(meta.version, meta.title, meta.content, meta.files.length, zipName, zipBuf.length,
  JSON.stringify(meta.files.map((m) => ({ path: m.path, size: m.size, status: m.status }))), 'admin');
for (const m of manifest) baseline.files[m.path] = m.hash;
baseline.updated_at = now.toISOString();
setSetting(db, 'upgrade_baseline', baseline);
setSetting(db, 'current_version', 'v1.6.18');
console.log(`已生成 ${zipName}（${(zipBuf.length / 1024).toFixed(0)} KB，源码 ${manifest.length}，无 dist 变更）`);
