// Uncanny Listening — the knob model off the page (brief §3.4: "retraining must be fast enough to follow a knob … in a worker").
// in: {type: "data", rows, segs, cols, fam} once per analysis; {type: "run", id, y, K, gains, C, thr} per knob turn
// out: {type: "result", id, ...run()} · {type: "error", id, error}
import { run } from "./model.js";
let D = null;
self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === "data") { D = { rows: m.rows.map((r) => Float64Array.from(r)), segs: m.segs.map((r) => Float64Array.from(r)), cols: m.cols, fam: m.fam }; return; }
  if (m.type !== "run" || !D) return;
  try { self.postMessage({ type: "result", id: m.id, ...run({ ...D, y: m.y, K: m.K, gains: m.gains, C: m.C, thr: m.thr }) }); }
  catch (e) { self.postMessage({ type: "error", id: m.id, error: String(e && e.stack || e) }); }
};
