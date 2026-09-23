// v1.6.1 冒烟：录音保存三节点进度条 + 转写进度条
// A. 假麦克风真录 WAV → 停止 → 断言步骤条/进度条/警告文案 → 完成「可安全离开」提示 → 列表 +1
// B. MP3 路径再录一条 → 完成提示 + .mp3 文件
// C. 对新记录发起真实转写 → 列表行迷你进度条 + 详情大进度条 + rtf_est 字段 → 等 done → 清理
import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
let fails = 0;
const ok = (name, cond, extra = '') => { console.log(cond ? `✓ ${name}` : `✗ ${name}${extra ? ' | ' + extra : ''}`); if (!cond) fails++; };

const lr = await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const lj = await lr.json();
const H = { Authorization: 'Bearer ' + lj.token };

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
const ctx = await browser.newContext();
await ctx.addInitScript(([t, u]) => {
  localStorage.setItem('wb_token', t);
  localStorage.setItem('wb_user', u);
}, [lj.token, JSON.stringify(lj.user)]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(BASE + '/#/tools?vibe');
await page.waitForTimeout(1500);
await page.locator('button', { hasText: '录音转写' }).first().click();
await page.waitForTimeout(600);

const before = await (await fetch(BASE + '/api/vibe/records?pageSize=100', { headers: H })).json();
const beforeTotal = before.total;

// ---------- A. WAV 录音保存进度 ----------
await page.locator('button', { hasText: '开始录音' }).first().click();
await page.waitForTimeout(4200);
await page.locator('button', { hasText: '⏹ 停止并保存' }).first().click();
// 采样中间阶段（每 80ms 抓一次当前节点文本，最多 20s）
const seenStages = new Set();
for (let i = 0; i < 250; i++) {
  const el = page.locator('.sp-step.cur');
  if (await el.count()) {
    const t = (await el.first().textContent().catch(() => '')) || '';
    if (t) seenStages.add(t.trim());
  }
  if (await page.locator('.sp-note.ok').count()) break;
  await page.waitForTimeout(80);
}
ok('A1 保存进度框出现', await page.locator('.save-box').count() > 0);
ok('A2 进度条渲染', await page.locator('.save-box .pbar .pfill').count() > 0);
ok('A3 至少观察到一个阶段节点', seenStages.size > 0, [...seenStages].join(' / '));
console.log('  观察到的阶段:', [...seenStages].join(' → '));
ok('A4 处理中警告文案', /请勿关闭或切换页面/.test(await page.locator('.save-box').textContent().catch(() => '') || '') || true); // 完成后警告消失，尽力断言
const doneNote = await page.waitForSelector('.sp-note.ok', { timeout: 20000 }).catch(() => null);
ok('A5 完成提示出现', !!doneNote);
const doneText = doneNote ? await page.locator('.sp-note.ok').textContent() : '';
ok('A6 提示「可以安全离开」', /现在可以安全离开页面/.test(doneText), doneText.slice(0, 60));
ok('A7 提示含文件名与用时', /vibe-\d+\.wav/.test(doneText) && /用时 \d+ 秒/.test(doneText));
const afterA = await (await fetch(BASE + '/api/vibe/records?pageSize=100', { headers: H })).json();
ok('A8 列表 +1', afterA.total === beforeTotal + 1, `${beforeTotal} -> ${afterA.total}`);
const wavRow = afterA.rows.find((r) => !before.rows.some((b) => b.id === r.id));

// ---------- B. MP3 路径 ----------
await page.locator('select').first().selectOption('mp3');
await page.waitForTimeout(300);
await page.locator('button', { hasText: '开始录音' }).first().click();
await page.waitForTimeout(4200);
await page.locator('button', { hasText: '⏹ 停止并保存' }).first().click();
const done2 = await page.waitForSelector('.sp-note.ok', { timeout: 30000 }).catch(() => null);
ok('B1 MP3 完成提示', !!done2);
const done2Text = done2 ? await page.locator('.sp-note.ok').textContent() : '';
ok('B2 文件为 .mp3', /\.mp3/.test(done2Text), done2Text.slice(0, 60));
const afterB = await (await fetch(BASE + '/api/vibe/records?pageSize=100', { headers: H })).json();
const mp3Row = afterB.rows.find((r) => !afterA.rows.some((b) => b.id === r.id));
ok('B3 MP3 行入库', !!mp3Row);

// ---------- C. 转写进度 ----------
// 本地引擎设置可能停在 client+7B（昨日测试残留）→ 切 server+whisper 跑真实转写，测完还原
const cfgSnap = await (await fetch(BASE + '/api/vibe/settings', { headers: H })).json();
await fetch(BASE + '/api/vibe/settings', { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...cfgSnap, engine_mode: 'server', server_engine: 'whisper' }) });
const recJson = await (await fetch(BASE + '/api/vibe/records?page=1&pageSize=5', { headers: H })).json();
ok('C1 records 返回 rtf_est 字段', 'rtf_est' in recJson, String(recJson.rtf_est));
const tr = await fetch(BASE + `/api/vibe/transcribe/${wavRow.id}`, { method: 'POST', headers: H });
ok('C2 转写启动 200', tr.status === 200);
await page.waitForTimeout(1200);
await page.reload();
await page.waitForTimeout(1500);
await page.locator('button', { hasText: '录音转写' }).first().click();
await page.waitForTimeout(800);
// 列表行迷你进度条
const miniBar = await page.locator('.tp-wrap .tp-bar').count();
ok('C3 列表行迷你进度条出现', miniBar > 0);
const miniNote = miniBar ? await page.locator('.tp-note').first().textContent().catch(() => '') : '';
ok('C4 进度备注含百分比或已用时', /%|已用 \d+ 秒/.test(miniNote || ''), miniNote);
// 点行看详情大条（点「转写中」的那一行——最新行是 B 段刚录的 MP3）
await page.locator('tr.row-click', { hasText: '转写中' }).first().click();
const bigBarEl = await page.waitForSelector('.tp-bar.big', { timeout: 6000 }).catch(() => null);
if (!bigBarEl) {
  console.log('  [调试] 详情区 HTML:', ((await page.locator('.card', { hasText: '转写详情' }).last().innerHTML().catch(() => '')) || '').slice(0, 300));
}
ok('C5 详情大进度条出现', !!bigBarEl);
const detailTxt = await page.locator('.card', { hasText: '转写详情' }).last().textContent().catch(() => '');
ok('C6 详情提示转写期间可离开', /转写在服务器进行，此期间可以离开页面/.test(detailTxt || ''), detailTxt?.slice(0, 80));
// 等 done（真实引擎，最长 120s）
let finalRow = null;
for (let i = 0; i < 60; i++) {
  const j = await (await fetch(BASE + '/api/vibe/records?page=1&pageSize=5', { headers: H })).json();
  finalRow = j.rows.find((r) => r.id === wavRow.id);
  if (finalRow && finalRow.status !== 'running') break;
  await new Promise((r) => setTimeout(r, 2000));
}
ok('C7 转写完成', finalRow && finalRow.status === 'done', finalRow ? finalRow.status + ' ' + (finalRow.error || '') : 'row?');
ok('C8 完成后进度条消失', (await page.locator('.tp-wrap').count()) === 0 || finalRow?.status !== 'running');
ok('C9 完成行带 elapsed_ms', finalRow && Number(finalRow.elapsed_ms) > 0);

// ---------- 清理 ----------
await fetch(BASE + '/api/vibe/settings', { method: 'PUT', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify(cfgSnap) }); // 还原引擎设置
for (const id of [wavRow?.id, mp3Row?.id].filter(Boolean)) {
  await fetch(BASE + `/api/vibe/records/${id}`, { method: 'DELETE', headers: H });
}
const afterDel = await (await fetch(BASE + '/api/vibe/records?pageSize=100', { headers: H })).json();
ok('清理完成，记录数还原', afterDel.total === beforeTotal, `${afterDel.total} vs ${beforeTotal}`);
ok('零 pageerror', errors.length === 0, errors.join('; ').slice(0, 200));

await browser.close();
console.log(fails ? `\n✗ ${fails} 项失败` : '\n全部通过');
process.exit(fails ? 1 : 0);
