#!/usr/bin/env node
// 装配「智能家居」独立应用的飞牛 fnOS 包目录（随后由 Logs/build-fpk-sh.py 走 bsdtar 三步打成 .fpk）
// 用法：
//   node fnos-sh/build-fpk.mjs [--out <目录>] [--node-modules <生产依赖目录>]
//
// 与 fnos/build-fpk.mjs（全能工作台）的三处差别：
//   ① 载荷**不含 zhizu/**：智作平台是工作台的东西，智能家居用不到（少一个会崩的子进程）。
//   ② 载荷不含 **server/fnos/**：那目录装的是工作台自己的 fpk（23MB），本应用用不上；
//      本应用也不渲染「设置 → 飞牛应用」那个 tab（见 server/index.js 的 SH_MODE 分支说明）。
//   ③ 前端取 **web/dist-sh/<时间戳>**（sh 入口，base './'），不是 web/dist。
//
// 载荷来源：默认**从工作区拷贝**（不是 git archive）——本应用的 server/flash-tool/ 里放着
// 预编译固件模板（约 7MB，尚未入库），git archive 取不到已提交之外的内容。代价是「与 GitHub
// 逐字节一致」这条保证在本脚本上不成立；换来的是「改了就能立刻打包验证」。工作台那条链路
// （fnos/build-fpk.mjs）仍走 git archive，不要混。
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FNOS_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(FNOS_DIR, '..');
const argv = process.argv.slice(2);
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const OUT = path.resolve(argOf('--out', path.join(ROOT, '..', 'jarvis-fnos-build')));
const PROJ = path.join(OUT, 'jarvis');
const APP = path.join(PROJ, 'app');

// 从工作区拷 server/ 时要排掉的目录（相对 server/）
// fnos    = 工作台自己的 fpk（23MB），本应用用不上
// fnos-sh = **本应用自己的 fpk 交付物就放在这儿**——不排掉会把上一版的 26MB 包打进这一版
//           （2026-10-04 实测：第一次打出的 fpk 让第二次装配多了 26MB，逐版套娃翻倍；
//           工作台那条链在 §6 里被同一个坑咬过，靠 .gitattributes export-ignore 防的）
const SERVER_SKIP = new Set(['fnos', 'fnos-sh']);

// 最新前端构建产物（时间戳子目录，同 server/index.js 的 latestDistSh() 解析规则）
const distRoot = path.join(ROOT, 'web', 'dist-sh');
if (!fs.existsSync(distRoot)) { console.error('未找到 web/dist-sh，先执行 npm run build:web:sh'); process.exit(1); }
const latest = fs.readdirSync(distRoot)
  .filter((f) => fs.statSync(path.join(distRoot, f)).isDirectory() && fs.existsSync(path.join(distRoot, f, 'index.html')))
  .sort().pop();
if (!latest) { console.error('web/dist-sh 下没有含 index.html 的构建产物，先执行 npm run build:web:sh'); process.exit(1); }

fs.rmSync(PROJ, { recursive: true, force: true });
fs.mkdirSync(APP, { recursive: true });

// 1) 包骨架：manifest / 图标 / cmd / config / wizard（fnos-sh/ 目录即源）
for (const f of ['manifest', 'ICON.PNG', 'ICON_256.PNG', 'cmd', 'config', 'wizard']) {
  fs.cpSync(path.join(FNOS_DIR, f), path.join(PROJ, f), { recursive: true });
}
// 2) UI 入口：fnos-sh/app-ui → app/ui（manifest desktop_uidir=ui）
fs.cpSync(path.join(FNOS_DIR, 'app-ui'), path.join(APP, 'ui'), { recursive: true });

// 3) server/：从工作区拷（见文件头 ③ 的说明），跳过 SERVER_SKIP
fs.cpSync(path.join(ROOT, 'server'), path.join(APP, 'server'), {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(path.join(ROOT, 'server'), src);
    if (!rel) return true;
    const top = rel.split(path.sep)[0];
    return !SERVER_SKIP.has(top);
  },
});

// 4) 根文件 + 说明文档
fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(APP, 'package.json'));
fs.copyFileSync(path.join(ROOT, 'package-lock.json'), path.join(APP, 'package-lock.json'));
fs.copyFileSync(path.join(FNOS_DIR, 'README-FNOS.md'), path.join(APP, 'README-FNOS.md'));

// 5) 前端构建产物：只带最新一份（server/index.js 里 latestDistSh() 取最新的）
fs.cpSync(path.join(distRoot, latest), path.join(APP, 'web', 'dist-sh', latest), { recursive: true });

// 6) 生产依赖：优先用现成目录（同 lockfile、已验证零原生模块），否则现场安装
let nmSrc = argOf('--node-modules', '');
if (nmSrc) {
  fs.cpSync(nmSrc, path.join(APP, 'node_modules'), { recursive: true });
} else {
  console.log('[fpk-sh] 未指定 --node-modules，现场安装生产依赖（npm ci --omit=dev --ignore-scripts）...');
  execSync('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', { cwd: APP, stdio: 'inherit' });
}

// 版本一致性：manifest（应用中心显示的那个）必须与 server/shApp.js（应用内自称的那个）相同，
// 否则会出现「应用中心 1.0.0、页面里写着别的」这种对不上号的包。对不上直接退出，不放行。
{
  const manifestTxt = fs.readFileSync(path.join(FNOS_DIR, 'manifest'), 'utf8');
  const mVer = (manifestTxt.match(/^version\s*=\s*(.+)$/m) || [])[1]?.trim();
  const { createRequire } = await import('node:module');
  const shApp = createRequire(import.meta.url)(path.join(ROOT, 'server', 'shApp.js'));
  if (!mVer || mVer !== shApp.version) {
    console.error(`[fpk-sh] 版本不一致：fnos-sh/manifest 是 ${mVer}，server/shApp.js 是 ${shApp.version}。改齐再打包。`);
    process.exit(1);
  }
  console.log(`[fpk-sh] 版本一致：${mVer}（manifest == server/shApp.js）`);
}

// 装配自检：三样关键内容必须在位，缺一个这包就是废的
const must = [
  ['server/index.js', '服务端入口'],
  ['server/flash-tool/firmware/xiaozhi/xiaozhi.bin', '智能板固件模板'],
  ['server/cc-light/main.py', '红绿灯程序'],
  ['server/cc-light/ESP32_GENERIC_C3-20260824-v1.29.0.bin', '红绿灯固件'],
  [`web/dist-sh/${latest}/index.html`, '前端入口'],
  ['node_modules/express/package.json', '生产依赖'],
];
const missing = must.filter(([rel]) => !fs.existsSync(path.join(APP, rel)));
if (missing.length) {
  console.error('[fpk-sh] 装配自检失败，缺：' + missing.map(([r, d]) => `${r}（${d}）`).join('、'));
  process.exit(1);
}
// 套娃守卫：载荷里出现 fpk = 把上一版的包打进了这一版（见 SERVER_SKIP 注释）。宁可不发也不发这种包。
{
  const found = [];
  const walkFpk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) walkFpk(q);
      else if (e.name.toLowerCase().endsWith('.fpk')) found.push(path.relative(APP, q));
    }
  };
  walkFpk(path.join(APP, 'server'));
  if (found.length) {
    console.error('[fpk-sh] 载荷里混进了 fpk（逐版套娃）：' + found.join('、') + ' —— 检查 SERVER_SKIP');
    process.exit(1);
  }
}

// 目录体积：自己递归算，不 shell 出去调 du（本机 git-bash 环境下 `du` 会报「系统找不到指定的路径」
// 然后被 catch 吞成 0MB —— 输出看着像空包，实际有 30MB，误导过）
const dirSize = (p) => {
  let total = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const q = path.join(p, e.name);
    total += e.isDirectory() ? dirSize(q) : (() => { try { return fs.statSync(q).size; } catch { return 0; } })();
  }
  return total;
};
const du = (p) => { try { return Math.round(dirSize(p) / 1048576); } catch { return 0; } };
console.log(`[fpk-sh] 装配完成: ${PROJ}`);
console.log(`         dist-sh=${latest}  app≈${du(APP)}MB`);
console.log(`         下一步: python Logs/build-fpk-sh.py`);
