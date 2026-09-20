// 复现「图片上传失败：Cannot read properties of null (reading 'focus')」：
// 逐一尝试真实用户路径：📎点击、粘贴、粘贴后立刻切tab、立刻登记、立刻跳页、连续两张
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const BASE = 'http://localhost:3000';
const db = new DatabaseSync('data/workbench.sqlite');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
db.prepare("INSERT OR IGNORE INTO users(username,password_hash,role,allowed_pages,allowed_tabs,is_bot) VALUES('rich_e2e','','user','[]','{}',0)").run();
const uid = db.prepare("SELECT id FROM users WHERE username='rich_e2e'").get().id;
const token = crypto.randomBytes(32).toString('hex');
db.prepare(`INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,'2030-01-01 00:00:00')`).run(token, uid);

const PNG_B64 = png.toString('base64');
let imgMax0 = (db.prepare('SELECT MAX(id) m FROM family_images').get().m) || 0;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('dialog', async (d) => { console.log('  [alert]', d.message().slice(0, 120)); await d.accept(); });
page.on('pageerror', (e) => console.log('  [pageerror]', e.message.slice(0, 120)));
await page.addInitScript(() => {
  const s = document.createElement('style');
  s.textContent = '.msg-toasts{display:none!important}';
  document.addEventListener('DOMContentLoaded', () => document.head.appendChild(s));
  window.__setTok = (t, u) => { localStorage.setItem('wb_token', t); localStorage.setItem('wb_user', JSON.stringify({ id: u, username: 'rich_e2e', role: 'user', allowed_pages: [], allowed_tabs: {} })); };
});
await page.goto(BASE + '/#/login');
await page.evaluate((t) => window.__setTok(t, 0), token); // 先占位，下面重设
await page.evaluate(([t, u]) => window.__setTok(t, u), [token, uid]);

// 向 sel 指定的编辑框合成 Ctrl+V 图片粘贴（先点击聚焦，贴近真实操作）
async function paste(sel) {
  await page.click(sel);
  await page.evaluate(([s, b64]) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'paste.png', { type: 'image/png' }));
    document.querySelector(s).dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [sel, PNG_B64]);
}

// 场景1：📎 点击上传（真实 filechooser）
console.log('场景1 📎点击上传');
await page.goto(BASE + '/#/family');
await page.waitForSelector('.rb-edit');
const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('.rb-btn')]);
await fc.setFiles({ name: 'a.png', mimeType: 'image/png', buffer: png });
await page.waitForTimeout(800);
console.log('  编辑框img数:', await page.locator('.rb-edit img').count());

// 场景2：粘贴（点击聚焦后）
console.log('场景2 Ctrl+V 粘贴');
await page.reload();
await page.waitForSelector('.rb-edit');
await paste('.rb-edit');
await page.waitForTimeout(800);
console.log('  编辑框img数:', await page.locator('.rb-edit img').count());

// 场景3：粘贴后立刻切到子女学习 tab（竞态）
console.log('场景3 粘贴后立刻切tab');
await page.reload();
await page.waitForSelector('.rb-edit');
await paste('.rb-edit');
await page.click('.tabs button:has-text("子女学习")'); // 不等待上传
await page.waitForTimeout(1200);
console.log('  切tab后未捕获错误?');

// 场景4：子女学习 tab 粘贴后立刻点登记按钮旁/切回家庭事项
console.log('场景4 子女tab粘贴后立刻切回');
await page.waitForSelector('h3:has-text("孩子档案")');
await paste('.rb-edit');
await page.click('.tabs button:has-text("家庭事项")');
await page.waitForTimeout(1200);

// 场景5：粘贴后立刻点「登记」
console.log('场景5 粘贴后立刻登记');
await page.reload();
await page.waitForSelector('.rb-edit');
await paste('.rb-edit');
await page.click('button.primary'); // 登记
await page.waitForTimeout(1200);
console.log('  编辑框img数:', await page.locator('.rb-edit img').count(), '列表img数:', await page.locator('.list-item img').count());

// 场景6：粘贴后立刻整页跳走（消息页）
console.log('场景6 粘贴后立刻跳消息页');
await page.reload();
await page.waitForSelector('.rb-edit');
await paste('.rb-edit');
await page.goto(BASE + '/#/messages');
await page.waitForTimeout(1200);

// ===== 慢网络（模拟手机/局域网）：拦截上传接口延迟 1.5s =====
await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
await page.route('**/api/family-images', async (route) => {
  if (route.request().method() === 'POST') await new Promise((ok) => setTimeout(ok, 1500));
  route.continue();
});

console.log('场景7 慢上传-占位即时出现+登记按钮禁用');
await page.goto(BASE + '/#/family');
await page.waitForSelector('.rb-edit');
await paste('.rb-edit');
await page.waitForSelector('.rb-edit .rb-up', { timeout: 3000 }).then(() => console.log('  占位即时出现 ✓')).catch(() => console.log('  占位未出现 ✗'));
const dis = await page.locator('button.primary[title*="上传中"]').isDisabled().catch(() => false);
console.log('  上传中登记按钮禁用:', dis ? '✓' : '✗');
await page.waitForSelector('.rb-edit img', { timeout: 8000 });
console.log('  上传完成替换为图片 ✓, 按钮恢复:', !(await page.locator('button.primary').isDisabled()) ? '✓' : '✗');

console.log('场景8 慢上传-粘贴后立刻切tab（原报错场景）');
await page.reload();
await page.waitForSelector('.rb-edit');
await paste('.rb-edit');
await page.click('.tabs button:has-text("子女学习")'); // 上传还在路上就切走
await page.waitForTimeout(2500);
console.log('  完成且无 alert');

console.log('场景9 慢上传-粘贴后立刻整页跳走');
await page.goto(BASE + '/#/family');
await page.waitForSelector('.rb-edit');
await paste('.rb-edit');
await page.goto(BASE + '/#/messages');
await page.waitForTimeout(2500);
console.log('  完成且无 alert');

await page.unroute('**/api/family-images').catch(() => {});

// 场景10：勾选只打勾——内容保留、位置不动、无删除线
console.log('场景10 勾选行为');
await page.goto(BASE + '/#/family');
await page.waitForSelector('.list-item');
const firstTitle = (await page.locator('.list-item .t.rich').first().textContent()).trim();
await page.locator('.list-item .check').first().click();
await page.waitForTimeout(800);
const firstTitle2 = (await page.locator('.list-item .t.rich').first().textContent()).trim();
const checkTxt = (await page.locator('.list-item .check').first().textContent()).trim();
const hasStrike = await page.locator('.list-item .strike').count();
console.log('  勾选后仍在原位(首行标题不变):', firstTitle === firstTitle2 ? '✓' : `✗ (${firstTitle} → ${firstTitle2})`);
console.log('  圈内变✓:', checkTxt === '✓' ? '✓' : `✗(${checkTxt})`, '· 无删除线样式:', hasStrike === 0 ? '✓' : '✗');
await page.locator('.list-item .check').first().click(); // 还原
await page.waitForTimeout(500);

// 场景11：登记日期默认今天 + 宽图收缩到框宽 + 点图开查看器（滚轮缩放）
console.log('场景11 日期默认/图片收缩/查看器');
await page.goto(BASE + '/#/family');
await page.waitForSelector('.rb-edit');
const d = new Date(); const p2 = (n) => String(n).padStart(2, '0');
const todayS = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const famDate = await page.locator('input[type=date]').first().inputValue();
console.log('  家庭事项日期默认今天:', famDate === todayS ? '✓' : `✗(${famDate})`);
await page.click('.tabs button:has-text("子女学习")');
await page.waitForSelector('h3:has-text("孩子档案")');
const kidDate = await page.locator('input[type=date]').first().inputValue();
console.log('  任务截止日期默认今天:', kidDate === todayS ? '✓' : `✗(${kidDate})`);
// 1200px 宽图粘贴 → 编辑框内收缩
await page.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 1200; c.height = 300;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#4f7cf7'; ctx.fillRect(0, 0, 1200, 300);
  c.toBlob((b) => {
    const dt = new DataTransfer();
    dt.items.add(new File([b], 'wide.png', { type: 'image/png' }));
    document.querySelector('.rb-edit').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  });
});
await page.waitForSelector('.rb-edit img', { timeout: 8000 });
const dims = await page.evaluate(() => {
  const box = document.querySelector('.rb-edit');
  const img = document.querySelector('.rb-edit img');
  return { imgW: img.clientWidth, boxW: box.clientWidth, natural: img.naturalWidth };
});
console.log(`  宽图 ${dims.natural}px → 显示 ${dims.imgW}px（框宽 ${dims.boxW}px）:`, dims.imgW <= dims.boxW ? '✓' : '✗');
await page.type('.rb-edit', 'E2E查看器测试');
await page.click('button.primary:has-text("下发任务")');
await page.waitForSelector('.list-item .t.rich img', { timeout: 8000 });
await page.locator('.list-item .t.rich img').first().click();
await page.waitForSelector('.img-viewer', { timeout: 5000 });
console.log('  点击图片打开查看器 ✓');
const s0 = (await page.locator('.iv-scale').textContent()).trim();
await page.mouse.move(700, 400);
await page.mouse.wheel(0, -240);
await page.waitForTimeout(250);
const s1 = (await page.locator('.iv-scale').textContent()).trim();
console.log(`  滚轮缩放 ${s0}→${s1}:`, s0 !== s1 ? '✓' : '✗');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
console.log('  Esc 关闭查看器:', (await page.locator('.img-viewer').count()) === 0 ? '✓' : '✗');

await browser.close();
// 清理
db.prepare("DELETE FROM family_items WHERE title LIKE '%E2E%' OR title LIKE '%<img%'").run();
db.prepare("DELETE FROM kid_tasks WHERE content LIKE '%E2E查看器测试%'").run(); // 场景11下发任务残留
db.prepare('DELETE FROM family_images WHERE id > ?').run(imgMax0);
db.prepare("DELETE FROM messages WHERE to_user=?").run(uid);
db.prepare("DELETE FROM sessions WHERE token=?").run(token);
db.prepare("DELETE FROM users WHERE id=?").run(uid);
console.log('done');
