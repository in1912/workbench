// 正则扫描 worker（v1.9.41）：只干一件事——拿主线程给的正则在**自己打开的只读库**上扫一遍，
// 回传命中的 id 列表。
//
// 为什么在 worker 里跑：SQLite 没有内置 REGEXP，扫描只能在 Node 里做；而用户给的正则可能
// 有灾难性回溯（ReDoS）。worker 让主线程可以用 1500ms 定时器直接 terminate() 掐断，
// 主线程不会被卡死。**零新依赖**（node:worker_threads / node:sqlite 都是内置模块）。
//
// 为什么只传库路径不传行数据：笔记正文动辄几百 KB，克隆几 MB 进 worker 比扫描本身还贵。
// worker 自己开只读连接（与 db.js 里的历史库统计同一个用法），消息只有几十字节。
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');

try {
  const { dbPath, sql, params = [], pattern, flags = '', slice = 8000, limit = 500 } = workerData;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  // flags 已在主线程校验过，这里只可能是 i/m/u，不含 g（g 会让 test() 带 lastIndex 状态）
  const re = new RegExp(pattern, flags);
  const rows = db.prepare(sql).all(...params);
  const ids = [];
  for (const r of rows) {
    const t = String(r.title || '').slice(0, slice);
    const c = String(r.content || '').slice(0, slice);
    if (re.test(t) || re.test(c)) {
      ids.push(Number(r.id));
      if (ids.length >= limit) break;
    }
  }
  db.close();
  parentPort.postMessage({ ids, scanned: rows.length });
} catch (e) {
  parentPort.postMessage({ ids: [], error: String((e && e.message) || e) });
}
