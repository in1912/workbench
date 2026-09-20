// 管理员：首次登录设置用户名密码（SHA-256 摘要存储，不落明文）；会话级登录态
// 说明：飞牛内网常以 http 访问，crypto.subtle 需安全上下文不可用，故内置纯 JS SHA-256
(function () {
  'use strict';

  const ADMIN_KEY = 'dep_admin_v1';
  const SESSION_KEY = 'dep_admin_session_v1';

  // SHA-256（FIPS 180-4 实现，UTF-8 安全），返回小写 hex
  function sha256Hex(input) {
    const s = unescape(encodeURIComponent(String(input)));
    const bytes = [];
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
    const bitLen = bytes.length * 8;
    const hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    bytes.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255,
      (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);

    const K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ];
    const rr = (x, n) => (x >>> n) | (x << (32 - n));
    let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

    for (let off = 0; off < bytes.length; off += 64) {
      const w = new Array(64);
      for (let t = 0; t < 16; t++) {
        w[t] = ((bytes[off + t * 4] << 24) | (bytes[off + t * 4 + 1] << 16) | (bytes[off + t * 4 + 2] << 8) | bytes[off + t * 4 + 3]) | 0;
      }
      for (let t = 16; t < 64; t++) {
        const s0 = rr(w[t - 15], 7) ^ rr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
        const s1 = rr(w[t - 2], 17) ^ rr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (let t = 0; t < 64; t++) {
        const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[t] + w[t]) | 0;
        const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
        const mj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + mj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H = [
        (H[0] + a) | 0, (H[1] + b) | 0, (H[2] + c) | 0, (H[3] + d) | 0,
        (H[4] + e) | 0, (H[5] + f) | 0, (H[6] + g) | 0, (H[7] + h) | 0
      ];
    }
    return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }

  function readStore() {
    try {
      const a = JSON.parse(localStorage.getItem(ADMIN_KEY) || 'null');
      if (a && a.u && a.h) return a;
    } catch (e) { /* 忽略 */ }
    return null;
  }
  function hashOf(username, password) { return sha256Hex(username + ':' + password); }

  function isInit() { return !!readStore(); }

  // 首次设置：设置后不可重复设置（如需重置请清空浏览器数据）
  function init(username, password) {
    username = String(username || '').trim();
    password = String(password || '');
    if (username.length < 2 || username.length > 20) return { ok: false, message: '用户名需 2-20 个字符' };
    if (password.length < 4) return { ok: false, message: '密码至少 4 位' };
    if (readStore()) return { ok: false, message: '管理员已设置过，请直接登录' };
    localStorage.setItem(ADMIN_KEY, JSON.stringify({
      u: username, h: hashOf(username, password), createdAt: new Date().toISOString(),
    }));
    return { ok: true };
  }

  function login(username, password) {
    const a = readStore();
    if (!a) return { ok: false, message: '尚未设置管理员，请先完成首次设置' };
    username = String(username || '').trim();
    if (username !== a.u || hashOf(username, String(password || '')) !== a.h) {
      return { ok: false, message: '用户名或密码错误' };
    }
    sessionStorage.setItem(SESSION_KEY, '1');
    return { ok: true };
  }

  function logout() { sessionStorage.removeItem(SESSION_KEY); }
  function loggedIn() { return !!readStore() && sessionStorage.getItem(SESSION_KEY) === '1'; }
  function username() { const a = readStore(); return a ? a.u : ''; }

  window.MBTI_ADMIN = { sha256Hex, isInit, init, login, logout, loggedIn, username, ADMIN_KEY, SESSION_KEY };
})();
