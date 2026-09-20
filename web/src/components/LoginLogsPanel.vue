<template>
  <div>
    <div v-if="msg" class="msg" :class="msgType">{{ msg }}</div>

    <!-- IP 黑名单 -->
    <div class="card" style="margin-bottom:14px">
      <h3>⛔ IP 黑名单 <span class="badge" style="background:#c0392b;color:#fff">{{ bans.length }} 个</span></h3>
      <div class="muted" style="margin-bottom:10px">黑名单内的 IP <b>无法访问系统的任何部分</b>（连登录页都打不开）。账号连续 10 次密码错误时也会自动封禁其来源 IP。<br />注意：经内网穿透（花生壳）访问时所有访客 IP 都是本机回环地址——回环与自己当前使用的 IP 不可封，防止把整站锁死。</div>
      <div class="row" style="flex-wrap:wrap; margin-bottom:12px">
        <input v-model="newIp" placeholder="IP 地址，如 203.0.113.5" style="width:200px" @keyup.enter="addBan" />
        <input v-model="newNote" placeholder="备注（选填，如：爆破来源）" style="width:220px" @keyup.enter="addBan" />
        <button class="danger" @click="addBan">＋ 加入黑名单</button>
      </div>
      <div v-if="bans.length" class="table-wrap">
        <table class="ll-table">
          <thead><tr><th>IP</th><th>备注</th><th>操作人</th><th>封禁时间</th><th style="width:90px">操作</th></tr></thead>
          <tbody>
            <tr v-for="b in bans" :key="b.ip">
              <td style="white-space:nowrap"><b>{{ b.ip }}</b></td>
              <td style="white-space:normal">{{ b.note || '—' }}</td>
              <td style="white-space:nowrap">{{ b.created_by }}</td>
              <td style="white-space:nowrap">{{ b.created_at }}</td>
              <td><button class="small" @click="unban(b)">解封</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="empty">黑名单为空</div>
    </div>

    <!-- 登录日志 -->
    <div class="card">
      <h3>🛡️ 登录日志 <span class="badge blue">{{ logs.total || 0 }} 条</span></h3>
      <div class="muted" style="margin-bottom:8px">记录每一次登录尝试（成功、密码错误、锁定期内尝试、IP 熔断）。失败行的「尝试的密码」是对方当时输入的内容；<b>成功登录不记录密码</b>（防止日志本身变成明文口令表）。</div>
      <div class="row" style="margin-bottom:10px">
        <select v-model="outcome" style="width:auto" @change="loadLogs(1)">
          <option value="">全部</option>
          <option value="success">仅成功登录</option>
          <option value="fail">仅失败尝试</option>
        </select>
        <button class="small" @click="loadLogs(logs.page)">⟳ 刷新</button>
      </div>
      <div v-if="logs.rows?.length" class="table-wrap">
        <table class="ll-table">
          <thead><tr><th>日期时间</th><th>用户名</th><th>结果</th><th>IP</th><th>地区</th><th>尝试的密码</th><th>客户端</th><th style="width:70px">操作</th></tr></thead>
          <tbody>
            <tr v-for="r in logs.rows" :key="r.id">
              <td style="white-space:nowrap">{{ r.ts }}</td>
              <td style="white-space:nowrap">{{ r.username }}</td>
              <td style="white-space:nowrap">
                <span v-if="r.success" class="badge blue">成功</span>
                <span v-else class="badge" style="background:#c0392b;color:#fff">失败</span>
                <span class="muted" style="font-size:12px">{{ r.reason }}</span>
              </td>
              <td style="white-space:nowrap">{{ r.ip }}</td>
              <td style="white-space:nowrap">{{ r.region || '—' }}</td>
              <td style="max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap" :title="r.attempted_password || ''">{{ r.success ? '—' : (r.attempted_password || '(空)') }}</td>
              <td style="max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap" :title="r.user_agent">{{ r.user_agent || '—' }}</td>
              <td>
                <button v-if="bannable(r)" class="small" style="color:#c0392b" @click="banRow(r)" :title="'封禁 ' + r.ip">封禁</button>
                <span v-else-if="r.ip" class="muted" style="font-size:11px" title="内网/回环地址不可封禁">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="empty">暂无登录日志</div>
      <div v-if="(logs.total || 0) > (logs.pageSize || 30)" class="row" style="justify-content:flex-end; align-items:center; gap:8px; margin-top:10px">
        <span class="muted" style="font-size:12px">共 {{ logs.total }} 条 · 第 {{ logs.page }}/{{ pages }} 页</span>
        <button class="small" :disabled="logs.page <= 1" @click="loadLogs(logs.page - 1)">上一页</button>
        <button class="small" :disabled="logs.page >= pages" @click="loadLogs(logs.page + 1)">下一页</button>
      </div>
    </div>
  </div>
</template>

<script setup>
// 登录日志 + IP 黑名单管理（v1.3.4，设置页 tab，仅管理员；挂载时懒加载数据）
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';

const msg = ref('');
const msgType = ref('ok');
function flash(text, type = 'ok') {
  msg.value = text;
  msgType.value = type;
  window.scrollTo({ top: 0, behavior: 'smooth' });
  setTimeout(() => (msg.value = ''), 4000);
}

// ---------- IP 黑名单 ----------
const bans = ref([]);
const newIp = ref('');
const newNote = ref('');
async function loadBans() {
  try { bans.value = (await api.get('/ip-bans')).bans || []; } catch { bans.value = []; }
}
async function addBan() {
  const ip = newIp.value.trim();
  if (!ip) { flash('请输入 IP 地址', 'err'); return; }
  try {
    await api.put(`/ip-bans/${encodeURIComponent(ip)}`, { note: newNote.value.trim() });
    newIp.value = ''; newNote.value = '';
    await loadBans();
    flash(`已封禁 ${ip}：其将无法访问系统任何部分`);
  } catch (e) { flash(e.message, 'err'); }
}
async function banRow(r) {
  if (!confirm(`封禁 IP ${r.ip}？该地址将无法访问系统的任何部分（连登录页都打不开）。`)) return;
  try {
    await api.put(`/ip-bans/${encodeURIComponent(r.ip)}`, { note: `登录日志封禁：${r.username} ${r.reason}` });
    await loadBans();
    flash(`已封禁 ${r.ip}`);
  } catch (e) { flash(e.message, 'err'); }
}
async function unban(b) {
  if (!confirm(`解封 IP ${b.ip}？其可重新访问系统。`)) return;
  try {
    await api.del(`/ip-bans/${encodeURIComponent(b.ip)}`);
    await loadBans();
    flash(`已解封 ${b.ip}`);
  } catch (e) { flash(e.message, 'err'); }
}

// 内网/回环地址不提供封禁按钮（花生壳穿透下是全站共用出口，封了=自锁整站）
const PRIV_RE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|localhost)/i;
function bannable(r) { return !!r.ip && !PRIV_RE.test(r.ip); }

// ---------- 登录日志 ----------
const logs = ref({ total: 0, page: 1, pageSize: 30, rows: [] });
const outcome = ref(''); // '' 全部 / success / fail
const pages = computed(() => Math.max(1, Math.ceil((logs.value.total || 0) / (logs.value.pageSize || 30))));
async function loadLogs(p) {
  try {
    logs.value = await api.get(`/auth/login-logs?page=${p || 1}&pageSize=30${outcome.value ? `&outcome=${outcome.value}` : ''}`);
  } catch { logs.value = { total: 0, page: 1, pageSize: 30, rows: [] }; }
}

onMounted(() => { loadBans(); loadLogs(1); });
</script>

<style scoped>
.table-wrap { overflow-x: auto; }
.ll-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.ll-table th { text-align: left; padding: 8px 10px; border-bottom: 2px solid var(--border); color: var(--muted, #888); white-space: nowrap; }
.ll-table td { padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; }
.ll-table tr:last-child td { border-bottom: none; }
.ll-table tbody tr:hover td { background: rgba(79, 124, 247, 0.08); }
</style>
