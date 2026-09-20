// 短消息服务（跨租户：messages 表在主库，成员互发 + 各模块推送，永久留存）
// module 取值：message=站内消息 / family=家庭事项 / kids=子女学习 / event=日程共享 / dingtalk=钉钉机器人收到
const dingtalk = require('./dingtalkService');
const MODULE_LABELS = { message: '站内消息', family: '家庭事项', kids: '子女学习', event: '日程提醒', dingtalk: '钉钉', ssl: 'SSL 证书', monitor: '电脑监控' };

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
function send(d, { from_user, to_user, subject = '', content = '', module = 'message', ref_id = null, ext_id = '' }) {
  if (!to_user) return null;
  const sText = String(subject || '');
  const cText = String(content || '');
  const r = d.prepare('INSERT INTO messages(from_user,to_user,subject,content,module,ref_id,ext_id) VALUES(?,?,?,?,?,?,?)')
    .run(Number(from_user), Number(to_user), sText, cText, module, ref_id, String(ext_id || ''));
  const botFrom = isBot(d, from_user);
  const botTo = isBot(d, to_user);
  setImmediate(async () => {
    // 发给钉钉机器人 = 在消息页回复机器人会话：走机器人通道发回钉钉（惰性 require 防循环依赖）。
    // 发不出去时回执一条站内提示进会话——此前静默失败，用户以为发出去了（v1.2.9 修）
    if (botTo) {
      const stream = require('./dingtalkStreamService');
      stream.robotReply(from_user, cText)
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
    const text = richToPlain(`【个人工作台·${label}】${who}` + (sText ? `\n主题：${sText}` : '') + `\n${cText}`);
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

module.exports = { send, userName, isBot, listContacts, conversation, unread, markRead, markAllRead, MODULE_LABELS, richToPlain, richImageIds };
