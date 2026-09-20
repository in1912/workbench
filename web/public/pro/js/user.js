// 用户档案：首次访问自动生成编号（用于关联历次试卷），资料字段全部选填
(function () {
  'use strict';

  const USER_KEY = 'pro_user_v1';

  function genUid() {
    // 8 位数字编号，加时间熵避免碰撞
    const t = Date.now().toString().slice(-6);
    const r = String(Math.floor(Math.random() * 900) + 100);
    return 'U' + t + r;
  }

  function load() {
    try {
      const u = JSON.parse(localStorage.getItem(USER_KEY) || 'null');
      if (u && u.uid) return u;
    } catch (e) { /* 忽略 */ }
    const fresh = {
      uid: genUid(),
      avatar: '',        // dataURL
      nickname: '',      // 昵称（展示用，可改）
      name: '',          // 真实姓名
      age: '',           // 年龄
      gender: '',
      job: '',           // 职业
      hobbies: '',       // 爱好
      createdAt: new Date().toISOString(),
    };
    localStorage.setItem(USER_KEY, JSON.stringify(fresh));
    return fresh;
  }

  function save(patch) {
    const u = Object.assign(load(), patch || {});
    localStorage.setItem(USER_KEY, JSON.stringify(u));
    return u;
  }

  function reset() {
    localStorage.removeItem(USER_KEY);
    return load();
  }

  // 当前用户的历次试卷（新在前）
  function myProfiles() {
    const uid = load().uid;
    return window.MBTI_PROFILE.list().filter(p => p.uid === uid);
  }

  window.MBTI_USER = { load, save, reset, myProfiles, USER_KEY };
})();
