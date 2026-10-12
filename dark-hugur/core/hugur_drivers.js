// hugur_drivers.js — the driver production of brain.py (dark_hugur), ported statement by statement.
//
// ES module, pure: no DOM, no Node-only API, no I/O. Used by hugur_brain.js (driver_vec), hugur_vizdata.js
// (the drivers column of sites.json and the FIELDS derivation) and the gates (probe/vizdata_equiv.mjs,
// probe/selftest_brain.mjs). Line references are to brain.py (2026-08-31, 522 lines).
//
//   deriveFields(l0)             brain.py L74–83: FIELDS = sorted field names + the 8-field cap by density
//   driverColumns(fields)        brain.py L84–86: the 15 driver columns, in contract order
//   normalizeDrivers(l0, fields) brain.py L87–90: corpus min-max over ALL sites → drivers[i][c] in 0..1
//   driverVec(drivers_i, sim)    brain.py L112–114: np.round(drivers[i], 4) + [round(sim, 4)]
//
// Two roundings live in brain.py and they are NOT the same function (verified 2026-10-08 on the shipped
// sites.json: numpy's and Python's round differ at 9 of the 8,205 driver cells, and sites.json carries numpy's):
//   np.round(a, 4)   = rint(a * 10000.0) / 10000.0   — rint = round half to even on the DOUBLE PRODUCT
//                      (numpy/core/src/multiarray/calculation.c PyArray_Round; power_of_ten(4) is exact)
//   round(x, 4)      = Python float.__round__: the exact binary value correctly rounded to 4 decimals,
//                      half to even on an EXACT decimal tie (only odd multiples of 1/32 tie at 4 dp), then the
//                      nearest double to that decimal (_Py_dg_dtoa mode 3 + strtod)
// Used by: the 15 drivers → np.round (npRound4); the query sim (driver_vec), the layout coordinates and
// narrative_pos in _gen_viz_data → round(x, 4) (pyRound4 = round4); sims in query_result → round(x, 3) (round3).
// Math.round(x * 1e4) / 1e4 is neither (it rounds half UP), so it is not used anywhere in these modules.

import { pySortedStrings } from './hugur_sites.js';

export const DRIVER_DIM = 16;                          // 8 fields + subj, middle, neg, litotes, experiencer, speech, pos, sim
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

/**
 * brain.py L112–114: `list(np.round(self.drivers[i], 4)) + [round(sim, 4)]` — 16 numbers. `drivers_i` is one
 * site's 15 normalised drivers (un-rounded, or sites.json's already-rounded ones: np.round is idempotent on them).
 */
export function driverVec(driversI, sim = 0.0) {
  const out = new Array(DRIVER_DIM);
  for (let c = 0; c < DRIVER_DIM - 1; c++) out[c] = npRound4(driversI[c]);
  out[DRIVER_DIM - 1] = pyRound4(sim);
  return out;
}

export default { DRIVER_DIM, MAX_FIELDS, EXTRA_COLS, rint, npRound, npRound4, pyRound, pyRound4, pyRound3,
  round4, round3, asFloat, deriveFields, driverColumns, normalizeDrivers, driverVec };
