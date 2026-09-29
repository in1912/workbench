// CC-LIGHT hooks 安装器 — 把指示灯钩子合并进 Claude Code 用户级配置
// 用法: node install-hooks.js          安装/更新
//       node install-hooks.js --remove 移除
// 说明: 自动备份 settings.json → settings.json.bak-<时间戳>; 只增删本工具的
//       钩子条目(按命令含 "CC/ESP32/light/send.js" 识别), 其他配置原样保留。
'use strict';
const fs = require('fs');
const path = require('path');

const SETTINGS = path.join(process.env.USERPROFILE || '', '.claude', 'settings.json');
const TAG = 'CC/ESP32/light/send.js';      // 识别本工具钩子的特征串
const REMOVE = process.argv[2] === '--remove';

// 事件 → 钩子命令 (固定模式直接传参; post/notify 需读 stdin JSON 判断)
const HOOKS = {
  SessionStart: ['demo'],      // 会话开启 → 开机演示
  UserPromptSubmit: ['thinking'], // 提交提示词 → AI 正在分析
  PreToolUse: ['busy'],        // 即将执行工具/命令 → 黄灯慢闪(阻塞式,发送器要快)
  PostToolUse: ['post'],       // 工具结束 → 读结果: 失败=红快闪, 否则=柔和跑马
  Stop: ['success'],           // 任务完成 → 绿灯常亮
  Notification: ['notify'],    // 权限确认等待 → 红黄警灯
  SessionEnd: ['off'],         // 会话结束 → 全灭
};

let raw = '{}';
try { raw = fs.readFileSync(SETTINGS, 'utf8'); } catch (e) {}
let cfg;
try { cfg = JSON.parse(raw); } catch (e) { console.error('settings.json 解析失败, 先人工检查: ' + e.message); process.exit(1); }

const hooks = cfg.hooks || {};
for (const ev of Object.keys(hooks)) {
  hooks[ev] = (hooks[ev] || []).map((entry) => {
    if (!entry || !Array.isArray(entry.hooks)) return entry;
    const kept = entry.hooks.filter((h) => !(h && typeof h.command === 'string' && h.command.includes(TAG)));
    return { ...entry, hooks: kept };
  }).filter((entry) => (entry.hooks || []).length > 0);
  if (!hooks[ev].length) delete hooks[ev];
}

if (!REMOVE) {
  for (const [ev, args] of Object.entries(HOOKS)) {
    const list = hooks[ev] || (hooks[ev] = []);
    // 同 matcher 的组存在则并入, 否则新建 matcher "*" 组
    let group = list.find((g) => g.matcher === '*');
    if (!group) { group = { matcher: '*', hooks: [] }; list.push(group); }
    for (const a of args) {
      group.hooks.push({ type: 'command', command: `node D:/${TAG} ${a}`, timeout: 15 });
    }
  }
}

if (Object.keys(hooks).length) cfg.hooks = hooks;
else delete cfg.hooks;

const backup = SETTINGS + '.bak-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
if (!REMOVE) fs.copyFileSync(SETTINGS, backup);
fs.writeFileSync(SETTINGS, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

console.log((REMOVE ? '已移除' : '已安装') + ' CC-LIGHT 钩子 → ' + SETTINGS);
if (!REMOVE) console.log('原配置备份: ' + backup);
console.log('注意: 钩子对新开的 claude 会话生效(当前已开的会话不加载)。');
