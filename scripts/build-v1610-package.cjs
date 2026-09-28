// v1.6.10 升级包：修复米家换令牌协议（对齐官方 MIoTOauthClient）
//   两个坑（逐层实测定位）：
//   1) get_token 参数必须整体序列化为 JSON 放进唯一的 data= 查询参数——平铺传参小米回 invalid params；
//   2) client_id 2882303761520251711 是 19 位大整数，超出 JS Number 安全范围，Number() 会把尾数
//      吃成 ...2000（小米回 96003 invalid client）→ 手拼 JSON 以原始数字字面量写入。
//   另修复：刷新令牌的 redirect_uri 必须与原授权一致（原实现拼了 get_token 地址，是错的），刷新数据不带 device_id。
//   验证轨迹：假 code + 平铺参数 → invalid params；+ data=JSON 但 client_id 丢精度 → 96003 invalid client；
//   + 精确 client_id → 96013 invalid authorization code（协议全对，只等真实 code）。
//   仅改 server/services/mihomeService.js，无前端变更（dist 差分 0）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(dataDir, 'upgrades');
const LIVE_DIST = '202609220406'; // 生产当前服务的 dist 目录名（写入目标）
const BASE_DIST = '202609280929'; // 生产现状对应的本地构建目录（v1.6.9 构建）
const NEW_DIST = '202609280929';  // 本次无前端变更，沿用同一构建

const FILES = [
  'server/services/mihomeService.js', // 本次唯一修改
  'server/routes/mihomeRoutes.js',    // 留档（未变）
  'server/index.js',                  // 留档（未变）
  'server/auth.js',                   // 留档（未变）
  'web/src/views/SmartHome.vue',      // 留档（未变）
  'web/src/tabs.js',                  // 留档（未变）
  'web/src/nav.js',                   // 留档（未变）
  'web/src/router/index.js',          // 留档（未变）
];

const hashBuf = (b) => crypto.createHash('sha256').update(b).digest('hex');
function localTs() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const distRoot = path.join(ROOT, 'web', 'dist');
if (!fs.existsSync(path.join(distRoot, NEW_DIST, 'index.html'))) throw new Error('dist 目录不存在：' + NEW_DIST);

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
  version: 'v1.6.10',
  title: '修复米家换令牌协议：data=JSON 参数与 client_id 大整数精度',
  content: [
    '问题：v1.6.9 手动回填后小米返回「换取访问令牌失败 invalid params」。',
    '根因一：官方 get_token 要求把 client_id/redirect_uri/code/device_id 整体序列化为 JSON、放进唯一的 data= 查询参数，平铺传参一律 invalid params。',
    '根因二：client_id 为 19 位大整数，超出 JavaScript Number 安全整数范围，数值化后尾数丢失（…1711 → …2000），小米回 96003 invalid client；改为手拼 JSON 保留精确位数。',
    '顺带修复：刷新令牌（refresh_token）的 redirect_uri 须与原授权一致（原实现误拼 get_token 地址），且刷新请求不带 device_id——均对齐官方 MIoTOauthClient。',
    '实测验证：假授权码在修复后返回 96013 invalid authorization code（客户端与参数均已通过校验，仅授权码本身无效），协议链路正确。',
    '无前端变更，不改动既有业务数据。',
  ].join('\n'),
  dist: LIVE_DIST, files: manifest, dist_files: 0,
  created_at: now.toISOString(), created_by: 'admin',
};
const zipBuf = buildZip([
  { name: 'UPGRADE.md', data: ['# 升级包 v1.6.10', '',
    `- 标题：${meta.title}`, `- 时间：${now.toLocaleString('zh-CN')}`,
    `- 源码：${manifest.filter((m) => m.status === 'changed').length} 个修改（mihomeService.js），${manifest.length - 1} 个留档`,
    '- 前端：无变更（dist 差分 0）', '',
    '## 绑定步骤不变', '',
    '生成授权二维码 → 浏览器授权 → 复制打不开页面的地址栏网址 → 粘贴回填「完成绑定」。', '',
    '## 文件清单', '',
    ...manifest.map((m) => `- ${m.path}（${statusText[m.status]}，${m.size}B）`), ''].join('\n') },
  { name: 'manifest.json', data: JSON.stringify(meta, null, 2) },
  ...entries,
]);
if (!fs.existsSync(PKG_DIR)) fs.mkdirSync(PKG_DIR, { recursive: true });
const zipName = `${localTs()}_v1.6.10.zip`;
fs.writeFileSync(path.join(PKG_DIR, zipName), zipBuf);
db.prepare(
  `INSERT INTO upgrade_logs(version,title,content,file_count,package_name,package_size,files_json,created_by,source)
   VALUES(?,?,?,?,?,?,?,?, 'package')`
).run(meta.version, meta.title, meta.content, meta.files.length, zipName, zipBuf.length,
  JSON.stringify(meta.files.map((m) => ({ path: m.path, size: m.size, status: m.status }))), 'admin');
for (const m of manifest) baseline.files[m.path] = m.hash;
baseline.updated_at = now.toISOString();
setSetting(db, 'upgrade_baseline', baseline);
setSetting(db, 'current_version', 'v1.6.10');
console.log(`已生成 ${zipName}（${(zipBuf.length / 1024).toFixed(0)} KB，源码 ${manifest.length}，dist 差分 0）`);
