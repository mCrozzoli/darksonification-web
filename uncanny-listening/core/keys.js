// Copied from projects/designs/dark_music_corpus/web_implementation/core/keys.js on 2026-10-27 for Uncanny Listening (credit: the
// Dark Music Corpus web engine). Changes here: none.
// Dark Music Corpus — the key families in the browser (2026-10-23): a port of dev/engine/dmc/keys.py.
// The catalogue itself is data/keys_catalogue.json (exported from keys.CATALOGUE); familyConfig() is keys.family_config.
// Every family the desktop computes is computed here, with the same names, kinds, descriptions and numbers:
//   live (reading-independent): S2 S4 S5 S6 S7 S13 S14 S18 · Y5 (+ labels.csv) Y6 Y7 Y8 Y9 Y11 Y12 · E5 flags
//   per reading: S7 S9 S10 S12/S16 S13 · Y2 Y3 Y10
// Y3 runs networkx 3.5's Louvain and sampled betweenness exactly: CPython's Mersenne Twister seeded with 0, its
// shuffle / sample / _randbelow, and the graphs' insertion-ordered adjacency (TESTS §8). pandas' rolling windows,
// numpy's linear percentiles, Python's half-to-even round() and scipy's find_peaks (prominence + distance) are
// written out where the desktop uses them.

// ------------------------------------------------------------------ small numerics (numpy / pandas semantics)
const roundEven = (x) => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 ? r - 1 : r; };
const mean = (a) => { let s = 0; for (const v of a) s += v; return a.length ? s / a.length : NaN; };
const stdPop = (a) => { const m = mean(a); let s = 0; for (const v of a) s += (v - m) ** 2; return a.length ? Math.sqrt(s / a.length) : NaN; };
const medianOf = (a) => { const s = Float64Array.from(a).sort(), n = s.length; return !n ? NaN : n % 2 ? s[(n - 1) / 2] : 0.5 * (s[n / 2 - 1] + s[n / 2]); };
function percentile(a, q) {                                       // np.percentile (linear)
  const s = Float64Array.from(a).sort(), n = s.length; if (!n) return NaN; const pos = (n - 1) * q / 100, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo); }
function rankPct(v) {                                             // pandas rank(pct=True), ties averaged
  const n = v.length, idx = Array.from(v, (_, i) => i).sort((a, b) => v[a] - v[b]), r = new Float64Array(n); let i = 0;
  while (i < n) { let j = i; while (j + 1 < n && v[idx[j + 1]] === v[idx[i]]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k]] = avg / n; i = j + 1; }
  return r; }
function rolling(v, w, center = false) {                          // pd.Series.rolling(w, min_periods=1, center).mean()
  const n = v.length, out = new Float64Array(n), off = center ? Math.floor((w - 1) / 2) : 0;   // pandas: end = i + (w − 1) // 2
  for (let i = 0; i < n; i++) { const e = Math.min(n - 1, i + off), s = Math.max(0, i + off - w + 1); let t = 0; for (let k = s; k <= e; k++) t += v[k]; out[i] = t / (e - s + 1); }
  return out; }
function slope(v, w) {                                            // rolling(w, min_periods=2) cov(x, index) / var(index), NaN → 0
  const n = v.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) { const s = Math.max(0, i - w + 1), m = i - s + 1; if (m < 2) continue;
    let mx = 0, mt = 0; for (let k = s; k <= i; k++) { mx += v[k]; mt += k; } mx /= m; mt /= m;
    let c = 0, vv = 0; for (let k = s; k <= i; k++) { c += (v[k] - mx) * (k - mt); vv += (k - mt) ** 2; } out[i] = vv > 0 ? c / vv : 0; }
  return out; }
const minmax = (v) => { let lo = Infinity, hi = -Infinity; for (const x of v) { lo = Math.min(lo, x); hi = Math.max(hi, x); } return Float64Array.from(v, (x) => hi > lo ? (x - lo) / (hi - lo) : 0); };
function qbin(v, b) {                                             // np.quantile edges + searchsorted(side="right")
  const s = Float64Array.from(v).sort(), n = s.length, edges = [];
  for (let k = 1; k < b; k++) { const q = k / b, pos = (n - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos); edges.push(s[lo] + (s[hi] - s[lo]) * (pos - lo)); }
  return Int32Array.from(v, (x) => { let c = 0; for (const e of edges) if (e <= x) c++; return c; }); }
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
const fmtG = (x) => { const s = Number(x).toPrecision(6); return String(+s); };                  // Python's :g for the values used in descriptions
const pctFmt = (x) => `${Math.round(x * 100)}%`;
const d2 = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) { const t = a[k] - b[k]; s += t * t; } return s; };
const pyLess = (a, b) => a < b ? -1 : a > b ? 1 : 0;              // Python's str sort (code points)

// scipy.signal.find_peaks(x, prominence=p, distance=d): local maxima (plateau midpoints), then distance, then prominence
function findPeaks(x, prom, dist) {
  const n = x.length; let peaks = [];
  for (let i = 1; i < n - 1; i++) { if (x[i - 1] < x[i]) { let a = i + 1; while (a < n - 1 && x[a] === x[i]) a++; if (x[a] < x[i]) { peaks.push((i + a - 1) >> 1); i = a; } } }
  if (dist != null && dist > 1 && peaks.length) {
    const d = Math.ceil(dist), keep = new Uint8Array(peaks.length).fill(1), order = peaks.map((_, j) => j).sort((p, q) => x[peaks[p]] - x[peaks[q]] || p - q);
    for (let t = order.length - 1; t >= 0; t--) { const j = order[t]; if (!keep[j]) continue;
      for (let k = j - 1; k >= 0 && peaks[j] - peaks[k] < d; k--) keep[k] = 0;
      for (let k = j + 1; k < peaks.length && peaks[k] - peaks[j] < d; k++) keep[k] = 0; }
    peaks = peaks.filter((_, j) => keep[j]); }
  if (prom != null) peaks = peaks.filter((p) => {
    let lm = x[p]; for (let i = p; i >= 0 && x[i] <= x[p]; i--) if (x[i] < lm) lm = x[i];
    let rm = x[p]; for (let i = p; i < n && x[i] <= x[p]; i++) if (x[i] < rm) rm = x[i];
    return x[p] - Math.max(lm, rm) >= prom; });
  return peaks;
}

// ------------------------------------------------------------------ CPython's random.Random (MT19937)
export class PyRandom {
  constructor(seed) { this.mt = new Uint32Array(624); this.i = 624; this.byArray([seed >>> 0]); }
  genrandInit(s) { const mt = this.mt; mt[0] = s >>> 0; for (let i = 1; i < 624; i++) mt[i] = (Math.imul(1812433253, mt[i - 1] ^ (mt[i - 1] >>> 30)) + i) >>> 0; this.i = 624; }
  byArray(key) { this.genrandInit(19650218); const mt = this.mt; let i = 1, j = 0;
    for (let k = Math.max(624, key.length); k; k--) { const p = mt[i - 1] ^ (mt[i - 1] >>> 30); mt[i] = ((mt[i] ^ Math.imul(p, 1664525)) + key[j] + j) >>> 0; i++; j++; if (i >= 624) { mt[0] = mt[623]; i = 1; } if (j >= key.length) j = 0; }
    for (let k = 623; k; k--) { const p = mt[i - 1] ^ (mt[i - 1] >>> 30); mt[i] = ((mt[i] ^ Math.imul(p, 1566083941)) - i) >>> 0; i++; if (i >= 624) { mt[0] = mt[623]; i = 1; } }
    mt[0] = 0x80000000; }
  u32() { const mt = this.mt;
    if (this.i >= 624) { let y, k = 0, mag = (v) => v & 1 ? 0x9908b0df : 0;
      for (; k < 227; k++) { y = (mt[k] & 0x80000000) | (mt[k + 1] & 0x7fffffff); mt[k] = mt[k + 397] ^ (y >>> 1) ^ mag(y); }
      for (; k < 623; k++) { y = (mt[k] & 0x80000000) | (mt[k + 1] & 0x7fffffff); mt[k] = mt[k - 227] ^ (y >>> 1) ^ mag(y); }
      y = (mt[623] & 0x80000000) | (mt[0] & 0x7fffffff); mt[623] = mt[396] ^ (y >>> 1) ^ mag(y); this.i = 0; }
    let y = mt[this.i++]; y ^= y >>> 11; y ^= (y << 7) & 0x9d2c5680; y ^= (y << 15) & 0xefc60000; y ^= y >>> 18; return y >>> 0; }
  getrandbits(k) { return k === 32 ? this.u32() : this.u32() >>> (32 - k); }      // k ≤ 32 (populations here are far smaller)
  randbelow(n) { const k = 32 - Math.clz32(n); let r = this.getrandbits(k); while (r >= n) r = this.getrandbits(k); return r; }
  shuffle(x) { for (let i = x.length - 1; i > 0; i--) { const j = this.randbelow(i + 1); [x[i], x[j]] = [x[j], x[i]]; } return x; }
  sample(pop, k) { const n = pop.length, out = new Array(k); let setsize = 21; if (k > 5) setsize += 4 ** Math.ceil(Math.log(k * 3) / Math.log(4));
    if (n <= setsize) { const pool = pop.slice(); for (let i = 0; i < k; i++) { const j = this.randbelow(n - i); out[i] = pool[j]; pool[j] = pool[n - i - 1]; } }
    else { const sel = new Set(); for (let i = 0; i < k; i++) { let j = this.randbelow(n); while (sel.has(j)) j = this.randbelow(n); sel.add(j); out[i] = pop[j]; } }
    return out; }
}

// ------------------------------------------------------------------ networkx.Graph (insertion-ordered) + Louvain + betweenness
class Graph {
  constructor() { this.adj = new Map(); this.attr = new Map(); }
  addNode(u, a) { if (!this.adj.has(u)) { this.adj.set(u, new Map()); this.attr.set(u, a || {}); } else if (a) Object.assign(this.attr.get(u), a); }
  addEdge(u, v, w = 1) { this.addNode(u); this.addNode(v); this.adj.get(u).set(v, w); this.adj.get(v).set(u, w); }
  *edges() { const seen = new Set(); for (const [n, nb] of this.adj) { for (const [v, w] of nb) if (!seen.has(v)) yield [n, v, w]; seen.add(n); } }
  degree(u) { const nb = this.adj.get(u); let s = 0; for (const w of nb.values()) s += w; if (nb.has(u)) s += nb.get(u); return s; }
}
function modularity(G, comms, res) {
  const deg = new Map(); let tot = 0; for (const u of G.adj.keys()) { const d = G.degree(u); deg.set(u, d); tot += d; }
  const m = tot / 2, norm = 1 / (tot * tot); let q = 0;
  for (const c of comms) { let Lc = 0; const seen = new Set();
    for (const u of c) { for (const [v, w] of G.adj.get(u)) if (!seen.has(v) && c.has(v)) Lc += w; seen.add(u); }
    let ds = 0; for (const u of c) ds += deg.get(u); q += Lc / m - res * ds * ds * norm; }
  return q; }
function oneLevel(G, m, partition, res, R) {
  const nodes = [...G.adj.keys()], node2com = new Map(nodes.map((u, i) => [u, i])), inner = nodes.map((u) => new Set([u]));
  const deg = new Map(nodes.map((u) => [u, G.degree(u)])), Stot = nodes.map((u) => deg.get(u));
  const nbrs = new Map(nodes.map((u) => { const o = new Map(); for (const [v, w] of G.adj.get(u)) if (v !== u) o.set(v, w); return [u, o]; }));
  const rand = R.shuffle(nodes.slice()); let moves = 1, improvement = false;
  while (moves > 0) { moves = 0;
    for (const u of rand) {
      let bestMod = 0, best = node2com.get(u);
      const w2c = new Map(); for (const [v, w] of nbrs.get(u)) { const c = node2com.get(v); w2c.set(c, (w2c.get(c) || 0) + w); }
      const degree = deg.get(u); Stot[best] -= degree;
      if (!w2c.has(best)) w2c.set(best, 0);                        // defaultdict: reading weights2com[best_com] inserts it
      const remove = -w2c.get(best) / m + res * (Stot[best] * degree) / (2 * m ** 2);
      for (const [c, wt] of w2c) { const gain = remove + wt / m - res * (Stot[c] * degree) / (2 * m ** 2); if (gain > bestMod) { bestMod = gain; best = c; } }
      Stot[best] += degree;
      if (best !== node2com.get(u)) { const com = G.attr.get(u).nodes || new Set([u]), from = node2com.get(u);
        for (const x of com) partition[from].delete(x); inner[from].delete(u); for (const x of com) partition[best].add(x); inner[best].add(u);
        improvement = true; moves++; node2com.set(u, best); }
    } }
  return [partition.filter((s) => s.size), inner.filter((s) => s.size), improvement]; }
function genGraph(G, partition) {
  const H = new Graph(), node2com = new Map();
  partition.forEach((part, i) => { const nodes = new Set(); for (const u of part) { node2com.set(u, i); for (const x of (G.attr.get(u).nodes || [u])) nodes.add(x); } H.addNode(i, { nodes }); });
  for (const [a, b, w] of G.edges()) { const c1 = node2com.get(a), c2 = node2com.get(b), t = H.adj.has(c1) && H.adj.get(c1).has(c2) ? H.adj.get(c1).get(c2) : 0; H.addEdge(c1, c2, w + t); }
  return H; }
function louvain(G, res, seed) {                                  // networkx.community.louvain_communities(G, resolution, seed): the last level
  const R = new PyRandom(seed); let partition = [...G.adj.keys()].map((u) => new Set([u]));
  let mod = modularity(G, partition, res);
  let graph = new Graph(); for (const u of G.adj.keys()) graph.addNode(u); for (const [a, b] of G.edges()) graph.addEdge(a, b, 1);
  let m = 0; for (const u of graph.adj.keys()) m += graph.degree(u); m /= 2;
  let inner, improvement; [partition, inner, improvement] = oneLevel(graph, m, partition, res, R);
  improvement = true; let last = null;
  while (improvement) { last = partition.map((s) => new Set(s));                  // louvain_partitions yields, then tests
    const nm = modularity(graph, inner, res); if (nm - mod <= 1e-7) return last; mod = nm;
    graph = genGraph(graph, inner); [partition, inner, improvement] = oneLevel(graph, m, partition, res, R); }
  return last;
}
function betweenness(G, k, seed) {                                 // networkx.betweenness_centrality(G, k, seed=seed), normalised, no endpoints
  const nodesAll = [...G.adj.keys()], n = nodesAll.length, b = new Map(nodesAll.map((u) => [u, 0]));
  let kk = k === n ? null : k; const sources = kk == null ? nodesAll : new PyRandom(seed).sample(nodesAll, kk);
  for (const s of sources) {
    const S = [], P = new Map(nodesAll.map((u) => [u, []])), sigma = new Map(nodesAll.map((u) => [u, 0])), D = new Map([[s, 0]]); sigma.set(s, 1);
    const Q = [s]; let qh = 0;
    while (qh < Q.length) { const v = Q[qh++]; S.push(v); const Dv = D.get(v), sv = sigma.get(v);
      for (const w of G.adj.get(v).keys()) { if (!D.has(w)) { Q.push(w); D.set(w, Dv + 1); } if (D.get(w) === Dv + 1) { sigma.set(w, sigma.get(w) + sv); P.get(w).push(v); } } }
    const delta = new Map(S.map((u) => [u, 0]));
    while (S.length) { const w = S.pop(), coeff = (1 + delta.get(w)) / sigma.get(w); for (const v of P.get(w)) delta.set(v, delta.get(v) + sigma.get(v) * coeff); if (w !== s) b.set(w, b.get(w) + delta.get(w)); }
  }
  const N = n - 1; if (N < 2) return b;
  if (kk == null) { const sc = 1 / (N * (N - 1)); for (const u of nodesAll) b.set(u, b.get(u) * sc); return b; }
  const ss = kk > 1 ? 1 / ((kk - 1) * (N - 1)) : NaN, sn = 1 / (kk * (N - 1)), src = new Set(sources);
  for (const u of nodesAll) b.set(u, b.get(u) * (src.has(u) ? ss : sn));
  return b;
}
export function graphKeys(idx, k, n, resolution, minSize, bridgePct) {   // keys._graph
  const G = new Graph(); for (let i = 0; i < n; i++) G.addNode(i);
  for (let i = 0; i < n; i++) for (let t = 0; t < k; t++) G.addEdge(i, idx[i * k + t]);
  const comms = louvain(G, resolution, 0).map((s, i) => [s, i]).sort((a, b) => b[0].size - a[0].size || a[1] - b[1]).map((x) => x[0]);
  const lab = new Int32Array(n), big = comms.filter((c) => c.size >= minSize);
  big.forEach((c, i) => { for (const u of c) lab[u] = i; });
  for (const c of comms) if (c.size < minSize) for (const u of c) lab[u] = big.length;
  const bc = betweenness(G, Math.min(n, 300), 0), bv = Float64Array.from({ length: n }, (_, i) => bc.get(i)), thr = percentile(bv, 100 - bridgePct);
  return { community: lab, bridge: Int32Array.from(bv, (v) => v >= thr ? 1 : 0) };
}

// ------------------------------------------------------------------ family config and keys
export function familyConfig(catalogue, keysCfg, code) {
  const fam = catalogue.find((f) => f.code === code) || { scope: "skipped", default: false };
  const out = { enabled: !!fam.default || fam.scope === "core" };
  for (const p of fam.params || []) out[p.name] = JSON.parse(JSON.stringify(p.default));
  Object.assign(out, (keysCfg || {})[code] || {});
  if (fam.scope === "core") out.enabled = true;
  if (fam.scope === "skipped") out.enabled = false;
  return out;
}
const key = (name, values, kind, family, desc, nClasses = 0, noiseClass = null, labels = null) =>
  ({ name, kind, family, desc, values: Float64Array.from(values), n_classes: nClasses, noise_class: noiseClass, labels });

export const S2_ALL = { "spectral.centroid": "spectral_centroid_mean", "spectral.rolloff": "spectral_rolloff_mean", "spectral.flatness": "spectral_flatness_mean",
  "spectral.zcr": "zcr_mean", "spectral.flux": "spectral_flux_mean", "energy.rms": "rms_mean", "energy.rms_db": "rms_db", "energy.dynamic_range": "dynamic_range_db",
  "energy.peak_db": "peak_db", "rhythm.onset_rate": "onset_rate", "rhythm.beat_strength": "beat_strength", "rhythm.tempo": "tempo" };

// ctx: { n, col(c) → Float64Array|null, groups, fileOf (clip → file index), t0, t1, files [{name, rel_path, folder, duration}],
//        results {name: {labels, noise, Zc, knnIdx, knnDist, k, spec}}, keysCfg, catalogue, labelsCsv (text|null),
//        text {prompts, T (Float32Array[]), model} | {error} | null, clipIds }
export function computeKeys(c) {
  const fc = (code) => familyConfig(c.catalogue, c.keysCfg, code), n = c.n, warnings = [], out = [];
  const col = (name) => c.col(name) || new Float64Array(n), has = (name) => !!c.col(name);
  // Ctx: track order by rel_path (code points), per-track time order, the non-overlapping predecessor
  const F = c.files, order = F.map((f, i) => i).sort((a, b) => pyLess(F[a].rel_path, F[b].rel_path)), trackOf = new Int32Array(F.length);
  order.forEach((fi, r) => { trackOf[fi] = r; });
  const trackIndex = Int32Array.from(c.fileOf, (fi) => trackOf[fi]), dur = Float64Array.from(c.fileOf, (fi) => F[fi].duration);
  const seq = F.map(() => []); for (let i = 0; i < n; i++) seq[c.fileOf[i]].push(i); for (const s of seq) s.sort((a, b) => c.t0[a] - c.t0[b]);
  const pos = new Int32Array(n); for (const s of seq) s.forEach((i, k) => { pos[i] = k; });
  const clipDur = medianOf(Array.from({ length: n }, (_, i) => c.t1[i] - c.t0[i]));
  const hops = seq.filter((s) => s.length > 1).map((s) => medianOf(s.slice(1).map((i, k) => c.t0[i] - c.t0[s[k]])));
  const hop = hops.length ? medianOf(hops) : clipDur, stride = Math.max(1, roundEven(clipDur / Math.max(hop, 1e-6))), hopS = hop * stride;
  const pred = new Int32Array(n).fill(-1); for (const s of seq) if (s.length > stride) for (let k = stride; k < s.length; k++) pred[s[k]] = s[k - stride];
  const perTrack = (fn, v) => { const o = new Float64Array(n); for (const s of seq) { const r = fn(s.map((i) => v[i])); s.forEach((i, k) => { o[i] = r[k]; }); } return o; };
  const mirCols = ["spectral", "energy", "mfcc", "chroma"].flatMap((g) => (c.groups[g] || []).filter((x) => x.endsWith("_mean") || x === "rms_db"));
  let Mc = null;
  const mir = () => { if (Mc) return Mc;                           // Ctx.mir: robust-scaled MIR means, clipped ±5
    const cols = mirCols.map((x) => { let v = Float64Array.from(col(x)); const fin = Array.from(v).filter(Number.isFinite), med = medianOf(fin);
      v = v.map((x2) => Number.isFinite(x2) ? x2 : med); const q75 = percentile(v, 75), q25 = percentile(v, 25), iqr = q75 - q25 > 1e-12 ? q75 - q25 : stdPop(v) + 1e-12;
      return v.map((x2) => Math.max(-5, Math.min(5, (x2 - med) / iqr))); });
    Mc = Array.from({ length: n }, (_, i) => Float64Array.from(cols, (cc) => cc[i])); return Mc; };
  const hopStr = `${fmtG(hopS)} s earlier`;

  // S2
  for (const name of fc("S2").features || []) { const cn = S2_ALL[name]; if (cn && has(cn)) out.push(key(name, col(cn), "signal", "S2", `${cn} (Phase 2, mean over the clip's frames)`)); }
  // S4
  if (fc("S4").enabled) {
    const mf = (c.groups.mfcc || []).filter((x) => x.endsWith("_mean") && x !== "mfcc_0_mean"), ct = (c.groups.spectral || []).filter((x) => x.startsWith("spectral_contrast") && x.endsWith("_mean"));
    if (mf.length) { const cs = mf.map(col); out.push(key("stats.mfcc_spread", Array.from({ length: n }, (_, i) => stdPop(cs.map((v) => v[i]))), "signal", "S4", "std across the clip's MFCC 1..n means: timbre variance across bands")); }
    if (ct.length) { const cs = ct.map(col); out.push(key("stats.contrast", Array.from({ length: n }, (_, i) => mean(cs.map((v) => v[i]))), "signal", "S4", "mean spectral contrast over the bands: peaks vs valleys (tonal / noisy texture)")); }
    const fm = col("spectral_flux_mean"), fs = col("spectral_flux_std");
    out.push(key("stats.busyness", Float64Array.from(fm, (m2, i) => fs[i] / (Math.abs(m2) + 1e-9)), "signal", "S4", "spectral-flux variation within the clip (std / mean): how busy it is"));
    const M = mir(), blocks = ["spectral", "energy", "mfcc", "chroma"].map((g) => { const set = new Set(c.groups[g] || []); return mirCols.map((x, i) => [x, i]).filter(([x]) => set.has(x) || (g === "energy" && x === "rms_db")).map(([, i]) => i); }).filter((b) => b.length);
    if (blocks.length) out.push(key("stats.group_spread", M.map((r) => stdPop(blocks.map((b) => mean(b.map((i) => Math.abs(r[i])))))), "signal", "S4", "std across feature groups of each group's mean |robust z|: one group stands out vs all alike"));
  }
  // novelty (S5, Y7, E5)
  let novelty = null;
  if (fc("S5").enabled || fc("Y7").enabled || fc("E5").enabled) {
    const W = +fc("S5").novelty_window, M = mir(), d = M[0] ? M[0].length : 0; novelty = new Float64Array(n);
    for (const s of seq) s.forEach((i, k) => { const before = [], after = [];
      for (let t = Math.max(0, k - W * stride); t < k; t += stride) before.push(s[t]); for (let t = k; t < Math.min(s.length, k + W * stride); t += stride) after.push(s[t]);
      if (before.length && after.length) { let q = 0; for (let j = 0; j < d; j++) { let a = 0, b = 0; for (const x of after) a += M[x][j]; for (const x of before) b += M[x][j]; q += (a / after.length - b / before.length) ** 2; } novelty[i] = Math.sqrt(q); } });
  }
  if (fc("S5").enabled) {
    const M = mir(), mfi = mirCols.map((x, i) => [x, i]).filter(([x]) => x.startsWith("mfcc_")).map(([, i]) => i), rdb = col("rms_db"), cen = col("spectral_centroid_mean");
    const dt = new Float64Array(n), dl = new Float64Array(n), db = new Float64Array(n);
    for (let i = 0; i < n; i++) if (pred[i] >= 0) { const p = pred[i]; let q = 0; for (const j of mfi) q += (M[i][j] - M[p][j]) ** 2; dt[i] = Math.sqrt(q); dl[i] = rdb[i] - rdb[p]; db[i] = cen[i] - cen[p]; }
    out.push(key("delta.timbre", dt, "signal", "S5", `MFCC distance to the clip ${hopStr}: timbral speed`), key("delta.loudness", dl, "signal", "S5", `rms dB minus the clip ${hopStr} (signed)`),
             key("delta.brightness", db, "signal", "S5", `centroid Hz minus the clip ${hopStr} (signed)`),
             key("delta.novelty", novelty, "signal", "S5", `MIR distance between the ${fc("S5").novelty_window} clips before and after (Foote-style)`));
  }
  // S6
  if (fc("S6").enabled) {
    const w = Math.trunc(+fc("S6").window), rdb = col("rms_db"), cen = col("spectral_centroid_mean"), per = Math.max(hopS / stride, 1e-9);
    const roll = (v) => perTrack((x) => rolling(x, w * stride), v), sl = (v) => perTrack((x) => slope(x, w * stride).map((y) => y / per), v);
    const arcW = Math.max(3, roundEven(+fc("S6").arc_s / Math.max(hopS / stride, 1e-6)));
    out.push(key("trend.loudness", roll(rdb), "signal", "S6", `rolling mean rms dB over the last ${w} clips`), key("trend.loudness_slope", sl(rdb), "signal", "S6", `dB per second over the last ${w} clips`),
             key("trend.brightness", roll(cen), "signal", "S6", `rolling mean centroid over the last ${w} clips`), key("trend.brightness_slope", sl(cen), "signal", "S6", `Hz per second over the last ${w} clips`),
             key("trend.arc", perTrack((x) => minmax(rolling(x, arcW, true)), rdb), "signal", "S6", `the track's long loudness arc (${fmtG(+fc("S6").arc_s)} s centred smoothing), 0–1 within the track`));
  }
  // S7 (track part)
  if (fc("S7").enabled) { const M = mir(), dev = new Float64Array(n);
    for (const s of seq) { if (!s.length) continue; const d = M[0].length, mu = new Float64Array(d); for (const i of s) for (let j = 0; j < d; j++) mu[j] += M[i][j] / s.length;
      const dd = s.map((i) => Math.sqrt(d2(M[i], mu))), m2 = mean(dd), sd = stdPop(dd); s.forEach((i, k) => { dev[i] = (dd[k] - m2) / (sd + 1e-9); }); }
    out.push(key("track.deviation", dev, "signal", "S7", "MIR distance from its own track's mean, z within the track")); }
  // S13 (track part)
  if (fc("S13").enabled) for (const name of fc("S13").features || []) { const cn = S2_ALL[name]; if (has(cn)) out.push(key(`pct.track_${name.split(".").pop()}`, perTrack(rankPct, col(cn)), "signal", "S13", `percentile of ${name} within the clip's track`)); }
  // S14
  if (fc("S14").enabled) out.push(key("track.time", Float64Array.from({ length: n }, (_, i) => (c.t0[i] + c.t1[i]) / 2 / dur[i]), "signal", "S14", "clip centre / track duration (0–1)"),
    key("track.time_s", c.t0, "signal", "S14", "clip start in the track, seconds"), key("track.index", trackIndex, "signal", "S14", "track number on the record (by file path order)"),
    key("track.clip_index", pos, "signal", "S14", "clip number within its track"));
  // S18
  if (fc("S18").enabled) out.push(...tonal(c, n, col, has, pred, hopS));
  // Y5
  if (fc("Y5").enabled) {
    const names = order.map((fi) => F[fi].name.replace(/\.[^.]+$/, ""));
    out.push(key("label.track", trackIndex, "symbol", "Y5", "the track (by file path order)", names.length, null, names));
    const pats = fc("Y5").side_patterns || {}, pk = Object.keys(pats);
    if (pk.length) { const lab = new Int32Array(n).fill(pk.length);
      pk.forEach((s, k) => { const re = new RegExp(pats[s]); for (let i = 0; i < n; i++) if (lab[i] === pk.length && re.test(F[c.fileOf[i]].name)) lab[i] = k; });
      const anyOther = lab.some((v) => v === pk.length), anyMatch = lab.some((v) => v < pk.length), used = anyOther ? pk.concat(["other"]) : pk;
      if (anyMatch) out.push(key("label.side", lab, "symbol", "Y5", "album side by filename pattern: " + pk.map((s) => `${s}~/${pats[s]}/`).join(", "), used.length, null, used)); }
    const folderOf = (f) => f.rel_path.includes("/") ? f.rel_path.split("/")[0] : "";                 // ingest: label = first sub-folder
    if (F.some((f) => folderOf(f) !== "")) { const fl = Array.from(c.fileOf, (fi) => folderOf(F[fi])), cats = [...new Set(fl)].sort(pyLess);
      out.push(key("label.folder", fl.map((x) => cats.indexOf(x)), "symbol", "Y5", "the corpus subfolder the file sits in", cats.length, null, cats)); }
    if (fc("Y5").labels_csv && c.labelsCsv) out.push(...labelsCsv(c, n));
  }
  // Y6
  if (fc("Y6").enabled) { const b = Math.trunc(+fc("Y6").bins), [ln, bn] = b === 3 ? [["pp", "mf", "ff"], ["dark", "mid", "bright"]] : [Array.from({ length: b }, (_, i) => `q${i}`), Array.from({ length: b }, (_, i) => `q${i}`)];
    out.push(key("tier.loudness", qbin(col("rms_db"), b), "symbol", "Y6", `rms dB in ${b} quantile tiers`, b, null, ln),
             key("tier.brightness", qbin(col("spectral_centroid_mean"), b), "symbol", "Y6", `centroid in ${b} quantile tiers`, b, null, bn),
             key("tier.density", qbin(col("onset_rate"), 2), "symbol", "Y6", "onset rate below / above its median", 2, null, ["sparse", "dense"])); }
  // Y7 / E5
  const events = {};
  if (fc("Y7").enabled || fc("E5").enabled) {
    const y7 = fc("Y7"), hp = Math.max(hopS / stride, 1e-6), dist = Math.max(1, roundEven(+y7.min_dwell_s / hp));
    const sec = new Int32Array(n), starts = new Uint8Array(n), peaks = new Uint8Array(n);
    for (const s of seq) { const v = s.map((i) => novelty[i]); let pk = findPeaks(v, +y7.prominence * (stdPop(v) + 1e-9), dist); pk = pk.filter((p) => p >= dist && p <= s.length - dist);
      const bset = new Set(pk); let idx = 0; s.forEach((i, k) => { if (k > 0 && bset.has(k)) idx++; sec[i] = idx; }); for (const p of pk) { peaks[s[p]] = 1; starts[s[p]] = 1; } }
    events.novelty_peak = peaks; events.section_start = starts;
    if (y7.enabled) { let mx = -1; for (const v of sec) mx = Math.max(mx, v);
      out.push(key("section.index", sec, "symbol", "Y7", `section of its track: cut at novelty peaks, ≥ ${fmtG(+y7.min_dwell_s)} s each`, n ? mx + 1 : 0));
      const w = Math.max(1, roundEven(+y7.min_dwell_s / hp)), sm = perTrack((x) => rolling(x, w, true), col("rms_db")), lab = qbin(sm, 3);
      for (const s of seq) { const x = s.map((i) => lab[i]); let k = 0; while (k < x.length) { let j = k; while (j < x.length && x[j] === x[k]) j++; if (j - k < w && k > 0) for (let t = k; t < j; t++) x[t] = x[k - 1]; k = j; } s.forEach((i, t) => { lab[i] = x[t]; }); }
      out.push(key("section.state", lab, "symbol", "Y7", `loudness regime with a ≥ ${fmtG(+y7.min_dwell_s)} s dwell`, 3, null, ["quiet", "mid", "loud"])); }
  }
  // Y8
  if (fc("Y8").enabled) { const a = +fc("Y8").opening, z = +fc("Y8").ending;
    out.push(key("part.position", Array.from({ length: n }, (_, i) => { const tt = (c.t0[i] + c.t1[i]) / 2 / dur[i]; return tt < a ? 0 : tt > 1 - z ? 2 : 1; }), "symbol", "Y8",
      `opening (first ${pctFmt(a)}) / middle / ending (last ${pctFmt(z)}) of its track`, 3, null, ["opening", "middle", "ending"])); }
  // Y9
  if (fc("Y9").enabled) { const names = Object.keys(c.results), conf = fc("Y9").pairs || [], asked = conf.filter(([a, b]) => c.results[a] && c.results[b]);
    if (conf.length && !asked.length && names.length >= 2) warnings.push(`Y9: none of the pairs ${JSON.stringify(conf)} are readings of this run; used the first two readings`);
    const pairs = asked.length ? asked : names.length >= 2 ? [names.slice(0, 2)] : [];
    for (const [a, b] of pairs) { if (!c.results[a] || !c.results[b]) continue; const la = c.results[a].labels, lb = c.results[b].labels, ct = new Map();
      for (let i = 0; i < n; i++) { const m = ct.get(la[i]) || new Map(); m.set(lb[i], (m.get(lb[i]) || 0) + 1); ct.set(la[i], m); }
      const map = new Map(); for (const [x, m] of ct) { let best = null, bv = -1; for (const y of [...m.keys()].sort((p, q) => p - q)) if (m.get(y) > bv) { bv = m.get(y); best = y; } map.set(x, best); }
      out.push(key(`agree.${a}_vs_${b}`, Array.from({ length: n }, (_, i) => map.get(la[i]) === lb[i] ? 1 : 0), "symbol", "Y9", `1 when the clip's ${b} cluster is the one its ${a} cluster mostly maps to`, 2, null, ["disagree", "agree"])); } }
  // Y11
  if (fc("Y11").enabled) {
    const cc = (c.groups.clap || []).filter(has);
    if (cc.length) { if (!c.text) warnings.push("Y11 skipped: the CLAP text model is not loaded in this page");
      else if (c.text.error) warnings.push(`Y11 skipped: ${c.text.error}`);
      else if (c.text.T[0].length !== cc.length) warnings.push(`Y11 skipped: the corpus's CLAP embeddings have ${cc.length} dimensions, the text model ${c.text.model} gives ${c.text.T[0].length}`);
      else { const P = c.text.prompts, T = c.text.T, cols = cc.map(col), top = new Int32Array(n), score = new Float64Array(n), S = P.map(() => new Float64Array(n));
        for (let i = 0; i < n; i++) { let nr = 0; for (const v of cols) nr += v[i] * v[i]; nr = Math.sqrt(nr) + 1e-9; let b = -Infinity;
          for (let p = 0; p < P.length; p++) { let s = 0; for (let j = 0; j < cols.length; j++) s += Math.fround(cols[j][i] / nr) * T[p][j]; S[p][i] = s; if (s > b) { b = s; top[i] = p; } } score[i] = b; }
        out.push(key("tag.top", top, "symbol", "Y11", `best CLAP text prompt (${c.text.model})`, P.length, null, P.slice()), key("tag.score", score, "signal", "S16", "cosine similarity of the clip to its best prompt"));
        if (fc("Y11").per_prompt) P.forEach((p, k) => out.push(key(`tag.${slug(p)}`, S[k], "signal", "S9", `CLAP similarity to “${p}”`))); } }
  }
  // Y12
  if (fc("Y12").enabled) { const q = fc("Y12"), rdb = col("rms_db"), pk = has("peak_db") ? col("peak_db") : null, flag = new Int32Array(n);
    for (let i = 0; i < n; i++) { if (rdb[i] < +q.silent_db) flag[i] = 1; else if (pk && pk[i] > +q.clip_db) flag[i] = 2; else if (c.t1[i] - c.t0[i] < +q.short_s) flag[i] = 3; }
    out.push(key("quality.flag", flag, "symbol", "Y12", `ok / silent (rms < ${fmtG(+q.silent_db)} dB) / clipped (peak > ${fmtG(+q.clip_db)} dBFS) / short (< ${fmtG(+q.short_s)} s)`, 4, null, ["ok", "silent", "clipped", "short"])); }

  // ---------------------------------------------------------------- per reading (keys.reading_keys)
  const readingKeys = {};
  for (const [name, r] of Object.entries(c.results)) readingKeys[name] = readingKeysOf(c, fc, name, r, n, col, has);
  return { live: out, events, readingKeys, warnings, ctx: { stride, hopS } };
}

function tonal(c, n, col, has, pred, hopS) {
  const cols = Array.from({ length: 12 }, (_, i) => `chroma_${i}_mean`); if (!cols.every(has)) return [];
  const C = cols.map(col), Pn = Array.from({ length: n }, (_, i) => { const r = C.map((v) => Math.max(0, v[i])); const t = r.reduce((a, b) => a + b, 0) + 1e-12; return r.map((x) => x / t); });
  const cent = Pn.map((p) => { let re = 0, im = 0; p.forEach((x, k) => { re += x * Math.cos(2 * Math.PI * k / 12); im += x * Math.sin(2 * Math.PI * k / 12); }); let a = Math.atan2(im, re); a = ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); return a / (2 * Math.PI) * 12; });
  const maj = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88], mnr = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const roll = (a, k) => a.map((_, i) => a[((i - k) % 12 + 12) % 12]), prof = [...Array.from({ length: 12 }, (_, k) => roll(maj, k)), ...Array.from({ length: 12 }, (_, k) => roll(mnr, k))];
  const pz = prof.map((p) => { const m = mean(p), s = stdPop(p); return p.map((x) => (x - m) / s); });
  const kidx = new Int32Array(n), kconf = new Float64Array(n);
  Pn.forEach((p, i) => { const m = mean(p), s = stdPop(p) + 1e-12, cz = p.map((x) => (x - m) / s); let b = 0, bv = -Infinity;
    pz.forEach((z, k) => { let q = 0; for (let j = 0; j < 12; j++) q += cz[j] * z[j]; q /= 12; if (q > bv) { bv = q; b = k; } }); kidx[i] = b; kconf[i] = bv; });
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"], labels = names.concat(names.map((x) => x + "m"));
  const hc = new Float64Array(n); for (let i = 0; i < n; i++) if (pred[i] >= 0) { const a = Pn[i], b = Pn[pred[i]]; let s = 0, na = 0, nb = 0; for (let j = 0; j < 12; j++) { s += a[j] * b[j]; na += a[j] * a[j]; nb += b[j] * b[j]; } hc[i] = 1 - s / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12); }
  const ent = Pn.map((p) => -p.reduce((s, x) => s + x * Math.log(x + 1e-12), 0) / Math.log(12));
  return [key("tonal.chroma_centroid", cent, "signal", "S18", "circular mean of the clip's chroma, 0–12 (C=0)"),
          key("tonal.key", kidx, "symbol", "S18", "estimated key (Krumhansl–Kessler profiles on the clip's chroma)", 24, null, labels),
          key("tonal.key_confidence", kconf, "signal", "S18", "correlation of the chroma with the best key profile"),
          key("tonal.harmonic_change", hc, "signal", "S18", `chroma cosine distance to the clip ${fmtG(hopS)} s earlier: harmonic change rate`),
          key("tonal.chroma_entropy", ent, "signal", "S18", "pitch-class entropy, 0 (one pitch class) – 1 (flat)")];
}

function parseCsv(text) {                                         // RFC 4180-ish: quotes, "" escapes, CRLF
  const rows = []; let row = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) { const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
    else if (ch === '"') q = true; else if (ch === ",") { row.push(f); f = ""; } else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; } else f += ch; }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => x !== ""));
}
function labelsCsv(c, n) {                                        // keys._labels_csv
  const rows = parseCsv(c.labelsCsv); if (rows.length < 2) return [];
  const head = rows[0].map((h) => h.trim()), recs = rows.slice(1).map((r) => Object.fromEntries(head.map((h, j) => [h, r[j] === undefined || r[j] === "" ? null : r[j]])));
  const F = c.files, fileIdOf = (fi) => F[fi].file_id, ids = ["clip_id", "file_id", "rel_path", "filename", "t_start", "t_end"];
  let cols, joined;
  if (head.includes("clip_id")) { const by = new Map(); for (const r of recs) if (!by.has(r.clip_id)) by.set(r.clip_id, r);
    cols = head.filter((h) => h !== "clip_id"); joined = Array.from({ length: n }, (_, i) => by.get(c.clipIds[i]) || {}); }
  else { const k = ["file_id", "rel_path", "filename"].find((x) => head.includes(x)); if (!k) return [];
    const fval = (fi) => k === "file_id" ? fileIdOf(fi) : k === "rel_path" ? F[fi].rel_path : F[fi].name;
    const recF = recs.flatMap((r) => F.map((f, fi) => fi).filter((fi) => fval(fi) === r[k]).map((fi) => ({ fi, r })));
    if (head.includes("t_start") && head.includes("t_end")) { cols = head.filter((h) => !["file_id", "t_start", "t_end", k].includes(h)).sort(pyLess);
      joined = Array.from({ length: n }, () => ({}));
      for (const { fi, r } of recF) for (let i = 0; i < n; i++) { const mid = (c.t0[i] + c.t1[i]) / 2; if (c.fileOf[i] === fi && mid >= +r.t_start && mid < +r.t_end) for (const h of cols) joined[i][h] = r[h]; } }
    else { cols = head.filter((h) => h !== k && h !== "file_id"); const by = new Map(); for (const { fi, r } of recF) if (!by.has(fi)) by.set(fi, r);
      joined = Array.from({ length: n }, (_, i) => by.get(c.fileOf[i]) || {}); } }
  const out = [];
  for (const h of cols) { if (ids.includes(h)) continue;
    const v = joined.map((r) => r[h] ?? null), present = v.filter((x) => x !== null);
    const num = v.map((x) => x === null ? NaN : (x.trim() !== "" && Number.isFinite(+x) ? +x : NaN));
    if (present.length && present.every((x) => x.trim() !== "" && Number.isFinite(+x))) { const miss = num.some(Number.isNaN);
      out.push(key(`label.${slug(h)}`, num.map((x) => Number.isNaN(x) ? -1 : x), "signal", "Y5", `labels.csv column '${h}' (numeric${miss ? "; −1 = unlabelled" : ""})`)); }
    else { const cats = [...new Set(present.map(String))].sort(pyLess), codes = v.map((x) => x === null ? cats.length : cats.indexOf(String(x)));
      const labs = cats.concat(codes.some((x) => x === cats.length) ? ["(none)"] : []);
      out.push(key(`label.${slug(h)}`, codes, "symbol", "Y5", `labels.csv column '${h}'`, labs.length, null, labs)); } }
  return out;
}

function readingKeysOf(c, fc, name, r, n, col, has) {             // keys.reading_keys
  const out = [], labels = r.labels, noise = r.noise, Zc = r.Zc, space = (r.spec.cluster || {}).space || "feature";
  const real = [...new Set(labels)].filter((x) => x !== noise).sort((a, b) => a - b), d = Zc[0].length;
  const cent = real.length ? real.map((cl) => { const m = new Float64Array(d); let cnt = 0; for (let i = 0; i < n; i++) if (labels[i] === cl) { cnt++; for (let j = 0; j < d; j++) m[j] += Zc[i][j]; } return m.map((x) => x / cnt); }) : [new Float64Array(d)];
  const D = Zc.map((z) => cent.map((ct) => Math.sqrt(d2(z, ct)))), posOf = new Map(real.map((cl, i) => [cl, i]));
  const argmin = (a) => { let b = 0; for (let j = 1; j < a.length; j++) if (a[j] < a[b]) b = j; return b; };
  const own = Float64Array.from(labels, (cl, i) => posOf.has(cl) ? D[i][posOf.get(cl)] : Math.min(...D[i]));
  if (fc("S7").enabled) { const ids = Int32Array.from(labels, (cl, i) => posOf.has(cl) ? posOf.get(cl) : argmin(D[i])), K = D[0].length;
    const means = [], stds = []; for (let j = 0; j < K; j++) { const v = []; for (let i = 0; i < n; i++) if (ids[i] === j) v.push(own[i]); means.push(v.length ? mean(v) : 0); const s = v.length ? stdPop(v) : 1; stds.push(s > 0 ? s : 1); }
    out.push(key(`${name}.typicality`, Float64Array.from(own, (v, i) => Math.max(-3, Math.min(3, (v - means[ids[i] % K]) / stds[ids[i] % K])) / 3), "signal", "S7",
      "distance to its cluster centre as a z within that cluster, ±3σ → −1..1 (0 = typical, + = atypical; datamapper cluster_relative_deviation)")); }
  if (fc("S9").enabled) out.push(key(`${name}.dist_centre`, own, "signal", "S9", `distance to its own cluster centre (${space} space)`));
  if (fc("S10").enabled && r.k) { const k = r.k, pur = new Float64Array(n), ent = new Float64Array(n), kd = new Float64Array(n);
    for (let i = 0; i < n; i++) { const cnt = new Map(); let same = 0, ds = 0; for (let t = 0; t < k; t++) { const l = labels[r.knnIdx[i * k + t]]; cnt.set(l, (cnt.get(l) || 0) + 1); if (l === labels[i]) same++; ds += r.knnDist[i * k + t]; }
      pur[i] = same / k; let e = 0; for (const v of cnt.values()) { const p = v / k; e -= p * Math.log(p); } ent[i] = e / Math.log(k); kd[i] = ds / k; }
    out.push(key(`${name}.knn_purity`, pur, "signal", "S10", `share of its ${k} nearest neighbours in its own cluster`), key(`${name}.knn_entropy`, ent, "signal", "S10", `entropy of its ${k} neighbours' clusters, 0–1`),
             key(`${name}.knn_dist`, kd, "signal", "S10", `mean distance to its ${k} nearest neighbours (loneliness, feature space)`)); }
  if (fc("S12").enabled && real.length > 1) { const temp = +fc("S12").temperature, tau = medianOf(own) * temp + 1e-9;
    const W = D.map((row) => { const mn = Math.min(...row), e = row.map((x) => Math.exp(-(x - mn) / tau)), s = e.reduce((a, b) => a + b, 0); return e.map((x) => x / s); });
    real.forEach((cl, j) => out.push(key(`${name}.member_${cl}`, W.map((w) => w[j]), "signal", "S12", `soft membership of cluster ${cl} (softmax of −distance / ${fmtG(temp)}·median, ${space} space)`)));
    out.push(key(`${name}.confidence`, W.map((w) => Math.max(...w)), "signal", "S16", "max soft membership: how sure the clip's cluster is")); }
  if (fc("S13").enabled) for (const fname of fc("S13").features || []) { const cn = S2_ALL[fname]; if (!has(cn)) continue; const v = col(cn), pc = new Float64Array(n);
    for (const cl of [...new Set(labels)]) { const m = []; for (let i = 0; i < n; i++) if (labels[i] === cl) m.push(i); const rk = rankPct(m.map((i) => v[i])); m.forEach((i, t) => { pc[i] = rk[t]; }); }
    out.push(key(`${name}.pct_${fname.split(".").pop()}`, pc, "signal", "S13", `percentile of ${fname} within its ${name} cluster`)); }
  if (fc("Y2").enabled) { const q = fc("Y2"), nn = Zc.length, co = Math.max(2, Math.min(+q.coarse, nn - 1)), fi = Math.max(2, Math.min(+q.fine, nn - 1));
    const bySize = (lab) => { const cnt = new Map(); for (const l of lab) cnt.set(l, (cnt.get(l) || 0) + 1); const u = [...cnt.keys()].sort((a, b) => a - b), ord = u.slice().sort((a, b) => cnt.get(b) - cnt.get(a)), m = new Map(ord.map((x, i) => [x, i])); return Int32Array.from(lab, (l) => m.get(l)); };
    const lc = bySize(c.agglomerative(Zc, co, "ward")), lf = bySize(c.agglomerative(Zc, fi, "ward"));
    out.push(key(`${name}.cluster_coarse`, lc, "symbol", "Y2", `Ward tree cut at ${q.coarse} (${space} space)`, Math.max(...lc) + 1), key(`${name}.cluster_fine`, lf, "symbol", "Y2", `Ward tree cut at ${q.fine} (${space} space)`, Math.max(...lf) + 1)); }
  if (fc("Y3").enabled && r.k) { const q = fc("Y3"), g = graphKeys(r.knnIdx, r.k, n, +q.resolution, Math.trunc(+q.min_size), +q.bridge_pct);
    out.push(key(`${name}.community`, g.community, "symbol", "Y3", `Louvain community of the kNN graph (resolution ${fmtG(+q.resolution)}; last class = small ones)`, Math.max(...g.community) + 1),
             key(`${name}.bridge`, g.bridge, "symbol", "Y3", `1 = top ${fmtG(+q.bridge_pct)} % betweenness: a clip linking communities`, 2, null, ["no", "bridge"])); }
  if (fc("Y10").enabled) { const pct = +fc("Y10").pct, role = new Int32Array(n);
    const margin = D.map((row) => { if (row.length < 2) return Infinity; const s = row.slice().sort((a, b) => a - b); return s[1] - s[0]; });
    for (const cl of real) { const m = []; for (let i = 0; i < n; i++) if (labels[i] === cl) m.push(i); if (!m.length) continue;
      const hi = percentile(m.map((i) => own[i]), 100 - pct), lo = percentile(m.map((i) => margin[i]), pct);
      for (const i of m) if (own[i] >= hi) role[i] = 3; for (const i of m) if (margin[i] <= lo && role[i] === 0) role[i] = 2;
      let b = m[0]; for (const i of m) if (own[i] < own[b]) b = i; role[b] = 1; }
    out.push(key(`${name}.role`, role, "symbol", "Y10", `regular / medoid / boundary (smallest ${fmtG(pct)} % margin to another centre) / extreme (farthest ${fmtG(pct)} %)`, 4, null, ["regular", "medoid", "boundary", "extreme"])); }
  return out;
}

export function baseReadingDescs(name, info, spec) {              // keys.base_reading_descs
  const dr = ((spec || {}).dr || {}).method || "?", cl = (spec || {}).cluster || {}, an = (spec || {}).anomaly || {}, nc = info.n_clusters, noise = info.noise_class;
  return { x: ["S1", `x on ${name}'s ${dr} map, 0–1`], y: ["S1", `y on ${name}'s ${dr} map, 0–1`],
    cluster: ["Y1", `${cl.method || "?"} in ${cl.space || "feature"} space · ${nc} clusters` + (noise != null ? ` + noise (class ${noise})` : "")],
    outlier: ["Y4", `${an.method || "iforest"} outlier at ${fmtG(an.contamination ?? 0.03)} contamination`],
    outlier_score: ["S11", `${an.method || "iforest"} anomaly score as a rank 0–1 (1 = most anomalous)`],
    density: ["S8", "inverse mean distance to the 10 nearest points on the 2-D map, as a rank 0–1"] };
}
