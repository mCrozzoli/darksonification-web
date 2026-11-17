// hugur_query.js — brain.py on_query / _resolve_lemma / _bin_lemmas (dark_hugur), ported for the web.
//
// ES module, pure: no DOM, no Node-only API, no I/O. The tables are built by hugur_brain.js from the files the
// exporter and the build ship (design WEB_P1_DESIGN.md §1.6, §2.6):
//
//   data/space.json          {vocab: {lemma: row}, counts, total_stream, dim}   → vocab (Map lemma → row), dim
//   data/space.vectors.f32   lemma_vectors.npy as raw little-endian float32     → lemmaVecs (rows L2-normalised)
//   data/sites.vectors.f32   site_vectors.npy  as raw little-endian float32     → siteVecs  (rows L2-normalised)
//   data/bin.json            {lowercasedForm: [BÍN lemma candidate, …]} in BÍN order, written by the exporter with
//                            brain.Brain._bin_lemmas on every lower-cased surface form of the corpus plus every
//                            lexicon / keyword lemma — the static stand-in for the live BÍN tokenizer (§2.6.2)
//
// Line references are to brain.py (2026-08-31). Arithmetic note: brain.py normalises float32 matrices in numpy
// and takes the dot products with BLAS sgemv (float32, accumulation order unknowable); here everything after the
// float32 input is float64. The gate (design §5.2) therefore compares query-derived numbers at |Δ| ≤ 1.5e-3 and
// `top` as a set where sims tie; everything else (which sites hit, the 1.0 / 0.3 / 0.0 surface values, the no-hit
// payload, the lemma chosen) is exact.

import { pySortedStrings } from './hugur_sites.js';

/**
 * brain.py L103 / L108: `V / (np.linalg.norm(V, axis=1, keepdims=True) + 1e-9)`.
 * `f32` is the raw float32 matrix (Float32Array or ArrayBuffer), `n` rows × `dim`; returns a Float64Array.
 * A zero row (a window without any vocabulary lemma) stays a zero row, as in numpy.
 */
export function normalizeRows(f32, n, dim) {
  const V = f32 instanceof Float32Array ? f32 : new Float32Array(f32);
  if (V.length !== n * dim) throw new RangeError(`normalizeRows: ${V.length} floats is not ${n} × ${dim}`);
  const out = new Float64Array(n * dim);
  for (let r = 0; r < n; r++) {
    const o = r * dim;
    let ss = 0;
    for (let k = 0; k < dim; k++) ss += V[o + k] * V[o + k];
    const inv = 1 / (Math.sqrt(ss) + 1e-9);
    for (let k = 0; k < dim; k++) out[o + k] = V[o + k] * inv;
  }
  return out;
}

/** space.json's `vocab` object (or a Map) → Map lemma → row. */
export function vocabMap(vocab) {
  if (vocab instanceof Map) return vocab;
  const m = new Map();
  if (vocab) for (const k of Object.keys(vocab)) m.set(k, vocab[k]);
  return m;
}

/** One lemma's unit vector (a Float64Array view) from the normalised matrix. */
export function rowOf(mat, row, dim) {
  return mat.subarray(row * dim, row * dim + dim);
}

// The BÍN tokenizer's word boundaries, approximated for the static table (checked against reynir.bintokenizer.tokenize
// on 2026-10-08): whitespace separates tokens; punctuation is a token of its own, at the edges of a word ('gráta,'
// '„gráta“' '(gráta)' → gráta) and inside it ('gráta/hlæja' 'gráta;hlæja' 'hlæja—gráta' → two words) — except the
// hyphen, which BÍN keeps inside a compound ('gráta-hlæja' is ONE token, a compound the table never holds, so it
// resolves nothing on the desktop either). A punctuation token's own BÍN entry is the mark itself (brain.py's
// _bin_lemmas('gráta,') is ['gráta', ',']): never a keyword lemma, never in vocab, so dropping them changes no result.
const EDGE_PUNCT = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;   // leading / trailing runs of non-letter, non-digit characters
const INNER_PUNCT = /[^\p{L}\p{N}-]+/u;                   // a run of punctuation inside a part (the hyphen excepted)

/** The word tokens the BÍN tokenizer would yield for `word` (already lower-cased by the caller), in order. */
export function binTokens(word) {
  const out = [];
  for (const raw of String(word).split(/\s+/)) {
    for (const piece of raw.split(INNER_PUNCT)) {
      const p = piece.replace(EDGE_PUNCT, '');
      if (p) out.push(p);
    }
  }
  return out;
}

/**
 * brain.py L419–438 `_bin_lemmas(word)` over the static table: the ordered, de-duplicated list of lower-cased BÍN
 * stems for every token the BÍN tokenizer yields for the input. `bin` = the bin.json object (or a Map). The table
 * holds single forms: the exact key first; on a miss the input is tokenised as BÍN would (binTokens: whitespace,
 * edge and inner punctuation dropped, the hyphen kept) and the parts' lists are concatenated in part order, each in
 * its table (= BÍN) order, de-duplicated. `[]` when no part is known to the table (= BÍN unavailable, or an
 * inflection the corpus never uses — design §2.6.3) or when `bin` is null. The caller keeps testing the ORIGINAL
 * word against window_text (brain.py's str.contains(word)): only the lemma lookup is tokenised, as on the desktop.
 */
export function binLemmas(word, bin) {
  if (!bin) return [];
  const get = bin instanceof Map ? (k) => bin.get(k) : (k) => (Object.prototype.hasOwnProperty.call(bin, k) ? bin[k] : undefined);
  const direct = get(word);
  if (Array.isArray(direct)) return direct.slice();
  const whole = get(word.replace(EDGE_PUNCT, ''));          // a phrase key ('alla vega') typed with edge punctuation: reynir keeps the phrase as ONE token
  if (Array.isArray(whole)) return whole.slice();
  const out = [];
  for (const p of binTokens(word)) {
    const c = get(p);
    if (!Array.isArray(c)) continue;
    for (const stem of c) if (!out.includes(stem)) out.push(stem);
  }
  return out;
}

/**
 * brain.py L440–459 `_resolve_lemma(word)`: the word itself if in vocab, else the FIRST BÍN candidate (in BÍN
 * order) that is in vocab, else nothing. `tables` = { vocab (Map), lemmaVecs (Float64Array, normalised), dim, bin }.
 * Returns { lemma, vec } with `vec` a Float64Array view, or { lemma: null, vec: null }.
 */
export function resolveLemma(word, tables) {
  const { vocab, lemmaVecs, dim, bin } = tables;
  if (vocab && lemmaVecs && vocab.has(word)) return { lemma: word, vec: rowOf(lemmaVecs, vocab.get(word), dim) };
  if (vocab && lemmaVecs) {
    for (const stem of binLemmas(word, bin)) {        // BÍN order is load-bearing: the first in vocab wins
      if (vocab.has(stem)) return { lemma: stem, vec: rowOf(lemmaVecs, vocab.get(stem), dim) };
    }
  }
  return { lemma: null, vec: null };
}

/** brain.py L385: `self.site_vecs @ vec` — one cosine per site (unit rows · unit vector), float64. */
export function siteSims(siteVecs, nSites, dim, vec) {
  const out = new Float64Array(nSites);
  for (let r = 0; r < nSites; r++) {
    const o = r * dim;
    let s = 0;
    for (let k = 0; k < dim; k++) s += siteVecs[o + k] * vec[k];
    out[r] = s;
  }
  return out;
}

/** brain.py L386–389: cosine → (c + 1) / 2 clipped to 0..1, then the per-query min-max stretch (if hi − lo > 1e-9). */
export function stretchSims(sims) {
  const n = sims.length;
  const out = new Float64Array(n);
  for (let r = 0; r < n; r++) {
    const v = (sims[r] + 1) / 2;
    out[r] = v < 0 ? 0 : v > 1 ? 1 : v;
  }
  let lo = Infinity, hi = -Infinity;
  for (let r = 0; r < n; r++) { if (out[r] < lo) lo = out[r]; if (out[r] > hi) hi = out[r]; }
  if (hi - lo > 1e-9) for (let r = 0; r < n; r++) out[r] = (out[r] - lo) / (hi - lo);
  return out;
}

/**
 * brain.py L412: `list(map(int, np.argsort(-sims, kind="stable")[:10]))` — `kind="stable"` since 2026-10-08 (the
 * web lead's one edit to brain.py): numpy's default introsort put tied sims in an implementation-defined order, so
 * a text-only query such as 'tár' (every hit 0.3) landed the two brains on different sites. This is exactly that
 * order: sim descending, ties by index ascending — `top` compares as a LIST between the two brains.
 */
export function argTop(sims, k = 10) {
  const idx = new Array(sims.length);
  for (let r = 0; r < sims.length; r++) idx[r] = r;
  idx.sort((a, b) => (sims[b] - sims[a]) || (a - b));
  return idx.slice(0, k);
}

/**
 * The semantic spread γ (P2, design WEB_P2_DESIGN.md §4): q = z ** γ on the STRETCHED sims — monotone, 0 → 0,
 * 1 → 1, so `top`, the argmax and simMax (= max z = 1 after a stretch) are γ-invariant; γ = 1 returns `z` itself
 * (no pow: bit-identical to the knob-less brain). The reference form of the brain's _spreadSims: the brain keeps z
 * (its `query_z`) and re-derives q when γ moves; runQuery never applies it.
 */
export function applySpread(z, gamma = 1) {
  const g = Number(gamma);
  if (!Number.isFinite(g) || g <= 0) throw new RangeError(`applySpread: gamma must be a positive number (got ${JSON.stringify(gamma)})`);
  if (g === 1) return z;
  const q = new Float64Array(z.length);
  for (let k = 0; k < z.length; k++) q[k] = Math.pow(z[k], g);
  return q;
}

/**
 * The vocabulary floor as a vocab filter (design §4): the lemmas of `vocab` (Map lemma → row, or space.json's
 * object) whose `counts[lemma] ≥ minCount`, row indices unchanged — the same rule as hugur_sites.loadSpace's
 * minCount, for a brain that holds the full table (rebuild(…, {vocab}) takes the result). minCount ≤ 0 → a copy.
 */
export function vocabFloor(vocab, counts, minCount = 0) {
  const src = vocabMap(vocab);
  const out = new Map();
  const c = counts || {};
  for (const [w, row] of src) if (minCount <= 0 || (c[w] === undefined ? 0 : c[w]) >= minCount) out.set(w, row);
  return out;
}

/**
 * brain.py L378–417 `on_query`, the computation only (the state change, the OSC and the payload are the brain's).
 * `word` is already `str(args[0]).strip().lower()` and non-empty. `tables` = { vocab, lemmaVecs, dim, bin,
 * siteVecs (normalised Float64Array or null), nSites, lemma (string[] keyword_lemma per site), textLower
 * (string[] window_text.lower() per site) }. Knows no γ: the brain owns the semantic spread (it stores `z` and
 * applies its own _spreadSims, as brain.py does).
 *
 * Returns { hit: false, word } for the no-hit surface case (brain.py L399–402: payload without 'surface', no
 * query_sims change, no SC), else { hit: true, word, lemma, sims, z (the same Float64Array: the stretched cosines,
 * or the 1 / 0.3 / 0 surface values), top (int[] ≤ 10, from z), surface, simMax (max z) }.
 */
export function runQuery(word, tables) {
  const { siteVecs, nSites, dim, lemma: siteLemma, textLower } = tables;
  const { lemma: resolved, vec } = resolveLemma(word, tables);
  let lemma = resolved, sims, surface = false;
  if (vec !== null && siteVecs) {
    sims = stretchSims(siteSims(siteVecs, nSites, dim, vec));
  } else {
    // too rare for the embedding vocab — keyword/surface matching against ALL BÍN candidates of the form
    const cands = new Set(binLemmas(word, tables.bin));
    cands.add(word);
    const kw = new Uint8Array(nSites), txt = new Uint8Array(nSites);
    let any = false;
    for (let i = 0; i < nSites; i++) {
      kw[i] = cands.has(siteLemma[i]) ? 1 : 0;
      txt[i] = textLower[i].includes(word) ? 1 : 0;      // str.contains(word, regex=False): a plain substring
      if (kw[i] || txt[i]) any = true;
    }
    if (!any) return { hit: false, word };
    sims = new Float64Array(nSites);
    const hitLemmas = new Set();
    for (let i = 0; i < nSites; i++) {
      sims[i] = kw[i] ? 1.0 : txt[i] ? 0.3 : 0.0;       // sites OF the word = 1.0; windows merely CONTAINING it = 0.3
      if (kw[i]) hitLemmas.add(siteLemma[i]);
    }
    lemma = hitLemmas.has(word) ? word : hitLemmas.size ? pySortedStrings(hitLemmas)[0] : word;
    surface = true;
  }
  let simMax = -Infinity;
  for (let i = 0; i < sims.length; i++) if (sims[i] > simMax) simMax = sims[i];
  const z = sims;
  return { hit: true, word, lemma, sims: z, z, top: argTop(z, 10), surface, simMax };
}

export default { normalizeRows, vocabMap, rowOf, binTokens, binLemmas, resolveLemma, siteSims, stretchSims, argTop, runQuery, applySpread, vocabFloor };
