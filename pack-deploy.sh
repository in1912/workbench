#!/bin/bash
# 个人工作台 · Docker 部署打包脚本
# 用法：
#   1) 本机执行  bash pack-deploy.sh  生成 workbench-deploy.tar.gz（含源码 + 数据，不含 node_modules）
#   2) 把 tar 包上传到服务器/群晖，解压后进入目录执行  docker compose up -d --build
#   3) 容器已配置 restart: always，开机自动启动；数据在 ./data 卷中持久化
set -e
cd "$(dirname "$0")"

OUT="workbench-deploy.tar.gz"
echo "== 打包部署包（源码 + data 数据目录） =="

# 排除项：依赖目录、构建产物、历史备份文件
tar --exclude='./node_modules' \
    --exclude='./web/node_modules' \
    --exclude='./web/dist' \
    --exclude='./data/*.old*' \
    --exclude='./data/*.bak*' \
    --exclude='./data/*.test-backup*' \
    --exclude='./data/archive' \
    --exclude='./data/qg-2*.sqlite' \
    --exclude='./workbench-deploy.tar.gz' \
    -czf "$OUT" \
    Dockerfile docker-compose.yml package.json package-lock.json .dockerignore README.md \
    server scripts web package.json web/package.json web/vite.config.js web/index.html web/src start.bat data

echo "== 完成：$OUT =="
echo "服务器上执行："
echo "  tar xzf workbench-deploy.tar.gz && cd workbench-deploy && docker compose up -d --build"
echo "（容器 restart: always，开机自动运行；首次启动会自动从 data/ 历史库迁移数据）"
