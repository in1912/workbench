<template>
  <div class="multi-panel">
    <div class="mp-subtabs">
      <button :class="{ on: sub === 'share' }" @click="sub = 'share'">🔗 分享访问</button>
      <button :class="{ on: sub === 'tv' }" @click="sub = 'tv'">📺 电视版</button>
    </div>

    <!-- ---------- 子页 1：分享访问 ---------- -->
    <template v-if="sub === 'share'">
      <div class="card">
        <h3>分享给平板 / 手机浏览器</h3>
        <div class="zone-line">
          <span class="badge" :class="zone === 'lan' ? 'green' : 'blue'">{{ zone === 'lan' ? '🏠 当前在内网环境' : '🌐 当前在外网环境' }}</span>
          <span class="muted zone-tip">{{ zone === 'lan'
            ? '现在用局域网地址访问，分享时优先给内网地址（速度快）；对方出门在外时用外网地址。'
            : '现在通过外网地址访问，分享时优先给外网地址（哪里都能打开）；对方在家时内网地址更快。' }}</span>
        </div>

        <!-- 内网地址 -->
        <div class="addr-row" :class="{ cur: zone === 'lan' }">
          <div class="grow">
            <div class="addr-kind"><span class="badge green">内网地址</span>{{ zone === 'lan' ? '当前通道 · 局域网内速度最快' : '家里/同一 WiFi 下使用' }}</div>
            <code class="addr-text">{{ lanUrl || '（未获取：在内网环境打开本页会自动显示，或由管理员在本页下方「地址配置」填写内网直连地址）' }}</code>
          </div>
          <button v-if="lanUrl" class="small" @click="copyIt(lanUrl, 'lan')">{{ copied === 'lan' ? '✓ 已复制' : '⧉ 复制链接' }}</button>
        </div>

        <!-- 外网地址 -->
        <div class="addr-row" :class="{ cur: zone === 'wan' }">
          <div class="grow">
            <div class="addr-kind"><span class="badge blue">外网地址</span>{{ zone === 'wan' ? '当前通道 · 任何网络都能打开' : '出门在外（4G/公司网络）使用' }}</div>
            <code class="addr-text">{{ wanUrl || '（未配置：管理员在本页下方「地址配置」填写外网地址，如花生壳/内网穿透域名）' }}</code>
          </div>
          <button v-if="wanUrl" class="small" @click="copyIt(wanUrl, 'wan')">{{ copied === 'wan' ? '✓ 已复制' : '⧉ 复制链接' }}</button>
        </div>

        <div class="tip-card">
          <b>iPad / 手机打开方式（两种）：</b>
          <div class="tip-item">① <b>微信/钉钉里收到链接</b>：点开多半只能看个封面或提示要复制——按住链接 →「拷贝」，再打开 Safari / Chrome 浏览器（iPad 请用系统自带 Safari），把地址<b>粘贴到浏览器地址栏</b>访问；</div>
          <div class="tip-item">② <b>直接抄地址</b>：把上面的地址（带 http:// 前缀完整抄写）输入到浏览器地址栏打开。</div>
          <div class="muted" style="margin-top:6px">两个地址都能进同一个工作台、账号密码与电脑端一致。在家优先内网地址；在外面（4G、公司网络）用外网地址。</div>
        </div>
      </div>

      <!-- 管理员：地址配置（外网地址 + 内网直连地址，保存即生效全站） -->
      <div v-if="isAdmin" class="card">
        <h3>地址配置（管理员）</h3>
        <div class="cfg-row">
          <label>外网地址（花生壳 / 内网穿透域名，出门在外访问用）</label>
          <div class="cfg-line">
            <input v-model="cfgExternal" placeholder="https://xxx.vicp.fun（留空 = 清除）" />
            <button class="small" :disabled="cfgBusy" @click="saveExternal">{{ cfgBusy ? '保存中…' : '保存' }}</button>
          </div>
        </div>
        <div class="cfg-row">
          <label>内网直连地址（家里 / 同一 WiFi 访问用，也是视频教学大文件加速地址）</label>
          <div class="cfg-line">
            <input v-model="cfgLan" placeholder="http://192.168.x.x:3000（留空 = 清除）" />
            <button class="small" :disabled="cfgBusy" @click="saveLan">{{ cfgBusy ? '保存中…' : '保存' }}</button>
          </div>
        </div>
        <p class="muted" style="font-size:12px; margin-top:8px">格式：http(s)://域名或IP[:端口]，不带路径。内网地址填本机局域网 IP（当前访问地址 {{ locationOrigin }} 可参考）。</p>
      </div>
    </template>

    <!-- ---------- 子页 2：电视版 ---------- -->
    <template v-else>
      <div class="card">
        <h3>安卓电视版 APP（横屏 · 遥控器操作）</h3>
        <p class="muted" style="line-height:1.8; margin-bottom:10px">
          在安卓电视 / 电视盒子（如当贝、小米、腾讯极光等安卓系统设备）上安装本 APP，
          用遥控器的 <b>上下左右</b> 方向键移动蓝色焦点、<b>确定键</b> 点按进入，
          工作台的页面都能在电视大屏上操作（学习、家庭事项、待办……）。
        </p>
        <div class="t-row">
          <a class="primary dl" href="/tv/family-learning-tv.apk" download="family-learning-tv.apk">⬇ 下载电视版 APK</a>
          <span class="muted" style="font-size:12px">（也可复制本页地址到电视浏览器直接下载；APK 约 50KB，极小）</span>
        </div>
        <div class="tip-card">
          <b>安装步骤：</b>
          <div class="tip-item">① 把 APK 拷到 U 盘 → 插电视 → 用电视自带的「文件管理 / 媒体中心」找到 APK 安装（需在设置里允许安装未知来源应用）；</div>
          <div class="tip-item">② 或在电视上打开自带浏览器，输入上面的分享地址 + /tv/family-learning-tv.apk 直接下载安装；</div>
          <div class="tip-item">③ 首次打开 APP 会要求填服务器地址——就是本页「分享访问」里的地址（内网优先），填好确定即进入登录页。</div>
          <div class="muted" style="margin-top:6px">遥控器操作：方向键移动焦点（蓝色高亮框）、确定键点击、返回键后退/关闭弹窗。键盘/飞鼠可直接打字登录。</div>
        </div>
        <div class="tv-preview">
          <button class="small" @click="toggleTv">{{ tvOn ? '⏹ 退出电视模式预览' : '▶ 在本机预览电视模式' }}</button>
          <span class="muted" style="font-size:12px">预览 = 用键盘方向键代替遥控器试操作（↑↓←→移动焦点、回车确定、Esc 返回），体验与电视上一致。</span>
        </div>
      </div>
    </template>

    <!-- 电视模式预览的退出按钮（跨页面常驻，仅浏览器手动预览时显示） -->
    <button v-if="tvOn && manualTv" class="tv-exit-btn" @click="toggleTv">退出电视模式</button>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue';
import { api } from '../api';
import { netZone } from '../utils/netZone';
import { startTvNav, stopTvNav, tvModeOn } from '../utils/tvNav';

const props = defineProps({ isAdmin: { type: Boolean, default: false } });

const sub = ref('share');
const addr = ref({ external: '', lan: '' });
const copied = ref('');
const cfgExternal = ref('');
const cfgLan = ref('');
const cfgBusy = ref(false);
let copyTimer = null;

// 内外网判定（netZone + 外网地址精确匹配）：当前访问源 == 配置的外网地址 → 外网
const zone = computed(() => {
  if (addr.value.external && location.origin === addr.value.external) return 'wan';
  return netZone();
});
// 内网地址：在内网环境打开时就是当前地址；在外网时读管理员配置的内网直连地址
const lanUrl = computed(() => (zone.value === 'lan' ? location.origin : addr.value.lan || ''));
// 外网地址：优先管理员配置；当前就在外网访问时当前地址即外网地址
const wanUrl = computed(() => addr.value.external || (zone.value === 'wan' ? location.origin : ''));
const locationOrigin = location.origin;

// 复制：优先剪贴板 API（https/localhost），http 局域网是非安全上下文没有该 API → execCommand 兜底
async function copyIt(text, tag) {
  let ok = false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch { /* 落到兜底 */ }
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    document.body.removeChild(ta);
  }
  if (ok) {
    copied.value = tag;
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { copied.value = ''; }, 2000);
  } else {
    alert('复制失败：请长按/选中上方地址手动复制：\n' + text);
  }
}

async function saveExternal() {
  cfgBusy.value = true;
  try {
    await api.post('/settings/external-base', { external: cfgExternal.value });
    addr.value.external = cfgExternal.value.trim().replace(/\/+$/, '');
  } catch (e) { alert(e.message || '保存失败'); }
  cfgBusy.value = false;
}
async function saveLan() {
  cfgBusy.value = true;
  try {
    await api.post('/settings/local-base', { base: cfgLan.value });
    addr.value.lan = cfgLan.value.trim().replace(/\/+$/, '');
  } catch (e) { alert(e.message || '保存失败'); }
  cfgBusy.value = false;
}

// ---------- 电视模式预览 ----------
const tvOn = ref(tvModeOn());
const manualTv = ref(localStorage.getItem('wb_tv_mode') === '1');
function toggleTv() {
  if (tvOn.value) {
    localStorage.removeItem('wb_tv_mode');
    stopTvNav();
    tvOn.value = false;
    manualTv.value = false;
  } else {
    localStorage.setItem('wb_tv_mode', '1');
    startTvNav();
    tvOn.value = true;
    manualTv.value = true;
  }
}

onMounted(async () => {
  try {
    addr.value = await api.get('/settings/external-base');
    cfgExternal.value = addr.value.external || '';
    cfgLan.value = addr.value.lan || '';
  } catch { /* 读不到就当未配置 */ }
});
</script>

<style scoped>
.multi-panel { display: flex; flex-direction: column; gap: 12px; }
.mp-subtabs { display: flex; gap: 6px; flex-wrap: wrap; }
.mp-subtabs button { background: var(--bg3); color: var(--text2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 16px; font-size: 13.5px; cursor: pointer; }
.mp-subtabs button.on { color: var(--accent); border-color: var(--accent); font-weight: 600; }
.zone-line { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px; }
.zone-tip { font-size: 12.5px; }
.addr-row { display: flex; align-items: center; gap: 12px; padding: 12px; border: 1px solid var(--border); border-radius: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.addr-row.cur { border-color: var(--green); box-shadow: 0 0 0 1px var(--green) inset; }
.addr-kind { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--text3); margin-bottom: 6px; }
.addr-text { display: block; font-size: 14.5px; word-break: break-all; user-select: all; }
.tip-card { margin-top: 6px; padding: 12px; border: 1px dashed var(--border); border-radius: 8px; background: var(--bg3); font-size: 13px; line-height: 1.9; }
.tip-item { margin-top: 2px; }
.t-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 10px 0; }
.tv-preview { margin-top: 10px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.cfg-row { margin-bottom: 12px; }
.cfg-row label { display: block; font-size: 13px; color: var(--text2); margin-bottom: 6px; }
.cfg-line { display: flex; gap: 8px; }
.cfg-line input { flex: 1; background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 13.5px; font-family: inherit; }
.primary.dl { display: inline-block; background: var(--accent); color: #fff; border: none; border-radius: 8px; padding: 9px 22px; font-size: 13.5px; cursor: pointer; text-decoration: none; }
.small { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 8px 14px; font-size: 13px; cursor: pointer; white-space: nowrap; }
.badge.green { color: var(--green); border: 1px solid var(--green); }
.badge.blue { color: #3b82f6; border: 1px solid #3b82f6; }
.badge { border-radius: 10px; padding: 2px 10px; font-size: 11.5px; }
</style>
