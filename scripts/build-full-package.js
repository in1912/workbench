// 完整版升级包构建脚本：node scripts/build-full-package.js [版本号] [标题]
//
// 与「升级管理」页的常规打包不同：常规包只带变更的 server/ 源码 + web/dist 快照，
// 目标容器 node_modules 一旦缺少新引入的依赖（如 v1.0.7 的 dingtalk-stream）就会
// 起不来。完整版把生产依赖闭包一并打进 server/node_modules/——应用升级包时随
// server/ 白名单一起落盘，老容器无需 npm install 即可启动。
//
// 依赖来源：本机 node_modules（按各 package.json 的 dependencies 递归收集），
// 与本地测试跑的是同一份代码。playwright 除外——它要求库版本与镜像内浏览器
// 二进制匹配，沿用目标容器自带的那份（缺失时 browserSkillService 已有降级）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const NM = path.join(ROOT, 'node_modules');
const PKG_DIR = path.join(dataDir, 'upgrades');
// playwright 不随包分发：vendored 副本会遮蔽镜像内与浏览器二进制配套的原版本
const SKIP_DEPS = new Set(['playwright']);

function localTs() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 生产依赖闭包：根 package.json 起，沿 dependencies/optionalDependencies 递归
function collectClosure(rootDeps) {
  const seen = new Map(); // name -> version
  const queue = [...rootDeps];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name) || SKIP_DEPS.has(name)) continue;
    const pj = path.join(NM, ...name.split('/'), 'package.json');
    if (!fs.existsSync(pj)) { console.warn(`  ! node_modules 缺少 ${name}（若为可选依赖可忽略）`); continue; }
    const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'));
    seen.set(name, pkg.version);
    for (const d of Object.keys(pkg.dependencies || {})) queue.push(d);
    for (const d of Object.keys(pkg.optionalDependencies || {})) queue.push(d);
  }
  return seen;
}

// 目录 → zip 条目（跳过 .bin/隐藏文件/软链）
function addDirEntries(entries, absDir, prefix) {
  for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (ent.name === '.bin' || ent.name.startsWith('.')) continue;
    const abs = path.join(absDir, ent.name);
    if (fs.lstatSync(abs).isSymbolicLink()) continue;
    const name = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) addDirEntries(entries, abs, name);
    else if (ent.isFile()) entries.push({ name, data: fs.readFileSync(abs) });
  }
}

// server/ 源码文件清单（与升级页扫描同一套排除规则）
// 'data'：zhizu/data/ 是本地开发库（子进程数据库在生产走持久卷 /data/zhizu），绝不入包
// 'fnos-sh'：只放兄弟应用（JARVIS / 智能家居）打好的成品 fpk，是交付物不是源码——
//   .gitignore 第 20 行 `server/fnos-sh/*.fpk` 已按交付物排除，fnos-sh/build-fpk.mjs 里也
//   有 SERVER_SKIP=['fnos','fnos-sh'] 挡同一件事；后端 fnosRoutes 只读 server/fnos/，前端零引用。
//   不排掉的话，每个升级包都会白背 ~52MB 别人的安装包（v1.9.39 就因此撞到 apply 端点
//   multer 的 100MB 上限，上传直接 500 File too large）。注意 server/fnos/ 不同——
//   那是工作台自己的 fpk，FnosPanel 要下载，必须留在包里。
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'Logs', '.claude', 'backups', '__pycache__', 'data', 'fnos-sh']);
function walkServer(rel, out) {
  const abs = path.join(ROOT, rel);
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!EXCLUDE_DIRS.has(ent.name)) walkServer(`${rel}/${ent.name}`, out);
    } else if (ent.isFile()) {
      out.push(`${rel}/${ent.name}`);
    }
  }
  return out;
}

function hashBuf(b) { return crypto.createHash('sha256').update(b).digest('hex'); }

// 最新前端构建快照目录名（服务启动时同样选最新）
function latestDist() {
  const distDir = path.join(ROOT, 'web', 'dist');
  if (!fs.existsSync(distDir)) return null;
  const subs = fs.readdirSync(distDir)
    .filter((f) => fs.existsSync(path.join(distDir, f, 'index.html')))
    .sort();
  return subs.length ? subs[subs.length - 1] : null;
}

async function main() {
  const version = String(process.argv[2] || '').trim();
  if (!/^[\w.-]+$/.test(version)) {
    console.error('用法：node scripts/build-full-package.js <版本号 如 v1.1.0> [标题]');
    process.exit(1);
  }
  const title = String(process.argv[3] || '完整版升级包（全部源码 + 前端构建 + 新增依赖）');
  const dist = latestDist();
  if (!dist) { console.error('未找到 web/dist 构建快照，请先 npm run build:web'); process.exit(1); }

  // 1) 依赖闭包 → server/node_modules/
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const closure = collectClosure(Object.keys(rootPkg.dependencies || {}));
  console.log(`依赖闭包 ${closure.size} 个包（不含 playwright）：`);
  console.log('  ' + [...closure.entries()].map(([n, v]) => `${n}@${v}`).join(', '));

  // 2) 组装 zip 条目
  const entries = [];
  const manifest = [];
  // zhizu/（智作平台子服务，v1.6.2）：代码 + web/dist 构建产物随包，容器里落到 /app/zhizu
  // （子进程数据库另走持久卷 /data/zhizu，zhizu/data/ 由 EXCLUDE_DIRS 的 'data' 排除）。
  // 为什么必须带：打包侧此前漏了它，包永远不含 zhizu —— 2026-10-02 容器被重建（可写层清空、
  // /app/zhizu 随之消失）后，连 apply 全量包也救不回来，智作平台只能一直停在「正在启动，请稍候…」。
  // 应用侧 applyTargetPath 早就认 zhizu/ 前缀，两端从此对齐。
  const srcRels = walkServer('server', []);
  if (fs.existsSync(path.join(ROOT, 'zhizu'))) srcRels.push(...walkServer('zhizu', []));
  for (const rel of srcRels) {
    const data = fs.readFileSync(path.join(ROOT, rel));
    entries.push({ name: rel, data });
    manifest.push({ path: rel, size: data.length, hash: hashBuf(data) });
  }
  let vendorFiles = 0;
  for (const name of [...closure.keys()].sort()) {
    const before = entries.length;
    addDirEntries(entries, path.join(NM, ...name.split('/')), `server/node_modules/${name}`);
    vendorFiles += entries.length - before;
  }
  let distFiles = 0;
  const distEntries = [];
  addDirEntries(distEntries, path.join(ROOT, 'web', 'dist', dist), '');
  for (const e of distEntries) { entries.push({ name: `web/dist/${dist}/${e.name}`, data: e.data }); distFiles++; }

  // 3) manifest + 说明
  const now = new Date();
  const meta = {
    version, title,
    content: '完整版升级包：全部 server 源码 + 前端构建快照 + 生产依赖闭包（server/node_modules，playwright 除外）。用于老容器缺新依赖（dingtalk-stream）导致升级后无法启动的场景，也适用于全新环境一步到位。',
    dist, files: manifest, dist_files: distFiles, vendor_modules: closure.size, vendor_files: vendorFiles,
    created_at: now.toISOString(), created_by: 'admin',
  };
  const md = [
    `# 完整版升级包 ${version}`, '',
    `- 标题：${title}`,
    `- 时间：${now.toLocaleString('zh-CN')}`,
    `- server 源码：${manifest.length} 个文件`,
    `- 前端构建快照：${dist}（${distFiles} 个文件）`,
    `- 内置依赖：${closure.size} 个包 / ${vendorFiles} 个文件（server/node_modules，不含 playwright）`, '',
    '## 说明', '',
    '- 覆盖式升级：无论目标容器当前是什么版本，应用后即为本地当前代码状态。',
    '- 新增依赖（如 dingtalk-stream）已内置于 server/node_modules，老容器无需 npm install。',
    '- 应用后服务自动重启（Docker restart:always），数据目录不受影响。', '',
  ].join('\n');
  entries.unshift({ name: 'manifest.json', data: JSON.stringify(meta, null, 2) });
  entries.unshift({ name: 'UPGRADE.md', data: md });

  // 4) 写包 + 登记升级日志 + 对齐基线/版本
  const zipBuf = buildZip(entries);
  if (!fs.existsSync(PKG_DIR)) fs.mkdirSync(PKG_DIR, { recursive: true });
  const pkgName = `${localTs()}_${version}.zip`;
  fs.writeFileSync(path.join(PKG_DIR, pkgName), zipBuf);

  db.prepare(
    `INSERT INTO upgrade_logs(version,title,content,file_count,package_name,package_size,files_json,created_by,source)
     VALUES(?,?,?,?,?,?,?,?, 'package')`
  ).run(version, title, meta.content, manifest.length, pkgName, zipBuf.length,
    JSON.stringify(manifest.map((m) => ({ path: m.path, size: m.size, status: 'full' }))), 'admin');

  const baseline = getSetting(db, 'upgrade_baseline', { files: {}, updated_at: null });
  for (const m of manifest) baseline.files[m.path] = m.hash; // 完整包=全部文件即新基线
  baseline.updated_at = now.toISOString();
  setSetting(db, 'upgrade_baseline', baseline);
  setSetting(db, 'current_version', version);

  console.log('\n== 完整版升级包已生成 ==');
  console.log(`  文件：${pkgName}（${(zipBuf.length / 1024 / 1024).toFixed(2)} MB，共 ${entries.length} 个条目）`);
  console.log(`  位置：${path.join(PKG_DIR, pkgName)}`);
  console.log('  下载：设置 → 升级管理 → 该记录的「下载」；目标机「应用升级包」上传即可。');
  process.exit(0);
}

main().catch((e) => { console.error('构建失败：', e); process.exit(1); });
