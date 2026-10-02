// 单测：语音问「最近的邮件」必须拿到最新的那封（v1.9.35，用户报障）
//
// 用户报障：「我让它查询最近一个邮件，明明有10月2日的邮件，而它只能找到9月14日的一个招聘邮件」。
// 两层原因，缺一不可地复现在本用例里：
//   ① 邮件表的写入顺序是**倒序的**——emailService.listEmails 先把 mails 按日期降序排（最新在前），
//      再用一个事务顺序 INSERT，于是 id 越小日期越新。而所有查询都写 `ORDER BY id DESC`，
//      等于「按日期升序」→ 取到的是**最旧的 10 封**，最新的那封永远不会出现在 LIMIT 10 里。
//   ② 问句里「最近」被整句切词丢掉，只剩候选串「邮件」做 LIKE 子串匹配——正文里没写「邮件」
//      两个字的那封（10月2日那封）压根搜不到，而招聘邮件里写了「回复本邮件」，于是只有它命中。
// 用例造一个和生产同形的租户库：30 封邮件按「最新在前」插入（复刻 listEmails 的写入顺序），
// 其中最新那封（10月2日）正文不含「邮件」二字，第 12 封（9月14日）正文含「邮件」。
//
//   node scripts/test-email-recent.mjs
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// 必须在 import 任何 server 模块之前设好，db.js 会在加载时建库
const DATA = mkdtempSync(path.join(tmpdir(), 'wb-emailrecent-'));
process.env.DATA_DIR = DATA;

let passed = 0, failed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};

try {
  const { db, getTenantDb } = await import('../server/db.js');
  const searchService = await import('../server/services/searchService.js');
  const svc = await import('../server/services/xiaozhiService.js');

  const uid = Number(db.prepare("INSERT INTO users(username,password_hash,role) VALUES(?,?,?)").run('tester', 'x', 'admin').lastInsertRowid);
  const tdb = getTenantDb(uid);

  // ---------- 造数据：复刻 emailService.listEmails 的写入顺序（日期降序 → 顺序 INSERT）----------
  const day = (n) => new Date(Date.UTC(2026, 9, 2) - n * 86400000).toISOString(); // 第 n 天前，10-02 起往回
  const mails = [];
  for (let i = 0; i < 30; i++) {
    // 第 12 封（i=11）定成 9月14日 的招聘邮件，正文里带「邮件」二字（真实招聘邮件就这么写）
    const isHr = i === 11;
    const date = isHr ? '2026-09-14T03:00:00.000Z' : day(i);
    // 字面命中「邮件」二字的有两封：9-14 招聘（i=11）与更早的 9-12（i=20）——用来验「命中集内也按日期倒序」
    const hasWord = isHr || i === 20;
    mails.push({
      uid: 900 + i, // 序列号：越大越新（IMAP 语义），入库顺序 = 数组顺序
      subject: isHr ? '招聘邀请——人力资源总监石月月' : `例行通知 #${i}`,
      from: isHr ? 'hr@example.com' : `noreply${i}@example.com`,
      // 最新那封（i=0，10月2日）正文里**没有**「邮件」二字——这正是它搜不到的原因
      body: isHr ? '看到您宁波伯通的经验，特邀请您投递简历，可回复本邮件联系。'
        : hasWord ? `这是第 ${i} 封例行通知，请勿回复本邮件。` : `这是第 ${i} 封例行通知的正文。`,
      date,
    });
  }
  mails.sort((a, b) => (b.date || '').localeCompare(a.date || '')); // ← listEmails:435 原样
  const ins = tdb.prepare(
    "INSERT OR IGNORE INTO emails(account_id,uid,subject,from_name,from_addr,date,seen,folder) VALUES(?,?,?,?,?,?,0,'inbox')"
  );
  tdb.transaction((list) => { for (const m of list) ins.run(1, m.uid, m.subject, '', m.from, m.date); })(mails);
  const setBody = tdb.prepare('UPDATE emails SET body=? WHERE uid=?');
  for (const m of mails) setBody.run(m.body, m.uid);

  const newest = tdb.prepare('SELECT id, subject, date FROM emails ORDER BY COALESCE(date, fetched_at) DESC LIMIT 1').get();
  const oldest = tdb.prepare('SELECT id, subject, date FROM emails ORDER BY COALESCE(date, fetched_at) ASC LIMIT 1').get();
  const byIdDesc = tdb.prepare('SELECT id, subject, date FROM emails ORDER BY id DESC LIMIT 1').get();
  console.log(`  · 库内 ${tdb.prepare('SELECT COUNT(*) n FROM emails').get().n} 封；最新=${newest.date} id=${newest.id}；最旧=${oldest.date} id=${oldest.id}`);
  console.log(`  · 按 id DESC 取第一条 = ${byIdDesc.date}（${byIdDesc.subject}）`);

  console.log('— ①写入顺序导致 id 与日期反序（这条不修的话下面全错）');
  ok(byIdDesc.id === oldest.id && newest.id < oldest.id,
    'id 越小日期越新（复刻出生产形态：ORDER BY id DESC 取到的是最旧的）',
    `id DESC 第一条日期 ${byIdDesc.date}`);

  console.log('— ②全局搜索（面板与语音共用）里邮件命中集必须日期倒序');
  const sr = searchService.search(tdb, '邮件').results.filter((r) => r.type === '邮件');
  ok(sr.length >= 2, '能搜到邮件（正文含「邮件」二字的那几封）', `命中 ${sr.length} 封`);
  ok(sr.every((r, i) => i === 0 || sr[i - 1].time >= r.time), '命中集按日期倒序（新的在前）',
    `实际 ${sr.map((r) => r.time).join(' > ')}`);
  ok(sr[0] && String(sr[0].title).includes('石月月'), '9-14 招聘邮件排在更早那封之前',
    `实际第一条 ${sr[0] && sr[0].title}`);

  console.log('— ③「查一下我最近的邮件」：只认邮件表，且最新在前');
  const a = svc.searchWithFallback(tdb, '查一下我最近的邮件');
  const aMail = a.results.filter((r) => r.type === '邮件');
  ok(aMail.length > 0 && a.results[0].type === '邮件',
    '走的是邮件这一类（不被别的表劫持）', `实际第一条 type=${a.results[0] && a.results[0].type}`);
  ok(aMail[0] && aMail[0].time === newest.date, '第一条是最新那封', `实际 ${aMail[0] && aMail[0].time}`);
  ok(aMail.some((r) => r.time === newest.date), '最新那封在返回结果里（没被 LIMIT 10 挤掉）');

  console.log('— ④「查询最近一个邮件」/「最近收到的邮件是什么」同样');
  for (const q of ['查询最近一个邮件', '最近的邮件', '最近收到的邮件是什么']) {
    const r = svc.searchWithFallback(tdb, q);
    const m = r.results.filter((x) => x.type === '邮件');
    ok(m.length > 0 && m[0] && m[0].time === newest.date, `「${q}」第一条是最新那封`,
      `实际第一条 ${r.results[0] && r.results[0].type}/${m[0] && m[0].time}`);
  }

  console.log('— ⑤具名查询不受影响（问某件具体的事，仍按子串命中）');
  const hr = svc.searchWithFallback(tdb, '石月月');
  ok(hr.results.some((r) => String(r.title).includes('石月月')), '搜「石月月」仍能命中那封招聘邮件');
} catch (e) {
  failed++;
  console.error(`  ✗ 抛异常：${e && e.stack || e}`);
} finally {
  try { rmSync(DATA, { recursive: true, force: true }); } catch {}
}

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
