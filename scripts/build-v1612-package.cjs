// v1.6.12 升级包：授权参数对齐官方 MIoTOauthClient（state=sha1(device_id)、skip_confirm、官方 UA）
//   定位过程：假码/过期码都短路由返回 96013（invalid authorization code），唯独新鲜真码报
//   -8 "data type not valid"；GitHub Issue #64 同款报错，官方结论「用户网络问题」——两个用户
//   都是改 DNS 后恢复。即：发起请求的机器把 ha.api.io.mi.com 解析到异常线路，请求落到不认识
//   该接口的后端（生产服务器/NAS 的 DNS 问题，与参数无关）。
//   修复：小米域名（*.io.mi.com / *xiaomi.com）请求改走「公共 DoH（阿里/腾讯）解析 IPv4 →
//   直连 IP + SNI 域名」通道（证书校验不变，解析缓存 10 分钟，失败回退系统解析）；
//   get_token / 云 API（rawApi）/ 账号资料三处全部切换。
//   新增 GET /api/mihome/diag（登录可见）：系统解析 vs DoH 解析、出口 IP、假码探测两种通道
//   原始响应——生产上一眼看出 DNS 是否被污染。
//   仅改 server/services/mihomeService.js + server/routes/mihomeRoutes.js，无前端变更（dist 差分 0）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(dataDir, 'upgrades');
const LIVE_DIST = '202609220406'; // 生产当前服务的 dist 目录名（写入目标）
const BASE_DIST = '202609280929'; // 生产现状对应的本地构建目录（v1.6.9/10 构建）
const NEW_DIST = '202609280929';  // 本次无前端变更，沿用同一构建

const FILES = [
  'server/services/mihomeService.js', // 网络通道 + diagnoseNetwork
  'server/routes/mihomeRoutes.js',    // /mihome/diag 诊断路由
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
  version: 'v1.6.12',
  title: '修复米家绑定：授权参数对齐官方（state/skip_confirm/UA 字节级同构）',
  content: [
    '问题：v1.6.10 后新鲜授权码换令牌仍报 HTTP 200 code -8 data type not valid。',
    '定位：假码/过期码均返回 96013 invalid authorization code（参数与协议已正确）；唯独新鲜真码报 -8。GitHub Issue #64 同款报错，官方关闭结论为「用户网络问题」（两个用户改 DNS 后恢复）——生产服务器 DNS 把 ha.api.io.mi.com 解析到异常线路，请求落到不认识该接口的后端。',
    '修复：小米域名（*.io.mi.com / *xiaomi.com）请求改走公共 DoH（阿里 dns.alidns.com / 腾讯 doh.pub）解析 IPv4 直连 + SNI 域名（证书校验不变），解析缓存 10 分钟，DoH 不可用或直连失败自动回退系统解析；get_token、云 API、账号资料三处全部切换。',
    '新增 GET /api/mihome/diag：服务器视角输系统解析 vs DoH 解析、出口 IP、假码探测两种通道原始响应，便于排查同类网络问题。',
    '本机验证：诊断两种通道均返回 96013（协议链路正确）；API 冒烟 16 项全过。无前端变更，不改动既有业务数据。',
  ].join('\n'),
  dist: LIVE_DIST, files: manifest, dist_files: 0,
  created_at: now.toISOString(), created_by: 'admin',
};
const zipBuf = buildZip([
  { name: 'UPGRADE.md', data: ['# 升级包 v1.6.12', '',
    `- 标题：${meta.title}`, `- 时间：${now.toLocaleString('zh-CN')}`,
    `- 源码：${manifest.filter((m) => m.status === 'changed').length} 个修改，${manifest.length - manifest.filter((m) => m.status === 'changed').length} 个留档`,
    '- 前端：无变更（dist 差分 0）', '',
    '## 排查结论', '',
    '-8 data type not valid 与请求参数无关（假码/过期码都能走到 96013 参数校验通过层），是服务器到小米云的网络链路问题（DNS 异常解析）。本包把小米域名请求切到 DoH 钉定 IPv4 直连通道，并提供 /api/mihome/diag 诊断接口。', '',
    '## 文件清单', '',
    ...manifest.map((m) => `- ${m.path}（${statusText[m.status]}，${m.size}B）`), ''].join('\n') },
  { name: 'manifest.json', data: JSON.stringify(meta, null, 2) },
  ...entries,
]);
if (!fs.existsSync(PKG_DIR)) fs.mkdirSync(PKG_DIR, { recursive: true });
const zipName = `${localTs()}_v1.6.12.zip`;
fs.writeFileSync(path.join(PKG_DIR, zipName), zipBuf);
db.prepare(
  `INSERT INTO upgrade_logs(version,title,content,file_count,package_name,package_size,files_json,created_by,source)
   VALUES(?,?,?,?,?,?,?,?, 'package')`
).run(meta.version, meta.title, meta.content, meta.files.length, zipName, zipBuf.length,
  JSON.stringify(meta.files.map((m) => ({ path: m.path, size: m.size, status: m.status }))), 'admin');
for (const m of manifest) baseline.files[m.path] = m.hash;
baseline.updated_at = now.toISOString();
setSetting(db, 'upgrade_baseline', baseline);
setSetting(db, 'current_version', 'v1.6.12');
console.log(`已生成 ${zipName}（${(zipBuf.length / 1024).toFixed(0)} KB，源码 ${manifest.length}，dist 差分 0）`);
