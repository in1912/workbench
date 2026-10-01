<template>
  <div class="xz-root">
    <!-- ============ 装机向导 ============ -->
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
              <input v-model="form.helper.url" placeholder="http://192.168.110.100:3000" />
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

    <!-- ============ 语音控米家 ============ -->
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
            <input v-model="form.bridge.url" placeholder="http://192.168.110.105:3000/api/xiaozhi/bridge" />
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

      <!-- 可控设备预览 -->
      <div class="xz-sub">
        <div class="xz-sub-title xz-click" @click="showDevices = !showDevices">
          可控设备一览（{{ devices.length }} 台）{{ showDevices ? ' ▴' : ' ▾' }}
        </div>
        <div v-if="showDevices" class="xz-devs">
          <div v-for="d in devices" :key="d.did" class="xz-dev">
            <i :class="d.online ? 'xz-on' : ''"></i>
            <span>{{ d.room === '未分区' ? '' : d.room + ' · ' }}{{ d.name }}</span>
            <small v-if="d.sw" class="xz-muted">{{ d.sw.v ? '开' : '关' }}</small>
          </div>
          <div v-if="!devices.length" class="xz-muted">（先在「米家」tab 绑定账号，这里就会出现可控设备）</div>
        </div>
      </div>
    </div>

    <!-- 消息条 -->
    <div v-if="msg.err" class="msg err">{{ msg.err }}</div>
    <div v-if="msg.ok" class="msg ok">{{ msg.ok }}</div>
  </div>
</template>

<script setup>
import { ref, reactive, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { api } from '../api';

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
});
const ports = ref([]);
const busy = reactive({ ports: false, probe: false, spProbe: false });
const probeMsg = ref(''); const probeOk = ref(false);
const spProbeMsg = ref(''); const spTestMsg = ref('');
const testText = ref('');
const devices = ref([]); const showDevices = ref(false);
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

// ---------- 保存（唤醒词/通道/桥接/智能屏/串口一起） ----------
async function saveConfig(extra = {}) {
  const body = {
    wake: { ...form.wake },
    channel: form.channel,
    bridge: { url: form.bridge.url.trim() },
    helper: { url: form.helper.url.trim() },
    speaker: {
      did: String(form.speaker.did).trim(),
      siid_play: form.speaker.siid_play === '' ? null : Number(form.speaker.siid_play),
      aiid_play: Number(form.speaker.aiid_play) || 3,
      siid_exec: form.speaker.siid_exec === '' ? null : Number(form.speaker.siid_exec),
      aiid_exec: Number(form.speaker.aiid_exec) || 4,
    },
    paths: { serialPort: form.port },
    ...extra,
  };
  const r = await api.put('/xiaozhi/config', body);
  cfg.value = r.config;
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
  st.value = await api.get('/xiaozhi/build/status').catch(() => st.value);
  if (st.value.running) startPoll();
  if (isAdmin && cap.value.canFlash) loadPorts();
});
onBeforeUnmount(stopPoll);
</script>

<style scoped>
.xz-root { display: flex; flex-direction: column; gap: 16px; }
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
.xz-inline { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.xz-mini { width: 86px !important; min-width: 86px !important; }
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
.xz-devs { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 6px; }
.xz-dev { display: flex; gap: 8px; align-items: center; font-size: 13px; padding: 4px 8px; background: rgba(0,0,0,.03); border-radius: 6px; }
.xz-dev i { width: 8px; height: 8px; border-radius: 50%; background: #bbb; flex: none; }
.xz-dev i.xz-on { background: var(--ok, #1e9e68); }
</style>
