import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import './style.css';
import { maybeStartTvNav } from './utils/tvNav';

// 启动时应用主题（深色/浅色）
const savedTheme = localStorage.getItem('wb_theme') || 'dark';
document.documentElement.dataset.theme = savedTheme;

// 电视/遥控器模式（安卓电视 APP 自动 / 浏览器手动开启，自 family-learning v3.0 移植）
maybeStartTvNav();

createApp(App).use(router).mount('#app');
