// E2E（v1.13.1）：LLM在线模型对话的 AI 脱敏界面 + 数字人「智能家居控制」tab 的界面。
//
// 覆盖：
//   A 三个按钮（附件 / 脱敏 / 回传）都在、**尺寸完全一致**、回传是原名；
//   B 点【脱敏】→ 右侧延伸出说明框（说明与原理 / 当前规则 / 本轮对照关系三个分区），✕ 能收；
//   C Ctrl+回车 = 直接脱敏发送：用户气泡「🔒 已脱敏 N 项」、AI 气泡显示复原后的真名（无代码残留）、
//     对照关系表列出真名 ↔ 代码；发送过程中有过程进度气泡；
//   D 数字人 →「智能家居控制」子页签可用（**零数字人时也在**，因为它不属于任何角色）；
//   E 全程无 JS 报错。
// 隔离 DATA_DIR 起服务；AI 是本地桩（只回代码，真名只可能是服务端复原出来的）。
//   node scripts/e2e-llm-desens-ui.mjs
import { spawn } from 'child_process';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PORT = 3196;
const STUB = 3994;
const B = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), 'wb-llmdesens-ui-'));
process.env.DATA_DIR = DATA;

let passed = 0, failed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};

const CODE_RE = /\b(?:ORG|PER|DEPT|GRP|ACC|PWD|KEY|MAIL|PHONE|ID|KW|NUM)-[A-Z0-9]{5}\b/;
const ASK = '对接人张三，公司是杭州未来科技有限公司，密码是 Passw0rd#2026';

// ---- 桩 AI：只回代码（真 AI 也只能看到代码）----
const codesIn = (s) => String(s || '').match(/\b(?:ORG|PER|DEPT|GRP|ACC|PWD|KEY|MAIL|PHONE|ID|KW|NUM)-[A-Z0-9]{5}\b/g) || [];
const stub = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (c) => { buf += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(buf); } catch { /* 原样 */ }
    const last = (body.messages || []).slice(-1)[0]?.content;
    const codes = [...new Set(codesIn(typeof last === 'string' ? last : JSON.stringify(last)))];
    const text = codes.length ? `联系人 ${codes.slice(0, 2).join(' / ')} 已记录` : '没看到代码';
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (let i = 0; i < text.length; i += 3) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 3) } }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
  });
});
await new Promise((r) => stub.listen(STUB, '127.0.0.1', r));

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: path.join(import.meta.dirname, '..'),
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, TTS_ROOT: path.join(DATA, 'tts'), DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => { if (process.env.E2E_VERBOSE) process.stderr.write(d); });

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${B}/api/health`)).ok) return; } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('服务 20s 未就绪');
}
async function api(method, url, { token, body } = {}) {
  const r = await fetch(B + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, j: ct.includes('json') ? await r.json() : await r.text() };
}

let br = null;
try {
  await waitReady();
  const lg = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'test123456' } });
  const T = lg.j.b?.token || lg.j.token;
  ok(!!T, 'A0 admin 登录拿到 token');
  await api('POST', '/api/ai/config', { token: T, body: { model: 'stub-chat', base_url: `http://127.0.0.1:${STUB}/v1`, api_key: 'sk-stub-e2e' } });

  const { chromium } = await import('playwright');
  br = await chromium.launch();
  const ctx = await br.newContext({ viewport: { width: 1500, height: 900 } });
  await ctx.addInitScript(([t, u]) => {
    localStorage.setItem('wb_token', t);
    localStorage.setItem('wb_user', u);
  }, [T, JSON.stringify(lg.j.user)]);
  const p = await ctx.newPage();
  const perr = [];
  p.on('pageerror', (e) => perr.push(String(e).slice(0, 200)));

  // ---------- A. 三个按钮 ----------
  await p.goto(`${B}/#/smart-home?tab=llm`, { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('.ai-btns button', { timeout: 20000 });
  const btns = p.locator('.ai-btns button');
  ok(await btns.count() === 3, 'A1 输入区右侧正好三个按钮（附件 / 脱敏 / 回传）');
  const labels = await btns.allInnerTexts();
  ok(labels.some((t) => t.includes('附件')) && labels.some((t) => t.includes('脱敏')) && labels.includes('回传'),
    'A2 文案：📎 附件 / 🔒 脱敏 / 回传（发送已改名）', JSON.stringify(labels));
  const boxes = [];
  for (let i = 0; i < 3; i++) boxes.push(await btns.nth(i).boundingBox());
  const hs = boxes.map((b) => Math.round(b.height)), ws = boxes.map((b) => Math.round(b.width));
  ok(new Set(hs).size === 1 && new Set(ws).size === 1,
    'A3 三个按钮尺寸完全一致（附件不再是小按钮）', `h=${hs.join(',')} w=${ws.join(',')}`);
  const ph = await p.locator('.ai-chat-main textarea').getAttribute('placeholder');
  ok(/Ctrl\+回车/.test(ph || ''), 'A4 占位文字写明 Ctrl+回车 = 直接脱敏发送', ph);

  // ---------- B. 点【脱敏】→ 右侧功能框 ----------
  ok(await p.locator('.desens-panel').count() === 0, 'B1 初始右侧没有功能框');
  await btns.nth(1).click();
  await p.waitForSelector('.desens-panel', { timeout: 5000 });
  const panelText = await p.locator('.desens-panel').innerText();
  ok(/说明与原理/.test(panelText) && /当前规则/.test(panelText) && /本轮对照关系/.test(panelText),
    'B2 功能框三段齐全：说明与原理 / 当前规则 / 本轮对照关系');
  ok(/无法脱敏/.test(panelText), 'B3 如实写明「图片附件无法脱敏」', panelText.slice(0, 80));
  const layoutCols = await p.locator('.ai-chat-layout').evaluate((el) => getComputedStyle(el).gridTemplateColumns);
  ok(layoutCols.split(' ').length === 3, 'B4 展开后布局多一列（右侧延伸，不是把中间挤窄）', layoutCols);
  ok(/✓/.test(await btns.nth(1).innerText()), 'B5 按钮进入勾选态（🔒 脱敏 ✓）', await btns.nth(1).innerText());
  // 宽屏下聊天区一分不让（用户要求「现有布局尺寸不变，框在右侧空白里展开」）
  await p.setViewportSize({ width: 1920, height: 900 });
  await p.waitForTimeout(300);
  const wideOpen = (await p.locator('.ai-chat-main').boundingBox()).width;
  await p.locator('.desens-panel .icon-btn').click();
  await p.waitForTimeout(300);
  const wideClosed = (await p.locator('.ai-chat-main').boundingBox()).width;
  ok(Math.abs(wideOpen - wideClosed) <= 2, 'B6 1920 宽屏：展开前后聊天区宽度一致（尺寸不变，面板占右侧空白）',
    `展开 ${Math.round(wideOpen)} vs 收起 ${Math.round(wideClosed)}`);
  await btns.nth(1).click();   // 重新展开，后面几组要用
  await p.setViewportSize({ width: 1500, height: 900 });
  await p.waitForTimeout(300);

  // ---------- C. Ctrl+回车 = 直接脱敏发送 ----------
  await p.locator('.ai-chat-main textarea').fill(ASK);
  await p.keyboard.press('Control+Enter');
  await p.waitForSelector('.wm-badge.in', { timeout: 20000 });
  const userBubble = await p.locator('.wm-badge.in').innerText();
  ok(/已脱敏\s*3\s*项/.test(userBubble), 'C1 用户气泡出现「🔒 已脱敏 3 项」过程提示', userBubble);
  await p.waitForFunction(() => /已按对照表复原/.test(document.body.innerText), null, { timeout: 20000 });
  const aiBubble = await p.locator('.wm-badge.out').innerText();
  ok(/已按对照表复原\s*3\s*项/.test(aiBubble), 'C2 AI 气泡出现「🔓 已按对照表复原 3 项」', aiBubble);
  const bodyText = await p.locator('.ai-chat-body').innerText();
  ok(bodyText.includes('张三') && bodyText.includes('杭州未来科技有限公司'),
    'C3 对话里看到的是真名（桩只回过代码）', bodyText.replace(/\n/g, ' | ').slice(0, 160));
  ok(!CODE_RE.test(bodyText), 'C4 气泡里一个代码都没漏', (bodyText.match(CODE_RE) || []).join(','));
  const rows = await p.locator('.desens-panel .dp-row').count();
  ok(rows >= 3, 'C5 本轮对照关系表列出了真名 ↔ 代码', String(rows));
  const rowText = await p.locator('.desens-panel .dp-table').innerText();
  ok(/张三|Passw0rd#2026|杭州未来科技有限公司/.test(rowText), 'C6 对照表里是真名而不是代码', rowText.replace(/\n/g, ' | ').slice(0, 160));

  await p.locator('.desens-panel .icon-btn').click();
  await p.waitForTimeout(200);
  ok(await p.locator('.desens-panel').count() === 0, 'C7 ✕ 能收起功能框');

  // ---------- D. 数字人 → 智能家居控制 ----------
  await p.goto(`${B}/#/smart-home?tab=dh`, { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  const dhSubs = await p.locator('body').innerText();
  ok(/智能家居控制/.test(dhSubs), 'D1 数字人设置里出现「智能家居控制」页签（零数字人时也在）');
  const tabBtn = p.locator('button', { hasText: '智能家居控制' }).first();
  await tabBtn.click();
  await p.waitForTimeout(1200);
  const smText = await p.locator('body').innerText();
  ok(/控制通道/.test(smText), 'D2 页签内容有「控制通道」', '');
  ok(/可控设备一览/.test(smText), 'D3 页签内容有「可控设备一览」');
  ok(!/烧录|固件|串口|桥接密钥|装机向导/.test(smText), 'D4 剥干净了板子/烧录相关内容（用户明确要求）',
    (smText.match(/烧录|固件|串口|桥接密钥|装机向导/g) || []).join(','));

  ok(perr.length === 0, 'E1 全程没有 JS 报错', perr.join(' || '));
} catch (e) {
  failed++;
  console.error('  ✗ 用例抛异常 —', e.message);
} finally {
  try { await br?.close(); } catch { /* 已关 */ }
  try { server.kill('SIGKILL'); } catch { /* 已退 */ }
  stub.close();
  try { rmSync(DATA, { recursive: true, force: true }); } catch { /* 句柄未释放 */ }
}

console.log(`\n${passed} 通过, ${failed} 失败`);
if (failed) process.exitCode = 1;
