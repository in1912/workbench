// 打字赚钱：练习进度上报 / 每日记录 / 月度汇总（赚钱日历）/ 费率配置 / 兑现登记
// 权限：练习、记录、赚钱日历随 typing 页面授权；/typing/payouts* 与 /typing/config 归
//       「兑现登记」受限 tab（费率与兑现同属钱款管理），必须在用户管理里显式勾选授权
//       （admin 始终可见，见 auth.js RESTRICTED_TABS）。
const express = require('express');
const { db } = require('../db');
const router = express.Router();

// 奖励费率存 settings 表：打字每打对 reward_chars 个字 = reward_yuan 元；
// 视频教学每 video_reward_minutes 分钟学时 = video_reward_yuan 元（默认 60 分钟 1 元）；
// 练琴每 piano_reward_hours 小时有效时长 = piano_reward_yuan 元（默认 1 小时 3 元）
const RATE_DEFAULTS = {
  typing_reward_chars: 100, typing_reward_yuan: 2,
  video_reward_minutes: 60, video_reward_yuan: 1,
  piano_reward_hours: 1, piano_reward_yuan: 3,
};
const RATE_FIELDS = [
  ['typing_reward_chars', 'reward_chars', Math.round],
  ['typing_reward_yuan', 'reward_yuan', (v) => v],
  ['video_reward_minutes', 'video_reward_minutes', Math.round],
  ['video_reward_yuan', 'video_reward_yuan', (v) => v],
  ['piano_reward_hours', 'piano_reward_hours', (v) => v],
  ['piano_reward_yuan', 'piano_reward_yuan', (v) => v],
];
function loadRates() {
  const out = { ...RATE_DEFAULTS };
  for (const [key, short] of RATE_FIELDS) {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    const n = row ? Number(row.value) : NaN;
    if (Number.isFinite(n) && n > 0) out[short] = n;
  }
  out.wrong_penalty = WRONG_PENALTY; // 前端展示用：打错 1 个减 3 个有效字
  return out;
}
const dayMoney = (correct, rates) => Math.round(correct * rates.reward_yuan / rates.reward_chars * 100) / 100;
// 视频学时折算（有效秒 → 元）；练琴有效时长折算（有效秒 → 元）
const videoMoney = (effSec, rates) => Math.round((effSec || 0) / 60 / rates.video_reward_minutes * rates.video_reward_yuan * 100) / 100;
const pianoMoney = (validSec, rates) => Math.round((validSec || 0) / 3600 / rates.piano_reward_hours * rates.piano_reward_yuan * 100) / 100;

// ---------- 视频学时 / 练琴 有效秒数聚合（按天，供赚钱日历与预览合并统计） ----------
// 视频按流水落账日归属；练琴按录音开始日归属（练习发生在哪天钱就算哪天）
function videoEffByDay(uid, month) {
  const out = {};
  for (const r of db.prepare(
    `SELECT strftime('%Y-%m-%d', created_at) d, COALESCE(SUM(delta_sec),0) v
     FROM vstudy_ledger WHERE user_id=? AND strftime('%Y-%m', created_at)=? GROUP BY d`
  ).all(uid, month)) out[r.d] = r.v;
  return out;
}
function videoEffTotals(uid) {
  return db.prepare(
    `SELECT COALESCE(SUM(delta_sec),0) all_v,
            COALESCE(SUM(CASE WHEN strftime('%Y-%m', created_at)=strftime('%Y-%m','now','localtime') THEN delta_sec ELSE 0 END),0) month_v
     FROM vstudy_ledger WHERE user_id=?`
  ).get(uid);
}
function pianoValidByDay(uid, month) {
  const out = {};
  for (const r of db.prepare(
    `SELECT strftime('%Y-%m-%d', COALESCE(NULLIF(started_at,''), created_at)) d, COALESCE(SUM(valid_sec),0) v
     FROM piano_records WHERE user_id=? AND confirmed=1
       AND strftime('%Y-%m', COALESCE(NULLIF(started_at,''), created_at))=?
     GROUP BY d`
  ).all(uid, month)) out[r.d] = r.v;
  return out;
}
function pianoTotals(uid) {
  return db.prepare(
    `SELECT COALESCE(SUM(duration_sec),0) total_sec,
            COALESCE(SUM(CASE WHEN strftime('%Y-%m', COALESCE(NULLIF(started_at,''), created_at))=strftime('%Y-%m','now','localtime') THEN duration_sec ELSE 0 END),0) month_sec,
            COALESCE(SUM(CASE WHEN confirmed=1 THEN valid_sec ELSE 0 END),0) valid_sec,
            COALESCE(SUM(CASE WHEN confirmed=1 AND strftime('%Y-%m', COALESCE(NULLIF(started_at,''), created_at))=strftime('%Y-%m','now','localtime') THEN valid_sec ELSE 0 END),0) month_valid
     FROM piano_records WHERE user_id=?`
  ).get(uid);
}
// 有效字数（结算口径）：打对 − 3×打错，错 1 个减 3 个。惩罚后单日可为负——如实展示，月内正负自然相抵
const WRONG_PENALTY = 3;
const netChars = (correct, wrong) => (correct || 0) - WRONG_PENALTY * (wrong || 0);
const todayStr = () => new Date().toLocaleDateString('sv').slice(0, 10);
const monthStr = () => new Date().toLocaleDateString('sv').slice(0, 7);
const userLabel = (u) => (u && (u.display_name || u.nickname || u.username)) || `用户#${u && u.id}`;

// 记录/汇总查询的目标用户：admin 可指定 user_id，其余人只能看自己
function targetUid(req) {
  const id = Number(req.query.user_id) || 0;
  return req.user.role === 'admin' && id ? id : req.user.id;
}

// ---------- 练习进度上报（前端每 20 秒心跳 + 退出补报，当日累加） ----------
router.post('/typing/progress', (req, res) => {
  const num = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
  const seconds = num(req.body.seconds, 600);
  const correct = num(req.body.correct, 3000);
  const wrong = num(req.body.wrong, 3000);
  if (seconds || correct || wrong) {
    db.prepare(
      `INSERT INTO typing_days(user_id, day, seconds, correct, wrong, updated_at)
       VALUES(?,?,?,?,?,datetime('now','localtime'))
       ON CONFLICT(user_id, day) DO UPDATE SET
         seconds = seconds + excluded.seconds,
         correct = correct + excluded.correct,
         wrong = wrong + excluded.wrong,
         updated_at = datetime('now','localtime')`
    ).run(req.user.id, todayStr(), seconds, correct, wrong);
  }
  res.json({ ok: true });
});

// ---------- 每日记录（最近 N 天，默认 31） ----------
router.get('/typing/records', (req, res) => {
  const uid = targetUid(req);
  const days = Math.min(366, Math.max(1, Number(req.query.days) || 31));
  const from = new Date(Date.now() - (days - 1) * 86400000).toLocaleDateString('sv').slice(0, 10);
  const rows = db.prepare(
    'SELECT day, seconds, correct, wrong FROM typing_days WHERE user_id=? AND day>=? ORDER BY day DESC'
  ).all(uid, from);
  const t = rows.reduce((a, r) => ({ s: a.s + r.seconds, c: a.c + r.correct, w: a.w + r.wrong }), { s: 0, c: 0, w: 0 });
  res.json({
    user_id: uid,
    days: rows.map((r) => ({ ...r, net: netChars(r.correct, r.wrong) })),
    totals: { seconds: t.s, correct: t.c, wrong: t.w, net: netChars(t.c, t.w), accuracy: t.c + t.w ? Math.round(t.c / (t.c + t.w) * 100) : null },
    // admin 可在打字记录里切换查看任意成员
    users: req.user.role === 'admin'
      ? db.prepare('SELECT id, username, display_name, nickname FROM users WHERE is_bot=0 ORDER BY id').all()
          .map((u) => ({ id: u.id, name: userLabel(u) }))
      : undefined,
  });
});

// ---------- 月度汇总（赚钱日历数据：打字 + 视频学时 + 练琴 合并统计） ----------
router.get('/typing/summary', (req, res) => {
  const uid = targetUid(req);
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || '')) ? req.query.month : monthStr();
  const rates = loadRates();
  const rows = db.prepare(
    "SELECT day, seconds, correct, wrong FROM typing_days WHERE user_id=? AND day LIKE ? ORDER BY day"
  ).all(uid, month + '-%');
  const days = rows.map((r) => ({ ...r, net: netChars(r.correct, r.wrong), money: dayMoney(netChars(r.correct, r.wrong), rates) }));
  const tc = rows.reduce((a, r) => a + r.correct, 0);
  const tw = rows.reduce((a, r) => a + r.wrong, 0);
  const ts = rows.reduce((a, r) => a + r.seconds, 0);
  const paid = db.prepare(
    'SELECT COALESCE(SUM(amount),0) s FROM typing_payouts WHERE user_id=? AND period=?'
  ).get(uid, month).s;
  // 视频学时（按流水落账日）与练琴有效时长（按录音开始日，仅已确认）按天聚合
  const vDay = videoEffByDay(uid, month);
  const pDay = pianoValidByDay(uid, month);
  for (const d of days) {
    d.video_sec = Math.max(0, vDay[d.day] || 0);
    d.piano_sec = pDay[d.day] || 0;
    d.money = Math.round((d.money + videoMoney(d.video_sec, rates) + pianoMoney(d.piano_sec, rates)) * 100) / 100;
    delete vDay[d.day]; delete pDay[d.day];
  }
  // 只有视频/练琴、没有打字记录的日子也要出现在日历上
  const extraDays = [...new Set([...Object.keys(vDay), ...Object.keys(pDay)])];
  for (const d of extraDays) {
    days.push({ day: d, seconds: 0, correct: 0, wrong: 0, net: 0,
      video_sec: Math.max(0, vDay[d] || 0), piano_sec: pDay[d] || 0,
      money: Math.round((videoMoney(Math.max(0, vDay[d] || 0), rates) + pianoMoney(pDay[d] || 0, rates)) * 100) / 100 });
  }
  days.sort((a, b) => (a.day < b.day ? -1 : 1));
  // 合并总额：打字 + 视频 + 练琴（days 各行已含三类合计，月度直接按行汇总）
  const typingTotal = dayMoney(netChars(tc, tw), rates);
  const vt = videoEffTotals(uid);
  const pt = pianoTotals(uid);
  const monthVideoSec = days.reduce((s, d) => s + (d.video_sec || 0), 0);
  const monthPianoSec = days.reduce((s, d) => s + (d.piano_sec || 0), 0);
  const monthVideoMoney = videoMoney(monthVideoSec, rates);
  const monthPianoMoney = pianoMoney(monthPianoSec, rates);
  const total = Math.round((typingTotal + monthVideoMoney + monthPianoMoney) * 100) / 100;
  // 赊账（提前支取）也占用待兑现额度
  const advanced = db.prepare(
    'SELECT COALESCE(SUM(ABS(amount)),0) s FROM credit_records WHERE user_id=? AND period=?'
  ).get(uid, month).s;
  res.json({
    user_id: uid, month, days,
    totals: {
      seconds: ts, correct: tc, wrong: tw, net: netChars(tc, tw),
      accuracy: tc + tw ? Math.round(tc / (tc + tw) * 100) : null,
      money: total, paid: Math.round(paid * 100) / 100,
      advanced: Math.round(advanced * 100) / 100,
      pending: Math.max(0, Math.round((total - paid - advanced) * 100) / 100),
      typing_money: typingTotal,
      video_hist_sec: Math.max(0, vt.all_v || 0), video_month_sec: monthVideoSec,
      video_month_money: monthVideoMoney,
      piano_total_sec: pt.total_sec || 0, piano_month_sec: pt.month_sec || 0,
      piano_valid_sec: pt.valid_sec || 0, piano_month_valid_sec: pt.month_valid || 0,
      piano_month_money: monthPianoMoney,
    },
    config: rates,
    // admin 可在赚钱日历里切换查看任意成员
    users: req.user.role === 'admin'
      ? db.prepare('SELECT id, username, display_name, nickname FROM users WHERE is_bot=0 ORDER BY id').all()
          .map((u) => ({ id: u.id, name: userLabel(u) }))
      : undefined,
  });
});

// ---------- 费率配置（归「兑现登记」受限 tab：能进兑现登记即可设置，admin 恒可） ----------
router.get('/typing/config', (req, res) => res.json(loadRates()));
router.put('/typing/config', (req, res) => {
  for (const [key, short, cast] of RATE_FIELDS) {
    if (req.body[short] === undefined) continue;
    const n = Number(req.body[short]);
    if (!Number.isFinite(n) || n <= 0)
      return res.status(400).json({ error: `费率无效：${short} 需 >0` });
    db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, String(cast(n)));
  }
  res.json(loadRates());
});

// ---------- 兑现登记（受限 tab） ----------
// 结算人（登记表单）用的用户清单
router.get('/typing/payouts/users', (req, res) => {
  const rows = db.prepare('SELECT id, username, display_name, nickname FROM users WHERE is_bot=0 ORDER BY id').all();
  res.json(rows.map((u) => ({ id: u.id, name: userLabel(u) })));
});

// 某用户某月「已赚 / 已兑现 / 待兑现」预览（登记表单提示金额用；打字+视频+练琴分项合并）
router.get('/typing/payouts/preview', (req, res) => {
  const uid = Number(req.query.user_id) || 0;
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(req.query.month || '')) ? req.query.month : monthStr();
  if (!uid) return res.status(400).json({ error: '缺少用户' });
  const rates = loadRates();
  const agg = db.prepare(
    "SELECT COALESCE(SUM(correct),0) c, COALESCE(SUM(wrong),0) w FROM typing_days WHERE user_id=? AND day LIKE ?"
  ).get(uid, month + '-%');
  const paid = db.prepare(
    'SELECT COALESCE(SUM(amount),0) s FROM typing_payouts WHERE user_id=? AND period=?'
  ).get(uid, month).s;
  const videoSec = db.prepare(
    "SELECT COALESCE(SUM(delta_sec),0) v FROM vstudy_ledger WHERE user_id=? AND strftime('%Y-%m', created_at)=?"
  ).get(uid, month).v;
  const pianoSec = db.prepare(
    `SELECT COALESCE(SUM(valid_sec),0) v FROM piano_records WHERE user_id=? AND confirmed=1
       AND strftime('%Y-%m', COALESCE(NULLIF(started_at,''), created_at))=?`
  ).get(uid, month).v;
  const typingEarned = dayMoney(netChars(agg.c, agg.w), rates);
  const videoEarned = videoMoney(Math.max(0, videoSec), rates);
  const pianoEarned = pianoMoney(pianoSec, rates);
  const advanced = db.prepare(
    'SELECT COALESCE(SUM(ABS(amount)),0) s FROM credit_records WHERE user_id=? AND period=?'
  ).get(uid, month).s;
  const earned = Math.round((typingEarned + videoEarned + pianoEarned) * 100) / 100;
  res.json({
    user_id: uid, month, correct: agg.c, wrong: agg.w, net: netChars(agg.c, agg.w),
    typing_earned: typingEarned, video_sec: Math.max(0, videoSec), video_earned: videoEarned,
    piano_sec: pianoSec, piano_earned: pianoEarned,
    earned,
    paid: Math.round(paid * 100) / 100,
    advanced: Math.round(advanced * 100) / 100,
    pending: Math.max(0, Math.round((earned - paid - advanced) * 100) / 100),
    config: rates,
  });
});

// 兑现记录列表（最近 200 条，含用户名/登记人名）
router.get('/typing/payouts', (req, res) => {
  const rows = db.prepare(
    `SELECT p.id, p.user_id, p.period, p.amount, p.note, p.created_by, p.created_at,
            u.display_name u_dn, u.nickname u_nn, u.username u_un,
            c.display_name c_dn, c.nickname c_nn, c.username c_un
     FROM typing_payouts p
     JOIN users u ON u.id = p.user_id
     LEFT JOIN users c ON c.id = p.created_by
     ORDER BY p.id DESC LIMIT 200`
  ).all();
  res.json(rows.map((r) => ({
    id: r.id, user_id: r.user_id, user_name: r.u_dn || r.u_nn || r.u_un,
    period: r.period, amount: r.amount, note: r.note,
    created_by: r.created_by,
    created_by_name: r.c_dn || r.c_nn || r.c_un || `#${r.created_by}`,
    created_at: r.created_at,
  })));
});

// 登记一笔已兑现
router.post('/typing/payouts', (req, res) => {
  const uid = Number(req.body.user_id) || 0;
  const period = String(req.body.period || '');
  const amount = Number(req.body.amount);
  if (!db.prepare('SELECT id FROM users WHERE id=? AND is_bot=0').get(uid))
    return res.status(400).json({ error: '用户不存在' });
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) return res.status(400).json({ error: '月份格式应为 YYYY-MM' });
  if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: '金额需大于 0' });
  const info = db.prepare(
    'INSERT INTO typing_payouts(user_id, period, amount, note, created_by) VALUES(?,?,?,?,?)'
  ).run(uid, period, Math.round(amount * 100) / 100, String(req.body.note || '').slice(0, 200), req.user.id);
  res.json({ ok: true, id: info.lastInsertRowid });
});

// 删除登记（admin 或登记人本人，当天内可撤）
router.delete('/typing/payouts/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM typing_payouts WHERE id=?').get(Number(req.params.id) || 0);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  if (req.user.role !== 'admin' && row.created_by !== req.user.id)
    return res.status(403).json({ error: '仅管理员或登记人可删除' });
  const info = db.prepare(
    "DELETE FROM typing_payouts WHERE id=? AND created_at > datetime('now','localtime','-1 day')"
  ).run(row.id);
  if (!info.changes) return res.status(400).json({ error: '仅登记后 1 天内可删除' });
  res.json({ ok: true });
});

// ---------- 赊账兑换登记（写操作归「兑现登记」受限 tab；列表两处展示：兑现登记可勾选平账、记录页只读） ----------
// 列表（分页；学习页内共享，供记录页只读展示）
router.get('/credit/list', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.max(5, Math.min(100, parseInt(req.query.pageSize, 10) || 15));
  const total = db.prepare('SELECT COUNT(*) c FROM credit_records').get().c;
  const rows = db.prepare(`
    SELECT cr.*, u.display_name u_dn, u.nickname u_nn, u.username u_un
    FROM credit_records cr LEFT JOIN users u ON u.id = cr.user_id
    ORDER BY cr.id DESC LIMIT ? OFFSET ?
  `).all(pageSize, (page - 1) * pageSize);
  res.json({
    total, page, pageSize,
    rows: rows.map((r) => ({ ...r, user_name: r.u_dn || r.u_nn || r.u_un || `#${r.user_id}` })),
  });
});

// 登记（金额默认负数 = 提前支取；可附图片凭证 family_images id）
router.post('/credit/manage', (req, res) => {
  const b = req.body || {};
  const uid = Number(b.user_id) || 0;
  if (!db.prepare('SELECT id FROM users WHERE id=? AND is_bot=0').get(uid))
    return res.status(400).json({ error: '成员不存在' });
  const period = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(b.period || '')) ? b.period : monthStr();
  let amount = Number(b.amount);
  if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: '金额无效（手工填写，负数为支取）' });
  if (amount > 0) amount = -amount; // 统一存负数（赊账 = 提前支取）
  const imageId = Number(b.image_id) > 0 && db.prepare('SELECT id FROM family_images WHERE id=?').get(Number(b.image_id))
    ? Number(b.image_id) : null;
  const me = db.prepare('SELECT display_name, nickname, username FROM users WHERE id=?').get(req.user.id);
  // 日期时间可手工改（默认当天当时）；只接受 YYYY-MM-DD HH:MM(:SS)
  const ts = String(b.created_at || '').trim().replace('T', ' ');
  const created = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(ts) ? (ts.length === 16 ? ts + ':00' : ts) : null;
  const info = db.prepare(`INSERT INTO credit_records(user_id, user_name, period, amount, content, note, image_id, created_by, created_by_name, created_at)
    VALUES(?,?,?,?,?,?,?,?,?,COALESCE(?, datetime('now','localtime')))`)
    .run(uid, (db.prepare('SELECT display_name, nickname, username FROM users WHERE id=?').get(uid) || {}).display_name || '',
      period, Math.round(amount * 100) / 100,
      String(b.content || '').slice(0, 200), String(b.note || '').slice(0, 300), imageId,
      req.user.id, me ? (me.display_name || me.nickname || me.username) : '', created);
  res.json({ ok: true, id: info.lastInsertRowid });
});

// 勾选/取消平账
router.patch('/credit/manage/:id/settle', (req, res) => {
  const row = db.prepare('SELECT * FROM credit_records WHERE id=?').get(Number(req.params.id) || 0);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  const settled = (req.body || {}).settled === false || (req.body || {}).settled === 0 ? 0 : 1;
  const me = db.prepare('SELECT display_name, nickname, username FROM users WHERE id=?').get(req.user.id);
  db.prepare(`UPDATE credit_records SET settled=?, settled_at=CASE WHEN ?=1 THEN datetime('now','localtime') ELSE NULL END,
    settled_by=CASE WHEN ?=1 THEN ? ELSE NULL END, settled_by_name=CASE WHEN ?=1 THEN ? ELSE NULL END WHERE id=?`)
    .run(settled, settled, settled, req.user.id, settled, me ? (me.display_name || me.nickname || me.username) : '', row.id);
  res.json({ ok: true });
});

// 删除（admin 或登记人本人，1 天内可撤）
router.delete('/credit/manage/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM credit_records WHERE id=?').get(Number(req.params.id) || 0);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  if (req.user.role !== 'admin' && row.created_by !== req.user.id)
    return res.status(403).json({ error: '仅管理员或登记人可删除' });
  const info = db.prepare(
    "DELETE FROM credit_records WHERE id=? AND created_at > datetime('now','localtime','-1 day')"
  ).run(row.id);
  if (!info.changes) return res.status(400).json({ error: '仅登记后 1 天内可删除' });
  res.json({ ok: true });
});

// ---------- 自定义打字内容导入（游戏/诗词/歌词；存主库，仅创建人可见可删） ----------
// 游戏模式只导字母（练习流本身只认 a-z）；诗词/歌词需带逐字对齐拼音（前端导入时
// 用 pinyin-pro 自动生成、可手工修正，约定与内置库一致：无声调、ü→v、标点原样透传）
const IMPORT_KINDS = new Set(['game', 'poem', 'song']);
const isHan = (ch) => /[一-鿿]/.test(ch);

router.get('/typing/imports', (req, res) => {
  const kind = String(req.query.kind || '');
  const sql = `SELECT id, kind, title, subtitle, text, pinyin, created_at FROM typing_imports
    WHERE user_id=? ${IMPORT_KINDS.has(kind) ? 'AND kind=? ' : ''}ORDER BY id DESC`;
  res.json(IMPORT_KINDS.has(kind) ? db.prepare(sql).all(req.user.id, kind) : db.prepare(sql).all(req.user.id));
});

router.post('/typing/imports', (req, res) => {
  const b = req.body || {};
  const kind = String(b.kind || '');
  if (!IMPORT_KINDS.has(kind)) return res.status(400).json({ error: '类型无效（应为 game/poem/song）' });
  const title = String(b.title || '').trim().slice(0, 40);
  if (!title) return res.status(400).json({ error: '请填写标题' });
  const subtitle = String(b.subtitle || '').trim().slice(0, 40);
  const text = String(b.text || '');
  let pinyin = '';
  if (kind === 'game') {
    // 游戏模式只能导入字母：空格仅作分隔（练习时全部忽略），其余字符一律拒绝
    if (/[0-9]/.test(text) || !/^[A-Za-z\s]*$/.test(text))
      return res.status(400).json({ error: '游戏练习只能包含英文字母（空格可选），不能有数字或符号' });
    const letters = text.replace(/[^A-Za-z]/g, '');
    if (letters.length < 4) return res.status(400).json({ error: '至少需要 4 个英文字母' });
    if (letters.length > 800) return res.status(400).json({ error: '内容过长（最多 800 个字母）' });
  } else {
    if (text.trim().length < 4) return res.status(400).json({ error: '内容太短（至少 4 个字）' });
    if (text.length > 2000) return res.status(400).json({ error: '内容过长（最多 2000 字）' });
    if ([...text].filter(isHan).length < 4)
      return res.status(400).json({ error: '内容需至少包含 4 个汉字' });
    pinyin = String(b.pinyin || '').trim().slice(0, 4000);
    if (!pinyin) return res.status(400).json({ error: '缺少拼音（导入窗口会自动生成）' });
  }
  if (db.prepare('SELECT COUNT(*) c FROM typing_imports WHERE user_id=?').get(req.user.id).c >= 100)
    return res.status(400).json({ error: '导入数量已达上限（100 条），请先删除一些' });
  const clean = kind === 'game' ? text.replace(/\s+/g, ' ').trim() : text.trim();
  const info = db.prepare(
    'INSERT INTO typing_imports(user_id, kind, title, subtitle, text, pinyin) VALUES(?,?,?,?,?,?)'
  ).run(req.user.id, kind, title, subtitle, clean, pinyin);
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.delete('/typing/imports/:id', (req, res) => {
  const row = db.prepare('SELECT id FROM typing_imports WHERE id=? AND user_id=?')
    .get(Number(req.params.id) || 0, req.user.id);
  if (!row) return res.status(404).json({ error: '内容不存在' });
  db.prepare('DELETE FROM typing_imports WHERE id=?').run(row.id);
  res.json({ ok: true });
});

module.exports = router;
