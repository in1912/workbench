<template>
  <div class="wish">
    <!-- ============ 上：看板框（产品卡片，横向滚动不向下延伸） ============ -->
    <div class="card kanban">
      <div class="kb-head">
        <h3 style="margin:0">心愿看板</h3>
        <span class="muted" style="font-size:12px">每天最多打卡 {{ dailyLimit }} 次（每个产品每天 1 次）· 今日已打卡 {{ myTodayCount }}/{{ dailyLimit }} · 心愿值 = 全家累计打卡次数 · 按心愿值从高到低</span>
      </div>
      <div class="kb-scroll">
        <div v-if="!products.length" class="empty" style="padding:24px 12px">暂无心愿产品{{ canManage ? '，请在下方「心愿卡设置」添加' : '' }}</div>
        <div v-for="p in kanbanList" :key="p.id" class="kb-card">
          <div class="kb-img" @click="zoom(p)" :title="p.name">
            <img v-if="p.image_id" :src="imgUrl(p.image_id)" alt="" />
            <span v-else class="kb-ph">🎁</span>
            <span v-if="imgCount(p) > 1" class="multi" :title="`共 ${imgCount(p)} 张图，点击可放大左右翻页`">⧉{{ imgCount(p) }}</span>
          </div>
          <div class="kb-name" :title="p.name">{{ p.name }}</div>
          <div class="kb-desc" :title="p.description">{{ p.description || '—' }}</div>
          <div class="kb-prices">
            <span class="mk">市场 ¥{{ fmt(p.market_price) }}</span>
            <span class="fam">兑换 ¥{{ fmt(p.family_price) }}</span>
          </div>
          <div class="kb-foot">
            <span class="val">❤ 心愿值 {{ p.wish_value }}</span>
            <button class="ck-btn" :class="{ done: p.checked_today }" :disabled="p.checked_today || myTodayCount >= dailyLimit"
              :title="p.checked_today ? '该产品今天已打过卡' : myTodayCount >= dailyLimit ? '今日打卡次数已用完' : '打卡 +1'"
              @click="checkin(p)">
              {{ p.checked_today ? '已打卡' : '打卡' }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 中：列表框（分页 15/30/50） ============ -->
    <div class="card list">
      <h3>心愿列表</h3>
      <div class="tbl-wrap">
        <table class="tbl">
          <thead>
            <tr>
              <th>序号</th><th>图片</th><th>名称</th><th>心愿值</th><th>说明</th>
              <th>市场售价</th><th>家庭兑换价</th><th>备注</th><th>上传时间</th><th v-if="canManage"></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(p, i) in pageList" :key="p.id">
              <td>{{ (page - 1) * pageSize + i + 1 }}</td>
              <td><div class="mini-img" @click="zoom(p)" :title="p.name"><img v-if="p.image_id" :src="imgUrl(p.image_id)" alt="" /><span v-else>🎁</span><span v-if="imgCount(p) > 1" class="multi">⧉{{ imgCount(p) }}</span></div></td>
              <td>{{ p.name }}</td>
              <td>❤ {{ p.wish_value }}</td>
              <td class="desc" :title="p.description">{{ p.description || '—' }}</td>
              <td>¥{{ fmt(p.market_price) }}</td>
              <td>¥{{ fmt(p.family_price) }}</td>
              <td class="desc" :title="p.note">{{ p.note || '—' }}</td>
              <td>{{ p.created_at }}</td>
              <td v-if="canManage" class="ops">
                <button class="small" @click="edit(p)">编辑</button>
                <button class="small" @click="remove(p)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!products.length" class="empty">暂无产品</div>
      </div>
      <div class="row foot">
        <span class="muted" style="font-size:12px">共 {{ products.length }} 条</span>
        <span class="grow"></span>
        <button class="small" :disabled="page <= 1" @click="page--">‹ 上一页</button>
        <span class="muted" style="font-size:12px">{{ page }} / {{ totalPages }}</span>
        <button class="small" :disabled="page >= totalPages" @click="page++">下一页 ›</button>
        <select v-model.number="pageSize" title="每页条数">
          <option :value="15">15 行</option><option :value="30">30 行</option><option :value="50">50 行</option>
        </select>
      </div>
    </div>

    <!-- ============ 下：设置框（单独权限：wishset） ============ -->
    <div v-if="canManage" class="card setup">
      <h3>{{ form.id ? `编辑产品 #${form.id}` : '心愿卡设置' }} <span class="muted" style="font-size:12px; font-weight:400">上传产品图片与价格信息，全家即可打卡攒心愿值</span></h3>
      <div class="setup-grid">
        <div class="up" @click="pickImg" title="点击选择产品图片（可一次多选）">
          <img v-if="form.images.length" :src="imgUrl(form.images[0])" alt="" />
          <span v-else>🖼 点击上传图片<br /><small>可一次多选</small></span>
          <input ref="imgInput" type="file" accept="image/*" multiple style="display:none" @change="onImgChange" />
        </div>
        <div class="fields">
          <div class="row" style="flex-wrap:wrap; gap:8px">
            <input v-model="form.name" placeholder="产品名称" style="width:200px" />
            <input v-model="form.market_price" type="number" min="0" step="0.01" placeholder="市场售价（元）" style="width:150px" />
            <input v-model="form.family_price" type="number" min="0" step="0.01" placeholder="家庭兑换价（元）" style="width:150px" />
          </div>
          <input v-model="form.description" placeholder="说明（看板卡片上显示的简介）" style="width:100%" />
          <div class="row" style="flex-wrap:wrap; gap:8px">
            <input v-model="form.note" placeholder="备注（可选）" class="grow" />
            <button class="primary" @click="save">{{ form.id ? '保存修改' : '登记产品' }}</button>
            <button v-if="form.id" class="small" @click="resetForm">取消编辑</button>
          </div>
        </div>
      </div>
      <div v-if="form.images.length" class="thumbs">
        <div v-for="(id, i) in form.images" :key="id" class="th" :class="{ cover: i === 0 }">
          <img :src="imgUrl(id)" title="点击设为封面" @click="setCover(i)" />
          <span v-if="i === 0" class="cv">封面</span>
          <button class="rm" title="移除这张（不删图库原图）" @click="rmImg(i)">✕</button>
        </div>
        <span class="muted" style="font-size:12px; align-self:center">点缩略图设为封面，✕ 移除（最多 9 张，看板显示封面）</span>
      </div>
    </div>

    <!-- 图片放大查看（多图左右切换：屏幕 ‹› 按钮 / 键盘 ←→ / 手机滑动） -->
    <div v-if="zoomImg" class="modal-backdrop" @click.self="guardClose"
         @touchstart.passive="onTouchStart" @touchend.passive="onTouchEnd">
      <img class="zoom" :src="zoomImg" alt="" @click="guardClose" />
      <template v-if="zoomList.length > 1">
        <button class="znv prev" @click="zoomBy(-1)">‹</button>
        <button class="znv next" @click="zoomBy(1)">›</button>
        <span class="zct">{{ zoomIdx + 1 }} / {{ zoomList.length }}</span>
      </template>
    </div>
  </div>
</template>

<script setup>
// 心愿卡：产品看板打卡（每人每天 2 次、每产品 1 次）+ 产品列表 + 产品设置（wishset 受限权限）。
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { api } from '../api';
import { canTab } from '../tabs';

const canManage = canTab('learning', 'wishset');

const products = ref([]);
const dailyLimit = ref(2);
const myTodayCount = ref(0);

// ---------- 列表分页（15/30/50，客户端分页） ----------
const page = ref(1);
const pageSize = ref(15);
const totalPages = computed(() => Math.max(1, Math.ceil(products.value.length / pageSize.value)));
const pageList = computed(() => products.value.slice((Math.min(page.value, totalPages.value) - 1) * pageSize.value, Math.min(page.value, totalPages.value) * pageSize.value));
watch(pageSize, () => { page.value = 1; });

// 看板按心愿值降序（同值保持原顺序：新登记在前）；下方列表仍按登记顺序
const kanbanList = computed(() => [...products.value].sort((a, b) => b.wish_value - a.wish_value));

async function load() {
  try {
    const r = await api.get('/wish/products');
    products.value = r.products || [];
    dailyLimit.value = r.daily_limit || 2;
    myTodayCount.value = r.my_today_count || 0;
    if (page.value > totalPages.value) page.value = 1;
  } catch { products.value = []; }
}

async function checkin(p) {
  try {
    const r = await api.post('/wish/checkin', { product_id: p.id });
    myTodayCount.value = r.my_today_count ?? myTodayCount.value + 1;
    await load();
  } catch (e) { alert(e.message); }
}

// ---------- 设置（登记/编辑/删除；多图上传 + 封面管理） ----------
const form = ref({ id: 0, name: '', description: '', market_price: '', family_price: '', note: '', images: [] });
const imgInput = ref(null);
const imgBusy = ref(0); // 待完成上传计数（多张并发）
function pickImg() { imgInput.value?.click(); }
function onImgChange(e) {
  const files = [...(e.target.files || [])]; // FileList 是活对象，先快照再清空
  e.target.value = '';
  if (!files.length) return;
  if (form.value.images.length + files.length > 9) alert('最多保留 9 张图片，多出的会忽略');
  imgBusy.value += files.length;
  for (const f of files) {
    const fr = new FileReader();
    fr.onload = async () => {
      try {
        const r = await api.post('/family-images', { data: fr.result });
        if (form.value.images.length < 9) form.value.images.push(r.id);
      } catch (err) { alert('图片上传失败：' + err.message); }
      imgBusy.value--;
    };
    fr.onerror = () => { imgBusy.value--; alert('图片读取失败'); };
    fr.readAsDataURL(f);
  }
}
function setCover(i) {
  if (i === 0) return;
  const [id] = form.value.images.splice(i, 1);
  form.value.images.unshift(id); // 封面 = 第一张
}
function rmImg(i) { form.value.images.splice(i, 1); }
function edit(p) {
  form.value = { id: p.id, name: p.name, description: p.description || '', market_price: p.market_price, family_price: p.family_price, note: p.note || '', images: [...(p.images || [])] };
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
}
function resetForm() { form.value = { id: 0, name: '', description: '', market_price: '', family_price: '', note: '', images: [] }; }
async function save() {
  if (!form.value.name.trim()) { alert('请填写产品名称'); return; }
  if (imgBusy.value) { alert('图片还在上传中，请稍候'); return; }
  const body = {
    name: form.value.name.trim(),
    description: form.value.description.trim(),
    note: form.value.note.trim(),
    market_price: Number(form.value.market_price) || 0,
    family_price: Number(form.value.family_price) || 0,
    image_ids: form.value.images,
    cover_id: form.value.images[0] || 0,
  };
  try {
    if (form.value.id) await api.put(`/wish/manage/${form.value.id}`, body);
    else await api.post('/wish/manage', body);
    resetForm();
    await load();
  } catch (e) { alert('保存失败：' + e.message); }
}
async function remove(p) {
  if (!confirm(`删除心愿产品「${p.name}」？其打卡记录会一并删除。`)) return;
  try { await api.del(`/wish/manage/${p.id}`); await load(); }
  catch (e) { alert('删除失败：' + e.message); }
}

// ---------- 图片（放大查看：多图左右切换，键盘 ←/→/Esc） ----------
const token = () => encodeURIComponent(localStorage.getItem('wb_token') || '');
const imgUrl = (id) => `/api/family-images/${id}?token=${token()}`;
const zoomList = ref([]);
const zoomIdx = ref(0);
const zoomImg = computed(() => (zoomList.value.length ? imgUrl(zoomList.value[zoomIdx.value]) : null));
function zoom(p) {
  const list = p.images && p.images.length ? p.images : p.image_id ? [p.image_id] : [];
  if (!list.length) return;
  zoomList.value = list;
  zoomIdx.value = 0;
}
function zoomBy(d) {
  if (!zoomList.value.length) return;
  zoomIdx.value = (zoomIdx.value + d + zoomList.value.length) % zoomList.value.length;
}
function onKey(e) {
  if (!zoomList.value.length) return;
  if (e.key === 'Escape') zoomList.value = [];
  else if (e.key === 'ArrowLeft') zoomBy(-1);
  else if (e.key === 'ArrowRight') zoomBy(1);
}
// 手机触屏滑动翻页（左滑下一张 / 右滑上一张）。滑动距离足够时吞掉紧随的 click 事件，
// 避免一次滑动被当成「点击关闭」误关画廊（部分 webview 滑动后仍派发 click）。
let touchX = null, touchY = null, swipeGuard = 0, swipeTimer = null;
function onTouchStart(e) { const t = e.touches[0]; touchX = t.clientX; touchY = t.clientY; }
function onTouchEnd(e) {
  if (touchX === null || zoomList.value.length < 2) { touchX = null; return; }
  const t = e.changedTouches[0];
  const dx = t.clientX - touchX, dy = t.clientY - touchY;
  touchX = null;
  if (Math.abs(dx) > 36 && Math.abs(dx) > Math.abs(dy) * 1.2) {
    swipeGuard = 1;
    clearTimeout(swipeTimer);
    swipeTimer = setTimeout(() => { swipeGuard = 0; }, 500);
    zoomBy(dx < 0 ? 1 : -1);
  }
}
function guardClose() { if (swipeGuard) { swipeGuard = 0; return; } zoomList.value = []; }
const imgCount = (p) => (p.images && p.images.length ? p.images.length : p.image_id ? 1 : 0);
const fmt = (n) => { const v = Number(n) || 0; return Number.isInteger(v) ? String(v) : v.toFixed(2); };

onMounted(() => {
  load();
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<style scoped>
.kanban { padding: 14px 16px; margin-bottom: 12px; }
.kb-head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
.kb-scroll { display: flex; gap: 12px; overflow-x: auto; overflow-y: hidden; padding-bottom: 6px; }
.kb-card { flex: 0 0 172px; width: 172px; border: 1px solid var(--border); border-radius: 12px; padding: 10px; background: var(--bg2); }
.kb-img { position: relative; width: 150px; height: 150px; border-radius: 10px; overflow: hidden; cursor: zoom-in; background: var(--bg3);
  display: flex; align-items: center; justify-content: center; }
.multi { position: absolute; right: 5px; bottom: 5px; background: rgba(0, 0, 0, 0.55); color: #fff; font-size: 11px;
  border-radius: 8px; padding: 1px 6px; pointer-events: none; z-index: 1; }
.kb-img img { width: 100%; height: 100%; object-fit: cover; }
.kb-ph { font-size: 40px; opacity: .5; }
.kb-name { font-weight: 600; font-size: 13.5px; margin-top: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kb-desc { font-size: 12px; color: var(--text3); height: 32px; line-height: 16px; margin-top: 3px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.kb-prices { display: flex; justify-content: space-between; gap: 6px; margin-top: 6px; font-size: 12px; }
.kb-prices .mk { color: var(--text3); text-decoration: line-through; }
.kb-prices .fam { color: var(--red, #e5484d); font-weight: 700; }
.kb-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; }
.kb-foot .val { font-size: 12px; color: var(--accent, #4f7cf7); font-weight: 600; }
.ck-btn { border: none; border-radius: 8px; background: var(--accent); color: #fff; padding: 5px 14px; font-size: 12.5px; cursor: pointer; }
.ck-btn:hover { filter: brightness(1.08); }
.ck-btn:disabled { background: var(--bg3); color: var(--text3); cursor: default; }
.ck-btn.done { background: rgba(46, 158, 91, .15); color: var(--green, #2e9e5b); }
.list { padding: 16px 18px; margin-bottom: 12px; }
.list h3 { margin-bottom: 10px; }
.tbl-wrap { overflow-x: auto; }
.tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.tbl th { text-align: left; font-weight: 500; color: var(--text3); padding: 6px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.tbl td { padding: 7px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
.mini-img { position: relative; width: 44px; height: 44px; border-radius: 8px; overflow: hidden; cursor: zoom-in; background: var(--bg3);
  display: flex; align-items: center; justify-content: center; font-size: 18px; }
.mini-img .multi { right: 0; bottom: 0; font-size: 10px; padding: 0 5px; border-radius: 8px 0 8px 0; }
.mini-img img { width: 100%; height: 100%; object-fit: cover; }
.desc { max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
.ops { white-space: nowrap; }
.foot { margin-top: 10px; align-items: center; gap: 8px; }
.setup { padding: 16px 18px; }
.setup h3 { margin-bottom: 12px; }
.setup-grid { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
.up { flex: 0 0 150px; width: 150px; height: 150px; border: 1.5px dashed var(--border); border-radius: 12px; overflow: hidden;
  cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 13px; color: var(--text3); background: var(--bg2); }
.up:hover { border-color: var(--accent); }
.up img { width: 100%; height: 100%; object-fit: cover; }
.thumbs { display: flex; align-items: center; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.th { position: relative; width: 64px; height: 64px; border-radius: 8px; overflow: visible; }
.th img { width: 64px; height: 64px; object-fit: cover; border-radius: 8px; border: 2px solid var(--border); cursor: pointer; display: block; }
.th.cover img { border-color: var(--accent, #4f7cf7); }
.th .cv { position: absolute; left: 2px; top: 2px; font-size: 10px; background: var(--accent, #4f7cf7); color: #fff; border-radius: 6px; padding: 0 5px; pointer-events: none; }
.th .rm { position: absolute; right: -7px; top: -7px; width: 18px; height: 18px; border-radius: 50%; border: none; background: #e5484d; color: #fff; font-size: 11px; line-height: 18px; padding: 0; cursor: pointer; }
.znv { position: fixed; top: 50%; transform: translateY(-50%); width: 44px; height: 64px; border: none; border-radius: 10px; background: rgba(0, 0, 0, .45); color: #fff; font-size: 26px; cursor: pointer; }
.znv.prev { left: 18px; }
.znv.next { right: 18px; }
.zct { position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%); background: rgba(0, 0, 0, .5); color: #fff; border-radius: 12px; padding: 3px 14px; font-size: 13px; }
.fields { flex: 1; min-width: 300px; display: flex; flex-direction: column; gap: 8px; }
.small { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 6px 14px; font-size: 13px; cursor: pointer; }
.grow { flex: 1; }
.muted { color: var(--text3); }
.zoom { max-width: 92vw; max-height: 84vh; border-radius: 12px; box-shadow: 0 10px 40px rgba(0, 0, 0, .4); }
</style>
