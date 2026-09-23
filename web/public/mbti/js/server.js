// 服务器模式：记录中央同步 + 站点域名（用于拼接分享链接）
// 支持两种部署：
//  1) 个人工作台（workbench）：页面经 /mbti/index.html 访问（与工作台同源），
//     档案同步到工作台 /api/mbti/*（复用工作台登录态 wb_token）；
//     管理功能（系统用户 / 全部测试记录 / 分享前缀配置）在工作台「效率工具 → 心理测试」页。
//  2) 飞牛 fnOS FPK（cgi）：页面经 /cgi/ThirdParty/mbtitest/index.cgi/ 访问，
//     档案同步到 NAS 上的 records.jsonl。
// file:// 或普通静态服务器下自动退化为本地模式，一切功能照旧。
(function () {
  'use strict';

  const SITE_KEY = 'mbti_site_v1';
  const CGI_PATH = '/cgi/ThirdParty/mbtitest/index.cgi/';
  const WB_API = '/api/mbti';
  const WB_PAGE = '/mbti/index.html';

  // ---------- 站点域名（设置页配置，仅 CGI 模式使用） ----------
  function loadSite() {
    try {
      const s = JSON.parse(localStorage.getItem(SITE_KEY) || 'null');
      if (s && typeof s === 'object') return { domain: String(s.domain || '') };
    } catch (e) { /* 忽略 */ }
    return { domain: '' };
  }
  function saveSite(patch) {
    const s = Object.assign(loadSite(), patch || {});
    localStorage.setItem(SITE_KEY, JSON.stringify(s));
    return s;
  }

  // ---------- 运行模式检测：workbench | cgi | local ----------
  function mode() {
    const p = location.pathname;
    if (p === '/mbti' || p === '/mbti/' || p.indexOf('/mbti/') === 0) return 'workbench';
    if (/index\.cgi\/?$/.test(p)) return 'cgi';
    return 'local';
  }
  const MODE = mode();

  function available() { return MODE !== 'local'; }
  function apiBase() {
    if (MODE !== 'cgi') return null;
    let p = location.pathname;
    if (!p.endsWith('/')) p += '/';
    return p; // 例如 /cgi/ThirdParty/mbtitest/index.cgi/
  }

  // ---------- 工作台模式：登录令牌（与工作台 SPA 同源，localStorage 共享） ----------
  function wbToken() {
    try { return localStorage.getItem('wb_token') || ''; } catch (e) { return ''; }
  }
  function wbHeaders(json) {
    const h = {};
    if (json) h['Content-Type'] = 'application/json';
    const t = wbToken();
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }

  // 工作台分享前缀（管理员在工作台「心理测试」页配置；留空 = 用当前访问地址）
  let wbPrefix = '';
  if (MODE === 'workbench') {
    fetch(WB_API + '/config', { headers: wbHeaders(false) })
      .then(r => (r.ok ? r.json() : null))
      .then(j => { if (j && typeof j.prefix === 'string') wbPrefix = j.prefix.trim(); })
      .catch(() => { /* 取不到就用当前地址 */ });
  }

  // ---------- 记录同步载荷（白名单字段，不含头像等大字段） ----------
  function syncPayload(profile, user) {
    const u = user || window.MBTI_USER.load();
    // 通用测试结果：result 体积可控（branch 的 steps 会截断，避免超大载荷）
    let result = profile.result || null;
    if (result && result.steps && result.steps.length > 40) {
      result = Object.assign({}, result, { steps: result.steps.slice(0, 40) });
    }
    return {
      id: profile.id, uid: profile.uid, version: profile.version, name: profile.name,
      testId: profile.testId || '', testTitle: profile.testTitle || '', summary: profile.summary || '',
      type: profile.type, scores: profile.scores, stats: profile.stats, answers: profile.answers, result,
      startedAt: profile.startedAt, finishedAt: profile.finishedAt, durationMin: profile.durationMin,
      aiAnalysis: profile.aiAnalysis || '', aiAnalysisAt: profile.aiAnalysisAt || '',
      userInfo: {
        uid: u.uid, nickname: u.nickname, name: u.name, age: u.age,
        gender: u.gender, job: u.job, hobbies: u.hobbies,
      },
      syncedAt: new Date().toISOString(),
    };
  }

  function syncProfile(profile, user) {
    if (!profile || !profile.id) return Promise.resolve(false);
    const payload = syncPayload(profile, user);
    if (MODE === 'workbench') {
      return fetch(WB_API + '/records', {
        method: 'POST',
        headers: wbHeaders(true),
        body: JSON.stringify(payload),
      }).then(r => r.ok).catch(() => false);
    }
    if (MODE !== 'cgi') return Promise.resolve(false);
    return fetch(apiBase() + 'api/save?id=' + encodeURIComponent(profile.id), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(r => r.ok).catch(() => false);
  }

  function fetchOne(id) {
    if (!id) return Promise.resolve(null);
    if (MODE === 'workbench') {
      // 公开端点：分享链接接收方无需登录也能读
      return fetch(WB_API + '/public/' + encodeURIComponent(id))
        .then(r => (r.ok ? r.json() : null)).catch(() => null);
    }
    if (MODE !== 'cgi') return Promise.resolve(null);
    return fetch(apiBase() + 'api/get?id=' + encodeURIComponent(id)).then(r => {
      if (!r.ok) return null;
      return r.json();
    }).catch(() => null);
  }

  // 管理端列表/删除（仅 CGI 模式提供；工作台模式的管理功能在工作台页面里）
  function fetchAll() {
    if (MODE !== 'cgi') return Promise.resolve(null);
    return fetch(apiBase() + 'api/list').then(r => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(text => text.split('\n').map(l => l.trim()).filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch (e) { return null; }
    }).filter(Boolean));
  }

  function remove(id) {
    if (MODE !== 'cgi' || !id) return Promise.resolve(false);
    return fetch(apiBase() + 'api/del?id=' + encodeURIComponent(id)).then(r => r.ok).catch(() => false);
  }

  // ---------- 工作台模式：用户资料入库 + AI 授权与深度分析代理 ----------
  function saveUserInfo(info) {
    if (MODE !== 'workbench' || !info || !info.uid) return Promise.resolve(false);
    return fetch(WB_API + '/user-info', {
      method: 'POST',
      headers: wbHeaders(true),
      body: JSON.stringify(info),
    }).then(r => r.ok).catch(() => false);
  }

  // AI 分析授权（按档案编号 uid，管理员在工作台勾选；结果缓存 60s）
  let aiAuthCache = { at: 0, ok: false };
  function aiAuth() {
    if (MODE !== 'workbench') return Promise.resolve(false);
    if (Date.now() - aiAuthCache.at < 60000) return Promise.resolve(aiAuthCache.ok);
    const uid = (window.MBTI_USER.load() || {}).uid || '';
    return fetch(WB_API + '/ai-auth?uid=' + encodeURIComponent(uid), { headers: wbHeaders(false) })
      .then(r => r.ok ? r.json() : { ok: false })
      .then(j => {
        aiAuthCache = { at: Date.now(), ok: !!(j && j.ok) };
        return aiAuthCache.ok;
      })
      .catch(() => false);
  }

  // AI 深度分析：服务端校验归属与授权后，走工作台统一 ai_config 调用
  function aiAnalysis(payload) {
    if (MODE !== 'workbench') return Promise.reject(new Error('仅工作台模式支持'));
    return fetch(WB_API + '/ai-analysis', {
      method: 'POST',
      headers: wbHeaders(true),
      body: JSON.stringify(payload || {}),
    }).then(r => r.json().then(j => {
      if (!r.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
      return (j && j.text) || '';
    }));
  }

  // ---------- 分享链接 ----------
  function buildShareLink(profileId) {
    if (!profileId) return null;
    if (MODE === 'workbench') {
      let d = wbPrefix.trim();
      if (d && !/^[a-z][a-z0-9+.-]*:\/\//i.test(d)) d = 'https://' + d;
      if (!d) d = location.origin; // 工作台部署必为 http(s)，一定有 origin
      return d.replace(/\/+$/, '') + WB_PAGE + '#/result/' + profileId;
    }
    let d = loadSite().domain.trim();
    if (d && !/^[a-z][a-z0-9+.-]*:\/\//i.test(d)) d = 'http://' + d;
    if (!d) {
      if (location.protocol === 'http:' || location.protocol === 'https:') d = location.origin;
      else return null; // file:// 等无域名环境
    }
    return d.replace(/\/+$/, '') + CGI_PATH + '#/result/' + profileId;
  }

  // ---------- 运行时门禁（workbench 模式）：管理员关闭对外开关后，已加载的页面也立即停用 ----------
  // 题目全在 JS 里、纯客户端即可作答：静态页 403 只拦得住「新打开」的访客，拦不住已开着的
  // 标签页（bfcache 返回、长驻 SPA 都还在内存里）。此处轮询工作台免登录 gate 端点（无敏感
  // 数据），一旦停用就整页锁定；网络失败不锁（离线可用性优先）。端点不存在（旧版工作台）
  // 返回 401/404，同样不锁。
  function gateLockdown() {
    if (document.getElementById('wb_gate_lock')) return;
    var d = document.createElement('div');
    d.id = 'wb_gate_lock';
    d.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fff;display:flex;align-items:center;justify-content:center;text-align:center;font-family:system-ui,sans-serif;color:#555;padding:24px';
    d.innerHTML = '<div><div style="font-size:44px">🚫</div><h2 style="margin:10px 0 6px">测试已停用</h2><p style="margin:0;color:#888">该测试中心当前未对外开放，请联系管理员开启。</p></div>';
    (document.body || document.documentElement).appendChild(d);
  }
  function gateCheck() {
    fetch(WB_API + '/gate')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.enabled === false) gateLockdown(); })
      .catch(function () { /* 网络失败不锁页面 */ });
  }
  if (MODE === 'workbench') {
    gateCheck();
    setInterval(gateCheck, 15000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) gateCheck(); });
  }

  window.MBTI_SITE = { load: loadSite, save: saveSite, KEY: SITE_KEY };
  window.MBTI_SERVER = {
    CGI_PATH, mode, available, apiBase, syncProfile, fetchAll, fetchOne, remove, buildShareLink,
    saveUserInfo, aiAuth, aiAnalysis,
  };
})();
