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

const app = createApp(App);
// 页面级异常兜底（v1.9.2）：onMounted/setup 里未捕获的异步异常会让整页内容消失
// （「首页/设置闪一下就没了」的现象）。统一接住：页面不再白屏，右下角红条提示 6 秒。
app.config.errorHandler = (err) => {
  console.error('[wb]', err);
  try {
    const d = document.createElement('div');
    d.textContent = '页面出了点问题：' + (err && err.message ? err.message : String(err));
    d.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;background:#dc2626;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;max-width:70vw;box-shadow:0 4px 16px rgba(0,0,0,.3)';
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 6000);
  } catch { /* 展示失败不影响主流程 */ }
};
app.use(router).mount('#app');
