// Uncanny Listening — outputs (brief §6): the session file, CSV tables (one ZIP), figures (SVG / PNG) and the methods note.
// Nothing here touches audio: a session holds the analysis, labels and overrides, knobs, selections and traces; reopening it
// needs the folders only to listen (files are matched again by name and size, as Dark Music Corpus's .dmc does).

// ------------------------------------------------------------------ files
export function download(blob, name) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
export async function gzipJson(obj) { return await new Response(new Blob([JSON.stringify(obj)]).stream().pipeThrough(new CompressionStream("gzip"))).blob(); }
export async function gunzipJson(file) {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  const text = head[0] === 0x1f && head[1] === 0x8b ? await new Response(file.stream().pipeThrough(new DecompressionStream("gzip"))).text() : await file.text();
  return JSON.parse(text);
}
export function pickFile(accept) {
  return new Promise((res) => { const i = document.createElement("input"); i.type = "file"; i.accept = accept; i.onchange = () => res(i.files[0] || null); i.click(); });
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
export { stamp };

// ------------------------------------------------------------------ CSV + a small ZIP writer (stored, CRC-32), no library
export function csv(header, rows) {
  const q = (v) => { if (v == null || (typeof v === "number" && !Number.isFinite(v))) return ""; const s = String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [header.map(q).join(","), ...rows.map((r) => r.map(q).join(","))].join("\n") + "\n";
}
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function zip(files) {                                         // files: [{name, text}] → Blob
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  const d = new Date(), dt = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff, dd = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  for (const f of files) {
    const name = enc.encode(f.name), data = f.bytes || enc.encode(f.text), crc = crc32(data), h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true); h.setUint16(10, dt, true); h.setUint16(12, dd, true);
    h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(h, name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true); c.setUint16(12, dt, true); c.setUint16(14, dd, true);
    c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true); c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    central.push(c, name); off += 30 + name.length + data.length;
  }
  const size = central.reduce((s, p) => s + (p.byteLength ?? p.length), 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, size, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, e], { type: "application/zip" });
}

// ------------------------------------------------------------------ figures: an SVG made standalone (computed styles inlined)
const PROPS = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity", "stroke-dasharray", "opacity", "font-family", "font-size", "font-weight", "text-anchor"];
function inline(src, dst) {
  const cs = getComputedStyle(src);
  for (const p of PROPS) { const v = cs.getPropertyValue(p); if (v && v !== "normal") dst.setAttribute(p, v); }
  for (let i = 0; i < src.children.length; i++) inline(src.children[i], dst.children[i]);
}
// a figure from several SVGs laid out on a grid, with captions and a background (the current look)
export function figureSvg(items, { title = "", cols = 2, bg = "#fff", txt = "#000", font = "monospace" } = {}) {
  const F = esc(font), pad = 16, cap = 18, ws = items.map((it) => +it.svg.getAttribute("width")), hs = items.map((it) => +it.svg.getAttribute("height"));
  const cw = Math.max(...ws), ch = Math.max(...hs) + cap, n = items.length, c = Math.min(cols, n), r = Math.ceil(n / c), top = title ? 28 : 0;
  const W = pad + c * (cw + pad), H = top + pad + r * (ch + pad);
  const out = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  out.setAttribute("xmlns", "http://www.w3.org/2000/svg"); out.setAttribute("width", W); out.setAttribute("height", H); out.setAttribute("viewBox", `0 0 ${W} ${H}`);
  out.innerHTML = `<rect width="${W}" height="${H}" fill="${esc(bg)}"/>` + (title ? `<text x="${pad}" y="22" fill="${esc(txt)}" font-family="${F}" font-size="14">${esc(title)}</text>` : "");
  items.forEach((it, i) => {
    const x = pad + (i % c) * (cw + pad), y = top + pad + Math.floor(i / c) * (ch + pad), clone = it.svg.cloneNode(true);
    inline(it.svg, clone); clone.setAttribute("x", x); clone.setAttribute("y", y + cap);
    out.insertAdjacentHTML("beforeend", `<text x="${x}" y="${y + 12}" fill="${esc(txt)}" font-family="${F}" font-size="12">${esc(it.caption || "")}</text>`);
    out.appendChild(clone);
  });
  return out;
}
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export const svgBlob = (svg) => new Blob(['<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" });
export async function pngBlob(svg, scale = 2) {
  const url = URL.createObjectURL(svgBlob(svg)), img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  const cv = document.createElement("canvas"); cv.width = img.width * scale; cv.height = img.height * scale;
  const g = cv.getContext("2d"); g.scale(scale, scale); g.drawImage(img, 0, 0); URL.revokeObjectURL(url);
  return await new Promise((res) => cv.toBlob(res, "image/png"));
}

// ------------------------------------------------------------------ the methods note (EN / ES), from what was computed
export function methodsNote(m, lang) {
  if (m.source) {                                                  // read from tables, not extracted here: name them instead
    const src = m.source.files.join(", "), first = lang === "es"
      ? `Se analizaron ${m.n} canciones en ${m.K} clases (${m.classes.map((c, i) => `${c}: ${m.counts[i]}`).join("; ")})${m.edits ? `, de las cuales ${m.edits} ${m.edits === 1 ? "se reetiquetó" : "se reetiquetaron"} de oído en la herramienta` : ""}. Los descriptores se leyeron de tablas ya procesadas (${src}): ${m.nCols} columnas, ${m.segments} segmentos${m.stored ? "; PCA, densidad y grupos k-means tal como estaban guardados" : ""}.`
      : `${m.n} songs in ${m.K} classes were analysed (${m.classes.map((c, i) => `${c}: ${m.counts[i]}`).join("; ")})${m.edits ? `, of which ${m.edits} ${m.edits === 1 ? "was" : "were"} relabelled by ear in the tool` : ""}. The descriptors were read from already-processed tables (${src}): ${m.nCols} columns, ${m.segments} segments${m.stored ? "; PCA, density and k-means clusters as stored" : ""}.`;
    const rest = methodsNote({ ...m, source: null }, lang).split("\n\n").slice(1);
    return [first, ...rest].join("\n\n");
  }
  const P = m.preset, pc = (v) => `${(100 * v).toFixed(1)} %`, fam = m.families.map(([f, g]) => `${m.famName(f)} ×${g.toFixed(2)}`).join(", ");
  const off = m.families.filter(([, g]) => g === 0).map(([f]) => m.famName(f));
  if (lang === "es") return [
    `Se analizaron ${m.n} canciones en ${m.K} clases definidas por carpetas (${m.classes.map((c, i) => `${c}: ${m.counts[i]}`).join("; ")})${m.edits ? `, de las cuales ${m.edits} ${m.edits === 1 ? "se reetiquetó" : "se reetiquetaron"} de oído en la herramienta` : ""}. Los descriptores se calcularon en el navegador con una adaptación de DarkLibrosa (modo resumen), preset por defecto: audio mono a ${P.sr / 1000} kHz normalizado en pico, n_fft ${P.nFft}, hop ${P.hop}; tasa de cruces por cero, rms, centroide, ancho de banda, rolloff (${P.rolloff_percent}), planitud y contraste espectral (${P.contrast_bands} banda, dos filas), flujo espectral (fuerza de ataque), mfcc 0 y croma (media de las 12 clases), cada uno resumido por media, mediana, desviación, mínimo y máximo, más tempo, número de ataques y su densidad por canción (librosa 0.11). Nivel 0: la canción entera; nivel 1: segmentos de ${P.window_s} s sin solapamiento (${m.segments} segmentos).`,
    `Las ${m.nCols} columnas se escalaron a [0, 1] (MinMax). ${m.stored ? "Los mapas usan el PCA, la densidad y los grupos k-means guardados en las tablas; " : `Un PCA de 3 componentes explica ${m.explained.map(pc).join(", ")} de la varianza. `}${m.stored ? `los grupos k-means guardados, alineados a las etiquetas de clase (${m.alignMethod}), coinciden con ellas en ${pc(m.kmAcc)}.` : `Un k-means con k = ${m.k} (10 inicializaciones, semilla 42) sobre la tabla escalada, alineado a las etiquetas de clase (${m.alignMethod}), coincide con ellas en ${pc(m.kmAcc)}.`}`,
    `El modelo es una regresión logística ${m.K === 2 ? "binaria" : "multinomial"} con penalización L2 (C = ${m.C.toPrecision(3)}) sobre las columnas tipificadas, cada familia multiplicada por su ganancia (${fam})${off.length ? `; familias apagadas: ${off.join(", ")}` : ""}${m.K === 2 ? `, con umbral ${m.thr.toFixed(2)}` : ""}. Entrenado con las etiquetas actuales, acierta ${pc(m.acc)} en las canciones con que aprendió y ${pc(m.cv)} en validación cruzada estratificada de ${m.folds} partes. Las predicciones por segmento aplican el modelo de canciones al resumen de cada segmento. El modelo y k-means coinciden en ${pc(m.kmModel)}.`,
    `Análisis hecho con Uncanny Listening (${m.date}).`].join("\n\n");
  return [
    `${m.n} songs in ${m.K} folder-defined classes were analysed (${m.classes.map((c, i) => `${c}: ${m.counts[i]}`).join("; ")})${m.edits ? `, of which ${m.edits} ${m.edits === 1 ? "was" : "were"} relabelled by ear in the tool` : ""}. Descriptors were computed in the browser by a port of DarkLibrosa's summary mode, default preset: mono audio at ${P.sr / 1000} kHz, peak-normalised, n_fft ${P.nFft}, hop ${P.hop}; zero-crossing rate, rms, spectral centroid, bandwidth, rolloff (${P.rolloff_percent}), flatness and contrast (${P.contrast_bands} band, two rows), spectral flux (onset strength), mfcc 0 and chroma (the mean of the 12 classes), each summarised by mean, median, standard deviation, minimum and maximum, plus tempo, the number of onsets and their density per song (librosa 0.11). Level 0: the whole song; level 1: ${P.window_s} s segments without overlap (${m.segments} segments).`,
    `The ${m.nCols} columns were scaled to [0, 1] (MinMax). ${m.stored ? "The maps use the PCA, density and k-means clusters as stored in the tables; " : `A 3-component PCA explains ${m.explained.map(pc).join(", ")} of the variance. `}${m.stored ? `the stored k-means clusters, aligned to the class labels (${m.alignMethod}), agree with them on ${pc(m.kmAcc)}.` : `k-means with k = ${m.k} (10 initialisations, seed 42) on the scaled table, aligned to the class labels (${m.alignMethod}), agrees with them on ${pc(m.kmAcc)}.`}`,
    `The model is a ${m.K === 2 ? "binary" : "multinomial"} logistic regression with an L2 penalty (C = ${m.C.toPrecision(3)}) on the z-scored columns, each family multiplied by its gain (${fam})${off.length ? `; families switched off: ${off.join(", ")}` : ""}${m.K === 2 ? `, with threshold ${m.thr.toFixed(2)}` : ""}. Trained on the current labels, it scores ${pc(m.acc)} on the songs it learnt and ${pc(m.cv)} in ${m.folds}-fold stratified cross-validation. Segment predictions apply the song model to each segment's own summary. The model and k-means agree on ${pc(m.kmModel)}.`,
    `Analysis made with Uncanny Listening (${m.date}).`].join("\n\n");
}
