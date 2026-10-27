// Uncanny Listening — decoding the researcher's own files in the page, as librosa.load(sr=None, mono=True) does.
// nativeRate / decodePcm / decodeNative are copied from projects/designs/dark_music_corpus/web_implementation/web_bridge.js
// (2026-10-27, unchanged; tested there, TESTS_2026-10-22 §9: WAV / AIFF decoded here exactly as libsndfile; 16- and 24-bit
// FLAC through the browser's decoder, 16-bit mapped back to k / 32768: max |Δ| 0 against libsndfile). MP3 and the rest use
// the browser's decoder (a small difference Miguel accepted for Dark Music Corpus).
// the file's own sample rate, from its header: decodeAudioData resamples to its context's rate, so decoding in a context
// at the native rate gives the native signal (as librosa.load(sr=None)). WAV / RF64, AIFF / AIFC, FLAC, MP3, Ogg (Vorbis, Opus).
function nativeRate(buf) {
  const b = new Uint8Array(buf), dv = new DataView(buf), tag = (o, n = 4) => String.fromCharCode(...b.subarray(o, o + n));
  try {
    if ((tag(0) === "RIFF" || tag(0) === "RF64") && tag(8) === "WAVE") { for (let o = 12; o + 8 <= b.length;) { const id = tag(o), sz = dv.getUint32(o + 4, true); if (id === "fmt ") return dv.getUint32(o + 12, true); o += 8 + sz + (sz & 1); } }
    if (tag(0) === "FORM" && (tag(8) === "AIFF" || tag(8) === "AIFC")) { for (let o = 12; o + 8 <= b.length;) { const id = tag(o), sz = dv.getUint32(o + 4); if (id === "COMM") {
          const e = o + 16, ex = ((b[e] & 0x7f) << 8) | b[e + 1], hi = dv.getUint32(e + 2), lo = dv.getUint32(e + 6); return Math.round((hi * 2 ** 32 + lo) * 2 ** (ex - 16383 - 63)); } o += 8 + sz + (sz & 1); } }
    if (tag(0) === "fLaC") return (b[18] << 12) | (b[19] << 4) | (b[20] >> 4);
    if (tag(0) === "OggS") { const i = b.findIndex((x, k) => k > 27 && tag(k, 8) === "OpusHead"); if (i > 0) return 48000;
      const v = b.findIndex((x, k) => k > 27 && x === 1 && tag(k + 1, 6) === "vorbis"); if (v > 0) return dv.getUint32(v + 12, true); }
    let o = 0; if (tag(0, 3) === "ID3") o = 10 + ((b[6] & 0x7f) << 21 | (b[7] & 0x7f) << 14 | (b[8] & 0x7f) << 7 | (b[9] & 0x7f));
    for (; o + 4 < b.length; o++) if (b[o] === 0xff && (b[o + 1] & 0xe0) === 0xe0) { const ver = (b[o + 1] >> 3) & 3, si = (b[o + 2] >> 2) & 3; if (ver === 1 || si === 3) continue;
        return [[11025, 12000, 8000], null, [22050, 24000, 16000], [44100, 48000, 32000]][ver][si]; }
  } catch (e) { /* unknown header */ }
  return null;
}
// WAV / AIFF PCM decoded here, as libsndfile does for librosa.load (ints ÷ 2^(bits−1) in float32, floats as stored):
// exact, where the browser's decoder adds a small gain and conversion noise (TESTS §9). Other formats: the browser's decoder.
function decodePcm(buf) {
  const b = new Uint8Array(buf), dv = new DataView(buf), tag = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  let fmt = null, data = null, le = true;
  if ((tag(0) === "RIFF" || tag(0) === "RF64") && tag(8) === "WAVE") {
    let ds64 = null;
    for (let o = 12; o + 8 <= b.length;) { const id = tag(o); let sz = dv.getUint32(o + 4, true);
      if (id === "ds64") ds64 = Number(dv.getBigUint64(o + 16, true));
      if (id === "fmt ") { let code = dv.getUint16(o + 8, true); const ch = dv.getUint16(o + 10, true), sr = dv.getUint32(o + 12, true), bits = dv.getUint16(o + 22, true);
        if (code === 0xfffe && sz >= 40) code = dv.getUint16(o + 32, true);                           // WAVE_FORMAT_EXTENSIBLE: the sub-format GUID
        fmt = { float: code === 3, pcm: code === 1, ch, sr, bits }; }
      if (id === "data") { if (sz === 0xffffffff && ds64 != null) sz = ds64; data = [o + 8, Math.min(sz, b.length - o - 8)]; break; }
      o += 8 + sz + (sz & 1); }
  } else if (tag(0) === "FORM" && (tag(8) === "AIFF" || tag(8) === "AIFC")) {
    le = false;
    for (let o = 12; o + 8 <= b.length;) { const id = tag(o), sz = dv.getUint32(o + 4);
      if (id === "COMM") { const ch = dv.getUint16(o + 8), bits = dv.getUint16(o + 14), e = o + 16, ex = ((b[e] & 0x7f) << 8) | b[e + 1];
        const sr = Math.round((dv.getUint32(e + 2) * 2 ** 32 + dv.getUint32(e + 6)) * 2 ** (ex - 16383 - 63)), comp = tag(8) === "AIFC" ? tag(o + 26) : "NONE";
        if (comp === "sowt") le = true; fmt = { float: comp === "fl32" || comp === "FL32" || comp === "fl64" || comp === "FL64", pcm: comp === "NONE" || comp === "sowt", ch, sr, bits: comp.startsWith("fl") || comp.startsWith("FL") ? (comp.endsWith("64") ? 64 : 32) : bits }; }
      if (id === "SSND") { const off = dv.getUint32(o + 8); data = [o + 16 + off, Math.min(sz - 8 - off, b.length - o - 16 - off)]; }
      o += 8 + sz + (sz & 1); }
    if (fmt && fmt.pcm && fmt.bits === 8) fmt.signed8 = true;                                      // AIFF 8-bit is signed
  }
  if (!fmt || !data || !(fmt.pcm || fmt.float)) return null;
  const { ch, bits } = fmt, bps = Math.ceil(bits / 8), n = Math.floor(data[1] / (bps * ch)), y = Array.from({ length: ch }, () => new Float32Array(n));
  for (let i = 0, o = data[0]; i < n; i++) for (let c = 0; c < ch; c++, o += bps) {
    let v;
    if (fmt.float) v = bits === 64 ? dv.getFloat64(o, le) : dv.getFloat32(o, le);
    else if (bps === 1) v = fmt.signed8 ? dv.getInt8(o) / 128 : (b[o] - 128) / 128;
    else if (bps === 2) v = dv.getInt16(o, le) / 32768;
    else if (bps === 3) { const x = le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) : ((b[o] << 16) | (b[o + 1] << 8) | b[o + 2]); v = ((x << 8) >> 8) / 8388608; }
    else v = dv.getInt32(o, le) / 2147483648;
    y[c][i] = v;
  }
  return { sampleRate: fmt.sr, numberOfChannels: ch, length: n, getChannelData: (c) => y[c] };
}
async function decodeNative(buf) {
  const pcm = decodePcm(buf); if (pcm) return pcm;
  const b = new Uint8Array(buf), flacBits = String.fromCharCode(b[0], b[1], b[2], b[3]) === "fLaC" ? (((b[20] & 1) << 4) | (b[21] >> 4)) + 1 : 0;
  const sr = nativeRate(buf), ctx = sr ? new OfflineAudioContext(1, 1, sr) : new AudioContext();
  let dec; try { dec = await ctx.decodeAudioData(buf.slice(0)); } finally { if (ctx.close) ctx.close(); }
  if (flacBits === 16) {                                          // Chromium scales 16-bit FLAC by 1/32767 above zero (1/32768 below): back to k / 32768 (libsndfile)
    const chs = Array.from({ length: dec.numberOfChannels }, (_, c) => dec.getChannelData(c));
    const asym = chs.some((x) => { for (let i = 0; i < x.length; i += 97) if (x[i] > 0 && x[i] * 32768 !== Math.round(x[i] * 32768)) return true; return false; });
    if (asym) return { sampleRate: dec.sampleRate, numberOfChannels: chs.length, length: dec.length,
      getChannelData: (c) => Float32Array.from(chs[c], (v) => Math.round(v * (v > 0 ? 32767 : 32768)) / 32768) };
  }
  return dec;
}


// → {y: mono Float32Array at the native rate (numpy's float32 mean of the channels), sr}
// The same result as decodeNative + a channel mix, without the copies: the 16-bit FLAC remap and the mix happen in one pass
// over the decoder's own channel arrays, and the file's bytes go to the decoder without a copy. (A one-hour stereo file holds
// 1.2 GB of decoded audio; with the copies the page needed ~3 GB at once and could crash.)
export async function decodeMono(buf) {
  const pcm = decodePcm(buf);
  let chs, sr, remap = false;
  if (pcm) { chs = Array.from({ length: pcm.numberOfChannels }, (_, c) => pcm.getChannelData(c)); sr = pcm.sampleRate; }
  else {
    const b = new Uint8Array(buf, 0, Math.min(64, buf.byteLength)), flacBits = String.fromCharCode(b[0], b[1], b[2], b[3]) === "fLaC" ? (((b[20] & 1) << 4) | (b[21] >> 4)) + 1 : 0;
    const nsr = nativeRate(buf), ctx = nsr ? new OfflineAudioContext(1, 1, nsr) : new AudioContext();
    let dec; try { dec = await ctx.decodeAudioData(buf); } finally { if (ctx.close) ctx.close(); }
    chs = Array.from({ length: dec.numberOfChannels }, (_, c) => dec.getChannelData(c)); sr = dec.sampleRate;
    // Chromium scales 16-bit FLAC by 1/32767 above zero (1/32768 below): back to k / 32768 (libsndfile), as decodeNative does
    if (flacBits === 16) remap = chs.some((x) => { for (let i = 0; i < x.length; i += 97) if (x[i] > 0 && x[i] * 32768 !== Math.round(x[i] * 32768)) return true; return false; });
  }
  const n = chs[0].length, nc = chs.length, y = new Float32Array(n);
  for (let c = 0; c < nc; c++) { const ch = chs[c];
    if (remap) for (let k = 0; k < n; k++) { const v = ch[k]; y[k] += Math.round(v * (v > 0 ? 32767 : 32768)) / 32768; }
    else for (let k = 0; k < n; k++) y[k] += ch[k]; }
  if (nc > 1) for (let k = 0; k < n; k++) y[k] /= nc;
  return { y, sr };
}
export { nativeRate, decodePcm, decodeNative };

// the audio's length from a file's header (WAV / AIFF / FLAC exact; other formats by size at ~192 kbit/s), for the time estimate
// (copied from the same web_bridge.js, unchanged)
export async function audioSeconds(f) {
  try {
    const buf = await f.slice(0, 65536).arrayBuffer(), b = new Uint8Array(buf), dv = new DataView(buf), tag = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
    if ((tag(0) === "RIFF" || tag(0) === "RF64") && tag(8) === "WAVE") { let ch = 0, sr = 0, bits = 0;
      for (let o = 12; o + 8 <= b.length;) { const id = tag(o), sz = dv.getUint32(o + 4, true);
        if (id === "fmt ") { ch = dv.getUint16(o + 10, true); sr = dv.getUint32(o + 12, true); bits = dv.getUint16(o + 22, true); }
        if (id === "data") { const n = sz === 0xffffffff ? f.size - o - 8 : sz; return sr ? n / (ch * Math.ceil(bits / 8)) / sr : 0; }
        o += 8 + sz + (sz & 1); } }
    if (tag(0) === "FORM") for (let o = 12; o + 8 <= b.length;) { const id = tag(o), sz = dv.getUint32(o + 4);
      if (id === "COMM") { const e = o + 16, ex = ((b[e] & 0x7f) << 8) | b[e + 1], sr = (dv.getUint32(e + 2) * 2 ** 32 + dv.getUint32(e + 6)) * 2 ** (ex - 16383 - 63); return dv.getUint32(o + 10) / sr; }
      o += 8 + sz + (sz & 1); }
    if (tag(0) === "fLaC") { const sr = (b[18] << 12) | (b[19] << 4) | (b[20] >> 4), n = (b[21] & 0x0f) * 2 ** 32 + dv.getUint32(22); if (sr && n) return n / sr; }
  } catch (_) { /* fall through */ }
  return f.size * 8 / 192000;
}
