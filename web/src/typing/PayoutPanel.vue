<template>
  <div class="payout">
    <div class="po-card">
      <h3>登记已结算兑现</h3>
      <div class="po-form">
        <label>成员
          <select v-model="form.user_id">
            <option v-if="!users.length" :value="0">加载中…</option>
            <option v-for="u in users" :key="u.id" :value="u.id">{{ u.name }}</option>
          </select>
        </label>
        <label>月份
          <input v-model="form.period" type="month">
        </label>
        <label>金额（元）
          <input v-model.number="form.amount" type="number" min="0.01" step="0.01" placeholder="0.00">
        </label>
        <label class="grow">备注
          <input v-model="form.note" type="text" maxlength="100" placeholder="微信转账 / 现金 / 换购…（可选）">
        </label>
        <button class="primary" :disabled="saving || !form.user_id || !form.amount" @click="submit">登记兑现</button>
      </div>
      <div v-if="preview" class="po-preview">
        <b>{{ previewName }}</b> {{ form.period }}：
        打字 有效 <b :class="{ hot: preview.net < 0 }">{{ preview.net }}</b> 字 → <b>¥{{ num(preview.typing_earned) }}</b>
        · 视频 <b>{{ fmtDur(preview.video_sec) }}</b> → <b>¥{{ num(preview.video_earned) }}</b>
        · 练琴 <b>{{ fmtDur(preview.piano_sec) }}</b> → <b>¥{{ num(preview.piano_earned) }}</b>
        <br>
        应得合计 <b>¥{{ num(preview.earned) }}</b> · 已兑现 <b>¥{{ num(preview.paid) }}</b>
        <template v-if="preview.advanced > 0"> · 已赊账 <b class="hot">¥{{ num(preview.advanced) }}</b></template>
        · 待兑现 <b class="hot">¥{{ num(preview.pending) }}</b>
        <a v-if="preview.pending > 0" class="mini-link" @click="form.amount = preview.pending">填入待兑现金额</a>
      </div>
      <div v-if="msg" class="po-msg" :class="msgType">{{ msg }}</div>
    </div>

    <div class="po-card">
      <h3>奖励标准 <span class="muted">（打字 / 视频教学 / 练琴 三项分别设置）</span></h3>
      <div class="rate-line">
        打字：每
        <input v-model.number="rateChars" type="number" min="1" step="10"> 个有效字 =
        <input v-model.number="rateYuan" type="number" min="0.1" step="0.5"> 元
      </div>
      <div class="rate-line">
        视频教学：每
        <input v-model.number="rateVMin" type="number" min="1" step="10"> 分钟学时 =
        <input v-model.number="rateVYuan" type="number" min="0.1" step="0.5"> 元
      </div>
      <div class="rate-line">
        练琴：每
        <input v-model.number="ratePHours" type="number" min="0.1" step="0.5"> 小时有效时长 =
        <input v-model.number="ratePYuan" type="number" min="0.1" step="0.5"> 元
        <span class="cur">（当前生效：打字 {{ config.reward_chars }} 字={{ config.reward_yuan }} 元 · 视频 {{ config.video_reward_minutes }} 分={{ config.video_reward_yuan }} 元 · 练琴 {{ config.piano_reward_hours }} 时={{ config.piano_reward_yuan }} 元）</span>
        <button class="primary" :disabled="savingRate || !rateChars || !rateYuan || !rateVMin || !rateVYuan || !ratePHours || !ratePYuan" @click="saveRate">保存标准</button>
      </div>
      <div v-if="rateMsg" class="po-msg" :class="rateMsgType">{{ rateMsg }}</div>
    </div>

    <!-- ============ 赊账兑换登记 ============ -->
    <div class="po-card">
      <h3>赊账兑换登记 <span class="muted">（提前支取，金额记为负数，占用当月待兑现额度）</span></h3>
      <div class="po-form">
        <label>日期时间
          <input v-model="cr.created_at" type="datetime-local">
        </label>
        <label>成员
          <select v-model.number="cr.user_id">
            <option v-if="!users.length" :value="0">加载中…</option>
            <option v-for="u in users" :key="u.id" :value="u.id">{{ u.name }}</option>
          </select>
        </label>
        <label>月份
          <input v-model="cr.period" type="month">
        </label>
        <label>金额（元）
          <input v-model.number="cr.amount" type="number" step="0.01" placeholder="-10.00" :class="{ pos: cr.amount > 0 }">
        </label>
        <label>赊账内容
          <input v-model="cr.content" type="text" maxlength="200" placeholder="买了什么 / 换了什么">
        </label>
        <label class="grow">备注
          <input v-model="cr.note" type="text" maxlength="300" placeholder="可选">
        </label>
        <label>图片凭证
          <span class="img-pick">
            <img v-if="cr.image_id" class="thumb" :src="imgUrl(cr.image_id)" alt="" @click="pickImg" title="点击更换" />
            <button v-else class="pick-btn" type="button" @click="pickImg">{{ imgBusy ? '上传中…' : '＋ 上传' }}</button>
            <a v-if="cr.image_id" class="mini-link" @click="cr.image_id = 0">移除</a>
            <input ref="imgInput" type="file" accept="image/*" style="display:none" @change="onImgChange" />
          </span>
        </label>
        <button class="primary" :disabled="crSaving || !cr.user_id || !cr.amount || !cr.content" @click="submitCredit">登记赊账</button>
      </div>
      <div v-if="cr.amount > 0" class="hint">金额将按负数（-¥{{ Math.abs(cr.amount).toFixed(2) }}）记账</div>
      <div v-if="crMsg" class="po-msg" :class="crMsgType">{{ crMsg }}</div>
    </div>

    <!-- 赊账兑换列表：可勾选平账（记录页下方为只读副本） -->
    <div class="po-card">
      <h3>赊账兑换列表 <span class="muted">（勾选「平账」表示已结清；已平账显示划线）</span></h3>
      <div class="tbl-wrap">
        <table class="po-table">
          <thead>
            <tr><th>序号</th><th>日期时间</th><th>成员</th><th>月份</th><th>金额</th><th>内容</th><th>备注</th><th>凭证</th><th>平账</th><th>状态</th><th>登记人</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="(c, i) in creditRows" :key="c.id" :class="{ settled: c.settled }">
              <td>{{ (crPage - 1) * crSize + i + 1 }}</td>
              <td :class="{ strike: c.settled }">{{ c.created_at }}</td>
              <td :class="{ strike: c.settled }">{{ c.user_name }}</td>
              <td :class="{ strike: c.settled }">{{ c.period }}</td>
              <td :class="{ strike: c.settled }" class="neg-money">¥{{ Number(c.amount).toFixed(2) }}</td>
              <td :class="{ strike: c.settled }" class="note">{{ c.content || '—' }}</td>
              <td :class="{ strike: c.settled }" class="note">{{ c.note || '—' }}</td>
              <td>
                <div v-if="c.image_id" class="mini-img" title="点击放大" @click="zoomId = c.image_id"><img :src="imgUrl(c.image_id)" alt="凭证" /></div>
                <span v-else class="muted">—</span>
              </td>
              <td><input type="checkbox" style="width:auto" :checked="!!c.settled" @change="toggleSettle(c, $event)" /></td>
              <td>
                <span v-if="c.settled" class="badge ok">已平账{{ c.settled_at ? ' · ' + c.settled_at : '' }}</span>
                <span v-else class="badge wait">待兑现</span>
              </td>
              <td>{{ c.created_by_name || '—' }}</td>
              <td><a v-if="canDelCredit(c)" class="del" @click="removeCredit(c)">删除</a></td>
            </tr>
            <tr v-if="!creditRows.length"><td colspan="12" class="empty">暂无赊账兑换记录</td></tr>
          </tbody>
        </table>
      </div>
      <div class="pager">
        <span class="muted" style="font-size:12px">共 {{ crTotal }} 条</span>
        <span class="grow"></span>
        <button class="small" :disabled="crPage <= 1" @click="loadCredit(crPage - 1)">‹ 上一页</button>
        <span class="muted" style="font-size:12px">{{ crPage }} / {{ crTotalPages }}</span>
        <button class="small" :disabled="crPage >= crTotalPages" @click="loadCredit(crPage + 1)">下一页 ›</button>
        <select v-model.number="crSize" title="每页条数" @change="loadCredit(1)">
          <option :value="15">15 行</option><option :value="30">30 行</option><option :value="50">50 行</option>
        </select>
      </div>
    </div>

    <div class="po-card">
      <h3>兑现记录</h3>
      <table class="po-table">
        <thead>
          <tr><th>时间</th><th>成员</th><th>月份</th><th>金额</th><th>备注</th><th>登记人</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="p in list" :key="p.id">
            <td>{{ p.created_at }}</td>
            <td>{{ p.user_name }}</td>
            <td>{{ p.period }}</td>
            <td class="ok">¥{{ Number(p.amount).toFixed(2) }}</td>
            <td class="note">{{ p.note || '—' }}</td>
            <td>{{ p.created_by_name }}</td>
            <td><a v-if="canDelete(p)" class="del" @click="remove(p)">删除</a></td>
          </tr>
          <tr v-if="!list.length"><td colspan="7" class="empty">还没有兑现记录</td></tr>
        </tbody>
      </table>
    </div>

    <!-- 凭证图片放大查看（点击图片/遮罩/Esc 关闭） -->
    <div v-if="zoomId" class="modal-backdrop" @click.self="zoomId = null">
      <img class="zoom-img" :src="imgUrl(zoomId)" alt="凭证" @click="zoomId = null" />
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { api } from '../api';

const me = JSON.parse(localStorage.getItem('wb_user') || 'null');
const isAdmin = !!me && me.role === 'admin';

const users = ref([]);
const list = ref([]);
const preview = ref(null);
const saving = ref(false);
const msg = ref('');
const msgType = ref('ok');
const form = reactive({
  user_id: 0,
  period: new Date().toLocaleDateString('sv').slice(0, 7),
  amount: null,
  note: '',
});

const previewName = computed(() => {
  const u = users.value.find((x) => x.id === form.user_id);
  return u ? u.name : '';
});
const canDelete = (p) => isAdmin || (me && p.created_by === me.id);

// 奖励标准（能进兑现登记 tab 即可设置）：打字 / 视频教学 / 练琴
const config = ref({ reward_chars: 100, reward_yuan: 2, video_reward_minutes: 60, video_reward_yuan: 1, piano_reward_hours: 1, piano_reward_yuan: 3 });
const rateChars = ref(100);
const rateYuan = ref(2);
const rateVMin = ref(60);
const rateVYuan = ref(1);
const ratePHours = ref(1);
const ratePYuan = ref(3);
const savingRate = ref(false);
const rateMsg = ref('');
const rateMsgType = ref('ok');

async function loadRate() {
  config.value = await api.get('/typing/config');
  rateChars.value = config.value.reward_chars;
  rateYuan.value = config.value.reward_yuan;
  rateVMin.value = config.value.video_reward_minutes;
  rateVYuan.value = config.value.video_reward_yuan;
  ratePHours.value = config.value.piano_reward_hours;
  ratePYuan.value = config.value.piano_reward_yuan;
}
async function saveRate() {
  if (savingRate.value) return;
  savingRate.value = true;
  try {
    config.value = await api.put('/typing/config', {
      reward_chars: rateChars.value, reward_yuan: rateYuan.value,
      video_reward_minutes: rateVMin.value, video_reward_yuan: rateVYuan.value,
      piano_reward_hours: ratePHours.value, piano_reward_yuan: ratePYuan.value,
    });
    rateMsg.value = '奖励标准已保存，日历与预览金额已按新标准计算';
    rateMsgType.value = 'ok';
    await Promise.all([loadPreview(), loadRate()]);
  } catch (e) {
    rateMsg.value = e.message;
    rateMsgType.value = 'err';
  }
  savingRate.value = false;
  setTimeout(() => { rateMsg.value = ''; }, 3000);
}

async function loadUsers() {
  users.value = await api.get('/typing/payouts/users');
  if (!form.user_id && users.value.length) form.user_id = me && users.value.some((u) => u.id === me.id) ? me.id : users.value[0].id;
  if (!cr.user_id && users.value.length) cr.user_id = form.user_id;
}
async function loadList() {
  list.value = await api.get('/typing/payouts');
}
async function loadPreview() {
  if (!form.user_id) { preview.value = null; return; }
  try {
    preview.value = await api.get(`/typing/payouts/preview?user_id=${form.user_id}&month=${form.period}`);
  } catch {
    preview.value = null;
  }
}
async function submit() {
  if (saving.value) return;
  saving.value = true;
  try {
    await api.post('/typing/payouts', { ...form });
    msg.value = '登记成功';
    msgType.value = 'ok';
    form.amount = null;
    form.note = '';
    await Promise.all([loadList(), loadPreview()]);
  } catch (e) {
    msg.value = e.message;
    msgType.value = 'err';
  }
  saving.value = false;
  setTimeout(() => { msg.value = ''; }, 3000);
}
async function remove(p) {
  if (!confirm(`删除 ${p.user_name} ${p.period} 的 ¥${Number(p.amount).toFixed(2)} 兑现记录？`)) return;
  try {
    await api.del(`/typing/payouts/${p.id}`);
    await Promise.all([loadList(), loadPreview()]);
  } catch (e) {
    alert(e.message);
  }
}

// ---------- 赊账兑换登记 ----------
const nowLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const cr = reactive({
  created_at: nowLocal(),
  user_id: 0,
  period: new Date().toLocaleDateString('sv').slice(0, 7),
  amount: null,
  content: '',
  note: '',
  image_id: 0,
});
const crSaving = ref(false);
const crMsg = ref('');
const crMsgType = ref('ok');
const imgInput = ref(null);
const imgBusy = ref(false);
const imgUrl = (id) => `/api/family-images/${id}?token=${encodeURIComponent(localStorage.getItem('wb_token') || '')}`;

function pickImg() { imgInput.value?.click(); }
function onImgChange(e) {
  const f = (e.target.files || [])[0];
  e.target.value = '';
  if (!f) return;
  imgBusy.value = true;
  const fr = new FileReader();
  fr.onload = async () => {
    try { cr.image_id = (await api.post('/family-images', { data: fr.result })).id; }
    catch (err) { alert('图片上传失败：' + err.message); }
    imgBusy.value = false;
  };
  fr.onerror = () => { imgBusy.value = false; };
  fr.readAsDataURL(f);
}

async function submitCredit() {
  if (crSaving.value) return;
  crSaving.value = true;
  try {
    await api.post('/credit/manage', {
      created_at: cr.created_at ? cr.created_at.replace('T', ' ') + ':00' : '',
      user_id: cr.user_id,
      period: cr.period,
      amount: cr.amount,
      content: cr.content,
      note: cr.note,
      image_id: cr.image_id || 0,
    });
    crMsg.value = '赊账登记成功（金额已记为负数）';
    crMsgType.value = 'ok';
    cr.amount = null; cr.content = ''; cr.note = ''; cr.image_id = 0;
    cr.created_at = nowLocal();
    await Promise.all([loadCredit(crPage.value), loadPreview()]);
  } catch (e) {
    crMsg.value = e.message;
    crMsgType.value = 'err';
  }
  crSaving.value = false;
  setTimeout(() => { crMsg.value = ''; }, 3000);
}

// 赊账列表（服务端分页 15/30/50）
const creditRows = ref([]);
const crTotal = ref(0);
const crPage = ref(1);
const crSize = ref(15);
const crTotalPages = computed(() => Math.max(1, Math.ceil(crTotal.value / crSize.value)));
async function loadCredit(p = 1) {
  crPage.value = p;
  try {
    const r = await api.get(`/credit/list?page=${p}&pageSize=${crSize.value}`);
    creditRows.value = r.rows || [];
    crTotal.value = r.total || 0;
  } catch { creditRows.value = []; crTotal.value = 0; }
}
async function toggleSettle(c, ev) {
  const settled = ev.target.checked;
  try {
    await api.patch(`/credit/manage/${c.id}/settle`, { settled });
    c.settled = settled ? 1 : 0;
    await loadPreview();
  } catch (e) {
    ev.target.checked = !settled;
    alert('操作失败：' + e.message);
  }
}
const canDelCredit = (c) => isAdmin || (me && c.created_by === me.id);
// 凭证缩略图点击放大（Esc 关闭）
const zoomId = ref(null);
const onZoomKey = (e) => { if (e.key === 'Escape') zoomId.value = null; };
onMounted(() => window.addEventListener('keydown', onZoomKey));
onUnmounted(() => window.removeEventListener('keydown', onZoomKey));
async function removeCredit(c) {
  if (!confirm(`删除 ${c.user_name} 的赊账 ¥${Math.abs(Number(c.amount)).toFixed(2)}（${c.content || '无内容'}）？`)) return;
  try { await api.del(`/credit/manage/${c.id}`); await Promise.all([loadCredit(crPage.value), loadPreview()]); }
  catch (e) { alert(e.message); }
}

const fmtDur = (sec) => {
  const mm = Math.round((sec || 0) / 60);
  if (!mm) return '0 分';
  return mm < 60 ? `${mm} 分` : `${Math.floor(mm / 60)} 时 ${mm % 60} 分`;
};
// 金额格式化：服务端在净字数为 0 等场景会返回 null，直接 .toFixed() 会把整页渲染搞崩
const num = (v) => Number(v || 0).toFixed(2);

watch(() => [form.user_id, form.period], loadPreview);
onMounted(async () => {
  await Promise.all([loadUsers(), loadRate()]);
  await Promise.all([loadList(), loadPreview(), loadCredit(1)]);
});
</script>

<style scoped>
.payout { display: flex; flex-direction: column; gap: 14px; }
.po-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
.po-card h3 { font-size: 14px; font-weight: 600; margin-bottom: 12px; }
.muted { color: var(--text3); font-size: 12px; font-weight: 400; }
.po-form { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
.po-form label { display: flex; flex-direction: column; gap: 5px; font-size: 12.5px; color: var(--text3); }
.po-form label.grow { flex: 1; min-width: 160px; }
.po-form select, .po-form input { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font-size: 13.5px; min-width: 110px; }
.po-form input.pos { border-color: var(--red); }
.po-form .primary { background: var(--accent); color: #fff; border: none; border-radius: 8px; padding: 9px 22px; font-size: 13.5px; cursor: pointer; }
.po-form .primary:disabled { opacity: .5; cursor: default; }
.rate-line { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13.5px; color: var(--text2); margin-bottom: 8px; }
.rate-line:last-of-type { margin-bottom: 0; }
.rate-line input { width: 84px; background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 7px; padding: 6px 8px; text-align: center; }
.rate-line .cur { color: var(--text3); font-size: 12.5px; }
.rate-line .primary { background: var(--accent); color: #fff; border: none; border-radius: 8px; padding: 8px 20px; font-size: 13.5px; cursor: pointer; }
.rate-line .primary:disabled { opacity: .5; cursor: default; }
.po-preview { margin-top: 12px; font-size: 13px; color: var(--text2); background: var(--bg3); border-radius: 8px; padding: 9px 12px; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.po-preview b { color: var(--amber); }
.po-preview b.hot { color: var(--green); }
.mini-link { color: var(--accent); font-size: 12px; cursor: pointer; margin-left: 6px; text-decoration: underline; }
.po-msg { margin-top: 10px; font-size: 13px; }
.po-msg.ok { color: var(--green); }
.po-msg.err { color: var(--red); }
.hint { margin-top: 8px; font-size: 12px; color: var(--red); }
.img-pick { display: inline-flex; align-items: center; gap: 8px; }
.thumb { width: 40px; height: 40px; border-radius: 8px; object-fit: cover; cursor: pointer; border: 1px solid var(--border); }
.pick-btn { background: var(--bg3); color: var(--text3); border: 1px dashed var(--border); border-radius: 8px; padding: 9px 14px; font-size: 12.5px; cursor: pointer; }
.tbl-wrap { overflow-x: auto; }
.po-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.po-table th { text-align: left; color: var(--text3); font-weight: 500; font-size: 12px; padding: 6px 8px; border-bottom: 1.5px solid var(--border); white-space: nowrap; }
.po-table td { padding: 7px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.po-table .ok { color: var(--green); font-weight: 600; }
.po-table .note { color: var(--text3); white-space: normal; max-width: 220px; }
.po-table .neg-money { color: var(--red); font-weight: 600; }
.po-table .del { color: var(--red); font-size: 12px; cursor: pointer; }
.mini-img { width: 44px; height: 44px; border-radius: 8px; overflow: hidden; cursor: zoom-in; background: var(--bg3);
  display: flex; align-items: center; justify-content: center; flex: none; }
.mini-img img { width: 100%; height: 100%; object-fit: cover; display: block; }
.zoom-img { max-width: 92vw; max-height: 84vh; border-radius: 12px; box-shadow: 0 10px 40px rgba(0, 0, 0, .4); cursor: zoom-out; }
.strike { text-decoration: line-through; color: var(--text3); }
.badge { font-size: 11px; border-radius: 10px; padding: 1px 8px; white-space: nowrap; }
.badge.ok { background: rgba(46, 158, 91, .12); color: var(--green); }
.badge.wait { background: rgba(251, 191, 36, .15); color: #b7791f; }
.pager { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.pager .small { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 5px 12px; font-size: 12.5px; cursor: pointer; }
.pager select { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 4px 6px; }
.grow { flex: 1; }
</style>
