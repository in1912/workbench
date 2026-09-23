// v1.6.2 升级包构建：私有项目页 + 剪贴板采集三件套 + 智作平台嵌入 + Material Icons 单色图标。
// 两段式发布（生产当前白名单不含 zhizu/，主包里的 zhizu 条目会被跳过）：
//   ① pre 包：仅 server/routes/upgradeRoutes.js（应用白名单加入 zhizu/）——先上，旧通道即可应用；
//   ② 主包：其余全部 + zhizu 运行时（server 源码 + web/dist + package.json，data/ 永不入包）。
// 差分模式：新 dist 202609230417 与生产现状（= v1.6.1 构建目录 202609230342）对比，
// 变更文件写进线上目录 202609220406 原地覆盖。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(dataDir, 'upgrades');
const LIVE_DIST = '202609220406';  // 生产当前服务的 dist 目录名（写入目标，v1.5.9 起被多包原地覆盖）
const BASE_DIST = '202609230342'; // 生产现状对应的本地构建目录（对比基线 = v1.6.1 的新构建）
const NEW_DIST = '202609230417';  // 本次新构建（四项需求前端）
const FILES = [
  'server/index.js',                    // 挂载 /zhizu 反向代理（express.json 之前）+ 采集端点免登录
  'server/auth.js',                     // PAGES/private 页 + /api/dep|pro|mbti 归 private + TAB_PATHS 迁移
  'server/db.js',                       // clipboard_items.device 列、clipboard_devices 表、两项一次性迁移
  'server/routes/core.js',              // 剪贴板采集：脚本三件套下发 + agent-register/push + 设备列表
  'server/services/zhizuService.js',    // 智作平台子进程 + /zhizu 反向代理（路径还原，DATA_DIR 命名空间化）
  'web/src/tabs.js',                    // tools 增 zhizu 首位/移除三测评；private 三 tab
  'web/src/nav.js',                     // Material Icons 图标名 + 私有项目入口
  'web/src/router/index.js',            // /private 路由
  'web/src/App.vue',                    // 侧边栏图标改 material-icons 字体
  'web/src/style.css',                  // .ico 字体图标尺寸
  'web/src/views/Tools.vue',            // 智作平台 iframe tab + 剪贴板下载按钮/设备列表/来源电脑显示
  'web/src/views/Private.vue',          // 新页：三大测评中心
  'web/src/views/Settings.vue',         // 页面排序图标渲染
  'web/src/components/PermTable.vue',   // 权限表图标渲染
  'web/index.html',                     // 图标字体样式表
];
const ZHIZU_FILES = [
  'zhizu/package.json',
  'zhizu/server/index.js',
  'zhizu/server/db.js',
  'zhizu/server/features.js',
  'zhizu/server/featureTables.js',
  'zhizu/server/sensitiveSeed.js',
  'zhizu/server/xlsx.js',
  'zhizu/server/routes/authRoutes.js',
  'zhizu/server/routes/configRoutes.js',
  'zhizu/server/routes/genRoutes.js',
  'zhizu/server/routes/hotRoutes.js',
  'zhizu/server/routes/sensitiveRoutes.js',  // v1.6.2-fix1 补漏：顶层 require 缺它子进程秒崩（容器 503 根因）
  'zhizu/server/services/aiService.js',
  'zhizu/server/services/cryptoUtil.js',
  'zhizu/server/services/hotService.js',
  'zhizu/server/services/topicScheduler.js',
  'zhizu/server/services/topicService.js',
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
const statusText = { new: '新增', changed: '修改', unchanged: '未变更' };
function manifestOf(rels) {
  return rels.map((rel) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) throw new Error(`文件不存在：${rel}`);
    const data = fs.readFileSync(abs);
    const hash = hashBuf(data);
    const old = (baseline.files || {})[rel];
    return { path: rel, size: data.length, hash, status: !old ? 'new' : old === hash ? 'unchanged' : 'changed' };
  });
}
function writeZip(name, meta, md, entries) {
  const zipBuf = buildZip([{ name: 'UPGRADE.md', data: md }, { name: 'manifest.json', data: JSON.stringify(meta, null, 2) }, ...entries]);
  if (!fs.existsSync(PKG_DIR)) fs.mkdirSync(PKG_DIR, { recursive: true });
  fs.writeFileSync(path.join(PKG_DIR, name), zipBuf);
  db.prepare(
    `INSERT INTO upgrade_logs(version,title,content,file_count,package_name,package_size,files_json,created_by,source)
     VALUES(?,?,?,?,?,?,?,?, 'package')`
  ).run(meta.version, meta.title, meta.content, meta.files.length, name, zipBuf.length,
    JSON.stringify(meta.files.map((m) => ({ path: m.path, size: m.size, status: m.status }))), 'admin');
  for (const m of meta.files) baseline.files[m.path] = m.hash;
  console.log(`已生成 ${name}（${(zipBuf.length / 1024).toFixed(0)} KB，清单 ${meta.files.length} + 运行时 ${meta.runtime_files || 0} 个文件）`);
  return zipBuf;
}

// ---------- ① pre 包：升级通道白名单扩展（必须先应用，主包 zhizu/ 条目才能落盘） ----------
const now = new Date();
const preManifest = manifestOf(['server/routes/upgradeRoutes.js']);
const preMeta = {
  version: 'v1.6.2-pre', title: '升级通道预置：应用白名单允许 zhizu/ 目录（智作平台前置）',
  content: '为 v1.6.2「智作平台」子服务进容器做准备：升级包应用白名单新增 zhizu/ 前缀（其数据库走子进程 DATA_DIR=/data/zhizu 持久卷，data/ 子目录永不入包）。仅此一个文件，先于 v1.6.2 主包应用。',
  files: preManifest, created_at: now.toISOString(), created_by: 'admin',
};
const preMd = [
  `# 升级包 v1.6.2-pre`, '',
  `- 标题：${preMeta.title}`, `- 时间：${now.toLocaleString('zh-CN')}`, '',
  '## 说明', '', preMeta.content, '',
  ...preManifest.map((m) => `- ${m.path}（${statusText[m.status]}，${m.size}B）`), '',
].join('\n');
writeZip(`${localTs()}_v1.6.2-pre.zip`, preMeta, preMd, preManifest.map((m) => ({ name: m.path, data: fs.readFileSync(path.join(ROOT, m.path)) })));

// ---------- ② 主包 ----------
const manifest = manifestOf(FILES);
const entries = manifest.map((m) => ({ name: m.path, data: fs.readFileSync(path.join(ROOT, m.path)) }));

// 智作平台运行时：server 源码 + package.json 入清单；web/dist 整树入包（首装全量）
const zhizuManifest = manifestOf(ZHIZU_FILES);
for (const m of zhizuManifest) entries.push({ name: m.path, data: fs.readFileSync(path.join(ROOT, m.path)) });
const listFiles = (dir, rel, out) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) listFiles(path.join(dir, ent.name), r, out);
    else out.push(r);
  }
};
const zhizuDist = [];
listFiles(path.join(ROOT, 'zhizu', 'web', 'dist'), '', zhizuDist);
for (const rel of zhizuDist) entries.push({ name: `zhizu/web/dist/${rel}`, data: fs.readFileSync(path.join(ROOT, 'zhizu', 'web', 'dist', rel)) });

// 差分 dist：新构建与生产现状（基线目录）不同/缺的文件，写进生产服务的目录名（原地覆盖）
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

const meta = {
  version: 'v1.6.2',
  title: '私有项目页 + 剪贴板采集三件套 + 智作平台嵌入 + 全站单色图标',
  content: [
    '新增「私有项目」模块：抑郁测试、心理测试、职业测试三大测评中心自「效率工具」迁入（旧地址 /tools?tab=dep 等自动回落，权限与角色授权一并迁移）。',
    '剪贴板采集：管理员可一键下载三件套——采集脚本(ps1)、安装批处理(bat)、卸载批处理(bat)，双击安装到 %LOCALAPPDATA%\\WorkbenchClipboard 并开机自启（无需管理员权限）；脚本按下载来源（IP 或域名）自动内嵌服务器地址；页面显示已登记电脑的在线状态、最近上报与累计推送，剪贴板内容前标注来源电脑与时间；同机同内容 10 分钟内自动去重。',
    '智作平台（文案库）整体嵌入「效率工具」第一个 tab：随工作台进程自动启动（内部 127.0.0.1:9608，对外只走同源 /zhizu 反向代理，不开新端口），自带登录与 admin/user/guest 角色体系；生产首次启动为全新库（默认 admin/admin123，登录后请改密）。',
    '全站图标改 Material Icons 单色字体（本地化 web/public/material-icons，无外链）：侧边栏、设置页排序、权限表统一替换彩色 emoji，随文字颜色渲染。',
  ].join('\n'),
  dist: LIVE_DIST, files: [...manifest, ...zhizuManifest], dist_files: distDiff,
  runtime_files: zhizuDist.length,
  created_at: now.toISOString(), created_by: 'admin',
};
const md = [
  `# 升级包 v1.6.2`, '',
  `- 标题：${meta.title}`,
  `- 时间：${now.toLocaleString('zh-CN')}`,
  `- 前端源码留档：${manifest.length} 个；智作平台运行时：源码 ${zhizuManifest.length} + dist ${zhizuDist.length} 个`,
  `- 前端差分：${distDiff} 个文件（构建 ${NEW_DIST}，对比基线 ${BASE_DIST}=生产现状，写入线上目录 ${LIVE_DIST} 原地覆盖）`,
  `- 部署顺序：先应用 v1.6.2-pre（白名单），再应用本包`, '',
  '## 升级内容', '',
  meta.content, '',
  '## 文件清单', '',
  ...[...manifest, ...zhizuManifest].map((m) => `- ${m.path}（${statusText[m.status]}，${m.size}B）`),
  `- zhizu/web/dist/**（${zhizuDist.length} 个构建产物）`,
  '',
].join('\n');
writeZip(`${localTs()}_v1.6.2.zip`, meta, md, entries);

baseline.updated_at = now.toISOString();
setSetting(db, 'upgrade_baseline', baseline);
setSetting(db, 'current_version', 'v1.6.2');
