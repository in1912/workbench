import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import './style.css';
import { maybeStartTvNav } from './utils/tvNav';
import { applyTheme, installGatewayFetchPatch, installErrorHandler } from './boot';

applyTheme();

// 电视/遥控器模式（安卓电视 APP 自动 / 浏览器手动开启，自 family-learning v3.0 移植）
maybeStartTvNav();

// fnOS 网关自适配（v1.9.1）+ 全局错误兜底（v1.9.2）：两段都搬到 boot.js，与智能家居入口共用
installGatewayFetchPatch();

const app = createApp(App);
installErrorHandler(app);
app.use(router);
// 等初始路由解析完再挂载（v1.10.32）：否则首帧 route 是空路由（无 meta.public），
// 公开页（#/s/:token 分享页、#/login）会先按主布局渲染一瞬——访客打开分享链接
// 会闪现完整侧栏目录，再切到裸布局。初始守卫是同步的（读 localStorage），等待是毫秒级。
router.isReady().then(() => app.mount('#app'));
