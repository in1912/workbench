// e2e-gate-runtime.mjs —— 第4项运行时门禁冒烟：已加载的 H5 在管理员关闭开关后 15s 内锁定
// 前置：本机 3000 已跑新代码；跑完自动恢复 dep 开关为开。
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:3000';
const login = await fetch(BASE + '/api/auth/login', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'admin123' }),
}).then((r) => r.json());
const H = { Authorization: 'Bearer ' + login.token, 'Content-Type': 'application/json' };
const putCfg = (body) => fetch(BASE + '/api/dep/config', { method: 'PUT', headers: H, body: JSON.stringify(body) }).then((r) => r.json());

await putCfg({ enabled: true }); // 起点：开
const b = await chromium.launch();
const pg = await b.newPage();
await pg.goto(BASE + '/dep/index.html', { waitUntil: 'domcontentloaded' });
await pg.waitForTimeout(1200);
console.log('[1] H5 打开（开关=开），gate 锁存在?', await pg.locator('#wb_gate_lock').count());

await putCfg({ enabled: false });
console.log('[2] 管理员关闭对外开关 → 等待运行时锁定（≤15s + 余量）…');
const t0 = Date.now();
await pg.waitForSelector('#wb_gate_lock', { timeout: 22000 });
console.log('[3] ✅ 已锁定，耗时', ((Date.now() - t0) / 1000).toFixed(1) + 's');

const fresh = await b.newPage();
const resp = await fresh.goto(BASE + '/dep/index.html').catch((e) => null);
console.log('[4] 关闭后新开页面 HTTP 状态 =', resp ? resp.status() : 'ERR（403=正常）');

await putCfg({ enabled: true }); // 恢复
await pg.waitForTimeout(1800);
console.log('[5] 重新开启后刷新页面，gate 锁存在?', await pg.locator('#wb_gate_lock').count(), '（0=正常，锁不自动解除，刷新即恢复）');
await b.close();
const cfg = await fetch(BASE + '/api/dep/config', { headers: H }).then((r) => r.json());
console.log('[6] 收尾：dep enabled =', cfg.enabled, '（true=已恢复）');
