// 两个前端入口（主工作台 main.js / 智能家居 sh-main.js）共用的启动逻辑（v2.0.0 抽出）
// 抽出的动机：网关自适应与全局错误兜底这两段是「跟部署环境有关、跟业务无关」的代码，
// 复制一份到智能家居入口必然两边不同步，所以收在这里，两边都调。
import { rawUrl } from './api';

// 启动时应用主题（深色/浅色）
export function applyTheme() {
  const savedTheme = localStorage.getItem('wb_theme') || 'dark';
  document.documentElement.dataset.theme = savedTheme;
}

// fnOS 网关自适配（v1.9.1，仅 /app/.. 前缀下生效）：各视图里散落的裸 fetch('/api/..')
// 不走 api 模块（上传进度/SSE 等各自实现），统一在这里收口——补网关前缀 + 追加 ?token=
// 冗余通道（网关会剥/换 Authorization 头）。api 模块的请求已带前缀与 token，不会被改动
// （这里只改写以 '/api' 开头的字符串 URL）。非网关部署完全不受影响。
export function installGatewayFetchPatch() {
  const prefix = (location.pathname.match(/^\/app\/[A-Za-z0-9_-]+/) || [''])[0];
  if (!prefix) return '';
  const origFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    try {
      if (typeof input === 'string' && input.startsWith('/api')) {
        let url = prefix + input;
        const t = localStorage.getItem('wb_token') || '';
        if (t && !url.includes('token=')) url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t);
        input = url;
        // v1.9.6：网关把 Authorization 头当 NAS 令牌校验，带头一律拒（真机证实）。
        // 各视图裸 fetch 手动加的头在这里统一剥掉，认证由上面的 ?token= 参数承担。
        if (init && init.headers) {
          if (init.headers instanceof Headers) init.headers.delete('Authorization');
          else if (Array.isArray(init.headers)) init.headers = init.headers.filter(([k]) => String(k).toLowerCase() !== 'authorization');
          else {
            const c = { ...init.headers };
            delete c.Authorization; delete c.authorization;
            init.headers = c;
          }
        }
      }
    } catch { /* 任何解析异常都按原请求发出 */ }
    return origFetch(input, init);
  };
  return prefix;
}

// v1.10.36：懒加载 chunk/CSS 瞬时失败自愈。生产实测（2026-10-06 16:41，错误上报仅 1 条）：
// 首页 Dashboard 的 defineAsyncComponent(HolidayCalendar) 撞上一次网络抖动，Vite preload
// 抛「Unable to preload CSS」——文件本身 200 可达、之后无复发，纯瞬时失败；但没有兜底时
// 组件挂死、必须手动刷新。带 60 秒防循环标记整页刷新一次：重试成功即无感恢复；刷了还
// 失败（真故障）就让错误照常走红条 + 上报，绝不无限 reload。
// 组件级异步 import 的失败走 Vue errorHandler（installErrorHandler 里调）、路由级懒加载
// 的失败走 router.onError（router/index.js 里调）——两处共用这一个助手。
export function selfHealChunkFail(err) {
  const msg = String((err && err.message) || err || '');
  if (!/preload|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(msg)) return false;
  const KEY = 'wb_route_reload_ts';
  const last = Number(sessionStorage.getItem(KEY) || 0);
  if (Date.now() - last < 60000) return false;
  try { sessionStorage.setItem(KEY, String(Date.now())); } catch { /* 隐私模式 */ }
  location.reload();
  return true;
}

// 页面级异常兜底（v1.9.2 起）：onMounted/setup 里未捕获的异步异常会让整页内容消失
// （「首页/设置闪一下就没了」的现象）。统一接住：页面不再白屏，右下角红条提示。
// v1.9.3 诊断增强：红条带上出错位置（文件:行号）、点击复制完整堆栈、
// 同一错误 4 秒内去重（Vue 渲染错误重试会触发两次 errorHandler，不再弹两条）、
// 自动上报服务端（设置 → 前端错误上报 可查，方便无 SSH 环境排障）。
export function installErrorHandler(app) {
  let lastErr = '';
  let lastErrAt = 0;
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
      selfHealChunkFail(err); // chunk/CSS 瞬时失败：上报完带防循环标记自动刷新一次
      const now = Date.now();
      if (msg === lastErr && now - lastErrAt < 4000) return;
      lastErr = msg; lastErrAt = now;
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
}
