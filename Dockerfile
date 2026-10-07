# ---------- 阶段 1：构建前端 ----------
FROM node:22-alpine AS web-builder
WORKDIR /build/web
COPY web/package.json ./
RUN npm install --registry=https://registry.npmmirror.com
COPY web/ ./
RUN npm run build

# ---------- 阶段 2：后端运行环境 ----------
# 使用 node:sqlite 内置模块，无需原生编译依赖
# 含 Playwright + Chromium：浏览器自动化（业务系统 Skill）随镜像打包，迁移即自带
FROM node:22-slim AS runner
WORKDIR /app

# Chromium 运行所需的系统库 + 中文字体（BI 仪表盘中文渲染）
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
    libasound2 libatspi2.0-0 fonts-wqy-zenhei \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com
# 安装 Chromium（Linux 版，打进镜像；国内镜像加速）
ENV PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright
RUN npx playwright install chromium

COPY server/ ./server/
COPY --from=web-builder /build/web/dist ./web/dist

# 运行时还需要的东西（原来漏了——镜像里没有它们时，测评中心 H5、录音转写页、智作平台全都缺）
COPY web/index.html web/vite.config.js ./web/
COPY web/src/ ./web/src/
# 测评中心 H5 等运行时静态资源
COPY web/public/ ./web/public/
# 服务端/客户端辅助脚本（对外分发的 .ps1/.cmd 从这里取）
COPY scripts/ ./scripts/
# 语音配音：脚本与空 voices（模型权重由页面一键安装器按需下载）
COPY tts/ ./tts/
# 独立转写引擎客户端（linux/win 预编译）
COPY vibeasr/ ./vibeasr/
# 智作平台子应用
COPY zhizu/ ./zhizu/

ENV PORT=3000
ENV DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 3000
CMD ["node", "--no-warnings", "server/index.js"]
