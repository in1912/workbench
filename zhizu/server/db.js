// 文案库数据库（node:sqlite，稳定单库）
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'wenanku.sqlite');

const db = new DatabaseSync(DB_FILE);

db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  display_name TEXT NOT NULL DEFAULT '',
  nickname TEXT NOT NULL DEFAULT '',
  bio TEXT NOT NULL DEFAULT '',
  avatar TEXT NOT NULL DEFAULT '',
  industry_persona TEXT NOT NULL DEFAULT '',
  ai_base TEXT NOT NULL DEFAULT '',
  ai_model TEXT NOT NULL DEFAULT '',
  ai_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gen_records(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  feature TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  inputs TEXT NOT NULL DEFAULT '',
  output TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  fav INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_records_user ON gen_records(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS sensitive_words(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'common',
  category TEXT NOT NULL DEFAULT '未分类',
  severity TEXT NOT NULL DEFAULT '中',
  description TEXT NOT NULL DEFAULT '',
  suggestion TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_sw_platform ON sensitive_words(platform, category);

CREATE TABLE IF NOT EXISTS regs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '法律',
  issuer TEXT NOT NULL DEFAULT '',
  doc_no TEXT NOT NULL DEFAULT '',
  publish_date TEXT NOT NULL DEFAULT '',
  effective_date TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  key_points TEXT NOT NULL DEFAULT '[]',
  url TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS scan_records(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  text_len INTEGER NOT NULL DEFAULT 0,
  platforms TEXT NOT NULL DEFAULT '',
  total_hits INTEGER NOT NULL DEFAULT 0,
  high_hits INTEGER NOT NULL DEFAULT 0,
  med_hits INTEGER NOT NULL DEFAULT 0,
  low_hits INTEGER NOT NULL DEFAULT 0,
  detail TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_scan_user ON scan_records(user_id, id DESC);
`);

// ---- settings 读写（值存 JSON 编码）----
function getSetting(key, def = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  if (!row) return def;
  try { return JSON.parse(row.value); } catch { return row.value; }
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, JSON.stringify(value));
}

// v1.2 用户级 AI 选题定时配置（存量库自动补列）
for (const [col, def] of [
  ['ai_topic_industries', "TEXT NOT NULL DEFAULT '[]'"], // 定时生成的行业 JSON 数组
  ['ai_topic_time', "TEXT NOT NULL DEFAULT ''"],         // 每日生成时间 HH:MM
  ['ai_topic_last', "TEXT NOT NULL DEFAULT ''"],         // 上次定时执行日期（防重复）
]) {
  const has = db.prepare('PRAGMA table_info(users)').all().some(c => c.name === col);
  if (!has) db.prepare(`ALTER TABLE users ADD COLUMN ${col} ${def}`).run();
}

// v1.3 敏感词检测历史：保存检测原文（历史页对照高亮用）
if (!db.prepare('PRAGMA table_info(scan_records)').all().some(c => c.name === 'original_text')) {
  db.prepare("ALTER TABLE scan_records ADD COLUMN original_text TEXT NOT NULL DEFAULT ''").run();
}

module.exports = { db, getSetting, setSetting, DATA_DIR };
