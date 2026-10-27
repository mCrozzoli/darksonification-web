// Copied from projects/designs/dark_music_corpus/web_implementation/core/clap.js on 2026-10-27 for Uncanny Listening (credit: the
// Dark Music Corpus web engine). Changes here: none.
// Dark Music Corpus — CLAP audio embeddings in the browser (2026-10-22).
// The desktop engine (dmc/clap.py) runs a CLAP checkpoint through Hugging Face's ClapProcessor + ClapModel. Here (three
// checkpoints: larger_clap_music_and_speech, larger_clap_music, clap-htsat-fused — the last with HTK mel ×4, "fusion"):
//   · features(): a port of transformers' ClapFeatureExtractor for clips ≤ 10 s (truncation "rand_trunc", padding
//     "repeatpad"): the clip (48 kHz mono) is tiled int(480000 / n) times and zero-padded to 480000 samples; a log-mel
//     spectrogram follows — reflect-padded frames of 1024, hop 480, periodic Hann, |rfft|², 64 Slaney mel filters
//     (Slaney norm) 50–14000 Hz, floor 1e-10, 10·log10 — giving input_features [1, 1, 1001, 64];
//   · the audio encoder exported from the local model to ONNX (8-bit), run with ONNX Runtime Web (WASM);
//   · embeddings L2-normalised per clip, the file-level one = L2(mean of its clips) (dmc/clap.embed_file).
export const CLAP_SR = 48000, MAX = 480000, NFFT = 1024, HOP = 480, NMEL = 64, NFR = 1 + Math.floor((MAX + NFFT - NFFT) / HOP);

function fftFactory(n) {
  const lev = Math.log2(n) | 0, cos = new Float64Array(n / 2), sin = new Float64Array(n / 2), rev = new Uint32Array(n);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
  for (let i = 0; i < n; i++) { let r = 0, x = i; for (let j = 0; j < lev; j++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
  return (re, im) => {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size *= 2) { const half = size / 2, step = n / size;
      for (let i = 0; i < n; i += size) for (let j = i, k = 0; j < i + half; j++, k += step) {
        const tr = re[j + half] * cos[k] + im[j + half] * sin[k], ti = -re[j + half] * sin[k] + im[j + half] * cos[k];
        re[j + half] = re[j] - tr; im[j + half] = im[j] - ti; re[j] += tr; im[j] += ti; } }
  };
}
const fft = fftFactory(NFFT);
const WIN = Float64Array.from({ length: NFFT }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / NFFT));   // periodic Hann
const NB = NFFT / 2 + 1;
// transformers.audio_utils.mel_filter_bank(513, 64, 50, 14000, 48000, norm="slaney", mel_scale="slaney") → [NB][NMEL]
const hz2mel = (f) => f < 1000 ? 3 * f / 200 : 15 + Math.log(f / 1000) * 27 / Math.log(6.4);
const mel2hz = (m) => m < 15 ? 200 * m / 3 : 1000 * Math.exp(Math.log(6.4) * (m - 15) / 27);
// the fused model (laion/clap-htsat-fused, truncation "fusion") reads mel_filter_bank(…, norm=None, mel_scale="htk") instead
const MEL_HTK = (() => {
  const h2m = (f) => 2595 * Math.log10(1 + f / 700), m2h = (m) => 700 * (10 ** (m / 2595) - 1);
  const m0 = h2m(50), m1 = h2m(14000), ff = Array.from({ length: NMEL + 2 }, (_, i) => m2h(m0 + (m1 - m0) * i / (NMEL + 1)));
  const fft_f = Array.from({ length: NB }, (_, k) => k * (CLAP_SR / 2) / (NB - 1)), W = Array.from({ length: NMEL }, () => new Float64Array(NB));
  for (let m = 0; m < NMEL; m++) for (let k = 0; k < NB; k++) { const down = (fft_f[k] - ff[m]) / (ff[m + 1] - ff[m]), up = (ff[m + 2] - fft_f[k]) / (ff[m + 2] - ff[m + 1]); W[m][k] = Math.max(0, Math.min(down, up)); }
  return W;
})();
const MEL = (() => {
  const m0 = hz2mel(50), m1 = hz2mel(14000), ff = Array.from({ length: NMEL + 2 }, (_, i) => mel2hz(m0 + (m1 - m0) * i / (NMEL + 1)));
  const fft_f = Array.from({ length: NB }, (_, k) => k * (CLAP_SR / 2) / (NB - 1));
  const W = Array.from({ length: NMEL }, () => new Float64Array(NB));
  for (let m = 0; m < NMEL; m++) { const en = 2 / (ff[m + 2] - ff[m]);
    for (let k = 0; k < NB; k++) { const down = (fft_f[k] - ff[m]) / (ff[m + 1] - ff[m]), up = (ff[m + 2] - fft_f[k]) / (ff[m + 2] - ff[m + 1]);
      W[m][k] = Math.max(0, Math.min(down, up)) * en; } }
  return W;
})();

export function features(clip, htk = false) {                     // Float32Array (48 kHz mono, ≤ 10 s) → Float32Array(1001·64)
  const FB = htk ? MEL_HTK : MEL;
  const n = Math.min(clip.length, MAX), w = new Float64Array(MAX);
  const reps = n > 0 ? Math.floor(MAX / n) : 0;
  for (let r = 0, o = 0; r < reps; r++, o += n) for (let i = 0; i < n; i++) w[o + i] = clip[i];
  const pad = NFFT / 2, L = MAX + 2 * pad, at = (i) => { let j = i - pad; if (j < 0) j = -j; else if (j >= MAX) j = 2 * (MAX - 1) - j; return w[j]; };   // reflect
  const out = new Float32Array(NFR * NMEL), re = new Float64Array(NFFT), im = new Float64Array(NFFT), P = new Float64Array(NB);
  for (let f = 0; f < NFR; f++) {
    const s = f * HOP; for (let i = 0; i < NFFT; i++) { re[i] = at(s + i) * WIN[i]; im[i] = 0; }
    fft(re, im); for (let k = 0; k < NB; k++) P[k] = re[k] * re[k] + im[k] * im[k];
    for (let m = 0; m < NMEL; m++) { const Wm = FB[m]; let a = 0; for (let k = 0; k < NB; k++) if (Wm[k]) a += Wm[k] * P[k];
      out[f * NMEL + m] = 10 * Math.log10(Math.max(1e-10, a)); }
  }
  void L; return out;
}

let ort = null, session = null, sessionUrl = null, fusedModel = false;
export async function load(modelUrl, ortUrl, wasmBase, onProgress, fused = false) {   // one audio model at a time; another URL replaces it
  if (session && sessionUrl === modelUrl) return session;
  session = null; fusedModel = fused;
  ort = await import(ortUrl);
  ort.env.wasm.wasmPaths = wasmBase;
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(8, (self.navigator && navigator.hardwareConcurrency) || 4)) : 1;
  const r = await fetch(modelUrl); if (!r.ok) throw new Error(`CLAP model: HTTP ${r.status}`);
  const total = +r.headers.get("Content-Length") || 0, rd = r.body.getReader(), parts = []; let got = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; onProgress && onProgress(got, total); }
  const bytes = new Uint8Array(got); let o = 0; for (const p of parts) { bytes.set(p, o); o += p.length; }
  session = await ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] }); sessionUrl = modelUrl;
  return session;
}
export function threads() { return ort ? ort.env.wasm.numThreads : 0; }
export async function embed(clip) {                               // → Float32Array(512), L2-normalised
  let x = features(clip, fusedModel), C = 1;
  if (fusedModel) { const y = new Float32Array(4 * x.length); for (let c = 0; c < 4; c++) y.set(x, c * x.length); x = y; C = 4; }   // fusion, ≤ 10 s: the same mel ×4, is_longer false
  const o = await session.run({ input_features: new ort.Tensor("float32", x, [1, C, NFR, NMEL]) });
  const e = Float32Array.from(o.audio_embeds.data); let s = 0; for (const v of e) s += v * v; s = Math.sqrt(s) || 1;
  for (let i = 0; i < e.length; i++) e[i] /= s; return e;
}
export function l2mean(rows) {
  const d = rows[0].length, m = new Float32Array(d); for (const r of rows) for (let i = 0; i < d; i++) m[i] += r[i];
  let s = 0; for (const v of m) s += v * v; s = Math.sqrt(s) || 1; for (let i = 0; i < d; i++) m[i] /= s; return m;
}

// ---------------------------------------------------------------- the text side (text probe)
// The text encoder (8-bit, per-channel) arrives in two halves (GitHub's file limit) and is joined here; the tokenizer is
// core/tokenizer.js on the model's own vocab.json + merges.txt. Embeddings L2-normalised (keys.text_embeddings).
let textSession = null, textUrl = null, tokenizer = null;
export const DEFAULT_PROMPTS = ["a drone", "noise", "a human voice", "strings", "percussion", "a field recording", "an electronic pulse", "near silence"];
async function fetchBytes(u, onProgress, base = 0, total = 0) {
  const r = await fetch(u); if (!r.ok) throw new Error(`${u.split("/").pop()}: HTTP ${r.status}`);
  const rd = r.body.getReader(), parts = []; let got = 0;
  for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; onProgress && onProgress(base + got, total); }
  const b = new Uint8Array(got); let o = 0; for (const p of parts) { b.set(p, o); o += p.length; } return b;
}
export async function loadText(parts, vocabUrl, mergesUrl, ortUrl, wasmBase, onProgress) {
  if (textSession && textUrl === parts[0].url) return textSession;
  textSession = null;
  if (!ort) { ort = await import(ortUrl); ort.env.wasm.wasmPaths = wasmBase;
    ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(8, (self.navigator && navigator.hardwareConcurrency) || 4)) : 1; }
  const { Tokenizer } = await import("./tokenizer.js");
  const [vocab, merges] = await Promise.all([fetch(vocabUrl).then((r) => r.json()), fetch(mergesUrl).then((r) => r.text())]);
  tokenizer = new Tokenizer(vocab, merges);
  const total = parts.reduce((s, p) => s + p.bytes, 0); let base = 0; const chunks = [];
  for (const p of parts) { chunks.push(await fetchBytes(p.url, onProgress, base, total)); base += p.bytes; }
  const all = new Uint8Array(base); let o = 0; for (const c of chunks) { all.set(c, o); o += c.length; }
  textSession = await ort.InferenceSession.create(all, { executionProviders: ["wasm"] }); textUrl = parts[0].url;
  return textSession;
}
export async function embedText(texts) {                          // → Float32Array[] (L2-normalised), one per text
  const out = [];
  for (const t of texts) {
    const ids = tokenizer.encode(t), n = ids.length;
    const o = await textSession.run({ input_ids: new ort.Tensor("int64", BigInt64Array.from(ids, BigInt), [1, n]),
                                      attention_mask: new ort.Tensor("int64", new BigInt64Array(n).fill(1n), [1, n]) });
    const e = Float32Array.from(o.text_embeds.data); let s = 0; for (const v of e) s += v * v; s = Math.sqrt(s) || 1; for (let i = 0; i < e.length; i++) e[i] /= s;
    out.push(e);
  }
  return out;
}
