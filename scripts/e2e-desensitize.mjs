// E2E（v1.13.0）：AI 数据脱敏全链路。
//
// 覆盖：
//   A 引擎纯函数：各类型抽取 / 同名同码 / 最长优先 / decode 往返 / 数值开关 / 泛称不误伤 /
//     固定关键词表（含自定义代码）；
//   B 配置读写往返 + 试运行预览落 history；
//   C **AI复盘IM**：桩收到的语料里没有真名、只有代码；任务 mask.mapping 有内容；
//     AI 回包里的代码在结果里被复原成真名；history 落 im_review；
//   D **笔记 AI 总结/续写/翻译**：preview 只脱敏不调 AI（桩零调用）；带 session_id 发送时
//     桩收到的文本已脱敏、返回结果已复原；不带 session_id = 上线前的老行为（原文直发）；
//   E 权限：/desensitize 判到 tools 页；没有 tools.desens 的用户 403，有的 200；
//   F 总开关（enabled=0）：IM 复如实记日志不脱敏、笔记 preview 回报 disabled 而不是假装脱敏。
//
// AI 一律本地桩（http 服务），**语料内容断言全部读桩收到的请求体**——猜的契约不算数。
import http from 'node:http';
import svc from '../server/services/desensitizeService.js';
import { pageForPath } from '../server/auth.js';
import { startServer, login, api, checker, j } from './_noteE2E.mjs';

const { ck, done } = checker();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CODE_RE = /\b(?:ORG|PER|DEPT|GRP|ACC|PWD|KEY|MAIL|PHONE|ID|KW|NUM)-[A-Z0-9]{5}\b/g;
const codesIn = (s) => String(s || '').match(CODE_RE) || [];

// ---------- A. 引擎纯函数（不需要服务器）----------
try {
  const SAMPLE = [
    '【会话】杭州未来科技有限公司工作群（3 条）',
    '张三：跟深圳星辰网络科技的合同定稿了吗？密码是 Passw0rd#2026，账号 zhang3',
    '李四：API KEY 是 sk-abcdef1234567890XYZ，联系张总 13812345678 或 me@corp.com',
    '王五：身份证 110101199003071234，研发部门下周一开会，金额 12880 元',
  ].join('\n');
  const hints = ['杭州未来科技有限公司工作群', '张三', '李四', '王五'];
  const enc = svc.encode(SAMPLE, { types: {}, fixed_terms: [], nameHints: hints });
  const byTerm = (t) => enc.mapping.find((m) => m.term === t);
  ck('A1 公司名（后缀锚定，后面跟着汉字也认得）', !!byTerm('杭州未来科技有限公司') && !!byTerm('深圳星辰网络科技'),
    enc.mapping.map((m) => m.term).join(' / '));
  ck('A2 部门名（研发部门）', byTerm('研发部门') && byTerm('研发部门').type === 'dept');
  ck('A3 密码值不被后面半句话污染', byTerm('Passw0rd#2026') && byTerm('Passw0rd#2026').type === 'pwd',
    JSON.stringify(enc.mapping.find((m) => m.type === 'pwd')));
  ck('A4 API KEY / 邮箱 / 手机 / 身份证', byTerm('sk-abcdef1234567890XYZ') && byTerm('me@corp.com')
    && byTerm('13812345678') && byTerm('110101199003071234'));
  ck('A5 人名启发式（张三 / 李四 / 张总带称谓）', byTerm('张三') && byTerm('李四') && byTerm('张总'),
    enc.mapping.filter((m) => m.type === 'person').map((m) => m.term).join(','));
  ck('A6 群名整条（会话名）', byTerm('杭州未来科技有限公司工作群') && byTerm('杭州未来科技有限公司工作群').type === 'group');
  ck('A7 同一名词本轮同一代码（扫一遍建表再替换）', (() => {
    const e = svc.encode('张总来了，张总走了，张总又来了', {});
    const hit = e.mapping.filter((m) => m.term === '张总');
    return hit.length === 1 && e.masked.split(hit[0].code).length - 1 === 3;
  })());
  ck('A8 长词优先：张三丰不被张三吃掉', (() => {
    const src = '张三丰和张三都来了';
    const e = svc.encode(src, { fixed_terms: [{ term: '张三丰' }, { term: '张三' }] });
    return e.mapping.length === 2 && new Set(e.mapping.map((m) => m.code)).size === 2
      && !e.masked.includes('张三') && svc.decode(e.masked, e.mapping) === src;
  })());
  ck('A9 数值默认不脱敏（影响 AI 算数的开关默认关）', svc.encode('金额 12880 元', {}).mapping.length === 0);
  ck('A10 数值开关打开才脱敏', svc.encode('金额 12880 元', { mask_numbers: true }).mapping.some((m) => m.type === 'numbers'));
  ck('A11 泛称不误伤（这部分工作全部完成 / 很多部门 / 科技公司）',
    svc.encode('这部分工作全部完成，很多部门都在等，这是我们公司的下一步', {}).mapping.length === 0
    && svc.encode('科技公司和大数据公司都在做人工智能', {}).mapping.length === 0);
  const fx = svc.encode('内部代号是夜枭，联系人老周', { fixed_terms: [{ term: '夜枭', code: 'X-001' }, { term: '老周' }] });
  ck('A12 固定关键词表：写进去的一律替换，支持自定义代码',
    fx.masked.includes('X-001') && fx.mapping.some((m) => m.term === '老周' && m.type === 'custom'), fx.masked);
  ck('A13 decode 往返逐字一致', svc.decode(enc.masked, enc.mapping) === SAMPLE);
  ck('A14 decodeDeep 复原嵌套对象', (() => {
    const e = svc.encode('回复张总的合同', {});
    const o = svc.decodeDeep({ summary: e.masked, todos: [{ title: e.masked }] }, e.mapping);
    return o.summary === '回复张总的合同' && o.todos[0].title === '回复张总的合同';
  })());
  ck('A15 对照表里有「名词 → 代码」的中文名，AI 侧只该看到代码', enc.mapping.every((m) => /-/.test(m.code) && m.term));
} catch (e) {
  ck('A 组引擎测试未抛异常', false, e && e.message);
}

// ---------- 桩 AI ----------
const imCalls = [];
const imStub = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (c) => { buf += c; });
  req.on('end', () => {
    imCalls.push({ url: req.url, body: buf });
    let user = '';
    try { user = JSON.parse(buf).messages.slice(-1)[0].content; } catch { /* 原样 */ }
    const codes = [...new Set(codesIn(user))];
    // 回包**只引用代码**（真实 AI 也只能看到代码）——结果里若出现真名，只可能是服务端复原出来的
    const payload = {
      summary: '概要：' + (codes.slice(0, 3).join('、') || '(无代码)'),
      highlights: ['重点：' + (codes[0] || '无')],
      todos: [{ title: '回复 ' + (codes[0] || '无'), note: '涉及 ' + (codes[1] || codes[0] || '无') }],
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }], usage: { total_tokens: 42 } }));
  });
});
const noteCalls = [];
const noteStub = http.createServer((req, res) => {
  let buf = '';
  req.on('data', (c) => { buf += c; });
  req.on('end', () => {
    noteCalls.push({ url: req.url, body: buf });
    let user = '';
    try { user = JSON.parse(buf).messages.slice(-1)[0].content; } catch { /* 原样 */ }
    const code = [...new Set(codesIn(user))].join('、');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: `摘要：${code}（这是 AI 写的）` } }],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    }));
  });
});
await new Promise((r) => imStub.listen(3989, '127.0.0.1', r));
await new Promise((r) => noteStub.listen(3991, '127.0.0.1', r));

const srv = await startServer({ tag: 'desens', port: 3986 });
const { B } = srv;

try {
  const admin = await login(B, 'admin', 'test123456');
  const A = api(B, admin.H);

  // ---------- B. 配置 / 试运行 / 历史 ----------
  let r = await A.get('/desensitize/meta');
  ck('B1 meta 回类型目录 + 默认配置（总开关默认开、数值默认关）',
    r.status === 200 && Array.isArray(r.body.types) && r.body.types.length >= 10
    && r.body.config.enabled === true && r.body.config.mask_numbers === false, JSON.stringify(r.body.config));

  r = await A.put('/desensitize/config', {
    enabled: true, mask_numbers: true, types: { phone: false }, fixed_terms: [{ term: '夜枭', code: 'X-001' }],
  });
  ck('B2 保存配置回体一致', r.status === 200 && r.body.mask_numbers === true && r.body.types.phone === false
    && r.body.fixed_terms[0].code === 'X-001', JSON.stringify(r.body));
  r = await A.get('/desensitize/config');
  ck('B3 配置真的落库（重读一致）', r.body.mask_numbers === true && r.body.types.phone === false);

  r = await A.post('/desensitize/preview', { text: '对接人张三，电话 13812345678，代号夜枭，金额 12880' });
  ck('B4 试运行：脱敏后文本 + 对照表', r.status === 200 && r.body.count >= 2
    && r.body.masked.includes('X-001') && !r.body.masked.includes('夜枭')
    && r.body.mapping.some((m) => m.term === '张三'), JSON.stringify(r.body).slice(0, 200));
  ck('B5 类型开关生效：phone 关掉后不识别手机号', !r.body.mapping.some((m) => m.type === 'phone'),
    JSON.stringify(r.body.mapping.map((m) => m.type)));
  ck('B6 数值开关生效（B2 打开了）', r.body.mapping.some((m) => m.type === 'numbers'));
  const manualId = r.body.id;
  r = await A.get('/desensitize/history?scope=manual');
  ck('B7 试运行落了一条 scope=manual 历史', r.body.items.some((h) => h.id === manualId && h.scope === 'manual'),
    JSON.stringify(r.body.items.map((h) => h.id + ':' + h.scope)));
  r = await A.get(`/desensitize/history/${manualId}`);
  ck('B8 单条历史带完整对照表', r.status === 200 && r.body.mapping.length === r.body.item_count && !!r.body.masked_preview);

  // 复原本轮配置（后面几组用默认口径：数值不脱敏，全类型开）
  await A.put('/desensitize/config', { enabled: true, mask_numbers: false, types: {}, fixed_terms: [] });

  // ---------- C. AI复盘IM 接入 ----------
  const inT = (h) => {
    const d = new Date(Date.now() - h * 3600000), p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const mk = async (name, parent) => (await A.post('/notes/folders', { name, parent_id: parent })).body.id;
  const tree = (await A.get('/notes/folders')).body;
  const findNode = (ns, name) => {
    for (const n of ns || []) { if (n.name === name) return n; const h = findNode(n.children, name); if (h) return h; }
    return null;
  };
  const seedIm = findNode(tree, 'IM连接');
  const root = seedIm ? seedIm.id : await mk('IM连接', null);
  const folder = await mk('脱敏e2e', root);
  const line = (t, who, text) => `- **${t}｜${who}**：${text}`;
  await A.post('/notes', {
    title: `张三-${inT(2)}-脱敏e2e`, folder_id: folder,
    content: ['# 会话', '', '- 会话 ID：`oc_x`', '', `## ${inT(1)} 同步（新增 3 条）`, '',
      line(inT(2), '张三', '合同方是杭州未来科技有限公司，对接人李四'),
      line(inT(1), '李四', '他们研发部门的张总电话 13812345678，密码是 Passw0rd#2026'),
      line(inT(1), '我', '好，我把杭州未来科技有限公司的报价发你'),
    ].join('\n'),
  });

  await A.post('/ai/config', { model: 'stub-chat', base_url: 'http://127.0.0.1:3989/v1', api_key: 'sk-stub-e2e' });
  imCalls.length = 0;
  r = await A.post('/life/im-review/jobs', { folder_id: folder, days: 1, desensitize: true });
  ck('C1 勾了脱敏的任务起得来', r.status === 200 && r.body.state === 'running', `${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  let job = r.body;
  for (let i = 0; i < 100 && job.state === 'running'; i++) {
    await sleep(150);
    job = (await A.get('/life/im-review/jobs/latest')).body;
  }
  ck('C2 任务跑到终态 done', job.state === 'done', JSON.stringify({ state: job.state, logs: (job.logs || []).slice(-2) }));

  // 桩收到的语料（AI 侧真收到的才算数）
  const imUser = (() => { try { return JSON.parse(imCalls[0].body).messages.slice(-1)[0].content; } catch { return ''; } })();
  ck('C3 桩收到语料：真名已不在（公司名 / 人名 / 密码）',
    !imUser.includes('杭州未来科技有限公司') && !imUser.includes('张三') && !imUser.includes('Passw0rd#2026'),
    imUser.slice(0, 200));
  ck('C4 桩收到语料：换成了代码', codesIn(imUser).length >= 3, codesIn(imUser).join(','));
  ck('C5 对照表挂在任务快照上（面板要显示）', job.mask && job.mask.mapping.length >= 3 && job.mask.count === job.mask.mapping.length,
    JSON.stringify(job.mask && job.mask.count));
  ck('C6 公司名按 org 认（后缀锚定）', job.mask.mapping.some((m) => m.term === '杭州未来科技有限公司' && m.type === 'org'),
    JSON.stringify(job.mask.mapping.map((m) => m.term + ':' + m.type)));
  ck('C7 说话人靠名字提示表认成人名', job.mask.mapping.some((m) => m.term === '张三' && m.type === 'person'));
  ck('C8 AI 回包里的代码在结果里被复原成真名',
    job.result.summary.includes('杭州未来科技有限公司') || job.result.summary.includes('张三')
    || job.result.todos[0].title.includes('张三'),
    JSON.stringify(job.result).slice(0, 200));
  ck('C9 复原后的结果里不留代码', codesIn(JSON.stringify(job.result)).length === 0,
    codesIn(JSON.stringify(job.result)).join(','));
  ck('C10 完成日志写明了脱敏条数', (job.logs || []).some((l) => /脱敏：\d+ 个专有名词已换成随机代码/.test(l.msg)),
    (job.logs || []).map((l) => l.msg).slice(-3).join(' | '));

  r = await A.get('/desensitize/history?scope=im_review');
  const imHist = r.body.items[0];
  ck('C11 落一条 im_review 历史且 ref=任务 id、状态 sent',
    imHist && imHist.ref === String(job.id) && imHist.status === 'sent' && imHist.item_count >= 3,
    JSON.stringify(imHist && { ref: imHist.ref, status: imHist.status, n: imHist.item_count }));

  // 不勾脱敏 = 老行为：语料里真名照旧
  imCalls.length = 0;
  r = await A.post('/life/im-review/jobs', { folder_id: folder, days: 1 });
  job = r.body;
  for (let i = 0; i < 100 && job.state === 'running'; i++) { await sleep(150); job = (await A.get('/life/im-review/jobs/latest')).body; }
  const imUser2 = (() => { try { return JSON.parse(imCalls[0].body).messages.slice(-1)[0].content; } catch { return ''; } })();
  ck('C12 不勾脱敏时语料原样（真名照旧）= 未回归老行为',
    imUser2.includes('杭州未来科技有限公司') && imUser2.includes('Passw0rd#2026') && !job.mask,
    imUser2.slice(0, 120));

  // ---------- D. 笔记 AI 总结/续写/翻译 ----------
  const noteId = (await A.post('/notes', {
    title: '脱敏e2e-笔记', content: '甲方是杭州未来科技有限公司，负责人张三，电话 13812345678。',
  })).body.id;
  await A.post('/ai/config', { model: 'stub-chat', base_url: 'http://127.0.0.1:3991/v1', api_key: 'sk-stub-e2e' });
  noteCalls.length = 0;
  r = await A.post(`/notes/${noteId}/ai-assist/preview`, { action: 'summarize' });
  ck('D1 preview 返回对照表 + session_id，且**没调 AI**',
    r.status === 200 && r.body.session_id > 0 && r.body.mapping.some((m) => m.term === '张三')
    && r.body.masked_preview.includes('PER-') && !r.body.masked_preview.includes('张三') && noteCalls.length === 0,
    JSON.stringify({ n: noteCalls.length, body: r.body && r.body.count }));
  const sid = r.body.session_id;
  r = await A.get(`/desensitize/history/${sid}`);
  ck('D2 preview 同步落一条 note_ai 历史（status=preview, ref=笔记 id）',
    r.body.scope === 'note_ai' && r.body.ref === String(noteId) && r.body.status === 'preview');

  r = await A.post(`/notes/${noteId}/ai-assist`, { action: 'summarize', session_id: sid });
  ck('D3 带 session_id 发送成功且标记 masked', r.status === 200 && r.body.ok && r.body.masked === true,
    JSON.stringify(r.body).slice(0, 160));
  const noteUser = (() => { try { return JSON.parse(noteCalls[0].body).messages.slice(-1)[0].content; } catch { return ''; } })();
  ck('D4 桩收到的是已脱敏文本（没有真名）', noteUser.includes('PER-') && !noteUser.includes('张三')
    && !noteUser.includes('杭州未来科技有限公司'), noteUser.slice(0, 160));
  ck('D5 预览与发送用的是同一份脱敏文本（session 里存的那份）',
    noteUser === (await A.get(`/desensitize/history/${sid}`)).body.masked_text);
  ck('D6 结果按对照表复原（AI 只回了代码，页面看到真名）',
    r.body.result.includes('张三') && r.body.result.includes('杭州未来科技有限公司')
    && !codesIn(r.body.result).length, r.body.result);
  r = await A.get(`/desensitize/history/${sid}`);
  ck('D7 发送后历史状态变 sent', r.body.status === 'sent', r.body.status);

  // 不带 session_id：老路径，原文直发
  noteCalls.length = 0;
  r = await A.post(`/notes/${noteId}/ai-assist`, { action: 'summarize' });
  const noteUser2 = (() => { try { return JSON.parse(noteCalls[0].body).messages.slice(-1)[0].content; } catch { return ''; } })();
  ck('D8 不带 session_id = 原行为（原文直发、masked=false）',
    r.body.masked === false && noteUser2.includes('张三') && noteUser2.includes('杭州未来科技有限公司'),
    JSON.stringify({ masked: r.body.masked }));

  // 会话与笔记对不上 → 拒（防串号）
  const other = (await A.post('/notes', { title: '脱敏e2e-别的笔记', content: '无关内容' })).body.id;
  r = await A.post(`/notes/${other}/ai-assist`, { action: 'summarize', session_id: sid });
  ck('D9 session_id 与笔记对不上 → 400 拒收', r.status === 400 && /失效/.test(r.body.error), `${r.status} ${r.body.error}`);

  // ---------- E. 权限 ----------
  ck('E1 pageForPath(/desensitize) 判到 tools 页', pageForPath('/desensitize/history') === 'tools',
    String(pageForPath('/desensitize/history')));
  await fetch(`${B}/api/users`, {
    method: 'POST', headers: admin.H,
    body: JSON.stringify({ username: 'uNoDesens', password: 'uno123456', allowed_pages: ['tools'], allowed_tabs: { tools: [] } }),
  });
  await fetch(`${B}/api/users`, {
    method: 'POST', headers: admin.H,
    body: JSON.stringify({ username: 'uDesens', password: 'uyes123456', allowed_pages: ['tools'], allowed_tabs: { tools: ['desens'] } }),
  });
  let U = await login(B, 'uNoDesens', 'uno123456');
  let UA = api(B, U.H);
  r = await UA.get('/desensitize/meta');
  ck('E2 没有 tools.desens 的用户访问 → 403', r.status === 403, `${r.status} ${JSON.stringify(r.body).slice(0, 80)}`);
  U = await login(B, 'uDesens', 'uyes123456');
  UA = api(B, U.H);
  r = await UA.get('/desensitize/meta');
  ck('E3 有 tools.desens 的用户 → 200', r.status === 200 && !!r.body.config);

  // ---------- F. 总开关关闭 ----------
  await A.put('/desensitize/config', { enabled: false, types: {}, fixed_terms: [] });
  await A.post('/ai/config', { model: 'stub-chat', base_url: 'http://127.0.0.1:3989/v1', api_key: 'sk-stub-e2e' });
  imCalls.length = 0;
  r = await A.post('/life/im-review/jobs', { folder_id: folder, days: 1, desensitize: true });
  job = r.body;
  for (let i = 0; i < 100 && job.state === 'running'; i++) { await sleep(150); job = (await A.get('/life/im-review/jobs/latest')).body; }
  const imUser3 = (() => { try { return JSON.parse(imCalls[0].body).messages.slice(-1)[0].content; } catch { return ''; } })();
  ck('F1 总开关关了：IM 不脱敏（真名照发）但日志如实说明',
    imUser3.includes('杭州未来科技有限公司') && !job.mask
    && (job.logs || []).some((l) => /脱敏已跳过：AI脱敏总开关/.test(l.msg)),
    (job.logs || []).map((l) => l.msg).slice(-2).join(' | '));

  r = await A.post(`/notes/${noteId}/ai-assist/preview`, { action: 'summarize' });
  ck('F2 总开关关了：笔记 preview 回报 disabled，不假装脱敏',
    r.status === 200 && r.body.disabled === true && r.body.mapping.length === 0 && !r.body.session_id, JSON.stringify(r.body));

  await A.put('/desensitize/config', { enabled: true });
  r = await A.post(`/notes/${noteId}/ai-assist/preview`, { action: 'summarize' });
  ck('F3 打开总开关后 preview 恢复脱敏', r.status === 200 && !r.body.disabled && r.body.mapping.length > 0 && r.body.session_id > 0);

  // ---------- G. 历史维护 ----------
  r = await A.get('/desensitize/history');
  const nAll = r.body.items.length;
  r = await A.del(`/desensitize/history/${r.body.items[0].id}`);
  ck('G1 删一条历史', r.body.removed === 1 && (await A.get('/desensitize/history')).body.items.length === nAll - 1);
  r = await A.del('/desensitize/history?scope=manual');
  ck('G2 按来源清空（manual 清掉，别的来源留着）',
    r.body.removed >= 0 && (await A.get('/desensitize/history?scope=manual')).body.items.length === 0
    && (await A.get('/desensitize/history')).body.items.length > 0, JSON.stringify(r.body));
} catch (e) {
  ck('未抛异常（e2e 主流程）', false, (e && e.stack) || '');
} finally {
  try { imStub.close(); noteStub.close(); } catch { /* 已关 */ }
  srv.stop();
}
done();
