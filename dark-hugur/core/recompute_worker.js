// recompute_worker.js — the in-browser recompute of dark_hugur's sites tables (P2; lab/WEB_P2_DESIGN.md §5,
// WEB_PLAN.md §10.3): a MODULE Web Worker that the page's text tab drives through window.__darkWeb.recompute
// (web_page.js). The pipeline is the one the desktop runs in preprocess.py, ported module by module:
//
//   loadLexicon → loadSpace(floor) → stageSites(window, sagas) → filterSites(strictness) → attachLayoutsAsync
//   (pca · umap-js · k-means · [tsne-js] · som (epoch cap) · grammar pca) → vizData → {sites, tokens, meta, vecs}
//
// Messages (main → worker):
//   {type:"init",      cancelFlag?: SharedArrayBuffer}           the cross-thread cancel flag (Int32: the latest jobId)
//   {type:"recompute", jobId, dataBase, sagas:[ids], lexicon:{fields:[{lemma,field,weight,notes}], experiencer:[…]},
//                      knobs:{window, floor, strict, spread?}, layouts?:{umap, tsne, somEpochs}, manifest?:{methods,
//                      lexicon_hash}, debug?:{raw}}               a new recompute cancels the running one
//   {type:"cancel",    jobId?}                                    cancel the running job
//   {type:"evict",     sagas:[ids]}                               drop parsed tables from the cache
// Messages (worker → main):
//   {type:"progress",  jobId, stage, done, total, pct, ms, label}
//   {type:"done",      jobId, sites, tokens, entities, meta, vecs (Float32Array, transferred), siteCount, n, dim,
//                      status, timings, knobs, sagas, vocab (Map), listId, experTally, keywordTally, late, l0?, l1?}
//   {type:"tsne",      jobId, tsne:{coords:[[x,y]…] (4 dp, normalised as vizData does), layout, label, ms}}
//                                                                 the deferred t-SNE (see TSNE_* below), after "done"
//   {type:"cancelled", jobId}  ·  {type:"error", jobId, stage, message}
//
// The per-saga tables (<saga>.tokens.json.gz, <saga>.sentences.json.gz), space.json + space.vectors.f32,
// corpus.json and meta.json are fetched from dataBase (gzip-aware, like web_page.js's loader) and memoised for the
// worker's life; the token tables never leave the worker. Cancellation: the generation counter (a cancel or a newer
// recompute message, served between the awaited macrotasks of attachLayoutsAsync) and, when the page is
// cross-origin isolated, the SharedArrayBuffer flag main writes BEFORE posting — polled inside the synchronous
// loops too (tsne-js cannot yield). Everything exported here is DOM-free and runs in Node (probe/selftest_recompute.mjs
// runs runRecompute over data/ with a file loader); the worker glue at the bottom only runs inside a Worker.
//
// t-SNE (measured 2026-10-08, Node 26: tsne-js costs ≈ 40 ms per iteration at 547 sites, ∝ n² — 41 s for the two
// sagas, ≈ 12 min for 41): it never holds the picture back. layouts.tsne: 'later' (the page's tick, P3 §11.2) → the
// result is posted without t-SNE (vizData drops the tab, honestly), then tsne-js runs while the page shows the new
// picture and a {type:"tsne"} message follows WHATEVER the size (inline when the projection is ≤ TSNE_INLINE_MS;
// never skipped — the page's stop ends it); true keeps the P2 budget (later ≤ TSNE_LATER_BUDGET_MS, else skipped;
// status.tsne says which, with the projected seconds); "inline" forces it before "done" (the gate's path); false
// skips it. A newer job cancels a deferred t-SNE like any other step. After a job is done the loader evicts the
// parsed tables of the sagas not in the job (memory follows the selection; status.evicted lists them).

import { loadLexicon, loadSpace, stageSites, countSites } from './hugur_sites.js';
import { attachLayoutsAsync, makeUmapHook, makeTsneHook, tsneProjectedMs, cancelError, isCancelled } from './hugur_layouts.js';
import { vizData, normColumn } from './hugur_vizdata.js';
import { pyRound4 } from './hugur_drivers.js';

export const GZIPPED = /(^|\/)(sites|tokens|bin|[^/]+\.(tokens|sentences))\.json$/;   // ships only as .gz (build_web.py GZIP)
export const STRICTNESS = Object.freeze(['loose', 'usual', 'strict']);
export const TSNE_INLINE_MS = 3000;          // projected tsne-js time at or below which it runs before "done"
export const TSNE_LATER_BUDGET_MS = 60000;   // … at or below which it runs after "done" (two sagas ≈ 41 s); above: skipped — layouts.tsne === true only (P2); 'later' never skips
export const STAGE_LABELS = Object.freeze({
  fetch: 'loading', inflate: 'unpacking', parse: 'reading', sites: 'scanning', filter: 'sifting', pca: 'placing sites (pca)',
  kmeans: 'placing sites (k-means)', umap: 'placing sites (umap)', tsne: 'placing sites (t-sne)', som: 'placing sites (som)',
  gpca: 'placing sites (grammar pca)', vizdata: 'drawing',
});
// stage weights for the overall pct (fetch+parse 20 · sites 15 · pca 5 · umap 25 · kmeans 10 · som 20 · gpca 2 · vizdata 3)
const STAGE_PCT = { fetch: [0, 12], parse: [12, 20], sites: [20, 35], filter: [35, 36], pca: [36, 41], umap: [41, 66], kmeans: [66, 76], tsne: [76, 76], som: [76, 95], gpca: [95, 97], vizdata: [97, 100] };

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const yieldNow = () => new Promise((r) => setTimeout(r, 0));

// ----------------------------------------------------------------------------------------------- loaders --

/**
 * The gzip-aware, memoised fetch loader (web_page.js's json(), worker-side): json(name) and bytes(name) relative to
 * `base` (an absolute URL or one relative to the worker's parent folder — "data/" → <web_implementation>/data/).
 * The names of GZIPPED fetch "<name>.gz" and inflate through DecompressionStream. evict(names) forgets entries.
 */
export function makeFetchLoader(base, { onFile } = {}) {
  const root = typeof self !== 'undefined' && self.location ? new URL('../', self.location.href) : undefined;
  const baseUrl = new URL(String(base || 'data/'), root);
  const memo = new Map();
  const url = (name) => new URL(name, baseUrl).href;
  async function fetchBuf(name) {
    const gz = GZIPPED.test(name);
    const t0 = now();
    const r = await fetch(url(gz ? name + '.gz' : name));
    if (!r.ok) throw new Error(`${name}${gz ? '.gz' : ''}: HTTP ${r.status}`);
    let buf;
    if (gz) {
      if (typeof DecompressionStream !== 'function') throw new Error('DecompressionStream is not available in this browser');
      buf = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    } else buf = await r.arrayBuffer();
    if (onFile) onFile(name, buf.byteLength, now() - t0);
    return buf;
  }
  const loader = {
    base: baseUrl.href,
    json(name) {
      if (!memo.has(name)) {
        const p = fetchBuf(name).then((buf) => {
          const t0 = now();
          const o = JSON.parse(new TextDecoder().decode(buf));
          loader.parseMs.set(name, now() - t0);
          return o;
        });
        p.catch(() => memo.delete(name));
        memo.set(name, p);
      }
      return memo.get(name);
    },
    bytes(name) {
      if (!memo.has(name)) { const p = fetchBuf(name); p.catch(() => memo.delete(name)); memo.set(name, p); }
      return memo.get(name);
    },
    has: (name) => memo.has(name),
    evict(names) { for (const n of names) { memo.delete(`${n}.tokens.json`); memo.delete(`${n}.sentences.json`); } },
    sagas() {                                  // the sagas whose tables are memoised (either file), for the eviction after a job
      const out = new Set();
      for (const k of memo.keys()) { const m = /^(.+)\.(tokens|sentences)\.json$/.exec(k); if (m) out.add(m[1]); }
      return Array.from(out);
    },
    parseMs: new Map(),
  };
  return loader;
}

/** After a job: forget the memoised tables of every saga NOT in `keep` (memory follows the selection). Returns the
 *  evicted saga names; a loader without sagas()/evict() (a bare file loader) evicts nothing. */
export function evictOthers(loader, keep) {
  if (!loader || typeof loader.sagas !== 'function' || typeof loader.evict !== 'function') return [];
  const want = new Set(Array.from(keep || [], String));
  const drop = loader.sagas().filter((s) => !want.has(s));
  if (drop.length) loader.evict(drop);
  return drop;
}

// ---------------------------------------------------------------------------------------------- pipeline --

/** A form's BÍN readings (`kw_candidates`, `;`-joined) count: the strict rule keeps an `unk` site only when its form has ONE. */
function candidateCount(row) {
  const s = row.kw_candidates == null ? '' : String(row.kw_candidates);
  if (!s) return 0;
  let n = 0;
  for (const c of s.split(';')) if (c) n++;
  return n;
}

/**
 * The disambiguation strictness (design §4), pure: {l0, l1, vecs, dim} → the same shape over the kept rows.
 *   usual  = every site (today, bit-identical: the arrays are returned as they are)
 *   strict = keep kw_disamb === 'ok' or ('unk' and the form has a single BÍN candidate); site_id renumbered 0..m−1
 *            (rows copied, key order kept), l1 filtered + renumbered, vecs sliced
 *   loose  = every site, like usual; the brain's braid keeps the rej sites (rebuild(…, {loose}))
 * Returns {l0, l1, vecs, dim, kept, dropped, rule, strict}. Layout columns must NOT be attached yet (they are fitted
 * over the kept rows afterwards; position is rewritten by attachLayouts).
 */
export function filterSites({ l0, l1, vecs, dim }, strict = 'usual') {
  if (!STRICTNESS.includes(strict)) throw new RangeError(`filterSites: strict must be one of ${STRICTNESS.join(' | ')} (got ${JSON.stringify(strict)})`);
  if (strict !== 'strict') return { l0, l1, vecs, dim, kept: l0.length, dropped: 0, rule: 'every site', strict };
  const keep = new Map();                       // old site_id → new
  const outL0 = [];
  for (const r of l0) {
    const ok = r.kw_disamb === 'ok' || (r.kw_disamb === 'unk' && candidateCount(r) <= 1);
    if (!ok) continue;
    const id = outL0.length;
    keep.set(r.site_id, id);
    outL0.push({ ...r, site_id: id });          // key order preserved: site_id keeps its slot
  }
  const outL1 = [];
  for (const t of l1) {
    const id = keep.get(t.site_id);
    if (id !== undefined) outL1.push({ ...t, site_id: id });
  }
  let outVecs = vecs;
  if (vecs && dim) {
    outVecs = new Float32Array(outL0.length * dim);
    for (let pos = 0; pos < l0.length; pos++) {              // vecs rows are in l0's row order (= site_id 0..n−1)
      const id = keep.get(l0[pos].site_id);
      if (id === undefined) continue;
      outVecs.set(vecs.subarray(pos * dim, pos * dim + dim), id * dim);
    }
  }
  return { l0: outL0, l1: outL1, vecs: outVecs, dim, kept: outL0.length, dropped: l0.length - outL0.length,
    rule: "kw_disamb ok, or unk with a single BÍN candidate", strict };
}

/** Per experiencer verb: how many window tokens (L1 rows) carry that lemma — a cheap tally for the editor's counts column. */
export function experiencerTally(l1, exper) {
  const set = exper instanceof Set ? exper : new Set(exper || []);
  const out = {};
  for (const lm of set) out[lm] = 0;
  for (const t of l1) if (set.has(t.lemma)) out[t.lemma] += 1;
  return out;
}

/** Per keyword lemma: the number of sites (and how many of them the parser rejected) — the word list's counts column. */
export function keywordTally(l0) {
  const out = {};
  for (const r of l0) {
    const e = out[r.keyword_lemma] || (out[r.keyword_lemma] = { sites: 0, rej: 0, unk: 0 });
    e.sites += 1;
    if (r.kw_disamb === 'rej') e.rej += 1;
    else if (r.kw_disamb === 'unk') e.unk += 1;
  }
  return out;
}

/** sha256 of the canonical list → 10 hex (the lexicon id when the page sends none); FNV-1a 32 bit where crypto.subtle is absent. */
export async function lexiconId(lexicon) {
  const rows = (lexicon && lexicon.fields) || [];
  const canon = rows.map((r) => [r.lemma, r.field, r.weight, r.notes || ''].join('\t')).concat((lexicon && lexicon.experiencer) || []).join('\n');
  const subtle = typeof crypto !== 'undefined' && crypto.subtle;
  if (subtle) {
    const h = await subtle.digest('SHA-256', new TextEncoder().encode(canon));
    return Array.from(new Uint8Array(h)).slice(0, 5).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let x = 0x811c9dc5;
  for (const ch of canon) { x ^= ch.codePointAt(0); x = Math.imul(x, 0x01000193) >>> 0; }
  return x.toString(16).padStart(8, '0') + '00';
}

/** The vendored libraries through their ESM shims (vendor/*.esm.js, generated by build_web.py): {UMAP, TSNE} or nulls. */
export async function loadLibs(vendorBase, { umap = true, tsne = true } = {}) {
  const root = typeof self !== 'undefined' && self.location ? new URL('../', self.location.href) : undefined;
  const base = new URL(String(vendorBase || 'vendor/'), root);
  const libs = { UMAP: null, TSNE: null, errors: {} };
  if (umap) {
    try { const m = await import(new URL('umap-js.esm.js', base).href); libs.UMAP = (m.default && m.default.UMAP) || m.UMAP || null; }
    catch (e) { libs.errors.umap = String((e && e.message) || e); }
  }
  if (tsne) {
    try { const m = await import(new URL('tsne.esm.js', base).href); libs.TSNE = typeof m.default === 'function' ? m.default : null; }
    catch (e) { libs.errors.tsne = String((e && e.message) || e); }
  }
  return libs;
}

/** The t-SNE plan for n sites and the job's layouts.tsne (true | 'later' | 'inline' | false):
 *    'later'  (the page's tick, P3) inline when the projection is ≤ TSNE_INLINE_MS, else later — NEVER skipped
 *    true     (P2) inline ≤ TSNE_INLINE_MS · later ≤ TSNE_LATER_BUDGET_MS · else skipped
 *    'inline' before "done" whatever the size · false / null: off */
export function tsnePlan(n, want, nIter = 1000) {
  if (want === false || want == null) return { mode: 'off', projectedMs: 0 };
  const projectedMs = Math.round(tsneProjectedMs(n, nIter));
  if (want === 'inline') return { mode: 'inline', projectedMs };
  if (want === 'later') return { mode: projectedMs <= TSNE_INLINE_MS ? 'inline' : 'later', projectedMs };
  if (want === true) {
    if (projectedMs <= TSNE_INLINE_MS) return { mode: 'inline', projectedMs };
    if (projectedMs <= TSNE_LATER_BUDGET_MS) return { mode: 'later', projectedMs };
    return { mode: 'skipped', projectedMs };
  }
  throw new RangeError(`layouts.tsne must be true | false | 'inline' | 'later' (got ${JSON.stringify(want)})`);
}

/**
 * The recompute itself, DOM-free (design §5.2 steps 1–8). env: {loader: {json, bytes}, post(progressMessage),
 * cancelled() → boolean, yield() → Promise, libs: {UMAP, TSNE} | null, debug?}. Returns the "done" payload
 * (vecs a Float32Array; `late` says what follows) plus `runLate()` — the deferred t-SNE, or null.
 */
export async function runRecompute(job, env) {
  const t0 = now();
  const timings = {};
  const post = env.post || (() => {});
  const cancelled = env.cancelled || (() => false);
  const yieldTo = env.yield || yieldNow;
  const loader = env.loader;
  const jobId = job.jobId;
  const knobs = { window: 25, floor: 5, strict: 'usual', spread: 1, ...(job.knobs || {}) };
  const layouts = { umap: true, tsne: true, somEpochs: 'auto', ...(job.layouts || {}) };
  if (!STRICTNESS.includes(knobs.strict)) throw new RangeError(`knobs.strict must be one of ${STRICTNESS.join(' | ')} (got ${JSON.stringify(knobs.strict)})`);
  const floor = Number(knobs.floor);
  if (!Number.isFinite(floor) || floor < 0) throw new RangeError(`knobs.floor must be a non-negative number (got ${JSON.stringify(knobs.floor)})`);
  const check = (stage) => { if (cancelled()) throw cancelError(stage); };
  const progress = (stage, done, total, extra) => {
    const [a, b] = STAGE_PCT[stage] || [0, 0];
    const pct = total ? a + (b - a) * Math.min(1, done / total) : a;
    post({ type: 'progress', jobId, stage, done, total, pct: Math.round(pct), ms: Math.round(now() - t0), label: STAGE_LABELS[stage] || stage, ...(extra || {}) });
  };

  // 0. the corpus order and the shipped meta (methods), the lexicon
  const corpus = await loader.json('corpus.json');
  if (!corpus || !Array.isArray(corpus.sagas)) throw new Error('corpus.json is not {sagas, rows} (re-run build/export_corpus.py)');
  const wanted = new Set(Array.isArray(job.sagas) && job.sagas.length ? job.sagas.map(String) : corpus.sagas);
  const unknown = Array.from(wanted).filter((s) => !corpus.sagas.includes(s));
  if (unknown.length) throw new Error(`sagas not in this corpus: ${unknown.join(', ')}`);
  const sagas = corpus.sagas.filter((s) => wanted.has(s));           // the exporter's processing order, never the page's
  if (!sagas.length) throw new Error('no saga selected');
  const lexicon = job.lexicon;
  if (!lexicon || !Array.isArray(lexicon.fields)) throw new Error('lexicon.fields is required ([{lemma, field, weight, notes}])');
  const lex = loadLexicon(lexicon);
  if (!lex.fieldsMap.size) throw new Error('the word list has no usable row (lemma + field)');
  let shippedMeta = null;
  try { shippedMeta = await loader.json('meta.json'); } catch (_) { shippedMeta = null; }
  const manifest = job.manifest || {};
  const listId = manifest.lexicon_hash || await lexiconId(lexicon);

  // 1. fetch + parse the per-saga tables and the space (memoised in the loader)
  check('fetch');
  const files = [];
  for (const s of sagas) files.push(`${s}.tokens.json`, `${s}.sentences.json`);
  const tFetch = now();
  let fetched = 0;
  const total = files.length + 2;
  progress('fetch', 0, total);
  const tick = () => { fetched++; progress('fetch', fetched, total); };
  const [spaceJson, spaceBuf] = await Promise.all([
    loader.json('space.json').then((v) => { tick(); return v; }),
    loader.bytes('space.vectors.f32').then((v) => { tick(); return v; }),
  ]);
  const tokens = {}, sentences = {};
  await Promise.all(sagas.map(async (s) => {
    const [tk, sn] = await Promise.all([
      loader.json(`${s}.tokens.json`).then((v) => { tick(); return v; }),
      loader.json(`${s}.sentences.json`).then((v) => { tick(); return v; }),
    ]);
    tokens[s] = tk; sentences[s] = sn;
  }));
  timings.fetch = Math.round(now() - tFetch);
  check('parse');
  await yieldTo();

  // 2. the space with the vocabulary floor
  const spaceVectors = new Float32Array(spaceBuf instanceof ArrayBuffer ? spaceBuf : spaceBuf.buffer.slice(spaceBuf.byteOffset, spaceBuf.byteOffset + spaceBuf.byteLength));
  const space = loadSpace(spaceJson, spaceVectors, { minCount: floor });

  // 3. the site counts (progress totals, offsets)
  const counts = {};
  let nSitesTotal = 0;
  for (const s of sagas) { counts[s] = countSites(tokens[s], lex); nSitesTotal += counts[s]; }
  progress('sites', 0, nSitesTotal);
  check('sites');

  // 4. the sites, saga by saga (one yield per saga so a cancel gets through)
  const tSites = now();
  const parts = [];
  let done = 0;
  for (const s of sagas) {
    const part = stageSites({ tokens: { [s]: tokens[s] }, sentences: { [s]: sentences[s] }, lexicon: lex, space, window: knobs.window, sagas: [s] });
    parts.push(part);
    done += counts[s];
    progress('sites', done, nSitesTotal);
    check('sites');
    await yieldTo();
  }
  // concatenate in corpus order with running site_ids (stageSites numbers each part from 0)
  const l0 = [], l1 = [];
  const dim = space.dim;
  let offset = 0;
  for (const part of parts) {
    for (const r of part.l0) { r.site_id += offset; l0.push(r); }
    for (const t of part.l1) { t.site_id += offset; l1.push(t); }
    offset += part.l0.length;
  }
  let vecs = new Float32Array(l0.length * dim);
  { let o = 0; for (const part of parts) { vecs.set(part.vecs, o); o += part.vecs.length; } }
  timings.sites = Math.round(now() - tSites);

  // 5. the strictness
  const tFilter = now();
  const filtered = filterSites({ l0, l1, vecs, dim }, knobs.strict);
  timings.filter = Math.round(now() - tFilter);
  progress('filter', 1, 1, { kept: filtered.kept, dropped: filtered.dropped });
  const L0 = filtered.l0, L1 = filtered.l1;
  vecs = filtered.vecs;
  const n = L0.length;
  const experTally = experiencerTally(L1, lex.exper);
  const keywordTallyOut = keywordTally(L0);
  const metaExtra = { knobs: { ...knobs }, sagas, listId, window: knobs.window, floor, strict: knobs.strict, nVocab: space.nVocab, vocabSize: space.vocab.size,
    vocab: space.vocab, counts, filtered: { kept: filtered.kept, dropped: filtered.dropped, rule: filtered.rule } };

  if (n === 0) {                                                       // nothing to place: the page says "none of these words occur"
    const meta = { gen: 8, fields: lex.fieldNames.slice(0, 8), sagas, n_sites: 0, lexicon_hash: listId,
      methods: manifest.methods || (shippedMeta && shippedMeta.methods) || {}, layouts: [], lexicon: lexicon.fields.filter((r) => r.lemma), recompute: metaExtra };
    timings.total = Math.round(now() - t0);
    return { type: 'done', jobId, sites: [], tokens: {}, entities: [], meta, vecs: new Float32Array(0), siteCount: 0, n: 0, dim,
      status: { umap: 'absent', tsne: 'absent', k: 0 }, timings, knobs, sagas, vocab: space.vocab, listId, experTally, keywordTally: keywordTallyOut,
      late: { tsne: 'off' }, runLate: null };
  }

  // 6. the layouts (separately awaited macrotasks; the SOM one epoch per task; umap-js every 25 epochs)
  const libs = env.libs || { UMAP: null, TSNE: null };
  const umapHook = layouts.umap && libs.UMAP ? makeUmapHook(libs.UMAP) : null;
  const plan = tsnePlan(n, layouts.tsne, layouts.tsneIters);
  const tsneHook = plan.mode === 'inline' && libs.TSNE ? makeTsneHook(libs.TSNE) : null;
  const stageT = {};
  let stageStart = now();
  const onProgress = (stage, d, tot) => {
    if (d === 0 && tot === 1) stageStart = now();
    if (d === tot && tot === 1 && stage !== 'som' && stage !== 'umap' && stage !== 'tsne') timings[stage] = Math.round(now() - stageStart);
    if (d === tot && tot === 1) stageT[stage] = Math.round(now() - stageStart);
    progress(stage, d, tot);
  };
  const tLay = now();
  const status = await attachLayoutsAsync(L0, vecs, n, dim, { umap: umapHook, tsne: tsneHook, somEpochs: layouts.somEpochs, onProgress, cancelled, yield: yieldTo, tsneIters: layouts.tsneIters });
  timings.layouts = Math.round(now() - tLay);
  for (const k of ['pca', 'umap', 'kmeans', 'tsne', 'som', 'gpca']) if (stageT[k] !== undefined) timings[k] = stageT[k];
  if (umapHook && umapHook.last) status.umapRun = umapHook.last;
  if (!libs.UMAP && layouts.umap) status.umapNote = 'umap-js not loaded' + (libs.errors && libs.errors.umap ? ` (${libs.errors.umap})` : '') + ' — emb_0/emb_1 fallback';
  if (plan.mode === 'later') status.tsne = `later (tsne-js, ≈ ${(plan.projectedMs / 1000).toFixed(0)} s after the picture)`;
  else if (plan.mode === 'skipped') status.tsne = `skipped (tsne-js would take ≈ ${(plan.projectedMs / 1000).toFixed(0)} s at ${n} sites)`;
  else if (plan.mode === 'inline' && !libs.TSNE) status.tsne = 'absent (tsne-js not loaded' + (libs.errors && libs.errors.tsne ? `: ${libs.errors.tsne}` : '') + ')';
  status.tsnePlan = plan;
  check('vizdata');

  // 7. the picture
  const tViz = now();
  const umapPending = status.umap === 'fallback';
  const viz = vizData({ l0: L0, l1: L1, entities: null, manifest: { sagas, lexicon_hash: listId, methods: manifest.methods || (shippedMeta && shippedMeta.methods) || {} },
    lexicon, opts: { umapPending, float32: false, warn: (t) => post({ type: 'warn', jobId, text: t }) } });
  timings.vizdata = Math.round(now() - tViz);
  viz.meta.recompute = metaExtra;
  for (const L of viz.meta.layouts) {                               // label honesty (PORTING_LOG §5.7 H5): a layout fitted HERE says by which library;
    if (L.key === 'umap' && status.umap === 'umap-js') L.label = 'semantic · umap (umap-js)';       // the shipped picture's "semantic · umap" is the desktop's umap-learn
    if (L.key === 'tsne' && status.tsne === 'tsne-js') L.label = 'semantic · t-sne (tsne-js)';
  }
  progress('vizdata', 1, 1);
  timings.total = Math.round(now() - t0);

  const result = { type: 'done', jobId, sites: viz.sites, tokens: viz.tokens, entities: viz.entities, meta: viz.meta, vecs, siteCount: n, n, dim,
    status, timings, knobs, sagas, vocab: space.vocab, listId, experTally, keywordTally: keywordTallyOut, late: { tsne: plan.mode === 'later' ? 'pending' : plan.mode } };
  if (job.debug && job.debug.raw) { result.l0 = L0; result.l1 = L1; }

  // 8. the deferred t-SNE: a function the caller runs after posting "done". `M` = the site vectors to use: the worker
  //    glue passes a COPY it took before transferring result.vecs to main (a transferred buffer is detached here);
  //    a caller that did not transfer (Node) may omit it.
  result.runLate = plan.mode === 'later' && libs.TSNE ? async (M = vecs) => {
    const tT = now();
    if (!(M instanceof Float32Array) || M.length !== n * dim) throw new Error(`runLate: needs the n × dim site vectors (got ${M && M.length} floats; the buffer was transferred?)`);
    const hook = makeTsneHook(libs.TSNE);
    check('tsne');
    const pcaScores = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) { pcaScores[i * 2] = L0[i].emb_0; pcaScores[i * 2 + 1] = status.k > 1 ? L0[i].emb_1 : 0; }
    const T = hook(M, n, dim, { cancelled, onProgress: (st, d, tot) => progress('tsne', d, tot, { late: true }), pcaScores, pcaK: 2, nIter: layouts.tsneIters });
    const rows = new Array(n);
    for (let i = 0; i < n; i++) rows[i] = { tsne_x: T[i * 2], tsne_y: T[i * 2 + 1] };
    const xs = normColumn(rows, 'tsne_x', false), ys = normColumn(rows, 'tsne_y', false);   // brain.py norm(): (v − min) / max(max − min, 1e-9)
    const coords = new Array(n);
    for (let i = 0; i < n; i++) coords[i] = [pyRound4(xs[i]), pyRound4(ys[i])];
    return { type: 'tsne', jobId, tsne: { coords, layout: { key: 'tsne', label: 'semantic · t-sne (tsne-js)' }, label: 'tsne-js', ms: Math.round(now() - tT), run: hook.last } };
  } : null;
  return result;
}

// ------------------------------------------------------------------------------------------ worker glue --

const inWorker = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;

if (inWorker) {
  const loaders = new Map();                   // dataBase → loader (the parsed tables live here for the worker's life)
  let libsPromise = null;
  let gen = 0;                                 // the generation: a cancel or a newer recompute bumps it
  let flag = null;                             // Int32Array over the SharedArrayBuffer main writes the latest jobId into
  const post = (m, transfer) => self.postMessage(m, transfer || []);

  const loaderFor = (base) => {
    const key = String(base || 'data/');
    if (!loaders.has(key)) loaders.set(key, makeFetchLoader(key));
    return loaders.get(key);
  };

  async function run(job, myGen) {
    const jobId = job.jobId;
    const cancelled = () => gen !== myGen || (flag !== null && Atomics.load(flag, 0) !== jobId);
    try {
      if (!libsPromise) libsPromise = loadLibs(job.vendorBase || 'vendor/');
      const libs = await libsPromise;
      const loader = loaderFor(job.dataBase);
      const result = await runRecompute(job, { loader, post, cancelled, yield: yieldNow, libs });
      if (cancelled()) throw cancelError('done');
      const { runLate, ...payload } = result;
      payload.status.evicted = evictOthers(loader, payload.sagas);   // memory follows the selection: the tables of the sagas not in this job go (the late t-SNE needs none)
      const keep = runLate && payload.vecs ? payload.vecs.slice() : null;   // the transfer below detaches payload.vecs here
      post(payload, payload.vecs && payload.vecs.buffer ? [payload.vecs.buffer] : []);
      if (runLate) {
        try {
          const late = await runLate(keep);
          if (!cancelled()) post(late);
        } catch (e) {
          if (isCancelled(e)) post({ type: 'cancelled', jobId, stage: 'tsne', late: true });
          else post({ type: 'error', jobId, stage: 'tsne', late: true, message: String((e && e.message) || e) });
        }
      }
    } catch (e) {
      if (isCancelled(e) || cancelled()) post({ type: 'cancelled', jobId, stage: (e && e.message) || 'cancelled' });
      else post({ type: 'error', jobId, stage: (e && e.stage) || 'recompute', message: String((e && e.message) || e), stack: e && e.stack });
    }
  }

  self.onmessage = (ev) => {
    const m = ev.data || {};
    if (m.type === 'init') {
      if (m.cancelFlag && typeof SharedArrayBuffer !== 'undefined' && m.cancelFlag instanceof SharedArrayBuffer) flag = new Int32Array(m.cancelFlag);
      post({ type: 'ready', sab: flag !== null });
    } else if (m.type === 'cancel') {
      gen++;
    } else if (m.type === 'evict') {
      for (const l of loaders.values()) l.evict(m.sagas || []);
    } else if (m.type === 'recompute') {
      const myGen = ++gen;
      run(m, myGen);
    }
  };
}

export default { GZIPPED, STRICTNESS, STAGE_LABELS, TSNE_INLINE_MS, TSNE_LATER_BUDGET_MS, makeFetchLoader, evictOthers, filterSites, experiencerTally, keywordTally,
  lexiconId, loadLibs, tsnePlan, runRecompute };
