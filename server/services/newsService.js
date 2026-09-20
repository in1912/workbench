const Parser = require('rss-parser');
const { getSetting, setSetting } = require('../db');

// 抓取用浏览器 UA（skill chinese-content-extraction：许多站点无 UA 直接返回空页/错误页）
const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const parser = new Parser({
  timeout: 15000,
  headers: { 'User-Agent': UA_CHROME, 'Accept-Language': 'zh-CN,zh;q=0.9' },
});

// 同域名连续请求间隔 ≥1.2s（skill 建议 1-2s 礼貌抓取，避免触发限流；
// 默认源里 chinanews 一个域要连抓 5 个 feed）
const lastHitByHost = new Map();
async function politeGate(url) {
  try {
    const host = new URL(url).hostname;
    const wait = (lastHitByHost.get(host) || 0) + 1200 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastHitByHost.set(host, Date.now());
  } catch { /* URL 解析失败不打断抓取 */ }
}

// 默认新闻源：类别 → [{name, url}]（均为实测可用的中文 RSS，2026-08 核验新鲜）
// 失效源可在「设置 → 新闻源」中替换
const DEFAULT_SOURCES = {
  tech: [
    { name: 'IT 之家', url: 'https://www.ithome.com/rss/' },
    { name: '少数派', url: 'https://sspai.com/feed' },
    { name: 'InfoQ 中文', url: 'https://www.infoq.cn/feed' },
    { name: 'Solidot', url: 'https://www.solidot.org/index.rss' },
  ],
  life: [
    { name: '中国新闻网', url: 'https://www.chinanews.com.cn/rss/scroll-news.xml' },
    { name: '中新·社会', url: 'https://www.chinanews.com.cn/rss/society.xml' },
    { name: '中新·财经', url: 'https://www.chinanews.com.cn/rss/finance.xml' },
    { name: '中新·体育', url: 'https://www.chinanews.com.cn/rss/sports.xml' },
    { name: '中新·国际', url: 'https://www.chinanews.com.cn/rss/world.xml' },
  ],
  // 本地新闻暂无通用按城市 RSS（百度/Bing/浙江在线均已停 RSS 或 404），
  // 默认用全国综合源 + 城市/省份关键词过滤；如有本地 RSS 可在「设置 → 新闻源」替换
  local: [
    { name: '本地动态（全国综合）', url: 'https://www.chinanews.com.cn/rss/scroll-news.xml' },
    { name: '中新·社会', url: 'https://www.chinanews.com.cn/rss/society.xml' },
    { name: '中新·财经', url: 'https://www.chinanews.com.cn/rss/finance.xml' },
    { name: '中新·国际', url: 'https://www.chinanews.com.cn/rss/world.xml' },
  ],
};

// 城市所在省份映射：本地新闻过滤时"城市 OR 省份"命中即保留（仅按城市太严，常匹配为空）
const PROVINCE_OF = {
  宁波: '浙江', 杭州: '浙江', 温州: '浙江', 绍兴: '浙江', 嘉兴: '浙江', 金华: '浙江', 台州: '浙江', 湖州: '浙江', 衢州: '浙江', 丽水: '浙江', 舟山: '浙江', 义乌: '浙江',
  上海: '上海', 北京: '北京', 天津: '天津', 重庆: '重庆',
  广州: '广东', 深圳: '广东', 东莞: '广东', 佛山: '广东', 珠海: '广东', 中山: '广东',
  南京: '江苏', 苏州: '江苏', 无锡: '江苏', 南通: '江苏', 常州: '江苏',
  成都: '四川', 武汉: '湖北', 长沙: '湖南', 青岛: '山东', 济南: '山东', 郑州: '河南', 西安: '陕西',
  福州: '福建', 厦门: '福建', 大连: '辽宁', 沈阳: '辽宁', 哈尔滨: '黑龙江', 长春: '吉林',
  昆明: '云南', 南昌: '江西', 合肥: '安徽', 太原: '山西', 石家庄: '河北', 南宁: '广西',
  海口: '海南', 贵阳: '贵州', 兰州: '甘肃', 银川: '宁夏', 西宁: '青海',
  乌鲁木齐: '新疆', 拉萨: '西藏', 呼和浩特: '内蒙古',
};

function getSources(d) {
  const saved = getSetting(d, 'news_sources', null);
  if (saved) return saved;
  return JSON.parse(JSON.stringify(DEFAULT_SOURCES));
}

function setSources(d, sources) {
  setSetting(d, 'news_sources', sources);
}

function cleanHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;/g, (m) => ({
      '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    })[m])
    .replace(/\s+/g, ' ')
    .trim();
}

// 判断摘要是否可用（过滤掉"点击查看原文"之类的无意义 snippet）
function meaningful(s) {
  if (!s) return false;
  const t = String(s).trim();
  if (t.length < 10) return false;
  if (/点击查看原文|阅读原文|点击查看|查看全文|Click to view|Read more/i.test(t)) return false;
  return true;
}

// 乱码检测：中文新闻源正常标题/摘要中文字符占比高（>40%）。
// 部分站点（如早辰报）页面为 GBK 编码，聚合搜索服务端解码错误后返回乱码字节
// （形态如 "ۣ޿ӵйAIģͣ"——码点落在组合附加符号等冷门区）。
// 特征：中文字符占比极低 + 冷门码点区字符占比高 → 判定乱码，丢弃该条。
function isGarbled(s) {
  const t = String(s || '');
  if (!t.trim()) return false;
  const chars = [...t];
  const cn = chars.filter((c) => /[一-鿿　-〿＀-￯]/.test(c)).length;
  // 冷门区：组合附加标记、希伯来/希腊/西里尔扩展、傈僳文等乱码高发段
  const weird = chars.filter((c) => {
    const v = c.codePointAt(0);
    return (v >= 0x0300 && v <= 0x036f) || (v >= 0x0500 && v <= 0x0abf) || (v >= 0x7c00 && v <= 0x7fff);
  }).length;
  const cnRatio = cn / chars.length;
  const weirdRatio = weird / chars.length;
  // 纯英文新闻（如 IT之家部分标题）中文占比低但 weird 也低，不误伤
  return weirdRatio > 0.08 && cnRatio < 0.3;
}

function extractSummary(it) {
  if (meaningful(it.contentSnippet)) return String(it.contentSnippet).slice(0, 300);
  if (meaningful(it.summary)) return String(it.summary).slice(0, 300);
  if (it.content) {
    const t = cleanHtml(it.content);
    if (t.length > 20) return t.slice(0, 220);
  }
  return '（无摘要）';
}

// 本地新闻按城市过滤：城市 OR 省份命中即保留（仅城市太严，多数匹配不上）。
// 多租户：city 由调用方传入（独立库=该租户天气城市；共享库=null 不过滤，
// 展示时再按请求者租户的城市过滤——共享库无法按单一城市抓取）。
function filterByCity(items, category, city) {
  if (category !== 'local' || !city) return items;
  const c = String(city).replace(/市$/, '');
  const kws = [c, PROVINCE_OF[c]].filter(Boolean);
  if (!kws.length) return items;
  return items.filter((it) => {
    const text = `${it.title} ${it.summary}`;
    return kws.some((k) => text.includes(k));
  });
}

// 新浪新闻首页 SSR 抓取（skill 工作流：<a href> 正则提取 + 标题去重 + URL 日期优先）。
// URL 形如 https://news.sina.com.cn/w/2026-09-08/doc-xxx.shtml——带今天的日期排前，
// 旧文/无日期的排后（skill 提醒：首页混有旧文，靠日期区分）
async function fetchSinaArticles() {
  const res = await fetch('https://news.sina.com.cn/', {
    headers: { 'User-Agent': UA_CHROME, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const html = await res.text();
  const now = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const seen = new Set();
  const items = [];
  const re = /<a[^>]*href="(https?:\/\/news\.sina\.com\.cn\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(re)) {
    const url = m[1];
    const title = cleanHtml(m[2]);
    if (title.length < 8 || seen.has(title) || seen.has(url)) continue;
    if (/javascript/i.test(url)) continue;
    seen.add(title);
    seen.add(url);
    items.push({
      title: title.slice(0, 200),
      // 新浪首页链接无摘要，给固定说明文字（条目池会滤掉空摘要/'（无摘要）'）
      summary: '新浪首页要闻，点击标题查看全文',
      source: '新浪新闻',
      url,
      // 只标日期不造时间：今天的文章排前，其余排后
      published_at: url.includes(today) ? `${today}T00:00:00` : null,
      category: 'life',
    });
  }
  return items.sort((a, b) => (b.published_at || '').localeCompare(a.published_at || ''));
}

async function fetchCategory(d, category, limit = 12, city = null) {
  const sources = getSources(d)[category] || [];
  const urls = [];
  for (const s of sources) {
    if (s.url) urls.push({ name: s.name, url: s.url });
  }

  const items = [];

  for (const { name, url } of urls) {
    try {
      await politeGate(url);
      const feed = await parser.parseURL(url);
      const feedItems = (feed.items || []).slice(0, category === 'local' ? 30 : 8).map((it) => ({
        title: cleanHtml(it.title || '').slice(0, 200),
        summary: extractSummary(it),
        source: it.creator || name || feed.title || name,
        url: it.link || it.guid || '',
        published_at: it.isoDate || it.pubDate || null,
        category,
      }));
      items.push(...feedItems.filter((it) => {
        if (isGarbled(it.title) || isGarbled(it.summary)) return false;
        return true;
      }));
    } catch (e) {
      console.warn(`[news] 抓取失败 ${name}: ${e.message}`);
    }
  }

  // 新浪新闻首页 SSR 要闻（skill 实测可靠源：文章链接直出在 <a href>，无需 JS 渲染），
  // 作为 life 分类的补充源——RSS 之外再抓一拨当日要闻
  if (category === 'life') {
    try {
      await politeGate('https://news.sina.com.cn/');
      const sina = (await fetchSinaArticles())
        .filter((it) => !isGarbled(it.title))
        .slice(0, 15);
      items.push(...sina);
    } catch (e) {
      console.warn(`[news] 新浪首页抓取失败: ${e.message}`);
    }
  }

  // 直接用抓取来的摘要入库（不走 AI 概括：省 AI 耗用，也避免推理模型把
  // "我们需要理解用户要求…"之类引导文本混进摘要）。
  // 过滤掉没有真实摘要的条目（部分源 RSS 不含正文，避免"（无摘要）"霸榜）
  let pool = items.filter((it) => it.summary && it.summary !== '（无摘要）');

  // 本地新闻按城市过滤（city=null 共享库跳过，查询期再过滤）
  pool = filterByCity(pool, category, city);

  // 按时间排序（无时间排后），限制条数
  pool.sort((a, b) => (b.published_at || '').localeCompare(a.published_at || ''));
  return pool.slice(0, limit);
}

// ---------- agent 主动搜索（Tavily，免费 key） ----------
// 配置存 settings：{ provider:'tavily', api_key:'...' }
function getSearchConfig(d) {
  const saved = getSetting(d, 'news_search', null) || {};
  return {
    provider: 'tavily',
    base_url: saved.base_url || 'https://api.tavily.com',
    path: saved.path || '/search',
    api_key: saved.api_key || process.env.TAVILY_API_KEY || '',
  };
}
function setSearchConfig(d, cfg) {
  setSetting(d, 'news_search', {
    provider: 'tavily',
    base_url: (cfg && cfg.base_url) || 'https://api.tavily.com',
    path: (cfg && cfg.path) || '/search',
    api_key: (cfg && cfg.api_key) || '',
  });
}
function domainOf(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    const parts = h.split('.');
    return parts.length >= 2 ? parts[parts.length - 2] : h;
  } catch { return 'AI搜索'; }
}
// 用 Tavily 搜真实新闻：返回的标题/摘要/链接全部来自真实搜索结果（AI 不编造）
// 只要中文新闻：搜索词带中文限定 + 结果再按标题中文字符占比过滤（英文站结果丢弃）
async function fetchByAgent(d, category, limit = 5, city = null) {
  const cfg = getSearchConfig(d);
  if (!cfg || !cfg.api_key) return []; // 未配置 key → 不走 agent，回退 RSS
  const c = city ? String(city).replace(/市$/, '') : '';
  const queries = {
    tech: '今日 科技 互联网 AI 新闻 中文',
    life: '今日 社会 生活 资讯 中文',
    local: `${c || '本地'} 今日 新闻 本地报道`,
  };
  const r = await fetch((cfg.base_url || 'https://api.tavily.com').replace(/\/+$/, '') + (cfg.path || '/search'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: cfg.api_key,
      query: queries[category] || category,
      topic: 'news',
      max_results: limit + 5, // 多取几个，过滤英文后仍够数
      search_depth: 'basic',
      days: 3,
      // 注意：include_domains 只接受完整域名（如 ithome.com），裸顶级域 'cn' 会 400
      // （"All domains in include_domains are invalid"）——中文限定靠搜索词+标题过滤兜底
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Tavily ${r.status}: ${t.slice(0, 120)}`);
  }
  const j = await r.json();
  return (j.results || [])
    .filter((it) => !isGarbled(it.title) && !isGarbled(it.content)) // 丢弃源站编码错误的乱码条目
    .filter((it) => isChineseTitle(it.title)) // 只要中文新闻（英文站标题丢弃）
    .slice(0, limit)
    .map((it) => ({
      title: cleanHtml(it.title || '').slice(0, 200),
      summary: String(it.content || '').replace(/\s+/g, ' ').trim().slice(0, 220) || '（AI 搜索结果）',
      source: domainOf(it.url) || 'AI搜索',
      url: it.url,
      published_at: it.published_date || null,
      source_type: 'ai',
    }));
}
// 中文标题判定：含中文字符（标题是中文即可，不要求摘要全中文）
function isChineseTitle(t) {
  return /[一-鿿]/.test(String(t || ''));
}

// ---------- 百度榜单（实时热搜 / 电影 / 电视剧，新闻页 tab + 首页热搜卡共用） ----------
// 三个 tab 同源同构：top.baidu.com/board?tab=<board>，SSR 页面把整份榜单内嵌为
// <!--s-data:{...}--> JSON 注释（2026-09 实测，比逐条正则可靠）。
// 每条字段：word 词条/片名、desc 摘要、img 封面图 CDN 直链（实测无 Referer 可直接访问）、
// url 原链接（热搜=百度搜索结果页，影视=百科页）、hotScore 热搜指数；
// 影视板额外带 show: ["类型：喜剧","演员：张小斐、迪丽热巴、张艺兴"]。
// 存储策略：当天查看时实时抓取（10 分钟缓存全租户共享）并 upsert 进 news_hot 当日快照；
// 08:00 定时任务兜底存档（没人访问的日子也有快照）；历史按日期读库，永久留存不清理
// （周日清理只删 news 表，news_hot 永不清理）。
const BOARD_KEYS = ['realtime', 'movie', 'teleplay'];
const boardCache = new Map(); // board -> { items, fetchedAt, source }
const boardInflight = new Map();
const BOARD_TTL_MS = 10 * 60 * 1000;

function localDayStr() {
  const n = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
}

// JSON 字符串还原（处理 \uXXXX 与 \" 转义）
function decodeJsonStr(s) {
  try { return JSON.parse('"' + s + '"'); } catch { return s; }
}

// 实时热搜的关键词分类（百度榜单自身无分类字段，hotTag 是数字标记不可用）。
// 分类口径按用户要求：社会民生/体育、科技/数码、娱乐/文娱、教育/时政、其他热议（兜底）
const HOT_CATEGORIES = ['社会民生/体育', '科技/数码', '娱乐/文娱', '教育/时政', '其他热议'];
const HOT_CAT_RULES = [
  ['科技/数码', /AI|人工智能|大模型|ChatGPT|DeepSeek|机器人|芯片|半导体|光刻|算力|算法|量子|开源|互联网|科技|数码|手机|电脑|笔记本|苹果|华为|小米|OPPO|vivo|荣耀|三星|iPhone|iPad|Mac|腾讯|阿里|百度|字节|京东|淘宝|拼多多|5G|6G|卫星|航天|火箭|自动驾驶|新能源车|电动车|充电桩|电竞|游戏|网游|App|APP|软件|程序员|代码/],
  ['娱乐/文娱', /电影|电视剧|综艺|影视|票房|明星|歌手|演员|导演|演唱会|专辑|新歌|追星|粉丝|吃瓜|绯闻|官宣|恋情|结婚|离婚|娱乐|网剧|短剧|动漫|漫画|动画|音乐|歌曲|春晚|相声|小品|网红|主播|直播|豆瓣|红毯|开机|杀青|OST|爱豆|偶像/],
  ['教育/时政', /高考|中考|考研|考公|公务员|考试|招生|录取|分数线|学费|开学|放假|寒假|暑假|学校|大学|中学|小学|幼儿园|学生|教师|老师|校长|教育|教材|课堂|论文|学历|留学|外语|外交|大使|总统|首相|议会|选举|联合国|制裁|关税|国务院|政策|两会|人大|政协|声明|会谈|访问|峰会|改革|主席|总理/],
  ['社会民生/体育', /民生|物价|房价|房租|工资|养老金|医保|社保|医院|看病|药品|手术|体检|台风|地震|暴雨|高温|寒潮|冷空气|降温|天气|预警|火灾|事故|车祸|坠|警方|公安|警察|法院|判决|判刑|拘留|逮捕|嫌疑|诈骗|传销|维权|消费者|食品|安全|旅游|景区|游客|地铁|公交|高铁|火车|航班|机场|高速|拥堵|供暖|水电|燃气|快递|外卖|男子|女子|网友|小伙|姑娘|大爷|大妈|通报|回应|曝光|突发|足球|篮球|NBA|CBA|世界杯|奥运|亚运|冠军|夺冠|联赛|球员|教练|进球|乒乓球|羽毛球|排球|网球|台球|斯诺克|田径|游泳|跳水|体操|拳击|UFC|中超|亚冠|国足|体育|运动员|球队|赛季|决赛|车手|赛/],
];
function classifyHot(text) {
  for (const [cat, re] of HOT_CAT_RULES) {
    if (re.test(text)) return cat;
  }
  return '其他热议';
}

// 榜单条目归一化：影视板的 show 数组拆成 extra.{类型,演员}
function normBoardItem(it, board) {
  const item = {
    word: decodeJsonStr(String(it.word || '')),
    desc: decodeJsonStr(String(it.desc || '')),
    img: String(it.img || ''),
    url: String(it.url || ''),
    hotScore: Number(it.hotScore) || 0,
  };
  if (!item.url && item.word) item.url = 'https://www.baidu.com/s?wd=' + encodeURIComponent(item.word);
  const extra = {};
  if (Array.isArray(it.show)) {
    for (const s of it.show) {
      const m = String(s).match(/^(类型|演员|导演|编剧|年份|平台)\s*[：:]\s*(.+)$/);
      if (m) extra[m[1]] = m[2].trim();
    }
  }
  item.extra = extra;
  if (board === 'realtime') item.category = classifyHot(`${item.word} ${item.desc}`);
  return item;
}

function parseBaiduBoard(html, board) {
  // 首选：整份榜单的 s-data JSON 注释（字段最全，含 img/show）
  const m = html.match(/<!--s-data:(\{[\s\S]*?\})-->/);
  if (m) {
    try {
      const cards = ((JSON.parse(m[1]).data || {}).cards) || [];
      const items = [];
      for (const c of cards) {
        if (Array.isArray(c.content)) items.push(...c.content.map((it) => normBoardItem(it, board)));
      }
      if (items.length) return items;
    } catch (e) { console.warn('[hotboard] s-data 解析失败，回退正则:', e.message); }
  }
  // 回退：逐条正则（字段顺序 desc→hotChange→hotScore→…→img→…→url→word，[^{}]*? 防跨条目）
  const re = /"desc":"((?:[^"\\]|\\.)*)","hotChange":"[^"]*","hotScore":"(\d+)"[^{}]*?(?:"img":"((?:[^"\\]|\\.)*)")?[^{}]*?"url":"((?:[^"\\]|\\.)*)","word":"((?:[^"\\]|\\.)*)"/g;
  const items = [];
  for (const m2 of html.matchAll(re)) {
    items.push(normBoardItem({ desc: m2[1], hotScore: m2[2], img: m2[3] || '', url: m2[4], word: m2[5] }, board));
  }
  if (items.length >= 5) return items;
  // 最后兜底（skill 老办法）：只提取 word，链接现场拼百度搜索页
  const seen = new Set();
  for (const m3 of html.matchAll(/"word":"((?:[^"\\]|\\.)*)"/g)) {
    const w = decodeJsonStr(m3[1]);
    if (!w || seen.has(w)) continue;
    seen.add(w);
    items.push(normBoardItem({ word: w }, board));
  }
  return items;
}

async function fetchBaiduBoard(board) {
  const url = `https://top.baidu.com/board?tab=${board}`;
  await politeGate(url);
  const res = await fetch(url, {
    headers: { 'User-Agent': UA_CHROME, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const items = parseBaiduBoard(await res.text(), board);
  if (!items.length) throw new Error('榜单解析为空');
  return items;
}

// 榜单条目统一带名次（实时抓取的数据没有 rank 字段，按序补 1..n）
const withRank = (items) => (items || []).map((it, i) => ({ ...it, rank: i + 1 }));

// 当日实时榜单：缓存（10 分钟）+ 并发去重 + 百度失败回退旧缓存/新浪
async function getLiveBoard(board) {
  const now = Date.now();
  const c = boardCache.get(board);
  if (c && now - c.fetchedAt < BOARD_TTL_MS) return { items: withRank(c.items), fetchedAt: c.fetchedAt, source: c.source, cached: true };
  if (!boardInflight.has(board)) {
    boardInflight.set(board, fetchBaiduBoard(board)
      .then((items) => { boardCache.set(board, { items, fetchedAt: Date.now(), source: 'baidu' }); })
      .finally(() => { boardInflight.delete(board); }));
  }
  try {
    await boardInflight.get(board);
  } catch (e) {
    // 百度抓不来 → 到新浪抓（仅实时热搜有对应要闻；影视榜新浪无榜单，直接回退）
    if (board === 'realtime') {
      try {
        await politeGate('https://news.sina.com.cn/');
        const sina = await fetchSinaArticles();
        const items = sina.slice(0, 30).map((a) => normBoardItem({
          word: a.title, desc: a.summary, url: a.url, hotScore: 0,
        }, 'realtime'));
        if (items.length) {
          boardCache.set(board, { items, fetchedAt: Date.now(), source: 'sina' });
          return { items: withRank(items), fetchedAt: Date.now(), source: 'sina', fallback: true };
        }
      } catch (e2) { console.warn('[hotboard] 新浪兜底也失败:', e2.message); }
    }
    if (c) return { items: withRank(c.items), fetchedAt: c.fetchedAt, source: c.source, stale: true, error: e.message };
    throw e;
  }
  const cur = boardCache.get(board);
  return { items: withRank(cur.items), fetchedAt: cur.fetchedAt, source: cur.source };
}

// 当日快照落库（upsert：同日重复抓取刷新排名/指数/封面，词条集合取并集）
function persistHotBoard(d, board, items) {
  const day = localDayStr();
  const stmt = d.prepare(`
    INSERT INTO news_hot(board,day,rank,word,desc,img,url,hot_score,category,extra)
    VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(board,day,word) DO UPDATE SET
      rank=excluded.rank, hot_score=excluded.hot_score, desc=excluded.desc,
      img=excluded.img, url=excluded.url, category=excluded.category, extra=excluded.extra
  `);
  const tx = d.transaction((list) => {
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      if (!it.word) continue;
      stmt.run(board, day, i + 1, it.word, it.desc || '', it.img || '', it.url, it.hotScore || 0, it.category || '', JSON.stringify(it.extra || {}));
    }
  });
  tx(items || []);
  return (items || []).length;
}

// 榜单读取（新闻页 tab）：date 为空 = 今天，date 为历史日期 = 纯读库（永久留存）。
// 实时热搜：今天=实时抓取（10 分钟缓存）+ 顺手落当日快照；
// 电影/电视剧：影视榜一天变不了几次——当天已有存档直接读库（每天 09:00 定时 + 当天首次访问各存一份，
// 之后全天不再抓百度），force=1 跳过存档立即重抓。
async function getHotBoard(d, board, { date = null, limit = 60, force = false } = {}) {
  if (!BOARD_KEYS.includes(board)) throw new Error('未知榜单 ' + board);
  if (force) boardCache.delete(board);
  if (!date || date === localDayStr()) {
    const today = localDayStr();
    if (board !== 'realtime' && !force) {
      const savedItems = d.prepare('SELECT rank,word,desc,img,url,hot_score AS hotScore,category,extra FROM news_hot WHERE board=? AND day=? ORDER BY rank').all(board, today)
        .map((r) => ({ ...r, extra: safeJson(r.extra) }));
      if (savedItems.length) {
        return { board, date: today, today: true, archived: true, source: 'archive', saved: savedItems.length, items: savedItems.slice(0, limit) };
      }
    }
    const live = await getLiveBoard(board); // 今天：实时数据
    let saved = 0;
    try { saved = persistHotBoard(d, board, live.items); } catch (e) { console.warn('[hotboard] 快照落库失败:', e.message); }
    return {
      board, date: today, today: true,
      items: live.items.slice(0, limit),
      fetchedAt: live.fetchedAt, source: live.source, cached: live.cached, stale: live.stale, error: live.error, saved,
    };
  }
  const items = d.prepare('SELECT rank,word,desc,img,url,hot_score AS hotScore,category,extra FROM news_hot WHERE board=? AND day=? ORDER BY rank').all(board, date)
    .map((r) => ({ ...r, extra: safeJson(r.extra) }));
  return { board, date, today: false, items: items.slice(0, limit) };
}

function safeJson(s) { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } }

// 榜单有存档的历史日期（永久，不截 90 天）
function getHotBoardDates(d, board) {
  return d.prepare('SELECT DISTINCT day FROM news_hot WHERE board=? ORDER BY day DESC').all(board).map((r) => r.day);
}

// 三个榜单各抓一份并落当日快照（每日 09:00 定时兜底，保证无人访问的日子也有存档）
async function refreshBoards(d) {
  const result = {};
  for (const b of BOARD_KEYS) {
    try {
      const live = await getLiveBoard(b);
      result[b] = persistHotBoard(d, b, live.items);
    } catch (e) {
      result[b] = 0;
      console.warn(`[news] 榜单存档失败 ${b}: ${e.message}`);
    }
  }
  return result;
}

// 首页热搜卡（短列表；沿用当日实时数据，顺带落一份当日快照）
async function getBaiduHot(limit = 15) {
  const live = await getLiveBoard('realtime');
  return { items: withRank(live.items).slice(0, limit), fetchedAt: live.fetchedAt, source: live.source };
}

async function refreshCategory(d, category, city = null) {
  // 1) agent 主动搜索（主，需配置 Tavily key）；失败/无 key 则跳过
  let agentItems = [];
  try { agentItems = await fetchByAgent(d, category, 5, city); }
  catch (e) { console.warn(`[news] agent 搜索失败 ${category}: ${e.message}`); }
  // 2) RSS（补充）
  let rssItems = [];
  try { rssItems = await fetchCategory(d, category, 8, city); }
  catch (e) { console.warn(`[news] RSS 失败 ${category}: ${e.message}`); }
  // 只要中文新闻：标题无中文的条目不入库（英文站/纯英文标题全滤掉）
  agentItems = agentItems.filter((it) => isChineseTitle(it.title));
  rssItems = rssItems.filter((it) => isChineseTitle(it.title));
  // 合并去重（按 url），标注来源类型；agent 在前
  const seen = new Set();
  const all = [];
  for (const it of [...agentItems, ...rssItems]) {
    if (!it.url || seen.has(it.url)) continue;
    seen.add(it.url);
    all.push({ ...it, source_type: it.source_type || 'rss' });
  }
  // 入库前统一按城市过滤（共享库 city=null 跳过，查询期按请求者城市过滤）
  const finalItems = filterByCity(all, category, city);
  const insert = d.prepare(
    'INSERT OR IGNORE INTO news(category,title,summary,source,url,published_at,source_type,ai_tokens,ai_model) VALUES(?,?,?,?,?,?,?,?,?)'
  );
  const tx = d.transaction((list) => {
    let added = 0;
    for (const it of list) {
      // AI 耗用记账：当前管道 Tavily 是搜索 API（不走大模型）、RSS 直抓 → 恒 0；
      // 列留在这里，未来接入 LLM 概括/翻译时如实写入 token 数与模型名
      const r = insert.run(category, it.title, it.summary, it.source, it.url, it.published_at, it.source_type, it.ai_tokens || 0, it.ai_model || '');
      if (r.changes > 0) added++;
    }
    return added;
  });
  return tx(finalItems);
}

// 某分类某天抓取到的最新 N 条（默认当天；历史新闻按日期翻阅）
// 本地新闻按城市过滤（查询期：city 传请求者租户的天气城市；共享库各用户可不同城市）
function getDailyNews(d, category, limit = 5, dateStr = null, city = null) {
  // 用本地日期（fetched_at 存的是 localtime），避免 UTC 偏移导致当天新闻不显示
  const now = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const day = dateStr || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  let sql =
    `SELECT id,title,summary,source,url,published_at,fetched_at,source_type,ai_tokens,ai_model
     FROM news WHERE category=? AND substr(fetched_at,1,10)=?`;
  const params = [category, day];
  if (category === 'local' && city) {
    const c = String(city).replace(/市$/, '');
    const kws = [c, PROVINCE_OF[c]].filter(Boolean);
    if (kws.length) {
      sql += ` AND (${kws.map(() => '(title LIKE ? OR summary LIKE ?)').join(' OR ')})`;
      for (const k of kws) params.push(`%${k}%`, `%${k}%`);
    }
  }
  sql += ` ORDER BY COALESCE(published_at, fetched_at) DESC LIMIT ?`;
  params.push(limit);
  return d.prepare(sql).all(...params);
}

// 有新闻记录的历史日期（按天去重，最近 90 天）
function getDates(d) {
  return d.prepare(
    'SELECT DISTINCT substr(fetched_at,1,10) d FROM news ORDER BY d DESC LIMIT 90'
  ).all().map((r) => r.d);
}

async function refreshAll(d, city = null) {
  const cats = ['tech', 'life', 'local'];
  const result = {};
  for (const c of cats) {
    try {
      result[c] = await refreshCategory(d, c, city);
    } catch (e) {
      result[c] = 0;
      console.warn(`[news] 刷新 ${c} 失败: ${e.message}`);
    }
  }
  return result;
}

module.exports = { getSources, setSources, getSearchConfig, setSearchConfig, refreshCategory, refreshAll, getDailyNews, getDates, getBaiduHot, getHotBoard, getHotBoardDates, refreshBoards, HOT_CATEGORIES, classifyHot };
