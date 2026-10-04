<template>
  <!-- 公开页（登录页 / 分享页）：全屏独立布局，不显示任何侧边栏/目录 -->
  <template v-if="isBare">
    <router-view />
  </template>

  <!-- 系统主布局 -->
  <template v-else>
    <div class="mobile-topbar">
      <div class="logo"><span class="dot"></span>{{ sysName }}<NetBadge /></div>
      <div class="row" style="gap:6px">
        <span class="muted" style="font-size:12px">{{ user?.username }}</span>
        <button class="hamburger" @click="menuOpen = !menuOpen" aria-label="菜单">☰</button>
      </div>
    </div>
    <div v-if="menuOpen" class="mobile-mask" @click="menuOpen = false"></div>

    <aside class="sidebar" :class="{ open: menuOpen }">
      <div class="logo"><span class="dot"></span>{{ sysName }}<NetBadge /></div>
      <nav class="nav">
        <router-link v-for="n in visibleNavs" :key="n.to" :to="n.to" @click="menuOpen = false">
          <span class="ico material-icons" aria-hidden="true">{{ n.icon }}</span>{{ n.label }}
        </router-link>
      </nav>
      <div class="sidebar-foot">
        <span class="muted">{{ user?.username }}（{{ user?.role === 'admin' ? '管理员' : '成员' }}）</span>
        <a class="link small" @click="logout" style="cursor:pointer">退出登录</a>
      </div>
    </aside>

    <main class="main">
      <div v-if="denied" class="msg err">当前账号无权访问该页面，请联系管理员授权</div>
      <router-view />
    </main>

    <!-- 全局悬浮电子宠物（有电子宠物页面权限才显示） -->
    <FloatingPet v-if="hasPets" />

    <!-- 短消息提醒：右下角方块弹窗（未读常驻显示，标记已读后才消失；在线期间每 60s 检查新消息） -->
    <div class="msg-toasts">
      <div v-for="t in toasts" :key="t.id" class="msg-toast" @click="openMessages(t)">
        <div class="row" style="justify-content:space-between; align-items:center; margin-bottom:4px">
          <span class="badge blue" style="font-size:11px">{{ t.module_label }}</span>
          <button class="toast-read" @click.stop="markReadToast(t)">已读</button>
        </div>
        <div style="font-size:13px; font-weight:600; margin-bottom:2px">{{ t.subject || '（无主题）' }}</div>
        <div class="muted" style="font-size:11.5px; margin-bottom:4px">{{ t.from_name }} · {{ t.created_at }}</div>
        <div style="font-size:12.5px; white-space:pre-wrap; word-break:break-word; max-height:96px; overflow:hidden">
          <template v-if="t.is_voice">🎤 语音 {{ Math.ceil(t.voice_secs || 1) }}"<span v-if="t.voice_text"> · {{ t.voice_text.slice(0, 80) }}</span></template>
          <template v-else>{{ plainText(t.content) }}</template>
        </div>
      </div>
    </div>

    <!-- 全局搜索悬浮框（v1.7.0）：最右下角短输入框 + 搜索按钮，直达效率工具的全局搜索 tab；
         空输入点搜索 = 进搜索页；带词回车/点按钮 = 进页并自动执行搜索 -->
    <div v-if="canGlobalSearch" class="float-search">
      <input v-model="gsQ" placeholder="全局搜索…" @keyup.enter="goSearch" />
      <button title="全局搜索" @click="goSearch">🔍</button>
    </div>

    <!-- 升级自愈提示：常驻 webview（钉钉工作台等）里的旧前端检测到服务端已升级，提示后自动刷新加载新包 -->
    <div v-if="upgradeTip" class="upgrade-tip">⬆ {{ upgradeTip }}</div>

    <!-- 图片查看器：内容区（.rich）里的图片单击放大；滚轮缩放、拖动移动、点击空白或 Esc 关闭 -->
    <div v-if="viewer.show" class="img-viewer" @wheel.prevent="viewerWheel"
         @pointerdown="viewerDown" @pointermove="viewerMove" @pointerup="viewerUp" @pointercancel="viewerUp">
      <img :src="viewer.src" draggable="false"
           :style="{ transform: `translate(${viewer.x}px, ${viewer.y}px) scale(${viewer.s})` }" />
      <span class="iv-scale">{{ Math.round(viewer.s * 100) }}%</span>
      <div class="iv-tip">滚轮缩放 · 拖动移动 · 点击空白或 Esc 关闭</div>
    </div>
  </template>
</template>

<script setup>
import { ref, reactive, computed, onMounted, watch } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { api } from './api';
import { NAV_ITEMS, sortByOrder } from './nav';
import FloatingPet from './components/FloatingPet.vue';
import NetBadge from './components/NetBadge.vue';
import { probeLocalBase } from './utils/localBase';
import { sysName, setSysInfo } from './sysname';
import { plainText } from './utils/rich';
import { canTab } from './tabs';

const router = useRouter();
const route = useRoute();
// 公开页 = 路由 meta.public（登录页 + 笔记分享页 #/s/:token，v1.9.39）。这类页面渲染裸布局。
const isBare = computed(() => !!route.meta.public);
const menuOpen = ref(false);

// 标签页标题跟随系统名称/路由即时更新（设置页改名后无需刷新；原 router.afterEach 的标题逻辑收拢到这里）
watch([sysName, () => route.meta.title], () => {
  document.title = (route.meta.title || sysName.value) + ' · ' + sysName.value;
}, { immediate: true });

// 页面排序：localStorage 缓存先行渲染，登录后以服务端为准（设置页保存时也会广播事件即时更新）
const pageOrder = ref((() => {
  try { return JSON.parse(localStorage.getItem('wb_page_order') || '[]') || []; } catch { return []; }
})());
// 菜单改名：page → 自定义中文名（localStorage 缓存先行，登录后以服务端为准）
const pageLabels = ref((() => {
  try { return JSON.parse(localStorage.getItem('wb_page_labels') || '{}') || {}; } catch { return {}; }
})());

onMounted(async () => {
  // 设置页保存排序后广播，侧边栏即时重排（无需刷新）
  window.addEventListener('wb-nav-order', (e) => {
    pageOrder.value = Array.isArray(e.detail) ? e.detail : [];
  });
  window.addEventListener('wb-nav-labels', (e) => {
    pageLabels.value = (e.detail && typeof e.detail === 'object') ? e.detail : {};
  });
  // 图片查看器：事件委托——内容区（.rich 容器）里任意图片单击即放大（列表富文本/消息气泡全覆盖）
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.tagName === 'IMG' && t.closest && t.closest('.rich') && !viewer.show) openViewer(t.src);
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && viewer.show) viewer.show = false; });
  try {
    const info = await api.get('/system-info');
    setSysInfo(info.name, info.name_en); // 共享来源：头部 logo 与标签页标题同步更新
    if (info.version) bootVersion.value = info.version; // 版本看门狗基线
  } catch (e) { /* 默认名称 */ }
  try {
    if (localStorage.getItem('wb_token')) {
      // 刷新本地用户信息：管理员改过页面/tab 授权后，不重新登录也能拿到最新权限
      try {
        const me = await api.get('/auth/me');
        if (me.user) { localStorage.setItem('wb_user', JSON.stringify(me.user)); userTick.value++; }
        // 外观主题随账号：服务端保存值优先（换浏览器/设备登录同一账号也跟随）
        if (me.theme) {
          localStorage.setItem('wb_theme', me.theme);
          document.documentElement.dataset.theme = me.theme;
        }
      } catch { /* 过期由 401 处理器统一跳登录 */ }
      const d = await api.get('/nav-order');
      if (Array.isArray(d.order)) {
        pageOrder.value = d.order;
        localStorage.setItem('wb_page_order', JSON.stringify(d.order));
      }
      if (d.labels && typeof d.labels === 'object') {
        pageLabels.value = d.labels;
        localStorage.setItem('wb_page_labels', JSON.stringify(d.labels));
      }
      // 本地直连：登录后即后台探测设置的内网地址（不阻塞界面），可达则学习页大文件自动走内网
      probeLocalBase();
      // 新邮件提示音开关（邮箱页「邮箱设置」里配置；无邮箱设置权限的成员静默跳过）
      try { const n = await api.get('/emails/notify'); emailSoundOn.value = !!n.sound; } catch {}
    }
  } catch (e) { /* 保持缓存 */ }
  // 消息提醒：每 20s 轮询新消息（登录瞬间由 watch(isLogin) 立即触发一次）
  setInterval(checkUnread, 20000);
  // 版本看门狗：每 5 分钟对比一次服务端版本（切回前台时也会立即查，见下方 visibilitychange）
  setInterval(checkVersion, 5 * 60 * 1000);
  // 切回浏览器标签页时立即检查一次，避免等待轮询；顺带补测本地直连（缓存 TTL 内不发请求）
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    checkVersion();
    if (localStorage.getItem('wb_token')) { checkUnread(); probeLocalBase(); }
  });
  // 消息页/家庭页发送或推送后广播，立即检查未读（发给自己=备忘时右下角马上弹出）
  window.addEventListener('wb-messages-check', () => checkUnread());
  // 消息页标记已读后广播（detail: {ids:[...]} 或 {all:true}），即时移除对应弹窗
  window.addEventListener('wb-messages-read', (e) => {
    const d = e.detail || {};
    if (d.all) toasts.value = [];
    else if (Array.isArray(d.ids)) toasts.value = toasts.value.filter((t) => !d.ids.includes(t.id));
  });
});

// ---------- 版本看门狗（升级自愈）----------
// 钉钉工作台/常驻标签页里的页面不会自己重新加载：服务端升级后，旧前端包继续在跑，
// 表现为「新功能不存在/行为不对」。这里定期对比 /api/system-info 的版本号，发现服务端已升级
// 就提示并自动刷新页面（首次加载记录基线；刷新后基线更新，不会循环）。
const bootVersion = ref('');
const upgradeTip = ref('');
let versionReloadTimer = null;
async function checkVersion() {
  try {
    const info = await api.get('/system-info');
    if (!info.version) return;
    if (!bootVersion.value) { bootVersion.value = info.version; return; } // 首次记录基线
    if (info.version !== bootVersion.value && !versionReloadTimer) {
      upgradeTip.value = `系统已升级到 ${info.version}，3 秒后自动刷新页面…`;
      versionReloadTimer = setTimeout(() => location.reload(), 3000);
    }
  } catch { /* 网络失败下次轮询再查 */ }
}

// ---------- 图片查看器（滚轮缩放 + 拖动平移；点击/悬停区分：按住拖动=平移，原地单击=关闭） ----------
const viewer = reactive({ show: false, src: '', x: 0, y: 0, s: 1 });
let viewerDrag = null; // { sx, sy, ox, oy, moved }
function openViewer(src) { viewer.show = true; viewer.src = src; viewer.x = 0; viewer.y = 0; viewer.s = 1; }
function viewerWheel(e) { viewer.s = Math.min(12, Math.max(0.15, viewer.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); }
function viewerDown(e) {
  viewerDrag = { sx: e.clientX, sy: e.clientY, ox: viewer.x, oy: viewer.y, moved: 0 };
  e.preventDefault();
}
function viewerMove(e) {
  if (!viewerDrag) return;
  viewer.x = viewerDrag.ox + (e.clientX - viewerDrag.sx);
  viewer.y = viewerDrag.oy + (e.clientY - viewerDrag.sy);
  viewerDrag.moved = Math.max(viewerDrag.moved, Math.abs(e.clientX - viewerDrag.sx) + Math.abs(e.clientY - viewerDrag.sy));
}
function viewerUp() {
  const d = viewerDrag;
  viewerDrag = null;
  if (d && d.moved < 5) viewer.show = false; // 没拖动过 = 原地单击 → 关闭
}

// ---------- 短消息弹窗（右下角，未读常驻，已读才消失） ----------
const toasts = ref([]);
const shownMsgIds = new Set(); // 已弹过的消息（避免轮询重复弹）
const emailSoundOn = ref(false); // 新邮件提示音（邮箱设置里配置；弹出新邮件提醒时播放）
function checkUnread() {
  if (!localStorage.getItem('wb_token')) return;
  api.get('/messages/unread')
    .then((d) => {
      const list = d.messages || [];
      // 对账：已通过其他途径（消息页等）标为已读的消息，弹窗同步移除
      const live = new Set(list.map((m) => m.id));
      toasts.value = toasts.value.filter((t) => live.has(t.id));
      // 未读消息常驻显示（不自动消失、不限条数；标记已读后才移除）
      for (const m of list.slice().reverse()) {
        if (shownMsgIds.has(m.id)) continue;
        shownMsgIds.add(m.id);
        toasts.value.push(m);
        // 新邮件提醒弹窗 → 按用户设置播提示音（v1.7.0 任务8）
        if (m.module === 'email' && emailSoundOn.value) beep();
      }
    })
    .catch(() => {});
}
// 新邮件提示音：WebAudio 双音（叮-叮），无需音频文件
let audioCtx = null;
function beep() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.type = 'sine';
    o.frequency.setValueAtTime(880, t0);
    o.frequency.setValueAtTime(1174.66, t0 + 0.18);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.2, t0 + 0.02);
    g.gain.setValueAtTime(0.2, t0 + 0.18);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
    o.start(t0);
    o.stop(t0 + 0.55);
  } catch { /* 无音频环境（如静音策略）则跳过 */ }
}
// 公开页 ↔ 主布局切换：App 不会重新挂载，需手动触发（immediate 覆盖带 token 直接打开/刷新页面的情况）
watch(isBare, (barePage) => {
  if (barePage) {
    toasts.value = [];      // 退出登录清空弹窗
    shownMsgIds.clear();
  } else {
    checkUnread();          // 登录成功进入主布局，立即弹出未读
    probeLocalBase();       // 登录后探测内网直连（换账号/重新登录也重新走一遍）
  }
}, { immediate: true });
// 点「已读」：服务端标记已读并移除弹窗（唯一的消失方式）
function markReadToast(t) {
  api.post(`/messages/${t.id}/read`)
    .then(() => { dismissToast(t.id); })
    .catch(() => {});
}
function dismissToast(id) {
  const i = toasts.value.findIndex((t) => t.id === id);
  if (i >= 0) toasts.value.splice(i, 1);
}
function openMessages(t) {
  dismissToast(t.id); // 打开会话即视为已读（服务端自动标记），事件对账兜底
  // 按消息来源模块直达对应页面（v1.7.0：新邮件点弹窗直达邮箱页对应账号 tab）
  if (t.module === 'email') router.push({ path: '/email', query: t.ext_id ? { acc: t.ext_id } : {} });
  // 录音转写完成（v1.9.39）→ 直达该录音笔记页（ref_id = vibe_records.id）
  else if (t.module === 'vibe') router.push(`/notes/rec/${t.ref_id}`);
  else if (t.module === 'kids') router.push('/family?tab=kids');
  else if (t.module === 'family') router.push('/family');
  else router.push('/messages');
}

// ---------- 全局搜索悬浮框（右下角，v1.7.0） ----------
const gsQ = ref('');
const canGlobalSearch = computed(() => {
  route.fullPath; userTick.value; // 依赖：路由/用户信息变化时重算
  const u = user.value;
  if (!u) return false;
  if (u.role === 'admin') return true;
  const allowed = u.allowed_pages || [];
  if (allowed.length && !allowed.includes('tools')) return false; // 没有效率工具页权限
  return canTab('tools', 'search');
});
function goSearch() {
  const q = gsQ.value.trim();
  router.push({ path: '/tools', query: { tab: 'search', ...(q ? { q } : {}) } });
}

// localStorage 非响应式：依赖 route.fullPath + userTick（boot 刷新 wb_user 后手动 +1），
// 否则受限成员 F5 时首次求值为 null → 显示全量菜单，boot 写回后不触发重算（v1.3.5 修复）
const userTick = ref(0);
const user = computed(() => {
  route.fullPath; userTick.value;
  try { return JSON.parse(localStorage.getItem('wb_user') || 'null'); } catch { return null; }
});
const denied = computed(() => !!route.query.denied);
// 悬浮宠物与电子宠物页共用 'pets' 页面权限
const hasPets = computed(() => {
  const u = user.value;
  if (!u) return false;
  if (u.role === 'admin') return true;
  const allowed = u.allowed_pages || [];
  return !allowed.length || allowed.includes('pets');
});

const allNavs = NAV_ITEMS;

const visibleNavs = computed(() => {
  const u = user.value;
  let list = allNavs;
  if (u && u.role !== 'admin') {
    const allowed = u.allowed_pages || [];
    if (allowed.length) list = allNavs.filter((n) => !n.adminOnly && allowed.includes(n.page));
  }
  // 菜单改名：有自定义名用自定义名，否则用默认 label
  return sortByOrder(list, pageOrder.value).map((n) => {
    const lbl = pageLabels.value[n.page];
    return lbl ? { ...n, label: lbl } : n;
  });
});

function logout() {
  localStorage.removeItem('wb_token');
  localStorage.removeItem('wb_user');
  // fnOS 网关免登场景（v1.9.1）：退出后本标签页不再自动用 NAS 账号重登（sessionStorage 关标签即失效，
  // 重新从飞牛桌面打开恢复免登）；手动账号密码登录成功时会在 enterSystem 里清掉该标记
  if (location.pathname.startsWith('/app/')) sessionStorage.setItem('wb_fnos_off', '1');
  router.push('/login');
}
</script>

<style scoped>
.msg-toasts { position: fixed; right: 16px; bottom: 76px; z-index: 1200; display: flex; flex-direction: column; gap: 10px;
  max-width: 92vw; max-height: calc(100vh - 150px); overflow-y: auto; }
/* 全局搜索悬浮框（最右下角；消息弹窗在其上方让位） */
.float-search { position: fixed; right: 16px; bottom: 16px; z-index: 1150; display: flex; align-items: center;
  background: var(--bg2); border: 1px solid var(--border); border-radius: 10px; padding: 4px;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.25); }
.float-search input { border: none; background: transparent; color: var(--text); width: 132px; font-size: 12.5px;
  padding: 5px 8px; outline: none; border-radius: 7px; }
.float-search input:focus { background: var(--bg3, rgba(0, 0, 0, 0.12)); }
.float-search button { border: none; background: rgba(79, 124, 247, 0.16); color: var(--text); border-radius: 7px;
  padding: 5px 11px; cursor: pointer; font-size: 13px; flex-shrink: 0; }
.float-search button:hover { background: rgba(79, 124, 247, 0.3); }
.msg-toast { width: 300px; padding: 12px 14px; border-radius: 10px; border: 1px solid var(--border);
  background: var(--bg2); box-shadow: 0 6px 24px rgba(0,0,0,0.25); cursor: pointer; flex-shrink: 0; }
.toast-read { background: rgba(79, 124, 247, 0.16); border: 1px solid rgba(79, 124, 247, 0.4); color: var(--text);
  cursor: pointer; font-size: 11.5px; padding: 2px 10px; border-radius: 6px; }
.toast-read:hover { background: rgba(79, 124, 247, 0.3); }
.msg-toast:hover { border-color: rgba(79, 124, 247, 0.5); }
.upgrade-tip { position: fixed; left: 50%; bottom: 22px; transform: translateX(-50%); z-index: 1300;
  background: rgba(20, 22, 28, 0.92); color: #fff; font-size: 13px; padding: 9px 18px; border-radius: 10px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.35); max-width: 88vw; text-align: center; }
.img-viewer { position: fixed; inset: 0; z-index: 2000; background: rgba(0, 0, 0, 0.85);
  display: flex; align-items: center; justify-content: center; overflow: hidden;
  cursor: grab; user-select: none; touch-action: none; }
.img-viewer:active { cursor: grabbing; }
.img-viewer img { max-width: 92vw; max-height: 90vh; border-radius: 4px;
  -webkit-user-drag: none; pointer-events: none; /* 拖动/点击统一由遮罩层接管 */ }
.iv-scale { position: absolute; top: 14px; right: 18px; color: rgba(255, 255, 255, 0.9); font-size: 13px;
  background: rgba(0, 0, 0, 0.45); padding: 2px 10px; border-radius: 6px; }
.iv-tip { position: absolute; bottom: 18px; left: 50%; transform: translateX(-50%); color: rgba(255, 255, 255, 0.7); font-size: 12.5px; }
</style>
