<template>
  <div class="piano-mode">
    <div class="pn-top">
      <span>🎹 卡农钢琴 <em class="pn-midi-status">{{ midiStatus }}</em></span>
      <span class="pn-speed">🏃 速度
        <input v-model.number="speed" type="range" min="0.5" max="5" step="0.1">
        <b>{{ speed.toFixed(1) }}</b>
      </span>
      <span>✅ {{ doneCnt }} / {{ totalCnt }}</span>
      <span>🔥 连击 {{ combo }}</span>
    </div>
    <div class="pn-progress"><div class="fill" :style="{ width: progressPct }"></div></div>
    <div class="pn-content">
      <div ref="fallEl" class="pn-fall">
        <div
          v-for="(k, i) in PIANO_KEYS" :key="'glow' + k" class="channel-glow"
          :class="{ active: channelOn[k] }"
          :style="{ left: (i / PIANO_KEYS.length * 100) + '%', width: (90 / PIANO_KEYS.length) + '%' }"
        ></div>
        <div ref="particleEl" class="pn-particles"></div>
        <div class="pn-actions">
          <input ref="midiPickerEl" type="file" accept=".mid,.midi" style="display:none" @change="onMidiFile">
          <button class="pn-midi-btn" @click="midiPickerEl && midiPickerEl.click()">🎵 选择MIDI文件</button>
        </div>
        <textarea v-model="customText" class="pn-custom" placeholder="📋 粘贴自定义字母..." rows="2"></textarea>
      </div>
      <div class="pn-kbd">
        <div
          v-for="(k, i) in PIANO_KEYS" :key="k" class="piano-key" :class="{ black: isBlack(i), active: keyOn[k], err: keyErr[k] }"
        >
          <span class="key-letter">{{ k }}</span>
          <span class="key-label">{{ KEY_NAMES[i] }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onUnmounted, onMounted, ref, watch } from 'vue';
import { PIANO_DEFAULT_TEXT } from './content';
import { playError, playTone } from './audio';
import { createTracker } from './tracker';

const emit = defineEmits(['back']);
const tracker = createTracker('piano');

const PIANO_KEYS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
const PIANO_BLACK = [1, 3, 6, 8, 10, 13, 15, 18, 20, 22, 25];
const KEY_NAMES = ['Do', 'Re', 'Mi', 'Fa', 'Sol', 'La', 'Si', 'Do', 'Re', 'Mi', 'Fa', 'Sol', 'La', 'Si', 'Do', 'Re', 'Mi', 'Fa', 'Sol', 'La', 'Si', 'Do', 'Re', 'Mi', 'Fa', 'Sol'];
const isBlack = (i) => PIANO_BLACK.includes(i);

const fallEl = ref(null);
const particleEl = ref(null);
const midiPickerEl = ref(null);
const speed = ref(1.5);
const customText = ref('');
const midiStatus = ref('(未加载MIDI)');
const doneCnt = ref(0);
const totalCnt = ref(0);
const combo = ref(0);
const channelOn = ref({});
const keyOn = ref({});
const keyErr = ref({});
const progressPct = computed(() => (totalCnt.value ? Math.round((doneCnt.value / totalCnt.value) * 100) + '%' : '0%'));

// 下落字母（非响应式：DOM 元素直改样式，60fps 不走 Vue）
let notes = [];
let rafId = null;
let restartTimer = null;
let customTimer = null;

function startTyping(text) {
  const txt = String(text || PIANO_DEFAULT_TEXT).replace(/[^A-Za-z]/g, '').toUpperCase();
  if (!txt) return;
  clearNotes();
  notes = [];
  doneCnt.value = 0;
  combo.value = 0;
  totalCnt.value = txt.length;
  const area = fallEl.value;
  if (!area) return;
  const aw = area.clientWidth - 50;
  const ah = area.clientHeight - 80;
  const sp = Math.max(38, Math.min(68, ah / Math.min(txt.length, 35)));
  const colW = aw / PIANO_KEYS.length;
  for (let i = 0; i < txt.length && i < 50; i++) {
    const ch = txt[i];
    const keyIdx = PIANO_KEYS.indexOf(ch);
    if (keyIdx < 0) continue;
    const el = document.createElement('div');
    const hue = Math.floor(Math.random() * 360);
    el.className = 'falling-note';
    el.textContent = ch;
    el.style.cssText = `left:${keyIdx * colW + colW / 2 - 25}px;top:${-60 - i * sp}px;color:hsl(${hue},100%,70%);text-shadow:0 0 15px hsla(${hue},100%,70%,.6),0 0 35px hsla(${hue},100%,70%,.3)`;
    area.appendChild(el);
    notes.push({ char: ch, el, speed: 0.6 + Math.random() * 0.8, hit: false, color: `hsl(${hue},100%,70%)` });
  }
}
function clearNotes() {
  notes.forEach((n) => { if (n.el && n.el.parentNode) n.el.remove(); });
  notes = [];
  const area = fallEl.value;
  if (area) area.querySelectorAll('.piano-laser').forEach((e) => e.remove());
}

function loop() {
  const area = fallEl.value;
  if (!area) return;
  const ah = area.clientHeight - 85;
  const sm = speed.value || 1;
  notes.forEach((n) => {
    if (n.hit || !n.el || !n.el.parentNode) return;
    const top = parseFloat(n.el.style.top) || 0;
    if (top < ah) {
      n.el.style.top = top + n.speed * sm / 1.5 + 'px';
      const db = ah - top;
      if (db < 150) {
        const p = 1 + 0.4 * Math.sin(Date.now() / 150 + db / 20);
        n.el.style.transform = `scale(${p})`;
        n.el.style.textShadow = `0 0 ${20 + p * 15}px ${n.color}, 0 0 ${40 + p * 25}px ${n.color}80`;
      } else n.el.style.transform = 'scale(1)';
    } else {
      n.el.style.top = -80 - Math.random() * 140 + 'px';
      n.el.style.transform = 'scale(1)';
    }
  });
  rafId = requestAnimationFrame(loop);
}

// ---------- MIDI 伴奏 ----------
let midiNotes = [];
let midiCurrent = 0;
let midiPlaying = false;
let midiTimer = null;
function stopMidi() {
  midiPlaying = false;
  if (midiTimer) { clearTimeout(midiTimer); midiTimer = null; }
}
function scheduleMidi() {
  if (midiTimer) { clearTimeout(midiTimer); midiTimer = null; }
  if (!midiPlaying || !midiNotes.length) return;
  const beat = 0.3;
  const chunk = Math.min(32, midiNotes.length);
  for (let i = 0; i < chunk; i++) {
    const n = midiNotes[(midiCurrent + i) % midiNotes.length];
    playTone(n.freq, 0.15, 0.05, 'triangle', i * beat * 0.5);
  }
  midiCurrent = (midiCurrent + chunk) % midiNotes.length;
  midiTimer = setTimeout(scheduleMidi, Math.min(chunk * beat * 0.5 * 1000, 2000));
}
let midiLibPromise = null;
function loadMidiLib() {
  if (window.Midi) return Promise.resolve();
  if (!midiLibPromise) {
    midiLibPromise = new Promise((ok, ng) => {
      const s = document.createElement('script');
      s.src = '/vendor/Midi.min.js';
      s.onload = () => (window.Midi ? ok() : ng(new Error('no Midi')));
      s.onerror = () => { midiLibPromise = null; ng(new Error('lib fail')); };
      document.head.appendChild(s);
    });
  }
  return midiLibPromise;
}
async function parseMidi(arrayBuffer) {
  stopMidi();
  try {
    // @tonejs/midi UMD 自托管（web/public/vendor），无 CDN 外网依赖
    if (!window.Midi) await loadMidiLib();
    const midi = new window.Midi(arrayBuffer);
    const all = [];
    midi.tracks.forEach((tr) => tr.notes.forEach((nt) => all.push({ freq: nt.freq || 440 * Math.pow(2, (nt.midi - 69) / 12) })));
    if (!all.length) throw new Error('no notes');
    midiNotes = all;
  } catch {
    midiNotes = [];
    for (let i = 0; i < 48; i++) midiNotes.push({ freq: 262 * Math.pow(2, i / 12) });
  }
  midiCurrent = 0;
  midiPlaying = true;
  scheduleMidi();
}
async function autoLoadMidi() {
  midiStatus.value = '(加载中...)';
  try {
    const resp = await fetch('/canon.mid');
    if (!resp.ok) throw new Error('nf');
    await parseMidi(await resp.arrayBuffer());
    midiStatus.value = '(MIDI已加载)';
  } catch {
    midiStatus.value = '(点击选择MIDI文件)';
  }
}
async function onMidiFile(e) {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  midiStatus.value = '(加载中...)';
  try {
    await parseMidi(await f.arrayBuffer());
    midiStatus.value = '(MIDI已加载)';
  } catch {
    midiStatus.value = '(加载失败)';
  }
}

// ---------- 击打：任意匹配字母 → 激光 + 爆炸 ----------
function explode(x, y) {
  const c = particleEl.value;
  if (!c) return;
  for (let i = 0; i < 45 + Math.floor(Math.random() * 20); i++) {
    const p = document.createElement('div');
    const a = Math.random() * Math.PI * 2;
    const d = 30 + Math.random() * 130;
    const s = 3 + Math.random() * 8;
    const l = 0.4 + Math.random() * 0.6;
    const h = Math.random() > 0.3 ? 40 + Math.random() * 40 : Math.random() * 360;
    p.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${s}px;height:${s}px;border-radius:${Math.random() > 0.5 ? '50%' : '2px'};background:hsl(${h},100%,${50 + Math.random() * 40}%);box-shadow:0 0 ${s * 2}px hsl(${h},100%,60%);transition:all ${l}s cubic-bezier(.2,.8,.3,1)`;
    c.appendChild(p);
    requestAnimationFrame(() => {
      p.style.transform = `translate(${Math.cos(a) * d}px,${Math.sin(a) * d}px) scale(.1) rotate(${Math.random() * 720}deg)`;
      p.style.opacity = '0';
    });
    setTimeout(() => { if (p.parentNode) p.remove(); }, l * 1000 + 100);
  }
  for (let i = 0; i < 6; i++) {
    const st = document.createElement('div');
    const a2 = (i * Math.PI) / 3 + Math.random() * 0.5;
    const d2 = 60 + Math.random() * 80;
    const sz = 10 + Math.random() * 10;
    st.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${sz}px;height:${sz}px;background:#ffd700;clip-path:polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%);box-shadow:0 0 ${sz * 2}px #ffd700;transition:all .5s cubic-bezier(.2,.8,.3,1)`;
    c.appendChild(st);
    requestAnimationFrame(() => {
      st.style.transform = `translate(${Math.cos(a2) * d2}px,${Math.sin(a2) * d2}px) scale(.2) rotate(${Math.random() * 360}deg)`;
      st.style.opacity = '0';
    });
    setTimeout(() => { if (st.parentNode) st.remove(); }, 700);
  }
}

function flashKey(map, k, ms = 200) {
  map.value = { ...map.value, [k]: true };
  setTimeout(() => { map.value = { ...map.value, [k]: false }; }, ms);
}

function onKey(e) {
  if (e.target && /^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === 'Escape') { emit('back'); return; }
  const key = e.key.toUpperCase();
  if (!PIANO_KEYS.includes(key)) return;
  const target = notes.find((n) => !n.hit && n.char === key);
  if (target) {
    doneCnt.value++;
    combo.value++;
    tracker.hit(true);
    playTone(440, 0.1, 0.1);
    const ki = PIANO_KEYS.indexOf(key);
    flashKey(keyOn, key, 180);
    flashKey(channelOn, key, 220);
    const area = fallEl.value;
    const ar = area.getBoundingClientRect();
    const rect = target.el.getBoundingClientRect();
    const hx = rect.left - ar.left + rect.width / 2;
    const hy = rect.top - ar.top + rect.height / 2;
    // 光柱从底部射向字母
    const beam = document.createElement('div');
    beam.className = 'piano-laser';
    beam.style.cssText = `left:${ki / PIANO_KEYS.length * 100}%;width:${100 / PIANO_KEYS.length}%;height:${hy + 40}px`;
    area.appendChild(beam);
    setTimeout(() => {
      target.hit = true;
      explode(hx, hy);
      target.el.classList.add('hit');
      setTimeout(() => { if (target.el && target.el.parentNode) target.el.remove(); }, 350);
    }, 200);
    setTimeout(() => { if (beam.parentNode) beam.remove(); }, 400);
    if (notes.every((n) => n.hit)) {
      tracker.flush();
      restartTimer = setTimeout(() => startTyping(customText.value.trim()), 2500);
    }
  } else {
    combo.value = 0;
    tracker.hit(false);
    playError();
    flashKey(keyErr, key, 200);
  }
}
window.addEventListener('keydown', onKey);

watch(customText, () => {
  clearTimeout(customTimer);
  customTimer = setTimeout(() => { const t = customText.value.trim(); if (t) startTyping(t); }, 400);
});

onMounted(() => {
  startTyping(PIANO_DEFAULT_TEXT);
  rafId = requestAnimationFrame(loop);
  autoLoadMidi();
});
onUnmounted(() => {
  window.removeEventListener('keydown', onKey);
  cancelAnimationFrame(rafId);
  clearTimeout(restartTimer);
  clearTimeout(customTimer);
  clearTimeout(midiTimer);
  clearNotes();
  tracker.dispose();
});
</script>

<style scoped>
.piano-mode { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.pn-top { display: flex; gap: 16px; align-items: center; font-size: 13px; color: var(--text2); padding: 6px 2px; flex-wrap: wrap; }
.pn-midi-status { font-style: normal; font-size: 12px; color: var(--text3); }
.pn-speed input { vertical-align: middle; width: 70px; }
.pn-speed b { color: var(--amber); min-width: 22px; display: inline-block; }
.pn-progress { height: 4px; background: var(--bg3); border-radius: 2px; overflow: hidden; margin-bottom: 6px; }
.pn-progress .fill { height: 100%; background: linear-gradient(90deg, var(--amber), #ff8c00); transition: width .2s; }
.pn-content { flex: 1; display: flex; flex-direction: column; min-height: 240px; }
.pn-fall { flex: 1; position: relative; overflow: hidden; border-radius: 10px; background: linear-gradient(180deg, #0a0015 0%, #1a0a3e 30%, #0a0a1a 70%, #0a0015 100%); }
.channel-glow { position: absolute; bottom: 0; height: 100%; background: linear-gradient(0deg, rgba(255, 215, 0, .25), rgba(255, 215, 0, .05) 60%, transparent 90%); opacity: 0; transition: opacity .08s; pointer-events: none; }
.channel-glow.active { opacity: 1; }
.pn-particles { position: absolute; inset: 0; pointer-events: none; z-index: 15; overflow: hidden; }
.pn-actions { position: absolute; top: 8px; right: 8px; z-index: 25; }
.pn-midi-btn { background: rgba(255, 215, 0, .15); color: #ffd700; border: 1px solid rgba(255, 215, 0, .3); padding: 3px 12px; border-radius: 8px; font-size: 12px; cursor: pointer; }
.pn-custom { position: absolute; bottom: 8px; right: 8px; width: 170px; background: rgba(0, 0, 0, .6); color: #fff; border: 1px solid rgba(255, 255, 255, .15); border-radius: 8px; padding: 6px 8px; font-size: 12px; resize: none; z-index: 25; }
:deep(.falling-note) { position: absolute; font-size: 2rem; font-weight: 900; pointer-events: none; z-index: 10; width: 50px; height: 50px; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: radial-gradient(circle, rgba(255, 255, 255, .1), transparent); will-change: top; }
:deep(.falling-note.hit) { animation: pnHit .25s forwards; }
@keyframes pnHit { 0% { transform: scale(1); opacity: 1 } 30% { transform: scale(2.5); opacity: 1; color: #fff } 100% { transform: scale(4); opacity: 0 } }
:deep(.piano-laser) { position: absolute; bottom: 0; background: linear-gradient(0deg, rgba(255, 215, 0, .9), rgba(255, 215, 0, .5) 30%, rgba(255, 255, 255, .4) 60%, transparent); pointer-events: none; z-index: 5; animation: pnLaser .25s ease-out forwards; }
@keyframes pnLaser { 0% { transform: scaleY(0); opacity: 1 } 30% { opacity: 1 } 100% { transform: scaleY(1); opacity: 0 } }
.pn-kbd { display: flex; height: 92px; padding: 0 4px 6px; background: linear-gradient(180deg, #2a1a0a, #1a0e05); align-items: stretch; }
.piano-key { flex: 1; border-radius: 0 0 8px 8px; color: #333; font-weight: 700; display: flex; flex-direction: column; align-items: center; justify-content: flex-end; padding-bottom: 6px; margin: 0 1px; cursor: pointer; position: relative; background: linear-gradient(180deg, #f8f6f0 0%, #e8e4dc 60%, #d8d4cc 100%); border-bottom: 3px solid #b0a890; transition: all .06s; }
.piano-key .key-letter { font-size: 1.05rem; font-weight: 900; color: #555; }
.piano-key .key-label { font-size: .6rem; color: #999; }
.piano-key.black { flex: .6; z-index: 2; margin: 0 -0.3%; height: 62%; align-self: flex-start; background: linear-gradient(180deg, #3a3028, #1a1410, #0a0806); border-bottom: 3px solid #000; color: #ddd; border-radius: 0 0 6px 6px; padding-bottom: 8px; }
.piano-key.black .key-letter { color: #bbb; font-size: .9rem; }
.piano-key.active { background: linear-gradient(180deg, #fff8e0, #ffd700 40%, #ff8c00 100%); border-color: #ffd700; transform: scaleY(1.02); box-shadow: 0 0 30px rgba(255, 215, 0, .4); }
.piano-key.black.active { background: linear-gradient(180deg, #5a4a30, #3a2a10); border-color: #ffd700; }
.piano-key.err { background: linear-gradient(180deg, #ff6666, #cc2222); border-color: #f33; }
@media (max-width: 700px) { .piano-key .key-label { display: none } .piano-key .key-letter { font-size: .8rem } }
</style>
