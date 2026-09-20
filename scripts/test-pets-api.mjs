// 电子宠物接口冒烟测试：node scripts/test-pets-api.mjs [baseUrl]
// 需先以全新 DATA_DIR 启动服务（默认管理员 admin/admin123）
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] || 'http://localhost:3100';
const dataDir = process.env.DATA_DIR || path.resolve('data-test');
let TOKEN = '';
const failures = [];
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failures.push(name);
};
const api = async (method, url, body) => {
  const res = await fetch(BASE + '/api' + url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

// ---------- 登录 ----------
const login = await api('POST', '/auth/login', { username: 'admin', password: '123456' });
TOKEN = login.data.token;
ok('登录管理员', !!TOKEN);

// ---------- 建宠 ----------
const dog = await api('POST', '/pets', { name: '旺财', species: 'dog', variant: 1, raise_mode: 'shared' });
const cat = await api('POST', '/pets', { name: '咪咪', species: 'cat', raise_mode: 'personal' });
const dogId = dog.data.id, catId = cat.data.id;
ok('创建共同养育小狗', dogId > 0);
ok('创建个人小猫', catId > 0);

// ---------- 喂养与冷却 ----------
let r = await api('POST', `/pets/${dogId}/action`, { type: 'food', item: 'rice' });
ok('喂饭成功', r.data.ok && r.data.pet.my.affection === 0.01 && r.data.pet.my.scoop_credits === 3);
r = await api('POST', `/pets/${dogId}/action`, { type: 'food', item: 'snack' });
ok('3小时内重复喂饭被拒', r.status === 400 && /吃太饱/.test(r.data.error));
r = await api('POST', `/pets/${dogId}/action`, { type: 'water' });
ok('喂水独立冷却', r.data.ok && r.data.pet.my.scoop_credits === 4 && r.data.pet.my.affection === 0.02);
r = await api('POST', `/pets/${dogId}/action`, { type: 'water' });
ok('3小时内重复喂水被拒', r.status === 400 && /喝过水/.test(r.data.error));
r = await api('POST', `/pets/${dogId}/action`, { type: 'play', item: 'yarn' });
ok('玩耍加好感0.03', r.data.ok && r.data.pet.my.affection === 0.05);

// ---------- 粪便（快进：直接改基准时间为 7 小时前） ----------
const tdb = new DatabaseSync(path.join(dataDir, 'workbench.sqlite'));
tdb.prepare("UPDATE pet_state SET poop_base_at = datetime('now','localtime','-7 hours') WHERE pet_id=?").run(dogId);
r = await api('GET', '/pets/state');
const dog0 = r.data.pets.find((p) => p.id === dogId);
ok('7小时生成2块粪便', dog0.poops.length === 2, `实际 ${dog0.poops.length}`);
r = await api('POST', `/pets/${dogId}/action`, { type: 'scoop', poop_id: dog0.poops[0] });
ok('铲屎消耗额度', r.data.ok && r.data.pet.poops.length === 1 && r.data.pet.my.scoop_credits === 3);
const pidGone = dog0.poops[0];
r = await api('POST', `/pets/${dogId}/action`, { type: 'scoop', poop_id: pidGone });
ok('重复铲同一块被拒', r.status === 404);

// ---------- 生病（快进：投喂时间改为 4 天前） ----------
tdb.prepare("UPDATE pet_state SET last_food_at = datetime('now','localtime','-4 days'), last_water_at = datetime('now','localtime','-4 days') WHERE pet_id=?").run(dogId);
r = await api('GET', '/pets/state');
ok('3天没吃没喝判定生病', r.data.pets.find((p) => p.id === dogId).sick === true);
ok('生病全体成员好感度-1', r.data.pets.find((p) => p.id === dogId).my.affection === 0);
r = await api('POST', `/pets/${dogId}/action`, { type: 'food', item: 'rice' });
ok('生病时拒绝喂食', r.status === 400 && /生病/.test(r.data.error));
r = await api('POST', `/pets/${dogId}/action`, { type: 'medicine' });
ok('吃药恢复健康', r.data.ok && r.data.pet.sick === false);

// ---------- 粪便超标扣好感 ----------
tdb.prepare('DELETE FROM pet_poops WHERE pet_id=?').run(dogId);
tdb.prepare("UPDATE pet_state SET poop_base_at = datetime('now','localtime','-2 days') WHERE pet_id=?").run(dogId);
tdb.prepare("UPDATE pet_state SET poop_penalty_at = datetime('now','localtime','-5 hours') WHERE pet_id=?").run(dogId);
r = await api('GET', '/pets/state');
const p2 = r.data.pets.find((p) => p.id === dogId);
ok('超3块粪便按小时扣好感', p2.poops.length > 3 && p2.my.affection === 0, `poops=${p2.poops.length} aff=${p2.my.affection}`);

// ---------- 每日上限（快进不了日期，直接灌日志） ----------
for (let i = 0; i < 2; i++) tdb.prepare('INSERT INTO pet_logs(pet_id,user_id,action,detail) VALUES(?,?,?,?)').run(dogId, login.data.user.id, 'food', 'rice');
r = await api('GET', '/pets/state');
ok('今日喂养计数=3（1真+2灌）', r.data.pets.find((p) => p.id === dogId).my.today_food === 3);

// ---------- 打卡 ----------
r = await api('POST', '/pets/checkin');
ok('打卡成功返回连续天数', r.data.ok && r.data.streak === 1);
r = await api('POST', '/pets/checkin');
ok('重复打卡被拒', r.status === 400);
r = await api('GET', '/pets/checkins');
ok('打卡月历包含今天', r.data.days.includes(new Date().toLocaleDateString('sv').slice(0, 10)));

// ---------- 记录 ----------
r = await api('GET', `/pets/records?pet_id=${dogId}`);
ok('记录含统计与日志', r.data.stats.length >= 1 && r.data.logs.length >= 5, `logs=${r.data.logs.length}`);

// ---------- 分配 ----------
const me = login.data.user.id;
r = await api('PUT', '/pets/members', { pet_id: dogId, user_ids: [me] });
ok('成员分配保存', r.data.ok);
r = await api('GET', '/pets/assign');
ok('分配视图包含宠物', r.data.pets.some((p) => p.id === dogId));

// ---------- 配置 ----------
r = await api('PUT', '/pets/config', { poop_interval_hours: 5, growth_days: 7 });
ok('管理员改配置', r.data.poop_interval_hours === 5 && r.data.growth_days === 7);

// ---------- 个人宠物隔离：建第二个用户验证 ----------
const dbMain = tdb;
const crypto = await import('node:crypto');
const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync('test123456', salt, 64).toString('hex');
dbMain.prepare("INSERT INTO users(username,password_hash,role,allowed_pages) VALUES('tester',?,'user','[]')").run(`${salt}:${hash}`);
const login2 = await api('POST', '/auth/login', { username: 'tester', password: 'test123456' });
const saveToken = TOKEN;
TOKEN = login2.data.token;
r = await api('GET', '/pets/state');
ok('他人看不到别人的个人宠物', !r.data.pets.some((p) => p.id === catId));
r = await api('POST', `/pets/${dogId}/action`, { type: 'play', item: 'blocks' });
ok('未分配成员不能操作共同宠物', r.status === 403);
// 分配后可见可操作
TOKEN = saveToken;
await api('PUT', '/pets/members', { pet_id: dogId, user_ids: [me, login2.data.user.id] });
TOKEN = login2.data.token;
r = await api('GET', '/pets/state');
ok('分配后成员可见共同宠物', r.data.pets.some((p) => p.id === dogId));
r = await api('POST', `/pets/${dogId}/action`, { type: 'play', item: 'train' });
ok('分配后成员可玩耍', r.data.ok === true);
TOKEN = saveToken;

// ---------- 删除 ----------
r = await api('DELETE', `/pets/${catId}`);
ok('删除宠物', r.data.ok);
r = await api('GET', '/pets/state');
ok('删除后列表移除', !r.data.pets.some((p) => p.id === catId));

console.log(failures.length ? `\n${failures.length} 项失败` : '\n全部通过');
process.exit(failures.length ? 1 : 0);
