// sidecar 合成冒烟测试：参考音频路径 + preset 两种方式各合成一句（UTF-8 由 node 保证）
const BASE = 'http://127.0.0.1:9640';
async function one(label, body) {
  const t0 = Date.now();
  const r = await fetch(BASE + '/synthesize', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  if (!r.ok) { console.log(label, 'FAIL HTTP', r.status, await r.text()); return; }
  const buf = Buffer.from(await r.arrayBuffer());
  const riff = buf.slice(0, 4).toString('ascii');
  console.log(`${label}: HTTP 200, ${buf.length} bytes, ${riff === 'RIFF' ? 'RIFF✓' : 'NOT-WAV✗'}, ${(ms / 1000).toFixed(1)}s`);
}
await one('中文·参考音频zh_1', { text: '你好，这是听写测试第一句。', prompt_audio_path: 'D:/cc/personal-workbench/tts/MOSS-TTS-Nano/assets/audio/zh_1.wav' });
await one('英文·preset Trump', { text: 'Hello, this is a dictation test.', voice: 'Trump' });
await one('中文·preset Xiaoyu', { text: '春眠不觉晓，处处闻啼鸟。', voice: 'Xiaoyu' });
