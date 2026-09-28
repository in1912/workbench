// v1.6.23 升级包（= v1.6.20/21 全部内容 + 两项新增）：
//   ①彻底修复设备控制「设备不存在」误报：官方 ha_xiaomi_home 源码证实该通道 prop/set 项级 code 不可靠
//     （同端点官方实现不检查项级 code；实测两台设备命令执行成功仍返回 code 1）→ 改为信封判定 + 下发后
//     回读校验（700ms/1800ms 两次），回读不符才报失败并带出当前值。
//   ②温湿度计卡片直显温度/湿度（用户需求）：buildHomeView 对 temperature/humidity 类传感器批量读
//     temperature / relative-humidity 属性，卡片显示「23.5°C · 45%」。
//   含 v1.6.20 的「摄像头二次验证」tab 与 v1.6.21 的 rawApi 拆分。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(dataDir, 'upgrades');
const LIVE_DIST = '202609220406';
const BASE_DIST = '202609281644'; // v1.6.20/21 已上线的构建
const NEW_DIST = '202609281655';

const FILES = [
  'server/services/micamLogin.js',    // 新增（v1.6.20）：小米账号密码登录 + 短信/邮件安全验证
  'server/services/mihomeService.js', // prop/set 回读校验 + 温湿度批量读 + did 数字化 + rawApi 拆分
  'server/routes/mihomeRoutes.js',    // prop/set 判定重写 + /micam/login|verify|inject-target
  'server/auth.js',                   // verify tab 路径归属
  'web/src/tabs.js',                  // 摄像头二次验证 tab 项
  'web/src/views/SmartHome.vue',      // 新 tab + 卡片温湿度直显 + 控制失败回读兜底
  'data/test-mihome-api.js',          // 测试（40 项）
  'data/test-mihome-ui.js',           // 测试（17 项）
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
  version: 'v1.6.23',
  title: '修复设备控制误报「设备不存在」（回读校验）+ 温湿度计卡片直显 + 摄像头二次验证 tab',
  content: [
    '修复（用户实测反馈的根因收口）：控制设备提示「设备不存在」但设备实际已被控制、界面回退后同值重复下发（表现为「开关只能点一次」）。对照官方 ha_xiaomi_home 源码确认：OAuth 通道 /app/v2/miotspec/prop/set 的响应项级 code 不可靠（官方实现同端点不检查项级 code；实测两台不同设备命令均执行成功、项级却一律返回 code 1）。修复：成功判定以外层信封为准，下发后 700ms/1800ms 两次回读设备真实值校验——回读一致报「已下发并确认」，不符才报失败并显示当前实际值；前端另有失败 1s 后回读兜底，界面不再与设备脱节。',
    '新增：温湿度计卡片直接显示温度/湿度（如「23.5°C · 45%」），随设备列表缓存/刷新自动更新（用户需求）。仅 temperature/humidity 类传感器挂载，网关等设备自带温度属性不受影响。',
    '新增：「摄像头二次验证」tab（智能家居页）——把小米账号密码登录换凭证集成进页面，支持图片验证码与手机短信/邮件安全验证码，替代原独立工具的手工流程。密码仅在本地实例（localhost）输入、仅内存换凭证，不保存、不经过生产服务器；生产站点该 tab 显示操作引导（一键打开本机页面）。注入目标默认 localhost，也可注入本机。',
    '测试：API 40 项 / UI 17 项全过（本地）。',
  ].join('\n'),
  dist: LIVE_DIST, files: manifest, dist_files: distDiff,
  created_at: now.toISOString(), created_by: 'admin',
};
const zipBuf = buildZip([
  { name: 'UPGRADE.md', data: ['# 升级包 v1.6.23', '',
    `- 标题：${meta.title}`, `- 时间：${now.toLocaleString('zh-CN')}`,
    `- 源码：${manifest.length} 个`, `- 前端差分：${distDiff} 个文件（构建 ${NEW_DIST}，基线 ${BASE_DIST}）`, '',
    '## 验证要点', '',
    '1. 智能家居 → 开关设备：连续点开/关应提示「已下发并确认」，不再出现「设备不存在」',
    '2. 温湿度计卡片显示「xx°C · xx%」；点「刷新」更新数值',
    '3. 摄像头二次验证 tab：生产显示引导；localhost:3000 显示登录表单', ''].join('\n') },
  { name: 'manifest.json', data: JSON.stringify(meta, null, 2) },
  ...entries,
]);
if (!fs.existsSync(PKG_DIR)) fs.mkdirSync(PKG_DIR, { recursive: true });
const zipName = `${localTs()}_v1.6.23.zip`;
fs.writeFileSync(path.join(PKG_DIR, zipName), zipBuf);
db.prepare(
  `INSERT INTO upgrade_logs(version,title,content,file_count,package_name,package_size,files_json,created_by,source)
   VALUES(?,?,?,?,?,?,?,?, 'package')`
).run(meta.version, meta.title, meta.content, meta.files.length, zipName, zipBuf.length,
  JSON.stringify(meta.files.map((m) => ({ path: m.path, size: m.size, status: m.status }))), 'admin');
for (const m of manifest) baseline.files[m.path] = m.hash;
baseline.updated_at = now.toISOString();
setSetting(db, 'upgrade_baseline', baseline);
setSetting(db, 'current_version', 'v1.6.23');
console.log(`已生成 ${zipName}（${(zipBuf.length / 1024).toFixed(0)} KB，源码 ${manifest.length} + dist 差分 ${distDiff}）`);
