// AI 密钥静态加密（AES-256-GCM）
// 密钥存 data/secret.key（首次自动生成）。数据库中的 ai_key 以 "enc:v1:" 前缀密文存储；
// 备份时必须连同 data/secret.key 一起备份，否则无法解密。
// 兼容策略：读到无前缀的旧明文按明文使用（升级无感），下次保存时自动转为密文。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../db');

const KEY_FILE = process.env.SECRET_KEY_FILE || path.join(DATA_DIR, 'secret.key');
const PREFIX = 'enc:v1:';
let cachedKey = null;

function getKey() {
  if (cachedKey) return cachedKey;
  try {
    const raw = fs.readFileSync(KEY_FILE, 'utf8').trim();
    const k = Buffer.from(raw, 'hex');
    if (k.length === 32) { cachedKey = k; return k; }
  } catch { /* 不存在或损坏 → 重新生成 */ }
  cachedKey = crypto.randomBytes(32);
  fs.writeFileSync(KEY_FILE, cachedKey.toString('hex'));
  return cachedKey;
}

function encrypt(plain) {
  const s = String(plain || '');
  if (!s || s.startsWith(PREFIX)) return s;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(s, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + iv.toString('base64') + '.' + tag.toString('base64') + '.' + enc.toString('base64');
}

function decrypt(stored) {
  const s = String(stored || '');
  if (!s) return s;
  if (!s.startsWith(PREFIX)) return s; // 旧明文，直接用
  try {
    const [iv, tag, data] = s.slice(PREFIX.length).split('.').map(x => Buffer.from(x, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString('utf8');
  } catch {
    return ''; // 解密失败（密钥文件丢失/不匹配）→ 视为未配置
  }
}

module.exports = { encrypt, decrypt };
