<template>
  <div>
    <div class="row" style="align-items:center; margin-bottom:12px">
      <h2 class="page-title" style="margin:0">笔记</h2>
      <div class="tabs" style="margin:0 0 0 16px">
        <button :class="{active: tab==='text'}" @click="tab='text'">文本</button>
        <button :class="{active: tab==='rec'}" @click="tab='rec'; loadRecs()">🎙 录音</button>
      </div>
      <div class="row" style="margin-left:auto; gap:8px; align-items:center">
        <template v-if="tab==='text' && current?.id">
          <button class="small" @click="shareOpen = true">🔗 分享</button>
          <button class="small" @click="manageOpen = true">
            分享 {{ shareStats.link_count }} 条 · 访问 {{ shareStats.view_total }} 次
          </button>
        </template>
        <button class="small" @click="catModal = true">分类管理</button>
      </div>
    </div>

    <!-- ===== 文本 tab ===== -->
    <div v-if="tab==='text'" class="grid" style="grid-template-columns:250px 1fr">
      <div class="card notes-list" style="max-height:calc(100vh - 170px); overflow-y:auto">
        <div class="row" style="margin-bottom:10px">
          <button class="primary small" @click="createNote">＋ 新建</button>
          <select v-model="filterCat" @change="load()" class="small" style="width:auto; padding:4px 8px">
            <option value="">全部分类</option>
            <option v-for="c in cats" :key="c.id" :value="c.name">{{ catLabel(c.name) }}</option>
          </select>
        </div>
        <input v-model="kw" @input="debouncedLoad" placeholder="搜索标题 / 正文 / 标签" class="small" style="margin-bottom:10px">
        <div v-for="n in notes" :key="n.id" class="list-item" :class="{active: current?.id===n.id}"
             style="cursor:pointer; border-radius:8px; padding:8px 10px"
             @click="openNote(n)">
          <div class="grow">
            <div class="t">{{ n.record_id ? '🎙 ' : '' }}{{ n.title || '未命名' }}</div>
            <div class="meta">{{ catLabel(n.category) }} · {{ n.updated_at?.slice(5,16) }}</div>
            <div v-if="splitTags(n.tags).length" class="meta" style="margin-top:3px">
              <span v-for="t in splitTags(n.tags)" :key="t" class="tag" style="font-size:10.5px; margin-right:4px">{{ t }}</span>
            </div>
          </div>
        </div>
        <div v-if="!notes.length" class="empty">还没有笔记</div>
      </div>

      <div class="card">
        <template v-if="current">
          <div class="row" style="margin-bottom:12px; flex-wrap:wrap; gap:6px">
            <select v-model="current.category" style="width:130px">
              <option v-for="c in cats" :key="c.id" :value="c.name">{{ catLabel(c.name) }}</option>
            </select>
            <button v-if="current.record_id" class="small" @click="$router.push(`/notes/rec/${current.record_id}`)">🎙 打开录音页</button>
            <button class="primary" @click="save">保存</button>
            <button :disabled="!current.id" @click="downloadMd">下载 MD</button>
            <button :disabled="!current.id" @click="downloadHtml">下载 HTML</button>
            <button class="danger" @click="del">删除</button>
          </div>

          <div class="tabs" style="margin-bottom:8px">
            <button :class="{active: mode==='edit'}" @click="mode='edit'">编辑</button>
            <button :class="{active: mode==='preview'}" @click="mode='preview'">预览</button>
            <button v-if="current.content" class="small" style="margin-left:auto" :disabled="!current.id || aiLoading" @click="aiSummarize">
              {{ aiLoading ? 'AI 总结中…' : 'AI 概要 + 关键词' }}
            </button>
          </div>

          <textarea v-if="mode==='edit'" v-model="current.content" rows="20" placeholder="支持 Markdown 语法；用 [[另一篇笔记的标题]] 建立双向链接" style="font-family:ui-monospace,Consolas,monospace"></textarea>
          <div v-else class="markdown-body" v-html="rendered"></div>

          <div v-if="current.summary" class="card" style="margin-top:10px; background:var(--bg3); border:none">
            <b>概要</b>
            <div style="margin-top:6px">{{ current.summary }}</div>
            <div v-if="current.keywords" class="muted" style="font-size:12px; margin-top:6px">关键词：{{ current.keywords }}</div>
          </div>

          <div v-if="links.out.length || links.in.length" class="card" style="margin-top:10px; background:var(--bg3); border:none">
            <div v-if="links.out.length" style="font-size:12.5px">
              <b>链接到：</b>
              <a v-for="l in links.out" :key="'o'+l.id" href="javascript:;" @click="openById(l.id)" style="margin-right:10px">{{ l.title }}</a>
            </div>
            <div v-if="links.in.length" style="font-size:12.5px; margin-top:4px">
              <b>被引用：</b>
              <a v-for="l in links.in" :key="'i'+l.id" href="javascript:;" @click="openById(l.id)" style="margin-right:10px">{{ l.title }}</a>
            </div>
          </div>
        </template>
        <div v-else class="empty">选择或新建一篇笔记</div>
      </div>
    </div>

    <!-- ===== 录音 tab ===== -->
    <div v-if="tab==='rec'" class="card">
      <div class="row" style="margin-bottom:12px">
        <button class="primary" @click="$router.push('/notes/rec/')">＋ 新增录音</button>
        <button class="small" @click="loadRecs">刷新</button>
        <span class="muted" style="font-size:12px">在这里录的音，转写完成后会自动生成一篇笔记（同时出现在「文本」列表里）</span>
      </div>
      <div v-for="r in recs" :key="r.id" class="list-item" style="cursor:pointer; border-radius:8px; padding:10px"
           @click="$router.push(`/notes/rec/${r.id}`)">
        <div class="grow">
          <div class="t">🎙 {{ r.started_at || ('录音 #' + r.id) }}</div>
          <div class="meta">
            {{ r.fmt?.toUpperCase() }} · {{ fmtDur(r.duration_sec) }} · {{ fmtSize(r.file_size) }} ·
            <b :style="{color: recStatusColor(r)}">{{ recStatusText(r) }}</b>
            <span v-if="r.has_text"> · {{ r.transcript_chars }} 字</span>
            <span v-if="r.model"> · {{ r.model }}</span>
          </div>
        </div>
        <span class="muted" style="font-size:12px">打开 →</span>
      </div>
      <div v-if="!recs.length" class="empty">还没有录音，点「＋ 新增录音」开始</div>
    </div>

    <NoteShareDialog v-if="shareOpen && current?.id" :note="current" @close="shareOpen=false"
                     @created="loadShareStats" />
    <NoteShareManage v-if="manageOpen && current?.id" :note="current" @close="manageOpen=false" />

    <!-- 分类管理 -->
    <div v-if="catModal" class="modal-backdrop" @click.self="catModal=false">
      <div class="modal" style="width:min(760px,94vw); max-height:86vh; overflow-y:auto">
        <h3>分类管理</h3>
        <div class="muted" style="font-size:12.5px; margin-bottom:12px">
          分类可增可删可改名。「未分类」不可删除。给分类生成令牌后，外部 AI / 系统就能往这个分类写入笔记（只写，不可读）。
        </div>
        <div v-if="catErr" class="msg err">{{ catErr }}</div>

        <div class="row" style="gap:6px; margin-bottom:12px">
          <input v-model="newCat" placeholder="新分类名称" style="flex:1" @keyup.enter="catAdd">
          <button class="primary" @click="catAdd">新增分类</button>
        </div>

        <div v-for="c in cats" :key="c.id" class="card" style="background:var(--bg3); border:none; margin-bottom:8px">
          <div class="row" style="gap:6px; flex-wrap:wrap; align-items:center">
            <input v-model="c.name" :disabled="c.name==='general'" style="width:130px" @change="catRename(c)">
            <input v-model.number="c.sort_order" type="number" style="width:70px" title="排序（小的在前）" @change="catSort(c)">
            <span class="muted" style="font-size:12px">{{ c.note_count }} 篇</span>
            <span v-if="c.intake_token" class="tag ok" style="font-size:11px">已开写入令牌</span>
            <div class="row" style="margin-left:auto; gap:6px">
              <button class="small" @click="catToken(c, c.intake_token ? 'clear' : 'gen')">
                {{ c.intake_token ? '清除令牌' : '生成写入令牌' }}
              </button>
              <button class="small danger" :disabled="c.name==='general'" @click="catDel(c)">删除</button>
            </div>
          </div>
          <div v-if="c.intake_token" class="row" style="gap:6px; margin-top:8px; align-items:center">
            <code style="flex:1; font-size:11px; word-break:break-all">{{ intakeLink(external, c.intake_token) }}</code>
            <button class="small" @click="copyIntake(c)">复制</button>
          </div>
        </div>

        <div class="row" style="justify-content:flex-end">
          <button @click="catModal=false">关闭</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { marked } from 'marked';
import { api, rawUrl } from '../api';
import NoteShareDialog from '../components/NoteShareDialog.vue';
import NoteShareManage from '../components/NoteShareManage.vue';
import { loadExternalBase, intakeLink, copyText } from '../utils/noteShare';

const route = useRoute();
const router = useRouter();

const tab = ref('text');
const notes = ref([]);
const recs = ref([]);
const current = ref(null);
const mode = ref('edit');
const filterCat = ref('');
const kw = ref('');
const aiLoading = ref(false);
const links = ref({ out: [], in: [] });
const cats = ref([]);
const shareStats = ref({ link_count: 0, view_total: 0 });
const shareOpen = ref(false);
const manageOpen = ref(false);

// 分类管理
const catModal = ref(false);
const newCat = ref('');
const catErr = ref('');
const external = ref('');

const catLabel = (n) => (n === 'general' ? '未分类' : n);
const splitTags = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

// 预览：先按 Markdown 渲染，再把 [[标题]] 换成可点的双链（命中的跳转、未命中的点一下新建）
const rendered = computed(() => {
  if (!current.value) return '';
  let html = marked.parse(current.value.content || '');
  return html.replace(/\[\[([^\[\]\n]{1,80})\]\]/g, (m, raw) => {
    const t = raw.trim();
    const hit = notes.value.find((n) => n.title === t);
    return hit
      ? `<a class="wl" href="#/notes?note=${hit.id}">${t}</a>`
      : `<a class="wl wl-miss" href="#/notes?newtitle=${encodeURIComponent(t)}">${t} ＋</a>`;
  });
});

async function load() {
  const qs = [];
  if (kw.value.trim()) qs.push('q=' + encodeURIComponent(kw.value.trim()));
  if (filterCat.value) qs.push('category=' + encodeURIComponent(filterCat.value));
  notes.value = await api.get(`/notes${qs.length ? '?' + qs.join('&') : ''}`);
}
let kwTimer = null;
function debouncedLoad() { clearTimeout(kwTimer); kwTimer = setTimeout(load, 300); }

async function loadCats() { cats.value = await api.get('/notes/categories'); }

async function loadRecs() {
  try {
    const d = await api.get('/vibe/records?pageSize=100');
    recs.value = (d.rows || []).filter((r) => r.from_notes);
  } catch { recs.value = []; }
}

async function openNote(n) {
  if (n.record_id) return router.push(`/notes/rec/${n.record_id}`);
  current.value = JSON.parse(JSON.stringify(n));
  mode.value = n.content && n.content.trim() ? 'preview' : 'edit';
  await loadSide();
}
function openById(id) { const n = notes.value.find((x) => x.id === id); if (n) openNote(n); }
async function loadSide() {
  links.value = { out: [], in: [] };
  shareStats.value = { link_count: 0, view_total: 0 };
  if (!current.value?.id) return;
  try {
    const rows = await api.get(`/notes/${current.value.id}/links`);
    links.value = { out: rows.filter((r) => r.dir === 'out'), in: rows.filter((r) => r.dir === 'in') };
  } catch { /* 双链失败不挡编辑 */ }
  loadShareStats();
}
async function loadShareStats() {
  if (!current.value?.id) { shareStats.value = { link_count: 0, view_total: 0 }; return; }
  try {
    const d = await api.get(`/notes/shares/note/${current.value.id}`);
    shareStats.value = { link_count: d.link_count || 0, view_total: d.view_total || 0 };
  } catch { shareStats.value = { link_count: 0, view_total: 0 }; }
}

function createNote() {
  current.value = { title: '', content: '', category: filterCat.value || 'general' };
  mode.value = 'edit';
  links.value = { out: [], in: [] };
  shareStats.value = { link_count: 0, view_total: 0 };
}
async function save() {
  if (current.value.id) await api.put(`/notes/${current.value.id}`, current.value);
  else { const r = await api.post('/notes', current.value); current.value.id = r.id; }
  await load();
  // 回填服务端生成的标题/标签/概要
  const fresh = notes.value.find((n) => n.id === current.value.id);
  if (fresh) { current.value.title = fresh.title; current.value.tags = fresh.tags; }
  await loadSide();
}
async function del() {
  if (!confirm('确认删除这篇笔记？')) return;
  await api.del(`/notes/${current.value.id}`);
  current.value = null;
  await load();
}
async function aiSummarize() {
  aiLoading.value = true;
  try {
    const r = await api.post(`/notes/${current.value.id}/ai-meta`);
    current.value.summary = r.summary;
    current.value.keywords = r.keywords;
  } catch (e) { alert('AI 概要失败：' + e.message); } finally { aiLoading.value = false; }
}

// ---------- 下载 ----------
const safeName = (n) => String(n.title || '笔记').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || '笔记';
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function blobToB64(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1] || '');
    fr.onerror = () => rej(new Error('读取音频失败'));
    fr.readAsDataURL(blob);
  });
}
// 录音笔记：每次下载都问一次要不要把音频嵌进文件（内嵌为 data URI，文件可离线独立打开）
async function audioTag(n) {
  if (!n.record_id) return '';
  if (!confirm('这条是录音笔记。\n\n「确定」= 文件内嵌入音频播放器\n「取消」= 只导出文字')) return '';
  try {
    const res = await fetch(rawUrl(`/api/vibe/audio/${n.record_id}?inline=1`));
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const blob = await res.blob();
    if (blob.size > 12 * 1024 * 1024) {
      if (!confirm(`音频约 ${(blob.size / 1048576).toFixed(1)} MB，内嵌后文件会明显变大，继续？`)) return '';
    }
    return `<audio controls preload="none" src="data:${blob.type || 'audio/mpeg'};base64,${await blobToB64(blob)}"></audio>`;
  } catch (e) { alert('读取音频失败：' + e.message); return ''; }
}
async function downloadMd() {
  const n = current.value;
  let text = `# ${n.title || '未命名'}\n\n`;
  if (n.summary) text += `> ${n.summary}\n\n`;
  if (n.tags) text += `标签：${n.tags}\n\n`;
  text += String(n.content || '');
  const a = await audioTag(n);
  if (a) text += `\n\n${a}\n`;
  saveBlob(new Blob([text], { type: 'text/markdown;charset=utf-8' }), `${safeName(n)}.md`);
}
async function downloadHtml() {
  const n = current.value;
  const a = await audioTag(n);
  const head = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(n.title || '笔记')}</title>
<style>
body{max-width:760px;margin:40px auto;padding:0 18px;font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#1f2937;background:#fff}
h1{font-size:26px;line-height:1.35;margin:0 0 6px}
.meta{color:#6b7280;font-size:13px;margin-bottom:18px}
.summary{background:#f3f4f6;border-radius:8px;padding:12px 14px;color:#374151;font-size:14px;margin-bottom:20px}
audio{width:100%;margin:14px 0}
pre{background:#f6f8fa;padding:12px;border-radius:8px;overflow:auto}
code{background:#f6f8fa;padding:1px 5px;border-radius:4px;font-size:.92em}
pre code{background:none;padding:0}
img{max-width:100%}
blockquote{border-left:3px solid #d1d5db;margin:0;padding-left:14px;color:#4b5563}
table{border-collapse:collapse}td,th{border:1px solid #e5e7eb;padding:6px 10px}
@media(prefers-color-scheme:dark){body{background:#111827;color:#e5e7eb}pre,code{background:#1f2937}.summary{background:#1f2937;color:#d1d5db}.meta{color:#9ca3af}}
</style></head><body>
<h1>${esc(n.title || '未命名')}</h1>
<div class="meta">${esc(catLabel(n.category))} · ${esc(n.updated_at || '')}${n.tags ? ' · ' + esc(n.tags) : ''}</div>
${n.summary ? `<div class="summary">${esc(n.summary)}</div>` : ''}
${a}
`;
  const html = head + marked.parse(n.content || '') + '\n</body></html>';
  saveBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), `${safeName(n)}.html`);
}
const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- 分类管理 ----------
async function catAdd() {
  catErr.value = '';
  const name = newCat.value.trim();
  if (!name) return;
  try { await api.post('/notes/categories', { name }); newCat.value = ''; await loadCats(); }
  catch (e) { catErr.value = e.message; }
}
async function catRename(c) {
  catErr.value = '';
  try { await api.put(`/notes/categories/${c.id}`, { name: c.name }); await loadCats(); await load(); }
  catch (e) { catErr.value = e.message; await loadCats(); }
}
async function catSort(c) {
  try { await api.put(`/notes/categories/${c.id}`, { sort_order: c.sort_order }); } catch { /* 排序失败忽略 */ }
}
async function catToken(c, action) {
  catErr.value = '';
  if (action === 'clear' && !confirm('清除令牌后，之前发出的写入地址立即失效，外部系统无法再写入。继续？')) return;
  try { await api.put(`/notes/categories/${c.id}`, { token_action: action }); await loadCats(); }
  catch (e) { catErr.value = e.message; }
}
async function copyIntake(c) {
  const ok = await copyText(intakeLink(external.value, c.intake_token));
  if (!ok) alert('复制失败，请手动选中复制');
}
async function catDel(c) {
  catErr.value = '';
  try { await api.del(`/notes/categories/${c.id}`); }
  catch (e) {
    if (!String(e.message).includes('还有')) { catErr.value = e.message; return; }
    if (!confirm(`该分类下还有笔记，删除后这些笔记会变成「未分类」。继续删除？`)) return;
    try { await api.del(`/notes/categories/${c.id}?force=1`); } catch (e2) { catErr.value = e2.message; return; }
  }
  await loadCats();
  await load();
}

// ---------- 录音列表展示 ----------
function fmtDur(s) { const t = Math.max(0, Math.round(Number(s) || 0)); return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`; }
function fmtSize(b) { const n = Number(b) || 0; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }
const recStatusText = (r) => ({ pending: '待转写', running: '转写中…', done: '已生成', failed: '失败' }[r.status] || r.status || '—');
const recStatusColor = (r) => ({ running: '#60a5fa', done: '#34d399', failed: '#f87171' }[r.status] || 'inherit');

// ---------- 路由 query（双链跳转 / 第 7 条系统消息跳转） ----------
async function handleQuery() {
  const q = route.query;
  if (q.note) { const n = notes.value.find((x) => x.id === Number(q.note)); if (n) await openNote(n); }
  else if (q.newtitle) { createNote(); current.value.title = String(q.newtitle); current.value.content = ''; }
  if (q.rec) { tab.value = 'rec'; await loadRecs(); }
}

onMounted(async () => {
  await loadCats();
  await load();
  await loadRecs();
  external.value = await loadExternalBase();
  await handleQuery();
  if (!current.value && tab.value === 'text' && notes.value.length) await openNote(notes.value[0]);
});
watch(() => route.query, handleQuery);
</script>

<style scoped>
.list-item { display: flex; align-items: center; gap: 8px; }
.list-item .t { font-size: 13.5px; }
.list-item .meta { font-size: 11.5px; color: var(--text2); margin-top: 2px; }
.list-item.active { background: var(--bg3); }
:deep(.wl) { color: var(--accent, #60a5fa); text-decoration: none; border-bottom: 1px dashed currentColor; }
:deep(.wl-miss) { color: var(--text2); border-bottom: 1px dashed var(--border); }
</style>
