// v1.6.21 升级包：①「摄像头二次验证」tab（智能家居页内完成小米账号密码登录换凭证，支持短信/邮件验证码）
//                ②修复设备控制「设备不存在」误报：did 传字符串时小米 prop/set 命令已执行但响应报 code 1，
//                  界面回退后重复下发同值 → 「开关只能点一次」。上游要求数字 did，统一转 Number；
//                  前端失败后 1s 回读真实值兜底。
//   server：micamLogin.js（新增：passport 登录三步 + 验证码 + 短信/邮件安全验证 identity/list→verifyPhone/Email）
//           mihomeRoutes.js（/micam/login|verify|inject-target）
//           mihomeService.js（numDid 数字化修复）
//           auth.js（verify tab 路径归属）
//   web：tabs.js + SmartHome.vue（新 tab；生产站点显示本地操作引导不显示密码表单；控制失败回读兜底）
//   dist 差分：新构建 202609281644 对比基线 202609281602（v1.6.19=生产现状），写入 202609220406 原地覆盖。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(dataDir, 'upgrades');
const LIVE_DIST = '202609220406';
const BASE_DIST = '202609281602';
const NEW_DIST = '202609281644';

const FILES = [
  'server/services/micamLogin.js',    // 新增：小米账号密码登录 + 短信/邮件安全验证（密码仅内存）
  'server/services/mihomeService.js', // 修复：did 数字化（prop/set 字符串 did → 上报 code1「设备不存在」误报）
  'server/routes/mihomeRoutes.js',    // /micam/login|verify|inject-target 路由
  'server/auth.js',                   // verify tab 路径归属
  'web/src/tabs.js',                  // 摄像头二次验证 tab 项
  'web/src/views/SmartHome.vue',      // 新 tab UI + 开关控制失败回读兜底
  'data/test-mihome-api.js',          // 测试（+4 项 micam 登录会话，共 40）
  'data/test-mihome-ui.js',           // 测试（+2 项二次验证 tab，共 17）
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
  version: 'v1.6.21',
  title: '摄像头二次验证 tab + 修复设备控制「设备不存在」误报（开关只能点一次的问题）',
  content: [
    '修复（用户实测反馈）：智能家居页控制设备（如书架台灯所在 lemesh 开关）时提示「设备不存在」，但设备实际已被控制；界面随即回退，再点开关重复下发同值，表现为「开关只能点一次 / 点了没反应」。根因：米家云 /app/v2/miotspec/prop/set 的 did 参数要求数字类型，传字符串时命令仍会执行、但响应项报 code 1「设备不存在」——已实测复现（set 后 get 值已变、响应仍报错）。修复：prop/get、prop/set、action 的 did 统一转数字下发。',
    '加固：卡片/详情页开关控制上报失败时，1 秒后自动回读设备真实状态并校正界面显示，避免界面与设备脱节（同类上游误报再出现也能自动对齐）。',
    '新增「摄像头二次验证」tab（智能家居页，监控 tab 右侧）：把小米账号密码登录换凭证功能集成进工作台页面，逐步支持图片验证码、手机短信/邮件安全验证码（此前独立工具遇短信验证无法继续的问题就此解决）。表单默认注入目标 localhost（也可注入本机）。',
    '安全不变：小米密码只在【本地电脑（localhost 访问）】的工作台页面输入，仅在本机内存换凭证，不保存、不经过生产服务器；生产站点打开该 tab 显示操作引导（一键打开本机页面），不显示密码表单。凭证仍 AES-256-GCM 加密存储，30 分钟登录会话仅存内存。',
    '测试：API 40 项 / UI 17 项全过（本地）。',
  ].join('\n'),
  dist: LIVE_DIST, files: manifest, dist_files: distDiff,
  created_at: now.toISOString(), created_by: 'admin',
};
const zipBuf = buildZip([
  { name: 'UPGRADE.md', data: ['# 升级包 v1.6.21', '',
    `- 标题：${meta.title}`, `- 时间：${now.toLocaleString('zh-CN')}`,
    `- 源码：${manifest.length} 个（1 个新增 + 5 个修改 + 2 个测试）`,
    `- 前端差分：${distDiff} 个文件（构建 ${NEW_DIST}，对比基线 ${BASE_DIST}=生产现状 v1.6.19，写入线上目录 ${LIVE_DIST} 原地覆盖）`, '',
    '## 验证要点', '',
    '1. 智能家居 → 任意开关设备：卡片开关连续点开/关，均应提示成功且不再出现「设备不存在」',
    '2. 智能家居 → 摄像头二次验证 tab：生产站点显示「请在本地电脑操作」引导；本机 localhost:3000 显示完整登录表单', ''].join('\n') },
  { name: 'manifest.json', data: JSON.stringify(meta, null, 2) },
  ...entries,
]);
if (!fs.existsSync(PKG_DIR)) fs.mkdirSync(PKG_DIR, { recursive: true });
const zipName = `${localTs()}_v1.6.21.zip`;
fs.writeFileSync(path.join(PKG_DIR, zipName), zipBuf);
db.prepare(
  `INSERT INTO upgrade_logs(version,title,content,file_count,package_name,package_size,files_json,created_by,source)
   VALUES(?,?,?,?,?,?,?,?, 'package')`
).run(meta.version, meta.title, meta.content, meta.files.length, zipName, zipBuf.length,
  JSON.stringify(meta.files.map((m) => ({ path: m.path, size: m.size, status: m.status }))), 'admin');
for (const m of manifest) baseline.files[m.path] = m.hash;
baseline.updated_at = now.toISOString();
setSetting(db, 'upgrade_baseline', baseline);
setSetting(db, 'current_version', 'v1.6.21');
console.log(`已生成 ${zipName}（${(zipBuf.length / 1024).toFixed(0)} KB，源码 ${manifest.length} + dist 差分 ${distDiff}）`);
