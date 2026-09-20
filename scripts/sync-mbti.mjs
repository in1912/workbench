// 把 MBTI H5（D:/CC/mbti-test）同步进工作台静态目录 web/public/mbti/：
// Vite 构建时会原样拷进 dist，Express 静态托管后即可通过 /mbti/index.html 访问（免登录）。
// 用法：node scripts/sync-mbti.mjs [H5源目录，默认 D:/CC/mbti-test]
// 只拷贝运行所需文件：index.html + css/ + js/（不带 fpk/tools/data 等构建与打包资产）。
import fs from 'node:fs';
import path from 'node:path';

const SRC = process.argv[2] || 'D:/CC/mbti-test';
const DST = path.join(process.cwd(), 'web', 'public', 'mbti');

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
    const s = path.join(srcDir, name);
    if (fs.statSync(s).isDirectory()) { copyDir(path.join(rel, name)); continue; } // 子目录递归（fun/img/ 题图）
    copyFile(path.join(rel, name));
  }
}
// 白名单：根目录只要 index.html（favicon 是内联 data URL），其余只带 css/ js/ 与 fun/（趣味测试题库，懒加载）
copyFile('index.html');
copyDir('css');
copyDir('js');
copyDir('fun');
console.log(`已同步 ${count} 个文件（${(bytes / 1024).toFixed(1)} KB）→ ${DST}`);
