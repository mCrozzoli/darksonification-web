// Uncanny Listening — DarkLibrosa's summary mode in the browser (2026-10-27).
// A port of what darksonification/preprocessing/darklibrosa.py computed for Ana's features on 2026-01-23
// (data_{si,no}_{l0,l1}_20260123_1117.csv), with librosa 0.11. That run was the code of early 2026 (the copy kept in
// projects/designs/darkquake/darkquake_headless_20260707_223104/…/darklibrosa.py), which differs from today's file in two
// places that show in her data:
//   • spectral contrast with n_bands = 1 kept as two bands (spectral_contrast_0, _1), not averaged into one;
//   • rhythm in a separate pass after the parallel run, on librosa.load(sr=44100) of the whole file: tempo =
//     librosa.feature.tempo, n_beats = the number of onsets (onset_detect), beat_density = n_beats / duration, and the
//     same three values written on every row of the file (L0 and each L1 segment).
// Checked in Python first: today's librosa with exactly this recipe reproduces her cache to float32 (TESTS P0).
//
// Per file (sound_normalize + extract of notebook cells 10–11):
//   librosa.load(sr=None) → mono (float32 mean) → resample to 44.1 kHz if needed (soxr HQ) → peak normalise → clip;
//   L0 = the whole file, L1 = 10 s windows without overlap plus a last window ending at the file's end; every window gets
//   its own STFT (centre, zero padding at the window's edges), its own dB reference and its own tuning estimate, as
//   DarkLibrosa's _process_windowed re-runs _extract_frame_features on the window alone.
//   Frame features (n_fft 2048, hop 512): zcr, rms, spectral centroid / bandwidth / rolloff (0.85) / flatness /
//   contrast (n_bands 1) / flux (= onset strength), mfcc_0, chroma (chroma_stft, the mean of the 12 classes);
//   each summarised as mean / median / std / min / max.
// The frames are streamed (two FFT passes per window: features + tuning, then chroma) so a one-hour file stays small.
import { fftOf, hann, roundEven, resample, melFilter, chromaFilter, powerToDb } from "./mir.js";

export const ANA_PRESET = {
  id: "ana_2026_01",
  sr: 44100, nFft: 2048, hop: 512, window_s: 10, overlap: 0,
  normalize: "peak", clip: true, format: "flac",
  rolloff_percent: 0.85, contrast_bands: 1, n_mfcc: 1,
};
export const FEATURES = ["zcr", "rms", "spectral_centroid", "spectral_bandwidth", "spectral_rolloff", "spectral_flatness",
  "spectral_contrast_0", "spectral_contrast_1", "spectral_flux", "mfcc_0", "chroma"];
export const STATS = ["mean", "median", "std", "min", "max"];
export const COLUMNS = [...FEATURES.flatMap((f) => STATS.map((s) => `${f}_${s}`)), "tempo", "n_beats", "beat_density"];

const TINY32 = 1.1754944e-38, f32 = Math.fround;

// librosa.pitch_tuning(pitches[mag >= median(mag)], resolution 0.01) in float32, with numpy's histogram edges (linspace)
function tuning32(pitches, mags) {
  if (!pitches.length) return 0;
  const so = Float32Array.from(mags).sort(), m = so.length, thr = m % 2 ? so[(m - 1) / 2] : f32(f32(so[m / 2 - 1] + so[m / 2]) / 2);
  const counts = new Int32Array(100), edge = (i) => i === 100 ? 0.5 : i * 0.01 + -0.5;
  for (let i = 0; i < pitches.length; i++) {
    if (!(mags[i] >= thr) || !(pitches[i] > 0)) continue;
    let r = f32(12 * f32(Math.log2(f32(pitches[i] / 27.5)))); r = f32(r - Math.floor(r)); if (r >= 0.5) r = f32(r - 1);
    let k = Math.floor((r - -0.5) * 100); if (k > 99) k = 99; if (k < 0) k = 0;
    if (r < edge(k)) k--; else if (k < 99 && r >= edge(k + 1)) k++;
    counts[k]++;
  }
  let best = 0; for (let k = 1; k < 100; k++) if (counts[k] > counts[best]) best = k;
  return edge(best);
}

// ---------------------------------------------------------------- one window → per-frame features
function makeExtractor(cfg) {
  const { sr, nFft, hop } = cfg, NB = nFft / 2 + 1, W = hann(nFft), fft = fftOf(nFft), pad = nFft / 2;
  const FREQ = Float64Array.from({ length: NB }, (_, b) => b * sr / nFft), MEL = melFilter(sr, nFft), nM = MEL.length;
  const melLo = new Int32Array(nM), melHi = new Int32Array(nM);
  for (let i = 0; i < nM; i++) { let lo = NB, hi = -1; for (let b = 0; b < NB; b++) if (MEL[i][b]) { lo = Math.min(lo, b); hi = b; } melLo[i] = lo; melHi[i] = hi; }
  // spectral contrast bands (librosa: octave edges from fmin 200 Hz; the first band below 200 Hz, the last up to Nyquist)
  const nb = cfg.contrast_bands, octa = [0, ...Array.from({ length: nb + 1 }, (_, i) => 200 * 2 ** i)], BANDS = [];
  for (let k = 0; k <= nb; k++) {
    const band = []; for (let b = 0; b < NB; b++) if (FREQ[b] >= octa[k] && FREQ[b] <= octa[k + 1]) band.push(b);
    let sel = band.slice(); if (k > 0) sel = [band[0] - 1, ...sel]; if (k === nb) for (let b = band[band.length - 1] + 1; b < NB; b++) sel.push(b);
    const sub = k < nb ? sel.slice(0, -1) : sel; BANDS.push({ sub: Int32Array.from(sub), q: Math.max(1, roundEven(0.02 * sel.length)) });
  }
  const re = new Float64Array(nFft), im = new Float64Array(nFft), mag = new Float32Array(NB), pw = new Float64Array(NB), p32 = new Float32Array(NB);
  const frameMag = (y, off, n, t) => {                                 // |STFT| of frame t: centre, zero padding outside [off, off+n)
    const s0 = t * hop - pad;
    for (let i = 0; i < nFft; i++) { const k = s0 + i; re[i] = (k >= 0 && k < n ? y[off + k] : 0) * W[i]; im[i] = 0; }
    fft(re, im); for (let b = 0; b < NB; b++) mag[b] = Math.hypot(re[b], im[b]);
  };

  // the features of y[off, off+n) (one DarkLibrosa window) → {name: Float64Array(T)}, and the onset envelope
  return function extract(y, off, n) {
    const T = 1 + Math.floor(n / hop), F = {};
    for (const f of FEATURES) F[f] = new Float64Array(T);
    // time domain: zcr (frame 2048, centre, edge padding, threshold 1e-10) and rms (frame 2048, centre, zero padding)
    for (let t = 0; t < T; t++) {
      const s0 = t * hop - 1024; let cnt = 0, prev = null, e = 0;
      for (let i = 0; i < 2048; i++) {
        const k = s0 + i, ke = Math.min(Math.max(k, 0), n - 1); let v = y[off + ke]; if (Math.abs(v) <= 1e-10) v = 0;
        const neg = v < 0 || Object.is(v, -0); if (prev !== null && neg !== prev) cnt++; prev = neg;
        const r = k >= 0 && k < n ? y[off + k] : 0; e += r * r;
      }
      F.zcr[t] = cnt / 2048; F.rms[t] = Math.sqrt(e / 2048);
    }
    // pass 1: spectral shape, contrast peak / valley, the mel power spectrogram, the tuning peaks (piptrack on power)
    const mel = new Float32Array(T * nM), pk = Array.from({ length: nb + 1 }, () => new Float64Array(T)), vl = Array.from({ length: nb + 1 }, () => new Float64Array(T));
    const pitches = [], mags = [], rp = cfg.rolloff_percent, fmin = 150, fmax = 4000;
    let sortBuf = new Float32Array(NB);
    for (let t = 0; t < T; t++) {
      frameMag(y, off, n, t);
      let tot = 0; for (let b = 0; b < NB; b++) tot += mag[b];
      let cc = 0; for (let b = 0; b < NB; b++) cc += FREQ[b] * mag[b] / (tot || 1); F.spectral_centroid[t] = tot ? cc : 0;
      let v = 0; for (let b = 0; b < NB; b++) v += (mag[b] / (tot || 1)) * (FREQ[b] - cc) ** 2; F.spectral_bandwidth[t] = Math.sqrt(v);
      let cum = 0, r = FREQ[NB - 1]; for (let b = 0; b < NB; b++) { cum += mag[b]; if (cum >= rp * tot) { r = FREQ[b]; break; } } F.spectral_rolloff[t] = r;
      let lg = 0, am = 0, mx = 0;
      for (let b = 0; b < NB; b++) { const p = mag[b] * mag[b]; pw[b] = p; if (p > mx) mx = p; const pt = Math.max(1e-10, p); lg += Math.log(pt); am += pt; }
      F.spectral_flatness[t] = Math.exp(lg / NB) / (am / NB);
      for (let k = 0; k <= nb; k++) {
        const { sub, q } = BANDS[k], m = sub.length; if (sortBuf.length < m) sortBuf = new Float32Array(m);
        const sb = sortBuf.subarray(0, m); for (let i = 0; i < m; i++) sb[i] = mag[sub[i]]; sb.sort();
        let a = 0, z = 0; for (let i = 0; i < q; i++) { a += sb[i]; z += sb[m - 1 - i]; } vl[k][t] = a / q; pk[k][t] = z / q;
      }
      const mo = t * nM;
      for (let i = 0; i < nM; i++) { const w = MEL[i]; let a = 0; for (let b = melLo[i]; b <= melHi[i]; b++) a += w[b] * pw[b]; mel[mo + i] = a; }
      // librosa piptrack(S = power, threshold 0.1 · the frame's max) in float32, as librosa computes it on a float32 spectrogram:
      // its tuning histogram is often nearly flat (top bins a few counts apart), so float64 here can move the estimate by 0.01
      for (let b = 0; b < NB; b++) p32[b] = mag[b] * mag[b];
      const ref = f32(f32(0.1) * f32(mx)), X = (b) => (p32[b] > ref ? p32[b] : 0);
      for (let b = 1; b < NB - 1; b++) {
        const f = FREQ[b]; if (f < fmin || f >= fmax) continue;
        const x = X(b); if (!(x > X(b - 1) && x >= X(b + 1))) continue;
        const s1 = p32[b + 1], s0 = p32[b], sm = p32[b - 1];
        const avg = f32(f32(s1 - sm) / 2), pa = f32(f32(s1 + sm) - f32(2 * s0)), pb = f32(f32(s1 - sm) / 2);   // np.gradient · _pi_stencil
        const sh = Math.abs(pb) >= Math.abs(pa) ? 0 : f32(-pb / pa), pitch = f32((b + sh) * (sr / nFft));
        if (pitch > 0) { pitches.push(pitch); mags.push(f32(s0 + f32(f32(0.5 * avg) * sh))); }
      }
    }
    powerToDb(pk); powerToDb(vl);
    for (let k = 0; k <= nb; k++) { const c = F[`spectral_contrast_${k}`]; for (let t = 0; t < T; t++) c[t] = pk[k][t] - vl[k][t]; }
    // the mel spectrogram in dB (ref 1, amin 1e-10, top_db 80 over the window): mfcc_0 (DCT-II ortho, k = 0) and the onset strength
    let mmax = -Infinity; for (let i = 0; i < mel.length; i++) { const d = 10 * Math.log10(Math.max(1e-10, mel[i])); mel[i] = d; if (d > mmax) mmax = d; }
    for (let i = 0; i < mel.length; i++) if (mel[i] < mmax - 80) mel[i] = mmax - 80;
    const c0 = Math.sqrt(1 / nM);
    for (let t = 0; t < T; t++) { let s = 0; for (let i = 0; i < nM; i++) s += mel[t * nM + i]; F.mfcc_0[t] = s * c0; }
    const env = F.spectral_flux, lagPad = 1 + Math.floor(2048 / (2 * hop));   // onset_strength: lag 1, centre: pad lag + n_fft // (2 hop)
    for (let t = 1; t < T; t++) { let a = 0; for (let i = 0; i < nM; i++) a += Math.max(0, mel[t * nM + i] - mel[(t - 1) * nM + i]); const j = t - 1 + lagPad; if (j < T) env[j] = a / nM; }
    // pass 2: chroma_stft with this window's tuning, ∞-normalised per frame, then the mean of the 12 classes
    const CH = chromaFilter(sr, nFft, tuning32(pitches, mags)), raw = new Float64Array(12);
    for (let t = 0; t < T; t++) {
      frameMag(y, off, n, t); for (let b = 0; b < NB; b++) pw[b] = mag[b] * mag[b];
      let mx = 0; for (let c = 0; c < 12; c++) { let a = 0; const w = CH[c]; for (let b = 0; b < NB; b++) a += w[b] * pw[b]; raw[c] = a; if (Math.abs(a) > mx) mx = Math.abs(a); }
      let s = 0; for (let c = 0; c < 12; c++) s += mx > TINY32 ? raw[c] / mx : raw[c]; F.chroma[t] = s / 12;
    }
    return F;
  };
}

// numpy's mean / median / std (ddof 0) / min / max over the frames
function summarize(F) {
  const row = {};
  for (const f of FEATURES) {
    const x = F[f], n = x.length; let s = 0, lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { s += x[i]; if (x[i] < lo) lo = x[i]; if (x[i] > hi) hi = x[i]; }
    const m = s / n; let v = 0; for (let i = 0; i < n; i++) v += (x[i] - m) ** 2;
    const so = Float64Array.from(x).sort(), med = n % 2 ? so[(n - 1) / 2] : 0.5 * (so[n / 2 - 1] + so[n / 2]);
    row[`${f}_mean`] = m; row[`${f}_median`] = med; row[`${f}_std`] = Math.sqrt(v / n); row[`${f}_min`] = lo; row[`${f}_max`] = hi;
  }
  return row;
}

// librosa.feature.tempo(onset_envelope, sr, hop): the mean tempogram over an 8 s window, log-normal prior at 120 BPM,
// nothing above 320 BPM (the same steps as core/mir.js beatTrack's first half, which is tested equal to librosa)
function globalTempo(env, sr, hop) {
  const n = env.length; if (!n) return 0;
  const win = Math.floor(8.0 * sr / hop), half = win >> 1, pad = new Float64Array(n + 2 * half);
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
  const bpms = Float64Array.from({ length: win }, (_, k) => k === 0 ? Infinity : 60 * sr / (hop * k));
  let k0 = 0; while (k0 < win && !(bpms[k0] < 320)) k0++;
  let best = 0, bv = -Infinity;
  for (let k = k0; k < win; k++) { const v = Math.log1p(1e6 * g[k]) - 0.5 * (Math.log2(bpms[k]) - Math.log2(120)) ** 2; if (v > bv) { bv = v; best = k; } }
  return bpms[best];
}
// librosa.onset.onset_detect(onset_envelope) with its defaults → the number of onsets (util.peak_pick on the normalised envelope)
function countOnsets(env, sr, hop) {
  const n = env.length; let lo = Infinity, hi = -Infinity; for (const v of env) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const x = Float64Array.from(env, (v) => (v - lo) / ((hi - lo) + TINY32));
  if (!x.some((v) => v) || !x.every(Number.isFinite)) return 0;
  const fd = (v) => Math.floor(v * sr / hop), preMax = Math.ceil(fd(0.03)), postMax = Math.ceil(fd(0) + 1), preAvg = Math.ceil(fd(0.10)), postAvg = Math.ceil(fd(0.10) + 1), wait = Math.ceil(fd(0.03)), delta = 0.07;
  const mx = (a, b) => { let m = -Infinity; for (let k = a; k < b; k++) m = Math.max(m, x[k]); return m; }, av = (a, b) => { let s = 0; for (let k = a; k < b; k++) s += x[k]; return s / (b - a); };
  let cnt = 0, nn = 1;
  if (x[0] >= mx(0, Math.min(postMax, n)) && x[0] >= av(0, Math.min(postAvg, n)) + delta) { cnt++; nn = wait + 1; }
  while (nn < n) { const m = mx(Math.max(0, nn - preMax), Math.min(nn + postMax, n));
    if (x[nn] !== m) { nn++; continue; }
    if (!(x[nn] >= av(Math.max(0, nn - preAvg), Math.min(nn + postAvg, n)) + delta)) { nn++; continue; }
    cnt++; nn += wait + 1; }
  return cnt;
}

// DarkLibrosa._create_windows: [start, start + W) every W samples, plus [len − W, len) when the file does not divide evenly
export function windows(len, sr, size, overlap = 0) {
  const W = Math.trunc(size * sr), H = Math.trunc(W * (1 - overlap)), out = [];
  for (let s = 0; s <= len - W; s += H) out.push([s, s + W]);
  if (len > W && len % H !== 0) out.push([len - W, len]);
  return out;
}

// One file. yNat: the mono native-rate signal (Float32Array, consumed); returns {duration, l0: row, l1: [rows]}.
// The rhythm values use the onset envelope of the whole file, as the separate rhythm pass did (on the signal before the
// peak normalisation: the envelope is the same, since the dB mel spectrogram only shifts with gain).
export function analyseFile(yNat, srNat, cfg = ANA_PRESET, onProgress = null) {
  const sr = cfg.sr;
  let y = srNat === sr ? yNat : resample(yNat, srNat, sr);
  let peak = 0; for (let i = 0; i < y.length; i++) { const a = Math.abs(y[i]); if (a > peak) peak = a; }
  if (cfg.normalize === "peak" && peak > 0) for (let i = 0; i < y.length; i++) y[i] = y[i] / peak;   // float32 division, as numpy
  if (cfg.clip) for (let i = 0; i < y.length; i++) y[i] = Math.max(-1, Math.min(1, y[i]));
  const n = y.length, duration = n / sr, extract = makeExtractor(cfg);
  const Fw = extract(y, 0, n), l0 = Object.assign({ window_start: 0, window_end: duration }, summarize(Fw));
  const rhythm = { tempo: globalTempo(Fw.spectral_flux, sr, cfg.hop) };
  rhythm.n_beats = countOnsets(Fw.spectral_flux, sr, cfg.hop); rhythm.beat_density = duration > 0 ? rhythm.n_beats / duration : 0;
  Object.assign(l0, rhythm);
  const W = windows(n, sr, cfg.window_s, cfg.overlap), l1 = [];
  W.forEach(([a, b], i) => { l1.push(Object.assign({ window_start: a / sr, window_end: b / sr }, summarize(extract(y, a, b - a)), rhythm)); if (onProgress) onProgress(i + 1, W.length); });
  return { duration, sr_native: srNat, l0, l1 };
}
