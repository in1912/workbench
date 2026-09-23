// AI 选题生成 + 入库（「AI智能选题」页手动触发 与 每日定时任务 共用）
const { db } = require('../db');
const hot = require('./hotService');
const ai = require('./aiService');

async function generateAndSave(user, industry) {
  const cfg = ai.resolveConfig(user);
  if (!cfg) throw Object.assign(new Error('尚未配置算力，请先到「算力配置」页设置 AI 接口（或联系管理员配置全局算力）'), { status: 400 });
  const data = await hot.aiTopics({
    industry,
    aiFn: (prompt, timeout) => ai.chat(cfg, [{ role: 'user', content: prompt }], { timeout }),
  });
  db.prepare('INSERT INTO gen_records(user_id,feature,title,inputs,output,model,tokens,duration_ms) VALUES(?,?,?,?,?,?,?,?)')
    .run(user.id, 'hot_ai', `热点·${industry}`,
      JSON.stringify({ industry, source: 'ai', hot_words: Array.isArray(data.hotWords) ? data.hotWords.slice(0, 15) : [] }),
      data.raw || '', data.model || '', data.tokens || 0, 0);
  delete data.raw;
  return data;
}

module.exports = { generateAndSave };
