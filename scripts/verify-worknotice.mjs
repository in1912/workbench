// 验证图片通道切换到「工作通知」：配置读写含 agent_id、test-image 在缺 AgentId 时给出指引（不外发）
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const db = new DatabaseSync('data/workbench.sqlite');
const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const token = crypto.randomBytes(32).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+5 minutes'))").run(token, admin.id);
const H = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
const B = 'http://localhost:3000/api';

try {
  // 1) GET config 应含 agent_id 字段（当前应为空）
  const cfg = await (await fetch(B + '/dingtalk/config', { headers: H })).json();
  console.log('[1] GET config agent_id =', JSON.stringify(cfg.agent_id), '| app_key =', cfg.app_key, '| userid =', cfg.userid);
  if (!('agent_id' in cfg)) throw new Error('GET config 缺 agent_id 字段');

  // 2) POST config 显式传 agent_id=''（当前本就为空，等于无操作保存，验证回显合并不丢字段）
  await fetch(B + '/dingtalk/config', { method: 'POST', headers: H, body: JSON.stringify({ agent_id: '' }) });
  const cfg2 = await (await fetch(B + '/dingtalk/config', { headers: H })).json();
  console.log('[2] 空值保存后 app_key/userid/enabled 保持 =', cfg2.app_key, cfg2.userid, cfg2.enabled);
  if (cfg2.app_key !== cfg.app_key || cfg2.userid !== cfg.userid || cfg2.enabled !== cfg.enabled) throw new Error('部分保存丢了字段！');

  // 3) test-image：未配置 AgentId → 400 + 指引（不应外发）
  const r3 = await fetch(B + '/dingtalk/test-image', { method: 'POST', headers: H });
  const j3 = await r3.json();
  console.log('[3] test-image 无 AgentId →', r3.status, JSON.stringify(j3.error).slice(0, 90));
  if (r3.status !== 400 || !/AgentId/.test(j3.error || '')) throw new Error('test-image 未给出 AgentId 指引');

  console.log('ALL-OK');
} finally {
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
}
