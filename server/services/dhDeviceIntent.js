// 数字人对话里的「开关设备」意图识别（v1.13.2）——纯字符串逻辑、零依赖，便于单测。
//
// 为什么需要它（生产实测的根因）：数字人的对话走 aiService.chatEx，而 chatEx 只发
// {model, messages, max_tokens, temperature, stream}——**没有 tools 通道**，人设 system 又是
// 纯角色扮演（buildInstructions 全是说话风格）。于是「帮我打开台灯」只有两种结局：
//   ① 模型老实说「我没有这个能力」（用户实测的第一次回复）；
//   ② 模型顺着人设编一句「已经打开了」（用户实测的第二次回复，实际没动）。
// 智能板之所以能用，是板子侧云端 AI 自带 MCP 工具（self.workbench.control → xiaozhiService.dispatch）。
// 这里不指望模型：服务端先把「开关动词 + 设备名」认出来，直接调同一条 dispatch('control')，
// 回执原文当回复，不经模型转述（转述正是把失败润色成成功的源头）。
//
// 误伤防护（两道）：
//   ① 本文件只认「有开关动词 + 剥完像名字」的短句——长句、带标点、夹着「想/聊/故事」的闲聊一律放行；
//   ② 调用方（dhService.tryDeviceControl）还要求句子里真的出现了某台设备的名字才动手。
// 「我今天打开了新买的书，想跟你聊聊」因此不会被执行成开设备。

const norm = (s) => String(s || '').replace(/\s+/g, '');

// 检测用（含单字「开/关」：「把台灯开了」「开空调」都是口语里最常见的形式）
const ON_WORDS = ['打开', '开启', '点开', '开一下', '开下', '亮起', '点亮', '启动', '开'];
const OFF_WORDS = ['关闭', '关掉', '关上', '关一下', '关下', '熄灭', '停止', '关'];
// 剥词用（**不含单字、也不含「开灯/关灯」**：「开灯」剥掉会把唯一的线索「灯」一起带走，
// 而单字剥掉会毁掉「开合窗帘」这类设备名——单字只在句首句尾兜一层，见下）
const STRIP_VERBS = ['打开', '开启', '点开', '开一下', '开下', '亮起', '点亮', '启动',
  '关闭', '关掉', '关上', '关一下', '关下', '熄灭', '停止'];
// 客气话/人称/语助词：长词在前，剥完剩下的通常就是设备名
const NOISE = ['麻烦你', '麻烦', '帮我给', '帮我', '给我', '请', '我想要', '我要', '我想', '能不能', '能否',
  '可以', '你把', '把', '你', '我', '现在', '马上', '立即', '一下', '一哈', '谢谢',
  '好吗', '行吗', '好不好', '吧', '吗', '呢', '啊', '哦', '了', '的'];
// 否定/疑问句不接管：宁可让模型正常聊天，也不要因为一个字把「我不想开灯」执行成开灯
const NEGATIONS = ['不要', '不想', '不', '别', '先不', '暂时不', '不用', '没', '没让你', '没有让你'];
// 剥完还夹着这些东西 = 在聊天，不是在点设备
const CHATTY = ['想', '觉得', '认为', '聊', '说', '讲', '故事', '感觉', '为什么', '怎么', '是不是'];
const PUNCT = /[，。！？；：、,.!?;:]/;

function firstAt(s, words) {
  let i = -1;
  for (const w of words) {
    const j = s.indexOf(w);
    if (j >= 0 && (i < 0 || j < i)) i = j;
  }
  return i;
}

// 返回 { action: 'on'|'off', query: '设备名候选' }（query 可能为空串——只有动词没带名字时，
// 由调用方结合设备清单决定要不要接管）；不像控制指令则返回 null。
// 句首句尾的标点先剥掉：用户打字常常带句号（「帮我打开客厅书架台灯。」），
// 不剥就会被下面的「带标点=不是指令」误杀（2026-10-10 生产实测踩到）。
// 句**中**的标点仍然照旧拒绝——那是长句/多指令，不是点一台设备。
const EDGE_PUNCT = /^[，。！？；：、,.!?;:~…\s]+|[，。！？；：、,.!?;:~…\s]+$/g;

function parseDeviceCommand(text) {
  const s = norm(text).replace(EDGE_PUNCT, '');
  if (!s || s.length > 60) return null;                       // 长段落是在聊天
  if (NEGATIONS.some((w) => s.includes(w))) return null;
  const iOn = firstAt(s, ON_WORDS);
  const iOff = firstAt(s, OFF_WORDS);
  if (iOn < 0 && iOff < 0) return null;
  const action = iOn >= 0 && (iOff < 0 || iOn <= iOff) ? 'on' : 'off';
  let query = s;
  for (const w of [...STRIP_VERBS, ...NOISE]) query = query.split(w).join('');
  // 句首句尾剩下的单字动词（「开空调」「把台灯开了」）；句中不剥，免得毁掉「开合窗帘」这类名字
  query = query.trim().replace(/^[开关]+/, '').replace(/[开关]+$/, '').trim();
  if (query.length > 12) return null;                          // 剩下的太长 = 不是名字
  if (PUNCT.test(query)) return null;
  if (CHATTY.some((w) => query.includes(w))) return null;
  // 剥完还夹着「开/关/着」= 在问状态（「客厅的灯现在是不是开着的」），不是在下指令
  if (/[开关着]/.test(query)) return null;
  return { action, query };
}

// 句子里点了名的设备（别名接管的设备只认别名，与 resolveDevice 同口径）。
// 只留「名字被命中的最长」那一档：「打开客厅书架台灯」里两台台灯也含「台灯」二字，
// 但只有书架台灯整名被命中——不按长度过滤就会把指名道姓的指令误判成多候选。
function devicesInText(text, devices) {
  const said = norm(text);
  if (!said) return [];
  let best = 0;
  const scored = [];
  for (const d of devices || []) {
    const base = d.alias || d.name;
    const cands = [base, d.room && d.room !== '未分区' ? d.room + base : ''];
    let s = 0;
    for (const c of cands) {
      const n = norm(c);
      if (n && said.includes(n) && n.length > s) s = n.length;
    }
    if (s > 0) { scored.push({ d, s }); if (s > best) best = s; }
  }
  return scored.filter((x) => x.s === best).map((x) => x.d);
}

// 决策（纯函数，便于单测）：返回 { action, target, by }——
//   by='name'  target 是 did（句子里点到的设备唯一）；
//   by='query' target 是设备名候选（交给 resolveDevice 做全等/子串/多候选消歧与话术）；
// 不像控制指令、或只有动词没点名也剥不出名字时返回 null（交回模型正常聊天）。
function planDeviceCommand(text, devices) {
  const cmd = parseDeviceCommand(text);
  if (!cmd) return null;
  const hits = devicesInText(text, devices);
  if (hits.length === 1) return { action: cmd.action, target: String(hits[0].did), by: 'name' };
  if (!cmd.query) return null;
  return { action: cmd.action, target: cmd.query, by: 'query' };
}

module.exports = { parseDeviceCommand, devicesInText, planDeviceCommand, norm };
