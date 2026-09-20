// E2E：钉钉机器人接收图片消息（v1.2.7）
// 根因：processRobotMessage 只认 p.text.content，msgtype=picture/richText 的消息没有 text 字段 → 直接被丢弃。
// 修复：picture/richText → downloadCode 经下载接口换临时链接 → 字节落主库 message_images →
//       消息体 <img src="/api/message-images/N">；失败兜底文字提示，绝不静默丢。
// 测试：隔离服务 + 测试进程内直接调 processRobotMessage（stub downloadRobotFileUrl 指向本地文件服务器），
//       另带 Messages 页气泡渲染 UI 断言（displayHtml 新路由）。
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'tmp-dtimg-e2e');
const PORT = 3999;
const FPORT = 3123; // 本地"钉钉文件服务器"（stub 下载链接指向这里）
const B = `http://127.0.0.1:${PORT}`;

// 关键：隔离 DATA_DIR 必须在 import 任何 server 模块之前设置（db.js sweep 会导入 data/ 根下的杂库）
process.env.DATA_DIR = DATA;

let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  <<< ' + extra}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
const srv = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456', TTS_ROOT: path.join(DATA, 'no-tts') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', (d) => console.error('[srv-err]', String(d).slice(0, 300)));
await sleep(2500);

try {
  // ---- 登录 + 租户库惰性建表 ----
  let r = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test123456' }) });
  const lj = await r.json();
  ck('管理员登录', r.status === 200 && !!lj.token);
  const uid = lj.user.id;
  const TK = lj.token;
  await fetch(`${B}/api/emails/attach-config`, { headers: { Authorization: 'Bearer ' + TK } });

  // ---- 本地文件服务器：/img.png 出真 PNG，/notimg 出文本 ----
  const reqSrv = createRequire(path.join(ROOT, 'server', 'services', 'dingtalkStreamService.js'));
  const dingtalk = reqSrv('./dingtalkService');
  const svc = reqSrv('./dingtalkStreamService.js');
  const PNG = dingtalk.makeTestPng();
  const filesrv = http.createServer((q, s) => {
    if (q.url.startsWith('/notimg')) { s.setHeader('Content-Type', 'text/plain'); return s.end('this is definitely not an image');
    }
    s.setHeader('Content-Type', 'image/png'); s.end(PNG);
  }).listen(FPORT, '127.0.0.1');
  await new Promise((res) => filesrv.once('listening', res));
  const origDl = dingtalk.downloadRobotFileUrl;
  const stubDl = (url) => { dingtalk.downloadRobotFileUrl = async () => url; };
  stubDl(`http://127.0.0.1:${FPORT}/img.png`);

  const botUid = svc.botId();
  ck('机器人虚拟成员就绪', botUid > 0);
  const { db } = reqSrv('../db');
  const cnt = () => db.prepare("SELECT COUNT(*) c FROM messages WHERE module='dingtalk'").get().c;
  const getMsg = (ext) => db.prepare("SELECT * FROM messages WHERE module='dingtalk' AND ext_id=?").get(ext);
  const basePay = (over) => ({
    msgId: '', msgtype: 'text', text: { content: '' },
    robotCode: 'e2erobot', conversationId: 'cid1', conversationType: '2', conversationTitle: 'E2E测试群',
    senderNick: '张三', sessionWebhook: '', sessionWebhookExpiredTime: 0, ...over,
  });

  // ---- 1. 纯图片消息 ----
  let res = svc.processRobotMessage(uid, basePay({ msgId: 'e2epic1', msgtype: 'picture', content: { pictureDownloadCode: 'pc1', downloadCode: 'dc1' } }));
  ck('图片消息同步受理（先 ack）', res.ok === true && !!res.async);
  const t1 = await res.async;
  ck('后台落库成功', t1.ok === true && t1.id > 0, JSON.stringify(t1));
  const m1 = getMsg('e2epic1');
  ck('消息体含本站图床 img', !!m1 && m1.content.includes('<img src="/api/message-images/1">'), m1 && m1.content);
  ck('发件人署名在消息体里', !!m1 && m1.content.includes('张三：'), m1 && m1.content.slice(0, 30));
  const im1 = db.prepare('SELECT * FROM message_images WHERE id=1').get();
  ck('message_images 落库（png/字节数）', !!im1 && im1.mime === 'image/png' && im1.size === PNG.length && im1.data, JSON.stringify(im1 && { mime: im1.mime, size: im1.size, sp: im1.storage_path }));

  // ---- 2. 取图接口（带 token 200 / 裸请求 401） ----
  r = await fetch(`${B}/api/message-images/1?token=${encodeURIComponent(TK)}`);
  const imgBuf = Buffer.from(await r.arrayBuffer());
  ck('GET /message-images/:id?token= 200 且 PNG 魔数', r.status === 200 && imgBuf.slice(0, 8).equals(PNG.slice(0, 8)), `${r.status} len=${imgBuf.length}`);
  r = await fetch(`${B}/api/message-images/1`);
  ck('裸请求 401', r.status === 401, String(r.status));
  r = await fetch(`${B}/api/message-images/999?token=${encodeURIComponent(TK)}`);
  ck('不存在 404', r.status === 404, String(r.status));

  // ---- 3. 重推去重（下载完成后走 ext_id 查重） ----
  const n1 = cnt();
  res = svc.processRobotMessage(uid, basePay({ msgId: 'e2epic1', msgtype: 'picture', content: { downloadCode: 'dc1' } }));
  ck('同 msgId 重推被忽略', res.ok === false && /重复/.test(res.reason || ''), JSON.stringify(res));
  ck('消息数未增加', cnt() === n1);

  // ---- 4. 下载失败 → 兜底文字提示（不静默丢） ----
  dingtalk.downloadRobotFileUrl = async () => { throw new Error('下载码已过期'); };
  res = svc.processRobotMessage(uid, basePay({ msgId: 'e2epic2', msgtype: 'picture', content: { pictureDownloadCode: 'pc2' } }));
  const t2 = await res.async;
  ck('失败也有消息 id', t2.ok === true && t2.id > 0, JSON.stringify(t2));
  const m2 = getMsg('e2epic2');
  ck('兜底为文字提示（含原因）', !!m2 && m2.content.includes('图片消息接收失败') && m2.content.includes('下载码已过期'), m2 && m2.content);

  // ---- 5. 富文本（文字+图片+文字混合） ----
  stubDl(`http://127.0.0.1:${FPORT}/img.png`);
  res = svc.processRobotMessage(uid, basePay({
    msgId: 'e2ert1', msgtype: 'richText',
    content: { richText: [{ text: '看这张图' }, { pictureDownloadCode: 'pc3', downloadCode: 'dc3', type: 'picture' }, { text: '明白了吗' }] },
  }));
  const t3 = await res.async;
  ck('富文本落库', t3.ok === true && t3.id > 0, JSON.stringify(t3));
  const m3 = getMsg('e2ert1');
  ck('文字段保留且图片入图床', !!m3 && m3.content.includes('张三：看这张图') && m3.content.includes('/api/message-images/2') && m3.content.includes('明白了吗'), m3 && m3.content);
  ck('第二张图入库', !!db.prepare('SELECT id FROM message_images WHERE id=2').get());

  // ---- 6. 下载内容不是图片 → 兜底 ----
  stubDl(`http://127.0.0.1:${FPORT}/notimg`);
  res = svc.processRobotMessage(uid, basePay({ msgId: 'e2epic3', msgtype: 'picture', content: { downloadCode: 'dc9' } }));
  const t4 = await res.async;
  const m4 = getMsg('e2epic3');
  ck('非图片内容兜底提示', t4.ok === true && !!m4 && m4.content.includes('不是支持的图片格式'), m4 && m4.content);

  // ---- 7. 语音消息（单聊才会推）→ 文字提示 ----
  res = svc.processRobotMessage(uid, basePay({ msgId: 'e2eaud1', msgtype: 'audio', content: { downloadCode: 'a1' } }));
  const m5 = getMsg('e2eaud1');
  ck('语音消息文字提示', res.ok === true && !!m5 && m5.content.includes('收到一条语音消息'), m5 && m5.content);

  // ---- 8. 单聊按发件人路由（v1.2.9）：senderStaffId 匹配成员绑定 → 进本人信箱 ----
  let r2 = await fetch(`${B}/api/users`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TK }, body: JSON.stringify({ username: 'wen', password: 'Wen123456', role: 'user' }) });
  const wenId = (await r2.json()).id;
  ck('创建成员 wen', r2.status === 200 && wenId > 0, String(r2.status));
  const { getTenantDb, setSetting, getSetting } = reqSrv('../db');
  // wen 绑定同一应用（userid=staff_wen）——单聊消息应进 wen 自己的信箱，不再全进管理员
  setSetting(getTenantDb(wenId), 'dingtalk_push', { app_key: 'e2eapp', app_secret: 'sec', userid: 'staff_wen', enabled: true });
  res = svc.processRobotMessage(uid, basePay({ msgId: 'e2er1', text: { content: '单聊你好' }, conversationType: '1', conversationId: 'wc1', conversationTitle: '', senderNick: '温泉', senderStaffId: 'staff_wen' }), 'e2eapp');
  const mw = getMsg('e2er1');
  ck('单聊路由到 wen 本人信箱', !!mw && mw.to_user === wenId, mw && `to_user=${mw.to_user} wen=${wenId}`);
  ck('单聊主题=发件人昵称（不再是「机器人单聊」）', !!mw && mw.subject === '温泉', mw && mw.subject);
  ck('wen 的回复通道已按人记录', !!(getSetting(db, 'dingtalk_robot_state_u' + wenId) || {}).conversation_id);
  // 未绑定的发件人单聊 → 回落应用归属人 admin
  res = svc.processRobotMessage(uid, basePay({ msgId: 'e2er2', text: { content: '陌生单聊' }, conversationType: '1', senderStaffId: 'stranger' }), 'e2eapp');
  const mstr = getMsg('e2er2');
  ck('未匹配发件人回落归属人', !!mstr && mstr.to_user === uid, mstr && `to_user=${mstr.to_user}`);
  // 群聊不路由：仍归归属人
  res = svc.processRobotMessage(uid, basePay({ msgId: 'e2er3', text: { content: '群里@机器人' }, senderStaffId: 'staff_wen' }), 'e2eapp');
  const mg = getMsg('e2er3');
  ck('群聊仍归归属人', !!mg && mg.to_user === uid, mg && `to_user=${mg.to_user}`);

  // ---- 9. robotReply 通道（v1.2.9）：单聊 webhook 过期 → 机器人单发到本人绑定 ----
  setSetting(db, 'dingtalk_robot_state_u' + wenId, { conversation_type: '1', session_webhook: '', session_webhook_expire: 0, conversation_id: 'wc1', robot_code: 'e2erobot' });
  let sent = null;
  const origSend = dingtalk.sendRobot, origToken = dingtalk.getToken;
  dingtalk.sendRobot = async (d, token, text) => { sent = { token, text }; return true; };
  dingtalk.getToken = async () => 'e2e-token';
  const ok1 = await svc.robotReply(wenId, '工作台回复');
  dingtalk.sendRobot = origSend; dingtalk.getToken = origToken;
  ck('单聊过期走机器人单发（oToMessages）', ok1 === true && !!sent, `ok=${ok1}`);
  ck('单发内容带署名', !!sent && sent.text.includes('【工作台·wen】') && sent.text.includes('工作台回复'), sent && sent.text);
  const ok2 = await svc.robotReply(99999, 'x'); // 租户库无任何配置
  ck('未绑定成员回复返回 false', ok2 === false, `ok=${ok2}`);

  // ---- 10. 发送失败回执（v1.2.9）：通道不可用时不再静默——会话里出现失败提示 ----
  r = await fetch(`${B}/api/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TK }, body: JSON.stringify({ to_users: [botUid], content: 'e2e 通道测试' }) });
  ck('发给机器人 200', r.status === 200, String(r.status));
  let notice = null;
  for (let i = 0; i < 20 && !notice; i++) {
    await sleep(200);
    notice = db.prepare("SELECT * FROM messages WHERE module='dingtalk' AND from_user=? AND to_user=? AND (content LIKE '[钉钉发送失败%' OR content LIKE '[未送达%') ORDER BY id DESC").get(botUid, uid);
  }
  ck('失败回执进了会话（不再静默）', !!notice, notice && notice.content);

  // ---- 11. UI：消息页气泡渲染图片（displayHtml 新路由） ----
  stubDl(`http://127.0.0.1:${FPORT}/img.png`);
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addInitScript((t) => { localStorage.setItem('wb_token', t); }, TK);
  await ctx.addInitScript((u) => { localStorage.setItem('wb_user', u); }, JSON.stringify(lj.user));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(`${B}/#/messages`);
  await page.waitForSelector('.list-item', { timeout: 15000 });
  await page.locator('.list-item', { hasText: '钉钉' }).first().click();
  await page.waitForSelector('.bubble .rich', { timeout: 10000 });
  const img = page.locator('.bubble .rich img').first();
  await img.waitFor({ state: 'visible', timeout: 10000 });
  const nw = await img.evaluate((el) => el.naturalWidth);
  ck('气泡图片真实渲染（naturalWidth>0）', nw > 0, String(nw));
  const src = await img.getAttribute('src');
  ck('img src 补了 token', /\/api\/message-images\/\d+\?token=/.test(src || ''), src);
  const hasFallback = await page.locator('.bubble', { hasText: '图片消息接收失败' }).count();
  ck('兜底文字消息可见', hasFallback > 0);
  // 打开会话应贴底显示最新一条（v1.2.9：图片异步加载后补滚，不再停在那天的第一条）
  await sleep(600);
  const atBottom = await page.evaluate(() => {
    const el = document.querySelector('.history');
    return !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  });
  ck('会话打开贴底（最新一条可见）', atBottom);
  await page.screenshot({ path: 'Logs/dingtalk-image-msg.png', fullPage: false });
  ck('无 pageerror', errors.length === 0, errors.slice(0, 2).join(' | '));
  await browser.close();
  dingtalk.downloadRobotFileUrl = origDl;
  filesrv.close();
} catch (e) {
  fail++;
  console.error('  ✗ 脚本异常:', e.message);
} finally {
  srv.kill();
  await sleep(600);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
}
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
