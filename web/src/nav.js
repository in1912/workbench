// 侧边栏页面清单（App.vue 导航与设置页「页面排序」共用）。
// page 为权限/排序的 key；adminOnly 页面仅管理员可见。
// 图标为 Material Icons 单色字体（v1.6.2：字体本地化在 web/public/material-icons/，随文字颜色渲染，不再用彩色 emoji）。
export const NAV_ITEMS = [
  { to: '/', icon: 'dashboard', label: '今日看板', page: 'dashboard' },
  { to: '/search', icon: 'search', label: '全局搜索', page: 'search' },
  { to: '/news', icon: 'article', label: '每日新闻', page: 'news' },
  { to: '/email', icon: 'mail', label: '邮箱', page: 'email' },
  { to: '/notes', icon: 'edit', label: '笔记', page: 'notes' },
  { to: '/tasks', icon: 'event_note', label: '待办与日程', page: 'tasks' },
  { to: '/family', icon: 'favorite', label: '家庭事项', page: 'family' },
  { to: '/learning', icon: 'trending_up', label: '学习', page: 'learning' },
  { to: '/tools', icon: 'build', label: '效率工具', page: 'tools' },
  { to: '/private', icon: 'lock', label: '私有项目', page: 'private' },
  { to: '/business', icon: 'business', label: '业务系统', page: 'business' },
  { to: '/files', icon: 'folder', label: '文件存档', page: 'files' },
  { to: '/pay', icon: 'account_balance_wallet', label: '个人账务', page: 'pay' },
  { to: '/ai', icon: 'smart_toy', label: 'AI 助手', page: 'ai' },
  { to: '/pets', icon: 'pets', label: '我的宠物', page: 'pets' },
  { to: '/smart-home', icon: 'home', label: '智能家居', page: 'smarthome' },
  { to: '/messages', icon: 'chat', label: '短消息', page: 'messages' },
  { to: '/users', icon: 'manage_accounts', label: '用户管理', page: 'users', adminOnly: true },
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
