const cron = require('node-cron');
const newsService = require('./services/newsService');
const skillService = require('./services/businessSkillService');
// 多租户调度：除"共享新闻"外，所有定时任务逐租户执行（forEachTenant 已做单租户异常隔离）
const { db, getSetting, setSetting, getShareFlags, forEachTenant } = require('./db');

const DEFAULT_REFRESH_TIMES = ['07:00', '17:00'];

let tasks = [];

// 每日默认待办：把模板（default_todos）复制为当天待办，每租户每天只执行一次
function syncDefaultTodos(d, username) {
  const today = new Date().toISOString().slice(0, 10);
  const last = getSetting(d, 'last_template_date', '');
  if (last === today) return;
  const items = getSetting(d, 'default_todos', []);
  if (Array.isArray(items) && items.length) {
    const insert = d.prepare('INSERT INTO todos(title,desc,due_date,priority) VALUES(?,?,?,?)');
    const tx = d.transaction((list) => {
      for (const t of list) {
        insert.run(`每日 · ${t.title}`, '每日默认待办', today, t.priority || 2);
      }
    });
    tx(items);
    console.log(`[scheduler] 已生成今日默认待办 ${items.length} 项${username ? `（${username}）` : ''}`);
  }
  setSetting(d, 'last_template_date', today);
}

// 邮箱拉取：固定每 5 分钟巡检一次，各租户按自己的 refresh_minutes 与上次拉取时间决定是否到点
// （旧实现按单一配置注册一个间隔 cron，多租户后各人间隔不同，改为统一巡检 + 时间戳判断）
async function pollEmails() {
  const emailService = require('./services/emailService');
  forEachTenant((d, uid, username) => {
    if (!emailService.isConfigured(d)) return;
    let minutes = 20;
    try {
      const cfg = d.prepare('SELECT refresh_minutes FROM email_config WHERE id=1').get() || {};
      minutes = Math.max(5, Number(cfg.refresh_minutes) || 20);
    } catch { /* email_config 缺行用默认 */ }
    const last = Number(getSetting(d, 'last_email_pull', 0)) || 0;
    if (Date.now() - last < minutes * 60 * 1000) return;
    setSetting(d, 'last_email_pull', Date.now()); // 先占位防并发重入
    (async () => {
      try {
        const r = await Promise.race([
          emailService.refresh(d),
          new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), 180000)),
        ]);
        console.log(`[scheduler] 邮箱拉取(${username}):`, r.ok ? `成功 ${r.count} 封` : `失败 ${r.error}`);
      } catch (e) {
        console.error(`[scheduler] 邮箱拉取超时(${username}):`, e.message);
      }
    })();
  });
}

// 通勤定时刷新时刻：所有租户 refresh_times 的并集（到点后逐租户强刷各自路线）
let commuteJobs = [];
function refreshAllCommutes() {
  const commuteService = require('./services/commuteService');
  forEachTenant((d, uid, username) => {
    (async () => {
      try {
        const r = await Promise.race([
          commuteService.calcCommute(d, true),
          new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), 60000)),
        ]);
        console.log(`[scheduler] 通勤刷新(${username}):`, r.ok ? `去${r.to_work.minutes}分/回${r.to_home.minutes}分` : r.error);
      } catch (e) {
        console.error(`[scheduler] 通勤刷新失败(${username}):`, e.message);
      }
    })();
  });
}
function scheduleCommuteJobs() {
  commuteJobs.forEach((j) => { try { j.stop(); } catch {} });
  commuteJobs = [];
  const times = new Set();
  forEachTenant((d) => {
    const c = getSetting(d, 'commute', {}) || {};
    for (const t of (c.refresh_times || DEFAULT_REFRESH_TIMES)) {
      if (t) times.add(String(t).slice(0, 5));
    }
  });
  for (const t of times) {
    const m = String(t).match(/^(\d{1,2}):(\d{2})$/);
    if (!m) continue;
    commuteJobs.push(cron.schedule(`${Number(m[2])} ${Number(m[1])} * * *`, refreshAllCommutes, { timezone: 'Asia/Shanghai' }));
    console.log(`[scheduler] 已注册通勤定时刷新：每天 ${t}（全体租户）`);
  }
}
// 租户改了刷新时刻（POST /commute）后重排
function rescheduleCommute() { scheduleCommuteJobs(); }

function init() {
  // 启动时清理 AI 空回复（历史 bug 存下的空气泡），避免用户看到空白消息——逐租户
  forEachTenant((d) => {
    try {
      const cleared = d.prepare("DELETE FROM ai_messages WHERE role='assistant' AND (content IS NULL OR TRIM(content)='')").run();
      if (cleared.changes) console.log(`[scheduler] 清理 AI 空回复 ${cleared.changes} 条`);
    } catch (e) { /* 忽略 */ }
  });

  // 每天 08:00 抓取三类新闻（用户要求：只保留早间一次，去掉原 13:00 午间补抓）
  // 共享开关开=主库抓一次（不按城市过滤，展示期各租户按自己城市过滤）；关=逐租户各抓各源各城市
  const newsJob = cron.schedule('0 8 * * *', async () => {
    console.log('[scheduler] 开始刷新每日新闻...');
    const run = async (d, city, who) => {
      try {
        const r = await Promise.race([
          newsService.refreshAll(d, city),
          new Promise((_, rej) => setTimeout(() => rej(new Error('新闻抓取超时（5 分钟）')), 5 * 60 * 1000)),
        ]);
        console.log(`[scheduler] 新闻刷新完成${who ? `（${who}）` : ''}`, r);
      } catch (e) {
        console.error(`[scheduler] 新闻刷新失败${who ? `（${who}）` : ''}:`, e.message);
      }
    };
    if (getShareFlags().news) {
      run(db, null, '');
    } else {
      forEachTenant((d, uid, username) => {
        const city = (getSetting(d, 'weather', {}) || {}).city || null;
        run(d, city, username);
      });
    }
  }, { timezone: 'Asia/Shanghai' });

  // 每天 09:00 刷新百度三榜并落当日快照（永久留存不清理）：
  // 热搜当天随查看实时更新（10 分钟缓存）；电影/电视剧当天读这份存档、不再重抓
  const boardJob = cron.schedule('0 9 * * *', async () => {
    console.log('[scheduler] 刷新百度榜单存档...');
    const run = async (d, who) => {
      try {
        const hb = await newsService.refreshBoards(d);
        console.log(`[scheduler] 百度榜单存档完成${who ? `（${who}）` : ''}`, hb);
      } catch (e) {
        console.warn(`[scheduler] 百度榜单存档失败${who ? `（${who}）` : ''}:`, e.message);
      }
    };
    if (getShareFlags().news) run(db, '');
    else forEachTenant((d, uid, username) => run(d, username));
  }, { timezone: 'Asia/Shanghai' });

  // 每天 06:00 生成今日默认待办（逐租户）
  const todoJob = cron.schedule('0 6 * * *', () => {
    forEachTenant((d, uid, username) => {
      try { syncDefaultTodos(d, username); } catch (e) { console.error(`[scheduler] 默认待办生成失败(${username}):`, e.message); }
    });
  }, { timezone: 'Asia/Shanghai' });
  forEachTenant((d, uid, username) => {
    try { syncDefaultTodos(d, username); } catch (e) { console.error(`[scheduler] 默认待办启动补跑失败(${username}):`, e.message); }
  });

  // 每周日 21:00 清理 90 天前的旧新闻（历史新闻留存 90 天；新闻在哪个库就清哪个）+ 各租户邮件垃圾箱
  const cleanJob = cron.schedule('0 21 * * 0', () => {
    const emailService = require('./services/emailService');
    const purgeNews = (d, who) => {
      try {
        const r = d.prepare("DELETE FROM news WHERE fetched_at < datetime('now','localtime','-90 days')").run();
        console.log(`[scheduler] 清理旧新闻 ${r.changes} 条${who ? `（${who}）` : ''}`);
      } catch (e) { console.error('[scheduler] 旧新闻清理失败:', e.message); }
    };
    if (getShareFlags().news) purgeNews(db, '');
    else forEachTenant((d, uid, username) => purgeNews(d, username));
    forEachTenant((d, uid, username) => {
      try { emailService.purgeTrash(d); } catch (e) { console.error(`[scheduler] 垃圾箱清理失败(${username}):`, e.message); }
    });
  }, { timezone: 'Asia/Shanghai' });
  // 垃圾箱每日也清一次（保留天数配置可能在周中被修改）
  cron.schedule('30 3 * * *', () => {
    const emailService = require('./services/emailService');
    forEachTenant((d, uid, username) => {
      try { emailService.purgeTrash(d); } catch (e) { console.error(`[scheduler] 垃圾箱清理失败(${username}):`, e.message); }
    });
  }, { timezone: 'Asia/Shanghai' });

  // 电脑监控截图保留期清理（每日 03:40，磁盘与库内同步；天数在「效率工具→电脑监控」配置）
  cron.schedule('40 3 * * *', () => {
    try {
      const n = require('./services/monitorService').cleanup();
      if (n) console.log('[scheduler] 电脑监控过期截图已清理 ' + n + ' 张');
    } catch (e) { console.warn('[scheduler] 监控截图清理失败:', e.message); }
  }, { timezone: 'Asia/Shanghai' });

  // 通勤定时刷新：注册所有租户 refresh_times 的并集时刻
  scheduleCommuteJobs();

  // 邮箱定时拉取：固定每 5 分钟巡检（pollEmails 内按各租户自己的间隔判断到点）
  const emailJob = cron.schedule('*/5 * * * *', pollEmails, { timezone: 'Asia/Shanghai' });
  console.log('[scheduler] 已注册邮箱巡检：每 5 分钟（各租户按自配间隔拉取）');

  // 飞书群触发词轮询：每 30 秒查各租户各群新消息，命中引导词则执行 skill（结果自动推回群）
  const feishuPoll = cron.schedule('*/30 * * * * *', async () => {
    try {
      const feishuService = require('./services/feishuService');
      forEachTenant((d) => { feishuService.pollTriggers(d).catch(() => {}); });
    } catch (e) { /* 忽略 */ }
  }, { timezone: 'Asia/Shanghai' });

  // 日程钉钉提醒：每分钟巡检各租户日程，开始前 15 分钟推送（工作通知优先，共享日程同步共享成员）
  const eventRemind = cron.schedule('* * * * *', () => {
    require('./services/eventRemindService').checkAll().catch((e) => console.warn('[scheduler] 日程提醒巡检失败:', e.message));
  }, { timezone: 'Asia/Shanghai' });

  // HTTPS 自签名证书到期提醒：每天 09:23 检查，到期前 30 天内给全体管理员发站内消息
  // （自备忘形态不随查看自动已读；messageService.send 会自动转钉钉推送），每天最多一条
  const sslRemind = cron.schedule('23 9 * * *', () => {
    try {
      const sslService = require('./services/sslService');
      const st = sslService.status();
      if (!st.configured || st.error || st.days_left > sslService.REMIND_DAYS) return;
      const today = new Date().toLocaleDateString('sv'); // YYYY-MM-DD
      if (getSetting(db, 'ssl_expire_last_notify', '') === today) return;
      setSetting(db, 'ssl_expire_last_notify', today);
      const expiry = new Date(st.valid_to).toLocaleDateString('zh-CN');
      const text = st.days_left >= 0
        ? `HTTPS 证书还有 ${st.days_left} 天到期（${expiry}）。请到「设置 → SSL 自签名」生成新证书并重启服务，避免浏览器安全告警。`
        : `HTTPS 证书已于 ${expiry} 过期 ${-st.days_left} 天！https 访问可能已被浏览器拦截，请尽快到「设置 → SSL 自签名」更换。`;
      const messageService = require('./services/messageService');
      for (const admin of db.prepare("SELECT id FROM users WHERE role='admin' AND is_bot=0").all()) {
        try { messageService.send(db, { from_user: admin.id, to_user: admin.id, subject: 'HTTPS 证书到期提醒', content: text, module: 'ssl' }); } catch { /* 单个失败不影响其余 */ }
      }
      console.log(`[scheduler] SSL 证书到期提醒已发送（剩余 ${st.days_left} 天）`);
    } catch (e) { console.warn('[scheduler] SSL 到期检查失败:', e.message); }
  }, { timezone: 'Asia/Shanghai' });

  tasks = [newsJob, boardJob, todoJob, cleanJob, ...commuteJobs, emailJob, feishuPoll, eventRemind, sslRemind];
  skillService.registerAllTenantSkillJobs();

  // TTS 引擎开机预热：升级/服务重启会连同 Python sidecar 一起带走（引擎原本是惰性拉起，
  // 要等首次合成才重启、冷启动约 30 秒——每次重启后进语音配音页都显示「未启动」）。
  // 启动 15 秒后后台拉起，不阻塞服务启动；未安装引擎的环境静默跳过，失败只记日志不重试
  // （语音配音页的「启动引擎」按钮仍是手动兜底）
  setTimeout(() => {
    try {
      const ttsService = require('./services/ttsService');
      if (!ttsService.installed()) return;
      ttsService.ensureServer()
        .then((h) => console.log(`[scheduler] TTS 引擎开机预热完成（phase=${h.phase}）`))
        .catch((e) => console.warn('[scheduler] TTS 引擎开机预热失败（可在语音配音页手动启动）:', e.message));
    } catch (e) { console.warn('[scheduler] TTS 引擎预热跳过:', e.message); }
  }, 15 * 1000).unref();
  console.log('[scheduler] 定时任务已启动：每日 06:00 默认待办 / 08:00 新闻 / 09:00 百度榜单存档 / 09:23 SSL证书到期检查 / 每周日 21:00 清理 / 通勤按租户并集时刻 / Skill 任务 / 飞书群触发词轮询(30s) / 日程提醒巡检(每分钟)');
}

module.exports = { init, tasks, syncDefaultTodos, rescheduleCommute };
