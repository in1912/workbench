// 档案管理：每个测试人自动生成档案，localStorage 持久化
(function () {
  'use strict';

  const STORE_KEY = 'mbti_profiles_v1';
  const SESSION_KEY = 'mbti_session_v1'; // 进行中的测试进度

  function readAll() {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    } catch (e) { return []; }
  }
  function writeAll(list) {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
  }

  function genId() {
    return 'P' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
  }

  // 保存档案：profile = { name, version, type, scores, answers, stats, startedAt, finishedAt }
  function save(profile) {
    const list = readAll();
    const p = Object.assign({
      id: genId(),
      name: '未命名',
      createdAt: new Date().toISOString(),
    }, profile);
    p.id = profile.id || p.id; // 更新已有档案（重测覆盖）
    const idx = list.findIndex(x => x.id === p.id);
    if (idx >= 0) list[idx] = Object.assign({}, list[idx], p);
    else list.unshift(p);
    writeAll(list);
    return p;
  }

  function get(id) { return readAll().find(p => p.id === id) || null; }
  function remove(id) { writeAll(readAll().filter(p => p.id !== id)); }
  function list() { return readAll(); }

  // ---- 进行中的测试会话（中断续答） ----
  function saveSession(session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }
  function loadSession() {
    try { return JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); }
    catch (e) { return null; }
  }
  function clearSession() { localStorage.removeItem(SESSION_KEY); }

  window.MBTI_PROFILE = { save, get, remove, list, saveSession, loadSession, clearSession, STORE_KEY, SESSION_KEY };
})();
