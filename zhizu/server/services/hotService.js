// 热门话题多源服务：百度热搜 / 新浪要闻 / AI 智能生成
// 百度：top.baidu.com 页面内嵌 <!--s-data:{...}--> 注释 JSON
// 新浪：feed.mix.sina.com.cn 滚动新闻 API
// AI：结合实时热点词 + 行业，让 LLM 出选题（对标原版 lingguang.data.fetch 联网检索）

const { getSetting } = require('../db');

const TTL = 10 * 60 * 1000; // 10 分钟缓存
const cache = new Map(); // key -> { at, data }

async function fetchWithUA(url, { timeout = 10000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function cached(key, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.data);
  if (hit && hit.inflight) return hit.inflight;
  const p = fn().then(data => {
    cache.set(key, { at: Date.now(), data });
    return data;
  }).catch(e => {
    // 失败回退旧缓存（标 stale）
    if (hit) { hit.at = Date.now() - TTL + 60000; return hit.data; }
    throw e;
  });
  cache.set(key, { at: Date.now(), inflight: p });
  return p;
}

// ---- 百度热搜（实时榜）----
async function fetchBaidu() {
  return cached('baidu', async () => {
    const res = await fetchWithUA('https://top.baidu.com/board?tab=realtime');
    if (!res.ok) throw new Error(`百度热搜 HTTP ${res.status}`);
    const html = await res.text();
    const m = html.match(/<!--s-data:(\{[\s\S]*?\})-->/);
    if (!m) throw new Error('百度热搜页面结构变化，未找到 s-data');
    const json = JSON.parse(m[1]);
    const list = ((json.data && json.data.cards && json.data.cards[0] && json.data.cards[0].content) || [])
      .map((c, i) => ({
        rank: i + 1,
        title: c.word || '',
        description: c.desc || '',
        url: c.url || '',
        hotScore: Number(c.hotScore) || 0,
      }))
      .filter(x => x.title);
    if (!list.length) throw new Error('百度热搜解析结果为空');
    return { items: list.slice(0, 50), source: 'baidu', sourceName: '百度热搜' };
  });
}

// ---- 新浪要闻 ----
async function fetchSina() {
  return cached('sina', async () => {
    const res = await fetchWithUA('https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2509&k=&num=50&page=1');
    if (!res.ok) throw new Error(`新浪要闻 HTTP ${res.status}`);
    const data = await res.json();
    const list = (((data.result && data.result.data) || [])
      .map((c, i) => ({
        rank: i + 1,
        title: (c.title || '').replace(/<[^>]+>/g, ''),
        description: (c.intro || '').replace(/<[^>]+>/g, '').slice(0, 120),
        url: c.url || '',
        hotScore: 0,
        ctime: c.ctime,
      }))
      .filter(x => x.title));
    if (!list.length) throw new Error('新浪要闻解析结果为空');
    return { items: list.slice(0, 50), source: 'sina', sourceName: '新浪要闻' };
  });
}

// ---- AI 智能生成（结合实时热点词）----
async function aiTopics({ industry, aiFn }) {
  // 尽力拿百度热点词做种子（拿不到也能纯 AI 生成）
  let hotWords = [];
  try {
    const b = await fetchBaidu();
    hotWords = b.items.slice(0, 15).map(x => x.title);
  } catch { /* 无网或百度结构变化，跳过 */ }

  const today = new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  const hotSection = hotWords.length
    ? `\n当前实时热点词（百度热搜，可挑选与本行业有关联的角度蹭热点，不必强行关联）：\n${hotWords.map((w, i) => `${i + 1}. ${w}`).join('\n')}\n`
    : '';

  const prompt = `你是一位专业的短视频热点选题专家。请针对用户的行业领域，生成10个当下适合做的热门话题选题。

行业领域：${industry}
日期：${today}
${hotSection}
生成要求：
1. 话题标题简洁有力，适合作为短视频选题
2. 每个话题说明为什么热门/为什么值得做
3. 给出相关关键词（用于内容创作参考）
4. 标注热度等级：高、中、低
5. 给出结合该话题做内容的创作建议
6. 若热点词与行业有关联，优先做"行业 × 热点"的跨界选题，并在该项的 source 字段填写所结合的热点词原文；与热点无关的纯行业原创话题，source 填空字符串

请以JSON数组格式输出，格式如下：
[
  {
    "title": "话题标题",
    "description": "话题简要说明",
    "keywords": ["关键词1", "关键词2"],
    "heatLevel": "高",
    "suggestion": "创作建议",
    "source": "所结合的实时热点词原文（纯原创则为空字符串）"
  }
]

只返回JSON数组，不要有其他文字。`;

  const r = await aiFn(prompt, 90000);
  let arr = [];
  try {
    arr = JSON.parse(r.content);
  } catch {
    const m = r.content.match(/\[[\s\S]*\]/);
    if (m) arr = JSON.parse(m[0]);
  }
  if (!Array.isArray(arr) || !arr.length) throw Object.assign(new Error('AI 话题解析失败，请重试'), { status: 502 });
  return {
    items: arr.slice(0, 10).map((t, i) => ({
      rank: i + 1,
      title: t.title || '',
      description: t.description || '',
      keywords: Array.isArray(t.keywords) ? t.keywords : [],
      heatLevel: t.heatLevel || '中',
      suggestion: t.suggestion || '',
      source: String(t.source || '').slice(0, 60), // 该选题结合的实时热点词（前端生成来源链接）
      url: '',
      hotScore: 0,
    })),
    source: 'ai',
    sourceName: hotWords.length ? 'AI 智能选题（结合实时热点）' : 'AI 智能选题',
    tokens: r.tokens,
    model: r.model,
    raw: r.content,
    hotWords, // 本次用作种子的实时热点词（前端「来源」链接展示/溯源）
    hotSourceUrl: 'https://top.baidu.com/board?tab=realtime',
  };
}

// 源注册表（配置开关存 settings.hot_sources）
const SOURCES = {
  baidu: { name: '百度热搜', fetch: fetchBaidu },
  sina: { name: '新浪要闻', fetch: fetchSina },
  ai: { name: 'AI 智能选题', needAI: true },
};

function enabledSources() {
  const cfg = getSetting('hot_sources', { baidu: true, sina: true, ai: true });
  return cfg;
}

module.exports = { fetchBaidu, fetchSina, aiTopics, SOURCES, enabledSources };
