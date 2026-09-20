<!-- 领养宠物面板：电子宠物模块「领养宠物」tab 的内容（领养入口回归页内 tab）。
     物种/花色小画布实时预览（自适应方块网格），支持共同/个人养育与自定义 GIF；
     领养成功后广播 wb-pets-refresh 并向父页面抛 adopted 事件（切回宠物列表）。 -->
<template>
  <div>
    <div v-if="msg" class="msg" :class="msgType">{{ msg }}</div>

    <div class="card" style="margin-bottom:14px">
      <h3>基本资料</h3>
      <div class="row" style="flex-wrap:wrap; align-items:flex-end; gap:10px">
        <label class="fld">名字
          <input v-model="form.name" maxlength="20" placeholder="给宠物起个名字" style="width:170px" @keyup.enter="createPet">
        </label>
        <label class="fld">养育方式
          <select v-model="form.raise_mode" style="width:190px">
            <option value="shared">共同养育（全员可见）</option>
            <option value="personal">个人养育（仅自己）</option>
          </select>
        </label>
        <label v-if="form.species === 'custom'" class="fld">GIF 动图
          <input type="file" accept="image/gif" @change="gifFile = $event.target.files[0] || null" style="max-width:230px; font-size:12px">
        </label>
        <button class="primary" :disabled="creating" @click="createPet">{{ creating ? '领养中…' : '带它回家 🐾' }}</button>
      </div>
      <div class="muted small" style="margin-top:8px">自定义宠物需上传 GIF（≤8MB），显示时强制固定宽高比；领养后到「我的宠物」tab 或右下角悬浮窗照顾它。</div>
    </div>

    <div class="card">
      <h3>选择物种
        <span class="muted small" style="font-weight:400">当前：{{ speciesLabel(form.species) }}{{ curSpeciesVariants.length > 1 && form.species !== 'custom' ? ' · ' + curVariantName : '' }}</span>
      </h3>
      <div class="species-grid">
        <div v-for="sp in SPECIES_LIST" :key="sp.key" class="species-item" :class="{ on: form.species === sp.key }" @click="pickSpecies(sp.key)">
          <div class="species-canvas">
            <PixelPet :species="sp.key" :variant="sp.key === form.species ? form.variant : 0" :size="1.7" :interactive="false" />
          </div>
          <div class="species-name">{{ sp.label }}</div>
        </div>
      </div>
      <div v-if="curSpeciesVariants.length > 1" class="row" style="gap:8px; margin-top:10px; flex-wrap:wrap">
        <span class="muted small">花色：</span>
        <button v-for="v in curSpeciesVariants" :key="v.index" class="small" :class="{ primary: form.variant === v.index }" @click="form.variant = v.index">{{ v.name }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue';
import PixelPet from './PixelPet.vue';
import { SPECIES_LIST } from '../pets/pixelSprites.js';

const emit = defineEmits(['adopted']);

const msg = ref(''), msgType = ref('ok');
const creating = ref(false);
const form = reactive({ name: '', species: 'dog', variant: 0, raise_mode: 'shared' });
const gifFile = ref(null);

const curSpeciesVariants = computed(() => SPECIES_LIST.find((s) => s.key === form.species)?.variants || []);
const curVariantName = computed(() => curSpeciesVariants.value.find((v) => v.index === form.variant)?.name || '');
function speciesLabel(key) { return SPECIES_LIST.find((s) => s.key === key)?.label || key; }
function pickSpecies(key) { form.species = key; form.variant = 0; gifFile.value = null; }

function say(text, type = 'ok') { msg.value = text; msgType.value = type; }

async function createPet() {
  if (!form.name.trim()) return say('先给宠物起个名字', 'err');
  if (form.species === 'custom' && !gifFile.value) return say('自定义宠物需上传 GIF 动图', 'err');
  creating.value = true;
  try {
    const fd = new FormData();
    fd.append('name', form.name.trim());
    fd.append('species', form.species);
    fd.append('variant', String(form.variant));
    fd.append('raise_mode', form.raise_mode);
    if (gifFile.value) fd.append('gif', gifFile.value);
    const res = await fetch('/api/pets', { method: 'POST', headers: { Authorization: `Bearer ${localStorage.getItem('wb_token')}` }, body: fd });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || '领养失败');
    window.dispatchEvent(new Event('wb-pets-refresh')); // 悬浮窗/宠物列表立即出现新宠物
    say(`「${form.name.trim()}」加入家庭！`);
    form.name = ''; gifFile.value = null;
    emit('adopted', d.id);
  } catch (e) { say(e.message, 'err'); }
  creating.value = false;
}
</script>

<style scoped>
.fld { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--text); }
/* 物种方块网格：宽屏多列并排，页面收缩时自动减列 */
.species-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 10px; }
.species-item { border: 1px solid var(--border); border-radius: 10px; padding: 8px 6px 6px; cursor: pointer; text-align: center;
  display: flex; flex-direction: column; align-items: center; gap: 4px; transition: border-color 0.15s, background 0.15s; }
.species-item:hover { border-color: rgba(79, 124, 247, 0.5); }
.species-item.on { border-color: rgba(79, 124, 247, 0.8); background: rgba(79, 124, 247, 0.1); }
.species-canvas { height: 74px; display: flex; align-items: flex-end; justify-content: center; }
.species-name { font-size: 11.5px; }
</style>
