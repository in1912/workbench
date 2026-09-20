// 家庭与子女富文本图片 e2e：
//  A. 服务端：family_images 上传/鉴权出图/大小与格式校验、/family 与 /kid-tasks 富文本清洗(script 注入剥除)、
//     messageService richToPlain/richImageIds 纯函数、消息落库含图、钉钉 uploadMedia 假凭证报错不崩溃
//  B. UI：RichBox 📎上传 + Ctrl+V 合成粘贴、文字+图片混排登记、列表内联完整显示、
//     家庭事项/学习任务客户端分页(15默认/15-30-50/上一页下一页)、消息气泡图片、系统名称统一(个人工作台)
import { chromium } from 'playwright';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:3000';
const OUT = 'Logs/family-rich-shots';
fs.mkdirSync(OUT, { recursive: true });
const db = new DatabaseSync('data/workbench.sqlite');
const log = (k, v) => console.log(k + ':', v);
const errors = [];
const ck = (name, cond) => { log(name, cond ? '✓' : '✗ FAIL'); if (!cond) errors.push(name); };

// 1x1 红色像素 PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const pngBuf = Buffer.from(PNG_B64, 'base64');

// ---------- 临时用户 + 会话 ----------
db.prepare("INSERT INTO users(username,password_hash,role,allowed_pages,allowed_tabs,is_bot) VALUES('rich_e2e','','user','[]','{}',0)").run();
const uid = db.prepare("SELECT id FROM users WHERE username='rich_e2e'").get().id;
const token = crypto.randomBytes(32).toString('hex');
db.prepare(`INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,'2030-01-01 00:00:00')`).run(token, uid);
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
const req = async (method, url, body, raw) => {
  const r = await fetch(BASE + '/api' + url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: raw ? Buffer.from(await r.arrayBuffer()) : await r.json().catch(() => ({})) };
};

const famIds = [];   // 本脚本登记的家庭事项 id（清理用）
const taskIds = [];  // 学习任务 id
const imgIds = [];   // 图片 id
let imgId = 0;
// UI 上传的图片 id 不在 imgIds 里（浏览器发的请求），记录起点 id，清理时删掉之后新增的
const imgMax0 = (db.prepare('SELECT MAX(id) m FROM family_images').get().m) || 0;

try {
  // ===== A1. 图片上传 / 鉴权出图 =====
  let r = await req('POST', '/family-images', { data: 'data:image/png;base64,' + PNG_B64 });
  imgId = r.data.id; imgIds.push(imgId);
  ck('上传图片返回 id', r.status === 200 && imgId > 0);
  const noAuth = await fetch(`${BASE}/api/family-images/${imgId}`);
  ck('无凭证出图 401', noAuth.status === 401);
  const badToken = await fetch(`${BASE}/api/family-images/${imgId}?token=bad`);
  ck('假 token 出图 401', badToken.status === 401);
  r = await req('GET', `/family-images/${imgId}`, null, true);
  ck('带 token 出图字节一致', r.status === 200 && Buffer.compare(r.data, pngBuf) === 0);

  // ===== A2. 校验：超大 / 非图片 =====
  r = await req('POST', '/family-images', { data: 'data:image/png;base64,' + 'A'.repeat(7 * 1024 * 1024 + 100), mime: 'image/png' });
  ck('超大图片拒 400', r.status === 400 && /过大/.test(r.data.error || ''));
  r = await req('POST', '/family-images', { data: 'data:text/html;base64,PGI+', mime: 'text/html' });
  ck('非图片 mime 拒 400', r.status === 400 && /图片/.test(r.data.error || ''));

  // ===== A3. 富文本清洗 + 推送落库（notify 自己） =====
  const richTitle = `E2E图片家庭事项<img src="/api/family-images/${imgId}"><script>alert(1)</script><b>加粗</b>`;
  r = await req('POST', '/family', { title: richTitle, notify_users: [uid] });
  ck('家庭事项富文本登记', r.status === 200 && r.data.id > 0);
  famIds.push(r.data.id);
  let rows = db.prepare('SELECT title FROM family_items WHERE id=?').get(r.data.id);
  ck('script 标签被剥除', !rows.title.includes('<script') && !rows.title.includes('</script'));
  ck('本站 img 保留、b 标签剥除', rows.title.includes(`<img src="/api/family-images/${imgId}">`) && !rows.title.includes('<b>'));
  // 消息落主库（内容含 img，消息页气泡要显示）
  await new Promise((ok) => setTimeout(ok, 300));
  const msgRow = db.prepare('SELECT content FROM messages WHERE to_user=? AND module=? ORDER BY id DESC LIMIT 1').get(uid, 'family');
  ck('推送消息落库且内容含 img', !!msgRow && msgRow.content.includes(`/api/family-images/${imgId}`));

  // ===== A4. 学习任务富文本 =====
  r = await req('POST', '/kid-tasks', { subject: '数学', content: `E2E任务看图<img src="/api/family-images/${imgId}">`, notify_users: [uid] });
  ck('学习任务富文本登记', r.status === 200 && r.data.id > 0);
  taskIds.push(r.data.id);
  r = await req('GET', '/kids');
  const t = (r.data.tasks || []).find((x) => x.id === taskIds[0]);
  ck('任务内容 img 保留', !!t && t.content.includes(`/api/family-images/${imgId}`));

  // ===== A4b. 勾选保留内容（回归：旧 PATCH 只传 status 会把 title/content 清成空串） =====
  await req('PATCH', `/family/${famIds[0]}`, { status: 'done' });
  const fRow = db.prepare('SELECT title,status FROM family_items WHERE id=?').get(famIds[0]);
  ck('勾选家庭事项不清空内容', fRow.status === 'done' && fRow.title.includes(`<img src="/api/family-images/${imgId}">`) && fRow.title.includes('E2E图片家庭事项'));
  await req('PATCH', `/kid-tasks/${taskIds[0]}`, { status: 'done' });
  const kRow = db.prepare('SELECT content,status FROM kid_tasks WHERE id=?').get(taskIds[0]);
  ck('勾选学习任务不清空内容', kRow.status === 'done' && kRow.content.includes(`/api/family-images/${imgId}`));
  await req('PATCH', `/family/${famIds[0]}`, { status: 'todo' });
  await req('PATCH', `/kid-tasks/${taskIds[0]}`, { status: 'todo' });

  // ===== A5. messageService 纯函数：富文本→钉钉纯文本 =====
  const { richToPlain, richImageIds } = await import('../server/services/messageService.js').then((m) => m.default || m);
  const sample = `甲<img src="/api/family-images/${imgId}">乙<br>丙<img src="/api/family-images/${imgId + 1}"><div>丁</div>`;
  const plain = richToPlain(sample);
  ck('richToPlain: img→[图片N] 顺序编号', plain.includes('甲[图片1]乙') && plain.includes('丙[图片2]'));
  ck('richToPlain: br→换行、多余标签剥除', plain.includes('乙\n丙') && plain.includes('丁') && !plain.includes('<div>'));
  ck('richImageIds: 去重取序', JSON.stringify(richImageIds(sample)) === JSON.stringify([String(imgId), String(imgId + 1)]));

  // ===== A6. 钉钉 uploadMedia 假凭证：报错但可捕获（不崩溃、不碰真实配置） =====
  const dingtalk = await import('../server/services/dingtalkService.js').then((m) => m.default || m);
  const memDb = new DatabaseSync(':memory:');
  memDb.exec('CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT)');
  memDb.prepare('INSERT INTO settings VALUES(?,?)').run('dingtalk_push', JSON.stringify({ app_key: 'e2e_fake_key', app_secret: 'e2e_fake_secret', userid: 'e2e_fake_user', enabled: true, mode: 'robot' }));
  let uploadErr = '';
  try { await dingtalk.uploadMedia(memDb, pngBuf, 'image/png'); } catch (e) { uploadErr = e.message; }
  ck('uploadMedia 假凭证抛错可捕获', uploadErr.length > 0);
  memDb.close();

  // ===== B. UI =====
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  // 未读消息右下角弹窗会盖住翻页按钮（常驻直到已读），e2e 里隐藏避让（不动真实已读状态）
  await page.addInitScript(() => {
    const s = document.createElement('style');
    s.textContent = '.msg-toasts{display:none!important}';
    document.addEventListener('DOMContentLoaded', () => document.head.appendChild(s));
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource.*401/.test(m.text())) errors.push('console: ' + m.text()); });

  // 系统名称统一：登录页标题（当前设置=个人工作台，不应再出现泉哥工作台）
  await page.goto(BASE + '/#/login');
  await page.waitForSelector('.login-title .zh', { timeout: 10000 });
  ck('登录页标题=个人工作台', (await page.locator('.login-title .zh').textContent()).trim() === '个人工作台');

  await page.evaluate(([t, u]) => {
    localStorage.setItem('wb_token', t);
    localStorage.setItem('wb_user', JSON.stringify({ id: u, username: 'rich_e2e', role: 'user', allowed_pages: [], allowed_tabs: {} }));
  }, [token, uid]);
  await page.goto(BASE + '/#/family');
  await page.waitForSelector('.richbox', { timeout: 10000 });
  ck('侧边栏 logo=个人工作台', (await page.locator('.sidebar .logo').textContent()).includes('个人工作台'));
  ck('标签页标题跟随系统名', (await page.title()).includes('个人工作台') && !(await page.title()).includes('泉哥工作台'));
  ck('RichBox 渲染(contenteditable)', (await page.locator('.rb-edit[contenteditable="true"]').count()) === 1);
  ck('占位提示含粘贴说明', ((await page.locator('.rb-edit').getAttribute('data-ph')) || '').includes('Ctrl+V'));

  // 📎 点击上传 + 打字混排 → 登记 → 列表内联完整图片
  fs.writeFileSync('Logs/e2e-tmp-paste.png', pngBuf);
  await page.setInputFiles('.richbox input[type=file]', 'Logs/e2e-tmp-paste.png');
  await page.waitForSelector('.rb-edit img', { timeout: 10000 });
  ck('📎 上传后编辑框内联显示', (await page.locator('.rb-edit img').count()) === 1);
  await page.type('.rb-edit', 'E2E图片测试内容');
  await page.screenshot({ path: OUT + '/richbox-editing.png' });
  await page.click('button.primary'); // 登记
  await page.waitForSelector('.list-item .t.rich img', { timeout: 10000 });
  const listed = page.locator('.list-item .t.rich img').first();
  ck('列表项图片 src 补 token', ((await listed.getAttribute('src')) || '').includes('?token='));
  await page.waitForFunction(() => {
    const im = document.querySelector('.list-item .t.rich img');
    return im && im.complete && im.naturalWidth > 0;
  }, { timeout: 10000 });
  ck('列表图片真实加载(naturalWidth>0)', true);
  ck('登记后编辑框清空', (await page.locator('.rb-edit').innerHTML()) === '');

  // 消息气泡图片（notify 自己的备忘）
  await page.goto(BASE + '/#/messages');
  await page.waitForSelector('.list-item', { timeout: 10000 });
  await page.locator('.list-item', { hasText: '我）' }).first().click();
  await page.waitForSelector('.bubble .rich img', { timeout: 10000 });
  await page.waitForFunction(() => {
    const im = document.querySelector('.bubble .rich img');
    return im && im.complete && im.naturalWidth > 0;
  }, { timeout: 10000 });
  ck('消息气泡图片显示', true);
  await page.screenshot({ path: OUT + '/messages-rich.png' });

  // ===== 分页：家庭事项（共享主库含真实数据，总数动态取全量再断言） =====
  for (let i = 0; i < 17; i++) {
    const rr = await req('POST', '/family', { title: `E2E分页事项${String(i).padStart(2, '0')}` });
    famIds.push(rr.data.id);
  }
  await page.goto(BASE + '/#/family');
  await page.waitForSelector('.pager', { timeout: 10000 });
  await page.waitForTimeout(300); // 等 load() 拉全量后分页计算稳定
  const famN = (await req('GET', '/family')).data.length;
  const famPages = Math.ceil(famN / 15);
  const famItems = () => page.locator('.card .list-item').count();
  ck('家庭事项总数 > 15（可分页）', famN > 15);
  ck('默认每页 15 行', (await famItems()) === Math.min(15, famN));
  const famMuted = await page.locator('.pager .muted').textContent();
  ck(`页码显示 第1/${famPages}页 · 共${famN}条`, famMuted.includes(`共 ${famN} 条`) && famMuted.includes(`第 1/${famPages} 页`));
  ck('首页时上一页禁用', await page.locator('.pager button', { hasText: '上一页' }).isDisabled());
  await page.click('.pager button:has-text("下一页")');
  await page.waitForTimeout(200);
  ck('下一页 → 剩余行数', (await famItems()) === Math.min(15, Math.max(0, famN - 15)));
  await page.click('.pager button:has-text("上一页")');
  await page.waitForTimeout(200);
  ck('上一页 → 回第一页行数', (await famItems()) === Math.min(15, famN));
  await page.selectOption('.pager select', '30');
  await page.waitForTimeout(200);
  ck('切 30 行/页 → 全显', (await famItems()) === Math.min(30, famN));
  await page.screenshot({ path: OUT + '/family-pager.png' });

  // ===== 子女学习 tab：合成 Ctrl+V 粘贴 + 任务分页 =====
  await page.click('.tabs button:has-text("子女学习")');
  await page.waitForSelector('.richbox', { timeout: 10000 });
  await page.evaluate((b64) => { window.__E2E_PNG = b64; }, PNG_B64);
  await page.evaluate(() => {
    const bin = atob(window.__E2E_PNG);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'paste.png', { type: 'image/png' }));
    document.querySelector('.rb-edit').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForSelector('.rb-edit img', { timeout: 10000 });
  ck('Ctrl+V 粘贴 → 编辑框插 图', (await page.locator('.rb-edit img').count()) === 1);
  await page.type('.rb-edit', 'E2E粘贴任务');
  await page.click('button.primary:has-text("下发任务")');
  await page.waitForSelector('.list-item .t.rich img', { timeout: 10000 });
  ck('任务列表显示图片', (await page.locator('.list-item .t.rich img').count()) >= 1);
  // 任务分页：再造 39 条（含 UI 1 条 = 40）
  for (let i = 0; i < 39; i++) {
    const rr = await req('POST', '/kid-tasks', { subject: '语文', content: `E2E分页任务${String(i).padStart(2, '0')}` });
    taskIds.push(rr.data.id);
  }
  await page.goto(BASE + '/#/family');
  await page.reload(); // 同 hash 路由不重挂载，强制刷新拉新数据
  await page.click('.tabs button:has-text("子女学习")');
  await page.waitForSelector('.card h3:has-text("孩子档案")', { timeout: 10000 }); // 等 tab 切换完成再断言
  await page.waitForTimeout(300);
  const kidsData = await req('GET', '/kids');
  const kidsN = (kidsData.data.kids || []).length; // 共享主库含真实孩子档案，同在 .list-item
  const taskN = (kidsData.data.tasks || []).length;
  const taskPages = Math.ceil(taskN / 15);
  const taskItems = () => page.locator('.card .list-item').count(); // 左卡孩子档案 kidsN 项 + 右卡任务
  ck('任务总数 > 30（可翻多页）', taskN > 30);
  ck('任务默认每页 15 行', (await taskItems()) === kidsN + 15);
  await page.click('.pager button:has-text("下一页")');
  await page.waitForTimeout(200);
  ck('任务第 2 页 15 行', (await taskItems()) === kidsN + 15);
  ck(`任务页码 第2/${taskPages}页`, (await page.locator('.pager .muted').textContent()).includes(`第 2/${taskPages} 页`));
  await page.screenshot({ path: OUT + '/tasks-pager.png' });
  await browser.close();
} catch (e) {
  errors.push('脚本异常: ' + e.message);
  console.error(e);
} finally {
  // 清理：只删本脚本标记的数据（家庭表在主库共享，绝不整表清）。
  // UI 登记/粘贴的内容 HTML 以 <img> 开头（图先文后），必须用非锚定 LIKE
  for (const id of famIds) db.prepare('DELETE FROM family_items WHERE id=?').run(id);
  for (const id of taskIds) db.prepare('DELETE FROM kid_tasks WHERE id=?').run(id);
  db.prepare("DELETE FROM family_items WHERE title LIKE '%E2E%'").run();
  db.prepare("DELETE FROM kid_tasks WHERE content LIKE '%E2E%'").run();
  for (const id of imgIds) db.prepare('DELETE FROM family_images WHERE id=?').run(id);
  db.prepare('DELETE FROM family_images WHERE id > ?').run(imgMax0); // 含 UI 上传未跟踪的
  db.prepare('DELETE FROM messages WHERE to_user=?').run(uid);
  db.prepare("DELETE FROM sessions WHERE expires_at='2030-01-01 00:00:00'").run();
  db.prepare('DELETE FROM users WHERE id=?').run(uid);
  try { fs.unlinkSync('Logs/e2e-tmp-paste.png'); } catch {}
  try { fs.unlinkSync(`data/tenant-${uid}.sqlite`); } catch {} // 推送触发的空租户库（server 持连接时删除失败可忽略）
  log('清理', '完成');
}
log('结果', errors.length ? errors.join(' ; ') : '全部通过');
process.exit(errors.length ? 1 : 0);
