// 笔记模块的标签页列表（v1.9.41）——单例 store。
//
// 为什么是模块级单例而不是 provide/inject：标签页要跨「左栏 / 中间编辑区 / 右栏堆叠模式 /
// 命令面板 / 快捷键」五处读写，用 props 一层层往下传会迅速失控；这里没有多实例需求
// （笔记壳同一时刻只有一个），单例最省事也最不容易出「两个列表各说各话」的 bug。
//
// 标签形状：{ key, kind, noteId?, title, dirty, data? }
//   kind: note | rec | graph | timeline | query | stats | board | help
//   dirty 只对 note 有意义（未保存的正文改动），关页签/切路由时靠它拦一下。
import { ref, computed } from 'vue';

const tabs = ref([]);
const activeKey = ref('');
// 每篇笔记的正文就存在这里（按页签 key 索引）：切页签不重新拉、也不丢未保存的改动。
// 关页签时一并丢掉，避免整晚开着几十篇笔记把内存撑起来。
const docs = ref({});
let seq = 0;
const nextKey = () => `nt${++seq}`;

export function findTab(pred) { return tabs.value.find(pred); }

// 打开或激活一个「同一种东西只开一个」的页签（图普/统计/帮助/时间线这种）。
// data 参与去重：白板 A 与白板 B 是两个页签，但打开同一个白板不会开出第二个。
function openUnique(kind, { title, data } = {}) {
  const sig = data === undefined ? '' : JSON.stringify(data);
  const hit = tabs.value.find((t) => t.kind === kind && (t.sig || '') === sig);
  if (hit) { activeKey.value = hit.key; return hit; }
  const t = { key: nextKey(), kind, title: title || kind, dirty: false, sig };
  tabs.value.push(t);
  activeKey.value = t.key;
  return t;
}

// 打开一篇笔记（已在标签里就切过去，不重开）
function openNote(id, title) {
  const nid = Number(id);
  if (!Number.isFinite(nid)) return null;
  const hit = tabs.value.find((t) => t.kind === 'note' && t.noteId === nid);
  if (hit) {
    if (title && hit.title !== title) hit.title = title;
    activeKey.value = hit.key;
    return hit;
  }
  const t = { key: nextKey(), kind: 'note', noteId: nid, title: title || '未命名', dirty: false };
  tabs.value.push(t);
  activeKey.value = t.key;
  return t;
}

// 新建一篇还没有 id 的草稿页签（Ctrl+N / 未命中双链）
function openDraft(title) {
  const t = { key: nextKey(), kind: 'note', noteId: null, title: title || '未命名', dirty: true, draft: true };
  tabs.value.push(t);
  activeKey.value = t.key;
  return t;
}

function activate(key) {
  if (tabs.value.some((t) => t.key === key)) activeKey.value = key;
}

// 关闭一个页签，返回关闭后应该激活的 key（关掉当前页签 → 落到右邻居，没有右邻居取左邻居）
function close(key) {
  const i = tabs.value.findIndex((t) => t.key === key);
  if (i < 0) return activeKey.value;
  const wasActive = activeKey.value === key;
  tabs.value.splice(i, 1);
  delete docs.value[key];
  if (wasActive) activeKey.value = (tabs.value[i] || tabs.value[i - 1] || {}).key || '';
  return activeKey.value;
}

function setDoc(key, doc) { docs.value[key] = doc; }
function getDoc(key) { return docs.value[key] || null; }

function setDirty(key, dirty) {
  const t = tabs.value.find((x) => x.key === key);
  if (t) t.dirty = !!dirty;
}

function patchByNoteId(noteId, patch) {
  const nid = Number(noteId);
  for (const t of tabs.value) if (t.kind === 'note' && t.noteId === nid) Object.assign(t, patch);
}

export function useNotesTabs() {
  return {
    tabs,
    activeKey,
    active: computed(() => tabs.value.find((t) => t.key === activeKey.value) || null),
    activeIndex: computed(() => tabs.value.findIndex((t) => t.key === activeKey.value)),
    openNote,
    openDraft,
    openUnique,
    activate,
    close,
    setDirty,
    patchByNoteId,
    docs,
    setDoc,
    getDoc,
    closeAll: () => { tabs.value = []; docs.value = {}; activeKey.value = ''; },
    // 任何一篇笔记被删掉时，把它的页签一并关掉（否则会留下一个点开就 404 的空壳）
    closeNote: (noteId) => {
      const nid = Number(noteId);
      for (const t of tabs.value.filter((x) => x.kind === 'note' && x.noteId === nid)) close(t.key);
    },
    hasDirty: () => tabs.value.some((t) => t.dirty),
  };
}
