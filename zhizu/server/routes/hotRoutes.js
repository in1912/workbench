// 热门话题
const express = require('express');
const { db } = require('../db');
const hot = require('../services/hotService');
const { generateAndSave } = require('../services/topicService');

const router = express.Router();

const INDUSTRIES = ['美妆护肤', '美食餐饮', '时尚穿搭', '健身运动', '科技数码', '教育知识', '母婴育儿', '旅行出游', '家居生活', '职场成长', '情感心理', '财经投资'];

router.get('/industries', (req, res) => {
  res.json({ industries: INDUSTRIES, sources: hot.enabledSources() });
});

// 最近一次生成的 AI 选题（只取最新一条的 10 个；更早的在页面下方「历史生成」里查）
router.get('/ai/latest', (req, res) => {
  const r = db.prepare(
    "SELECT id,title,inputs,output,created_at,model FROM gen_records WHERE user_id=? AND feature='hot_ai' ORDER BY id DESC LIMIT 1"
  ).get(req.user.id);
  if (!r) return res.json({ record: null });
  let industry = '';
  try { industry = (JSON.parse(r.inputs || '{}') || {}).industry || ''; } catch { /* 忽略 */ }
  res.json({
    record: { id: r.id, industry: industry || String(r.title).replace(/^热点·/, ''), output: r.output, created_at: r.created_at, model: r.model },
  });
});

// GET /api/hot?industry=&source=baidu|sina|ai
router.get('/', async (req, res) => {
  const industry = String(req.query.industry || '').trim().slice(0, 50);
  const source = ['baidu', 'sina', 'ai'].includes(req.query.source) ? req.query.source : 'baidu';

  const enabled = hot.enabledSources();
  if (!enabled[source]) return res.status(400).json({ error: `「${hot.SOURCES[source].name}」源已被管理员停用` });

  try {
    if (source === 'baidu' || source === 'sina') {
      const data = source === 'baidu' ? await hot.fetchBaidu() : await hot.fetchSina();
      return res.json({ ...data, fetched_at: new Date().toISOString() });
    }
    // AI 源：需要行业（生成 + 入库逻辑在 topicService，与每日定时任务共用）
    if (req.user.role === 'guest') return res.status(403).json({ error: '当前账号为「受限用户」，无 AI 生成权限，请联系管理员调整角色' });
    if (!industry) return res.status(400).json({ error: 'AI 智能选题需要选择或输入一个行业' });
    const data = await generateAndSave(req.user, industry);
    res.json({ ...data, fetched_at: new Date().toISOString() });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message });
  }
});

module.exports = { router };
