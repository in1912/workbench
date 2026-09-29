const { ImapFlow } = require('imapflow');
// 多租户：邮箱配置/邮件/附件目录全部归租户库（每人可配自己的邮箱）
const { getSetting, setSetting, tenantIdOf } = require('../db');

function getConfig(d) {
  // 兼容旧调用（/settings/email GET、发测试等）：返回 1 号账号配置
  return getAccount(d, 1) || {};
}

// ---------- 多邮箱账号（v1.7.0） ----------
function getAccounts(d) {
  return d.prepare('SELECT * FROM email_accounts ORDER BY id').all();
}
function getAccount(d, id) {
  return d.prepare('SELECT * FROM email_accounts WHERE id=?').get(Number(id) || 0) || null;
}
function accountReady(a) {
  return !!(a && a.imap_host && a.imap_user && a.imap_pass);
}
// 列表给前端：密码不回传（has_pass 标记是否已配）
function accountsView(d) {
  return getAccounts(d).map((a) => ({
    id: a.id, label: a.label || a.imap_user || `邮箱 ${a.id}`,
    imap_host: a.imap_host, imap_port: a.imap_port, imap_user: a.imap_user, has_imap_pass: !!a.imap_pass,
    smtp_host: a.smtp_host, smtp_port: a.smtp_port, smtp_user: a.smtp_user, has_smtp_pass: !!a.smtp_pass,
    smtp_tls: a.smtp_tls, smtp_from_name: a.smtp_from_name, signature: a.signature,
    refresh_minutes: a.refresh_minutes, trash_keep_days: a.trash_keep_days, enabled: a.enabled,
  }));
}
function saveAccount(d, id, cfg) {
  const fields = [
    'label', 'imap_host', 'imap_port', 'imap_user', 'use_tls',
    'smtp_host', 'smtp_port', 'smtp_user', 'smtp_tls', 'smtp_from_name',
    'signature', 'refresh_minutes', 'trash_keep_days', 'enabled',
  ];
  const row = {};
  for (const f of fields) row[f] = cfg[f];
  row.imap_port = Number(cfg.imap_port) || 993;
  row.smtp_port = Number(cfg.smtp_port) || 465;
  row.refresh_minutes = Math.max(5, Number(cfg.refresh_minutes) || 20);
  row.trash_keep_days = Math.max(1, Number(cfg.trash_keep_days) || 30);
  row.enabled = cfg.enabled === 0 || cfg.enabled === false ? 0 : 1;
  // 密码为空 = 不修改（前端掩码回传空串时保留原值）
  row.imap_pass = cfg.imap_pass ? cfg.imap_pass : null;
  row.smtp_pass = cfg.smtp_pass ? cfg.smtp_pass : null;
  if (id) {
    const cur = getAccount(d, id);
    if (!cur) throw new Error('账号不存在');
    d.prepare(
      `UPDATE email_accounts SET label=?, imap_host=?, imap_port=?, imap_user=?, imap_pass=COALESCE(?,imap_pass), use_tls=?,
       smtp_host=?, smtp_port=?, smtp_user=?, smtp_pass=COALESCE(?,smtp_pass), smtp_tls=?, smtp_from_name=?,
       signature=?, refresh_minutes=?, trash_keep_days=?, enabled=? WHERE id=?`
    ).run(
      row.label || '', row.imap_host || '', row.imap_port, row.imap_user || '', row.imap_pass, row.use_tls ? 1 : 0,
      row.smtp_host || '', row.smtp_port, row.smtp_user || '', row.smtp_pass, row.smtp_tls ? 1 : 0, row.smtp_from_name || '',
      row.signature || '', row.refresh_minutes, row.trash_keep_days, row.enabled, id
    );
    return Number(id);
  }
  if (!row.imap_user) throw new Error('请填写 IMAP 账号');
  const r = d.prepare(
    `INSERT INTO email_accounts(label,imap_host,imap_port,imap_user,imap_pass,use_tls,
     smtp_host,smtp_port,smtp_user,smtp_pass,smtp_tls,smtp_from_name,signature,refresh_minutes,trash_keep_days,enabled)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    row.label || '', row.imap_host || '', row.imap_port, row.imap_user || '', row.imap_pass || '', row.use_tls ? 1 : 0,
    row.smtp_host || '', row.smtp_port, row.smtp_user || '', row.smtp_pass || '', row.smtp_tls ? 1 : 0, row.smtp_from_name || '',
    row.signature || '', row.refresh_minutes, row.trash_keep_days, row.enabled
  );
  return Number(r.lastInsertRowid);
}
function deleteAccount(d, id) {
  const tx = d.transaction(() => {
    d.prepare('DELETE FROM emails WHERE account_id=?').run(Number(id));
    d.prepare('DELETE FROM email_accounts WHERE id=?').run(Number(id));
  });
  tx();
}

function saveConfig(d, cfg) {
  // 兼容旧入口（/settings/email POST）：写 1 号账号；无账号时创建
  if (getAccount(d, 1)) saveAccount(d, 1, cfg);
  else saveAccount(d, null, cfg);
}

function isConfigured(d) {
  return getAccounts(d).some(accountReady);
}

// 新邮件提醒设置：{popup:1, sound:0}（弹窗走站内消息通道，提示音由前端播放）
function getNotifyCfg(d) {
  const c = getSetting(d, 'email_notify', null);
  return { popup: c && c.popup !== undefined ? c.popup : 1, sound: c && c.sound !== undefined ? c.sound : 0 };
}
function saveNotifyCfg(d, c) {
  setSetting(d, 'email_notify', { popup: c && c.popup ? 1 : 0, sound: c && c.sound ? 1 : 0 });
}

// 关键词标签规则：[{keyword,label}]（邮件主题+正文命中第一个关键词 → 标题前显示标签）
function getTagRules(d) {
  const list = getSetting(d, 'email_tags', null);
  return Array.isArray(list) ? list.filter((r) => r && r.keyword && r.label) : [];
}
function saveTagRules(d, list) {
  const clean = (Array.isArray(list) ? list : [])
    .map((r) => ({ keyword: String(r.keyword || '').trim(), label: String(r.label || '').trim() }))
    .filter((r) => r.keyword && r.label);
  if (clean.length > 50) throw new Error('标签规则最多 50 条');
  setSetting(d, 'email_tags', clean);
  return clean;
}
// 单封邮件匹配标签（每个邮件只取第一个命中的关键词）
function matchTag(rules, subject, body) {
  for (const r of rules) {
    const k = r.keyword.toLowerCase();
    if (k && (String(subject || '').toLowerCase().includes(k) || String(body || '').toLowerCase().includes(k))) return r.label;
  }
  return '';
}

// 定时拉取入口（供 scheduler 调用，带防重入——按租户库句柄区分）。
// v1.7.0 多邮箱：逐个启用中的账号拉取；uid 为当前租户用户 id（用于新邮件站内提醒，可缺省）。
const refreshing = new Set();
async function refresh(d, uid) {
  if (refreshing.has(d)) return { ok: false, error: '正在拉取中' };
  refreshing.add(d);
  try {
    // v1.2.5 附件解析修复后的一次性自愈：老库里被 '[]' 毒化的邮件自动补拉一次附件
    // （用户要求附件随邮件默认直接拉取，不依赖手动点「补拉附件」——升级后第一次巡检即翻案）
    const heal = !getSetting(d, 'email_att_fix_v125', 0);
    const results = [];
    let total = 0, newTotal = 0;
    for (const acc of getAccounts(d)) {
      if (!acc.enabled || !accountReady(acc)) continue;
      try {
        const r = await listEmails(d, heal ? 50 : 30, { force: heal, accountId: acc.id });
        total += r.length;
        newTotal += r.reduce((s, m) => s + (m.isNew ? 1 : 0), 0);
        results.push({ id: acc.id, label: acc.label || acc.imap_user, count: r.length, new: r.filter((m) => m.isNew).length });
        // 新邮件 → 站内消息弹窗提醒（可在邮箱设置里关掉/开提示音）
        if (uid && r.some((m) => m.isNew) && getNotifyCfg(d).popup) notifyNew(d, uid, acc, r.filter((m) => m.isNew));
      } catch (e) {
        results.push({ id: acc.id, label: acc.label || acc.imap_user, error: e.message });
      }
    }
    if (heal) setSetting(d, 'email_att_fix_v125', 1);
    return { ok: true, count: total, newCount: newTotal, accounts: results };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    refreshing.delete(d);
  }
}

// 新邮件站内提醒：走现有消息弹窗（module=email，点弹窗直达邮箱页对应账号）
function notifyNew(d, uid, acc, mails) {
  try {
    const { db: mainDb } = require('../db');
    const messageService = require('./messageService');
    const subjects = mails.slice(0, 5).map((m) => `· ${m.subject || '（无主题）'}`).join('\n');
    const more = mails.length > 5 ? `\n… 等共 ${mails.length} 封` : '';
    messageService.send(mainDb, {
      from_user: uid, to_user: uid, module: 'email', ext_id: String(acc.id),
      subject: `新邮件 ${mails.length} 封（${acc.label || acc.imap_user}）`,
      content: subjects + more,
    });
  } catch (e) { console.warn('[email] 新邮件提醒发送失败:', e.message); }
}

// ---------- MIME 正文解析（无 mailparser 依赖，直接解析 source） ----------
function stripHtml(h) {
  return String(h)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
// 取指定头部（处理折叠续行）；headerStr 为头区文本
function pickHeader(headerStr, name) {
  const unfolded = headerStr.replace(/\r?\n[ \t]+/g, ' ');
  const m = unfolded.match(new RegExp('^' + name + '\\s*:\\s*(.*)$', 'im'));
  return m ? m[1].trim() : null;
}
// 按 Content-Transfer-Encoding 解码字节为 UTF-8 文本
function decodeBytes(buf, cte) {
  const enc = String(cte || '').toLowerCase().trim();
  if (enc === 'base64') {
    try { return Buffer.from(buf.toString('utf8').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64').toString('utf8'); }
    catch { return buf.toString('utf8'); }
  }
  if (enc === 'quoted-printable') {
    const s = buf.toString('latin1').replace(/=\r?\n/g, '');
    const out = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '=' && /[0-9A-Fa-f]{2}/.test(s.slice(i + 1, i + 3))) { out.push(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
      else out.push(s.charCodeAt(i) & 0xff);
    }
    return Buffer.from(out).toString('utf8');
  }
  return buf.toString('utf8'); // 7bit / 8bit / binary
}
// RFC2047 编码的附件名解码：=?UTF-8?B?...?= / =?GBK?Q?...?=
function decodeMimeFilename(raw) {
  let s = String(raw || '').trim();
  // 相邻编码词之间的空白按 RFC2047 丢弃（分段拼接值里常见，否则文件名中间夹空格）
  s = s.replace(/\?=\s+=\?/g, '?==?');
  // 多段拼接 =?charset?B/Q?...?=
  s = s.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_, charset, enc, data) => {
    try {
      let buf;
      if (enc.toLowerCase() === 'b') buf = Buffer.from(data, 'base64');
      else {
        // Q 编码：_ 是空格，=XX 是十六进制字节
        const bytes = [];
        for (let i = 0; i < data.length; i++) {
          if (data[i] === '_') bytes.push(0x20);
          else if (data[i] === '=' && /[0-9A-Fa-f]{2}/.test(data.slice(i + 1, i + 3))) { bytes.push(parseInt(data.slice(i + 1, i + 3), 16)); i += 2; }
          else bytes.push(data.charCodeAt(i) & 0xff);
        }
        buf = Buffer.from(bytes);
      }
      // charset 真解码：GBK/Big5 中文附件名按各自码表（此前两个分支都是 utf8，中文名必乱码）
      const cs = String(charset || '').toLowerCase();
      const asBuf = ['gb2312', 'gbk', 'gb18030', 'big5'].includes(cs) ? cs : 'utf8';
      try { return buf.toString(asBuf); } catch { return buf.toString('utf8'); }
    } catch { return data; }
  });
  // 去掉两侧引号与换行
  return s.replace(/^"|"$/g, '').replace(/\r?\n/g, ' ').trim();
}

// 从 Content-Disposition / Content-Type 值里取附件文件名。
// 必须覆盖的格式（生产实测：浙江通行费电子发票的 zip 附件头）：
//   ① 普通 filename="a.pdf"
//   ② RFC2231 分段：filename*0="段1"; filename*1="段2"（段值里还可能混 RFC2047 编码词，
//     且编码词会被从中间劈开——必须先按段号拼接、再统一解 RFC2047）
//   ③ RFC2231 扩展值：filename*=UTF-8''%E5%8F%91.pdf（可分段 filename*0*=..）
//   ④ 引号值含分号（旧正则 ([^;]+) 会截断）
// filename 优先于 Content-Type 的 name；都没有返回 null。
function _params2231(src, key) {
  const re = new RegExp(key + '(\\*)?(\\d+)?(\\*)?\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|([^;\\r\\n]*))', 'gi');
  const out = { plain: null, segs: new Map() };
  let m;
  while ((m = re.exec(src))) {
    const num = m[2] !== undefined ? Number(m[2]) : null;
    const val = (m[4] !== undefined ? m[4] : (m[5] || '')).trim();
    if (num !== null) out.segs.set(num, { ext: !!m[3], val });
    else if (m[1] || m[3]) out.segs.set(0, { ext: true, val }); // filename*=...（无段号）
    else if (out.plain === null) out.plain = val;                // 普通 filename=
  }
  return out;
}
function pickFilename(cd, ct) {
  const src = [cd, ct].filter(Boolean).join(';\r\n');
  for (const key of ['filename', 'name']) {
    const p = _params2231(src, key);
    if (p.segs.size) {
      let charset = '', s = '', first = true, hadExt = false;
      for (const idx of [...p.segs.keys()].sort((a, b) => a - b)) {
        const seg = p.segs.get(idx);
        let v = seg.val || '';
        if (seg.ext) {
          hadExt = true;
          // 扩展值首段带 charset'lang' 前缀，摘出 charset 供后面按码表转文本
          if (first) { const mm = v.match(/^([A-Za-z0-9!*._+-]*)'[^']*'([\s\S]*)$/); if (mm) { charset = mm[1].toLowerCase(); v = mm[2]; } }
          v = v.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
        }
        s += v; first = false;
      }
      if (hadExt) { // 扩展段拼出的是原始字节，按声明 charset 转文本
        try {
          const cs = ['gb2312', 'gbk', 'gb18030', 'big5'].includes(charset) ? charset : 'utf8';
          s = Buffer.from(s, 'latin1').toString(cs);
        } catch { /* 保持原样 */ }
      }
      const dec = decodeMimeFilename(s); // 段值里混的 RFC2047 编码词最后统一解
      if (dec) return dec;
    }
    if (p.plain) return decodeMimeFilename(p.plain);
  }
  return null;
}

// 递归解析 MIME 结构，收集 text/plain、text/html 与附件（{filename, contentType, buf}）
function _extract(latin) {
  let split = latin.indexOf('\r\n\r\n'); let sep = 4;
  if (split < 0) { split = latin.indexOf('\n\n'); sep = 2; }
  if (split < 0) return {};
  const headerStr = latin.slice(0, split);
  const body = latin.slice(split + sep);
  const ct = pickHeader(headerStr, 'content-type') || 'text/plain';
  const boundary = (ct.match(/boundary\s*=\s*"?([^";\r\n]+)"?/i) || [])[1];
  let plain = null, html = null;
  const attachments = [];
  if (boundary && /multipart/i.test(ct)) {
    for (const part of body.split('--' + boundary)) {
      if (/^--/.test(part)) break; // 结束边界
      const sub = _extract(part.replace(/^\r?\n/, ''));
      if (sub.plain && plain === null) plain = sub.plain;
      if (sub.html && html === null) html = sub.html;
      if (sub.attachments) attachments.push(...sub.attachments);
    }
  } else {
    const cte = pickHeader(headerStr, 'content-transfer-encoding');
    const cd = pickHeader(headerStr, 'content-disposition') || '';
    const filename = pickFilename(cd, ct);
    const ctMain = ct.split(';')[0].trim().toLowerCase();
    // 附件判定：①disposition=attachment（没文件名也收，命名兜底）②有文件名且非正文体
    // ③application/* 二进制部件（发票 PDF/zip 常连 name 头都没有——此前这类部件被判成正文，
    //   附件丢失 + ZIP 二进制乱码灌进正文，生产 86 封邮件附件全空就是这个原因）
    const isAttachment = /attachment/i.test(cd)
      || (filename && !/^text\/(plain|html)/.test(ctMain))
      || /^application\//.test(ctMain);
    if (isAttachment) {
      const name = filename || 'attachment';
      const raw = Buffer.from(body, 'latin1');
      let buf;
      const enc = String(cte || '').toLowerCase().trim();
      if (enc === 'base64') {
        try { buf = Buffer.from(raw.toString('utf8').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64'); }
        catch { buf = raw; }
      } else if (enc === 'quoted-printable') {
        const bytes = [];
        for (let i = 0; i < raw.length; i++) {
          const ch = raw.toString('latin1')[i];
          if (ch === '=' && /[0-9A-Fa-f]{2}/.test(raw.toString('latin1').slice(i + 1, i + 3))) { bytes.push(parseInt(raw.toString('latin1').slice(i + 1, i + 3), 16)); i += 2; }
          else if (ch !== '\r' && ch !== '\n') bytes.push(raw[i]);
        }
        buf = Buffer.from(bytes);
      } else buf = raw;
      if (buf.length) attachments.push({ filename: name || 'attachment', contentType: ct.split(';')[0].trim(), buf });
    } else if (/^text\/html/.test(ctMain)) {
      const dec = decodeBytes(Buffer.from(body, 'latin1'), cte);
      if (html === null) html = dec;
    } else if (/^text\//.test(ctMain)) {
      // 只有 text/* 才能当正文；其余无文件名的二进制部件（内嵌图片等）直接跳过，
      // 绝不让二进制解码串污染 plain（旧行为：任何部件都进 plain）
      const dec = decodeBytes(Buffer.from(body, 'latin1'), cte);
      if (plain === null) plain = dec;
    }
  }
  return { plain, html, attachments };
}
// 从 RFC822 原始 source（Buffer）提取正文纯文本：text/plain 优先，否则 HTML 转文本
function extractBodyFromSource(src) {
  if (!src || !src.length) return '';
  const { plain, html } = _extract(src.toString('latin1'));
  return (plain || (html ? stripHtml(html) : '') || '').slice(0, 8000);
}
// 提取附件（无正文）
function extractAttachmentsFromSource(src) {
  if (!src || !src.length) return [];
  const { attachments } = _extract(src.toString('latin1'));
  return attachments || [];
}

// ---------- 附件存储（NAS 目录可配置，归租户 settings） ----------
const fs = require('fs');
const path = require('path');

function getAttachConfig(d) {
  return getSetting(d, 'email_attachments', { dir: '' }); // dir 例：Z:/mail-attachments 或 \\NAS\mail
}
function saveAttachConfig(d, cfg) {
  setSetting(d, 'email_attachments', { dir: String(cfg.dir || '').trim() });
}
// 保存附件文件：{dir}/t<租户>_a<账号>_{uid}_{安全文件名}；返回相对名（租户+账号前缀防共用目录时撞名）
// 专属目录留空时回落「全局默认上传路径」的 email-attachments 子目录；都没配才不落盘
function saveAttachment(d, uid, att, accountId = 1) {
  const dir = String(getAttachConfig(d).dir || '').trim() || require('../services/storagePaths').uploadSubDir('email-attachments') || '';
  const safe = String(att.filename || 'attachment').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120);
  const rel = `t${tenantIdOf(d) ?? 0}_a${Number(accountId) || 1}_${uid}_${safe}`;
  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, rel), att.buf);
      return { filename: att.filename, size: att.buf.length, path: rel, stored: 1 };
    } catch (e) {
      console.warn(`[email] 附件写盘失败(${dir}): ${e.message}`);
    }
  }
  // 目录未配置/写失败：不落盘，仅在列表中登记（可下载时从库取——当前库不存附件体，故标记未存）
  return { filename: att.filename, size: att.buf.length, path: '', stored: 0 };
}
function attachmentFullPath(d, rel) {
  const dir = String(getAttachConfig(d).dir || '').trim() || require('../services/storagePaths').uploadSubDir('email-attachments') || '';
  if (!dir || !rel) return null;
  return path.join(dir, rel);
}

// ---------- 拉取邮件 ----------
// limit = 拉取最新 N 封（按序列号从末尾取，确保是新邮件而非最旧的）
// opts.force = 补拉模式：对「已登记过附件但解析结果为空 '[]'」的邮件强制重拉原文重解析
// （解析器修好后，老邮件存的 '[]' 是毒化标记——常规拉取会永久跳过，必须 force 才能翻案；
//   已有附件的邮件不重拉，避免白下载大附件）
async function listEmails(d, limit = 30, opts = {}) {
  const force = !!(opts && opts.force);
  const accountId = Number(opts && opts.accountId) || 1;
  const cfg = getAccount(d, accountId);
  if (!cfg) throw new Error('邮箱账号不存在');
  if (!accountReady(cfg)) throw new Error('邮箱尚未配置完整（服务器 / 账号 / 授权码）');

  const client = new ImapFlow({
    host: cfg.imap_host,
    port: cfg.imap_port || 993,
    secure: cfg.use_tls ? true : false,
    auth: { user: cfg.imap_user, pass: cfg.imap_pass },
    logger: false,
    connectionTimeout: 15000,
    socketTimeout: 60000,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const total = client.mailbox.exists || 0;
      if (!total) return [];
      const start = Math.max(1, total - limit + 1); // 取最后 limit 封（最新）
      const known = new Map(
        d.prepare('SELECT uid, seen, body, attachments FROM emails WHERE account_id=?').all(accountId).map((r) => [r.uid, r])
      );
      const mails = [];
      for await (const msg of client.fetch(`${start}:*`, { envelope: true, uid: true })) {
        const uid = Number(msg.uid);
        const env = msg.envelope || {};
        mails.push({
          uid,
          subject: (env.subject || '').slice(0, 300),
          from_name: env.from?.[0]?.name || '',
          from_addr: env.from?.[0]?.address || '',
          date: env.date ? new Date(env.date).toISOString() : null,
          seen: known.has(uid) ? !!known.get(uid).seen : false,
          isNew: !known.has(uid),
        });
      }
      mails.sort((a, b) => (b.date || '').localeCompare(a.date || '')); // 最新在前

      // 入库元信息（INSERT OR IGNORE，依赖 (account_id, uid) 组合唯一索引去重）
      const insert = d.prepare(
        "INSERT OR IGNORE INTO emails(account_id,uid,subject,from_name,from_addr,date,seen,folder) VALUES(?,?,?,?,?,0,'inbox')"
      );
      const tx = d.transaction((list) => {
        for (const m of list) insert.run(accountId, m.uid, m.subject, m.from_name || '', m.from_addr, m.date);
      });
      tx(mails);

      // 拉正文+附件：缺正文或没登记过附件信息的邮件，用 source 拉 + MIME 解析
      let fetched = 0;
      let attCount = 0;
      const updates = [];
      for (const m of mails) {
        const prev = known.get(m.uid);
        const hasAttInfo = prev && prev.attachments !== null && prev.attachments !== undefined && prev.attachments !== '';
        if (prev && prev.body && hasAttInfo) {
          // force 补拉：只翻案「登记过但一个附件都没有」的邮件（解析缺陷期的 '[]' 毒化行）
          let skip = true;
          if (force && prev.attachments === '[]') skip = false;
          if (skip) { m.body = prev.body; m.attachments = null; continue; }
        }
        try {
          const src = await client.fetchOne(m.uid, { source: true }, { uid: true });
          const bodyText = extractBodyFromSource(src?.source);
          const atts = extractAttachmentsFromSource(src?.source);
          const meta = atts.map((a) => saveAttachment(d, m.uid, a, accountId));
          if (meta.length) attCount += meta.length;
          const attJson = JSON.stringify(meta); // 无附件存 []，避免下次重复拉
          if (force || bodyText || meta.length) {
            updates.push([bodyText || (prev?.body || ''), attJson, m.uid, accountId]);
            m.body = bodyText || prev?.body || ''; m.attachments = meta; fetched++;
          }
        } catch (e) {
          console.warn(`[email] 正文拉取失败 uid=${m.uid}: ${e.message}`);
        }
      }
      if (updates.length) {
        const upd = d.prepare('UPDATE emails SET body=?, attachments=? WHERE account_id=? AND uid=?');
        const tx2 = d.transaction((list) => { for (const u of list) upd.run(u[0], u[1], u[3], u[2]); });
        tx2(updates);
      }
      console.log(`[email] 账号${accountId} 拉取 ${mails.length} 封元信息（最新 ${limit}），新拉正文 ${fetched} 封，附件 ${attCount} 个`);
      return mails;
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

function markSeen(d, uid, accountId) {
  if (accountId) d.prepare('UPDATE emails SET seen=1 WHERE account_id=? AND uid=?').run(Number(accountId), uid);
  else d.prepare('UPDATE emails SET seen=1 WHERE uid=?').run(uid);
}

// 批量：按行 id 标已读 / 移动文件夹（v1.7.0 批量多选用）
function batchSeen(d, ids) {
  const st = d.prepare('UPDATE emails SET seen=1 WHERE id=?');
  const tx = d.transaction((list) => { for (const id of list) st.run(Number(id)); });
  tx(ids.filter((n) => Number.isInteger(Number(n)) && Number(n) > 0));
}
function batchMove(d, ids, to) {
  const SET = to === 'delete' ? null
    : to === 'trash' ? `folder='trash', deleted_at=datetime('now','localtime')`
    : ['inbox', 'sent', 'draft'].includes(to) ? `folder='${to}', deleted_at=NULL` : null;
  if (!SET) { if (to !== 'delete') throw new Error('无效文件夹'); }
  const st = to === 'delete'
    ? d.prepare('DELETE FROM emails WHERE id=?')
    : d.prepare(`UPDATE emails SET ${SET} WHERE id=?`);
  const tx = d.transaction((list) => { for (const id of list) st.run(Number(id)); });
  tx(ids.filter((n) => Number.isInteger(Number(n)) && Number(n) > 0));
}

// ---------- SMTP 发送（Node 原生 net/tls，无 nodemailer 依赖） ----------
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

function b64(s) { return Buffer.from(s).toString('base64'); }

// SMTP 会话封装：逐条命令→响应（多行响应以 250- / 334- 等续行，读到非 '-' 结尾行为止）
class SmtpClient {
  constructor(sock) { this.sock = sock; this.buf = ''; }
  readReply() {
    return new Promise((resolve, reject) => {
      const onData = (chunk) => {
        this.buf += chunk.toString('utf8');
        // 完整响应：所有行都是 "xyz 文本"（末行无 '-'）
        const lines = this.buf.split(/\r?\n/).filter(Boolean);
        const done = lines.length && lines.every((l) => /^\d{3}( |-)/.test(l)) && !/\d{3}-\s*$/.test(this.buf.replace(/\r?\n$/, ''));
        if (done) {
          const code = Number(lines[lines.length - 1].slice(0, 3));
          this.sock.off('data', onData);
          this.buf = '';
          if (code >= 400) reject(new Error(`SMTP ${code}: ${lines.join(' | ').slice(0, 300)}`));
          else resolve(lines.join('\n'));
        }
      };
      const onErr = (e) => { this.sock.off('data', onData); reject(e); };
      this.sock.once('error', onErr);
      this.sock.on('data', onData);
    });
  }
  async cmd(line) {
    this.sock.write(line + '\r\n');
    return this.readReply();
  }
  close() { try { this.sock.destroy(); } catch {} }
}

async function smtpConnect(cfg) {
  const host = cfg.smtp_host;
  const port = Number(cfg.smtp_port) || 465;
  const useTls = cfg.smtp_tls ? true : false;
  let sock;
  if (useTls) {
    sock = await new Promise((resolve, reject) => {
      const s = tls.connect({ host, port, rejectUnauthorized: false }, () => resolve(s));
      s.once('error', reject);
    });
  } else {
    sock = await new Promise((resolve, reject) => {
      const s = net.connect({ host, port }, () => resolve(s));
      s.once('error', reject);
    });
  }
  sock.setTimeout(20000, () => sock.destroy(new Error('SMTP 超时')));
  const c = new SmtpClient(sock);
  try {
    await c.readReply();                       // 220 问候
    await c.cmd('EHLO workbench');             // 250
    if (useTls) {
      // 隐式 TLS（465）已在 TLS 层完成，无需 STARTTLS
    } else {
      // 明文端口（如 25/587）尝试 STARTTLS 升级（QQ/163 等 587 需要）
      try {
        const r = await c.cmd('STARTTLS');
        if (/220/.test(r)) {
          const tlsSock = await new Promise((resolve, reject) => {
            const t = tls.connect({ socket: sock, rejectUnauthorized: false }, () => resolve(t));
            t.once('error', reject);
          });
          c.sock = tlsSock;
          await c.cmd('EHLO workbench');
        }
      } catch { /* 服务器不支持 STARTTLS，继续明文 */ }
    }
    await c.cmd('AUTH LOGIN');                 // 334
    await c.cmd(b64(cfg.smtp_user));           // 334
    const authOk = await c.cmd(b64(cfg.smtp_pass)); // 235
    return { c, authOk };
  } catch (e) {
    c.close();
    throw new Error('SMTP 连接/登录失败: ' + e.message);
  }
}

function buildMime({ from, fromName, to, cc, subject, text, signature }) {
  const boundary = '----wb_' + crypto.randomBytes(8).toString('hex');
  const dateStr = new Date().toUTCString();
  const msgId = `<${Date.now()}.${crypto.randomBytes(6).toString('hex')}@workbench>`;
  const encodeHdr = (v) => '=?UTF-8?B?' + b64(v) + '?=';
  const fullText = signature ? `${text}\n\n--\n${signature}` : text;
  const lines = [
    `From: ${encodeHdr(fromName || from)} <${from}>`,
    `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    `Subject: ${encodeHdr(subject)}`,
    `Date: ${dateStr}`,
    `Message-ID: ${msgId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(fullText).replace(/(.{76})/g, '$1\r\n'),
    '',
    `--${boundary}--`,
    '',
  ];
  return lines.join('\r\n');
}

async function sendMail(d, { to, cc, subject, text, accountId }) {
  const cfg = getAccount(d, Number(accountId) || 1) || {};
  if (!cfg.smtp_host || !cfg.smtp_user || !cfg.smtp_pass) {
    throw new Error('SMTP 尚未配置，请先在「邮箱设置」里填写发件服务器');
  }
  if (!to || !to.trim()) throw new Error('收件人不能为空');
  const fromName = cfg.smtp_from_name || cfg.imap_user || cfg.smtp_user;
  const body = buildMime({ from: cfg.smtp_user, fromName, to, cc, subject, text, signature: cfg.signature || '' });
  const { c } = await smtpConnect(cfg);
  try {
    await c.cmd(`MAIL FROM:<${cfg.smtp_user}>`);
    const all = String(to + (cc ? ',' + cc : '')).split(/[,;，；]/).map((s) => s.trim()).filter(Boolean);
    for (const addr of all) await c.cmd(`RCPT TO:<${addr}>`);
    await c.cmd('DATA');                       // 354
    // 点补齐：正文里行首的点要加一个点（RFC 5321）
    const safe = body.replace(/(^|\r?\n)\./g, '$1..');
    await c.cmd(safe + '\r\n.');
    await c.cmd('QUIT');
    // 存入发件箱（归属发件账号）
    d.prepare(`INSERT INTO emails(account_id,uid,subject,from_addr,to_addr,date,seen,body,folder) VALUES(?,NULL,?,?,?,?,1,?,'sent')`)
      .run(cfg.id || 1, subject || '', cfg.smtp_user, to, new Date().toISOString(), body);
    return { ok: true };
  } finally {
    c.close();
  }
}

// ---------- 文件夹视图 / 垃圾箱清理 ----------
function listFolder(d, folder, { q = '', page = 1, pageSize = 20, accountId } = {}) {
  const like = `%${q}%`;
  const accCond = accountId ? `AND account_id=${Number(accountId)}` : '';
  const where = folder === 'trash'
    ? "folder='trash'"
    : `folder='${folder}'`;
  const cond = q ? `AND (subject LIKE ? OR from_addr LIKE ? OR to_addr LIKE ? OR body LIKE ?)` : '';
  const params = q ? [like, like, like, like] : [];
  const total = d.prepare(`SELECT COUNT(*) c FROM emails WHERE ${where} ${accCond} ${cond}`).get(...params).c;
  const rows = d.prepare(`SELECT * FROM emails WHERE ${where} ${accCond} ${cond} ORDER BY date DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize);
  // 关键词标签（v1.7.0）：主题+正文全网检索，命中第一个预设关键词 → 标题前显示标签（每封只一个）
  const rules = getTagRules(d);
  if (rules.length) {
    for (const r of rows) r.tag = matchTag(rules, r.subject, r.body);
  }
  return { total, rows };
}

// 垃圾箱按保留天数物理删除（scheduler 每日调；多邮箱按各账号自己的保留天数）
function purgeTrash(d) {
  let n = 0;
  for (const acc of getAccounts(d)) {
    const days = Math.max(1, Number(acc.trash_keep_days) || 30);
    const r = d.prepare(`DELETE FROM emails WHERE account_id=? AND folder='trash' AND deleted_at IS NOT NULL AND deleted_at < datetime('now','localtime', ?)`).run(acc.id, `-${days} days`);
    if (r.changes) console.log(`[email] 垃圾箱清理（账号${acc.id}）：删除 ${r.changes} 封（保留 ${days} 天）`);
    n += r.changes;
  }
  return n;
}

function saveDraft(d, { id, to, cc, subject, text, accountId }) {
  const cfg = getAccount(d, Number(accountId) || 1) || {};
  if (id) {
    d.prepare(`UPDATE emails SET to_addr=?, subject=?, body=?, date=datetime('now','localtime') WHERE id=? AND folder='draft'`)
      .run(to || '', subject || '', text || '', id);
    return id;
  }
  const r = d.prepare(`INSERT INTO emails(account_id,uid,subject,from_addr,to_addr,date,seen,body,folder) VALUES(?,NULL,?,?,?,?,0,?,'draft')`)
    .run(cfg.id || 1, subject || '', cfg.smtp_user || '', to || '', new Date().toISOString(), text || '');
  return Number(r.lastInsertRowid);
}

module.exports = {
  getConfig, saveConfig, isConfigured, listEmails, markSeen, refresh,
  extractBodyFromSource, extractAttachmentsFromSource,
  sendMail, listFolder, purgeTrash, saveDraft,
  getAttachConfig, saveAttachConfig, attachmentFullPath, saveAttachment,
  getAccounts, getAccount, accountsView, saveAccount, deleteAccount, accountReady,
  batchSeen, batchMove, getNotifyCfg, saveNotifyCfg, getTagRules, saveTagRules,
};
