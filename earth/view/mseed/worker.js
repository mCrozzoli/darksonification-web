// dark_svartsengi · mseed/worker.js — the miniSEED Web Worker (CONTRACT 0.16; DESIGN §6.1 step 3). W3.
//
// Off the page's thread:
//   {id, op: "read", files: [Blob], t0, t1} → {id, segs: [{nslc, t0, fs, data}]} (the sample buffers transferred);
//   {id, op: "features", station, roles, files: {cha: [Blob]}, from, to, keep, state, filters} → the causal engine
//     (engine.js, W1's engine ported, gate: viz/tools/test_engine.mjs) run over [from, to) in W1's 60-s pushes on the
//     T0 grid, from `state` ({engine, pyramid}) when given, else fresh; rows with t >= keep returned by tier, with the
//     state at `to` (so the next day continues exactly). Progress {id, progress: 0..1} along the way;
//   {id, op: "cancel", target} stops a read or a run between blocks / pushes.
/* eslint-env worker */
importScripts("mseed.js", "engine.js");
const ctl = new Map();                                     // request id → AbortController
const FILTERS = new Set();                                 // the tables added (W1's filters.json: one per rate)
self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.op === "cancel") { const c = ctl.get(m.target); if (c) c.abort(); return; }
  const ac = new AbortController(); ctl.set(m.id, ac);
  try {
    if (m.op === "read") {
      const segs = await readFiles(m.files, m.t0, m.t1, ac.signal);
      const out = segs.map((s) => ({ nslc: s.nslc, t0: s.t0, fs: s.fs, data: s.data.slice() }));
      self.postMessage({ id: m.id, segs: out }, out.map((s) => s.data.buffer));
    } else if (m.op === "features") {
      for (const t of m.filters || []) { const k = t.rates ? Object.keys(t.rates).join(",") : String(t.fs); if (!FILTERS.has(k)) { SvkEngine.addFilterTable(t); FILTERS.add(k); } }
      self.postMessage({ id: m.id, ...(await features(m, ac.signal)) });
    } else self.postMessage({ id: m.id, error: `unknown op ${m.op}` });
  } catch (err) {
    self.postMessage({ id: m.id, error: err && err.name === "AbortError" ? "cancelled" : String((err && err.message) || err) });
  } finally { ctl.delete(m.id); }
};
// several files of one or more channels → merged segments in [t0, t1) (the reader's rules: obspy merge -1)
async function readFiles(files, t0, t1, signal) {
  const segs = [];
  for (const f of files) {
    const mf = await new SvkMseed.MseedFile(f).open();
    const [a, b] = await mf.span();
    if (b <= t0 || a >= t1) continue;
    segs.push(...(await mf.read(t0, t1, { signal })));
  }
  return SvkMseed.mergeSegments(segs);
}
const turn = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
async function features(m, signal) {
  const { FeatureEngine, Pyramid, T0 } = SvkEngine, CH = 60, t0 = performance.now();
  const segs = {};
  for (const [cha, fl] of Object.entries(m.files)) { segs[cha] = await readFiles(fl, m.from, m.to, signal); if (signal.aborted) throw new DOMException("cancelled", "AbortError"); }
  const tRead = performance.now() - t0;
  const eng = m.state ? new FeatureEngine(m.station, { state: m.state.engine }) : new FeatureEngine(m.station, { roles: m.roles });
  const pyr = m.state ? new Pyramid(m.station, m.state.pyramid) : new Pyramid(m.station);
  const rows = { f10s: [], f1m: [], f10m: [], f1h: [], f1d: [] };
  const take = (out) => { for (const k of Object.keys(rows)) if (out[k]) for (const r of out[k]) if (r.t >= m.keep) rows[k].push(r); };
  const w0 = T0 + Math.floor((m.from - T0) / CH) * CH, n = Math.ceil((m.to - w0) / CH);
  for (let i = 0; i < n; i++) {
    if (signal.aborted) throw new DOMException("cancelled", "AbortError");
    const a = Math.max(m.from, w0 + i * CH), b = Math.min(m.to, w0 + (i + 1) * CH), tr = [];
    for (const [cha, ss] of Object.entries(segs)) for (const s of SvkMseed.cut(ss, a, b)) tr.push({ cha, fs: s.fs, start: s.t0, data: s.data });
    take(pyr.push(eng.push(tr)));
    // every 20 min of data: report, and let a "cancel" in (a message-channel turn, which no timer throttling slows)
    if (i % 20 === 19) { self.postMessage({ id: m.id, progress: (i + 1) / n }); await turn(); }
  }
  if (m.final) { take(pyr.push(eng.flush())); take(pyr.flush()); }
  return { rows, state: { engine: eng.state(), pyramid: pyr.state() }, stats: eng.stats, ms: { read: Math.round(tRead), engine: Math.round(performance.now() - t0 - tRead) } };
}
