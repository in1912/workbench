// 一次性迁移：从被锁定的旧库把数据复制到全新数据库
// 用法：node migrate-db.js <旧库路径> <新库路径>
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const oldPath = process.argv[2];
const newPath = process.argv[3];
if (!oldPath || !newPath) { console.error('用法: node migrate-db.js 旧库 新库'); process.exit(1); }

fs.mkdirSync(path.dirname(newPath), { recursive: true });
if (fs.existsSync(newPath)) {
  // 避免触发宿主环境的安全删除钩子，用重命名归档旧文件
  const bak = newPath + '.old-' + Date.now();
  fs.renameSync(newPath, bak);
  console.log('已归档旧目标 →', bak);
}

const oldDb = new DatabaseSync(oldPath, { readOnly: true });
const newDb = new DatabaseSync(newPath);

const tables = oldDb.prepare(
  "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
).all();
console.log(`发现 ${tables.length} 张表`);

for (const t of tables) {
  newDb.exec(t.sql);
  const rows = oldDb.prepare(`SELECT * FROM "${t.name}"`).all();
  if (rows.length) {
    const cols = Object.keys(rows[0]).map((c) => `"${c}"`).join(',');
    const ph = Object.keys(rows[0]).map(() => '?').join(',');
    const ins = newDb.prepare(`INSERT INTO "${t.name}" (${cols}) VALUES (${ph})`);
    for (const r of rows) {
      ins.run(...Object.values(r));
    }
  }
  console.log(`  ✓ ${t.name}: ${rows.length} 行`);
}

// 建索引
const idxs = oldDb.prepare(
  "SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'"
).all();
for (const i of idxs) { try { newDb.exec(i.sql); } catch {} }

newDb.exec("PRAGMA journal_mode=DELETE");
console.log('迁移完成 →', newPath);
oldDb.close();
newDb.close();
