// 文件文字提取（内置实现，零第三方依赖）：
// - TXT/MD/CSV/JSON/HTML 等文本类：直接读 UTF-8
// - PDF：解析解压流中的文本对象（Tj/TJ），兼容多数常见 PDF
// - Word (.docx)：ZIP+XML，抽 <w:t> 文本（Word 2007+）
// - Excel (.xlsx)：ZIP+XML，抽共享字符串表 + 单元格值
// - 老 .doc/.xls 二进制：提取可见 ASCII/GBK 文本段（尽力而为）
const { inflateRawSync, inflateSync } = require('zlib');

// ---------- ZIP 解包（docx/xlsx 都是 zip 容器） ----------
// 读 Central Directory，返回 Map<name, Buffer>
function unzip(buf) {
  const files = new Map();
  // 定位 EOCD（End of Central Directory）
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP 结构无法识别');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    // 本地头再读一次文件数据偏移
    if (buf.readUInt32LE(localOff) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const comp = buf.subarray(dataStart, dataStart + compSize);
      let data;
      if (method === 0) data = Buffer.from(comp);
      else if (method === 8) data = inflateRawSync(comp);
      else data = Buffer.alloc(0);
      files.set(name, data);
    }
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return files;
}

const decodeXmlEnt = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));

// ---------- docx：document.xml 抽 <w:t>（按 <w:p> 换行） ----------
function docxText(buf) {
  const files = unzip(buf);
  const doc = files.get('word/document.xml');
  if (!doc) throw new Error('非标准 docx（无 word/document.xml）');
  const xml = doc.toString('utf8');
  const paras = xml.split(/<\/w:p>/).map((p) => {
    const ts = [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((m) => decodeXmlEnt(m[1]));
    return ts.join('');
  });
  return paras.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- xlsx：共享字符串 + sheet 单元格 ----------
function xlsxText(buf) {
  const files = unzip(buf);
  // 共享字符串表
  const sst = [];
  const sstXml = files.get('xl/sharedStrings.xml');
  if (sstXml) {
    const xml = sstXml.toString('utf8');
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const ts = [...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => decodeXmlEnt(t[1]));
      sst.push(ts.join(''));
    }
  }
  const sheets = [...files.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort();
  const out = [];
  for (const s of sheets) {
    const xml = files.get(s).toString('utf8');
    const rows = [];
    for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cm of rm[1].matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
        const attrs = cm[1];
        const inner = cm[2];
        const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
        const tm = inner.match(/<t>([\s\S]*?)<\/t>/);
        let val = tm ? decodeXmlEnt(tm[1]) : (vm ? vm[1] : '');
        if (/t="s"/.test(attrs) && vm) val = sst[Number(vm[1])] ?? '';
        cells.push(val);
      }
      if (cells.some((c) => c !== '')) rows.push(cells.join('\t'));
    }
    if (rows.length) out.push(rows.join('\n'));
  }
  return out.join('\n\n').trim();
}

// ---------- PDF：对象级解析 + 按字体的 ToUnicode CMap（支持中文 CID，1/2 字节） ----------
// 要点：① 每个字体资源（/TT2 8 0 R 等）有独立 ToUnicode 映射——按字体分组，不能全局合并
//          （合并会在字体子集间 CID 冲突时张冠李戴，产生错字）
//      ② codespacerange 有 1 字节（<00><FF>）和 2 字节（<0000><FFFF>）两种——按字体判断步长
//      ③ 内容流里跟踪 /TT2 12 Tf 字体切换，hex 字符串用当前字体的映射解码
//      ④ 只解析页面 /Contents 引用的内容流（跳过图片 XObject，避免无效解压卡死）
function pdfText(buf) {
  const text = buf.toString('latin1');
  const objRanges = [];
  for (const m of text.matchAll(/(\d+)\s+0\s+obj/g)) objRanges.push({ id: m[1], start: m.index });
  objRanges.sort((a, b) => a.start - b.start);
  for (let i = 0; i < objRanges.length; i++) {
    objRanges[i].end = i + 1 < objRanges.length ? objRanges[i + 1].start : text.length;
  }
  const objAt = (id) => objRanges.find((o) => o.id === id);

  function streamRangeIn(start, end) {
    const head = text.slice(start, Math.min(start + 3000, end));
    const sm = /stream\r?\n?/.exec(head);
    if (!sm) return null;
    const s = start + sm.index + sm[0].length;
    const e = text.indexOf('endstream', s);
    if (e < 0 || e > end) return null;
    return [s, e];
  }
  function inflateAt(s, e) {
    const raw = buf.subarray(s, e);
    try { return inflateSync(raw); } catch {}
    try { return inflateRawSync(raw); } catch {}
    return null;
  }
  // 解析一个 CMap → { step: 2|4, map: Map<cidHex, char> }
  // 注意：bfchar（<src> <dst> 两段）与 bfrange（<lo> <hi> <dst> 三段）必须在各自块内解析——
  // 全文盲目匹配三段时，相邻 bfchar 的 </dst> <src> 会被错配成一个 bfrange，映射全乱。
  function parseCmap(cs) {
    // codespacerange 决定 CID 字节数：<00><FF> → 1字节(step2) / <0000><FFFF> → 2字节(step4)
    let step = 4;
    const csm = /begincodespacerange\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/.exec(cs);
    if (csm && csm[1].length <= 2) step = 2;
    const map = new Map();
    // bfrange 块：<lo> <hi> <dstStart>（dst 逐 CID 递增；多为单点区间）
    for (const blk of cs.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const m of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
        if (m[1].length !== step || hi < lo || hi - lo > 65535) continue;
        const dst = parseInt(m[3].padStart(4, '0'), 16);
        for (let c = lo; c <= hi; c++) {
          const k = c.toString(16).padStart(step, '0').toUpperCase();
          if (!map.has(k)) map.set(k, String.fromCharCode(dst + (c - lo)));
        }
      }
    }
    // bfchar 块：<src> <dst>（dst 可多字符）
    for (const blk of cs.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const m of blk[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const src = m[1].toUpperCase();
        if (src.length !== step || map.has(src)) continue;
        const dst = m[2];
        let ch = '';
        for (let i = 0; i < dst.length; i += 4) ch += String.fromCharCode(parseInt(dst.slice(i, i + 4).padStart(4, '0'), 16));
        map.set(src, ch);
      }
    }
    return { step, map };
  }

  // ① 字体名 → { step, map }（页面字体字典 /TT2 8 0 R + 字体对象 /ToUnicode N 0 R）
  const fontMaps = new Map(); // 字体名(TT2/F1/...) → CMap
  const fontNameToObj = new Map();
  for (const m of text.matchAll(/\/(TT\d+|F\d+|C2_\d+|C\d+\.\d+)\s+(\d+)\s+0\s+R/g)) {
    if (!fontNameToObj.has(m[1])) fontNameToObj.set(m[1], m[2]);
  }
  for (const [name, objId] of fontNameToObj) {
    const o = objAt(objId);
    if (!o) continue;
    const dict = text.slice(o.start, Math.min(o.start + 3000, o.end));
    const tu = /\/ToUnicode\s+(\d+)\s+0\s+R/.exec(dict);
    if (!tu) continue;
    const to = objAt(tu[1]);
    if (!to) continue;
    const r = streamRangeIn(to.start, to.end);
    if (!r) continue;
    const cmap = inflateAt(r[0], r[1]);
    if (!cmap) continue;
    const parsed = parseCmap(cmap.toString('latin1'));
    if (parsed.map.size) fontMaps.set(name, parsed);
  }

  // ②/③ 内容流提取（跟踪 Tf 字体切换；CID 字体下括号字面量字节同样按 CID 解码）
  function extractCs(cs) {
    let out = '';
    let cur = null; // 当前字体 { step, map }
    const re = /\/(TT\d+|F\d+|C2_\d+|C\d+\.\d+)\s+[\d.]+\s+Tf|(<[0-9A-Fa-f\s]+>|\((?:\\.|[^\\()])*\))\s*Tj|(\[(?:[^\]]|\\.)*\])\s*TJ/g;
    let m;
    const dec = (s) => {
      if (s[0] === '<') {
        if (!cur) return '';
        const hex = s.slice(1, -1).replace(/\s+/g, '');
        let r = '';
        for (let i = 0; i + cur.step <= hex.length; i += cur.step) {
          r += cur.map.get(hex.slice(i, i + cur.step).toUpperCase()) || '';
        }
        return r;
      }
      // 括号字面量：当前字体有 CID 映射时按字节查（PPT/WPS 导出的 PDF 常见形态），
      // 查不出内容（非 CID 字体）才当普通字面量
      const inner = s.slice(1, -1);
      if (cur) {
        let bytes = '';
        for (const ch of inner) bytes += ch.charCodeAt(0).toString(16).padStart(2, '0');
        let r = '';
        for (let i = 0; i + cur.step <= bytes.length; i += cur.step) {
          r += cur.map.get(bytes.slice(i, i + cur.step).toUpperCase()) || '';
        }
        if (r) return r;
      }
      return inner.replace(/\\([0-7]{1,3})/g, ' ').replace(/\\([nrtbf])/g, ' ').replace(/\\(.)/g, '$1');
    };
    while ((m = re.exec(cs))) {
      if (m[1]) { cur = fontMaps.get(m[1]) || null; continue; }
      if (m[2]) out += dec(m[2]);
      else if (m[3]) for (const pm of m[3].matchAll(/(<[0-9A-Fa-f\s]+>|\((?:\\.|[^\\()])*\))/g)) out += dec(pm[1]);
    }
    return out;
  }

  const contentRefs = [];
  for (const m of text.matchAll(/\/Contents\s+(\d+)\s+0\s+R/g)) contentRefs.push(m[1]);
  let total = '';
  for (const id of contentRefs) {
    const o = objAt(id);
    if (!o) continue;
    const r = streamRangeIn(o.start, o.end);
    if (!r) continue;
    const inf = inflateAt(r[0], r[1]);
    if (!inf) continue;
    const cs = inf.toString('latin1');
    if (!/(Tj|TJ)/.test(cs)) continue;
    total += extractCs(cs) + '\n';
  }

  // 可读性过滤：全不可读（扫描件/纯图片 PDF）时返回空，交给上层走 AI 兜底
  const readable = total.replace(/[^\x20-\x7e一-鿿＀-￯　-〿\n]/g, '');
  if (total.length && readable.length / total.length < 0.5) return '';
  return total.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- 老式 .doc/.xls：二进制抽可打印段（尽力而为） ----------
function binaryText(buf) {
  const out = [];
  let run = '';
  const pushRun = () => {
    const t = run.trim();
    if (t.length >= 4) out.push(t);
    run = '';
  };
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    // ASCII 可打印 或 GBK 高位字节成对出现（粗略保留中文）
    if ((b >= 0x20 && b <= 0x7e)) run += String.fromCharCode(b);
    else if (b >= 0xa1 && i + 1 < buf.length && buf[i + 1] >= 0xa1) {
      // GBK 双字节 → 尝试整 buf GBK 段落交给 iconv 不现实，Node 无内建 GBK；
      // 用 Buffer+latin1 保留占位（中文场景 doc 老格式少见，尽力而为）
      run += ' '; i++;
    } else pushRun();
  }
  pushRun();
  return out.join('\n').slice(0, 20000);
}

// 主入口：按文件类型提取文字，返回 { text, engine }
function extractText(filename, mimetype, buffer) {
  const name = String(filename || '').toLowerCase();
  try {
    if (/\.(txt|md|csv|log|json|xml|html?|js|css|ini|yml|yaml|py|java|sql|sh|bat)$/.test(name)
      || (mimetype || '').startsWith('text/')) {
      let t = buffer.toString('utf8');
      // 去 BOM
      if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
      return { text: t.slice(0, 50000), engine: 'plain' };
    }
    if (name.endsWith('.pdf') || mimetype === 'application/pdf') {
      return { text: pdfText(buffer).slice(0, 50000), engine: 'pdf' };
    }
    if (name.endsWith('.docx')) {
      return { text: docxText(buffer).slice(0, 50000), engine: 'docx' };
    }
    if (name.endsWith('.xlsx')) {
      return { text: xlsxText(buffer).slice(0, 50000), engine: 'xlsx' };
    }
    if (name.endsWith('.doc') || name.endsWith('.xls')) {
      return { text: binaryText(buffer), engine: 'legacy-binary' };
    }
    return { text: '', engine: 'unsupported' };
  } catch (e) {
    return { text: '', engine: 'error: ' + e.message };
  }
}

module.exports = { extractText, unzip };
