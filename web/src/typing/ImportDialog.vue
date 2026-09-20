<template>
  <div class="imp-mask" @click.self="$emit('close')">
    <div class="imp-dialog">
      <h3>📥 导入{{ meta.name }}</h3>
      <p class="imp-tip">{{ meta.tip }}</p>

      <label>{{ meta.titleLabel }}</label>
      <input v-model="title" maxlength="40" :placeholder="meta.titlePh" />

      <template v-if="kind !== 'game'">
        <label>{{ kind === 'poem' ? '作者' : '歌手' }}（可空）</label>
        <input v-model="subtitle" maxlength="40" :placeholder="kind === 'poem' ? '如：李白' : '如：儿歌合唱团'" />
      </template>

      <label>{{ kind === 'game' ? '练习内容（只支持英文字母和空格）' : '原文（粘贴' + (kind === 'poem' ? '诗文' : '歌词') + '，可换行）' }}</label>
      <textarea v-model="text" rows="6" :placeholder="meta.textPh"></textarea>
      <div class="imp-count">{{ kind === 'game' ? letterInfo : hanziInfo }}</div>

      <template v-if="kind !== 'game'">
        <label>
          逐字拼音（自动生成，可手工修正）
          <button class="imp-regen" @click="genPinyin(true)">🔄 重新生成</button>
        </label>
        <textarea v-model="py" rows="4" placeholder="粘贴原文后自动生成（无声调，ü 写作 v）" @input="pyDirty = true"></textarea>
      </template>

      <div v-if="err" class="imp-err">{{ err }}</div>
      <div class="imp-btns">
        <button class="ghost" @click="$emit('close')">取消</button>
        <button class="primary" :disabled="busy" @click="save">{{ busy ? '保存中…' : '💾 保存' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { pinyin } from 'pinyin-pro';
import { saveImport } from './imports';
import { parseUnits } from './content';

const props = defineProps({ kind: { type: String, required: true } });
const emit = defineEmits(['close', 'saved']);

const META = {
  game: { name: '游戏练习', tip: '游戏模式只能导入英文字母内容，导入后长期保存、随时选练。',
    titleLabel: '练习名称', titlePh: '如：我的字母操', textPh: '只支持英文字母，如 abc def ghi jkl mno…' },
  poem: { name: '古诗词', tip: '粘贴任意诗词原文，拼音自动生成（可修正），练完自动进入你的诗词库。',
    titleLabel: '诗词标题', titlePh: '如：静夜思', textPh: '粘贴诗文原文，如：床前明月光，疑是地上霜。' },
  song: { name: '歌词', tip: '粘贴任意歌词，拼音自动生成（可修正），练完自动进入你的歌词库。',
    titleLabel: '歌曲名', titlePh: '如：歌唱祖国', textPh: '粘贴歌词原文，可换行' },
};
const meta = META[props.kind];

const title = ref('');
const subtitle = ref('');
const text = ref('');
const py = ref('');   // 拼音串（名字避开 pinyin-pro 的 pinyin 导入）
const err = ref('');
const busy = ref(false);
let pyDirty = false;   // 手工改过拼音后不再随原文变动自动覆盖（点「重新生成」可恢复）

const letterCount = computed(() => (text.value.match(/[A-Za-z]/g) || []).length);
const letterInfo = computed(() => {
  if (!text.value.trim()) return '尚无内容';
  const extra = /[0-9一-鿿，。？！,.?!]/.test(text.value) ? '（非字母字符将无法导入）' : '';
  return `${letterCount.value} 个字母${extra}`;
});
const units = computed(() => (props.kind === 'game' ? [] : parseUnits(text.value, py.value)));
const hanziInfo = computed(() => {
  const n = units.value.filter((u) => !u.skip).length;
  if (!n) return text.value.trim() ? '未识别到汉字' : '尚无内容';
  return `${n} 个汉字 · ${units.value.reduce((a, u) => a + (u.skip ? 0 : u.p.length), 0)} 个拼音字母`;
});

// 原文变化 → 350ms 防抖自动重生成拼音（手工改过则不动，等「重新生成」）
let genTimer = null;
watch(text, () => {
  if (props.kind === 'game') return;
  clearTimeout(genTimer);
  genTimer = setTimeout(() => genPinyin(false), 350);
});
function genPinyin(force) {
  if (props.kind === 'game' || (!force && pyDirty) || !text.value.trim()) return;
  // type:'array' 逐字符对齐（标点/空格原样透传），join 后正是内置库的拼音串格式
  py.value = pinyin(text.value, { toneType: 'none', v: true, type: 'array' }).join(' ');
}

async function save() {
  err.value = '';
  if (!title.value.trim()) { err.value = '请填写标题'; return; }
  if (props.kind === 'game') {
    if (/[0-9]/.test(text.value) || !/^[A-Za-z\s]*$/.test(text.value)) { err.value = '游戏练习只能包含英文字母和空格'; return; }
    if (letterCount.value < 4) { err.value = '至少需要 4 个英文字母'; return; }
  } else {
    genPinyin(false);
    if (!py.value.trim()) { err.value = '拼音为空：请先粘贴原文（或点重新生成）'; return; }
  }
  busy.value = true;
  try {
    const r = await saveImport({ kind: props.kind, title: title.value, subtitle: subtitle.value, text: text.value, pinyin: py.value });
    emit('saved', { id: r.id });
  } catch (e) {
    err.value = e.message || '保存失败';
  } finally {
    busy.value = false;
  }
}

// Esc 关闭（父级模式层的 Esc 已对本弹窗让路，见各模式 onKey）
function onEsc(e) { if (e.key === 'Escape') emit('close'); }
onMounted(() => window.addEventListener('keydown', onEsc));
onUnmounted(() => { window.removeEventListener('keydown', onEsc); clearTimeout(genTimer); });
</script>

<style scoped>
.imp-mask { position: fixed; inset: 0; background: rgba(0, 0, 0, .55); z-index: 300; display: flex; align-items: center; justify-content: center; padding: 16px; }
.imp-dialog { background: var(--bg2); border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px; width: min(560px, 94vw); max-height: 88vh; overflow: auto; }
.imp-dialog h3 { font-size: 16px; margin-bottom: 4px; }
.imp-tip { font-size: 12px; color: var(--text3); margin: 0 0 10px; }
.imp-dialog label { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text2); margin: 10px 0 4px; }
.imp-dialog input, .imp-dialog textarea { width: 100%; background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; font-size: 13.5px; font-family: inherit; }
.imp-dialog textarea { resize: vertical; line-height: 1.7; }
.imp-dialog textarea:focus, .imp-dialog input:focus { outline: none; border-color: var(--amber); }
.imp-regen { margin-left: auto; background: none; border: 1px solid var(--border); color: var(--text2); border-radius: 8px; padding: 1px 10px; font-size: 12px; cursor: pointer; }
.imp-regen:hover { color: var(--amber); border-color: var(--amber); }
.imp-count { font-size: 12px; color: var(--text3); margin-top: 4px; }
.imp-err { color: #ff6b6b; font-size: 13px; margin-top: 10px; }
.imp-btns { display: flex; justify-content: flex-end; gap: 10px; margin-top: 14px; }
.imp-btns button { border-radius: 8px; padding: 6px 18px; font-size: 13.5px; cursor: pointer; }
.imp-btns .ghost { background: var(--bg3); color: var(--text2); border: 1px solid var(--border); }
.imp-btns .primary { background: var(--amber); color: #1b1b1b; border: none; font-weight: 600; }
.imp-btns .primary:disabled { opacity: .6; cursor: default; }
</style>
