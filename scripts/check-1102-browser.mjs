// 真浏览器点检：v1.10.2 的四条笔记改动（编辑器换成 CodeMirror 6）。
//
// 为什么后端 e2e 不够：这四条**全是前端行为** ——
//   ① 打开笔记默认进编辑态、光标在开头（不是文末）；
//   ② 编辑时就显示语法配色 + 新增「源码」（代码预览，只读）模式；
//   ③ 创建于/最后修改从独占一行挪到「AI 总结 / 续写 / 翻译」那一行；
//   ④ 双链标题可搜索：键入 [[ 列出历史笔记标题。
// 字符串级校验（chunk 里有没有中文）拦不住「模板引用了不存在的变量」这类白屏。
//
// 纪律同 check-notes-browser.mjs / check-1101-browser.mjs：每步都要证明视图真的渲染了；
// 元素找不到就是失败，不许静默跳过。
// 用法：node scripts/check-1102-browser.mjs [--headed]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startServer, sleep, login } from './_noteE2E.mjs';

const PORT = 3214;
const HEADED = process.argv.includes('--headed');
const { B, DATA, srv, stop } = await startServer({ tag: 'v1102', port: PORT });
console.log('隔离服务器', B, ' DATA =', path.relative(ROOT, DATA));
void srv;

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
const ck = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  <<< ' + String(extra).slice(0, 500)}`); };

// ---- 造数据：两篇笔记。正文里放一个标题、一个双链、一个 js 代码块（验证按语言上色）----
const FENCE = '```';
const body = [
  '# 一号标题',
  '',
  '正文里有 [[另一篇笔记]] 这样的双链。',
  '',
  FENCE + 'js',
  'const answer = 42; // 常量',
  FENCE,
  '',
  // 第二个围栏故意用 **legacy-modes** 语言（shell）。v1.10.2 上线后真机抓到的崩溃就在这里：
  // StreamLanguage.define() 返回的是裸 Language（没有 .language），而 lang-markdown 读的是
  // support.language.parser —— 懒加载完成后下一次解析就抛 undefined.parser，代码块高亮从那一刻坏掉。
  // 只放 ```js（走 lang-javascript，返回 LanguageSupport）永远测不出来。
  FENCE + 'bash',
  'ls -la /tmp  # 列目录',
  FENCE,
  '',
  '## 二号标题',
  '',
  '- 列表项一',
].join('\n');
const nOther = await A('POST', '/api/notes', { title: '另一篇笔记', content: '另一篇的正文' });
// 第三篇：一个双链都没有，用来测右栏图谱的空态
const nLonely = await A('POST', '/api/notes', { title: '孤岛笔记', content: '这篇谁也不链。' });
await sleep(1200);   // updated_at 是秒级，拉开一点，保证「最近修改」就是下面这篇
const nMain = await A('POST', '/api/notes', { title: '主笔记', content: body });
ck('造了两篇笔记', Number.isFinite(nMain.id), JSON.stringify(nMain));

const browser = await chromium.launch({ headless: !HEADED });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 980 } });
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

const openMain = async () => {
  await page.goto(`${B}/#/notes?note=${nMain.id}`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.note-head input.title').first().waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('.preview').first().waitFor({ state: 'visible', timeout: 20000 });
};

console.log('\n== ① 打开是预览页；双击正文进编辑；进编辑后光标在开头 ==');
// v1.10.2 的默认是「编辑态」，v1.10.3 按用户后来的要求改成「预览态 + 双击进编辑」，
// 但「进编辑时光标落在开头」这条一直保留（makeState 的 selection:0），所以两步都要测。
await openMain();
ck('打开的是「主笔记」', (await page.locator('.note-head input.title').first().inputValue()).trim() === '主笔记');
const modes = await page.locator('.mbtn').evaluateAll((els) => els.map((e) => e.innerText.trim()));
ck('模式按钮有四个：编辑/分屏/预览/源码', JSON.stringify(modes) === JSON.stringify(['编辑', '分屏', '预览', '源码']), modes.join(' / '));
ck('默认选中的是「预览」（v1.10.3 起的默认）', (await page.locator('.mbtn.on').first().innerText()).trim() === '预览',
   (await page.locator('.mbtn.on').first().innerText()).trim());
ck('看到的是渲染结果（有 h1、有 <pre>），不是 Markdown 源码',
   (await page.locator('.preview h1').first().innerText()).includes('一号标题') &&
   (await page.locator('.preview pre').count()) >= 1);
ck('预览态下编辑器是藏起来的（.cm-content 不可见）', !(await page.locator('.cm-content').first().isVisible()));
await page.screenshot({ path: path.join(ROOT, 'Logs/shots/v1103-open-preview.png'), clip: { x: 190, y: 60, width: 1290, height: 500 } });

// 需求：在预览正文上双击 → 直接进这一篇的编辑
await page.locator('.preview h2, .preview p').first().dblclick();
await page.waitForTimeout(600);
ck('双击预览正文切到「编辑」', (await page.locator('.mbtn.on').first().innerText()).trim() === '编辑',
   (await page.locator('.mbtn.on').first().innerText()).trim());
ck('编辑器真的显示了（不是 0 高）', await page.locator('.cm-content').first().isVisible());
const focused = await page.evaluate(() => !!document.activeElement && document.activeElement.classList.contains('cm-content'));
ck('进编辑后编辑器拿到焦点', focused,
   await page.evaluate(() => document.activeElement && document.activeElement.className));

// 真打字验证光标位置：插到开头 → 首行应以它打头；撤销后恢复
await page.keyboard.type('☆');
await page.waitForTimeout(250);
const firstLine = (await page.locator('.cm-line').first().innerText()).trim();
ck('打一个字落在**首行开头**（光标在最前）', firstLine.startsWith('☆'), '首行：' + firstLine);
await page.keyboard.press('Control+z');
await page.waitForTimeout(250);
const firstLine2 = (await page.locator('.cm-line').first().innerText()).trim();
ck('撤销后回到原样（没把正文弄坏）', firstLine2 === '# 一号标题', '首行：' + firstLine2);

console.log('\n== ② 编辑时就有语法配色 ==');
const colorInfo = await page.evaluate(() => {
  const probe = (v) => { const d = document.createElement('div'); d.style.color = v; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; };
  const cm = document.querySelector('.cm-content');
  const lines = [...cm.querySelectorAll('.cm-line')];
  const headLine = lines.find((l) => l.textContent.trim().startsWith('# 一号标题'));
  const inlineCode = lines.find((l) => l.textContent.includes('[[另一篇笔记]]'));
  const varOf = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const spanColor = (line, pred) => {
    if (!line) return '';
    for (const s of line.querySelectorAll('span')) if (pred(s.textContent)) return getComputedStyle(s).color;
    return '';
  };
  return {
    heading: spanColor(headLine, (t) => t.includes('一号标题')),
    headingWant: probe(varOf('--syn-h1')),
    mark: spanColor(headLine, (t) => t.trim() === '#'),
    markWant: probe(varOf('--syn-mark')),
    wiki: spanColor(inlineCode, (t) => t.includes('另一篇笔记')),
    linkWant: probe(varOf('--syn-link')),
    headingText: headLine && headLine.textContent,
  };
});
ck('标题文字用的是 --syn-h1 那个颜色', colorInfo.heading === colorInfo.headingWant,
   `实际 ${colorInfo.heading} / 期望 ${colorInfo.headingWant}（${colorInfo.headingText}）`);
ck('Markdown 结构符号（#）用的是压暗色 --syn-mark', colorInfo.mark === colorInfo.markWant,
   `实际 ${colorInfo.mark} / 期望 ${colorInfo.markWant}`);
ck('双链 [[...]] 用的是链接色 --syn-link', colorInfo.wiki === colorInfo.linkWant,
   `实际 ${colorInfo.wiki} / 期望 ${colorInfo.linkWant}`);
await page.screenshot({ path: path.join(ROOT, 'Logs/shots/v1102-edit.png'), clip: { x: 190, y: 60, width: 1290, height: 420 } });

console.log('\n== ② 代码块按语言上色（js 解析器是懒加载的，等它到）==');
let kwOk = false, kwSeen = '';
try {
  await page.waitForFunction(() => {
    const probe = (v) => { const d = document.createElement('div'); d.style.color = v; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; };
    const want = probe(getComputedStyle(document.documentElement).getPropertyValue('--syn-keyword').trim());
    const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes('const answer'));
    if (!line) return false;
    return [...line.querySelectorAll('span')].some((s) => s.textContent.trim() === 'const' && getComputedStyle(s).color === want);
  }, { timeout: 15000 });
  kwOk = true;
  kwSeen = await page.evaluate(() => {
    const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes('const answer'));
    return [...line.querySelectorAll('span')].map((s) => s.textContent + '=' + getComputedStyle(s).color).join(' | ');
  });
} catch (e) { kwSeen = '超时：' + String(e.message).slice(0, 120); }
ck('```js 里的 const 用关键字色上色了（说明语言解析器真的按需加载并生效）', kwOk, kwSeen);

// 同一条路，但走 legacy-modes（shell）：这里等的是「懒加载完成后的**第二次**解析」——
// 正是当初炸 undefined.parser 的那一步。修好后应当稳稳拿到 ≥2 个上色 span。
let shOk = false, shSeen = '';
try {
  await page.waitForFunction(() => {
    const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes('ls -la /tmp'));
    if (!line) return false;
    return [...line.querySelectorAll('span')].length >= 2;
  }, { timeout: 15000 });
  shOk = true;
  shSeen = await page.evaluate(() => {
    const line = [...document.querySelectorAll('.cm-line')].find((l) => l.textContent.includes('ls -la /tmp'));
    return [...line.querySelectorAll('span')].map((s) => s.textContent + '=' + getComputedStyle(s).color).join(' | ');
  });
} catch (e) { shSeen = '超时：' + String(e.message).slice(0, 120); }
ck('```bash 走 legacy-modes 那条路也不炸、且真的上了色（v1.10.2 上线后修的那个 undefined.parser）', shOk, shSeen);
ck('编辑器没有出现未捕获错误（undefined.parser 之类）', errs.length === 0, errs.join(' | '));

console.log('\n== ② 源码模式：只读的「代码预览」 ==');
await page.locator('.mbtn', { hasText: '源码' }).first().click();
await page.waitForTimeout(400);
const srcState = await page.evaluate(() => {
  const cm = document.querySelector('.cm-content');
  return {
    editable: cm.getAttribute('contenteditable'),
    text: cm.innerText,
    onBtn: document.querySelector('.mbtn.on').innerText.trim(),
  };
});
ck('源码模式按钮选中', srcState.onBtn === '源码', srcState.onBtn);
ck('编辑器变成只读（contenteditable=false）', srcState.editable === 'false', String(srcState.editable));
ck('看到的是 Markdown 源文而不是渲染结果', srcState.text.includes('```js') && srcState.text.includes('# 一号标题'),
   JSON.stringify(srcState.text.slice(0, 80)));
ck('源码模式下渲染预览是藏起来的', !(await page.locator('.preview').first().isVisible()));
await page.screenshot({ path: path.join(ROOT, 'Logs/shots/v1102-source.png'), clip: { x: 190, y: 60, width: 1290, height: 420 } });

console.log('\n== ② 老的三态没坏 ==');
await page.locator('.mbtn', { hasText: '分屏' }).first().click();
await page.waitForTimeout(400);
const cmW = await page.locator('.cm-wrap').first().boundingBox();
const pvW = await page.locator('.preview').first().boundingBox();
ck('分屏：左编辑 + 右预览都在，宽度各占一半',
   !!cmW && !!pvW && Math.abs(cmW.width - pvW.width) < 40 && cmW.width > 200,
   JSON.stringify([cmW && Math.round(cmW.width), pvW && Math.round(pvW.width)]));
ck('分屏右侧是真渲染过的 HTML（有 h1 和代码块）',
   (await page.locator('.preview h1').first().innerText()).includes('一号标题') &&
   (await page.locator('.preview pre').count()) >= 1);
await page.locator('.mbtn', { hasText: '预览' }).first().click();
await page.waitForTimeout(300);
ck('预览：只剩渲染结果', (await page.locator('.preview').first().isVisible()) && !(await page.locator('.cm-wrap').first().isVisible()));
await page.locator('.mbtn', { hasText: '编辑' }).first().click();
await page.waitForTimeout(500);
ck('切回编辑：CodeMirror 回来了且能看到（不是 0 高）', await page.locator('.cm-content').first().isVisible(),
   JSON.stringify(await page.locator('.cm-wrap').first().boundingBox()));

console.log('\n== ③ 创建/修改时间并到「AI 总结 / 续写 / 翻译」那一行 ==');
const headLines = await page.locator('.note-head .line').count();
ck('头部只剩两行（标题行 + 按钮行），时间不再独占一行', headLines === 2, '实际 ' + headLines);
const rowInfo = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('.note-head .line')];
  const row = rows.find((r) => r.textContent.includes('创建'));
  return row ? { text: row.textContent.replace(/\s+/g, ' ').trim(), hasCreate: /创建 \d/.test(row.textContent), hasMod: /修改 \d/.test(row.textContent), hasAi: row.textContent.includes('AI 总结') || row.textContent.includes('总结'), hasCont: row.textContent.includes('续写'), hasTr: row.textContent.includes('翻译') } : null;
});
ck('时间与 AI 三个按钮同处一行', !!(rowInfo && rowInfo.hasCreate && rowInfo.hasMod && rowInfo.hasAi && rowInfo.hasCont && rowInfo.hasTr),
   JSON.stringify(rowInfo));

// 「节省界面」的真正判据不是 DOM 里有几行，而是**视觉上是不是一行**：
// 上一版就是 DOM 两行、视觉三行，只有看渲染图才发现。这里按子元素垂直中心分桶来数。
const lineInfo = await page.evaluate(() => {
  const row = [...document.querySelectorAll('.note-head .line')].find((r) => /创建 \d/.test(r.textContent));
  const kids = [...row.children];
  const centers = kids.map((c) => { const r = c.getBoundingClientRect(); return r.top + r.height / 2; });
  const buckets = centers.reduce((acc, c) => (acc.some((v) => Math.abs(v - c) < 10) ? acc : [...acc, c]), []);
  return { h: Math.round(row.getBoundingClientRect().height), visualLines: buckets.length, w: row.clientWidth, kids: kids.length };
});
ck('这一行视觉上只占一行（不再是「DOM 一行、看着两行」）', lineInfo.visualLines === 1 && lineInfo.h <= 40,
   JSON.stringify(lineInfo));
const row = (await A('GET', `/api/notes/${nMain.id}`)) || {};
const shown = await page.getByText(/创建 (\d{4}-)?\d{2}-\d{2} \d{2}:\d{2}/).first().innerText();
const tailOf = (s) => { const f = String(s || '').slice(0, 16); return f.startsWith(String(new Date().getFullYear())) ? f.slice(5) : f; };
ck('时间显示值与接口一致（截到分钟）', shown.trim().endsWith(tailOf(row.created_at)), `${shown} vs ${row.created_at}`);

// 为了把时间挤进这一行，头部去掉了「文件夹」二字、与左栏重复的「文件夹管理」按钮、以及与下拉重复的文件夹路径 ——
// 这里证明「文件夹管理」这个动作没有变成孤儿（左栏底部仍然有入口，命令面板里也还有）。
ck('「文件夹管理」仍能从左栏进入（头部那个是重复入口，删掉不丢功能）',
   (await page.locator('.ns-left .vbtn', { hasText: '文件夹管理' }).count()) >= 1);
ck('去掉「文件夹」二字后，下拉本身还在且带 title 说明',
   (await page.locator('.note-head select.folder-pick').getAttribute('title')) === '归属文件夹');
ck('与下拉重复的文件夹路径不再重复画（尾部那个 span 没了）',
   (await page.evaluate(() => [...document.querySelectorAll('.note-head .line.wrap span')].some((s) => s.style.marginLeft === 'auto'))) === false);
await page.screenshot({ path: path.join(ROOT, 'Logs/shots/v1102-head-times.png'), clip: { x: 190, y: 60, width: 1290, height: 190 } });

console.log('\n== ④ 键入 [[ 能搜历史笔记标题 ==');
await page.locator('.cm-content').first().click();
await page.keyboard.press('Control+Home');
await page.keyboard.press('Control+z');   // 把光标退回到文档开头（上一步点过鼠标，位置不定）
await page.waitForTimeout(150);
await page.keyboard.type('[[', { delay: 60 });
let tipSeen = false, tipText = '';
try {
  await page.locator('.cm-tooltip-autocomplete').first().waitFor({ state: 'visible', timeout: 6000 });
  tipSeen = true;
  tipText = (await page.locator('.cm-tooltip-autocomplete').first().innerText()).replace(/\n+/g, ' / ');
} catch (e) { tipText = '没弹出来：' + String(e.message).slice(0, 120); }
ck('键入 [[ 弹出标题列表', tipSeen, tipText);
ck('列表里有那篇已有笔记的标题', tipText.includes('另一篇笔记'), tipText);
// 边打边筛
await page.keyboard.type('另一', { delay: 60 });
await page.waitForTimeout(300);
const filtered = (await page.locator('.cm-tooltip-autocomplete').first().innerText()).replace(/\n+/g, ' / ');
ck('继续输入会筛选（只剩匹配的那条）', filtered.includes('另一篇笔记') && !filtered.includes('主笔记'), filtered);
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
const docText = await page.locator('.cm-content').first().innerText();
ck('选中后写入 [[另一篇笔记]]（自动补了收尾的 ]]）', docText.includes('[[另一篇笔记]]'), JSON.stringify(docText.slice(0, 60)));
await page.screenshot({ path: path.join(ROOT, 'Logs/shots/v1102-wiki-pick.png'), clip: { x: 190, y: 60, width: 1290, height: 420 } });

console.log('\n== 回归：CM 接线没把自动保存弄坏 ==');
await page.keyboard.type('尾巴', { delay: 40 });
await page.waitForTimeout(900);
const dirtyShown = await page.locator('.note-head .dirty').count();
ck('打字后出现「未保存」', dirtyShown === 1, 'dirty 元素 ' + dirtyShown + ' 个');
await page.waitForTimeout(4200);   // 自动保存防抖 3 秒
const saved = await A('GET', `/api/notes/${nMain.id}`);
ck('自动保存把内容写进库了', String(saved.content || '').includes('[[另一篇笔记]]') && String(saved.content || '').includes('尾巴'),
   JSON.stringify(String(saved.content || '').slice(0, 60)));
ck('保存后「未保存」标记消失', (await page.locator('.note-head .dirty').count()) === 0);

console.log('\n== ⑤（v1.10.3）右栏「图谱」页签：看本篇的知识图谱 ==');
// 此刻「主笔记」正文里已经有 [[另一篇笔记]] 并且保存过了，所以它应当是一张 2 点 1 边的局部图。
const tabTexts = await page.locator('.rp-tabs button').evaluateAll((els) => els.map((e) => e.innerText.trim()));
const graphAt = tabTexts.indexOf('图谱');
ck('页签里出现了「图谱」', graphAt >= 0, tabTexts.join(' / '));
ck('「图谱」就排在大纲后面（用户指定的位置）', graphAt === tabTexts.indexOf('大纲') + 1, tabTexts.join(' / '));
await page.locator('.rp-tabs button', { hasText: '图谱' }).first().click();
await page.waitForTimeout(1500);
const gv = await page.evaluate(() => {
  const cv = document.querySelector('.rp canvas');
  const body = document.querySelector('.rp-body');
  const r = cv && cv.getBoundingClientRect();
  const bar = body && body.innerText.replace(/\s+/g, ' ').trim();
  return {
    hasCanvas: !!cv,
    w: r ? Math.round(r.width) : 0, h: r ? Math.round(r.height) : 0,
    painted: cv ? cv.width > 0 && cv.height > 0 : false,
    bar,
    fill: !!document.querySelector('.rp-body.rp-body-fill'),
  };
});
ck('画布挂上了并且有真实高度（右栏里塌成 0 高是这一步最容易翻的车）',
   gv.hasCanvas && gv.w > 80 && gv.h > 120 && gv.painted, JSON.stringify(gv));
ck('取数换成了「本篇 + 邻居」（2 点 1 边），不是全库图谱',
   /\b2 点 \/ 1 边/.test(gv.bar), gv.bar);
ck('紧凑工具栏是「1 跳 / 2 跳 / 适配 / 全屏」', /1 跳/.test(gv.bar) && /2 跳/.test(gv.bar) && /全屏/.test(gv.bar), gv.bar);
ck('画布真的画了东西（不是空白）', await page.evaluate(() => {
  const cv = document.querySelector('.rp canvas');
  const g = cv.getContext('2d');
  const d = g.getImageData(0, 0, cv.width, cv.height).data;
  let lit = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) lit++;
  return lit > 200;   // 两个圆点 + 一条线 + 两个标题的像素量级
}));
// 首帧量宽度的时候右栏可能还没铺开，fit() 会把图缩到角上 —— 用「墨迹重心」把这件事钉住
const centroid = await page.evaluate(() => {
  const cv = document.querySelector('.rp canvas');
  const g = cv.getContext('2d');
  const d = g.getImageData(0, 0, cv.width, cv.height).data;
  let sx = 0, sy = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] <= 8) continue;
    const p = i / 4;
    sx += p % cv.width; sy += Math.floor(p / cv.width); n++;
  }
  return { n, cx: n ? sx / n / cv.width : -1, cy: n ? sy / n / cv.height : -1 };
});
ck('图是居中的，不是缩在角上（首帧量到 0 宽就会这样）',
   centroid.cx > 0.35 && centroid.cx < 0.65 && centroid.cy > 0.32 && centroid.cy < 0.68,
   JSON.stringify({ cx: +centroid.cx.toFixed(2), cy: +centroid.cy.toFixed(2) }));
// 裁切要盖满右栏整高：上一版只截了 560px，画布下半截被切掉，「图缩在角上」看着像真的
await page.screenshot({ path: path.join(ROOT, 'Logs/shots/v1103-right-graph.png'), clip: { x: 1050, y: 60, width: 440, height: 900 } });

// 跳数切换：邻居少时点数不变，但按钮状态要真的切过去（深度是发到接口的 query）
await page.locator('.rp button', { hasText: '2 跳' }).first().click();
await page.waitForTimeout(900);
ck('点「2 跳」后按钮状态切过去了（深度真的进了请求）', await page.evaluate(() => {
  const b = [...document.querySelectorAll('.rp button')].find((x) => x.innerText.trim() === '2 跳');
  return !!(b && b.classList.contains('on'));
}));

// 「全屏」应当打开整页图谱（右栏那个是同一个组件的紧凑态，这里确认两条路都通）
await page.locator('.rp button', { hasText: '全屏' }).first().click();
await page.waitForTimeout(1400);
const full = await page.evaluate(() => {
  const tops = [...document.querySelectorAll('.gv')];
  return { gv: tops.length, hasFullBar: !!document.querySelector('.gv .gtop button') && !document.querySelector('.rp canvas') };
});
ck('点「全屏」打开的是整页图谱（有「只看孤岛」那套完整工具栏）',
   full.gv >= 1 && (await page.locator('.gv button', { hasText: '只看孤岛' }).count()) >= 1, JSON.stringify(full));

// 没有链接的笔记：给空态提示，而不是一块空白画布
// 注意别拿「另一篇笔记」来测空态 —— 它被主笔记链着，邻接是**双向**的，它的局部图同样是 2 点 1 边。
await page.goto(`${B}/#/notes?note=${nLonely.id}`, { waitUntil: 'domcontentloaded' });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.locator('.note-head input.title').first().waitFor({ state: 'visible', timeout: 20000 });
await page.locator('.rp-tabs button', { hasText: '图谱' }).first().click();
await page.waitForTimeout(1200);
const lonely = await page.evaluate(() => {
  const cv = document.querySelector('.rp canvas');
  const r = cv && cv.getBoundingClientRect();
  return {
    text: (document.querySelector('.rp-body') || {}).innerText?.replace(/\s+/g, ' ').trim().slice(0, 90) || '',
    w: r ? Math.round(r.width) : 0,
  };
});
const lonelyBar = await page.evaluate(() => {
  const gv = document.querySelector('.rp .gv');
  return gv ? gv.innerText.replace(/\s+/g, ' ').trim() : '';
});
ck('换一篇没有链接的笔记：图谱跟着换成它自己的（1 点 0 边，不是留着上一篇的 2 点 1 边）',
   /1 点 \/ 0 边/.test(lonelyBar) && !/2 点/.test(lonelyBar), lonelyBar);
ck('只有一个点时给「这篇还没有链接」的提示（免得一个空心圆看不出所以然）',
   /这篇还没有链接/.test(lonelyBar) && lonely.w > 80, JSON.stringify(lonely));

// 收尾：把这篇临时笔记改回去（只删自己造的两条，绝不整表删）
await A('DELETE', `/api/notes/${nMain.id}`);
await A('DELETE', `/api/notes/${nLonely.id}`);
const left = await A('GET', '/api/notes?lean=1&limit=20');
ck('临时笔记已清理（只删本次造的那几条）', Array.isArray(left) && !left.some((n) => n.id === nMain.id || n.id === nLonely.id), JSON.stringify(left && left.length));

console.log('\n== 窄屏（820px）左栏抽屉：两个关闭手势都要能用 ==');
// 这一段是补的坑：1.10.2 上线后真机点检发现，窄屏下抽屉（78vw）+ 右面板把整屏铺满，
// 遮罩既被顶栏挡又被面板挡 —— ☰（被遮罩吃）和「点空白」（没有空白可点）**两个都废**，
// 用户只能刷新页面。现在：遮罩只盖正文区（贴 .ns-body），且 z-index 高过两个面板。
const geoms = () => page.evaluate(() => {
  const l = document.querySelector('.ns-left');
  const r = l && l.getBoundingClientRect();
  const sc = document.querySelector('.ns-scrim');
  return {
    open: !!r && r.width > 100,
    drawerW: r ? Math.round(r.width) : 0,
    scrim: !!sc,
    // 命中测试：☰ 的中心点上，最上层元素到底是不是 ☰ 自己（被遮罩盖住时会返回 .ns-scrim）
    topBarBlocked: sc ? (() => {
      const b = [...document.querySelectorAll('.ns-top-act button')].find((x) => x.textContent.includes('☰'));
      if (!b) return null;
      const br = b.getBoundingClientRect();
      const hit = document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2);
      return !(hit === b || (hit && b.contains(hit)));
    })() : null,
  };
});
await page.setViewportSize({ width: 820, height: 980 });
await page.waitForTimeout(700);
await page.locator('.ns-top-act button', { hasText: '☰' }).first().click();
await page.waitForTimeout(500);
const g1 = await geoms();
ck('窄屏下 ☰ 能把左栏抽屉打开', g1.open && g1.drawerW > 400, JSON.stringify(g1));
ck('遮罩没有盖住顶栏（☰ 自己仍然点得到）', g1.topBarBlocked === false, JSON.stringify(g1));
await page.locator('.ns-top-act button', { hasText: '☰' }).first().click();
await page.waitForTimeout(400);
ck('再点一次 ☰ 能把抽屉收起来（真机点检前的版本收不起来）', !(await geoms()).open);
await page.locator('.ns-top-act button', { hasText: '☰' }).first().click();
await page.waitForTimeout(400);
ck('第二次打开仍然有效（开关是真的开关，不是一次性）', (await geoms()).open);
// 点抽屉外的空白处也能关：窄屏右面板可能有、也可能收起，这里在抽屉右侧取一点试
const hitX = Math.min(810, (await geoms()).drawerW + 20);
await page.mouse.click(hitX, 700);
await page.waitForTimeout(400);
ck('点抽屉外的空白处也能关（遮罩这次真的露得出来）', !(await geoms()).open, `点在 x=${hitX}`);
await page.screenshot({ path: path.join(ROOT, 'Logs/shots/v1102-narrow-drawer.png') });
await page.setViewportSize({ width: 1500, height: 980 });
await page.waitForTimeout(300);

console.log('\n浏览器错误：' + (errs.length ? '\n  ' + errs.join('\n  ') : '无'));
await browser.close();
stop();
console.log(`\n结果：${fail || errs.length ? '未通过 ❌' : '全部通过 ✅'}（${pass} 通过, ${fail} 失败）`);
process.exit(fail || errs.length ? 1 : 0);
