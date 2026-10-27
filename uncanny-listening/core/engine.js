// Copied from projects/designs/dark_music_corpus/web_implementation/core/engine.js on 2026-10-27 for Uncanny Listening (credit: the
// Dark Music Corpus web engine). Changes here: none.
// Dark Music Corpus — the analysis engine in a Web Worker (Phase D, 2026-10-22).
// A port of dev/engine/dmc (segment.py, features.py, readings.py, the default key families of keys.py) that turns the
// visitor's own audio into the SAME payload viz/bridge.py serves (/api/data), so the page cannot tell the difference.
//
// main thread → worker:  {type:"file", i, name, rel_path, folder, y: Float32Array (mono, 22050 Hz), peak: [clip peaks]?, duration}
//                         {type:"finish", config: {phase2, readings}}
// worker → main thread:  {type:"progress", stage, done, total, …} · {type:"done", payload, link} · {type:"error", error}
//
// Ported, each tested against the desktop (TESTS_2026-10-22.md): fixed 2 s / 50 % segmentation with zero-crossing snap;
// the MIR groups (core/mir.js); rhythm (tempo, onset rate, beat strength, onsets) and librosa's beat tracker; CLAP
// (core/clap.js); the readings — scalers + clip, weights, balance, pre-PCA; maps UMAP / PCA / t-SNE (Barnes-Hut, after
// sklearn) / SOM (after MiniSom); clusterings k-means / GMM / agglomerative / spectral / HDBSCAN / DBSCAN (k auto by
// silhouette or BIC, noise as the last class); Isolation Forest / LOF; kNN; 2-D density; the per-stage cache; the
// readings comparison; and every key family of keys.py (core/keys.js); Phase 2 per its config (rate, normalize, the four
// segmentation modes, snap, groups and their options, chroma stft / cqt / cens). Not here: the desktop's on-disk cache
// across sessions (this page keeps one corpus in memory) and CLAP models other than larger_clap_music_and_speech.
import { makeMir, fixedSegments, regularize, toNativeSamples, normalizeAudio, roundEven, resample } from "./mir.js";
import { UMAP, Matrix, EigenvalueDecomposition, SingularValueDecomposition } from "../vendor/umap-js.esm.js";
import * as CLAP from "./clap.js";
import { computeKeys, familyConfig, baseReadingDescs, S2_ALL } from "./keys.js";
let clapOn = false;

const files = [];
// per-stage cache for this corpus (readings.compute_reading caches each stage on disk; here in memory, cleared on reset)
const CACHE = new Map();
let cancelFlag = null;                                          // Int32Array on a SharedArrayBuffer (isolated pages): [0] = 1 → stop
const checkCancel = () => { if (cancelFlag && Atomics.load(cancelFlag, 0)) throw new Error("__cancelled__"); };
function cached(key, fn, hits, stage) { if (CACHE.has(key)) { hits[stage] = true; return CACHE.get(key); } hits[stage] = false; const v = fn(); CACHE.set(key, v); return v; }                                               // per file: {name, rel_path, folder, file_id, t0, t1, rows, cols, whole, events}
const post = (m, tr) => self.postMessage(m, tr || []);

// ------------------------------------------------------------------ helpers
function rng(seed) { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
async function fileId(rel, n) {                                 // a stable 10-hex id (the desktop's content_hash role)
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`${rel}|${n}`));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 10);
}
const median = (a) => { const s = Float64Array.from(a).sort(), n = s.length; return n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]); };
const quantile = (s, q) => { const pos = (s.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos); return s[lo] + (s[hi] - s[lo]) * (pos - lo); };
const rankPct = (v) => { const idx = Array.from(v, (_, i) => i).sort((a, b) => v[a] - v[b]), r = new Float64Array(v.length); let i = 0;
  while (i < idx.length) { let j = i; while (j + 1 < idx.length && v[idx[j + 1]] === v[idx[i]]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k]] = avg / v.length; i = j + 1; } return r; };

// ------------------------------------------------------------------ one file (worker.process_file)
// m: {i, total, name, rel_path, folder, yNat (the native-rate mono mix), srNat, sr (the analysis rate), p2 (the Phase 2 config)}
// segment.load_audio: the analysis signal is yNat resampled (soxr-HQ-like, see mir.resample) and normalised
const MIR_GROUPS = ["spectral", "energy", "mfcc", "chroma", "rhythm"];
async function addFile(m) {
  const p2 = m.p2 || {}, an = p2.analysis || {}, sr = m.sr, M = makeMir({ sr, nFft: an.n_fft ?? 2048, hop: an.hop_length ?? 512 }), stats = an.summaries || ["mean", "std", "min", "max"];
  const yNat = m.yNat, srNat = m.srNat, y = normalizeAudio(resample(yNat, srNat, sr), p2.audio || {}), dur = y.length / sr, c = M.fileCtx(y);
  const fid = await fileId(m.rel_path, `${yNat.length}|${srNat}`);
  // segment.segments_for on the analysis signal, then native sample edges snapped to zero crossings
  const seg = p2.segmentation || { mode: "fixed" }, mode = seg.mode || "fixed"; let segs, note = "";
  if (mode === "whole") segs = [[0, dur]];
  else if (mode === "fixed") { const f = seg.fixed || {}; segs = fixedSegments(dur, f.size_s ?? 2.0, f.overlap ?? 0.0, f.min_tail_s ?? 0.5); }
  else if (mode === "onset") { const o = seg.onset || {};
    const fr = M.onsetDetect(c.env(), { backtrack: true, delta: o.delta ?? 0.07, wait: Math.max(1, roundEven((o.wait_s ?? 0.03) * sr / M.hop)) });
    segs = regularize(fr.map((f) => f * M.hop / sr), dur, o.min_len_s ?? 0.25, o.max_len_s ?? 4.0); }
  else if (mode === "beats") { const b = seg.beats || {}, bt = M.beatTrack(c.env()).beats;
    if (bt.length < 2) { segs = fixedSegments(dur, b.fallback_size_s ?? 2.0, 0.0, 0.0); note = "no beats found: fixed fallback"; }
    else { const step = Math.max(1, Math.trunc(b.n_beats ?? 4)); segs = regularize(bt.filter((_, k) => k % step === 0), dur, b.min_len_s ?? 0.25, b.max_len_s ?? 8.0); } }
  else throw new Error(`segmentation.mode must be whole|fixed|onset|beats, got ${mode}`);
  const { starts, ends } = toNativeSamples(segs, yNat, srNat, seg.snap || {});
  const t0 = starts.map((a) => a / srNat), t1 = ends.map((b) => b / srNat), durs = t0.map((a, k) => t1[k] - a);
  // the MIR groups (features.compute_group), in the desktop's order; peak_db on the native mix (worker.process_file)
  const feat = p2.features || {}, cols = [], rows = t0.map(() => []), whole = [], groups = {}, on = (g) => (feat[g] || {}).enabled !== false;
  let events = { onset_t: [], onset_s: [], beat_t: [] };
  for (const g of MIR_GROUPS) {
    if (!on(g)) continue; checkCancel();
    const gcfg = feat[g] || {}; let part;
    if (g === "rhythm") { const env = c.env(); part = M.rhythm(env, M.ranges(t0, t1, env.length), durs, dur, gcfg.tempogram_win_s ?? 8.0);
      events = { onset_t: part.onset_t, onset_s: part.onset_s, beat_t: M.beatTrack(env).beats }; }   // features.rhythm_events (E4)
    else {
      const fr = M.group(g, c, gcfg), R = M.ranges(t0, t1, fr.frames[0].length); part = M.summarize(fr, R, stats);
      if (g === "energy") { const ex = M.energyExtras(fr.frames[0], R); part.cols.push(...ex.cols); part.rows.forEach((r, k) => r.push(...ex.rows[k])); part.whole.push(...ex.whole);
        const db = (v) => 20 * Math.log10(Math.max(v, 1e-6)); let pAll = 0;
        starts.forEach((a, k) => { let p = 0; for (let q = a; q < ends[k]; q++) p = Math.max(p, Math.abs(yNat[q])); part.rows[k].push(db(p)); });
        for (let q = 0; q < yNat.length; q++) pAll = Math.max(pAll, Math.abs(yNat[q]));
        part.cols.push("peak_db"); part.whole.push(db(pAll)); }
    }
    cols.push(...part.cols); part.rows.forEach((r, k) => rows[k].push(...r)); whole.push(...part.whole); groups[g] = part.cols.slice();
  }
  if (clapOn && on("clap")) { const y48 = resample(yNat, srNat, CLAP.CLAP_SR);                            // clap.embed_file: per clip (≤ max_clip_s, centred), 48 kHz, then the L2 file mean
    const E = [], maxLen = Math.trunc(((feat.clap || {}).max_clip_s ?? 10.0) * srNat), f48 = CLAP.CLAP_SR / srNat;
    for (let k = 0; k < starts.length; k++) {
      let a = starts[k], b = ends[k]; if (b - a > maxLen) { const cc = Math.floor((a + b) / 2); a = cc - Math.floor(maxLen / 2); b = a + maxLen; }
      const a48 = Math.max(0, Math.round(a * f48)), b48 = Math.min(y48.length, Math.ceil(b * f48));
      E.push(await CLAP.embed(y48.subarray(a48, b48)));
      if (k % 8 === 7 || k === starts.length - 1) post({ type: "progress", stage: "clap", file: m.i + 1, total: m.total, done: k + 1, of: starts.length, name: m.name });
      if (k % 8 === 7) checkCancel();
    }
    const cc = Array.from({ length: E[0].length }, (_, j) => `clap_${j}`);
    rows.forEach((r, k) => { for (const v of E[k]) r.push(v); }); cols.push(...cc); groups.clap = cc;
    for (const v of CLAP.l2mean(E)) whole.push(v);
  }
  files[m.i] = { name: m.name, rel_path: m.rel_path, folder: m.folder || "", file_id: fid, duration: yNat.length / srNat, t0, t1, cols, rows, groups, whole, events, note };
}

// ------------------------------------------------------------------ readings (readings.py)
function selectColumns(groups, spec) {
  const f = spec.features, stats = new Set(f.stats || ["mean", "std", "min", "max"]), excl = f.exclude || [];
  const wanted = (c) => { if (excl.some((e) => c === e || c.startsWith(e + "_"))) return false; const m = c.match(/_(mean|std|min|max)$/); return !m || stats.has(m[1]); };
  const blocks = {}; for (const g of f.groups || []) { const cols = (groups[g] || []).filter(wanted); if (cols.length) blocks[g] = cols; }
  return blocks;
}
function prepare(get, n, blocks, spec) {                        // readings.prepare: impute, drop constant, scale (+ clip), weight blocks, pre-PCA
  const sc = spec.scaler || { method: "robust", clip: 5 }, out = [], used = {}, weights = spec.weights || {};
  for (const [b, cols] of Object.entries(blocks)) {
    let kept = 0; const start = out.length;
    for (const c of cols) {
      let v = Float64Array.from({ length: n }, (_, i) => get(c, i)); const fin = Array.from(v).filter(Number.isFinite);
      const med0 = fin.length ? median(fin) : 0; for (let i = 0; i < n; i++) if (!Number.isFinite(v[i])) v[i] = med0;
      let mu = 0; for (const x of v) mu += x; mu /= n; let sd = 0; for (const x of v) sd += (x - mu) ** 2; sd = Math.sqrt(sd / n);
      if (!(sd > 1e-12)) continue;
      if (sc.method === "robust" || !sc.method) { const s = Float64Array.from(v).sort(); let iqr = quantile(s, 0.75) - quantile(s, 0.25); if (!(iqr > 1e-12)) iqr = sd; const md = quantile(s, 0.5); v = v.map((x) => (x - md) / (iqr > 1e-12 ? iqr : 1)); }
      else if (sc.method === "standard") v = v.map((x) => (x - mu) / sd);
      else if (sc.method === "center") v = v.map((x) => x - mu);
      else if (sc.method === "minmax") { let lo = Infinity, hi = -Infinity; for (const x of v) { lo = Math.min(lo, x); hi = Math.max(hi, x); } v = v.map((x) => hi - lo > 1e-12 ? (x - lo) / (hi - lo) : x - lo); }
      if (sc.clip) v = v.map((x) => Math.max(-sc.clip, Math.min(sc.clip, x)));
      out.push(v); kept++;
    }
    if (kept) { let w = +(weights[b] ?? 1); if (spec.balance_groups) w /= Math.sqrt(kept);
      if (w !== 1) for (let j = start; j < out.length; j++) out[j] = out[j].map((x) => x * w);
      used[b] = kept; }
  }
  let X = Array.from({ length: n }, (_, i) => Float64Array.from(out, (col) => col[i]));
  const pre = spec.pre_pca;
  if (pre && X[0].length > pre) X = pca(X, Math.min(pre, n - 1, X[0].length));
  return { X, features: used, dims: X[0].length };
}
function pca(X, k) {                                             // centred PCA via the d×d covariance's eigenvectors (sklearn PCA up to sign)
  const n = X.length, d = X[0].length, mu = new Float64Array(d);
  for (const x of X) for (let j = 0; j < d; j++) mu[j] += x[j] / n;
  const C = Array.from({ length: d }, () => new Float64Array(d));
  for (const x of X) for (let a = 0; a < d; a++) { const xa = x[a] - mu[a]; if (!xa) continue; const Ca = C[a]; for (let b = a; b < d; b++) Ca[b] += xa * (x[b] - mu[b]); }
  for (let a = 0; a < d; a++) for (let b = a; b < d; b++) { C[a][b] /= (n - 1); C[b][a] = C[a][b]; }
  const e = new EigenvalueDecomposition(new Matrix(C.map((r) => Array.from(r))), { assumeSymmetric: true });
  const ev = e.realEigenvalues, V = e.eigenvectorMatrix, order = ev.map((v, i) => i).sort((a, b) => ev[b] - ev[a]).slice(0, k);
  return X.map((x) => Float64Array.from(order, (c) => { let s = 0; for (let j = 0; j < d; j++) s += (x[j] - mu[j]) * V.get(j, c); return s; }));
}
const d2 = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) { const t = a[k] - b[k]; s += t * t; } return s; };
function kmeans(X, k, seed, nInit = 10, iters = 100) {
  const n = X.length, d = X[0].length, R = rng(seed); let best = null;
  for (let run = 0; run < nInit; run++) {
    const C = [X[Math.floor(R() * n)].slice()], D = new Float64Array(n).fill(Infinity);   // k-means++
    while (C.length < k) { let tot = 0; for (let i = 0; i < n; i++) { D[i] = Math.min(D[i], d2(X[i], C[C.length - 1])); tot += D[i]; }
      let r = R() * tot, j = 0; for (; j < n - 1 && (r -= D[j]) > 0; j++); C.push(X[j].slice()); }
    const lab = new Int32Array(n); let inertia = 0;
    for (let it = 0; it < iters; it++) {
      let moved = 0; inertia = 0;
      for (let i = 0; i < n; i++) { let bj = 0, bd = Infinity; for (let j = 0; j < k; j++) { const v = d2(X[i], C[j]); if (v < bd) { bd = v; bj = j; } } if (lab[i] !== bj) { lab[i] = bj; moved++; } inertia += bd; }
      const S = Array.from({ length: k }, () => new Float64Array(d)), N = new Int32Array(k);
      for (let i = 0; i < n; i++) { N[lab[i]]++; const s = S[lab[i]]; for (let t = 0; t < d; t++) s[t] += X[i][t]; }
      for (let j = 0; j < k; j++) if (N[j]) for (let t = 0; t < d; t++) C[j][t] = S[j][t] / N[j];
      if (!moved && it) break;
    }
    if (!best || inertia < best.inertia) best = { inertia, lab: Int32Array.from(lab) };
  }
  return best.lab;
}
function silhouette(X, lab, sampleN, seed) {                    // sklearn silhouette_score with sample_size
  const n = X.length, R = rng(seed + 7), idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const S = idx.slice(0, Math.min(n, sampleN)), ks = Math.max(...lab) + 1; let tot = 0, cnt = 0;
  for (const i of S) {
    const sum = new Float64Array(ks), num = new Int32Array(ks);
    for (const j of S) if (j !== i) { sum[lab[j]] += Math.sqrt(d2(X[i], X[j])); num[lab[j]]++; }
    if (!num[lab[i]]) { cnt++; continue; } const a = sum[lab[i]] / num[lab[i]]; let b = Infinity;   // a singleton cluster scores 0 (sklearn)
    for (let c = 0; c < ks; c++) if (c !== lab[i] && num[c]) b = Math.min(b, sum[c] / num[c]);
    if (isFinite(b)) { tot += (b - a) / Math.max(a, b); cnt++; }
  }
  return cnt ? tot / cnt : 0;
}
function fitLabels(X, cl, k, seed) {                            // readings._fit_labels
  if (cl.method === "gmm") return gmm(X, k, seed, 2, 100, 1e-4, cl.covariance || null);
  if (cl.method === "agglomerative") return { lab: agglomerative(X, k, cl.linkage || "ward"), bic: null };
  if (cl.method === "spectral") return { lab: spectral(X, k, Math.min(cl.n_neighbors ?? 15, X.length - 1), seed), bic: null };
  return { lab: kmeans(X, k, seed), bic: null };
}
function clustering(X, cl, seed) {                              // readings.run_clustering: kmeans · gmm (BIC) · agglomerative · spectral · hdbscan · dbscan
  const n = X.length, method = cl.method || "kmeans"; let labels, info = { method };
  if (!["kmeans", "gmm", "agglomerative", "spectral", "hdbscan", "dbscan"].includes(method)) throw new Error(`unknown clustering ${JSON.stringify(method)}`);
  const c2 = Object.assign({}, cl, { method });
  if (method === "hdbscan") labels = hdbscan(X, Math.min(cl.min_cluster_size ?? 25, Math.max(2, Math.floor(n / 4))), cl.min_samples ?? null);
  else if (method === "dbscan") labels = dbscan(X, cl.eps ?? 0.5, cl.min_samples ?? 5);
  else if (n < 3) labels = new Int32Array(n);
  else if (cl.k === "auto") {
    const [lo, hi] = cl.k_range || [3, 10], scores = {}; let best = null;
    for (let k = Math.max(2, lo); k <= Math.min(hi, n - 1); k++) { const { lab, bic } = fitLabels(X, c2, k, seed); if (new Set(lab).size < 2) continue;
      const s = method === "gmm" ? -bic : silhouette(X, lab, Math.min(n, 2000), seed); scores[k] = +s.toFixed(4); if (!best || s > best[1]) best = [k, s, lab]; }
    labels = best ? best[2] : new Int32Array(n); if (best) info.k_auto = { criterion: method === "gmm" ? "bic" : "silhouette", scores, chosen: best[0] };
  } else labels = fitLabels(X, c2, Math.min(+cl.k || 6, Math.max(1, n - 1)), seed).lab;
  // relabel by size (0 = biggest); noise (-1) becomes the last class so devices never see -1
  const sizes = {}; let nNoise = 0; for (const c of labels) { if (c < 0) nNoise++; else sizes[c] = (sizes[c] || 0) + 1; }
  const order = Object.keys(sizes).map(Number).sort((a, b) => sizes[b] - sizes[a] || a - b), remap = new Map(order.map((c, i) => [c, i]));
  const noise = nNoise ? order.length : null, out = Int32Array.from(labels, (c) => c < 0 ? noise : remap.get(c));
  info.n_clusters = order.length; info.noise_class = noise; info.n_noise = nNoise; info.sizes = order.map((c) => sizes[c]);
  if (order.length >= 2) { const keep = []; for (let i = 0; i < n; i++) if (out[i] !== noise) keep.push(i);
    const lab = Int32Array.from(keep, (i) => out[i]); if (new Set(lab).size >= 2) info.silhouette = +silhouette(keep.map((i) => X[i]), lab, Math.min(keep.length, 2000), seed).toFixed(4); }
  return { labels: out, info };
}
function dbscan(X, eps, minSamples) {                           // sklearn DBSCAN (euclidean; a point counts itself; core if ≥ min_samples within eps)
  const n = X.length, e2 = eps * eps, nb = [];
  for (let i = 0; i < n; i++) { const a = []; for (let j = 0; j < n; j++) if (d2(X[i], X[j]) <= e2) a.push(j); nb.push(a); }
  const core = nb.map((a) => a.length >= minSamples), lab = new Int32Array(n).fill(-1); let c = 0;
  for (let i = 0; i < n; i++) { if (lab[i] !== -1 || !core[i]) continue;            // sklearn dbscan_inner: depth-first from each unlabelled core point
    const st = [i]; lab[i] = c;
    while (st.length) { const p = st.pop(); if (!core[p]) continue; for (const q of nb[p]) if (lab[q] === -1) { lab[q] = c; if (core[q]) st.push(q); } }
    c++; }
  return lab;
}
function agglomerative(X, k, linkage = "ward") {                 // sklearn AgglomerativeClustering(n_clusters=k, linkage) without connectivity:
  // scipy.cluster.hierarchy.linkage (nn_chain: the merged cluster lives on at the larger index; Lance–Williams as scipy
  // writes it; rows sorted by height, stable; label() renumbers), then sklearn's _hc_cut (a heapq of node ids)
  const n = X.length; if (k >= n) return Int32Array.from({ length: n }, (_, i) => i);
  if (!["ward", "complete", "average", "single"].includes(linkage)) throw new Error(`unknown linkage ${linkage}`);
  const ci = (i, j) => { if (i > j) [i, j] = [j, i]; return n * i - (i * (i + 1)) / 2 + (j - i - 1); }, D = new Float64Array(n * (n - 1) / 2);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) D[ci(i, j)] = Math.sqrt(d2(X[i], X[j]));
  const size = new Float64Array(n).fill(1), Z = [], chain = new Int32Array(n); let len = 0;
  if (linkage === "single") {                                    // sklearn mst_linkage_core (Prim from point 0; sklearn does single linkage itself)
    const Dm = new Float64Array(n).fill(Infinity), merged = new Uint8Array(n); let x = 0;
    for (let step = 0; step < n - 1; step++) { let cur = Infinity, y = -1; merged[x] = 1;
      for (let i = 0; i < n; i++) { if (merged[i]) continue; const dd = D[ci(x, i)]; if (Dm[i] > dd) Dm[i] = dd; if (Dm[i] < cur) { y = i; cur = Dm[i]; } }
      Z.push([x, y, cur, 0]); x = y; }
  } else
  for (let step = 0; step < n - 1; step++) {
    if (len === 0) { len = 1; for (let i = 0; i < n; i++) if (size[i] > 0) { chain[0] = i; break; } }
    let x, y, cur;
    for (;;) { x = chain[len - 1];
      if (len > 1) { y = chain[len - 2]; cur = D[ci(x, y)]; } else cur = Infinity;
      for (let i = 0; i < n; i++) { if (size[i] === 0 || x === i) continue; const dd = D[ci(x, i)]; if (dd < cur) { cur = dd; y = i; } }
      if (len > 1 && y === chain[len - 2]) break;
      chain[len++] = y; }
    len -= 2; if (x > y) [x, y] = [y, x];
    const nx = size[x], ny = size[y]; Z.push([x, y, cur, nx + ny]); size[x] = 0; size[y] = nx + ny;
    for (let i = 0; i < n; i++) { const ni = size[i]; if (ni === 0 || i === y) continue;
      const dxi = D[ci(i, x)], dyi = D[ci(i, y)]; let v;
      if (linkage === "ward") { const t = 1.0 / (nx + ny + ni); v = Math.sqrt((ni + nx) * t * dxi * dxi + (ni + ny) * t * dyi * dyi - ni * t * cur * cur); }
      else if (linkage === "complete") v = Math.max(dxi, dyi); else if (linkage === "single") v = Math.min(dxi, dyi); else v = (nx * dxi + ny * dyi) / (nx + ny);
      D[ci(i, y)] = v; }
  }
  const ord = Z.map((_, t) => t).sort((a, b) => Z[a][2] - Z[b][2] || a - b);           // argsort(kind="mergesort")
  const par = Int32Array.from({ length: 2 * n - 1 }, (_, i) => i), find = (q) => { while (par[q] !== q) { par[q] = par[par[q]]; q = par[q]; } return q; };
  const children = ord.map((t, r) => { const a = find(Z[t][0]), b = find(Z[t][1]), nn = n + r; par[a] = nn; par[b] = nn; return a < b || linkage === "single" ? [a, b] : [b, a]; });   // scipy label(); sklearn's _single_linkage_label keeps the MST order
  // sklearn _hc_cut with Python's heapq
  const less = (a, b) => a < b, sdown = (h, st, p) => { const it = h[p]; while (p > st) { const pp = (p - 1) >> 1; if (less(it, h[pp])) { h[p] = h[pp]; p = pp; continue; } break; } h[p] = it; };
  const sup = (h, p) => { const end = h.length, st = p, it = h[p]; let c = 2 * p + 1; while (c < end) { const r = c + 1; if (r < end && !less(h[c], h[r])) c = r; h[p] = h[c]; p = c; c = 2 * p + 1; } h[p] = it; sdown(h, st, p); };
  const push = (h, v) => { h.push(v); sdown(h, 0, h.length - 1); }, pushpop = (h, v) => { if (h.length && less(h[0], v)) { const t = h[0]; h[0] = v; v = t; sup(h, 0); } return v; };
  const nodes = [-(Math.max(...children[n - 2]) + 1)];
  for (let t = 0; t < k - 1; t++) { const ch = children[-nodes[0] - n]; push(nodes, -ch[0]); pushpop(nodes, -ch[1]); }
  const lab = new Int32Array(n);
  nodes.forEach((nd, i) => { const st = [-nd]; while (st.length) { const q = st.pop(); if (q < n) lab[q] = i; else st.push(...children[q - n]); } });
  return lab;
}
function hdbscan(X, mcs, minSamples) {                            // sklearn HDBSCAN (euclidean, eom, alpha 1): mutual reachability MST → condensed tree → stable clusters
  const n = X.length, ms = Math.max(1, Math.min(minSamples ?? mcs, n));
  if (n < 2) return new Int32Array(n).fill(-1);
  const core = new Float64Array(n);                               // distance to the min_samples-th neighbour, the point itself included
  for (let i = 0; i < n; i++) { const ds = new Float64Array(n); for (let j = 0; j < n; j++) ds[j] = Math.sqrt(d2(X[i], X[j])); ds.sort(); core[i] = ds[Math.min(ms - 1, n - 1)]; }
  // Prim's MST on mutual reachability max(core_i, core_j, d_ij)
  const inT = new Uint8Array(n), best = new Float64Array(n).fill(Infinity), from = new Int32Array(n).fill(-1), edges = []; let cur = 0; inT[0] = 1;
  for (let step = 1; step < n; step++) {
    let nx = -1, nd = Infinity;
    for (let j = 0; j < n; j++) if (!inT[j]) { const m = Math.max(core[cur], core[j], Math.sqrt(d2(X[cur], X[j]))); if (m < best[j]) { best[j] = m; from[j] = cur; } if (best[j] < nd) { nd = best[j]; nx = j; } }
    inT[nx] = 1; edges.push([from[nx], nx, nd]); cur = nx; }
  edges.sort((a, b) => a[2] - b[2]);
  // single-linkage tree (scipy layout: node n + t merges two nodes at distance, size)
  const par = Int32Array.from({ length: 2 * n - 1 }, (_, i) => i), sz = new Int32Array(2 * n - 1).fill(1), L = [];
  const find = (x) => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
  edges.forEach(([a, b, w], t) => { const ra = find(a), rb = find(b), nn = n + t; par[ra] = nn; par[rb] = nn; sz[nn] = sz[ra] + sz[rb]; L.push([ra, rb, w, sz[nn]]); });
  // condense (hdbscan _condense_tree): lambda = 1/distance
  const root = 2 * n - 2, kids = (node) => node < n ? null : L[node - n], relabel = new Int32Array(2 * n - 1), C = [];
  let next = n + 1; relabel[root] = n; const ignore = new Uint8Array(2 * n - 1);
  const leaves = (node) => { const out = [], st = [node]; while (st.length) { const x = st.pop(); if (x < n) out.push(x); else { st.push(L[x - n][0], L[x - n][1]); } } return out; };
  const bfs = [root];
  for (let qi = 0; qi < bfs.length; qi++) { const node = bfs[qi]; if (node < n || ignore[node]) continue;
    const [l, r, dist] = kids(node), lam = dist > 0 ? 1 / dist : Infinity, ls = l < n ? 1 : L[l - n][3], rs = r < n ? 1 : L[r - n][3];
    if (ls >= mcs && rs >= mcs) { relabel[l] = next++; C.push([relabel[node], relabel[l], lam, ls]); relabel[r] = next++; C.push([relabel[node], relabel[r], lam, rs]); bfs.push(l, r); }
    else if (ls < mcs && rs < mcs) { for (const s of [l, r]) for (const p of leaves(s)) C.push([relabel[node], p, lam, 1]); markIgnore(l); markIgnore(r); }
    else if (ls < mcs) { relabel[r] = relabel[node]; bfs.push(r); for (const p of leaves(l)) C.push([relabel[node], p, lam, 1]); markIgnore(l); }
    else { relabel[l] = relabel[node]; bfs.push(l); for (const p of leaves(r)) C.push([relabel[node], p, lam, 1]); markIgnore(r); } }
  function markIgnore(node) { const st = [node]; while (st.length) { const x = st.pop(); ignore[x] = 1; if (x >= n) st.push(L[x - n][0], L[x - n][1]); } }
  // stability (hdbscan compute_stability) and excess-of-mass selection, allow_single_cluster False
  const clusters = [...new Set(C.map((e) => e[0]))].sort((a, b) => a - b), birth = new Map([[n, 0]]), stab = new Map(clusters.map((c) => [c, 0]));
  for (const [p, c, lam, s] of C) if (c >= n) birth.set(c, lam);
  for (const [p, c, lam, s] of C) stab.set(p, stab.get(p) + (lam - birth.get(p)) * s);
  const childClusters = new Map(clusters.map((c) => [c, []])); for (const [p, c] of C) if (c >= n) childClusters.get(p).push(c);
  const sel = new Map(clusters.map((c) => [c, true])); sel.set(n, false);
  for (const c of [...clusters].sort((a, b) => b - a)) { if (c === n) continue;
    const kids2 = childClusters.get(c), sub = kids2.reduce((s, k) => s + stab.get(k), 0);
    if (kids2.length && sub > stab.get(c)) { sel.set(c, false); stab.set(c, sub); }
    else { const st = [...kids2]; while (st.length) { const x = st.pop(); sel.set(x, false); st.push(...childClusters.get(x)); } } }
  if (childClusters.get(n).length) { /* root never selected */ }
  // labels (hdbscan do_labelling): a point belongs to the selected cluster above it
  const parentOf = new Map(); for (const [p, c] of C) if (c >= n) parentOf.set(c, p);
  const chosen = clusters.filter((c) => sel.get(c)).sort((a, b) => a - b), cid = new Map(chosen.map((c, i) => [c, i]));
  const lab = new Int32Array(n).fill(-1);
  for (const [p, c, lam] of C) if (c < n) { let x = p; while (x !== undefined && !cid.has(x)) x = parentOf.get(x); if (x !== undefined) lab[c] = cid.get(x); }
  return lab;
}
function lof(X, kNb, contamination) {                            // sklearn LocalOutlierFactor(n_neighbors, contamination): flag + raw score (higher = more anomalous)
  const n = X.length, k = Math.min(kNb, n - 1), kn = knn(X, k), kd = Float64Array.from({ length: n }, (_, i) => kn.dist[i * k + k - 1]), lrd = new Float64Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (let t = 0; t < k; t++) { const j = kn.idx[i * k + t]; s += Math.max(kd[j], kn.dist[i * k + t]); } lrd[i] = 1 / (s / k + 1e-10); }
  const nof = Float64Array.from({ length: n }, (_, i) => { let s = 0; for (let t = 0; t < k; t++) s += lrd[kn.idx[i * k + t]]; return -(s / k) / lrd[i]; });
  const srt = Float64Array.from(nof).sort(), off = quantile(srt, contamination);
  return { flag: Int32Array.from(nof, (v) => v < off ? 1 : 0), raw: Float64Array.from(nof, (v) => -v) };
}
function gmm(X, k, seed, nInit = 2, iters = 100, reg = 1e-4, covType = null) {   // sklearn GaussianMixture, k-means init, BIC; "full" if d ≤ 10 else "diag" (readings._fit_labels)
  const n = X.length, d = X[0].length, diag = (covType || (d <= 10 ? "full" : "diag")) === "diag"; let best = null;
  for (let run = 0; run < nInit; run++) {
    const init = kmeans(X, k, seed + run, 1, 50);
    let R = Array.from({ length: n }, (_, i) => { const r = new Float64Array(k); r[init[i]] = 1; return r; }), ll = -Infinity, params = null;
    for (let it = 0; it < iters; it++) {
      // M step
      const w = new Float64Array(k), mu = Array.from({ length: k }, () => new Float64Array(d)), cov = [];
      for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) { const r = R[i][c]; if (!r) continue; w[c] += r; for (let j = 0; j < d; j++) mu[c][j] += r * X[i][j]; }
      for (let c = 0; c < k; c++) for (let j = 0; j < d; j++) mu[c][j] /= Math.max(w[c], 1e-300);
      const chol = [], logdet = [];
      for (let c = 0; c < k; c++) {
        const S = Array.from({ length: d }, () => new Float64Array(d));
        for (let i = 0; i < n; i++) { const r = R[i][c]; if (!r) continue; for (let a = 0; a < d; a++) { const xa = X[i][a] - mu[c][a]; for (let b = 0; b <= a; b++) S[a][b] += r * xa * (X[i][b] - mu[c][b]); } }
        for (let a = 0; a < d; a++) { for (let b = 0; b <= a; b++) { S[a][b] = diag && a !== b ? 0 : S[a][b] / Math.max(w[c], 1e-300); S[b][a] = S[a][b]; } S[a][a] += reg; }
        const L = Array.from({ length: d }, () => new Float64Array(d)); let ld = 0;     // Cholesky
        for (let a = 0; a < d; a++) for (let b = 0; b <= a; b++) { let s = S[a][b]; for (let t = 0; t < b; t++) s -= L[a][t] * L[b][t];
          if (a === b) { L[a][a] = Math.sqrt(Math.max(s, 1e-300)); ld += 2 * Math.log(L[a][a]); } else L[a][b] = s / L[b][b]; }
        chol.push(L); logdet.push(ld); cov.push(S);
      }
      const pi = Array.from(w, (x) => x / n);
      // E step
      let tot = 0; const R2 = [];
      for (let i = 0; i < n; i++) {
        const lp = new Float64Array(k);
        for (let c = 0; c < k; c++) { const L = chol[c], z = new Float64Array(d); let q = 0;
          for (let a = 0; a < d; a++) { let s = X[i][a] - mu[c][a]; for (let t = 0; t < a; t++) s -= L[a][t] * z[t]; z[a] = s / L[a][a]; q += z[a] * z[a]; }
          lp[c] = Math.log(Math.max(pi[c], 1e-300)) - 0.5 * (d * Math.log(2 * Math.PI) + logdet[c] + q); }
        let mx = -Infinity; for (const v of lp) mx = Math.max(mx, v); let s = 0; for (const v of lp) s += Math.exp(v - mx); const lse = mx + Math.log(s);
        tot += lse; R2.push(Float64Array.from(lp, (v) => Math.exp(v - lse)));
      }
      R = R2; params = { tot };
      if (Math.abs(tot - ll) < 1e-3 * n) { ll = tot; break; } ll = tot;
    }
    const lab = Int32Array.from(R, (r) => { let b = 0; for (let c = 1; c < k; c++) if (r[c] > r[b]) b = c; return b; });
    const np = (diag ? k * d : k * d * (d + 1) / 2) + k * d + k - 1, bic = -2 * ll + np * Math.log(n);
    if (!best || ll > best.ll) best = { ll, lab, bic };
  }
  return { lab: best.lab, bic: best.bic };
}
function spectral(X, k, nn, seed) {                              // sklearn SpectralClustering(affinity="nearest_neighbors", assign_labels="cluster_qr")
  const n = X.length, kn = knn(X, nn - 1);                       // kneighbors_graph(include_self=True): self + nn−1 others
  const A = Array.from({ length: n }, () => new Map());
  // the self-links of kneighbors_graph(include_self=True) are dropped: scipy's normed laplacian ignores the diagonal (and
  // sklearn then sets the Laplacian's diagonal to 1), so neither the matrix nor the degrees carry them
  for (let i = 0; i < n; i++) for (let t = 0; t < kn.k; t++) { const j = kn.idx[i * kn.k + t]; A[i].set(j, (A[i].get(j) || 0) + 0.5); A[j].set(i, (A[j].get(i) || 0) + 0.5); }
  const deg = Float64Array.from(A, (m) => { let s = 0; for (const v of m.values()) s += v; return s; }), dd = Float64Array.from(deg, (x) => Math.sqrt(x));
  // top-k eigenvectors of S = D^-½ A D^-½ (= the smallest of the normalised Laplacian, as sklearn's spectral_embedding
  // finds with shift-invert ARPACK). Their eigenvalues crowd just under 1 (gaps of 1e-4), which power iteration cannot
  // separate, so: Lanczos with full reorthogonalisation, m = min(n, 40 + 20·k) steps, Ritz vectors of the top k.
  const R = rng(seed + 29), mult = (v) => { const out = new Float64Array(n); for (let i = 0; i < n; i++) { let s = 0; for (const [j, a] of A[i]) s += a * v[j] / (dd[i] * dd[j]); out[i] = s; } return out; };
  // A disconnected graph repeats the eigenvalue 1 once per connected piece, and a single Lanczos run finds only one
  // direction of a repeated eigenvalue. Each piece's vector (√degree on the piece, 0 elsewhere) is that eigenvector
  // exactly, so they are taken as they are and Lanczos runs on what is orthogonal to them (cluster_qr depends only on the
  // subspace, so any basis of it gives sklearn's labels).
  const comp = new Int32Array(n).fill(-1); let nc = 0;
  for (let s0 = 0; s0 < n; s0++) if (comp[s0] < 0) { const st = [s0]; comp[s0] = nc; while (st.length) { const i = st.pop(); for (const j of A[i].keys()) if (comp[j] < 0) { comp[j] = nc; st.push(j); } } nc++; }
  const csize = new Int32Array(nc); for (const c of comp) csize[c]++;
  const compOrder = Array.from({ length: nc }, (_, c) => c).sort((a, b) => csize[b] - csize[a]).slice(0, k);
  const fixed = compOrder.map((c) => { const u = Float64Array.from({ length: n }, (_, i) => comp[i] === c ? dd[i] : 0); const nu = Math.sqrt(u.reduce((a, x) => a + x * x, 0)); return u.map((x) => x / nu); });
  const need = k - fixed.length;
  const deflate = (w) => { for (const u of fixed) { let p = 0; for (let i = 0; i < n; i++) p += w[i] * u[i]; for (let i = 0; i < n; i++) w[i] -= p * u[i]; } return w; };
  const m = Math.min(n - fixed.length, 300 + 20 * k), Qv = [], al = [], be = [];
  let q = deflate(Float64Array.from({ length: n }, () => R() - 0.5)), nq = Math.sqrt(q.reduce((a, x) => a + x * x, 0)); q = q.map((x) => x / nq);
  for (let j = 0; need > 0 && j < m; j++) {
    Qv.push(q); const w = mult(q); let a = 0; for (let i = 0; i < n; i++) a += w[i] * q[i]; al.push(a);
    for (let i = 0; i < n; i++) w[i] -= a * q[i] + (j ? be[j - 1] * Qv[j - 1][i] : 0);
    for (let pass = 0; pass < 2; pass++) { deflate(w); for (const u of Qv) { let p = 0; for (let i = 0; i < n; i++) p += w[i] * u[i]; for (let i = 0; i < n; i++) w[i] -= p * u[i]; } }
    const b = Math.sqrt(w.reduce((acc, x) => acc + x * x, 0)); if (j === m - 1 || b < 1e-10) break;
    be.push(b); q = w.map((x) => x / b);
  }
  const vecs = fixed.slice();
  if (need > 0) {
    const mm = Qv.length, T = Array.from({ length: mm }, (_, a) => Array.from({ length: mm }, (_, b) => a === b ? al[a] : Math.abs(a - b) === 1 ? be[Math.min(a, b)] : 0));
    const te = new EigenvalueDecomposition(new Matrix(T), { assumeSymmetric: true }), tv = te.realEigenvalues, TQ = te.eigenvectorMatrix;
    for (const c of tv.map((v, i) => i).sort((a, b) => tv[b] - tv[a]).slice(0, need)) vecs.push(Float64Array.from({ length: n }, (_, i) => { let s = 0; for (let a = 0; a < mm; a++) s += Qv[a][i] * TQ.get(a, c); return s; }));
  }
  let E = Array.from({ length: n }, (_, i) => Float64Array.from(vecs, (v) => v[i] / dd[i]));
  // cluster_qr: pivoted QR on Eᵀ picks k rows; an SVD aligns them; labels = argmax |E · U Vᵀ|
  const cols = E.map((r) => Float64Array.from(r)), piv = [];
  for (let t = 0; t < k; t++) { let bi = -1, bn = -1; for (let i = 0; i < n; i++) { if (piv.includes(i)) continue; let s = 0; for (const x of cols[i]) s += x * x; if (s > bn) { bn = s; bi = i; } }
    piv.push(bi); const q = cols[bi], qn = Math.sqrt(bn) || 1; const u = Float64Array.from(q, (x) => x / qn);
    for (let i = 0; i < n; i++) { let p = 0; for (let c = 0; c < k; c++) p += cols[i][c] * u[c]; for (let c = 0; c < k; c++) cols[i][c] -= p * u[c]; } }
  const P = new Matrix(Array.from({ length: k }, (_, c) => piv.map((i) => E[i][c])));   // E[piv].T : k × k
  const sv = new SingularValueDecomposition(P), U = sv.leftSingularVectors, W = sv.rightSingularVectors, Rot = U.mmul(W.transpose());
  return Int32Array.from(E, (r) => { let b = 0, bv = -Infinity; for (let c = 0; c < k; c++) { let s = 0; for (let a = 0; a < k; a++) s += r[a] * Rot.get(a, c); s = Math.abs(s); if (s > bv) { bv = s; b = c; } } return b; });
}
function tsne(X, dims, perplexity, seed, onIter) {               // sklearn TSNE(method="barnes_hut", init="pca", learning_rate="auto", max_iter=1000)
  const n = X.length, K = Math.min(n - 1, Math.floor(3 * perplexity + 1)), kn = knn(X, K);
  // conditional P per point by binary search on β to the desired perplexity (sklearn _binary_search_perplexity, squared distances)
  const rows = Array.from({ length: n }, () => new Map()), H = Math.log(perplexity);
  for (let i = 0; i < n; i++) {
    const D = Float64Array.from({ length: K }, (_, t) => kn.dist[i * K + t] ** 2); let beta = 1, lo = -Infinity, hi = Infinity, P = new Float64Array(K);
    for (let it = 0; it < 100; it++) {
      let sp = 0; for (let t = 0; t < K; t++) { P[t] = Math.exp(-D[t] * beta); sp += P[t]; } if (sp === 0) sp = 1e-8;
      let sdp = 0; for (let t = 0; t < K; t++) { P[t] /= sp; sdp += D[t] * P[t]; }
      const h = Math.log(sp) + beta * sdp, diff = h - H; if (Math.abs(diff) <= 1e-5) break;
      if (diff > 0) { lo = beta; beta = hi === Infinity ? beta * 2 : (beta + hi) / 2; } else { hi = beta; beta = lo === -Infinity ? beta / 2 : (beta + lo) / 2; }
    }
    for (let t = 0; t < K; t++) rows[i].set(kn.idx[i * K + t], P[t]);
  }
  // symmetrise, normalise to sum 1
  const Pij = [], Pj = [], Pv = []; let tot = 0;
  const sym = Array.from({ length: n }, () => new Map());
  for (let i = 0; i < n; i++) for (const [j, v] of rows[i]) { sym[i].set(j, (sym[i].get(j) || 0) + v); sym[j].set(i, (sym[j].get(i) || 0) + v); }
  for (let i = 0; i < n; i++) for (const [j, v] of sym[i]) { Pij.push(i); Pj.push(j); Pv.push(v); tot += v; }
  for (let e = 0; e < Pv.length; e++) Pv[e] /= Math.max(tot, 1e-12);
  // init: PCA, first column's sd scaled to 1e-4
  let Y = pca(X, dims); { let mu = 0; for (const y of Y) mu += y[0]; mu /= n; let sd = 0; for (const y of Y) sd += (y[0] - mu) ** 2; sd = Math.sqrt(sd / n) || 1;
    Y = Y.map((y) => Float64Array.from(y, (v) => v / sd * 1e-4)); }
  const lr = Math.max(n / 12 / 4, 50), upd = Y.map(() => new Float64Array(dims)), gains = Y.map(() => new Float64Array(dims).fill(1)), theta = 0.5;
  for (let it = 0; it < 1000; it++) {
    const exag = it < 250 ? 12 : 1, mom = it < 250 ? 0.5 : 0.8;
    // quadtree over Y (2-D)
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity; for (const y of Y) { x0 = Math.min(x0, y[0]); x1 = Math.max(x1, y[0]); y0 = Math.min(y0, y[1]); y1 = Math.max(y1, y[1]); }
    const w0 = Math.max(x1 - x0, y1 - y0) * 1.0001 + 1e-12, root = { cx: x0 + w0 / 2, cy: y0 + w0 / 2, w: w0, n: 0, mx: 0, my: 0, kids: null, pt: -1 };
    const insert = (node, i, depth) => {
      node.mx = (node.mx * node.n + Y[i][0]) / (node.n + 1); node.my = (node.my * node.n + Y[i][1]) / (node.n + 1); node.n++;
      if (node.n === 1) { node.pt = i; return; }
      if (depth > 40) return;                                          // coincident points stay together
      if (!node.kids) { node.kids = [0, 1, 2, 3].map((q) => ({ cx: node.cx + (q & 1 ? 1 : -1) * node.w / 4, cy: node.cy + (q & 2 ? 1 : -1) * node.w / 4, w: node.w / 2, n: 0, mx: 0, my: 0, kids: null, pt: -1 }));
        if (node.pt >= 0) { const o = node.pt; node.pt = -1; const q = (Y[o][0] > node.cx ? 1 : 0) | (Y[o][1] > node.cy ? 2 : 0); insert(node.kids[q], o, depth + 1); } }
      const q = (Y[i][0] > node.cx ? 1 : 0) | (Y[i][1] > node.cy ? 2 : 0); insert(node.kids[q], i, depth + 1);
    };
    for (let i = 0; i < n; i++) insert(root, i, 0);
    const neg = Y.map(() => new Float64Array(2)); let sQ = 0;
    for (let i = 0; i < n; i++) {
      const st = [root];
      while (st.length) { const nd = st.pop(); if (!nd.n) continue;
        const dx = Y[i][0] - nd.mx, dy = Y[i][1] - nd.my, d2 = dx * dx + dy * dy;
        if (!nd.kids || nd.w / Math.sqrt(d2) < theta) { if (nd.n === 1 && nd.pt === i) continue;
          const q = 1 / (1 + d2), m = nd.n; sQ += m * q; neg[i][0] += m * q * q * dx; neg[i][1] += m * q * q * dy; }
        else for (const k of nd.kids) st.push(k); }
    }
    const pos = Y.map(() => new Float64Array(2));
    for (let e = 0; e < Pv.length; e++) { const i = Pij[e], j = Pj[e], dx = Y[i][0] - Y[j][0], dy = Y[i][1] - Y[j][1], q = 1 / (1 + dx * dx + dy * dy), f = exag * Pv[e] * q;
      pos[i][0] += f * dx; pos[i][1] += f * dy; }
    for (let i = 0; i < n; i++) for (let a = 0; a < 2; a++) {
      const g = 4 * (pos[i][a] - neg[i][a] / sQ);
      if (upd[i][a] * g < 0) gains[i][a] += 0.2; else gains[i][a] *= 0.8; if (gains[i][a] < 0.01) gains[i][a] = 0.01;
      upd[i][a] = mom * upd[i][a] - lr * gains[i][a] * g; Y[i][a] += upd[i][a];
    }
    if (onIter && it % 50 === 49) onIter(it + 1);
  }
  return Y.map((y) => Array.from(y));
}
function som(X, dr, seed) {                                        // readings._som: MiniSom, own PCA init, BMU + a sub-cell offset
  const n = X.length, d = X[0].length; let [gx, gy] = dr.som_grid || [20, 20];
  if (n < gx * gy / 4) gx = gy = Math.max(2, Math.ceil(Math.sqrt(n * 2)));
  const sigma0 = dr.som_sigma ?? Math.max(gx, gy) / 4, lr0 = 0.5, T = Math.floor(dr.som_iter ?? 5000);
  const mu = new Float64Array(d); for (const x of X) for (let j = 0; j < d; j++) mu[j] += x[j] / n;
  const sub = X.filter((_, i) => i % Math.max(1, Math.floor(n / 2000)) === 0), m = sub.length;      // PCA of the subsample (np.linalg.svd of Xc[::step])
  const C = Array.from({ length: d }, () => new Float64Array(d));
  for (const x of sub) for (let a = 0; a < d; a++) { const xa = x[a] - mu[a]; for (let b = a; b < d; b++) C[a][b] += xa * (x[b] - mu[b]); }
  for (let a = 0; a < d; a++) for (let b = a; b < d; b++) { C[a][b] /= Math.max(1, m - 1); C[b][a] = C[a][b]; }
  const e = new EigenvalueDecomposition(new Matrix(C.map((r) => Array.from(r))), { assumeSymmetric: true }), ev = e.realEigenvalues, V = e.eigenvectorMatrix;
  const ord = ev.map((v, i) => i).sort((a, b) => ev[b] - ev[a]), v0 = ord[0], v1 = ord[1], sd0 = Math.sqrt(Math.max(ev[v0], 0)), sd1 = d > 1 ? Math.sqrt(Math.max(ev[v1], 0)) : 0;
  const lin = (k, N) => N === 1 ? 0 : -1.5 + 3 * k / (N - 1);
  const W = []; for (let i = 0; i < gx; i++) for (let j = 0; j < gy; j++) W.push(Float64Array.from({ length: d }, (_, t) => mu[t] + lin(i, gx) * V.get(t, v0) * sd0 + (d > 1 ? lin(j, gy) * V.get(t, v1) * sd1 : 0)));
  const R = rng(seed + 31), order = Array.from({ length: T }, (_, t) => t % n);
  for (let i = T - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  const bmu = (x) => { let b = 0, bd = Infinity; for (let u = 0; u < W.length; u++) { const v = d2(x, W[u]); if (v < bd) { bd = v; b = u; } } return b; };
  for (let t = 0; t < T; t++) {
    const x = X[order[t]], w = bmu(x), ci = Math.floor(w / gy), cj = w % gy, eta = lr0 / (1 + t / (T / 2)), sig = sigma0 / (1 + t / (T / 2)), dd2 = 2 * sig * sig;
    for (let u = 0; u < W.length; u++) { const i = Math.floor(u / gy), j = u % gy, g = Math.exp(-((i - ci) ** 2) / dd2) * Math.exp(-((j - cj) ** 2) / dd2) * eta;
      if (g < 1e-12) continue; const Wu = W[u]; for (let k = 0; k < d; k++) Wu[k] += g * (x[k] - Wu[k]); }
  }
  return X.map((x) => { let b1 = 0, b2 = 1, d1 = Infinity, dd = Infinity;
    for (let u = 0; u < W.length; u++) { const v = d2(x, W[u]); if (v < d1) { dd = d1; b2 = b1; d1 = v; b1 = u; } else if (v < dd) { dd = v; b2 = u; } }
    const f = Math.sqrt(d1) / (Math.sqrt(d1) + Math.sqrt(dd) + 1e-12) * 0.5, p1 = [Math.floor(b1 / gy), b1 % gy], p2 = [Math.floor(b2 / gy), b2 % gy];
    return [p1[0] + f * (p2[0] - p1[0]), p1[1] + f * (p2[1] - p1[1])]; });
}
function iforest(X, contamination = 0.03, seed = 42, nTrees = 200) {   // sklearn IsolationForest: max_samples 256, score = mean path
  const n = X.length, d = X[0].length, R = rng(seed + 13), psi = Math.min(256, n), H = Math.ceil(Math.log2(psi));
  const cN = (m) => m > 2 ? 2 * (Math.log(m - 1) + 0.5772156649) - 2 * (m - 1) / m : m === 2 ? 1 : 0;
  const build = (idx, h) => {
    if (h >= H || idx.length <= 1) return { size: idx.length };
    const f = Math.floor(R() * d); let lo = Infinity, hi = -Infinity; for (const i of idx) { lo = Math.min(lo, X[i][f]); hi = Math.max(hi, X[i][f]); }
    if (!(hi > lo)) return { size: idx.length };
    const s = lo + R() * (hi - lo), L = [], Rr = []; for (const i of idx) (X[i][f] < s ? L : Rr).push(i);
    return { f, s, l: build(L, h + 1), r: build(Rr, h + 1) };
  };
  const trees = []; for (let t = 0; t < nTrees; t++) { const idx = []; const used = new Set(); while (idx.length < psi) { const i = Math.floor(R() * n); if (!used.has(i)) { used.add(i); idx.push(i); } } trees.push(build(idx, 0)); }
  const path = (x, node, h) => node.size != null ? h + cN(node.size) : path(x, x[node.f] < node.s ? node.l : node.r, h + 1);
  const raw = X.map((x) => { let s = 0; for (const t of trees) s += path(x, t, 0); return Math.pow(2, -(s / nTrees) / cN(psi)); });
  const thr = quantile(Float64Array.from(raw).sort(), 1 - contamination);
  return { flag: Int32Array.from(raw, (v) => v > thr ? 1 : 0), score: rankPct(raw) };
}
function knn(Z, k) {
  const n = Z.length; k = Math.min(k, n - 1); const idx = new Int32Array(n * Math.max(k, 0)), dist = new Float32Array(n * Math.max(k, 0));
  if (k < 1) return { idx, dist, k: 0 };
  for (let i = 0; i < n; i++) {
    const best = []; for (let j = 0; j < n; j++) if (j !== i) { const v = d2(Z[i], Z[j]); if (best.length < k || v < best[best.length - 1][0]) { best.push([v, j]); best.sort((a, b) => a[0] - b[0]); if (best.length > k) best.pop(); } }
    best.forEach(([v, j], t) => { idx[i * k + t] = j; dist[i * k + t] = Math.sqrt(v); });
  }
  return { idx, dist, k };
}
const unit = (v) => { let lo = Infinity, hi = -Infinity; for (const x of v) { lo = Math.min(lo, x); hi = Math.max(hi, x); } return Array.from(v, (x) => hi - lo > 1e-12 ? (x - lo) / (hi - lo) : 0.5); };
function computeReading(get, n, groups, spec, level, progress0) {
  const progress = (st) => { checkCancel(); progress0(st); }, hits = {}, seed = spec.seed ?? 42, J = JSON.stringify;
  const xKey = J(["X", level, spec.features, spec.scaler, spec.weights, spec.balance_groups, spec.pre_pca]);
  const blocks = selectColumns(groups, spec), { X, features } = cached(xKey, () => prepare(get, n, blocks, spec), hits, "prep");
  const drKey = J(["dr", xKey, spec.dr, seed]);
  progress("dr");
  const cosine = (a, b) => { let s = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return 1 - s / (Math.sqrt(na * nb) || 1); };
  const reduce = (dims) => { if (n <= dims + 1) return X.map((x) => Array.from({ length: dims }, (_, j) => x[j] || 0));
    const method = spec.dr.method || "umap";                     // readings.run_dr
    if (method === "pca") return pca(X, Math.min(dims, X[0].length)).map((r) => Array.from(r));
    if (method === "tsne" && dims !== 2) throw new Error(`${spec.name}: t-SNE maps are 2-D here — cluster in the 2-D map or in feature space`);
    if (method === "tsne") return tsne(X, dims, Math.min(spec.dr.perplexity ?? 30, Math.max(1, (n - 1) / 3)), seed, (it) => progress(`dr · t-SNE ${it}/1000`));
    if (method === "som") return som(X, spec.dr, seed);
    const nn = Math.max(2, Math.min(spec.dr.n_neighbors ?? 15, n - 1)), opt = { nComponents: dims, nNeighbors: nn, minDist: spec.dr.min_dist ?? 0.1, random: rng(seed) };
    if (spec.dr.metric === "cosine") opt.distanceFn = cosine;
    const um = new UMAP(opt), ne = um.initializeFit(X.map((r) => Array.from(r)));      // = fit(), stepped so that stop can interrupt it
    for (let e = 0; e < ne; e++) { um.step(); if (e % 25 === 24) checkCancel(); }
    return um.getEmbedding(); };
  const emb = cached(drKey, () => reduce(2), hits, "dr");
  const cs = spec.cluster || { k: "auto" }; let Zc = X, dep = xKey;
  if ((cs.space || "feature") === "dr") { const cd = +(cs.dims || 2); dep = J([drKey, cd]);
    Zc = cd === 2 ? emb : cached(J(["dr_cluster", drKey, cd]), () => (progress("dr_cluster"), reduce(cd)), hits, "dr_cluster"); }
  progress("cluster"); const cl = cached(J(["cluster", dep, cs, seed]), () => clustering(Zc.map((r) => Float64Array.from(r)), cs, seed), hits, "cluster");
  progress("anomaly"); const an = cached(J(["anomaly", xKey, spec.anomaly, seed]), () => { const am = spec.anomaly || {}, cont = am.contamination ?? 0.03; if (n < 5) return { flag: new Int32Array(n), score: new Float64Array(n) };
      if ((am.method || "iforest") === "lof") { const r = lof(X, am.n_neighbors ?? 20, cont); return { flag: r.flag, score: rankPct(r.raw) }; }
      if ((am.method || "iforest") !== "iforest") throw new Error(`unknown anomaly method ${am.method}`);
      return iforest(X, cont, seed); }, hits, "anomaly");
  const ks = spec.knn || {}, kSpace = ks.space || "feature";
  progress("knn"); const kn = cached(J(["knn", kSpace === "feature" ? xKey : drKey, ks]), () => knn(kSpace === "feature" ? X : emb, ks.k ?? 10), hits, "knn"), k2 = knn(emb, (spec.density || {}).k ?? 10);
  const inv = new Float64Array(n); for (let i = 0; i < n; i++) { let s = 0; for (let t = 0; t < k2.k; t++) s += k2.dist[i * k2.k + t]; inv[i] = k2.k ? 1 / (s / k2.k + 1e-12) : 1; }
  const density = k2.k ? rankPct(inv) : new Float64Array(n).fill(0.5);
  return { x: unit(emb.map((e) => e[0])), y: unit(emb.map((e) => e[1])), c: Array.from(cl.labels), o: Array.from(an.flag), os: Array.from(an.score), d: Array.from(density),
           n_clusters: cl.info.n_clusters, noise_class: cl.info.noise_class ?? null, n_noise: cl.info.n_noise || 0, k_auto: cl.info.k_auto || null, silhouette: cl.info.silhouette ?? null,
           spec, features, knn: Array.from(kn.idx), k: kn.k, cache_hits: hits,
           _arts: { X, emb, Zc, knn: kn, labels: cl.labels, silhouette: cl.info.silhouette ?? null } };
}

// ------------------------------------------------------------------ the readings comparison (readings.compare)
function contingency(a, b) {                                     // labels → integer codes, then the counts table
  const code = (v) => { const m = new Map(); return { c: Int32Array.from(v, (x) => { if (!m.has(x)) m.set(x, m.size); return m.get(x); }), k: m.size }; };
  const A = code(a), B = code(b), n = a.length, C = new Float64Array(A.k * B.k), ra = new Float64Array(A.k), rb = new Float64Array(B.k);
  for (let i = 0; i < n; i++) { C[A.c[i] * B.k + B.c[i]]++; ra[A.c[i]]++; rb[B.c[i]]++; }
  return { C, ra, rb, n, ka: A.k, kb: B.k }; }
const trivial = (t) => t.ka === t.kb && (t.ka === 1 || t.ka === t.n);   // sklearn: both partitions all-one or all-singletons → 1
function ari(a, b) {                                             // sklearn adjusted_rand_score
  const t = contingency(a, b), c2 = (x) => x * (x - 1) / 2; if (trivial(t)) return 1;
  let sc = 0, sa = 0, sb = 0; for (const v of t.C) sc += c2(v); for (const v of t.ra) sa += c2(v); for (const v of t.rb) sb += c2(v);
  const exp = sa * sb / c2(t.n), mx = (sa + sb) / 2; return mx === exp ? 0 : (sc - exp) / (mx - exp); }
function nmi(a, b) {                                             // sklearn normalized_mutual_info_score (average_method "arithmetic")
  const t = contingency(a, b), n = t.n; if (t.ka === 1 && t.kb === 1 || trivial(t)) return 1;
  const H = (r) => { let h = 0; for (const v of r) if (v) h -= v / n * Math.log(v / n); return h; }, ha = H(t.ra), hb = H(t.rb);
  let mi = 0; for (let x = 0; x < t.ka; x++) for (let y = 0; y < t.kb; y++) { const v = t.C[x * t.kb + y]; if (v) mi += v / n * Math.log(v * n / (t.ra[x] * t.rb[y])); }
  const den = (ha + hb) / 2; return den <= 0 ? 0 : Math.max(0, mi) / den; }
function trustworthiness(X, E, k) {                              // sklearn.manifold.trustworthiness (euclidean)
  const n = X.length, rank = new Int32Array(n * n), ord = new Int32Array(n), dist = new Float64Array(n);
  for (let i = 0; i < n; i++) { for (let j = 0; j < n; j++) dist[j] = j === i ? Infinity : d2(X[i], X[j]);
    for (let j = 0; j < n; j++) ord[j] = j; ord.sort((p, q) => dist[p] - dist[q] || p - q);
    for (let r = 0; r < n; r++) rank[i * n + ord[r]] = r + 1; }
  const kn = knn(E, k); let t = 0;
  for (let i = 0; i < n; i++) for (let s = 0; s < k; s++) { const r = rank[i * n + kn.idx[i * k + s]] - k; if (r > 0) t += r; }
  return 1 - t * (2 / (n * k * (2 * n - 3 * k - 1))); }
function knnFar(X, file, t0, k = 10, excl = 4.0) {               // readings._knn_excluding_neighbours
  const n = X.length, kk = Math.min(n - 1, k + 4 * Math.ceil(2 * excl) + 1), kn = knn(X, kk), out = new Int32Array(n * k);
  for (let i = 0; i < n; i++) { const keep = [];
    for (let s = 0; s < kn.k && keep.length < k; s++) { const j = kn.idx[i * kn.k + s]; if (!(file[j] === file[i] && Math.abs(t0[j] - t0[i]) < excl)) keep.push(j); }
    for (let s = 0; s < k; s++) out[i * k + s] = s < keep.length ? keep[s] : keep.length ? keep[keep.length - 1] : i; }
  return out; }
function groupings(F, fileOf, cmp, level) {                      // readings.groupings: "file_id" or {column, patterns} (regex, later wins)
  const out = {};
  for (const [g, sp] of Object.entries(cmp.groupings || {})) {
    if (sp === "file_id") { if (level !== "l0") out[g] = fileOf.slice(); continue; }
    const col = F.map((f) => String(sp.column === "filename" ? f.name : sp.column === "rel_path" || sp.column === "path" ? f.rel_path : sp.column === "folder" ? f.folder : f.name));
    const lab = col.map((c) => { let l = "other"; for (const [label, pat] of Object.entries(sp.patterns || {})) if (new RegExp(pat).test(c)) l = label; return l; });
    out[g] = fileOf.map((fi) => lab[fi]);
  }
  return out; }
function compare(levels, F, cfgCompare, progress) {
  const out = {}, r3 = (v) => +(+v).toFixed(3);
  for (const lv of ["l1", "l0"]) {
    const res = levels[lv].readings, names = Object.keys(res); if (!names.length) continue;
    progress(lv);
    const labs = Object.fromEntries(names.map((nm) => [nm, Array.from(res[nm]._arts.labels)]));
    const pair = { ari: {}, nmi: {} };
    for (const a of names) { pair.ari[a] = {}; pair.nmi[a] = {}; for (const b of names) { pair.ari[a][b] = r3(ari(labs[a], labs[b])); pair.nmi[a][b] = r3(nmi(labs[a], labs[b])); } }
    const fileOf = levels[lv].file, grp = groupings(F, fileOf, cfgCompare || {}, lv), per = {};
    const R = rng(0);
    for (const nm of names) {
      const A = res[nm]._arts, X = A.X, n = X.length, nn = Math.min(10, Math.floor((n - 1) / 2) - 1);
      const row = { n_clusters: res[nm].n_clusters, silhouette: A.silhouette };
      if (nn >= 1) { let sel = Array.from({ length: n }, (_, i) => i);
        if (n > 2000) { for (let i = n - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [sel[i], sel[j]] = [sel[j], sel[i]]; } sel = sel.slice(0, 2000); }
        row.trustworthiness = r3(trustworthiness(sel.map((i) => X[i]), sel.map((i) => [A.emb[i][0], A.emb[i][1]]), nn)); }
      checkCancel();
      const far = lv === "l1" ? knnFar(X, fileOf, levels.l1.t0raw, 10, (cfgCompare || {}).exclude_s ?? 4.0) : null;
      for (const [g, lab] of Object.entries(grp)) {
        if (far) { let s = 0; for (let i = 0; i < n; i++) for (let t = 0; t < 10; t++) s += lab[far[i * 10 + t]] === lab[i]; row[`knn_purity_far_${g}`] = r3(s / (n * 10)); }
        row[`ari_${g}`] = r3(ari(lab, labs[nm])); row[`nmi_${g}`] = r3(nmi(lab, labs[nm]));
        const kn = A.knn; if (kn.k) { let s = 0; for (let i = 0; i < n; i++) for (let t = 0; t < kn.k; t++) s += lab[kn.idx[i * kn.k + t]] === lab[i]; row[`knn_purity_${g}`] = r3(s / (n * kn.k));
          const cnt = {}; for (const l of lab) cnt[l] = (cnt[l] || 0) + 1; let ch = 0; for (const v of Object.values(cnt)) ch += (v / n) ** 2; row[`knn_chance_${g}`] = r3(ch); }
        const ct = new Map(); labs[nm].forEach((c, i) => { const m = ct.get(c) || new Map(); m.set(lab[i], (m.get(lab[i]) || 0) + 1); ct.set(c, m); });
        let dom = 0; for (const m of ct.values()) dom += Math.max(...m.values()); row[`cluster_purity_${g}`] = r3(dom / n);
      }
      per[nm] = row;
    }
    out[lv] = { pairwise: pair, readings: per, groupings: Object.keys(grp) };
  }
  return out;
}

// ------------------------------------------------------------------ keys (readings.key_stats / osc_key_tuple) and the payload
function keyStats(name, values, kind, family, desc, nClasses = 0, labels = null) {
  const v = Array.from(values).filter(Number.isFinite); let mn = Infinity, mx = -Infinity, mu = 0; for (const x of v) { mn = Math.min(mn, x); mx = Math.max(mx, x); mu += x; } mu = v.length ? mu / v.length : 0;
  let sd = 0; for (const x of v) sd += (x - mu) ** 2; sd = v.length ? Math.sqrt(sd / v.length) : 0;
  const k = { name, kind, min: v.length ? mn : 0, max: v.length ? mx : 0, mean: mu, std: sd, n_classes: nClasses, noise_class: -1, family, desc };
  if (labels) { k.labels = labels; k.desc = (desc ? desc + " · " : "") + labels.map((l, i) => `${i}=${l}`).join(" "); }
  return k;
}
const tuple = (k) => [k.name, k.kind, k.min, k.max, k.mean, k.std, k.n_classes, k.noise_class ?? -1, k.family || ""];
const round = (v, nd = 4) => Number.isFinite(v) ? +(+v).toPrecision(nd) : 0;

async function finish(cfg, opts = {}) {
  const F = files.filter(Boolean); if (!F.length) throw new Error("no audio files could be read");
  const cols = F[0].cols, groups = F[0].groups, ci = new Map(cols.map((c, i) => [c, i]));
  const l1 = []; F.forEach((f, fi) => f.rows.forEach((r, k) => l1.push({ fi, k, r })));
  const n1 = l1.length, n0 = F.length, get1 = (c, i) => l1[i].r[ci.get(c)], get0 = (c, i) => F[i].whole[ci.get(c)];
  // readings.py: spec = deep_merge(defaults, reading) (the config lists each reading's overrides only)
  const merge = (a, b) => { if (b == null) return a; if (typeof a !== "object" || a == null || Array.isArray(a) || typeof b !== "object" || Array.isArray(b)) return b;
    const o = Object.assign({}, a); for (const [k, v] of Object.entries(b)) o[k] = merge(a[k], v); return o; };
  const rc = cfg.readings || {}, defs = rc.defaults || {};
  const specs = (rc.readings || []).map((r) => Object.assign(merge(defs, Object.fromEntries(Object.entries(r).filter(([k]) => k !== "name"))), { name: r.name, seed: r.seed ?? rc.seed ?? 42 }))
    .filter((s) => groups.clap || !((s.features || {}).groups || []).includes("clap"));
  if (!specs.length) specs.push({ name: "mir_umap", features: { groups: ["spectral", "energy", "mfcc", "chroma", "rhythm"], stats: ["mean", "std"], exclude: ["tempo"] },
                                  scaler: { method: "robust", clip: 5 }, dr: { method: "umap", n_neighbors: 15, min_dist: 0.1 }, cluster: { method: "kmeans", k: "auto", k_range: [3, 10] },
                                  anomaly: { method: "iforest", contamination: 0.03 }, knn: { k: 10 }, seed: 42 });
  const catalogue = opts.catalogue || [], keysCfg = rc.keys || {}, fam = (code) => familyConfig(catalogue, keysCfg, code);
  const s2 = (fam("S2").features || []).filter((k) => S2_ALL[k] && ci.has(S2_ALL[k]));            // S2: the raw features sent live
  const levels = { l1: { n: n1, file: l1.map((e) => e.fi), feats: {}, readings: {} }, l0: { n: n0, file: F.map((_, i) => i), feats: {}, readings: {} } };
  for (const key of s2) { const col = S2_ALL[key]; levels.l1.feats[key] = l1.map((e) => round(e.r[ci.get(col)])); levels.l0.feats[key] = F.map((f) => round(f.whole[ci.get(col)])); }
  const total = specs.length * 2; let done = 0;
  for (const spec of specs) for (const [lv, n, get] of [["l1", n1, get1], ["l0", n0, get0]]) {
    const t = performance.now(), r = computeReading(get, n, groups, spec, lv, (stage) => post({ type: "progress", stage: "readings", sub: `${lv}.${spec.name}.${stage}`, done, total }));
    levels[lv].readings[spec.name] = r; done++;
    post({ type: "progress", stage: "readings", done, total, reading: spec.name, level: lv, cache_hits: r.cache_hits, seconds: +((performance.now() - t) / 1000).toFixed(2) });
  }
  levels.l1.t0raw = l1.map((e) => F[e.fi].t0[e.k]);
  post({ type: "progress", stage: "compare", state: "start" });
  const comparison = compare(levels, F, rc.compare, () => post({ type: "progress", stage: "compare", state: "run" }));
  post({ type: "progress", stage: "compare", state: "end" });
  delete levels.l1.t0raw;
  // keys (readings._keys_stage + keys.py): the base keys of each reading, then every enabled family
  post({ type: "progress", stage: "keys", state: "start" });
  const clipIds = l1.map((e) => `${F[e.fi].file_id}:${Math.round(F[e.fi].t0[e.k] * 1000)}`), t0 = l1.map((e) => F[e.fi].t0[e.k]), t1 = l1.map((e) => F[e.fi].t1[e.k]);
  let text = null;
  if (fam("Y11").enabled && groups.clap) {                        // keys.text_embeddings: the prompts through the CLAP text tower, collapse check
    if (!opts.textModel) text = { error: "the CLAP text model is not available to this page" };
    else if (opts.textModel.error) text = { error: opts.textModel.error };
    else { try { const tm = opts.textModel, prompts = (fam("Y11").prompts || []).map(String);
      await CLAP.loadText(tm.parts, tm.vocab, tm.merges, tm.ort, tm.wasm, (got, total) => post({ type: "progress", stage: "text_model", got, total }));
      const T = await CLAP.embedText(prompts); let off = 0;
      for (let a = 0; a < T.length; a++) for (let b = 0; b < T.length; b++) if (a !== b) { let q = 0; for (let x = 0; x < T[a].length; x++) q += T[a][x] * T[b][x]; off += q; }
      const mo = T.length > 1 ? off / (T.length * (T.length - 1)) : 0;
      text = mo > 0.98 ? { error: `${tm.model}: the text tower maps different prompts to almost the same vector (mean pairwise cosine ${mo.toFixed(4)} > 0.98); text keys skipped` } : { prompts, T, model: tm.model };
    } catch (e) { text = { error: `CLAP text model: ${e.message || e}` }; } }
  }
  const res1 = {};
  for (const spec of specs) { const r = levels.l1.readings[spec.name], A = r._arts;
    res1[spec.name] = { labels: Int32Array.from(r.c), noise: r.noise_class, Zc: A.Zc, knnIdx: A.knn.idx, knnDist: A.knn.dist, k: A.knn.k, spec }; }
  const K = computeKeys({ n: n1, col: (c) => ci.has(c) ? Float64Array.from(l1, (e) => e.r[ci.get(c)]) : null, groups, fileOf: Int32Array.from(l1, (e) => e.fi), t0, t1,
    files: F.map((f) => ({ name: f.name, rel_path: f.rel_path, folder: f.folder, duration: f.duration, file_id: f.file_id })), results: res1, keysCfg, catalogue,
    labelsCsv: opts.labelsCsv || null, text, clipIds, agglomerative });
  const live = K.live, kv = {}, rkeys = {};
  for (const k of live) kv[k.name] = Array.from(k.values, (v) => round(v));
  for (const spec of specs) { const nm = spec.name, r = levels.l1.readings[nm], info = { n_clusters: r.n_clusters, noise_class: r.noise_class }, fd = baseReadingDescs(nm, info, spec);
    const base = [keyStats(`${nm}.x`, r.x, "signal", fd.x[0], fd.x[1]), keyStats(`${nm}.y`, r.y, "signal", fd.y[0], fd.y[1]),
                  Object.assign(keyStats(`${nm}.cluster`, r.c, "symbol", fd.cluster[0], fd.cluster[1], r.n_clusters + (r.noise_class != null ? 1 : 0)), { noise_class: r.noise_class ?? -1 }),
                  keyStats(`${nm}.outlier`, r.o, "symbol", fd.outlier[0], fd.outlier[1], 2, ["no", "outlier"]),
                  keyStats(`${nm}.outlier_score`, r.os, "signal", fd.outlier_score[0], fd.outlier_score[1]), keyStats(`${nm}.density`, r.d, "signal", fd.density[0], fd.density[1])];
    const extra = K.readingKeys[nm].map((k) => { kv[k.name] = Array.from(k.values, (v) => round(v)); return Object.assign(keyStats(k.name, k.values, k.kind, k.family, k.desc, k.n_classes, k.labels), { noise_class: k.noise_class ?? -1 }); });
    const ks = base.concat(extra); rkeys[nm] = ks; r.osc_keys = ks.map(tuple); levels.l0.readings[nm].osc_keys = base.map(tuple);
    kv[`${nm}.x`] = r.x; kv[`${nm}.y`] = r.y; kv[`${nm}.cluster`] = r.c; kv[`${nm}.outlier`] = r.o; kv[`${nm}.outlier_score`] = r.os; kv[`${nm}.density`] = r.d; }
  const liveStats = live.map((k) => keyStats(k.name, k.values, k.kind, k.family, k.desc, k.n_classes, k.labels));
  const flags = Object.fromEntries(Object.entries(K.events).map(([e, v]) => [e, Array.from(v).flatMap((x, i) => x ? [i] : [])]));
  post({ type: "progress", stage: "keys", state: "end" });
  for (const lv of ["l1", "l0"]) for (const r of Object.values(levels[lv].readings)) { delete r._arts; if (lv === "l0") { delete r.knn; delete r.k; } }
  Object.assign(levels.l1, { clip_id: clipIds, t0: t0.map((v) => +v.toFixed(6)), t1: t1.map((v) => +v.toFixed(6)), kv, flags });
  for (const lv of ["l1", "l0"]) for (const r of Object.values(levels[lv].readings)) for (const f of ["x", "y", "os", "d"]) r[f] = r[f].map((v) => round(v));
  const meta = (k) => ({ name: k.name, kind: k.kind, family: k.family, desc: k.desc, n_classes: k.n_classes, noise_class: k.noise_class === -1 ? null : k.noise_class, labels: k.labels || null, min: k.min, max: k.max });
  const version = String(Date.now());
  const warnings = K.warnings.slice(), clapModel = (((cfg.phase2 || {}).features || {}).clap || {}).model;
  if (groups.clap && opts.clapUsed && clapModel && opts.clapUsed !== clapModel) warnings.push(`CLAP: ${clapModel} is not in this page — the embeddings are ${opts.clapUsed}`);
  if (!groups.clap) warnings.push("computed in your browser without CLAP: the CLAP readings and text tags need the CLAP step (◫ your corpus → + CLAP)");
  const payload = { version, label: "your corpus", corpus: "your corpus", corpus_name: cfg.corpus_name || "your_corpus", readings: specs.map((s) => s.name),
    live: s2, keys: { live: liveStats.map(meta), readings: Object.fromEntries(Object.entries(rkeys).map(([n, ks]) => [n, ks.map(meta)])), warnings },
    tracks: F.map((f) => ({ file_id: f.file_id, name: f.name.replace(/\.[^.]+$/, ""), rel_path: f.rel_path, duration: +f.duration.toFixed(2) })),
    levels, comparison, config: { phase2: cfg.phase2 || {}, readings: cfg.readings || {} } };
  const link = { set_id: `dmc_${payload.corpus_name}`, version: "web-0.2", live_block: "_live", live_keys: liveStats.map(tuple),
    live_infos: Object.fromEntries(liveStats.map((k) => [k.name, k.desc])),
    readings: Object.fromEntries(Object.entries(rkeys).map(([n, ks]) => [n, { osc_keys: ks.map(tuple), infos: Object.fromEntries(ks.map((k) => [k.name, k.desc])) }])),
    families: Object.fromEntries(["E1", "E3", "E4", "E5", "E6", "E7", "E8"].map((c) => [c, fam(c)])),
    events_e4: Object.fromEntries(F.map((f) => [f.file_id, f.events])) };
  // the clips' CLAP embeddings for the page's reference probe (bridge.compute_probe: CLAP, centred), when computed
  let clap = null;
  if (groups.clap) { const cc = groups.clap.map((c) => ci.get(c)), d = cc.length; clap = new Float32Array(n1 * d);
    l1.forEach((e, i) => { for (let j = 0; j < d; j++) clap[i * d + j] = e.r[cc[j]]; }); }
  return { payload, link, clap };
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    if (m.type === "file") { cancelFlag = m.cancel || null; await addFile(m); post({ type: "progress", stage: "features", done: m.i + 1, total: m.total, name: m.name }); }
    else if (m.type === "dump") post({ type: "dump", files: files.filter(Boolean).map((f) => ({ name: f.name, rel_path: f.rel_path, t0: f.t0, t1: f.t1, cols: f.cols, rows: f.rows, whole: f.whole, groups: f.groups, events: f.events, note: f.note })) });   // the Phase 2 table, for tests
    else if (m.type === "restore") { files.length = 0; CACHE.clear(); clapOn = false; m.files.forEach((f, i) => { files[i] = f; }); post({ type: "restored", n: files.length }); }   // a saved analysis (.dmc)
    else if (m.type === "reset") { files.length = 0; clapOn = false; CACHE.clear(); }
    else if (m.type === "text") {                                 // the text probe (bridge.compute_probe "text" + keys.text_embeddings' collapse check)
      await CLAP.loadText(m.parts, m.vocab, m.merges, m.ort, m.wasm, (got, total) => post({ type: "progress", stage: "text_model", got, total }));
      const T = await CLAP.embedText([m.text, ...CLAP.DEFAULT_PROMPTS]), P = T.length; let off = 0;
      for (let a = 0; a < P; a++) for (let b = 0; b < P; b++) if (a !== b) { let s = 0; for (let i = 0; i < T[a].length; i++) s += T[a][i] * T[b][i]; off += s; }
      const mean = off / (P * (P - 1));
      post({ type: "text_embed", text: m.text, vec: T[0], collapsed: mean > 0.98, mean_pairwise: +mean.toFixed(4) }, [T[0].buffer]);
    }
    else if (m.type === "clap") { await CLAP.load(m.model, m.ort, m.wasm, (got, total) => post({ type: "progress", stage: "clap_model", got, total }), !!m.fused);
                                   clapOn = true; post({ type: "clap_ready", threads: CLAP.threads() }); }
    else if (m.type === "finish") { const t = performance.now(); cancelFlag = m.cancel || null;
      const catalogue = m.catalogue || await fetch(new URL("../data/keys_catalogue.json", import.meta.url)).then((q) => q.json());
      const r = await finish(m.config || {}, { catalogue, textModel: m.textModel || null, labelsCsv: m.labelsCsv || null, clapUsed: m.clapUsed || null }); post({ type: "done", ...r, seconds: +((performance.now() - t) / 1000).toFixed(1) }, r.clap ? [r.clap.buffer] : []); }
  } catch (e) { if (String(e && e.message) === "__cancelled__") post({ type: "cancelled" }); else post({ type: "error", error: String(e && e.stack || e) }); }
};
export { dbscan, agglomerative, hdbscan, lof, spectral, kmeans, silhouette, clustering, gmm, tsne, som, pca, ari, nmi, trustworthiness, knnFar, compare };
