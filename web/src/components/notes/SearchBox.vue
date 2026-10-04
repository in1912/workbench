<template>
  <div class="sbox">
    <div class="modes">
      <button v-for="m in MODES" :key="m.k" :class="{ on: mode === m.k }" :title="m.title"
              @click="$emit('update:mode', m.k); $emit('search', { mode: m.k, q: value })">{{ m.t }}</button>
    </div>
    <input v-model="value" :placeholder="ph" @input="onInput" @keyup.enter="$emit('search', { mode, q: value })">
  </div>
</template>

<script setup>
// 搜索框（v1.9.41）：四种模式 + 300ms 防抖。
// 防抖放在这里而不是父级 —— 输入框自己知道用户还在打字，父级只该收到「要搜什么」。
import { ref, computed, watch, onBeforeUnmount } from 'vue';

const props = defineProps({
  modelValue: { type: String, default: '' },
  mode: { type: String, default: 'keyword' },
});
const emit = defineEmits(['update:modelValue', 'update:mode', 'search']);

const MODES = [
  { k: 'keyword', t: '关键词', title: '标题 / 正文 / 标签模糊匹配' },
  { k: 'tag', t: '标签', title: '按标签精确找' },
  { k: 'path', t: '路径', title: '按所在文件夹找（含子文件夹）' },
  { k: 'regex', t: '正则', title: '高级：正则表达式（后台线程 + 硬超时）' },
];
const PH = {
  keyword: '搜索标题 / 正文 / 标签',
  tag: '标签名',
  path: '文件夹名（含子文件夹）',
  regex: '例如 量子(纠缠|计算)',
};
const ph = computed(() => PH[props.mode] || PH.keyword);

const value = ref(props.modelValue);
watch(() => props.modelValue, (v) => { if (v !== value.value) value.value = v; });

let timer = null;
function onInput() {
  emit('update:modelValue', value.value);
  clearTimeout(timer);
  timer = setTimeout(() => emit('search', { mode: props.mode, q: value.value }), 300);
}
onBeforeUnmount(() => clearTimeout(timer));
</script>

<style scoped>
.sbox { display: flex; flex-direction: column; gap: 5px; }
.modes { display: flex; gap: 2px; }
.modes button { flex: 1; font-size: 11px; padding: 2px 4px; border-radius: 5px; border: 1px solid var(--border); background: transparent; color: var(--text2); cursor: pointer; }
.modes button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
</style>
