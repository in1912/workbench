// AI 数据脱敏（v1.13.0）——把语料里的专有名词（公司名 / 人名 / 部门 / 群名 / 账号 / 密码 /
// API KEY / 邮箱 / 手机号 / 身份证）在**发给 AI 之前**换成本轮随机代码，AI 返回后再按对照表
// 拼回原词。之所以要它：工作台的 AI 走的是「设置 → AI 模型」里那个第三方网关，原文一旦发出去
// 就出了本机；脱敏让专有名词不出门，AI 只看到 ORG-7K2M9 这样的代号。
//
// **三条设计红线**：
//   ① 纯规则、不调用 AI、不联网——「不依赖 AI 能力提取」是需求原话，也让脱敏本身零延迟、可离线。
//   ② **同一名词本轮固定同一代码**（先把整篇扫一遍建表，再统一替换），否则 AI 会看到同一人被叫成
//      两个名字，概要里就对不上了。
//   ③ 替换**按词长降序**（长词先替），否则「张三丰」会被「张三」先吃掉一半。
//
// **能做什么、不能做什么**（界面里也照实说）：账号/密码/API KEY/邮箱/手机号/身份证是正则，准；
// 公司名靠后缀词锚定，也稳；**人名和部门是启发式**——靠姓氏字典 + 称谓词 + 引号 + 调用方给的
// 名字提示（IM 语料的说话人/会话名），**必然有漏网和误伤**，固定关键词表是给这两类打的补丁。
//
// 代码只在本轮有效（同一轮同名同码，跨轮重新随机）；对照历史只落在本机租户库里，不出本机。
const crypto = require('crypto');
const { db } = require('../db');

// ---------- 类型目录（前端渲染勾选项与说明用） ----------
const TYPES = [
  { key: 'org', label: '公司名', hint: '后缀词锚定（有限公司 / 集团 / 银行 / 医院 / 学校 …）' },
  { key: 'person', label: '人名', hint: '姓氏字典 + 称谓词 / 引号 / IM 说话人（启发式，可能漏或误）' },
  { key: 'dept', label: '部门', hint: '事业部 / 分公司 / 部门 / 中心 / 科 / 处 / 组（启发式）' },
  { key: 'group', label: '群名', hint: 'IM 会话名（群）与「…群」写法' },
  { key: 'acct', label: '账号', hint: '账号 / 用户名 / 登录名 / 工号 + 后面的值' },
  { key: 'pwd', label: '密码', hint: '密码 / password / pwd + 后面的值' },
  { key: 'apikey', label: 'API KEY', hint: 'sk-… / Bearer … / 密钥串 / 长随机串' },
  { key: 'email', label: '邮箱', hint: '邮箱地址' },
  { key: 'phone', label: '手机号', hint: '11 位手机号' },
  { key: 'idcard', label: '身份证', hint: '18 位身份证号' },
];
const TYPE_KEYS = TYPES.map((t) => t.key);
const PREFIX = {
  org: 'ORG', person: 'PER', dept: 'DEPT', group: 'GRP', acct: 'ACC', pwd: 'PWD',
  apikey: 'KEY', email: 'MAIL', phone: 'PHONE', idcard: 'ID', custom: 'KW', numbers: 'NUM',
};
// 同一名词命中多种规则时取优先级高的类型（用户固定的词排最前，其次才是正则类）
const PRIORITY = {
  custom: 100, apikey: 90, pwd: 80, acct: 70, email: 60, phone: 60, idcard: 60,
  org: 50, dept: 40, group: 30, person: 20, numbers: 10,
};

const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 去掉 0/1/I/O 这类易混字符
const MAX_ITEMS = 600;        // 单轮对照表条目上限（防止超长语料把表撑爆）
const MAX_PREVIEW = 4000;     // 落历史时脱敏片段的截断长度

// ---------- 基础工具 ----------
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function randCode() {
  const b = crypto.randomBytes(5);
  let s = '';
  for (let i = 0; i < 5; i++) s += ALPHABET[b[i] % ALPHABET.length];
  return s;
}

function makeCode(prefix, used) {
  for (let i = 0; i < 80; i++) {
    const c = `${prefix}-${randCode()}`;
    if (!used.has(c)) { used.add(c); return c; }
  }
  const c = `${prefix}-${Date.now().toString(36).toUpperCase()}`;
  used.add(c);
  return c;
}

// ---------- 抽取词表 ----------
// 汉语公司/机构后缀（长的排前面，先匹配长后缀）
const ORG_SUFFIX = [
  '股份有限公司', '有限责任公司', '有限公司', '集团公司', '集团', '公司',
  '研究院', '研究所', '事务所', '银行', '医院', '大学', '学院', '学校', '科技', '网络', '信息技术',
];
// 部门/组织后缀（含「部 / 组 / 科 / 处」这些短的，靠前缀长度 ≥2 + 停用字过滤兜住误报）
const DEPT_SUFFIX = [
  '事业部', '分公司', '委员会', '办公室', '工作组', '部门', '中心', '科室', '团队', '小组', '部', '组', '科', '处',
];
// 称谓词（人名启发式用；不含「部长 / 局长」这类本身带职级的，避免把「王部长」拆错）
const TITLES = [
  '总经理', '总监', '经理', '老师', '主任', '先生', '女士', '小姐', '同学', '医生', '博士',
  '老板', '组长', '队长', '班主任', '总', '哥', '姐', '叔', '姨', '工', '师',
];
const SURNAMES = '王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤';
const RE_SURNAME = '(?:欧阳|司马|上官|诸葛|东方|皇甫|尉迟|公孙|慕容|长孙|宇文|司徒|司空|令狐|独孤|南宫|西门|夏侯|东方|赫连)';
// 「前缀是占位/泛指词」时不算公司/部门（否则「很多部门」「这家公司」会被误伤）
const GENERIC_START = '这那该本个次你我他她它们和与或在有对把被给从到说问写全各每某两几多所任其此很太更就才还又而但却并因由至用做着过得地呢吗吧啊呀';

function looksGeneric(prefix) {
  const p = String(prefix || '');
  if (!p) return true;
  if (GENERIC_START.includes(p[0])) return true;
  return /^[的了是在和与或]/.test(p);
}

// 公司名 / 部门的锚定抽取（见 anchorTerms）。名字左边常挂着虚词（「这是」「和」「很多」），
// 先把这些从左侧削掉，剩下的才算名字主体。
// 名字左边碰到这些字就不再往左取（它们是虚词，不是名字的一部分）；
// 「一」故意不在此列（一汽集团 / 一中老师），改由下面的量词短语单独处理。
// 「为」故意不列在里面（华为 / 大为 会被削掉半截），它靠下面的虚词短语兜。
const LEFT_TRIM_SET = new Set('这那该本个次你我他她它们和与或在有对把被给从到跟同向找说问写全各每某两些所其此的了是也都很太就才还又而但却并且因由至用做着过得地呢吗吧啊呀'.split(''));
// 落到名字左侧的整段虚词（量词短语 / 常见功能词），一次性削掉
const LEFT_PREFIX_RE = /^(?:一(?:家|位|些|种|个|条|款|所|名)|作为|为了|就是|不是|还是|也是|都是|所有|整个|这些|那些|很多|非常|比较|特别|其实|然后|因此|所以|如果|因为|虽然|但是|而且|并且|另外|其中|目前|现在|以后|今天|明天|昨天|今年|去年|我们|你们|他们|咱们|大家)/;
// 单字后缀（部 / 组 / 科 / 处）只有在后面不接成常用词时才算部门名——
// 否则「星辰网络科技」会被拆出一个「…科」，「处理意见」会拆出「…处」。
const DEPT_SINGLE_STOP = new Set(['科技', '科学', '科目', '组织', '组成', '组件', '处理', '处罚', '处分', '部分', '部署', '部件', '部队', '部落', '部长', '部委', '组长']);
// 注：故意不含「大 / 新 / 中 / 华」这类能当名字开头的字（大华科技 / 新华书店 不能被削成「华科技」）
// 以泛称词收尾的名字（「科技公司」「购物中心」「大数据公司」）不算专有名词——
// 但只在去掉泛称后剩不下名字主体时才排除，「星辰科技」「华润集团」这类照留。
const ORG_GENERIC = ['科技', '网络', '信息', '信息技术', '数据', '智能', '人工', '互联网', '软件', '服务', '文化', '教育', '咨询', '管理', '投资', '发展', '实业', '商贸', '贸易', '传媒', '电子', '通信', '生物', '医疗', '健康', '能源', '环保', '金融', '地产', '建筑', '物流', '制造', '工程', '设计', '技术', '系统', '平台', '业务', '行业', '产业', '企业', '市场', '客户', '用户', '项目', '产品', '团队', '部门', '公司', '集团', '中心', '有限', '股份', '责任', '高新', '中小', '著名', '知名', '大型'];
const DEPT_GENERIC = ['购物', '服务', '数据', '信息', '文化', '体育', '娱乐', '交易', '物流', '配送', '会议', '展览', '全部', '部分', '大部', '整个', '所有', '各个', '部门', '中心', '团队', '小组', '组织', '集体', '机关', '机构'];

/**
 * 扫描文本，产出 [{term, type}]（已按类型优先级去重）。
 * @param {string} text
 * @param {{types?:Object, mask_numbers?:boolean, fixed_terms?:Array, nameHints?:Array}} opts
 */
function extract(text, opts = {}) {
  const t = String(text || '');
  const on = (k) => (opts.types ? opts.types[k] !== false : true); // 缺省视为开启
  const found = new Map();   // term → type
  const add = (term, type) => {
    let s = String(term || '').trim();
    s = s.replace(/^[\s:：=，,。.、；;'"“”「」《》（）()【】\[\]]+/, '').replace(/[\s:：=，,。.、；;'"“”「」《》（）()【】\[\]]+$/, '');
    if (!s || s.length < 2 || s.length > 60) return;      // 单字不脱敏：全局替换一个字会误伤满篇
    if (found.size >= MAX_ITEMS && !found.has(s)) return;
    const old = found.get(s);
    if (!old || (PRIORITY[type] || 0) > (PRIORITY[old] || 0)) found.set(s, type);
  };

  // 公司名 / 部门的锚定抽取。为什么不写成一条纯正则：中文里名字后面几乎总跟着
  // 「的 / 在 / 就」这类汉字，而纯后缀 + 词边界（后一字符不能是汉字）的写法会让
  // 「杭州未来科技有限公司的合同」整条命中不了；放开词边界又会被「很多科技公司」「这部分」
  // 这类泛称误伤。所以分两步：先定位后缀词，再向左扫出名字主体，最后用虚词表 + 泛称表两头夹。
  function anchorTerms(text, suffixes, type, opt) {
    const { minZh = 2, maxLeft = 20, generic = [] } = opt || {};
    const re = new RegExp(`(?:${suffixes.join('|')})`, 'g');
    const hits = [];
    for (const m of text.matchAll(re)) {
      const end = m.index + m[0].length;
      if (/[A-Za-z0-9]/.test(text[end] || '')) continue;   // 名字后紧跟字母数字 = 还在同一个词里
      if (m[0].length === 1 && DEPT_SINGLE_STOP.has(text.slice(m.index, m.index + 2))) continue;
      // 从后缀往左取名字主体，遇到虚词 / 标点 / 空白就停
      let k = m.index;
      let w = '';
      while (k > 0 && w.length < maxLeft) {
        const c = text[k - 1];
        if (!/[一-龥A-Za-z0-9()（）·]/.test(c) || LEFT_TRIM_SET.has(c)) break;
        k--; w = c + w;
      }
      w = w.replace(LEFT_PREFIX_RE, '');   // 「一家科技公司」「作为科技公司」这类前缀
      const i = m.index - w.length;        // 词在整个文本里的起点（要按裁完的 w 回推）
      if ((w.match(/[一-龥]/g) || []).length < minZh) continue;
      if (looksGeneric(w[0])) continue;
      const g = generic.find((x) => w.endsWith(x));
      if (g && (w.slice(0, w.length - g.length).match(/[一-龥]/g) || []).length < 2) continue;
      hits.push({ i, e: end, term: text.slice(i, end) });
    }
    // 「星辰科技」被「星辰科技有限公司」包住时只留长的（替换本身也按长度降序，这里先去重）
    for (const h of hits) {
      if (hits.some((o) => o !== h && o.i <= h.i && o.e >= h.e && (o.e - o.i) > (h.e - h.i))) continue;
      add(h.term, type);
    }
  }

  // ① 固定关键词表（用户指定，无条件替换，支持「词=自定义代码」）
  const fixed = Array.isArray(opts.fixed_terms) ? opts.fixed_terms : [];
  const fixedCodes = new Map();
  for (const it of fixed) {
    const term = String((it && it.term) || it || '').trim();
    if (!term) continue;
    add(term, 'custom');
    const code = String((it && it.code) || '').trim();
    if (code) fixedCodes.set(term, code);
  }

  // ② API KEY / 密钥 / 长随机串
  if (on('apikey')) {
    for (const m of t.matchAll(/\bsk-[A-Za-z0-9_-]{12,}\b/g)) add(m[0], 'apikey');
    for (const m of t.matchAll(/\b(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|secret|token|private[_-]?key)\s*[:=：]\s*["'`]?([A-Za-z0-9_\-./+=]{8,})/gi)) add(m[1], 'apikey');
    for (const m of t.matchAll(/\bBearer\s+([A-Za-z0-9_\-.]{12,})/gi)) add(m[1], 'apikey');
    // 长随机串：≥30 位、字母数字混排（纯英文长词、纯数字日期不会命中）
    for (const m of t.matchAll(/\b(?=[A-Za-z0-9_-]{30,}\b)(?=[^\s]*[A-Za-z])(?=[^\s]*\d)[A-Za-z0-9_-]{30,}\b/g)) add(m[0], 'apikey');
  }

  // ③ 密码 / ④ 账号：值一律以「空白或标点」收尾。用 \S 会把后面半句话一起吞掉
  // （实测「密码是 Passw0rd#2026，账号 zhang3」整条被当成密码，账号那个值反而没抽到）。
  const VALUE = '[^\\s,;，；、。．：:！!？?（）()\\[\\]【】「」《》""\'""\'<>]';
  if (on('pwd')) {
    for (const m of t.matchAll(new RegExp(`(?:密码|口令|password|passwd|pwd)\\s*(?:是|为|[:=：])\\s*(${VALUE}{3,64})`, 'gi'))) add(m[1], 'pwd');
  }

  // ④ 账号 / 用户名 / 工号
  if (on('acct')) {
    for (const m of t.matchAll(new RegExp(`(?:账号|帐号|用户名|账户名|登录名|工号|account|username|user\\s*name|userid|user\\s*id)\\s*(?:是|为|[:=：])\\s*(${VALUE}{2,64})`, 'gi'))) add(m[1], 'acct');
  }

  // ⑤ 邮箱 / 手机号 / 身份证
  if (on('email')) for (const m of t.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) add(m[0], 'email');
  if (on('phone')) for (const m of t.matchAll(/(?<!\d)1[3-9]\d{9}(?!\d)/g)) add(m[0], 'phone');
  if (on('idcard')) for (const m of t.matchAll(/(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/g)) add(m[0], 'idcard');

  // ⑥ 公司名 / ⑦ 部门：后缀词锚定后向左取名字主体（anchorTerms，见文件上方说明）
  if (on('org')) anchorTerms(t, ORG_SUFFIX, 'org', { generic: ORG_GENERIC });
  if (on('dept')) anchorTerms(t, DEPT_SUFFIX, 'dept', { generic: DEPT_GENERIC });

  // ⑧ 群名：「…群 / …群聊」写法
  if (on('group')) {
    for (const m of t.matchAll(/([一-龥A-Za-z0-9]{2,18}群(?:聊)?)/g)) {
      const w = m[1];
      if (/群众|群体|人群|群组|微信群|qq群|QQ群|钉钉群|群消息|群聊|群主|群公告/.test(w) && w.length <= 4) continue;
      add(w, 'group');
    }
  }

  // ⑨ 人名（启发式，任一条件满足才算）：
  //    a) 姓氏 + 0~2 汉字 + 称谓词（「张三经理」「张总」「王老师」）——名字为空时连称谓一起当词，避免只脱一个姓
  //    b) 姓氏 + 1~2 汉字，且落在引号内
  //    c) 命中调用方给的名字提示表（IM 语料的说话人 / 会话名）
  if (on('person')) {
    const quotes = [];
    for (const m of t.matchAll(/[「“"《【]\s*([^」”"》】]{1,24}?)\s*[」”"》】]/g)) quotes.push({ s: m.index, e: m.index + m[0].length, text: m[1].trim() });
    const inQuote = (idx, s) => quotes.some((q) => idx >= q.s && idx + s.length <= q.e);

    const re = new RegExp(`(${RE_SURNAME}|[${SURNAMES}])([\\u4e00-\\u9fa5]{0,2}?)(${TITLES.join('|')})`, 'g');
    for (const m of t.matchAll(re)) add(m[2] ? m[1] + m[2] : m[0], 'person');

    const re2 = new RegExp(`(${RE_SURNAME}|[${SURNAMES}])([\\u4e00-\\u9fa5]{1,2})`, 'g');
    for (const m of t.matchAll(re2)) {
      const term = m[1] + m[2];
      if (inQuote(m.index, term)) add(term, 'person');
    }

    // d) 职务/角色词在前 + 姓氏 + 1~2 汉字（「负责人张三」「对接人李四」）——中文行文里
    //    最常见的人名写法，光靠后缀称谓挂不住。末尾撞上称谓词的丢掉（「负责人王先生」
    //    不算人名，那该由 a) 按「王先生」处理）。
    const re3 = new RegExp(`(?:负责人|联系人|对接人|经办人|申请人|审批人|代理人|委托人|主管|专员|顾问|助理|秘书|经理|总监|主任|老板|老师|医生|律师|会计|出纳|司机|销售|客服|设计师|工程师|技术员)(${RE_SURNAME}|[${SURNAMES}])([\\u4e00-\\u9fa5]{1,2})`, 'g');
    for (const m of t.matchAll(re3)) {
      const term = m[1] + m[2];
      if (TITLES.some((x) => term.endsWith(x))) continue;
      add(term, 'person');
    }

    for (const hint of (Array.isArray(opts.nameHints) ? opts.nameHints : [])) {
      const h = String(hint || '').trim();
      if (h.length < 2 || h.length > 30) continue;
      add(h, /群|团队|委员会|项目组/.test(h) ? 'group' : 'person');
    }
  }

  // ⑩ 数值（默认关；开了之后 AI 就没法对数字做加减比较——界面上必须警示）
  if (opts.mask_numbers) {
    for (const m of t.matchAll(/(?<![\d.])\d[\d,，]*(?:\.\d+)?(?![\d])/g)) {
      const v = m[0];
      const digits = v.replace(/\D/g, '');
      if (digits.length < 3) continue;
      if (/^(19|20)\d{2}$/.test(digits)) continue;   // 年份不脱（否则日期全乱）
      add(v, 'numbers');
    }
  }

  const out = [];
  for (const [term, type] of found) out.push({ term, type, code: fixedCodes.get(term) || '' });
  return out;
}

/**
 * 多段文本共用**同一张**对照表（v1.13.1：LLM 对话一轮里所有消息必须同名同码）。
 * 一轮请求里「张三」若被换成 ORG-7K2M9 和 PER-3QW8Z 两个代码，AI 读不懂上下文，
 * 用户也说不清对照关系；所以抽取在拼接后的全文上做一次，替换再逐段进行。
 * 拼接用 \n：所有抽取器的字符类都遇空白即停，跨行不会串词。
 * @param {string[]} texts
 * @returns {{masked:string[], mapping:Array<{term,code,type}>, count:number}}
 */
function encodeMany(texts, opts = {}) {
  const arr = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t == null ? '' : t));
  if (!arr.length) return { masked: [], mapping: [], count: 0 };
  const items = extract(arr.join('\n'), opts);
  if (!items.length) return { masked: arr, mapping: [], count: 0 };
  items.sort((a, b) => b.term.length - a.term.length);   // 长词先替，防子串互吃
  const used = new Set();
  const mapping = [];
  const byTerm = new Map();
  for (const it of items) {
    const code = it.code && !used.has(it.code) ? it.code : makeCode(PREFIX[it.type] || 'TERM', used);
    used.add(code);
    byTerm.set(it.term, code);
    mapping.push({ term: it.term, code, type: it.type });
  }
  const re = new RegExp(mapping.map((m) => esc(m.term)).join('|'), 'g');
  const masked = arr.map((t) => t.replace(re, (m) => byTerm.get(m) || m));
  return { masked, mapping, count: mapping.length };
}

/**
 * 脱敏：抽取专有名词 → 生成本轮随机代码 → 按词长降序替换。
 * @returns {{masked:string, mapping:Array<{term,code,type}>, count:number}}
 */
function encode(text, opts = {}) {
  const r = encodeMany([String(text || '')], opts);
  return { masked: r.masked[0], mapping: r.mapping, count: r.count };
}

/** 复原：按对照表把代码拼回原词（code 唯一，直接替换即可）。 */
function decode(text, mapping) {
  const t = String(text == null ? '' : text);
  const list = Array.isArray(mapping) ? mapping.filter((m) => m && m.code && m.term) : [];
  if (!list.length) return t;
  const byCode = new Map(list.map((m) => [m.code, m.term]));
  const re = new RegExp(list.map((m) => esc(m.code)).join('|'), 'g');
  return t.replace(re, (m) => byCode.get(m) || m);
}

/** 对任意对象/数组做深度 decode（AI 回的 JSON 结构里代码可能出现在任何字符串上）。 */
function decodeDeep(value, mapping) {
  if (typeof value === 'string') return decode(value, mapping);
  if (Array.isArray(value)) return value.map((v) => decodeDeep(v, mapping));
  if (value && typeof value === 'object') {
    const o = {};
    for (const k of Object.keys(value)) o[k] = decodeDeep(value[k], mapping);
    return o;
  }
  return value;
}

// ---------- 配置（租户库单行表 id=1） ----------
const DEF_CONFIG = { enabled: true, mask_numbers: false, types: {}, fixed_terms: [], aggressive: 'balanced' };
const cdb = (tdb) => tdb || db;

function getConfig(tdb) {
  const row = cdb(tdb).prepare('SELECT * FROM desensitize_config WHERE id=1').get();
  if (!row) return { ...DEF_CONFIG };
  let types = {}, fixed = [];
  try { types = JSON.parse(row.types_json || '{}') || {}; } catch { /* 坏 JSON 当空 */ }
  try { fixed = JSON.parse(row.fixed_terms_json || '[]') || []; } catch { /* 同上 */ }
  return {
    enabled: !!row.enabled,
    mask_numbers: !!row.mask_numbers,
    types,
    fixed_terms: Array.isArray(fixed) ? fixed : [],
    aggressive: row.aggressive || 'balanced',
  };
}

function saveConfig(tdb, patch = {}) {
  const d = cdb(tdb);
  const cur = getConfig(d);
  const next = {
    enabled: patch.enabled === undefined ? cur.enabled : !!patch.enabled,
    mask_numbers: patch.mask_numbers === undefined ? cur.mask_numbers : !!patch.mask_numbers,
    types: patch.types === undefined ? cur.types : (patch.types && typeof patch.types === 'object' ? patch.types : {}),
    fixed_terms: patch.fixed_terms === undefined ? cur.fixed_terms : normalizeFixed(patch.fixed_terms),
    aggressive: patch.aggressive === undefined ? cur.aggressive : String(patch.aggressive || 'balanced'),
  };
  d.prepare(`INSERT INTO desensitize_config (id, enabled, mask_numbers, types_json, fixed_terms_json, aggressive, updated_at)
             VALUES (1, ?, ?, ?, ?, ?, datetime('now','localtime'))
             ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled, mask_numbers=excluded.mask_numbers,
               types_json=excluded.types_json, fixed_terms_json=excluded.fixed_terms_json,
               aggressive=excluded.aggressive, updated_at=excluded.updated_at`)
    .run(next.enabled ? 1 : 0, next.mask_numbers ? 1 : 0, JSON.stringify(next.types), JSON.stringify(next.fixed_terms), next.aggressive);
  return getConfig(d);
}

/** 固定关键词表归一：接受 ['词', {term,code}, '词=代码'] 三种写法。 */
function normalizeFixed(list) {
  const out = [];
  for (const it of (Array.isArray(list) ? list : [])) {
    if (it && typeof it === 'object') {
      const term = String(it.term || '').trim();
      if (term) out.push({ term, code: String(it.code || '').trim() });
      continue;
    }
    const s = String(it || '').trim();
    if (!s) continue;
    const i = s.indexOf('=');
    if (i > 0) out.push({ term: s.slice(0, i).trim(), code: s.slice(i + 1).trim() });
    else out.push({ term: s, code: '' });
  }
  return out.slice(0, 500);
}

/** 合并「已保存配置」与「本次覆盖」得到 encode 入参（IM复盘 / 笔记AI 都走它）。 */
function optionsFrom(tdb, override = {}) {
  const cfg = getConfig(tdb);
  return {
    enabled: cfg.enabled !== false,     // 总开关：调用方在脱敏之前先看这一项
    types: override.types || cfg.types,
    mask_numbers: override.mask_numbers === undefined ? cfg.mask_numbers : !!override.mask_numbers,
    fixed_terms: cfg.fixed_terms,
    nameHints: override.nameHints || [],
  };
}

// ---------- 脱敏历史（租户库表） ----------
function record(tdb, { scope, ref = '', userId = null, mapping = [], maskedPreview = '', maskedText = '', status = 'done' }) {
  const info = cdb(tdb).prepare(`INSERT INTO desensitize_history (scope, ref, user_id, item_count, mapping_json, masked_text, masked_preview, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now','localtime'))`)
    .run(String(scope || 'manual'), String(ref || ''), userId == null ? null : Number(userId),
      mapping.length, JSON.stringify(mapping), String(maskedText || ''),
      String(maskedPreview || '').slice(0, MAX_PREVIEW), String(status || 'done'));
  return Number(info.lastInsertRowid);
}

function historyRow(r, { full = false } = {}) {
  let mapping = [];
  try { mapping = JSON.parse(r.mapping_json || '[]') || []; } catch { /* 坏 JSON 当空 */ }
  return {
    id: Number(r.id), scope: r.scope, ref: r.ref, user_id: r.user_id == null ? null : Number(r.user_id),
    item_count: Number(r.item_count) || 0, status: r.status, created_at: r.created_at,
    masked_preview: r.masked_preview || '', mapping,
    ...(full ? { masked_text: r.masked_text || '' } : {}),
  };
}

function listHistory(tdb, { limit = 50, scope = '' } = {}) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const rows = scope
    ? cdb(tdb).prepare('SELECT * FROM desensitize_history WHERE scope=? ORDER BY id DESC LIMIT ?').all(String(scope), lim)
    : cdb(tdb).prepare('SELECT * FROM desensitize_history ORDER BY id DESC LIMIT ?').all(lim);
  return rows.map((r) => historyRow(r));
}

function getHistory(tdb, id) {
  const r = cdb(tdb).prepare('SELECT * FROM desensitize_history WHERE id=?').get(Number(id) || -1);
  return r ? historyRow(r, { full: true }) : null;
}

function setHistoryStatus(tdb, id, status) {
  cdb(tdb).prepare('UPDATE desensitize_history SET status=? WHERE id=?').run(String(status), Number(id) || -1);
}

function deleteHistory(tdb, id) {
  return cdb(tdb).prepare('DELETE FROM desensitize_history WHERE id=?').run(Number(id) || -1).changes;
}

function clearHistory(tdb, scope = '') {
  return scope
    ? cdb(tdb).prepare('DELETE FROM desensitize_history WHERE scope=?').run(String(scope)).changes
    : cdb(tdb).prepare('DELETE FROM desensitize_history').run().changes;
}

module.exports = {
  TYPES, TYPE_KEYS, PREFIX,
  extract, encode, encodeMany, decode, decodeDeep,
  getConfig, saveConfig, optionsFrom, normalizeFixed,
  record, listHistory, getHistory, setHistoryStatus, deleteHistory, clearHistory,
};
