// 打字赚钱音频引擎：全部 Web Audio 实时合成（击键/成功/错误音 + 简谱旋律伴奏），无音频文件依赖
let audioCtx = null;
export function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
export function playTone(freq, dur = 0.15, vol = 0.2, type = 'sine', time = 0) {
  try {
    const ctx = getAudioCtx();
    const t = ctx.currentTime + time;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    osc.type = type;
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.start(t);
    osc.stop(t + dur);
  } catch { /* 浏览器限制自动播放前静默失败即可 */ }
}
export const playKeyClick = () => playTone(800, 0.05, 0.1, 'square');
export const playError = () => playTone(200, 0.2, 0.15, 'sawtooth');
export const playCorrect = () => playTone(523, 0.08, 0.12);

// 简谱旋律循环伴奏（歌曲模式）；返回停止函数
export function startMelody(notes, intervalMs = 400) {
  if (!Array.isArray(notes) || !notes.length) return () => {};
  let ni = 0;
  const playNext = () => {
    const n = notes[ni % notes.length];
    if (n && n.freq > 0) playTone(n.freq, n.dur * 0.8, 0.15);
    ni++;
  };
  playNext();
  const timer = setInterval(playNext, intervalMs);
  return () => clearInterval(timer);
}
