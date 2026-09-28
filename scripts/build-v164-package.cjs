// v1.6.4 升级包：Skill 去 AI 化 + AI 耗用标注 + saveSkill 支持配方字段
//   server：businessSkillService.js（本地整理分支/chatEx 标注/UPDATE 参数修复/browser_recipe 显式携带语义）、
//           aiService.js（chatEx 返回 {content,model,usage}）、db.js（business_skills 四列迁移）
//   web 源码留档：Business.vue（本地整理勾选框/AI 徽标/执行链路说明）
//   dist 差分：新构建 202609280617 对比基线 202609230625（=生产现状），写入线上目录 202609220406 原地覆盖。
//   注意：本包只动代码，不动生产任何业务系统/Skill 数据（生产现有任务原样保留）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(dataDir, 'upgrades');
const LIVE_DIST = '202609220406'; // 生产当前服务的 dist 目录名（写入目标）
const BASE_DIST = '202609230625'; // 生产现状对应的本地构建目录（v1.6.3 构建）
const NEW_DIST = '202609280617';  // 本次新构建

const FILES = [
  'server/services/businessSkillService.js', // 本地整理 + AI 标注 + browser_recipe API 语义
  'server/services/aiService.js',            // chatEx()：内容+模型+token 用量
  'server/db.js',                            // business_skills 加 browser_recipe/local_format/last_ai_model/last_ai_tokens 列
  'web/src/views/Business.vue',              // 留档（应用白名单跳过）：本地整理勾选/AI 徽标/链路说明
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

// 差分 dist：新构建 vs 基线（=生产现状），不同/缺失的写进生产服务目录名原地覆盖
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
  version: 'v1.6.4',
  title: 'Skill 本地整理（零 AI）+ AI 耗用标注 + Skill 配方可经 API 写入',
  content: [
    'Skill 整理输出支持「本地整理」模式（勾选后不调用任何外部 AI，抓取/接口数据确定性排版为 Markdown 表格，结果尾标注「本地整理 · 未调用 AI」）。',
    'AI 整理模式保留，但强制标注耗用：结果尾部注明「模型 X · tokens 输入/输出/合计」，business_skills 新增 last_ai_model/last_ai_tokens 列，业务系统页显示 AI 徽标。',
    'saveSkill 支持经 API 写入 browser_recipe（仅在请求体显式携带时生效，管理页编辑表单不带该字段、不会误清配方）；修复 Skill 执行后 UPDATE 参数个数不匹配的运行时错误。',
    'business_skills 表结构迁移（新增 4 列，ALTER TABLE 幂等）——不影响存量 Skill 数据与定时任务。',
    '本次升级只更新代码，不改动生产已有的业务系统与 Skill 任务数据。',
  ].join('\n'),
  dist: LIVE_DIST, files: manifest, dist_files: distDiff,
  created_at: now.toISOString(), created_by: 'admin',
};
const zipBuf = buildZip([
  { name: 'UPGRADE.md', data: ['# 升级包 v1.6.4', '',
    `- 标题：${meta.title}`, `- 时间：${now.toLocaleString('zh-CN')}`,
    `- 源码：${manifest.length} 个（1 个 web 源码留档）`,
    `- 前端差分：${distDiff} 个文件（构建 ${NEW_DIST}，对比基线 ${BASE_DIST}=生产现状，写入线上目录 ${LIVE_DIST} 原地覆盖）`, '',
    '## 升级内容', '', meta.content, '',
    '## 文件清单', '',
    ...manifest.map((m) => `- ${m.path}（${statusText[m.status]}，${m.size}B）`),
    `- web/dist/${LIVE_DIST}/**（差分 ${distDiff} 个）`, ''].join('\n') },
  { name: 'manifest.json', data: JSON.stringify(meta, null, 2) },
  ...entries,
]);
if (!fs.existsSync(PKG_DIR)) fs.mkdirSync(PKG_DIR, { recursive: true });
const zipName = `${localTs()}_v1.6.4.zip`;
fs.writeFileSync(path.join(PKG_DIR, zipName), zipBuf);
db.prepare(
  `INSERT INTO upgrade_logs(version,title,content,file_count,package_name,package_size,files_json,created_by,source)
   VALUES(?,?,?,?,?,?,?,?, 'package')`
).run(meta.version, meta.title, meta.content, meta.files.length, zipName, zipBuf.length,
  JSON.stringify(meta.files.map((m) => ({ path: m.path, size: m.size, status: m.status }))), 'admin');
for (const m of manifest) baseline.files[m.path] = m.hash;
baseline.updated_at = now.toISOString();
setSetting(db, 'upgrade_baseline', baseline);
setSetting(db, 'current_version', 'v1.6.4');
console.log(`已生成 ${zipName}（${(zipBuf.length / 1024).toFixed(0)} KB，源码 ${manifest.length} + dist 差分 ${distDiff}）`);
