// fnpack 风格 manifest 格式化（§6 复刻链 ② 的脚本化）：
//   源 manifest 去空行保序 → `key.padEnd(27) + '= ' + value` → CRLF 行尾 → 末尾追加 checksum=MD5(app.tgz)
// 用法：node fnos/mk-manifest.mjs <app.tgz路径> <输出manifest路径>
//
// ⚠️ 1.12.6 应用中心拒装事故（2026-10-08）：旧版对无 '=' 的续行「原样透传」，多行 changelog
//   混进包里形成 93KB 的怪 manifest（裸行 + 伪 key 行），fnOS 解析直接拒收「不是合理的 fpk 程序」。
//   现规则：只有 `^[a-z_]+=` 形态的行才是新键，其余一律折叠进上一条 value（空格连接）；
//   产出逐行断言 27 列对齐、无内嵌换行、总量 ≤8KB，违规即 throw——宁可构建失败也不发废包。
//   源头纪律（配套）：fnos/manifest 的 changelog 只保留本版一条，历代记录看 CLAUDE.md §12 / git 历史。
import fs from 'node:fs';
import crypto from 'node:crypto';

const appTgz = process.argv[2], outPath = process.argv[3];
if (!appTgz || !outPath) { console.error('用法: node fnos/mk-manifest.mjs <app.tgz> <输出manifest>'); process.exit(2); }
const md5 = crypto.createHash('md5').update(fs.readFileSync(appTgz)).digest('hex');
const src = fs.readFileSync(new URL('./manifest', import.meta.url), 'utf8');

const entries = [];
for (const rawLine of src.split(/\r?\n/)) {
  const l = rawLine.trim();
  if (l === '' || /^checksum=/.test(l)) continue;
  if (/^[a-z_]+?=/.test(l)) {
    const i = l.indexOf('=');
    entries.push([l.slice(0, i), l.slice(i + 1)]);
  } else if (entries.length) {
    // 上一条 value 的续行：折叠成单行（绝不透传成裸行——那正是 1.12.6 拒装事故的形态）
    const last = entries[entries.length - 1];
    last[1] = (last[1] + ' ' + l).replace(/\s+/g, ' ');
  } else {
    throw new Error(`manifest 首个非空行不是 key=value: ${l.slice(0, 40)}`);
  }
}
const out = entries.map(([k, v]) => k.padEnd(27) + '= ' + v);
out.push('checksum'.padEnd(27) + '= ' + md5);

// 产出硬断言：每行 27 列对齐、key 非空、无内嵌换行、无裸 LF
for (const l of out) {
  if (l.indexOf('=') !== 27 || !l.slice(0, 27).trim()) throw new Error(`manifest 行不合规格: ${l.slice(0, 40)}`);
  if (/[\r\n]/.test(l)) throw new Error(`manifest 行内嵌换行: ${JSON.stringify(l.slice(0, 40))}`);
}
const text = out.join('\r\n') + '\r\n';
if ((text.match(/\n/g) || []).length !== (text.match(/\r\n/g) || []).length) throw new Error('manifest 存在裸 LF');
if (Buffer.byteLength(text) > 8192) throw new Error(`manifest ${Buffer.byteLength(text)}B 超 8KB 上限（changelog 该瘦身了）`);

fs.writeFileSync(outPath, text);
console.log('[manifest] ' + out.length + ' 行 / ' + Buffer.byteLength(text) + 'B → ' + outPath + '（checksum=' + md5 + '）');
