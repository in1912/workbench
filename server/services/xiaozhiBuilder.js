// 智能板（小智 Korvo2V3）固件构建/烧录状态机（v1.9.11）
// 照 vibeasrInstaller 模式：start() 立即返回，后台跑步骤链，GET /xiaozhi/build/status 轮询。
// 构建链（全部实测自本机 ESP-IDF 6.1 环境，2026-10-01）：
//   cmd /c "call C:\Espressif\frameworks\esp-idf-v6.1\export.bat && cd /d <src> && python scripts\build.py <board> --name esp32s3-korvo2-v3 --language zh-CN"
//   ⚠ export.bat 硬检查 python/git 必须在 PATH——本机 git 装在 C:\Espressif\tools\idf-git\2.44.0\cmd，
//     不前置进去直接 "Missing requirements" 退出；IDF_TOOLS_PATH 机器级变量子进程自动继承。
// 烧录：esptool v5.4 连字符写法（write-flash，旧 write_flash 已弃用，无 --no-progress 参数），
//   烧前强制 flash-id 且输出必须含 "ESP32-S3"（COM3 是另一块 ESP32-C3 红绿灯板，防烧错）。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('./xiaozhiPaths');
const svc = require('./xiaozhiService');

const STEP_DEFS = [
  { key: 'check', label: '检查工具链', weight: 3 },
  { key: 'config', label: '写入板级配置（唤醒词/桥接）', weight: 2 },
  { key: 'probe', label: '探测串口芯片（防烧错板）', weight: 5 },
  { key: 'build', label: '编译固件（首次 5-15 分钟）', weight: 55 },
  { key: 'flash', label: '烧录到板子', weight: 30 },
  { key: 'verify', label: '复核与归档', weight: 5 },
];

const state = {
  running: false, done: false, failed: false,
  stepIndex: 0, progress: 0,
  startedAt: null, finishedAt: null, error: '',
  log: [], wake: null, port: '', flash: true,
  firmware: { path: '', size: 0, mtime: null },
};
const MAX_LOG = 400;
function addLog(line) {
  const s = String(line).replace(/\r/g, '').trimEnd();
  if (!s) return;
  state.log.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${s}`);
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
}

// 步骤进度 → 总进度（权重折算）
function setStepProgress(idx, frac) {
  const before = STEP_DEFS.slice(0, idx).reduce((m, s) => m + s.weight, 0);
  const total = STEP_DEFS.reduce((m, s) => m + s.weight, 0);
  state.stepIndex = idx;
  state.progress = Math.min(99, Math.round((before + STEP_DEFS[idx].weight * Math.max(0, Math.min(1, frac))) / total * 100));
}

// ---------- 子进程封装（cmd /c 一次执行；超时杀进程树） ----------
function runCmd(command, { timeoutMs = 60 * 1000, onLine, onFrac } = {}) {
  return new Promise((resolve, reject) => {
    // windowsVerbatimArguments：cmd.exe 不认 MSVC 式 \" 转义——不透传的话内层引号会带反斜杠进命令
    const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
      windowsHide: true,
      windowsVerbatimArguments: true,
      env: { ...process.env },
    });
    let out = '';
    let emitted = 0; // 已回调过的行数（按整行去重，chunk 边界不在行尾也不重不漏）
    let timer = null;
    const kill = () => spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    if (timeoutMs) timer = setTimeout(() => { kill(); reject(new Error(`命令超时（${Math.round(timeoutMs / 60000)} 分钟）`)); }, timeoutMs);
    const feed = (buf) => {
      out += buf.toString('utf8');
      // 行式回调（进度/日志）；同时保留完整输出供结束解析。最后一段可能是不完整行，等下个 chunk
      const lines = out.split('\n');
      const whole = lines.slice(0, -1);
      for (const l of whole.slice(emitted)) if (onLine) onLine(l);
      emitted = whole.length;
      if (onFrac) {
        // esptool 百分比 "Writing at 0x... (42%)" / ninja 计数 "[123/456]" 取最后一次
        const pcts = out.match(/(\d+)%/g);
        const ninja = out.match(/\[(\d+)\/(\d+)\]/g);
        let frac = null;
        if (ninja && ninja.length) {
          const m = ninja[ninja.length - 1].match(/\[(\d+)\/(\d+)\]/);
          if (m && Number(m[2]) > 0) frac = Number(m[1]) / Number(m[2]);
        } else if (pcts && pcts.length) {
          frac = Number(pcts[pcts.length - 1].replace('%', '')) / 100;
        }
        if (frac != null) onFrac(Math.max(0, Math.min(1, frac)));
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(lastMeaningful(out) || `命令退出码 ${code}`));
    });
  });
}
function lastMeaningful(out) {
  const lines = String(out || '').split('\n').map((l) => l.replace(/\r/g, '').trim()).filter((l) => l && !/^(Writing|Reading|Hash of data|Leaving|A fatal error)/i.test(l));
  return lines.slice(-2).join(' | ').slice(0, 300);
}

// ---------- 板级 config.json 写入（唯一设计入口：sdkconfig_append；UTF-8 无 BOM，绝不用 PowerShell 写） ----------
// 管理键全量重写、非管理键原样保留（camera build_options 等不碰；丢 CONFIG_SR_MN_CN_MULTINET7_QUANT 会炸唤醒引擎）
const MANAGED_PREFIXES = [
  'CONFIG_USE_CUSTOM_WAKE_WORD=', 'CONFIG_CUSTOM_WAKE_WORD=', 'CONFIG_CUSTOM_WAKE_WORD_DISPLAY=',
  'CONFIG_CUSTOM_WAKE_WORD_THRESHOLD=', 'CONFIG_WORKBENCH_BRIDGE_',
];
function writeBoardConfig(det, cfg) {
  const raw = JSON.parse(fs.readFileSync(det.boardConfig, 'utf8'));
  const managed = [
    'CONFIG_USE_CUSTOM_WAKE_WORD=y',
    `CONFIG_CUSTOM_WAKE_WORD="${cfg.wake.pinyin}"`,
    `CONFIG_CUSTOM_WAKE_WORD_DISPLAY="${cfg.wake.display}"`,
    `CONFIG_CUSTOM_WAKE_WORD_THRESHOLD=${cfg.wake.threshold}`,
  ];
  if (cfg.bridge.url) {
    // 桥接启用：URL/KEY 注入构建产物（KEY 只落在本地固件源码目录，xiaozhi 仓无远程，不外泄）
    managed.push(
      'CONFIG_WORKBENCH_BRIDGE_ENABLED=y',
      `CONFIG_WORKBENCH_BRIDGE_URL="${cfg.bridge.url}"`,
      `CONFIG_WORKBENCH_BRIDGE_KEY="${svc.ensureBridgeKey()}"`,
    );
  }
  const rebuild = (lines) => {
    const kept = (lines || []).filter((l) => !MANAGED_PREFIXES.some((p) => String(l).startsWith(p.slice(0, -1))));
    return [...kept, ...managed];
  };
  // build.py 只读 builds[].sdkconfig_append（逐 build 条目，_get_builds_for_idf 不合并顶层键）
  // ——必须写进每个 build 变体，写顶层同名键会被静默忽略（真机踩过：bridge 三行全丢）
  let written = [];
  for (const b of raw.builds || []) {
    b.sdkconfig_append = rebuild(b.sdkconfig_append);
    written = b.sdkconfig_append;
  }
  delete raw.sdkconfig_append; // 清掉曾被误写的顶层键，防止再误导
  fs.writeFileSync(det.boardConfig, JSON.stringify(raw, null, 4) + '\n', 'utf8');
  return written;
}

// ---------- 串口枚举（PowerShell CIM；按 CH343 VID_1A86&PID_55D3 标推荐口） ----------
async function listPorts() {
  if (process.platform !== 'win32') return { ports: [], note: '仅 Windows 支持串口枚举' };
  const out = await new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-Command',
      "Get-CimInstance Win32_PnPEntity -Filter \"Name LIKE '%(COM%'\" | Select-Object Name,DeviceID | ConvertTo-Json -Compress"],
      { windowsHide: true });
    let buf = '';
    ps.stdout.on('data', (d) => (buf += d));
    ps.stderr.on('data', (d) => (buf += d));
    ps.on('error', reject);
    ps.on('close', () => resolve(buf));
  });
  let list = [];
  try {
    const j = JSON.parse(out);
    list = Array.isArray(j) ? j : [j];
  } catch { return { ports: [], note: '串口枚举失败' }; }
  const ports = list.map((x) => {
    const m = /\((COM\d+)\)/.exec(x.Name || '');
    if (!m) return null;
    return {
      port: m[1], name: x.Name,
      korvo: /VID_1A86.*PID_55D3/i.test(x.DeviceID || ''), // CH343 = Korvo2V3 专用桥芯
    };
  }).filter(Boolean);
  return { ports };
}

// ---------- 芯片探测：flash-id 输出必须含 ESP32-S3 ----------
// esptool v5.4 输出格式："Chip type: ESP32-S3 (QFN56)…"（老版本是 "Chip is ESP32-S3"）两种都认
async function probeChip(port, det) {
  const d = det || paths.detect(svc.getConfig());
  const cmd = `${pyPrefix(d)} python -m esptool --chip esp32s3 -p ${port} -b 921600 --before default-reset --after hard-reset flash-id`;
  try {
    const out = await runCmd(cmd, { timeoutMs: 45 * 1000 });
    const chip = (/Chip (?:is|type:)[: ]+(ESP32-[A-Z0-9]+)/i.exec(out) || [])[1] || '';
    const mac = (/MAC:\s*([0-9a-f:]{17})/i.exec(out) || [])[1] || '';
    const flash = (/Detected flash size: (\S+)/i.exec(out) || [])[1] || '';
    if (!/ESP32-S3/i.test(chip)) {
      return { ok: false, chip, mac, message: chip ? `检测到的是 ${chip}，不是 ESP32-S3——这不是小智板，已中止（防烧错别的板子）` : '未识别到芯片（板子没插好或串口被占用？）' };
    }
    return { ok: true, chip, mac, flash, message: `${chip}${flash ? ' · ' + flash : ''}${mac ? ' · MAC ' + mac : ''}` };
  } catch (e) {
    return { ok: false, message: `芯片探测失败：${e.message}` };
  }
}

// export.bat 激活前缀：① git 目录前置（export.bat 硬检查 PATH 里有 git.exe）；
// ② 显式设 IDF_TOOLS_PATH——本机该变量并未设成机器级，不设的话 export.bat 会去默认
//   ~/.espressif 找 python_env（实际装在 C:\Espressif），报 venv not found。
function pyPrefix(d) {
  const gitDir = d.paths.idfGitDir || 'C:\\Espressif\\tools\\idf-git\\2.44.0\\cmd';
  return `set "PATH=${gitDir};%PATH%" && set "IDF_TOOLS_PATH=${d.paths.idfToolsPath}" && call "${d.paths.idfExportBat}" &&`;
}

// ---------- 主流程 ----------
function start(opts = {}) {
  if (state.running) throw new Error('已有构建任务在进行中');
  const cfg = svc.getConfig();
  const wake = {
    pinyin: String(opts.pinyin || cfg.wake.pinyin).trim().toLowerCase(),
    display: String(opts.display || cfg.wake.display).trim(),
    threshold: Math.max(1, Math.min(99, Number(opts.threshold) || cfg.wake.threshold)),
  };
  // 桥接 URL：优先用本次提交值；否则沿用已存配置（前端会把当前访问地址带上来，NAS 内网直连最优）
  if (opts.bridgeUrl !== undefined) cfg.bridge.url = String(opts.bridgeUrl || '').trim();
  const doFlash = opts.flash !== false;
  const port = String(opts.port || cfg.paths.serialPort || 'COM4').trim();
  state.running = true; state.done = false; state.failed = false;
  state.error = ''; state.log = []; state.wake = wake; state.port = doFlash ? port : '';
  state.flash = doFlash; state.startedAt = new Date().toISOString(); state.finishedAt = null;
  state.firmware = { path: '', size: 0, mtime: null };
  addLog(`开始构建：唤醒词「${wake.display}」（${wake.pinyin}，阈值 ${wake.threshold}）${cfg.bridge.url ? '，桥接 ' + cfg.bridge.url : ''}${doFlash ? '，烧录 ' + port : '（仅编译）'}`);
  run(wake, cfg, doFlash, port).catch((e) => {
    state.failed = true; state.running = false; state.error = e.message;
    state.finishedAt = new Date().toISOString();
    addLog('❌ ' + e.message);
  });
  return status();
}

async function run(wake, cfg, doFlash, port) {
  // ① 工具链
  setStepProgress(0, 1);
  const det = paths.detect(cfg);
  if (!det.canBuild) {
    const miss = [];
    if (!det.srcExists) miss.push('小智源码目录');
    if (!det.esptoolExists) miss.push('esptool');
    if (!det.idfExists) miss.push('ESP-IDF 环境');
    throw new Error(`本机不具备构建条件（缺 ${miss.join('、')}）——请在装了 ESP-IDF 的电脑上操作，或按「装机向导」手动编译`);
  }
  addLog(`工具链就绪：${det.paths.srcDir}`);
  await tick();

  // ② 板级配置
  setStepProgress(1, 1);
  const append = writeBoardConfig(det, cfg);
  addLog(`config.json sdkconfig_append（${append.length} 条）：`);
  for (const l of append) addLog('  ' + l.replace(/CONFIG_WORKBENCH_BRIDGE_KEY=.*/, 'CONFIG_WORKBENCH_BRIDGE_KEY=***'));
  await tick();

  // ③ 串口芯片校验（烧录前强制；COM3 是 ESP32-C3 红绿灯板，烧错会毁掉那块板子的固件）
  if (doFlash) {
    setStepProgress(2, 0.3);
    addLog(`探测 ${port} 芯片…`);
    const probe = await probeChip(port, det);
    addLog(probe.ok ? `✓ ${probe.message}` : '✗ ' + probe.message);
    if (!probe.ok) throw new Error(probe.message);
    setStepProgress(2, 1);
  } else {
    setStepProgress(2, 1);
    addLog('跳过烧录（仅编译模式）');
  }

  // ④ 编译（build.py 自动 reconfigure → build → merge-bin；产物 build/merged-binary.bin）
  setStepProgress(3, 0.02);
  addLog('开始编译（首次需 5-15 分钟，期间会下载组件依赖）…');
  const buildCmd = `${pyPrefix(det)} cd /d "${det.paths.srcDir}" && python scripts\\build.py ${det.paths.boardTarget} --name esp32s3-korvo2-v3 --language zh-CN`;
  await runCmd(buildCmd, {
    timeoutMs: 40 * 60 * 1000,
    onLine: (l) => { const s = l.trim(); if (s && !/^\[?\d+\/\d+\]?%?$/.test(s)) addLog(s.slice(0, 200)); },
    onFrac: (f) => setStepProgress(3, f),
  });
  const bin = path.join(det.paths.srcDir, 'build', 'merged-binary.bin');
  const st = fs.statSync(bin);
  addLog(`✓ 编译完成：merged-binary.bin（${(st.size / 1048576).toFixed(1)} MB）`);

  // ⑤ 烧录（保留 WiFi 配网与设备绑定；救援场景用面板里的手动命令全片擦除）
  //
  // 绝不能写 `write-flash 0x0 merged-binary.bin`：merge-bin 出来的是一张从 0x0 起、**空洞补 0xFF**
  // 的连续镜像（实测 0x9000 nvs / 0xd000 otadata / 0xf000 phy_init 三处全 0xFF），
  // 写在 0x0 就等于把 NVS 一起写成 0xFF → 每次烧录都清掉配网与设备绑定（2026-10-03 实证）。
  // 改用 build/flash_args（IDF `idf.py flash` 的原生清单：bootloader/分区表/otadata/app/assets
  // 各自的偏移，不含 nvs），与 merged 相比只少写那片 0xFF 填充。
  if (doFlash) {
    setStepProgress(4, 0.02);
    addLog(`烧录到 ${port} @921600（约 1-2 分钟；按分区偏移写，不动 NVS）…`);
    const buildDir = path.join(det.paths.srcDir, 'build');
    const flashCmd = `${pyPrefix(det)} cd /d "${buildDir}" && python -m esptool --chip esp32s3 -p ${port} -b 921600 --before default-reset --after hard-reset write-flash "@flash_args"`;
    await runCmd(flashCmd, {
      timeoutMs: 10 * 60 * 1000,
      onFrac: (f) => setStepProgress(4, f),
    });
    addLog('✓ 烧录完成（哈希已校验，板子已自动复位重启）');
  } else {
    setStepProgress(4, 1);
  }

  // ⑥ 归档到 data 缓存（供同网其它电脑下载烧录；data/ 不入 git/升级包）
  setStepProgress(5, 0.5);
  fs.mkdirSync(det.dataFirmwareDir, { recursive: true });
  fs.copyFileSync(bin, path.join(det.dataFirmwareDir, 'merged-binary.bin'));
  state.firmware = { path: path.join(det.dataFirmwareDir, 'merged-binary.bin'), size: st.size, mtime: new Date().toISOString() };
  setStepProgress(5, 1);
  state.running = false; state.done = true;
  state.finishedAt = new Date().toISOString();
  state.progress = 100;
  addLog(`🎉 全部完成${doFlash ? `：对着板子喊「${wake.display}」试试` : '：固件已归档，可下载或稍后烧录'}`);
}

const tick = () => new Promise((r) => setTimeout(r, 150)); // 步骤间小停顿，日志好读

function status() {
  return {
    ...state, log: state.log.slice(-MAX_LOG),
    steps: STEP_DEFS.map((s, i) => ({ ...s, current: i === state.stepIndex && state.running })),
    canBuild: paths.detect(svc.getConfig()).canBuild,
    canFlash: paths.detect(svc.getConfig()).canFlash,
  };
}
function reset() {
  if (state.running) throw new Error('构建进行中，不能重置');
  state.done = false; state.failed = false; state.error = ''; state.log = [];
  state.progress = 0; state.stepIndex = 0;
}

module.exports = { start, status, reset, listPorts, probeChip, writeBoardConfig };
