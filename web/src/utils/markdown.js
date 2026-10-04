// 笔记模块共用的 Markdown 渲染（v1.9.41）。
//
// 为什么自己包一层而不是各处直接 marked.parse：
// ① 双链 [[标题]] 要渲染成可点链接（命中跳转 / 未命中一键新建），且**不能**误伤代码块里的 [[..]]；
// ② 有两条**不可信来源**会走到这里——外部写入令牌收进来的笔记、公开分享页 /s/:token——
//    而 marked 从 v5 起就不再自带净化，所以渲染完必须过一遍 scrubHtml；
// ③ 原始 HTML 一律转义成文本（普通用户不需要在笔记里写 HTML，但需要它不能变成 XSS 载荷）。
import { Marked } from 'marked';

// ---------- 基础 ----------
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 与服务端 noteService.extractWordCount 同一套规则（中日韩按字、拉丁按词），
// 这样顶栏的实时字数和服务端统计插件算出来的数不会对不上。
export function wordCount(text) {
  const s = String(text || '');
  const cjk = (s.match(/[㐀-䶿一-鿿぀-ヿ가-힯]/g) || []).length;
  const latin = (s.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
  return cjk + latin;
}

// ---------- URL 白名单 ----------
// 去掉控制字符再判（`java\tscript:` 这类绕过）。
function safeUrl(v, { image = false } = {}) {
  const s = String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!s) return '';
  if (/^(https?:|mailto:|tel:|#|\/(?!\/)|\.{1,2}\/)/i.test(s)) return s;
  if (image && /^data:image\/(png|jpe?g|gif|webp|avif|bmp);base64,/i.test(s)) return s;
  return '';
}

const BAD_TAGS = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'style', 'link', 'meta', 'base', 'form', 'noscript', 'template', 'svg', 'math']);

// 兜底用的正则版（环境里没有 DOMParser 时才会走到；浏览器里一律走 DOM 版）
function scrubByRegex(html) {
  let out = String(html || '');
  for (const t of BAD_TAGS) out = out.replace(new RegExp(`<\\s*${t}\\b[^>]*>[\\s\\S]*?<\\s*/\\s*${t}\\s*>`, 'gi'), '')
    .replace(new RegExp(`<\\s*/?\\s*${t}\\b[^>]*>`, 'gi'), '');
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\sstyle\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\s(href|src)\s*=\s*("\s*(?:javascript|vbscript|data:text)[^"]*"|'\s*(?:javascript|vbscript|data:text)[^']*')/gi, '');
  return out;
}

// 后处理净化：删危险标签、所有 on* 事件属性、style，校验 href/src；外链补 noopener。
export function scrubHtml(html) {
  const src = String(html || '');
  if (typeof DOMParser === 'undefined') return scrubByRegex(src);
  const doc = new DOMParser().parseFromString(`<body><div id="__wb_root">${src}</div></body>`, 'text/html');
  const root = doc.getElementById('__wb_root');
  if (!root) return scrubByRegex(src);
  const walk = (node) => {
    for (const el of Array.from(node.children)) {
      const tag = el.tagName.toLowerCase();
      if (BAD_TAGS.has(tag)) { el.remove(); continue; }
      for (const at of Array.from(el.attributes)) {
        const name = at.name.toLowerCase();
        if (name.startsWith('on') || name === 'style' || name === 'srcdoc' || name === 'formaction') {
          el.removeAttribute(at.name);
          continue;
        }
        if (name === 'href' || name === 'src' || name === 'xlink:href') {
          if (!safeUrl(at.value, { image: tag === 'img' })) el.removeAttribute(at.name);
        }
      }
      if (tag === 'a' && /^https?:/i.test(el.getAttribute('href') || '')) {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }
      walk(el);
    }
  };
  walk(root);
  return root.innerHTML;
}

// ---------- 双链 ----------
const WIKI_RE = /\[\[([^[\]\n]{1,80})\]\]/;

function wikiExtension(resolve, style) {
  return {
    name: 'wiki',
    level: 'inline',
    start(src) {
      const i = src.indexOf('[[');
      return i < 0 ? undefined : i;
    },
    tokenizer(src) {
      const m = WIKI_RE.exec(src);
      if (!m || m.index !== 0) return undefined;
      return { type: 'wiki', raw: m[0], title: m[1].trim() };
    },
    renderer(token) {
      const t = token.title;
      const label = escapeHtml(t);
      // 导出成文件时双链没有跳转目标，渲染成普通文字（点不动的链接比没有链接更让人困惑）
      if (style === 'plain') return `<span class="wl">${label}</span>`;
      const hit = resolve ? resolve(t) : null;
      if (hit && hit.id != null) {
        return `<a class="wl" data-wiki-note="${escapeHtml(String(hit.id))}" href="#/notes?note=${encodeURIComponent(String(hit.id))}">${label}</a>`;
      }
      // 未命中 → 点一下带着标题去新建（URL 形状与老版一致，wiki 里的历史链接不会失效）
      return `<a class="wl wl-miss" data-wiki-new="${escapeHtml(t)}" href="#/notes?newtitle=${encodeURIComponent(t)}">${label} ＋</a>`;
    },
  };
}

/**
 * 渲染 Markdown。
 * @param {string} src 正文
 * @param {object|function} [opts] 传函数等价于 { resolveWiki }
 * @param {(title:string)=>({id:number}|null)} [opts.resolveWiki] 双链解析器：给标题返回命中的笔记
 * @param {'link'|'plain'} [opts.wikiStyle] plain = 双链渲染成普通文字（导出文件用）
 */
export function renderMarkdown(src, opts = {}) {
  const resolveWiki = typeof opts === 'function' ? opts : opts.resolveWiki;
  const style = (typeof opts === 'function' ? '' : opts.wikiStyle) || 'link';
  const m = new Marked();
  m.use({
    // 原始 HTML 一律当纯文本：笔记里写 <script> 只会看到这几个字，而不是执行它
    renderer: {
      html(token) { return escapeHtml(token.text ?? token.raw ?? ''); },
    },
    extensions: [wikiExtension(resolveWiki, style)],
  });
  return scrubHtml(m.parse(String(src ?? '')));
}

// ---------- 大纲 ----------
// 抽 H1–H6（跳过围栏代码块里的 # 注释行 —— shell 注释最容易被误当成标题）
export function extractHeadings(md) {
  const out = [];
  let inFence = null;
  for (const line of String(md || '').split('\n')) {
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      if (inFence === fence[1]) inFence = null;
      else if (!inFence) inFence = fence[1];
      continue;
    }
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const text = m[2].replace(/\[\[([^\]]+)\]\]/g, '$1')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]/g, '')
      .trim();
    if (!text) continue;
    out.push({ level: m[1].length, text, line: out.length });
  }
  return out;
}

// 标题文本 → 锚点 id（DOM 里给 h1..h6 打点时用；重名靠序号区分）
export function headingSlug(text, taken = new Set()) {
  let base = String(text || '').trim().toLowerCase()
    .replace(/[^\w一-鿿\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (!base) base = 'heading';
  let id = base; let i = 2;
  while (taken.has(id)) id = `${base}-${i++}`;
  taken.add(id);
  return id;
}
