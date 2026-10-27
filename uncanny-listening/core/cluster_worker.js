// Uncanny Listening — the other clusterings of Dark Music Corpus's engine (core/engine.js, copied) on the songs' scaled table,
// each with k = the number of classes (HDBSCAN finds its own k), for the agreement table (brief §3.4, unsupervised side).
// in: {rows: Float64Array[], k, y (labels), methods: [{method, ...}]} → out: {results: [{method, labels, info, ari, accuracy | purity}]}
// accuracy: after the Hungarian / flip alignment when the clusters number the classes; purity (each cluster → its majority label) otherwise
import { clustering, ari } from "./engine.js";
import { alignLabels } from "./analysis.js";
self.onmessage = (ev) => {
  const { rows, k, methods, id, y } = ev.data; const X = rows.map((r) => Array.from(r)), out = [];
  for (const m of methods) { try { const r = clustering(X, Object.assign({ k }, m), 42); const lab = Array.from(r.labels), nk = new Set(lab).size, res = { method: m.label || m.method, labels: lab, info: r.info, k: nk, ari: ari(lab, y) };
      if (nk === new Set(y).size) { const A = alignLabels(lab, y); res.accuracy = A.accuracy; res.aligned = Array.from(A.aligned); }
      else { const by = new Map(); lab.forEach((c, i) => { if (!by.has(c)) by.set(c, new Map()); const m2 = by.get(c); m2.set(y[i], (m2.get(y[i]) || 0) + 1); });
        let ok = 0; for (const m2 of by.values()) ok += Math.max(...m2.values()); res.purity = ok / y.length; }
      out.push(res); }
    catch (e) { out.push({ method: m.label || m.method, error: String(e) }); } }
  self.postMessage({ id, results: out });
};
