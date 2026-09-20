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
  if (!system_id) throw new Error('请先添加业务系统');
  if (!name) throw new Error('Skill 名称（引导词）必填');
  if (id) {
    d.prepare(
      `UPDATE business_skills SET system_id=?, name=?, prompt=?, request_path=?, cron=?, enabled=? WHERE id=?`
    ).run(system_id, name, prompt || '', request_path || '', cronVal, enabled ? 1 : 0, id);
    registerAllTenantSkillJobs();
    return id;
  }
  const r = d.prepare(
    'INSERT INTO business_skills(system_id,name,prompt,request_path,cron,enabled) VALUES(?,?,?,?,?,?)'
  ).run(system_id, name, prompt || '', request_path || '', cronVal, enabled ? 1 : 0);
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
  if (!aiService.hasConfig(d)) throw new Error('AI 尚未配置，无法执行 Skill 任务');

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
  if (skill.browser_recipe) {
    try {
      const rc = JSON.parse(skill.browser_recipe);
      if (rc.extract && rc.extract.colNames) {
        const parsed = JSON.parse(data);
        let rows = Array.isArray(parsed) ? parsed : (parsed.rows || []);
        if (!Array.isArray(parsed) && parsed.footer) rows = [...rows, ['合计', ...parsed.footer]];
        d.prepare('INSERT INTO skill_pushes(system_id, skill_name, columns, rows) VALUES(?,?,?,?)')
          .run(skill.system_id, skill.name, JSON.stringify(rc.extract.colNames), JSON.stringify(rows));
        // 飞书推送：群触发只回触发群(opts.onlyTarget)；定时/AI助手推全部会话
        try {
          const feishu = require('./feishuService');
          const title = `[${sys.name}] ${skill.name}`;
          // 飞书卡片限制：最多推 18 行数据（表头由 header_style 渲染不计行）
          const pushRows = rows.slice(0, 18);
          if (opts && opts.onlyTarget) {
            await feishu.sendTableToTarget(d, opts.onlyTarget, title, rc.extract.colNames, pushRows);
            console.log('[skill] 已推送到飞书（触发会话·原生表格）');
          } else if ((feishu.getConfig(d).targets || []).length) {
            await feishu.sendTableAll(d, title, rc.extract.colNames, pushRows);
            console.log('[skill] 已推送到飞书（全部会话·原生表格）');
          }
        } catch (e) { console.warn('[skill] 飞书推送失败:', e.message); }
      }
    } catch (e) { console.warn('[skill] 保存推送失败:', e.message); }
  }

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
  const result = (await aiService.chat(messages, { maxTokens: 1600, tdb: d })).trim();
  d.prepare(`UPDATE business_skills SET last_result=?, last_run_at=datetime('now','localtime') WHERE id=?`)
    .run(result, skill.id);
  // 结果只写入 skill_pushes（AI 推送页展示），不再写入每日待办
  return result;
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
function saveSchedule(d, data) {
  const { id, skill_id, system_id, skill_name, system_name, feishu_target, feishu_target_name, cron, enabled } = data || {};
  if (!skill_id || !feishu_target || !cron) throw new Error('Skill、飞书会话和推送时间为必填');
  // 解析飞书目标 JSON 提取显示名
  let displayName = feishu_target_name || '';
  if (!displayName) {
    try { displayName = JSON.parse(feishu_target).name || ''; } catch { displayName = ''; }
  }
  if (id) {
    d.prepare('UPDATE skill_schedules SET skill_id=?, system_id=?, skill_name=?, system_name=?, feishu_target=?, feishu_target_name=?, cron=?, enabled=? WHERE id=?')
      .run(skill_id, system_id || 0, skill_name || '', system_name || '', feishu_target, displayName, cron, enabled !== false ? 1 : 0, id);
    registerAllTenantSkillJobs();
    return id;
  }
  const r = d.prepare('INSERT INTO skill_schedules(skill_id,system_id,skill_name,system_name,feishu_target,feishu_target_name,cron,enabled) VALUES(?,?,?,?,?,?,?,?)')
    .run(skill_id, system_id || 0, skill_name || '', system_name || '', feishu_target, displayName, cron, enabled !== false ? 1 : 0);
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
  matchSkill, runSkillById, runSkill, registerSkillJobs, registerAllTenantSkillJobs,
  listSchedules, saveSchedule, deleteSchedule, runScheduleNow,
};
