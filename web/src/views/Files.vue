<template>
  <!-- 文件存档（原独立页，2026-09 v1.7.0 并入效率工具页倒数第二个 tab；标题栏由外层 Tools 页提供） -->
  <div>
    <div class="muted" style="font-size:12.5px; margin-bottom:8px">点击左侧文件，右侧查看解析文字预览</div>
    <div v-if="msg" class="msg" :class="msgType">{{ msg }}</div>

    <!-- 上传区 -->
    <div class="card" style="margin-bottom:14px"
         @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="onDrop"
         :style="{ outline: dragging ? '2px dashed var(--accent)' : '', cursor: 'pointer' }"
         @click="$refs.fileInput.click()">
      <div style="text-align:center; padding:14px 0">
        <div style="font-size:24px">📄</div>
        <div>点击或拖拽文件到此处上传</div>
        <div class="muted" style="font-size:12px; margin-top:4px">支持 PDF / Excel / Word / TXT 等，最大 20MB</div>
        <div style="margin-top:6px">
          <label style="cursor:pointer; font-size:13px">
            <input type="checkbox" v-model="useAI" style="width:auto; margin-right:4px" @click.stop />上传后用 AI 精炼摘要（不勾选也会自动提取文字，可全局搜索）
          </label>
        </div>
      </div>
      <input ref="fileInput" type="file" style="display:none" @change="onFileChange" multiple />
    </div>

    <!-- 搜索 -->
    <div class="row" style="margin-bottom:14px">
      <input v-model="searchQ" placeholder="搜索文件名或解析文字..." class="grow" @keyup.enter="load" />
      <button class="primary" @click="load">搜索</button>
    </div>

    <!-- 左右分栏：左列表 + 右预览 -->
    <div class="files-layout">
      <!-- 左：文件列表 -->
      <div class="files-list">
        <div v-if="!files.length" class="card empty">暂无存档文件</div>
        <div v-for="f in files" :key="f.id" class="fitem" :class="{ active: current && current.id === f.id }" @click="select(f)">
          <div class="fitem-ico">{{ iconOf(f) }}</div>
          <div class="fitem-main">
            <div class="fitem-name" :title="f.filename">{{ f.filename }}</div>
            <div class="fitem-meta">
              {{ fmtSize(f.file_size) }} · {{ (f.created_at || '').slice(5, 16) }}
              <span v-if="f.ai_parsed" class="badge green" style="font-size:10px; margin-left:2px; padding:0 5px">AI</span>
              <span v-else-if="f.parse_engine && f.parse_engine !== 'unsupported'" class="badge blue" style="font-size:10px; margin-left:2px; padding:0 5px">文字</span>
            </div>
          </div>
          <span class="fitem-badge">{{ (f.text_content || '').length ? Math.min(9999, (f.text_content || '').length) + '字' : '—' }}</span>
        </div>
      </div>

      <!-- 右：预览大界面 -->
      <div class="files-view card">
        <template v-if="current">
          <div class="fv-head">
            <div style="min-width:0; flex:1">
              <b style="font-size:15px; word-break:break-all">{{ current.filename }}</b>
              <div class="muted" style="font-size:12px; margin-top:2px">
                {{ current.file_type || '未知类型' }} · {{ fmtSize(current.file_size) }} · 上传于 {{ current.created_at }}
                <span v-if="current.ai_parsed" class="badge green" style="font-size:11px; margin-left:4px">AI解析</span>
                <span v-else-if="current.parse_engine" class="badge blue" style="font-size:11px; margin-left:4px">提取引擎：{{ current.parse_engine }}</span>
              </div>
            </div>
            <div class="row" style="gap:6px; flex-shrink:0">
              <button class="small" @click="reparse('ai')" :disabled="rpLoading">{{ rpLoading ? 'AI识别中...' : 'AI 识别' }}</button>
              <button class="small" @click="reparse('builtin')" :disabled="rpLoading" title="用内置解析器重新提取文字">重新提取</button>
              <a class="link small" style="text-decoration:none;cursor:pointer" @click.prevent="dlFile">下载</a>
              <button class="icon-btn" @click="remove(current)">✕</button>
            </div>
          </div>
          <div class="fv-body">
            <div v-if="viewLoading" class="muted" style="padding:20px; text-align:center">加载解析文字...</div>
            <template v-else>
              <div v-if="viewText" class="fv-text">{{ viewText }}</div>
              <div v-else class="empty" style="padding:40px 0">
                {{ current.parse_engine === 'unsupported' ? '该文件类型暂不支持文字提取（仅存档）' : '未能提取到文字内容' }}
                <div v-if="isPdf(current)" style="margin-top:8px">
                  <button class="primary small" @click="reparse('ai')" :disabled="rpLoading">{{ rpLoading ? 'AI识别中...' : '用 AI 识别（适合扫描件/图片型 PDF）' }}</button>
                </div>
              </div>
            </template>
          </div>
        </template>
        <div v-else class="empty" style="padding:60px 0">← 点击左侧文件查看预览</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { api } from '../api';

const files = ref([]);
const searchQ = ref('');
const useAI = ref(false);
const dragging = ref(false);
const msg = ref('');
const msgType = ref('ok');
// 右侧预览：当前选中文件 + 全文（展开时从 /files/:id 拉完整内容）
const current = ref(null);
const viewText = ref('');
const viewLoading = ref(false);
const rpLoading = ref(false);
function flash(text, type = 'ok') { msg.value = text; msgType.value = type; setTimeout(() => (msg.value = ''), 4000); }

function isPdf(f) {
  return /\.pdf$/i.test(f.filename || '') || f.file_type === 'application/pdf';
}
// 重新解析：builtin=内置提取 / ai=AI 识别（文字整理或视觉识读）
async function reparse(mode) {
  if (!current.value || rpLoading.value) return;
  rpLoading.value = true;
  try {
    const r = await api.post(`/files/${current.value.id}/reparse`, { mode });
    flash(`解析完成（${r.engine}，${r.chars} 字）`);
    viewText.value = '';
    await select({ ...current.value }); // 重新拉全文
    await load();
  } catch (e) {
    flash('解析失败：' + e.message, 'err');
  } finally {
    rpLoading.value = false;
  }
}

async function load() {
  try {
    const d = await api.get('/files' + (searchQ.value ? `?q=${encodeURIComponent(searchQ.value)}` : ''));
    files.value = d.files || [];
    // 当前选中的被删掉/搜不到时清空预览
    if (current.value && !files.value.some((f) => f.id === current.value.id)) {
      current.value = null;
      viewText.value = '';
    }
  } catch (e) { files.value = []; }
}

// 文件下载：带令牌取流（裸 <a> 直链会因无 Authorization 头被 401 拦截）
async function dlFile() {
  if (!current.value) return;
  try {
    await api.download(`/files/${current.value.id}/download`, current.value.filename);
  } catch (e) {
    flash('下载失败：' + e.message, 'err');
  }
}

async function select(f) {
  current.value = f;
  viewLoading.value = true;
  viewText.value = '';
  try {
    const d = await api.get(`/files/${f.id}`);
    viewText.value = d.text_content || '';
  } catch (e) {
    viewText.value = '';
  } finally {
    viewLoading.value = false;
  }
}

async function uploadFile(file) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('ai', useAI.value ? 'true' : 'false');
  const r = await fetch('/api/files/upload', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + (localStorage.getItem('wb_token') || '') },
    body: fd,
  });
  if (!r.ok) throw new Error(`上传失败 (${r.status})`);
  const d = await r.json();
  flash(`「${file.name}」上传成功${d.ai_parsed ? '（AI解析完成）' : ''}`);
}

function onFileChange(e) {
  const list = e.target.files;
  if (!list) return;
  for (const f of list) uploadFile(f).catch(err => flash(`「${f.name}」上传失败: ${err.message}`, 'err'));
  e.target.value = '';
  setTimeout(load, 1000);
}
function onDrop(e) {
  dragging.value = false;
  const list = e.dataTransfer.files;
  if (!list) return;
  for (const f of list) uploadFile(f).catch(err => flash(`「${f.name}」上传失败: ${err.message}`, 'err'));
  setTimeout(load, 1000);
}

async function remove(f) {
  if (!confirm(`删除「${f.filename}」？`)) return;
  try {
    await api.del(`/files/${f.id}`);
    flash('已删除');
    if (current.value && current.value.id === f.id) { current.value = null; viewText.value = ''; }
    await load();
  }
  catch (e) { flash('删除失败: ' + e.message, 'err'); }
}

function iconOf(f) {
  const n = String(f.filename || '').toLowerCase();
  if (n.endsWith('.pdf')) return '📕';
  if (n.endsWith('.doc') || n.endsWith('.docx')) return '📘';
  if (n.endsWith('.xls') || n.endsWith('.xlsx') || n.endsWith('.csv')) return '📗';
  if (n.endsWith('.txt') || n.endsWith('.md') || n.endsWith('.log')) return '📄';
  if (/\.(png|jpe?g|gif|webp|bmp)$/.test(n)) return '🖼';
  if (/\.(zip|rar|7z|tar|gz)$/.test(n)) return '🗜';
  return '📎';
}

function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return n + 'B';
  if (n < 1048576) return (n/1024).toFixed(1) + 'KB';
  return (n/1048576).toFixed(1) + 'MB';
}

onMounted(load);
</script>

<style scoped>
.files-layout { display: grid; grid-template-columns: 300px 1fr; gap: 14px; align-items: start; }
.files-list { display: flex; flex-direction: column; gap: 6px; max-height: calc(100vh - 280px); overflow-y: auto; padding-right: 2px; }
.fitem { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg2); cursor: pointer; transition: border-color .12s; }
.fitem:hover { border-color: var(--accent); }
.fitem.active { border-color: var(--accent); background: var(--bg3); }
.fitem-ico { font-size: 18px; flex-shrink: 0; }
.fitem-main { min-width: 0; flex: 1; }
.fitem-name { font-size: 13px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fitem-meta { font-size: 11px; color: var(--text3); margin-top: 1px; }
.fitem-badge { font-size: 10.5px; color: var(--text3); flex-shrink: 0; }
.files-view { min-height: 320px; display: flex; flex-direction: column; }
.fv-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; padding-bottom: 10px; border-bottom: 1px solid var(--border); margin-bottom: 10px; flex-wrap: wrap; }
.fv-body { flex: 1; overflow-y: auto; max-height: calc(100vh - 380px); }
.fv-text { font-size: 13.5px; line-height: 1.8; color: var(--text2); white-space: pre-wrap; word-break: break-all; }
@media (max-width: 900px) {
  .files-layout { grid-template-columns: 1fr; }
  .files-list { max-height: 240px; }
  .fv-body { max-height: none; }
}
</style>
