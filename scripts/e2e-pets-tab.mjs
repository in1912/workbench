// E2E：宠物页「我的宠物」tab 勾选保存后回读（v1.2.5 修复验证）
// 根因：TAB_DEFS.pets 含 'pets' 主 tab，但 TAB_PATHS.pets 缺该键 → sanitizeTabs 保存时剥掉
// 修复：TAB_PATHS.pets 首条 ['pets', []]（空前缀=仅作授权勾选项，不绑路径）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'tmp-pets-tab-e2e');
const PORT = 3999;
const B = `http://127.0.0.1:${PORT}`;

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
  const HA = { 'Content-Type': 'application/json' };
  let r = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: HA, body: JSON.stringify({ username: 'admin', password: 'test123456' }) });
  const lj = await r.json();
  ck('管理员登录', r.status === 200 && !!lj.token);
  const A = { ...HA, Authorization: 'Bearer ' + lj.token };

  // 建用户：勾选 pets 页 + 'pets'/'checkin' 两个 tab
  r = await fetch(`${B}/api/users`, { method: 'POST', headers: A, body: JSON.stringify({
    username: 'kid1', password: 'test123456', role: 'user',
    allowed_pages: ['pets'],
    allowed_tabs: { pets: ['pets', 'checkin'] },
  }) });
  const pj = await r.json();
  ck('建用户 200', r.status === 200, JSON.stringify(pj));
  const uid = pj.id;

  // 回读：allowed_tabs.pets 必须保留（修复前会被 sanitizeTabs 剥成空对象）
  r = await fetch(`${B}/api/users`, { headers: A });
  const users = await r.json();
  const u = (Array.isArray(users) ? users : users.users || []).find((x) => x.id === uid);
  const tabs = u?.allowed_tabs || {};
  ck('回读 allowed_tabs.pets 含 pets 键', Array.isArray(tabs.pets) && tabs.pets.includes('pets'), JSON.stringify(tabs));
  ck('回读 allowed_tabs.pets 含 checkin', Array.isArray(tabs.pets) && tabs.pets.includes('checkin'), JSON.stringify(tabs));

  // PUT 再保存一轮：键不丢
  r = await fetch(`${B}/api/users/${uid}`, { method: 'PUT', headers: A, body: JSON.stringify({
    allowed_pages: ['pets'],
    allowed_tabs: { pets: ['pets', 'adopt', 'checkin', 'records', 'settings', 'assign'] },
  }) });
  ck('PUT 保存 200', r.status === 200);
  r = await fetch(`${B}/api/users`, { headers: A });
  const u2 = (await r.json()).find?.((x) => x.id === uid);
  ck('二轮保存后 6 tab 全保留', Array.isArray(u2?.allowed_tabs?.pets) && u2.allowed_tabs.pets.length === 6, JSON.stringify(u2?.allowed_tabs));

  // API 权限行为（此时 kid1 已含全部 tab）：/pets/checkins 200
  const tk = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: HA, body: JSON.stringify({ username: 'kid1', password: 'test123456' }) })).json();
  const K = { ...HA, Authorization: 'Bearer ' + tk.token };
  r = await fetch(`${B}/api/pets/checkins`, { headers: K });
  ck('勾 checkin 后 /pets/checkins 可达', r.status === 200, String(r.status));
  // 改成只勾 'pets' 主 tab（不绑路径）→ 共享端点 /pets/state 仍可达、checkin 403
  r = await fetch(`${B}/api/users/${uid}`, { method: 'PUT', headers: A, body: JSON.stringify({
    allowed_pages: ['pets'], allowed_tabs: { pets: ['pets'] },
  }) });
  ck('改只勾主 tab PUT 200', r.status === 200);
  r = await fetch(`${B}/api/pets/checkins`, { headers: K });
  ck('只剩主 tab → /pets/checkins 403', r.status === 403, String(r.status));
  r = await fetch(`${B}/api/pets/state`, { headers: K });
  ck('主 tab（空路径）→ /pets/state 可达', r.status === 200, String(r.status));
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
