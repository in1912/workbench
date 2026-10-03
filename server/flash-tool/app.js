// 智能家居烧录工具 · 页面逻辑（v2.0.0）
//
// 两件事：
//   ① 智能板 ESP32-S3：按分区偏移分段烧 5 个 bin（dio/80m/16MB），**绝不写 0x9000 nvs**，
//      所以配网信息与设备绑定保留（这正是 v1.9.36 修的破坏性 bug：merged-binary 直接写 0x0 会清 nvs）。
//   ② 红绿灯 ESP32-C3：先擦除 + 烧 MicroPython 固件，再用 raw-paste 协议把 main.py 写进板子文件系统。
//
// 浏览器 API：Web Serial（navigator.serial）——只在 Edge/Chrome 有，且只在安全上下文开放；
// http://127.0.0.1 算安全上下文，file:// 不算，这就是本包必须起本地服务器的原因（见 serve.ps1）。
import { ESPLoader, Transport } from './vendor/esptool-js.bundle.js';

const $ = (id) => document.getElementById(id);
const logEl = $('log');

function log(msg, cls = '') {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = `[${t}] ${msg}`;
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function banner(kind, html) {
  const b = $('banner');
  b.className = 'show ' + kind;
  b.innerHTML = html;
}

function setStatus(which, text, cls = '') {
  const el = $('st-' + which);
  el.className = 'status ' + cls;
  el.textContent = text;
}
function setBar(which, frac) {
  $('bar-' + which).style.width = Math.max(0, Math.min(100, Math.round(frac * 100))) + '%';
}

// esptool-js 的 terminal 接口（至少要有 clean/writeLine/write）
const term = {
  clean: () => {},
  writeLine: (d) => { if (d) log('[esptool] ' + String(d).trim(), 'd'); },
  write: (d) => { if (d && String(d).trim()) log('[esptool] ' + String(d).trim(), 'd'); },
};

const decoder = new TextDecoder();
let manifest = null;

// ---------- 固件清单 ----------
async function loadManifest() {
  const res = await fetch('./firmware/manifest.json', { cache: 'no-store' });
  if (!res.ok) throw new Error('固件清单读取失败 (HTTP ' + res.status + ')');
  manifest = await res.json();
  renderManifest();
}

const fmtMB = (n) => (n / 1048576).toFixed(2) + ' MB';

function renderManifest() {
  const xz = manifest.xiaozhi, cc = manifest.cclight;
  const xzTotal = xz.files.reduce((m, f) => m + f.size, 0);
  $('fw-xiaozhi').innerHTML =
    `固件包：<b>${xz.files.length} 个分区文件</b>（共 ${fmtMB(xzTotal)}） · Flash：<b>${xz.flashSize}</b> · ${xz.flashMode}/${xz.flashFreq}<br>` +
    (xz.bridgeUrl
      ? `板子将连回：<code>${xz.bridgeUrl}</code>`
      : `<span style="color:#f4b740">⚠ 这份固件没有内置回连地址，烧完需要在板子配网页面手动填服务地址</span>`);
  $('fw-cclight').innerHTML =
    `MicroPython 固件：<b>${cc.files[0].name}</b>（${fmtMB(cc.files[0].size)}） · Flash：<b>${cc.flashSize}</b> · ${cc.flashMode}/${cc.flashFreq}<br>` +
    `程序文件：<b>${cc.mainPy}</b>（${fmtMB(cc.mainPySize)}）—— 会一并写进板子`;
}

async function readFileAsBinaryString(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`读取 ${path} 失败 (HTTP ${res.status})`);
  const buf = new Uint8Array(await res.arrayBuffer());
  // esptool-js 的 fileArray[].data 要「二进制字符串」而非 ArrayBuffer/Base64
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < buf.length; i += CH) s += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
  return { str: s, size: buf.length };
}

// ---------- 串口选择 ----------
// 每个卡片各自持有一个已选串口；烧完断开后仍保留引用（红绿灯要复用它写 main.py）
const state = {
  xiaozhi: { port: null, busy: false, needProgram: false },
  cclight: { port: null, busy: false, needProgram: false },
};

async function pickPort(which) {
  if (!navigator.serial) {
    banner('bad', '当前浏览器不支持网页读串口（Web Serial）。请用 <b>Microsoft Edge</b> 或 <b>Google Chrome</b> 打开本页。');
    return;
  }
  try {
    const port = await navigator.serial.requestPort();
    state[which].port = port;
    const info = port.getInfo ? port.getInfo() : {};
    const vidpid = info.usbVendorId
      ? `（USB ${info.usbVendorId.toString(16).padStart(4, '0')}:${(info.usbProductId || 0).toString(16).padStart(4, '0')}）`
      : '';
    setStatus(which, '已选择串口' + vidpid + '，可以开始烧录了', 'ok');
    log(`${which === 'xiaozhi' ? '智能板' : '红绿灯'}：已选择串口 ${vidpid}`);
    syncButtons(which);
  } catch (e) {
    if (e && e.name === 'NotFoundError') { log('取消了串口选择'); return; }
    log('选择串口失败：' + e.message, 'e');
  }
}

function syncButtons(which) {
  const s = state[which];
  const flash = $(which === 'xiaozhi' ? 'btn-xz-flash' : 'btn-cc-flash');
  flash.disabled = s.busy || !s.port;
  if (which === 'cclight') flash.textContent = s.needProgram ? '③ 继续写入程序' : '② 一键烧录';
}

async function openLoader(which, baudrate) {
  const s = state[which];
  await s.port.open({ baudRate: baudrate });
  const transport = new Transport(s.port, true);
  const loader = new ESPLoader({ transport, baudrate, terminal: term });
  return { transport, loader };
}

// ---------- 智能板（ESP32-S3）----------
async function flashXiaozhi() {
  const s = state.xiaozhi;
  if (!s.port || s.busy) return;
  s.busy = true; syncButtons('xiaozhi');
  setBar('xiaozhi', 0);
  let transport = null;
  try {
    const cfg = manifest.xiaozhi;
    setStatus('xiaozhi', '正在连接板子…');
    const opened = await openLoader('xiaozhi', 921600);
    transport = opened.transport;
    const chip = await opened.loader.main();
    const chipName = opened.loader.chip ? opened.loader.chip.CHIP_NAME : String(chip);
    log('检测到芯片：' + chipName, 'ok');

    // 防烧错板：同一条线也可能插着红绿灯（ESP32-C3），芯片不对直接停
    if (!/ESP32-S3/i.test(chipName)) {
      throw new Error(`芯片是 ${chipName}，不是智能板用的 ESP32-S3。请确认选对了串口（红绿灯请用右边那张卡片）。`);
    }

    const files = [];
    let done = 0;
    const totalBytes = cfg.files.reduce((m, f) => m + f.size, 0);
    for (const f of cfg.files) {
      const { str } = await readFileAsBinaryString('./firmware/xiaozhi/' + f.name);
      files.push({ data: str, address: f.address });
      log(`载入 ${f.name}（${fmtMB(f.size)} @ ${f.addressHex}）`);
    }

    setStatus('xiaozhi', '正在烧录…（请勿拔线）');
    await opened.loader.writeFlash({
      fileArray: files,
      flashMode: cfg.flashMode,
      flashFreq: cfg.flashFreq,
      flashSize: cfg.flashSize,
      eraseAll: false,        // 关键：不清整片 Flash，nvs（配网/绑定）保留
      compress: true,
      reportProgress: (idx, written, total) => {
        const cur = total || cfg.files[idx].size;
        const frac = (done + Math.min(written, cur)) / totalBytes;
        setBar('xiaozhi', frac);
        setStatus('xiaozhi', `正在烧录… ${Math.round(frac * 100)}%（第 ${idx + 1}/${files.length} 段）`);
        if (written >= cur) done += cur;
      },
    });
    setBar('xiaozhi', 1);
    try { await opened.loader.after('hard_reset'); } catch (e) { log('复位指令无响应（一般不影响）：' + e.message, 'd'); }
    setStatus('xiaozhi', '✅ 烧录完成，板子已重启', 'ok');
    log('智能板烧录完成。', 'ok');
    log('提示：配网信息与设备绑定未被清除。若板子换了网络，长按唤醒后按提示重新配网即可。', 'd');
  } catch (e) {
    setStatus('xiaozhi', '❌ ' + humanError(e), 'err');
    log('烧录失败：' + (e && e.message ? e.message : e), 'e');
  } finally {
    try { if (transport) await transport.disconnect(); } catch {}
    s.busy = false; syncButtons('xiaozhi');
  }
}

// ---------- 红绿灯（ESP32-C3）：刷固件 + 写 main.py ----------
async function flashCclight() {
  const s = state.cclight;
  if (!s.port || s.busy) return;
  s.busy = true; syncButtons('cclight');
  try {
    if (s.needProgram) return await writeProgram();
    return await flashMicropython();
  } finally {
    s.busy = false; syncButtons('cclight');
  }
}

async function flashMicropython() {
  const s = state.cclight;
  const cfg = manifest.cclight;
  setBar('cclight', 0);
  let transport = null;
  try {
    setStatus('cclight', '正在连接板子…');
    const opened = await openLoader('cclight', 921600);
    transport = opened.transport;
    const chip = await opened.loader.main();
    const chipName = opened.loader.chip ? opened.loader.chip.CHIP_NAME : String(chip);
    log('检测到芯片：' + chipName, 'ok');
    if (!/ESP32-C3/i.test(chipName)) {
      throw new Error(`芯片是 ${chipName}，不是红绿灯用的 ESP32-C3。请确认选对了串口（智能板请用左边那张卡片）。`);
    }

    const f = cfg.files[0];
    const { str } = await readFileAsBinaryString('./firmware/cclight/' + f.name);
    log(`载入 ${f.name}（${fmtMB(f.size)}）`);

    setStatus('cclight', '正在擦除整片 Flash…（约 10 秒）');
    await opened.loader.eraseFlash();
    setBar('cclight', 0.15);

    setStatus('cclight', '正在写入 MicroPython 固件…（请勿拔线）');
    await opened.loader.writeFlash({
      fileArray: [{ data: str, address: f.address }],
      flashMode: cfg.flashMode,
      flashFreq: cfg.flashFreq,
      flashSize: cfg.flashSize,
      eraseAll: false,   // 上面已单独擦除
      compress: true,
      reportProgress: (idx, written, total) => {
        const cur = total || f.size;
        setBar('cclight', 0.15 + 0.6 * Math.min(1, written / cur));
        setStatus('cclight', `正在写入 MicroPython 固件… ${Math.round(Math.min(1, written / cur) * 100)}%`);
      },
    });
    setBar('cclight', 0.78);
    try { await opened.loader.after('hard_reset'); } catch (e) { log('复位指令无响应（一般不影响）：' + e.message, 'd'); }
    log('MicroPython 固件写入完成。', 'ok');
  } catch (e) {
    setStatus('cclight', '❌ ' + humanError(e), 'err');
    log('烧录失败：' + (e && e.message ? e.message : e), 'e');
    return;
  } finally {
    try { if (transport) await transport.disconnect(); } catch {}
  }
  // 固件阶段成功：接着写程序文件（板子重启会换一个 USB 设备，多半要重新选口）
  s.needProgram = true;
  $('hint-cc').style.display = 'block';
  setStatus('cclight', '固件已烧好，还差最后一步：重新选串口后点「③ 继续写入程序」', 'warn');
  log('等待重新选择串口，以继续写入 main.py', 'd');
  s.port = null;   // 强制重新选择
  syncButtons('cclight');
}

// raw-paste 协议写文件（MicroPython 官方 mpremote / pyboard.py 用的同一套）
// 比「一条条 raw REPL 命令 + base64」快得多，且带流控，不会因为板子缓冲区满而丢字节。
async function writeProgram() {
  const s = state.cclight;
  const cfg = manifest.cclight;
  const mainPy = new TextEncoder().encode(await (await fetch('./firmware/cclight/' + cfg.mainPy, { cache: 'no-store' })).text());
  let port = s.port;
  try {
    setStatus('cclight', '正在连接板子…');
    await port.open({ baudRate: 115200 });
    const reader = port.readable.getReader();
    const writer = port.writable.getWriter();

    // 有界读：把已到达的字节收集起来，够 len 就返回（超时则抛错）
    const readExact = async (len, timeoutMs = 8000) => {
      const out = new Uint8Array(len);
      let got = 0;
      const deadline = Date.now() + timeoutMs;
      while (got < len) {
        const remain = deadline - Date.now();
        if (remain <= 0) throw new Error('等待板子响应超时——请确认板子已插好、串口选的是同一个');
        const race = await Promise.race([
          reader.read(),
          new Promise((r) => setTimeout(() => r({ timeout: true }), remain)),
        ]);
        if (race.timeout) continue;
        if (race.done) throw new Error('串口已关闭');
        const chunk = race.value;
        for (let i = 0; i < chunk.length && got < len; i++) out[got++] = chunk[i];
      }
      return out;
    };
    const readUntil = async (needle, timeoutMs = 8000) => {
      const buf = [];
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const c = await readExact(1, deadline - Date.now());
        buf.push(c[0]);
        if (buf.length >= needle.length && needle.every((b, i) => buf[buf.length - needle.length + i] === b)) {
          return new Uint8Array(buf).slice(0, buf.length - needle.length);
        }
      }
      throw new Error('等待板子响应超时');
    };
    const write = (bytes) => writer.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));

    log('正在进入板子的 Python 交互模式…');
    await write([0x03, 0x03]);            // Ctrl-C x2：打断可能正在跑的 main.py
    await new Promise((r) => setTimeout(r, 200));
    await write([0x0d, 0x01]);            // 回车 + Ctrl-A：进 raw REPL
    await readUntil(new TextEncoder().encode('raw REPL; CTRL-B to exit\r\n>'), 6000);
    log('已进入 raw REPL', 'ok');

    // 进入 raw-paste 模式（带窗口流控），把「打开文件 + 分块 base64 写入 + 关闭 + 软复位」一段脚本整体写进去
    await write([0x05, 0x41, 0x01]);      // Ctrl-E + 期望窗口 0x41,0x01
    const hdr = await readExact(2, 6000);
    if (hdr[0] !== 0x52 || hdr[1] !== 0x00) throw new Error('板子没有进入 raw-paste 模式（可能不是 MicroPython 固件）');
    await write([0x01]);
    const wz = await readExact(2, 6000);
    const window = (wz[0] << 7) | (wz[1] + 1);
    log(`raw-paste 窗口：${window} 字节`);

    const b64 = toBase64(mainPy);
    const script = [
      "import ubinascii",
      "f=open('main.py','wb')",
      ...chunkStr(`f.write(ubinascii.a2b_base64('${b64}'))`, 4000),
      "f.close()",
      "import machine",
      "machine.reset()",
      '',
    ].join('\n');
    const payload = new TextEncoder().encode(script);

    let sent = 0;
    while (sent < payload.length) {
      if (window === 1) throw new Error('板子缓冲区太小，无法继续');
      const chunk = payload.subarray(sent, sent + window);
      sent += chunk.length;
      await write(chunk);
      const ack = await readExact(1, 8000);
      if (ack[0] !== 0x01) throw new Error('板子写入流控应答异常（0x' + ack[0].toString(16) + '）');
      setBar('cclight', 0.78 + 0.22 * (sent / payload.length));
      setStatus('cclight', `正在写入程序文件… ${Math.round((sent / payload.length) * 100)}%`);
    }
    log(`main.py 已写入（${mainPy.length} 字节，base64 ${payload.length} 字节分块发送）`, 'ok');

    await new Promise((r) => setTimeout(r, 1200));
    try { reader.releaseLock(); } catch {}
    try { writer.releaseLock(); } catch {}
    setBar('cclight', 1);
    setStatus('cclight', '✅ 全部完成！板子已自动重启并运行程序', 'ok');
    $('hint-cc').style.display = 'none';
    s.needProgram = false;
    log('红绿灯烧录完成：固件 + main.py 都已就位。', 'ok');
  } catch (e) {
    setStatus('cclight', '❌ ' + humanError(e), 'err');
    log('写入程序失败：' + (e && e.message ? e.message : e), 'e');
    log('兜底方案：本机装了 Python 时，可用 mpremote 手动写入 —— mpremote connect <COM口> fs cp main.py :main.py', 'd');
  } finally {
    try { if (port.readable || port.writable) await port.close(); } catch {}
  }
}

// base64（分块，避免大文件时 apply 参数超限）
function toBase64(u8) {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}
// 把长语句按不破坏语法的边界切成多条（MicroPython 单行有长度上限）
function chunkStr(line, max) {
  if (line.length <= max) return [line];
  const out = [];
  const m = /^f\.write\(ubinascii\.a2b_base64\('(.*)'\)\)$/.exec(line);
  const data = m ? m[1] : '';
  const step = max - 40;
  for (let i = 0; i < data.length; i += step) {
    out.push(`f.write(ubinascii.a2b_base64('${data.slice(i, i + step)}'))`);
  }
  return out;
}

function humanError(e) {
  const m = e && e.message ? e.message : String(e);
  if (/Failed to connect|no serial data received|Timed out/i.test(m)) {
    return '连不上板子。请检查：① 数据线是不是只能充电的线 ② 板子是否已上电 ③ 串口是否被其它软件（串口助手/Arduino IDE）占用 ④ 试试点住板子上的 BOOT 键再点烧录';
  }
  if (/Access denied|Failed to open/i.test(m)) return '串口被占用了。关掉其它用串口的软件（串口助手、Arduino IDE、设备管理器以外的工具）再试。';
  return m;
}

// ---------- 启动 ----------
(async function init() {
  if (!navigator.serial) {
    banner('bad', '当前浏览器不支持「网页读串口」（Web Serial API）。<br>请改用 <b>Microsoft Edge</b> 或 <b>Google Chrome</b> 打开本页 —— Firefox、Safari、以及各种「兼容 IE」的浏览器都不行。');
  } else if (!window.isSecureContext) {
    banner('bad', '当前页面不是安全上下文，浏览器不会开放串口。请通过启动脚本打开 http://127.0.0.1 地址，不要直接双击 index.html。');
  } else {
    banner('good', '✅ 浏览器已就绪（支持网页读串口）。插好板子 → 选串口 → 开始烧录。');
  }
  try {
    await loadManifest();
    log('固件清单已载入', 'ok');
  } catch (e) {
    log('固件清单载入失败：' + e.message, 'e');
    $('fw-xiaozhi').textContent = '固件清单读取失败，请确认整个压缩包已完整解压。';
    $('fw-cclight').textContent = '固件清单读取失败，请确认整个压缩包已完整解压。';
  }
  $('btn-xz-port').onclick = () => pickPort('xiaozhi');
  $('btn-xz-flash').onclick = flashXiaozhi;
  $('btn-cc-port').onclick = () => pickPort('cclight');
  $('btn-cc-flash').onclick = flashCclight;
  syncButtons('xiaozhi'); syncButtons('cclight');
})();
