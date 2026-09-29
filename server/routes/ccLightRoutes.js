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
  { name: 'main.py', desc: '板上固件（MicroPython）：9 种灯效 + BLE 蓝牙服务 + 极性自动检测' },
  { name: 'daemon.py', desc: '电脑守护进程：BLE 连接板子 + UDP 命令接收 + 断线重连 + 看门狗' },
  { name: 'send.js', desc: '命令发送器：Claude Code 钩子入口（也可手动 node send.js traffic 测试）' },
  { name: 'flash-firmware.cmd', desc: '一键刷机：自动装 esptool/mpremote（优先用包内 wheels 离线装）→ 输 COM 号 → 擦除 → 刷 MicroPython → 传 main.py → 重启板子——需 USB 数据线连板子' },
  { name: 'cc-light-install.cmd', desc: '一键安装：自动找 Python、缺 bleak 自动装（有 wheels 时离线装）、注册开机自启、启动守护进程（有 Node 还会问是否装钩子）——与程序文件放同一文件夹双击' },
  { name: 'cc-light-uninstall.cmd', desc: '一键卸载：熄灯 + 停守护进程 + 删开机自启任务 + 卸载 Claude Code 钩子' },
  { name: 'install-hooks.js', desc: '钩子安装器：合并进 ~/.claude/settings.json，自动备份；--remove 卸载' },
  { name: 'start-daemon.cmd', desc: '守护进程一键启动（双击；优先用 PATH 里的 pythonw）' },
  { name: 'README.md', desc: '完整使用说明：接线 / 刷机 / 蓝牙连接 / 排障' },
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

module.exports = router;
