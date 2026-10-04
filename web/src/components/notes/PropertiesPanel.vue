<template>
  <div class="props">
    <div v-for="d in defs" :key="d.id" class="prow">
      <label :title="d.key">{{ d.label || d.key }}</label>
      <template v-if="d.type === 'checkbox'">
        <input type="checkbox" :checked="isOn(d.key)" @change="$emit('set', d.key, $event.target.checked)">
      </template>
      <select v-else-if="d.type === 'select'" :value="val(d.key) ?? ''" @change="$emit('set', d.key, $event.target.value)">
        <option value="">（空）</option>
        <option v-for="o in d.options || []" :key="o" :value="o">{{ o }}</option>
      </select>
      <input v-else-if="d.type === 'number'" type="number" :value="val(d.key) ?? ''" @change="$emit('set', d.key, $event.target.value === '' ? '' : Number($event.target.value))">
      <input v-else-if="d.type === 'date'" type="date" :value="val(d.key) ?? ''" @change="$emit('set', d.key, $event.target.value)">
      <input v-else :value="val(d.key) ?? ''" @change="$emit('set', d.key, $event.target.value)">
    </div>

    <div v-if="orphanKeys.length" class="muted small" style="margin-top:8px">
      未定义但已填值的键：{{ orphanKeys.join('、') }}
    </div>
    <div v-if="!defs.length" class="muted small">还没有定义属性。<button class="small" style="margin-left:6px" @click="$emit('manage')">去定义</button></div>
  </div>
</template>

<script setup>
// 笔记属性（v1.9.41）：按「属性定义」渲染表单，值写进 notes.props（JSON）。
// 定义被删掉之后残留的键不隐藏也不强删 —— 用户没让删数据，就不该替他做决定。
import { computed } from 'vue';

const props = defineProps({
  defs: { type: Array, default: () => [] },
  values: { type: Object, default: () => ({}) },
});
defineEmits(['set', 'manage']);

const val = (k) => (props.values || {})[k];
const isOn = (k) => ['1', 'true', 'yes', '是', true].includes(val(k));
const orphanKeys = computed(() => {
  const known = new Set(props.defs.map((d) => d.key));
  return Object.keys(props.values || {}).filter((k) => !known.has(k) && props.values[k] !== '' && props.values[k] != null);
});
</script>

<style scoped>
.props { max-height: 100%; overflow-y: auto; }
.prow { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.prow label { flex: 0 0 74px; font-size: 12px; color: var(--text2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.prow input, .prow select { flex: 1; min-width: 0; font-size: 12.5px; padding: 3px 6px; }
.prow input[type=checkbox] { flex: 0 0 auto; width: 15px; height: 15px; }
</style>
