// 零依赖 ZIP 打包器（写入 + 解压）：项目刻意不引入 archiver 等外部依赖，
// 与 fileTextService.js 的手写 unzip（inflateRawSync）互为镜像。
// 支持 DEFLATE 压缩（zlib.deflateRawSync）、UTF-8 文件名（标志位 0x0800）。
const zlib = require('zlib');

// CRC32 查表法（IEEE 802.3 多项式 0xedb88320）
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// JS Date → MS-DOS 日期时间（ZIP 规范，2 秒精度）
function dosDateTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

// entries: [{ name: '相对路径', data: Buffer|string, mtime?: Date }]
// 返回完整 ZIP 文件 Buffer。条目数 < 65535 且单文件 < 4GB（无需 Zip64）。
function buildZip(entries) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data));
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const comp = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0; // 8=DEFLATE 0=STORE
    const { time, date } = dosDateTime(e.mtime || new Date());
    const crc = crc32(data);
    const flags = 0x0800; // 文件名为 UTF-8（中文路径）

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 局部文件头签名
    local.writeUInt16LE(20, 4);         // 解压所需版本
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);         // extra 长度
    localChunks.push(local, nameBuf, comp);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);    // 中央目录头签名
    cd.writeUInt16LE(20, 4);            // 制作版本
    cd.writeUInt16LE(20, 6);            // 解压所需版本
    cd.writeUInt16LE(flags, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);            // extra
    cd.writeUInt16LE(0, 32);            // 注释
    cd.writeUInt16LE(0, 34);            // 起始磁盘号
    cd.writeUInt16LE(0, 36);            // 内部属性
    cd.writeUInt32LE(0, 38);            // 外部属性
    cd.writeUInt32LE(offset, 42);       // 本地头偏移
    centralChunks.push(cd, nameBuf);

    offset += 30 + nameBuf.length + comp.length;
  }
  const central = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // 目录结束记录
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localChunks, central, eocd]);
}

// 解压 ZIP：解析中央目录逐条读取（支持 STORE/DEFLATE），返回 [{name, data:Buffer}]。
// 供「应用升级包」使用——升级包由本系统 buildZip 生成，格式受控，
// 仍按标准 ZIP 解析以保持通用性。目录条目（名以 / 结尾）自动跳过。
function extractZip(buf) {
  // 从尾部向前找 EOCD（注释区最长 65535）
  let eocd = -1;
  const scanEnd = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= scanEnd; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('无效的 ZIP 文件（缺少结束记录）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) {
      throw new Error('无效的 ZIP 文件（中央目录损坏）');
    }
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    off += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    // 本地文件头：跳过头部取压缩数据
    if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`无效的 ZIP 文件（${name} 本地头损坏）`);
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.slice(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = Buffer.from(comp);
    else if (method === 8) data = zlib.inflateRawSync(comp);
    else throw new Error(`不支持的压缩方式（${name}，method=${method}）`);
    out.push({ name, data });
  }
  return out;
}

module.exports = { buildZip, extractZip };
