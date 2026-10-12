// hugur_sites.js — faithful JavaScript port of preprocess.py stage_sites (dark_hugur).
//
// ES module. Works in Node ≥ 18 and in a browser (main thread or a Web Worker): no DOM,
// no Node-only API inside any exported function. Pure functions over the JSON shapes of
// web_implementation/data/ (see build/CORE_README.md and the data contract):
//
//   tokens:    {saga, n, cols: {text, kind, lemmas, lemma, cats, is_verb, case, mood, voice,
//               impersonal, in_quote, person, syl, sent_idx, idx, chapter}}   (column arrays)
//   sentences: {saga, rows: [[chapter, sent_idx, parsed, terms|null], ...]}
//   lexicon:   {fields: [{lemma, field, weight, notes}, ...], experiencer: [lemma, ...]}
//   space:     {vocab, counts, total_stream, dim, vectors: Float32Array} | null
//
// Every statement below mirrors a statement of preprocess.py (line references are to the
// 2026-10-08 file). Where Python and JavaScript semantics could differ (float32 arithmetic,
// numpy's pairwise summation, CPython set iteration order, `\s`, `str.lower`) the Python
// behaviour is emulated and the emulation is documented at the point of use. Known,
// unavoidable departures are listed under "DEPARTURES" at the bottom of this file.

// --------------------------------------------------------------- constants --
// preprocess.py lines 50–57
export const QUOTE_CHARS = new Set(['"', '“', '”', '„', '«', '»']);
export const NEG_LEMMAS = new Set(['eigi', 'ekki', 'aldrei', 'hvorki', 'né', 'engi', 'enginn', 'ei']);
// surface datives only; 'því' and 'sér' removed after review (see preprocess.py comment)
export const DAT_PRONOUNS = new Set(['mér', 'þér', 'honum', 'henni', 'oss', 'yður', 'þeim', 'okkur', 'ykkur', 'hánum']);
export const SIF_A = 1e-3;
export const DEFAULT_WINDOW = 25;

// ---------------------------------------------------------- python helpers --

/** Python `sorted()` on str: compares by Unicode code point (JS default sort compares UTF-16
 *  code units, which differs only for astral characters — none in the sagas, but be exact). */
export function pyStrCompare(a, b) {
  const la = a.length, lb = b.length;
  let i = 0, j = 0;
  while (i < la && j < lb) {
    const ca = a.codePointAt(i), cb = b.codePointAt(j);
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  return (la - i) - (lb - j) < 0 ? -1 : (la - i) - (lb - j) > 0 ? 1 : 0;
}

export function pySortedStrings(iterable) {
  return Array.from(iterable).sort(pyStrCompare);
}

/** Python `str.strip()` (whitespace per str.isspace) — see PY_SPACE_CLASS. */
const PY_SPACE_CLASS = '\\t\\n\\x0b\\x0c\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_STRIP_RE = new RegExp(`^[${PY_SPACE_CLASS}]+|[${PY_SPACE_CLASS}]+$`, 'g');
export function pyStrip(s) {
  return String(s).replace(PY_STRIP_RE, '');
}

/** Python `str(x)` for the JSON scalars that can appear in a `terms` pair. Strings pass
 *  through; None → 'None', True/False → 'True'/'False' (JS would give 'null'/'true'/'false'). */
export function pyStr(x) {
  if (typeof x === 'string') return x;
  if (x === null || x === undefined) return 'None';
  if (x === true) return 'True';
  if (x === false) return 'False';
  return String(x); // numbers: Python repr differs for floats ('1.0' vs '1') — never a str lemma
}

/** Python `str.lower()`. JS toLowerCase() implements the same Unicode full lowercase mapping
 *  (incl. final sigma); kept as a named helper so any future divergence is one edit. */
export function pyLower(s) {
  return s.toLowerCase();
}

/**
 * numpy 1.26 `np.mean(list_of_float64)` = pairwise summation (numpy/core/src/umath/loops_utils.h.src
 * pairwise_sum_DOUBLE: n < 8 sequential; n <= 128 eight-way unrolled partial sums combined as
 * ((r0+r1)+(r2+r3))+((r4+r5)+(r6+r7)) then the remainder sequentially; larger n split in two with
 * the left half rounded down to a multiple of 8) divided by n. Bit-identical to numpy.
 */
export function npPairwiseSum(a, lo = 0, n = a.length) {
  if (n < 8) {
    let res = 0.0;
    for (let i = 0; i < n; i++) res += a[lo + i];
    return res;
  } else if (n <= 128) {
    const r = [a[lo], a[lo + 1], a[lo + 2], a[lo + 3], a[lo + 4], a[lo + 5], a[lo + 6], a[lo + 7]];
    let i = 8;
    const stop = n - (n % 8);
    for (; i < stop; i += 8) {
      r[0] += a[lo + i]; r[1] += a[lo + i + 1]; r[2] += a[lo + i + 2]; r[3] += a[lo + i + 3];
      r[4] += a[lo + i + 4]; r[5] += a[lo + i + 5]; r[6] += a[lo + i + 6]; r[7] += a[lo + i + 7];
    }
    let res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
    for (; i < n; i++) res += a[lo + i];
    return res;
  } else {
    let n2 = Math.floor(n / 2);
    n2 -= n2 % 8;
    return npPairwiseSum(a, lo, n2) + npPairwiseSum(a, lo + n2, n - n2);
  }
}

export function npMean(a) {
  return npPairwiseSum(a, 0, a.length) / a.length;
}

/**
 * CPython 3.12 `set` iteration order for small non-negative ints (hash(n) == n), built by
 * inserting `values` in order (duplicates ignored, no deletions). Emulates Objects/setobject.c:
 * table of 8 slots, linear probes of 9 after the home slot when i + 9 <= mask, then
 * i = i*5 + 1 + (perturb >>= 5); resize to the smallest power of two > used*4 once
 * fill*5 >= mask*3, re-inserting in old slot order. Iteration = slot order.
 * Only matters for the floating-point order of `confs` in parse_conf (preprocess.py 575–578);
 * with boolean `parsed` values every order gives the same exact mean. Values ≥ 2^30 fall back to
 * ascending order (documented departure: hash wrap-around is not emulated).
 */
export function cpySetOrderInts(values) {
  const LINEAR_PROBES = 9, PERTURB_SHIFT = 5;
  const vals = Array.from(values);
  if (vals.some((v) => !Number.isInteger(v) || v < 0 || v >= 2 ** 30)) {
    return Array.from(new Set(vals)).sort((a, b) => a - b);
  }
  let size = 8, table = new Array(size).fill(null), fill = 0, used = 0;
  const present = new Set();
  const insertClean = (tbl, mask, key) => {           // set_insert_clean
    let perturb = key, i = key & mask;
    for (;;) {
      if (tbl[i] === null) { tbl[i] = key; return; }
      if (i + LINEAR_PROBES <= mask) {
        for (let j = 1; j <= LINEAR_PROBES; j++) {
          if (tbl[i + j] === null) { tbl[i + j] = key; return; }
        }
      }
      perturb = Math.floor(perturb / (1 << PERTURB_SHIFT));
      i = (i * 5 + 1 + perturb) % (mask + 1);
    }
  };
  for (const key of vals) {
    if (present.has(key)) continue;                   // found_active: nothing to do
    present.add(key);
    const mask = size - 1;
    let perturb = key, i = key & mask, slot = -1;
    outer: for (;;) {                                 // set_add_entry probing
      const probes = (i + LINEAR_PROBES <= mask) ? LINEAR_PROBES : 0;
      for (let p = 0; p <= probes; p++) {
        if (table[i + p] === null) { slot = i + p; break outer; }
      }
      perturb = Math.floor(perturb / (1 << PERTURB_SHIFT));
      i = (i * 5 + 1 + perturb) % (mask + 1);
    }
    table[slot] = key;
    fill++; used++;
    if (fill * 5 >= mask * 3) {                        // set_table_resize(so, used*4)
      const minused = used > 50000 ? used * 2 : used * 4;
      let newsize = 8;
      while (newsize <= minused) newsize <<= 1;
      const old = table;
      table = new Array(newsize).fill(null);
      size = newsize;
      for (const k of old) if (k !== null) insertClean(table, newsize - 1, k);
      fill = used;
    }
  }
  return table.filter((k) => k !== null);
}

// ---------------------------------------------------------------- lexicon --

/**
 * preprocess.py load_lexicon (lines 70–78) on the exported lexicon.json.
 * fieldsMap: Map lemma → {field, weight, rank}; fieldNames: sorted unique fields; exper: Set.
 * rank = position in `fields` (= CSV priority order). preprocess enumerates ALL CSV rows, so a
 * dropped duplicate/blank row would leave a gap in Python's ranks; only the relative order is ever
 * used (pick_hit compares with `<`), so the absolute numbers are immaterial.
 */
export function loadLexicon(lexiconJson) {
  const fieldsMap = new Map();
  const rows = (lexiconJson && lexiconJson.fields) || [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const lemma = pyLower(pyStrip(r.lemma == null ? '' : r.lemma));
    if (lemma && !fieldsMap.has(lemma)) {
      const w = r.weight;
      // Python: float(r.get("weight") or 1.0) — CSV '' → 1.0. In JSON the weight is already a
      // number; null/undefined/'' → 1.0, but a genuine 0 stays 0 (a JS `||` would turn it into 1).
      const weight = (w === null || w === undefined || w === '') ? 1.0 : Number(w);
      fieldsMap.set(lemma, { field: pyStrip(r.field == null ? '' : r.field), weight, rank: i });
    }
  }
  const exper = new Set();
  for (const lm of (lexiconJson && lexiconJson.experiencer) || []) {
    const s = pyLower(pyStrip(lm == null ? '' : lm));
    if (s) exper.add(s);
  }
  const fieldNames = pySortedStrings(new Set(Array.from(fieldsMap.values(), (v) => v.field)));
  return { fieldsMap, fieldNames, exper };
}

/**
 * preprocess.py pick_hit (lines 81–88): first lexicon match by CSV priority among the ORDERED BÍN
 * candidates. Strict `<` on rank → among equal ranks (same lemma listed twice) the earlier
 * candidate wins; among different lemmas the lower CSV row wins regardless of candidate order.
 * Returns null | {hit, field, weight, rank}.
 */
export function pickHit(candLemmas, fieldsMap) {
  let best = null;
  for (const lm of candLemmas) {
    const info = fieldsMap.get(lm);
    if (info && (best === null || info.rank < best.rank)) {
      best = { hit: lm, field: info.field, weight: info.weight, rank: info.rank };
    }
  }
  return best;
}

// -------------------------------------------------------------- embeddings --

/**
 * load_embeddings (lines 448–453) on the space JSON + raw float32 vectors.
 * opts.minCount (P2, the vocabulary floor — design WEB_P2_DESIGN.md §4): keep only the lemmas with
 * counts ≥ minCount in `vocab` (row indices unchanged, the matrix shared, the SIF probabilities
 * unchanged); windowVector then skips the sub-floor lemmas. The space was fitted at min_count 5,
 * so a floor ≤ 5 is the identity; `nVocab` is the full row count, `minCount` what was applied.
 */
export function loadSpace(spaceJson, vectors, opts = {}) {
  if (!spaceJson || !vectors) return null;
  const vocabAll = new Map(Object.entries(spaceJson.vocab));
  const probs = new Map();
  for (const [w, c] of Object.entries(spaceJson.counts)) probs.set(w, c / spaceJson.total_stream);
  const dim = spaceJson.dim;
  const vecs = vectors instanceof Float32Array ? vectors
    : new Float32Array(vectors.buffer, vectors.byteOffset, vectors.byteLength / 4);
  if (vecs.length !== vocabAll.size * dim) {
    throw new Error(`space.vectors.f32 has ${vecs.length} floats, expected ${vocabAll.size} x ${dim}`);
  }
  const minCount = opts && opts.minCount != null ? Number(opts.minCount) : 0;
  if (!Number.isFinite(minCount) || minCount < 0) throw new RangeError(`loadSpace: minCount must be a non-negative number (got ${JSON.stringify(opts.minCount)})`);
  let vocab = vocabAll;
  if (minCount > 0) {
    vocab = new Map();
    const counts = spaceJson.counts || {};
    for (const [w, row] of vocabAll) if ((counts[w] === undefined ? 0 : counts[w]) >= minCount) vocab.set(w, row);
  }
  return { vocab, probs, dim, vecs, total_stream: spaceJson.total_stream, counts: spaceJson.counts, nVocab: vocabAll.size, minCount };
}

/**
 * preprocess.py window_vector (lines 457–467), in float32 like numpy: `vecs` is float32 and `w`
 * / `n` are Python scalars, so numpy evaluates vecs[i] * w, acc + …, acc / n in float32 (the
 * scalar is cast to float32 first). Math.fround after every operation reproduces that exactly
 * (double rounding is innocuous for a single IEEE op on float32 operands).
 * Returns null when no lemma is in the vocabulary (preprocess stacks zeros for those).
 */
export function windowVector(lemmas, space) {
  const { vocab, probs, dim, vecs } = space;
  let acc = null, n = 0;
  for (const lm of lemmas) {
    const i = vocab.get(lm);
    if (i === undefined) continue;
    const p = probs.get(lm);
    const w = Math.fround(SIF_A / (SIF_A + (p === undefined ? 0.0 : p)));
    const base = i * dim;
    if (acc === null) {
      acc = new Float32Array(dim);
      for (let d = 0; d < dim; d++) acc[d] = Math.fround(vecs[base + d] * w);
    } else {
      for (let d = 0; d < dim; d++) acc[d] = Math.fround(acc[d] + Math.fround(vecs[base + d] * w));
    }
    n += 1;
  }
  if (acc === null) return null;
  const n32 = Math.fround(n);
  for (let d = 0; d < dim; d++) acc[d] = Math.fround(acc[d] / n32);
  return acc;
}

// ------------------------------------------------------------------ sites --

/** preprocess.py _window_text (lines 471–473): re.sub(r'\s+([,.;:!?"])', r'\1', ' '.join(texts)).
 *  Python's `\s` (str.isspace) is spelled out — it includes \x1c–\x1f and \x85 and excludes ﻿,
 *  unlike JavaScript's `\s`. */
const WINDOW_TEXT_RE = new RegExp(`[${PY_SPACE_CLASS}]+([,.;:!?"])`, 'g');
export function windowText(texts) {
  return texts.join(' ').replace(WINDOW_TEXT_RE, '$1');
}

function asBool(v) {
  return v === true || v === 1 || v === '1' || v === 'True' || v === 'true';
}

/** `window` arrives from a URL / form as a string in the browser; `i + window + 1` would then
 *  concatenate. Coerce with Number() and accept only a non-negative integer (preprocess: int).
 *  Number() maps null and blank strings to 0, which Python's int() rejects — so do we: a missing
 *  form value must not silently become a one-token window (undefined still takes the default). */
function checkWindow(window, where) {
  const blank = window === null || (typeof window === 'string' && window.trim() === '');
  const w = blank ? NaN : Number(window);
  if (!Number.isInteger(w) || w < 0) {
    throw new RangeError(`${where}: window must be a non-negative integer (got ${typeof window} ${JSON.stringify(window)})`);
  }
  return w;
}

function checkTokens(saga, tk) {
  const need = ['text', 'kind', 'lemmas', 'lemma', 'cats', 'is_verb', 'case', 'mood', 'voice',
    'impersonal', 'in_quote', 'person', 'syl', 'sent_idx', 'idx', 'chapter'];
  if (!tk || !tk.cols) throw new Error(`tokens[${saga}]: missing cols`);
  for (const c of need) {
    if (!Array.isArray(tk.cols[c])) throw new Error(`tokens[${saga}].cols.${c} missing`);
    if (tk.cols[c].length !== tk.n) throw new Error(`tokens[${saga}].cols.${c} has ${tk.cols[c].length} rows, n = ${tk.n}`);
  }
}

/** `for ch, grp in tk.groupby("chapter")` — chapters ascending, rows in file order. */
export function groupByChapter(chapterCol) {
  const groups = new Map();
  for (let r = 0; r < chapterCol.length; r++) {
    const ch = chapterCol[r];
    let g = groups.get(ch);
    if (!g) { g = []; groups.set(ch, g); }
    g.push(r);
  }
  return Array.from(groups.keys()).sort((a, b) => a - b).map((ch) => [ch, groups.get(ch)]);
}

/** Cheap pre-pass: number of L0 sites a saga yields (word tokens with a lexicon hit). Lets a
 *  caller size progress bars / split work across workers and compute site_id offsets. */
export function countSites(tokensJson, lex) {
  const { fieldsMap } = lex.fieldsMap ? lex : loadLexicon(lex);
  const { kind, lemmas } = tokensJson.cols;
  let n = 0;
  for (let r = 0; r < tokensJson.n; r++) {
    if (kind[r] !== 'word') continue;
    const ls = lemmas[r] ? lemmas[r].split(';') : [];
    if (pickHit(ls, fieldsMap) !== null) n++;
  }
  return n;
}

/**
 * The per-saga body of stage_sites (preprocess.py 535–643). Returns
 * {l0: row[], l1: row[], vecs: (Float32Array|null)[] | null, nextSiteId}.
 * `siteIdOffset` is the running site_id (sites are numbered across sagas in `sagas` order).
 */
export function sitesForSaga({ saga, tokens, sentences = null, lex, space = null, window = DEFAULT_WINDOW, siteIdOffset = 0 }) {
  window = checkWindow(window, 'sitesForSaga');
  checkTokens(saga, tokens);
  const { fieldsMap, fieldNames, exper } = lex;
  const cols = tokens.cols;

  // parse_lut / terms_lut (lines 524–533), keyed (chapter, sent_idx) within this saga
  const parseLut = new Map(), termsLut = new Map();
  if (sentences && Array.isArray(sentences.rows)) {
    for (const row of sentences.rows) {
      const key = `${row[0]}|${row[1]}`;
      parseLut.set(key, Number(row[2]));                       // float(r.parsed)
      const terms = row.length > 3 ? row[3] : null;
      if (terms && terms.length) termsLut.set(key, terms);     // `if has_terms and r.terms`
    }
  }

  const l0 = [], l1 = [];
  const siteVecs = space ? [] : null;
  let siteId = siteIdOffset;

  // max_idx = max(int(tk["idx"].max()), 1)
  let maxIdx = -Infinity;
  for (let r = 0; r < tokens.n; r++) if (cols.idx[r] > maxIdx) maxIdx = cols.idx[r];
  maxIdx = Math.max(maxIdx, 1);

  for (const [ch, rows] of groupByChapter(cols.chapter)) {
    const n = rows.length;
    // grp = grp.reset_index(drop=True): position i within the chapter → global row rows[i]
    const text = new Array(n), kind = new Array(n), cats = new Array(n), case_ = new Array(n),
      mood = new Array(n), voice = new Array(n), lemma = new Array(n), person = new Array(n),
      isVerb = new Uint8Array(n), impersonal = new Uint8Array(n), inQuote = new Uint8Array(n),
      syl = new Array(n), sentIdx = new Array(n), idx = new Array(n);
    const lemLists = new Array(n), lemSets = new Array(n), isWord = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const r = rows[i];
      text[i] = cols.text[r]; kind[i] = cols.kind[r]; cats[i] = cols.cats[r]; case_[i] = cols.case[r];
      mood[i] = cols.mood[r]; voice[i] = cols.voice[r]; lemma[i] = cols.lemma[r]; person[i] = cols.person[r];
      isVerb[i] = asBool(cols.is_verb[r]) ? 1 : 0; impersonal[i] = asBool(cols.impersonal[r]) ? 1 : 0;
      inQuote[i] = asBool(cols.in_quote[r]) ? 1 : 0;
      syl[i] = cols.syl[r]; sentIdx[i] = cols.sent_idx[r]; idx[i] = cols.idx[r];
      const s = cols.lemmas[r];
      lemLists[i] = s ? s.split(';') : [];                     // s.split(";") if s else []
      lemSets[i] = new Set(lemLists[i]);
      isWord[i] = kind[i] === 'word' ? 1 : 0;
    }
    const intersects = (set, other) => { for (const x of set) if (other.has(x)) return true; return false; };

    for (let i = 0; i < n; i++) {
      if (!isWord[i]) continue;
      const picked = pickHit(lemLists[i], fieldsMap);
      if (picked === null) continue;
      const hit = picked.hit, field = picked.field;
      const lo = Math.max(0, i - window), hi = Math.min(n, i + window + 1);
      const wwords = [];
      for (let j = lo; j < hi; j++) if (kind[j] === 'word') wwords.push(j);
      const nWords = Math.max(wwords.length, 1);

      // field densities (weights of the CSV-priority hit of every window token)
      const fdens = {};
      for (const f of fieldNames) fdens[f] = 0.0;
      for (let j = lo; j < hi; j++) {
        const p2 = pickHit(lemLists[j], fieldsMap);
        if (p2) fdens[p2.field] += p2.weight;
      }
      // negation count and litotes (negation within 3 tokens of an 'ó-' adjective)
      let neg = 0;
      for (let j = lo; j < hi; j++) if (intersects(lemSets[j], NEG_LEMMAS)) neg++;
      let litotes = false;
      for (let j = lo; j < hi; j++) {
        if (intersects(lemSets[j], NEG_LEMMAS)) {
          for (let k = Math.max(lo, j - 3); k < Math.min(hi, j + 4); k++) {
            if (pyLower(text[k]).startsWith('ó') && cats[k].split(';').includes('lo')) litotes = true;
          }
        }
      }
      // experiencer constructions: dative pronoun within ±2 of an experiencer verb / impersonal
      let expN = 0;
      for (let j = lo; j < hi; j++) {
        if (DAT_PRONOUNS.has(pyLower(text[j])) || (case_[j] === 'd' && cats[j].split(';').includes('pfn'))) {
          for (let k = Math.max(lo, j - 2); k < Math.min(hi, j + 3); k++) {
            if (k === j) continue;
            if (intersects(lemSets[k], exper) || impersonal[k]) { expN += 1; break; }
          }
        }
      }
      let nVerbs = 0;
      for (const j of wwords) nVerbs += isVerb[j];
      nVerbs = Math.max(nVerbs, 1);
      // sents = {s for s in win["sent_idx"] if s >= 0}  (CPython set order, see cpySetOrderInts)
      const sentVals = [];
      for (let j = lo; j < hi; j++) if (sentIdx[j] >= 0) sentVals.push(sentIdx[j]);
      const confs = [];
      for (const s of cpySetOrderInts(sentVals)) {
        const v = parseLut.get(`${ch}|${s}`);
        if (v !== undefined) confs.push(v);
      }

      let inQuoteSum = 0, datN = 0, accN = 0, genN = 0, vhN = 0, mmN = 0, impN = 0;
      for (const j of wwords) {
        inQuoteSum += inQuote[j];
        if (case_[j] === 'd') datN++;
        if (case_[j] === 'a') accN++;
        if (case_[j] === 'g') genN++;
        if (mood[j] === 'vh') vhN++;
        if (voice[j] === 'mm') mmN++;
        impN += impersonal[j];
      }
      const persons = new Set();
      for (let j = lo; j < hi; j++) if (person[j] !== '') persons.add(person[j]);
      const winTexts = [];
      for (let j = lo; j < hi; j++) winTexts.push(text[j]);

      const row = {
        site_id: siteId, saga, chapter: ch,
        keyword: text[i], keyword_lemma: hit, field,
        narrative_pos: idx[i] / maxIdx,
        is_direct_speech: inQuote[i] === 1,
        n_window_words: nWords,
        speech_ratio: wwords.length ? inQuoteSum / wwords.length : 0.0,
        neg_ratio: neg / nWords, litotes,
        experiencer_count: expN,
        dat_ratio: datN / nWords,
        acc_ratio: accN / nWords,
        gen_ratio: genN / nWords,
        subj_ratio: vhN / nVerbs,
        middle_ratio: mmN / nVerbs,
        impersonal_ratio: impN / nVerbs,
        parse_conf: confs.length ? npMean(confs) : null,          // np.nan → null
        window_text: windowText(winTexts),
        // who is present in this window (canonical person names)
        persons_in_window: pySortedStrings(persons).join(';'),
        // ALL BÍN readings of the keyword form — homographs made visible
        kw_candidates: pySortedStrings(new Set(lemLists[i])).join(';'),
      };
      // parse-based disambiguation: what did Greynir read THIS form as? (lines 604–617)
      let kwParsed = '', kwDisamb = 'unk';
      const sidx = sentIdx[i];
      const terms = termsLut.get(`${ch}|${sidx}`);
      if (terms) {
        const surf = text[i];
        let ordN = 0;                                              // same form earlier in this sentence
        for (let j = 0; j < i; j++) if (sentIdx[j] === sidx && text[j] === surf) ordN++;
        let matches = terms.filter((t) => t[0] === surf);
        if (!matches.length) {
          const surfLower = pyLower(surf);
          matches = terms.filter((t) => pyLower(pyStr(t[0])) === surfLower);
        }
        if (ordN < matches.length) {
          kwParsed = pyLower(pyStr(matches[ordN][1]));
          kwDisamb = kwParsed === hit ? 'ok' : 'rej';
        }
      }
      row.kw_parsed_lemma = kwParsed;
      row.kw_disamb = kwDisamb;
      for (const f of fieldNames) row[`field_${f}_ratio`] = fdens[f] / nWords;
      l0.push(row);

      if (siteVecs) {
        const wl = [];
        for (const j of wwords) wl.push(lemma[j]);
        siteVecs.push(windowVector(wl, space));
      }

      for (let tOff = 0; tOff < hi - lo; tOff++) {                 // L1: one row per window token
        const j = lo + tOff;
        const p3 = pickHit(lemLists[j], fieldsMap);
        l1.push({
          site_id: siteId, t: tOff, text: text[j],
          lemma: lemma[j], cats: cats[j], case: case_[j],
          mood: mood[j], voice: voice[j],
          is_keyword: j === i,
          dist: j - i,
          seed_field: p3 ? p3.field : '',
          in_quote: inQuote[j] === 1, syl: syl[j],
          kind: kind[j],
        });
      }
      siteId += 1;
    }
  }
  return { l0, l1, vecs: siteVecs, nextSiteId: siteId };
}

/**
 * preprocess.py stage_sites (lines 500–693) minus the layout columns (emb_*, umap_*, km_cluster,
 * tsne_*, som_*, gpca_*, position — those belong to core/hugur_layouts.js attachLayouts).
 *
 * @param {object} args
 * @param {Object<string, object>} args.tokens     saga id → tokens JSON (item 1 of the contract)
 * @param {Object<string, object>} [args.sentences] saga id → sentences JSON (item 2); missing saga → parse_conf null, kw_disamb 'unk'
 * @param {object} args.lexicon                    lexicon JSON (item 4) or the result of loadLexicon()
 * @param {object|null} [args.space]               {vocab, counts, total_stream, dim, vectors: Float32Array} or loadSpace() result; null → vecs null
 * @param {number} [args.window=25]
 * @param {string[]} [args.sagas]                  saga order; default = Python sorted(ids) of the tokens keys
 * @returns {{l0: object[], l1: object[], vecs: Float32Array|null, fieldNames: string[], dim: number|null}}
 */
export function stageSites({ tokens, sentences = {}, lexicon, space = null, window = DEFAULT_WINDOW, sagas = null }) {
  window = checkWindow(window, 'stageSites');
  if (!tokens) throw new Error('stageSites: tokens required');
  const lex = lexicon && lexicon.fieldsMap ? lexicon : loadLexicon(lexicon);
  const sp = space === null || space === undefined ? null
    : (space.vocab instanceof Map ? space : loadSpace(space, space.vectors));
  const order = sagas || pySortedStrings(Object.keys(tokens));

  const l0 = [], l1 = [];
  const vecList = sp ? [] : null;
  let siteId = 0;
  for (const saga of order) {
    const part = sitesForSaga({
      saga, tokens: tokens[saga], sentences: (sentences && sentences[saga]) || null,
      lex, space: sp, window, siteIdOffset: siteId,
    });
    for (const r of part.l0) l0.push(r);
    for (const r of part.l1) l1.push(r);
    if (vecList) for (const v of part.vecs) vecList.push(v);
    siteId = part.nextSiteId;
  }

  // M = np.vstack([v if v is not None else np.zeros(dim) for v in site_vecs]) — float32, zeros for
  // windows without a vocabulary lemma. (preprocess only stacks when len(l0) > 0; an empty result
  // yields a zero-length Float32Array here.)
  let vecs = null;
  if (sp) {
    vecs = new Float32Array(l0.length * sp.dim);
    for (let s = 0; s < l0.length; s++) {
      const v = vecList[s];
      if (v) vecs.set(v, s * sp.dim);
    }
  }
  return { l0, l1, vecs, fieldNames: lex.fieldNames, dim: sp ? sp.dim : null };
}

/** The L0 column order preprocess writes for the non-layout part (DataFrame insertion order). */
export function l0Columns(fieldNames) {
  return ['site_id', 'saga', 'chapter', 'keyword', 'keyword_lemma', 'field', 'narrative_pos',
    'is_direct_speech', 'n_window_words', 'speech_ratio', 'neg_ratio', 'litotes', 'experiencer_count',
    'dat_ratio', 'acc_ratio', 'gen_ratio', 'subj_ratio', 'middle_ratio', 'impersonal_ratio',
    'parse_conf', 'window_text', 'persons_in_window', 'kw_candidates', 'kw_parsed_lemma', 'kw_disamb',
    ...fieldNames.map((f) => `field_${f}_ratio`)];
}

export const L1_COLUMNS = ['site_id', 't', 'text', 'lemma', 'cats', 'case', 'mood', 'voice',
  'is_keyword', 'dist', 'seed_field', 'in_quote', 'syl', 'kind'];

// ------------------------------------------------------------- DEPARTURES --
// 1. loadLexicon ranks are positions in the exported `fields` array, not raw CSV row numbers
//    (preprocess enumerates every CSV data row, dropped duplicates included). Only `<` between
//    ranks is ever used, so no observable effect.
// 2. cpySetOrderInts falls back to ascending order for ints ≥ 2^30 (CPython hashes those the same
//    way, but the unsigned 64-bit perturb arithmetic is not reproduced in doubles). sent_idx is a
//    per-chapter counter (< 10^4), so the emulation is exact on real data; and with boolean
//    `parsed` values the order cannot change parse_conf at all.
// 3. pyStr covers str/None/bool; a numeric `terms` entry would stringify as JavaScript does
//    ('1' where Python repr gives '1.0'). Greynir terminals are always strings.
// 4. pyLower relies on String.prototype.toLowerCase == str.lower for the corpus (both implement
//    Unicode full lowercase mapping; they are identical for Latin/Icelandic text).
