// v1.3.5 总补丁：电脑监控模块接线 + AI 地址双后缀修复 + 侧边栏 adminOnly 过滤修复
// 用法：node scripts/patch-monitor.cjs
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

function file(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function save(rel, s) { fs.writeFileSync(path.join(ROOT, rel), s, 'utf8'); }
let failed = 0;
function rep(rel, old, neu, tag) {
  const s = file(rel);
  const n = s.split(old).length - 1;
  if (n !== 1) { console.error(`X ${rel} [${tag}] anchor hit ${n} times (need 1), skip`); failed++; return; }
  save(rel, s.replace(old, neu));
  console.log(`OK ${rel} [${tag}]`);
}

// ---------- 1) AI address normalization (fix /chat/completions double-suffix 404) ----------
rep('server/services/aiService.js',
  'async function chat(messages,',
  '// chat endpoint normalization: tolerate a full endpoint URL (..../chat/completions) or trailing slashes in base_url (v1.3.5)\n' +
  "function chatEndpoint(base) {\n" +
  "  return String(base || '').replace(/\\/+$/, '').replace(/\\/chat\\/completions$/i, '') + '/chat/completions';\n" +
  "}\n\n" +
  'async function chat(messages,',
  'chatEndpoint def');

rep('server/services/aiService.js',
  "  const url = cfg.base_url.replace(/\\/+$/, '') + '/chat/completions';",
  '  const url = chatEndpoint(cfg.base_url);',
  'chat concat');

rep('server/services/aiService.js',
  "  const res = await fetch(vBase + '/chat/completions', {",
  '  const res = await fetch(chatEndpoint(vBase), {',
  'ocrImages concat');

rep('server/services/aiService.js',
  'module.exports = { getConfig, hasConfig, chat, summarize, ocrImages };',
  'module.exports = { getConfig, hasConfig, chatEndpoint, chat, summarize, ocrImages };',
  'export chatEndpoint');

rep('server/routes/misc.js',
  "      const upRes = await fetch(upstream.base + '/chat/completions', {",
  "      const upRes = await fetch(aiService.chatEndpoint(upstream.base), {",
  'stream concat');

rep('server/services/monitorService.js',
  "  const res = await fetch(vBase + '/chat/completions', {",
  "  const res = await fetch(aiService.chatEndpoint(vBase), {",
  'monitor vision concat');

// ---------- 2) db.js main DDL: monitor tables ----------
rep('server/db.js',
  "CREATE TABLE IF NOT EXISTS message_images (\n" +
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
  "  mime TEXT NOT NULL DEFAULT 'image/png',\n" +
  "  size TEXT DEFAULT '',\n" +
  "  data TEXT NOT NULL,\n" +
  "  storage_path TEXT DEFAULT '',\n" +
  "  created_at TEXT DEFAULT (datetime('now','localtime'))\n" +
  ");",
  "CREATE TABLE IF NOT EXISTS message_images (\n" +
  "  id INTEGER PRIMARY KEY AUTOINCREMENT,\n" +
  "  mime TEXT NOT NULL DEFAULT 'image/png',\n" +
  "  size TEXT DEFAULT '',\n" +
  "  data TEXT NOT NULL,\n" +
  "  storage_path TEXT DEFAULT '',\n" +
  "  created_at TEXT DEFAULT (datetime('now','localtime'))\n" +
  ");\n" +
  '-- monitor (v1.3.5): devices & shots (main db, cross-tenant)\n' +
  'CREATE TABLE IF NOT EXISTS monitor_devices (\n' +
  '  id TEXT PRIMARY KEY,\n' +
  "  name TEXT DEFAULT '',\n" +
  "  computer_name TEXT DEFAULT '',\n" +
  '  enabled INTEGER DEFAULT 1,\n' +
  "  created_at TEXT DEFAULT (datetime('now','localtime')),\n" +
  "  last_seen TEXT DEFAULT ''\n" +
  ');\n' +
  'CREATE TABLE IF NOT EXISTS monitor_shots (\n' +
  '  id INTEGER PRIMARY KEY AUTOINCREMENT,\n' +
  '  device_id TEXT NOT NULL,\n' +
  '  ts TEXT NOT NULL,\n' +
  "  storage_path TEXT DEFAULT '',\n" +
  "  data TEXT DEFAULT '',\n" +
  '  ai_text TEXT,\n' +
  "  ai_at TEXT DEFAULT ''\n" +
  ');\n' +
  'CREATE INDEX IF NOT EXISTS idx_monitor_shots_dev ON monitor_shots(device_id, ts);',
  'monitor DDL');

// ---------- 3) index.js: EXEMPT + mount ----------
rep('server/index.js',
  "  '/pro/public', '/pro/records', '/pro/user-info', '/pro/ai-auth', '/pro/ai-analysis'];",
  "  '/pro/public', '/pro/records', '/pro/user-info', '/pro/ai-auth', '/pro/ai-analysis',\n  '/monitor/agent/config', '/monitor/agent/shot'];",
  'EXEMPT agent');

rep('server/index.js',
  "const sslRoutes = require('./routes/sslRoutes');",
  "const sslRoutes = require('./routes/sslRoutes');\nconst monitorRoutes = require('./routes/monitorRoutes');",
  'require monitorRoutes');

rep('server/index.js',
  "app.use('/api/ssl', sslRoutes);",
  "app.use('/api', monitorRoutes);\napp.use('/api/ssl', sslRoutes);",
  'mount monitorRoutes');

// ---------- 4) auth.js: TAB_PATHS.tools add monitor ----------
rep('server/auth.js',
  "    ['links', ['/links']],",
  "    ['links', ['/links']],\n    // monitor (v1.3.5)\n    ['monitor', ['/monitor']],",
  'TAB_PATHS.tools');

// ---------- 5) messageService.js: module label ----------
rep('server/services/messageService.js',
  "const MODULE_LABELS = { message: '站内消息', family: '家庭事项', kids: '子女学习', event: '日程提醒', dingtalk: '钉钉', ssl: 'SSL 证书' };",
  "const MODULE_LABELS = { message: '站内消息', family: '家庭事项', kids: '子女学习', event: '日程提醒', dingtalk: '钉钉', ssl: 'SSL 证书', monitor: '电脑监控' };",
  'MODULE_LABELS');

// ---------- 6) scheduler.js: retention cleanup ----------
rep('server/scheduler.js',
  '  // 通勤定时刷新：注册所有租户 refresh_times 的并集时刻',
  "  // 电脑监控截图保留期清理（每日 03:40，磁盘与库内同步；天数在「效率工具→电脑监控」配置）\n" +
  "  cron.schedule('40 3 * * *', () => {\n" +
  "    try {\n" +
  "      const n = require('./services/monitorService').cleanup();\n" +
  "      if (n) console.log('[scheduler] 电脑监控过期截图已清理 ' + n + ' 张');\n" +
  "    } catch (e) { console.warn('[scheduler] 监控截图清理失败:', e.message); }\n" +
  "  }, { timezone: 'Asia/Shanghai' });\n\n" +
  '  // 通勤定时刷新：注册所有租户 refresh_times 的并集时刻',
  'monitor cleanup');

// ---------- 7) tabs.js: tools add monitor (last tab) ----------
rep('web/src/tabs.js',
  "    { key: 'review', label: '复盘' },\n  ],",
  "    { key: 'review', label: '复盘' },\n    // 电脑监控（v1.3.5）\n    { key: 'monitor', label: '电脑监控' },\n  ],",
  'TAB_DEFS.tools');

// ---------- 8) Tools.vue: tab button + component ----------
rep('web/src/views/Tools.vue',
  "<button v-if=\"canTab('tools','review')\" :class=\"{active: tab==='review'}\" @click=\"switchTab('review')\">复盘</button>",
  "<button v-if=\"canTab('tools','review')\" :class=\"{active: tab==='review'}\" @click=\"switchTab('review')\">复盘</button>\n      <button v-if=\"canTab('tools','monitor')\" :class=\"{active: tab==='monitor'}\" @click=\"switchTab('monitor')\">电脑监控</button>",
  'tab button');

rep('web/src/views/Tools.vue',
  '    <!-- ============ 复盘（自学习页移来） ============ -->',
  "    <!-- ============ 电脑监控（v1.3.5） ============ -->\n    <MonitorPanel v-else-if=\"tab==='monitor'\" />\n\n    <!-- ============ 复盘（自学习页移来） ============ -->",
  'component insert');

rep('web/src/views/Tools.vue',
  "import TestCenterTab from '../components/TestCenterTab.vue';",
  "import TestCenterTab from '../components/TestCenterTab.vue';\nimport MonitorPanel from '../components/MonitorPanel.vue';",
  'import');

// ---------- 9) App.vue: sidebar adminOnly filter fix (verified in fork) ----------
rep('web/src/App.vue',
  'if (allowed.length) list = allNavs.filter((n) => n.adminOnly || allowed.includes(n.page));',
  'if (allowed.length) list = allNavs.filter((n) => !n.adminOnly && allowed.includes(n.page));',
  'App adminOnly');

// ---------- 10) Settings.vue: same fix + AI base_url placeholder ----------
rep('web/src/views/Settings.vue',
  'return NAV_ITEMS.filter((n) => n.adminOnly || allowed.includes(n.page));',
  'return NAV_ITEMS.filter((n) => !n.adminOnly && allowed.includes(n.page));',
  'Settings adminOnly');

rep('web/src/views/Settings.vue',
  'placeholder="如：https://api.deepseek.com/v1"',
  'placeholder="如：https://api.deepseek.com/v1（只填域名/版本号，接口路径自动拼接）"',
  'AI placeholder');

if (failed) { console.error(`\n${failed} anchors failed`); process.exit(1); }
console.log('\nall patches done');
