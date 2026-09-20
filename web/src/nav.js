// 侧边栏页面清单（App.vue 导航与设置页「页面排序」共用）。
// page 为权限/排序的 key；adminOnly 页面仅管理员可见。
export const NAV_ITEMS = [
  { to: '/', icon: '⌂', label: '今日看板', page: 'dashboard' },
  { to: '/search', icon: '⌕', label: '全局搜索', page: 'search' },
  { to: '/news', icon: '☰', label: '每日新闻', page: 'news' },
  { to: '/email', icon: '✉', label: '邮箱', page: 'email' },
  { to: '/notes', icon: '✎', label: '笔记', page: 'notes' },
  { to: '/tasks', icon: '✓', label: '待办与日程', page: 'tasks' },
  { to: '/family', icon: '♡', label: '家庭事项', page: 'family' },
  { to: '/learning', icon: '↑', label: '学习', page: 'learning' },
  { to: '/tools', icon: '◈', label: '效率工具', page: 'tools' },
  { to: '/business', icon: '⚙', label: '业务系统', page: 'business' },
  { to: '/files', icon: '📁', label: '文件存档', page: 'files' },
  { to: '/pay', icon: '💰', label: '个人账务', page: 'pay' },
  { to: '/ai', icon: '◈', label: 'AI 助手', page: 'ai' },
  { to: '/pets', icon: '🐾', label: '我的宠物', page: 'pets' },
  { to: '/messages', icon: '💬', label: '短消息', page: 'messages' },
  { to: '/users', icon: '☺', label: '用户管理', page: 'users', adminOnly: true },
  { to: '/settings', icon: '⚙', label: '设置', page: 'settings' },
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
