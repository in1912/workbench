<template>
  <div>
    <!-- 作为「设置 → 升级管理」tab 内嵌，不再带独立页标题 -->
    <div class="muted" style="font-size:13px; margin-bottom:12px">当前运行版本：<b>{{ currentVersion || '未标记' }}</b> · 打包版本代码，记录升级日志</div>
    <div v-if="msg" class="msg" :class="msgType">{{ msg }}</div>

    <!-- 打包新版本 -->
    <div class="card" style="margin-bottom:14px">
      <h3>📦 打包新版本</h3>
      <div class="frow">
        <label>版本号</label>
        <input v-model="ver" placeholder="如 v1.0.1" style="max-width:160px" />
        <label style="margin-left:10px">标题</label>
        <input v-model="title" class="grow" placeholder="一句话概括本次升级（选填）" />
      </div>
      <div class="frow">
        <label>升级内容</label>
        <textarea v-model="content" rows="4" class="grow" placeholder="本次升级做了什么：新增功能 / 修复问题 / 调整细节…（会写入升级日志，并附在压缩包内的 UPGRADE.md）"></textarea>
      </div>
      <div class="row" style="margin-top:10px">
        <button class="primary" @click="scan" :disabled="scanning">{{ scanning ? '扫描中…' : '检测改动' }}</button>
        <button @click="pkg" :disabled="packaging || !checkedCount">{{ packaging ? '打包中…' : `打包并记录${checkedCount ? '（' + checkedCount + ' 个文件）' : ''}` }}</button>
        <span class="grow"></span>
        <button class="small" @click="resetBaseline" title="把当前全部源码状态标记为基线，此后仅检测增量改动">重置基线</button>
      </div>
      <div v-if="scanInfo && scanInfo.latest_dist" class="muted small" style="margin-top:6px">
        打包时将自动附带最新前端构建快照 <b>web/dist/{{ scanInfo.latest_dist }}</b>（升级到 NAS 后无需构建，覆盖即用）
      </div>

      <!-- 扫描结果 -->
      <template v-if="scanInfo">
        <div class="scan-summary">
          共 {{ scanInfo.total }} 个源码文件：
          <span class="badge green">新增 {{ scanInfo.counts.new }}</span>
          <span class="badge amber">修改 {{ scanInfo.counts.changed }}</span>
          <span class="muted small">未变更 {{ scanInfo.counts.unchanged }}</span>
          <span v-if="scanInfo.counts.removed" class="badge red">已删除 {{ scanInfo.counts.removed }}</span>
          <span v-if="!scanInfo.baseline_at" class="muted small">（首次使用：可先「重置基线」建立参照，或直接全量打包当前代码作为初版）</span>
        </div>
        <div v-if="scanInfo.removed.length" class="muted small" style="margin:4px 0 8px">
          基线中已不存在：{{ scanInfo.removed.join('、') }}
        </div>
        <div class="row" style="margin-bottom:6px">
          <input v-model="filterQ" placeholder="按路径过滤…" class="grow" style="max-width:260px" />
          <label class="small" style="cursor:pointer;white-space:nowrap">
            <input type="checkbox" v-model="showAll" style="width:auto;margin-right:4px" />显示未改动文件
          </label>
          <button class="small" @click="setAll(true)">全选</button>
          <button class="small" @click="setAll(false)">清空</button>
          <button class="small" @click="setChanged">仅选改动</button>
        </div>
        <div class="file-list">
          <div v-if="!displayed.length" class="empty" style="padding:18px 0">没有匹配的文件</div>
          <label v-for="f in displayed" :key="f.path" class="fitem2">
            <input type="checkbox" v-model="f.checked" style="width:auto;flex-shrink:0" />
            <span class="badge" :class="f.status === 'new' ? 'green' : f.status === 'changed' ? 'amber' : 'blue'">{{ statusText[f.status] }}</span>
            <span class="fpath">{{ f.path }}</span>
            <span class="muted small" style="flex-shrink:0">{{ fmtSize(f.size) }}</span>
          </label>
        </div>
      </template>
    </div>

    <!-- 应用升级包（NAS/服务器端用） -->
    <div class="card" style="margin-bottom:14px">
      <h3>⬆ 应用升级包 <span class="muted" style="font-size:12px">在服务器/NAS 的工作台里上传本地生成的升级包</span></h3>
      <div class="row" style="flex-wrap:wrap">
        <input ref="applyFile" type="file" accept=".zip" style="max-width:340px" />
        <button class="primary" @click="applyPkg" :disabled="applying">{{ applying ? '应用中…' : '上传并应用' }}</button>
      </div>
      <div class="muted small" style="margin-top:8px">
        应用流程：校验升级包 → 覆盖 server/ 源码与 web/dist/ 前端快照 → 写入升级日志并标记当前版本 → 服务自动重启。
        Docker 部署（restart: always）会自动拉起，约数秒后刷新页面即新版本；本地直跑需手动重启服务。
      </div>
    </div>

    <!-- 升级日志 -->
    <div class="card" v-for="log in logs" :key="log.id" style="margin-bottom:14px">
      <div class="log-head">
        <span class="badge blue" style="flex-shrink:0">{{ log.version }}</span>
        <span class="badge" :class="log.source === 'applied' ? 'amber' : 'green'" style="flex-shrink:0">{{ log.source === 'applied' ? '已应用' : '打包' }}</span>
        <b v-if="log.title">{{ log.title }}</b>
        <span class="grow"></span>
        <span class="muted small">{{ log.created_at }} · {{ log.created_by }}</span>
      </div>

      <template v-if="editing === log.id">
        <div class="frow"><label>标题</label><input v-model="editTitle" class="grow" /></div>
        <div class="frow" style="margin-top:8px">
          <label>升级内容</label>
          <textarea v-model="editContent" rows="4" class="grow"></textarea>
        </div>
        <div class="row" style="margin-top:8px">
          <button class="primary small" @click="saveEdit(log)">保存</button>
          <button class="small" @click="editing = 0">取消</button>
        </div>
      </template>
      <template v-else>
        <div class="log-content">{{ log.content || '（未填写升级内容）' }}</div>
        <div class="row" style="margin-top:8px;flex-wrap:wrap">
          <span class="muted small">{{ log.file_count }} 个文件 · {{ fmtSize(log.package_size) }}</span>
          <button class="small" @click="toggleFiles(log)">{{ expanded[log.id] ? '收起清单' : '文件清单' }}</button>
          <span class="grow"></span>
          <button class="small" @click="download(log)">下载升级包</button>
          <button class="small" @click="startEdit(log)">编辑</button>
          <button class="icon-btn" @click="remove(log)" title="删除">✕</button>
        </div>
        <div v-if="expanded[log.id]" class="file-list" style="margin-top:8px">
          <div v-for="f in log.files" :key="f.path" class="fitem2" style="cursor:default">
            <span class="badge" :class="f.status === 'new' ? 'green' : f.status === 'changed' ? 'amber' : 'blue'">{{ statusText[f.status] || f.status }}</span>
            <span class="fpath">{{ f.path }}</span>
            <span class="muted small" style="flex-shrink:0">{{ fmtSize(f.size) }}</span>
          </div>
        </div>
      </template>
    </div>
    <div v-if="!logs.length && !scanning" class="card empty">暂无升级记录 —— 修改代码后点「检测改动」打包第一个版本</div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue';
import { api } from '../api';

const ver = ref('');
const title = ref('');
const content = ref('');
const files = ref([]);          // [{path,size,mtime,hash,status,checked}]
const scanInfo = ref(null);
const scanning = ref(false);
const packaging = ref(false);
const filterQ = ref('');
const showAll = ref(false);
const logs = ref([]);
const editing = ref(0);
const editTitle = ref('');
const editContent = ref('');
const expanded = reactive({});
const msg = ref('');
const msgType = ref('ok');
const currentVersion = ref(localStorage.getItem('wb_version') || '');
const applying = ref(false);
const applyFile = ref(null);

const statusText = { new: '新增', changed: '修改', unchanged: '未变更' };

function flash(text, type = 'ok') { msg.value = text; msgType.value = type; setTimeout(() => (msg.value = ''), 5000); }
function fmtSize(n) {
  if (!n) return '0B';
  if (n < 1024) return n + 'B';
  if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
  return (n / 1048576).toFixed(1) + 'MB';
}

const displayed = computed(() => {
  const q = filterQ.value.trim().toLowerCase();
  const pri = { changed: 0, new: 1, unchanged: 2 };
  return files.value
    .filter((f) => showAll.value || f.status !== 'unchanged')
    .filter((f) => !q || f.path.toLowerCase().includes(q))
    .sort((a, b) => pri[a.status] - pri[b.status] || a.path.localeCompare(b.path));
});
const checkedCount = computed(() => files.value.filter((f) => f.checked).length);

function setAll(v) { files.value.forEach((f) => { if (displayed.value.includes(f)) f.checked = v; }); }
function setChanged() { files.value.forEach((f) => (f.checked = f.status !== 'unchanged')); }

// 下一个版本号建议：取日志中最大的 x.y.z 并递增末位
function nextVersion() {
  let best = null;
  for (const l of logs.value) {
    const m = String(l.version || '').match(/(\d+)\.(\d+)\.(\d+)/);
    if (!m) continue;
    const p = m.slice(1).map(Number);
    if (!best || p[0] > best[0] || (p[0] === best[0] && (p[1] > best[1] || (p[1] === best[1] && p[2] > best[2])))) best = p;
  }
  return best ? `v${best[0]}.${best[1]}.${best[2] + 1}` : 'v1.0.1';
}

async function loadLogs() {
  try {
    const d = await api.get('/upgrade/list');
    logs.value = d.logs || [];
  } catch (e) { /* 列表加载失败不打断页面 */ }
}

async function scan() {
  scanning.value = true;
  try {
    const d = await api.get('/upgrade/scan');
    scanInfo.value = d;
    files.value = (d.files || []).map((f) => ({ ...f, checked: f.status !== 'unchanged' }));
    if (d.current_version !== undefined) {
      currentVersion.value = d.current_version;
      localStorage.setItem('wb_version', d.current_version);
    }
  } catch (e) {
    flash('扫描失败：' + e.message, 'err');
  } finally {
    scanning.value = false;
  }
}

async function pkg() {
  if (!ver.value.trim()) return flash('请填写版本号', 'err');
  packaging.value = true;
  try {
    const r = await api.post('/upgrade/package', {
      version: ver.value.trim(),
      title: title.value,
      content: content.value,
      files: files.value.filter((f) => f.checked).map((f) => f.path),
    });
    flash(`已打包 ${r.package_name}（${fmtSize(r.package_size)}，${r.file_count} 个文件），已写入升级日志`);
    title.value = '';
    content.value = '';
    await loadLogs();
    ver.value = nextVersion();
    await scan(); // 基线已更新，刷新待选列表
  } catch (e) {
    flash('打包失败：' + e.message, 'err');
  } finally {
    packaging.value = false;
  }
}

async function resetBaseline() {
  if (!confirm('把当前全部源码状态标记为基线？此后「检测改动」只提示基线之后的增量改动。')) return;
  try {
    const r = await api.post('/upgrade/baseline');
    flash(`基线已重置（${r.count} 个文件）`);
    await scan();
  } catch (e) {
    flash('重置失败：' + e.message, 'err');
  }
}

// 上传升级包并应用（NAS/服务器端）：上传成功后服务会自动重启，请求会被中断属预期
async function applyPkg() {
  const input = applyFile.value;
  const file = input && input.files && input.files[0];
  if (!file) return flash('请先选择升级包 zip 文件', 'err');
  if (!confirm(`应用升级包「${file.name}」？\n应用后服务会自动重启（Docker 环境数秒后自动拉起，届时刷新页面）。`)) return;
  applying.value = true;
  try {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/upgrade/apply', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + (localStorage.getItem('wb_token') || '') },
      body: fd,
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `应用失败 (${res.status})`);
    flash(`已应用 ${d.version || ''}（${d.applied || '?'} 个文件），服务正在重启——稍等几秒后刷新页面`, 'ok');
    setTimeout(() => location.reload(), 4000);
  } catch (e) {
    flash('应用失败：' + e.message, 'err');
    applying.value = false;
  }
}

async function download(log) {
  try {
    await api.download(`/upgrade/${log.id}/download`, `upgrade_${log.version}.zip`);
  } catch (e) {
    flash('下载失败：' + e.message, 'err');
  }
}

function startEdit(log) {
  editing.value = log.id;
  editTitle.value = log.title || '';
  editContent.value = log.content || '';
}
async function saveEdit(log) {
  try {
    await api.put(`/upgrade/${log.id}`, { title: editTitle.value, content: editContent.value });
    editing.value = 0;
    flash('日志已更新');
    await loadLogs();
  } catch (e) {
    flash('保存失败：' + e.message, 'err');
  }
}
function toggleFiles(log) { expanded[log.id] = !expanded[log.id]; }

async function remove(log) {
  if (!confirm(`删除升级记录「${log.version}」？对应的升级包文件也会一并删除。`)) return;
  try {
    await api.del(`/upgrade/${log.id}`);
    flash('已删除');
    await loadLogs();
  } catch (e) {
    flash('删除失败：' + e.message, 'err');
  }
}

onMounted(async () => {
  await loadLogs();
  ver.value = nextVersion();
  await scan();
});
</script>

<style scoped>
.frow { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 10px; }
.frow label { font-size: 12.5px; color: var(--text2); line-height: 32px; white-space: nowrap; flex-shrink: 0; }
.scan-summary { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 13px; margin: 12px 0 8px; }
.file-list { border: 1px solid var(--border); border-radius: 8px; max-height: 320px; overflow-y: auto; padding: 6px; }
.fitem2 { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 6px; font-size: 12.5px; cursor: pointer; }
.fitem2:hover { background: var(--bg3); }
.fpath { font-family: monospace; min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: ltr; }
.log-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.log-content { font-size: 13.5px; line-height: 1.7; color: var(--text2); white-space: pre-wrap; word-break: break-word; }
</style>
