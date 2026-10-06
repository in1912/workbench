// AI 连接（v1.10.31）——「批量链接」的第四种类型：AI 提炼关键字/标签，把等待链接的笔记分组，
// 用户挑一组后用既有的「两两互链 / 循环链」执行。**AI 只做筛选与分组，一个字都不写进笔记**；
// 真正落链接的还是 backlinkMutual / backlinkChain（幂等、副作用与手动保存同口径的那些老规矩）。
//
// 为什么要后台任务：与本版上线的 AI复盘IM 同一个教训——AI 一轮真实耗时可达数分钟，
// 同步 POST 会被前端 180s / 网关 ~100s 超时腰斩成「网络连接失败」。这里沿用同一套任务模型
// （每租户一个、内存里跑、快照轮询、可取消；任务引擎的形状与 lifeImReviewService 保持一致）。
//
// 「等待链接」的口径（用户点名的筛选）：note_links 表里出现过的（无论作为 src 还是 dst）=「有过链接」；
// 两侧都没出现过的 =「从未链接过」。范围默认「从未链接过」，可切「有过链接 / 全部」。
const noteService = require('./noteService');
const ai = require('./aiService');

const SCOPES = [
  { key: 'unlinked', label: '从未链接过' },
  { key: 'linked', label: '有过链接' },
  { key: 'all', label: '全部笔记' },
];
const MAX_NOTES = 300;          // 送进 AI 的候选上限（按 updated_at 新在前）
const MAX_CORPUS_CHARS = 80000; // 与 AI复盘IM 同一个语料预算

function bad(msg) { const e = new Error(msg); e.code = 400; return e; }

// ---------- 元数据（弹窗首屏：筛选选项 + AI 配没配 + 候选上限） ----------
function meta(tdb) {
  return { has_ai: ai.hasConfig(tdb), scopes: SCOPES, max_notes: MAX_NOTES };
}

// ---------- 后台任务（每租户同时只跑一个，只留最近一个；形状与 lifeImReviewService 一致） ----------
const jobs = new Map();   // tenantKey → job
let jobSeq = 0;

function log(job, msg) {
  job.logs.push({ t: Date.now(), msg });
  if (job.logs.length > 200) job.logs.splice(0, job.logs.length - 200);
}

// AI 阶段拿不到真实进度：按「已等时间 / 粗估总时长」从 20% 逼近 95%——保证在动、永远到不了头
function aiProgress(job) {
  const waited = (Date.now() - job.ai_started_at) / 1000;
  const est = Math.max(20, job.ai_estimate_s || 40);
  return Math.min(95, 20 + 75 * (1 - Math.exp(-waited / est)));
}

function snapshot(job) {
  return {
    id: job.id, state: job.state, stage: job.stage, stage_label: job.stage_label,
    progress: job.state === 'running' && job.stage === 'ai' ? Math.round(aiProgress(job)) : job.progress,
    scope: job.scope, folder_id: job.folder_id, folder_name: job.folder_name,
    started_at: job.started_at, finished_at: job.finished_at,
    ai_started_at: job.stage === 'ai' ? job.ai_started_at : null,
    error: job.error, result: job.result, logs: job.logs.slice(),
  };
}

/** 创建（或接上在跑的）分析任务。参数校验同步做，立即返回快照——不等 AI。 */
function startJob(tdb, tenantKey, body) {
  const scope = String((body || {}).scope || 'unlinked');
  if (!SCOPES.some((s) => s.key === scope)) throw bad('筛选范围只能是：从未链接过 / 有过链接 / 全部笔记');
  if (!ai.hasConfig(tdb)) {
    throw bad('AI 尚未配置：请先在「设置 → AI 模型」里填写模型名称 / API 地址 / API Key');
  }
  let folderId = Number((body || {}).folder_id) || 0;   // 0 = 全库
  let folderName = '全库笔记';
  if (folderId > 0) {
    const fmap = noteService.folderMap(tdb);
    const walk = (nodes) => {
      for (const f of nodes) {
        if (f.id === folderId) return f;
        const hit = walk(f.children || []);
        if (hit) return hit;
      }
      return null;
    };
    const hit = walk(fmap.roots);
    if (!hit) throw bad('文件夹不存在');
    folderName = hit.path || hit.name;
  }
  const running = jobs.get(tenantKey);
  if (running && running.state === 'running') return { ...snapshot(running), resumed: true };

  const job = {
    id: ++jobSeq, state: 'running', stage: 'scan', stage_label: '扫描候选笔记', progress: 0,
    scope, folder_id: folderId, folder_name: folderName,
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

/** 候选 SQL 的「有无链接」谓词：note_links 两侧出现过的都算「有过链接」。 */
const LINKED_PRED = 'EXISTS(SELECT 1 FROM note_links l WHERE l.src_note_id=n.id OR l.dst_note_id=n.id)';

async function runJob(job) {
  const tdb = job._tdb;
  const scopeLabel = (SCOPES.find((s) => s.key === job.scope) || {}).label || job.scope;
  try {
    // ① 扫描候选：范围（文件夹子树或全库）× 链接状态，新在前，封顶 MAX_NOTES
    setStage(job, 'scan', '扫描候选笔记', 6);
    let where = `n.title != ''`;
    const params = [];
    if (job.folder_id > 0) {
      const ids = noteService.folderSubtreeIds(tdb, job.folder_id);
      where += ` AND n.folder_id IN (${ids.map(() => '?').join(',')})`;
      params.push(...ids);
    }
    if (job.scope === 'unlinked') where += ` AND NOT ${LINKED_PRED}`;
    else if (job.scope === 'linked') where += ` AND ${LINKED_PRED}`;
    const rows = tdb.prepare(
      `SELECT n.id, n.title, substr(n.content, 1, 600) AS excerpt FROM notes n WHERE ${where}
       ORDER BY n.updated_at DESC LIMIT ?`
    ).all(...params, MAX_NOTES);
    log(job, `扫描：${scopeLabel}${job.folder_id > 0 ? ` · ${job.folder_name}` : ' · 全库'}，命中 ${rows.length} 篇候选（上限 ${MAX_NOTES} 篇，新在前）`);
    if (rows.length < 2) {
      throw bad(`候选笔记只有 ${rows.length} 篇（${scopeLabel}${job.folder_id > 0 ? ` · ${job.folder_name}` : ''}），不够分组——换个筛选范围或文件夹再试`);
    }

    // ② 组语料：每篇一行「[id] 标题 —— 摘要」；超预算先丢摘要只留标题（再超截断条目）
    setStage(job, 'corpus', '组装语料', 14);
    const lineOf = (r, withExcerpt) => {
      const ex = withExcerpt ? String(r.excerpt || '').replace(/\s+/g, ' ').trim().slice(0, 160) : '';
      return ex ? `[${r.id}] ${r.title} —— ${ex}` : `[${r.id}] ${r.title}`;
    };
    let lines = rows.map((r) => lineOf(r, true));
    let used = lines.reduce((a, t) => a + t.length, 0);
    if (used > MAX_CORPUS_CHARS) {
      lines = rows.map((r) => lineOf(r, false));
      used = lines.reduce((a, t) => a + t.length, 0);
      log(job, `语料超预算（含摘要 ${used} 字 > ${MAX_CORPUS_CHARS}），已改为只送标题`);
    }
    while (lines.length > 2 && used > MAX_CORPUS_CHARS) used -= lines.pop().length;   // 再超就截条目（新在前的尾部老笔记先丢）
    const corpus = lines.join('\n');
    log(job, `语料 ${corpus.length} 字 / ${lines.length} 篇（每篇：编号 · 标题 · 摘要前 160 字）`);

    // ③ 交给总配置的 AI。有的模型偶尔不按 JSON 输出（v1.10.30 生产实录），解析失败自动重问一次
    setStage(job, 'ai', 'AI 分析中', 20);
    job.ai_started_at = Date.now();
    job.ai_estimate_s = 20 + Math.round(corpus.length / 1200);
    const model = ai.getConfig(tdb).model || '';
    const NUDGE = '\n\n（注意：你上一次的输出不是合法 JSON。这一次从第一个字符起就只输出一个 JSON 对象本身——不要 markdown 代码围栏、不要解释、不要思考过程。）';
    const PROMPT = [
      '下面是一批笔记的清单，每行格式是「[编号] 标题 —— 内容摘要」。请通读它们，按主题把**内容相关、值得互相链接**的笔记分组，输出一个 JSON 对象（只输出 JSON 本身，不要代码围栏、不要解释）：',
      '',
      '{',
      '  "groups": [',
      '    { "keyword": "这组共同的关键字或标签（一个词，最多 12 字）",',
      '      "note_ids": [编号, 编号],',
      '      "reason": "为什么这几篇值得链接（一句话）" }',
      '  ]',
      '}',
      '',
      '要求：',
      '- 编号只能用清单里出现过的，不要编造；',
      '- 每组至少 2 篇才有意义；同一个编号最多进一个组（挑最贴切的那组）；',
      '- 宁缺毋滥：没有明显相关的就不硬凑，返回空数组 groups:[] 也完全可以；',
      '- 分组上限 20 组，组内篇数不设上限（同一主题的都收进来）。',
    ].join('\n');
    let o = null, usedModel = '', usage = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const tAi = Date.now();
      log(job, attempt === 1
        ? `调用 AI（${model}）分析 ${lines.length} 篇…可离开本弹窗，任务在后台继续`
        : '输出不是合法 JSON，自动重试一次（换更严格的 JSON 指令）…');
      const { content, model: m, usage: u } = await ai.chatEx([
        { role: 'system', content: '你是中文笔记整理助手。严格按用户要求的 JSON 结构输出，只输出一个 JSON 对象本身，不要 markdown 代码围栏，不要任何解释。' },
        { role: 'user', content: `${PROMPT}${attempt > 1 ? NUDGE : ''}\n\n（以下是笔记清单）\n\n${corpus}` },
      ], { maxTokens: 3000, temperature: 0.3, tdb });
      if (job.state === 'cancelled') {
        log(job, `AI 已返回（${((Date.now() - tAi) / 1000).toFixed(0)} 秒），但任务已被取消——结果丢弃`);
        return;
      }
      usedModel = m; usage = u;
      log(job, `AI 返回：耗时 ${((Date.now() - tAi) / 1000).toFixed(1)} 秒 · ${u && u.total_tokens != null ? u.total_tokens + ' tokens' : 'tokens 未知'}（${m}）`);
      try {
        o = parseGroupsJson(content);
        break;
      } catch (e) {
        if (attempt === 2) throw e;
        log(job, `第 ${attempt} 次输出解析失败（${e.message.slice(0, 60)}…），重试`);
      }
    }
    setStage(job, 'parse', '校验分组', 97);

    // ④ 校验：只认候选清单里真实存在的编号；同一编号只进最前面的组；不足 2 篇的组丢弃
    const idSet = new Map(rows.map((r) => [Number(r.id), r]));
    const byId = new Map();
    const groups = [];
    let droppedForeign = 0, droppedDup = 0, droppedSmall = 0;
    for (const g of (o.groups || []).slice(0, 20)) {
      const ids = [];
      for (const rawId of (Array.isArray(g.note_ids) ? g.note_ids : [])) {
        const id = Number(rawId);
        if (!idSet.has(id)) { droppedForeign++; continue; }      // AI 编出来的编号
        if (byId.has(id)) { droppedDup++; continue; }            // 已进过别的组
        byId.set(id, groups.length);
        ids.push(id);
      }
      if (ids.length < 2) { ids.forEach((id) => byId.delete(id)); droppedSmall++; continue; }
      groups.push({
        keyword: String(g.keyword || '').trim().slice(0, 24) || '未命名分组',
        reason: String(g.reason || '').trim().slice(0, 120),
        note_ids: ids,
        notes: ids.map((id) => ({ id, title: idSet.get(id).title })),
      });
    }
    groups.sort((a, b) => b.note_ids.length - a.note_ids.length);
    log(job, `校验完成：${groups.length} 组覆盖 ${byId.size} 篇`
      + (droppedForeign || droppedDup || droppedSmall
        ? `（丢弃：编造编号 ${droppedForeign}、重复入组 ${droppedDup}、不足 2 篇的组 ${droppedSmall}）` : ''));
    job.result = {
      scope: job.scope, scope_label: scopeLabel, folder_id: job.folder_id, folder_name: job.folder_name,
      notes_candidates: rows.length, notes_used: lines.length, notes_grouped: byId.size,
      groups, model: usedModel, usage, generated_at_ms: Date.now(),
    };
    job.state = 'done'; job.stage = 'done'; job.stage_label = '完成'; job.progress = 100;
    job.finished_at = Date.now();
  } catch (e) {
    if (job.state === 'cancelled') { log(job, '任务已取消（后续错误不再展示）'); return; }
    job.state = 'error'; job.error = (e && e.message) || String(e); job.finished_at = Date.now();
    log(job, `出错：${job.error}`);
  }
}

/** AI 回的 JSON 加固解析：剥代码围栏、截首尾大括号；形状不对报错。 */
function parseGroupsJson(raw) {
  const t = String(raw || '').trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  let o;
  try {
    o = JSON.parse(s >= 0 && e > s ? t.slice(s, e + 1) : t);
  } catch {
    const err = new Error('AI 返回的不是合法 JSON，请重试一次');
    err.code = 500;
    throw err;
  }
  if (!o || !Array.isArray(o.groups)) {
    const err = new Error('AI 返回里没有 groups 数组，请重试一次');
    err.code = 500;
    throw err;
  }
  return o;
}

/** 最近一个任务的快照；没有任务返回 null（前端据此收起进度卡）。 */
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

module.exports = { meta, startJob, getJob, cancelJob };
