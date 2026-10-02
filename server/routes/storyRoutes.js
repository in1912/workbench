// 儿童故事（v1.9.36）——家庭管理页「儿童故事」tab 的服务端。
// 数据是「家庭」共享族（全家共看）：读写一律走 routedDb(req.tdb, 'family')，
// 家庭共享开关开着时进主库、关掉时各回各的租户库，与留言板/子女学习同一套语义。
// 权限：/story 前缀在 auth.js 的 pageForPath 映射到 'family' 页、TAB_PATHS.family 的 'story' 子 tab。
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { routedDb } = require('../db');
const story = require('../services/storyService');
const ttsService = require('../services/ttsService');
const fileTextService = require('../services/fileTextService');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// 中文文件名乱码修复（与 misc.js 的 fixMojibakeName 同源）：multer/busboy 把浏览器发来的
// UTF-8 文件名按 latin1 解码（「小红帽.txt」→「å°çº¢å¸½.txt」），导入的故事名会跟着变乱码。
// 还原 = 按 latin1 取回字节再按 UTF-8 解码；本来就是好名字时重转会出替换符，此时保持原样。
function fixMojibakeName(name) {
  if (!name) return name;
  try {
    const converted = Buffer.from(String(name), 'latin1').toString('utf8');
    return converted === name || converted.includes('�') ? name : converted;
  } catch { return name; }
}
const fdb = (req) => routedDb(req.tdb, 'family');

// ---------- 元信息（音色清单 + 风格预设 + 引擎状态）----------
// 音色表在主库（tts_voices 是全平台共享的），直接问 ttsService 要，别从租户库查
router.get('/story/meta', async (req, res) => {
  try {
    const voices = ttsService.listVoices().map((v) => ({ id: v.id, name: v.name, kind: v.kind }));
    const def = story.defaultVoice();
    // 引擎状态给面板提示用（未装/未起时「文字转音频」必失败，先告诉用户去哪儿开，别让他对着报错猜）。
    // status() 内部只是探一次本地端口（不通立刻回 null），不会拉起 sidecar
    let engine = { installed: false, running: false, phase: 'unknown' };
    try {
      const st = await ttsService.status();
      engine = { installed: !!st.installed, running: !!st.running, phase: st.phase || '' };
    } catch { /* 探测失败按未就绪处理 */ }
    res.json({
      voices,
      default_voice_id: def ? def.id : 0,
      default_voice_name: def ? def.name : '',
      styles: story.STYLES,
      max_chars: story.GEN_MAX_CHARS,
      synth_max: story.SYNTH_MAX,
      engine,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- 列表（服务端分页 + 名称/概要模糊搜）----------
router.get('/story', (req, res) => {
  try {
    res.json(story.listStories(fdb(req), {
      page: req.query.page, pageSize: req.query.page_size || req.query.pageSize, q: req.query.q,
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- AI 生成故事（弹窗里给风格/主题，或留空随机）----------
router.post('/story/gen', async (req, res) => {
  try {
    const b = req.body || {};
    const g = await story.genStory(req.tdb, { topic: b.topic, style: b.style });
    // 生成即入库（用户点「生成」是想要一条故事，不是想要一段文本；不满意直接删）
    const row = story.createStory(fdb(req), { ...g, source: 'ai' }, req.user);
    res.json({ story: row, style: g.style, topic: g.topic });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- 导入 txt / md ----------
router.post('/story/import', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '没收到文件（支持 txt / md）' });
    const orig = fixMojibakeName(req.file.originalname);
    // extractText 回的是 { text, engine }，不是裸字符串（txt/md/csv… 走 'plain' 分支，UTF-8 去 BOM）
    const ex = fileTextService.extractText(orig, req.file.mimetype, req.file.buffer);
    const content = String((ex && ex.text) || '').trim();
    if (!content) return res.status(400).json({ error: '文件里没读到文字（只支持纯文本类文件）' });
    const base = String(path.parse(orig).name || '').trim();
    const title = String((req.body && req.body.title) || base || '导入的故事').slice(0, 120);
    res.json({ story: story.createStory(fdb(req), { title, content, source: 'import' }, req.user) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- 单条 ----------
router.get('/story/:id', (req, res) => {
  const row = story.getStory(fdb(req), req.params.id);
  if (!row) return res.status(404).json({ error: '故事不存在' });
  res.json({ story: row });
});

router.post('/story', (req, res) => {
  try {
    const b = req.body || {};
    res.json({ story: story.createStory(fdb(req), { title: b.title, summary: b.summary, content: b.content, source: 'manual' }, req.user) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/story/:id', (req, res) => {
  try {
    res.json({ story: story.updateStory(fdb(req), req.params.id, req.body || {}) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.delete('/story/:id', (req, res) => {
  try {
    const ok = story.deleteStory(fdb(req), req.params.id);
    if (!ok) return res.status(404).json({ error: '故事不存在' });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- 文字转音频（默认音色 = 中文女声 · Xiaoyu（明星））----------
// 合成可能要几十秒（模型冷启动更久），前端超时按 300s 配——复用 api.post 的默认超时不够，见前端
router.post('/story/:id/tts', async (req, res) => {
  try {
    const voiceId = (req.body && req.body.voice_id) || null;
    res.json({ story: await story.synthStory(fdb(req), req.params.id, voiceId ? Number(voiceId) : null) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- 播放（inline + Range/206，照 /vibe/audio/:id）----------
router.get('/story/:id/audio', (req, res) => {
  const row = story.getStory(fdb(req), req.params.id);
  if (!row || !row.audio_path || !fs.existsSync(row.audio_path)) return res.status(404).json({ error: '还没有音频，先点「文字转音频」' });
  let st; try { st = fs.statSync(row.audio_path); } catch { return res.status(404).json({ error: '音频文件不可读' }); }
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(audioName(row, 'wav'))}`);
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range));
    let start = 0; let end = st.size - 1;
    if (m && m[1]) { start = parseInt(m[1], 10); if (m[2]) end = Math.min(parseInt(m[2], 10), st.size - 1); }
    else if (m && m[2]) { start = Math.max(0, st.size - parseInt(m[2], 10)); }
    if (!m || start >= st.size || start > end) { res.status(416).setHeader('Content-Range', `bytes */${st.size}`); return res.end(); }
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
    res.setHeader('Content-Length', end - start + 1);
    return fs.createReadStream(row.audio_path, { start, end }).pipe(res);
  }
  res.setHeader('Content-Length', st.size);
  return fs.createReadStream(row.audio_path).pipe(res);
});

// ---------- 下载（attachment + RFC5987 中文名 + ASCII 兜底）----------
router.get('/story/:id/download', (req, res) => {
  const row = story.getStory(fdb(req), req.params.id);
  if (!row || !row.audio_path || !fs.existsSync(row.audio_path)) return res.status(404).json({ error: '还没有音频，先点「文字转音频」' });
  const name = audioName(row, 'wav');
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Content-Disposition',
    `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
  return fs.createReadStream(row.audio_path).pipe(res);
});

// 下载/播放的文件名：故事名 + .wav（去掉路径分隔符与非法字符）
function audioName(row, ext) {
  const base = String(row.title || '故事').replace(/[\\/:*?"<>|\r\n\t]/g, '_').trim().slice(0, 60) || '故事';
  return `${base}.${ext}`;
}

module.exports = router;
