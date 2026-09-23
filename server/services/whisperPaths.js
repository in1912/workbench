// Whisper 引擎路径统一解析（whisperService 与 whisperInstaller 共用）。
// 引擎三件套：whisper-cli 原生二进制（whisper.cpp 编译产物）+ 1 个 ggml 模型 + Node sidecar。
// 优先级：WHISPER_ROOT 环境变量 > 持久目录 dataDir/whisper（安装器目标）> server/whisper（升级包随附，本地开发手工放置）。
// 二进制随升级包分发在 server/whisper/<plat>-<arch>/（server/ 前缀天然过升级应用白名单——
// 独立 whisper/ 顶层前缀会被旧容器的白名单跳过，v1.5.0 的 vibeasr/ 踩过同款鸡生蛋）；模型只装一次在持久目录。
const fs = require('fs');
const path = require('path');
const os = require('os');
const { dataDir } = require('../db');

const DATA_WHISPER = path.join(dataDir, 'whisper');
const PROJECT_WHISPER = path.join(__dirname, '..', 'whisper'); // server/whisper（sidecar 与随包二进制都在这）

// 各平台二进制名（whisper.cpp 无官方预编译：Windows=MinGW-w64 构建，Linux=zig musl 静态交叉编译）
// 目录名用 win 而不是 process.platform 的原生值 win32（与 vibeasr/win-x64 命名一致）
const PLAT_DIR = process.platform === 'win32' ? 'win' : process.platform;
const BIN_NAME = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
const SHIPPED_BIN_DIR = path.join(PROJECT_WHISPER, PLAT_DIR + '-' + process.arch);
const SHIPPED_BIN = path.join(SHIPPED_BIN_DIR, BIN_NAME);

// 模型：openai/whisper-large-v3-turbo 的 whisper.cpp 转换量化版（ggerganov/whisper.cpp，hf-mirror 可达）。
// 选 q8_0 不选 q5_0：q5_0 不在 ggml online-repack 优化名单里走慢速标量路径（实测同段音频 49s vs 36s），q8_0 更快更准。
const MODEL_FILE = 'ggml-large-v3-turbo-q8_0.bin';
const MODEL_URL = 'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/' + MODEL_FILE;
const MODEL_SIZE = 834 * 1024 * 1024;   // 期望大小（完整性下限用 700MB）

function detectRoot() {
  if (process.env.WHISPER_ROOT) return process.env.WHISPER_ROOT;
  // 持久目录里已有二进制+模型（安装过）则优先；否则项目目录（本地开发手工放置）
  const marks = [path.join('bin', BIN_NAME), path.join('models', MODEL_FILE)];
  if (marks.every((m) => fs.existsSync(path.join(DATA_WHISPER, m)))) return DATA_WHISPER;
  if (marks.every((m) => fs.existsSync(path.join(PROJECT_WHISPER, m)))) return PROJECT_WHISPER;
  return DATA_WHISPER; // 未安装：返回目标目录（安装器往这里装）
}

const ROOT = detectRoot();

const paths = {
  DATA_WHISPER,
  PROJECT_WHISPER,
  SHIPPED_BIN_DIR,
  SHIPPED_BIN,
  ROOT,
  BIN: path.join(ROOT, 'bin', BIN_NAME),
  BIN_DIR: path.join(ROOT, 'bin'),
  MODELS_DIR: path.join(ROOT, 'models'),
  MODEL: path.join(ROOT, 'models', MODEL_FILE),
  // sidecar 脚本随升级包分发（server/ 在升级应用范围内），不拷贝到数据目录
  SIDECAR: path.join(__dirname, '..', 'whisper', 'server.js'),
  PORT: Number(process.env.WHISPER_PORT) || 9655,
  THREADS: Math.max(2, Math.min(8, (os.cpus()?.length || 4) - 1)),
  MODEL_FILE, MODEL_URL, MODEL_SIZE,
  // 引擎是否齐备（二进制 + 模型）
  engineReady: () => [paths.BIN, paths.MODEL].every((p) => fs.existsSync(p)),
};

module.exports = paths;
