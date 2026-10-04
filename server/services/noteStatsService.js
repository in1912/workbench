// 笔记统计（v1.9.41 统计插件）：写作字数、打卡记录（连续天数）、按天曲线、按文件夹分布。
// 全部基于 notes.word_count 这一列（保存时算好），所以是聚合查询而不是每次全表扫正文。
const { folderMap } = require('./noteService');

const localToday = () => new Date().toLocaleString('sv').slice(0, 10);

// 从「有记录的日期」列表算连续打卡：从今天（或昨天，允许今天还没写）往前数
function streakOf(daysDesc) {
  if (!daysDesc.length) return { streak_days: 0, longest_streak: 0 };
  const set = new Set(daysDesc);
  const today = localToday();
  const y = new Date(Date.now() - 86400000).toLocaleString('sv').slice(0, 10);
  let start = set.has(today) ? today : (set.has(y) ? y : null);
  let streak = 0;
  if (start) {
    const d = new Date(`${start}T00:00:00`);
    while (set.has(d.toLocaleString('sv').slice(0, 10))) {
      streak++;
      d.setDate(d.getDate() - 1);
    }
  }
  // 最长连续：把日期升序扫一遍
  const asc = [...daysDesc].sort();
  let longest = 0, run = 0, prev = null;
  for (const ds of asc) {
    const cur = new Date(`${ds}T00:00:00`).getTime();
    if (prev != null && cur - prev === 86400000) run++; else run = 1;
    if (run > longest) longest = run;
    prev = cur;
  }
  return { streak_days: streak, longest_streak: longest };
}

function stats(tdb, { days = 365 } = {}) {
  const total = tdb.prepare('SELECT COUNT(*) c, COALESCE(SUM(word_count),0) w FROM notes').get();
  const byDayAll = tdb.prepare(`
    SELECT date(updated_at) d, COUNT(*) c, COALESCE(SUM(word_count),0) w
    FROM notes WHERE updated_at IS NOT NULL AND date(updated_at) IS NOT NULL
    GROUP BY d ORDER BY d DESC`).all();
  const today = localToday();
  const byDay = byDayAll.slice(0, Math.min(3650, Math.max(1, Number(days) || 365)));
  const { streak_days, longest_streak } = streakOf(byDayAll.map((r) => r.d));
  const todayRow = byDayAll.find((r) => r.d === today);
  const fmap = folderMap(tdb);
  // 按顶层文件夹归并（多级树里子文件夹的字数并到它的顶层祖先）
  const topOf = (fid) => {
    let f = fid == null ? null : fmap.byId.get(Number(fid));
    let guard = 0;
    while (f && f.parent_id != null && guard++ < 64) { const p = fmap.byId.get(Number(f.parent_id)); if (!p) break; f = p; }
    return f ? f.name : '未归档';
  };
  const folderRows = tdb.prepare(
    'SELECT folder_id, COUNT(*) c, COALESCE(SUM(word_count),0) w FROM notes GROUP BY folder_id').all();
  const byFolder = {};
  for (const r of folderRows) {
    const k = topOf(r.folder_id);
    if (!byFolder[k]) byFolder[k] = { folder: k, count: 0, words: 0 };
    byFolder[k].count += r.c;
    byFolder[k].words += r.w;
  }
  return {
    total_notes: total.c,
    total_words: total.w,
    today_words: todayRow ? todayRow.w : 0,
    today_notes: todayRow ? todayRow.c : 0,
    active_days: byDayAll.length,
    streak_days,
    longest_streak,
    by_folder: Object.values(byFolder).sort((a, b) => b.count - a.count),
    by_day: byDay.slice().reverse(), // 返回按日期升序，前端画曲线省一步
  };
}

module.exports = { stats, streakOf, localToday };
