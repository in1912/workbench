// 心愿卡：产品看板 + 每日打卡（每人每天最多 2 次、每产品每天 1 次）+ 产品设置。
// 权限：浏览与打卡随学习页 wish tab；产品增删改 /wish/manage* 是受限端点（wishset，显式授权）。
const express = require('express');
const { db } = require('../db');
const router = express.Router();

const DAILY_LIMIT = 2;
const todayStr = () => new Date().toLocaleDateString('sv').slice(0, 10);

// ---------- 产品看板（含累计心愿值与今日打卡状态） ----------
// 图片归一化：image_ids 数组为准（封面排首位），旧单图 image_id 自动升级为单元素数组
function normImages(p) {
  let imgs = [];
  try { imgs = JSON.parse(p.image_ids || '[]'); } catch { /* 容错 */ }
  if (!Array.isArray(imgs)) imgs = [];
  if (!imgs.length && p.image_id) imgs = [p.image_id];
  const cover = p.cover_id && imgs.includes(p.cover_id) ? p.cover_id : (imgs[0] || 0);
  return { images: cover ? [cover, ...imgs.filter((i) => i !== cover)] : [], cover_id: cover || null };
}

router.get('/wish/products', (req, res) => {
  const today = todayStr();
  const products = db.prepare('SELECT * FROM wish_products ORDER BY id DESC').all();
  const cnt = db.prepare('SELECT product_id, COUNT(*) c FROM wish_checkins GROUP BY product_id').all();
  const cntMap = new Map(cnt.map((r) => [r.product_id, r.c]));
  const mine = db.prepare('SELECT product_id, COUNT(*) c FROM wish_checkins WHERE user_id=? GROUP BY product_id').all(req.user.id);
  const mineMap = new Map(mine.map((r) => [r.product_id, r.c]));
  const todayRows = db.prepare('SELECT product_id FROM wish_checkins WHERE user_id=? AND day=?').all(req.user.id, today);
  const todaySet = new Set(todayRows.map((r) => r.product_id));
  res.json({
    daily_limit: DAILY_LIMIT,
    my_today_count: todayRows.length,
    products: products.map((p) => {
      const img = normImages(p);
      return {
        ...p,
        ...img,
        image_id: img.cover_id,              // 兼容旧字段：恒等于封面
        wish_value: cntMap.get(p.id) || 0,   // 心愿值 = 该产品累计打卡次数（全家合力）
        my_checkins: mineMap.get(p.id) || 0,
        checked_today: todaySet.has(p.id),
      };
    }),
  });
});

// ---------- 打卡（每产品每人每天 1 次；每人每天全产品最多 2 次） ----------
router.post('/wish/checkin', (req, res) => {
  const pid = Number((req.body || {}).product_id) || 0;
  const p = db.prepare('SELECT id FROM wish_products WHERE id=?').get(pid);
  if (!p) return res.status(404).json({ error: '产品不存在' });
  const today = todayStr();
  const mineToday = db.prepare('SELECT COUNT(*) c FROM wish_checkins WHERE user_id=? AND day=?').get(req.user.id, today).c;
  if (mineToday >= DAILY_LIMIT)
    return res.status(400).json({ error: `今日已打卡 ${mineToday} 次，每天最多 ${DAILY_LIMIT} 次` });
  const dup = db.prepare('SELECT id FROM wish_checkins WHERE product_id=? AND user_id=? AND day=?').get(pid, req.user.id, today);
  if (dup) return res.status(400).json({ error: '该产品今天已打过卡，明天再来' });
  const u = db.prepare('SELECT display_name, nickname, username FROM users WHERE id=?').get(req.user.id);
  const name = (u && (u.display_name || u.nickname || u.username)) || `用户#${req.user.id}`;
  db.prepare('INSERT INTO wish_checkins(product_id, user_id, user_name, day) VALUES(?,?,?,?)')
    .run(pid, req.user.id, name, today);
  const wishValue = db.prepare('SELECT COUNT(*) c FROM wish_checkins WHERE product_id=?').get(pid).c;
  res.json({ ok: true, wish_value: wishValue, my_today_count: mineToday + 1 });
});

// ---------- 产品设置（受限：wishset） ----------
const MAX_IMAGES = 9;
function pickProduct(b) {
  const out = {
    name: String(b.name || '').trim().slice(0, 100),
    description: String(b.description || '').slice(0, 500),
    note: String(b.note || '').slice(0, 300),
  };
  const mp = Number(b.market_price);
  const fp = Number(b.family_price);
  out.market_price = Number.isFinite(mp) && mp >= 0 ? Math.round(mp * 100) / 100 : 0;
  out.family_price = Number.isFinite(fp) && fp >= 0 ? Math.round(fp * 100) / 100 : 0;
  // 多图：image_ids 数组为准，兼容旧单图 image_id；逐个校验存在、去重、上限 MAX_IMAGES
  let ids = Array.isArray(b.image_ids) ? b.image_ids.map(Number) : [];
  if (!ids.length && Number(b.image_id)) ids = [Number(b.image_id)];
  const valid = [];
  for (const id of ids) {
    if (id > 0 && !valid.includes(id) && valid.length < MAX_IMAGES
      && db.prepare('SELECT id FROM family_images WHERE id=?').get(id)) valid.push(id);
  }
  let cover = Number(b.cover_id) || 0;
  if (!valid.includes(cover)) cover = valid[0] || 0;
  out.image_ids = valid.length ? JSON.stringify(valid) : '';
  out.cover_id = cover || null;
  out.image_id = cover || null; // 旧字段兼容：封面同步写 image_id
  return out;
}

router.post('/wish/manage', (req, res) => {
  const p = pickProduct(req.body || {});
  if (!p.name) return res.status(400).json({ error: '请填写产品名称' });
  const info = db.prepare(`INSERT INTO wish_products(name, description, market_price, family_price, note, image_id, image_ids, cover_id, created_by)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(p.name, p.description, p.market_price, p.family_price, p.note, p.image_id, p.image_ids, p.cover_id, req.user.id);
  res.json({ ok: true, id: Number(info.lastInsertRowid) });
});

router.put('/wish/manage/:id', (req, res) => {
  const row = db.prepare('SELECT id FROM wish_products WHERE id=?').get(Number(req.params.id) || 0);
  if (!row) return res.status(404).json({ error: '产品不存在' });
  const p = pickProduct(req.body || {});
  if (!p.name) return res.status(400).json({ error: '请填写产品名称' });
  db.prepare(`UPDATE wish_products SET name=?, description=?, market_price=?, family_price=?, note=?, image_id=?, image_ids=?, cover_id=? WHERE id=?`)
    .run(p.name, p.description, p.market_price, p.family_price, p.note, p.image_id, p.image_ids, p.cover_id, row.id);
  res.json({ ok: true });
});

// 删除产品（连带打卡记录；admin 或创建人）
router.delete('/wish/manage/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM wish_products WHERE id=?').get(Number(req.params.id) || 0);
  if (!row) return res.status(404).json({ error: '产品不存在' });
  if (req.user.role !== 'admin' && row.created_by !== req.user.id)
    return res.status(403).json({ error: '仅管理员或创建人可删除' });
  db.prepare('DELETE FROM wish_checkins WHERE product_id=?').run(row.id);
  db.prepare('DELETE FROM wish_products WHERE id=?').run(row.id);
  res.json({ ok: true });
});

module.exports = router;
