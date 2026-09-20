// 全局默认上传保存路径（设置界面配置，主库全局生效）：
// 所有「没有专属配置目录」的上传（家庭图床图片 / AI 聊天附件 / 账单导入文件，
// 以及文件存档、邮件附件未配专属目录时的回落）都默认保存到这里，按子目录自动分类。
// 设计原则：尽力而为——目录未配置或写盘失败时静默回退旧行为（存库/不落盘），绝不阻塞业务。
const fs = require('fs');
const path = require('path');
const { db, getSetting, setSetting } = require('../db');

const KEY = 'upload_root';

// 全局根目录（未配置返回 ''）
function getUploadRoot() {
  return String(getSetting(db, KEY, '') || '').trim();
}

function saveUploadRoot(dir) {
  setSetting(db, KEY, String(dir || '').trim());
}

// 取分类子目录绝对路径并确保存在（如 {root}/family-images）；根未配置返回 null
function uploadSubDir(sub) {
  const root = getUploadRoot();
  if (!root) return null;
  const p = path.join(root, sub);
  try { fs.mkdirSync(p, { recursive: true }); return p; }
  catch (e) { console.warn(`[storage] 创建上传子目录失败(${p}): ${e.message}`); return null; }
}

// 尽力保存一份文件副本：返回绝对路径；根未配置/写失败返回 ''（永不抛）
// prefix 用于多租户共用目录时防撞名（如 t3_）
function bestEffortSave(sub, name, buf, prefix) {
  try {
    const dir = uploadSubDir(sub);
    if (!dir || !buf || !buf.length) return '';
    const safe = String(name || 'file').replace(/[\\/:*?"<>|\r\n\t]+/g, '_').trim().slice(-80) || 'file';
    const full = path.join(dir, `${prefix || ''}${Date.now()}_${safe}`);
    fs.writeFileSync(full, buf);
    return full;
  } catch (e) { console.warn(`[storage] 上传副本写盘失败(${sub}): ${e.message}`); return ''; }
}

module.exports = { getUploadRoot, saveUploadRoot, uploadSubDir, bestEffortSave };
