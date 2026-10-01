<template>
  <div>
    <h2 class="page-title">智能家居</h2>
    <div class="tabs">
      <button v-if="canTab('smarthome','mijia')" :class="{active: tab==='mijia'}" @click="switchTab('mijia')">米家</button>
      <button v-if="canTab('smarthome','xiaozhi')" :class="{active: tab==='xiaozhi'}" @click="switchTab('xiaozhi')">智能板</button>
      <!-- Agent红绿灯（v1.8.1 起为本页子 tab；v1.9.22 曾升格独立页，v1.9.23 放回智能板之后） -->
      <button v-if="canTab('smarthome','cclight')" :class="{active: tab==='cclight'}" @click="switchTab('cclight')">Agent红绿灯</button>
      <button v-if="canTab('smarthome','settings')" :class="{active: tab==='settings'}" @click="switchTab('settings')">米家设置</button>
      <!-- 参数翻译（v1.9.24 更名「米家参数翻译」并移到米家设置之后） -->
      <button v-if="canTab('smarthome','terms')" :class="{active: tab==='terms'}" @click="switchTab('terms')">米家参数翻译</button>
    </div>

    <div v-if="err" class="msg err">{{ err }}</div>
    <div v-if="okMsg" class="msg ok">{{ okMsg }}</div>

    <!-- ==================== 米家 tab ==================== -->
    <template v-if="tab==='mijia'">
      <!-- 未绑定引导 -->
      <div v-if="!status.bound && !loading" class="card" style="text-align:center;padding:40px">
        <span class="material-icons" style="font-size:44px;color:var(--muted)">home</span>
        <h3 style="margin:12px 0 8px">米家账号尚未绑定</h3>
        <p style="color:var(--muted);margin:0 0 16px">绑定后可在这里查看并控制你米家账号下的全部智能设备（家庭 → 房间 → 设备卡片）。</p>
        <button v-if="canTab('smarthome','settings')" class="btn" @click="switchTab('settings')">去扫码绑定</button>
      </div>

      <template v-else>
        <div class="card sh-toolbar">
          <select v-if="data && data.homes.length > 1" v-model="curHome" class="sh-home-select" title="切换家庭">
            <option v-for="h in data.homes" :key="h.id" :value="h.id">{{ h.name }}</option>
          </select>
          <span v-else-if="curHomeName" class="sh-home-name"><span class="material-icons" style="font-size:16px;vertical-align:-3px">home</span> {{ curHomeName }}</span>
          <span style="color:var(--muted);font-size:13px">
            {{ deviceCount }} 台设备 · {{ onlineCount }} 台在线
            <template v-if="data"> · 更新于 {{ shortTime(data.generated_at) }}</template>
          </span>
          <span style="flex:1"></span>
          <button class="btn" :disabled="loading" @click="loadHomes(true)">{{ loading ? '加载中…' : '刷新' }}</button>
        </div>

        <div v-if="loading && !data" class="card" style="text-align:center;color:var(--muted);padding:36px">正在从米家云拉取家庭与设备…</div>

        <!-- 当前家庭 → 房间 → 设备卡片 -->
        <div v-if="curHomeData" class="card">
          <div class="sh-home">{{ curHomeData.name }}</div>
          <div v-for="r in curHomeData.rooms" :key="r.id" class="sh-room">
            <div class="sh-room-name"><span class="material-icons" style="font-size:15px;vertical-align:-2px">meeting_room</span> {{ r.name }} <span class="sh-room-cnt">{{ r.devices.length }}</span></div>
            <div class="sh-grid">
              <div v-for="d in r.devices" :key="d.did" class="sh-card" :class="{ offline: !d.online }" @click="openDetail(d)">
                <!-- 父设备角标（v1.6.25）：多路开关的父条目，各分路有独立卡片；父卡不挂外层开关，点开进详情可控全部回路 -->
                <span v-if="d.is_parent" class="sh-parent-tag">父设备</span>
                <span class="material-icons sh-emoji">{{ iconOf(d) }}</span>
                <div class="sh-name" :title="d.name + ' · ' + d.model">{{ d.name }}</div>
                <!-- 温湿度计/净化器/浴霸：卡片直显温度（/湿度）（v1.6.21/24/25） -->
                <div v-if="envText(d)" class="sh-env">
                  <template v-if="d.env.t && d.env.t.value != null"><b>{{ d.env.t.value }}</b><i>°C</i></template>
                  <span v-if="d.env.t && d.env.t.value != null && d.env.h && d.env.h.value != null"> · </span>
                  <template v-if="d.env.h && d.env.h.value != null"><b>{{ d.env.h.value }}</b><i>%</i></template>
                </div>
                <div class="sh-dot"><i :class="d.online ? 'on' : ''"></i>{{ d.online ? '在线' : '离线' }}</div>
                <!-- 有开关能力且非父设备才显示圆形开关（父设备/无开关能力不显示，点击卡片进详情） -->
                <button v-if="d.switch && !d.is_parent" class="sh-toggle" :class="{ on: d.switch.value === true, busy: toggling[d.did] }"
                  :title="d.switch.value === true ? '点击关闭' : '点击开启'"
                  @click.stop="toggleSwitch(d)"><span></span></button>
              </div>
            </div>
          </div>
        </div>

        <div v-if="data && !data.homes.length && !loading" class="card" style="text-align:center;color:var(--muted);padding:36px">
          米家账号下暂无设备：先在米家 App 里添加设备，再点上方「刷新」。
        </div>
      </template>
    </template>

    <!-- ==================== 参数翻译 tab ==================== -->
    <template v-else-if="tab==='terms'">
      <div class="card">
        <h3 style="margin:0 0 10px">MIoT 参数中英对照</h3>
        <p style="color:var(--muted);font-size:13px;margin:0 0 14px">
          设备详情页的服务/属性/动作名取自 miot-spec.org 官方规范（英文）。详情页已自动套用本词典
          （优先显示中文，括注英文原文）；此处为完整对照，可搜索。
        </p>
        <input type="text" v-model="termQ" class="sh-manual-input" style="max-width:380px;display:block;margin-bottom:16px"
          placeholder="搜索：英文或中文，如 switch / 温度 / 摆风" />
        <div v-for="g in termGroups" :key="g.title" class="sh-term-group">
          <div class="sh-term-title">{{ g.title }}<span class="sh-room-cnt">{{ g.pairs.length }}</span></div>
          <div class="sh-term-grid">
            <div v-for="([en, z]) in g.pairs" :key="en" class="sh-term"><b>{{ z }}</b><span>{{ en }}</span></div>
          </div>
        </div>
        <div v-if="!termGroups.length" style="color:var(--muted);text-align:center;padding:24px">没有匹配的词条</div>
      </div>
    </template>

    <!-- ==================== 智能板 tab（v1.9.11：小智 Korvo2V3 装机/唤醒词/语音控米家） ==================== -->
    <XiaozhiPanel v-else-if="tab==='xiaozhi'" />

    <!-- ==================== Agent红绿灯 tab（v1.9.23 放回本页：功能介绍/下载安装包/安装步骤三段，见 CcLightPanel） ==================== -->
    <CcLightPanel v-else-if="tab==='cclight'" />

    <!-- ==================== 设置 tab ==================== -->
    <template v-else-if="tab==='settings'">
      <div class="card">
        <h3 style="margin:0 0 12px">小米账号绑定</h3>

        <!-- 已绑定状态 -->
        <template v-if="status.bound">
          <div class="sh-kv"><span>账号昵称</span><b>{{ status.nickname || '（未获取到）' }}</b></div>
          <div class="sh-kv"><span>用户 ID</span><b>{{ status.uid || '-' }}</b></div>
          <div class="sh-kv"><span>服务区域</span><b>{{ (status.regions || {})[status.region] || status.region }}</b></div>
          <div class="sh-kv"><span>绑定时间</span><b>{{ fmtTime(status.bound_at) }}</b></div>
          <div class="sh-kv"><span>令牌到期</span><b>{{ fmtTime(status.expires_at) }}（到期自动续期，无需干预）</b></div>
          <div class="sh-kv"><span>默认家庭</span>
            <select v-model="defaultHome" class="sh-home-select" :disabled="prefsSaving" @change="saveDefaultHome">
              <option v-if="!homes.length" value="">（正在加载家庭列表…）</option>
              <option v-for="h in homes" :key="h.id" :value="h.id">{{ h.name }}（{{ h.rooms.reduce((m, r) => m + r.devices.length, 0) }} 台）</option>
            </select>
          </div>
          <div class="sh-kv"><span>缓存刷新间隔</span>
            <span style="display:flex;align-items:center;gap:8px">
              <input type="number" min="1" max="1440" v-model="cacheTtl" class="sh-num" style="width:84px" :disabled="prefsSaving" />
              <span style="color:var(--muted);font-size:12px">分钟</span>
              <button class="btn sm" :disabled="prefsSaving" @click="saveCacheTtl">保存</button>
            </span>
          </div>
          <div style="font-size:12px;color:var(--muted);padding:4px 0 2px">设备列表缓存超过该时长后在后台静默更新，下次进入即为新数据（默认 60 分钟）。</div>
          <div style="margin-top:14px;display:flex;gap:10px">
            <button class="btn" @click="loadStatus(); okMsg='状态已刷新'">刷新状态</button>
            <button class="btn danger" @click="doUnbind">解绑（清空令牌）</button>
          </div>
        </template>

        <!-- 扫码绑定（小米只放行 homeassistant.local 回调 → 授权后页面打不开，复制地址栏网址回填） -->
        <template v-else>
          <p style="color:var(--muted);margin:0 0 10px;font-size:13px">
            小米 OAuth 只允许 Home Assistant 官方回调域名（homeassistant.local），<b>授权后浏览器会跳到一个打不开的页面——这是正常的</b>，
            授权码就在那个页面的地址栏里，复制回来即可完成绑定：
          </p>
          <ol class="sh-steps">
            <li>点「生成授权二维码」→ 用<strong>手机浏览器扫一扫</strong>（⚠️ 不要用米家 App 的扫一扫），或点下方链接<strong>在这台电脑的浏览器</strong>打开授权页</li>
            <li>登录小米账号 → 点「同意/确认授权」</li>
            <li>授权后页面显示<b>无法访问/打不开（homeassistant.local…）</b>——复制浏览器<b>地址栏的完整网址</b></li>
            <li>回到本页粘贴到下方输入框 → 点「完成绑定」</li>
          </ol>
          <div class="form-row">
            <label>服务区域</label>
            <select v-model="region">
              <option v-for="(label, key) in (status.regions || {cn:'中国大陆'})" :key="key" :value="key">{{ label }}</option>
            </select>
          </div>
          <div style="display:flex;gap:10px;margin:6px 0 16px">
            <button class="btn" :disabled="qrLoading" @click="startBind">{{ qrLoading ? '生成中…' : '生成授权二维码' }}</button>
            <button v-if="qr.url" class="btn ghost" @click="copyLink">复制链接</button>
          </div>

          <div v-if="qr.img" class="sh-qr">
            <img :src="qr.img" alt="小米账号授权二维码" />
            <div class="sh-qr-status">
              <template v-if="polling"><span class="material-icons" style="font-size:14px;vertical-align:-2px">hourglass_empty</span> 已生成，等待授权确认…（二维码 10 分钟内有效）</template>
              <template v-else>二维码已失效，请重新生成</template>
              <a v-if="qr.url" :href="qr.url" target="_blank" rel="noopener" class="sh-auth-link">在这台电脑的浏览器打开授权页 →</a>
            </div>
          </div>

          <div v-if="qr.img" class="sh-manual">
            <div class="sh-manual-title">④ 粘贴授权后地址栏的完整网址完成绑定：</div>
            <div style="display:flex;gap:10px;flex-wrap:wrap">
              <input type="text" class="sh-manual-input" v-model="manualUrl" :disabled="manualBusy"
                placeholder="http://homeassistant.local:8123/api/mihome/callback?code=…&state=…" @keyup.enter="submitManual" />
              <button class="btn" :disabled="manualBusy || !manualUrl.trim()" @click="submitManual">{{ manualBusy ? '绑定中…' : '完成绑定' }}</button>
            </div>

            <!-- 服务器出口与授权浏览器不一致时（小米风控），在用户浏览器里直接换令牌再注入 -->
            <div v-if="relayShow" class="sh-relay">
              <div class="sh-manual-title">自助通道：在你的浏览器里直接换令牌（服务器出口受限时用）</div>
              <ol class="sh-steps">
                <li>确认上方输入框已粘贴刚才授权的网址（含 code），然后点「在本浏览器换取令牌 →」（<b>须用刚才授权的同一个浏览器</b>），会打开一个显示 JSON 的页面</li>
                <li>全选复制那个页面的<b>全部内容</b>，粘贴到下面 → 点「注入令牌完成绑定」</li>
              </ol>
              <div style="margin-bottom:8px">
                <a v-if="relayUrl" class="btn ghost" :href="relayUrl" target="_blank" rel="noopener">在本浏览器换取令牌 →</a>
                <span v-else style="color:var(--muted);font-size:12px">先在上方粘贴含 code 的授权网址</span>
              </div>
              <textarea v-model="relayJson" class="sh-relay-input" rows="4" :disabled="relayBusy"
                placeholder="粘贴换令牌页面显示的 JSON（含 access_token / refresh_token）"></textarea>
              <div style="margin-top:8px">
                <button class="btn" :disabled="relayBusy || !relayJson.trim()" @click="submitRelay">{{ relayBusy ? '注入中…' : '注入令牌完成绑定' }}</button>
              </div>
            </div>
            <div v-else style="margin-top:10px;font-size:12px">
              <a href="#" class="sh-auth-link" @click.prevent="relayShow = true">「完成绑定」提示被小米风控拒绝？点此在你的浏览器直接换令牌 →</a>
            </div>
          </div>
        </template>
      </div>

      <div class="card">
        <h3 style="margin:0 0 10px">说明</h3>
        <ul class="sh-notes">
          <li>通道：小米账号 OAuth2 官方授权 + 米家云端 MIoT 接口，纯云端调用（不依赖局域网），仅操作你账号下已在米家 App 绑定的成品设备。</li>
          <li>授权内容：读取家庭/房间/设备列表、读写设备属性、调用设备动作；不收集、不修改设备绑定关系。</li>
          <li>安全：访问令牌以 AES-256-GCM 加密存储在本工作台服务器，不出现在日志与接口响应中；解绑即清空令牌即时失效。</li>
          <li>绑定账号对全工作台共享（家庭成员共用一个米家账号）；可在「用户管理」里控制谁能看到「智能家居」页。</li>
          <li>本功能仅限个人自用，请勿用于商业用途。</li>
        </ul>
      </div>
    </template>

    <!-- ==================== 设备详情弹窗：全量开放能力 ==================== -->
    <div v-if="detail.open" class="sh-mask" @click.self="closeDetail">
      <div class="sh-modal">
        <div class="sh-modal-head">
          <span class="material-icons" style="font-size:26px;line-height:1;color:var(--text2,#888)">{{ iconOf(detail.device) }}</span>
          <div style="flex:1;min-width:0">
            <div style="font-weight:600;font-size:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              {{ detail.device.name }}
              <i class="sh-dot-i" :class="{on: detail.device.online}"></i>
              <small :style="{color: detail.device.online ? 'var(--ok,#1e9e68)' : 'var(--muted)'}">{{ detail.device.online ? '在线' : '离线' }}</small>
            </div>
            <div style="font-size:12px;color:var(--muted)">{{ detail.device.model }} · did {{ detail.device.did }}</div>
          </div>
          <button v-if="detail.spec" class="btn ghost" :disabled="detail.loadingVals" @click="loadDetailValues">
            {{ detail.loadingVals ? '读取中…' : '刷新数值' }}
          </button>
          <button class="sh-close" @click="closeDetail">✕</button>
        </div>

        <div v-if="detail.loading" class="sh-modal-body" style="text-align:center;color:var(--muted);padding:40px">正在加载设备能力…</div>
        <div v-else-if="detail.err" class="sh-modal-body" style="text-align:center;color:var(--muted);padding:40px">
          {{ detail.err }}<br /><button class="btn" style="margin-top:10px" @click="openDetail(detail.device)">重试</button>
        </div>

        <div v-else class="sh-modal-body">
          <div v-for="sv in detail.spec.services" :key="sv.siid" class="sh-svc">
            <div class="sh-svc-head">
              <b>{{ dispName(sv) }}</b><span class="sh-svc-desc">{{ sv.name }}</span>
              <span class="sh-svc-id">siid {{ sv.siid }}</span>
            </div>

            <!-- 属性：读当前值 / 写入控制 -->
            <div v-if="sv.properties.length" class="sh-props">
              <div v-for="p in sv.properties" :key="p.piid" class="sh-prop">
                <div class="sh-prop-name" :title="p.name + (p.description ? ' · ' + p.description : '')">
                  {{ dispName(p) }}<small v-if="zh2(p.name) && p.name !== dispName(p)"> ({{ p.name }})</small>
                  <small v-if="p.unit">({{ p.unit }})</small>
                  <span class="sh-tag">{{ p.format }}</span>
                  <span v-if="canWrite(p)" class="sh-tag w">可写</span>
                </div>
                <div class="sh-prop-ctrl">
                  <!-- 布尔：开关 -->
                  <template v-if="p.format==='bool'">
                    <button v-if="canWrite(p)" class="sh-toggle sm" :class="{ on: valOf(p) === true, busy: writing[keyOf(sv,p)] }"
                      @click="writeProp(sv, p, valOf(p) !== true)"><span></span></button>
                    <b v-else>{{ valOf(p) === true ? '开' : valOf(p) === false ? '关' : '-' }}</b>
                  </template>
                  <!-- 枚举：下拉 -->
                  <template v-else-if="p.valueList">
                    <select v-if="canWrite(p)" v-model="inputs[keyOf(sv,p)]" :disabled="writing[keyOf(sv,p)]"
                      @change="writeProp(sv, p, inputs[keyOf(sv,p)])">
                      <option v-for="o in p.valueList" :key="o.value" :value="o.value">{{ zh2(o.description) || o.description }}（{{ o.value }}）</option>
                    </select>
                    <b v-else>{{ enumLabel(p, valOf(p)) }}</b>
                  </template>
                  <!-- 数值：数字输入 + 范围提示 -->
                  <template v-else-if="numFormats.includes(p.format)">
                    <template v-if="canWrite(p)">
                      <input type="number" class="sh-num" v-model="inputs[keyOf(sv,p)]"
                        :min="p.min" :max="p.max" :step="p.step || 1" :disabled="writing[keyOf(sv,p)]" />
                      <button class="btn sm" :disabled="writing[keyOf(sv,p)]" @click="writeProp(sv, p, numInput(sv, p))">写入</button>
                    </template>
                    <b v-else>{{ dispVal(p) }}</b>
                    <small v-if="p.min != null" class="sh-range">{{ p.min }} ~ {{ p.max }}{{ p.unit ? ' ' + p.unit : '' }}</small>
                  </template>
                  <!-- 字符串 -->
                  <template v-else>
                    <template v-if="canWrite(p)">
                      <input type="text" class="sh-num" v-model="inputs[keyOf(sv,p)]" :disabled="writing[keyOf(sv,p)]" />
                      <button class="btn sm" :disabled="writing[keyOf(sv,p)]" @click="writeProp(sv, p, inputs[keyOf(sv,p)])">写入</button>
                    </template>
                    <b v-else style="word-break:break-all">{{ dispVal(p) }}</b>
                  </template>
                </div>
                <small v-if="werr[keyOf(sv,p)]" class="sh-werr">{{ werr[keyOf(sv,p)] }}</small>
              </div>
            </div>

            <!-- 动作：可调用 -->
            <div v-if="sv.actions.length" class="sh-actions">
              <div v-for="a in sv.actions" :key="a.aiid" class="sh-action">
                <div class="sh-prop-name">
                  <span class="material-icons" style="font-size:14px;color:var(--muted)">bolt</span>{{ dispName(a) }} <span class="sh-tag">action</span><span class="sh-svc-id">aiid {{ a.aiid }}</span>
                </div>
                <div class="sh-prop-ctrl">
                  <template v-for="arg in a.in" :key="arg.piid">
                    <template v-if="arg.valueList">
                      <select v-model="actionArgs[sv.siid + '.' + a.aiid + '.' + arg.piid]">
                        <option v-for="o in arg.valueList" :key="o.value" :value="o.value">{{ o.description }}</option>
                      </select>
                    </template>
                    <input v-else-if="numFormats.includes(arg.format)" type="number" class="sh-num" :placeholder="arg.description || arg.name"
                      v-model="actionArgs[sv.siid + '.' + a.aiid + '.' + arg.piid]" />
                    <input v-else type="text" class="sh-num" :placeholder="arg.description || arg.name"
                      v-model="actionArgs[sv.siid + '.' + a.aiid + '.' + arg.piid]" />
                  </template>
                  <button class="btn sm" :disabled="acting[sv.siid + '.' + a.aiid]" @click="runAction(sv, a)">执行</button>
                </div>
              </div>
            </div>

            <!-- 事件：只读展示 -->
            <div v-if="sv.events.length" class="sh-events">
              <div v-for="e in sv.events" :key="e.eiid" class="sh-prop-name" style="font-weight:400;color:var(--muted)">
                <span class="material-icons" style="font-size:14px">notifications</span>{{ dispName(e) }} <span class="sh-tag">event</span>
                <small v-if="e.args.length">参数 {{ e.args.length }} 个</small>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { canTab, firstTab } from '../tabs';
import { api } from '../api';
import QRCode from 'qrcode';
import { zh, TERM_GROUPS } from '../miotTerms';
import XiaozhiPanel from '../components/XiaozhiPanel.vue';
import CcLightPanel from '../components/CcLightPanel.vue';

const route = useRoute();
const router = useRouter();
const tab = ref(firstTab('smarthome', 'mijia'));
function switchTab(t) {
  tab.value = t;
  router.replace({ query: { ...route.query, tab: t } });
  if (t === 'settings' && status.value.bound) {
    loadPrefs();
    if (!data.value) loadHomes(false); // 默认家庭下拉需要家庭列表（服务端 10s 缓存）
  }
}
// 兼容旧链接 ?tab=monitor / ?tab=verify：监控 tab 与二次验证已下线（v1.6.29），分别落到米家/设置
// v1.9.22 曾把 cclight 升格独立页并在此重定向；v1.9.23 放回本页子 tab，?tab=cclight 直接可用
const normalizeTab = (t) => (t === 'verify' ? 'settings' : t === 'monitor' ? 'mijia' : t);
watch(() => route.query.tab, (t) => {
  t = normalizeTab(String(t || ''));
  if (t && t !== tab.value && canTab('smarthome', t)) tab.value = t;
});
if (route.query.tab) {
  const t0 = normalizeTab(String(route.query.tab));
  if (canTab('smarthome', t0)) tab.value = t0;
}

// ---------- 消息 ----------
const err = ref('');
const okMsg = ref('');
let okTimer = null;
function flashOk(m) { okMsg.value = m; clearTimeout(okTimer); okTimer = setTimeout(() => (okMsg.value = ''), 4000); }
function flashErr(m) { err.value = m; setTimeout(() => (err.value = ''), 8000); }

// ---------- 绑定状态 / 扫码 ----------
const status = ref({ bound: false, regions: { cn: '中国大陆' } });
const region = ref('cn');
const qr = ref({ url: '', img: '', state: '' });
const qrLoading = ref(false);
const polling = ref(false);
let pollTimer = null;

async function loadStatus() {
  try { status.value = await api.get('/mihome/status'); } catch (e) { flashErr(e.message); }
}

async function startBind() {
  qrLoading.value = true;
  err.value = '';
  try {
    const r = await api.post('/mihome/bind/start', { region: region.value });
    qr.value = { url: r.auth_url, img: await QRCode.toDataURL(r.auth_url, { width: 260, margin: 1 }), state: r.state };
    startPoll();
  } catch (e) {
    flashErr('生成二维码失败：' + e.message);
  } finally {
    qrLoading.value = false;
  }
}
function startPoll() {
  stopPoll();
  polling.value = true;
  pollTimer = setInterval(async () => {
    try {
      const p = await api.get('/mihome/bind/poll');
      if (p.bound) {
        stopPoll();
        flashOk(`绑定成功${p.nickname ? '：' + p.nickname : ''}，正在加载设备…`);
        await loadStatus();
        if (canTab('smarthome', 'mijia')) switchTab('mijia');
        loadHomes(true);
      }
    } catch { /* 轮询失败静默，下轮再试 */ }
  }, 3000);
  // 二维码 10 分钟失效
  setTimeout(() => { if (polling.value) { stopPoll(); } }, 10 * 60 * 1000);
}
function stopPoll() { polling.value = false; if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

// 手动回填完成绑定（小米回调域名白名单 → 授权后页面打不开，code 在地址栏里）
const manualUrl = ref('');
const manualBusy = ref(false);
async function submitManual() {
  const url = manualUrl.value.trim();
  if (!url || manualBusy.value) return;
  manualBusy.value = true;
  err.value = '';
  try {
    const r = await api.post('/mihome/bind/manual', { url });
    if (r.ok) {
      stopPoll();
      manualUrl.value = '';
      flashOk(`绑定成功${r.nickname ? '：' + r.nickname : ''}，正在加载设备…`);
      await loadStatus();
      if (canTab('smarthome', 'mijia')) switchTab('mijia');
      loadHomes(true);
    }
  } catch (e) {
    flashErr('完成绑定失败：' + e.message);
    if ((e.message || '').includes('风控')) relayShow.value = true; // 自动展开浏览器直换通道
  } finally {
    manualBusy.value = false;
  }
}

// 浏览器直换令牌（自助通道）：小米要求换令牌请求与授权浏览器同出口，服务器出口不一致时
// 由用户浏览器直接打开 get_token（页面显示 JSON），复制回来注入。
const relayShow = ref(false);
const relayJson = ref('');
const relayBusy = ref(false);
const relayUrl = computed(() => {
  try {
    const code = new URLSearchParams((manualUrl.value.split('?')[1] || '')).get('code') || '';
    if (!code) return '';
    const did = new URLSearchParams((qr.value.url.split('?')[1] || '')).get('device_id') || '';
    if (!did) return '';
    const json = '{"client_id":2882303761520251711,"redirect_uri":"http://homeassistant.local:8123/api/mihome/callback","code":"' + code + '","device_id":"' + did + '"}';
    const host = region.value && region.value !== 'cn' ? region.value + '.ha.api.io.mi.com' : 'ha.api.io.mi.com';
    return 'https://' + host + '/app/v2/ha/oauth/get_token?data=' + encodeURIComponent(json);
  } catch { return ''; }
});
async function submitRelay() {
  const raw = relayJson.value.trim();
  if (!raw || relayBusy.value) return;
  let t = null;
  for (const s of [raw, raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1)]) {
    try { const j = JSON.parse(s); t = j.result && j.result.access_token ? j.result : j; break; } catch { /* 继续容错 */ }
  }
  if (!t || !t.access_token) { flashErr('令牌 JSON 解析失败：请复制换令牌页面显示的全部内容再粘贴'); return; }
  relayBusy.value = true;
  try {
    const r = await api.post('/mihome/bind/token', {
      access_token: t.access_token, refresh_token: t.refresh_token || '',
      expires_in: t.expires_in, region: region.value,
    });
    if (r.ok) {
      stopPoll(); manualUrl.value = ''; relayJson.value = ''; relayShow.value = false;
      flashOk(`绑定成功${r.nickname ? '：' + r.nickname : ''}，正在加载设备…`);
      await loadStatus();
      if (canTab('smarthome', 'mijia')) switchTab('mijia');
      loadHomes(true);
    }
  } catch (e) {
    flashErr('注入失败：' + e.message);
  } finally {
    relayBusy.value = false;
  }
}

async function copyLink() {
  try { await navigator.clipboard.writeText(qr.value.url); flashOk('授权链接已复制，请在手机浏览器打开'); }
  catch { flashErr('复制失败，请手动长按/选中最下方链接'); }
}

async function doUnbind() {
  if (!confirm('确定解绑米家账号？解绑后令牌立即清空，需重新扫码绑定。')) return;
  try {
    await api.post('/mihome/unbind', {});
    stopPoll();
    await loadStatus();
    flashOk('已解绑');
  } catch (e) { flashErr('解绑失败：' + e.message); }
}

// ---------- 家庭/房间/设备 ----------
const data = ref(null);
const loading = ref(false);
const toggling = ref({}); // did → busy
const curHome = ref(''); // 当前家庭 id（下拉切换；初始取默认家庭）

const curHomeData = computed(() => {
  const hs = data.value ? data.value.homes : [];
  return hs.find((h) => h.id === curHome.value) || hs[0] || null;
});
const curHomeName = computed(() => (curHomeData.value ? curHomeData.value.name : ''));
const deviceCount = computed(() => (curHomeData.value ? curHomeData.value.rooms.reduce((m, r) => m + r.devices.length, 0) : 0));
const onlineCount = computed(() => (curHomeData.value ? curHomeData.value.rooms.reduce((m, r) => m + r.devices.filter((d) => d.online).length, 0) : 0));

async function loadHomes(fresh) {
  err.value = '';
  if (!status.value.bound) await loadStatus();
  if (!status.value.bound) return;
  loading.value = true;
  try {
    data.value = await api.get('/mihome/homes' + (fresh ? '?fresh=1' : ''));
    // 默认家庭：设置页配置优先，否则第一个
    const ids = data.value.homes.map((h) => h.id);
    if (!ids.includes(curHome.value)) {
      let p = {};
      try { p = await api.get('/mihome/prefs'); } catch { /* 无配置则用第一个 */ }
      curHome.value = ids.includes(p.default_home) ? p.default_home : ids[0] || '';
    }
  } catch (e) {
    err.value = e.message;
    if (String(e.message).includes('绑定')) { await loadStatus(); data.value = null; }
  } finally {
    loading.value = false;
  }
}

// ---------- 偏好：默认家庭 / 缓存刷新间隔 ----------
const termQ = ref('');
const homes = computed(() => (data.value ? data.value.homes : []));
const defaultHome = ref('');
const cacheTtl = ref(60); // 列表缓存后台静默更新间隔（分钟，v1.6.16 可配）
const prefsSaving = ref(false);
async function loadPrefs() {
  try {
    const p = await api.get('/mihome/prefs');
    defaultHome.value = p.default_home || '';
    cacheTtl.value = p.cache_ttl_min || 60;
  } catch { /* 忽略 */ }
}
async function saveCacheTtl() {
  const n = Number(cacheTtl.value);
  if (!Number.isInteger(n) || n < 1 || n > 1440) { flashErr('缓存刷新间隔需为 1-1440 的整数（分钟）'); return; }
  prefsSaving.value = true;
  try {
    await api.put('/mihome/prefs', { cache_ttl_min: n });
    flashOk(`缓存刷新间隔已设为 ${n} 分钟`);
  } catch (e) {
    flashErr('保存失败：' + e.message);
  } finally {
    prefsSaving.value = false;
  }
}

// ---------- 参数词典：内置静态词典 + 服务端设备实测词条 ----------
const extraTerms = ref([]); // [en, zh][]，从 /mihome/terms 拉取（123 台生产设备全量提取翻译）
const extraMap = computed(() => {
  const m = new Map();
  for (const [en, z] of extraTerms.value) m.set(en, z);
  return m;
});
async function loadTerms() {
  try { extraTerms.value = (await api.get('/mihome/terms')).pairs || []; } catch { /* 静默：词典 tab 仍有内置词条 */ }
}
// 双层查词：先内置静态词典，再设备实测词典（键统一小写）
function zh2(s) {
  if (!s) return '';
  const v = zh(s);
  if (v) return v;
  return extraMap.value.get(String(s).trim().toLowerCase()) || '';
}
const termGroups = computed(() => {
  const groups = extraTerms.value.length
    ? [{ title: `设备实测词条（${extraTerms.value.length}，来自你家的设备）`, pairs: extraTerms.value }, ...TERM_GROUPS]
    : TERM_GROUPS;
  const q = termQ.value.trim().toLowerCase();
  if (!q) return groups;
  const qz = termQ.value.trim();
  return groups
    .map((g) => ({ title: g.title, pairs: g.pairs.filter(([en, z]) => en.toLowerCase().includes(q) || (z && z.includes(qz))) }))
    .filter((g) => g.pairs.length);
});
async function saveDefaultHome() {
  prefsSaving.value = true;
  try {
    await api.put('/mihome/prefs', { default_home: defaultHome.value });
    flashOk('默认家庭已保存');
  } catch (e) {
    flashErr('保存失败：' + e.message);
  } finally {
    prefsSaving.value = false;
  }
}

async function toggleSwitch(d) {
  if (!d.switch || toggling.value[d.did]) return;
  toggling.value[d.did] = true;
  const nextVal = d.switch.value !== true;
  const oldVal = d.switch.value;
  d.switch.value = nextVal; // 乐观更新
  try {
    const r = await api.post('/mihome/prop/set', { did: d.did, siid: d.switch.siid, piid: d.switch.piid, value: nextVal });
    if (!r.ok) { d.switch.value = oldVal; flashErr(`${d.name}：${r.message}`); resyncSwitch(d); }
    else flashOk(`${d.name} 已${nextVal ? '开启' : '关闭'}`);
  } catch (e) {
    d.switch.value = oldVal;
    flashErr(`${d.name} 控制失败：${e.message}`);
    resyncSwitch(d);
  } finally {
    delete toggling.value[d.did];
  }
}
// 失败后回读真实状态：有的上报错误但命令已执行（曾实测小米 did 传字符串时 set 报「设备不存在」但灯已亮），
// 直接回退乐观值会让界面与设备脱节 → 稍等 1s 读一次真实值校正。
async function resyncSwitch(d) {
  try {
    await new Promise((ok) => setTimeout(ok, 1000));
    if (!d.switch) return;
    const r = await api.post('/mihome/prop/get', { params: [{ did: d.did, siid: d.switch.siid, piid: d.switch.piid }] });
    const it = (r.result || []).find((x) => x.siid === d.switch.siid && x.piid === d.switch.piid);
    if (it && it.code === 0 && typeof it.value === 'boolean') d.switch.value = it.value;
  } catch { /* 读不到就保持当前显示 */ }
}

const numFormats = ['uint8', 'int8', 'uint16', 'int16', 'uint32', 'int32', 'uint64', 'int64', 'float'];
const detail = ref({ open: false, device: null, spec: null, loading: false, loadingVals: false, err: '', values: {} });
const inputs = ref({});   // 可写属性编辑值 key: siid.piid
const writing = ref({});  // 写入中 key
const werr = ref({});     // 写入错误 key
const actionArgs = ref({}); // 动作参数 key: siid.aiid.piid
const acting = ref({});

// 名称中文化：spec 描述是中文则优先（厂商原文更精确），否则查词典（内置+设备实测），最后回退原文
const hasZh = (s) => /[一-鿿]/.test(s || '');
function dispName(it) {
  if (hasZh(it.description)) return it.description;
  return zh2(it.name) || it.description || it.name;
}

const keyOf = (sv, p) => sv.siid + '.' + p.piid;
const valOf = (p) => (p.__v !== undefined ? p.__v : undefined);
const canWrite = (p) => (p.access || []).includes('write');
const dispVal = (p) => (p.__v !== undefined && p.__v !== null ? p.__v : '-');
function enumLabel(p, v) {
  if (v === undefined || v === null) return '-';
  const o = (p.valueList || []).find((x) => x.value === v);
  return o ? `${zh2(o.description) || o.description}（${v}）` : String(v);
}
function numInput(sv, p) {
  const raw = inputs.value[keyOf(sv, p)];
  if (raw === '' || raw === null || raw === undefined) return null;
  const n = Number(raw);
  if (Number.isNaN(n)) return null;
  return p.format === 'float' ? n : Math.round(n);
}

async function openDetail(d) {
  detail.value = { open: true, device: d, spec: null, loading: true, loadingVals: false, err: '', values: {} };
  inputs.value = {}; werr.value = {}; actionArgs.value = {}; writing.value = {}; acting.value = {};
  try {
    const spec = await api.get('/mihome/device/spec?did=' + encodeURIComponent(d.did));
    // 初始化可写输入框默认值
    for (const sv of spec.services) for (const p of sv.properties) inputs.value[keyOf(sv, p)] = '';
    detail.value.spec = spec;
    detail.value.loading = false;
    loadDetailValues();
  } catch (e) {
    detail.value.loading = false;
    detail.value.err = e.message;
  }
}
function closeDetail() { detail.value.open = false; }

// 打开详情/点「刷新数值」：批量读全部可读属性当前值
async function loadDetailValues() {
  const spec = detail.value.spec;
  if (!spec || detail.value.loadingVals) return;
  const readable = [];
  for (const sv of spec.services) for (const p of sv.properties) if ((p.access || []).includes('read')) readable.push({ sv, p });
  if (!readable.length) return;
  detail.value.loadingVals = true;
  try {
    for (let i = 0; i < readable.length; i += 50) {
      const batch = readable.slice(i, i + 50);
      const r = await api.post('/mihome/prop/get', { params: batch.map(({ sv, p }) => ({ did: detail.value.device.did, siid: sv.siid, piid: p.piid })) });
      for (const item of r.result || []) {
        const hit = batch.find(({ sv, p }) => sv.siid === item.siid && p.piid === item.piid);
        if (hit) hit.p.__v = item.value; // code!==0 时 value 缺省 → 保持 '-'
      }
    }
  } catch (e) {
    flashErr('读取属性失败：' + e.message);
  } finally {
    detail.value.loadingVals = false;
  }
}

async function writeProp(sv, p, value) {
  const k = keyOf(sv, p);
  if (writing.value[k]) return;
  if (value === null) { werr.value[k] = '请输入有效数值'; return; }
  writing.value[k] = true;
  delete werr.value[k];
  try {
    const r = await api.post('/mihome/prop/set', { did: detail.value.device.did, siid: sv.siid, piid: p.piid, value });
    if (r.ok) { p.__v = value; flashOk(`${p.description || p.name} 已设置为 ${value}`); }
    else { werr.value[k] = r.message; resyncProp(sv, p); }
  } catch (e) {
    werr.value[k] = e.message;
    resyncProp(sv, p);
  } finally {
    writing.value[k] = false;
  }
}
// 同 resyncSwitch：写入上报失败时回读真实值，避免界面与设备脱节（详情页开关）
async function resyncProp(sv, p) {
  try {
    await new Promise((ok) => setTimeout(ok, 1000));
    if (!detail.value.open || !detail.value.device) return;
    const r = await api.post('/mihome/prop/get', { params: [{ did: detail.value.device.did, siid: sv.siid, piid: p.piid }] });
    const it = (r.result || []).find((x) => x.siid === sv.siid && x.piid === p.piid);
    if (it && it.code === 0 && it.value !== undefined) { p.__v = it.value; delete werr.value[keyOf(sv, p)]; }
  } catch { /* 保持 */ }
}

async function runAction(sv, a) {
  const k = sv.siid + '.' + a.aiid;
  if (acting.value[k]) return;
  acting.value[k] = true;
  try {
    const inList = a.in.map((arg) => {
      const raw = actionArgs.value[sv.siid + '.' + a.aiid + '.' + arg.piid];
      if (raw === '' || raw === undefined) return arg.format.startsWith('int') || arg.format === 'float' ? 0 : '';
      return numFormats.includes(arg.format) ? Number(raw) : raw;
    });
    const r = await api.post('/mihome/action', { did: detail.value.device.did, siid: sv.siid, aiid: a.aiid, in: inList });
    if (r.ok) flashOk(`动作「${a.description || a.name}」已执行`);
    else flashErr(`动作执行失败：${r.error}`);
  } catch (e) {
    flashErr('动作执行失败：' + e.message);
  } finally {
    acting.value[k] = false;
  }
}

// ---------- 杂项 ----------
// 设备图标：Material Icons 单色字体（随文字颜色渲染，v1.6.14 起不再用彩色 emoji）
// 温湿度计卡片直显文本（有值才显示）
function envText(d) {
  const e = d.env;
  if (!e) return '';
  const parts = [];
  if (e.t && e.t.value != null) parts.push(e.t.value + '°C');
  if (e.h && e.h.value != null) parts.push(e.h.value + '%');
  return parts.join(' · ');
}

function iconOf(d) {
  const t = ((d.urn || '') + ' ' + (d.model || '') + ' ' + d.name).toLowerCase();
  const map = [
    ['lightbulb|light|灯', 'lightbulb'], ['outlet|plug|插', 'power'], ['curtain|blinds|窗帘', 'blinds'],
    ['air-conditioner|ac-|conditioner|空调', 'ac_unit'], ['air-purifier|purifier|净化', 'filter_air'],
    ['air-monitor|sensor|temperature|humidity|温|湿|sensor_ht', 'device_thermostat'], ['fan|风扇', 'toys'],
    ['lock|门锁', 'lock'], ['camera|摄像|cat-eye|doorbell|门铃', 'videocam'], ['vacuum|扫|扫地', 'cleaning_services'],
    ['humidifier|加湿', 'water_drop'], ['kettle|壶', 'coffee'], ['cooker|电饭|锅', 'rice_bowl'], ['refrigerator|冰箱', 'kitchen'],
    ['washer|洗衣', 'local_laundry_service'], ['heater|暖|浴霸', 'local_fire_department'], ['speaker|sound|音响|小爱', 'speaker'],
    ['television|tv|投影|projector', 'tv'], ['router|网关|gateway|hub', 'router'], ['switch|开关|button|key', 'toggle_on'],
    ['door|门', 'door_front'], ['bed|床垫|mattress', 'bed'], ['toothbrush|牙刷', 'brush'], ['treadmill|跑步', 'directions_run'],
    ['pet-feeder|喂食|饮水', 'pets'], ['airer|晾衣', 'checkroom'], ['ceiling|吊顶', 'home'],
  ];
  for (const [k, e] of map) if (new RegExp(k).test(t)) return e;
  return 'devices_other';
}
function fmtTime(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  if (isNaN(d)) return '-';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function shortTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return isNaN(d) ? '' : `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------- 生命周期 ----------
onMounted(async () => {
  loadTerms(); // 设备实测词条词典（详情页翻译回退 + 词典 tab 设备组）
  await loadStatus();
  if (status.value.bound && tab.value === 'mijia') loadHomes(false);
  if (status.value.bound && tab.value === 'settings') { loadPrefs(); if (!data.value) loadHomes(false); }
  // 回调页带 bind=ok 跳回：提示并清参数
  if (route.query.bind === 'ok') {
    router.replace({ query: { ...route.query, bind: undefined } });
    if (status.value.bound) {
      flashOk('米家账号绑定成功');
      if (canTab('smarthome', 'mijia')) { tab.value = 'mijia'; loadHomes(true); }
    }
  }
});
onBeforeUnmount(() => {
  stopPoll();
});
</script>

<style scoped>
/* 工具条 */
.sh-toolbar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; margin-bottom: 12px; }

/* 家庭/房间 */
.sh-home { font-size: 16px; font-weight: 600; margin-bottom: 10px; }
.sh-home-select { padding: 5px 8px; border-radius: 8px; border: 1px solid var(--border, rgba(128,128,128,.35)); background: transparent; color: inherit; font-size: 13px; max-width: 220px; }
.sh-home-name { font-size: 14px; font-weight: 600; }
.sh-emoji { font-size: 30px; line-height: 1; color: var(--text2, #888); }
.sh-room { margin-bottom: 14px; }
.sh-room-name { font-size: 13px; color: var(--muted); margin-bottom: 8px; }
.sh-room-cnt { background: var(--bg-soft, rgba(128,128,128,.15)); border-radius: 8px; padding: 0 8px; margin-left: 6px; font-size: 12px; }

/* 方形设备卡片 */
.sh-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
.sh-card {
  position: relative; aspect-ratio: 1/1; border-radius: 14px; border: 1px solid var(--border, rgba(128,128,128,.25));
  background: var(--card-bg, rgba(128,128,128,.08)); display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 6px; cursor: pointer; padding: 10px;
  transition: transform .1s, border-color .15s; text-align: center;
}
.sh-card:hover { transform: translateY(-2px); border-color: var(--accent, #4f8cff); }
.sh-card.offline { opacity: .55; }
/* 父设备角标（v1.6.25）：卡片左上角高亮标签 */
.sh-parent-tag {
  position: absolute; top: 8px; left: 8px; font-size: 10px; line-height: 1; font-weight: 600;
  padding: 3px 7px; border-radius: 6px; background: var(--accent, #4f8cff); color: #fff;
}
.sh-name { font-size: 14px; font-weight: 600; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sh-env { font-size: 13px; line-height: 1.4; font-variant-numeric: tabular-nums; color: var(--muted); }
.sh-env b { font-size: 16px; font-weight: 600; color: var(--text, inherit); }
.sh-env i { font-style: normal; font-size: 11px; margin-left: 1px; }
.sh-dot { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 4px; }
.sh-dot i, .sh-dot-i { width: 8px; height: 8px; border-radius: 50%; background: #9aa0a6; display: inline-block; }
.sh-dot i.on, .sh-dot-i.on { background: #1e9e68; }

/* 圆形开关按钮（卡片右下角） */
.sh-toggle {
  position: absolute; right: 10px; bottom: 10px; width: 44px; height: 44px; border-radius: 50%;
  border: 2px solid var(--border, rgba(128,128,128,.4)); background: rgba(128,128,128,.15);
  cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all .15s;
}
.sh-toggle span {
  width: 18px; height: 18px; border-radius: 50%; background: #9aa0a6; transition: all .15s;
}
.sh-toggle.on { border-color: #1e9e68; background: rgba(30,158,104,.15); box-shadow: 0 0 10px rgba(30,158,104,.35); }
.sh-toggle.on span { background: #1e9e68; transform: scale(1.15); }
.sh-toggle.busy { opacity: .6; pointer-events: none; }
.sh-toggle.sm { position: static; width: 36px; height: 36px; }
.sh-toggle.sm span { width: 14px; height: 14px; }

/* 设置 tab */
.sh-kv { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px dashed var(--border, rgba(128,128,128,.2)); font-size: 14px; }
.sh-kv span { color: var(--muted); }
.sh-qr { display: flex; gap: 18px; align-items: center; flex-wrap: wrap; }
.sh-qr img { border-radius: 10px; background: #fff; padding: 8px; width: 260px; height: 260px; }
.sh-qr-status { font-size: 14px; }
.sh-qr-tip { font-size: 12px; color: var(--muted); margin-top: 6px; }
.sh-auth-link { display: inline-block; margin-top: 6px; color: var(--accent, #4f8cff); font-size: 13px; }
.sh-steps { margin: 0 0 14px; padding-left: 20px; color: var(--muted); font-size: 13px; line-height: 1.9; }
.sh-manual { margin-top: 16px; padding-top: 12px; border-top: 1px dashed var(--border, rgba(128,128,128,.25)); }
.sh-manual-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.sh-manual-input { flex: 1; min-width: 260px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border, rgba(128,128,128,.35)); background: transparent; color: inherit; font-size: 13px; }
.sh-relay { margin-top: 12px; padding: 12px; border-radius: 10px; background: rgba(127,127,127,.07); }
.sh-relay-input { width: 100%; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border, rgba(128,128,128,.35)); background: transparent; color: inherit; font-size: 12px; font-family: ui-monospace, Consolas, monospace; resize: vertical; box-sizing: border-box; }
.sh-term-group { margin-bottom: 16px; }
.sh-term-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.sh-term-grid { display: flex; flex-wrap: wrap; gap: 8px; }
.sh-term { display: inline-flex; align-items: baseline; gap: 6px; padding: 4px 10px; border-radius: 999px; border: 1px solid var(--border, rgba(128,128,128,.25)); font-size: 12px; }
.sh-term span { color: var(--muted); font-family: ui-monospace, Consolas, monospace; font-size: 11px; }
.sh-notes { margin: 0; padding-left: 18px; color: var(--muted); font-size: 13px; line-height: 2; }

/* 详情弹窗 */
.sh-mask { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 100; display: flex; align-items: center; justify-content: center; padding: 20px; }
.sh-modal {
  background: var(--panel-bg, #fff); color: var(--text, #222); border-radius: 16px; width: min(720px, 100%);
  max-height: 86vh; display: flex; flex-direction: column; box-shadow: 0 10px 40px rgba(0,0,0,.3);
}
[data-theme='dark'] .sh-modal, :root.dark .sh-modal { background: #23272e; }
.sh-modal-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--border, rgba(128,128,128,.25)); }
.sh-close { border: none; background: transparent; font-size: 18px; cursor: pointer; color: var(--muted); padding: 4px 8px; }
.sh-modal-body { overflow-y: auto; padding: 12px 16px 20px; }
.sh-svc { margin-bottom: 16px; }
.sh-svc-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; font-size: 14px; }
.sh-svc-desc { color: var(--muted); font-size: 12px; flex: 1; }
.sh-svc-id { font-size: 11px; color: var(--muted); background: var(--bg-soft, rgba(128,128,128,.12)); border-radius: 6px; padding: 1px 6px; }
.sh-props, .sh-actions { display: flex; flex-direction: column; gap: 6px; }
.sh-prop { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 7px 10px; border-radius: 8px; background: var(--bg-soft, rgba(128,128,128,.07)); }
.sh-prop-name { font-size: 13px; min-width: 160px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sh-tag { font-size: 10px; padding: 1px 6px; border-radius: 6px; background: var(--bg-soft, rgba(128,128,128,.15)); color: var(--muted); }
.sh-tag.w { color: #1e9e68; }
.sh-prop-ctrl { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; flex: 1; justify-content: flex-end; }
.sh-num { width: 110px; padding: 5px 8px; border-radius: 8px; border: 1px solid var(--border, rgba(128,128,128,.35)); background: transparent; color: inherit; font-size: 13px; }
.sh-range { color: var(--muted); font-size: 11px; }
.sh-werr { width: 100%; color: #e06c75; font-size: 12px; }
.sh-prop-ctrl select { padding: 5px 8px; border-radius: 8px; border: 1px solid var(--border, rgba(128,128,128,.35)); background: transparent; color: inherit; font-size: 13px; }
.btn.sm { padding: 4px 12px; font-size: 12px; }
.btn.danger { border-color: #d64545; color: #d64545; }
.btn.ghost { background: transparent; }
.sh-events { margin-top: 6px; }

</style>
