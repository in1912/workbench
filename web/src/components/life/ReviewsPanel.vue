<template>
  <div class="split">
    <!-- 左：复盘编辑器 -->
    <div class="card">
      <h3>
        {{ editing ? '编辑复盘' : '写复盘' }}
        <button v-if="editing" class="small" @click="reset">写新的</button>
      </h3>
      <div class="row" style="margin-bottom:10px; flex-wrap:wrap">
        <select v-model="form.type" style="width:104px">
          <option v-for="(lab, k) in REVIEW_LABEL" :key="k" :value="k">{{ lab }}</option>
        </select>
        <input v-model="form.period_key" placeholder="周期键，留空自动按今天算" class="grow" />
      </div>
      <div class="muted" style="margin:-4px 0 10px">
        周期键留空就按类型和今天自动生成（{{ REVIEW_LABEL[form.type] }} → {{ previewKey }}）。同一个周期再写就是修改，不会多出一条。
      </div>

      <label class="fl">做得好</label>
      <textarea v-model="form.did_well" rows="2" placeholder="哪几件事推进了、为什么有效"></textarea>
      <label class="fl">做得不好</label>
      <textarea v-model="form.did_bad" rows="2" placeholder="哪里卡住、浪费在哪"></textarea>
      <label class="fl">学到了什么</label>
      <textarea v-model="form.learned" rows="2" placeholder="把经历提炼成一句话经验"></textarea>
      <label class="fl">下一步动作</label>
      <textarea v-model="form.next_action" rows="2" placeholder="写具体到可以直接执行的动作——这段会一键沉淀成 SOP"></textarea>

      <div class="row" style="margin:10px 0">
        <span class="small muted">心情</span>
        <select v-model.number="form.mood" style="width:88px">
          <option :value="null">—</option>
          <option v-for="n in 5" :key="n" :value="n">{{ n }}</option>
        </select>
        <span class="small muted">对齐度</span>
        <select v-model.number="form.alignment" style="width:88px">
          <option :value="null">—</option>
          <option v-for="n in 5" :key="n" :value="n">{{ n }}</option>
        </select>
      </div>
      <div class="row">
        <span class="grow"></span>
        <button class="primary" @click="save">{{ editing ? '保存修改' : '保存复盘' }}</button>
      </div>
      <div class="muted" style="margin-top:8px">
        「对齐度」问的是：这段时间做的事，跟你的目标是同一个方向吗？低分往往比做得少更值得停下来看。
      </div>
    </div>

    <!-- 右：历史 + SOP -->
    <div>
      <div class="card" style="margin-bottom:14px">
        <h3>复盘历史
          <select v-model="listType" class="small" style="width:100px; padding:2px 6px" @change="loadReviews">
            <option value="">全部</option>
            <option v-for="(lab, k) in REVIEW_LABEL" :key="k" :value="k">{{ lab }}</option>
          </select>
        </h3>
        <div v-if="!reviews.length" class="empty">还没有复盘记录</div>
        <div v-for="r in reviews" :key="r.id" class="list-item">
          <span class="t">
            <span class="badge blue">{{ REVIEW_LABEL[r.type] || r.type }}</span>
            {{ r.period_key }}
          </span>
          <span class="meta">
            <span v-if="r.mood" class="muted" title="心情">心 {{ r.mood }}</span>
            <span v-if="r.alignment" class="muted" title="与目标的对齐度">齐 {{ r.alignment }}</span>
            <button class="small" @click="edit(r)">编辑</button>
            <button class="small" title="把「下一步动作」沉淀成 SOP" @click="toSop(r)">→ SOP</button>
            <button class="small danger" @click="remove(r)">删</button>
          </span>
        </div>
      </div>

      <div class="card">
        <h3>SOP 库 <span class="muted" style="font-weight:400">{{ sops.length }} 条</span></h3>
        <div v-if="!sops.length" class="empty">
          还没有 SOP
          <div class="muted" style="margin-top:6px">复盘写多了，把它们沉淀成可复用的步骤，下次遇到同类事直接照着走。</div>
        </div>
        <div v-for="s in sops" :key="s.id" class="sop">
          <div class="row">
            <input v-model="s.scenario" class="inline-title grow" @change="saveSop(s)" />
            <span class="muted" v-if="s.use_count" :title="'最后使用 ' + (s.last_used_at || '')">用过 {{ s.use_count }} 次</span>
            <button class="small" @click="useSop(s)">用一次</button>
            <button class="small danger" @click="removeSop(s)">删</button>
          </div>
          <textarea v-model="s.steps" rows="2" style="margin-top:6px; width:100%"
                    placeholder="步骤，一行一步" @change="saveSop(s)"></textarea>
        </div>
        <div class="row" style="margin-top:12px">
          <input v-model="newSop" class="grow" placeholder="新建 SOP：什么场景？回车即建" @keyup.enter="addSop" />
          <button class="small" :disabled="!newSop.trim()" @click="addSop">添加</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../../api';
import { REVIEW_LABEL } from './lifeUtils';

const emit = defineEmits(['toast']);
const reviews = ref([]);
const sops = ref([]);
const listType = ref('');
const editing = ref(null);
const newSop = ref('');
const form = ref(blank());

function blank() {
  return { type: 'week', period_key: '', did_well: '', did_bad: '', learned: '', next_action: '', mood: null, alignment: null };
}
function reset() { editing.value = null; form.value = blank(); }

// 周期键预览：与后端 lifeService.periodKey 同一套规则（跨年 ISO 周已在那侧处理）
const previewKey = computed(() => {
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  const y = d.getFullYear(), m = d.getMonth() + 1;
  switch (form.value.type) {
    case 'day': return `${y}-${p2(m)}-${p2(d.getDate())}`;
    case 'month': return `${y}-${p2(m)}`;
    case 'quarter': return `${y}Q${Math.ceil(m / 3)}`;
    case 'year': return String(y);
    default: return '（周键按 ISO 周，保存后由服务端算）';
  }
});

async function loadReviews() {
  try {
    reviews.value = await api.get('/life/reviews' + (listType.value ? '?type=' + listType.value : ''));
  } catch (e) { emit('toast', e.message, 'err'); }
}
async function loadSops() {
  try { sops.value = await api.get('/life/sops'); } catch (e) { emit('toast', e.message, 'err'); }
}

function edit(r) {
  editing.value = r.id;
  form.value = { ...r, mood: r.mood === null ? null : Number(r.mood), alignment: r.alignment === null ? null : Number(r.alignment) };
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function save() {
  try {
    const r = await api.post('/life/reviews', form.value);
    emit('toast', r.created ? '复盘已保存' : '该周期已有复盘，已更新');
    reset();
    await loadReviews();
  } catch (e) { emit('toast', e.message, 'err'); }
}

async function remove(r) {
  if (!confirm(`删除 ${REVIEW_LABEL[r.type] || ''} ${r.period_key}？`)) return;
  try {
    await api.del(`/life/reviews/${r.id}`);
    if (editing.value === r.id) reset();
    await loadReviews();
  } catch (e) { emit('toast', e.message, 'err'); }
}

async function toSop(r) {
  if (!String(r.next_action || '').trim() && !confirm('这条复盘的「下一步动作」是空的，沉淀出来的 SOP 步骤也会是空的。继续吗？')) return;
  try {
    await api.post(`/life/reviews/${r.id}/to-sop`, {});
    await loadSops();
    emit('toast', '已沉淀成 SOP');
  } catch (e) { emit('toast', e.message, 'err'); }
}

async function addSop() {
  const t = newSop.value.trim();
  if (!t) return;
  try {
    await api.post('/life/sops', { scenario: t });
    newSop.value = '';
    await loadSops();
  } catch (e) { emit('toast', e.message, 'err'); }
}
async function saveSop(s) {
  try { await api.put(`/life/sops/${s.id}`, { scenario: s.scenario, steps: s.steps }); }
  catch (e) { emit('toast', e.message, 'err'); }
}
async function useSop(s) {
  try {
    await api.post(`/life/sops/${s.id}/use`, {});
    await loadSops();
    emit('toast', '已记录一次使用');
  } catch (e) { emit('toast', e.message, 'err'); }
}
async function removeSop(s) {
  if (!confirm(`删除 SOP「${s.scenario}」？`)) return;
  try { await api.del(`/life/sops/${s.id}`); await loadSops(); }
  catch (e) { emit('toast', e.message, 'err'); }
}

onMounted(() => { loadReviews(); loadSops(); });
</script>

<style scoped>
.split { display: grid; grid-template-columns: minmax(320px, 1fr) minmax(320px, 1fr); gap: 14px; align-items: start; }
@media (max-width: 900px) { .split { grid-template-columns: 1fr; } }
.fl { display: block; font-size: 12.5px; color: var(--text2); margin: 8px 0 3px; }
textarea { width: 100%; resize: vertical; }
.inline-title { background: transparent; border: 1px solid transparent; border-radius: 6px; padding: 2px 5px; color: inherit; font-size: 13px; }
.inline-title:hover, .inline-title:focus { border-color: var(--border); }
.sop { border-top: 1px solid var(--border); padding: 10px 0; }
.sop:first-of-type { border-top: none; }
</style>
