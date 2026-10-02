// 全局搜索（v1.9.31：从 routes/core.js 抽出，供面板与智能板语音共用同一套检索）
// 抽出的唯一原因：智能板语音查询（xiaozhiService.askWorkbench）必须和面板搜到的东西一致——
// 两处各写一份迟早会漂移。行为与抽取前的 GET /api/search 逐字一致（含 family/news 的共享开关选库）。
const { routedDb } = require('../db');

// 每类表的固定上限（与抽取前一致）。limit 只影响「整体返回条数」的上限，不影响单类。
function search(tdb, q, { limit } = {}) {
  const query = String(q || '').trim();
  if (!query) return { results: [] };
  const like = `%${query}%`;
  const out = [];
  const collect = (rows, type, titleOf, linkOf) => {
    for (const r of rows) {
      out.push({ type, id: r.id, title: titleOf(r), content: r._c || '', time: r._t || '', to: linkOf ? linkOf(r) : undefined });
    }
  };
  collect(tdb.prepare('SELECT id, title AS t, content AS _c, updated_at AS _t FROM notes WHERE title LIKE ? OR content LIKE ? ORDER BY updated_at DESC LIMIT 10').all(like, like), '笔记', (r) => r.t);
  collect(tdb.prepare('SELECT id, title AS t, desc AS _c, due_date AS _t FROM todos WHERE title LIKE ? OR desc LIKE ? LIMIT 10').all(like, like), '待办', (r) => r.t);
  // 日程（v1.9.33 补）：这张表原来**不在检索范围内**，于是「查一下我的日程」永远 0 结果
  // （偶尔返回几条是别的表里恰好含「日程」二字，纯属巧合）——用户报「查不到内容」的主因之一
  collect(tdb.prepare("SELECT id, title AS t, COALESCE(desc,'') AS _c, COALESCE(start_time,'') AS _t FROM events WHERE title LIKE ? OR desc LIKE ? OR location LIKE ? ORDER BY start_time DESC LIMIT 10").all(like, like, like), '日程', (r) => r.t);
  // 家庭事项/子女任务：随 family 共享开关选库
  const fdb = routedDb(tdb, 'family');
  collect(fdb.prepare('SELECT id, title AS t, desc AS _c, item_date AS _t FROM family_items WHERE title LIKE ? OR desc LIKE ? LIMIT 10').all(like, like), '家庭事项', (r) => r.t);
  collect(fdb.prepare("SELECT id, content AS t, '' AS _c, due_date AS _t FROM kid_tasks WHERE content LIKE ? LIMIT 10").all(like), '子女任务', (r) => r.t.slice(0, 60));
  collect(tdb.prepare('SELECT id, content AS t, gains AS _c, record_date AS _t FROM learning_records WHERE content LIKE ? OR gains LIKE ? LIMIT 10').all(like, like), '学习记录', (r) => r.t.slice(0, 60));
  collect(tdb.prepare("SELECT id, content AS t, '' AS _c, created_at AS _t FROM clipboard_items WHERE content LIKE ? LIMIT 10").all(like), '剪贴板', (r) => r.t.slice(0, 60));
  // 新闻：标题/摘要（news 表无 content 列；按共享开关选库）
  collect(routedDb(tdb, 'news').prepare('SELECT id, title AS t, summary AS _c, source AS _t FROM news WHERE title LIKE ? OR summary LIKE ? LIMIT 10')
    .all(like, like), '新闻', (r) => r.t);
  // 邮件：主题 + 正文全文
  collect(tdb.prepare('SELECT id, subject AS t, COALESCE(body, snippet, \'\') AS _c, COALESCE(date, fetched_at, \'\') AS _t FROM emails WHERE subject LIKE ? OR body LIKE ? OR from_addr LIKE ? ORDER BY id DESC LIMIT 10')
    .all(like, like, like), '邮件', (r) => r.t);
  // AI 对话：消息内容（带会话标题，点击跳转 AI 助手对应会话）
  collect(tdb.prepare(`SELECT m.id AS id, s.title AS t, m.content AS _c, m.created_at AS _t, s.id AS _sid
    FROM ai_messages m JOIN ai_sessions s ON s.id = m.session_id
    WHERE m.content LIKE ? ORDER BY m.id DESC LIMIT 10`).all(like), 'AI 对话', (r) => r.t, (r) => `/ai?session=${r._sid}`);
  // 文件存档：文件名 + 解析文字（点击跳文件页）
  collect(tdb.prepare('SELECT id, filename AS t, text_content AS _c, created_at AS _t FROM files WHERE filename LIKE ? OR text_content LIKE ? ORDER BY id DESC LIMIT 10')
    .all(like, like), '文件', (r) => r.t, () => '/files');
  // 账务（v1.9.33 补）：对手方 / 商品 / 备注。金额列不进检索——按关键词搜数字没意义
  collect(tdb.prepare(`SELECT id, COALESCE(NULLIF(counterparty,''), NULLIF(goods,''), '(无对方)') AS t,
    COALESCE(NULLIF(goods,''), NULLIF(remark,''), '') AS _c, COALESCE(NULLIF(pay_time,''), create_time, '') AS _t
    FROM pay_bills WHERE counterparty LIKE ? OR goods LIKE ? OR remark LIKE ? ORDER BY id DESC LIMIT 10`)
    .all(like, like, like), '账务', (r) => r.t);
  return { results: limit > 0 ? out.slice(0, limit) : out };
}

module.exports = { search };
