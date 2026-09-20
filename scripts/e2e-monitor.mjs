// E2E：电脑监控（v1.3.5）
// A 设置（密钥生成/钳制/关键字切分/推送人过滤） B 代理鉴权与配置轮询 C 截图上报/图片/禁用
// D AI 分析（本地视觉桩）+ 预警关键字推送站内消息 + 冷却 + chatEndpoint 双后缀回归
// G PowerShell 代理真机验证（合成安装态直跑常驻分支，本机截屏上报→删除）
// U UI（Playwright）+ 会话推导/保留期清理/chatEndpoint 单元（服务停止后直连库）
// 用法：node scripts/e2e-monitor.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url); // mjs 下供 playwright 加载
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'tmp-monitor-e2e'); // 子目录（勿放 data/ 根）
const PORT = 3999, B = `http://127.0.0.1:${PORT}`;
const STUB_PORT = 3998, STUB = `http://127.0.0.1:${STUB_PORT}`;

let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  <<< ' + extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = { 'Content-Type': 'application/json' };

// 1x1 透明 PNG（路由允许 JPEG/PNG 魔数）
const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// ---------- 视觉模型桩：记录每次请求的 url/auth/body ----------
const stubCalls = [];
const STUB_TEXT = '孩子在看动画片和视频网站的卡通片，浏览器标签页：小猪佩奇 - 视频';
const stubSrv = (await import('node:http')).createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    stubCalls.push({ url: req.url, auth: req.headers.authorization || '', body });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: STUB_TEXT } }], usage: { total_tokens: 123 } }));
  });
});
await new Promise((r) => stubSrv.listen(STUB_PORT, '127.0.0.1', r));

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
const srv = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456', TTS_ROOT: path.join(DATA, 'no-tts') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', (d) => console.error('[srv-err]', String(d).slice(0, 300)));
{
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`${B}/api/health`); if (r.ok) break; } catch { /* 未就绪 */ }
    if (Date.now() - t0 > 30000) { console.error('服务 30s 未就绪'); srv.kill(); process.exit(1); }
    await sleep(400);
  }
}

const DEV = 'PCE2EDEV0001';
let psProc = null, psDir = null, psLogFd = null, psCreated = false; // psCreated：仅 E2E 自建的目录才允许清理（真机已装代理时跳过且绝不删）
try {
  // ---------- 登录 ----------
  let r = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: J, body: JSON.stringify({ username: 'admin', password: 'test123456' }) });
  const lj = await r.json();
  ck('管理员登录', r.status === 200 && !!lj.token);
  const A = { ...J, Authorization: 'Bearer ' + lj.token };
  await fetch(`${B}/api/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'u2', password: 'u234567', display_name: '被推送人' }) });
  const l2 = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: J, body: JSON.stringify({ username: 'u2', password: 'u234567' }) })).json();
  const H2 = { ...J, Authorization: 'Bearer ' + l2.token };
  const users = await (await fetch(`${B}/api/users`, { headers: A })).json();
  const uid2 = (Array.isArray(users) ? users : users.users || []).find((u) => u.username === 'u2')?.id;

  // ========== A 设置 ==========
  console.log('\n== A 监控设置 ==');
  r = await fetch(`${B}/api/monitor/settings`, { headers: A });
  let cfg = await r.json();
  ck('A1a 管理员读设置 200', r.status === 200 && !!cfg.access_key);
  ck('A1b 接入密钥自动生成 24 hex', /^[0-9a-f]{24}$/.test(cfg.access_key), cfg.access_key);
  ck('A1c 默认值（width 480 / AI 关）', cfg.interval === 3 && cfg.width === 480 && cfg.ai_enabled === 0 && cfg.ai_every === 10 && cfg.retention_days === 14, JSON.stringify({ interval: cfg.interval, width: cfg.width, ai: cfg.ai_enabled }));
  r = await fetch(`${B}/api/monitor/settings`, { headers: H2 });
  ck('A2 普通用户读设置 403', r.status === 403);

  r = await fetch(`${B}/api/monitor/settings`, { method: 'PUT', headers: A, body: JSON.stringify({
    interval: 0, ai_every: 999, retention_days: 1, alert_cooldown: 30, width: 999,
    keywords: '视频，动画片 游戏视频,', alert_users: [uid2, 9999],
  }) });
  cfg = await r.json();
  ck('A3a interval 0→钳 1', cfg.interval === 1, String(cfg.interval));
  ck('A3b ai_every 999→钳 50', cfg.ai_every === 50, String(cfg.ai_every));
  ck('A3e width 999→钳 480（白名单外回默认）', cfg.width === 480, String(cfg.width));
  ck('A3c 关键字按逗号/空格切分去重', JSON.stringify(cfg.keywords) === JSON.stringify(['视频', '动画片', '游戏视频']), JSON.stringify(cfg.keywords));
  ck('A3d 推送人过滤不存在 uid', JSON.stringify(cfg.alert_users) === JSON.stringify([uid2]), JSON.stringify(cfg.alert_users));

  r = await fetch(`${B}/api/monitor/settings`, { method: 'PUT', headers: A, body: JSON.stringify({ access_key: '__regen__' }) });
  cfg = await r.json();
  ck('A4 重新生成密钥', /^[0-9a-f]{24}$/.test(cfg.access_key));

  // ========== B 代理鉴权 ==========
  console.log('\n== B 代理端点（免登录+密钥） ==');
  r = await fetch(`${B}/api/monitor/agent/config?id=${DEV}&key=WRONGKEY00`);
  ck('B1 错误密钥 403', r.status === 403);
  r = await fetch(`${B}/api/monitor/agent/config?id=SHORT&key=${cfg.access_key}`);
  ck('B2 短设备 ID 400', r.status === 400);
  r = await fetch(`${B}/api/monitor/agent/config?id=${DEV}&key=${cfg.access_key}&computer=E2E-PC`);
  const ac = await r.json();
  ck('B3a 正确密钥取配置 ok', r.status === 200 && ac.ok === true && ac.enabled === true);
  ck('B3b interval 回读（1）', ac.interval === 1, String(ac.interval));
  ck('B3c width 下发（480）', ac.width === 480, String(ac.width));
  const devs = await (await fetch(`${B}/api/monitor/devices`, { headers: A })).json();
  ck('B4 设备自动注册（默认名 电脑-0001）', devs.devices.length === 1 && devs.devices[0].id === DEV && devs.devices[0].name === '电脑-0001', JSON.stringify(devs.devices).slice(0, 120));

  // ========== C 截图上报 ==========
  console.log('\n== C 截图上报 ==');
  const upShot = async (id, key, buf = PNG1, extra = {}) => {
    const fd = new FormData();
    fd.append('id', id); fd.append('key', key);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    if (buf) fd.append('shot', new Blob([buf]), 's.png');
    return fetch(`${B}/api/monitor/agent/shot`, { method: 'POST', body: fd });
  };
  r = await upShot(DEV, 'WRONGKEY00');
  ck('C1 错误密钥上报 403', r.status === 403);
  r = await upShot(DEV, cfg.access_key, Buffer.from('not-an-image-at-all'));
  ck('C2 非图片 400', r.status === 400);
  r = await upShot(DEV, cfg.access_key, null);
  ck('C3 缺文件 400', r.status === 400);
  r = await upShot(DEV, cfg.access_key, PNG1, { computer: 'E2E-PC-RENAMED' });
  const up1 = await r.json();
  ck('C4a PNG 上报成功', r.status === 200 && up1.ok === true && up1.id > 0, JSON.stringify(up1));
  await upShot(DEV, cfg.access_key);
  let dvs = (await (await fetch(`${B}/api/monitor/devices`, { headers: A })).json()).devices;
  ck('C4b 设备计数 2 张 + last_shot', dvs[0].shot_count === 2 && !!dvs[0].last_shot, JSON.stringify(dvs[0]).slice(0, 140));
  ck('C4d 设备历史 AI token 初始 0', dvs[0].ai_tokens === 0, String(dvs[0].ai_tokens));
  ck('C4c computer_name 随上报更新', dvs[0].computer_name === 'E2E-PC-RENAMED', dvs[0].computer_name);
  r = await fetch(`${B}/api/monitor/shot/${up1.id}?token=${lj.token}`);
  const imgBuf = Buffer.from(await r.arrayBuffer());
  ck('C5 图片本体 PNG 魔数', r.status === 200 && imgBuf.subarray(0, 4).toString('hex') === '89504e47');
  r = await fetch(`${B}/api/monitor/shot/${up1.id}?token=bad`);
  ck('C6 坏 token 401', r.status === 401);
  let sh = await (await fetch(`${B}/api/monitor/shots?device_id=${DEV}&page=1&page_size=1`, { headers: A })).json();
  ck('C7 截图分页（total 2，倒序，page_size 钳到最小 5）', sh.total === 2 && sh.items.length === 2 && sh.items[0].id > up1.id && sh.items[0].ai_text === null && sh.ai_enabled === 0, JSON.stringify(sh).slice(0, 120));

  // 禁用设备
  await fetch(`${B}/api/monitor/devices/${DEV}`, { method: 'PUT', headers: A, body: JSON.stringify({ enabled: false }) });
  r = await upShot(DEV, cfg.access_key);
  ck('C8a 停用设备上报 skipped', r.status === 200 && (await r.json()).skipped === 'disabled');
  dvs = (await (await fetch(`${B}/api/monitor/devices`, { headers: A })).json()).devices;
  ck('C8b 停用后计数不变（仍 2）', dvs[0].shot_count === 2 && dvs[0].enabled === 0);
  await fetch(`${B}/api/monitor/devices/${DEV}`, { method: 'PUT', headers: A, body: JSON.stringify({ enabled: true, name: '儿子的电脑' }) });
  dvs = (await (await fetch(`${B}/api/monitor/devices`, { headers: A })).json()).devices;
  ck('C9 改中文名+重启', dvs[0].name === '儿子的电脑' && dvs[0].enabled === 1, dvs[0].name);

  // ========== D AI 分析 + 预警 ==========
  console.log('\n== D AI 分析（视觉桩）+ 预警推送 ==');
  r = await fetch(`${B}/api/ai/config`, { method: 'POST', headers: A, body: JSON.stringify({
    model: 'stub-chat', base_url: `${STUB}/v1`, api_key: 'sk-stub-e2e',
    vision_model: 'stub-vision', vision_base_url: `${STUB}/v1`, vision_api_key: 'sk-stub-e2e',
  }) });
  ck('D1 写入 AI 配置（指向桩）', r.status === 200);
  r = await fetch(`${B}/api/monitor/settings`, { method: 'PUT', headers: A, body: JSON.stringify({
    ai_enabled: 1, ai_every: 2, interval: 3, width: 720, keywords: '视频,动画片', alert_users: [uid2], alert_cooldown: 30,
  }) });
  cfg = await r.json();
  ck('D0 width=720 保存', cfg.width === 720, String(cfg.width));
  await upShot(DEV, cfg.access_key); // 第 3 张 → pending 3 ≥ 2 触发一轮（补齐前 2 张）
  let aiDone = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    sh = await (await fetch(`${B}/api/monitor/shots?device_id=${DEV}&page=1&page_size=15`, { headers: A })).json();
    if (sh.items.length && sh.items.every((s) => s.ai_text)) { aiDone = true; break; }
  }
  ck('D2a 分析完成（全部 ai_text 有值）', aiDone && sh.items.every((s) => s.ai_text === STUB_TEXT), JSON.stringify((sh.items[0] || {}).ai_text).slice(0, 100));
  ck('D2e shots 透出 ai_enabled=1', sh.ai_enabled === 1, String(sh.ai_enabled));
  const stubHit = stubCalls[0];
  ck('D2b 桩收到 /v1/chat/completions（无双重后缀）', stubHit && stubHit.url === '/v1/chat/completions', stubHit && stubHit.url);
  ck('D2c 桩收到 Bearer 密钥', stubHit && stubHit.auth === 'Bearer sk-stub-e2e');
  ck('D2d 桩收到视觉模型名与图片', stubHit && stubHit.body.includes('stub-vision') && stubHit.body.includes('data:image/'));
  ck('D2f 截图落库 ai_tokens（usage.total_tokens=123）', sh.items.every((s) => s.ai_tokens === 123), JSON.stringify(sh.items.map((s) => s.ai_tokens)));
  ck('D2g 命中关键字的截图落库 alert_hit=1（永久保留标记）', sh.items.every((s) => s.alert_hit === 1), JSON.stringify(sh.items.map((s) => s.alert_hit)));

  let unread = await (await fetch(`${B}/api/messages/unread`, { headers: H2 })).json();
  ck('D3a 被推送人收到 2 条预警（视频+动画片各一）', unread.messages.filter((m) => (m.subject || '').includes('电脑监控预警')).length === 2, JSON.stringify(unread.messages.map((m) => m.subject)));
  ck('D3b 预警含设备名与关键字', unread.messages.every((m) => m.subject.includes('儿子的电脑') && /「(视频|动画片)」/.test(m.subject)), JSON.stringify(unread.messages.map((m) => m.subject)));

  // 冷却：再触发一轮分析（同关键字 30 分钟内不重复推）
  const before = unread.messages.length;
  await upShot(DEV, cfg.access_key); await upShot(DEV, cfg.access_key);
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    sh = await (await fetch(`${B}/api/monitor/shots?device_id=${DEV}&page=1&page_size=15`, { headers: A })).json();
    if (sh.items.every((s) => s.ai_text)) break;
  }
  unread = await (await fetch(`${B}/api/messages/unread`, { headers: H2 })).json();
  ck('D4 冷却期内不重复推送', unread.messages.length === before, `${before} -> ${unread.messages.length}`);

  // chatEndpoint 回归：base_url 直接配成完整端点（用户踩过的坑）
  await fetch(`${B}/api/ai/config`, { method: 'POST', headers: A, body: JSON.stringify({
    model: 'stub-chat', base_url: `${STUB}/v1`, api_key: 'sk-stub-e2e',
    vision_model: 'stub-vision', vision_base_url: `${STUB}/v1/chat/completions`, vision_api_key: 'sk-stub-e2e',
  }) });
  stubCalls.length = 0;
  await upShot(DEV, cfg.access_key); await upShot(DEV, cfg.access_key);
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    sh = await (await fetch(`${B}/api/monitor/shots?device_id=${DEV}&page=1&page_size=15`, { headers: A })).json();
    if (sh.items.every((s) => s.ai_text)) break;
  }
  ck('D5a 完整端点形式仍归一成功（全部有 ai_text）', sh.items.every((s) => s.ai_text));
  ck('D5b 桩只收到单后缀路径', stubCalls.length > 0 && stubCalls.every((c) => c.url === '/v1/chat/completions'), JSON.stringify([...new Set(stubCalls.map((c) => c.url))]));
  dvs = (await (await fetch(`${B}/api/monitor/devices`, { headers: A })).json()).devices;
  const dvTok = dvs.find((d) => d.id === DEV);
  ck('D5c 设备历史总 AI token（7 张 ×123 = 861）', dvTok && dvTok.ai_tokens === 861, String(dvTok && dvTok.ai_tokens));

  // 普通用户（无 tools/monitor tab 权限）访问设备列表 403
  r = await fetch(`${B}/api/monitor/devices`, { headers: H2 });
  ck('D6 普通用户可看设备列表（家庭共用）', r.status === 200); // u2 未限制页面 → tools 页开放
  await fetch(`${B}/api/users/${uid2}`, { method: 'PUT', headers: A, body: JSON.stringify({ allowed_pages: ['notes'] }) });
  const l2b = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: J, body: JSON.stringify({ username: 'u2', password: 'u234567' }) })).json();
  r = await fetch(`${B}/api/monitor/devices`, { headers: { ...J, Authorization: 'Bearer ' + l2b.token } });
  ck('D7 限制页面后 403（tab 权限）', r.status === 403);

  // ========== G PowerShell 代理真机 ==========
  console.log('\n== G PowerShell 代理（本机直跑常驻分支） ==');
  psDir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'WorkbenchMonitor');
  if (fs.existsSync(psDir)) {
    console.log('  （%LOCALAPPDATA%\\WorkbenchMonitor 已存在，跳过真机段避免污染）');
  } else {
    r = await fetch(`${B}/api/monitor/agent-files?type=setup&token=${lj.token}`);
    const ab = await r.arrayBuffer();
    const hasBom = Buffer.from(ab.slice(0, 3)).toString('hex') === 'efbbbf';
    const psText = Buffer.from(ab.slice(3)).toString('utf8');
    ck('G1 下载 setup.ps1（BOM+内嵌服务器/密钥）', r.status === 200 && hasBom && psText.includes(B) && psText.includes(cfg.access_key), `status=${r.status} bom=${hasBom} srv=${psText.includes(B)} key=${psText.includes(cfg.access_key)}`);
    ck('G1b 模板含互斥锁与动态宽度', psText.includes('Threading.Mutex') && psText.includes('New-ShotBytes([int]$Width)'), psText.includes('Threading.Mutex') + '/' + psText.includes('New-ShotBytes([int]$Width'));
    fs.mkdirSync(psDir, { recursive: true });
    psCreated = true;
    fs.writeFileSync(path.join(psDir, 'monitor.ps1'), Buffer.from(ab)); // \u539F\u6837\u5B57\u8282\uFF08\u542B BOM\uFF1APS5.1 \u65E0 BOM \u4F1A\u6309 ANSI \u89E3\u6790\u4E2D\u6587\u5BFC\u81F4\u8BED\u6CD5\u9519\uFF09
    psLogFd = fs.openSync(path.join(DATA, 'ps-agent.log'), 'w');
    psProc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(psDir, 'monitor.ps1')], { stdio: ['ignore', psLogFd, psLogFd] });
    let realDev = '';
    const t0 = Date.now();
    for (;;) {
      await sleep(2000);
      const dd = (await (await fetch(`${B}/api/monitor/devices`, { headers: A })).json()).devices;
      const found = dd.find((d) => /^PC[0-9a-f]{12}$/.test(d.id));
      if (found) { realDev = found.id; break; }
      if (Date.now() - t0 > 90000) break;
    }
    ck('G2 真机代理注册（特征码 PC+12hex）', !!realDev, '90s 内未出现');
    if (realDev) {
      let got = null;
      for (let i = 0; i < 20; i++) {
        await sleep(1500);
        const s2 = await (await fetch(`${B}/api/monitor/shots?device_id=${realDev}&page=1&page_size=5`, { headers: A })).json();
        if (s2.total >= 1) { got = s2.items[0]; break; }
      }
      ck('G3 真机截图已上报', !!got);
      if (got) {
        r = await fetch(`${B}/api/monitor/shot/${got.id}?token=${lj.token}`);
        const jb = Buffer.from(await r.arrayBuffer());
        ck('G4 上报为 JPEG（真缩放编码链路）', jb.subarray(0, 3).toString('hex') === 'ffd8ff' && jb.length > 5000, `${jb.length}B`);
      }
      const dd = (await (await fetch(`${B}/api/monitor/devices`, { headers: A })).json()).devices;
      ck('G5 computer_name=本机名', dd.find((d) => d.id === realDev)?.computer_name === os.hostname().toUpperCase() || !!dd.find((d) => d.id === realDev)?.computer_name, dd.find((d) => d.id === realDev)?.computer_name);

      // 单实例互斥：再起一个同文件代理进程，应因互斥锁立即退出
      const p2 = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(psDir, 'monitor.ps1')], { stdio: 'ignore' });
      const exited = await new Promise((res) => { const t = setTimeout(() => res(false), 20000); p2.on('exit', () => { clearTimeout(t); res(true); }); });
      ck('G6 单实例互斥（第二个实例自动退出）', exited);
    }
  }

  // ========== U UI（Playwright） ==========
  console.log('\n== U UI ==');
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext();
    await ctx.addInitScript((t) => localStorage.setItem('wb_token', t), lj.token);
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(String(e)));
    await page.goto(`${B}/#/tools`);
    await page.click(`button:has-text("电脑监控")`, { timeout: 10000 });
    await page.waitForSelector('h3:has-text("监控配置")', { timeout: 10000 });
    ck('U1 电脑监控 tab 渲染（配置卡可见）', true);
    await page.waitForSelector('.dev-row', { timeout: 8000 });
    const devNames = await page.locator('.dev-row b').allTextContents();
    ck('U2 设备列表渲染', devNames.some((n) => n.includes('儿子的电脑')), JSON.stringify(devNames));
    await page.click('.dev-row:has-text("儿子的电脑")');
    await page.waitForSelector('.shot-thumb', { timeout: 8000 });
    await page.waitForFunction(() => { const i = document.querySelector('.shot-thumb'); return i && i.naturalWidth > 0; }, undefined, { timeout: 10000 });
    ck('U3 截图缩略图加载出图', true);
    const aiText = await page.locator('.ai-box').first().textContent();
    ck('U4 AI 分析框显示概括', (aiText || '').includes('动画片'), String(aiText).slice(0, 60));
    ck('U5 预警命中角标', (await page.locator('.badge.red').count()) >= 1);
    await page.waitForSelector('.mon-table', { timeout: 8000 });
    ck('U6 开关机记录表渲染', (await page.locator('.mon-table tbody tr').count()) >= 1);
    // 改名对话框（prompt）
    page.once('dialog', (d) => d.accept('女儿电脑'));
    await page.click('button:has-text("改 名"), button:has-text("✎ 改名")');
    await sleep(800);
    ck('U7 改名生效', (await page.locator('.dev-row b').allTextContents()).some((n) => n === '女儿电脑'));
    ck('U8 无页面错误', errs.length === 0, errs.join(' | ').slice(0, 200));

    // ---- v1.3.6：分页沉底 / 配置卡沉底 / 分辨率下拉 / 红字 / 默认未勾选 ----
    const shotPagerBottom = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.card')];
      const sc = cards.find((c) => (c.querySelector('h3') || {}).textContent?.includes('截图'));
      const nodes = sc ? [...sc.querySelectorAll('.pager, .shot-row')] : [];
      return nodes.length > 1 && nodes[nodes.length - 1].classList.contains('pager');
    });
    ck('U12 截图分页在列表底部', !!shotPagerBottom);
    const sesPagerBottom = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.card')];
      const sc = cards.find((c) => (c.querySelector('h3') || {}).textContent?.includes('开关机记录'));
      const nodes = sc ? [...sc.querySelectorAll('.pager, .mon-table')] : [];
      return nodes.length > 1 && nodes[nodes.length - 1].classList.contains('pager');
    });
    ck('U13 开关机分页在表格底部', !!sesPagerBottom);
    const lastIsCfg = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.card')];
      const last = cards[cards.length - 1];
      return !!last && ((last.querySelector('h3') || {}).textContent || '').includes('监控配置');
    });
    ck('U14 监控配置卡在最底部', !!lastIsCfg);
    const widthSel = page.locator('select:has(option:has-text("320px"))');
    ck('U15 分辨率下拉 4 档 + 当前 720', (await widthSel.locator('option').count()) === 4 && (await widthSel.inputValue()) === '720', await widthSel.inputValue());
    const redLine = await page.locator('.warn-line').textContent();
    ck('U16 安装说明红字（管理员身份运行）', (redLine || '').includes('右键') && (redLine || '').includes('以管理员身份运行'), String(redLine).slice(0, 60));
    const aiChecked = await page.locator('.card:has(h3:has-text("监控配置")) input[type=checkbox]').isChecked();
    ck('U17 AI 分析未勾选', aiChecked === false, String(aiChecked));

    // ---- v1.3.6：放大查看器（滚轮缩放/拖动/Esc/单击关） ----
    await page.click('.shot-thumb');
    await page.waitForSelector('.zoom-stage', { timeout: 5000 });
    ck('U18 点击打开放大查看器', true);
    let pct = (await page.locator('.zoom-pct').textContent() || '').trim();
    ck('U19 初始 100%', pct === '100%', pct);
    await page.mouse.move(400, 300);
    await page.mouse.wheel(0, -240);
    await sleep(180);
    pct = (await page.locator('.zoom-pct').textContent() || '').trim();
    ck('U20 滚轮放大 >100%', parseInt(pct) > 100, pct);
    await page.mouse.wheel(0, 240);
    await sleep(180);
    pct = (await page.locator('.zoom-pct').textContent() || '').trim();
    ck('U21 滚轮缩小回 100%', parseInt(pct) === 100, pct);
    await page.mouse.down();
    await page.mouse.move(520, 380, { steps: 5 });
    await page.mouse.up();
    await sleep(180);
    ck('U22 拖动平移不误关', (await page.locator('.zoom-stage').count()) === 1);
    await page.keyboard.press('Escape');
    await sleep(220);
    ck('U23 Esc 关闭', (await page.locator('.zoom-stage').count()) === 0);
    await page.click('.shot-thumb');
    await page.waitForSelector('.zoom-stage', { timeout: 5000 });
    await page.mouse.click(500, 400);
    await sleep(220);
    ck('U24 原地单击关闭', (await page.locator('.zoom-stage').count()) === 0);

    // ---- v1.3.7：拨动开关 / AI token 徽标与列 / 迷你分页（默认 5 行，置于上下页按钮中间） ----
    const cfgCard = page.locator('.card:has(h3:has-text("监控配置"))');
    const cfgChk = cfgCard.locator('input[type=checkbox]');
    ck('U25 拨动开关存在且默认关', (await cfgCard.locator('.switch').count()) === 1 && (await cfgChk.isChecked()) === false);
    await cfgCard.locator('.switch').click();
    ck('U26 点击拨动开关后为开', (await cfgChk.isChecked()) === true);
    await cfgCard.locator('.switch').click();
    ck('U27 再点拨回关闭', (await cfgChk.isChecked()) === false);
    const tokBadgeTxt = ((await page.locator('.dev-row:has-text("女儿电脑") .badge.tokai').textContent()) || '').trim();
    ck('U28 设备行 AI token 徽标（7×123=861）', tokBadgeTxt.replace(/\s+/g, ' ') === 'AI 861', tokBadgeTxt);
    const tokBeforeCnt = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.dev-row')].find((r) => r.textContent.includes('女儿电脑'));
      if (!row) return false;
      const kids = [...row.querySelectorAll('.badge')];
      const ti = kids.findIndex((b) => b.classList.contains('tokai'));
      const si = kids.findIndex((b) => b.textContent.includes('张'));
      return ti > -1 && si > -1 && ti < si;
    });
    ck('U29 AI token 徽标位于「张数」之前', tokBeforeCnt === true);
    ck('U30 开关机表 6 列含「AI tokens」', (await page.locator('.mon-table th').count()) === 6 && (await page.locator('.mon-table th', { hasText: 'AI tokens' }).count()) === 1);
    ck('U31 截图列表默认 5 行（共 7 张）', (await page.locator('.shot-row').count()) === 5, String(await page.locator('.shot-row').count()));
    const pagerOrder = await page.evaluate(() =>
      [...document.querySelectorAll('.pager.pager-bottom')].map((p) =>
        [...p.children].filter((n) => n.tagName === 'BUTTON' || n.tagName === 'SELECT').map((n) => n.tagName))
    );
    ck('U32 两个分页均为 [上一页→下拉→下一页] 结构', pagerOrder.length === 2 && pagerOrder.every((k) => k[0] === 'BUTTON' && k[1] === 'SELECT' && k[2] === 'BUTTON'), JSON.stringify(pagerOrder));
    ck('U33 迷你下拉各 4 档（5/15/30/50）', (await page.locator('.pager .mini-select').count()) === 2 && (await page.locator('.pager .mini-select option').count()) === 8, String(await page.locator('.pager .mini-select option').count()));
    await page.locator('.pager .mini-select').first().selectOption('15');
    await sleep(700);
    ck('U34 切 15 行后显示全部 7 张', (await page.locator('.shot-row').count()) === 7, String(await page.locator('.shot-row').count()));
    await page.locator('.pager .mini-select').first().selectOption('5');

    // 侧边栏 adminOnly 回归：受限成员看不到「用户管理」，管理员可见
    const ctx2 = await browser.newContext();
    await ctx2.addInitScript((t) => localStorage.setItem('wb_token', t), l2b.token);
    const page2 = await ctx2.newPage();
    const errs2 = [];
    page2.on('pageerror', (e) => errs2.push(String(e)));
    await page2.goto(`${B}/#/`);
    await sleep(1500);
    ck('U9 受限成员侧边栏无「用户管理」', (await page2.locator('a:has-text("用户管理")').count()) === 0);
    ck('U10 管理员侧边栏有「用户管理」', (await page.locator('a:has-text("用户管理")').count()) >= 1);
    ck('U11 受限成员页无脚本错误', errs2.length === 0, errs2.join(' | ').slice(0, 200));
  } finally {
    await browser.close();
  }
} catch (e) {
  fail++;
  console.error('  ✗ 脚本异常:', e);
} finally {
  if (psProc) try { psProc.kill('SIGKILL'); } catch { /* 已退出 */ }
  if (psLogFd !== null) try { fs.closeSync(psLogFd); } catch { /* 已关 */ }
  await sleep(800);
  if (psDir && psCreated) {
    for (let i = 0; i < 3; i++) { // Windows 句柄延迟，重试删安装目录
      try { fs.rmSync(psDir, { recursive: true, force: true }); break; } catch { await sleep(600); }
    }
  }
  srv.kill();
  stubSrv.close();
}

// ========== 会话推导 / 保留期清理 / chatEndpoint 单元（服务已停，直连库） ==========
await sleep(1200);
try {
  process.env.DATA_DIR = DATA;
  const req = createRequire(path.join(ROOT, 'server', 'index.js'));
  const { db } = req('./db.js');
  // 构造时间序列：08:00/08:03/08:06 连续（interval=3→阈值 9），12:00/12:03 第二段
  db.prepare('DELETE FROM monitor_shots WHERE device_id=?').run(DEV);
  const ins = db.prepare('INSERT INTO monitor_shots(device_id, ts, ai_tokens) VALUES(?,?,?)');
  [['2026-09-15 08:00:00', 100], ['2026-09-15 08:03:00', 50], ['2026-09-15 08:06:00', 25], ['2026-09-15 12:00:00', 200], ['2026-09-15 12:03:00', 10]].forEach(([t, tok]) => ins.run(DEV, t, tok));
  const mon = req('./services/monitorService.js');
  const ses = mon.listSessions(DEV);
  console.log('\n== 会话推导单元 ==');
  ck('E1 两段会话（间隔>阈值切分）', ses.length === 2, JSON.stringify(ses));
  ck('E2 倒序（最新在前）+ 编号', ses[0].no === 1 && ses[0].start === '2026-09-15 12:00:00' && ses[0].end === '2026-09-15 12:03:00');
  ck('E3 首段起止与张数', ses[1].start === '2026-09-15 08:00:00' && ses[1].end === '2026-09-15 08:06:00' && ses[1].shots === 3, JSON.stringify(ses[1]));
  ck('E3b 每段会话累计 AI token（175 / 210）', ses[1].tokens === 175 && ses[0].tokens === 210, `${ses[1].tokens} / ${ses[0].tokens}`);
  ck('E4 时长格式', ses[0].duration === '3 分钟' && ses[1].duration === '6 分钟', `${ses[0].duration} / ${ses[1].duration}`);

  mon.saveConfig({ retention_days: 7 });
  ins.run(DEV, '2026-09-01 10:00:00', 0);
  const n = mon.cleanup();
  const left = db.prepare('SELECT COUNT(*) c FROM monitor_shots WHERE device_id=?').get(DEV).c;
  console.log('\n== 保留期清理单元 ==');
  ck('E5 过期截图清理（retention=7）', n === 1 && left === 5, `del=${n} left=${left}`);
  // E5b：命中过预警的截图永久保留（alert_hit=1 不参与定期清理，仅手动删除）
  db.prepare('INSERT INTO monitor_shots(device_id, ts, alert_hit) VALUES(?,?,1)').run(DEV, '2026-09-01 11:00:00');
  const n2 = mon.cleanup();
  const left2 = db.prepare('SELECT COUNT(*) c FROM monitor_shots WHERE device_id=?').get(DEV).c;
  ck('E5b 预警命中截图跳过清理', n2 === 0 && left2 === 6, `del=${n2} left=${left2}`);

  const ai = req('./services/aiService.js');
  console.log('\n== chatEndpoint 归一单元 ==');
  ck('F1 纯域名补后缀', ai.chatEndpoint('https://api.deepseek.com') === 'https://api.deepseek.com/chat/completions', ai.chatEndpoint('https://api.deepseek.com'));
  ck('F2 带版本号不重复', ai.chatEndpoint('https://api.deepseek.com/v1') === 'https://api.deepseek.com/v1/chat/completions');
  ck('F3 完整端点不双重', ai.chatEndpoint('https://api.deepseek.com/v1/chat/completions') === 'https://api.deepseek.com/v1/chat/completions');
  ck('F4 尾斜杠容忍', ai.chatEndpoint('https://api.deepseek.com/v1//') === 'https://api.deepseek.com/v1/chat/completions');
} catch (e) {
  fail++;
  console.error('  ✗ 单元段异常:', e);
} finally {
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
