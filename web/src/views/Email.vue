<template>
  <div>
    <h2 class="page-title">邮箱 <span class="muted" style="font-size:12px; font-weight:400">多邮箱 · 收发 · 通讯录</span></h2>
    <div v-if="msg" class="msg" :class="msgType">{{ msg }}</div>

    <!-- ============ 一级 tab：各邮箱账号 + 通讯录 + 邮箱设置（v1.7.0 多邮箱） ============ -->
    <div class="tabs">
      <template v-if="canTab('email','mail')">
        <button v-for="a in accounts" :key="a.id" :class="{active: tab==='mail' && acc===a.id}" @click="openAccount(a.id)">
          {{ a.label }} <span v-if="a.id===acc && counts.inbox" class="badge blue">{{ counts.inbox }}</span>
        </button>
        <button v-if="canTab('email','esettings')" title="添加邮箱" @click="addAccount">＋</button>
      </template>
      <button v-if="canTab('email','contacts')" :class="{active: tab==='contacts'}" @click="openContacts">通讯录</button>
      <button v-if="canTab('email','esettings')" :class="{active: tab==='esettings'}" @click="openSettings">邮箱设置</button>
      <button v-if="tab!=='contacts' && tab!=='esettings' && canTab('email','mail')" class="primary" style="margin-left:auto" @click="openCompose()">✉ 写邮件</button>
    </div>

    <!-- ============ 邮箱账号视图：文件夹 + 列表 ============ -->
    <template v-if="tab==='mail'">
      <!-- 文件夹行：全部操作按钮统一在本行尾部（v1.7.0 任务4） -->
      <div class="folder-bar">
        <button :class="{on: folder==='inbox'}" @click="goFolder('inbox')">收件箱<span v-if="counts.inbox" class="fb-n">{{ counts.inbox }}</span></button>
        <button :class="{on: folder==='sent'}" @click="goFolder('sent')">发件箱</button>
        <button :class="{on: folder==='draft'}" @click="goFolder('draft')">草稿箱</button>
        <button :class="{on: folder==='trash'}" @click="goFolder('trash')">垃圾箱</button>
        <span class="grow"></span>
        <button v-if="folder==='inbox'" class="act" :disabled="loading" @click="fetchMail">{{ loading ? '拉取中...' : '拉取新邮件' }}</button>
        <button v-if="folder==='inbox'" class="act" :disabled="loading" @click="refetchAtts">补拉附件</button>
        <button v-if="folder==='trash'" class="act danger" @click="purgeAll">清空垃圾箱</button>
        <input v-model="searchQ" :placeholder="folder==='sent' || folder==='draft' ? '搜索（主题/收件人/正文）...' : '搜索（主题/发件人/正文）...'" class="fb-search" @keyup.enter="doSearch" />
        <button class="act" @click="doSearch">搜索</button>
        <template v-if="folder!=='draft'">
          <label class="fb-all"><input type="checkbox" :checked="allChecked" @change="toggleAll" /> 全选</label>
          <button v-if="folder==='inbox'" class="act" :disabled="!selected.size" @click="batchSeen">已读{{ selected.size ? `(${selected.size})` : '' }}</button>
          <button class="act danger" :disabled="!selected.size" @click="batchDelete">{{ folder==='trash' ? '彻底删除' : '删除' }}{{ selected.size ? `(${selected.size})` : '' }}</button>
        </template>
      </div>

      <div class="card">
        <div v-if="!accounts.length" class="empty">还没有邮箱账号：点右上角「邮箱设置」添加第一个邮箱</div>
        <div v-else-if="!mails.length && !loading" class="empty">{{ folderName }} 为空{{ searchQ ? '（当前搜索无结果）' : '' }}</div>
        <div v-for="m in mails" :key="m.id">
          <div class="list-item mail-row" :style="{opacity: m.seen ? 0.62 : 1, cursor: 'pointer'}" @click="toggle(m)">
            <input type="checkbox" style="width:auto; flex-shrink:0" :checked="selected.has(m.id)" @click.stop="toggleSel(m)" />
            <!-- 第一列：发件人姓名（GitHub<noreply@github.com> → GitHub；发件/草稿显示收件人） -->
            <div class="mail-from" :title="folder==='sent' || folder==='draft' ? m.to_addr : m.from_addr">{{ colName(m) }}</div>
            <!-- 第二列：主题 + 标签 + 附件 -->
            <div class="grow" style="min-width:0">
              <div class="t" :class="{strike: m.seen}">
                <span v-if="m.tag" class="tag-orange" :title="'命中关键词标签'">{{ m.tag }}</span>
                {{ m.subject || '(无主题)' }}
                <span v-if="attsOf(m).length" class="att-tag" :title="attsOf(m).map(a => a.filename).join('、')">附件 {{ attsOf(m).length }}</span>
              </div>
              <div class="d">
                <template v-if="folder==='sent' || folder==='draft'">收：{{ m.to_addr || '（未填）' }}</template>
                <template v-else>{{ m.from_addr || '?' }}</template>
                <span v-if="m.date"> · {{ fmt(m.date) }}</span>
              </div>
            </div>
            <span v-if="folder==='inbox' && !m.seen" class="badge blue" @click.stop="markSeen(m)" style="cursor:pointer">已读</span>
            <span v-if="folder==='draft'" class="badge small" @click.stop="openCompose(m)" style="cursor:pointer">继续编辑</span>
            <span v-if="folder==='inbox'" class="badge red" @click.stop="move(m, 'trash')" style="cursor:pointer">删除</span>
            <span v-if="folder==='trash'" class="badge" @click.stop="move(m, 'inbox')" style="cursor:pointer">恢复</span>
            <span v-if="folder==='trash'" class="badge red" @click.stop="move(m, 'delete')" style="cursor:pointer">彻底删除</span>
            <span class="muted">{{ openId === m.id ? '▲' : '▼' }}</span>
          </div>
          <div v-if="openId === m.id" class="email-body">
            <!-- 附件置顶：发票/账单类邮件附件比正文重要，展开即见 -->
            <div v-if="attsOf(m).length" style="margin:-4px 0 10px; padding-bottom:8px; border-bottom:1px dashed var(--border)">
              <div class="muted" style="font-size:12px; margin-bottom:4px">附件（{{ attsOf(m).length }} 个{{ attachDir ? '' : '，未配置存储目录，仅登记' }}）</div>
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
      <div v-if="folder==='trash'" class="muted" style="margin-top:8px; font-size:12px">垃圾箱保留天数在「邮箱设置」里按账号配置，到期自动清理。</div>
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

    <!-- ============ 邮箱设置（最后一个 tab，v1.7.0）：账号管理 / 提醒 / 标签 / 附件 ============ -->
    <template v-else-if="tab==='esettings'">
      <div class="masonry">
        <div class="card">
          <h3>邮箱账号（{{ accounts.length }} 个）</h3>
          <div class="muted" style="font-size:12.5px; margin-bottom:10px">每个账号是邮箱页顶部的一个独立 tab；「标签」即 tab 显示名。删除账号会连同其已拉取的邮件一起删除。</div>
          <div v-if="!accounts.length" class="empty" style="padding:16px 0">还没有邮箱账号</div>
          <div v-for="a in accounts" :key="a.id" class="row" style="align-items:center; gap:8px; padding:8px 0; border-bottom:1px dashed var(--border); flex-wrap:wrap">
            <b style="min-width:72px">{{ a.label }}</b>
            <span class="muted" style="font-size:12.5px; flex:1; min-width:160px">{{ a.imap_user || '（未配 IMAP）' }}{{ a.imap_host ? ' · ' + a.imap_host : '' }}</span>
            <span v-if="!a.enabled" class="badge">已停用</span>
            <button class="small" style="padding:2px 8px" @click="editAccount(a)">编辑</button>
            <button class="small" style="padding:2px 8px" :disabled="smtpTesting" @click="testSmtp(a)">发测试邮件</button>
            <button class="small danger" style="padding:2px 8px" @click="removeAccount(a)">删除</button>
          </div>
          <div class="row" style="margin-top:12px">
            <button class="primary" @click="addAccount">＋ 添加邮箱账号</button>
          </div>
        </div>

        <div class="card">
          <h3>新邮件提醒</h3>
          <label class="row" style="align-items:center; gap:8px; cursor:pointer; margin-bottom:6px">
            <input v-model="notify.popup" type="checkbox" style="width:auto" @change="saveNotify" />
            <span style="font-size:13.5px">弹出提示（通过右下角消息窗口弹出，点击直达本邮箱）</span>
          </label>
          <label class="row" style="align-items:center; gap:8px; cursor:pointer">
            <input v-model="notify.sound" type="checkbox" style="width:auto" @change="saveNotify" />
            <span style="font-size:13.5px">邮件提示音（弹出新邮件提醒时播放）</span>
          </label>
        </div>

        <div class="card">
          <h3>关键词标签</h3>
          <div class="muted" style="font-size:12.5px; margin-bottom:10px">拉取/搜索时对邮件主题 + 正文做全文检索，命中第一个关键词的邮件，标题最前面显示橙底白字标签（每封只显示一个）。例如关键词「发票」→ 标题前出现「发票」标签。</div>
          <div v-for="(r, i) in tagRules" :key="i" class="row" style="gap:8px; margin-bottom:6px; flex-wrap:wrap">
            <input v-model="r.keyword" placeholder="关键词，如：发票" style="width:200px" />
            <span class="muted">→</span>
            <span class="tag-orange" style="align-self:center">{{ r.label || '标签' }}</span>
            <input v-model="r.label" placeholder="标签文字" style="width:140px" />
            <button class="icon-btn" @click="tagRules.splice(i, 1)">✕</button>
          </div>
          <div class="row" style="gap:8px; margin-top:10px; flex-wrap:wrap">
            <button class="small" @click="tagRules.push({ keyword: '', label: '' })">＋ 加一条</button>
            <button class="primary" @click="saveTags">保存标签规则</button>
          </div>
        </div>

        <div class="card">
          <h3>邮件附件存储</h3>
          <div class="muted" style="font-size:12px; margin:4px 0 8px">拉取邮件时附件保存到此目录（建议 NAS 映射盘符，如 Z:\mail-attachments 或 \\NAS\mail）。留空则附件仅登记不落盘。全部邮箱账号共用。</div>
          <div class="row">
            <input v-model="attachCfg.dir" placeholder="Z:\mail-attachments" class="grow" />
            <button class="primary" @click="saveAttachDir">保存路径</button>
          </div>
        </div>
      </div>
    </template>

    <!-- ============ 账号编辑弹窗 ============ -->
    <div v-if="accModal.show" class="modal-backdrop" @click.self="accModal.show = false">
      <div class="modal" style="width:min(620px, 94vw); max-height:88vh; overflow-y:auto">
        <h3>{{ accModal.id ? '编辑邮箱账号' : '添加邮箱账号' }}</h3>
        <div class="form-row"><label>标签（邮箱页 tab 显示名）</label><input v-model="accModal.label" placeholder="如：工作邮箱" /></div>
        <div class="form-row"><label>IMAP 服务器</label><input v-model="accModal.imap_host" placeholder="imap.example.com" /></div>
        <div class="row">
          <div class="form-row" style="flex:1"><label>端口</label><input v-model.number="accModal.imap_port" type="number" /></div>
          <div class="form-row row" style="flex-shrink:0; align-self:flex-end; padding-bottom:8px">
            <label style="margin:0">使用 TLS</label>
            <input v-model="accModal.use_tls" type="checkbox" style="width:auto" />
          </div>
        </div>
        <div class="form-row"><label>账号</label><input v-model="accModal.imap_user" placeholder="you@example.com" /></div>
        <div class="form-row"><label>密码 / 授权码{{ accModal.has_imap_pass ? '（留空保持不变）' : '' }}</label><input v-model="accModal.imap_pass" type="password" placeholder="建议使用邮箱提供的授权码" /></div>
        <div class="form-row"><label>自动拉取间隔（分钟，≥5）</label><input v-model.number="accModal.refresh_minutes" type="number" min="5" max="1440" /></div>
        <div class="form-row"><label>SMTP 服务器（发件，可选）</label><input v-model="accModal.smtp_host" placeholder="smtp.example.com" /></div>
        <div class="row">
          <div class="form-row" style="flex:1"><label>SMTP 端口（465=TLS / 587=STARTTLS）</label><input v-model.number="accModal.smtp_port" type="number" /></div>
          <div class="form-row row" style="flex-shrink:0; align-self:flex-end; padding-bottom:8px">
            <label style="margin:0">SSL/TLS</label>
            <input v-model="accModal.smtp_tls" type="checkbox" style="width:auto" />
          </div>
        </div>
        <div class="form-row"><label>发件账号</label><input v-model="accModal.smtp_user" placeholder="you@example.com" /></div>
        <div class="form-row"><label>SMTP 密码 / 授权码{{ accModal.has_smtp_pass ? '（留空保持不变）' : '' }}</label><input v-model="accModal.smtp_pass" type="password" placeholder="通常与 IMAP 相同" /></div>
        <div class="form-row"><label>发件人显示名（可选）</label><input v-model="accModal.smtp_from_name" placeholder="如：张三" /></div>
        <div class="form-row">
          <label>邮件末尾签名（发送时自动附加）</label>
          <textarea v-model="accModal.signature" rows="3" placeholder="如：&#10;张三&#10;电话：138xxxx"></textarea>
        </div>
        <div class="form-row"><label>垃圾箱保留天数</label><input v-model.number="accModal.trash_keep_days" type="number" min="1" max="365" /></div>
        <div class="row" style="justify-content:flex-end; gap:8px; margin-top:12px">
          <button class="small" @click="accModal.show = false">取消</button>
          <button class="primary" @click="saveAccount">保存</button>
        </div>
      </div>
    </div>

    <!-- ============ 写信弹窗 ============ -->
    <div v-if="compose.show" class="modal-backdrop" @click.self="compose.show = false">
      <div class="modal" style="width:min(640px, 94vw)">
        <h3>{{ compose.draftId ? '编辑草稿' : '写邮件' }}</h3>
        <div class="form-row" v-if="smtpAccounts.length > 1">
          <label>发件账号</label>
          <select v-model="compose.accountId">
            <option v-for="a in smtpAccounts" :key="a.id" :value="a.id">{{ a.label }}（{{ a.smtp_user }}）</option>
          </select>
        </div>
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
          <label>正文（发送时自动附加该账号配置的签名）</label>
          <textarea v-model="compose.text" rows="9" placeholder="正文内容..."></textarea>
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
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import { canTab } from '../tabs';

const route = useRoute();
const router = useRouter();

const tab = ref('mail');            // mail | contacts | esettings
const folder = ref('inbox');        // inbox | sent | draft | trash
const accounts = ref([]);           // 多邮箱账号（label 即 tab 名）
const acc = ref(0);                 // 当前账号 id
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
const selected = ref(new Set());    // 批量多选（行 id）
const counts = ref({ inbox: 0, trash: 0 });

const contacts = ref([]);
const ct = ref({ name: '', email: '', remark: '' });
const ctSearch = ref('');

const compose = ref({ show: false, draftId: 0, accountId: 0, to: '', cc: '', subject: '', text: '' });
const picker = ref({ show: false, field: 'to' });
const accModal = ref({ show: false, id: 0, label: '', imap_host: '', imap_port: 993, imap_user: '', imap_pass: '', use_tls: true, smtp_host: '', smtp_port: 465, smtp_user: '', smtp_pass: '', smtp_tls: true, smtp_from_name: '', signature: '', refresh_minutes: 20, trash_keep_days: 30, has_imap_pass: false, has_smtp_pass: false });
const notify = ref({ popup: true, sound: false });
const tagRules = ref([]);
const attachCfg = ref({ dir: '' });
const attachDir = ref('');
const smtpTesting = ref(false);

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
const folderName = computed(() => ({ inbox: '收件箱', sent: '发件箱', draft: '草稿箱', trash: '垃圾箱' })[folder.value]);
const allChecked = computed(() => mails.value.length > 0 && mails.value.every((m) => selected.value.has(m.id)));
const smtpAccounts = computed(() => accounts.value.filter((a) => a.smtp_host && a.smtp_user));

function flash(text, type = 'ok') { msg.value = text; msgType.value = type; setTimeout(() => (msg.value = ''), 4000); }

// ---------- 账号 tab / URL 同步 ----------
function openAccount(id) {
  acc.value = id;
  tab.value = 'mail';
  router.replace({ query: { ...route.query, acc: id || undefined } });
  folder.value = 'inbox';
  page.value = 1; searchQ.value = '';
  selected.value = new Set();
  loadList();
  loadCounts();
}
function openContacts() { tab.value = 'contacts'; router.replace({ query: { ...route.query } }); loadContacts(); }
function openSettings() {
  tab.value = 'esettings';
  loadNotifyCfg();
  loadTags();
  loadAttachCfg();
}

async function loadAccounts() {
  try {
    const d = await api.get('/emails/accounts');
    accounts.value = d.accounts || [];
    if (accounts.value.length && !accounts.value.some((a) => a.id === acc.value)) {
      acc.value = accounts.value[0].id;
    }
  } catch { accounts.value = []; }
}

// ---------- 列表 ----------
function goFolder(f) { folder.value = f; page.value = 1; searchQ.value = ''; selected.value = new Set(); loadList(); }
function doSearch() { page.value = 1; selected.value = new Set(); loadList(); }

async function loadList() {
  if (!acc.value) { mails.value = []; total.value = 0; return; }
  try {
    const d = await api.get(`/emails/local?folder=${folder.value}&account=${acc.value}&page=${page.value}&pageSize=${pageSize.value}` + (searchQ.value ? `&q=${encodeURIComponent(searchQ.value)}` : ''));
    mails.value = d.mails || [];
    total.value = d.total || 0;
    page.value = d.page || 1;
    openId.value = null;
    if (mails.value.length) selected.value = new Set([...selected.value].filter((id) => mails.value.some((m) => m.id === id)));
  } catch (e) { flash(e.message, 'err'); }
}
async function loadCounts() {
  if (!acc.value) return;
  try {
    // 收件箱未读数 + 垃圾箱总数（轻量：各取一页 total）
    const a = await api.get(`/emails/local?folder=inbox&account=${acc.value}&page=1&pageSize=1&q=`);
    const b = await api.get(`/emails/local?folder=trash&account=${acc.value}&page=1&pageSize=1`);
    counts.value = { inbox: a.unread || 0, trash: b.total || 0 };
  } catch {}
}

async function fetchMail() {
  loading.value = true;
  try {
    await api.get(`/emails?account=${acc.value}`);
    flash('拉取成功');
    await loadList();
    await loadCounts();
  } catch (e) {
    flash(e.message, 'err');
    await loadList();
  } finally { loading.value = false; }
}

async function markSeen(m) {
  try {
    await api.post(`/emails/${m.uid}/seen?account=${acc.value}`);
    m.seen = 1;
    loadCounts();
  } catch (e) { flash(e.message, 'err'); }
}
// 行展开/收起（展开未读邮件即视为已读）
function toggle(m) {
  openId.value = openId.value === m.id ? null : m.id;
  if (openId.value && folder.value === 'inbox' && !m.seen) markSeen(m);
}

// ---------- 批量多选（v1.7.0 任务3/5） ----------
function toggleSel(m) {
  const s = new Set(selected.value);
  s.has(m.id) ? s.delete(m.id) : s.add(m.id);
  selected.value = s;
}
function toggleAll() {
  const s = new Set(selected.value);
  if (allChecked.value) mails.value.forEach((m) => s.delete(m.id));
  else mails.value.forEach((m) => s.add(m.id));
  selected.value = s;
}
async function batchSeen() {
  const ids = [...selected.value];
  if (!ids.length) return;
  try {
    await api.post('/emails/batch-seen', { ids });
    flash(`已把 ${ids.length} 封标为已读`);
    selected.value = new Set();
    await loadList();
    await loadCounts();
  } catch (e) { flash(e.message, 'err'); }
}
async function batchDelete() {
  const ids = [...selected.value];
  if (!ids.length) return;
  const to = folder.value === 'trash' ? 'delete' : 'trash';
  const tip = to === 'delete' ? `彻底删除选中的 ${ids.length} 封邮件？（不可恢复）` : `把选中的 ${ids.length} 封邮件移入垃圾箱？`;
  if (!confirm(tip)) return;
  try {
    await api.post('/emails/batch-move', { ids, to });
    flash(to === 'delete' ? '已彻底删除' : '已移入垃圾箱');
    selected.value = new Set();
    await loadList();
    await loadCounts();
  } catch (e) { flash(e.message, 'err'); }
}

async function refetchAtts() {
  loading.value = true;
  try {
    const r = await api.post('/emails/refetch-attachments', { account: acc.value });
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
    await loadCounts();
  } catch (e) { flash(e.message, 'err'); }
}

async function purgeAll() {
  if (!confirm(`清空当前邮箱垃圾箱全部 ${total.value} 封邮件？不可恢复！`)) return;
  try {
    await api.post(`/emails/purge-trash?account=${acc.value}`);
    flash('垃圾箱已清空');
    await loadList();
    await loadCounts();
  } catch (e) { flash(e.message, 'err'); }
}

// ---------- 写信 ----------
function openCompose(draft) {
  if (draft) {
    compose.value = { show: true, draftId: draft.id, accountId: acc.value, to: draft.to_addr || '', cc: '', subject: draft.subject || '', text: draft.body || '' };
  } else {
    compose.value = { show: true, draftId: 0, accountId: acc.value, to: '', cc: '', subject: '', text: '' };
  }
}
function mailTo(c) {
  tab.value = 'mail';
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
    await api.post('/emails/send', { to: c.to, cc: c.cc, subject: c.subject, text: c.text, draftId: c.draftId || undefined, accountId: c.accountId || acc.value || undefined });
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
    await api.post('/emails/draft', { id: c.draftId || undefined, to: c.to, cc: c.cc, subject: c.subject, text: c.text, accountId: c.accountId || acc.value || undefined });
    flash('草稿已保存');
    compose.value.show = false;
  } catch (e) { flash('保存草稿失败：' + e.message, 'err'); }
}

// ---------- 账号管理（邮箱设置 tab） ----------
function editAccount(a) {
  accModal.value = {
    show: true, id: a.id, label: a.label, imap_host: a.imap_host || '', imap_port: a.imap_port || 993,
    imap_user: a.imap_user || '', imap_pass: '', use_tls: a.use_tls !== 0, smtp_host: a.smtp_host || '',
    smtp_port: a.smtp_port || 465, smtp_user: a.smtp_user || '', smtp_pass: '', smtp_tls: a.smtp_tls !== 0,
    smtp_from_name: a.smtp_from_name || '', signature: a.signature || '',
    refresh_minutes: a.refresh_minutes || 20, trash_keep_days: a.trash_keep_days || 30,
    has_imap_pass: !!a.has_imap_pass, has_smtp_pass: !!a.has_smtp_pass,
  };
}
function addAccount() {
  if (!canTab('email', 'esettings')) return;
  accModal.value = { show: true, id: 0, label: '', imap_host: '', imap_port: 993, imap_user: '', imap_pass: '', use_tls: true, smtp_host: '', smtp_port: 465, smtp_user: '', smtp_pass: '', smtp_tls: true, smtp_from_name: '', signature: '', refresh_minutes: 20, trash_keep_days: 30, has_imap_pass: false, has_smtp_pass: false };
  tab.value = 'esettings';
}
async function saveAccount() {
  const m = accModal.value;
  if (!m.imap_user.trim()) { flash('请填写 IMAP 账号', 'err'); return; }
  const body = { ...m };
  delete body.show; delete body.has_imap_pass; delete body.has_smtp_pass;
  try {
    if (m.id) await api.put(`/emails/accounts/${m.id}`, body);
    else {
      const r = await api.post('/emails/accounts', body);
      acc.value = r.id;
    }
    accModal.value.show = false;
    flash(m.id ? '账号已保存' : '邮箱账号已添加');
    await loadAccounts();
    tab.value = 'mail';
    openAccount(acc.value);
  } catch (e) { flash(e.message, 'err'); }
}
async function removeAccount(a) {
  if (!confirm(`删除邮箱账号「${a.label}」？其已拉取的邮件将一并删除（邮箱服务器上的邮件不受影响）。`)) return;
  try {
    await api.del(`/emails/accounts/${a.id}`);
    flash('账号已删除');
    await loadAccounts();
    if (acc.value === a.id && accounts.value.length) openAccount(accounts.value[0].id);
    else if (!accounts.value.length) { mails.value = []; total.value = 0; }
  } catch (e) { flash(e.message, 'err'); }
}
async function testSmtp(a) {
  smtpTesting.value = true;
  try {
    const r = await api.post('/emails/send-test', { accountId: a.id });
    flash(`测试邮件已发往 ${r.to}，请查收`);
  } catch (e) { flash('发信失败：' + e.message, 'err'); }
  finally { smtpTesting.value = false; }
}

// ---------- 提醒 / 标签 / 附件 ----------
async function loadNotifyCfg() {
  try { notify.value = await api.get('/emails/notify'); } catch {}
}
async function saveNotify() {
  try { notify.value = await api.put('/emails/notify', notify.value); flash('提醒设置已保存'); } catch (e) { flash(e.message, 'err'); }
}
async function loadTags() {
  try { tagRules.value = ((await api.get('/emails/tags')).rules || []).map((r) => ({ ...r })); } catch { tagRules.value = []; }
}
async function saveTags() {
  try {
    const d = await api.put('/emails/tags', { rules: tagRules.value });
    tagRules.value = (d.rules || []).map((r) => ({ ...r }));
    flash('标签规则已保存（下次拉取/刷新列表生效）');
  } catch (e) { flash(e.message, 'err'); }
}
async function loadAttachCfg() {
  try { attachCfg.value = { dir: (await api.get('/emails/attach-config')).dir || '' }; attachDir.value = attachCfg.value.dir; } catch {}
}
async function saveAttachDir() {
  try {
    await api.post('/emails/attach-config', attachCfg.value);
    attachDir.value = attachCfg.value.dir;
    flash(attachCfg.value.dir ? '附件目录已保存：' + attachCfg.value.dir : '已清空附件目录');
  } catch (e) { flash(e.message, 'err'); }
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
// 正文排版：归一为每段之间恰好一个换行（只影响显示，不改库里的原文）
const fmtBody = (t) => String(t || '').replace(/\r\n?/g, '\n').replace(/\n{2,}/g, '\n');
function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return n + 'B';
  if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1048576).toFixed(1) + 'MB';
}
function goPage(n) { if (n >= 1 && n <= totalPages.value) { page.value = n; selected.value = new Set(); loadList(); } }
function fmt(t) { return t ? String(t).replace('T', ' ').slice(5, 16) : ''; }
// 第一列显示名：优先 envelope 显示名（GitHub <noreply@github.com> → GitHub），
// 没有则剥地址取 @ 前部分；发件/草稿列显示收件人
function colName(m) {
  const raw = folder.value === 'sent' || folder.value === 'draft' ? (m.to_addr || '?') : (m.from_name || m.from_addr || '?');
  const mm = String(raw).match(/^"?(.*?)"?\s*<[^>]+>$/);
  if (mm && mm[1].trim()) return mm[1].trim();
  const s = String(raw);
  return s.includes('@') ? s.split('@')[0] : (s || '?');
}

// ---------- URL 同步：?tab=contacts|esettings、?acc=账号id ----------
watch(() => route.query.tab, (t) => {
  if (t === 'contacts' && canTab('email', 'contacts')) { tab.value = 'contacts'; loadContacts(); }
  else if (t === 'esettings' && canTab('email', 'esettings')) { tab.value = 'esettings'; openSettings(); }
  else if (t && t !== 'mail') { /* 其他值不动（兼容旧 ?tab= 链接） */ }
});
watch(() => route.query.acc, (a) => {
  const id = Number(a) || 0;
  if (id && id !== acc.value && accounts.value.some((x) => x.id === id)) openAccount(id);
});

onMounted(async () => {
  await loadAccounts();
  // tab 级授权落点：无「收发邮件」权限时进通讯录/设置
  if (!canTab('email', 'mail')) {
    if (canTab('email', 'esettings')) { tab.value = 'esettings'; openSettings(); }
    else if (canTab('email', 'contacts')) { tab.value = 'contacts'; loadContacts(); }
    return;
  }
  const qAcc = Number(route.query.acc) || 0;
  if (qAcc && accounts.value.some((x) => x.id === qAcc)) acc.value = qAcc;
  const qTab = String(route.query.tab || '');
  if (qTab === 'contacts' && canTab('email', 'contacts')) { tab.value = 'contacts'; loadContacts(); return; }
  if (qTab === 'esettings' && canTab('email', 'esettings')) { tab.value = 'esettings'; openSettings(); return; }
  if (accounts.value.length) {
    loadList();
    loadCounts();
  }
});
</script>

<style scoped>
.page-select { padding: 4px 8px; border: 1px solid var(--border); background: var(--bg2); color: var(--text); border-radius: 6px; font-size: 13px; }
/* 文件夹行：tab + 操作按钮统一排在行尾（v1.7.0） */
.folder-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.folder-bar > button { padding: 5px 12px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: var(--text); cursor: pointer; font-size: 13.5px; }
.folder-bar > button.on { background: rgba(79, 124, 247, .14); border-color: rgba(79, 124, 247, .4); font-weight: 600; }
.folder-bar > button.act { border: 1px solid var(--border); background: var(--bg2); font-size: 12.5px; padding: 4px 10px; }
.folder-bar > button.act:disabled { opacity: .5; cursor: not-allowed; }
.folder-bar > button.danger { color: #e05454; border-color: rgba(224, 84, 84, .45); }
.fb-n { background: rgba(79, 124, 247, .16); border-radius: 8px; padding: 0 7px; margin-left: 5px; font-size: 11.5px; }
.fb-search { padding: 6px 10px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: inherit; font-size: 13px; width: 220px; max-width: 40vw; }
.fb-all { display: flex; align-items: center; gap: 4px; font-size: 13px; cursor: pointer; white-space: nowrap; }
/* 两列列表：第一列发件人姓名（固定宽），第二列主题 */
.mail-row { gap: 10px; }
.mail-from { width: 110px; flex-shrink: 0; font-weight: 600; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 橙底白字标签（关键词命中）与附件标签（与已读/删除徽章同尺寸） */
.tag-orange { display: inline-block; vertical-align: middle; margin-right: 6px; padding: 0 7px; border-radius: 6px;
  font-size: 11px; font-weight: 600; line-height: 18px; background: #e6a23c; color: #fff; }
.att-tag { display: inline-block; vertical-align: middle; margin-left: 6px; padding: 0 7px; border-radius: 6px;
  font-size: 11px; font-weight: 400; line-height: 18px;
  background: #e6a23c; color: #fff; }
</style>
