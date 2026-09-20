// TTS 引擎路径统一解析（ttsService 与 ttsInstaller 共用）
// 优先级：TTS_ROOT 环境变量 > 持久卷（Docker 的 /data/tts，容器重建不丢）> 项目 tts/（本地开发已装好）
// 安装器（ttsInstaller）始终把引擎装进 dataDir/tts；装完后需重启进程让本模块重新解析。
const fs = require('fs');
const path = require('path');
const { dataDir } = require('../db');

const DATA_TTS = path.join(dataDir, 'tts');
const PROJECT_TTS = path.join(__dirname, '..', '..', 'tts');

function detectRoot() {
  if (process.env.TTS_ROOT) return process.env.TTS_ROOT;
  // 持久卷里已有引擎（安装过）则优先；否则用项目目录里现成的（本地开发）
  const marks = ['py', '.venv', path.join('MOSS-TTS-Nano', 'onnx_tts_runtime.py')];
  if (marks.some((m) => fs.existsSync(path.join(DATA_TTS, m)))) return DATA_TTS;
  return PROJECT_TTS;
}

const TTS_ROOT = detectRoot();

// 解释器位置随安装方式而异：一键安装器装的是 Miniconda（Windows <root>/py/python.exe、
// Linux <root>/py/bin/python）；本地开发用 uv venv（.venv/Scripts|bin）
function findPython(root) {
  return [
    path.join('py', 'python.exe'),        // Miniconda（Windows）
    path.join('py', 'bin', 'python'),    // Miniconda（Linux）
    path.join('.venv', 'Scripts', 'python.exe'), // uv venv（Windows）
    path.join('.venv', 'bin', 'python'),        // uv venv（Linux）
  ].map((p) => path.join(root, p))
    .find((p) => fs.existsSync(p) && fs.statSync(p).isFile()) || '';
}

module.exports = {
  DATA_TTS,
  PROJECT_TTS,
  TTS_ROOT,
  PY: findPython(TTS_ROOT),
  // 引擎入口随升级包分发（server/ 在升级应用范围内）；运行时根目录由 MOSS_TTS_ROOT 传入
  SERVER: path.join(__dirname, '..', 'tts', 'moss_server.py'),
  REPO: path.join(TTS_ROOT, 'MOSS-TTS-Nano'),
  VOICES_DIR: path.join(TTS_ROOT, 'voices'),   // 成员上传的参考音频
  CACHE_DIR: path.join(TTS_ROOT, 'cache'),     // 合成缓存（按 音色+文本 哈希）
  findPython,
};
