// hugur_drivers.js — the driver production of brain.py (dark_hugur), ported statement by statement.
//
// ES module, pure: no DOM, no Node-only API, no I/O. Used by hugur_brain.js (driver_vec), hugur_vizdata.js
// (the drivers column of sites.json and the FIELDS derivation) and the gates (probe/vizdata_equiv.mjs,
// probe/selftest_brain.mjs). Line references are to brain.py (2026-08-31, 522 lines).
//
//   deriveFields(l0)             brain.py L74–83: FIELDS = sorted field names + the 8-field cap by density
//   driverColumns(fields)        brain.py L84–86: the 15 driver columns, in contract order
//   normalizeDrivers(l0, fields) brain.py L87–90: corpus min-max over ALL sites → drivers[i][c] in 0..1
//   siteStats(drivers, l0)       brain.py §stats (2026-10-12, L112–132): feel · focus · change per site, corpus min-max
//   driverVec(drivers_i, sim, stats_i)  brain.py L154–156: np.round(drivers[i], 4) + [round(sim, 4)] + np.round(stats[i], 4)
//
// v3 (WEB_PLAN.md §13.1, RUNNER_CONTRACT.md v3, 2026-10-12): the driver vector is 19 floats — 0..7 fields, 8 subj, 9 middle,
// 10 neg, 11 litotes, 12 experiencer, 13 speech, 14 pos, 15 sim (live), 16 feel, 17 focus, 18 change. The three statistics
// are computed ACROSS the eight normalised field drivers d[0..7] of a site (brain.py §stats, 2026-10-12 — mirrored statement
// by statement in siteStats below):
//   feel[i]   = mean(d_i[0..7])                                          (F.mean(axis=1))
//   focus[i]  = population variance of d_i[0..7] = Σ(d − mean)² / 8      (F.var(axis=1), divisor 8)
//   change[i] = (Σ over the neighbours of mean_f |d_i[f] − d_nb[f]|) / k — the neighbours = row i−1 and row i+1 of l0 IN
//               READING ORDER (site_id order), each counted only when its saga is site i's (k = 1 or 2); an end site has
//               its one neighbour, a site alone in its saga 0           (acc / k; 0.0 when k = 0)
//   then each statistic min-max normalised over ALL sites: span = hi − lo > 1e-9 ? hi − lo : 1.0, (x − lo) / span — a
//   constant statistic is 0 everywhere after the centring; on the wire np.round(…, 4) like the 15 drivers (npRound4).
// The 8-element reductions use numpy's pairwise summation order (sum8 below; numpy 1.26.4, verified 2026-10-12).
//
// Two roundings live in brain.py and they are NOT the same function (verified 2026-10-08 on the shipped
// sites.json: numpy's and Python's round differ at 9 of the 8,205 driver cells, and sites.json carries numpy's):
//   np.round(a, 4)   = rint(a * 10000.0) / 10000.0   — rint = round half to even on the DOUBLE PRODUCT
//                      (numpy/core/src/multiarray/calculation.c PyArray_Round; power_of_ten(4) is exact)
//   round(x, 4)      = Python float.__round__: the exact binary value correctly rounded to 4 decimals,
//                      half to even on an EXACT decimal tie (only odd multiples of 1/32 tie at 4 dp), then the
//                      nearest double to that decimal (_Py_dg_dtoa mode 3 + strtod)
// Used by: the 15 drivers and the three statistics (v3) → np.round (npRound4); the query sim (driver_vec), the layout coordinates and
// narrative_pos in _gen_viz_data → round(x, 4) (pyRound4 = round4); sims in query_result → round(x, 3) (round3).
// Math.round(x * 1e4) / 1e4 is neither (it rounds half UP), so it is not used anywhere in these modules.

import { pySortedStrings } from './hugur_sites.js';

export const DRIVER_DIM = 19;                          // 8 fields + subj, middle, neg, litotes, experiencer, speech, pos, sim + feel, focus, change (v3)
export const N_DRIVER_COLS = 15;                       // the normalised columns (brain.py self.drivers' width): slots 0..14
export const SIM_IDX = 15;                             // the live query closeness (driverVec's `sim`, Python round)
export const STAT_IDX = 16;                            // 16 feel · 17 focus · 18 change (siteStats, np.round)
export const STAT_NAMES = Object.freeze(['feel', 'focus', 'change']);
export const ZERO_STATS = Object.freeze([0.0, 0.0, 0.0]);   // the three statistics of an iso (neutral), never a site's
export const MAX_FIELDS = 8;                           // the SC driver contract carries 8 field slots (RUNNER_CONTRACT.md)
export const FIELD_COL_RE = /^field_(.+)_ratio$/;
export const EXTRA_COLS = Object.freeze(['subj_ratio', 'middle_ratio', 'neg_ratio', 'litotes',
  'experiencer_count', 'speech_ratio', 'narrative_pos']);

// ------------------------------------------------------------------ rounding --

/** C rint() in the default rounding mode = numpy's rint ufunc: round half to even, exact for |v| < 2^52. */
export function rint(v) {
  if (!Number.isFinite(v)) return v;
  const f = Math.floor(v);
  const d = v - f;                                     // exact: the fractional part of a double below 2^52
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

/** numpy `np.round(x, n)` for a float64 x: rint(x * 10**n) / 10**n, both operations in double. */
export function npRound(x, n = 4) {
  const p = 10 ** n;                                   // numpy power_of_ten(n): exact for n ≤ 22
  return rint(x * p) / p;
}
export const npRound4 = (x) => npRound(x, 4);

const F64 = new Float64Array(1);
const U64 = new BigUint64Array(F64.buffer);
const MASK52 = (1n << 52n) - 1n;

/** Python `round(x, n)` for a float x and n > 0: correctly rounded on the exact binary value, half to even. */
export function pyRound(x, n) {
  if (!Number.isFinite(x) || x === 0) return x;        // round(nan, n) is nan, round(±inf, n) is ±inf, ±0.0 kept
  F64[0] = x;
  const bits = U64[0];
  const neg = (bits >> 63n) === 1n;
  const expBits = Number((bits >> 52n) & 0x7ffn);
  let m = bits & MASK52;
  let e;
  if (expBits === 0) { e = -1074; } else { m |= 1n << 52n; e = expBits - 1075; }   // |x| = m · 2^e exactly
  const shift = e + n;                                 // |x| · 10^n = m · 5^n · 2^(e+n)
  if (shift >= 0) return x;                            // already an integer at n decimals: nothing to round
  const N = m * 5n ** BigInt(n);
  const k = BigInt(-shift);
  let q = N >> k;                                      // floor(|x| · 10^n)
  const r = N - (q << k);                              // the remainder, in units of 2^-k
  const half = 1n << (k - 1n);
  if (r > half || (r === half && (q & 1n) === 1n)) q += 1n;   // half to even on an EXACT tie
  const v = Number(`${q}e-${n}`);                      // strtod: the nearest double to the decimal q · 10^-n
  return neg ? -v : v;
}
export const pyRound4 = (x) => pyRound(x, 4);
export const pyRound3 = (x) => pyRound(x, 3);
/** The names the design uses: round4 / round3 are Python's round (sim, coordinates, pos; sims). */
export const round4 = pyRound4;
export const round3 = pyRound3;

// ------------------------------------------------------------------- FIELDS --

/** `float(v)` of a parquet cell as pandas' astype(float) sees it: bool → 1/0, int → itself, null → NaN. */
export function asFloat(v) {
  if (v === true) return 1;
  if (v === false) return 0;
  if (v === null || v === undefined) return NaN;
  return Number(v);
}

/**
 * brain.py L74–83. `l0` = array of row objects with the sites_l0 columns (the parquet's columns, all rows alike).
 * Returns { fields, allFields, warning }: `fields` = sorted(names) for every column `field_<name>_ratio`
 * (code-point sort, Python sorted()); if more than 8, the 8 densest (Σ field_f_ratio over all sites), ties
 * keeping alphabetical order (Python's sort is stable, so is Array.prototype.sort), re-sorted alphabetically,
 * and `warning` = brain.py's exact print line (em dash as in the source). `allFields` = before the cap.
 */
export function deriveFields(l0) {
  const names = [];
  const row0 = l0.length ? l0[0] : {};
  for (const c of Object.keys(row0)) {
    const m = FIELD_COL_RE.exec(c);
    if (m) names.push(m[1]);
  }
  const allFields = pySortedStrings(names);
  let fields = allFields;
  let warning = null;
  if (fields.length > MAX_FIELDS) {
    const dens = new Map();
    for (const f of fields) {
      let s = 0;
      const col = `field_${f}_ratio`;
      for (const r of l0) { const v = asFloat(r[col]); if (!Number.isNaN(v)) s += v; }   // pandas sum skips NaN
      dens.set(f, s);
    }
    const byDensity = fields.slice().sort((a, b) => dens.get(b) - dens.get(a));         // stable: ties alphabetical
    fields = pySortedStrings(byDensity.slice(0, MAX_FIELDS));
    warning = `[brain] WARNING: ${allFields.length} fields, SC contract sounds 8 — keeping densest: ${fields.join(', ')}`;
  }
  return { fields, allFields, warning };
}

/** brain.py L84–86: the 15 driver columns, fields first (alphabetical), then the seven grammar/narrative columns. */
export function driverColumns(fields) {
  return fields.map((f) => `field_${f}_ratio`).concat(EXTRA_COLS);
}

/**
 * brain.py L87–90. M = l0[cols].astype(float); lo = min, hi = max over ALL sites (no saga / rej / person filter,
 * once); span = hi − lo > 1e-9 ? hi − lo : 1.0; drivers[i][c] = (M[i][c] − lo[c]) / span[c]. Returns
 * { drivers: number[n][15], lo, hi, span, cols }. Index map (RUNNER_CONTRACT.md): 0..7 fields, 8 subj, 9 middle,
 * 10 neg, 11 litotes, 12 experiencer, 13 speech, 14 narrative_pos; slot 15 (query sim) is added by driverVec.
 */
export function normalizeDrivers(l0, fields) {
  const cols = driverColumns(fields);
  const n = l0.length, d = cols.length;
  const M = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = l0[i], row = new Array(d);
    for (let c = 0; c < d; c++) row[c] = asFloat(r[cols[c]]);
    M[i] = row;
  }
  const lo = new Array(d).fill(Infinity), hi = new Array(d).fill(-Infinity);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < d; c++) {
      const v = M[i][c];
      if (Number.isNaN(v)) { lo[c] = NaN; hi[c] = NaN; continue; }   // numpy min/max propagate NaN
      if (v < lo[c]) lo[c] = v;
      if (v > hi[c]) hi[c] = v;
    }
  }
  const span = new Array(d);
  for (let c = 0; c < d; c++) span[c] = hi[c] - lo[c] > 1e-9 ? hi[c] - lo[c] : 1.0;
  const drivers = new Array(n);
  for (let i = 0; i < n; i++) {
    const row = new Array(d);
    for (let c = 0; c < d; c++) row[c] = (M[i][c] - lo[c]) / span[c];
    drivers[i] = row;
  }
  return { drivers, lo, hi, span, cols };
}

// ------------------------------------------------------ the bed's three statistics (v3) --

/**
 * numpy's pairwise summation of exactly eight doubles (numpy/core/src/umath/loops_utils.h.src `pairwise_sum`, n = 8: the
 * eight accumulators r[0..7] = a[0..7], then ((r0 + r1) + (r2 + r3)) + ((r4 + r5) + (r6 + r7))) — the order in which
 * F.mean(axis=1), F.var(axis=1) and np.abs(v).mean() reduce an 8-vector (numpy 1.26.4, verified 2026-10-12 on this
 * machine: a sequential left-to-right sum differs by an ulp on some inputs, which np.round could carry into the 4th decimal).
 */
export function sum8(a) {
  return ((a[0] + a[1]) + (a[2] + a[3])) + ((a[4] + a[5]) + (a[6] + a[7]));
}

/** brain.py L130–132 on one statistic, in place: lo = St.min, hi = St.max (numpy's min/max propagate NaN), span =
 *  np.where(hi − lo > 1e-9, hi − lo, 1.0), (x − lo) / span — then np.round(…, 4). Returns {lo, hi, span}. */
function minMaxRound4(S) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < S.length; i++) {
    const v = S[i];
    if (Number.isNaN(v)) { lo = NaN; hi = NaN; break; }
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const span = hi - lo > 1e-9 ? hi - lo : 1.0;
  for (let i = 0; i < S.length; i++) S[i] = npRound4((S[i] - lo) / span);
  return { lo, hi, span };
}

/**
 * brain.py §stats (2026-10-12, L112–132), statement by statement. `drivers` = the n × 15 normalised drivers of
 * normalizeDrivers (un-rounded, the desktop's; or a sites.json's rounded 15 — hugur_brain.js's pre-v3 fallback), `l0` =
 * the n rows IN READING ORDER (site_id order) with their `saga` (the l0 table's rows, or sites.json's: both carry it).
 *   F = drivers[:, :8]; feel = F.mean(axis=1); focus = F.var(axis=1)        (population variance, divisor 8)
 *   change[i] = (Σ over the same-saga neighbours i−1, i+1 of float(np.abs(F[i] − F[nb]).mean())) / k  (k = 0 → 0.0)
 *   each min-max normalised over all sites (span ≤ 1e-9 → 1.0: a constant statistic is 0 after the centring)
 * Returns {feel, focus, change} as Float64Arrays over the n sites, normalised and np.round(…, 4) — the values the wire
 * carries (brain.py keeps self.stats un-rounded and rounds in driver_vec; np.round is idempotent on 4-dp values, so
 * driverVec's rounding of these is a no-op) — plus {lo, hi, span} per statistic (feel, focus, change) for the probes.
 */
export function siteStats(drivers, l0) {
  const n = drivers.length;
  if (!Array.isArray(l0) || l0.length !== n) throw new TypeError(`siteStats: l0 has ${l0 ? l0.length : 'no'} rows, drivers ${n}`);
  const sagas = new Array(n);
  for (let i = 0; i < n; i++) sagas[i] = String(l0[i].saga);   // sagas = [str(x) for x in self.l0["saga"]]
  const feel = new Float64Array(n), focus = new Float64Array(n), change = new Float64Array(n);
  const tmp = new Float64Array(8);
  for (let i = 0; i < n; i++) {
    const F = drivers[i];
    const m = sum8(F) / 8;                               // F.mean(axis=1): the pairwise sum / the count
    feel[i] = m;
    for (let c = 0; c < 8; c++) { const d = F[c] - m; tmp[c] = d * d; }   // _var: x = arr − arrmean; x = x * x
    focus[i] = sum8(tmp) / 8;                            // umr_sum(x) / (count − ddof), ddof = 0
  }
  for (let i = 0; i < n; i++) {
    let acc = 0.0, k = 0;
    if (i > 0 && sagas[i - 1] === sagas[i]) {           // if i > 0 and sagas[i − 1] == sagas[i]
      const A = drivers[i], B = drivers[i - 1];
      for (let c = 0; c < 8; c++) tmp[c] = Math.abs(A[c] - B[c]);
      acc += sum8(tmp) / 8; k += 1;                      // acc += float(np.abs(F[i] − F[i − 1]).mean()); k += 1
    }
    if (i + 1 < n && sagas[i + 1] === sagas[i]) {       // if i + 1 < n and sagas[i + 1] == sagas[i]
      const A = drivers[i + 1], B = drivers[i];
      for (let c = 0; c < 8; c++) tmp[c] = Math.abs(A[c] - B[c]);
      acc += sum8(tmp) / 8; k += 1;                      // acc += float(np.abs(F[i + 1] − F[i]).mean()); k += 1
    }
    change[i] = k ? acc / k : 0.0;                       // change[i] = acc / k if k else 0.0
  }
  const lo = new Array(3), hi = new Array(3), span = new Array(3);
  [feel, focus, change].forEach((S, c) => { const r = minMaxRound4(S); lo[c] = r.lo; hi[c] = r.hi; span[c] = r.span; });
  return { feel, focus, change, lo, hi, span };
}

/** The three statistics of site i as driverVec's `stats_i`: [feel, focus, change]. */
export function statsAt(stats, i) {
  return [stats.feel[i], stats.focus[i], stats.change[i]];
}

/**
 * brain.py L154–156: `list(np.round(self.drivers[i], 4)) + [round(sim, 4)] + list(np.round(self.stats[i], 4))` — 19
 * numbers (v3). `drivers_i` is one site's 15 normalised drivers (un-rounded, or sites.json's already-rounded ones:
 * np.round is idempotent on them; a 19-long sites.json row is read on its first 15); `stats_i` = [feel, focus, change]
 * of the site (siteStats / statsAt). Without `stats_i` the three are 0.0 — an iso's neutral, never a site's: vizData
 * and the brain always pass the site's.
 */
export function driverVec(driversI, sim = 0.0, statsI = ZERO_STATS) {
  const out = new Array(DRIVER_DIM);
  for (let c = 0; c < N_DRIVER_COLS; c++) out[c] = npRound4(driversI[c]);
  out[SIM_IDX] = pyRound4(sim);
  for (let c = 0; c < 3; c++) out[STAT_IDX + c] = npRound4(statsI[c]);
  return out;
}

export default { DRIVER_DIM, N_DRIVER_COLS, SIM_IDX, STAT_IDX, STAT_NAMES, ZERO_STATS, MAX_FIELDS, EXTRA_COLS, rint, npRound,
  npRound4, pyRound, pyRound4, pyRound3, round4, round3, asFloat, deriveFields, driverColumns, normalizeDrivers, sum8,
  siteStats, statsAt, driverVec };
