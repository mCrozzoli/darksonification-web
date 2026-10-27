// Uncanny Listening — the page (2026-10-27).
// P0: folders → classes → her preset's features in workers → the desktop's processing (scaling, PCA, density, k-means, align).
// P1: linked maps (PCA + her descriptor pairs, cell 61), selection / brushing / tracing across them, song and segment playback,
//     side panel with tabs, legend, config dock, dark / light / paper looks, EN / ES.
// P2: labels by ear (overrides with provenance, undone one by one), the knob model (core/model.js in a worker), its boundary
//     on every map, agreement between her labels, k-means and the model, the disagreements, the other clusterings, and the
//     songs a knob turn flipped, to hear.
import { t, paint, setLang, getLang, onLang } from "./i18n.js";
import { analyseSongs } from "./pool.js";
import { audioSeconds } from "./decode.js";
import { makeMaps } from "./maps.js";
import { knob } from "./knob.js";
import * as player from "./player.js";
import { COLUMNS, ANA_PRESET } from "../core/darklibrosa.js";
import { desktopL0, alignLabels } from "../core/analysis.js";
import { field as fieldOf } from "../core/model.js";
import { drawTimeline } from "./timeline.js";
import { drawCompare, effect } from "./compare.js";
import * as OUT from "./outputs.js";
import { Link } from "./live.js";

const AUDIO = [".flac", ".wav", ".aif", ".aiff", ".mp3", ".ogg", ".m4a", ".opus"];
const FEATS = COLUMNS;                                           // her preset's 58 columns: 11 descriptors × 5 statistics + tempo, n_beats, beat_density
const SEC_PER_AUDIO_S = 0.044;                                   // measured: one worker, her preset (TESTS P0)
// her descriptor names (notebook cell 61) and the pairs she maps
const FAMILY = { rms: "dinamica", chroma: "armonia", spectral_contrast_0: "timbre", spectral_flux: "complejidad", spectral_centroid: "brillo" };
const PAIRS = [["rms", "chroma"], ["rms", "spectral_flux"], ["rms", "spectral_contrast_0"], ["spectral_flux", "chroma"], ["spectral_flux", "spectral_contrast_0"], ["chroma", "spectral_contrast_0"]];
// the knobs: one per descriptor family (brief §3.4: hers + brillo, then the rest of her preset's columns grouped)
export const FAMILIES = [["dinamica", ["rms"]], ["armonia", ["chroma"]], ["timbre", ["spectral_contrast_0", "spectral_contrast_1"]], ["complejidad", ["spectral_flux"]],
  ["brillo", ["spectral_centroid"]], ["forma", ["spectral_bandwidth", "spectral_rolloff"]], ["ruido", ["zcr", "spectral_flatness"]], ["sonoridad", ["mfcc_0"]], ["ritmo", ["tempo", "n_beats", "beat_density"]]];
const famOf = (c) => { for (const [f, bs] of FAMILIES) if (bs.some((b) => c === b || c.startsWith(b + "_"))) return f; return "otros"; };

export const S = (window.UL = {
  classes: [], files: [], songs: [], formats: "preset", analysis: null, running: false, stop: false,
  view: { mapset: "mean", colour: "class", tab: "data", side: true, live: false, dock: false, boundary: true, work: "maps", cmpLevel: "l0" },
  pair: null,               // a map pair proposed from the descriptor comparison: [x, y]
  sel: new Set(), hover: null, trace: [], brushed: null, k: null,
  overrides: [],            // labels by ear, in order: {id, name, folder, from, to, at}
  model: { gains: Object.fromEntries(FAMILIES.map(([f]) => [f, 1])), C: 1, thr: 0.5, res: null, flips: null, cause: null, n: 0 },
  clusterings: null,
});
const $ = (s) => document.querySelector(s);
const pyCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);          // Python's sorted() on str
const fmtT = (s) => s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
const pct = (v) => `${(100 * v).toFixed(1)} %`;
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const LS = { get(k, d) { try { const v = localStorage.getItem("uncanny." + k); return v == null ? d : JSON.parse(v); } catch (_) { return d; } },
             set(k, v) { try { localStorage.setItem("uncanny." + k, JSON.stringify(v)); } catch (_) {} } };
Object.assign(S.view, LS.get("view", {}), { live: false });
const saveView = () => LS.set("view", { mapset: S.view.mapset, colour: S.view.colour, side: S.view.side, dock: S.view.dock, boundary: S.view.boundary });

// ------------------------------------------------------------------ colours (the style kit's validated sets, per look)
function classColours() {
  const sets = window.DarkStyle ? DarkStyle.sets() : { cat3: ["#2b6da8", "#46b0a4", "#e07b4f"], cat4: [], lines8: [] }, n = S.analysis ? S.analysis.classes.length : 2;
  return n === 2 ? [sets.cat3[0], sets.cat3[2]] : n === 3 ? sets.cat3 : n === 4 ? sets.cat4 : Array.from({ length: n }, (_, i) => sets.lines8[i % 8]);
}
const tok = (n, d) => (window.DarkStyle ? DarkStyle.tok(n) : d) || d;
let rmsRamp = null;
const rampOf = (v) => { if (!rmsRamp) rmsRamp = DarkStyle.ramp(DarkStyle.paperRamps ? DarkStyle.paperRamps.ochre : ["#e9cf84", "#dba04a", "#b85a4b", "#4a2447"]); return rmsRamp(v); };

// ------------------------------------------------------------------ labels: her folders, and her edits by ear
player.onMissing && player.onMissing(() => { $("#status").textContent = t("o_unlinked", { n: S.songs.filter((s) => !s.file).length }); });
export const labelOf = (s) => { for (let i = S.overrides.length - 1; i >= 0; i--) if (S.overrides[i].id === s.id) return S.overrides[i].to; return s.ci; };
function setLabel(s, to) {
  if (labelOf(s) === to) return;
  S.overrides.push({ id: s.id, name: s.name, folder: s.cls, from: labelOf(s), to, at: new Date().toISOString() });
  labelsChanged("label");
}
function undoLabel(k) { S.overrides.splice(k, 1); labelsChanged("undo"); }
function labelsChanged(cause) {
  realign(); runModel(cause); renderSide(); maps && maps.update();
}
function realign() {                                             // k-means stays; its alignment follows her current labels
  if (!S.analysis) return;
  const A = alignLabels(S.songs.map((s) => s.km_raw), S.songs.map(labelOf));
  S.songs.forEach((s, i) => { s.km = A.aligned[i]; });
  Object.assign(S.analysis, { mapping: A.mapping, accuracy: A.accuracy, method: A.method });
}

// ------------------------------------------------------------------ folders → classes
// A folder holding sub-folders with audio: each sub-folder is a class (files at any depth below it).
// A folder holding audio directly (no sub-folders): the folder itself is one class.
function intake(list) {
  const items = Array.from(list).map((f) => ({ file: f, rel: f.webkitRelativePath || f.name })).filter((x) => AUDIO.some((e) => x.file.name.toLowerCase().endsWith(e)));
  for (const x of items) {
    const p = x.rel.split("/"), cls = p.length >= 3 ? p[1] : p[0], root = p.length >= 3 ? p[0] : "";
    if (!S.classes.some((c) => c.name === cls)) S.classes.push({ name: cls, root, on: true });
    const key = `${cls}/${p.slice(p.length >= 3 ? 2 : 1).join("/")}`;
    if (!S.files.some((f) => f.key === key)) S.files.push({ ...x, key, cls, name: x.file.name, ext: x.file.name.slice(x.file.name.lastIndexOf(".")).toLowerCase() });
  }
  S.classes.sort((a, b) => pyCmp(a.name, b.name));
  S.view.tab = "data"; renderAll(); estimate();
}
const accepted = (f) => S.formats === "all" || f.ext === "." + ANA_PRESET.format;
const selectedFiles = () => { const on = S.classes.filter((c) => c.on), ci = new Map(on.map((c, i) => [c.name, i]));
  return { on, ci, files: S.files.filter((f) => ci.has(f.cls) && accepted(f)).sort((a, b) => ci.get(a.cls) - ci.get(b.cls) || pyCmp(a.name, b.name)) }; };
let estTok = 0;
async function estimate() {
  const my = ++estTok, { files } = selectedFiles(); let secs = 0;
  for (const f of files) { secs += await audioSeconds(f.file); if (my !== estTok) return; }
  const w = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 2));
  $("#est").textContent = files.length ? t("est", { t: fmtT(20 + secs * SEC_PER_AUDIO_S / w), h: fmtT(secs) }) : "";
}

// ------------------------------------------------------------------ analyse
async function analyse() {
  const { on, files } = selectedFiles();
  S.songs = files.map((f, i) => ({ id: i, cls: f.cls, ci: on.findIndex((c) => c.name === f.cls), name: f.name, rel: f.rel, file: f.file, size: f.file.size }));
  S.analysis = null; S.sel.clear(); S.trace = []; S.brushed = null; S.overrides = []; S.model.res = null; S.model.flips = null; S.clusterings = null;
  S.running = true; S.stop = false; renderAll(); $("#cancel").hidden = false;
  const status = $("#status"), bar = $("#bar i"), t0 = performance.now();
  const r = await analyseSongs(S.songs, {
    onSong: (song, res) => Object.assign(song, res),
    onProgress: (p) => { if (p.finished != null) { status.textContent = t("decoding", { i: p.finished, n: p.n, name: p.song ? p.song.name : "" }); bar.style.width = `${100 * p.finished / p.n}%`; } },
    cancelled: () => S.stop,
  });
  S.running = false; $("#cancel").hidden = true;
  const good = S.songs.filter((s) => s.l0), bad = S.songs.filter((s) => !s.l0), nSeg = good.reduce((a, s) => a + s.l1.length, 0);
  status.textContent = t("done_in", { n: good.length, m: nSeg, s: fmtT((performance.now() - t0) / 1000) }) + (bad.length ? " · " + t("failed", { n: bad.length }) : "");
  $("#errors").innerHTML = bad.map((s) => `<div>✗ ${esc(s.name)} — ${esc(String(s.error || "").split("\n")[0])}</div>`).join("");
  S.songs = good;
  if (good.length && !S.stop) { process(); S.view.tab = "view"; }
  renderAll();
  return r;
}
// the desktop's L0 processing (uncanny_music.darkproj): every feature column scaled, PCA 3, density, k-means (k = classes), align
function process() {
  const good = S.songs, classes = [...new Set(good.map((s) => s.cls))].sort(pyCmp);
  good.forEach((s) => { s.ci = classes.indexOf(s.cls); });
  const rows = good.map((s) => Float64Array.from(FEATS, (c) => s.l0[c])), k = S.k || classes.length;
  const A = desktopL0(rows, Int32Array.from(good, (s) => s.ci), { k });
  good.forEach((s, i) => { s.pca = A.pca[i]; s.density = A.density[i]; s.km_raw = A.km_raw[i]; s.x = Object.fromEntries(FEATS.map((c, j) => [c, A.scaled[i][j]])); });
  S.analysis = { classes, n: good.length, segments: good.reduce((a, s) => a + s.l1.length, 0), k, explained: A.explained, inertia: A.km_inertia, scaled: A.scaled };
  realign();
  // the 10 s segments' rms, for the strip's colour (scaled over the whole corpus)
  let lo = Infinity, hi = -Infinity; for (const s of good) for (const r of s.l1) { lo = Math.min(lo, r.rms_mean); hi = Math.max(hi, r.rms_mean); }
  let o = 0; for (const s of good) { s.segRms = s.l1.map((r) => (r.rms_mean - lo) / (hi - lo || 1)); s.segStart = o; o += s.l1.length; }
  segScale = null; S.pair = null;
  startModel();
}
S.recompute = () => { if (S.songs.length && S.songs[0].l0) { process(); renderAll(); } };

// ------------------------------------------------------------------ the knob model (core/model_worker.js)
let mw = null, mTimer = null, mId = 0;
function startModel() {
  if (mw) mw.terminate();
  mw = new Worker(new URL("../core/model_worker.js", import.meta.url), { type: "module" });
  mw.onmessage = (ev) => { const m = ev.data; if (m.type === "result" && m.id === mId) applyModel(m); else if (m.type === "error") console.error(m.error); };
  mw.postMessage({ type: "data", rows: S.songs.map((s) => FEATS.map((c) => s.l0[c])), segs: S.songs.flatMap((s) => s.l1.map((r) => FEATS.map((c) => r[c]))), cols: FEATS, fam: FEATS.map(famOf) });
  S.model.res = null; S.model.flips = null; runModel("start", 0);
}
function runModel(cause, delay = 120) {
  if (!mw || !S.analysis) return;
  S.model.cause = cause; clearTimeout(mTimer);
  mTimer = setTimeout(() => { mId++; mw.postMessage({ type: "run", id: mId, y: S.songs.map(labelOf), K: S.analysis.classes.length, gains: S.model.gains, C: S.model.C, thr: S.model.thr }); }, delay);
}
function applyModel(r) {
  const prev = S.model.res ? S.songs.map((s) => s.pred) : null;
  S.songs.forEach((s, i) => { s.p = r.prob[i]; s.pred = r.pred[i]; s.oof = r.oof[i]; s.segP = r.segProb.slice(s.segStart, s.segStart + s.l1.length); s.segPred = r.segPred.slice(s.segStart, s.segStart + s.l1.length); });
  if (prev && S.model.cause !== "start") {
    const ids = S.songs.filter((s, i) => s.pred !== prev[i]).map((s) => s.id);
    S.model.flips = { cause: S.model.cause, ids, from: Object.fromEntries(S.songs.map((s, i) => [s.id, prev[i]])) };
  }
  S.model.res = r; S.model.n++; fieldCache.clear(); liveSchema();
  renderModel(); renderInfo(); renderView(); renderLegend(); maps && maps.update(); if (S.view.work !== "maps") renderWork();
}

// ------------------------------------------------------------------ maps
const mapDefs = () => [{ x: "pca_0", y: "pca_1", big: true }, ...(S.pair ? [{ x: S.pair[0], y: S.pair[1], proposed: true }] : []), ...PAIRS.map(([a, b]) => ({ x: `${a}_${S.view.mapset}`, y: `${b}_${S.view.mapset}` }))];
const base = (axis) => axis.replace(/_(mean|std|median|min|max)$/, "");
const statOf = (axis) => (axis.match(/_(mean|std)$/) || [])[1];
const valueOf = (s, a) => a.startsWith("pca_") ? s.pca[+a.slice(4)] : s.x[a];
function axisLabel(axis) {
  if (axis.startsWith("pca_")) return `PCA ${+axis.slice(4) + 1}` + (S.analysis ? ` (${(100 * S.analysis.explained[+axis.slice(4)]).toFixed(0)} %)` : "");
  return `${t(famOf(axis))} · ${axis}`;
}
function mapTitle(def) {
  if (def.x.startsWith("pca_")) return `<b>PCA</b> <span class="k">· ${t("explained")} ${S.analysis ? S.analysis.explained.slice(0, 2).map((v) => (100 * v).toFixed(0) + " %").join(" + ") : ""}</span>`;
  if (def.proposed) return `<b>${t(famOf(def.x))}</b> <span class="k">${t("vs")}</span> <b>${t(famOf(def.y))}</b> <span class="k">· ${t("proposed")}</span> <button class="btn sm" id="unpair">×</button>`;
  return `<b>${t(FAMILY[base(def.x)])}</b> <span class="k">${t("vs")}</span> <b>${t(FAMILY[base(def.y)])}</b> <span class="k">· ${statOf(def.x) === "std" ? t("maps_std") : t("maps_mean")}</span>`;
}
let maps = null;
const songById = (id) => S.songs.find((s) => s.id === id);
// agreement between her label (L), k-means (K) and the model (M): all agree · k-means differs · model differs · both differ
const agreeCat = (s) => { const L = labelOf(s), a = s.km === L, b = s.pred == null || s.pred === L; return a && b ? 0 : !a && b ? 1 : a && !b ? 2 : 3; };
function colourOf(s) {
  const C = classColours(), cat4 = DarkStyle.sets().cat4;
  if (S.view.colour === "km") return C[s.km % C.length] || tok("--ds-dim", "#888");
  if (S.view.colour === "model") return s.pred != null ? C[s.pred] : tok("--ds-dim", "#888");
  if (S.view.colour === "agree") { const a = agreeCat(s); return a === 0 ? tok("--ds-dim", "#667") : [null, cat4[1], cat4[2], cat4[3]][a]; }
  return C[labelOf(s)];
}
function strokeOf(s) {
  if (S.overrides.some((o) => o.id === s.id)) return tok("--ds-cur-txt", "#fc0");             // a label she changed by ear
  return S.view.colour === "agree" && agreeCat(s) === 3 ? tok("--ds-txt-hi", "#fff") : null;
}
const fieldCache = new Map();
function fieldFor(def) {
  if (!S.view.boundary || !S.model.res || !S.model.res.active) return null;
  const key = def.x + "|" + def.y; if (fieldCache.has(key)) return fieldCache.get(key);
  const C = classColours(), K = S.analysis.classes.length, pts = S.songs.map((s) => [valueOf(s, def.x), valueOf(s, def.y)]);
  let F;
  if (K === 2) {
    const f = fieldOf(pts, S.songs.map((s) => s.p[1])), mix = d3.interpolateRgb(C[0], C[1]);
    F = { nx: f.nx, ny: f.ny, fill: (k) => mix(f.p[k]), alpha: (k) => Math.sqrt(f.dens[k]) * (0.10 + 0.34 * Math.abs(f.p[k] - 0.5) * 2), contours: [{ p: f.p, thr: S.model.thr }] };
  } else {
    const fs = Array.from({ length: K }, (_, c) => fieldOf(pts, S.songs.map((s) => s.p[c]))), nx = fs[0].nx, ny = fs[0].ny;
    const arg = (k) => { let b = 0; for (let c = 1; c < K; c++) if (fs[c].p[k] > fs[b].p[k]) b = c; return b; };
    F = { nx, ny, fill: (k) => C[arg(k)], alpha: (k) => Math.sqrt(fs[0].dens[k]) * (0.10 + 0.34 * (fs[arg(k)].p[k] - 1 / K) / (1 - 1 / K)), contours: fs.map((f) => ({ p: f.p, thr: 0.5 })) };
  }
  fieldCache.set(key, F); return F;
}
function setupMaps() {
  maps = makeMaps($("#maps"), {
    songs: () => S.songs, value: valueOf, colour: colourOf, stroke: strokeOf, label: axisLabel, title: mapTitle,
    sel: () => S.sel, hover: () => S.hover, trace: () => S.trace, brushed: () => S.brushed, field: fieldFor,
    on: {
      hover(id, ev) { S.hover = id; tip(id, ev); maps.update(); if (id != null && link.follow) { const s = songById(id), e = excerpt(s, s.pred); liveStep(s, e.t0, e.t1); } },
      click(id, ev) {
        if (ev.shiftKey) { if (S.trace[S.trace.length - 1] !== id) S.trace.push(id); }
        else { S.sel = new Set([id]); S.brushed = null; player.play(songById(id)); }
        renderSide(); maps.update();
      },
      brush(ids) { S.brushed = ids && ids.size ? ids : null; S.sel = new Set(ids || []); renderSide(); maps.update(); },
    },
  });
}
const modelLine = (s) => s.p ? `${t("model")} ${s.pred === labelOf(s) ? "· " + t("agrees") : "· <b>" + t("disagrees") + "</b>"} <span class="k">(${S.analysis.classes.map((c, i) => `${esc(c)} ${(s.p[i]).toFixed(2)}`).join(" · ")})</span>` : "";
function tip(id, ev) {
  const el = $("#tip"); if (id == null) { el.hidden = true; return; }
  const s = songById(id), C = classColours(), r = $("#work").getBoundingClientRect(), L = labelOf(s);
  el.innerHTML = `<b>${esc(s.name)}</b><div><i class="dot" style="background:${C[L]}"></i>${esc(S.analysis.classes[L])}${L !== s.ci ? ` <span class="k">(${t("edited")})</span>` : ""}</div>
    <div>${t("cluster")} ${s.km} ${s.km === L ? "· " + t("agrees") : "· <b>" + t("disagrees") + "</b>"}</div><div>${modelLine(s)}</div>`;
  el.hidden = false; el.style.left = `${Math.min(ev.clientX - r.left + 14, r.width - 270)}px`; el.style.top = `${ev.clientY - r.top + 12 + $("#work").scrollTop}px`;
}

// ------------------------------------------------------------------ walks: a list of songs, 10 s each
// The excerpt: the 10 s segment the model finds most typical of the class asked for (with no model: the middle segment).
function excerpt(s, cls = null) {
  if (!s.l1.length) return { song: s, t0: 0, t1: Math.min(10, s.duration) };
  let k = Math.floor(s.l1.length / 2);
  if (cls != null && s.segP) { let b = -1; s.segP.forEach((p, i) => { if (p[cls] > b) { b = p[cls]; k = i; } }); }
  return { song: s, t0: s.l1[k].window_start, t1: s.l1[k].window_end, seg: k };
}
let stopWalk = null;
function walkList(ids, clsOf = () => null) {
  if (stopWalk) stopWalk();
  const items = ids.map(songById).filter(Boolean).map((s) => excerpt(s, clsOf(s)));
  stopWalk = player.walk(items, (it) => { if (it) { S.sel = new Set([it.song.id]); renderInfo(); renderView(); maps && maps.update(); } else stopWalk = null; });
}

// walking the boundary (brief §5): across it (from the most confident first class to the most confident second, ~20 stops),
// the uncertain songs first (closest to the boundary), or the disagreements (her label ≠ the model, most confident first)
function walkBoundary(mode) {
  const K = S.analysis.classes.length, conf = (s) => K === 2 ? s.p[1] : Math.max(...s.p), margin = (s) => { const q = [...s.p].sort((a, b) => b - a); return K === 2 ? Math.abs(s.p[1] - S.model.thr) : q[0] - q[1]; };
  let ids;
  if (mode === "across") { const o = [...S.songs].sort((a, b) => (K === 2 ? a.p[1] - b.p[1] : a.pred - b.pred || conf(a) - conf(b))), n = Math.min(20, o.length);
    ids = Array.from({ length: n }, (_, i) => o[Math.round(i * (o.length - 1) / Math.max(1, n - 1))].id); }
  else if (mode === "uncertain") ids = [...S.songs].sort((a, b) => margin(a) - margin(b)).slice(0, 20).map((s) => s.id);
  else ids = S.songs.filter((s) => s.pred !== labelOf(s)).sort((a, b) => b.p[b.pred] - a.p[a.pred]).map((s) => s.id);
  walkList(ids, (s) => s.pred);
}

// ------------------------------------------------------------------ the workspace: maps · timeline · descriptors
let tl = null;
const HER4 = [["spectral_flux_mean", "complejidad"], ["rms_mean", "dinamica"], ["chroma_mean", "armonia"], ["spectral_contrast_0_mean", "timbre"]];
let segScale = null;
function renderWork() {
  const v = S.view.work, A = S.analysis;
  $("#views").hidden = !A; document.querySelectorAll("#views [data-v]").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  $("#maps").hidden = v !== "maps"; $("#timeline").hidden = v !== "timeline"; $("#compare").hidden = v !== "compare"; $("#legend").hidden = !A || v === "compare";
  const vo = $("#viewopts"); vo.innerHTML = "";
  if (!A) return;
  if (v === "timeline") {
    if (!segScale) { segScale = {}; for (const [c] of HER4) { let lo = Infinity, hi = -Infinity; for (const s of S.songs) for (const r of s.l1) { lo = Math.min(lo, r[c]); hi = Math.max(hi, r[c]); } segScale[c] = [lo, hi]; } }
    const lines8 = DarkStyle.sets().lines8, id = S.sel.size ? [...S.sel][0] : (S.songs[0] && S.songs[0].id);
    tl = drawTimeline($("#timeline"), { song: () => songById(id), empty: t("tl_empty"), lines: HER4.map(([c, f], i) => ({ col: c, label: t(f), colour: lines8[i] })), scale: (c) => segScale[c],
      classes: A.classes, colours: classColours(), thr: S.model.thr, modelLabel: S.model.res ? (A.classes.length === 2 ? t("tl_model2", { c: A.classes[1] }) : t("tl_modelN")) : "",
      playing: () => { const p = player.state(); return p.playing ? p : null; }, play: (s, k) => player.play(s, { t0: s.l1[k].window_start, t1: s.l1[k].window_end }) });
    const s = songById(id); if (s) $("#timeline").insertAdjacentHTML("afterbegin", `<div class="tlhead"><b>${esc(s.name)}</b> <span class="k">· ${esc(A.classes[labelOf(s)])} · ${s.l1.length} ${t("segments")} · ${t("tl_how")}</span></div>`);
  } else if (v === "compare") {
    vo.innerHTML = `<span class="seg"><button class="btn sm ${S.view.cmpLevel === "l0" ? "on" : ""}" data-lv="l0">${t("songs")}</button><button class="btn sm ${S.view.cmpLevel === "l1" ? "on" : ""}" data-lv="l1">${t("segments")}</button></span>`;
    vo.querySelectorAll("[data-lv]").forEach((b) => b.onclick = () => { S.view.cmpLevel = b.dataset.lv; renderWork(); });
    const l1 = S.view.cmpLevel === "l1";
    drawCompare($("#compare"), { cols: FEATS.filter((c) => !l1 || !["tempo", "n_beats", "beat_density"].includes(c)), K: A.classes.length, classes: A.classes, colours: classColours(), level: S.view.cmpLevel,
      famLabel: (c) => t(famOf(c)), strings: { descriptor: t("descriptor"), per_class: t("per_class"), pick: t("pick_pair") },
      rows: () => l1 ? S.songs.flatMap((s) => s.l1.map((r) => ({ v: r, y: labelOf(s) }))) : S.songs.map((s) => ({ v: s.l0, y: labelOf(s) })),
      onPick: (col, res) => {                                    // the partner: the best-separating descriptor of another family, not strongly correlated
        const v = S.songs.map((s) => s.l0[col]), corr = (c) => { const w = S.songs.map((s) => s.l0[c]); const m1 = d3.mean(v), m2 = d3.mean(w); let a = 0, b = 0, d = 0; v.forEach((x, i) => { a += (x - m1) * (w[i] - m2); b += (x - m1) ** 2; d += (w[i] - m2) ** 2; }); return a / Math.sqrt(b * d || 1); };
        const partner = res.find((r) => r.col !== col && famOf(r.col) !== famOf(col) && FEATS.includes(r.col) && Math.abs(corr(r.col)) < 0.6);
        S.pair = [col, partner ? partner.col : (col === "pca_0" ? "pca_1" : "spectral_flux_mean")]; S.view.work = "maps"; renderAll(); } });
  }
}

// ------------------------------------------------------------------ side panel, legend, dock
function renderClasses() {
  const box = $("#classes"); box.innerHTML = "";
  for (const c of S.classes) {
    const fs = S.files.filter((f) => f.cls === c.name), ok = fs.filter(accepted), skip = fs.length - ok.length;
    const row = document.createElement("label"); row.className = "cls";
    row.innerHTML = `<input type="checkbox" ${c.on ? "checked" : ""} ${S.running ? "disabled" : ""}><b></b><span class="k">${ok.length} ${t("files")}</span>${skip ? `<span class="k dim">· ${t("skipped_fmt", { n: skip, fmt: ANA_PRESET.format })}</span>` : ""}`;
    row.querySelector("b").textContent = c.name;
    row.querySelector("input").onchange = (e) => { c.on = e.target.checked; renderClasses(); estimate(); };
    box.appendChild(row);
  }
  const on = S.classes.filter((c) => c.on);
  $("#analyse").disabled = on.length < 2 || S.running || !S.files.length; $("#need2").hidden = !S.classes.length || on.length >= 2;
  for (const id of ["o_save", "o_link", "o_csv", "o_svg", "o_png", "o_note"]) $("#" + id).disabled = !S.analysis;
  document.querySelectorAll("#formats button").forEach((b) => { b.textContent = t(b.dataset.f === "preset" ? "formats_preset" : "formats_all", { fmt: ANA_PRESET.format }); b.classList.toggle("on", S.formats === b.dataset.f); b.disabled = S.running; });
  const A = S.analysis;
  $("#result").innerHTML = A ? `<div><span class="k">${t("songs")}</span> <b>${A.n}</b> <span class="k">· ${t("segments")}</span> <b>${A.segments}</b></div>
    <div><span class="k">${t("agree")}</span> <b>${pct(A.accuracy)}</b> <span class="k">· k ${A.k} · ${t("mapping")} ${esc(JSON.stringify(A.mapping).replace(/"/g, ""))}</span></div>` : "";
  // her label edits, newest first, each undoable
  const ed = $("#edits"); ed.hidden = !S.overrides.length;
  ed.innerHTML = S.overrides.length ? `<h4>${t("edits")} · ${S.overrides.length}</h4>` + S.overrides.map((o, k) => ({ o, k })).reverse().map(({ o, k }) =>
    `<div class="edit"><span>${esc(o.name)}</span><span class="k">${esc(A.classes[o.from])} → <b>${esc(A.classes[o.to])}</b> · ${o.at.slice(11, 16)}</span><button class="btn sm" data-undo="${k}">${t("undo")}</button></div>`).join("") : "";
  ed.querySelectorAll("[data-undo]").forEach((b) => b.onclick = () => undoLabel(+b.dataset.undo));
}
function renderInfo() {
  const box = $("#info"), id = S.sel.size === 1 ? [...S.sel][0] : null, s = id != null ? songById(id) : null;
  if (!s) { box.innerHTML = `<div class="k">${t(S.analysis ? "info_none" : "empty_p")}</div>`; return; }
  const C = classColours(), ps = player.state(), playing = ps.playing && ps.song === s, L = labelOf(s);
  box.innerHTML = `<div class="title">${esc(s.name)}</div>
    <div class="kv"><span class="k">${t("class_of")}</span><span class="chips">${S.analysis.classes.map((c, i) => `<button class="btn sm chip ${i === L ? "on" : ""}" data-lab="${i}" title="${t("label_by_ear")}"><i class="dot" style="background:${C[i]}"></i>${esc(c)}</button>`).join("")}</span>
    ${L !== s.ci ? `<span class="k">${t("folder")}</span><span>${esc(s.cls)} <span class="k">(${t("edited")})</span></span>` : ""}
    <span class="k">${t("cluster")}</span><span>${s.km} · ${s.km === L ? t("agrees") : "<b>" + t("disagrees") + "</b>"}</span>
    ${s.p ? `<span class="k">${t("model")}</span><span>${esc(S.analysis.classes[s.pred])} · p ${s.p[s.pred].toFixed(2)} ${s.pred === L ? "" : "· <b>" + t("disagrees") + "</b>"}</span>` : ""}
    <span class="k">${t("duration")}</span><span>${fmtT(s.duration)} · ${(s.sr_native / 1000).toFixed(1)} kHz</span></div>
    <div class="row"><button class="btn sm" id="pp">${playing ? "■ " + t("stop") : "▶ " + t("play")}</button><span class="k" id="ptime"></span></div>
    <div class="k small">${t("segments_strip")}</div><div id="strip"></div>${s.segP ? `<div id="strip2"></div><div class="k small">${t("segments_pred")}</div>` : ""}`;
  $("#pp").onclick = () => playing ? player.stop() : player.play(s);
  box.querySelectorAll("[data-lab]").forEach((b) => b.onclick = () => setLabel(s, +b.dataset.lab));
  const strip = $("#strip"), strip2 = $("#strip2");
  s.l1.forEach((r, i) => {
    const c = document.createElement("i"); c.style.background = rampOf(s.segRms[i]); c.title = `${i + 1} · ${fmtT(r.window_start)}–${fmtT(r.window_end)}`;
    c.onclick = () => player.play(s, { t0: r.window_start, t1: r.window_end }); strip.appendChild(c);
    if (strip2) { const d = document.createElement("i"), p = s.segP[i], k = s.segPred[i]; d.style.background = C[k]; d.style.opacity = 0.25 + 0.75 * Math.min(1, (p[k] - 1 / p.length) / (1 - 1 / p.length));
      d.title = `${i + 1} · ${S.analysis.classes.map((c2, j) => `${c2} ${p[j].toFixed(2)}`).join(" · ")}`; d.onclick = c.onclick; strip2.appendChild(d); }
  });
  paintStrip();
}
function paintStrip() {
  const ps = player.state(), id = S.sel.size === 1 ? [...S.sel][0] : null, s = id != null ? songById(id) : null, strip = $("#strip");
  $("#nowplaying").textContent = ps.playing && ps.song ? `♪ ${ps.song.name} · ${fmtT(ps.t)}` : "";
  if (!strip || !s) return;
  const on = ps.song === s && ps.playing, k = on ? s.l1.findIndex((r) => ps.t >= r.window_start && ps.t < r.window_end) : -1;
  [...strip.children].forEach((c, i) => c.classList.toggle("on", i === k));
  const pt = $("#ptime"); if (pt) pt.textContent = on ? fmtT(ps.t) : "";
}
let lastPlaying = null;
player.onChange((ps) => { paintStrip(); if (tl && S.view.work === "timeline") tl.update(); const p = ps.playing && ps.song; if (p !== lastPlaying) { lastPlaying = p; renderInfo(); } });
function renderView() {
  document.querySelectorAll("#mapset button").forEach((b) => b.classList.toggle("on", S.view.mapset === b.dataset.m));
  document.querySelectorAll("#colourby button").forEach((b) => { b.classList.toggle("on", S.view.colour === b.dataset.c); if (b.dataset.c === "model") b.disabled = !S.model.res; });
  $("#bound").classList.toggle("on", S.view.boundary); $("#bound").textContent = t(S.view.boundary ? "boundary_on" : "boundary_off");
  $("#selinfo").textContent = S.sel.size ? t("n_sel", { n: S.sel.size }) : t("none_sel");
  $("#tracelist").innerHTML = S.trace.map((id) => `<li data-id="${id}">${esc(songById(id).name)}</li>`).join("");
  $("#tracelist").querySelectorAll("li").forEach((li) => li.onclick = () => { S.sel = new Set([+li.dataset.id]); player.play(songById(+li.dataset.id)); renderSide(); maps.update(); });
}
// the list of songs (clickable, playable as a walk)
function songList(id, ids, title, clsOf = () => null, open = false) {
  return `<details class="list" data-list="${id}" ${open ? "open" : ""}><summary>${title} <b>${ids.length}</b> ${ids.length ? `<button class="btn sm" data-walk="${id}">▶ ${t("walk")}</button>` : ""}</summary>
    <ol>${ids.map((i) => `<li data-id="${i}">${esc(songById(i).name)}</li>`).join("")}</ol></details>`;
}
const LISTS = {};
function renderModel() {
  const box = $("#modelout"); if (!box) return;
  const r = S.model.res, A = S.analysis; if (!A) { box.innerHTML = `<p class="k">${t("model_wait")}</p>`; return; }
  if (!r) { box.innerHTML = `<p class="k">${t("training")}</p>`; return; }
  const K = A.classes.length, L = S.songs.map(labelOf), km = S.songs.map((s) => s.km), pr = S.songs.map((s) => s.pred);
  const agree = (a, b) => a.filter((v, i) => v === b[i]).length / a.length;
  const fw = Object.entries(r.famW).sort((a, b) => b[1] - a[1]), wmax = Math.max(1e-9, ...fw.map((x) => x[1]));
  const near = S.songs.filter((s) => { const q = [...s.p].sort((a, b) => b - a); return K === 2 ? Math.abs(s.p[1] - S.model.thr) < 0.1 : q[0] - q[1] < 0.2; }).map((s) => s.id);
  LISTS.km = S.songs.filter((s) => s.km !== labelOf(s)).map((s) => s.id);
  LISTS.model = S.songs.filter((s) => s.pred !== labelOf(s)).map((s) => s.id);
  LISTS.both = S.songs.filter((s) => s.pred !== labelOf(s) && s.km !== labelOf(s)).map((s) => s.id);
  LISTS.near = near;
  LISTS.flips = S.model.flips ? S.model.flips.ids : [];
  const C = classColours(), cn = (i) => `<i class="dot" style="background:${C[i]}"></i>${esc(A.classes[i])}`;
  box.innerHTML = `
    <div class="scores">
      <div><span class="k">${t("model")} ↔ ${t("c_class")}</span> <b>${pct(r.acc)}</b> <span class="k">${t("fit")} · </span><b>${pct(r.cv)}</b> <span class="k">${t("cv", { n: r.folds })}</span></div>
      <div><span class="k">k-means ↔ ${t("c_class")}</span> <b>${pct(A.accuracy)}</b></div>
      <div><span class="k">k-means ↔ ${t("model")}</span> <b>${pct(agree(km, pr))}</b></div>
      ${r.active ? "" : `<div class="warn">${t("all_off")}</div>`}
    </div>
    <h4>${t("flips")}</h4>
    ${S.model.flips ? (LISTS.flips.length ? songList("flips", LISTS.flips, t("flipped", { cause: t("cause_" + S.model.flips.cause) }), (s) => s.pred, true) : `<div class="k">${t("no_flips")}</div>`) : `<div class="k">${t("turn_a_knob")}</div>`}
    <h4>${t("walk_boundary")}</h4>
    <div class="seg wide"><button class="btn sm" data-wb="across">${t("wb_across")}</button><button class="btn sm" data-wb="uncertain">${t("wb_uncertain")}</button><button class="btn sm" data-wb="disagree">${t("wb_disagree")}</button></div>
    <div class="k small">${t("wb_note")}</div>
    <h4>${t("disagreements")}</h4>
    ${songList("km", LISTS.km, t("d_km"), (s) => s.km)}
    ${songList("model", LISTS.model, t("d_model"), (s) => s.pred)}
    ${songList("both", LISTS.both, t("d_both"), (s) => labelOf(s))}
    ${songList("near", LISTS.near, t("d_near"), (s) => s.pred)}
    <h4>${t("weights")}</h4>
    <div class="bars">${fw.map(([f, w]) => `<div><span>${t(f)}</span><i style="width:${(100 * w / wmax).toFixed(1)}%"></i></div>`).join("")}</div>
    <h4>${t("confusion")}</h4>
    <table class="conf"><tr><td class="k">${t("her_label")} ↓ · ${t("model")} →</td>${A.classes.map((c, i) => `<th>${cn(i)}</th>`).join("")}</tr>
      ${r.conf.map((row, i) => `<tr><th>${cn(i)}</th>${row.map((v, j) => `<td class="${i === j ? "diag" : ""}">${v}</td>`).join("")}</tr>`).join("")}</table>
    <h4>${t("clusterings")}</h4>
    ${S.clusterings ? `<table class="conf"><tr><th></th><th>k</th><th>${t("agreement")}</th><th>ARI</th></tr>
      <tr><td>k-means <span class="k">(${t("hers")})</span></td><td>${A.k}</td><td>${pct(A.accuracy)}</td><td>—</td></tr>
      ${S.clusterings.map((c) => c.error ? `<tr><td>${esc(c.method)}</td><td colspan="3" class="k">${esc(c.error)}</td></tr>` : `<tr><td>${esc(c.method)}</td><td>${c.k}</td><td>${c.accuracy != null ? pct(c.accuracy) : `${pct(c.purity)} <span class="k">${t("purity")}</span>`}</td><td>${c.ari.toFixed(3)}</td></tr>`).join("")}</table>
      <div class="k small">${t("clusterings_note")}</div>` : `<button class="btn sm" id="runclust">${t("run_clusterings")}</button>`}`;
  box.querySelectorAll("details.list li").forEach((li) => li.onclick = () => { S.sel = new Set([+li.dataset.id]); player.play(songById(+li.dataset.id)); renderInfo(); renderView(); maps.update(); });
  const clsOfList = { flips: (s) => s.pred, km: (s) => s.km, model: (s) => s.pred, both: (s) => labelOf(s), near: (s) => s.pred };
  box.querySelectorAll("[data-walk]").forEach((b) => b.onclick = (e) => { e.preventDefault(); walkList(LISTS[b.dataset.walk], clsOfList[b.dataset.walk]); });
  const rc = $("#runclust"); if (rc) rc.onclick = runClusterings;
  box.querySelectorAll("[data-wb]").forEach((b) => b.onclick = () => walkBoundary(b.dataset.wb));
}
function runClusterings() {
  const w = new Worker(new URL("../core/cluster_worker.js", import.meta.url), { type: "module" });
  $("#runclust").disabled = true; $("#runclust").textContent = t("computing");
  w.onmessage = (ev) => { S.clusterings = ev.data.results; w.terminate(); renderModel(); };
  w.postMessage({ id: 1, rows: S.analysis.scaled, k: S.analysis.classes.length, y: S.songs.map(labelOf),
    methods: [{ method: "agglomerative", linkage: "ward", label: "agglomerative (ward)" }, { method: "gmm", label: "GMM" }, { method: "spectral", label: "spectral" }, { method: "hdbscan", label: "HDBSCAN", min_cluster_size: 10 }] });
}
let knobs = null;
function buildKnobs() {
  const box = $("#knobs"); if (!box || knobs) return; knobs = {};
  box.innerHTML = "";
  const add = (key, o) => { const el = document.createElement("div"); box.appendChild(el); knobs[key] = knob(el, o); };
  for (const [f] of FAMILIES) add(f, { label: () => t(f), value: S.model.gains[f], min: 0, max: 2, def: 1, fmt: (v) => v === 0 ? t("off") : "×" + v.toFixed(2),
    onInput: (v) => { S.model.gains[f] = v; runModel("knob"); } });
  add("thr", { label: () => t("threshold"), value: S.model.thr, min: 0.05, max: 0.95, def: 0.5, fmt: (v) => v.toFixed(2), onInput: (v) => { S.model.thr = v; fieldCache.clear(); runModel("threshold"); } });
  add("C", { label: () => t("regularisation"), value: S.model.C, min: 0.01, max: 100, def: 1, log: true, fmt: (v) => "C " + (v < 1 ? v.toFixed(2) : v.toFixed(1)), onInput: (v) => { S.model.C = v; runModel("reg"); } });
}
function renderKnobs() {
  buildKnobs(); if (!knobs) return;
  const K = S.analysis ? S.analysis.classes.length : 2;
  knobs.thr && (knobs.thr.repaint(), $("#knobs").children[FAMILIES.length].hidden = K !== 2);
  for (const k in knobs) knobs[k].repaint();
}
function renderLegend() {
  const L = $("#legend"), A = S.analysis; L.hidden = !A; if (!A) return;
  const C = classColours(), cat4 = DarkStyle.sets().cat4, cnt = (f) => S.songs.filter(f).length;
  const what = { km: t("c_km"), model: t("c_model"), agree: t("c_agree"), class: t("c_class") }[S.view.colour];
  let body;
  if (S.view.colour === "agree") body = [[tok("--ds-dim", "#667"), t("a_all"), 0], [cat4[1], t("a_km"), 1], [cat4[2], t("a_model"), 2], [cat4[3], t("a_both"), 3]]
    .map(([c, l, a]) => `<div><i class="dot ${a === 3 ? "ring" : ""}" style="background:${c}"></i>${l} <span class="k">${cnt((s) => agreeCat(s) === a)}</span></div>`).join("");
  else body = A.classes.map((c, i) => `<div><i class="dot" style="background:${C[i]}"></i>${S.view.colour === "km" ? `${t("cluster")} ${i} → ${esc(c)} <span class="k">${cnt((s) => s.km === i)}</span>` : S.view.colour === "model" ? `${esc(c)} <span class="k">${cnt((s) => s.pred === i)}</span>` : `${esc(c)} <span class="k">${cnt((s) => labelOf(s) === i)}</span>`}</div>`).join("");
  L.innerHTML = `<div class="k">${what}</div>${body}`
    + (S.overrides.length ? `<div class="small"><i class="dot ring edited"></i>${t("edited")} <span class="k">${new Set(S.overrides.map((o) => o.id)).size}</span></div>` : "")
    + (S.model.res && S.view.boundary && S.model.res.active ? `<div class="small"><span class="line"></span>${t("boundary")}</div>` : "")
    + `<div class="k small">k-means ${pct(A.accuracy)}${S.model.res ? ` · ${t("model")} ${pct(S.model.res.cv)} cv` : ""}</div>`;
}
function renderDock() {
  const A = S.analysis, P = ANA_PRESET;
  $("#dockbody").hidden = !S.view.dock;
  $("#dockbody").innerHTML = `<div><span class="k">${t("dock_features")}</span> ${t("preset_ana")} · ${P.sr / 1000} kHz mono · peak · n_fft ${P.nFft} · hop ${P.hop} · ${P.window_s} s · contrast ${P.contrast_bands} band (2 rows) · mfcc ${P.n_mfcc} · chroma stft (mean of 12) · rhythm per song (tempo, onsets) · .${P.format}</div>
    <div><span class="k">${t("dock_processing")}</span> MinMax · PCA 3 · density KDE 0.2 · k-means k <input id="kin" type="number" min="2" max="12" value="${A ? A.k : S.k || ""}" placeholder="${S.classes.filter((c) => c.on).length || 2}"> (n_init 10, seed 42) · align ${A ? A.method : "auto"}
    <button class="btn sm" id="recompute" ${A ? "" : "disabled"}>${t("recompute")}</button></div>
    <div><span class="k">${t("model")}</span> ${t("model_desc")}</div>`;
  $("#recompute").onclick = () => { const v = +$("#kin").value; S.k = v >= 2 ? v : null; S.recompute(); };
}
function renderSide() {
  document.querySelectorAll("#tabs .tab").forEach((b) => b.classList.toggle("on", S.view.tab === b.dataset.tab));
  document.querySelectorAll(".pane").forEach((p) => p.hidden = p.dataset.pane !== S.view.tab);
  $("#side").classList.toggle("closed", !S.view.side); $("#sidetab").textContent = S.view.side ? "‹" : "›";
  renderClasses(); renderView(); renderInfo(); renderLegend(); renderKnobs(); renderModel();
  if (S.view.work !== "maps") renderWork();
  saveView();
}
function renderAll() {
  paint(); $("#empty").hidden = S.classes.length > 0;
  $("#live").hidden = !S.view.live; $("#livebtn").classList.toggle("on", S.view.live);
  renderSide(); renderDock(); renderWork();
  if (S.analysis) { if (!maps) setupMaps(); fieldCache.clear(); maps.setDefs(mapDefs()); const u = $("#unpair"); if (u) u.onclick = () => { S.pair = null; renderAll(); }; }
  else { $("#maps").innerHTML = ""; if (maps) maps = null; }
}

// ------------------------------------------------------------------ the Live link (P5): its own panel, right
const LIVE_DESC = [["spectral_flux_mean", "flux", "complejidad"], ["rms_mean", "rms", "dinamica"], ["chroma_mean", "chroma", "armonia"], ["spectral_contrast_0_mean", "contrast", "timbre"], ["spectral_centroid_mean", "centroid", "brillo"]];
let liveScale = null;
const link = new Link((st) => renderLive(st));
const relPath = (s) => { const p = (s.rel || s.name).split("/"); return p.length >= 3 ? p.slice(1).join("/") : p.length === 2 && S.classes.length > 1 ? p.join("/") : p[p.length - 1]; };
function liveSchema() {
  if (!S.analysis) return;
  const A = S.analysis, K = A.classes.length, names = A.classes.map((c, i) => `${i}=${c}`).join(" "), keys = [], infos = {};
  liveScale = {};
  const stat = (v) => { let mn = Infinity, mx = -Infinity, mu = 0; for (const x of v) { mn = Math.min(mn, x); mx = Math.max(mx, x); mu += x; } mu /= v.length || 1; let sd = 0; for (const x of v) sd += (x - mu) ** 2; return [mn, mx, mu, Math.sqrt(sd / (v.length || 1))]; };
  for (const [col, key, fam] of LIVE_DESC) {
    const all = S.songs.flatMap((s) => s.l1.map((r) => r[col])), [lo, hi] = stat(all); liveScale[col] = [lo, hi];
    const u = all.map((v) => (v - lo) / (hi - lo || 1)), st = stat(u); keys.push([key, "signal", 0, 1, st[2], st[3], 0, -1, "UL"]); infos[key] = `${t(fam, {}, "en")} (${col}) of the 10 s segment playing, scaled 0–1 over every segment`;
  }
  for (const a of [0, 1]) { const st = stat(S.songs.map((s) => s.pca[a])); keys.push([`pca.${a ? "y" : "x"}`, "signal", 0, 1, st[2], st[3], 0, -1, "UL"]); infos[`pca.${a ? "y" : "x"}`] = `the song's place on the PCA map (${a ? "PCA 2" : "PCA 1"})`; }
  const sym = (name, v, n, info) => { const st = stat(v); keys.push([name, "symbol", 0, n - 1, st[2], st[3], n, -1, "UL"]); infos[name] = info; };
  sym("label", S.songs.map(labelOf), K, `her class · ${names}`);
  sym("kmeans", S.songs.map((s) => s.km), K, `k-means, aligned to her classes · ${names}`);
  if (S.model.res) {
    sym("model", S.songs.map((s) => s.pred), K, `the model's class · ${names}`);
    const pv = S.songs.map((s) => K === 2 ? s.p[1] : Math.max(...s.p)), st = stat(pv); keys.push(["p", "signal", 0, 1, st[2], st[3], 0, -1, "UL"]);
    infos.p = K === 2 ? `the model's probability of ${A.classes[1]}` : "the model's probability of its class";
    sym("agreement", S.songs.map(agreeCat), 4, "0=all agree 1=k-means differs 2=model differs 3=both differ");
    sym("near_boundary", S.songs.map((s) => +nearB(s)), 2, "1 = near the model's boundary");
  }
  link.setSchema(keys, infos, `uncanny_${A.n}_${A.classes.join("_")}`.slice(0, 60));
}
const nearB = (s) => { if (!s.p) return false; const K = s.p.length, q = [...s.p].sort((a, b) => b - a); return K === 2 ? Math.abs(s.p[1] - S.model.thr) < 0.1 : q[0] - q[1] < 0.2; };
function liveStep(s, t0, t1) {
  if (!link.enabled || !S.analysis) return;
  const K = S.analysis.classes.length, k = s.l1.findIndex((r) => t0 >= r.window_start - 1e-6 && t0 < r.window_end), row = k >= 0 ? s.l1[k] : s.l0, v = {};
  for (const [col, key] of LIVE_DESC) { const [lo, hi] = liveScale[col]; v[key] = Math.max(0, Math.min(1, (row[col] - lo) / (hi - lo || 1))); }
  v["pca.x"] = s.pca[0]; v["pca.y"] = s.pca[1]; v.label = labelOf(s); v.kmeans = s.km;
  if (s.p) { const p = k >= 0 && s.segP ? s.segP[k] : s.p; v.model = k >= 0 && s.segPred ? s.segPred[k] : s.pred; v.p = K === 2 ? p[1] : Math.max(...p); v.agreement = agreeCat(s); v.near_boundary = +nearB(s); }
  link.nav({ clipId: k >= 0 ? `${s.id}.${k}` : `${s.id}`, values: v, path: relPath(s), t0, t1, cluster: labelOf(s), pan: s.pca[0] * 2 - 1, pred: v.model });
}
player.onPlay((s, t0, t1) => liveStep(s, t0, t1));
function renderLive(st = link.status()) {
  if ($("#live").hidden) return;
  const label = { off: t("ls_off"), connecting: t("ls_connecting"), linked: st.connected ? t("ls_linked") : t("ls_waiting"), busy: t("ls_busy"), refused: t("ls_refused"), nohub: t("ls_nohub"), safari: t("ls_safari") }[st.state] || st.state;
  $("#livestate").textContent = label; $("#livelight").className = "light " + (st.connected ? "on" : st.state === "connecting" || st.state === "linked" ? "wait" : st.state === "safari" || st.state === "refused" || st.state === "busy" ? "bad" : "");
  $("#liveon").textContent = st.enabled ? t("live_unlink") : t("live_link"); $("#liveon").classList.toggle("on", st.enabled); $("#liveon").disabled = st.state === "safari";
  $("#livefollow").textContent = t(st.follow ? "live_follow_on" : "live_follow_off"); $("#livefollow").classList.toggle("on", st.follow);
  const root = S.classes.length ? (S.classes[0].root || t("ls_root_unknown")) : "—";
  $("#liveinfo").innerHTML = `<div>${t("live_root", { root: esc(root) })}</div>` + (st.hub ? `<div>Hub ${esc(st.hub.version)} · ${st.hub.root_set ? t("ls_root_set") : "<b>" + t("ls_root_unset") + "</b>"}</div>` : "")
    + `<div>${st.keys} ${t("ls_keys")} · ${st.msgs} ${t("ls_msgs")}</div>`;
}

// ------------------------------------------------------------------ outputs (P4): session, CSVs, figures, methods note
const SESSION = "uncanny-listening-session";
function sessionData() {
  return { format: SESSION, version: 1, saved: new Date().toISOString(), preset: ANA_PRESET, columns: FEATS, classes: S.analysis.classes,
    songs: S.songs.map((s) => ({ id: s.id, name: s.name, rel: s.rel, size: s.size, cls: s.cls, duration: s.duration, sr_native: s.sr_native, l0: s.l0, l1: s.l1 })),
    overrides: S.overrides, model: { gains: S.model.gains, C: S.model.C, thr: S.model.thr }, k: S.k,
    view: { mapset: S.view.mapset, colour: S.view.colour, boundary: S.view.boundary, work: S.view.work, cmpLevel: S.view.cmpLevel },
    sel: [...S.sel], trace: S.trace, pair: S.pair };
}
async function saveSession() { if (S.analysis) OUT.download(await OUT.gzipJson(sessionData()), `uncanny_${OUT.stamp()}.uncanny`); }
async function openSession(file) {
  file = file || await OUT.pickFile(".uncanny,.json,.gz"); if (!file) return;
  let ses; try { ses = await OUT.gunzipJson(file); } catch (e) { alert(t("o_bad")); return; }
  if (ses.format !== SESSION) { alert(t("o_bad")); return; }
  if (stopWalk) stopWalk(); player.stop();
  S.classes = ses.classes.map((c) => ({ name: c, root: "", on: true })); S.files = [];
  S.songs = ses.songs.map((s) => ({ ...s, file: null })); S.overrides = ses.overrides || []; S.k = ses.k || null;
  Object.assign(S.model, ses.model || {}); Object.assign(S.view, ses.view || {});
  if (knobs) { for (const [f] of FAMILIES) knobs[f] && knobs[f].set(S.model.gains[f] ?? 1); knobs.thr && knobs.thr.set(S.model.thr); knobs.C && knobs.C.set(S.model.C); }
  S.clusterings = null; process();
  S.sel = new Set(ses.sel || []); S.trace = ses.trace || []; S.pair = ses.pair || null;
  $("#status").textContent = t("o_opened", { n: S.songs.length, name: file.name }); renderAll(); renderLinkNote();
}
function renderLinkNote() { const n = S.songs.filter((s) => !s.file).length; $("#linknote").textContent = S.analysis && n ? t("o_unlinked", { n }) : ""; }
function linkAudio(list) {                                         // match by name and size (Dark Music Corpus's .dmc rule)
  const files = Array.from(list), by = new Map(files.map((f) => [`${f.name}|${f.size}`, f])); let n = 0;
  for (const s of S.songs) { const f = by.get(`${s.name}|${s.size}`); if (f) { s.file = f; n++; } }
  $("#status").textContent = t("o_linked", { n, m: S.songs.length }); renderLinkNote();
}
function tables() {
  const A = S.analysis, C = A.classes, K = C.length, r = S.model.res, cat = ["all agree", "k-means differs", "model differs", "both differ"];
  const ed = (s) => S.overrides.filter((o) => o.id === s.id), last = (s) => { const e = ed(s); return e.length ? e[e.length - 1] : null; };
  const near = (s) => { if (!s.p) return ""; const q = [...s.p].sort((a, b) => b - a); return (K === 2 ? Math.abs(s.p[1] - S.model.thr) < 0.1 : q[0] - q[1] < 0.2) ? 1 : 0; };
  const files = [];
  files.push({ name: "labels.csv", text: OUT.csv(["song", "folder_class", "label", "provenance", "edited_at", "n_edits"], S.songs.map((s) => [s.name, s.cls, C[labelOf(s)], last(s) ? "edited by ear" : "folder", last(s) ? last(s).at : "", ed(s).length])) });
  files.push({ name: "label_edits.csv", text: OUT.csv(["song", "folder_class", "from", "to", "at"], S.overrides.map((o) => [o.name, o.folder, C[o.from], C[o.to], o.at])) });
  const oc = S.clusterings ? S.clusterings.filter((c) => !c.error) : [];
  files.push({ name: "clusters.csv", text: OUT.csv(["song", "label", "kmeans_aligned", "kmeans_raw", ...oc.map((c) => c.method)], S.songs.map((s, i) => [s.name, C[labelOf(s)], s.km, s.km_raw, ...oc.map((c) => c.labels[i])])) });
  if (r) {
    files.push({ name: "predictions_songs.csv", text: OUT.csv(["song", "label", "model", ...C.map((c) => `p_${c}`), ...C.map((c) => `p_${c}_cross_validated`)], S.songs.map((s) => [s.name, C[labelOf(s)], C[s.pred], ...s.p, ...(s.oof || [])])) });
    files.push({ name: "predictions_segments.csv", text: OUT.csv(["song", "segment", "t_start", "t_end", "label", "model", ...C.map((c) => `p_${c}`)], S.songs.flatMap((s) => s.l1.map((q, k) => [s.name, k, q.window_start, q.window_end, C[labelOf(s)], C[s.segPred[k]], ...s.segP[k]]))) });
    files.push({ name: "disagreements.csv", text: OUT.csv(["song", "label", "kmeans", "model", "category", "near_boundary"], S.songs.map((s) => [s.name, C[labelOf(s)], C[s.km], C[s.pred], cat[agreeCat(s)], near(s)])) });
    files.push({ name: "model_coefficients.csv", text: OUT.csv(["column", "family", "gain", ...(K === 2 ? [`w_${C[1]}`] : C.map((c) => `w_${c}`))], r.coef.map((c) => [c.col, c.fam, S.model.gains[c.fam] ?? 1, ...c.w])) });
  }
  const y = S.songs.map(labelOf);
  files.push({ name: "descriptors.csv", text: OUT.csv(["descriptor", "family", K === 2 ? `cohen_d_${C[1]}_minus_${C[0]}` : "eta_squared", ...C.flatMap((c) => [`mean_${c}`, `sd_${c}`, `n_${c}`])],
    FEATS.map((col) => { const e = effect(S.songs.map((s) => s.l0[col]), y, K); return [col, famOf(col), K === 2 ? e.d : e.eta2, ...C.flatMap((c, i) => [e.means[i], e.sds[i], e.n[i]])]; })) });
  files.push({ name: "features_l0.csv", text: OUT.csv(["filename", "class", "window_start", "window_end", ...FEATS], S.songs.map((s) => [s.name, s.cls, 0, s.duration, ...FEATS.map((c) => s.l0[c])])) });
  files.push({ name: "features_l1.csv", text: OUT.csv(["filename", "class", "segment_index", "window_start", "window_end", ...FEATS], S.songs.flatMap((s) => s.l1.map((q, k) => [s.name, s.cls, k, q.window_start, q.window_end, ...FEATS.map((c) => q[c])]))) });
  files.push({ name: "methods_en.txt", text: methods("en") + "\n" }, { name: "methods_es.txt", text: methods("es") + "\n" });
  return files;
}
function methods(lang) {
  const A = S.analysis, r = S.model.res, K = A.classes.length;
  return OUT.methodsNote({ preset: ANA_PRESET, n: A.n, K, classes: A.classes, counts: A.classes.map((_, i) => S.songs.filter((s) => labelOf(s) === i).length),
    edits: new Set(S.overrides.map((o) => o.id)).size, segments: A.segments, nCols: FEATS.length, explained: A.explained, k: A.k, alignMethod: A.method, kmAcc: A.accuracy,
    C: S.model.C, thr: S.model.thr, families: FAMILIES.map(([f]) => [f, S.model.gains[f] ?? 1]), famName: (f) => t(f, {}, lang),
    acc: r ? r.acc : NaN, cv: r ? r.cv : NaN, folds: r ? r.folds : 5, kmModel: r ? S.songs.filter((s) => s.km === s.pred).length / S.songs.length : NaN,
    date: new Date().toISOString().slice(0, 10) }, lang);
}
function currentFigure() {
  const look = window.DarkStyle ? DarkStyle.get() : "dark", bg = tok("--ds-bg", "#fff"), txt = tok("--ds-txt", "#000"), font = tok("--ds-font-ui", "monospace");
  const v = S.view.work; let items, title;
  if (v === "timeline") { const sv = $("#timeline svg"); items = sv ? [{ svg: sv, caption: $("#timeline .tlhead") ? $("#timeline .tlhead").textContent : "" }] : []; title = t("v_timeline"); }
  else if (v === "compare") { items = [...document.querySelectorAll("#compare tbody tr")].slice(0, 20).map((tr) => ({ svg: tr.querySelector("svg"), caption: [...tr.children].slice(0, 3).map((td) => td.textContent.trim()).join("  ") })); title = t("v_compare"); }
  else { items = maps.cells().map((c) => ({ svg: c.svg.node(), caption: c.cap.textContent.replace("×", "").trim() })); title = `${t("title")} · ${t("c_" + S.view.colour) || ""}`; }
  return { svg: OUT.figureSvg(items.filter((i) => i.svg), { title, cols: v === "maps" ? 2 : v === "compare" ? 2 : 1, bg, txt, font }), look };
}
async function exportFigure(kind) {
  if (!S.analysis) return;
  const { svg, look } = currentFigure(), name = `uncanny_${S.view.work}_${look}_${OUT.stamp()}`;
  if (kind === "svg") OUT.download(OUT.svgBlob(svg), name + ".svg"); else OUT.download(await OUT.pngBlob(svg, 2), name + ".png");
}
let noteLang = null;
function showNote() {
  if (!S.analysis) return; noteLang = noteLang || getLang();
  $("#notetext").value = methods(noteLang); document.querySelectorAll("[data-nl]").forEach((b) => b.classList.toggle("on", b.dataset.nl === noteLang));
  if (!$("#notebox").open) $("#notebox").showModal();
}

// ------------------------------------------------------------------ dev hooks (parity tests: probe/p0_browser.py; checks: probe/p2_check.py)
S.exportFeatures = () => ({ preset: ANA_PRESET, columns: FEATS, analysis: S.analysis && { ...S.analysis, scaled: undefined },
  songs: S.songs.map((s) => ({ cls: s.cls, filename: s.name, sr_native: s.sr_native, duration: s.duration, ms: s.ms, error: s.error, l0: s.l0, l1: s.l1, pca: s.pca, density: s.density, km: s.km })) });
S.intake = intake; S.analyse = analyse; S.setFormats = (f) => { S.formats = f; renderClasses(); estimate(); };
S.render = renderAll; S.player = player; S.setLabel = (id, to) => setLabel(songById(id), to); S.undoLabel = undoLabel; S.labelOf = labelOf;
S.setGain = (f, v) => { S.model.gains[f] = v; knobs && knobs[f] && knobs[f].set(v); runModel("knob", 0); };
S.runClusterings = runClusterings; S.link = link; S.liveSchema = liveSchema; S.tables = tables; S.methods = methods; S.saveSession = saveSession; S.sessionBlob = () => OUT.gzipJson(sessionData()); S.OUT = OUT; S.openSession = openSession; S.linkAudio = linkAudio; S.currentFigure = currentFigure; S.walkBoundary = walkBoundary; S.setWork = (v) => { S.view.work = v; renderWork(); };

// ------------------------------------------------------------------ boot
function boot() {
  document.documentElement.lang = getLang();
  const pick = $("#pick");
  $("#open").onclick = () => pick.click(); $("#open2").onclick = () => pick.click();
  pick.onchange = () => { intake(pick.files); pick.value = ""; };
  $("#analyse").onclick = analyse; $("#cancel").onclick = () => { S.stop = true; };
  document.querySelectorAll("[data-lang]").forEach((b) => b.onclick = () => setLang(b.dataset.lang));
  document.querySelectorAll("#tabs .tab").forEach((b) => b.onclick = () => { S.view.tab = b.dataset.tab; renderSide(); });
  document.querySelectorAll("#formats button").forEach((b) => b.onclick = () => S.setFormats(b.dataset.f));
  document.querySelectorAll("#mapset button").forEach((b) => b.onclick = () => { S.view.mapset = b.dataset.m; renderAll(); });
  document.querySelectorAll("#colourby button").forEach((b) => b.onclick = () => { S.view.colour = b.dataset.c; renderSide(); maps && maps.update(); });
  document.querySelectorAll("#views [data-v]").forEach((b) => b.onclick = () => { S.view.work = b.dataset.v; renderWork(); if (b.dataset.v === "maps" && maps) maps.setDefs(mapDefs()); });
  $("#bound").onclick = () => { S.view.boundary = !S.view.boundary; fieldCache.clear(); renderSide(); maps && maps.update(); };
  $("#selclear").onclick = () => { S.sel.clear(); S.brushed = null; renderSide(); maps && maps.update(); };
  $("#traceclear").onclick = () => { S.trace = []; renderSide(); maps && maps.update(); };
  $("#sidetab").onclick = () => { S.view.side = !S.view.side; renderSide(); };
  $("#livebtn").onclick = () => { S.view.live = !S.view.live; renderAll(); renderLive(); };
  $("#liveclose").onclick = () => { S.view.live = false; renderAll(); };
  $("#liveon").onclick = () => { liveSchema(); link.configure({ enabled: !link.enabled }); };
  $("#livefollow").onclick = () => link.configure({ follow: !link.follow });
  $("#liveport").onchange = (e) => link.configure({ port: +e.target.value }); $("#liverate").onchange = (e) => link.configure({ rate: +e.target.value });
  $("#dockbtn").onclick = () => { S.view.dock = !S.view.dock; renderDock(); saveView(); };
  $("#vol").oninput = (e) => player.setVolume(+e.target.value);
  $("#o_save").onclick = saveSession; $("#o_open").onclick = () => openSession(); $("#o_link").onclick = () => $("#linkpick").click();
  $("#linkpick").onchange = () => { linkAudio($("#linkpick").files); $("#linkpick").value = ""; };
  $("#o_csv").onclick = () => S.analysis && OUT.download(OUT.zip(tables()), `uncanny_tables_${OUT.stamp()}.zip`);
  $("#o_svg").onclick = () => exportFigure("svg"); $("#o_png").onclick = () => exportFigure("png"); $("#o_note").onclick = showNote;
  document.querySelectorAll("[data-nl]").forEach((b) => b.onclick = () => { noteLang = b.dataset.nl; showNote(); });
  $("#notecopy").onclick = () => navigator.clipboard && navigator.clipboard.writeText($("#notetext").value);
  $("#notedl").onclick = () => OUT.download(new Blob([$("#notetext").value + "\n"], { type: "text/plain" }), `uncanny_methods_${noteLang}_${OUT.stamp()}.txt`);
  $("#noteclose").onclick = () => $("#notebox").close();
  window.addEventListener("keydown", (e) => {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || e.target.classList.contains("knob")) return;
    if (e.key === "i") { S.view.side = !S.view.side; renderSide(); }
    else if (e.key === " ") { e.preventDefault(); player.toggle(); }
    else if (e.key === "Escape") { if (stopWalk) stopWalk(); S.sel.clear(); S.brushed = null; renderSide(); maps && maps.update(); }
  });
  onLang(() => renderAll());
  if (window.DarkStyle) { DarkStyle.control($("#looks"), { btnClass: "btn sm" }); DarkStyle.keys(); DarkStyle.onChange(() => { rmsRamp = null; renderAll(); }); }
  renderAll();
}
boot();
