// Minimal ZIP writer/reader for the annual archive (no dependency).
// Writer: STORE only (the payload is already-compressed PDFs/images plus
// small CSV/JSON), UTF-8 names, no ZIP64 — so at most 65,535 entries and
// 4 GiB, which the caller checks. Reader: STORE and DEFLATE (via the
// browser's DecompressionStream) for earlier archives, with hard size caps.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const ZIP_MAX_ENTRIES = 65535;
export const ZIP_MAX_BYTES = 0xffffffff - 1_000_000;

export interface ZipInput {
  path: string;
  data: Uint8Array;
}

function dosTime(d: Date): [number, number] {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return [time, date];
}

/** Builds a STORE zip. Throws when the archive would need ZIP64. */
export function buildZip(entries: ZipInput[], now = new Date()): Blob {
  if (entries.length > ZIP_MAX_ENTRIES) throw new Error("Too many files for one archive.");
  const enc = new TextEncoder();
  const [time, date] = dosTime(now);
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.path)) throw new Error(`Duplicate path in archive: ${e.path}`);
    seen.add(e.path);
    const name = enc.encode(e.path);
    const crc = crc32(e.data);
    const size = e.data.length;
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);
    central.push(cd);
    parts.push(local, e.data as BlobPart);
    offset += local.length + size;
    if (offset > ZIP_MAX_BYTES) throw new Error("The archive is larger than 4 GB. Split the export.");
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  return new Blob([...parts, ...(central as BlobPart[]), end], { type: "application/zip" });
}

export interface ZipEntry {
  path: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

/** Reads the central directory. Throws on anything that is not a plain zip. */
export async function readZipDirectory(zip: Blob, maxEntries = 200_000): Promise<ZipEntry[]> {
  const tailLen = Math.min(zip.size, 22 + 0xffff);
  const tail = await bytesOf(zip.slice(zip.size - tailLen));
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("This is not a ZIP file.");
  const ev = new DataView(tail.buffer, tail.byteOffset + eocd, 22);
  const count = ev.getUint16(10, true);
  const cdSize = ev.getUint32(12, true);
  const cdOffset = ev.getUint32(16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("Large (ZIP64) archives are not supported here.");
  if (count > maxEntries) throw new Error("This file has too many entries to be an HRMS archive.");
  if (cdOffset + cdSize > zip.size) throw new Error("The ZIP file is damaged.");
  const cd = await bytesOf(zip.slice(cdOffset, cdOffset + cdSize));
  const dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const dec = new TextDecoder();
  const out: ZipEntry[] = [];
  let p = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > cd.length || dv.getUint32(p, true) !== 0x02014b50) throw new Error("The ZIP file is damaged.");
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    out.push({
      method: dv.getUint16(p + 10, true),
      crc: dv.getUint32(p + 16, true),
      compressedSize: dv.getUint32(p + 20, true),
      size: dv.getUint32(p + 24, true),
      localOffset: dv.getUint32(p + 42, true),
      path: dec.decode(cd.subarray(p + 46, p + 46 + nameLen)),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function inflate(data: Uint8Array, limit: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new Error("This browser cannot read compressed archives.");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error("An archive entry is larger than declared.");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Extracts one entry, refusing to produce more than `limit` bytes. */
export async function readZipEntry(zip: Blob, e: ZipEntry, limit = e.size): Promise<Uint8Array> {
  if (e.size > limit) throw new Error("An archive entry is larger than allowed.");
  const head = await bytesOf(zip.slice(e.localOffset, e.localOffset + 30));
  const hv = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (head.length < 30 || hv.getUint32(0, true) !== 0x04034b50) throw new Error("The ZIP file is damaged.");
  const start = e.localOffset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
  const raw = await bytesOf(zip.slice(start, start + e.compressedSize));
  if (raw.length !== e.compressedSize) throw new Error("The ZIP file is damaged.");
  let data: Uint8Array;
  if (e.method === 0) data = raw;
  else if (e.method === 8) data = await inflate(raw, limit);
  else throw new Error("The archive uses an unsupported compression method.");
  if (data.length !== e.size || crc32(data) !== e.crc) throw new Error(`An archive entry failed its check: ${e.path}`);
  return data;
}
