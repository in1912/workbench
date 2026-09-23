// VibeASR BitNet 引擎路径统一解析（vibeasrService 与 vibeasrInstaller 共用）。
// 引擎三件套：asr_stream_server 原生二进制（VibeASR.cpp 编译产物）+ 2 个 GGUF 模型 + Node sidecar。
// 优先级：VIBEASR_ROOT 环境变量 > 持久目录 dataDir/vibeasr（安装器目标）> 项目 vibeasr/（本地开发手工放置）。
// 二进制随升级包分发（vibeasr/win-x64/ 在升级应用范围内）；模型只装一次在持久目录，升级不重下。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { dataDir } = require('../db');

const DATA_VIBEASR = path.join(dataDir, 'vibeasr');
const PROJECT_VIBEASR = path.join(__dirname, '..', '..', 'vibeasr');

// 各平台二进制名（VibeASR.cpp 无官方预编译；Windows 用 MinGW-w64 构建，Linux 容器内构建）
const BIN_NAME = process.platform === 'win32' ? 'asr_stream_server.exe' : 'asr_stream_server';
const SHIPPED_BIN_DIR = path.join(PROJECT_VIBEASR, process.platform + '-' + process.arch);
const SHIPPED_BIN = path.join(SHIPPED_BIN_DIR, BIN_NAME);
// 客户端部署包固定发 Windows 引擎（setup 是 PS1/BAT）：不随服务器平台走——
// Linux 生产容器上 SHIPPED_BIN_DIR=linux-x64（自身引擎源码编译用），下发仍取 win-x64。
const SHIPPED_WIN_DIR = path.join(PROJECT_VIBEASR, 'win-x64');
const SHIPPED_WIN_EXE = path.join(SHIPPED_WIN_DIR, 'asr_stream_server.exe');

// 模型文件（microsoft/VibeVoice-ASR-BitNet 的 GGUF 量化版，hf-mirror 可达）
const MODEL_FILES = {
  vae: 'vibeasr-vae-encoder-i8_s.gguf',   // VAE 编码器 i8_s 量化 703MB
  lm: 'vibeasr-lm-i2_s-embed-q6_k.gguf',  // 语言模型 i2_s 量化 993MB
};
const MODEL_URL_BASE = 'https://hf-mirror.com/microsoft/VibeVoice-ASR-BitNet/resolve/main/';

function detectRoot() {
  if (process.env.VIBEASR_ROOT) return process.env.VIBEASR_ROOT;
  // 持久目录里已有二进制+模型（安装过）则优先；否则项目目录（本地开发手工放置）
  const marks = [path.join('bin', BIN_NAME), path.join('models', MODEL_FILES.lm)];
  if (marks.every((m) => fs.existsSync(path.join(DATA_VIBEASR, m)))) return DATA_VIBEASR;
  if (marks.every((m) => fs.existsSync(path.join(PROJECT_VIBEASR, m)))) return PROJECT_VIBEASR;
  return DATA_VIBEASR; // 未安装：返回目标目录（安装器往这里装）
}

const ROOT = detectRoot();

const paths = {
  DATA_VIBEASR,
  PROJECT_VIBEASR,
  SHIPPED_BIN_DIR,
  SHIPPED_BIN,
  SHIPPED_WIN_DIR,
  SHIPPED_WIN_EXE,
  ROOT,
  BIN: path.join(ROOT, 'bin', BIN_NAME),
  BIN_DIR: path.join(ROOT, 'bin'),
  MODELS_DIR: path.join(ROOT, 'models'),
  VAE: path.join(ROOT, 'models', MODEL_FILES.vae),
  LM: path.join(ROOT, 'models', MODEL_FILES.lm),
  // sidecar 脚本随升级包分发（server/ 在升级应用范围内），不拷贝到数据目录
  SIDECAR: path.join(__dirname, '..', 'vibeasr', 'server.js'),
  PORT: Number(process.env.VIBEASR_PORT) || 9650,
  THREADS: Math.max(2, Math.min(8, (os.cpus()?.length || 4) - 1)),
  MODEL_FILES,
  MODEL_URL_BASE,
  // 引擎是否齐备（二进制 + 双模型）
  engineReady: () => [paths.BIN, paths.VAE, paths.LM].every((p) => fs.existsSync(p)),
};

module.exports = paths;
