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

  // ---------- ⑧ 循环链接（v1.10.28）：按 ids 顺序串成环，每篇只链下一篇、末篇链回首篇 ----------
  r = await A.post('/notes', { title: 'E2E系列一', content: '一的内容。' });
  const s1 = r.body.id; created.push(s1);
  r = await A.post('/notes', { title: 'E2E系列二', content: '二的内容。' });
  const s2 = r.body.id; created.push(s2);
  r = await A.post('/notes', { title: 'E2E系列三', content: '三的内容。' });
  const s3 = r.body.id; created.push(s3);

  r = await A.post('/notes/backlink-chain', { ids: [s1, s2, s3] });
  s.ck('循环链：3 篇各补 1 条（共 3 条，不是互链的 6 条）',
    r.status === 200 && r.body.updated === 3 && r.body.links_added === 3 && r.body.notes_total === 3, JSON.stringify(r.body).slice(0, 200));
  const c1 = (await A.get(`/notes/${s1}`)).body;
  const c2 = (await A.get(`/notes/${s2}`)).body;
  const c3 = (await A.get(`/notes/${s3}`)).body;
  s.ck('方向正确：一→二、二→三（各只有一条「下一篇」链接，不是两两互加）',
    c1.content.includes('- [[E2E系列二]]') && !c1.content.includes('[[E2E系列三]]')
    && c2.content.includes('- [[E2E系列三]]') && !c2.content.includes('[[E2E系列一]]'),
    JSON.stringify([c1.content, c2.content]));
  s.ck('循环闭合：末篇（三）链回首篇（一）', c3.content.includes('- [[E2E系列一]]') && !c3.content.includes('[[E2E系列二]]'), JSON.stringify(c3.content));
  const l1 = (await A.get(`/notes/${s1}/backlinks`)).body;
  const l2 = (await A.get(`/notes/${s2}/backlinks`)).body;
  s.ck('note_links 也是环：每篇出链 1、入链 1', l1.out.length === 1 && l1.in.length === 1 && l2.out.length === 1 && l2.in.length === 1,
    JSON.stringify([l1.out.length, l1.in.length, l2.out.length, l2.in.length]));

  const c1before = { content: c1.content, upd: c1.updated_at };
  r = await A.post('/notes/backlink-chain', { ids: [s1, s2, s3] });
  s.ck('循环链幂等：重跑 0 篇动、0 条加', r.status === 200 && r.body.updated === 0 && r.body.links_added === 0, JSON.stringify(r.body));
  const c1again = (await A.get(`/notes/${s1}`)).body;
  s.ck('循环链重跑后正文与 updated_at 逐字节不变', c1again.content === c1before.content && c1again.updated_at === c1before.upd, '');

  // 顺序由 ids 数组决定（不是按 id 大小）：丙→乙→甲 的环与 甲→乙→丙 方向相反
  r = await A.post('/notes', { title: 'E2E系列甲', content: '甲。' });
  const j1 = r.body.id; created.push(j1);
  r = await A.post('/notes', { title: 'E2E系列乙', content: '乙。' });
  const j2 = r.body.id; created.push(j2);
  r = await A.post('/notes', { title: 'E2E系列丙', content: '丙。' });
  const j3 = r.body.id; created.push(j3);
  r = await A.post('/notes/backlink-chain', { ids: [j3, j2, j1] });
  const k3 = (await A.get(`/notes/${j3}`)).body, k2 = (await A.get(`/notes/${j2}`)).body, k1 = (await A.get(`/notes/${j1}`)).body;
  s.ck('倒序传入按传入顺序串（丙→乙、乙→甲、甲→丙）',
    k3.content.includes('- [[E2E系列乙]]') && k2.content.includes('- [[E2E系列甲]]') && k1.content.includes('- [[E2E系列丙]]'),
    JSON.stringify([k3.content, k2.content, k1.content]));

  // 正文里手写的「下一篇」链接算已链过：丁只补对方的，自己一个字节不动
  r = await A.post('/notes', { title: 'E2E系列丁', content: '我的下一篇是 [[E2E系列丙]]。' });
  const j4 = r.body.id; created.push(j4);
  r = await A.post('/notes/backlink-chain', { ids: [j4, j3] });
  s.ck('手写已链的那篇不动、只补缺的一侧', r.status === 200 && r.body.updated === 1 && r.body.links_added === 1
    && r.body.details[0].id === j3, JSON.stringify(r.body));
  const k4 = (await A.get(`/notes/${j4}`)).body;
  s.ck('手写的链接原样留在原句里', k4.content.includes('我的下一篇是 [[E2E系列丙]]。'), JSON.stringify(k4.content));

  // 循环链的参数校验：单篇 400 / 不存在 404 / 重名 400 / 非数组 400
  r = await A.post('/notes/backlink-chain', { ids: [s1] });
  s.ck('循环链只选一篇 → 400', r.status === 400 && /两篇/.test(r.body.error || ''), JSON.stringify(r.body));
  r = await A.post('/notes/backlink-chain', { ids: [s1, 999999] });
  s.ck('循环链里有不存在的笔记 → 404 并点名', r.status === 404 && /999999/.test(r.body.error || ''), JSON.stringify(r.body));
  r = await A.post('/notes/backlink-chain', { ids: [a, dup] });
  s.ck('循环链遇重名标题 → 400', r.status === 400 && /重名/.test(r.body.error || ''), JSON.stringify(r.body));
  r = await A.post('/notes/backlink-chain', { ids: 'no' });
  s.ck('循环链 ids 非数组 → 400，不 500', r.status === 400, JSON.stringify(r.body));

  // ---------- ⑨ 批量取消链接（v1.10.28）：清「## 关联笔记」小节里的条目，小节清空后节头不留 ----------
  // 复用 ①~④ 造成的现状：a/b/c 各有互链条目、e 的小节里有「说明文字条目 + 批量条目」、d 正文里有手写链接
  r = await A.post('/notes/backlink-clear', { ids: [a, b, c] });
  s.ck('取消链接：3 篇都清了、共移除 8 条（a 3 条 + b 2 条 + c 3 条）',
    r.status === 200 && r.body.updated === 3 && r.body.links_removed === 8, JSON.stringify(r.body));
  const za = (await A.get(`/notes/${a}`)).body;
  const zb = (await A.get(`/notes/${b}`)).body;
  s.ck('清完后小节整个撤掉、原文一行不少', !za.content.includes(SECTION) && za.content.startsWith('瓷砖 8000，地板 6000。')
    && !zb.content.includes(SECTION) && zb.content.startsWith('今天进场，先拆旧。'), JSON.stringify(za.content));
  const la2 = (await A.get(`/notes/${a}/backlinks`)).body;
  s.ck('note_links 同步清掉（a 出链 0；入链剩 2 条来自没清的篇：d 正文手写 + e 小节里那条，后面单独清）',
    la2.out.length === 0 && la2.in.length === 2 && la2.in.every((x) => [d, e].includes(x.id)), JSON.stringify(la2));

  // e 的小节：批量条目被清、带说明文字的条目和小节头保留（用户自己的字不动）
  r = await A.post('/notes/backlink-clear', { ids: [e] });
  s.ck('带说明文字的条目所在篇：只清 1 条批量条目', r.status === 200 && r.body.updated === 1 && r.body.links_removed === 1, JSON.stringify(r.body));
  const ze = (await A.get(`/notes/${e}`)).body;
  s.ck('说明文字条目与小节头保留、批量条目没了、结尾一段还在',
    ze.content.includes(SECTION) && ze.content.includes('- 手动记的 [[E2E装修日记]]') && !ze.content.includes('- [[E2E装修预算]]')
    && ze.content.includes('结尾一段。'), JSON.stringify(ze.content));

  // 正文里手写的内联 [[链接]] 不动（只清小节里的条目行）
  r = await A.post('/notes/backlink-clear', { ids: [d] });
  const zd = (await A.get(`/notes/${d}`)).body;
  s.ck('正文手写的 [[链接]] 原样保留（取消只清小节条目）',
    zd.content.includes('我早就写过 [[E2E装修预算]]') && zd.content.includes('还写过 [[E2E装修日记]]'), JSON.stringify(zd.content));
  s.ck('d 的小节条目已被清掉', !zd.content.includes('- [[E2E家电清单]]'), JSON.stringify(zd.content));

  // 幂等：没有可清条目的笔记一个字节不动
  const zBefore = { content: za.content, upd: za.updated_at };
  r = await A.post('/notes/backlink-clear', { ids: [a] });
  s.ck('取消链接幂等：重跑 0 条移除', r.status === 200 && r.body.updated === 0 && r.body.links_removed === 0, JSON.stringify(r.body));
  const za2 = (await A.get(`/notes/${a}`)).body;
  s.ck('重跑后正文与 updated_at 不变', za2.content === zBefore.content && za2.updated_at === zBefore.upd, '');

  // 参数校验：空数组 400 / 不存在 404（单篇是允许的——与互链不同，取消一篇也有意义）
  r = await A.post('/notes/backlink-clear', { ids: [] });
  s.ck('取消链接空数组 → 400', r.status === 400 && /至少.*一篇/.test(r.body.error || ''), JSON.stringify(r.body));
  r = await A.post('/notes/backlink-clear', { ids: [a, 999999] });
  s.ck('取消链接里有不存在的笔记 → 404 并点名', r.status === 404 && /999999/.test(r.body.error || ''), JSON.stringify(r.body));

  // 循环链 ↔ 互链互通：同一批笔记先串链再互链，互链把缺的对面补上（串过的算已链）
  r = await A.post('/notes', { title: 'E2E互通甲', content: '互通甲。' });
  const t1 = r.body.id; created.push(t1);
  r = await A.post('/notes', { title: 'E2E互通乙', content: '互通乙。' });
  const t2 = r.body.id; created.push(t2);
  await A.post('/notes/backlink-chain', { ids: [t1, t2] });
  r = await A.post('/notes/backlink-mutual', { ids: [t1, t2] });
  s.ck('先串链再互链：互链只补缺（2 篇 2 节点的环本就互达，0 新增）', r.status === 200 && r.body.links_added === 0, JSON.stringify(r.body));

  // ---------- ⑩ 清理 ----------
  for (const id of created) await A.del(`/notes/${id}`);
} catch (e) {
  console.error('用例异常：', e && e.stack ? e.stack : e);
  s.ck('用例未抛异常', false, String(e && e.message));
  for (const id of created) { try { await A.del(`/notes/${id}`); } catch { /* 清理尽力 */ } }
} finally {
  stop();
  s.done();
}
