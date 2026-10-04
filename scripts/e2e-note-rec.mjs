// E2E：录音笔记链路（v1.9.39 第 6/7 条）
// 上传(from_notes=1) → 详情字段 → 转写完成 → 自动建笔记 + 推系统消息
// 转写用「客户端回传」这条真实通路驱动（造一条 claimed 任务后 POST /vibe/job/:id/result），
// 不需要真的装 ASR 引擎；这正是生产里客户端算力模式的同一条代码路径。
// 清理：只按本次创建的 id 精确删，不做全表 DELETE（CLAUDE.md §3）
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const db = new DatabaseSync('data/workbench.sqlite');
db.exec('PRAGMA busy_timeout = 8000');
const admin = db.prepare("SELECT id FROM users WHERE role='admin' AND is_bot=0 ORDER BY id LIMIT 1").get();
const tA = crypto.randomBytes(24).toString('hex');
db.prepare("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,datetime('now','localtime','+15 minutes'))").run(tA, admin.id);
const HA = { Authorization: 'Bearer ' + tA, 'Content-Type': 'application/json' };
const HJ = { Authorization: 'Bearer ' + tA };

// 客户端密钥（key 即凭证）：只用于请求鉴权，不打印。
// settings.value 是 JSON 编码的（setSetting 走 JSON.stringify），要先解码再比较。
const clientKey = (() => {
  const s = db.prepare("SELECT value FROM settings WHERE key='vibe_client_key'").get();
  if (!s) return '';
  const raw = String(s.value);
  try { const v = JSON.parse(raw); return typeof v === 'string' ? v : String(v ?? ''); } catch { return raw; }
})();

let pass = 0, fail = 0;
const ck = (n, c, x = '') => { c ? (pass++, console.log('  ✓', n)) : (fail++, console.log('  ✗', n, x)); };
const B = 'http://localhost:3000/api';
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return { __raw: t.slice(0, 120) }; } };

// 2 秒静音 WAV（服务端按文件头判时长）
function makeWav(seconds) {
  const rate = 16000, ch = 1, bits = 16;
  const data = Buffer.alloc(rate * seconds * (bits / 8));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE((rate * ch * bits) / 8, 28);
  h.writeUInt16LE((ch * bits) / 8, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const recIds = [], noteIds = [], jobIds = [], msgIds = [];

try {
  if (!clientKey) { console.log('  （未生成本机客户端密钥，跳过客户端回传用例）'); }

  // ---------- ① 上传（笔记页发起） ----------
  const fd = new FormData();
  fd.append('audio', new Blob([makeWav(2)], { type: 'audio/wav' }), 'note-e2e.wav');
  fd.append('source', 'record');
  fd.append('started_at', '2026-10-05 10:00:00');
  fd.append('ended_at', '2026-10-05 10:00:02');
  fd.append('duration_hint', '2');
  fd.append('from_notes', '1');
  let r = await fetch(B + '/vibe/upload', { method: 'POST', headers: HJ, body: fd });
  let d = await j(r);
  const rid = d.id;
  recIds.push(rid);
  ck('上传录音成功', r.status === 200 && rid > 0, JSON.stringify(d));
  ck('服务端按文件头判定时长（2 秒）', Math.abs(Number(d.duration_sec) - 2) < 0.2, String(d.duration_sec));

  // ---------- ② 详情字段齐全（录音笔记信息区） ----------
  r = await fetch(B + `/vibe/transcript/${rid}`, { headers: HJ });
  d = await j(r);
  ck('详情返回信息区所需字段', r.status === 200
    && d.from_notes === 1 && d.fmt === 'wav' && d.source === 'record'
    && !!d.file_path && Number(d.file_size) > 44 && d.started_at === '2026-10-05 10:00:00'
    && d.ended_at === '2026-10-05 10:00:02' && 'elapsed_ms' in d && d.status === 'pending',
    JSON.stringify({ ...d, file_path: '…' }));
  ck('待转写时未生成文本', !d.transcript_chars && d.status === 'pending', String(d.transcript_chars));

  // ---------- ③ 列表可见（笔记页「录音」tab） ----------
  d = await j(await fetch(B + '/vibe/records?pageSize=100', { headers: HJ }));
  const inList = (d.rows || []).find((x) => x.id === rid);
  ck('列表接口带 from_notes 标记', !!inList && inList.from_notes === 1, JSON.stringify(inList && inList.from_notes));

  // ---------- ④ 转写前还没有笔记 ----------
  d = await j(await fetch(B + `/notes/by-record/${rid}`, { headers: HJ }));
  ck('转写前 by-record 返回空对象', !d.id, JSON.stringify(d));

  // ---------- ⑤ 转写完成（走客户端回传这条真实通路） ----------
  if (clientKey) {
    const runMs = Date.now() - 3000; // 假装 3 秒前开始转写 → 详情里应显示约 3 秒耗时
    db.prepare("UPDATE vibe_records SET status='running', run_ms=? WHERE id=?").run(runMs, rid);
    const job = db.prepare("INSERT INTO vibe_jobs(record_id, req_body, status, engine, created_at) VALUES(?,'{}','claimed','vibeasr',?)")
      .run(rid, Date.now());
    jobIds.push(Number(job.lastInsertRowid));
    const utter = JSON.stringify([{ 'Start time': '00:00:00', 'End time': '00:00:02', 'Speaker ID': 1, Content: '今天测试录音笔记功能，这是一段转写文字。' }]);
    r = await fetch(B + `/vibe/job/${job.lastInsertRowid}/result`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: clientKey, ok: true, content: utter, model: 'vibeasr-e2e' }),
    });
    ck('客户端回传结果被接受', r.status === 200 && (await j(r)).ok === true, String(r.status));

    d = await j(await fetch(B + `/vibe/transcript/${rid}`, { headers: HJ }));
    ck('记录转为已生成', d.status === 'done' && d.transcript_chars > 0, JSON.stringify({ s: d.status, c: d.transcript_chars }));
    ck('转写耗时被记录（约 3 秒）', Number(d.elapsed_ms) >= 2000 && Number(d.elapsed_ms) < 30000, String(d.elapsed_ms));
    ck('使用模型落库', String(d.model).includes('vibeasr-e2e'), d.model);

    // ---------- ⑥ 自动建笔记（混排进笔记列表） ----------
    d = await j(await fetch(B + `/notes/by-record/${rid}`, { headers: HJ }));
    ck('转写后自动生成关联笔记', !!d.id && d.record_id === rid, JSON.stringify({ id: d.id, record_id: d.record_id }));
    ck('笔记正文即转写内容', String(d.content).includes('今天测试录音笔记功能'), String(d.content).slice(0, 60));
    ck('笔记标题为录音时间', String(d.title).includes('2026-10-05 10:00:00'), d.title);
    ck('笔记分类落在未分类', d.category === 'general', d.category);
    if (d.id) noteIds.push(d.id);
    const listed = await j(await fetch(B + '/notes?q=' + encodeURIComponent('今天测试录音笔记'), { headers: HJ }));
    ck('笔记出现在主列表', listed.some((n) => n.id === d.id), String(listed.length));

    // ---------- ⑦ 系统消息（第 7 条） ----------
    const msg = db.prepare("SELECT * FROM messages WHERE module='vibe' AND ref_id=? ORDER BY id DESC LIMIT 1").get(rid);
    ck('推送了 module=vibe 的系统消息', !!msg && msg.to_user === admin.id, JSON.stringify(msg && { m: msg.module, r: msg.ref_id }));
    if (msg) {
      msgIds.push(msg.id);
      ck('消息标题为「录音转写完成」', msg.subject === '录音转写完成', msg.subject);
      ck('消息含摘要/字数/时长/耗时', /共 \d+ 字/.test(msg.content) && /时长 00:02/.test(msg.content) && /转写耗时 \d+ 秒/.test(msg.content), msg.content.split('\n')[0]);
      ck('消息 ref_id 指向录音记录（点击可跳转 /notes/rec/:id）', Number(msg.ref_id) === rid, String(msg.ref_id));
    }

    // ---------- ⑧ 幂等：重复回传不再建第二条笔记 ----------
    const before = (await j(await fetch(B + '/notes?q=' + encodeURIComponent('今天测试录音笔记'), { headers: HJ }))).length;
    r = await fetch(B + `/vibe/job/${job.lastInsertRowid}/result`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: clientKey, ok: true, content: utter, model: 'vibeasr-e2e' }),
    });
    await j(r);
    const after = (await j(await fetch(B + '/notes?q=' + encodeURIComponent('今天测试录音笔记'), { headers: HJ }))).length;
    ck('重复回传不重复建笔记', after === before, `${before} → ${after}`);
  }

  // ---------- ⑨ 效率工具页的录音【不】自动建笔记（from_notes 缺省） ----------
  const fd2 = new FormData();
  fd2.append('audio', new Blob([makeWav(1)], { type: 'audio/wav' }), 'plain-e2e.wav');
  fd2.append('source', 'record');
  r = await fetch(B + '/vibe/upload', { method: 'POST', headers: HJ, body: fd2 });
  d = await j(r);
  const rid2 = d.id;
  recIds.push(rid2);
  const t2 = await j(await fetch(B + `/vibe/transcript/${rid2}`, { headers: HJ }));
  ck('未标记 from_notes 的记录（批量转写路径行为不变）', t2.from_notes === 0, String(t2.from_notes));

  console.log(`\n${pass} 通过, ${fail} 失败`);
  if (fail) process.exitCode = 1;
} finally {
  for (const id of noteIds) await fetch(B + `/notes/${id}`, { method: 'DELETE', headers: HA }).catch(() => {});
  for (const id of recIds) await fetch(B + `/vibe/records/${id}`, { method: 'DELETE', headers: HA }).catch(() => {});
  for (const id of jobIds) { try { db.prepare('DELETE FROM vibe_jobs WHERE id=?').run(id); } catch { /* 已清 */ } }
  for (const id of msgIds) { try { db.prepare('DELETE FROM messages WHERE id=?').run(id); } catch { /* 已清 */ } }
  db.prepare('DELETE FROM sessions WHERE token=?').run(tA);
  db.close();
}
