// 真浏览器点检：v1.9.41 笔记知识系统。
//
// 为什么需要它：这一版把 /notes 整个换成了三栏外壳 + 十几个新组件，而既有的 e2e 全是**后端**用例，
// 前端只做过「chunk 里有没有某个中文字符串」的字符串级校验 —— 那拦不住 `:disabled="!nodes.length"`
// 这种「模板引用了脚本里根本没有的变量」。线上就是这么炸的（GraphView 一进就白屏）。
// 所以这里用 Playwright 真的把每个视图点一遍，收 pageerror 与 console.error。
//
// 两条纪律（第一版就是栽在这上面）：
//   ① **每一步都要证明视图真的渲染了**（等一个只有它能渲染出来的元素），不能只看「没报错」——
//      空白页同样不报错；
//   ② 元素找不到就是 **失败**，不许用 `if (await count())` 悄悄跳过——那会在空白页上给出假绿。
//
// 用法：node scripts/check-notes-browser.mjs [--headed]
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, startServer, sleep } from './_noteE2E.mjs';

const PORT = 3211;
const HEADED = process.argv.includes('--headed');
const { B, DATA, srv } = await startServer({ tag: 'browser', port: PORT });
console.log('隔离服务器', B, ' DATA =', path.relative(ROOT, DATA));

// ---- 造数据（走 API，直接落在隔离库里）----
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

// ---- 浏览器 ----
const browser = await chromium.launch({ headless: !HEADED });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

const errs = [];
page.on('pageerror', (e) => errs.push({ kind: 'pageerror', text: e.message, stack: String(e.stack || '').split('\n').slice(0, 3).join(' | ') }));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/favicon|ERR_CONNECTION|Failed to load resource/i.test(t)) return; // 静态资源噪声
  errs.push({ kind: 'console', text: t, stack: '' });
});

await page.goto(B, { waitUntil: 'domcontentloaded' });
// wb_user 也得给：应用起来会读它（只给 wb_token 会出现 allowed_pages 读 null 的噪声错误）
await page.evaluate(([tk, u]) => {
  localStorage.setItem('wb_token', tk);
  localStorage.setItem('wb_user', JSON.stringify(u));
}, [TOKEN, admin.user || { username: 'admin' }]);

// ---------- 严格交互助手：找不到就抛，不静默跳过 ----------
const T = 6000;
async function clickText(text, timeout = T) {
  const l = page.getByText(text, { exact: false }).first();
  await l.waitFor({ state: 'visible', timeout });
  await l.click({ timeout });
  return 'clicked';
}
async function expectText(text, timeout = T) {
  // 挑「第一个**可见**的匹配」，不能拿 .first() 直接等。
  // 原因（v1.10.3 改「默认预览」之后踩到的）：编辑器 .cm-wrap 在预览态是 display:none，但节点还在 DOM 里、
  // 内容是**同一段源文**，而且它排在预览前面 —— .first() 落到那个隐藏节点上，waitFor(visible) 必然超时，
  // 明明是渲染好好的却被判失败。
  const l = page.getByText(text, { exact: false });
  const end = Date.now() + timeout;
  for (;;) {
    const n = await l.count();
    for (let i = 0; i < n; i++) if (await l.nth(i).isVisible()) return 'seen';
    if (Date.now() >= end) throw new Error(`等不到可见文本「${text}」（匹配 ${n} 个，全部隐藏或根本不存在）`);
    await page.waitForTimeout(120);
  }
}
async function expectSel(sel, timeout = T) {
  await page.locator(sel).first().waitFor({ state: 'visible', timeout });
  return 'seen';
}
// 按钮必须存在；disabled 就只记「存在但不可点」（这类按钮靠 disabled 表达状态，不该算失败）
async function clickBtn(text, timeout = T) {
  const b = page.locator('button', { hasText: text }).first();
  await b.waitFor({ state: 'attached', timeout });
  if (await b.isDisabled()) return 'disabled';
  await b.click({ timeout });
  return 'clicked';
}

let stepNo = 0;
let fatal = false;
async function step(label, fn, wait = 700) {
  stepNo++;
  const before = errs.length;
  let outcome = null;
  try { outcome = await fn(); } catch (e) {
    // 点击类超时最常见的原因是「元素被别的元素盖住了」——把实据一起记下来，别让人瞎猜
    let diag = '';
    try {
      const m = /\[([^\]]*)\]/.exec(String(e.message));
      const t = label.match(/「([^」]+)」/);
      if (t) {
        diag = await page.evaluate((txt) => {
          const all = [...document.querySelectorAll('button,span,div,a,label')].filter((el) => (el.textContent || '').includes(txt));
          const el = all.find((e2) => e2.offsetParent !== null) || all[0];
          if (!el) return ' （DOM 里找不到这个文本）';
          const r = el.getBoundingClientRect();
          const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return ` （匹配 ${all.length} 个；首个可见元素 ${el.tagName}.${el.className} @${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}；该点最上层是 ${top ? top.tagName + '.' + top.className : 'null'}）`;
        }, t[1]);
      }
      if (!diag) diag = m ? ` （出错选择器：${m[1]}）` : '';
    } catch { /* 诊断本身失败无所谓 */ }
    errs.push({ kind: 'step', text: `[${label}] ${String(e.message).split('\n')[0]}${diag}` });
  }
  await page.waitForTimeout(wait);
  const nu = errs.slice(before);
  ck(`${String(stepNo).padStart(2)}. ${label}${outcome ? ' · ' + outcome : ''}`, nu.length === 0,
    nu.map((e) => `${e.kind}: ${e.text}${e.stack ? ' @ ' + e.stack : ''}`).join('  ///  '));
  return nu.length === 0;
}

console.log('\n== 一、空库进笔记页（线上就是这么炸的）==');
await step('打开 /#/notes', async () => { await page.goto(`${B}/#/notes`, { waitUntil: 'domcontentloaded' }); return 'goto'; }, 1800);
const shellOk = await step('三栏壳渲染出左栏（六分区 + 视图入口）', async () => {
  await expectText('文件', 8000);
  await expectText('🕸 图谱', 8000);
  return '壳体在';
}, 300);
if (!shellOk) { fatal = true; console.log('\n⚠️ 壳体没渲染出来，后续步骤没有意义，提前收尾。'); }

if (!fatal) {
  console.log('\n== 二、左栏六个分区 ==');
  for (const t of ['搜索', '标签', '书签', '模板', '录音', '文件']) {
    await step(`左栏分区「${t}」`, async () => { await clickText(t); return 'clicked'; }, 500);
  }

  console.log('\n== 三、五个视图页（空库）——每页都要真的渲染出来 ==');
  const VIEWS = [
    ['🕸 图谱', async () => { await expectSel('canvas'); await expectText(' 点 / '); }, '空库图谱：画布在'],
    // 注意：别断言 <option> 里的文字（「按更新时间」）—— option 没有布局盒，Playwright 判定不可见，必然超时
    ['🕒 时间线', async () => { await expectText('清空范围'); await expectText('篇 · '); }, '时间线控件在'],
    ['🗃 数据库', async () => { await expectText('文本表达式'); await expectText('表单条件'); }, '查询表单在'],
    ['🧩 白板', async () => { await expectText('＋ 白板'); }, '白板工具栏在'],
    ['❓ 说明', async () => { await expectText('笔记模块速查'); }, '使用说明在'],
  ];
  for (const [t, prove, note] of VIEWS) {
    await step(`视图「${t}」（空库）`, async () => { await clickText(t); await prove(); return note; }, 900);
  }
}

console.log('\n== 四、造数据后重进（图谱/白板/查询有东西才画得出来）==');
const f1 = await A('POST', '/api/notes/folders', { name: '验收文件夹' });
const f2 = await A('POST', '/api/notes/folders', { name: '子文件夹', parent_id: f1.id });
const n1 = await A('POST', '/api/notes', { title: '甲 · 起点', folder_id: f1.id, content: '# 甲\n\n指向 [[乙 · 终点]]，还有个 [[不存在的目标]]。\n\n#验收\n\n正文若干字。' });
const n2 = await A('POST', '/api/notes', { title: '乙 · 终点', folder_id: f2.id, content: '# 乙\n\n回到 [[甲 · 起点]]。\n\n' + '字'.repeat(300) });
const n3 = await A('POST', '/api/notes', { title: '丙 · 孤岛', content: '谁都不指，也没人指我。' });
const pd = await A('POST', '/api/notes/properties', { key: '进度', label: '进度', type: 'number' });
const tpl = await A('POST', '/api/notes/templates', { name: '验收模板', content: '# {{title}}\n\n日期 {{date}} {{time}}\n' });
const bd0 = await A('POST', '/api/notes/boards', { name: '验收白板' });
ck('测试数据就位', [f1.id, f2.id, n1.id, n2.id, n3.id, pd.id, tpl.id, bd0.id].every(Boolean),
  JSON.stringify({ f1, f2, n1, n2, n3, pd, tpl, bd0 }));

if (!fatal) {
  await step('重新载入 /#/notes', async () => { await page.reload({ waitUntil: 'domcontentloaded' }); await expectText('文件', 8000); return 'reload'; }, 1200);

  console.log('\n== 五、五个视图页（有数据）==');
  const VIEWS2 = [
    ['🕸 图谱', async () => { await expectSel('canvas'); await expectText(' 点 / '); await expectText('甲 · 起点'); }, '图谱画出节点'],
    ['🕒 时间线', async () => { await expectText('清空范围'); }, '时间线在'],
    ['🗃 数据库', async () => { await expectText('文本表达式'); }, '查询在'],
    // 板名活在 <option> 里，同样没有布局盒 —— 断言它必然超时（第一版就栽在这）。
    // 换成两条能看得见的证据：空白板提示在 + 下拉确实选中了一块板。
    ['🧩 白板', async () => {
      await expectSel('.wb');
      await expectText('空白板');
      const v = await page.locator('.wb select').first().inputValue();
      if (!v) throw new Error('白板下拉没有选中任何板');
    }, '白板选中了刚建的'],
    ['❓ 说明', async () => { await expectText('笔记模块速查'); }, '说明在'],
  ];
  for (const [t, prove, note] of VIEWS2) {
    await step(`视图「${t}」（有数据）`, async () => { await clickText(t); await prove(); return note; }, 1100);
  }

  console.log('\n== 六、图谱页顶栏按钮与交互 ==');
  await step('回到图谱并等布局画出节点', async () => { await clickText('🕸 图谱'); await expectSel('canvas'); await expectText(' 点 / '); return '就位'; }, 1400);
  for (const t of ['只看孤岛', '居中集散点', '释放钉住', '适配窗口', '查询']) {
    await step(`图谱按钮「${t}」`, async () => clickBtn(t), 700);
  }
  await step('图谱画布滚轮缩放', async () => {
    const c = page.locator('canvas').first();
    await c.hover({ timeout: T });
    await page.mouse.wheel(0, -240);
    return '缩放';
  }, 500);
  await step('图谱画布拖拽平移', async () => {
    const c = page.locator('canvas').first();
    const bb = await c.boundingBox();
    if (!bb) throw new Error('canvas 没有 boundingBox');
    await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
    await page.mouse.down();
    await page.mouse.move(bb.x + bb.width / 2 + 80, bb.y + bb.height / 2 + 40, { steps: 8 });
    await page.mouse.up();
    return '平移';
  }, 600);

  console.log('\n== 七、白板页功能 ==');
  await step('回到白板', async () => { await clickText('🧩 白板'); await expectText('＋ 白板'); return '就位'; }, 1000);
  for (const t of ['＋ 文本', '＋ 链接']) {
    await step(`白板「${t}」加卡片`, async () => { await clickBtn(t); await expectSel('.wcard'); return '卡片已加'; }, 900);
  }
  await step('白板点「＋ 白板」再建一块', async () => { const r = await clickBtn('＋ 白板'); return r; }, 900);
  await step('白板切回第一块板', async () => {
    const sel = page.locator('.wb select').first();
    await sel.selectOption({ label: '验收白板' });
    return '切板';
  }, 1200);

  console.log('\n== 八、打开笔记 + 右栏各模式 ==');
  await step('左栏切回「文件」并点开「甲 · 起点」', async () => {
    await clickText('文件');
    await page.waitForTimeout(500);
    await clickText('甲 · 起点');
    return '已打开';
  }, 1400);
  for (const t of ['大纲', '链接', '属性', '标签', '页签', '统计', '说明']) {
    await step(`右栏模式「${t}」`, async () => clickBtn(new RegExp('^' + t + '$')), 800);
  }
  await step('右栏「链接」里能看到未解析的 [[不存在的目标]]', async () => {
    await clickBtn(/^链接$/);
    // 必须断言在**右栏面板里**：正文预览里也有这几个字（`[[不存在的目标]]` 渲染成链接），
    // 只等「页面上有这几个字」等于什么都没验。
    await page.locator('.rp-body').getByText('不存在的目标').first()
      .waitFor({ state: 'visible', timeout: 6000 });
    return '未解析已在面板里';
  }, 900);
}

console.log('\n== 九、快捷键与浮层 ==');
await step('Ctrl+Shift+P 命令面板', async () => { await page.keyboard.press('Control+Shift+P'); await expectText('今日笔记', 5000); return '面板出来了'; }, 800);
await step('Esc 关掉命令面板', async () => { await page.keyboard.press('Escape'); return 'esc'; }, 400);
await step('Ctrl+O 快速切换器', async () => { await page.keyboard.press('Control+o'); await expectText('甲 · 起点', 5000); return '切换器出来了'; }, 800);
await step('Esc 关掉切换器', async () => { await page.keyboard.press('Escape'); return 'esc'; }, 400);
await step('Alt+N 新建笔记', async () => { await page.keyboard.press('Alt+n'); return 'n'; }, 900);
await step('Ctrl+S 保存', async () => { await page.keyboard.press('Control+s'); return 's'; }, 900);
await step('Ctrl+P 打开/新建今日笔记', async () => { await page.keyboard.press('Control+p'); return 'p'; }, 1800);

console.log('\n== 十、日程页的「显示笔记」开关（本版新插件）==');
await step('打开 /#/tasks', async () => { await page.goto(`${B}/#/tasks`, { waitUntil: 'domcontentloaded' }); return 'goto'; }, 1800);
await step('点「显示笔记」开关', async () => {
  const l = page.locator('label', { hasText: '显示笔记' }).first();
  await l.waitFor({ state: 'visible', timeout: T });
  await l.click({ timeout: T });
  return '已切换';
}, 1500);
await step('打开后日历格子里出现当天笔记标题「甲 · 起点」', async () => {
  const chip = page.getByText('甲 · 起点').first();
  await chip.waitFor({ state: 'visible', timeout: 6000 });
  return '按日聚合生效';
}, 800);

console.log('\n== 十一、窄屏 + 暗色 ==');
// 窄屏下左栏是浮动抽屉、默认收起（避免一进页面就挡住正文），靠顶栏的 ☰ 展开。
// v1.10.2 之前 leftOpen 只被赋过 false —— 那个 ☰ 是当时补的入口，这一步顺带守住它。
await step('视口压到 820px 重进笔记页', async () => {
  await page.setViewportSize({ width: 820, height: 900 });
  await page.goto(`${B}/#/notes`, { waitUntil: 'domcontentloaded' });
  await page.locator('.nshell.narrow').first().waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('.ns-top-act button', { hasText: '☰' }).first().click({ timeout: 8000 });
  await expectText('文件', 8000);
  return '窄屏壳体在，左栏抽屉能展开';
}, 1500);
await step('切暗色重载', async () => {
  await page.evaluate(() => localStorage.setItem('wb_theme', 'dark'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.ns-top-act button', { hasText: '☰' }).first().click({ timeout: 8000 });
  await expectText('文件', 8000);
  return '暗色在';
}, 1500);
await step('视口还原 1400px', async () => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expectText('文件', 8000);
  return '还原';
}, 1200);

console.log('\n== 十二、长笔记：编辑器必须能滚到底（v1.10.4 修的线上缺陷）==');
// 缺陷长这样：.cm-editor 被 @codemirror/view 的基础主题钉成 position:relative!important，
// 于是「绝对定位铺满 .cm-wrap」那条 CSS 从来没生效 —— 一篇 200 行的笔记把 .cm-editor 撑到 4700px，
// 塞在 600px 的 .cm-wrap 里被 overflow:hidden 裁掉，而 .cm-scroller 自身盒子跟内容一样高，
// **永远不滚动**：用户只能看到前 36 行，往下滚不动。短笔记看不出来，长笔记必现。
// 所以这一节用一篇 200 行的笔记当尺子：盒子高度必须被约束住、滚到底必须能看见最后一行。
const LONG_LINES = [];
for (let i = 1; i <= 200; i++) LONG_LINES.push(i === 200 ? 'SENTINEL-END-第200行' : `第 ${i} 行：这是一行把文档撑长的正文。`);
LONG_LINES.splice(20, 0, '```bash', 'ls -la /tmp', '```');
const nLong = await A('POST', '/api/notes', { title: '长文探针', content: LONG_LINES.join('\n') });

await step('打开 200 行的长笔记并进编辑态', async () => {
  await page.goto(`${B}/#/notes?note=${nLong.id}`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.mbtn', { hasText: '编辑' }).first().waitFor({ state: 'visible', timeout: T });
  await page.locator('.mbtn', { hasText: '编辑' }).first().click({ timeout: T });
  await page.waitForTimeout(1500);
  return '就位';
}, 800);
const longBox = await page.evaluate(() => {
  const wrap = document.querySelector('.cm-wrap');
  const ed = document.querySelector('.cm-editor');
  const sc = document.querySelector('.cm-scroller');
  return {
    wrapH: Math.round(wrap.getBoundingClientRect().height), edH: Math.round(ed.getBoundingClientRect().height),
    sh: sc.scrollHeight, ch: sc.clientHeight,
  };
});
ck('编辑器盒子被约束在容器里（不再撑成整篇文档那么高）',
   longBox.edH <= longBox.wrapH + 4 && longBox.edH > 200, JSON.stringify(longBox));
ck('内容比可视区高（说明确实是长文，尺子有效）', longBox.sh > longBox.ch * 2, JSON.stringify(longBox));

await step('在编辑器里滚到底', async () => {
  await page.mouse.move(500, 500);
  for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 900); await page.waitForTimeout(100); }
  return '滚了';
}, 400);
const longEnd = await page.evaluate(() => {
  const sc = document.querySelector('.cm-scroller');
  const lines = [...document.querySelectorAll('.cm-line')];
  return {
    st: sc.scrollTop, sh: sc.scrollHeight, ch: sc.clientHeight,
    hasSentinel: sc.textContent.includes('SENTINEL-END'),
    lines: lines.length,
  };
});
ck('滚动真的生效了（scrollTop > 0）', longEnd.st > 0, JSON.stringify(longEnd));
ck('滚到底能看见最后一行（第 200 行哨兵）', longEnd.hasSentinel === true, JSON.stringify(longEnd));

// ---- 汇总 ----
console.log('\n== 浏览器错误明细 ==');
if (!errs.length) console.log('  （无）');
errs.slice(0, 40).forEach((e, i) => console.log(`  ${i + 1}. [${e.kind}] ${e.text}${e.stack ? '\n       ' + e.stack : ''}`));

await browser.close();
srv.kill('SIGKILL');
await sleep(200);
fs.rmSync(DATA, { recursive: true, force: true });

console.log(`\n结果：${total.pass} 通过 / ${total.fail} 失败（累计 ${errs.length} 条浏览器错误）`);
process.exit(total.fail || errs.length ? 1 : 0);
