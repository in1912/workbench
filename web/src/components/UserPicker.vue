<template>
  <div ref="root" class="upicker">
    <div class="up-box" @click="toggle">
      <span v-for="id in sel" :key="id" class="up-chip">
        {{ nameOf(id) }}<i class="up-x" @click.stop="remove(id)">✕</i>
      </span>
      <input
        ref="inputEl"
        v-model="q"
        class="up-input"
        :placeholder="sel.length ? '' : placeholder"
        @focus="open = true"
        @input="open = true"
        @keydown.enter.prevent="enterPick"
      />
    </div>
    <div v-if="open" class="up-drop">
      <!-- 纯 div 行 + 视觉勾选标记：整行（含勾选方块）点击都触发 pick，不用原生 label/checkbox，
           避免浏览器 label 转发点击造成勾选状态与实际选中不同步 -->
      <div v-for="u in filtered" :key="u.id" class="up-item" :class="{ on: sel.includes(u.id) }" @click="pick(u)">
        <span class="up-check" :class="{ on: sel.includes(u.id) }">{{ sel.includes(u.id) ? '✓' : '' }}</span>
        <span class="up-name">
          {{ nameOf(u) }}<span v-if="u.is_self" class="muted">（我）</span>
          <span v-if="subOf(u)" class="muted">（{{ subOf(u) }}）</span>
        </span>
        <span class="muted up-role">{{ u.role === 'admin' ? '管理员' : '成员' }}</span>
      </div>
      <div v-if="!filtered.length" class="muted" style="padding:8px 12px; font-size:12.5px">无匹配用户</div>
    </div>
  </div>
</template>

<script setup>
// 通用用户选择器：下拉 + 搜索过滤；multiple=true 多选（chips 可删），false 单选。
// users 数据源：GET /messages/contacts（全部系统用户，含自己，is_self 标记）。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';

const props = defineProps({
  users: { type: Array, default: () => [] },       // [{id, username, display_name, nickname, role, is_self, is_bot}]
  modelValue: { type: [Array, Number], default: () => [] }, // 多选: number[]；单选: id
  multiple: { type: Boolean, default: true },
  placeholder: { type: String, default: '搜索并选择用户…' },
  includeBots: { type: Boolean, default: false },  // 是否包含机器人虚拟成员（消息页回复钉钉用；推送选择器不含）
});
const emit = defineEmits(['update:modelValue']);

const open = ref(false);
const q = ref('');
const root = ref(null);
const inputEl = ref(null);

// 单选模式的 modelValue 是一个 number id（不是数组）。v1.9.31 只写了多选那一支，
// 单选恒回 []：选中后没有 chip、下拉里不打勾、占位文字也不消失——值其实发出去了，
// 但界面零反馈，看起来就是「点了勾不上」（v1.9.32 修）。这里统一成「已选 id 的数组」。
const sel = computed(() => {
  const v = props.modelValue;
  if (props.multiple) return Array.isArray(v) ? v.map(Number) : [];
  if (v === null || v === undefined || v === '') return [];
  const n = Number(v);
  return Number.isFinite(n) ? [n] : [];
});
const filtered = computed(() => {
  // users 非数组（调用方传错形状）时按空处理：渲染崩溃会表现为「下拉一点就消失」
  if (!Array.isArray(props.users)) return [];
  const pool = props.includeBots ? props.users : props.users.filter((u) => !u.is_bot);
  const kw = q.value.trim().toLowerCase();
  if (!kw) return pool;
  // 用户名 / 中文姓名 / 昵称 任一命中即可搜到
  return pool.filter((u) => [u.username, u.display_name, u.nickname].some((s) => String(s || '').toLowerCase().includes(kw)));
});

// 显示名：中文姓名优先，空则回退用户名
function nameOf(idOrUser) {
  const u = typeof idOrUser === 'object' ? idOrUser : props.users.find((x) => Number(x.id) === Number(idOrUser));
  if (!u) return typeof idOrUser === 'object' ? '用户' : `用户${idOrUser}`;
  return (u.display_name || '').trim() || u.username;
}
// 次要标注：有中文姓名且与用户名不同时括号补用户名；昵称存在则一并带出
function subOf(u) {
  const name = (u.display_name || '').trim();
  const parts = [];
  if (name && name !== u.username) parts.push(u.username);
  if ((u.nickname || '').trim()) parts.push(u.nickname.trim());
  return parts.join(' · ');
}
function toggle(e) {
  // 首击即消失的根因：点击落在输入框上时，focus 已把下拉打开，
  // 同一次点击再冒泡到这里取反会把刚打开的立即关掉——此时保持打开即可
  if (e && inputEl.value && e.target === inputEl.value) open.value = true;
  else open.value = !open.value;
  if (open.value) q.value = '';
}
function pick(u) {
  if (props.multiple) {
    const i = sel.value.indexOf(u.id);
    const next = sel.value.slice();
    if (i >= 0) next.splice(i, 1); else next.push(u.id);
    emit('update:modelValue', next);
  } else {
    emit('update:modelValue', u.id);
    open.value = false;
    q.value = '';
  }
}
function remove(id) {
  if (props.multiple) { emit('update:modelValue', sel.value.filter((x) => x !== id)); return; }
  // 单选：chip 上的 ✕ 就是「清空」——emit null 让上层回到「没选人」的显式状态
  q.value = '';
  emit('update:modelValue', null);
}
// 回车：列表只剩一个匹配时直接选中，方便键盘操作
function enterPick() {
  if (filtered.value.length === 1) pick(filtered.value[0]);
}
function onDoc(e) {
  if (root.value && !root.value.contains(e.target)) open.value = false;
}
onMounted(() => document.addEventListener('click', onDoc));
onBeforeUnmount(() => document.removeEventListener('click', onDoc));
</script>

<style scoped>
.upicker { position: relative; min-width: 220px; }
.up-box { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; border: 1px solid var(--border);
  border-radius: 8px; padding: 5px 8px; cursor: text; background: var(--bg2); min-height: 34px; }
.up-box:focus-within { border-color: rgba(79, 124, 247, 0.6); }
.up-chip { display: inline-flex; align-items: center; gap: 4px; background: rgba(79, 124, 247, 0.16);
  border-radius: 12px; padding: 1px 8px; font-size: 12px; }
.up-x { cursor: pointer; font-style: normal; opacity: 0.7; }
.up-x:hover { opacity: 1; }
.up-input { flex: 1; min-width: 90px; border: none; background: transparent; color: inherit; font-size: 13px; outline: none; }
.up-drop { position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 900; max-height: 240px; overflow-y: auto;
  background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 6px 20px rgba(0,0,0,0.28); }
.up-item { display: flex; align-items: center; gap: 8px; padding: 7px 12px; cursor: pointer; font-size: 13px; user-select: none; }
.up-item:hover, .up-item.on { background: rgba(79, 124, 247, 0.1); }
.up-check { flex-shrink: 0; width: 15px; height: 15px; border: 1.5px solid var(--border); border-radius: 4px;
  display: inline-flex; align-items: center; justify-content: center; font-size: 11px; color: #fff; line-height: 1; }
.up-check.on { background: rgba(79, 124, 247, 0.85); border-color: rgba(79, 124, 247, 0.85); }
.up-role { margin-left: auto; font-size: 11px; }
</style>
