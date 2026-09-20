<template>
  <div class="vset">
    <!-- NAS 学习目录 -->
    <div class="card">
      <h3>NAS 学习目录</h3>
      <div class="muted" style="font-size:12.5px; margin-bottom:10px">
        「视频教学」页的目录树从这里配置的路径读取。Docker/NAS 部署：填<b>容器内路径</b>——需先在 NAS 的 Docker 里把目录映射进容器（如宿主机 /vol2/1000/媛媛学习 映射为 /study，这里就填 /study，参考邮箱附件的 /mail 是映射进来的）。
        Windows 直跑：填本机目录（如 D:\学习资料）。服务进程需对该路径有读取权限。
      </div>
      <div class="row">
        <input v-model="root" class="grow" placeholder="/study（Docker 映射路径）或 D:\学习资料" @keyup.enter="saveRoot" />
        <button class="small" :disabled="testing" @click="testRoot">{{ testing ? '测试中…' : '测试连接' }}</button>
        <button class="primary" :disabled="savingRoot" @click="saveRoot">{{ savingRoot ? '保存中…' : '保存目录' }}</button>
      </div>
      <div v-if="testResult" class="test-result" :class="testResult.ok ? 'ok' : 'bad'">
        {{ testResult.ok ? `✓ 连接成功：${testResult.text}` : `✗ ${testResult.text}` }}
      </div>
      <!-- 容器目录浏览器：Docker 部署找不到映射路径时，从根目录逐层点开看容器里真实可见的目录 -->
      <div class="probe">
        <button class="small" @click="probe(probeRes ? probeRes.path : '/')">{{ probeRes ? '🔄 刷新' : '📁 浏览容器目录（找不到路径时用这个）' }}</button>
        <div v-if="probeRes" class="probe-box">
          <div class="probe-head">
            <a v-if="probeRes.parent" class="mini" @click="probe(probeRes.parent)">⬆ 上级</a>
            <b>{{ probeRes.path }}</b>
            <span v-if="!probeRes.exists" class="probe-err">（容器内不存在）</span>
            <span class="grow"></span>
            <button v-if="probeRes.exists && probeRes.is_dir" class="small" @click="root = probeRes.path; saveRoot()">用此目录</button>
          </div>
          <div class="probe-list">
            <span v-for="e in probeRes.entries" :key="e.name" class="probe-item" :class="{ dir: e.dir }"
              :title="e.dir ? '点开' : '文件'" @click="e.dir && probe(joinProbe(e.name))">{{ e.dir ? '📁' : '📄' }} {{ e.name }}</span>
            <span v-if="probeRes.exists && probeRes.is_dir && !probeRes.entries.length" class="muted">（空目录）</span>
          </div>
          <div class="muted" style="font-size:11.5px; margin-top:6px">
            这里显示的是<b>服务进程（容器内）</b>看到的目录。NAS 上的目录必须先在 Docker 里映射进来才会出现；
            找到你的学习目录后点「用此目录」即可。
          </div>
        </div>
      </div>
    </div>

    <!-- 学年 / 学科字典 -->
    <div class="card">
      <h3>学年与学科</h3>
      <div class="muted" style="font-size:12.5px; margin-bottom:10px">进入「视频教学」点「开始学习」后，将按大按钮展示以下选项；新增项会自动出现在按钮区。</div>
      <div class="dict-block">
        <div class="dict-title">学年</div>
        <div class="chips">
          <span v-for="(y, i) in years" :key="y" class="chip">{{ y }} <a class="x" @click="years.splice(i, 1)">✕</a></span>
          <span v-if="!years.length" class="muted" style="font-size:12.5px">（空）</span>
        </div>
        <div class="row">
          <input v-model="newYear" class="grow" placeholder="如：2027-2028 学年" @keyup.enter="addYear" />
          <button class="small" @click="addYear">添加学年</button>
        </div>
      </div>
      <div class="dict-block">
        <div class="dict-title">学科</div>
        <div class="chips">
          <span v-for="(s, i) in subjects" :key="s" class="chip">{{ s }} <a class="x" @click="subjects.splice(i, 1)">✕</a></span>
          <span v-if="!subjects.length" class="muted" style="font-size:12.5px">（空）</span>
        </div>
        <div class="row">
          <input v-model="newSubject" class="grow" placeholder="如：信息技术" @keyup.enter="addSubject" />
          <button class="small" @click="addSubject">添加学科</button>
        </div>
      </div>
      <div class="row" style="margin-top:14px">
        <button class="primary" :disabled="savingDict" @click="saveDict">{{ savingDict ? '保存中…' : '保存学年与学科' }}</button>
        <span v-if="dictSaved" class="muted" style="font-size:12.5px; color: var(--green)">✓ 已保存</span>
      </div>
    </div>
  </div>
</template>

<script setup>
// 视频教学设置：NAS 根目录（视频教学页目录树的数据源）+ 学年/学科字典（开始学习的大按钮选项）
import { onMounted, ref } from 'vue';
import { api } from '../api';

const root = ref('');
const testing = ref(false);
const savingRoot = ref(false);
const testResult = ref(null);
const years = ref([]);
const subjects = ref([]);
const newYear = ref('');
const newSubject = ref('');
const savingDict = ref(false);
const dictSaved = ref(false);

async function load() {
  try {
    const c = await api.get('/vstudy/config');
    root.value = c.root || '';
    years.value = c.years || [];
    subjects.value = c.subjects || [];
  } catch { /* 配置读取失败由保存时报错 */ }
}

async function testRoot() {
  testing.value = true;
  testResult.value = null;
  try {
    await api.post('/vstudy/settings', { root: root.value.trim() }); // 后端会校验目录存在
    const t = await api.get('/vstudy/tree');
    testResult.value = { ok: true, text: `目录可读，顶层 ${ (t.entries || []).length } 项` };
  } catch (e) {
    testResult.value = { ok: false, text: e.message };
  }
  testing.value = false;
}

async function saveRoot() {
  savingRoot.value = true;
  testResult.value = null;
  try {
    await api.post('/vstudy/settings', { root: root.value.trim() });
    testResult.value = { ok: true, text: '已保存' };
  } catch (e) {
    testResult.value = { ok: false, text: e.message };
  }
  savingRoot.value = false;
}

// ---------- 容器目录浏览器（管理员探针） ----------
const probeRes = ref(null);
async function probe(p) {
  try { probeRes.value = await api.get('/vstudy/fs-probe?path=' + encodeURIComponent(p || '/')); }
  catch (e) { alert(e.message); }
}
const joinProbe = (name) => probeRes.value.path.replace(/[\\/]+$/, '') + '/' + name;

function addYear() {
  const v = newYear.value.trim();
  if (v && !years.value.includes(v)) years.value.push(v);
  newYear.value = '';
  dictSaved.value = false;
}
function addSubject() {
  const v = newSubject.value.trim();
  if (v && !subjects.value.includes(v)) subjects.value.push(v);
  newSubject.value = '';
  dictSaved.value = false;
}
async function saveDict() {
  savingDict.value = true;
  try {
    await api.post('/vstudy/settings', { years: years.value, subjects: subjects.value });
    dictSaved.value = true;
  } catch (e) { alert(e.message); }
  savingDict.value = false;
}

onMounted(load);
</script>

<style scoped>
.vset { display: flex; flex-direction: column; gap: 12px; }
.row { display: flex; align-items: center; gap: 10px; margin-top: 8px; flex-wrap: wrap; }
.row .grow { flex: 1; min-width: 220px; }
input { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font-size: 13px; }
.test-result { margin-top: 10px; font-size: 13px; }
.test-result.ok { color: var(--green); }
.test-result.bad { color: var(--red); }
.probe { margin-top: 10px; }
.probe-box { margin-top: 8px; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; background: var(--bg2); }
.probe-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; word-break: break-all; }
.probe-head b { font-family: var(--mono, monospace); font-size: 12.5px; }
.probe-head .mini { color: var(--accent); cursor: pointer; font-size: 12.5px; white-space: nowrap; }
.probe-head .grow { flex: 1; }
.probe-err { color: var(--red); font-size: 12.5px; }
.probe-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; max-height: 240px; overflow-y: auto; }
.probe-item { background: var(--bg3); border: 1px solid var(--border); border-radius: 6px; padding: 3px 10px; font-size: 12.5px; user-select: none; }
.probe-item.dir { cursor: pointer; }
.probe-item.dir:hover { border-color: var(--accent); }
.dict-block { margin-bottom: 16px; }
.dict-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 4px; }
.chip { display: inline-flex; align-items: center; gap: 6px; background: var(--bg3); border: 1px solid var(--border); border-radius: 16px; padding: 4px 12px; font-size: 13px; }
.chip .x { color: var(--red); cursor: pointer; font-size: 11px; }
.primary { background: var(--accent); color: #fff; border: none; border-radius: 8px; padding: 7px 18px; font-size: 13.5px; cursor: pointer; }
.primary:disabled { opacity: .5; cursor: default; }
.small { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 7px 14px; font-size: 13px; cursor: pointer; }
.small:disabled { opacity: .5; cursor: default; }
.muted { color: var(--text3); }
</style>
