// CC-LIGHT hooks 安装器 — 把指示灯钩子装进 Claude Code / Codex CLI / WorkBuddy / CodeBuddy / Cursor /
// DeepSeek Harness / Hermes / Gemini CLI / Qwen Code 九家 agent 的用户级配置
// 用法: node install-hooks.js                  安装/更新 Claude Code 钩子 (~/.claude/settings.json)
//       node install-hooks.js --remove         移除 Claude Code 钩子
//       node install-hooks.js --codex          安装/更新 Codex CLI 钩子 (~/.codex/hooks.json)
//       node install-hooks.js --codex-remove   移除 Codex CLI 钩子
//       node install-hooks.js --workbuddy      安装/更新 WorkBuddy 插件 (~/.workbuddy/plugins/, 本地插件)
//       node install-hooks.js --workbuddy-remove 移除 WorkBuddy 插件
//       node install-hooks.js --codebuddy      安装/更新 CodeBuddy Code 钩子 (~/.codebuddy/settings.json 直接格式)
//       node install-hooks.js --codebuddy-remove 移除 CodeBuddy Code 钩子
//       node install-hooks.js --cursor         安装/更新 Cursor 钩子 (~/.cursor/hooks.json, Cursor 1.7+)
//       node install-hooks.js --cursor-remove  移除 Cursor 钩子
//       node install-hooks.js --dsh            安装 DeepSeek Harness 插件 (dsh plugin add ./dist, 进程内 TS 插件)
//       node install-hooks.js --dsh-remove     移除 dsh 插件
//       node install-hooks.js --hermes         安装 Hermes Agent 插件 (~/.hermes/plugins/esp32-light/, Python)
//       node install-hooks.js --hermes-remove  移除 Hermes 插件
//       node install-hooks.js --gemini         安装/更新 Gemini CLI 钩子 (~/.gemini/settings.json hooks 段)
//       node install-hooks.js --gemini-remove  移除 Gemini CLI 钩子
//       node install-hooks.js --qwen           安装/更新 Qwen Code 钩子 (~/.qwen/settings.json hooks 段)
//       node install-hooks.js --qwen-remove    移除 Qwen Code 钩子
//       node install-hooks.js --all            一键全装: 检测到哪家 CLI 就装哪家(缺的跳过, 不逐个询问)
// 说明: 写入前自动备份原文件; 只增删本工具的条目, 其他配置原样保留。
//       Claude/Codex 钩子命令按本文件实际位置拼 send.js 绝对路径,
//       换电脑/换文件夹后重跑一次安装即可(会自动替换旧路径条目)。
//       Windows / macOS 通用(HOME 自动取 USERPROFILE 或 HOME); 命令路径一律正斜杠。
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const HOME = process.env.USERPROFILE || process.env.HOME || '';   // Windows / macOS
const CLAUDE = path.join(HOME, '.claude', 'settings.json');
const CODEX_DIR = path.join(HOME, '.codex');
const CODEX = path.join(CODEX_DIR, 'hooks.json');
const CURSOR_DIR = path.join(HOME, '.cursor');
const CURSOR = path.join(CURSOR_DIR, 'hooks.json');
const CODEBUDDY_DIR = path.join(HOME, '.codebuddy');
const CODEBUDDY = path.join(CODEBUDDY_DIR, 'settings.json');
const GEMINI_DIR = path.join(HOME, '.gemini');
const GEMINI = path.join(GEMINI_DIR, 'settings.json');
const QWEN_DIR = path.join(HOME, '.qwen');
const QWEN = path.join(QWEN_DIR, 'settings.json');

const ARG = (process.argv[2] || '').toLowerCase();
const MODE =
  ARG === '--codex' ? 'codex' :
  ARG === '--codex-remove' ? 'codex-remove' :
  ARG === '--workbuddy' ? 'workbuddy' :
  ARG === '--workbuddy-remove' ? 'workbuddy-remove' :
  ARG === '--codebuddy' ? 'codebuddy' :
  ARG === '--codebuddy-remove' ? 'codebuddy-remove' :
  ARG === '--cursor' ? 'cursor' :
  ARG === '--cursor-remove' ? 'cursor-remove' :
  ARG === '--dsh' ? 'dsh' :
  ARG === '--dsh-remove' ? 'dsh-remove' :
  ARG === '--hermes' ? 'hermes' :
  ARG === '--hermes-remove' ? 'hermes-remove' :
  ARG === '--gemini' ? 'gemini' :
  ARG === '--gemini-remove' ? 'gemini-remove' :
  ARG === '--qwen' ? 'qwen' :
  ARG === '--qwen-remove' ? 'qwen-remove' :
  ARG === '--all' ? 'all' :
  ARG === '--remove' ? 'claude-remove' : 'claude';

// send.js 绝对路径(正斜杠 + 引号, 兼容带空格的文件夹)
const SEND = path.join(__dirname, 'send.js').replace(/\\/g, '/');
// cursor-forward.mjs 绝对路径(Cursor 钩子统一走它: 映射灯效 + 回权限放行 JSON)
const FWD = path.join(__dirname, 'cursor-forward.mjs').replace(/\\/g, '/');
// workbuddy-forward.mjs 绝对路径(CodeBuddy 直接格式不能用 ${CODEBUDDY_PLUGIN_ROOT}, 必须写绝对路径)
const WBFWD = path.join(__dirname, 'workbuddy-forward.mjs').replace(/\\/g, '/');
// gemini-qwen-forward.mjs 绝对路径(Gemini CLI / Qwen Code 两家钩子统一走它, 按 hook_event_name 分发)
const GFWD = path.join(__dirname, 'gemini-qwen-forward.mjs').replace(/\\/g, '/');
// 命令里出现 send.js 即视为本工具的钩子(用于增删时识别自己的条目)
const isOurs = (h) => !!(h && typeof h.command === 'string' && h.command.includes('send.js'));

// 事件 → 钩子参数 (固定模式直接传参; post 需读 stdin JSON 判断成败)
const CLAUDE_EVENTS = {
  SessionStart: ['demo'],      // 会话开启 → 开机演示
  UserPromptSubmit: ['thinking'], // 提交提示词 → AI 正在分析
  PreToolUse: ['busy'],        // 即将执行工具/命令 → 黄灯慢闪
  PostToolUse: ['post'],       // 工具结束 → 读结果: 失败=红快闪, 否则=柔和跑马
  Stop: ['success'],           // 任务完成 → 绿灯常亮
  Notification: ['notify'],    // 权限确认等待 → 红黄警灯
  SessionEnd: ['off'],         // 会话结束 → 全灭
};
// Codex 生命周期钩子(事件名与 Claude Code 基本同名, 同样 stdin 收 JSON):
// 无 Notification → 权限等待由 PermissionRequest 触发警灯; 无 SessionEnd →
// 会话结束不灭灯, 由守护进程看门狗兜底(success 10 分钟自动 off)。
const CODEX_EVENTS = {
  SessionStart: ['demo'],
  UserPromptSubmit: ['thinking'],
  PreToolUse: ['busy'],        // 只拦截 Bash / apply_patch / MCP 工具
  PostToolUse: ['post'],
  PermissionRequest: ['alarm'],
  Stop: ['success'],
};
// WorkBuddy / CodeBuddy Code 共用事件集(两平台钩子引擎同源, 事件同名同义含 stdin JSON)
const WB_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse',
  'PostToolUse', 'Stop', 'Notification', 'SessionEnd'];
// Cursor 生命周期钩子(事件名驼峰, 条目扁平无 matcher 嵌套):
// 全部交给 cursor-forward.mjs——它按 hook_event_name 映射灯效, 且对权限类事件
// (preToolUse/beforeSubmitPrompt) 必须在 stdout 回放行 JSON, 否则 Cursor 会拦掉动作。
// 无权限等待类事件 → 不映射 alarm; postToolUseFailure 是独立失败事件 → 精准红灯;
// afterAgentResponse 补上纯聊天(不碰工具)场景的输出反馈。
const CURSOR_EVENTS = [
  'sessionStart', 'beforeSubmitPrompt', 'preToolUse', 'postToolUse',
  'postToolUseFailure', 'afterAgentResponse', 'stop', 'sessionEnd',
];
// Gemini CLI 钩子(事件名 Before*/After* 自成一套, timeout 单位毫秒):
// Notification.notification_type 目前只有 "ToolPermission" → matcher 精确匹配只认权限等待;
// AfterTool.tool_response 自带 error 字段 → 转发器做结构化失败判定, 不用正则启发式。
const GEMINI_EVENTS = {
  SessionStart: '*',
  BeforeAgent: '*',
  BeforeTool: '*',
  AfterTool: '*',
  AfterAgent: '*',
  Notification: 'ToolPermission',   // 生命周期类 matcher 是精确字符串
  SessionEnd: '*',
};
// Qwen Code 钩子(Gemini CLI 兄弟分支但事件沿 Claude 命名):
// PostToolUseFailure/StopFailure 是独立失败事件(精准红灯); PermissionRequest = 权限弹窗 → alarm;
// 命令钩子支持 async:true 后台执行 → 开启, 灯效零延迟不阻塞主流程。
const QWEN_EVENTS = {
  SessionStart: '*',
  UserPromptSubmit: '*',
  PreToolUse: '*',
  PostToolUse: '*',
  PostToolUseFailure: '*',
  Stop: '*',
  StopFailure: '*',
  PermissionRequest: '*',
  SessionEnd: '*',
};

// 清掉所有事件里属于本工具的钩子条目, 保留其他工具的配置
function stripOurs(hooks) {
  for (const ev of Object.keys(hooks)) {
    hooks[ev] = (hooks[ev] || []).map((entry) => {
      if (!entry || !Array.isArray(entry.hooks)) return entry;
      const kept = entry.hooks.filter((h) => !isOurs(h));
      return { ...entry, hooks: kept };
    }).filter((entry) => (entry.hooks || []).length > 0);
    if (!hooks[ev].length) delete hooks[ev];
  }
}

function readJson(file, label) {
  let raw = '{}';
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {}
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) {
    console.error(label + ' 解析失败, 先人工检查: ' + e.message);
    process.exit(1);
  }
  return cfg;
}

function writeJson(file, cfg, installing) {
  if (installing) {
    try { fs.copyFileSync(file, file + '.bak-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)); } catch (e) {}
  }
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

// ---------- Claude Code: ~/.claude/settings.json ----------
if (MODE.startsWith('claude')) {
  const cfg = readJson(CLAUDE, 'settings.json');
  if (MODE === 'claude') fs.mkdirSync(path.dirname(CLAUDE), { recursive: true });   // 无 .claude 目录时兜底(装好钩子, CLI 装后即用)
  const hooks = cfg.hooks || {};
  stripOurs(hooks);
  if (MODE === 'claude') {
    for (const [ev, args] of Object.entries(CLAUDE_EVENTS)) {
      const list = hooks[ev] || (hooks[ev] = []);
      // 同 matcher 的组存在则并入, 否则新建 matcher "*" 组
      let group = list.find((g) => g && g.matcher === '*');
      if (!group) { group = { matcher: '*', hooks: [] }; list.push(group); }
      for (const a of args) {
        group.hooks.push({ type: 'command', command: `node "${SEND}" ${a}`, timeout: 15 });
      }
    }
  }
  if (Object.keys(hooks).length) cfg.hooks = hooks;
  else delete cfg.hooks;
  writeJson(CLAUDE, cfg, MODE === 'claude');
  console.log((MODE === 'claude' ? '已安装' : '已移除') + ' Claude Code 钩子 → ' + CLAUDE);
  console.log('注意: 钩子对新开的 claude 会话生效(当前已开的会话不加载)。');

// ---------- Codex CLI: ~/.codex/hooks.json ----------
} else if (MODE.startsWith('codex')) {
  if (MODE === 'codex' && !fs.existsSync(CODEX_DIR)) {
    console.error('未找到 ' + CODEX_DIR + ' —— 请先安装 Codex CLI 再运行本安装器:');
    console.error('  npm i -g @openai/codex   (或参考 https://developers.openai.com/codex/cli)');
    process.exit(1);
  }
  if (!fs.existsSync(CODEX)) {
    if (MODE === 'codex-remove') { console.log('Codex 钩子本就未安装, 无需移除。'); process.exit(0); }
    fs.mkdirSync(CODEX_DIR, { recursive: true });
  }
  const cfg = readJson(CODEX, 'hooks.json');
  const hooks = cfg.hooks || {};
  stripOurs(hooks);
  if (MODE === 'codex') {
    for (const [ev, args] of Object.entries(CODEX_EVENTS)) {
      const list = hooks[ev] || (hooks[ev] = []);
      for (const a of args) {
        list.push({ hooks: [{ type: 'command', command: `node "${SEND}" ${a}`, timeout: 15 }] });
      }
    }
  }
  if (Object.keys(hooks).length) cfg.hooks = hooks;
  else delete cfg.hooks;
  writeJson(CODEX, cfg, MODE === 'codex');
  console.log((MODE === 'codex' ? '已安装' : '已移除') + ' Codex CLI 钩子 → ' + CODEX);
  if (MODE === 'codex') {
    console.log('注意: Codex 出于安全要求, 新钩子需人工信任后才会执行:');
    console.log('      打开 codex → 输入 /hooks → Review → Trust, 然后新开会话即可联动。');
  }

// ---------- WorkBuddy: 本地插件 ~/.workbuddy/plugins/cache/local/workbuddy-light/ ----------
} else if (MODE.startsWith('workbuddy')) {
  const WB_HOME = path.join(HOME, '.workbuddy');
  const WB_INST = path.join(WB_HOME, 'plugins', 'installed_plugins.json');
  const WB_SET = path.join(WB_HOME, 'settings.json');
  const KEY = 'workbuddy-light@local';
  const VER = '0.1.0';
  const PDIR = path.join(WB_HOME, 'plugins', 'cache', 'local', 'workbuddy-light', VER);
  if (!fs.existsSync(WB_INST)) {
    console.error('未找到 ' + WB_INST + ' —— 请先安装并启动过一次 WorkBuddy 再运行本安装器。');
    process.exit(1);
  }

  if (MODE === 'workbuddy') {
    // 1) 插件实体: hooks/hooks.json + hooks/forward.mjs(自包含转发器) + light-config.json
    fs.mkdirSync(path.join(PDIR, 'hooks'), { recursive: true });
    const hj = {
      description: 'Agent light 工作状态指示灯：WorkBuddy 会话事件经 UDP 转发到本机 daemon → ESP32-C3 红绿灯（与 Claude Code / Codex CLI 共用同一块板子）',
      hooks: {},
    };
    for (const ev of WB_EVENTS) {
      hj.hooks[ev] = [{ matcher: '*', hooks: [{
        type: 'command',
        command: 'node "${CODEBUDDY_PLUGIN_ROOT}/hooks/forward.mjs"',
        description: 'Agent light 指示灯转发（永远 exit 0, 不阻塞会话）',
        timeout: 5,
      }] }];
    }
    fs.writeFileSync(path.join(PDIR, 'hooks', 'hooks.json'), JSON.stringify(hj, null, 2) + '\n', 'utf8');
    fs.copyFileSync(path.join(__dirname, 'workbuddy-forward.mjs'), path.join(PDIR, 'hooks', 'forward.mjs'));
    fs.writeFileSync(path.join(PDIR, 'light-config.json'),
      JSON.stringify({ host: '127.0.0.1', port: 7878 }, null, 2) + '\n', 'utf8');
    // 2) 注册: installed_plugins.json + settings.json>enabledPlugins（先备份）
    const inst = readJson(WB_INST, 'installed_plugins.json');
    inst.plugins = inst.plugins || {};
    const prev = (inst.plugins[KEY] || [])[0] || {};
    inst.plugins[KEY] = [{
      scope: 'user',
      installPath: PDIR,
      version: VER,
      installedAt: prev.installedAt || new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    }];
    writeJson(WB_INST, inst, true);
    const st = readJson(WB_SET, 'settings.json');
    st.enabledPlugins = st.enabledPlugins || {};
    st.enabledPlugins[KEY] = true;
    writeJson(WB_SET, st, true);
    console.log('已安装 WorkBuddy 插件 → ' + PDIR);
    console.log('已在 installed_plugins.json / settings.json 注册并启用（原文件已备份）');
    console.log('注意: 完全退出并重启 WorkBuddy, 新开会话即联动（灯先走 demo 轮播自检）。');
    console.log('      若钩子未加载: 用 WorkBuddy 界面的插件管理确认 workbuddy-light 已启用。');

  } else {
    let touched = false;
    if (fs.existsSync(WB_INST)) {
      const inst = readJson(WB_INST, 'installed_plugins.json');
      if (inst.plugins && inst.plugins[KEY]) {
        delete inst.plugins[KEY];
        writeJson(WB_INST, inst, true);
        touched = true;
      }
    }
    if (fs.existsSync(WB_SET)) {
      const st = readJson(WB_SET, 'settings.json');
      if (st.enabledPlugins && KEY in st.enabledPlugins) {
        delete st.enabledPlugins[KEY];
        writeJson(WB_SET, st, true);
        touched = true;
      }
    }
    fs.rmSync(PDIR, { recursive: true, force: true });
    console.log((touched ? '已移除' : '本就未安装') + ' WorkBuddy 插件注册, 插件目录已清理。');
  }

// ---------- Cursor: ~/.cursor/hooks.json (Cursor 1.7+, 扁平条目+驼峰事件名) ----------
} else if (MODE.startsWith('cursor')) {
  if (MODE === 'cursor' && !fs.existsSync(CURSOR_DIR)) {
    console.error('未找到 ' + CURSOR_DIR + ' —— 请先安装并启动过一次 Cursor(1.7+) 再运行本安装器。');
    process.exit(1);
  }
  if (!fs.existsSync(CURSOR)) {
    if (MODE === 'cursor-remove') { console.log('Cursor 钩子本就未安装, 无需移除。'); process.exit(0); }
    fs.mkdirSync(CURSOR_DIR, { recursive: true });
  }
  const cfg = readJson(CURSOR, 'hooks.json');
  const hooks = cfg.hooks || {};
  // Cursor 条目是扁平的 {command,...}(无 Claude 式 matcher/hooks 嵌套), 直接按命令过滤
  for (const ev of Object.keys(hooks)) {
    hooks[ev] = (hooks[ev] || []).filter(
      (e) => !(e && typeof e.command === 'string' && e.command.includes('cursor-forward.mjs'))
    );
    if (!hooks[ev].length) delete hooks[ev];
  }
  if (MODE === 'cursor') {
    for (const ev of CURSOR_EVENTS) {
      const list = hooks[ev] || (hooks[ev] = []);
      list.push({ command: `node "${FWD}"`, timeout: 5 });
    }
  }
  if (Object.keys(hooks).length) cfg.hooks = hooks;
  else delete cfg.hooks;
  cfg.version = cfg.version || 1;   // 官方 schema 要求正整数, 固定 1
  writeJson(CURSOR, cfg, MODE === 'cursor');
  console.log((MODE === 'cursor' ? '已安装' : '已移除') + ' Cursor 钩子 → ' + CURSOR);
  if (MODE === 'cursor') {
    console.log('注意: Cursor 会自动热重载 hooks.json, 无需重启——');
    console.log('      在 Cursor 设置 Customize → Hooks 里应能看到本工具命令; 新开对话即联动。');
  }

// ---------- CodeBuddy Code: ~/.codebuddy/settings.json 直接格式(事件名写顶层) ----------
// 与 WorkBuddy 钩子引擎同源(事件同名同义), 但配置入口是 settings.json 顶层直接写事件,
// 且此路径下没有 ${CODEBUDDY_PLUGIN_ROOT} 环境变量 → 命令必须写转发器绝对路径。
} else if (MODE.startsWith('codebuddy')) {
  if (MODE === 'codebuddy' && !fs.existsSync(CODEBUDDY_DIR)) {
    console.error('未找到 ' + CODEBUDDY_DIR + ' —— 请先安装并启动过一次 CodeBuddy Code 再运行本安装器。');
    process.exit(1);
  }
  if (!fs.existsSync(CODEBUDDY)) {
    if (MODE === 'codebuddy-remove') { console.log('CodeBuddy 钩子本就未安装, 无需移除。'); process.exit(0); }
    fs.mkdirSync(CODEBUDDY_DIR, { recursive: true });
  }
  const cfg = readJson(CODEBUDDY, 'settings.json');
  const isOursCB = (h) => !!(h && typeof h.command === 'string' && h.command.includes('workbuddy-forward.mjs'));
  // 只动 7 个事件键, settings.json 里其他配置键原样保留
  for (const ev of WB_EVENTS) {
    const list = Array.isArray(cfg[ev]) ? cfg[ev] : [];
    const cleaned = list.map((entry) => {
      if (!entry || !Array.isArray(entry.hooks)) return entry;
      return { ...entry, hooks: entry.hooks.filter((h) => !isOursCB(h)) };
    }).filter((e) => (e.hooks || []).length > 0);
    if (MODE === 'codebuddy') {
      cleaned.push({ matcher: '*', hooks: [{ type: 'command', command: `node "${WBFWD}"`, timeout: 5 }] });
      cfg[ev] = cleaned;
    } else if (cleaned.length) {
      cfg[ev] = cleaned;
    } else {
      delete cfg[ev];
    }
  }
  writeJson(CODEBUDDY, cfg, MODE === 'codebuddy');
  console.log((MODE === 'codebuddy' ? '已安装' : '已移除') + ' CodeBuddy Code 钩子 → ' + CODEBUDDY);
  if (MODE === 'codebuddy') {
    console.log('注意: 重启 codebuddy 会话后生效; 会话内输入 /hooks 应显示 7 个事件。');
    console.log('      调试看日志: codebuddy --debug');
  }

// ---------- DeepSeek Harness (dsh): 进程内插件(bundle), dsh plugin --profile X add ----------
// 实测流程(dsh 0.1.0-rc.7): 依赖 pnpm 转发安装; 插件包需声明 dsh.bundle(cordis.patch.yml)
// 才会被当作 profile 层激活; 装完用 --dump-config 验证 esp32-light 行在配置树里。
} else if (MODE.startsWith('dsh')) {
  const PKG = path.join(__dirname, 'dsh-esp32-light');
  const PKG_FWD = PKG.replace(/\\/g, '/');
  if (!fs.existsSync(path.join(PKG, 'dist', 'index.js'))) {
    console.error('未找到 ' + PKG + ' —— 请用完整 cc-light 包运行本安装器。');
    process.exit(1);
  }
  const run = (cmd) => cp.spawnSync(cmd, { shell: true, encoding: 'utf8' });
  // dsh 的 profile 目录(默认 ~/.dsh/profiles), 排除 node_modules
  const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');
  const PROFS = fs.existsSync(path.join(DSH_HOME, 'profiles'))
    ? fs.readdirSync(path.join(DSH_HOME, 'profiles'), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== 'node_modules').map((d) => d.name)
    : [];
  const prof = PROFS.includes('web') ? 'web' : PROFS[0];

  if (MODE === 'dsh') {
    if (run('dsh --version').status !== 0) {
      console.error('未找到 dsh 命令 —— 请先安装 DeepSeek Harness:');
      console.error('  npm install -g @deepseek-ai/dsh');
      process.exit(1);
    }
    if (!PROFS.length) {
      console.error('未找到任何 dsh profile(' + path.join(DSH_HOME, 'profiles') + ') —— 先跑一次 dsh web 生成 profile 再装。');
      process.exit(1);
    }
    if (run('pnpm --version').status !== 0) {
      console.log('dsh 插件机制依赖 pnpm, 未检测到 → 自动安装: npm install -g pnpm ...');
      const pr = run('npm install -g pnpm');
      if (run('pnpm --version').status !== 0) {
        console.error('pnpm 安装失败: ' + String(pr.stderr || pr.stdout || '').slice(0, 150));
        console.error('请手动执行 npm install -g pnpm 后重试。');
        process.exit(1);
      }
    }
    const r = run('dsh plugin --profile ' + prof + ' add "' + PKG_FWD + '"');
    if (r.status !== 0) {
      console.error('dsh plugin add 失败(' + r.status + '): ' + String(r.stderr || r.stdout || '').slice(0, 200));
      console.error('请手动执行: dsh plugin --profile ' + prof + ' add "' + PKG_FWD + '"');
      process.exit(1);
    }
    // 验证: 配置树里应出现 esp32-light 层
    const dump = run('dsh --profile ' + prof + ' --dump-config');
    const ok = (dump.stdout || '').includes('esp32-light');
    console.log(ok
      ? '已安装并激活 dsh 插件 esp32-light (profile: ' + prof + ', --dump-config 已验证)'
      : '已执行 dsh plugin add (profile: ' + prof + '), 但 --dump-config 未见 esp32-light —— 请手动核查。');
    console.log('注意: 重启 dsh (dsh web) 后生效; 灯效走本机 daemon UDP 7878, 与其他 agent 共用同一块板。');
    console.log('      事件名已对照 dsh 0.1.0-rc.7 源码核实(session/event 总线); dsh 是预览版,');
    console.log('      升级后若灯不亮: dsh plugin --profile ' + prof + ' add "' + PKG_FWD + '" 重装一次。');
    console.log('      多 profile 用户想装进别的 profile: dsh plugin --profile <名字> add "' + PKG_FWD + '"');
  } else {
    const target = prof || 'web';
    const r = run('dsh plugin --profile ' + target + ' remove dsh-esp32-light');
    console.log(r.status === 0
      ? '已从 dsh profile "' + target + '" 移除插件 dsh-esp32-light。'
      : 'dsh plugin remove 返回 ' + r.status + ' —— 确认 profile 里已无 esp32-light 即可(可用 dsh --profile ' + target + ' --dump-config 查看)。');
  }

// ---------- Hermes Agent: Python 插件 ~/.hermes/plugins/esp32-light/ ----------
} else if (MODE.startsWith('hermes')) {
  const HM = path.join(HOME, '.hermes');
  const PDIR = path.join(HM, 'plugins', 'esp32-light');
  if (MODE === 'hermes') {
    if (!fs.existsSync(HM)) {
      console.error('未找到 ' + HM + ' —— 请先安装并启动过一次 Hermes Agent 再运行本安装器。');
      process.exit(1);
    }
    fs.mkdirSync(PDIR, { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'hermes-esp32-light', '__init__.py'),
      path.join(PDIR, '__init__.py'));
    console.log('已安装 Hermes 插件 → ' + PDIR);
    console.log('注意: 重启 hermes 会话后生效(插件随会话加载); 全部为纯观察钩子, 不改写主流程数据。');
    console.log('      审批等待有原生 pre_approval_request → alarm 警灯。');
    console.log('      单测: python "' + path.join(PDIR, '__init__.py').replace(/\\/g, '/') + '" demo');
  } else {
    if (fs.existsSync(PDIR)) {
      fs.rmSync(PDIR, { recursive: true, force: true });
      console.log('已移除 Hermes 插件目录 ' + PDIR);
    } else {
      console.log('Hermes 插件本就未安装, 无需移除。');
    }
  }

// ---------- Gemini CLI / Qwen Code: settings.json 的 hooks 段 ----------
// 两家结构同 Claude 式嵌套(matcher → hooks[]), 但 timeout 单位是毫秒(写 5000)。
// 只动 cfg.hooks 一个键, settings.json 里其他配置(主题/模型等)原样保留。
} else if (MODE.startsWith('gemini') || MODE.startsWith('qwen')) {
  const isG = MODE.startsWith('gemini');
  const label = isG ? 'Gemini CLI' : 'Qwen Code';
  const dir = isG ? GEMINI_DIR : QWEN_DIR;
  const file = isG ? GEMINI : QWEN;
  const EVENTS = isG ? GEMINI_EVENTS : QWEN_EVENTS;
  if (!MODE.endsWith('-remove') && !fs.existsSync(dir)) {
    console.error('未找到 ' + dir + ' —— 请先安装并启动过一次 ' + label + ' 再运行本安装器。');
    process.exit(1);
  }
  if (!fs.existsSync(file)) {
    if (MODE.endsWith('-remove')) { console.log(label + ' 钩子本就未安装, 无需移除。'); process.exit(0); }
    fs.mkdirSync(dir, { recursive: true });
  }
  const cfg = readJson(file, label + ' settings.json');
  const hooks = cfg.hooks || {};
  // 清掉属于本工具的条目(转发器路径识别), 保留其他钩子
  const isOursGQ = (h) => !!(h && typeof h.command === 'string' && h.command.includes('gemini-qwen-forward.mjs'));
  for (const ev of Object.keys(hooks)) {
    hooks[ev] = (hooks[ev] || []).map((entry) => {
      if (!entry || !Array.isArray(entry.hooks)) return entry;
      return { ...entry, hooks: entry.hooks.filter((h) => !isOursGQ(h)) };
    }).filter((entry) => (entry.hooks || []).length > 0);
    if (!hooks[ev].length) delete hooks[ev];
  }
  if (!MODE.endsWith('-remove')) {
    for (const [ev, matcher] of Object.entries(EVENTS)) {
      const list = hooks[ev] || (hooks[ev] = []);
      let group = list.find((g) => g && g.matcher === matcher);
      if (!group) { group = { matcher, hooks: [] }; list.push(group); }
      const hk = { type: 'command', command: `node "${GFWD}"`, timeout: 5000, name: 'agent-light' };
      if (!isG) hk.async = true;   // Qwen 支持 async 命令钩子(后台执行, 零阻塞)
      group.hooks.push(hk);
    }
  }
  if (Object.keys(hooks).length) cfg.hooks = hooks;
  else delete cfg.hooks;
  writeJson(file, cfg, !MODE.endsWith('-remove'));
  console.log((MODE.endsWith('-remove') ? '已移除' : '已安装') + ' ' + label + ' 钩子 → ' + file);
  if (!MODE.endsWith('-remove')) {
    console.log('注意: 新开的 ' + (isG ? 'gemini' : 'qwen') + ' 会话生效; /hooks 命令可查看已装事件。');
    if (isG) {
      console.log('      事件名已对照官方 hooks 文档(BeforeTool/AfterTool 自成一套, 非 Claude 命名);');
      console.log('      Notification 只在权限等待(ToolPermission)时点亮警灯。');
    } else {
      console.log('      PostToolUseFailure/StopFailure 为独立失败事件(精准红灯); 钩子已开 async 后台执行。');
    }
  }

// ---------- 一键全装: 检测到哪家 CLI 就装哪家(缺的跳过), 不逐个询问 ----------
// 实现: 依次以子进程跑本安装器的各分支(stdio 直通, 各分支自带检测与提示)。
} else if (MODE === 'all') {
  const WB_INST = path.join(HOME, '.workbuddy', 'plugins', 'installed_plugins.json');
  const STEPS = [
    { label: 'Claude Code', flag: '', ok: () => true },
    { label: 'Codex CLI', flag: '--codex', ok: () => fs.existsSync(CODEX_DIR) },
    { label: 'WorkBuddy', flag: '--workbuddy', ok: () => fs.existsSync(WB_INST) },
    { label: 'CodeBuddy Code', flag: '--codebuddy', ok: () => fs.existsSync(CODEBUDDY_DIR) },
    { label: 'Cursor', flag: '--cursor', ok: () => fs.existsSync(CURSOR_DIR) },
    { label: 'DeepSeek Harness', flag: '--dsh', ok: () => cp.spawnSync('dsh', ['--version'], { shell: true }).status === 0 },
    { label: 'Hermes', flag: '--hermes', ok: () => fs.existsSync(path.join(HOME, '.hermes')) },
    { label: 'Gemini CLI', flag: '--gemini', ok: () => fs.existsSync(GEMINI_DIR) },
    { label: 'Qwen Code', flag: '--qwen', ok: () => fs.existsSync(QWEN_DIR) },
  ];
  let i = 0;
  for (const s of STEPS) {
    i++;
    if (!s.ok()) { console.log('[' + i + '/9] ' + s.label + ' 未检测到, 跳过。'); continue; }
    console.log('[' + i + '/9] ' + s.label + ' —— 安装中 ...');
    const r = cp.spawnSync(process.execPath, [__filename, s.flag], { stdio: 'inherit' });
    if (r.status !== 0) console.log('      (' + s.label + ' 返回 ' + r.status + ', 继续下一家)');
  }
  console.log('');
  console.log('一键全装结束。生效提醒:');
  console.log('  Codex: 打开 codex → 输 /hooks → 方向键选中本工具钩子 → Trust 信任一次(不做灯不亮), 新开会话。');
  console.log('  WorkBuddy / dsh: 完全重启一次才加载;  Cursor / Gemini / Qwen / CodeBuddy: 新会话即生效。');
}
