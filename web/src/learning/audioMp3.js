// WebM/Opus → MP3（lamejs）。从 VibeVoiceTab.vue 抽出共用（v1.9.39：笔记页录音也要 MP3 选项）。
// lamejs 走本地 vendor 动态加载，避开 Vite 打包该类 UMD 库的兼容问题。
import { prefixUrl } from '../api';

let lameLoading = null;
export function ensureLame() {
  if (window.lamejs?.Mp3Encoder) return Promise.resolve(window.lamejs);
  if (lameLoading) return lameLoading;
  lameLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = prefixUrl('/vendor/lame.min.js'); // 走网关前缀：fnOS 部署下裸路径会 404
    s.onload = () => (window.lamejs?.Mp3Encoder ? resolve(window.lamejs) : reject(new Error('MP3 编码器加载异常')));
    s.onerror = () => reject(new Error('MP3 编码器加载失败（/vendor/lame.min.js）'));
    document.head.appendChild(s);
  });
  return lameLoading;
}

// onProg(p)：p 0~1 全程进度；0~0.4 解码重采样（黑盒，靠动画推进），0.4~1 编码（真实进度）
export async function webmToMp3(blob, rate, kbps, onProg) {
  const rep = (p) => { if (onProg) onProg(p); };
  const lame = await ensureLame();
  rep(0.05);
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let buf;
  try { buf = await ctx.decodeAudioData(await blob.arrayBuffer()); } finally { ctx.close().catch(() => {}); }
  rep(0.28);
  // 重采样到目标采样率并混为单声道（语音识别足够，文件最小）
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil((buf.length * rate) / buf.sampleRate)), rate);
  const srcNode = off.createBufferSource();
  srcNode.buffer = buf;
  srcNode.connect(off.destination);
  srcNode.start();
  const rendered = await off.startRendering();
  rep(0.4);
  const ch = rendered.getChannelData(0);
  const pcm = new Int16Array(ch.length);
  for (let i = 0; i < ch.length; i++) {
    const s = Math.max(-1, Math.min(1, ch[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  rep(0.44);
  const enc = new lame.Mp3Encoder(1, rate, kbps);
  const out = [];
  const total = pcm.length;
  let lastYield = 0;
  for (let i = 0; i < total; i += 1152) {
    const d = enc.encodeBuffer(pcm.subarray(i, i + 1152));
    if (d.length) out.push(new Uint8Array(d));
    // 每约 4 秒音频让出一次主线程：进度条能刷新、页面不卡死
    if (i - lastYield >= 48000 * 4) {
      lastYield = i;
      rep(0.44 + 0.56 * (i / total));
      await new Promise((r) => setTimeout(r));
    }
  }
  const fin = enc.flush();
  if (fin.length) out.push(new Uint8Array(fin));
  rep(1);
  return new Blob(out, { type: 'audio/mpeg' });
}
