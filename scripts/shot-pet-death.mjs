// 宠物死亡机制 e2e：饿死/病逝（可配阈值）、死亡后动作拦截与状态冻结、
// 墓碑卡（像素十字架+死因+时间+悼词）、悬浮窗死亡态、admin 删除死亡记录/存活宠物、配置恢复。
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = 'Logs/pet-shots';
fs.mkdirSync(OUT, { recursive: true });
const db = new DatabaseSync('data/workbench.sqlite');
const log = (k, v) => console.log(k + ':', v);
const errors = [];
const ck = (name, cond) => { log(name, cond ? '✓' : '✗ FAIL'); if (!cond) errors.push(name); };

// ---------- 临时用户 + 会话 ----------
db.prepare("INSERT INTO users(username,password_hash,role,allowed_pages,allowed_tabs,is_bot) VALUES('petdeath_e2e','','user','[]','{}',0)").run();
const uid = db.prepare("SELECT id FROM users WHERE username='petdeath_e2e'").get().id;
const mkToken = (u) => {
  const t = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,'2030-01-01 00:00:00')`).run(t, u);
  return t;
};
const tempToken = mkToken(uid);
const adminToken = mkToken(1);
const H = (t) => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' });
const req = async (t, method, url, body) => {
  const r = await fetch(BASE + '/api' + url, { method, headers: H(t), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};
// 把某宠物的上次喂饭/喂水回溯 N 天（直接落库，模拟长期没人照顾）
const backdate = (petId, days) => db.prepare(
  `UPDATE pet_state SET last_food_at=datetime('now','localtime','-${days} days'), last_water_at=datetime('now','localtime','-${days} days') WHERE pet_id=?`
).run(petId);
const petState = (arr, id) => arr.find((p) => p.id === id);

let petA = 0, petB = 0, petC = 0;
try {
  // ===== 造两只临时宠物 =====
  let r = await req(tempToken, 'POST', '/pets', { name: '饿饿', species: 'dog', raise_mode: 'personal' });
  petA = r.data.id;
  r = await req(tempToken, 'POST', '/pets', { name: '病病', species: 'cat', raise_mode: 'personal' });
  petB = r.data.id;
  ck('领养两只临时宠物', petA > 0 && petB > 0);

  // ===== 病逝路径：阈值设 2 个回合 =====
  await req(adminToken, 'PUT', '/pets/config', { sick_death_threshold: 2 });
  backdate(petB, 4); // sick_days 默认 3 天 → 生病第 1 回合
  r = await req(tempToken, 'GET', '/pets/state');
  let b = petState(r.data.pets, petB);
  ck('第 1 回合生病 sick=true', b.sick === true);
  ck('sick_count=1（病史计数）', b.sick_count === 1);
  ck('还没死', b.is_dead === false);
  r = await req(tempToken, 'POST', `/pets/${petB}/action`, { type: 'medicine' });
  ck('吃药恢复', r.status === 200 && r.data.pet.sick === false);
  backdate(petB, 4); // 再病一次 → 第 2 回合 → 达阈值
  r = await req(tempToken, 'GET', '/pets/state');
  b = petState(r.data.pets, petB);
  ck('第 2 回合触发病逝 is_dead', b.is_dead === true);
  ck('死因=sick', b.death_cause === 'sick');
  ck('death_text 含累计生病 2 回合', (b.death_text || '').includes('累计生病 2'));
  ck('dead_at 非空', !!b.dead_at);
  ck('悼词含宠物名', (b.death_eulogy || '').includes('病病'));
  r = await req(tempToken, 'POST', `/pets/${petB}/action`, { type: 'food', item: 'rice' });
  ck('死后喂饭被拦 400', r.status === 400 && /去世/.test(r.data.error || ''));

  // ===== 饿死路径：30 天没喂饭 =====
  await req(adminToken, 'PUT', '/pets/config', { starve_death_days: 30 });
  db.prepare(`UPDATE pet_state SET poop_base_at=datetime('now','localtime','-10 hours') WHERE pet_id=?`).run(petA);
  backdate(petA, 31);
  r = await req(tempToken, 'GET', '/pets/state');
  const a = petState(r.data.pets, petA);
  ck('31 天没喂 → 饿死 is_dead', a.is_dead === true);
  ck('死因=starve', a.death_cause === 'starve');
  ck('death_text 含没喂饭', (a.death_text || '').includes('没喂饭'));
  ck('悼词非空', (a.death_eulogy || '').length > 5);
  // 冻结：死后即使粪便基准回溯 10 小时也不再生成
  ck('死后粪便冻结（0 块）', db.prepare('SELECT COUNT(*) c FROM pet_poops WHERE pet_id=?').get(petA).c === 0);
  await req(tempToken, 'GET', '/pets/state');
  ck('再次刷新仍 0 块', db.prepare('SELECT COUNT(*) c FROM pet_poops WHERE pet_id=?').get(petA).c === 0);
  // 打卡跳过死者
  r = await req(tempToken, 'POST', '/pets/checkin');
  ck('打卡成功且不计死者', r.status === 200);

  // ===== UI：墓碑卡 + 悬浮窗死亡态 =====
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(BASE + '/#/login');
  await page.evaluate(([t, u]) => {
    localStorage.setItem('wb_token', t);
    localStorage.setItem('wb_user', JSON.stringify({ id: u, username: 'petdeath_e2e', role: 'user', allowed_pages: [], allowed_tabs: {} }));
  }, [tempToken, uid]);
  await page.goto(BASE + '/#/pets');
  await page.waitForSelector('.pet-card', { timeout: 10000 });
  ck('两张墓碑卡各含像素十字架', (await page.locator('.pet-card .px-cross canvas').count()) === 2);
  ck('已去世徽标 ×2', (await page.locator('.pet-card .badge.dark').count()) === 2);
  ck('死因文案可见', (await page.locator('.grave-cause').first().textContent() || '').length > 3);
  ck('悼词可见', (await page.locator('.grave-eulogy').first().textContent() || '').includes('，'));
  ck('删除记录按钮（主人）可见', (await page.locator('.pet-card button', { hasText: '删除记录' }).count()) === 2);
  await page.screenshot({ path: OUT + '/pet-death-cards.png' });
  // 悬浮窗：十字架 + 已去世标签 + 悬停只出翻页
  await page.waitForSelector('.float-pet.dead', { timeout: 10000 });
  ck('悬浮窗死亡态样式', true);
  ck('悬浮窗十字架', (await page.locator('.float-pet .px-cross').count()) === 1);
  ck('悬浮窗已去世标签', (await page.locator('.float-pet .mmini.dead').textContent() || '').includes('已去世'));
  await page.hover('.float-pet');
  await page.waitForTimeout(600);
  const orbitLabels = await page.$$eval('.obtn .ol', (els) => els.map((e) => e.textContent.trim()));
  ck('死亡宠物环绕按钮只剩翻页', orbitLabels.join(',') === '翻页');
  ck('无粪便图', (await page.locator('img.poop').count()) === 0);
  await page.screenshot({ path: OUT + '/pet-death-float.png' });
  await browser.close();

  // ===== 管理员：删除死亡记录 + 直接删除存活宠物 =====
  r = await req(adminToken, 'DELETE', `/pets/${petB}`);
  ck('admin 删除死亡记录', r.status === 200);
  r = await req(tempToken, 'POST', '/pets', { name: '新新', species: 'bear', raise_mode: 'personal' });
  petC = r.data.id;
  r = await req(adminToken, 'DELETE', `/pets/${petC}`);
  ck('admin 直接删除存活宠物', r.status === 200);
  r = await req(tempToken, 'GET', '/pets/state');
  ck('只剩 1 只（petA 墓碑）', r.data.pets.length === 1 && r.data.pets[0].id === petA);

  // ===== 恢复默认配置 =====
  r = await req(adminToken, 'PUT', '/pets/config', { sick_death_threshold: 50, starve_death_days: 60 });
  ck('恢复默认阈值 50/60', r.data.sick_death_threshold === 50 && r.data.starve_death_days === 60);
} catch (e) {
  errors.push('脚本异常: ' + e.message);
  console.error(e);
} finally {
  for (const pid of [petA, petB, petC]) {
    if (!pid) continue;
    for (const t of ['pets', 'pet_members', 'pet_state', 'pet_poops', 'pet_stats', 'pet_logs']) {
      db.prepare(`DELETE FROM ${t} WHERE ${t === 'pets' ? 'id' : 'pet_id'}=?`).run(pid);
    }
  }
  db.prepare("DELETE FROM sessions WHERE expires_at='2030-01-01 00:00:00'").run();
  db.prepare('DELETE FROM pet_checkins WHERE user_id=?').run(uid);
  db.prepare('DELETE FROM users WHERE id=?').run(uid);
  log('清理', '完成');
}
log('结果', errors.length ? errors.join(' ; ') : '全部通过');
process.exit(errors.length ? 1 : 0);
