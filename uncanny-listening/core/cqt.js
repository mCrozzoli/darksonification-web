// Copied from projects/designs/dark_music_corpus/web_implementation/core/cqt.js on 2026-10-27 for Uncanny Listening (credit: the
// Dark Music Corpus web engine). Changes here: none.
// Dark Music Corpus — chroma_cqt and chroma_cens in the browser (2026-10-23): a port of librosa 0.11
// (feature.chroma_cqt / chroma_cens → core.cqt → vqt with gamma 0). 7 octaves × 36 bins from C1, the file's tuning from
// piptrack (magnitude, n_fft 2048, hop 512) at 36 bins per octave; per octave a Hann-windowed complex wavelet basis
// (L1-normalised, scaled by length / n_fft), FFT'd, sparsified at the 0.01 quantile, applied to an STFT with a rectangular
// window; the signal halved between octaves (and early, when the top filter allows) with soxr-HQ-like resampling
// (mir.resample, ×√2 as scale=True); responses trimmed to the shortest octave and divided by √length; then cq_to_chroma
// and ∞-normalisation (cqt) or L1 → quantise (0.4 0.2 0.1 0.05) → 41-frame Hann smoothing → L2 (cens).
import { estimateTuning, resample, fftOf, stftMag } from "./mir.js";

const C1 = 440 * 2 ** ((24 - 69) / 12), HANN_BW = 1.50018310546875, TINY = 1.1754944e-38;
const periodicHann = (n) => Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));

function relativeBandwidth(freqs) {                               // filters._relative_bandwidth
  const n = freqs.length, lf = freqs.map(Math.log2), bpo = new Float64Array(n);
  bpo[0] = 1 / (lf[1] - lf[0]); bpo[n - 1] = 1 / (lf[n - 1] - lf[n - 2]); for (let i = 1; i < n - 1; i++) bpo[i] = 2 / (lf[i + 1] - lf[i - 1]);
  return Array.from(bpo, (b) => (2 ** (2 / b) - 1) / (2 ** (2 / b) + 1));
}
const lengthsOf = (freqs, alpha, sr) => freqs.map((f, i) => (1 / alpha[i]) * sr / f);           // wavelet_lengths, gamma 0, filter_scale 1
// __vqt_filter_fft: → rows of {idx, re, im} (sparse), n_fft
function filterFft(sr, freqs, alpha) {
  const lengths = lengthsOf(freqs, alpha, sr), sigs = [];
  for (let r = 0; r < freqs.length; r++) {
    const ilen = lengths[r], a = Math.floor(-ilen / 2), b = Math.floor(ilen / 2), n = b - a, w = periodicHann(n);   // __float_window(len(sig)): an integer length
    const re = new Float64Array(n), im = new Float64Array(n); let l1 = 0;
    for (let k = 0; k < n; k++) { const ang = (a + k) * 2 * Math.PI * freqs[r] / sr, win = w[k]; re[k] = Math.cos(ang) * win; im[k] = Math.sin(ang) * win; l1 += Math.hypot(re[k], im[k]); }
    if (l1 >= TINY) for (let k = 0; k < n; k++) { re[k] /= l1; im[k] /= l1; }
    sigs.push({ re, im, n });
  }
  const nFft = 2 ** Math.ceil(Math.log2(Math.max(...lengths))), fft = fftOf(nFft), half = nFft / 2 + 1, rows = [];
  for (let r = 0; r < sigs.length; r++) {
    const { re: sr0, im: si0, n } = sigs[r], lp = Math.floor((nFft - n) / 2), re = new Float64Array(nFft), im = new Float64Array(nFft), sc = lengths[r] / nFft;
    for (let k = 0; k < n; k++) { re[lp + k] = sr0[k] * sc; im[lp + k] = si0[k] * sc; }
    fft(re, im);
    const mags = Float64Array.from({ length: half }, (_, k) => Math.hypot(re[k], im[k])), sorted = Float64Array.from(mags).sort();
    let norm = 0; for (const v of mags) norm += v; let cum = 0, j = 0;                                  // util.sparsify_rows(quantile 0.01)
    for (; j < half; j++) { cum += sorted[j] / norm; if (!(cum < 0.01)) break; } if (j >= half) j = 0;
    const thr = sorted[j], idx = [], vr = [], vi = [];
    for (let k = 0; k < half; k++) if (mags[k] >= thr) { idx.push(k); vr.push(re[k]); vi.push(im[k]); }
    rows.push({ idx: Int32Array.from(idx), re: Float64Array.from(vr), im: Float64Array.from(vi) });
  }
  return { rows, nFft };
}
// __cqt_response: |basis · STFT(y, n_fft, hop, window ones, centre, constant pad)|, complex → per frame
function response(y, nFft, hop, rows, gain) {
  const T = 1 + Math.floor(y.length / hop), pad = nFft / 2, fft = fftOf(nFft), re = new Float64Array(nFft), im = new Float64Array(nFft), out = rows.map(() => new Float64Array(T));
  for (let t = 0; t < T; t++) {
    const s0 = t * hop - pad; for (let i = 0; i < nFft; i++) { const k = s0 + i; re[i] = k >= 0 && k < y.length ? y[k] : 0; im[i] = 0; }
    fft(re, im);
    for (let r = 0; r < rows.length; r++) { const R = rows[r]; let ar = 0, ai = 0;
      for (let q = 0; q < R.idx.length; q++) { const k = R.idx[q], br = R.re[q] * gain, bi = R.im[q] * gain; ar += br * re[k] - bi * im[k]; ai += br * im[k] + bi * re[k]; }
      out[r][t] = Math.hypot(ar, ai); }
  }
  return out;
}
export function cqtMag(y, sr, hop, { nBins = 252, bpo = 36 } = {}) {   // |cqt(y, sr, hop, n_bins, bins_per_octave, tuning=None)|
  const nOct = Math.ceil(nBins / bpo), nFilt = Math.min(bpo, nBins);
  const tuning = estimateTuning(stftMag(y, 2048, 512), sr, 2048, 150, 4000, bpo);   // estimate_tuning(y=y): piptrack on |STFT| (n_fft 2048, hop 512)
  const fmin = C1 * 2 ** (tuning / bpo), freqs = Array.from({ length: nBins }, (_, i) => fmin * 2 ** ((i % bpo) / bpo) * 2 ** Math.floor(i / bpo)).sort((a, b) => a - b);
  const alpha = relativeBandwidth(freqs), Q = alpha.map((a) => 1 / a);
  const cutoff = Math.max(...freqs.map((f, i) => f * (1 + 0.5 * HANN_BW / Q[i]))), nyq = sr / 2;
  if (cutoff > nyq) throw new Error(`chroma cqt: the top filter (${cutoff.toFixed(0)} Hz) exceeds the Nyquist frequency at ${sr} Hz`);
  let twos = 0; for (let h = hop; h > 0 && h % 2 === 0; h /= 2) twos++;                // __early_downsample
  const c1 = Math.max(0, Math.ceil(Math.log2(nyq / cutoff)) - 1 - 1), c2 = Math.max(0, twos - nOct + 1), cnt = Math.min(c1, c2);
  let my = y, mySr = sr, myHop = hop;
  if (cnt > 0) { const f = 2 ** cnt; myHop = Math.floor(hop / f); mySr = sr / f; my = resample(y, f, 1).map((v) => v / Math.sqrt(1 / f)); }
  const srE = mySr, resp = [];
  for (let i = 0; i < nOct; i++) {
    const lo = i === 0 ? nBins - nFilt : nBins - nFilt * (i + 1), hi = i === 0 ? nBins : nBins - nFilt * i;
    const fo = freqs.slice(Math.max(0, lo), hi), ao = alpha.slice(Math.max(0, lo), hi), { rows, nFft } = filterFft(mySr, fo, ao);
    resp.push(response(my, nFft, myHop, rows, Math.sqrt(srE / mySr)));
    if (myHop % 2 === 0) { myHop /= 2; mySr /= 2; my = resample(my, 2, 1).map((v) => v * Math.SQRT2); }
  }
  const T = Math.min(...resp.map((r) => r[0].length)), out = [];                     // __trim_stack: low octaves first
  for (let i = resp.length - 1; i >= 0; i--) for (const row of resp[i]) out.push(row.slice(0, T));
  const L = lengthsOf(freqs, alpha, srE); out.forEach((row, b) => { const d = Math.sqrt(L[b]); for (let t = 0; t < T; t++) row[t] /= d; });
  return out;                                                       // nBins × T, low → high
}
function cqToChroma(C, bpo = 36) {                                // filters.cq_to_chroma(n_input, bpo, 12, fmin C1): bins merged by 3, rolled −1
  const n = C.length, T = C[0].length, merge = bpo / 12, out = Array.from({ length: 12 }, () => new Float64Array(T));
  for (let b = 0; b < n; b++) { const c = Math.floor(((b + Math.floor(merge / 2)) % bpo) / merge) % 12; for (let t = 0; t < T; t++) out[c][t] += C[b][t]; }
  return out;
}
const normFrames = (X, p) => { const T = X[0].length;              // util.normalize(axis=-2), threshold tiny
  for (let t = 0; t < T; t++) { let l = 0; for (const r of X) l = p === Infinity ? Math.max(l, Math.abs(r[t])) : l + Math.abs(r[t]) ** p; if (p !== Infinity) l = l ** (1 / p); if (l < TINY) l = 1; for (const r of X) r[t] /= l; }
  return X; };
export function chromaCqt(y, sr, hop) { return normFrames(cqToChroma(cqtMag(y, sr, hop)), Infinity); }
export function chromaCens(y, sr, hop, winLen = 41) {
  const ch = normFrames(cqToChroma(cqtMag(y, sr, hop)), 1), T = ch[0].length;
  const q = ch.map((r) => Float64Array.from(r, (v) => (v > 0.4 ? 0.25 : 0) + (v > 0.2 ? 0.25 : 0) + (v > 0.1 ? 0.25 : 0) + (v > 0.05 ? 0.25 : 0)));
  const M = winLen + 2, w = Float64Array.from({ length: M }, (_, k) => 0.5 - 0.5 * Math.cos(2 * Math.PI * k / (M - 1))); let ws = 0; for (const v of w) ws += v; for (let k = 0; k < M; k++) w[k] /= ws;
  const c = Math.floor(M / 2), sm = q.map((r) => { const o = new Float64Array(T); for (let t = 0; t < T; t++) { let s = 0; for (let k = 0; k < M; k++) { const j = t + c - k; if (j >= 0 && j < T) s += r[j] * w[k]; } o[t] = s; } return o; });
  return normFrames(sm, 2);
}
