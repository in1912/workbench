// HTML → Markdown 转换器（v1.11.6，笔记编辑器「粘贴富文本」用）。
//
// 为什么自研不用 turndown：项目纪律不轻易引新依赖（v1.9.41 起只进过 d3-force），
// 而粘贴文章的 HTML 形态有限（标题/段落/加粗斜体/链接/列表/引用/代码块/表格/图片），
// DOMParser 走查 200 行内能覆盖；转换不了的标签一律当透明容器拆开，正文文字不会丢。
//
// 用法：const md = await htmlToMarkdown(html, { resolveImage })
//   resolveImage: async ({src, alt}) => 最终图片地址（返回 null/抛错 = 保留原 src）。
//   图片在上传前先替换 src 再转换，正文里不会出现 data: 大串。
//   注意：CodeMirror 自己复制的剪贴板里也有 text/html（语法高亮的 span），调用方要先
//   排除（htmlToMarkdown 不认），否则内部复制粘贴会被 round-trip 改写。
const SKIP = new Set(['script', 'style', 'noscript', 'template', 'head', 'meta', 'title',
  'link', 'svg', 'math', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'select', 'textarea']);
const BLOCK_TAGS = new Set(['p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'main',
  'nav', 'figure', 'figcaption', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'blockquote',
  'pre', 'table', 'hr', 'dl', 'dt', 'dd', 'address', 'details', 'summary', 'fieldset']);

const collapseWs = (s) => String(s ?? '').replace(/[ \t\r\n]+/g, ' ');
const wrapMark = (mark, t) => {
  const lead = (t.match(/^\s*/) || [''])[0], trail = (t.match(/\s*$/) || [''])[0];
  const core = t.trim();
  return core ? lead + mark + core + mark + trail : t;
};
const cleanAlt = (s) => collapseWs(s).replace(/[[\]\n]/g, ' ').trim();

// ---------- 内联（返回一段可能含 \n（来自 <br>）的 markdown 文本） ----------
function inlineOf(node) {
  if (node.nodeType === 3) return collapseWs(node.nodeValue || '');
  if (node.nodeType !== 1) return '';
  const tag = node.tagName.toLowerCase();
  if (SKIP.has(tag)) return '';
  const kids = () => [...node.childNodes].map(inlineOf).join('');
  switch (tag) {
    case 'br': return '\n';
    case 'strong': case 'b': return wrapMark('**', kids());
    case 'em': case 'i': case 'cite': case 'var': return wrapMark('*', kids());
    case 's': case 'del': case 'strike': return wrapMark('~~', kids());
    case 'code': {
      const t = collapseWs(node.textContent || '');
      return t ? '`' + t.replace(/`/g, '’') + '`' : '';
    }
    case 'a': {
      const t = kids().replace(/\n/g, ' ').trim();
      const href = String(node.getAttribute('href') || '').trim();
      if (!t) return '';
      if (!href || /^javascript:/i.test(href)) return t;
      return `[${t.replace(/[[\]]/g, ' ')}](${href})`;
    }
    case 'img': {
      const src = String(node.getAttribute('src') || '').trim();
      if (!src) return '';
      return `![${cleanAlt(node.getAttribute('alt'))}](${src})`;
    }
    default: return kids();
  }
}

// ---------- 块级（返回若干段 markdown 字符串，外层用 \n\n 连接） ----------
function childBlocks(el) {
  const blocks = [];
  let buf = '';
  const flush = () => {
    // <br> 产生的软换行转 GFM 硬换行（行尾两空格），不然 marked 会把它并成一行
    const t = buf.replace(/[ \t]*\n[ \t]*/g, '  \n').replace(/[ \t]+/g, ' ').trim();
    if (t) blocks.push(t);
    buf = '';
  };
  for (const ch of el.childNodes) {
    if (ch.nodeType === 3) { buf += collapseWs(ch.nodeValue || ''); continue; }
    if (ch.nodeType !== 1) continue;
    const tag = ch.tagName.toLowerCase();
    if (SKIP.has(tag)) continue;
    if (tag === 'br') { buf += '\n'; continue; }
    if (BLOCK_TAGS.has(tag)) { flush(); blocks.push(...blockOf(ch)); continue; }
    buf += inlineOf(ch);
  }
  flush();
  return blocks;
}

function listLines(el, indent) {
  const ordered = el.tagName.toLowerCase() === 'ol';
  const out = [];
  let i = 0;
  for (const li of el.children) {
    if (!li.tagName || li.tagName.toLowerCase() !== 'li') continue;
    i++;
    const marker = ordered ? `${i}. ` : '- ';
    const sub = [];
    const inlineBuf = [];
    for (const ch of li.childNodes) {
      const tag = ch.nodeType === 1 && ch.tagName ? ch.tagName.toLowerCase() : '';
      if (tag && BLOCK_TAGS.has(tag)) sub.push(...blockOf(ch));
      else if (ch.nodeType === 1 && SKIP.has(tag)) continue;
      else inlineBuf.push(inlineOf(ch));
    }
    const text = inlineBuf.join('').replace(/[ \t]+/g, ' ').trim();
    const cont = indent + ' '.repeat(marker.length);
    out.push(indent + marker + text.split('\n').map((l) => l.trim()).filter(Boolean).join('\n' + cont));
    for (const b of sub) out.push(...b.split('\n').map((l) => cont + l));
  }
  return out;
}

function tableBlock(el) {
  const rows = [...el.querySelectorAll('tr')].map((tr) =>
    [...tr.children].map((c) => collapseWs(inlineOf(c)).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim() || ' '));
  if (!rows.length) return [];
  const width = Math.max(...rows.map((r) => r.length));
  for (const r of rows) while (r.length < width) r.push(' ');
  const line = (cells) => `| ${cells.join(' | ')} |`;
  return [line(rows[0]), line(Array(width).fill('---')), ...rows.slice(1).map(line)];
}

function blockOf(el) {
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': {
      const t = inlineOf(el).replace(/\n/g, ' ').trim();
      return t ? ['#'.repeat(Number(tag[1])) + ' ' + t] : [];
    }
    case 'hr': return ['---'];
    case 'pre': {
      const codeEl = el.querySelector('code');
      const m = codeEl ? (codeEl.className || '').match(/(?:language|lang)-([\w+#.-]+)/) : null;
      const lang = m ? m[1] : '';
      const text = (el.textContent || '').replace(/\n+$/, '');
      return text ? ['```' + lang + '\n' + text + '\n```'] : [];
    }
    case 'blockquote':
      return childBlocks(el).flatMap((b) => b.split('\n').map((l) => '> ' + l));
    case 'ul': case 'ol':
      return [listLines(el, '').join('\n')];
    case 'table':
      return tableBlock(el);
    case 'figcaption': {
      const t = inlineOf(el).replace(/\n/g, ' ').trim();
      return t ? ['*' + t + '*'] : [];
    }
    default:
      return childBlocks(el);
  }
}

/**
 * 把富文本 HTML 转成 Markdown。
 * @param {string} html 剪贴板里的 text/html
 * @param {{resolveImage?: (info:{src:string,alt:string})=>Promise<string|null>}} [opts]
 *   resolveImage 给图片找最终地址（上传 / 服务端代取）；null/抛错 = 原样保留。
 * @returns {Promise<string>} markdown 正文（两侧已 trim，多余空行已压平）
 */
export async function htmlToMarkdown(html, opts = {}) {
  const resolveImage = typeof opts.resolveImage === 'function' ? opts.resolveImage : null;
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const imgs = [...doc.body.querySelectorAll('img')];
  if (imgs.length) {
    // 先把图片地址都定下来（并行），失败的保留原 src，不让一张坏图卡住整篇粘贴
    await Promise.all(imgs.map((im) => {
      const src = String(im.getAttribute('src') || '').trim();
      const alt = im.getAttribute('alt') || '';
      if (!src) return Promise.resolve();
      return Promise.resolve(resolveImage({ src, alt }))
        .catch(() => null)
        .then((final) => { if (final) im.setAttribute('src', final); });
    }));
  }
  return childBlocks(doc.body).join('\n\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim();
}
