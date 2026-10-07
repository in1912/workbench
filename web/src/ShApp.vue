<template>
  <!-- JARVIS 独立应用外壳（v2.0.0）
       左侧 = 模块目录（原智能家居页的 6 个页签升格成侧栏条目）；
       右侧 = 该模块的内容，各模块内部的子页签（智能板 7 个 / 红绿灯 3 个）原样保留。
       业务实体全部复用 SmartHome.vue（layout="sidebar" 时它不画自己的 tab 条），所以没有第二份实现。 -->
  <div class="sh-shell">
    <div class="sh-topbar">
      <div class="sh-brand">
        <span class="sh-logo material-icons" aria-hidden="true">home</span>
        <span class="sh-title">{{ sysName }}</span>
        <span v-if="version" class="sh-ver">{{ version }}</span>
      </div>
      <div class="sh-topbar-right">
        <span class="sh-net" :class="netClass" :title="netTitle">{{ netText }}</span>
      </div>
    </div>

    <div class="sh-body">
      <aside class="sh-side">
        <nav class="sh-nav">
          <button v-for="m in MODULES" :key="m.key" class="sh-nav-item" :class="{ active: tab === m.key }" @click="pick(m.key)">
            <span class="sh-ico" aria-hidden="true" v-html="m.svg"></span>
            <span class="sh-label">{{ m.label }}</span>
            <span v-if="m.badge" class="sh-badge">{{ m.badge }}</span>
          </button>
        </nav>
        <div class="sh-side-foot">
          <span class="sh-hint">JARVIS</span>
        </div>
      </aside>

      <main class="sh-main">
        <div v-if="!ready" class="sh-loading">正在加载…</div>
        <SmartHome v-else layout="sidebar" v-model:tab="tab" />
      </main>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import SmartHome from './views/SmartHome.vue';
import { api } from './api';

// 侧栏模块 = 原智能家居页的 6 个页签，key 与后端 auth.js TAB_PATHS 的 tab key 完全一致
// （授权模型不用动：同一套 key，只不过从页内 tab 条搬到了左侧栏）
const MODULES = [
  {
    key: 'mijia', label: '米家',
    svg: '<svg viewBox="0 0 24 24"><path d="M12 3 2 11h3v9h5v-6h4v6h5v-9h3z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  },
  {
    key: 'dh', label: '数字人',
    svg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  },
  {
    // v1.12.4：原独立「AI 助手」页并入（LLM在线模型），与主工作台同一个 llm tab key
    key: 'llm', label: 'LLM在线模型',
    svg: '<svg viewBox="0 0 24 24"><rect x="3.5" y="4.5" width="17" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M8 20.5h8M12 16.5v4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  },
  {
    key: 'xiaozhi', label: '智能板',
    svg: '<svg viewBox="0 0 24 24"><rect x="9" y="2.5" width="6" height="11" rx="3" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3.5M8.5 21.5h7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  },
  {
    key: 'cclight', label: 'Agent红绿灯',
    svg: '<svg viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="3" fill="none" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="7" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor" opacity=".45"/><circle cx="12" cy="17" r="1.6" fill="currentColor" opacity=".45"/></svg>',
  },
  {
    key: 'settings', label: '米家设置',
    svg: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.5-2-3.5-2.4 1a7.7 7.7 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5a7.7 7.7 0 0 0-2.6 1.5l-2.4-1-2 3.5 2 1.5a7.6 7.6 0 0 0 0 3l-2 1.5 2 3.5 2.4-1a7.7 7.7 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.7 7.7 0 0 0 2.6-1.5l2.4 1 2-3.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  },
  {
    key: 'terms', label: '米家参数翻译',
    svg: '<svg viewBox="0 0 24 24"><path d="M3 5h8M7 3v2c0 4-2 7-4.5 8.5M5 9c1.2 2.6 3.6 4.4 6 5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="m12.5 21 4-11 4 11M14 17.5h5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  },
  {
    key: 'videocenter', label: '视频中心',
    svg: '<svg viewBox="0 0 24 24"><rect x="2.5" y="5" width="19" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M10.5 9.5 15.5 12l-5 2.5z" fill="currentColor"/></svg>',
  },
];

const tab = ref('mijia');
const ready = ref(false);
const sysName = ref('JARVIS');
const version = ref('');
const netText = ref('');
const netClass = ref('');
const netTitle = ref('');

function pick(k) {
  tab.value = k;
  try { localStorage.setItem('wb_sh_tab', k); } catch { /* 隐私模式忽略 */ }
}

// 网络/在线提示：独立应用跑在 NAS 上，用户最常遇到的问题是「NAS 没起来/被网关拦」，
// 顶栏给一个一眼可见的状态，比让他去翻控制台强。
async function probe() {
  try {
    const info = await api.get('/system-info');
    if (info && info.name) sysName.value = info.name;
    if (info && info.version) version.value = info.version;
    netText.value = '在线';
    netClass.value = 'ok';
    netTitle.value = `已连接${info && info.mode ? `（模式：${info.mode}）` : ''}`;
  } catch (e) {
    netText.value = '离线';
    netClass.value = 'bad';
    netTitle.value = '连不上服务：' + e.message;
  }
}

onMounted(async () => {
  try {
    const saved = localStorage.getItem('wb_sh_tab');
    if (saved && MODULES.some((m) => m.key === saved)) tab.value = saved;
  } catch { /* 忽略 */ }
  // 免登录应用：服务端已把内置本地账号注入到每个 /api 请求，这里把它落到 localStorage，
  // 让 tabs.js 的 canTab()/allowedTabs() 拿到正确的角色（管理员），子页签一个不少。
  try {
    const r = await api.get('/auth/me');
    if (r && r.user) localStorage.setItem('wb_user', JSON.stringify(r.user));
  } catch { /* 拿不到也不影响（tabs.js 对空用户按「不限制」处理） */ }
  probe();
  ready.value = true;
  document.title = 'JARVIS';
});
</script>

<style scoped>
.sh-shell { display: flex; flex-direction: column; height: 100vh; background: var(--bg); color: var(--text); }

.sh-topbar {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 0 18px; height: 52px; flex: none;
  background: var(--bg2); border-bottom: 1px solid var(--border);
}
.sh-brand { display: flex; align-items: center; gap: 9px; min-width: 0; }
.sh-logo { font-size: 21px; color: var(--accent); }
.sh-title { font-size: 16px; font-weight: 600; letter-spacing: .5px; }
.sh-ver { font-size: 12px; color: var(--text3); border: 1px solid var(--border); border-radius: 20px; padding: 0 8px; }
.sh-net { font-size: 12px; padding: 2px 10px; border-radius: 20px; border: 1px solid var(--border); color: var(--text3); }
.sh-net.ok { color: var(--green); border-color: color-mix(in srgb, var(--green) 45%, transparent); }
.sh-net.bad { color: var(--red); border-color: color-mix(in srgb, var(--red) 45%, transparent); }

.sh-body { display: flex; flex: 1; min-height: 0; }

/* 左侧模块目录：原来的 6 个页签，升格成侧栏条目 */
.sh-side {
  width: 208px; flex: none; display: flex; flex-direction: column;
  background: var(--bg2); border-right: 1px solid var(--border);
  padding: 12px 10px;
}
.sh-nav { display: flex; flex-direction: column; gap: 4px; flex: 1; overflow: auto; }
.sh-nav-item {
  display: flex; align-items: center; gap: 11px; width: 100%;
  padding: 10px 12px; border: 0; border-radius: 9px; cursor: pointer;
  background: transparent; color: var(--text2); font: inherit; font-size: 14px; text-align: left;
  transition: background .15s, color .15s;
}
.sh-nav-item:hover { background: var(--bg3); color: var(--text); }
.sh-nav-item.active { background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); font-weight: 600; }
.sh-ico { width: 21px; height: 21px; flex: none; display: inline-flex; }
.sh-ico :deep(svg) { width: 21px; height: 21px; }
.sh-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sh-badge { font-size: 11px; background: var(--accent); color: #fff; border-radius: 20px; padding: 0 7px; }
.sh-side-foot { padding: 10px 12px 4px; border-top: 1px solid var(--border); margin-top: 8px; }
.sh-hint { font-size: 11.5px; color: var(--text3); }

.sh-main { flex: 1; min-width: 0; overflow: auto; padding: 18px 22px 40px; }
.sh-loading { color: var(--text3); padding: 40px; text-align: center; }

/* 窄屏：侧栏收成横向标签条（独立应用也会被手机浏览器打开） */
@media (max-width: 720px) {
  .sh-body { flex-direction: column; }
  .sh-side { width: auto; border-right: 0; border-bottom: 1px solid var(--border); padding: 8px; }
  .sh-nav { flex-direction: row; overflow-x: auto; gap: 6px; }
  .sh-nav-item { width: auto; padding: 8px 12px; white-space: nowrap; }
  .sh-label { flex: none; }
  .sh-side-foot { display: none; }
  .sh-main { padding: 14px 12px 30px; }
}
</style>
