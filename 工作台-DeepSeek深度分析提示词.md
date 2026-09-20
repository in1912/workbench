# 个人工作台 · DeepSeek 深度分析提示词

> 本文档由 **DeepSeek 分析** 生成。
> 分析对象：`D:\CC\personal-workbench`（自托管家庭/个人效率中枢，端口 3000）
> 分析时间：2026-09-06
> 说明：本文档为**只读分析产物**，未修改任何项目文件；仅作为对该系统的一次纵深解读与"提示词级"能力梳理。

---

## 0. 一句话定位

一个**单机自托管、局域网多成员共用、以"家庭日常运转"为核心场景**的效率中枢：把记账、待办、家庭共享、视频学习、练琴、打字赚零花、电子宠物、AI 助手、业务系统自动化、钉钉/飞书推送等 20+ 模块，塞进"一个 Express 进程 + 一组 SQLite 文件 + 一套 Vue3 前端"里，并用**多租户数据库隔离 + 页面/Tab 两级授权**解决"一家人共用一台设备、各看各的数据"的问题。

它不是玩具。从代码看，这是**长期迭代、针对真实家庭使用**打磨出来的系统（版本号已到 v1.2.10+，有金蝶云星空自动化、花生壳 PATCH 穿透补丁、钉钉 Stream 长连接、HTTPS/HTTP 同端口嗅探这类"踩过真实坑才写得出来"的细节）。

---

## 1. 技术栈与工程形态

| 维度 | 实现 |
|---|---|
| 前端 | Vue 3 + Vite（hash 路由、`<script setup>`），构建产物输出到 `web/dist/<时间戳>/` |
| 后端 | Express 4，单进程，入口 `server/index.js`（175 行） |
| 数据库 | **`node:sqlite`**（Node 22 内置 SQLite，非 better-sqlite3），单文件多库 |
| 任务调度 | `node-cron`（时区固定 `Asia/Shanghai`） |
| 邮件 | `imapflow`（IMAP 拉取）+ 内置 SMTP 发送 |
| 浏览器自动化 | `playwright` + Chromium（headless，业务系统取数） |
| 推送 | `dingtalk-stream`（钉钉 Stream 长连接）+ 飞书 HTTP 机器人 + 通用 webhook |
| 新闻 | `rss-parser` + Tavily 主动搜索（Agent 补充） |
| 语音 | MOSS-TTS-Nano 本地离线引擎（Python 子进程，`moss_server.py`） |
| 其他 | `multer`（上传）、`marked`（markdown）、Node 内置 `crypto`/`net`/`https` |

**部署**：Docker（`node:22-alpine` 编译前端 → `node:22-slim` 运行时 + Chromium 系统库 + 中文字体），`docker-compose.yml` 挂 `./data:/data`，`restart: always`，容器名 `quan-ge-workbench`。

---

## 2. 核心架构：多租户数据库模型（最重要的一条）

这是理解整个系统的钥匙。数据分两层：

### 2.1 主库（`workbench.sqlite` / Docker 下 `qg-final.sqlite`）

存放**全局/账号/共享**数据，只有一份：

- `users`、`sessions`（会话，7 天有效）、`upgrade_logs`
- `share_config`（模块共享开关）
- `messages`、`message_images`（站内消息 + 图片）
- `family_*`（家庭共享数据，见下）
- `pets` / `pet_*`、`typing_days`、`typing_payouts`、`tts_voices`
- `vstudy_*`、`piano_records`、`wish_*`、`credit_records`、`user_prefs`

### 2.2 租户库（`tenant-<uid>.sqlite`）

**每个真实用户一个独立 SQLite 文件**，存放该用户"私有/可隔离"的数据（待办、笔记、邮箱配置、学习记录、业务系统、AI 配置、账单等）。首次访问时惰性创建，并自动 seed 支付分类。

### 2.3 数据路由开关（`share_config` / `SHARE_MODULES`）

关键函数 `routedDb(tdb, flag)` / `routedSettingDb(tdb, flag)`：

- 某模块被管理员设为"**共享**" → 数据走主库，全家一份；
- 设为"**独立**" → 数据走各自租户库，每人一份。

可配置共享/独立的模块（`SHARE_MODULES`）：`news`、`holiday`、`amap_key`、`ai_config`、`family`。典型例子：新闻共享时，主库抓一次、展示时按每个成员自己的城市过滤；独立时各租户各抓各源各城市。

> 这一层"共享 vs 隔离"是**运行时动态决定**的，不是写死的分库，是整个系统"一人一套数据、又想全家共享"需求的落地。

---

## 3. 认证与权限模型

### 3.1 认证
- 密码 `scrypt + 随机盐` 哈希，`timingSafeEqual` 比对，绝不存明文。
- Bearer Token 会话（7 天），`<img>`/`<audio>` 等无法带头的场景回退 `?token=` 查询参数。
- 默认管理员 `admin / 123456`（可环境变量覆盖），**统计真实用户时排除 `is_bot=1` 的虚拟 `dingtalk_bot` 成员**。
- 钉钉"免登"：authCode → userid → 绑定账号。

### 3.2 授权：页面级 + Tab 级（两级）

- **页面级**：`PAGES` 数组（dashboard/search/news/email/notes/tasks/family/learning/tools/business/ai/files/pay/pets/settings），每个 API 路径经 `pageForPath()` 映射到某页，用户 `allowed_pages` 控制整页开关。**`allowed_pages` 为空数组 = 全开放**（家庭场景默认全家可见）。
- **Tab 级**：`TAB_PATHS` 定义每页内的 tab → 路径前缀映射；路径前缀以 `=` 开头表示"仅全等匹配"（如 `=/pets` 只拦截 `POST /pets` 领养，不误伤 `/pets/state` 等共享端点）。
- **受限 Tab（`RESTRICTED_TABS`）**：`payout`（兑现登记）、`wishset`（心愿卡设置）、`pianoconfirm`（练琴有效时长确认）、`vsettings`（视频教学设置）——这些涉及"真金白银 / 家长权限 / 全家配置"，**默认对所有人关闭（admin 除外）**，即使页面全开放也必须在用户管理里显式勾选。
- **admin 全局 bypass**。

> 亮点：`canAccess()` 里明确处理了一个反直觉 case——"`allowed_pages` 为空 = 全开时，残留的 tab 配置**不得**暗中收紧"。这是权限模型里很容易踩的坑，作者用一行注释钉死了语义。

---

## 4. 模块全景（按页面/功能域）

### 4.1 首页看板（dashboard）
总览聚合、布局自定义（`dashboard/layout`）、导航顺序。

### 4.2 新闻（news）
- 三类源：科技/生活/本地。默认 RSS 源（IT之家、少数派、InfoQ、Solidot、中国新闻网系）。
- **乱码检测** `isGarbled()`：GBK 源被错误解码后中文字符占比骤降 + 冷门码点区占比升高 → 丢弃该条。
- **Agent 主动搜索**：Tavily（免费 key）先搜真实新闻，RSS 补充，两者合并去重（按 url），只要中文标题。**AI 不编造新闻**。
- 本地新闻按"城市 OR 省份"过滤（`PROVINCE_OF` 映射表）。

### 4.3 邮箱（email）
- IMAP 拉取（`imapflow`），本地分页文件夹列表，已读/移动/删除，SMTP 发送、草稿、签名、附件、通讯录（`contacts`）。
- 定时巡检：每 5 分钟，各租户按自己 `refresh_minutes` 决定是否到点；垃圾箱每日 + 每周日定时清理。

### 4.4 待办与日程（tasks）
- 待办（todos）、日程（events，支持共享给成员 + 通知）、每日默认待办模板（06:00 自动复制）。
- 日程钉钉提醒：开始前 15 分钟推送，每分钟巡检。

### 4.5 家庭共享（family）
家人档案（`family-profiles`）、子女任务（kids / kid-tasks）、富文本（`sanitizeRich` 消毒）、家庭图床（base64/磁盘存储）、农历/节气（`lunar`，含转换接口）。

### 4.6 学习（learning）
- **学习计划/记录/复盘**（已移到"效率工具"页）。
- **视频教学（vstudy）**：NAS 目录懒加载树浏览、HTTP `Range`/206 流式播放、进度上报、注意力检测惩罚、学时流水（≥90% 完成才算，300 秒中段累积）、路径穿越防护 `resolveInRoot`。
- **打字赚钱（typing）**：20 秒心跳上报、赚钱日历（净字数 = 正确 − 3×错误，+ 视频学时 + 练琴有效时长）、费率配置、兑现登记（1 天删除窗口）、赊账（credit，负金额 + 结清）。
- **练琴（piano）**：浏览器录音/录像上传、缩略图、流式播放（Range）、有效时长确认（受限 tab）、文件清理。
- **心愿卡（wish）**：商品 + 打卡（每日限 2 次、每商品 1 次）、多图管理、设置受限。
- **语音合成（tts）**：MOSS-TTS-Nano 本地引擎一键安装（长任务）、音色库、参考音频、听写（dictation）。

### 4.7 电子宠物（pets）
虚拟宠物养成：喂食/喝水/玩耍/喂药/铲屎动作，**便便生成/生病/饥饿惩罚/死亡**机制（`refreshPet` 惰性推进，有挽联文案），成员分配、打卡、GIF 上传、互动打字。

### 4.8 业务系统 + Skills（business）—— 系统里最有"工程感"的部分
- **业务系统**：保存第三方系统 URL + 凭证，密码用 **AES-256-GCM 可逆加密**（`v1:iv:tag:data`，密钥来自 `WORKBENCH_SECRET`，兼容旧明文）。
- **Skill**：引导词（触发词）+ 提示词 + 可选 cron。执行时取数 → 交给 DeepSeek 提炼 → 存 `skill_pushes` + 飞书推送。
- **两种取数通道**：
  1. **HTTP API 代理**：Bearer 或 Basic 认证（密码解密后拼 Base64），30s 超时，结果截断 20000 字。
  2. **Playwright 浏览器自动化**（`browser_recipe` JSON）：`loginUrl/login{selectors}/postLoginUrl/actions[]/extract{type}`。extract 支持 `tableFiltered`（抽取"指定列为空"的行 + 底栏）、`tableRows`（前 N 行指定列）、`html`/`text`。
  - 还内置 **金蝶云星空销售出库单列表** 全流程脚本（`custom: 'kingdee_sale_list'`）：切账号选项卡 → 切数据中心 → 登录 → 处理下线/地址变更弹窗 → 点菜单 → 过滤"所有组织" → 抓表格。这是**为真实客户定制的、几百行的浏览器自动化**，说明系统已被用于对接实际 ERP。
- **探针（probe）**：启发式登录 + dump 登录页/首页结构（输入框/按钮/表格/关键词元素）+ 截图，供人工/AI 据此写配方。
- **Skill 定时任务按租户分桶**（`Map<uid, jobs[]>`），任一租户改动 → 全量重注册。
- 飞书推送：群触发词轮询（30s），命中引导词执行 Skill 并回推（原生表格，最多 18 行）。

### 4.9 AI 助手（ai）
- OpenAI 兼容（默认 DeepSeek），SSE 流式、`reasoning_effort: 'low'`、`max_tokens 4096`。
- **多租户 AI 配置**（共享 → 主库；独立 → 租户库）。
- `chat()`：408/429/5xx 及超时**自动重试一次**（1.5s）；推理模型 `content` 为空时回退 `reasoning_content`，仍空则报错而非静默存空。
- **视觉识别（vision）**：独立视觉模型配置（`vision_model/vision_base_url/vision_api_key`），未配置回落主模型；识别"图片→文字"；对"文本模型不支持 image_url"的报错给出明确指引。
- 能力：总结（summarize）、合同/文本审查（review）、账单分类（classify-ai）、余额查询、会话历史、附件。

### 4.10 支付记账（pay）
支付宝 CSV 导入（**GB18030 编码**）、AI 分类（分组）、账单 CRUD、分类、固定支出、周期、看板（自然月 + 周期月）、排行（月/季/年）、预算、预算对比、AI 分析。

### 4.11 文件存档（files）
上传/解析（`fileTextService`/`pdfOcrService`）/下载/删除，支持 PDF OCR。

### 4.12 消息（messages）
站内消息（联系人/未读/会话/发送/已读），与钉钉机器人消息打通（见下）。

### 4.13 钉钉（dingtalk）
- **Stream 长连接**（官方 SDK）：群 @机器人 → 进站内"短消息 → 钉钉"。
- **单聊按发件人路由**：`senderStaffId` 在各成员租户库的"钉钉推送"绑定里匹配 → 消息进 TA 自己的信箱（此前全进管理员，作者修过这个串台 bug）。
- **回复通道三级**：① 本人会话 `sessionWebhook`（约 2h 有效）→ ② 企业机器人单发 `oToMessages/batchSend` → ③ 群 `groupMessages/send`。
- **图片魔数嗅探**（PNG/JPEG/GIF/WEBP/BMP），下载码双字段兼容（`pictureDownloadCode`/`downloadCode`），msgId 去重 + inflight 去重防钉钉重推，图片先 ack、后台落库、失败降级文字提示。
- **robotCode 自动学习**：新版机器人 `robotCode ≠ AppKey`，从真实报文中学习回写配置。
- 工作通知推送（`asyncsend_v2`）、图片推送、扫码绑定、免登。

### 4.14 飞书（feishu）
配置、会话列表、测试、群触发词轮询、原生表格推送。

### 4.15 通用推送（pushes）
推送记录汇总（Skill 结果落地 `skill_pushes`）。

### 4.16 节假日/日历（holidays/calendar）
中国节日日历、农历/节气、信用卡账单日提醒。公共数据**仅需登录**，不绑页面权限（修过"没开文件权限的成员日历上节假日消失"的 bug）。

### 4.17 HTTPS / SSL
**HTTP/HTTPS 同端口自适应**（`index.js`）：前置 `net` 服务嗅探首字节 `0x16`（TLS 握手）→ 转发到内部 https 或 http 端口。自签名证书放 `data/ssl/`（升级/重建容器不丢）。证书状态/生成/下载/上传替换/重启，到期前 30 天每天 09:23 给管理员发站内提醒。

### 4.18 升级管理（upgrade）
sha256 基线扫描 → zip 打包（manifest.json + UPGRADE.md + 前端 dist 快照）→ web 应用 → 自动重启。支持"常规包（不含 node_modules）"与"完整包（含新增依赖）"之分。

### 4.19 其他细节
- **地图**：Esri 瓦片代理 + 缓存，静态地图（`mapWorker` 子进程）、高德 key。
- **通勤**：高德算路，各租户刷新时刻取并集注册 cron。
- **天气**：天气 + 地理编码。
- **剪贴板/链接**：轻量收藏。
- **全局搜索**：跨笔记/待办/家庭/子女/学习/剪贴板/新闻/邮件/AI/文件的 LIKE 联合检索。

---

## 5. 调度任务时间线（`scheduler.js`）

| 时刻 | 任务 |
|---|---|
| 启动时 | 清理 AI 空回复；补跑当日默认待办；重注册 Skill 定时任务；启动钉钉长连接 |
| 每 30 秒 | 飞书群触发词轮询 |
| 每 1 分钟 | 日程钉钉提醒巡检（开始前 15 分钟推送） |
| 每 5 分钟 | 邮箱拉取巡检（各租户按自配间隔） |
| 每天 06:00 | 生成今日默认待办（逐租户） |
| 每天 08:00 | 抓取三类新闻（共享→主库一次；独立→逐租户） |
| 每天 09:23 | SSL 证书到期检查（到期前 30 天提醒管理员） |
| 每天 03:30 | 邮件垃圾箱清理 |
| 每周日 21:00 | 清理 90 天前旧新闻 + 邮件垃圾箱 |
| 通勤 | 按各租户 `refresh_times` 并集注册 |
| Skill cron | 按租户分桶注册，任一改动全量重注册 |

---

## 6. 数据表清单（关键表）

**主库**：`users`、`sessions`、`upgrade_logs`、`share_config`、`messages`、`message_images`、`family_*`（共享）、`pets`、`pet_*`、`typing_days`、`typing_payouts`、`tts_voices`、`vstudy_*`、`piano_records`、`wish_*`、`credit_records`、`user_prefs`、`news`（共享时）、`ai_config`（共享时）。

**租户库**：`BUSINESS_DDL`（业务系统 + Skill 相关表）、`todos`、`notes`、`emails`、`email_config`、`learning_*`、`clipboard`、`links`、`bills`、`pay_categories`、`news`（独立时）、`ai_config`（独立时）等。

**迁移体系**：`addCol` 幂等加列；`migrateToMultiTenant`（27 张 TENANT_TABLES 拷贝到管理员租户库）；`cleanupMainBusinessTables`；历史 DB 自动导入（`setImmediate`）；`migratePushIntoBusiness`、`migrateTypingIntoLearning`、`migrateFamilyShare`/`rebalanceFamilyShare`（5 张 FAMILY_TABLES 镜像拷贝）。

---

## 7. API 面（Express 路由挂载）

12 个路由模块挂 `/api`：

`authRoutes`（登录/登出/用户/共享配置）、`core`（总览/笔记/待办/日程/家庭/学习/剪贴板/链接/搜索）、`misc`（最大，1353 行：新闻/天气/邮件/业务/AI/地图/通勤/推送/飞书/钉钉/日程/节假日/消息/文件等）、`payRoutes`、`upgradeRoutes`、`petRoutes`、`typingRoutes`、`ttsRoutes`、`vstudyRoutes`、`pianoRoutes`、`wishRoutes`、`sslRoutes`。

**全局中间件**：
- JSON body 上限 12MB（家庭图床 base64）。
- **PUT + `X-HTTP-Method: PATCH` 头 → 还原为 PATCH**（花生壳 HTTP 映射会掐掉 PATCH）。
- **`Connection: close`**（花生壳中转杀连接，客户端复用死套接字 → 阵发 `failed to fetch`）。
- 全局认证 + 页面/Tab 权限校验 + 注入 `req.tdb`。

---

## 8. 部署与运维要点

- Docker 一键起：`3000:3000`，`DATA_DIR=/data`，`DB_FILE=qg-final.sqlite`，数据卷持久化。
- 自签名 HTTPS 证书可分发到各设备信任导入。
- 升级：web 应用 zip → 覆盖 `server/`、`web/dist/`、`tts/` → 自动重启。
- 日志：诊断日志写 `Logs/latest.json`，**不含 API key/令牌/完整对话内容**。
- Playwright/Chromium 需在容器内 `npx playwright install chromium`。

---

## 9. DeepSeek 角度的观察与结论

1. **架构成熟度远超"家庭玩具"**：多租户分库 + 共享开关 + 页面/Tab 两级权限，是一套**真实多用户生产系统**的设计，而非 demo。

2. **大量"踩坑修复"痕迹是最大资产**：花生壳 PATCH 穿透、`Connection: close` 防死套接字、钉钉 robotCode 自动学习、图片双下载码兼容、新闻 GBK 乱码检测、`allowed_pages` 为空时 tab 不收紧——这些注释背后都是真实线上故障，是拿钱买不到的工程经验。

3. **AI 深度嵌入业务，而非贴皮**：AI 不只是聊天框，而是贯穿了新闻（Agent 搜索）、账单（分类/分析）、业务系统（Skill 提炼）、文件（PDF OCR）、视觉（图片转文字）五条主线，且都做了"内容为空报错""不支持 image_url 给指引""408/429 重试"这类健壮性处理。

4. **自动化是隐藏主线**：Playwright 浏览器配方 + cron 分桶 + 飞书/钉钉双通道推送，让这个"家庭工作台"实际上已经具备**轻量 RPA + 定时报表推送**能力，金蝶云星空脚本证明它已对接真实 ERP。

5. **克制与一致性**：密码只做 scrypt 单向哈希、凭证做 AES-GCM 可逆加密、日志脱敏、图片魔数嗅探、路径穿越防护——安全习惯贯穿始终。

6. **潜在观察点**（非缺陷，仅提示后续分析可关注）：单进程单文件多库在用户数增长后的并发上限；`Connection: close` 的握手开销；Playwright 依赖的系统库体积；租户库随用户数线性增长的备份策略。

---

## 10. 可作为"提示词"复用的部分

本文档本身即可作为后续对该系统做**二次开发 / 重构 / 迁移 / 安全审计 / 文档补全**时的上下文提示词。若要让 DeepSeek（或任意 LLM）继续在其上工作，建议开篇注入：

> 你正在分析/修改一个自托管的家庭效率中枢（Vue3 + Express 4 + node:sqlite）。核心要点：① 多租户——主库 `workbench.sqlite` + 每用户 `tenant-<uid>.sqlite`，`routedDb(tdb, flag)` 按 `share_config` 决定共享/隔离；② 权限——页面级 `PAGES` + Tab 级 `TAB_PATHS`，受限 tab `RESTRICTED_TABS` 默认关闭；③ 单进程入口 `server/index.js`，12 个路由模块 + `server/services/*` 服务层；④ 全局中间件做了 PUT→PATCH 还原与 `Connection: close`（花生壳穿透兼容），勿移除；⑤ 所有定时任务在 `server/scheduler.js`（时区 Asia/Shanghai），Skill cron 按租户分桶；⑥ 凭证：密码 scrypt 单向哈希，业务系统密码 AES-256-GCM 可逆加密。请先阅读 `server/db.js`、`server/auth.js`、`server/index.js` 三个文件再动手。
