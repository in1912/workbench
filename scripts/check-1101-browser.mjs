// 真浏览器点检：v1.10.1 的三处改动。
//
// 为什么后端 e2e 不够：这三条全在**前端行为**上——
//   ① 人生页最后一个页签是「使用流程」，图能画出来、点格子能跳页；
//   ② 笔记查看页显示创建/最后修改时间；
//   ③ 进笔记页默认打开**最近修改**的那一篇（而不是最近创建、更不是最近那篇录音）。
// 字符串级校验（chunk 里有没有某个中文）拦不住「模板引用了不存在的变量」这类白屏。
//
// 纪律同 check-notes-browser.mjs：每步都要证明视图真的渲染了；元素找不到就是失败，不许静默跳过。
// 用法：node scripts/check-1101-browser.mjs [--headed]
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startServer, sleep, login } from './_noteE2E.mjs';

const PORT = 3213;
const HEADED = process.argv.includes('--headed');
const { B, DATA, srv, stop } = await startServer({ tag: 'v1101', port: PORT });
console.log('隔离服务器', B, ' DATA =', path.relative(ROOT, DATA));

const admin = await login(B, 'admin', 'test123456');
const TOKEN = admin.token;
const A = async (m, url, body) => {
  const r = await fetch(B + url, {
    method: m, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { __raw: t.slice(0, 200), __status: r.status }; }
};

let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  <<< ' + String(extra).slice(0, 400)}`); };

// ---- 造数据：两篇笔记，时间戳拉开（updated_at 是秒级，同秒会并列，靠 id 兜底就不是「最近修改」了）----
const nA = await A('POST', '/api/notes', { title: '基线笔记A', content: '第一篇的正文' });
await sleep(1300);
const nB = await A('POST', '/api/notes', { title: '最近笔记B', content: '第二篇的正文' });
ck('造了两篇笔记', Number.isFinite(nA.id) && Number.isFinite(nB.id), JSON.stringify([nA, nB]));

const lean = await A('GET', '/api/notes?lean=1&limit=10');
ck('列表按最后修改倒序（B 在前）', lean[0] && lean[0].id === nB.id, JSON.stringify(lean.map((n) => [n.id, n.title, n.updated_at])));

const browser = await chromium.launch({ headless: !HEADED });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/favicon|ERR_CONNECTION|Failed to load resource/i.test(t)) return;
  errs.push('console: ' + t);
});
await page.goto(B, { waitUntil: 'domcontentloaded' });
await page.evaluate(([tk, u]) => {
  localStorage.setItem('wb_token', tk);
  localStorage.setItem('wb_user', JSON.stringify(u));
}, [TOKEN, admin.user || { username: 'admin' }]);

const titleOf = () => page.locator('.note-head input.title').first().inputValue();
const openNotes = async () => {
  await page.goto(`${B}/#/notes`, { waitUntil: 'domcontentloaded' });
  // 必须 reload：同 URL 的 goto 只是 fragment 导航，外壳不会重挂，页签还停在上一篇上
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.note-head input.title').first().waitFor({ state: 'visible', timeout: 20000 });
  return (await titleOf()).trim();
};

console.log('\n== ③ 进笔记页默认打开最近修改的那一篇 ==');
ck('默认打开的是「最近笔记B」', (await openNotes()) === '最近笔记B', '实际：' + await titleOf());

// 把 A 改一下 → A 变成最近修改的；再进一次必须打开 A（证明看的是 updated_at，不是创建时间/id）
await sleep(1300);
await A('PUT', `/api/notes/${nA.id}`, { title: '基线笔记A', content: '第一篇的正文（刚刚改过）' });
const lean2 = await A('GET', '/api/notes?lean=1&limit=10');
ck('改过之后列表头名换成 A（服务端确实按最后修改排）', lean2[0] && lean2[0].id === nA.id, JSON.stringify(lean2.map((n) => [n.id, n.updated_at])));
ck('改过之后默认打开「基线笔记A」', (await openNotes()) === '基线笔记A', '实际：' + await titleOf());

console.log('\n== ② 查看页显示创建时间 / 最后修改时间 ==');
// v1.10.2：这两枚时间从「独占一行」挪到「AI 总结/续写/翻译」那一行，格式也压缩成
// 「创建 10-05 09:45」（今年不写年份），完整时间戳改挂在 title 上。
const created = (await page.getByText(/创建 (\d{4}-)?\d{2}-\d{2} \d{2}:\d{2}/).first().innerText()).trim();
const updated = (await page.getByText(/修改 (\d{4}-)?\d{2}-\d{2} \d{2}:\d{2}/).first().innerText()).trim();
ck('「创建」是日期+时分', /^创建 (\d{4}-)?\d{2}-\d{2} \d{2}:\d{2}$/.test(created), created);
ck('「修改」是日期+时分', /^修改 (\d{4}-)?\d{2}-\d{2} \d{2}:\d{2}$/.test(updated), updated);
const row = (await A('GET', `/api/notes/${nA.id}`)) || {};
// 今年只显示「月-日 时:分」，往年的才带年份 —— 所以比对时按同一条规则把接口值裁一下
const tailOf = (s) => { const f = String(s || '').slice(0, 16); return f.startsWith(String(new Date().getFullYear())) ? f.slice(5) : f; };
ck('显示值与接口返回一致', created.endsWith(tailOf(row.created_at)) && updated.endsWith(tailOf(row.updated_at)),
  `${created} / ${updated} vs ${row.created_at} / ${row.updated_at}`);
const tips = await page.locator('.note-head .line.wrap span.nowrap').evaluateAll((els) => els.map((e) => [e.textContent.trim(), e.getAttribute('title')]));
ck('省掉的年份没丢：悬停提示里是完整时间戳',
  tips.some((t) => t[0].startsWith('创建') && String(t[1]).endsWith(String(row.created_at || '').slice(0, 19))) &&
  tips.some((t) => t[0].startsWith('修改') && String(t[1]).endsWith(String(row.updated_at || '').slice(0, 19))),
  JSON.stringify(tips));
await page.screenshot({ path: path.join(ROOT, 'Logs/shots/v1101-note-times.png'), clip: { x: 190, y: 60, width: 1240, height: 200 } });
ck('库里最后修改确实晚于创建（显示只到分钟，故用原始值判）', String(row.updated_at) !== String(row.created_at), `${row.created_at} / ${row.updated_at}`);

console.log('\n== ① 人生页最后一个页签「使用流程」==');
await page.goto(`${B}/#/life`, { waitUntil: 'domcontentloaded' });
await page.locator('.page-title').first().waitFor({ state: 'visible', timeout: 20000 });
const labels = await page.locator('.tabs button').evaluateAll((els) => els.map((e) => e.innerText.trim()));
ck('页签里有「使用流程」', labels.includes('使用流程'), labels.join(' / '));
ck('「使用流程」排在最后', labels[labels.length - 1] === '使用流程', labels.join(' / '));

await page.locator('.tabs button', { hasText: '使用流程' }).first().click();
await page.locator('.tabs button.active', { hasText: '使用流程' }).first().waitFor({ state: 'visible', timeout: 8000 });
const svg = page.locator('svg.flow').first();
await svg.waitFor({ state: 'visible', timeout: 10000 });
const rects = await page.locator('svg.flow g.node rect').count();
const texts = await page.locator('svg.flow g.node text.nt').evaluateAll((els) => els.map((e) => e.textContent.trim()));
ck('图里画了 10 个格子', rects === 10, '实际 ' + rects);
ck('格子文案是那十步', texts.length === 10 && texts[0].includes('今日') && texts[9].includes('关系图'), texts.join(' / '));
await page.getByText('进度永不落库', { exact: false }).first().waitFor({ state: 'visible', timeout: 8000 });
ck('图下有「进度永不落库」须知', true);
const loop = await page.locator('svg.flow path.edge.loop').count();
ck('有一条虚线闭环（反哺）', loop === 1, '实际 ' + loop);
await page.screenshot({ path: path.join(ROOT, 'Logs/shots/v1101-guide.png'), fullPage: true });
const box = await svg.boundingBox();
ck('图真的占位渲染（不是 0 高）', box && box.height > 200 && box.width > 400, JSON.stringify(box));

// 点格子要能跳页：点「③ 目标」应切到目标页
await page.locator('svg.flow g.node', { hasText: '③ 目标' }).first().click();
await page.locator('.tabs button.active', { hasText: '目标' }).first().waitFor({ state: 'visible', timeout: 8000 });
await page.getByText('目标树', { exact: false }).first().waitFor({ state: 'visible', timeout: 10000 });
ck('点图里的格子能跳到对应页签', true);

await page.screenshot({ path: path.join(ROOT, 'Logs/shots/v1101-guide-jump.png'), fullPage: true });
console.log('  截图：Logs/shots/v1101-guide.png（流程图）、Logs/shots/v1101-guide-jump.png（点格子跳页后）');

console.log('\n== ④ 新建 KR 的默认值：分子 0 / 分母 100（走真界面点「＋ 加一条」）==');
const goal = await A('POST', '/api/life/goals', { title: 'E2E-默认值目标', level: 'year' });
ck('建了一个目标', Number.isFinite(goal.id), JSON.stringify(goal));
await page.goto(`${B}/#/life?tab=goals`, { waitUntil: 'domcontentloaded' });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.locator('.tree-row', { hasText: 'E2E-默认值目标' }).first().waitFor({ state: 'visible', timeout: 15000 });
await page.locator('.tree-row', { hasText: 'E2E-默认值目标' }).first().click();
await page.locator('button', { hasText: '加一条' }).first().waitFor({ state: 'visible', timeout: 8000 });
await page.locator('button', { hasText: '加一条' }).first().click();
await page.locator('.kr-row').first().waitFor({ state: 'visible', timeout: 10000 });

const nums = await page.locator('.kr-row').first().locator('input[type=number]').evaluateAll((els) => els.map((e) => e.value));
ck('两个数值框是 0（分子）/ 100（分母）', nums[0] === '0' && nums[1] === '100', JSON.stringify(nums));
const krApi = await A('GET', `/api/life/goals/${goal.id}`);
ck('库里也落成 target=100 / current=0', !!(krApi.krs && krApi.krs[0]) && Number(krApi.krs[0].target) === 100 && Number(krApi.krs[0].current) === 0, JSON.stringify(krApi.krs));
const pct0 = (await page.locator('.kr-row').first().locator('.krpct').innerText()).trim();
ck('进度是 0% 而不是「—」（分母 100 真的生效了）', pct0 === '0%', pct0);
// 分子填 40 → 应当立刻是 40%，证明分母就是那个 100，而且改得动
const curInput = page.locator('.kr-row').first().locator('input[type=number]').first();
await curInput.fill('40');
await curInput.blur();
await page.waitForTimeout(1200);
const pct40 = (await page.locator('.kr-row').first().locator('.krpct').innerText()).trim();
ck('分子填 40 → 40%', pct40 === '40%', pct40);
await page.screenshot({ path: path.join(ROOT, 'Logs/shots/v1101-kr-default.png'), fullPage: true });
console.log('  截图：Logs/shots/v1101-kr-default.png');

console.log('\n浏览器错误：' + (errs.length ? '\n  ' + errs.join('\n  ') : '无'));
await browser.close();
stop();
console.log(`\n结果：${fail || errs.length ? '未通过 ❌' : '全部通过 ✅'}（${pass} 通过, ${fail} 失败）`);
process.exit(fail || errs.length ? 1 : 0);
