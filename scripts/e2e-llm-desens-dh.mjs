// E2E（v1.13.1）：LLM在线模型对话接入 AI 脱敏 + 数字人「智能家居控制」tab。
//
// 覆盖：
//   A /ai/desensitize-meta（走 /ai 前缀 = smarthome.llm 权限，不借效率工具的 /desensitize/meta）；
//   B 流式 /ai/chat + desensitize:true —— 断言**桩收到的语料里没有真名、只有代码**，
//     浏览器侧收到的是复原后的真名；mask 事件、增量复原（代码被切碎也不漏乱码）、历史留痕；
//   C 非流式回体同样复原 + 带 mapping/count；
//   D 不勾脱敏 = 老行为（原文直发、无 mask 事件）；
//   E 总开关关闭时如实回 mask_skipped，且**桩收到的仍是原文**（绝不假装脱敏）；
//   F 权限：/dh 与 /ai 都判到 smarthome 页；只有 dh 的拿不到 /ai/*，只有 llm 的拿不到 /dh/*；
//   G /dh/smarthome/*：设备一览未绑米家不 500、control/alias/config/speaker-test 的校验与落库。
//
// AI 一律本地桩；语料断言全部读桩收到的请求体——猜的契约不算数。
import http from 'node:http';
import { pageForPath } from '../server/auth.js';
import { startServer, login, api, checker } from './_noteE2E.mjs';

const { ck, done } = checker();
const CODE_RE = /\b(?:ORG|PER|DEPT|GRP|ACC|PWD|KEY|MAIL|PHONE|ID|KW|NUM)-[A-Z0-9]{5}\b/g;
const CODE_PREFIX_RE = /(?:^|[^A-Z0-9-])(?:ORG|PER|DEPT|GRP|ACC|PWD|KEY|MAIL|PHONE|ID|KW|NUM)-[A-Z0-9]{0,5}/;
const codesIn = (s) => String(s || '').match(CODE_RE) || [];

const REAL_ORG = '杭州未来科技有限公司';
const REAL_PER = '张三';

// ---------- 桩 AI（OpenAI 形状；流式/非流式都支持）----------
const calls = [];
const stub = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (c) => { buf += c; });
  req.on('end', () => {
    calls.push(buf);
    let body = {};
    try { body = JSON.parse(buf); } catch { /* 原样 */ }
    const userMsg = (body.messages || []).slice(-1)[0]?.content;
    const user = typeof userMsg === 'string' ? userMsg : JSON.stringify(userMsg || '');
    const codes = [...new Set(codesIn(user))];
    // 回包**只引用代码**（真实 AI 也只能看到代码）——结果里若出现真名，只可能是服务端复原出来的
    const text = codes.length ? `联系人 ${codes.slice(0, 2).join(' / ')} 已记录` : `原文：${user.slice(0, 40)}`;
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // 故意每 3 个字符切一块 —— 代码必然被切成两截，考增量复原的留尾逻辑
      for (let i = 0; i < text.length; i += 3) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 3) } }] })}\n\n`);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: text } }], usage: { total_tokens: 12 } }));
  });
});
await new Promise((r) => stub.listen(3993, '127.0.0.1', r));

// SSE 读流：把 data: 行解析成事件数组
async function sseChat(B, H, body) {
  const r = await fetch(`${B}/api/ai/chat`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  if (!r.ok) return { status: r.status, events: [], raw: (await r.text()).slice(0, 200) };
  const dec = new TextDecoder();
  const events = [];
  let buf = '';
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const p of parts) {
      const line = p.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const s = line.slice(5).trim();
      if (!s) continue;
      try { events.push(JSON.parse(s)); } catch { /* 跳过坏行 */ }
    }
  }
  return { status: r.status, events };
}

const srv = await startServer({ tag: 'llmdesens', port: 3987 });
const { B } = srv;

try {
  const admin = await login(B, 'admin', 'test123456');
  const A = api(B, admin.H);
  await A.post('/ai/config', { model: 'stub-chat', base_url: 'http://127.0.0.1:3993/v1', api_key: 'sk-stub-e2e' });

  // ---------- A. 规则摘要（走 /ai 前缀，不借效率工具那条）----------
  let r = await A.get('/ai/desensitize-meta');
  ck('A1 /ai/desensitize-meta 回类型目录 + 总开关默认开',
    r.status === 200 && Array.isArray(r.body.types) && r.body.types.length >= 10 && r.body.enabled === true,
    `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  ck('A2 带上 types_on / 数值开关 / 固定关键词条数（面板要用）',
    typeof r.body.types_on === 'object' && r.body.mask_numbers === false && r.body.fixed_count === 0,
    JSON.stringify({ n: r.body.mask_numbers, f: r.body.fixed_count }));

  // 取材说明：人名走引擎既有的启发式（职务词前缀「对接人张三」/ 称谓 / 引号）——
  // 光秃秃的两个字（「张三来了」）不在识别范围里，这是 v1.13.0 引擎的既定口径（宁漏不误伤）。
  const ASK = `对接人${REAL_PER}，公司是${REAL_ORG}，密码是 Passw0rd#2026`;

  // ---------- B. 流式 + 脱敏 ----------
  calls.length = 0;
  let s = await sseChat(B, admin.H, { messages: [{ role: 'user', content: ASK }], stream: true, desensitize: true });
  const maskEv = s.events.find((e) => e.mask);
  const deltas = s.events.filter((e) => e.delta).map((e) => e.delta);
  const doneEv = s.events.find((e) => e.done);
  const joined = deltas.join('');
  ck('B1 流式：先收到 mask 事件，带本轮对照表',
    s.status === 200 && !!maskEv && !maskEv.mask.skipped && maskEv.mask.count >= 2
    && maskEv.mask.mapping.some((m) => m.term === REAL_PER) && maskEv.mask.mapping.some((m) => m.term === REAL_ORG),
    JSON.stringify(maskEv).slice(0, 220));
  const stubUser = (() => { try { return JSON.parse(calls[0]).messages.slice(-1)[0].content; } catch { return ''; } })();
  ck('B2 桩收到的语料里没有真名（公司名 / 人名 / 密码都不在）',
    !!stubUser && !stubUser.includes(REAL_ORG) && !stubUser.includes(REAL_PER) && !stubUser.includes('Passw0rd#2026'),
    String(stubUser).slice(0, 200));
  ck('B3 桩收到的语料换成了代码（>=3 个）', codesIn(stubUser).length >= 3, codesIn(stubUser).join(','));
  ck('B4 浏览器侧看到的是复原后的真名，一个代码都不剩',
    !!doneEv && doneEv.content.includes(REAL_PER) && doneEv.content.includes(REAL_ORG) && codesIn(doneEv.content).length === 0,
    JSON.stringify(doneEv && doneEv.content));
  ck('B5 增量复原：所有 delta 拼起来 == 最终 content', joined === doneEv.content, `${JSON.stringify(joined)} vs ${JSON.stringify(doneEv && doneEv.content)}`);
  ck('B6 中途没有半个代码漏出来（每块 delta 都干净）',
    deltas.every((d) => !CODE_PREFIX_RE.test(d)), deltas.filter((d) => CODE_PREFIX_RE.test(d)).join('|'));
  ck('B7 done 事件标记 masked=true 且没有 mask_skipped',
    doneEv && doneEv.masked === true && !doneEv.mask_skipped, JSON.stringify(doneEv).slice(0, 160));
  ck('B8 该轮落了一条 scope=llm_chat 的脱敏历史',
    (await A.get('/desensitize/history?scope=llm_chat')).body.items.some((h) => h.scope === 'llm_chat' && h.item_count >= 2),
    JSON.stringify((await A.get('/desensitize/history?scope=llm_chat')).body.items.map((h) => h.scope + ':' + h.item_count)));

  // ---------- C. 非流式 + 脱敏 ----------
  calls.length = 0;
  r = await A.post('/ai/chat', { messages: [{ role: 'user', content: ASK }], stream: false, desensitize: true });
  const cStubUser = (() => { try { return JSON.parse(calls[0]).messages.slice(-1)[0].content; } catch { return ''; } })();
  ck('C1 非流式：桩收到的是代码，不是真名',
    r.status === 200 && !!cStubUser && !cStubUser.includes(REAL_ORG) && !cStubUser.includes(REAL_PER),
    String(cStubUser).slice(0, 160));
  ck('C2 回体里已是真名 + 带 count/mapping 供面板显示',
    r.body.content.includes(REAL_ORG) && r.body.content.includes(REAL_PER)
    && r.body.masked === true && r.body.count >= 2 && r.body.mapping.length === r.body.count,
    JSON.stringify(r.body).slice(0, 200));

  // ---------- D. 不勾脱敏 = 老行为 ----------
  calls.length = 0;
  s = await sseChat(B, admin.H, { messages: [{ role: 'user', content: ASK }], stream: true });
  const dStubUser = (() => { try { return JSON.parse(calls[0]).messages.slice(-1)[0].content; } catch { return ''; } })();
  ck('D1 不勾脱敏：桩原样收到真名', String(dStubUser).includes(REAL_ORG) && String(dStubUser).includes(REAL_PER), String(dStubUser).slice(0, 160));
  ck('D2 不勾脱敏：没有 mask 事件，delta 原样透传',
    !s.events.some((e) => e.mask) && s.events.filter((e) => e.delta).map((e) => e.delta).join('').includes(String(dStubUser).slice(0, 10)),
    JSON.stringify(s.events.slice(0, 2)).slice(0, 160));

  // ---------- E. 总开关关闭：如实告知，不假装脱敏 ----------
  await A.put('/desensitize/config', { enabled: false });
  calls.length = 0;
  s = await sseChat(B, admin.H, { messages: [{ role: 'user', content: ASK }], stream: true, desensitize: true });
  const eMask = s.events.find((e) => e.mask);
  const eDone = s.events.find((e) => e.done);
  const eStubUser = (() => { try { return JSON.parse(calls[0]).messages.slice(-1)[0].content; } catch { return ''; } })();
  ck('E1 总开关关着：mask 事件如实写 skipped + 原因', !!eMask && eMask.mask.skipped === true && /总开关/.test(eMask.mask.reason || ''), JSON.stringify(eMask));
  ck('E2 总开关关着：桩收到的仍是原文（没有偷偷脱敏也没撒谎说脱了）',
    String(eStubUser).includes(REAL_ORG) && String(eStubUser).includes(REAL_PER), String(eStubUser).slice(0, 160));
  ck('E3 done 事件带 mask_skipped 文案，前端能亮黄牌', !!eDone && !!eDone.mask_skipped && eDone.masked === false, JSON.stringify(eDone).slice(0, 180));
  await A.put('/desensitize/config', { enabled: true });

  // ---------- F. 权限 ----------
  ck('F1 pageForPath(/dh/smarthome/devices) 判到 smarthome 页（漏了权限就形同虚设）',
    pageForPath('/dh/smarthome/devices') === 'smarthome', String(pageForPath('/dh/smarthome/devices')));
  ck('F2 pageForPath(/ai/desensitize-meta) 判到 smarthome 页',
    pageForPath('/ai/desensitize-meta') === 'smarthome', String(pageForPath('/ai/desensitize-meta')));
  const mkUser = (name, tabs) => fetch(`${B}/api/users`, {
    method: 'POST', headers: admin.H,
    body: JSON.stringify({ username: name, password: 'un123456', allowed_pages: ['smarthome'], allowed_tabs: { smarthome: tabs } }),
  });
  await mkUser('uDhOnly', ['dh']);
  await mkUser('uLlmOnly', ['llm']);
  const dhU = await login(B, 'uDhOnly', 'un123456');
  const llmU = await login(B, 'uLlmOnly', 'un123456');
  const dhApi = api(B, dhU.H), llmApi = api(B, llmU.H);
  r = await dhApi.get('/dh/smarthome/devices');
  ck('F3 只有 dh 权限：/dh/smarthome/devices 200', r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  r = await dhApi.get('/ai/desensitize-meta');
  ck('F4 只有 dh 权限：/ai/desensitize-meta 403（两个 tab 互不隶属）', r.status === 403, String(r.status));
  r = await llmApi.get('/ai/desensitize-meta');
  ck('F5 只有 llm 权限：/ai/desensitize-meta 200', r.status === 200, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  r = await llmApi.get('/dh/smarthome/devices');
  ck('F6 只有 llm 权限：/dh/smarthome/devices 403', r.status === 403, String(r.status));

  // ---------- G. /dh/smarthome/* ----------
  r = await A.get('/dh/smarthome/devices');
  ck('G1 未绑米家也回 200 + bound:false（不是 500）',
    r.status === 200 && r.body.bound === false && Array.isArray(r.body.devices) && r.body.is_admin === true,
    `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  ck('G2 回体带控制通道默认值与家庭过滤', r.body.channel === 'direct' && !!r.body.home_filter, JSON.stringify({ c: r.body.channel, h: r.body.home_filter }));
  ck('G3 非管理员看得到 but is_admin=false（面板据此禁用编辑）',
    (await dhApi.get('/dh/smarthome/devices')).body.is_admin === false);

  r = await A.post('/dh/smarthome/control', { did: 'a b', action: 'on' });
  ck('G4 control：did 格式不对 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  r = await A.post('/dh/smarthome/control', { did: '123456', action: 'explode' });
  ck('G5 control：action 白名单外 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  r = await A.post('/dh/smarthome/control', { did: '123456', action: 'on' });
  ck('G6 control：合法入参不被校验拦下（未绑米家故 503 也算过闸）', r.status !== 400, `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);

  r = await dhApi.put('/dh/smarthome/alias', { did: '123456', alias: '客厅灯' });
  ck('G7 别名：非管理员 → 403', r.status === 403, String(r.status));
  r = await A.put('/dh/smarthome/alias', { did: '123456', alias: 'x'.repeat(33) });
  ck('G8 别名：超 32 字 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  r = await A.put('/dh/smarthome/alias', { did: '123456', alias: '主灯' });
  ck('G9 别名：管理员登记成功，落库并回全表',
    r.status === 200 && r.body.ok === true && r.body.device_aliases['123456'] === '主灯',
    JSON.stringify(r.body).slice(0, 160));
  r = await A.put('/dh/smarthome/alias', { did: '123456', alias: '' });
  ck('G10 别名：空别名 = 解除登记（替换语义，不会复活）', r.status === 200 && !r.body.device_aliases['123456'], JSON.stringify(r.body));

  r = await dhApi.put('/dh/smarthome/config', { channel: 'direct' });
  ck('G11 配置：非管理员 → 403', r.status === 403, String(r.status));
  r = await A.put('/dh/smarthome/config', { channel: 'telepathy' });
  ck('G12 配置：channel 白名单外 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  r = await A.put('/dh/smarthome/config', { home_filter: 'x'.repeat(33) });
  ck('G13 配置：家庭名超 32 字 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  r = await A.put('/dh/smarthome/config', {});
  ck('G14 配置：没有可存字段 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);
  r = await A.put('/dh/smarthome/config', { channel: 'speaker', home_filter: '我家' });
  ck('G15 配置：合法保存回体一致', r.status === 200 && r.body.config.channel === 'speaker' && r.body.config.home_filter === '我家', JSON.stringify(r.body));
  r = await A.get('/dh/smarthome/devices');
  ck('G16 配置真的落库（重读一致）', r.body.channel === 'speaker' && r.body.home_filter === '我家', JSON.stringify({ c: r.body.channel, h: r.body.home_filter }));
  await A.put('/dh/smarthome/config', { channel: 'direct', home_filter: 'all' });

  r = await A.post('/dh/smarthome/speaker-test', { text: '' });
  ck('G17 试播：text 为空 → 400', r.status === 400, `${r.status} ${JSON.stringify(r.body)}`);

  r = await A.get('/dh/smarthome/devices');
  ck('G18 面板要的字段齐（devices/homes/home_filter/channel/speaker/is_admin）',
    ['devices', 'homes', 'home_filter', 'channel', 'speaker', 'is_admin'].every((k) => k in r.body), Object.keys(r.body).join(','));
} finally {
  srv.stop();
  stub.close();
}

done();
