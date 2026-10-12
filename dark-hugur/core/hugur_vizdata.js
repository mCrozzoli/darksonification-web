// hugur_vizdata.js — brain.py _gen_viz_data (dark_hugur, L117–218), ported: the reshaping of the sites tables into
// viz/data/{sites,tokens,entities,meta}.json, value for value and key for key.
//
// ES module, pure: no DOM, no Node-only API, no I/O. In P1 it is gated (probe/vizdata_equiv.mjs: over the
// exporter's reference tables it must equal the desktop brain's own files); in P2 the text tab calls it after a
// lexicon edit (design WEB_P1_DESIGN.md §4.3):
//
//   vizData({ l0, l1, entities, manifest, lexicon, opts }) → { sites, tokens, entities, meta }
//
//   l0        array of row objects with the sites_l0 columns (the exporter's probe/ref/.../sites_l0.json, or
//             hugur_sites.stageSites().l0 after hugur_layouts.attachLayouts()); rows in l0 order (= site_id)
//   l1        array of row objects with the sites_l1 columns (site_id, t, text, lemma, cats, case, mood, voice,
//             is_keyword, dist, seed_field, in_quote, syl, kind)
//   entities  array of row objects with the entities_l0 columns (name, saga, kind, mentions, first_chapter,
//             last_chapter, …) or null/undefined (brain.py: the parquet is absent → `entities: []`)
//   manifest  { sagas, lexicon_hash, methods } — darkdata/manifest.json's fields the brain reads
//   lexicon   data/lexicon.json ({fields: [{lemma, field, weight, notes}], experiencer}) or an array of such rows
//   opts      { umapPending: false, float32: 'auto' | false | [column names], warn: console.warn }
//
// Pandas arithmetic emulated where it is observable: `umap_x/y` and `tsne_x/y` are float32 columns in the parquet
// (umap-learn and sklearn's TSNE return float32), so pandas normalises them in float32 — (v − min) and the division
// each rounded to float32 — before `float()` and `round(x, 4)`; `som_*` and `gpca_*` are float64. A column is
// treated as float32 when every finite value is float32-representable (opts.float32 = 'auto', the default), or
// when named in opts.float32; opts.float32 = false treats every column as float64 (what a JS-computed layout is).
//
// The honest labels (design §4.4): with opts.umapPending the umap layout is labelled `semantic · pca (umap
// pending)` (P2: attachLayouts wrote the emb_0/emb_1 fallback because no JS UMAP was passed); a t-SNE whose
// columns are absent is dropped from `layouts` and from the rows — brain.py already does that.

import { pySortedStrings, pyStrip, pyStr } from './hugur_sites.js';
import { deriveFields, normalizeDrivers, driverVec, pyRound4, asFloat } from './hugur_drivers.js';

export const VIZ_GEN = 8;                          // brain.py L33
export const LAYOUT_KEYS = Object.freeze(['umap', 'som', 'tsne', 'gpca']);

const hasCol = (l0, c) => l0.length > 0 && Object.prototype.hasOwnProperty.call(l0[0], c);
const pyInt = (v) => Math.trunc(Number(v));        // int(x) on an int / bool / integral float cell

/** True when every finite value of the column is exactly representable in float32 (a float32 parquet column). */
export function isFloat32Column(l0, c) {
  let seen = false;
  for (const r of l0) {
    const v = asFloat(r[c]);
    if (!Number.isFinite(v)) continue;
    seen = true;
    if (Math.fround(v) !== v) return false;
  }
  return seen;
}

/**
 * brain.py L131–136 `norm(cx, cy)`: x = (col − min) / max(max − min, 1e-9), per column; null when `cx` is absent.
 * Returns { x: number[], y: number[] } of un-rounded doubles (float32-emulated when `f32` says so).
 */
export function normColumn(l0, c, f32) {
  const n = l0.length, vals = new Array(n);
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = asFloat(l0[i][c]);
    vals[i] = v;
    if (Number.isNaN(v)) continue;                 // pandas min/max skip NaN
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const out = new Array(n);
  if (f32) {
    const d = Math.fround(hi - lo);                // np.float32 − np.float32
    const denom = d > 1e-9 ? d : Math.fround(1e-9);   // max(np.float32, 1e-9): the Python float then casts to float32 in the division
    for (let i = 0; i < n; i++) out[i] = Math.fround(Math.fround(vals[i] - lo) / denom);
  } else {
    const denom = Math.max(hi - lo, 1e-9);
    for (let i = 0; i < n; i++) out[i] = (vals[i] - lo) / denom;
  }
  return out;
}

export function layoutCoords(l0, opts = {}) {
  const f32mode = opts.float32 === undefined ? 'auto' : opts.float32;
  const isF32 = (c) => (f32mode === 'auto' ? isFloat32Column(l0, c)
    : f32mode === false ? false
      : Array.isArray(f32mode) ? f32mode.includes(c) : f32mode instanceof Set ? f32mode.has(c) : false);
  const coords = {};
  for (const k of LAYOUT_KEYS) {
    const cx = `${k}_x`, cy = `${k}_y`;
    if (!hasCol(l0, cx)) { coords[k] = null; continue; }   // brain.py L132–133: `if cx not in l0.columns: return None`
    coords[k] = { x: normColumn(l0, cx, isF32(cx)), y: normColumn(l0, cy, isF32(cy)) };
  }
  return coords;
}

/** brain.py L199–209: meta.lexicon rows {lemma, field, weight} from the lexicon (CSV rules on the JSON rows). */
export function metaLexicon(lexicon) {
  const rows = Array.isArray(lexicon) ? lexicon : lexicon && Array.isArray(lexicon.fields) ? lexicon.fields : [];
  const out = [];
  for (const row of rows) {
    const lemma = pyStrip(row.lemma == null ? '' : String(row.lemma));
    if (!lemma) continue;                          // `if row.get("lemma", "").strip()`
    const w = row.weight;
    out.push({ lemma, field: pyStrip(row.field == null ? '' : String(row.field)),
      weight: w === null || w === undefined || w === '' ? 1.0 : Number(w) });   // float(row.get("weight") or 1.0): "" → 1.0, "0" → 0.0
  }
  return out;
}

/** brain.py L190–197: the layouts list — umap always, som / tsne when their columns exist, gpca ALWAYS, arc, kwic. */
export function layoutList(coords, opts = {}) {
  const layouts = [{ key: 'umap', label: opts.umapPending ? 'semantic · pca (umap pending)' : 'semantic · umap' }];
  if (coords.som) layouts.push({ key: 'som', label: 'semantic · som' });
  if (coords.tsne) layouts.push({ key: 'tsne', label: 'semantic · t-sne' });
  layouts.push({ key: 'gpca', label: 'grammar · pca' });
  layouts.push({ key: 'arc', label: 'narrative arc' });
  layouts.push({ key: 'kwic', label: 'kwic' });
  return layouts;
}

export function vizData({ l0, l1, entities = null, manifest = {}, lexicon = null, opts = {} } = {}) {
  if (!Array.isArray(l0) || !Array.isArray(l1)) throw new TypeError('vizData: l0 and l1 must be arrays of rows');
  const warn = opts.warn || ((t) => { if (typeof console !== 'undefined') console.warn(t); });

  // brain.py _load, the parts _gen_viz_data consumes
  const { fields: FIELDS, warning } = deriveFields(l0);
  if (warning) warn(warning);
  const { drivers } = normalizeDrivers(l0, FIELDS);
  const coords = layoutCoords(l0, opts);
  if (!coords.umap) throw new Error('vizData: l0 has no umap_x / umap_y columns (brain.py would fail here too)');
  const hasKm = hasCol(l0, 'km_cluster');
  const hasCands = hasCol(l0, 'kw_candidates');
  const hasKwd = hasCol(l0, 'kw_disamb');
  const hasWho = hasCol(l0, 'persons_in_window');

  // L141–168: sites
  const sites = new Array(l0.length);
  for (let i = 0; i < l0.length; i++) {
    const r = l0[i];
    const whoS = hasWho ? r.persons_in_window : '';
    const s = {
      id: pyInt(r.site_id), saga: r.saga, ch: pyInt(r.chapter),
      kw: r.keyword, lemma: r.keyword_lemma, field: r.field,
      x: pyRound4(coords.umap.x[i]),
      y: pyRound4(coords.umap.y[i]),
      pos: pyRound4(Number(r.narrative_pos)),
      speech: Boolean(r.is_direct_speech),
      text: r.window_text,
      who: whoS ? pySortedStrings(new Set(String(whoS).split(';'))) : [],   // set(s.split(";")) if s else set()
      drivers: driverVec(drivers[i], 0.0),         // query_sims is None at generation: sim 0.0
    };
    if (hasCands) {
      const cands = pyStr(r.kw_candidates).split(';').filter((c) => c);
      if (cands.length > 1) s.cands = cands;         // homograph form — ship the other readings
    }
    if (hasKwd) {
      s.kwd = r.kw_disamb;                           // ok | rej | unk (parse verdict)
      if (r.kw_disamb === 'rej') s.kwp = r.kw_parsed_lemma;
    }
    for (const k of ['som', 'tsne', 'gpca']) {
      if (coords[k]) s[k] = [pyRound4(coords[k].x[i]), pyRound4(coords[k].y[i])];
    }
    if (hasKm) s.km = pyInt(r.km_cluster);
    sites[i] = s;
  }

  // L72 + L169–175: tokens — l1 grouped by site_id (ascending), each group sorted by t
  const groups = new Map();
  for (const t of l1) {
    const sid = pyInt(t.site_id);
    let g = groups.get(sid);
    if (!g) { g = []; groups.set(sid, g); }
    g.push(t);
  }
  const tokens = {};
  for (const sid of Array.from(groups.keys()).sort((a, b) => a - b)) {
    const g = groups.get(sid).slice().sort((a, b) => Number(a.t) - Number(b.t));
    tokens[String(sid)] = g.map((t) => [t.text, pyInt(t.dist), Boolean(t.is_keyword),
      FIELDS.indexOf(t.seed_field),                  // FIELDS.index(seed_field) if in FIELDS else -1
      pyInt(t.syl), Boolean(t.in_quote), t.kind === 'person' ? 1 : 0]);
  }

  // L176–183: entities
  const ents = Array.isArray(entities)
    ? entities.map((r) => ({ name: r.name, saga: r.saga, kind: r.kind, mentions: pyInt(r.mentions),
      ch0: pyInt(r.first_chapter), ch1: pyInt(r.last_chapter) }))
    : [];

  // L190–216: layouts, lexicon, meta
  const layouts = layoutList(coords, opts);
  const meta = {
    gen: VIZ_GEN, fields: FIELDS,
    sagas: manifest.sagas === undefined ? null : manifest.sagas,
    n_sites: l0.length,
    lexicon_hash: manifest.lexicon_hash === undefined ? null : manifest.lexicon_hash,
    methods: manifest.methods || {},
    layouts,
    lexicon: metaLexicon(lexicon),
  };
  return { sites, tokens, entities: ents, meta };
}

export default { VIZ_GEN, LAYOUT_KEYS, vizData, layoutCoords, normColumn, isFloat32Column, metaLexicon, layoutList };
