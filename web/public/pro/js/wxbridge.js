// 微信小程序对接桥（预留能力，详见 README.md「小程序对接」）
// H5 可直接嵌入小程序 <web-view>；本模块提供三类能力：
//  1. 环境探测：isWeChat() / isMiniProgram()
//  2. URL 指令：?version=93&autostart=1 直达测试；?profile=ID 直达档案；?type=INTJ 直达类型详情
//  3. 数据回传：postResult() 在小程序 web-view 的后退/组件销毁/分享时机把结果发给小程序页
//     （微信 web-view 的 bindmessage 仅在这三个时机触发，属平台限制）
//     小程序页示例：<web-view src="..." bindmessage="onMsg"></web-view>
//     onMsg: e.detail.data[e.detail.data.length-1].mbtiResult
(function () {
  'use strict';

  const q = (() => {
    const o = {};
    new URLSearchParams(location.search).forEach((v, k) => { o[k] = v; });
    // 兼容 hash 参数：#/test?version=28
    const h = location.hash.split('?')[1];
    if (h) new URLSearchParams(h).forEach((v, k) => { if (!(k in o)) o[k] = v; });
    return o;
  })();

  const ua = navigator.userAgent;
  const isWeChat = /MicroMessenger/i.test(ua);
  const isMiniProgram = isWeChat && (/miniProgram/i.test(ua) || (window.__wxjs_environment === 'miniprogram'));

  // 小程序 web-view 内跳转
  function navigateTo(url) {
    if (isMiniProgram && window.wx && window.wx.miniProgram) {
      window.wx.miniProgram.navigateTo({ url });
      return true;
    }
    return false;
  }

  // 结果数据回传（累积式，小程序在后退/销毁/分享时收到）
  function postResult(profile) {
    // 趣味/专业测评档案没有 type（气质仅 MBTI 有）——temperamentOf(undefined) 会抛错，
    // 且此处在 try 块外构造，一崩就中断后续跳转（结果页打不开）。必须防御。
    const payload = {
      event: 'mbtiResult',
      mbtiResult: {
        id: profile.id, name: profile.name, version: profile.version, type: profile.type,
        scores: profile.scores,
        temperament: profile.type && window.MBTI_SCORING && window.MBTI_SCORING.temperamentOf
          ? window.MBTI_SCORING.temperamentOf(profile.type) : '',
        finishedAt: profile.finishedAt || profile.createdAt,
      },
    };
    try {
      if (isMiniProgram && window.wx && window.wx.miniProgram) {
        window.wx.miniProgram.postMessage({ data: payload });
        window.wx.miniProgram.postMessage({ data: { event: 'ready' } });
        return true;
      }
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(payload, '*'); // 普通 iframe 场景
        return true;
      }
    } catch (e) { /* 静默 */ }
    return false;
  }

  // 通用对外 API：小程序/宿主页面可提前注入监听，或直接调用
  const bridge = {
    query: q, isWeChat, isMiniProgram, navigateTo, postResult,
    // 供外部（含小程序 wx.evaluateJs 或宿主页面）随时取最近一份档案
    getResult: function (profileId) {
      const p = profileId ? window.MBTI_PROFILE.get(profileId) : (window.MBTI_PROFILE.list()[0] || null);
      return p ? {
        id: p.id, name: p.name, version: p.version, type: p.type, scores: p.scores,
        temperament: window.MBTI_SCORING.temperamentOf(p.type),
      } : null;
    },
  };
  window.MBTI_BRIDGE = bridge;

  // URL 指令分发（在 app 就绪后执行）
  bridge.applyRouteCommands = function (go) {
    if (q.profile) { go('#/profile/' + encodeURIComponent(q.profile)); return true; }
    if (q.type && /^[A-Z]{4}$/.test(q.type)) { go('#/type/' + q.type); return true; }
    if (q.version === '28' || q.version === '93') {
      go('#/start/' + q.version);
      if (q.autostart === '1') setTimeout(() => go('#/test/' + q.version, true), 60);
      return true;
    }
    return false;
  };
})();
