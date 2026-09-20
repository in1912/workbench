// UI 目检：听写完整流程（录入→开始→原文隐藏→播报计数→完成）+ 语音配音页
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const token = crypto.randomBytes(32).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+10 minutes'))").run(token, admin.id);

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
await page.addInitScript((t) => {
  localStorage.setItem('wb_token', t);
  localStorage.setItem('wb_user', JSON.stringify({ id: 1, username: 'admin', role: 'admin', allowed_pages: [], allowed_tabs: {} }));
}, [token]);

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };

try {
  // ===== 听写页 =====
  await page.goto('http://localhost:3000/#/learning?tab=dictation');
  await page.waitForTimeout(1200);
  ck('听写 tab 可见', await page.locator('.tabs button', { hasText: '中英文听写' }).isVisible());
  ck('语音配音 tab 可见', await page.locator('.tabs button', { hasText: '语音配音' }).isVisible());
  ck('原有 tab 保留', await page.locator('.tabs button', { hasText: '学习计划' }).isVisible());
  ck('音色下拉有 18 项', (await page.locator('.dict select >> nth=1').locator('option').allTextContents()).length >= 18);

  // 录入 3 条全新文本（强制真实合成，验证预加载），自动模式间隔 3 秒（最快档）
  await page.locator('.dict textarea').fill('预热首条甲\n预热二条乙\n预热三条丙');
  await page.locator('.dict select >> nth=0').selectOption('auto');
  const intervalInput = page.locator('.dict input[type=number]');
  await intervalInput.fill('3');
  ck('条数统计 3', (await page.locator('.dict .cnt').innerText()).includes('3'));

  await page.locator('button', { hasText: '开始听写' }).click();
  // 准备阶段：session 一建立（配置保存后）就进 preloading，进度卡必出现
  await page.waitForSelector('.prep', { timeout: 15000 });
  ck('准备阶段进度卡出现', true);
  ck('准备阶段原文隐藏', !(await page.locator('.dict textarea').count()));
  ck('准备阶段有进度条', await page.locator('.prep .pbar').isVisible());
  await page.screenshot({ path: 'Logs/dictation-prep.png' });
  // 等全部合成完进入播放态（准备卡也带 .run 类，须用 :not(.prep) 区分；3 条全新文本最多 3 分钟）
  await page.waitForSelector('.run:not(.prep)', { timeout: 180000 });
  ck('合成完成进入播放态', true);
  ck('总数显示 3', (await page.locator('.run-count').innerText()).includes('3'));
  await page.waitForFunction(() => {
    const el = document.querySelector('.run:not(.prep) .run-count b');
    return el && Number(el.textContent) >= 1;
  }, null, { timeout: 90000 });
  ck('已播放计数 ≥1', true);
  await page.screenshot({ path: 'Logs/dictation-running.png' });
  const st1 = await page.locator('.run:not(.prep) .run-status').innerText();
  console.log('    [状态文案]', JSON.stringify(st1.trim()));
  ck('状态文案合理', /倒计时|播报|准备|下一条|暂停/.test(st1), st1);

  // 快捷键：← 重播本条（计数不推进）
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(600);
  const doneAfterReplay = await page.evaluate(() => Number(document.querySelector('.run:not(.prep) .run-count b').textContent));
  ck('← 重播不推进计数', doneAfterReplay === 1, String(doneAfterReplay));
  // 空格 ×2 → 跳到第 3 条（预加载完毕应秒切）
  await page.keyboard.press('Space');
  await page.waitForFunction(() => Number(document.querySelector('.run:not(.prep) .run-count b').textContent) >= 2, null, { timeout: 30000 });
  ck('空格切到第 2 条', true);
  await page.keyboard.press('Space');
  await page.waitForFunction(() => Number(document.querySelector('.run:not(.prep) .run-count b').textContent) >= 3, null, { timeout: 30000 });
  ck('空格切到第 3 条', true);
  ck('快捷键说明可见', await page.locator('.kbd-tip').isVisible());

  // 结束 → 回编辑态，草稿还在
  await page.locator('button', { hasText: '结束听写' }).click();
  await page.waitForSelector('.dict textarea');
  ck('结束回到编辑态', (await page.locator('.dict textarea').inputValue()).includes('预热首条甲'));

  // ===== 语音配音页 =====
  await page.locator('.tabs button', { hasText: '语音配音' }).click();
  await page.waitForSelector('.tts');
  await page.waitForTimeout(800);
  ck('引擎状态=运行中', (await page.locator('.pill').innerText()).includes('运行中'));
  const vcount = await page.locator('.v-item').count();
  ck('音色库 18 个', vcount === 18, String(vcount));
  ck('有参考录音试听控件', (await page.locator('.v-prev').count()) > 0);

  // 独立配音：生成一句并断言 <audio> 出现
  await page.locator('.tts textarea').fill('这是配音功能的测试句子。');
  await page.locator('button', { hasText: '生成语音' }).click();
  await page.waitForSelector('.gen-out audio', { timeout: 120000 });
  ck('配音生成成功(audio 控件)', true);
  await page.screenshot({ path: 'Logs/tts-panel.png' });

  console.log(`\nUI ${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  await browser.close();
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
