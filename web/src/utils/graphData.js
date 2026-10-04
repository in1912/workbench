// 图谱的图论小工具（v1.9.41）——度数、邻接表、BFS 取子图、枢纽/孤岛判定。
//
// 这些都能在前端几毫秒算完（个人库几千条边），不必再往后端加端点：
// 局部聚焦要能瞬时响应，走一趟网络就慢了。

/** 无向邻接表（图谱里 [[a]] 与 a 引用 b 视作同一条关系） */
export function buildAdjacency(edges) {
  const adj = new Map();
  const add = (a, b) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a).add(b); };
  for (const e of edges || []) { add(Number(e.source), Number(e.target)); add(Number(e.target), Number(e.source)); }
  return adj;
}

/** 度数分位（p90）：超过它算「集散点」。样本太少时不标枢纽——三条边也叫枢纽没意义 */
export function degreeStats(nodes) {
  const degs = (nodes || []).map((n) => Number(n.degree) || 0).sort((a, b) => a - b);
  const at = (q) => (degs.length ? degs[Math.min(degs.length - 1, Math.floor(degs.length * q))] : 0);
  const p90 = at(0.9);
  const hubs = new Set();
  if (degs.length >= 12 && p90 >= 3) for (const n of nodes) if ((Number(n.degree) || 0) >= p90) hubs.add(n.id);
  const islands = new Set((nodes || []).filter((n) => (Number(n.degree) || 0) === 0).map((n) => n.id));
  return { p90, hubs, islands, count: degs.length };
}

/** 从 center 出发走 depth 跳的子图（含 center 本身） */
export function subgraph(nodes, edges, centerId, depth = 2) {
  const adj = buildAdjacency(edges);
  const seen = new Set([Number(centerId)]);
  let frontier = [Number(centerId)];
  for (let i = 0; i < Math.max(1, depth); i++) {
    const next = [];
    for (const n of frontier) for (const m of adj.get(n) || []) if (!seen.has(m)) { seen.add(m); next.push(m); }
    frontier = next;
  }
  return {
    nodes: (nodes || []).filter((n) => seen.has(n.id)),
    edges: (edges || []).filter((e) => seen.has(Number(e.source)) && seen.has(Number(e.target))),
  };
}

/** 按顶层文件夹分组 → 稳定配色（同一文件夹永远同色，跟节点顺序无关） */
export function colorOf(group, groups) {
  const list = groups && groups.length ? groups : ['未归档'];
  const i = Math.max(0, list.indexOf(group || '未归档'));
  const hues = [212, 152, 32, 280, 344, 190, 96, 260, 14, 320];
  return `hsl(${hues[i % hues.length]} 62% 58%)`;
}

export function collectGroups(nodes) {
  const set = new Set();
  for (const n of nodes || []) set.add(n.group || '未归档');
  return Array.from(set).sort((a, b) => (a === '未归档' ? 1 : b === '未归档' ? -1 : a.localeCompare(b)));
}
