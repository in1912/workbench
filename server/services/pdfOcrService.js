// PDF AI 识读（图片型 PDF）：直接抽取 PDF 内嵌的 JPEG 图片对象（DCTDecode），
// 交给视觉 LLM 识别文字。无需渲染引擎——扫描件/图片型 PDF 每页就是一张 JPEG。
// 注意：headless Chromium 不渲染 PDF 查看器（实测无 embed 元素），渲染方案不可行；
// 内嵌图抽取是零依赖、毫秒级的路径。Flate 压缩的图片流（PNG/Flate）不支持，跳过。
const aiService = require('./aiService');

// 从 PDF buffer 抽取内嵌 JPEG（dataURL 数组，按文档顺序，最多 maxPages 张）
function extractPdfJpegs(buf, { maxPages = 4 } = {}) {
  const text = buf.toString('latin1');
  const imgs = [];
  let pos = 0;
  while (imgs.length < maxPages) {
    const i = text.indexOf('/DCTDecode', pos);
    if (i < 0) break;
    pos = i + 10;
    // 同一词典内向后找 stream 边界（500 字符内足够）
    const near = text.slice(i, i + 600);
    const sm = near.match(/stream\r?\n?/);
    if (!sm) continue;
    const start = i + near.indexOf(sm[0]) + sm[0].length;
    const end = text.indexOf('endstream', start);
    if (end < 0) break;
    const jpg = buf.subarray(start, end);
    // JPEG 魔数校验（FFD8...），剥掉可能的尾部空白
    if (jpg.length > 1000 && jpg[0] === 0xFF && jpg[1] === 0xD8) {
      let e = jpg.length;
      while (e > 2 && (jpg[e - 1] === 0x0A || jpg[e - 1] === 0x0D || jpg[e - 1] === 0x20)) e--;
      const clean = jpg.subarray(0, e);
      if (clean[clean.length - 2] === 0xFF && clean[clean.length - 1] === 0xD9) {
        imgs.push('data:image/jpeg;base64,' + clean.toString('base64'));
      } else {
        // 无结束符也接受（有些生成器不写 FFD9）
        imgs.push('data:image/jpeg;base64,' + clean.toString('base64'));
      }
    }
  }
  return imgs;
}

// 主入口：AI 识读图片型 PDF（内嵌 JPEG 抽取 + 视觉 LLM）
async function ocrPdf(pdfBuffer, { maxPages = 4, tdb = null } = {}) {
  const imgs = extractPdfJpegs(pdfBuffer, { maxPages });
  if (!imgs.length) {
    throw new Error('PDF 内无 JPEG 图片对象（可能是 Flate 压缩图片或其他格式），暂不支持自动识读');
  }
  const text = await aiService.ocrImages(imgs, { hint: `这是 PDF 文档的前 ${imgs.length} 页图片。`, tdb });
  return { pages: imgs.length, text };
}

module.exports = { extractPdfJpegs, ocrPdf };
