<template>
  <div>
    <h2 class="page-title">家庭管理</h2>
    <div class="tabs">
      <button v-if="canTab('family','family')" :class="{active: tab==='family'}" @click="tab='family'">通知</button>
      <button v-if="canTab('family','kids')" :class="{active: tab==='kids'}" @click="tab='kids'">子女学习</button>
      <button v-if="canTab('family','profiles')" :class="{active: tab==='profiles'}" @click="openProfiles">家庭人员档案</button>
      <button v-if="canTab('family','story')" :class="{active: tab==='story'}" @click="tab='story'">儿童故事</button>
      <!-- 个人账务（原独立页并入，2026-09 v1.7.0）：最后一个 tab，内含 5 个子 tab -->
      <button v-if="canPay" :class="{active: tab==='pay'}" @click="tab='pay'">个人账务</button>
    </div>

    <template v-if="tab==='family'">
      <div class="card" style="margin-bottom:12px">
        <div class="row" style="align-items:flex-start">
          <RichBox v-model="fam.title" placeholder="家庭事项（Ctrl+V 可直接粘贴图片，与文字混排）" class="grow" @uploading="famUp = $event" />
          <input v-model="fam.item_date" type="date" style="width:150px" />
          <button class="primary" :disabled="famUp" :title="famUp ? '图片还在上传中…' : ''" @click="addFamily">登记</button>
        </div>
        <!-- 登记时可选：推送消息给指定用户（含自己；对方登录后右下角弹窗提醒，消息永久留存） -->
        <div v-if="contacts.length" class="row" style="align-items:center; gap:8px; margin-top:10px; padding-top:8px; border-top:1px dashed var(--border)">
          <label style="cursor:pointer; display:flex; align-items:center; gap:5px; font-size:12.5px; flex-shrink:0">
            <input v-model="famNotify.on" type="checkbox" style="width:auto" /> 推送消息给：
          </label>
          <UserPicker v-if="famNotify.on" v-model="famNotify.users" :users="contacts" multiple placeholder="搜索并选择用户（可多选、含自己）" style="flex:1" />
        </div>
      </div>
      <div class="card">
        <div v-for="f in famPageList" :key="f.id" class="list-item">
          <span class="check" :class="{done:f.status==='done'}" @click="toggleFam(f)">{{ f.status==='done' ? '✓' : '○' }}</span>
          <div class="grow">
            <div class="t rich" v-html="displayHtml(f.title)"></div>
            <div class="d" v-if="f.desc">{{ f.desc }}</div>
            <div class="meta">
              <span v-if="f.item_date">{{ f.item_date }}</span>
              <span v-if="f.created_by_name"> · 登记人 {{ f.created_by_name }}</span>
              <span v-if="f.created_at"> · {{ f.created_at }}</span>
              <template v-if="f.status==='done'">
                <span v-if="f.done_by_name"> · {{ f.done_by_name }} 勾选</span>
                <span v-else> · 已勾选</span>
                <span v-if="f.done_at"> · {{ f.done_at }}</span>
              </template>
            </div>
          </div>
          <button class="icon-btn" @click="delFamily(f)">✕</button>
        </div>
        <div v-if="!family.length" class="empty">暂无家庭事项，登记一件吧（家庭笔记可直接在「笔记」中用「家庭」分类记录）</div>
        <div v-if="family.length" class="row pager" style="justify-content:flex-end; align-items:center; gap:8px; margin-top:10px">
          <span class="muted" style="font-size:12px">共 {{ family.length }} 条 · 第 {{ famPageClamped }}/{{ famTotal }} 页</span>
          <button class="small" :disabled="famPageClamped <= 1" @click="famPage--">上一页</button>
          <select v-model.number="famSize" style="width:auto" title="每页条数">
            <option :value="15">15 行</option><option :value="30">30 行</option><option :value="50">50 行</option>
          </select>
          <button class="small" :disabled="famPageClamped >= famTotal" @click="famPage++">下一页</button>
        </div>
      </div>
    </template>

    <template v-else-if="tab==='profiles'">
      <div class="card" style="margin-bottom:12px">
        <h3>添加家人 <span class="muted" style="font-size:12px; font-weight:400">填公历生日自动换算农历；农历生日每年映射到节日日历/日程日历显示 🎂</span></h3>
        <div class="row" style="flex-wrap:wrap; gap:8px">
          <input v-model="fp.name" placeholder="姓名" style="width:110px" />
          <input v-model="fp.relation" placeholder="关系（如 妈妈/儿子）" style="width:150px" />
          <input v-model="fp.solar_birthday" type="date" title="公历生日（登记用，自动换算农历）" style="width:150px" @change="calcLunar" />
          <input v-model="fp.lunar_birthday" placeholder="农历生日 MM-DD（自动生成，可改）" style="width:190px" title="农历月-日，如 08-16；自动换算可手改" />
          <input v-model="fp.remark" placeholder="备注（可选）" style="width:130px" />
          <button class="primary" @click="addProfile">添加</button>
        </div>
        <div v-if="fpLunarHint" class="muted" style="font-size:12px; margin-top:6px">{{ fpLunarHint }}</div>
      </div>
      <div class="card">
        <div v-if="!profiles.length" class="empty">暂无家人档案，添加后农历生日会显示在首页节日日历和日程日历</div>
        <div v-for="p in profiles" :key="p.id" class="list-item">
          <span class="avatar">{{ (p.name || '?')[0] }}</span>
          <div class="grow">
            <div class="t">{{ p.name }} <span v-if="p.relation" class="badge blue" style="font-size:11px">{{ p.relation }}</span><span v-if="p.animal" class="badge" style="font-size:11px; margin-left:2px" title="生肖（按农历年，春节分界）">属{{ p.animal }}</span><span v-if="p.zodiac" class="badge amber" style="font-size:11px; margin-left:2px">{{ p.zodiac }}</span><span v-if="p.age_solar !== null && p.age_solar !== undefined" class="badge" style="font-size:11px; margin-left:2px">{{ p.age_solar }}周岁 · 虚{{ p.age_nominal }}岁</span></div>
            <div class="d">
              公历 {{ p.solar_birthday || '—' }}
              <span v-if="p.lunar_text"> · 农历 {{ p.lunar_text }}</span>
              <span v-if="p.next_birthday"> · 今年 {{ p.next_birthday }}</span>
            </div>
            <div class="d" v-if="p.remark">{{ p.remark }}</div>
          </div>
          <button class="icon-btn" title="修改" @click="editProfile(p)">✎</button>
          <button class="icon-btn" @click="delProfile(p)">✕</button>
        </div>
      </div>
    </template>

    <template v-else-if="tab==='kids'">
      <div class="grid" style="grid-template-columns:1fr 2fr">
        <div class="card">
          <h3>孩子档案</h3>
          <div class="row" style="margin-bottom:10px">
            <input v-model="kid.name" placeholder="姓名" />
            <input v-model="kid.grade" placeholder="年级" style="width:90px" />
            <button class="primary small" @click="addKid">添加</button>
          </div>
          <div v-for="k in data.kids" :key="k.id" class="list-item">
            <div class="grow">
              <div class="t">{{ k.name }}</div>
              <div class="d">{{ k.grade }}</div>
            </div>
            <button class="icon-btn" @click="delKid(k)">✕</button>
          </div>
        </div>

        <div class="card">
          <h3>学习任务跟进</h3>
          <div class="row" style="flex-wrap:wrap; margin-bottom:8px">
            <select v-model="tk.kid_id" style="width:110px">
              <option :value="null">未指定</option>
              <option v-for="k in data.kids" :key="k.id" :value="k.id">{{ k.name }}</option>
            </select>
            <input v-model="tk.subject" placeholder="科目" style="width:90px" />
            <RichBox v-model="tk.content" placeholder="任务内容（Ctrl+V 可直接粘贴图片，与文字混排）" class="grow" @uploading="tkUp = $event" />
            <input v-model="tk.due_date" type="date" style="width:140px" />
            <button class="primary" :disabled="tkUp" :title="tkUp ? '图片还在上传中…' : ''" @click="addTask">下发任务</button>
          </div>
          <!-- 下发任务时可选：推送消息给指定用户（含自己） -->
          <div v-if="contacts.length" class="row" style="align-items:center; gap:8px; margin-bottom:12px; padding-top:8px; border-top:1px dashed var(--border)">
            <label style="cursor:pointer; display:flex; align-items:center; gap:5px; font-size:12.5px; flex-shrink:0">
              <input v-model="tkNotify.on" type="checkbox" style="width:auto" /> 推送消息给：
            </label>
            <UserPicker v-if="tkNotify.on" v-model="tkNotify.users" :users="contacts" multiple placeholder="搜索并选择用户（可多选、含自己）" style="flex:1" />
          </div>
          <div v-for="t in taskPageList" :key="t.id" class="list-item">
            <span class="check" :class="{done:t.status==='done'}" @click="toggleTask(t)">{{ t.status==='done' ? '✓' : '○' }}</span>
            <div class="grow">
              <div class="t rich">
                <span v-if="t.kid_id" class="badge blue">{{ kidName(t.kid_id) }}</span>
                <span v-if="t.subject" class="badge amber">{{ t.subject }}</span>
                <span v-html="displayHtml(t.content)"></span>
              </div>
              <div class="meta" v-if="t.due_date">截止 {{ t.due_date }}<span v-if="t.done_at"> · 完成于 {{ t.done_at.slice(0,16) }}</span></div>
            </div>
            <button class="icon-btn" @click="delTask(t)">✕</button>
          </div>
          <div v-if="!data.tasks.length" class="empty">暂无学习任务</div>
          <div v-if="data.tasks.length" class="row pager" style="justify-content:flex-end; align-items:center; gap:8px; margin-top:10px">
            <span class="muted" style="font-size:12px">共 {{ data.tasks.length }} 条 · 第 {{ taskPageClamped }}/{{ taskTotal }} 页</span>
            <button class="small" :disabled="taskPageClamped <= 1" @click="taskPage--">上一页</button>
            <select v-model.number="taskSize" style="width:auto" title="每页条数">
              <option :value="15">15 行</option><option :value="30">30 行</option><option :value="50">50 行</option>
            </select>
            <button class="small" :disabled="taskPageClamped >= taskTotal" @click="taskPage++">下一页</button>
          </div>
        </div>
      </div>
    </template>

    <!-- ============ 儿童故事（v1.9.36，组件内部自带分页/弹窗/音频播放） ============ -->
    <StoryPanel v-else-if="tab==='story'" />

    <!-- ============ 个人账务（原独立页整页并入，v1.7.0 最后一个 tab） ============ -->
    <PayPanel v-else-if="tab==='pay'" />

    <!-- 档案修改弹窗：独立 v-if，刻意放在所有页签 template 之后。
         曾插在 profiles 与 kids 两个 template 中间，打断了 v-if/v-else-if 链：
         kids 变成了弹窗的 else 分支，弹窗开着时切换页签整页只剩弹窗 -->
    <div v-if="fpEdit.show" class="modal-backdrop" @click.self="fpEdit.show = false">
      <div class="modal" style="width:min(480px, 92vw)">
        <h3>修改家人档案</h3>
        <div class="form-row"><label>姓名</label><input v-model="fpEdit.form.name" /></div>
        <div class="form-row"><label>关系</label><input v-model="fpEdit.form.relation" placeholder="如 妈妈/儿子" /></div>
        <div class="form-row">
          <label>公历生日（星座与农历按此换算）</label>
          <div class="row">
            <input v-model="fpEdit.form.solar_birthday" type="date" style="width:160px" @change="calcEditLunar" />
            <span v-if="fpEditAnimal" class="badge" title="生肖（按农历年，春节分界）">属{{ fpEditAnimal }}</span>
            <span v-if="fpEditZodiac" class="badge amber">{{ fpEditZodiac }}</span>
          </div>
        </div>
        <div class="form-row">
          <label>农历生日 MM-DD（清空后保存按公历重算）</label>
          <input v-model="fpEdit.form.lunar_birthday" placeholder="如 07-19" style="width:140px" />
        </div>
        <div v-if="fpEditHint" class="muted" style="font-size:12px; margin-bottom:10px">{{ fpEditHint }}</div>
        <div class="form-row"><label>备注</label><input v-model="fpEdit.form.remark" /></div>
        <div class="row" style="justify-content:flex-end; gap:8px">
          <button class="small" @click="fpEdit.show = false">取消</button>
          <button class="primary" @click="saveProfileEdit">保存</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api';
import UserPicker from '../components/UserPicker.vue';
import RichBox from '../components/RichBox.vue';
import { canTab, firstTab } from '../tabs';
import { displayHtml, richHasContent } from '../utils/rich';
// v1.7.0 个人账务整页并入（组件内部自带 5 个子 tab 与数据加载）
import PayPanel from './Pay.vue';
// v1.9.36 儿童故事（家庭共享：导入/AI 生成 → 文字转音频 → 播放/下载）
import StoryPanel from './StoryPanel.vue';

const route = useRoute();
const tab = ref(firstTab('family', 'family'));
// 个人账务按钮可见性：整页键 'pay' 或任一子 tab 键有权限即可见（老授权迁移后细分键挂在 family 下）
const canPay = computed(() =>
  canTab('family', 'pay') || ['dash', 'cats', 'import', 'bills', 'budget'].some((k) => canTab('family', k)));
const data = ref({ kids: [], tasks: [] });
const family = ref([]);
// 登记日期默认当天（可改可清空）
const todayStr = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const fam = ref({ title: '', desc: '', item_date: todayStr() });
const kid = ref({ name: '', grade: '' });
const tk = ref({ kid_id: null, subject: '', content: '', due_date: todayStr() });

// ---------- 客户端分页（默认 15 行，可 15/30/50） ----------
const famPage = ref(1); const famSize = ref(15);
const famTotal = computed(() => Math.max(1, Math.ceil(family.value.length / famSize.value)));
const famPageClamped = computed(() => Math.min(Math.max(1, famPage.value), famTotal.value));
const famPageList = computed(() => family.value.slice((famPageClamped.value - 1) * famSize.value, famPageClamped.value * famSize.value));
watch(famSize, () => { famPage.value = 1; });
const taskPage = ref(1); const taskSize = ref(15);
const taskTotal = computed(() => Math.max(1, Math.ceil(data.value.tasks.length / taskSize.value)));
const taskPageClamped = computed(() => Math.min(Math.max(1, taskPage.value), taskTotal.value));
const taskPageList = computed(() => data.value.tasks.slice((taskPageClamped.value - 1) * taskSize.value, taskPageClamped.value * taskSize.value));
watch(taskSize, () => { taskPage.value = 1; });

// 各数据源独立容错：无对应 tab 权限时接口 403，不能拖垮其他 tab
async function load() {
  try { data.value = await api.get('/kids'); } catch { data.value = { kids: [], tasks: [] }; }
  try { family.value = await api.get('/family'); } catch { family.value = []; }
}

async function addFamily() {
  if (!richHasContent(fam.value.title)) return;
  if (famUp.value) { alert('图片还在上传中，请稍候再登记'); return; } // 按钮禁用外的双保险（禁用绑定可能有极小竞态窗口）
  const notify = famNotify.value.on ? famNotify.value.users.map(Number) : [];
  try {
    await api.post('/family', { ...fam.value, notify_users: notify });
  } catch (e) { alert('登记失败：' + e.message); return; }
  fam.value = { title: '', desc: '', item_date: todayStr() };
  famNotify.value = { on: false, users: [] };
  await load();
  if (notify.length) window.dispatchEvent(new CustomEvent('wb-messages-check')); // 推送对象含自己时立即弹窗
}
async function toggleFam(f) {
  await api.patch(`/family/${f.id}`, { status: f.status === 'done' ? 'todo' : 'done' });
  await load();
}
async function delFamily(f) { await api.del(`/family/${f.id}`); await load(); }

async function addKid() {
  if (!kid.value.name.trim()) return;
  await api.post('/kids', kid.value);
  kid.value = { name: '', grade: '' };
  await load();
}
async function delKid(k) { await api.del(`/kids/${k.id}`); await load(); }

async function addTask() {
  if (!richHasContent(tk.value.content)) return;
  if (tkUp.value) { alert('图片还在上传中，请稍候再下发'); return; }
  const notify = tkNotify.value.on ? tkNotify.value.users.map(Number) : [];
  try {
    await api.post('/kid-tasks', { ...tk.value, notify_users: notify });
  } catch (e) { alert('下发失败：' + e.message); return; }
  tk.value = { kid_id: null, subject: '', content: '', due_date: todayStr() };
  tkNotify.value = { on: false, users: [] };
  await load();
  if (notify.length) window.dispatchEvent(new CustomEvent('wb-messages-check')); // 推送对象含自己时立即弹窗
}
async function toggleTask(t) {
  await api.patch(`/kid-tasks/${t.id}`, { status: t.status === 'done' ? 'todo' : 'done' });
  await load();
}
async function delTask(t) { await api.del(`/kid-tasks/${t.id}`); await load(); }

function kidName(id) {
  return data.value.kids.find((k) => k.id === id)?.name || '孩子';
}

// ---------- 家庭人员档案 ----------
const profiles = ref([]);
const fp = ref({ name: '', relation: '', solar_birthday: '', lunar_birthday: '', remark: '' });
const fpLunarHint = ref('');
const LUNAR_MONTHS = ['正','二','三','四','五','六','七','八','九','十','冬','腊'];
function lunarDayText(d) {
  const PRE = ['初','十','廿','三'];
  const NUM = ['一','二','三','四','五','六','七','八','九','十'];
  if (d === 10) return '初十';
  if (d === 20) return '二十';
  if (d === 30) return '三十';
  return PRE[Math.floor((d - 1) / 10)] + NUM[(d - 1) % 10];
}
async function openProfiles() {
  tab.value = 'profiles';
  await loadProfiles();
}
async function loadProfiles() {
  try {
    const list = await api.get('/family-profiles');
    // 补充展示信息：农历文本 + 今年生日
    const year = new Date().getFullYear();
    try {
      const l = await api.get(`/lunar/year?year=${year}`);
      const bd = l.birthdays || [];
      for (const p of list) {
        const m = /^(\d{1,2})-(\d{1,2})$/.exec(String(p.lunar_birthday || ''));
        p.lunar_text = m ? `${LUNAR_MONTHS[Number(m[1]) - 1]}月${lunarDayText(Number(m[2]))}` : '';
        const hit = bd.find((b) => b.name === p.name);
        p.next_birthday = hit ? hit.date : '';
      }
    } catch {}
    profiles.value = list;
  } catch { profiles.value = []; }
}
// 填公历生日 → 换算农历 MM-DD
async function calcLunar() {
  const d = fp.value.solar_birthday;
  if (!d) { fpLunarHint.value = ''; return; }
  try {
    const r = await api.get(`/lunar/convert?date=${d}`);
    fp.value.lunar_birthday = r.key;
    fpLunarHint.value = `公历 ${d} = 农历${r.lunar}${r.term ? `（${r.term}）` : ''}`;
  } catch (e) { fpLunarHint.value = '换算失败：' + e.message; }
}
async function addProfile() {
  if (!fp.value.name.trim()) return;
  try {
    await api.post('/family-profiles', fp.value);
    fp.value = { name: '', relation: '', solar_birthday: '', lunar_birthday: '', remark: '' };
    fpLunarHint.value = '';
    await loadProfiles();
  } catch (e) { alert('添加失败：' + e.message); }
}
async function delProfile(p) {
  if (!confirm(`删除「${p.name}」的档案？`)) return;
  await api.del(`/family-profiles/${p.id}`);
  await loadProfiles();
}

// ---------- 档案修改 ----------
const fpEdit = ref({ show: false, id: 0, form: { name: '', relation: '', solar_birthday: '', lunar_birthday: '', remark: '' } });
const fpEditHint = ref('');
const ZODIAC_RANGES = [
  [1, 20, '水瓶座'], [2, 19, '双鱼座'], [3, 21, '白羊座'], [4, 20, '金牛座'],
  [5, 21, '双子座'], [6, 22, '巨蟹座'], [7, 23, '狮子座'], [8, 23, '处女座'],
  [9, 23, '天秤座'], [10, 24, '天蝎座'], [11, 23, '射手座'], [12, 22, '摩羯座'],
];
function zodiacOfLocal(dateStr) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(dateStr || '').trim());
  if (!m) return '';
  const mo = Number(m[2]), d = Number(m[3]);
  const hit = ZODIAC_RANGES.find(([zm, zd]) => zm === mo && d >= zd);
  if (hit) return hit[2];
  // 月初（未到本月起始日）= 上一个星座；1 月初 = 摩羯座
  const prevM = mo === 1 ? 12 : mo - 1;
  return (ZODIAC_RANGES.slice().reverse().find(([zm]) => zm === prevM) || [0, 0, ''])[2] || (prevM === 12 ? '摩羯座' : '');
}
const fpEditZodiac = computed(() => zodiacOfLocal(fpEdit.form.solar_birthday));
// 生肖：后端按农历年算好返回（编辑改日期时由 /lunar/convert 实时带回）
const fpEditAnimal = ref('');
function editProfile(p) {
  fpEdit.value = { show: true, id: p.id, form: { name: p.name || '', relation: p.relation || '', solar_birthday: p.solar_birthday || '', lunar_birthday: p.lunar_birthday || '', remark: p.remark || '' } };
  fpEditHint.value = p.lunar_text ? `当前农历：${p.lunar_text}` : '';
  fpEditAnimal.value = p.animal || '';
}
async function calcEditLunar() {
  const d = fpEdit.value.form.solar_birthday;
  if (!d) { fpEditHint.value = ''; fpEditAnimal.value = ''; return; }
  try {
    const r = await api.get(`/lunar/convert?date=${d}`);
    fpEdit.value.form.lunar_birthday = r.key;
    fpEditHint.value = `公历 ${d} = 农历${r.lunar}${r.term ? `（${r.term}）` : ''}`;
    if (r.animal) fpEditAnimal.value = r.animal;
  } catch (e) { fpEditHint.value = '换算失败：' + e.message; }
}
async function saveProfileEdit() {
  const f = fpEdit.value.form;
  if (!f.name.trim()) { alert('姓名不能为空'); return; }
  try {
    await api.put(`/family-profiles/${fpEdit.value.id}`, { ...f, lunar_birthday: f.lunar_birthday || '' });
    fpEdit.value.show = false;
    await loadProfiles();
  } catch (e) { alert('保存失败：' + e.message); }
}

// ---------- 登记时推送消息给指定用户（含自己；UserPicker 下拉搜索多选） ----------
const contacts = ref([]); // 全部系统用户（无可推送对象时隐藏勾选区）
const famNotify = ref({ on: false, users: [] });
const tkNotify = ref({ on: false, users: [] });
const famUp = ref(false); // 家庭事项录入框图片上传中（此时登记按钮禁用，防丢图）
const tkUp = ref(false);  // 任务录入框同上
async function loadContacts() {
  try { contacts.value = (await api.get('/messages/contacts')).users || []; } catch { contacts.value = []; }
}

onMounted(() => {
  // ?tab=pay 直达（旧 /pay 地址重定向过来）
  if (String(route.query.tab || '') === 'pay' && canPay.value) tab.value = 'pay';
  // ?tab=story 直达（儿童故事）。深链必须过 canTab 校验：canTab 对 admin 的未知 key 也放行，
  // 不校验的话 key 写错会落进下面 v-else 的空分支
  if (String(route.query.tab || '') === 'story' && canTab('family', 'story')) tab.value = 'story';
  load(); loadContacts();
});
</script>
