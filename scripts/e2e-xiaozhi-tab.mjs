// e2e：智能家居 → 智能板 tab（v1.9.11）
// 覆盖：能力探测 / 配置读写与校验 / tab 权限矩阵（成员无 xiaozhi tab 403）/ 桥接 key 403 与业务 JSON /
//       工具清单 + CH343 驱动 zip 下载（PK 头）/ 构建状态机空转。
// 真机构建烧录链路（ESP-IDF 编译 + COM4 烧录，需开发机工具链与插板）默认关闭：
//   E2E_XIAOZHI_BUILD=1 node scripts/e2e-xiaozhi-tab.mjs          （编译，不烧录）
//   E2E_XIAOZHI_BUILD=1 E2E_XIAOZHI_FLASH=1 node scripts/e2e-xiaozhi-tab.mjs （编译并烧录 COM4）
// 隔离 DATA_DIR 必须在 import 任何 server 模块之前设置（db.js sweep 会导入 data/ 根下的杂库）。
import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const PORT = 3187;
const B = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), 'wb-xiaozhi-'));
process.env.DATA_DIR = DATA;

let passed = 0, failed = 0;
const ok = (cond, name) => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.error(`  ✗ ${name}`); } };

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: path.join(import.meta.dirname, '..'),
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => process.env.E2E_VERBOSE && process.stderr.write(d));

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${B}/api/health`);
      if (r.ok) return;
    } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('服务 60s 未就绪');
}

async function api(method, url, { token, body } = {}) {
  const r = await fetch(B + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = r.headers.get('content-type') || '';
  const j = ct.includes('json') ? await r.json() : await r.arrayBuffer();
  return { status: r.status, j };
}

try {
  await waitReady();
  console.log('— 登录与能力探测');
  const lg = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'test123456' } });
  const T = lg.j.b?.token || lg.j.token;
  ok(!!T, 'admin 登录拿到 token');
  const cap = await api('GET', '/api/xiaozhi/capabilities', { token: T });
  ok(cap.status === 200 && typeof cap.j.canBuild === 'boolean' && 'firmware' in cap.j, 'capabilities 返回 canBuild/firmware（本机 canBuild=' + cap.j.canBuild + '）');

  console.log('— 配置读写与校验');
  ok((await api('PUT', '/api/xiaozhi/config', { token: T, body: { wake: { pinyin: 'Xiao Yang-Yang', display: '小阳阳', threshold: 20 } } })).status === 400, '非法拼音（大写/连字符）被拒 400');
  ok((await api('PUT', '/api/xiaozhi/config', { token: T, body: { wake: { pinyin: 'xiao yang yang', display: '小阳阳', threshold: 0 } } })).status === 400, '阈值越界（0）被拒 400');
  const put = await api('PUT', '/api/xiaozhi/config', { token: T, body: { wake: { pinyin: 'xiao yang yang', display: '小阳阳', threshold: 18 }, channel: 'speaker', bridge: { url: 'http://192.168.110.105:3000/api/xiaozhi/bridge' } } });
  ok(put.status === 200 && put.j.config.wake.threshold === 18 && put.j.config.channel === 'speaker', '合法配置保存成功（阈值/通道回读一致）');
  const spPut = await api('PUT', '/api/xiaozhi/config', { token: T, body: { speaker: { did: '1149549826', siid_play: '', aiid_play: 3, siid_exec: '', aiid_exec: 4 } } });
  ok(spPut.status === 200 && spPut.j.config.speaker.did === '1149549826', '智能屏配置保存成功（did 是数字字符串，不误报「需为整数」——v1.9.12 生产回归）');
  ok((await api('PUT', '/api/xiaozhi/config', { token: T, body: { speaker: { did: 'abc' } } })).status === 400, '智能屏 did 非数字被拒');
  ok((await api('PUT', '/api/xiaozhi/config', { token: T, body: { speaker: { did: '1149549826', aiid_play: 3.5 } } })).status === 400, '智能屏点位非整数被拒');
  ok((await api('PUT', '/api/xiaozhi/config', { token: T, body: { helper: { url: 'javascript:x' } } })).status === 400, '非法构建机地址被拒');
  const hp = await api('PUT', '/api/xiaozhi/config', { token: T, body: { helper: { url: 'http://127.0.0.1:9' } } });
  ok(hp.status === 200 && hp.j.config.helper.url === 'http://127.0.0.1:9', '构建机地址保存回读一致');
  const cfg = await api('GET', '/api/xiaozhi/config', { token: T });
  ok(typeof cfg.j.bridge_key === 'string' && cfg.j.bridge_key.length === 32, 'admin 读配置带 32hex 桥接密钥');
  ok((await api('PUT', '/api/xiaozhi/config', { token: T, body: { bridge: { url: 'javascript:alert(1)' } } })).status === 400, '非法桥接 URL 被拒');

  console.log('— 设备别名（v1.9.16）');
  const alPut = await api('PUT', '/api/xiaozhi/device-alias', { token: T, body: { did: '123456789', alias: '客厅大灯' } });
  ok(alPut.status === 200 && alPut.j.device_aliases['123456789'] === '客厅大灯', '别名登记成功（did→别名对照）');
  const alClr = await api('PUT', '/api/xiaozhi/device-alias', { token: T, body: { did: '123456789', alias: '' } });
  ok(alClr.status === 200 && !alClr.j.device_aliases['123456789'], '空别名=解除登记');
  // v1.9.25 回归：清空别名必须真正落库——旧 saveConfig 的合并语义（{...cur, ...patch}）会把删除的键
  // 复活：响应里的对照表看着删了、读 config 又回来，正是「改为空不能保存生效」的根因
  const cfgClr = await api('GET', '/api/xiaozhi/config', { token: T });
  ok(cfgClr.status === 200 && !(cfgClr.j.config.device_aliases || {})['123456789'], '清空别名持久生效（config 不再含该 did——合并复活 bug 回归）');
  ok((await api('PUT', '/api/xiaozhi/device-alias', { token: T, body: { did: 'x!@#', alias: 'a' } })).status === 400, '非法 did 被拒');
  ok((await api('PUT', '/api/xiaozhi/device-alias', { token: T, body: { did: '123456789', alias: 'a'.repeat(33) } })).status === 400, '超长别名被拒（≤32）');
  ok((await api('PUT', '/api/xiaozhi/device-alias', { body: { did: '123456789', alias: 'a' } })).status === 401, '未登录登记别名 401');
  const dv = await api('GET', '/api/xiaozhi/devices', { token: T });
  ok(dv.status === 200 && dv.j.bound === false && Array.isArray(dv.j.devices), '设备一览优雅降级（隔离库未绑米家：bound=false 空列表不 500）');

  console.log('— 默认家庭 / 快捷开关（v1.9.17）');
  const hf = await api('PUT', '/api/xiaozhi/config', { token: T, body: { home_filter: '老家' } });
  ok(hf.status === 200 && hf.j.config.home_filter === '老家', 'home_filter 保存回读一致');
  ok((await api('PUT', '/api/xiaozhi/config', { token: T, body: { home_filter: 'x'.repeat(33) } })).status === 400, '超长家庭名被拒');
  ok((await api('POST', '/api/xiaozhi/device-control', { token: T, body: { did: 'x!', action: 'on' } })).status === 400, '快捷开关非法 did 400');
  ok((await api('POST', '/api/xiaozhi/device-control', { token: T, body: { did: '123', action: 'bright' } })).status === 400, '快捷开关非法 action 400');
  const dc = await api('POST', '/api/xiaozhi/device-control', { token: T, body: { did: '123456789', action: 'on' } });
  ok(dc.status === 200 && dc.j.ok === false, '快捷开关走 control 链（未绑米家 → 业务 JSON 优雅降级不 500）');

  console.log('— 视频对话无 IP 时的指引（v1.9.18）');
  ok((await api('POST', '/api/xiaozhi/chat', { token: T, body: { on: 1 } })).status === 503, 'chat 无板子 IP → 503 带登记指引');
  ok((await fetch(`${B}/api/xiaozhi/video?token=${T}`)).status === 503, 'video 无板子 IP → 503 带登记指引');

  console.log('— 摄像头照片（v1.9.17：上传 key 即凭证 + 相册 + poll 消费）');
  const jpg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 0x3b)]);
  const upNoKey = await fetch(`${B}/api/xiaozhi/photo`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: jpg });
  ok(upNoKey.status === 403, '无 key 上传照片 403');
  const upBad = await fetch(`${B}/api/xiaozhi/photo?k=deadbeef`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: jpg });
  ok(upBad.status === 403, '错 key 上传照片 403');
  const upOk = await fetch(`${B}/api/xiaozhi/photo?k=${cfg.j.bridge_key}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg', 'x-wb-key': cfg.j.bridge_key }, body: jpg });
  const upJ = await upOk.json();
  ok(upOk.status === 200 && upJ.ok === true && /^\d{10,14}\.jpg$/.test(upJ.file), `带 key 上传照片成功（${upJ.file}）`);
  const upJunk = await fetch(`${B}/api/xiaozhi/photo?k=${cfg.j.bridge_key}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: Buffer.from('not a jpeg at all....') });
  ok(upJunk.status === 400, '非 JPEG 数据被拒 400');
  const phList = await api('GET', '/api/xiaozhi/photos', { token: T });
  ok(phList.status === 200 && phList.j.photos.length === 1 && phList.j.photos[0].file === upJ.file, '相册列表能看到刚传的照片');
  const phImg = await fetch(`${B}/api/xiaozhi/photos/${upJ.file}?token=${T}`);
  const phBuf = Buffer.from(await phImg.arrayBuffer());
  ok(phImg.status === 200 && phBuf[0] === 0xff && phBuf[1] === 0xd8 && phBuf.length === jpg.length, '?token= 直取图片（JPEG 魔数 + 长度一致，<img> src 通道）');
  ok((await api('GET', '/api/xiaozhi/photos/..%2F..%2Fpackage.json', { token: T })).status === 404, '相册文件名白名单防穿越');
  ok((await fetch(`${B}/api/xiaozhi/photos/${upJ.file}`)).status === 401, '无登录态取图 401');
  ok((await api('DELETE', `/api/xiaozhi/photos/${upJ.file}`, { token: T })).status === 200, '管理员删照片成功');
  ok((await api('GET', '/api/xiaozhi/photos', { token: T })).j.photos.length === 0, '删除后相册为空');
  const req1 = await api('POST', '/api/xiaozhi/photo-request', { token: T });
  ok(req1.status === 200 && req1.j.ok === true, '面板请求拍照 200（置 pending）');
  const poll1 = await api('POST', `/api/xiaozhi/bridge?k=${cfg.j.bridge_key}`, { body: { op: 'poll' } });
  ok(poll1.status === 200 && poll1.j.ok === true && poll1.j.photo_requested === true, '板子轮询 poll 拿到拍照指令（pending 消费）');
  const poll2 = await api('POST', `/api/xiaozhi/bridge?k=${cfg.j.bridge_key}`, { body: { op: 'poll' } });
  ok(poll2.status === 200 && poll2.j.photo_requested === false, '再次 poll 无指令（pending 已清）');

  console.log('— poll 自报 IP（v1.9.20：生产端口转发改写 remoteAddress 恒 127.0.0.1 的根治）');
  const pollIp = await api('POST', `/api/xiaozhi/bridge?k=${cfg.j.bridge_key}`, { body: { op: 'poll', ip: '192.168.110.99' } });
  ok(pollIp.status === 200 && pollIp.j.ok === true, 'poll 带自报 ip 字段被接受');
  ok((await api('GET', '/api/xiaozhi/board', { token: T })).j.ip === '192.168.110.99', '自报 ip 优先于 remoteAddress 登记');
  await api('POST', `/api/xiaozhi/bridge?k=${cfg.j.bridge_key}`, { body: { op: 'poll', ip: 'not-an-ip' } });
  ok((await api('GET', '/api/xiaozhi/board', { token: T })).j.ip === '127.0.0.1', '非法自报 ip 回退 remoteAddress（旧固件兼容）');

  console.log('— 视频对话（v1.9.18：poll 登记 IP + 代理错误路径）');
  const bd = await api('GET', '/api/xiaozhi/board', { token: T });
  ok(bd.status === 200 && bd.j.ip === '127.0.0.1' && bd.j.online === true, 'poll 登记板子 IP + 在线判定（e2e 里即 127.0.0.1）');
  const chatBad = await api('POST', '/api/xiaozhi/chat', { token: T, body: { on: 1 } });
  ok(chatBad.status === 502 && /连不上板子/.test(chatBad.j.error || ''), 'chat 板端（127.0.0.1:81）不可达 → 502 带指引');
  ok((await fetch(`${B}/api/xiaozhi/video?token=${T}`)).status === 502, 'video 代理板端不可达 → 502');
  ok((await fetch(`${B}/api/xiaozhi/video`)).status === 401, '无登录态取视频流 401');

  console.log('— 对话记录（v1.9.19：chatlog 攒批入库 + 向上翻页）');
  const clEmpty = await api('POST', `/api/xiaozhi/bridge?k=${cfg.j.bridge_key}`, { body: { op: 'chatlog', messages: [{ role: 'user', text: '   ' }, { role: 'assistant' }] } });
  ok(clEmpty.status === 200 && clEmpty.j.ok === true && clEmpty.j.message === '', 'chatlog 空批也回 ok（空白文本全滤掉）——别让板子重试');
  const clPut = await api('POST', `/api/xiaozhi/bridge?k=${cfg.j.bridge_key}`, { body: { op: 'chatlog', messages: [
    { role: 'user', text: '小阳阳打开门口台灯', ts_ms: 1 },  // 板钟未同步（1970）→ 服务端时间兜底
    { role: 'assistant', text: '好的，已为你打开门口台灯。', ts_ms: Date.now() },
  ] } });
  ok(clPut.status === 200 && /已记录 2 条/.test(clPut.j.message || ''), 'chatlog 攒批入库成功');
  const clList = await api('GET', '/api/xiaozhi/chatlog', { token: T });
  ok(clList.status === 200 && clList.j.messages.length === 2 && clList.j.messages[0].role === 'user' && clList.j.messages[1].role === 'assistant', '对话记录按时间正序返回（左应答右指令两个角色都在）');
  ok(clList.j.messages[0].ts > 1e12, '板钟未同步的那条被兜底成服务端时间');
  const clPage = await api('GET', '/api/xiaozhi/chatlog?limit=1', { token: T });
  ok(clPage.j.messages.length === 1 && clPage.j.messages[0].role === 'assistant' && clPage.j.has_more === true, '分页 limit=1 取到最新一条 + has_more=true');
  const clOlder = await api('GET', `/api/xiaozhi/chatlog?limit=50&before_id=${clPage.j.messages[0].id}`, { token: T });
  ok(clOlder.j.messages.length === 1 && clOlder.j.messages[0].role === 'user' && clOlder.j.has_more === false, 'before_id 向上翻页取到更早一条 + has_more=false');
  ok((await fetch(`${B}/api/xiaozhi/chatlog`)).status === 401, '无登录态读对话记录 401');

  console.log('— 桥接（EXEMPT + key）');
  const noKey = await api('POST', '/api/xiaozhi/bridge', { body: { op: 'ping' } });
  ok(noKey.status === 403, '无 key 桥接 403');
  const badKey = await api('POST', '/api/xiaozhi/bridge', { body: { op: 'ping', key: 'deadbeef' } });
  ok(badKey.status === 403, '错 key 桥接 403');
  const ping = await api('POST', `/api/xiaozhi/bridge?k=${cfg.j.bridge_key}`, { body: { op: 'ping' } });
  ok(ping.status === 200 && ping.j.ok === false && /未绑定|失败|米家/.test(ping.j.message || ''), '对 key 桥接 ping 走通（隔离库未绑米家 → 业务 JSON 优雅降级：' + (ping.j.message || '').slice(0, 40) + '…）');
  const unk = await api('POST', `/api/xiaozhi/bridge?k=${cfg.j.bridge_key}`, { body: { op: 'haha' } });
  ok(unk.status === 200 && unk.j.ok === false && /未知操作/.test(unk.j.message), '未知 op 返回业务 JSON（固件侧好念）');
  ok((await api('POST', `/api/xiaozhi/bridge?k=${cfg.j.bridge_key}`, { body: { op: 'speak', text: '' } })).j.ok === false, '空 text 被业务层拒绝');
  const rot = await api('POST', '/api/xiaozhi/bridge-key/reset', { token: T });
  ok(rot.status === 200 && rot.j.bridge_key !== cfg.j.bridge_key, '密钥轮换生效');
  ok((await api('POST', `/api/xiaozhi/bridge?k=${cfg.j.bridge_key}`, { body: { op: 'ping' } })).status === 403, '旧 key 轮换后立即 403');

  console.log('— 工具与固件下载');
  const tools = await api('GET', '/api/xiaozhi/tools', { token: T });
  const drv = (tools.j.tools || []).find((t) => t.name === 'ch343-driver');
  ok(!!drv && drv.size > 500 * 1024, `CH343 驱动在列（${(drv?.size / 1024).toFixed(0)} KB）`);
  const zipR = await fetch(`${B}/api/xiaozhi/tools/ch343-driver`, { headers: { Authorization: 'Bearer ' + T } });
  const zipBuf = Buffer.from(await zipR.arrayBuffer());
  ok(zipR.status === 200 && zipBuf.subarray(0, 2).toString() === 'PK' && zipBuf.length > 500 * 1024, `驱动 zip 下载（PK 头，${(zipBuf.length / 1024).toFixed(0)} KB）`);
  const pyR = await fetch(`${B}/api/xiaozhi/tools/serial_read.py`, { headers: { Authorization: 'Bearer ' + T } });
  ok(pyR.status === 200 && (await pyR.text()).includes('import sys, time, serial'), 'serial_read.py 单文件下载');
  ok((await api('GET', '/api/xiaozhi/tools/..%2F..%2Fpackage.json', { token: T })).status === 404, '工具名白名单防路径穿越');

  console.log('— 固件下载双通道（EXEMPT + key / 管理员；v1.9.12）');
  ok((await fetch(`${B}/api/xiaozhi/firmware`)).status === 403, '无凭证下载固件 403');
  ok((await fetch(`${B}/api/xiaozhi/firmware?k=deadbeef`)).status === 403, '错 key 下载固件 403');
  const fwByKey = await fetch(`${B}/api/xiaozhi/firmware?k=${rot.j.bridge_key}`);
  if (fwByKey.status === 200) {
    const fwBuf = Buffer.from(await fwByKey.arrayBuffer());
    ok(fwBuf.length > 1024 * 1024, `本机有固件产物，key 下载 200（${(fwBuf.length / 1048576).toFixed(1)} MB；代理分支留给无固件环境）`);
  } else {
    const j = await fwByKey.json().catch(() => ({}));
    ok(fwByKey.status === 502 && /构建机/.test(j.error || ''), '本机无固件时向构建机代理（不可达 → 502 带指引）');
  }

  console.log('— tab 权限矩阵（成员）');
  await api('POST', '/api/users', { token: T, body: { username: 'm1', password: 'm1-pass-123', role: 'user', allowed_pages: ['smarthome'], allowed_tabs: { smarthome: ['mijia'] } } });
  const mlg = await api('POST', '/api/auth/login', { body: { username: 'm1', password: 'm1-pass-123' } });
  const MT = mlg.j.b?.token || mlg.j.token;
  ok((await api('GET', '/api/xiaozhi/capabilities', { token: MT })).status === 403, '成员无 xiaozhi tab → 403');
  await api('PUT', `/api/users/${(await api('GET', '/api/users', { token: T })).j.find((u) => u.username === 'm1').id}`, { token: T, body: { allowed_tabs: { smarthome: ['mijia', 'xiaozhi'] } } });
  ok((await api('GET', '/api/xiaozhi/capabilities', { token: MT })).status === 200, '授权 xiaozhi tab 后放行');
  ok((await api('GET', '/api/xiaozhi/config', { token: MT })).j.bridge_key === undefined, '成员读配置不带桥接密钥');
  ok((await api('PUT', '/api/xiaozhi/config', { token: MT, body: { channel: 'direct' } })).status === 403, '成员改配置被管理员门禁拦下');
  ok((await api('GET', '/api/xiaozhi/ports', { token: MT })).status === 403, '成员枚举串口被拦');
  ok((await fetch(`${B}/api/xiaozhi/firmware`, { headers: { Authorization: 'Bearer ' + MT } })).status === 403, '成员（非管理员）下载固件被拒（固件内含桥接密钥）');
  const upM = await fetch(`${B}/api/xiaozhi/photo?k=${rot.j.bridge_key}`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: jpg });
  const upMJ = await upM.json();
  ok((await api('DELETE', `/api/xiaozhi/photos/${upMJ.file}`, { token: MT })).status === 403, '成员删照片被拒（管理员操作）');
  ok((await api('DELETE', `/api/xiaozhi/photos/${upMJ.file}`, { token: T })).status === 200, '管理员删照片成功（轮换后新 key 仍可上传）');

  console.log('— 构建状态机（空转）');
  const st0 = await api('GET', '/api/xiaozhi/build/status', { token: MT });
  ok(st0.status === 200 && st0.j.running === false && Array.isArray(st0.j.steps) && st0.j.steps.length === 6, 'status 端点返回 6 步定义');

  // —— 真机链路（默认跳过）——
  if (process.env.E2E_XIAOZHI_BUILD === '1') {
    console.log('— 真机构建' + (process.env.E2E_XIAOZHI_FLASH === '1' ? '+烧录（COM4）' : '（不烧录）'));
    const ports = await api('GET', '/api/xiaozhi/ports', { token: T });
    const korvo = (ports.j.ports || []).find((p) => p.korvo);
    ok(!!korvo, `枚举串口发现 CH343：${korvo ? korvo.port : '（未插板？）'}`);
    if (korvo || process.env.E2E_XIAOZHI_FLASH !== '1') {
      const start = await api('POST', '/api/xiaozhi/build', { token: T, body: { flash: process.env.E2E_XIAOZHI_FLASH === '1', port: korvo ? korvo.port : 'COM4' } });
      ok(start.status === 200 && start.j.running === true, 'build 启动（异步状态机）');
      let s = { running: true };
      while (s.running) {
        await new Promise((r) => setTimeout(r, 2000));
        s = (await api('GET', '/api/xiaozhi/build/status', { token: T })).j;
        process.stdout.write(`\r  进度 ${s.progress}%（${(s.steps[s.stepIndex] || {}).label || ''}）      `);
      }
      console.log('');
      ok(s.done === true, '构建完成（' + (s.firmware.size / 1048576).toFixed(1) + ' MB）');
      if (s.failed) console.error('  失败原因：' + s.error);
      ok(s.failed !== true, '无失败');
    }
  }

  // —— 设备一览 UI（v1.9.25：默认展开 + 父设备标注）——
  // 隔离库未绑米家，/xiaozhi/devices 走路由拦截喂模拟数据（接口真实形态见上方 bound=false 降级用例）
  console.log('— 设备一览 UI（默认展开 / 父设备标注，mock 设备数据）');
  try {
    const { chromium } = await import('playwright');
    const br = await chromium.launch();
    const ctx = await br.newContext();
    await ctx.addInitScript(([t, u]) => {
      localStorage.setItem('wb_token', t);
      localStorage.setItem('wb_user', u);
      localStorage.setItem('xz_sub', 'voice'); // 直接落在「语音控米家」子 tab（设备一览所在）
    }, [T, JSON.stringify(lg.j.user)]);
    const p = await ctx.newPage();
    const perr = [];
    p.on('pageerror', (e) => perr.push(String(e).slice(0, 120)));
    await ctx.route('**/api/xiaozhi/devices**', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ bound: true, homes: ['我家'], devices: [
        { did: '111', name: '客厅灯', home: '我家', room: '客厅', online: true, sw: { siid: 2, piid: 1, v: true }, t: null, h: null, alias: null },
        { did: '222', name: '两路开关', home: '我家', room: '卧室', online: true, is_parent: true, sw: null, t: null, h: null, alias: null },
      ] }),
    }));
    await p.goto(`${B}/#/smart-home?tab=xiaozhi`);
    await p.waitForSelector('.xz-dev', { timeout: 10000 });
    ok(true, '可控设备一览默认直接展开（不点标题就有 .xz-dev 行）');
    ok((await p.locator('.xz-parent-tag').count()) === 1 && (await p.locator('.xz-parent-tag').first().innerText()) === '父设备', '父设备行渲染圆角「父设备」标签');
    const parentRow = p.locator('.xz-dev', { hasText: '两路开关' });
    ok((await parentRow.locator('.xz-toggle').count()) === 0 && (await parentRow.locator('.xz-alias').count()) === 0, '父设备行无开关按钮、无别名框');
    const lampRow = p.locator('.xz-dev', { hasText: '客厅灯' });
    ok((await lampRow.locator('.xz-toggle').count()) === 1 && (await lampRow.locator('.xz-alias').count()) === 1, '普通设备行仍有开关与别名框');
    ok(perr.length === 0, '页面无 JS 错误' + (perr.length ? '：' + perr[0] : ''));
    await br.close();
  } catch (e) {
    ok(false, '设备一览 UI 段异常：' + e.message);
  }

  // —— 语音助手 UI（v1.9.31：新子 tab 渲染 / 密钥只回布尔 / 勾选框不被全局样式撑开）——
  console.log('— 语音助手 UI（新字段读得到、密钥不回显、保存键能过校验）');
  try {
    const { chromium } = await import('playwright');
    const br = await chromium.launch();
    const ctx = await br.newContext();
    await ctx.addInitScript(([t, u]) => {
      localStorage.setItem('wb_token', t);
      localStorage.setItem('wb_user', u);
      localStorage.setItem('xz_sub', 'assistant'); // 直接落在「语音助手」子 tab
    }, [T, JSON.stringify(lg.j.user)]);
    const p = await ctx.newPage();
    const perr = [];
    p.on('pageerror', (e) => perr.push(String(e).slice(0, 120)));
    await p.goto(`${B}/#/smart-home?tab=xiaozhi`);
    await p.waitForSelector('text=🔎 语音查工作台资料', { timeout: 10000 });
    ok(true, '「语音查工作台资料」卡渲染');
    ok((await p.locator('text=🤖 转交家里 agent').count()) === 1 && (await p.locator('text=🔗 官方 MCP 接入点').count()) === 1, '「转交家里 agent」「官方 MCP 接入点」两张卡都在');
    ok((await p.locator('text=📜 转交流水').count()) === 1, '「转交流水」卡在');
    // v1.9.32：摄像头那块是子页签链尾的 v-else 兜底，语音助手曾单开成并列的 v-if → 两个页签内容一起渲染
    ok((await p.locator('text=📷 摄像头相册（板子拍照存工作台）').count()) === 0, '本页签不串出「摄像头相册」卡（v-else 兜底串页）');
    ok((await p.locator('button', { hasText: '让板子拍一张' }).count()) === 0, '也没有「让板子拍一张」按钮');
    // 密钥：GET 只回布尔，输入框必须留空 + 靠 placeholder 提示，绝不能把密钥灌进 value
    const pw = p.locator('input[type="password"]');
    ok((await pw.count()) === 2, '两个密钥框（agent 密钥 / 接入点 token）都在');
    const vals = await pw.evaluateAll((els) => els.map((e) => e.value));
    ok(vals.every((v) => v === ''), '密钥框不回显任何值（只靠 placeholder 提示）');
    // 勾选框必须保持原生小尺寸——style.css 会把非 checkbox 的 input 拉成 100% 宽，
    // 而 .xz-field input 的 min-width:170px 会把 checkbox 也撑开（这条断言就是防它回潮）
    const w = await p.locator('#xz-agent-on').boundingBox();
    ok(w && w.width < 40, `勾选框保持原生宽度（${w ? Math.round(w.width) : '?'}px，没被全局/表单样式撑开）`);
    ok((await p.locator('.xz-pill').first().innerText()).includes('未连接'), '接入点连接状态灯有内容（未配置 → 未连接）');
    // 显式保存：密钥与名字不做「敲一下就存」的自动保存，必须有个按钮；点它要能过服务端校验
    const save = p.locator('button', { hasText: '保存语音助手配置' });
    ok((await save.count()) === 1, '有显式保存按钮（密钥/名字不进防抖自动保存）');
    await save.click();
    await p.waitForSelector('.msg.ok', { timeout: 8000 });
    ok(true, '点保存 → 服务端校验全过（未填智能屏 did 也不会被无关字段拦下）');
    // 反向：切到「摄像头」页签，那块卡必须还在（别把兜底分支改没了）
    await p.locator('.xz-tabs button', { hasText: '摄像头' }).click();
    await p.waitForTimeout(400);
    ok((await p.locator('text=📷 摄像头相册（板子拍照存工作台）').count()) === 1, '切到「摄像头」页签仍然显示相册卡（没修过头）');
    ok(perr.length === 0, '页面无 JS 错误' + (perr.length ? '：' + perr[0] : ''));
    await br.close();
  } catch (e) {
    ok(false, '语音助手 UI 段异常：' + e.message);
  }

  // —— 子页签改名与排序（v1.9.33）——
  console.log('— 「语音助手」→「贾维斯J.A.R.V.I.S.」并挪到第一个（v1.9.33）');
  try {
    const { chromium } = await import('playwright');
    const br = await chromium.launch();
    const ctx = await br.newContext();
    // 故意不写 xz_sub：从没存过页签的人（新用户）必须落在第一个，也就是贾维斯
    await ctx.addInitScript(([t, u]) => {
      localStorage.setItem('wb_token', t);
      localStorage.setItem('wb_user', u);
    }, [T, JSON.stringify(lg.j.user)]);
    const p = await ctx.newPage();
    const perr = [];
    p.on('pageerror', (e) => perr.push(String(e).slice(0, 120)));
    await p.goto(`${B}/#/smart-home?tab=xiaozhi`);
    await p.waitForSelector('.xz-tabs button', { timeout: 10000 });
    const labels = await p.locator('.xz-tabs button').allTextContents();
    ok(labels[0] === '贾维斯J.A.R.V.I.S.', `第一个子页签是「贾维斯J.A.R.V.I.S.」（实际「${labels[0]}」）`);
    ok(labels.length === 6, `子页签仍是 6 个（${labels.length}）`, labels.join(' / '));
    ok(!labels.some((l) => l.includes('语音助手')), '页签行里没有旧名「语音助手」的残留');
    ok((await p.locator('text=🔎 语音查工作台资料').count()) === 1, '没存过页签时默认就落在贾维斯页（内容已在）');
    await p.locator('.xz-tabs button', { hasText: '摄像头' }).click();
    ok((await p.locator('text=🔎 语音查工作台资料').count()) === 0, '切走后贾维斯内容收起');
    await p.locator('.xz-tabs button', { hasText: '贾维斯' }).click();
    await p.waitForSelector('text=🔎 语音查工作台资料', { timeout: 5000 });
    ok(true, '点「贾维斯J.A.R.V.I.S.」页签能切回来');
    ok(perr.length === 0, '页面无 JS 错误', perr.join(' | '));
    await br.close();
  } catch (e) {
    ok(false, '改名与排序段异常：' + e.message);
  }

  // —— 语音助手两处上手修正（v1.9.32）——
  // ①「查谁的资料」是单选，而选择器组件只实现了多选显示：点中的人不出现标签/不打勾/占位不消失，看着像点不动
  console.log('— 「查谁的资料」单选要真的「选得中」（v1.9.32）');
  try {
    const { chromium } = await import('playwright');
    const br = await chromium.launch();
    const ctx = await br.newContext();
    await ctx.addInitScript(([t, u]) => {
      localStorage.setItem('wb_token', t);
      localStorage.setItem('wb_user', u);
      // 刷新页面直接落在这个子 tab（localStorage 里的 xz_sub）：成员列表必须自己加载，
      // 此前只有「点页签切过来」才 loadUsers，刷新进来是空列表 → 点开写「无匹配用户」
      localStorage.setItem('xz_sub', 'assistant');
    }, [T, JSON.stringify(lg.j.user)]);
    const p = await ctx.newPage();
    const perr = [];
    p.on('pageerror', (e) => perr.push(String(e).slice(0, 120)));
    await p.goto(`${B}/#/smart-home?tab=xiaozhi`);
    await p.waitForSelector('text=🔎 语音查工作台资料', { timeout: 10000 });
    await p.locator('.up-box').first().click();
    await p.waitForSelector('.up-item', { timeout: 8000 });
    const items = await p.locator('.up-item').count();
    ok(items > 0, `刷新后直接落在本页签也有成员可选（此前空列表）items=${items}`);
    const firstRow = (await p.locator('.up-item').first().innerText()).trim();
    await p.locator('.up-item').first().click();
    await p.waitForTimeout(300);
    const chips = p.locator('.up-chip');
    ok((await chips.count()) === 1, '单选点中成员后出现选中标签（此前单选恒无标签）');
    const chipTxt = (await chips.first().innerText()).replace('✕', '').trim();
    ok(!!chipTxt && firstRow.includes(chipTxt), `标签上写的就是点中的那个人（${chipTxt}）`);
    ok((await p.locator('.up-input').first().getAttribute('placeholder')) === '', '选中后占位提示让位（不再同时显示「选一个成员…」）');
    await p.locator('.up-box').first().click();   // 再点开：已选行必须打勾
    await p.waitForSelector('.up-item', { timeout: 8000 });
    ok((await p.locator('.up-item.on').count()) === 1 && (await p.locator('.up-check.on').count()) === 1,
      '下拉里已选行打勾（.up-item.on + .up-check.on）');
    await p.locator('h3').first().click();        // 点卡片标题关下拉（收起走 document click）
    await p.waitForTimeout(200);
    await p.locator('.up-x').first().click();     // 单选也要能反悔
    await p.waitForTimeout(250);
    ok((await p.locator('.up-chip').count()) === 0, '标签上的 ✕ 能清空（单选也能反悔）');
    // 选一个再存盘：界面上看得见的东西必须跟库里一致
    await p.locator('.up-box').first().click();
    await p.waitForSelector('.up-item', { timeout: 8000 });
    await p.locator('.up-item').first().click();
    await p.waitForTimeout(200);
    await p.locator('button', { hasText: '保存语音助手配置' }).click();
    await p.waitForSelector('.msg.ok', { timeout: 8000 });
    await p.waitForTimeout(1200); // 保存后会自己回读一次接入点状态，别把这当成「页面在闪」
    const cfgNow = await api('GET', '/api/xiaozhi/config', { token: T });
    ok(cfgNow.j.config.query.uid > 0, `面板选中的成员真进了库（query.uid=${cfgNow.j.config.query.uid}）`);
    await p.reload();                             // 刷新回显：值在库里还不够，界面得看得见
    await p.waitForSelector('text=🔎 语音查工作台资料', { timeout: 10000 });
    await p.waitForSelector('.up-chip', { timeout: 8000 });
    ok((await p.locator('.up-chip').count()) === 1, '刷新页面后已选成员回显成标签');
    ok(perr.length === 0, '页面无 JS 错误' + (perr.length ? '：' + perr[0] : ''));
    await br.close();
  } catch (e) {
    ok(false, '单选取人 UI 段异常：' + e.message);
  }

  // ② 接入点是异步连的：保存那一刻必然还没握手完。面板必须自己回来问，否则连上了也一直显示「未连接」
  console.log('— 接入点状态灯自己刷新（v1.9.32：不再一直挂「未连接」）');
  try {
    const { chromium } = await import('playwright');
    const br = await chromium.launch();
    // A) 连上的情形：进页面时未连接，保存后桥接握手完成 → 面板轮询到「已连接」
    {
      const ctx = await br.newContext();
      await ctx.addInitScript(([t, u]) => {
        localStorage.setItem('wb_token', t); localStorage.setItem('wb_user', u);
        localStorage.setItem('xz_sub', 'assistant');
      }, [T, JSON.stringify(lg.j.user)]);
      let handshook = false;   // 模拟桥接：保存（PUT）之后才握手完成
      // 只劫持 GET，PUT 走真服务端（真实语义：保存那一刻它回的 connected 一定是 false）
      await ctx.route('**/api/xiaozhi/config**', async (route) => {
        const m = route.request().method();
        if (m !== 'GET') { if (m === 'PUT') handshook = true; return route.continue(); }
        const resp = await route.fetch();
        const j = await resp.json();
        j.config.mcp = { enabled: true, url: 'wss://api.xiaozhi.me/mcp/', token_set: true, connected: handshook, since: handshook ? Date.now() : 0 };
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(j) });
      });
      const p = await ctx.newPage();
      const perr = [];
      p.on('pageerror', (e) => perr.push(String(e).slice(0, 120)));
      await p.goto(`${B}/#/smart-home?tab=xiaozhi`);
      await p.waitForSelector('text=🔗 官方 MCP 接入点', { timeout: 10000 });
      await p.waitForTimeout(700);
      ok((await p.locator('.xz-pill').first().innerText()).includes('未连接'), '进页面时是「未连接」（还没连上）');
      await p.locator('button', { hasText: '保存语音助手配置' }).click();
      await p.waitForSelector('.msg.ok', { timeout: 8000 });
      await p.waitForSelector('.xz-pill.ok', { timeout: 10000 });   // 此前这里永远等不到：界面再也不刷
      ok((await p.locator('.xz-pill').first().innerText()).includes('已连接'), '保存后状态灯自己刷成「已连接」（此前一直挂「未连接」）');
      ok((await p.locator('text=掉线会自动重连').count()) === 1, '连上后补一句连接时间 +「掉线会自动重连」');
      ok(perr.length === 0, '页面无 JS 错误' + (perr.length ? '：' + perr[0] : ''));
      await ctx.close();
    }
    // B) 连不上的情形：要给原因，而不是只抛一个「未连接」让人猜
    {
      const ctx = await br.newContext();
      await ctx.addInitScript(([t, u]) => {
        localStorage.setItem('wb_token', t); localStorage.setItem('wb_user', u);
        localStorage.setItem('xz_sub', 'assistant');
      }, [T, JSON.stringify(lg.j.user)]);
      await ctx.route('**/api/xiaozhi/config**', async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        const resp = await route.fetch();
        const j = await resp.json();
        j.config.mcp = { enabled: true, url: 'wss://api.xiaozhi.me/mcp/', token_set: true, connected: false, since: 0, last_error: 'connect ECONNREFUSED 127.0.0.1:1' };
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(j) });
      });
      const p = await ctx.newPage();
      const perr = [];
      p.on('pageerror', (e) => perr.push(String(e).slice(0, 120)));
      await p.goto(`${B}/#/smart-home?tab=xiaozhi`);
      await p.waitForSelector('text=🔗 官方 MCP 接入点', { timeout: 10000 });
      await p.waitForTimeout(500);
      await p.locator('button', { hasText: '刷新状态' }).click();
      await p.waitForTimeout(600);
      ok((await p.locator('.xz-pill').first().innerText()).includes('连接中'), '复查期间显示「连接中…」（不干等着也不误报未连接）');
      await p.waitForSelector('.xz-err:has-text("ECONNREFUSED")', { timeout: 25000 });
      ok(true, '连不上时直接写出失败原因（管理员可见；非管理员拿不到这个字段）');
      ok(perr.length === 0, '页面无 JS 错误' + (perr.length ? '：' + perr[0] : ''));
      await ctx.close();
    }
    await br.close();
  } catch (e) {
    ok(false, '接入点状态灯 UI 段异常：' + e.message);
  }

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exitCode = failed ? 1 : 0;
} catch (e) {
  console.error('e2e 异常：', e.message);
  process.exitCode = 1;
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 800));
  try { rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows 句柄延迟，残留无害 */ }
}
