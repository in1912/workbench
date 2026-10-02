#!/bin/bash
# 全能工作台 · macOS 启动器
# 用法：双击本文件（首次可能需要在「系统设置 → 隐私与安全性」里允许运行），
#      或在终端里执行  chmod +x start.command && ./start.command
cd "$(dirname "$0")" || exit 1

echo "=========================================="
echo "  全能工作台"
echo "=========================================="

# ---- 检查 Node.js ----
if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 没有找到 Node.js。"
  echo "       请先安装 Node.js 22 LTS：https://nodejs.org"
  echo "       或使用 Homebrew：brew install node"
  echo
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

NODE_MAJOR=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "[错误] 需要 Node.js 22.5 或更高版本，当前是 $(node -v)。"
  echo "       请到 https://nodejs.org 下载新版。"
  echo
  read -n 1 -s -r -p "按任意键关闭…"
  exit 1
fi

# ---- 依赖 ----
if [ ! -d node_modules ]; then
  echo "首次运行：正在安装依赖，请稍候…"
  npm install --no-audit --no-fund || { echo "[错误] 依赖安装失败，请检查网络。"; read -n 1 -s -r -p "按任意键关闭…"; exit 1; }
fi

if [ ! -d web/dist ]; then
  echo "[提示] 缺少前端构建产物 web/dist。"
  echo "       如果你拿到的是源码包，请先执行：npm run build:web"
fi

echo
echo "  启动地址：http://localhost:3000"
echo "  默认账号：admin / admin123（登录后请在「设置」里改掉）"
echo "  停止服务：在本窗口按 Control + C"
echo
node --no-warnings server/index.js

echo
echo "服务已停止。"
read -n 1 -s -r -p "按任意键关闭窗口…"
