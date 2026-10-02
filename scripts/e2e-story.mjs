// e2e：儿童故事（v1.9.36，家庭管理 → 儿童故事 tab）的服务端 + 前端契约
//
// 覆盖：列表分页（5/15/30/50/100、默认 15、翻页边界）、故事名/概要模糊搜（含 LIKE 通配符转义）、
//       条目详情（正文不进列表）、导入 txt、AI 生成（假 AI）、删除（连带音频）、
//       文字转音频全链（分段合成 + WAV 拼接 + 成品拷出合成缓存）、播放 Range/206/416、下载中文名。
//
// 全部离线：AI 用本地假 HTTP 服务顶替；**TTS 用「预置缓存文件」代替真引擎**——
// ttsService.synthesize 命中缓存就直接返回该文件（不走 Python sidecar），
// 所以测试只要按 cacheKey(voiceId, 文本) 算出文件名、往 CACHE_DIR 放一段合法 WAV 即可。
// TTS_ROOT 被指到临时目录，绝不碰本机真实合成缓存。
//
//   node scripts/e2e-story.mjs
//   E2E_VERBOSE=1 node scripts/e2e-story.mjs   看服务端日志
import { spawn } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';

const PORT = 3192;
const FAKE_PORT = 3193;
const B = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), 'wb-story-'));
const TTS_ROOT = path.join(DATA, 'tts');       // 合成缓存落临时目录（CACHE_DIR = TTS_ROOT/cache）
const CACHE_DIR = path.join(TTS_ROOT, 'cache');
const STORY_DIR = path.join(DATA, 'story-audio');
process.env.DATA_DIR = DATA;
process.env.TTS_ROOT = TTS_ROOT;

let passed = 0, failed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};

// ---------- 假的 AI（OpenAI 兼容形状，与 e2e-xiaozhi-voice 同一套） ----------
const fake = { text: '小鸭子在池塘边遇到了一只小乌龟，它们成了好朋友。', hits: 0, delay: 0 };
const fakeSrv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', async () => {
    if (!req.url.endsWith('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    fake.hits++;
    await new Promise((r) => setTimeout(r, fake.delay));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: 'fake-1', usage: { total_tokens: 3 },
      choices: [{ message: { role: 'assistant', content: fake.text } }],
    }));
  });
});
await new Promise((r) => fakeSrv.listen(FAKE_PORT, r));

// ---------- WAV 工具（假音频：16bit 单声道，时长可控，能被 wavDuration 正确解析） ----------
function mk_wav(sec, sr = 16000) {
  const n = Math.max(1, Math.floor(sr * sec));
  const dataLen = n * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0, 'ascii'); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii'); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);           // PCM / 单声道
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);      // 采样率 / byteRate
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);           // blockAlign / 位深
  buf.write('data', 36, 'ascii'); buf.writeUInt32LE(dataLen, 40);
  return buf;
}
const cacheKey = (voiceId, text) => crypto.createHash('sha256').update(`${voiceId}\n${text}`).digest('hex') + '.wav';
// 与 server/services/storyService.js 的 splitText 同步（改了那边这条要跟着改；
// 下面的断言会校验切出来的段数，算法一漂移测试立刻红）
const CHUNK_MAX = 1500;
function splitText(text) {
  const s = String(text || '').trim();
  if (s.length <= CHUNK_MAX) return [s];
  const out = []; let cur = '';
  for (const piece of s.split(/(?<=[。！？!?；;\n])/)) {
    if ((cur + piece).length > CHUNK_MAX && cur) { out.push(cur); cur = ''; }
    if (piece.length > CHUNK_MAX) {
      if (cur) { out.push(cur); cur = ''; }
      for (let i = 0; i < piece.length; i += CHUNK_MAX) out.push(piece.slice(i, i + CHUNK_MAX));
    } else cur += piece;
  }
  if (cur) out.push(cur);
  return out.filter((x) => x.trim());
}
// 把某段文本的「合成结果」预置进缓存：真引擎在时这一步是 Python 干的活
function seedAudio(voiceId, text, sec = 1) {
  mkdirSync(CACHE_DIR, { recursive: true });
  const f = path.join(CACHE_DIR, cacheKey(voiceId, text));
  writeFileSync(f, mk_wav(sec));
  return f;
}

// ---------- 起被测服务 ----------
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: path.join(import.meta.dirname, '..'),
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, TTS_ROOT, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; if (process.env.E2E_VERBOSE) process.stdout.write(d); });
server.stderr.on('data', (d) => { serverLog += d; if (process.env.E2E_VERBOSE) process.stderr.write(d); });

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${B}/api/health`)).ok) return; } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('服务 60s 未就绪');
}
async function api(method, url, { token, body } = {}) {
  const r = await fetch(B + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, j: ct.includes('json') ? await r.json() : await r.text(), headers: r.headers };
}
// undici 的坑：响应体不读干净、再遇上服务端显式 Connection: close，会在 Parser.finish 里
// assert(!this.paused) 直接把测试进程崩掉（浏览器不受影响，本项目 index.js 有全局 Connection: close）。
// 凡是不看 body 的响应都显式吃掉。
async function drain(r) { try { await r.arrayBuffer(); } catch { /* 已断，忽略 */ } return r; }
let T = '';
const GET = (u) => api('GET', u, { token: T });
const POST = (u, b) => api('POST', u, { token: T, body: b });
const PATCH = (u, b) => api('PATCH', u, { token: T, body: b });
const DEL = (u) => api('DELETE', u, { token: T });

try {
  await waitReady();
  console.log('— 准备');
  const lg = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'test123456' } });
  T = lg.j.b?.token || lg.j.token;
  ok(!!T, 'admin 登录拿到 token');

  console.log('— /story/meta（音色 + 风格 + 引擎状态）');
  const meta = (await GET('/api/story/meta')).j;
  ok(Array.isArray(meta.voices) && meta.voices.length > 0, `音色清单非空（${meta.voices?.length} 个）`);
  ok(/Xiaoyu/.test(meta.default_voice_name) && /明星/.test(meta.default_voice_name),
    `默认音色 = 中文女声 · Xiaoyu（明星）`, meta.default_voice_name);
  ok(Number(meta.default_voice_id) > 0, `默认音色有 id=${meta.default_voice_id}`);
  ok(Array.isArray(meta.styles) && meta.styles.length === 6, `风格预设 6 个`, JSON.stringify(meta.styles));
  ok(meta.max_chars > 0 && meta.synth_max === 2000, '返回正文字数上限与合成上限');
  ok(meta.engine && typeof meta.engine.installed === 'boolean', '带引擎状态（未装/未跑时前端好提示）');
  const VID = Number(meta.default_voice_id);

  console.log('— 列表：初始态与分页');
  const l0 = (await GET('/api/story')).j;
  ok(l0.total === 0 && l0.pageSize === 15 && l0.page === 1, '空库：total=0 且默认每页 15 行', JSON.stringify(l0));
  ok((await api('GET', '/api/story')).status === 401, '未登录访问 /api/story → 401（权限挂在 family 页的 story tab）');

  console.log('— 新建 / 详情 / 修改');
  const c1 = await POST('/api/story', { title: '小蝌蚪找妈妈', content: '春天来了，池塘里的小蝌蚪开始找妈妈。它们游过水草，问过鸭子。' });
  ok(c1.status === 200 && c1.j.story.id > 0, '手工新建一条成功');
  ok(c1.j.story.summary.startsWith('春天来了'), '概要自动取正文开头（未填概要时）', c1.j.story.summary);
  const sid = c1.j.story.id;
  const detail = (await GET(`/api/story/${sid}`)).j.story;
  ok(detail.content.includes('小蝌蚪'), '详情能取到全文');
  ok(detail.audio_path === '' && Number(detail.audio_sec) === 0, '新建时未转音频');
  ok((await POST('/api/story', { content: '没有标题' })).status === 400, '缺故事名 → 400');
  ok((await GET('/api/story/999999')).status === 404, '不存在的 id → 404');
  ok((await PATCH(`/api/story/${sid}`, { title: '小蝌蚪找妈妈（改）' })).j.story.title === '小蝌蚪找妈妈（改）', 'PATCH 改标题落库');
  const patched = (await PATCH(`/api/story/${sid}`, { content: '改过的正文内容，用于验证概要跟着重算。' })).j.story;
  ok(patched.summary.startsWith('改过的正文'), '只改正文时概要自动重算', patched.summary);
  ok((await PATCH(`/api/story/${sid}`, { title: '   ' })).status === 400, '标题改成空白 → 400');

  console.log('— 列表：排序 / 分页 / 搜索');
  const titles = ['灰姑娘', '三只小猪', '小红帽', '丑小鸭', '卖火柴的小女孩', '海的女儿', '拇指姑娘'];
  for (const t of titles) await POST('/api/story', { title: t, content: `${t}的故事正文。` });
  const all = (await GET('/api/story')).j;
  ok(all.total === 8 && all.pageSize === 15 && all.pages === 1, `共 8 条、1 页`, `${all.total}/${all.pages}`);
  ok(all.stories[0].title === '拇指姑娘', '按 id 倒序（最新建的排最前）', all.stories[0].title);
  ok(all.stories.every((s) => s.content === undefined), '列表不带正文（长文本不随列表下发）');
  const p1 = (await GET('/api/story?page=1&page_size=5')).j;
  ok(p1.pageSize === 5 && p1.pages === 2 && p1.stories.length === 5, '每页 5 行 → 2 页，首页 5 条');
  const p2 = (await GET('/api/story?page=2&page_size=5')).j;
  ok(p2.page === 2 && p2.stories.length === 3, '第 2 页 3 条');
  ok((await GET('/api/story?page=99&page_size=5')).j.page === 2, '页码越界收敛到最后一页');
  ok((await GET('/api/story?page_size=7')).j.pageSize === 15, '非法每页量（7）回落 15');
  for (const n of [5, 15, 30, 50, 100]) {
    ok((await GET(`/api/story?page_size=${n}`)).j.pageSize === n, `每页量 ${n} 生效`);
  }
  ok((await GET('/api/story?q=' + encodeURIComponent('小猪'))).j.total === 1, '模糊搜故事名命中 1 条');
  ok((await GET('/api/story?q=' + encodeURIComponent('故事正文'))).j.total === 7, '模糊搜概要也能命中（7 条）');
  const esc = await POST('/api/story', { title: '折扣100%的故事', content: '百分号不是通配符。' });
  ok((await GET('/api/story?q=' + encodeURIComponent('%'))).j.total === 1, 'LIKE 通配符被转义：搜 % 只命中含字面 % 的那条');
  ok((await GET('/api/story?q=' + encodeURIComponent('100%'))).j.total === 1, '搜「100%」命中该条');
  ok((await GET('/api/story?q=' + encodeURIComponent('_'))).j.total === 0, '下划线同样被转义（不会命中任意单字）');
  await DEL(`/api/story/${esc.j.story.id}`);

  console.log('— 导入 txt / md');
  const fd = new FormData();
  fd.append('file', new File([Buffer.from('从前有座山，山里有座庙。', 'utf8')], '山里的故事.txt', { type: 'text/plain' }));
  const imp = await fetch(`${B}/api/story/import`, { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: fd });
  const impJ = await imp.json();
  ok(imp.status === 200 && impJ.story, '导入 txt 成功', JSON.stringify(impJ).slice(0, 120));
  ok(impJ.story.title === '山里的故事', '中文文件名不乱码且去掉扩展名作标题', impJ.story.title);
  ok(impJ.story.source === 'import' && impJ.story.content.includes('从前有座山'), '导入内容与来源标记正确');
  const fd2 = new FormData();
  fd2.append('file', new File([Buffer.from('', 'utf8')], 'empty.txt', { type: 'text/plain' }));
  const imp2 = await drain(await fetch(`${B}/api/story/import`, { method: 'POST', headers: { Authorization: 'Bearer ' + T }, body: fd2 }));
  ok(imp2.status === 400, '空文件导入 → 400');

  console.log('— AI 生成故事（假 AI）');
  ok((await POST('/api/story/gen', { style: '温馨睡前' })).status === 400, '未配置 AI 算力 → 400 且不炸');
  const setAi = await api('POST', '/api/ai/config', { token: T, body: { model: 'fake-1', base_url: `http://127.0.0.1:${FAKE_PORT}/ai/v1`, api_key: 'sk-fake' } });
  ok(setAi.status === 200, '配置假 AI 算力');
  const g1 = await POST('/api/story/gen', { style: '温馨睡前', topic: '小乌龟' });
  ok(g1.status === 200 && g1.j.story.source === 'ai', 'AI 生成成功且标记 source=ai', JSON.stringify(g1.j).slice(0, 120));
  ok(g1.j.story.content.includes('小鸭子'), '生成正文来自 AI 返回');
  ok(fake.hits === 1, '确实调了一次 AI 接口');
  const g2 = await POST('/api/story/gen', {});
  ok(g2.status === 200 && g2.j.story.title.length > 0, '不给风格/主题（随机）也能生成');

  console.log('— 文字转音频（预置合成缓存 → 真走分段拼接链路）');
  // 单段：正文 ≤1500 字，直接命中一条缓存
  const one = (await POST('/api/story', { title: '睡前小故事', content: '月亮升起来了，小兔子回家睡觉。' })).j.story;
  seedAudio(VID, one.content, 2);
  const t1 = await POST(`/api/story/${one.id}/tts`, { voice_id: null });
  ok(t1.status === 200 && t1.j.story.audio_path, '转音频成功（默认音色）', JSON.stringify(t1.j).slice(0, 160));
  ok(/Xiaoyu/.test(t1.j.story.voice_name), '音频音色记为默认的 Xiaoyu', t1.j.story.voice_name);
  ok(existsSync(t1.j.story.audio_path) && t1.j.story.audio_path.startsWith(STORY_DIR), '音频落到 data/story-audio/（不是合成缓存目录）', t1.j.story.audio_path);
  ok(Math.abs(Number(t1.j.story.audio_sec) - 2) < 0.2, `音频时长 ≈2 秒（读到 ${t1.j.story.audio_sec}）`);
  ok(Number(t1.j.story.audio_bytes) > 44, '音频字节数已记录');
  // 多段：>1500 字正文 → 服务端切段各自合成再拼 WAV
  const seg1 = '小鸭子。'.repeat(200);
  const seg2 = '大灰狼。'.repeat(200);
  const longText = seg1 + seg2;
  const segs = splitText(longText);
  ok(segs.length === 2 && longText.length > CHUNK_MAX, `长文本被切成 ${segs.length} 段（测试夹具与 storyService.splitText 同步）`);
  const two = (await POST('/api/story', { title: '长故事', content: longText })).j.story;
  segs.forEach((s) => seedAudio(VID, s, 1.5));
  const t2 = await POST(`/api/story/${two.id}/tts`, { voice_id: null });
  ok(t2.status === 200, '长故事转音频成功（两段拼接）', JSON.stringify(t2.j).slice(0, 160));
  ok(Math.abs(Number(t2.j.story.audio_sec) - segs.length * 1.5) < 0.3, `拼接后时长 ≈ 段数×1.5s（读到 ${t2.j.story.audio_sec}）`);
  const wav = readFileSync(t2.j.story.audio_path);
  ok(wav.toString('ascii', 0, 4) === 'RIFF' && wav.toString('ascii', 8, 12) === 'WAVE', '成品是合法 WAV（RIFF/WAVE 头）');
  ok(wav.readUInt32LE(4) === wav.length - 8, 'RIFF size 字段与实际字节数一致（拼接头部写对了）');
  // 换音色重转：旧音频文件被删（不留孤儿）
  const other = meta.voices.find((v) => Number(v.id) !== VID);
  const oldFile = t2.j.story.audio_path;
  seedAudio(Number(other.id), segs[0], 1.5);
  segs.slice(1).forEach((s) => seedAudio(Number(other.id), s, 1.5));
  const t3 = await POST(`/api/story/${two.id}/tts`, { voice_id: other.id });
  ok(t3.status === 200 && t3.j.story.voice_id === Number(other.id), '指定音色重转成功');
  ok(!existsSync(oldFile), '重转后旧音频文件被删掉（不留孤儿文件）');
  ok((await POST('/api/story/999999/tts', {})).status === 400, '给不存在的故事转音频 → 400');

  console.log('— 播放与下载');
  const p = t1.j.story;
  const raw = await fetch(`${B}/api/story/${p.id}/audio?token=${encodeURIComponent(T)}`);
  ok(raw.status === 200 && raw.headers.get('content-type') === 'audio/wav', '播放端点 200 + audio/wav');
  ok(raw.headers.get('accept-ranges') === 'bytes', '声明 Accept-Ranges（配合 Range 拖进度）');
  const size = Number(p.audio_bytes);
  const rawBuf = Buffer.from(await raw.arrayBuffer());
  ok(rawBuf.length === size && rawBuf.toString('ascii', 0, 4) === 'RIFF', `200 时整段回全文件（${rawBuf.length} 字节）`);
  const r206 = await fetch(`${B}/api/story/${p.id}/audio?token=${encodeURIComponent(T)}`, { headers: { Range: 'bytes=0-99' } });
  ok(r206.status === 206 && r206.headers.get('content-range') === `bytes 0-99/${size}`, 'Range 请求 206 + Content-Range 正确', r206.headers.get('content-range'));
  ok((await r206.arrayBuffer()).byteLength === 100, '206 只回 100 字节');
  const r416 = await drain(await fetch(`${B}/api/story/${p.id}/audio?token=${encodeURIComponent(T)}`, { headers: { Range: `bytes=${size}-` } }));
  ok(r416.status === 416 && r416.headers.get('content-range') === `bytes */${size}`, '越界 Range → 416 + 总长度');
  ok((await drain(await fetch(`${B}/api/story/${p.id}/audio`))).status === 401, '播放端点未带 token → 401');
  const dl = await fetch(`${B}/api/story/${p.id}/download?token=${encodeURIComponent(T)}`);
  const dlBuf = Buffer.from(await dl.arrayBuffer());
  const cd = dl.headers.get('content-disposition') || '';
  ok(dl.status === 200 && cd.startsWith('attachment;'), '下载走 attachment');
  ok(/filename\*=UTF-8''/.test(cd) && /filename="[^"]+"/.test(cd), '下载文件名带 RFC5987 UTF-8 名 + ASCII 兜底', cd);
  ok(dlBuf.length === size, '下载内容与播放同源同字节数');
  ok((await drain(await fetch(`${B}/api/story/${two.id}/download?token=${encodeURIComponent(T)}`))).status === 200, '转好音频的故事可下载');
  const noAudio = (await POST('/api/story', { title: '还没转音频', content: '空的。' })).j.story;
  ok((await GET(`/api/story/${noAudio.id}/audio`)).status === 404, '没转音频时播放 → 404 提示');
  ok((await GET(`/api/story/${noAudio.id}/download`)).status === 404, '没转音频时下载 → 404 提示');

  console.log('— 删除（条目 + 音频文件）');
  const delFile = t1.j.story.audio_path;
  ok((await DEL(`/api/story/${p.id}`)).status === 200, '删除故事成功');
  ok(!existsSync(delFile), '音频文件随条目一起删掉');
  ok((await GET(`/api/story/${p.id}`)).status === 404, '删除后详情 404');
  ok((await DEL(`/api/story/${p.id}`)).status === 404, '重复删除 → 404');
  // 共造 15 条（手工 1 + 7 篇 + 1 条搜转义用 + 导入 1 + AI 2 + 转音频 2 + 无音频 1），删掉 2 条（搜转义那条 + 睡前小故事）
  const after = (await GET('/api/story')).j;
  ok(after.total === 13, `删除后总数正确（${after.total}，应为 13）`);
} catch (e) {
  failed++;
  console.error('  ✗ 未捕获异常:', e.message);
  if (serverLog) console.error(serverLog.slice(-2000));
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  try { fakeSrv.close(); } catch { /* 已关 */ }
  try { rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows 文件占用，忽略 */ }
  console.log(`\n${failed === 0 ? '✅' : '❌'} 通过 ${passed} / 失败 ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}
