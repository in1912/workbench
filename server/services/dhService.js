// 数字人（v1.12.0，智能家居页「数字人」tab）：角色注册表 + 参考图 + 历史对话 + Vivix 会话配置组装。
//
// 调研口径（2026-10-07，docs.vivix.ai 全量抓读，报告=note-intake id=174）在本文件落成代码：
//   人设 → avatars[].instructions（中文可写）；外观 → 首图定格（运行时改不了服装背景）；
//   动作 → pipeline_config.motion_enhanced（说话）/ motion_planner（倾听）两套 VMP，
//          第一段=相机与景别，官方口径「日常对话用固定机位」；
//   开场白 → source_images[0].opening.dialogue；声音 → 会话级 tts_config.tts_voice_id（9 个内置音色）；
//   output.aspect_ratio/resolution（16:9 + 720p，无 1080p）。
// 会话 JSON 只在这里组装（单一出处，同 lifeKm 的 PROMPT_MODEL 口径），库里不存组装产物。
//
// v1.12.0 范围说明：本版交付配置/参考图/人设引导/历史对话（含工作台内置 AI 的「文字试聊」，
// 走 aiService.chatEx），实时视频拉流（TRTC/Agora SDK + WSS 控制通道）在 API Key 配好并
// 验证连通后再接——/dh/personas/:id/test 的连通性测试就是那一步的前置检查。
const fs = require('fs');
const path = require('path');
const { getSetting, setSetting, tenantIdOf } = require('../db');
const storagePaths = require('./storagePaths');
const aiService = require('./aiService');

// Vivix 内置 Qwen Audio 九音色（voice.md 全表；无台湾腔——调研已确认，要特定口音走外接/克隆，暂未开通）
const VOICES = [
  { id: 'longanhuan_v3.6', label: '温暖女声 · 中英（默认）' },
  { id: 'longan_fengyue_v3.6', label: '庄重女声 · 中英' },
  { id: 'longwanxiao_v3.6', label: '轻快活泼女声 · 中文' },
  { id: 'longwanqing_v3.6', label: '轻柔舒缓女声 · 中文' },
  { id: 'longxingzhi_v3.6', label: '专业清晰男声 · 中英' },
  { id: 'xiaochen_v3.6', label: '年轻清晰男声 · 中英' },
  { id: 'Jason', label: '沉稳男声 · 英文' },
  { id: 'Emily', label: '亲切女声 · 英文' },
  { id: 'Olivia', label: '温暖女声 · 英文' },
];
const TYPES = ['男友', '女友', '宠物'];

// 人设引导构建的结构化默认值（=用户给的女友示例；「其他需要引导设置的」落在 extra 预留字段）
const PERSONA_DEFAULTS = {
  personaLine: '20 岁女友，性格温柔爱撒娇',
  shortSentences: true,      // 口语短句开关
  maxLen: 15,                // 单句字数上限
  habits: '好啦、真的假的、吼、欸你',   // 口语习惯
  callUser: '宝宝',          // 对用户的称呼
  scene: '居家、自然侧光、简洁背景、棉质背心',
  aspect: '16:9',            // 9:16|16:9|1:1
  resolution: '720p',        // Vivix 只有 480p/720p 两档，默认 720p（无 1080p）
  cameraFixed: true,         // 固定平视机位
  cameraLock: true,          // 镜头跟平移但构图锁定
  shot: '中景（画面下缘胸口）',
  ratio: '60%',              // 人物占比
  allowMove: '眨眼、微笑、轻点头、小手势、自然呼吸；1 米内缓慢移动',
  forbidMove: '快速大转头、手与头发遮脸、走出画面、剧烈运镜、改变距离',
  opening: '我在呢，怎么啦',
  interrupt: true,           // 可打断（Vivix interrupt 默认开）
  extra: '',                 // 预留：其他引导设置直接写这里
};
const ASPECTS = ['9:16', '16:9', '1:1'];
const RESOLUTIONS = ['480p', '720p'];

// ---------- persona JSON 的保存侧校验与读取侧解析（同一个函数，防「存得进读不出」） ----------
function clampStr(v, max, def) {
  const s = String(v == null ? '' : v).trim();
  return s ? s.slice(0, max) : def;
}
function sanitizePersona(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  const b = (k, d) => (typeof o[k] === 'boolean' ? o[k] : d);
  const n = Number(o.maxLen);
  return {
    personaLine: clampStr(o.personaLine, 120, PERSONA_DEFAULTS.personaLine),
    shortSentences: b('shortSentences', true),
    maxLen: Number.isFinite(n) && n >= 6 && n <= 60 ? Math.round(n) : PERSONA_DEFAULTS.maxLen,
    habits: clampStr(o.habits, 200, ''),
    callUser: clampStr(o.callUser, 30, ''),
    scene: clampStr(o.scene, 300, ''),
    aspect: ASPECTS.includes(o.aspect) ? o.aspect : PERSONA_DEFAULTS.aspect,
    resolution: RESOLUTIONS.includes(o.resolution) ? o.resolution : PERSONA_DEFAULTS.resolution,
    cameraFixed: b('cameraFixed', true),
    cameraLock: b('cameraLock', true),
    shot: clampStr(o.shot, 60, PERSONA_DEFAULTS.shot),
    ratio: clampStr(o.ratio, 20, PERSONA_DEFAULTS.ratio),
    allowMove: clampStr(o.allowMove, 300, PERSONA_DEFAULTS.allowMove),
    forbidMove: clampStr(o.forbidMove, 300, PERSONA_DEFAULTS.forbidMove),
    opening: clampStr(o.opening, 120, PERSONA_DEFAULTS.opening),
    interrupt: b('interrupt', true),
    extra: clampStr(o.extra, 2000, ''),
  };
}
function parsePersona(p) {
  try { return sanitizePersona(JSON.parse(p.persona || '{}')); } catch { return { ...PERSONA_DEFAULTS }; }
}

// ---------- 人设 → avatars[].instructions（官方五段式的中文落地；指令语言无关） ----------
function buildInstructions(name, pf) {
  const parts = [`你是${name}，${pf.personaLine}`];
  const style = [];
  if (pf.shortSentences) style.push(`说话用口语短句，一句不超过 ${pf.maxLen} 个字`);
  if (pf.habits) style.push(`常带这些口头语：${pf.habits}`);
  if (pf.callUser) style.push(`称呼对方为「${pf.callUser}」`);
  if (style.length) parts.push(style.join('，'));
  parts.push('你像真人一样自然聊天，不说教、不列长清单，只说适合开口说的话');
  if (pf.extra) parts.push(pf.extra);
  return parts.join('。') + '。';
}

// ---------- 人设 + 参考图 → 说话/倾听两套 VMP（六段式：机位/人物/场景/起始姿态/动作/收尾姿态） ----------
function cameraPhrase(pf) {
  if (!pf.cameraFixed) return pf.cameraLock
    ? '机位可以随人物小幅平移，但构图保持稳定（人物占比与景别不变）'
    : '机位自由，注意构图稳定';
  return `固定平视机位（Static waist-up shot at eye level.），镜头全程固定（The camera stays fixed.），${pf.shot}，人物约占画面 ${pf.ratio}`;
}
function buildVmps(name, pf) {
  const who = `人物是${name}${pf.scene ? `，场景：${pf.scene}` : ''}`;
  const pose = '起始姿态放松自然、面朝镜头、双手在画面内';
  const speaking = [
    cameraPhrase(pf), who, pose,
    `说话时允许：${pf.allowMove}`,
    `避免：${pf.forbidMove}`,
    '说完回到放松的自然姿态',
  ].join('。') + '。';
  const listening = [
    cameraPhrase(pf), who, pose,
    '倾听时安静克制：点头、保持眼神接触、呼吸自然起伏、偶尔歪头浅笑（比说话时更安静）',
    `同样避免：${pf.forbidMove}`,
    '保持放松的自然姿态',
  ].join('。') + '。';
  return { speaking, listening };
}

// ---------- 会话配置组装（预览/复制用；真实建会话在接入实时拉流时用同一函数） ----------
function buildSessionJson(tdb, p) {
  const pf = parsePersona(p);
  const images = tdb.prepare(
    'SELECT * FROM dh_images WHERE persona_id=? ORDER BY sort ASC, id ASC LIMIT 8'
  ).all(p.id);
  const { speaking, listening } = buildVmps(p.name, pf);
  const mkUrl = (im) => `https://<你的公网域名>/api/dh/images/${im.id}/raw`;
  const sourceImages = images.slice(0, 5).map((im, i) => ({ // Vivix 限每角色 ≤5 张源图
    source_image_id: `img${im.id}`,
    // ⚠️ Vivix 要求公网 HTTPS 可下载（不支持 base64）：接入实时会话时这里要换成公网可达直链
    url: mkUrl(im),
    media_type: im.mime || 'image/png',
    description: im.description || `${pf.shot}、面朝镜头、手在画内${pf.scene ? '，' + pf.scene : ''}`,
    ...(i === 0 && pf.opening ? { opening: { dialogue: pf.opening } } : {}),
  }));
  const session = {
    model: p.model,
    output: { aspect_ratio: pf.aspect, resolution: pf.resolution },
    avatars: [{
      avatar_id: 'main',
      instructions: buildInstructions(p.name, pf),
      visual: {
        ...(sourceImages.length ? {
          source_images: sourceImages,
          default_source_image_id: sourceImages[0].source_image_id,
        } : {}),
      },
    }],
    pipeline_config: {
      tts_config: { tts_voice_id: p.voice_id },
      motion_enhanced: { prompt: speaking },   // 说话时动作
      motion_planner: { prompt: listening },   // 倾听/待机时动作
    },
    // 可打断（interrupt 默认开）；delivery 默认 trtc，max_duration_seconds 默认 1200（20 分钟）
    delivery: { media: { transport: 'trtc' } },
  };
  return session;
}

// ---------- 对外 DTO（api_key 一律擦掉，只回 hasKey） ----------
function publicPersona(tdb, p) {
  const images = tdb.prepare(
    'SELECT id, persona_id, orig_name, mime, size, description, sort, created_at FROM dh_images WHERE persona_id=? ORDER BY sort ASC, id ASC'
  ).all(p.id).map((im) => ({ ...im, url: `/api/dh/images/${im.id}/raw` }));
  return {
    id: p.id, name: p.name, type: p.type,
    api_base: p.api_base, model: p.model, voice_id: p.voice_id,
    hasKey: !!p.api_key,
    remark: p.remark, note: p.note,
    persona: parsePersona(p),
    is_default: !!p.is_default,
    created_at: p.created_at, updated_at: p.updated_at,
    images,
  };
}
function listPersonas(tdb) {
  return tdb.prepare('SELECT * FROM dh_personas ORDER BY is_default DESC, id ASC').all()
    .map((p) => publicPersona(tdb, p));
}

// ---------- 参考图存取（磁盘优先，回退 base64 入库——同笔记附件口径） ----------
function storeImage(tdb, personaId, { originalname, mimetype, buffer }) {
  const uid = tenantIdOf(tdb);
  const p = storagePaths.bestEffortSave('dh-images', originalname, buffer, uid != null ? `t${uid}_` : '');
  if (!p) {
    if (buffer.length > 4 * 1024 * 1024) return { error: '未配置上传目录，无法保存大于 4MB 的图片' };
  }
  const r = tdb.prepare(
    'INSERT INTO dh_images(persona_id,file,orig_name,mime,size,storage_path,data,description,sort) VALUES(?,?,?,?,?,?,?,?,?)'
  ).run(personaId, String(originalname || 'image'), String(originalname || 'image'),
    mimetype || 'image/png', buffer.length, p || '', p ? '' : buffer.toString('base64'),
    '', nextSort(tdb, personaId));
  return { id: Number(r.lastInsertRowid) };
}
function nextSort(tdb, personaId) {
  const r = tdb.prepare('SELECT COALESCE(MAX(sort),-1)+1 AS s FROM dh_images WHERE persona_id=?').get(personaId);
  return Number(r.s || 0);
}

// 没有默认人物时把最早的一个补为默认（删光则保持空）
function ensureDefault(tdb) {
  const any = tdb.prepare('SELECT id FROM dh_personas WHERE is_default=1').get();
  if (any) return;
  const first = tdb.prepare('SELECT id FROM dh_personas ORDER BY id ASC LIMIT 1').get();
  if (first) tdb.prepare('UPDATE dh_personas SET is_default=1 WHERE id=?').run(first.id);
}

// ---------- 首次种子：默认数字人（女友示例）+ 随包参考图 ----------
// 参考图随包在 server/dh/seed/（来自 D:\CC\参考资料\数字人，用户指定的首次默认配图），
// 首次进 /dh/meta 时拷进该租户的图存；用租户 settings 键做一次性闸门——用户后来删光也不再自动补。
const SEED_DIR = path.join(__dirname, '..', 'dh', 'seed');
const SEED_FILES = [
  'idol_hero_lively.png', 'idol_hero_locked.png', '00-idol_hero_lively_b.png',
  '01_front.png', '02_side.png', '03_back.png', '04_hair_front.png', '05_hair_side.png',
];
function seedIfNeeded(tdb) {
  if (getSetting(tdb, 'dh_seeded_v1', false)) return;
  setSetting(tdb, 'dh_seeded_v1', true);
  const has = tdb.prepare('SELECT COUNT(*) AS c FROM dh_personas').get();
  if (has.c > 0) return; // 已有数据（老租户）不种
  const r = tdb.prepare(`INSERT INTO dh_personas(name,type,voice_id,remark,note,persona,is_default)
    VALUES(?,?,?,?,?,?,1)`).run('小星', '女友', 'longwanxiao_v3.6',
    '默认示例：20 岁女友', '首次使用自动创建的示例数字人；可在设置里改人设或换参考图',
    JSON.stringify(PERSONA_DEFAULTS));
  const pid = Number(r.lastInsertRowid);
  for (const f of SEED_FILES) {
    try {
      const full = path.join(SEED_DIR, f);
      if (!fs.existsSync(full)) continue;
      storeImage(tdb, pid, { originalname: f, mimetype: 'image/png', buffer: fs.readFileSync(full) });
    } catch (e) { console.warn(`[dh] 种子图 ${f} 写入失败：${e.message}`); }
  }
}

// ---------- 历史对话 ----------
function addHistory(tdb, personaId, role, text) {
  const r = tdb.prepare('INSERT INTO dh_history(persona_id,role,text) VALUES(?,?,?)')
    .run(personaId, role === 'user' ? 'user' : 'assistant', String(text || '').slice(0, 8000));
  return tdb.prepare('SELECT * FROM dh_history WHERE id=?').get(Number(r.lastInsertRowid));
}
function recentHistory(tdb, personaId, n) {
  return tdb.prepare(
    `SELECT * FROM (SELECT id,role,text,audio_file,ts FROM dh_history WHERE persona_id=? ORDER BY id DESC LIMIT ?)
     ORDER BY id ASC`
  ).all(personaId, n);
}

// ---------- 文字试聊：走工作台已配置的 AI（aiService 总配置），system=组装好的人设 ----------
// 实时 Vivix 会话接入后，同一张 dh_history 表继续接语音转写与回复，气泡区一套 UI。
async function chat(tdb, personaId, text) {
  const p = tdb.prepare('SELECT * FROM dh_personas WHERE id=?').get(personaId);
  if (!p) throw new Error('数字人不存在');
  const pf = parsePersona(p);
  const system = buildInstructions(p.name, pf)
    + (pf.scene ? `（场景设定：${pf.scene}，仅作背景理解，不要主动报幕）` : '');
  const msgs = [{ role: 'system', content: system }];
  for (const h of recentHistory(tdb, personaId, 12)) {
    msgs.push({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text });
  }
  msgs.push({ role: 'user', content: String(text || '').slice(0, 4000) });
  const out = await aiService.chatEx(msgs, { maxTokens: 512, temperature: 0.8, tdb });
  const user = addHistory(tdb, personaId, 'user', text);
  const assistant = addHistory(tdb, personaId, 'assistant', out.content || '');
  return { reply: out.content || '', user, assistant, model: out.model, usage: out.usage };
}

// ---------- Vivix 连通性测试：GET /v1/models（轻量、不建会话不烧额度） ----------
async function testKey(p) {
  if (!p.api_key) return { ok: false, error: '尚未填写 API Key' };
  const base = String(p.api_base || '').replace(/\/+$/, '');
  const t0 = Date.now();
  try {
    const res = await fetch(base + '/v1/models', {
      headers: { Authorization: `Bearer ${p.api_key}` },
      signal: AbortSignal.timeout(15000),
    });
    const latency = Date.now() - t0;
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Vivix 错误信封 {code,message}：10001=key 缺失、10003=key 无效、10008=限流
      const msg = (body && (body.message || body.error)) || `HTTP ${res.status}`;
      return { ok: false, latency_ms: latency, error: String(msg) };
    }
    const data = body && body.data;
    const arr = Array.isArray(data) ? data : (data && Array.isArray(data.models) ? data.models : []);
    const models = arr.map((m) => String(m.name || m.id || '')).filter(Boolean);
    const target = String(p.model || '').split(':')[0];
    const modelOk = models.some((m) => m === p.model || m.startsWith(target + ':'));
    return { ok: true, latency_ms: latency, models, model_ok: modelOk };
  } catch (e) {
    return { ok: false, latency_ms: Date.now() - t0, error: e.name === 'TimeoutError' ? '超时（15 秒无响应）' : e.message };
  }
}

module.exports = {
  VOICES, TYPES, PERSONA_DEFAULTS, ASPECTS, RESOLUTIONS,
  sanitizePersona, parsePersona, buildInstructions, buildVmps, buildSessionJson,
  publicPersona, listPersonas, storeImage, nextSort, ensureDefault, seedIfNeeded,
  addHistory, recentHistory, chat, testKey,
};
