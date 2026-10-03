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
app.use(router).mount('#app');
