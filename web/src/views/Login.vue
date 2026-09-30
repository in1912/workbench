<template>
  <div class="login-wrap">
    <canvas ref="cv" class="star-canvas"></canvas>
    <button class="theme-toggle" :title="isDark ? '切换到浅色主题' : '切换到深色主题'" @click="toggleTheme">
      {{ isDark ? '☀' : '☾' }}
    </button>

    <div class="login-card">
      <div class="login-title">
        <div class="zh">{{ sysName }}</div>
        <div class="en">{{ sysNameEn }}</div>
      </div>
      <p class="muted" style="text-align:center; margin:6px 0 20px">请登录后使用</p>
      <div v-if="err" class="msg err">{{ err }}</div>
      <input v-model="username" placeholder="用户名" autocomplete="username" style="margin-bottom:12px" @keyup.enter="login" />
      <input v-model="password" type="password" placeholder="密码" autocomplete="current-password" style="margin-bottom:18px" @keyup.enter="login" />
      <button class="primary" style="width:100%; padding:10px" :disabled="loading" @click="login">
        {{ loading ? '登录中...' : '登 录' }}
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { api } from '../api';
import { sysName, sysNameEn, setSysInfo } from '../sysname';

const router = useRouter();
const route = useRoute();
const cv = ref(null);
const username = ref('');
const password = ref('');
const loading = ref(false);
const err = ref('');
const isDark = ref(getTheme() !== 'light');

onMounted(async () => {
  try {
    const info = await api.get('/system-info');
    setSysInfo(info.name, info.name_en); // 共享来源 + 回写缓存：登录后各页首屏即正确
  } catch (e) { /* 默认名称 */ }
});

function getTheme() { return localStorage.getItem('wb_theme') || 'dark'; }
function toggleTheme() {
  const next = isDark.value ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('wb_theme', next);
  isDark.value = !isDark.value;
}

// ---------- 钉钉工作台免登 ----------
// 本页在钉钉客户端里打开时：先取免登码直接登录；未绑定的账号提示先账号密码登录一次（成功后自动绑定）
const inDingTalk = /DingTalk/i.test(navigator.userAgent);

function loadDingtalkJs() {
  if (window.dd) return Promise.resolve(window.dd);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://g.alicdn.com/dingding/dingtalk-jsapi/3.0.25/dingtalk.open.js';
    s.onload = () => resolve(window.dd);
    s.onerror = () => reject(new Error('钉钉 JSAPI 加载失败'));
    document.head.appendChild(s);
  });
}
// 免登码：管理员配置了 corpId 才去要（未配置保持普通登录，静默跳过）
async function requestDingCode() {
  const info = await api.get('/auth/dingtalk-info');
  if (!info.enabled || !info.corp_id) return null;
  const dd = await loadDingtalkJs();
  return new Promise((resolve, reject) => {
    dd.ready(() => {
      dd.runtime.permission.requestAuthCode({
        corpId: info.corp_id,
        onSuccess: (r) => resolve(r && r.code),
        onFail: (e) => reject(new Error((e && (e.message || e.errorCode)) || '获取免登码失败')),
      });
    });
  });
}
// 登录成功统一入口（账号密码 / 免登共用）
function enterSystem(d) {
  sessionStorage.removeItem('wb_fnos_off');   // 登录成功即解除「退出后不自动免登」标记
  localStorage.setItem('wb_token', d.token);
  localStorage.setItem('wb_user', JSON.stringify(d.user));
  // 主题随账号：登录即应用该账号保存的主题
  if (d.theme) {
    localStorage.setItem('wb_theme', d.theme);
    document.documentElement.dataset.theme = d.theme;
  }
  router.push(route.query.redirect || '/');
}

let stars = [];
let raf = null;
let mouse = { x: -9999, y: -9999 };

function setupStars() {
  const canvas = cv.value;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const resize = () => {
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener('resize', resize);

  const count = Math.min(320, Math.floor(window.innerWidth * window.innerHeight / 3800));
  stars = Array.from({ length: count }, () => ({
    x: Math.random() * window.innerWidth,
    y: Math.random() * window.innerHeight,
    r: Math.random() * 1.6 + 0.4,
    a: Math.random() * 0.65 + 0.25,
    sp: Math.random() * 0.35 + 0.08,
    phase: Math.random() * Math.PI * 2,
    tw: Math.random() * 0.03 + 0.008,
    vx: 0, vy: 0,
    big: Math.random() < 0.12,
  }));

  const onMove = (e) => { mouse.x = e.clientX; mouse.y = e.clientY; };
  window.addEventListener('mousemove', onMove);
  window.addEventListener('touchmove', (e) => {
    if (e.touches[0]) { mouse.x = e.touches[0].clientX; mouse.y = e.touches[0].clientY; }
  }, { passive: true });

  const isLight = !isDark.value;
  const starColor = (a, big) => {
    if (big) return isLight ? `rgba(20,60,130,${a})` : `rgba(190,215,255,${a})`;
    return isLight ? `rgba(35,70,140,${a})` : `rgba(255,255,255,${a})`;
  };

  const tick = (t) => {
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    for (const s of stars) {
      const dx = mouse.x - s.x;
      const dy = mouse.y - s.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 170 && dist > 0.001) {
        // 星星被鼠标吸引，加速冲向鼠标 → 流星跟随效果
        const force = (170 - dist) / 170 * 0.9;
        s.vx += (dx / dist) * force * 1.6;
        s.vy += (dy / dist) * force * 1.6;
      } else {
        // 恢复自然浮动
        s.vx *= 0.94; s.vy *= 0.94;
      }
      s.x += s.vx + Math.sin(t * 0.0002 + s.phase) * 0.18;
      s.y += s.vy + s.sp;
      if (s.y > window.innerHeight + 6) { s.y = -6; s.x = Math.random() * window.innerWidth; s.vx = 0; s.vy = 0; }
      if (s.x < -6) s.x = window.innerWidth + 6;
      if (s.x > window.innerWidth + 6) s.x = -6;

      const alpha = s.a * (0.65 + 0.35 * Math.sin(t * s.tw + s.phase));
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fillStyle = starColor(alpha, s.big);
      ctx.fill();
      if (s.big) {
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r * 3, 0, Math.PI * 2);
        ctx.fillStyle = starColor(alpha * 0.18, false);
        ctx.fill();
      }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', resize);
    window.removeEventListener('mousemove', onMove);
  };
}

onMounted(() => {
  document.documentElement.dataset.theme = getTheme();
  isDark.value = getTheme() !== 'light';
  const cleanup = setupStars();
  onBeforeUnmount(() => cleanup());
  // 钉钉内打开：先试免登直接进系统
  if (inDingTalk) {
    requestDingCode()
      .then((code) => (code ? api.post('/auth/dingtalk/login', { code }) : null))
      .then((d) => { if (d && d.token) enterSystem(d); })
      .catch((e) => {
        // 未绑定：给出明确指引；其他失败（未配置/网络）保留登录表单即可用
        err.value = /尚未绑定/.test(e.message || '')
          ? e.message
          : '钉钉免登未生效：' + (e.message || '请直接账号密码登录');
      });
  }
  // 飞牛 fnOS 桌面内打开（统一网关 /app/... 前缀，v1.9.0）：NAS 登录态已被网关校验并注入可信用户头，
  // 先试免登直接进系统；失败（如直连 7777 端口无网关头）静默回退账号密码表单
  // wb_fnos_off：用户在本标签页主动退出过，先给账号密码表单（关标签重开即恢复免登，v1.9.1）
  if (location.pathname.startsWith('/app/') && !sessionStorage.getItem('wb_fnos_off')) {
    api.post('/auth/fnos-login', {})
      .then((d) => { if (d && d.token) enterSystem(d); })
      .catch(() => {});
  }
});

async function login() {
  if (!username.value || !password.value) { err.value = '请输入用户名和密码'; return; }
  loading.value = true;
  err.value = '';
  try {
    const d = await api.post('/auth/login', { username: username.value, password: password.value });
    // 钉钉内首次账号密码登录：顺手绑定免登（后台静默，失败不影响进入系统）
    if (inDingTalk) {
      requestDingCode()
        .then((code) => (code ? api.post('/auth/dingtalk/bind', { code }) : null))
        .catch(() => {});
    }
    enterSystem(d);
  } catch (e) {
    err.value = e.message;
  } finally {
    loading.value = false;
  }
}
</script>
