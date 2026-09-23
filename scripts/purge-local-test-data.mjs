// purge-local-test-data.mjs —— 本机 3000 测试库个人敏感数据一次性清理（2026-09-23 第6项）
// 范围：仅本机 data/workbench.sqlite + data/tenant-1.sqlite + 孤儿 tenant 库归档；绝不动生产。
// 用法：先停掉本机 3000 服务，再在项目根目录执行  node scripts/purge-local-test-data.mjs
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const auth = require('../server/auth.js'); // scrypt 哈希（require 会顺带打开主库，同进程正常）

const log = (...a) => console.log(...a);
const main = new DatabaseSync('data/workbench.sqlite');

// ---- 1) 管理员 admin → admin，密码 admin123，清全部会话 ----
main.prepare("UPDATE users SET username='admin' WHERE id=1").run();
main.prepare('UPDATE users SET password_hash=? WHERE id=1').run(auth.hashPassword('admin123'));
main.prepare('UPDATE users SET fail_count=0, locked_until=NULL, lock_permanent=0 WHERE id=1').run();
main.prepare('DELETE FROM sessions').run();
log('[1] id=1 已改名 admin + 密码重置，sessions 全清');

// ---- 2) E2E 残留用户 ----
main.prepare('DELETE FROM users WHERE id IN (396,398,402)').run();
log('[2] E2E 残留用户 396/398/402 已删');

// ---- 3) 主库敏感表 ----
const MAIN_TABLES = ['ai_config','email_config','login_logs','messages','vstudy_sessions','vstudy_records',
  'typing_days','typing_payouts','vibe_records','vibe_jobs','pet_checkins'];
for (const t of MAIN_TABLES) { try { main.prepare('DELETE FROM ' + t).run(); } catch (e) { log('  (主库跳过', t, e.message, ')'); } }
log('[3] 主库敏感表已清：ai_config(真实api_key)/email_config/login_logs/messages/vstudy_*/typing_*/vibe_*/pet_checkins');

// ---- 4) 主库 settings 敏感键 ----
const MAIN_KEYS = ['amap_key','commute','dingtalk_app','dingtalk_login','monitor_cfg','news_search','local_base_url','external_base_url'];
for (const k of MAIN_KEYS) main.prepare('DELETE FROM settings WHERE key=?').run(k);
log('[4] 主库 settings 敏感键已删：' + MAIN_KEYS.join(', '));

// ---- 5) tenant-1（admin 业务库）敏感数据；news 为公开抓取内容，保留 ----
const t1 = new DatabaseSync('data/tenant-1.sqlite');
const T1_TABLES = ['emails','email_config','ai_config','pay_bills','pay_budgets','pay_categories',
  'business_systems','business_skills','skill_pushes','files','family_items','family_profiles','kids','kid_tasks',
  'events','todos','learning_plans','quick_links','clipboard_devices','clipboard_items'];
for (const t of T1_TABLES) { try { t1.prepare('DELETE FROM ' + t).run(); } catch (e) { log('  (tenant-1 跳过', t, e.message, ')'); } }
const T1_KEYS = ['commute','credit_cards','dingtalk_push','feishu_push','files_storage','weather','default_todos','pay_cycle'];
for (const k of T1_KEYS) t1.prepare('DELETE FROM settings WHERE key=?').run(k);
log('[5] tenant-1 业务数据已清（邮件28/账单2828/预算132/家庭/待办/日程/文件7/剪贴板等），settings 敏感键已删');

// ---- 6) vibe 录音音频落盘文件 ----
const vr = 'data/vibe-recordings';
if (fs.existsSync(vr)) { for (const f of fs.readdirSync(vr)) fs.unlinkSync(path.join(vr, f)); log('[6] data/vibe-recordings 音频已删'); }

// ---- 7) 孤儿 tenant 库（用户已不存在）连同 -wal/-shm 归档 ----
const uids = new Set(main.prepare('SELECT id FROM users').all().map((r) => r.id));
const ark = 'data/archive/orphans-' + new Date().toISOString().slice(0, 10).replaceAll('-', '');
fs.mkdirSync(ark, { recursive: true });
let n = 0;
for (const f of fs.readdirSync('data')) {
  const m = f.match(/^tenant-(\d+)\.sqlite(-wal|-shm)?$/);
  if (m && !uids.has(Number(m[1]))) { fs.renameSync(path.join('data', f), path.join(ark, f)); n++; }
}
log('[7] 归档孤儿 tenant 库文件 ' + n + ' 个 → ' + ark);

// ---- 校验输出 ----
log('--- 校验 ---');
log('users:', JSON.stringify(main.prepare('SELECT id,username,role FROM users').all()));
const cnt = (db, t) => { try { return db.prepare('SELECT COUNT(*) c FROM ' + t).get().c; } catch { return 'N/A'; } };
for (const t of MAIN_TABLES) log('主库', t, '=', cnt(main, t));
for (const t of ['emails','pay_bills','files']) log('tenant-1', t, '=', cnt(t1, t));
log('验证新密码 admin123:', auth.verifyPassword('admin123', main.prepare('SELECT password_hash FROM users WHERE id=1').get().password_hash));
main.close(); t1.close();
