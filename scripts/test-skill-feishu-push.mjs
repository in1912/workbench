// 业务系统 Skill → 飞书推送 回归测试。
// 起因（v1.9.37）：runSkill() 里整个飞书推送块嵌在 `if (skill.browser_recipe)` 之内，
//   且失败只 console.warn —— 于是
//     ① 「引导词类 Skill」（没有浏览器配方）点「立即执行」，飞书**一次都没调用**，
//        接口照回 ok、界面照闪「执行完成，去飞书查看」；
//     ② 配方类 Skill 发送失败时异常被吞，界面照样说成功。
//   用户现象正是「工作台显示通了，但飞书没反应」。
// 本测试用假 feishuService（注入 require 缓存）断言：文字 Skill 走 markdown 卡片发出去、
// 表格 Skill 走表格卡片、指定会话只发一个、失败原因必须回传而不是被吞。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-skillpush-'));
process.env.DATA_DIR = tmp;

const db = (await import('../server/db.js')).default;
const d = db.openDatabase(path.join(tmp, 'main.db'));
db.initBusinessSchema(d);

const require = createRequire(import.meta.url);

// ---------- 假 feishuService（必须在 require businessSkillService 之前塞进缓存） ----------
const calls = { markdown: 0, toTarget: 0, tableAll: 0, tableToTarget: 0 };
let failNext = null; // 设成字符串则下一次发送抛该错
const feishuStub = {
  getConfig: () => ({ app_id: 'cli_x', app_secret: 's', targets: [{ receive_id: 'oc_1', receive_id_type: 'chat_id', name: '测试群' }] }),
  sendMarkdown: async (dd, title, md) => { calls.markdown++; lastMd = md; lastTitle = title; if (failNext) throw new Error(failNext); return 1; },
  sendToTarget: async (dd, t, title, md) => { calls.toTarget++; lastMd = md; lastTitle = title; if (failNext) throw new Error(failNext); return true; },
  sendTableAll: async () => { calls.tableAll++; if (failNext) throw new Error(failNext); return 1; },
  sendTableToTarget: async () => { calls.tableToTarget++; if (failNext) throw new Error(failNext); return true; },
};
let lastMd = '', lastTitle = '';
const feishuPath = require.resolve('../server/services/feishuService.js');
require.cache[feishuPath] = {
  id: feishuPath, filename: feishuPath, loaded: true, exports: feishuStub, children: [], paths: [],
};

const skillSvc = require('../server/services/businessSkillService.js');

// ---------- 造数据 ----------
d.prepare("INSERT INTO business_systems(id,name,url,type) VALUES(1,'测试系统','http://x.local','web')").run();
const insertSkill = d.prepare(
  'INSERT INTO business_skills(system_id,name,prompt,request_path,cron,enabled,local_format,browser_recipe) VALUES(?,?,?,?,?,?,?,?)'
);
// 纯文字 Skill：没有浏览器配方，只填了引导词（用户嘴里「贾维斯已上线」那类）
const textSkillId = Number(insertSkill.run(1, '上线通知', '贾维斯已上线，这条消息是测试，收到请回复', '', '', 1, 1, '').lastInsertRowid);
// 浏览器配方 Skill：有 extract.colNames（表格卡片那条路）
const recipeSkillId = Number(insertSkill.run(1, '报表', '', '', '', 1, 1, JSON.stringify({ extract: { colNames: ['姓名', '金额'] } })).lastInsertRowid);

let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  <<< ' + extra}`); };
const getRow = (id) => d.prepare('SELECT * FROM business_skills WHERE id=?').get(id);

console.log('\n【1】纯文字 Skill（没有 browser_recipe）—— 修复前这里一次都不碰飞书');
{
  calls.markdown = 0; calls.toTarget = 0; failNext = null;
  const r = await skillSvc.runSkill(d, getRow(textSkillId));
  ck('走了 markdown 卡片通道（sendMarkdown 被调用）', calls.markdown === 1, `markdown=${calls.markdown}`);
  ck('返回值带 feishu 结果且 sent=1', r.feishu && r.feishu.sent === 1, JSON.stringify(r.feishu));
  ck('推送的就是 Skill 执行结果正文', typeof r.result === 'string' && lastMd === r.result, `md=${String(lastMd).slice(0, 40)}`);
  ck('卡片标题 = [系统名] Skill名', lastTitle === '[测试系统] 上线通知', lastTitle);
  ck('结果仍落库 last_result（老行为不变）', String(getRow(textSkillId).last_result || '').includes('本地整理'));
}

console.log('\n【2】纯文字 Skill 发送失败 —— 修复前异常被 console.warn 吞掉，接口照回成功');
{
  calls.markdown = 0; failNext = '飞书 token 获取失败: invalid app_secret';
  const r = await skillSvc.runSkill(d, getRow(textSkillId));
  ck('sent=0', r.feishu && r.feishu.sent === 0, JSON.stringify(r.feishu));
  ck('失败原因如实回传（不再吞）', /invalid app_secret/.test((r.feishu && r.feishu.error) || ''), JSON.stringify(r.feishu));
  failNext = null;
}

console.log('\n【3】浏览器配方 Skill（有表格）—— 仍走原生表格卡片，行为不变');
{
  calls.tableAll = 0; calls.markdown = 0;
  const r = await skillSvc.pushFeishu(d, { name: '测试系统' }, { name: '报表' }, {
    tableCols: ['姓名', '金额'], tableRows: [['小雨', 100]], result: 'x', target: null,
  });
  ck('走表格卡片通道（sendTableAll 被调用）', calls.tableAll === 1, `tableAll=${calls.tableAll}`);
  ck('未误走 markdown 通道', calls.markdown === 0, `markdown=${calls.markdown}`);
  ck('sent = 配置的会话数', r.sent === 1, JSON.stringify(r));
  const r2 = await skillSvc.pushFeishu(d, { name: '测试系统' }, { name: '报表' }, {
    tableCols: ['姓名'], tableRows: [['小雨']], result: 'x', target: { receive_id: 'oc_9', receive_id_type: 'chat_id' },
  });
  ck('指定会话（群触发/独立推送）只发那一个 → sendTableToTarget', calls.tableToTarget === 1 && r2.sent === 1, JSON.stringify(r2));
}

console.log('\n【4】没配置飞书会话 —— 要明确说出来，而不是静默跳过');
{
  const real = feishuStub.getConfig;
  feishuStub.getConfig = () => ({ app_id: 'cli_x', app_secret: 's', targets: [] });
  calls.markdown = 0;
  const r = await skillSvc.pushFeishu(d, { name: '测试系统' }, { name: '上线通知' }, { tableCols: null, tableRows: null, result: 'x', target: null });
  ck('sent=0 且不调用发送', r.sent === 0 && calls.markdown === 0, JSON.stringify(r));
  ck('给出可操作的原因', /没配置飞书推送会话/.test(r.error || ''), JSON.stringify(r));
  feishuStub.getConfig = real;
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
try { d.close?.(); } catch {}
delete require.cache[feishuPath];
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
process.exit(fail ? 2 : 0);
