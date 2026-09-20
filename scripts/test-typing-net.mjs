// 打字有效字数口径验证：临时用户上报已知 correct/wrong，校验 records/summary/payouts preview 的 net 与金额
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const db = new DatabaseSync('data/workbench.sqlite');
db.prepare("INSERT OR IGNORE INTO users(username,password_hash,role,allowed_pages,allowed_tabs,is_bot) VALUES('typing_net_e2e','','user','[]','{}',0)").run();
const uid = db.prepare("SELECT id FROM users WHERE username='typing_net_e2e'").get().id;
const token = crypto.randomBytes(32).toString('hex');
db.prepare(`INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,'2030-01-01 00:00:00')`).run(token, uid);
const H = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
const j = (r) => r.json();

try {
  // 上报两批：200对50错（净 50）、300对10错（净 270）→ 当日合计 500对60错，净 320
  await fetch('http://localhost:3000/api/typing/progress', { method: 'POST', headers: H, body: JSON.stringify({ seconds: 60, correct: 200, wrong: 50 }) }).then(j);
  await fetch('http://localhost:3000/api/typing/progress', { method: 'POST', headers: H, body: JSON.stringify({ seconds: 30, correct: 300, wrong: 10 }) }).then(j);

  const rec = await fetch('http://localhost:3000/api/typing/records', { headers: H }).then(j);
  const sum = await fetch('http://localhost:3000/api/typing/summary', { headers: H }).then(j);
  // preview 是受限 tab 接口：临时借用管理员会话（同 test-typed-api.mjs 的直插 sessions 模式）
  const adminId = db.prepare("SELECT id FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get().id;
  const aToken = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+5 minutes'))").run(aToken, adminId);
  let prev = {};
  try { prev = await fetch('http://localhost:3000/api/typing/payouts/preview?user_id=' + uid, { headers: { Authorization: 'Bearer ' + aToken } }).then(j); }
  finally { db.prepare('DELETE FROM sessions WHERE token=?').run(aToken); }

  const cfg = sum.config; // 费率从 summary 自带 config 取（/typing/config 是受限 tab 接口，普通用户 403）
  const rates = cfg.reward_yuan / cfg.reward_chars;
  const net = 500 - 3 * 60;
  const money = Math.round(net * rates * 100) / 100;
  const day = rec.days[0];
  const out = [];
  out.push(['config 带 wrong_penalty', cfg.wrong_penalty === 3]);
  out.push(['records 日行 net', day.net === net, `(${day.correct}对${day.wrong}错→${day.net})`]);
  out.push(['records 汇总 net', rec.totals.net === net]);
  out.push(['summary 日 money', sum.days[0].money === money, `(¥${sum.days[0].money})`]);
  out.push(['summary 汇总 net/money', sum.totals.net === net && sum.totals.money === money]);
  out.push(['summary 待兑现(无兑现记录)', sum.totals.pending === money]);
  out.push(['preview net/earned', prev.net === net && prev.earned === money]);

  // 负数场景：另一天直接插库 30对20错 → 净 -30，验证单日负金额与月内相抵
  db.prepare("INSERT INTO typing_days(user_id,day,seconds,correct,wrong,updated_at) VALUES(?,?,10,30,20,datetime('now','localtime'))")
    .run(uid, new Date(Date.now() - 86400000).toLocaleDateString('sv'));
  const sum2 = await fetch('http://localhost:3000/api/typing/summary', { headers: H }).then(j);
  const net2 = net + (30 - 60);
  const money2 = Math.round(net2 * rates * 100) / 100;
  const negDay = sum2.days.find((d) => d.correct === 30);
  out.push(['负数日 money', negDay.money === Math.round(-30 * rates * 100) / 100, `(¥${negDay.money})`]);
  out.push(['月内正负相抵 net', sum2.totals.net === net2, `(${sum2.totals.net})`]);
  out.push(['月合计 money', sum2.totals.money === money2, `(¥${sum2.totals.money})`]);

  let fail = 0;
  for (const [name, ok, extra] of out) { console.log((ok ? '✓' : '✗ FAIL'), name, extra || ''); if (!ok) fail++; }
  console.log(fail ? `失败 ${fail} 项` : '全部通过');
  process.exitCode = fail ? 1 : 0;
} finally {
  db.prepare('DELETE FROM typing_days WHERE user_id=?').run(uid);
  db.prepare('DELETE FROM sessions WHERE token=?').run(token);
  db.prepare('DELETE FROM users WHERE id=?').run(uid);
}
