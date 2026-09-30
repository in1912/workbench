// 飞牛 fnOS 统一网关嵌入（v1.9.0）：页面挂在 /app/{appname} 前缀下时，API 请求也必须带同款前缀，
// 否则 fetch('/api/..') 会打到 NAS 域名根路径（fnOS 自己的接口）。哈希路由 + vite base './'，
// 其余静态资源天然可迁移，这里补齐 API 这一处。常规部署（根路径）保持 '/api' 不变。
const GATEWAY_PREFIX = (location.pathname.match(/^\/app\/[A-Za-z0-9_-]+/) || [''])[0];
const base = GATEWAY_PREFIX + '/api';
// v1.9.6：fnOS 网关会把 Authorization 头当 NAS 令牌校验，带头的业务请求一律被拒
// （真机 70+ 样本证实：带头的首发全被拦回 200 "invalid token"，去头的重试全成功；
// 而 sendBeacon 只带 ?token= 参数无头，全部穿透）。网关部署下一律不发 Authorization 头，
// 认证由 ?token= 查询参数 + wb_token Cookie 双通道承担（服务端 resolveUser 已支持）。
export const GATEWAY_ACTIVE = !!GATEWAY_PREFIX;
const authHeaders = () => (GATEWAY_ACTIVE ? {} : { Authorization: `Bearer ${getToken()}` });

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

// 令牌冗余通道（v1.9.1）：飞牛 fnOS 统一网关会剥掉/替换转请求的 Authorization 头，
// 表现为免登成功但所有业务接口 401（页面闪退、保存失败、退出即自动重登循环）。
// query 参数任何网关都不会动——<img> 直链本来就走这条路，这里推广到全部请求；
// Authorization 头照发（非网关部署优先走头），服务端 resolveUser 按头→query 顺序回退。
function withToken(url) {
  const t = getToken();
  if (!t) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t);
}

// 给不走 api 模块的裸 '/api/..' 调用（XHR 上传、Leaflet 瓦片 URL 模板等）用：
// 同样补网关前缀 + 令牌查询参数。非 '/api' 开头（跨机绝对地址等）原样返回。
export function rawUrl(url) {
  if (!url.startsWith('/api')) return url;
  return withToken(GATEWAY_PREFIX + url);
}

// 非 API 路径（智作平台 iframe 的 /zhizu/ 等）补网关前缀：常规部署前缀为空原样返回，
// fnOS 网关下补成 /app/{appname}/zhizu/（v1.9.2 修复「智作平台 找不到/404」）。
export function prefixUrl(p) {
  return GATEWAY_PREFIX + p;
}

// v1.9.8：二进制/附件通道的网关假200守卫。request() 的自愈只覆盖 JSON 响应；
// download / postBlob / upload 走 res.ok 直判——fnOS 网关代答（HTTP 200 +
// text/plain「invalid token」13 字节，NAS 会话失效签名，真机 2026-10-01 复现）
// 会被当成功：下载把代答文本存成「空 zip」（红绿灯安装包下载全空的用户反馈），
// 上传吞成 {}。本应用这些接口的正常响应 Content-Type 恒非 text/plain|html，
// 命中即读出代答原文：invalid token 给重登指引，其余给片段，并上报前端错误日志。
async function rejectGatewayText(res) {
  if (!res.ok) return; // 非 2xx 由调用方按各自语义报错
  const ct = res.headers.get('content-type') || '';
  if (!/^text\/(plain|html)/i.test(ct)) return;
  const text = await res.text();
  const snippet = text.slice(0, 120).replace(/\s+/g, ' ');
  try {
    navigator.sendBeacon(rawUrl('/api/client-errors'), new Blob([JSON.stringify({
      msg: `网关假200（二进制通道）→ ${snippet}`, stack: '', page: location.hash, ts: Date.now(),
    })], { type: 'application/json' }));
  } catch { /* 上报失败不影响本地 */ }
  throw new Error(
    snippet.includes('invalid token')
      ? 'NAS 会话已失效（网关拦截了该请求）：请打开 NAS 网页重新登录后刷新本页，或从飞牛桌面重新进入应用'
      : `响应被网关代答（${snippet || '空响应'}），请重试或重新进入应用`
  );
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
  if (token && !GATEWAY_ACTIVE) opts.headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  // PATCH 还原双通道（v1.9.2）：X-HTTP-Method 头之外再追加 ?_method=PATCH 查询参数——
  // fnOS 网关剥 Authorization 头的行为提示它可能也剥自定义头，查询参数任何网关都不动。
  let full = withToken(base + url);
  if (method === 'PATCH') full += (full.includes('?') ? '&' : '?') + '_method=PATCH';
  try {
    res = await fetch(full, { ...opts, signal: AbortSignal.timeout(180000) });
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
  // v1.9.4：先读文本再解析。此前 res.json().catch(()=>({})) 会把「200 但非 JSON」的响应
  // （fnOS 网关用自己的文本/错误页顶替业务响应，真机已捕获过）静默吞成 {}，当成功返回后
  // 页面拿 undefined 去读 .length 直接崩（首页子女学习卡）。现在：解析失败原样抛错，
  // 并把响应片段上报到「设置 → 前端错误」，直接看到网关到底回了什么。
  // v1.9.5 自愈：本应用 200 恒为 JSON，200 非 JSON 必是网关代答（请求从未到达服务端，
  // 重发无重复副作用）——去掉我们附加的 token 参数与 Authorization 头再试一次（wb_token
  // Cookie 通道兜底认证）；网关签名 invalid token（NAS 会话失效）时给出重登指引文案。
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const snippet = text.slice(0, 200).replace(/\s+/g, ' ');
    const report = (m) => {
      try {
        navigator.sendBeacon(rawUrl('/api/client-errors'), new Blob([JSON.stringify({
          msg: m, stack: '', page: location.hash, ts: Date.now(),
        })], { type: 'application/json' }));
      } catch { /* 上报失败不影响本地 */ }
    };
    if (res.status === 200 && !snippet.startsWith('<')) {
      try {
        const h2 = { ...opts.headers };
        delete h2.Authorization; // 只留 Content-Type / X-HTTP-Method；认证走 wb_token Cookie
        const r2 = await fetch(base + url, { ...opts, headers: h2, signal: AbortSignal.timeout(180000) });
        const t2 = await r2.text();
        if (r2.status === 200) {
          const d2 = JSON.parse(t2); // 仍非 JSON 会抛，落入下方统一报错
          report(`网关假200自愈：${method} ${url} 无token重试成功；首次返回「${snippet}」`);
          return d2;
        }
      } catch { /* 自愈未成，按原样报错 */ }
    }
    report(`非JSON响应 ${method} ${url} → HTTP ${res.status}：${snippet}`);
    throw new Error(
      snippet.includes('invalid token')
        ? 'NAS 会话已失效（网关拒绝了请求）：请打开 NAS 网页重新登录后刷新本页，或从飞牛桌面重新进入应用'
        : `接口响应异常（HTTP ${res.status}，非 JSON：${snippet}）`
    );
  }
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
  upload,
};

// 带登录令牌的 multipart 上传（fields 普通字段 + files: [{name, file}] 文件字段）。
// FormData 由浏览器自动设 Content-Type/boundary，这里不能再手工指定 JSON 头。
async function upload(url, fields = {}, files = []) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== '') fd.append(k, v);
  }
  for (const f of files) fd.append(f.name, f.file, f.file.name);
  const res = await fetch(withToken(base + url), {
    method: 'POST',
    headers: authHeaders(),
    body: fd,
    signal: AbortSignal.timeout(300000),
  });
  if (res.status === 401) {
    localStorage.removeItem('wb_token');
    localStorage.removeItem('wb_user');
    if (!location.hash.includes('/login')) location.hash = '#/login';
    throw new Error('登录已过期，请重新登录');
  }
  await rejectGatewayText(res);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `上传失败 (${res.status})`);
  return data;
}

// 带登录令牌取二进制（语音合成返回 audio/wav）。
// 超时放宽到 5 分钟：首次合成可能包含引擎冷启动 + 首次模型加载。
async function postBlob(url, body) {
  const res = await fetch(withToken(base + url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
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
  await rejectGatewayText(res);
  return res.blob();
}

// 带登录令牌下载文件。<a href> 直链不带 Authorization 头会被全局鉴权拦成 401，
// 必须 fetch 取 blob 后再触发浏览器保存。filename 缺省时从 Content-Disposition 解析。
async function download(url, filename) {
  const res = await fetch(withToken(base + url), {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `下载失败 (${res.status})`);
  }
  await rejectGatewayText(res);
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
