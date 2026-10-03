// 本地烧录工具包（v2.0.0）：把「网页 + 烧录引擎 + 固件 + 驱动」打成一个 zip 供下载
//
// 用户在智能板/红绿灯的烧录页点「下载本地烧录工具包」，拿到一个压缩包：解压 → 双击 .cmd →
// 浏览器里选串口一键烧录（Web Serial 直接读本机 COM 口，不需要 NAS、不需要 Python）。
//
// 两个关键设计：
//   ① 固件是**定长占位符模板**（Logs/build-xiaozhi-template.mjs 编译产出），生成包时把本应用的
//      桥接地址与密钥**字节级**写进去 —— 板子拿到手就指向你这台 NAS，开箱即用，不用手工改配置。
//      替换后必须**重算 app 镜像尾部追加的 SHA-256**，否则二级 bootloader 校验不过，板子不启动。
//   ② 智能板走**分段烧录**（按 flash_args 的分区偏移逐段写），绝不写 0x9000 nvs 分区 ——
//      配网信息与设备绑定都存那里；merged-binary.bin 写 0x0 的清 nvs 是老 bug（v1.9.36 修过）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildZip } = require('./zipService');
const svc = require('./xiaozhiService');

const ROOT = path.join(__dirname, '..', 'flash-tool');
const FW_XIAOZHI = path.join(ROOT, 'firmware', 'xiaozhi');
// 红绿灯的两件固件**直接取自 server/cc-light/**（不是抄一份到 flash-tool/）：
// 那目录本来就是「Agent红绿灯」tab 的下载源，从这里读保证两边永远同一份文件，
// 不会出现「面板下载到的 main.py」和「烧录包里写进板子的 main.py」不一样的鬼故事。
const FW_CCLIGHT = path.join(__dirname, '..', 'cc-light');
const DRIVER_DIR = path.join(__dirname, '..', 'xiaozhi', 'tools', 'ch343-driver');
const VENDOR_DIR = path.join(ROOT, 'vendor');

// 智能板分段烧录清单（偏移与顺序照 D:\CC\ESP32\xiaozhi-esp32\build\flash_args；**不含** 0x9000 nvs）
const XIAOZHI_SEGMENTS = [
  { name: 'bootloader.bin', address: 0x0 },
  { name: 'partition-table.bin', address: 0x8000 },
  { name: 'ota_data_initial.bin', address: 0xd000 },
  { name: 'xiaozhi.bin', address: 0x20000 },        // ← 桥接地址/密钥的占位符在这个文件里
  { name: 'generated_assets.bin', address: 0x800000 },
];
const XIAOZHI_FLASH = { flashMode: 'dio', flashFreq: '80m', flashSize: '16MB' };
const CCLIGHT_FLASH = { flashMode: 'dio', flashFreq: '80m', flashSize: '4MB' };
const CCLIGHT_BIN = 'ESP32_GENERIC_C3-20260824-v1.29.0.bin';
const CCLIGHT_MAINPY = 'main.py';

// 固件模板里的定长占位符。**唯一定义处**：Logs/build-xiaozhi-template.mjs 从这里 import，
// 由它生成 board 的 config.template.json 再编译 —— 两边靠同一份常量对齐，不会各写各的字面量。
// 长度取宽裕值：真实桥接地址是「http://<host>:<port>/api/xiaozhi/bridge」，
// 域名/花生壳地址可能到 60~70 字节；密钥恒为 32 位 hex。留够余量，超长时 patchFixed 会直接报错而不是写坏固件。
const URL_PREFIX = 'http://wb-bridge-url-placeholder-';
const KEY_PREFIX = 'wbkey-placeholder-';
const URL_PLACEHOLDER = Buffer.from(URL_PREFIX + '0'.repeat(96 - URL_PREFIX.length), 'latin1'); // 96 字节
const KEY_PLACEHOLDER = Buffer.from(KEY_PREFIX + '0'.repeat(64 - KEY_PREFIX.length), 'latin1'); // 64 字节

const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const pad2 = (n) => String(n).padStart(2, '0');

// 板子要连回的是「**这台 NAS 上本应用的直连地址**」，不是请求 Host 的原样：
//   ① 从飞牛桌面（统一网关 /app/jarvis）进来时，Host 是 NAS 的网页地址——那个入口要求
//      带 NAS 登录态，板子的裸 HTTP 请求过不去（§6 闸门 2：无会话一律回 `invalid token`），
//      把网关地址烧进固件等于烧了个连不上的地址；
//   ② 直连端口（http://NAS:7778）进来的 Host 本来就是对的，原样用。
// 所以只对网关链路做一次「换端口」：主机名保留，端口换成本应用自己的服务端口。
// 用户仍可在智能板面板改（xiaozhi config 的 bridge.url 优先于这个默认值）。
// 本应用自己的服务端口（cmd/main 注入的 TRIM_SERVICE_PORT；本地调试走 PORT；默认 7778）
const SERVICE_PORT = String(process.env.TRIM_SERVICE_PORT || process.env.PORT || '7778');
function defaultBridgeBase(req) {
  let host = String((req && req.headers && req.headers.host) || '').trim();
  if (!host) return '';
  if (req && req.viaGateway) {
    const name = host.replace(/:\d+$/, '');            // 去掉网关端口
    if (name) host = `${name}:${SERVICE_PORT}`;        // 换成本应用端口
  }
  return `http://${host}`;
}
function bridgeUrlFor(req) {
  const base = defaultBridgeBase(req);
  return base ? `${base}/api/xiaozhi/bridge` : '';
}

// 定长字节替换：写入值 → 不足补 \0；超长直接抛（宁可报错也不能写出半截地址的固件）。
// C++ 侧是 std::string(const char*)，遇 \0 截断，所以「等长 + 补零」对运行时完全等价。
function patchFixed(buf, placeholder, value, label) {
  const pos = buf.indexOf(placeholder);
  if (pos < 0) return { buf, found: false, pos: -1 };
  if (Buffer.byteLength(value, 'utf8') > placeholder.length) {
    throw new Error(`${label} 太长（${Buffer.byteLength(value)} 字节 > ${placeholder.length} 字节），无法写进固件模板`);
  }
  const out = Buffer.from(buf);
  const seg = Buffer.alloc(placeholder.length, 0);
  seg.write(value, 0, 'utf8');
  seg.copy(out, pos);
  return { buf: out, found: true, pos };
}

// 重算 ESP-IDF app 镜像尾部追加的 SHA-256（覆盖范围 = 镜像除末尾 32 字节外的全部内容）。
// 改过一个字节就必须重算，否则 bootloader 校验失败 → 板子反复重启不进系统。
function rehashAppImage(buf) {
  const body = buf.subarray(0, buf.length - 32);
  const digest = crypto.createHash('sha256').update(body).digest();
  const out = Buffer.from(buf);
  digest.copy(out, buf.length - 32);
  return out;
}

// 把本应用的地址与密钥写进智能板 app 镜像（占位符不在时原样返回并如实汇报，绝不假装成功）
function patchXiaozhiApp(buf, { url, key }) {
  const r = { urlFound: false, keyFound: false, patched: false };
  let out = buf;
  if (url) { const a = patchFixed(out, URL_PLACEHOLDER, url, '桥接地址'); out = a.buf; r.urlFound = a.found; }
  if (key) { const b = patchFixed(out, KEY_PLACEHOLDER, key, '桥接密钥'); out = b.buf; r.keyFound = b.found; }
  r.patched = r.urlFound || r.keyFound;
  // 只有真动过字节才重算哈希（否则等于把原始镜像的哈希改坏）
  if (r.patched) out = rehashAppImage(out);
  return { buf: out, info: r };
}

// 启动脚本的编码体检。**别删这几行**——2026-10-04 实测踩过：
// serve.ps1 存成「UTF-8 无 BOM」时，Windows PowerShell 5.1 会按本地 ANSI 代码页去读它，
// 中文被误解码后会吐出多余的引号字符把语法拆散 —— 脚本不是报错，而是**把后面几行当文本原样打出来**，
// 看起来像「启动了」，其实一行都没跑。所以 PS1 必须带 UTF-8 BOM（CLAUDE.md §10 的老规矩）。
// .cmd 相反：必须**无** BOM（BOM 会被当命令打出来且破坏 @echo off），靠第二行 `chcp 65001` 转 UTF-8 读中文。
function launcherHealth(root) {
  root = root || ROOT;   // 参数只为测试能拿一份坏样本跑（见 scripts/test-flashtool-guards.mjs）
  const ps1 = path.join(root, 'serve.ps1');
  const cmd = path.join(root, '启动烧录.cmd');
  const problems = [];
  if (!exists(ps1)) problems.push('缺少 serve.ps1');
  else {
    const b = fs.readFileSync(ps1);
    if (!(b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf)) {
      problems.push('serve.ps1 缺 UTF-8 BOM（PowerShell 5.1 会按 ANSI 读，中文会拆散脚本语法）');
    }
  }
  if (!exists(cmd)) problems.push('缺少 启动烧录.cmd');
  else {
    const b = fs.readFileSync(cmd);
    if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) problems.push('启动烧录.cmd 不该带 BOM');
    const t = b.toString('latin1');
    if (!/chcp 65001/.test(t)) problems.push('启动烧录.cmd 缺 chcp 65001（中文会乱码）');
    if (/[^\r]\n/.test(t)) problems.push('启动烧录.cmd 含裸 LF 行尾（批处理可能错行）');
  }
  return { ok: problems.length === 0, problems };
}

// 固件/驱动的就绪情况（供 /flashtool/info 与面板显示）
function availability() {
  const xiaozhiFiles = XIAOZHI_SEGMENTS.map((s) => {
    const p = path.join(FW_XIAOZHI, s.name);
    const ok = exists(p);
    return { name: s.name, address: s.address, size: ok ? fs.statSync(p).size : 0, ok };
  });
  const ccBin = path.join(FW_CCLIGHT, CCLIGHT_BIN);
  const ccMain = path.join(FW_CCLIGHT, CCLIGHT_MAINPY);
  return {
    xiaozhi: { files: xiaozhiFiles, ready: xiaozhiFiles.every((f) => f.ok) },
    cclight: {
      firmware: { name: CCLIGHT_BIN, size: exists(ccBin) ? fs.statSync(ccBin).size : 0, ok: exists(ccBin) },
      program: { name: CCLIGHT_MAINPY, size: exists(ccMain) ? fs.statSync(ccMain).size : 0, ok: exists(ccMain) },
      ready: exists(ccBin) && exists(ccMain),
    },
    driver: { ok: exists(DRIVER_DIR) },
    vendor: { ok: exists(path.join(VENDOR_DIR, 'esptool-js.bundle.js')) },
    launcher: launcherHealth(),
  };
}

// 递归收集整个目录（驱动包是个多层级目录树）
function walk(dir, prefix, out) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (fs.statSync(p).isDirectory()) walk(p, rel, out);
    else out.push({ name: rel, data: fs.readFileSync(p) });
  }
  return out;
}

// 生成烧录页面用的固件清单（偏移量、芯片、flash 参数都下发，页面不写死）
function buildManifest(req, patchInfo) {
  const url = bridgeUrlFor(req);
  return {
    generatedAt: new Date().toISOString(),
    xiaozhi: {
      label: '智能板（小智 Korvo2V3）',
      chip: 'ESP32-S3',
      ...XIAOZHI_FLASH,
      files: XIAOZHI_SEGMENTS.map((s) => {
        const p = path.join(FW_XIAOZHI, s.name);
        return { name: s.name, address: s.address, addressHex: '0x' + s.address.toString(16), size: exists(p) ? fs.statSync(p).size : 0 };
      }),
      bridgeUrl: patchInfo && patchInfo.urlFound ? url : '',
      note: '分段烧录，不写 0x9000 nvs —— 配网信息与设备绑定保留',
    },
    cclight: {
      label: 'Agent 红绿灯（ESP32-C3）',
      chip: 'ESP32-C3',
      ...CCLIGHT_FLASH,
      files: [{ name: CCLIGHT_BIN, address: 0, addressHex: '0x0', size: exists(path.join(FW_CCLIGHT, CCLIGHT_BIN)) ? fs.statSync(path.join(FW_CCLIGHT, CCLIGHT_BIN)).size : 0 }],
      mainPy: CCLIGHT_MAINPY,
      mainPySize: exists(path.join(FW_CCLIGHT, CCLIGHT_MAINPY)) ? fs.statSync(path.join(FW_CCLIGHT, CCLIGHT_MAINPY)).size : 0,
    },
  };
}

// ---------- 打整包 ----------
// 一个包同时能烧两个设备（用户要的就是「下载一个包，都能分别烧」）。
// 中文目录名：本包 zip 用 UTF-8 文件名标志（0x0800），Windows 资源管理器/7-Zip 都能正确显示。
function buildPackage(req) {
  const av = availability();
  if (!av.xiaozhi.ready && !av.cclight.ready) throw new Error('固件文件缺失，无法生成烧录包');
  // 启动脚本编码不对 = 用户双击后看着「启动了」其实什么都没跑（见 launcherHealth 注释）。
  // 这属于「打出来的包是废的」，宁可不给下载也不发出去。
  if (!av.launcher.ok) throw new Error('启动脚本编码不对，无法生成烧录包：' + av.launcher.problems.join('；'));

  const entries = [];
  const root = 'JARVIS烧录工具包/';
  const addFile = (abs, rel) => { if (exists(abs)) entries.push({ name: root + rel, data: fs.readFileSync(abs) }); };

  // ① 网页本体 + 启动脚本
  for (const f of ['index.html', 'app.js', 'serve.ps1', 'README.txt']) addFile(path.join(ROOT, f), f);
  // 启动入口用中文名（用户要双击的就是它）
  const cmdPath = path.join(ROOT, '启动烧录.cmd');
  if (exists(cmdPath)) entries.push({ name: root + '启动烧录.cmd', data: fs.readFileSync(cmdPath) });

  // ② 烧录引擎（esptool-js，Apache-2.0；依赖已内联，运行期不访问外网）
  addFile(path.join(VENDOR_DIR, 'esptool-js.bundle.js'), 'vendor/esptool-js.bundle.js');
  addFile(path.join(VENDOR_DIR, 'esptool-js.LICENSE.txt'), 'vendor/esptool-js.LICENSE.txt');

  // ③ 固件：智能板 5 段（app 镜像现场注入本应用的地址与密钥）+ 红绿灯 2 件
  const patchInfo = { urlFound: false, keyFound: false, patched: false };
  const key = svc.ensureBridgeKey();
  const url = bridgeUrlFor(req);
  for (const s of XIAOZHI_SEGMENTS) {
    const p = path.join(FW_XIAOZHI, s.name);
    if (!exists(p)) continue;
    let data = fs.readFileSync(p);
    if (s.name === 'xiaozhi.bin') {
      const r = patchXiaozhiApp(data, { url, key });
      data = r.buf;
      Object.assign(patchInfo, r.info);
      // 自检：写进去的地址必须能在镜像里读到，否则这包烧完板子连不回来（宁可不给下载）
      if (patchInfo.urlFound && !data.includes(Buffer.from(url, 'utf8'))) throw new Error('固件地址注入自检失败');
    }
    entries.push({ name: root + 'firmware/xiaozhi/' + s.name, data });
  }
  addFile(path.join(FW_CCLIGHT, CCLIGHT_BIN), 'firmware/cclight/' + CCLIGHT_BIN);
  addFile(path.join(FW_CCLIGHT, CCLIGHT_MAINPY), 'firmware/cclight/' + CCLIGHT_MAINPY);

  // ④ 固件清单（页面读它拿偏移/芯片/flash 参数，不写死）
  entries.push({ name: root + 'firmware/manifest.json', data: JSON.stringify(buildManifest(req, patchInfo), null, 2) });

  // ⑤ CH343 串口驱动整目录（智能板第一次插电脑要装）
  if (av.driver.ok) {
    const drv = [];
    walk(DRIVER_DIR, 'ch343-driver', drv);
    for (const f of drv) entries.push({ name: root + 'driver/' + f.name, data: f.data });
  }

  return { zip: buildZip(entries), patchInfo, entries: entries.length };
}

// 包文件名：带日期，避免用户下过好几版分不清
function packageFileName() {
  const d = new Date();
  return `JARVIS烧录工具包-${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}.zip`;
}

module.exports = {
  availability, buildPackage, buildManifest, packageFileName,
  launcherHealth,
  bridgeUrlFor, defaultBridgeBase, patchXiaozhiApp,
  XIAOZHI_SEGMENTS, CCLIGHT_BIN, CCLIGHT_MAINPY, ROOT,
  // 供编译脚本生成 board config.template.json（见 Logs/build-xiaozhi-template.mjs）
  PLACEHOLDERS: { url: URL_PLACEHOLDER.toString('latin1'), key: KEY_PLACEHOLDER.toString('latin1') },
  URL_PLACEHOLDER, KEY_PLACEHOLDER,
  rehashAppImage,
};
