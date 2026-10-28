// Uncanny Listening — the PERCEPTUAL LEGEND, after Dark Re-wilding's (view/legend.js, Manual C5 §19): a panel docked on the
// left (key L) that reads like a map legend. Every row is NAME · plain meaning, at most one line of range, then chips; each (i)
// is two or three sentences for a listener ending on "in the data: <column>". Three tiers:
//   CATALOGUE  real songs (click = hear + see + select): the most typical song of each class, the one on the boundary, the
//              strongest disagreements, and the song highest on each of her descriptors
//   HEAR       select a song, then HOLD a chip: you hear THIS song's own 10-s segment where that descriptor is lowest / highest
//              (the song stays the same, only the moment changes); release returns you to what was playing
//   SEE        the encodings: colour (the current colouring, with counts), rings, the boundary, the trace, the strips
// Re-wilding's hold pushes one quantity in a synthesiser; here the sound is the researcher's own recordings, so the honest
// equivalent is the song's own extreme moment. renderLegend(root, ctx) — ctx below.

const HEAR = [                                                  // column, her family, unit line (or null)
  ["spectral_flux_mean", "complejidad", null], ["rms_mean", "dinamica", null], ["chroma_mean", "armonia", null],
  ["spectral_contrast_0_mean", "timbre", "dB"], ["spectral_centroid_mean", "brillo", "Hz"],
];
const open = new Set();                                          // the (i) rows open, kept across renders
export function renderLegend(root, ctx) {
  const { t, A, songs, colours, labelOf } = ctx, esc = ctx.esc;
  if (!A) { root.innerHTML = `<div class="lg-h"><b>${t("legend_title")}</b></div><p class="k">${t("model_wait")}</p>`; return; }
  const sel = ctx.selected(), C = colours, K = A.classes.length, model = !!(songs[0] && songs[0].p), HEARX = HEAR.filter(([c]) => !ctx.has || ctx.has(c));
  const info = (id, txt, col) => `<button class="lg-i" data-i="${id}" aria-label="(i)">ⓘ</button>${open.has(id) ? `<div class="lg-ib">${txt}${col ? `<div class="k small">${t("lg_inthedata")} ${col}</div>` : ""}</div>` : ""}`;
  const chip = (attrs, label, sub = "", cls = "") => `<button class="lg-chip ${cls}" ${attrs}><span>${label}</span>${sub ? `<span class="k">${esc(sub)}</span>` : ""}</button>`;

  // CATALOGUE — real songs
  const cat = [];
  const best = (f, pick) => songs.filter(f).sort(pick)[0];
  if (model) {
    A.classes.forEach((c, i) => { const s = best((x) => labelOf(x) === i, (a, b) => b.p[i] - a.p[i]); if (s) cat.push([t("lg_typical", { c }), s, i]); });
    const margin = (s) => { const q = [...s.p].sort((a, b) => b - a); return K === 2 ? Math.abs(s.p[1] - ctx.thr) : q[0] - q[1]; };
    const b = best(() => true, (a, c) => margin(a) - margin(c)); if (b) cat.push([t("lg_boundary"), b, b.pred]);
    const d = best((x) => x.pred !== labelOf(x), (a, c) => c.p[c.pred] - a.p[a.pred]); if (d) cat.push([t("lg_doubt"), d, d.pred]);
  }
  const kd = songs.filter((x) => x.km !== labelOf(x)); if (kd.length) cat.push([t("lg_kmeans"), kd[0], labelOf(kd[0])]);
  for (const [col, fam] of HEARX) { const s = best(() => true, (a, b) => b.l0[col] - a.l0[col]); if (s) cat.push([t("lg_hi_" + fam), s, null]); }

  // SEE — the current colouring
  const cnt = (f) => songs.filter(f).length, mode = ctx.colourMode, cat4 = ctx.cat4;
  const colourRows = mode === "agree"
    ? [[ctx.dim, t("a_all"), 0], [cat4[1], t("a_km"), 1], [cat4[2], t("a_model"), 2], [cat4[3], t("a_both"), 3]].map(([c, l, a]) => `<span class="lg-key"><i class="dot ${a === 3 ? "ring" : ""}" style="background:${c}"></i>${l} <span class="k">${cnt((s) => ctx.agreeCat(s) === a)}</span></span>`).join("")
    : A.classes.map((c, i) => `<span class="lg-key"><i class="dot" style="background:${C[i]}"></i>${esc(c)} <span class="k">${cnt((s) => (mode === "km" ? s.km : mode === "model" ? s.pred : labelOf(s)) === i)}</span></span>`).join("");

  root.innerHTML = `<div class="lg-h"><b>${t("legend_title")}</b></div>
  <section class="lg-sec"><div class="lg-st">${t("lg_catalogue")}</div>
    <div class="lg-chips">${cat.map(([label, s, ci], k) => chip(`data-cat="${k}"`, `${ci != null ? `<i class="dot" style="background:${C[ci]}"></i>` : ""}${esc(label)}`, s.name.replace(/\.[a-z0-9]+$/i, "").slice(0, 34))).join("")}</div></section>
  <section class="lg-sec"><div class="lg-st">${t("lg_hear")}</div>
    <div class="k small">${sel ? `${t("lg_hearing")} <b>${esc(sel.name)}</b>` : t("lg_select_first")}</div>
    ${HEARX.map(([col, fam, unit]) => { const v = songs.map((s) => s.l0[col]), lo = Math.min(...v), hi = Math.max(...v);
      return `<div class="lg-row"><div class="lg-name"><b>${t(fam)}</b> · ${t("lg_m_" + fam)} ${info("h_" + fam, t("lg_i_" + fam), col)}</div>
        ${unit ? `<div class="k small">${unit === "Hz" ? `${Math.round(lo)} – ${Math.round(hi)} Hz` : `${lo.toFixed(1)} – ${hi.toFixed(1)} dB`} ${t("lg_across")}</div>` : ""}
        <div class="lg-chips">${chip(`data-hold="${col}" data-w="lo" ${sel ? "" : "disabled"}`, `${t("lg_lo_" + fam)} ◀`)}${chip(`data-hold="${col}" data-w="hi" ${sel ? "" : "disabled"}`, `${t("lg_hi_" + fam)} ▶`)}</div></div>`; }).join("")}
  </section>
  <section class="lg-sec"><div class="lg-st">${t("lg_see")}</div>
    <div class="lg-row"><div class="lg-name"><b>${t("lg_colour")}</b> · ${esc({ class: t("c_class"), km: t("c_km"), model: t("c_model"), agree: t("c_agree") }[mode])} ${info("s_colour", t("lg_i_colour"), null)}</div><div class="lg-keys">${colourRows}</div></div>
    <div class="lg-row"><div class="lg-name"><span class="lg-sym ring"></span><b>${t("lg_ring")}</b> · ${t("lg_ring_m")}</div></div>
    <div class="lg-row"><div class="lg-name"><span class="lg-sym ring edited"></span><b>${t("edited")}</b> · ${t("lg_edited_m")}</div></div>
    <div class="lg-row"><div class="lg-name"><span class="lg-sym line"></span><b>${t("boundary")}</b> · ${t("lg_boundary_m")} ${info("s_bound", t("lg_i_boundary"), null)}</div></div>
    <div class="lg-row"><div class="lg-name"><span class="lg-sym trace"></span><b>${t("trace")}</b> · ${t("lg_trace_m")}</div></div>
    <div class="lg-row"><div class="lg-name"><span class="lg-sym strip"></span><b>${t("lg_strip")}</b> · ${t("lg_strip_m")} ${info("s_strip", t("lg_i_strip"), "rms_mean")}</div></div>
  </section>`;
  root.querySelectorAll("[data-i]").forEach((b) => b.onclick = () => { const id = b.dataset.i; open.has(id) ? open.delete(id) : open.add(id); renderLegend(root, ctx); });
  root.querySelectorAll("[data-cat]").forEach((b) => b.onclick = () => { const [, s, ci] = cat[+b.dataset.cat]; ctx.pick(s, ci); });
  root.querySelectorAll("[data-hold]").forEach((b) => {
    let release = null;
    const down = (e) => { e.preventDefault(); if (!sel || release) return; b.classList.add("held"); b.setPointerCapture && b.setPointerCapture(e.pointerId); release = ctx.hold(sel, b.dataset.hold, b.dataset.w); };
    const up = () => { if (!release) return; b.classList.remove("held"); release(); release = null; };
    b.addEventListener("pointerdown", down); b.addEventListener("pointerup", up); b.addEventListener("pointercancel", up); b.addEventListener("lostpointercapture", up);
  });
}
