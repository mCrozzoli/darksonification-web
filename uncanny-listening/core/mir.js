// Copied from projects/designs/dark_music_corpus/web_implementation/core/mir.js on 2026-10-27 for Uncanny Listening (credit: the
// Dark Music Corpus web engine). Changes here: none, except the export list at the end (melFilter, chromaFilter, powerToDb).
// Dark Music Corpus — the MIR feature groups in the browser (2026-10-22; any analysis rate and the Phase 2 options 10-23).
// A line-for-line port of what the desktop engine computes with librosa 0.11 through DarkLibrosa
// (darklibrosa._extract_frame_features + dmc/features.py + dmc/segment.py). makeMir({sr, nFft, hop}) gives the functions
// for one analysis rate; every option of the Phase 2 config is honoured:
//   spectral — zcr, centroid, bandwidth, rolloff (rolloff_percent), flatness, contrast (contrast_bands; collapse_contrast
//              = the mean over the bands, "spectral_contrast"), flux (= onset strength)
//   energy   — rms (+ rms_db, dynamic_range_db; peak_db is joined by the engine from the native-rate signal)
//   mfcc     — n_mfcc coefficients (collapse = their mean, "mfcc")
//   chroma   — chroma_stft with librosa's tuning estimate (collapse = the mean, "chroma"); cqt / cens: core/cqt.js
//   rhythm   — tempo, onset_rate, beat_strength (tempogram_win_s), and the file's onsets and beats (E4)
// and the segmentation helpers: onset_detect (incl. backtrack), beat_track, regularize, fixed segments.
import { chromaCqt, chromaCens } from "./cqt.js";
export const SR = 22050, N_FFT = 2048, HOP = 512;

const roundEven = (x) => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 ? r - 1 : r; };
const TINY32 = 1.1754944e-38;

// ---------------------------------------------------------------- FFT (radix-2, in place)
function fftFactory(n) {
  const lev = Math.log2(n) | 0, cos = new Float64Array(n / 2), sin = new Float64Array(n / 2), rev = new Uint32Array(n);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
  for (let i = 0; i < n; i++) { let r = 0, x = i; for (let j = 0; j < lev; j++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
  return (re, im) => {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size *= 2) {
      const half = size / 2, step = n / size;
      for (let i = 0; i < n; i += size) for (let j = i, k = 0; j < i + half; j++, k += step) {
        const tr = re[j + half] * cos[k] + im[j + half] * sin[k], ti = -re[j + half] * sin[k] + im[j + half] * cos[k];
        re[j + half] = re[j] - tr; im[j + half] = im[j] - ti; re[j] += tr; im[j] += ti;
      }
    }
  };
}
const FFTS = new Map();
const fftOf = (n) => { if (!FFTS.has(n)) FFTS.set(n, fftFactory(n)); return FFTS.get(n); };
const hann = (n) => Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n));   // periodic

// |STFT|, centre=True, pad_mode="constant" → frames × (nFft/2+1), one Float32Array per frame
function stftMag(y, nFft, hop) {
  const NB = nFft / 2 + 1, T = 1 + Math.floor(y.length / hop), pad = nFft / 2, W = hann(nFft), fft = fftOf(nFft);
  const re = new Float64Array(nFft), im = new Float64Array(nFft), S = [];
  for (let t = 0; t < T; t++) {
    const s0 = t * hop - pad;
    for (let i = 0; i < nFft; i++) { const k = s0 + i; re[i] = (k >= 0 && k < y.length ? y[k] : 0) * W[i]; im[i] = 0; }
    fft(re, im);
    const m = new Float32Array(NB); for (let b = 0; b < NB; b++) m[b] = Math.hypot(re[b], im[b]); S.push(m);
  }
  return S;
}

// ---------------------------------------------------------------- mel (slaney) + power_to_db + DCT
const hz2mel = (f) => f < 1000 ? f / (200 / 3) : 15 + Math.log(f / 1000) / (Math.log(6.4) / 27);
const mel2hz = (m) => m < 15 ? m * (200 / 3) : 1000 * Math.exp((Math.log(6.4) / 27) * (m - 15));
function melFilter(sr, nFft, nMels = 128) {
  const NB = nFft / 2 + 1, FREQ = Float64Array.from({ length: NB }, (_, b) => b * sr / nFft);
  const mmin = hz2mel(0), mmax = hz2mel(sr / 2), mf = Float64Array.from({ length: nMels + 2 }, (_, i) => mel2hz(mmin + (mmax - mmin) * i / (nMels + 1)));
  const W = [];
  for (let i = 0; i < nMels; i++) {
    const w = new Float64Array(NB), d0 = mf[i + 1] - mf[i], d1 = mf[i + 2] - mf[i + 1], en = 2 / (mf[i + 2] - mf[i]);
    for (let b = 0; b < NB; b++) { const lo = (FREQ[b] - mf[i]) / d0, hi = (mf[i + 2] - FREQ[b]) / d1; w[b] = Math.max(0, Math.min(lo, hi)) * en; }
    W.push(w);
  }
  return W;
}
function powerToDb(rows) {                                         // ref 1, amin 1e-10, top_db 80 over the whole array
  let mx = -Infinity;
  for (const r of rows) for (let i = 0; i < r.length; i++) { r[i] = 10 * Math.log10(Math.max(1e-10, r[i])); if (r[i] > mx) mx = r[i]; }
  for (const r of rows) for (let i = 0; i < r.length; i++) if (r[i] < mx - 80) r[i] = mx - 80;
  return rows;
}
function dctOrtho(x, n) {
  const N = x.length, out = new Float64Array(n);
  for (let k = 0; k < n; k++) { let s = 0; for (let i = 0; i < N; i++) s += x[i] * Math.cos(Math.PI / N * (i + 0.5) * k); out[k] = s * Math.sqrt((k === 0 ? 1 : 2) / N); }
  return out;
}
function melDb(S, W) {                                             // power mel spectrogram → dB (whole array)
  const nM = W.length, NB = S.length ? S[0].length : 0;
  return powerToDb(S.map((s) => { const m = new Float64Array(nM); for (let i = 0; i < nM; i++) { const w = W[i]; let a = 0; for (let b = 0; b < NB; b++) if (w[b]) a += w[b] * s[b] * s[b]; m[i] = a; } return m; }));
}

// ---------------------------------------------------------------- chroma (librosa.filters.chroma + estimate_tuning)
const hzToOcts = (f, tuning) => Math.log2(f / ((440 * Math.pow(2, tuning / 12)) / 16));
function chromaFilter(sr, nFft, tuning) {
  const n = 12, NB = nFft / 2 + 1, fr = []; for (let i = 1; i < nFft; i++) fr.push(n * hzToOcts(i * sr / nFft, tuning));
  const frq = [fr[0] - 1.5 * n, ...fr], bw = frq.map((v, i) => i < frq.length - 1 ? Math.max(frq[i + 1] - v, 1) : 1);
  const W = Array.from({ length: n }, () => new Float64Array(frq.length));
  for (let j = 0; j < frq.length; j++) {
    let nrm = 0;
    for (let c = 0; c < n; c++) { let D = frq[j] - c; D = ((D + 6 + 10 * n) % n + n) % n - 6; const v = Math.exp(-0.5 * Math.pow(2 * D / bw[j], 2)); W[c][j] = v; nrm += v * v; }
    nrm = Math.sqrt(nrm) || 1;
    const oct = Math.exp(-0.5 * Math.pow((frq[j] / n - 5) / 2, 2));
    for (let c = 0; c < n; c++) W[c][j] = W[c][j] / nrm * oct;
  }
  return Array.from({ length: n }, (_, c) => W[((c + 3) % n + n) % n].slice(0, NB));   // base_c: roll by -3
}
export function estimateTuning(P, sr, nFft, fmin = 150, fmax = 4000, bpo = 12) {   // piptrack(S) + pitch_tuning, resolution 0.01
  const NB = nFft / 2 + 1, pitches = [], mags = [];
  for (const S of P) {
    let mx = 0; for (let b = 0; b < NB; b++) if (S[b] > mx) mx = S[b];
    const ref = 0.1 * mx, X = (b) => (S[b] > ref ? S[b] : 0);
    for (let b = 1; b < NB - 1; b++) {
      const f = b * sr / nFft; if (f < fmin || f >= fmax) continue;
      const x = X(b); if (!(x > X(b - 1) && x >= X(b + 1))) continue;
      const avg = 0.5 * (S[b + 1] - S[b - 1]), pa = S[b + 1] + S[b - 1] - 2 * S[b], pb = avg;   // librosa _pi_stencil
      const sh = Math.abs(pb) >= Math.abs(pa) ? 0 : -pb / pa, pitch = (b + sh) * sr / nFft;
      if (pitch > 0) { pitches.push(pitch); mags.push(S[b] + 0.5 * avg * sh); }
    }
  }
  return pitchTuning(pitches, mags, bpo);
}
export function pitchTuning(pitches, mags, bpo = 12) {
  if (!pitches.length) return 0;
  const sorted = Float64Array.from(mags).sort(), m = sorted.length, med = m % 2 ? sorted[(m - 1) / 2] : 0.5 * (sorted[m / 2 - 1] + sorted[m / 2]);
  const nb = 100, counts = new Float64Array(nb);
  for (let i = 0; i < pitches.length; i++) {
    if (mags[i] < med || !(pitches[i] > 0)) continue;
    let r = (bpo * hzToOcts(pitches[i], 0)) % 1; if (r < 0) r += 1; if (r >= 0.5) r -= 1;
    let k = Math.floor((r + 0.5) / (1 / nb)); if (k >= nb) k = nb - 1; counts[k]++;
  }
  let best = 0; for (let k = 1; k < nb; k++) if (counts[k] > counts[best]) best = k;
  return -0.5 + best / nb;
}

// ---------------------------------------------------------------- one analysis rate
const INST = new Map();
export function makeMir({ sr = SR, nFft = N_FFT, hop = HOP } = {}) {
  const key = `${sr}|${nFft}|${hop}`; if (INST.has(key)) return INST.get(key);
  const NB = nFft / 2 + 1, FREQ = Float64Array.from({ length: NB }, (_, b) => b * sr / nFft), MELn = melFilter(sr, nFft), MEL2048 = nFft === 2048 ? MELn : melFilter(sr, 2048);

  // onset_strength(y, sr, hop): its own 2048-point mel spectrogram, lag 1, centre: pad lag + 2048 // (2·hop) frames
  function onsetEnvFrom(mdb, T) {
    const env = new Float64Array(T), pad = 1 + Math.floor(2048 / (2 * hop)), nM = mdb.length ? mdb[0].length : 128;
    for (let t = 1; t < mdb.length; t++) { let a = 0; for (let i = 0; i < nM; i++) a += Math.max(0, mdb[t][i] - mdb[t - 1][i]); const j = t - 1 + pad; if (j < T) env[j] = a / nM; }
    return env;
  }
  // a lazily shared per-file analysis: the STFT, the mel spectrogram, the onset envelope
  function fileCtx(y) {
    const c = { y, T: 1 + Math.floor(y.length / hop) }; let S = null, S2048 = null, md = null, md2048 = null, env = null;
    c.S = () => S || (S = stftMag(y, nFft, hop));
    c.S2048 = () => nFft === 2048 ? c.S() : (S2048 || (S2048 = stftMag(y, 2048, hop)));
    c.melDb = () => md || (md = melDb(c.S(), MELn));
    c.melDb2048 = () => nFft === 2048 ? c.melDb() : (md2048 || (md2048 = melDb(c.S2048(), MEL2048)));
    c.env = () => env || (env = onsetEnvFrom(c.melDb2048(), c.S2048().length));
    return c;
  }
  // DarkLibrosa per group (features.compute_group): {names, frames: Float64Array[] (one per name)}
  function group(g, c, gcfg = {}) {
    const S = g === "energy" || g === "rhythm" || (g === "chroma" && (gcfg.variant || "stft") !== "stft") ? null : c.S(), T = c.T, y = c.y, names = [], frames = [];
    const add = (n, v) => { names.push(n); frames.push(v); };
    if (g === "spectral") {
      const zcr = new Float64Array(T);                              // zero_crossing_rate: frame 2048, centred, pad "edge", threshold 1e-10
      for (let t = 0; t < T; t++) { const s0 = t * hop - 1024; let cnt = 0, prev = null;
        for (let i = 0; i < 2048; i++) { const ke = Math.min(Math.max(s0 + i, 0), y.length - 1); let v = y[ke]; if (Math.abs(v) <= 1e-10) v = 0;
          const neg = v < 0 || Object.is(v, -0); if (prev !== null && neg !== prev) cnt++; prev = neg; }
        zcr[t] = cnt / 2048; }
      add("zcr", zcr);
      const cen = new Float64Array(T), bw = new Float64Array(T), ro = new Float64Array(T), fl = new Float64Array(T), rp = gcfg.rolloff_percent ?? 0.85;
      for (let t = 0; t < T; t++) {
        const s = S[t]; let tot = 0; for (let b = 0; b < NB; b++) tot += s[b];
        let cc = 0; for (let b = 0; b < NB; b++) cc += FREQ[b] * s[b] / (tot || 1); cen[t] = tot ? cc : 0;
        let v = 0; for (let b = 0; b < NB; b++) v += (s[b] / (tot || 1)) * (FREQ[b] - cc) ** 2; bw[t] = Math.sqrt(v);
        let cum = 0, r = FREQ[NB - 1]; for (let b = 0; b < NB; b++) { cum += s[b]; if (cum >= rp * tot) { r = FREQ[b]; break; } } ro[t] = r;
        let lg = 0, am = 0; for (let b = 0; b < NB; b++) { const p = Math.max(1e-10, s[b] * s[b]); lg += Math.log(p); am += p; } fl[t] = Math.exp(lg / NB) / (am / NB);
      }
      add("spectral_centroid", cen); add("spectral_bandwidth", bw); add("spectral_rolloff", ro); add("spectral_flatness", fl);
      // spectral_contrast(S, sr, n_bands, fmin 200, quantile 0.02): power_to_db(peak) − power_to_db(valley), each over all bands
      const nb = Math.trunc(gcfg.contrast_bands ?? 6), octa = [0, ...Array.from({ length: nb + 1 }, (_, i) => 200 * 2 ** i)];
      if (octa.slice(0, -1).some((f) => f >= 0.5 * sr)) throw new Error(`spectral contrast: ${nb} bands exceed the Nyquist frequency at ${sr} Hz`);
      const pk = Array.from({ length: nb + 1 }, () => new Float64Array(T)), vl = Array.from({ length: nb + 1 }, () => new Float64Array(T));
      for (let k = 0; k <= nb; k++) {
        const band = []; for (let b = 0; b < NB; b++) if (FREQ[b] >= octa[k] && FREQ[b] <= octa[k + 1]) band.push(b);
        let sel = band.slice(); if (k > 0) sel = [band[0] - 1, ...sel]; if (k === nb) for (let b = band[band.length - 1] + 1; b < NB; b++) sel.push(b);
        const nCur = sel.length, sub = k < nb ? sel.slice(0, -1) : sel, q = Math.max(1, roundEven(0.02 * nCur));
        for (let t = 0; t < T; t++) { const v = Float64Array.from(sub, (b) => S[t][b]).sort(); let a = 0, z = 0; for (let i = 0; i < q; i++) { a += v[i]; z += v[v.length - 1 - i]; } vl[k][t] = a / q; pk[k][t] = z / q; }
      }
      powerToDb(pk); powerToDb(vl);
      const con = pk.map((p, k) => Float64Array.from(p, (x, t) => x - vl[k][t]));
      if (gcfg.collapse_contrast) add("spectral_contrast", Float64Array.from({ length: T }, (_, t) => { let s = 0; for (const r of con) s += r[t]; return s / con.length; }));
      else con.forEach((r, k) => add(`spectral_contrast_${k}`, r));
      add("spectral_flux", c.env());
    } else if (g === "energy") {
      const rms = new Float64Array(T);                              // rms: frame 2048, centred, constant pad
      for (let t = 0; t < T; t++) { const s0 = t * hop - 1024; let e = 0; for (let i = 0; i < 2048; i++) { const k = s0 + i; const v = k >= 0 && k < y.length ? y[k] : 0; e += v * v; } rms[t] = Math.sqrt(e / 2048); }
      add("rms", rms);
    } else if (g === "mfcc") {
      const nm = Math.trunc(gcfg.n_mfcc ?? 13), md = c.melDb(), cols = Array.from({ length: nm }, () => new Float64Array(T));
      for (let t = 0; t < T; t++) { const d = dctOrtho(md[t], nm); for (let k = 0; k < nm; k++) cols[k][t] = d[k]; }
      if (gcfg.collapse) add("mfcc", Float64Array.from({ length: T }, (_, t) => { let s = 0; for (const r of cols) s += r[t]; return s / nm; }));
      else cols.forEach((r, k) => add(`mfcc_${k}`, r));
    } else if (g === "chroma") {
      const v = gcfg.variant || "stft", ch = v === "stft" ? chromaStft(S) : v === "cqt" ? chromaCqt(y, sr, hop) : v === "cens" ? chromaCens(y, sr, hop) : null;
      if (!ch) throw new Error(`chroma variant must be stft|cqt|cens, got ${v}`);
      if (gcfg.collapse) add("chroma", Float64Array.from({ length: ch[0].length }, (_, t) => { let s = 0; for (const r of ch) s += r[t]; return s / 12; }));
      else ch.forEach((r, k) => add(`chroma_${k}`, r));
    }
    return { names, frames };
  }
  function chromaStft(S) {                                          // chroma_stft on power, with the file's tuning; ∞-normalised per frame
    const P = S.map((s) => Float64Array.from(s, (v) => v * v)), CH = chromaFilter(sr, nFft, estimateTuning(P, sr, nFft)), T = S.length;
    const out = Array.from({ length: 12 }, () => new Float64Array(T));
    for (let t = 0; t < T; t++) { const raw = new Float64Array(12); let mx = 0;
      for (let c = 0; c < 12; c++) { let a = 0; const w = CH[c]; for (let b = 0; b < NB; b++) a += w[b] * P[t][b]; raw[c] = a; if (Math.abs(a) > mx) mx = Math.abs(a); }
      for (let c = 0; c < 12; c++) out[c][t] = mx > TINY32 ? raw[c] / mx : raw[c]; }
    return out;
  }
  // features.clip_frame_ranges
  function ranges(t0, t1, T) {
    return t0.map((a0, i) => { const a = a0 * sr, b = t1[i] * sr; let f0 = Math.ceil(a / hop), f1 = Math.floor((b - 1) / hop) + 1;
      const mid = Math.min(Math.max(Math.round((a + b) / 2 / hop), 0), T - 1);
      if (f1 <= f0) { f0 = mid; f1 = mid + 1; } else { f0 = Math.min(Math.max(f0, 0), T - 1); f1 = Math.min(Math.max(f1, 1), T); }
      return [f0, Math.max(f1, f0 + 1)]; });
  }
  // features.summarize: nanmean / nanstd / nanmin / nanmax per clip and over the file, columns <name>_<stat>
  const STAT = { mean: (x) => x.reduce((s, v) => s + v, 0) / x.length, std: (x) => { const m = x.reduce((s, v) => s + v, 0) / x.length; return Math.sqrt(x.reduce((s, v) => s + (v - m) ** 2, 0) / x.length); },
                 min: (x) => x.reduce((a, b) => Math.min(a, b), Infinity), max: (x) => x.reduce((a, b) => Math.max(a, b), -Infinity) };
  function summarize({ names, frames }, R, stats) {
    const cols = names.flatMap((n) => stats.map((s) => `${n}_${s}`)), fin = (fr, a, b) => { const o = []; for (let t = a; t < b; t++) if (!Number.isNaN(fr[t])) o.push(fr[t]); return o; };
    const one = (a, b) => frames.flatMap((fr) => { const x = fin(fr, a, b); return stats.map((s) => x.length ? STAT[s](x) : NaN); });
    return { cols, rows: R.map(([a, b]) => one(a, b)), whole: one(0, frames.length ? frames[0].length : 0) };
  }
  function energyExtras(rms, R) {                                   // features._energy_extras: rms_db, dynamic_range_db
    const ex = (a, b) => { const r = Array.from(rms.slice(a, b), (v) => Math.max(v, 1e-5)), m = r.reduce((p, q) => p + q, 0) / r.length, s = r.slice().sort((p, q) => p - q);
      const pct = (q) => { const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos); return s[lo] + (s[hi] - s[lo]) * (pos - lo); };
      return [20 * Math.log10(m), 20 * Math.log10(pct(0.95) / pct(0.10))]; };
    return { cols: ["rms_db", "dynamic_range_db"], rows: R.map(([a, b]) => ex(a, b)), whole: ex(0, rms.length) };
  }
  // librosa.onset.onset_detect(onset_envelope, sr, hop, backtrack, delta, wait, …) → frames
  function onsetDetect(env, o = {}) {
    const n = env.length; let lo = Infinity, hi = -Infinity; for (const v of env) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    const x = Float64Array.from(env, (v) => (v - lo) / ((hi - lo) + TINY32));
    if (!x.some((v) => v) || !x.every(Number.isFinite)) return [];
    const fd = (v) => Math.floor(v * sr / hop), preMax = Math.ceil(o.pre_max ?? fd(0.03)), postMax = Math.ceil(o.post_max ?? fd(0) + 1),
          preAvg = Math.ceil(o.pre_avg ?? fd(0.10)), postAvg = Math.ceil(o.post_avg ?? fd(0.10) + 1), wait = Math.ceil(o.wait ?? fd(0.03)), delta = o.delta ?? 0.07;
    const peaks = [], mx = (a, b) => { let m = -Infinity; for (let k = a; k < b; k++) m = Math.max(m, x[k]); return m; }, av = (a, b) => { let s = 0; for (let k = a; k < b; k++) s += x[k]; return s / (b - a); };
    let nn = 1;                                                     // util.__peak_pick, frame 0 special-cased
    if (x[0] >= mx(0, Math.min(postMax, n)) && x[0] >= av(0, Math.min(postAvg, n)) + delta) { peaks.push(0); nn = wait + 1; }
    while (nn < n) { const m = mx(Math.max(0, nn - preMax), Math.min(nn + postMax, n));
      if (x[nn] !== m) { nn++; continue; }
      if (!(x[nn] >= av(Math.max(0, nn - preAvg), Math.min(nn + postAvg, n)) + delta)) { nn++; continue; }
      peaks.push(nn); nn += wait + 1; }
    if (!o.backtrack) return peaks;
    // onset_backtrack(events, energy = the normalised envelope): the nearest preceding local minimum
    const minima = [0]; for (let i = 1; i < n - 1; i++) if (x[i] <= x[i - 1] && x[i] < x[i + 1]) minima.push(i);
    const mins = [...new Set(minima)].sort((a, b) => a - b);
    return peaks.map((p) => { let best = mins[0]; for (const m2 of mins) { if (m2 <= p) best = m2; else break; } return best; });
  }
  // features._rhythm + rhythm_events, from the onset envelope
  function rhythm(env, R, durs, durTotal, winS = 8.0) {
    const win = Math.max(16, roundEven(winS * sr / hop)), half = win >> 1, n = env.length;
    const pad = new Float64Array(n + 2 * half);
    for (let i = 0; i < half; i++) { pad[i] = env[0] * i / half; pad[n + 2 * half - 1 - i] = env[n - 1] * i / half; }   // linear_ramp to 0
    for (let i = 0; i < n; i++) pad[half + i] = env[i];
    let F = 1; while (F < 2 * win) F <<= 1;
    const fftN = fftOf(F), hw = hann(win), bpm = Float64Array.from({ length: win }, (_, k) => k === 0 ? Infinity : 60 * sr / (hop * k));
    const prior = Float64Array.from(bpm, (b) => (isFinite(b) && b >= 30 && b <= 320) ? -0.5 * (Math.log2(b) - Math.log2(120)) ** 2 : -Infinity);
    const band = Array.from(bpm, (b) => isFinite(b) && b >= 30 && b <= 300);
    const TG = new Array(n), re = new Float64Array(F), im = new Float64Array(F);
    for (let t = 0; t < n; t++) {
      re.fill(0); im.fill(0); for (let i = 0; i < win; i++) re[i] = pad[t + i] * hw[i];
      fftN(re, im); for (let i = 0; i < F; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; } fftN(re, im);
      const ac = new Float32Array(win); let mx = 0; for (let k = 0; k < win; k++) { ac[k] = re[k] / F; if (Math.abs(ac[k]) > mx) mx = Math.abs(ac[k]); }
      if (mx > 0) for (let k = 0; k < win; k++) ac[k] /= mx; TG[t] = ac;
    }
    const on = onsetDetect(env), onCum = new Int32Array(n + 1);
    { const m = new Uint8Array(n); for (const t of on) m[Math.min(Math.max(t, 0), n - 1)] = 1; for (let t = 0; t < n; t++) onCum[t + 1] = onCum[t] + m[t]; }
    const one = (a, b, dur) => {
      const g = new Float64Array(win); for (let t = a; t < b; t++) for (let k = 0; k < win; k++) g[k] += TG[t][k]; for (let k = 0; k < win; k++) g[k] /= Math.max(1, b - a);
      let best = 1, bv = -Infinity; for (let k = 1; k < win; k++) { const v = Math.log1p(1e6 * g[k]) + prior[k]; if (v > bv) { bv = v; best = k; } }
      const b2 = []; for (let k = 0; k < win; k++) if (band[k]) b2.push(g[k]); b2.sort((p, q) => p - q);
      const strength = b2.length ? b2[b2.length - 1] - (b2.length % 2 ? b2[b2.length >> 1] : 0.5 * (b2[b2.length / 2 - 1] + b2[b2.length / 2])) : NaN;
      return [bpm[best], (onCum[Math.min(b, n)] - onCum[Math.min(a, n)]) / Math.max(dur, 1e-6), strength];
    };
    let hi = 0; for (const v of env) hi = Math.max(hi, v);
    return { cols: ["tempo", "onset_rate", "beat_strength"], rows: R.map(([a, b], i) => one(a, b, durs[i])), whole: one(0, n, durTotal),
             onset_t: on.map((t) => t * hop / sr), onset_s: on.map((t) => env[t] / Math.max(hi, 1e-9)) };
  }
  // librosa.beat.beat_track(onset_envelope=env, sr, hop) (librosa 0.11): the global tempo (feature.tempo: mean tempogram
  // over an 8 s window, log-normal prior at 120 BPM, nothing above 320 BPM), then the dynamic programme (tightness 100,
  // trim). Kept as in librosa: np.round's half-to-even, the local score's same-mode convolution that skips frame 0, the
  // 0.01 · max threshold before the first beat, the last beat among cumscore's local maxima ≥ half their median.
  function beatTrack(env) {
    const n = env.length; if (!n || !env.some((v) => v)) return { tempo: 0, beats: [] };
    const win = Math.floor(8.0 * sr / hop), half = win >> 1;         // time_to_frames(ac_size = 8.0) floors
    const pad = new Float64Array(n + 2 * half);
    for (let i = 0; i < half; i++) { pad[i] = env[0] * i / half; pad[n + 2 * half - 1 - i] = env[n - 1] * i / half; }
    for (let i = 0; i < n; i++) pad[half + i] = env[i];
    let F = 1; while (F < 2 * win) F <<= 1;
    const fftN = fftOf(F), hw = hann(win), g = new Float64Array(win), re = new Float64Array(F), im = new Float64Array(F);
    for (let t = 0; t < n; t++) {
      re.fill(0); im.fill(0); for (let i = 0; i < win; i++) re[i] = pad[t + i] * hw[i];
      fftN(re, im); for (let i = 0; i < F; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; } fftN(re, im);
      let mx = 0; for (let k = 0; k < win; k++) mx = Math.max(mx, Math.abs(re[k])); if (mx > 0) for (let k = 0; k < win; k++) g[k] += re[k] / mx;
    }
    for (let k = 0; k < win; k++) g[k] /= n;
    let maxIdx = 0; const bpms = Float64Array.from({ length: win }, (_, k) => k === 0 ? Infinity : 60 * sr / (hop * k));
    while (maxIdx < win && !(bpms[maxIdx] < 320)) maxIdx++;
    let best = 0, bv = -Infinity;
    for (let k = maxIdx; k < win; k++) { const v = Math.log1p(1e6 * g[k]) - 0.5 * (Math.log2(bpms[k]) - Math.log2(120)) ** 2; if (v > bv) { bv = v; best = k; } }
    const tempo = bpms[best], fpb = roundEven(sr / hop * 60 / tempo);
    let mu = 0; for (const v of env) mu += v; mu /= n; let sd = 0; for (const v of env) sd += (v - mu) ** 2; sd = Math.sqrt(sd / Math.max(1, n - 1));
    const on = Float64Array.from(env, (v) => v / (sd + TINY32)), K = 2 * fpb + 1, K2 = K >> 1;
    const w = Float64Array.from({ length: K }, (_, k) => Math.exp(-0.5 * ((k - fpb) * 32 / fpb) ** 2)), ls = new Float64Array(n);
    for (let i = 0; i < n; i++) { let s = 0; for (let k = Math.max(0, i + K2 - n + 1); k < Math.min(i + K2, K); k++) s += w[k] * on[i + K2 - k]; ls[i] = s; }
    let lmax = -Infinity; for (const v of ls) lmax = Math.max(lmax, v);
    const thr = 0.01 * lmax, back = new Int32Array(n), cum = new Float64Array(n), lf = Math.log(fpb), h2 = roundEven(fpb / 2); let first = true;
    for (let i = 0; i < n; i++) {
      let bs = -Infinity, loc0 = -1;
      for (let loc = i - h2; loc > i - 2 * fpb - 1; loc--) { if (loc < 0) break; const sc = cum[loc] - 100 * (Math.log(i - loc) - lf) ** 2; if (sc > bs) { bs = sc; loc0 = loc; } }
      cum[i] = loc0 >= 0 ? ls[i] + bs : ls[i];
      if (first && ls[i] < thr) back[i] = -1; else { back[i] = loc0; first = false; }
    }
    const isMax = (i) => cum[i] > (i > 0 ? cum[i - 1] : cum[0]) && cum[i] >= (i < n - 1 ? cum[i + 1] : cum[n - 1]);
    const maxima = []; for (let i = 0; i < n; i++) if (isMax(i)) maxima.push(cum[i]); maxima.sort((a, b) => a - b);
    const med = maxima.length ? (maxima.length % 2 ? maxima[maxima.length >> 1] : 0.5 * (maxima[maxima.length / 2 - 1] + maxima[maxima.length / 2])) : 0;
    let tail = n - 1; for (let i = n - 1; i >= 0; i--) if (isMax(i) && cum[i] >= 0.5 * med) { tail = i; break; }
    const beat = new Uint8Array(n); for (let i = tail; i >= 0; i = back[i]) beat[i] = 1;
    const bl = []; for (let i = 0; i < n; i++) if (beat[i]) bl.push(ls[i]);
    const hw5 = [0, 0.5, 1, 0.5, 0], conv = new Float64Array(bl.length + 4);
    for (let a = 0; a < bl.length; a++) for (let k = 0; k < 5; k++) conv[a + k] += bl[a] * hw5[k];
    const sm = conv.slice(2, Math.min(conv.length, n + 2)); let ms = 0; for (const v of sm) ms += v * v; const trim = sm.length ? 0.5 * Math.sqrt(ms / sm.length) : 0;
    for (let i = 0; i < n && ls[i] <= trim; i++) beat[i] = 0;
    for (let i = n - 1; i >= 0 && ls[i] <= trim; i--) beat[i] = 0;
    const beats = []; for (let i = 0; i < n; i++) if (beat[i]) beats.push(i * hop / sr);
    return { tempo, beats };
  }
  const api = { sr, nFft, hop, fileCtx, group, ranges, summarize, energyExtras, onsetDetect, rhythm, beatTrack, chromaStft };
  INST.set(key, api); return api;
}

// ---------------------------------------------------------------- segmentation (dmc/segment.py)
const EPS = 1e-6;
export function fixedSegments(dur, size = 2.0, overlap = 0.0, minTail = 0.5) {
  if (dur <= size + EPS) return [[0, dur]];
  const hop = size * (1 - overlap), segs = []; for (let k = 0; k * hop + size <= dur + EPS; k++) segs.push([k * hop, k * hop + size]);
  const tail = dur - segs[segs.length - 1][1];
  if (tail > EPS && tail >= minTail && dur - size > segs[segs.length - 1][0] + EPS) segs.push([dur - size, dur]);
  return segs;
}
export function regularize(bounds, dur, minLen, maxLen) {        // merge pieces < min_len, split pieces > max_len
  const b = [...new Set([0, dur, ...bounds.map(Number).filter((x) => x > EPS && x < dur - EPS)])].sort((p, q) => p - q);
  const merged = []; let start = b[0];
  for (const end of b.slice(1)) if (end - start >= minLen) { merged.push([start, end]); start = end; }
  if (start < dur - EPS) { if (merged.length) merged[merged.length - 1][1] = dur; else merged.push([start, dur]); }
  const out = [];
  for (const [s, e] of merged) { const n = maxLen && e - s > maxLen ? Math.ceil((e - s) / maxLen - EPS) : 1, step = (e - s) / n;
    const edges = Array.from({ length: n + 1 }, (_, k) => k === n ? e : s + k * step); for (let k = 0; k < n; k++) out.push([edges[k], edges[k + 1]]); }
  return out;
}
export function snapToZeroCrossing(x, s, radius) {               // segment.snap_to_zero_crossing
  const n = x.length; if (s <= 0 || s >= n) return Math.min(Math.max(s, 0), n);
  const lo = Math.max(0, s - radius), hi = Math.min(n - 1, s + radius); if (hi - lo + 1 < 2) return s;
  let best = s, bd = Infinity;
  for (let i = lo; i < hi; i++) if ((x[i] <= 0) !== (x[i + 1] <= 0)) { const j = Math.abs(x[i + 1]) < Math.abs(x[i]) ? i + 1 : i; if (Math.abs(j - s) < bd) { bd = Math.abs(j - s); best = j; } }
  return best;
}
export function toNativeSamples(segs, yNat, srNat, snap = {}) {  // segment.to_native_samples: seconds → native samples, edges snapped, unique starts
  const n = yNat.length, radius = roundEven((snap.radius_ms ?? 5.0) * 1e-3 * srNat), memo = new Map(), on = snap.enabled ?? true;
  const conv = (t) => { const s = roundEven(t * srNat); if (s <= 0) return 0; if (s >= n) return n; if (!on || radius < 1) return s;
    if (!memo.has(s)) memo.set(s, snapToZeroCrossing(yNat, s, radius)); return memo.get(s); };
  const st = [], en = [];
  for (const [t0, t1] of segs) { let a = conv(t0), b = conv(t1); if (b - a < 2) { a = roundEven(t0 * srNat); b = Math.min(n, roundEven(t1 * srNat)); } if (b > a) { st.push(a); en.push(b); } }
  const seen = new Set(), keep = [];
  st.forEach((a, i) => { const ms = roundEven(a / srNat * 1000); if (!seen.has(ms)) { seen.add(ms); keep.push(i); } });
  return { starts: keep.map((i) => st[i]), ends: keep.map((i) => en[i]) };
}
export function normalizeAudio(y, audio = {}) {                  // segment.normalize: none | peak | rms (rms_target_db, clipped ±1)
  const m = audio.normalize || "none"; if (m === "none" || !y.length) return y;
  if (m === "peak") { let p = 0; for (const v of y) p = Math.max(p, Math.abs(v)); if (p > 0) return Float32Array.from(y, (v) => v / p); return y; }
  if (m === "rms") { let s = 0; for (const v of y) s += v * v; const r = Math.sqrt(s / y.length); if (r > 0) { const g = 10 ** ((audio.rms_target_db ?? -20) / 20) / r; return Float32Array.from(y, (v) => Math.max(-1, Math.min(1, v * g))); } return y; }
  throw new Error("audio.normalize must be none|peak|rms");
}

// ---------------------------------------------------------------- resampling (librosa.resample's default, soxr "HQ")
// soxr HQ is linear-phase with the passband to 0.913 and the stopband from 1.0 of the lower Nyquist, ~125 dB down. Here: an
// arbitrary-ratio polyphase filter to that specification (Kaiser-windowed sinc), output length ceil(n · to / from) as librosa.
// Against librosa.resample: SNR 85 dB (48 → 22.05 kHz) and 91 dB (48 → 44.1 kHz) on music (TESTS §9).
function bessel0(x) { let s = 1, t = 1; for (let k = 1; k < 60; k++) { t *= (x / (2 * k)) ** 2; s += t; if (t < 1e-17 * s) break; } return s; }
const gcd = (a, b) => { while (b) [a, b] = [b, a % b]; return a; };
export function resample(y, from, to, { pass = 0.913, stop = 1.0, atten = 140 } = {}) {
  from = Math.round(from); to = Math.round(to); if (from === to) return Float32Array.from(y);
  const g = gcd(from, to), up = to / g, down = from / g, r = to / from, nyq = Math.min(1, r) / 2;
  const fc = nyq * (pass + stop) / 2, tw = nyq * (stop - pass), beta = 0.1102 * (atten - 8.7), i0b = bessel0(beta);
  const half = Math.ceil((atten - 8) / (2.285 * 2 * Math.PI * tw) / 2), L = 2 * half;
  const tap = (x) => { const u = x / half; if (Math.abs(u) > 1) return 0; return (x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x)) * bessel0(beta * Math.sqrt(1 - u * u)) / i0b; };
  const table = up <= 4096 ? Array.from({ length: up }, (_, p) => Float64Array.from({ length: L }, (_, j) => tap(p / up + half - 1 - j))) : null;
  const nOut = Math.ceil(y.length * r), out = new Float32Array(nOut), n0 = y.length;
  for (let n = 0; n < nOut; n++) {
    const num = n * down, c = Math.floor(num / up), p = num - c * up, h = table ? table[p] : Float64Array.from({ length: L }, (_, j) => tap(p / up + half - 1 - j));
    let s = 0, k = c - half + 1, j = 0; if (k < 0) { j = -k; k = 0; }
    for (; j < L && k < n0; j++, k++) s += y[k] * h[j];
    out[n] = s;
  }
  return out;
}

// the 22050 Hz defaults, for the tests and older callers
export const beatTrack = (env) => makeMir().beatTrack(env);
export { fftFactory, roundEven, fftOf, stftMag, hann, melFilter, chromaFilter, powerToDb };
