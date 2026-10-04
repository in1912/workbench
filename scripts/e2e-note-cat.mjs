// E2E：笔记分类管理 + 自动标签 + 双向链接（v1.9.39）
// 清理：只按本次创建的 id 精确删，不做全表 DELETE（CLAUDE.md §3）
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const tA = crypto.randomBytes(24).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+15 minutes'))").run(tA, admin.id);
const HA = { Authorization: 'Bearer ' + tA, 'Content-Type': 'application/json' };
const HJ = { Authorization: 'Bearer ' + tA };

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };
const B = (process.env.E2E_BASE || 'http://localhost:3000') + '/api'; // E2E_BASE 用来指向另起的临时实例
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { __raw: t.slice(0, 120) }; } };

const notes = [];
const cats = [];

try {
  // ---------- ① 种子分类 ----------
  let r = await fetch(B + '/notes/categories', { headers: HJ });
  let d = await j(r);
  ck('默认分类已播种（含「未分类」）', r.status === 200 && d.some((c) => c.name === 'general'), JSON.stringify(d.map((c) => c.name)));
  ck('分类带 note_count 字段', d.every((c) => typeof c.note_count === 'number'), JSON.stringify(d[0]));
  const general = d.find((c) => c.name === 'general');

  // ---------- ② 增 ----------
  r = await fetch(B + '/notes/categories', { method: 'POST', headers: HA, body: JSON.stringify({ name: 'E2E分类甲' }) });
  const catA = await j(r);
  cats.push(catA.id);
  ck('新增分类', r.status === 200 && catA.id > 0, JSON.stringify(catA));

  r = await fetch(B + '/notes/categories', { method: 'POST', headers: HA, body: JSON.stringify({ name: 'E2E分类甲' }) });
  ck('重名分类被拒（400）', r.status === 400, String(r.status));

  r = await fetch(B + '/notes/categories', { method: 'POST', headers: HA, body: JSON.stringify({ name: '   ' }) });
  ck('空名分类被拒（400）', r.status === 400, String(r.status));

  r = await fetch(B + '/notes/categories', { method: 'POST', headers: HA, body: JSON.stringify({ name: 'E2E分类乙' }) });
  const catB = await j(r);
  cats.push(catB.id);
  ck('新增第二个分类（排序自动递增）', r.status === 200 && catB.id > 0);

  // ---------- ③ 改（改名 / 排序） ----------
  r = await fetch(B + `/notes/categories/${catB.id}`, { method: 'PUT', headers: HA, body: JSON.stringify({ name: 'E2E分类乙改名' }) });
  ck('分类改名', r.status === 200 && (await j(r)).ok === true);
  r = await fetch(B + `/notes/categories/${catB.id}`, { method: 'PUT', headers: HA, body: JSON.stringify({ name: 'E2E分类甲' }) });
  ck('改成已存在的名字被拒（400）', r.status === 400, String(r.status));
  r = await fetch(B + `/notes/categories/${catB.id}`, { method: 'PUT', headers: HA, body: JSON.stringify({ sort_order: -5 }) });
  d = await j(r);
  ck('分类排序可改', r.status === 200 && (await (await fetch(B + '/notes/categories', { headers: HJ })).json())[0].id === catB.id);

  // ---------- ④ 分类下建笔记 + 精确过滤 ----------
  r = await fetch(B + '/notes', { method: 'POST', headers: HA, body: JSON.stringify({ title: '甲类笔记', content: '甲类正文', category: 'E2E分类甲' }) });
  const n1 = (await j(r)).id;
  notes.push(n1);
  r = await fetch(B + '/notes?category=' + encodeURIComponent('E2E分类甲'), { headers: HJ });
  d = await j(r);
  ck('?category= 精确过滤（不含其它分类）', d.length === 1 && d[0].id === n1, JSON.stringify(d.map((n) => n.title)));

  r = await fetch(B + '/notes/categories', { headers: HJ });
  const withCount = (await j(r)).find((c) => c.id === catA.id);
  ck('分类 note_count 计入新笔记', withCount && withCount.note_count === 1, JSON.stringify(withCount));

  // ---------- ⑤ 删有笔记的分类：409 → force ----------
  r = await fetch(B + `/notes/categories/${catA.id}`, { method: 'DELETE', headers: HA });
  d = await j(r);
  ck('删有笔记的分类返回 409 + 条数', r.status === 409 && d.count === 1 && d.need_force === true, JSON.stringify(d));
  r = await fetch(B + `/notes/categories/${catA.id}?force=1`, { method: 'DELETE', headers: HA });
  d = await j(r);
  ck('force=1 删除并报告迁移条数', r.status === 200 && d.moved === 1, JSON.stringify(d));
  cats.splice(cats.indexOf(catA.id), 1);
  const moved = (await j(await fetch(B + '/notes?q=' + encodeURIComponent('甲类笔记'), { headers: HJ }))).find((n) => n.id === n1);
  ck('未修改的笔记落到「未分类」', moved && moved.category === 'general', JSON.stringify(moved && moved.category));

  // ---------- ⑥ 未分类不可删 ----------
  r = await fetch(B + `/notes/categories/${general.id}`, { method: 'DELETE', headers: HA });
  ck('「未分类」不可删除（400）', r.status === 400, String(r.status));

  // ---------- ⑦ 自动标签（不依赖 AI） ----------
  r = await fetch(B + '/notes', { method: 'POST', headers: HA, body: JSON.stringify({
    content: '项目管理的核心是项目管理和项目排期。项目排期决定了项目管理的节奏，项目管理离不开排期。',
  }) });
  const n2 = (await j(r)).id;
  notes.push(n2);
  let row = (await j(await fetch(B + '/notes?q=' + encodeURIComponent('项目'), { headers: HJ }))).find((n) => n.id === n2);
  const tags = String(row.tags || '').split(',').filter(Boolean);
  ck('保存时自动生成标签（非 AI）', tags.length > 0 && tags.length <= 5, JSON.stringify(row.tags));
  ck('高频词进标签', tags.includes('项目管理') || tags.includes('项目'), JSON.stringify(tags));
  ck('标题自动生成', !!row.title && row.title !== '无标题笔记', row.title);

  // ---------- ⑧ 双向链接 ----------
  r = await fetch(B + '/notes', { method: 'POST', headers: HA, body: JSON.stringify({ title: 'E2E目标笔记', content: '目标正文' }) });
  const nT = (await j(r)).id;
  notes.push(nT);
  r = await fetch(B + '/notes', { method: 'POST', headers: HA, body: JSON.stringify({ title: 'E2E来源笔记', content: '参考 [[E2E目标笔记]] 的结论。' }) });
  const nS = (await j(r)).id;
  notes.push(nS);

  let links = await j(await fetch(B + `/notes/${nS}/links`, { headers: HJ }));
  ck('出链被解析出来', links.length === 1 && links[0].id === nT && links[0].dir === 'out', JSON.stringify(links));
  links = await j(await fetch(B + `/notes/${nT}/links`, { headers: HJ }));
  ck('反链可查（目标侧看到来源）', links.length === 1 && links[0].id === nS && links[0].dir === 'in', JSON.stringify(links));

  r = await fetch(B + `/notes/${nS}`, { method: 'PUT', headers: HA, body: JSON.stringify({ title: 'E2E来源笔记', content: '不再引用了。' }) });
  await j(r);
  links = await j(await fetch(B + `/notes/${nS}/links`, { headers: HJ }));
  ck('改写后旧链被清掉', links.length === 0, JSON.stringify(links));
  r = await fetch(B + `/notes/${nS}`, { method: 'PUT', headers: HA, body: JSON.stringify({ title: 'E2E来源笔记', content: '又引用 [[不存在的笔记标题]]。' }) });
  await j(r);
  links = await j(await fetch(B + `/notes/${nS}/links`, { headers: HJ }));
  ck('未命中的 [[]] 不产生链接', links.length === 0, JSON.stringify(links));

  console.log(`\n${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  for (const id of notes) await fetch(B + `/notes/${id}`, { method: 'DELETE', headers: HA }).catch(() => {});
  for (const id of cats) await fetch(B + `/notes/categories/${id}?force=1`, { method: 'DELETE', headers: HA }).catch(() => {});
  db.prepare('DELETE FROM sessions WHERE token=?').run(tA);
  db.close();
}
