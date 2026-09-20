// 纯前端升级包构建脚本：node scripts/build-frontend-package.js <版本> [标题] [变更文件...]
//
// 适用于只改前端（web/src）的小批次：包内 = 变更的源码文件 + 最新 web/dist 快照，
// 不含 server/ 与依赖闭包——目标容器代码不变，无需完整版（对照 build-full-package.js）。
// 应用端白名单只落 web/dist/（源码条目留档于包内），容器重启后新快照即刻生效。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db, dataDir, getSetting, setSetting } = require('../server/db');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(dataDir, 'upgrades');
const hashBuf = (b) => crypto.createHash('sha256').update(b).digest('hex');
function localTs() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function main() {
  const version = String(process.argv[2] || '').trim();
  if (!version) {
    console.error('用法：node scripts/build-frontend-package.js <版本> [标题] [变更文件...]');
    console.error('示例：node scripts/build-frontend-package.js v1.2.2 钉钉AgentId修复 web/src/views/Settings.vue');
    process.exit(1);
  }
  const title = String(process.argv[3] || `${version} 前端更新`).trim();
  const files = process.argv.slice(4).map((s) => s.replace(/\\/g, '/')).filter(Boolean);

  // 最新前端构建快照（同 index.js latestDist 规则）
  const distRoot = path.join(ROOT, 'web', 'dist');
  const subs = fs.readdirSync(distRoot)
    .filter((f) => fs.statSync(path.join(distRoot, f)).isDirectory() && fs.existsSync(path.join(distRoot, f, 'index.html')))
    .sort();
  if (!subs.length) throw new Error('未找到前端构建产物，请先执行 npm run build');
  const dist = subs[subs.length - 1];

  const baseline = getSetting(db, 'upgrade_baseline', { files: {}, updated_at: null });
  const entries = [];
  const manifest = [];
  for (const rel of files) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) throw new Error(`文件不存在：${rel}`);
    const data = fs.readFileSync(abs);
    const hash = hashBuf(data);
    const old = (baseline.files || {})[rel];
    manifest.push({ path: rel, size: data.length, hash, status: !old ? 'new' : old === hash ? 'unchanged' : 'changed' });
    entries.push({ name: rel, data });
  }

  let distFiles = 0;
  const addDir = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) addDir(path.join(dir, ent.name), r);
      else { entries.push({ name: `web/dist/${dist}/${r}`, data: fs.readFileSync(path.join(dir, ent.name)) }); distFiles++; }
    }
  };
  addDir(path.join(distRoot, dist), '');

  const now = new Date();
  const meta = {
    version, title,
    content: '纯前端升级包：变更源码（留档）+ 前端构建快照（web/dist）。目标容器 server 代码与依赖不变。',
    dist, files: manifest, dist_files: distFiles,
    created_at: now.toISOString(), created_by: 'admin',
  };
  const statusText = { new: '新增', changed: '修改', unchanged: '未变更' };
  const md = [
    `# 纯前端升级包 ${version}`, '',
    `- 标题：${title}`,
    `- 时间：${now.toLocaleString('zh-CN')}`,
    `- 变更源码：${manifest.length} 个${files.length ? `（${files.join('、')}）` : ''}`,
    `- 前端构建快照：${dist}（${distFiles} 个文件）`, '',
    '- 应用后服务自动重启（Docker restart:always），web/dist 新快照即刻生效。', '',
    '## 变更清单', '',
    ...manifest.map((m) => `- ${m.path}（${statusText[m.status]}，${m.size}B）`),
    '',
  ].join('\n');
  entries.unshift({ name: 'manifest.json', data: JSON.stringify(meta, null, 2) });
  entries.unshift({ name: 'UPGRADE.md', data: md });

  const zipBuf = buildZip(entries);
  if (!fs.existsSync(PKG_DIR)) fs.mkdirSync(PKG_DIR, { recursive: true });
  const pkgName = `${localTs()}_${version}.zip`;
  fs.writeFileSync(path.join(PKG_DIR, pkgName), zipBuf);

  db.prepare(
    `INSERT INTO upgrade_logs(version,title,content,file_count,package_name,package_size,files_json,created_by,source)
     VALUES(?,?,?,?,?,?,?,?,'package')`
  ).run(version, title, meta.content, manifest.length, pkgName, zipBuf.length,
    JSON.stringify(manifest.map((m) => ({ path: m.path, size: m.size, status: m.status }))), 'admin');

  for (const m of manifest) baseline.files[m.path] = m.hash; // 未勾选的改动下次扫描仍提示
  baseline.updated_at = now.toISOString();
  setSetting(db, 'upgrade_baseline', baseline);
  setSetting(db, 'current_version', version);

  console.log(`纯前端升级包已生成: ${pkgName}（${(zipBuf.length / 1024).toFixed(0)} KB，源码 ${manifest.length} + dist ${distFiles} 个文件）`);
  console.log(`位置: ${path.join(PKG_DIR, pkgName)}`);
  process.exit(0);
}

try { main(); } catch (e) { console.error('构建失败：', e.message); process.exit(1); }
