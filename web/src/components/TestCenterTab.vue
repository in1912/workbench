<template>
  <div>
    <div class="card" style="margin-bottom:12px">
      <div class="row" style="flex-wrap:wrap; gap:8px">
        <button class="small" :disabled="!enabled" @click="h5Open">↗ 新窗口打开</button>
        <button class="small" :disabled="!enabled" @click="h5Reload">⟳ 重新加载</button>
        <span class="muted">测试记录自动同步到工作台；结果页「复制分享链接」生成的外链，接收方<b>无需登录</b>即可打开。</span>
      </div>
    </div>

    <div v-if="isAdmin" class="card" style="margin-bottom:12px">
      <h3>🔗 分享域名前缀</h3>
      <div class="row" style="margin-bottom:10px; align-items:center; gap:8px; flex-wrap:wrap">
        <label style="display:inline-flex; align-items:center; gap:6px; cursor:pointer">
          <input type="checkbox" v-model="enabled" @change="saveEnabled" />
          <b :style="{ color: enabled ? '' : 'var(--danger, #d33)' }">对外测试开关（{{ enabled ? '开' : '关' }}）</b>
        </label>
        <span class="muted" style="font-size:12px">关闭后：测试网页、分享链接与全部免登录接口对外失效（403），防止匿名滥用；管理员的记录管理不受影响。</span>
      </div>
      <div class="row">
        <input v-model="prefix" placeholder="https://your.domain.com（留空 = 使用当前访问地址）" class="grow" />
        <button class="primary" @click="savePrefix">保存</button>
      </div>
      <div class="muted" style="margin-top:8px">
        拼接示例：{{ sample }}
        <template v-if="msg"> · <b style="color:var(--accent)">{{ msg }}</b></template>
      </div>
    </div>

    <div v-if="enabled" class="card" style="padding:0; overflow:hidden">
      <iframe :src="src" :title="cfg.title" style="width:100%; height:78vh; border:0; display:block"></iframe>
    </div>
    <div v-else class="card" style="padding:40px 20px; text-align:center">
      <h3>🚫 {{ cfg.title }}已停用</h3>
      <p class="muted">管理员已关闭对外测试：测试网页与分享链接暂不可用{{ isAdmin ? '（上方「对外测试开关」可重新开启）' : '' }}。</p>
    </div>

    <template v-if="isAdmin">
      <div class="card" style="margin-top:12px">
        <h3>🗂️ 系统用户（{{ users.total || 0 }} 个测试编号）</h3>
        <div class="muted" style="margin-bottom:8px">按 H5 档案编号分组；「AI分析」勾选后，该编号在 H5 里即可对测试结果使用 AI 深度分析（走工作台统一 AI 配置）。</div>
        <div v-if="users.rows?.length" class="table-wrap">
          <table class="tc-table">
            <thead><tr><th>测试人</th><th>资料</th><th>测试次数</th><th>AI分析</th><th>最近测试</th><th style="width:110px">操作</th></tr></thead>
            <tbody>
              <tr v-for="u in users.rows" :key="u.uid">
                <td>
                  <b>{{ u.nickname || u.real_name || u.user_name || u.uid }}</b>
                  <div class="muted" style="font-size:12px">{{ u.uid }}</div>
                </td>
                <td style="max-width:220px">
                  <template v-if="u.real_name || u.age || u.gender || u.job || u.hobbies">
                    <div v-if="u.real_name">{{ u.real_name }}<template v-if="u.gender"> · {{ u.gender }}</template><template v-if="u.age"> · {{ u.age }}岁</template></div>
                    <div class="muted" style="font-size:12px"><template v-if="u.job">{{ u.job }}</template><template v-if="u.hobbies">{{ u.job ? ' · ' : '' }}{{ u.hobbies }}</template></div>
                  </template>
                  <span v-else class="muted" style="font-size:12px">未填资料</span>
                </td>
                <td>{{ u.count }}<span class="muted" style="font-size:12px">（{{ cfg.countLabel }} {{ u.mbti_count || 0 }}）</span></td>
                <td>
                  <label style="display:inline-flex; align-items:center; gap:4px; cursor:pointer">
                    <input type="checkbox" :checked="!!u.ai_authorized" @change="toggleAi(u)" />
                    <span class="muted" style="font-size:12px">{{ u.ai_authorized ? '已授权' : '未授权' }}</span>
                  </label>
                </td>
                <td>{{ (u.last_at || '').slice(0, 16) || '—' }}</td>
                <td>
                  <button class="small" @click="filterBy(u.uid)">测试记录</button>
                  <button class="small" @click="delUser(u)" style="margin-left:4px">删除</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty">还没有任何用户做过测试</div>
        <div v-if="(users.total || 0) > (users.pageSize || 15)" class="row" style="justify-content:flex-end; align-items:center; gap:8px; margin-top:10px">
          <span class="muted" style="font-size:12px">共 {{ users.total }} 条 · 第 {{ users.page }}/{{ usersPages }} 页</span>
          <button class="small" :disabled="users.page <= 1" @click="loadUsers(users.page - 1)">上一页</button>
          <button class="small" :disabled="users.page >= usersPages" @click="loadUsers(users.page + 1)">下一页</button>
        </div>
      </div>

      <div class="card">
        <h3>📋 用户测试列表（{{ list.total || 0 }} 份）</h3>
        <div class="row" style="margin-bottom:10px">
          <select v-model="userFilter" style="width:auto">
            <option value="">全部测试人</option>
            <option v-for="u in users.rows" :key="u.uid" :value="u.uid">{{ u.nickname || u.real_name || u.user_name || u.uid }}</option>
          </select>
        </div>
        <div v-if="list.rows?.length" class="table-wrap">
          <table class="tc-table">
            <thead><tr><th>用户</th><th>测试</th><th>结果</th><th>档案名</th><th>完成时间</th><th style="width:190px">操作</th></tr></thead>
            <tbody>
              <tr v-for="r in list.rows" :key="r.id">
                <td>{{ r.user_name || r.uid || ('用户#' + r.user_id) }}</td>
                <td>{{ r.test_title || cfg.fallback(r) }}</td>
                <td><span v-if="r.type" class="badge blue">{{ r.type }}</span><span v-else-if="r.summary">{{ r.summary }}</span></td>
                <td>{{ r.name || r.uid || r.id.slice(0, 10) + '…' }}</td>
                <td>{{ fmtDbTime(r.finished_at || r.updated_at) }}</td>
                <td>
                  <button class="small" :disabled="!enabled" :title="enabled ? '' : '已停用对外测试，预览/分享链接不可用'" @click="view(r)">查看</button>
                  <button class="small" :disabled="!enabled" :title="enabled ? '' : '已停用对外测试，预览/分享链接不可用'" @click="copyLink(r)">复制链接</button>
                  <button class="small" @click="del(r)">删除</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty">暂无测试记录</div>
        <div v-if="(list.total || 0) > (list.pageSize || 15)" class="row" style="justify-content:flex-end; align-items:center; gap:8px; margin-top:10px">
          <span class="muted" style="font-size:12px">共 {{ list.total }} 条 · 第 {{ list.page }}/{{ listPages }} 页</span>
          <button class="small" :disabled="list.page <= 1" @click="loadList(list.page - 1)">上一页</button>
          <button class="small" :disabled="list.page >= listPages" @click="loadList(list.page + 1)">下一页</button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup>
// 测评中心通用 tab（v1.3.0）：H5 嵌入 + 管理端（系统用户 / 测试列表 / AI 授权 / 分享前缀）。
// 三个中心接口同构（/api/mbti|dep|pro/*，见 mbtiRoutes 及其生成件），本组件按 center 参数取配置。
// users.mbti_count 是后端前端兼容列名：mbti 中心=MBTI 份数，dep/pro 中心=已 AI 分析份数（countLabel 区分文案）
import { ref, computed, onMounted, watch } from 'vue';
import { api } from '../api';

const props = defineProps({
  center: { type: String, required: true }, // 'mbti' | 'dep' | 'pro'
});

const CFG = {
  mbti: {
    title: '职业测试', h5: '/mbti/index.html', api: '/mbti', countLabel: 'MBTI',
    fallback: (r) => (r.test_id === 'mbti' || r.version ? 'MBTI 职业性格测试' : '趣味测试'),
  },
  dep: {
    title: '抑郁测试', h5: '/dep/index.html', api: '/dep', countLabel: '已析',
    fallback: () => '抑郁测评量表',
  },
  pro: {
    title: '心理测试', h5: '/pro/index.html', api: '/pro', countLabel: '已析',
    fallback: () => '心理测评量表',
  },
};
const cfg = CFG[props.center] || CFG.mbti;

const isAdmin = (() => {
  try { return (JSON.parse(localStorage.getItem('wb_user') || 'null') || {}).role === 'admin'; } catch { return false; }
})();

const src = ref(cfg.h5);
const prefix = ref('');
const enabled = ref(true); // 对外开关（v1.3.2）：关闭后 H5 页面与免登录接口全 403
const msg = ref('');
const users = ref({ total: 0, page: 1, pageSize: 15, rows: [] });
const list = ref({ total: 0, page: 1, pageSize: 15, rows: [] });
const userFilter = ref(''); // '' = 全部；否则为 H5 档案号 uid

const usersPages = computed(() => Math.max(1, Math.ceil((users.value.total || 0) / (users.value.pageSize || 15))));
const listPages = computed(() => Math.max(1, Math.ceil((list.value.total || 0) / (list.value.pageSize || 15))));
const sample = computed(() => {
  const base = (prefix.value.trim() || location.origin).replace(/\/+$/, '');
  return base + cfg.h5 + '#/result/（档案ID）';
});

function h5Open() { window.open(cfg.h5, '_blank'); }
function h5Reload() { src.value = cfg.h5 + '?t=' + Date.now(); }

async function loadAll() {
  try { const c = await api.get(cfg.api + '/config'); prefix.value = c.prefix || ''; enabled.value = c.enabled !== false; } catch { /* 无 tab 权限/未配置时留空 */ }
  if (isAdmin) { loadUsers(1); loadList(1); }
}
async function saveEnabled() {
  try {
    const r = await api.put(cfg.api + '/config', { enabled: enabled.value });
    enabled.value = r.enabled !== false;
    msg.value = enabled.value ? '已开启对外测试' : '已关闭：网页、分享链接与免登录接口全部失效';
  } catch (e) {
    enabled.value = !enabled.value; // 失败回弹
    msg.value = '操作失败：' + (e.message || e);
  }
  setTimeout(() => (msg.value = ''), 3000);
}
async function loadUsers(p) {
  try { users.value = await api.get(`${cfg.api}/users?page=${p || 1}&pageSize=15`); } catch { users.value = { total: 0, page: 1, pageSize: 15, rows: [] }; }
}
async function loadList(p) {
  const u = userFilter.value;
  try { list.value = await api.get(`${cfg.api}/records?page=${p || 1}&pageSize=15${u ? `&uid=${encodeURIComponent(u)}` : ''}`); } catch { list.value = { total: 0, page: 1, pageSize: 15, rows: [] }; }
}
watch(userFilter, () => loadList(1));
function filterBy(uid) { userFilter.value = uid; loadList(1); }

async function delUser(u) {
  const label = u.nickname || u.real_name || u.user_name || u.uid;
  if (!confirm(`确定删除测试人员「${label}」（${u.uid}）？其档案资料与全部 ${u.count || 0} 份测试记录将一并删除，分享链接立即失效。`)) return;
  try {
    const r = await api.del(`${cfg.api}/users/${encodeURIComponent(u.uid)}`);
    msg.value = `已删除 ${u.uid}（${r.deleted_records || 0} 份记录）`;
    await Promise.all([loadUsers(users.value.page), loadList(1)]);
  } catch (e) {
    alert('删除失败：' + (e.message || e));
  }
  setTimeout(() => (msg.value = ''), 2500);
}
async function toggleAi(u) {
  try {
    await api.put(`${cfg.api}/users/${encodeURIComponent(u.uid)}/ai-auth`, { authorized: !u.ai_authorized });
    u.ai_authorized = u.ai_authorized ? 0 : 1;
    msg.value = u.ai_authorized ? `已为 ${u.uid} 开通 AI 深度分析` : `已关闭 ${u.uid} 的 AI 分析`;
  } catch (e) {
    alert('授权失败：' + (e.message || e));
    loadUsers(users.value.page);
  }
  setTimeout(() => (msg.value = ''), 2500);
}

async function savePrefix() {
  try {
    await api.put(cfg.api + '/config', { prefix: prefix.value.trim() });
    msg.value = '已保存';
    setTimeout(() => (msg.value = ''), 2000);
  } catch (e) {
    msg.value = '保存失败：' + (e.message || e);
  }
}
function view(r) { window.open(cfg.h5 + '#/result/' + encodeURIComponent(r.id), '_blank'); }
// 完成时间展示：旧档案存 UTC ISO（带 Z，如 2026-09-10T09:21:00.000Z）→ 转浏览器本地；
// 新档案入库已转 'YYYY-MM-DD HH:mm:ss' 本地格式，直接截取
function fmtDbTime(s) {
  if (!s) return '';
  const str = String(s);
  if (/Z$|[+-]\d{2}:?\d{2}$/.test(str)) {
    const d = new Date(str);
    if (!isNaN(d)) {
      const p = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    }
  }
  return str.slice(0, 16).replace('T', ' ');
}
function shareBase() {
  return (prefix.value.trim() || location.origin).replace(/\/+$/, '');
}
function copyLink(r) {
  const link = shareBase() + cfg.h5 + '#/result/' + encodeURIComponent(r.id);
  navigator.clipboard?.writeText(link).then(() => {
    msg.value = '分享链接已复制';
    setTimeout(() => (msg.value = ''), 2000);
  });
}
async function del(r) {
  if (!confirm(`确定删除「${r.name || r.id}」的测试记录？删除后其分享链接立即失效。`)) return;
  try {
    await api.del(`${cfg.api}/records/${encodeURIComponent(r.id)}`);
    await Promise.all([loadList(list.value.page), loadUsers(1)]);
  } catch (e) {
    alert('删除失败：' + (e.message || e));
  }
}

onMounted(loadAll);
</script>

<style scoped>
/* 测评中心管理列表（系统用户 / 用户测试） */
.table-wrap { overflow-x: auto; }
.tc-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.tc-table th { text-align: left; padding: 8px 10px; border-bottom: 2px solid var(--border); color: var(--muted, #888); white-space: nowrap; }
.tc-table td { padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: middle; white-space: nowrap; }
.tc-table tr:last-child td { border-bottom: none; }
.tc-table tbody tr:hover td { background: rgba(79, 124, 247, 0.08); }
</style>
