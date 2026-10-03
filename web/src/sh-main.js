// 智能家居独立应用前端入口（v2.0.0）——与主工作台 main.js 分开，产物落 web/dist-sh/<时间戳>/
//
// 与主工作台的三点差别：
//   ① 没有登录页：服务端给每个 /api 请求注入内置本地账号（见 db.ensureLocalUser），页面直接进主界面；
//   ② 没有页面权限守卫：只有「智能家居」这一个模块，路由表就一条兜底路由；
//   ③ 仍然装 vue-router：SmartHome.vue 内部用 useRoute/useRouter 把当前 tab 同步进 ?tab=（深链/刷新保持），
//      给它一个最小路由器即可，业务组件一行都不用改。
import { createApp, h } from 'vue';
import { createRouter, createWebHashHistory, RouterView } from 'vue-router';
import ShApp from './ShApp.vue';
import './style.css';
import { applyTheme, installGatewayFetchPatch, installErrorHandler } from './boot';

applyTheme();
// fnOS 网关自适配：独立应用也走 /app/qgsmarthome 前缀，同样的补前缀逻辑（boot.js 与主应用共用）
installGatewayFetchPatch();

const router = createRouter({
  history: createWebHashHistory(),
  routes: [{ path: '/:pathMatch(.*)*', component: ShApp }],
});

const Root = { render: () => h(RouterView) };
const app = createApp(Root);
installErrorHandler(app);
app.use(router).mount('#app');
