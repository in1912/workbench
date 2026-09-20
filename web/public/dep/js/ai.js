// AI 扩展分析模块
// - 配置存储：兼容 OpenAI 接口格式的服务（OpenAI / DeepSeek / Kimi / GLM / 通义 / 本地 Ollama 等）
//   baseURL 填到 /v1 为止，例如 https://api.deepseek.com/v1
// - 调用：POST {baseURL}/chat/completions，支持流式（SSE）
// - 提示词：把测试者的完整作答（每题题干 + 所选选项文本 + 归属字母）与得分、结果一并交给 AI 做深入分析
(function () {
  'use strict';

  const CFG_KEY = 'mbti_ai_config_v1';

  const DEFAULT_CFG = {
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    apiKey: '',
    temperature: 0.7,
    stream: true,
  };

  function loadCfg() {
    try {
      return Object.assign({}, DEFAULT_CFG, JSON.parse(localStorage.getItem(CFG_KEY) || '{}'));
    } catch (e) { return Object.assign({}, DEFAULT_CFG); }
  }
  function saveCfg(patch) {
    const cfg = Object.assign(loadCfg(), patch || {});
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    return cfg;
  }

  // ---- 提示词构建：完整答题结果 ----
  function buildPrompt(user, profile, flatQuestions) {
    const S = window.MBTI_SCORING;
    const REPORTS = window.MBTI_TYPE_REPORTS;
    const C = window.MBTI_CONTENT;
    const r = REPORTS[profile.type] || {};
    const tempKey = S.temperamentOf(profile.type);
    const temp = C.temperaments[tempKey] || {};

    // 维度得分行
    const dimLines = (profile.stats || []).map(s =>
      `${s.left}（${s.leftCount}）vs ${s.right}（${s.rightCount}）→ 倾向 ${s.winner}，强度 ${(s.ratio * 100).toFixed(0)}%`).join('\n');

    // 完整作答明细
    const answerLines = flatQuestions.map((q, i) => {
      const choice = profile.answers && profile.answers[i + 1];
      if (choice == null) return '';
      const c = q.choices[choice] || {};
      const stem = q.stem ? `【${q.stem}】` : '';
      return `${i + 1}. ${stem}${c.text}（${c.letter}）`;
    }).filter(Boolean).join('\n');

    const userInfo = [];
    if (user.nickname) userInfo.push(`昵称：${user.nickname}`);
    if (user.name) userInfo.push(`姓名：${user.name}`);
    if (user.age) userInfo.push(`年龄：${user.age}`);
    if (user.gender) userInfo.push(`性别：${user.gender}`);
    if (user.job) userInfo.push(`职业：${user.job}`);
    if (user.hobbies) userInfo.push(`爱好：${user.hobbies}`);
    if (user.uid) userInfo.push(`档案编号：${user.uid}`);

    return `你是一位资深的 MBTI 心理测评分析师与职业发展顾问，精通荣格心理类型理论。请基于下面这份完整的测评数据，给出深入、全面、个性化的分析报告。

【测评者信息】
${userInfo.length ? userInfo.join('，') : '（未提供，跳过个人信息相关推断）'}

【测试版本】${profile.version === '93' ? 'MBTI 93 题完整版（四部分：23+24+23+23）' : 'MBTI 28 题速测版'}

【测试结果】${profile.type}${r.name ? '（' + r.name + '）' : ''}${r.motto ? '「' + r.motto + '」' : ''}
【气质类型】${temp.name || tempKey} —— ${temp.style || ''}
【四维度得分】
${dimLines}

【完整作答明细】（每题为二选一，括号内为该选项归属的维度字母）
${answerLines}

请用中文输出结构化的深度分析报告，包含以下部分：
一、总体画像：结合具体作答证据（引用典型题目选择）描绘这个人的思维与行为风格；
二、四维度深度解析：逐一分析 E/I、S/N、T/F、J/P 的表现，注意得分接近的维度要指出"边界特征"；
三、优势与盲点：结合作答指出可发挥的优势与需警惕的盲点；
四、职业发展建议：适合的行业、岗位特质、团队角色，以及应避免的环境；
五、人际与组合搭配：与什么类型的人合作顺畅、可能摩擦的类型及相处建议；
六、个人成长建议：3-5 条具体可执行的行动建议。

要求：分析要引用测评者的具体作答内容作为证据，避免空泛的模板话术；语气专业而温暖；使用 Markdown 标题与列表组织内容。`;
  }

  // ---- 调用（OpenAI 兼容 chat/completions）----
  // onDelta(增量文本)、onDone(全文)、onError(错误)
  async function analyze(prompt, { onDelta, onDone, onError } = {}) {
    const cfg = loadCfg();
    if (!cfg.apiKey) {
      const e = new Error('未配置 API Key，请先到「设置」页填写 AI 接口配置');
      if (onError) onError(e); return;
    }
    const url = cfg.baseURL.replace(/\/+$/, '') + '/chat/completions';
    const body = {
      model: cfg.model,
      temperature: Number(cfg.temperature) || 0.7,
      stream: !!cfg.stream,
      messages: [
        { role: 'system', content: '你是专业的 MBTI 心理测评分析师，擅长基于测评数据输出深入、具体、有洞察力的中文分析报告。' },
        { role: 'user', content: prompt },
      ],
    };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`接口返回 ${res.status}：${txt.slice(0, 200) || '请检查 baseURL / 模型名 / Key'}`);
      }
      if (!body.stream || !res.body || !res.body.getReader) {
        const data = await res.json();
        const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '(空响应)';
        if (onDelta) onDelta(text);
        if (onDone) onDone(text);
        return;
      }
      // SSE 流式
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '', full = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
            if (delta) { full += delta; if (onDelta) onDelta(delta, full); }
          } catch (e) { /* 忽略残包 */ }
        }
      }
      if (onDone) onDone(full);
    } catch (e) {
      if (onError) onError(e);
    }
  }

  // 连通性测试（设置页用）
  async function testConnection() {
    const cfg = loadCfg();
    if (!cfg.apiKey) throw new Error('未配置 API Key');
    const url = cfg.baseURL.replace(/\/+$/, '') + '/chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({ model: cfg.model, max_tokens: 8, messages: [{ role: 'user', content: '你好' }] }),
    }).catch(e => { throw new Error('网络错误：' + e.message + '（注意浏览器 CORS 限制与域名白名单）'); });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`返回 ${res.status}：${txt.slice(0, 160)}`);
    }
    const data = await res.json();
    return (data.choices && data.choices[0] && 'ok') || 'ok';
  }

  // 极简 Markdown 渲染（标题/加粗/列表/段落），无外部依赖
  function mdToHtml(md) {
    const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const lines = String(md || '').split(/\r?\n/);
    const out = [];
    let inList = false;
    for (let raw of lines) {
      const line = raw.replace(/\s+$/, '');
      const h = line.match(/^(#{1,4})\s+(.*)$/);
      const li = line.match(/^\s*(?:[-*·]|\d+[.、)])\s+(.*)$/);
      const bold = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
      if (h) { if (inList) { out.push('</ul>'); inList = false; } out.push(`<h4 class="md-h">${bold(h[2])}</h4>`); }
      else if (li) { if (!inList) { out.push('<ul class="list">'); inList = true; } out.push(`<li>${bold(li[1])}</li>`); }
      else if (line.trim() === '') { if (inList) { out.push('</ul>'); inList = false; } }
      else { if (inList) { out.push('</ul>'); inList = false; } out.push(`<p>${bold(line)}</p>`); }
    }
    if (inList) out.push('</ul>');
    return out.join('');
  }

  window.MBTI_AI = { loadCfg, saveCfg, buildPrompt, analyze, testConnection, mdToHtml, CFG_KEY, DEFAULT_CFG };
})();
