import { createRouter, createWebHashHistory } from 'vue-router';
import { NAV_ITEMS } from '../nav';

const routes = [
  { path: '/login', component: () => import('../views/Login.vue'), meta: { title: '登录', public: true } },
  { path: '/', component: () => import('../views/Dashboard.vue'), meta: { title: '今日看板', page: 'dashboard' } },
  { path: '/news', component: () => import('../views/News.vue'), meta: { title: '新闻', page: 'news' } },
  { path: '/email', component: () => import('../views/Email.vue'), meta: { title: '邮箱', page: 'email' } },
  { path: '/notes', component: () => import('../views/Notes.vue'), meta: { title: '笔记', page: 'notes' } },
  { path: '/tasks', component: () => import('../views/Tasks.vue'), meta: { title: '待办与日程', page: 'tasks' } },
  { path: '/family', component: () => import('../views/Family.vue'), meta: { title: '家庭事项', page: 'family' } },
  { path: '/learning', component: () => import('../views/Learning.vue'), meta: { title: '学习', page: 'learning' } },
  { path: '/tools', component: () => import('../views/Tools.vue'), meta: { title: '效率工具', page: 'tools' } },
  // 「私有项目」页（2026-09 v1.6.2）：三大测试中心从效率工具移入；旧地址 /tools?tab=dep 等回落到本页
  { path: '/private', component: () => import('../views/Private.vue'), meta: { title: '私有项目', page: 'private' } },
  { path: '/business', component: () => import('../views/Business.vue'), meta: { title: '业务系统', page: 'business' } },
  { path: '/ai', component: () => import('../views/AiChat.vue'), meta: { title: 'AI 助手', page: 'ai' } },
  { path: '/pets', component: () => import('../views/Pets.vue'), meta: { title: '我的宠物', page: 'pets' } },
  // 「打字赚钱」4 个 tab 已并入学习页（2026-09 v1.2.0）；旧地址带参跳转过去（tab key 不变）
  { path: '/typing', redirect: (to) => ({ path: '/learning', query: { tab: to.query.tab || 'practice' } }) },
  // 「领养宠物」已并回电子宠物模块的 tab；旧地址带参跳转过去
  { path: '/adopt', redirect: { path: '/pets', query: { tab: 'adopt' } } },
  { path: '/messages', component: () => import('../views/Messages.vue'), meta: { title: '短消息', page: 'messages' } },
  // 「AI 推送」已并入业务系统页；旧地址重定向过去
  { path: '/push', redirect: '/business' },
  { path: '/files', component: () => import('../views/Files.vue'), meta: { title: '文件存档', page: 'files' } },
  { path: '/pay', component: () => import('../views/Pay.vue'), meta: { title: '个人账务', page: 'pay' } },
  { path: '/users', component: () => import('../views/Users.vue'), meta: { title: '用户管理', page: 'users', adminOnly: true } },
  // 升级管理已并入「设置」页的 tab；旧地址重定向过去
  { path: '/upgrade', redirect: '/settings' },
  { path: '/settings', component: () => import('../views/Settings.vue'), meta: { title: '设置', page: 'settings' } },
  { path: '/dingtalk', component: () => import('../views/Dingtalk.vue'), meta: { title: '钉钉绑定' } },
  { path: '/search', component: () => import('../views/Search.vue'), meta: { title: '全局搜索', page: 'search' } },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

// 用户第一个有权限的页面路径；无任何授权页面返回 ''（守卫退回登录页）
function firstAllowedPath(user) {
  const allowed = user.allowed_pages || [];
  if (!allowed.length) return '/';
  const hit = NAV_ITEMS.find((n) => !n.adminOnly && allowed.includes(n.page));
  return hit ? hit.to : '';
}

// 会话与权限守卫
router.beforeEach((to) => {
  const token = localStorage.getItem('wb_token');
  const user = JSON.parse(localStorage.getItem('wb_user') || 'null');
  if (to.meta.public) {
    if (token && to.path === '/login') return firstAllowedPath(user) || '/login';
    return true;
  }
  if (!token) return { path: '/login', query: { redirect: to.fullPath } };
  // 页面权限
  if (user) {
    if (to.meta.adminOnly && user.role !== 'admin') return { path: '/', query: { denied: to.meta.page } };
    if (user.role !== 'admin' && to.meta.page) {
      const allowed = user.allowed_pages || [];
      if (allowed.length && !allowed.includes(to.meta.page)) {
        // 目标无权限时回落首页；但首页('/')本身也可能无权限——
        // 直接回落到第一个有权限的页面，避免 '/' → '/' 自重定向死循环（页面卡死）
        if (to.path === '/') {
          const first = firstAllowedPath(user);
          return first && first !== to.path ? first : { path: '/login' };
        }
        return { path: '/', query: { denied: to.meta.page } };
      }
    }
  }
  return true;
});

// 标签页标题统一由 App.vue 的 watch 设置（跟随共享 sysName，改名即时生效）

export default router;
