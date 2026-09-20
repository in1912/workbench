// E2E：全局默认上传保存路径（设置 → 全局默认上传保存路径）
// 覆盖：权限（仅管理员）/ 非法目录校验 / 家庭图床落盘+老数据回退 / 文件存档回落 / AI 附件留档 /
//       邮件附件回落（直接调服务函数）/ 清空后恢复旧行为
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const { getTenantDb, closeTenantDb } = await import('../server/db.js');

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };
const j = (r) => r.json();
const B = 'http://localhost:3000/api';
const ROOT = path.resolve('data/e2e-up-root');

// 临时用户（图床/文件/AI 附件都用他，不碰真实成员）；管理员配置全局路径
db.prepare("INSERT INTO users(username,password_hash,role,allowed_pages,is_bot) VALUES('e2e_tmp_up','','user','[]',0)").run();
const uidU = db.prepare('SELECT id FROM users WHERE username=?').get('e2e_tmp_up').id;
const mkTok = (uid) => {
  const t = crypto.randomBytes(24).toString('hex');
  db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+30 minutes'))").run(t, uid);
  return t;
};
const tU = mkTok(uidU);
const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const tA = mkTok(admin.id);
const H = (t) => ({ Authorization: 'Bearer ' + t });
const HJ = (t) => ({ ...H(t), 'Content-Type': 'application/json' });

// 1x1 透明 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const famIds = []; // 创建的图床行 id（finally 清理）
let fileRow = null; // 文件存档行

try {
  // ===== 权限与校验 =====
  const noPerm = await fetch(B + '/settings/upload-root', { method: 'POST', headers: HJ(tU), body: JSON.stringify({ dir: ROOT }) });
  ck('非管理员不可配置（403）', noPerm.status === 403, String(noPerm.status));
  const bad = await fetch(B + '/settings/upload-root', { method: 'POST', headers: HJ(tA), body: JSON.stringify({ dir: path.resolve('data/workbench.sqlite') }) });
  ck('非法目录（库文件当目录）被拒 400', bad.status === 400, String(bad.status));
  const set = await j(await fetch(B + '/settings/upload-root', { method: 'POST', headers: HJ(tA), body: JSON.stringify({ dir: ROOT }) }));
  ck('管理员配置成功', set.ok === true && set.dir === ROOT, JSON.stringify(set));
  const cfg = await j(await fetch(B + '/settings/upload-root', { headers: H(tU) }));
  ck('读取回显一致', cfg.dir === ROOT, JSON.stringify(cfg));

  // ===== 家庭图床：落盘 =====
  const tdbU = getTenantDb(uidU);
  const famDbOf = (id) => db.prepare('SELECT * FROM family_images WHERE id=?').get(id) || tdbU.prepare('SELECT * FROM family_images WHERE id=?').get(id);
  const img = await j(await fetch(B + '/family-images', { method: 'POST', headers: HJ(tU), body: JSON.stringify({ data: PNG.toString('base64'), mime: 'image/png' }) }));
  famIds.push(Number(img.id));
  ck('图床上传返回 id', Number(img.id) > 0, JSON.stringify(img));
  const row = famDbOf(img.id);
  ck('图片落盘（{root}/family-images、库里无 base64）', !!row && !!row.storage_path && row.storage_path.startsWith(path.join(ROOT, 'family-images')) && !(row.data || ''), JSON.stringify({ sp: row && row.storage_path, dlen: (row && row.data || '').length }));
  ck('磁盘文件字节一致', row.storage_path && fs.existsSync(row.storage_path) && fs.readFileSync(row.storage_path).equals(PNG));
  const served = Buffer.from(await (await fetch(B + '/family-images/' + img.id, { headers: H(tU) })).arrayBuffer());
  ck('GET 走磁盘返回原图', served.equals(PNG), `${served.length} vs ${PNG.length}`);
  // 老 base64 行照常服务（回退）
  const famTarget = db.prepare('SELECT id FROM family_images WHERE id=?').get(img.id) ? db : tdbU; // 与新行同库（共享开关决定）
  const oldR = famTarget.prepare("INSERT INTO family_images(mime,size,data,storage_path) VALUES('image/png',?,?,'')").run(PNG.length, PNG.toString('base64'));
  famIds.push(Number(oldR.lastInsertRowid));
  const servedOld = Buffer.from(await (await fetch(B + '/family-images/' + oldR.lastInsertRowid, { headers: H(tU) })).arrayBuffer());
  ck('老 base64 数据照常服务', servedOld.equals(PNG));

  // ===== 文件存档：专属目录留空 → 回落 {root}/files =====
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), '测试档案.png');
  const up = await j(await fetch(B + '/files/upload', { method: 'POST', headers: H(tU), body: fd }));
  ck('文件上传成功', Number(up.id) > 0, JSON.stringify(up));
  fileRow = tdbU.prepare('SELECT * FROM files WHERE id=?').get(up.id);
  ck('文件落 {root}/files（库里无 base64）', !!fileRow && !!fileRow.storage_path && fileRow.storage_path.startsWith(path.join(ROOT, 'files')) && !(fileRow.content || ''), fileRow && fileRow.storage_path);
  const dl = Buffer.from(await (await fetch(B + `/files/${up.id}/download`, { headers: H(tU) })).arrayBuffer());
  ck('下载字节一致', dl.equals(PNG));

  // ===== AI 聊天附件留档 =====
  const fd2 = new FormData();
  fd2.append('file', new Blob([PNG], { type: 'image/png' }), '聊天图.png');
  const ai = await j(await fetch(B + '/ai/attachment', { method: 'POST', headers: H(tU), body: fd2 }));
  ck('AI 附件接口正常返回', ai.kind === 'image' && ai.name === '聊天图.png', JSON.stringify(ai.kind));
  const aiFiles = fs.readdirSync(path.join(ROOT, 'ai-attachments'));
  ck('AI 附件已留档到 {root}/ai-attachments', aiFiles.some((f) => f.includes('聊天图.png')), aiFiles.join(','));

  // ===== 邮件附件：专属目录留空 → 回落（直接调服务函数，不依赖 IMAP）=====
  const emailService = await import('../server/services/emailService.js');
  const att = emailService.saveAttachment(tdbU, uidU, { filename: '测试附件.txt', buf: Buffer.from('hello 附件') });
  ck('邮件附件落盘（stored=1）', att.stored === 1 && !!att.path && att.path.includes('测试附件.txt'), JSON.stringify(att));
  const attFull = emailService.attachmentFullPath(tdbU, att.path);
  ck('附件路径解析指向 {root}/email-attachments', !!attFull && attFull.startsWith(path.join(ROOT, 'email-attachments')) && fs.existsSync(attFull), attFull || '(null)');

  // ===== 清空全局路径 → 恢复旧行为 =====
  await fetch(B + '/settings/upload-root', { method: 'POST', headers: HJ(tA), body: JSON.stringify({ dir: '' }) });
  const img2 = await j(await fetch(B + '/family-images', { method: 'POST', headers: HJ(tU), body: JSON.stringify({ data: PNG.toString('base64'), mime: 'image/png' }) }));
  famIds.push(Number(img2.id));
  const row2 = famDbOf(img2.id);
  ck('清空后回退旧行为（base64 入库）', !!row2 && !row2.storage_path && !!(row2.data || ''), JSON.stringify({ sp: row2 && row2.storage_path, dlen: (row2 && row2.data || '').length }));

  console.log(`\n${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  db.prepare('DELETE FROM sessions WHERE user_id=?').run(uidU);
  db.prepare('DELETE FROM sessions WHERE token=?').run(tA);
  for (const id of famIds) { // 图床行（可能在主库或租户库，删不到就算了）
    try { db.prepare('DELETE FROM family_images WHERE id=?').run(id); } catch {}
    try { getTenantDb(uidU).prepare('DELETE FROM family_images WHERE id=?').run(id); } catch {}
  }
  try {
    if (fileRow && fileRow.storage_path) { try { fs.unlinkSync(fileRow.storage_path); } catch {} }
    getTenantDb(uidU).prepare('DELETE FROM files WHERE id=?').run(fileRow ? fileRow.id : -1);
    closeTenantDb(uidU);
  } catch {}
  db.prepare('DELETE FROM users WHERE id=?').run(uidU);
  try { fs.unlinkSync(`data/tenant-${uidU}.sqlite`); } catch { /* 服务进程占用则留空壳（内容已清） */ }
  fs.rmSync(ROOT, { recursive: true, force: true }); // 测试落盘目录整体移除
}
