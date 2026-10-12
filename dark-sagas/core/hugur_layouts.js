// hugur_layouts.js — the layouts preprocess.py stage_sites computes after the sites (lines 647–686),
// as pure functions on a Float32Array/Float64Array matrix M (n × d, row-major) + row count.
//
// ES module, no DOM, no Node-only APIs. All functions are deterministic given the seed: a small
// seeded PRNG (mulberry32 + Box–Muller) replaces numpy's RandomState / sklearn's random_state for
// k-means and the SOM; the embedding PCA uses a numpy-compatible MT19937 (see pcaRandomized).
//
// Status per column of sites_l0.parquet (numbers measured 2026-10-08 by probe/sites_equiv.mjs on
// the two-saga reference — 547 sites × 100 dims, egla + njala — and on the 42-saga corpus,
// 2 311 sites × 100 dims; scikit-learn 1.7.2 / numpy 1.26.4 produced both parquets):
//
//   emb_0..7   EQUIVALENT. attachLayouts() mirrors sklearn's svd_solver='auto' policy
//              (sklearnPcaSolver): covariance_eigh for n ≥ 10·d (d ≤ 1000), 'full' for
//              max(n, d) ≤ 500 — both exact, served by the Jacobi pca() — otherwise the *randomized*
//              SVD seeded by RandomState(42), which pcaRandomized() reproduces (numpy MT19937 +
//              legacy gaussian). Against sklearn's own PCA call re-run in float64 with the same
//              version, seed and resolved solver (the exporter's ref/emb_witness64.json) the port
//              agrees to ≤ 2.9e-15 (two-saga, randomized) and ≤ 4.1e-14 (42-saga, covariance_eigh).
//              The parquets were computed in float32 and depart from their own algorithm's float64
//              value by ≤ 1.1e-6 (two-saga) and up to 1.47e-5 (42-saga, emb_3; emb_2: 1.23e-5 =
//              1.01e-4 × the component's scale); the JS–parquet gap equals that float32 noise on every
//              component (ratio 1.000), every sign +. Gate: |js − witness64| ≤ 1e-9 and solver name
//              equal; |js − parquet| ≤ 1e-4 absolute AND ≤ the measured float32 noise + 1e-9 (a plain
//              1e-4 × scale bound would fail on the reference's own noise, so it is reported only).
//              The exact Jacobi pca() = numpy eigh to 1e-15; against the two-saga *randomized*
//              parquet alone it differs by 2.3e-7 (emb_0) … 4.05e-4 (emb_7): sklearn's
//              approximation, not ours — hence the solver mirror.
//   gpca_x/y   EQUIVALENT. PCA(2) on (G - mean) / (std + 1e-9) with numpy's population std, the
//              nine columns in preprocess.py's order; sklearn used covariance_eigh here (9 cols):
//              max|d| 6.6e-14 / 5.0e-13 two-saga, 2.8e-13 / 1.2e-12 42-saga (gate 1e-9), signs +.
//   km_cluster PARTITION-EQUIVALENT, labels not. Greedy k-means++ (sklearn's 2 + floor(ln k) local
//              trials) + Lloyd to convergence, best inertia over nInit, from a mulberry32 stream:
//              ARI 0.92 (two-saga) / 0.975 (42-saga) against the seed-42 sklearn partition, while
//              sklearn's own seeds 0–19 vs seed 42 span ARI 0.29–0.97 (two-saga, median 0.91) and
//              0.63–0.99 (42-saga); inertia ratio JS/reference 1.00016 and 0.99999. The gate is
//              PRNG-independent: inertia ratio ≤ 1.01 to the reference partition's own inertia and
//              exactly 6 non-empty clusters.
//   som_x/y    STRUCTURE only. preprocess._som_fit() statement for statement (same lr/sigma
//              schedules, same per-sample update order per epoch via a seeded permutation, same
//              ±0.35 in-cell jitter) but numpy's seed-42 map needs MT19937 draws in numpy's exact
//              consumption order, which is not reproduced: reference-cell neighbour pairs still
//              within 1 cell in JS = 0.58 two-saga / 0.54 42-saga (cell ARI 0.39 / 0.28); numpy's
//              own seed 43 vs 42 gives 0.51 / 0.55 and cell ARI 0.32 / 0.28 — the JS map is as close
//              to the desktop map as another numpy seed is. Gate: inside the 12 × 8 grid ± 0.35.
//   umap_x/y   PRESENT BUT NOT EQUIVALENT. The desktop venv has umap-learn 0.5.9, so the parquet
//              holds real UMAP(n_components=2, random_state=42, n_neighbors=15) coordinates. Without
//              a hook this module writes the emb_0/emb_1 fallback (what preprocess does when umap is
//              missing; status.umap = 'fallback'); the probe reports the k = 15 nearest-neighbour
//              overlap: 0.13 two-saga / 0.07 42-saga (random 0.03 / 0.007). With makeUmapHook(UMAP)
//              (the vendored umap-js 1.4.0, P2) it writes a real UMAP: exact kNN (exactKnn, euclidean,
//              self first — umap-learn's own rule below 4,096 points), n_neighbors = min(15, max(2,
//              n − 1)), min_dist 0.1, spread 1.0, 500 epochs (n ≤ 10,000), seed 42 through
//              mulberry32 → deterministic; status.umap = 'umap-js'. Still not the desktop's picture:
//              umap-js initialises at random (umap-learn: spectral) and optimises its own way; the
//              gate compares cluster agreement, never coordinates (design WEB_P2_DESIGN.md §5.5).
//   tsne_x/y   ABSENT without a hook. With makeTsneHook(TSNE) (the vendored tsne-js 1.0.3) it is a
//              real t-SNE: perplexity min(30, max(5, floor(n / 20))), early exaggeration 12, learning
//              rate max(n / 48, 50), 1,000 iterations, euclidean, initialised from the exact sklearn
//              PCA scores scaled like sklearn's init='pca' (first column std 1e-4) — the desktop's
//              parameters; tsne-js's own schedule (exaggeration to iteration 100, momentum 0.5 → 0.8
//              at 50, patience 30) differs from sklearn's (250 / 250 / 300). Deterministic (no draw
//              survives the PCA init). status.tsne = 'tsne-js'. MEASURED COST (Node 26, 2026-10-08):
//              40 ms per iteration at 547 sites, ≈ 720 ms at 2,311 (exact n² in generic ndarray
//              ops) — 41 s for the two sagas, ≈ 12 min for 42: the recompute worker runs it AFTER
//              the picture (deferred) within a budget, never inline (core/recompute_worker.js).
//   som_x/y    the epoch cap (design §5.4): somEpochsFor(n, 'auto') = 60 for n ≤ 2,000, else
//              max(20, floor(120,000 / n)) (2,311 → 51); the default (opts.somEpochs undefined) stays
//              60 so the probe's run is unchanged. som() is the stepper somStepper() run to the end.
//   position   row index, exact.
//
// adjustedRandIndex(a, b) — sklearn.metrics.adjusted_rand_score, exported for the gate: k-means
// (and SOM cells) are compared as partitions, never by label number.
//
// Edge cases that never occur for a real saga: kmeans with n < k clamps k to n and gpca with
// n < 2 returns zeros (sklearn raises); pcaRandomized with k + 10 > min(n, d) falls back to pca().
//
// opts.pcaSolver: 'auto' (default, sklearn's policy as above) | 'exact' (Jacobi) | 'randomized'.

// ------------------------------------------------------------------- PRNG --

/** mulberry32: 32-bit seed → uniform [0, 1) doubles. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal draws (Box–Muller, both halves used) over a uniform source. */
export function gaussian(rng) {
  let spare = null;
  return function randn() {
    if (spare !== null) { const v = spare; spare = null; return v; }
    let u = 0, v = 0;
    do { u = rng(); } while (u <= 1e-300);          // avoid log(0)
    v = rng();
    const r = Math.sqrt(-2.0 * Math.log(u)), th = 2.0 * Math.PI * v;
    spare = r * Math.sin(th);
    return r * Math.cos(th);
  };
}

/** Fisher–Yates permutation of 0..n-1 (numpy.random.permutation stand-in). */
export function permutation(n, rng) {
  const p = new Int32Array(n);
  for (let i = 0; i < n; i++) p[i] = i;
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  return p;
}

// --------------------------------------------------------- linear algebra --

/** Cyclic Jacobi eigen-decomposition of a symmetric d×d matrix (row-major Float64Array).
 *  → {values: Float64Array d, vectors: Float64Array d×d, column c = eigenvector of values[c]}
 *  (unsorted). Numerical Recipes' `jacobi`, upper triangle. Fine for d ≤ a few hundred. */
export function jacobiEigen(A, d, maxSweeps = 100) {
  const a = Float64Array.from(A);
  const v = new Float64Array(d * d);
  for (let i = 0; i < d; i++) v[i * d + i] = 1.0;
  const vals = new Float64Array(d), b = new Float64Array(d), z = new Float64Array(d);
  for (let i = 0; i < d; i++) { vals[i] = a[i * d + i]; b[i] = vals[i]; }
  const rot = (arr, i, j, k, l, s, tau) => {
    const g = arr[i * d + j], h = arr[k * d + l];
    arr[i * d + j] = g - s * (h + g * tau);
    arr[k * d + l] = h + s * (g - h * tau);
  };
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let sm = 0.0;
    for (let p = 0; p < d - 1; p++) for (let q = p + 1; q < d; q++) sm += Math.abs(a[p * d + q]);
    if (sm === 0.0) break;
    const tresh = sweep < 3 ? 0.2 * sm / (d * d) : 0.0;
    for (let p = 0; p < d - 1; p++) {
      for (let q = p + 1; q < d; q++) {
        const apq = a[p * d + q];
        const g = 100.0 * Math.abs(apq);
        if (sweep > 3 && Math.abs(vals[p]) + g === Math.abs(vals[p]) &&
            Math.abs(vals[q]) + g === Math.abs(vals[q])) {
          a[p * d + q] = 0.0;
        } else if (Math.abs(apq) > tresh) {
          let h = vals[q] - vals[p], t;
          if (Math.abs(h) + g === Math.abs(h)) {
            t = apq / h;
          } else {
            const theta = 0.5 * h / apq;
            t = 1.0 / (Math.abs(theta) + Math.sqrt(1.0 + theta * theta));
            if (theta < 0.0) t = -t;
          }
          const c = 1.0 / Math.sqrt(1.0 + t * t), s = t * c, tau = s / (1.0 + c);
          h = t * apq;
          z[p] -= h; z[q] += h; vals[p] -= h; vals[q] += h;
          a[p * d + q] = 0.0;
          for (let j = 0; j < p; j++) rot(a, j, p, j, q, s, tau);
          for (let j = p + 1; j < q; j++) rot(a, p, j, j, q, s, tau);
          for (let j = q + 1; j < d; j++) rot(a, p, j, q, j, s, tau);
          for (let j = 0; j < d; j++) rot(v, j, p, j, q, s, tau);
        }
      }
    }
    for (let i = 0; i < d; i++) { b[i] += z[i]; vals[i] = b[i]; z[i] = 0.0; }
  }
  return { values: vals, vectors: v };
}

/** Column means of M (n × d). */
export function columnMeans(M, n, d) {
  const mean = new Float64Array(d);
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) mean[j] += M[i * d + j];
  if (n > 0) for (let j = 0; j < d; j++) mean[j] /= n;
  return mean;
}

// -------------------------------------------------------------------- PCA --

/**
 * Centered PCA of M (n × d) → k components, ordered by decreasing variance.
 *   scores:            Float64Array n×k   (centered X @ components^T, == sklearn fit_transform)
 *   explained:         number[k]          share of the total variance per component (sklearn's
 *                                         explained_variance_ratio_; points on a line → [1, 0])
 *   explainedRatio:    number[k]          alias of `explained`
 *   explainedVariance: number[k]          absolute variance per component (S² / (n-1), sklearn's
 *                                         explained_variance_)
 *   components:     Float64Array k×d   (sklearn components_, sign-fixed like svd_flip)
 *   mean:           Float64Array d
 */
export function pca(M, n, d, k) {
  k = Math.max(0, Math.min(k | 0, d, n));
  const mean = columnMeans(M, n, d);
  const Xc = new Float64Array(n * d);
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) Xc[i * d + j] = M[i * d + j] - mean[j];
  // covariance (upper triangle, then mirrored), normalised by n-1 like sklearn
  const C = new Float64Array(d * d);
  for (let i = 0; i < n; i++) {
    const off = i * d;
    for (let a = 0; a < d; a++) {
      const xa = Xc[off + a];
      if (xa === 0.0) continue;
      const rowA = a * d;
      for (let b = a; b < d; b++) C[rowA + b] += xa * Xc[off + b];
    }
  }
  const denom = n > 1 ? n - 1 : 1;
  for (let a = 0; a < d; a++) {
    for (let b = a; b < d; b++) { C[a * d + b] /= denom; C[b * d + a] = C[a * d + b]; }
  }
  const { values, vectors } = jacobiEigen(C, d);
  const order = Array.from({ length: d }, (_, i) => i).sort((p, q) => values[q] - values[p] || p - q);
  let total = 0.0;
  for (let i = 0; i < d; i++) total += Math.max(values[i], 0.0);
  const components = new Float64Array(k * d);
  const explainedVariance = [], explained = [];
  for (let c = 0; c < k; c++) {
    const col = order[c];
    // sign: largest-|entry| of the component positive (sklearn svd_flip, u_based_decision=False)
    let imax = 0, vmax = -1.0;
    for (let j = 0; j < d; j++) {
      const av = Math.abs(vectors[j * d + col]);
      if (av > vmax) { vmax = av; imax = j; }
    }
    const sgn = vectors[imax * d + col] < 0 ? -1.0 : 1.0;
    for (let j = 0; j < d; j++) components[c * d + j] = sgn * vectors[j * d + col];
    const ev = Math.max(values[col], 0.0);
    explainedVariance.push(ev);
    explained.push(total > 0 ? ev / total : 0.0);
  }
  const scores = new Float64Array(n * k);
  for (let i = 0; i < n; i++) {
    const off = i * d;
    for (let c = 0; c < k; c++) {
      let s = 0.0;
      const coff = c * d;
      for (let j = 0; j < d; j++) s += Xc[off + j] * components[coff + j];
      scores[i * k + c] = s;
    }
  }
  return { scores, explained, explainedRatio: explained, explainedVariance, components, mean, k };
}

// ----------------------------------------------------------------- KMeans --

function sqDist(M, i, Cn, c, d) {
  let s = 0.0;
  const a = i * d, b = c * d;
  for (let j = 0; j < d; j++) { const t = M[a + j] - Cn[b + j]; s += t * t; }
  return s;
}

/** Greedy k-means++ seeding (sklearn _kmeans_plusplus: n_local_trials = 2 + floor(ln k)). */
function kmeansPlusPlus(M, n, d, k, rng) {
  const centers = new Float64Array(k * d);
  const nTrials = 2 + Math.floor(Math.log(k));
  const first = Math.min(n - 1, Math.floor(rng() * n));
  centers.set(M.subarray(first * d, first * d + d), 0);
  const closest = new Float64Array(n);
  let pot = 0.0;
  for (let i = 0; i < n; i++) { closest[i] = sqDist(M, i, centers, 0, d); pot += closest[i]; }
  const cand = new Float64Array(n);
  for (let c = 1; c < k; c++) {
    let bestId = -1, bestPot = Infinity, bestDist = null;
    for (let t = 0; t < nTrials; t++) {
      // sample ∝ closest² : searchsorted(cumsum(closest), r * pot)
      const r = rng() * pot;
      let acc = 0.0, id = n - 1;
      for (let i = 0; i < n; i++) { acc += closest[i]; if (r < acc) { id = i; break; } }
      let p = 0.0;
      for (let i = 0; i < n; i++) {
        let s = 0.0;
        const a = i * d, b = id * d;
        for (let j = 0; j < d; j++) { const x = M[a + j] - M[b + j]; s += x * x; }
        cand[i] = s < closest[i] ? s : closest[i];
        p += cand[i];
      }
      if (p < bestPot) { bestPot = p; bestId = id; bestDist = Float64Array.from(cand); }
    }
    centers.set(M.subarray(bestId * d, bestId * d + d), c * d);
    closest.set(bestDist);
    pot = bestPot;
  }
  return centers;
}

/** Lloyd iterations from given centers → {labels, centers, inertia, iterations}. */
function lloyd(M, n, d, k, centers, tol, maxIter = 300) {
  const labels = new Int32Array(n).fill(-1);
  const counts = new Int32Array(k);
  const next = new Float64Array(k * d);
  let inertia = 0.0, it = 0;
  for (it = 0; it < maxIter; it++) {
    let changed = 0;
    inertia = 0.0;
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) { const s = sqDist(M, i, centers, c, d); if (s < bd) { bd = s; best = c; } }
      if (labels[i] !== best) { labels[i] = best; changed += 1; }
      inertia += bd;
    }
    next.fill(0.0); counts.fill(0);
    for (let i = 0; i < n; i++) {
      const c = labels[i]; counts[c] += 1;
      const a = i * d, b = c * d;
      for (let j = 0; j < d; j++) next[b + j] += M[a + j];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) { for (let j = 0; j < d; j++) next[c * d + j] /= counts[c]; }
      else {
        // empty cluster: move its center to the point farthest from its own center
        let far = 0, fd = -1.0;
        for (let i = 0; i < n; i++) { const s = sqDist(M, i, centers, labels[i], d); if (s > fd) { fd = s; far = i; } }
        next.set(M.subarray(far * d, far * d + d), c * d);
      }
    }
    let shift = 0.0;
    for (let x = 0; x < k * d; x++) { const t = next[x] - centers[x]; shift += t * t; }
    centers.set(next);
    if (changed === 0 || shift <= tol) { it += 1; break; }
  }
  // closing E-step with the converged centers (sklearn's final _labels_inertia): the labels and
  // the inertia both refer to the centers that are returned, also after a shift-tolerance stop
  inertia = 0.0;
  for (let i = 0; i < n; i++) {
    let best = 0, bd = Infinity;
    for (let c = 0; c < k; c++) { const s = sqDist(M, i, centers, c, d); if (s < bd) { bd = s; best = c; } }
    labels[i] = best; inertia += bd;
  }
  return { labels, centers, inertia, iterations: it };
}

/** Full result: {labels: Int32Array, centers: Float64Array k×d, inertia, nInit} */
export function kmeansFull(M, n, d, k = 6, seed = 42, nInit = 10) {
  k = Math.max(1, Math.min(k | 0, n));
  const rng = mulberry32(seed);
  // sklearn: tol = 1e-4 × mean per-feature variance of the data
  const mean = columnMeans(M, n, d);
  let varSum = 0.0;
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) { const t = M[i * d + j] - mean[j]; varSum += t * t; }
  const tol = 1e-4 * (n > 0 ? varSum / (n * d) : 0.0);
  let best = null;
  for (let r = 0; r < nInit; r++) {
    const centers = kmeansPlusPlus(M, n, d, k, rng);
    const res = lloyd(M, n, d, k, centers, tol);
    if (best === null || res.inertia < best.inertia) best = res;
  }
  return { labels: best.labels, centers: best.centers, inertia: best.inertia, nInit, k };
}

/** k-means labels (Int32Array n): k-means++ init, Lloyd to convergence, best inertia over nInit. */
export function kmeans(M, n, d, k = 6, seed = 42, nInit = 10) {
  return kmeansFull(M, n, d, k, seed, nInit).labels;
}

// -------------------------------------------------------------------- SOM --

/** The epoch cap of design WEB_P2_DESIGN.md §5.4: 'auto' → 60 epochs for n ≤ 2,000, else max(20, floor(120,000 / n))
 *  (2,311 → 51 ≈ 2.2 s; 5,000 → 24); a number → that number; undefined/null → 60 (today's default). The grid stays
 *  12 × 8 (the gate "inside the grid ± 0.35" is epoch-independent). */
export function somEpochsFor(n, epochs = undefined) {
  if (epochs === undefined || epochs === null) return 60;
  if (epochs === 'auto') return n <= 2000 ? 60 : Math.max(20, Math.floor(120000 / n));
  const e = Math.floor(Number(epochs));
  if (!Number.isFinite(e) || e < 0) throw new RangeError(`somEpochsFor: epochs must be 'auto' or a non-negative integer (got ${JSON.stringify(epochs)})`);
  return e;
}

/**
 * preprocess._som_fit() as a STEPPER (P2, design §5.4: a worker runs one epoch per macrotask so a cancel message gets
 * through): the same draws from the same seeded stream in the same order as som() — W init, one permutation per
 * epoch, the jitter at the end — so somStepper(...).step() × iters then .finish() is bit-identical to som(...).
 *   step()   → true while epochs remain (false after the last one); a no-op once all are done
 *   epoch    → epochs run so far
 *   finish() → Float64Array n×2: BMU cells + U(−0.35, 0.35) jitter (callable once; after fewer than `iters` epochs
 *              it is the map of a stopped run — the worker never reads one, it throws on cancel instead)
 */
export function somStepper(M, n, d, gw = 12, gh = 8, iters = 60, seed = 42) {
  const rng = mulberry32(seed), randn = gaussian(rng);
  const cells = gw * gh;
  const W = new Float64Array(cells * d);
  for (let x = 0; x < cells * d; x++) W[x] = randn() * 0.1;        // rng.randn(cells, d) * 0.1
  // grid = column_stack([gx.ravel(), gy.ravel()]) for gy, gx = mgrid[0:gh, 0:gw]
  const gx = new Float64Array(cells), gy = new Float64Array(cells);
  for (let c = 0; c < cells; c++) { gx[c] = c % gw; gy[c] = Math.floor(c / gw); }
  const h = new Float64Array(cells);
  const bmuOf = (i) => {
    let best = 0, bd = Infinity;
    const a = i * d;
    for (let c = 0; c < cells; c++) {
      let s = 0.0;
      const b = c * d;
      for (let j = 0; j < d; j++) { const t = W[b + j] - M[a + j]; s += t * t; }
      if (s < bd) { bd = s; best = c; }
    }
    return best;
  };
  let it = 0;
  return {
    iters,
    get epoch() { return it; },
    step() {
      if (it >= iters) return false;
      const lr = 0.5 * (1 - it / iters) + 0.02;
      const sig = Math.max(gw, gh) / 2 * (1 - it / iters) + 0.8;
      const inv = 1.0 / (2 * sig * sig);
      const perm = permutation(n, rng);
      for (let pi = 0; pi < n; pi++) {
        const i = perm[pi], a = i * d;
        const bmu = bmuOf(i);
        for (let c = 0; c < cells; c++) {
          const dx = gx[c] - gx[bmu], dy = gy[c] - gy[bmu];
          h[c] = Math.exp(-(dx * dx + dy * dy) * inv);
        }
        for (let c = 0; c < cells; c++) {
          const f = lr * h[c], b = c * d;
          for (let j = 0; j < d; j++) W[b + j] += f * (M[a + j] - W[b + j]);
        }
      }
      it += 1;
      return it < iters;
    },
    finish() {
      const out = new Float64Array(n * 2);
      const bmus = new Int32Array(n);
      for (let i = 0; i < n; i++) bmus[i] = bmuOf(i);
      for (let i = 0; i < n; i++) {                                 // rng.uniform(-0.35, 0.35, (n, 2))
        out[i * 2] = gx[bmus[i]] + (rng() * 0.7 - 0.35);
        out[i * 2 + 1] = gy[bmus[i]] + (rng() * 0.7 - 0.35);
      }
      return out;
    },
  };
}

/** preprocess._som_fit(): tiny Kohonen SOM → Float64Array n×2 grid coords (gx, gy) with in-cell
 *  jitter U(-0.35, 0.35). Seeded PRNG stands in for numpy's RandomState(seed). The stepper run to the end;
 *  opts.onEpoch(epochsDone, iters) → false stops early (design §5.4; the default behaviour is unchanged). */
export function som(M, n, d, gw = 12, gh = 8, iters = 60, seed = 42, opts = {}) {
  const st = somStepper(M, n, d, gw, gh, iters, seed);
  const onEpoch = opts && typeof opts.onEpoch === 'function' ? opts.onEpoch : null;
  let more = iters > 0;
  while (more) {
    more = st.step();
    if (onEpoch && onEpoch(st.epoch, iters) === false) break;
  }
  return st.finish();
}

// ------------------------------------------------------------ grammar PCA --

export const GPCA_COLS = ["subj_ratio", "middle_ratio", "dat_ratio", "acc_ratio", "gen_ratio",
  "neg_ratio", "impersonal_ratio", "speech_ratio", "experiencer_count"];

/** Grammar-space PCA: standardize the nine columns ((G - mean) / (std + 1e-9), population std)
 *  and take PCA(2) → Float64Array n×2. Returns zeros for n < 2. */
export function gpca(rows) {
  const n = rows.length, d = GPCA_COLS.length;
  const G = new Float64Array(n * d);
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) {
    const v = rows[i][GPCA_COLS[j]];
    const x = (v === null || v === undefined) ? NaN : Number(v);
    // sklearn raises "Input contains NaN" here; a silent 0 would move every site in grammar space
    if (!Number.isFinite(x)) throw new Error(`gpca: non-finite ${GPCA_COLS[j]} at row ${i} (${v})`);
    G[i * d + j] = x;
  }
  const out = new Float64Array(n * 2);
  if (n < 2) return out;
  const mean = columnMeans(G, n, d);
  const std = new Float64Array(d);
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) { const t = G[i * d + j] - mean[j]; std[j] += t * t; }
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j] / n);       // numpy std, ddof=0
  const Z = new Float64Array(n * d);
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) Z[i * d + j] = (G[i * d + j] - mean[j]) / (std[j] + 1e-9);
  const { scores, k } = pca(Z, n, d, 2);
  for (let i = 0; i < n; i++) {
    out[i * 2] = scores[i * k];
    out[i * 2 + 1] = k > 1 ? scores[i * k + 1] : 0.0;
  }
  return out;
}

// ------------------------------------------------ numpy PRNG + sklearn PCA --
//
// preprocess.py's embedding PCA is sklearn PCA(n_components=k, random_state=42) with
// svd_solver='auto'. For the two-saga reference (547 × 100, k = 8) 'auto' resolves to the
// *randomized* SVD (Halko et al.), seeded by np.random.RandomState(42): its trailing components
// differ from the exact PCA by up to 4e-4, more than the gate's 1e-4. To reproduce the desktop
// columns the same random start matrix is needed, hence an MT19937 with numpy's legacy seeding,
// 53-bit doubles and the legacy polar-method gaussian. This is a mirrored Python quirk, used only
// by pcaRandomized(); kmeans()/som() keep mulberry32 as the contract asks. The port reproduces
// sklearn's randomized PCA run in float64 to 2.9e-15 and its float32 parquet to ~1e-6 (the
// parquet's own float32 noise; measured 2026-10-08, probe/sites_equiv.mjs + ref/emb_witness64.json).

/** MT19937 seeded like np.random.RandomState(int) (numpy mt19937_seed == init_genrand) → next uint32. */
export function mt19937(seed) {
  const N = 624, M = 397;
  const mt = new Uint32Array(N);
  let mti = N;
  mt[0] = seed >>> 0;
  for (let i = 1; i < N; i++) {
    const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
    mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
  }
  return function next() {
    if (mti >= N) {
      for (let kk = 0; kk < N; kk++) {
        const y = (mt[kk] & 0x80000000) | (mt[(kk + 1) % N] & 0x7fffffff);
        mt[kk] = mt[(kk + M) % N] ^ (y >>> 1) ^ ((y & 1) ? 0x9908b0df : 0);
      }
      mti = 0;
    }
    let y = mt[mti++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  };
}

/** numpy legacy RandomState(seed) draws: randomSample() = random_sample() (53-bit double),
 *  gauss() = legacy_gauss (polar Box–Muller, second value cached), normal(count) = normal(size)
 *  with loc 0 / scale 1 filled in C order, uniform(lo, hi) = lo + (hi - lo) * random_sample(). */
export function numpyRandomState(seed) {
  const next = mt19937(seed);
  let hasGauss = false, gaussV = 0.0;
  const randomSample = () => {
    const a = next() >>> 5, b = next() >>> 6;
    return (a * 67108864.0 + b) / 9007199254740992.0;
  };
  const gauss = () => {
    if (hasGauss) { hasGauss = false; const t = gaussV; gaussV = 0.0; return t; }
    let x1, x2, r2;
    do {
      x1 = 2.0 * randomSample() - 1.0;
      x2 = 2.0 * randomSample() - 1.0;
      r2 = x1 * x1 + x2 * x2;
    } while (r2 >= 1.0 || r2 === 0.0);
    const f = Math.sqrt(-2.0 * Math.log(r2) / r2);
    gaussV = f * x1; hasGauss = true;
    return f * x2;
  };
  const normal = (count) => { const out = new Float64Array(count); for (let i = 0; i < count; i++) out[i] = gauss(); return out; };
  const uniform = (lo, hi) => lo + (hi - lo) * randomSample();
  return { next, randomSample, gauss, normal, uniform };
}

// dense row-major helpers (small matrices: n × 18, 100 × 18, 18 × 18)
function matmul(A, ar, ac, B, bc) {                 // A (ar×ac) @ B (ac×bc)
  const C = new Float64Array(ar * bc);
  for (let i = 0; i < ar; i++) {
    const ao = i * ac, co = i * bc;
    for (let p = 0; p < ac; p++) {
      const a = A[ao + p]; if (a === 0) continue;
      const bo = p * bc;
      for (let j = 0; j < bc; j++) C[co + j] += a * B[bo + j];
    }
  }
  return C;
}
function matmulT(A, ar, ac, B, bc) {                // A^T (ac×ar) @ B (ar×bc)
  const C = new Float64Array(ac * bc);
  for (let p = 0; p < ar; p++) {
    const ao = p * ac, bo = p * bc;
    for (let i = 0; i < ac; i++) {
      const a = A[ao + i]; if (a === 0) continue;
      const co = i * bc;
      for (let j = 0; j < bc; j++) C[co + j] += a * B[bo + j];
    }
  }
  return C;
}

/** scipy.linalg.lu(X, permute_l=True)[0] for a tall X (m × r, m ≥ r): P @ L, L unit lower
 *  trapezoidal from partial-pivoting LU (first maximal |pivot| wins, like LAPACK idamax). */
export function luPermutedL(X, m, r) {
  if (m < r) throw new RangeError(`luPermutedL: needs m >= r (got ${m} x ${r})`);
  const A = Float64Array.from(X);
  const perm = new Int32Array(m);
  for (let i = 0; i < m; i++) perm[i] = i;
  for (let j = 0; j < r; j++) {
    let p = j, best = Math.abs(A[j * r + j]);
    for (let i = j + 1; i < m; i++) { const a = Math.abs(A[i * r + j]); if (a > best) { best = a; p = i; } }
    if (p !== j) {
      for (let c = 0; c < r; c++) { const t = A[j * r + c]; A[j * r + c] = A[p * r + c]; A[p * r + c] = t; }
      const t = perm[j]; perm[j] = perm[p]; perm[p] = t;
    }
    const piv = A[j * r + j];
    if (piv === 0) continue;
    for (let i = j + 1; i < m; i++) {
      const l = A[i * r + j] / piv;
      A[i * r + j] = l;
      if (l !== 0) for (let c = j + 1; c < r; c++) A[i * r + c] -= l * A[j * r + c];
    }
  }
  const PL = new Float64Array(m * r);
  for (let i = 0; i < m; i++) {
    const o = perm[i] * r;
    for (let c = 0; c < r; c++) PL[o + c] = c < i ? A[i * r + c] : (c === i ? 1.0 : 0.0);
  }
  return PL;
}

/** scipy.linalg.qr(X, mode='economic')[0] for a tall X (m × r): Householder Q (m × r). Column
 *  signs may differ from LAPACK's — immaterial here, U = Q @ Uhat is invariant to them. */
export function qrEconomicQ(X, m, r) {
  const A = Float64Array.from(X);
  const vs = new Array(r), betas = new Float64Array(r);
  for (let j = 0; j < r; j++) {
    let norm2 = 0.0;
    for (let i = j; i < m; i++) norm2 += A[i * r + j] * A[i * r + j];
    const alpha = Math.sqrt(norm2);
    if (alpha === 0.0) { vs[j] = null; continue; }
    const x0 = A[j * r + j];
    const v = new Float64Array(m - j);
    v[0] = x0 + (x0 >= 0 ? alpha : -alpha);
    for (let i = j + 1; i < m; i++) v[i - j] = A[i * r + j];
    let vn = 0.0;
    for (let i = 0; i < v.length; i++) vn += v[i] * v[i];
    const beta = 2.0 / vn;
    for (let c = j; c < r; c++) {
      let dot = 0.0;
      for (let i = j; i < m; i++) dot += v[i - j] * A[i * r + c];
      dot *= beta;
      for (let i = j; i < m; i++) A[i * r + c] -= dot * v[i - j];
    }
    vs[j] = v; betas[j] = beta;
  }
  const Q = new Float64Array(m * r);
  for (let c = 0; c < r; c++) Q[c * r + c] = 1.0;
  for (let j = r - 1; j >= 0; j--) {
    const v = vs[j]; if (!v) continue;
    const beta = betas[j];
    for (let c = 0; c < r; c++) {
      let dot = 0.0;
      for (let i = j; i < m; i++) dot += v[i - j] * Q[i * r + c];
      dot *= beta;
      for (let i = j; i < m; i++) Q[i * r + c] -= dot * v[i - j];
    }
  }
  return Q;
}

/** Thin SVD of a wide B (r × d, r ≤ d) through the r × r Gram matrix: {U: r×r, s: r (desc), Vt: r×d}. */
function svdViaGram(B, r, d) {
  const S = new Float64Array(r * r);
  for (let i = 0; i < r; i++) for (let j = i; j < r; j++) {
    let s = 0.0;
    for (let c = 0; c < d; c++) s += B[i * d + c] * B[j * d + c];
    S[i * r + j] = s; S[j * r + i] = s;
  }
  const { values, vectors } = jacobiEigen(S, r);
  const order = Array.from({ length: r }, (_, i) => i).sort((p, q) => values[q] - values[p] || p - q);
  const U = new Float64Array(r * r), s = new Float64Array(r), Vt = new Float64Array(r * d);
  for (let c = 0; c < r; c++) {
    const col = order[c];
    for (let i = 0; i < r; i++) U[i * r + c] = vectors[i * r + col];
    s[c] = Math.sqrt(Math.max(values[col], 0.0));
    if (s[c] > 0) {
      for (let f = 0; f < d; f++) {
        let acc = 0.0;
        for (let i = 0; i < r; i++) acc += U[i * r + c] * B[i * d + f];
        Vt[c * d + f] = acc / s[c];
      }
    }
  }
  return { U, s, Vt };
}

/** sklearn's svd_solver='auto' policy (PCA._fit, scikit-learn 1.7): which solver fit the data. */
export function sklearnPcaSolver(n, d, k) {
  if (d <= 1000 && n >= 10 * d) return "covariance_eigh";
  if (Math.max(n, d) <= 500) return "full";
  if (1 <= k && k < 0.8 * Math.min(n, d)) return "randomized";
  return "full";
}

/**
 * sklearn PCA(n_components=k, svd_solver='randomized', random_state=seed).fit_transform(M), i.e.
 * PCA._fit_truncated + extmath._randomized_svd: n_oversamples 10, n_iter 'auto' (7 if
 * k < 0.1·min(n, d) else 4), power_iteration_normalizer 'auto' → LU, transpose if n < d, final
 * economic QR, SVD of the (k+10) × d projection, svd_flip(u_based_decision=False) on Vt,
 * scores = U[:, :k] * S[:k]. Same return shape as pca(). Float64 throughout (sklearn ran the
 * reference in float32; agreement ~1e-6).
 */
export function pcaRandomized(M, n, d, k, { seed = 42, nOversamples = 10, nIter = "auto", normalizer = "LU" } = {}) {
  k = Math.max(0, Math.min(k | 0, d, n));
  const mean = columnMeans(M, n, d);
  const Xc = new Float64Array(n * d);
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) Xc[i * d + j] = M[i * d + j] - mean[j];
  const nRandom = k + nOversamples;
  if (nIter === "auto") nIter = k < 0.1 * Math.min(n, d) ? 7 : 4;
  if (nRandom > Math.min(n, d)) throw new RangeError(`pcaRandomized: k + oversamples (${nRandom}) exceeds min(n, d) = ${Math.min(n, d)}`);
  const transpose = n < d;
  let A, ar, ac;
  if (transpose) {
    ar = d; ac = n; A = new Float64Array(d * n);
    for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) A[j * n + i] = Xc[i * d + j];
  } else { A = Xc; ar = n; ac = d; }
  const rs = numpyRandomState(seed);
  let Q = rs.normal(ac * nRandom);                                  // random_state.normal(size=(ac, nRandom))
  const norm = normalizer === "LU" ? luPermutedL : normalizer === "QR" ? qrEconomicQ : (x) => x;
  for (let it = 0; it < nIter; it++) {
    Q = norm(matmul(A, ar, ac, Q, nRandom), ar, nRandom);           // A @ Q
    Q = norm(matmulT(A, ar, ac, Q, nRandom), ac, nRandom);          // A.T @ Q
  }
  Q = qrEconomicQ(matmul(A, ar, ac, Q, nRandom), ar, nRandom);      // economic QR of A @ Q (ar × nRandom)
  const B = matmulT(Q, ar, nRandom, A, ac);                         // Q.T @ A (nRandom × ac)
  const { U: Uhat, s, Vt } = svdViaGram(B, nRandom, ac);
  const U = matmul(Q, ar, nRandom, Uhat, nRandom);                  // ar × nRandom
  // returned (U, s, Vt) → first k; transposed problems swap the roles (sklearn: Vt[:k].T, s[:k], U[:, :k].T)
  const Ul = new Float64Array(n * k), Vtr = new Float64Array(k * d);
  if (!transpose) {
    for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) Ul[i * k + c] = U[i * nRandom + c];
    for (let c = 0; c < k; c++) for (let f = 0; f < d; f++) Vtr[c * d + f] = Vt[c * ac + f];
  } else {
    for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) Ul[i * k + c] = Vt[c * ac + i];
    for (let c = 0; c < k; c++) for (let f = 0; f < d; f++) Vtr[c * d + f] = U[f * nRandom + c];
  }
  // svd_flip(U, Vt, u_based_decision=False): sign of the largest-|.| entry of each Vt row
  const scores = new Float64Array(n * k), components = new Float64Array(k * d);
  const explainedVariance = [], explained = [];
  let total = 0.0;
  for (let x = 0; x < n * d; x++) total += Xc[x] * Xc[x];
  total /= n > 1 ? n - 1 : 1;
  for (let c = 0; c < k; c++) {
    let jmax = 0, vmax = -1.0;
    for (let f = 0; f < d; f++) { const av = Math.abs(Vtr[c * d + f]); if (av > vmax) { vmax = av; jmax = f; } }
    const sgn = Math.sign(Vtr[c * d + jmax]);                        // np.sign (0 for an all-zero row, as sklearn)
    for (let f = 0; f < d; f++) components[c * d + f] = sgn * Vtr[c * d + f];
    for (let i = 0; i < n; i++) scores[i * k + c] = sgn * Ul[i * k + c] * s[c];
    const ev = (s[c] * s[c]) / (n > 1 ? n - 1 : 1);
    explainedVariance.push(ev);
    explained.push(total > 0 ? ev / total : 0.0);
  }
  return { scores, explained, explainedRatio: explained, explainedVariance, components, mean, k, solver: "randomized" };
}

// ------------------------------------------------------- cancellation + hooks --

/** The error a cancelled layout run throws (the worker's cancellation, design §5.4): isCancelled(e) recognises it. */
export function cancelError(stage = '') {
  const e = new Error(stage ? `cancelled during ${stage}` : 'cancelled');
  e.name = 'CancelledError';
  e.cancelled = true;
  return e;
}
export const isCancelled = (e) => Boolean(e && e.cancelled === true);

/** The n × d matrix as umap-js / tsne-js want it: an Array of n Arrays of d numbers. */
export function rowsOf(M, n, d) {
  const X = new Array(n);
  for (let i = 0; i < n; i++) X[i] = Array.from(M.subarray(i * d, i * d + d));
  return X;
}

/**
 * Exact k nearest neighbours (euclidean) of every row of M (n × d): {indices: number[n][k], distances: number[n][k]},
 * each row sorted by distance then index (ties by index — deterministic). With includeSelf (default) column 0 is the
 * point itself at distance 0, as umap-learn's exact path (argsort of the distance matrix) and umap-js's own
 * nnDescent both return it; umap-js zeroes the self edge in computeMembershipStrengths. O(n²·d) time, O(n) memory.
 */
export function exactKnn(M, n, d, k, { includeSelf = true } = {}) {
  const kk = Math.max(0, Math.min(k, n));
  const indices = new Array(n), distances = new Array(n);
  const row = new Float64Array(n);
  const need = includeSelf ? Math.max(0, kk - 1) : kk;
  const bi = new Int32Array(need + 1), bd = new Float64Array(need + 1);
  for (let i = 0; i < n; i++) {
    const a = i * d;
    for (let j = 0; j < n; j++) {
      let s = 0.0;
      const b = j * d;
      for (let c = 0; c < d; c++) { const t = M[a + c] - M[b + c]; s += t * t; }
      row[j] = s;
    }
    let m = 0;
    for (let j = 0; j < n; j++) {
      if (j === i && includeSelf) continue;
      const v = row[j];
      if (m === need && (need === 0 || v >= bd[m - 1])) continue;   // not better than the worst kept (ties keep the earlier index)
      let p = m;
      while (p > 0 && bd[p - 1] > v) { bd[p] = bd[p - 1]; bi[p] = bi[p - 1]; p--; }
      bd[p] = v; bi[p] = j;
      if (m < need) m++;
    }
    const idx = new Array(kk), dst = new Array(kk);
    let o = 0;
    if (includeSelf && kk > 0) { idx[0] = i; dst[0] = 0; o = 1; }
    for (let q = 0; q < m && o < kk; q++, o++) { idx[o] = bi[q]; dst[o] = Math.sqrt(bd[q]); }
    indices[i] = idx; distances[i] = dst;
  }
  return { indices, distances };
}

/** The 2-D embedding umap-js / tsne-js return (number[n][2]) → Float64Array n×2. */
function flatten2(E, n) {
  const out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) { out[i * 2] = E[i][0]; out[i * 2 + 1] = E[i][1]; }
  return out;
}

/**
 * The UMAP hook for attachLayouts from the vendored umap-js (its UMAP class: (await import('../vendor/umap-js.esm.js')).default.UMAP):
 * hook(M, n, d, ctx) → Float64Array n×2 (or a Promise of it when ctx.yield is given: one yield per `every` epochs,
 * ctx.cancelled() checked there, ctx.onProgress('umap', epochsDone, nEpochs) called there). Parameters = the desktop's
 * umap-learn call (preprocess.py L651–653): n_components 2, n_neighbors min(15, max(2, n − 1)), min_dist 0.1, spread
 * 1.0, 500 epochs for n ≤ 10,000 (else 200), euclidean; the seed (42) feeds umap-js's one random source (`random`),
 * so two runs are identical. The kNN graph is exact (exactKnn, self first), as umap-learn computes it below 4,096
 * points; umap-js's own NN-descent is bypassed. null for n < 3 (umap-js refuses n ≤ n_neighbors) → the emb fallback.
 * hook.label = 'umap-js' (the status attachLayouts reports — label honesty, design §5.5).
 */
export function makeUmapHook(UMAP, { seed = 42, minDist = 0.1, spread = 1.0, every = 25 } = {}) {
  if (typeof UMAP !== 'function') throw new TypeError('makeUmapHook: UMAP must be the umap-js constructor');
  const hook = function umapHook(M, n, d, ctx = {}) {
    if (n < 3) return null;
    const k = Math.min(15, Math.max(2, n - 1));
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const t0 = now();
    const knn = exactKnn(M, n, d, k);
    const X = rowsOf(M, n, d);
    const umap = new UMAP({ nComponents: 2, nNeighbors: k, minDist, spread, nEpochs: n <= 10000 ? 500 : 200, random: mulberry32(seed) });
    umap.setPrecomputedKNN(knn.indices, knn.distances);
    const nEpochs = umap.initializeFit(X);
    hook.last = { n, k, nEpochs, knnMs: now() - t0 };
    const tick = (e) => {
      if (ctx.cancelled && ctx.cancelled()) throw cancelError('umap');
      if (ctx.onProgress) ctx.onProgress('umap', e, nEpochs);
    };
    if (typeof ctx.yield === 'function') {
      return (async () => {
        for (let e = 0; e < nEpochs; e++) {
          umap.step();
          if ((e + 1) % every === 0 || e === nEpochs - 1) { tick(e + 1); await ctx.yield(); }
        }
        return flatten2(umap.getEmbedding(), n);
      })();
    }
    for (let e = 0; e < nEpochs; e++) { umap.step(); if ((e + 1) % every === 0 || e === nEpochs - 1) tick(e + 1); }
    return flatten2(umap.getEmbedding(), n);
  };
  hook.label = 'umap-js';
  hook.params = { nComponents: 2, nNeighbors: 'min(15, max(2, n-1))', minDist, spread, nEpochs: '500 (n <= 10000) else 200', metric: 'euclidean', seed, knn: 'exact, self first', init: 'umap-js random (umap-learn: spectral)' };
  return hook;
}

/**
 * The t-SNE hook for attachLayouts from the vendored tsne-js (its default export, the TSNE class):
 * hook(M, n, d, ctx) → Float64Array n×2. Parameters = the desktop's sklearn call (preprocess.py L664–666 with
 * sklearn 1.7's defaults): perplexity min(30, max(5, floor(n / 20))), early exaggeration 12, learning rate
 * max(n / 48, 50) (sklearn's 'auto'), 1,000 iterations (ctx.nIter / opts.nIter override), euclidean, init = the
 * sklearn PCA scores (ctx.pcaScores n×k from the pca step, or pca() here) scaled like sklearn's init='pca' (divided
 * by the first column's std, × 1e-4) — written over tsne-js's Gaussian start, so no random draw survives and two
 * runs are identical (tsne-js's Math.random is seeded during init() anyway and restored). tsne-js's run() is one
 * synchronous loop: progress goes through its 'progressIter' event (ctx.onProgress('tsne', iter, nIter) every 10),
 * and ctx.cancelled() is polled there too (a throw aborts the loop) — the ONLY way to stop it; it cannot yield.
 * Cost measured 2026-10-08 (Node 26): ≈ 40 ms × (n / 547)² per iteration. null for n < 4. hook.label = 'tsne-js'.
 * NOTE (cwise, the ndarray compiler inside tsne-js): it decides which identifiers are globals by `name in self` /
 * `name in window`; in a bare Node context neither exists and it mangles Math — set globalThis.self = globalThis
 * before running it in Node (the self-tests do; a Worker and a page have self).
 */
export function makeTsneHook(TSNE, { seed = 42, nIter = 1000, earlyExaggeration = 12 } = {}) {
  if (typeof TSNE !== 'function') throw new TypeError('makeTsneHook: TSNE must be the tsne-js constructor');
  const hook = function tsneHook(M, n, d, ctx = {}) {
    if (n < 4) return null;
    const iters = Math.max(1, Math.floor(Number(ctx.nIter != null ? ctx.nIter : nIter)));
    const perplexity = Math.min(30, Math.max(5, Math.floor(n / 20)));
    const learningRate = Math.max(n / 48, 50);
    const t = new TSNE({ dim: 2, perplexity, earlyExaggeration, learningRate, nIter: iters, metric: 'euclidean' });
    const X = rowsOf(M, n, d);
    const savedRandom = Math.random;
    Math.random = mulberry32(seed);
    try { t.init({ data: X, type: 'dense' }); } finally { Math.random = savedRandom; }
    // sklearn init='pca': X_embedded = PCA(2).fit_transform(X) / std(X_embedded[:, 0]) * 1e-4
    let scores = ctx.pcaScores || null, kk = ctx.pcaK || 0;
    if (!scores || kk < 2) { const P = pca(M, n, d, 2); scores = P.scores; kk = P.k; }
    let mean = 0;
    for (let i = 0; i < n; i++) mean += scores[i * kk];
    mean /= n;
    let sd = 0;
    for (let i = 0; i < n; i++) sd += (scores[i * kk] - mean) ** 2;
    sd = Math.sqrt(sd / n);
    const scale = sd > 0 ? 1e-4 / sd : 1e-4;
    const Y = t.outputEmbedding.data;                            // the ndarray's Float64Array, row-major n × 2
    for (let i = 0; i < n; i++) { Y[i * 2] = scores[i * kk] * scale; Y[i * 2 + 1] = (kk > 1 ? scores[i * kk + 1] : 0) * scale; }
    let iterDone = 0;
    t.on('progressIter', (ev) => {
      iterDone = ev[0] + 1;
      if (ctx.cancelled && (iterDone % 5 === 0) && ctx.cancelled()) throw cancelError('tsne');
      if (ctx.onProgress && (iterDone % 10 === 0 || iterDone === iters)) ctx.onProgress('tsne', iterDone, iters);
    });
    const [error, iter] = t.run();
    hook.last = { n, perplexity, learningRate, nIter: iters, iterations: iter, error };
    return flatten2(t.getOutput(), n);
  };
  hook.label = 'tsne-js';
  hook.params = { perplexity: 'min(30, max(5, floor(n/20)))', earlyExaggeration, learningRate: 'max(n/48, 50)', nIter, metric: 'euclidean', init: 'sklearn PCA scores × 1e-4 / std(col 0)', seed };
  return hook;
}

/** Projected tsne-js wall time (ms) for n sites and nIter iterations, from the 2026-10-08 measurement (40 ms per
 *  iteration + 170 ms of setup at 547 sites, both ∝ n²). */
export function tsneProjectedMs(n, nIter = 1000) {
  const r = (n / 547) * (n / 547);
  return 40 * r * nIter + 170 * r;
}

// ---------------------------------------------------------- attachLayouts --

const noopProgress = () => {};
const never = () => false;

/**
 * The layout steps as a plan both drivers follow (design §5.4: pca → umap → kmeans → tsne → som → gpca; the column
 * insertion order is the parquet's). Each step's run() is synchronous unless a hook returns a Promise under
 * ctx.yield. Shared between attachLayouts (sync) and attachLayoutsAsync.
 */
function layoutPlan(l0, vecs, n, d, opts, ctxBase) {
  const status = { umap: "absent", tsne: "absent", k: 0 };
  const steps = [];
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : noopProgress;
  const cancelled = typeof opts.cancelled === 'function' ? opts.cancelled : never;
  const shared = { pcaScores: null, pcaK: 0 };
  const ctx = { ...ctxBase, onProgress, cancelled, nIter: opts.tsneIters };
  if (vecs && d > 0) {
    const k = n > 1 ? Math.min(8, n - 1, d) : 1;
    status.k = k;
    // PCA solver: 'auto' follows sklearn's svd_solver='auto' policy so the emb_* columns equal the
    // desktop's for any selection (randomized SVD, seed 42, for 500 < n < 10·d; exact otherwise);
    // 'exact' forces the Jacobi PCA, 'randomized' forces the sklearn randomized path.
    let solver = opts.pcaSolver || "auto";
    if (solver === "auto") solver = sklearnPcaSolver(n, d, k);
    if (solver === "randomized" && k + 10 > Math.min(n, d)) solver = "full";
    status.pca = solver;
    steps.push({ name: 'pca', run() {
      const { scores } = solver === "randomized" ? pcaRandomized(vecs, n, d, k, { seed: 42 }) : pca(vecs, n, d, k);
      shared.pcaScores = scores; shared.pcaK = k;
      for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) l0[i]["emb_" + c] = scores[i * k + c];
    } });
    steps.push({ name: 'umap', run() {
      const hook = typeof opts.umap === "function" ? opts.umap : null;          // UMAP hook
      const write = (U) => {
        if (U) {
          for (let i = 0; i < n; i++) { l0[i].umap_x = U[i * 2]; l0[i].umap_y = U[i * 2 + 1]; }
          status.umap = hook.label || "hook";
        } else {
          // preprocess: "umap unavailable — using emb_0/emb_1 as map coords" (emb_1 may not exist)
          for (let i = 0; i < n; i++) { l0[i].umap_x = l0[i].emb_0; l0[i].umap_y = k > 1 ? l0[i].emb_1 : l0[i].emb_0; }
          status.umap = "fallback";
        }
      };
      const U = hook ? hook(vecs, n, d, { ...ctx, pcaScores: shared.pcaScores, pcaK: shared.pcaK }) : null;
      return U && typeof U.then === 'function' ? U.then(write) : write(U);
    } });
    steps.push({ name: 'kmeans', run() {
      const labels = kmeans(vecs, n, d, 6, 42, 10);
      for (let i = 0; i < n; i++) l0[i].km_cluster = labels[i];
    } });
    steps.push({ name: 'tsne', run() {
      const hook = typeof opts.tsne === "function" ? opts.tsne : null;          // t-SNE hook
      const write = (T) => {
        if (T) {
          for (let i = 0; i < n; i++) { l0[i].tsne_x = T[i * 2]; l0[i].tsne_y = T[i * 2 + 1]; }
          status.tsne = hook.label || "hook";
        }
      };
      const T = hook ? hook(vecs, n, d, { ...ctx, pcaScores: shared.pcaScores, pcaK: shared.pcaK }) : null;
      return T && typeof T.then === 'function' ? T.then(write) : write(T);
    } });
    const epochs = somEpochsFor(n, opts.somEpochs);
    status.som = { epochs, grid: [12, 8], capped: epochs !== 60 };
    steps.push({ name: 'som', epochs, run() {
      const S = som(vecs, n, d, 12, 8, epochs, 42, { onEpoch(e, total) { if (cancelled()) throw cancelError('som'); onProgress('som', e, total); } });
      for (let i = 0; i < n; i++) { l0[i].som_x = S[i * 2]; l0[i].som_y = S[i * 2 + 1]; }
    }, async runAsync(yieldNow) {
      const st = somStepper(vecs, n, d, 12, 8, epochs, 42);
      let more = epochs > 0;
      while (more) {
        more = st.step();
        if (cancelled()) throw cancelError('som');
        onProgress('som', st.epoch, epochs);
        await yieldNow();
      }
      const S = st.finish();
      for (let i = 0; i < n; i++) { l0[i].som_x = S[i * 2]; l0[i].som_y = S[i * 2 + 1]; }
    } });
  }
  steps.push({ name: 'gpca', run() {
    const GP = gpca(l0);
    for (let i = 0; i < n; i++) { l0[i].gpca_x = GP[i * 2]; l0[i].gpca_y = GP[i * 2 + 1]; }
    for (let i = 0; i < n; i++) l0[i].position = i;
  } });
  return { status, steps, onProgress, cancelled };
}

/**
 * Mutates the l0 rows of stageSites() adding the layout columns preprocess.py writes:
 *   emb_0..emb_{k-1} (k = min(8, n-1, d)), umap_x/umap_y (hook or emb_0/emb_1 fallback),
 *   km_cluster, [tsne_x/tsne_y only via hook], som_x/som_y, gpca_x/gpca_y, position.
 *   vecs: Float32Array n×d or null (no semantic space → only gpca + position, like preprocess).
 *   opts.umap / opts.tsne: optional hooks (M, n, d, ctx) → Float64Array n×2 | null (makeUmapHook / makeTsneHook, or
 *     any function; a hook's .label names it in the status — 'umap-js' / 'tsne-js' — else 'hook'); a hook that
 *     returns a Promise needs attachLayoutsAsync.
 *   opts.pcaSolver: 'auto' (default: sklearn's svd_solver='auto' policy, see sklearnPcaSolver) |
 *     'exact' (Jacobi PCA) | 'randomized' (sklearn randomized SVD, RandomState(42)).
 *   opts.somEpochs: undefined → 60 (today) | 'auto' → the cap of design §5.4 | a number.
 *   opts.onProgress(stage, done, total): per step, per SOM epoch, per hook tick; opts.cancelled() → true throws a
 *     CancelledError (isCancelled) between steps and inside the SOM / the hooks.
 *   opts.tsneIters: iterations for the t-SNE hook (default the hook's, 1,000).
 * → {umap: 'fallback'|'hook'|<hook.label>|'absent', tsne: 'absent'|'hook'|<hook.label>, k, pca: solver used,
 *    som: {epochs, grid, capped}}
 */
export function attachLayouts(l0, vecs, n, d, opts = {}) {
  n = n == null ? l0.length : n;
  if (n === 0) return { umap: "absent", tsne: "absent", k: 0 };
  const plan = layoutPlan(l0, vecs, n, d, opts, {});
  for (const step of plan.steps) {
    if (plan.cancelled()) throw cancelError(step.name);
    plan.onProgress(step.name, 0, 1);
    const r = step.run();
    if (r && typeof r.then === 'function') throw new Error(`attachLayouts: the ${step.name} hook returned a Promise — use attachLayoutsAsync`);
    plan.onProgress(step.name, 1, 1);
  }
  return plan.status;
}

/**
 * attachLayouts as separately awaited macrotasks (design §5.4): the same columns, bit for bit, but every step —
 * and every SOM epoch, and the UMAP hook every `every` epochs — is followed by `await opts.yield()` (default: a
 * setTimeout(0) turn), so a worker's message queue (a cancel, a newer job) is served in between; opts.cancelled()
 * is checked at each of those points and the run throws a CancelledError. tsne-js cannot yield (one synchronous
 * run()); it polls opts.cancelled() every 5 iterations instead.
 */
export async function attachLayoutsAsync(l0, vecs, n, d, opts = {}) {
  n = n == null ? l0.length : n;
  if (n === 0) return { umap: "absent", tsne: "absent", k: 0 };
  const yieldNow = typeof opts.yield === 'function' ? opts.yield : () => new Promise((r) => setTimeout(r, 0));
  const plan = layoutPlan(l0, vecs, n, d, opts, { yield: yieldNow });
  for (const step of plan.steps) {
    if (plan.cancelled()) throw cancelError(step.name);
    plan.onProgress(step.name, 0, 1);
    if (step.runAsync) await step.runAsync(yieldNow); else await step.run();
    plan.onProgress(step.name, 1, 1);
    await yieldNow();
  }
  return plan.status;
}

// -------------------------------------------------------------------- ARI --

/**
 * Adjusted Rand index between two labelings of the same items (labels may be any comparable
 * values; typed arrays accepted). Matches sklearn.metrics.adjusted_rand_score, including the 1.0
 * special case when the two partitions coincide (no discordant pairs: fp = fn = 0).
 */
export function adjustedRandIndex(a, b) {
  const n = a.length;
  if (n !== b.length) throw new RangeError(`adjustedRandIndex: lengths differ (${n} vs ${b.length})`);
  if (n <= 1) return 1.0;
  const ia = new Map(), ib = new Map();
  const ca = [], cb = [];
  const cont = new Map();
  for (let i = 0; i < n; i++) {
    let x = ia.get(a[i]); if (x === undefined) { x = ia.size; ia.set(a[i], x); ca.push(0); }
    let y = ib.get(b[i]); if (y === undefined) { y = ib.size; ib.set(b[i], y); cb.push(0); }
    ca[x] += 1; cb[y] += 1;
    const key = x * 1048576 + y;
    cont.set(key, (cont.get(key) || 0) + 1);
  }
  const c2 = (m) => m * (m - 1) / 2;
  let sumComb = 0, sumA = 0, sumB = 0;
  for (const v of cont.values()) sumComb += c2(v);
  for (const v of ca) sumA += c2(v);
  for (const v of cb) sumB += c2(v);
  if (sumA === sumComb && sumB === sumComb) return 1.0;      // identical partitions
  const total = c2(n);
  const expected = sumA * sumB / total;
  const maxIndex = (sumA + sumB) / 2;
  return (sumComb - expected) / (maxIndex - expected);
}

export default { pca, pcaRandomized, sklearnPcaSolver, kmeans, kmeansFull, som, somStepper, somEpochsFor, gpca, attachLayouts, attachLayoutsAsync,
  exactKnn, rowsOf, makeUmapHook, makeTsneHook, tsneProjectedMs, cancelError, isCancelled, adjustedRandIndex, mulberry32, mt19937, numpyRandomState };
