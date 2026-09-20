// 邮件附件解析器全矩阵测试（离线，不起服务不连 IMAP）
// 用法：node scripts/test-email-att-parse.mjs
// 覆盖：真实生产发票邮件 / 普通 filename / RFC2047 / RFC2231 扩展值·分段·分段扩展 /
//       无 name 的 application/pdf / 引号含分号 / name-only / qp 附件 / 正文不误判 / 内嵌图片跳过
// 注意：构造数据必须全 ASCII（或预编码）——真实邮件非 ASCII 都经 base64/qp/RFC2047 传输，
//       Buffer.from(str,'latin1') 会把裸中文变 '?'，测试数据写裸中文是测试自身的 bug。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'tmp-email-parse');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
const es = await import('../server/services/emailService.js');

let pass = 0, fail = 0;
const ck = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  <<< ' + extra}`);
};

// 构造 multipart 邮件：每个部件补齐尾随 CRLF，保证边界独占一行
function mk(parts, { subtype = 'mixed' } = {}) {
  const b = 'bnd_' + Math.random().toString(36).slice(2, 10);
  const segs = parts.map((p) => '--' + b + '\r\n' + p.replace(/\r?\n$/, '') + '\r\n').join('');
  return Buffer.from(
    'Content-Type: multipart/' + subtype + ';\r\n\tboundary="' + b + '"\r\n\r\n' + segs + '--' + b + '--\r\n',
    'latin1'
  );
}
const b64 = (s) => Buffer.from(s, 'latin1').toString('base64').replace(/(.{76})/g, '$1\r\n');

// 0. 真实生产邮件（浙江通行费电子发票，RFC2231 分段 + 段值混 RFC2047，v1.2.5 前解析为空）
{
  const f = 'data/tmp-mail-source-8054.eml';
  if (fs.existsSync(f)) {
    const src = fs.readFileSync(f);
    const atts = es.extractAttachmentsFromSource(src);
    ck('真实发票邮件：解析出 1 个附件', atts.length === 1, JSON.stringify(atts.map((a) => a.filename)));
    ck('文件名正确解码（RFC2231分段+RFC2047）', atts[0]?.filename === '浙BG85U0[蓝]+202609051306+60.00元.zip', atts[0]?.filename);
    ck('ZIP 完整（PK 魔数 + 大小）', atts[0]?.buf.slice(0, 4).toString('hex') === '504b0304' && atts[0].buf.length > 300000, String(atts[0]?.buf.length));
    const body = es.extractBodyFromSource(src);
    ck('正文干净（非 ZIP 乱码）', body.length > 50 && body.length < 2000 && !body.includes('PK'), `len=${body.length}`);
  } else console.log('  （真实 .eml 不存在，跳过固化用例）');
}

// 1. 普通 filename="report.pdf"（base64）
{
  const src = mk([
    'Content-Type: text/plain; charset=utf-8\r\n\r\nplain body here',
    `Content-Type: application/pdf\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="report.pdf"\r\n\r\n${b64('%PDF-1.4 fake content')}`,
  ]);
  const atts = es.extractAttachmentsFromSource(src);
  const body = es.extractBodyFromSource(src);
  ck('普通 filename：1 附件', atts.length === 1, String(atts.length));
  ck('文件名 report.pdf', atts[0]?.filename === 'report.pdf', atts[0]?.filename);
  ck('正文来自 text/plain', body.includes('plain body here'), JSON.stringify(body.slice(0, 40)));
  ck('附件字节正确', atts[0]?.buf.toString('latin1') === '%PDF-1.4 fake content', atts[0]?.buf?.toString('latin1'));
}

// 2. RFC2047 B 编码文件名（UTF-8）
{
  const enc = '=?UTF-8?B?' + Buffer.from('测试发票.pdf', 'utf8').toString('base64') + '?=';
  const src = mk([
    'Content-Type: text/plain; charset=utf-8\r\n\r\nbody',
    `Content-Type: application/octet-stream\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${enc}"\r\n\r\n${b64('XYZ')}`,
  ]);
  const atts = es.extractAttachmentsFromSource(src);
  ck('RFC2047 B 编码文件名解码', atts[0]?.filename === '测试发票.pdf', atts[0]?.filename);
}

// 3. RFC2231 扩展值 filename*=UTF-8''%E6%B5%8B%E8%AF%95.pdf
{
  const src = mk([
    'Content-Type: text/plain; charset=utf-8\r\n\r\nbody',
    `Content-Type: application/pdf\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment;\r\n\tfilename*=UTF-8''%E6%B5%8B%E8%AF%95.pdf\r\n\r\n${b64('PDF')}`,
  ]);
  const atts = es.extractAttachmentsFromSource(src);
  ck('RFC2231 扩展值文件名', atts[0]?.filename === '测试.pdf', atts[0]?.filename);
}

// 4. RFC2231 分段扩展 filename*0*=UTF-8''%E6%B5%8B; filename*1*=%E8%AF%95.pdf
{
  const src = mk([
    'Content-Type: text/plain; charset=utf-8\r\n\r\nbody',
    `Content-Type: application/pdf\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment;\r\n\tfilename*0*=UTF-8''%E6%B5%8B; filename*1*=%E8%AF%95.pdf\r\n\r\n${b64('PDF')}`,
  ]);
  const atts = es.extractAttachmentsFromSource(src);
  ck('RFC2231 分段扩展拼接', atts[0]?.filename === '测试.pdf', atts[0]?.filename);
}

// 5. 无文件名的 application/pdf（发票 PDF 直发常见：只有 ct 没有 name/disposition）
{
  const src = mk([
    'Content-Type: text/html; charset=utf-8\r\n\r\n<p>fapiao content</p>',
    `Content-Type: application/pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64('%PDF-1.4')}`,
  ]);
  const atts = es.extractAttachmentsFromSource(src);
  ck('无 name 的 application/pdf：收为附件', atts.length === 1 && atts[0].buf.length > 0, String(atts.length));
  ck('兜底命名 attachment', atts[0]?.filename === 'attachment', atts[0]?.filename);
  const body = es.extractBodyFromSource(src);
  ck('PDF 不再灌进正文', body.includes('fapiao content') && !body.includes('%PDF'), JSON.stringify(body.slice(0, 40)));
}

// 6. 引号内含分号 filename="a;b.pdf"（旧正则 ([^;]+) 截断）
{
  const src = mk([
    'Content-Type: text/plain; charset=utf-8\r\n\r\nbody',
    `Content-Type: application/pdf\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="a;b.pdf"\r\n\r\n${b64('PDF')}`,
  ]);
  const atts = es.extractAttachmentsFromSource(src);
  ck('引号内分号完整保留', atts[0]?.filename === 'a;b.pdf', atts[0]?.filename);
}

// 7. Content-Type 只有 name=（无 Content-Disposition 头）
{
  const src = mk([
    'Content-Type: text/plain; charset=utf-8\r\n\r\nbody',
    `Content-Type: application/zip; name="pack.zip"\r\nContent-Transfer-Encoding: base64\r\n\r\n${b64('PK')}`,
  ]);
  const atts = es.extractAttachmentsFromSource(src);
  ck('name-only 兜底命中', atts[0]?.filename === 'pack.zip', atts[0]?.filename);
}

// 8. quoted-printable 附件
{
  const src = mk([
    'Content-Type: text/plain; charset=utf-8\r\n\r\nbody',
    'Content-Type: text/plain\r\nContent-Transfer-Encoding: quoted-printable\r\nContent-Disposition: attachment; filename="notes.txt"\r\n\r\n=E6=B5=8B=E8=AF=95=0Aline2',
  ]);
  const atts = es.extractAttachmentsFromSource(src);
  ck('qp 附件解码', atts.length === 1 && atts[0].buf.toString('utf8') === '测试\nline2', atts[0]?.buf?.toString('utf8'));
}

// 9. 正文部件绝不误判为附件（multipart/alternative: plain + html）
{
  const src = mk([
    'Content-Type: text/plain; charset=utf-8\r\n\r\nplain text wins',
    'Content-Type: text/html; charset=utf-8\r\n\r\n<p>html alt</p>',
  ], { subtype: 'alternative' });
  const atts = es.extractAttachmentsFromSource(src);
  const body = es.extractBodyFromSource(src);
  ck('正文部件 0 附件', atts.length === 0, JSON.stringify(atts.length));
  ck('plain 优先正文', body.includes('plain text wins'), JSON.stringify(body.slice(0, 40)));
}

// 10. 无文件名内嵌图片（inline 无 filename）→ 不进附件也不进正文
{
  const src = mk([
    'Content-Type: text/html; charset=utf-8\r\n\r\n<p>hello <img src="cid:1"></p>',
    'Content-Type: image/png\r\nContent-Transfer-Encoding: base64\r\nContent-ID: <1>\r\n\r\n' + b64('iVBORw0KGgo='),
  ], { subtype: 'related' });
  const atts = es.extractAttachmentsFromSource(src);
  const body = es.extractBodyFromSource(src);
  ck('无文件名内嵌图片：0 附件', atts.length === 0, String(atts.length));
  ck('图片二进制不进正文', body.includes('hello') && body.length < 200, `len=${body.length}`);
}

// 11. GBK RFC2047 Q 编码（本 Node 无 full-icu，gbk 解码抛错→降级 utf8 不崩溃，后缀保留）
{
  // '账单' 的 GBK 字节 = D5 CB B5 A5（硬编码，勿依赖运行时 gbk 支持）
  const q = '=?gb2312?Q?=D5=CB=B5=A5.zip?=';
  const src = mk([
    'Content-Type: text/plain; charset=utf-8\r\n\r\nbody',
    `Content-Type: application/zip\r\nContent-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${q}"\r\n\r\n${b64('PK')}`,
  ]);
  const atts = es.extractAttachmentsFromSource(src);
  ck('GBK Q 编码：降级不崩溃且后缀保留', atts.length === 1 && /\.zip$/.test(atts[0]?.filename || ''), atts[0]?.filename);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
