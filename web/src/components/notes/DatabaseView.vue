<template>
  <div class="db">
    <div class="dbtabs">
      <button :class="{ on: tab === 'text' }" @click="tab = 'text'">文本表达式</button>
      <button :class="{ on: tab === 'form' }" @click="tab = 'form'">表单条件</button>
      <span class="muted small" style="margin-left:8px">
        字段：title / content / tag / folder / created / updated / bookmarked / words / link / prop.键名
      </span>
    </div>

    <div v-if="tab === 'text'" class="row" style="gap:6px; align-items:flex-start; margin-bottom:8px">
      <textarea v-model="text" rows="3" placeholder='例如：tag = "读书" AND words > 200'
                style="font-family:ui-monospace,Consolas,monospace; flex:1" @keydown.ctrl.enter.prevent="run()" />
      <button class="primary" @click="run()">查询</button>
    </div>

    <div v-else class="formbox">
      <div class="row" style="gap:6px; margin-bottom:6px; align-items:center">
        <span class="muted small">条件之间</span>
        <select v-model="join" style="width:120px">
          <option value="AND">全部满足（且）</option><option value="OR">任一满足（或）</option>
        </select>
        <span class="muted small">（后端同一组条件只支持一种连接方式）</span>
      </div>
      <div v-for="(c, i) in where" :key="i" class="row" style="gap:4px; margin-bottom:5px">
        <span class="muted small" style="width:70px; text-align:right">{{ i === 0 ? '当' : (join === 'OR' ? '或' : '且') }}</span>
        <select v-model="c.field" style="width:150px">
          <option v-for="f in FIELD_OPTS" :key="f.v" :value="f.v">{{ f.t }}</option>
        </select>
        <select v-model="c.op" style="width:72px">
          <option v-for="o in OPS" :key="o.v" :value="o.v">{{ o.t }}</option>
        </select>
        <input v-model="c.value" :placeholder="hintOf(c.field)" style="flex:1">
        <button class="small danger" :disabled="where.length <= 1" @click="where.splice(i, 1)">×</button>
      </div>
      <div class="row" style="gap:6px">
        <button class="small" :disabled="where.length >= 10" @click="addRow">＋ 条件</button>
        <select v-model="sort" style="width:110px">
          <option value="updated">按更新时间</option><option value="created">按创建时间</option>
          <option value="title">按标题</option><option value="words">按字数</option>
        </select>
        <select v-model="order" style="width:88px"><option value="desc">降序</option><option value="asc">升序</option></select>
        <select v-model.number="limit" style="width:100px">
          <option :value="50">50 条</option><option :value="200">200 条</option><option :value="1000">1000 条</option>
        </select>
        <button class="primary" @click="run()">查询</button>
      </div>
    </div>

    <div v-if="err" class="msg err">{{ err }}</div>

    <div class="row" style="gap:8px; margin:6px 0">
      <span class="muted small">共 {{ rows.length }} 条</span>
      <label v-for="d in propDefs" :key="d.id" class="muted small" style="display:flex; align-items:center; gap:3px">
        <input type="checkbox" :checked="cols.has('prop.' + d.key)" @change="toggleCol('prop.' + d.key)">{{ d.label || d.key }}
      </label>
      <button class="small" style="margin-left:auto" @click="copyText" title="把结果导成 Markdown 表格">复制表格</button>
    </div>

    <div class="tblwrap">
      <table class="tbl">
        <thead>
          <tr>
            <th style="width:34%">标题</th><th>文件夹</th><th>标签</th><th class="r">字数</th><th>更新</th>
            <th v-for="k in activePropCols" :key="k">{{ labelOfProp(k) }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.id">
            <td><a href="javascript:;" @click="$emit('open-note', r.id)">{{ r.title || '未命名' }}</a></td>
            <td class="muted">{{ r.folder_path || '' }}</td>
            <td class="muted" style="font-size:11px">{{ tagsOf(r).join(' ') }}</td>
            <td class="r muted">{{ r.word_count || 0 }}</td>
            <td class="muted" style="font-size:11px">{{ String(r.updated_at || '').slice(0, 16) }}</td>
            <td v-for="k in activePropCols" :key="k">
              <input class="cell" :value="propVal(r, k)" @change="setProp(r, k, $event.target.value)">
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="!rows.length" class="empty">{{ ran ? '没有匹配的笔记' : '写个条件点「查询」' }}</div>
    </div>
  </div>
</template>

<script setup>
// 数据库视图（v1.9.41）：Dataview 条件的两种写法 + 结果表格 + 属性列内联编辑。
//
// 只读 + 改属性，不改正文 —— 表格里改正文很容易误伤（一行看不全内容），正文编辑交给编辑器。
import { ref, computed } from 'vue';
import { api } from '../../api';
import { copyText as clip } from '../../utils/noteShare';

const props = defineProps({
  folders: { type: Array, default: () => [] },
  propDefs: { type: Array, default: () => [] },
});
const emit = defineEmits(['open-note']);

const tab = ref('text');
const text = ref('');
const where = ref([{ field: 'tag', op: '=', value: '' }]);
const join = ref('AND');
const sort = ref('updated');
const order = ref('desc');
const limit = ref(200);
const rows = ref([]);
const err = ref('');
const ran = ref(false);

const OPS = [
  { v: '=', t: '等于 =' }, { v: '!=', t: '不等于 ≠' }, { v: '~', t: '包含 ~' },
  { v: '>', t: '大于 >' }, { v: '<', t: '小于 <' }, { v: '>=', t: '≥' }, { v: '<=', t: '≤' },
];
const FIELD_OPTS = computed(() => [
  { v: 'title', t: '标题 title' }, { v: 'content', t: '正文 content' }, { v: 'tag', t: '标签 tag' },
  { v: 'folder', t: '文件夹 folder' }, { v: 'created', t: '创建时间 created' }, { v: 'updated', t: '更新时间 updated' },
  { v: 'words', t: '字数 words' }, { v: 'bookmarked', t: '已收藏 bookmarked' }, { v: 'link', t: '链接到 link' },
  ...props.propDefs.map((d) => ({ v: 'prop.' + d.key, t: `属性 ${d.label || d.key}` })),
]);
const hintOf = (f) => (f === 'bookmarked' ? '1 / 0' : f === 'words' ? '数字' : f?.startsWith('prop.') ? '值' : '文本或 2026-01-01');

const cols = ref(new Set());
const activePropCols = computed(() => Array.from(cols.value).filter((k) => k.startsWith('prop.')));
function toggleCol(k) { const s = new Set(cols.value); s.has(k) ? s.delete(k) : s.add(k); cols.value = s; }
const labelOfProp = (k) => { const key = k.replace('prop.', ''); const d = props.propDefs.find((x) => x.key === key); return d ? (d.label || d.key) : key; };

function addRow() { where.value.push({ field: 'title', op: '~', value: '' }); }

async function run() {
  err.value = '';
  let body;
  if (tab.value === 'text') {
    body = { text: text.value, sort: sort.value, order: order.value, limit: limit.value };
  } else {
    // 空值的条件直接报错而不是悄悄丢掉：用户以为筛了「标签 = 空」，其实是想筛别的
    if (where.value.some((c) => String(c.value).trim() === '')) { err.value = '每个条件的值都不能为空'; return; }
    body = { where: where.value.map((c) => ({ field: c.field, op: c.op, value: c.value })), join: join.value, sort: sort.value, order: order.value, limit: limit.value };
  }
  try {
    const d = await api.post('/notes/query', body);
    rows.value = d.rows || [];
    ran.value = true;
  } catch (e) { err.value = e.message; rows.value = []; ran.value = true; }
}

const tagsOf = (r) => (Array.isArray(r.tags) ? r.tags : String(r.tags || '').split(',')).map((x) => String(x).trim()).filter(Boolean);
function propVal(r, k) {
  let p = r.props;
  if (typeof p === 'string') { try { p = JSON.parse(p || '{}'); } catch { p = {}; } }
  const v = (p || {})[k.replace('prop.', '')];
  return v === undefined || v === null ? '' : String(v);
}
async function setProp(r, k, value) {
  const key = k.replace('prop.', '');
  let p = r.props;
  if (typeof p === 'string') { try { p = JSON.parse(p || '{}'); } catch { p = {}; } }
  const next = { ...(p || {}), [key]: value };
  try {
    // 必须把标题一起回传：只传 props 的话后端会按正文重算标题，手工改过的标题会被冲掉
    await api.put(`/notes/${r.id}`, { title: r.title, props: next });
    r.props = next;
  } catch (e) { alert('保存失败：' + e.message); }
}

async function copyText() {
  const head = ['标题', '文件夹', '标签', '字数', '更新', ...activePropCols.value.map(labelOfProp)];
  const lines = [head.join(' | '), head.map(() => '---').join(' | ')];
  for (const r of rows.value) {
    lines.push([r.title || '未命名', r.folder_path || '', tagsOf(r).join(' '), r.word_count || 0,
      String(r.updated_at || '').slice(0, 16), ...activePropCols.value.map((k) => propVal(r, k))].join(' | '));
  }
  const ok = await clip(lines.join('\n'));
  if (!ok) alert('复制失败，请手动选中表格');
}
defineExpose({ run });
</script>

<style scoped>
.db { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.dbtabs { display: flex; gap: 4px; align-items: center; margin-bottom: 8px; flex-wrap: wrap; }
.dbtabs button { font-size: 12px; padding: 3px 10px; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--text2); cursor: pointer; }
.dbtabs button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
.formbox { border: 1px solid var(--border); border-radius: 8px; padding: 8px; margin-bottom: 8px; }
.tblwrap { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
.tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.tbl th, .tbl td { padding: 5px 8px; border-bottom: 1px solid var(--border); text-align: left; white-space: nowrap; }
.tbl th { position: sticky; top: 0; background: var(--bg2); font-weight: 600; font-size: 11.5px; color: var(--text2); z-index: 1; }
.tbl td.r, .tbl th.r { text-align: right; }
.tbl a { color: var(--accent); text-decoration: none; }
.tbl a:hover { text-decoration: underline; }
.cell { width: 110px; font-size: 12px; padding: 2px 5px; }
</style>
