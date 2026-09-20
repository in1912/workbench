// 探针 CLI：node biProbe.js <业务系统名称或id>
// 用业务系统里存的账号密码登录，dump 登录页+首页结构 + 截图到 data/bi-probe-*.txt/.png
const path = require('path');
const fs = require('fs');
const { db } = require('./db');
const browserSkill = require('./services/browserSkillService');

(async () => {
  const arg = process.argv[2];
  if (!arg) { console.error('用法: node biProbe.js <业务系统名称或id>'); process.exit(1); }
  const sys = db.prepare('SELECT * FROM business_systems WHERE id=? OR name=?').get(Number(arg) || 0, arg);
  if (!sys) { console.error('找不到业务系统:', arg); process.exit(1); }
  console.log(`探针: ${sys.name} (${sys.url})`);
  const dump = await browserSkill.probe(sys);
  const file = path.join('data', `bi-probe-${sys.id}-${Date.now()}.txt`);
  fs.writeFileSync(file, dump);
  console.log('dump 已存:', file);
  console.log('--- dump ---\n' + dump);
  process.exit(0);
})().catch((e) => { console.error('探针失败:', e.message); process.exit(1); });
