<template>
  <div>
    <h2 class="page-title">笔记</h2>
    <div class="grid" style="grid-template-columns:250px 1fr">
      <div class="card notes-list" style="max-height:calc(100vh - 130px); overflow-y:auto">
        <div class="row" style="margin-bottom:10px">
          <button class="primary small" @click="createNote">＋ 新建</button>
          <select v-model="filterCat" @change="load()" class="small" style="width:auto; padding:4px 8px">
            <option value="">全部分类</option>
            <option v-for="c in categories" :key="c">{{ c }}</option>
          </select>
        </div>
        <div v-for="n in notes" :key="n.id" class="list-item" :class="{active: current?.id===n.id}"
             style="cursor:pointer; border-radius:8px; padding:8px 10px"
             @click="select(n)">
          <div class="grow">
            <div class="t">{{ n.title || '未命名' }}</div>
            <div class="meta">{{ n.category }} · {{ n.updated_at?.slice(5,16) }}</div>
          </div>
        </div>
      </div>

      <div class="card">
        <template v-if="current">
          <div class="row" style="margin-bottom:12px">
            <select v-model="current.category" style="width:120px">
              <option v-for="c in categories" :key="c">{{ c }}</option>
            </select>
            <span class="muted" style="font-size:12px; align-self:center">标题保存时自动按内容关键词生成</span>
            <button class="primary" @click="save">保存</button>
            <button class="danger" @click="del">删除</button>
          </div>
          <div class="tabs" style="margin-bottom:8px">
            <button :class="{active: mode==='edit'}" @click="mode='edit'">编辑</button>
            <button :class="{active: mode==='preview'}" @click="mode='preview'">预览</button>
            <button v-if="current.content" class="small" style="margin-left:auto" @click="aiSummarize">AI 总结</button>
          </div>
          <textarea v-if="mode==='edit'" v-model="current.content" rows="20" placeholder="支持 Markdown 语法..." style="font-family:ui-monospace,Consolas,monospace"></textarea>
          <div v-else class="markdown-body" v-html="rendered"></div>
          <div v-if="aiLoading" class="muted" style="margin-top:8px">AI 总结中...</div>
          <div v-if="aiResult" class="card" style="margin-top:10px; background:var(--bg3); border:none">
            <b>AI 总结</b><div style="margin-top:6px">{{ aiResult }}</div>
          </div>
        </template>
        <div v-else class="empty">选择或新建一篇笔记</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { marked } from 'marked';
import { api } from '../api';

const notes = ref([]);
const current = ref(null);
const mode = ref('edit');
const filterCat = ref('');
const aiLoading = ref(false);
const aiResult = ref('');

const categories = ['general', '工作', '生活', '家庭', '学习', '想法'];

const rendered = computed(() => (current.value ? marked.parse(current.value.content || '') : ''));

async function load() {
  const q = filterCat.value ? `?q=${encodeURIComponent(filterCat.value)}` : '';
  notes.value = await api.get(`/notes${q}`);
}
async function select(n) {
  current.value = JSON.parse(JSON.stringify(n));
  mode.value = n.content && n.content.trim() ? 'preview' : 'edit';
  aiResult.value = '';
}
async function createNote() {
  current.value = { title: '', content: '', category: filterCat.value || 'general' };
  mode.value = 'edit';
  aiResult.value = '';
}
async function save() {
  if (current.value.id) {
    await api.put(`/notes/${current.value.id}`, current.value);
  } else {
    const r = await api.post('/notes', current.value);
    current.value.id = r.id;
  }
  await load();
}
async function del() {
  if (!confirm('确认删除这篇笔记？')) return;
  await api.del(`/notes/${current.value.id}`);
  current.value = null;
  await load();
}
async function aiSummarize() {
  aiLoading.value = true;
  aiResult.value = '';
  try {
    const r = await api.post('/ai/summarize', {
      text: current.value.content || '',
      instruction: '请用 150 字以内总结这篇笔记的核心要点，直接输出总结。',
    });
    aiResult.value = r.content;
  } catch (e) {
    aiResult.value = 'AI 总结失败：' + e.message;
  } finally {
    aiLoading.value = false;
  }
}

onMounted(load);
</script>
