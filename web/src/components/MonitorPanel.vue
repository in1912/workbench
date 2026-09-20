<template>
  <div>
    <!-- 设备列表（点击切换查看） -->
    <div class="card" style="margin-bottom:12px">
      <h3>🖥️ 监控设备 <span class="badge blue">{{ devices.length }}</span>
        <span class="muted" style="font-size:12px; font-weight:400">（{{ devices.length ? '点击设备切换查看' : '在目标电脑运行安装包后自动出现' }}）</span>
      </h3>
      <div v-if="!devices.length" class="empty">暂无设备接入{{ isAdmin ? '：下载页面最下方「代理安装包」到目标电脑安装' : '' }}</div>
      <div v-for="d in devices" :key="d.id" class="dev-row" :class="{ active: d.id === cur }" @click="select(d)">
        <b>{{ d.name }}</b>
        <span class="muted mono">{{ d.id }}</span>
        <span class="badge" :class="d.enabled ? 'green' : ''">{{ d.enabled ? '启用' : '已停用' }}</span>
        <span class="badge" title="本设备实际生效的截图间隔/分辨率/AI 分析（单独配置优先，未设置用全局默认）">⏱ {{ d.interval_eff || 3 }} 分钟 · {{ d.width_eff || 480 }}px · AI{{ d.ai_eff ? '开' : '关' }}{{ d.cfg_solo ? '（单独配置）' : '' }}</span>
        <span class="muted">最近截图 {{ d.last_shot || '—' }}</span>
        <span class="badge tokai" title="本设备历史 AI 分析总耗用 token">AI {{ fmtTok(d.ai_tokens) }}</span>
        <span class="badge blue">{{ d.shot_count }} 张</span>
        <span class="grow"></span>
        <template v-if="isAdmin">
          <button class="small" @click.stop="openDevCfg(d)">⚙ 配置</button>
          <button class="small" @click.stop="toggleDev(d)">{{ d.enabled ? '停用' : '启用' }}</button>
          <button class="danger small" @click.stop="delDev(d)">删除</button>
        </template>
      </div>
    </div>

    <!-- 截图列表（分页在底部） -->
    <div v-if="cur" class="card" style="margin-bottom:12px">
      <h3>📸 截图 · {{ curName }} <span class="badge blue">{{ shotsTotal }} 张</span></h3>
      <div v-if="isAdmin && shots.length" class="sel-bar">
        <label class="chk"><input type="checkbox" :checked="pageAllSel" @change="toggleAllSel" /> 全选本页</label>
        <button class="danger small" :disabled="!sel.size" @click="delSel">🗑 删除所选{{ sel.size ? `（${sel.size}）` : '' }}</button>
        <button v-if="sel.size" class="small" @click="sel = new Set()">取消选择</button>
        <span class="muted" style="font-size:12px">选中后可批量删除；翻页/切换设备会清空选择</span>
      </div>
      <div v-if="!shots.length" class="empty">该设备暂无截图</div>
      <div v-for="s in shots" :key="s.id" class="shot-row">
        <input v-if="isAdmin" class="shot-check" type="checkbox" :checked="sel.has(s.id)" @change="toggleSel(s)" title="勾选后可批量删除" />
        <img class="shot-thumb" :src="imgUrl(s)" loading="lazy" @click="openZoom(s)" title="点击放大（滚轮缩放）" />
        <div class="grow" style="min-width:0">
          <div class="meta">{{ s.ts }}</div>
          <div class="ai-box" :class="{ none: !s.ai_text }">{{ aiPlaceholder(s) }}</div>
          <div v-if="s.alert_hit || hitKw(s)" class="row" style="margin-top:4px">
            <span class="badge red" title="命中过预警关键字的截图不参与保留期清理，永久保留直至手动删除">⚠ 预警命中：{{ hitKw(s) || '已标记（永久保留）' }}</span>
          </div>
        </div>
        <button v-if="isAdmin" class="danger small shot-del" @click="delShot(s)">删除</button>
      </div>
      <div class="pager pager-bottom">
        <button class="small" :disabled="shotPage <= 1" @click="shotPage--">‹ 上一页</button>
        <select v-model.number="shotSize" class="mini-select" title="每页行数">
          <option :value="5">5 行</option><option :value="15">15 行</option><option :value="30">30 行</option><option :value="50">50 行</option>
        </select>
        <button class="small" :disabled="shotPage >= shotPages" @click="shotPage++">下一页 ›</button>
        <span class="muted">共 {{ shotsTotal }} 张 · 第 {{ shotPage }}/{{ shotPages || 1 }} 页</span>
        <span class="grow"></span>
        <button class="small" @click="loadShots">↻ 刷新</button>
      </div>
    </div>

    <!-- 开关机记录（分页在底部） -->
    <div v-if="cur" class="card" style="margin-bottom:12px">
      <h3>⏰ 开关机记录 · {{ curName }}
        <span class="muted" style="font-size:12px; font-weight:400">（按各截图当时间隔推导：首张=开机，末张=关机，超过当时间隔×2+3 分钟 = 新一次开机）</span>
      </h3>
      <div v-if="!sessions.length" class="empty">暂无记录</div>
      <table v-else class="mon-table">
        <thead><tr><th>#</th><th>开机时间（首张截图）</th><th>关机时间（末张截图）</th><th>使用时长</th><th>截图张数</th><th>AI tokens</th></tr></thead>
        <tbody>
          <tr v-for="s in sessions" :key="s.no">
            <td>{{ s.no }}</td><td>{{ s.start }}</td><td>{{ s.end }}</td><td>{{ s.duration }}</td><td>{{ s.shots }}</td><td>{{ s.tokens ? s.tokens.toLocaleString() : '—' }}</td>
          </tr>
        </tbody>
      </table>
      <div class="pager pager-bottom">
        <button class="small" :disabled="sesPage <= 1" @click="sesPage--">‹ 上一页</button>
        <select v-model.number="sesSize" class="mini-select" title="每页行数">
          <option :value="5">5 行</option><option :value="15">15 行</option><option :value="30">30 行</option><option :value="50">50 行</option>
        </select>
        <button class="small" :disabled="sesPage >= sesPages" @click="sesPage++">下一页 ›</button>
        <span class="muted">共 {{ sesTotal }} 次 · 第 {{ sesPage }}/{{ sesPages || 1 }} 页</span>
      </div>
    </div>

    <!-- 管理配置（仅管理员，页面最下） -->
    <div v-if="isAdmin" class="card">
      <h3>⚙️ 监控配置（全局默认）</h3>
      <div class="muted" style="font-size:12px; margin-bottom:10px">以下间隔/分辨率/AI 分析是<b>所有设备的默认值</b>；某台电脑要不同值，在上方设备行点「⚙ 配置」单独设置（间隔/分辨率代理下个上报周期生效，AI 开关立即生效，无需重装）。</div>
      <div class="form-row"><label>接入密钥</label>
        <div class="row grow">
          <input :value="cfg.access_key" readonly class="mono grow" @click="$event.target.select()" />
          <button class="small" @click="regenKey">重新生成</button>
        </div>
      </div>
      <div class="form-row"><label>截图间隔（分钟）</label>
        <div class="row grow" style="gap:16px; flex-wrap:wrap">
          <label style="display:inline-flex; align-items:center; gap:6px">
            <input type="number" v-model.number="cfg.interval" min="1" max="120" style="width:80px" /> 分钟（1~120，代理下次上报周期生效）
          </label>
          <label style="display:inline-flex; align-items:center; gap:6px">
            截图分辨率
            <select v-model.number="cfg.width" class="small">
              <option :value="320">320 高（最省）</option>
              <option :value="480">480 高（默认）</option>
              <option :value="720">720 高（较清晰，≈720p）</option>
              <option :value="1080">1080 高（高清，≈1080p）</option>
            </select>
          </label>
          <label style="display:inline-flex; align-items:center; gap:6px">
            截图保留 <input type="number" v-model.number="cfg.retention_days" min="1" max="180" style="width:70px" /> 天
          </label>
        </div>
      </div>
      <div class="form-row"><label>AI 分析</label>
        <div class="row grow" style="gap:16px; flex-wrap:wrap">
          <label class="switch" title="左右拨动开关">
            <input type="checkbox" v-model="cfg.ai_enabled" />
            <span class="slider"></span>
            <b :class="['sw-state', cfg.ai_enabled ? 'on' : '']">{{ cfg.ai_enabled ? '已开启' : '已关闭' }}</b>
          </label>
          <label style="display:inline-flex; align-items:center; gap:6px">
            每累计 <input type="number" v-model.number="cfg.ai_every" min="1" max="50" style="width:70px" :disabled="!cfg.ai_enabled" /> 张截图分析一次（1~50）
          </label>
        </div>
        <div class="muted" style="font-size:12px; width:100%">默认关闭，拨动开关开启并点「保存配置」后生效；走「设置 → AI 配置」里的视觉模型——DeepSeek 官方 API 不支持识图，需另配支持图片的模型（如 GLM-4V / qwen-vl / gpt-4o 等）。</div>
      </div>
      <div class="form-row"><label>预警关键字</label>
        <input v-model="kwText" placeholder="多个用逗号分隔，例：视频,动画片,游戏" class="grow" />
      </div>
      <div class="form-row"><label>预警推送给</label>
        <UserPicker v-model="cfg.alert_users" :users="contacts" multiple placeholder="搜索并选择用户（可多选）" style="flex:1" />
      </div>
      <div class="form-row"><label>预警冷却（分钟）</label>
        <div class="row grow" style="gap:16px">
          <label style="display:inline-flex; align-items:center; gap:6px">
            同设备同关键字 <input type="number" v-model.number="cfg.alert_cooldown" min="0" max="1440" style="width:80px" /> 分钟内不重复推
          </label>
        </div>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="primary" @click="saveCfg">保存配置</button>
        <span v-if="msg" :class="['save-msg', msgType === 'err' ? 'err' : '']">{{ msg }}</span>
      </div>

      <h3 style="margin-top:18px">📦 代理安装包</h3>
      <div class="warn-line">⚠️ 重要：请 <u>右键 install-monitor.bat → 选择「以管理员身份运行」</u>——只有管理员权限才会自动把安装目录加入杀毒软件白名单、避免被误报拦截；普通双击也能安装，但不会自动加白名单。</div>
      <div class="row" style="flex-wrap:wrap; gap:8px; margin-bottom:8px">
        <a class="button small" :href="dlUrl('setup')" @click.prevent="dlAgent('setup', 'monitor-setup.ps1')">⬇ monitor-setup.ps1（代理脚本）</a>
        <a class="button small" :href="dlUrl('install')" @click.prevent="dlAgent('install', 'install-monitor.bat')">⬇ install-monitor.bat（安装）</a>
        <a class="button small" :href="dlUrl('uninstall')" @click.prevent="dlAgent('uninstall', 'uninstall-monitor.bat')">⬇ uninstall-monitor.bat（卸载）</a>
      </div>
      <div class="muted" style="font-size:12px; line-height:1.8">
        安装方法：两个文件（monitor-setup.ps1 + install-monitor.bat）放到目标电脑同一文件夹，<b>右键 install-monitor.bat 以管理员身份运行</b>即完成——程序复制到
        %LOCALAPPDATA%\WorkbenchMonitor、注册当前用户开机自启、立即开始截图上报。<br />
        设备 ID 由目标电脑的机器码自动生成（重装系统才会变化），首次上报后出现在上方设备列表，点「改名」可设中文名。<br />
        程序为纯 PowerShell 脚本（任务管理器可见、启动项可管理），同一台电脑重复安装会自动互斥、不会跑两份。<br />
        截图间隔/分辨率/AI 分析在本卡设置全局默认（改动后代理下个上报周期自动生效，无需重装），单台设备可在设备行「⚙ 配置」单独覆盖。分辨率数值＝图片高度（720≈720p、1080≈1080p，宽度按屏幕比例自动缩放），多显示器拼接为一张图、每屏保持该高度；2026-09-19 前安装的旧代理按宽度缩放（图片偏小偏糊），重新下载安装一次即切换为按高度。
      </div>
    </div>

    <!-- 设备配置弹窗（仅管理员）：改名 + 显示顺序 + 全量监控配置（勾选「单独配置」后逐项设置） -->
    <div v-if="devCfg" class="cfg-backdrop" @click.self="devCfg = null">
      <div class="cfg-box">
        <h3>⚙ 设备配置 · {{ devCfg.origName }}</h3>
        <div class="form-row"><label>设备名称</label>
          <input v-model.trim="devCfg.name" class="grow" placeholder="如：家里电脑" />
        </div>
        <div class="form-row"><label>配置方式</label>
          <label class="chk"><input type="checkbox" v-model="devCfg.solo" /> 本设备单独配置监控（不勾选 = 跟随「监控配置」全局默认）</label>
        </div>
        <template v-if="devCfg.solo">
          <div class="form-row"><label>截图间隔</label>
            <div class="row grow" style="gap:8px; align-items:center; flex-wrap:wrap">
              <input type="number" v-model.number="devCfg.interval" min="1" max="120" style="width:80px" /> 分钟（1~120）
              <label style="display:inline-flex; align-items:center; gap:6px; margin-left:12px">
                分辨率
                <select v-model.number="devCfg.width" class="small">
                  <option :value="320">320 高（最省）</option>
                  <option :value="480">480 高（默认）</option>
                  <option :value="720">720 高（较清晰，≈720p）</option>
                  <option :value="1080">1080 高（高清，≈1080p）</option>
                </select>
              </label>
            </div>
          </div>
          <div class="form-row"><label>AI 分析</label>
            <div class="row grow" style="gap:16px; flex-wrap:wrap">
              <label class="switch">
                <input type="checkbox" v-model="devCfg.ai" />
                <span class="slider"></span>
                <b :class="['sw-state', devCfg.ai ? 'on' : '']">{{ devCfg.ai ? '已开启' : '已关闭' }}</b>
              </label>
              <label style="display:inline-flex; align-items:center; gap:6px">
                每累计 <input type="number" v-model.number="devCfg.aiEvery" min="1" max="50" style="width:70px" :disabled="!devCfg.ai" /> 张分析一次（1~50）
              </label>
              <label style="display:inline-flex; align-items:center; gap:6px">
                截图保留 <input type="number" v-model.number="devCfg.retention" min="1" max="180" style="width:70px" /> 天（1~180）
              </label>
            </div>
          </div>
          <div class="form-row"><label>预警关键字</label>
            <input v-model.trim="devCfg.kw" placeholder="多个用逗号分隔，例：视频,动画片,游戏" class="grow" />
          </div>
          <div class="form-row"><label>预警推送给</label>
            <UserPicker v-model="devCfg.alertUsers" :users="contacts" multiple placeholder="搜索并选择用户（可多选）" style="flex:1" />
          </div>
          <div class="form-row"><label>预警冷却（分钟）</label>
            <div class="row grow" style="gap:16px">
              <label style="display:inline-flex; align-items:center; gap:6px">
                同设备同关键字 <input type="number" v-model.number="devCfg.cooldown" min="0" max="1440" style="width:80px" /> 分钟内不重复推
              </label>
            </div>
          </div>
          <div class="muted" style="font-size:12px">命中预警时：站内信 + 钉钉文字提醒，并经钉钉「工作消息」推送命中截图（需在「设置 → 钉钉推送」配置 AgentId）。间隔/分辨率改动由该设备代理在下一个上报周期自动应用。</div>
        </template>
        <div class="form-row" style="margin-top:10px"><label>显示顺序</label>
          <div class="row grow" style="gap:8px; align-items:center; flex-wrap:wrap">
            <input type="number" v-model.number="devCfg.sortOrder" min="0" max="99" style="width:80px" placeholder="默认" />
            <span class="muted" style="font-size:12px">1~99 = 固定排第几行（数字小的在前，未设序号的按接入先后排在后面；0 = 默认）</span>
          </div>
        </div>
        <div class="row" style="justify-content:flex-end; gap:8px; margin-top:12px">
          <button class="small" @click="devCfg = null">取消</button>
          <button class="primary" @click="saveDevCfg">保存</button>
        </div>
      </div>
    </div>

    <!-- 放大查看：滚轮缩放 + 拖动平移 -->
    <div v-if="zoom" ref="stageRef" class="zoom-stage" @wheel.prevent="onWheel"
         @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onUp">
      <img :src="imgUrl(zoom)" class="zoom-img" :style="{ transform: `translate(${zx}px, ${zy}px) scale(${zs})` }" />
      <div class="zoom-ctrl" @pointerdown.stop @click.stop>
        <span class="zoom-pct">{{ Math.round(zs * 100) }}%</span>
        <button class="small" title="缩小" @click="zs = Math.max(0.15, zs / 1.25)">−</button>
        <button class="small" title="放大" @click="zs = Math.min(12, zs * 1.25)">＋</button>
        <button class="small" title="复位" @click="resetZoom">1:1</button>
        <button class="small" @click="closeZoom">✕ 关闭</button>
      </div>
      <div class="zoom-meta">{{ zoom.ts }}　·　滚轮缩放 · 拖动查看 · Esc 关闭</div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import { api } from '../api';
import UserPicker from './UserPicker.vue';

const isAdmin = ref(false);
const token = localStorage.getItem('wb_token') || '';
const devices = ref([]);
const cur = ref('');
const curName = computed(() => (devices.value.find((d) => d.id === cur.value) || {}).name || cur.value);

const cfg = ref({ access_key: '', interval: 3, width: 480, ai_enabled: 0, ai_every: 10, retention_days: 14, keywords: [], alert_users: [], alert_cooldown: 30 });
const kwText = ref('');
const contacts = ref([]);
const msg = ref('');
const msgType = ref('ok');
// 设备配置弹窗（设备级间隔/分辨率覆盖，0/空=跟随全局）
const devCfg = ref(null);

const shots = ref([]);
const shotsTotal = ref(0);
const shotPage = ref(1);
const shotSize = ref(5);
const shotPages = computed(() => Math.max(1, Math.ceil(shotsTotal.value / shotSize.value)));
const aiOn = ref(false); // 服务端 AI 分析开关（区分“未开启/待分析”占位文案）

const sessions = ref([]);
const sesTotal = ref(0);
const sesPage = ref(1);
const sesSize = ref(5);
const sesPages = computed(() => Math.max(1, Math.ceil(sesTotal.value / sesSize.value)));

// 放大查看器状态
const zoom = ref(null);
const stageRef = ref(null);
const zs = ref(1);   // 缩放倍率
const zx = ref(0);   // 平移 x
const zy = ref(0);   // 平移 y
let dragBase = null;

function flash(text, type = 'ok') {
  msg.value = text; msgType.value = type;
  setTimeout(() => (msg.value = ''), 3500);
}
function dlUrl(type) { return `/api/monitor/agent-files?type=${type}&token=${encodeURIComponent(token)}`; }
// <a download> 直点走浏览器下载管理器重新发起连接，经隧道/代理时会被拦下报「请检查互联网状况」
// （复制链接新开窗口却能下，宠物模块 v1.3.8 批踩过同款坑）。改走页内 fetch 拉 blob 再存盘；
// href 保留，右键「复制链接」仍可用。
async function dlAgent(type, name) {
  try {
    const r = await fetch(dlUrl(type));
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || `HTTP ${r.status}`); }
    const u = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = u; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 30000);
    flash('已开始下载 ' + name);
  } catch (e) { flash('下载失败：' + e.message, 'err'); }
}
function imgUrl(s) { return `/api/monitor/shot/${s.id}?token=${encodeURIComponent(token)}`; }
function hitKw(s) {
  if (!s.ai_text) return '';
  const dev = devices.value.find((d) => d.id === cur.value);
  const hits = ((dev && dev.keywords_eff) || cfg.value.keywords || []).filter((k) => s.ai_text.includes(k));
  return hits.join('、');
}
function fmtTok(n) {
  const v = Number(n) || 0;
  return v >= 100000000 ? (v / 100000000).toFixed(1) + '亿' : v >= 10000 ? (v / 10000).toFixed(1) + '万' : String(v);
}
function aiPlaceholder(s) {
  if (s.ai_text) return s.ai_text;
  return aiOn.value ? '（待分析：累计到设定张数后自动进行 AI 概括）' : '（AI 分析未开启：管理员可在最下方「监控配置」拨动开关开启并保存）';
}

function select(d) { cur.value = d.id; shotPage.value = 1; sesPage.value = 1; }

// ---------- 放大查看器 ----------
function openZoom(s) { zoom.value = s; }
function closeZoom() { zoom.value = null; dragBase = null; }
function resetZoom() { zs.value = 1; zx.value = 0; zy.value = 0; }
function onWheel(e) {
  const el = stageRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  // 光标相对画面中心的位置（图像以自身中心为变换原点、flex 居中）
  const px = e.clientX - rect.left - rect.width / 2;
  const py = e.clientY - rect.top - rect.height / 2;
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  const ns = Math.min(12, Math.max(0.15, zs.value * factor));
  // 锚定光标：缩放后保持光标下的图像点仍在光标下
  const ux = (px - zx.value) / zs.value;
  const uy = (py - zy.value) / zs.value;
  zx.value = px - ux * ns;
  zy.value = py - uy * ns;
  zs.value = ns;
}
function onDown(e) {
  dragBase = { x: e.clientX, y: e.clientY, bx: zx.value, by: zy.value, moved: 0 };
  if (stageRef.value) stageRef.value.style.cursor = 'grabbing';
}
function onMove(e) {
  if (!dragBase) return;
  const dx = e.clientX - dragBase.x;
  const dy = e.clientY - dragBase.y;
  dragBase.moved = Math.max(dragBase.moved, Math.abs(dx) + Math.abs(dy));
  zx.value = dragBase.bx + dx;
  zy.value = dragBase.by + dy;
}
function onUp() {
  if (dragBase && dragBase.moved < 5) closeZoom(); // 原地单击 = 关闭
  dragBase = null;
  if (stageRef.value) stageRef.value.style.cursor = '';
}
function onKey(e) { if (e.key === 'Escape') closeZoom(); }
watch(zoom, (v) => {
  if (v) { resetZoom(); window.addEventListener('keydown', onKey); }
  else window.removeEventListener('keydown', onKey);
});
onUnmounted(() => window.removeEventListener('keydown', onKey));

// ---------- 数据加载 ----------
async function loadDevices() {
  const r = await api.get('/monitor/devices');
  devices.value = r.devices || [];
  if (!devices.value.find((d) => d.id === cur.value)) cur.value = devices.value.length ? devices.value[0].id : '';
}

async function loadCfg() {
  const r = await api.get('/monitor/settings');
  cfg.value = { width: 480, ...r };
  kwText.value = (cfg.value.keywords || []).join(',');
}

async function saveCfg() {
  try {
    const r = await api.put('/monitor/settings', { ...cfg.value, keywords: kwText.value });
    cfg.value = { width: 480, ...r };
    kwText.value = (r.keywords || []).join(',');
    flash('配置已保存');
    await loadDevices(); // 间隔变化会影响开关机推导阈值
  } catch (e) { flash(e.message, 'err'); }
}

async function regenKey() {
  if (!confirm('重新生成接入密钥？已安装的代理将全部失联（需重新下载安装包并重装）。')) return;
  try {
    const r = await api.put('/monitor/settings', { access_key: '__regen__' });
    cfg.value = { width: 480, ...r };
    flash('已重新生成，请重新下载安装包');
  } catch (e) { flash(e.message, 'err'); }
}

// 设备级配置：改名 + 间隔/分辨率覆盖（interval/width 传 null 或 0 = 清除覆盖，回落全局默认）
// 设备配置弹窗：改名 + 显示顺序；勾选「单独配置」= 本设备全量监控配置（初始值取当前生效值），
// 不勾 = 清空覆盖、跟随全局默认
function openDevCfg(d) {
  devCfg.value = {
    id: d.id, origName: d.name, name: d.name,
    solo: !!d.cfg_solo,
    interval: d.interval_eff || 3,
    width: d.width_eff || 480,
    ai: !!d.ai_eff,
    aiEvery: d.ai_every_eff || 10,
    retention: d.retention_days_eff || 14,
    kw: (d.keywords_eff || []).join(','),
    alertUsers: [...(d.alert_users_eff || [])],
    cooldown: d.alert_cooldown_eff ?? 30,
    sortOrder: Number(d.sort_order) || 0,
  };
}
async function saveDevCfg() {
  const b = devCfg.value;
  try {
    await api.put(`/monitor/devices/${b.id}`, {
      name: b.name,
      sort_order: b.sortOrder > 0 ? Math.min(99, Math.round(b.sortOrder)) : 0,
      solo: b.solo ? 1 : 0,
      ...(b.solo ? {
        interval: Math.min(120, Math.max(1, Math.round(b.interval) || 3)),
        width: b.width || 480,
        ai_enabled: b.ai ? 1 : 0,
        ai_every: Math.round(b.aiEvery) || 10,
        retention_days: Math.round(b.retention) || 14,
        keywords: b.kw,
        alert_users: b.alertUsers,
        alert_cooldown: Math.round(b.cooldown) || 0,
      } : {}),
    });
    devCfg.value = null;
    flash('设备配置已保存');
    await loadDevices();
  } catch (e) { flash(e.message, 'err'); }
}

async function toggleDev(d) {
  try { await api.put(`/monitor/devices/${d.id}`, { enabled: !d.enabled }); await loadDevices(); } catch (e) { flash(e.message, 'err'); }
}

async function delDev(d) {
  if (!confirm(`删除设备「${d.name}」及其全部截图与记录？不可恢复。`)) return;
  try { await api.del(`/monitor/devices/${d.id}`); await loadDevices(); } catch (e) { flash(e.message, 'err'); }
}

async function loadShots() {
  if (!cur.value) return;
  const r = await api.get(`/monitor/shots?device_id=${encodeURIComponent(cur.value)}&page=${shotPage.value}&page_size=${shotSize.value}`);
  shots.value = r.items || [];
  shotsTotal.value = r.total || 0;
  aiOn.value = !!r.ai_enabled;
}

// ---------- 截图删除（仅管理员）：单选 + 多选批量；翻页/换设备清空选择 ----------
const sel = ref(new Set());
const pageAllSel = computed(() => shots.value.length > 0 && shots.value.every((s) => sel.value.has(s.id)));
function toggleSel(s) {
  const n = new Set(sel.value);
  if (n.has(s.id)) n.delete(s.id); else n.add(s.id);
  sel.value = n;
}
function toggleAllSel() {
  const n = new Set(sel.value);
  if (pageAllSel.value) shots.value.forEach((s) => n.delete(s.id));
  else shots.value.forEach((s) => n.add(s.id));
  sel.value = n;
}
async function afterDel(n) {
  flash(`已删除 ${n} 张截图`);
  sel.value = new Set();
  await loadDevices(); // 张数/最近截图/AI tokens 徽标随删除变化
  await loadSessions(); // 开关机记录由截图推导，需一并刷新
  await loadShots();
  if (!shots.value.length && shotPage.value > 1) shotPage.value--; // 删空末页回退一页（watch 自动重载）
}
async function delShot(s) {
  if (!confirm(`删除这张截图（${s.ts}）？不可恢复${s.alert_hit ? '；该截图命中过预警（原本永久保留）' : ''}。`)) return;
  try { await afterDel((await api.post('/monitor/shots/delete', { ids: [s.id] })).deleted); }
  catch (e) { flash(e.message, 'err'); }
}
async function delSel() {
  const ids = [...sel.value];
  const hasAlert = ids.some((id) => {
    const s = shots.value.find((x) => x.id === id);
    return s && (s.alert_hit || hitKw(s));
  });
  if (!confirm(`删除所选 ${ids.length} 张截图？不可恢复${hasAlert ? '；其中含命中过预警的截图（原本永久保留）' : ''}。`)) return;
  try { await afterDel((await api.post('/monitor/shots/delete', { ids })).deleted); }
  catch (e) { flash(e.message, 'err'); }
}

async function loadSessions() {
  if (!cur.value) return;
  const r = await api.get(`/monitor/sessions?device_id=${encodeURIComponent(cur.value)}&page=${sesPage.value}&page_size=${sesSize.value}`);
  sessions.value = r.items || [];
  sesTotal.value = r.total || 0;
}

watch(shotPage, () => { sel.value = new Set(); loadShots(); });
watch(shotSize, () => { shotPage.value = 1; sel.value = new Set(); loadShots(); });
watch(sesPage, loadSessions);
watch(sesSize, () => { sesPage.value = 1; loadSessions(); });
watch(cur, () => { sel.value = new Set(); loadShots(); loadSessions(); });

onMounted(async () => {
  try {
    const m = await api.get('/auth/me');
    isAdmin.value = m.user.role === 'admin';
  } catch { /* 未登录由路由守卫处理 */ }
  try { await loadDevices(); } catch (e) { flash(e.message, 'err'); }
  if (isAdmin.value) {
    await loadCfg();
    try { contacts.value = (await api.get('/messages/contacts')).users || []; } catch { contacts.value = []; }
  }
  if (cur.value) { loadShots(); loadSessions(); }
});
</script>

<style scoped>
.dev-row {
  display: flex; align-items: center; gap: 10px;
  padding: 8px 10px; border: 1px solid var(--border, #ddd); border-radius: 8px;
  margin-bottom: 6px; cursor: pointer; flex-wrap: wrap;
}
.dev-row:hover { border-color: var(--accent, #4f7cf7); }
.dev-row.active { border-color: var(--accent, #4f7cf7); background: color-mix(in srgb, var(--accent, #4f7cf7) 8%, transparent); }
.mono { font-family: Consolas, monospace; font-size: 12px; }
.form-row { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; flex-wrap: wrap; }
.form-row > label { min-width: 110px; font-size: 13px; color: var(--text2, #666); }
.save-msg { font-size: 13px; color: var(--green, #2e9e5b); }
.save-msg.err { color: var(--danger, #d33); }
.shot-row { display: flex; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border, #eee); align-items: flex-start; }
/* 截图选择/删除（仅管理员可见） */
.sel-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 4px 0 8px; border-bottom: 1px dashed var(--border, #eee); }
.chk { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text2, #666); cursor: pointer; user-select: none; -webkit-user-select: none; }
.shot-check { flex: none; width: 16px; height: 16px; margin-top: 4px; cursor: pointer; }
.shot-del { flex: none; }
.shot-thumb { width: 240px; border-radius: 6px; cursor: zoom-in; border: 1px solid var(--border, #eee); object-fit: cover; }
.ai-box {
  margin-top: 4px; padding: 8px 10px; border-radius: 6px; font-size: 13px; line-height: 1.6;
  background: var(--bg2, #f6f7f9); border: 1px dashed var(--border, #ddd); word-break: break-all;
}
.ai-box.none { color: var(--text3, #999); }
.pager { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; }
.pager-bottom { margin: 12px 0 2px; padding-top: 10px; border-top: 1px solid var(--border, #eee); }
.mon-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.mon-table th, .mon-table td { padding: 7px 10px; border-bottom: 1px solid var(--border, #eee); text-align: left; }
.mon-table th { color: var(--text2, #666); font-weight: 600; }
a.button { text-decoration: none; display: inline-block; }
.warn-line { color: var(--danger, #d93026); font-weight: 600; line-height: 1.7; margin-bottom: 8px; font-size: 13px; }
/* 设备配置弹窗 */
.cfg-backdrop {
  position: fixed; inset: 0; z-index: 90; background: rgba(0, 0, 0, .45);
  display: flex; align-items: center; justify-content: center; padding: 16px;
}
.cfg-box {
  width: min(460px, 94vw); max-height: 86vh; overflow: auto;
  background: var(--bg, #fff); border-radius: 12px; padding: 18px 20px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, .25);
}
/* AI token 徽标（设备列表） */
.badge.tokai { background: rgba(124, 58, 237, .12); color: #7c3aed; }
/* 左右拨动开关 */
.switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; -webkit-user-select: none; }
.switch input { display: none; }
.switch .slider {
  flex: none; width: 44px; height: 22px; border-radius: 11px; position: relative;
  background: #c4cad3; transition: background .18s;
}
.switch .slider::before {
  content: ''; position: absolute; left: 3px; top: 3px; width: 16px; height: 16px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, .3); transition: left .18s;
}
.switch input:checked + .slider { background: #2e9e5b; }
.switch input:checked + .slider::before { left: 25px; }
.sw-state { font-size: 13px; }
.sw-state.on { color: var(--green, #2e9e5b); }
/* 迷你每页行数下拉（置于上一页/下一页中间） */
select.mini-select {
  width: auto; padding: 2px 6px; font-size: 12px; border-radius: 6px;
  border: 1px solid var(--border, #ddd); background: var(--bg, #fff); color: var(--text, #222);
}
/* 放大查看器 */
.zoom-stage {
  position: fixed; inset: 0; z-index: 100; background: rgba(0, 0, 0, .9);
  display: flex; align-items: center; justify-content: center;
  overflow: hidden; cursor: grab; user-select: none; -webkit-user-select: none;
}
.zoom-img { max-width: 92vw; max-height: 84vh; border-radius: 6px; will-change: transform; pointer-events: none; }
.zoom-ctrl {
  position: fixed; top: 14px; right: 16px; display: flex; gap: 6px; align-items: center;
  background: rgba(0, 0, 0, .55); padding: 6px 10px; border-radius: 18px;
}
.zoom-pct { color: #fff; font-size: 13px; min-width: 46px; text-align: center; font-family: Consolas, monospace; }
.zoom-meta {
  position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); color: #fff;
  background: rgba(0, 0, 0, .55); padding: 4px 14px; border-radius: 14px; font-size: 13px; pointer-events: none;
}
</style>
