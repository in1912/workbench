// 把测评中心 H5 同步进工作台静态目录 web/public/<tag>/（Vite 原样拷进 dist，/dep/ /pro/ 免登录访问）。
// 三中心共用一个脚本：node scripts/sync-testcenter.mjs dep|pro
// 源目录约定：D:/CC/dep-test（抑郁测试中心）、D:/CC/pro-test（专业心理测评中心），
// 由 mbti-test 的 tools/clone-center.js 生成代码骨架 + 各自 fun/ 题库。
// 只拷贝运行所需文件：index.html + css/ + js/ + fun/（不带 tools 等构建资产）。
import fs from 'node:fs';
import path from 'node:path';

const TAG = process.argv[2];
if (TAG !== 'dep' && TAG !== 'pro') {
  console.error('用法：node scripts/sync-testcenter.mjs dep|pro');
  process.exit(1);
}
const SRC = process.argv[3] || `D:/CC/${TAG}-test`;
const DST = path.join(process.cwd(), 'web', 'public', TAG);

if (!fs.existsSync(path.join(SRC, 'index.html'))) {
  console.error(`源目录不存在或缺少 index.html: ${SRC}`);
  process.exit(1);
}

fs.rmSync(DST, { recursive: true, force: true });
fs.mkdirSync(DST, { recursive: true });

let count = 0, bytes = 0;
function copyFile(rel) {
  const s = path.join(SRC, rel);
  if (!fs.existsSync(s)) { console.error(`源文件缺失: ${rel}`); process.exit(1); }
  const d = path.join(DST, rel);
  fs.mkdirSync(path.dirname(d), { recursive: true });
  const buf = fs.readFileSync(s);
  fs.writeFileSync(d, buf);
  count++; bytes += buf.length;
}
function copyDir(rel) {
  const srcDir = path.join(SRC, rel);
  if (!fs.existsSync(srcDir)) { console.error(`源目录缺失: ${rel}`); process.exit(1); }
  for (const name of fs.readdirSync(srcDir)) {
    const s = path.join(SRC, rel + '/' + name);
    if (fs.statSync(s).isDirectory()) { copyDir(path.join(rel, name)); continue; } // 子目录递归
    copyFile(path.join(rel, name));
  }
}
// 白名单与 sync-mbti.mjs 一致：index.html + css/ + js/ + fun/（量表题库，懒加载）
copyFile('index.html');
copyDir('css');
copyDir('js');
copyDir('fun');
console.log(`[${TAG}] 已同步 ${count} 个文件（${(bytes / 1024).toFixed(1)} KB）→ ${DST}`);
