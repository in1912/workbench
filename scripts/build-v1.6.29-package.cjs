// v1.6.29 升级包构建：智能家居「监控」tab 与摄像头事件凭证（micam）下线
// 用法：node scripts/build-v1.6.29-package.cjs
// 产物：data/upgrades/<时间戳>_v1.6.29.zip（manifest + UPGRADE.md + 改动源码 + 前端构建快照）
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildZip } = require('../server/services/zipService');

const ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(ROOT, 'data', 'upgrades');
const VER = 'v1.6.29';
const DIST = '202609290228'; // 本次 npm run build 产物目录（服务端按名字排序取最新）

// 本次改动的服务端文件（apply 白名单内才落盘；web/src 与根文件仅随仓库走，不进容器）
const FILES = [
  'server/db.js',
  'server/index.js',
  'server/auth.js',
  'server/routes/mihomeRoutes.js',
  'server/services/mihomeService.js',
];

const CONTENT = [
  '1. 智能家居：移除「监控」tab（小米云已停出流，直播通道整体下线），页面只留 米家 / 参数翻译 / 设置 三个 tab；',
  '   旧链接 ?tab=monitor 落到米家、?tab=verify 落到设置，不出现空白页。',
  '2. 智能家居设置：移除「摄像头事件凭证」卡片与二次验证表单（micam 全部接口下线，历史注入的凭证密文随迁移清理）。',
  '3. 侧边栏默认顺序与名称对齐线上系统；前端移除 hls.js 依赖；README 重写。',
].join('\n');

function hashFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16);
}

(async () => {
  const now = new Date();
  const entries = [];
  const manifest = [];
  for (const rel of FILES) {
    const abs = path.join(ROOT, rel);
    const data = fs.readFileSync(abs);
    entries.push({ name: rel, data, mtime: fs.statSync(abs).mtime });
    manifest.push({ path: rel, size: data.length, hash: hashFile(abs), status: 'changed' });
  }
  // 前端构建快照（目标容器无 vite，直接落 web/dist/<ts> 即可运行）
  const distRoot = path.join(ROOT, 'web', 'dist', DIST);
  if (!fs.existsSync(path.join(distRoot, 'index.html'))) {
    console.error(`前端构建快照不存在：web/dist/${DIST}（先在 web/ 执行 npm run build）`);
    process.exit(1);
  }
  let distFiles = 0;
  const addDir = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isDirectory()) addDir(path.join(dir, ent.name), rel + ent.name + '/');
      else {
        entries.push({ name: `web/dist/${DIST}/${rel}${ent.name}`, data: fs.readFileSync(path.join(dir, ent.name)) });
        distFiles++;
      }
    }
  };
  addDir(distRoot, '');

  const meta = {
    version: VER,
    title: '智能家居监控与摄像头凭证通道下线',
    content: CONTENT,
    dist: DIST,
    files: manifest,
    dist_files: distFiles,
    created_at: now.toISOString(),
    created_by: 'admin',
  };
  const statusText = { new: '新增', changed: '修改', unchanged: '未变更' };
  const md = [
    `# ${VER} ${meta.title}`, '',
    `- 时间：${now.toLocaleString('zh-CN')}`,
    `- 源码文件：${manifest.length} 个`,
    `- 前端构建快照：${DIST}（${distFiles} 个文件）`, '',
    '## 升级内容', '',
    CONTENT, '',
    '## 文件清单', '',
    ...manifest.map((m) => `- ${m.path}（${statusText[m.status]}，${m.size}B）`),
    '',
  ].join('\n');
  entries.unshift({ name: 'manifest.json', data: JSON.stringify(meta, null, 2), mtime: now });
  entries.unshift({ name: 'UPGRADE.md', data: md, mtime: now });

  const zipBuf = buildZip(entries);
  const ts = now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0')
    + String(now.getDate()).padStart(2, '0') + String(now.getHours()).padStart(2, '0')
    + String(now.getMinutes()).padStart(2, '0') + String(now.getSeconds()).padStart(2, '0');
  const pkgName = `${ts}_${VER}.zip`;
  fs.mkdirSync(PKG_DIR, { recursive: true });
  fs.writeFileSync(path.join(PKG_DIR, pkgName), zipBuf);
  console.log(`已生成 data/upgrades/${pkgName}（${(zipBuf.length / 1024 / 1024).toFixed(2)} MB，源码 ${manifest.length} 个 + 前端 ${distFiles} 个）`);
})();
