import { createApp } from 'vue';
import App from './App.vue';
import router from './router';
import './style.css';
import { maybeStartTvNav } from './utils/tvNav';
import { rawUrl } from './api';

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
// 页面级异常兜底（v1.9.2 起）：onMounted/setup 里未捕获的异步异常会让整页内容消失
// （「首页/设置闪一下就没了」的现象）。统一接住：页面不再白屏，右下角红条提示。
// v1.9.3 诊断增强：红条带上出错位置（文件:行号）、点击复制完整堆栈、
// 同一错误 4 秒内去重（Vue 渲染错误重试会触发两次 errorHandler，不再弹两条）、
// 自动上报服务端（设置 → 前端错误上报 可查，方便无 SSH 环境排障）。
let wbLastErr = '';
let wbLastErrAt = 0;
app.config.errorHandler = (err) => {
  console.error('[wb]', err);
  try {
    const msg = err && err.message ? err.message : String(err);
    const stack = String((err && err.stack) || '');
    const frame = (stack.split('\n')[1] || '').trim().replace(/^at\s+/, '').slice(0, 160);
    // 上报（fire-and-forget，未登录/网络失败静默丢弃；rawUrl 补网关前缀+token）
    try {
      navigator.sendBeacon(rawUrl('/api/client-errors'), new Blob([JSON.stringify({ msg, stack: stack.slice(0, 2000), page: location.hash, ts: Date.now() })], { type: 'application/json' }));
    } catch { /* 上报失败不影响本地 */ }
    // 去重：Vue 渲染出错重试会让同一错误连触两次
    const now = Date.now();
    if (msg === wbLastErr && now - wbLastErrAt < 4000) return;
    wbLastErr = msg; wbLastErrAt = now;
    const d = document.createElement('div');
    d.textContent = '页面出了点问题：' + msg + (frame ? `\n(${frame})` : '') + '（点击复制详情）';
    d.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;background:#dc2626;color:#fff;padding:10px 16px;border-radius:8px;font-size:13px;max-width:70vw;white-space:pre-line;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.3)';
    d.onclick = () => {
      try { navigator.clipboard.writeText(msg + '\n' + stack + '\npage: ' + location.hash); d.textContent = '已复制，可粘贴发给维护者'; } catch { /* 剪贴板不可用就算了 */ }
    };
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 12000);
  } catch { /* 展示失败不影响主流程 */ }
};
app.use(router).mount('#app');
