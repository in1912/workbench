<template>
  <div class="game-mode">
    <div class="gm-top">
      <span>🎯 正确率 {{ accuracy }}%</span>
      <span>⚡ WPM {{ wpm }}</span>
      <span>🔥 连击 {{ combo }}</span>
      <span>✅ {{ correct }} / {{ total }}</span>
    </div>
    <div class="gm-progress"><div class="fill" :style="{ width: progressPct }"></div></div>
    <div class="gm-text"><span v-for="(c, i) in chars" :key="i" class="char" :class="{ done: i < idx, current: i === idx }">{{ c }}</span></div>
    <div ref="wrapEl" class="gm-ground">
      <canvas ref="canvasEl"></canvas>
      <div class="gm-mine">
        <div class="gm-mine-head">
          <span>📦 我的练习</span>
          <button class="imp" @click="showImport = true">＋ 导入</button>
        </div>
        <div v-if="mine.length" class="gm-chips">
          <button v-for="m in mine" :key="m.id" :class="{ active: selectedId === m.id }" :title="m.text" @click="playMine(m)">{{ m.title }}<i class="del" title="删除" @click.stop="removeMine(m)">✕</i></button>
        </div>
        <div v-else class="gm-empty">还没有导入的字母练习</div>
        <textarea v-model="customText" class="gm-custom" placeholder="⌨ 临时练习（只认英文字母）｜导入的内容长期保存" rows="2"></textarea>
      </div>
    </div>

    <ImportDialog v-if="showImport" kind="game" @close="showImport = false" @saved="onImported" />
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { GAME_DEFAULT_TEXT } from './content';
import { playCorrect, playError } from './audio';
import { createTracker } from './tracker';
import { listImports, deleteImport } from './imports';
import ImportDialog from './ImportDialog.vue';

const emit = defineEmits(['back']);
const tracker = createTracker('game');

const canvasEl = ref(null);
const wrapEl = ref(null);
const customText = ref('');
const mine = ref([]);
const selectedId = ref(null);
const showImport = ref(false);
const selectedItem = computed(() => mine.value.find((m) => m.id === selectedId.value) || null);
const chars = ref([]);
const idx = ref(0);
const correct = ref(0);
const wrong = ref(0);
const combo = ref(0);
const startTime = ref(null);
const total = computed(() => chars.value.length);
const accuracy = computed(() => {
  const t = correct.value + wrong.value;
  return t ? Math.round((correct.value / t) * 100) : 100;
});
const wpm = computed(() => {
  const el = startTime.value ? (Date.now() - startTime.value) / 60000 : 0;
  return el > 0.005 ? Math.max(0, Math.round(correct.value / el / 5)) : 0;
});
const progressPct = computed(() => (total.value ? Math.round((idx.value / total.value) * 100) + '%' : '0%'));

// ---------- Canvas 游戏状态（闭包内非响应式，60fps 不走 Vue） ----------
const KEY_ROWS = [['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'], ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'], ['z', 'x', 'c', 'v', 'b', 'n', 'm']];
const KEY_H = 76;
let ctx = null;
let rafId = null;
let gmKeys = [];
let gmParticles = [];
let gmStars = [];
let gmHammer = { x: 0, y: 0, angle: 0, swinging: false };
let gmRunner = { x: 0, jumping: false, jumpTime: 0 };

function startTyping(text) {
  // 游戏模式只练字母：空格与非字母字符一律剔除（导入内容在服务端已校验纯字母）
  const txt = String(text || GAME_DEFAULT_TEXT).replace(/[^A-Za-z]/g, '');
  chars.value = [...txt];
  idx.value = 0;
  correct.value = 0;
  wrong.value = 0;
  combo.value = 0;
  startTime.value = Date.now();
}
let customTimer = null;
watch(customText, () => {
  clearTimeout(customTimer);
  customTimer = setTimeout(() => {
    const t = customText.value.trim();
    if (t) { selectedId.value = null; startTyping(t); }  // 临时粘贴顶掉选中的导入练习
  }, 400);
});

// ---------- 我的练习（服务端导入，仅本人可见） ----------
async function loadMine() {
  try { mine.value = await listImports('game'); } catch { /* 拉不到不阻塞默认练习 */ }
}
loadMine();

async function onImported() {
  showImport.value = false;
  await loadMine();
  if (mine.value.length) playMine(mine.value[0]);   // 新导入排最前，直接开练
}

function playMine(m) {
  selectedId.value = m.id;
  customText.value = '';
  startTyping(m.text);
}

async function removeMine(m) {
  if (!window.confirm(`删除「${m.title}」？`)) return;
  try { await deleteImport(m.id); } catch (e) { window.alert(e.message || '删除失败'); return; }
  await loadMine();
  if (selectedId.value === m.id) selectedId.value = null;
}

function spawnParticles(x, y, good) {
  for (let i = 0; i < 12; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = 2 + Math.random() * 4;
    gmParticles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 2, life: 1, color: good ? `hsl(${40 + Math.random() * 30},100%,${50 + Math.random() * 30}%)` : '#ff4444', size: 3 + Math.random() * 3 });
  }
}
function spawnStars(x, y) {
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    const v = 3 + Math.random() * 2;
    gmStars.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 3, life: 1, size: 4 + Math.random() * 3, rotation: Math.random() * Math.PI * 2 });
  }
}

let restartTimer = null;
function onKey(e) {
  if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === 'Escape') { if (!showImport.value) emit('back'); return; }  // 弹窗开着时 Esc 只关弹窗（弹窗自己监听）
  const key = e.key.toLowerCase();
  if (key.length !== 1 || !/[a-z0-9]/.test(key)) return;
  const target = chars.value[idx.value];
  const k = gmKeys.find((g) => g.key === key);
  if (key === target) {
    correct.value++;
    combo.value++;
    tracker.hit(true);
    playCorrect();
    idx.value++;
    gmRunner.jumping = true;
    gmRunner.jumpTime = 0;
    if (k) {
      gmHammer.swinging = true;
      gmHammer.x = k.x + k.w / 2;
      gmHammer.y = k.y;
      spawnParticles(k.x + k.w / 2, k.y + KEY_H / 2, true);
      spawnStars(k.x + k.w / 2, k.y);
    }
    if (idx.value >= total.value) {
      tracker.flush();
      const again = customText.value.trim() || (selectedItem.value ? selectedItem.value.text : '') || GAME_DEFAULT_TEXT;
      restartTimer = setTimeout(() => startTyping(again), 1000);
    }
  } else {
    wrong.value++;
    combo.value = 0;
    tracker.hit(false);
    playError();
    if (k) {
      k.hit = true;
      spawnParticles(k.x + k.w / 2, k.y + KEY_H / 2, false);
      setTimeout(() => { k.hit = false; }, 300);
    }
  }
}
window.addEventListener('keydown', onKey);

// ---------- 像素土拨鼠 / 木锤 ----------
function drawGroundhog(c, x, y, size = 24, laughing = false) {
  const s = size / 24;
  c.fillStyle = '#8B6914';
  c.beginPath(); c.ellipse(x, y + 3 * s, s * 10, s * 8, 0, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#C4A265';
  c.beginPath(); c.ellipse(x, y + 4 * s, s * 6, s * 5, 0, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#8B6914';
  c.beginPath(); c.arc(x, y - 6 * s, s * 7, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#C4A265';
  c.beginPath(); c.arc(x, y - 5 * s, s * 5, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#7A5C10';
  c.beginPath(); c.ellipse(x - 6 * s, y - 11 * s, s * 3, s * 4, -0.3, 0, Math.PI * 2); c.fill();
  c.beginPath(); c.ellipse(x + 6 * s, y - 11 * s, s * 3, s * 4, 0.3, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#D4A574';
  c.beginPath(); c.ellipse(x - 6 * s, y - 11 * s, s * 1.8, s * 2.5, -0.3, 0, Math.PI * 2); c.fill();
  c.beginPath(); c.ellipse(x + 6 * s, y - 11 * s, s * 1.8, s * 2.5, 0.3, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#1a1a1a';
  c.beginPath(); c.arc(x - 3 * s, y - 8 * s, s * 1.5, 0, Math.PI * 2); c.fill();
  c.beginPath(); c.arc(x + 3 * s, y - 8 * s, s * 1.5, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#fff';
  c.beginPath(); c.arc(x - 2 * s, y - 9 * s, s * 0.6, 0, Math.PI * 2); c.fill();
  c.beginPath(); c.arc(x + 4 * s, y - 9 * s, s * 0.6, 0, Math.PI * 2); c.fill();
  if (laughing) {
    c.fillStyle = '#4a2a0a';
    c.beginPath(); c.arc(x, y - 4 * s, s * 3, 0, Math.PI); c.fill();
    c.fillStyle = '#cc3333';
    c.beginPath(); c.arc(x, y - 4 * s, s * 2, 0, Math.PI); c.fill();
  } else {
    c.fillStyle = '#4a2a0a';
    c.beginPath(); c.ellipse(x, y - 6 * s, s * 1.2, s * 1, 0, 0, Math.PI * 2); c.fill();
    c.strokeStyle = '#4a2a0a';
    c.lineWidth = 1.5;
    c.beginPath(); c.arc(x, y - 5 * s, s * 2, 0.1, Math.PI - 0.1); c.stroke();
    c.lineWidth = 0.5;
    for (let side = -1; side <= 1; side += 2) {
      for (let wi = 0; wi < 3; wi++) {
        c.beginPath();
        c.moveTo(x + side * 4 * s, y - 6 * s + wi * 2 * s);
        c.lineTo(x + side * (8 + wi) * s, y - 8 * s + wi * 2 * s);
        c.stroke();
      }
    }
  }
  c.fillStyle = '#7A5C10';
  c.beginPath(); c.ellipse(x - 4 * s, y + 6 * s, s * 2.2, s * 1.8, 0, 0, Math.PI * 2); c.fill();
  c.beginPath(); c.ellipse(x + 4 * s, y + 6 * s, s * 2.2, s * 1.8, 0, 0, Math.PI * 2); c.fill();
}
function drawHammer(c, x, y, angle) {
  c.save();
  c.translate(x, y - 20);
  c.rotate(angle);
  c.fillStyle = '#8B5E3C';
  c.fillRect(-2, -20, 5, 25);
  c.fillStyle = '#6B6B6B';
  c.fillRect(-12, -28, 24, 12);
  c.fillStyle = '#888';
  c.fillRect(-10, -27, 20, 10);
  c.restore();
}

// ---------- 主循环 ----------
function loop() {
  const cvs = canvasEl.value;
  if (!cvs || !ctx) return;
  const W = cvs.width;
  const H = cvs.height;
  const c = ctx;
  c.clearRect(0, 0, W, H);

  const grd = c.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, '#1a3a2a');
  grd.addColorStop(1, '#0f2a1a');
  c.fillStyle = grd;
  c.fillRect(0, 0, W, H - 58);

  const t = Date.now() / 1000;
  const grassY = H - 65;
  c.strokeStyle = '#3a8a3a';
  c.lineWidth = 2;
  for (let i = 0; i < W; i += 6) {
    const sway = Math.sin(t * 2 + i / 20) * 6;
    const h = 12 + Math.sin(t * 1.3 + i * 0.3) * 6;
    c.beginPath();
    c.moveTo(i, grassY);
    c.quadraticCurveTo(i + sway, grassY - h, i + sway * 1.5, grassY - h - 4);
    c.stroke();
  }
  c.strokeStyle = '#4a9a4a';
  c.lineWidth = 1.5;
  for (let i = 3; i < W; i += 8) {
    const sway = Math.sin(t * 1.7 + i / 25) * 5;
    const h = 8 + Math.sin(t + i * 0.2) * 4;
    c.beginPath();
    c.moveTo(i, grassY + 2);
    c.quadraticCurveTo(i + sway, grassY - h, i + sway * 1.2, grassY - h - 2);
    c.stroke();
  }
  const gg = c.createLinearGradient(0, grassY + 5, 0, H);
  gg.addColorStop(0, '#2d5a27');
  gg.addColorStop(1, '#1a3a15');
  c.fillStyle = gg;
  c.fillRect(0, grassY + 5, W, H - grassY - 5);

  // 跑步土拨鼠（打对时跳跃庆祝）
  gmRunner.x += 1.2;
  if (gmRunner.x > W + 40) gmRunner.x = -40;
  const bob = Math.sin(t * 8 + gmRunner.x / 10) * 4;
  if (gmRunner.jumping) {
    gmRunner.jumpTime += 0.05;
    gmRunner.y = -Math.sin(gmRunner.jumpTime * Math.PI) * 90;
    if (gmRunner.jumpTime >= 1) { gmRunner.jumping = false; gmRunner.jumpTime = 0; gmRunner.y = 0; }
  }
  const ry = grassY - 32 + bob + (gmRunner.y || 0);
  c.fillStyle = '#8B6914';
  c.beginPath(); c.ellipse(gmRunner.x, ry, 14, 10, 0, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#C4A265';
  c.beginPath(); c.ellipse(gmRunner.x - 2, ry + 2, 9, 7, 0, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#8B6914';
  c.beginPath(); c.arc(gmRunner.x + 12, ry - 5, 10, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#4a2a0a';
  c.beginPath(); c.arc(gmRunner.x + 18, ry - 5, 3, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#1a1a1a';
  c.beginPath(); c.arc(gmRunner.x + 15, ry - 8, 2.5, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#fff';
  c.beginPath(); c.arc(gmRunner.x + 16, ry - 9, 1, 0, Math.PI * 2); c.fill();
  c.fillStyle = '#7A5C10';
  c.beginPath(); c.ellipse(gmRunner.x + 8, ry - 13, 3.5, 5, 0.3, 0, Math.PI * 2); c.fill();
  const legSwing = Math.sin(t * 12 + gmRunner.x / 8) * 6;
  c.beginPath(); c.ellipse(gmRunner.x - 10, ry + 9 + legSwing, 4, 3, 0, 0, Math.PI * 2); c.fill();
  c.beginPath(); c.ellipse(gmRunner.x + 4, ry + 9 - legSwing, 4, 3, 0, 0, Math.PI * 2); c.fill();
  c.strokeStyle = '#7A5C10';
  c.lineWidth = 2.5;
  c.beginPath();
  c.moveTo(gmRunner.x - 14, ry - 2);
  c.quadraticCurveTo(gmRunner.x - 20, ry - 10, gmRunner.x - 18, ry - 15);
  c.stroke();

  // 键盘 + 目标键上的土拨鼠
  const kw = Math.min(72, (W - 10) / 12);
  const startY = H - KEY_H * 3 - 36;
  const targetChar = chars.value[idx.value];
  KEY_ROWS.forEach((row, ri) => {
    const startX = (W - row.length * kw) / 2;
    row.forEach((k, ki) => {
      const kx = startX + ki * kw;
      const ky = startY + ri * (KEY_H + 6);
      const keyObj = gmKeys.find((g) => g.key === k);
      const isHit = keyObj && keyObj.hit;
      c.fillStyle = isHit ? '#ff4444' : targetChar === k ? 'rgba(255,215,0,.25)' : 'rgba(255,255,255,.08)';
      c.fillRect(kx, ky, kw - 2, KEY_H - 2);
      c.strokeStyle = isHit ? '#ff6666' : targetChar === k ? '#ffd700' : 'rgba(255,255,255,.15)';
      c.lineWidth = 1;
      c.strokeRect(kx, ky, kw - 2, KEY_H - 2);
      c.fillStyle = 'rgba(255,255,255,.7)';
      c.font = '13px Arial';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(k.toUpperCase(), kx + (kw - 2) / 2, ky + (KEY_H - 2) / 2 + 8);
      if (targetChar === k) drawGroundhog(c, kx + (kw - 2) / 2, ky + KEY_H / 2 - 20 + Math.sin(Date.now() / 300) * 2, 20, false);
    });
  });

  if (gmHammer.swinging) {
    gmHammer.angle += 0.3;
    if (gmHammer.angle > Math.PI * 2) { gmHammer.swinging = false; gmHammer.angle = 0; }
    drawHammer(c, gmHammer.x, gmHammer.y, gmHammer.angle);
  }

  gmParticles = gmParticles.filter((p) => {
    p.x += p.vx; p.y += p.vy; p.vy += 0.15; p.life -= 0.03;
    if (p.life > 0) {
      c.globalAlpha = p.life;
      c.fillStyle = p.color;
      c.beginPath(); c.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2); c.fill();
      c.globalAlpha = 1;
      return true;
    }
    return false;
  });
  gmStars = gmStars.filter((s) => {
    s.x += s.vx; s.y += s.vy; s.vy += 0.1; s.life -= 0.04; s.rotation += 0.1;
    if (s.life > 0) {
      c.save();
      c.translate(s.x, s.y);
      c.rotate(s.rotation);
      c.globalAlpha = s.life;
      c.fillStyle = '#ffd700';
      c.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = (i * Math.PI * 2) / 5 - Math.PI / 2;
        c[i === 0 ? 'moveTo' : 'lineTo'](Math.cos(a) * s.size, Math.sin(a) * s.size);
        const a2 = a + Math.PI / 5;
        c.lineTo(Math.cos(a2) * s.size * 0.4, Math.sin(a2) * s.size * 0.4);
      }
      c.closePath();
      c.fill();
      c.globalAlpha = 1;
      c.restore();
      return true;
    }
    return false;
  });

  rafId = requestAnimationFrame(loop);
}

function resize() {
  const cvs = canvasEl.value;
  const wrap = wrapEl.value;
  if (!cvs || !wrap) return;
  const rect = wrap.getBoundingClientRect();
  cvs.width = rect.width;
  cvs.height = rect.height - 8;
  const kw = Math.min(72, (cvs.width - 10) / 12);
  gmKeys = [];
  KEY_ROWS.forEach((row, ri) => {
    const startX = (cvs.width - row.length * kw) / 2;
    row.forEach((k, ki) => gmKeys.push({ key: k, x: startX + ki * kw, y: cvs.height - KEY_H * 3 - 36 + ri * (KEY_H + 6), w: kw - 2, hit: false }));
  });
}

let ro = null;
onMounted(() => {
  startTyping(GAME_DEFAULT_TEXT);
  resize();
  ctx = canvasEl.value.getContext('2d');
  ro = new ResizeObserver(resize);
  ro.observe(wrapEl.value);
  rafId = requestAnimationFrame(loop);
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
  cancelAnimationFrame(rafId);
  clearTimeout(restartTimer);
  clearTimeout(customTimer);
  if (ro) ro.disconnect();
  tracker.dispose();
});
</script>

<style scoped>
.game-mode { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.gm-top { display: flex; gap: 16px; font-size: 13px; color: var(--text2); padding: 6px 2px; flex-wrap: wrap; }
.gm-progress { height: 4px; background: var(--bg3); border-radius: 2px; overflow: hidden; margin-bottom: 6px; }
.gm-progress .fill { height: 100%; background: linear-gradient(90deg, var(--amber), #ff8c00); transition: width .2s; }
.gm-text { text-align: center; padding: 6px 0; font-size: 17px; letter-spacing: 3px; font-weight: 700; min-height: 34px; overflow: hidden; }
.gm-text .char { padding: 2px 1px; border-radius: 4px; }
.gm-text .char.done { color: var(--text3); }
.gm-text .char.current { color: var(--amber); background: rgba(251, 191, 36, .18); animation: gmPulse .6s ease-in-out infinite; }
@keyframes gmPulse { 0%,100% { box-shadow: 0 0 4px rgba(251,191,36,.25) } 50% { box-shadow: 0 0 12px rgba(251,191,36,.5) } }
.gm-ground { flex: 1; position: relative; min-height: 240px; border-radius: 12px; overflow: hidden; }
.gm-ground canvas { width: 100%; height: 100%; display: block; border-radius: 12px; }
.gm-mine { position: absolute; bottom: 8px; right: 8px; width: 216px; background: rgba(0, 0, 0, .6); border: 1px solid rgba(255, 255, 255, .16); border-radius: 10px; padding: 8px; z-index: 5; }
.gm-mine-head { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: rgba(255, 255, 255, .85); margin-bottom: 6px; }
.gm-mine-head .imp { background: none; border: 1px dashed rgba(255, 255, 255, .35); color: #ffd700; border-radius: 8px; padding: 1px 9px; font-size: 12px; cursor: pointer; }
.gm-mine-head .imp:hover { border-color: #ffd700; }
.gm-chips { display: flex; flex-wrap: wrap; gap: 4px; max-height: 96px; overflow: auto; margin-bottom: 6px; }
.gm-chips button { background: rgba(255, 255, 255, .1); color: #fff; border: 1px solid rgba(255, 255, 255, .2); padding: 2px 8px; border-radius: 10px; font-size: 12px; cursor: pointer; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gm-chips button.active { background: rgba(255, 215, 0, .25); border-color: #ffd700; color: #ffd700; }
.gm-chips button .del { font-style: normal; margin-left: 6px; color: rgba(255, 255, 255, .45); font-size: 10px; }
.gm-chips button .del:hover { color: #ff6b6b; }
.gm-empty { font-size: 11.5px; color: rgba(255, 255, 255, .5); margin-bottom: 6px; }
.gm-custom { width: 100%; box-sizing: border-box; background: rgba(0, 0, 0, .4); color: #fff; border: 1px solid rgba(255, 255, 255, .18); border-radius: 8px; padding: 5px 7px; font-size: 12px; resize: none; font-family: inherit; }
</style>
