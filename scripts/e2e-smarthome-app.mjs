// E2E：JARVIS 独立应用（WB_MODE=smarthome）——飞牛 fpk 里的那个形态
//
// 验的是「抽出来之后还成立」这件事，四组：
//   A. 免登录：不带给任何 token 也进得去，/api 一律 200，/auth/me 回内置本地账号
//   B. 外壳：侧栏 6 个模块（原页签升格），不再是页内 tab 条；选中项记忆在 localStorage.wb_sh_tab
//   C. 模块内容照旧：智能板 7 个子页签、红绿灯 3 个（子页签一个都没丢）
//   D. 模式互斥：/system-info 报 smarthome，且工作台专属路由（/api/pets、/api/emails）在本模式下不存在
//      —— 免登录 + 全路由挂载 = 谁都能读别人邮箱，这条是安全边界，必须守住
//
// 用法：node scripts/e2e-smarthome-app.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'tmp-sh-app-e2e');
const PORT = 3998;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  <<< ' + extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let srv, browser;
try {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });

  srv = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, WB_MODE: 'smarthome', PORT: String(PORT), DATA_DIR: DATA },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', () => {});
  srv.stderr.on('data', (d) => console.error('[srv-err]', String(d).slice(0, 200)));
  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { await fetch(`${B}/api/system-info`); up = true; break; } catch { /* 未就绪 */ }
  }
  if (!up) throw new Error('server not ready in 20s');

  // ---------- A. 免登录 ----------
  let r = await fetch(`${B}/api/system-info`);
  let j = await r.json();
  ck('A1 /system-info 免登录可读，且 mode=smarthome', r.status === 200 && j.mode === 'smarthome', `status=${r.status} mode=${j.mode}`);
  ck('A2 空库首启时版本/名称是「JARVIS 1.0.0」而不是工作台的兜底值', j.name === 'JARVIS' && j.version === '1.0.0', `${j.name} / ${j.version}`);

  r = await fetch(`${B}/api/auth/me`);
  j = await r.json();
  ck('A3 /auth/me 免登录回内置本地账号（role=admin）', r.status === 200 && j.user && j.user.role === 'admin' && j.user.username === 'local', JSON.stringify(j).slice(0, 160));
  const localId = j.user && j.user.id;

  // 内置账号必须是「可进但不可登」：password_hash='*' 不含 ':'，verifyPassword 恒 false；
  // 且登录接口本身在这个应用里压根不存在（白名单里只有 /auth/me）——没有登录页，就没有登录口。
  r = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'local', password: '' }) });
  ck('A4 登录接口在本应用里不存在（无登录页就没有登录口）', r.status === 404, `status=${r.status}`);

  // 免登录的代价 = 后端绝不能把工作台的数据端点也敞开。这条是安全边界，靠 index.js 的
  // SH_API_ALLOW 白名单闸门守住；白名单被改宽会在这里当场红灯（尤其 /emails —— 那是真实邮件）。
  for (const [p, label] of [['/api/pets', '电子宠物'], ['/api/emails', '邮箱'], ['/api/notes', '笔记'], ['/api/monitor/devices', '电脑监控'], ['/api/business/skills', '业务系统'], ['/api/fnos/package', '工作台 fpk 下载']]) {
    const rr = await fetch(`${B}${p}`);
    ck(`A5 工作台专属端点 ${p}（${label}）在本模式下不存在`, rr.status === 404, `status=${rr.status}`);
  }
  // JARVIS 自己那几个必须在（否则是砍过头）。
  // 视频中心的 /vc/tree 在没配视频根目录时回 400（根目录不存在），故判据是「不是 404」= 路由在。
  for (const [p, label] of [['/api/mihome/status', '米家'], ['/api/xiaozhi/config', '智能板'], ['/api/cclight/files', '红绿灯'], ['/api/vc/tree?path=/', '视频中心'], ['/api/messages/contacts', '用户选择器']]) {
    const rr = await fetch(`${B}${p}`);
    ck(`A6 JARVIS 端点 ${p}（${label}）在`, rr.status !== 404 && rr.status !== 500, `status=${rr.status}`);
  }

  // 烧录工具包
  r = await fetch(`${B}/api/flashtool/info`);
  j = await r.json();
  ck('A7 /flashtool/info ready，两个设备固件都齐', r.status === 200 && j.ready === true && j.xiaozhi.ready && j.cclight.ready, JSON.stringify({ ready: j.ready, x: j.xiaozhi && j.xiaozhi.ready, c: j.cclight && j.cclight.ready }));
  ck('A8 启动脚本编码体检通过（serve.ps1 有 BOM / .cmd 无 BOM）', j.launcher && j.launcher.ok === true, JSON.stringify(j.launcher));

  r = await fetch(`${B}/api/flashtool/package`);
  const zipBuf = Buffer.from(await r.arrayBuffer());
  const patch = r.headers.get('x-flash-patch') || '';
  const cdisp = r.headers.get('content-disposition') || '';
  ck('A9 烧录包可下载且 URL/密钥都注入成功', r.status === 200 && zipBuf.length > 4 * 1024 * 1024 && patch === 'url=true,key=true', `status=${r.status} size=${zipBuf.length} patch=${patch}`);
  ck('A10 中文包名走 RFC5987（filename*=UTF-8\'\'）', /filename\*=UTF-8''/.test(cdisp), cdisp);
  ck('A11 包内两张固件都在（zip 里能搜到目录名）', zipBuf.includes(Buffer.from('firmware/xiaozhi/xiaozhi.bin', 'utf8')) && zipBuf.includes(Buffer.from('firmware/cclight/main.py', 'utf8')));
  ck('A12 包内含 esptool 烧录引擎与本地服务器脚本', zipBuf.includes(Buffer.from('vendor/esptool-js.bundle.js', 'utf8')) && zipBuf.includes(Buffer.from('serve.ps1', 'utf8')));

  // ---------- B/C. 前端外壳 ----------
  const { chromium } = await import('playwright');
  browser = await chromium.launch();
  const ctx = await browser.newContext();
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));

  // 刻意不带任何 token —— 免登录就该这样进得去
  await p.goto(`${B}/`);
  await p.waitForSelector('.sh-shell', { timeout: 15000 });
  await sleep(700);

  ck('B1 打开就是应用外壳，没有被踢到登录页', (await p.locator('.sh-shell').count()) === 1 && !p.url().includes('login'), p.url());
  ck('B2 页面上没有登录表单', (await p.locator('input[type=password]').count()) === 0);
  const navTexts = (await p.locator('.sh-nav-item .sh-label').allInnerTexts()).map((t) => t.trim());
  ck('B3 左侧 6 个模块（原来那 6 个页签）', navTexts.join('|') === '米家|智能板|Agent红绿灯|米家设置|米家参数翻译|视频中心', navTexts.join('|'));
  ck('B4 原来的页内 tab 条不再出现（已升格为侧栏）', (await p.locator('h2.page-title').count()) === 0 && (await p.locator('.tabs').count()) === 0);
  ck('B5 顶栏显示应用名与版本', (await p.locator('.sh-title').innerText()).includes('JARVIS') && (await p.locator('.sh-ver').count()) === 1, await p.locator('.sh-brand').innerText());
  await p.waitForFunction(() => { const el = document.querySelector('.sh-net'); return el && /在线|离线/.test(el.textContent); }, null, { timeout: 8000 });
  ck('B6 顶栏在线状态探测到底（免登录下不会因 401 显示离线）', (await p.locator('.sh-net').innerText()).includes('在线'), await p.locator('.sh-net').innerText());
  await p.screenshot({ path: path.join(ROOT, 'Logs', 'e2e-sh-app-shell.png'), fullPage: true });

  // 切模块 + 记忆
  await p.locator('.sh-nav-item', { hasText: '智能板' }).click();
  await sleep(500);
  ck('B7 点侧栏切模块，内容区跟着换', (await p.locator('.sh-nav-item.active .sh-label').innerText()).trim() === '智能板', await p.locator('.sh-nav-item.active').innerText());
  await p.reload();
  await p.waitForSelector('.sh-shell');
  await sleep(900);
  ck('B8 当前模块记忆在 localStorage.wb_sh_tab（刷新仍在智能板）', (await p.locator('.sh-nav-item.active .sh-label').innerText()).trim() === '智能板');

  // ---------- C. 各模块的子页签一个都没丢 ----------
  await p.waitForSelector('.xz-tabs button');
  const xzTabs = (await p.locator('.xz-tabs button').allInnerTexts()).map((t) => t.trim().replace(/^[^一-龥A-Za-z0-9]+/, ''));
  ck('C1 智能板 7 个子页签（贾维斯/Agent对话记录/装机向导/语音控米家/视频对话/对话记录/摄像头）',
    xzTabs.join('|') === '贾维斯J.A.R.V.I.S.|Agent对话记录|装机向导|语音控米家|视频对话|对话记录|摄像头', xzTabs.join('|'));

  // 装机向导第②步 = 本地烧录工具包按钮（本轮的核心交付）
  await p.locator('.xz-tabs button', { hasText: '装机向导' }).click();
  await p.waitForSelector('.xz-step');
  const guideTxt = await p.evaluate(() => document.body.innerText);
  ck('C2 装机向导第②步给的是「下载本地烧录工具包」，并写明双击启动', guideTxt.includes('下载本地烧录工具包') && guideTxt.includes('启动烧录.cmd'), '');
  // 折叠区里的文字用 innerText 取不到（<details> 收起时 innerText 不含隐藏内容），故读 textContent
  const adv = await p.evaluate(() => {
    const el = document.querySelector('details.xz-adv');
    return el ? el.textContent.replace(/\s+/g, '') : '';
  });
  ck('C3 手工合并镜像降级为折叠说明，且带「会覆盖 nvs / 配网要重做」警告',
    adv.length > 0 && adv.includes('write-flash0x0') && adv.includes('覆盖nvs分区') && adv.includes('配网与绑定要重做'), adv.slice(0, 200));

  // 红绿灯 3 个子页签
  await p.locator('.sh-nav-item', { hasText: 'Agent红绿灯' }).click();
  await p.waitForSelector('.ccp-tabs button');
  const ccTabs = (await p.locator('.ccp-tabs button').allInnerTexts()).map((t) => t.trim().replace(/^[^一-龥A-Za-z0-9]+/, ''));
  ck('C4 红绿灯 3 个子页签（功能介绍/下载安装包/安装步骤）', ccTabs.join('|') === '功能介绍|下载安装包|安装步骤', ccTabs.join('|'));
  await p.locator('.ccp-tabs button', { hasText: '安装步骤' }).click();
  await sleep(300);
  const ccTxt = await p.evaluate(() => document.body.innerText);
  ck('C5 红绿灯安装页第①步也挂了同一个烧录包下载按钮', ccTxt.includes('下载本地烧录工具包'));

  // 其余四个模块各自能渲染（不白屏）。按钮文字有前缀关系（「米家」是「米家设置」的子串），
  // 必须 exact 匹配，否则 strict mode 一次命中三个按钮。
  for (const label of ['米家', '米家设置', '米家参数翻译', '视频中心']) {
    await p.getByRole('button', { name: label, exact: true }).click();
    await sleep(900);
    ck(`C6 「${label}」模块有内容渲染（不白屏）`, (await p.locator('.card').count()) > 0);
  }

  ck('C7 全程无前端 JS 报错', errors.length === 0, errors.join(' | '));

  // ---------- D. 工作台形态不受影响（同一个 server，换个 env）----------
  // 白名单闸门必须是「只在本模式生效」的条件分支，否则下一个进程里工作台的邮箱/笔记全变 404。
  // （跑本脚本前先跑一次工作台模式的 e2e 才算数——这里只守源码这一行不被写成无条件挂载。）
  const src = fs.readFileSync(path.join(ROOT, 'server', 'index.js'), 'utf8');
  ck('D1 接口白名单闸门带 SH_MODE 条件（不是无条件生效）',
    /if \(!SH_MODE\) return next\(\);\s*\n\s*const p = req\.path;/.test(src));
  void localId;
} catch (e) {
  fail++;
  console.error('  ✗ 异常：', e.message);
} finally {
  try { if (browser) await browser.close(); } catch { /* 忽略 */ }
  try { if (srv) srv.kill(); } catch { /* 忽略 */ }
  await sleep(600);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }
}

console.log(`\n${fail === 0 ? '全绿' : '有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
