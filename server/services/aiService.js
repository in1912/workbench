const { db, routedDb } = require('../db');

// 多租户：AI 配置按共享开关选库（共享→主库；独立→该租户库）。
// tdb=null（无请求上下文）时默认主库。
function getConfig(tdb = null) {
  const d = tdb ? routedDb(tdb, 'ai_config') : db;
  return d.prepare('SELECT * FROM ai_config WHERE id=1').get() || {};
}

function hasConfig(tdb = null) {
  const c = getConfig(tdb);
  return !!(c.model && c.base_url && c.api_key);
}

// OpenAI 兼容接口调用，返回 text；408/429/5xx 自动重试（高峰波动/超时兜底）
// chat endpoint normalization: tolerate a full endpoint URL (..../chat/completions) or trailing slashes in base_url (v1.3.5)
function chatEndpoint(base) {
  return String(base || '').replace(/\/+$/, '').replace(/\/chat\/completions$/i, '') + '/chat/completions';
}

// chatEx：与 chat 同逻辑，但返回 { content, model, usage }（usage 取 OpenAI 兼容响应的
// prompt/completion/total tokens；个别网关不回传 usage 时为 null）。
// chat 保持只返回文本，既有调用方零改动；需要向用户标注「用了哪个模型、耗了多少 token」的场景用 chatEx。
async function chatEx(messages, { maxTokens = 1024, temperature = 0.7, reasoningEffort, tdb = null } = {}) {
  const cfg = getConfig(tdb);
  if (!cfg.model || !cfg.base_url || !cfg.api_key) {
    throw new Error('AI 尚未配置，请先在「设置」中填写模型名称 / API 地址 / API Key');
  }
  const url = chatEndpoint(cfg.base_url);
  const attempt = async () => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.api_key}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        max_tokens: maxTokens,
        temperature,
        stream: false,
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      }),
      signal: AbortSignal.timeout(150000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`AI 接口错误 ${res.status}: ${body.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };
  let data;
  try {
    data = await attempt();
  } catch (e) {
    // 408/429/5xx（服务端超时/限流/波动）：间隔 1.5s 重试一次
    if ((e.status === 408 || e.status === 429 || (e.status >= 500 && e.status < 600)) || e.name === 'TimeoutError') {
      await new Promise((r) => setTimeout(r, 1500));
      data = await attempt();
    } else {
      throw e;
    }
  }
  // 推理模型（deepseek-v4-flash 等）偶发 content 为空但推理内容在 reasoning_content；
  // 回退取 reasoning_content，仍空则报错而非静默存空回复
  const msg = data.choices?.[0]?.message;
  const content = msg?.content || msg?.reasoning_content || '';
  if (!content) throw new Error('AI 返回内容为空，请重试一次');
  const u = data.usage || null;
  const usage = u ? {
    prompt_tokens: u.prompt_tokens ?? null,
    completion_tokens: u.completion_tokens ?? null,
    total_tokens: u.total_tokens ?? null,
  } : null;
  // finish_reason（stop=正常收尾 / length=被 max_tokens 截断 / …）：调用方判「截断还是真答完」的依据
  return { content: content.trim(), model: cfg.model, usage, finish_reason: data.choices?.[0]?.finish_reason ?? null };
}

async function chat(messages, opts = {}) {
  return (await chatEx(messages, opts)).content;
}

async function summarize(text, instruction, tdb = null) {
  const messages = [
    { role: 'system', content: '你是中文信息整理助手。只输出整理后的内容本身，不要任何解释或开场白。' },
    { role: 'user', content: `${instruction}\n\n内容如下：\n${text.slice(0, 4000)}` },
  ];
  return (await chat(messages, { maxTokens: 500, temperature: 0.3, tdb })).trim();
}

// 视觉识读（vision）：把页面图片交给多模态模型转文字。
// 优先用独立视觉模型配置（vision_* 列）；未配置时回落主模型（若主模型不支持图片会报错并提示）。
// dataUrls: ['data:image/png;base64,...']；返回识别出的文字。
async function ocrImages(dataUrls, { hint = '', tdb = null } = {}) {
  const cfg = getConfig(tdb);
  const vModel = cfg.vision_model || cfg.model;
  const vBase = (cfg.vision_base_url || cfg.base_url || '').replace(/\/+$/, '');
  const vKey = cfg.vision_api_key || cfg.api_key;
  if (!vModel || !vBase || !vKey) {
    throw new Error('AI 视觉模型未配置：请到「设置 → AI 配置」填写视觉模型（如 qwen-vl-max / glm-4v），或在主模型支持图片时留空');
  }
  const content = [
    { type: 'text', text: `请把图片中的全部文字内容识别出来，按原始阅读顺序输出纯文本（保留段落结构）。${hint}` },
    ...dataUrls.slice(0, 4).map((url) => ({ type: 'image_url', image_url: { url } })),
  ];
  const res = await fetch(chatEndpoint(vBase), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${vKey}` },
    body: JSON.stringify({ model: vModel, messages: [{ role: 'user', content }], max_tokens: 4000, temperature: 0.1 }),
    signal: AbortSignal.timeout(150000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    // 典型错误：文本模型不支持 image_url
    if (/image_url|unknown variant|multimodal|vision/i.test(t)) {
      throw new Error('当前模型不支持图片输入：请在「设置 → AI 配置」配置支持视觉的模型（如 qwen-vl-max / glm-4v / gpt-4o）');
    }
    throw new Error(`视觉模型接口错误 ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  // 推理模型偶发 content 为空但内容在 reasoning_content（同 chat 的兜底）
  const msg = data.choices?.[0]?.message;
  const out = String(msg?.content || msg?.reasoning_content || '').trim();
  if (!out) throw new Error('视觉模型返回内容为空');
  return out;
}

module.exports = { getConfig, hasConfig, chatEndpoint, chat, chatEx, summarize, ocrImages };
