// OpenAI 兼容 AI 调用服务
const { db, getSetting } = require('../db');
const { encrypt, decrypt } = require('./cryptoUtil');

// 防双后缀：无论用户填 域名 / 域名+v1 / 完整端点，都拼出正确地址
function chatEndpoint(base) {
  let b = String(base || '').trim().replace(/\/+$/, '');
  b = b.replace(/\/chat\/completions$/, '');
  return b + '/chat/completions';
}

// 解析某用户生效的 AI 配置：个人覆盖 > 全局（key 静态加密存储，用前解密）
function resolveConfig(user) {
  if (user && user.ai_key && user.ai_base) {
    const key = decrypt(user.ai_key);
    if (key) return { base: user.ai_base, model: user.ai_model || 'deepseek-chat', key, source: 'personal' };
  }
  const g = {
    base: getSetting('ai_base', ''),
    model: getSetting('ai_model', ''),
    key: decrypt(getSetting('ai_key', '')),
  };
  if (g.key && g.base) return { ...g, source: 'global' };
  return null;
}

// 全局配置掩码回显（不回传明文 key）
function maskConfig() {
  const key = decrypt(getSetting('ai_key', ''));
  return {
    base: getSetting('ai_base', ''),
    model: getSetting('ai_model', ''),
    key_masked: key ? '***' : '',
    configured: !!(key && getSetting('ai_base', '')),
  };
}

/**
 * 调 LLM。messages 为 OpenAI 格式数组。
 * 返回 { content, tokens, model }
 */
async function chat(cfg, messages, { timeout = 120000, temperature } = {}) {
  const url = chatEndpoint(cfg.base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.key}` },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        stream: false,
        ...(temperature != null ? { temperature } : {}),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`AI 接口返回 ${res.status}：${text.slice(0, 300)}`);
      err.status = 502;
      throw err;
    }
    const data = await res.json();
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    // 推理模型偶发 content 空、正文在 reasoning_content
    const content = (msg && (msg.content || msg.reasoning_content)) || '';
    if (!content) throw Object.assign(new Error('AI 返回内容为空，请重试或更换模型'), { status: 502 });
    return {
      content,
      tokens: (data.usage && data.usage.total_tokens) || 0,
      model: data.model || cfg.model,
    };
  } catch (e) {
    if (e.name === 'AbortError') throw Object.assign(new Error('AI 生成超时，请重试'), { status: 504 });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { chatEndpoint, resolveConfig, maskConfig, chat };
