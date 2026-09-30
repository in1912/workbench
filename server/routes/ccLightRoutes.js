// Agent红绿灯（CC-LIGHT）下载服务：智能家居页「Agent红绿灯」tab 的文件来源。
// 程序实体在 server/cc-light/（与本机开发目录 D:\CC\ESP32\light 同源，更新后复制过来），
// 权限：归 smarthome.cclight tab（TAB_PATHS 前缀 /cclight），登录 + 有该 tab 权限即可下载。
const express = require('express');
const fs = require('fs');
const path = require('path');
const { buildZip } = require('../services/zipService');

const router = express.Router();
const DIR = path.join(__dirname, '..', 'cc-light');

// 下载区展示顺序 + 说明（与前端 tab 的下载清单一致）
const FILES = [
  { name: 'main.py', desc: '板上固件（MicroPython）：10 种灯效（含三色全亮 all）+ BLE 蓝牙服务 + 极性自动检测' },
  { name: 'daemon.py', desc: '电脑守护进程：BLE 连接板子 + UDP 命令接收 + 断线重连 + 看门狗（只认 UDP 命令, 天然多 agent 通用）' },
  { name: 'send.js', desc: '命令发送器：Claude Code / Codex CLI 钩子入口（也可手动 node send.js all / traffic 测试）' },
  { name: 'workbuddy-forward.mjs', desc: 'WorkBuddy / CodeBuddy 钩子转发器（WorkBuddy 安装时复制进其插件目录, 永远 exit 0 不阻塞会话）' },
  { name: 'cursor-forward.mjs', desc: 'Cursor 钩子转发器：驼峰事件名映射 + 权限钩子自动回放行 JSON（防止拦掉工具调用）' },
  { name: 'gemini-qwen-forward.mjs', desc: 'Gemini CLI / Qwen Code 钩子转发器：两套事件名自动分发, Gemini 结构化失败检测 + 权限等待警灯, stdout 零输出' },
  { name: 'dsh-esp32-light/package.json', desc: 'DeepSeek Harness (dsh) 插件包声明（dsh.bundle 层声明, 装完即激活）' },
  { name: 'dsh-esp32-light/cordis.patch.yml', desc: 'dsh 插件 profile 层插入声明（--dump-config 可验证激活）' },
  { name: 'dsh-esp32-light/dist/index.js', desc: 'dsh 插件预编译版（免 tsc 直接 dsh plugin add; 事件名对照 dsh 0.1.0-rc.7 源码核实）' },
  { name: 'dsh-esp32-light/src/index.ts', desc: 'dsh 插件 TypeScript 源码（改后需 npx tsc 重新编译）' },
  { name: 'dsh-esp32-light/tsconfig.json', desc: 'dsh 插件 TS 编译配置（npx tsc 重建 dist 用）' },
  { name: 'hermes-esp32-light/__init__.py', desc: 'Hermes Agent Python 插件（10 个纯观察钩子, 含原生审批等待警灯; 安装时复制到 ~/.hermes/plugins/esp32-light/）' },
  { name: 'flash-firmware.cmd', desc: 'Windows 一键刷机：自动装 esptool/mpremote（优先用包内 wheels 离线装）→ 输 COM 号 → 擦除 → 刷 MicroPython → 传 main.py → 重启板子——需 USB 数据线连板子' },
  { name: 'cc-light-install.cmd', desc: 'Windows 一键安装：自动找 Python、缺 bleak 自动装（有 wheels 时离线装）、注册开机自启、启动守护进程；有 Node 时依次检测询问安装九家 agent 钩子——与程序文件放同一文件夹双击' },
  { name: 'cc-light-uninstall.cmd', desc: 'Windows 一键卸载：熄灯 + 停守护进程 + 删开机自启任务 + 卸载九家 agent 钩子' },
  { name: 'install-hooks.js', desc: '钩子安装器：九家 agent 通吃（Claude/Codex/Cursor/CodeBuddy/Gemini/Qwen 配置文件 + WorkBuddy 本地插件 + dsh 插件包 + Hermes Python 插件）, Windows/macOS 通用, 自动备份；--remove / --codex-remove / --workbuddy-remove / --codebuddy-remove / --cursor-remove / --dsh-remove / --hermes-remove / --gemini-remove / --qwen-remove 卸载' },
  { name: 'start-daemon.cmd', desc: '守护进程一键启动（双击；优先用 PATH 里的 pythonw）' },
  { name: 'cc-light-install.command', desc: 'macOS 一键安装（LaunchAgent 自启 + 逐家询问钩子；双击或 bash 执行）' },
  { name: 'cc-light-uninstall.command', desc: 'macOS 一键卸载（熄灯 + 删 LaunchAgent + 九家钩子全清）' },
  { name: 'flash-firmware-mac.command', desc: 'macOS 一键刷机（列出 /dev/cu.usb* 串口 → 擦除 → 刷固件 → 传 main.py——Mac 也能刷 ESP32）' },
  { name: 'README.md', desc: '完整使用说明：接线 / 刷机（Win+Mac）/ 蓝牙连接 / 九家 agent 接入对比 / macOS 安装与刷机 / 多 agent 同时运行说明 / 排障' },
  { name: 'ESP32_GENERIC_C3-20260824-v1.29.0.bin', desc: 'MicroPython 固件 ESP32-C3 通用版 v1.29.0（刷机用，4MB Flash）' },
];

router.get('/cclight/files', (req, res) => {
  res.json({
    files: FILES.map((f) => {
      try {
        return { ...f, size: fs.statSync(path.join(DIR, f.name)).size };
      } catch {
        return { ...f, size: 0, missing: true };
      }
    }),
  });
});

router.get('/cclight/file/:name', (req, res) => {
  const f = FILES.find((x) => x.name === req.params.name);   // 白名单，杜绝路径穿越
  if (!f) return res.status(404).json({ error: '文件不存在' });
  const p = path.join(DIR, f.name);
  if (!fs.existsSync(p)) return res.status(404).json({ error: '文件缺失' });
  res.download(p);
});

router.get('/cclight/package', (req, res) => {
  const entries = [];
  for (const f of FILES) {
    const p = path.join(DIR, f.name);
    if (fs.existsSync(p)) entries.push({ name: 'cc-light/' + f.name, data: fs.readFileSync(p) });
  }
  // 刷机/运行依赖 wheel 包（v1.8.3）：esptool + mpremote + bleak 全依赖，随打包下载附带、可完全离线安装；
  // 只进 zip 不进单文件下载清单（单独下载没有意义，脚本会优先用 wheels\、缺了自动走网络）。
  const wheelsDir = path.join(DIR, 'wheels');
  if (fs.existsSync(wheelsDir)) {
    for (const w of fs.readdirSync(wheelsDir).sort()) {
      if (w.endsWith('.whl')) entries.push({ name: 'cc-light/wheels/' + w, data: fs.readFileSync(path.join(wheelsDir, w)) });
    }
  }
  if (!entries.length) return res.status(404).json({ error: '没有可下载文件' });
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', 'attachment; filename="cc-light.zip"');
  res.send(buildZip(entries));
});

// macOS 专用包（v1.8.8）：不带 Windows 件（.cmd / wheels——macOS 依赖是纯 Python 包, 联网 pip 即可）,
// 带 .command 三件套（安装/卸载/刷机, LaunchAgent 自启）。
const MAC_FILES = [
  'main.py', 'daemon.py', 'send.js', 'workbuddy-forward.mjs', 'cursor-forward.mjs',
  'gemini-qwen-forward.mjs',
  'dsh-esp32-light/package.json', 'dsh-esp32-light/cordis.patch.yml',
  'dsh-esp32-light/dist/index.js', 'dsh-esp32-light/src/index.ts',
  'dsh-esp32-light/tsconfig.json',
  'hermes-esp32-light/__init__.py',
  'install-hooks.js', 'cc-light-install.command', 'cc-light-uninstall.command',
  'flash-firmware-mac.command', 'README.md', 'ESP32_GENERIC_C3-20260824-v1.29.0.bin',
];

router.get('/cclight/package-mac', (req, res) => {
  const entries = [];
  for (const name of MAC_FILES) {
    const p = path.join(DIR, name);
    if (fs.existsSync(p)) entries.push({ name: 'cc-light/' + name, data: fs.readFileSync(p) });
  }
  if (!entries.length) return res.status(404).json({ error: '没有可下载文件' });
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', 'attachment; filename="cc-light-mac.zip"');
  res.send(buildZip(entries));
});

module.exports = router;
