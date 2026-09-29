<template>
  <!-- 用户管理（原独立页，2026-09 v1.7.0 并入「设置」页 tab；标题栏由外层 Settings 页提供） -->
  <div>
    <div class="muted" style="font-size:12.5px; margin-bottom:8px">用户管理 <span class="badge blue" style="font-size:11px">仅管理员</span></div>
    <div v-if="msg" class="msg" :class="msgType">{{ msg }}</div>

    <div class="card" style="margin-bottom:14px">
      <h3>新建用户</h3>
      <div class="row" style="flex-wrap:wrap; margin-bottom:8px">
        <input v-model="nu.username" placeholder="用户名（登录用）" style="width:150px" />
        <input v-model="nu.password" type="password" placeholder="初始密码（至少 6 位）" style="width:170px" />
        <select v-model="nu.role" style="width:110px">
          <option value="user">成员</option>
          <option value="admin">管理员</option>
        </select>
        <input v-model="nu.display_name" placeholder="中文姓名（选填，推送选择时显示）" style="width:200px" />
        <input v-model="nu.nickname" placeholder="昵称（选填）" style="width:130px" />
      </div>
      <div class="muted" style="margin-bottom:8px">允许访问的页面与页内功能（不勾选 = 全部开放）：</div>
      <PermTable :user="nu" />
      <button class="primary" style="margin-top:12px" @click="addUser">添加用户</button>
    </div>

    <div class="card">
      <h3>用户列表 <span class="badge blue">{{ users.length }} 人</span></h3>
      <div v-for="u in users" :key="u.id" class="list-item" style="align-items:center">
        <span class="avatar">{{ avatarOf(u) }}</span>
        <div class="grow">
          <div class="t">
            {{ u.display_name || u.username }}
            <span v-if="u.display_name && u.display_name !== u.username" class="muted" style="font-size:12px">（{{ u.username }}）</span>
            <span v-if="u.nickname" class="badge" style="font-size:11px">{{ u.nickname }}</span>
            <span class="badge" :class="u.role==='admin' ? 'blue' : ''">{{ u.role === 'admin' ? '管理员' : '成员' }}</span>
            <span v-if="u.is_bot" class="badge amber">系统成员</span>
            <span v-if="u.id === me.id" class="badge amber">当前账号</span>
            <span v-if="u.lock_permanent" class="badge" style="background:#c0392b;color:#fff">🔒 已锁定 · 连续失败 {{ u.fail_count || 0 }} 次</span>
            <span v-else-if="isTempLocked(u)" class="badge amber">⏳ 临时锁定至 {{ fmtLock(u.locked_until) }}</span>
          </div>
          <div class="meta" style="white-space:normal">
            {{ u.is_bot ? '钉钉群消息通道（不可登录，站内消息里显示为「钉钉」成员）' : '授权：' + permText(u) }}
          </div>
        </div>
        <template v-if="!u.is_bot">
          <button class="small" @click="editProfile(u)">资料</button>
          <button class="small" @click="toggleRole(u)">{{ u.role === 'admin' ? '降为成员' : '设为管理员' }}</button>
          <button class="small" @click="editAllowed(u)">授权</button>
          <button v-if="u.lock_permanent || isTempLocked(u)" class="small" style="color:#c0392b" @click="unlockUser(u)">解锁</button>
          <button class="small" :disabled="u.id === me.id" @click="openReset(u)">重置密码</button>
          <button class="danger small" :disabled="u.id === me.id" @click="delUser(u)">删除</button>
        </template>
      </div>
      <div v-if="!users.length" class="empty">暂无其他用户</div>
    </div>

    <!-- 授权弹窗 -->
    <div v-if="editing" class="modal-backdrop" @click.self="editing = null">
      <div class="modal" style="width:min(760px, 94vw)">
        <h3>用户授权 · {{ editing.username }} <span v-if="editing.role === 'admin'" class="badge blue">管理员不受限制</span></h3>
        <PermTable :user="editing" />
        <div class="muted" style="margin:12px 0 0">「用户管理」页仅管理员可用，不在授权列表；页内功能全不勾 = 该用户只能进入页面框架。</div>
        <div class="row" style="margin-top:12px">
          <button class="primary" @click="saveAllowed">保存授权</button>
          <button @click="editing = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 资料编辑弹窗（姓名/昵称） -->
    <div v-if="profEdit" class="modal-backdrop" @click.self="profEdit = null">
      <div class="modal" style="width:min(420px, 94vw)">
        <h3>用户资料 · {{ profEdit.username }}</h3>
        <div class="form-row"><label>用户名（登录用，不可改）</label><input :value="profEdit.username" disabled /></div>
        <div class="form-row"><label>中文姓名</label><input v-model="profEdit.display_name" placeholder="推送选择消息时显示；空则显示用户名" /></div>
        <div class="form-row"><label>昵称</label><input v-model="profEdit.nickname" placeholder="选填" /></div>
        <div class="row" style="margin-top:14px">
          <button class="primary" @click="saveProfile">保存</button>
          <button @click="profEdit = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 重置密码弹窗 -->
    <div v-if="resetting" class="modal-backdrop" @click.self="resetting = null">
      <div class="modal" style="width:min(420px, 94vw)">
        <h3>重置密码 · {{ resetting.username }}</h3>
        <div class="muted" style="margin:8px 0 12px">重置后该用户所有登录立即失效，需用新密码重新登录。</div>
        <input v-model="np1" type="password" placeholder="新密码（至少 6 位）" style="width:100%" @keyup.enter="saveReset" />
        <input v-model="np2" type="password" placeholder="再次输入新密码" style="width:100%; margin-top:8px" @keyup.enter="saveReset" />
        <div class="row" style="margin-top:14px">
          <button class="primary" @click="saveReset">确认重置</button>
          <button @click="resetting = null">取消</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue';
import { api } from '../api';
import { NAV_ITEMS } from '../nav';
import { TAB_DEFS } from '../tabs';
import PermTable from '../components/PermTable.vue';

const users = ref([]);
const me = ref({ id: 0, username: '' });
const nu = ref({ username: '', password: '', role: 'user', display_name: '', nickname: '', allowed_pages: [], allowed_tabs: {} });
const editing = ref(null);
const msg = ref('');
const msgType = ref('ok');

// 页面名与侧边栏同源（nav.js），tab 细分展示在 PermTable 组件里
function pageLabel(k) { return NAV_ITEMS.find((p) => p.page === k)?.label || k; }
function tabLabel(page, k) { return (TAB_DEFS[page] || []).find((t) => t.key === k)?.label || k; }
// 列表授权文案：页名(页内功能1/页内功能2)；空数组 = 该页无可用功能
function permText(u) {
  if (!u.allowed_pages.length) return '全部页面';
  return u.allowed_pages.map((k) => {
    const tabs = u.allowed_tabs?.[k];
    if (Array.isArray(tabs) && TAB_DEFS[k]) {
      return pageLabel(k) + (tabs.length ? `(${tabs.map((t) => tabLabel(k, t)).join('/')})` : '(无页内功能)');
    }
    return pageLabel(k);
  }).join('、');
}
function flash(text, type = 'ok') {
  msg.value = text;
  msgType.value = type;
  // 用户列表在长授权表下方，行内操作时页面多半已滚到中下部——滚回顶部让提示可见
  window.scrollTo({ top: 0, behavior: 'smooth' });
  setTimeout(() => (msg.value = ''), 4000);
}

async function load() {
  users.value = await api.get('/users');
}

onMounted(async () => {
  try {
    const m = await api.get('/auth/me');
    me.value = m.user;
  } catch {}
  await load();
});

// 提交载荷：只带已勾选页面的 tab 细分（未勾选页面的残留勾选不落库）
function permPayload(u) {
  const tabs = {};
  for (const k of Object.keys(u.allowed_tabs || {})) {
    if (u.allowed_pages.includes(k)) tabs[k] = u.allowed_tabs[k];
  }
  return { allowed_pages: u.allowed_pages, allowed_tabs: tabs };
}

// 头像字：中文姓名优先取首字（英文姓名取首字母大写）
function avatarOf(u) {
  const name = (u.display_name || '').trim() || u.username;
  return /[a-zA-Z]/.test(name[0]) ? name[0].toUpperCase() : name[0];
}

async function addUser() {
  if (!nu.value.username || !nu.value.password) { flash('用户名和密码必填', 'err'); return; }
  if (nu.value.password.length < 6) { flash('密码至少 6 位', 'err'); return; }
  try {
    const uname = nu.value.username;
    await api.post('/users', { username: nu.value.username, password: nu.value.password, role: nu.value.role,
      display_name: nu.value.display_name, nickname: nu.value.nickname, ...permPayload(nu.value) });
    nu.value = { username: '', password: '', role: 'user', display_name: '', nickname: '', allowed_pages: [], allowed_tabs: {} };
    await load();
    flash(`用户「${uname}」已添加`);
  } catch (e) { flash(e.message, 'err'); }
}

async function toggleRole(u) {
  try {
    await api.put(`/users/${u.id}`, { role: u.role === 'admin' ? 'user' : 'admin' });
    await load();
  } catch (e) { flash(e.message, 'err'); }
}

function editAllowed(u) {
  // 深拷贝编辑；tab 数组补齐交给 PermTable（缺键=全部功能，物化为全选）
  const e = JSON.parse(JSON.stringify(u));
  e.allowed_pages = Array.isArray(e.allowed_pages) ? e.allowed_pages : [];
  e.allowed_tabs = e.allowed_tabs && typeof e.allowed_tabs === 'object' ? e.allowed_tabs : {};
  editing.value = e;
}

async function saveAllowed() {
  await api.put(`/users/${editing.value.id}`, permPayload(editing.value));
  editing.value = null;
  await load();
  flash('授权已保存');
}

async function delUser(u) {
  if (!confirm(`删除用户 ${u.username}？该操作不可恢复。`)) return;
  try {
    await api.del(`/users/${u.id}`);
    await load();
    flash('已删除');
  } catch (e) { flash(e.message, 'err'); }
}

// ---------- 账号解锁（v1.3.3 防爆破锁配套；登录日志在 设置 → 登录日志 tab，v1.3.4 迁走） ----------
function isTempLocked(u) { return !u.lock_permanent && !!u.locked_until && new Date(u.locked_until) > new Date(); }
function fmtLock(s) {
  const d = new Date(s);
  if (isNaN(d)) return s;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function unlockUser(u) {
  if (!confirm(`解锁用户「${u.username}」？将清空失败计数与锁定状态，其可立即重新登录。`)) return;
  try {
    await api.put(`/users/${u.id}/unlock`);
    await load();
    flash(`已解锁「${u.username}」`);
  } catch (e) { flash(e.message, 'err'); }
}

// ---------- 资料编辑（中文姓名/昵称；推送选择器显示中文姓名） ----------
const profEdit = ref(null);
function editProfile(u) { profEdit.value = { id: u.id, username: u.username, display_name: u.display_name || '', nickname: u.nickname || '' }; }
async function saveProfile() {
  try {
    await api.put(`/users/${profEdit.value.id}`, { display_name: profEdit.value.display_name, nickname: profEdit.value.nickname });
    profEdit.value = null;
    await load();
    flash('用户资料已保存');
  } catch (e) { flash(e.message, 'err'); }
}

// 管理员重置用户密码（自己的密码走 设置 → 修改密码，需原密码）
const resetting = ref(null);
const np1 = ref('');
const np2 = ref('');
function openReset(u) {
  resetting.value = u;
  np1.value = '';
  np2.value = '';
}
async function saveReset() {
  if (np1.value.length < 6) { flash('密码至少 6 位', 'err'); return; }
  if (np1.value !== np2.value) { flash('两次输入的密码不一致', 'err'); return; }
  try {
    const uname = resetting.value.username;
    await api.put(`/users/${resetting.value.id}/password`, { password: np1.value });
    resetting.value = null;
    flash(`已重置「${uname}」的密码，其所有登录已失效`);
  } catch (e) { flash(e.message, 'err'); }
}
</script>
