// v1.6.15 升级包：米家参数中文化（详情页翻译 + 参数翻译 tab）+ 家庭/设备持久缓存
//   需求（2026-09-28 用户）：① 设备详情页都是英文参数，加一套中英对照翻译，并开「参数翻译」tab 展示词典；
//   ② 每次进页面都提示「正在从米家云拉取家庭与设备…」，改为持久缓存 + 刷新按钮，不必每次都拉云端。
//   server：mihomeService.js（homeView 持久缓存 settings 键 mihome_homeview_cache：命中秒回、
//           超 5 分钟后台静默更新、fresh=1 强制拉云端；unbind 清缓存；updateCachedSwitchValue 开关写入同步缓存）
//           mihomeRoutes.js（prop/set 成功后同步缓存值）
//   web：SmartHome.vue（详情页服务/属性/动作/事件/枚举值中文名：优先 spec 中文描述，其次词典；
//         新增「参数翻译」tab：五组中英对照词典，可搜索；tab 栏入口）
//        miotTerms.js（新增词典 ~280 词条）、tabs.js（smarthome 增 terms tab）
//   dist 差分：新构建 202609281040 对比基线 202609281029（=生产现状 v1.6.14），写入线上目录 202609220406 原地覆盖。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(dataDir, 'upgrades');
const LIVE_DIST = '202609220406'; // 生产当前服务的 dist 目录名（写入目标）
const BASE_DIST = '202609281029'; // 生产现状对应的本地构建目录（v1.6.14 构建）
const NEW_DIST = '202609281040';  // 本次新构建

const FILES = [
  'server/services/mihomeService.js', // homeView 持久缓存 + updateCachedSwitchValue + unbind 清缓存
  'server/routes/mihomeRoutes.js',    // prop/set 成功后同步缓存
  'server/index.js',                  // 留档（未变）
  'server/auth.js',                   // 留档（未变）
  'web/src/views/SmartHome.vue',      // 详情页翻译 + 参数翻译 tab + tab 栏入口
  'web/src/miotTerms.js',             // 新增：MIoT 参数中英词典
  'web/src/tabs.js',                  // smarthome 增 terms tab
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
if (!fs.existsSync(path.join(distRoot, NEW_DIST, 'index.html'))) throw new Error('新 dist 目录不存在：' + NEW_DIST);
if (!fs.existsSync(path.join(distRoot, BASE_DIST, 'index.html'))) throw new Error('基线 dist 目录不存在：' + BASE_DIST);

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
  version: 'v1.6.15',
  title: '米家参数中文化（详情页翻译 + 参数翻译词典 tab）+ 家庭/设备持久缓存秒开',
  content: [
    '参数翻译：设备详情页的服务/属性/动作/事件/枚举值自动显示中文名（优先用厂商 spec 自带的中文描述，其次查内置词典，括注英文原文），不再是一屏英文。',
    '新增「参数翻译」tab：服务/属性/动作/枚举值/规格术语五组中英对照词典（约 280 词条），支持搜索过滤。',
    '持久缓存：家庭/房间/设备列表落库缓存，进入页面立即显示（不再每次都显示「正在从米家云拉取…」）；缓存超过 5 分钟在后台静默更新，下次进入即为新数据。',
    '「刷新」按钮强制从米家云重新拉取并更新缓存；在本页开关设备成功后缓存同步最新状态。',
    '解绑时清空设备缓存，避免换账号后显示旧设备；令牌存储与加密逻辑不变。',
  ].join('\n'),
  dist: LIVE_DIST, files: manifest, dist_files: distDiff,
  created_at: now.toISOString(), created_by: 'admin',
};
const zipBuf = buildZip([
  { name: 'UPGRADE.md', data: ['# 升级包 v1.6.15', '',
    `- 标题：${meta.title}`, `- 时间：${now.toLocaleString('zh-CN')}`,
    `- 源码：${manifest.length} 个（2 个服务端修改 + 1 个新增词典，6 个留档）`,
    `- 前端差分：${distDiff} 个文件（构建 ${NEW_DIST}，对比基线 ${BASE_DIST}=生产现状 v1.6.14，写入线上目录 ${LIVE_DIST} 原地覆盖）`, '',
    '## 变更点', '',
    '1. 详情页中文化：spec 描述是中文则直接用（厂商原文更精确），否则查 miotTerms.js 词典，最后回退英文原文。',
    '2. 「参数翻译」tab：完整词典可搜索；详情页与词典共用同一份数据。',
    '3. 设备列表持久缓存：settings 表键 mihome_homeview_cache；命中秒回 + 5 分钟后台静默更新 + 刷新按钮 fresh=1 强制拉云端。',
    '', '## 文件清单', '',
    ...manifest.map((m) => `- ${m.path}（${statusText[m.status]}，${m.size}B）`),
    `- web/dist/${LIVE_DIST}/**（差分 ${distDiff} 个）`, ''].join('\n') },
  { name: 'manifest.json', data: JSON.stringify(meta, null, 2) },
  ...entries,
]);
if (!fs.existsSync(PKG_DIR)) fs.mkdirSync(PKG_DIR, { recursive: true });
const zipName = `${localTs()}_v1.6.15.zip`;
fs.writeFileSync(path.join(PKG_DIR, zipName), zipBuf);
db.prepare(
  `INSERT INTO upgrade_logs(version,title,content,file_count,package_name,package_size,files_json,created_by,source)
   VALUES(?,?,?,?,?,?,?,?, 'package')`
).run(meta.version, meta.title, meta.content, meta.files.length, zipName, zipBuf.length,
  JSON.stringify(meta.files.map((m) => ({ path: m.path, size: m.size, status: m.status }))), 'admin');
for (const m of manifest) baseline.files[m.path] = m.hash;
baseline.updated_at = now.toISOString();
setSetting(db, 'upgrade_baseline', baseline);
setSetting(db, 'current_version', 'v1.6.15');
console.log(`已生成 ${zipName}（${(zipBuf.length / 1024).toFixed(0)} KB，源码 ${manifest.length} + dist 差分 ${distDiff}）`);
