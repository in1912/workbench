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

  console.log('— 视频对话（v1.9.18：poll 登记 IP + 代理错误路径）');
  const bd = await api('GET', '/api/xiaozhi/board', { token: T });
  ok(bd.status === 200 && bd.j.ip === '127.0.0.1' && bd.j.online === true, 'poll 登记板子 IP + 在线判定（e2e 里即 127.0.0.1）');
  const chatBad = await api('POST', '/api/xiaozhi/chat', { token: T, body: { on: 1 } });
  ok(chatBad.status === 502 && /连不上板子/.test(chatBad.j.error || ''), 'chat 板端（127.0.0.1:81）不可达 → 502 带指引');
  ok((await fetch(`${B}/api/xiaozhi/video?token=${T}`)).status === 502, 'video 代理板端不可达 → 502');
  ok((await fetch(`${B}/api/xiaozhi/video`)).status === 401, '无登录态取视频流 401');

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
