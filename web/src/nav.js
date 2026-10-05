// 侧边栏页面清单（App.vue 导航与设置页「页面排序」共用）。
// page 为权限/排序的 key；adminOnly 页面仅管理员可见。
// v1.7.0 模块重组：业务系统(→效率工具·推送任务)/文件存档/全局搜索(→效率工具)、
// 个人账务(→家庭管理)、用户管理(→设置) 不再是独立侧边栏页面；
// 家庭留言板改名「家庭管理」。旧地址在 router 里重定向到对应页 tab。
// v1.8.0：「私有项目」页（三大测试中心）整体移除，迁至独立项目 Private_Mini；旧 /private 回落首页。
// 图标为 Material Icons 单色字体（v1.6.2：字体本地化在 web/public/material-icons/，随文字颜色渲染，不再用彩色 emoji）。
export const NAV_ITEMS = [
  { to: '/', icon: 'dashboard', label: '首页', page: 'dashboard' },
  // 人生管理系统 → lifeOS（v1.10.5，需求⑨）：默认排第二位（首页之后）。
  // 注意：设置页里手动排过序的用户会有一份 wb_page_order 存档，那份存档优先级更高；
  // 默认顺序只对「没排过序」的账号生效（服务端 settings 里目前没有任何 order 记录）。
  { to: '/life', icon: 'flag', label: 'lifeOS', page: 'life' },
  // 笔记 → 第三位（v1.10.10，需求⑩）：紧跟着 lifeOS。这是**默认**顺序；
  // 设置页里拖过排序的账号有一份 wb_page_order 存档，存档优先级更高（线上那份已同步改成同样的顺序）。
  { to: '/notes', icon: 'edit', label: '笔记', page: 'notes' },
  { to: '/news', icon: 'article', label: '新闻', page: 'news' },
  { to: '/email', icon: 'mail', label: '邮箱', page: 'email' },
  // 人生管理系统（v1.10.0）：独立侧栏页，承载目标/行动/复盘/习惯/项目/领域/关系引擎。
  // 图标名是本机图标字体实测有字形的（缺失的名字会在侧栏渲染成一串字母，不是空白）。
  { to: '/learning', icon: 'trending_up', label: '学习', page: 'learning' },
  { to: '/tasks', icon: 'event_note', label: '日程', page: 'tasks' },
  { to: '/family', icon: 'favorite', label: '家庭管理', page: 'family' },
  { to: '/tools', icon: 'build', label: '效率工具', page: 'tools' },
  { to: '/ai', icon: 'smart_toy', label: 'AI 助手', page: 'ai' },
  // 电子宠物（v1.10.10，需求⑨）：不再是独立页，整页并入「效率工具」页的 tab；
  // 旧地址 /pets、/adopt 在 router 里重定向到 /tools?tab=pets。
  { to: '/messages', icon: 'chat', label: '短消息', page: 'messages' },
  { to: '/smart-home', icon: 'home', label: '智能家居', page: 'smarthome' },
  // v1.9.22 曾把 Agent红绿灯升格独立侧栏页；v1.9.23 放回智能家居子 tab（旧地址 /cc-light 在 router 重定向）
  { to: '/settings', icon: 'settings', label: '设置', page: 'settings' },
];

// 按保存的顺序（page key 数组）排序。
//
// v1.10.7（需求⑨ 的追加修复）：存档里**没有**的页面，插回它「默认该在的位置」——
// 即往前找最近一个存档里有记录的邻居，落在那个邻居**后面**；前面一个都没有就落在最前。
// 原写法是给它们 key = 10000+i，一律丢到最末尾，后果很坑：**只要用户动过一次页面排序，
// 之后新增的页面永远垫底**（服务端那份 order 是登录后拉取、覆盖 localStorage 的，躲不开）。
// lifeOS 正好撞上：线上存档是
// ["dashboard","news","email","notes","learning","tasks","family","tools","ai","pets","messages",
//  "private","smarthome","settings"] —— 还留着 v1.8.0 就删掉的 private，也没有 life，
// 于是「默认排第二位」在这个账号上完全看不出来，侧栏里 lifeOS 被排到了最后（真机点检才发现）。
//
// 为什么是「插在邻居后面」而不是按默认下标重排：存档里的相对顺序必须一字不动
// （用户自己拖过的顺序仍然算数），只有存档没提过的页面才需要找位置。
export function sortByOrder(items, order) {
  if (!Array.isArray(order) || !order.length) return items.slice();
  const idx = new Map(order.map((p, i) => [p, i]));
  // 存档跟当前清单完全不沾边（换过账号、键名全变）时不要自作聪明，原样返回
  if (!items.some((it) => idx.has(it.page))) return items.slice();
  const before = Math.min(...items.filter((it) => idx.has(it.page)).map((it) => idx.get(it.page))) - 0.5;
  return items
    .map((it, i) => {
      if (idx.has(it.page)) return { it, k: idx.get(it.page) };
      for (let j = i - 1; j >= 0; j--) if (idx.has(items[j].page)) return { it, k: idx.get(items[j].page) + 0.5 };
      return { it, k: before };
    })
    .sort((a, b) => a.k - b.k)
    .map((x) => x.it);
}
