// v1.6.3 升级包构建（两段式，照 v1.6.2-pre/主包 模式）：
//   ① pre 包：server/routes/upgradeRoutes.js —— 应用白名单加入 web/public/（旧容器没有此前缀，
//      测评中心 H5 一直停留在镜像内置版本；不先扩白名单，主包的 H5 运行时门禁文件会被静默跳过）
//   ② 主包：三大测评中心运行时门禁（服务端 /gate + H5 轮询锁定）+ 域名示例脱敏 + 效率工具默认
//      落点智作平台 + 标题/系统名兜底「工作台」+ 新库默认账号 admin/admin123 + vibeRoutes 客户端
//      模板回环化（上批遗留）。dist 差分：新构建 202609230625 对比基线 202609230417（=生产现状），
//      写入线上目录 202609220406 原地覆盖；web/public 全量入包（mbti/dep/pro H5 + material-icons）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(dataDir, 'upgrades');
const LIVE_DIST = '202609220406'; // 生产当前服务的 dist 目录名（写入目标）
const BASE_DIST = '202609230417'; // 生产现状对应的本地构建目录（v1.6.2 构建）
const NEW_DIST = '202609230625';  // 本次新构建

const FILES = [
  'server/index.js',                    // EXEMPT 免登录 /gate + （静态守卫不变）
  'server/auth.js',                     // 新库初始管理员默认 admin/admin123（原 admin/admin123）
  'server/db.js',                       // 注释示例脱敏
  'server/vibeasr/server.js',           // 注释域名脱敏
  'server/routes/misc.js',              // /system-info 默认名「工作台/Workbench」+ 版本回退 v1.6.3 + external-base 文案
  'server/routes/depRoutes.js',         // 抑郁中心：/gate 端点 + 分享前缀报错文案脱敏
  'server/routes/mbtiRoutes.js',        // 职业测试：同上
  'server/routes/proRoutes.js',         // 心理中心：同上
  'server/routes/vibeRoutes.js',        // 客户端引擎模板 base_url 回环化（上批遗留未发）
  'web/index.html',                     // <title>工作台</title>（消除旧名闪现）
  'web/src/sysname.js',                 // 系统名兜底「工作台/Workbench」
  'web/src/views/Tools.vue',            // 效率工具默认落点=智作平台
  'web/src/views/Settings.vue',         // placeholder 脱敏（张三/工作台）
  'web/src/views/MultiPanel.vue',       // 外网地址 placeholder 脱敏
  'web/src/components/TestCenterTab.vue', // 分享前缀 placeholder 脱敏 + 停用时禁用查看/复制链接
  'web/src/components/SslPanel.vue',    // CN placeholder + 场景说明脱敏
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
function listFiles(dir, rel, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) listFiles(path.join(dir, ent.name), r, out);
    else out.push(r);
  }
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
  console.log(`已生成 ${name}（${(zipBuf.length / 1024 / 1024).toFixed(1)} MB，清单 ${meta.files.length} + 运行时 ${meta.runtime_files || 0} 个文件）`);
  return zipBuf;
}
const now = new Date();

// ---------- ① pre 包：应用白名单扩展（必须先应用，主包 web/public 条目才能落盘） ----------
const preManifest = manifestOf(['server/routes/upgradeRoutes.js']);
const preMeta = {
  version: 'v1.6.3-pre', title: '升级通道预置：应用白名单允许 web/public/（测评中心 H5 前置）',
  content: '为 v1.6.3「测评中心运行时门禁」铺路：升级包应用端路径白名单新增 web/public/ 前缀。此前 H5 静态一直停留在镜像内置版本（旧白名单会静默跳过该前缀），本包仅 upgradeRoutes.js 一个文件，先于 v1.6.3 主包应用。',
  files: preManifest, created_at: now.toISOString(), created_by: 'admin',
};
writeZip(`${localTs()}_v1.6.3-pre.zip`, preMeta,
  ['# 升级包 v1.6.3-pre', '', `- 标题：${preMeta.title}`, `- 时间：${now.toLocaleString('zh-CN')}`, '', '## 说明', '', preMeta.content, '',
   ...preManifest.map((m) => `- ${m.path}（${statusText[m.status]}，${m.size}B）`), '',
   '- 部署顺序：先应用本包，再应用 v1.6.3 主包', ''].join('\n'),
  preManifest.map((m) => ({ name: m.path, data: fs.readFileSync(path.join(ROOT, m.path)) })));

// ---------- ② 主包 ----------
const manifest = manifestOf(FILES);
const entries = manifest.map((m) => ({ name: m.path, data: fs.readFileSync(path.join(ROOT, m.path)) }));

// H5/静态运行时：web/public 全量入包（mbti/dep/pro 三中心 + material-icons + vendor）。
// 不做差分——生产 H5 停留在镜像版本且历史包的 web/public 条目从未真正落盘，全量覆盖才能保证门禁脚本到位。
const publicFiles = [];
for (const d of ['mbti', 'dep', 'pro', 'material-icons', 'vendor']) {
  const abs = path.join(ROOT, 'web', 'public', d);
  if (fs.existsSync(abs)) listFiles(abs, d, publicFiles);
}
for (const rel of publicFiles) entries.push({ name: `web/public/${rel}`, data: fs.readFileSync(path.join(ROOT, 'web', 'public', rel)) });

// 差分 dist：新构建 vs 基线（=生产现状），不同/缺失的写进生产服务目录名原地覆盖
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

const meta = {
  version: 'v1.6.3',
  title: '测评中心运行时门禁 + 域名示例脱敏 + 默认落点智作平台 + 系统名兜底「工作台」',
  content: [
    '运行时门禁（安全修复）：三大测评中心新增免登录 /gate 探测端点，H5 页面启动即查 + 15 秒轮询 + 切回前台即查——管理员关闭「对外测试开关」后，已经打开的测试页面也会在 15 秒内整页锁定（此前漏洞：题目全在 JS 里，已加载的页面关开关后仍可继续作答，仅新开页面 403）。',
    '域名示例脱敏：全系统具体穿透域名示例统一替换为 your.domain.com 通用示例（后端校验报错文案与前端 placeholder/场景说明），停用对外测试时「查看/复制链接」按钮同步禁用。',
    '效率工具页默认落点改为「智作平台」。',
    '系统名兜底：新装/未配置时默认显示「工作台 / Workbench」（页面 title 与异步加载前的兜底值同步修正，不再闪现旧名称）；新库初始管理员默认 admin/admin123。',
    '附带：录音转写客户端引擎模板 base_url 回环化（上批遗留）。',
    '前置：需先应用 v1.6.3-pre（应用白名单加入 web/public/），否则主包的 H5 静态更新会被跳过。',
  ].join('\n'),
  dist: LIVE_DIST, files: manifest, dist_files: distDiff,
  runtime_files: publicFiles.length,
  created_at: now.toISOString(), created_by: 'admin',
};
writeZip(`${localTs()}_v1.6.3.zip`, meta,
  ['# 升级包 v1.6.3', '',
   `- 标题：${meta.title}`, `- 时间：${now.toLocaleString('zh-CN')}`,
   `- 源码留档：${manifest.length} 个；web/public 运行时：${publicFiles.length} 个（三中心 H5 + 图标字体，全量覆盖）`,
   `- 前端差分：${distDiff} 个文件（构建 ${NEW_DIST}，对比基线 ${BASE_DIST}=生产现状，写入线上目录 ${LIVE_DIST} 原地覆盖）`,
   '- 部署顺序：先应用 v1.6.3-pre（白名单），再应用本包', '',
   '## 升级内容', '', meta.content, '',
   '## 文件清单', '',
   ...manifest.map((m) => `- ${m.path}（${statusText[m.status]}，${m.size}B）`),
   `- web/public/**（${publicFiles.length} 个：mbti/dep/pro H5 全量 + material-icons + vendor）`, '',
  ].join('\n'),
  entries);

baseline.updated_at = now.toISOString();
setSetting(db, 'upgrade_baseline', baseline);
setSetting(db, 'current_version', 'v1.6.3');
console.log(`dist 差分 ${distDiff} 个；web/public 全量 ${publicFiles.length} 个；baseline 已更新`);
