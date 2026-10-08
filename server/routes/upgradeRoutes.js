// 升级管理：版本代码打包 + 升级日志
// 思路：以「基线清单」（settings 键 upgrade_baseline，记录每个源码文件的 sha256）
// 为参照，扫描时识别新增/修改文件；打包时把选中文件压成 zip 存入 data/upgrades/，
// 并在 upgrade_logs 表登记升级说明，形成可追溯、可下载的升级历史。
// 注意：按源码目录白名单扫描（server/web/src/scripts + 根文件），本地源码环境适用；
// Docker 容器内仅有 server/ 与 web/dist，扫描范围会相应缩小。
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { db, getSetting, setSetting, dataDir } = require('../db');
const { buildZip, extractZip } = require('../services/zipService');
const { gracefulRestart } = require('../services/restartService');

const router = express.Router();
router.use(express.json());

// 代码打包涉及源码与部署，仅管理员可用（挂在 /upgrade 前缀下，
// 不能用无路径的 router.use——那会拦下所有流经本 router 的请求，包括 /health）
router.use('/upgrade', (req, res, next) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
  next();
});

const ROOT = path.join(__dirname, '..', '..');      // 项目根目录（server/ 的上一级）
const PKG_DIR = path.join(dataDir, 'upgrades');     // 升级包存放目录（随 data 卷持久化）
if (!fs.existsSync(PKG_DIR)) fs.mkdirSync(PKG_DIR, { recursive: true });

// 扫描范围：白名单源码目录 + 根目录配置文件；node_modules 等一律排除。
// tts/ 只随包带引擎代码（moss_server.py + MOSS-TTS-Nano 仓库）：.venv/models/缓存等
// 大体积且每机各异的内容排除——目标机用「语音配音」页的一键安装器自行补齐。
// vibeasr/ 随包带 Windows 引擎二进制（win-x64 的 exe+3 个 MinGW DLL，共约 5.6MB）：
// 生产容器是 Linux，自身引擎由一键安装器源码编译；这 4 个文件专供「客户端电脑算力」
// 部署包下发（clientFileList 只认 *.exe/*.dll，Linux 产物不会被误发）。
// whisper.cpp 引擎二进制在 server/whisper/<plat>-<arch>/（server/ 前缀天然过应用白名单，
// 不设独立顶层 whisper/ 目录——旧容器白名单会跳过新前缀，v1.5.0 踩过同款鸡生蛋）。
// zhizu/（智作平台子服务，v1.6.2）：只带代码 + web/dist 构建产物，绝不带运行数据。
// 子进程数据库走持久卷 /data/zhizu（zhizuService 里 DATA_DIR 命名空间化）；仓库里的
// zhizu/data/ 是本地开发库，靠 EXCLUDE_DIRS 里的 'data' 排除（各子树下均无同名目录，加它无副作用）。
// 为什么现在才加：应用侧 applyTargetPath 一直认 zhizu/ 前缀，打包侧却漏了它，于是包永远不含
// zhizu —— 2026-10-02 容器被重建（可写层清空，/app/zhizu 随之消失）后，应用 1.9.29 包也救不回来，
// 智作平台从此停在「正在启动，请稍候…」（子服务目录不存在 → zhizuService.start() 直接跳过）。
const INCLUDE_DIRS = ['server', 'web/src', 'web/public', 'scripts', 'tts', 'vibeasr', 'zhizu'];
const EXCLUDE_DIRS = new Set(['node_modules', '.git', 'Logs', '.claude', 'backups', '__pycache__', '.venv', 'hf-cache', 'models', 'cache', 'voices', 'tmp', 'generated_audio', 'examples', 'data']);
function isRootFileIncluded(name) {
  if (name === 'Dockerfile' || name === 'docker-compose.yml' || name === '.dockerignore') return true;
  return /\.(js|vue|json|css|html|md|sh|bat|ps1|yml|yaml|txt)$/.test(name);
}

// 递归扫描源码，返回 [{path(相对路径,正斜杠), size, mtime}]
async function walkSource() {
  const out = [];
  const skipAbs = new Set([path.resolve(dataDir), path.resolve(PKG_DIR)]);
  async function recurse(dir, rel) {
    for (const ent of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (EXCLUDE_DIRS.has(ent.name) || skipAbs.has(path.resolve(abs))) continue;
        await recurse(abs, r);
      } else if (ent.isFile()) {
        const st = await fs.promises.stat(abs);
        out.push({ path: r, size: st.size, mtime: st.mtime.toISOString() });
      }
    }
  }
  for (const d of INCLUDE_DIRS) {
    const abs = path.join(ROOT, d);
    if (fs.existsSync(abs)) await recurse(abs, d);
  }
  for (const ent of fs.readdirSync(ROOT, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (ent.isFile() && isRootFileIncluded(ent.name)) {
      const st = fs.statSync(path.join(ROOT, ent.name));
      out.push({ path: ent.name, size: st.size, mtime: st.mtime.toISOString() });
    }
  }
  return out;
}

async function hashFile(abs) {
  return crypto.createHash('sha256').update(await fs.promises.readFile(abs)).digest('hex');
}

// 校验提交的文件路径：正斜杠相对路径、无越权段、且落在扫描白名单内（防任意文件读取）
function safeRelPath(p) {
  if (typeof p !== 'string') return null;
  const rel = p.replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!rel || /^[a-zA-Z]:/.test(rel)) return null;
  const parts = rel.split('/');
  if (parts.some((s) => !s || s === '.' || s === '..')) return null;
  if (parts.length > 1) {
    const dir = parts.slice(0, -1).join('/');
    if (!INCLUDE_DIRS.some((d) => dir === d || dir.startsWith(d + '/'))) return null;
    if (parts.slice(0, -1).some((seg) => EXCLUDE_DIRS.has(seg))) return null;
  } else if (!isRootFileIncluded(rel)) {
    return null;
  }
  return rel;
}

function localTs() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// 最新前端构建快照目录名（web/dist/<ts>，服务启动时也是选最新；无则 null）
function latestDist() {
  const distDir = path.join(ROOT, 'web', 'dist');
  if (!fs.existsSync(distDir)) return null;
  const subs = fs.readdirSync(distDir)
    .filter((f) => fs.existsSync(path.join(distDir, f, 'index.html')))
    .sort();
  return subs.length ? subs[subs.length - 1] : null;
}

// 覆盖文件：优先 rename（同盘原子），跨文件系统（Docker 卷 → 容器层）退化为 copy
function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (e) {
    if (e.code === 'EXDEV' || e.code === 'EPERM' || e.code === 'EBUSY') {
      fs.copyFileSync(src, dest);
      fs.unlinkSync(src);
    } else {
      throw e;
    }
  }
}

// ---------- 扫描：与基线比对，标出新增/修改 ----------
router.get('/upgrade/scan', async (req, res) => {
  try {
    const baseline = getSetting(db, 'upgrade_baseline', { files: {}, updated_at: null });
    const files = await walkSource();
    const list = [];
    let nNew = 0, nChanged = 0, nUnchanged = 0;
    for (const f of files) {
      const hash = await hashFile(path.join(ROOT, f.path));
      const old = baseline.files[f.path];
      const status = !old ? 'new' : old === hash ? 'unchanged' : 'changed';
      if (status === 'new') nNew++; else if (status === 'changed') nChanged++; else nUnchanged++;
      list.push({ ...f, hash, status });
    }
    const seen = new Set(list.map((f) => f.path));
    const removed = Object.keys(baseline.files).filter((p) => !seen.has(p));
    res.json({
      files: list,
      counts: { new: nNew, changed: nChanged, unchanged: nUnchanged, removed: removed.length },
      removed,
      baseline_at: baseline.updated_at || null,
      latest_dist: latestDist(),
      current_version: getSetting(db, 'current_version', '') || '',
      total: list.length,
    });
  } catch (e) {
    res.status(500).json({ error: '扫描失败：' + e.message });
  }
});

// ---------- 打包：选中文件 + 最新前端构建快照 → zip 存盘 + 写升级日志 + 更新基线 ----------
router.post('/upgrade/package', async (req, res) => {
  try {
    const { version, title, content, files } = req.body || {};
    const ver = String(version || '').trim();
    if (!ver) return res.status(400).json({ error: '请填写版本号' });
    if (!Array.isArray(files) || !files.length) return res.status(400).json({ error: '请至少选择一个文件' });
    const baseline = getSetting(db, 'upgrade_baseline', { files: {}, updated_at: null });

    const entries = [];
    const manifest = [];
    for (const p of [...new Set(files)]) {
      const rel = safeRelPath(p);
      if (!rel) return res.status(400).json({ error: `非法文件路径：${p}` });
      const abs = path.join(ROOT, rel);
      let st;
      try { st = await fs.promises.stat(abs); } catch { return res.status(400).json({ error: `文件不存在：${rel}` }); }
      if (!st.isFile()) return res.status(400).json({ error: `不是普通文件：${rel}` });
      const data = await fs.promises.readFile(abs);
      const hash = crypto.createHash('sha256').update(data).digest('hex');
      const old = baseline.files[rel];
      const status = !old ? 'new' : old === hash ? 'unchanged' : 'changed';
      entries.push({ name: rel, data, mtime: st.mtime });
      manifest.push({ path: rel, size: st.size, hash, status });
    }

    // 自动附带最新前端构建快照：NAS 容器内没有 vite，覆盖 web/dist/<ts> 即可直接运行
    const dist = latestDist();
    let distFiles = 0;
    if (dist) {
      const distRoot = path.join(ROOT, 'web', 'dist', dist);
      const addDir = async (dir, rel) => {
        for (const ent of await fs.promises.readdir(dir, { withFileTypes: true })) {
          const r = rel ? `${rel}/${ent.name}` : ent.name;
          if (ent.isDirectory()) await addDir(path.join(dir, ent.name), r);
          else {
            const data = await fs.promises.readFile(path.join(dir, ent.name));
            entries.push({ name: `web/dist/${dist}/${r}`, data });
            distFiles++;
          }
        }
      };
      await addDir(distRoot, '');
    }

    const now = new Date();
    const pkgName = `${localTs()}_${ver.replace(/[\\/:*?"<>|\r\n]+/g, '_')}.zip`;
    const meta = {
      version: ver,
      title: String(title || '').trim(),
      content: String(content || '').trim(),
      dist: dist || '',
      files: manifest,
      dist_files: distFiles,
      created_at: now.toISOString(),
      created_by: req.user.username,
    };
    const statusText = { new: '新增', changed: '修改', unchanged: '未变更' };
    const md = [
      `# 升级包 ${ver}`, '',
      `- 标题：${meta.title || '（无）'}`,
      `- 时间：${now.toLocaleString('zh-CN')}`,
      `- 打包人：${req.user.username}`,
      `- 源码文件：${manifest.length} 个`,
      `- 前端构建快照：${dist ? `${dist}（${distFiles} 个文件）` : '无（本次未附带，需在目标机自行构建）'}`, '',
      '## 升级内容', '',
      meta.content || '（未填写）', '',
      '## 文件清单', '',
      ...manifest.map((m) => `- ${m.path}（${statusText[m.status]}，${m.size}B）`),
      '',
    ].join('\n');
    entries.unshift({ name: 'manifest.json', data: JSON.stringify(meta, null, 2), mtime: now });
    entries.unshift({ name: 'UPGRADE.md', data: md, mtime: now });

    const zipBuf = buildZip(entries);
    await fs.promises.writeFile(path.join(PKG_DIR, pkgName), zipBuf);

    const r = db.prepare(
      `INSERT INTO upgrade_logs(version,title,content,file_count,package_name,package_size,files_json,created_by,source)
       VALUES(?,?,?,?,?,?,?,?, 'package')`
    ).run(ver, meta.title, meta.content, manifest.length, pkgName, zipBuf.length, JSON.stringify(manifest), req.user.username);

    // 基线只更新已打包文件：未勾选的改动下次扫描仍会提示，避免遗漏出包
    for (const m of manifest) baseline.files[m.path] = m.hash;
    baseline.updated_at = now.toISOString();
    setSetting(db, 'upgrade_baseline', baseline);
    setSetting(db, 'current_version', ver); // 本机代码状态即该版本

    res.json({ id: Number(r.lastInsertRowid), package_name: pkgName, package_size: zipBuf.length, file_count: manifest.length, dist, dist_files: distFiles });
  } catch (e) {
    res.status(500).json({ error: '打包失败：' + e.message });
  }
});

// ---------- 应用升级包：上传 zip → 安全校验 → 覆盖 server/ 与 web/dist/ → 自动重启 ----------
// 用于 NAS/服务器端接收本地生成的升级包：Docker 的 restart: always 会在进程退出后
// 自动拉起容器（可写层保留），新代码与新前端快照即生效；本地直跑则需手动重启。
// 上限 100→256MB（v1.12.6）：server/fnos 的 fpk 随包含 dws/wecom linux 二进制后涨到 66MB，
// 全量升级包 ~123MB，100MB 上限必拒（v1.9.39 的 103MB 打包事故是同类）；
// 此路由要管理员登录，提额不扩大攻击面。
const applyUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 256 * 1024 * 1024 } });

// 应用端路径白名单：容器内只需要可运行部分（server 源码 + 前端构建产物 + tts/vibeasr 引擎文件 + zhizu 子服务）。
// web/src、scripts、根文件等源码条目不落盘（容器内无构建环境，仅留档于包内）。
// tts/ 落到容器层 /app/tts：引擎的 venv/模型由一键安装器装进持久卷 /data/tts，
// 仓库代码副本留在 /app/tts 供安装器离线复用。
// zhizu/ 落到 /app/zhizu：智作平台子服务运行时（server 源码 + web/dist + package.json）；
// 其数据库走子进程 DATA_DIR=/data/zhizu（持久卷），data/ 子目录永不入包。
function applyTargetPath(name) {
  const rel = String(name || '').replace(/\\/g, '/');
  // web/public/：测评中心 H5 静态（v1.6.3 运行时门禁要更新 H5 的 js/server.js）。
  // 旧容器白名单无此前缀，H5 一直停留在镜像内置版本——v1.6.3-pre 先发本文件扩白名单，主包 H5 才能落盘。
  if (!rel.startsWith('server/') && !rel.startsWith('web/dist/') && !rel.startsWith('web/public/') && !rel.startsWith('tts/') && !rel.startsWith('vibeasr/') && !rel.startsWith('zhizu/')) return null;
  const parts = rel.split('/');
  if (parts.some((s) => !s || s === '.' || s === '..')) return null;
  return rel;
}

router.post('/upgrade/apply', applyUpload.single('file'), async (req, res) => {
  let staging = null;
  try {
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: '未收到升级包文件' });
    const entries = extractZip(req.file.buffer);
    const mf = entries.find((e) => e.name === 'manifest.json');
    if (!mf) return res.status(400).json({ error: '不是本系统生成的升级包（缺少 manifest.json）' });
    let meta;
    try { meta = JSON.parse(mf.data.toString('utf8')); } catch { return res.status(400).json({ error: '升级包 manifest 解析失败' }); }
    if (!meta.version) return res.status(400).json({ error: '升级包缺少版本号，拒绝应用' });

    // 先完整解压到临时目录，全部成功后再统一覆盖（避免半新半旧）
    staging = path.join(PKG_DIR, `.staging_${localTs()}_${process.pid}`);
    fs.mkdirSync(staging, { recursive: true });
    const staged = [];
    let skipped = 0;
    for (const e of entries) {
      if (e.name === 'manifest.json' || e.name === 'UPGRADE.md') continue;
      const rel = applyTargetPath(e.name);
      if (!rel) { skipped++; continue; } // web/src、scripts、根文件等：容器内用不上，跳过
      const sp = path.join(staging, ...rel.split('/'));
      fs.mkdirSync(path.dirname(sp), { recursive: true });
      fs.writeFileSync(sp, e.data);
      staged.push({ rel, sp });
    }
    if (!staged.length) return res.status(400).json({ error: '升级包中没有可应用的文件（server/ 或 web/dist/）' });

    let applied = 0;
    for (const s of staged) {
      const dest = path.join(ROOT, ...s.rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      moveFile(s.sp, dest);
      applied++;
    }

    // 上传的包留档 + 写应用日志 + 版本锚点
    const pkgName = `${localTs()}_applied_${String(meta.version).replace(/[\\/:*?"<>|\r\n]+/g, '_')}.zip`;
    fs.writeFileSync(path.join(PKG_DIR, pkgName), req.file.buffer);
    db.prepare(
      `INSERT INTO upgrade_logs(version,title,content,file_count,package_name,package_size,files_json,created_by,source)
       VALUES(?,?,?,?,?,?,?,?, 'applied')`
    ).run(String(meta.version), String(meta.title || ''), String(meta.content || ''), applied, pkgName,
      req.file.buffer.length, JSON.stringify((meta.files || []).map((f) => ({ path: f.path, size: f.size, status: f.status }))), req.user.username);
    setSetting(db, 'current_version', String(meta.version));

    res.json({ ok: true, version: String(meta.version), applied, skipped });
    console.log(`[upgrade] 已应用升级包 ${meta.version}（${applied} 个文件），服务即将重启`);
    // Docker：restart=always 自动拉起；本地直跑由接替进程接管
    gracefulRestart('升级应用后重启');
  } catch (e) {
    if (staging) { try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* 清理失败不影响报错 */ } }
    res.status(500).json({ error: '应用升级包失败：' + e.message });
  }
});

// ---------- 重置基线：把当前全部源码状态标记为基线（不打包，用于首次建立参照或对齐） ----------
router.post('/upgrade/baseline', async (req, res) => {
  try {
    const files = await walkSource();
    const map = {};
    for (const f of files) map[f.path] = await hashFile(path.join(ROOT, f.path));
    setSetting(db, 'upgrade_baseline', { files: map, updated_at: new Date().toISOString() });
    res.json({ ok: true, count: files.length });
  } catch (e) {
    res.status(500).json({ error: '重置基线失败：' + e.message });
  }
});

// ---------- 升级日志 ----------
router.get('/upgrade/list', (req, res) => {
  const rows = db.prepare('SELECT * FROM upgrade_logs ORDER BY id DESC').all();
  res.json({ logs: rows.map((r) => ({ ...r, files: JSON.parse(r.files_json || '[]'), files_json: undefined })) });
});

router.put('/upgrade/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM upgrade_logs WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  const { title, content } = req.body || {};
  db.prepare('UPDATE upgrade_logs SET title=?, content=? WHERE id=?')
    .run(title !== undefined ? String(title).trim() : row.title, content !== undefined ? String(content).trim() : row.content, req.params.id);
  res.json({ ok: true });
});

router.get('/upgrade/:id/download', (req, res) => {
  const row = db.prepare('SELECT * FROM upgrade_logs WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  const abs = path.join(PKG_DIR, row.package_name);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: '升级包文件已丢失（data/upgrades 目录可能被清理）' });
  const name = `upgrade_${row.version}.zip`.replace(/[\\/:*?"<>|]/g, '_');
  // RFC 5987：filename* 支持 UTF-8 中文，filename 兜底 ASCII（与文件存档下载一致）
  res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('Content-Type', 'application/zip');
  fs.createReadStream(abs).pipe(res);
});

router.delete('/upgrade/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM upgrade_logs WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  db.prepare('DELETE FROM upgrade_logs WHERE id=?').run(req.params.id);
  try { fs.unlinkSync(path.join(PKG_DIR, row.package_name)); } catch { /* 包文件已不在则跳过 */ }
  res.json({ ok: true });
});

module.exports = router;
