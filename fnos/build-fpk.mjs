#!/usr/bin/env node
// 装配飞牛 fnOS 应用包目录（随后用官方 fnpack build 打成 .fpk）
// 用法：
//   node fnos/build-fpk.mjs [--out <目录>] [--node-modules <生产依赖目录>]
// 说明：
//   - server/zhizu/package.json 等取自 git 已提交内容（git archive，保证与 GitHub 一致）
//   - web/dist 只带最新一次构建产物（时间戳目录）
//   - node_modules 用 --node-modules 指定已装好的生产依赖（npm ci --omit=dev --ignore-scripts，
//     全纯 JS 无原生模块）；未指定时会现场 npm ci 装一份（较慢）
//   - 装配完成后：fnpack build --directory <out>/qgworkbench
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FNOS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(FNOS_DIR, '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = path.resolve(argOf('--out', path.join(ROOT, '..', 'workbench-fnos-build')));
const PROJ = path.join(OUT, 'qgworkbench');
const APP = path.join(PROJ, 'app');

// 最新前端构建产物（时间戳子目录，同 server/index.js 的解析规则）
const distRoot = path.join(ROOT, 'web', 'dist');
const latest = fs.readdirSync(distRoot)
  .filter((f) => fs.statSync(path.join(distRoot, f)).isDirectory() && fs.existsSync(path.join(distRoot, f, 'index.html')))
  .sort().pop();
if (!latest) { console.error('未找到 web/dist 构建产物，先执行 npm run build:web'); process.exit(1); }

fs.rmSync(PROJ, { recursive: true, force: true });
fs.mkdirSync(APP, { recursive: true });

// 1) 包骨架：manifest / 图标 / cmd / config / wizard（fnos/ 目录即源）
for (const f of ['manifest', 'ICON.PNG', 'ICON_256.PNG', 'cmd', 'config', 'wizard']) {
  fs.cpSync(path.join(FNOS_DIR, f), path.join(PROJ, f), { recursive: true });
}
// 2) UI 入口：fnos/app-ui → app/ui（manifest desktop_uidir=ui）
fs.cpSync(path.join(FNOS_DIR, 'app-ui'), path.join(APP, 'ui'), { recursive: true });
// 3) 运行文件：git 已提交内容（server + zhizu + package*.json + fnos 说明），与 GitHub 完全一致
//    ⚠️ `git archive` 与 checkout 同规则会吃 core.autocrlf——Windows 上会把库里的 LF 全转成 CRLF，
//    载荷就和 git 逐字节对不上了；必须 `-c core.autocrlf=false -c core.eol=lf` 钉死原样字节，
//    再用 Windows 自带 bsdtar 解包（二进制模式，不像 MSYS tar 那样做文本转换）。
const APP_POSIX = APP.replaceAll('\\', '/');
const tmpTar = path.join(OUT, 'head-payload.tar');
execSync(`git -c core.autocrlf=false -c core.eol=lf archive HEAD server zhizu package.json package-lock.json fnos/README-FNOS.md --output="${tmpTar.replaceAll('\\', '/')}"`, { cwd: ROOT, stdio: 'inherit' });
execSync(`"${process.env.SystemRoot || 'C:/Windows'}/System32/tar.exe" -xf "${tmpTar}" -C "${APP_POSIX}"`, { stdio: 'inherit' });
fs.rmSync(tmpTar, { force: true });
// git archive 保留 fnos/ 路径前缀：说明文档挪到 app 根（随包安装在 target/ 根可读）
fs.renameSync(path.join(APP, 'fnos', 'README-FNOS.md'), path.join(APP, 'README-FNOS.md'));
fs.rmSync(path.join(APP, 'fnos'), { recursive: true, force: true });
// 4) 前端构建产物：只带最新一份
fs.cpSync(path.join(distRoot, latest), path.join(APP, 'web', 'dist', latest), { recursive: true });
// 5) 生产依赖：优先用现成目录（同 lockfile、已验证零原生模块），否则现场安装
let nmSrc = argOf('--node-modules', '');
if (nmSrc) {
  fs.cpSync(nmSrc, path.join(APP, 'node_modules'), { recursive: true });
} else {
  console.log('[fpk] 未指定 --node-modules，现场安装生产依赖（npm ci --omit=dev --ignore-scripts）...');
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(APP, 'package.json'));
  fs.copyFileSync(path.join(ROOT, 'package-lock.json'), path.join(APP, 'package-lock.json'));
  execSync('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', { cwd: APP, stdio: 'inherit' });
}

const du = (p) => Math.round(execSync(`du -sm "${p}" 2>/dev/null || echo 0`).toString().trim().split('\t')[0]);
console.log(`[fpk] 装配完成: ${PROJ}`);
console.log(`      dist=${latest}  app≈${du(APP)}MB`);
console.log(`      下一步: fnpack build --directory "${PROJ}"`);
