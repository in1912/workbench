// AI 数据脱敏 API（v1.13.0）——效率工具页「AI脱敏」tab 用；引擎在 services/desensitizeService.js。
//
//   GET    /desensitize/meta        类型目录 + 当前配置（tab 首屏）
//   GET    /desensitize/config      当前配置
//   PUT    /desensitize/config      保存配置
//   POST   /desensitize/preview     试运行：{text} → {masked, mapping}（并落一条 scope='manual' 历史）
//   GET    /desensitize/history     对照历史（?limit= & ?scope=）
//   DELETE /desensitize/history/:id 删一条
//   DELETE /desensitize/history     清空（?scope= 可按来源清）
//
// 权限：pageForPath('/desensitize') → tools；TAB_PATHS.tools 的 'desens' 键 = /desensitize（见 auth.js）。
// IM复盘 / 笔记AI 两处接入不经这里，直接在各自服务/路由里调引擎——所以它们只受各自页权限约束，
// 不要求调用者另有 tools 权限。
const express = require('express');
const svc = require('../services/desensitizeService');

const router = express.Router();

function ok(fn) {
  return (req, res, next) => {
    try {
      const r = fn(req, res, next);
      if (r && typeof r.then === 'function') r.catch((e) => fail(res, e));
    } catch (e) { fail(res, e); }
  };
}
function fail(res, e) {
  if (res.headersSent) return;
  if (e && e.code === 400) return res.status(400).json({ error: e.message });
  if (e && e.code === 404) return res.status(404).json({ error: e.message });
  console.error('[desensitize] 失败:', (e && e.message) || e);
  res.status(500).json({ error: (e && e.message) || '服务器内部错误' });
}
function bad(msg) { const e = new Error(msg); e.code = 400; throw e; }

// tab 首屏：类型目录 + 配置（一次拿全，前端不用分两次请求）
router.get('/desensitize/meta', ok((req, res) => {
  res.json({ types: svc.TYPES, config: svc.getConfig(req.tdb) });
}));

router.get('/desensitize/config', ok((req, res) => {
  res.json(svc.getConfig(req.tdb));
}));

router.put('/desensitize/config', ok((req, res) => {
  const b = req.body || {};
  const patch = {};
  if (b.enabled !== undefined) patch.enabled = !!b.enabled;
  if (b.mask_numbers !== undefined) patch.mask_numbers = !!b.mask_numbers;
  if (b.types !== undefined) {
    if (!b.types || typeof b.types !== 'object' || Array.isArray(b.types)) bad('types 必须是对象');
    patch.types = b.types;
  }
  if (b.fixed_terms !== undefined) {
    if (!Array.isArray(b.fixed_terms)) bad('fixed_terms 必须是数组');
    patch.fixed_terms = b.fixed_terms;
  }
  if (b.aggressive !== undefined) patch.aggressive = String(b.aggressive || 'balanced');
  res.json(svc.saveConfig(req.tdb, patch));
}));

// 试运行：只脱敏、不调 AI。用当前配置，也允许本次局部覆盖（试不同类型/数值开关的效果）。
router.post('/desensitize/preview', ok((req, res) => {
  const b = req.body || {};
  const text = String(b.text || '');
  if (!text.trim()) bad('请输入要试运行的文本');
  if (text.length > 200000) bad('文本过长（上限 20 万字符）');
  const opts = svc.optionsFrom(req.tdb, {
    types: b.types && typeof b.types === 'object' ? b.types : undefined,
    mask_numbers: b.mask_numbers === undefined ? undefined : !!b.mask_numbers,
  });
  const { masked, mapping, count } = svc.encode(text, opts);
  const cfg = svc.getConfig(req.tdb);
  // 只有配置里主开关是关的、又是在 tab 里手动试运行——仍然记历史（用户要「每次调用脱敏的对照历史」）
  const id = svc.record(req.tdb, {
    scope: 'manual', ref: '', userId: req.user && req.user.id,
    mapping, maskedPreview: masked, status: count ? 'done' : 'empty',
  });
  res.json({ id, masked, mapping, count, mask_numbers: !!cfg.mask_numbers });
}));

router.get('/desensitize/history', ok((req, res) => {
  const scope = String(req.query.scope || '');
  res.json({ items: svc.listHistory(req.tdb, { limit: req.query.limit, scope }) });
}));

router.get('/desensitize/history/:id', ok((req, res) => {
  const row = svc.getHistory(req.tdb, req.params.id);
  if (!row) { const e = new Error('历史不存在'); e.code = 404; throw e; }
  res.json(row);
}));

router.delete('/desensitize/history/:id', ok((req, res) => {
  res.json({ removed: svc.deleteHistory(req.tdb, req.params.id) });
}));

router.delete('/desensitize/history', ok((req, res) => {
  res.json({ removed: svc.clearHistory(req.tdb, String(req.query.scope || '')) });
}));

module.exports = router;
