// export/zip.js: a tiny store-only ZIP writer (no compression, no dependencies). Pure.
//
// Contract
//   crc32(bytes: Uint8Array) -> unsigned 32-bit integer (the ZIP/PNG CRC-32, poly 0xEDB88320)
//   zipStore(files: [{ path, text } | { path, bytes }], { date = new Date(2026, 0, 1) }) -> Uint8Array
//     Paths are UTF-8 (general-purpose flag bit 11 set), '/'-separated, no leading '/', no '..'.
//     Method 0 (stored), so every entry is byte-identical to its input and any unzip can read it.
//   readZip(bytes) -> [{ path, bytes, crcOk }]   reads back what zipStore wrote (tests, browser page)
// Failure behaviour: a bad path (empty, absolute, '..', backslash) or a duplicate path throws
//   Error('zip: ...'); more than 65535 entries or 4 GB is out of scope and throws too.
// Store-only on purpose: club sessions are a few MB of CSV, and DEFLATE would be the only
// non-trivial code here. A fixed default date keeps exports byte-reproducible for tests.

const enc = new TextEncoder();
let TABLE = null;

export function crc32(bytes) {
  if (!TABLE) {
    TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

function checkPath(p, seen) {
  if (typeof p !== 'string' || !p || p.startsWith('/') || p.includes('\\') || p.split('/').some((s) => s === '..' || s === '')) throw new Error(`zip: bad path "${p}"`);
  if (seen.has(p)) throw new Error(`zip: duplicate path "${p}"`);
  seen.add(p);
}

export function zipStore(files, { date = new Date(2026, 0, 1) } = {}) {
  if (files.length > 0xffff) throw new Error('zip: too many files');
  const { time, date: dd } = dosTime(date);
  const seen = new Set();
  const entries = files.map((f) => {
    checkPath(f.path, seen);
    const name = enc.encode(f.path);
    const data = f.bytes instanceof Uint8Array ? f.bytes : enc.encode(String(f.text ?? ''));
    return { name, data, crc: crc32(data) };
  });
  const localSize = entries.reduce((a, e) => a + 30 + e.name.length + e.data.length, 0);
  const centralSize = entries.reduce((a, e) => a + 46 + e.name.length, 0);
  if (localSize + centralSize + 22 > 0xffffffff) throw new Error('zip: archive over 4 GB');
  const out = new Uint8Array(localSize + centralSize + 22);
  const v = new DataView(out.buffer);
  let o = 0;
  const offsets = [];
  for (const e of entries) {
    offsets.push(o);
    v.setUint32(o, 0x04034b50, true); v.setUint16(o + 4, 20, true); v.setUint16(o + 6, 0x0800, true);
    v.setUint16(o + 8, 0, true); v.setUint16(o + 10, time, true); v.setUint16(o + 12, dd, true);
    v.setUint32(o + 14, e.crc, true); v.setUint32(o + 18, e.data.length, true); v.setUint32(o + 22, e.data.length, true);
    v.setUint16(o + 26, e.name.length, true); v.setUint16(o + 28, 0, true);
    out.set(e.name, o + 30); out.set(e.data, o + 30 + e.name.length);
    o += 30 + e.name.length + e.data.length;
  }
  const cdStart = o;
  entries.forEach((e, i) => {
    v.setUint32(o, 0x02014b50, true); v.setUint16(o + 4, 20, true); v.setUint16(o + 6, 20, true);
    v.setUint16(o + 8, 0x0800, true); v.setUint16(o + 10, 0, true); v.setUint16(o + 12, time, true); v.setUint16(o + 14, dd, true);
    v.setUint32(o + 16, e.crc, true); v.setUint32(o + 20, e.data.length, true); v.setUint32(o + 24, e.data.length, true);
    v.setUint16(o + 28, e.name.length, true); // extra, comment, disk, internal attr = 0
    v.setUint32(o + 38, 0, true); v.setUint32(o + 42, offsets[i], true);
    out.set(e.name, o + 46);
    o += 46 + e.name.length;
  });
  v.setUint32(o, 0x06054b50, true); v.setUint16(o + 8, entries.length, true); v.setUint16(o + 10, entries.length, true);
  v.setUint32(o + 12, o - cdStart, true); v.setUint32(o + 16, cdStart, true);
  return out;
}

export function readZip(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = bytes.length - 22;
  if (eocd < 0 || v.getUint32(eocd, true) !== 0x06054b50) throw new Error('zip: no end record');
  const count = v.getUint16(eocd + 10, true);
  let o = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = [];
  for (let i = 0; i < count; i++) {
    if (v.getUint32(o, true) !== 0x02014b50) throw new Error('zip: bad central entry');
    const crc = v.getUint32(o + 16, true);
    const size = v.getUint32(o + 20, true);
    const nl = v.getUint16(o + 28, true);
    const path = dec.decode(bytes.subarray(o + 46, o + 46 + nl));
    const lo = v.getUint32(o + 42, true);
    if (v.getUint32(lo, true) !== 0x04034b50) throw new Error('zip: bad local entry');
    const start = lo + 30 + v.getUint16(lo + 26, true) + v.getUint16(lo + 28, true);
    const data = bytes.subarray(start, start + size);
    out.push({ path, bytes: data, crcOk: crc32(data) === crc });
    o += 46 + nl + v.getUint16(o + 30, true) + v.getUint16(o + 32, true);
  }
  return out;
}
