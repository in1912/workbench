// 页内 tab 级授权（与后端 auth.js TAB_PATHS 的 tab key 一一对应）
// 授权语义：allowed_tabs 里该页的键不存在 = 该页全部 tab 开放；存在数组 = 只开放列出的 tab（空数组=都不开）
export const TAB_DEFS = {
  tasks: [
    { key: 'cal', label: '日历' },
    { key: 'todo', label: '待办事项' },
  ],
  email: [
    { key: 'mail', label: '收发邮件' },
    { key: 'contacts', label: '通讯录' },
  ],
  family: [
    { key: 'family', label: '通知' },
    { key: 'kids', label: '子女学习' },
    { key: 'profiles', label: '家庭人员档案' },
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
  pay: [
    { key: 'dash', label: '账务看板' },
    { key: 'cats', label: '科目设置' },
    { key: 'import', label: '账单导入' },
    { key: 'bills', label: '账单流水' },
    { key: 'budget', label: '预算' },
  ],
  business: [
    { key: 'sys', label: '业务系统' },
    { key: 'skill', label: 'Skill 任务' },
    { key: 'push', label: '推送记录' },
    { key: 'config', label: '定时配置' },
  ],
  // 「私有项目」页（2026-09 v1.6.2）：三大测试中心从「效率工具」页移入
  // H5 分别嵌 /dep/index.html、/pro/index.html、/mbti/index.html；管理列表与分享前缀配置在各 tab
  private: [
    { key: 'dep', label: '抑郁测试' },
    { key: 'pro', label: '心理测试' },
    { key: 'mbti', label: '职业测试' },
  ],
  tools: [
    // 智作平台（文案库）排第一（2026-09 v1.6.2）：iframe 嵌入同源 /zhizu/，自带登录与角色体系
    { key: 'zhizu', label: '智作平台' },
    // 录音转写为默认落点（2026-09-22 用户要求：模块默认进录音转写）
    { key: 'vibe', label: '录音转写' },
    { key: 'clip', label: '剪贴板' },
    { key: 'links', label: '快捷启动' },
    // 学习页移来的 3 个 tab（2026-09 v1.2.0）
    { key: 'plans', label: '学习计划' },
    { key: 'records', label: '学习记录' },
    { key: 'review', label: '复盘' },
    // 电脑监控（v1.3.5）
    { key: 'monitor', label: '电脑监控' },
    // 语音配音从「学习」页移来（2026-09 v1.6.5），排最后一个 tab
    { key: 'tts', label: '语音配音' },
  ],
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
  smarthome: [
    { key: 'mijia', label: '米家' },
    { key: 'terms', label: '参数翻译' },
    { key: 'settings', label: '设置' },
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
