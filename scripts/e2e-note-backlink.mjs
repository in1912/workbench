// E2E（v1.10.24）：批量反链 —— 一组笔记两两互加 [[标题]]，落「## 关联笔记」小节。
//
// 覆盖：基本互链（每篇两两都链上 / note_links 六条有向边）/ 幂等（重跑 0 新增、
//       正文与 updated_at 一个字节不动）/ 已有小节时插在小节头下面（既有条目不冲掉）/
//       正文里手写的同名 [[链接]] 算已链过 / 手动标签不被冲掉 / 词数重算 /
//       少于两篇 → 400、不存在 → 404、重名标题 → 400 / 模态用的关键词搜索真的能搜到。
import { startServer, login, api, checker } from './_noteE2E.mjs';

const { B, stop } = await startServer({ tag: 'backlink', port: 3994 });
const s = checker();
const A = api(B, (await login(B, 'admin', 'test123456')).H);
const created = [];
const SECTION = '## 关联笔记';

try {
  // ---------- ① 基本互链：三篇两两互加 ----------
  let r = await A.post('/notes', { title: 'E2E装修预算', content: '瓷砖 8000，地板 6000。' });
  const a = r.body.id; created.push(a);
  r = await A.post('/notes', { title: 'E2E装修日记', content: '今天进场，先拆旧。', tags: ['重要'] });
  const b = r.body.id; created.push(b);
  r = await A.post('/notes', { title: 'E2E家电清单', content: '冰箱、洗衣机、烘干机。' });
  const c = r.body.id; created.push(c);

  r = await A.post('/notes/backlink-mutual', { ids: [a, b, c] });
  const st = r.body || {};
  s.ck('三篇互链：3 篇都动了、共加 6 条链接（每篇 2 条）',
    r.status === 200 && st.updated === 3 && st.links_added === 6, JSON.stringify(st).slice(0, 200));

  const na = (await A.get(`/notes/${a}`)).body;
  const nb = (await A.get(`/notes/${b}`)).body;
  s.ck('每篇末尾都长出了「## 关联笔记」小节，两条链接各就各位',
    na.content.includes(`\n${SECTION}\n`) && na.content.includes('- [[E2E装修日记]]') && na.content.includes('- [[E2E家电清单]]')
    && nb.content.includes('- [[E2E装修预算]]') && nb.content.includes('- [[E2E家电清单]]'),
    JSON.stringify(na.content));
  s.ck('小节在正文最末尾（原文一行不丢）', na.content.startsWith('瓷砖 8000，地板 6000。'), JSON.stringify(na.content));

  // note_links：三篇两两互链 = 6 条有向边
  const la = (await A.get(`/notes/${a}/backlinks`)).body;
  const lb = (await A.get(`/notes/${b}/backlinks`)).body;
  const lc = (await A.get(`/notes/${c}/backlinks`)).body;
  s.ck('反链面板真看到了这些边（每篇出链 2、入链 2）',
    la.out.length === 2 && la.in.length === 2 && lb.out.length === 2 && lc.out.length === 2,
    JSON.stringify([la.out.length, la.in.length, lb.out.length, lc.out.length]));
  s.ck('没有因为互链产生未解析链接', la.unresolved.length === 0 && lb.unresolved.length === 0, JSON.stringify(la.unresolved));

  // ---------- ② 幂等：重跑一个字节都不动 ----------
  const before = { a: na.content, upd: na.updated_at };
  r = await A.post('/notes/backlink-mutual', { ids: [a, b, c] });
  s.ck('重跑：0 篇要动、0 条新链接', r.status === 200 && r.body.updated === 0 && r.body.links_added === 0, JSON.stringify(r.body));
  const na2 = (await A.get(`/notes/${a}`)).body;
  s.ck('正文逐字节没变', na2.content === before.a, '');
  s.ck('updated_at 没有前进（没动就不算编辑）', na2.updated_at === before.upd, `${before.upd} → ${na2.updated_at}`);

  // ---------- ③ 正文里手写的同名链接算已链过 ----------
  r = await A.post('/notes', { title: 'E2E手写链接篇', content: '我早就写过 [[E2E装修预算]]，还写过 [[E2E装修日记]]。' });
  const d = r.body.id; created.push(d);
  r = await A.post('/notes/backlink-mutual', { ids: [d, c] });
  s.ck('手写链接的那篇只补缺的对方，不重复加', r.status === 200 && r.body.links_added === 2
    && r.body.details.find((x) => x.id === d).links.join() === 'E2E家电清单', JSON.stringify(r.body));
  const nd = (await A.get(`/notes/${d}`)).body;
  s.ck('补的那条落在小节里，手写的仍在原句里（各在各的位置）',
    nd.content.includes('我早就写过 [[E2E装修预算]]') && nd.content.split(SECTION).pop().includes('- [[E2E家电清单]]'),
    JSON.stringify(nd.content));
  // 反过来 c 侧链向 d 是全新的一条
  const nc = (await A.get(`/notes/${c}`)).body;
  s.ck('对方侧照样链过来（互链是双向的，不看你那边有没有写过）',
    nc.content.split(SECTION).pop().includes('- [[E2E手写链接篇]]'), JSON.stringify(nc.content.split(SECTION).pop()));

  // ---------- ④ 已有小节：新链接插在小节头下面，既有条目不冲掉 ----------
  r = await A.post('/notes', { title: 'E2E已有小节篇', content: '开头一段。\n\n## 关联笔记\n\n- 手动记的 [[E2E装修日记]]\n\n结尾一段。' });
  const e = r.body.id; created.push(e);
  r = await A.post('/notes/backlink-mutual', { ids: [e, a] });
  s.ck('已有小节的那篇：只补缺的 1 条（手里已有 装修日记 不算）', r.status === 200 && r.body.links_added === 2
    && r.body.details.find((x) => x.id === e).added === 1, JSON.stringify(r.body));
  const ne = (await A.get(`/notes/${e}`)).body;
  const secPart = ne.content.split(SECTION)[1] || '';
  s.ck('新链接插在小节头下面、既有条目原样留着、结尾一段也没丢',
    secPart.indexOf('- [[E2E装修预算]]') < secPart.indexOf('- 手动记的 [[E2E装修日记]]')
    && ne.content.includes('结尾一段。'), JSON.stringify(ne.content));

  // ---------- ⑤ 副作用与手动编辑同口径 ----------
  s.ck('手动标签没被冲掉（#重要 还在，平台口径同 IM 归档）', (nb.tags || []).includes('重要'), JSON.stringify(nb.tags));
  s.ck('词数按新正文重算了（> 原来的字数）', (await A.get(`/notes/${a}`)).body.word_count > 10, String((await A.get(`/notes/${a}`)).body.word_count));

  // ---------- ⑥ 参数校验 ----------
  r = await A.post('/notes/backlink-mutual', { ids: [a] });
  s.ck('只选一篇 → 400（互链至少两篇）', r.status === 400, JSON.stringify(r.body));
  r = await A.post('/notes/backlink-mutual', { ids: [a, 999999] });
  s.ck('选里有不存在的笔记 → 404 并点名是哪篇', r.status === 404 && /999999/.test(r.body.error || ''), JSON.stringify(r.body));
  r = await A.post('/notes', { title: 'E2E装修预算', content: '重名的那篇。' });
  const dup = r.body.id; created.push(dup);
  r = await A.post('/notes/backlink-mutual', { ids: [a, dup] });
  s.ck('重名标题 → 400（[[链接]] 分不清指向哪篇，先改名）', r.status === 400 && /重名/.test(r.body.error || ''), JSON.stringify(r.body));
  r = await A.post('/notes/backlink-mutual', { ids: 'not-array' });
  s.ck('ids 不是数组 → 400，不 500', r.status === 400, JSON.stringify(r.body));

  // ---------- ⑦ 模态用的关键词搜索真能按标题/正文搜到 ----------
  r = await A.get('/notes/search?mode=keyword&q=' + encodeURIComponent('E2E装修'));
  const hits = (r.body.rows || []).map((x) => x.id);
  s.ck('关键词搜索（模态的数据源）把这一批都搜出来了', [a, b, dup].every((x) => hits.includes(x)), JSON.stringify(r.body.rows.map((x) => x.title)));

  // ---------- ⑧ 清理 ----------
  for (const id of created) await A.del(`/notes/${id}`);
} catch (e) {
  console.error('用例异常：', e && e.stack ? e.stack : e);
  s.ck('用例未抛异常', false, String(e && e.message));
  for (const id of created) { try { await A.del(`/notes/${id}`); } catch { /* 清理尽力 */ } }
} finally {
  stop();
  s.done();
}
