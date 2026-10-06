// AI 复盘 IM（v1.10.29 起；v1.10.30 改后台任务模型）——lifeOS「AI复盘IM」页签的后端。
//
// 一句话：选一个笔记文件夹（通常是 IM连接/某平台/某连接器），把时间范围内的聊天记录
// 交给工作台总配置的 AI，产出 **沟通概要 / 沟通重点 / 待办事项参考**；待办可勾选后
// 一键落成 lifeOS 行动（todos），截止日按复盘范围从次日起算（日=次日、周=+7、双周=+14、月=+30）。
//
// **读取量优化（本模块的核心取舍）**：归档笔记的标题是 `对方名称-YYYY-MM-DD HH:mm-连接器备注名`，
// 而标题里的时间戳在**每次有新消息的同步里都会被重写成最新一条消息的时间**（imService.upsertImNote
// 的更新分支无条件 UPDATE title；chatTitle 取本轮最后一条消息的时间）。于是「这篇笔记在时间范围内
// 有没有消息」**先看标题就够了**——标题时间在范围外的笔记必然不含范围内消息，整篇不读、一个字节不
// 取。方向是保守安全的：标题时间只会 ≥ 正文最新行（生产实测：官方 last_msg_time 把被过滤掉的
// 消息类型也计入，会出现「标题新、正文行都旧」的假阳性），最坏多读几篇、绝不漏。
//
// **时区**：标题/消息行的时间都是 imService.fmtTime 用**服务器本地时区方法**渲染的——所以这里的
// cutoff 也必须用同一个 fmtTime 生成（两边同一口径，容器是什么时区都对；定宽零填充，字典序=时间序）。
//
// 边界说破：快筛认的是标题里的时间戳。**用户改过标题的归档笔记**（时间戳没了）会被跳过——
// 这是读取量优化的代价，界面上写明。
//
// **v1.10.30 为什么改成后台任务**：AI 一轮真实耗时可达数分钟（上游单次 150 秒超时、
// 失败再重试一次，最坏 ~5 分钟；生产实测 days=1 也超过 300 秒）。原来同步 POST /preview
// 会被三层超时腰斩——前端 180 秒 AbortSignal、外网网关 ~100 秒、连测脚本的 undici 都是 300 秒
// ——用户只看到一句「网络连接失败」，而服务端其实还在跑。现在 POST /jobs 立即返回任务号，
// 管线在服务端内存里跑、随时可查快照（阶段/进度/过程日志），离开页面不影响、重进页面接着看；
// DELETE 可取消（在途的 AI 调用返回后结果丢弃）。任务只保存在内存里，服务重启即清。
const noteService = require('./noteService');
const lifeService = require('./lifeService');
const ai = require('./aiService');
const im = require('./imService');

const RANGES = [
  { days: 1, label: '日报（1 天内）' },
  { days: 7, label: '周报（7 天内）' },
  { days: 14, label: '双周报（14 天内）' },
  { days: 30, label: '月报（30 天内）' },
];

const DEFAULT_PROMPT = [
  '请根据下面的聊天记录做一份复盘整理，输出一个 JSON 对象（只输出 JSON 本身，不要代码围栏、不要解释）：',
  '',
  '{',
  '  "summary": "沟通概要：这段时间分别和谁沟通了什么，按会话或主题归纳，200 字以内",',
  '  "highlights": ["沟通重点：决策、约定、风险、重要信息，最多 6 条，每条一句话"],',
  '  "todos": [',
  '    { "title": "待办事项参考：动词开头、一条只写一件事", "note": "出处：哪个会话、什么时间、为什么要跟进（一句话）" }',
  '  ]',
  '}',
  '',
  '要求：待办只收聊天里明确要跟进的行动（别人等你回复、你答应要做、约了时间的事），',
  '不要编造、不要把寒暄当待办；没有可跟进的就给空数组。重点和待办里保留人名与时间，方便回查。',
].join('\n');

// 标题时间戳：`对方名称-YYYY-MM-DD HH:mm-连接器备注名`（时间串自带连字符，正则按整段锚定）
const TITLE_TS_RE = /-(\d{4}-\d{2}-\d{2} \d{2}:\d{2})-/;
// 消息行：`- **YYYY-MM-DD HH:mm｜发送者**：内容`（全角分隔符，与 imService.MSG_LINE_RE 同款）
const MSG_LINE_RE = /^- \*\*(\d{4}-\d{2}-\d{2} \d{2}:\d{2})｜(.+?)\*\*：(.*)$/;

function bad(msg) { const e = new Error(msg); e.code = 400; return e; }

function titleTs(title) {
  const m = TITLE_TS_RE.exec(String(title || ''));
  return m ? m[1] : '';
}

/** 某会话名（标题里时间戳前面那一段；认不出就整篇标题当会话名）。 */
function whoOf(title, ts) {
  const t = String(title || '');
  const cut = ts ? t.indexOf(`-${ts}-`) : -1;
  return (cut > 0 ? t.slice(0, cut) : t).trim() || '未知会话';
}

/** 交给 AI 的正文上限。超了按会话配额保留最新的行（老对话先丢），并把 truncated 标出来。 */
const MAX_CORPUS_CHARS = 80000;

// ---------- 元数据（页签首屏：范围选项 + 默认引导词 + AI 配没配） ----------
function meta(tdb) {
  return { ranges: RANGES, default_prompt: DEFAULT_PROMPT, has_ai: ai.hasConfig(tdb) };
}

// ---------- 文件夹树（只数 IM 归档笔记：标题里认得出时间戳的） ----------
// 不复用 GET /notes/folders 的两个原因：① 那个接口挂在笔记页权限下，本页签挂 life 页，
// 受限成员会 403；② 这里要的是 IM 篇数口径（note_count 数所有笔记，对选源没用）。
function listImFolders(tdb) {
  const map = noteService.folderMap(tdb);
  const own = new Map();
  for (const r of tdb.prepare('SELECT title, folder_id FROM notes WHERE folder_id IS NOT NULL').all()) {
    if (!titleTs(r.title)) continue;
    const k = Number(r.folder_id);
    own.set(k, (own.get(k) || 0) + 1);
  }
  const total = new Map();
  const sumOf = (f, depth) => {
    if (depth > 64) return 0;
    const t = (own.get(f.id) || 0) + f.children.reduce((acc, c) => acc + sumOf(c, depth + 1), 0);
    total.set(f.id, t);
    return t;
  };
  map.roots.forEach((f) => sumOf(f, 0));
  const mk = (f, depth) => {
    if (depth > 64) return null;
    return {
      id: f.id, name: f.name, path: f.path,
      im_count: own.get(f.id) || 0, im_total: total.get(f.id) || 0,
      children: f.children.map((c) => mk(c, depth + 1)).filter(Boolean),
    };
  };
  return map.roots.map((f) => mk(f, 0)).filter(Boolean);
}

// ---------- 后台任务（每租户同时只跑一个，只留最近一个） ----------
const jobs = new Map();   // tenantKey → job
let jobSeq = 0;

function log(job, msg) {
  job.logs.push({ t: Date.now(), msg });
  if (job.logs.length > 300) job.logs.splice(0, job.logs.length - 300);
}

// AI 阶段拿不到真实进度：按「已等时间 / 粗估总时长」从 40% 逼近 95%——保证在动、永远到不了头，
// 响应回来由 runJob 直接置 97/100。估错只影响爬得快慢，不影响正确性。
function aiProgress(job) {
  const waited = (Date.now() - job.ai_started_at) / 1000;
  const est = Math.max(20, job.ai_estimate_s || 40);
  return Math.min(95, 40 + 55 * (1 - Math.exp(-waited / est)));
}

/** 任务快照（对外只给这份；running 且在 AI 阶段时进度动态算）。 */
function snapshot(job) {
  const s = {
    id: job.id, state: job.state, stage: job.stage, stage_label: job.stage_label,
    progress: job.state === 'running' && job.stage === 'ai' ? Math.round(aiProgress(job)) : job.progress,
    days: job.days, folder_id: job.folder_id,
    started_at: job.started_at, finished_at: job.finished_at,
    ai_started_at: job.stage === 'ai' ? job.ai_started_at : null,
    error: job.error, result: job.result,
    logs: job.logs.slice(),
  };
  return s;
}

/** 创建（或接上在跑的）复盘任务。参数校验同步做，立即返回快照——不等 AI。 */
function startJob(tdb, tenantKey, body) {
  const days = Number(body.days);
  if (![1, 7, 14, 30].includes(days)) throw bad('时间范围只能是 1 / 7 / 14 / 30 天');
  if (!ai.hasConfig(tdb)) {
    throw bad('AI 尚未配置：请先在「设置 → AI 模型」里填写模型名称 / API 地址 / API Key');
  }
  const folderId = Number(body.folder_id);
  if (!noteService.folderSubtreeIds(tdb, folderId).length) {
    throw bad('文件夹不存在（或它下面没有任何子目录）');
  }
  const running = jobs.get(tenantKey);
  if (running && running.state === 'running') return { ...snapshot(running), resumed: true };

  const job = {
    id: ++jobSeq, state: 'running', stage: 'scan', stage_label: '扫描文件夹', progress: 0,
    days, folder_id: folderId, prompt: String(body.prompt || DEFAULT_PROMPT).trim() || DEFAULT_PROMPT,
    started_at: Date.now(), finished_at: null, error: null, result: null, logs: [],
    ai_started_at: null, ai_estimate_s: null,
    _tdb: tdb,
  };
  jobs.set(tenantKey, job);
  runJob(job).catch((e) => {   // 理论上不会到这（runJob 内部全兜）；兜住防 unhandledRejection
    job.state = 'error'; job.error = e && e.message; job.finished_at = Date.now();
  });
  return snapshot(job);
}

function setStage(job, stage, label, progress) {
  job.stage = stage; job.stage_label = label; job.progress = progress;
}

/** 管线：与旧 preview 相同的取数逻辑，加阶段/进度/日志。所有错误消化在 job 里。 */
async function runJob(job) {
  const tdb = job._tdb;
  const days = job.days;
  try {
    const ids = noteService.folderSubtreeIds(tdb, job.folder_id);
    const ph = ids.map(() => '?').join(',');
    const rows = tdb.prepare(`SELECT id, title FROM notes WHERE folder_id IN (${ph})`).all(...ids);

    // ① 快筛：只看标题时间，标题在范围外的整篇不读（notes_matched 是「读了内容的」篇数）
    setStage(job, 'scan', '扫描文件夹（标题时间快筛）', 4);
    const cutoff = im.fmtTime(Date.now() - days * 86400000);
    const matched = [];
    for (const r of rows) {
      const ts = titleTs(r.title);
      if (ts && ts >= cutoff) matched.push({ id: Number(r.id), title: r.title, ts });
    }
    matched.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));   // 新会话在前
    log(job, `快筛：扫描 ${rows.length} 篇标题（范围：最近 ${days} 天，早于 ${cutoff} 的整篇跳过），命中 ${matched.length} 篇`);
    job.stats = { scanned: rows.length, matched: matched.length };

    // ② 读命中的笔记，按行自己的时间戳过滤（标题假阳性的笔记在这里自然归零）
    setStage(job, 'read', '读取命中的笔记正文', 8);
    const convs = [];
    for (let i = 0; i < matched.length; i++) {
      if (job.state === 'cancelled') return;
      const m = matched[i];
      const row = tdb.prepare('SELECT content FROM notes WHERE id=?').get(m.id);
      const lines = [];
      for (const line of String((row && row.content) || '').split('\n')) {
        const hit = MSG_LINE_RE.exec(line.trim());
        if (hit && hit[1] >= cutoff) lines.push({ ts: hit[1], who: hit[2].trim(), text: hit[3].trim() });
      }
      if (lines.length) convs.push({ ...m, who: whoOf(m.title, m.ts), lines });
      log(job, `读取 ${i + 1}/${matched.length}：${m.title}（范围内消息 ${lines.length} 条）`);
      job.progress = 8 + Math.round(24 * (i + 1) / matched.length);   // 8 → 32
    }
    if (!convs.length) {
      throw bad(`时间范围（最近 ${days} 天）内没有提取到任何聊天消息：扫描 ${rows.length} 篇、标题命中 ${matched.length} 篇。范围外的笔记按标题时间整篇跳过、未读取。`);
    }

    // ③ 组语料。超预算时按会话份额保留最新的行，老会话先丢（但每个会话至少留一点，别整段消失）
    setStage(job, 'corpus', '组装语料', 36);
    const render = (c) => [`【会话】${c.who}（${c.lines.length} 条）`,
      ...c.lines.map((l) => `[${l.ts}] ${l.who}：${l.text}`)].join('\n');
    let texts = convs.map(render);
    let used = texts.reduce((a, t) => a + t.length, 0);
    let truncated = false;
    if (used > MAX_CORPUS_CHARS) {
      truncated = true;
      const budget = convs.map((c, i) => Math.max(1200, Math.floor(MAX_CORPUS_CHARS * texts[i].length / used)));
      texts = convs.map((c, i) => {
        const head = `【会话】${c.who}（部分，保留最新）`;
        const out = [head];
        let n = 0;
        for (const l of c.lines) {                       // lines 本就是新在前
          const s = `[${l.ts}] ${l.who}：${l.text}`;
          if (n + s.length > budget[i] - head.length && n > 0) break;
          out.push(s); n += s.length;
        }
        return out.join('\n');
      });
      used = texts.reduce((a, t) => a + t.length, 0);
    }
    const corpus = texts.join('\n\n');
    const linesUsed = convs.reduce((a, c) => a + c.lines.length, 0);
    log(job, `语料 ${corpus.length} 字（预算 ${MAX_CORPUS_CHARS}${truncated ? '，超了：按会话保留最新' : ''}），覆盖 ${convs.length} 个会话 / ${linesUsed} 条消息`);

    // ④ 交给总配置的 AI（aiService 自带 150 秒超时 × 2 次尝试与空回复报错——真实可能要几分钟）。
    // 生产实测有的模型偶尔不按 JSON 输出（v1.10.30 探针：语料才 1132 字、6 秒返回却是一段散文），
    // 所以解析失败自动用更严格的 JSON 指令重问一次，再不行才把任务判失败。
    setStage(job, 'ai', 'AI 生成中', 40);
    job.ai_started_at = Date.now();
    job.ai_estimate_s = 20 + Math.round(corpus.length / 1200);
    const model = ai.getConfig(tdb).model || '';
    const NUDGE = '\n\n（注意：你上一次的输出不是合法 JSON。这一次从第一个字符起就只输出一个 JSON 对象本身——不要 markdown 代码围栏、不要解释、不要思考过程。）';
    let o = null, usedModel = '', usage = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const tAi = Date.now();
      log(job, attempt === 1
        ? `调用 AI（${model}）…语料越大越慢，可离开本页，任务在后台继续`
        : '输出不是合法 JSON，自动重试一次（换更严格的 JSON 指令）…');
      const { content, model: m, usage: u } = await ai.chatEx([
        { role: 'system', content: '你是中文沟通复盘助手。严格按用户要求的 JSON 结构输出，只输出一个 JSON 对象本身，不要 markdown 代码围栏，不要任何解释。' },
        { role: 'user', content: `${job.prompt}${attempt > 1 ? NUDGE : ''}\n\n（以下是时间范围：最近 ${days} 天内的聊天记录，每行开头 [时间] 发送者：内容）\n\n${corpus}` },
      ], { maxTokens: 3000, temperature: 0.3, tdb });
      if (job.state === 'cancelled') {
        log(job, `AI 已返回（${((Date.now() - tAi) / 1000).toFixed(0)} 秒），但任务已被取消——结果丢弃`);
        return;
      }
      usedModel = m; usage = u;
      log(job, `AI 返回：耗时 ${((Date.now() - tAi) / 1000).toFixed(1)} 秒 · ${u && u.total_tokens != null ? u.total_tokens + ' tokens' : 'tokens 未知'}（${m}）`);
      try {
        o = parseReviewJson(content);   // 剥围栏等加固在 parseReviewJson
        break;
      } catch (e) {
        if (attempt === 2) throw e;
        log(job, `第 ${attempt} 次输出解析失败（${e.message.slice(0, 60)}…），重试`);
      }
    }
    setStage(job, 'parse', '解析结果', 97);
    log(job, `解析完成：概要 1 段 · 重点 ${o.highlights.length} 条 · 待办参考 ${o.todos.length} 条`);
    job.result = {
      range: RANGES.find((r) => r.days === days),
      folders: ids.length, notes_scanned: rows.length, notes_matched: matched.length,
      conversations: convs.map((c) => ({ id: c.id, title: c.title, lines: c.lines.length })),
      lines_used: linesUsed, chars: corpus.length, truncated,
      summary: o.summary, highlights: o.highlights, todos: o.todos,
      model: usedModel, usage,
      generated_at_ms: Date.now(),
    };
    job.state = 'done'; job.stage = 'done'; job.stage_label = '完成'; job.progress = 100;
    job.finished_at = Date.now();
  } catch (e) {
    if (job.state === 'cancelled') { log(job, `任务已取消（后续错误不再展示）`); return; }
    job.state = 'error'; job.error = (e && e.message) || String(e); job.finished_at = Date.now();
    log(job, `出错：${job.error}`);
  }
}

/** 最近一个任务的快照；没有任务返回 null（前端据此显示「还没有生成」）。 */
function getJob(tenantKey) {
  const job = jobs.get(tenantKey);
  return job ? snapshot(job) : null;
}

/** 取消在跑的任务：立即置 cancelled；在途的 AI 调用返回后由 runJob 丢弃结果。 */
function cancelJob(tenantKey) {
  const job = jobs.get(tenantKey);
  if (!job || job.state !== 'running') {
    return { ok: false, state: job ? job.state : 'none' };
  }
  job.state = 'cancelled'; job.stage_label = '已取消'; job.finished_at = Date.now();
  log(job, '已取消（如在途的 AI 调用稍后返回，结果将丢弃，不再计为完成）');
  return { ok: true, state: 'cancelled' };
}

/** AI 回的 JSON 加固解析：剥代码围栏、截首尾大括号；形状不对按可修复项修，修不了才报错。 */
function parseReviewJson(raw) {
  const t = String(raw || '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  let o;
  try {
    o = JSON.parse(s >= 0 && e > s ? t.slice(s, e + 1) : t);
  } catch {
    const err = new Error('AI 返回的不是合法 JSON，请重试一次（可先把引导词改简单些）');
    err.code = 500;
    throw err;
  }
  const strArr = (v, cap) => (Array.isArray(v) ? v.map((x) => String(x).trim()).filter(Boolean).slice(0, cap) : []);
  const todos = (Array.isArray(o.todos) ? o.todos : []).map((x) => typeof x === 'string'
    ? { title: x } : { title: String((x && x.title) || '').trim(), note: String((x && x.note) || '').trim() })
    .filter((x) => x.title).slice(0, 20);
  return {
    summary: String(o.summary || '').trim(),
    highlights: strArr(o.highlights, 8),
    todos,
  };
}

// ---------- 待办 → lifeOS 行动 ----------
// 截止日的口径（用户定的）：日待办=次日；周待办=次日后的 7 天时间范围（窗口末端即截止）；
// 月待办=次日后的 30 天。双周（14）顺势=+14。落在 lifeService.todayStr() 的本地日期上算。
const DUE_OFFSET_DAYS = { 1: 1, 7: 7, 14: 14, 30: 30 };

function dueDateFor(days) {
  const base = lifeService.todayStr();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(base);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + DUE_OFFSET_DAYS[days]);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function createTodos(tdb, body) {
  const days = Number(body.days);
  if (!(days in DUE_OFFSET_DAYS)) throw bad('时间范围只能是 1 / 7 / 14 / 30 天');
  const items = Array.isArray(body.items) ? body.items : null;
  if (!items || !items.length) throw bad('至少要勾选一条待办');
  if (items.length > 50) throw bad('一次最多加入 50 条待办');
  const due = dueDateFor(days);
  const ids = [];
  for (const it of items) {
    const title = String((it && it.title) || '').trim();
    if (!title) throw bad('待办内容不能为空');
    if (title.length > 200) throw bad(`待办「${title.slice(0, 30)}…」太长（上限 200 字）`);
    const note = String((it && it.note) || '').trim().slice(0, 300);
    ids.push(lifeService.createAction(tdb, { title, desc: note, due_date: due, task_type: 'daily_todo' }));
  }
  return { created: ids.length, due_date: due };
}

module.exports = { RANGES, DEFAULT_PROMPT, meta, listImFolders, startJob, getJob, cancelJob, createTodos, titleTs };
