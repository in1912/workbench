// UI 目检：① 视频教学历史学习列表（8 列表头/进行中标记/点击条目续学自动打开文件）
//          ② 日程日历（新增弹窗：钉钉提醒默认勾选 + 共享成员选择器；他人共享日程只读弹窗）
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const admin = db.prepare("SELECT id, display_name, username FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const token = crypto.randomBytes(32).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+20 minutes'))").run(token, admin.id);
const TEST_ROOT = path.resolve('data/vstudy-test').replace(/\\/g, '\\\\');

// 临时共享人（把日程共享给管理员）：先建用户，再让服务端打开其租户库建表，然后写一条共享日程
db.prepare("INSERT OR IGNORE INTO users(username,password_hash,role,allowed_pages,is_bot) VALUES('e2e_tmp_c','','user','[]',0)").run();
const uidC = db.prepare('SELECT id FROM users WHERE username=?').get('e2e_tmp_c').id;
const d0 = new Date(), pad = (x) => String(x).padStart(2, '0');
const DAY = `${d0.getFullYear()}-${pad(d0.getMonth() + 1)}-${pad(d0.getDate())}`;
const HM = `${pad(d0.getHours())}:${pad(d0.getMinutes())}`;
const evC = { title: `共享·家庭聚餐${HM}`, desc: '测试只读共享日程', start_time: `${DAY}T19:00`, end_time: `${DAY}T21:00`, location: '外婆家' };

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// 注意 addInitScript 的第二参是「单个参数」：传数组会把数组整体当实参（旧脚本 [token] 单元素字符串化后
// 碰巧无害，多元素会变成 "token,[object Object]" 导致 401 登出）——这里拆成两次单元素调用
await page.addInitScript((t) => { localStorage.setItem('wb_token', t); }, [token]);
await page.addInitScript((u) => { localStorage.setItem('wb_user', u); }, [JSON.stringify({ id: admin.id, username: admin.username, role: 'admin', allowed_pages: [], allowed_tabs: {} })]);

try {
  // 让服务端打开临时用户 C 的租户库（建全业务表结构），随后直接写库放共享日程
  await fetch('http://localhost:3000/api/events', { headers: { Authorization: 'Bearer ' + token } });
  const tdbC = new DatabaseSync(`data/tenant-${uidC}.sqlite`);
  tdbC.exec('PRAGMA busy_timeout = 8000');
  tdbC.prepare('INSERT INTO events(title,desc,start_time,end_time,location,remind_push,shared_to) VALUES(?,?,?,?,?,1,?)')
    .run(evC.title, evC.desc, evC.start_time, evC.end_time, evC.location, JSON.stringify([admin.id]));
  tdbC.close();

  // ===== ① 视频教学：历史学习列表 =====
  db.prepare("INSERT INTO settings(key,value) VALUES('vstudy_root',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(path.resolve('data/vstudy-test')));
  const mkSess = (pathAbs, year, subject, watched, startedMinAgo, endedMinAgo) => {
    const st = new Date(Date.now() - startedMinAgo * 60000);
    const en = endedMinAgo === null ? null : new Date(Date.now() - endedMinAgo * 60000);
    const f = (d) => d ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : null;
    db.prepare('INSERT INTO vstudy_sessions(user_id,user_name,path,kind,ext,school_year,subject,watched_sec,started_at,ended_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(admin.id, admin.display_name || admin.username, pathAbs, 'media', 'mp4', year, subject, watched, f(st), f(en));
  };
  mkSess(path.resolve('data/vstudy-test/语文/第一课.mp4'), '2025-2026 学年', '语文', 755, 90, 80);
  mkSess(path.resolve('data/vstudy-test/语文/笔记.txt'), '2025-2026 学年', '语文', 120, 2880, 2810);
  mkSess(path.resolve('data/vstudy-test/英语/教学.flv'), '2025-2026 学年', '英语', 3600, 30, null); // 进行中

  await page.goto('http://localhost:3000/#/learning?tab=vstudy');
  await page.waitForSelector('.vstudy');
  await page.waitForTimeout(800);
  ck('历史列表卡片可见', await page.locator('.hist h3', { hasText: '历史学习列表' }).isVisible());
  const heads = (await page.locator('.hist-tbl th').allTextContents()).join(',');
  ck('8 列表头齐全', ['序号', '日期时间', '学年', '科目', '学习时长', '开始时间', '关闭时间', '文件路径'].every((h) => heads.includes(h)), heads);
  const rows = await page.locator('.hist-tbl tbody tr').allInnerTexts();
  ck('3 条记录（倒序最新在前）', rows.length === 3, String(rows.length));
  ck('学习时长格式化', rows[0].includes('1.0 小时'), rows[0]);
  ck('进行中标记', rows.some((r) => r.includes('进行中')));
  ck('关闭时间列为 HH:MM:SS', /\d{2}:\d{2}:\d{2}/.test(rows[1] || ''), rows[1]);
  await page.screenshot({ path: 'Logs/vstudy-history.png', fullPage: false });

  // 点击最新一条 → 回到学习页并自动打开该文件（flv 用 flv.js 播）
  await page.locator('.hist-tbl tbody tr').first().click();
  await page.waitForSelector('.vs-body', { timeout: 10000 });
  ck('跳转学习页（学年·学科带出）', (await page.locator('.vs-head .cur').innerText()).includes('英语'));
  await page.waitForSelector('.player-zone video', { timeout: 15000 });
  ck('自动打开该文件播放', (await page.locator('.player-zone video').getAttribute('src') || '').includes(encodeURIComponent('教学.flv').slice(0, 6)));
  await page.waitForFunction(() => { const v = document.querySelector('.player-zone video'); return v && v.currentTime > 0.3; }, null, { timeout: 25000 }).catch(() => {});
  await page.screenshot({ path: 'Logs/vstudy-history-resume.png' });

  // ===== ② 日程日历 =====
  await page.goto('http://localhost:3000/#/tasks?tab=cal');
  await page.waitForSelector('.cal-grid');
  await page.waitForTimeout(800);
  // 新增弹窗：提醒默认勾选 + 共享选择器
  await page.locator('.cal-cell:not(.cal-empty)').first().click();
  await page.waitForSelector('.modal-card');
  ck('新增弹窗：钉钉提醒勾选默认开', await page.locator('.modal-card .ck-row input').isChecked());
  ck('新增弹窗：共享选择器在', await page.locator('.modal-card .share-row .upicker').isVisible());
  await page.screenshot({ path: 'Logs/tasks-add-remind-share.png' });
  await page.locator('.modal-card button', { hasText: '取消' }).click();
  // 共享日程（绿）+ 只读弹窗
  const sharedEvt = page.locator('.cal-evt.is-shared', { hasText: '共享·家庭聚餐' });
  await sharedEvt.waitFor({ timeout: 8000 });
  ck('日历中共享日程绿色标记', (await sharedEvt.getAttribute('title') || '').includes('只读'));
  await sharedEvt.click();
  await page.waitForSelector('.modal-card .ro-box');
  ck('共享日程只读弹窗（无保存/删除按钮）', (await page.locator('.modal-card button', { hasText: '保存' }).count()) === 0);
  ck('只读内容带主人与时间', (await page.locator('.modal-card .ro-box').innerText()).includes('e2e_tmp_c') && (await page.locator('.modal-card .ro-box').innerText()).includes('19:00'));
  await page.screenshot({ path: 'Logs/tasks-shared-readonly.png' });

  console.log(`\nUI ${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  await browser.close();
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  db.prepare('DELETE FROM vstudy_sessions WHERE user_id=?').run(admin.id);
  db.prepare("DELETE FROM settings WHERE key='vstudy_root'").run();
  try {
    const t = new DatabaseSync(`data/tenant-${uidC}.sqlite`);
    t.exec('PRAGMA busy_timeout = 8000');
    t.prepare('DELETE FROM events').run();
    t.close();
  } catch { /* 无库 */ }
  db.prepare('DELETE FROM users WHERE id=?').run(uidC);
  try { fs.unlinkSync(`data/tenant-${uidC}.sqlite`); } catch { /* 服务进程占用则留空壳 */ }
}
