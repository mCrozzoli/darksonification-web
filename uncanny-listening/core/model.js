// Uncanny Listening — the "pedal" model (brief §3.4): a transparent classifier trained on the researcher's current labels.
//   features  her summary columns, z-scored over the songs (a constant column → 0), each family multiplied by its knob's gain
//             (0 = the family is off). With the L2 penalty, a larger gain lets a family count more.
//   model     regularised logistic regression: binary for 2 classes, multinomial (softmax) for more; loss
//             C · Σ −log p(yᵢ | xᵢ) + ½ ‖W‖² (sklearn's form, intercepts not penalised), fitted by L-BFGS.
//   readouts  probabilities per song (fitted on every song) and per 10 s segment (the song model on the segment's own
//             summary columns, scaled with the songs' mean and std), accuracy, 5-fold stratified cross-validated accuracy
//             (seeded, so the same knobs give the same number), the confusion matrix, the weight of each family.
// Pure functions; core/model_worker.js runs them off the page.

export function zscore(rows) {                                      // → {Z, mean, std}
  const n = rows.length, d = rows[0].length, mu = new Float64Array(d), sd = new Float64Array(d);
  for (const r of rows) for (let j = 0; j < d; j++) mu[j] += r[j] / n;
  for (const r of rows) for (let j = 0; j < d; j++) sd[j] += (r[j] - mu[j]) ** 2 / n;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]);
  return { mean: mu, std: sd, Z: rows.map((r) => apply(r, mu, sd)) };
}
const apply = (r, mu, sd, g = null) => Float64Array.from(r, (v, j) => (sd[j] > 1e-12 ? (v - mu[j]) / sd[j] : 0) * (g ? g[j] : 1));

// ------------------------------------------------------------------ L-BFGS (two-loop recursion, Armijo backtracking)
function lbfgs(f, x0, { m = 10, maxIter = 300, tol = 1e-6 } = {}) {
  let x = Float64Array.from(x0), [fx, g] = f(x); const S = [], Y = [], n = x.length;
  const dot = (a, b) => { let s = 0; for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; };
  for (let it = 0; it < maxIter; it++) {
    let gn = 0; for (let i = 0; i < n; i++) gn = Math.max(gn, Math.abs(g[i])); if (gn < tol) break;
    const q = Float64Array.from(g), al = [];
    for (let k = S.length - 1; k >= 0; k--) { const r = 1 / dot(Y[k], S[k]), a = r * dot(S[k], q); al[k] = a; for (let i = 0; i < n; i++) q[i] -= a * Y[k][i]; }
    if (S.length) { const k = S.length - 1, gam = dot(S[k], Y[k]) / dot(Y[k], Y[k]); for (let i = 0; i < n; i++) q[i] *= gam; }
    for (let k = 0; k < S.length; k++) { const r = 1 / dot(Y[k], S[k]), b = r * dot(Y[k], q); for (let i = 0; i < n; i++) q[i] += S[k][i] * (al[k] - b); }
    for (let i = 0; i < n; i++) q[i] = -q[i];
    let gd = dot(g, q); if (gd >= 0) { for (let i = 0; i < n; i++) q[i] = -g[i]; gd = dot(g, q); }
    let step = 1, xn, fn, gnw;
    for (let ls = 0; ls < 40; ls++) { xn = Float64Array.from(x, (v, i) => v + step * q[i]); [fn, gnw] = f(xn); if (fn <= fx + 1e-4 * step * gd) break; step *= 0.5; }
    const s = Float64Array.from(xn, (v, i) => v - x[i]), y = Float64Array.from(gnw, (v, i) => v - g[i]);
    if (dot(s, y) > 1e-12) { S.push(s); Y.push(y); if (S.length > m) { S.shift(); Y.shift(); } }
    const df = Math.abs(fx - fn); x = xn; fx = fn; g = gnw;
    if (df < 1e-12 * Math.max(1, Math.abs(fx))) break;
  }
  return x;
}

// ------------------------------------------------------------------ fit / predict on prepared rows (already gained)
export function fit(X, y, K, C = 1) {
  const n = X.length, d = X[0].length, P = K === 2 ? 1 : K, np = P * (d + 1);   // per output: d weights + intercept
  const f = (w) => {
    let loss = 0; const g = new Float64Array(np);
    for (let p = 0; p < P; p++) for (let j = 0; j < d; j++) { const v = w[p * (d + 1) + j]; loss += 0.5 * v * v; g[p * (d + 1) + j] = v; }
    const z = new Float64Array(P);
    for (let i = 0; i < n; i++) {
      const x = X[i];
      for (let p = 0; p < P; p++) { const o = p * (d + 1); let s = w[o + d]; for (let j = 0; j < d; j++) s += w[o + j] * x[j]; z[p] = s; }
      if (K === 2) {
        const t = y[i] === 1 ? 1 : 0, s = z[0], pr = 1 / (1 + Math.exp(-s));
        loss += C * (s > 0 ? Math.log1p(Math.exp(-s)) + (1 - t) * s : Math.log1p(Math.exp(s)) - t * s);
        const e = C * (pr - t); for (let j = 0; j < d; j++) g[j] += e * x[j]; g[d] += e;
      } else {
        let mx = -Infinity; for (let p = 0; p < P; p++) mx = Math.max(mx, z[p]);
        let se = 0; for (let p = 0; p < P; p++) se += Math.exp(z[p] - mx);
        loss += C * (mx + Math.log(se) - z[y[i]]);
        for (let p = 0; p < P; p++) { const e = C * (Math.exp(z[p] - mx) / se - (p === y[i] ? 1 : 0)), o = p * (d + 1); for (let j = 0; j < d; j++) g[o + j] += e * x[j]; g[o + d] += e; }
      }
    }
    return [loss, g];
  };
  return { K, d, w: lbfgs(f, new Float64Array(np)) };
}
export function predict(M, x) {                                      // → Float64Array(K) probabilities
  const { K, d, w } = M, P = K === 2 ? 1 : K, z = new Float64Array(P);
  for (let p = 0; p < P; p++) { const o = p * (d + 1); let s = w[o + d]; for (let j = 0; j < d; j++) s += w[o + j] * x[j]; z[p] = s; }
  if (K === 2) { const p1 = 1 / (1 + Math.exp(-z[0])); return Float64Array.of(1 - p1, p1); }
  let mx = -Infinity; for (const v of z) mx = Math.max(mx, v); let se = 0; for (const v of z) se += Math.exp(v - mx);
  return Float64Array.from(z, (v) => Math.exp(v - mx) / se);
}
const decide = (p, thr) => p.length === 2 ? (p[1] >= thr ? 1 : 0) : p.indexOf(Math.max(...p));

function folds(y, k, seed = 42) {                                   // stratified, seeded: each class shuffled, dealt round-robin
  let s = seed >>> 0 || 1; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const f = new Int32Array(y.length), by = new Map();
  y.forEach((c, i) => { if (!by.has(c)) by.set(c, []); by.get(c).push(i); });
  let off = 0;
  for (const c of [...by.keys()].sort((a, b) => a - b)) { const idx = by.get(c);
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    idx.forEach((v, i) => { f[v] = (i + off) % k; }); off += idx.length; }
  return f;
}

// The whole readout for one knob setting.
// rows: song feature rows (raw), y: label index per song, K classes, cols: column names, fam: family per column,
// gains: {family: gain}, C, thr (2 classes), segs: [{song, row}] (raw segment rows) → result
export function run({ rows, y, K, cols, fam, gains, C = 1, thr = 0.5, segs = [], nFolds = 5 }) {
  const t0 = performance.now(), { mean, std } = zscore(rows), g = Float64Array.from(cols, (c, j) => gains[fam[j]] ?? 1);
  const X = rows.map((r) => apply(r, mean, std, g)), active = g.some((v) => v > 0);
  const M = fit(X, y, K, C), prob = X.map((x) => predict(M, x)), pred = prob.map((p) => decide(p, thr));
  const conf = Array.from({ length: K }, () => new Int32Array(K)); let acc = 0;
  y.forEach((c, i) => { conf[c][pred[i]]++; if (c === pred[i]) acc++; });
  // cross-validated accuracy (and each song's out-of-fold probability)
  const F = folds(y, Math.min(nFolds, Math.min(...Array.from({ length: K }, (_, c) => y.filter((v) => v === c).length)) || 2)), oof = new Array(X.length); let cvOk = 0;
  const nf = Math.max(...F) + 1;
  for (let k = 0; k < nf; k++) {
    const tr = [], te = []; F.forEach((f, i) => (f === k ? te : tr).push(i));
    if (!te.length || !tr.length) continue;
    const zs = zscore(tr.map((i) => rows[i])), Xt = tr.map((i) => apply(rows[i], zs.mean, zs.std, g)), Mk = fit(Xt, tr.map((i) => y[i]), K, C);
    for (const i of te) { const p = predict(Mk, apply(rows[i], zs.mean, zs.std, g)); oof[i] = Array.from(p); if (decide(p, thr) === y[i]) cvOk++; }
  }
  // the weight of each family: the norm of its coefficients in the gained space (what the model leans on)
  const famW = {}, P = K === 2 ? 1 : K;
  cols.forEach((c, j) => { let s = 0; for (let p = 0; p < P; p++) s += (M.w[p * (M.d + 1) + j] * g[j]) ** 2; famW[fam[j]] = (famW[fam[j]] || 0) + s; });
  for (const k in famW) famW[k] = Math.sqrt(famW[k]);
  const coef = cols.map((c, j) => ({ col: c, fam: fam[j], w: Array.from({ length: P }, (_, p) => M.w[p * (M.d + 1) + j] * g[j]) }));
  const segProb = segs.map((r) => Array.from(predict(M, apply(r, mean, std, g))));
  return { K, active, prob: prob.map((p) => Array.from(p)), pred, acc: acc / y.length, cv: cvOk / y.length, folds: nf, oof, conf: conf.map((r) => Array.from(r)),
           famW, coef, segProb, segPred: segProb.map((p) => decide(p, thr)), ms: performance.now() - t0 };
}

// The probability field on a 2-D map: a Gaussian-kernel (Nadaraya–Watson) average of the songs' probabilities at each grid
// point of the map, and the kernel density, so the field fades where there are no songs. pts: [[x, y] ∈ [0, 1]²], p: values.
export function field(pts, p, { nx = 48, ny = 48, h = 0.07, lo = -0.03, hi = 1.03 } = {}) {
  const out = new Float32Array(nx * ny), dens = new Float32Array(nx * ny), i2 = 1 / (2 * h * h);
  let dmax = 0;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const gx = lo + (hi - lo) * (i + 0.5) / nx, gy = lo + (hi - lo) * (j + 0.5) / ny; let e0 = Infinity;
    for (let k = 0; k < pts.length; k++) e0 = Math.min(e0, ((pts[k][0] - gx) ** 2 + (pts[k][1] - gy) ** 2) * i2);
    let sw = 0, sp = 0;                                             // weights relative to the nearest song: no underflow far from the songs
    for (let k = 0; k < pts.length; k++) { const w = Math.exp(e0 - ((pts[k][0] - gx) ** 2 + (pts[k][1] - gy) ** 2) * i2); sw += w; sp += w * p[k]; }
    out[j * nx + i] = sp / sw; const dn = sw * Math.exp(-e0); dens[j * nx + i] = dn; if (dn > dmax) dmax = dn;
  }
  for (let k = 0; k < dens.length; k++) dens[k] /= dmax || 1;
  return { nx, ny, p: out, dens };
}
