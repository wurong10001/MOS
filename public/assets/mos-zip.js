/* mos-zip.js — 零依赖 ZIP 读取器（stored + deflate，浏览器/Node 通用）
 * deflate 通过 DecompressionStream('deflate-raw')（Chrome 80+/Safari 16.4+/Node 18+）
 */

const td = new TextDecoder();

function u16(dv, o) { return dv.getUint16(o, true); }
function u32(dv, o) { return dv.getUint32(o, true); }

export function sanitizeEntryName(name) {
  return String(name).replace(/\\/g, "/").split("/")
    .filter((s) => s && s !== "." && s !== "..").join("/");
}

export async function openZip(arrayBuffer) {
  const buf = arrayBuffer instanceof ArrayBuffer ? arrayBuffer
    : (arrayBuffer.buffer ? arrayBuffer.buffer.slice(arrayBuffer.byteOffset, arrayBuffer.byteOffset + arrayBuffer.byteLength) : arrayBuffer);
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // 倒扫 EOCD (PK\x05\x06)
  let eocd = -1;
  const min = Math.max(0, buf.byteLength - 66560);
  for (let i = buf.byteLength - 22; i >= min; i--) {
    if (u32(dv, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 zip 文件（未找到 EOCD）");
  const total = u16(dv, eocd + 10);
  let cdOff = u32(dv, eocd + 16);

  // zip64 EOCD locator（大文件兼容）
  if (cdOff === 0xffffffff) {
    // 简单回退：扫描 zip64 end of central directory
    for (let i = eocd - 20; i >= 0; i--) {
      if (u32(dv, i) === 0x06064b50) {
        const lo = dv.getBigUint64(i + 48, true);
        cdOff = Number(lo);
        break;
      }
    }
  }

  const entries = [];
  let p = cdOff;
  for (let n = 0; n < total; n++) {
    if (u32(dv, p) !== 0x02014b50) throw new Error("中央目录损坏 @0x" + p.toString(16));
    const method = u16(dv, p + 10);
    const compSize = u32(dv, p + 20);
    const uncompSize = u32(dv, p + 24);
    const nameLen = u16(dv, p + 28);
    const extraLen = u16(dv, p + 30);
    const cmtLen = u16(dv, p + 32);
    const localOff = u32(dv, p + 42);
    const name = td.decode(u8.subarray(p + 46, p + 46 + nameLen));
    entries.push({ name, method, size: uncompSize, compSize, localOff });
    p += 46 + nameLen + extraLen + cmtLen;
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== "function") throw new Error("环境缺少 DecompressionStream");
    const ds = new DecompressionStream("deflate-raw");
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    return out;
  }

  async function read(nameOrEntry) {
    const e = typeof nameOrEntry === "string"
      ? entries.find((x) => x.name === nameOrEntry) : nameOrEntry;
    if (!e) throw new Error("zip 条目不存在: " + nameOrEntry);
    // 定位 local header 数据起点（名字/extra 长度可能与中央目录不同）
    if (u32(dv, e.localOff) !== 0x04034b50) throw new Error("本地头损坏");
    const lnLen = u16(dv, e.localOff + 26);
    const leLen = u16(dv, e.localOff + 28);
    const start = e.localOff + 30 + lnLen + leLen;
    const raw = u8.subarray(start, start + e.compSize);
    if (e.method === 0) return raw.slice();
    if (e.method === 8) return await inflateRaw(raw);
    throw new Error("不支持的压缩方式 method=" + e.method + " (" + e.name + ")");
  }

  return { entries, read };
}
