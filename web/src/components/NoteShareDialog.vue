<template>
  <div class="modal-backdrop" @click.self="$emit('close')">
    <div class="modal">
      <h3>分享笔记</h3>
      <div class="muted" style="font-size:12.5px; margin-bottom:14px">
        {{ note.title || '未命名' }} · 链接自带 4 位访问密码，收到的人点开即看
      </div>

      <div class="form-row">
        <label>链接有效期</label>
        <div class="row" style="gap:8px">
          <label v-for="o in expOptions" :key="o.v" class="row" style="gap:4px; font-size:13px; align-items:center">
            <input type="radio" :value="o.v" v-model.number="expiresDays" style="width:auto"> {{ o.label }}
          </label>
        </div>
      </div>

      <div class="form-row">
        <label>内容形态</label>
        <div class="row" style="gap:8px">
          <label class="row" style="gap:4px; font-size:13px; align-items:center">
            <input type="radio" value="live" v-model="mode" style="width:auto"> 活链接（跟随笔记更新）
          </label>
          <label class="row" style="gap:4px; font-size:13px; align-items:center">
            <input type="radio" value="snapshot" v-model="mode" style="width:auto"> 快照（冻结当前内容）
          </label>
        </div>
      </div>

      <div class="form-row" v-if="note.record_id">
        <label class="row" style="gap:6px; align-items:center; font-size:13px">
          <input type="checkbox" v-model="withAudio" style="width:auto"> 包含录音（对方可直接播放）
        </label>
      </div>

      <div v-if="err" class="msg err">{{ err }}</div>

      <div v-if="created" class="card" style="background:var(--bg3); border:none; margin-bottom:12px">
        <div style="font-size:12.5px; color:var(--text2); margin-bottom:6px">分享链接（已带访问密码）</div>
        <div style="word-break:break-all; font-size:12.5px; font-family:ui-monospace,Consolas,monospace">{{ link }}</div>
      </div>

      <div class="row" style="justify-content:flex-end; gap:8px">
        <button @click="$emit('close')">关闭</button>
        <template v-if="!created">
          <button class="primary" :disabled="busy" @click="create">{{ busy ? '生成中...' : '生成链接' }}</button>
        </template>
        <template v-else>
          <button class="primary" @click="copy">{{ copied ? '已复制 ✓' : '复制链接' }}</button>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { api } from '../api';
import { loadExternalBase, shareLink, copyText } from '../utils/noteShare';

const props = defineProps({ note: { type: Object, required: true } });
const emit = defineEmits(['close', 'created']);

const expOptions = [
  { v: 7, label: '7 天' },
  { v: 30, label: '30 天' },
  { v: 0, label: '不限' },
];
const expiresDays = ref(7);
const mode = ref('live');
const withAudio = ref(false);
const busy = ref(false);
const err = ref('');
const created = ref(null);
const copied = ref(false);

const link = computed(() => (created.value ? shareLink(created.value.external, created.value.token, created.value.code) : ''));

async function create() {
  busy.value = true;
  err.value = '';
  try {
    const external = await loadExternalBase();
    const r = await api.post(`/notes/shares/note/${props.note.id}`, {
      expires_days: expiresDays.value,
      mode: mode.value,
      with_audio: withAudio.value ? 1 : 0,
    });
    created.value = { ...r, external };
    emit('created');
  } catch (e) {
    err.value = e.message || '生成失败';
  } finally {
    busy.value = false;
  }
}

async function copy() {
  copied.value = await copyText(link.value);
  if (!copied.value) alert('复制失败，请手动选中上面的链接复制');
}
</script>
