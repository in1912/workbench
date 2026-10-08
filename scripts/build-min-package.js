#!/usr/bin/env node
// 最小升级包：新 dist 目录 + 最新 fpk + 若干指定文件——给「server 无改动、只有前端/fpk 变化」的版本用。
// 为什么需要它：fpk 随包含 dws/wecom linux 二进制涨到 66MB 后，全量包 ~123MB；
// apply 的 multer 上限在 v1.12.6 前是 100MB（之后 256MB），全量包在老生产上可能传不上去。
// apply 是合并覆盖语义（不带的服务器文件保持现状），所以只要版本锚点 + 变更内容齐了就是合法升级。
// ⚠️ 前提：目标机当前版本与本仓库同源且较新（server 侧没漏改动）。server 代码有改动时，
//    把改动文件用 --extra 显式带上，或干脆走 build-full-package.js。
// 用法：node scripts/build-min-package.js <版本号 如 1.12.6> [--extra <仓库相对路径>]... [--no-fpk]
//   --extra 可多次；默认自动带 server/fnos/*.fpk 与最新 web/dist/<时间戳>/。
//   --no-fpk 不带 fpk（fpk 66MB 是体积大头）：本机与生产不同网、只能走公网 cc.in1912.cc apply 时
//   必须用——Cloudflare 对上传有 ~100s 墙，65MB 基本必 502，6MB 的 dist 增量秒过。
//   fpk 只服务 7777 飞牛实例（随测试环境全量包升级），生产增量不带不影响运行。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const version = String(process.argv[2] || '').trim();
if (!/^[\w.-]+$/.test(version)) { console.error('用法：node scripts/build-min-package.js <版本号> [--extra <仓库相对路径>] [--no-fpk]'); process.exit(1); }
const extras = [];
const noFpk = process.argv.includes('--no-fpk');
for (let i = 3; i < process.argv.length; i++) {
  if (process.argv[i] === '--extra') { extras.push(String(process.argv[++i] || '')); }
}

// 最新 dist（与 build-full-package 同规则）
const distRoot = path.join(ROOT, 'web', 'dist');
const dist = fs.readdirSync(distRoot)
  .filter((f) => { try { return fs.statSync(path.join(distRoot, f)).isDirectory() && fs.existsSync(path.join(distRoot, f, 'index.html')); } catch { return false; } })
  .sort().pop();
if (!dist) { console.error('未找到 web/dist 构建快照，先 npm run build:web'); process.exit(1); }

const entries = [];
const files = [];
const hashBuf = (b) => crypto.createHash('sha256').update(b).digest('hex');
const addFile = (abs, name) => {
  const data = fs.readFileSync(abs);
  entries.push({ name, data });
  files.push({ path: name, size: data.length, hash: hashBuf(data) });
};

// 1) 新 dist 目录（全新时间戳目录，整目录带上——latestDist() 落盘后自动切过去，旧目录不动）
const distDir = path.join(distRoot, dist);
const walk = (dir, prefix) => {
  for (const f of fs.readdirSync(dir).sort()) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, prefix + f + '/');
    else addFile(p, `web/dist/${dist}/${prefix}${f}`);
  }
};
walk(distDir, '');

// 2) 最新 fpk（server/fnos/ 只放最新一版）——--no-fpk 时跳过（见文件头注释）
if (!noFpk) {
  const fnosDir = path.join(ROOT, 'server', 'fnos');
  for (const f of fs.readdirSync(fnosDir).filter((x) => x.endsWith('.fpk')).sort()) {
    addFile(path.join(fnosDir, f), `server/fnos/${f}`);
  }
}

// 3) --extra 显式指定的文件（如本轮的 server/routes/upgradeRoutes.js）
for (const rel of extras) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) { console.error('--extra 文件不存在：' + rel); process.exit(1); }
  addFile(abs, rel.replace(/\\/g, '/'));
}

const now = new Date();
const meta = {
  version, title: `最小升级包 ${version}（前端 dist + fpk${extras.length ? ' + ' + extras.length + ' 个指定文件' : ''}）`,
  content: '最小升级包：apply 合并覆盖语义——只带本版变更（新 dist 目录 + 最新 fpk' + (extras.length ? ' + 显式指定的 server 文件' : '') + '），未带的文件在目标机保持现状。适用于 server 无（或仅少量）改动的版本。',
  dist, files, dist_files: files.filter((f) => f.path.startsWith('web/dist/')).length,
  created_at: now.toISOString(), created_by: 'admin',
};
entries.unshift({ name: 'manifest.json', data: JSON.stringify(meta, null, 2) });

const zipBuf = buildZip(entries);
const pkgDir = path.join(ROOT, 'data', 'upgrades');
if (!fs.existsSync(pkgDir)) fs.mkdirSync(pkgDir, { recursive: true });
const ts = new Date(Date.now() + 8 * 3600e3).toISOString().replace(/[-:T]/g, '').slice(0, 14);
const pkgName = `${ts}_${version}-min.zip`;
fs.writeFileSync(path.join(pkgDir, pkgName), zipBuf);
console.log(`== 最小升级包已生成 ==`);
console.log(`  文件：${pkgName}（${(zipBuf.length / 1048576).toFixed(2)} MB，${entries.length} 个条目）`);
console.log(`  位置：${path.join(pkgDir, pkgName)}`);
console.log(`  dist：${dist}（${meta.dist_files} 文件）· fpk：${files.filter((f) => f.path.startsWith('server/fnos/')).map((f) => path.basename(f.path)).join(', ') || '无'}`);
if (extras.length) console.log(`  extra：${extras.join(', ')}`);
const mb = zipBuf.length / 1048576;
console.log(mb > 256 ? `  ⚠️ ${(mb).toFixed(1)}MB 超 apply 上限 256MB，传不上去！` : mb > 100 ? `  注意：超旧版 100MB 上限——目标机须已含 256MB 修复（v1.12.6+）` : `  ${mb.toFixed(1)}MB < 100MB，任何版本上限都可直接 apply`);
