// 每日定时 AI 选题：每分钟对照用户在「我的」页配置的生成时间（本地时间 HH:MM）
const { db } = require('../db');
const { generateAndSave } = require('./topicService');

function localDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function tick() {
  try {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const today = localDate(now);
    const rows = db.prepare(
      "SELECT * FROM users WHERE ai_topic_time=? AND ai_topic_last<>? AND ai_topic_industries NOT IN ('','[]')"
    ).all(hhmm, today);
    for (const u of rows) {
      db.prepare('UPDATE users SET ai_topic_last=? WHERE id=?').run(today, u.id); // 先标记，防止同一天重复执行
      if (u.role === 'guest') continue; // 受限用户不消耗算力
      let industries = [];
      try { industries = JSON.parse(u.ai_topic_industries || '[]'); } catch { /* 格式异常跳过 */ }
      if (!Array.isArray(industries) || !industries.length) continue;
      let ok = 0;
      for (const ind of industries.slice(0, 12)) {
        try { await generateAndSave(u, String(ind).slice(0, 50)); ok++; }
        catch (e) { console.error(`[定时选题] ${u.username} · ${ind} 失败: ${e.message}`); }
      }
      console.log(`[定时选题] ${u.username} 完成 ${ok}/${industries.length} 个行业`);
    }
  } catch (e) { console.error('[定时选题] 检查异常:', e.message); }
}

function startTopicScheduler() {
  setTimeout(tick, 5000);      // 启动后先查一次（当天已到点但未执行的补跑一次，ai_topic_last 防重）
  setInterval(tick, 60 * 1000);
  console.log('[定时选题] 调度器已启动（每分钟检查一次用户配置的生成时间）');
}

module.exports = { startTopicScheduler };
