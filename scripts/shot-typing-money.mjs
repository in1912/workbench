// 打字赚钱 e2e：四模式可玩 / 进度入库 / 记录 / 赚钱日历金额 / 费率 / 兑现登记权限边界。
// 用临时用户承载练习数据（不污染真实账号），跑完即清理。node scripts/shot-typing-money.mjs
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

// ---------- 临时用户（打字数据全落它身上） ----------
db.prepare("INSERT INTO users(username,password_hash,role,allowed_pages,allowed_tabs,is_bot) VALUES('typing_e2e','','user','[]','{}',0)").run();
const tempUid = db.prepare("SELECT id FROM users WHERE username='typing_e2e'").get().id;
const mkToken = (uid) => {
  const t = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,'2030-01-01 00:00:00')`).run(t, uid);
  return t;
};
const adminToken = mkToken(1);
const tempToken = mkToken(tempUid);
const H = (t) => ({ Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' });
const req = async (t, method, url, body) => {
  const r = await fetch(BASE + '/api' + url, { method, headers: H(t), body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})) };
};

try {
  // ===== 0. API 权限与金额计算 =====
  let r = await req(tempToken, 'GET', '/typing/payouts');
  log('未授权用户 GET 兑现列表(应 403)', r.status);
  r = await req(tempToken, 'POST', '/typing/payouts', { user_id: tempUid, period: '2026-09', amount: 1 });
  log('未授权用户 POST 兑现(应 403)', r.status);
  r = await req(tempToken, 'PUT', '/typing/config', { reward_chars: 50, reward_yuan: 1 });
  log('未授权用户 改费率(应 403,费率归兑现登记)', r.status);
  r = await req(adminToken, 'PUT', '/typing/config', { reward_chars: 40, reward_yuan: 1 });
  log('admin 改费率 40字=1元', r.status, JSON.stringify(r.data));
  r = await req(tempToken, 'POST', '/typing/progress', { seconds: 90, correct: 150, wrong: 10 });
  log('练习进度上报', r.status);
  r = await req(adminToken, 'GET', `/typing/summary?user_id=${tempUid}`);
  log('汇总金额(150字×1元/40=3.75元)', JSON.stringify(r.data.totals));
  // 显式授权 payout tab 后可访问（费率与兑现同权限）
  db.prepare('UPDATE users SET allowed_tabs=? WHERE id=?').run(JSON.stringify({ typing: ['practice', 'records', 'money', 'payout'] }), tempUid);
  r = await req(tempToken, 'PUT', '/typing/config', { reward_chars: 30, reward_yuan: 1 });
  log('授权后 改费率 30字=1元(应 200)', r.status, JSON.stringify(r.data));
  r = await req(adminToken, 'GET', `/typing/summary?user_id=${tempUid}`);
  log('新费率汇总(150字×1元/30=5元)', r.data.totals.money);
  r = await req(tempToken, 'PUT', '/typing/config', { reward_chars: 40, reward_yuan: 1 });
  log('授权用户改回 40字=1元', r.status);
  r = await req(tempToken, 'GET', '/typing/payouts');
  log('授权后 GET 兑现列表(应 200)', r.status);
  r = await req(tempToken, 'GET', `/typing/payouts/preview?user_id=${tempUid}&month=${new Date().toLocaleDateString('sv').slice(0, 7)}`);
  log('兑现预览(应得3.75/待兑现3.75)', JSON.stringify({ e: r.data.earned, p: r.data.pending }));
  r = await req(tempToken, 'POST', '/typing/payouts', { user_id: tempUid, period: new Date().toLocaleDateString('sv').slice(0, 7), amount: 1.5, note: 'e2e' });
  const payId = r.data.id;
  log('登记兑现 1.5 元', r.status, 'id=' + payId);
  r = await req(tempToken, 'GET', `/typing/payouts/preview?user_id=${tempUid}&month=${new Date().toLocaleDateString('sv').slice(0, 7)}`);
  log('登记后待兑现(应 2.25=3.75-1.5)', r.data.pending);
  r = await req(adminToken, 'PUT', '/typing/config', { reward_chars: 100, reward_yuan: 2 });
  log('恢复费率 100字=2元', r.status + ' ' + JSON.stringify(r.data));

  // ===== 1. 浏览器：临时用户进入打字赚钱 =====
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const shot = (n) => page.screenshot({ path: `${OUT}/${n}.png` });
  await page.goto(BASE + '/#/login');
  await page.evaluate(([t, uid]) => {
    localStorage.setItem('wb_token', t);
    localStorage.setItem('wb_user', JSON.stringify({ id: uid, username: 'typing_e2e', role: 'user', allowed_pages: [], allowed_tabs: {} }));
  }, [tempToken, tempUid]);
  await page.goto(BASE + '/#/typing');
  await page.waitForSelector('.mode-card', { timeout: 10000 });
  const tabs0 = await page.$$eval('.tabs button', (bs) => bs.map((b) => b.textContent.trim()));
  log('临时用户 tabs(应无兑现登记)', tabs0.join(' | '));

  // ===== 2. 诗词模式：汉字+拼音对照，打对前几个字母 =====
  await page.click('.mode-card:nth-child(2)');
  await page.waitForSelector('.py-cells', { timeout: 6000 });
  const cell0 = await page.locator('.py-cells .cell').first().textContent();
  log('诗词首个单元(汉字+拼音)', JSON.stringify(cell0));
  const pyLetters = await page.locator('.py-cells .cell').first().locator('.py').textContent();
  for (const ch of pyLetters.slice(0, 4)) await page.keyboard.press(ch);
  await page.waitForTimeout(300);
  const stat = await page.locator('.py-stats').textContent();
  log('打4个字母后统计', stat.replace(/\s+/g, ' '));
  await shot('typing-poetry');
  // 换库：宋词 / 蒙学
  const libBtns = await page.$$eval('.py-select button', (bs) => bs.slice(0, 3).map((b) => b.textContent.trim()));
  log('诗词库切换按钮', libBtns.join(' | '));
  await page.click('.py-select button:nth-child(2)');
  await page.waitForTimeout(300);
  log('宋词第一首', await page.locator('.py-title').textContent());

  // ===== 3. 歌词模式：分类(爱国/儿歌/流行) =====
  await page.keyboard.press('Escape');
  await page.click('.mode-card:nth-child(3)');
  await page.waitForSelector('.py-cells', { timeout: 6000 });
  const songBtns = await page.$$eval('.py-select button', (bs) => bs.slice(0, 3).map((b) => b.textContent.trim()));
  log('歌曲分类', songBtns.join(' | '));
  await page.click('.py-select button:nth-child(2)'); // 儿歌
  await page.waitForTimeout(300);
  log('儿歌第一首', await page.locator('.py-title').textContent());
  await page.keyboard.press('l'); // 儿歌第一首=两只老虎 liang → l
  await page.waitForTimeout(200);
  await shot('typing-song');

  // ===== 4. 游戏模式 =====
  await page.keyboard.press('Escape');
  await page.click('.mode-card:nth-child(1)');
  await page.waitForSelector('.gm-ground canvas', { timeout: 6000 });
  await page.waitForTimeout(500);
  await page.keyboard.press('h'); // hello
  await page.waitForTimeout(200);
  await page.keyboard.press('x'); // 错误键
  await page.waitForTimeout(300);
  log('游戏模式统计', (await page.locator('.gm-top').textContent()).replace(/\s+/g, ' '));
  await shot('typing-game');

  // ===== 5. 钢琴模式（含 canon.mid 加载） =====
  await page.keyboard.press('Escape');
  await page.click('.mode-card:nth-child(4)');
  await page.waitForSelector('.pn-fall', { timeout: 6000 });
  await page.waitForSelector('.falling-note', { timeout: 6000 });
  await page.waitForTimeout(1500);
  const noteCnt = await page.locator('.falling-note').count();
  const midiStatus = await page.locator('.pn-midi-status').textContent();
  log('下落字母数', noteCnt, '| MIDI状态', midiStatus);
  const firstNote = await page.locator('.falling-note').first().textContent();
  await page.keyboard.press(firstNote.trim());
  await page.waitForTimeout(700);
  log('击打一个字母后统计', (await page.locator('.pn-top').textContent()).replace(/\s+/g, ' '));
  await shot('typing-piano');

  // ===== 6. 切回打字记录：今日行 + 时长 =====
  await page.keyboard.press('Escape');
  await page.click('.tabs button:nth-child(2)');
  await page.waitForSelector('.rc-table', { timeout: 6000 });
  const rows = await page.$$eval('.rc-table tbody tr', (rs) => rs.map((r) => r.textContent.trim().replace(/\s+/g, ' ')));
  log('打字记录(临时用户)', JSON.stringify(rows));
  await shot('typing-records');

  // ===== 7. 赚钱日历 =====
  await page.click('.tabs button:nth-child(3)');
  await page.waitForSelector('.mn-calendar', { timeout: 6000 });
  const todayCell = await page.locator('.mn-day.today').textContent();
  const moneyCards = await page.$$eval('.mn-card', (cs) => cs.map((c) => c.textContent.trim().replace(/\s+/g, ' ')));
  log('日历今日格子', todayCell.replace(/\s+/g, ' '));
  log('月度卡片', JSON.stringify(moneyCards));
  const rateText = await page.locator('.mn-rate').textContent();
  log('费率栏(只读展示)', rateText.replace(/\s+/g, ' ').slice(0, 60));
  log('日历页费率编辑框(应0,已挪到兑现登记)', await page.locator('.mn-rate input').count());
  await shot('typing-money');

  // ===== 8. 授权后临时用户能看到兑现登记 =====
  db.prepare('UPDATE users SET allowed_tabs=? WHERE id=?').run(JSON.stringify({ typing: ['practice', 'records', 'money', 'payout'] }), tempUid);
  await page.reload();
  await page.waitForSelector('.tabs button', { timeout: 10000 });
  const tabs1 = await page.$$eval('.tabs button', (bs) => bs.map((b) => b.textContent.trim()));
  log('授权后 tabs(应含兑现登记)', tabs1.join(' | '));
  await page.click('.tabs button:nth-child(4)');
  await page.waitForSelector('.po-form', { timeout: 6000 });
  log('兑现表单可见', true);
  const preview = await page.locator('.po-preview').textContent().catch(() => '');
  log('兑现预览', preview.replace(/\s+/g, ' ').slice(0, 80));
  // 奖励标准设置卡：改金额并保存
  log('兑现页费率编辑框(应2)', await page.locator('.rate-line input').count());
  await page.locator('.rate-line input').nth(1).fill('2.5');
  await page.click('.rate-line .primary');
  await page.waitForTimeout(600);
  log('保存费率提示', (await page.locator('.po-card:nth-child(2) .po-msg').textContent()).trim().slice(0, 40));
  r = await req(adminToken, 'GET', '/typing/config');
  log('UI保存后费率(应 yuan=2.5)', JSON.stringify(r.data));
  await req(adminToken, 'PUT', '/typing/config', { reward_chars: 100, reward_yuan: 2 });
  await shot('typing-payout');
  await browser.close();

  // ===== 9. admin 侧边栏有「打字赚钱」 =====
  const b2 = await chromium.launch();
  const p2 = await b2.newPage({ viewport: { width: 1440, height: 900 } });
  await p2.goto(BASE + '/#/login');
  await p2.evaluate((t) => {
    localStorage.setItem('wb_token', t);
    localStorage.setItem('wb_user', JSON.stringify({ id: 1, username: 'admin', role: 'admin', display_name: '', allowed_pages: [], allowed_tabs: {} }));
  }, adminToken);
  await p2.goto(BASE + '/#/typing');
  try {
    await p2.waitForSelector('.mode-card', { timeout: 8000 });
  } catch {
    await p2.reload(); // hash 导航偶发竞态，整页重载兜底
    try {
      await p2.waitForSelector('.mode-card', { timeout: 10000 });
    } catch {
      console.log('admin页诊断 url =', p2.url());
      console.log('admin页诊断 body =', (await p2.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400));
      await p2.screenshot({ path: OUT + '/typing-admin-fail.png' });
      throw new Error('admin 打字页未出现模式卡片');
    }
  }
  const navTexts = await p2.$$eval('.nav a', (as) => as.map((a) => a.textContent.trim()));
  log('admin 侧边栏含「打字赚钱」', navTexts.some((t) => t.includes('打字赚钱')));
  const adminTabs = await p2.$$eval('.tabs button', (bs) => bs.map((b) => b.textContent.trim()));
  log('admin tabs(4个)', adminTabs.join(' | '));
  await p2.click('.tabs button:nth-child(3)');
  await p2.waitForSelector('.mn-rate', { timeout: 6000 });
  log('admin 日历页费率编辑框(应0,只读)', await p2.locator('.mn-rate input').count());
  await p2.click('.tabs button:nth-child(4)');
  await p2.waitForSelector('.rate-line', { timeout: 6000 });
  log('admin 兑现页费率编辑框(应2)', await p2.locator('.rate-line input').count());
  await p2.screenshot({ path: OUT + '/typing-payout-admin.png' });
  await b2.close();

  // ===== 10. 删除兑现记录（当天可删） =====
  r = await req(adminToken, 'DELETE', `/typing/payouts/${payId}`);
  log('删除测试兑现记录', r.status);
} catch (e) {
  errors.push('脚本异常: ' + e.message);
  console.error(e);
} finally {
  // 清理：临时用户的一切 + 会话（费率已恢复 100/2）
  db.prepare('DELETE FROM typing_payouts WHERE user_id=?').run(tempUid);
  db.prepare('DELETE FROM typing_days WHERE user_id=?').run(tempUid);
  db.prepare("DELETE FROM sessions WHERE user_id=?").run(tempUid);
  // 本脚本与上次中断运行留下的测试用 admin 会话（特征：2030 过期）
  db.prepare("DELETE FROM sessions WHERE expires_at='2030-01-01 00:00:00'").run();
  db.prepare('DELETE FROM users WHERE id=?').run(tempUid);
  log('临时用户已清理', tempUid);
}
log('控制台/页面错误', errors.length ? errors.join(' ; ') : '无');
process.exit(errors.length ? 1 : 0);
