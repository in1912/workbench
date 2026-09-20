const base = '/api';

// 兼容老内核 webview（iOS 钉钉内置浏览器等不支持 AbortSignal.timeout，2021 年前的 Safari 均无）：
// 不打补丁的话该设备上全站请求直接抛 TypeError（表现为"钉钉免登未生效 / 登录失败"）。
// 全局补丁 + 本模块被所有视图 import → AiChat 等处的 AbortSignal.timeout 也一并覆盖。
if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout !== 'function') {
  AbortSignal.timeout = (ms) => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), ms);
    return ctrl.signal;
  };
}

function getToken() {
  return localStorage.getItem('wb_token') || '';
}

// 花生壳 HTTP 型映射会掐掉 PATCH 方法的连接（实测 GET/POST/PUT/DELETE 均可达、PATCH 必断）：
// 所有 PATCH 实际改发 PUT + 还原头，服务端中间件在路由前还原为 PATCH，路由零改动。
// 幂等方法网络层失败自动重试一次（中转杀连接/复用死套接字时，换新连接实测 100% 可达）；
// POST 不重试——新建类请求重发可能产生重复数据。
const NET_RETRY = new Set(['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE']);

async function request(method, url, body, retried = false) {
  const opts = { method, headers: {} };
  if (method === 'PATCH') {
    opts.method = 'PUT';
    opts.headers['X-HTTP-Method'] = 'PATCH';
  }
  const token = getToken();
  if (token) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(base + url, { ...opts, signal: AbortSignal.timeout(180000) });
  } catch (e) {
    if (!retried && NET_RETRY.has(method) && e && e.name !== 'AbortError') {
      await new Promise((r) => setTimeout(r, 500));
      return request(method, url, body, true);
    }
    throw new Error('网络连接失败，请重试（若反复失败请检查网络或稍后再试）');
  }
  if (res.status === 401) {
    localStorage.removeItem('wb_token');
    localStorage.removeItem('wb_user');
    if (!location.hash.includes('/login')) location.hash = '#/login';
    throw new Error('登录已过期，请重新登录');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body) => request('POST', url, body ?? {}),
  put: (url, body) => request('PUT', url, body ?? {}),
  patch: (url, body) => request('PATCH', url, body ?? {}),
  del: (url) => request('DELETE', url),
  download,
  blob: postBlob,
};

// 带登录令牌取二进制（语音合成返回 audio/wav）。
// 超时放宽到 5 分钟：首次合成可能包含引擎冷启动 + 首次模型加载。
async function postBlob(url, body) {
  const res = await fetch(base + url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${getToken()}` },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(300000),
  });
  if (res.status === 401) {
    localStorage.removeItem('wb_token');
    localStorage.removeItem('wb_user');
    if (!location.hash.includes('/login')) location.hash = '#/login';
    throw new Error('登录已过期，请重新登录');
  }
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `请求失败 (${res.status})`);
  }
  return res.blob();
}

// 带登录令牌下载文件。<a href> 直链不带 Authorization 头会被全局鉴权拦成 401，
// 必须 fetch 取 blob 后再触发浏览器保存。filename 缺省时从 Content-Disposition 解析。
async function download(url, filename) {
  const res = await fetch(base + url, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `下载失败 (${res.status})`);
  }
  if (!filename) {
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="([^"]+)"/);
    if (m) filename = decodeURIComponent(m[1]);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename || 'download';
  a.click();
  URL.revokeObjectURL(objectUrl);
}
