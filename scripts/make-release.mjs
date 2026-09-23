// make-release.mjs —— 生成可直接分发的工作台发行包（第9项：整个文件夹打包给别人用）
// 产物：D:/CC/workbench-release/personal-workbench/（staging）+ D:/CC/personal-workbench-v1.6.3.zip
// 排除：data/（私密数据）、Logs/、web/node_modules（仅构建用）、web/dist 历史版本、开发文档、临时文件
// 包含：全部运行代码 + 根 node_modules（开箱即用，无需联网 npm install）+ 最新前端构建
// 用法：node scripts/make-release.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const STAGE = 'D:/CC/workbench-release/personal-workbench';
const ZIP = 'D:/CC/personal-workbench-v1.6.3.zip';

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });
fs.rmSync(ZIP, { force: true });

function rc(rel, extra = []) {
  const r = spawnSync('robocopy', [path.join(ROOT, rel), path.join(STAGE, rel), '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/MT:16', ...extra], { stdio: 'inherit' });
  if ((r.status ?? 0) >= 8) throw new Error(`robocopy ${rel} 失败 code=${r.status}`);
}
function cp(rel) {
  fs.copyFileSync(path.join(ROOT, rel), path.join(STAGE, rel));
}

// ---- 代码目录 ----
rc('server');
rc('vibeasr');   // 独立转写客户端引擎（linux/win 预编译，~8MB）
rc('tts');       // TTS 脚本（voices 为空目录，随包带上）
rc('scripts', ['/XF', 'repro-switch-hole.mjs']); // 漏洞复现脚本不分发
rc('web/src');
rc('web/public'); // 前端静态：三大测评中心 H5、Material Icons 等
rc('zhizu', ['/XD', 'data', 'node_modules']);    // 智作平台：代码带、数据绝不带

// ---- 前端构建产物：只带最新版本目录（dist 下按时间戳累积，历史版本不分发）----
const distRoot = path.join(ROOT, 'web', 'dist');
const latest = fs.readdirSync(distRoot).filter((d) => /^\d+$/.test(d)).sort().pop();
if (!latest) throw new Error('web/dist 下没有版本目录，请先 npm run build:web');
rc(`web/dist/${latest}`);
console.log(`[release] 前端构建产物：仅带最新 ${latest}`);

// ---- 根依赖（开箱即用；web/node_modules 仅前端构建用，不带）----
rc('node_modules');

// ---- 根部单文件 ----
for (const f of [
  'package.json', 'package-lock.json', 'start.bat',
  'README.md', 'README-使用说明.md',
  'Dockerfile', 'docker-compose.yml', '.dockerignore', 'pack-deploy.sh',
  'web/index.html', 'web/package.json', 'web/package-lock.json', 'web/vite.config.js',
]) cp(f);

// ---- 空数据目录（首启自动建库；带上空壳让「数据在 data/」一目了然）----
fs.mkdirSync(path.join(STAGE, 'data'), { recursive: true });

// ---- 压缩（Windows 自带 bsdtar 按 .zip 扩展名出 zip；Git Bash 的 GNU tar 不支持 zip，必须全路径）----
console.log('[release] 压缩中…');
const BSDTAR = 'C:/Windows/System32/tar.exe';
const z = spawnSync(BSDTAR, ['-a', '-c', '-f', ZIP, '-C', path.dirname(STAGE), path.basename(STAGE)], { stdio: 'inherit' });
if (z.status !== 0) throw new Error('tar 压缩失败 code=' + z.status);

const mb = (p) => (fs.statSync(p).size / 1024 / 1024).toFixed(1);
console.log(`\n[release] ✅ 完成\n  staging: ${STAGE}（${mb(STAGE)}MB 估算见 du）\n  zip:     ${ZIP}（${mb(ZIP)}MB）\n  首启账号: admin / admin123（README-使用说明.md 有完整指引）`);
