// 路由层验证：POST /api/business/skills/:id/run 必须如实回报飞书发送结果。
// 起因（v1.9.37）：「工作台显示通了，但飞书没反应」——runSkill 把飞书失败吞成 console.warn、
//   纯文字 Skill 更是根本不发，路由却恒回 {ok:true}，前端于是恒闪「执行完成，去飞书查看」。
// 本脚本起真服务、走真 HTTP：造一个纯文字 Skill（没配飞书会话）执行，断言响应里
//   result 是字符串、feishu 必须存在且带上「没配置飞书推送会话」的可操作原因。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-skillroute-'));
const PORT = 3997;
const B = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  <<< ' + extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = spawn(process.execPath, ['--no-warnings', 'server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', () => {});
srv.stderr.on('data', () => {});
await sleep(3000);

try {
  const lj = await (await fetch(`${B}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test123456' }),
  })).json();
  const H = { Authorization: 'Bearer ' + lj.token, 'Content-Type': 'application/json' };

  const sysRes = await (await fetch(`${B}/api/business`, {
    method: 'POST', headers: H, body: JSON.stringify({ name: '测试系统', url: '', type: 'web' }),
  })).json();
  ck('建业务系统', !!sysRes.id, JSON.stringify(sysRes));

  // 纯文字 Skill：只填引导词 + 本地整理（不依赖 AI），没有 browser_recipe
  const skRes = await (await fetch(`${B}/api/business/skills`, {
    method: 'POST', headers: H,
    body: JSON.stringify({ system_id: sysRes.id, name: '上线通知', prompt: '贾维斯已上线，这条消息是测试，收到请回复', enabled: 1, local_format: 1 }),
  })).json();
  ck('建纯文字 Skill', !!skRes.id, JSON.stringify(skRes));

  const run = await fetch(`${B}/api/business/skills/${skRes.id}/run`, { method: 'POST', headers: H });
  const j = await run.json();
  ck('执行返回 HTTP 200', run.status === 200, 'HTTP ' + run.status);
  ck('result 仍是字符串（老调用方不受影响）', typeof j.result === 'string' && j.result.includes('本地整理'), typeof j.result);
  ck('响应里带 feishu 结果（修复前完全没有这个字段）', !!j.feishu, JSON.stringify(j));
  ck('sent=0', j.feishu && j.feishu.sent === 0, JSON.stringify(j.feishu));
  ck('原因是可操作的中文提示，而不是静默成功', /没配置飞书推送会话/.test((j.feishu && j.feishu.error) || ''), JSON.stringify(j.feishu));
} catch (e) {
  fail++;
  console.error('  ✗ 脚本异常:', e.message);
} finally {
  srv.kill();
  await sleep(500);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 2 : 0);
