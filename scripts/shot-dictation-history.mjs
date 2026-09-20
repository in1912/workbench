// UI 复现：听写历史列表 —— 生成自动存档、全部词条以词块展示、点击行调取重听、15/30/50 分页 + 前后翻页
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
const B = 'http://localhost:3000/api';
const HA = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
const MARK = ['ui测试词组A\nui测试词组B\nui测试词组C', '单独词Z'];
const isMine = (c) => MARK.includes(c) || String(c).includes('ui测试词组') || /分页 filler/.test(c);

const browser = await chromium.launch();
try {
  // 造数据：16 条 filler 在前；三词组、单词最后创建（置顶第 1 页，方便词块/点击断言）
  for (let i = 2; i <= 17; i++) {
    await fetch(B + '/tts/dictation-history', { method: 'POST', headers: HA, body: JSON.stringify({ content: `分页 filler 第${i}词`, mode: 'auto', interval: 30, voice_id: 1, voice_name: '默认' }) });
  }
  for (const content of MARK) {
    await fetch(B + '/tts/dictation-history', { method: 'POST', headers: HA, body: JSON.stringify({ content, mode: 'auto', interval: 30, voice_id: 1, voice_name: '默认' }) });
  }

  const p = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await p.addInitScript(() => { window.alert = () => {}; });   // 静音取消重听过程中的提示
  await p.addInitScript((t) => { localStorage.setItem('wb_token', t); }, [token]);
  await p.addInitScript((u) => { localStorage.setItem('wb_user', u); }, [JSON.stringify({ id: admin.id, username: admin.username, role: 'admin', allowed_pages: [], allowed_tabs: {} })]);
  await p.goto('http://localhost:3000/#/learning?tab=dictation');
  await p.waitForSelector('.dict .hist', { timeout: 15000 });
  await p.evaluate(() => { const el = document.querySelector('.float-pet'); if (el) el.style.display = 'none'; });   // 悬浮宠物会挡住按钮点击

  // ① 列表渲染 + 分页脚（默认每页 15 行）
  const rows = p.locator('.hist-tbl tbody tr');
  const T = Number(await p.locator('.hist-foot .cnt b').first().textContent());
  ck('分页脚显示总数', T >= 18, String(T));
  ck('列表渲染（默认每页 15 行）', (await rows.count()) === Math.min(15, T), `rows=${await rows.count()} total=${T}`);

  // ② 全部词条以词块展示（三词组记录 → 3 个词块）
  const rowA = p.locator('.hist-row', { hasText: 'ui测试词组A' });
  ck('三词组记录在列表可见', (await rowA.count()) === 1, String(await rowA.count()));
  ck('该行展示全部 3 个词块', (await rowA.locator('.chip').count()) === 3, String(await rowA.locator('.chip').count()));
  const chipTexts = (await rowA.locator('.chip').allTextContents()).join('|');
  ck('词块为 A/B/C 三个词条', chipTexts === 'ui测试词组A|ui测试词组B|ui测试词组C', chipTexts);

  // ③ 每页行数切换 15 → 30 → 50
  await p.locator('.hist-foot select').selectOption('30');
  await p.waitForFunction(() => document.querySelectorAll('.hist-tbl tbody tr').length > 15, null, { timeout: 8000 });
  ck('切到每页 30 行', (await rows.count()) === Math.min(30, T), String(await rows.count()));
  await p.locator('.hist-foot select').selectOption('50');
  await p.waitForFunction(() => document.querySelector('.hist-foot select').value === '50', null, { timeout: 8000 });
  await p.waitForFunction(() => document.querySelectorAll('.hist-tbl tbody tr').length > 15, null, { timeout: 8000 });
  ck('切到每页 50 行', (await rows.count()) === Math.min(50, T), String(await rows.count()));

  // ④ 前后翻页
  await p.locator('.hist-foot select').selectOption('15');
  await p.waitForFunction(() => document.querySelectorAll('.hist-tbl tbody tr').length <= 15, null, { timeout: 8000 });
  ck('回到每页 15 行', (await rows.count()) === Math.min(15, T), String(await rows.count()));
  ck('第 1 页「上一页」禁用', await p.locator('.hist-foot button', { hasText: '上一页' }).isDisabled());
  if (T > 15) {
    await p.locator('.hist-foot button', { hasText: '下一页' }).click();
    await p.waitForFunction(() => [...document.querySelectorAll('.hist-foot .cnt')].some((el) => el.textContent.trim().startsWith('2 /')), null, { timeout: 8000 });
    ck('下一页翻到第 2 页', true);
    ck('第 2 页行数 = 余量', (await rows.count()) === Math.min(15, T - 15), String(await rows.count()));
    await p.locator('.hist-foot button', { hasText: '上一页' }).click();
    await p.waitForFunction(() => [...document.querySelectorAll('.hist-foot .cnt')].some((el) => el.textContent.trim().startsWith('1 /')), null, { timeout: 8000 });
    ck('上一页翻回第 1 页', true);
  }

  // ⑤ 点击行 → 调取该次内容直接重新听写；引擎已热时预合成一闪而过，两种收尾按钮都要兼容
  await p.locator('.hist-row', { hasText: '单独词Z' }).click();
  await p.waitForSelector('.card.run', { timeout: 15000 });
  ck('点击行直接进入重新听写界面', true);
  try {
    await p.locator('.run.prep button', { hasText: '取消准备' }).click({ timeout: 3000 });
  } catch {   // 预合成已完成进入播放态 → 用「结束听写」退出
    await p.locator('.card.run button', { hasText: '结束听写' }).click({ timeout: 5000 });
  }
  await p.waitForSelector('.dict textarea', { timeout: 8000 });
  const recalled = await p.locator('.dict textarea').inputValue();
  ck('取消后编辑框已载入该次内容', recalled.trim() === '单独词Z', recalled);

  await p.screenshot({ path: 'Logs/dictation-history.png', fullPage: true });
  await p.close();

  console.log(`\nUI ${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} catch (e) {
  console.log('测试异常:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  // 清理：删除本次测试的记录（含点击重听时新生成的那份「单独词Z」）
  try {
    for (let pg = 1; pg <= 5; pg++) {
      const d = await (await fetch(`${B}/tts/dictation-history?page=${pg}&pageSize=100`, { headers: HA })).json();
      for (const r of d.records || []) if (isMine(r.content)) await fetch(`${B}/tts/dictation-history/${r.id}`, { method: 'DELETE', headers: HA });
      if (!d.records || !d.records.length || pg * 100 >= d.total) break;
    }
  } catch { /* 尽力清理 */ }
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
