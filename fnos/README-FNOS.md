# 全能工作台 · 飞牛 fnOS 应用版（v1.9.0）

把 [personal-workbench](https://github.com/in1912/personal-workbench)（自托管家庭/个人效率中枢，13 个模块）打包成飞牛 fnOS 应用（.fpk）：应用中心安装、桌面图标直达、**NAS 账号免登**（统一网关）、数据持久化在 `@appdata`，同时保留 **7777 端口局域网直连**。

## 安装（二选一）

**方式 A · 应用中心手动安装（推荐）**
1. 飞牛 fnOS 桌面 → **应用中心** → 手动安装（本地安装）
2. 选择 `qgworkbench-1.9.0.fpk`，按向导走：
   - 初始管理员用户名/密码（仅首次建库生效，默认 `admin` / `admin123`，登录后请立即修改）
   - NAS 普通成员首次免登自动开号的默认权限（推荐「开放全部页面」，之后可在应用内逐人收紧）
3. 安装时会自动拉起 `nodejs_v22` 运行时依赖；等待端口就绪后桌面出现「全能工作台」图标

**方式 B · appcenter-cli（SSH 命令行）**
```bash
appcenter-cli install ./qgworkbench-1.9.0.fpk
```

## 两种入口

| 入口 | 地址 | 登录方式 |
|---|---|---|
| fnOS 桌面图标 / 统一网关 | `https://你的NAS域名/app/qgworkbench` | **NAS 账号免登**：网关校验 NAS 登录态并注入可信用户头，工作台按用户名自动开号（NAS 管理员→工作台 admin，普通成员→user） |
| 局域网直连 | `http://NAS内网IP:7777` | 工作台自己的账号密码（初始 admin/admin123） |

> 安全设计：免登只认 fnOS 统一网关（Unix Socket）转发来的请求；直连 7777 端口伪造 `X-Trim-*` 头无效（`仅飞牛 fnOS 网关入口可用`）。

## 数据与目录

| 内容 | 位置 |
|---|---|
| 数据库/上传/证书等全部数据 | `@appdata/qgworkbench/data/`（`/var/apps/qgworkbench/var/data`，升级不丢） |
| 运行日志 | `@appdata/qgworkbench/logs/server.log` |
| 初始配置（向导生成） | `@appconf/qgworkbench/workbench.env` |
| 应用文件 | `@appcenter/qgworkbench/target/` |

备份 = 拷贝 `@appdata/qgworkbench/`；从其他部署迁移 = 把旧 `workbench.sqlite`（及 `tenant-*.sqlite`）放进上述 `data/` 目录再启动。

## 升级 / 卸载

- 升级：应用中心安装新版 .fpk（数据在 `@appdata`，不受影响）
- 卸载：应用中心卸载；数据目录按 fnOS 提示处理（应用自身不主动删数据）

## 已知限制（Linux/NAS 环境）

- 「语音配音」TTS 引擎与「电脑监控/剪贴板采集」的 Windows 客户端不适用（页面功能仍在，客户端需 Windows 机器）
- 「推送任务」的 Playwright 浏览器自动化未随包内置浏览器内核（其余推送通道正常）
- 录音转写本地引擎模型未随包（可后续在应用内按需下载，或继续用客户端引擎）

## 开发者：从源码构建 .fpk

```bash
# 仓库根目录
npm run build:web                       # 出最新前端产物
node fnos/build-fpk.mjs                 # 装配应用包目录（可用 --node-modules 指定现成生产依赖）
fnpack build --directory workbench-fnos-build/qgworkbench   # 官方 CLI 打出 .fpk
```

网关适配源码：`server/index.js`（前缀挂载 + Unix Socket）、`server/routes/authRoutes.js`（`/auth/fnos-login` 免登开号）、`web/src/api/index.js`（API 前缀自适应）、`web/src/views/Login.vue`（网关静默免登）。
