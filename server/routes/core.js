const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const { routedDb, db, getTenantDb, getSetting, setSetting } = require('../db');
const messageService = require('../services/messageService');
const storagePaths = require('../services/storagePaths');

// 给指定成员推送模块消息（家庭事项/子女学习登记时勾选；消息落主库永久留存）
function pushModuleMessages(req, module, subject, content, refId) {
  const ids = req.body && Array.isArray(req.body.notify_users) ? req.body.notify_users.map(Number).filter(Boolean) : [];
  for (const uid of ids) {
    try {
      messageService.send(db, { from_user: req.user.id, to_user: uid, subject, content, module, ref_id: refId });
    } catch (e) { console.warn(`[message] ${module} 推送给用户${uid}失败:`, e.message); }
  }
}

const router = express.Router();
router.use(express.json({ limit: '12mb' })); // 家庭图床走 base64 JSON 提交，放宽到 12mb（5MB 原图上限）

// ---------- 看板聚合 ----------
router.get('/overview', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const events = req.tdb.prepare(
    `SELECT * FROM events WHERE date(start_time)<=? AND (end_date IS NULL OR end_date>=?)
     ORDER BY start_time LIMIT 8`
  ).all(today, today);
  const todos = req.tdb.prepare(
    "SELECT * FROM todos WHERE done=0 OR due_date=date('now','localtime') ORDER BY done, (due_date IS NULL), due_date DESC, priority LIMIT 8"
  ).all();
  const links = req.tdb.prepare('SELECT * FROM quick_links ORDER BY category, id LIMIT 12').all();
  const fdb = routedDb(req.tdb, 'family'); // 子女看板卡随家庭模块共享
  const kids = fdb.prepare('SELECT * FROM kids ORDER BY id').all();
  const pendingKids = fdb.prepare(
    "SELECT kt.*, k.name AS kid_name FROM kid_tasks kt LEFT JOIN kids k ON k.id=kt.kid_id WHERE kt.status='todo' ORDER BY (kt.due_date IS NULL), kt.due_date LIMIT 8"
  ).all();
  res.json({ today, events, todos, links, kids, pendingKids });
});

// ---------- 笔记 ----------
router.get('/notes', (req, res) => {
  const q = (req.query.q || '').trim();
  let rows;
  if (q) {
    const like = `%${q}%`;
    rows = req.tdb.prepare(
      'SELECT * FROM notes WHERE title LIKE ? OR content LIKE ? OR category LIKE ? ORDER BY updated_at DESC'
    ).all(like, like, like);
  } else {
    rows = req.tdb.prepare('SELECT * FROM notes ORDER BY updated_at DESC').all();
  }
  res.json(rows);
});
// 根据内容自动提取标题：优先取首句（截断 20 字），否则取开头
function extractTitle(content) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (!text) return '无标题笔记';
  const first = text.split(/[。！？!?\n；;]/)[0].trim();
  if (first) return first.slice(0, 20);
  return text.slice(0, 20);
}
router.post('/notes', (req, res) => {
  const { content, category } = req.body;
  const r = req.tdb.prepare(
    "INSERT INTO notes(title,content,category) VALUES(?,?,?)"
  ).run(extractTitle(content), content || '', category || 'general');
  res.json({ id: r.lastInsertRowid });
});
router.put('/notes/:id', (req, res) => {
  const { content, category } = req.body;
  req.tdb.prepare(
    "UPDATE notes SET title=?, content=?, category=?, updated_at=datetime('now','localtime') WHERE id=?"
  ).run(extractTitle(content), content ?? '', category ?? 'general', req.params.id);
  res.json({ ok: true });
});
router.delete('/notes/:id', (req, res) => {
  req.tdb.prepare('DELETE FROM notes WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- 待办 ----------
router.get('/todos', (req, res) => {
  res.json(req.tdb.prepare('SELECT * FROM todos ORDER BY done, (due_date IS NULL), due_date DESC, priority').all());
});
router.post('/todos', (req, res) => {
  const { title, desc, due_date, priority } = req.body;
  const r = req.tdb.prepare('INSERT INTO todos(title,desc,due_date,priority) VALUES(?,?,?,?)')
    .run(title, desc || '', due_date || null, priority || 2);
  res.json({ id: r.lastInsertRowid });
});
router.patch('/todos/:id', (req, res) => {
  const { done, title, desc, due_date, priority } = req.body;
  const cur = req.tdb.prepare('SELECT * FROM todos WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'not found' });
  req.tdb.prepare(
    'UPDATE todos SET title=?, desc=?, due_date=?, priority=?, done=? WHERE id=?'
  ).run(
    title ?? cur.title, desc ?? cur.desc, due_date !== undefined ? due_date : cur.due_date,
    priority ?? cur.priority, done !== undefined ? (done ? 1 : 0) : cur.done, req.params.id
  );
  res.json({ ok: true });
});
router.delete('/todos/:id', (req, res) => {
  req.tdb.prepare('DELETE FROM todos WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- 日程 ----------
// end_date：跨日日程的结束日期（YYYY-MM-DD）；同日日程为 NULL
// remind_push：开始前 15 分钟钉钉提醒（eventRemindService 巡检推送，默认开）；
// shared_to：共享给的成员 uid JSON 数组（对方只可查看，15 分钟提醒也同步推给他们）
// 共享成员 uid 归一化：去重、剔除自己与机器人、必须是真实用户
function normShareIds(raw, selfId) {
  const ids = Array.isArray(raw) ? raw.map(Number).filter((x) => Number.isInteger(x) && x > 0) : [];
  return [...new Set(ids)].filter((id) => id !== Number(selfId) && db.prepare('SELECT id FROM users WHERE id=? AND is_bot=0').get(id));
}
// 给共享成员发站内通知（其钉钉绑定启用时由 messageService 自动同步转发一份）
function notifyShared(fromUid, toUid, ev, refId) {
  const day = String(ev.start_time || '').slice(0, 10);
  const hm = String(ev.start_time || '').slice(11, 16);
  const lines = [
    `「${ev.title}」`,
    `时间：${hm ? `${day} ${hm}` : day}${ev.end_date && ev.end_date > day ? ` ~ ${ev.end_date}` : ''}`,
  ];
  if (ev.location) lines.push('地点：' + ev.location);
  lines.push('该日程已共享给你（仅查看，不可编辑修改），开始前 15 分钟将同步钉钉提醒。');
  try {
    messageService.send(db, { from_user: fromUid, to_user: toUid, subject: `共享日程：${ev.title}`, content: lines.join('\n'), module: 'event', ref_id: refId });
  } catch (e) { console.warn(`[event] 共享通知给用户${toUid}失败:`, e.message); }
}
// 他人共享给我的日程（只读）：扫其他真实用户的租户库（家庭规模用户量小，遍历足够）
function sharedEventsFor(meId) {
  const out = [];
  for (const u of db.prepare('SELECT id, username, display_name FROM users WHERE is_bot=0 AND id<>?').all(Number(meId))) {
    let odb;
    try { odb = getTenantDb(u.id); } catch { continue; }
    for (const ev of odb.prepare("SELECT * FROM events WHERE shared_to IS NOT NULL AND shared_to NOT IN ('', '[]')").all()) {
      let ids = null;
      try { ids = JSON.parse(ev.shared_to || '[]'); } catch { continue; }
      if (Array.isArray(ids) && ids.map(Number).includes(Number(meId))) {
        out.push({ ...ev, shared: 1, owner_name: (u.display_name || '').trim() || u.username });
      }
    }
  }
  return out;
}
router.get('/events', (req, res) => {
  const { from, to } = req.query;
  let rows;
  if (from && to) {
    // 区间取并集：开始或结束落在 [from, to] 内的跨日日程也要显示
    rows = req.tdb.prepare(
      `SELECT * FROM events
       WHERE date(start_time) BETWEEN ? AND ?
          OR (end_date IS NOT NULL AND end_date >= ? AND date(start_time) <= ?)
       ORDER BY start_time`
    ).all(from, to, from, to);
  } else {
    rows = req.tdb.prepare('SELECT * FROM events ORDER BY start_time').all();
  }
  // 合并他人共享给我的日程（shared=1 标记，前端按只读展示）
  const shared = sharedEventsFor(req.user.id);
  if (shared.length) {
    const inRange = (ev) => {
      const s = String(ev.start_time || '').slice(0, 10);
      if (!s) return false;
      if (s >= from && s <= to) return true;
      return !!(ev.end_date && ev.end_date >= from && s <= to);
    };
    rows = [...rows, ...(from && to ? shared.filter(inRange) : shared)]
      .sort((a, b) => String(a.start_time || '').localeCompare(String(b.start_time || '')));
  }
  res.json(rows);
});
router.post('/events', (req, res) => {
  const { title, desc, start_time, end_time, end_date, location } = req.body;
  const startDate = start_time ? String(start_time).slice(0, 10) : null;
  const realEnd = end_date && startDate && end_date > startDate ? end_date : null;
  const shared = normShareIds(req.body.shared_to, req.user.id);
  const r = req.tdb.prepare('INSERT INTO events(title,desc,start_time,end_time,end_date,location,remind_push,shared_to) VALUES(?,?,?,?,?,?,?,?)')
    .run(title, desc || '', start_time || null, end_time || null, realEnd, location || '',
      req.body.remind_push === false ? 0 : 1, JSON.stringify(shared));
  const id = Number(r.lastInsertRowid);
  for (const uid of shared) notifyShared(req.user.id, uid, { title, desc, start_time, end_time, end_date: realEnd, location }, id);
  res.json({ id });
});
router.put('/events/:id', (req, res) => {
  const { title, desc, start_time, end_time, end_date, location } = req.body;
  const cur = req.tdb.prepare('SELECT * FROM events WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: '日程不存在' });
  const newStart = start_time !== undefined ? (start_time || null) : cur.start_time;
  const newEnd = end_date !== undefined ? end_date : cur.end_date;
  const startDate = newStart ? String(newStart).slice(0, 10) : null;
  const realEnd = newEnd && startDate && newEnd > startDate ? newEnd : null;
  const newPush = req.body.remind_push === undefined ? cur.remind_push : (req.body.remind_push ? 1 : 0);
  const curShared = (() => { try { return JSON.parse(cur.shared_to || '[]'); } catch { return []; } })();
  const newShared = req.body.shared_to === undefined ? curShared : normShareIds(req.body.shared_to, req.user.id);
  // 开始时间变动 / 重新打开提醒 → 清掉已发标记，15 分钟提醒按新时间重排
  const resetRemind = (String(newStart || '') !== String(cur.start_time || '')) || (newPush && !cur.remind_push);
  req.tdb.prepare(`UPDATE events SET title=?, desc=?, start_time=?, end_time=?, end_date=?, location=?, remind_push=?, shared_to=?,
    remind_sent_at = ${resetRemind ? 'NULL' : 'remind_sent_at'} WHERE id=?`)
    .run(
      title != null ? title : cur.title,
      desc != null ? desc : cur.desc,
      newStart,
      end_time !== undefined ? (end_time || null) : cur.end_time,
      realEnd,
      location != null ? location : cur.location,
      newPush,
      JSON.stringify(newShared),
      req.params.id
    );
  // 新增的共享成员补发通知（原本就共享的不重复打扰）
  const ev = req.tdb.prepare('SELECT * FROM events WHERE id=?').get(req.params.id);
  for (const uid of newShared) {
    if (!curShared.map(Number).includes(Number(uid))) notifyShared(req.user.id, uid, ev, Number(req.params.id));
  }
  res.json({ ok: true });
});
router.delete('/events/:id', (req, res) => {
  req.tdb.prepare('DELETE FROM events WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- 家庭事项（family 共享开关：开=主库全员共用，关=各租户独立） ----------
// 富文本清洗：粘贴图片后的内容只允许 文本 / <br> / 本站图床的 <img>，其余标签一律剥掉（防注入）
function sanitizeRich(s) {
  return String(s || '')
    .replace(/<img\b[^>]*src="\/api\/family-images\/(\d+)"[^>]*\/?>/gi, (m, id) => `<img src="/api/family-images/${id}">`)
    .replace(/⏳图片上传中…/g, '') // 前端"上传中"占位兜底（正常到不了这里：序列化剥除+按钮禁用双保险）
    .replace(/<(?!\/?(?:img|br)\b)[^>]*>/gi, ''); // img/br 以外的开合标签全部移除（img 已被上一行规范化为无属性形态）
}
router.get('/family', (req, res) => {
  // 勾选不改变位置（用户要求：只打勾，文字图片原样保留），按日期倒序恒定
  res.json(routedDb(req.tdb, 'family').prepare("SELECT * FROM family_items ORDER BY item_date DESC, id DESC").all());
});
router.post('/family', (req, res) => {
  const { desc, item_date, status } = req.body;
  const title = sanitizeRich(req.body.title);
  const richDesc = sanitizeRich(desc) || '';
  // 清洗后为空（纯"上传中"占位或空内容）直接拒绝，防脏空行入库
  if (!/<(img|br)\b/i.test(title) && !title.trim() && !richDesc.trim()) {
    return res.status(400).json({ error: '内容不能为空（图片若还在上传中，请稍候再点登记）' });
  }
  const r = routedDb(req.tdb, 'family').prepare(`INSERT INTO family_items(title,desc,item_date,status,created_by,created_by_name)
    VALUES(?,?,?,?,?,?)`)
    .run(title, richDesc, item_date || null, status || 'todo',
      req.user.id, req.user.display_name || req.user.nickname || req.user.username || '');
  const newId = Number(r.lastInsertRowid);
  // 勾选了推送：给指定成员发消息（来源=家庭事项）
  const text = `${title}${richDesc ? `\n${richDesc}` : ''}${item_date ? `\n日期：${item_date}` : ''}`;
  pushModuleMessages(req, 'family', `家庭事项：${title}`, text, newId);
  res.json({ id: newId });
});
router.patch('/family/:id', (req, res) => {
  // 只更新请求里出现的字段：勾选只传 status，绝不能把没传的 title/desc 刷成空
  // （旧实现 title??'' 把勾选变成"清空内容"，用户点个勾文字和图片就没了）
  const b = req.body || {};
  const sets = [];
  const args = [];
  if ('status' in b) {
    // 勾选完成时留痕：谁勾的、什么时候勾的（通知列表显示勾选人中文姓名与勾选时间）；取消勾选则清痕
    if (b.status === 'done') {
      sets.push(`status='done'`, 'done_by=?', 'done_by_name=?', "done_at=datetime('now','localtime')");
      args.push(req.user.id, req.user.display_name || req.user.nickname || req.user.username || '');
    } else {
      sets.push('status=?', 'done_by=NULL', 'done_by_name=NULL', 'done_at=NULL');
      args.push(b.status || 'todo');
    }
  }
  if ('title' in b) { sets.push('title=?'); args.push(sanitizeRich(b.title)); }
  if ('desc' in b) { sets.push('desc=?'); args.push(sanitizeRich(b.desc)); }
  if ('item_date' in b) { sets.push('item_date=?'); args.push(b.item_date || null); }
  if (sets.length) routedDb(req.tdb, 'family').prepare(`UPDATE family_items SET ${sets.join(',')} WHERE id=?`).run(...args, req.params.id);
  res.json({ ok: true });
});
router.delete('/family/:id', (req, res) => {
  routedDb(req.tdb, 'family').prepare('DELETE FROM family_items WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- 家庭图床（录入框粘贴/上传的图片，随 family 共享开关路由；<img> 标签请求经 ?token= 鉴权） ----------
const IMG_MAX_B64 = 7 * 1024 * 1024; // base64 长度上限 ≈ 原图 5MB
const IMG_MIME_OK = /^image\/(png|jpe?g|gif|webp|bmp)$/;
router.post('/family-images', (req, res) => {
  const { data, mime } = req.body || {};
  let b64 = String(data || '');
  const m = /^data:([^;]+);base64,(.+)$/s.exec(b64);
  const realMime = m ? m[1].toLowerCase() : String(mime || 'image/png').toLowerCase();
  if (m) b64 = m[2];
  if (!b64) return res.status(400).json({ error: '缺少图片数据' });
  if (!IMG_MIME_OK.test(realMime)) return res.status(400).json({ error: '仅支持 png/jpg/gif/webp/bmp 图片' });
  if (b64.length > IMG_MAX_B64) return res.status(400).json({ error: '图片过大（超过约 5MB），请压缩后再贴' });
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return res.status(400).json({ error: '图片数据无效' });
  // 全局默认上传路径已配置 → 图片落盘 {root}/family-images、库里不再存 base64（省数据库体积）；
  // 未配置维持旧行为。落盘失败静默回退存库
  const IMG_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp' };
  const storagePath = storagePaths.bestEffortSave('family-images', `paste.${IMG_EXT[realMime] || 'png'}`, buf, `t${req.user.id}_`);
  const r = routedDb(req.tdb, 'family').prepare('INSERT INTO family_images(mime,size,data,storage_path) VALUES(?,?,?,?)')
    .run(realMime, buf.length, storagePath ? '' : b64, storagePath);
  const id = Number(r.lastInsertRowid);
  res.json({ id, url: `/api/family-images/${id}` });
});
router.get('/family-images/:id', (req, res) => {
  const row = routedDb(req.tdb, 'family').prepare('SELECT mime, data, storage_path FROM family_images WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.setHeader('Content-Type', row.mime || 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=86400'); // 图片不可变，缓存一天
  if (row.storage_path && fs.existsSync(row.storage_path)) return fs.createReadStream(row.storage_path).pipe(res); // 新数据走磁盘
  res.send(Buffer.from(row.data, 'base64')); // 老数据 / 落盘文件丢失回退
});

// ---------- 机器人消息图片（主库 message_images：钉钉机器人收到的图片转存；<img> 经 ?token= 鉴权取图） ----------
router.get('/message-images/:id', (req, res) => {
  const row = db.prepare('SELECT mime, data, storage_path FROM message_images WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.setHeader('Content-Type', row.mime || 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  if (row.storage_path && fs.existsSync(row.storage_path)) return fs.createReadStream(row.storage_path).pipe(res);
  res.send(Buffer.from(row.data, 'base64'));
});

// ---------- 子女（随 family 共享开关） ----------
router.get('/kids', (req, res) => {
  const fdb = routedDb(req.tdb, 'family');
  const kids = fdb.prepare('SELECT * FROM kids ORDER BY id').all();
  const tasks = fdb.prepare("SELECT * FROM kid_tasks ORDER BY (due_date IS NULL), due_date DESC, id DESC").all(); // 勾选不沉底，位置恒定
  res.json({ kids, tasks });
});
router.post('/kids', (req, res) => {
  const r = routedDb(req.tdb, 'family').prepare('INSERT INTO kids(name,grade) VALUES(?,?)').run(req.body.name, req.body.grade || '');
  res.json({ id: r.lastInsertRowid });
});
router.delete('/kids/:id', (req, res) => {
  routedDb(req.tdb, 'family').prepare('DELETE FROM kids WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
router.post('/kid-tasks', (req, res) => {
  const { kid_id, subject, due_date } = req.body;
  const content = sanitizeRich(req.body.content);
  // 清洗后为空（纯"上传中"占位或空内容）直接拒绝，防脏空行入库
  if (!/<(img|br)\b/i.test(content) && !content.trim() && !(subject || '').trim()) {
    return res.status(400).json({ error: '任务内容不能为空（图片若还在上传中，请稍候再下发）' });
  }
  const fdb = routedDb(req.tdb, 'family');
  const r = fdb.prepare('INSERT INTO kid_tasks(kid_id,subject,content,due_date) VALUES(?,?,?,?)')
    .run(kid_id || null, subject || '', content, due_date || null);
  const newId = Number(r.lastInsertRowid);
  // 勾选了推送：给指定成员发消息（来源=子女学习）
  const kidName = kid_id ? (fdb.prepare('SELECT name FROM kids WHERE id=?').get(kid_id)?.name || '') : '';
  const title = `学习任务${kidName ? `·${kidName}` : ''}${subject ? `（${subject}）` : ''}`;
  const text = `${content}${due_date ? `\n截止：${due_date}` : ''}`;
  pushModuleMessages(req, 'kids', title, text, newId);
  res.json({ id: newId });
});
router.patch('/kid-tasks/:id', (req, res) => {
  // 只更新出现的字段：勾选只传 status 时绝不能清空 content（旧实现 content??'' 会把任务文字/图片抹掉）
  const b = req.body || {};
  const fdb = routedDb(req.tdb, 'family');
  if (b.status !== undefined) {
    const done = b.status === 'done' ? `datetime('now','localtime')` : 'NULL';
    const contentSet = b.content !== undefined ? ', content=?' : '';
    const contentArg = b.content !== undefined ? [sanitizeRich(b.content)] : [];
    fdb.prepare(`UPDATE kid_tasks SET status=?, done_at=${done}${contentSet} WHERE id=?`)
      .run(b.status || 'todo', ...contentArg, req.params.id);
  } else if (b.content !== undefined) {
    fdb.prepare('UPDATE kid_tasks SET content=? WHERE id=?').run(sanitizeRich(b.content), req.params.id);
  }
  res.json({ ok: true });
});
router.delete('/kid-tasks/:id', (req, res) => {
  routedDb(req.tdb, 'family').prepare('DELETE FROM kid_tasks WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- 学习成长 ----------
router.get('/learning', (req, res) => {
  const plans = req.tdb.prepare("SELECT * FROM learning_plans ORDER BY (status='active') DESC, id DESC").all();
  const records = req.tdb.prepare(
    'SELECT r.*, p.skill FROM learning_records r LEFT JOIN learning_plans p ON p.id=r.plan_id ORDER BY r.record_date DESC, r.id DESC LIMIT 200'
  ).all();
  res.json({ plans, records });
});
router.post('/learning/plans', (req, res) => {
  const { skill, goal, plan_date } = req.body;
  const r = req.tdb.prepare('INSERT INTO learning_plans(skill,goal,plan_date) VALUES(?,?,?)')
    .run(skill, goal || '', plan_date || null);
  res.json({ id: r.lastInsertRowid });
});
router.patch('/learning/plans/:id', (req, res) => {
  const { status } = req.body;
  req.tdb.prepare('UPDATE learning_plans SET status=? WHERE id=?').run(status || 'active', req.params.id);
  res.json({ ok: true });
});
router.delete('/learning/plans/:id', (req, res) => {
  req.tdb.prepare('DELETE FROM learning_plans WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
router.post('/learning/records', (req, res) => {
  const { plan_id, content, gains, problems, next_steps, record_date } = req.body;
  const r = req.tdb.prepare(
    'INSERT INTO learning_records(plan_id,content,gains,problems,next_steps,record_date) VALUES(?,?,?,?,?,?)'
  ).run(plan_id || null, content, gains || '', problems || '', next_steps || '', record_date || new Date().toISOString().slice(0, 10));
  res.json({ id: r.lastInsertRowid });
});
router.delete('/learning/records/:id', (req, res) => {
  req.tdb.prepare('DELETE FROM learning_records WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- 复盘 ----------
router.get('/reviews', (req, res) => {
  res.json(req.tdb.prepare('SELECT * FROM reviews ORDER BY id DESC LIMIT 100').all());
});
router.post('/reviews', (req, res) => {
  const { period, content } = req.body;
  const r = req.tdb.prepare('INSERT INTO reviews(period,content) VALUES(?,?)').run(period || '', content);
  res.json({ id: r.lastInsertRowid });
});
router.delete('/reviews/:id', (req, res) => {
  req.tdb.prepare('DELETE FROM reviews WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- 剪贴板（手动录入 + Windows 采集代理，v1.6.2） ----------
router.get('/clipboard', (req, res) => {
  res.json(req.tdb.prepare('SELECT * FROM clipboard_items ORDER BY id DESC LIMIT 200').all());
});
router.post('/clipboard', (req, res) => {
  const { content, source } = req.body;
  if (!content || !content.trim()) return res.json({ ok: true });
  const r = req.tdb.prepare('INSERT INTO clipboard_items(content,source,device) VALUES(?,?,?)')
    .run(content.trim().slice(0, 10000), source === 'manual' ? 'manual' : String(source || 'manual').slice(0, 30), '');
  res.json({ id: r.lastInsertRowid });
});
router.delete('/clipboard/:id', (req, res) => {
  req.tdb.prepare('DELETE FROM clipboard_items WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- 剪贴板采集代理（v1.6.2）：Windows 电脑端脚本，一键下载/安装/卸载 ----------
// 同录音转写客户端包模式：脚本按「下载来源」内嵌服务器地址（IP 访问嵌 IP、域名访问嵌域名），
// key=登记密钥 + uid=下载管理员的用户 id 双凭证；采集数据落该管理员的租户库。
function clipKey() {
  let k = getSetting('clip_client_key', '');
  if (!k) { k = crypto.randomBytes(16).toString('hex'); setSetting('clip_client_key', k); }
  return k;
}
function clipBaseUrl(req) {
  const clean = (u) => String(u || '').replace(/\/+$/, '');
  const org = clean(req.get('origin'));
  if (/^https?:\/\//i.test(org)) return org;
  const ref = clean(String(req.get('referer') || '').replace(/^(https?:\/\/[^/?#]+).*$/i, '$1'));
  if (/^https?:\/\//i.test(ref)) return ref;
  const xfp = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  return `${xfp || req.protocol}://${req.get('host')}`;
}

// PS 5.1 注意（沿用 vibeasr-setup.ps1 踩坑结论）：中文须 UTF-8 BOM（下载时服务端补）；
// TLS 信任回调用编译型 C#（脚本块形式在 TLS 线程崩）；剪贴板 API 需 STA（安装命令带 -STA）；
// $Host/$args 是自动变量不可赋值；函数名不能叫 Curl（Invoke-RestMethod 的别名 curl 会遮蔽）。
const CLIP_PS = [
  '# 个人工作台·剪贴板采集脚本（由「效率工具→剪贴板」页生成，按下载来源内嵌服务器地址）',
  '# 用法：与 install-clipboard.bat 放同一文件夹，双击 install-clipboard.bat 安装（无需管理员）。',
  '# 安装位置：%LOCALAPPDATA%\\WorkbenchClipboard；当前用户开机自启。卸载：双击 uninstall-clipboard.bat，',
  '#   或 powershell -ExecutionPolicy Bypass -File 本文件 -Remove',
  'param([switch]$Remove)',
  "$Server = '__SERVER__'",
  "$Key    = '__KEY__'",
  "$Uid    = __UID__",
  "$RunName = 'WorkbenchClipboard'",
  "$Dir = Join-Path $env:LOCALAPPDATA 'WorkbenchClipboard'",
  "$LogFile = Join-Path $Dir 'agent.log'",
  "function Log([string]$m) { try { Add-Content -Path $LogFile -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $m) -ErrorAction SilentlyContinue } catch {} }",
  '',
  'if ($Remove) {',
  "  Log 'uninstall'",
  "  Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name $RunName -ErrorAction SilentlyContinue",
  "  Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like ('*' + $Dir + '*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  "  Remove-Item $Dir -Recurse -Force -ErrorAction SilentlyContinue",
  "  Write-Host '已卸载剪贴板采集'",
  '  exit',
  '}',
  '',
  '# --- 安装分支：不从安装目录运行时，先落位再转常驻 ---',
  'if ($PSCommandPath -and (-not $PSCommandPath.StartsWith($Dir))) {',
  '  New-Item -ItemType Directory -Force -Path $Dir | Out-Null',
  "  Log ('installing from ' + $PSCommandPath)",
  "  Copy-Item $PSCommandPath (Join-Path $Dir 'watcher.ps1') -Force",
  "  $cmd = 'powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"' + (Join-Path $Dir 'watcher.ps1') + '\"'",
  "  New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name $RunName -Value $cmd -PropertyType String -Force | Out-Null",
  "  Write-Host ('安装完成（' + $Dir + '），已开始后台采集并设为开机自启')",
  "  Start-Process -FilePath 'powershell.exe' -ArgumentList ('-STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"' + (Join-Path $Dir 'watcher.ps1') + '\"')",
  '  exit',
  '}',
  '',
  '# --- 常驻分支：监听剪贴板 → 变化即推送；每 9 分钟刷新登记（页面显示在线状态） ---',
  'Add-Type -AssemblyName System.Windows.Forms',
  '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
  '# 工作台可能是内网自签名 HTTPS（按下载来源内嵌）：编译型 C# 回调放行证书（脚本块形式会在 TLS 线程炸）',
  "if (-not ('ClipTlsTrust' -as [type])) {",
  "  Add-Type -TypeDefinition 'using System.Net; using System.Security.Cryptography.X509Certificates; public class ClipTlsTrust : ICertificatePolicy { public bool CheckValidationResult(ServicePoint sp, X509Certificate cert, WebRequest req, int problem) { return true; } }'",
  '}',
  '[System.Net.ServicePointManager]::CertificatePolicy = New-Object ClipTlsTrust',
  '# 本机代理会掐断内网请求，强制直连',
  '[System.Net.WebRequest]::DefaultWebProxy = $null',
  '# 单实例互斥',
  "$mtx = New-Object System.Threading.Mutex($false, 'Global\\WorkbenchClipboard')",
  'if (-not $mtx.WaitOne(0)) { exit }',
  '',
  '$Machine = $env:COMPUTERNAME',
  '$regBody = @{ key = $Key; uid = [int]$Uid; host = $Machine } | ConvertTo-Json',
  'function Register-Clip {',
  "  try { Invoke-RestMethod -Method Post -Uri ($Server + '/api/clipboard/agent-register') -ContentType 'application/json; charset=utf-8' -Body $regBody | Out-Null } catch {}",
  '}',
  'Register-Clip',
  "Log ('watching clipboard -> ' + $Server)",
  '',
  "$last = ''",
  '$lastReg = Get-Date',
  'for (;;) {',
  '  Start-Sleep -Seconds 3',
  '  try {',
  '    $text = [System.Windows.Forms.Clipboard]::GetText()',
  '    if ($text -and $text.Length -gt 1 -and $text -ne $last) {',
  '      $last = $text',
  '      if ($text.Length -gt 20000) { $text = $text.Substring(0, 20000) }',
  '      $body = @{ key = $Key; uid = [int]$Uid; host = $Machine; content = $text } | ConvertTo-Json',
  '      try {',
  "        Invoke-RestMethod -Method Post -Uri ($Server + '/api/clipboard/agent-push') -ContentType 'application/json; charset=utf-8' -Body $body | Out-Null",
  "      } catch { Log ('push failed: ' + $_.Exception.Message) }",
  '    }',
  '  } catch { # 剪贴板被其他程序占用时忽略',
  '  }',
  '  if (((Get-Date) - $lastReg).TotalMinutes -ge 9) { $lastReg = Get-Date; Register-Clip }',
  '}',
].join('\n');

// bat 全 ASCII（cmd 内嵌中文经传参必乱码）
const CLIP_INSTALL_BAT = [
  '@echo off',
  'cd /d "%~dp0"',
  'powershell -STA -NoProfile -ExecutionPolicy Bypass -File "%~dp0clipboard-setup.ps1"',
  'pause',
].join('\r\n');

// 卸载自包含：不依赖当初的 ps1 还在；$PID 排除自身（卸载命令行里含目录名会自匹配）
const CLIP_UNINSTALL_BAT = [
  '@echo off',
  'powershell -NoProfile -ExecutionPolicy Bypass -Command "& { $dir = Join-Path $env:LOCALAPPDATA \'WorkbenchClipboard\'; Remove-ItemProperty -Path \'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\' -Name \'WorkbenchClipboard\' -ErrorAction SilentlyContinue; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like (\'*\' + $dir + \'*\') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep 1; Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue; if (Test-Path $dir) { Write-Host \'Some files are locked, please reboot and run again\' } else { Write-Host \'Workbench clipboard watcher uninstalled\' } }"',
  'pause',
].join('\r\n');

// 三件套下发（仅管理员；ps1 内嵌下载来源地址 + 密钥 + 下载者 uid）
router.get('/clipboard/agent', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可下载采集脚本' });
  const t = String(req.query.type || '');
  if (t === 'setup') {
    const ps = CLIP_PS.replace(/__SERVER__/g, clipBaseUrl(req)).replace(/__KEY__/g, clipKey()).replace(/__UID__/g, String(req.user.id));
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="clipboard-setup.ps1"');
    return res.end('﻿' + ps); // UTF-8 BOM：PS 5.1 无 BOM 按 ANSI 解析中文
  }
  if (t === 'install') {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="install-clipboard.bat"');
    return res.end(CLIP_INSTALL_BAT);
  }
  if (t === 'uninstall') {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="uninstall-clipboard.bat"');
    return res.end(CLIP_UNINSTALL_BAT);
  }
  res.status(400).json({ error: '未知类型' });
});

// 代理登记/推送（EXEMPT 免登录；key + uid 双校验，数据落该管理员的租户库）
function clipAgentDb(b) {
  if (String(b.key || '') !== clipKey()) return null;
  const uid = Number(b.uid) || 0;
  const u = db.prepare('SELECT id, role FROM users WHERE id=?').get(uid);
  if (!u || u.role !== 'admin') return null;
  return getTenantDb(uid);
}
router.post('/clipboard/agent-register', (req, res) => {
  const tdb = clipAgentDb(req.body || {});
  if (!tdb) return res.status(403).json({ error: '密钥不对' });
  const host = String(req.body.host || '').trim().slice(0, 60) || '未知电脑';
  tdb.prepare(`INSERT INTO clipboard_devices(host, first_seen, last_seen) VALUES(?,?,?)
    ON CONFLICT(host) DO UPDATE SET last_seen=excluded.last_seen`).run(host, Date.now(), Date.now());
  res.json({ ok: true });
});
router.post('/clipboard/agent-push', (req, res) => {
  const tdb = clipAgentDb(req.body || {});
  if (!tdb) return res.status(403).json({ error: '密钥不对' });
  const host = String(req.body.host || '').trim().slice(0, 60) || '未知电脑';
  const content = String(req.body.content || '').trim().slice(0, 10000);
  if (!content) return res.json({ ok: true });
  // 同机同内容 10 分钟内去重（采集脚本重启后 $last 清零会重推最后一次内容）
  const last = tdb.prepare('SELECT content, created_at FROM clipboard_items WHERE device=? ORDER BY id DESC LIMIT 1').get(host);
  if (last && last.content === content) {
    const t = Date.parse(String(last.created_at || '').replace(' ', 'T'));
    if (!Number.isFinite(t) || Date.now() - t < 10 * 60 * 1000) return res.json({ ok: true, dup: true });
  }
  const r = tdb.prepare("INSERT INTO clipboard_items(content, source, device) VALUES(?, 'agent', ?)").run(content, host);
  tdb.prepare('INSERT OR IGNORE INTO clipboard_devices(host, first_seen, last_seen) VALUES(?,?,?)').run(host, Date.now(), Date.now());
  tdb.prepare('UPDATE clipboard_devices SET last_seen=?, push_count=push_count+1 WHERE host=?').run(Date.now(), host);
  res.json({ id: r.lastInsertRowid });
});
// 已登记的采集电脑列表（谁装了采集脚本、在不在线）
router.get('/clipboard/devices', (req, res) => {
  res.json(req.tdb.prepare('SELECT * FROM clipboard_devices ORDER BY last_seen DESC LIMIT 50').all());
});

// ---------- 快捷启动 ----------
router.get('/links', (req, res) => {
  res.json(req.tdb.prepare('SELECT * FROM quick_links ORDER BY category, id').all());
});
router.post('/links', (req, res) => {
  const { name, url, icon, category } = req.body;
  const r = req.tdb.prepare('INSERT INTO quick_links(name,url,icon,category) VALUES(?,?,?,?)')
    .run(name, url, icon || '', category || 'general');
  res.json({ id: r.lastInsertRowid });
});
router.delete('/links/:id', (req, res) => {
  req.tdb.prepare('DELETE FROM quick_links WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- 全局搜索 ----------
router.get('/search', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ results: [] });
  const like = `%${q}%`;
  const out = [];
  const collect = (rows, type, titleOf, linkOf) => {
    for (const r of rows) {
      out.push({ type, id: r.id, title: titleOf(r), content: r._c || '', time: r._t || '', to: linkOf ? linkOf(r) : undefined });
    }
  };
  collect(req.tdb.prepare('SELECT id, title AS t, content AS _c, updated_at AS _t FROM notes WHERE title LIKE ? OR content LIKE ? ORDER BY updated_at DESC LIMIT 10').all(like, like), '笔记', (r) => r.t);
  collect(req.tdb.prepare('SELECT id, title AS t, desc AS _c, due_date AS _t FROM todos WHERE title LIKE ? OR desc LIKE ? LIMIT 10').all(like, like), '待办', (r) => r.t);
  // 家庭事项/子女任务：随 family 共享开关选库
  const fdb = routedDb(req.tdb, 'family');
  collect(fdb.prepare('SELECT id, title AS t, desc AS _c, item_date AS _t FROM family_items WHERE title LIKE ? OR desc LIKE ? LIMIT 10').all(like, like), '家庭事项', (r) => r.t);
  collect(fdb.prepare("SELECT id, content AS t, '' AS _c, due_date AS _t FROM kid_tasks WHERE content LIKE ? LIMIT 10").all(like), '子女任务', (r) => r.t.slice(0, 60));
  collect(req.tdb.prepare('SELECT id, content AS t, gains AS _c, record_date AS _t FROM learning_records WHERE content LIKE ? OR gains LIKE ? LIMIT 10').all(like, like), '学习记录', (r) => r.t.slice(0, 60));
  collect(req.tdb.prepare("SELECT id, content AS t, '' AS _c, created_at AS _t FROM clipboard_items WHERE content LIKE ? LIMIT 10").all(like), '剪贴板', (r) => r.t.slice(0, 60));
  // 新闻：标题/摘要（news 表无 content 列；按共享开关选库）
  collect(routedDb(req.tdb, 'news').prepare('SELECT id, title AS t, summary AS _c, source AS _t FROM news WHERE title LIKE ? OR summary LIKE ? LIMIT 10')
    .all(like, like), '新闻', (r) => r.t);
  // 邮件：主题 + 正文全文
  collect(req.tdb.prepare('SELECT id, subject AS t, COALESCE(body, snippet, \'\') AS _c, COALESCE(date, fetched_at, \'\') AS _t FROM emails WHERE subject LIKE ? OR body LIKE ? OR from_addr LIKE ? ORDER BY id DESC LIMIT 10')
    .all(like, like, like), '邮件', (r) => r.t);
  // AI 对话：消息内容（带会话标题，点击跳转 AI 助手对应会话）
  collect(req.tdb.prepare(`SELECT m.id AS id, s.title AS t, m.content AS _c, m.created_at AS _t, s.id AS _sid
    FROM ai_messages m JOIN ai_sessions s ON s.id = m.session_id
    WHERE m.content LIKE ? ORDER BY m.id DESC LIMIT 10`).all(like), 'AI 对话', (r) => r.t, (r) => `/ai?session=${r._sid}`);
  // 文件存档：文件名 + 解析文字（点击跳文件页）
  collect(req.tdb.prepare('SELECT id, filename AS t, text_content AS _c, created_at AS _t FROM files WHERE filename LIKE ? OR text_content LIKE ? ORDER BY id DESC LIMIT 10')
    .all(like, like), '文件', (r) => r.t, () => '/files');
  res.json({ results: out });
});

module.exports = router;
