<template>
  <div class="page" style="max-width:640px; margin:0 auto">
    <div v-if="msg" class="msg" :class="msgType">{{ msg }}</div>

    <div class="card">
      <h2>📲 钉钉绑定</h2>
      <div class="muted" style="margin-bottom:12px; font-size:13px">
        绑定后，发给你的工作台消息（站内互发 / 家庭事项 / 子女学习通知，含写给自己的备忘）会同步推送到你的钉钉。
      </div>

      <!-- 已绑定 -->
      <div v-if="cfg.userid" style="border:1px solid var(--border,#334155); border-radius:10px; padding:14px 16px; margin-bottom:14px">
        <div style="margin-bottom:8px">
          ✅ 已绑定：<b>{{ cfg.bound_nick || '钉钉用户' }}</b>
          <span class="muted">（userid：{{ cfg.userid }}）</span>
          <span v-if="cfg.bound_at" class="muted">· {{ cfg.bound_at }}</span>
        </div>
        <label style="display:flex; align-items:center; gap:6px; cursor:pointer; margin-bottom:10px">
          <input v-model="cfg.enabled" type="checkbox" style="width:auto" @change="saveEnabled" />
          启用推送：新消息同步推送到钉钉
        </label>
        <div class="row" style="gap:8px; flex-wrap:wrap">
          <button class="primary" @click="test">测试发送</button>
          <button @click="newTicket">重新扫码绑定</button>
          <button class="small" @click="unbind">解绑</button>
        </div>
      </div>

      <!-- 第一步：应用凭证（未配置时） -->
      <div v-if="!cfg.app_key" style="margin-bottom:14px">
        <h3 style="font-size:14px">第一步：填写企业内部应用凭证</h3>
        <div class="muted" style="font-size:12.5px; margin-bottom:8px">
          在钉钉开放平台（open.dingtalk.com）创建「企业内部应用」，把 AppKey / AppSecret 填到下面保存；
          应用需开通「通讯录只读」权限（扫码后自动换取你的 userid）。
        </div>
        <div class="form-row"><label>AppKey</label><input v-model="cred.key" placeholder="ding..." /></div>
        <div class="form-row"><label>AppSecret</label><input v-model="cred.secret" type="password" placeholder="AppSecret" /></div>
        <button class="primary" @click="saveCred">保存并生成二维码</button>
      </div>

      <!-- 第二步：扫码 -->
      <div v-if="cfg.app_key && qr" style="text-align:center">
        <h3 style="font-size:14px; margin-bottom:6px">{{ cfg.userid ? '重新绑定：扫码' : '第二步：钉钉扫码' }}</h3>
        <div class="muted" style="font-size:12.5px; margin-bottom:10px">
          打开手机钉钉 → 顶部「＋」→「扫一扫」→ 扫描下方二维码并在手机上点「同意」。
        </div>
        <img :src="qr" alt="钉钉绑定二维码" style="width:220px; height:220px; background:#fff; padding:8px; border-radius:8px" />
        <div class="muted" style="font-size:12px; margin-top:8px; word-break:break-all">
          回调地址：{{ redirectBase }}/api/dingtalk/bind/callback<br />
          （手机需能访问该地址：与电脑同一局域网即可；跨网部署在设置页「钉钉推送-回调基础地址」填写公网地址）<br />
          若扫码确认后提示 redirect_uri 不合法：到钉钉开放平台该应用的「安全设置」，把回调域名
          {{ redirectBase.replace(/^https?:\/\//, '') }} 加入后重试。
        </div>
        <div class="row" style="gap:8px; margin-top:10px; justify-content:center">
          <button class="small" @click="newTicket">刷新二维码</button>
          <span v-if="state === 'pending'" class="muted" style="font-size:13px">⏳ 等待扫码确认…</span>
          <span v-else-if="state === 'error'" style="font-size:13px; color:var(--danger,#f87171)">{{ stateError }}</span>
        </div>
      </div>
      <div v-else-if="cfg.app_key" style="text-align:center">
        <button class="primary" @click="newTicket">生成绑定二维码</button>
      </div>

      <p style="margin-top:16px"><router-link to="/settings">← 返回设置</router-link></p>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { api } from '../api';
import QRCode from 'qrcode';

const cfg = ref({ app_key: '', userid: '', enabled: false, bound_nick: '', bound_at: '' });
const cred = ref({ key: '', secret: '' });
const qr = ref('');
const redirectBase = ref('');
const state = ref(''); // ''|'pending'|'error'
const stateError = ref('');
const msg = ref('');
const msgType = ref('ok');
let ticket = '';
let timer = null;

function flash(text, type = 'ok') {
  msg.value = text;
  msgType.value = type;
  setTimeout(() => (msg.value = ''), 4000);
}

async function loadCfg() {
  const g = await api.get('/dingtalk/config');
  cfg.value = { app_key: g.app_key || '', userid: g.userid || '', enabled: !!g.enabled, bound_nick: g.bound_nick || '', bound_at: g.bound_at || '' };
}

async function saveCred() {
  if (!cred.value.key.trim() || !cred.value.secret.trim()) return flash('AppKey / AppSecret 都要填', 'err');
  try {
    await api.post('/dingtalk/config', { app_key: cred.value.key.trim(), app_secret: cred.value.secret.trim(), mode: 'robot' });
    flash('凭证已保存');
    await loadCfg();
    newTicket();
  } catch (e) { flash(e.message, 'err'); }
}

async function saveEnabled() {
  try { await api.post('/dingtalk/config', { enabled: cfg.value.enabled }); flash(cfg.value.enabled ? '已启用推送' : '已停用推送'); }
  catch (e) { flash(e.message, 'err'); }
}

// 生成绑定二维码（新票据），并开始轮询扫码结果
async function newTicket() {
  try {
    const t = await api.post('/dingtalk/bind/ticket');
    ticket = t.ticket;
    redirectBase.value = t.redirect_base;
    qr.value = await QRCode.toDataURL(t.qr_url, { width: 220, margin: 1 });
    state.value = 'pending';
    stateError.value = '';
    startPoll();
    // 滚到二维码
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  } catch (e) { flash(e.message, 'err'); }
}

function startPoll() {
  stopPoll();
  timer = setInterval(async () => {
    if (!ticket) return stopPoll();
    try {
      const s = await api.get('/dingtalk/bind/status?ticket=' + encodeURIComponent(ticket));
      if (s.status === 'bound') {
        stopPoll();
        qr.value = '';
        state.value = '';
        await loadCfg();
        flash(`绑定成功：${cfg.value.bound_nick || cfg.value.userid}，推送已自动启用`);
      } else if (s.status === 'expired') {
        stopPoll();
        state.value = 'error';
        stateError.value = '二维码已过期，请刷新重扫';
      } else if (s.error) {
        state.value = 'error';
        stateError.value = s.error;
      }
    } catch { /* 轮询失败忽略，下轮重试 */ }
  }, 2000);
}
function stopPoll() { if (timer) { clearInterval(timer); timer = null; } }

async function unbind() {
  try {
    await api.post('/dingtalk/unbind');
    await loadCfg();
    qr.value = '';
    flash('已解绑，推送停用');
  } catch (e) { flash(e.message, 'err'); }
}

async function test() {
  try { await api.post('/dingtalk/test'); flash('测试消息已发送，去钉钉查看'); }
  catch (e) { flash(e.message, 'err'); }
}

onMounted(async () => {
  try { await loadCfg(); } catch (e) { flash(e.message, 'err'); }
});
onUnmounted(stopPoll);
</script>
