// 日程钉钉提醒巡检：scheduler 每分钟调一次 checkAll()。
// 触发条件（同一条日程只发一次）：remind_push=1 且 remind_sent_at IS NULL，有具体开始时间
// （全天日程无 HH:MM 不提醒），且已进入 [开始-15分钟, 开始) 窗口——过期不补发
// （服务器停机跨过窗口的放弃，避免开机收到一堆迟到的提醒）。
// 推送通道：工作通知优先（配了 AgentId 走 asyncsend_v2 文本），否则回退原文字通道；
// 共享日程（shared_to）同时推给共享成员，用他们各自的租户钉钉配置。
const { db, forEachTenant } = require('../db');
const dingtalk = require('./dingtalkService');
const messageService = require('./messageService');

const REMIND_AHEAD_MIN = 15;

function ownerName(uid) { return messageService.userName(db, uid); }

function buildText(ev, opts = {}) {
  const day = String(ev.start_time || '').slice(0, 10);
  const hm = String(ev.start_time || '').slice(11, 16);
  const et = ev.end_time && String(ev.end_time).includes('T') ? '~' + String(ev.end_time).slice(11, 16) : '';
  const lines = [
    `【个人工作台·日程提醒】${ev.title}`,
    `时间：${day} ${hm}${et}（${REMIND_AHEAD_MIN} 分钟后开始）`,
  ];
  if (ev.end_date && ev.end_date > day) lines[1] += `，跨日至 ${ev.end_date}`;
  if (ev.location) lines.push('地点：' + ev.location);
  if (ev.desc) lines.push('内容：' + String(ev.desc).replace(/\s+/g, ' ').slice(0, 120));
  if (opts.fromName) lines.push(`（${opts.fromName} 共享的日程）`);
  return lines.join('\n');
}

function parseShared(ev) {
  let ids = [];
  try { ids = JSON.parse(ev.shared_to || '[]'); } catch { /* 脏数据按未共享处理 */ }
  return Array.isArray(ids) ? ids.map(Number).filter((x) => x > 0) : [];
}

async function checkTenant(d, uid, username) {
  const rows = d.prepare(`
    SELECT * FROM events
    WHERE remind_push = 1 AND remind_sent_at IS NULL
      AND start_time IS NOT NULL AND length(start_time) >= 16
      AND datetime(start_time, ?) <= datetime('now', 'localtime')
      AND datetime(start_time) > datetime('now', 'localtime')
  `).all(`-${REMIND_AHEAD_MIN} minutes`);
  for (const ev of rows) {
    const name = ownerName(uid);
    let ok = false;
    try { ok = await dingtalk.sendWorkNoticeText(d, buildText(ev)); }
    catch (e) { console.warn(`[event-remind] 推给日程主人(${username})失败 #${ev.id}:`, e.message); }
    // 共享成员：同一时间点各自推送（失败不影响彼此；未绑定钉钉的静默跳过）
    const sharedIds = parseShared(ev);
    for (const sid of sharedIds) {
      try { await dingtalk.notifyUserWorkNotice(db, sid, buildText(ev, { fromName: name })); }
      catch (e) { console.warn(`[event-remind] 推给共享成员#${sid}失败 #${ev.id}:`, e.message); }
    }
    // 无论推送成败都盖章（失败重试会在下个分钟重复轰炸，宁可不重试）
    d.prepare("UPDATE events SET remind_sent_at = datetime('now', 'localtime') WHERE id = ?").run(ev.id);
    console.log(`[event-remind] 日程「${ev.title}」提醒已发（${username}${sharedIds.length ? ` +${sharedIds.length} 位共享成员` : ''}${ok ? '' : '，本人钉钉未绑定/未启用，仅同步共享成员'}）`);
  }
}

async function checkAll() {
  forEachTenant((d, uid, username) => {
    checkTenant(d, uid, username).catch((e) => console.warn(`[event-remind] 租户 ${username} 巡检失败:`, e.message));
  });
}

module.exports = { checkAll, REMIND_AHEAD_MIN };
