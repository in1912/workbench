// v1.3.2 补丁：三个测评中心（mbti/dep/pro）各加对外开关。
// 关闭后：H5 静态页（index.js 静态守卫）+ 全部免登录 API（路由内 rejectDisabled）403；
// 管理端（列表/删除/AI授权/config）不受影响。一次跑完 3 个路由文件 + index.js。
const fs = require('fs');
const path = require('path');
const R = path.join(__dirname, '..', 'server');

function rep(file, oldStr, newStr, tag, expect = 1) {
  let t = fs.readFileSync(file, 'utf8');
  const n = t.split(oldStr).length - 1;
  if (n !== expect) { console.error(`[FAIL] ${path.basename(file)} 「${tag}」匹配 ${n} 处（期望 ${expect}），中止不改`); process.exit(1); }
  fs.writeFileSync(file, t.replace(oldStr, newStr));
  console.log(`[ok] ${path.basename(file)} 「${tag}」`);
}

for (const base of ['mbti', 'dep', 'pro']) {
  const f = path.join(R, 'routes', `${base}Routes.js`);
  // 1) 开关键 + 助手（挂在 PREFIX_KEY 之后）
  rep(f,
    `const PREFIX_KEY = '${base}_share_prefix';`,
    `const PREFIX_KEY = '${base}_share_prefix';\n` +
    `const ENABLED_KEY = '${base}_enabled'; // 对外开关：'0' = H5 页面与全部免登录接口 403，管理端不受影响\n` +
    `function isEnabled() {\n` +
    `  return String(getSetting(db, ENABLED_KEY, '1') || '1') !== '0';\n` +
    `}\n` +
    `function rejectDisabled(req, res) {\n` +
    `  if (isEnabled()) return false;\n` +
    `  res.status(403).json({ error: '该测试中心已停用，暂不对外提供测试' });\n` +
    `  return true;\n` +
    `}`,
    'helpers');

  // 2) GET config 带上 enabled
  rep(f,
    `router.get('/${base}/config', (req, res) => {\n  res.json({ prefix: String(getSetting(db, PREFIX_KEY, '') || '') });\n});`,
    `router.get('/${base}/config', (req, res) => {\n  res.json({ prefix: String(getSetting(db, PREFIX_KEY, '') || ''), enabled: isEnabled() });\n});`,
    'GET config');

  // 3) PUT config 改部分更新语义（只动出现的键：开关切换不得清空已存前缀）
  rep(f,
    `router.put('/${base}/config', (req, res) => {\n  if (!adminOnly(req, res)) return;\n  const p = String((req.body || {}).prefix || '').trim().replace(/\\/+$/, '');\n  if (p) {\n    if (!/^https?:\\/\\/[^\\s]+$/i.test(p)) {\n      return res.status(400).json({ error: '前缀须为 http(s):// 开头的地址（如 https://xxx.vicp.fun），或留空使用当前访问地址' });\n    }\n    if (p.length > 200) return res.status(400).json({ error: '前缀过长' });\n  }\n  setSetting(db, PREFIX_KEY, p);\n  res.json({ ok: true, prefix: p });\n});`,
    `router.put('/${base}/config', (req, res) => {\n  if (!adminOnly(req, res)) return;\n  const b = req.body || {};\n  let cur = String(getSetting(db, PREFIX_KEY, '') || '');\n  if ('prefix' in b) { // 显式传才算（含空串=清空）；只切开关时不碰前缀\n    const p = String(b.prefix || '').trim().replace(/\\/+$/, '');\n    if (p) {\n      if (!/^https?:\\/\\/[^\\s]+$/i.test(p)) {\n        return res.status(400).json({ error: '前缀须为 http(s):// 开头的地址（如 https://xxx.vicp.fun），或留空使用当前访问地址' });\n      }\n      if (p.length > 200) return res.status(400).json({ error: '前缀过长' });\n    }\n    setSetting(db, PREFIX_KEY, p);\n    cur = p;\n  }\n  if ('enabled' in b) setSetting(db, ENABLED_KEY, (b.enabled === false || b.enabled === 0 || b.enabled === '0') ? '0' : '1');\n  res.json({ ok: true, prefix: cur, enabled: isEnabled() });\n});`,
    'PUT config');

  // 4) 五个免登录端点加守卫
  for (const [anchor, tag] of [
    [`router.get('/${base}/public/:id', (req, res) => {`, 'guard public'],
    [`router.post('/${base}/records', (req, res) => {`, 'guard records POST'],
    [`router.post('/${base}/user-info', (req, res) => {`, 'guard user-info'],
    [`router.get('/${base}/ai-auth', (req, res) => {`, 'guard ai-auth'],
    [`router.post('/${base}/ai-analysis', async (req, res) => {`, 'guard ai-analysis'],
  ]) {
    rep(f, anchor, anchor + `\n  if (rejectDisabled(req, res)) return;`, tag);
  }
}

// 5) index.js：静态页守卫（挂在 webDist 静态服务之前）+ 引入 getSetting
const idx = path.join(R, 'index.js');
rep(idx,
  `const { db, onImported, getTenantDb, dataDir } = require('./db');`,
  `const { db, onImported, getTenantDb, dataDir, getSetting } = require('./db');`,
  'import getSetting');
rep(idx,
  `// 托管前端构建产物：web/dist 下可能累积多个时间戳子目录`,
  `// 心理测试三中心对外开关（v1.3.2）：关闭后 H5 静态页（含免登录分享链接）对所有人 403；\n` +
  `// 免登录 API 的同名校验在各中心路由内兜底（防绕过静态直打接口）。开关在「效率工具」各测试 tab。\n` +
  `app.use((req, res, next) => {\n` +
  `  const m = req.path.match(/^\\/(mbti|dep|pro)(?:\\/|$)/);\n` +
  `  if (m && String(getSetting(db, m[1] + '_enabled', '1') || '1') === '0') {\n` +
  `    return res.status(403).type('text/html').send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;padding:40px;text-align:center;color:#555"><h2>🚫 测试已停用</h2><p>该测试中心当前未对外开放，请联系管理员开启。</p></body>');\n` +
  `  }\n` +
  `  next();\n` +
  `});\n\n` +
  `// 托管前端构建产物：web/dist 下可能累积多个时间戳子目录`,
  'static guard');
console.log('全部补丁完成');
