// 本地烧录工具包 —— 纯函数守卫测试（不需要服务、不需要硬件）
//
// 覆盖三件在真机上踩过、且**静默失败**的事：
//   ① 启动脚本编码：serve.ps1 必须带 UTF-8 BOM（PowerShell 5.1 读无 BOM 的 UTF-8 会按 ANSI 解码，
//      中文被拆散后脚本不报错、只是把后面几行当文本打出来——看着像启动了，其实一行没跑）。
//      启动烧录.cmd 相反：必须无 BOM、含 chcp 65001、全 CRLF。
//   ② 定长占位符替换：等长、补 \0、超长必须抛（宁可报错也不能写出半截地址的固件）。
//   ③ app 镜像尾部 SHA-256 重算：改过字节必须重算，否则二级 bootloader 校验不过、板子不启动。
//
// 用法：node scripts/test-flashtool-guards.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const svc = require('../server/services/flashToolService.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`PASS  ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? '  ' + detail : ''}`); }
};

// ---------- ① 启动脚本编码 ----------
const real = svc.launcherHealth();
ok('真实 serve.ps1 / 启动烧录.cmd 体检通过', real.ok, real.problems.join('；'));

// 造一份坏样本，证明守卫真的会亮红灯（不会失败的守卫等于没有）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-flashguard-'));
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const cp = (name, buf) => fs.writeFileSync(path.join(tmp, name), buf);

cp('serve.ps1', Buffer.from("# 无 BOM 的 PowerShell\nWrite-Host '中文'\n", 'utf8'));
cp('启动烧录.cmd', Buffer.from('@echo off\r\nchcp 65001 >nul\r\n', 'utf8'));
let h = svc.launcherHealth(tmp);
ok('serve.ps1 无 BOM → 报错', !h.ok && h.problems.some((p) => p.includes('BOM')), h.problems.join('；'));

cp('serve.ps1', Buffer.concat([BOM, Buffer.from("# 带 BOM\n", 'utf8')]));
cp('启动烧录.cmd', Buffer.concat([BOM, Buffer.from('@echo off\r\nchcp 65001 >nul\r\n', 'utf8')]));
h = svc.launcherHealth(tmp);
ok('.cmd 带 BOM → 报错', !h.ok && h.problems.some((p) => p.includes('不该带 BOM')), h.problems.join('；'));

cp('启动烧录.cmd', Buffer.from('@echo off\r\nWrite-Host 中文\r\n', 'utf8'));
h = svc.launcherHealth(tmp);
ok('.cmd 缺 chcp 65001 → 报错', !h.ok && h.problems.some((p) => p.includes('chcp')), h.problems.join('；'));

cp('启动烧录.cmd', Buffer.from('@echo off\nchcp 65001 >nul\n', 'utf8'));
h = svc.launcherHealth(tmp);
ok('.cmd 裸 LF 行尾 → 报错', !h.ok && h.problems.some((p) => p.includes('LF')), h.problems.join('；'));

cp('启动烧录.cmd', Buffer.from('@echo off\r\nchcp 65001 >nul\r\necho 好\r\n', 'utf8'));
h = svc.launcherHealth(tmp);
ok('样本改好 → 重新通过（非恒假）', h.ok, h.problems.join('；'));
fs.rmSync(tmp, { recursive: true, force: true });

// ---------- ② 定长占位符替换 ----------
const { URL_PLACEHOLDER, KEY_PLACEHOLDER } = svc;
ok('URL 占位符 = 96 字节', URL_PLACEHOLDER.length === 96, `${URL_PLACEHOLDER.length}`);
ok('KEY 占位符 = 64 字节', KEY_PLACEHOLDER.length === 64, `${KEY_PLACEHOLDER.length}`);

// 用一段假镜像验证 patchXiaozhiApp：长度不变、值写得进、其余字节不动、超长必抛
const fake = Buffer.concat([
  Buffer.from('HEAD', 'latin1'), URL_PLACEHOLDER, Buffer.from('MID', 'latin1'), KEY_PLACEHOLDER,
  Buffer.from('TAIL', 'latin1'), Buffer.alloc(32, 0xaa),   // 末尾 32 字节当作旧的校验值
]);
const url = 'http://192.168.1.9:7778/api/xiaozhi/bridge';
const patched = svc.patchXiaozhiApp(fake, { url, key: 'a'.repeat(32) });
ok('替换后长度不变', patched.buf.length === fake.length, `${patched.buf.length}`);
ok('URL 命中', patched.info.urlFound && patched.info.keyFound);
ok('URL 内容可读回', patched.buf.includes(Buffer.from(url, 'utf8')));
ok('占位符已消失', !patched.buf.includes(URL_PLACEHOLDER) && !patched.buf.includes(KEY_PLACEHOLDER));
ok('头部/中部/尾部未被波及', patched.buf.slice(0, 4).toString() === 'HEAD' && patched.buf.slice(fake.length - 32 - 4, fake.length - 32).toString() === 'TAIL');
ok('超长地址必须抛（不写出半截固件）', (() => {
  try { svc.patchXiaozhiApp(fake, { url: 'x'.repeat(97), key: '' }); return false; } catch { return true; }
})());
ok('占位符不在时如实汇报 found=false', (() => {
  const r = svc.patchXiaozhiApp(Buffer.from('nothing here', 'latin1'), { url, key: 'k' });
  return !r.info.urlFound && !r.info.keyFound && !r.info.patched;
})());

// ---------- ③ 尾部 SHA-256 重算 ----------
const img = Buffer.concat([Buffer.from('img-body-'.repeat(10), 'latin1'), Buffer.alloc(32, 0xaa)]);
const re = svc.rehashAppImage(img);
const want = crypto.createHash('sha256').update(img.subarray(0, img.length - 32)).digest();
ok('重算值 == SHA256(镜像[:-32])', re.subarray(re.length - 32).equals(want));
ok('只动末尾 32 字节', re.subarray(0, re.length - 32).equals(img.subarray(0, img.length - 32)));
ok('重算前后确实不同（有效功）', !re.subarray(re.length - 32).equals(img.subarray(img.length - 32)));

// ---------- ④ 回连地址推导 ----------
// 这是「烧进去的地址板子到底连不连得上」的唯一决定点，两种入口不能混：
//   直连端口 → 原样用请求 Host；飞牛桌面（网关）→ 必须换成本应用端口（网关要求 NAS 登录态，
//   板子的裸 HTTP 过不去），否则固件里的地址是个死链，表现为「烧完板子连不回来」。
const reqDirect = { headers: { host: '192.168.1.50:7778' } };
const reqGateway = { headers: { host: '192.168.1.50:5666' }, viaGateway: true };
ok('直连端口进来：原样用 Host', svc.defaultBridgeBase(reqDirect) === 'http://192.168.1.50:7778', svc.defaultBridgeBase(reqDirect));
ok('网关进来：主机名保留、端口换成本应用端口',
  svc.defaultBridgeBase(reqGateway) === `http://192.168.1.50:${process.env.TRIM_SERVICE_PORT || process.env.PORT || 7778}`,
  svc.defaultBridgeBase(reqGateway));
ok('网关进来的地址不带 /app/ 前缀（网关路径板子进不去）', !svc.defaultBridgeBase(reqGateway).includes('/app/'));
ok('无 Host 头返回空（不瞎猜地址）', svc.defaultBridgeBase({ headers: {} }) === '');
ok('bridgeUrlFor 拼出完整的 /api/xiaozhi/bridge',
  svc.bridgeUrlFor(reqDirect) === 'http://192.168.1.50:7778/api/xiaozhi/bridge', svc.bridgeUrlFor(reqDirect));
// 拼出来的地址必须能塞进 96 字节占位符（域名单长、端口再多也在余量内；超长 patchFixed 会抛）
ok('典型桥接地址长度在 96 字节余量内', Buffer.byteLength(svc.bridgeUrlFor(reqDirect)) < 96, `${Buffer.byteLength(svc.bridgeUrlFor(reqDirect))}`);

console.log(`\n${fail === 0 ? '全绿' : '有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
