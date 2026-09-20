const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { db, dataDir, getSetting, setSetting } = require('../db');

// 电子宠物：跨用户共同养育，全部数据落主库（与会话/消息一致）。
// 状态全部惰性计算（读取/动作时推进），无需定时任务：
//   粪便 = 距上次基准每 poop_interval_hours 生成一块（上限 POOP_CAP，防止堆爆）
//   生病 = 连续 sick_days 天没喂饭也没喂水 → 全体成员好感度 -1，画面转背面
//   粪便超标 = 存活 > threshold 块后每维持 1 小时全体成员 -0.02
const router = express.Router();

const SPECIES = ['dog', 'cat', 'elephant', 'kangaroo', 'tiger', 'lion', 'pig', 'sheep', 'bear', 'custom'];
const FOODS = ['rice', 'snack', 'banana', 'apple'];       // 喂食物（与喂水分开冷却/计数）
const PLAYS = ['yarn', 'blocks', 'train', 'cooking'];     // 陪玩内容
const POOP_CAP = 60;                                      // 场上粪便上限
const GIF_DIR = path.join(dataDir, 'pet-gifs');

// ---------- 时间工具（库内统一 localtime 字符串，解析也按本地时区） ----------
function nowLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function fmt(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
const parse = (s) => (s ? Date.parse(String(s).replace(' ', 'T')) : NaN);
const todayStr = () => nowLocal().slice(0, 10);
// 本地时区日期（Date.toISOString 是 UTC，临近午夜会与 localtime 日期错位）
function dayOf(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- 全局配置（settings 键 pet_config，主库） ----------
const DEFAULT_CONFIG = {
  poop_interval_hours: 3,     // 粪便生成间隔（小时，可改）
  feed_daily_limit: 3,        // 每用户每天喂食物（饭/零食/水果合计）上限
  feed_cooldown_hours: 3,     // 两次喂食物最小间隔（对宠物全局生效，防共同养育重复投喂）
  water_daily_limit: 3,       // 每用户每天喂水上限
  water_cooldown_hours: 3,    // 两次喂水最小间隔
  play_daily_limit: 5,        // 每用户每天玩耍上限
  typing_daily_limit: 3,      // 打字互动：每用户每天每类（喂饭/喂水/零食/玩耍）额外次数上限（不占按钮次数）
  sick_days: 3,               // 连续 N 天没喂饭也没喂水 → 生病
  sick_death_threshold: 50,   // 累计生病 N 个回合 → 去世（每生病→吃药恢复算 1 回合）
  starve_death_days: 60,      // 超过 N 天没喂饭 → 去世
  growth_days: 14,            // 每 N 天长一圈像素
  max_rings: 6,               // 成长圈数上限
  poop_penalty_threshold: 3,  // 粪便超过 N 块开始按小时扣好感度
  affection: { rice: 0.01, water: 0.01, snack: 0.02, banana: 0.02, apple: 0.02, play: 0.03, checkin: 0.01, sick: -1, poop_hour: -0.02 },
};
function getConfig() {
  const saved = getSetting(db, 'pet_config', {}) || {};
  const out = { ...DEFAULT_CONFIG, ...saved, affection: { ...DEFAULT_CONFIG.affection, ...(saved.affection || {}) } };
  for (const k of ['poop_interval_hours', 'feed_cooldown_hours', 'water_cooldown_hours', 'sick_days', 'growth_days']) {
    out[k] = Math.min(365, Math.max(0.05, Number(out[k]) || DEFAULT_CONFIG[k]));
  }
  for (const k of ['feed_daily_limit', 'water_daily_limit', 'play_daily_limit', 'typing_daily_limit', 'max_rings', 'poop_penalty_threshold']) {
    out[k] = Math.min(50, Math.max(1, Math.floor(Number(out[k]) || DEFAULT_CONFIG[k])));
  }
  out.sick_death_threshold = Math.min(10000, Math.max(1, Math.floor(Number(out.sick_death_threshold) || DEFAULT_CONFIG.sick_death_threshold)));
  out.starve_death_days = Math.min(3650, Math.max(1, Number(out.starve_death_days) || DEFAULT_CONFIG.starve_death_days));
  return out;
}
router.get('/pets/config', (req, res) => res.json(getConfig()));

// 桌面宠物配置（登录态）必须注册在 PUT /pets/:id 之前——否则 'desktop-config' 会被当作 :id 吞掉
//（同 /pets/members 的坑；依赖的 petDesktopPref/frameVer 等定义在文件后段，调用时已加载完毕）
router.get('/pets/desktop-config', (req, res) => {
  const pref = petDesktopPref(req.user.id);
  const cfg = getConfig();
  const pets = myPets(req.user).map((p) => {
    const ageDays = Math.max(0, ((p.is_dead ? parse(p.dead_at) : Date.now()) || Date.now()) - (parse(p.created_at) || Date.now())) / 86400000;
    const hasGif = p.species === 'custom' && !!p.custom_gif;
    return {
      id: p.id, name: p.name, species: p.species, variant: p.variant || 0, has_gif: hasGif,
      rings: Math.min(cfg.max_rings, Math.floor(ageDays / cfg.growth_days)),
    };
  });
  res.json({
    enabled: !!pref.enabled, key: pref.key || '', pet_id: pref.pet_id || null,
    scale: Number(pref.scale) || 1, // 桌面显示比例（1 = 基准尺寸 = 原始帧的 60%）
    pets,
    frames_ready: pets.some((p) => p.has_gif || frameVer(p.id) > 0),
  });
});
router.put('/pets/desktop-config', (req, res) => {
  const pref = petDesktopPref(req.user.id);
  const next = { ...pref };
  if ('enabled' in req.body) next.enabled = req.body.enabled ? 1 : 0;
  if (next.enabled && !next.key) next.key = crypto.randomBytes(16).toString('hex');
  if ('pet_id' in req.body) {
    if (req.body.pet_id === null || req.body.pet_id === undefined || req.body.pet_id === '') {
      next.pet_id = null; // 未选择宠物：允许只切开关（桌面端显示「未找到宠物」），不再按非法选择报错
    } else {
      const pet = db.prepare('SELECT * FROM pets WHERE id=?').get(Number(req.body.pet_id));
      if (!pet || !canSee(pet, req.user)) return res.status(400).json({ error: '无权选择该宠物' });
      next.pet_id = pet.id;
    }
  }
  // 桌面显示比例：0.5~2（1 = 基准 = 原始帧 60%；用户嫌原尺寸大、50% 又小，定格 60% 为基准）
  if ('scale' in req.body) {
    const s = Number(req.body.scale);
    if (Number.isFinite(s) && s >= 0.5 && s <= 2) next.scale = Math.round(s * 100) / 100;
  }
  setPetDesktopPref(req.user.id, next);
  res.json({ ok: true, enabled: !!next.enabled, key: next.key || '', pet_id: next.pet_id || null, scale: Number(next.scale) || 1 });
});

// 桌面端互动同样必须先于 POST /pets/:id/action 注册（'desktop' 否则被当作 :id）
router.post('/pets/desktop/action', (req, res) => {
  const user = desktopUserByKey(req.query.key);
  if (!user) return res.status(403).json({ error: 'bad key' });
  const pet = db.prepare('SELECT * FROM pets WHERE id=?').get(Number(req.body && req.body.pet));
  if (!pet || !canSee(pet, user)) return res.status(404).json({ error: '宠物不存在' });
  if (pet.is_dead) return res.status(400).json({ error: '它已经去世了，愿它在彩虹的另一头安好 🌈' });
  const cfg = getConfig();
  const st = refreshPet(pet.id, cfg);
  if (db.prepare('SELECT is_dead FROM pets WHERE id=?').get(pet.id).is_dead)
    return res.status(400).json({ error: '它刚刚去世了…愿它在彩虹的另一头安好 🌈' });
  const kind = String((req.body && req.body.action) || '');
  const today = todayStr();
  const cnt = (actions) => db.prepare(
    `SELECT COUNT(*) c FROM pet_logs WHERE pet_id=? AND user_id=? AND date(created_at)=? AND action IN (${actions.map(() => '?').join(',')})`
  ).get(pet.id, user.id, today, ...actions).c;
  const cool = (at, hours) => { if (!at) return 0; const left = parse(at) + hours * 3600000 - Date.now(); return left > 0 ? Math.ceil(left / 1000) : 0; };
  db.prepare('INSERT OR IGNORE INTO pet_stats(pet_id,user_id) VALUES(?,?)').run(pet.id, user.id);
  try {
    if (kind === 'food') {
      if (st.sick_at) return res.status(400).json({ error: '宠物生病了，先在网页里喂它吃药吧' });
      if (cool(st.last_food_at, cfg.feed_cooldown_hours) > 0) return res.status(400).json({ error: '刚吃饱啦，等一会儿再喂' });
      if (cnt(['food']) >= cfg.feed_daily_limit) return res.status(400).json({ error: '今天的喂食次数已用完' });
      db.prepare("UPDATE pet_state SET last_food_at=datetime('now','localtime') WHERE pet_id=?").run(pet.id);
      addAffection(pet.id, user.id, cfg.affection.rice, 'food', 'rice');
      db.prepare('UPDATE pet_stats SET fed=fed+1, scoop_credits=scoop_credits+3 WHERE pet_id=? AND user_id=?').run(pet.id, user.id);
    } else if (kind === 'water') {
      if (st.sick_at) return res.status(400).json({ error: '宠物生病了，先在网页里喂它吃药吧' });
      if (cool(st.last_water_at, cfg.water_cooldown_hours) > 0) return res.status(400).json({ error: '刚喝过水啦，等一会儿再喂' });
      if (cnt(['water']) >= cfg.water_daily_limit) return res.status(400).json({ error: '今天的喂水次数已用完' });
      db.prepare("UPDATE pet_state SET last_water_at=datetime('now','localtime') WHERE pet_id=?").run(pet.id);
      addAffection(pet.id, user.id, cfg.affection.water, 'water', 'water');
      db.prepare('UPDATE pet_stats SET waters=waters+1 WHERE pet_id=? AND user_id=?').run(pet.id, user.id);
    } else if (kind === 'play') {
      if (st.sick_at) return res.status(400).json({ error: '宠物生病了没心情玩，先在网页里喂它吃药吧' });
      if (cnt(['play']) >= cfg.play_daily_limit) return res.status(400).json({ error: '今天的玩耍次数已用完' });
      addAffection(pet.id, user.id, cfg.affection.play, 'play', 'yarn');
      db.prepare('UPDATE pet_stats SET plays=plays+1 WHERE pet_id=? AND user_id=?').run(pet.id, user.id);
    } else {
      return res.status(400).json({ error: '未知动作' });
    }
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.put('/pets/config', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '宠物时间/频率参数由管理员统一配置' });
  const cur = getConfig();
  const next = { ...cur };
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (k === 'affection') continue;
    if (req.body[k] !== undefined) next[k] = Number(req.body[k]);
  }
  if (req.body.affection && typeof req.body.affection === 'object') {
    next.affection = { ...cur.affection };
    for (const k of Object.keys(DEFAULT_CONFIG.affection)) {
      if (req.body.affection[k] !== undefined) next.affection[k] = Number(req.body.affection[k]);
    }
  }
  setSetting(db, 'pet_config', next);
  res.json(getConfig());
});

// ---------- 权限 ----------
function canManage(pet, user) { return user.role === 'admin' || pet.owner_id === user.id; }
function canSee(pet, user) {
  if (canManage(pet, user)) return true;
  if (pet.raise_mode === 'personal') return false; // 他人个人宠物不可见
  return !!db.prepare('SELECT 1 FROM pet_members WHERE pet_id=? AND user_id=?').get(pet.id, user.id);
}
function myPets(user) {
  return db.prepare('SELECT * FROM pets ORDER BY id').all().filter((p) => canSee(p, user));
}

// ---------- 好感度 ----------
function addAffection(petId, userId, delta, action, detail, typed) {
  if (!delta) return;
  db.prepare('INSERT OR IGNORE INTO pet_stats(pet_id,user_id) VALUES(?,?)').run(petId, userId);
  const cur = db.prepare('SELECT affection FROM pet_stats WHERE pet_id=? AND user_id=?').get(petId, userId);
  const next = Math.max(0, Math.round((cur.affection + delta) * 10000) / 10000); // 好感度下限 0
  db.prepare('UPDATE pet_stats SET affection=? WHERE pet_id=? AND user_id=?').run(next, petId, userId);
  db.prepare('INSERT INTO pet_logs(pet_id,user_id,action,detail,affection_delta,typed) VALUES(?,?,?,?,?,?)')
    .run(petId, userId, action, detail || '', delta, typed ? 1 : 0);
}
function addAffectionAll(petId, delta, action, detail) {
  for (const m of db.prepare('SELECT user_id FROM pet_members WHERE pet_id=?').all(petId)) {
    addAffection(petId, m.user_id, delta, action, detail);
  }
}

// ---------- 死亡：随机悼词 + 落库（保留为墓碑记录，管理员/主人可删） ----------
const EULOGIES = [
  (n) => `${n}去了彩虹的那一头。谢谢你陪它走过的每一天，愿它在云朵上继续打滚撒娇。`,
  (n) => `${n}睡着了，这一次再也不会饿肚子。它会记得每一个喂过它、陪它玩过的人。`,
  (n) => `小小的身体，装满了大家满满的爱。${n}，一路走好。`,
  (n) => `${n}化作了夜空里的一颗星，抬头就能看见它在摇尾巴。`,
  (n) => `这里长眠着一个被爱包围的小家伙。${n}，我们永远想你。`,
  (n) => `${n}的碗空了，回忆却是满的。谢谢你来过，再见啦。`,
  (n) => `${n}跑完了它小小的、认真的一生。愿另一个世界有吃不完的饭和玩不完的毛线球。`,
  (n) => `风吹过草坪的时候，那是${n}在打招呼。它过得很好，别担心。`,
  (n) => `${n}离开了，但每一次摸头、每一顿饭、每一场游戏，都留在了大家心里。`,
  (n) => `再见，${n}。你是我们养过最棒的小家伙。`,
];
function diePet(pet, cause, cfg) {
  const eulogy = EULOGIES[Math.floor(Math.random() * EULOGIES.length)](pet.name);
  const detail = cause === 'sick'
    ? `累计生病 ${cfg.sick_death_threshold} 个回合，医治无效，安详离世`
    : `超过 ${cfg.starve_death_days} 天没喂饭，饥饿离世`;
  const r = db.prepare('UPDATE pets SET is_dead=1, dead_at=?, death_cause=?, death_eulogy=? WHERE id=? AND is_dead=0')
    .run(nowLocal(), cause, eulogy, pet.id);
  if (r.changes) {
    db.prepare('INSERT INTO pet_logs(pet_id,user_id,action,detail) VALUES(?,?,?,?)').run(pet.id, pet.owner_id, 'death', detail);
    db.prepare('DELETE FROM pet_poops WHERE pet_id=?').run(pet.id); // 墓碑不留粪：清掉死亡当次刷新先生成的粪便
  }
}

// ---------- 惰性状态推进（粪便生成 / 生病判定 / 粪便超标惩罚 / 死亡判定） ----------
function refreshPet(petId, cfg) {
  let pet = db.prepare('SELECT * FROM pets WHERE id=?').get(petId);
  let st = db.prepare('SELECT * FROM pet_state WHERE pet_id=?').get(petId);
  if (!st) return null;
  if (pet.is_dead) return st; // 已去世：状态冻结，不再生成粪便/生病/扣好感
  const now = Date.now();
  // 1) 粪便生成：每 interval 一块，超出上限的份额只推进基准不补偿生成
  const intervalMs = cfg.poop_interval_hours * 3600000;
  let base = parse(st.poop_base_at);
  if (!Number.isFinite(base)) { base = now; db.prepare('UPDATE pet_state SET poop_base_at=? WHERE pet_id=?').run(nowLocal(), petId); }
  const due = Math.floor((now - base) / intervalMs);
  if (due > 0) {
    const alive = db.prepare('SELECT COUNT(*) c FROM pet_poops WHERE pet_id=?').get(petId).c;
    const n = Math.min(due, Math.max(0, POOP_CAP - alive));
    const ins = db.prepare('INSERT INTO pet_poops(pet_id) VALUES(?)');
    for (let i = 0; i < n; i++) ins.run(petId);
    db.prepare('UPDATE pet_state SET poop_base_at=?, poop_generated=poop_generated+? WHERE pet_id=?')
      .run(fmt(base + due * intervalMs), n, petId);
  }
  st = db.prepare('SELECT * FROM pet_state WHERE pet_id=?').get(petId);
  // 2) 生病判定：连续 sick_days 天没喂饭也没喂水（未喂过时以创建时间起算，防新宠立即生病）
  //    每个回合（生病→吃药恢复→再生病）累计 sick_count +1，累计到阈值即离世
  if (!st.sick_at) {
    const nowS = Date.now();
    const bornAt = parse(pet.created_at) || nowS;
    const noFood = (nowS - (parse(st.last_food_at) || bornAt)) >= cfg.sick_days * 86400000;
    const noWater = (nowS - (parse(st.last_water_at) || bornAt)) >= cfg.sick_days * 86400000;
    if (noFood && noWater) {
      db.prepare("UPDATE pet_state SET sick_at=datetime('now','localtime'), sick_count=sick_count+1 WHERE pet_id=?").run(petId);
      addAffectionAll(petId, cfg.affection.sick, 'sick', `连续 ${cfg.sick_days} 天没吃没喝，生病了`);
    }
  }
  // 3) 粪便超标：存活 > threshold 后每维持 1 小时，全体成员好感度按小时扣
  const alive = db.prepare('SELECT COUNT(*) c FROM pet_poops WHERE pet_id=?').get(petId).c;
  let pAt = parse(st.poop_penalty_at);
  if (!Number.isFinite(pAt)) { pAt = Date.now(); db.prepare('UPDATE pet_state SET poop_penalty_at=? WHERE pet_id=?').run(nowLocal(), petId); }
  if (alive > cfg.poop_penalty_threshold) {
    const hrs = Math.floor((Date.now() - pAt) / 3600000);
    if (hrs > 0) {
      addAffectionAll(petId, cfg.affection.poop_hour * hrs, 'poop_penalty', `粪便堆积 ${alive} 块，维持 ${hrs} 小时`);
      db.prepare('UPDATE pet_state SET poop_penalty_at=? WHERE pet_id=?').run(fmt(pAt + hrs * 3600000), petId);
    }
  } else {
    db.prepare('UPDATE pet_state SET poop_penalty_at=? WHERE pet_id=?').run(nowLocal(), petId);
  }
  // 4) 死亡判定：累计生病回合数达阈值（久病） 或 超过 starve_death_days 天没喂饭（饥饿；吃药会刷新 last_food_at）
  st = db.prepare('SELECT * FROM pet_state WHERE pet_id=?').get(petId);
  const bornAt = parse(pet.created_at) || Date.now();
  const foodAt = parse(st.last_food_at) || bornAt;
  if ((st.sick_count || 0) >= cfg.sick_death_threshold) diePet(pet, 'sick', cfg);
  else if ((Date.now() - foodAt) / 86400000 >= cfg.starve_death_days) diePet(pet, 'starve', cfg);
  return st;
}

// ---------- 视图组装 ----------
function petView(pet, user, cfg) {
  const st = refreshPet(pet.id, cfg) || {};
  pet = db.prepare('SELECT * FROM pets WHERE id=?').get(pet.id) || pet; // 推进过程中可能刚触发死亡，重取最新行
  const created = parse(pet.created_at) || Date.now();
  const dead = !!pet.is_dead;
  // 去世后年龄冻结在离世当天
  const ageDays = Math.max(0, ((dead ? parse(pet.dead_at) : Date.now()) || Date.now()) - created) / 86400000;
  const rings = Math.min(cfg.max_rings, Math.floor(ageDays / cfg.growth_days));
  const poops = dead ? [] : db.prepare('SELECT id, created_at FROM pet_poops WHERE pet_id=? ORDER BY id').all(pet.id);
  const today = todayStr();
  const todayCount = (actions) => db.prepare(
    `SELECT COUNT(*) c FROM pet_logs WHERE pet_id=? AND user_id=? AND date(created_at)=? AND action IN (${actions.map(() => '?').join(',')})`
  ).get(pet.id, user.id, today, ...actions).c;
  const stat = db.prepare('SELECT * FROM pet_stats WHERE pet_id=? AND user_id=?').get(pet.id, user.id) || { affection: 0, scoop_credits: 0, fed: 0, waters: 0, snacks: 0, plays: 0, scooped: 0, medicines: 0 };
  // 今日打字互动各类已用次数（与按钮次数分开统计）
  const typedCnt = (action, detail) => db.prepare(
    'SELECT COUNT(*) c FROM pet_logs WHERE pet_id=? AND user_id=? AND date(created_at)=? AND action=? AND detail=? AND typed=1'
  ).get(pet.id, user.id, today, action, detail).c;
  // 冷却剩余秒数
  const cool = (at, hours) => {
    if (!at) return 0;
    const left = parse(at) + hours * 3600000 - Date.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  };
  const owner = db.prepare('SELECT username, display_name FROM users WHERE id=?').get(pet.owner_id);
  return {
    id: pet.id, name: pet.name, species: pet.species, variant: pet.variant || 0,
    raise_mode: pet.raise_mode, owner_id: pet.owner_id,
    owner_name: owner ? (owner.display_name || owner.username) : '',
    has_gif: pet.species === 'custom' && !!pet.custom_gif,
    created_at: pet.created_at, age_days: Math.floor(ageDays), rings,
    sick: !!st.sick_at && !dead, sick_at: st.sick_at || null,
    sick_count: st.sick_count || 0, sick_death_threshold: cfg.sick_death_threshold, starve_death_days: cfg.starve_death_days,
    is_dead: dead, dead_at: dead ? pet.dead_at : null,
    death_cause: dead ? (pet.death_cause || '') : '',
    death_text: dead ? (pet.death_cause === 'sick'
      ? `累计生病 ${cfg.sick_death_threshold} 个回合，医治无效，安详离世`
      : `超过 ${cfg.starve_death_days} 天没喂饭，饥饿离世`) : '',
    death_eulogy: dead ? (pet.death_eulogy || '') : '',
    last_food_at: st.last_food_at || null, last_water_at: st.last_water_at || null,
    poop_next_in: dead ? null : Math.max(0, Math.ceil((parse(st.poop_base_at) + cfg.poop_interval_hours * 3600000 - Date.now()) / 1000)),
    poops: poops.map((p) => p.id),
    member_count: db.prepare('SELECT COUNT(*) c FROM pet_members WHERE pet_id=?').get(pet.id).c + (pet.raise_mode === 'personal' ? 0 : 0),
    my: {
      affection: stat.affection, scoop_credits: stat.scoop_credits,
      today_food: todayCount(['food']), today_water: todayCount(['water']), today_play: todayCount(['play']),
      today_typed: { rice: typedCnt('food', 'rice'), snack: typedCnt('food', 'snack'), water: typedCnt('water', 'water'), play: typedCnt('play', 'yarn') },
      fed: stat.fed, waters: stat.waters, snacks: stat.snacks, plays: stat.plays, scooped: stat.scooped,
      food_cooldown: cool(st.last_food_at, cfg.feed_cooldown_hours),
      water_cooldown: cool(st.last_water_at, cfg.water_cooldown_hours),
    },
  };
}

// ---------- 状态总览（悬浮窗 + 宠物 tab 共用） ----------
router.get('/pets/state', (req, res) => {
  const cfg = getConfig();
  const pets = myPets(req.user).map((p) => petView(p, req.user, cfg));
  // 今日打卡与连续天数
  const today = todayStr();
  const checked = !!db.prepare('SELECT 1 FROM pet_checkins WHERE user_id=? AND day=?').get(req.user.id, today);
  let streak = 0;
  if (checked) {
    const days = new Set(db.prepare('SELECT day FROM pet_checkins WHERE user_id=?').all(req.user.id).map((r) => r.day));
    const d = new Date();
    while (days.has(dayOf(d))) { streak++; d.setDate(d.getDate() - 1); }
  }
  // 该用户保存的悬浮宠物位置（按住拖动后持久化，登录后恢复）
  let ui = null;
  try { ui = JSON.parse(db.prepare("SELECT value FROM user_prefs WHERE user_id=? AND key='pet_pos'").get(req.user.id)?.value || 'null'); } catch {}
  res.json({ config: cfg, pets, checkin: { today: checked, streak }, ui: ui && Number.isFinite(ui.right) ? ui : null });
});

// 悬浮宠物位置：每个用户各自保存（user_prefs.pet_pos）
router.put('/pets/ui-pos', (req, res) => {
  const r = Number(req.body && req.body.right), b = Number(req.body && req.body.bottom);
  if (!Number.isFinite(r) || !Number.isFinite(b)) return res.status(400).json({ error: '参数错误' });
  const val = JSON.stringify({ right: Math.max(0, Math.round(r)), bottom: Math.max(0, Math.round(b)) });
  db.prepare('INSERT INTO user_prefs(user_id,key,value) VALUES(?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value')
    .run(req.user.id, 'pet_pos', val);
  res.json({ ok: true });
});

// ---------- 新增宠物（multipart：可选 gif 文件） ----------
const gifFilter = (rq, file, cb) => {
  const ok = file.mimetype === 'image/gif' || /\.gif$/i.test(file.originalname);
  cb(ok ? null : new Error('只支持 GIF 动图'), ok);
};
const gifUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 }, fileFilter: gifFilter });
function saveGif(file) {
  if (!fs.existsSync(GIF_DIR)) fs.mkdirSync(GIF_DIR, { recursive: true });
  const name = `pet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.gif`;
  fs.writeFileSync(path.join(GIF_DIR, name), file.buffer);
  return name;
}

router.post('/pets', gifUpload.single('gif'), (req, res) => {
  const { name, species, variant, raise_mode } = req.body;
  const sp = SPECIES.includes(species) ? species : 'dog';
  let gif = '';
  if (sp === 'custom') {
    if (!req.file) return res.status(400).json({ error: '自定义宠物需上传 GIF 动图' });
    gif = saveGif(req.file);
  } else if (req.file) {
    gif = saveGif(req.file); // 普通种类也允许上传 gif 作为自定义形象
  }
  const mode = raise_mode === 'personal' ? 'personal' : 'shared';
  const r = db.prepare('INSERT INTO pets(name,species,variant,raise_mode,owner_id,custom_gif) VALUES(?,?,?,?,?,?)')
    .run(String(name || '').trim() || '宠物', sp, Number(variant) || 0, mode, req.user.id, gif);
  const id = Number(r.lastInsertRowid);
  db.prepare('INSERT INTO pet_members(pet_id,user_id) VALUES(?,?)').run(id, req.user.id);
  // last_food/water 留 NULL：新宠可立即投喂（冷却只对真实投喂计时），生病判定以创建时间兜底
  db.prepare('INSERT INTO pet_state(pet_id) VALUES(?)').run(id);
  res.json({ id });
});

// 成员分配：必须注册在 PUT /pets/:id 之前，否则 'members' 会被当作 :id 吞掉
router.put('/pets/members', (req, res) => {
  const pet = db.prepare('SELECT * FROM pets WHERE id=?').get(Number(req.body.pet_id) || 0);
  if (!pet) return res.status(404).json({ error: '宠物不存在' });
  if (req.user.role !== 'admin' && pet.owner_id !== req.user.id)
    return res.status(403).json({ error: '只有管理员或创建者可以分配' });
  const ids = Array.isArray(req.body.user_ids) ? req.body.user_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [];
  if (!ids.includes(pet.owner_id)) ids.push(pet.owner_id); // 创建者必须保留
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM pet_members WHERE pet_id=?').run(pet.id);
    const ins = db.prepare('INSERT OR IGNORE INTO pet_members(pet_id,user_id) VALUES(?,?)');
    for (const uid of ids) ins.run(pet.id, uid);
  });
  tx();
  res.json({ ok: true });
});

router.put('/pets/:id', (req, res) => {
  const pet = db.prepare('SELECT * FROM pets WHERE id=?').get(req.params.id);
  if (!pet) return res.status(404).json({ error: '宠物不存在' });
  if (!canManage(pet, req.user)) return res.status(403).json({ error: '只有创建者或管理员可以修改' });
  const { name, raise_mode } = req.body;
  db.prepare('UPDATE pets SET name=?, raise_mode=? WHERE id=?').run(
    name !== undefined ? String(name).trim() : pet.name,
    raise_mode === 'personal' ? 'personal' : (raise_mode === 'shared' ? 'shared' : pet.raise_mode),
    pet.id
  );
  res.json({ ok: true });
});

router.delete('/pets/:id', (req, res) => {
  const pet = db.prepare('SELECT * FROM pets WHERE id=?').get(req.params.id);
  if (!pet) return res.status(404).json({ error: '宠物不存在' });
  if (!canManage(pet, req.user)) return res.status(403).json({ error: '只有创建者或管理员可以删除' });
  for (const t of ['pets', 'pet_members', 'pet_state', 'pet_poops', 'pet_stats', 'pet_logs']) {
    db.prepare(`DELETE FROM ${t} WHERE ${t === 'pets' ? 'id' : 'pet_id'}=?`).run(pet.id);
  }
  if (pet.custom_gif) { try { fs.unlinkSync(path.join(GIF_DIR, pet.custom_gif)); } catch {} }
  res.json({ ok: true });
});

// 替换 GIF（custom 或任意种类换形象）
router.post('/pets/:id/gif', gifUpload.single('gif'), (req, res) => {
  const pet = db.prepare('SELECT * FROM pets WHERE id=?').get(req.params.id);
  if (!pet) return res.status(404).json({ error: '宠物不存在' });
  if (!canManage(pet, req.user)) return res.status(403).json({ error: '只有创建者或管理员可以修改' });
  if (!req.file) return res.status(400).json({ error: '未收到文件' });
  const name = saveGif(req.file);
  if (pet.custom_gif) { try { fs.unlinkSync(path.join(GIF_DIR, pet.custom_gif)); } catch {} }
  db.prepare('UPDATE pets SET custom_gif=? WHERE id=?').run(name, pet.id);
  res.json({ ok: true, custom_gif: name });
});

// GIF 文件（<img> 无法带 Authorization 头，前端 fetch blob 后转 objectURL 使用）
router.get('/pets/:id/gif', (req, res) => {
  const pet = db.prepare('SELECT * FROM pets WHERE id=?').get(req.params.id);
  if (!pet || !pet.custom_gif) return res.status(404).json({ error: 'not found' });
  const file = path.join(GIF_DIR, path.basename(pet.custom_gif));
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not found' });
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Cache-Control', 'no-cache');
  fs.createReadStream(file).pipe(res);
});

// ---------- 喂养 / 玩耍 / 吃药 / 铲屎 ----------
router.post('/pets/:id/action', (req, res) => {
  const pet = db.prepare('SELECT * FROM pets WHERE id=?').get(req.params.id);
  if (!pet) return res.status(404).json({ error: '宠物不存在' });
  if (pet.is_dead) return res.status(400).json({ error: '它已经去世了，愿它在彩虹的另一头安好 🌈' });
  if (!canSee(pet, req.user)) return res.status(403).json({ error: '你没有这只宠物的养育权限' });
  const cfg = getConfig();
  const st = refreshPet(pet.id, cfg);
  // 本次推进刚好触发死亡（如生病回合数到阈值）：拦下本次操作
  if (db.prepare('SELECT is_dead FROM pets WHERE id=?').get(pet.id).is_dead)
    return res.status(400).json({ error: '它刚刚去世了…愿它在彩虹的另一头安好 🌈' });
  const { type, item, poop_id } = req.body;
  const today = todayStr();
  const todayCount = (actions) => db.prepare(
    `SELECT COUNT(*) c FROM pet_logs WHERE pet_id=? AND user_id=? AND date(created_at)=? AND action IN (${actions.map(() => '?').join(',')})`
  ).get(pet.id, req.user.id, today, ...actions).c;
  db.prepare('INSERT OR IGNORE INTO pet_stats(pet_id,user_id) VALUES(?,?)').run(pet.id, req.user.id);
  const bump = (col, n) => db.prepare(`UPDATE pet_stats SET ${col}=${col}+? WHERE pet_id=? AND user_id=?`).run(n, pet.id, req.user.id);

  try {
    // ---------- 打字互动：输入口令触发的喂养/玩耍 ----------
    // 不占按钮的每日次数、不受冷却限制，每类（饭/水/零食/玩耍）每天另有 typing_daily_limit 次；
    // 但同样会让宠物吃饱喝足（更新 last_food/water_at，喂不了生病的宠物）
    if (req.body.typed) {
      // 前端口令体：{food,rice} {food,snack} {water,-} {play,yarn} —— 优先按 item，缺省回落 type
      const raw = (item && ['rice', 'water', 'snack', 'play'].includes(item)) ? item : type;
      const key = ['rice', 'water', 'snack', 'play'].includes(raw) ? raw : null;
      if (!key) return res.status(400).json({ error: '未知的打字互动类型' });
      const TYPED_LABEL = { rice: '喂饭', water: '喂水', snack: '零食', play: '玩耍' };
      const typedUsed = key === 'rice' || key === 'snack'
        ? db.prepare("SELECT COUNT(*) c FROM pet_logs WHERE pet_id=? AND user_id=? AND date(created_at)=? AND action='food' AND detail=? AND typed=1").get(pet.id, req.user.id, today, key).c
        : db.prepare("SELECT COUNT(*) c FROM pet_logs WHERE pet_id=? AND user_id=? AND date(created_at)=? AND action=? AND typed=1").get(pet.id, req.user.id, today, key).c;
      if (typedUsed >= cfg.typing_daily_limit)
        return res.status(400).json({ error: `今天的「${TYPED_LABEL[key]}」打字机会已用完（各 ${cfg.typing_daily_limit} 次）` });
      if (st.sick_at) return res.status(400).json({ error: '宠物生病了，先喂它吃药吧' });
      if (key === 'rice' || key === 'snack') {
        db.prepare("UPDATE pet_state SET last_food_at=datetime('now','localtime') WHERE pet_id=?").run(pet.id);
        addAffection(pet.id, req.user.id, cfg.affection[key], 'food', key, 1);
        bump(key === 'rice' ? 'fed' : 'snacks', 1);
        db.prepare('UPDATE pet_stats SET scoop_credits=scoop_credits+3 WHERE pet_id=? AND user_id=?').run(pet.id, req.user.id);
      } else if (key === 'water') {
        db.prepare("UPDATE pet_state SET last_water_at=datetime('now','localtime') WHERE pet_id=?").run(pet.id);
        addAffection(pet.id, req.user.id, cfg.affection.water, 'water', 'water', 1);
        bump('waters', 1);
        db.prepare('UPDATE pet_stats SET scoop_credits=scoop_credits+1 WHERE pet_id=? AND user_id=?').run(pet.id, req.user.id);
      } else { // play
        addAffection(pet.id, req.user.id, cfg.affection.play, 'play', 'yarn', 1);
        bump('plays', 1);
      }
      const freshT = db.prepare('SELECT * FROM pets WHERE id=?').get(pet.id);
      return res.json({ ok: true, typed: key, pet: petView(freshT, req.user, cfg) });
    }

    if (type === 'food') {
      const food = FOODS.includes(item) ? item : 'rice';
      if (st.sick_at) return res.status(400).json({ error: '宠物生病了，先喂它吃药吧' });
      if (todayCount(['food']) >= cfg.feed_daily_limit)
        return res.status(400).json({ error: `今天已喂 ${cfg.feed_daily_limit} 次，明天再来吧` });
      const left = parse(st.last_food_at) + cfg.feed_cooldown_hours * 3600000 - Date.now();
      if (Number.isFinite(parse(st.last_food_at)) && left > 0)
        return res.status(400).json({ error: `吃太饱啦，${Math.ceil(left / 60000)} 分钟后再喂` });
      db.prepare("UPDATE pet_state SET last_food_at=datetime('now','localtime') WHERE pet_id=?").run(pet.id);
      addAffection(pet.id, req.user.id, cfg.affection[food], 'food', food);
      bump(food === 'rice' ? 'fed' : 'snacks', 1);
      db.prepare('UPDATE pet_stats SET scoop_credits=scoop_credits+3 WHERE pet_id=? AND user_id=?').run(pet.id, req.user.id);
    } else if (type === 'water') {
      if (st.sick_at) return res.status(400).json({ error: '宠物生病了，先喂它吃药吧' });
      if (todayCount(['water']) >= cfg.water_daily_limit)
        return res.status(400).json({ error: `今天已喂水 ${cfg.water_daily_limit} 次，明天再来吧` });
      const left = parse(st.last_water_at) + cfg.water_cooldown_hours * 3600000 - Date.now();
      if (Number.isFinite(parse(st.last_water_at)) && left > 0)
        return res.status(400).json({ error: `刚喝过水，${Math.ceil(left / 60000)} 分钟后再喂` });
      db.prepare("UPDATE pet_state SET last_water_at=datetime('now','localtime') WHERE pet_id=?").run(pet.id);
      addAffection(pet.id, req.user.id, cfg.affection.water, 'water', 'water');
      bump('waters', 1);
      db.prepare('UPDATE pet_stats SET scoop_credits=scoop_credits+1 WHERE pet_id=? AND user_id=?').run(pet.id, req.user.id);
    } else if (type === 'play') {
      if (st.sick_at) return res.status(400).json({ error: '宠物生病了没心情玩，先喂它吃药吧' });
      const toy = PLAYS.includes(item) ? item : 'yarn';
      if (todayCount(['play']) >= cfg.play_daily_limit)
        return res.status(400).json({ error: `今天已经玩了 ${cfg.play_daily_limit} 次，宠物累了` });
      addAffection(pet.id, req.user.id, cfg.affection.play, 'play', toy);
      bump('plays', 1);
    } else if (type === 'medicine') {
      if (!st.sick_at) return res.status(400).json({ error: '宠物很健康，不需要吃药' });
      db.prepare('UPDATE pet_state SET sick_at=NULL, last_food_at=datetime(\'now\',\'localtime\') WHERE pet_id=?').run(pet.id);
      bump('medicines', 1);
      db.prepare('INSERT INTO pet_logs(pet_id,user_id,action,detail) VALUES(?,?,?,?)').run(pet.id, req.user.id, 'medicine', '喂药，恢复健康');
    } else if (type === 'scoop') {
      const stat = db.prepare('SELECT scoop_credits FROM pet_stats WHERE pet_id=? AND user_id=?').get(pet.id, req.user.id);
      if (!stat || stat.scoop_credits <= 0)
        return res.status(400).json({ error: '铲屎次数不足：喂饭+3次、喂水+1次' });
      const poop = db.prepare('SELECT * FROM pet_poops WHERE id=? AND pet_id=?').get(Number(poop_id) || 0, pet.id);
      if (!poop) return res.status(404).json({ error: '这块粪便已经被铲掉了' });
      db.prepare('DELETE FROM pet_poops WHERE id=?').run(poop.id);
      db.prepare('UPDATE pet_stats SET scoop_credits=scoop_credits-1, scooped=scooped+1 WHERE pet_id=? AND user_id=?').run(pet.id, req.user.id);
      db.prepare('INSERT INTO pet_logs(pet_id,user_id,action,detail) VALUES(?,?,?,?)').run(pet.id, req.user.id, 'scoop', '铲屎');
    } else {
      return res.status(400).json({ error: '未知操作' });
    }
  } catch (e) {
    return res.status(500).json({ error: '操作失败：' + e.message });
  }
  // 返回推进后的最新状态（前端即时刷新悬浮窗）
  const fresh = db.prepare('SELECT * FROM pets WHERE id=?').get(pet.id);
  res.json({ ok: true, pet: petView(fresh, req.user, cfg) });
});

// ---------- 记录（每宠物各成员统计 + 明细日志） ----------
router.get('/pets/records', (req, res) => {
  const petId = Number(req.query.pet_id) || 0;
  const pet = db.prepare('SELECT * FROM pets WHERE id=?').get(petId);
  if (!pet) return res.status(404).json({ error: '宠物不存在' });
  if (!canSee(pet, req.user)) return res.status(403).json({ error: '没有该宠物的权限' });
  const cfg = getConfig();
  refreshPet(pet.id, cfg);
  const today = todayStr();
  const stats = db.prepare(
    `SELECT s.*, u.username, u.display_name FROM pet_stats s LEFT JOIN users u ON u.id=s.user_id
     WHERE s.pet_id=? ORDER BY s.affection DESC`
  ).all(pet.id).filter((s) => s.user_id);
  for (const s of stats) {
    const cnt = (actions) => db.prepare(
      `SELECT COUNT(*) c FROM pet_logs WHERE pet_id=? AND user_id=? AND date(created_at)=? AND action IN (${actions.map(() => '?').join(',')})`
    ).get(pet.id, s.user_id, today, ...actions).c;
    s.today_food = cnt(['food']);
    s.today_water = cnt(['water']);
    s.today_play = cnt(['play']);
  }
  const logs = db.prepare(
    `SELECT l.*, u.username, u.display_name FROM pet_logs l LEFT JOIN users u ON u.id=l.user_id
     WHERE l.pet_id=? ORDER BY l.id DESC LIMIT 300`
  ).all(pet.id);
  const members = db.prepare(
    'SELECT m.user_id, u.username, u.display_name FROM pet_members m LEFT JOIN users u ON u.id=m.user_id WHERE m.pet_id=?'
  ).all(pet.id);
  res.json({ pet: { id: pet.id, name: pet.name, species: pet.species, raise_mode: pet.raise_mode, created_at: pet.created_at }, stats, logs, members, config: cfg });
});

// ---------- 打卡 ----------
router.post('/pets/checkin', (req, res) => {
  const cfg = getConfig();
  const today = todayStr();
  const r = db.prepare('INSERT OR IGNORE INTO pet_checkins(user_id,day) VALUES(?,?)').run(req.user.id, today);
  if (r.changes === 0) return res.status(400).json({ error: '今天已经打过卡了' });
  // 打卡给该用户养育的每只宠物加好感度（已去世的跳过）
  let gained = 0;
  for (const pet of myPets(req.user)) {
    if (pet.is_dead) continue;
    addAffection(pet.id, req.user.id, cfg.affection.checkin, 'checkin', '每日打卡');
    gained++;
  }
  const days = new Set(db.prepare('SELECT day FROM pet_checkins WHERE user_id=?').all(req.user.id).map((x) => x.day));
  let streak = 1;
  const d = new Date();
  d.setDate(d.getDate() - 1);
  while (days.has(dayOf(d))) { streak++; d.setDate(d.getDate() - 1); }
  res.json({ ok: true, streak, pets_gained: gained });
});
router.get('/pets/checkins', (req, res) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : todayStr().slice(0, 7);
  const days = db.prepare("SELECT day FROM pet_checkins WHERE user_id=? AND day LIKE ?").all(req.user.id, `${month}%`).map((x) => x.day);
  const all = new Set(db.prepare('SELECT day FROM pet_checkins WHERE user_id=?').all(req.user.id).map((x) => x.day));
  let streak = 0;
  const d = new Date();
  while (all.has(dayOf(d))) { streak++; d.setDate(d.getDate() - 1); }
  res.json({ month, days, streak, today: all.has(todayStr()) });
});

// ---------- 分配（管理员维护共同养育成员） ----------
router.get('/pets/assign', (req, res) => {
  // 查看放开（成员名单与用户列表非敏感）；修改走 PUT 校验管理员/创建者
  const all = db.prepare('SELECT * FROM pets ORDER BY id').all();
  const pets = req.user.role === 'admin' ? all : all.filter((p) => canSee(p, req.user));
  const users = db.prepare('SELECT id, username, display_name, role FROM users WHERE is_bot=0 ORDER BY id').all();
  const members = db.prepare('SELECT pet_id, user_id FROM pet_members').all();
  res.json({ pets, users, members });
});

// ---------- 桌面宠物（2026-09）：Windows 桌面常驻小窗（PowerShell WinForms，右下角置顶） ----------
// 服务端职责：① 用户级开关+接入密钥（user_prefs.pet_desktop，key 即桌面端凭证）② 当前宠物状态下发
// ③ 桌面形象帧文件：内置像素宠物由网页端「生成桌面形象」截帧上传 PNG（洋红底，颜色键透明），
//    custom GIF 宠物直接下发 GIF 原文件；④ 桌面端轻量互动（喂饭/喂水/玩耍，复用冷却与每日上限）
// ⑤ 安装包下发（desktop-pet-setup.ps1 内嵌服务器地址+个人 key，安装模式同监控代理）。
const PET_DESKTOP_DIR = path.join(dataDir, 'pet-desktop');

function petDesktopPref(userId) {
  try { return JSON.parse(db.prepare("SELECT value FROM user_prefs WHERE user_id=? AND key='pet_desktop'").get(userId)?.value || '{}') || {}; } catch { return {}; }
}
function setPetDesktopPref(userId, pref) {
  db.prepare('INSERT INTO user_prefs(user_id,key,value) VALUES(?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value')
    .run(userId, 'pet_desktop', JSON.stringify(pref));
}
// key → 用户（扫 pet_desktop 偏好行；key 格式严格校验，枚举量 = 用户数，个人平台足够）
function desktopUserByKey(key) {
  if (!/^[0-9a-f]{32}$/.test(String(key || ''))) return null;
  for (const r of db.prepare("SELECT user_id, value FROM user_prefs WHERE key='pet_desktop'").all()) {
    try {
      const p = JSON.parse(r.value || '{}');
      if (p && p.enabled && p.key === key) return db.prepare('SELECT * FROM users WHERE id=?').get(r.user_id) || null;
    } catch { /* 脏数据跳过 */ }
  }
  return null;
}
// 形象帧版本（f0.png 的 mtime 秒数）：换形象后桌面端据此弃用旧缓存
function frameVer(petId) {
  try { return Math.round(fs.statSync(path.join(PET_DESKTOP_DIR, String(petId), 'f0.png')).mtimeMs / 1000); } catch { return 0; }
}

// 桌面宠物配置（GET/PUT /pets/desktop-config）已注册到文件前段（须先于 PUT /pets/:id）

// 桌面端状态（key 免登录，EXEMPT 前缀 /pets/desktop）
router.get('/pets/desktop/state', (req, res) => {
  const user = desktopUserByKey(req.query.key);
  if (!user) return res.status(403).json({ error: 'bad key' });
  const cfg = getConfig();
  const pref = petDesktopPref(user.id);
  let pets = myPets(user);
  if (pref.pet_id) { const p = pets.find((x) => x.id === pref.pet_id); if (p) pets = [p]; }
  const pet = pets[0];
  if (!pet) return res.json({ enabled: true, pet: null });
  const v = petView(pet, user, cfg); // 惰性推进（生病/死亡即时反映）
  let frameCount = 0;
  if (!v.has_gif) {
    try { frameCount = fs.readdirSync(path.join(PET_DESKTOP_DIR, String(v.id))).filter((f) => /^f\d+\.png$/.test(f)).length; } catch { /* 未生成 */ }
  }
  res.json({
    enabled: true,
    scale: 0.6 * (Number(pref.scale) || 1), // 下发实际缩放系数：设置页 100% = 原始帧 60%
    pet: {
      id: v.id, name: v.name, species: v.species, variant: v.variant, rings: v.rings,
      sick: !!v.sick, dead: !!v.is_dead,
      gif: !!v.has_gif, frames: frameCount,
      ver: v.has_gif ? 0 : frameVer(v.id),
    },
    cooldowns: { food: v.my.food_cooldown || 0, water: v.my.water_cooldown || 0 },
  });
});

// 桌面形象文件（key 免登录）：i=gif → 宠物 GIF；i=数字 → PNG 帧
router.get('/pets/desktop/frame', (req, res) => {
  const user = desktopUserByKey(req.query.key);
  if (!user) return res.status(403).json({ error: 'bad key' });
  const petId = parseInt(req.query.pet, 10);
  if (!Number.isInteger(petId) || petId <= 0) return res.status(400).end();
  const i = String(req.query.i || '');
  if (i === 'gif') {
    const pet = db.prepare('SELECT * FROM pets WHERE id=?').get(petId);
    if (!pet || !pet.custom_gif || !canSee(pet, user)) return res.status(404).end();
    const f = path.join(GIF_DIR, path.basename(pet.custom_gif));
    if (!fs.existsSync(f)) return res.status(404).end();
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Cache-Control', 'no-cache');
    return fs.createReadStream(f).pipe(res);
  }
  const n = parseInt(i, 10);
  if (!Number.isInteger(n) || n < 0 || n > 7) return res.status(400).end();
  const f = path.join(PET_DESKTOP_DIR, String(petId), `f${n}.png`);
  if (!fs.existsSync(f)) return res.status(404).end();
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-cache');
  return fs.createReadStream(f).pipe(res);
});

// 桌面形象帧上传（登录态；网页端把内置像素宠物渲染成 PNG 帧后传上来）
router.post('/pets/desktop-frames', (req, res) => {
  const pet = db.prepare('SELECT * FROM pets WHERE id=?').get(Number(req.body && req.body.pet_id));
  if (!pet || !canSee(pet, req.user)) return res.status(404).json({ error: '宠物不存在' });
  const frames = Array.isArray(req.body.frames) ? req.body.frames : [];
  if (!frames.length || frames.length > 8) return res.status(400).json({ error: '帧数需 1~8 张' });
  const dir = path.join(PET_DESKTOP_DIR, String(pet.id));
  const pngs = [];
  for (const d of frames) {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(d || ''));
    if (!m) return res.status(400).json({ error: '仅支持 PNG dataURL' });
    pngs.push(Buffer.from(m[1], 'base64'));
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  pngs.forEach((buf, i) => fs.writeFileSync(path.join(dir, `f${i}.png`), buf));
  res.json({ ok: true, frames: pngs.length, ver: frameVer(pet.id) });
});

// ---------- 桌面宠物安装包（登录态；key 为个人密钥，非管理员亦可下载自己的） ----------
function petBaseUrl(req) {
  const clean = (u) => String(u || '').replace(/\/+$/, '');
  const org = clean(req.get('origin'));
  if (/^https?:\/\//i.test(org)) return org;
  const ref = clean(String(req.get('referer') || '').replace(/^(https?:\/\/[^/?#]+).*$/i, '$1'));
  if (/^https?:\/\//i.test(ref)) return ref;
  const xfp = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  return `${xfp || req.protocol}://${req.get('host')}`;
}

const PET_PS_TEMPLATE = [
  '# Workbench Desktop Pet - Windows 桌面电子宠物（PowerShell WinForms）',
  '# 从工作台「电子宠物 → 设置与预览 → 桌面宠物」下载，内嵌服务器地址与个人接入密钥。',
  'param([switch]$Remove)',
  "$ErrorActionPreference = 'Stop'",
  "$Server = '__SERVER__'",
  "$DeskKey = '__KEY__'",
  "$AppName = 'WorkbenchDesktopPet'",
  '$InstallDir = Join-Path $env:LOCALAPPDATA $AppName',
  '',
  'if ($Remove) {',
  '  Get-CimInstance Win32_Process -Filter "Name=\'powershell.exe\'" | Where-Object { $_.CommandLine -like "*$AppName*" } | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch {} }',
  "  Remove-Item 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name $AppName -ErrorAction SilentlyContinue",
  '  Start-Sleep 1',
  '  try { Remove-Item $InstallDir -Recurse -Force } catch {}',
  '  Write-Host \'桌面宠物已卸载\'',
  '  exit',
  '}',
  '',
  '# 单实例互斥锁：同一台电脑只跑一份（重复安装/双击自动退出第二份）。',
  '# WaitOne 捕获 AbandonedMutexException：上一个实例被强杀（卸载/任务管理器）会留下弃锁，视为本进程获得',
  "$mtx = New-Object System.Threading.Mutex($false, 'Global\\WorkbenchDesktopPet')",
  '$mtxHeld = $false',
  'try { $mtxHeld = $mtx.WaitOne(0) } catch { $mtxHeld = $true }',
  'if (-not $mtxHeld) { exit }',
  '',
  '# 首次运行（从下载目录）：复制自身到安装目录、注册当前用户开机自启、启动隐藏副本后退出',
  '$self = $MyInvocation.MyCommand.Path',
  "$installed = Join-Path $InstallDir 'desktop-pet.ps1'",
  'if ($self -and ($self -ne $installed)) {',
  '  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null',
  '  [IO.File]::WriteAllBytes($installed, [IO.File]::ReadAllBytes($self))',
  "  Set-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name $AppName -Value ('powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File ' + [char]34 + $installed + [char]34)",
  "  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installed",
  '  Write-Host \'桌面宠物已安装并启动（开机自启）\'',
  '  exit',
  '}',
  '',
  'Add-Type -AssemblyName System.Windows.Forms',
  'Add-Type -AssemblyName System.Drawing',
  '$CacheDir = Join-Path $InstallDir \'cache\'',
  'New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null',
  '# 自签名 HTTPS（局域网部署）：PS5.1 默认拒不受信证书且默认协议不含 TLS1.2，两项都显式放开（鉴权靠内嵌 key）',
  '[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12',
  '[Net.ServicePointManager]::ServerCertificateValidationCallback = { $true }',
  '',
  'function Http-Get([string]$Path) {',
  '  try {',
  '    $req = [System.Net.HttpWebRequest]::Create("$Server/api$Path")',
  '    $req.Timeout = 15000',
  '    $resp = $req.GetResponse()',
  '    $sr = New-Object IO.StreamReader($resp.GetResponseStream())',
  '    $t = $sr.ReadToEnd(); $sr.Close(); $resp.Close()',
  '    return $t',
  '  } catch [System.Net.WebException] {',
  '    # 4xx/5xx 同样带响应体（服务端 JSON 错误文案）——读出来按正常返回，别误报「网络不可达」',
  '    if ($_.Exception.Response) {',
  '      try { $r2 = $_.Exception.Response; $sr2 = New-Object IO.StreamReader($r2.GetResponseStream()); $t2 = $sr2.ReadToEnd(); $sr2.Close(); $r2.Close(); return $t2 } catch { return $null }',
  '    }',
  '    return $null',
  '  } catch { return $null }',
  '}',
  'function Http-Post([string]$Path, [string]$Body) {',
  '  try {',
  '    $req = [System.Net.HttpWebRequest]::Create("$Server/api$Path")',
  "    $req.Method = 'POST'; $req.ContentType = 'application/json'; $req.Timeout = 15000",
  '    $b = [Text.Encoding]::UTF8.GetBytes($Body)',
  '    $s = $req.GetRequestStream(); $s.Write($b, 0, $b.Length); $s.Close()',
  '    $resp = $req.GetResponse()',
  '    $r = New-Object IO.StreamReader($resp.GetResponseStream())',
  '    $t = $r.ReadToEnd(); $r.Close(); $resp.Close()',
  '    return $t',
  '  } catch [System.Net.WebException] {',
  '    if ($_.Exception.Response) {',
  '      try { $r2 = $_.Exception.Response; $sr2 = New-Object IO.StreamReader($r2.GetResponseStream()); $t2 = $sr2.ReadToEnd(); $sr2.Close(); $r2.Close(); return $t2 } catch { return $null }',
  '    }',
  '    return $null',
  '  } catch { return $null }',
  '}',
  'function Download-Bin([string]$Path) {',
  '  $wc = New-Object System.Net.WebClient',
  '  return $wc.DownloadData("$Server/api$Path")',
  '}',
  '',
  '# ---------- 状态与形象帧 ----------',
  '$script:State = $null',
  '$script:Frames = @()',
  '# 显示尺寸：按服务器下发的比例系数重采样（默认 0.6 = 原始帧 60% = 设置页的 100%）。必须用最近邻',
  '# 插值——不混色，洋红底仍是纯洋红、透明键不受影响；若靠 PictureBox Zoom 缩放（双线性）会把宠物',
  '# 边缘与洋红混成紫色镶边（见下方 Fit-Form 注释）。GIF 分支不缩放（转 Bitmap 会杀死动画）。',
  '$script:Mult = 0.6',
  'function Scale-Frame([Drawing.Image]$src) {',
  '  $w2 = [int][Math]::Max(1, [Math]::Round($src.Width * $script:Mult)); $h2 = [int][Math]::Max(1, [Math]::Round($src.Height * $script:Mult))',
  '  $bmp = New-Object Drawing.Bitmap($w2, $h2)',
  '  $g = [Drawing.Graphics]::FromImage($bmp)',
  '  $g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::NearestNeighbor',
  '  $g.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::Half',
  '  $g.DrawImage($src, 0, 0, $w2, $h2)',
  '  $g.Dispose()',
  '  return $bmp',
  '}',
  'function Load-Frames {',
  '  $script:Frames = @()',
  '  if (-not $script:State -or -not $script:State.pet) { return }',
  '  $petId = [int]$script:State.pet.id',
  '  $ver = [int]$script:State.pet.ver',
  '  if ($script:State.pet.gif) {',
  "    $f = Join-Path $CacheDir (\"pet-$petId-v$ver.gif\")",
  '    if (-not (Test-Path $f)) {',
  '      try { [IO.File]::WriteAllBytes($f, (Download-Bin ("/pets/desktop/frame?key=$DeskKey&pet=$petId&i=gif"))) } catch { return }',
  '    }',
  '    try { $script:Frames = @([Drawing.Image]::FromFile($f)) } catch {}',
  '    return',
  '  }',
  '  $n = [int]$script:State.pet.frames',
  '  if ($n -le 0) { return }',
  '  for ($i = 0; $i -lt $n; $i++) {',
  "    $f = Join-Path $CacheDir (\"pet-$petId-v$ver-f$i.png\")",
  '    if (-not (Test-Path $f)) {',
  '      try { [IO.File]::WriteAllBytes($f, (Download-Bin ("/pets/desktop/frame?key=$DeskKey&pet=$petId&i=$i"))) } catch { continue }',
  '    }',
  '    try { $img0 = [Drawing.Image]::FromFile($f); $script:Frames += (Scale-Frame $img0); $img0.Dispose() } catch {}',
  '  }',
  '}',
  'function Refresh-State {',
  '  $t = Http-Get "/pets/desktop/state?key=$DeskKey"',
  '  if (-not $t) { return }',
  '  try { $script:State = $t | ConvertFrom-Json } catch { return }',
  '  # 显示比例：服务器按用户设置下发（改设置后约 1 分钟轮询生效；缓存存的是原始帧，重采样纯内存）',
  '  if ($script:State.scale) { $m = [double]$script:State.scale; if ($m -gt 0 -and $m -le 3) { $script:Mult = $m } }',
  '  Load-Frames',
  '  Fit-Form',
  '  Update-Caption',
  '}',
  '# 窗体尺寸贴合图片（1:1 显示）：SizeMode=Zoom 的非整数缩放会用双线性插值把宠物边缘',
  '# 与洋红底混色，形成一圈紫色镶边（颜色键只认精确 #FF00FF）；贴合后零重采样即无镶边。',
  'function Fit-Form {',
  '  $iw = 0; $ih = 80',
  '  if ($script:Frames.Count -gt 0) { $iw = [int][Math]::Min(480, $script:Frames[0].Width); $ih = [int][Math]::Min(480, $script:Frames[0].Height) }',
  '  # 字幕可能比宠物宽（如「刚吃饱啦，等一会儿再喂」）：按文字实测宽度加宽窗体，',
  '  # 否则 1bpp 居中绘制到面板右缘就被截断（用户看到「刚吃饱啦，等」后面没了即此坑）',
  '  $w = $iw',
  '  if ($cap.Text) {',
  '    $g = $form.CreateGraphics(); $tw = [int][Math]::Ceiling($g.MeasureString($cap.Text, $cap.Font).Width); $g.Dispose()',
  '    if (($tw + 14) -gt $w) { $w = [Math]::Min(440, $tw + 14) }',
  '  }',
  '  if ($w -lt 120) { $w = 120 }',
  '  # 注意：PS 逗号优先级高于 +，构造器实参必须先算好——Size(a, b+20) 会被当成 3 参炸掉',
  '  $h = $ih + 18',
  '  $oldW = $form.ClientSize.Width',
  '  $form.ClientSize = New-Object Drawing.Size($w, $h)',
  '  # 宽度变化时反向平移保持右缘不动（宠物贴屏幕右缘时不被推出可视区）',
  '  if ($oldW -gt 0 -and $w -ne $oldW) { $form.Left = $form.Left - ($w - $oldW) }',
  '}',
  '',
  '# ---------- 窗体（无边框置顶 + 颜色键透明：PNG 洋红底即透明区） ----------',
  '$form = New-Object Windows.Forms.Form',
  "$form.FormBorderStyle = 'None'",
  '$form.BackColor = [Drawing.Color]::FromArgb(255, 0, 255)',
  '$form.TransparencyKey = $form.BackColor',
  '$form.TopMost = $true',
  '$form.ShowInTaskbar = $false',
  "$form.StartPosition = 'Manual'",
  '$form.Size = New-Object Drawing.Size(184, 206)',
  '$wa = [Windows.Forms.Screen]::PrimaryScreen.WorkingArea',
  '$form.Location = New-Object Drawing.Point(($wa.Right - 204), ($wa.Bottom - 226))',
  '',
  '$pb = New-Object Windows.Forms.PictureBox',
  "$pb.SizeMode = 'Zoom'",
  "$pb.Dock = 'Fill'",
  '$pb.BackColor = $form.BackColor',
  '$form.Controls.Add($pb)',
  '',
  '$cap = New-Object Windows.Forms.Panel',
  "$cap.Dock = 'Bottom'; $cap.Height = 18",
  '# 文字无底色悬浮：Panel 背景仍是洋红（整条连同空白区被透明键抠掉），文字改 1bpp 无抗锯齿',
  '# 自绘——每个像素要么纯黑要么纯洋红，桌面只剩黑字。ClearType/抗锯齿会把字边缘与洋红混成',
  '# 抠不掉的杂色（紫色毛边）；白底条可避但用户不要底色，1bpp 自绘两头兼得（坑⑧）。',
  '$cap.BackColor = $form.BackColor',
  "$cap.Font = New-Object Drawing.Font('Microsoft YaHei UI', 9)",
  '$cap.Add_TextChanged({ Fit-Form; $cap.Invalidate() })',
  '$cap.Add_Paint({',
  '  $_.Graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::SingleBitPerPixelGridFit',
  '  $fmt = New-Object Drawing.StringFormat',
  "  $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'",
  '  $rect = New-Object Drawing.RectangleF(0, 0, $cap.ClientSize.Width, $cap.ClientSize.Height)',
  '  $_.Graphics.DrawString($cap.Text, $cap.Font, [Drawing.Brushes]::Black, $rect, $fmt)',
  '})',
  '$form.Controls.Add($cap)',
  '',
  'function Update-Caption {',
  '  if (-not $script:State -or -not $script:State.pet) { $cap.Text = \'未找到宠物\'; return }',
  '  $p = $script:State.pet',
  '  if ($p.dead) { $cap.Text = "$($p.name) 已去世...  " }',
  '  elseif ($p.sick) { $cap.Text = "$($p.name) 生病了（回网页喂药）" }',
  '  else { $cap.Text = $p.name }',
  '}',
  '',
  '# ---------- 互动：双击玩耍；右键菜单 ----------',
  'function Do-Action([string]$kind) {',
  '  if (-not $script:State -or -not $script:State.pet) { return }',
  '  $petId = [int]$script:State.pet.id',
  '  $body = "{`"pet`":$petId,`"action`":`"$kind`"}"',
  '  $t = Http-Post "/pets/desktop/action?key=$DeskKey" $body',
  '  if ($t) { try { $r = $t | ConvertFrom-Json; if ($r.ok) { $cap.Text = \'收到了~ \' + $kind } } catch {} }',
  '  if (-not $t) { $cap.Text = \'网络不可达\' }',
  '  try { $e = $t | ConvertFrom-Json; if ($e.error) { $cap.Text = $e.error } } catch {}',
  '}',
  '$menu = New-Object Windows.Forms.ContextMenuStrip',
  '[void]$menu.Items.Add(\'喂饭\', $null, { Do-Action \'food\' })',
  '[void]$menu.Items.Add(\'喂水\', $null, { Do-Action \'water\' })',
  '[void]$menu.Items.Add(\'玩耍（双击宠物同效）\', $null, { Do-Action \'play\' })',
  '[void]$menu.Items.Add(\'刷新状态\', $null, { Refresh-State })',
  '[void]$menu.Items.Add(\'退出\', $null, { $form.Close() })',
  '$form.ContextMenuStrip = $menu',
  '# 关键：PictureBox/Label 铺满窗体，右键永远落在控件上——只挂窗体菜单永远弹不出来',
  '$pb.ContextMenuStrip = $menu',
  '$cap.ContextMenuStrip = $menu',
  '',
  '# ---------- 拖动（左键按住图片拖动；右键留给菜单，不作为拖动起点） ----------',
  '$script:drag = $null',
  '$pb.Add_MouseDown({ if ($_.Button -ne [Windows.Forms.MouseButtons]::Left) { return }; $script:drag = @{ X = ([Windows.Forms.Cursor]::Position.X - $form.Left); Y = ([Windows.Forms.Cursor]::Position.Y - $form.Top) } })',
  '$pb.Add_MouseMove({',
  '  if ($script:drag) {',
  '    $form.Location = New-Object Drawing.Point(([Windows.Forms.Cursor]::Position.X - $script:drag.X), ([Windows.Forms.Cursor]::Position.Y - $script:drag.Y))',
  '  }',
  '})',
  '$pb.Add_MouseUp({ $script:drag = $null })',
  '$pb.Add_DoubleClick({ Do-Action \'play\' })',
  '',
  '# ---------- 帧动画：像素帧 4 张约定 [正常, 眨眼, 开心, 生病]，正常循环 0-1-0-2；GIF 自播不停表 ----------',
  '$script:fi = 0',
  '$tAnim = New-Object Windows.Forms.Timer',
  '$tAnim.Interval = 380',
  '$tAnim.Add_Tick({',
  '  if ($script:Frames.Count -le 1) { if ($script:Frames.Count -eq 1 -and -not $pb.Image) { $pb.Image = $script:Frames[0] }; return }',
  '  $idx = 0',
  '  if ($script:State -and $script:State.pet) {',
  '    if ($script:State.pet.dead) { $idx = $script:Frames.Count - 1 }',
  '    elseif ($script:State.pet.sick -and $script:Frames.Count -ge 4) { $idx = 3 }',
  '    else { $seq = @(0, 1, 0, 2); $idx = $seq[$script:fi % 4]; $script:fi = ($script:fi + 1) % 4 }',
  '  }',
  '  if ($idx -lt $script:Frames.Count) { $pb.Image = $script:Frames[$idx] }',
  '})',
  '$tAnim.Start()',
  '',
  '# ---------- 状态轮询（60s）：生病/去世/换形象即时跟上 ----------',
  '$tPoll = New-Object Windows.Forms.Timer',
  '$tPoll.Interval = 60000',
  '$tPoll.Add_Tick({ Refresh-State })',
  '$tPoll.Start()',
  '',
  'Refresh-State',
  'if (-not $script:State) { $cap.Text = \'服务器暂不可达（稍后自动重试）\' }',
  'elseif (-not $script:State.pet) { $cap.Text = \'未找到宠物\' }',
  'elseif ($script:Frames.Count -eq 0) { $cap.Text = \'请先在网页生成桌面形象\' }',
  '[void]$form.ShowDialog()',
  '$mtx.ReleaseMutex() | Out-Null',
];

router.get('/pets/agent-files', (req, res) => {
  const type = String(req.query.type || '');
  const pref = petDesktopPref(req.user.id);
  // 不设 Cache-Control：no-store 会让 Chrome/Edge <a download> 直点下载报
  // 「下载失败-请检查互联网连接状况」（复制链接新窗口打开反而正常）；与 monitor-setup 一致
  if (type === 'petsetup') {
    if (!pref.key) return res.status(400).json({ error: '请先打开桌面宠物开关并保存' });
    const ps = PET_PS_TEMPLATE.join('\r\n').replace(/__SERVER__/g, petBaseUrl(req)).replace(/__KEY__/g, pref.key);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="desktop-pet-setup.ps1"');
    return res.end('﻿' + ps); // UTF-8 BOM：PS 5.1 无 BOM 会按 ANSI 解析中文
  }
  if (type === 'petinstall') {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="install-desktop-pet.bat"');
    return res.end([
      '@echo off',
      'rem Workbench Desktop Pet - install (put together with desktop-pet-setup.ps1, then run as Administrator)',
      'cd /d "%~dp0"',
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "desktop-pet-setup.ps1"',
      'pause',
    ].join('\r\n'));
  }
  if (type === 'petuninstall') {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="uninstall-desktop-pet.bat"');
    return res.end([
      '@echo off',
      'rem Workbench Desktop Pet - uninstall',
      'cd /d "%~dp0"',
      'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "desktop-pet-setup.ps1" -Remove',
      'pause',
    ].join('\r\n'));
  }
  res.status(400).json({ error: '未知文件类型' });
});

module.exports = router;
