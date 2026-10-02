// e2e：智能板语音查询工作台数据 + 转交家里 agent（v1.9.31 通道 A/B 共用的服务端逻辑）
//
// 覆盖：ask 的检索/降级/AI 超时/AI 成功/整句剥离、delegate 的三道闸+限流+同步与异步两段式、
//       配置校验（uid 必须真实存在、名字不许撞唤醒词、密钥不回显）、审计留痕、接入点工具表。
// 全部离线：AI 与 Hermes 各用一个本地假 HTTP 服务顶替，不需要真板子、不需要真 NAS agent。
//
//   node scripts/e2e-xiaozhi-voice.mjs
//   E2E_VERBOSE=1 node scripts/e2e-xiaozhi-voice.mjs   看服务端日志
import { spawn, spawnSync } from 'child_process';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import http from 'http';
import https from 'https';
import crypto from 'crypto';

const PORT = 3189;
const FAKE_PORT = 3190;
const B = `http://127.0.0.1:${PORT}`;
const DATA = mkdtempSync(path.join(tmpdir(), 'wb-xzvoice-'));
process.env.DATA_DIR = DATA;

let passed = 0, failed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};

// ---------- 假的 AI / 假的 Hermes（同一个 server 按路径分流） ----------
const fake = { ai: { delay: 0, text: 'AI 归纳结果' }, hermes: { delay: 0, text: '好的，已经办好了' }, hits: { ai: 0, hermes: 0 } };
const fakeSrv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', async () => {
    const which = req.url.startsWith('/ai') ? 'ai' : req.url.startsWith('/hermes') ? 'hermes' : null;
    if (!which || !req.url.endsWith('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'not found' }));
    }
    fake.hits[which]++;
    const cfg = fake[which];
    await new Promise((r) => setTimeout(r, cfg.delay));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      model: 'fake-1', usage: { total_tokens: 3 },
      choices: [{ message: { role: 'assistant', content: cfg.text } }],
    }));
  });
});
await new Promise((r) => fakeSrv.listen(FAKE_PORT, r));
const AI_BASE = `http://127.0.0.1:${FAKE_PORT}/ai/v1`;
const HERMES_BASE = `http://127.0.0.1:${FAKE_PORT}/hermes/v1`;

// ---------- 假小智云：手写最小 WebSocket 服务端 ----------
// Node 没有内置 ws server、也不给这个项目引 npm 依赖（交付链见 CLAUDE.md），所以帧收发手写。
// 帧序完全照 Phase 0 spike 实测：**云端是 client、工作台是 server**，云端先发 initialize。
const MCP_PORT = 3191;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
async function until(fn, ms = 8000, step = 100) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
  return false;
}

function makeFakeCloud(tls) {
  const state = { conns: [] };
  const socks = new Set();
  const srv = https.createServer(tls);
  srv.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1')
      .update(String(req.headers['sec-websocket-key'] || '') + WS_GUID).digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socks.add(socket);
    socket.on('close', () => socks.delete(socket));

    const conn = { url: req.url, init: null, tools: null, askText: null, delegateDesc: '', error: '' };
    state.conns.push(conn);

    let seq = 1, acc = Buffer.alloc(0);
    const pending = new Map();
    const send = (op, payload) => {
      const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
      let head;
      if (data.length < 126) head = Buffer.from([0x80 | op, data.length]);
      else if (data.length < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(data.length, 2); }
      else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(data.length), 2); }
      try { socket.write(Buffer.concat([head, data])); } catch { /* 已断 */ }
    };
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = seq++;
      pending.set(id, { resolve, reject });
      send(0x1, JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} 没等到响应`)); }, 8000);
    });

    socket.on('data', (d) => {
      acc = Buffer.concat([acc, d]);
      while (acc.length >= 2) {
        const op = acc[0] & 0x0f;
        const masked = !!(acc[1] & 0x80);
        let len = acc[1] & 0x7f, off = 2;
        if (len === 126) { if (acc.length < 4) return; len = acc.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (acc.length < 10) return; len = Number(acc.readBigUInt64BE(2)); off = 10; }
        const mlen = masked ? 4 : 0;
        if (acc.length < off + mlen + len) return;
        const mask = masked ? acc.subarray(off, off + 4) : null;
        off += mlen;
        const payload = Buffer.from(acc.subarray(off, off + len)); // 复制一份再解掩码，别改动累积缓冲
        acc = acc.subarray(off + len);
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        if (op === 0x1) {
          let msg; try { msg = JSON.parse(payload.toString('utf8')); } catch { continue; }
          const p = msg.id !== undefined && pending.get(msg.id);
          if (p) { pending.delete(msg.id); if (msg.error) p.reject(new Error(msg.error.message)); else p.resolve(msg); }
        } else if (op === 0x8) { try { socket.end(); } catch { /* 已断 */ } }
        else if (op === 0x9) send(0xA, payload); // ping → pong
      }
    });
    socket.on('error', () => { /* 断线由 close 收尾 */ });

    // 驱动一轮完整 MCP 会话
    (async () => {
      try {
        const init = await request('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: { sampling: {}, roots: { listChanged: false } },
          clientInfo: { name: 'xz-mcp-broker', version: '0.0.1' },
        });
        conn.init = init.result;
        send(0x1, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
        const list = await request('tools/list', {});
        conn.tools = (list.result && list.result.tools) || [];
        conn.delegateDesc = ((conn.tools.find((t) => t.name === 'self.workbench.delegate') || {}).description) || '';
        const call = await request('tools/call', { name: 'self.workbench.ask', arguments: { keywords: '装修' } });
        const c = call.result && call.result.content;
        conn.askText = c && c[0] && c[0].text;
      } catch (e) { conn.error = e.message; }
    })();
  });
  return {
    state,
    listen: () => new Promise((r) => srv.listen(MCP_PORT, r)),
    close: () => new Promise((r) => { try { srv.close(() => r()); } catch { r(); } }),
    dropAll: () => { for (const s of socks) { try { s.destroy(); } catch { /* 已断 */ } } socks.clear(); },
  };
}

// ---------- 起被测服务 ----------
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: path.join(import.meta.dirname, '..'),
  // NODE_TLS_REJECT_UNAUTHORIZED=0 是给通道 A 段用的：内置 WebSocket 没地方传 rejectUnauthorized，
  // 而假小智云用的是当场生成的自签证书。只影响这个测试子进程（它的出网对象只有 127.0.0.1）
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, DEFAULT_ADMIN: 'admin', DEFAULT_ADMIN_PASSWORD: 'test123456', NODE_TLS_REJECT_UNAUTHORIZED: '0' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; if (process.env.E2E_VERBOSE) process.stdout.write(d); });
server.stderr.on('data', (d) => { serverLog += d; if (process.env.E2E_VERBOSE) process.stderr.write(d); });

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${B}/api/health`)).ok) return; } catch { /* 未起 */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('服务 60s 未就绪');
}
async function api(method, url, { token, body } = {}) {
  const r = await fetch(B + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, j: ct.includes('json') ? await r.json() : await r.text() };
}
// 桥接调用：走 EXEMPT + 桥接密钥（真板子走的就是这条路）
let KEY = '';
const bridge = (body) => api('POST', `/api/xiaozhi/bridge?k=${KEY}`, { body });
const putCfg = (body, token) => api('PUT', '/api/xiaozhi/config', { token, body });
const setAi = (body, token) => api('POST', '/api/ai/config', { token, body });

let T = '';
const useAI = (delay, text) => { fake.ai.delay = delay; fake.ai.text = text; fake.hits.ai = 0; return setAi({ model: 'fake-1', base_url: AI_BASE, api_key: 'sk-fake' }, T); };
const useHermes = (delay, text) => { fake.hermes.delay = delay; fake.hermes.text = text; fake.hits.hermes = 0; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await waitReady();
  console.log('— 准备');
  const lg = await api('POST', '/api/auth/login', { body: { username: 'admin', password: 'test123456' } });
  T = lg.j.b?.token || lg.j.token;
  ok(!!T, 'admin 登录拿到 token');
  const me = await api('GET', '/api/auth/me', { token: T });
  const uid = (me.j.user && me.j.user.id) || me.j.id;
  ok(Number.isInteger(uid) && uid > 0, `拿到管理员 uid=${uid}`, JSON.stringify(me.j).slice(0, 160));
  KEY = (await api('GET', '/api/xiaozhi/config', { token: T })).j.bridge_key;
  ok(/^[0-9a-f]{32}$/.test(KEY || ''), '拿到 32hex 桥接密钥');

  // 造一条能搜到的笔记
  await api('POST', '/api/notes', { token: T, body: { content: '装修预算清单\n客厅地板 2 万，厨房橱柜 1.5 万' } });
  ok(true, '已写入测试笔记（含关键词「装修」）');

  console.log('— ask：未配用户 / 未配 AI 的确定性路径');
  ok((await bridge({ op: 'ask', keywords: '装修' })).j.ok === false, '未指定用户时 ask 明确回「没配」而不是瞎搜');
  const badUid = await putCfg({ query: { uid: 99999 } }, T);
  ok(badUid.status === 400, '不存在的 uid 被拒 400');
  ok((await putCfg({ query: { uid: -1 } }, T)).status === 400, '负数 uid 被拒 400');
  const setUid = await putCfg({ query: { uid } }, T);
  ok(setUid.status === 200 && setUid.j.config.query.uid === uid, '指定用户保存成功');
  const a1 = await bridge({ op: 'ask', keywords: '装修' });
  ok(a1.j.ok === true && /找到 1 条/.test(a1.j.message), '未配 AI → 确定性文案含「找到 N 条」', a1.j.message);
  ok(fake.hits.ai === 0, '未配 AI 时确实没去打 AI 接口');
  const a2 = await bridge({ op: 'ask', keywords: '不存在的东西xyz' });
  ok(a2.j.ok === true && /没找到/.test(a2.j.message), '零结果回「没找到」而不是空话', a2.j.message);

  console.log('— ask：整句剥离（云端 LLM 很可能传整句）');
  const a3 = await bridge({ op: 'ask', keywords: '我的笔记里关于装修的内容是什么' });
  ok(a3.j.ok === true && a3.j.count >= 1, '整句经疑问词剥离后仍能搜到', a3.j.message);

  console.log('— v1.9.33：日程/账务进检索 + 整句切词 + 类别兜底 + 数量问句');
  await api('POST', '/api/events', { token: T, body: { title: '牙科复诊', desc: '带上拍片结果', start_time: '2099-10-08 09:30', location: '市口腔医院' } });
  await api('POST', '/api/pay/bills', { token: T, body: { amount: 76, category: '餐饮', goods: '星巴克拿铁两杯' } });
  const ev = await bridge({ op: 'ask', keywords: '牙科' });
  ok(ev.j.ok === true && ev.j.message.includes('牙科复诊'), '日程进了检索范围（此前 events 表根本不在检索里）', ev.j.message);
  const ev2 = await bridge({ op: 'ask', keywords: '口腔医院' });
  ok(ev2.j.ok === true && ev2.j.count >= 1, '日程的地点也进检索', ev2.j.message);
  const pb = await bridge({ op: 'ask', keywords: '星巴克' });
  ok(pb.j.ok === true && pb.j.count >= 1, '账务（商品名）进了检索', pb.j.message);
  const gram = await bridge({ op: 'ask', keywords: '帮我查一下我的装修清单有几条' });
  ok(gram.j.ok === true && gram.j.count >= 1, '中文整句没有空格也能搜到（剥完剩一坨连写字 → n-gram 切词）', gram.j.message);
  const cat = await bridge({ op: 'ask', keywords: '我的日程' });
  ok(cat.j.ok === true && cat.j.count >= 1 && cat.j.message.includes('牙科复诊'), '「我的日程」走类别兜底拿到最近的日程（字面「日程」不在任何一条日程里）', cat.j.message);
  const notesJ = (await api('GET', '/api/notes', { token: T })).j;
  const noteCount = (Array.isArray(notesJ) ? notesJ : ((notesJ.items || notesJ.list || notesJ.data) || [])).length;
  const cnt = await bridge({ op: 'ask', keywords: '我有几篇笔记' });
  ok(cnt.j.ok === true && cnt.j.message.includes(`笔记 ${noteCount} 条`), `「我有几篇笔记」回真实计数（${noteCount}）而不是 AI 数的检索结果`, cnt.j.message);
  const none = await bridge({ op: 'ask', keywords: '咸鱼饼干xyz' });
  ok(none.j.ok === true && /没找到/.test(none.j.message), '既无命中又无类别词 → 仍然老实回「没找到」', none.j.message);

  console.log('— v1.9.34：类别词被别的表劫持（生产实测：「日程」二字在 6 条笔记/剪贴板里命中，「我的日程」就永远拿不到真日程）');
  await api('POST', '/api/notes', { token: T, body: { content: '工作台侧栏一览\n新闻 邮箱 笔记 日程管理 听写 视频教学' } });
  const cat2 = await bridge({ op: 'ask', keywords: '我的日程' });
  ok(cat2.j.ok === true && cat2.j.message.includes('牙科复诊'),
    '别处（笔记）出现「日程」二字也抢不走「我的日程」——纯类别问法只认该类别的真行', cat2.j.message);
  const cat3 = await bridge({ op: 'ask', keywords: '侧栏一览' });
  ok(cat3.j.ok === true && cat3.j.count >= 1, '问具体内容时仍按内容检索（不被类别兜底抢走）', cat3.j.message);

  console.log('— v1.9.34：时间范围（用户问「本月日程」，字面匹配没有日期维度，把上个月的事件也念了出来）');
  const pad2 = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const today = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  await api('POST', '/api/events', { token: T, body: { title: '本月的家长会', start_time: `${today} 20:00` } });
  const mo = await bridge({ op: 'ask', keywords: '本月日程' });
  ok(mo.j.ok === true && mo.j.message.includes('本月的家长会') && !mo.j.message.includes('牙科复诊'),
    '「本月日程」只回本月的（2099 年那条牙科复诊不在本月，必须被排除）', mo.j.message);
  const moCnt = await bridge({ op: 'ask', keywords: '本月有几条日程' });
  ok(moCnt.j.ok === true && /本月：.*日程 1 条/.test(moCnt.j.message), '「本月有几条日程」的计数也按月份过滤', moCnt.j.message);
  const noTime = await bridge({ op: 'ask', keywords: '我的日程' });
  ok(noTime.j.ok === true && noTime.j.message.includes('牙科复诊'), '不带时间词时行为不变（仍是未来优先）', noTime.j.message);

  console.log('— v1.9.34：练琴时长（用户报障「查小雨的练琴时长」回「查不到，只能看到这个菜单」——钢琴数据在主库、且不在检索的 10 张表里）');
  const pu = await api('POST', '/api/users', { token: T, body: { username: 'xiaoyu', password: 'piano123456', role: 'admin', display_name: '小雨' } });
  ok(Number.isInteger(pu.j.id), '建一个「小雨」账号（练琴记录挂在人名下）', JSON.stringify(pu.j).slice(0, 80));
  ok((await bridge({ op: 'ask', keywords: '练琴' })).j.message.includes('没有找到'),
    '检索里没有练琴数据（复现生产：字面「练琴」只能撞到菜单/说明类文本）');
  const pl = await api('POST', '/api/auth/login', { body: { username: 'xiaoyu', password: 'piano123456' } });
  const PT = pl.j.b?.token || pl.j.token;
  ok(!!PT, '小雨登录拿到 token');
  const fd = new FormData();
  fd.append('duration_sec', '2700');
  fd.append('started_at', `${today} 19:00`);
  fd.append('audio', new Blob([Buffer.from('fake-webm-audio')], { type: 'audio/webm' }), 'piano.webm');
  const up = await fetch(`${B}/api/piano/upload`, { method: 'POST', headers: { Authorization: 'Bearer ' + PT }, body: fd });
  const upj = await up.json().catch(() => ({}));
  ok(up.ok && Number.isInteger(upj.id), `上传一条 45 分钟练琴录音（id=${upj.id}）`, JSON.stringify(upj).slice(0, 120));
  ok((await api('PATCH', `/api/piano/confirm/${upj.id}`, { token: PT, body: { valid_sec: 2700 } })).status === 200,
    '确认为有效时长 45 分钟');
  const pc = await bridge({ op: 'ask', keywords: '小雨的练琴时长' });
  ok(pc.j.ok === true && pc.j.message.includes('45 分钟'), `「小雨的练琴时长」答出 45 分钟（实际「${String(pc.j.message).slice(0, 40)}」）`);
  const pcm = await bridge({ op: 'ask', keywords: '小雨本月练琴时长' });
  ok(pcm.j.ok === true && pcm.j.message.includes('本月') && pcm.j.message.includes('45 分钟'),
    `带月份范围也对（实际「${String(pcm.j.message).slice(0, 40)}」）`);

  console.log('— ask：AI 归纳与超时降级');
  await useAI(0, '装修预算一共三万五，地板两万，橱柜一万五。');
  const a4 = await bridge({ op: 'ask', keywords: '装修' });
  ok(a4.j.ok === true && a4.j.message === '装修预算一共三万五，地板两万，橱柜一万五。', 'AI 正常时用 AI 的话术', a4.j.message);
  ok(fake.hits.ai === 1, 'AI 接口被调用一次');
  // v1.9.35：小模型偶尔把「说明书」当答案念出来（deepseek-flash 生产实测），必须丢掉回落到确定性文案
  await useAI(0, '需要回答用户“最近的邮件”。检索结果有10条？全库计数没有给出。题目说问到数量时必须用给出的全库计数，'
    + '这里没有给全库计数。用户问“最近的邮件”，属于清单，把检索到的条目标题挨个念出来，最多6条。不要 markdown、列表、引号、表情。');
  const aGarbage = await bridge({ op: 'ask', keywords: '装修' });
  ok(aGarbage.j.ok === true && /找到 \d+ 条/.test(aGarbage.j.message) && !/全库计数|不要 markdown/.test(aGarbage.j.message),
    'AI 念说明书（回体带系统提示词）→ 丢掉，回落到确定性文案', aGarbage.j.message);
  await useAI(0, '1. 第一条笔记 2. 第二条笔记 3. 第三条笔记');
  const aNumbered = await bridge({ op: 'ask', keywords: '装修' });
  ok(aNumbered.j.ok === true && /找到 \d+ 条/.test(aNumbered.j.message),
    'AI 回通篇编号罗列（语音里就是念稿子）→ 也丢掉', aNumbered.j.message);

  await useAI(9000, '这句不该被等到');
  await putCfg({ query: { ai_timeout_ms: 1200 } }, T);
  const t0 = Date.now();
  const a5 = await bridge({ op: 'ask', keywords: '装修' });
  const dt = Date.now() - t0;
  ok(a5.j.ok === true && /找到 1 条/.test(a5.j.message), 'AI 超时 → 回落确定性文案，不抛 500', a5.j.message);
  ok(dt < 4000, `AI 超时后仍在预算内返回（${dt}ms）`);
  await putCfg({ query: { ai_timeout_ms: 6000 } }, T);
  await setAi({ model: '', base_url: '', api_key: '' }, T);

  console.log('— ask 回包体积（接入点约 1024 字节上限）');
  await api('POST', '/api/notes', { token: T, body: { content: '装修 ' + '很长的一段内容'.repeat(60) } });
  const a6 = await bridge({ op: 'ask', keywords: '装修' });
  const bytes = Buffer.byteLength(JSON.stringify(a6.j), 'utf8');
  ok(bytes <= 950, `回包 ${bytes} 字节 ≤ 950`, a6.j.message);

  console.log('— delegate：三道闸');
  ok((await bridge({ op: 'delegate', request: '让贾维斯看看磁盘' })).j.ok === false, '未启用 agent 时 delegate 被拒');
  const en = await putCfg({
    agent: { enabled: true, name: '贾维斯', aliases: ['老贾'], base_url: HERMES_BASE, model: 'my-agent', sync_budget_ms: 8000 },
    agent_key: 'sk-hermes-fake',
  }, T);
  ok(en.status === 200 && en.j.config.agent.has_key === true, '启用 agent 且密钥已保存（只回 has_key 布尔）');
  const raw = await api('GET', '/api/xiaozhi/config', { token: T });
  ok(!JSON.stringify(raw.j).includes('sk-hermes-fake'), 'GET 配置不含密钥明文');
  const noName = await bridge({ op: 'delegate', request: '看看磁盘还剩多少' });
  ok(noName.j.ok === false && /贾维斯/.test(noName.j.message), '没点名被拒且提示要点名', noName.j.message);
  const risky = await bridge({ op: 'delegate', request: '贾维斯帮我把 logs 目录删除了' });
  ok(risky.j.ok === false && /危险/.test(risky.j.message), '危险动词被拦下', risky.j.message);
  ok((await putCfg({ wake: { pinyin: 'xiao yang yang', display: '贾维斯', threshold: 20 } }, T)).status === 400, 'agent 名字撞唤醒词被拒 400');

  console.log('— delegate：同步快答 / 限流 / 异步补播');
  await sleep(5200); // 让限流窗口清空
  useHermes(0, '磁盘还剩 120G。');
  const d1 = await bridge({ op: 'delegate', request: '贾维斯，看看磁盘还剩多少' });
  ok(d1.j.ok === true && d1.j.mode === 'sync' && d1.j.message === '磁盘还剩 120G。', '快点名转交 → 同步拿到答案', JSON.stringify(d1.j));
  const d2 = await bridge({ op: 'delegate', request: '贾维斯，再看看内存' });
  ok(d2.j.ok === false && /稍等/.test(d2.j.message), '5 秒内连发第二次被限流拦下', d2.j.message);

  await sleep(5200);
  await putCfg({ agent: { sync_budget_ms: 1200 } }, T);
  useHermes(6000, '内存还剩 8G。');
  const t1 = Date.now();
  const d3 = await bridge({ op: 'delegate', request: '贾维斯，算个久一点的活' });
  const dt3 = Date.now() - t1;
  ok(d3.j.ok === true && d3.j.mode === 'async' && /智能屏/.test(d3.j.message), '慢任务 → 立刻回执并说明用智能屏补播', JSON.stringify(d3.j));
  ok(dt3 < 3000, `异步回执在同步预算内返回（${dt3}ms）`);
  await sleep(6000); // 等后台那次 Hermes 调用跑完（它不该被 abort）
  ok(fake.hits.hermes === 1, `后台那次 Hermes 调用只发生一次（${fake.hits.hermes}）`);
  await putCfg({ agent: { sync_budget_ms: 8000 } }, T);

  console.log('— ask 自动改道（云端错调 ask 但用户点了名）');
  await sleep(5200);
  useHermes(0, '已经在办了。');
  const rr = await bridge({ op: 'ask', keywords: '贾维斯，帮我看看磁盘' });
  ok(rr.j.ok === true && fake.hits.hermes === 1, 'ask 带 agent 名字 → 自动转交 delegate', JSON.stringify(rr.j));

  console.log('— v1.9.36 屏幕按钮③【对话AI】agent_chat（按钮本身就是点名 → 跳过「必须点名」那道闸）');
  await sleep(5200); // 清空限流窗口
  useHermes(0, '灯已经关了。');
  const btn1 = await bridge({ op: 'agent_chat', text: '帮我把客厅的灯关了' });
  ok(btn1.j.ok === true && btn1.j.mode === 'sync' && btn1.j.message === '灯已经关了。',
    '不点名也照转给 agent，且答案原样回（板子直接念）', JSON.stringify(btn1.j));
  ok(fake.hits.hermes === 1, '确实打到了 agent 接口');

  const btnEmpty = await bridge({ op: 'agent_chat', text: '   ' });
  ok(btnEmpty.j.ok === false && /再说一遍/.test(btnEmpty.j.message), '空内容回可念的提示（不是 500）', btnEmpty.j.message);

  const btnRate = await bridge({ op: 'agent_chat', text: '接下来呢' });
  ok(btnRate.j.ok === false && /稍等/.test(btnRate.j.message), '5 秒内连按两次被限流拦下（按钮不是无限制通道）', btnRate.j.message);

  const btnRisky = await bridge({ op: 'agent_chat', text: '把 logs 目录删除了' });
  ok(btnRisky.j.ok === false && /危险/.test(btnRisky.j.message), '危险动词照拦（按钮不免检）', btnRisky.j.message);

  await putCfg({ agent: { enabled: false } }, T);
  const btnOff = await bridge({ op: 'agent_chat', text: '现在几点' });
  ok(btnOff.j.ok === false && /还没启用/.test(btnOff.j.message), 'agent 关闭时被拒且说清去哪开', btnOff.j.message);
  await putCfg({ agent: { enabled: true } }, T);

  await putCfg({ agent: { base_url: '' } }, T);
  const btnUncfg = await bridge({ op: 'agent_chat', text: '在吗' });
  ok(btnUncfg.j.ok === false && /还没配全/.test(btnUncfg.j.message), '没配全时回可念文案而不是抛', btnUncfg.j.message);

  // 超时/连不上也必须翻成人话——固件拿到 message 就直接念，不能是个技术异常串
  await putCfg({ agent: { base_url: 'http://127.0.0.1:9/v1' } }, T);
  await sleep(5200);
  const btnDead = await bridge({ op: 'agent_chat', text: '在吗' });
  ok(btnDead.j.ok === false && /没办成/.test(btnDead.j.message) && /连不上|没回应/.test(btnDead.j.message),
    'agent 连不上 → 回「没办成：连不上…」这类能念的话（且 HTTP 仍是 200）', btnDead.j.message);
  await putCfg({ agent: { base_url: HERMES_BASE } }, T);

  console.log('— v1.9.36 屏幕按钮④【测试】selftest（自检消息发 IM）');
  ok((await putCfg({ test: { channel: 'wechat' } }, T)).status === 400, 'test.channel 白名单：乱填被拒 400');
  const setCh = await putCfg({ test: { channel: 'feishu' } }, T);
  ok(setCh.status === 200 && setCh.j.config.test.channel === 'feishu', 'test.channel 合法值保存成功');
  ok((await api('GET', '/api/xiaozhi/config', { token: T })).j.config.test.channel === 'feishu', '重新读取仍是 feishu（真落库，不是内存假象）');

  useHermes(0, '今天晴，22 度。');
  const st1 = await bridge({ op: 'selftest' });
  ok(st1.j.ok === false && st1.j.sent === false && st1.j.channel === 'feishu',
    '没配飞书会话 → 明确回「没发出去」+ channel=feishu，而不是 500', JSON.stringify(st1.j));
  ok(/测试消息没发出去/.test(st1.j.message), '回执是一句能念的中文', st1.j.message);
  ok(fake.hits.hermes >= 2, `自检真的探了 agent（ping + 让它查天气，${fake.hits.hermes} 次调用）`);

  await putCfg({ test: { channel: 'dingtalk' } }, T);
  const st2 = await bridge({ op: 'selftest' });
  ok(st2.j.channel === 'dingtalk' && /钉钉/.test(st2.j.message), '切到钉钉后走钉钉通道', st2.j.message);

  // 没指定「查谁的资料」= 不知道该发给谁（钉钉/飞书绑定都是按人按租户存的）
  await putCfg({ query: { uid: null } }, T);
  const st3 = await bridge({ op: 'selftest' });
  ok(st3.j.ok === false && /不知道发给谁/.test(st3.j.message), '没指定收件人时给出原因而不是静默失败', st3.j.message);
  await putCfg({ query: { uid } }, T);

  // v1.9.37 通道自动兜底：选了钉钉、但那位成员名下没绑钉钉，而飞书会话是配好的 → 自动改走飞书。
  // v1.9.36 只会硬发钉钉（默认值就是 dingtalk）→ 静默白按，用户看到的就是「按了测试按钮，飞书没反应」。
  const fc = await api('POST', '/api/feishu/config', {
    token: T,
    body: { app_id: 'cli_x', app_secret: 's', targets: [{ receive_id: 'oc_test', receive_id_type: 'chat_id', name: '测试群' }] },
  });
  ok(fc.status === 200, '给该租户配上一个飞书会话（兜底用例的前置）', JSON.stringify(fc.j));
  await putCfg({ test: { channel: 'dingtalk' } }, T);
  const st4 = await bridge({ op: 'selftest' });
  ok(st4.j.channel === 'feishu' && st4.j.switched === true,
    '选了钉钉但没绑 → 自动改走飞书（测试按钮不再对着一辆空车按）', JSON.stringify(st4.j));
  ok(/自动改走飞书/.test(st4.j.message || ''), '回执说清「已自动改走飞书」，板子能念出来', st4.j.message);
  ok(st4.j.sent === false || /飞书/.test(st4.j.message), '走的是飞书那条通道（假凭证下失败也要如实说）', JSON.stringify(st4.j));
  // 收尾：清掉飞书会话，别影响后面的用例
  await api('POST', '/api/feishu/config', { token: T, body: { app_id: '', app_secret: '', targets: [] } });

  const btnLog = (await api('GET', '/api/xiaozhi/agent-log?limit=50', { token: T })).j.entries || [];
  ok(btnLog.some((e) => e.mode === 'button' && e.status === 'ok' && /灯已经关了/.test(e.result || '')),
    '按钮对话落审计（面板「Agent对话记录」能看到 mode=button）');
  ok(btnLog.some((e) => e.mode === 'button' && e.status === 'rejected' && e.reason === 'risky'), '被拦下的那次也留痕');
  ok(btnLog.some((e) => e.mode === 'button' && e.request === '自检'), '自检消息也留痕');

  console.log('— 审计留痕');
  const log = await api('GET', '/api/xiaozhi/agent-log?limit=50', { token: T });
  const entries = (log.j.entries) || [];
  ok(entries.length >= 6, `审计流水有记录（${entries.length} 条）`);
  ok(entries.some((e) => e.status === 'rejected' && e.reason === 'not_addressed'), '审计区分了「没点名」这类拒绝原因');
  ok(entries.some((e) => e.mode === 'async-receipt'), '审计记下了异步回执');
  ok(entries.some((e) => e.mode === 'async' && e.result && e.result.includes('内存')), '慢任务算完后落了完成态（证明没被 abort）');
  ok(!entries.some((e) => /sk-hermes/.test(JSON.stringify(e))), '审计里不落密钥');

  console.log('— 接入点配置校验');
  ok((await putCfg({ mcp: { url: 'http://192.168.1.5:3000' } }, T)).status === 400, '接入点地址非 wss:// 被拒');
  ok((await putCfg({ mcp: { url: 'wss://api.xiaozhi.me/mcp/' } }, T)).status === 200, '合法 wss 接入点地址保存成功');
  // 控制台给的那条地址自带 ?token=…：混进 url 就会明文躺在 xiaozhi_config 里，
  // 而 GET /xiaozhi/config 把整个 config 回给前端（成员也读得到）——必须挡在保存之前
  const leak = await putCfg({ mcp: { url: 'wss://api.xiaozhi.me/mcp/?token=eyJleGFtcGxlIn0.sig' } }, T);
  ok(leak.status === 400, '地址里自带 token 被拒 400（防密钥明文入库 + 回显给成员）', JSON.stringify(leak.j));
  ok((await api('GET', '/api/xiaozhi/config', { token: T })).j.config.mcp.url === 'wss://api.xiaozhi.me/mcp/', '被拒的地址没被写进配置（仍是上一条合法的）');

  console.log('— 通道 A：假小智云（真 WebSocket 全链路：握手 / tools-list / tools-call / 改名 / 断线重连）');
  const certDir = mkdtempSync(path.join(tmpdir(), 'wb-xzcert-'));
  let cloud = null;
  try {
    // 内置 WebSocket 没地方传 rejectUnauthorized，所以用自签证书 + 子进程 NODE_TLS_REJECT_UNAUTHORIZED=0
    const gen = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', path.join(certDir, 'k.pem'), '-out', path.join(certDir, 'c.pem'),
      '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    ok(gen.status === 0, 'openssl 生成自签证书（假小智云用）', gen.error ? gen.error.message : `exit ${gen.status}`);
    if (gen.status === 0) {
      cloud = makeFakeCloud({ key: readFileSync(path.join(certDir, 'k.pem')), cert: readFileSync(path.join(certDir, 'c.pem')) });
      await cloud.listen();

      const on = await putCfg({ mcp: { enabled: true, url: `wss://127.0.0.1:${MCP_PORT}/mcp/` }, mcp_token: 'tok-A' }, T);
      ok(on.status === 200 && on.j.config.mcp.token_set === true, '启用接入点 + token 已加密保存（只回 token_set 布尔）');
      ok(!JSON.stringify(on.j).includes('tok-A'), '返回体里没有 token 明文');

      const ready = await until(async () => (await api('GET', '/api/xiaozhi/config', { token: T })).j.config.mcp.connected === true, 12000);
      ok(ready, '工作台真的连上了假小智云（真 WebSocket 建连 + 握手）');
      const c0 = cloud.state.conns[0];
      ok(!!c0, '假云端收到连接');
      ok(c0 && c0.url.includes('token=tok-A'), '连接地址自动带上了 token（endpoint 拼对了）', c0 && c0.url);
      ok(c0 && (c0.url.match(/token=/g) || []).length === 1, 'token 只出现一次（没被拼成重复参数）');

      ok(await until(() => c0 && (c0.tools || c0.error), 9000), '走完了 initialize → notifications/initialized → tools/list');
      ok(c0 && c0.init && c0.init.protocolVersion === '2024-11-05' && !!c0.init.capabilities.tools, 'initialize 回了协议版本与 tools 能力', JSON.stringify(c0 && c0.init));
      ok(c0 && c0.tools && c0.tools.length === 2, `tools/list 回了两个工具（${c0 && c0.tools ? c0.tools.map((t) => t.name).join(' + ') : '—'}）`);
      // 不写死条数：本项目前面为测回包体积又补了一条含「装修」的笔记，命中几条由那边决定
      ok(c0 && /找到 \d+ 条/.test(c0.askText || '') && c0.askText.includes('装修'), 'tools/call 经真 socket 打回 ask，拿到确定性文案', c0 && c0.askText);
      ok(c0 && c0.delegateDesc.includes('贾维斯'), 'delegate 描述里带的是当前配置的真名', c0 && c0.delegateDesc.slice(0, 70));

      // 改名：配置一改桥接就主动重连，云端重新拉到的工具表必须已带新名字（= 不用烧固件的根据）
      const n0 = cloud.state.conns.length;
      await putCfg({ agent: { name: '星期五', aliases: ['小五'] } }, T);
      ok(await until(() => cloud.state.conns.length > n0, 12000), '改配置后桥接主动重连（改名立即生效的机制）');
      const c1 = cloud.state.conns[cloud.state.conns.length - 1];
      await until(() => c1 && (c1.tools || c1.error), 9000);
      ok(c1 && c1.delegateDesc.includes('星期五') && c1.delegateDesc.includes('小五'), '重连后工具描述已换成新名字与新别名', c1 && c1.delegateDesc.slice(0, 80));
      const stillOn = (await api('GET', '/api/xiaozhi/config', { token: T })).j.config.mcp.connected;
      ok(stillOn === true, '重连的交接期状态灯没被旧连接的 close 打回「未连接」（迟到事件已加判据）');
      await putCfg({ agent: { name: '贾维斯', aliases: [] } }, T);

      // 断线：云端掐掉连接 → 状态转未连接 → 自动重连（指数退避最小 3s）
      // 先等最后那次重连的 upgrade 真正落地——否则掐掉的是上一根已在关闭的 socket，新连接活得好好的
      await until(async () => (await api('GET', '/api/xiaozhi/config', { token: T })).j.config.mcp.connected === true, 8000);
      await sleep(400);
      const n1 = cloud.state.conns.length;
      cloud.dropAll();
      ok(await until(async () => (await api('GET', '/api/xiaozhi/config', { token: T })).j.config.mcp.connected === false, 8000), '云端断线后状态转「未连接」（面板状态灯会变色）');
      ok(await until(() => cloud.state.conns.length > n1, 15000), '断线后自动重连（退避后自己回来了）');

      await putCfg({ mcp: { enabled: false } }, T);
      ok(await until(async () => (await api('GET', '/api/xiaozhi/config', { token: T })).j.config.mcp.connected === false, 6000), '关掉开关就断开（不再挂着连接）');
    }
  } catch (e) {
    ok(false, '通道 A 段异常：' + e.message);
  } finally {
    if (cloud) await cloud.close();
    try { rmSync(certDir, { recursive: true, force: true }); } catch { /* 尽力 */ }
  }
} catch (e) {
  failed++;
  console.error('未捕获异常:', e);
} finally {
  try { server.kill(); } catch { /* 已退 */ }
  try { fakeSrv.close(); } catch { /* 已关 */ }
  try { rmSync(DATA, { recursive: true, force: true }); } catch { /* 尽力 */ }
  if (failed) {
    console.error(`\n服务端日志尾部:\n${serverLog.slice(-1500)}`);
  }
  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  process.exit(failed ? 1 : 0);
}
