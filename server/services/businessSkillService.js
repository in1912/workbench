const crypto = require('crypto');
const cron = require('node-cron');
// 多租户：业务系统/Skill/推送配置/推送记录全部归租户库；
// cron 注册按租户分桶（Map<uid,jobs[]>），任一租户改动后全量重注册。
const { db, forEachTenant } = require('../db');
const aiService = require('./aiService');

// ---------- 业务系统密码加解密（AES-256-GCM，可逆） ----------
const SECRET = crypto.createHash('sha256')
  .update(process.env.WORKBENCH_SECRET || 'workbench-default-secret-change-me')
  .digest();

function encrypt(text) {
  if (!text) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SECRET, iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}
function decrypt(stored) {
  if (!stored) return '';
  if (!stored.startsWith('v1:')) return stored; // 兼容旧明文
  const [, ivHex, tagHex, dataHex] = stored.split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', SECRET, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

function sanitizeSystem(sys) {
  if (!sys) return null;
  const { password, ...rest } = sys;
  return { ...rest, username: sys.username || '', password: password ? '******' : '' };
}

// ---------- Skill CRUD ----------
function listSkills(d, systemId) {
  const rows = systemId
    ? d.prepare('SELECT * FROM business_skills WHERE system_id=? ORDER BY id').all(systemId)
    : d.prepare('SELECT * FROM business_skills ORDER BY system_id, id').all();
  // 关联系统名（前端下拉需要显示"系统名 · Skill名"）
  const sysMap = {};
  for (const s of d.prepare('SELECT id, name FROM business_systems').all()) sysMap[s.id] = s.name;
  return rows.map((r) => ({ ...r, enabled: !!r.enabled, system_name: sysMap[r.system_id] || `系统${r.system_id}` }));
}

function saveSkill(d, data) {
  const { id, system_id, name, prompt, request_path, enabled } = data;
  const cronVal = data.cron || data.cron_expr || '';
  const localFmt = data.local_format ? 1 : 0;
  if (!system_id) throw new Error('请先添加业务系统');
  if (!name) throw new Error('Skill 名称（引导词）必填');
  // browser_recipe 只在请求体显式携带时写入（管理页编辑表单不带该字段——
  // 带缺省值会在编辑其它字段时误清配方；API/脚本创建配方走显式传参）
  const hasRecipe = Object.prototype.hasOwnProperty.call(data, 'browser_recipe');
  const recipeVal = hasRecipe ? String(data.browser_recipe || '') : '';
  if (id) {
    if (hasRecipe) {
      d.prepare(
        `UPDATE business_skills SET system_id=?, name=?, prompt=?, request_path=?, cron=?, enabled=?, local_format=?, browser_recipe=? WHERE id=?`
      ).run(system_id, name, prompt || '', request_path || '', cronVal, enabled ? 1 : 0, localFmt, recipeVal, id);
    } else {
      d.prepare(
        `UPDATE business_skills SET system_id=?, name=?, prompt=?, request_path=?, cron=?, enabled=?, local_format=? WHERE id=?`
      ).run(system_id, name, prompt || '', request_path || '', cronVal, enabled ? 1 : 0, localFmt, id);
    }
    registerAllTenantSkillJobs();
    return id;
  }
  const r = d.prepare(
    'INSERT INTO business_skills(system_id,name,prompt,request_path,cron,enabled,local_format,browser_recipe) VALUES(?,?,?,?,?,?,?,?)'
  ).run(system_id, name, prompt || '', request_path || '', cronVal, enabled ? 1 : 0, localFmt, recipeVal);
  registerAllTenantSkillJobs();
  return r.lastInsertRowid;
}

function deleteSkill(d, id) {
  d.prepare('DELETE FROM business_skills WHERE id=?').run(id);
  registerAllTenantSkillJobs();
}

// ---------- 引导词匹配 ----------
function matchSkill(d, text) {
  if (!text) return null;
  const skills = d.prepare('SELECT * FROM business_skills WHERE enabled=1').all();
  const t = String(text);
  // 优先全名匹配，其次包含匹配
  return (
    skills.find((s) => s.name === t.trim()) ||
    skills.find((s) => t.includes(s.name)) ||
    null
  );
}

// ---------- 执行 Skill ----------
async function runSkillById(d, id, opts = {}) {
  const skill = d.prepare('SELECT * FROM business_skills WHERE id=?').get(id);
  if (!skill) throw new Error('Skill 不存在');
  return runSkill(d, skill, opts);
}

async function runSkill(d, skill, opts = {}) {
  const sys = d.prepare('SELECT * FROM business_systems WHERE id=?').get(skill.system_id);
  if (!sys) throw new Error('所属业务系统不存在');
  // 本地整理模式不需要 AI；AI 模式才检查配置
  if (!skill.local_format && !aiService.hasConfig(d)) {
    throw new Error('AI 尚未配置，无法执行 Skill 任务（或在 Skill 里勾选「本地整理」改为不依赖 AI）');
  }

  let data = '';
  if (skill.browser_recipe) {
    // 浏览器取数模式（Playwright）：按配方登录+抓取，返回页面文本/表格 HTML
    try {
      const browserSkill = require('./browserSkillService');
      data = await browserSkill.runRecipe(sys, JSON.parse(skill.browser_recipe));
    } catch (e) {
      data = `（浏览器取数失败：${e.message}）`;
    }
  } else if (skill.request_path && sys.url) {
    try {
      data = await proxyGet(sys, skill.request_path);
    } catch (e) {
      data = `（数据接口调用失败：${e.message}）`;
    }
  }

  // 浏览器表格提取：把结构化数据存入 skill_pushes（供「AI推送」页 HTML 表格展示）
  // cols/rows 提升到外层：本地整理模式与飞书表格卡片都直接复用，避免二次解析
  let tableCols = null, tableRows = null;
  if (skill.browser_recipe) {
    try {
      const rc = JSON.parse(skill.browser_recipe);
      if (rc.extract && rc.extract.colNames) {
        const parsed = JSON.parse(data);
        let rows = Array.isArray(parsed) ? parsed : (parsed.rows || []);
        if (!Array.isArray(parsed) && parsed.footer) rows = [...rows, ['合计', ...parsed.footer]];
        tableCols = rc.extract.colNames;
        tableRows = rows;
        d.prepare('INSERT INTO skill_pushes(system_id, skill_name, columns, rows) VALUES(?,?,?,?)')
          .run(skill.system_id, skill.name, JSON.stringify(rc.extract.colNames), JSON.stringify(rows));
      }
    } catch (e) { console.warn('[skill] 保存推送失败:', e.message); }
  }

  // 本地整理（local_format=1）：不调用 AI，把抓取/接口数据确定性排版为 Markdown
  // AI 模式：chatEx 拿到 usage，结果尾部标注「模型 + token 消耗」并落库（last_ai_model/last_ai_tokens）
  let result, aiModel = '', aiTokens = 0;
  if (skill.local_format) {
    result = localFormat(sys, skill, data, tableCols, tableRows);
  } else {
    const sysLine = `业务系统：${sys.name}（${sys.url}）`;
    const messages = [
      {
        role: 'system',
        content:
          `你是业务助手，正在处理「${sys.name}」系统的定时/指令任务。${sysLine}` +
          (data ? `\n以下是系统接口返回的数据（可能不完整，基于它回答）：\n${String(data).slice(0, 8000)}` : '') +
          '\n请按任务指令执行，输出简洁明确、可直接阅读的中文结果，不要编造数据。',
      },
      { role: 'user', content: skill.prompt },
    ];
    const { content, model, usage } = await aiService.chatEx(messages, { maxTokens: 1600, tdb: d });
    const tokLine = usage && usage.total_tokens != null
      ? ` · tokens：输入 ${usage.prompt_tokens ?? '?'} + 输出 ${usage.completion_tokens ?? '?'} = ${usage.total_tokens}`
      : ' · tokens：网关未回传';
    result = content.trim() + `\n\n（AI 整理 · 模型 ${model || '未知'}${tokLine}）`;
    aiModel = model || '';
    aiTokens = (usage && usage.total_tokens) || 0;
  }
  d.prepare(`UPDATE business_skills SET last_result=?, last_run_at=datetime('now','localtime'), last_ai_model=?, last_ai_tokens=? WHERE id=?`)
    .run(result, aiModel, aiTokens, skill.id);

  // 推飞书（v1.9.37 修）：这块原先整段嵌在 `if (skill.browser_recipe)` 里，且异常只 console.warn ——
  // 于是「引导词类 Skill」（没有浏览器配方）点「立即执行」时**一条都没发出去**，界面却照闪
  // 「执行完成，去飞书查看」；配方类 Skill 发失败时同样被吞、界面照样说成功。
  // 现在：所有 Skill 都推，且把真实结果回给调用方（sent / error），由界面如实显示。
  const feishu = await pushFeishu(d, sys, skill, { tableCols, tableRows, result, target: opts && opts.onlyTarget });
  // 结果写入 skill_pushes（AI 推送页展示）与 business_skills.last_result，不再写入每日待办
  return { result, feishu };
}

// 推送到飞书并**如实回报**：{ sent, error }。
// 有结构化表格 → 原生表格卡片（schema 2.0）；纯文字 Skill → 旧版 markdown 卡片（sendToTarget）。
// 群触发/独立推送配置传了 target 就只发那一个会话；Skill 自带定时与「立即执行」发全部已配置会话。
async function pushFeishu(d, sys, skill, { tableCols, tableRows, result, target }) {
  let feishu;
  try { feishu = require('./feishuService'); } catch (e) { return { sent: 0, error: '飞书模块不可用：' + e.message }; }
  const title = `[${sys.name}] ${skill.name}`;
  const hasTable = !!(tableCols && tableRows && tableRows.length);
  if (!target && !(feishu.getConfig(d).targets || []).length) {
    return { sent: 0, error: '没配置飞书推送会话（去「设置 → 飞书推送」加一个群或个人）' };
  }
  try {
    if (hasTable) {
      // 飞书卡片限制：最多推 18 行数据（表头由 header_style 渲染，不计行）
      const rows = tableRows.slice(0, 18);
      if (target) await feishu.sendTableToTarget(d, target, title, tableCols, rows);
      else await feishu.sendTableAll(d, title, tableCols, rows);
    } else if (target) {
      await feishu.sendToTarget(d, target, title, result);
    } else {
      await feishu.sendMarkdown(d, title, result);
    }
    console.log(`[skill] 已推送到飞书（${hasTable ? '表格卡片' : 'markdown 卡片'}${target ? '·触发会话' : '·全部会话'}）`);
    return { sent: target ? 1 : (feishu.getConfig(d).targets || []).length };
  } catch (e) {
    console.warn('[skill] 飞书推送失败:', e.message);
    return { sent: 0, error: e.message };
  }
}

// ---------- 本地整理（不调用 AI） ----------
// 单元格转义：Markdown 表格的 | 与换行会破坏表格结构
function mdCell(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
}
function mdTable(cols, rows) {
  const lines = [`| ${cols.map(mdCell).join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`];
  for (const r of rows) {
    const cells = Array.isArray(r) ? cols.map((_, i) => r[i]) : cols.map((c) => (r && r[c] !== undefined ? r[c] : ''));
    lines.push(`| ${cells.map(mdCell).join(' | ')} |`);
  }
  return lines.join('\n');
}
// 数据 → 可读 Markdown：结构化表格直接排表；JSON 数组（对象按字段并集 / 数组按最大宽度）排表；
// JSON 对象排键值对；其余按原文输出（截断 4000 字符）。
function localFormat(sys, skill, data, tableCols, tableRows) {
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
  let body = '';
  if (tableCols && tableRows && tableRows.length) {
    body = mdTable(tableCols, tableRows);
  } else {
    const text = String(data || '').trim();
    if (!text || text.startsWith('（')) {
      body = text || '（未取到数据）';
    } else {
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* 非 JSON 原文输出 */ }
      if (Array.isArray(parsed) && parsed.length && parsed.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
        const cols = [...new Set(parsed.flatMap((x) => Object.keys(x)))];
        body = mdTable(cols, parsed);
      } else if (Array.isArray(parsed) && parsed.length && parsed.every((x) => Array.isArray(x))) {
        const width = Math.max(...parsed.map((x) => x.length));
        const cols = Array.from({ length: width }, (_, i) => `列${i + 1}`);
        body = mdTable(cols, parsed);
      } else if (Array.isArray(parsed)) {
        body = parsed.length ? text.slice(0, 4000) : '（接口返回空数据）';
      } else if (parsed && typeof parsed === 'object') {
        body = Object.entries(parsed)
          .map(([k, v]) => `- **${mdCell(k)}**：${typeof v === 'object' ? mdCell(JSON.stringify(v)) : mdCell(v)}`)
          .join('\n');
      } else {
        body = text.slice(0, 4000);
      }
    }
  }
  return `【${sys.name}】${skill.name}\n（本地整理 · ${stamp} · 未调用 AI）\n\n${body}`;
}

async function proxyGet(sys, requestPath) {
  const url = sys.url.replace(/\/+$/, '') + requestPath;
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'workbench-skill' };
  if (sys.token) headers.Authorization = `Bearer ${sys.token}`;
  else if (sys.username) {
    headers.Authorization = 'Basic ' + Buffer.from(`${sys.username}:${decrypt(sys.password)}`).toString('base64');
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return text.slice(0, 20000);
}

// ---------- Skill 定时任务注册（按租户分桶） ----------
const skillJobs = new Map(); // uid → jobs[]
function stopTenantJobs() {
  for (const jobs of skillJobs.values()) jobs.forEach((j) => { try { j.stop(); } catch {} });
  skillJobs.clear();
}

// 注册单个租户的定时任务（cron 闭包捕获该租户库句柄 d）
function registerSkillJobs(d) {
  const uid = require('../db').tenantIdOf(d);
  const bucket = [];
  skillJobs.set(uid, bucket);

  // 1) skill 自身的 cron（推到所有已配置的飞书会话）
  const skills = d.prepare("SELECT * FROM business_skills WHERE enabled=1 AND cron != ''").all();
  for (const s of skills) {
    try {
      const job = cron.schedule(s.cron, () => {
        console.log(`[skill] 定时执行: ${s.name}`);
        runSkill(d, s).catch((e) => console.warn(`[skill] ${s.name} 执行失败: ${e.message}`));
      }, { timezone: 'Asia/Shanghai' });
      bucket.push(job);
    } catch (e) {
      console.warn(`[skill] ${s.name} cron 无效（${s.cron}）: ${e.message}`);
    }
  }

  // 2) skill_schedules 表的独立推送配置（指定推到哪个飞书会话）
  try {
    const schedules = d.prepare("SELECT * FROM skill_schedules WHERE enabled=1 AND cron != ''").all();
    for (const sc of schedules) {
      try {
        const job = cron.schedule(sc.cron, async () => {
          console.log(`[schedule] 定时推送: ${sc.skill_name} → ${sc.feishu_target_name || sc.feishu_target}`);
          try {
            // 节假日门控：到点先判当日（中国墙钟）是否该推；「立即执行」不经过这里
            if (sc.holiday_mode) {
              const g = await holidayGate(d, sc.holiday_mode);
              if (g.skip) {
                console.log(`[schedule] ${sc.skill_name} 本次跳过：${g.reason}`);
                return;
              }
            }
            // 指定目标推到该会话
            const target = JSON.parse(sc.feishu_target);
            await runSkillById(d, sc.skill_id, { onlyTarget: target });
            d.prepare("UPDATE skill_schedules SET last_run_at=datetime('now','localtime') WHERE id=?").run(sc.id);
          } catch (e) {
            console.warn(`[schedule] ${sc.skill_name} 推送失败: ${e.message}`);
          }
        }, { timezone: 'Asia/Shanghai' });
        bucket.push(job);
      } catch (e) {
        console.warn(`[schedule] id=${sc.id} cron 无效（${sc.cron}）: ${e.message}`);
      }
    }
    if (schedules.length) console.log(`[schedule] 已注册 ${schedules.length} 个定时推送配置`);
  } catch (e) { /* skill_schedules 表可能不存在 */ }

  return bucket.length;
}

// 全量重注册（任一租户的 Skill/推送配置改动后调用；scheduler init 也调）
function registerAllTenantSkillJobs() {
  stopTenantJobs();
  let total = 0;
  forEachTenant((d) => { total += registerSkillJobs(d); });
  console.log(`[skill] 已注册 ${total} 个 Skill 定时任务（跨 ${skillJobs.size} 个租户）`);
  return total;
}

// ---------- 定时推送配置 CRUD ----------
function listSchedules(d) {
  try {
    return d.prepare('SELECT * FROM skill_schedules ORDER BY id').all();
  } catch { return []; }
}
// ---------- 节假日门控（数据源=系统设置「节假日」：timor.tech / apizero.cn，holidayService 统一拉取缓存） ----------
// mode: ''=不判断（照常推送） | 'skip'=法定节假日不推送 | 'workday'=按国家工作日历
//       （法定节假日跳过；周末调休补班日照常推送；无日历数据时退化为周一至周五）
// 返回 {skip, reason}；skip=true 表示本次到点应跳过。date 参数供测试注入（中国墙钟 {year,mmdd,dow}）。
function cnToday() {
  // 容器时区可能是 UTC：按 +8 偏移取中国标准时间墙钟（cron 都按 Asia/Shanghai 注册）
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return { year: d.getUTCFullYear(), mmdd: `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`, dow: d.getUTCDay() };
}
async function holidayGate(d, mode, ctx) {
  if (!mode) return { skip: false };
  const today = ctx || cnToday();
  let info = null;
  try {
    const map = await require('./holidayService').getHolidays(d, today.year) || {};
    info = map[today.mmdd] || null; // { name, holiday } —— holiday=false 的条目是调休补班日
  } catch (e) { console.warn('[schedule] 节假日日历获取失败，按无日历处理:', e.message); }
  const weekend = today.dow === 0 || today.dow === 6;
  if (mode === 'skip') {
    // 只跳法定节假日（含调休放的周末）；补班日/普通日不受影响
    if (info && info.holiday) return { skip: true, reason: `今日为法定节假日「${info.name || today.mmdd}」` };
    return { skip: false };
  }
  if (mode === 'workday') {
    if (info) {
      if (info.holiday) return { skip: true, reason: `今日为法定节假日「${info.name || today.mmdd}」` };
      return { skip: false, reason: `今日为调休补班日「${info.name || today.mmdd}」` };
    }
    if (weekend) return { skip: true, reason: '今日为周末（非调休补班日）' };
    return { skip: false };
  }
  return { skip: false };
}

function saveSchedule(d, data) {
  const { id, skill_id, system_id, skill_name, system_name, feishu_target, feishu_target_name, cron, enabled, holiday_mode } = data || {};
  if (!skill_id || !feishu_target || !cron) throw new Error('Skill、飞书会话和推送时间为必填');
  const hMode = holiday_mode === 'skip' || holiday_mode === 'workday' ? holiday_mode : '';
  // 解析飞书目标 JSON 提取显示名
  let displayName = feishu_target_name || '';
  if (!displayName) {
    try { displayName = JSON.parse(feishu_target).name || ''; } catch { displayName = ''; }
  }
  if (id) {
    d.prepare('UPDATE skill_schedules SET skill_id=?, system_id=?, skill_name=?, system_name=?, feishu_target=?, feishu_target_name=?, cron=?, enabled=?, holiday_mode=? WHERE id=?')
      .run(skill_id, system_id || 0, skill_name || '', system_name || '', feishu_target, displayName, cron, enabled !== false ? 1 : 0, hMode, id);
    registerAllTenantSkillJobs();
    return id;
  }
  const r = d.prepare('INSERT INTO skill_schedules(skill_id,system_id,skill_name,system_name,feishu_target,feishu_target_name,cron,enabled,holiday_mode) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(skill_id, system_id || 0, skill_name || '', system_name || '', feishu_target, displayName, cron, enabled !== false ? 1 : 0, hMode);
  registerAllTenantSkillJobs();
  return Number(r.lastInsertRowid);
}
function deleteSchedule(d, id) {
  d.prepare('DELETE FROM skill_schedules WHERE id=?').run(id);
  registerAllTenantSkillJobs();
}
function runScheduleNow(d, id) {
  const sc = d.prepare('SELECT * FROM skill_schedules WHERE id=?').get(id);
  if (!sc) throw new Error('配置不存在');
  const target = JSON.parse(sc.feishu_target);
  return runSkillById(d, sc.skill_id, { onlyTarget: target });
}

module.exports = {
  encrypt, decrypt, sanitizeSystem, listSkills, saveSkill, deleteSkill,
  matchSkill, runSkillById, runSkill, pushFeishu, registerSkillJobs, registerAllTenantSkillJobs,
  listSchedules, saveSchedule, deleteSchedule, runScheduleNow, holidayGate, cnToday,
};
