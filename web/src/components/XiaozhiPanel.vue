<template>
  <div class="xz-root">
    <!-- 子 tab（v1.9.17）：装机向导 / 语音控米家 / 摄像头；v1.9.18 加视频对话 -->
    <div class="xz-tabs">
      <!-- v1.9.33：语音助手改名为「贾维斯J.A.R.V.I.S.」并挪到第一个（用户要求——板子的主用途是问贾维斯） -->
      <button :class="{ on: sub === 'assistant' }" @click="switchSub('assistant')">贾维斯J.A.R.V.I.S.</button>
      <!-- v1.9.35：转交流水从贾维斯页里单拎出来（用户要求——它是排障用的，和配置不该挤在一屏） -->
      <button :class="{ on: sub === 'agentlog' }" @click="switchSub('agentlog')">📜 Agent对话记录</button>
      <button :class="{ on: sub === 'guide' }" @click="switchSub('guide')">🛠 装机向导</button>
      <button :class="{ on: sub === 'voice' }" @click="switchSub('voice')">🏠 语音控米家</button>
      <button :class="{ on: sub === 'live' }" @click="switchSub('live')">🎥 视频对话</button>
      <button :class="{ on: sub === 'history' }" @click="switchSub('history')">💬 对话记录</button>
      <button :class="{ on: sub === 'camera' }" @click="switchSub('camera')">📷 摄像头</button>
    </div>

    <!-- ============ 装机向导 ============ -->
    <template v-if="sub === 'guide'">
    <div class="card">
      <h3 style="margin:0 0 4px">🛠 装机向导（ESP32-S3-Korvo-2-V3 · 小智 AI 语音板）</h3>
      <p class="xz-muted" style="margin:0 0 14px">
        从零到能对话共 5 步；唤醒词编译烧录在下一张卡，语音控米家配置在最后一张卡。
      </p>

      <div class="xz-step">
        <div class="xz-step-no">①</div>
        <div class="xz-step-body">
          <b>装 USB 串口驱动</b>
          <p class="xz-muted">板子用 CH343 芯片桥接 USB 串口。Win10/11 大多免驱；设备管理器看不到「USB-Enhanced-SERIAL CH343 (COMx)」时再装：</p>
          <div class="xz-dl-row">
            <button class="btn primary" @click="dlTool('ch343-driver')">⬇ CH343 驱动包（zip，含安装说明）</button>
            <button class="btn" @click="dlTool('serial_read.py')">⬇ serial_read.py（串口日志脚本）</button>
          </div>
        </div>
      </div>

      <div class="xz-step">
        <div class="xz-step-no">②</div>
        <div class="xz-step-body">
          <b>烧录固件</b>
          <p class="xz-muted">
            管理员在下方「唤醒词与固件」卡里一键<b>编译并烧录</b>（自动校验芯片防烧错板）；或下载已编译的合并镜像，
            用 esptool 烧到 <code>0x0</code>：<code>esptool --chip esp32s3 -p COM4 -b 921600 write-flash 0x0 merged-binary.bin</code>
            <template v-if="cap.firmware.available">（当前产物：{{ fmtSize(cap.firmware.size) }} · {{ fmtTime(cap.firmware.mtime) }}）</template>
          </p>
          <div class="xz-dl-row">
            <button class="btn" :disabled="!cap.firmware.available" @click="dlFirmware">⬇ 下载固件 merged-binary.bin</button>
            <span v-if="isAdmin" class="xz-muted">或直接用下方「唤醒词与固件」卡一键编译烧录 →</span>
          </div>
        </div>
      </div>

      <div class="xz-step">
        <div class="xz-step-no">③</div>
        <div class="xz-step-body">
          <b>配网（板子连家里 WiFi）</b>
          <p class="xz-muted">
            板子上电/烧录后自动进配网模式，屏幕显示热点名（形如 <code>Xiaozhi-XXXX</code>，开放无密码）。
            用<b>手机或电脑连上这个热点</b>，点下面的按钮（或浏览器打开 <code>http://192.168.4.1</code>），选家里 WiFi 输密码提交。
            配网信息存在板子里，重启不用重配：
          </p>
          <div class="xz-dl-row">
            <a class="btn primary" href="http://192.168.4.1" target="_blank" rel="noopener">🆕 打开配网页 192.168.4.1（新窗口）</a>
            <span class="xz-muted">先连上 Xiaozhi-XXXX 热点再打开；没连热点时页面打不开是正常的。</span>
          </div>
        </div>
      </div>

      <div class="xz-step">
        <div class="xz-step-no">④</div>
        <div class="xz-step-body">
          <b>绑定小智控制台（xiaozhi.me）</b>
          <p class="xz-muted">
            配网成功后板子会显示 <b>6 位激活码</b>并播报。到控制台注册/登录（免费）→ 添加设备 → 输入激活码完成绑定，
            之后对话走虾哥云端 AI。绑定信息存在板子里，重启不用重输：
          </p>
          <div class="xz-dl-row" style="margin-top:6px">
            <a class="btn" href="https://xiaozhi.me" target="_blank" rel="noopener">🆕 打开 xiaozhi.me 控制台（新窗口）</a>
          </div>
        </div>
      </div>

      <div class="xz-step">
        <div class="xz-step-no">⑤</div>
        <div class="xz-step-body">
          <b>测试唤醒</b>
          <p class="xz-muted">
            对着板子喊「<b class="xz-wake">{{ cfg.wake.display || '小阳阳' }}</b>」，屏幕亮起并应答即成功。
            不灵的话：离近点/大声点 → 还不行就把下方「唤醒阈值」调小（更灵敏）重烧；误唤醒多就调大。
          </p>
        </div>
      </div>
    </div>

    <!-- ============ 唤醒词与固件（管理员） ============ -->
    <div class="card">
      <h3 style="margin:0 0 4px">🔊 唤醒词与固件{{ isAdmin ? '' : '（只读：当前配置）' }}</h3>
      <p class="xz-muted" style="margin:0 0 14px">
        唤醒词在编译期写进固件（MultiNet 引擎，任意中文词都行，不用训练模型）。改完点「编译并烧录」，全程 5-15 分钟。
      </p>

      <!-- 能力横幅：非 Windows/没装工具链 → 文档模式（可从构建机取固件） -->
      <div v-if="!cap.canBuild" class="xz-cap xz-cap-warn">
        ⚠️ 本机不具备编译条件（{{ capMiss }}）——编译要在装了 ESP-IDF 6.1 + 小智源码的 Windows 电脑上进行
        （在那台电脑打开本页就是「⚡ 编译并烧录」一键模式）。这里配置「构建机地址」后可直接下载它编译好的固件来烧录。
      </div>
      <div v-else class="xz-cap xz-cap-ok">
        ✅ 工具链就绪：{{ cap.paths.srcDir }} · {{ cap.isWindows ? 'Windows 烧录可用' : '' }}
      </div>

      <div class="xz-form">
        <div class="xz-field">
          <label>唤醒词拼音</label>
          <input v-model="form.wake.pinyin" :disabled="!isAdmin" placeholder="xiao yang yang" />
        </div>
        <div class="xz-field">
          <label>显示名（应答称呼）</label>
          <input v-model="form.wake.display" :disabled="!isAdmin" maxlength="12" placeholder="小阳阳" />
        </div>
        <div class="xz-field xz-field-s">
          <label>阈值（越小越灵敏）</label>
          <input v-model.number="form.wake.threshold" :disabled="!isAdmin" type="number" min="1" max="99" />
        </div>
      </div>

      <template v-if="isAdmin">
        <div class="xz-form" style="margin-top:10px">
          <div class="xz-field xz-field-s">
            <label>串口（烧录用）</label>
            <div class="xz-inline">
              <select v-model="form.port">
                <option value="">（先刷新列表）</option>
                <option v-for="p in ports" :key="p.port" :value="p.port">{{ p.port }}{{ p.korvo ? ' ★小智板' : '' }}（{{ p.name }}）</option>
              </select>
              <button class="btn sm" :disabled="busy.ports" @click="loadPorts">{{ busy.ports ? '…' : '刷新' }}</button>
              <button class="btn sm" :disabled="busy.probe || !form.port" @click="doProbe">{{ busy.probe ? '探测中…' : '探测芯片' }}</button>
              <span class="xz-muted xz-port-note" title="串口探测 / 编译烧录需要本地模式：在装了 ESP-IDF 6.1 + 小智源码的电脑上打开 http://localhost:3000 的本页操作。生产/NAS 页没有工具链和串口，探测不到芯片是正常的——那边用上方「构建机地址」下载固件，配 esptool 命令手动烧录。">
                ⚠️ 仅本地模式（装了 ESP-IDF 的电脑开 localhost:3000）能探测/烧录；生产页探测不到芯片是正常的
              </span>
            </div>
            <small v-if="probeMsg" class="xz-muted" :class="{ 'xz-err': !probeOk }">{{ probeMsg }}</small>
          </div>
        </div>

        <div class="xz-actions">
          <button class="btn primary" :disabled="!cap.canBuild || st.running" @click="startBuild(true)">⚡ 编译并烧录</button>
          <button class="btn" :disabled="!cap.canBuild || st.running" @click="startBuild(false)">仅编译（不烧录）</button>
          <button v-if="st.failed || st.done" class="btn ghost" :disabled="st.running" @click="resetBuild">清除记录</button>
          <span v-if="st.running" class="xz-muted">进行中：{{ st.steps && st.steps[st.stepIndex] && st.steps[st.stepIndex].label }}…</span>
        </div>

        <!-- 无工具链环境（NAS/容器）：从构建机取固件 + 烧录指引（v1.9.12） -->
        <div v-if="!cap.canBuild" class="xz-helper">
          <div class="xz-form">
            <div class="xz-field">
              <label>构建机地址（装了 ESP-IDF 的工作台，留空则本机无固件可取）</label>
              <input v-model="form.helper.url" placeholder="http://192.168.1.100:3000" />
            </div>
          </div>
          <div class="xz-actions">
            <button class="btn primary" @click="dlFirmware">⬇ 下载固件镜像</button>
            <button class="btn ghost" @click="saveHelper">保存地址</button>
          </div>
          <small class="xz-muted">
            本机没有固件产物时自动向构建机取（它须开着工作台且已编译过固件；两边「桥接密钥」一致才认）。
            固件内含密钥，仅管理员可下载。
          </small>
          <div class="xz-cmd" @click="copyCmd" title="点击复制">esptool --chip esp32s3 -p COM4 -b 921600 write-flash 0x0 xiaozhi-korvo2v3-merged.bin</div>
          <small class="xz-muted">
            烧前先跑 <b>flash-id</b> 确认芯片是 ESP32-S3（COM3 是别的板子，别烧错）；esptool/驱动在「装机向导」下载。
            电脑直连烧录用装了工具链那台的「⚡ 编译并烧录」最省事。
          </small>
        </div>

        <!-- 进度 + 日志 -->
        <div v-if="st.startedAt" class="xz-build">
          <div class="xz-bar"><i :style="{ width: (st.progress || 0) + '%' }" :class="{ fail: st.failed }"></i></div>
          <div class="xz-build-meta">
            <span v-if="st.running">{{ st.progress }}%</span>
            <span v-else-if="st.done" class="xz-ok">✅ 完成（{{ fmtTime(st.finishedAt) }}）</span>
            <span v-else-if="st.failed" class="xz-err">❌ {{ st.error }}</span>
          </div>
          <div class="xz-steps">
            <span v-for="(s, i) in st.steps" :key="s.key" class="xz-chip" :class="{ on: i === st.stepIndex && st.running, done: i < st.stepIndex || st.done }">{{ s.label }}</span>
          </div>
          <div class="xz-log" ref="logBox">
            <div v-for="(l, i) in st.log" :key="i" :class="{ 'xz-log-err': l.startsWith('[') && l.includes('❌') }">{{ l }}</div>
          </div>
        </div>
      </template>
      <div v-else class="xz-kv">
        <span>当前唤醒词</span><b>{{ cfg.wake.display }}（{{ cfg.wake.pinyin }}，阈值 {{ cfg.wake.threshold }}）</b>
      </div>
    </div>
    </template>

    <!-- ============ 语音控米家 ============ -->
    <template v-else-if="sub === 'voice'">
    <div class="card">
      <h3 style="margin:0 0 4px">🏠 语音控米家（板子 → 工作台 → 米家设备）</h3>
      <p class="xz-muted" style="margin:0 0 14px">
        原理：对小智说指令 → 云端 AI 调用板上的 <code>self.workbench.*</code> 工具 → 板子 HTTP 回连本工作台 →
        控制右侧「米家」tab 里的设备。需要固件烧录时勾选桥接（下方 URL 非空即自动启用）。
      </p>

      <template v-if="isAdmin">
        <div class="xz-form">
          <div class="xz-field">
            <label>桥接地址（烧进固件；填 NAS 内网地址最快最稳）</label>
            <input v-model="form.bridge.url" placeholder="http://192.168.1.100:3000/api/xiaozhi/bridge" />
          </div>
        </div>
        <div class="xz-kv">
          <span>桥接密钥（32hex）</span>
          <span class="xz-inline">
            <code class="xz-key">{{ bridgeKey || '（点生成）' }}</code>
            <button class="btn sm ghost" @click="rotateKey" title="轮换后旧固件立即失联，需重烧">轮换</button>
          </span>
        </div>
        <p class="xz-muted" style="margin:6px 0 14px;font-size:12px">
          改了桥接地址或轮换密钥后，需要重新「编译并烧录」固件才会生效。
        </p>
      </template>

      <div class="xz-form">
        <div class="xz-field">
          <label>控制通道</label>
          <div class="xz-radios">
            <label class="xz-radio"><input type="radio" value="direct" v-model="form.channel" :disabled="!isAdmin" />
              <b>直接米家</b><span class="xz-muted">开关类指令直达 MIoT（快、有回执，默认）</span></label>
            <label class="xz-radio"><input type="radio" value="speaker" v-model="form.channel" :disabled="!isAdmin" />
              <b>智能屏转述</b><span class="xz-muted">指令转成文字发给小爱解析（能控空调温度等复杂指令，无回执、尽力而为）</span></label>
          </div>
        </div>
      </div>

      <!-- 智能屏备用通道 -->
      <div class="xz-sub">
        <div class="xz-sub-title">智能屏备用通道（xiaomi.wifispeaker.x10a）</div>
        <div class="xz-form">
          <div class="xz-field xz-field-s">
            <label>did</label>
            <input v-model="form.speaker.did" :disabled="!isAdmin" />
          </div>
          <div class="xz-field">
            <label>动作点位（siid 留空=自动探测）</label>
            <div class="xz-inline">
              <input v-model="form.speaker.siid_play" :disabled="!isAdmin" placeholder="播放 siid" class="xz-mini" />
              <input v-model="form.speaker.aiid_play" :disabled="!isAdmin" placeholder="aiid 3" class="xz-mini" />
              <span class="xz-muted">播放文本</span>
              <input v-model="form.speaker.siid_exec" :disabled="!isAdmin" placeholder="执行 siid" class="xz-mini" />
              <input v-model="form.speaker.aiid_exec" :disabled="!isAdmin" placeholder="aiid 4" class="xz-mini" />
              <span class="xz-muted">执行指令</span>
              <button class="btn sm" :disabled="busy.spProbe" @click="probeSpeaker">{{ busy.spProbe ? '探测中…' : '自动探测 siid' }}</button>
            </div>
            <small v-if="spProbeMsg" class="xz-muted">{{ spProbeMsg }}</small>
          </div>
        </div>
        <div class="xz-inline" style="margin-top:8px">
          <input v-model="testText" placeholder="试播/试执行内容，如：今天天气不错" style="flex:1;max-width:420px" />
          <button class="btn sm" :disabled="!testText.trim()" @click="speakerTest('play')">🔈 试播</button>
          <button class="btn sm" :disabled="!testText.trim()" @click="speakerTest('exec')">▶ 试执行指令</button>
        </div>
        <small v-if="spTestMsg" class="xz-muted">{{ spTestMsg }}</small>
      </div>

      <!-- 可控设备预览（与「米家」tab 同源；别名=语音里的另一种叫法，纯对照不改真名） -->
      <div class="xz-sub">
        <div class="xz-sub-title xz-click" @click="toggleDevices">
          可控设备一览（{{ shownDevices.length }} 台）{{ showDevices ? ' ▴' : ' ▾' }}
          <button class="btn sm" style="margin-left:8px" :disabled="busy.devs" @click.stop="loadDevices(true)">{{ busy.devs ? '同步中…' : '⟳ 同步米家' }}</button>
          <select v-if="showDevices && homes.length > 1" v-model="homeFilter" class="xz-home-sel" @click.stop @change="saveHomeFilter">
            <option value="all">全部家庭（{{ devices.length }}）</option>
            <option v-for="h in homes" :key="h" :value="h">{{ h }}（{{ devices.filter((d) => d.home === h).length }}）</option>
          </select>
        </div>
        <div v-if="showDevices" class="xz-devs-wrap">
          <p class="xz-muted" style="margin:2px 0 8px">
            与「米家」tab 同一数据源：进本页、展开列表、点 ⟳ 都会刷新（⟳ 额外强制同步小米云端）。
            <b>别名</b>=给设备起的语音叫法，登记后<b>只认别名、本名退出匹配</b>——两台重名设备给其中一台起别名即可消歧（喊本名就只控没别名的那台）；输完回车或点别处即保存{{ isAdmin ? '' : '（登记需管理员）' }}；
            左侧开关可直接通断测试（与语音同一条控制链路）。
          </p>
          <div v-if="!shownDevices.length" class="xz-muted">
            <template v-if="devBound === false">⚠️ 本服务器还没绑定米家（{{ devMsg || '未绑定' }}）——到「米家」tab 绑定后这里自动出现。</template>
            <template v-else>（{{ homeFilter !== 'all' ? `「${homeFilter}」里没有可控设备` : '没有可控设备' }}）</template><br />
            注意：这里显示的是<b>当前这台服务器</b>的米家数据——本地电脑（localhost）与生产 NAS 是两套独立的库；
            语音桥接地址填的哪台服务器，板子就控制哪台的米家。
          </div>
          <div v-for="d in shownDevices" :key="d.did" class="xz-dev" :class="{ busy: d._busy }">
            <button v-if="d.sw" class="xz-toggle" :class="{ on: d.sw.v, wait: d._busy }" :disabled="!d.online || d._busy"
                    :title="d.online ? '快速通断测试' : '设备离线'" @click="toggleDevice(d)"><i></i></button>
            <i v-else class="xz-dot" :class="{ 'xz-on': d.online }" :title="d.online ? (d.is_parent ? '在线（父设备）' : '在线（无开关属性）') : '离线'"></i>
            <span class="xz-dev-name" :title="`${d.room === '未分区' ? '' : d.room + ' · '}${d.name}${d.home ? '（' + d.home + '）' : ''}`">{{ d.room === '未分区' ? '' : d.room + ' · ' }}{{ d.name }}</span>
            <!-- 父设备（v1.9.25）：多路开关的父条目——本体无开关无别名，各分路有独立卡片，这里只标注（照「米家」tab 的父设备标法） -->
            <span v-if="d.is_parent" class="xz-parent-tag" title="多路开关的父设备——本体没有开关，各分路在下方独立可控">父设备</span>
            <template v-else>
              <span class="xz-alias-arrow" title="语音别名（登记后只认别名，本名退出匹配——重名设备消歧用）">叫→</span>
              <input v-model="d.aliasDraft" class="xz-alias" placeholder="语音别名" maxlength="32"
                     :disabled="!isAdmin" @blur="saveAlias(d)" @keyup.enter="$event.target.blur()" />
              <button class="btn sm ghost xz-alias-save" :class="{ dirty: d.aliasDraft !== (d.alias || '') }"
                      :disabled="!isAdmin || d.aliasDraft === (d.alias || '')" @mousedown.prevent @click="saveAlias(d)">存</button>
              <small v-if="d.sw" class="xz-muted xz-sw-state">{{ d.sw.v ? '开' : '关' }}</small>
            </template>
          </div>
        </div>
      </div>
    </div>
    </template>

    <!-- ============ 视频对话（v1.9.18） ============ -->
    <template v-else-if="sub === 'live'">
      <div class="card">
        <h3 style="margin:0 0 4px">🎥 视频对话（板子摄像头 + 麦克风扬声器）</h3>
        <p class="xz-muted" style="margin:0 0 14px">
          一个按钮同步开两件事：网页实时显示板子看到的画面（约 2-4 帧/秒，画面经工作台中转，外网也能看），
          同时板子立刻进入对话模式——<b>看着画面直接对它说话，回应从板子扬声器播出</b>（用的是板子的麦克风和喇叭，不是电脑的）。
        </p>
        <div class="xz-actions" style="margin-top:0">
          <button class="btn primary" :disabled="sessionBusy" @click="toggleSession">
            {{ sessionBusy ? '… 处理中' : sessionOn ? '⏹ 结束视频对话' : '🎥 开启视频对话' }}
          </button>
          <button class="btn" :disabled="busy.photo" @click="requestPhoto">📸 拍一张</button>
        </div>
        <p class="xz-muted" style="margin:6px 0 0">
          画面：{{ liveOn ? '✅ 开' : '⬜ 关' }} · 对话：{{ voiceOn ? '✅ 开' : '⬜ 关' }}
          <template v-if="liveOn !== voiceOn">（两边没对齐——再点一次按钮补齐缺的那边）</template>
          <br />
          板子：{{ board.ip ? `${board.ip}${board.online ? ' · 在线' : ' · 刚刚失联'}` : 'IP 未登记（板子连着网并已烧录 v1.9.18 固件后，最迟约 1 分钟自动登记）' }}
          <button class="btn sm ghost" style="margin-left:6px" @click="loadBoard">⟳</button>
        </p>
        <div v-if="liveOn" class="xz-live-frame">
          <img :src="videoUrl" alt="板子实时画面" @error="liveStreamBroken" />
          <span class="xz-live-tag">● LIVE</span>
        </div>
        <div v-else class="xz-muted" style="margin-top:12px">
          （视频默认关闭：开着流板子会持续采集编码耗电耗 CPU，不用时记得关。流断了会自动停，重新点按钮即可。）
        </div>
        <small class="xz-muted" style="display:block;margin-top:6px">
          需已烧录 v1.9.18 固件；对话中喊「你看到了什么」这类视觉问答建议先结束视频对话（板子同一颗摄像头，两条链路抢帧）。
        </small>
      </div>
    </template>

    <!-- ============ 对话记录（v1.9.19）：与板子的全部对话，聊天窗口式，向上滚动加载更早 ======== -->
    <template v-else-if="sub === 'history'">
      <div class="card">
        <h3 style="margin:0 0 4px">💬 对话记录（与{{ boardName }}的全部对话）</h3>
        <p class="xz-muted" style="margin:0 0 10px">
          板子听到的每句话（右侧）和{{ boardName }}的每句应答（左侧）都自动存进工作台；
          默认显示最新一段，向上滚动到顶自动加载更早的（每次约 3 屏）。需已烧录 v1.9.19 固件之后的对话才有记录。
          <button class="btn sm ghost" style="margin-left:6px" :disabled="busy.chat" @click="loadChat()">{{ busy.chat ? '加载中…' : '⟳ 刷新' }}</button>
        </p>
        <div v-if="!chat.messages.length && !busy.chat" class="xz-muted" style="padding:28px 0;text-align:center">
          还没有对话记录——对着板子说句话，几秒后刷新就能看到（固件每 3 秒攒批上报）。
        </div>
        <div v-else class="xz-chat" ref="chatBox" @scroll="onChatScroll">
          <div v-if="chat.loadingMore" class="xz-chat-hint">加载更早的记录…</div>
          <div v-else-if="!chat.hasMore" class="xz-chat-hint">—— 没有更早的了 ——</div>
          <div v-for="m in chat.messages" :key="m.id" class="xz-chat-row" :class="m.role">
            <div class="xz-bubble" :class="m.role">
              <span v-if="m.role === 'assistant'" class="xz-chat-name">{{ boardName }}</span>
              <span class="xz-chat-text">{{ m.text }}</span>
              <span class="xz-chat-time" :title="fmtTime(m.ts)">{{ fmtChatTime(m.ts) }}</span>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- ============ 摄像头（v1.9.17） ============ -->
    <!-- 这里**必须写全条件**：v1.9.31 加「语音助手」时把它单开成 v-if，而这块是链尾的 v-else，
         于是语音助手页签下摄像头相册跟着一起渲染（v1.9.32 修） -->
    <template v-else-if="sub === 'camera'">
      <div class="card">
        <h3 style="margin:0 0 4px">📷 摄像头相册（板子拍照存工作台）</h3>
        <p class="xz-muted" style="margin:0 0 14px">
          板子摄像头拍的照片会存进工作台：可以对着板子说「拍张照存相册」（语音 → AI 调板上的拍照工具），
          也可以在这里点按钮主动让板子拍（板子每 ~25 秒轮询一次指令，稍等即传）。点击照片放大，滚轮缩放。
        </p>
        <div class="xz-actions" style="margin-top:0">
          <button class="btn primary" :disabled="busy.photo" @click="requestPhoto">{{ busy.photo ? '已请求，等板子上传…' : '📸 让板子拍一张' }}</button>
          <button class="btn" :disabled="busy.photos" @click="loadPhotos">{{ busy.photos ? '…' : '⟳ 刷新' }}</button>
          <span class="xz-muted">{{ photos.length ? `共 ${photos.length} 张` : '（还没有照片）' }}</span>
        </div>
        <div v-if="!photos.length" class="xz-muted" style="margin-top:10px">
          相册还是空的——对着板子说「拍张照存到相册」，或点上面的按钮（需板子已烧录带拍照功能的固件并连着网）。
        </div>
        <div v-else class="xz-gallery">
          <div v-for="p in photos" :key="p.file" class="xz-shot">
            <img :src="photoUrl(p.file)" loading="lazy" @click="openLightbox(p)" alt="板子照片" />
            <div class="xz-shot-bar">
              <span class="xz-muted">{{ fmtTime(p.mtime) }} · {{ fmtSize(p.size) }}</span>
              <button v-if="isAdmin" class="btn sm ghost" @click="delPhoto(p)">删除</button>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 照片查看器：点击放大 / 滚轮缩放 / 双击复位 / ESC 或点背景关闭 -->
    <div v-if="viewer.show" class="xz-viewer" @wheel.prevent="zoomViewer($event.deltaY < 0 ? 1 : -1)" @click.self="closeViewer"
         @dblclick="resetViewer" tabindex="0" ref="viewerBox">
      <img :src="photoUrl(viewer.file)" :style="{ transform: `scale(${viewer.scale}) translate(${viewer.x}px, ${viewer.y}px)` }" alt="照片查看" />
      <div class="xz-viewer-bar">
        <span>{{ fmtTime(viewer.mtime) }} · {{ fmtSize(viewer.size) }} · {{ Math.round(viewer.scale * 100) }}%</span>
        <span>
          <button class="btn sm ghost" @click="zoomViewer(-1)">－</button>
          <button class="btn sm ghost" @click="resetViewer">100%</button>
          <button class="btn sm ghost" @click="zoomViewer(1)">＋</button>
          <button class="btn sm ghost" @click="closeViewer">✕ 关闭</button>
        </span>
      </div>
    </div>

    <!-- ============ 语音助手（v1.9.31）：查工作台数据 + 转交 NAS agent ============ -->
    <template v-if="sub === 'assistant'">
    <div class="card">
      <h3 style="margin:0 0 4px">🔎 语音查工作台资料</h3>
      <p class="xz-muted" style="margin:0 0 14px">
        对板子说「查一下我的笔记」这类问题时，板子会去检索下面这个人的资料并口头答出来。
        <b>没指定用户就查不了</b>——板子不知道查谁，这里必须先选一个。
      </p>
      <div class="xz-form">
        <div class="xz-field">
          <label>查谁的资料</label>
          <UserPicker v-model="form.query.uid" :users="users" :multiple="false"
                      :disabled="!isAdmin" placeholder="选一个成员…" />
          <span class="xz-hint">范围：笔记 / 待办 / 家庭事项 / 子女任务 / 学习记录 / 剪贴板 / 新闻 / 邮件 / AI 对话 / 文件存档</span>
        </div>
        <div class="xz-field xz-field-s">
          <label>最多取几条 / 每条截断</label>
          <div class="xz-inline">
            <input v-model.number="form.query.max_results" type="number" min="1" max="30" class="xz-mini" />
            <span class="xz-muted">条，每条</span>
            <input v-model.number="form.query.max_chars" type="number" min="20" max="500" class="xz-mini" />
            <span class="xz-muted">字</span>
          </div>
          <span class="xz-hint">喂给 AI 归纳的量，太大拖慢回答</span>
        </div>
        <div class="xz-field xz-field-s">
          <label>AI 归纳超时</label>
          <div class="xz-inline">
            <input v-model.number="form.query.ai_timeout_ms" type="number" min="500" max="60000" step="500" class="xz-mini" />
            <span class="xz-muted">毫秒</span>
          </div>
          <span class="xz-hint">超过就直接念「找到 N 条：…」，不让板子干等</span>
        </div>
      </div>
      <p class="xz-muted" style="font-size:12px;margin:8px 0 0">
        没配置 AI 模型时自动走降级文案（只报条目标题），功能不受影响。
      </p>
    </div>

    <div class="card">
      <h3 style="margin:0 0 4px">🤖 转交家里 agent</h3>
      <p class="xz-muted" style="margin:0 0 14px">
        把任务交给局域网里那台能读写文件、跑代码的 agent（Hermes 之类）。
        <b>只有用户点名它时才转交</b>：名字叫「{{ form.agent.name || '贾维斯' }}」，说「让{{ form.agent.name || '贾维斯' }}去做 X」就走它，
        其它的仍由板子自己的小智 AI 回答。
      </p>
      <div class="xz-form">
        <div class="xz-field">
          <label>启用</label>
          <div class="xz-inline">
            <input id="xz-agent-on" v-model="form.agent.enabled" type="checkbox" :disabled="!isAdmin" />
            <label for="xz-agent-on" class="xz-check-lb">允许板子语音调用它</label>
          </div>
          <span class="xz-hint">默认关闭 —— 不开的话任何人都喊不动它</span>
        </div>
        <div class="xz-field">
          <label>agent 的地址（IP:端口）</label>
          <input v-model="form.agent.base_url" :disabled="!isAdmin" placeholder="http://192.168.1.10:8642" />
          <span class="xz-hint">局域网地址，<b>不要暴露到公网</b></span>
        </div>
        <div class="xz-field">
          <label>Agent 名</label>
          <input v-model="form.agent.model" :disabled="!isAdmin" placeholder="fnnas-feishu" />
          <span class="xz-hint">填 agent 的 <b>profile 档案名</b>（Hermes 里就是那个档案 / 模型 ID，如 <code>fnnas-feishu</code>）——不是给它起的说话名，那个填在下面。填哪个档案就决定了消息从哪个机器人出去：<b>「屏幕【测试】按钮走哪条」选飞书时，那条自检消息就是让这个档案自己去发的</b></span>
        </div>
        <div class="xz-field">
          <label>API 密钥</label>
          <div class="xz-inline">
            <input v-model="form.agentKey" type="password" :disabled="!isAdmin"
                   :placeholder="cfg.agent?.has_key ? '已配置（留空保持不变）' : '粘贴 agent 的密钥'" />
            <button v-if="isAdmin && cfg.agent?.has_key" class="btn sm ghost" @click="clearAgentKey">清除</button>
          </div>
          <span class="xz-hint">加密存库，读取接口永不回显</span>
        </div>
        <div class="xz-field">
          <label>叫它的名字 / 别名</label>
          <div class="xz-inline">
            <input v-model="form.agent.name" class="xz-narrow" :disabled="!isAdmin" maxlength="16" />
            <input v-model="form.agentAliases" :disabled="!isAdmin" placeholder="别名，逗号分隔（可留空）" />
          </div>
        </div>
        <div class="xz-field">
          <label>安全</label>
          <div class="xz-inline">
            <input id="xz-agent-reqname" v-model="form.agent.require_name" type="checkbox" :disabled="!isAdmin" />
            <label for="xz-agent-reqname" class="xz-check-lb">必须点名才放行</label>
            <input id="xz-agent-risky" v-model="form.agent.block_risky" type="checkbox" :disabled="!isAdmin" />
            <label for="xz-agent-risky" class="xz-check-lb">拦截危险词</label>
            <span class="xz-muted">每小时最多</span>
            <input v-model.number="form.agent.rate_per_hour" type="number" min="1" max="500" class="xz-mini" :disabled="!isAdmin" />
            <span class="xz-muted">次</span>
          </div>
        </div>
        <div class="xz-field xz-field-s">
          <label>同步等待上限</label>
          <div class="xz-inline">
            <input v-model.number="form.agent.sync_budget_ms" type="number" min="1000" max="120000" step="500" class="xz-mini" :disabled="!isAdmin" />
            <span class="xz-muted">毫秒</span>
          </div>
        </div>
        <div class="xz-field xz-field-s">
          <label>屏幕【测试】按钮走哪条</label>
          <div class="xz-inline">
            <select v-model="form.test.channel" class="xz-mini" :disabled="!isAdmin">
              <option value="feishu">飞书（走上面的 agent）</option>
              <option value="dingtalk">钉钉</option>
            </select>
          </div>
        </div>
      </div>
      <p class="xz-muted" style="margin:8px 0 0">
        「屏幕【测试】按钮走哪条」= 板上第四个按钮按下后，那条自检消息（接入点状态 / agent 连通性 / agent 查的本地天气）
        从哪个 IM 发出来。<b>默认飞书</b>（v1.9.37 起）；<b>选了哪条就发哪条，不发第二条</b>——那条没配好就在板子上
        如实报错，不会悄悄改走另一条。<br />
        <b>飞书那条是让上面的 agent 自己发的</b>（把这段话交给「Agent 名」那个档案，由它发进你的飞书）——所以收到消息的
        就是<b>贾维斯自己的飞书机器人</b>，不是「设置 → 飞书推送」里那个工作台自带的应用（那是另一个机器人，发到那边你在飞书里看不到）。
        收件人由 agent 决定（它绑的就是你的会话）。钉钉那条没有这层中转，照旧发给「查谁的资料」那位成员绑定的钉钉。
      </p>
      <div class="xz-cap xz-cap-warn" style="margin:10px 0 0">
        ⚠️ <b>超过「同步等待上限」的长任务，答案会从智能屏播出来，不是板子</b>——板子会先说「还在算，算好了我用智能屏告诉您」，
        算完由智能屏补播。这是板子固件的限制（云端驱动 TTS，工具调用必须同步返回），不是 bug。
      </div>
      <div class="xz-dl-row" style="margin-top:10px">
        <button class="btn" :disabled="!isAdmin || busy.agentTest" @click="testAgent">
          {{ busy.agentTest ? '测试中…' : '🔌 测试连通性' }}
        </button>
        <span v-if="agentTestMsg" class="xz-muted">{{ agentTestMsg }}</span>
      </div>
    </div>

    <div class="card">
      <h3 style="margin:0 0 4px">🔗 官方 MCP 接入点（可选，二选一通道）</h3>
      <p class="xz-muted" style="margin:0 0 14px">
        小智控制台里的 <b>MCP 接入点</b>：勾上并填好地址、token 后，工作台会主动连过去，
        语音就能调到上面这两个能力。<b>好处是以后加功能不用再烧固件</b>。
        与「设备侧工具」是两条并行通道，同时开会重名——<b>只开一条</b>。
      </p>
      <div class="xz-form">
        <div class="xz-field">
          <label>启用</label>
          <div class="xz-inline">
            <input id="xz-mcp-on" v-model="form.mcp.enabled" type="checkbox" :disabled="!isAdmin" />
            <label for="xz-mcp-on" class="xz-check-lb">连接接入点</label>
            <span class="xz-pill" :class="mcpPill.cls">{{ mcpPill.text }}</span>
            <button v-if="isAdmin" class="btn sm ghost" :disabled="busy.mcpState" @click="checkMcp">
              {{ busy.mcpState ? '查询中…' : '🔄 刷新状态' }}
            </button>
          </div>
          <span class="xz-hint">令牌与地址都填好、并勾上这里，才会去连</span>
          <span v-if="mcpMsg" class="xz-hint" :class="mcpPill.cls === 'ok' ? 'xz-ok' : 'xz-err'">{{ mcpMsg }}</span>
          <span v-else-if="isAdmin && cfg.mcp?.last_error" class="xz-hint xz-err">最近一次失败：{{ cfg.mcp.last_error }}</span>
          <span v-else-if="cfg.mcp?.connected && cfg.mcp?.since" class="xz-hint xz-ok">
            已连上（{{ fmtTime(cfg.mcp.since) }}），掉线会自动重连
          </span>
        </div>
        <div class="xz-field">
          <label>接入点地址</label>
          <input v-model="form.mcp.url" :disabled="!isAdmin" placeholder="wss://api.xiaozhi.me/mcp/" />
          <span class="xz-hint">
            必须 wss://。控制台给的那条地址尾巴上有个 <code>?token=…</code>——<b>地址里只留到 /mcp/ 为止</b>，
            后面那一长串填到下面的 token 框（放地址里会明文存库）
          </span>
        </div>
        <div class="xz-field">
          <label>接入点 token</label>
          <input v-model="form.mcpToken" type="password" :disabled="!isAdmin"
                 :placeholder="cfg.mcp?.token_set ? '已配置（留空保持不变）' : '粘贴小智控制台给的 token'" />
          <span class="xz-hint">加密存库，读取接口永不回显</span>
        </div>
      </div>
    </div>

    <div class="xz-dl-row" v-if="isAdmin" style="margin:0 0 14px">
      <button class="btn primary" :disabled="busy.assistantSave" @click="saveAssistant">
        {{ busy.assistantSave ? '保存中…' : '💾 保存语音助手配置' }}
      </button>
      <span class="xz-muted">密钥保存后即刻生效；接入点开关变化会自动重连</span>
    </div>
    <p v-else class="xz-muted">只有管理员能改这些设置。</p>
    </template>

    <!-- ============ Agent 对话记录（v1.9.35）：转交流水单开一页，可筛选 + 翻页 ============ -->
    <template v-if="sub === 'agentlog'">
    <div class="card">
      <h3 style="margin:0 0 10px">📜 Agent对话记录</h3>
      <p class="xz-muted" style="margin:0 0 10px;font-size:12px">
        谁在什么时候让 agent 办了什么、被哪道闸拦下——板子范围内谁都能喊，出事只能靠这条查。
        四项筛选都是模糊匹配（日期只认那天整天）。
      </p>
      <div class="xz-form xz-filters">
        <div class="xz-field xz-field-s">
          <label>日期范围</label>
          <div class="xz-inline">
            <input v-model="logQ.from" type="date" class="xz-date" />
            <span class="xz-muted">至</span>
            <input v-model="logQ.to" type="date" class="xz-date" />
          </div>
        </div>
        <div class="xz-field xz-field-s">
          <label>状态类型</label>
          <select v-model="logQ.status" class="xz-mini">
            <option value="">全部</option>
            <option value="ok">已办</option>
            <option value="rejected">已拦</option>
            <option value="error">出错</option>
          </select>
        </div>
        <div class="xz-field xz-field-s">
          <label>语音内容</label>
          <input v-model="logQ.request" placeholder="说的那句话里含…" @keyup.enter="searchLog" />
        </div>
        <div class="xz-field xz-field-s">
          <label>反馈内容</label>
          <input v-model="logQ.feedback" placeholder="回复或拒绝原因里含…" @keyup.enter="searchLog" />
        </div>
      </div>
      <div class="xz-dl-row" style="margin:10px 0 10px">
        <button class="btn primary sm" :disabled="busy.agentLog" @click="searchLog">{{ busy.agentLog ? '查询中…' : '🔍 查询' }}</button>
        <button class="btn sm ghost" :disabled="busy.agentLog" @click="resetLog">清空条件</button>
        <button class="btn sm" :disabled="busy.agentLog" @click="loadAgentLog(agentLog.page)">{{ busy.agentLog ? '加载中…' : '🔄 刷新' }}</button>
        <span class="xz-muted">每页</span>
        <select v-model.number="logQ.pageSize" class="xz-mini" @change="searchLog">
          <option v-for="n in LOG_PAGE_SIZES" :key="n" :value="n">{{ n }}</option>
        </select>
        <span class="xz-muted">行</span>
      </div>
      <div v-if="agentLog.entries.length" class="xz-loglist">
        <div v-for="e in agentLog.entries" :key="e.id" class="xz-logrow">
          <span class="xz-muted">{{ fmtTime(e.ts) }}</span>
          <span class="xz-pill" :class="e.status === 'ok' ? 'ok' : e.status === 'rejected' ? 'warn' : 'bad'">
            {{ e.status === 'ok' ? '已办' : e.status === 'rejected' ? '已拦' : '出错' }}
          </span>
          <span class="xz-logreq">{{ e.request }}</span>
          <span class="xz-muted xz-logwhy">{{ e.reason || e.result || '' }}</span>
          <span class="xz-muted xz-logms">{{ e.ms }}ms</span>
        </div>
      </div>
      <p v-else class="xz-muted">{{ busy.agentLog ? '查询中…' : (agentLog.total ? '这一页没有记录。' : '没有符合条件的记录。') }}</p>
      <div class="xz-dl-row" style="margin-top:10px">
        <button class="btn sm" :disabled="busy.agentLog || agentLog.page <= 1" @click="loadAgentLog(agentLog.page - 1)">‹ 上一页</button>
        <span class="xz-muted">第 {{ agentLog.page }} / {{ agentLog.pages }} 页 · 共 {{ agentLog.total }} 条</span>
        <button class="btn sm" :disabled="busy.agentLog || agentLog.page >= agentLog.pages" @click="loadAgentLog(agentLog.page + 1)">下一页 ›</button>
      </div>
    </div>
    </template>

    <!-- 消息条 -->
    <div v-if="msg.err" class="msg err">{{ msg.err }}</div>
    <div v-if="msg.ok" class="msg ok">{{ msg.ok }}</div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { api } from '../api';
import UserPicker from './UserPicker.vue'; // 通用用户下拉（v1.9.31：指定查谁的资料）

const isAdmin = (() => { try { return (JSON.parse(localStorage.getItem('wb_user') || '{}') || {}).role === 'admin'; } catch { return false; } })();

const cap = ref({ canBuild: false, canFlash: false, isWindows: true, firmware: {}, paths: {} });
const cfg = ref({ wake: { pinyin: '', display: '', threshold: 20 }, channel: 'direct', speaker: {}, bridge: { url: '' }, paths: {} });
const bridgeKey = ref('');
const form = reactive({
  wake: { pinyin: '', display: '', threshold: 20 },
  channel: 'direct',
  port: '',
  bridge: { url: '' },
  helper: { url: '' },
  speaker: { did: '', siid_play: '', aiid_play: 3, siid_exec: '', aiid_exec: 4 },
  // v1.9.31 语音助手
  query: { uid: null, max_results: 10, max_chars: 120, ai_timeout_ms: 6000 },
  agent: { enabled: false, name: '贾维斯', base_url: '', model: '', require_name: true, block_risky: true, rate_per_hour: 20, sync_budget_ms: 8000 },
  agentAliases: '',
  agentKey: '',   // 只写不读：留空 = 保持原值，服务端也只回 has_key 布尔
  mcp: { enabled: false, url: '' },
  mcpToken: '',
  // v1.9.36 屏幕【测试】按钮走哪条 IM —— v1.9.37 起默认飞书（用户指定：飞书是默认 IM，钉钉不是）
  test: { channel: 'feishu' },
});
const ports = ref([]);
const busy = reactive({ ports: false, probe: false, spProbe: false, devs: false, photo: false, photos: false, chat: false, agentTest: false, agentLog: false, assistantSave: false, mcpState: false });
const probeMsg = ref(''); const probeOk = ref(false);
const spProbeMsg = ref(''); const spTestMsg = ref('');
const testText = ref('');
const devices = ref([]); const showDevices = ref(true); // v1.9.25：可控设备一览默认直接展开
const devBound = ref(null); const devMsg = ref(''); // null=未加载；false=未绑米家（面板要能区分 0 台的两种原因）

// ---------- 子 tab：贾维斯(v1.9.31，v1.9.33 挪到第一个) / Agent对话记录(v1.9.35) / 装机向导 / 语音控米家 / 视频对话 / 对话记录 / 摄像头 ----------
// 没存过页签时落在第一个（贾维斯）——它就是板子的主用途；存过的一律尊重用户上次的选择
const SUBS = ['assistant', 'agentlog', 'guide', 'voice', 'live', 'history', 'camera'];
const sub = ref(SUBS.includes(localStorage.getItem('xz_sub')) ? localStorage.getItem('xz_sub') : 'assistant');
function switchSub(s) {
  sub.value = s;
  localStorage.setItem('xz_sub', s);
  if (s === 'voice') loadDevices(false); // 台数随标题显示，切过来就拉最新
  if (s === 'live') loadBoard();
  if (s === 'history') loadChat();
  if (s === 'camera') loadPhotos();
  if (s === 'agentlog') loadAgentLog();
  if (s === 'assistant') {
    loadUsers();
    stopMcpWatch();                 // 离开过再回来：重新问一次真实状态，别拖着上一轮的轮询
    mcpMsg.value = '';
    pollMcpOnce().catch(() => {});
  } else stopMcpWatch();
}

// ---------- 语音助手（v1.9.31）：指定用户 + agent 连通性 ----------
const users = ref([]);
const agentTestMsg = ref('');
async function loadUsers() {
  if (users.value.length) return; // 每次进 tab 不必重拉
  try { users.value = (await api.get('/messages/contacts')).users || []; }
  catch (e) { flashErr('用户列表加载失败：' + e.message); }
}

// ---------- Agent对话记录（原「转交流水」，v1.9.35 单开一页 + 筛选翻页） ----------
// 默认 20 行、可翻页、页量可改；四个筛选走后端（不是前端过滤——记录会攒到 2000 条，全塞给浏览器不合适）
const LOG_PAGE_SIZES = [5, 10, 20, 30, 50, 100];
const logQ = reactive({ from: '', to: '', status: '', request: '', feedback: '', pageSize: 20 });
const agentLog = reactive({ entries: [], total: 0, page: 1, pages: 1 });
async function loadAgentLog(page = 1) {
  busy.agentLog = true;
  try {
    const qs = new URLSearchParams({ page: String(page), page_size: String(logQ.pageSize) });
    if (logQ.from) qs.set('from', logQ.from);
    if (logQ.to) qs.set('to', logQ.to);
    if (logQ.status) qs.set('status', logQ.status);
    if (logQ.request.trim()) qs.set('request', logQ.request.trim());
    if (logQ.feedback.trim()) qs.set('feedback', logQ.feedback.trim());
    const r = await api.get('/xiaozhi/agent-log?' + qs.toString());
    agentLog.entries = r.entries || [];
    agentLog.total = r.total ?? agentLog.entries.length;
    agentLog.page = r.page || 1;
    agentLog.pages = r.pages || 1;
  } catch (e) { flashErr('记录加载失败：' + e.message); }
  busy.agentLog = false;
}
function searchLog() { loadAgentLog(1); }   // 改条件一律回到第 1 页，否则会停在一个不存在的页码上
function resetLog() {
  Object.assign(logQ, { from: '', to: '', status: '', request: '', feedback: '' });
  loadAgentLog(1);
}
async function testAgent() {
  busy.agentTest = true; agentTestMsg.value = '';
  try {
    const r = await api.post('/xiaozhi/agent-test', {});
    // 失败时把「试的是哪个地址」一并说出来：404 这类错八成是地址少了 /v1 那一段，
    // 只说「接口错误 404」等于让人去猜（用户就是这么撞上的）
    agentTestMsg.value = r.ok ? `✅ 通了，往返 ${r.ms}ms` : `❌ ${r.error}${r.url ? `（试的地址：${r.url}）` : ''}`;
  } catch (e) { agentTestMsg.value = '❌ ' + e.message; }
  busy.agentTest = false;
}
async function clearAgentKey() {
  try { const r = await api.put('/xiaozhi/config', { agent_key_clear: true }); cfg.value = r.config; flashOk('密钥已清除'); }
  catch (e) { flashErr(e.message); }
}
async function saveAssistant() {
  busy.assistantSave = true;
  try {
    await saveConfig();
    flashOk('已保存（密钥存好即生效）');
    // 接入点是**异步**连的：保存这一刻必然还没握手完，回读一定是「未连接」。
    // 不盯着刷新一会儿，界面就会一直挂着「未连接」——连上了也看不出来（v1.9.32 修）
    if (form.mcp.enabled) watchMcp();
    else { stopMcpWatch(); mcpMsg.value = ''; pollMcpOnce().catch(() => {}); }
  } catch (e) { flashErr(e.message); }
  busy.assistantSave = false;
}

// ---------- 接入点连接状态（v1.9.32） ----------
const mcpMsg = ref('');
let mcpTimer = null;
const mcpPill = computed(() => {
  const m = cfg.value.mcp || {};
  if (m.connected) return { cls: 'ok', text: '● 已连接' };
  if (mcpMsg.value.startsWith('连接中')) return { cls: 'warn', text: '◌ 连接中…' };
  if (mcpMsg.value) return { cls: 'bad', text: '○ 连不上' };
  if (m.last_error) return { cls: 'bad', text: '○ 连不上' };
  return { cls: 'bad', text: '○ 未连接' };
});
// 只回填状态字段，绝不动 form：轮询期间用户可能正在改配置，碰 form 会把输入抹掉
function patchMcp(m, agent) {
  cfg.value = {
    ...cfg.value,
    mcp: { ...(cfg.value.mcp || {}), ...m },
    ...(agent ? { agent: { ...(cfg.value.agent || {}), has_key: !!agent.has_key } } : {}),
  };
}
async function pollMcpOnce() {
  const c = await api.get('/xiaozhi/config');
  if (c && c.config) patchMcp(c.config.mcp || {}, c.config.agent);
  return (c && c.config && c.config.mcp) || {};
}
function stopMcpWatch() { if (mcpTimer) { clearInterval(mcpTimer); mcpTimer = null; } }
// 连上之前每 1.5s 问一次（最多 15s）；连上立刻停手，超时把原因写在状态下方
function watchMcp() {
  stopMcpWatch();
  mcpMsg.value = '连接中…';
  let n = 0;
  mcpTimer = setInterval(async () => {
    n += 1;
    let m = {};
    try { m = await pollMcpOnce(); } catch { /* 抖一下继续问 */ }
    if (m.connected) { stopMcpWatch(); mcpMsg.value = ''; flashOk('接入点已连上'); return; }
    if (n >= 10) {
      stopMcpWatch();
      mcpMsg.value = m.last_error
        ? `连不上：${m.last_error}`
        : '连不上：检查地址与 token 是否填全（桥接每 30s 会自动再试，改动后建议刷新页面看日志）';
    }
  }, 1500);
}
async function checkMcp() {
  busy.mcpState = true;
  mcpMsg.value = '连接中…';
  try {
    const m = await pollMcpOnce();
    if (m.connected) { mcpMsg.value = ''; flashOk('接入点已连上'); }
    else if (form.mcp.enabled) watchMcp();          // 勾着没连上：多半正在重连，再盯一轮
    else mcpMsg.value = '还没勾「连接接入点」——勾上再保存才会去连';
  } catch (e) { mcpMsg.value = '查询失败：' + e.message; }
  busy.mcpState = false;
}

// ---------- 对话记录（v1.9.19）：聊天窗口，左=板子应答，右=用户指令；向上滚动翻更早 ----------
const chat = reactive({ messages: [], hasMore: false, loadingMore: false });
const chatBox = ref(null);
const boardName = computed(() => cfg.value.wake?.display || '小阳阳'); // 板子的称呼跟唤醒词显示名走
const fmtChatTime = (t) => { try { return new Date(t).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }); } catch { return ''; } };
async function loadChat() {
  busy.chat = true;
  try {
    const r = await api.get('/xiaozhi/chatlog?limit=50'); // 一页 50 条≈3 屏
    chat.messages = r.messages || [];
    chat.hasMore = !!r.has_more;
    await nextTick(); // 默认滚到底：进来直接看到最新一轮对话
    if (chatBox.value) chatBox.value.scrollTop = chatBox.value.scrollHeight;
  } catch (e) { flashErr('对话记录加载失败：' + e.message); }
  busy.chat = false;
}
async function onChatScroll() {
  const el = chatBox.value;
  if (!el || chat.loadingMore || !chat.hasMore || busy.chat) return;
  if (el.scrollTop > 80) return; // 滚到贴近顶部才翻页
  chat.loadingMore = true;
  const prevHeight = el.scrollHeight;
  const prevTop = el.scrollTop;
  try {
    const r = await api.get(`/xiaozhi/chatlog?limit=50&before_id=${chat.messages[0]?.id || 0}`);
    chat.messages = [...(r.messages || []), ...chat.messages];
    chat.hasMore = !!r.has_more;
    await nextTick();
    el.scrollTop = el.scrollHeight - prevHeight + prevTop; // 补回撑高的差值：视口看起来原地不动，旧内容从上面接出来
  } catch (e) { flashErr('加载更早记录失败：' + e.message); }
  chat.loadingMore = false;
}

// ---------- 视频对话（v1.9.18 建，v1.9.21 一键同步）：MJPEG 流经工作台代理（?token= 同照片先例）；对话指令直达板子 ----------
const board = ref({ ip: '', seen_at: 0, online: false });
const liveOn = ref(false); // 流开关——img 只在开时挂载，关=断连接，板子随之停止推帧
const voiceOn = ref(false); // 对话开关（板子 StartListening/StopListening 的镜像，指令成功才置位）
const sessionBusy = ref(false);
const sessionOn = computed(() => liveOn.value && voiceOn.value); // 两边都开才算「进行中」
const videoUrl = computed(() => `/api/xiaozhi/video?token=${token()}`);
async function loadBoard() {
  try { board.value = await api.get('/xiaozhi/board'); } catch { /* 排障信息而已，失败不打扰 */ }
}
// 一键开关：开=对话先行、画面跟上（v1.9.21 真机实测：视频流活跃时板子应答 /chat 要 2.4s+，
// 先开流再发指令容易顶到超时 502——所以两个方向都按「无流竞争」的顺序发：开=先指令后挂流，关=先摘流后指令）。
// 部分失败不回滚另一边——状态行看得到，再点一次补齐
async function toggleSession() {
  sessionBusy.value = true;
  try {
    if (sessionOn.value) {
      liveOn.value = false; // 先摘 <img> 断流，板子 httpd 不再被推流挤占，结束指令毫秒级
      await setVoice(false);
      flashOk('已结束视频对话');
    } else {
      const ok = await setVoice(true); // 对话指令先发（此刻无流，0.2s 级应答），板子随即进入监听
      liveOn.value = true; // 再挂画面（对话失败也挂——看着画面排障，状态行能看出对话缺着）
      loadBoard(); // 开流顺带刷一次板子状态（错误提示里好用）
      if (ok) flashOk('视频对话已开启——看着画面直接对它说话');
    }
  } finally { sessionBusy.value = false; }
}
async function setVoice(on) {
  try {
    await api.post('/xiaozhi/chat', { on });
    voiceOn.value = on;
    return true;
  } catch (e) {
    flashErr((on ? '开启对话失败' : '结束对话失败') + '：' + e.message);
    return false;
  }
}
function liveStreamBroken() {
  liveOn.value = false;
  flashErr('视频流断了（板子可能重启/断网）——稍后再点按钮重开（对话若还开着会一并补齐）');
}

// ---------- 家庭过滤 + 快捷开关（v1.9.17） ----------
const homes = ref([]);
const homeFilter = ref('all'); // 'all'=全部（存进 config.home_filter，下次进来还是这个家）
const shownDevices = computed(() => homeFilter.value === 'all' ? devices.value : devices.value.filter((d) => d.home === homeFilter.value));
async function saveHomeFilter() {
  if (!isAdmin) return; // 非管理员只改本会话显示，不落配置
  try { await api.put('/xiaozhi/config', { home_filter: homeFilter.value }); } catch (e) { flashErr('默认家庭保存失败：' + e.message); }
}
async function toggleDevice(d) {
  if (d._busy || !d.sw) return;
  const want = !d.sw.v;
  d._busy = true; d.sw.v = want; // 乐观更新，失败回读校正（与米家卡片同思路）
  try {
    const r = await api.post('/xiaozhi/device-control', { did: d.did, action: want ? 'on' : 'off' });
    if (!r.ok) { d.sw.v = !want; flashErr(r.message || '控制失败'); }
    else flashOk(r.message || `已${want ? '打开' : '关闭'}${d.name}`);
  } catch (e) {
    d.sw.v = !want;
    flashErr('控制失败：' + e.message);
  } finally { d._busy = false; }
}

// ---------- 摄像头相册（v1.9.17） ----------
const photos = ref([]);

const st = ref({ running: false, done: false, failed: false, progress: 0, stepIndex: 0, log: [], steps: [] });
const msg = reactive({ err: '', ok: '' });
const logBox = ref(null);
let pollTimer = null;

const fmtSize = (n) => (!n ? '' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB');
const fmtTime = (t) => { try { return new Date(t).toLocaleString('zh-CN', { hour12: false }); } catch { return ''; } };
const capMiss = ref('');
function flashOk(m) { msg.ok = m; setTimeout(() => (msg.ok = ''), 4000); }
function flashErr(m) { msg.err = m; setTimeout(() => (msg.err = ''), 8000); }

function syncForm(c) {
  cfg.value = c;
  form.wake = { ...c.wake };
  form.channel = c.channel;
  form.bridge = { ...c.bridge };
  form.helper = { url: (c.helper && c.helper.url) || '' };
  form.speaker = {
    did: c.speaker.did || '',
    siid_play: c.speaker.siid_play ?? '', aiid_play: c.speaker.aiid_play ?? 3,
    siid_exec: c.speaker.siid_exec ?? '', aiid_exec: c.speaker.aiid_exec ?? 4,
  };
  form.port = c.paths.serialPort || 'COM4';
  // v1.9.31：语音助手。密钥字段一律留空——回显密钥会让「保存」变成「覆盖成掩码」
  const q = c.query || {}; const a = c.agent || {}; const m = c.mcp || {};
  form.query = {
    uid: q.uid ?? null,
    max_results: q.max_results ?? 10,
    max_chars: q.max_chars ?? 120,
    ai_timeout_ms: q.ai_timeout_ms ?? 6000,
  };
  form.agent = {
    enabled: !!a.enabled, name: a.name || '贾维斯', base_url: a.base_url || '', model: a.model || '',
    require_name: a.require_name !== false, block_risky: a.block_risky !== false,
    rate_per_hour: a.rate_per_hour ?? 20, sync_budget_ms: a.sync_budget_ms ?? 8000,
  };
  form.agentAliases = (Array.isArray(a.aliases) ? a.aliases : []).join(', ');
  form.agentKey = '';
  form.mcp = { enabled: !!m.enabled, url: m.url || '' };
  form.mcpToken = '';
  const tst = c.test || {};
  form.test = { channel: tst.channel === 'dingtalk' ? 'dingtalk' : 'feishu' }; // 没存过 = 跟随新默认飞书
}

async function loadAll() {
  try {
    const c = await api.get('/xiaozhi/config');
    syncForm(c.config);
    bridgeKey.value = c.bridge_key || '';
    cap.value = await api.get('/xiaozhi/capabilities');
    const miss = [];
    if (!cap.value.srcExists) miss.push('小智源码');
    if (!cap.value.esptoolExists) miss.push('esptool');
    if (!cap.value.idfExists) miss.push('ESP-IDF 环境');
    if (!cap.value.isWindows) miss.push('仅限 Windows');
    capMiss.value = miss.join('、') || '缺工具链';
  } catch (e) { flashErr('读取配置失败：' + e.message); }
}

// ---------- 可控设备（与米家 tab 同源；fresh=强制同步小米云端） ----------
async function loadDevices(fresh) {
  busy.devs = true;
  try {
    const r = await api.get('/xiaozhi/devices' + (fresh ? '?fresh=1' : ''));
    devBound.value = !!r.bound;
    devMsg.value = r.message || '';
    devices.value = (r.devices || []).map((d) => ({ ...d, aliasDraft: d.alias || '' }));
    homes.value = r.homes || [];
    if (homeFilter.value === 'all' && cfg.value.home_filter && cfg.value.home_filter !== 'all'
        && homes.value.includes(cfg.value.home_filter)) homeFilter.value = cfg.value.home_filter; // 默认家庭（config 存的）
    if (homeFilter.value !== 'all' && !homes.value.includes(homeFilter.value)) homeFilter.value = 'all'; // 家庭没了（改名/删除）回全部
  } catch (e) { flashErr('设备列表加载失败：' + e.message); }
  busy.devs = false;
}
function toggleDevices() {
  showDevices.value = !showDevices.value;
  if (showDevices.value) loadDevices(false); // 每次展开都拉最新——米家 tab 那边动过这里立刻跟上
}
async function saveAlias(d) {
  const v = String(d.aliasDraft || '').trim();
  if (v === (d.alias || '')) return;
  try {
    await api.put('/xiaozhi/device-alias', { did: d.did, alias: v });
    d.alias = v || null;
    flashOk(v ? `已登记别名「${v}」——对板子喊这个名字也能控` : '已清除别名');
  } catch (e) { flashErr('别名保存失败：' + e.message); }
}

// ---------- 相册 ----------
const token = () => encodeURIComponent(localStorage.getItem('wb_token') || '');
const photoUrl = (file) => `/api/xiaozhi/photos/${file}?token=${token()}`; // <img> 带不了 Authorization 头，走 ?token=（同家庭图床）
async function loadPhotos() {
  busy.photos = true;
  try { photos.value = (await api.get('/xiaozhi/photos')).photos || []; }
  catch (e) { flashErr('相册加载失败：' + e.message); }
  busy.photos = false;
}
let photoPollTimer = null;
async function requestPhoto() {
  busy.photo = true;
  try {
    const r = await api.post('/xiaozhi/photo-request', {});
    flashOk(r.message || '已请求拍照，等板子上传');
    // 板子 ~25s 轮询一次（刚开机要等 60s 启动 + 25s 周期）：密集刷 80 秒，见到新照片就停
    const before = photos.value[0]?.file || '';
    clearInterval(photoPollTimer);
    let n = 0;
    photoPollTimer = setInterval(async () => {
      if (++n > 16) { clearInterval(photoPollTimer); busy.photo = false; return; } // 80s 超时
      try {
        await loadPhotos();
        if (photos.value[0] && photos.value[0].file !== before) {
          clearInterval(photoPollTimer); busy.photo = false;
          flashOk('照片已上传 🎉');
        }
      } catch { /* 下个 tick 重试 */ }
    }, 5000);
  } catch (e) { busy.photo = false; flashErr('请求失败：' + e.message); }
}
async function delPhoto(p) {
  if (!confirm(`删除这张 ${fmtTime(p.mtime)} 的照片？`)) return;
  try {
    await api.del(`/xiaozhi/photos/${p.file}`);
    photos.value = photos.value.filter((x) => x.file !== p.file);
    if (viewer.value.show && viewer.value.file === p.file) closeViewer();
  } catch (e) { flashErr('删除失败：' + e.message); }
}

// ---------- 照片查看器（点击放大 / 滚轮缩放 / 双击复位 / ESC 关闭） ----------
const viewerBox = ref(null);
const viewer = reactive({ show: false, file: '', size: 0, mtime: 0, scale: 1, x: 0, y: 0 });
function openLightbox(p) {
  Object.assign(viewer, { show: true, file: p.file, size: p.size, mtime: p.mtime, scale: 1, x: 0, y: 0 });
  nextTick(() => viewerBox.value?.focus());
}
function closeViewer() { viewer.show = false; }
function zoomViewer(dir) {
  viewer.scale = Math.min(8, Math.max(0.2, viewer.scale + dir * Math.max(0.1, viewer.scale * 0.15)));
}
function resetViewer() { viewer.scale = 1; viewer.x = 0; viewer.y = 0; }
function onKey(e) { if (e.key === 'Escape' && viewer.show) closeViewer(); }
window.addEventListener('keydown', onKey);

async function saveConfig(extra = {}) {
  const body = {
    wake: { ...form.wake },
    channel: form.channel,
    bridge: { url: form.bridge.url.trim() },
    helper: { url: form.helper.url.trim() },
    // did 为空就整块不发：服务端要求 did 是纯数字，发了必被 400 打回，
    // 而「语音助手」页只想存 agent/接入点配置时并不该被智能屏那个字段拦住（空=保持原值）
    ...(String(form.speaker.did).trim() ? {
      speaker: {
        did: String(form.speaker.did).trim(),
        siid_play: form.speaker.siid_play === '' ? null : Number(form.speaker.siid_play),
        aiid_play: Number(form.speaker.aiid_play) || 3,
        siid_exec: form.speaker.siid_exec === '' ? null : Number(form.speaker.siid_exec),
        aiid_exec: Number(form.speaker.aiid_exec) || 4,
      },
    } : {}),
    paths: { serialPort: form.port },
    // v1.9.31 语音助手。密钥只在非空时发（服务端把空串当「保持原值」）
    query: {
      uid: form.query.uid === null || form.query.uid === '' ? null : Number(form.query.uid),
      max_results: Number(form.query.max_results) || 10,
      max_chars: Number(form.query.max_chars) || 120,
      ai_timeout_ms: Number(form.query.ai_timeout_ms) || 6000,
    },
    agent: {
      enabled: !!form.agent.enabled, name: form.agent.name, base_url: form.agent.base_url, model: form.agent.model,
      aliases: form.agentAliases.split(/[,，、]/).map((s) => s.trim()).filter(Boolean),
      require_name: !!form.agent.require_name, block_risky: !!form.agent.block_risky,
      rate_per_hour: Number(form.agent.rate_per_hour) || 20,
      sync_budget_ms: Number(form.agent.sync_budget_ms) || 8000,
    },
    mcp: { enabled: !!form.mcp.enabled, url: form.mcp.url },
    test: { channel: form.test.channel === 'dingtalk' ? 'dingtalk' : 'feishu' },
    ...(form.agentKey.trim() ? { agent_key: form.agentKey.trim() } : {}),
    ...(form.mcpToken.trim() ? { mcp_token: form.mcpToken.trim() } : {}),
    ...extra,
  };
  const r = await api.put('/xiaozhi/config', body);
  cfg.value = r.config;
  // 密钥已入库，清掉本地明文，避免停在这个页面时一直被持在内存里
  form.agentKey = ''; form.mcpToken = '';
  return r.config;
}

// ---------- 构建 ----------
async function startBuild(flash) {
  try {
    const c = await saveConfig();
    const r = await api.post('/xiaozhi/build', {
      pinyin: form.wake.pinyin, display: form.wake.display, threshold: form.wake.threshold,
      bridgeUrl: c.bridge.url, flash, port: form.port,
    });
    st.value = r;
    flashOk(flash ? '已开始编译并烧录，下面实时日志' : '已开始编译，下面实时日志');
    startPoll();
  } catch (e) { flashErr(e.message); }
}
function resetBuild() { api.post('/xiaozhi/build/reset').then(() => { st.value = { running: false, done: false, failed: false, progress: 0, stepIndex: 0, log: [], steps: [] }; }).catch(() => {}); }
function startPoll() {
  stopPoll();
  pollTimer = setInterval(async () => {
    try {
      st.value = await api.get('/xiaozhi/build/status');
      if (!st.value.running) { stopPoll(); if (st.value.done) flashOk('构建烧录完成 🎉'); if (st.value.failed) flashErr('构建失败：' + st.value.error); }
      nextTick(() => { if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight; });
    } catch { /* 轮询失败下个 tick 重试 */ }
  }, 1000);
}
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

// ---------- 串口 / 芯片 ----------
async function loadPorts() {
  busy.ports = true;
  try { const r = await api.get('/xiaozhi/ports'); ports.value = r.ports || []; const k = ports.value.find((p) => p.korvo); if (k && !form.port) form.port = k.port; }
  catch (e) { flashErr(e.message); }
  finally { busy.ports = false; }
}
async function doProbe() {
  busy.probe = true; probeMsg.value = '';
  try { const r = await api.post('/xiaozhi/probe', { port: form.port }); probeOk.value = r.ok; probeMsg.value = (r.ok ? '✓ ' : '✗ ') + r.message; }
  catch (e) { probeOk.value = false; probeMsg.value = '✗ ' + e.message; }
  finally { busy.probe = false; }
}

// ---------- 桥接密钥 ----------
async function rotateKey() {
  if (!confirm('轮换密钥后，已烧录的固件会立即失联（需重烧）。确定？')) return;
  try { bridgeKey.value = (await api.post('/xiaozhi/bridge-key/reset')).bridge_key; flashOk('已轮换——记得重新编译烧录固件'); }
  catch (e) { flashErr(e.message); }
}

// ---------- 智能屏 ----------
async function probeSpeaker() {
  busy.spProbe = true; spProbeMsg.value = '';
  try {
    await saveConfig();
    const r = await api.post('/xiaozhi/speaker-probe', {});
    spProbeMsg.value = (r.ok ? '✓ ' : '✗ ') + r.message;
    if (r.speaker) { form.speaker.siid_play = r.speaker.siid_play ?? ''; form.speaker.siid_exec = r.speaker.siid_exec ?? ''; cfg.value.speaker = r.speaker; }
  } catch (e) { spProbeMsg.value = '✗ ' + e.message; }
  finally { busy.spProbe = false; }
}
async function speakerTest(kind) {
  spTestMsg.value = '';
  try { const r = await api.post('/xiaozhi/speaker-test', { kind, text: testText.value }); spTestMsg.value = (r.ok ? '✓ ' : '✗ ') + r.message; }
  catch (e) { spTestMsg.value = '✗ ' + e.message; }
}

// ---------- 下载 ----------
function dlTool(name) { api.download(`/xiaozhi/tools/${encodeURIComponent(name)}`, name === 'ch343-driver' ? 'ch343-driver.zip' : name).catch((e) => flashErr('下载失败：' + e.message)); }
function dlFirmware() { api.download('/xiaozhi/firmware', 'xiaozhi-korvo2v3-merged.bin').catch((e) => flashErr('下载失败：' + e.message)); }

// ---------- 无工具链环境：构建机地址保存 + 烧录命令复制 ----------
function saveHelper() { saveConfig().then(() => flashOk('构建机地址已保存')).catch((e) => flashErr(e.message)); }
function copyCmd() {
  const text = 'esptool --chip esp32s3 -p COM4 -b 921600 write-flash 0x0 xiaozhi-korvo2v3-merged.bin';
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject())
    .then(() => flashOk('烧录命令已复制'))
    .catch(() => flashErr('复制失败，请手动选中命令复制'));
}

// ---------- 通道/地址变化自动保存（管理员；防抖 800ms，敲完地址才存） ----------
let saveTimer = null;
watch(() => [form.channel, form.bridge.url, form.helper.url, form.speaker.did], () => {
  if (!isAdmin) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveConfig().catch((e) => flashErr(e.message)), 800);
});

onMounted(async () => {
  await loadAll();
  loadDevices(false); // 设备台数随标题显示，不阻塞页面
  st.value = await api.get('/xiaozhi/build/status').catch(() => st.value);
  if (st.value.running) startPoll();
  if (isAdmin && cap.value.canFlash) loadPorts();
  // 子 tab 存在 localStorage 里：直接刷新页面回到「语音助手」时，switchSub 不会跑，
  // 成员列表就是空的（下拉点开写「无匹配用户」，看着像选不了人）。这里补上首屏该拉的数据。
  if (sub.value === 'assistant') { loadUsers(); pollMcpOnce().catch(() => {}); }
  if (sub.value === 'agentlog') loadAgentLog();
});
onBeforeUnmount(() => {
  stopPoll();
  stopMcpWatch();
  clearInterval(photoPollTimer);
  window.removeEventListener('keydown', onKey);
});
</script>

<style scoped>
.xz-root { display: flex; flex-direction: column; gap: 16px; }
.xz-tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.xz-tabs button { border: 1px solid var(--border, #e5e7eb); background: rgba(0,0,0,.03); color: inherit; border-radius: 18px; padding: 5px 16px; font-size: 13px; cursor: pointer; }
.xz-tabs button.on { background: var(--accent, #2563eb); border-color: var(--accent, #2563eb); color: #fff; }
.xz-port-note { flex: 1; min-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; }
.xz-home-sel { font-size: 12.5px; padding: 2px 6px; border: 1px solid var(--border, #e5e7eb); border-radius: 6px; background: transparent; color: inherit; margin-left: 8px; }
.xz-toggle { position: relative; width: 34px; height: 18px; border-radius: 9px; border: none; background: #c8c8c8; cursor: pointer; padding: 0; flex: none; transition: background .2s; }
.xz-toggle i { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: left .2s; box-shadow: 0 1px 2px rgba(0,0,0,.25); }
.xz-toggle.on { background: var(--ok, #1e9e68); }
.xz-toggle.on i { left: 18px; }
.xz-toggle.wait { opacity: .6; }
.xz-toggle:disabled { cursor: not-allowed; }
.xz-dot { width: 8px; height: 8px; border-radius: 50%; background: #bbb; flex: none; margin: 0 13px; }
.xz-dot.xz-on { background: var(--ok, #1e9e68); }
.xz-dev.busy { opacity: .7; }
.xz-gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; margin-top: 12px; }
.xz-shot { display: flex; flex-direction: column; gap: 4px; }
.xz-shot img { width: 100%; aspect-ratio: 4/3; object-fit: cover; border-radius: 8px; cursor: zoom-in; background: #0b1020; }
.xz-shot-bar { display: flex; justify-content: space-between; align-items: center; font-size: 12px; }
.xz-viewer { position: fixed; inset: 0; z-index: 1000; background: rgba(0,0,0,.88); display: flex; align-items: center; justify-content: center; outline: none; }
.xz-viewer img { max-width: 92vw; max-height: 88vh; cursor: zoom-in; transition: transform .08s linear; user-select: none; -webkit-user-drag: none; }
.xz-viewer-bar { position: absolute; bottom: 14px; left: 0; right: 0; display: flex; justify-content: space-between; align-items: center; padding: 0 20px; color: #eee; font-size: 13px; }
.xz-viewer-bar .btn { color: #eee; border-color: rgba(255,255,255,.4); }
.xz-muted { color: var(--muted); font-size: 13px; line-height: 1.7; margin: 4px 0; }
.xz-ok { color: var(--ok, #1e9e68); }
.xz-err { color: var(--danger, #dc2626); }
.xz-wake { color: var(--accent, #2563eb); }
.xz-step { display: flex; gap: 12px; padding: 10px 0; border-top: 1px dashed var(--border, #e5e7eb); }
.xz-step-no { font-size: 18px; font-weight: 700; color: var(--accent, #2563eb); min-width: 26px; }
.xz-step-body { flex: 1; min-width: 0; }
.xz-dl-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-top: 6px; }
.xz-jump { color: var(--accent, #2563eb); font-size: 13px; text-decoration: none; }
.xz-cap { border-radius: 8px; padding: 8px 12px; font-size: 13px; margin-bottom: 12px; }
.xz-cap-ok { background: rgba(30, 158, 104, .08); color: var(--ok, #1e9e68); }
.xz-cap-warn { background: rgba(234, 179, 8, .1); color: #a16207; }
.xz-form { display: flex; gap: 12px; flex-wrap: wrap; }
.xz-field { display: flex; flex-direction: column; gap: 4px; }
.xz-field > label { font-size: 12px; color: var(--muted); }
.xz-field-s { max-width: 240px; }
.xz-field input, .xz-field select { min-width: 170px; }
.xz-field input[type="checkbox"] { width: auto; min-width: 0; flex: none; }
.xz-field textarea { min-width: 240px; }
.xz-inline { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.xz-inline > .xz-check-lb { font-size: 13px; white-space: nowrap; }
.xz-mini { width: 86px !important; min-width: 86px !important; }
/* Agent对话记录筛选条（v1.9.35）：date 框装不下 YYYY-MM-DD 加日历图标，86px 会把它挤成一团 */
.xz-date { width: 150px !important; min-width: 150px !important; }
.xz-filters .xz-field-s { max-width: 300px; }
.xz-narrow { width: 130px !important; min-width: 130px !important; }
.xz-hint { font-size: 12px; color: var(--muted); line-height: 1.6; }
/* 语音助手：转交流水的状态标签与行 */
.xz-pill { flex: none; font-size: 11.5px; line-height: 1; padding: 3px 8px; border-radius: 9px; background: rgba(0,0,0,.06); color: var(--muted); }
.xz-pill.ok { background: rgba(30,158,104,.15); color: var(--ok, #1e9e68); }
.xz-pill.warn { background: rgba(234,179,8,.16); color: #a16207; }
.xz-pill.bad { background: rgba(220,38,38,.12); color: var(--danger, #dc2626); }
.xz-loglist { border-top: 1px dashed var(--border, #e5e7eb); }
.xz-logrow { display: flex; gap: 10px; align-items: baseline; padding: 7px 0; border-bottom: 1px dashed var(--border, #e5e7eb); font-size: 13px; }
.xz-logrow > .xz-muted:first-child { flex: none; font-size: 12px; white-space: nowrap; }
.xz-logreq { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.xz-logwhy { flex: 0 1 40%; min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.xz-logms { flex: none; font-size: 12px; }
.xz-actions { display: flex; gap: 10px; align-items: center; margin: 14px 0 10px; flex-wrap: wrap; }
.xz-kv { display: flex; gap: 10px; align-items: center; padding: 4px 0; font-size: 13px; }
.xz-kv > span:first-child { color: var(--muted); min-width: 96px; }
.xz-key { font-size: 12px; background: rgba(0,0,0,.05); padding: 2px 8px; border-radius: 4px; }
.xz-build { margin-top: 6px; }
.xz-bar { height: 8px; border-radius: 4px; background: rgba(0,0,0,.08); overflow: hidden; }
.xz-bar i { display: block; height: 100%; background: var(--accent, #2563eb); transition: width .6s; }
.xz-bar i.fail { background: var(--danger, #dc2626); }
.xz-build-meta { font-size: 12.5px; margin: 6px 0; color: var(--muted); }
.xz-steps { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
.xz-chip { font-size: 11.5px; padding: 2px 8px; border-radius: 10px; background: rgba(0,0,0,.06); color: var(--muted); }
.xz-chip.on { background: var(--accent, #2563eb); color: #fff; }
.xz-chip.done { background: rgba(30,158,104,.15); color: var(--ok, #1e9e68); }
.xz-log { max-height: 260px; overflow: auto; background: #0b1020; color: #c9d6f0; border-radius: 8px; padding: 10px 12px; font: 12px/1.65 Consolas, monospace; }
.xz-log-err { color: #ff9b9b; }
.xz-helper { margin-top: 12px; padding: 12px; border: 1px dashed var(--border, #e5e7eb); border-radius: 10px; display: flex; flex-direction: column; gap: 8px; }
.xz-cmd { background: #0b1020; color: #9fe8b8; border-radius: 8px; padding: 10px 12px; font: 12px/1.6 Consolas, monospace; cursor: pointer; word-break: break-all; }
.xz-radios { display: flex; gap: 10px; flex-wrap: wrap; }
.xz-radio { display: flex; flex-direction: column; gap: 2px; border: 1px solid var(--border, #e5e7eb); border-radius: 8px; padding: 8px 12px; cursor: pointer; min-width: 240px; }
.xz-radio input { margin-right: 6px; }
.xz-radio .xz-muted { margin: 0; font-size: 12px; }
.xz-sub { border-top: 1px dashed var(--border, #e5e7eb); margin-top: 14px; padding-top: 10px; }
.xz-sub-title { font-weight: 600; font-size: 13.5px; margin-bottom: 8px; }
.xz-click { cursor: pointer; }
.xz-devs-wrap { display: block; }
.xz-devs { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 6px; }
.xz-dev { display: flex; gap: 8px; align-items: center; font-size: 13px; padding: 4px 8px; background: rgba(0,0,0,.03); border-radius: 6px; }
.xz-dev-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 44%; flex: 0 1 auto; }
.xz-alias-arrow { font-size: 11px; color: var(--muted); flex: none; opacity: .55; }
.xz-dev:hover .xz-alias-arrow { opacity: 1; color: var(--accent, #2563eb); }
.xz-alias { width: 108px; flex: none; font-size: 12px; padding: 2px 8px; border: 1px solid var(--border, #e5e7eb); border-radius: 6px; background: transparent; color: inherit; }
.xz-dev:hover .xz-alias { border-color: var(--accent, #2563eb); }
.xz-alias-save { flex: none; padding: 2px 8px !important; font-size: 12px; opacity: .45; }
.xz-alias-save.dirty { opacity: 1; border-color: var(--accent, #2563eb); color: var(--accent, #2563eb); }
.xz-sw-state { margin-left: auto; flex: none; }
/* 父设备圆角标签（v1.9.25）：行内式（本面板设备是行不是卡片，照「米家」tab 的 accent 底白字圆角观感） */
.xz-parent-tag { flex: none; margin-left: 8px; font-size: 11px; line-height: 1; font-weight: 600; padding: 4px 9px; border-radius: 9px; background: var(--accent, #4f8cff); color: #fff; }
.xz-live-frame { position: relative; margin-top: 12px; background: #0b1020; border-radius: 10px; overflow: hidden; }
.xz-live-frame img { display: block; width: 100%; max-height: 62vh; object-fit: contain; }
.xz-live-tag { position: absolute; top: 10px; left: 10px; font-size: 11px; letter-spacing: 1px; color: #ff6b6b; background: rgba(0,0,0,.55); border-radius: 4px; padding: 2px 8px; }
.xz-chat { max-height: 62vh; overflow-y: auto; border: 1px solid var(--border, #e5e7eb); border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; background: rgba(0,0,0,.02); scroll-behavior: auto; }
.xz-chat-row { display: flex; }
.xz-chat-row.user { justify-content: flex-end; }
.xz-bubble { max-width: 78%; border-radius: 12px; padding: 7px 12px; font-size: 13.5px; line-height: 1.6; word-break: break-word; }
.xz-bubble.assistant { background: rgba(0,0,0,.06); border-top-left-radius: 4px; }
.xz-bubble.user { background: var(--accent, #2563eb); color: #fff; border-top-right-radius: 4px; }
.xz-chat-name { display: block; font-size: 11px; font-weight: 600; color: var(--accent, #2563eb); margin-bottom: 2px; }
.xz-chat-time { display: block; font-size: 10.5px; opacity: .55; margin-top: 2px; text-align: right; }
.xz-chat-hint { text-align: center; font-size: 11.5px; color: var(--muted); padding: 2px 0 6px; flex: none; }
.xz-dev i { width: 8px; height: 8px; border-radius: 50%; background: #bbb; flex: none; }
.xz-dev i.xz-on { background: var(--ok, #1e9e68); }
</style>
