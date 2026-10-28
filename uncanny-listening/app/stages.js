// Uncanny Listening — load and save each stage's data (brief §10b, Miguel 2026-10-27: "load (and also save) data from the
// different modules … if everything has been processed already she can load the files and just explore").
// Formats: CSV as her notebook writes them — DarkSonification's save_ / load_latest: <name>_<YYYYMMDD_HHMM>.csv (pandas
// index as the first column) beside <name>_<YYYYMMDD_HHMM>.json {"type": "dataframe"} — and the desktop GUI's stage
// tables. Pure functions here; main.js does the files and the folder.
//
// What a table is, read from its name and columns (so her older schemas load too):
//   per-class features  data_<class>_l<0|1>_<stamp>.csv    (her preprocessing/ folder; the class is the name's token)
//   combined features   any table with a `class` column     (dark_librosa_ana_l0.csv, uncanny_L0.csv, data_l0.parquet …)
//   processed           a table with pca_0 / pca_1          (dark_librosa_processed_l0.csv, darkdf_l0.parquet …): her PCA,
//                       density and k-means clusters are kept as stored
//   level               _l0 / _l1 in the name, else L1 when a song has several rows (or a segment_index column)

// ------------------------------------------------------------------ CSV
export function parseCSV(text) {                                   // RFC 4180: quotes, doubled quotes, newlines in quotes
  const rows = []; let row = [], f = "", q = false, i = 0;
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  for (; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true; else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") rows.pop();
  return { header: rows[0] || [], rows: rows.slice(1) };
}
// → {columns: {name: values[]}, names, n}: numbers where every non-empty cell parses, else strings; the unnamed pandas index dropped
export function tableFromCSV(text) {
  const { header, rows } = parseCSV(text), cols = {}, names = [];
  header.forEach((h, j) => {
    if (j === 0 && h === "") return;
    const raw = rows.map((r) => r[j] ?? ""), num = raw.every((v) => v === "" || isFinite(+v));
    cols[h] = num ? raw.map((v) => (v === "" ? NaN : +v)) : raw; names.push(h);
  });
  return { columns: cols, names, n: rows.length };
}
const q = (v) => { if (v == null || (typeof v === "number" && !Number.isFinite(v))) return ""; const s = String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
// pandas' to_csv(index=True): an unnamed first column with 0…n−1
export function toCSV(names, rows, { index = true } = {}) {
  const out = [(index ? [""] : []).concat(names).map(q).join(",")];
  rows.forEach((r, i) => out.push((index ? [i] : []).concat(r).map(q).join(",")));
  return out.join("\n") + "\n";
}
export const stamp = (d = new Date()) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
export const pandasTime = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds() * 1000).padStart(6, "0")}`;
export const META_TAG = '{"type": "dataframe"}';                  // what save_ writes beside a DataFrame's CSV

// ------------------------------------------------------------------ what a loaded table is
const META = new Set(["", "position", "filename", "timestamp", "window_start", "window_end", "class", "class_distance", "_id", "segment_index",
  "density", "density_estimation", "km_cluster", "outlier_score", "outlier_flag", "label", "provenance"]);
export const isFeature = (c) => !META.has(c) && !/^pca_\d+$/.test(c) && !/^km_\d+$/.test(c) && !c.includes("__") && !/^p_/.test(c) && !/^(model|kmeans)/.test(c);
export function describe(name, table) {
  const m = name.match(/^data_(.+?)_l([01])(?:_(\d{8}_\d{4}))?\.(csv|parquet)$/i), c = table.columns;
  const fn = c.filename || [], perSong = new Map(); fn.forEach((f) => perSong.set(f, (perSong.get(f) || 0) + 1));
  const lvl = /_l1\b|_l1[._]|L1\b/i.test(name) || c.segment_index ? 1 : /_l0\b|_l0[._]|L0\b/i.test(name) ? 0 : [...perSong.values()].some((v) => v > 1) ? 1 : 0;
  return { name, level: m ? +m[2] : lvl, token: m ? m[1] : null, hasClass: !!c.class, processed: !!(c.pca_0 && c.pca_1), n: table.n,
           features: table.names.filter((k) => isFeature(k) && typeof c[k][0] === "number"), ok: !!c.filename };
}
// several described tables → {classes, songs, featCols, skipped}: songs keyed by (class, filename), each with l0 and l1 rows
export function assemble(tables, classNames = {}) {
  const key = (cls, f) => `${cls}\u0000${f}`, songs = new Map(), classes = new Set();
  const clsOf = (t, i) => t.d.token != null ? t.d.token : t.t.columns.class ? String(t.t.columns.class[i]) : "all";
  const row = (t, i) => Object.fromEntries(t.t.names.map((k) => [k, t.t.columns[k][i]]));
  for (const t of tables.filter((x) => x.d.level === 0)) for (let i = 0; i < t.t.n; i++) {
    const cls = clsOf(t, i), f = t.t.columns.filename[i], k = key(cls, f); classes.add(cls);
    const s = songs.get(k) || { cls, name: f, l0: {}, l1: [], stored: null }; Object.assign(s.l0, row(t, i));
    if (t.d.processed) s.stored = { pca: [t.t.columns.pca_0[i], t.t.columns.pca_1[i], t.t.columns.pca_2 ? t.t.columns.pca_2[i] : NaN],
      density: (t.t.columns.density_estimation || t.t.columns.density || [])[i], km: t.t.columns.km_cluster ? t.t.columns.km_cluster[i] : null };
    songs.set(k, s);
  }
  // a segment table with no class (no class column, no class in its name) joins the song of the same file name, when only
  // one class has it (the same file in two classes is ambiguous and is skipped, counted in `skipped`)
  const byName = new Map(); for (const s of songs.values()) byName.set(s.name, (byName.get(s.name) || []).concat([s]));
  let skipped = 0;
  for (const t of tables.filter((x) => x.d.level === 1)) for (let i = 0; i < t.t.n; i++) {
    let cls = clsOf(t, i); const f = t.t.columns.filename[i];
    if (cls === "all" && songs.size) { const c = byName.get(f) || []; if (c.length !== 1) { skipped++; continue; } cls = c[0].cls; }
    const k = key(cls, f); classes.add(cls);
    if (!songs.has(k)) songs.set(k, { cls, name: f, l0: null, l1: [], stored: null });
    songs.get(k).l1.push(row(t, i));
  }
  const all = [...songs.values()];
  for (const s of all) {
    s.l1.sort((a, b) => a.window_start - b.window_start);
    if (!s.l0 && s.l1.length) s.l0 = { filename: s.name, window_start: 0, window_end: s.l1[s.l1.length - 1].window_end, _fromL1: true };
    s.duration = s.l0 ? +s.l0.window_end || (s.l1.length ? s.l1[s.l1.length - 1].window_end : 0) : 0;
  }
  // the feature columns: those every song has at L0 (and every segment at L1, when segments are loaded)
  const l0f = tables.filter((t) => t.d.level === 0).map((t) => t.d.features), l1f = tables.filter((t) => t.d.level === 1).map((t) => t.d.features);
  const inter = (arrs) => arrs.length ? arrs.reduce((a, b) => a.filter((x) => b.includes(x))) : null;
  let featCols = inter(l0f) || inter(l1f) || [];
  if (inter(l1f) && inter(l0f)) featCols = featCols.filter((c) => inter(l1f).includes(c));
  const named = (c) => classNames[c] ?? c;
  return { classes: [...classes].map(named), songs: all.filter((s) => s.l0).map((s) => ({ ...s, cls: named(s.cls) })), featCols, skipped };
}
// the token her notebook uses for a class in data_<token>_l0: the folder name's last "_" part (libreria_si → si)
export const tokenOf = (cls) => { const p = String(cls).split("_"); return (p[p.length - 1] || String(cls)).replace(/[\\/:*?"<>|]/g, "-"); };   // no path characters in a file name

// ------------------------------------------------------------------ parquet (the desktop GUI's stage tables; hyparquet, MIT, vendor/)
// read: any parquet pandas / pyarrow writes (snappy, double / int64 / string); write: one DOUBLE / INT64 / STRING column each
let PQ = null, PQW = null;
export async function tableFromParquet(buf) {
  PQ = PQ || await import("../vendor/hyparquet/index.js");
  const rows = await PQ.parquetReadObjects({ file: buf }), names = rows.length ? Object.keys(rows[0]).filter((k) => !/^__index_level_\d+__$/.test(k)) : [], cols = {};
  for (const k of names) { const v = rows.map((r) => r[k]); cols[k] = v.every((x) => typeof x === "number" || typeof x === "bigint" || x == null) ? v.map((x) => (x == null ? NaN : Number(x))) : v.map((x) => (x == null ? "" : String(x))); }
  return { columns: cols, names, n: rows.length };
}
export async function toParquet(names, rows) {
  PQW = PQW || await import("../vendor/hyparquet-writer/index.js");
  const columnData = names.map((n, j) => {
    const v = rows.map((r) => r[j]), str = v.some((x) => typeof x === "string"), int = !str && v.every((x) => Number.isInteger(x));
    return str ? { name: n, data: v.map((x) => (x == null ? null : String(x))), type: "STRING" } : int ? { name: n, data: BigInt64Array.from(v.map((x) => BigInt(x))), type: "INT64" }
      : { name: n, data: Float64Array.from(v.map((x) => (x == null ? NaN : +x))), type: "DOUBLE" };
  });
  return new Uint8Array(PQW.parquetWriteBuffer({ columnData }));
}
