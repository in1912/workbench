// 笔记关系图谱（v1.9.41）：节点 = 笔记，边 = note_links。
// 后端只负责「把图与度数算准」，枢纽/孤岛/配色/布局全在前端（见 web 的 graphData.js + GraphView）。
// 度数在这里一次算好带上，图例的「集散点 N / 孤岛 N」就不用前端再遍历一遍。
const { folderMap, folderSubtreeIds } = require('./noteService');

// 一组 notes 行 + 边 → 带度数与顶层文件夹分组的节点数组
function buildNodes(tdb, rows, edges, fmap) {
  const inD = new Map(), outD = new Map();
  for (const e of edges) {
    outD.set(e.source, (outD.get(e.source) || 0) + 1);
    inD.set(e.target, (inD.get(e.target) || 0) + 1);
  }
  const map = fmap || folderMap(tdb);
  return rows.map((r) => {
    const id = Number(r.id);
    const f = r.folder_id == null ? null : map.byId.get(Number(r.folder_id));
    // 顶层文件夹名是配色维度（用户决策 5：不用硬字段的笔记类型）
    let top = f;
    let guard = 0;
    while (top && top.parent_id != null && guard++ < 64) {
      const p = map.byId.get(Number(top.parent_id));
      if (!p) break;
      top = p;
    }
    const i = inD.get(id) || 0, o = outD.get(id) || 0;
    return {
      id, title: r.title || '',
      folder_id: r.folder_id == null ? null : Number(r.folder_id),
      folder: f ? f.name : '', folder_path: f ? f.path : '',
      group: top ? top.name : '未归档',
      word_count: Number(r.word_count) || 0,
      in_degree: i, out_degree: o, degree: i + o,
    };
  });
}

// 全局图（可带筛选）。max 封顶节点数，超了如实回 truncated
function buildGraph(tdb, { folderId = null, tag = '', q = '', max = 2000 } = {}) {
  const conds = [], args = [];
  if (folderId) {
    const ids = folderSubtreeIds(tdb, folderId);
    if (!ids.length) return { nodes: [], edges: [], truncated: false, total: 0 };
    conds.push(`folder_id IN (${ids.map(() => '?').join(',')})`);
    args.push(...ids);
  }
  if (tag) { conds.push('id IN (SELECT note_id FROM note_tags WHERE tag=?)'); args.push(tag); }
  if (q) { conds.push('(title LIKE ? OR content LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  const total = tdb.prepare(`SELECT COUNT(*) c FROM notes${where}`).get(...args).c;
  const cap = Math.min(5000, Math.max(1, Number(max) || 2000));
  const rows = tdb.prepare(
    `SELECT id, title, folder_id, word_count FROM notes${where} ORDER BY updated_at DESC LIMIT ?`
  ).all(...args, cap);
  const ids = new Set(rows.map((r) => Number(r.id)));
  const edges = [];
  for (const e of tdb.prepare('SELECT src_note_id s, dst_note_id d FROM note_links').all()) {
    const s = Number(e.s), d = Number(e.d);
    if (ids.has(s) && ids.has(d)) edges.push({ source: s, target: d });
  }
  return { nodes: buildNodes(tdb, rows, edges), edges, truncated: total > rows.length, total };
}

// 局部图：从某条笔记出发走 N 跳（无向）。前端已加载全局图时会自己做 BFS，这个端点
// 供深链（直接打开 /notes?note=X&local=1）与超大库使用。
function localGraph(tdb, noteId, depth = 1, limit = 300) {
  const start = Number(noteId);
  if (!tdb.prepare('SELECT id FROM notes WHERE id=?').get(start)) return null;
  const all = tdb.prepare('SELECT src_note_id s, dst_note_id d FROM note_links').all()
    .map((e) => [Number(e.s), Number(e.d)]);
  const adj = new Map();
  const add = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
  for (const [s, d] of all) { add(s, d); add(d, s); }
  const cap = Math.min(1000, Math.max(1, Number(limit) || 300));
  const dep = Math.min(3, Math.max(1, Number(depth) || 1));
  const seen = new Set([start]);
  let frontier = [start];
  for (let i = 0; i < dep; i++) {
    const next = [];
    for (const n of frontier) {
      for (const m of adj.get(n) || []) {
        if (!seen.has(m) && seen.size < cap) { seen.add(m); next.push(m); }
      }
    }
    frontier = next;
  }
  const ids = [...seen];
  const ph = ids.map(() => '?').join(',');
  const rows = tdb.prepare(`SELECT id, title, folder_id, word_count FROM notes WHERE id IN (${ph})`).all(...ids);
  const edges = all.filter(([s, d]) => seen.has(s) && seen.has(d)).map(([s, d]) => ({ source: s, target: d }));
  return { nodes: buildNodes(tdb, rows, edges), edges, center: start, depth: dep, truncated: seen.size >= cap };
}

module.exports = { buildGraph, localGraph, buildNodes };
