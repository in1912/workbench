// build-dist-packages.mjs —— 生成三端分发压缩包（Windows / macOS / Docker），全部不含个人数据。
// 产物落在仓库根目录（用户指定）：全能工作台-<版本>-windows.zip / -macos.zip / -docker.zip
// 原则：只带「能跑起来的最小运行集」——data/ 一律空壳、Logs/ 不带、TTS 模型权重与合成语音缓存不带、
//       fpk 安装包不带、web/dist 只带最新一份；img/ 要带（README 的模块截图，2026-10-02 用户要求图片必须可用）。
// 用法：node scripts/build-dist-packages.mjs [--out <目录>]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const outArg = process.argv.indexOf('--out');
const OUT = outArg > -1 ? path.resolve(process.argv[outArg + 1]) : ROOT;
const STAGE_ROOT = process.env.DIST_STAGE || 'D:/CC/workbench-dist';

// 最新前端构建产物（web/dist 下按时间戳累积，只带最新的）
const distDir = path.join(ROOT, 'web', 'dist');
const latestDist = fs.readdirSync(distDir).filter((d) => /^\d{10,}$/.test(d)).sort().pop();
if (!latestDist) throw new Error('web/dist 下没有版本目录，请先 npm run build:web');

const A = (...p) => path.join(...p);

// ---------- 排除清单（个人数据 / 可再生的大货） ----------
const XD_COMMON = [ // 目录
  A(ROOT, 'server', 'fnos'),                    // 只放 fpk 安装包（22MB），分发包不需要
  A(ROOT, 'zhizu', 'node_modules'),
  A(ROOT, 'zhizu', 'data'),
  A(ROOT, 'web', 'node_modules'),
  A(ROOT, 'tts', 'cache'),                      // 合成语音缓存 = 个人数据
  A(ROOT, 'tts', 'MOSS-TTS-Nano'),              // 模型权重 ~758MB
  A(ROOT, 'tts', '.venv'),
  A(ROOT, 'tts', 'hf-cache'),
  A(ROOT, 'tts', 'generated_audio'),
  A(ROOT, 'tts', '__pycache__'),
  A(ROOT, 'tts', 'examples'),
  A(ROOT, 'tts', 'tmp'),
];
const XF_COMMON = ['repro-*.mjs']; // 漏洞复现脚本不分发

function rc(relSrc, relDst, extra = []) {
  const src = A(ROOT, relSrc);
  if (!fs.existsSync(src)) { console.log(`   · 跳过（不存在）${relSrc}`); return; }
  const dst = A(relDst, relSrc);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const args = [src, dst, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP', '/MT:16', ...extra];
  const r = spawnSync('robocopy', args, { stdio: 'ignore' });
  if ((r.status ?? 0) >= 8) throw new Error(`robocopy ${relSrc} 失败 code=${r.status}`);
}

function cpFile(relSrc, relDst) {
  const src = A(ROOT, relSrc);
  if (!fs.existsSync(src)) { console.log(`   · 跳过（不存在）${relSrc}`); return; }
  const dst = A(relDst, relSrc);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function deployNote(variant) {
  const common = [
    `全能工作台 v${VERSION}（${variant} 版）`,
    '',
    '本包不含任何历史个人数据：data/ 是空目录，首次启动会自动建库。',
    `首次登录：admin / admin123 —— 登录后请立刻在「设置 → 用户管理」里改掉。`,
    '',
  ];
  const byVariant = {
    windows: [
      '【Windows 部署】',
      '1. 解压到任意目录（路径别太长、别含特殊符号）。',
      '2. 需要 Node.js 22.5 或更高版本（https://nodejs.org 下载 LTS）。',
      '3. 双击 start.bat，浏览器打开 http://localhost:3000 。',
      '4. 依赖（node_modules）已随包附带，无需联网安装。',
      '',
      '【可选功能补齐】',
      '· 浏览器自动化（业务系统 Skill）需要 Chromium，首次用到时在该目录执行：',
      '    npx playwright install chromium',
      '· 录音转写 / 语音配音：到「效率工具 → 录音转写」页按提示装引擎（要联网下模型）。',
    ],
    macos: [
      '【macOS 部署】',
      '1. 解压到任意目录。',
      '2. 需要 Node.js 22.5 或更高版本（https://nodejs.org 或 brew install node）。',
      '3. 首次运行前给启动器加执行权限：',
      '    cd 解压出来的目录 && chmod +x start.command',
      '   然后双击 start.command（或 ./start.command）。',
      '4. 浏览器打开 http://localhost:3000 。',
      '5. 依赖（node_modules）已随包附带，正常无需联网安装；若提示缺依赖，在该目录执行 npm install。',
      '',
      '【可选功能补齐】',
      '· 浏览器自动化需要 Chromium：npx playwright install chromium',
      '· 独立转写引擎（vibeasr）只提供 Windows / Linux 预编译版，macOS 上该功能不可用，',
      '  请在「录音转写」页改用其它引擎。',
    ],
    docker: [
      '【Docker 部署】',
      '1. 把整个目录上传到服务器（或群晖 / 飞牛 NAS）。',
      '2. 按需改 docker-compose.yml 里的挂载路径。',
      '3. 在目录里执行：',
      '    docker compose up -d --build',
      '4. 容器 restart: always，开机自动启动。',
      '5. 浏览器打开 http://<服务器IP>:3000 。',
      '',
      '【说明】',
      '· 镜像里已自带 Chromium（浏览器自动化开箱可用）。',
      '· DATA_DIR=/data，数据落在宿主机 ./data 目录（compose 已挂载）。',
      '· 本包不含 node_modules，依赖在 docker build 时安装（走 npmmirror 国内镜像）。',
    ],
  };
  return [...common, ...byVariant[variant], '', '完整功能说明与截图见 README.md。'].join('\n');
}

const VARIANTS = [
  {
    key: 'windows', label: 'Windows',
    dirs: [['server'], ['web', 'src'], ['web', 'public'], [A('web', 'dist', latestDist)], ['zhizu'], ['tts'], ['vibeasr'], ['scripts'], ['img'], ['node_modules']],
    files: ['package.json', 'package-lock.json', 'README.md', 'start.bat', '.gitignore', '.gitattributes'],
  },
  {
    key: 'macos', label: 'macOS',
    dirs: [['server'], ['web', 'src'], ['web', 'public'], [A('web', 'dist', latestDist)], ['zhizu'], ['tts'], ['scripts'], ['img'], ['node_modules']],
    files: ['package.json', 'package-lock.json', 'README.md', 'start.command', '.gitignore', '.gitattributes'],
  },
  {
    key: 'docker', label: 'Docker',
    dirs: [['server'], ['web', 'src'], ['web', 'public'], [A('web', 'dist', latestDist)], ['zhizu'], ['tts'], ['vibeasr'], ['scripts'], ['img']],
    files: ['package.json', 'package-lock.json', 'README.md', 'Dockerfile', 'docker-compose.yml', '.dockerignore', 'pack-deploy.sh', '.gitignore', '.gitattributes'],
  },
];

fs.mkdirSync(STAGE_ROOT, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
console.log(`版本 ${VERSION}｜前端构建产物只带 ${latestDist}\n`);

const result = [];
for (const v of VARIANTS) {
  const dirName = `全能工作台-${VERSION}-${v.key}`;
  const STAGE = A(STAGE_ROOT, dirName);
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  console.log(`── ${v.label} → ${dirName}`);

  const xd = XD_COMMON.map((p) => ['/XD', p]).flat();
  const xf = XF_COMMON.map((p) => ['/XF', p]).flat();
  for (const seg of v.dirs) rc(A(...seg), STAGE, [...xd, ...xf]);
  for (const f of v.files) cpFile(f, STAGE);

  // 空 data/（让「数据在 data/」一目了然；首启自动建库）
  fs.mkdirSync(A(STAGE, 'data'), { recursive: true });
  fs.writeFileSync(A(STAGE, '部署说明.txt'), deployNote(v.key), 'utf8');

  const zip = A(OUT, `${dirName}.zip`);
  fs.rmSync(zip, { force: true });
  // 必须用 scripts/zip-utf8.py：bsdtar 不给中文名打 UTF-8 标志，Windows 解压会乱码
  const z = spawnSync('python', [A(ROOT, 'scripts', 'zip-utf8.py'), STAGE, zip], { stdio: 'inherit' });
  if (z.status !== 0) throw new Error(`压缩失败 code=${z.status}（${zip}）`);
  const mb = (fs.statSync(zip).size / 1048576).toFixed(1);
  console.log(`   ✅ ${path.basename(zip)}  ${mb} MB\n`);
  result.push({ variant: v.key, zip, mb });
}

console.log('════════ 结果 ════════');
for (const r of result) console.log(`  ${r.variant.padEnd(8)} ${r.mb.padStart(6)} MB  ${r.zip}`);
