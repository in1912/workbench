// 浏览器端极简 ZIP 解包（xlsx 用）：读 Central Directory 取 entry，inflateRaw 解压
// 使用 DecompressionStream('deflate-raw')（现代浏览器均支持）
export function unzip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  // 定位 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('非有效 ZIP/xlsx 文件');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const cmtLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = new TextDecoder('utf-8').decode(buf.subarray(off + 46, off + 46 + nameLen));
    entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  const files = new Map();
  for (const e of entries) {
    if (dv.getUint32(e.localOff, true) !== 0x04034b50) continue;
    const lNameLen = dv.getUint16(e.localOff + 26, true);
    const lExtraLen = dv.getUint16(e.localOff + 28, true);
    const dataStart = e.localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + e.compSize);
    if (e.method === 0) {
      files.set(e.name, new Uint8Array(comp));
    } else if (e.method === 8) {
      files.set(e.name, inflateRaw(comp));
    }
  }
  return files;
}

// inflateRaw via DecompressionStream（同步接口不可能，这里做同步近似：
// DecompressionStream 是异步的——但训练入口是 async 函数，改 async 版本）
// 实际导出：async unzipAsync；Pay.vue 里调用需 await。为兼容已有同步用法，提供 promise 通路：
async function inflateRawAsync(comp) {
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([comp]).stream().pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

export async function unzipAsync(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('非有效 ZIP/xlsx 文件');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const cmtLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = new TextDecoder('utf-8').decode(buf.subarray(off + 46, off + 46 + nameLen));
    entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  const files = new Map();
  for (const e of entries) {
    if (dv.getUint32(e.localOff, true) !== 0x04034b50) continue;
    const lNameLen = dv.getUint16(e.localOff + 26, true);
    const lExtraLen = dv.getUint16(e.localOff + 28, true);
    const dataStart = e.localOff + 30 + lNameLen + lExtraLen;
    const comp = buf.subarray(dataStart, dataStart + e.compSize);
    if (e.method === 0) files.set(e.name, new Uint8Array(comp));
    else files.set(e.name, await inflateRawAsync(comp));
  }
  return files;
}
