<!-- 全局悬浮电子宠物：固定在页面右下角，闲置时上下漂浮；
     悬停展开环绕操作按钮（翻页/喂饭/喂水/零食/香蕉/苹果/铲屎/吃药/陪它玩）；
     粪便按编号黄金角铺满全屏互不重叠，点击一块铲一块（消耗铲屎额度）；
     每 60s 轮询状态。无宠物时显示引导入口。 -->
<template>
  <!-- 还没有宠物：右下角引导 -->
  <div v-if="!loading && pets.length === 0" class="pet-entry" @click="$router.push({ path: '/pets', query: { tab: 'adopt' } })" title="去领养一只电子宠物">
    <span class="paw">🐾</span>
    <span class="paw-txt">领养电子宠物</span>
  </div>

  <template v-if="current">
    <!-- 粪便覆盖层（当前宠物的，编号决定屏幕槽位，互不重叠） -->
    <img
      v-for="p in poopItems" :key="p.id" class="poop" :style="p.style"
      :src="poopImg" :title="`粪便 #${p.id} · 剩余额度 ${credits} 次`"
      @click="scoop(p)"
    />

    <!-- 悬浮宠物本体（按住拖动可改变位置，松手后按用户保存） -->
    <div ref="rootEl" class="float-pet" :class="{ hover: hover || playMenu || typeMenu, sick: current.sick && !current.is_dead, dead: current.is_dead, drag: dragging }"
         :style="posStyle" title="按住拖动可改变位置"
         @mouseenter="hover = true" @mouseleave="hover = false"
         @pointerdown="onDragStart" @pointermove="onDragMove" @pointerup="onDragEnd" @pointercancel="onDragEnd">
      <div class="bob">
        <!-- 已去世：像素十字架墓碑（无互动） -->
        <PixelCross v-if="current.is_dead" :size="4" />
        <PixelPet v-else ref="petRef" :species="current.species" :variant="current.variant"
                  :sick="current.sick" :rings="current.rings" :gif="gifUrl" :size="3.5" @hit="onHit" />
      </div>
      <div class="pet-tag">
        <b>{{ current.name }}</b>
        <span class="mmini">{{ currentIndex + 1 }}/{{ pets.length }}</span>
        <template v-if="current.is_dead">
          <span class="mmini dead">🕯 已去世 {{ (current.dead_at || '').slice(5, 10) }}</span>
        </template>
        <template v-else>
          <span class="mmini" title="好感度">❤ {{ current.my.affection }}</span>
          <span class="mmini" title="剩余铲屎额度">🧹{{ credits }}</span>
          <span v-if="current.sick" class="mmini sick">生病了</span>
        </template>
      </div>

      <!-- 环绕按钮（悬停显示，弧形分布在宠物上方） -->
      <transition name="orbit-pop">
        <div v-if="hover || playMenu" class="orbit" :class="{ busy }">
          <button v-for="(b, i) in orbitButtons" :key="b.label" class="obtn"
                  :style="orbitStyle(i, orbitButtons.length)" :class="{ dis: b.dis }"
                  :title="b.tip || b.label" @click.stop="b.run">
            <span class="oi">{{ b.icon }}</span>
            <span class="ol">{{ b.label }}</span>
            <span v-if="b.badge != null" class="ob">{{ b.badge }}</span>
          </button>
        </div>
      </transition>

      <!-- 陪它玩子菜单 -->
      <transition name="orbit-pop">
        <div v-if="playMenu" class="play-menu">
          <button v-for="g in PLAY_GAMES" :key="g.item" @click.stop="doPlay(g.item)">
            <span class="oi">{{ g.icon }}</span>{{ g.label }}
          </button>
        </div>
      </transition>

      <!-- 打字喂养子菜单：输入口令触发对应互动，不占按钮次数 -->
      <transition name="orbit-pop">
        <div v-if="typeMenu" class="play-menu type-menu" :class="{ 'tm-right': typeSide === 'right' }" @pointerdown.stop>
          <div class="tm-title">打字互动<span class="mmini">输对口令就算一次，不占按钮次数</span></div>
          <div class="tm-word">口令：<b>{{ typeWord }}</b><span class="mmini">（{{ TYPED_WORDS[typeKey].label }}）</span></div>
          <input ref="typeInputEl" v-model="typeVal" class="tm-input" placeholder="输入上面的口令"
                 @keyup.enter="submitTyped" @keydown.stop>
          <div v-if="typeErr" class="tm-err">{{ typeErr }}</div>
          <div class="row" style="gap:6px; margin-top:6px">
            <button style="flex:1" @click.stop="submitTyped">确定</button>
            <button title="换一个口令" @click.stop="rollTypeTarget">↻</button>
          </div>
          <div class="mmini" style="margin-top:6px">今日剩余：{{ typedLeftText }}</div>
        </div>
      </transition>
    </div>

    <!-- 轻提示 -->
    <div class="pet-toasts">
      <div v-for="t in toasts" :key="t.id" class="pet-toast" :class="t.kind">{{ t.text }}</div>
    </div>
  </template>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { api } from '../api';
import PixelPet from './PixelPet.vue';
import PixelCross from './PixelCross.vue';
import { SPRITES } from '../pets/pixelSprites.js';

const router = useRouter();
const petRef = ref(null);

// ---------- 状态 ----------
const pets = ref([]);
const config = ref({});
const checkin = ref({ today: false, streak: 0 });
const loading = ref(true);
const currentIndex = ref(Number(localStorage.getItem('wb_pet_idx') || 0) || 0);
const hover = ref(false);
const playMenu = ref(false);
const busy = ref(false);
const toasts = reactive([]);
const gifCache = new Map(); // petId -> objectURL

const PLAY_GAMES = [
  { item: 'yarn', label: '玩毛线球', icon: '🧶' },
  { item: 'blocks', label: '玩积木', icon: '🧱' },
  { item: 'train', label: '玩电动火车', icon: '🚂' },
  { item: 'cooking', label: '玩做饭游戏', icon: '🍳' },
];
const PLAY_ANIMS = { yarn: 'playYarn', blocks: 'playBlocks', train: 'playTrain', cooking: 'playCooking' };
const FOOD_ANIMS = { rice: 'feed', snack: 'feed', banana: 'feed', apple: 'feed' };

// ---------- 打字喂养：输对口令触发对应互动（不占按钮次数，每类每天另有 typing_daily_limit 次） ----------
const typeMenu = ref(false), typeVal = ref(''), typeErr = ref(''), typeKey = ref('rice'), typeWord = ref('');
const typeSide = ref('left'); // 面板展开侧：跟随宠物在屏幕左右哪边更空
const typeInputEl = ref(null);
const TYPED_WORDS = {
  rice:  { label: '喂饭', body: { type: 'food', item: 'rice', typed: true }, anim: 'feed', words: ['吃饭啦', '开饭咯', '吃香喷喷的米饭'] },
  water: { label: '喂水', body: { type: 'water', typed: true }, anim: 'water', words: ['多喝水', '咕咚咕咚喝水', '喝点水'] },
  snack: { label: '零食', body: { type: 'food', item: 'snack', typed: true }, anim: 'feed', words: ['吃零食', '零食时间到', '来点小零食'] },
  play:  { label: '玩耍', body: { type: 'play', item: 'yarn', typed: true }, anim: 'playYarn', words: ['一起玩吧', '陪我玩', '玩耍时间到'] },
};
function rollTypeTarget() {
  const lim = config.value.typing_daily_limit ?? 3;
  const used = current.value?.my?.today_typed || {};
  const keys = Object.keys(TYPED_WORDS);
  const left = keys.filter((k) => (used[k] || 0) < lim);
  const pool = left.length ? left : keys; // 全用完也给词，提交时服务端会提示次数已满
  typeKey.value = pool[Math.floor(Math.random() * pool.length)];
  const ws = TYPED_WORDS[typeKey.value].words;
  typeWord.value = ws[Math.floor(Math.random() * ws.length)];
  typeVal.value = '';
  typeErr.value = '';
  nextTick(() => typeInputEl.value?.focus());
}
const typedLeftText = computed(() => {
  const used = current.value?.my?.today_typed || {};
  const lim = config.value.typing_daily_limit ?? 3;
  return Object.entries(TYPED_WORDS).map(([k, v]) => `${v.label} ${Math.max(0, lim - (used[k] || 0))}`).join(' · ');
});
async function submitTyped() {
  if (busy.value || !current.value) return;
  const v = typeVal.value.trim();
  if (!v) return;
  if (v !== typeWord.value) {
    rollTypeTarget(); // 先换词（内部会清提示），再落错误提示
    typeErr.value = '口令不对，换一个再试试～';
    return;
  }
  const t = TYPED_WORDS[typeKey.value];
  await act({ ...t.body }, async () => {
    await petRef.value?.playAnim(t.anim, t.body.item);
    if (t.anim === 'feed') await petRef.value?.playAnim('happyJump'); // 吃完开心蹦跳
  }, `打对了！${t.label}成功，不占按钮次数`);
  typeMenu.value = false;
}

const current = computed(() => {
  if (!pets.value.length) return null;
  const i = Math.min(currentIndex.value, pets.value.length - 1);
  return pets.value[i];
});
const credits = computed(() => (current.value ? current.value.my.scoop_credits : 0));
const gifUrl = computed(() => (current.value && current.value.has_gif ? gifCache.get(current.value.id) || '' : ''));

// ---------- 悬浮宠物位置：默认右下（左移避开页面按钮），按住拖动后按用户保存 ----------
const rootEl = ref(null);
const petPos = ref(null);   // 已保存位置 {right, bottom}（相对视口右/下边缘）
const dragPos = ref(null);  // 拖动中的 {left, top}
const dragging = ref(false);
let dragId = null, dragRect = null, dragMoved = false;
const posStyle = computed(() => {
  if (dragPos.value) return { left: dragPos.value.left + 'px', top: dragPos.value.top + 'px', right: 'auto', bottom: 'auto' };
  if (petPos.value) return { right: petPos.value.right + 'px', bottom: petPos.value.bottom + 'px' };
  return {};
});
function localPosKey() {
  const u = JSON.parse(localStorage.getItem('wb_user') || 'null');
  return u ? 'wb_pet_pos_' + u.id : '';
}
function loadLocalPos() {
  const k = localPosKey();
  if (!k) return;
  try {
    const p = JSON.parse(localStorage.getItem(k) || 'null');
    if (p && Number.isFinite(p.right) && Number.isFinite(p.bottom)) petPos.value = p;
  } catch { /* 忽略坏数据 */ }
}
function savePetPos(pos) {
  const k = localPosKey();
  if (k) localStorage.setItem(k, JSON.stringify(pos));
  api.put('/pets/ui-pos', pos).catch(() => {}); // 服务端也存一份：换设备登录同样恢复
}
// 超过 6px 才算拖动（点击/摸头不受影响）；移动超过阈值后再捕获指针，避免吞掉环绕按钮的 click
function onDragStart(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  dragId = e.pointerId;
  dragMoved = false;
  const el = rootEl.value;
  if (el) dragRect = { start: { x: e.clientX, y: e.clientY }, rect: el.getBoundingClientRect() };
}
function onDragMove(e) {
  if (dragId === null || !dragRect) return;
  const dx = e.clientX - dragRect.start.x, dy = e.clientY - dragRect.start.y;
  if (!dragMoved) {
    if (Math.hypot(dx, dy) < 6) return;
    dragMoved = true;
    dragging.value = true;
    try { rootEl.value?.setPointerCapture(e.pointerId); } catch { /* 拖出窗口也能继续跟 */ }
  }
  const { width: w, height: h } = dragRect.rect;
  dragPos.value = {
    left: Math.max(0, Math.min(window.innerWidth - w, dragRect.rect.left + dx)),
    top: Math.max(0, Math.min(window.innerHeight - h, dragRect.rect.top + dy)),
  };
}
function onDragEnd() {
  if (dragId === null) return;
  dragId = null;
  dragRect = null;
  if (!dragMoved) return;
  dragging.value = false;
  const r = rootEl.value?.getBoundingClientRect();
  dragPos.value = null;
  if (r) {
    petPos.value = { right: Math.round(window.innerWidth - r.right), bottom: Math.round(window.innerHeight - r.bottom) };
    savePetPos(petPos.value);
  }
  setTimeout(() => { dragMoved = false; }, 60); // 吞掉拖动结束时误触的摸头 click
}

// ---------- 拉取状态 ----------
async function refresh() {
  if (!localStorage.getItem('wb_token')) return;
  try {
    const d = await api.get('/pets/state');
    pets.value = d.pets || [];
    config.value = d.config || {};
    checkin.value = d.checkin || { today: false, streak: 0 };
    if (!petPos.value && d.ui) petPos.value = d.ui; // 本机没存过时用服务端保存的位置（换设备恢复）
    // 编号越界时回落；持久化上次选择
    if (currentIndex.value >= pets.value.length) currentIndex.value = 0;
    if (current.value && current.value.has_gif) loadGif(current.value.id);
  } catch { /* 无权限/离线时静默 */ }
  loading.value = false;
}
// GIF 走鉴权下载（<img> 直链带不上 Bearer 头），按宠物缓存 objectURL
async function loadGif(petId) {
  if (gifCache.has(petId)) return gifCache.get(petId);
  try {
    const res = await fetch(`/api/pets/${petId}/gif`, { headers: { Authorization: `Bearer ${localStorage.getItem('wb_token')}` } });
    if (!res.ok) return '';
    const url = URL.createObjectURL(await res.blob());
    gifCache.set(petId, url);
    return url;
  } catch { return ''; }
}
watch(currentIndex, (i) => localStorage.setItem('wb_pet_idx', String(i)));
watch(() => current.value && current.value.id, (id) => { if (id && current.value.has_gif) loadGif(id); });

let timer = 0;
onMounted(() => {
  loadLocalPos(); // 先用本机保存的位置，避免加载后跳一下
  refresh();
  timer = setInterval(refresh, 60000);
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('wb-pets-refresh', refresh); // 宠物页操作后立即同步
});
onBeforeUnmount(() => {
  clearInterval(timer);
  document.removeEventListener('visibilitychange', onVis);
  window.removeEventListener('wb-pets-refresh', refresh);
});
const onVis = () => { if (!document.hidden) refresh(); };

// ---------- 轻提示 ----------
let toastSeq = 0;
function toast(text, kind = 'ok') {
  const id = ++toastSeq;
  toasts.push({ id, text, kind });
  setTimeout(() => {
    const i = toasts.findIndex((t) => t.id === id);
    if (i >= 0) toasts.splice(i, 1);
  }, 2600);
}

// ---------- 环绕按钮 ----------
function cyclePet() {
  if (pets.value.length < 2) return;
  currentIndex.value = (currentIndex.value + 1) % pets.value.length;
  toast(`切换到「${current.value.name}」`);
}
async function doFeed(item) {
  await act({ type: 'food', item }, async () => {
    await petRef.value?.playAnim(FOOD_ANIMS[item] || 'feed', item);
    await petRef.value?.playAnim('happyJump'); // 吃完开心蹦跳
  }, `喂了${FOOD_NAMES[item] || '食物'}，铲屎额度 +${item === 'rice' ? 3 : 3}`);
}
async function doWater() {
  await act({ type: 'water' }, () => petRef.value?.playAnim('water'), '喂了水，铲屎额度 +1');
}
async function doMedicine() {
  await act({ type: 'medicine' }, () => petRef.value?.playAnim('medicine'), '药到病除，恢复健康！');
}
async function doPlay(item) {
  playMenu.value = false;
  await act({ type: 'play', item }, () => petRef.value?.playAnim(PLAY_ANIMS[item] || 'playYarn'), '玩得很开心，好感度 +0.03');
}
async function scoop(p) {
  if (!current.value) return;
  if (credits.value <= 0) return toast('铲屎额度不足：喂饭 +3 次、喂水 +1 次', 'err');
  await act({ type: 'scoop', poop_id: p.id }, () => petRef.value?.playAnim('reactPaw'), `铲掉了粪便 #${p.id}`);
}
// 统一动作：先请求（冷却/上限校验在服务端），成功后播放动画并刷新
async function act(body, anim, okMsg) {
  if (busy.value || !current.value) return;
  busy.value = true;
  try {
    const r = await api.post(`/pets/${current.value.id}/action`, body);
    if (r.pet) {
      const i = pets.value.findIndex((x) => x.id === r.pet.id);
      if (i >= 0) pets.value[i] = r.pet;
    }
    if (anim) await anim();
    if (okMsg) toast(okMsg);
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    busy.value = false;
  }
}

const FOOD_NAMES = { rice: '饭', snack: '零食', banana: '香蕉', apple: '苹果' };
const orbitButtons = computed(() => {
  const c = current.value;
  if (!c) return [];
  // 已去世：只剩翻页（其余操作在服务端也会被拦）
  if (c.is_dead) {
    return [{ icon: '🔄', label: '翻页', run: cyclePet, show: pets.value.length > 1, tip: '切换到下一只宠物' }].filter((b) => b.show !== false);
  }
  const list = [
    { icon: '🔄', label: '翻页', run: cyclePet, show: pets.value.length > 1, tip: '切换到下一只宠物' },
    { icon: '🍚', label: '喂饭', run: () => doFeed('rice'), dis: c.my.food_cooldown > 0, tip: c.my.food_cooldown > 0 ? `吃太饱了，${fmtCool(c.my.food_cooldown)}后再喂` : `今日已喂 ${c.my.today_food} 次` },
    { icon: '💧', label: '喂水', run: doWater, dis: c.my.water_cooldown > 0, tip: c.my.water_cooldown > 0 ? `刚喝过水，${fmtCool(c.my.water_cooldown)}后再喂` : `今日已喂水 ${c.my.today_water} 次` },
    { icon: '🦴', label: '零食', run: () => doFeed('snack'), dis: c.my.food_cooldown > 0, tip: '零食和饭共用冷却' },
    { icon: '🍌', label: '香蕉', run: () => doFeed('banana'), dis: c.my.food_cooldown > 0, tip: '香蕉和饭共用冷却' },
    { icon: '🍎', label: '苹果', run: () => doFeed('apple'), dis: c.my.food_cooldown > 0, tip: '苹果和饭共用冷却' },
    { icon: '🧹', label: '铲屎', run: () => toast(credits.value > 0 ? '点击屏幕上的粪便即可铲走一块' : '铲屎额度不足：喂饭 +3、喂水 +1'), badge: credits.value, tip: '剩余铲屎额度' },
    { icon: '💊', label: '吃药', run: doMedicine, show: c.sick, tip: '给生病的它喂药' },
    { icon: '🎮', label: '陪它玩', run: () => { playMenu.value = !playMenu.value; if (playMenu.value) typeMenu.value = false; }, tip: `今日已玩 ${c.my.today_play} 次` },
    { icon: '⌨', label: '打字', run: () => {
      typeMenu.value = !typeMenu.value;
      if (typeMenu.value) {
        playMenu.value = false;
        const r = rootEl.value?.getBoundingClientRect(); // 面板朝屏幕更空的一侧展开，防止被裁切
        typeSide.value = r && r.left > window.innerWidth - r.right ? 'left' : 'right';
        rollTypeTarget();
      }
    }, tip: '输入口令喂养：输对了不占按钮次数' },
  ];
  return list.filter((b) => b.show !== false);
});
function fmtCool(sec) {
  if (sec >= 3600) return `${Math.ceil(sec / 3600)} 小时`;
  if (sec >= 60) return `${Math.ceil(sec / 60)} 分钟`;
  return `${sec} 秒`;
}
// 弧形分布在宠物上方（180°→360° 半圆）
function orbitStyle(i, n) {
  const deg = 180 + (n === 1 ? 90 : (i * 180) / (n - 1));
  const rad = (deg * Math.PI) / 180;
  const r = 96;
  return {
    transform: `translate(calc(-50% + ${Math.round(Math.cos(rad) * r)}px), calc(-50% + ${Math.round(Math.sin(rad) * r)}px))`,
    transitionDelay: `${i * 30}ms`,
  };
}

// ---------- 粪便槽位：编号 → 黄金角向日葵分布（互不重叠、稳定不漂移） ----------
const poopImg = makeSprite('poop', 4);
function makeSprite(key, scale) {
  const sp = SPRITES[key];
  const c = document.createElement('canvas');
  c.width = sp.grid[0].length * scale;
  c.height = sp.grid.length * scale;
  const g = c.getContext('2d');
  sp.grid.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === '.') return;
    g.fillStyle = sp.palette[ch] || '#000';
    g.fillRect(x * scale, y * scale, scale, scale);
  }));
  return c.toDataURL();
}
const poopItems = computed(() => {
  const c = current.value;
  if (!c || !c.poops || !c.poops.length) return [];
  const vw = window.innerWidth, vh = window.innerHeight;
  const cx = vw / 2, cy = vh / 2;
  return c.poops.map((id) => {
    const r = 90 + 34 * Math.sqrt(id);
    const a = id * 2.39996; // 黄金角
    let x = cx + r * Math.cos(a);
    let y = cy + r * Math.sin(a);
    x = Math.max(16, Math.min(vw - 60, x));
    y = Math.max(66, Math.min(vh - 100, y));
    // 避开右下角宠物本体区
    if (x > vw - 210 && y > vh - 210) x -= 220;
    return { id, style: { left: Math.round(x) + 'px', top: Math.round(y) + 'px' } };
  });
});

// ---------- 点击宠物本体 ----------
function onHit(area, label) {
  if (dragMoved || dragging.value) return; // 刚拖完的一次 click 不算摸头
  if (area !== 'miss' && area !== 'tail') toast(`摸了摸${label || '它'}`);
}
</script>

<style scoped>
/* 无宠物引导 */
.pet-entry { position: fixed; right: 22px; bottom: 22px; z-index: 1100; display: flex; align-items: center; gap: 8px;
  padding: 10px 14px; border-radius: 999px; border: 1px solid var(--border); background: var(--bg2);
  box-shadow: 0 6px 20px rgba(0,0,0,0.22); cursor: pointer; font-size: 13px; }
.pet-entry:hover { border-color: rgba(79,124,247,0.5); }
.pet-entry .paw { font-size: 22px; animation: paw-bob 2.2s ease-in-out infinite; }
@keyframes paw-bob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-5px) } }

/* 悬浮宠物（默认位置右下角略左移：不挡页面右下角按钮，环绕按钮也不被屏幕右缘裁切；
   用户按住拖动后的位置由行内样式覆盖并按用户保存） */
.float-pet { position: fixed; right: 64px; bottom: 24px; z-index: 1150; width: 150px; cursor: grab; touch-action: none; user-select: none; }
.float-pet.drag { cursor: grabbing; }
.float-pet.drag .bob { animation: none; } /* 拖动时停止漂浮，跟手 */
.bob { animation: pet-bob 2.6s ease-in-out infinite; }
.float-pet.sick .bob { animation-duration: 5s; } /* 生病时漂浮变迟缓 */
@keyframes pet-bob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-7px) } }
.pet-tag { display: flex; align-items: center; justify-content: center; gap: 6px; flex-wrap: wrap;
  font-size: 11.5px; color: var(--text); background: var(--bg2); border: 1px solid var(--border);
  border-radius: 8px; padding: 3px 8px; box-shadow: 0 4px 14px rgba(0,0,0,0.18); }
.mmini { font-size: 10.5px; opacity: 0.75; }
.mmini.sick { color: #e87070; opacity: 1; }
.mmini.dead { color: #b8bec6; opacity: 1; }
/* 去世：漂浮停止，静止的墓碑 */
.float-pet.dead .bob { animation: none; }

/* 环绕按钮 */
.orbit { position: absolute; left: 50%; top: 46%; width: 0; height: 0; }
.orbit.busy { pointer-events: none; }
.obtn { position: absolute; left: 0; top: 0; width: 46px; height: 46px; border-radius: 50%;
  border: 1px solid var(--border); background: var(--bg2); color: var(--text); cursor: pointer;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0;
  box-shadow: 0 4px 12px rgba(0,0,0,0.25); transition: border-color 0.15s, transform 0.15s; }
.obtn:hover { border-color: rgba(79,124,247,0.6); }
.obtn .oi { font-size: 17px; line-height: 1; }
.obtn .ol { font-size: 8.5px; opacity: 0.75; margin-top: 2px; }
.obtn .ob { position: absolute; right: -4px; top: -4px; min-width: 16px; height: 16px; border-radius: 8px;
  background: #4f7cf7; color: #fff; font-size: 10px; line-height: 16px; padding: 0 3px; }
.obtn.dis { opacity: 0.45; }
.orbit-pop-enter-active, .orbit-pop-leave-active { transition: opacity 0.18s; }
.orbit-pop-enter-from, .orbit-pop-leave-to { opacity: 0; }

/* 陪它玩子菜单 */
.play-menu { position: absolute; left: 50%; top: 20%; transform: translateX(-50%);
  display: flex; flex-direction: column; gap: 6px; background: var(--bg2); border: 1px solid var(--border);
  border-radius: 10px; padding: 8px; box-shadow: 0 8px 24px rgba(0,0,0,0.3); }
.play-menu button { display: flex; align-items: center; gap: 8px; border: none; background: transparent;
  color: var(--text); font-size: 12.5px; padding: 6px 10px; border-radius: 7px; cursor: pointer; white-space: nowrap; }
.play-menu button:hover { background: rgba(79,124,247,0.14); }

/* 打字喂养面板：放在宠物左侧，避开宠物本体与上方弧形环绕按钮（弧最左端到 -44px，留 56px） */
.type-menu { width: 224px; left: -56px; top: 46%; transform: translate(-100%, -50%); }
.type-menu.tm-right { left: auto; right: -56px; transform: translate(100%, -50%); }
.tm-title { font-size: 12.5px; font-weight: 700; display: flex; flex-direction: column; gap: 2px; padding: 0 2px; }
.tm-word { font-size: 14px; margin: 7px 0; padding: 0 2px; }
.tm-word b { color: #f0c674; }
.tm-input { width: 100%; padding: 6px 9px; border-radius: 7px; border: 1px solid var(--border);
  background: var(--bg, #222); color: var(--text, #eee); font-size: 13px; }
.tm-input:focus { outline: none; border-color: rgba(79,124,247,0.65); }
.tm-err { font-size: 11px; color: #e87070; margin-top: 4px; padding: 0 2px; }

/* 粪便 */
.poop { position: fixed; z-index: 1140; width: 28px; height: 24px; cursor: pointer;
  filter: drop-shadow(1px 2px 1px rgba(0,0,0,0.25)); animation: poop-idle 3s ease-in-out infinite; }
.poop:hover { animation: poop-wig 0.4s ease-in-out infinite; filter: drop-shadow(0 0 4px rgba(255,229,138,0.9)); }
@keyframes poop-idle { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-2px) } }
@keyframes poop-wig { 0%,100% { transform: rotate(-8deg) } 50% { transform: rotate(8deg) } }

/* 轻提示 */
.pet-toasts { position: fixed; right: 24px; bottom: 200px; z-index: 1160; display: flex; flex-direction: column;
  gap: 6px; align-items: flex-end; pointer-events: none; }
.pet-toast { max-width: 240px; padding: 7px 12px; border-radius: 9px; font-size: 12.5px;
  background: var(--bg2); border: 1px solid var(--border); box-shadow: 0 6px 18px rgba(0,0,0,0.28); }
.pet-toast.err { border-color: rgba(232,112,112,0.6); color: #e87070; }
</style>
