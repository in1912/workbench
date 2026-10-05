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

// 每日笔记自动创建：租户在笔记设置里打开 daily_note.auto_create 后，每天凌晨自动建当天那篇。
// 与 syncDefaultTodos 同一套路：每租户每天只跑一次（last_daily_note_date 记日期），
// 真正的创建走 noteService.ensureDailyNote，与 POST /notes/daily 共用一份逻辑（幂等靠 daily_date）。
function ensureDailyNotes(d, username) {
  const cfg = getSetting(d, 'daily_note', null) || {};
  if (!cfg.auto_create) return;
  const { localToday } = require('./services/noteStatsService');
  const today = localToday();
  if (getSetting(d, 'last_daily_note_date', '') === today) return;
  const { ensureDailyNote } = require('./services/noteService');
  const template = cfg.template_id
    ? d.prepare('SELECT content FROM note_templates WHERE id=?').get(Number(cfg.template_id) || -1)
    : null;
  const r = ensureDailyNote(d, today, { folder_id: cfg.folder_id, template });
  setSetting(d, 'last_daily_note_date', today);
  if (r.created) console.log(`[scheduler] 已创建今日笔记 ${today}${username ? `（${username}）` : ''}`);
}

// 邮箱拉取：固定每 5 分钟巡检一次，各租户各账号按自己的 refresh_minutes 与上次拉取时间决定是否到点
// （v1.7.0 多邮箱：逐账号判断到点，到点即整租户拉取一遍启用中的账号；时间戳按账号分开记）
async function pollEmails() {
  const emailService = require('./services/emailService');
  forEachTenant((d, uid, username) => {
    if (!emailService.isConfigured(d)) return;
    let due = false;
    for (const acc of emailService.getAccounts(d)) {
      if (!acc.enabled || !emailService.accountReady(acc)) continue;
      const minutes = Math.max(5, Number(acc.refresh_minutes) || 20);
      const last = Number(getSetting(d, `last_email_pull_a${acc.id}`, 0)) || 0;
      if (Date.now() - last >= minutes * 60 * 1000) {
        due = true;
        setSetting(d, `last_email_pull_a${acc.id}`, Date.now()); // 先占位防并发重入
      }
    }
    if (!due) return;
    (async () => {
      try {
        const r = await Promise.race([
          emailService.refresh(d, uid),
          new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), 180000)),
        ]);
        const parts = (r.accounts || []).map((a) => a.error ? `账号${a.id}失败` : `账号${a.id} ${a.new || 0} 新`).join('，');
        console.log(`[scheduler] 邮箱拉取(${username}):`, r.ok ? `成功（${parts}）` : `失败 ${r.error}`);
      } catch (e) {
        console.error(`[scheduler] 邮箱拉取超时(${username}):`, e.message);
      }
    })();
  });
}

// ---------- IM 连接器定时同步（v1.10.14，需求③） ----------
// 每条连接器各设各的时点/频率/范围（im_connectors.auto_*），这里每分钟巡检一次现算「到点没到点」。
//
// 为什么每分钟扫一遍，而不是给每条连接器排一个 cron：用户随时会改时刻、改开关、删连接器。
// 现算的好处是**没有需要维护的 job**，改配置立刻生效、删连接器不会留下幽灵任务；
// 代价是每分钟多几十微秒的库查询，可以忽略。
//
// 跑起来时**一次跑到底**（不像前端那样每 45 秒交还给浏览器）：分轮本来是为了绕开
// Cloudflare 对回源请求 ~100 秒的读超时，而这里是服务端自己跑，没有网关卡在中间，没必要分批。
// 服务器停机错过的那一次，起来后由 autoSyncDue 判定为「已过点、还没跑」自动补跑一次
//（最多补一次，不是补三天 —— 见 imService.autoSyncSlot 的注释）。
async function runImAutoSync(d, conn, username) {
  const imService = require('./services/imService');
  const who = `${conn.label || conn.provider}#${conn.id}`;
  if (!imService.lockSync(conn.id)) return;   // 手动点的同步正在跑 → 这一分钟让给它，下一分钟再来
  const done = (result) => {
    try {
      // auto_last_at 用**北京时间**写（与 autoSyncSlot 同一口径，见 imService.cstStamp）：
      // 这两串要互相比大小，如果一边服务器本地时间、一边北京时间，在 UTC 的容器里会算出
      // 「刚跑完还判定没跑」→ 每分钟重跑一次。所以这里不能图省事用 datetime('now','localtime')。
      d.prepare('UPDATE im_connectors SET auto_last_at=?,auto_last_result=? WHERE id=?')
        .run(imService.cstStamp(Date.now()), String(result).slice(0, 300), Number(conn.id));
    } catch (e) { console.warn('[scheduler] IM 定时同步结果写回失败:', e.message); }
  };
  try {
    let last = null, round = '';
    for (let i = 0; i < 200; i++) {   // 上限只是防死循环；正常几轮就完
      last = await imService.syncConnector(d, conn.id, { sinceDays: Number(conn.auto_days) || 30, round });
      round = last.round || round;
      if (last.done) break;
    }
    const where = `${last.chats} 个会话，新增 ${last.messages} 条消息`
      + `${last.notes ? `，新建 ${last.notes} 篇笔记` : ''}`
      + `${last.errors && last.errors.length ? `，${last.errors.length} 个会话失败` : ''}`;
    done(where);
    console.log(`[scheduler] IM 定时同步(${username} / ${who})：${where}`);
  } catch (e) {
    const m = String(e.message || e).slice(0, 300);
    done('失败：' + m);
    console.warn(`[scheduler] IM 定时同步失败(${username} / ${who})：${m}`);
  } finally {
    imService.unlockSync(conn.id);
  }
}

function pollImSync() {
  const imService = require('./services/imService');
  forEachTenant((d, uid, username) => {
    let rows = [];
    try { rows = d.prepare('SELECT * FROM im_connectors WHERE auto_sync=1').all(); } catch { return; }  // 老库还没加列时静默跳过
    for (const conn of rows) {
      if (!imService.autoSyncDue(conn)) continue;
      // 故意不 await：一条连接器可能跑好几分钟，不能把后面的租户堵住。
      // runImAutoSync 自己把异常吞干净，不会变成 unhandledRejection。
      runImAutoSync(d, conn, username);
    }
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

  // 每天 05:00 自动创建当天笔记（逐租户，开关在笔记设置里；启动时也补跑一次，
  // 服务器夜里重启也不会漏掉当天那篇）
  cron.schedule('0 5 * * *', () => {
    forEachTenant((d, uid, username) => {
      try { ensureDailyNotes(d, username); } catch (e) { console.error(`[scheduler] 每日笔记创建失败(${username}):`, e.message); }
    });
  }, { timezone: 'Asia/Shanghai' });
  forEachTenant((d, uid, username) => {
    try { ensureDailyNotes(d, username); } catch (e) { console.error(`[scheduler] 每日笔记启动补跑失败(${username}):`, e.message); }
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

  // IM 连接器定时同步：每分钟巡检，每条连接器按自己设的时点/频率到点就跑（v1.10.14）
  const imSyncJob = cron.schedule('* * * * *', pollImSync, { timezone: 'Asia/Shanghai' });
  console.log('[scheduler] 已注册 IM 连接器定时同步巡检：每分钟（各连接器按自配时点）');

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

  tasks = [newsJob, boardJob, todoJob, cleanJob, ...commuteJobs, emailJob, feishuPoll, imSyncJob, eventRemind, sslRemind];
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
  console.log('[scheduler] 定时任务已启动：每日 06:00 默认待办 / 08:00 新闻 / 09:00 百度榜单存档 / 09:23 SSL证书到期检查 / 每周日 21:00 清理 / 通勤按租户并集时刻 / Skill 任务 / 飞书群触发词轮询(30s) / 日程提醒巡检(每分钟) / IM 连接器定时同步巡检(每分钟，各连接器按自配时点)');
}

module.exports = { init, tasks, syncDefaultTodos, ensureDailyNotes, rescheduleCommute };
