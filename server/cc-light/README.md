# CC-LIGHT — 九家 AI Agent 状态指示灯

ESP32-C3 SuperMini + 三色红绿灯模块 = AI CLI 工作状态室外灯（**一套板子同时兼容 Claude Code、OpenAI Codex CLI、WorkBuddy、CodeBuddy Code、Cursor、DeepSeek Harness、Hermes、Gemini CLI、Qwen Code 九家 agent**，见下方「多 agent 兼容」）。
**全程蓝牙(BLE)通讯**，USB 仅首次刷固件时使用，之后拔掉数据线随便找个 USB 电源供电即可。支持 **Windows 与 macOS**（见「macOS 安装」）。

## 灯效对照

| 灯效 | 触发时机 |
|------|---------|
| 开机演示 demo | 会话开启（SessionStart / sessionStart）：自检闪 R→Y→G 后轮播 7 种灯效 |
| 连贯跑马灯 thinking | 提交提示词后（UserPromptSubmit / BeforeAgent 等）：AI 正在分析 |
| 柔和慢速跑马灯 ai | 工具执行完无错误（PostToolUse / AfterTool / tool/result） |
| 黄灯慢闪 busy | 正在执行工具/命令（PreToolUse / BeforeTool / tool/call） |
| 绿灯常亮 success | 任务完成（Stop / AfterAgent / turn/end） |
| 红灯快闪 error | 工具执行失败（PostToolUse 检测到错误；Cursor/Qwen 有独立失败事件、Gemini 看结构化 error 字段、dsh/Hermes 有失败回调，精准触发） |
| 红黄交替警灯 alarm | 等待权限确认（Claude/WorkBuddy/CodeBuddy 的 Notification；Codex 的 PermissionRequest；Gemini 的 Notification(ToolPermission)；Qwen 的 PermissionRequest；Hermes 的 pre_approval_request） |
| 红绿灯循环 traffic | 手动演示模式 |
| 三色全亮 all | 手动模式（红黄绿同时亮，混白光）：`node send.js all` |
| 全灭 off | 会话结束（SessionEnd）；或看门狗超时自动熄灭 |

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
| `daemon.py` | 电脑端守护进程：BLE 连接板子 + 监听 UDP 127.0.0.1:7878 + 断线重连 + 看门狗（Windows / macOS 通用） |
| `send.js` | 命令发送器：Claude Code / Codex CLI 钩子入口（也可手动 `node send.js traffic` 测试） |
| `workbuddy-forward.mjs` | WorkBuddy / CodeBuddy 钩子转发器（WorkBuddy 安装时复制进插件目录，自包含） |
| `cursor-forward.mjs` | Cursor 钩子转发器（驼峰事件名 + 权限钩子放行 JSON） |
| `gemini-qwen-forward.mjs` | Gemini CLI / Qwen Code 钩子转发器（两套事件名分发；Gemini 结构化失败检测；stdout 零输出） |
| `dsh-esp32-light/` | DeepSeek Harness (dsh) 进程内插件包（dist/ 预编译 + src/ TS 源码 + cordis.patch.yml 层声明） |
| `hermes-esp32-light/` | Hermes Agent Python 插件（`__init__.py`，安装时复制到 `~/.hermes/plugins/esp32-light/`） |
| `flash-firmware.cmd` | Windows 一键刷机：装 esptool/mpremote（优先 wheels 离线装）→ 输 COM 号 → 擦除 → 刷固件 → 传 main.py → 重启 |
| `install-hooks.js` | 九家钩子安装器（自动备份；`--remove` / `--codex-remove` / `--workbuddy-remove` / `--codebuddy-remove` / `--cursor-remove` / `--dsh-remove` / `--hermes-remove` / `--gemini-remove` / `--qwen-remove` 卸载） |
| `start-daemon.cmd` | 守护进程手动启动（双击） |
| `cc-light-install.cmd` / `cc-light-uninstall.cmd` | Windows 一键安装 / 卸载（装守护进程 + 逐家询问装钩子 / 全部清理） |
| `cc-light-install.command` / `cc-light-uninstall.command` / `flash-firmware-mac.command` | macOS 一键安装 / 卸载 / 刷机（LaunchAgent 自启；见下方「macOS 安装」） |
| `wheels/` | esptool + mpremote + bleak 全依赖离线 wheel 包（刷机/安装脚本优先用它，没网也能装；仅随 Windows 打包 zip 附带） |
| `ESP32_GENERIC_C3-*.bin` | MicroPython 固件备份 |
| `daemon.log` / `status.json` | 运行日志与当前状态（connected/mode/fw） |

## 日常使用

1. 开发板通电（USB 充电器即可，无需连电脑）
2. 电脑上守护进程在跑（见下方"开机自启"）
3. 正常使用任一已装钩子的 CLI，灯自动跟随状态（各家生效条件见横向对比表「额外必要步骤」列）

手动控制：`node <cc-light文件夹>\send.js <模式名>`（all=三色全亮 / demo=轮播 / traffic=红绿灯循环 / off=熄灭）

## 一键安装 / 卸载（推荐，Windows）

- **安装**：`cc-light-install.cmd` 与 daemon.py 等文件放同一文件夹（打包下载解压后即满足），双击——自动找 Python（3.9+ 64 位）、缺 bleak 自动装（有 `wheels/` 时离线装）、注册开机自启任务 `CC-Light-Daemon`、立即启动守护进程；装了 Node.js 会依次检测并询问：Claude Code → Codex（`~/.codex`）→ WorkBuddy（`~/.workbuddy/plugins`）→ CodeBuddy（`~/.codebuddy`）→ Cursor（`~/.cursor`）→ DeepSeek Harness（`dsh` 命令）→ Hermes（`~/.hermes`）→ Gemini CLI（`~/.gemini`）→ Qwen Code（`~/.qwen`）；最后自动读 daemon.log 验证并显示连接结果。Node.js 无需单独安装——用 Claude Code CLI 的机器已自带
- **卸载**：双击 `cc-light-uninstall.cmd`——先发熄灯命令、停守护进程、删自启任务、卸载九家钩子；文件夹随后手动删除即可（板上固件保留，以后想用再跑安装脚本）

## macOS 安装（苹果电脑专用包）

**完全可行**：守护进程用的 bleak 库官方支持 macOS（走系统 CoreBluetooth）；九家 CLI 的钩子配置文件（`~/.claude` / `~/.codex` / `~/.workbuddy` / `~/.codebuddy` / `~/.cursor` / dsh profile / `~/.hermes` / `~/.gemini` / `~/.qwen`）格式与 Windows 完全一致；转发器是纯 Node/Python 脚本跨平台。板子不挑电脑——同一块板配哪台电脑都行。

**获取**：下载 `cc-light-mac.zip`（工作台「Agent红绿灯」页顶部「下载打包(macOS)」按钮；比 Windows 包小，不含 Windows 专用件——.cmd 脚本和离线 wheels，macOS 的依赖全是纯 Python 包，联网 `pip install` 一步到位）。

**安装**（在 Mac 上）：

1. 解压 `cc-light-mac.zip`（得到 cc-light 文件夹，所有文件在一起）
2. 双击 `cc-light-install.command`——自动找 python3（系统自带，需 Xcode 命令行工具：没有就先跑 `xcode-select --install`）→ 装 bleak → 注册开机自启（LaunchAgent：`~/Library/LaunchAgents/com.cclight.daemon.plist`）→ 立即启动守护进程 → 逐家检测询问装钩子（同 Windows 九家）
   - **双击提示"无法执行/没有权限"时**（zip 解压可能丢失可执行位）：打开"终端"，`cd` 到该文件夹执行 `bash cc-light-install.command`（效果完全一样）
3. **首次蓝牙权限**：macOS 会弹「python3/终端 想要使用蓝牙」→ 点**允许**（只问一次）。若当时没弹且灯一直不连：终端里跑一次 `python3 daemon.py`，授权后 Ctrl+C，再 `launchctl start com.cclight.daemon`
4. 验证：看安装窗口末尾 `tail daemon.log` 出现 `BLE connected` 即成功；新开任一 CLI 会话测试灯效

**卸载**：双击（或 `bash` 执行）`cc-light-uninstall.command`——熄灯 → 卸载并删除 LaunchAgent → 停守护进程 → 九家钩子全清。

### macOS 刷机（重点：Mac 也能给 ESP32 刷固件）

**结论：可以。** esptool / mpremote 都是纯 Python 工具，在 macOS 上完整支持 ESP32-C3；唯一与 Windows 不同的是串口名和驱动。

**步骤**（新板子首次使用 / 换板子时）：

1. USB **数据线**（不能是纯充电线）连接 ESP32-C3 与 Mac
2. 双击 `flash-firmware-mac.command`（或终端 `bash flash-firmware-mac.command`）——自动联网装 esptool/mpremote → 列出所有 `/dev/cu.usb*` 串口让你选 → 确认后自动：擦除整片 → 写入 MicroPython 固件 → 传入 `main.py` → 复位重启
3. 串口识别要点：
   - 脚本会列出形如 `/dev/cu.usbmodemXXXX` / `/dev/cu.usbserial-XXXX` 的串口，选带 usb 的那一行
   - 没有任何 `/dev/cu.usb*`：换一条**数据线**（最常见原因）、换一个 USB 口；老款 CH340 板子需装 CH340 驱动（macOS 10.14+ 一般免驱，ESP32-C3 自带 USB 通常免驱）
4. **进不去下载模式时**（esptool 反复 `Connecting....`）：按住板上 **BOOT** 键 → 点一下 **RST** → 松开 BOOT，再试
5. 刷完后拔线，板子接任意 USB 电源即可（之后全靠蓝牙，无需再连线）
6. 手动刷（想自己敲命令时）：

```bash
python3 -m pip install --user esptool mpremote
python3 -m esptool --chip esp32c3 --port /dev/cu.usbmodemXXXX --baud 921600 erase_flash
python3 -m esptool --chip esp32c3 --port /dev/cu.usbmodemXXXX --baud 921600 write_flash 0x0 ESP32_GENERIC_C3-20260824-v1.29.0.bin
python3 -m mpremote connect /dev/cu.usbmodemXXXX cp main.py :main.py
python3 -m mpremote connect /dev/cu.usbmodemXXXX exec 'import machine; machine.reset()'
```

**与 Windows 包的差异**：

| | Windows 包 | macOS 包 |
|---|---|---|
| 安装/卸载脚本 | `cc-light-*.cmd`（双击） | `cc-light-*.command`（双击；失效就 `bash` 执行） |
| 开机自启 | 计划任务 CC-Light-Daemon | LaunchAgent `com.cclight.daemon` |
| Python | pythonw.exe（3.9+ 64 位） | 系统 python3（Xcode 命令行工具自带） |
| bleak 等依赖 | 优先 `wheels/` 离线装 | 联网 `pip install --user`（依赖是纯 Python 包） |
| 刷机串口 | COMx（设备管理器看） | `/dev/cu.usb*`（脚本自动列出） |
| 刷机工具 | flash-firmware.cmd | flash-firmware-mac.command（流程一致，串口名不同） |
| 蓝牙权限 | 无需授权弹窗 | 首次弹「想要使用蓝牙」→ 允许一次 |

说明：Windows 侧九家全链路已实测；macOS 脚本按 bleak/LaunchAgent 标准写法编写，首次在 Mac 上部署请按上面第 3、4 步验证（尤其蓝牙授权弹窗）。

## 多 agent 兼容（守护进程只认 UDP，谁发都一样）

**总原理**：守护进程只认「本机 UDP 7878 上的 `MODE:灯效` 命令」，根本不关心包是谁发的。所以任何带"生命周期钩子/插件"的 agent 都能接入：给它配一份适配（配置文件/插件/独立转发器），事件发生时往 7878 发一个词即可——**同一个守护进程、同一块板子，固件与看门狗零改动**。

### Codex CLI 接入

Codex CLI 从 2026 年 9 月起支持生命周期钩子（`~/.codex/hooks.json`），事件名与 Claude Code 基本同名、命令同样从 stdin 收 JSON，直接复用 send.js。

**安装**：

1. 装 Codex CLI（`npm i -g @openai/codex`）并登录过一次（`~/.codex` 已生成）
2. 双击 `cc-light-install.cmd` 检测到 Codex 时回答 Y；或手动 `node install-hooks.js --codex`
3. **关键一步——信任钩子**：Codex 出于安全要求，新钩子必须人工信任后才执行。打开 codex → 输入 `/hooks` → Review → **Trust**。**没做这一步 = 灯对 codex 无反应**（「装了却没效果」的头号原因）
4. 新开 codex 会话测试

**与 Claude Code 的区别**：配置在独立文件 `~/.codex/hooks.json`；无 Notification → 权限等待由 **PermissionRequest** 触发警灯；无 SessionEnd → 会话结束不灭灯，靠看门狗兜底；PreToolUse 只拦 Bash / apply_patch / MCP 工具。
**映射**：SessionStart→demo；UserPromptSubmit→thinking；PreToolUse→busy；PostToolUse→失败红闪/正常柔和跑马；PermissionRequest→alarm；Stop→success。

### WorkBuddy 接入

**原理**：WorkBuddy 的钩子不走全局配置文件，而是装成**本地插件**（`~/.workbuddy/plugins/`）。插件里一个自包含转发器 `hooks/forward.mjs` 收 stdin JSON → 映射灯效 → UDP 7878。事件与 Claude Code 完全同名同义（含 Notification、SessionEnd），7 个事件全部对上。

**安装**：

1. WorkBuddy 已安装并启动过一次（`~/.workbuddy` 已生成）
2. 双击 `cc-light-install.cmd` 检测到 WorkBuddy 时回答 Y；或手动 `node install-hooks.js --workbuddy`——自动创建插件 → 注册 `installed_plugins.json` → `settings.json>enabledPlugins` 启用（改前都备份）
3. **完全退出并重启 WorkBuddy**（含托盘）→ 新建会话 → 灯走 demo 轮播自检
4. 单测转发器：`echo '{"hook_event_name":"Stop"}' | node workbuddy-forward.mjs` → 绿灯

注意：本地插件注册写法按其插件系统文件结构推导（官方未公开文档）；若重启后灯无反应，去 WorkBuddy 插件管理确认 `workbuddy-light` 已启用。

### CodeBuddy Code 接入

**原理**：CodeBuddy Code 与 WorkBuddy 的钩子引擎**同源**（同一套 PascalCase 事件、同一套 stdin JSON），唯一差异是配置入口——支持在 `~/.codebuddy/settings.json` **顶层直接写事件**（官方"直接格式"，无需装插件）。复用 `workbuddy-forward.mjs`（绝对路径，直接格式下没有插件根环境变量）。

**安装**：

1. CodeBuddy Code 已安装并启动过一次（`~/.codebuddy` 已生成）
2. 双击 `cc-light-install.cmd` 检测到 CodeBuddy 时回答 Y；或手动 `node install-hooks.js --codebuddy`（7 个事件合并进顶层，settings 其他键原样保留）
3. **重启 codebuddy 会话**生效；`/hooks` 应显示 7 个事件；排障 `codebuddy --debug`

**映射（7 个全）**：SessionStart→demo；UserPromptSubmit→thinking；PreToolUse→busy；PostToolUse→失败红闪/正常柔和跑马；Notification→alarm；Stop→success；SessionEnd→off。

### Cursor 接入（Cursor 1.7+）

**原理**：Cursor 1.7 起提供完整 hooks 体系（`~/.cursor/hooks.json`，官方 cursor.com/docs/hooks）。差异由专用转发器 `cursor-forward.mjs` 抹平：事件名驼峰、结果字段是 `tool_output`、且 `preToolUse` 属于**权限钩子**——必须在 stdout 回 `{"permission":"allow"}`，否则 Cursor 会拦掉工具调用。全部由转发器处理，用户无感。

**安装**：

1. Cursor ≥ 1.7 已安装并启动过一次（`~/.cursor` 已生成）
2. 双击 `cc-light-install.cmd` 检测到 Cursor 时回答 Y；或手动 `node install-hooks.js --cursor`（用户级全局；只想某项目生效就放 `<项目>\.cursor\hooks.json`）
3. **无需重启**：hooks.json 热重载；设置 Customize → Hooks 可见本工具命令，Output 面板 Hooks 频道查日志
4. 单测：`echo '{"hook_event_name":"stop"}' | node cursor-forward.mjs` → 绿灯

**映射（8 个全）**：sessionStart→demo；beforeSubmitPrompt→thinking；preToolUse→busy（同时回放行 JSON）；postToolUse→ai；**postToolUseFailure→error**（失败/超时/被拒专用事件，不用启发式）；afterAgentResponse→ai（纯聊天也有反馈）；stop→success；sessionEnd→off。Cursor 无"等待权限确认"事件，不映射 alarm（等待权限时保持 busy 黄闪，属预期）。

### DeepSeek Harness (dsh) 接入

**原理**：dsh（DeepSeek Harness，`npm i -g @deepseek-ai/dsh`）用**进程内插件**体系，不走 shell 钩子。本工具提供现成插件包 `dsh-esp32-light/`（`dsh plugin --profile <名> add` 安装）。事件名已**对照本机 dsh 0.1.0-rc.7 源码核实**（不是猜的）：顶层监听 `session/created`、`session/disposed`、`agent/status`、`agent/request-error` + 万能总线 `session/event`（`user/message`、`tool/call`、`tool/result`、`assistant/message`、`turn/end`）。只监听 emit 型事件，waterfall 型（需调 next() 的）一律不碰，天然不存在"忘调 next 卡死 Agent"的风险。

**安装**：

1. dsh 已安装并**跑过一次**生成 profile（`~/.dsh/profiles/`，本工具自动挑 `web` 或第一个 profile）
2. 双击 `cc-light-install.cmd` 检测到 dsh 命令时回答 Y；或手动 `node install-hooks.js --dsh`——自动：检查 pnpm（dsh 插件机制依赖，缺了自动 `npm i -g pnpm`）→ `dsh plugin --profile <名> add` → 用 `--dump-config` 验证 `esp32-light` 层已激活
3. **重启 dsh**（`dsh web`）加载插件
4. 多 profile 用户装别的 profile：`dsh plugin --profile <名字> add "<cc-light文件夹>/dsh-esp32-light"`

**映射**：session/created→demo；user/message→thinking；tool/call→busy；tool/result→失败红闪/正常柔和跑马（启发式）；assistant/message→ai；turn/end→success；agent/status(running)→busy；agent/request-error→error；session/disposed→off。同一灯效 30 秒内节流（流式 chunk 频率高，防蓝牙刷包）。

注意：dsh 是预览版（0.1.0-rc.x），升级后事件名若变、灯不亮：重跑一次 `--dsh` 安装即可。插件声明了 `dsh.bundle`（cordis.patch.yml），装完即激活为 profile 层。

### Hermes Agent 接入

**原理**：Hermes Agent 是 Python 插件体系（`~/.hermes/plugins/<名字>/__init__.py`，入口 `register(ctx)` + `ctx.register_hook`）。本工具提供 `hermes-esp32-light/__init__.py`：**10 个全部纯观察钩子**（不实现任何 transform_*，不改写主流程数据，官方保证钩子非阻塞）。

**安装**：

1. Hermes 已安装并启动过一次（`~/.hermes` 已生成）
2. 双击 `cc-light-install.cmd` 检测到 Hermes 时回答 Y；或手动 `node install-hooks.js --hermes`（把 `__init__.py` 复制到 `~/.hermes/plugins/esp32-light/`）
3. 重启 hermes 会话加载
4. 单测（不依赖 Hermes）：`python ~/.hermes/plugins/esp32-light/__init__.py demo` → 板子轮播

**映射（10 个钩子）**：on_session_start/on_session_reset→demo；pre_llm_call→thinking；pre_tool_call→busy；**pre_approval_request→alarm**（审批等待有原生钩子，警灯最准）；post_approval_response→busy；post_tool_call→失败红闪/正常柔和跑马；post_llm_call→success；on_session_end/finalize→off。可选配置文件 `~/.hermes/light-config.json` 可覆盖 UDP 地址。

注意：Hermes 部分钩子官方标注"规划中"——本插件只挂已实现的观察位；若某钩子未触发灯不亮，不影响其他钩子，也不影响 Hermes 本身。

### Gemini CLI 接入

**原理**：Gemini CLI（Google，`npm i -g @google/gemini-cli`）有自己的 hooks 体系（`~/.gemini/settings.json` 的 `hooks` 段）。**事件名与 Claude Code 不同**——自成一套 `Before*`/`After*` 命名（已对照官方 hooks 文档核实）：`SessionStart`、`BeforeAgent`、`BeforeTool`、`AfterTool`、`AfterAgent`、`Notification`、`SessionEnd`。专用转发器 `gemini-qwen-forward.mjs` 按 `hook_event_name` 自动分发。三个 Gemini 特殊点都已处理：

- **timeout 单位是毫秒**（Claude 是秒）——安装器写 5000
- **stdout 零输出**（官方规定 stdout 只能是 JSON，观察型钩子输出为空 + exit 0 = 默认放行）
- `Notification.notification_type` 目前只有 `"ToolPermission"`（权限等待）——matcher 精确匹配 `ToolPermission`，只在权限等待时点亮警灯
- `AfterTool.tool_response` 自带**结构化 `error` 字段**——失败检测不用正则启发式，有 error 字段就红闪

**安装**：

1. Gemini CLI 已安装并启动过一次（`~/.gemini` 已生成）
2. 双击 `cc-light-install.cmd` 检测到 Gemini 时回答 Y；或手动 `node install-hooks.js --gemini`（只动 settings.json 的 hooks 键，主题/模型等其他配置原样保留）
3. 新开 gemini 会话生效；`/hooks` 命令可查看
4. 单测：`echo '{"hook_event_name":"AfterTool","tool_response":{"error":{"m":1}}}' | node gemini-qwen-forward.mjs` → 红闪

**映射（7 个）**：SessionStart→demo；BeforeAgent→thinking；BeforeTool→busy；AfterTool→失败红闪/正常柔和跑马（看 error 字段）；AfterAgent→success；Notification(ToolPermission)→alarm；SessionEnd→off。BeforeModel/AfterModel 每个 chunk 都触发（太热），不挂。

### Qwen Code 接入

**原理**：Qwen Code（阿里，`npm i -g @qwen-code/qwen-code`）是 Gemini CLI 的兄弟分支，但 hooks **事件沿 Claude 命名**（`~/.qwen/settings.json` 的 `hooks` 段，已对照官方 hooks 文档核实），且更贴心：`PostToolUseFailure`（工具失败独立事件）、`StopFailure`（API/网络出错，如限流/鉴权失败）都是现成事件——**失败检测完全不用启发式**；`PermissionRequest` 权限弹窗→警灯；命令钩子支持 `async: true` 后台执行——安装器已开启，灯效**零延迟不阻塞主流程**。

**安装**：

1. Qwen Code 已安装并启动过一次（`~/.qwen` 已生成）
2. 双击 `cc-light-install.cmd` 检测到 Qwen 时回答 Y；或手动 `node install-hooks.js --qwen`（只动 hooks 键，其他配置原样保留）
3. 新开 qwen 会话生效
4. 单测：`echo '{"hook_event_name":"PostToolUseFailure"}' | node gemini-qwen-forward.mjs` → 红闪

**映射（9 个）**：SessionStart→demo；UserPromptSubmit→thinking；PreToolUse→busy；PostToolUse→ai（此事件只在成功时触发）；PostToolUseFailure→error；StopFailure→error（限流/断网也亮红闪）；Stop→success；PermissionRequest→alarm；SessionEnd→off。

### 九家横向对比（每行一家）

| Agent | 接入形式 | 安装命令 | 额外必要步骤 | 权限等待灯 | 失败检测 | 会话结束灭灯 | 卸载 |
|---|---|---|---|---|---|---|---|
| Claude Code | `~/.claude/settings.json` hooks 字段 | `install-hooks.js` | 无（新会话即生效） | Notification→alarm | PostToolUse 启发式 | 有 | `--remove` |
| Codex CLI | `~/.codex/hooks.json` | `--codex` | **`/hooks` 里 Trust 一次** | PermissionRequest→alarm | 同左 | 无（看门狗兜底） | `--codex-remove` |
| WorkBuddy | **本地插件**（目录+双注册） | `--workbuddy` | **完全重启 WorkBuddy** | Notification→alarm | 同左 | 有 | `--workbuddy-remove` |
| CodeBuddy Code | `~/.codebuddy/settings.json` 顶层直接格式 | `--codebuddy` | 重启 codebuddy 会话 | Notification→alarm | 同左 | 有 | `--codebuddy-remove` |
| Cursor (1.7+) | `~/.cursor/hooks.json` 扁平条目 | `--cursor` | 无（**热重载**） | 无（失败走红闪） | **专事件 postToolUseFailure，精准** | 有 | `--cursor-remove` |
| DeepSeek Harness | **进程内插件包** dsh-esp32-light | `--dsh` | 重启 dsh（`dsh web`） | 无该类事件（request-error→红闪） | agent/request-error + tool/result 启发式 | 有（session/disposed） | `--dsh-remove` |
| Hermes | Python 插件 `~/.hermes/plugins/` | `--hermes` | 重启 hermes 会话 | **pre_approval_request→alarm（原生）** | post_tool_call 启发式 | 有（finalize） | `--hermes-remove` |
| Gemini CLI | `~/.gemini/settings.json` hooks 段 | `--gemini` | 无（新会话即生效） | Notification(ToolPermission)→alarm | **结构化 error 字段，精准** | 有 | `--gemini-remove` |
| Qwen Code | `~/.qwen/settings.json` hooks 段 | `--qwen` | 无（新会话即生效；钩子 async 零阻塞） | PermissionRequest→alarm | **专事件 PostToolUseFailure/StopFailure，精准** | 有 | `--qwen-remove` |

### 多个 agent 同时运行，灯信号会冲突吗？

**不会"打架"，但会"共用一盏灯"——后到者覆盖（last-writer-wins）。**

- **为什么不会坏**：每个钩子都是独立的小进程，各发一个完整 UDP 数据报到本机 7878；守护进程逐条收、逐条执行。命令不可能"混成半条"，不存在抢占、堵塞或互相干扰，任何一家的会话都完全不受影响。
- **实际表现（不是"最后打开的独占"）**：灯显示的是**最近一次触发的事件**——与 agent 的打开/启动顺序完全无关（守护进程不知道也不关心包来自哪家）。空闲等待输入的 agent 不发事件、不会霸占灯；只有多家**同时**在干活时，灯才随各家事件交错来回跳（交替提示，属预期而非故障）。claude 在思考时 codex 开始执行命令 → 灯切黄闪，claude 的下一个事件再抢回来。
- **典型叠加场景**：A 完成 Stop→绿灯，此时 B 还在干活 → 灯暂显绿灯，B 的下一个事件立刻盖掉；A 会话结束 SessionEnd→off 可能会把另一家正在工作的灯态灭掉，对方的下一个事件会重新点亮。
- **看门狗**按"最后一次变化"计时，多开时依旧兜底防卡死。
- **结论**：单人多 agent 并发时，灯 = 全场最新动态汇总，不是每家一盏。若想精确区分：① 错开使用；② 只给主力 agent 装钩子；③ 进阶——不同 agent 配不同板子（需改 daemon 按来源分板，目前未做）。

### 两台电脑各装一块板，会互相干扰吗？

蓝牙名都是 "Agent light"，**同一蓝牙范围内有串台风险，分处两地则完全没问题**：

- BLE 是连接制：板子一旦被某台电脑连上就**停止广播**，别人搜不到它。所以不存在"两台电脑同时连上同一块板"。
- 但两块板都在广播、两台电脑都在附近时，daemon 按名字扫描**可能连到对方那块**（A 电脑控制了 B 的灯，自己那块反而没人连）——这就是"串台"。
- 判断：不在同一间屋子/相隔超过 BLE 距离（室内隔几堵墙、室外几十米）→ 各扫各的，互不干扰，放心用。
- 同屋使用想根治：给板子改不同蓝牙名 + daemon 按名过滤（改 `main.py` 广播名与 `daemon.py` 的名字匹配即可）。需要的话可以做「一板一名」配置小工具。

## 开机自启（可选，二选一，Windows）

**方式 A：计划任务**（推荐直接双击 `cc-light-install.cmd`，它就是干这个的；手动方式如下，路径换成你的实际 Python 与解压路径）：

```cmd
schtasks /Create /F /TN "CC-Light-Daemon" /TR "\"C:\Users\你\AppData\Local\Programs\Python\Python312\pythonw.exe\" \"D:\解压路径\cc-light\daemon.py\"" /SC ONLOGON /RL LIMITED
schtasks /Run /TN "CC-Light-Daemon"
```

删除：`schtasks /Delete /TN "CC-Light-Daemon" /F`

**方式 B：启动文件夹** —— `Win+R` 输入 `shell:startup`，把 `start-daemon.cmd` 的快捷方式放进去。

（macOS 的开机自启由 `cc-light-install.command` 自动注册 LaunchAgent，无需手动配置。）

## 刷机/更新固件（Windows，很少需要）

**一键刷机（推荐）**：USB 数据线连板子，双击 `flash-firmware.cmd`——自动装 esptool/mpremote（有 `wheels/` 时离线装）、列出串口、输 COM 号、确认后自动擦除→刷固件→传 main.py→重启。只改 main.py 不动固件时，可单跑上面两条 mpremote 命令。

```bash
# 假设 python 在 PATH 中; COM3 换成实际串口号
python -m mpremote connect COM3 cp main.py :main.py
python -m mpremote connect COM3 exec 'import machine; machine.reset()'
```

- COM 口在设备管理器里看"USB 串行设备"；自动进下载模式失败时（esptool 反复 Connecting）：**按住 BOOT → 点一下 RST → 松开 BOOT**
- 完整重刷 MicroPython：`python -m esptool --chip esp32c3 --port COM3 --baud 921600 write_flash 0x0 ESP32_GENERIC_C3-20260824-v1.29.0.bin`
- macOS 刷机见上方「macOS 刷机」一节（`flash-firmware-mac.command`，串口是 `/dev/cu.usb*`）

## 常见问题

- **蓝牙设置里搜不到「Agent light」**：正常现象，不是故障——设备只支持 BLE 低功耗蓝牙（ESP32-C3 无经典蓝牙），Windows/手机的「蓝牙设置 → 添加设备」列表只显示经典蓝牙设备；且 BLE 设备只在**广播**时可见，守护进程连接成功后广播即暂停（BLE 扫描器也搜不到）。确认连接看 daemon.log 的 `BLE connected`；想亲眼看：停掉守护进程后用 nRF Connect 等 BLE 扫描 App 搜「Agent light」
- **灯全灭且 status.json connected=false**：板子没通电 / 蓝牙被断开；守护进程每几秒自动重连，通电即恢复并续上最后灯态
- **灯态卡死**：看门狗兜底（busy/alarm 30 分钟、thinking/ai 15 分钟、success 10 分钟无变化自动 off）；也可手动 `node send.js off`
- **codex 装了钩子但灯无反应**：九成是没做信任——打开 codex 输入 `/hooks` → Review → Trust，再新开会话；其余看 `~/.codex/hooks.json` 是否写入成功
- **workbuddy 装了插件但灯无反应**：插件是会话启动时加载的——**完全退出 WorkBuddy 再启动**（托盘也要退）；还不行就去插件管理里看 `workbuddy-light` 是否已启用
- **cursor 装了钩子但灯无反应**：确认 Cursor ≥ 1.7；设置 Customize → Hooks 里应能看到 `node ...cursor-forward.mjs` 命令（hooks.json 是热重载的，看不到就重启一次 Cursor）；用户级钩子对 Agent 对话生效
- **dsh 装了插件但灯无反应**：插件是启动时加载的——**重启 dsh**（`dsh web`）；验证是否装上：`dsh --profile <名> --dump-config | grep esp32-light`；dsh 是预览版，升级后事件名变了就重跑一次 `node install-hooks.js --dsh`
- **hermes 装了插件但灯无反应**：重启 hermes 会话；确认 `~/.hermes/plugins/esp32-light/__init__.py` 存在；单测 `python ~/.hermes/plugins/esp32-light/__init__.py demo`
- **gemini/qwen 装了钩子但灯无反应**：新开会话才会加载；CLI 内 `/hooks` 查看是否列出 agent-light；确认 `~/.gemini/settings.json` / `~/.qwen/settings.json` 的 hooks 段写入了 `gemini-qwen-forward.mjs`；转发器单测 `echo '{"hook_event_name":"Stop"}' | node gemini-qwen-forward.mjs`
- **多家 agent 同时开着，灯来回跳**：正常——灯显示最后触发的事件（后到者覆盖），详见上文「多个 agent 同时运行」一节
- **想看极性检测读数**：`tail daemon.log` 找 `board: Agent light 1.1 HIGH r… y… g…`（LOW=共阳/3.3V 接法，HIGH=共阴/GND 接法）
- **极性不对（该亮不亮/该灭不灭）**：`node send.js xxx` 之外可发 `PING`；极性翻转用蓝牙命令 FORCELOW/FORCEHIGH（需修改 daemon 或临时用 mpremote）
- **卸载**：`node install-hooks.js --remove`（或对应家的 `--xxx-remove`）+ 删计划任务/启动项 + 停守护进程

## 架构

```
claude CLI  ──hooks(~/.claude/settings.json)──┐
codex CLI   ──hooks(~/.codex/hooks.json)──────┤
workbuddy   ──插件(~/.workbuddy/plugins/)──────┤
codebuddy   ──hooks(~/.codebuddy/ 顶层)───────┼──> 转发器(send.js / workbuddy-forward.mjs /
cursor IDE ──hooks(~/.cursor/hooks.json)──────┤     cursor-forward.mjs / gemini-qwen-forward.mjs /
dsh        ──插件(dsh-esp32-light 进程内)─────┤     dsh 插件直发 / hermes 插件直发)
hermes     ──插件(~/.hermes/plugins/)─────────┤        │
gemini CLI ──hooks(~/.gemini/settings.json)───┤        UDP 127.0.0.1:7878 (MODE:灯效词)
qwen CLI   ──hooks(~/.qwen/settings.json)─────┘        ▼
                                                   daemon.py ──bleak (BLE GATT, Nordic UART Service)──> ESP32-C3 main.py
                                                                 （灯效线程 + BLE 透传, REPL 留作调试; 任何 agent 的命令后到者覆盖）
```
