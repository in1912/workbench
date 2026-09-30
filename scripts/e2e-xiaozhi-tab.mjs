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
