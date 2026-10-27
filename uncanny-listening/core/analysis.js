// Uncanny Listening — the desktop's processing of Ana's songs, in the browser (2026-10-27).
// What uncanny_music.darkproj runs after the features (tested against its frozen output, darkdata/darkdf_l0.parquet):
//   data step   MinMaxScaler over every feature column (sklearn: (x − min) / (max − min); a constant column → 0)
//   PCA         sklearn PCA(n_components = 3) on the scaled table, svd_flip with the largest |loading| positive, then MinMax
//   density     sklearn KernelDensity(bandwidth 0.2, gaussian).score_samples on the scaled table, then MinMax
//   k-means     sklearn KMeans(n_clusters = k, n_init 10, max_iter 300, random_state 42), lloyd, on the scaled table:
//               k-means++ (2 + ⌊ln k⌋ local trials) drawn from numpy's RandomState(42) (MT19937, ported here), the
//               tolerance mean(var) · 1e-4, the final E-step when not strictly converged, the lowest inertia of the 10
//   align       darksonification.processing.utils.align_labels(km_cluster → class, method auto): flip for 2 labels,
//               the Hungarian assignment on the contingency table otherwise; accuracy = agreement after the mapping
// Pure functions on arrays of rows (Float64Array per row); no DOM, usable in a worker.

// ------------------------------------------------------------------ numpy RandomState (MT19937, legacy seeding)
export class RandomState {
  constructor(seed) {
    const mt = this.mt = new Uint32Array(624); let s = seed >>> 0;
    for (let i = 0; i < 624; i++) { mt[i] = s; s = (Math.imul(1812433253, s ^ (s >>> 30)) + i + 1) >>> 0; }
    this.i = 624;
  }
  int32() {
    const mt = this.mt;
    if (this.i >= 624) {
      for (let k = 0; k < 624; k++) {
        const y = (mt[k] & 0x80000000) | (mt[(k + 1) % 624] & 0x7fffffff);
        mt[k] = mt[(k + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      this.i = 0;
    }
    let y = mt[this.i++];
    y ^= y >>> 11; y ^= (y << 7) & 0x9d2c5680; y ^= (y << 15) & 0xefc60000; y ^= y >>> 18;
    return y >>> 0;
  }
  random() { const a = this.int32() >>> 5, b = this.int32() >>> 6; return (a * 67108864 + b) / 9007199254740992; }   // random_sample
}

// ------------------------------------------------------------------ small linear algebra
const dot = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) s += a[k] * b[k]; return s; };
function jacobiEigen(A) {                                         // symmetric A (array of Float64Array) → {values, vectors (columns)}
  const n = A.length, a = A.map((r) => Float64Array.from(r)), V = Array.from({ length: n }, (_, i) => { const r = new Float64Array(n); r[i] = 1; return r; });
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0; for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < n; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < n; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  return { values: a.map((r, i) => r[i]), vectors: V };
}

// ------------------------------------------------------------------ the steps
export function minmax(X) {                                       // columns of X → [0, 1]; returns {X, min, max}
  const n = X.length, d = n ? X[0].length : 0, lo = new Float64Array(d).fill(Infinity), hi = new Float64Array(d).fill(-Infinity);
  for (const x of X) for (let j = 0; j < d; j++) { if (x[j] < lo[j]) lo[j] = x[j]; if (x[j] > hi[j]) hi[j] = x[j]; }
  const out = X.map((x) => Float64Array.from(x, (v, j) => { const r = hi[j] - lo[j]; return r === 0 ? 0 : (v - lo[j]) / r; }));
  return { X: out, min: lo, max: hi };
}
export function pca(X, k) {                                        // sklearn PCA: centred, components with svd_flip(u_based_decision=False)
  const n = X.length, d = X[0].length, mu = new Float64Array(d);
  for (const x of X) for (let j = 0; j < d; j++) mu[j] += x[j] / n;
  const Xc = X.map((x) => Float64Array.from(x, (v, j) => v - mu[j])), C = Array.from({ length: d }, () => new Float64Array(d));
  for (const x of Xc) for (let a = 0; a < d; a++) { const xa = x[a]; if (!xa) continue; for (let b = a; b < d; b++) C[a][b] += xa * x[b]; }
  for (let a = 0; a < d; a++) for (let b = a; b < d; b++) { C[a][b] /= n - 1; C[b][a] = C[a][b]; }
  const { values, vectors } = jacobiEigen(C), order = values.map((v, i) => i).sort((p, q) => values[q] - values[p]).slice(0, k);
  const comps = order.map((c) => { const v = Float64Array.from({ length: d }, (_, j) => vectors[j][c]); let m = 0; for (let j = 1; j < d; j++) if (Math.abs(v[j]) > Math.abs(v[m])) m = j; if (v[m] < 0) for (let j = 0; j < d; j++) v[j] = -v[j]; return v; });
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);
  return { Z: Xc.map((x) => Float64Array.from(comps, (v) => dot(x, v))), components: comps, mean: mu, explained: order.map((c) => values[c] / total) };
}
export function kdeLog(X, h) {                                     // sklearn KernelDensity(gaussian).score_samples on the fitting data itself
  const n = X.length, d = X[0].length, c = -Math.log(n) - 0.5 * d * Math.log(2 * Math.PI * h * h);
  return X.map((x) => { const e = X.map((z) => { let s = 0; for (let j = 0; j < d; j++) s += (x[j] - z[j]) ** 2; return -0.5 * s / (h * h); });
    const m = Math.max(...e); let s = 0; for (const v of e) s += Math.exp(v - m); return m + Math.log(s) + c; });
}
const unit = (v) => { let lo = Infinity, hi = -Infinity; for (const x of v) { lo = Math.min(lo, x); hi = Math.max(hi, x); } return Array.from(v, (x) => hi > lo ? (x - lo) / (hi - lo) : 0); };

function sameClustering(a, b, k) {                                 // sklearn _is_same_clustering
  const m = new Int32Array(k).fill(-1);
  for (let i = 0; i < a.length; i++) { if (m[a[i]] === -1) m[a[i]] = b[i]; else if (m[a[i]] !== b[i]) return false; }
  return true;
}
export function kmeans(X0, k, { nInit = 10, maxIter = 300, tol = 1e-4, seed = 42 } = {}) {
  const n = X0.length, d = X0[0].length, rs = new RandomState(seed), mu = new Float64Array(d);
  for (const x of X0) for (let j = 0; j < d; j++) mu[j] += x[j]; for (let j = 0; j < d; j++) mu[j] /= n;
  const X = X0.map((x) => Float64Array.from(x, (v, j) => v - mu[j])), xx = X.map((x) => dot(x, x));
  let vsum = 0; for (let j = 0; j < d; j++) { let s = 0; for (const x of X) s += x[j]; const m = s / n; let v = 0; for (const x of X) v += (x[j] - m) ** 2; vsum += v / n; }
  const TOL = vsum / d * tol, nTrials = 2 + Math.floor(Math.log(k));
  const sqd = (i, c, cc) => Math.max(0, xx[i] + cc - 2 * dot(X[i], c));
  function plusplus() {
    const C = [], cdf = Float64Array.from({ length: n }, (_, i) => (i + 1) / n);   // choice(n, p = uniform)
    const u0 = rs.random(); let id = 0; while (id < n - 1 && cdf[id] <= u0) id++;   // searchsorted side="right"
    C.push(Float64Array.from(X[id])); let closest = Float64Array.from({ length: n }, (_, i) => sqd(i, X[id], xx[id])), pot = closest.reduce((s, v) => s + v, 0);
    while (C.length < k) {
      const cum = new Float64Array(n); let s = 0; for (let i = 0; i < n; i++) { s += closest[i]; cum[i] = s; }
      const cands = Array.from({ length: nTrials }, () => { const r = rs.random() * pot; let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < r) lo = m + 1; else hi = m; } return Math.min(lo, n - 1); });
      let best = -1, bestPot = Infinity, bestD = null;
      for (const c of cands) { const dd = Float64Array.from({ length: n }, (_, i) => Math.min(closest[i], sqd(i, X[c], xx[c]))), p = dd.reduce((a, v) => a + v, 0); if (p < bestPot) { bestPot = p; best = c; bestD = dd; } }
      C.push(Float64Array.from(X[best])); closest = bestD; pot = bestPot;
    }
    return C;
  }
  function assign(C, lab) {
    const cc = C.map((c) => dot(c, c));
    for (let i = 0; i < n; i++) { let bj = 0, bv = Infinity; for (let j = 0; j < k; j++) { const v = cc[j] - 2 * dot(X[i], C[j]); if (v < bv) { bv = v; bj = j; } } lab[i] = bj; }
  }
  let best = null;
  for (let run = 0; run < nInit; run++) {
    let C = plusplus(); const lab = new Int32Array(n).fill(-1), old = new Int32Array(n).fill(-1); let strict = false;
    for (let it = 0; it < maxIter; it++) {
      assign(C, lab);
      const S = Array.from({ length: k }, () => new Float64Array(d)), N = new Int32Array(k);
      for (let i = 0; i < n; i++) { N[lab[i]]++; const s = S[lab[i]]; for (let t = 0; t < d; t++) s[t] += X[i][t]; }
      let shift = 0; const Cn = C.map((c, j) => { if (!N[j]) return c; const m = Float64Array.from(S[j], (v) => v / N[j]); let s = 0; for (let t = 0; t < d; t++) s += (m[t] - c[t]) ** 2; shift += s; return m; });
      C = Cn;
      if (lab.every((v, i) => v === old[i])) { strict = true; break; }
      if (shift <= TOL) break;
      old.set(lab);
    }
    if (!strict) assign(C, lab);
    let inertia = 0; for (let i = 0; i < n; i++) { let s = 0; for (let t = 0; t < d; t++) s += (X[i][t] - C[lab[i]][t]) ** 2; inertia += s; }
    if (!best || (inertia < best.inertia && !sameClustering(lab, best.labels, k))) best = { inertia, labels: Int32Array.from(lab), centers: C.map((c) => Float64Array.from(c, (v, j) => v + mu[j])) };
  }
  return best;
}
function hungarianMax(M) {                                          // max-weight assignment on a square matrix (Kuhn–Munkres) → col of each row
  const n = M.length, INF = Infinity, u = new Float64Array(n + 1), v = new Float64Array(n + 1), p = new Int32Array(n + 1), way = new Int32Array(n + 1);
  const cost = (i, j) => -M[i - 1][j - 1];
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0; const minv = new Float64Array(n + 1).fill(INF), used = new Uint8Array(n + 1);
    do { used[j0] = 1; const i0 = p[j0]; let delta = INF, j1 = 0;
      for (let j = 1; j <= n; j++) if (!used[j]) { const cur = cost(i0, j) - u[i0] - v[j]; if (cur < minv[j]) { minv[j] = cur; way[j] = j0; } if (minv[j] < delta) { delta = minv[j]; j1 = j; } }
      for (let j = 0; j <= n; j++) if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      j0 = j1; } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const rowToCol = new Int32Array(n); for (let j = 1; j <= n; j++) if (p[j]) rowToCol[p[j] - 1] = j - 1; return rowToCol;
}
// align_labels(source → target): {mapping: {src: tgt}, accuracy, aligned, method, flipped?}
export function alignLabels(src, tgt) {
  const S = [...new Set(src)].sort((a, b) => a - b), T = [...new Set(tgt)].sort((a, b) => a - b), n = src.length;
  if (S.length !== T.length) throw new Error(`align: ${S.length} clusters vs ${T.length} classes`);
  let mapping = {}, method, flipped;
  if (S.length === 2) {
    method = "flip"; let same = 0; for (let i = 0; i < n; i++) if (src[i] === tgt[i]) same++;
    flipped = n - same > same; mapping = flipped ? { [S[0]]: T[1], [S[1]]: T[0] } : { [S[0]]: T[0], [S[1]]: T[1] };
  } else {
    method = "hungarian"; const M = T.map((t) => S.map((s) => { let c = 0; for (let i = 0; i < n; i++) if (tgt[i] === t && src[i] === s) c++; return c; }));
    hungarianMax(M).forEach((si, ti) => { mapping[S[si]] = T[ti]; });
  }
  const aligned = Int32Array.from(src, (s) => mapping[s]); let agree = 0; for (let i = 0; i < n; i++) if (aligned[i] === tgt[i]) agree++;
  return { mapping, accuracy: agree / n, aligned, method, flipped };
}

// The desktop pipeline on L0 (her preset): rows = Float64Array of the feature columns, cls = class index per row.
export function desktopL0(rows, cls, { k = null, pcaN = 3, bandwidth = 0.2, seed = 42 } = {}) {
  const { X } = minmax(rows), P = pca(X, pcaN), km = kmeans(X, k ?? new Set(cls).size, { seed });
  const pcs = Array.from({ length: pcaN }, (_, c) => unit(P.Z.map((z) => z[c])));
  return { scaled: X, pca: P.Z.map((_, i) => pcs.map((v) => v[i])), explained: P.explained, density: unit(kdeLog(X, bandwidth)),
           km_raw: km.labels, km_inertia: km.inertia, align: alignLabels(Array.from(km.labels), Array.from(cls)) };
}
