<template>
  <div class="fnos-panel">
    <div v-if="msg" class="msg" :class="msgType">{{ msg }}</div>

    <!-- ============ 下载安装包（页面最上方） ============ -->
    <div class="card">
      <h3>📦 飞牛 fnOS 应用安装包</h3>
      <template v-if="info && info.available">
        <div class="row" style="flex-wrap:wrap; gap:10px; align-items:center; margin-bottom:10px">
          <button class="primary" :disabled="downloading" @click="dl">
            {{ downloading ? '下载中（23MB，稍候）...' : '⬇ 下载 fpk 安装包' }}
          </button>
          <span class="badge blue">{{ info.version || '最新' }}</span>
          <span class="muted" style="font-size:12.5px">{{ fmtSize(info.size) }} · {{ fmtDate(info.mtime) }} · {{ info.file }}</span>
        </div>
        <!-- 当前访问通道：内网走内网地址、外网走外网地址（同源下载自动跟随当前页面地址） -->
        <div class="kv"><span>当前访问通道</span><b>
          <span class="badge" :class="net.kind === '内网直连' ? 'green' : 'blue'">{{ net.kind }}</span>
          <span style="margin-left:6px">{{ net.origin }}</span>
        </b></div>
        <div class="kv"><span>下载地址（当前通道）</span><b style="font-size:12px; word-break:break-all">{{ dlUrl }}</b></div>
        <div class="muted" style="font-size:12px; margin-top:8px">
          下载链接自动跟随你打开本页的地址：在内网浏览器打开（如 <code>http://192.168.x.x:3000</code>）即走内网直连，在外网打开（如域名 https:// 地址）即走外网——内网下载更快。把上面的下载地址复制到内网其它设备浏览器（已登录工作台）也可直接下载。
        </div>
      </template>
      <div v-else-if="info" class="msg" style="background:rgba(230,162,60,.15); color:var(--orange,#e6a23c); border:1px solid var(--orange,#e6a23c)">
        当前部署（fnOS 应用）未内置 fpk 安装包——应用包自身不含安装包文件（避免包中套包逐版翻倍）。请到电脑 / 服务器版工作台的同一页面下载，或从源码仓库 <code>server/fnos/</code> 目录获取；下方安装步骤与介绍照常适用。
      </div>
      <div v-else class="muted">正在读取安装包信息…</div>
    </div>

    <!-- ============ 安装步骤 ============ -->
    <div class="card">
      <h3>🛠 安装步骤（在你的飞牛 NAS 上）</h3>
      <div class="muted" style="font-size:12.5px; margin-bottom:10px">方式 A · 应用中心图形界面（推荐）。已装过旧版本的话，直接安装新版 fpk 即可完成升级——数据在 <code>@appdata</code> 不受影响，无需卸载。</div>
      <ol style="margin:0 0 10px 20px; line-height:2">
        <li>点击上方按钮下载 fpk 安装包，把文件拷到 NAS（文件管理上传 / SMB 均可）</li>
        <li>fnOS 桌面 → <b>应用中心</b> → 手动安装（本地安装）→ 选择下载的 <code>全能工作台-飞牛应用-*.fpk</code></li>
        <li>按安装向导填写：初始管理员账号密码 + NAS 普通成员自动开号的默认权限（全部页面 / 无权限）</li>
        <li>安装（自动拉起 <code>nodejs_v22</code> 运行时依赖）→ 桌面双击「全能工作台」图标即用</li>
      </ol>
      <div class="muted" style="font-size:12.5px">
        备用直连：应用同时监听 <b>7777</b> 端口，局域网可直接访问 <code>http://NAS内网IP:7777</code>（走工作台自己的账号密码，不经过 NAS 免登）。
        升级后若提示「NAS 会话已失效」：新开标签页登录一下 NAS 网页（或从飞牛桌面重新进入应用）再刷新本页即可——那是 NAS 登录态过期，不是故障。
      </div>
    </div>

    <!-- ============ 基本介绍 ============ -->
    <div class="card">
      <h3>ℹ️ 这是什么</h3>
      <div class="muted" style="font-size:12.5px; margin-bottom:8px">按飞牛应用开放平台规范制作的 fnOS 应用包：应用中心一键安装，桌面出现「全能工作台」图标，工作台全部模块原样嵌入，并做了三层官方集成：</div>
      <ol style="margin:0 0 10px 20px; line-height:2">
        <li><b>统一网关</b>（官方推荐接入）：桌面入口走 <code>https://你的NAS域名/app/qgworkbench</code>，复用 NAS 访问域名与 HTTPS</li>
        <li><b>NAS 账号免登</b>：网关校验 NAS 登录态后注入可信用户头，工作台按用户名自动开号（NAS 管理员 → 工作台 admin，普通成员 → user），从桌面点开即用</li>
        <li><b>端口服务</b>：同时监听 7777 端口供局域网直连，与 NAS 上其它应用互不冲突</li>
      </ol>
      <div class="muted" style="font-size:12px">SQLite 存储、数据全在 NAS 本地（<code>@appdata</code>）；源码与说明见项目 README。</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';

// 服务端内置的最新 fpk 信息（server/fnos/*.fpk）
const info = ref(null);
const downloading = ref(false);
const msg = ref('');
const msgType = ref('ok');

// 内网/外网判定：私有网段/本机名=内网直连，域名=外网；飞牛桌面入口单独标注
const net = computed(() => {
  const h = location.hostname;
  if (location.pathname.startsWith('/app/')) return { kind: '飞牛桌面（NAS 本机）', origin: location.origin + location.pathname.replace(/\/$/, '') };
  const lan = /^(localhost|127\.|0\.0\.0\.0$)|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^fe80:|^f[cd][0-9a-f]{2}:/.test(h) || !h.includes('.');
  return { kind: lan ? '内网直连' : '外网（域名）', origin: location.origin };
});
const dlUrl = computed(() => net.value.origin + '/api/fnos/package');

const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');
const fmtDate = (s) => new Date(s).toLocaleDateString('zh-CN');

async function dl() {
  downloading.value = true;
  try {
    await api.download('/fnos/package', info.value?.file || 'workbench.fpk');
    msg.value = '下载已开始（浏览器保存到下载目录）'; msgType.value = 'ok';
  } catch (e) {
    msg.value = '下载失败：' + e.message; msgType.value = 'err';
  } finally {
    downloading.value = false;
  }
}

onMounted(async () => {
  try { info.value = await api.get('/fnos/info'); }
  catch (e) { info.value = { available: false }; msg.value = '读取安装包信息失败：' + e.message; msgType.value = 'err'; }
});
</script>
