// 侧边栏页面清单（App.vue 导航与设置页「页面排序」共用）。
// page 为权限/排序的 key；adminOnly 页面仅管理员可见。
// v1.7.0 模块重组：业务系统(→效率工具·推送任务)/文件存档/全局搜索(→效率工具)、
// 个人账务(→家庭管理)、用户管理(→设置) 不再是独立侧边栏页面；
// 家庭留言板改名「家庭管理」。旧地址在 router 里重定向到对应页 tab。
// 图标为 Material Icons 单色字体（v1.6.2：字体本地化在 web/public/material-icons/，随文字颜色渲染，不再用彩色 emoji）。
export const NAV_ITEMS = [
  { to: '/', icon: 'dashboard', label: '首页', page: 'dashboard' },
  { to: '/news', icon: 'article', label: '新闻', page: 'news' },
  { to: '/email', icon: 'mail', label: '邮箱', page: 'email' },
  { to: '/notes', icon: 'edit', label: '笔记', page: 'notes' },
  { to: '/learning', icon: 'trending_up', label: '学习', page: 'learning' },
  { to: '/tasks', icon: 'event_note', label: '日程', page: 'tasks' },
  { to: '/family', icon: 'favorite', label: '家庭管理', page: 'family' },
  { to: '/tools', icon: 'build', label: '效率工具', page: 'tools' },
  { to: '/ai', icon: 'smart_toy', label: 'AI 助手', page: 'ai' },
  { to: '/pets', icon: 'pets', label: '电子宠物', page: 'pets' },
  { to: '/messages', icon: 'chat', label: '短消息', page: 'messages' },
  { to: '/private', icon: 'lock', label: '私有项目', page: 'private' },
  { to: '/smart-home', icon: 'home', label: '智能家居', page: 'smarthome' },
  { to: '/settings', icon: 'settings', label: '设置', page: 'settings' },
];

// 按保存的顺序（page key 数组）排序；未记录的页面按默认顺序排在已排序页面之后。
export function sortByOrder(items, order) {
  if (!Array.isArray(order) || !order.length) return items.slice();
  const idx = new Map(order.map((p, i) => [p, i]));
  return items
    .map((it, i) => ({ it, k: idx.has(it.page) ? idx.get(it.page) : 10000 + i }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.it);
}
