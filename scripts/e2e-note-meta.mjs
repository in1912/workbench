// E2E（v1.9.41）：属性定义 / 模板 / 书签 / 每日笔记 / 设置 / 统计 / 时间线 / 日历 by-day。
// 末尾还直接调 scheduler.ensureDailyNotes 验每日笔记的自动创建（同一套隔离 DATA_DIR）。
import { createRequire } from 'node:module';
import { startServer, login, api, checker } from './_noteE2E.mjs';

const { B, DATA, stop } = await startServer({ tag: 'meta', port: 3974 });
const s = checker();
const A = api(B, (await login(B, 'admin', 'test123456')).H);
const today = new Date().toLocaleString('sv').slice(0, 10);
const created = [];
let propId = null; let tplId = null; let dailyId = null;

const del = async (p) => { const r = await A.del(p); return r; };

try {
  // ---------- ① 属性定义 ----------
  let r = await A.get('/notes/properties');
  s.ck('初始属性表为空数组', r.status === 200 && Array.isArray(r.body), JSON.stringify(r.body).slice(0, 120));

  r = await A.post('/notes/properties', { key: '状态', label: '阅读状态', type: 'select', options: ['待读', '在读', '已读'] });
  propId = r.body.id;
  s.ck('建属性定义', r.status === 200 && propId > 0, JSON.stringify(r.body));

  r = await A.post('/notes/properties', { key: '状态' });
  s.ck('同名属性 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

  r = await A.post('/notes/properties', { key: '   ' });
  s.ck('空属性名 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

  r = await A.post('/notes/properties', { key: '评分', type: 'number' });
  const prop2 = r.body.id;
  r = await A.post('/notes/properties', { key: '不存在的类型', type: 'wat' });
  const prop3 = r.body.id;
  r = await A.get('/notes/properties');
  s.ck('列表按 sort_order 排且 options 解析成数组', r.body.length === 3 && Array.isArray(r.body[0].options) && r.body[0].options.length === 3, JSON.stringify(r.body));
  s.ck('未知类型回落到 text', r.body.find((x) => x.id === prop3).type === 'text', JSON.stringify(r.body.find((x) => x.id === prop3)));

  r = await A.put(`/notes/properties/${propId}`, { label: '读书状态', type: 'select', options: ['待读', '在读', '已读', '弃读'] });
  s.ck('改属性定义', r.status === 200 && r.body.ok, JSON.stringify(r.body));
  r = await A.put(`/notes/properties/${prop3}`, { key: '状态' });
  s.ck('改属性名撞车 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  r = await A.put('/notes/properties/999999', { label: 'x' });
  s.ck('改不存在的属性 → 404', r.status === 404, `${r.status}`);

  // ---------- ② 属性值：走 PUT /notes/:id 的 props ----------
  r = await A.post('/notes', { title: 'E2E属性甲', content: '关于属性的一篇笔记，正文写长一点凑够字数方便统计。' });
  const n1 = r.body.id; created.push(n1);
  r = await A.put(`/notes/${n1}`, { props: { 状态: '在读', 评分: 4 } });
  s.ck('写 props', r.status === 200, JSON.stringify(r.body));
  r = await A.get(`/notes/${n1}`);
  s.ck('详情里 props 是对象', r.body.props && r.body.props['状态'] === '在读' && r.body.props['评分'] === 4, JSON.stringify(r.body.props));

  // props 只传一次：再存正文不该把属性抹掉（标题要一起带上——不传 title 会按正文首行重算，这是老契约）
  r = await A.put(`/notes/${n1}`, { title: 'E2E属性甲', content: '改了正文，属性应该还在。' });
  r = await A.get(`/notes/${n1}`);
  s.ck('只存正文不动 props', r.body.props['状态'] === '在读', JSON.stringify(r.body.props));

  // Dataview 认 prop.键名（json_extract）
  r = await A.post('/notes/query', { text: 'prop.状态 = "在读"' });
  s.ck('Dataview 查 prop.键名', r.status === 200 && r.body.rows.some((x) => x.id === n1), JSON.stringify(r.body.rows.map((x) => x.title)));
  r = await A.post('/notes/query', { text: 'prop.状态 = "已读"' });
  s.ck('Dataview 查 prop 不匹配则空', r.body.rows.length === 0, String(r.body.count));

  await del(`/notes/properties/${prop2}`);
  r = await A.get('/notes/properties');
  s.ck('删定义后笔记上的 props 值还在', r.body.every((x) => x.id !== prop2), JSON.stringify(r.body.map((x) => x.key)));

  // ---------- ③ 模板 ----------
  r = await A.post('/notes/templates', { name: '闪念', content: '# {{title}}\n\n{{date}} {{time}}\n\n- [ ] ' });
  tplId = r.body.id;
  s.ck('建模板', r.status === 200 && tplId > 0, JSON.stringify(r.body));
  r = await A.post('/notes/templates', { name: '' });
  s.ck('空模板名 → 400', r.status === 400, `${r.status}`);

  r = await A.post('/notes/from-template', { template_id: tplId, title: 'E2E模板产出' });
  const n2 = r.body.id; created.push(n2);
  s.ck('从模板建笔记', r.status === 200 && n2 > 0, JSON.stringify(r.body));
  r = await A.get(`/notes/${n2}`);
  s.ck('占位符被替换（title/date/time）',
    r.body.content.includes('E2E模板产出') && r.body.content.includes(today) && !r.body.content.includes('{{'),
    JSON.stringify(r.body.content).slice(0, 160));

  r = await A.post('/notes/from-template', { template_id: 999999 });
  s.ck('模板不存在 → 404', r.status === 404, `${r.status}`);

  r = await A.put(`/notes/templates/${tplId}`, { content: '# {{title}}\n改过的模板\n' });
  s.ck('改模板', r.status === 200 && r.body.ok, JSON.stringify(r.body));
  r = await A.get('/notes/templates');
  s.ck('模板列表带 updated_at', r.body.some((x) => x.id === tplId && x.content.includes('改过的模板')), JSON.stringify(r.body.map((x) => x.name)));

  // ---------- ④ 书签 ----------
  r = await A.put(`/notes/${n1}/bookmark`, { on: true, label: '重点' });
  s.ck('加书签', r.status === 200 && r.body.bookmarked === true, JSON.stringify(r.body));
  r = await A.get('/notes/bookmarks');
  s.ck('书签列表带标题与所在文件夹', r.body.length === 1 && r.body[0].title === 'E2E属性甲' && 'folder_name' in r.body[0],
    JSON.stringify(r.body.map((x) => [x.kind, x.title, x.folder_name])));

  r = await A.put(`/notes/${n1}/bookmark`, { kind: 'heading', anchor: '绪论', on: true });
  s.ck('段落书签与整篇书签能共存', r.status === 200, JSON.stringify(r.body));
  r = await A.get('/notes/bookmarks?kind=heading');
  s.ck('按 kind 过滤', r.body.length === 1 && r.body[0].anchor === '绪论', JSON.stringify(r.body.map((x) => x.anchor)));
  r = await A.get('/notes/bookmarks');
  s.ck('两类书签共 2 条', r.body.length === 2, String(r.body.length));

  r = await A.put(`/notes/${n1}/bookmark`, { on: false });
  r = await A.get('/notes/bookmarks?kind=note');
  s.ck('取消整篇书签', r.body.length === 0, String(r.body.length));
  r = await A.put('/notes/999999/bookmark', { on: true });
  s.ck('给不存在的笔记加书签 → 404', r.status === 404, `${r.status}`);

  // 列表接口的 bookmarked 过滤认的是 note_bookmarks(kind='note')
  r = await A.put(`/notes/${n1}/bookmark`, { on: true });
  r = await A.get('/notes?bookmarked=1');
  s.ck('GET /notes?bookmarked=1 认书签', r.body.some((x) => x.id === n1), JSON.stringify(r.body.map((x) => x.title)));

  // ---------- ⑤ 每日笔记（幂等） ----------
  r = await A.get('/notes/daily?date=2026-01-15');
  s.ck('还没建时 daily 返回 note:null', r.status === 200 && r.body.date === '2026-01-15' && r.body.note === null, JSON.stringify(r.body).slice(0, 140));

  r = await A.post('/notes/daily', { date: '2026-01-15' });
  dailyId = r.body.id; created.push(dailyId);
  s.ck('建每日笔记', r.status === 200 && r.body.created === true && dailyId > 0, JSON.stringify(r.body).slice(0, 160));
  s.ck('默认标题是日期 + 日记', r.body.note.title === '2026-01-15 日记', r.body.note.title);

  r = await A.post('/notes/daily', { date: '2026-01-15' });
  s.ck('同一天再建 → 同一个 id 且 created=false', r.body.id === dailyId && r.body.created === false, JSON.stringify(r.body).slice(0, 140));
  r = await A.get('/notes/daily?date=2026-01-15');
  s.ck('GET daily 拿到同一条', r.body.note && r.body.note.id === dailyId, JSON.stringify(r.body).slice(0, 140));

  r = await A.get('/notes');
  s.ck('每日笔记只出现一条', r.body.filter((x) => x.daily_date === '2026-01-15').length === 1,
    String(r.body.filter((x) => x.daily_date === '2026-01-15').length));

  // 设置 → 模板 → 新建的每日笔记内容来自模板
  r = await A.put('/notes/settings', { daily_note: { auto_create: true, template_id: tplId } });
  s.ck('存每日笔记设置', r.status === 200 && r.body.daily_note.auto_create === true && r.body.daily_note.template_id === tplId, JSON.stringify(r.body));
  r = await A.get('/notes/settings');
  s.ck('读回设置', r.body.daily_note.auto_create === true && r.body.daily_note.template_id === tplId, JSON.stringify(r.body));

  r = await A.post('/notes/daily', { date: '2026-01-16' });
  const d16 = r.body.id; created.push(d16);
  s.ck('带模板时每日笔记正文来自模板', r.body.note.content.includes('改过的模板') && r.body.note.content.includes('2026-01-16'),
    JSON.stringify(r.body.note.content).slice(0, 160));

  r = await A.put('/notes/settings', { daily_note: { template_id: null } });
  s.ck('设置能被清空', r.body.daily_note.template_id === null, JSON.stringify(r.body.daily_note));

  // ---------- ⑥ 统计 ----------
  r = await A.get('/notes/stats');
  const st = r.body;
  s.ck('stats 形状完整',
    r.status === 200 && typeof st.total_notes === 'number' && typeof st.total_words === 'number'
    && typeof st.today_words === 'number' && typeof st.active_days === 'number'
    && typeof st.streak_days === 'number' && typeof st.longest_streak === 'number'
    && Array.isArray(st.by_folder) && Array.isArray(st.by_day),
    JSON.stringify(st).slice(0, 220));
  s.ck('stats 数字对得上（本次建了 4 篇）', st.total_notes === 4, String(st.total_notes));
  s.ck('字数被算进去（>0）', st.total_words > 0, String(st.total_words));
  s.ck('今天有记录 → 连续天数 ≥ 1', st.streak_days >= 1, String(st.streak_days));
  s.ck('按文件夹分布非空', st.by_folder.length >= 1 && st.by_folder[0].count > 0, JSON.stringify(st.by_folder));
  s.ck('by_day 升序且带 count/words', st.by_day.length >= 1 && 'd' in st.by_day[0] && 'c' in st.by_day[0] && 'w' in st.by_day[0],
    JSON.stringify(st.by_day.slice(-3)));

  r = await A.get('/notes/stats?days=1');
  s.ck('days 参数收窄曲线（≤2 个桶）', r.body.by_day.length <= 2, String(r.body.by_day.length));

  // ---------- ⑦ 时间线 ----------
  r = await A.get('/notes/timeline?field=created&granularity=day');
  s.ck('时间线按天分桶', r.status === 200 && r.body.field === 'created' && r.body.buckets.length >= 1
    && /^\d{4}-\d{2}-\d{2}$/.test(r.body.buckets[0].bucket), JSON.stringify(r.body).slice(0, 200));
  const totalInBuckets = r.body.buckets.reduce((a, b) => a + b.count, 0);
  s.ck('分桶计数合计 = 全部笔记', totalInBuckets === 4, String(totalInBuckets));

  r = await A.get('/notes/timeline?field=created&granularity=month');
  s.ck('按月分桶格式 YYYY-MM', r.body.buckets.length >= 1 && /^\d{4}-\d{2}$/.test(r.body.buckets[0].bucket), JSON.stringify(r.body.buckets));
  r = await A.get('/notes/timeline?field=updated&granularity=week');
  s.ck('按周分桶格式 YYYY-Www', r.body.buckets.length >= 1 && /^\d{4}-W\d{2}$/.test(r.body.buckets[0].bucket), JSON.stringify(r.body.buckets));

  r = await A.get('/notes/timeline?field=daily&from=2026-01-15&to=2026-01-15');
  s.ck('时间线按日期区间收窄（只剩 01-15）', r.body.buckets.length === 1 && r.body.buckets[0].count === 1, JSON.stringify(r.body.buckets));

  // ---------- ⑧ 日历 by-day ----------
  r = await A.get('/notes/by-day?from=2099-01-01&to=2099-01-02');
  s.ck('空区间返回空对象', r.status === 200 && Object.keys(r.body).length === 0, JSON.stringify(r.body));
  r = await A.get('/notes/by-day?from=nope&to=2026-01-01');
  s.ck('from 格式不对 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

  r = await A.get(`/notes/by-day?from=${today}&to=${today}`);
  const dayList = r.body[today] || [];
  s.ck('今天的格子里有笔记', dayList.some((x) => x.id === n1), JSON.stringify(r.body).slice(0, 200));
  s.ck('chip 带 id/title/daily 标记', dayList.every((x) => 'id' in x && 'title' in x && 'daily' in x), JSON.stringify(dayList[0]));

  r = await A.get('/notes/by-day?from=2026-01-15&to=2026-01-16');
  s.ck('每日笔记落在自己的格子且 daily=true',
    (r.body['2026-01-15'] || []).some((x) => x.daily === true) && (r.body['2026-01-16'] || []).some((x) => x.daily === true),
    JSON.stringify(r.body).slice(0, 200));

  // ---------- ⑨ 每日笔记调度器 ----------
  // 直接调 scheduler 里的那个函数（不是走 HTTP）：它是 cron 任务的本体，
  // 用同一套隔离 DATA_DIR 打开租户库，验证「开关关着不动 / 打开后按天幂等」。
  process.env.DATA_DIR = DATA;
  const require_ = createRequire(import.meta.url);
  const { forEachTenant } = require_('../server/db.js');
  const { ensureDailyNotes } = require_('../server/scheduler.js');
  const runDaily = () => { let n = 0; forEachTenant((d, uid, username) => { n++; ensureDailyNotes(d, username); }); return n; };

  // ⑤ 段的设置里 auto_create 一直是 true，这里先明确关掉，再验「关着不动」
  await A.put('/notes/settings', { daily_note: { auto_create: false } });
  r = await A.get(`/notes/daily?date=${today}`);
  const beforeId = r.body.note ? r.body.note.id : null;

  runDaily();
  r = await A.get(`/notes/daily?date=${today}`);
  s.ck('auto_create 关着时调度器不建笔记', (r.body.note ? r.body.note.id : null) === beforeId, JSON.stringify(r.body).slice(0, 200));

  r = await A.put('/notes/settings', { daily_note: { auto_create: true } });
  s.ck('设置里能打开每日笔记自动创建', r.status === 200 && r.body.daily_note.auto_create === true, JSON.stringify(r.body));

  runDaily();
  r = await A.get(`/notes/daily?date=${today}`);
  const autoId = r.body.note ? r.body.note.id : null;
  s.ck('打开后调度器建出当天那篇', autoId != null && autoId !== beforeId, JSON.stringify(r.body).slice(0, 200));

  runDaily();
  runDaily();
  r = await A.get(`/notes/daily?date=${today}`);
  s.ck('同一天重复跑不会重复创建（按天幂等）', r.body.note && r.body.note.id === autoId, JSON.stringify(r.body).slice(0, 200));
  if (autoId && autoId !== beforeId) created.push(autoId);
  await A.put('/notes/settings', { daily_note: { auto_create: false } });

  // ---------- 标题长度上限（v1.10.13：60 → 120）----------
  // 为什么要盯死这个数：IM 归档的标题规则是「对方姓名-日期时间-会话 ID」，而一个飞书 chat_id
  // （oc_ + 32 位）就 35 个字符，加时间 16 和两个连字符已经 53 —— 姓名只要超过 7 个字就撞上原来的 60，
  // 标题会被从 chat_id 中间截断（而那串 ID 正是这篇笔记的稳定身份）。所以这里钉住「不许再退回 60」。
  {
    const IM_TITLE = "泉哥's Feishu Assistant-2026-09-29 10:48-oc_d072b5362aac789b457fbf5d872b79bd";  // 74 字，实测会撞线的真实样例
    let r = await A.post('/notes', { title: IM_TITLE, content: '标题长度上限用例' });
    s.ck('74 字的 IM 式标题建得出来', r.status === 200 && r.body && r.body.id > 0, JSON.stringify(r.body).slice(0, 160));
    const longId = r.body && r.body.id;
    if (longId) {
      created.push(longId);
      r = await A.get(`/notes/${longId}`);
      s.ck('★ 标题一个字符都没被截（chat_id 完整）', String(r.body && r.body.title) === IM_TITLE,
          `长度 ${String(r.body && r.body.title || '').length}/74：${String(r.body && r.body.title || '').slice(-18)}`);
      // 改标题这条路（PUT）以前也是 60，两个入口都得验
      const T2 = IM_TITLE.replace('泉哥', '泉哥2');
      r = await A.put(`/notes/${longId}`, { title: T2 });
      s.ck('★ PUT 改标题也不截断', String(r.body && r.body.title) === T2, String(r.body && r.body.title || '').slice(-18));
    }
    // 上限仍然是**有**的（120），只是够宽容
    r = await A.post('/notes', { title: '长'.repeat(200), content: '超长标题' });
    const capped = r.body && r.body.id;
    if (capped) {
      created.push(capped);
      r = await A.get(`/notes/${capped}`);
      s.ck('超过 120 的标题仍然被削到 120（不是无上限）', String(r.body && r.body.title || '').length === 120,
          `实长 ${String(r.body && r.body.title || '').length}`);
    } else {
      s.ck('超过 120 的标题仍然被削到 120（不是无上限）', false, JSON.stringify(r).slice(0, 120));
    }
  }

  // ---------- 清理 ----------
  for (const id of created) await del(`/notes/${id}`);
  await del(`/notes/properties/${propId}`);
  await del(`/notes/properties/${prop3}`);
  await del(`/notes/templates/${tplId}`);
} finally {
  stop();
  s.done();
}
