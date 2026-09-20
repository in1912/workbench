// E2E：桌面宠物（v1.3.8，Windows 桌面常驻小窗）
// A 配置（开关/密钥生成/宠物选择校验/variant+rings 透出）
// B key 凭证（免登录 state；坏 key 403；关闭开关后失效）
// C 形象帧（dataURL 上传→文件落盘/ver 变化/帧下发字节一致）
// D 桌面互动（喂饭/喂水/玩耍走冷却与每日上限；未知动作）
// E 安装包（ps1 带 UTF-8 BOM + CRLF + 内嵌服务器地址与 key；两个 bat）
// F 无宠物用户（state → pet:null）
// 用法：node scripts/e2e-desktop-pet.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data', 'tmp-deskpet-e2e'); // 子目录（勿放 data/ 根）
const PORT = 3997, B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  <<< ' + extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = { 'Content-Type': 'application/json' };

// 两张不同的 1x1 PNG（第二张尾部多一字节），充当前端渲染出的桌面帧——服务端只校验
// dataURL 形态并按字节落盘/回发，字节一致性按我们送进去的原样比对
const MAGENTA_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const CYAN_PNG = Buffer.concat([MAGENTA_PNG, Buffer.from([0x00])]);
const PNG_URL = (buf) => 'data:image/png;base64,' + buf.toString('base64');

fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(DATA, { recursive: true });
const srv = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456', TTS_ROOT: path.join(DATA, 'no-tts') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', (d) => console.error('[srv-err]', String(d).slice(0, 300)));
{
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`${B}/api/health`); if (r.ok) break; } catch { /* 未就绪 */ }
    if (Date.now() - t0 > 30000) { console.error('服务 30s 未就绪'); srv.kill(); process.exit(1); }
    await sleep(400);
  }
}

try {
  // ---------- 登录 ----------
  let r = await fetch(`${B}/api/auth/login`, { method: 'POST', headers: J, body: JSON.stringify({ username: 'admin', password: 'test123456' }) });
  const lj = await r.json();
  ck('管理员登录', r.status === 200 && !!lj.token);
  const A = { ...J, Authorization: 'Bearer ' + lj.token };
  await fetch(`${B}/api/users`, { method: 'POST', headers: A, body: JSON.stringify({ username: 'u2', password: 'u234567', display_name: '无宠用户' }) });
  const l2 = await (await fetch(`${B}/api/auth/login`, { method: 'POST', headers: J, body: JSON.stringify({ username: 'u2', password: 'u234567' }) })).json();
  const H2 = { ...J, Authorization: 'Bearer ' + l2.token };

  // 建一只像素宠物（dog，非 GIF → 桌面端走 PNG 帧链路）
  r = await fetch(`${B}/api/pets`, { method: 'POST', headers: A, body: JSON.stringify({ name: '桌宠小狗', species: 'dog', variant: 1, raise_mode: 'shared' }) });
  const pet = await r.json();
  ck('前置：创建像素宠物', r.status === 200 && pet.id > 0, JSON.stringify(pet));

  // ========== A 配置 ==========
  console.log('\n== A 桌面宠物配置 ==');
  let dc = await (await fetch(`${B}/api/pets/desktop-config`, { headers: A })).json();
  ck('A1 默认关闭且无密钥', dc.enabled === false && !dc.key, JSON.stringify({ enabled: dc.enabled, key: dc.key }));
  ck('A2 宠物清单（species/variant/has_gif/rings）', dc.pets.length === 1 && dc.pets[0].species === 'dog' && dc.pets[0].variant === 1 && dc.pets[0].has_gif === false && dc.pets[0].rings === 0, JSON.stringify(dc.pets));

  r = await fetch(`${B}/api/pets/desktop-config`, { method: 'PUT', headers: A, body: JSON.stringify({ enabled: 1, pet_id: pet.id }) });
  dc = await r.json();
  ck('A3 开启后生成 32hex 个人密钥', r.status === 200 && dc.enabled === true && /^[0-9a-f]{32}$/.test(dc.key || ''), JSON.stringify(dc));
  const KEY = dc.key;
  ck('A4 密钥稳定（再读不变）', ((await (await fetch(`${B}/api/pets/desktop-config`, { headers: A })).json()).key) === KEY);

  r = await fetch(`${B}/api/pets/desktop-config`, { method: 'PUT', headers: H2, body: JSON.stringify({ enabled: 1, pet_id: pet.id }) });
  ck('A5 他人无权选择该宠物 400（个人/无成员）', r.status === 400, String(r.status));
  // u2 无宠物：开启后 state 走 pet:null 分支（F 段再验）

  // ========== B key 凭证 ==========
  console.log('\n== B key 免登录凭证 ==');
  r = await fetch(`${B}/api/pets/desktop/state?key=WRONGKEY`.toLowerCase() + '0'.repeat(26));
  ck('B1 坏 key 403', r.status === 403, String(r.status));
  r = await fetch(`${B}/api/pets/desktop/state?key=${KEY}`);
  let st = await r.json();
  ck('B2 免登录取 state（无 Authorization 头）', r.status === 200 && st.pet && st.pet.id === pet.id, JSON.stringify(st).slice(0, 160));
  ck('B3 state 透出宠物名与帧未生成', st.pet.name === '桌宠小狗' && st.pet.frames === 0 && st.pet.ver === 0, JSON.stringify(st.pet));

  // ========== C 形象帧 ==========
  console.log('\n== C 形象帧上传与下发 ==');
  r = await fetch(`${B}/api/pets/desktop-frames`, { method: 'POST', headers: A, body: JSON.stringify({ pet_id: pet.id, frames: ['data:image/jpeg;base64,AAAA', PNG_URL(MAGENTA_PNG)] }) });
  ck('C1 非 PNG dataURL 拒绝 400', r.status === 400, String(r.status));
  r = await fetch(`${B}/api/pets/desktop-frames`, { method: 'POST', headers: A, body: JSON.stringify({ pet_id: pet.id, frames: [PNG_URL(MAGENTA_PNG), PNG_URL(CYAN_PNG)] }) });
  let up = await r.json();
  ck('C2 上传 2 帧成功且 ver>0', r.status === 200 && up.ok === true && up.frames === 2 && up.ver > 0, JSON.stringify(up));
  const ver1 = up.ver;

  r = await fetch(`${B}/api/pets/desktop/frame?key=${KEY}&pet=${pet.id}&i=0`);
  const b0 = Buffer.from(await r.arrayBuffer());
  ck('C3 帧文件下发（f0 字节一致）', r.status === 200 && b0.equals(MAGENTA_PNG), `${r.status} len=${b0.length}`);
  r = await fetch(`${B}/api/pets/desktop/frame?key=${KEY}&pet=${pet.id}&i=1`);
  ck('C4 帧文件下发（f1 字节一致）', r.status === 200 && Buffer.from(await r.arrayBuffer()).equals(CYAN_PNG));
  r = await fetch(`${B}/api/pets/desktop/frame?key=${KEY}&pet=${pet.id}&i=9`);
  ck('C5 帧号越界 400', r.status === 400, String(r.status));
  r = await fetch(`${B}/api/pets/desktop/frame?key=${KEY}&pet=${pet.id}&i=gif`);
  ck('C6 非 GIF 宠物 i=gif → 404', r.status === 404, String(r.status));

  st = await (await fetch(`${B}/api/pets/desktop/state?key=${KEY}`)).json();
  ck('C7 state 反映 frames=2 / ver', st.pet.frames === 2 && st.pet.ver === ver1, JSON.stringify(st.pet));

  await sleep(1100); // ver 取 f0 mtime 秒数：隔 1 秒重传才会变
  r = await fetch(`${B}/api/pets/desktop-frames`, { method: 'POST', headers: A, body: JSON.stringify({ pet_id: pet.id, frames: [PNG_URL(CYAN_PNG)] }) });
  up = await r.json();
  st = await (await fetch(`${B}/api/pets/desktop/state?key=${KEY}`)).json();
  ck('C8 重传换形象：ver 递增 + 旧帧清空（1 帧）', up.ver > ver1 && st.pet.frames === 1 && st.pet.ver === up.ver, `${ver1} -> ${up.ver}, frames=${st.pet.frames}`);

  // ========== D 桌面互动 ==========
  console.log('\n== D 桌面互动（喂饭/喂水/玩耍） ==');
  const act = (kind) => fetch(`${B}/api/pets/desktop/action?key=${KEY}`, { method: 'POST', headers: J, body: JSON.stringify({ pet: pet.id, action: kind }) });
  r = await act('food');
  ck('D1 喂饭成功', r.status === 200 && (await r.json()).ok === true);
  r = await act('food');
  let e = await r.json();
  ck('D2 喂饭冷却拦截 400', r.status === 400 && /等一会儿|吃饱/.test(e.error || ''), JSON.stringify(e));
  r = await act('water');
  ck('D3 喂水成功', r.status === 200 && (await r.json()).ok === true);
  r = await act('play');
  ck('D4 玩耍成功', r.status === 200 && (await r.json()).ok === true);
  r = await act('dance');
  ck('D5 未知动作 400', r.status === 400 && /未知动作/.test((await r.json()).error || ''), String(r.status));
  // 冷却结束后的状态字段：state 透出 cooldowns（food 已在冷却 → >0）
  st = await (await fetch(`${B}/api/pets/desktop/state?key=${KEY}`)).json();
  ck('D6 state 透出喂食冷却剩余', st.cooldowns && st.cooldowns.food > 0, JSON.stringify(st.cooldowns));

  // ========== E 安装包 ==========
  console.log('\n== E 安装包下发 ==');
  r = await fetch(`${B}/api/pets/agent-files?type=petsetup`, { headers: A });
  const psBuf = Buffer.from(await r.arrayBuffer());
  const ps = psBuf.toString('utf8');
  ck('E1 ps1 带 UTF-8 BOM（PS5.1 中文）', psBuf[0] === 0xef && psBuf[1] === 0xbb && psBuf[2] === 0xbf, `${psBuf[0]},${psBuf[1]},${psBuf[2]}`);
  ck('E2 ps1 内嵌服务器地址', ps.includes(`$Server = '${B}'`), (ps.match(/\$Server = '[^']*'/) || [''])[0]);
  ck('E3 ps1 内嵌个人密钥', ps.includes(`$DeskKey = '${KEY}'`));
  ck('E4 ps1 CRLF 行尾', psBuf.includes(Buffer.from('\r\n')) && !/(?<!\r)\n/.test(ps), '存在裸 LF');
  ck('E5 ps1 含颜色键透明与单实例锁', ps.includes('TransparencyKey') && ps.includes('WorkbenchDesktopPet'));
  r = await fetch(`${B}/api/pets/agent-files?type=petsetup`, { headers: H2 });
  ck('E6 未开启用户下载 ps1 400（无 key）', r.status === 400, String(r.status));
  r = await fetch(`${B}/api/pets/agent-files?type=petinstall`, { headers: A });
  const bat = (await r.text());
  ck('E7 install bat 调 ps1', r.status === 200 && bat.includes('desktop-pet-setup.ps1') && bat.includes('\r\n'), bat.slice(0, 80));
  r = await fetch(`${B}/api/pets/agent-files?type=petuninstall`, { headers: A });
  ck('E8 uninstall bat 带 -Remove', (await r.text()).includes('-Remove'));
  r = await fetch(`${B}/api/pets/agent-files?type=petnope`, { headers: A });
  ck('E9 未知类型 400', r.status === 400, String(r.status));

  // ========== F 开关与无宠物 ==========
  console.log('\n== F 开关关闭 / 无宠物 ==');
  await fetch(`${B}/api/pets/desktop-config`, { method: 'PUT', headers: H2, body: JSON.stringify({ enabled: 1 }) });
  const dc2 = await (await fetch(`${B}/api/pets/desktop-config`, { headers: H2 })).json();
  r = await fetch(`${B}/api/pets/desktop/state?key=${dc2.key}`);
  const st2 = await r.json();
  ck('F1 无宠物用户 state → pet:null', r.status === 200 && st2.pet === null, JSON.stringify(st2).slice(0, 100));
  await fetch(`${B}/api/pets/desktop-config`, { method: 'PUT', headers: A, body: JSON.stringify({ enabled: 0 }) });
  r = await fetch(`${B}/api/pets/desktop/state?key=${KEY}`);
  ck('F2 关闭开关后旧 key 失效 403', r.status === 403, String(r.status));
} catch (e) {
  fail++;
  console.error('  ✗ 异常:', e);
} finally {
  srv.kill();
  await sleep(800);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* Windows 句柄延迟 */ }
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
