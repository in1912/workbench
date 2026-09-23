// 服务端音频元信息：从文件字节流读播放时长（无需 ffmpeg）。
// WAV：RIFF 头逐 chunk 找 fmt/data，data 字节 ÷ byteRate。
// MP3：逐帧遍历（ID3v2 跳过 + MPEG 帧头解析），Σ(每帧样本数/采样率)，CBR/VBR 都准。

// ---- WAV ----
function wavDuration(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 0;
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && off + 24 <= buf.length) byteRate = buf.readUInt32LE(off + 16) || 0;
    if (id === 'data') return byteRate > 0 ? size / byteRate : 0;
    off += 8 + size + (size % 2); // chunk 按 2 字节对齐
    if (size <= 0) break;
  }
  return 0;
}

// ---- MP3 ----
const BR_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]; // MPEG1 Layer3 kbps
const BR_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];     // MPEG2/2.5 Layer3
const SR = [ // [MPEG1, MPEG2, MPEG2.5]
  [44100, 22050, 11025], [48000, 24000, 12000], [32000, 16000, 8000], [0, 0, 0],
];
function mp3Duration(buf) {
  let pos = 0;
  if (buf.length > 10 && buf.toString('ascii', 0, 3) === 'ID3') {
    const sz = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    pos = 10 + sz;
  }
  let sec = 0;
  let frames = 0;
  while (pos + 4 <= buf.length && frames < 3_000_000) {
    if (buf[pos] !== 0xff || (buf[pos + 1] & 0xe0) !== 0xe0) { pos++; continue; } // 找帧同步字
    const hdr = buf.readUInt32BE(pos);
    const verBits = (hdr >> 19) & 3;   // 0=MPEG2.5 2=MPEG2 3=MPEG1
    const layerBits = (hdr >> 17) & 3; // 1=Layer3
    if (verBits === 1 || layerBits !== 1) { pos++; continue; }
    const vi = verBits === 3 ? 0 : (verBits === 2 ? 1 : 2);
    const br = (verBits === 3 ? BR_V1_L3 : BR_V2_L3)[(hdr >> 12) & 15] * 1000;
    const sr = SR[(hdr >> 10) & 3][vi];
    if (!br || !sr) { pos++; continue; }
    const pad = (hdr >> 9) & 1;
    const samples = verBits === 3 ? 1152 : 576; // MPEG1 L3=1152, MPEG2/2.5 L3=576
    const frameBytes = Math.floor(samples / 8 * br / sr) + pad;
    if (frameBytes < 4) { pos++; continue; }
    sec += samples / sr;
    frames++;
    pos += frameBytes;
  }
  return sec;
}

// 按扩展名分派；未知格式返回 0（调用方回落到客户端上报时长）
function audioDuration(buf, ext) {
  const e = String(ext || '').toLowerCase().replace('.', '');
  if (e === 'wav') return wavDuration(buf);
  if (e === 'mp3') return mp3Duration(buf);
  return 0;
}

const AUDIO_MIME = {
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4',
  flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm', aac: 'audio/aac',
};

module.exports = { audioDuration, wavDuration, mp3Duration, AUDIO_MIME };
