const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

// 数据目录：默认放项目 data 目录。可用 DATA_DIR 环境变量覆盖（如 Docker 卷 /data）。
const defaultDataDir = path.join(__dirname, '..', 'data');
const dataDir = process.env.DATA_DIR || defaultDataDir;
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// 主库文件：稳定单库（默认 workbench.sqlite；Docker 用 DB_FILE=qg-final.sqlite 覆盖）。
// 历史背景：早期版本怀疑 data 目录被同步盘锁定，故每次启动新建带时间戳的库并迁移；
// 现已确认宿主 data 目录不在同步盘（夸克网盘仅同步 D:\Documents），改为稳定单库。
// 首次启动自动从 data/ 下最近的历史库一次性导入数据，并把历史库归档到 data/archive/。
// 若仍遇 readonly（自行把 data 放到同步盘），可设 DATA_DIR 指向非同步目录。
const dbFile = process.env.DB_FILE || 'workbench.sqlite';
const dbPath = path.join(dataDir, dbFile);

// ---------- 通用打开（主库/租户库共用） ----------
// 使用 DELETE 日志模式（无 -wal/-shm 辅助文件，兼容各类文件监控环境）
function openDatabase(file) {
  const d = new DatabaseSync(file);
  d.exec('PRAGMA journal_mode = DELETE');
  d.exec('PRAGMA foreign_keys = ON');
  // 写锁等待上限：防止与其他进程/宿主监控短暂冲突时写操作无限挂起
  d.exec('PRAGMA busy_timeout = 5000');
  // node:sqlite 无内置事务 API，这里补一个与 better-sqlite3 兼容的包装
  d.transaction = (fn) => (...args) => {
    d.exec('BEGIN');
    try {
      const r = fn(...args);
      d.exec('COMMIT');
      return r;
    } catch (e) {
      d.exec('ROLLBACK');
      throw e;
    }
  };
  return d;
}

// ---------- 业务表结构（主库与租户库共用） ----------
// 多租户模型：主库只保留用户/会话/升级日志/共享配置 + 共享模块数据（news、ai_config）；
// 其余业务表每个用户（租户）一份独立库 data/tenant-<uid>.sqlite。
const BUSINESS_DDL = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'general',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  desc TEXT DEFAULT '',
  due_date TEXT,
  priority INTEGER DEFAULT 2,
  done INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  desc TEXT DEFAULT '',
  start_time TEXT,
  end_time TEXT,
  location TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT DEFAULT '',
  source TEXT DEFAULT '',
  url TEXT NOT NULL,
  published_at TEXT,
  fetched_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(category, url)
);

-- 百度榜单每日存档（热搜/电影/电视剧）：day=抓取日，一次一行快照；
-- 永久留存（周日清理只删 news 表，不动本表）
CREATE TABLE IF NOT EXISTS news_hot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board TEXT NOT NULL,
  day TEXT NOT NULL,
  rank INTEGER DEFAULT 0,
  word TEXT NOT NULL,
  desc TEXT DEFAULT '',
  img TEXT DEFAULT '',
  url TEXT NOT NULL,
  hot_score INTEGER DEFAULT 0,
  category TEXT DEFAULT '',
  extra TEXT DEFAULT '',
  fetched_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(board, day, word)
);

CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid INTEGER,
  subject TEXT DEFAULT '',
  from_addr TEXT DEFAULT '',
  date TEXT,
  snippet TEXT DEFAULT '',
  seen INTEGER DEFAULT 0,
  fetched_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS family_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  desc TEXT DEFAULT '',
  item_date TEXT,
  status TEXT DEFAULT 'todo',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS kids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  grade TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS kid_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kid_id INTEGER,
  subject TEXT DEFAULT '',
  content TEXT NOT NULL,
  due_date TEXT,
  status TEXT DEFAULT 'todo',
  done_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS family_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mime TEXT NOT NULL DEFAULT 'image/png',
  size INTEGER DEFAULT 0,
  data TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS learning_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill TEXT NOT NULL,
  goal TEXT DEFAULT '',
  plan_date TEXT,
  status TEXT DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS learning_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER,
  content TEXT NOT NULL,
  record_date TEXT DEFAULT (date('now','localtime')),
  gains TEXT DEFAULT '',
  problems TEXT DEFAULT '',
  next_steps TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT DEFAULT '',
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS clipboard_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  source TEXT DEFAULT 'manual',
  device TEXT DEFAULT '',          -- 采集来源电脑名（v1.6.2 剪贴板采集代理；手动录入为空）
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS clipboard_devices (  -- 已安装采集脚本的电脑（v1.6.2；落在各管理员自己的租户库）
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL UNIQUE,
  first_seen INTEGER DEFAULT 0,
  last_seen INTEGER DEFAULT 0,
  push_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS quick_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  icon TEXT DEFAULT '',
  category TEXT DEFAULT 'general',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS business_systems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT DEFAULT '',
  type TEXT DEFAULT 'web',
  token TEXT DEFAULT '',
  description TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS ai_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  model TEXT DEFAULT '',
  base_url TEXT DEFAULT '',
  api_key TEXT DEFAULT '',
  updated_at TEXT
);
INSERT OR IGNORE INTO ai_config (id) VALUES (1);

-- AI 对话会话（分主题保存）
CREATE TABLE IF NOT EXISTS ai_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT DEFAULT '新对话',
  model TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
-- AI 对话消息
CREATE TABLE IF NOT EXISTS ai_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON ai_messages(session_id);

CREATE TABLE IF NOT EXISTS email_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  imap_host TEXT DEFAULT '',
  imap_port INTEGER DEFAULT 993,
  imap_user TEXT DEFAULT '',
  imap_pass TEXT DEFAULT '',
  use_tls INTEGER DEFAULT 1,
  updated_at TEXT
);
INSERT OR IGNORE INTO email_config (id) VALUES (1);

-- 多邮箱账号（v1.7.0）：email_config 单行配置升级为多账号；老配置迁移为 1 号账号
CREATE TABLE IF NOT EXISTS email_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT DEFAULT '',
  imap_host TEXT DEFAULT '',
  imap_port INTEGER DEFAULT 993,
  imap_user TEXT DEFAULT '',
  imap_pass TEXT DEFAULT '',
  use_tls INTEGER DEFAULT 1,
  smtp_host TEXT DEFAULT '',
  smtp_port INTEGER DEFAULT 465,
  smtp_user TEXT DEFAULT '',
  smtp_pass TEXT DEFAULT '',
  smtp_tls INTEGER DEFAULT 1,
  smtp_from_name TEXT DEFAULT '',
  signature TEXT DEFAULT '',
  refresh_minutes INTEGER DEFAULT 20,
  trash_keep_days INTEGER DEFAULT 30,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- 邮件通信录
CREATE TABLE IF NOT EXISTS email_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT DEFAULT '',
  email TEXT NOT NULL,
  remark TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- 家庭人员档案：农历生日的唯一来源（节日日历/日程按此生成显示）
CREATE TABLE IF NOT EXISTS family_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  relation TEXT DEFAULT '',
  solar_birthday TEXT DEFAULT '',
  lunar_birthday TEXT DEFAULT '',
  remark TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- ---------- 个人账务 ----------
-- 账单流水（支付宝 CSV 导入 + 手动补录；交易号唯一去重）
CREATE TABLE IF NOT EXISTS pay_bills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_no TEXT,             -- 交易号（唯一索引去重；手动补录为空/自造）
  merchant_no TEXT DEFAULT '',
  create_time TEXT DEFAULT '',   -- 交易创建时间 YYYY-MM-DD HH:mm:ss
  pay_time TEXT DEFAULT '',
  source TEXT DEFAULT '',        -- 交易来源地
  tx_type TEXT DEFAULT '',       -- 类型（即时到账/担保交易…）
  counterparty TEXT DEFAULT '',  -- 交易对方
  goods TEXT DEFAULT '',         -- 商品名称
  amount REAL DEFAULT 0,         -- 金额（元）
  inout TEXT DEFAULT '',         -- 收/支（只有'支出'参与统计）
  status TEXT DEFAULT '',        -- 交易状态
  fee REAL DEFAULT 0,
  refund REAL DEFAULT 0,
  remark TEXT DEFAULT '',
  fund_status TEXT DEFAULT '',
  category TEXT DEFAULT '',      -- 消费类型（科目；自动识别或手动）
  category_src TEXT DEFAULT '',  -- 分类来源：rule(规则)/ai(AI)/manual(手动)/fixed(固定支出)/train(训练)
  is_expense INTEGER DEFAULT 0,  -- 是否参与统计（收/支=支出 且 金额>0）
  source_file TEXT DEFAULT '',   -- 来源文件
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_pay_bills_trade ON pay_bills(trade_no) WHERE trade_no IS NOT NULL AND trade_no != '';
CREATE INDEX IF NOT EXISTS idx_pay_bills_time ON pay_bills(create_time);
CREATE INDEX IF NOT EXISTS idx_pay_bills_cat ON pay_bills(category);

-- 消费科目（含识别特征标签 + 手动维护）
CREATE TABLE IF NOT EXISTS pay_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  keywords TEXT DEFAULT '',      -- 识别特征（交易对方/商品名关键词，逗号分隔）
  is_fixed INTEGER DEFAULT 0,    -- 是否每月固定支出（房贷/车贷…）
  fixed_amount REAL DEFAULT 0,   -- 固定支出金额
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- 月度预算（年+月+科目；一年12条可批量生成）
CREATE TABLE IF NOT EXISTS pay_budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  category TEXT NOT NULL,
  amount REAL DEFAULT 0,
  UNIQUE(year, month, category)
);

-- 文件存档：文件元数据 + 内置提取/AI 解析的文字版（供全局搜索）
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL,
  file_type TEXT DEFAULT '',
  file_size INTEGER DEFAULT 0,
  content TEXT DEFAULT '',
  text_content TEXT DEFAULT '',
  ai_parsed INTEGER DEFAULT 0,
  parse_engine TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS business_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER,
  name TEXT NOT NULL,
  prompt TEXT DEFAULT '',
  request_path TEXT DEFAULT '',
  cron TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1,
  last_result TEXT DEFAULT '',
  last_run_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- 定时推送配置：每条 = Skill × 飞书会话 × cron 时间（独立于 skill 自身的 cron）
CREATE TABLE IF NOT EXISTS skill_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  skill_id INTEGER NOT NULL,
  system_id INTEGER NOT NULL,
  skill_name TEXT DEFAULT '',
  system_name TEXT DEFAULT '',
  feishu_target TEXT DEFAULT '',
  feishu_target_name TEXT DEFAULT '',
  cron TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1,
  last_run_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- AI 推送：Skill 每次执行的结构化结果留存（供「AI推送」页按业务系统查看，HTML 表格展示）
CREATE TABLE IF NOT EXISTS skill_pushes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER,
  skill_name TEXT,
  columns TEXT,
  rows TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_skill_pushes ON skill_pushes(system_id, id DESC);

-- 听写历史：每次「开始听写」生成的内容存一行（点列表行可直接调取该次内容重新听写）
CREATE TABLE IF NOT EXISTS dictation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,       -- 原始录入内容（每行一条，中英文均可）
  count INTEGER DEFAULT 0,     -- 词条数（非空行）
  mode TEXT DEFAULT 'auto',    -- 播报方式快照：auto=全自动 / step=逐条暂停
  interval INTEGER DEFAULT 30, -- 间隔秒数快照
  voice_id INTEGER DEFAULT 0,  -- 播报音色快照
  voice_name TEXT DEFAULT '',  -- 音色名快照（音色删除后仍可显示）
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
`;

// 为已有表补充新列（SQLite ADD COLUMN，幂等）
function addCol(d, table, col, def) {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find((c) => c.name === col)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    console.log(`[db] 迁移：${table} 增加列 ${col}`);
  }
}

function applyColumnMigrations(d) {
  addCol(d, 'business_systems', 'username', "TEXT DEFAULT ''");
  addCol(d, 'business_systems', 'password', "TEXT DEFAULT ''");
  addCol(d, 'emails', 'body', "TEXT DEFAULT ''");
  addCol(d, 'emails', 'folder', "TEXT DEFAULT 'inbox'"); // inbox | sent | trash | draft
  addCol(d, 'emails', 'to_addr', "TEXT DEFAULT ''");
  addCol(d, 'emails', 'deleted_at', 'TEXT');
  // 附件（JSON 数组 [{filename, size, path}]，path 为 NAS 目录下相对路径）
  addCol(d, 'emails', 'attachments', "TEXT DEFAULT ''");
  // 多邮箱（v1.7.0）：邮件归属账号 id，与 email_accounts.id 对应；老邮件默认 1
  addCol(d, 'emails', 'account_id', "INTEGER DEFAULT 1");
  // 发件人显示名（v1.7.0 列表第一列用：如 GitHub &lt;noreply@github.com&gt; 显示 GitHub）
  addCol(d, 'emails', 'from_name', "TEXT DEFAULT ''");
  // 文件存档落盘路径（设置 → 文件存档 配置目录后新文件存磁盘、库里只留元数据；空=内容存库，旧数据兼容读取）
  addCol(d, 'files', 'storage_path', "TEXT DEFAULT ''");
  // 家庭图床落盘路径（全局默认上传路径配置后新图片存磁盘、库里不再存 base64；空=base64 存库，旧数据兼容读取）
  addCol(d, 'family_images', 'storage_path', "TEXT DEFAULT ''");
  addCol(d, 'email_config', 'refresh_minutes', "INTEGER DEFAULT 20");
  // SMTP 发信 + 签名 + 垃圾箱保留天数
  addCol(d, 'email_config', 'smtp_host', "TEXT DEFAULT ''");
  addCol(d, 'email_config', 'smtp_port', "INTEGER DEFAULT 465");
  addCol(d, 'email_config', 'smtp_user', "TEXT DEFAULT ''");
  addCol(d, 'email_config', 'smtp_pass', "TEXT DEFAULT ''");
  addCol(d, 'email_config', 'smtp_tls', "INTEGER DEFAULT 1");
  addCol(d, 'email_config', 'smtp_from_name', "TEXT DEFAULT ''");
  addCol(d, 'email_config', 'signature', "TEXT DEFAULT ''");
  addCol(d, 'email_config', 'trash_keep_days', "INTEGER DEFAULT 30");
  addCol(d, 'news', 'source_type', "TEXT DEFAULT 'rss'");
  // AI 耗用留痕（抓取该条新闻消耗的 token 数与模型；当前管道 Tavily 为搜索 API、
  // 不走大模型 → 恒为 0。列留在这里供未来接入 LLM 概括/翻译时如实记账）
  addCol(d, 'news', 'ai_tokens', 'INTEGER DEFAULT 0');
  addCol(d, 'news', 'ai_model', "TEXT DEFAULT ''");
  addCol(d, 'business_skills', 'browser_recipe', "TEXT DEFAULT ''");
  // 本地整理开关（1=不调用 AI，抓取/接口数据直接本地排版为 Markdown 表格）
  addCol(d, 'business_skills', 'local_format', 'INTEGER DEFAULT 0');
  // AI 整理模式留痕：上次执行用的模型与 token 消耗（本地整理恒为 ''/0）
  addCol(d, 'business_skills', 'last_ai_model', "TEXT DEFAULT ''");
  addCol(d, 'business_skills', 'last_ai_tokens', 'INTEGER DEFAULT 0');
  // 定时推送节假日门控：''=不判断 | 'skip'=法定节假日不推送 | 'workday'=按国家工作日历（补班日照推）
  // 数据源跟随系统设置「节假日」（timor.tech / apizero.cn，见 holidayService）
  addCol(d, 'skill_schedules', 'holiday_mode', "TEXT DEFAULT ''");
  addCol(d, 'pay_bills', 'category_src', "TEXT DEFAULT ''");
  addCol(d, 'pay_bills', 'source_file', "TEXT DEFAULT ''");
  addCol(d, 'pay_bills', 'modify_time', "TEXT DEFAULT ''");
  addCol(d, 'files', 'parse_engine', "TEXT DEFAULT ''");
  // AI 视觉模型（识图用，可独立于主模型；DeepSeek 官方 API 不支持 image_url，
  // 需填支持视觉的模型如 qwen-vl-max / glm-4v / gpt-4o 或第三方多模态网关）
  addCol(d, 'ai_config', 'vision_model', "TEXT DEFAULT ''");
  addCol(d, 'ai_config', 'vision_base_url', "TEXT DEFAULT ''");
  addCol(d, 'ai_config', 'vision_api_key', "TEXT DEFAULT ''");
  // 日程跨日：结束日期（与 end_time 组合；同日则留空）
  addCol(d, 'events', 'end_date', 'TEXT');
  // 日程钉钉提醒：remind_push=1 开始前 15 分钟推送到本人钉钉（工作通知）；
  // remind_sent_at=已推送时间（幂等，改时间后置空重排）；shared_to=共享给的成员 uid JSON 数组（只读查看+同步提醒）
  addCol(d, 'events', 'remind_push', 'INTEGER DEFAULT 0');
  addCol(d, 'events', 'remind_sent_at', 'TEXT');
  addCol(d, 'events', 'shared_to', "TEXT DEFAULT ''");
  // 家庭事项（通知）：登记人 + 勾选人留痕（中文姓名与时间直接冗余存行上，列表免联表）
  addCol(d, 'family_items', 'created_by', 'INTEGER');
  addCol(d, 'family_items', 'created_by_name', "TEXT DEFAULT ''");
  addCol(d, 'family_items', 'done_by', 'INTEGER');
  addCol(d, 'family_items', 'done_by_name', "TEXT DEFAULT ''");
  addCol(d, 'family_items', 'done_at', 'TEXT');
  addCol(d, 'family_items', 'ext_id', "TEXT DEFAULT ''"); // 钉钉消息 msgId（跨重推去重用）
}

// 业务库初始化：DDL + 结构迁移 + 索引（幂等，主库/租户库共用）
function initBusinessSchema(d) {
  d.exec(BUSINESS_DDL);

  // 迁移：旧版 news.url 为全局唯一，会导致同一来源文章无法同时存在于多个分类（如生活/本地共用中新网源）。
  // 检测到旧结构时，重建为 (category, url) 组合唯一并保留已有数据。
  const newsDef = d.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='news'").get();
  if (newsDef && newsDef.sql.includes('url TEXT NOT NULL UNIQUE')) {
    console.log('[db] 迁移 news 表：url 全局唯一 → (category,url) 组合唯一');
    d.exec(`
      ALTER TABLE news RENAME TO news_old;
      CREATE TABLE news (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT DEFAULT '',
        source TEXT DEFAULT '',
        url TEXT NOT NULL,
        published_at TEXT,
        fetched_at TEXT DEFAULT (datetime('now','localtime')),
        UNIQUE(category, url)
      );
      INSERT OR IGNORE INTO news SELECT * FROM news_old;
      DROP TABLE news_old;
    `);
  }

  applyColumnMigrations(d);

  // 中文全文搜索：SQLite FTS5 默认分词对中文不友好，个人数据量级用 LIKE 足够，
  // 此处为各表建立索引加速 LIKE 查询
  d.exec(`
    CREATE INDEX IF NOT EXISTS idx_notes ON notes(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_todos ON todos(done, due_date);
    CREATE INDEX IF NOT EXISTS idx_events ON events(start_time);
    CREATE INDEX IF NOT EXISTS idx_news ON news(category, fetched_at);
    CREATE INDEX IF NOT EXISTS idx_news_hot ON news_hot(board, day, rank);
    CREATE INDEX IF NOT EXISTS idx_clip ON clipboard_items(id DESC);
  `);
  // emails 去重唯一索引（v1.7.0 多邮箱）：(account_id, uid) 组合唯一，
  // 不同账号的 uid 互不冲突；发件/草稿 uid 为 NULL（SQLite 唯一索引视 NULL 互不相同，可多行）。
  // 旧库是单列 idx_emails_uid → 先检测存在即删除，再建组合索引
  try {
    const legacy = d.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_emails_uid'").get();
    if (legacy) d.exec('DROP INDEX idx_emails_uid');
  } catch {}
  try { d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_acc_uid ON emails(account_id, uid)'); } catch {}

  // 多邮箱迁移（v1.7.0）：email_config 单行配置 → email_accounts 1 号账号（一次性，幂等标记）
  try {
    if (!getSetting(d, 'email_accounts_v17', false)) {
      setSetting(d, 'email_accounts_v17', true);
      const hasAcc = d.prepare('SELECT COUNT(*) c FROM email_accounts').get().c;
      if (!hasAcc) {
        const cfg = d.prepare('SELECT * FROM email_config WHERE id=1').get();
        if (cfg && cfg.imap_user) {
          const label = String(cfg.imap_user).split('@')[0] || '邮箱 1';
          d.prepare(
            `INSERT INTO email_accounts(id,label,imap_host,imap_port,imap_user,imap_pass,use_tls,
             smtp_host,smtp_port,smtp_user,smtp_pass,smtp_tls,smtp_from_name,signature,
             refresh_minutes,trash_keep_days,enabled)
             VALUES(1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`
          ).run(
            label, cfg.imap_host || '', cfg.imap_port || 993, cfg.imap_user || '', cfg.imap_pass || '',
            cfg.use_tls ? 1 : 0, cfg.smtp_host || '', cfg.smtp_port || 465, cfg.smtp_user || '',
            cfg.smtp_pass || '', cfg.smtp_tls ? 1 : 0, cfg.smtp_from_name || '', cfg.signature || '',
            Math.max(5, Number(cfg.refresh_minutes) || 20), Math.max(1, Number(cfg.trash_keep_days) || 30)
          );
          console.log('[db] 邮箱单账号配置已迁移为多邮箱 1 号账号');
        }
      }
    }
  } catch (e) { console.warn('[db] 邮箱多账号迁移跳过:', e.message); }
}

// ---------- 主库 ----------
const db = openDatabase(dbPath);
initBusinessSchema(db);

// 主库专属表：用户/会话/升级日志 + 模块共享开关
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  allowed_pages TEXT DEFAULT '[]',
  display_name TEXT DEFAULT '',     -- 中文姓名（推送选择器等界面优先显示；空则回退用户名）
  nickname TEXT DEFAULT '',         -- 昵称（可选，仅用户管理与选择器搜索用）
  is_bot INTEGER NOT NULL DEFAULT 0, -- 1=系统虚拟成员（如钉钉机器人）：不可登录、不可删除
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  expires_at TEXT
);
-- 登录日志（v1.3.3）：每次登录尝试的流水（成功+失败），登录页爆破取证用。
-- attempted_password 只在失败时记录（看清攻击者在试什么）；成功登录不落密码，防止日志变成明文口令表。
-- region 归属地：内网 IP 直接标「内网」，公网 IP 异步查 ip-api.com 回填（尽力而为，查不到留空）。
CREATE TABLE IF NOT EXISTS login_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now','localtime')),
  username TEXT DEFAULT '',
  user_id INTEGER,
  success INTEGER NOT NULL DEFAULT 0,
  reason TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  region TEXT DEFAULT '',
  user_agent TEXT DEFAULT '',
  attempted_password TEXT
);
-- IP 黑名单（v1.3.4）：被封禁的 IP 一律 403（含静态页与全部 API）。
-- 来源：管理员在「设置 → 登录日志」手动封禁，或账号连续 10 次密码错误时自动封禁（回环/曾成功登录的 IP 不自动封）。
CREATE TABLE IF NOT EXISTS ip_bans (
  ip TEXT PRIMARY KEY,
  note TEXT DEFAULT '',
  created_by TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
-- 升级日志：每次版本打包的记录（zip 包存 data/upgrades/，表内存元数据与说明）
CREATE TABLE IF NOT EXISTS upgrade_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL,           -- 版本号（如 v1.0.1，自由填写）
  title TEXT DEFAULT '',           -- 升级标题
  content TEXT DEFAULT '',         -- 升级内容说明（多行）
  file_count INTEGER DEFAULT 0,
  package_name TEXT DEFAULT '',    -- data/upgrades/ 下的 zip 文件名
  package_size INTEGER DEFAULT 0,
  files_json TEXT DEFAULT '[]',    -- 打包文件清单 [{path,size,hash,status}]
  created_by TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
-- 日志来源：package=本机打包 / applied=应用外来升级包（迁移列，幂等）
-- 模块共享开关：管理员控制哪些模块的数据全租户共用（1=共享主库数据，0=各租户独立）
CREATE TABLE IF NOT EXISTS share_config (
  module TEXT PRIMARY KEY,
  is_shared INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO share_config (module, is_shared) VALUES
  ('news', 1), ('holiday', 1), ('amap_key', 1), ('ai_config', 1), ('family', 1);
-- 短消息（跨租户，主库）：成员互发站内信 + 各模块推送，永久留存
-- module: message=站内消息 / family=家庭事项 / kids=子女学习；ref_id 指向来源记录
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_user INTEGER NOT NULL,
  to_user INTEGER NOT NULL,
  subject TEXT DEFAULT '',
  content TEXT DEFAULT '',
  module TEXT DEFAULT 'message',
  ref_id INTEGER,
  ext_id TEXT DEFAULT '',           -- 来源外部标识（钉钉 msgId，用于流式重推去重）
  created_at TEXT DEFAULT (datetime('now','localtime')),
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_user, read_at);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(from_user, to_user, id);
-- 机器人消息图片（主库，随 messages）：钉钉机器人收到的图片经下载接口转存；
-- <img src="/api/message-images/N"> 经 ?token= 鉴权取图（同 family-images 模式）
CREATE TABLE IF NOT EXISTS message_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mime TEXT NOT NULL DEFAULT 'image/png',
  size INTEGER DEFAULT 0,
  data TEXT NOT NULL,
  storage_path TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
-- 电脑监控（v1.3.5；v1.4.7 设备级 interval/width 覆盖列、v1.4.8 AI 分析开关，NULL=跟随全局默认）：设备与截图（主库，跨租户统一管理）
CREATE TABLE IF NOT EXISTS monitor_devices (
  id TEXT PRIMARY KEY,
  name TEXT DEFAULT '',
  computer_name TEXT DEFAULT '',
  enabled INTEGER DEFAULT 1,
  interval INTEGER,
  width INTEGER,
  ai_enabled INTEGER,
  sort_order INTEGER DEFAULT 0,
  cfg_json TEXT,                 -- 单独配置的其余键（ai_every/retention_days/keywords/alert_users/alert_cooldown），NULL=跟随全局
  created_at TEXT DEFAULT (datetime('now','localtime')),
  last_seen TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS monitor_shots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  storage_path TEXT DEFAULT '',
  data TEXT DEFAULT '',
  ai_text TEXT,
  ai_at TEXT DEFAULT '',
  ai_tokens INTEGER DEFAULT 0,
  alert_hit INTEGER DEFAULT 0,
  shot_interval INTEGER
);
CREATE INDEX IF NOT EXISTS idx_monitor_shots_dev ON monitor_shots(device_id, ts);
-- 家庭与子女（按 family 共享开关路由：开=读主库全员共用，关=读各租户库独立）
-- 结构与租户库同名表一致（routedDb 选库，两边共用同一份 DDL 定义见上方业务表）
CREATE TABLE IF NOT EXISTS family_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  desc TEXT DEFAULT '',
  item_date TEXT,
  status TEXT DEFAULT 'todo',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS kids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  grade TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS kid_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kid_id INTEGER,
  subject TEXT DEFAULT '',
  content TEXT NOT NULL,
  due_date TEXT,
  status TEXT DEFAULT 'todo',
  done_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS family_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mime TEXT NOT NULL DEFAULT 'image/png',
  size INTEGER DEFAULT 0,
  data TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS family_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  relation TEXT DEFAULT '',
  solar_birthday TEXT DEFAULT '',
  lunar_birthday TEXT DEFAULT '',
  remark TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
-- ---------- 电子宠物（跨用户共同养育，数据归主库） ----------
CREATE TABLE IF NOT EXISTS pets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  species TEXT NOT NULL DEFAULT 'dog',        -- dog/cat/elephant/kangaroo/tiger/lion/pig/sheep/bear/custom
  variant INTEGER DEFAULT 0,                  -- 配色备选序号（custom 类型不适用）
  raise_mode TEXT NOT NULL DEFAULT 'shared',  -- shared=共同养育 personal=个人养育
  owner_id INTEGER,                           -- 创建者（personal 时即唯一养育人）
  custom_gif TEXT DEFAULT '',                 -- custom：data/pet-gifs 下的文件名
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS pet_members (
  pet_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  UNIQUE(pet_id, user_id)
);
CREATE TABLE IF NOT EXISTS pet_state (
  pet_id INTEGER PRIMARY KEY,
  last_food_at TEXT,                          -- 最近一次喂食物（饭/零食/水果）：冷却与生病判定
  last_water_at TEXT,                         -- 最近一次喂水
  sick_at TEXT,                               -- 生病起始（空=健康）
  poop_base_at TEXT DEFAULT (datetime('now','localtime')),   -- 粪便生成进度基准
  poop_penalty_at TEXT DEFAULT (datetime('now','localtime')), -- 粪便超标扣好感度进度基准
  poop_generated INTEGER DEFAULT 0            -- 历史累计生成数（粪便编号→槽位稳定）
);
CREATE TABLE IF NOT EXISTS pet_poops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,       -- 自增即"粪便编号"（客户端按编号定屏幕槽位，铲掉不漂移）
  pet_id INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pet_poops ON pet_poops(pet_id);
CREATE TABLE IF NOT EXISTS pet_stats (
  pet_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  affection REAL DEFAULT 0,                   -- 好感度（宠物对该用户）
  scoop_credits INTEGER DEFAULT 0,            -- 剩余铲屎次数（喂食物+3 喂水+1 铲一次-1）
  fed INTEGER DEFAULT 0, waters INTEGER DEFAULT 0, snacks INTEGER DEFAULT 0,
  plays INTEGER DEFAULT 0, scooped INTEGER DEFAULT 0, medicines INTEGER DEFAULT 0,
  PRIMARY KEY(pet_id, user_id)
);
CREATE TABLE IF NOT EXISTS pet_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pet_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  action TEXT NOT NULL,                       -- food/water/play/medicine/scoop/checkin/sick/poop_penalty
  detail TEXT DEFAULT '',                     -- 补充（食物种类/玩耍内容/事件说明）
  affection_delta REAL DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pet_logs ON pet_logs(pet_id, id DESC);
CREATE TABLE IF NOT EXISTS pet_checkins (
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,                          -- YYYY-MM-DD
  created_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(user_id, day)
);
-- 每用户界面偏好（如悬浮宠物位置 {right,bottom}，登录后恢复）
CREATE TABLE IF NOT EXISTS user_prefs (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  value TEXT DEFAULT '',
  PRIMARY KEY(user_id, key)
);
-- ---------- 打字赚钱（每日练习统计 + 兑现登记，数据归主库） ----------
CREATE TABLE IF NOT EXISTS typing_days (
  user_id INTEGER NOT NULL,
  day TEXT NOT NULL,                          -- YYYY-MM-DD
  seconds INTEGER NOT NULL DEFAULT 0,         -- 当日累计练习秒数
  correct INTEGER NOT NULL DEFAULT 0,         -- 打对字数（按键次数，奖励按此累计）
  wrong INTEGER NOT NULL DEFAULT 0,           -- 打错次数
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  PRIMARY KEY(user_id, day)
);
CREATE TABLE IF NOT EXISTS typing_payouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,                   -- 结算对象
  period TEXT NOT NULL,                       -- 结算月份 YYYY-MM
  amount REAL NOT NULL,                       -- 兑现金额（元）
  note TEXT DEFAULT '',
  created_by INTEGER NOT NULL,                -- 登记人
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_typing_payouts ON typing_payouts(user_id, period);
-- 自定义导入的打字内容（游戏=纯字母练习串 / poem=诗文 / song=歌词），仅创建人可见可删
CREATE TABLE IF NOT EXISTS typing_imports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,                          -- game | poem | song
  title TEXT NOT NULL,
  subtitle TEXT DEFAULT '',                    -- poem: 作者 / song: 歌手（可空）
  text TEXT NOT NULL,
  pinyin TEXT DEFAULT '',                      -- poem/song: 与原文逐字对齐的拼音串（无声调，ü→v）
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_typing_imports ON typing_imports(user_id, kind);

-- ---------- 语音（MOSS-TTS-Nano） ----------
-- 音色库（全局共享，主库）：一行一个「音色」。
-- builtin = 模型自带音色（preset=模型内预编码名；file_path 有值时也能直接试听参考音频）；
-- upload = 成员上传/录制的参考音频（file_path 为音色本体）
CREATE TABLE IF NOT EXISTS tts_voices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'upload',
  file_path TEXT NOT NULL DEFAULT '',
  preset TEXT DEFAULT '',
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
-- 视频教学学习记录：一人一文件一行（UNIQUE upsert），position 取历史最大值算进度%，watched 累加算学时
CREATE TABLE IF NOT EXISTS vstudy_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'media',
  ext TEXT DEFAULT '',
  school_year TEXT DEFAULT '',
  subject TEXT DEFAULT '',
  duration_sec REAL DEFAULT 0,
  position_sec REAL DEFAULT 0,
  watched_sec REAL DEFAULT 0,
  opened_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(user_id, path)
);
-- 视频教学学习会话：每打开一个文件 = 一次会话（历史学习列表按会话展示开始/关闭时间）；
-- 与 vstudy_records（一人一文件汇总）互补：records 算进度与总学时，sessions 记每次学习明细
CREATE TABLE IF NOT EXISTS vstudy_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'media',
  ext TEXT DEFAULT '',
  school_year TEXT DEFAULT '',
  subject TEXT DEFAULT '',
  watched_sec REAL DEFAULT 0,
  started_at TEXT DEFAULT (datetime('now','localtime')),
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_vstudy_sessions ON vstudy_sessions(user_id, started_at DESC);

-- ---------- 学时记账流水（视频教学有效学时的增/减明细账） ----------
-- delta_sec>0 = 生效学时（earn），<0 = 扣减（penalty，注意力检测未确认）；
-- complete=1 表示该次学习观看了视频时长的 90% 以上（完整学习）
CREATE TABLE IF NOT EXISTS vstudy_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  session_id INTEGER,
  path TEXT DEFAULT '',
  kind TEXT DEFAULT 'media',         -- media / doc
  school_year TEXT DEFAULT '',
  subject TEXT DEFAULT '',
  delta_sec REAL NOT NULL,           -- 秒；正=生效、负=扣减
  entry_type TEXT DEFAULT 'earn',    -- earn=生效 / penalty=扣减
  reason TEXT DEFAULT '',            -- 说明（如：注意力检测未确认，扣减50%）
  complete INTEGER DEFAULT 0,        -- 是否完整学习（观看≥90%时长）
  started_at TEXT,                   -- 会话开始时间
  ended_at TEXT,                     -- 会话关闭时间
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_vstudy_ledger ON vstudy_ledger(user_id, id DESC);

-- ---------- 练琴录音（录音文件落全局上传路径，有效时长由有权限成员确认） ----------
CREATE TABLE IF NOT EXISTS piano_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  duration_sec REAL DEFAULT 0,       -- 录音时长（秒）
  valid_sec REAL DEFAULT 0,          -- 有效时长（确认后生效；默认=录音时长，可改）
  confirmed INTEGER DEFAULT 0,       -- 是否已确认有效
  confirmed_by INTEGER,
  confirmed_by_name TEXT DEFAULT '',
  confirmed_at TEXT,
  started_at TEXT,                   -- 录音开始时间
  ended_at TEXT,                     -- 录音结束时间
  file_path TEXT DEFAULT '',         -- 服务器上的录音文件绝对路径
  file_mime TEXT DEFAULT 'audio/webm',
  kind TEXT DEFAULT 'audio',         -- audio=仅录音 | video=录像（320p 低码率小文件，含声音）
  thumb TEXT DEFAULT '',             -- 视频缩略图（base64 JPEG data URL，列表小图直接展示，点击弹窗播放）
  file_size INTEGER DEFAULT 0,       -- 媒体文件字节数（列表「容量」列）
  file_deleted INTEGER DEFAULT 0,    -- 原文件已清理=1（保留练习记录与有效时长，仅释放存储）
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_piano_records ON piano_records(user_id, id DESC);

-- ---------- 录音转写（VibeVoice-ASR：浏览器录音/上传音频 → 说话人分离转写） ----------
CREATE TABLE IF NOT EXISTS vibe_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',   -- 操作人中文姓名（display_name 优先）
  source TEXT NOT NULL DEFAULT 'record',-- record=系统内录音 | upload=上传文件
  fmt TEXT NOT NULL DEFAULT 'wav',      -- wav | mp3（录音格式；上传的按实际扩展名）
  started_at TEXT DEFAULT '',           -- 开始录制时间（上传=开始上传时间）
  ended_at TEXT DEFAULT '',             -- 结束录制时间（上传=上传完成时间）
  duration_sec REAL DEFAULT 0,          -- 录音时长（服务端读文件判定；录音兜底用起止时间差）
  file_path TEXT DEFAULT '',
  file_mime TEXT DEFAULT 'audio/wav',
  file_size INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- pending=待转写 | running=转写中 | done=已生成 | failed=失败
  transcript_md TEXT DEFAULT '',        -- 转写文本（markdown，详情框渲染/导出用）
  transcript_json TEXT DEFAULT '',      -- 模型原始 utterances（导出 txt 重建干净文本用）
  transcript_chars INTEGER DEFAULT 0,   -- 正文字数（不含时间戳/标题）
  transcribed_at TEXT DEFAULT '',
  model TEXT DEFAULT '',
  error TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_vibe_records ON vibe_records(id DESC);

-- 客户端拉取模式任务队列：客户端引擎多半在外网/NAT 后（服务器永远连不到它的内网 IP），
-- 反向而行——任务入队、客户端主动回连工作台领取并回传结果（客户端→工作台方向已证明可达）
CREATE TABLE IF NOT EXISTS vibe_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id INTEGER NOT NULL,
  req_body TEXT NOT NULL,               -- OpenAI 兼容请求体（含音频 data URL，认领时下发；终态清空省库容）
  status TEXT NOT NULL DEFAULT 'queued',-- queued=待领 | claimed=已领 | done=完成 | failed=失败
  engine TEXT DEFAULT 'vibeasr',         -- 任务归属引擎：vibeasr=1.5B BitNet | vibe7b=7B vLLM（老任务 NULL 按 vibeasr 兜底）
  error TEXT DEFAULT '',
  created_at INTEGER DEFAULT 0,         -- 入队时刻（epoch ms，超时判定用）
  claimed_at INTEGER DEFAULT 0,
  finished_at INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_vibe_jobs_pending ON vibe_jobs(status, id);
-- idx_vibe_jobs_pending2(status, engine, id) 在列迁移后就位后再建（见下方 addCol(vibe_jobs, engine) 后的语句），
-- 不能随主 DDL 一起建：旧库此时 engine 列尚未 addCol 补齐，CREATE INDEX 会因「no such column」启动崩溃

-- ---------- 心愿卡（产品 + 每日打卡；每天每人最多 2 次、每产品 1 次） ----------
CREATE TABLE IF NOT EXISTS wish_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  market_price REAL DEFAULT 0,       -- 市场售价
  family_price REAL DEFAULT 0,       -- 家庭兑换价
  note TEXT DEFAULT '',
  image_id INTEGER,                  -- family_images 图床 id
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS wish_checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  day TEXT NOT NULL,                 -- YYYY-MM-DD
  created_at TEXT DEFAULT (datetime('now','localtime')),
  UNIQUE(product_id, user_id, day)
);
CREATE INDEX IF NOT EXISTS idx_wish_checkins_day ON wish_checkins(day, user_id);

-- ---------- 赊账兑换登记（金额默认负数 = 提前支取；勾选平账后视为已结算） ----------
CREATE TABLE IF NOT EXISTS credit_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,          -- 成员
  user_name TEXT DEFAULT '',
  period TEXT DEFAULT '',            -- 月份 YYYY-MM
  amount REAL NOT NULL,              -- 金额（负数）
  content TEXT DEFAULT '',           -- 赊账内容
  note TEXT DEFAULT '',
  image_id INTEGER,                  -- family_images 图床 id（可选图片凭证）
  settled INTEGER DEFAULT 0,         -- 是否已平账
  settled_at TEXT,
  settled_by INTEGER,
  settled_by_name TEXT DEFAULT '',
  created_by INTEGER,
  created_by_name TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_credit_records ON credit_records(id DESC);

-- ---------- MBTI 心理测试（效率工具 → 心理测试；H5 静态托管在 /mbti/index.html） ----------
-- 每完成一份试卷 = 一行。id = H5 档案 ID（长随机串），分享链接 = 域名 + /mbti/index.html#/result/<id>，
-- 免登录读取（能力链接模型：知道链接即可看，见 mbtiRoutes /mbti/public/:id）
CREATE TABLE IF NOT EXISTS mbti_records (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 0,
  user_name TEXT NOT NULL DEFAULT '',
  uid TEXT DEFAULT '',               -- H5 档案编号（U…，展示用）
  version TEXT DEFAULT '',           -- 28 / 93
  type TEXT DEFAULT '',              -- MBTI 分型，如 INTJ
  name TEXT DEFAULT '',              -- 试卷名称（H5 档案名）
  finished_at TEXT,
  data TEXT NOT NULL DEFAULT '{}',   -- 完整档案 JSON（H5 白名单字段，不含头像）
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_mbti_records_user ON mbti_records(user_id, updated_at DESC);

-- H5「我的」页个人资料入库（多测试版 v1.2.24）：按 H5 档案编号 uid 一人一行。
-- 管理员在系统用户列表勾选 ai_authorized 后，该 uid 可用 AI 深度分析（走 ai_config 统一配置）
CREATE TABLE IF NOT EXISTS mbti_user_info (
  uid TEXT PRIMARY KEY,
  nickname TEXT DEFAULT '',
  name TEXT DEFAULT '',
  age TEXT DEFAULT '',
  gender TEXT DEFAULT '',
  job TEXT DEFAULT '',
  hobbies TEXT DEFAULT '',
  ai_authorized INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- ---------- 抑郁测试中心（v1.3.0）：与 mbti_records/mbti_user_info 同构，独立表 ----------
-- H5 静态托管在 /dep/index.html，路由见 depRoutes.js（/api/dep/*）
CREATE TABLE IF NOT EXISTS dep_records (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 0,
  user_name TEXT NOT NULL DEFAULT '',
  uid TEXT DEFAULT '',
  version TEXT DEFAULT '',
  type TEXT DEFAULT '',
  name TEXT DEFAULT '',
  test_id TEXT DEFAULT '',
  test_title TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  ai_analysis_done INTEGER NOT NULL DEFAULT 0,
  finished_at TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_dep_records_user ON dep_records(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS dep_user_info (
  uid TEXT PRIMARY KEY,
  nickname TEXT DEFAULT '',
  name TEXT DEFAULT '',
  age TEXT DEFAULT '',
  gender TEXT DEFAULT '',
  job TEXT DEFAULT '',
  hobbies TEXT DEFAULT '',
  ai_authorized INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);

-- ---------- 专业心理测试中心（v1.3.0）：与上同构，H5 静态托管在 /pro/index.html ----------
CREATE TABLE IF NOT EXISTS pro_records (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL DEFAULT 0,
  user_name TEXT NOT NULL DEFAULT '',
  uid TEXT DEFAULT '',
  version TEXT DEFAULT '',
  type TEXT DEFAULT '',
  name TEXT DEFAULT '',
  test_id TEXT DEFAULT '',
  test_title TEXT DEFAULT '',
  summary TEXT DEFAULT '',
  ai_analysis_done INTEGER NOT NULL DEFAULT 0,
  finished_at TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pro_records_user ON pro_records(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS pro_user_info (
  uid TEXT PRIMARY KEY,
  nickname TEXT DEFAULT '',
  name TEXT DEFAULT '',
  age TEXT DEFAULT '',
  gender TEXT DEFAULT '',
  job TEXT DEFAULT '',
  hobbies TEXT DEFAULT '',
  ai_authorized INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
`);
addCol(db, 'upgrade_logs', 'source', "TEXT DEFAULT 'package'");
// 学时会话的流水跟踪：ledger_sec=已写入流水的生效秒数；penalty_sec=已扣减秒数；
// duration_sec=媒体总时长（判断「观看≥90% 即完整学习」）
addCol(db, 'vstudy_sessions', 'ledger_sec', 'REAL NOT NULL DEFAULT 0');
addCol(db, 'vstudy_sessions', 'penalty_sec', 'REAL NOT NULL DEFAULT 0');
addCol(db, 'vstudy_sessions', 'duration_sec', 'REAL NOT NULL DEFAULT 0');
// 练琴录像（v1.2.3，piano_records 仅主库）：kind=audio|video、thumb=视频缩略图、file_size=文件容量、file_deleted=原文件已清理
addCol(db, 'piano_records', 'kind', "TEXT DEFAULT 'audio'");
addCol(db, 'piano_records', 'thumb', "TEXT DEFAULT ''");
addCol(db, 'piano_records', 'file_size', 'INTEGER DEFAULT 0');
addCol(db, 'piano_records', 'file_deleted', 'INTEGER DEFAULT 0');
// 心愿卡多图（v1.2.4，wish_products 仅主库）：image_ids=图床 id JSON 数组（最多 9 张）、cover_id=封面图 id；
// 旧单图 image_id 保留兼容（封面同步写入，读取时自动归一化）
addCol(db, 'wish_products', 'image_ids', "TEXT DEFAULT ''");
addCol(db, 'wish_products', 'cover_id', 'INTEGER');
// 页内 tab 级授权（JSON 对象 {family:['family','kids'], ...}；空/缺页键 = 该页全部 tab）
addCol(db, 'users', 'allowed_tabs', "TEXT DEFAULT ''");
// 电脑监控（v1.3.7）：截图的 AI 分析 token 耗用（monitor_shots 仅主库，存量库补列）
addCol(db, 'monitor_shots', 'ai_tokens', 'INTEGER DEFAULT 0');
// 命中过预警关键字的截图：不参与保留期清理，永久保留直至手动删除
addCol(db, 'monitor_shots', 'alert_hit', 'INTEGER DEFAULT 0');
// 电脑监控（v1.4.7）：设备级间隔/分辨率覆盖（NULL=跟随全局默认）；
// 截图记录上报当时生效的间隔——开关机会话按「当时间隔」推导，不再被当前全局配置误切历史
addCol(db, 'monitor_devices', 'interval', 'INTEGER');
addCol(db, 'monitor_devices', 'width', 'INTEGER');
addCol(db, 'monitor_shots', 'shot_interval', 'INTEGER');
// 设备列表显示排序（v1.4.8）：1~99 数字小的排前面，0=默认按接入先后；
// 设备级 AI 分析开关（NULL=跟随全局，1=开，0=关）；单独配置的其余监控键存 cfg_json（NULL=跟随全局）
addCol(db, 'monitor_devices', 'sort_order', 'INTEGER DEFAULT 0');
addCol(db, 'monitor_devices', 'ai_enabled', 'INTEGER');
addCol(db, 'monitor_devices', 'cfg_json', 'TEXT');
// 中文姓名/昵称（存量库补列；新库由上方 DDL 直接带出）
addCol(db, 'users', 'display_name', "TEXT DEFAULT ''");
addCol(db, 'users', 'nickname', "TEXT DEFAULT ''");
addCol(db, 'users', 'is_bot', 'INTEGER NOT NULL DEFAULT 0');
// 钉钉免登绑定：钉钉企业内 userid ↔ 工作台账号（首次账号密码登录自动绑定，之后钉钉工作台免登）
addCol(db, 'users', 'dingtalk_userid', "TEXT DEFAULT ''");
// 登录防爆破锁（v1.3.3，users 仅主库）：fail_count=连续失败次数（登录成功清零）；
// locked_until=临时锁定到期时间（ISO）；lock_permanent=1 时只能管理员在「用户管理」点解锁
addCol(db, 'users', 'fail_count', 'INTEGER NOT NULL DEFAULT 0');
addCol(db, 'users', 'locked_until', "TEXT DEFAULT ''");
addCol(db, 'users', 'lock_permanent', 'INTEGER NOT NULL DEFAULT 0');
addCol(db, 'messages', 'ext_id', "TEXT DEFAULT ''");
// 打字喂养：pet_logs 标记该次互动来自「打字口令」（配额与按钮互动分开统计）
addCol(db, 'pet_logs', 'typed', 'INTEGER DEFAULT 0');
// 宠物死亡：累计生病次数达阈值 / 长期没喂饭 → 去世（保留为墓碑记录，admin/主人可删）
addCol(db, 'pets', 'is_dead', 'INTEGER NOT NULL DEFAULT 0');
addCol(db, 'pets', 'dead_at', 'TEXT');
// death_cause：sick=久病离世 starve=饥饿离世；death_eulogy：随机悼词
addCol(db, 'pets', 'death_cause', "TEXT DEFAULT ''");
addCol(db, 'pets', 'death_eulogy', "TEXT DEFAULT ''");
// 历史累计生病回合数（吃药恢复后再次生病 +1）
addCol(db, 'pet_state', 'sick_count', 'INTEGER NOT NULL DEFAULT 0');
// 心理测试多测试版（v1.2.24）：test_id=mbti/holland/disc/enneagram/f###；test_title/summary 供列表直显
addCol(db, 'mbti_records', 'test_id', "TEXT DEFAULT ''");
addCol(db, 'mbti_records', 'test_title', "TEXT DEFAULT ''");
addCol(db, 'mbti_records', 'summary', "TEXT DEFAULT ''");
addCol(db, 'mbti_records', 'ai_analysis_done', 'INTEGER NOT NULL DEFAULT 0'); // 1=该档案已生成过 AI 深度分析
// 录音转写耗时（v1.5.9，v1.5.10 起列名改「转写耗时」）：run_ms=本次转写开始的 epoch 毫秒；elapsed_ms=完成耗时；
// 直连与拉取两条路共用——含排队/引擎加载/推理全程，老记录无值显示 —）
addCol(db, 'vibe_records', 'run_ms', 'INTEGER DEFAULT 0');
addCol(db, 'vibe_records', 'elapsed_ms', 'INTEGER DEFAULT 0');
// 任务引擎路由（v1.6.0）：该任务由哪套客户端引擎领取——vibeasr=1.5B BitNet 纯CPU | vibe7b=7B vLLM(WSL2+显卡)；
// 老任务/老 sidecar 无此概念，NULL 与空串一律按 vibeasr 兜底（向后兼容）
addCol(db, 'vibe_jobs', 'engine', "TEXT DEFAULT 'vibeasr'");
// engine 列就位后再建索引（旧库列是 addCol 补的，索引不能随主 DDL 建，否则列未就绪时启动会崩）
try { db.exec('CREATE INDEX IF NOT EXISTS idx_vibe_jobs_pending2 ON vibe_jobs(status, engine, id)'); } catch {}
// 存量回填：老记录的 test_id/test_title/summary 从档案 JSON 带出（每次启动只处理空列行，幂等）
try {
  const bfRows = db.prepare("SELECT id, data FROM mbti_records WHERE test_id=''").all();
  const bfUp = db.prepare('UPDATE mbti_records SET test_id=?, test_title=?, summary=? WHERE id=?');
  for (const r of bfRows) {
    try {
      const j = JSON.parse(r.data || '{}');
      const tid = String(j.testId || (j.version ? 'mbti' : '') || '');
      if (!tid) continue;
      bfUp.run(tid, String(j.testTitle || (tid === 'mbti' ? 'MBTI 职业性格测试' : '')), String(j.summary || j.type || ''), r.id);
    } catch (e) { /* 单行数据损坏则跳过 */ }
  }
} catch (e) { /* 表不存在等极端情况：忽略 */ }
// 存量回填：旧档案 finished_at 存的是 UTC ISO（含 'T'，比北京时间早 8 小时）→ 转本地统一格式（幂等：
// 转换后的 'YYYY-MM-DD HH:mm:ss' 不含 'T'，不会重复命中）
try {
  const tzRows = db.prepare("SELECT id, finished_at FROM mbti_records WHERE finished_at LIKE '%T%'").all();
  if (tzRows.length) {
    const tzUp = db.prepare('UPDATE mbti_records SET finished_at=? WHERE id=?');
    for (const r of tzRows) {
      const d = new Date(r.finished_at);
      if (isNaN(d)) continue;
      const p = n => String(n).padStart(2, '0');
      const local = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
        + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
      tzUp.run(local, r.id);
    }
    console.log('[db] mbti finished_at 时区回填 ' + tzRows.length + ' 行');
  }
} catch (e) { /* 表不存在等极端情况：忽略 */ }

// 钉钉机器人虚拟成员：站内消息里的「钉钉」会话入口（不可登录——password_hash 为空无法通过校验）
// 模块加载时建一次；多租户迁移/历史导入后由 dingtalkStreamService.start() 再补一次（幂等）
function ensureDingtalkBot(d) {
  d.prepare(
    `INSERT OR IGNORE INTO users(username,password_hash,role,allowed_pages,allowed_tabs,display_name,nickname,is_bot)
     VALUES('dingtalk_bot','','user','[]','{}','钉钉','机器人',1)`
  ).run();
}
ensureDingtalkBot(db);

// ---------- settings KV ----------
// 兼容两种签名：getSetting(d, key, def) 显式库；getSetting(key, def) 旧式默认主库。
// 新代码一律显式传库（租户数据用 req.tdb / service 参数 d）。
function getSetting(a, b, c) {
  const d = typeof a === 'string' ? db : a;
  const key = typeof a === 'string' ? a : b;
  const def = typeof a === 'string' ? b : c;
  const row = d.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (!row) return def;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
function setSetting(a, b, c) {
  const d = typeof a === 'string' ? db : a;
  const key = typeof a === 'string' ? a : b;
  const val = typeof a === 'string' ? b : c;
  d.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(val));
}

// ---------- 模块共享开关 ----------
const SHARE_MODULES = ['news', 'holiday', 'amap_key', 'ai_config', 'family'];
function getShareFlags() {
  const out = { news: true, holiday: true, amap_key: true, ai_config: true, family: true };
  try {
    for (const r of db.prepare('SELECT module, is_shared FROM share_config').all()) out[r.module] = !!r.is_shared;
  } catch {}
  return out;
}
function setShareFlags(partial) {
  for (const [k, v] of Object.entries(partial || {})) {
    if (!SHARE_MODULES.includes(k)) continue;
    db.prepare('INSERT INTO share_config(module,is_shared) VALUES(?,?) ON CONFLICT(module) DO UPDATE SET is_shared=excluded.is_shared')
      .run(k, v ? 1 : 0);
  }
}

// ---------- settings 键路由 ----------
// 永远存主库的系统键 + 一次性守卫键（与租户无关）
const MAIN_SETTING_KEYS = new Set([
  'system_name', 'system_name_en', 'current_version', 'upgrade_baseline',
  'email_rebuild_done', 'stable_db_archived', 'multi_tenant_v1', 'mt_cleanup_done', 'push_merge_v1',
  'family_share_v1', 'external_base_url',
]);
// 带共享开关的键：开关开 → 主库（全租户共用）；关 → 各租户库
const SHARED_SETTING_KEYS = {
  news_sources: 'news',
  news_search: 'news',
  holiday_api: 'holiday',
  amap_key: 'amap_key',
  ai_balance_url: 'ai_config',
};
function routedSettingDb(tdb, key) {
  if (MAIN_SETTING_KEYS.has(key)) return db;
  const flag = SHARED_SETTING_KEYS[key];
  if (flag && getShareFlags()[flag]) return db;
  return tdb;
}
function getSettingR(tdb, key, def) { return getSetting(routedSettingDb(tdb, key), key, def); }
function setSettingR(tdb, key, val) { setSetting(routedSettingDb(tdb, key), key, val); }
// 按共享开关选库：flag 开 → 主库；关 → 租户库
function routedDb(tdb, flag) { return getShareFlags()[flag] ? db : tdb; }

// 高德 Key：从旧 settings.commute.key 拆出的独立键，按 amap_key 开关路由
function getAmapKey(tdb) { return String(getSettingR(tdb, 'amap_key', '') || '').trim(); }
function saveAmapKey(tdb, key) { setSettingR(tdb, 'amap_key', String(key || '').trim()); }

// ---------- 租户库 ----------
const tenantDbs = new Map(); // uid → DatabaseSync
function tenantDbFile(uid) { return path.join(dataDir, `tenant-${uid}.sqlite`); }

function getTenantDb(uid) {
  const key = Number(uid);
  let t = tenantDbs.get(key);
  if (t) return t;
  t = openDatabase(tenantDbFile(key));
  initBusinessSchema(t);
  // 账务科目种子：惰性 require 避免 db ↔ payService 循环依赖
  try { require('./services/payService').seedCategories(t); } catch (e) {
    console.warn(`[db] 租户#${key} 科目种子失败:`, e.message);
  }
  tenantDbs.set(key, t);
  return t;
}
// 关闭租户库句柄（删除用户前必调：Windows 上打开的文件无法 rename/删除）
function closeTenantDb(uid) {
  const key = Number(uid);
  const t = tenantDbs.get(key);
  if (!t) return false;
  tenantDbs.delete(key);
  try { t.close(); } catch {}
  return true;
}
// 反查：该 db 句柄属于哪个租户（主库返回 null）——附件落盘加租户前缀防跨租户撞名
function tenantIdOf(d) {
  for (const [uid, t] of tenantDbs) if (t === d) return uid;
  return null;
}
// data/ 下现存的租户库 uid 列表（孤儿文件也列出，供排查）
function listTenantDbs() {
  return fs.readdirSync(dataDir)
    .filter((f) => /^tenant-\d+\.sqlite$/.test(f))
    .map((f) => Number(f.slice(7, -7)));
}
// 遍历所有真实用户的租户库（逐租户 try/catch 隔离，单个失败不影响其他；机器人虚拟成员不是租户）
function forEachTenant(fn) {
  for (const u of db.prepare('SELECT id, username FROM users WHERE is_bot=0 ORDER BY id').all()) {
    try { fn(getTenantDb(u.id), u.id, u.username); }
    catch (e) { console.warn(`[db] 租户 ${u.username}(#${u.id}) 任务失败:`, e.message); }
  }
}

// ---------- 多租户存量迁移（复制式，一次性） ----------
// 27 张业务表清单（主库与租户库共有的业务数据表）
const TENANT_TABLES = [
  'notes', 'todos', 'events', 'emails', 'family_items', 'kids', 'kid_tasks',
  'learning_plans', 'learning_records', 'reviews', 'clipboard_items', 'quick_links',
  'business_systems', 'ai_sessions', 'ai_messages', 'email_config', 'email_contacts',
  'family_profiles', 'pay_bills', 'pay_categories', 'pay_budgets', 'files',
  'business_skills', 'skill_schedules', 'skill_pushes', 'news', 'ai_config',
];
// 归租户库的 settings 键（其余留在主库）
const TENANT_SETTING_KEYS = [
  'weather', 'commute', 'default_todos', 'last_template_date', 'dashboard_layout',
  'credit_cards', 'calendar', 'email_attachments', 'feishu_push', 'feishu_last_poll',
  'pay_cycle', 'last_email_pull',
];

function copyTableRows(src, dst, name) {
  const has = src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (!has) return 0;
  const rows = src.prepare(`SELECT * FROM "${name}"`).all();
  if (!rows.length) return 0;
  const srcCols = Object.keys(rows[0]);
  // 只插两边共有的列，防未来主库/租户库结构差异
  const dstCols = dst.prepare(`PRAGMA table_info("${name}")`).all().map((c) => c.name);
  const use = srcCols.filter((c) => dstCols.includes(c));
  const ins = dst.prepare(`INSERT OR REPLACE INTO "${name}" (${use.map((c) => `"${c}"`).join(',')}) VALUES (${use.map(() => '?').join(',')})`);
  for (const r of rows) ins.run(...use.map((c) => r[c]));
  return rows.length;
}

function migrateToMultiTenant() {
  if (getSetting(db, 'multi_tenant_v1', false)) return;
  const admin = db.prepare("SELECT id, username FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
  if (!admin) {
    // 空库（无用户）：标记完成，后续用户经 getTenantDb 惰性建库
    setSetting(db, 'multi_tenant_v1', true);
    return;
  }
  const finalPath = tenantDbFile(admin.id);
  if (fs.existsSync(finalPath)) {
    // 租户库已存在（历史残留/重复启动）：直接标记完成，不覆盖
    setSetting(db, 'multi_tenant_v1', true);
    console.log(`[db] 多租户：租户库已存在，跳过迁移（${path.basename(finalPath)}）`);
    return;
  }
  const tmpPath = finalPath + '.tmp';
  try { fs.unlinkSync(tmpPath); } catch {}
  const t = openDatabase(tmpPath);
  try {
    initBusinessSchema(t);
    let total = 0;
    const tx = t.transaction(() => {
      for (const name of TENANT_TABLES) total += copyTableRows(db, t, name);
      for (const k of TENANT_SETTING_KEYS) {
        const row = db.prepare('SELECT value FROM settings WHERE key=?').get(k);
        if (row) t.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(k, row.value);
      }
    });
    tx();
    // 高德 Key 拆分：旧 settings.commute.key → 主库独立键 amap_key（共享开关默认开）
    const commute = getSetting(db, 'commute', null);
    if (commute && commute.key && !getSetting(db, 'amap_key', '')) {
      setSetting(db, 'amap_key', commute.key);
      console.log('[db] 高德 Key 已从 commute 配置拆分为共享键 amap_key');
    }
    t.close();
    fs.renameSync(tmpPath, finalPath);
    setSetting(db, 'multi_tenant_v1', true);
    console.log(`[db] 多租户迁移完成：存量数据（${total} 行）已复制到 ${path.basename(finalPath)}，归属管理员 ${admin.username}`);
    console.log('[db] 主库业务数据暂保留作过渡（路由切换完成后由 mt_cleanup 清理）');
  } catch (e) {
    try { t.close(); } catch {}
    try { fs.unlinkSync(tmpPath); } catch {}
    console.error('[db] 多租户迁移失败（主库保持原状，下次启动重试）:', e.message);
  }
}

// 一次性清理：路由全部切换到租户库后，清空主库业务表残留（复制式迁移的数据源）。
// 共享模块（news/ai_config）按当前开关决定是否保留。
function cleanupMainBusinessTables() {
  if (getSetting(db, 'mt_cleanup_done', false)) return;
  const flags = getShareFlags();
  const tx = db.transaction(() => {
    for (const name of TENANT_TABLES) {
      if (name === 'news' && flags.news) continue;       // 共享新闻保留在主库
      if (name === 'ai_config' && flags.ai_config) continue; // 共享 AI 配置保留在主库
      try { db.prepare(`DELETE FROM "${name}"`).run(); } catch {}
    }
    // ai_config 预置空行还原（共享关闭后主库该表清空，留结构不留数据）
    for (const k of TENANT_SETTING_KEYS) {
      if (k === 'commute') continue; // commute.key 已拆分到 amap_key；其余通勤字段归租户
      try { db.prepare('DELETE FROM settings WHERE key=?').run(k); } catch {}
    }
  });
  tx();
  setSetting(db, 'mt_cleanup_done', true);
  console.log('[db] 主库业务表残留已清理（多租户切换完成）');
}

// 一次性修复：emails.uid 原无唯一约束 + 旧逻辑只拉最旧30封，导致重复堆积且无正文。
// 清空历史垃圾（IMAP 是源头，重拉即恢复），建 uid 唯一索引让 INSERT OR IGNORE 去重生效。
if (!getSetting(db, 'email_rebuild_done')) {
  try {
    db.exec('DELETE FROM emails');
    // v1.7.0 多邮箱：去重索引改为 (account_id, uid) 组合唯一（建/删统一在 initBusinessSchema 处理）
    setSetting(db, 'email_rebuild_done', true);
    console.log('[db] 邮件表已清空（历史重复数据修复）');
  } catch (e) { console.warn('[db] 邮件表迁移失败:', e.message); }
}

// ---------- 历史数据迁移（异步执行，不阻塞服务启动） ----------
// 宿主写监控使逐行 INSERT 较慢，若同步导入会阻塞事件循环（服务看似卡死）。
// 改为 setImmediate 后台导入：服务立即监听，数据导入完成前各表为空，完成后自动就绪。
let importedCbs = [];
function onImported(cb) { importedCbs.push(cb); }

setImmediate(() => {
// 迁移导入：MIGRATE_FROM=<旧库路径> 时，若当前库为空则从旧库导入全部数据。
// 未显式指定时，自动选取 data 目录中最近一次的历史库（时间戳命名天然有序）。
// 注意：tenant-*.sqlite 是多租户租户库，绝不可当作历史库导入。
const migrateFrom = process.env.MIGRATE_FROM ||
  (() => {
    // 自动选择迁移源：优先"修改时间最新"的库（即上次运行库，数据延续最准确）；
    // 若最新库行数过少（空链库），回退为"行数最多"的库。
    const olds = fs.readdirSync(dataDir)
      .filter((f) => f.endsWith('.sqlite') && f !== dbFile && !f.startsWith('tenant-') && !f.includes('old') && !f.includes('bak'))
      .map((f) => ({ p: path.join(dataDir, f), m: fs.statSync(path.join(dataDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);

    const countRows = (p) => {
      try {
        const odb = new DatabaseSync(p, { readOnly: true });
        const tables = odb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        let rows = 0;
        for (const t of tables) {
          try { rows += odb.prepare(`SELECT COUNT(*) c FROM "${t.name}"`).get().c; } catch {}
        }
        odb.close();
        return rows;
      } catch { return 0; }
    };

    if (!olds.length) return null;
    const newestRows = countRows(olds[0].p);
    if (newestRows >= 10) {
      console.log(`[db] 自动选择历史库：${path.basename(olds[0].p)}（最新，${newestRows} 行）`);
      return olds[0].p;
    }
    let best = null, bestRows = -1;
    for (const o of olds) {
      const n = countRows(o.p);
      if (n > bestRows) { best = o.p; bestRows = n; }
    }
    if (bestRows > 0) console.log(`[db] 自动选择历史库：${path.basename(best)}（最重，${bestRows} 行）`);
    return bestRows > 0 ? best : null;
  })();
// 迁移一次性：首次导入后历史库被归档（见下方 archive 逻辑），data/ 顶层不再有时间戳库，
// migrateFrom 自然为 null；per-table 的 cnt>0 检查也兜底防止重复导入。
if (migrateFrom && fs.existsSync(migrateFrom)) {
  const oldDb = new DatabaseSync(migrateFrom, { readOnly: true });
  const tables = oldDb.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('t','_wtest')"
  ).all();
  // 单行配置表的"关键字段"（仅这些字段有值才算真实配置）
  const CONFIG_KEY_FIELDS = {
    email_config: ['imap_host', 'imap_user', 'imap_pass'],
    ai_config: ['model', 'base_url', 'api_key'],
  };
  const isPresetEmptyRow = (tname, rows) => {
    const keys = CONFIG_KEY_FIELDS[tname];
    if (!keys || !rows.length) return false;
    return rows.every((r) => keys.every((k) => !r[k]));
  };
  let total = 0;
  for (const t of tables) {
    try {
      const targetRows = db.prepare(`SELECT * FROM "${t.name}"`).all();
      // 修复：email_config/ai_config 等单行配置表建表时预置了空行（id=1），
      // 若目标表只有空配置行则先清空，保证旧库的真实配置能导入（否则配置丢失）
      if (isPresetEmptyRow(t.name, targetRows)) {
        db.prepare(`DELETE FROM "${t.name}"`).run();
        console.log(`[db]   清空 ${t.name} 的预置空配置行`);
      }
      const cnt = db.prepare(`SELECT COUNT(*) c FROM "${t.name}"`).get().c;
      if (cnt > 0) continue;
      const rows = oldDb.prepare(`SELECT * FROM "${t.name}"`).all();
      if (!rows.length) continue;
      const cols = Object.keys(rows[0]).map((c) => `"${c}"`).join(',');
      const ph = Object.keys(rows[0]).map(() => '?').join(',');
      const ins = db.prepare(`INSERT INTO "${t.name}" (${cols}) VALUES (${ph})`);
      for (const r of rows) ins.run(...Object.values(r));
      total += rows.length;
      console.log(`[db]   导入 ${t.name}: ${rows.length} 行`);
    } catch (e) {
      console.warn(`[db] 导入 ${t.name} 失败: ${e.message}`);
    }
  }
  console.log(`[db] 已从 ${migrateFrom} 导入 ${total} 行数据`);
  oldDb.close();
} else {
  console.log('[db] 无历史库可迁移（稳定库已就绪或全新部署）');
}

// 多租户存量迁移：在历史库导入之后执行（保证旧数据已进主库再复制给管理员租户）
migrateToMultiTenant();

// 收尾清理：清空主库业务表残留（一次性守卫 mt_cleanup_done；租户库已各就各位）
cleanupMainBusinessTables();

// 一次性迁移：「AI 推送」页并入「业务系统」页（守卫 push_merge_v1）
// 受限用户的 allowed_pages 里 'push' → 'business'；allowed_tabs.push 的细分并入 business
function migratePushIntoBusiness() {
  if (getSetting(db, 'push_merge_v1', false)) return;
  const users = db.prepare('SELECT id, allowed_pages, allowed_tabs FROM users').all();
  const ORDER = ['sys', 'skill', 'push', 'config'];
  for (const u of users) {
    let pages;
    try { pages = JSON.parse(u.allowed_pages || '[]'); } catch { pages = []; }
    let tabs;
    try { tabs = JSON.parse(u.allowed_tabs || '{}'); } catch { tabs = {}; }
    let changed = false;
    if (Array.isArray(pages) && pages.includes('push')) {
      pages = pages.filter((p) => p !== 'push');
      if (!pages.includes('business')) pages.push('business');
      changed = true;
    }
    if (tabs && typeof tabs === 'object' && 'push' in tabs) {
      const from = Array.isArray(tabs.push) ? tabs.push : [];
      const cur = Array.isArray(tabs.business) ? tabs.business : [];
      tabs.business = ORDER.filter((t) => cur.includes(t) || from.includes(t))
        .concat(cur.filter((t) => !ORDER.includes(t)), from.filter((t) => !ORDER.includes(t) && !cur.includes(t)));
      delete tabs.push;
      changed = true;
    }
    if (changed) db.prepare('UPDATE users SET allowed_pages=?, allowed_tabs=? WHERE id=?')
      .run(JSON.stringify(pages), JSON.stringify(tabs), u.id);
  }
  setSetting(db, 'push_merge_v1', true);
  console.log('[db] 「AI 推送」页已并入「业务系统」页（用户授权已迁移）');
}
migratePushIntoBusiness();

// 一次性迁移：「打字赚钱」页 4 个 tab 并入「学习」页（2026-09 v1.2.0）；
// 「学习计划/学习记录/复盘」3 个 tab 移到「效率工具」页。
// allowed_pages 里的 typing → learning；allowed_tabs.typing → 并入 learning（tab 键不变）；
// learning 的 plans/records/review 键 → 移到 tools 键下。
function migrateTypingIntoLearning() {
  if (getSetting(db, 'typing_merge_v1', false)) return;
  setSetting(db, 'typing_merge_v1', true);
  const MOVED = ['plans', 'records', 'review']; // learning → tools
  const users = db.prepare('SELECT id, allowed_pages, allowed_tabs FROM users').all();
  for (const u of users) {
    let pages;
    try { pages = JSON.parse(u.allowed_pages || '[]'); } catch { pages = []; }
    let tabs;
    try { tabs = JSON.parse(u.allowed_tabs || '{}'); } catch { tabs = {}; }
    let changed = false;
    const hadTypingPage = Array.isArray(pages) && pages.includes('typing');
    if (hadTypingPage) {
      pages = pages.filter((p) => p !== 'typing');
      if (!pages.includes('learning')) pages.push('learning');
      changed = true;
    }
    if (tabs && typeof tabs === 'object') {
      if (Array.isArray(tabs.typing)) {
        const cur = Array.isArray(tabs.learning) ? tabs.learning : [];
        tabs.learning = [...new Set([...cur, ...tabs.typing])];
        delete tabs.typing;
        changed = true;
      } else if (hadTypingPage && Array.isArray(tabs.learning)) {
        // 原打字页未做 tab 细分（=4 个 tab 全开）但学习页有细分：
        // 把打字的 4 个 tab 键并入学习细分，避免合并后反而丢权限
        tabs.learning = [...new Set([...tabs.learning, 'practice', 'records', 'money', 'payout'])];
        changed = true;
      }
      // learning 的计划/记录/复盘细分迁到 tools（tools 原本无 tab 细分定义，直接带上）
      if (Array.isArray(tabs.learning)) {
        const moved = tabs.learning.filter((t) => MOVED.includes(t));
        if (moved.length) {
          tabs.learning = tabs.learning.filter((t) => !MOVED.includes(t));
          const curTools = Array.isArray(tabs.tools) ? tabs.tools : null;
          tabs.tools = curTools ? [...new Set([...curTools, ...moved])] : moved;
          changed = true;
        }
      }
    }
    if (changed) db.prepare('UPDATE users SET allowed_pages=?, allowed_tabs=? WHERE id=?')
      .run(JSON.stringify(pages), JSON.stringify(tabs), u.id);
  }
  console.log('[db] 「打字赚钱」已并入「学习」页、「计划/记录/复盘」已移至「效率工具」（用户授权已迁移）');
}
migrateTypingIntoLearning();

// 一次性迁移（2026-09 v1.6.5）：「语音配音」tab 从「学习」页移到「效率工具」页最后一个 tab。
// allowed_tabs.learning 细分里勾了 'tts' → 挪到 tools 细分；learning 原无细分（=该页全开，tts 隐式可用）
// 但 tools 有细分且不含 tts、且用户有学习页权限 → 补进 tools 细分（避免移页后反而丢权限，同打字迁移语义）。
// 主库 + 全部租户库都跑（幂等，tts_merge_v165 标记）。
function migrateTtsToTools() {
  const fix = (d) => {
    if (getSetting(d, 'tts_merge_v165', false)) return;
    setSetting(d, 'tts_merge_v165', true);
    const users = d.prepare('SELECT id, allowed_pages, allowed_tabs FROM users').all();
    for (const u of users) {
      let pages;
      try { pages = JSON.parse(u.allowed_pages || '[]'); } catch { pages = []; }
      let tabs;
      try { tabs = JSON.parse(u.allowed_tabs || '{}'); } catch { tabs = {}; }
      let changed = false;
      const learnList = Array.isArray(tabs.learning) ? tabs.learning : null;
      const toolsList = Array.isArray(tabs.tools) ? tabs.tools : null;
      if (learnList && learnList.includes('tts')) {
        tabs.learning = learnList.filter((t) => t !== 'tts');
        tabs.tools = toolsList ? [...new Set([...toolsList, 'tts'])] : ['tts'];
        changed = true;
      } else if (!learnList && toolsList && !toolsList.includes('tts')
        && (!Array.isArray(pages) || pages.length === 0 || pages.includes('learning'))) {
        tabs.tools = [...toolsList, 'tts'];
        changed = true;
      }
      if (changed) d.prepare('UPDATE users SET allowed_tabs=? WHERE id=?').run(JSON.stringify(tabs), u.id);
    }
  };
  fix(db);
  forEachTenant(fix);
  console.log('[db] 「语音配音」tab 已从「学习」页移至「效率工具」页（用户授权已迁移）');
}
migrateTtsToTools();

// 一次性迁移（2026-09 v1.7.0）：模块重组并入 tab ——
//   业务系统(推送任务)/文件存档/全局搜索 → 「效率工具」页 tab；
//   个人账务 → 「家庭管理」页最后一个 tab；用户管理 → 「设置」页 tab。
// 页面权限随之迁移：allowed_pages 的 business/files/search → tools、pay → family、users → settings；
// tab 细分合并：tabs.business(→tools) / tabs.pay(→family)（无细分=全开的语义保持不变）。
function migrateV170Pages() {
  const PAGE_TO = { business: 'tools', files: 'tools', search: 'tools', pay: 'family', users: 'settings' };
  const TAB_TO = { business: ['tools'], pay: ['family'] };
  const fix = (d) => {
    if (getSetting(d, 'pages_merge_v170', false)) return;
    setSetting(d, 'pages_merge_v170', true);
    const users = (() => { try { return d.prepare('SELECT id, allowed_pages, allowed_tabs FROM users').all(); } catch { return []; } })();
    for (const u of users) {
      let pages;
      try { pages = JSON.parse(u.allowed_pages || '[]'); } catch { pages = []; }
      let tabs;
      try { tabs = JSON.parse(u.allowed_tabs || '{}'); } catch { tabs = {}; }
      let changed = false;
      if (Array.isArray(pages) && pages.length) {
        const out = [];
        for (const p of pages) {
          const to = PAGE_TO[p];
          if (to) { if (!out.includes(to)) out.push(to); changed = true; }
          else out.push(p);
        }
        pages = out;
      }
      if (tabs && typeof tabs === 'object') {
        for (const [from, tos] of Object.entries(TAB_TO)) {
          if (!(from in tabs) || !Array.isArray(tabs[from])) continue;
          const fromList = tabs[from];
          delete tabs[from];
          for (const to of tos) {
            const cur = Array.isArray(tabs[to]) ? tabs[to] : null;
            tabs[to] = cur ? [...new Set([...cur, ...fromList])] : [...new Set(fromList)];
          }
          changed = true;
        }
      }
      if (changed) d.prepare('UPDATE users SET allowed_pages=?, allowed_tabs=? WHERE id=?')
        .run(JSON.stringify(pages), JSON.stringify(tabs), u.id);
    }
  };
  fix(db);
  forEachTenant(fix);
  console.log('[db] v1.7.0 模块重组授权迁移完成（业务系统/文件存档/全局搜索→效率工具，个人账务→家庭管理，用户管理→设置）');
}
migrateV170Pages();

// 一次性迁移（2026-09 v1.6.2）：①剪贴板采集代理——老库补 clipboard_items.device 列 + clipboard_devices 表
// （主库 + 全部租户库，幂等）；②三大测试中心从「效率工具」页移到新页「私有项目」，用户授权随之迁移。
function migrateClipboardAgent() {
  const fix = (d) => {
    addCol(d, 'clipboard_items', 'device', "TEXT DEFAULT ''");
    d.exec(`CREATE TABLE IF NOT EXISTS clipboard_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host TEXT NOT NULL UNIQUE,
      first_seen INTEGER DEFAULT 0,
      last_seen INTEGER DEFAULT 0,
      push_count INTEGER DEFAULT 0
    )`);
  };
  fix(db);
  forEachTenant(fix);
}
migrateClipboardAgent();

// 一次性清理（2026-09 v1.6.29）：智能家居「监控」tab 与摄像头事件凭证通道下线——
// 删除已注入的 micam_creds 密文（凭证存在主库 settings，租户库一并兜底清理；DELETE 幂等）。
(function cleanupMicamCreds() {
  if (getSetting(db, 'micam_cleanup_v1', false)) return;
  setSetting(db, 'micam_cleanup_v1', true);
  const fix = (d) => { try { d.prepare("DELETE FROM settings WHERE key='micam_creds'").run(); } catch { /* 无 settings 表则跳过 */ } };
  fix(db);
  forEachTenant(fix);
  console.log('[db] 摄像头事件凭证（micam_creds）已随监控功能下线清理');
})();

function migrateTestsIntoPrivate() {
  if (getSetting(db, 'tests_move_private_v1', false)) return;
  setSetting(db, 'tests_move_private_v1', true);
  const MOVED = ['dep', 'pro', 'mbti'];
  const users = db.prepare('SELECT id, allowed_pages, allowed_tabs FROM users').all();
  for (const u of users) {
    let pages;
    try { pages = JSON.parse(u.allowed_pages || '[]'); } catch { pages = []; }
    let tabs;
    try { tabs = JSON.parse(u.allowed_tabs || '{}'); } catch { tabs = {}; }
    let changed = false;
    // 页受限且含 tools 的用户补 private 页（原来能经 tools 用测试中心的，迁移后保持能用）
    if (Array.isArray(pages) && pages.length && pages.includes('tools')) {
      if (!pages.includes('private')) { pages.push('private'); changed = true; }
    }
    // tools 有 tab 细分（受限列表）的：三个测试键移到 private 细分。
    // private 一律落成数组（哪怕空数组）：tools 细分原本为空=测试中心全关的用户，不能因迁移反而放开
    if (tabs && typeof tabs === 'object' && Array.isArray(tabs.tools)) {
      const moved = tabs.tools.filter((t) => MOVED.includes(t));
      tabs.tools = tabs.tools.filter((t) => !MOVED.includes(t));
      const cur = Array.isArray(tabs.private) ? tabs.private : [];
      tabs.private = [...new Set([...cur, ...moved])];
      changed = true;
    }
    if (changed) db.prepare('UPDATE users SET allowed_pages=?, allowed_tabs=? WHERE id=?')
      .run(JSON.stringify(pages), JSON.stringify(tabs), u.id);
  }
  console.log('[db] 三大测试中心已移至「私有项目」页（用户授权已迁移）');
}
migrateTestsIntoPrivate();

// 家庭共享底账初始化（一次性，守卫 family_share_v1；函数定义在模块层，见文件尾）
migrateFamilyShare();

// 管理员改名：RENAME_USER=旧名:新名（如 user1:admin）
// 用于在服务进程内修改账号名（宿主写保护下外部进程无法改库）
const renameUser = process.env.RENAME_USER;
if (renameUser && renameUser.includes(':')) {
  const [oldName, newName] = renameUser.split(':').map((s) => s.trim());
  const r = db.prepare('UPDATE users SET username=? WHERE username=? AND role=?').run(newName, oldName, 'admin');
  console.log(`[db] 管理员账号改名：${oldName} → ${newName}${r.changes ? '' : '（未找到，跳过）'}`);
}

// 一次性归档：稳定单库就绪后，把历史累积的库文件（qg-*.sqlite、旧命名库、测试残留）
// 移入 data/archive/<时间戳>/。仅执行一次（settings 标记），移动而非删除，可恢复。
// 注意：tenant-*.sqlite 是活跃租户库，绝不可归档。
if (!getSetting(db, 'stable_db_archived', false)) {
  try {
    const ts = new Date().toISOString().replace(/[-T:]/g, '').slice(0, 14);
    const archiveDir = path.join(dataDir, 'archive', ts);
    fs.mkdirSync(archiveDir, { recursive: true });
    let moved = 0;
    for (const f of fs.readdirSync(dataDir)) {
      if (f === dbFile || f.startsWith('tenant-')) continue; // 保留活跃库与租户库
      const full = path.join(dataDir, f);
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) continue;       // 跳过 archive/ 等子目录
      // 只搬数据库相关文件：.sqlite/.db/.old/.bak/.test-backup/-wal/-shm
      if (!/\.(sqlite|db)$/.test(f) && !/\.(old|bak|test-backup)/.test(f) && !/-wal/.test(f) && !/-shm/.test(f)) continue;
      try { fs.renameSync(full, path.join(archiveDir, f)); moved++; } catch (e) { console.warn(`[db] 归档失败 ${f}: ${e.message}`); }
    }
    setSetting(db, 'stable_db_archived', true);
    if (moved) console.log(`[db] 已归档 ${moved} 个历史库/残留 → data/archive/${ts}`);
  } catch (e) {
    console.warn('[db] 归档历史库失败:', e.message);
  }
}

for (const cb of importedCbs) cb();
});

// ---------- 家庭与子女数据共享 ----------
// 家庭数据是"多人协作"型（全家共看共记一份），与 news（管理员维护全员只读）不同：
// 开=全员读主库同一份（都可读写）；关=各回各的租户库。
// 切换时重平衡（rebalanceFamilyShare）：关=主库共享底账归还第一位管理员；开=以管理员当前数据重建底账。
// 首次启用（migrateFamilyShare，守卫 family_share_v1）：把第一位管理员的租户家庭数据复制到主库作共享底账。
const FAMILY_TABLES = ['family_items', 'kids', 'kid_tasks', 'family_profiles', 'family_images'];
function firstAdmin() { return db.prepare("SELECT id, username FROM users WHERE role='admin' ORDER BY id LIMIT 1").get(); }
// 整表镜像复制（replace=先清空目标表再插，保留原 id，消息中心 ref_id 引用不失效）
function copyFamilyTables(src, dst, replace) {
  let n = 0;
  for (const t of FAMILY_TABLES) {
    if (replace) dst.prepare(`DELETE FROM "${t}"`).run();
    n += copyTableRows(src, dst, t);
  }
  return n;
}
function migrateFamilyShare() {
  if (getSetting(db, 'family_share_v1', false)) return;
  setSetting(db, 'family_share_v1', true);
  const admin = firstAdmin();
  if (!admin) { console.log('[db] 家庭共享初始化：无管理员，跳过'); return; }
  const tf = tenantDbFile(admin.id);
  if (!fs.existsSync(tf)) { console.log('[db] 家庭共享初始化：管理员租户库不存在，跳过'); return; }
  // 仅当主库家庭表为空才导入（防重启覆盖主库已共享的新数据）
  const hasData = FAMILY_TABLES.some((t) => db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c > 0);
  if (hasData) { console.log('[db] 家庭共享初始化：主库已有家庭数据，跳过导入'); return; }
  const tdb = openDatabase(tf);
  try {
    const n = copyFamilyTables(tdb, db, false);
    console.log(`[db] 家庭共享初始化：已复制管理员 ${admin.username} 的家庭数据 ${n} 行到主库（共享底账，租户副本保留）`);
  } finally { tdb.close(); }
}
// 开关切换时的数据重平衡（由 PUT /share-config 调用）
function rebalanceFamilyShare(on) {
  const admin = firstAdmin();
  if (!admin) return;
  const tdb = getTenantDb(admin.id);
  if (on) {
    const n = copyFamilyTables(tdb, db, true);
    console.log(`[db] 家庭共享开启：以管理员 ${admin.username} 的 ${n} 行数据重建共享底账`);
  } else {
    const n = copyFamilyTables(db, tdb, true);
    console.log(`[db] 家庭共享关闭：共享底账 ${n} 行已归还管理员 ${admin.username} 的租户库（其余成员回到各自独立数据）`);
  }
}

module.exports = {
  db, dbFile, dataDir, onImported,
  openDatabase, initBusinessSchema,
  getSetting, setSetting, getSettingR, setSettingR,
  getShareFlags, setShareFlags, routedDb, routedSettingDb,
  getAmapKey, saveAmapKey,
  getTenantDb, closeTenantDb, tenantIdOf, listTenantDbs, forEachTenant, tenantDbFile,
  TENANT_TABLES, TENANT_SETTING_KEYS,
  migrateToMultiTenant, cleanupMainBusinessTables,
  rebalanceFamilyShare, ensureDingtalkBot,
};
