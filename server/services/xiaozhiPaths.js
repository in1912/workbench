// 智能板（小智 Korvo2V3）路径与能力探测（v1.9.11）
// 参照 vibeasrPaths/whisperPaths 三件套模式：探测本机是否具备「编译固件 + 烧录」的完整工具链，
// NAS/Docker 等不具备的环境自动降级为「纯文档 + 工具下载」模式。
// 路径优先级：settings 配置（智能板 tab 可改） > 环境变量 > 默认开发机路径。
const fs = require('fs');
const path = require('path');

// 默认路径（Windows 开发机实测布局）；非 Windows 或未安装时 detect() 相应返回 false
const DEFAULTS = {
  // 小智固件源码（xiaozhi-esp32 v2.5+，含 scripts/build.py 与板级 config.json）
  srcDir: process.env.XIAOZHI_SRC || 'D:\\CC\\ESP32\\xiaozhi-esp32',
  // ESP-IDF 工具链根（IDF_TOOLS_PATH）
  idfToolsPath: process.env.IDF_TOOLS_PATH || 'C:\\Espressif',
  // esptool（idf python env 内）
  esptool: process.env.XIAOZHI_ESPTOOL || 'C:\\Espressif\\python_env\\idf6.1_py3.10_env\\Scripts\\esptool.exe',
  // ESP-IDF 6.1 export 脚本（构建前激活环境用；.bat 供 cmd /c 一次执行）
  idfExportBat: process.env.XIAOZHI_EXPORT || 'C:\\Espressif\\frameworks\\esp-idf-v6.1\\export.bat',
  // 板级构建目标（build.py 参数）
  boardTarget: 'espressif/esp32-s3-korvo-2-v3.0',
  // 默认串口（CH343 桥接；烧录前会用 esptool flash-id 校验芯片，防烧错别的板子）
  serialPort: 'COM4',
};

const exists = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };

// 探测结果（全部同步 fs.existsSync，路由层每次请求调用也开销极小）
// cfg 为智能板 tab 保存的路径覆盖（settings.xiaozhi_config 的 paths 段）
function detect(cfg) {
  const p = { ...DEFAULTS, ...((cfg || {}).paths || {}) };
  const boardConfig = path.join(p.srcDir, 'main', 'boards', ...p.boardTarget.split('/'), 'config.json');
  const buildPy = path.join(p.srcDir, 'scripts', 'build.py');
  const buildBin = path.join(p.srcDir, 'build', 'merged-binary.bin');
  // 固件缓存目录（构建成功后复制，供同网其它电脑下载烧录；data/ 不入 git/升级包）
  const dataFirmwareDir = path.join(__dirname, '..', '..', 'data', 'xiaozhi', 'firmware');
  const cachedBin = path.join(dataFirmwareDir, 'merged-binary.bin');
  const srcOk = exists(buildPy) && exists(boardConfig);
  return {
    platform: process.platform,
    isWindows: process.platform === 'win32',
    // 完整链路（可改唤醒词重编译）：源码 + esptool + IDF 环境齐备
    canBuild: srcOk && exists(p.esptool) && exists(p.idfExportBat),
    canFlash: srcOk && exists(p.esptool) && process.platform === 'win32',
    paths: p,
    srcExists: srcOk,
    boardConfig,
    esptoolExists: exists(p.esptool),
    idfExists: exists(p.idfExportBat),
    // 固件产物：优先 data 缓存，其次源码 build 目录
    firmware: firmwareInfo(cachedBin, buildBin),
    dataFirmwareDir,
  };
}

// 固件产物信息（cachedBin 优先——即使源码目录被移走，缓存仍可供下载）
function firmwareInfo(cachedBin, buildBin) {
  const out = { available: false, path: '', size: 0, mtime: null };
  for (const p of [cachedBin, buildBin]) {
    try {
      const st = fs.statSync(p);
      if (st.isFile() && st.size > 1024 * 1024) { // 合并镜像必然 >1MB，防误认残片
        return { available: true, path: p, size: st.size, mtime: st.mtime.toISOString() };
      }
    } catch { /* 不存在看下一个 */ }
  }
  return out;
}

module.exports = { DEFAULTS, detect, firmwareInfo };
