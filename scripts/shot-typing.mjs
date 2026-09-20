// 打字喂养 + 按住拖动保存 + 领养回归 tab 端到端验证：node scripts/shot-typing.mjs [baseUrl]
// 覆盖：侧边栏无「领养宠物」/ 宠物页有领养 tab / 旧 /adopt 重定向 / 领养 e2e /
//       悬浮宠物默认位置右移 64px / 拖动后按用户保存并跨刷新恢复 / 打字口令喂养成败两条路径。
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = 'Logs/pet-shots';
fs.mkdirSync(OUT, { recursive: true });
const db = new DatabaseSync('data/workbench.sqlite');

// 临时会话（user 1 管理员），结束后清理
const token = crypto.randomBytes(32).toString('hex');
db.prepare(`INSERT INTO sessions(token,user_id,expires_at) VALUES(?,1,datetime('now','localtime','+1 hour'))`).run(token);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 860 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });
const log = (k, v) => console.log(k + ':', v);

try {
  await page.goto(BASE + '/#/login');
  await page.evaluate((t) => {
    localStorage.setItem('wb_token', t);
    localStorage.setItem('wb_user', JSON.stringify({ id: 1, username: 'admin', role: 'admin', display_name: '', allowed_pages: [], allowed_tabs: {} }));
  }, token);

  // ===== 1. 领养回归 tab：侧边栏无独立菜单，宠物页内有 tab =====
  await page.goto(BASE + '/#/pets');
  await page.waitForSelector('.tabs button', { timeout: 10000 });
  await page.waitForTimeout(900);
  const navTexts = await page.$$eval('.nav a', (as) => as.map((a) => a.textContent.trim()));
  log('侧边栏含「领养宠物」菜单(应 false)', navTexts.some((t) => t.includes('领养宠物')));
  log('侧边栏含「我的宠物」菜单(应 true)', navTexts.some((t) => t.includes('我的宠物')));
  const tabTexts = await page.$$eval('.tabs button', (bs) => bs.map((b) => b.textContent.trim()));
  log('宠物页 tabs', tabTexts.join(' | '));
  const cards = await page.$$eval('.pet-card', (cs) => cs.map((c) => ({ name: c.querySelector('.pc-name')?.textContent, w: c.offsetWidth, h: c.offsetHeight })));
  log('宠物卡片(仍为方形)', JSON.stringify(cards));

  // ===== 2. 旧地址 /adopt 重定向到 /#/pets?tab=adopt =====
  await page.goto(BASE + '/#/adopt');
  await page.waitForTimeout(900);
  log('旧地址落点', page.url().replace(BASE, ''));
  log('重定向后领养 tab 激活(物种网格)', await page.locator('.species-grid').count() === 1);
  log('物种方块数', await page.locator('.species-item').count());
  await shot('typing-adopt-tab');

  // ===== 3. 领养 e2e：选物种 → 起名 → 带它回家 → 自动切回列表 =====
  await page.locator('.species-item').nth(1).click(); // 猫
  await page.fill('input[placeholder="给宠物起个名字"]', '打字测试宠');
  await page.click('button:has-text("带它回家")');
  await page.waitForSelector('.pet-grid .pet-card', { timeout: 10000 });
  await page.waitForTimeout(600);
  const afterAdopt = await page.$$eval('.pet-card .pc-name', (ns) => ns.map((n) => n.textContent.trim()));
  log('领养后列表(应含新宠并回到列表tab)', afterAdopt.join(','));
  log('领养后回到列表 tab(应 true)', await page.locator('.tabs button.active').first().textContent().then((t) => t.trim() === '我的宠物'));

  // ===== 4. 悬浮宠物默认位置：右缘 64px（左移后） =====
  const fp = page.locator('.float-pet');
  await fp.waitFor({ timeout: 10000 });
  const b0 = await fp.boundingBox();
  const rightGap = Math.round(1440 - (b0.x + b0.width));
  log('悬浮宠物默认右缘间距(应 64)', rightGap);
  log('悬浮宠物底部间距(应 24)', Math.round(860 - (b0.y + b0.height)));

  // ===== 5. 按住拖动 → 位置保存 → 刷新后恢复 =====
  const targetX = Math.max(10, b0.x - 260), targetY = Math.max(70, b0.y - 80);
  await page.mouse.move(b0.x + b0.width / 2, b0.y + 30);
  await page.mouse.down();
  await page.mouse.move(targetX + b0.width / 2, targetY + 30, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  const b1 = await fp.boundingBox();
  log('拖动后位置(x/y)', `${Math.round(b1.x)},${Math.round(b1.y)} (原 ${Math.round(b0.x)},${Math.round(b0.y)})`);
  const lsPos = await page.evaluate(() => localStorage.getItem('wb_pet_pos_1'));
  log('localStorage 保存位置', lsPos);
  const srvPos = db.prepare("SELECT value FROM user_prefs WHERE user_id=1 AND key='pet_pos'").get();
  log('服务端保存位置', srvPos ? srvPos.value : '(无)');
  await shot('typing-dragged');
  await page.reload();
  await fp.waitFor({ timeout: 10000 });
  await page.waitForTimeout(800);
  const b2 = await fp.boundingBox();
  log('刷新后位置恢复(应≈拖动后)', `${Math.round(b2.x)},${Math.round(b2.y)}`);

  // ===== 6. 打字喂养：错误口令 → 换词；正确口令 → 互动成功 =====
  await page.mouse.move(b2.x + b2.width / 2, b2.y + 30); // 悬停展开环绕按钮
  await page.waitForSelector('.obtn', { timeout: 6000 });
  await page.click('.obtn:has-text("打字")');
  await page.waitForSelector('.type-menu', { timeout: 4000 });
  const word1 = (await page.locator('.tm-word b').textContent()).trim();
  await page.fill('.tm-input', '肯定不对的口令');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  log('错误口令提示出现(应含"口令不对")', (await page.locator('.tm-err').textContent().catch(() => '')) || '(无)');
  const word2 = (await page.locator('.tm-word b').textContent()).trim();
  log('错误后换了口令(应 true)', word1 !== word2);
  await page.fill('.tm-input', word2);
  await shot('typing-panel');
  const typedBefore = db.prepare("SELECT COUNT(*) c FROM pet_logs WHERE user_id=1 AND typed=1").get().c;
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  const typedAfter = db.prepare("SELECT COUNT(*) c FROM pet_logs WHERE user_id=1 AND typed=1").get().c;
  log('打字成功入库 typed 日志(+1)', `${typedBefore} → ${typedAfter}`);
  const lastTyped = db.prepare("SELECT action, detail FROM pet_logs WHERE user_id=1 AND typed=1 ORDER BY id DESC LIMIT 1").get();
  log('最近一条打字日志', JSON.stringify(lastTyped));
  const st = await page.evaluate(async (t) => {
    const r = await fetch('/api/pets/state', { headers: { Authorization: 'Bearer ' + t } });
    return await r.json();
  }, token);
  const cur = st.pets.find((p) => p.name === 'April') || st.pets[0];
  log('state 里 today_typed', JSON.stringify(cur.my.today_typed));
  log('state 里 ui 位置', JSON.stringify(st.ui));
  log('config typing_daily_limit(应 3)', st.config.typing_daily_limit);
} catch (e) {
  errors.push('脚本异常: ' + e.message);
  await shot('typing-error').catch(() => {});
} finally {
  // 清理：测试宠物 / 用户位置偏好（恢复默认右下）/ 临时会话
  const tp = db.prepare("SELECT id FROM pets WHERE name='打字测试宠'").get();
  if (tp) {
    for (const t of ['pets', 'pet_members', 'pet_state', 'pet_poops', 'pet_stats', 'pet_logs']) {
      db.prepare(`DELETE FROM ${t} WHERE ${t === 'pets' ? 'id' : 'pet_id'}=?`).run(tp.id);
    }
    log('测试宠物已删除', tp.id);
  }
  db.prepare("DELETE FROM user_prefs WHERE user_id=1 AND key='pet_pos'").run();
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  await browser.close();
}
log('控制台/页面错误', errors.length ? errors.join(' ; ') : '无');
process.exit(errors.length ? 1 : 0);
