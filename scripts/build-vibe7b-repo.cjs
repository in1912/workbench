// 打包 VibeVoice 仓库子集（7B 客户端部署用）：vibevoice/ + vllm_plugin/ + pyproject.toml + README.md
// → server/vibe7b-repo.zip（随升级包分发，server/ 前缀过 apply 白名单；客户端部署脚本经
//   /vibe/client-download?f=vibe7b-repo.zip 下发，在 WSL 里 pip install -e . --no-deps 注册 vLLM 插件入口）。
// README.md 必须带上：pyproject readme 字段引用它，缺了 pip install -e 会直接构建失败。
// 用法: node scripts/build-vibe7b-repo.cjs [源仓库目录，默认 D:\CC\VibeVoice-main]
const fs = require('fs');
const path = require('path');
const { buildZip } = require('../server/services/zipService');

const SRC = path.resolve(process.argv[2] || 'D:/CC/VibeVoice-main');
const OUT = path.join(__dirname, '..', 'server', 'vibe7b-repo.zip');

const listFiles = (dir, rel, out) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) listFiles(path.join(dir, ent.name), r, out);
    else out.push(r);
  }
};

const entries = [];
for (const part of ['vibevoice', 'vllm_plugin']) {
  const dir = path.join(SRC, part);
  if (!fs.existsSync(dir)) throw new Error(`源目录不存在：${dir}`);
  const files = [];
  listFiles(dir, part, files);
  for (const rel of files) {
    if (rel.includes('/tests/') || rel.includes('/__pycache__/')) continue; // 测试与缓存不带
    entries.push({ name: rel, data: fs.readFileSync(path.join(SRC, rel)) });
  }
}
for (const f of ['pyproject.toml', 'README.md']) {
  const p = path.join(SRC, f);
  if (!fs.existsSync(p)) throw new Error(`缺少 ${f}（pip install -e 需要）：${p}`);
  entries.push({ name: f, data: fs.readFileSync(p) });
}

const zipBuf = buildZip(entries);
fs.writeFileSync(OUT, zipBuf);
console.log(`vibe7b-repo.zip 已生成: ${OUT}（${(zipBuf.length / 1024).toFixed(0)} KB，${entries.length} 个文件）`);
