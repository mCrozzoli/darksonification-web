// hugur_brain.js — brain.py (dark_hugur, 2026-08-31, 522 lines; + `layer` and `spread` of 2026-10-08) in JavaScript:
// the fifteen /dark_nav commands, /dark_query, /dark_legend, the level machine, the five payloads to the page and the
// ten OSC messages to SuperCollider — ported statement by statement (design WEB_P1_DESIGN.md §2; line references
// below are to brain.py). P2 (WEB_PLAN.md §10.2): nav `layer` {name, value} → /dark/layer (the SOUND faders, kept in
// `layers`), nav `spread` {value} → γ, the semantic spread, an exponent on the live query's stored base sims
// (`query_z`): both in the state payload, both mirrored in brain.py line for line. v3 (WEB_PLAN.md §13, RUNNER_CONTRACT.md v3,
// 2026-10-12): the driver vector is 19 floats — 16 feel · 17 focus · 18 change, the bed's three statistics across the fields
// (hugur_drivers.js siteStats = brain.py §stats), kept per site in `stats` at load and after a rebuild; the legend gains
// `hold [field, dir]` (the page's less · more chips): the current site's vector with one value pushed to 0 or 1, sent to
// SuperCollider as an `iso` — brain.py L565–571.
//
// ES module usable from Node and the browser: no DOM, no Node-only API, no I/O of its own. Files come through an
// injected loader (`load(loader)`), sound and page traffic go through injected hooks:
//
//   const brain = new HugurBrain({
//     osc:     (address, typedArgs) => …,   // → SuperCollider; typedArgs are osc.js-shaped {t:"i"|"f"|"s", v}
//     deliver: (payload) => …,              // → the page (what bridge.py forwarded as /dark_viz JSON)
//     now:     () => seconds,               // unused by brain.py's logic; kept for API parity
//     timer:   (ms, fn) => void,            // the one timer: the demo ping's 250 ms "end"
//     warn:    (text) => void,              // brain.py's print() warnings (default console.warn)
//   });
//   await brain.load(window.__darkWeb);     // {json(path)} (+ optional {bytes(path)}): the picture tables first
//   brain.announce();                       // deliver(state) then deliver(hello) — the bridge's two sticky messages, in its STICKY order
//   brain.dispatch(pageMessage);            // {type:"nav"|"query"|"legend", …} exactly as the page sends it
//   brain.replay();                         // at SC ready: /dark/master, /dark/mute if muted, /dark/layer per gain ≠ 1, /dark/level 1 if at L1, drivers of sel
//   HugurBrain.fromData(brain.data, hooks)  // a second, isolated instance over the same loaded tables (the gates)
//   brain.rebuild(rows, meta, vecs)         // P2 seam: new sites.json-shaped rows (+ meta, raw float32 site vectors)
//
// On the desktop the brain boots from sites_l0.parquet; here it boots from the page's own sites.json rows (the
// desktop brain's output: `lemma`, `saga`, `field`, `speech`, `text`, `who`, `kwd` and `drivers[0..14]` = the
// normalised drivers already rounded to 4 dp, `drivers[16..18]` = the three statistics since v3), plus sites.vectors.f32, space.json + space.vectors.f32 and bin.json
// for the queries. The rows are shared with the page and never mutated here; what the brain indexes it copies.
//
// Dropped, by design (§2.8): the 3 s heartbeat, the parent watch, the sticky replay, the lock, the BÍN preload
// (replaced by the static table), the dead L1_BASE / PITCH_BY_CAT / l1_abort. Everything else is here.

import { pySortedStrings, pyStrip, pyLower, pyStr } from './hugur_sites.js';
import { DRIVER_DIM, N_DRIVER_COLS, SIM_IDX, STAT_IDX, siteStats, npRound4, pyRound4, pyRound3 } from './hugur_drivers.js';
import { normalizeRows, vocabMap, runQuery } from './hugur_query.js';

export { DRIVER_DIM };
export const VIZ_GEN = 9;                                   // brain.py L50 (9: the drivers carry 19 floats — v3, 2026-10-12)
export const LAYER_NAMES = Object.freeze(['bed', 'pad', 'whisper', 'events']);   // the SOUND faders, /dark/layer's names

// Typed OSC arguments: the same {t, v} objects osc.js's f()/i()/s() build (its typed() passes them through), so a
// message list from here goes straight into oscMessage(address, args) — without this module importing osc.js.
export const f = (v) => ({ t: 'f', v: Number(v) });
export const i = (v) => ({ t: 'i', v: Math.trunc(Number(v)) });
export const s = (v) => ({ t: 's', v: String(v) });
export const oscTypes = Object.freeze({ f, i, s });

/** The files the brain loads, relative to the page (design §1.6); override with load(loader, {paths}). */
export const DATA_PATHS = Object.freeze({
  meta: 'data/meta.json',
  sites: 'data/sites.json',
  siteVectors: 'data/sites.vectors.f32',
  space: 'data/space.json',
  spaceVectors: 'data/space.vectors.f32',
  bin: 'data/bin.json',
});

// ------------------------------------------------------------ python coercions --
// Python's int()/float()/str() on an OSC argument. int()/float() RAISE on a bad value (TypeError on None, a list or
// a dict; ValueError on a non-numeric string; OverflowError on inf) — the desktop handler then dies in its thread
// with nothing changed or sent; here the caller gets null and returns silently (same outcome). Only booleans,
// numbers and numeric strings coerce, as in Python; a NaN float → null too (JSON cannot carry one; nothing wants it).
export function pyInt(x) {
  if (typeof x === 'boolean') return x ? 1 : 0;
  if (typeof x === 'number') return Number.isFinite(x) ? Math.trunc(x) : null;
  if (typeof x === 'string') { const t = x.trim(); return /^[+-]?\d+$/.test(t) ? parseInt(t, 10) : null; }
  return null;                                              // null, undefined, arrays, objects: Python's TypeError
}
export function pyFloat(x) {
  if (typeof x === 'boolean') return x ? 1.0 : 0.0;
  if (typeof x === 'number') return Number.isNaN(x) ? null : x;
  if (typeof x === 'string') { const t = x.trim(); if (!t) return null; const v = Number(t); return Number.isNaN(v) ? null : v; }
  return null;                                              // null, undefined, arrays, objects: Python's TypeError
}
const pyMod = (a, n) => ((a % n) + n) % n;                 // Python % is never negative for n > 0
const nonEmpty = (w) => w !== '';
const hasKey = (m, k) => Object.prototype.hasOwnProperty.call(m, k);

/**
 * viz/bridge.py `_relay_to_brain` (L146–163), flattened: the page object → the positional args the handler got.
 *   nav    → [str(cmd)] + idx? + value? + name? + [str(w) for w in words]   (each key only if present)
 *   query  → [str(word)]
 *   legend → [str(cmd)] + field? + site? + layer? + value? + dir?
 * Returns { addr, args } or null for an unknown type (the bridge relays nothing then).
 * `dir` (v3, 2026-10-12): the legend's `hold {field, dir}` of WEB_PLAN.md §13.3 — appended after bridge.py's four keys so
 * the desktop's order is untouched; bridge.py L214's tuple ("field", "site", "layer", "value") has to gain "dir" the same
 * way for the desktop page's hold to reach brain.py (until then a page may send the direction as `value`: both flatten).
 */
export function flattenPageMessage(m) {
  if (!m || typeof m !== 'object') return null;
  const t = m.type;
  if (t === 'nav') {
    const args = [hasKey(m, 'cmd') ? pyStr(m.cmd) : ''];
    for (const k of ['idx', 'value', 'name']) if (hasKey(m, k)) args.push(m[k]);
    if (Array.isArray(m.words)) for (const w of m.words) args.push(pyStr(w));
    return { addr: '/dark_nav', args };
  }
  if (t === 'query') return { addr: '/dark_query', args: [hasKey(m, 'word') ? pyStr(m.word) : ''] };
  if (t === 'legend') {
    const args = [hasKey(m, 'cmd') ? pyStr(m.cmd) : ''];
    for (const k of ['field', 'site', 'layer', 'value', 'dir']) if (hasKey(m, k)) args.push(m[k]);
    return { addr: '/dark_legend', args };
  }
  return null;
}

// ------------------------------------------------------------------- the brain --
export class HugurBrain {
  constructor(hooks = {}, data = null) {
    const noop = () => {};
    this.hooks = {
      osc: noop, deliver: noop,
      now: () => Date.now() / 1000,
      timer: (ms, fn) => setTimeout(fn, ms),
      warn: (t) => { if (typeof console !== 'undefined') console.warn(t); },
      ...hooks,
    };
    // brain.py L44–57: the mutable state and its initial values
    this.sel = 0;
    this.level = 0;
    this.comb = 0;
    this.master = 0.8;
    this.muted = false;
    this.tracked = [];
    this.query_sims = null;                               // Float64Array per site once a query lands; never cleared
    this.l1_traj = [];                                    // L1 = manual navigation through a lemma-braid
    this.l1_step = 0;
    this.persons = new Set();                             // person filter: braids restrict to their windows
    this.person_mode = 'any';                             // "any" = union · "all" = co-presence
    this.braid = [];                                      // page-selected query lemmas; if set, they ARE the braid
    this.saga_off = new Set();                            // saga display filter: braids skip hidden sagas
    this.layers = { bed: 1, pad: 0.28, whisper: 0.5, events: 0.84 };   // SOUND faders → /dark/layer (brain.py self.layers; the defaults Miguel set by ear, 2026-10-12)
    this.spread = 1;                                      // γ, the semantic spread: query_sims = query_z ** γ (WEB_P2_DESIGN.md §4)
    this.loose = false;                                   // P2 strictness LOOSE (rebuild(…, {loose})): rej sites stay in the braid
    this.query_z = null;                                  // the last hit's sims BEFORE γ (Float64Array; the stretch, or the 1/0.3/0 surface values)
    this.last_query = null;                               // {word, lemma, top, surface} of the last hit: re-delivered when γ changes
    // web-only: the tables and the load state
    this.data = { rows: null, meta: null, fields: [], nSites: 0, dim: 0, siteVecs: null, vocab: new Map(), vocabAll: null, lemmaVecs: null, bin: null, loadErrors: {} };
    this.stats = null;                                    // v3: {feel, focus, change} Float64Arrays per site (+ source), set by _bindRows (brain.py self.stats)
    this._gen = 0;                                        // the rows generation: rebuild() bumps it; load()'s background site vectors bind only to the generation they were asked for
    this.loaded = false;                                  // the picture tables (rows + meta) are in
    this.queryLoaded = false;                             // the query assets have settled (loaded or failed)
    this.pendingQueries = [];                             // words asked before the query assets landed
    this.ready = new Promise((res) => { this._readyResolve = res; });
    this.queryReady = new Promise((res) => { this._queryReadyResolve = res; });
    if (data) this._bindAll(data);
  }

  /** An isolated instance over tables another instance loaded (design §1.5, §5.2): nothing is fetched. */
  static fromData(data, hooks = {}) { return new HugurBrain(hooks, data); }

  // ---------------------------------------------------------------- loading --
  /**
   * brain.py `_load` (L68–110) over the shipped files. `loader.json(path)` is required (the page's gzip-aware,
   * memoised `window.__darkWeb.json`, so the rows are the very object the page draws); `loader.bytes(path)` →
   * ArrayBuffer is optional (default: fetch(path).arrayBuffer()). Resolves (and sets `loaded`) when meta + sites
   * are in — the state machine answers from then on; the query assets keep loading in the background, each one
   * independently (`queryReady`, `queryLoaded`; a failure is recorded in data.loadErrors and that path degrades
   * to the desktop's "BÍN unavailable" / surface behaviour). Queries asked meanwhile are answered when they settle.
   */
  async load(loader, opts = {}) {
    if (!loader || typeof loader.json !== 'function') throw new TypeError('HugurBrain.load: loader.json(path) is required');
    const paths = { ...DATA_PATHS, ...(opts.paths || {}) };
    const json = (p) => loader.json(p);
    const bytes = typeof loader.bytes === 'function' ? (p) => loader.bytes(p)
      : (p) => {
        if (typeof fetch !== 'function') return Promise.reject(new Error('no bytes loader and no fetch'));
        return fetch(p).then((r) => { if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.arrayBuffer(); });
      };
    const [meta, rows] = await Promise.all([json(paths.meta), json(paths.sites)]);
    this._bindRows(rows, meta, Array.isArray(meta && meta.fields) ? meta.fields : null);
    const settle = (name, p, apply) => p.then(apply, (e) => {
      this.data.loadErrors[name] = String((e && e.message) || e);
      this.hooks.warn(`[brain] ${name} failed to load (${this.data.loadErrors[name]}) — queries fall back to surface matching`);
    });
    const q = {};
    const gen = this._gen;                                 // the rows these site vectors belong to (the shipped ones)
    this._queryLoading = Promise.all([
      settle('sites.vectors', bytes(paths.siteVectors), (buf) => { q.siteVectorsRaw = buf; }),
      settle('space', Promise.all([json(paths.space), bytes(paths.spaceVectors)]), ([space, buf]) => { q.space = space; q.spaceVectorsRaw = buf; }),
      settle('bin', json(paths.bin), (b) => { q.bin = b; }),
    ]).then(() => {
      if (this._gen !== gen) { delete q.siteVectorsRaw; q.keepVocab = true; }   // rebuilt meanwhile (a link-driven apply): the shipped site vectors belong to the old rows and the rebuild's vocabulary floor stays; the space and the BÍN table are rows-free and bind
      this._bindQueryTables(q);
    }).catch((e) => {
      this.data.loadErrors.bind = String((e && e.message) || e);
      this.hooks.warn(`[brain] query tables could not be bound (${this.data.loadErrors.bind}) — queries fall back to surface matching`);
      if (!this.queryLoaded) this._bindQueryTables({});           // settle anyway: the pending queries are answered
    });
    return this;
  }

  _bindAll(data) {
    this._bindRows(data.rows, data.meta, data.fields || (data.meta && data.meta.fields) || null);
    this._bindQueryTables(data);
  }
  /** The per-site indexes brain.py keeps (L91–98): copies, never the shared rows. */
  _bindRows(rows, meta, fields) {
    if (!Array.isArray(rows)) throw new TypeError('HugurBrain: rows must be the sites.json array');
    const n = rows.length;
    this.data.rows = rows;
    this.data.meta = meta || null;
    this.data.fields = Array.isArray(fields) ? fields.slice() : [];
    if (!this.data.fields.length) this.hooks.warn('[brain] meta.fields missing — every L1 field index falls to 0');
    this.data.nSites = n;
    if (meta && Number.isFinite(meta.n_sites) && meta.n_sites !== n) this.hooks.warn(`[brain] meta.n_sites ${meta.n_sites} != ${n} rows — using the rows`);
    this.lemma = new Array(n); this.saga = new Array(n); this.field = new Array(n); this.speech = new Array(n);
    this.who = new Array(n); this.textLower = new Array(n); this.rej = new Set();
    for (let k = 0; k < n; k++) {
      const r = rows[k];
      this.lemma[k] = r.lemma;
      this.saga[k] = String(r.saga);                     // site_saga = [str(s) for s in l0["saga"]]
      this.field[k] = r.field;
      this.speech[k] = Boolean(r.speech);
      this.who[k] = new Set(Array.isArray(r.who) ? r.who : []);   // persons_in_window split on ';'
      this.textLower[k] = pyLower(String(r.text == null ? '' : r.text));
      if (r.kwd === 'rej') this.rej.add(k);               // parse-rejected keywords (excluded from braids)
    }
    this.stats = this._siteStats(rows);
    this.loaded = true;
    this._readyResolve(this);
  }
  /**
   * v3 (brain.py §stats, L112–132, 2026-10-12): the bed's three statistics per site — feel · focus · change, np.round 4 as the
   * wire carries them. brain.py computes them at boot from its UN-rounded normalised drivers; this brain never sees those,
   * only sites.json's 4-dp ones, so: rows that carry 19 drivers (a v3 sites.json, or vizData's after a recompute) bring
   * them in slots 16..18, computed by their producer (brain.py _gen_viz_data / hugur_vizdata.js) from the un-rounded
   * drivers in reading order — read as they are, the only exact source; rows with 16 (a pre-v3 sites.json, until it is
   * regenerated at gen 9) get them derived by siteStats over the rounded 15 and the rows' sagas, in row order — the same
   * rule on 4-dp inputs (|Δ| vs the desktop up to that rounding) — and a warning says so. `source` says which.
   */
  _siteStats(rows) {
    const n = rows.length;
    const v3 = n > 0 && rows.every((r) => Array.isArray(r.drivers) && r.drivers.length >= DRIVER_DIM);
    if (v3) {
      const feel = new Float64Array(n), focus = new Float64Array(n), change = new Float64Array(n);
      for (let k = 0; k < n; k++) {
        const d = rows[k].drivers;
        feel[k] = npRound4(Number(d[STAT_IDX])); focus[k] = npRound4(Number(d[STAT_IDX + 1])); change[k] = npRound4(Number(d[STAT_IDX + 2]));
      }
      return { feel, focus, change, source: 'rows' };
    }
    const d15 = rows.map((r) => (Array.isArray(r.drivers) ? r.drivers : []).slice(0, N_DRIVER_COLS).map(Number));
    const st = siteStats(d15, rows);
    if (n) this.hooks.warn(`[brain] sites.json drivers carry ${Array.isArray(rows[0].drivers) ? rows[0].drivers.length : 0} floats (pre-v3): feel · focus · change derived from the rounded drivers — regenerate the data (gen ${VIZ_GEN}) for the exact ones`);
    return { feel: st.feel, focus: st.focus, change: st.change, source: 'derived' };
  }
  /** site_vecs, vocab, lemma_vecs (L102–108) and the BÍN table; accepts raw float32 or already-normalised tables. */
  _bindQueryTables(q) {
    const d = this.data, n = d.nSites;
    if (q.loadErrors) Object.assign(d.loadErrors, q.loadErrors);
    if (q.siteVecs instanceof Float64Array) { d.siteVecs = q.siteVecs; d.dim = q.dim || (n ? d.siteVecs.length / n : 0); }
    else if (q.siteVectorsRaw) {
      const V = q.siteVectorsRaw instanceof Float32Array ? q.siteVectorsRaw : new Float32Array(q.siteVectorsRaw);
      if (n && V.length % n === 0 && V.length > 0) { d.dim = V.length / n; d.siteVecs = normalizeRows(V, n, d.dim); }
      else { d.loadErrors['sites.vectors'] = `${V.length} floats do not divide into ${n} rows`; this.hooks.warn(`[brain] sites.vectors.f32: ${d.loadErrors['sites.vectors']} — no semantic queries`); }
    }
    // the vocabulary: `vocabAll` = the space's whole table (the lemma matrix's rows, in order); `vocab` = what
    // resolveLemma may use — the same table, or the vocabulary floor's filtered Map after a recompute (rebuild's
    // opts.vocab / meta.recompute.vocab; row indices unchanged). fromData copies both; q.keepVocab (load() after a
    // rebuild) leaves a floored `vocab` alone.
    if (q.vocabAll) d.vocabAll = vocabMap(q.vocabAll);
    if (q.vocab) { d.vocab = vocabMap(q.vocab); if (!d.vocabAll) d.vocabAll = d.vocab; }
    else if (q.space && q.space.vocab) { d.vocabAll = vocabMap(q.space.vocab); if (!q.keepVocab || !d.vocab.size) d.vocab = d.vocabAll; }
    const nLemmas = (d.vocabAll || d.vocab).size;            // the lemma matrix is the FULL table's, whatever a floor keeps
    if (q.lemmaVecs instanceof Float64Array) d.lemmaVecs = q.lemmaVecs;
    else if (q.spaceVectorsRaw && nLemmas) {
      const L = q.spaceVectorsRaw instanceof Float32Array ? q.spaceVectorsRaw : new Float32Array(q.spaceVectorsRaw);
      const dim = (q.space && q.space.dim) || d.dim;
      if (dim && L.length === nLemmas * dim) {
        d.lemmaVecs = normalizeRows(L, nLemmas, dim);
        if (!d.dim) d.dim = dim;
        if (d.dim !== dim) { d.loadErrors.space = `space dim ${dim} != site vectors dim ${d.dim}`; this.hooks.warn(`[brain] ${d.loadErrors.space} — no semantic queries`); d.lemmaVecs = null; }
      } else { d.loadErrors.space = `${L.length} floats is not ${nLemmas} × ${dim}`; this.hooks.warn(`[brain] space.vectors.f32: ${d.loadErrors.space} — no semantic queries`); }
    }
    if (q.bin !== undefined) d.bin = q.bin;
    this.queryLoaded = true;
    this._queryReadyResolve(this);
    const pending = this.pendingQueries.splice(0);
    for (const w of pending) this._query(w);
  }
  _queryTables() {
    const d = this.data;
    return { vocab: d.vocab, lemmaVecs: d.lemmaVecs, dim: d.dim, bin: d.bin, siteVecs: d.siteVecs && d.lemmaVecs ? d.siteVecs : null,
      nSites: d.nSites, lemma: this.lemma, textLower: this.textLower };
  }

  /**
   * P2 seam (design §4.3): the page recomputed the sites — new sites.json-shaped rows, a new meta (fields, sagas,
   * layouts…), the new window vectors as raw float32 (n × dim; null → no semantic queries). Keeps master / mute /
   * comb / persons / saga filter / layers / spread; resets sel, level, braid, trajectory, tracked, query_sims (+ its
   * base and the last query); re-announces (state, then hello) and re-sends the current site. The fields, the
   * drivers and their normalisation come with the rows (vizData's `drivers`, meta.fields; v3: the three statistics in
   * slots 16..18, computed over the new l0 in reading order) — _bindRows re-indexes and re-reads `stats`.
   * opts (P2, design §4 + §5.2 step 10):
   *   vocab  the vocabulary floor's filtered vocab (Map lemma → row, or space.json's object; the worker's
   *          loadSpace(…, {minCount}).vocab, or hugur_query.vocabFloor) — resolveLemma then treats a word below the
   *          floor as "not in vocab" (the first BÍN candidate ≥ floor wins, else the surface path); the lemma
   *          matrix stays the full one (row indices unchanged). Omitted, and no meta.recompute.vocab → the WHOLE
   *          vocabulary again (data.vocabAll, kept from load()): the shipped dataset that tx-undo / tx-default
   *          restore queries semantically, whatever floor the list before it had (PORTING_LOG §5.7 F1).
   *   loose  true = the LOOSE strictness: set_level keeps the parse-rejected sites (`rej`) in the braid (the design's
   *          original, recall first); false / omitted = usual (rej skipped while something remains).
   * When the page passes three arguments (viz/index.html adoptDataset), the worker's hints in meta.recompute
   * ({knobs: {strict}, vocab}) stand in for the options; a plain shipped meta has none → usual, the whole vocabulary.
   * `vecs` for the shipped rows = the shipped sites.vectors.f32 (the page keeps it): the semantic path is bound again.
   * Bumps the rows generation: shipped site vectors still downloading in load() are then dropped, not bound.
   */
  rebuild(rows, meta, vecs = null, opts = {}) {
    const wasL1 = this.level === 1;
    const hints = (meta && meta.recompute && typeof meta.recompute === 'object') ? meta.recompute : {};
    this._gen += 1;
    this._bindRows(rows, meta, Array.isArray(meta && meta.fields) ? meta.fields : null);
    this.data.siteVecs = null;
    this._bindQueryTables(vecs ? { siteVectorsRaw: vecs } : {});
    const vocab = opts && opts.vocab !== undefined ? opts.vocab : hints.vocab;
    this.data.vocab = vocab ? vocabMap(vocab) : (this.data.vocabAll || this.data.vocab);
    this.loose = opts && opts.loose !== undefined ? Boolean(opts.loose) : Boolean(hints.knobs && hints.knobs.strict === 'loose');
    this.sel = 0; this.level = 0; this.l1_traj = []; this.l1_step = 0; this.braid = []; this.tracked = []; this.query_sims = null;
    this.query_z = null; this.last_query = null;
    if (wasL1) { this.osc('/dark/l1/end', []); this.osc('/dark/level', [i(0)]); }
    this.announce();
    this.send_site(this.sel);
  }

  // ------------------------------------------------------------------- comms --
  get n() { return this.data.nSites; }
  get fields() { return this.data.fields; }
  osc(address, args) { this.hooks.osc(address, args); }
  deliver(payload) { this.hooks.deliver(payload); }
  clamp(idx) { return Math.max(0, Math.min(this.n - 1, idx)); }    // max(0, min(len(l0) - 1, int(x)))

  /** brain.py L154–156: the 19 numbers (v3) — np.round(drivers[i], 4) (sites.json's `drivers` already are) + round(sim, 4) +
   *  np.round(stats[i], 4) (this.stats: feel, focus, change). */
  driver_vec(k) {
    const row = this.data.rows[k].drivers;
    const sim = this.query_sims !== null ? this.query_sims[k] : 0.0;
    const out = new Array(DRIVER_DIM);
    for (let c = 0; c < N_DRIVER_COLS; c++) out[c] = npRound4(Number(row[c]));
    out[SIM_IDX] = pyRound4(sim);
    const st = this.stats;
    out[STAT_IDX] = npRound4(st.feel[k]); out[STAT_IDX + 1] = npRound4(st.focus[k]); out[STAT_IDX + 2] = npRound4(st.change[k]);
    return out;
  }
  state_payload() {                                        // L227–231 (+ layers, spread: 2026-10-08)
    return { type: 'state', sel: this.sel, level: this.level, comb: this.comb, tracked: this.tracked.slice(),
      master: this.muted ? 0.0 : this.master, layers: { ...this.layers }, spread: this.spread };
  }
  helloPayload() {                                         // L241
    return { type: 'hello', fields: this.fields.slice(), n_sites: this.n };
  }
  push_state() { this.deliver(this.state_payload()); }    // L232–233
  send_site(k) {                                           // L283: /dark/drivers i + 19 f (v3)
    this.osc('/dark/drivers', [i(k), ...this.driver_vec(k).map(f)]);
  }
  /**
   * The bridge's two sticky messages at boot (design §1.5, §2.8), in bridge.py's order: STICKY = ("state", "hello",
   * "query_result") is replayed to a new client in that order, and brain.py main() pushes state before the
   * heartbeat's first hello — so state, then hello.
   */
  announce() { this.push_state(); this.deliver(this.helloPayload()); }
  /**
   * What the page said while SuperCollider was not there (design §1.5): master, mute, the faders that moved (in
   * LAYER_NAMES order; a gain of 1 is SC's own default), level, the current site. The spread needs no message of its
   * own: SC only ever sees γ through the drivers' slot 15, which send_site carries.
   */
  replay() {
    this.osc('/dark/master', [f(this.master)]);
    if (this.muted) this.osc('/dark/mute', [i(1)]);
    for (const k of LAYER_NAMES) if (this.layers[k] !== 1) this.osc('/dark/layer', [s(k), f(this.layers[k])]);
    if (this.level === 1) this.osc('/dark/level', [i(1)]);
    this.send_site(this.sel);
  }

  // ---------------------------------------------------------------- dispatch --
  /** A page message, flattened as bridge.py relays it, to the ported handler (positional args, like *args). */
  dispatch(m) {
    const flat = flattenPageMessage(m);
    if (!flat) return;
    if (flat.addr === '/dark_nav') this.on_nav(flat.args);
    else if (flat.addr === '/dark_query') this.on_query(flat.args);
    else if (flat.addr === '/dark_legend') this.on_legend(flat.args);
  }

  // ---------------------------------------------------------------- handlers --
  /** brain.py L264–321 `on_nav(_addr, *args)`. An unknown cmd or a missing required argument is a silent no-op. */
  on_nav(args) {
    const cmd = args.length ? pyStr(args[0]) : '';
    if (cmd === 'select' && args.length > 1) {
      const v = pyInt(args[1]); if (v === null) return;
      const idx = this.clamp(v);
      if (this.level === 1) {
        if (this.l1_traj.includes(idx)) {                   // jump within the braid
          this._l1_go(this.l1_traj.indexOf(idx));
          this.push_state();
        }
        return;                                             // a select outside the braid at L1: ignored, no push
      }
      this.sel = idx;
      this.send_site(this.sel);
      this.push_state();
    } else if (cmd === 'hover' && args.length > 1) {
      const v = pyInt(args[1]); if (v === null) return;
      this.send_site(this.clamp(v));                        // no state change, no push, allowed at L1
    } else if (cmd === 'next' || cmd === 'prev') {
      const step = cmd === 'next' ? 1 : -1;
      if (this.level === 1) {                               // L1 = the user walks the braid (clamped at the ends: re-fires)
        this._l1_go(this.l1_step + step);
      } else {
        this.sel = pyMod(this.sel + step, this.n);          // wraps
        this.send_site(this.sel);
      }
      this.push_state();
    } else if (cmd === 'level' && args.length > 1) {
      const words = args.slice(2).map(pyStr).filter(nonEmpty);
      if (words.length) this.braid = words;                 // braid rides with the command (stale-proof)
      const lvl = pyInt(args[1]); if (lvl === null) return;
      this.set_level(lvl);
    } else if (cmd === 'up') {
      this.set_level(0);
    } else if (cmd === 'track' && args.length > 1) {
      const v = pyInt(args[1]); if (v === null) return;      // NOT clamped: out-of-range entries are filtered in set_level
      const k = this.tracked.indexOf(v);
      if (k >= 0) this.tracked.splice(k, 1); else this.tracked.push(v);
      this.push_state();
    } else if (cmd === 'comb' && args.length > 1) {
      const v = pyInt(args[1]); if (v === null) return;
      this.comb = v;                                        // echoed in state only; zero sound effect
      this.push_state();
    } else if (cmd === 'person') {
      // new form: ["person", mode(any|all), name...]; legacy: ["person", name|""]
      if (args.length > 1 && (pyStr(args[1]) === 'any' || pyStr(args[1]) === 'all')) {
        this.person_mode = pyStr(args[1]);
        this.persons = new Set(args.slice(2).map(pyStr).filter(nonEmpty));
      } else {
        const nm = args.length > 1 ? pyStr(args[1]) : '';
        this.persons = nm ? new Set([nm]) : new Set();
      }
      this.push_state();                                    // the payload does not carry persons
    } else if (cmd === 'braid') {
      this.braid = args.slice(1).map(pyStr).filter(nonEmpty);   // empty list clears; no push, no SC
    } else if (cmd === 'saga') {                            // display filter: args = hidden sagas
      this.saga_off = new Set(args.slice(1).map(pyStr).filter(nonEmpty));
    } else if (cmd === 'master' && args.length > 1) {
      const v = pyFloat(args[1]); if (v === null) return;
      this.master = v;                                      // no clamp here; SC clips 0..1
      this.osc('/dark/master', [f(this.master)]);
      this.push_state();
    } else if (cmd === 'mute' && args.length > 1) {
      const v = pyInt(args[1]); if (v === null) return;
      this.muted = v !== 0;
      this.osc('/dark/mute', [i(this.muted ? 1 : 0)]);
      this.push_state();
    } else if (cmd === 'layer' && args.length > 2) {
      // the page sends {cmd:"layer", name, value}; the bridge flattens idx, value, name in that order → value BEFORE
      // name on the wire. Either order is accepted, by type (brain.py does the same).
      const a = args[1], b = args[2];
      const name = pyStr(typeof a === 'string' ? a : b);
      const v = pyFloat(typeof a === 'string' ? b : a); if (v === null) return;
      if (!hasKey(this.layers, name)) return;              // bed | pad | whisper | events; else ignored
      this.layers[name] = Math.max(0, Math.min(1, v));
      this.osc('/dark/layer', [s(name), f(this.layers[name])]);
      this.push_state();
    } else if (cmd === 'spread' && args.length > 1) {
      // γ, live (no recompute): the live query's sims are re-derived from their stored base and the current site's
      // slot 15 follows; no /dark/query (max z = 1 is γ-invariant), top is the same by monotony, so the page gets
      // the same word / lemma / top with the new sims
      const v = pyFloat(args[1]); if (v === null) return;
      this.spread = Math.max(0.25, Math.min(4, v));
      if (this.query_z !== null) {
        this.query_sims = this._spreadSims(this.query_z);
        this.send_site(this.sel);
        this.deliver(this._queryPayload());
      }
      this.push_state();
    }
  }

  /**
   * brain.py L323–360. L1 is a PLACE, not a playback: the user steps through it and leaves when they choose. The
   * braid = the page's selected query lemmas if any, else the selected site's lemma ∪ the lemmas of every tracked
   * site. Fallback chain (`x or traj`): drop rejects, drop hidden sagas, keep the persons' windows — each stage
   * only if it leaves something. An empty braid: return with no state change, no SC message, no push.
   */
  set_level(lvl) {
    if (lvl === this.level) return;
    if (lvl === 1) {
      let lemmas;
      if (this.braid.length) {                              // selected query words ARE the braid
        lemmas = new Set(this.braid);
      } else {
        lemmas = new Set([String(this.lemma[this.sel])]);
        for (const k of this.tracked) if (k >= 0 && k < this.n) lemmas.add(String(this.lemma[k]));
      }
      let traj = [];
      for (let k = 0; k < this.n; k++) if (lemmas.has(this.lemma[k])) traj.push(k);   // narrative order: index == site_id
      // skip homograph rejects — unless the LOOSE strictness is on (rebuild(…, {loose}), design §4): then every
      // class walks the braid; rej stays a ghost dot for the page
      const noRej = this.loose ? traj : traj.filter((k) => !this.rej.has(k));
      traj = noRej.length ? noRej : traj;
      if (this.saga_off.size) {                             // ferill walks the displayed sagas only
        const shown = traj.filter((k) => !this.saga_off.has(this.saga[k]));
        traj = shown.length ? shown : traj;
      }
      if (this.persons.size) {                              // emotion × person(s): union or co-presence
        const P = Array.from(this.persons);
        const t2 = this.person_mode === 'all'
          ? traj.filter((k) => P.every((p) => this.who[k].has(p)))
          : traj.filter((k) => P.some((p) => this.who[k].has(p)));
        traj = t2.length ? t2 : traj;
      }
      if (!traj.length) return;
      this.level = 1;
      this.l1_traj = traj;
      this.osc('/dark/level', [i(1)]);
      this.osc('/dark/l1/start', [i(this.sel), i(traj.length)]);   // sel = the anchor BEFORE the walk
      this.deliver({ type: 'l1_info', lemmas: pySortedStrings(lemmas), n: traj.length });
      this._l1_go(traj.includes(this.sel) ? traj.indexOf(this.sel) : 0);
    } else {
      this.level = 0;
      this.l1_traj = [];
      this.osc('/dark/l1/end', []);
      this.osc('/dark/level', [i(0)]);
      this.send_site(this.sel);                             // wherever the walk left it; no anchor restore
    }
    this.push_state();
  }

  /** brain.py L362–376: one step of the walk. Never pushes state itself; its callers do. */
  _l1_go(k) {
    const traj = this.l1_traj;
    if (!traj.length) return;
    this.l1_step = Math.max(0, Math.min(traj.length - 1, Math.trunc(k)));
    const sid = traj[this.l1_step];
    this.sel = sid;                                         // the selection walks with the user
    const at = this.fields.indexOf(this.field[sid]);
    const fi = at >= 0 ? at : 0;
    this.send_site(sid);
    this.osc('/dark/l1/tok', [
      i(this.l1_step), f(0.3 + 0.5 * fi / Math.max(this.fields.length - 1, 1)), f(0.5), i(1),
      i(fi), i(this.speech[sid] ? 1 : 0)]);
    this.deliver({ type: 'l1_tick', site: sid, t: this.l1_step, n: traj.length, lemma: String(this.lemma[sid]) });
  }

  /** brain.py L378–417 `on_query(_addr, *args)`; the computation is hugur_query.runQuery. */
  on_query(args) {
    const word = args.length ? pyLower(pyStrip(pyStr(args[0]))) : '';
    if (!word) return;
    if (!this.queryLoaded) { this.pendingQueries.push(word); return; }   // answered when the query assets land (§4.1)
    this._query(word);
  }
  _query(word) {
    const res = runQuery(word, this._queryTables());
    if (!res.hit) {                                         // L399–402: the 5-field payload, no 'surface', nothing else
      this.deliver({ type: 'query_result', word, lemma: null, sims: [], top: [] });
      return;
    }
    this.query_z = res.z;                                   // the γ-free base (WEB_P2_DESIGN.md §4); runQuery knows no γ — the brain owns it (_spreadSims)
    this.query_sims = this._spreadSims(res.sims);           // persists for every later driver_vec (slot 15) and the halo
    this.osc('/dark/query', [f(res.simMax)]);               // max z: γ never reaches the glide
    this.send_site(this.sel);                               // refresh sim dim of current site
    this.last_query = { word, lemma: res.lemma, top: res.top, surface: res.surface };   // top is argTop(z): z ** γ is monotone
    this.deliver(this._queryPayload());
  }
  /** q = z ** γ: monotone, 0 → 0, 1 → 1; γ = 1 is z itself (no pow: bit-identical to before the knob). brain.py _spread_sims. */
  _spreadSims(z) {
    if (this.spread === 1) return z;
    const q = new Float64Array(z.length);
    for (let k = 0; k < z.length; k++) q[k] = Math.pow(z[k], this.spread);
    return q;
  }
  _queryPayload() {                                         // brain.py _query_payload
    const q = this.last_query;
    return { type: 'query_result', word: q.word, lemma: q.lemma, sims: Array.from(this.query_sims, pyRound3),
      top: q.top.slice(), surface: q.surface };
  }

  /** brain.py L461–495 `on_legend(_addr, *args)`: previews through the live addresses; no payloads, no state. */
  on_legend(args) {
    const cmd = args.length ? pyStr(args[0]) : '';
    if (cmd === 'iso' && args.length > 1) {
      // one driver isolated; optional value (default high). Neutral register and presence unless the isolated
      // driver IS one of those axes.
      const vec = new Array(DRIVER_DIM).fill(0.0);
      const fi = pyInt(args[1]); if (fi === null) return;
      const val = args.length > 2 ? pyFloat(args[2]) : 1.0; if (val === null) return;
      if (fi >= 0 && fi < DRIVER_DIM && fi !== 15) vec[fi] = val;   // brain.py L545: 0..18 but 15 (the live sim, not isolable); 16..18 the bed's statistics
      if (fi !== 14) vec[14] = 0.5;                         // narrative position: mid register
      vec[15] = 0.5;                                        // query closeness: mid presence
      this.osc('/dark/legend', [s('iso'), ...vec.map(f)]);
    } else if (cmd === 'demo' && args.length > 1) {
      // one-shot event demos — reuse the LIVE addresses, zero new SC surface
      const what = pyStr(args[1]);
      if (what === 'glide') {
        this.osc('/dark/query', [f(0.7)]);
      } else if (what === 'step') {
        this.osc('/dark/l1/tok', [i(0), f(0.62), f(0.3), i(1), i(3), i(0)]);
      } else if (what === 'ping') {
        // momentary experiencer spike through the cooking fn fires the ping
        const vec = new Array(DRIVER_DIM).fill(0.0);
        vec[12] = 0.9; vec[14] = 0.5; vec[15] = 0.5;
        this.osc('/dark/legend', [s('iso'), ...vec.map(f)]);
        this.hooks.timer(250, () => this.osc('/dark/legend', [s('end')]));
      }
    } else if (cmd === 'hold' && args.length > 2) {
      // v3 (brain.py L565–571, WEB_PLAN §13.3): the legend's less · more — the CURRENT site's vector (the live sim at 15)
      // with ONE value pushed to 0 (dir 0) or 1 (dir 1), sent as an iso: the parser previews it like any iso, `end` restores
      const fi = pyInt(args[1]); if (fi === null) return;    // fi, d = int(args[1]), int(args[2]): either raising → nothing sent
      const d = pyInt(args[2]); if (d === null) return;
      const vec = this.driver_vec(this.sel);
      if (fi >= 0 && fi < DRIVER_DIM) vec[fi] = d ? 1.0 : 0.0;
      this.osc('/dark/legend', [s('iso'), ...vec.map(f)]);
    } else if (cmd === 'site' && args.length > 1) {
      const v = pyInt(args[1]); if (v === null) return;
      const k = this.clamp(v);
      this.osc('/dark/legend', [s('site'), ...this.driver_vec(k).map(f)]);
    } else if (cmd === 'solo' && args.length > 1) {
      this.osc('/dark/legend', [s('solo'), s(pyStr(args[1]))]);
    } else {
      this.osc('/dark/legend', [s('end')]);
    }
  }
}

export default HugurBrain;
