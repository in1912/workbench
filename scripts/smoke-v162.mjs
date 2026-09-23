// v1.6.2 冒烟：私有项目页 + 剪贴板采集脚本三件套 + 智作平台嵌入 + Material Icons 单色图标
// A. 私有项目：3 个测试 tab 迁入、TestCenterTab iframe 正常、旧 /tools?tab=dep 回落
// B. 剪贴板：setup/install/uninstall 下载（BOM/内嵌地址/密钥/uid）、错误密钥 403、登记+推送+去重、
//    设备列表、UI 显示来源电脑与下载按钮（仅管理员）；只清理本测试写入的行
// C. 智作平台：/zhizu/ 静态页 + 子服务 health + 代理登录、iframe 同源嵌入渲染
// D. 图标：侧边栏全部 material-icons ligature 生效（宽度<30px，失败会渲染成原文字串）
import { chromium } from 'playwright';

const BASE = 'http://localhost:3000';
let fails = 0;
const ok = (name, cond, extra = '') => { console.log(cond ? `✓ ${name}` : `✗ ${name}${extra ? ' | ' + extra : ''}`); if (!cond) fails++; };

const lr = await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
});
const lj = await lr.json();
if (!lj.token) { console.log('登录失败，中止', lj); process.exit(1); }
const H = { Authorization: 'Bearer ' + lj.token };
ok('登录 admin 成功（uid=' + lj.user.id + '）', lj.user.role === 'admin');

// ================= A. 私有项目 =================
const browser = await chromium.launch();
const ctx = await browser.newContext();
await ctx.addInitScript(([t, u]) => {
  localStorage.setItem('wb_token', t);
  localStorage.setItem('wb_user', u);
}, [lj.token, JSON.stringify(lj.user)]);
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(BASE + '/#/private');
await page.waitForTimeout(1200);
ok('A1 私有项目页标题', (await page.locator('h2.page-title').textContent()) === '私有项目');
for (const t of ['抑郁测试', '心理测试', '职业测试']) {
  ok(`A2 tab「${t}」出现`, await page.locator('.tabs button', { hasText: t }).count() === 1);
}
ok('A3 默认 dep 中心 iframe 渲染', await page.locator('iframe[title*="抑郁"]').count() === 1 || /dep/.test(await page.locator('iframe').first().getAttribute('src') || ''));
await page.locator('.tabs button', { hasText: '心理测试' }).click();
await page.waitForTimeout(600);
ok('A4 切到 pro 中心 iframe 换源', /\/pro\//.test(await page.locator('iframe').first().getAttribute('src') || ''));

// 旧地址回落：/tools?tab=dep 不再属于 tools → 落默认 vibe，且 tools 页无抑郁测试按钮
await page.goto(BASE + '/#/tools?tab=dep');
await page.waitForTimeout(900);
ok('A5 旧 /tools?tab=dep 回落（dep 按钮已不在 tools）', await page.locator('.tabs button', { hasText: '抑郁测试' }).count() === 0);
ok('A6 tools 默认落点=录音转写', ((await page.locator('.tabs button.active').first().textContent().catch(() => '')) || '').includes('录音转写'));

// ================= B. 剪贴板采集 =================
const setRes = await fetch(BASE + '/api/clipboard/agent?type=setup', { headers: H });
const setBuf = new Uint8Array(await setRes.arrayBuffer());
const setBody = new TextDecoder('utf-8').decode(setBuf); // 注意：fetch .text() 会剥掉 BOM，须按字节判断
ok('B1 setup 下载 200', setRes.status === 200);
ok('B2 ps1 文件名', (setRes.headers.get('content-disposition') || '').includes('clipboard-setup.ps1'));
ok('B3 UTF-8 BOM（PS5.1 中文）', setBuf[0] === 0xef && setBuf[1] === 0xbb && setBuf[2] === 0xbf);
ok('B4 内嵌下载来源地址', setBody.includes("$Server = '" + BASE + "'"), BASE);
const keyM = setBody.match(/\$Key\s+= '([0-9a-f]{32})'/);
ok('B5 内嵌 32 位密钥', !!keyM);
ok('B6 内嵌下载者 uid', setBody.includes('$Uid    = ' + lj.user.id));
ok('B7 含登记与推送调用', setBody.includes('agent-register') && setBody.includes('agent-push'));

const inst = await (await fetch(BASE + '/api/clipboard/agent?type=install', { headers: H })).text();
ok('B8 install.bat 引用 ps1 且纯 ASCII', inst.includes('clipboard-setup.ps1') && /^[\x00-\x7f]*$/.test(inst));
const uninst = await (await fetch(BASE + '/api/clipboard/agent?type=uninstall', { headers: H })).text();
ok('B9 uninstall.bat 自包含可卸载', uninst.includes('WorkbenchClipboard') && uninst.includes('Remove-ItemProperty'));

ok('B10 未登录下载被拒', (await fetch(BASE + '/api/clipboard/agent?type=setup')).status === 401);
const AK = { 'Content-Type': 'application/json' };
ok('B11 错误密钥登记 403', (await fetch(BASE + '/api/clipboard/agent-register', { method: 'POST', headers: AK, body: JSON.stringify({ key: 'bad', uid: lj.user.id, host: 'X' }) })).status === 403);

const HOST = 'SMOKE-CLIP-PC';
const reg = await fetch(BASE + '/api/clipboard/agent-register', { method: 'POST', headers: AK, body: JSON.stringify({ key: keyM[1], uid: lj.user.id, host: HOST }) });
ok('B12 正确密钥登记 ok', reg.status === 200 && (await reg.json()).ok === true);
const MARK = 'SMOKE-剪贴板推送-' + Date.now();
const push = await fetch(BASE + '/api/clipboard/agent-push', { method: 'POST', headers: AK, body: JSON.stringify({ key: keyM[1], uid: lj.user.id, host: HOST, content: MARK }) });
const pushJ = await push.json();
ok('B13 推送入库返回 id', push.status === 200 && pushJ.id > 0);
const push2 = await (await fetch(BASE + '/api/clipboard/agent-push', { method: 'POST', headers: AK, body: JSON.stringify({ key: keyM[1], uid: lj.user.id, host: HOST, content: MARK }) })).json();
ok('B14 10 分钟内同内容去重', push2.dup === true && !push2.id);

const clips = await (await fetch(BASE + '/api/clipboard', { headers: H })).json();
const mine = clips.find((c) => c.content === MARK);
ok('B15 列表可见且来源电脑在前', !!mine && mine.device === HOST && mine.source === 'agent');
const devs = await (await fetch(BASE + '/api/clipboard/devices', { headers: H })).json();
const dv = devs.find((d) => d.host === HOST);
ok('B16 设备列表含本机且计数≥1', !!dv && dv.push_count >= 1);

// UI：剪贴板 tab
await page.goto(BASE + '/#/tools?tab=clip');
await page.waitForTimeout(1000);
ok('B17 管理员见 3 个下载按钮', await page.locator('button', { hasText: '下载' }).count() === 3);
ok('B18 设备行显示登记电脑', (await page.locator('.clip-dev').filter({ hasText: HOST }).count()) === 1);
const rowText = await page.locator('.list-item').filter({ hasText: MARK }).first().locator('.meta').textContent();
ok('B19 内容前有「电脑·时间」', rowText.includes(HOST) && /\d{4}-\d{2}-\d{2}/.test(rowText), rowText || '');

// 清理：仅删本测试写入的行
await fetch(BASE + '/api/clipboard/' + mine.id, { method: 'DELETE', headers: H });
const after = await (await fetch(BASE + '/api/clipboard', { headers: H })).json();
ok('B20 清理测试推送行', !after.some((c) => c.content === MARK));

// ================= C. 智作平台 =================
const zh = await fetch(BASE + '/zhizu/');
const zhBody = await zh.text();
ok('C1 /zhizu/ 静态页 200', zh.status === 200 && zhBody.includes('/zhizu/assets'));
const health = await (await fetch(BASE + '/zhizu/api/health')).json();
ok('C2 子服务 health（经代理）', health && (health.name === 'wenanku' || health.ok !== undefined), JSON.stringify(health));
const zl = await fetch(BASE + '/zhizu/api/auth/login', { method: 'POST', headers: AK, body: JSON.stringify({ username: 'admin', password: 'admin123' }) });
const zlj = await zl.json();
ok('C3 代理登录智作默认 admin', zl.status === 200 && !!zlj.token);

await page.locator('.tabs button', { hasText: '智作平台' }).click();
await page.waitForTimeout(2500);
const frame = page.frames().find((f) => f.url().startsWith(BASE + '/zhizu'));
ok('C4 iframe 同源加载 /zhizu/', !!frame, page.frames().map((f) => f.url()).join(' , '));
if (frame) {
  const ftxt = (await frame.locator('body').textContent().catch(() => '')) || '';
  ok('C5 帧内渲染（文案库界面）', ftxt.includes('登录') || ftxt.includes('文案'), ftxt.slice(0, 40));
}
ok('C6 智作平台是 tools 第一个 tab', (await page.locator('.tabs button').first().textContent()).includes('智作平台'));

// ================= D. 单色图标 =================
const css = await fetch(BASE + '/material-icons/material-icons.css');
ok('D1 图标字体 CSS 可达', css.status === 200 && (await css.text()).includes('Material Icons'));
await page.goto(BASE + '/#/');
await page.waitForTimeout(1200);
const iconInfo = await page.evaluate(() => {
  return [...document.querySelectorAll('.sidebar .nav .ico.material-icons')].map((el) => ({
    text: el.textContent.trim(), w: el.offsetWidth,
  }));
});
ok('D2 侧边栏图标数量', iconInfo.length >= 16, String(iconInfo.length));
const bad = iconInfo.filter((i) => i.w >= 30 || !i.text);
ok('D3 全部 ligature 生效（单字形渲染）', bad.length === 0, bad.map((b) => b.text + ':' + b.w).join(' , '));
ok('D4 含新增 smart_toy/manage_accounts', iconInfo.some((i) => i.text === 'smart_toy') && iconInfo.some((i) => i.text === 'manage_accounts'));

ok('D5 无页面 JS 报错', errors.length === 0, errors.join(' ; '));
await browser.close();
console.log(fails ? `\n✗ ${fails} 项未通过` : '\n全部通过');
process.exit(fails ? 1 : 0);
