// v1.6.5 升级包：定时推送节假日门控
//   server：businessSkillService.js（holidayGate/cnToday + saveSchedule holiday_mode + cron 回调门控）、
//           db.js（skill_schedules.holiday_mode 列迁移）
//   web 源码留档：Business.vue（类型=周一至周五、节假日下拉、预览后缀、列表徽标）
//   dist 差分：新构建 202609280707 对比基线 202609280617（=生产现状 v1.6.4），写入线上目录 202609220406 原地覆盖。
//   注意：本包只动代码，不动生产任何定时推送/Skill 数据（现有配置 holiday_mode 默认空=不判断，行为不变）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(dataDir, 'upgrades');
const LIVE_DIST = '202609220406'; // 生产当前服务的 dist 目录名（写入目标）
const BASE_DIST = '202609280617'; // 生产现状对应的本地构建目录（v1.6.4 构建）
const NEW_DIST = '202609280707';  // 本次新构建

const FILES = [
  'server/services/businessSkillService.js', // holidayGate 门控 + saveSchedule holiday_mode + cron 回调跳过
  'server/db.js',                            // skill_schedules 加 holiday_mode 列
  'web/src/views/Business.vue',              // 留档（应用白名单跳过）：类型/节假日下拉/预览/徽标
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
  version: 'v1.6.5',
  title: '定时推送：时间/星期选择增强 + 节假日门控（timor.tech / apizero.cn）',
  content: [
    '新增定时推送「类型」新增「周一至周五」一键选项（原每周自选星期保留，可选到周日）。',
    '新增「节假日」设置：不判断（照常推送）/ 法定节假日不推送 / 按国家工作日历（法定节假日不推、周末调休补班日照常推），数据源跟随「系统设置 → 节假日」（timor.tech / apizero.cn），对自定义 cron 同样生效，「立即执行」不受门控限制。',
    '到点判断按中国标准时间取当日日期；日历接口故障时安全退化（节假日不推送模式照常推、工作日历模式退化为周一至周五），不会因接口问题漏推工作日。',
    'skill_schedules 表新增 holiday_mode 列（ALTER TABLE 幂等）——存量配置默认空=不判断，行为完全不变。',
    '本次升级只更新代码，不改动生产已有的定时推送与 Skill 任务数据。',
  ].join('\n'),
  dist: LIVE_DIST, files: manifest, dist_files: distDiff,
  created_at: now.toISOString(), created_by: 'admin',
};
const zipBuf = buildZip([
  { name: 'UPGRADE.md', data: ['# 升级包 v1.6.5', '',
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
const zipName = `${localTs()}_v1.6.5.zip`;
fs.writeFileSync(path.join(PKG_DIR, zipName), zipBuf);
db.prepare(
  `INSERT INTO upgrade_logs(version,title,content,file_count,package_name,package_size,files_json,created_by,source)
   VALUES(?,?,?,?,?,?,?,?, 'package')`
).run(meta.version, meta.title, meta.content, meta.files.length, zipName, zipBuf.length,
  JSON.stringify(meta.files.map((m) => ({ path: m.path, size: m.size, status: m.status }))), 'admin');
for (const m of manifest) baseline.files[m.path] = m.hash;
baseline.updated_at = now.toISOString();
setSetting(db, 'upgrade_baseline', baseline);
setSetting(db, 'current_version', 'v1.6.5');
console.log(`已生成 ${zipName}（${(zipBuf.length / 1024).toFixed(0)} KB，源码 ${manifest.length} + dist 差分 ${distDiff}）`);
