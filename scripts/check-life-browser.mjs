// 真浏览器点检：v1.10.0 人生管理系统（/#/life 八个页签）。
//
// 为什么需要它：⑧ 面板全是新组件 + 新接口，既有 e2e 全是**后端**用例，
// 前端只做过「chunk 里有没有某个中文字符串」的字符串级校验——那拦不住模板引用了
// 脚本里不存在的变量、或某个面板一进就白屏。
//
// 三条纪律：
//   ① 每一步都要等一个**只有该面板能渲染出来的元素**，不能只看「没报错」——空白页同样不报错；
//   ② 元素找不到就是失败，绝不 `if (await count())` 静默跳过（那会在空白页上给假绿）；
//   ③ 选择器一律用**可见文本/元素**，不用 `<option>`（option 不渲染，永远等不到）。
//
// 用法：node scripts/check-life-browser.mjs [--headed]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startServer, sleep } from './_noteE2E.mjs';

const PORT = 3212;
const HEADED = process.argv.includes('--headed');
const SHOTS = path.join(ROOT, 'Logs', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const { B, DATA, srv, stop } = await startServer({ tag: 'life-browser', port: PORT });
console.log('隔离服务器', B, ' DATA =', path.relative(ROOT, DATA));

const login = async (u, p) => (await (await fetch(`${B}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: u, password: p }),
})).json());
const admin = await login('admin', 'test123456');
const TOKEN = admin.token;
const A = async (m, url, body) => {
  const r = await fetch(B + url, {
    method: m, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { __raw: t.slice(0, 200), __status: r.status }; }
};

const total = { pass: 0, fail: 0 };
const ck = (name, cond, extra = '') => {
  cond ? total.pass++ : total.fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  <<< ' + String(extra).slice(0, 400)}`);
};

// ---------- 造数据：走真接口落在隔离库里，和用户手点出来的东西一模一样 ----------
const p2 = (n) => String(n).padStart(2, '0');
const d0 = new Date();
const TODAY = `${d0.getFullYear()}-${p2(d0.getMonth() + 1)}-${p2(d0.getDate())}`;

const domains = await A('GET', '/api/life/domains');
const career = (domains || []).find((x) => x.name === '事业') || domains[0];
ck('领域种子：6 个领域已就位', Array.isArray(domains) && domains.length === 6, JSON.stringify(domains).slice(0, 200));

const year = await A('POST', '/api/life/goals', {
  title: '（验收）年度目标：把副业做成第二条收入', level: 'year', domain_id: career.id, is_key: 1, status: 'active',
});
ck('建年度目标', year && year.id > 0, JSON.stringify(year));

const quarter = await A('POST', '/api/life/goals', {
  title: '（验收）季度目标：上线写作课', level: 'quarter', parent_id: year.id, is_key: 1,
});
const kr1 = await A('POST', `/api/life/goals/${year.id}/krs`, { title: '卖出 100 份', target: 100, current: 38, weight: 1, unit: '份' });
const kr2 = await A('POST', `/api/life/goals/${year.id}/krs`, { title: '收入 3 万', target: 30000, current: 12000, weight: 2, unit: '元' });
ck('建子目标 + 两条 KR', quarter.id > 0 && kr1.id > 0 && kr2.id > 0, JSON.stringify({ quarter, kr1, kr2 }));

const detail = await A('GET', `/api/life/goals/${year.id}`);
// 加权：(0.38*1 + 0.40*2) / 3 = 0.3933…
ck('目标进度由 KR 自动算出', Math.abs(detail.progress - (0.38 + 0.4 * 2) / 3) < 1e-6, JSON.stringify(detail.progress));

const task = await A('POST', '/api/life/actions', {
  title: '（验收）写课程大纲', task_type: 'mainline', goal_id: quarter.id, estimate_min: 90, main_line_date: TODAY,
});
ck('建行动（挂着目标）', task && task.id > 0, JSON.stringify(task));
const task2 = await A('POST', '/api/life/actions', { title: '（验收）录一节试听课', task_type: 'project', estimate_min: 45 });

const habit = await A('POST', '/api/life/habits', { title: '（验收）每天走 8000 步', cadence: 'daily', goal_id: year.id });
const chk = await A('POST', `/api/life/habits/${habit.id}/check`, { count: 1 });
ck('建习惯并打卡', habit.id > 0 && chk.count === 1, JSON.stringify({ habit, chk }));

const review = await A('POST', '/api/life/reviews', {
  type: 'week', did_well: '（验收）周一定了大纲，三天补齐了目录。',
  did_bad: '（验收）晚上刷手机两小时。', learned: '（验收）先写大纲能省一半时间。',
  next_action: '（验收）周一上午先写大纲再动手', mood: 4, alignment: 5,
});
ck('写复盘', review && review.id > 0, JSON.stringify(review));
const toSop = await A('POST', `/api/life/reviews/${review.id}/to-sop`, {});
ck('复盘沉淀 SOP', toSop && toSop.id > 0, JSON.stringify(toSop));

const proj = await A('POST', '/api/life/projects', { title: '（验收）写作课', category: 'content', goal_id: year.id });
ck('建项目', proj && proj.id > 0, JSON.stringify(proj));

const links = await A('GET', '/api/life/links');
ck('关系引擎已自动建边（建目标/行动时连出来的）', links.nodes.length >= 4 && links.edges.length >= 3,
  `nodes=${links?.nodes?.length} edges=${links?.edges?.length}`);

// ---------- 浏览器 ----------
const browser = await chromium.launch({ headless: !HEADED });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } });
const page = await ctx.newPage();

const errs = [];
page.on('pageerror', (e) => errs.push({ kind: 'pageerror', text: e.message, stack: String(e.stack || '').split('\n').slice(0, 3).join(' | ') }));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/favicon|ERR_CONNECTION|Failed to load resource/i.test(t)) return; // 静态资源噪声
  errs.push({ kind: 'console', text: t, stack: '' });
});

// 登录态必须在应用首次初始化前就位（addInitScript）：先 goto 再 evaluate 塞 token，
// 首次导航已被弹回 /login，后续只变 hash 的 goto 不会重新走守卫（v1.10.32 老坑，v1.10.34 修）
await page.addInitScript(([tk, u]) => {
  localStorage.setItem('wb_token', tk);
  localStorage.setItem('wb_user', JSON.stringify(u));
}, [TOKEN, admin.user || { username: 'admin' }]);

const T = 8000;
const seen = async (text, timeout = T) => page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout });
// 点页签：只在 .tabs 里找，免得「今日」跟「今日主线」抢
async function tab(label, mustSee) {
  const btn = page.locator('.tabs button', { hasText: label }).first();
  await btn.waitFor({ state: 'visible', timeout: T });
  await btn.click({ timeout: T });
  for (const t of [].concat(mustSee)) await seen(t);
  await sleep(400); // 让画布/过渡画完再截图
  const f = path.join(SHOTS, `life-${label}.png`);
  await page.screenshot({ path: f, fullPage: true });
  return path.relative(ROOT, f);
}

const shot = {};
try {
  // 侧栏页签存在 + 路由落地
  await page.goto(`${B}/#/life`, { waitUntil: 'domcontentloaded' });
  // 侧栏那条用 href 精确定位：锚点文本是「flag + lifeOS」（图标连字 + 标签），按整串文本匹配永远等不到
  const lifeLink = page.locator('aside.sidebar nav a[href="#/life"]');
  await lifeLink.waitFor({ state: 'visible', timeout: T });
  const lifeTxt = (await lifeLink.innerText()).trim();
  ck('左侧栏出现独立页「lifeOS」', lifeTxt.includes('lifeOS'), lifeTxt);
  const title = (await page.locator('.page-title').first().innerText()).trim();
  ck('路由 /#/life 落到「lifeOS」页', title.startsWith('lifeOS'), title);

  shot.today = await tab('今日', ['今日主线', '（验收）年度目标：把副业做成第二条收入']);
  ck('今日：重点目标 + 今日主线渲染出来', true, shot.today);

  shot.goals = await tab('目标', ['目标树', '（验收）年度目标：把副业做成第二条收入']);
  // KR 只在选中目标后才出现在右栏，而且 KR 标题是 <input> 的 value（不是可等待的文本），
  // 所以：先点树，再等「关键结果 KR」这个标题，最后读输入框的值。
  const row = page.locator('.tree-row', { hasText: '年度目标' }).first();
  await row.waitFor({ state: 'visible', timeout: T });
  const rowTxt = (await row.innerText()).replace(/\s+/g, ' ');
  ck('目标树：年度目标带着进度百分比', /39%/.test(rowTxt), rowTxt);
  await row.click({ timeout: T });
  await seen('关键结果 KR');
  const krRows = page.locator('.kr-row');
  const krN = await krRows.count();
  const kr0 = krN ? await krRows.first().locator('input').first().inputValue() : '';
  const kr1 = krN > 1 ? await krRows.nth(1).locator('input').first().inputValue() : '';
  ck('目标详情：两条 KR 都列出来且标题对得上', krN === 2 && kr0 === '卖出 100 份' && kr1 === '收入 3 万',
    `n=${krN} kr0=${kr0} kr1=${kr1}`);
  await seen('支撑这个目标的行动');
  await page.screenshot({ path: path.join(SHOTS, 'life-目标-详情.png'), fullPage: true });

  // 新建目标的弹窗只在点开时才渲染：模板里引用不存在的变量也只会在这一刻炸，必须真点一次
  await page.locator('button', { hasText: '新建目标' }).first().click({ timeout: T });
  const modal = page.locator('.modal.card', { hasText: '新建目标' }).first();
  await modal.waitFor({ state: 'visible', timeout: T });
  ck('目标：新建弹窗能打开', (await modal.locator('select').count()) === 3, `selects=${await modal.locator('select').count()}`);
  await page.screenshot({ path: path.join(SHOTS, 'life-目标-新建弹窗.png'), fullPage: true });
  await page.locator('.modal-backdrop').first().click({ position: { x: 5, y: 5 }, timeout: T });
  await sleep(200);

  shot.actions = await tab('行动', ['条']);
  // 别拿「主线」当锚点：它同时是下拉里 <option>主线任务</option> 的子串，而 option 永远不可见（等它必超时）
  await page.locator('.list-item .badge.green').first().waitFor({ state: 'visible', timeout: T });
  const actTitles = await page.locator('.list-item input.inline-title').evaluateAll((els) => els.map((e) => e.value));
  ck('行动：两条行动都列出来（标题、类型、主线日）',
    actTitles.length === 2 && actTitles.join('|').includes('写课程大纲') && actTitles.join('|').includes('录一节试听课'),
    JSON.stringify(actTitles));

  shot.habits = await tab('习惯', ['连续 1 天', '撤销今日打卡']);
  // 习惯名也是 input 的 value，读值比等文本可靠
  const habitVal = await page.locator('.card input.inline-title').first().inputValue();
  ck('习惯：习惯名与打卡区渲染出来', habitVal.includes('每天走 8000 步'), habitVal);

  shot.reviews = await tab('复盘与SOP', ['复盘历史', 'SOP 库']);
  const sopVal = await page.locator('.sop input.inline-title').first().inputValue();
  const sopSteps = await page.locator('.sop textarea').first().inputValue();
  ck('复盘与SOP：复盘历史 + 复盘沉淀出的 SOP 都在',
    sopVal.includes('复盘沉淀') && sopSteps.includes('周一上午先写大纲'), `${sopVal} / ${sopSteps}`);

  shot.projects = await tab('项目', ['个项目']);
  const projVal = await page.locator('.card input.inline-title').first().inputValue();
  ck('项目：项目卡片渲染', projVal.includes('写作课'), projVal);

  shot.domains = await tab('领域', ['事业', '个人成长']);
  // v1.10.5 起领域页是一领域一竖列（.dom-cols .dom-col），不再是旧版 .grid .card 矩阵
  ck('领域：六个领域卡片渲染', (await page.locator('.dom-cols .dom-col').count()) === 6);
  // 图标必须真的被字体渲染成字形：漏了 class="material-icons" 时会画出「trending_up」这串字母（宽得多）。
  // 有效连字在 18px 字号下不超过 ~40px；缺失的名字会到 90px 以上。
  const iconW = await page.locator('.dom-cols .dom-col .dom-titlerow .material-icons').evaluateAll((els) => Math.max(...els.map((e) => e.getBoundingClientRect().width)));
  ck('领域：领域图标是字形而不是图标名拼写的字母', iconW > 4 && iconW < 45, `最宽 ${iconW.toFixed(1)}px`);

  shot.graph = await tab('关系', ['个节点', '条关联']);
  // 画布必须真的画了东西：读像素，全空画布的 base64 会短得多
  const ink = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c || !c.width) return -1;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  });
  ck('关系：力导向布局真的画在画布上了', ink > 2000, `不透明像素 = ${ink}`);
  console.log('  截图：', Object.values(shot).join('  '));
} catch (e) {
  ck('浏览器点检未抛异常', false, e.message);
}

await sleep(300);
ck('全程无 JS 报错（pageerror / console.error）', errs.length === 0, JSON.stringify(errs).slice(0, 800));

await browser.close();
stop();
srv.kill('SIGKILL');
console.log(`\n${total.pass} 通过, ${total.fail} 失败`);
if (total.fail) process.exitCode = 1;
