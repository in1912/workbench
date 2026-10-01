// 邮箱入库语句回归测试：把 emailService.js 里写死的 SQL 全部抽出来，用**真实 schema** 逐条 prepare。
// 起因：v1.7.0 多邮箱改造时收件箱那条 INSERT 列名加了 2 个、占位符只加了 1 个，
//       SQLite 在 prepare 阶段就抛「7 values for 8 columns」，刷新收件箱必失败（v1.9.29 修）。
//       这类「列/值/参数个数对不上」的错误只有真跑一遍才看得见，静态读代码很容易漏。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-emailsql-'));
process.env.DATA_DIR = tmp;

const db = (await import('../server/db.js')).default;
const d = db.openDatabase(path.join(tmp, 'main.db'));
db.initBusinessSchema(d);

// ---------- 1) 从源码里抽 SQL（不硬编码，改源码就能测到） ----------
const src = fs.readFileSync('server/services/emailService.js', 'utf8');
const lines = src.split('\n');
const found = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^.*?(['"`])((?:INSERT|UPDATE|DELETE)[\s\S]*?)\1\s*[),;]?\s*$/i);
  if (m && m[2].length > 10) found.push({ sql: m[2].replace(/\\'/g, "'").replace(/\s+/g, ' ').trim(), line: i + 1 });
}

// ---------- 2) 逐条 prepare（含 ? 个数的实际绑定检查） ----------
let pass = 0, fail = 0;
const argCount = (sql) => (sql.split('?').length - 1);
for (const f of found) {
  try {
    const st = d.prepare(f.sql);
    // 再验一次参数个数：SQLite 不管多传少传都要抛，这里显式比一次更直观
    const need = argCount(f.sql);
    if (/VALUES|\bSET\b/i.test(f.sql)) {
      const dummy = new Array(need).fill(null);
      d.exec('BEGIN');
      try { st.run(...dummy); } catch (e) {
        // 值本身非法（NOT NULL 等）不算 SQL 结构错误，只看是否报个数不符
        if (/values|counter|columns/i.test(e.message)) throw e;
      }
      d.exec('ROLLBACK');
    }
    console.log(`  ✓ :${f.line} ${f.sql.slice(0, 72)}…`);
    pass++;
  } catch (e) {
    console.log(`  ✗ :${f.line} ${e.message}\n      ${f.sql.slice(0, 110)}`);
    fail++;
  }
}

// ---------- 3) 收件箱那条的真实落库（回归到「刷新收件箱」这条路径） ----------
try {
  const ins = d.prepare("INSERT OR IGNORE INTO emails(account_id,uid,subject,from_name,from_addr,date,seen,folder) VALUES(?,?,?,?,?,?,0,'inbox')");
  ins.run(1, 9001, '主题', '发件人', 'a@qq.com', '2026-10-02T09:00:00.000Z');
  ins.run(1, 9001, '主题', '发件人', 'a@qq.com', '2026-10-02T09:00:00.000Z'); // 同 (account_id,uid) 应被 IGNORE
  const r = d.prepare('SELECT COUNT(*) c FROM emails WHERE uid=9001').get();
  const row = d.prepare('SELECT date, seen, folder FROM emails WHERE uid=9001').get();
  const okRow = r.c === 1 && row.date === '2026-10-02T09:00:00.000Z' && row.seen === 0 && row.folder === 'inbox';
  console.log(`  ${okRow ? '✓' : '✗'} 收件箱入库：去重后 1 行、date/seen/folder 正确落库`);
  okRow ? pass++ : fail++;
} catch (e) {
  console.log('  ✗ 收件箱入库：' + e.message);
  fail++;
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
d.close?.();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} // Windows 上 DB 句柄可能还占着，清理失败不影响结果
process.exit(fail ? 2 : 0);
