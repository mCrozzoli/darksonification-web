// Uncanny Listening — a FLAC decoder in JavaScript (2026-10-27), after the format specification (xiph.org/flac/format.html,
// RFC 9639). Why: Chromium's decoder refuses some valid files (one of the test corpus's FLACs, which libsndfile reads) and
// the page's header reader mistook FLACs that start with an ID3 tag for MP3; FLAC is lossless, so decoding it here gives
// exactly what libsndfile gives librosa: the integers ÷ 2^(bits − 1), as float32. It runs in the feature workers.
// decodeFlac(ArrayBuffer | Uint8Array, {mono}) → {sampleRate, channels, bits, length, data: Int32Array[] (one per channel)}, or
//   with mono: {sampleRate, channels, bits, length, y: Float32Array}, mixed frame by frame (a one-hour file stays 4 bytes a sample):
//   each channel ÷ 2^(bits − 1) in float32, summed in float32, ÷ channels: numpy's float32 mean, as librosa.load(mono=True).
// toMonoFloat(dec) → the same mix from the channel arrays. flacHeader(bytes) → {sampleRate, channels, bits, total}.

class Bits {
  constructor(b, pos) { this.b = b; this.p = pos * 8; }
  // bit positions pass 2^31 in files over 256 MB: byte = floor(p / 8), never p >> 3
  get byte() { return Math.floor(this.p / 8); }
  align() { this.p = Math.ceil(this.p / 8) * 8; }
  bit() { const v = (this.b[Math.floor(this.p / 8)] >> (7 - (this.p % 8))) & 1; this.p++; return v; }
  u(n) {                                                             // n ≤ 32 unsigned
    let v = 0;
    while (n > 0) {
      const off = this.p % 8, take = Math.min(8 - off, n), byte = this.b[Math.floor(this.p / 8)];
      v = v * (1 << take) + ((byte >> (8 - off - take)) & ((1 << take) - 1)); this.p += take; n -= take;
    }
    return v;
  }
  s(n) { if (!n) return 0; const v = this.u(n); return v >= 2 ** (n - 1) ? v - 2 ** n : v; }
  unary() {                                                           // count zeros before a one
    let n = 0;
    for (;;) {
      const off = this.p % 8, byte = (this.b[Math.floor(this.p / 8)] << off) & 0xff;
      if (byte) { const z = Math.clz32(byte) - 24; n += z; this.p += z + 1; return n; }
      n += 8 - off; this.p += 8 - off;
    }
  }
}

const BLOCK = [0, 192, 576, 1152, 2304, 4608, -8, -16, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768];
const FIXED = [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]];

function residual(br, bs, order, out) {
  const method = br.u(2), pbits = method === 0 ? 4 : 5, esc = method === 0 ? 15 : 31, po = br.u(4), parts = 1 << po;
  let i = order;
  for (let p = 0; p < parts; p++) {
    const n = (bs >> po) - (p === 0 ? order : 0), k = br.u(pbits);
    if (k === esc) { const nb = br.u(5); for (let j = 0; j < n; j++) out[i++] = br.s(nb); }
    else for (let j = 0; j < n; j++) {
      const q = br.unary(), r = k ? br.u(k) : 0, v = q * (1 << k) + r;   // zig-zag
      out[i++] = v % 2 ? -(v + 1) / 2 : v / 2;
    }
  }
}
function subframe(br, bs, bps, out) {
  br.bit();                                                          // zero padding
  const type = br.u(6); let wasted = 0;
  if (br.bit()) wasted = br.unary() + 1;
  const b = bps - wasted;
  if (type === 0) { const v = br.s(b); out.fill(v, 0, bs); }
  else if (type === 1) { for (let i = 0; i < bs; i++) out[i] = br.s(b); }
  else if (type >= 8 && type <= 12) {
    const order = type - 8, c = FIXED[order];
    for (let i = 0; i < order; i++) out[i] = br.s(b);
    residual(br, bs, order, out);
    for (let i = order; i < bs; i++) { let s = 0; for (let j = 0; j < order; j++) s += c[j] * out[i - 1 - j]; out[i] += s; }
  } else if (type >= 32) {
    const order = type - 31;
    for (let i = 0; i < order; i++) out[i] = br.s(b);
    const prec = br.u(4) + 1; if (prec === 16) throw new Error("flac: invalid LPC precision");
    const shift = br.s(5), coef = new Array(order); for (let j = 0; j < order; j++) coef[j] = br.s(prec);
    residual(br, bs, order, out);
    const div = 2 ** shift;
    for (let i = order; i < bs; i++) { let s = 0; for (let j = 0; j < order; j++) s += coef[j] * out[i - 1 - j]; out[i] += Math.floor(s / div); }
  } else throw new Error(`flac: reserved subframe type ${type}`);
  if (wasted) for (let i = 0; i < bs; i++) out[i] *= 2 ** wasted;
}

export function flacHeader(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  let o = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) o = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f)) + (b[5] & 0x10 ? 10 : 0);
  if (String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) !== "fLaC") return null;
  const s = o + 8; return { sampleRate: (b[s + 10] << 12) | (b[s + 11] << 4) | (b[s + 12] >> 4), channels: ((b[s + 12] >> 1) & 7) + 1, bits: (((b[s + 12] & 1) << 4) | (b[s + 13] >> 4)) + 1,
    total: (b[s + 13] & 0x0f) * 2 ** 32 + ((b[s + 14] << 24) >>> 0) + (b[s + 15] << 16) + (b[s + 16] << 8) + b[s + 17] };
}
export function decodeFlac(input, { mono = false } = {}) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  let o = 0;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) o = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f)) + (b[5] & 0x10 ? 10 : 0);   // ID3v2
  if (String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) !== "fLaC") throw new Error("not a FLAC stream");
  o += 4;
  let sr = 0, ch = 0, bps = 0, total = 0;
  for (;;) {                                                          // metadata blocks
    const last = b[o] >> 7, type = b[o] & 0x7f, len = (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
    if (type === 0) { const s = o + 4; sr = (b[s + 10] << 12) | (b[s + 11] << 4) | (b[s + 12] >> 4); ch = ((b[s + 12] >> 1) & 7) + 1; bps = (((b[s + 12] & 1) << 4) | (b[s + 13] >> 4)) + 1;
      total = (b[s + 13] & 0x0f) * 2 ** 32 + ((b[s + 14] << 24) >>> 0) + (b[s + 15] << 16) + (b[s + 16] << 8) + b[s + 17]; }
    o += 4 + len; if (last) break;
  }
  const cap = total || 1 << 20, sc = 2 ** (bps - 1);
  let data = mono ? null : Array.from({ length: ch }, () => new Int32Array(cap)), y = mono ? new Float32Array(cap) : null;
  const fr = Math.fround;
  let n = 0, maxBs = 65536, sub = Array.from({ length: 8 }, () => new Float64Array(maxBs));
  const br = new Bits(b, o);
  while (br.byte + 2 < b.length) {
    // frame header: sync 0b11111111111110 (14 bits), reserved, blocking strategy
    if (b[br.byte] !== 0xff || (b[br.byte + 1] & 0xfc) !== 0xf8) { br.p += 8; continue; }   // resync byte by byte (should not happen)
    const start = br.byte; br.u(16);
    const bsc = br.u(4), src = br.u(4), ca = br.u(4), ssc = br.u(3); br.u(1);
    // the UTF-8-like coded frame / sample number
    let x = br.u(8), extra = 0; if (x >= 0xc0) { extra = x >= 0xfe ? 6 : x >= 0xfc ? 5 : x >= 0xf8 ? 4 : x >= 0xf0 ? 3 : x >= 0xe0 ? 2 : 1; }
    for (let i = 0; i < extra; i++) br.u(8);
    let bs = BLOCK[bsc]; if (bsc === 6) bs = br.u(8) + 1; else if (bsc === 7) bs = br.u(16) + 1;
    if (src === 12) br.u(8); else if (src === 13 || src === 14) br.u(16);
    br.u(8);                                                          // CRC-8
    const fbps = [bps, 8, 12, 0, 16, 20, 24, 32][ssc] || bps, nch = ca < 8 ? ca + 1 : 2;
    if (bs > maxBs) { maxBs = bs; sub = Array.from({ length: 8 }, () => new Float64Array(maxBs)); }
    for (let c = 0; c < nch; c++) {
      const side = (ca === 8 && c === 1) || (ca === 9 && c === 0) || (ca === 10 && c === 1);
      subframe(br, bs, fbps + (side ? 1 : 0), sub[c]);
    }
    br.align(); br.u(16);                                             // CRC-16
    const a = sub[0], s1 = sub[1];
    if (ca === 8) for (let i = 0; i < bs; i++) s1[i] = a[i] - s1[i];                 // left/side → left, right in sub[0], sub[1]
    else if (ca === 9) for (let i = 0; i < bs; i++) { const r = s1[i]; s1[i] = r; a[i] = a[i] + r; }
    else if (ca === 10) for (let i = 0; i < bs; i++) { const m = a[i] * 2 + (s1[i] & 1), sd = s1[i]; a[i] = (m + sd) >> 1; s1[i] = (m - sd) >> 1; }
    if (mono) {
      if (n + bs > y.length) { const g = new Float32Array(Math.max(n + bs, y.length * 2)); g.set(y); y = g; }
      for (let i = 0; i < bs; i++) { let acc = fr(sub[0][i] / sc); for (let c = 1; c < nch; c++) acc = fr(acc + fr(sub[c][i] / sc)); y[n + i] = nch > 1 ? fr(acc / nch) : acc; }
      n += bs; if (total && n >= total) break; if (br.byte === start) break; continue;
    }
    if (n + bs > data[0].length) for (let c = 0; c < ch; c++) { const g = new Int32Array(Math.max(n + bs, data[c].length * 2)); g.set(data[c]); data[c] = g; }
    for (let c = 0; c < nch; c++) data[c].set(sub[c].subarray(0, bs), n);
    n += bs;
    if (total && n >= total) break;
    if (br.byte === start) break;
  }
  const len = total ? Math.min(n, total) : n;
  if (mono) return { sampleRate: sr, channels: ch, bits: bps, length: len, y: y.subarray(0, len) };
  return { sampleRate: sr, channels: ch, bits: bps, length: len, data: data.map((d) => d.subarray(0, len)) };
}
export function toMonoFloat(dec) {
  const { data, bits, length } = dec, sc = 2 ** (bits - 1), y = new Float32Array(length), nc = data.length;
  for (let c = 0; c < nc; c++) { const d = data[c]; for (let i = 0; i < length; i++) y[i] += Math.fround(d[i] / sc); }
  if (nc > 1) for (let i = 0; i < length; i++) y[i] /= nc;
  return y;
}
export const isFlac = (b) => { let o = 0; if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) o = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f)) + (b[5] & 0x10 ? 10 : 0);
  return b[o] === 0x66 && b[o + 1] === 0x4c && b[o + 2] === 0x61 && b[o + 3] === 0x43; };
