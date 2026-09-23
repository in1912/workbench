// 生成（11 功能统一入口）+ 生成记录
const express = require('express');
const { db } = require('../db');
const { FEATURES } = require('../features');
const ai = require('../services/aiService');
const { buildXlsx } = require('../xlsx');

const router = express.Router();

// 功能元数据（给前端渲染表单用）
router.get('/meta', (req, res) => {
  const { featureTables } = require('../featureTables');
  res.json(featureTables());
});

// 统一生成入口：POST /api/gen/:feature
router.post('/:feature', async (req, res) => {
  const feat = FEATURES[req.params.feature];
  if (!feat) return res.status(404).json({ error: '未知功能' });
  if (req.user.role === 'guest') return res.status(403).json({ error: '当前账号为「受限用户」，无 AI 生成权限，请联系管理员调整角色' });

  let inputs;
  try {
    inputs = feat.validate(req.body || {});
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }

  const cfg = ai.resolveConfig(req.user);
  if (!cfg) {
    return res.status(400).json({ error: '尚未配置算力，请先到「算力配置」页设置 AI 接口（或联系管理员配置全局算力）' });
  }

  const prompt = feat.build(inputs);
  const started = Date.now();
  let r;
  try {
    r = await ai.chat(cfg, [{ role: 'user', content: prompt }], { temperature: 0.6 });
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
  const duration_ms = Date.now() - started;

  // 解析（JSON 双保险：直接 parse → 正则抽取）
  let parsed = null;
  if (feat.parse === 'jsonArray') {
    try { parsed = JSON.parse(r.content); } catch {
      const m = r.content.match(/\[[\s\S]*\]/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch { /* 保留原文 */ } }
    }
    if (!Array.isArray(parsed)) parsed = null;
  } else if (feat.parse === 'jsonObject') {
    let obj = null;
    try { obj = JSON.parse(r.content); } catch {
      const m = r.content.match(/\{[\s\S]*\}/);
      if (m) { try { obj = JSON.parse(m[0]); } catch { /* 保留原文 */ } }
    }
    // 自选选题包了一层 {topics:[...]}
    if (obj && req.params.feature === 'customtopic' && Array.isArray(obj.topics)) parsed = obj.topics;
    else if (obj) parsed = obj;
  } else if (feat.parse === 'lines') {
    parsed = String(r.content).split('\n').map(x => x.trim()).filter(Boolean).slice(0, 50);
  }

  // 落生成记录
  let title = '';
  try { title = feat.recordTitle(inputs); } catch { /* ignore */ }
  const info = db.prepare(`
    INSERT INTO gen_records(user_id,feature,title,inputs,output,model,tokens,duration_ms)
    VALUES(?,?,?,?,?,?,?,?)`)
    .run(req.user.id, req.params.feature, String(title || '').slice(0, 60),
      JSON.stringify(inputs), r.content, r.model, r.tokens, duration_ms);

  res.json({
    parsed,
    raw: r.content,
    model: r.model,
    tokens: r.tokens,
    duration_ms,
    record_id: Number(info.lastInsertRowid),
    cfg_source: cfg.source,
  });
});

// ---- 生成记录 ----
router.get('/records/list', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const size = Math.min(100, Math.max(1, Number(req.query.size) || 15));
  const feature = String(req.query.feature || '').trim();
  const favOnly = req.query.fav === '1';
  const kw = String(req.query.kw || '').trim();

  let where = 'WHERE user_id=?';
  const args = [req.user.id];
  if (feature && FEATURES[feature]) { where += ' AND feature=?'; args.push(feature); }
  if (favOnly) where += ' AND fav=1';
  if (kw) { where += ' AND (title LIKE ? OR output LIKE ?)'; args.push(`%${kw}%`, `%${kw}%`); }

  const total = db.prepare(`SELECT COUNT(*) c FROM gen_records ${where}`).get(...args).c;
  const rows = db.prepare(`
    SELECT id,feature,title,model,tokens,duration_ms,fav,created_at,
           length(output) out_len, substr(output,1,120) preview
    FROM gen_records ${where}
    ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, size, (page - 1) * size);
  res.json({ total, page, size, rows });
});

// 导出 Excel（xlsx，当前筛选条件下的记录，上限 1 万条）
router.get('/records/export', (req, res) => {
  const feature = String(req.query.feature || '').trim();
  const favOnly = req.query.fav === '1';
  const kw = String(req.query.kw || '').trim();

  let where = 'WHERE user_id=?';
  const args = [req.user.id];
  if (feature && FEATURES[feature]) { where += ' AND feature=?'; args.push(feature); }
  if (favOnly) where += ' AND fav=1';
  if (kw) { where += ' AND (title LIKE ? OR output LIKE ?)'; args.push(`%${kw}%`, `%${kw}%`); }

  const rows = db.prepare(`SELECT id,feature,title,output,model,tokens,duration_ms,fav,created_at
    FROM gen_records ${where} ORDER BY id DESC LIMIT 10000`).all(...args);
  const label = f => (FEATURES[f] ? FEATURES[f].label : f === 'hot_ai' ? 'AI智能选题' : f);
  const data = [
    ['ID', '功能', '标题', '生成内容', '模型', 'Tokens', '耗时(秒)', '收藏', '时间'],
    ...rows.map(r => [
      r.id, label(r.feature), r.title, r.output, r.model || '', r.tokens || '',
      r.duration_ms ? (r.duration_ms / 1000).toFixed(1) : '',
      r.fav ? '是' : '', String(r.created_at || '').replace('T', ' ').slice(0, 19),
    ]),
  ];
  const buf = buildXlsx('生成记录', data);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('生成记录.xlsx')}`);
  res.send(buf);
});

router.get('/records/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM gen_records WHERE id=? AND user_id=?')
    .get(Number(req.params.id), req.user.id);
  if (!row) return res.status(404).json({ error: '记录不存在' });
  try { row.inputs = JSON.parse(row.inputs); } catch { /* 保留 */ }
  res.json({ record: row });
});

router.put('/records/:id/fav', (req, res) => {
  const r = db.prepare('UPDATE gen_records SET fav = 1-fav WHERE id=? AND user_id=?')
    .run(Number(req.params.id), req.user.id);
  if (!r.changes) return res.status(404).json({ error: '记录不存在' });
  const row = db.prepare('SELECT id,fav FROM gen_records WHERE id=?').get(Number(req.params.id));
  res.json({ ok: true, fav: row.fav });
});

router.delete('/records/:id', (req, res) => {
  const r = db.prepare('DELETE FROM gen_records WHERE id=? AND user_id=?')
    .run(Number(req.params.id), req.user.id);
  if (!r.changes) return res.status(404).json({ error: '记录不存在' });
  res.json({ ok: true });
});

module.exports = { router };
