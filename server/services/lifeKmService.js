// 知识地图（v1.11.0）——lifeOS「知识地图」页签的后端。
//
// 一句话：用户输入「我想获得做什么任务的能力」（一句话目标），交给工作台总配置的 AI
// 生成一棵**技能树**——每个节点带【周期 / 程度 / 成本】，另配一套带元数据的学习资源
// （书籍/文章/规范/论文/开源项目/课程/工具/专家…）、扩展子能力与优势能力、以及一组
// keywords；keywords 用来在用户已有数据里找「知识交集」（lifeOS 实体 / 笔记 / RSS / 邮箱 /
// IM 归档，点击可跳回原文）。
//
// 结构纪律（与 lifeImReviewService 同款）：
//  · AI 生成走**后台任务**（jobs Map，每租户同时一个、只留最近一个）——真实耗时数十秒到
//    数分钟，同步 POST 会被前端/网关超时腰斩；POST /jobs 立即回任务号，轮询拿快照。
//  · AI 输出**加固解析 + 递归 sanitize**：剥代码围栏、截首尾大括号、树形状修复（非法节点
//    丢弃而非整体失败）、深度/节点数/资源数封顶、url 非 http(s) 一律清空（防编造链接）。
//  · 生成成功**直接落库**（life_km_maps，默认未分类文件夹），任务结果只带 map_id。
//
// 知识交集的匹配策略：keywords + 树节点名（≤14 词）做**子串包含**匹配（中文无词边界，
// LIKE 与 includes 等价；先取行再内存匹配，为的是把「命中了哪个词」带回去）。每类限量，
// 匹配不到就给空数组——交集是锦上添花，绝不因为某类数据缺失报错。
const ai = require('./aiService');
const noteService = require('./noteService');

// ---------- 常量（前端下拉/分组的唯一出处，别在前端硬编码） ----------
// radial（v1.11.0 用户补充授权「有其他布局也可添加」）：根在圆心，子树按叶子数分扇区向外发散。
const STYLES = [
  { key: 'mindmap', label: '思维导图', desc: '根在左侧，向右逐层展开' },
  { key: 'treeup', label: '树形向上生长', desc: '根在底部，向上分叉' },
  { key: 'pyramid', label: '金字塔向下扩展', desc: '根在顶部，向下展开' },
  { key: 'sides', label: '左右分别扩展', desc: '根在中间，子树分列左右' },
  { key: 'radial', label: '放射环状', desc: '根在圆心，子树按扇区向外发散' },
];

const RES_TYPES = [
  { key: 'book', label: '书籍' }, { key: 'article', label: '文章' },
  { key: 'standard', label: '规范' }, { key: 'whitepaper', label: '白皮书' },
  { key: 'report', label: '行业报告' }, { key: 'paper', label: '论文' },
  { key: 'patent', label: '专利' },
  { key: 'docs', label: '官方文档' }, { key: 'api', label: 'API 文档' },
  { key: 'opensource', label: '开源项目' }, { key: 'dataset', label: '数据集' },
  { key: 'course', label: '课程' }, { key: 'podcast', label: '播客' },
  { key: 'talk', label: '会议演讲' },
  { key: 'template', label: '模板' }, { key: 'sop', label: 'SOP' },
  { key: 'tool', label: '工具链' }, { key: 'platform', label: '软件平台' },
  { key: 'case', label: '案例库' }, { key: 'retro', label: '复盘库' },
  { key: 'internal', label: '内部文档' }, { key: 'archive', label: '历史项目档案' },
  { key: 'expert', label: '专家导师' }, { key: 'community', label: '社区' },
  { key: 'forum', label: '论坛' }, { key: 'cert', label: '认证' },
];
const RES_LABEL = Object.fromEntries(RES_TYPES.map((t) => [t.key, t.label]));

function bad(msg) { const e = new Error(msg); e.code = 400; return e; }
function conflict(msg, counts) { const e = new Error(msg); e.code = 409; e.counts = counts; return e; }
const s = (v, cap = 200) => String(v == null ? '' : v).trim().slice(0, cap);

// ---------- 文件夹树 ----------
/** 全部文件夹 → 树（每节点带 map_count 直属地图数与 map_total 含子孙数）。 */
function folderTree(tdb) {
  const folders = tdb.prepare('SELECT * FROM life_km_folders ORDER BY sort_order, id').all();
  const counts = new Map();
  for (const r of tdb.prepare('SELECT folder_id, count(*) n FROM life_km_maps GROUP BY folder_id').all()) {
    counts.set(r.folder_id == null ? null : Number(r.folder_id), Number(r.n));
  }
  const kids = new Map();
  for (const f of folders) {
    const p = f.parent_id == null ? null : Number(f.parent_id);
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(f);
  }
  const mk = (f, depth) => {
    if (depth > 32) return null;   // 环保护：脏数据不许把递归挂死
    const children = (kids.get(Number(f.id)) || []).map((c) => mk(c, depth + 1)).filter(Boolean);
    const own = counts.get(Number(f.id)) || 0;
    const total = own + children.reduce((a, c) => a + c.map_total, 0);
    return { id: Number(f.id), name: f.name, parent_id: f.parent_id == null ? null : Number(f.parent_id),
      map_count: own, map_total: total, children };
  };
  return (kids.get(null) || []).map((f) => mk(f, 0)).filter(Boolean);
}

function folderIds(tdb, rootId) {   // 含自己；不存在返回 []
  const all = tdb.prepare('SELECT id, parent_id FROM life_km_folders').all();
  const kids = new Map();
  for (const f of all) {
    const p = f.parent_id == null ? null : Number(f.parent_id);
    if (!kids.has(p)) kids.set(p, []);
    kids.get(p).push(Number(f.id));
  }
  const out = [];
  (function walk(n) { out.push(n); for (const c of kids.get(n) || []) walk(c); })(Number(rootId));
  return out;
}

function createFolder(tdb, body) {
  const name = s(body.name, 60);
  if (!name) throw bad('文件夹名不能为空');
  let parentId = null;
  if (body.parent_id != null && body.parent_id !== '') {
    parentId = Number(body.parent_id);
    if (!tdb.prepare('SELECT id FROM life_km_folders WHERE id=?').get(parentId)) throw bad('父文件夹不存在');
  }
  const r = tdb.prepare('INSERT INTO life_km_folders(name, parent_id) VALUES(?,?)').run(name, parentId);
  return Number(r.lastInsertRowid);
}

function renameFolder(tdb, id, body) {
  const row = tdb.prepare('SELECT * FROM life_km_folders WHERE id=?').get(Number(id));
  if (!row) return null;
  const name = s(body.name, 60);
  if (!name) throw bad('文件夹名不能为空');
  let parentId = row.parent_id == null ? null : Number(row.parent_id);
  if (body.parent_id !== undefined) {
    parentId = body.parent_id == null || body.parent_id === '' ? null : Number(body.parent_id);
    if (parentId != null) {
      if (parentId === Number(id)) throw bad('不能把文件夹移动到自己下面');
      if (folderIds(tdb, Number(id)).includes(parentId)) throw bad('不能把文件夹移动到它自己的子文件夹里');
      if (!tdb.prepare('SELECT id FROM life_km_folders WHERE id=?').get(parentId)) throw bad('目标文件夹不存在');
    }
  }
  tdb.prepare('UPDATE life_km_folders SET name=?, parent_id=? WHERE id=?').run(name, parentId, Number(id));
  return { ok: true };
}

/** 删除空文件夹。有子文件夹 → 409 不可删；有地图 → 409 报数，force=1 把地图挪到未分类再删。 */
function deleteFolder(tdb, id, { force = false } = {}) {
  const row = tdb.prepare('SELECT * FROM life_km_folders WHERE id=?').get(Number(id));
  if (!row) return null;
  const kids = tdb.prepare('SELECT count(*) n FROM life_km_folders WHERE parent_id=?').get(Number(id));
  if (Number(kids.n) > 0) throw conflict('该文件夹下还有子文件夹，先删或移走它们', { subfolders: Number(kids.n) });
  const maps = tdb.prepare('SELECT count(*) n FROM life_km_maps WHERE folder_id=?').get(Number(id));
  if (Number(maps.n) > 0 && !force) {
    throw conflict(`该文件夹下还有 ${maps.n} 张知识地图：确认删除会把它们挪到「未分类」`, { maps: Number(maps.n) });
  }
  if (Number(maps.n) > 0) tdb.prepare('UPDATE life_km_maps SET folder_id=NULL WHERE folder_id=?').run(Number(id));
  tdb.prepare('DELETE FROM life_km_folders WHERE id=?').run(Number(id));
  return { ok: true, moved_maps: Number(maps.n) };
}

// ---------- 地图 CRUD ----------
function parseTree(t) {
  try { return JSON.parse(String(t || '{}')); } catch { return {}; }
}

function listMaps(tdb, { folder_id } = {}) {
  const rows = folder_id === undefined
    ? tdb.prepare('SELECT id,title,goal_text,folder_id,style,model,created_at,updated_at FROM life_km_maps ORDER BY updated_at DESC').all()
    : tdb.prepare('SELECT id,title,goal_text,folder_id,style,model,created_at,updated_at FROM life_km_maps WHERE folder_id=? ORDER BY updated_at DESC')
        .all(folder_id == null || folder_id === '' ? null : Number(folder_id));
  return rows.map((r) => ({ ...r, id: Number(r.id), folder_id: r.folder_id == null ? null : Number(r.folder_id) }));
}

function getMap(tdb, id) {
  const r = tdb.prepare('SELECT * FROM life_km_maps WHERE id=?').get(Number(id));
  if (!r) return null;
  return { ...r, id: Number(r.id), folder_id: r.folder_id == null ? null : Number(r.folder_id), tree: parseTree(r.tree) };
}

function updateMap(tdb, id, body) {
  const cur = tdb.prepare('SELECT * FROM life_km_maps WHERE id=?').get(Number(id));
  if (!cur) return null;
  const title = body.title !== undefined ? s(body.title, 120) : cur.title;
  if (!title) throw bad('标题不能为空');
  let folderId = cur.folder_id == null ? null : Number(cur.folder_id);
  if (body.folder_id !== undefined) {
    folderId = body.folder_id == null || body.folder_id === '' ? null : Number(body.folder_id);
    if (folderId != null && !tdb.prepare('SELECT id FROM life_km_folders WHERE id=?').get(folderId)) throw bad('目标文件夹不存在');
  }
  const style = body.style !== undefined ? (STYLES.some((x) => x.key === body.style) ? body.style : cur.style) : cur.style;
  tdb.prepare(`UPDATE life_km_maps SET title=?, folder_id=?, style=?, updated_at=datetime('now','localtime') WHERE id=?`)
    .run(title, folderId, style, Number(id));
  return getMap(tdb, id);
}

function deleteMap(tdb, id) {
  const r = tdb.prepare('DELETE FROM life_km_maps WHERE id=?').run(Number(id));
  return Number(r.changes) > 0;
}

// ---------- AI 产物 sanitize（形状修复；非法片段丢弃而非整体失败） ----------
const str = (v, cap) => (typeof v === 'string' ? v.trim().slice(0, cap) : (v == null ? '' : String(v).trim().slice(0, cap)));
const URL_RE = /^https?:\/\/\S+$/i;

/** 树节点：非法（无名字）丢弃；深度 ≤4、每层 ≤6 子、全树 ≤40 节点。返回 null=整棵没救。 */
function sanitizeNode(node, depth, budget) {
  if (!node || typeof node !== 'object') return null;
  const name = str(node.name, 60);
  if (!name) return null;
  if (budget.left <= 0 || depth > 4) return { name, cycle: '', level: '', cost: '', note: '', children: [] };
  budget.left--;
  const out = {
    name,
    cycle: str(node.cycle, 40),
    level: str(node.level, 16),
    cost: str(node.cost, 60),
    note: str(node.note, 160),
    children: [],
  };
  if (Array.isArray(node.children)) {
    for (const c of node.children.slice(0, 6)) {
      const k = sanitizeNode(c, depth + 1, budget);
      if (k) out.children.push(k);
    }
  }
  return out;
}

function sanitizeResources(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list.slice(0, 30)) {
    if (!r || typeof r !== 'object') continue;
    const title = str(r.title, 120);
    if (!title) continue;
    const url = URL_RE.test(str(r.url, 300)) ? str(r.url, 300) : '';   // 不像链接的一律清空，绝不展示编造地址
    out.push({
      type: RES_LABEL[r.type] ? r.type : 'article',
      title, url,
      author: str(r.author, 80), source: str(r.source, 80), version: str(r.version, 40),
      difficulty: str(r.difficulty, 16), prereq: str(r.prereq, 80), stage: str(r.stage, 60),
      credibility: str(r.credibility, 40), license: str(r.license, 60), skill: str(r.skill, 60),
    });
  }
  return out;
}

// ---------- LLM 输出修复解析（v1.11.1，生产 deepseek-flash 连续两次「不是合法 JSON」后加） ----------
// 真实模型两类高频病：① 被 max_tokens 截断——停在半个字符串/半个对象上，lastIndexOf('}')
//   截出的片段必炸；② 尾逗号（",}" / ",]"）。都修；修不好才抛（调用方决定重试）。
const tryParse = (t) => { try { return JSON.parse(t); } catch { return undefined; } };

/** 去掉字符串外的尾逗号（,} / ,]）：扫描时跟踪 in-string/escape，绝不碰字符串内容。
 *  连续逗号（,,}）一趟清不干净，有界多趟。 */
function stripTrailingCommas(text) {
  for (let pass = 0; pass < 4; pass++) {
    const drop = [];
    let inStr = false, esc = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === '}' || c === ']') {
        let j = i - 1;
        while (j >= 0 && /\s/.test(text[j])) j--;
        if (j >= 0 && text[j] === ',') drop.push(j);
      }
    }
    if (!drop.length) return text;
    let out = '', last = 0;
    for (const d of drop) { out += text.slice(last, d); last = d + 1; }
    text = out + text.slice(last);
  }
  return text;
}

/** 截断补全：字符串中途断 → 闭引号（悬空反斜杠先摘）；悬空键值（"key": 后没值）→ 逐字符回退重试。 */
function closeTruncated(t) {
  const scan = (s) => {
    const stack = [];
    let inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') { inStr = false; stack.pop(); }
        continue;
      }
      if (c === '"') { inStr = true; stack.push('"'); }
      else if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' || c === ']') {
        for (let j = stack.length - 1; j >= 0; j--) if (stack[j] !== '"') { stack.length = j; break; }
      }
    }
    return { stack, inStr, esc };
  };
  for (let trim = 0; trim <= 400; trim++) {
    const base = (trim ? t.slice(0, t.length - trim) : t).replace(/[\s,]+$/, '');
    if (!base.includes('{')) return undefined;
    const st = scan(base);
    let fixed = base;
    if (st.inStr) {
      if (st.esc) fixed = fixed.slice(0, -1);   // 摘掉悬空反斜杠，闭合引号才不会被转义
      fixed += '"';
    }
    fixed = fixed.replace(/[\s,]+$/, '');
    let out = fixed;
    const st2 = scan(out);
    for (let j = st2.stack.length - 1; j >= 0; j--) if (st2.stack[j] !== '"') out += st2.stack[j] === '{' ? '}' : ']';
    const parsed = tryParse(out);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/** AI 原文 → { obj, repaired }：围栏 / 尾逗号 / 截断三重抢救；全部失败返回 undefined。 */
function hardParseJson(raw) {
  const t = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const i = t.indexOf('{');
  if (i < 0) return undefined;
  const e = t.lastIndexOf('}');
  const body = e > i ? t.slice(i, e + 1) : t.slice(i);
  let o = tryParse(body) ?? tryParse(t.slice(i));
  if (o !== undefined) return { obj: o, repaired: null };
  o = tryParse(stripTrailingCommas(body));
  if (o !== undefined) return { obj: o, repaired: 'commas' };
  o = closeTruncated(stripTrailingCommas(t.slice(i)));   // 截断时 lastIndexOf('}') 丢后半截，补全要从全文做起
  if (o !== undefined) return { obj: o, repaired: 'truncated' };
  return undefined;
}

/** AI 原文 → { tree, repaired }。root 修不出来才抛（调用方决定重试）。 */
function parseTreeJson(raw) {
  const parsed = hardParseJson(raw);
  if (!parsed) throw bad('AI 返回的不是合法 JSON，请重试一次');
  const o = parsed.obj;
  const budget = { left: 40 };
  const root = sanitizeNode(o.root, 1, budget);
  if (!root || (!root.children.length && !root.note)) throw bad('AI 没有给出可用的技能树（root 为空），请重试');
  const keywords = [];
  if (Array.isArray(o.keywords)) {
    for (const k of o.keywords) {
      const w = str(k, 20);
      if (w.length >= 2 && !keywords.includes(w)) keywords.push(w);
      if (keywords.length >= 16) break;
    }
  }
  // 树节点名补进 keywords（交集检索的另一半语料）
  (function collect(n) {
    if (n.name.length >= 2 && !keywords.includes(n.name)) keywords.push(n.name.slice(0, 20));
    for (const c of n.children || []) collect(c);
  })(root);
  return {
    tree: {
      title: str(o.title, 60),
      summary: str(o.summary, 500),
      root,
      resources: sanitizeResources(o.resources),
      subskills: (Array.isArray(o.subskills) ? o.subskills : []).slice(0, 12)
        .map((x) => typeof x === 'string' ? { name: str(x, 60), why: '' } : { name: str(x && x.name, 60), why: str(x && x.why, 200) })
        .filter((x) => x.name),
      advantages: (Array.isArray(o.advantages) ? o.advantages : []).slice(0, 10).map((x) => str(x, 160)).filter(Boolean),
      keywords: keywords.slice(0, 24),
      recommended_style: STYLES.some((x) => x.key === o.recommended_style) ? o.recommended_style : '',
    },
    repaired: parsed.repaired,
  };
}

// ---------- AI 生成任务（每租户同时一个，只留最近一个；内存态，重启即清） ----------
const jobs = new Map();   // tenantKey → job
let jobSeq = 0;

// v1.11.2 起提示词分三层组装：PROMPT_MODEL 是「知识地图&技能图谱构建引擎」的固化构建模型
// （用户 2026-10-06 提供模板接入：节点四要素 + 资源 7 大类 + 元数据必填 + 六条约束），
// 后端 runJob（= MODEL + JSON 契约）与「📋 获得提示词」外部旁路（= MODEL + Markdown/JSON 输出格式）
// 共用同一份模型——两处口径必然一致，改模型两边自动同步。
const PROMPT_MODEL = [
  '你是「知识地图 & 技能图谱构建引擎」。把用户的一句话学习目标，拆解成可执行、可验收、成本透明的技能学习地图。',
  '按下面五步构建（内部分析用，不要把步骤本身输出）：',
  '① 目标解析：这项能力由哪些大类技能构成、学习主线怎么走；',
  '② 技能拆解：一级大类 3~5 个，每类下具体技能 2~4 个（树 2~3 层、总节点 10~25 个），先修技能排在依赖它的技能之前；',
  '③ 逐节点定四要素：【周期】【程度】【成本】【前置依赖】；',
  '④ 资源检索：给关键技能配学习资源——实体书籍优先、权威来源优先；',
  '⑤ 依赖校验：砍掉超纲与循环依赖的节点，核对资源真实存在。',
  '',
  '节点四要素规范：',
  '- cycle 周期：分阶段紧凑给出（如「入门 8 小时/练习 4 周/实战 6 周」，16 字以内），单位用小时或周；',
  '- level 程度：了解 / 掌握 / 熟练 / 精通 四档之一；',
  '- cost 成本：免费 或金额区间（如 0～500 元），软件 / 课程 / 认证支出分开写清；',
  '- note 验收标准：可检验——学会后能独立做成什么（如「能独立完成一次 X 并通过 Y 的验收」），不写空话；',
  '  前置依赖体现在树的位置上（先修在前）；节点确有树外前置时写在 note 开头（「前置：…」）。',
  '',
  '资源分类体系固定 7 大类（资源 type 只能取下列值，不能自创大类）：',
  '· 文献读物：book 书籍 / article 文章 / standard 规范 / whitepaper 白皮书 / report 行业报告 / paper 论文 / patent 专利',
  '· 技术文档：docs 官方文档 / api API 文档',
  '· 开源资产：opensource 开源项目 / dataset 数据集',
  '· 音视频课程：course 课程 / podcast 播客 / talk 会议演讲',
  '· 工程模板：template 模板 / sop SOP / tool 工具链 / platform 软件平台',
  '· 项目案例：case 案例库 / retro 复盘库 / internal 内部文档 / archive 历史项目档案',
  '· 人际与认证：expert 专家导师 / community 社区 / forum 论坛 / cert 认证',
  '',
  '资源元数据全部必填，缺失写「未知」（url 除外，见下）：',
  'title 资源名称（实体书籍一律写《书名》，必须是真实出版的书）/ source 来源 / author 作者 /',
  'version 版本（无链接的写「无」）/ url 链接（真实存在的才填，不确定给空字符串，绝不编造）/',
  'difficulty 难度等级：入门 / 初级 / 中级 / 高级 / 专家 / prereq 先修要求（没有写「无」）/',
  'stage 适用阶段：入门 / 练习 / 实战 / credibility 可信度：高 / 中 / 低，后接一句理由 / license 版权说明（公开 / 付费 / 开源等）。',
  '',
  '约束规则：',
  '1. 先修排前：任何技能不得排在其前置技能之前；',
  '2. 程度可落地验收：每条验收标准要能被第三方检验；',
  '3. 成本如实：免费就写免费，付费给区间；',
  '4. 资源权威真实：书籍与课程给真实存在、业界公认的；不确定就换你确定的，绝不编造书名 / 作者 / 版本 / 链接；',
  '5. 参考书籍加权：book 类资源不少于全部资源的四分之一，优先经典教材与公认著作；',
  '6. 资源总量 10~20 条，7 大类至少覆盖 4 类，书籍 / 文档 / 课程 / 开源项目尽量各有覆盖。',
].join('\n');

// JSON 结构契约（后端解析用这份骨架；外部版也复用它当「JSON 附件」的格式说明）
const PROMPT_JSON = [
  '{',
  '  "title": "地图标题，10 字以内",',
  '  "summary": "总述：这项能力由什么构成、学习主线怎么走，120 字以内",',
  '  "root": {',
  '    "name": "能力总名（如：独立开发并上线一个 Web 应用）",',
  '    "cycle": "总周期（如：3 个月 / 约 120 小时）", "level": "入门/熟练/精通",',
  '    "cost": "总成本（如：0～500 元）", "note": "一句话总说明",',
  '    "children": [',
  '      { "name": "第一阶段或大类（3~5 个）", "cycle": "…", "level": "了解/掌握/熟练/精通", "cost": "…", "note": "验收标准",',
  '        "children": [ { "name": "具体技能（每类 2~4 个）", "cycle": "…", "level": "…", "cost": "…", "note": "…" } ] }',
  '    ]',
  '  },',
  '  "resources": [',
  '    { "type": "类型（上面 7 大类里选）", "title": "资源名（实体书籍用《书名》）", "author": "作者/机构", "source": "来源",',
  '      "version": "版本/年份", "url": "链接（不确定给空字符串）",',
  '      "difficulty": "入门/初级/中级/高级/专家", "prereq": "先修要求", "stage": "入门/练习/实战",',
  '      "credibility": "高/中/低+一句理由", "license": "版权/许可", "skill": "挂靠的技能名（对应树节点 name）" }',
  '  ],',
  '  "subskills": [ { "name": "完成该目标还需要补的子能力", "why": "为什么需要（一句话）" } ],',
  '  "advantages": [ "学成后可迁移的优势能力，一句话一条" ],',
  '  "keywords": ["8~15 个用于检索的关键词或短语（技能名、技术名词、领域术语）"],',
  '  "recommended_style": "最适合展示这棵树的风格：mindmap/treeup/pyramid/sides/radial 之一"',
  '}',
].join('\n');

// 内部版：后端 runJob 用（解析 JSON 落库）
const PROMPT_SCHEMA = PROMPT_MODEL + '\n\n输出要求：严格按下面结构输出一个 JSON 对象本身（不要 markdown 代码围栏、不要解释、不要思考过程）：\n\n'
  + PROMPT_JSON;

// 外部版：「📋 获得提示词」按钮下发（meta.prompt_template）——给外部 AI 工具用，
// 按「Markdown 技能树 + 资源表 + 图谱说明 + JSON 附件」输出，人直接可读；JSON 附件结构同内部版。
const PROMPT_EXTERNAL = PROMPT_MODEL + '\n\n输出格式（按顺序四段）：\n'
  + '1. Markdown 技能树：缩进列表展示整棵树，每个节点后标注【周期】【程度】【成本】，节点有树外前置的用「← 前置：X」标出；\n'
  + '2. 学习资源表：按 7 大类分组的 Markdown 表格，列 = 资源名称/作者/来源/版本·链接/难度/先修/适用阶段/可信度/版权/挂靠技能；\n'
  + '3. 图谱说明：依赖关系、建议学习顺序、主要风险（各一两句）；\n'
  + '4. JSON 附件：完整输出下面结构的 JSON（便于导回知识地图类工具），放在最后一个代码块里：\n\n'
  + PROMPT_JSON;

function log(job, msg) {
  job.logs.push({ t: Date.now(), msg });
  if (job.logs.length > 200) job.logs.splice(0, job.logs.length - 200);
}

function snapshot(job) {
  const waited = (Date.now() - job.ai_started_at) / 1000;
  const est = Math.max(25, job.ai_estimate_s || 45);
  const progress = job.state === 'running' && job.stage === 'ai'
    ? Math.round(Math.min(95, 5 + 90 * (1 - Math.exp(-waited / est))))
    : job.progress;
  return {
    id: job.id, state: job.state, stage: job.stage, stage_label: job.stage_label,
    progress, goal_text: job.goal_text,
    started_at: job.started_at, finished_at: job.finished_at,
    error: job.error, result: job.result, logs: job.logs.slice(),
  };
}

function startJob(tdb, tenantKey, body) {
  const goal = s(body.goal_text, 500);
  if (goal.length < 4) throw bad('先用一句话说清你想获得什么能力（至少 4 个字），例如「能独立完成一个家庭 NAS 的部署与运维」');
  if (!ai.hasConfig(tdb)) throw bad('AI 尚未配置：请先在「设置 → AI 模型」里填写模型名称 / API 地址 / API Key');
  const running = jobs.get(tenantKey);
  if (running && running.state === 'running') return { ...snapshot(running), resumed: true };
  const job = {
    id: ++jobSeq, state: 'running', stage: 'ai', stage_label: 'AI 构建技能树', progress: 3,
    goal_text: goal, started_at: Date.now(), finished_at: null, error: null, result: null,
    logs: [], ai_started_at: Date.now(), ai_estimate_s: 60, _tdb: tdb,
  };
  jobs.set(tenantKey, job);
  log(job, `目标：${goal}`);
  runJob(job).catch((e) => { job.state = 'error'; job.error = e && e.message; job.finished_at = Date.now(); });
  return snapshot(job);
}

async function runJob(job) {
  const tdb = job._tdb;
  try {
    const model = ai.getConfig(tdb).model || '';
    log(job, `调用 AI（${model}）生成技能树…大目标可能要 1~3 分钟，可离开本页，任务在后台继续`);
    const NUDGE = '\n\n（注意：你上一次的输出不是合法 JSON。这一次从第一个字符起就只输出一个 JSON 对象本身——不要 markdown 代码围栏、不要解释、不要思考过程；把每段文字压短：summary ≤ 60 字、note ≤ 20 字，整份 JSON 控制在 3000 字以内。）';
    let tree = null, usedModel = '', usage = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const t0 = Date.now();
      if (attempt > 1) log(job, '输出不是合法 JSON，自动重试一次（换更严格的 JSON 指令）…');
      const { content, model: m, usage: u, finish_reason: finish } = await ai.chatEx([
        { role: 'system', content: '你是「知识地图 & 技能图谱构建引擎」，精通各类技能的学习路径设计。严格按用户要求的 JSON 结构输出，只输出一个 JSON 对象本身，不要 markdown 代码围栏，不要任何解释。' },
        { role: 'user', content: PROMPT_SCHEMA + (attempt > 1 ? NUDGE : '') + `\n\n（学习目标）\n${job.goal_text}` },
      ], { maxTokens: 8000, temperature: 0.4, tdb });
      if (job.state === 'cancelled') { log(job, 'AI 已返回但任务已取消——结果丢弃'); return; }
      usedModel = m; usage = u;
      const outTok = u && (u.completion_tokens ?? u.total_tokens) != null ? (u.completion_tokens ?? u.total_tokens) : '?';
      log(job, `AI 返回：耗时 ${((Date.now() - t0) / 1000).toFixed(1)} 秒 · 输出 ${outTok} tokens · finish=${finish || '?'}（${m}）`);
      try {
        const r = parseTreeJson(content);
        tree = r.tree;
        if (r.repaired === 'truncated') log(job, '输出疑似被截断——已自动补全闭合括号，解析成功');
        else if (r.repaired === 'commas') log(job, '输出带尾逗号——已自动修复，解析成功');
        break;
      } catch (e) {
        if (attempt === 2) {
          // 失败原因分型：截断 / 没按 JSON 回答（拒答或散文）/ 其他，别再一律「不是合法 JSON」
          if (finish === 'length') throw bad('AI 输出被长度上限截断（finish=length）、自动补全也没救回来——把目标拆小一点再试，或重试一次');
          if (!String(content).includes('{')) throw bad('AI 没有按 JSON 格式回答（多半是拒答了这个目标或输出了散文，开头已记入任务日志）——换个措辞描述目标再试');
          throw e;
        }
        log(job, `第 ${attempt} 次输出解析失败（${e.message.slice(0, 60)}）· finish=${finish || '?'} · 开头：${String(content).slice(0, 60).replace(/\s+/g, ' ')} … 结尾：… ${String(content).slice(-60).replace(/\s+/g, ' ')}`);
      }
    }
    // 落库（默认「未分类」）。token 用量随 tree JSON 落库（v1.11.2：地图要带「模型/用量/生成时间」，
    // model 列与 created_at 列已有，usage 挂进 tree 里读出来就是同一份）
    job.stage = 'save'; job.stage_label = '保存地图'; job.progress = 97;
    const title = tree.title || (job.goal_text.length > 24 ? job.goal_text.slice(0, 24) + '…' : job.goal_text);
    if (usage && typeof usage === 'object') {
      tree.usage = {
        prompt_tokens: usage.prompt_tokens ?? null,
        completion_tokens: usage.completion_tokens ?? null,
        total_tokens: usage.total_tokens ?? null,
      };
    }
    const r = tdb.prepare(
      'INSERT INTO life_km_maps(title, goal_text, folder_id, tree, style, model) VALUES(?,?,?,?,?,?)'
    ).run(title, job.goal_text, null, JSON.stringify(tree), tree.recommended_style || 'mindmap', usedModel);
    const mapId = Number(r.lastInsertRowid);
    const nodeCount = (function cnt(n) { return 1 + (n.children || []).reduce((a, c) => a + cnt(c), 0); })(tree.root);
    log(job, `已保存：《${title}》· 技能节点 ${nodeCount} 个 · 资源 ${tree.resources.length} 条 · 子能力 ${tree.subskills.length} 项`);
    job.result = {
      map_id: mapId, title, node_count: nodeCount, resources: tree.resources.length,
      subskills: tree.subskills.length, model: usedModel, usage,
    };
    job.state = 'done'; job.stage = 'done'; job.stage_label = '完成'; job.progress = 100;
    job.finished_at = Date.now();
  } catch (e) {
    if (job.state === 'cancelled') { log(job, '任务已取消（后续错误不再展示）'); return; }
    job.state = 'error'; job.error = (e && e.message) || String(e); job.finished_at = Date.now();
    log(job, `出错：${job.error}`);
  }
}

function getJob(tenantKey) {
  const job = jobs.get(tenantKey);
  return job ? snapshot(job) : null;
}

function cancelJob(tenantKey) {
  const job = jobs.get(tenantKey);
  if (!job || job.state !== 'running') return { ok: false, state: job ? job.state : 'none' };
  job.state = 'cancelled'; job.stage_label = '已取消'; job.finished_at = Date.now();
  log(job, '已取消（如在途的 AI 调用稍后返回，结果将丢弃）');
  return { ok: true, state: 'cancelled' };
}

// ---------- 知识交集（五类定向检索，点击跳回原文） ----------
// 每类返回 { items: [{ id, title, why, jump }], total }；words 是命中词表（去重、限量）。
const LINK_SOURCES = [
  { key: 'lifeos', label: 'lifeOS（目标/行动/习惯/复盘/项目）', jump: (kind, id) => {
    const tab = { goal: 'goals', action: 'actions', habit: 'habits', review: 'reviews', project: 'projects' }[kind] || 'today';
    return `/life?tab=${tab}`;
  } },
  { key: 'notes', label: '笔记（不含 IM 连接）', jump: (kind, id) => `/notes?note=${id}` },
  { key: 'news', label: 'RSS 新闻', jump: () => '/news' },
  { key: 'email', label: '邮箱', jump: () => '/email' },
  { key: 'im', label: 'IM 连接聊天记录', jump: (kind, id) => `/notes?note=${id}` },
];

/** IM 子树判定：文件夹名「IM连接」的整棵子树（与 imService 的落地目录约定一致）。 */
function imFolderIds(tdb) {
  const map = noteService.folderMap(tdb);
  const out = [];
  (function walk(nodes) {
    for (const n of nodes) {
      if (n.name === 'IM连接') { (function sub(x) { out.push(x.id); (x.children || []).forEach(sub); })(n); }
      else walk(n.children || []);
    }
  })(map.roots);
  return out;
}

// 命中词表；一个都没中返回 null（不是 []——空数组是 truthy，`hitWords(a) || hitWords(b)`
// 会短路成 []，导致第二路（摘要/描述字段）永远搜不到）
function hitWords(text, words) {
  const t = String(text || '');
  const hit = [];
  for (const w of words) if (t.includes(w)) hit.push(w);
  return hit.length ? hit : null;
}

function searchLinks(tdb, mapId) {
  const row = tdb.prepare('SELECT * FROM life_km_maps WHERE id=?').get(Number(mapId));
  if (!row) return null;
  const tree = parseTree(row.tree);
  const words = (tree.keywords || []).slice(0, 14);
  const groups = [];
  const push = (key, items) => {
    const def = LINK_SOURCES.find((x) => x.key === key);
    groups.push({ key, label: def.label, items: items.slice(0, 20), total: items.length });
  };
  if (words.length) {
    // ① lifeOS 五类实体
    const lifeos = [];
    const scan = (sql, kind, titleKey, extraKeys) => {
      for (const r of tdb.prepare(sql).all()) {
        const hit = hitWords(r[titleKey], words) || hitWords((extraKeys || []).map((k) => r[k]).join(' '), words);
        if (hit) lifeos.push({ kind, id: Number(r.id), title: String(r[titleKey] || '').slice(0, 80), why: hit[0] });
      }
    };
    scan('SELECT id,title,description FROM life_goals', 'goal', 'title', ['description']);
    scan('SELECT id,title,desc FROM todos', 'action', 'title', ['desc']);
    scan('SELECT id,title FROM life_habits WHERE archived=0', 'habit', 'title', []);
    scan('SELECT id,did_well,did_bad,learned,next_action,type,period_key FROM life_reviews', 'review', 'learned', ['did_well', 'did_bad', 'next_action']);
    scan('SELECT id,title,description FROM life_projects', 'project', 'title', ['description']);
    // 复盘标题显示周期而不是 learned 片段
    for (const it of lifeos) if (it.kind === 'review') {
      const r = tdb.prepare('SELECT type, period_key FROM life_reviews WHERE id=?').get(it.id);
      it.title = `${{ day: '日', week: '周', month: '月', quarter: '季', year: '年' }[r && r.type] || '复盘'}复盘 ${r ? r.period_key : ''}`;
    }
    push('lifeos', lifeos);

    // ② + ⑤ 笔记：标题/摘要命中，按是否 IM 子树分两组
    const imIds = new Set(imFolderIds(tdb));
    const notes = [], ims = [];
    for (const r of tdb.prepare('SELECT id,title,summary,folder_id FROM notes ORDER BY updated_at DESC LIMIT 2000').all()) {
      const hit = hitWords(r.title, words) || hitWords(r.summary, words);
      if (!hit) continue;
      const item = { kind: 'note', id: Number(r.id), title: String(r.title || '').slice(0, 80) || '（无标题）', why: hit[0] };
      (r.folder_id != null && imIds.has(Number(r.folder_id)) ? ims : notes).push(item);
    }
    push('notes', notes);
    push('im', ims);

    // ③ RSS 新闻（只扫最近 800 条，交集是锦上添花不值得全表）
    const news = [];
    for (const r of tdb.prepare('SELECT id,title,summary FROM news ORDER BY id DESC LIMIT 800').all()) {
      const hit = hitWords(r.title, words) || hitWords(r.summary, words);
      if (hit) news.push({ kind: 'news', id: Number(r.id), title: String(r.title || '').slice(0, 100), why: hit[0] });
    }
    push('news', news);

    // ④ 邮件（同上，最近 800 封）
    const mails = [];
    for (const r of tdb.prepare('SELECT id,subject,from_addr,snippet FROM emails ORDER BY id DESC LIMIT 800').all()) {
      const hit = hitWords(r.subject, words) || hitWords(`${r.from_addr} ${r.snippet}`, words);
      if (hit) mails.push({ kind: 'email', id: Number(r.id), title: String(r.subject || '').slice(0, 100) || '（无主题）', why: hit[0] });
    }
    push('email', mails);
  }
  const src = LINK_SOURCES.reduce((m, x) => ((m[x.key] = x), m), {});
  for (const g of groups) for (const it of g.items) it.jump = src[g.key].jump(it.kind, it.id);
  return { words, groups };
}

function meta(tdb) {
  // prompt_template：固化的导图框架提示词（单一出处，v1.11.2 起下发外部版——Markdown 树 +
  // 资源表 + 图谱说明 + JSON 附件，与后端 runJob 共用 PROMPT_MODEL 构建模型）。前端
  // 「📋 获得提示词」按钮拿它拼上用户的目标，复制出去粘到外部 AI 工具按同一模型生成导图。
  return { styles: STYLES, res_types: RES_TYPES, has_ai: ai.hasConfig(tdb), prompt_template: PROMPT_EXTERNAL };
}

module.exports = {
  STYLES, RES_TYPES, RES_LABEL,
  folderTree, createFolder, renameFolder, deleteFolder,
  listMaps, getMap, updateMap, deleteMap,
  startJob, getJob, cancelJob, searchLinks, meta,
};
