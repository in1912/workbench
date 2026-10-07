import { createRouter, createWebHashHistory } from 'vue-router';
import { NAV_ITEMS } from '../nav';
import { selfHealChunkFail } from '../boot';

const routes = [
  { path: '/login', component: () => import('../views/Login.vue'), meta: { title: '登录', public: true } },
  { path: '/', component: () => import('../views/Dashboard.vue'), meta: { title: '今日看板', page: 'dashboard' } },
  { path: '/news', component: () => import('../views/News.vue'), meta: { title: '新闻', page: 'news' } },
  { path: '/email', component: () => import('../views/Email.vue'), meta: { title: '邮箱', page: 'email' } },
  { path: '/notes', component: () => import('../views/Notes.vue'), meta: { title: '笔记', page: 'notes' } },
  // 录音笔记（v1.9.39）：:id = vibe_records.id；不带 id = 新录一条。权限同「笔记」页
  { path: '/notes/rec/:id?', component: () => import('../views/NoteRecord.vue'), meta: { title: '录音笔记', page: 'notes' } },
  // 笔记分享公开页（v1.9.39）：无需登录，token 在路径、4 位码在 ?c=
  { path: '/s/:token', component: () => import('../views/ShareView.vue'), meta: { title: '分享的笔记', public: true } },
  // 人生管理系统（v1.10.0）：独立侧栏页；后端所有接口都在 /api/life/* 下
  { path: '/life', component: () => import('../views/Life.vue'), meta: { title: 'lifeOS', page: 'life' } },
  { path: '/tasks', component: () => import('../views/Tasks.vue'), meta: { title: '待办与日程', page: 'tasks' } },
  { path: '/family', component: () => import('../views/Family.vue'), meta: { title: '家庭管理', page: 'family' } },
  { path: '/learning', component: () => import('../views/Learning.vue'), meta: { title: '学习', page: 'learning' } },
  { path: '/tools', component: () => import('../views/Tools.vue'), meta: { title: '效率工具', page: 'tools' } },
  // 「私有项目」页 v1.8.0 整体移除（三大测试中心迁至独立项目 Private_Mini）；旧地址回落首页
  { path: '/private', redirect: '/' },
  // v1.7.0 模块重组：业务系统(→效率工具·推送任务)/文件存档/全局搜索/个人账务/用户管理
  // 不再是独立页面，旧地址带 tab 参数重定向到新位置
  { path: '/business', redirect: (to) => ({ path: '/tools', query: { ...to.query, tab: 'business' } }) },
  // AI 助手 v1.12.4 整页并入「人工智能」的 llm 子 tab（改名「LLM在线模型」）；旧地址/书签重定向过去
  // （AiChat 组件本身由 SmartHome 页引进渲染，不再单独挂路由）
  { path: '/ai', redirect: (to) => ({ path: '/smart-home', query: { ...to.query, tab: 'llm' } }) },
  // 电子宠物 v1.10.10（需求⑨）整页并入「效率工具」的 tab；旧地址与书签一律重定向过去。
  // 原来宠物页自己的 tab 参数也叫 tab（/pets?tab=adopt），跟效率工具的 tab 撞名，
  // 所以挪到 sub 参数：/pets?tab=adopt → /tools?tab=pets&sub=adopt（PetsPanel 读 sub）。
  { path: '/pets', redirect: (to) => ({ path: '/tools', query: { tab: 'pets', ...(to.query.tab ? { sub: to.query.tab } : {}) } }) },
  // 人工智能（2026-09 v1.6.8 智能家居，v1.12.4 改名）：米家扫码绑定 + 数字人 + LLM在线模型 + 视频
  { path: '/smart-home', component: () => import('../views/SmartHome.vue'), meta: { title: '人工智能', page: 'smarthome' } },
  // Agent红绿灯：v1.9.22 曾升格独立页，v1.9.23 放回人工智能页子 tab；旧地址/书签重定向过去
  { path: '/cc-light', redirect: (to) => ({ path: '/smart-home', query: { ...to.query, tab: 'cclight' } }) },
  // 「打字赚钱」4 个 tab 已并入学习页（2026-09 v1.2.0）；旧地址带参跳转过去（tab key 不变）
  { path: '/typing', redirect: (to) => ({ path: '/learning', query: { tab: to.query.tab || 'practice' } }) },
  // 「领养宠物」已并回电子宠物模块的 tab；v1.10.10 起宠物模块又并进效率工具，这里一路跳到 /tools
  { path: '/adopt', redirect: { path: '/tools', query: { tab: 'pets', sub: 'adopt' } } },
  { path: '/messages', component: () => import('../views/Messages.vue'), meta: { title: '短消息', page: 'messages' } },
  // 「AI 推送」已并入业务系统页；旧地址重定向过去
  { path: '/push', redirect: '/business' },
  { path: '/files', redirect: (to) => ({ path: '/tools', query: { ...to.query, tab: 'files' } }) },
  { path: '/pay', redirect: (to) => ({ path: '/family', query: { ...to.query, tab: 'pay' } }) },
  { path: '/users', redirect: (to) => ({ path: '/settings', query: { ...to.query, tab: 'users' } }) },
  // 升级管理已并入「设置」页的 tab；旧地址重定向过去
  { path: '/upgrade', redirect: '/settings' },
  { path: '/settings', component: () => import('../views/Settings.vue'), meta: { title: '设置', page: 'settings' } },
  { path: '/dingtalk', component: () => import('../views/Dingtalk.vue'), meta: { title: '钉钉绑定' } },
  { path: '/search', redirect: (to) => ({ path: '/tools', query: { ...to.query, tab: 'search' } }) },
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

// v1.10.36：路由级懒加载 chunk/CSS 失败自愈（组件级异步 import 的失败由 boot.js 的
// installErrorHandler 兜，两处共用 selfHealChunkFail——60 秒防循环，详见其注释）
router.onError((err) => { selfHealChunkFail(err); });

export default router;
