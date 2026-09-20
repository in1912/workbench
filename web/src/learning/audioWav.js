// 浏览器端音频工具：任意音频（mp3/m4a/webm/ogg/wav）→ 16bit PCM WAV、麦克风录音。
// 上传音色（参考录音）走 MOSS-TTS-Nano 的 torchaudio 加载，WAV 兼容性最好；
// MediaRecorder 只产 webm/opus，服务端读不了，必须先在浏览器解码转成 WAV。
// 单声道统一复制成双声道（与模型参考音频一致），采样率保留原始值。

export async function toWavBlob(blob) {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
    const len = buf.length;
    const left = buf.getChannelData(0);
    const right = buf.numberOfChannels > 1 ? buf.getChannelData(1) : left;
    const bytes = 44 + len * 4; // 双声道 16bit
    const ab = new ArrayBuffer(bytes);
    const dv = new DataView(ab);
    let off = 0;
    const ws = (s) => { for (const c of s) dv.setUint8(off++, c.charCodeAt(0)); };
    const u32 = (v) => { dv.setUint32(off, v, true); off += 4; };
    const u16 = (v) => { dv.setUint16(off, v, true); off += 2; };
    ws('RIFF'); u32(bytes - 8); ws('WAVE');
    ws('fmt '); u32(16); u16(1); u16(2); u32(buf.sampleRate);
    u32(buf.sampleRate * 4); u16(4); u16(16);
    ws('data'); u32(len * 4);
    for (let i = 0; i < len; i++) {
      for (const ch of [left, right]) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      }
    }
    return new Blob([ab], { type: 'audio/wav' });
  } finally {
    ctx.close().catch(() => {});
  }
}

// 麦克风录音：const rec = startRecording() → rec.stop() → await rec.promise 得 Blob
export function startRecording() {
  const state = { rec: null, promise: null, stop: () => {} };
  state.promise = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const rec = new MediaRecorder(stream);
    state.rec = rec;
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const done = new Promise((resolve) => { rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType })); });
    rec.start();
    state.stop = () => { if (rec.state !== 'inactive') rec.stop(); };
    const blob = await done;
    stream.getTracks().forEach((t) => t.stop());
    return blob;
  })();
  return state;
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] || '');
    r.onerror = () => reject(new Error('读取文件失败'));
    r.readAsDataURL(blob);
  });
}
