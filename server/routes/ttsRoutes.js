// 语音合成（MOSS-TTS-Nano 本地离线引擎）：中英文听写播报 + 语音配音独立使用 + 音色库管理
// 权限：合成/状态/音色列表/参考音频试听为学习成长页共享端点（登录即可，不绑 tab）；
//       音色上传/删除/设默认（/tts/voices 写操作）归「语音配音」tab（auth.js TAB_PATHS）。
const express = require('express');
const fs = require('fs');
const path = require('path');
const tts = require('../services/ttsService');
const installer = require('../services/ttsInstaller');
const { getSetting, setSetting } = require('../db');
const router = express.Router();

// 引擎与音色状态（听写/配音页顶部状态灯用）
router.get('/tts/status', async (req, res) => {
  res.json(await tts.status());
});

// ---------- 引擎一键安装（新环境/新 NAS 部署用；仅管理员） ----------
// 安装为长任务（下载 torch 等，分钟级）：POST 触发后立即返回，前端轮询 status 看进度
router.get('/tts/engine/status', (req, res) => {
  res.json({ ...installer.status(), installed: tts.installed() });
});
router.post('/tts/engine/install', (req, res) => {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可安装引擎' });
  res.json(installer.start({ by: req.user.username, restart: (req.body || {}).restart !== false }));
});

// 预热：显式拉起合成服务（平时首次合成也会自动拉起；此端点给“按钮全灰/想提前热机”的场景一个入口）。
// 端口起来即返回；首次的模型下载在后台继续，前端轮询 /tts/status 看 downloading/loading/ready。
router.post('/tts/engine/warmup', async (req, res) => {
  if (!tts.installed()) return res.status(400).json({ error: 'TTS 引擎未安装：请先一键安装' });
  try { await tts.ensureServer(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// 音色列表 + 当前用户默认音色
router.get('/tts/voices', (req, res) => {
  res.json({ voices: tts.listVoices(), default_voice_id: tts.defaultVoiceId(req.tdb) });
});

// 参考音频试听（<audio> 标签带不了 Authorization，走 ?token= 查询参数鉴权，同家庭图床）
// 仓库自带 assets/*.wav 实为 FLAC 数据（torchaudio 透明支持），按魔数定 Content-Type 保证浏览器能播
router.get('/tts/ref-audio/:id', (req, res) => {
  const v = tts.getVoice(req.params.id);
  if (!v || !fs.existsSync(v.file_path)) return res.status(404).json({ error: '参考音频不存在' });
  const fd = fs.openSync(v.file_path, 'r');
  const head = Buffer.alloc(12);
  fs.readSync(fd, head, 0, 12, 0);
  fs.closeSync(fd);
  const magic = head.toString('latin1');
  const mime = magic.startsWith('fLaC') ? 'audio/flac'
    : magic.startsWith('OggS') ? 'audio/ogg'
    : magic.startsWith('RIFF') ? 'audio/wav'
    : (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) || magic.startsWith('ID3') ? 'audio/mpeg' : 'audio/wav';
  res.setHeader('Content-Type', mime);
  fs.createReadStream(v.file_path).pipe(res);
});

// 合成：POST {text, voice_id?}（voice_id 缺省用当前默认音色）→ audio/wav 二进制
router.post('/tts/synthesize', async (req, res) => {
  try {
    const { text, voice_id } = req.body || {};
    const file = await tts.synthesize(voice_id || tts.defaultVoiceId(req.tdb), text);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- 音色管理（「语音配音」tab；挂 /tts/manage/* 便于 tab 级授权——
//             TAB_PATHS 按路径前缀匹配不分方法，管理写操作必须与共享读接口路径分开） ----------
// 上传音色：{name, data_base64}（前端统一转 WAV；也兼容 wav/flac/ogg/mp3 魔数——torchaudio 都能读）
router.post('/tts/manage/upload', async (req, res) => {
  try {
    const { name, data_base64 } = req.body || {};
    const b64 = String(data_base64 || '').replace(/^data:audio\/[a-z]+;base64,/, '');
    if (!b64) return res.status(400).json({ error: '音频数据为空' });
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < 1000) return res.status(400).json({ error: '音频太短，参考录音建议 10~30 秒' });
    if (buf.length > 20 * 1024 * 1024) return res.status(400).json({ error: '音频过大（>20MB），请裁剪到 30 秒左右' });
    const magic = buf.toString('latin1');
    const isAudio = magic.startsWith('RIFF') || magic.startsWith('fLaC') || magic.startsWith('OggS')
      || magic.startsWith('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
    if (!isAudio) return res.status(400).json({ error: '不识别的音频格式（支持 wav/flac/ogg/mp3）' });
    fs.mkdirSync(tts.VOICES_DIR, { recursive: true });
    const file = path.join(tts.VOICES_DIR, `v${Date.now()}_${Math.random().toString(36).slice(2, 8)}.wav`);
    fs.writeFileSync(file, buf);
    const id = tts.addVoice(name, file, req.user.id);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/tts/manage/voice/:id', (req, res) => {
  try { tts.removeVoice(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/tts/manage/default', (req, res) => {
  try { tts.setDefaultVoice(req.tdb, (req.body || {}).voice_id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// 听写偏好（逐条/自动、间隔秒数）——归各人租户配置
router.get('/tts/dictation-config', (req, res) => {
  res.json(getSetting(req.tdb, 'tts_dictation_config', null) || { mode: 'auto', interval: 30 });
});
router.post('/tts/dictation-config', (req, res) => {
  const b = req.body || {};
  const mode = b.mode === 'step' ? 'step' : 'auto';
  const interval = Math.max(3, Math.min(300, Math.floor(Number(b.interval) || 30)));
  setSetting(req.tdb, 'tts_dictation_config', { mode, interval });
  res.json({ ok: true, mode, interval });
});

// ---------- 听写历史（每次「开始听写」存一行；点列表行调取该次内容重新听写） ----------
// 保存一次生成：{content, mode?, interval?, voice_id?, voice_name?} → 记录快照（含播报配置与音色）
router.post('/tts/dictation-history', (req, res) => {
  const b = req.body || {};
  const content = String(b.content || '').replace(/\r\n/g, '\n').trim();
  if (!content) return res.status(400).json({ error: '听写内容为空' });
  if (content.length > 100000) return res.status(400).json({ error: '听写内容过长' });
  const lines = content.split('\n').map((s) => s.trim()).filter(Boolean);
  const mode = b.mode === 'step' ? 'step' : 'auto';
  const interval = Math.max(3, Math.min(300, Math.floor(Number(b.interval) || 30)));
  const info = req.tdb.prepare(
    'INSERT INTO dictation_history(content,count,mode,interval,voice_id,voice_name) VALUES(?,?,?,?,?,?)'
  ).run(lines.join('\n'), lines.length, mode, interval, Math.floor(Number(b.voice_id) || 0), String(b.voice_name || '').slice(0, 100));
  res.json({ ok: true, id: Number(info.lastInsertRowid), count: lines.length });
});

// 分页列表（新→旧）：page 从 1 起；pageSize 前端提供 15/30/50，服务端钳制 1~100
router.get('/tts/dictation-history', (req, res) => {
  const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
  const pageSize = Math.max(1, Math.min(100, Math.floor(Number(req.query.pageSize) || 15)));
  const total = req.tdb.prepare('SELECT COUNT(*) AS c FROM dictation_history').get().c;
  const records = req.tdb.prepare(
    'SELECT id, content, count, mode, interval, voice_id, voice_name, created_at FROM dictation_history ORDER BY id DESC LIMIT ? OFFSET ?'
  ).all(pageSize, (page - 1) * pageSize);
  res.json({ total, page, pageSize, records });
});

// 删除一条（只能删自己的：历史存在各人租户库）
router.delete('/tts/dictation-history/:id', (req, res) => {
  const info = req.tdb.prepare('DELETE FROM dictation_history WHERE id=?').run(Math.floor(Number(req.params.id) || 0));
  res.json({ ok: true, deleted: info.changes });
});

module.exports = router;
