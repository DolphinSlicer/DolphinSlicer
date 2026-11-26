// MD5 (RFC 1321), to compare a local file with Drive's md5Checksum without downloading it. Not
// for security; crypto.subtle has no MD5.
// SPDX-License-Identifier: AGPL-3.0-or-later

const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

/** The MD5 of the bytes, as 32 hex digits (as Drive's md5Checksum). */
export function md5(data: Uint8Array): string {
  const len = data.length;
  const blocks = Math.ceil((len + 9) / 64);
  const m = new Uint8Array(blocks * 64);
  m.set(data);
  m[len] = 0x80;
  const view = new DataView(m.buffer);
  view.setUint32(m.length - 8, (len * 8) >>> 0, true);
  view.setUint32(m.length - 4, Math.floor(len / 0x20000000), true);
  let a0 = 0x67452301,
    b0 = 0xefcdab89,
    c0 = 0x98badcfe,
    d0 = 0x10325476;
  const w = new Uint32Array(16);
  for (let off = 0; off < m.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, true);
    let a = a0,
      b = b0,
      c = c0,
      d = d0;
    for (let i = 0; i < 64; i++) {
      const round = i >> 4;
      let f: number, g: number;
      if (round === 0) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (round === 1) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (round === 2) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }
      const s = S[(round << 2) | (i & 3)]!;
      const x = (a + f + K[i]! + w[g]!) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((x << s) | (x >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new DataView(new ArrayBuffer(16));
  [a0, b0, c0, d0].forEach((v, i) => out.setUint32(i * 4, v, true));
  return [...new Uint8Array(out.buffer)].map((x) => x.toString(16).padStart(2, '0')).join('');
}
