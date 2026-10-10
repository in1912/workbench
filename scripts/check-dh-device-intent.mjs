// 数字人设备指令识别单测（v1.13.2）——纯函数，不连库不连服务器：
//   node scripts/check-dh-device-intent.mjs
// 覆盖：识别得到的 action/target、闲聊与疑问句不被劫持、多候选交给 resolveDevice 出话术。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseDeviceCommand, planDeviceCommand } = require('../server/services/dhDeviceIntent.js');

let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '   <<< ' + extra}`); };

// 生产实测的真实设备（2026-10-10 拉取）：两台台灯重名，正是「打开台灯」要消歧的场景
const DEVICES = [
  { did: '1159721152', name: '书架台灯', room: '客厅', alias: null },
  { did: '394124354', name: '台灯', room: '儿童房', alias: null },
  { did: '386001585', name: '台灯', room: '主卧', alias: null },
  { did: '4707021', name: '空调', room: '客厅', alias: null },
  { did: '4707022', name: '吊灯', room: '餐厅', alias: '餐桌灯' },   // 别名接管：本名退出匹配
];

console.log('\n[1] 认得出来的控制指令');
const OK = [
  ['帮我打开台灯', 'on'],
  ['打开客厅书架台灯', 'on'],
  ['把书架台灯关掉', 'off'],
  ['帮我打开台灯好吗', 'on'],
  ['开灯', 'on'],
  ['帮我关灯', 'off'],
  ['把台灯开了', 'on'],
  ['开一下客厅的空调', 'on'],
  ['麻烦把餐厅的餐桌灯打开', 'on'],   // 叫别名
  ['帮我打开客厅书架台灯。', 'on'],    // 句尾带句号（用户打字习惯，2026-10-10 实测踩到的坑）
  ['关掉台灯！', 'off'],              // 句尾感叹号
];
for (const [t, action] of OK) {
  const p = parseDeviceCommand(t);
  ck(`「${t}」→ ${action}`, p && p.action === action, JSON.stringify(p));
}

console.log('\n[2] 闲聊 / 疑问 / 否定句不接管（返回 null）');
const NO = [
  '我今天打开了新买的书，想跟你聊聊',
  '我不想开灯',
  '别关空调',
  '客厅的灯现在是不是开着的',
  '灯开着吗',
  '你昨天说要把台灯打开的吗',
  '今天天气怎么样',
  '聊聊天吧',
];
for (const t of NO) {
  const p = parseDeviceCommand(t);
  ck(`「${t}」→ 不接管`, p === null, JSON.stringify(p));
}

console.log('\n[3] 决策：唯一命中走 did，多候选交给 resolveDevice');
const P = (t) => planDeviceCommand(t, DEVICES);
const p1 = P('打开客厅书架台灯');
ck('「打开客厅书架台灯」→ by=name，落 1159721152', p1 && p1.by === 'name' && p1.target === '1159721152' && p1.action === 'on', JSON.stringify(p1));
const p2 = P('帮我打开台灯');       // 两台同名「台灯」并列最长 → 多候选，交 resolveDevice 出「匹配到多台」
ck('「帮我打开台灯」→ by=query（多候选交 resolveDevice 追问）', p2 && p2.by === 'query' && p2.target === '台灯' && p2.action === 'on', JSON.stringify(p2));
const p3 = P('打开儿童房台灯');     // 点名房间 → 唯一的 394124354
ck('「打开儿童房台灯」→ by=name，落 394124354', p3 && p3.by === 'name' && p3.target === '394124354', JSON.stringify(p3));
const p4 = P('把餐厅的餐桌灯关掉'); // 别名接管
ck('「把餐厅的餐桌灯关掉」→ by=name，落 4707022', p4 && p4.by === 'name' && p4.target === '4707022' && p4.action === 'off', JSON.stringify(p4));
const p5 = P('关掉吊灯');           // 本名已退出匹配 → 只剥出「吊灯」，交给 resolveDevice 回「已登记别名」引导
ck('「关掉吊灯」→ by=query「吊灯」（别名接管后由 resolveDevice 引导）', p5 && p5.by === 'query' && p5.target === '吊灯', JSON.stringify(p5));
const p6 = P('打开电视');           // 没这台设备：剥出名字交给 resolveDevice 回「没有找到」
ck('「打开电视」→ by=query「电视」（让 dispatch 回「没有找到」而不是模型编）', p6 && p6.by === 'query' && p6.target === '电视', JSON.stringify(p6));
const p7 = P('我今天打开了新买的书，想跟你聊聊');
ck('闲聊句 → 决策 null', p7 === null, JSON.stringify(p7));
const p9 = P('帮我打开一下');        // 只有动词没点名：不接管，交回模型正常聊天
ck('「帮我打开一下」→ 决策 null（没点名）', p9 === null, JSON.stringify(p9));
const p8 = planDeviceCommand('打开台灯', []);   // 未绑米家（设备清单拉不到）
ck('设备清单为空也能决策（by=query）', p8 && p8.target === '台灯', JSON.stringify(p8));
const pa = P('帮我打开客厅书架台灯。');   // 句尾句号不该影响命中（用户实测踩到的坑）
ck('句尾「。」不影响命中（by=name 1159721152）', pa && pa.by === 'name' && pa.target === '1159721152' && pa.action === 'on', JSON.stringify(pa));
const pb = P('帮我打开书架台灯，顺便把空调也关了');   // 句中逗号=多指令/长句：不接管，交回模型
ck('句中逗号的多指令不接管', pb === null, JSON.stringify(pb));

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
