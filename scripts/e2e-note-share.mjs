// E2E：笔记分享链接 + 外部写入令牌（v1.9.39）
// 覆盖：分享生成 → 免登录访问 → 错码/错 token 被拒 → 关关闭/过期失效 → 访问计数 → 快照冻结
//       分类写入令牌 → 免登录写入落库 → 非法令牌 403
// 清理：只按本次创建的 id 精确删，不做全表 DELETE（CLAUDE.md §3）
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const admin = db.prepare("SELECT id, username FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const tA = crypto.randomBytes(24).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+15 minutes'))").run(tA, admin.id);
const HA = { Authorization: 'Bearer ' + tA, 'Content-Type': 'application/json' };
const HJ = { Authorization: 'Bearer ' + tA };

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };
const B = 'http://localhost:3000/api';
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { __raw: t.slice(0, 120) }; } };

const notes = [];          // 本次创建的笔记 id
const shares = [];         // 本次创建的分享 id
const cats = [];           // 本次创建的分类 id
const catRenames = [];     // [id, 原名] 便于恢复

try {
  // ---------- 准备一篇笔记 ----------
  let r = await fetch(B + '/notes', { method: 'POST', headers: HA, body: JSON.stringify({ title: 'E2E分享源笔记', content: '第一版正文\n\n## 小节\n内容 A' }) });
  let d = await j(r);
  const noteId = d.id;
  notes.push(noteId);
  ck('创建笔记', r.status === 200 && noteId > 0, JSON.stringify(d));

  // 服务端自动标签（第 3 条）
  r = await fetch(B + `/notes?q=E2E分享源笔记`, { headers: HJ });
  const row = (await j(r)).find((n) => n.id === noteId) || {};
  ck('保存时自动生成 tags 字段', typeof row.tags === 'string', JSON.stringify(row.tags));

  // ---------- ① 生成分享（活链接 / 7 天） ----------
  r = await fetch(B + `/notes/shares/note/${noteId}`, { method: 'POST', headers: HA, body: JSON.stringify({ expires_days: 7, mode: 'live', with_audio: 0 }) });
  d = await j(r);
  const sh = d;
  shares.push(sh.id);
  ck('生成分享返回 token/code/有效期', r.status === 200 && typeof sh.token === 'string' && sh.token.length >= 16 && /^[A-Za-z0-9]{4}$/.test(sh.code) && !!sh.expires_at, JSON.stringify(d));

  // ---------- ② 免登录访问（带正确码） ----------
  r = await fetch(`${B}/share/n/${sh.token}?c=${sh.code}`);
  d = await j(r);
  ck('免登录打开分享（200 + 内容）', r.status === 200 && d.title === 'E2E分享源笔记' && String(d.content).includes('第一版正文'), JSON.stringify(d));
  ck('分享内容携带分类与标签字段', 'category' in d && 'tags' in d && d.mode === 'live', JSON.stringify({ c: d.category, m: d.mode }));
  ck('访问计数 +1', d.views === 1, String(d.views));

  // ---------- ③ 错误凭证 ----------
  r = await fetch(`${B}/share/n/${sh.token}?c=zzzz`);
  ck('错访问码被拒（403，不是 401）', r.status === 403, String(r.status));
  r = await fetch(`${B}/share/n/nonexistenttoken000000000000?c=${sh.code}`);
  ck('不存在的 token 返回 404（不是 401）', r.status === 404, String(r.status));
  r = await fetch(`${B}/share/n/short?c=${sh.code}`);
  ck('超短 token 返回 404', r.status === 404, String(r.status));

  // ---------- ④ 统计（笔记页右上角用） ----------
  r = await fetch(B + `/notes/shares/note/${noteId}`, { headers: HJ });
  d = await j(r);
  ck('分享统计返回条数与总访问数', d.link_count === 1 && d.view_total === 1, JSON.stringify(d));

  // ---------- ⑤ 关闭访问 → 立即失效 ----------
  r = await fetch(B + `/notes/shares/${sh.id}`, { method: 'PUT', headers: HA, body: JSON.stringify({ disabled: 1 }) });
  ck('关闭访问返回 ok', r.status === 200 && (await j(r)).ok === true);
  r = await fetch(`${B}/share/n/${sh.token}?c=${sh.code}`);
  ck('关闭后访问被拒（403）', r.status === 403, String(r.status));
  r = await fetch(B + `/notes/shares/${sh.id}`, { method: 'PUT', headers: HA, body: JSON.stringify({ disabled: 0 }) });
  ck('重新开启访问', r.status === 200);

  // ---------- ⑥ 有效期改为不限 ----------
  r = await fetch(B + `/notes/shares/${sh.id}`, { method: 'PUT', headers: HA, body: JSON.stringify({ expires_days: 0 }) });
  d = await j(r);
  ck('有效期可改为不限（expires_at 置空）', r.status === 200 && !d.expires_at, JSON.stringify(d));

  // ---------- ⑦ 快照模式冻结内容 ----------
  r = await fetch(B + `/notes/shares/note/${noteId}`, { method: 'POST', headers: HA, body: JSON.stringify({ expires_days: 0, mode: 'snapshot' }) });
  const snap = await j(r);
  shares.push(snap.id);
  r = await fetch(B + `/notes/${noteId}`, { method: 'PUT', headers: HA, body: JSON.stringify({ title: 'E2E分享源笔记', content: '第二版正文（改过了）' }) });
  await j(r);
  r = await fetch(`${B}/share/n/${snap.token}?c=${snap.code}`);
  d = await j(r);
  ck('快照链接读取的仍是旧内容', r.status === 200 && String(d.content).includes('第一版正文'), String(d.content).slice(0, 40));
  r = await fetch(`${B}/share/n/${sh.token}?c=${sh.code}`);
  d = await j(r);
  ck('活链接跟随笔记更新', r.status === 200 && String(d.content).includes('第二版正文'), String(d.content).slice(0, 40));

  // ---------- ⑧ 过期即失效（把 expires_at 改到过去） ----------
  const tdb = new DatabaseSync(`data/tenant-${admin.id}.sqlite`);
  tdb.exec('PRAGMA busy_timeout = 8000');
  tdb.prepare("UPDATE note_shares SET expires_at='2020-01-01 00:00:00' WHERE id=?").run(snap.id);
  r = await fetch(`${B}/share/n/${snap.token}?c=${snap.code}`);
  ck('已过期链接被拒（403）', r.status === 403, String(r.status));
  tdb.prepare("UPDATE note_shares SET expires_at=NULL WHERE id=?").run(snap.id);
  tdb.close();

  // ---------- ⑨ 删除笔记 → 分享自动失效 ----------
  r = await fetch(B + `/notes/shares/${snap.id}`, { method: 'DELETE', headers: HA, body: '{}' });
  ck('删除单条分享', r.status === 200);
  r = await fetch(`${B}/share/n/${snap.token}?c=${snap.code}`);
  ck('删除后链接失效（404）', r.status === 404, String(r.status));
  shares.pop();

  // ================= 外部写入令牌 =================
  r = await fetch(B + '/notes/categories', { method: 'POST', headers: HA, body: JSON.stringify({ name: 'E2E外部队列' }) });
  const cat = await j(r);
  cats.push(cat.id);
  ck('新建外部写入分类', r.status === 200 && cat.id > 0, JSON.stringify(cat));

  r = await fetch(B + `/notes/categories/${cat.id}`, { method: 'PUT', headers: HA, body: JSON.stringify({ token_action: 'gen' }) });
  d = await j(r);
  const tok = d.intake_token;
  ck('生成写入令牌（32 位 hex）', r.status === 200 && /^[0-9a-f]{32}$/.test(String(tok)), JSON.stringify(d));

  const before = (await j(await fetch(B + '/notes?category=' + encodeURIComponent('E2E外部队列'), { headers: HJ }))).length;
  r = await fetch(`${B}/note-intake/${tok}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '外部系统推送', content: '来自 AI 的正文内容', summary: '一句摘要' }) });
  d = await j(r);
  ck('免登录写入成功并落在该分类下', r.status === 200 && d.ok === true && d.id > 0 && d.category === 'E2E外部队列', JSON.stringify(d));
  notes.push(d.id);
  const after = (await j(await fetch(B + '/notes?category=' + encodeURIComponent('E2E外部队列'), { headers: HJ })));
  ck('该分类笔记数 +1', after.length === before + 1, `${before} → ${after.length}`);
  const pushed = after.find((n) => n.id === d.id) || {};
  ck('落库字段齐全（标题/摘要/正文/时间）', pushed.title === '外部系统推送' && String(pushed.content).includes('来自 AI') && !!pushed.updated_at, JSON.stringify(pushed).slice(0, 120));

  r = await fetch(`${B}/note-intake/${'f'.repeat(32)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'x' }) });
  ck('非法令牌被拒（403）', r.status === 403, String(r.status));
  r = await fetch(`${B}/note-intake/`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'x' }) });
  ck('空令牌路径不落入写入口（非 200）', r.status !== 200, String(r.status));
  r = await fetch(`${B}/note-intake/${tok}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: '   ' }) });
  ck('空内容被拒（400）', r.status === 400, String(r.status));
  // 令牌只写不读：拿它当读接口应 404
  r = await fetch(`${B}/note-intake/${tok}`);
  ck('令牌接口不支持读（非 200）', r.status !== 200, String(r.status));

  r = await fetch(B + `/notes/categories/${cat.id}`, { method: 'PUT', headers: HA, body: JSON.stringify({ token_action: 'clear' }) });
  d = await j(r);
  ck('清除令牌', r.status === 200 && d.intake_token === '', JSON.stringify(d));
  r = await fetch(`${B}/note-intake/${tok}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'x' }) });
  ck('清除后原令牌失效（403）', r.status === 403, String(r.status));

  console.log(`\n${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  for (const id of shares) await fetch(B + `/notes/shares/${id}`, { method: 'DELETE', headers: HA }).catch(() => {});
  for (const id of notes) await fetch(B + `/notes/${id}`, { method: 'DELETE', headers: HA }).catch(() => {});
  for (const id of cats) {
    await fetch(B + `/notes/categories/${id}?force=1`, { method: 'DELETE', headers: HA }).catch(() => {});
  }
  for (const [id, name] of catRenames) await fetch(B + `/notes/categories/${id}`, { method: 'PUT', headers: HA, body: JSON.stringify({ name }) }).catch(() => {});
  db.prepare('DELETE FROM sessions WHERE token=?').run(tA);
  db.close();
}
