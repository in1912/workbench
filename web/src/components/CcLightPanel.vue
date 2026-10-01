<template>
  <div class="ccp-root">
    <!-- 子 tab：功能介绍 / 下载安装包 / 安装步骤（localStorage.cc_sub 记忆，同 XiaozhiPanel 模式） -->
    <div class="ccp-tabs">
      <button :class="{ on: sub === 'intro' }" @click="switchSub('intro')">🚦 功能介绍</button>
      <button :class="{ on: sub === 'download' }" @click="switchSub('download')">⬇ 下载安装包</button>
      <button :class="{ on: sub === 'install' }" @click="switchSub('install')">🛠 安装步骤</button>
    </div>

    <div v-if="err" class="msg err">{{ err }}</div>

    <!-- ==================== ① 功能介绍（含灯效演示图） ==================== -->
    <template v-if="sub === 'intro'">
      <div class="card">
        <div class="cc-intro-row">
          <div style="flex:1; min-width:0">
            <h3 style="margin:0 0 8px">Agent红绿灯 — AI Agent 状态指示灯（九家：Claude Code / Codex CLI / WorkBuddy / CodeBuddy / Cursor / DeepSeek Harness / Hermes / Gemini CLI / Qwen Code）</h3>
            <div class="muted" style="font-size:13px; line-height:1.8; margin-bottom:0">
              ESP32-C3 SuperMini 开发板 + 三色红绿灯模块。AI 干什么，灯就显示什么——<b>一块板子同时兼容九家 agent</b>，<b>Windows / macOS 都能装</b>（安装包在「下载安装包」页签）：
              <b>全程蓝牙（BLE）通讯</b>，USB 只在刷固件时用一次，之后板子插任意 USB 电源即可，电脑端守护进程自动扫描连接（蓝牙名 <b>Agent light</b>）。<br />
              链路：各家钩子/插件 → 转发器（send.js / workbuddy-forward.mjs / cursor-forward.mjs / gemini-qwen-forward.mjs / dsh·hermes 插件直发）→ UDP（本机 7878）→ daemon.py → 蓝牙 → 板子。板子断电重启会自动重连并续上最后灯态。
            </div>
          </div>
          <img class="cc-demo" :src="ccDemoImg" alt="成品示例：ESP32-C3 红绿灯" title="成品示例" />
        </div>
        <div class="cc-note">
          <b>为什么蓝牙设置里搜不到「Agent light」？</b>（正常现象，不是故障）<br />
          本设备只支持 <b>BLE 低功耗蓝牙</b>（ESP32-C3 没有经典蓝牙）——Windows / 手机的「蓝牙设置 → 添加设备」列表只显示经典蓝牙设备，BLE 设备不会出现在里面；
          而且 BLE 设备只在<b>广播</b>时可见，守护进程连接成功后广播即暂停，此时连 BLE 扫描器（手机 nRF Connect 等 App）也搜不到它。<br />
          确认连接请看 daemon.log（出现 <code>BLE connected</code> / <code>board: Agent light …</code>）；想亲眼看设备广播：先停掉守护进程，再用 BLE 扫描 App 搜「Agent light」。
        </div>
        <h3 style="margin:14px 0 8px">灯效演示对照表</h3>
        <table class="cc-table">
          <thead><tr><th style="width:150px">灯效</th><th>含义 / 触发时机</th></tr></thead>
          <tbody>
            <tr><td>🎬 轮播演示</td><td>会话开启：自检闪红→黄→绿各一次，然后轮播 7 种灯效</td></tr>
            <tr><td>🔵➡️ 连贯跑马灯</td><td>提交提示词后：AI 正在分析（thinking）</td></tr>
            <tr><td>🌊 柔和慢速跑马灯</td><td>工具执行完回到生成：AI 正在输出（ai）</td></tr>
            <tr><td>🟡 黄灯慢闪</td><td>正在执行工具 / 命令（busy）</td></tr>
            <tr><td>🟢 绿灯常亮</td><td>任务完成（success）</td></tr>
            <tr><td>🔴 红灯快闪</td><td>命令 / 工具执行失败（error；Cursor / Qwen 有专门的失败事件，Gemini 看结构化 error 字段，触发最准）</td></tr>
            <tr><td>🚨 红黄交替警灯</td><td>等待权限确认——Claude / WorkBuddy / CodeBuddy（Notification）、Codex / Qwen（PermissionRequest）、Gemini（Notification·ToolPermission）、Hermes（pre_approval_request）</td></tr>
            <tr><td>🚦 红绿灯循环</td><td>手动演示模式（traffic）：红3秒→绿3秒→黄1秒</td></tr>
            <tr><td>⚪ 三色全亮</td><td>手动模式（all）：红黄绿同时亮（混白光），<code>node send.js all</code>，1 分钟后 <code>node send.js demo</code> 恢复</td></tr>
            <tr><td>⚫ 全灭</td><td>会话结束（Claude / WorkBuddy / Cursor），或看门狗超时自动熄灭（busy 卡 30 分钟等）</td></tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <h3>多 agent 兼容说明（兼容方式与九家安装区别）</h3>
        <div class="cc-note" style="margin-bottom:12px">
          <b>兼容方式（总原理）</b>：电脑端守护进程 daemon.py 只认「发到本机 UDP 7878 的一句 <code>MODE:灯效</code> 命令」，
          根本不关心命令是谁发的。所以任何带「生命周期钩子 / 插件体系」的 AI agent 都能接入——给对应家配一份适配，事件发生时往 7878 发一个词即可。
          <b>同一个守护进程、同一块板子，九家共用，固件零改动</b>；装几家、开几家完全自由，互不影响。
        </div>
        <div style="overflow-x:auto">
          <table class="cc-table" style="min-width:980px">
            <thead><tr><th style="width:130px">Agent</th><th>接入形式</th><th>安装命令</th><th style="width:170px">装完即用？</th><th style="width:150px">权限等待</th><th>卸载</th></tr></thead>
            <tbody>
              <tr><td><b>Claude Code</b></td><td>写入 <code>~/.claude/settings.json</code> 钩子字段</td><td><code>node install-hooks.js</code></td><td>✅ 新开会话即联动</td><td>Notification → 🚨</td><td><code>--remove</code></td></tr>
              <tr><td><b>Codex CLI</b></td><td>独立文件 <code>~/.codex/hooks.json</code></td><td>同左 + <code>--codex</code></td><td>⚠️ 需信任：codex 里 <code>/hooks</code> → Review → <b>Trust</b>（不做这步灯无反应，头号原因）</td><td>PermissionRequest → 🚨</td><td><code>--codex-remove</code></td></tr>
              <tr><td><b>WorkBuddy</b></td><td>装成<b>本地插件</b>（目录 + 双注册）</td><td>同左 + <code>--workbuddy</code></td><td>⚠️ 需<b>完全退出并重启</b>（托盘也要退）</td><td>Notification → 🚨</td><td><code>--workbuddy-remove</code></td></tr>
              <tr><td><b>CodeBuddy Code</b></td><td><code>~/.codebuddy/settings.json</code> <b>顶层直接格式</b></td><td>同左 + <code>--codebuddy</code></td><td>⚠️ 重启 codebuddy 会话（<code>/hooks</code> 可查看）</td><td>Notification → 🚨</td><td><code>--codebuddy-remove</code></td></tr>
              <tr><td><b>Cursor</b>（1.7+）</td><td><code>~/.cursor/hooks.json</code> 扁平格式</td><td>同左 + <code>--cursor</code></td><td>✅ <b>热重载</b>，无需重启</td><td>无此类事件（拒绝/中断走红闪）</td><td><code>--cursor-remove</code></td></tr>
              <tr><td><b>DeepSeek Harness</b>（dsh）</td><td><b>进程内插件包</b> dsh-esp32-light（profile 层）</td><td>同左 + <code>--dsh</code></td><td>⚠️ 重启 dsh（<code>dsh web</code>）；依赖 pnpm（缺了自动装）</td><td>无此类事件（请求失败走红闪）</td><td><code>--dsh-remove</code></td></tr>
              <tr><td><b>Hermes</b></td><td>Python 插件 <code>~/.hermes/plugins/esp32-light/</code></td><td>同左 + <code>--hermes</code></td><td>⚠️ 重启 hermes 会话</td><td>pre_approval_request → 🚨（原生钩子，最准）</td><td><code>--hermes-remove</code></td></tr>
              <tr><td><b>Gemini CLI</b></td><td><code>~/.gemini/settings.json</code> hooks 段</td><td>同左 + <code>--gemini</code></td><td>✅ 新开会话即联动</td><td>Notification(ToolPermission) → 🚨</td><td><code>--gemini-remove</code></td></tr>
              <tr><td><b>Qwen Code</b></td><td><code>~/.qwen/settings.json</code> hooks 段</td><td>同左 + <code>--qwen</code></td><td>✅ 新会话即联动（钩子 <b>async 后台执行</b>，零阻塞）</td><td>PermissionRequest → 🚨</td><td><code>--qwen-remove</code></td></tr>
              <tr><td colspan="6" style="color:var(--muted)"><b>钩子原理差异（都被转发器抹平，用户无感）</b>：各家事件 JSON 从 stdin 传给钩子命令（dsh/Hermes 是进程内插件直发），由本工具的转发器统一映射成灯效词发 UDP。差异——事件名大小写（Cursor 驼峰）、Gemini 自成一套 Before*/After* 命名（非 Claude 式）、Qwen 沿 Claude 命名但有独立失败事件（PostToolUseFailure/StopFailure，失败检测不用启发式）、Gemini 的 AfterTool 自带结构化 error 字段、Cursor 权限钩子须回放行 JSON、WorkBuddy/CodeBuddy 事件同源——全部在转发器内部处理；所有钩子永远 exit 0、失败静默，绝不阻塞 AI 会话。</td></tr>
            </tbody>
          </table>
        </div>
        <div class="cc-note" style="margin-top:12px; border-color:rgba(227,138,10,.55); background:rgba(227,138,10,.08)">
          <b>⚠️ 重点：Codex CLI 装完钩子必须「信任」一次，否则灯永远不亮（装了没反应的头号原因）</b><br />
          这一步<b>不是 Windows 命令、也没有图形开关</b>，是在 <b>codex 程序自己的对话界面里</b>用键盘完成的：
          ① 终端运行 <code>codex</code>（不带参数，进入它的对话界面）→ ② 在输入框输入 <code>/hooks</code> 回车，弹出钩子管理面板 →
          ③ 用<b>方向键</b>选中本工具的钩子条目（命令是 <code>node …\send.js …</code> 那几条，未信任的会标注 untrusted / 待审核）→
          ④ 回车 → 选 <b>Trust / 信任</b>（有的版本叫 Review → Trust）确认 → ⑤ 退出后<b>新开</b>一个 codex 会话，灯即联动。<br />
          输 <code>/hooks</code> 没反应 = codex 版本太老（钩子功能 2026 年 9 月才有），先升级：<code>npm i -g @openai/codex</code>。
          信任<b>只需做一次</b>，之后重装/升级钩子、换文件夹都不用再做（换电脑需重做）。
        </div>
        <div class="cc-note" style="margin-top:12px">
          <b>多个 agent 同时开着，灯的信号会冲突吗？</b>——<b>不会冲突，但会「共用一盏灯」：后到者覆盖。</b><br />
          每个钩子都是独立小进程，各发一条完整 UDP 命令，守护进程逐条执行——命令不会「混线」，不存在抢占或互相干扰，
          <b>任何一家的会话都完全不受影响</b>。灯永远显示<b>最近一次触发的事件</b>：claude 在思考、codex 开始跑命令 → 灯切到黄闪，
          claude 的下一个事件再抢回来；一家会话结束灭灯可能盖掉另一家的状态，对方的下一个事件会重新点亮。看门狗按最后一次变化计时，依旧兜底。
          一句话：<b>多开时灯 = 全场最新动态汇总</b>，不是每家一盏；介意串扰就错开用，或只给主力 agent 装钩子。
        </div>
        <div class="cc-note">
          <b>两台电脑各装一块板（蓝牙名都叫 Agent light）会互相干扰吗？</b>——<b>不在同一蓝牙范围内：完全没问题；同处一室：有「串台」风险。</b><br />
          BLE 是连接制：板子被某台电脑连上后就<b>停止广播</b>，别人搜不到，所以不会两台电脑连同一块板。但两块板都在广播、电脑又都在附近时，
          守护进程按名字扫描<b>可能连到对方那块</b>（A 控制了 B 的灯）。分处两间屋 / 不同楼层（隔几堵墙）就各扫各的，互不干扰；
          同屋想根治：给板子改不同蓝牙名 + 守护进程按名过滤（改 main.py 广播名与 daemon.py 匹配名即可，需要可让 AI 帮你做「一板一名」小工具）。
        </div>
      </div>
    </template>

    <!-- ==================== ② 下载安装包（含子文件清单） ==================== -->
    <template v-else-if="sub === 'download'">
      <div class="card">
        <h3 style="margin:0 0 10px">⬇ 下载安装包（按你的电脑系统选）</h3>
        <div class="cc-dl-group">🖥️ Windows 环境</div>
        <div class="row" style="gap:8px; flex-wrap:wrap">
          <button class="primary" @click="ccDlPack">📦 打包下载（Windows，cc-light.zip 约 10MB，推荐——含安装/卸载/刷机脚本 + 九家 agent 适配器 + 刷机工具离线安装包 wheels）</button>
          <button class="primary" @click="ccDl('cc-light-install.cmd')">⬇ 下载安装批处理</button>
          <button class="primary" @click="ccDl('cc-light-install-all.cmd')">⬇ 下载一键全装钩子脚本</button>
          <button class="primary" @click="ccDl('cc-light-uninstall.cmd')">⬇ 下载卸载脚本</button>
        </div>
        <div class="cc-dl-group" style="margin-top:10px">🍎 macOS 环境</div>
        <div class="row" style="gap:8px; flex-wrap:wrap">
          <button class="primary" @click="ccDlPackMac">📦 打包下载（macOS，cc-light-mac.zip 约 2MB——.command 安装/卸载/刷机三件套 + 同一套九家 agent 适配器）</button>
        </div>
        <div class="muted" style="font-size:12.5px; line-height:1.8; margin-top:8px">
          两个包里的程序与九家 agent 适配器<b>完全一致</b>，只差系统脚本：Windows 用 .cmd（双击）+ 离线 wheels；macOS 用 .command（双击，失效就在终端 <code>bash cc-light-install.command</code>）+ LaunchAgent 自启 + 首次弹「想要使用蓝牙」<b>点一次允许</b>；Mac 也能给板子刷机（包里 flash-firmware-mac.command，串口是 /dev/cu.usb*）。<br />
          安装 / 卸载脚本必须与 daemon.py 等文件放<b>同一文件夹</b>（打包下载解压后即满足，直接双击 cc-light-install.cmd）。
        </div>
      </div>

      <div class="card">
        <h3>子文件清单（单文件下载；建议直接用上方打包下载，解压即满足「同文件夹」要求）</h3>
        <div v-if="!ccFiles.length" class="muted" style="padding:8px 0">加载中…</div>
        <div v-for="f in ccFiles" :key="f.name" class="cc-file">
          <div class="grow" style="min-width:0">
            <div class="t"><b>{{ f.name }}</b> <span class="muted" style="font-size:12px">{{ fmtCcSize(f.size) }}</span></div>
            <div class="d muted">{{ f.desc }}</div>
          </div>
          <button class="small" style="flex-shrink:0" :disabled="f.missing" @click="ccDl(f.name)">下载</button>
        </div>
        <div class="muted" style="font-size:12.5px; margin-top:8px">
          单独下载文件时，把所有文件放<b>同一个文件夹</b>再运行安装脚本。完整说明文档 <b>README.md</b> 也在清单里（可单独下载查看全部细节）。
        </div>
      </div>
    </template>

    <!-- ==================== ③ 安装步骤：① 刷版 → ② 电脑钩子 → ③ 蓝牙配对（+ 参考文档） ==================== -->
    <template v-else-if="sub === 'install'">
      <div class="card">
        <h3>安装顺序总览</h3>
        <div class="cc-note" style="margin:0">
          <b>① 刷版</b>（板子烧固件，只需一次，需 USB 数据线）→ <b>② 装电脑中的钩子</b>（让九家 AI CLI 的状态发给灯）→
          <b>③ 板子的蓝牙配对</b>（电脑端守护进程自动连接，装好就再也不用管）。三步全做完 = 日常只要「板子插电 + 电脑开机」，灯自动跟随 AI 状态。
        </div>
      </div>

      <div class="card">
        <h3>① 怎么刷版（首次使用 / 更换板子，需 USB 数据线）</h3>
        <ol class="cc-steps">
          <li>USB <b>数据线</b>连电脑（充电线不行）→ 设备管理器出现「USB 串行设备 (COMx)」，记住这个 COM 号</li>
          <li>双击 <code>flash-firmware.cmd</code> 一键刷机：自动装 esptool / mpremote（<b>打包下载已附带离线安装包 wheels，没网也能装</b>）→ 输入 COM 号 → 确认后自动 擦除 → 刷 MicroPython 固件 → 上传 main.py → 重启板子</li>
          <li>成功标志：自检红→黄→绿各闪一次 → 自动进入轮播演示；之后拔掉数据线换任意 USB 电源即可</li>
        </ol>
        <div class="muted" style="font-size:12.5px; line-height:1.8">
          手动方式：<code>pip install esptool mpremote</code> 后执行 <code>python -m esptool --chip esp32c3 --port COMx erase_flash</code>、
          <code>python -m esptool --chip esp32c3 --port COMx --baud 921600 write_flash 0x0 ESP32_GENERIC_C3-20260824-v1.29.0.bin</code>、
          <code>python -m mpremote connect COMx cp main.py :main.py</code>，再按一下 RST。<br />
          按键时机：esptool 反复打印 <code>Connecting...</code> 时 = <b>按住 BOOT → 点一下 RST → 松开 BOOT</b> 进下载模式；刷完没反应 = 按一下 RST。<br />
          <b>macOS 也能刷</b>：Mac 包里的 <code>flash-firmware-mac.command</code> 流程完全一致（自动联网装 esptool/mpremote → 列出 /dev/cu.usb* 串口让你选 → 擦除 → 刷固件 → 传 main.py → 重启）；搜不到串口九成是用了纯充电线，换<b>数据线</b>。<br />
          接线（已焊好的可跳过）：红=GPIO4、黄=GPIO3、绿=GPIO2、模块公共端→GND（接 3.3V 也可以，固件上电自动识别共阴/共阳）。
        </div>
      </div>

      <div class="card">
        <h3>② 怎么装电脑中的钩子（让 AI 的状态发给灯）</h3>
        <ol class="cc-steps">
          <li>双击 <code>cc-light-install-all.cmd</code> 一键全装（= <code>node install-hooks.js --all</code>）：<b>自动检测装了哪些 CLI，检测到哪家就装哪家、缺的跳过、无需逐个回答 Y/N</b>，结束打印各家生效提醒；已装过旧版本钩子的机器直接跑它即可补齐（幂等）</li>
          <li>想逐家选择：双击 <code>cc-light-install.cmd</code>（检测到哪家就逐家问 Y/N），或单家安装 <code>node install-hooks.js --codex / --workbuddy / --codebuddy / --cursor / --dsh / --hermes / --gemini / --qwen</code>（卸载对应加 <code>-remove</code>）</li>
          <li>按各家「生效条件」做最后一下（详见「功能介绍」页签的九家对照表）：Claude/Gemini/Qwen <b>新开会话</b>即生效；<b>Codex 必须在 codex 界面里 <code>/hooks</code> 信任一次</b>（头号没反应原因）；<b>WorkBuddy 完全退出再启动</b>（托盘也要退）；CodeBuddy/DeepSeek Harness/Hermes 重启对应会话；Cursor 热重载无需重启</li>
          <li>单测某一家（不依赖对应 CLI，灯应立即变色）：<code>node send.js all</code> ｜ <code>echo '{"hook_event_name":"Stop"}' | node workbuddy-forward.mjs</code>（WorkBuddy/CodeBuddy 共用）｜ <code>echo '{"hook_event_name":"stop"}' | node cursor-forward.mjs</code> ｜ <code>echo '{"hook_event_name":"Stop"}' | node gemini-qwen-forward.mjs</code>（Gemini/Qwen 共用）</li>
        </ol>
        <div class="muted" style="font-size:12.5px; margin-top:6px">
          电脑要求：<b>Node.js 不用单独装</b>——用 Claude Code CLI 就已自带（它本身跑在 Node 上）；钩子只影响灯色，<b>绝不阻塞 AI 会话</b>（全部 exit 0、失败静默）。<br />
          不需要了双击 <code>cc-light-uninstall.cmd</code> 一键卸载（九家钩子全清，板上固件保留，以后想用再装）。
        </div>
      </div>

      <div class="card">
        <h3>③ 怎么做板子的蓝牙配对（守护进程自动连接，无需系统配对）</h3>
        <div class="cc-note" style="margin-top:0">
          <b>核心认知：这块板子不需要、也不能在 Windows/macOS 的「蓝牙设置 → 添加设备」里配对。</b>
          它是 BLE 低功耗蓝牙设备，系统蓝牙列表根本不显示它（见「功能介绍」页签的说明）；配对这件事由电脑端守护进程 <b>daemon.py</b> 完成——
          它按蓝牙名 <b>「Agent light」</b> 自动扫描、自动连接、断线自动重连，<b>全程无需任何手动配对操作</b>。
        </div>
        <ol class="cc-steps">
          <li>电脑要求：带蓝牙适配器（支持 BLE）；已装 <b>Python 3.9+（64 位，推荐 3.12）</b></li>
          <li>板子通电：任意 USB 充电头 / 充电宝，不需要连电脑（刷版完成后就可以拔线了）</li>
          <li>双击 <code>cc-light-install.cmd</code> 一键安装（它就是干这个的）：自动找 Python → 缺 bleak 蓝牙库自动装（有 wheels 时离线装）→
            注册开机自启（计划任务 <code>CC-Light-Daemon</code>）→ <b>立即启动守护进程并自动扫描连接板子</b> → 有 Node 时顺带逐家询问装钩子 → 最后自动验证<br />
            （macOS 对应双击 <code>cc-light-install.command</code>，自启是 LaunchAgent；首次会弹「python3 想要使用蓝牙」→ <b>点一次允许</b>）</li>
          <li>不想注册自启、只手动启动：双击 <code>start-daemon.cmd</code>（或终端 <code>python daemon.py</code>）</li>
          <li>成功标志：安装窗口显示 <code>[OK] Connected to board "Agent light"</code>（daemon.log 里有 <code>BLE connected</code> 与 <code>board: Agent light 1.1 ...</code>）；
            板子断电重启会自动重连并续上最后灯态，电脑重启后自启任务也会自动连</li>
        </ol>
        <div class="muted" style="font-size:12.5px; line-height:1.8">
          排障：灯全灭且 status.json connected=false = 板子没通电 / 蓝牙断开，通电即自动恢复；灯态卡死 = 看门狗兜底自动熄灭，也可手动 <code>node send.js off</code>；
          想亲眼看设备广播：先停掉守护进程，用手机 nRF Connect 等 BLE 扫描 App 搜「Agent light」。开机自启手动管理：<code>schtasks /Run /TN "CC-Light-Daemon"</code>（删除 <code>/Delete /F</code>），
          或 Win+R 输 <code>shell:startup</code> 把 start-daemon.cmd 的快捷方式放启动文件夹。
        </div>
      </div>

      <div class="card">
        <h3>参考文档（全部）</h3>
        <ul class="cc-refs">
          <li><b>本工具完整说明书</b>：<code>README.md</code>——在「下载安装包」页签的子文件清单里可单独下载（灯效 / 接线 / 九家接入细节 / 常见问题 / 架构图全在里面）</li>
          <li><a class="link" href="https://www.nologo.tech/product/esp32/esp32c3/esp32c3supermini/esp32C3SuperMini.html" target="_blank" rel="noopener">ESP32-C3 SuperMini 产品页（开发板介绍 / 引脚图）</a></li>
          <li><a class="link" href="https://micropython.org/download/ESP32_GENERIC_C3/" target="_blank" rel="noopener">MicroPython 固件下载页（ESP32_GENERIC_C3）</a></li>
          <li><a class="link" href="https://pypi.org/project/bleak/" target="_blank" rel="noopener">bleak — Python 蓝牙（BLE）客户端库（Windows / macOS 都支持）</a></li>
          <li><a class="link" href="https://cursor.com/docs/hooks" target="_blank" rel="noopener">Cursor hooks 官方文档（事件列表 / 配置格式 / 热重载）</a></li>
          <li><a class="link" href="https://developers.openai.com/codex/cli" target="_blank" rel="noopener">OpenAI Codex CLI 官方文档</a></li>
          <li><a class="link" href="https://github.com/google-gemini/gemini-cli/blob/main/docs/hooks/reference.md" target="_blank" rel="noopener">Gemini CLI hooks 官方规范（Before*/After* 事件 / Notification·ToolPermission）</a></li>
          <li><a class="link" href="https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/hooks.md" target="_blank" rel="noopener">Qwen Code hooks 官方文档（PostToolUseFailure / PermissionRequest / async 钩子）</a></li>
          <li>本机随板资料（引脚图 / 原理图 / 使用手册 / 疑难解答）：<code>D:\CC\ESP32\资料</code></li>
        </ul>
      </div>
    </template>
  </div>
</template>

<script setup>
// Agent红绿灯面板（v1.9.23）：智能家居页 cclight 子 tab 的内容组件。
// 内容沿用 v1.9.22 独立页的三段结构（功能介绍/下载安装包/安装步骤），子 tab 用 localStorage 记忆
// （不占页级 ?tab= 查询参数，那是外层智能家居页的）；/cclight/* API 权限挂 smarthome.cclight 单 tab。
import { ref } from 'vue';
import { api } from '../api';
import ccDemoImg from '../assets/cclight-demo.png';

const SUBS = ['intro', 'download', 'install'];
const sub = ref(SUBS.includes(localStorage.getItem('cc_sub')) ? localStorage.getItem('cc_sub') : 'intro');
function switchSub(s) {
  sub.value = s;
  localStorage.setItem('cc_sub', s);
  if (s === 'download') loadCcFiles();
}

// ---------- 下载区文件清单 ----------
const ccFiles = ref([]);
async function loadCcFiles() {
  if (ccFiles.value.length) return;
  try { ccFiles.value = (await api.get('/cclight/files')).files || []; }
  catch { ccFiles.value = []; }
}
const fmtCcSize = (n) => (!n ? '' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
// 下载失败不静默（v1.9.8 起的规矩）：错误显示在面板顶部，网关代答/断网点了没反应可定位
const err = ref('');
function flashErr(m) { err.value = m; setTimeout(() => (err.value = ''), 8000); }
function ccDl(name) { api.download(`/cclight/file/${encodeURIComponent(name)}`, name).catch((e) => flashErr(`下载失败：${e.message}`)); }
function ccDlPack() { api.download('/cclight/package', 'cc-light.zip').catch((e) => flashErr(`打包下载失败：${e.message}`)); }
function ccDlPackMac() { api.download('/cclight/package-mac', 'cc-light-mac.zip').catch((e) => flashErr(`打包下载失败：${e.message}`)); }
if (sub.value === 'download') loadCcFiles();
</script>

<style scoped>
/* 子 tab 样式与 XiaozhiPanel（.xz-tabs）同款胶囊风格 */
.ccp-tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.ccp-tabs button { border: 1px solid var(--border, #e5e7eb); background: rgba(0,0,0,.03); color: inherit; border-radius: 18px; padding: 5px 16px; font-size: 13px; cursor: pointer; }
.ccp-tabs button.on { background: var(--accent, #2563eb); border-color: var(--accent, #2563eb); color: #fff; }
/* 灯效表 / 步骤 / 下载清单（自 SmartHome.vue cclight 段沿承） */
.cc-intro-row { display: flex; align-items: center; gap: 16px; margin-bottom: 10px; }
.cc-demo { flex-shrink: 0; width: 150px; max-width: 40%; border-radius: 10px; border: 1px solid var(--border); box-shadow: 0 2px 10px rgba(0,0,0,.12); }
@media (max-width: 640px) { .cc-demo { width: 104px; } .cc-intro-row { gap: 10px; } }
.cc-note { border: 1px solid rgba(79, 124, 247, .4); background: rgba(79, 124, 247, .08); border-radius: 8px; padding: 10px 12px; font-size: 13px; line-height: 1.8; margin: 0 0 12px; }
.cc-dl-group { font-size: 13.5px; margin: 2px 0 6px; color: var(--text); border-left: 3px solid rgba(79, 124, 247, .6); padding-left: 8px; }
.cc-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.cc-table th, .cc-table td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; line-height: 1.6; }
.cc-table th { background: var(--bg2); white-space: nowrap; }
.cc-steps { margin: 0; padding-left: 20px; line-height: 2; font-size: 13.5px; }
.cc-steps code, .cc-refs code { background: var(--bg2); border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px; font-size: 12.5px; word-break: break-all; }
.cc-note code { background: var(--bg2); border: 1px solid var(--border); border-radius: 4px; padding: 1px 6px; font-size: 12.5px; word-break: break-all; }
.cc-file { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px dashed var(--border); }
.cc-file .t { font-size: 13.5px; }
.cc-file .d { font-size: 12.5px; margin-top: 2px; }
.cc-refs { margin: 0; padding-left: 20px; line-height: 2.1; font-size: 13.5px; }
</style>
