// E2E（v1.10.10，需求⑨）：电子宠物从独立侧栏页「pets」并入「效率工具」页的 tab。
//
// 这次搬家最容易出事的**不是界面，是权限**：页面没了以后，任何还按「页面 pets」写的判断都会
// 静默失效（pageForPath 落到 null = 仅需登录，等于把 /api/pets 敞开给任何登录用户）。所以这个
// 脚本盯三件事：
//   ① 新的授权维度 tools.pets 真的管用：有它才 200，没它就是 403；
//   ② 拿不到 tools 页的人同样 403（不能因为宠物接口"搬过家"就漏掉页面这一层）；
//   ③ **存量授权会自动平移**：老库里 `allowed_pages:['pets']` + `allowed_tabs:{pets:[…]}` 的账号，
//      重启后必须变成 tools 页 + tools 里的 pets 键，且 pets 键被删干净 —— 否则真实用户升级完
//      会发现右下角悬浮宠物和宠物 tab 一起消失。
//
// 顺带用真浏览器过一遍界面：/pets 与 /adopt 旧地址要跳到 /tools?tab=pets，效率工具默认落
// 录音转写、且录音转写是第一个 tab，三个被删掉的 tab（学习计划/学习记录/复盘）不许再出现。
//
// 数据目录用独立子目录，脚本自己建自己删（绝不碰 data/ 根下的正式库）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'tmp-pets-tools-e2e');
const PORT = 3996;
const B = `http://127.0.0.1:${PORT}`;
const DBF = path.join(DATA, 'workbench.sqlite');

let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  <<< ' + String(extra).slice(0, 300)}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
fs.mkdirSync(DATA, { recursive: true });

function startServer() {
  const s = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456', TTS_ROOT: path.join(DATA, 'no-tts') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  s.stdout.on('data', () => {});
  s.stderr.on('data', (d) => console.error('[srv-err]', String(d).slice(0, 300)));
  return s;
}
async function waitUp(tries = 60) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(`${B}/api/system-info`); if (r.ok) return true; } catch { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
}

let srv = startServer();
ck('服务已启动', await waitUp());

// 直接改用户授权（主库 users 表；跳过 API 是为了造出"老库里的存量形状"）
function setUserGrants(username, pages, tabs) {
  const d = new DatabaseSync(DBF);
  d.prepare('UPDATE users SET allowed_pages=?, allowed_tabs=? WHERE username=?')
    .run(JSON.stringify(pages), JSON.stringify(tabs), username);
  d.close();
}
function readUserGrants(username) {
  const d = new DatabaseSync(DBF, { readOnly: true });
  const u = d.prepare('SELECT allowed_pages, allowed_tabs FROM users WHERE username=?').get(username);
  d.close();
  if (!u) return null;
  return { pages: JSON.parse(u.allowed_pages || '[]'), tabs: JSON.parse(u.allowed_tabs || '{}') };
}

const HA = { 'Content-Type': 'application/json' };
let A = null, adminUser = null;

try {
  // 管理员用 DEFAULT_ADMIN 直建，不走管理接口（那是另一套 e2e 的事）
  let r = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: HA, body: JSON.stringify({ username: 'admin', password: 'test123456' }) });
  const lj = await r.json();
  A = { ...HA, Authorization: 'Bearer ' + lj.token };
  ck('管理员登录', r.status === 200 && !!lj.token);
  adminUser = (await (await fetch(`${B}/api/auth/me`, { headers: A })).json()).user;

  console.log('\n== ① tools.pets 是新的授权维度 ==');
  // 建三个用户，用直接写库的方式造授权（管理接口会做 sanitize，这里要的是"就是这个形状"）
  for (const [name, pages, tabs] of [
    ['petuser', ['tools'], { tools: ['pets'] }],     // 有宠物 tab
    ['tooluser', ['tools'], { tools: ['vibe'] }],    // 有工具页、没有宠物 tab
    ['noteonly', ['notes'], {}],                     // 连工具页都没有
  ]) {
    await fetch(`${B}/api/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: name, password: 'test123456', role: 'user' }) });
    setUserGrants(name, pages, tabs);
  }
  async function loginAs(name) {
    const rr = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: HA, body: JSON.stringify({ username: name, password: 'test123456' }) });
    const jj = await rr.json();
    return jj.token ? { ...HA, Authorization: 'Bearer ' + jj.token } : null;
  }
  const L = { pet: await loginAs('petuser'), tool: await loginAs('tooluser'), note: await loginAs('noteonly') };
  ck('三个测试账号都能登录', !!L.pet && !!L.tool && !!L.note);
  // 登录态里必须能看见 tools.pets（前端 canTab('tools','pets') 与 App.vue 悬浮宠物都靠它）
  const mePet = (await (await fetch(`${B}/api/auth/me`, { headers: L.pet })).json()).user;
  ck('petuser 登录态带 allowed_tabs.tools=[pets]', (mePet.allowed_tabs?.tools || []).includes('pets'), JSON.stringify(mePet.allowed_tabs));

  r = await fetch(`${B}/api/pets/state`, { headers: L.pet });
  ck('有 tools.pets → GET /api/pets/state 200', r.status === 200, String(r.status));
  // 原来绑在 adopt/checkin/records/settings/assign 五个子 tab 前缀上的接口，现在一并归到 'pets'
  // 这一个键下（子 tab 只剩 UI 分段），所以勾了 pets 就该全通、没勾就该全挡。
  r = await fetch(`${B}/api/pets/config`, { headers: L.pet });
  ck('有 tools.pets → GET /api/pets/config 200（原 settings 子 tab 的接口已并入 pets）', r.status === 200, String(r.status));
  r = await fetch(`${B}/api/pets/checkins`, { headers: L.pet });
  ck('有 tools.pets → GET /api/pets/checkins 200（原 checkin 子 tab 的接口已并入 pets）', r.status === 200, String(r.status));
  r = await fetch(`${B}/api/pets/config`, { headers: L.tool });
  ck('只有 tools.vibe → GET /api/pets/config 403', r.status === 403, String(r.status));

  r = await fetch(`${B}/api/pets/state`, { headers: L.tool });
  ck('只有 tools.vibe（没勾宠物）→ /api/pets/state 403', r.status === 403, String(r.status));
  r = await fetch(`${B}/api/pets/state`, { headers: L.note });
  ck('连 tools 页都没有 → /api/pets/state 403', r.status === 403, String(r.status));
  // 反向：不受限的管理员照旧全通
  r = await fetch(`${B}/api/pets/state`, { headers: A });
  ck('管理员 → /api/pets/state 200', r.status === 200, String(r.status));

  console.log('\n== ② 未登录不会漏成 200 ==');
  r = await fetch(`${B}/api/pets/state`);
  ck('匿名 → 401（不是 200）', r.status === 401, String(r.status));

  console.log('\n== ③ 存量授权自动平移（这次搬家最关键的一条）==');
  // 造一个"老库形状"的账号：页面里有 pets、细分里勾了宠物子 tab
  await fetch(`${B}/api/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'legacy1', password: 'test123456', role: 'user' }) });
  setUserGrants('legacy1', ['dashboard', 'pets'], { pets: ['pets', 'checkin'], tools: ['vibe', 'plans', 'review'] });
  // 再造一个"细分空数组"的：本来就被挡在宠物外面，迁移不该给它补权
  await fetch(`${B}/api/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'legacy2', password: 'test123456', role: 'user' }) });
  setUserGrants('legacy2', ['dashboard', 'pets'], { pets: [] });
  // 再造一个最刁的：**只**授权了宠物页、且一个宠物子 tab 都没勾。
  // 剥掉 'pets' 之后 allowed_pages 会变成空数组 —— 而空数组在 canAccess 里是"不限制"，
  // 也就是说这里一不小心就会把这人从"只有宠物页"放开成"什么都能看"。这条就是提权防线。
  await fetch(`${B}/api/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'legacy3', password: 'test123456', role: 'user' }) });
  setUserGrants('legacy3', ['pets'], { pets: [] });
  ck('三个老形状账号已造好',
    !!readUserGrants('legacy1') && !!readUserGrants('legacy2') && !!readUserGrants('legacy3'));

  // 让迁移重跑一次：关掉守卫 + 重启进程
  srv.kill();
  await sleep(800);
  { const d = new DatabaseSync(DBF); d.prepare("DELETE FROM settings WHERE key='pets_into_tools_v11010b'").run(); d.close(); }
  srv = startServer();
  ck('重启后服务恢复', await waitUp());

  const g1 = readUserGrants('legacy1'), g2 = readUserGrants('legacy2');
  ck('legacy1 的页里已无 pets', !g1.pages.includes('pets'), JSON.stringify(g1.pages));
  ck('legacy1 补上了 tools 页（原来的 dashboard 保留）', g1.pages.includes('tools') && g1.pages.includes('dashboard'), JSON.stringify(g1.pages));
  ck('legacy1 的 tools 细分补上了 pets', (g1.tabs.tools || []).includes('pets'), JSON.stringify(g1.tabs));
  ck('legacy1 的 allowed_tabs.pets 死键已删除', !('pets' in g1.tabs), JSON.stringify(g1.tabs));
  ck('legacy1 的 tools 细分里 plans/review 死键已清', !(g1.tabs.tools || []).includes('plans') && !(g1.tabs.tools || []).includes('review'), JSON.stringify(g1.tabs.tools));
  ck('legacy1 原本保留的 tools.vibe 没被动', (g1.tabs.tools || []).includes('vibe'), JSON.stringify(g1.tabs.tools));
  ck('legacy2（细分为空 = 原本就看不到宠物）没有被补权',
    !g2.pages.includes('tools') && !(g2.tabs.tools || []).includes('pets'),
    JSON.stringify(g2));
  ck('legacy2 的 pets 页也已摘掉', !g2.pages.includes('pets'), JSON.stringify(g2.pages));
  // legacy3（只授权宠物页 + 空细分）：剥完不能变成空数组（= 全开放提权）
  const g3 = readUserGrants('legacy3');
  ck('★ legacy3 剥掉 pets 后 allowed_pages 不是空数组（空数组 = 不限制，等于提权）',
    g3.pages.length > 0, JSON.stringify(g3));
  ck('★ legacy3 拿到的是 tools 页 + tools 一个 tab 都不开（有页面、什么都点不动）',
    JSON.stringify(g3.pages) === JSON.stringify(['tools']) && Array.isArray(g3.tabs.tools) && g3.tabs.tools.length === 0,
    JSON.stringify(g3));

  // 迁移后重启的服务上，legacy1 真的能用宠物、legacy2/legacy3 真的不能
  const L1 = await loginAs('legacy1'), L2 = await loginAs('legacy2');
  r = await fetch(`${B}/api/pets/state`, { headers: L1 });
  ck('迁移后的 legacy1 → /api/pets/state 200（宠物功能没丢）', r.status === 200, String(r.status));
  r = await fetch(`${B}/api/pets/state`, { headers: L2 });
  ck('迁移后的 legacy2 → /api/pets/state 403（没被扩权）', r.status === 403, String(r.status));
  // legacy3 最要命的一条：他绝不能因为"页面列表被清空"而能看别的模块
  const L3 = await loginAs('legacy3');
  r = await fetch(`${B}/api/pets/state`, { headers: L3 });
  ck('迁移后的 legacy3 → /api/pets/state 403（宠物仍然看不到）', r.status === 403, String(r.status));
  r = await fetch(`${B}/api/notes?limit=1`, { headers: L3 });
  ck('★ 迁移后的 legacy3 → /api/notes 403（没有被"页面清空"放开成全能看）', r.status === 403, String(r.status));
  r = await fetch(`${B}/api/life/domains`, { headers: L3 });
  ck('★ 迁移后的 legacy3 → /api/life/domains 403（同上，换一个页面再确认一遍）', r.status === 403, String(r.status));

  console.log('\n== ④ 真浏览器：旧地址重定向 + 效率工具 tab 栏 ==');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript((t) => { localStorage.setItem('wb_token', t); }, lj.token);
  await ctx.addInitScript((u) => { localStorage.setItem('wb_user', u); }, JSON.stringify(adminUser));
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e).slice(0, 200)));

  // /pets → /tools?tab=pets
  await page.goto(`${B}/#/pets`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  ck('/pets 重定向到 /tools?tab=pets', page.url().includes('/tools') && page.url().includes('tab=pets'), page.url());
  const tabsTxt = await page.locator('.tabs button').allTextContents();
  ck('效率工具 tab 栏第一个是「录音转写」', (tabsTxt[0] || '').trim() === '录音转写', tabsTxt.join(' | '));
  ck('tab 栏里有「电子宠物」', tabsTxt.some((t) => t.includes('电子宠物')), tabsTxt.join(' | '));
  ck('tab 栏里不再有 学习计划/学习记录/复盘',
    !tabsTxt.some((t) => /学习计划|学习记录|复盘/.test(t)), tabsTxt.join(' | '));
  ck('电子宠物 tab 高亮', (await page.locator('.tabs button.active').first().textContent() || '').includes('电子宠物'));
  // 宠物面板自己的子 tab 栏还在（六个子 tab）
  const subTxt = await page.locator('.tabs button').allTextContents();
  ck('宠物面板六个子 tab 都在', ['我的宠物', '领养宠物', '每日打卡', '养育记录', '设置与预览', '宠物分配'].every((t) => subTxt.some((x) => x.includes(t))), subTxt.join(' | '));
  await page.screenshot({ path: path.join(ROOT, 'Logs/shots/pets-tools-pets-tab.png') });

  // 不带 tab 进效率工具 → 默认录音转写
  await page.goto(`${B}/#/tools`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2200);
  ck('不带 tab 进效率工具默认落「录音转写」',
    (await page.locator('.tabs button.active').first().textContent() || '').includes('录音转写'),
    await page.locator('.tabs button.active').first().textContent());

  // /adopt → /tools?tab=pets&sub=adopt，并直开「领养宠物」子 tab
  await page.goto(`${B}/#/adopt`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  ck('/adopt 重定向带 sub=adopt', page.url().includes('tab=pets') && page.url().includes('sub=adopt'), page.url());
  ck('直开的是「领养宠物」子 tab',
    (await page.locator('.tabs button.active').last().textContent() || '').includes('领养宠物'),
    await page.locator('.tabs button.active').last().textContent());

  console.log('\n== ⑤ 侧栏：笔记第三位、电子宠物不再是独立项 ==');
  await page.goto(`${B}/#/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1800);
  const nav = await page.evaluate(() => [...document.querySelectorAll('nav.nav a')].map((a) => a.innerText.trim().split('\n').pop()));
  ck('侧栏前四项 = 首页 / lifeOS / 笔记 / 新闻', nav.slice(0, 4).join('→') === '首页→lifeOS→笔记→新闻', nav.join('→'));
  ck('侧栏里没有「电子宠物」独立项', !nav.includes('电子宠物'), nav.join('→'));

  await page.screenshot({ path: path.join(ROOT, 'Logs/shots/pets-tools-merged.png') });
  ck('浏览器全程无 JS 报错', errs.length === 0, errs.slice(0, 2).join(' | '));
  await browser.close();
} catch (e) {
  fail++;
  console.error('  ✗ 脚本异常:', e.message);
} finally {
  srv.kill();
  await sleep(800);
  try { fs.rmSync(DATA, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* Windows 句柄延迟 */ }
}
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
