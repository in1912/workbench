// 儿童故事（v1.9.36，家庭管理页的「儿童故事」tab）
// 职责：故事条目 CRUD（库）+ 文字转音频（调 ttsService 合成、**把成品拷出合成缓存**）+ AI 生成故事 + txt/md 导入。
//
// 两个必须知道的点：
// ① ttsService.synthesize() 返回的是**共享合成缓存**里的文件（同音色同文本秒回，缓存超 600MB 会按
//    mtime 淘汰到 400MB 以下）。故事音频直接指着缓存文件用 = 哪天被淘汰掉就成哑巴，所以合成完一律
//    fs.copyFile 到 data/story-audio/ 下自己存一份。
// ② 单次合成上限 2000 字符（引擎限制）。长故事按句号切段分别合成再拼 WAV——拼接前逐段比对 fmt 块，
//    格式不一致宁可报错也不出噪声。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataDir, db } = require('../db');
const ttsService = require('./ttsService');
const aiService = require('./aiService');
const { wavDuration } = require('../lib/audioMeta');

const STORY_DIR = path.join(dataDir, 'story-audio');
const SYNTH_MAX = 2000;      // 引擎硬上限（ttsService.js 里也是这个数）
const CHUNK_MAX = 1500;      // 我们自己切段的长度，留出余量
const GEN_MAX_CHARS = 900;   // AI 生成的故事正文上限（约 3-4 分钟音频，睡前故事合适）

function ensureDir() { fs.mkdirSync(STORY_DIR, { recursive: true }); }

// 默认音色 = 中文女声 · Xiaoyu（明星）。按 preset 查 id，不硬编码数字 id
// （音色表会被 ensureSeeded 重建/补全，数字 id 不是稳定标识）。
function defaultVoice() {
  ttsService.getVoice(0); // 顺手触发 ttsService.ensureSeeded()：没人先播种过的话，直接查表会查到空
  const v = db.prepare("SELECT id, name FROM tts_voices WHERE preset='Xiaoyu'").get();
  if (v) return v;
  const id = ttsService.defaultVoiceId(null);
  return (id && ttsService.getVoice(id)) || null;
}

// ---------- WAV 拼接 ----------
function parseWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是合法的 WAV 音频');
  }
  let off = 12; let fmt = null; let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const end = Math.min(off + 8 + size, buf.length);
    if (id === 'fmt ') fmt = Buffer.from(buf.subarray(off + 8, end));
    else if (id === 'data') data = Buffer.from(buf.subarray(off + 8, end));
    off += 8 + size + (size % 2); // 块按偶数字节对齐
  }
  if (!fmt || !data) throw new Error('WAV 缺少 fmt 或 data 块');
  return { fmt, data };
}

function concatWav(bufs) {
  if (bufs.length === 1) return bufs[0];
  const parts = bufs.map(parseWav);
  const fmt0 = parts[0].fmt;
  for (const p of parts.slice(1)) {
    if (!p.fmt.equals(fmt0)) throw new Error('分段音频格式不一致，无法拼接（换个音色重试）');
  }
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
  const fmtChunk = Buffer.concat([
    Buffer.from('fmt ', 'ascii'), u32(fmt0.length), fmt0,
    fmt0.length % 2 ? Buffer.from([0]) : Buffer.alloc(0),
  ]);
  const dataLen = parts.reduce((n, p) => n + p.data.length, 0);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'ascii');
  // RIFF size = 整文件长度 - 8（'RIFF'+size 这 8 字节本身不算）＝ 'WAVE' + 各子块。
  // 别写成 12+…——那等于把 'RIFF'+size 也算进去，头部会大 8 字节（宽容的解码器照样播，
  // 严格校验的播放器/工具会判文件损坏）
  head.writeUInt32LE(4 + fmtChunk.length + 8 + dataLen, 4);
  head.write('WAVE', 8, 'ascii');
  return Buffer.concat([head, fmtChunk, Buffer.from('data', 'ascii'), u32(dataLen), ...parts.map((p) => p.data)]);
}

// 按句末标点切成 ≤CHUNK_MAX 的段（尽量在句子边界断，读起来才不像被掐断）
function splitText(text) {
  const s = String(text || '').trim();
  if (s.length <= CHUNK_MAX) return [s];
  const out = [];
  let cur = '';
  // 在句末标点后切开；没有标点的长串再按长度硬切
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

// 文本 → WAV 文件（落到 data/story-audio/ 下）；返回 { file, bytes, sec, voice }
async function textToAudio(text, voiceId) {
  const txt = String(text || '').trim();
  if (!txt) throw new Error('故事内容是空的，没法转音频');
  if (txt.length > SYNTH_MAX * 20) throw new Error(`故事太长了（${txt.length} 字），请精简到 ${SYNTH_MAX * 20} 字以内再转音频`);
  const voice = (voiceId && ttsService.getVoice(voiceId)) || defaultVoice();
  if (!voice) throw new Error('音色库为空：请先在「语音配音」里准备音色，或等模型下载完自动播种');

  const segs = splitText(txt);
  const bufs = [];
  for (const seg of segs) {
    // eslint-disable-next-line no-await-in-loop
    const file = await ttsService.synthesize(voice.id, seg);
    bufs.push(fs.readFileSync(file));
  }
  const wav = concatWav(bufs);
  ensureDir();
  const name = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}.wav`;
  const full = path.join(STORY_DIR, name);
  fs.writeFileSync(full, wav);
  let sec = 0;
  try { sec = wavDuration(wav) || 0; } catch { sec = 0; }
  return { file: full, bytes: wav.length, sec, voice: { id: voice.id, name: voice.name } };
}

// 删音频文件（容错：文件不在也照样把表里的引用清掉）
function removeAudio(file) {
  if (!file) return;
  try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (e) { console.warn('[story] 删除音频失败', e.message); }
}

// 概要：优先用显式传入的；否则取正文前 60 字（去掉换行）
function makeSummary(summary, content) {
  const s = String(summary || '').trim();
  if (s) return s.slice(0, 200);
  return String(content || '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

// ---------- 条目 CRUD ----------
const COLS = 'id, title, summary, content, source, voice_id, voice_name, audio_path, audio_sec, audio_bytes, created_by, created_by_name, created_at, updated_at';

function listStories(fdb, { page = 1, pageSize = 15, q = '' } = {}) {
  const sizes = [5, 15, 30, 50, 100];
  const size = sizes.includes(Number(pageSize)) ? Number(pageSize) : 15;
  const kw = String(q || '').trim();
  const where = kw ? " WHERE title LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\'" : '';
  const like = '%' + kw.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
  const args = kw ? [like, like] : [];
  const total = fdb.prepare('SELECT COUNT(*) c FROM kid_stories' + where).get(...args).c;
  const pages = Math.max(1, Math.ceil(total / size));
  const p = Math.min(Math.max(Number(page) || 1, 1), pages);
  // 列表不带 content（可能很长），点开条目再单独拉
  const rows = fdb.prepare(
    `SELECT ${COLS.replace('content, ', '')} FROM kid_stories` + where + ' ORDER BY id DESC LIMIT ? OFFSET ?'
  ).all(...args, size, (p - 1) * size);
  return { total, page: p, pages, pageSize: size, stories: rows };
}

function getStory(fdb, id) {
  return fdb.prepare(`SELECT ${COLS} FROM kid_stories WHERE id=?`).get(Number(id));
}

function createStory(fdb, { title, summary, content, source = 'manual' } = {}, user) {
  const t = String(title || '').trim();
  if (!t) throw new Error('故事名称不能为空');
  const c = String(content || '').trim();
  const r = fdb.prepare(
    'INSERT INTO kid_stories (title, summary, content, source, created_by, created_by_name) VALUES (?,?,?,?,?,?)'
  ).run(t.slice(0, 120), makeSummary(summary, c), c, source, user ? user.id : null, user ? user.username : '');
  return getStory(fdb, r.lastInsertRowid);
}

function updateStory(fdb, id, patch = {}) {
  const cur = getStory(fdb, id);
  if (!cur) throw new Error('故事不存在');
  const sets = []; const args = [];
  if (patch.title !== undefined) {
    const t = String(patch.title || '').trim();
    if (!t) throw new Error('故事名称不能为空');
    sets.push('title=?'); args.push(t.slice(0, 120));
  }
  if (patch.summary !== undefined) { sets.push('summary=?'); args.push(String(patch.summary || '').slice(0, 200)); }
  if (patch.content !== undefined) {
    sets.push('content=?'); args.push(String(patch.content || ''));
    if (patch.summary === undefined) { sets.push('summary=?'); args.push(makeSummary('', patch.content)); }
  }
  if (!sets.length) return cur;
  sets.push("updated_at=datetime('now','localtime')");
  fdb.prepare(`UPDATE kid_stories SET ${sets.join(', ')} WHERE id=?`).run(...args, cur.id);
  return getStory(fdb, cur.id);
}

function deleteStory(fdb, id) {
  const cur = getStory(fdb, id);
  if (!cur) return false;
  removeAudio(cur.audio_path);
  fdb.prepare('DELETE FROM kid_stories WHERE id=?').run(cur.id);
  return true;
}

// 转音频：合成完把成品路径与时长写回条目
async function synthStory(fdb, id, voiceId) {
  const cur = getStory(fdb, id);
  if (!cur) throw new Error('故事不存在');
  const r = await textToAudio(cur.content, voiceId);
  removeAudio(cur.audio_path); // 重转：旧音频先删，避免磁盘上堆孤儿
  fdb.prepare("UPDATE kid_stories SET audio_path=?, audio_sec=?, audio_bytes=?, voice_id=?, voice_name=?, updated_at=datetime('now','localtime') WHERE id=?")
    .run(r.file, r.sec, r.bytes, r.voice.id, r.voice.name, cur.id);
  return getStory(fdb, cur.id);
}

// ---------- AI 生成故事 ----------
const STYLES = ['温馨睡前', '动物冒险', '勇敢成长', '奇幻魔法', '科普小知识', '幽默搞笑'];

function buildGenPrompt(topic, style) {
  const st = String(style || '').trim() || STYLES[Math.floor(Math.random() * STYLES.length)];
  const tp = String(topic || '').trim();
  const sys = '你是儿童故事作家。写适合 3-8 岁孩子的中文故事，语言简单、温暖、有画面感，结尾要有正向的小道理。'
    + `篇幅 ${GEN_MAX_CHARS} 字以内，直接输出故事正文，不要标题、不要 markdown、不要列表、不要任何解释或前言。`;
  const user = tp ? `主题：${tp}\n风格：${st}` : `没有指定主题，请你随机想一个孩子会喜欢的小主题。\n风格：${st}`;
  return { sys, user, style: st, topic: tp };
}

async function genStory(tdb, { topic, style } = {}) {
  if (!aiService.hasConfig(tdb)) throw new Error('还没配置 AI 算力（去「设置 → AI 配置」填一下），没法自动生成');
  const { sys, user, style: st, topic: tp } = buildGenPrompt(topic, style);
  const content = String(await aiService.chat(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { maxTokens: 1600, temperature: 0.9, tdb },
  ) || '').trim();
  if (!content) throw new Error('AI 没返回内容，再点一次试试');
  const body = content.slice(0, GEN_MAX_CHARS * 2);
  // 标题：取正文第一句（AI 被要求不写标题），太长了就按主题/风格兜底
  const first = (body.split(/[。！？\n]/)[0] || '').trim();
  let title = first.length >= 4 && first.length <= 20 ? first : (tp ? `${tp}（${st}）` : `${st}故事`);
  return { title: title.slice(0, 120), content: body, summary: makeSummary('', body), style: st, topic: tp };
}

module.exports = {
  STORY_DIR, SYNTH_MAX, GEN_MAX_CHARS, STYLES,
  listStories, getStory, createStory, updateStory, deleteStory,
  synthStory, genStory, textToAudio, defaultVoice, splitText, concatWav, makeSummary,
};
