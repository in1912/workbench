<template>
  <div class="pinyin-mode">
    <div class="py-top">
      <div class="py-title">📜 {{ itemTitle }}</div>
      <div class="py-stats">
        <span>✅ {{ typedLetters }} / {{ totalLetters }}</span>
        <span>🔥 连击 {{ combo }}</span>
        <span>正确率 {{ accuracy }}%</span>
        <button v-if="kind === 'song'" class="py-mute" @click="toggleMelody">{{ melodyOn ? '🔊 伴奏开' : '🔇 伴奏关' }}</button>
      </div>
    </div>
    <div class="py-progress"><div class="fill" :style="{ width: progressPct }"></div></div>

    <div class="py-select">
      <template v-if="kind === 'poem'">
        <button v-for="lib in libs" :key="lib.key" :class="{ active: libKey === lib.key }" @click="switchLib(lib.key)">{{ lib.label }}</button>
      </template>
      <template v-else>
        <button v-for="c in libs" :key="c.key" :class="{ active: libKey === c.key }" @click="switchLib(c.key)">{{ c.label }}</button>
      </template>
      <span class="py-sep">|</span>
      <template v-if="libKey === 'mine'">
        <button v-for="(it, i) in items" :key="it.id" :class="{ active: i === itemIdx }" @click="loadItem(i)">{{ itemLabel(it) }}<i class="del" title="删除" @click.stop="removeItem(it)">✕</i></button>
        <span v-if="!items.length" class="py-empty">还没有导入内容，点右边「＋ 导入」试试</span>
      </template>
      <template v-else>
        <button v-for="(it, i) in items" :key="i" :class="{ active: i === itemIdx }" @click="loadItem(i)">{{ itemLabel(it) }}</button>
      </template>
      <button class="py-add" @click="showImport = true">＋ 导入</button>
    </div>

    <div v-if="libKey === 'mine' && !items.length" class="py-cells py-none">📥 还没有导入内容——点上方「＋ 导入」，粘贴你喜欢的{{ kind === 'poem' ? '诗词' : '歌词' }}就能练</div>
    <div v-else ref="scrollEl" class="py-cells" :class="{ done }">
      <div v-for="(u, i) in units" :key="i" class="cell" :class="{ cur: i === cur && !done, done: i < cur || done, skip: u.skip, err: errCell === i }">
        <span class="py">
          <template v-if="!u.skip">
            <i v-if="i < cur" class="typed">{{ u.p }}</i>
            <template v-else-if="i === cur"><i v-if="ci > 0" class="typed">{{ u.p.slice(0, ci) }}</i>{{ u.p.slice(ci) }}</template>
            <template v-else>{{ u.p }}</template>
          </template>
          <template v-else>&nbsp;</template>
        </span>
        <span class="hz">{{ u.h }}</span>
      </div>
    </div>

    <div v-if="done" class="py-result">{{ itemText }}</div>

    <div class="vkbd">
      <div v-for="(row, ri) in VKBD_ROWS" :key="ri" class="row">
        <div v-for="k in row" :key="k" class="key" :class="{ hit: vkHit === k }">{{ k.toUpperCase() }}</div>
      </div>
      <div class="row"><div class="key space" :class="{ hit: vkHit === ' ' }">SPACE</div></div>
    </div>

    <ImportDialog v-if="showImport" :kind="kind" @close="showImport = false" @saved="onImported" />
  </div>
</template>

<script setup>
import { computed, nextTick, onUnmounted, ref } from 'vue';
import { POEM_LIBS, SONG_CATS, parseUnits } from './content';
import { playCorrect, playError, playTone, startMelody } from './audio';
import { createTracker } from './tracker';
import { listImports, deleteImport } from './imports';
import ImportDialog from './ImportDialog.vue';

const props = defineProps({ kind: { type: String, default: 'poem' } });
const emit = defineEmits(['back']);
const tracker = createTracker(props.kind === 'poem' ? 'poetry' : 'lyrics');

// 「⭐ 我的」= 服务端导入内容（每人自己的）；条目映射成与内置库同构的形状
const baseLibs = props.kind === 'poem' ? POEM_LIBS : SONG_CATS;
const libKey = ref(baseLibs[0].key);
const myImports = ref([]);
const showImport = ref(false);
const myItems = computed(() => myImports.value.map((r) => (
  props.kind === 'poem'
    ? { id: r.id, title: r.title, author: r.subtitle || '自创', text: r.text, pinyin: r.pinyin }
    : { id: r.id, name: r.title, lyrics: r.text, pinyin: r.pinyin }
)));
const libs = computed(() => [...baseLibs, { key: 'mine', label: '⭐ 我的', [props.kind === 'poem' ? 'poems' : 'songs']: myItems.value }]);
const itemIdx = ref(0);
const units = ref([]);
const cur = ref(0);
const ci = ref(0);
const combo = ref(0);
const correctCnt = ref(0);
const wrongCnt = ref(0);
const done = ref(false);
const errCell = ref(-1);
const vkHit = ref('');
const melodyOn = ref(true);
const scrollEl = ref(null);
const VKBD_ROWS = [['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'], ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'], ['z', 'x', 'c', 'v', 'b', 'n', 'm']];

const items = computed(() => (libs.value.find((l) => l.key === libKey.value) || libs.value[0])[props.kind === 'poem' ? 'poems' : 'songs']);
const item = computed(() => items.value[itemIdx.value] || items.value[0]);
const itemTitle = computed(() => (item.value
  ? (props.kind === 'poem' ? `${item.value.title} · ${item.value.author}` : `🎵 ${item.value.name}`)
  : (props.kind === 'poem' ? '⭐ 我的诗词' : '⭐ 我的歌词')));
const itemText = computed(() => (item.value ? (props.kind === 'poem' ? item.value.text : item.value.lyrics) : ''));
const totalLetters = computed(() => units.value.reduce((a, u) => a + (u.skip ? 0 : u.p.length), 0));
const typedLetters = computed(() => {
  let n = 0;
  for (let i = 0; i < units.value.length; i++) {
    const u = units.value[i];
    if (u.skip) continue;
    if (i < cur.value) n += u.p.length;
    else if (i === cur.value) n += ci.value;
  }
  return n;
});
const progressPct = computed(() => (totalLetters.value ? Math.round((typedLetters.value / totalLetters.value) * 100) + '%' : '0%'));
const accuracy = computed(() => {
  const t = correctCnt.value + wrongCnt.value;
  return t ? Math.round((correctCnt.value / t) * 100) : 100;
});

let stopMelodyFn = null;
function stopMelody() { if (stopMelodyFn) { stopMelodyFn(); stopMelodyFn = null; } }
function startMelodyIfAny() {
  stopMelody();
  if (props.kind === 'song' && melodyOn.value && item.value && item.value.melody) stopMelodyFn = startMelody(item.value.melody);
}
function toggleMelody() { melodyOn.value = !melodyOn.value; startMelodyIfAny(); }

function itemLabel(it) { return props.kind === 'poem' ? it.title : it.name; }
function switchLib(key) { libKey.value = key; itemIdx.value = 0; loadItem(0); }

async function loadMine() {
  try { myImports.value = await listImports(props.kind); } catch { /* 拉不到不阻塞内置库练习 */ }
}
loadMine();

async function onImported() {
  showImport.value = false;
  await loadMine();
  libKey.value = 'mine';   // 新导入排在最前（服务端按 id 倒序）
  loadItem(0);
}

async function removeItem(it) {
  if (!window.confirm(`删除「${itemLabel(it)}」？`)) return;
  try { await deleteImport(it.id); } catch (e) { window.alert(e.message || '删除失败'); return; }
  await loadMine();
  if (libKey.value === 'mine') { itemIdx.value = 0; loadItem(0); }
}

function loadItem(idx) {
  itemIdx.value = idx;
  const it = items.value[idx] || items.value[0];
  if (!it) {  // 我的库可能为空：清场等待导入
    units.value = [];
    cur.value = 0;
    ci.value = 0;
    done.value = false;
    errCell.value = -1;
    stopMelody();
    return;
  }
  units.value = parseUnits(props.kind === 'poem' ? it.text : it.lyrics, it.pinyin);
  cur.value = 0;
  ci.value = 0;
  done.value = false;
  errCell.value = -1;
  // 跳过开头可能出现的标点
  while (units.value[cur.value] && units.value[cur.value].skip) cur.value++;
  startMelodyIfAny();
  nextTick(() => { if (scrollEl.value) scrollEl.value.scrollTop = 0; });
}

let restartTimer = null;
function onKey(e) {
  if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === 'Escape') { if (!showImport.value) emit('back'); return; }  // 弹窗开着时 Esc 只关弹窗（弹窗自己监听）
  if (done.value) return;
  const key = e.key.toLowerCase();
  if (key.length !== 1 || /[一-鿿]/.test(key)) return;
  vkHit.value = key;
  setTimeout(() => { if (vkHit.value === key) vkHit.value = ''; }, 120);
  const u = units.value[cur.value];
  if (!u) return;
  if (key === u.p[ci.value]) {
    correctCnt.value++;
    combo.value++;
    tracker.hit(true);
    playCorrect();
    playTone(523 + typedLetters.value * 3, 0.06, 0.08);
    ci.value++;
    if (ci.value >= u.p.length) {
      ci.value = 0;
      let n = cur.value + 1;
      while (units.value[n] && units.value[n].skip) n++;
      cur.value = n;
      if (n >= units.value.length) {
        done.value = true;
        tracker.flush();
        playTone(784, 0.15, 0.15);
        playTone(988, 0.2, 0.15, 'sine', 0.15);
        playTone(1175, 0.3, 0.15, 'sine', 0.35);
        stopMelody();
        restartTimer = setTimeout(() => loadItem(itemIdx.value), 3000);
        return;
      }
    }
    nextTick(() => {
      const el = scrollEl.value && scrollEl.value.querySelector('.cell.cur');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
    });
  } else {
    wrongCnt.value++;
    combo.value = 0;
    tracker.hit(false);
    playError();
    errCell.value = cur.value;
    setTimeout(() => { if (errCell.value === cur.value) errCell.value = -1; }, 300);
  }
}
window.addEventListener('keydown', onKey);
onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
  clearTimeout(restartTimer);
  stopMelody();
  tracker.dispose();
});

loadItem(0);
</script>

<style scoped>
.pinyin-mode { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.py-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 6px 2px; flex-wrap: wrap; }
.py-title { font-weight: 600; font-size: 15px; }
.py-stats { display: flex; gap: 14px; font-size: 13px; color: var(--text2); align-items: center; }
.py-mute { background: none; border: 1px solid var(--border); color: var(--text2); border-radius: 8px; padding: 2px 10px; font-size: 12px; cursor: pointer; }
.py-progress { height: 4px; background: var(--bg3); border-radius: 2px; overflow: hidden; margin-bottom: 8px; }
.py-progress .fill { height: 100%; background: linear-gradient(90deg, var(--amber), var(--accent)); transition: width .2s; }
.py-select { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; padding: 4px 0 10px; }
.py-select button { background: var(--bg3); color: var(--text2); border: 1px solid var(--border); padding: 3px 12px; border-radius: 12px; font-size: 12.5px; cursor: pointer; }
.py-select button:hover, .py-select button.active { color: var(--amber); border-color: var(--amber); background: rgba(251, 191, 36, .1); }
.py-sep { color: var(--text3); margin: 0 2px; }
.py-select button .del { font-style: normal; margin-left: 7px; color: var(--text3); font-size: 11px; }
.py-select button .del:hover { color: #ff6b6b; }
.py-select button.py-add { color: var(--accent); border-style: dashed; }
.py-empty { font-size: 12px; color: var(--text3); }
.py-none { display: flex; align-items: center; justify-content: center; color: var(--text3); font-size: 14px; }
.py-cells { flex: 1; min-height: 120px; overflow: auto; display: flex; flex-wrap: wrap; align-content: flex-start; justify-content: center; gap: 6px 8px; padding: 14px 6px; border: 1px dashed var(--border); border-radius: 10px; }
.cell { display: flex; flex-direction: column; align-items: center; min-width: 34px; padding: 3px 5px; border-radius: 8px; }
.cell .py { font-size: 12px; color: var(--text2); letter-spacing: 1px; min-height: 16px; font-family: Consolas, monospace; }
.cell .py .typed { font-style: normal; color: var(--text3); }
.cell .hz { font-size: 24px; font-weight: 700; line-height: 1.25; }
.cell.cur { background: rgba(251, 191, 36, .16); box-shadow: 0 0 0 1px var(--amber) inset; }
.cell.cur .hz { color: var(--amber); }
.cell.done .hz { color: var(--text3); }
.cell.done .py { color: var(--text3); }
.cell.skip { opacity: .55; }
.cell.skip .hz { font-size: 20px; }
.cell.err { animation: pyShake .3s; }
@keyframes pyShake { 0%,100% { transform: translateX(0) } 25% { transform: translateX(-4px) } 75% { transform: translateX(4px) } }
.py-cells.done { justify-content: center; align-content: center; }
.py-result { text-align: center; font-size: 20px; letter-spacing: 4px; line-height: 1.9; color: var(--amber); padding: 14px 0 4px; font-weight: 700; }
.vkbd { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 8px 0 2px; flex-shrink: 0; }
.vkbd .row { display: flex; gap: 4px; }
.vkbd .key { width: 46px; height: 42px; border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 14px; font-weight: 700; background: var(--bg3); border: 1px solid var(--border); color: var(--text2); transition: all .06s; }
.vkbd .key.space { width: 240px; font-size: 11px; }
.vkbd .key.hit { background: var(--amber); color: #1b1b1b; border-color: var(--amber); transform: scale(.88); }
</style>
