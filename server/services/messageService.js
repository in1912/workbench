// 短消息服务（跨租户：messages 表在主库，成员互发 + 各模块推送，永久留存）
// module 取值：message=站内消息 / family=家庭事项 / kids=子女学习 / event=日程共享 / dingtalk=钉钉机器人收到
const dingtalk = require('./dingtalkService');
const MODULE_LABELS = { message: '站内消息', family: '家庭事项', kids: '子女学习', event: '日程提醒', dingtalk: '钉钉', ssl: 'SSL 证书', monitor: '电脑监控', email: '邮箱' };

// 是否机器人虚拟成员（钉钉）
function isBot(d, id) {
  return !!d.prepare('SELECT id FROM users WHERE id=? AND is_bot=1').get(Number(id));
}

// ---------- 富文本（家庭事项/学习任务粘贴图片的内容）→ 钉钉推送用的纯文本/图片 id ----------
const IMG_RE = /<img\b[^>]*src="\/api\/family-images\/(\d+)"[^>]*>/gi;
// 钉钉文本消息不认 HTML：<img> 变 [图片N] 占位，其余标签剥掉、常见转义还原
function richToPlain(s) {
  let i = 0;
  return String(s || '')
    .replace(IMG_RE, () => `[图片${++i}]`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
// 内容里引用的本站图片 id（去重、按出现顺序）
function richImageIds(s) {
  const out = [];
  for (const m of String(s || '').matchAll(IMG_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

// 发一条消息（允许发给自己：to_user === from_user 为"写给自己的备忘"，同样入库留存）。
// 接收人在自己租户配置里绑定并启用钉钉时，异步同步转发一份（失败仅记日志，不影响站内消息）。
// 内容含图片时：文字先行（[图片N] 占位），随后逐图经媒体上传单独推送
// v1.9.24 语音条：is_voice=1 时 content 空、语音文件按消息 id 存 data/messages-voice/<id>.wav（由路由写入）
function send(d, { from_user, to_user, subject = '', content = '', module = 'message', ref_id = null, ext_id = '', is_voice = 0, voice_secs = 0 }) {
  if (!to_user) return null;
  const sText = String(subject || '');
  const cText = String(content || '');
  const r = d.prepare('INSERT INTO messages(from_user,to_user,subject,content,module,ref_id,ext_id,is_voice,voice_secs) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(Number(from_user), Number(to_user), sText, cText, module, ref_id, String(ext_id || ''), is_voice ? 1 : 0, Math.max(0, Number(voice_secs) || 0));
  const botFrom = isBot(d, from_user);
  const botTo = isBot(d, to_user);
  // 语音条在钉钉侧的替身文案（语音本体与转写文字在工作台消息页看）
  const pushText = is_voice ? `[语音消息 ${Math.max(1, Math.round(Number(voice_secs) || 0))} 秒]（到工作台「短消息」页播放/看转写文字）` : cText;
  setImmediate(async () => {
    // 发给钉钉机器人 = 在消息页回复机器人会话：走机器人通道发回钉钉（惰性 require 防循环依赖）。
    // 发不出去时回执一条站内提示进会话——此前静默失败，用户以为发出去了（v1.2.9 修）
    if (botTo) {
      const stream = require('./dingtalkStreamService');
      stream.robotReply(from_user, pushText)
        .then((ok) => {
          if (ok !== false || !stream.botId()) return;
          send(d, {
            from_user: stream.botId(), to_user: from_user, module: 'dingtalk',
            content: '[未送达钉钉：你还没有绑定钉钉（设置 → 钉钉推送）。绑定后在钉钉里给机器人发一条消息，即可在工作台回复]',
          });
        })
        .catch((e) => {
          console.warn('[dingtalk] 机器人回复发送失败:', e.message);
          if (!stream.botId()) return;
          send(d, {
            from_user: stream.botId(), to_user: from_user, module: 'dingtalk',
            content: '[钉钉发送失败：' + String(e && e.message || e).slice(0, 300) + ']',
          });
        });
      return;
    }
    // 机器人发来的消息不再回推钉钉（本人就在钉钉里，回推等于重复提醒）
    if (botFrom) return;
    const label = MODULE_LABELS[module] || '站内消息';
    const who = Number(from_user) === Number(to_user) ? '自己的备忘' : userName(d, Number(from_user)) + ' 发来消息';
    const text = richToPlain(`【个人工作台·${label}】${who}` + (sText ? `\n主题：${sText}` : '') + `\n${pushText}`);
    try {
      const ok = await dingtalk.notifyUser(d, to_user, text);
      // 文字推送成功且内容带图：逐图上传媒体后以 sampleImage 补推（图片顺序即 [图片N] 顺序）
      if (ok) {
        for (const id of richImageIds(sText + '\n' + cText)) {
          try { await dingtalk.notifyUserImage(d, to_user, Number(id)); }
          catch (e) { console.warn(`[dingtalk] 图片(${id})推送给用户${to_user}失败:`, e.message); }
        }
      }
    } catch (e) {
      console.warn(`[dingtalk] 推送给用户${to_user}失败:`, e.message);
    }
  });
  return Number(r.lastInsertRowid);
}

// 用户显示名：中文姓名优先，空则回退用户名（消息署名/钉钉推送文本统一用它）
function userName(d, id) {
  const u = d.prepare('SELECT username, display_name FROM users WHERE id=?').get(Number(id));
  if (!u) return `用户${id}`;
  return (u.display_name || '').trim() || u.username;
}

// 用户列表（全部系统用户，含自己与机器人虚拟成员，is_self/is_bot 标记）+ 每人发来的未读数（选择器/消息页共用）
function listContacts(d, meId) {
  const users = d.prepare('SELECT id, username, display_name, nickname, role, is_bot FROM users ORDER BY id').all();
  const counts = {};
  for (const r of d.prepare('SELECT from_user, COUNT(*) c FROM messages WHERE to_user=? AND read_at IS NULL GROUP BY from_user').all(Number(meId))) {
    counts[r.from_user] = r.c;
  }
  return users.map((u) => ({ id: u.id, username: u.username, display_name: (u.display_name || '').trim(), nickname: (u.nickname || '').trim(), role: u.role, is_bot: !!u.is_bot, is_self: u.id === Number(meId), unread: counts[u.id] || 0 }));
}

// 与某成员的双向沟通记录（按时间正序，动态加载）：默认只取最近 1 天，传 before_id 向上翻页加载更早历史。
// 返回 { rows, hasMore }；取回即把对方发来的未读标已读。
// 注意：写给自己的备忘（from_user=to_user=me）不随查看自动已读——必须点弹窗「已读」/「全部已读」，
// 否则刚发给自己弹窗就被自己查看会话消掉，用户永远看不到提醒
function conversation(d, meId, otherId, opts = {}) {
  const me = Number(meId), other = Number(otherId);
  const PAIR = '(from_user=? AND to_user=?) OR (from_user=? AND to_user=?)';
  const pairArgs = [me, other, other, me];
  const beforeId = Number(opts.before_id) || 0;
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 50));
  let rows;
  if (beforeId > 0) {
    // 向上翻页：取该 id 之前最近的 limit 条，再反转回时间正序
    rows = d.prepare(`SELECT * FROM messages WHERE (${PAIR}) AND id < ? ORDER BY id DESC LIMIT ?`)
      .all(...pairArgs, beforeId, limit).reverse();
  } else {
    // 默认只加载最近 1 天；一天内一条都没有时回落最近 limit 条（新对话也能看到历史）
    rows = d.prepare(`SELECT * FROM messages WHERE (${PAIR}) AND created_at >= datetime('now','localtime','-1 day') ORDER BY id`)
      .all(...pairArgs);
    if (!rows.length) {
      rows = d.prepare(`SELECT * FROM messages WHERE (${PAIR}) ORDER BY id DESC LIMIT ?`)
        .all(...pairArgs, limit).reverse();
    }
  }
  d.prepare("UPDATE messages SET read_at=datetime('now','localtime') WHERE from_user=? AND to_user=? AND read_at IS NULL AND from_user<>to_user")
    .run(other, me);
  // 还有更早的历史可翻？
  const minId = rows.length ? rows[0].id : 0;
  const hasMore = minId > 0 && !!d.prepare(`SELECT id FROM messages WHERE (${PAIR}) AND id < ? LIMIT 1`)
    .get(...pairArgs, minId);
  const names = {};
  for (const r of rows) {
    if (!(r.from_user in names)) names[r.from_user] = userName(d, r.from_user);
    if (!(r.to_user in names)) names[r.to_user] = userName(d, r.to_user);
  }
  return {
    rows: rows.map((r) => ({
      ...r,
      from_name: names[r.from_user] || '',
      to_name: names[r.to_user] || '',
      mine: r.from_user === me,
      module_label: MODULE_LABELS[r.module] || r.module,
    })),
    hasMore,
  };
}

// 我的未读（登录弹窗提醒 + 轮询用；署名中文姓名优先）
function unread(d, meId, limit = 20) {
  return d.prepare(
    `SELECT m.*, u.username AS from_name, u.display_name AS from_display FROM messages m LEFT JOIN users u ON u.id=m.from_user
     WHERE m.to_user=? AND m.read_at IS NULL ORDER BY m.id DESC LIMIT ?`
  ).all(Number(meId), limit).map((r) => ({
    ...r,
    from_name: (r.from_display || '').trim() || r.from_name || `用户${r.from_user}`,
    module_label: MODULE_LABELS[r.module] || r.module,
  }));
}

function markRead(d, meId, id) {
  d.prepare("UPDATE messages SET read_at=datetime('now','localtime') WHERE id=? AND to_user=? AND read_at IS NULL")
    .run(Number(id), Number(meId));
}

function markAllRead(d, meId) {
  d.prepare("UPDATE messages SET read_at=datetime('now','localtime') WHERE to_user=? AND read_at IS NULL").run(Number(meId));
}

// ---------- 语音条（v1.9.24）：文件定位 + 自动转文字（复用「录音转写」模块配置的引擎） ----------
// 语音文件按消息 id 命名存 data/messages-voice/<id>.wav（发送路由写入；消息永久留存故不需要清理）
function voiceFile(id) {
  const { dataDir } = require('../db');
  const path = require('path');
  return path.join(dataDir, 'messages-voice', `${Number(id)}.wav`);
}

const VOICE_SYSTEM = 'You are a helpful assistant that transcribes audio input into text output in JSON format.';

// 长转写 POST（node:http 直连）：与 vibeRoutes 同结论——本地引擎转写完才发响应头，
// undici fetch 的 5 分钟 headersTimeout 会掐断，http.request 无内建超时
function voicePostJson(url, body, timeoutMs) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('转写服务响应解析失败：' + e.message)); }
        } else reject(new Error(`转写服务返回 ${res.statusCode}：${buf.slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`转写服务超时（${Math.round(timeoutMs / 60000)} 分钟）`)));
    req.end(body);
  });
}

// 模型返回 content → 纯文本（剥 ```json 围栏、截最外层 []、容错取 utterance 的 Content 字段）
function voiceTextOf(content) {
  let t = String(content || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const i = t.indexOf('['), j = t.lastIndexOf(']');
  if (i >= 0 && j > i) t = t.slice(i, j + 1);
  try {
    const arr = JSON.parse(t);
    if (Array.isArray(arr)) {
      return arr.map((x) => String(x && (x.Content ?? x.text) || '').trim()).filter(Boolean).join('\n');
    }
  } catch { /* 非数组：整段当文本 */ }
  return t;
}

// 转写一条语音消息（成功/失败都会把 voice_state 落库，返回转写文字）。
// 引擎选择（v1.9.25 起）：Whisper large-v3-turbo 优先（用户指定——消息场景短音频，turbo 快且准），
// 装了就用、不看「录音转写」页的 server_engine；未装才回退配置的 VibeASR；都没有如实报错。
// custom 模式仍直连配置地址（用户显式选的外部算力）；client 拉取模式跑不了（任务队列绑定 vibe_records）。
// 耗时与所用模型随结果落 voice_ms/voice_model（气泡下方小字溯源）。
async function transcribeVoice(d, id) {
  const row = d.prepare('SELECT * FROM messages WHERE id=?').get(Number(id) || 0);
  if (!row || !row.is_voice) throw new Error('不是语音消息');
  if (row.voice_text) return row.voice_text;
  const fs = require('fs');
  const file = voiceFile(row.id);
  if (!fs.existsSync(file)) throw new Error('语音文件缺失');
  const t0 = Date.now(); // 含引擎预热（模型加载也是用户等的一部分）
  const { getSetting } = require('../db');
  const s = getSetting(d, 'vibe_settings', {}) || {};
  const mode = ['server', 'custom'].includes(s.engine_mode) ? s.engine_mode : (s.base_url ? 'custom' : 'server');
  if (mode === 'client') throw new Error('转写算力是「客户端拉取」模式，短消息语音无法自动转文字：请在「录音转写」页改用服务器引擎或自定义服务');
  let base, model;
  if (mode === 'custom') {
    base = String(s.base_url || '').replace(/\/+$/, '');
    if (!base) throw new Error('未配置转写服务地址（录音转写页 → 算力来源）');
    model = String(s.model || 'vibevoice');
  } else if (require('./whisperPaths').engineReady()) {
    const wp = require('./whisperPaths'), ws = require('./whisperService');
    await ws.ensureReady(['auto', 'zh', 'en', 'yue', 'ja', 'ko'].includes(s.whisper_lang) ? s.whisper_lang : 'auto');
    base = `http://127.0.0.1:${wp.PORT}`; model = 'whisper-large-v3-turbo';
  } else if (s.server_engine === 'vibeasr') {
    const vp = require('./vibeasrPaths'), vs = require('./vibeasrService');
    if (!vp.engineReady()) throw new Error('Whisper 未安装，配置的 VibeASR 服务器引擎也未安装（「录音转写」页可一键安装）');
    await vs.ensureReady();
    base = `http://127.0.0.1:${vp.PORT}`; model = 'vibevoice';
  } else {
    throw new Error('Whisper 服务器引擎未安装（「录音转写」页可一键安装）');
  }
  d.prepare("UPDATE messages SET voice_state='pending' WHERE id=?").run(row.id);
  try {
    const buf = fs.readFileSync(file);
    const dataUrl = `data:audio/wav;base64,${buf.toString('base64')}`;
    const dur = Math.max(0, Number(row.voice_secs) || 0);
    const prompt = `This is a ${dur.toFixed(2)} seconds audio, please transcribe it with these keys: Start time, End time, Speaker ID, Content`;
    const body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: VOICE_SYSTEM },
        { role: 'user', content: [{ type: 'audio_url', audio_url: { url: dataUrl } }, { type: 'text', text: prompt }] },
      ],
      max_tokens: 8192, temperature: 0, top_p: 1, stream: false,
    });
    const resp = await voicePostJson(base + '/v1/chat/completions', body, 5 * 60 * 1000);
    const text = voiceTextOf(resp.choices?.[0]?.message?.content ?? '').trim();
    if (!text) throw new Error('模型未返回转写内容');
    d.prepare("UPDATE messages SET voice_state='done', voice_text=?, voice_model=?, voice_ms=? WHERE id=?")
      .run(text.slice(0, 5000), model, Date.now() - t0, row.id);
    return text;
  } catch (e) {
    d.prepare("UPDATE messages SET voice_state='failed' WHERE id=?").run(row.id);
    throw e;
  }
}

module.exports = { send, userName, isBot, listContacts, conversation, unread, markRead, markAllRead, MODULE_LABELS, richToPlain, richImageIds, voiceFile, transcribeVoice };
