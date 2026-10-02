// NAS Hermes agent 客户端（v1.9.31）
// 对接的是 hermes-agent 容器暴露的 OpenAI 兼容 API Server（默认内网 8642 端口）。
// 职责边界：只负责「把一句话发过去、拿回一句话」。密钥由调用方解密后传入——
// 这个模块不读配置、不碰数据库，方便单测直接喂假 endpoint。
//
// 安全前提：这个 base_url 指向的是能读写 NAS 文件的 agent，**绝不能暴露到公网**。
// 工作台侧只做「点名才放行 + 限流 + 危险词拦截 + 审计」四道外围约束。

// Hermes 的 OpenAI 兼容接口在 /v1/chat/completions（实测：POST /chat/completions → 404，
// POST /v1/chat/completions → 401/405，即路由只在后者）。面板里让大家填的是「IP:端口」，
// 所以只填了主机名（没有路径）时自动补 /v1——否则一填就 404（v1.9.32 修）。
// 已经带了路径的（如 …/hermes/v1、或整条 …/chat/completions）按原样走，不猜。
const chatEndpoint = (base) => {
  const b = String(base || '').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(b)) return b;           // 整条接口地址粘进来了
  let pathname = '';
  try { pathname = new URL(b).pathname; } catch { /* 形状怪：按无路径处理 */ }
  if (!pathname || pathname === '/') return b + '/v1/chat/completions';
  return b.replace(/\/chat\/completions$/i, '') + '/chat/completions';
};

// 语音播报用的系统提示：Hermes 默认回答偏长（它是个会写 markdown 的 agent），
// 不约束的话 TTS 会念一串列表符号和星号。
const VOICE_SYSTEM =
  '你是一个语音助手，回答会被直接朗读出来。用不超过 60 字的中文口语回答，' +
  '不要 markdown、不要列表、不要标题、不要引号、不要表情符号。' +
  '如果需要操作但没权限，就直接说做不到，不要编造结果。';

// text 有值则以它为准（任务原文），否则退回放到用户消息里的默认串
async function ask({ baseUrl, apiKey, model, text, systemPrompt, timeoutMs = 60000 }) {
  const base = String(baseUrl || '').trim();
  if (!base) throw new Error('未配置 Hermes 地址');
  if (!apiKey) throw new Error('未配置 Hermes 密钥');
  if (!model) throw new Error('未配置 agent 档案名（面板里的「Agent 名」）');
  const task = String(text || '').trim().slice(0, 200);
  if (!task) throw new Error('要转交的内容为空');

  let res;
  try {
    res = await fetch(chatEndpoint(base), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt || VOICE_SYSTEM },
          { role: 'user', content: task },
        ],
        max_tokens: 300,
        temperature: 0.3,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // 超时/断网：翻成人话，固件那边会直接念出来
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error(`Hermes ${Math.round(timeoutMs / 1000)} 秒内没回应`);
    throw new Error(`连不上 Hermes（${e.cause && e.cause.code ? e.cause.code : e.message}）`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('Hermes 密钥不对（401）');
    if (res.status === 404) throw new Error(`Hermes 接口 404（地址不对——面板里只填 IP:端口 即可，路径会自动补）：${body.slice(0, 120)}`);
    throw new Error(`Hermes 接口错误 ${res.status}：${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  const content = String((msg && (msg.content || msg.reasoning_content)) || '').trim();
  if (!content) throw new Error('Hermes 返回了空内容');
  return { content, model: data.model || model, usage: data.usage || null };
}

// 连通性自检（面板「测试」按钮用）：只回耗时与是否通，不回内容——避免把 agent 的输出留在前端。
// 失败时回 url（我们实际试的那个地址）：404 类错误光看「接口错误」没法排查，地址得摆在眼前。
async function ping({ baseUrl, apiKey, model, timeoutMs = 15000 }) {
  const t0 = Date.now();
  const url = chatEndpoint(baseUrl);
  try {
    const r = await ask({ baseUrl, apiKey, model, text: '回复「在」一个字即可', timeoutMs });
    return { ok: true, ms: Date.now() - t0, chars: r.content.length };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: e.message, url };
  }
}

module.exports = { ask, ping, VOICE_SYSTEM, chatEndpoint };
