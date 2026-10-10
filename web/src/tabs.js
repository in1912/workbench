// 页内 tab 级授权（与后端 auth.js TAB_PATHS 的 tab key 一一对应）
// 授权语义：allowed_tabs 里该页的键不存在 = 该页全部 tab 开放；存在数组 = 只开放列出的 tab（空数组=都不开）
export const TAB_DEFS = {
  // 人生管理系统（v1.10.0）：与后端 auth.js TAB_PATHS.life 的键一一对应，顺序即 tab 栏顺序。
  // 今日排第一：原文的「每天从这里出发，又反哺到这里」。
  life: [
    { key: 'today', label: '今日' },
    { key: 'goals', label: '目标' },
    { key: 'actions', label: '行动' },
    { key: 'habits', label: '习惯' },
    { key: 'reviews', label: '复盘与SOP' },
    // AI复盘IM（v1.10.29）：复盘页之后——按 IM 归档文件夹让 AI 整理概要/重点/待办，
    // 待办可勾选落成行动（日=次日、周=+7、双周=+14、月=+30 截止）
    { key: 'aimreview', label: 'AI复盘IM' },
    { key: 'projects', label: '项目' },
    { key: 'domains', label: '领域' },
    { key: 'graph', label: '关系' },
    // 知识地图（v1.11.0）：一句话目标 → AI 生成技能树（周期/程度/成本 + 带元数据的学习资源），
    // 五种展示风格（思维导图/向上生长/金字塔/左右扩展/放射环状），右栏知识交集可跳回已有笔记/邮件/新闻/IM 记录
    { key: 'km', label: '知识地图' },
    // 使用流程（v1.10.1）：放最后——它是说明书，不是每天要点的页
    { key: 'guide', label: '使用流程' },
  ],
  tasks: [
    { key: 'cal', label: '日历' },
    { key: 'todo', label: '待办事项' },
  ],
  email: [
    // v1.7.0 多邮箱：各邮箱账号 tab + 通讯录 + 邮箱设置（账号 tab 统一挂 'mail' 权限）
    { key: 'mail', label: '收发邮件' },
    { key: 'contacts', label: '通讯录' },
    { key: 'esettings', label: '邮箱设置' },
  ],
  family: [
    { key: 'family', label: '通知' },
    { key: 'kids', label: '子女学习' },
    { key: 'profiles', label: '家庭人员档案' },
    // 儿童故事（v1.9.36）：导入/AI 生成 → 文字转音频 → 板子或手机听
    { key: 'story', label: '儿童故事' },
    // 个人账务从独立页并入（2026-09 v1.7.0），作为「家庭管理」最后一个 tab（内含 5 个子 tab）
    { key: 'pay', label: '个人账务' },
    // 隐藏伪 tab：个人账务内部的子功能细分（不出现在家庭页 tab 栏，权限表可勾选限制）
    { key: 'dash', label: '账务看板', hidden: true },
    { key: 'cats', label: '科目设置', hidden: true },
    { key: 'import', label: '账单导入', hidden: true },
    { key: 'bills', label: '账单流水', hidden: true },
    { key: 'budget', label: '预算', hidden: true },
  ],
  learning: [
    { key: 'dictation', label: '听写' },
    { key: 'vstudy', label: '视频教学' },
    { key: 'vledger', label: '学时记账' },
    { key: 'vsettings', label: '视频教学设置', restricted: true },
    { key: 'vlog', label: '视频学习记录' },
    // 打字赚钱 4 个 tab 并入（2026-09 v1.2.0）：开始练习→打字、打字记录→记录、赚钱日历、兑现登记
    { key: 'practice', label: '打字' },
    { key: 'records', label: '记录' },
    { key: 'money', label: '赚钱日历' },
    { key: 'payout', label: '兑现登记', restricted: true },
    { key: 'piano', label: '练琴' },
    { key: 'wish', label: '心愿卡' },
    // 隐藏伪 tab：不出现在页内 tab 栏，但权限表里可勾选（对应受限子功能）
    { key: 'pianoconfirm', label: '练琴确认', restricted: true, hidden: true },
    { key: 'wishset', label: '心愿卡设置', restricted: true, hidden: true },
  ],
  // 业务系统改名「推送任务」并入效率工具（2026-09 v1.7.0）；tab 键不变（sys/skill/push/config）
  // 个人账务（原独立页）→ family 页 tab；此处不再有独立 business/pay 页定义
  // v1.8.0：「私有项目」页（dep/pro/mbti 三大测试中心）整体移除，迁至独立项目 Private_Mini
  tools: [
    // 录音转写（v1.10.10，需求⑨）：从第二个挪到**第一个**，并且是本页默认落点。
    // 用户原话：「效率工具默认进入后显示录音转写，录音转写放在第一个 tab 页」。
    { key: 'vibe', label: '录音转写' },
    // 智作平台（文案库，2026-09 v1.6.2）：iframe 嵌入同源 /zhizu/，自带登录与角色体系
    { key: 'zhizu', label: '智作平台' },
    { key: 'clip', label: '剪贴板' },
    { key: 'links', label: '快捷启动' },
    // v1.10.10（需求⑨）：「学习计划 / 学习记录 / 复盘」三个 tab 按用户要求**整块去掉**
    //（plans / records / review）。后端 /learning/plans、/learning/records、/reviews 端点与
    // learning_plans / learning_records / reviews 三张表都**原样保留**，只是不再有入口。
    // 电脑监控（v1.3.5）
    { key: 'monitor', label: '电脑监控' },
    // 语音配音从「学习」页移来（2026-09 v1.6.5）
    { key: 'tts', label: '语音配音' },
    // 电子宠物（v1.10.10，需求⑨）：原独立侧栏页整体并入本页。
    // 页内的「我的宠物 / 领养 / 打卡 / 养育记录 / 设置与预览 / 宠物分配」六个子 tab 仍是
    // PetsPanel 自己的 tab 栏（与「推送任务」「个人账务」同一套嵌法），这里只占**一个**外层 tab。
    // 权限键就一个 'pets'：后端 TAB_PATHS.tools 里 ['pets', ['/pets']] 一网打尽整个 /api/pets。
    { key: 'pets', label: '电子宠物' },
    // 业务系统整页并入，改名「推送任务」（2026-09 v1.7.0，内含 4 个子 tab）
    { key: 'business', label: '推送任务' },
    // 隐藏伪 tab：推送任务内部的子功能细分（不出现在效率工具 tab 栏，权限表可勾选限制）
    { key: 'sys', label: '业务系统', hidden: true },
    { key: 'skill', label: 'Skill 任务', hidden: true },
    { key: 'push', label: '推送记录', hidden: true },
    { key: 'config', label: '定时配置', hidden: true },
    // AI 脱敏（v1.13.0）：给其他页面调用的能力中心——规则配置 / 原理说明 / 试运行 / 脱敏历史。
    // 后端 TAB_PATHS.tools 的 'desens' 键 = /api/desensitize（IM复盘、笔记AI 的接入不走这里，
    // 只受各自页权限约束，所以调用方不必另有本 tab 权限）。
    { key: 'desens', label: 'AI脱敏' },
    // 文件存档从独立页并入（2026-09 v1.7.0）：倒数第二个 tab
    { key: 'files', label: '文件存档' },
    // 全局搜索从独立页并入（2026-09 v1.7.0）：最后一个 tab（右下角悬浮框直达）
    { key: 'search', label: '全局搜索' },
  ],
  settings: [
    // 用户管理从独立页并入（2026-09 v1.7.0）：设置页 tab（仅管理员可见，视图内部再按角色拦截）
    { key: 'users', label: '用户管理' },
  ],
  // 电子宠物（v1.10.10，需求⑨）：本页已并入「效率工具」的一个 tab，不再出现在侧栏，
  // 因此下面这组键不会再被权限表渲染出来、也拿不到 allowed_tabs.pets ——
  // canTab('pets', k) 于是恒为「全开」，PetsPanel 内部六个子 tab 对所有能看到电子宠物 tab 的人都开放
  // （这正是预期：外层只守一道 tools.pets，内部子 tab 是纯 UI 分段）。
  // 定义保留是为了别处万一还引用 key 时不至于取到 undefined。
  pets: [
    { key: 'pets', label: '我的宠物' },
    { key: 'adopt', label: '领养宠物' },
    { key: 'checkin', label: '每日打卡' },
    { key: 'records', label: '养育记录' },
    { key: 'settings', label: '设置与预览' },
    { key: 'assign', label: '宠物分配' },
  ],
  // 智能家居（2026-09 v1.6.8）：米家设备总览与控制 / 参数中英对照 / 扫码绑定设置
  // v1.6.29：移除「监控」tab（小米云已停 HLS 出流，事件凭证通道一并下线）
  // v1.9.22 曾把「Agent红绿灯」升格独立页；v1.9.23 放回本页（智能板之后）
  smarthome: [
    { key: 'mijia', label: '米家' },
    // 数字人（v1.12.0，本页第二个 tab）：Vivix 实时数字人——数字人界面/设置/历史对话三个子页（DhPanel 内部分）
    { key: 'dh', label: '数字人' },
    // LLM在线模型（v1.12.4）：原独立「AI 助手」页整页并入（AiChat 组件原样挂本 tab）；
    // 授权键从 ai 页平移为 smarthome.llm（db.js migrateAiIntoSmartHome），/api/ai/* 归这一个 tab
    { key: 'llm', label: 'LLM在线模型' },
    // 智能板（v1.9.11）：小智 Korvo2V3 语音板 = 装机向导 + 唤醒词编译烧录 + 语音控米家
    { key: 'xiaozhi', label: '智能板' },
    // Agent红绿灯（v1.8.1 起的本页子 tab）：ESP32-C3 三色灯指示九家 AI Agent 状态；
    // 面板内部再分 功能介绍/下载安装包/安装步骤 三段（CcLightPanel，localStorage 记忆，无独立权限键）
    { key: 'cclight', label: 'Agent红绿灯' },
    // v1.9.24 改名「米家设置」（内容就是小米账号绑定/解绑，避免与全局设置混淆）
    { key: 'settings', label: '米家设置' },
    // v1.9.24 更名「米家参数翻译」并移到米家设置之后（内容就是米家设备属性的中文对照维护）
    { key: 'terms', label: '米家参数翻译' },
    // 视频中心（v1.9.26）：本页最后一个 tab——视频教学的精简版（目录树+播放+进度记忆/断点续播，
    // 无学年学科/注意力点检/文档预览；目录在设置页「智能家居视频路径」配置）
    { key: 'videocenter', label: '视频中心' },
  ],
};

// 受限 tab：与后端 auth.js RESTRICTED_TABS 一致——默认对所有人关闭（admin 除外），
// 即使 allowed_tabs 缺键（=该页全开）也必须在用户管理里显式勾选授权。
const RESTRICTED_TABS = { learning: ['payout', 'wishset', 'pianoconfirm', 'vsettings'] };

function meUser() {
  try { return JSON.parse(localStorage.getItem('wb_user') || 'null'); } catch { return null; }
}

// 该页允许的 tab key 数组；null = 不限制（全部）
export function allowedTabs(page) {
  const me = meUser();
  if (!me || me.role === 'admin') return null;
  const map = me.allowed_tabs || {};
  if (!(page in map)) return null;
  const list = map[page];
  return Array.isArray(list) ? list : null;
}

export function canTab(page, key) {
  const me = meUser();
  if ((RESTRICTED_TABS[page] || []).includes(key)) {
    if (!me) return false;
    if (me.role === 'admin') return true;
    const list = (me.allowed_tabs || {})[page];
    return Array.isArray(list) && list.includes(key);
  }
  const t = allowedTabs(page);
  return t === null || t.includes(key);
}

// 初始 tab：默认值无权限时落到第一个有权限的 tab（全无权限时返回原值，页面自己显示空态）
export function firstTab(page, def) {
  if (canTab(page, def)) return def;
  const t = allowedTabs(page);
  return t && t.length ? t[0] : def;
}
