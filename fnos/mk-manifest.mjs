// fnpack 风格 manifest 格式化（§6 复刻链 ② 的脚本化）：
//   源 manifest 去空行保序 → `key.padEnd(27) + '= ' + value` → CRLF 行尾 → 末尾追加 checksum=MD5(app.tgz)
// 用法：node fnos/mk-manifest.mjs <app.tgz路径> <输出manifest路径>
import fs from 'node:fs';
import crypto from 'node:crypto';

const appTgz = process.argv[2], outPath = process.argv[3];
if (!appTgz || !outPath) { console.error('用法: node fnos/mk-manifest.mjs <app.tgz> <输出manifest>'); process.exit(2); }
const md5 = crypto.createHash('md5').update(fs.readFileSync(appTgz)).digest('hex');
const src = fs.readFileSync(new URL('./manifest', import.meta.url), 'utf8');
const kept = src.split(/\r?\n/).filter((l) => l.trim() !== '' && !/^checksum=/.test(l));
const out = kept.map((l) => {
  const i = l.indexOf('=');
  if (i < 0) throw new Error('manifest 行缺 =：' + l.slice(0, 40));
  return l.slice(0, i).padEnd(27) + '= ' + l.slice(i + 1);
});
out.push('checksum'.padEnd(27) + '= ' + md5);
fs.writeFileSync(outPath, out.join('\r\n') + '\r\n');
console.log('[manifest] ' + out.length + ' 行 → ' + outPath + '（checksum=' + md5 + '）');
