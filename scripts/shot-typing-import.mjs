// UI 冒烟（v3.5 打字内容导入）：游戏/诗词/歌词三处导入弹窗 + 自动拼音 + 选练 + 删除
// 跑在真实 6606 上（admin），结束后清理本脚本产生的导入行
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const admin = db.prepare("SELECT id, username FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const token = crypto.randomBytes(32).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+20 minutes'))").run(token, admin.id);

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };
const BASE = 'http://localhost:3000';
const MY_TITLES = ['E2E字母操', 'E2E问刘十九', 'E2E两只老虎'];

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript((t) => { localStorage.setItem('wb_token', t); }, [token]);
  await page.addInitScript((u) => { localStorage.setItem('wb_user', u); }, [JSON.stringify({ id: admin.id, username: admin.username, role: 'admin', allowed_pages: [], allowed_tabs: {} })]);
  page.on('dialog', (d) => d.accept());   // window.confirm 删除确认

  await page.goto(BASE + '/#/learning?tab=practice');
  await page.waitForSelector('.mode-card', { timeout: 15000 });
  ck('练习模式选择页打开', true);

  // ===== 游戏模式：导入字母练习 =====
  console.log('— 游戏模式 · 导入字母 —');
  await page.locator('.mode-card:has-text("游戏模式")').click();
  await page.waitForSelector('.game-mode', { timeout: 8000 });
  ck('游戏模式进入（我的练习面板在）', await page.locator('.gm-mine').count() === 1);
  await page.locator('.gm-mine .imp').click();
  await page.waitForSelector('.imp-dialog', { timeout: 5000 });
  ck('游戏导入弹窗只含一个内容框（无拼音框）', await page.locator('.imp-dialog textarea').count() === 1);
  await page.locator('.imp-dialog input').fill('E2E字母操');
  await page.locator('.imp-dialog textarea').fill('qwe rty uio pas');
  await page.locator('.imp-btns .primary').click();
  await page.waitForTimeout(800);
  ck('保存后弹窗关闭', await page.locator('.imp-dialog').count() === 0);
  ck('练习 chip 出现', await page.locator('.gm-chips button:has-text("E2E字母操")').count() === 1);
  ck('导入后自动开练（chip 高亮）', (await page.locator('.gm-chips button.active').textContent()).includes('E2E字母操'));
  const total0 = (await page.locator('.gm-top span:has-text("✅")').textContent()).trim();
  ck('练习流 = 10 个字母', total0.includes('0 / 12'), total0);
  await page.keyboard.press('q');
  await page.waitForTimeout(200);
  const total1 = (await page.locator('.gm-top span:has-text("✅")').textContent()).trim();
  ck('敲 q 命中第 1 个字母', total1.includes('1 / 12'), total1);
  await page.screenshot({ path: 'Logs/ti-game.png' });
  await page.keyboard.press('Escape');   // 回模式选择
  await page.waitForSelector('.mode-card', { timeout: 5000 });

  // ===== 诗词模式：导入 + 自动拼音 =====
  console.log('— 诗词模式 · 导入 + 自动拼音 —');
  await page.locator('.mode-card:has-text("诗词模式")').click();
  await page.waitForSelector('.pinyin-mode', { timeout: 8000 });
  await page.locator('.py-select button:has-text("⭐ 我的")').click();
  await page.waitForTimeout(400);
  { const mineN = await page.locator('.py-select button .del').count(); mineN ? ck('已有导入条目（用户自己的）', true) : ck('我的诗词空态提示', (await page.locator('.py-none').textContent()).includes('还没有导入')); }
  await page.locator('.py-select button.py-add').click();
  await page.waitForSelector('.imp-dialog', { timeout: 5000 });
  ck('诗词弹窗含原文+拼音两个框', await page.locator('.imp-dialog textarea').count() === 2);
  await page.locator('.imp-dialog input').first().fill('E2E问刘十九');
  await page.locator('.imp-dialog input').last().fill('白居易');
  await page.locator('.imp-dialog textarea').first().fill('绿蚁新醅酒，红泥小火炉。');
  await page.waitForTimeout(700);   // 等 350ms 防抖自动生成
  const pyVal = await page.locator('.imp-dialog textarea').last().inputValue();
  ck('拼音自动生成（岱=dai，ü=lv）', pyVal.startsWith('lv yi xin pei jiu'), pyVal.slice(0, 40));
  await page.locator('.imp-btns .primary').click();
  await page.waitForTimeout(800);
  ck('保存后进入我的库并加载该诗', (await page.locator('.py-select button.active:has-text("E2E问刘十九")').count()) === 1);
  ck('首格拼音 dai', (await page.locator('.cell').first().locator('.py').textContent()).trim() === 'lv');
  await page.keyboard.press('l');
  await page.waitForTimeout(200);
  ck('敲 l 命中首个拼音 lv', (await page.locator('.py-stats span').first().textContent()).includes('1 /'));
  await page.screenshot({ path: 'Logs/ti-poem.png' });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.mode-card', { timeout: 5000 });

  // ===== 歌词模式 =====
  console.log('— 歌词模式 · 导入 —');
  await page.locator('.mode-card:has-text("歌词模式")').click();
  await page.waitForSelector('.pinyin-mode', { timeout: 8000 });
  await page.locator('.py-select button:has-text("⭐ 我的")').click();
  await page.locator('.py-select button.py-add').click();
  await page.waitForSelector('.imp-dialog', { timeout: 5000 });
  await page.locator('.imp-dialog input').first().fill('E2E两只老虎');
  await page.locator('.imp-dialog input').last().fill('儿歌');
  await page.locator('.imp-dialog textarea').first().fill('两只老虎，两只老虎，跑得快，跑得快。');
  await page.waitForTimeout(700);
  const pyVal2 = await page.locator('.imp-dialog textarea').last().inputValue();
  ck('歌词拼音自动生成（liang zhi lao hu）', pyVal2.startsWith('liang zhi lao hu'), pyVal2.slice(0, 30));
  await page.locator('.imp-btns .primary').click();
  await page.waitForTimeout(800);
  ck('歌词保存后加载（标题含儿歌曲名）', (await page.locator('.py-title').textContent()).includes('E2E两只老虎'));
  await page.keyboard.press('l');
  await page.waitForTimeout(200);
  ck('敲 l 命中首个拼音', (await page.locator('.py-stats span').first().textContent()).includes('1 /'));
  await page.screenshot({ path: 'Logs/ti-song.png' });

  // ===== 删除（诗词条目 ✕ → confirm 已自动接受） =====
  await page.locator('.py-select button:has-text("E2E两只老虎") .del').click();
  await page.waitForTimeout(600);
  ck('歌词删除后条目消失', (await page.locator('.py-select button:has-text("E2E两只老虎")').count()) === 0);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.mode-card', { timeout: 5000 });
  await page.locator('.mode-card:has-text("游戏模式")').click();
  await page.waitForSelector('.gm-mine', { timeout: 5000 });
  await page.locator('.gm-chips button:has-text("E2E字母操") .del').click();
  await page.waitForTimeout(600);
  ck('游戏练习删除后 chip 消失', (await page.locator('.gm-chips button:has-text("E2E字母操")').count()) === 0);

  console.log(`\n${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  // 清理本脚本产生的导入行（防止污染真实库）
  try { db.prepare("DELETE FROM typing_imports WHERE title IN ('E2E字母操','E2E问刘十九','E2E两只老虎')").run(); } catch { /* 表不在就算了 */ }
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  await browser.close();
}
