# CC-LIGHT — Claude Code CLI 状态指示灯

ESP32-C3 SuperMini + 三色红绿灯模块 = Claude Code 工作状态室外灯。
**全程蓝牙(BLE)通讯**，USB 仅首次刷固件时使用，之后拔掉数据线随便找个 USB 电源供电即可。

## 灯效对照

| 灯效 | 触发时机 |
|------|---------|
| 开机演示 demo | 会话开启(SessionStart)：自检闪 R→Y→G 后轮播 7 种灯效 |
| 连贯跑马灯 thinking | 提交提示词后(UserPromptSubmit)：AI 正在分析 |
| 柔和慢速跑马灯 ai | 工具执行完回到生成(PostToolUse 无错误) |
| 黄灯慢闪 busy | 正在执行工具/命令(PreToolUse) |
| 绿灯常亮 success | 任务完成(Stop) |
| 红灯快闪 error | 工具执行失败(PostToolUse 检测到错误) |
| 红黄交替警灯 alarm | Claude 等待权限确认(Notification) |
| 红绿灯循环 traffic | 手动演示模式 |
| 三色全亮 all | 手动模式（红黄绿同时亮，混白光）：`node send.js all` |
| 全灭 off | 会话结束(SessionEnd) / 看门狗超时 |

## 硬件接线（当前已接好）

| 模块引脚 | 开发板 |
|---------|--------|
| R 红 | GPIO4 |
| Y 黄 | GPIO3 |
| G 绿 | GPIO2 |
| gnd 公共端 | **GND**（共阴；若换共阳模块接 3.3V，固件上电自动检测极性） |

## 文件清单

| 文件 | 用途 |
|------|------|
| `main.py` | 板上固件（MicroPython）：灯效引擎 + BLE 蓝牙服务(广播名 Agent light) |
| `daemon.py` | 电脑端守护进程：BLE 连接板子 + 监听 UDP 127.0.0.1:7878 + 断线重连 + 看门狗 |
| `send.js` | 命令发送器：Claude Code 钩子入口（也可手动 `node send.js traffic` 测试） |
| `flash-firmware.cmd` | 一键刷机：装 esptool/mpremote（优先 wheels 离线装）→ 输 COM 号 → 擦除 → 刷固件 → 传 main.py → 重启 |
| `install-hooks.js` | 把钩子合并进 `~/.claude/settings.json`（自动备份；`--remove` 卸载） |
| `start-daemon.cmd` | 守护进程手动启动（双击） |
| `wheels/` | esptool + mpremote + bleak 全依赖离线 wheel 包（刷机/安装脚本优先用它，没网也能装；仅随打包 zip 附带） |
| `ESP32_GENERIC_C3-*.bin` | MicroPython 固件备份 |
| `daemon.log` / `status.json` | 运行日志与当前状态（connected/mode/fw） |

## 日常使用

1. 开发板通电（USB 充电器即可，无需连电脑）
2. 电脑上守护进程在跑（见下方"开机自启"）
3. 正常使用 claude CLI，灯自动跟随状态 —— 新开的 claude 会话才会加载钩子

手动控制：`node <cc-light文件夹>\send.js <模式名>`（all=三色全亮 / demo=轮播 / traffic=红绿灯循环 / off=熄灭）

## 一键安装 / 卸载（推荐）

- **安装**：`cc-light-install.cmd` 与 daemon.py 等文件放同一文件夹（打包下载解压后即满足），双击——自动找 Python（3.9+ 64 位）、缺 bleak 自动装（有 `wheels/` 时离线装）、注册开机自启任务 `CC-Light-Daemon`、立即启动守护进程；装了 Node.js 会询问是否同时安装 Claude Code 钩子；最后自动读 daemon.log 验证并显示连接结果。Node.js 无需单独安装——用 Claude Code CLI 的机器已自带
- **卸载**：双击 `cc-light-uninstall.cmd`——先发熄灯命令、停守护进程、删自启任务、卸载 Claude Code 钩子；文件夹随后手动删除即可（板上固件保留，以后想用再跑安装脚本）

## 开机自启（可选，二选一）

**方式 A：计划任务**（推荐直接双击 `cc-light-install.cmd`，它就是干这个的；手动方式如下，路径换成你的实际 Python 与解压路径）：

```cmd
schtasks /Create /F /TN "CC-Light-Daemon" /TR "\"C:\Users\你\AppData\Local\Programs\Python\Python312\pythonw.exe\" \"D:\解压路径\cc-light\daemon.py\"" /SC ONLOGON /RL LIMITED
schtasks /Run /TN "CC-Light-Daemon"
```

删除：`schtasks /Delete /TN "CC-Light-Daemon" /F`

**方式 B：启动文件夹** —— `Win+R` 输入 `shell:startup`，把 `start-daemon.cmd` 的快捷方式放进去。

## 刷机/更新固件（很少需要）

**一键刷机（推荐）**：USB 数据线连板子，双击 `flash-firmware.cmd`——自动装 esptool/mpremote（有 `wheels/` 时离线装）、列出串口、输 COM 号、确认后自动擦除→刷固件→传 main.py→重启。只改 main.py 不动固件时，可单跑上面两条 mpremote 命令。

```bash
# 假设 python 在 PATH 中; COM3 换成实际串口号
python -m mpremote connect COM3 cp main.py :main.py
python -m mpremote connect COM3 exec 'import machine; machine.reset()'
```

- COM 口在设备管理器里看"USB 串行设备"；自动进下载模式失败时（esptool 反复 Connecting）：**按住 BOOT → 点一下 RST → 松开 BOOT**
- 完整重刷 MicroPython：`python -m esptool --chip esp32c3 --port COM3 --baud 921600 write_flash 0x0 ESP32_GENERIC_C3-20260824-v1.29.0.bin`

## 常见问题

- **蓝牙设置里搜不到「Agent light」**：正常现象，不是故障——设备只支持 BLE 低功耗蓝牙（ESP32-C3 无经典蓝牙），Windows/手机的「蓝牙设置 → 添加设备」列表只显示经典蓝牙设备；且 BLE 设备只在**广播**时可见，守护进程连接成功后广播即暂停（BLE 扫描器也搜不到）。确认连接看 daemon.log 的 `BLE connected`；想亲眼看：停掉守护进程后用 nRF Connect 等 BLE 扫描 App 搜「Agent light」
- **灯全灭且 status.json connected=false**：板子没通电 / 蓝牙被断开；守护进程每几秒自动重连，通电即恢复并续上最后灯态
- **灯态卡死**：看门狗兜底（busy 30 分钟、thinking/ai 15 分钟无变化自动 off）；也可手动 `node send.js off`
- **想看极性检测读数**：`tail daemon.log` 找 `board: Agent light 1.1 HIGH r… y… g…`（LOW=共阳/3.3V 接法，HIGH=共阴/GND 接法）
- **极性不对（该亮不亮/该灭不灭）**：`node send.js xxx` 之外可发 `PING`；极性翻转用蓝牙命令 FORCELOW/FORCEHIGH（需修改 daemon 或临时用 mpremote）
- **卸载**：`node install-hooks.js --remove` + 删计划任务/启动项 + 停守护进程

## 架构

```
claude CLI ──hooks(settings.json)──> node send.js ──UDP 127.0.0.1:7878──> daemon.py
                                                                        │ bleak (BLE GATT, Nordic UART Service)
                                                                        ▼
                                                    ESP32-C3 固件 main.py（灯效线程 + BLE 透传, REPL 留作调试）
```
