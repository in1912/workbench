// E2E（v1.9.41）：白板 CRUD / 批量 layout 事务 / 图片上传→附件 / 级联清理 / 附件 / AI 辅助。
import { startServer, login, api, checker, j } from './_noteE2E.mjs';

const { B, stop } = await startServer({ tag: 'board', port: 3975 });
const s = checker();
const L = await login(B, 'admin', 'test123456');
const A = api(B, L.H);
const H = L.H;

// 1x1 透明 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

// multipart 上传（_noteE2E 的 api() 固定发 JSON，这里单独走一份）
const up = async (p, buf, name, type, fields = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
  fd.append('file', new Blob([buf], { type }), name);
  const r = await fetch(B + '/api' + p, { method: 'POST', headers: { Authorization: H.Authorization }, body: fd });
  return { status: r.status, body: await j(r), raw: r };
};
const getRaw = (p) => fetch(B + '/api' + p, { headers: { Authorization: H.Authorization } });

const created = [];
let boardId = null; let attId = null; let noteId = null;

try {
  // ---------- ① 白板 CRUD ----------
  let r = await A.get('/notes/boards');
  s.ck('初始白板列表为空', r.status === 200 && Array.isArray(r.body) && r.body.length === 0, JSON.stringify(r.body).slice(0, 120));

  r = await A.post('/notes/boards', { name: 'E2E白板' });
  boardId = r.body.id;
  s.ck('建白板', r.status === 200 && boardId > 0 && r.body.name === 'E2E白板', JSON.stringify(r.body));
  r = await A.post('/notes/boards', {});
  const board2 = r.body.id;
  s.ck('不传名字给默认名', r.body.name === '新白板', JSON.stringify(r.body));

  r = await A.get(`/notes/boards/${boardId}`);
  s.ck('新白板 viewport 是对象且无卡片', r.body.viewport && r.body.viewport.zoom === 1 && r.body.items.length === 0 && r.body.edges.length === 0,
    JSON.stringify(r.body).slice(0, 200));
  r = await A.get('/notes/boards/999999');
  s.ck('不存在的白板 → 404', r.status === 404, `${r.status}`);

  r = await A.put(`/notes/boards/${boardId}`, { name: 'E2E白板改名', viewport: { x: 10, y: -20, zoom: 1.5 } });
  s.ck('改白板名与视口', r.status === 200, JSON.stringify(r.body));
  r = await A.get(`/notes/boards/${boardId}`);
  s.ck('视口落库并解析回对象', r.body.name === 'E2E白板改名' && r.body.viewport.x === 10 && r.body.viewport.zoom === 1.5, JSON.stringify(r.body.viewport));
  r = await A.put('/notes/boards/999999', { name: 'x' });
  s.ck('改不存在的白板 → 404', r.status === 404, `${r.status}`);

  // ---------- ② 批量 layout（前端 800ms 防抖后整块推） ----------
  r = await A.post('/notes', { title: 'E2E白板卡源', content: '白板上的笔记卡要实时 join 标题。' });
  noteId = r.body.id; created.push(noteId);

  r = await A.put(`/notes/boards/${boardId}/layout`, {
    items: [
      { type: 'note', note_id: noteId, x: 40, y: 60 },
      { type: 'text', text: '这是一张文本卡', x: 300, y: 60, color: '#ffe' },
    ],
  });
  s.ck('批量落盘新卡片', r.status === 200 && r.body.items === 2, JSON.stringify(r.body));

  r = await A.get(`/notes/boards/${boardId}`);
  const items = r.body.items;
  s.ck('卡片带 note 实时标题（活链接不是冻结副本）',
    items.some((i) => i.note_id === noteId && i.note_title === 'E2E白板卡源'), JSON.stringify(items.map((i) => [i.type, i.note_title])));
  s.ck('text 卡原样存下', items.some((i) => i.type === 'text' && i.text === '这是一张文本卡' && i.color === '#ffe'), JSON.stringify(items));
  const noteItem = items.find((i) => i.note_id === noteId);
  const textItem = items.find((i) => i.type === 'text');

  // 带 id 再推一次 = 更新坐标；同时建一条连线
  r = await A.put(`/notes/boards/${boardId}/layout`, {
    items: [
      { id: noteItem.id, type: 'note', note_id: noteId, x: 111, y: 222 },
      { id: textItem.id, type: 'text', text: '这是一张文本卡', x: 300, y: 60 },
    ],
    edges: [{ from_item_id: noteItem.id, to_item_id: textItem.id, label: '相关' }],
    viewport: { x: 5, y: 5, zoom: 2 },
  });
  s.ck('带 id 推送 = 原地更新', r.status === 200, JSON.stringify(r.body));
  r = await A.get(`/notes/boards/${boardId}`);
  s.ck('坐标被更新', r.body.items.find((i) => i.id === noteItem.id).x === 111, JSON.stringify(r.body.items.map((i) => i.x)));
  s.ck('卡片数没变成 4 条', r.body.items.length === 2, String(r.body.items.length));
  s.ck('连线落库带标签', r.body.edges.length === 1 && r.body.edges[0].label === '相关', JSON.stringify(r.body.edges));
  s.ck('layout 会一并存视口', r.body.viewport.zoom === 2, JSON.stringify(r.body.viewport));

  // 删一张卡 → 挂在它身上的连线一起没了
  r = await A.put(`/notes/boards/${boardId}/layout`, {
    items: [{ id: noteItem.id, type: 'note', note_id: noteId, x: 111, y: 222 }],
    removed_items: [textItem.id],
    edges: [],
  });
  s.ck('删卡片', r.status === 200, JSON.stringify(r.body));
  r = await A.get(`/notes/boards/${boardId}`);
  s.ck('卡片只剩 1 张', r.body.items.length === 1, String(r.body.items.length));
  s.ck('消失卡片的连线被连带清掉', r.body.edges.length === 0, JSON.stringify(r.body.edges));

  // 上限
  r = await A.put(`/notes/boards/${boardId}/layout`, { items: Array.from({ length: 501 }, () => ({ type: 'text', text: 'x' })) });
  s.ck('卡片超 500 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  r = await A.put('/notes/boards/999999/layout', { items: [] });
  s.ck('给不存在的白板落盘 → 404', r.status === 404, `${r.status}`);

  // ---------- ③ 删笔记 → 白板卡变空壳，不连带删掉卡片 ----------
  r = await A.del(`/notes/${noteId}`);
  s.ck('删笔记', r.status === 200, JSON.stringify(r.body));
  created.splice(created.indexOf(noteId), 1);
  r = await A.get(`/notes/boards/${boardId}`);
  s.ck('卡片还在但 note_id 被置空、标题没了',
    r.body.items.length === 1 && r.body.items[0].note_id === null && r.body.items[0].note_title === null,
    JSON.stringify(r.body.items));

  // ---------- ④ 往白板贴图（上传 → 附件 → raw） ----------
  r = await up(`/notes/boards/${boardId}/image`, PNG, '点.png', 'image/png', { x: 7, y: 8 });
  attId = r.body.attachment_id;
  s.ck('贴图返回 attachment_id 与 raw 地址', r.status === 200 && attId > 0 && r.body.url === `/api/notes/attachments/${attId}/raw`, JSON.stringify(r.body));

  r = await A.get(`/notes/boards/${boardId}`);
  const img = r.body.items.find((i) => i.type === 'image');
  s.ck('图片卡 join 到文件名', img && img.attachment_id === attId && img.attachment_name === '点.png' && img.w === 260,
    JSON.stringify(r.body.items.map((i) => [i.type, i.attachment_name, i.w])));

  let raw = await getRaw(`/notes/attachments/${attId}/raw`);
  const bytes = Buffer.from(await raw.arrayBuffer());
  s.ck('raw 原样回图（类型 + 字节数）',
    raw.status === 200 && raw.headers.get('content-type') === 'image/png' && bytes.length === PNG.length && bytes.equals(PNG),
    `${raw.status} ${raw.headers.get('content-type')} ${bytes.length}/${PNG.length}`);
  s.ck('raw 带 inline 的 Content-Disposition', /^inline/.test(raw.headers.get('content-disposition') || ''), raw.headers.get('content-disposition'));

  raw = await getRaw('/notes/attachments/999999/raw');
  s.ck('不存在的附件 raw → 404', raw.status === 404, String(raw.status));

  // 附件能挂到笔记上
  r = await up('/notes/attachments', PNG, '配图.png', 'image/png', {});
  const att2 = r.body.id;
  s.ck('附件接口接受 multipart', r.status === 200 && att2 > 0, JSON.stringify(r.body));
  r = await up('/notes/attachments', Buffer.alloc(0), '空.png', 'image/png');
  s.ck('空文件 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

  // 删附件 → 白板卡上的 attachment_id 置空，raw 也不再可用
  r = await A.del(`/notes/attachments/${attId}`);
  s.ck('删附件', r.status === 200 && r.body.ok, JSON.stringify(r.body));
  raw = await getRaw(`/notes/attachments/${attId}/raw`);
  s.ck('删完 raw → 404', raw.status === 404, String(raw.status));
  r = await A.get(`/notes/boards/${boardId}`);
  s.ck('白板图片卡的 attachment_id 被置空', r.body.items.every((i) => i.attachment_id == null), JSON.stringify(r.body.items));
  attId = null;

  // ---------- ⑤ 删笔记连带清附件 ----------
  r = await A.post('/notes', { title: 'E2E带附件的笔记', content: '这篇的附件应该随笔记一起消失。' });
  const noteB = r.body.id; created.push(noteB);
  r = await up('/notes/attachments', PNG, '随笔记走.png', 'image/png', { note_id: noteB });
  const att3 = r.body.id;
  s.ck('附件挂到指定笔记', r.status === 200 && att3 > 0, JSON.stringify(r.body));
  s.ck('挂上后 raw 可用', (await getRaw(`/notes/attachments/${att3}/raw`)).status === 200, '');

  r = await A.del(`/notes/${noteB}`);
  created.splice(created.indexOf(noteB), 1);
  s.ck('删笔记本身成功', r.status === 200, JSON.stringify(r.body));
  const raw3 = await getRaw(`/notes/attachments/${att3}/raw`);
  s.ck('删笔记时附件行与文件一并清掉（raw → 404）', raw3.status === 404, String(raw3.status));

  // ---------- ⑥ 白板级联删除 ----------
  r = await A.put(`/notes/boards/${boardId}/layout`, { items: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }], edges: [] });
  r = await A.del(`/notes/boards/${boardId}`);
  s.ck('删白板', r.status === 200 && r.body.ok, JSON.stringify(r.body));
  r = await A.get(`/notes/boards/${boardId}`);
  s.ck('删完 GET → 404', r.status === 404, `${r.status}`);
  boardId = null;

  r = await A.del(`/notes/boards/${board2}`);
  s.ck('删第二个白板', r.status === 200, JSON.stringify(r.body));

  // ---------- ⑦ AI 辅助：没配模型时明确 400，而不是 500 ----------
  r = await A.post('/notes', { title: 'E2E AI 素材', content: '这是一段用来让 AI 处理的正文，长度足够。' });
  const aiNote = r.body.id; created.push(aiNote);

  r = await A.post(`/notes/${aiNote}/ai-assist`, { action: 'summarize' });
  s.ck('未配置 AI 时 summarize → 400', r.status === 400 && /AI/.test(r.body.error || ''), `${r.status} ${JSON.stringify(r.body)}`);
  r = await A.post(`/notes/${aiNote}/ai-assist`, { action: 'continue' });
  s.ck('未配置 AI 时 continue → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  r = await A.post(`/notes/${aiNote}/ai-assist`, { action: 'translate' });
  s.ck('未配置 AI 时 translate → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  r = await A.post(`/notes/${aiNote}/ai-assist`, { action: '念首诗' });
  s.ck('不支持的 action → 400', r.status === 400 && /action/.test(r.body.error || ''), `${r.status} ${JSON.stringify(r.body)}`);

  r = await A.post('/notes', { title: 'E2E空笔记', content: '' });
  const emptyNote = r.body.id; created.push(emptyNote);
  r = await A.post(`/notes/${emptyNote}/ai-assist`, { action: 'summarize' });
  s.ck('空正文 → 400（在 AI 检查之前就拦下）', r.status === 400 && /正文/.test(r.body.error || ''), `${r.status} ${JSON.stringify(r.body)}`);
  r = await A.post('/notes/999999/ai-assist', { action: 'summarize' });
  s.ck('不存在的笔记 → 404', r.status === 404, `${r.status}`);

  // ---------- ⑧ 权限：没有「笔记」页权限的成员一律 403 ----------
  await A.post('/users', { username: 'board-e2e-noperm', password: 'Np123456', role: 'user', allowed_pages: ['dashboard'] });
  const np = await login(B, 'board-e2e-noperm', 'Np123456');
  const N = api(B, np.H);
  for (const [name, rr] of [
    ['GET /notes/boards', await N.get('/notes/boards')],
    ['POST /notes/boards', await N.post('/notes/boards', { name: 'x' })],
    ['PUT /notes/boards/1/layout', await N.put('/notes/boards/1/layout', { items: [] })],
    ['POST /notes/attachments', await N.post('/notes/attachments', {})],
    ['GET /notes/attachments/1/raw', await N.get('/notes/attachments/1/raw')],
    ['POST /notes/query', await N.post('/notes/query', { text: 'title ~ "x"' })],
    ['GET /notes/timeline', await N.get('/notes/timeline')],
    ['GET /notes/by-day?from=2026-01-01&to=2026-01-02', await N.get('/notes/by-day?from=2026-01-01&to=2026-01-02')],
  ]) {
    s.ck(`无权限打 ${name} 返回 403`, rr.status === 403, String(rr.status));
  }

  // ---------- 清理 ----------
  for (const id of created) await A.del(`/notes/${id}`);
  if (att2) await A.del(`/notes/attachments/${att2}`);
} finally {
  stop();
  s.done();
}
