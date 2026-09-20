// 从 mbtiRoutes.js 生成 depRoutes.js / proRoutes.js（同构路由：独立表 + 独立 URL 前缀）
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'server', 'routes');
const src = fs.readFileSync(path.join(dir, 'mbtiRoutes.js'), 'utf8');

const jobs = [
  { tag: 'dep', file: 'depRoutes.js', cn: '抑郁测试' },
  { tag: 'pro', file: 'proRoutes.js', cn: '专业心理测试' },
];

for (const { tag, file, cn } of jobs) {
  let out = src
    .replace(/mbti_share_prefix/g, `${tag}_share_prefix`)
    .replace(/mbti_records/g, `${tag}_records`)
    .replace(/mbti_user_info/g, `${tag}_user_info`)
    .replace(/\/mbti\//g, `/${tag}/`);
  // 头部注释：换成本中心说明
  out = out.replace(
    /^\/\/ 心理测试（多测试版 v1\.2\.24）[^\n]*\n/,
    `// ${cn}中心（v1.3.0）：与 mbtiRoutes 同构（/api/${tag}/*，独立 ${tag}_records / ${tag}_user_info 表）。\n` +
    `// H5 静态托管在 /${tag}/index.html，工作台「效率工具 → ${cn}」tab 管理记录/用户/AI授权/分享前缀。\n`
  );
  // mbti 专属文案残留：test_title 回退串
  out = out.replace(
    /String\(b\.testTitle \|\| \(testId === 'mbti' \? 'MBTI 职业性格测试' : ''\)\)/,
    `String(b.testTitle || '')`
  );
  out = out.replace(/testId === 'mbti'/g, `testId === '${tag}'`);
  // version 字段只有 MBTI 档案有；本中心档案一律带 testId
  out = out.replace(
    /const testId = String\(b\.testId \|\| \(b\.version \? 'mbti' : ''\) \|\| ''\);/,
    `const testId = String(b.testId || '');`
  );
  // AI 门槛：本中心全部为专业量表（无趣味测试），全部允许 AI 分析（授权仍按 uid 管理员开通）
  out = out.replace(
    /  \/\/ AI 深度分析仅限 4 大主测[\s\S]*?趣味测试不提供 AI 深度分析' \}\);\r?\n    \}\r?\n  \}\r?\n/,
    `  // 本中心全部为专业量表，均可 AI 深度分析（授权按 uid 由管理员开通）\n`
  );
  // users 列表的 mbti_count 对本中心无意义：改为统计已出 AI 分析的份数（列名保持前端兼容）。
  // 注意注释必须用 SQL 的 --（node:sqlite 不认 JS 的 //），且只到行尾不影响后续行
  out = out.replace(
    /SUM\(CASE WHEN r\.test_id = 'mbti' OR r\.test_id = '' THEN 1 ELSE 0 END\) AS mbti_count,/,
    `SUM(CASE WHEN r.ai_analysis_done = 1 THEN 1 ELSE 0 END) AS mbti_count, -- 本中心语义：已 AI 分析的份数`
  );
  fs.writeFileSync(path.join(dir, file), out);
  console.log(file, out.length, 'bytes, 残留 mbti 引用:', (out.match(/mbti/g) || []).filter(s => s !== 'mbti_count').length, '（mbti_count 为前端兼容列名）');
}
