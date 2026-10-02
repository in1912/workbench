// 单测：智能板语音接入的纯逻辑部分（v1.9.31）
// 覆盖：抽取后的 searchService 形状、整句剥离、接入点桥接的 MCP 帧响应、工具表随配置变化。
// 不起 HTTP 服务、不连网——直接 import 服务端模块，用隔离 DATA_DIR 建一个真 schema 的租户库。
//
//   node scripts/test-xiaozhi-guards.mjs
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// 必须在 import 任何 server 模块之前设好，db.js 会在加载时建库
const DATA = mkdtempSync(path.join(tmpdir(), 'wb-xzguard-'));
process.env.DATA_DIR = DATA;

let passed = 0, failed = 0;
const ok = (cond, name, extra) => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`); }
};

try {
  const { getTenantDb } = await import('../server/db.js');
  const searchService = await import('../server/services/searchService.js');
  const tools = await import('../server/services/xiaozhiTools.js');
  const svc = await import('../server/services/xiaozhiService.js');
  const bridge = await import('../server/services/xiaozhiMcpBridge.js');

  console.log('— searchService（从 core.js 抽出，行为必须与原实现一致）');
  const tdb = getTenantDb(1);
  tdb.prepare("INSERT INTO notes(title,content,category) VALUES(?,?,?)").run('装修清单', '客厅地板两万，橱柜一万五', 'general');
  tdb.prepare("INSERT INTO todos(title,desc,due_date) VALUES(?,?,?)").run('装修验收', '下周去看工地', '2026-10-10');
  const r1 = searchService.search(tdb, '装修');
  ok(r1.results.length === 2, `跨表命中 2 条（${r1.results.length}）`);
  ok(r1.results.every((r) => 'type' in r && 'id' in r && 'title' in r && 'content' in r && 'time' in r), '返回字段形状不变（type/id/title/content/time/to）');
  ok(r1.results.some((r) => r.type === '笔记') && r1.results.some((r) => r.type === '待办'), '笔记与待办都进来了');
  ok(searchService.search(tdb, '').results.length === 0, '空查询回空数组');
  ok(searchService.search(tdb, 'zzz不存在').results.length === 0, '无命中回空数组');
  ok(searchService.search(tdb, '装修', { limit: 1 }).results.length === 1, 'limit 能截断整体返回');
  ok(tdb.prepare('SELECT COUNT(*) c FROM notes').get().c === 1, '检索不写库（纯读，笔记仍只有插入的那 1 条）');

  console.log('— 整句剥离与检索兜底（e2e 实测踩过：剥完剩「装修 内容」整串去 LIKE 会一个字都搜不到）');
  const strip = svc.stripQuestion;
  ok(!strip('我的笔记里关于装修的内容是什么').includes('我的'), '剥掉「我的」', strip('我的笔记里关于装修的内容是什么'));
  ok(strip('我的笔记里关于装修的内容是什么').includes('装修'), '关键词「装修」被保留');
  ok(strip('帮我查一下张三') === '张三', `「帮我查一下张三」→ 张三（实际「${strip('帮我查一下张三')}」）`);
  const fb = svc.searchWithFallback(tdb, '我的笔记里关于装修的内容是什么');
  ok(fb.results.length >= 1, `整句能搜到（落到候选串「${fb.used}」）`, JSON.stringify(fb.results.slice(0, 1)));
  ok(fb.results.some((r) => r.title === '装修清单'), '命中的确实是那条装修笔记');
  ok(svc.searchCandidates('装修').length === 1, '本来就像关键词的输入不额外造候选');
  ok(svc.searchCandidates('我的装修').includes('装修'), '候选里包含剥离后的单词');
  ok(svc.searchCandidates('').length === 0, '空串不产生候选');

  console.log('— 点名判定');
  const ag = { name: '贾维斯', aliases: ['老贾'] };
  ok(tools.addressed('贾维斯帮我看下磁盘', ag), '全名命中');
  ok(tools.addressed('老贾，看看内存', ag), '别名命中');
  ok(tools.addressed('贾 维 斯 在吗', ag), '忽略空格命中');
  ok(!tools.addressed('帮我看看笔记', ag), '没点名不误判');
  ok(!tools.addressed('', ag), '空串不误判');

  console.log('— 工具表（接入点 tools/list 的来源）');
  const enabled = tools.buildTools({ agent: { ...ag, enabled: true } });
  const names = enabled.map((t) => t.name);
  ok(names.length === 2 && names.includes('self.workbench.ask') && names.includes('self.workbench.delegate'), '启用时给出 ask + delegate', names.join(','));
  const desc = enabled.find((t) => t.name === 'self.workbench.delegate').description;
  ok(desc.includes('贾维斯') && desc.includes('老贾'), 'delegate 描述带真名与别名（改名即生效，通道 A 的关键优势）');
  ok(!enabled.find((t) => t.name === 'self.workbench.ask').description.includes('贾维斯'), 'ask 描述里不掺 agent 名字');
  ok(tools.buildTools({ agent: { ...ag, enabled: false } }).length === 1, '停用时摘掉 delegate（不留必然被拒的入口）');
  ok(tools.buildTools({ agent: { enabled: true } }).length === 2, '没填名字时回落「贾维斯」且不崩');

  console.log('— Hermes 接口地址归一（v1.9.32：少一段 /v1 会让「测试连通性」永远 404）');
  {
    const hermes = await import('../server/services/hermesService.js');
    const ce = hermes.chatEndpoint;
    // 面板里让大家填的就是「IP:端口」，这一段必须由我们补——实测 POST /chat/completions → 404
    ok(ce('http://192.168.110.105:8642') === 'http://192.168.110.105:8642/v1/chat/completions', '只填 IP:端口 → 自动补 /v1/chat/completions', ce('http://192.168.110.105:8642'));
    ok(ce('http://192.168.110.105:8642/') === 'http://192.168.110.105:8642/v1/chat/completions', '尾斜杠容忍', ce('http://192.168.110.105:8642/'));
    ok(ce('http://h:8642/v1') === 'http://h:8642/v1/chat/completions', '已带 /v1 不重复补', ce('http://h:8642/v1'));
    ok(ce('http://h:8642/v1/chat/completions') === 'http://h:8642/v1/chat/completions', '整条接口地址粘进来也不双重后缀', ce('http://h:8642/v1/chat/completions'));
    ok(ce('https://api.deepseek.com') === 'https://api.deepseek.com/v1/chat/completions', 'https 无路径同理', ce('https://api.deepseek.com'));
    ok(ce('http://h:8642/hermes/v1') === 'http://h:8642/hermes/v1/chat/completions', '自定义前缀路径照原样拼（不猜）', ce('http://h:8642/hermes/v1'));
  }

  console.log('— 接入点 MCP 帧响应');
  const init = await bridge._respond({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  ok(init.result && init.result.protocolVersion === '2024-11-05' && init.result.capabilities.tools, 'initialize 回协议版本与 tools 能力');
  ok((await bridge._respond({ jsonrpc: '2.0', method: 'notifications/initialized' })) === null, '通知帧不回应');
  const ping = await bridge._respond({ jsonrpc: '2.0', id: 2, method: 'ping' });
  ok(ping.result && ping.id === 2, 'ping 有空结果');
  const unk = await bridge._respond({ jsonrpc: '2.0', id: 3, method: 'no/such' });
  ok(unk.error && unk.error.code === -32601, '未知方法回 -32601');
  const reply0 = await bridge._respond({ jsonrpc: '2.0', id: 9, result: {} });
  ok(reply0 === null, '响应帧（无 method）被忽略');

  console.log('— 配置：密钥不外泄 + 默认值');
  svc.setAgentKey('sk-secret-should-never-leak');
  const pub = svc.getPublicConfig();
  ok(pub.agent.has_key === true, 'has_key 布尔为真');
  ok(!JSON.stringify(pub).includes('sk-secret-should-never-leak'), 'getPublicConfig 不含密钥明文');
  ok(!JSON.stringify(pub).includes('v1:'), '也不含密文串（加密存储不外泄）');
  svc.clearAgentKey();
  ok(svc.getPublicConfig().agent.has_key === false, '清除后 has_key 转假');
  const d = svc.getConfig().agent;
  ok(!d.enabled, 'agent 默认关闭（不做任何事就等于不存在）');
  ok(d.base_url && d.model, `agent 地址/模型有默认值可直接用（${d.base_url} / ${d.model}）`);
  ok(svc.getConfig().mcp.enabled === false, '官方接入点默认关闭');

  console.log('— uid 必须真实存在（getTenantDb 对任意数字都会建空库，光看数字会漏）');
  svc.saveConfig({ query: { uid: 99999 } });
  ok(svc.configuredQueryUser() === null, '不存在的 uid 视为未配置');
  svc.saveConfig({ query: { uid: null } });
  ok(svc.configuredQueryUser() === null, 'null 视为未配置');
} catch (e) {
  failed++;
  console.error('未捕获异常:', e);
} finally {
  try { rmSync(DATA, { recursive: true, force: true }); } catch { /* 尽力 */ }
  console.log(`\n通过 ${passed} / 失败 ${failed}`);
  process.exit(failed ? 1 : 0);
}
