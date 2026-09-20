// 富文本内容（家庭事项/学习任务粘贴图片产生）的前端渲染与判断辅助。
// 约定：存库内容 = 纯文本 或 「转义文本 + <br> + 本站图床 <img>」的安全 HTML（服务端 sanitizeRich 已兜底）。

// 是否富文本（含 img/br 标签）
export function isRich(s) {
  return /<(img|br)\b/i.test(String(s || ''));
}

// 富文本 → 纯文本预览：<img> 变 [图片]、标签剥掉（看板小卡/搜索结果/弹窗预览用，避免露出 HTML 标签）
export function plainText(s) {
  let i = 0;
  return String(s || '')
    .replace(/<img\b[^>]*>/gi, () => `[图片${++i}]`)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .trim();
}

// 录入校验：剥掉标签后仍有文字，或内容里带图片，都算有内容
export function richHasContent(s) {
  return plainText(s).length > 0 || /<img\b/i.test(String(s || ''));
}

// 渲染用 HTML：<img> 补上当前登录 token（<img> 请求带不了 Authorization 头），非本站图床的 img 一律丢弃；
// 本站图床 = /api/family-images/N（录入粘贴）与 /api/message-images/N（钉钉机器人收图）；
// 纯文本走转义 + \n→<br>，统一交给 v-html
export function displayHtml(s) {
  const t = String(s || '');
  const token = encodeURIComponent(localStorage.getItem('wb_token') || '');
  const rich = t
    .replace(/<img\b[^>]*src="(\/api\/(?:family|message)-images\/\d+)"[^>]*\/?>/gi, (m, url) => `<img src="${url}?token=${token}">`)
    .replace(/<img\b(?![^>]*\/api\/(?:family|message)-images\/)[^>]*>/gi, '');
  if (rich !== t) return rich; // 含本站 img：已是安全富文本
  // 纯文本：整体转义后换行变 <br>（已含 <br> 的旧富文本经转义无害显示）
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}
