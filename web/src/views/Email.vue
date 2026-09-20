<template>
  <div>
    <h2 class="page-title">邮箱 <span class="muted" style="font-size:12px; font-weight:400">收件 · 发件 · 通讯录</span></h2>
    <div v-if="msg" class="msg" :class="msgType">{{ msg }}</div>

    <div class="tabs">
      <template v-if="canTab('email','mail')">
        <button :class="{active: folder==='inbox'}" @click="goFolder('inbox')">收件箱 <span v-if="counts.inbox" class="badge blue">{{ counts.inbox }}</span></button>
        <button :class="{active: folder==='sent'}" @click="goFolder('sent')">发件箱</button>
        <button :class="{active: folder==='draft'}" @click="goFolder('draft')">草稿箱</button>
        <button :class="{active: folder==='trash'}" @click="goFolder('trash')">垃圾箱 <span v-if="counts.trash" class="badge">{{ counts.trash }}</span></button>
      </template>
      <button v-if="canTab('email','contacts')" :class="{active: tab==='contacts'}" @click="openContacts">通讯录</button>
      <button v-if="tab!=='contacts' && canTab('email','mail')" class="primary" style="margin-left:auto" @click="openCompose()">✉ 写邮件</button>
    </div>

    <!-- ============ 文件夹列表 ============ -->
    <template v-if="tab==='folder'">
      <div class="row" style="margin-bottom:12px; flex-wrap:wrap">
        <button v-if="folder==='inbox'" class="primary" @click="fetchMail" :disabled="loading">{{ loading ? '连接中...' : '拉取新邮件' }}</button>
        <button v-if="folder==='inbox'" class="small" @click="refetchAtts" :disabled="loading">补拉附件</button>
        <input v-model="searchQ" :placeholder="folder==='sent' ? '搜索发件箱（主题/收件人/正文）...' : '搜索（主题/发件人/正文）...'" class="grow" style="max-width:340px" @keyup.enter="loadList" />
        <button class="small" @click="loadList">搜索</button>
        <button v-if="folder==='trash'" class="small danger" @click="purgeAll">清空垃圾箱</button>
      </div>
      <div class="card">
        <div v-if="!mails.length && !loading" class="empty">{{ folderName }} 为空</div>
        <div v-for="m in mails" :key="m.id">
          <div class="list-item" :style="{opacity: m.seen ? 0.62 : 1, cursor: 'pointer'}" @click="toggle(m)">
            <span class="avatar">{{ avatarChar(m) }}</span>
            <div class="grow">
              <div class="t" :class="{strike: m.seen}">{{ m.subject || '(无主题)' }} <span v-if="attsOf(m).length" class="att-tag" :title="attsOf(m).map(a => a.filename).join('、')">📎 附件 {{ attsOf(m).length }}</span></div>
              <div class="d">
                <template v-if="folder==='sent'">收：{{ m.to_addr || '?' }}</template>
                <template v-else-if="folder==='draft'">收：{{ m.to_addr || '（未填）' }}</template>
                <template v-else>{{ m.from_addr || '?' }}</template>
                <span v-if="m.date"> · {{ fmt(m.date) }}</span>
              </div>
            </div>
            <span v-if="folder==='inbox' && !m.seen" class="badge blue" @click.stop="markSeen(m)" style="cursor:pointer">标记已读</span>
            <span v-else-if="folder==='inbox'" class="badge">已读</span>
            <span v-if="folder==='draft'" class="badge small" @click.stop="openCompose(m)" style="cursor:pointer">继续编辑</span>
            <span v-if="folder==='inbox'" class="badge red" @click.stop="move(m, 'trash')" style="cursor:pointer">删除</span>
            <span v-if="folder==='trash'" class="badge" @click.stop="move(m, 'inbox')" style="cursor:pointer">恢复</span>
            <span v-if="folder==='trash'" class="badge red" @click.stop="move(m, 'delete')" style="cursor:pointer">彻底删除</span>
            <span class="muted">{{ openId === m.id ? '▲' : '▼' }}</span>
          </div>
          <div v-if="openId === m.id" class="email-body">
            <!-- 附件置顶：发票/账单类邮件附件比正文重要，展开即见 -->
            <div v-if="attsOf(m).length" style="margin:-4px 0 10px; padding-bottom:8px; border-bottom:1px dashed var(--border)">
              <div class="muted" style="font-size:12px; margin-bottom:4px">📎 附件（{{ attsOf(m).length }} 个{{ attachDir ? '' : '，未配置存储目录，仅登记' }}）</div>
              <div v-for="(a, i) in attsOf(m)" :key="i" style="font-size:12.5px; margin-bottom:2px">
                <a v-if="a.stored" class="link" style="cursor:pointer" @click.prevent="dlAtt(m, i)">{{ a.filename }}</a>
                <span v-else class="muted">{{ a.filename }}（未落盘）</span>
                <span class="muted"> · {{ fmtSize(a.size) }}</span>
              </div>
            </div>
            {{ fmtBody(m.body) || '（无正文）' }}
          </div>
        </div>
      </div>
      <!-- 分页 -->
      <div class="row" style="justify-content:space-between; margin-top:12px; flex-wrap:wrap; gap:10px">
        <div class="row" style="gap:8px; align-items:center">
          <span class="muted" style="font-size:13px">每页</span>
          <select v-model.number="pageSize" @change="onPageSizeChange" class="page-select">
            <option v-for="n in [20,30,50,100]" :key="n" :value="n">{{ n }}</option>
          </select>
          <span class="muted" style="font-size:13px">行</span>
        </div>
        <div class="row" style="gap:8px; align-items:center">
          <button class="small" :disabled="page <= 1" @click="goPage(page - 1)">‹ 上一页</button>
          <span class="muted" style="font-size:13px">第 {{ page }} / {{ totalPages }} 页（共 {{ total }} 条）</span>
          <button class="small" :disabled="page >= totalPages" @click="goPage(page + 1)">下一页 ›</button>
        </div>
      </div>
      <div v-if="folder==='trash'" class="muted" style="margin-top:8px; font-size:12px">垃圾箱邮件保留天数可在「设置 → 邮箱」中配置，到期自动清理。</div>
    </template>

    <!-- ============ 通讯录 ============ -->
    <template v-else-if="tab==='contacts'">
      <div class="card" style="margin-bottom:12px">
        <h3>添加联系人</h3>
        <div class="row" style="flex-wrap:wrap">
          <input v-model="ct.name" placeholder="姓名" style="width:140px" />
          <input v-model="ct.email" placeholder="邮箱地址" class="grow" style="min-width:180px" />
          <input v-model="ct.remark" placeholder="备注（可选）" style="width:160px" />
          <button class="primary" @click="addContact">添加</button>
        </div>
      </div>
      <div class="card">
        <div class="row" style="margin-bottom:10px">
          <input v-model="ctSearch" placeholder="搜索联系人..." class="grow" style="max-width:320px" @keyup.enter="loadContacts" />
          <button class="small" @click="loadContacts">搜索</button>
        </div>
        <div v-if="!contacts.length" class="empty">暂无联系人</div>
        <div v-for="c in contacts" :key="c.id" class="list-item">
          <span class="avatar">{{ (c.name || c.email || '?')[0].toUpperCase() }}</span>
          <div class="grow">
            <div class="t">{{ c.name || '（未命名）' }}</div>
            <div class="d">{{ c.email }}<span v-if="c.remark"> · {{ c.remark }}</span></div>
          </div>
          <button class="small" @click="mailTo(c)">✉ 写信</button>
          <button class="icon-btn" @click="delContact(c)">✕</button>
        </div>
      </div>
    </template>

    <!-- ============ 写信弹窗 ============ -->
    <div v-if="compose.show" class="modal-backdrop" @click.self="compose.show = false">
      <div class="modal" style="width:min(640px, 94vw)">
        <h3>{{ compose.draftId ? '编辑草稿' : '写邮件' }}</h3>
        <div class="form-row">
          <label>收件人（多个用逗号分隔）</label>
          <div class="row">
            <input v-model="compose.to" placeholder="a@x.com, b@y.com" />
            <button class="small" style="flex-shrink:0" @click="pickContact('to')">通讯录</button>
          </div>
        </div>
        <div class="form-row">
          <label>抄送（可选）</label>
          <div class="row">
            <input v-model="compose.cc" placeholder="抄送地址" />
            <button class="small" style="flex-shrink:0" @click="pickContact('cc')">通讯录</button>
          </div>
        </div>
        <div class="form-row"><label>主题</label><input v-model="compose.subject" placeholder="邮件主题" /></div>
        <div class="form-row">
          <label>正文（发送时自动附加设置里配置的签名）</label>
          <textarea v-model="compose.text" rows="9" placeholder="正文内容..."></textarea>
        </div>
        <div class="row" style="justify-content:space-between; flex-wrap:wrap; gap:8px">
          <span v-if="signature" class="muted" style="font-size:12px">当前签名：{{ signature.slice(0, 40) }}{{ signature.length > 40 ? '…' : '' }}</span>
          <span v-else class="muted" style="font-size:12px">未配置签名（设置 → 邮箱）</span>
        </div>
        <div class="row" style="justify-content:flex-end; gap:8px; margin-top:12px">
          <button class="small" @click="compose.show = false">取消</button>
          <button class="small" @click="saveDraft" :disabled="sending">存草稿</button>
          <button class="primary" @click="send" :disabled="sending">{{ sending ? '发送中...' : '发送' }}</button>
        </div>
      </div>
    </div>

    <!-- 联系人选择弹窗 -->
    <div v-if="picker.show" class="modal-backdrop" @click.self="picker.show = false">
      <div class="modal" style="width:min(440px, 92vw)">
        <h3>选择联系人（加到{{ picker.field === 'to' ? '收件人' : '抄送' }}）</h3>
        <div v-if="!contacts.length" class="empty">通讯录为空，先到「通讯录」页签添加</div>
        <div v-for="c in contacts" :key="c.id" class="list-item" style="cursor:pointer" @click="applyPick(c)">
          <span class="avatar">{{ (c.name || c.email || '?')[0].toUpperCase() }}</span>
          <div class="grow">
            <div class="t">{{ c.name || c.email }}</div>
            <div class="d">{{ c.email }}</div>
          </div>
          <span class="badge blue">选择</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api';
import { canTab } from '../tabs';

const tab = ref('folder');           // folder | contacts
const folder = ref('inbox');         // inbox | sent | draft | trash
const mails = ref([]);
const loading = ref(false);
const sending = ref(false);
const msg = ref('');
const msgType = ref('ok');
const openId = ref(null);
const pageSize = ref(20);
const page = ref(1);
const total = ref(0);
const searchQ = ref('');
const counts = ref({ inbox: 0, trash: 0 });
const signature = ref('');

const contacts = ref([]);
const ct = ref({ name: '', email: '', remark: '' });
const ctSearch = ref('');

const compose = ref({ show: false, draftId: 0, to: '', cc: '', subject: '', text: '' });
const picker = ref({ show: false, field: 'to' });

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
const folderName = computed(() => ({ inbox: '收件箱', sent: '发件箱', draft: '草稿箱', trash: '垃圾箱' })[folder.value]);

function flash(text, type = 'ok') { msg.value = text; msgType.value = type; setTimeout(() => (msg.value = ''), 4000); }
function avatarChar(m) {
  const s = folder.value === 'sent' || folder.value === 'draft' ? (m.to_addr || '?') : (m.from_addr || '?');
  return (s[0] || '?').toUpperCase();
}
function toggle(m) { openId.value = openId.value === m.id ? null : m.id; }

function goFolder(f) { tab.value = 'folder'; folder.value = f; page.value = 1; searchQ.value = ''; loadList(); }
function openContacts() { tab.value = 'contacts'; loadContacts(); }

async function loadList() {
  try {
    const d = await api.get(`/emails/local?folder=${folder.value}&page=${page.value}&pageSize=${pageSize.value}` + (searchQ.value ? `&q=${encodeURIComponent(searchQ.value)}` : ''));
    mails.value = d.mails || [];
    total.value = d.total || 0;
    page.value = d.page || 1;
    openId.value = null;
  } catch (e) { flash(e.message, 'err'); }
}
async function loadCounts() {
  try {
    // 未读数与垃圾箱数（轻量：各取一页 total）
    const a = await api.get(`/emails/local?folder=inbox&page=1&pageSize=1`);
    counts.value.inbox = 0; // 收件箱角标暂不区分未读（列表已标），只显示垃圾箱数
    const b = await api.get(`/emails/local?folder=trash&page=1&pageSize=1`);
    counts.value.trash = b.total || 0;
  } catch {}
}

async function fetchMail() {
  loading.value = true;
  try {
    await api.get('/emails');
    flash('拉取成功');
    await loadList();
  } catch (e) {
    flash(e.message, 'err');
    await loadList();
  } finally { loading.value = false; }
}

async function markSeen(m) {
  await api.post(`/emails/${m.uid}/seen`);
  m.seen = 1;
}

async function refetchAtts() {
  loading.value = true;
  try {
    const r = await api.post('/emails/refetch-attachments', {});
    flash(`附件补拉完成：覆盖 ${r.mails} 封，解析到 ${r.attachments} 个附件`);
    await loadList();
  } catch (e) { flash(e.message, 'err'); }
  finally { loading.value = false; }
}

async function move(m, to) {
  const tip = to === 'delete' ? `彻底删除「${m.subject || '该邮件'}」？（不可恢复）` : to === 'trash' ? `把「${m.subject || '该邮件'}」移入垃圾箱？` : null;
  if (tip && !confirm(tip)) return;
  try {
    await api.post(`/emails/${m.id}/move`, { to });
    flash(to === 'delete' ? '已彻底删除' : to === 'trash' ? '已移入垃圾箱' : '已恢复');
    await loadList();
  } catch (e) { flash(e.message, 'err'); }
}

async function purgeAll() {
  if (!confirm(`清空垃圾箱全部 ${total.value} 封邮件？不可恢复！`)) return;
  try {
    const d = await api.get('/emails/local?folder=trash&page=1&pageSize=1000');
    for (const m of d.mails || []) await api.post(`/emails/${m.id}/move`, { to: 'delete' });
    flash('垃圾箱已清空');
    await loadList();
  } catch (e) { flash(e.message, 'err'); }
}

// ---------- 写信 ----------
function openCompose(draft) {
  if (draft) {
    compose.value = { show: true, draftId: draft.id, to: draft.to_addr || '', cc: '', subject: draft.subject || '', text: draft.body || '' };
  } else {
    compose.value = { show: true, draftId: 0, to: '', cc: '', subject: '', text: '' };
  }
}
function mailTo(c) {
  tab.value = 'folder';
  openCompose();
  compose.value.to = c.email;
}
function pickContact(field) { picker.value = { show: true, field }; loadContacts(); }
function applyPick(c) {
  const cur = (compose.value[picker.value.field] || '').trim();
  compose.value[picker.value.field] = cur ? cur + ', ' + c.email : c.email;
  picker.value.show = false;
}
async function send() {
  const c = compose.value;
  if (!c.to.trim()) { flash('请填写收件人', 'err'); return; }
  sending.value = true;
  try {
    await api.post('/emails/send', { to: c.to, cc: c.cc, subject: c.subject, text: c.text, draftId: c.draftId || undefined });
    flash('发送成功 ✓');
    compose.value.show = false;
    folder.value = 'sent';
    await loadList();
  } catch (e) {
    flash('发送失败：' + e.message, 'err');
  } finally { sending.value = false; }
}
async function saveDraft() {
  const c = compose.value;
  try {
    await api.post('/emails/draft', { id: c.draftId || undefined, to: c.to, cc: c.cc, subject: c.subject, text: c.text });
    flash('草稿已保存');
    compose.value.show = false;
  } catch (e) { flash('保存草稿失败：' + e.message, 'err'); }
}

// ---------- 通讯录 ----------
async function loadContacts() {
  try {
    const d = await api.get('/contacts' + (ctSearch.value ? `?q=${encodeURIComponent(ctSearch.value)}` : ''));
    contacts.value = d || [];
  } catch { contacts.value = []; }
}
async function addContact() {
  if (!ct.value.email.trim()) { flash('邮箱地址不能为空', 'err'); return; }
  try {
    await api.post('/contacts', ct.value);
    ct.value = { name: '', email: '', remark: '' };
    flash('联系人已添加');
    await loadContacts();
  } catch (e) { flash(e.message, 'err'); }
}
async function delContact(c) {
  if (!confirm(`删除联系人「${c.name || c.email}」？`)) return;
  await api.del(`/contacts/${c.id}`);
  await loadContacts();
}

function onPageSizeChange() { page.value = 1; loadList(); }
// 附件：emails.attachments 是 JSON 字符串
function attsOf(m) {
  if (!m.attachments) return [];
  try { return JSON.parse(m.attachments) || []; } catch { return []; }
}
// 附件下载：带令牌取流（裸 <a> 直链会因无 Authorization 头被 401 拦截）
async function dlAtt(m, i) {
  const att = attsOf(m)[i];
  try {
    await api.download(`/emails/${m.id}/attachments/${i}`, att && att.filename);
  } catch (e) {
    flash('附件下载失败：' + e.message, 'err');
  }
}
const attachDir = ref('');
// 正文排版：邮件原文段落间常有多个空行（\r\n\r\n\r\n 或 HTML 转文本残留）——
// 展示时归一为每段之间恰好一个换行，不留空行（只影响显示，不改库里的原文）
const fmtBody = (t) => String(t || '').replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n');
function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return n + 'B';
  if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1048576).toFixed(1) + 'MB';
}
function goPage(n) { if (n >= 1 && n <= totalPages.value) { page.value = n; loadList(); } }
function fmt(t) { return t ? String(t).replace('T', ' ').slice(5, 16) : ''; }

onMounted(async () => {
  // tab 级授权：无「收发邮件」权限但有「通讯录」时直接落在通讯录
  if (!canTab('email', 'mail') && canTab('email', 'contacts')) {
    tab.value = 'contacts';
    loadContacts();
    return;
  }
  if (canTab('email', 'mail')) {
    loadList();
    loadCounts();
    try {
      const s = await api.get('/emails/signature');
      signature.value = s.signature || '';
    } catch {}
    try {
      const a = await api.get('/emails/attach-config');
      attachDir.value = a.dir || '';
    } catch {}
  }
});
</script>

<style scoped>
.page-select { padding: 4px 8px; border: 1px solid var(--border); background: var(--bg2); color: var(--text); border-radius: 6px; font-size: 13px; }
/* 列表标题行的「📎 附件 N」标签 */
.att-tag { display: inline-block; vertical-align: middle; margin-left: 6px; padding: 0 6px; border-radius: 6px;
  font-size: 11px; font-weight: 400; line-height: 18px;
  background: rgba(79, 124, 247, .12); color: var(--accent, #4f7cf7); border: 1px solid rgba(79, 124, 247, .25); }
</style>
