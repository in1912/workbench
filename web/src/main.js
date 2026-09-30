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

// fnOS 网关自适配（v1.9.1，仅 /app/.. 前缀下生效）：各视图里散落的裸 fetch('/api/..')
// 不走 api 模块（上传进度/SSE 等各自实现），统一在这里收口——补网关前缀 + 追加 ?token=
// 冗余通道（网关会剥/换 Authorization 头）。api 模块的请求已带前缀与 token，不会被改动
// （这里只改写以 '/api' 开头的字符串 URL）。非网关部署完全不受影响。
const wbGatewayPrefix = (location.pathname.match(/^\/app\/[A-Za-z0-9_-]+/) || [''])[0];
if (wbGatewayPrefix) {
  const origFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      if (typeof input === 'string' && input.startsWith('/api')) {
        let url = wbGatewayPrefix + input;
        const t = localStorage.getItem('wb_token') || '';
        if (t && !url.includes('token=')) url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t);
        input = url;
      }
    } catch { /* 任何解析异常都按原请求发出 */ }
    return origFetch(input, init);
  };
}

createApp(App).use(router).mount('#app');
