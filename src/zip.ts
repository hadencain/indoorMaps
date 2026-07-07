// Dependency-free ZIP writer, STORE method (no compression). A valid .zip is
// just: [local header + file data]* + [central directory header]* + EOCD, all
// little-endian. STORE keeps this ~120 lines and is a fully valid archive.
//
// CRC32 is validated numerically against a known vector (see scratch check):
//   crc32("The quick brown fox jumps over the lazy dog") === 0x414FA339
// so the writer can be trusted without a browser round-trip.

export interface ZipFile {
  name: string;
  data: Uint8Array;
}

const textEnc = new TextEncoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** Standard IEEE CRC32 of a byte buffer, as an unsigned 32-bit int. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS packed time/date (used by the ZIP format for mtime). */
function dosDateTime(d: Date): { time: number; date: number } {
  const time =
    ((d.getHours() & 0x1f) << 11) |
    ((d.getMinutes() & 0x3f) << 5) |
    ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const year = Math.max(0, d.getFullYear() - 1980);
  const date = ((year & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/** Build a valid uncompressed ZIP archive as a Blob. */
export function zipStore(files: ZipFile[]): Blob {
  const { time, date } = dosDateTime(new Date());
  const parts: BlobPart[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = textEnc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;

    // Local file header (30 bytes + filename).
    const lh = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); // signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // method: 0 = STORE
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed size
    lv.setUint32(22, size, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra length
    lh.set(nameBytes, 30);
    parts.push(lh as BlobPart, f.data as BlobPart);

    // Central directory header (46 bytes + filename).
    const ch = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); // signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, 0, true); // method
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra length
    cv.setUint16(32, 0, true); // comment length
    cv.setUint16(34, 0, true); // disk number
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // local header offset
    ch.set(nameBytes, 46);
    central.push(ch);

    offset += lh.length + size;
  }

  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const centralOffset = offset;
  for (const c of central) parts.push(c as BlobPart);

  // End of central directory record (22 bytes, no comment).
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // signature
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // central dir start disk
  ev.setUint16(8, files.length, true); // entries this disk
  ev.setUint16(10, files.length, true); // entries total
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  ev.setUint16(20, 0, true); // comment length
  parts.push(eocd as BlobPart);

  return new Blob(parts, { type: "application/zip" });
}
