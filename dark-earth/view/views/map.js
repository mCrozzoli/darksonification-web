// dark_svartsengi · views/map.js — view B, the map (DESIGN §5 B). W3.
//
// D3 geo over a LOCAL coastline (geo/reykjanes_coast.geojson, Natural Earth 1:10m, public domain). No tile servers.
//   - the epicentres of the window on the timeline, fading with age before the cursor (after it: faint outlines);
//   - stations (CONTRACT 0.13 §4.2): a measured position is a filled triangle; an approx one (a placeholder) is hollow and
//     dashed with a dotted ring of its stated uncertainty (pos_err_m); pos_source on hover; a station without numbers is
//     LISTED, never placed. ctx.stations() = the published positions with the config dock's page-local edits on top;
//   - v0.13: while the cursor is inside an eruption, its fissure (W1's centroid; approx = hollow, dashed, with its ring)
//     and the fountains' heights at that moment from W1's series, a bar per fissure segment (dashed + "model" when simulated);
//   - a brush selects events by place: the timeline dims the rest and the Swarm hears only the selection;
//   - at the hours and minutes levels, a polarization arrow for MELH, in a compass inset (MELH is placed approximately,
//     ±2 km, since 0.13; the direction is in the sensor's frame, ambiguous by 180°).
window.SvkMap = (function () {
  "use strict";
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);

  function create(host, ctx) {
    const { S } = ctx;
    host.classList.add("mapv");
    host.innerHTML = `<svg class="map-svg"><g class="map-grat"></g><path class="map-land"></path><path class="map-coast"></path>
        <g class="map-places"></g><g class="map-scale"></g><g class="map-brush"></g></svg>
      <canvas class="map-cv"></canvas><svg class="map-top"><g class="map-st"></g><g class="map-ear"><title></title><circle class="ear-hit" r="13"></circle><circle class="ear-ring" r="5.5"></circle><circle class="ear-dot" r="1.6"></circle><path class="ear-face" d="M0,-6 L-3.4,-12.5 A13,13 0 0 1 3.4,-12.5 Z"></path></g></svg><canvas class="map-eru"></canvas>
      <div class="map-pol"><svg viewBox="-40 -40 80 80"><circle r="30" class="pol-ring"></circle><text y="-32" class="pol-n">N</text>
        <line class="pol-arrow" x1="0" y1="0" x2="0" y2="0"></line><path class="pol-h1"></path><path class="pol-h2"></path></svg>
        <canvas class="map-hodo" title="particle motion: 4 s around the cursor · east → · north ↑ · the sensor's frame"></canvas><div class="pol-txt"></div></div>
      <div class="map-pending"></div><div class="map-sel"></div><div class="hbox map-hbox"></div>`;
    // the stations sit above the quakes' canvas (map-top, no pointer events: the brush below takes the hover)
    const svg = d3.select(host).select(".map-svg"), top = d3.select(host).select(".map-top"), cv = host.querySelector(".map-cv"), g = cv.getContext("2d");
    // the eruption's fissure and fountain bars on their own canvas above the stations (the stations sit at the eruption site)
    const cve = host.querySelector(".map-eru"), ge = cve.getContext("2d");
    const hbox = host.querySelector(".map-hbox");
    let W = 300, H = 200, dpr = 1, geo = null, dirty = true, box = null;
    const proj = d3.geoMercator(), path = d3.geoPath(proj);
    const brush = d3.brush().on("end", (e) => {
      if (!e.sourceEvent) return;
      if (!e.selection) { box = null; ctx.setSelection(null); return; }
      const [[a, b], [c, d]] = e.selection, p0 = proj.invert([a, d]), p1 = proj.invert([c, b]);
      box = { lon0: p0[0], lat0: p0[1], lon1: p1[0], lat1: p1[1] };
      ctx.setSelection(box);
    });
    const bg = svg.select(".map-brush").call(brush);
    bg.select(".overlay").on("pointermove.hover", (e) => hover(e)).on("pointerleave.hover", () => (hbox.style.display = "none"));

    function fit() {
      if (!geo) return;
      // fit corner points, never a box polygon: d3-geo is spherical, and a ring wound the "wrong" way is the whole globe
      const bb = geo.bbox || [-23.05, 63.7, -21.6, 64.2];
      const corners = (a, b, c, d) => ({ type: "MultiPoint", coordinates: [[a, b], [c, b], [c, d], [a, d]] });
      // a wide map frames the epicentre area with the coast around it; a tall one shows the whole box
      proj.fitExtent([[8, 8], [W - 8, H - 8]], W / H > 1.4 ? corners(-22.80, 63.76, -22.05, 64.02) : corners(...bb));
    }
    function resize() {
      const r = host.getBoundingClientRect();
      W = Math.max(160, r.width); H = Math.max(140, r.height); dpr = window.devicePixelRatio || 1;
      svg.attr("width", W).attr("height", H); top.attr("width", W).attr("height", H);
      for (const c of [cv, cve]) { c.width = W * dpr; c.height = H * dpr; c.style.width = W + "px"; c.style.height = H + "px"; }
      brush.extent([[0, 0], [W, H]]); bg.call(brush);
      fit(); drawStatic(); drawEar(); dirty = true;
      if (box) bg.call(brush.move, [proj([box.lon0, box.lat1]), proj([box.lon1, box.lat0])]);
    }
    function drawStatic() {
      if (!geo) return;
      const land = geo.features.find((f) => f.properties.kind === "land"), coast = geo.features.find((f) => f.properties.kind === "coast");
      svg.select(".map-land").attr("d", land ? path(land) : null);
      svg.select(".map-coast").attr("d", coast ? path(coast) : null);
      const grat = d3.geoGraticule().step([0.25, 0.1]).extent([[-23.5, 63.5], [-21, 64.5]]);
      svg.select(".map-grat").selectAll("path").data([grat()]).join("path").attr("d", path);
      // a 10 km scale bar
      const [lx, ly] = [14, H - 34], p0 = proj.invert([lx, ly]);
      const dLon = 10 / (111.32 * Math.cos((p0[1] * Math.PI) / 180)), x1 = proj([p0[0] + dLon, p0[1]])[0];
      const sc = svg.select(".map-scale").selectAll("*").remove() && svg.select(".map-scale");
      sc.append("line").attr("x1", lx).attr("x2", x1).attr("y1", ly).attr("y2", ly);
      sc.append("text").attr("x", lx).attr("y", ly - 4).text("10 km");
      // placed stations: measured filled, approx hollow + dashed with its uncertainty ring (CONTRACT 0.13 §4.2)
      const all = stations(), placed = all.filter((s) => s.placed);
      top.select(".map-st").selectAll("g").data(placed, (s) => s.id)
        .join((en) => { const gg = en.append("g"); gg.append("circle").attr("class", "err"); gg.append("path"); gg.append("text"); return gg; })
        .attr("class", (s) => `${s.approx ? "approx" : ""}${s.edited ? " edited" : ""}`)
        .attr("transform", (s) => `translate(${proj([s.lon, s.lat])})`)
        .call((gg) => {
          const ring = (s) => s.approx && isNum(s.pos_err_m) && s.pos_err_m > 0;
          gg.select("circle.err").attr("r", (s) => (ring(s) ? Math.max(3, mPx(s.lat, s.lon, s.pos_err_m)) : 0)).style("display", (s) => (ring(s) ? null : "none"));
          gg.select("path").attr("d", "M0,-6 L5,4 L-5,4 Z");
          gg.select("text").attr("x", 7).attr("y", 4).text((s) => short(s.id));
        });
      // a label that would overlap one already drawn is left to the hover (measured stations first): a tight cluster of
      // names on a small map reads as noise
      const shown = [], marks = placed.map((s) => [s.id, proj([s.lon, s.lat])]);
      top.select(".map-st").selectAll("g").sort((a, b) => (a.approx ? 1 : 0) - (b.approx ? 1 : 0)).each(function (s) {
        const q = proj([s.lon, s.lat]), w = 7 + 6.2 * short(s.id).length;
        const free = !shown.some((p) => Math.abs(p[0] - q[0]) < 34 && Math.abs(p[1] - q[1]) < 11)
          && !marks.some(([id, p]) => id !== s.id && p[0] > q[0] - 1 && p[0] < q[0] + w + 5 && Math.abs(p[1] - q[1]) < 10);   // nor over another's ▲
        d3.select(this).select("text").style("display", free ? null : "none"); if (free) shown.push(q);
      });
      const pend = all.filter((s) => !s.placed);
      // listed, never placed; one short line, the stations' names on hover (the calm page, 2026-10-22)
      const mp = host.querySelector(".map-pending");
      mp.textContent = pend.length ? `${pend.length} station${pend.length > 1 ? "s" : ""} not placed` : "";
      mp.title = pend.length ? `no position yet (pending StationXML; one can be entered in config · C): ${pend.map((s) => s.label || s.id).join(" · ")}` : "";
      mp.style.display = pend.length ? "" : "none";
    }
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const short = (id) => (String(id).split(".").length >= 2 ? String(id).split(".")[1] : String(id));
    // metres → pixels here (an uncertainty ring)
    const mPx = (lat, lon, m) => { const a = proj([lon, lat]), b = proj([lon, lat + m / 111320]); return a && b ? Math.abs(a[1] - b[1]) : 0; };
    const stations = () => (ctx.stations ? ctx.stations() : (S.M.stations || []).map((s) => ({ ...s, placed: isNum(s.lat) && isNum(s.lon), approx: !!s.pending })));
    const fmtUT = (t) => `${new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
    function stationLines(s) {
      const out = [`<b>${esc(short(s.id))}</b> · ${esc(s.kind || "station")}${s.edited ? " · edited in this page" : ""}`];
      out.push(s.approx ? `approx position, a placeholder${isNum(s.pos_err_m) ? ` · ± ${s.pos_err_m} m` : " · uncertainty unknown"}` : "measured position");
      out.push(`${s.lat.toFixed(4)}° N, ${Math.abs(s.lon).toFixed(4)}° ${s.lon < 0 ? "W" : "E"}`);
      if (s.pos_source) out.push(`<span class="dim">${esc(s.pos_source)}</span>`);
      return out;
    }

    // v0.13: the eruption whose span holds the cursor: its fissure (the centroid W1 gives; approx = hollow, dashed, with
    // its uncertainty ring) and, from W1's fountain series (events/fountains/<id>.json: t, cols, data[col]), one bar per
    // fissure segment, its height at the cursor, on the fountains' range; dashed with "model" when simulated. A series is
    // asked for once, when its eruption is near the cursor; the segments have no positions, so the bars stand in a row
    const fnt = new Map();                                   // file → series (null while loading or absent)
    let eruHit = [];                                         // what the hover can name: {x, y, lines}
    function series(e) {
      if (!e.fnt || !ctx.src.fountains) return null;
      const k = e.fnt.file;
      if (!fnt.has(k)) {
        fnt.set(k, null);
        ctx.src.fountains(e.fnt).then((F) => {
          if (!F) return;
          const t = F.t || []; F._t1 = Math.max(F.end_utc ? Date.parse(F.end_utc) / 1000 : -Infinity, t.length ? t[t.length - 1] : -Infinity);
          fnt.set(k, F); dirty = true;
        });
      }
      return fnt.get(k);
    }
    function eruptionNow() {
      const L = ctx.eruptions ? ctx.eruptions() : [];
      for (let i = L.length - 1; i >= 0; i--) {
        const e = L[i], a = e.onset ?? e.t;
        if (!(S.cursor >= a && S.cursor <= a + 60 * 86400)) continue;
        const F = series(e), end = e.t1 ?? (F && isNum(F._t1) ? F._t1 : a + 86400);
        if (S.cursor <= end) return { e, F, a, end };
      }
      return null;
    }
    // one segment's height at t: linear between two samples; across a gap, the nearer sample within 10 minutes; else null
    function hAt(F, col, t) {
      const ts = F.t || [], hs = (F.data || {})[col] || [];
      if (!ts.length || t < ts[0] || t > ts[ts.length - 1]) return null;
      let lo = 0, hi = ts.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts[m] <= t) lo = m; else hi = m; }
      const a = hs[lo], b = hs[hi];
      if (isNum(a) && isNum(b)) return ts[hi] > ts[lo] ? a + ((t - ts[lo]) / (ts[hi] - ts[lo])) * (b - a) : a;
      const [v, d] = t - ts[lo] <= ts[hi] - t ? [a, t - ts[lo]] : [b, ts[hi] - t];
      return isNum(v) && d <= 600 ? v : null;
    }
    const clause = (txt) => String(txt || "").split(/;\s|\s\|\s/)[0];
    function drawEruption(C) {
      const g = ge;
      eruHit = [];
      const now = eruptionNow(); if (!now) return;
      const { e, F, a, end } = now, col = C.fissure || ctx.tok("--ds-danger");
      const f = e.fissure || (F && isNum(F.fissure_lat) && isNum(F.fissure_lon)
        ? { lat: F.fissure_lat, lon: F.fissure_lon, status: F.fissure_status || "approx", err_m: isNum(F.fissure_err_deg) ? Math.round(F.fissure_err_deg * 111320) : null, source: F.centroid_method || null } : null);
      if (!f) return;
      const p = proj([f.lon, f.lat]); if (!p || !isNum(p[0])) return;
      const sim = F ? F.kind === "simulated" : e.fountain_kind === 2, ap = f.status !== "measured";
      const hTop = Math.max(1, ...(ctx.eruptions() || []).map((x) => x.fountain_m).filter(isNum));
      g.save(); g.lineCap = "butt";
      // the fissure: a diamond, filled when measured; approx = hollow, dashed, its uncertainty ring dotted
      if (ap && isNum(f.err_m) && f.err_m > 0) { g.strokeStyle = col; g.globalAlpha = 0.6; g.lineWidth = 0.8; g.setLineDash([2, 3]); g.beginPath(); g.arc(p[0], p[1], Math.max(4, mPx(f.lat, f.lon, f.err_m)), 0, 7); g.stroke(); g.setLineDash([]); }
      g.globalAlpha = 0.95; g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1.4; g.setLineDash(ap ? [2, 2] : []);
      g.beginPath(); g.moveTo(p[0], p[1] - 4); g.lineTo(p[0] + 4, p[1]); g.lineTo(p[0], p[1] + 4); g.lineTo(p[0] - 4, p[1]); g.closePath(); if (ap) g.stroke(); else g.fill(); g.setLineDash([]);
      // the fountains: a row of bars above it, one per segment (or the eruption's highest, faint, without a series)
      const cols = F ? F.cols || Object.keys(F.data || {}) : [], hs = cols.map((c) => [c, hAt(F, c, S.cursor)]);
      const n = cols.length, gap = 4, y0 = p[1] - 7, x0 = p[0] - ((n - 1) * gap) / 2;
      const bar = (x, h, faint) => { const L = 2 + 38 * Math.min(1, h / hTop); g.globalAlpha = faint ? 0.5 : 0.95; g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y0 - L); g.stroke(); return L; };
      g.strokeStyle = col; g.lineWidth = 2.4; g.setLineDash(sim ? [3, 2] : []);
      let top = 0;
      if (n) {
        g.globalAlpha = 0.35; g.lineWidth = 1; g.setLineDash([]); g.beginPath(); g.moveTo(x0 - 2, y0 + 0.5); g.lineTo(x0 + (n - 1) * gap + 2, y0 + 0.5); g.stroke();   // the row's footing
        g.lineWidth = 2.4; g.setLineDash(sim ? [3, 2] : []);
        hs.forEach(([, h], k) => { if (isNum(h) && h > 0) top = Math.max(top, bar(x0 + k * gap, h, false)); });
      } else if (isNum(e.fountain_m)) top = bar(p[0], e.fountain_m, true);
      g.setLineDash([]);
      if (sim && top > 0) { g.globalAlpha = 0.95; g.fillStyle = col; g.font = `9px ${ctx.tok("--ds-font-canvas")}`; g.textAlign = "right"; g.fillText("model", x0 - 5, y0 - top + 7); g.textAlign = "left"; }
      g.restore();
      // what the hover says there; an intrusion has no fissure: its position is where the dike or swarm began (W1)
      const place = e.kind === "intrusion" ? "where it began" : "fissure";
      const endTxt = e.t1 && e.t1_day ? new Date((end - 86400) * 1000).toISOString().slice(0, 10) : fmtUT(end);
      const out = [`<b>${e.kind}${e.imo_n ? ` ${e.imo_n}` : ""}</b> · from ${e.onset_approx ? "≈ " : ""}${fmtUT(a)}${e.t1 || (F && F.end_utc) ? ` to ${endTxt}` : ""}`,
        ap ? `${place}: approx position${isNum(f.err_m) ? ` · ± ${f.err_m} m` : " · uncertainty unknown"}` : `${place}: measured position`];
      if (F) {
        const on = hs.filter(([, h]) => isNum(h) && h > 0).sort((u, v) => v[1] - u[1]);
        out.push(on.length ? `fountains now: ${on.slice(0, 5).map(([c, h]) => `${esc(c)} ${Math.round(h)} m`).join(" · ")}${on.length > 5 ? ` · +${on.length - 5}` : ""}` : "no fountain at this moment");
        out.push(`${sim ? "simulated: model output" : "observed"} · highest ${Math.round(F.max_m ?? e.fountain_m ?? 0)} m${F.max_segment ? ` (segment ${esc(F.max_segment)})` : ""} · ${n} segment${n === 1 ? "" : "s"}`);
        if (F.source) out.push(`<span class="dim">${esc(clause(F.source))}</span>`);
      } else if (isNum(e.fountain_m)) out.push(`highest fountain ${Math.round(e.fountain_m)} m · ${e.fountain_kind === 2 ? "simulated: model output" : "observed"} (no height series: the bar is the eruption's highest)`);
      if (f.source) out.push(`<span class="dim" title="${esc(f.source)}">${place}: ${esc(clause(f.source))}</span>`);
      eruHit.push({ x: p[0], y: p[1], lines: out }, ...(n || top ? [{ x: p[0], y: y0 - Math.max(6, top / 2), lines: out }] : []));
    }

    // epicentres of the window, fading with age (relative to the cursor)
    function draw() {
      if (!dirty) return; dirty = false;
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      ge.setTransform(dpr, 0, 0, dpr, 0, 0); ge.clearRect(0, 0, W, H);
      const [t0, t1] = S.view, span = t1 - t0, E = ctx.src.events(t0, t1), C = ctx.col(), sel = ctx.selection();
      const many = E.n > 3000;
      for (let k = E.i0; k < E.i1; k++) {
        const lon = E.lon[k], lat = E.lat[k]; if (!isNum(lon) || !isNum(lat)) continue;
        const [px, py] = proj([lon, lat]);
        const age = S.cursor - E.t[k], m = E.mag[k], r = Math.max(0.8, 1 + 1.3 * (m + 0.5));
        const on = !sel || sel(k);
        if (age < 0) { if (many) continue; g.globalAlpha = on ? 0.18 : 0.05; g.strokeStyle = C.event; g.lineWidth = 0.6; g.beginPath(); g.arc(px, py, r, 0, 7); g.stroke(); continue; }
        const fresh = 1 - Math.min(1, age / Math.max(1, span));
        // thousands of dots on 30 km: keep each faint so density reads as density, and the newest stand out
        const dense = Math.min(1, 900 / Math.max(1, E.n));
        g.globalAlpha = on ? (0.05 + 0.9 * fresh ** 3) * Math.max(dense, fresh ** 3) + 0.03 : 0.03;
        g.fillStyle = C.event; g.beginPath(); g.arc(px, py, many ? Math.min(r, 1.8) : r, 0, 7); g.fill();
      }
      // the events just sent to the engine ring once in gold (what you hear, where it is)
      g.globalAlpha = 0.95; g.strokeStyle = ctx.tok("--ds-cur"); g.lineWidth = 1.3;
      for (const k of ctx.recentEvents()) { const [px, py] = proj([E.lon[k], E.lat[k]]); if (isNum(px)) { g.beginPath(); g.arc(px, py, 6, 0, 7); g.stroke(); } }
      // traced moments: their quakes ringed in the trace's colour (re_wilding 3.10: a trace marks, it hides nothing)
      g.lineWidth = 1.4;
      for (const r of (ctx.traces && ctx.traces()) || []) {
        const T = ctx.src.events(r.t0, r.t1); g.strokeStyle = r.color; g.globalAlpha = 0.95;
        for (let k = T.i0; k < T.i1 && k < T.i0 + 400; k++) { const q = proj([T.lon[k], T.lat[k]]); if (q && isNum(q[0])) { g.beginPath(); g.arc(q[0], q[1], 4.5, 0, 7); g.stroke(); } }
      }
      g.globalAlpha = 1;
      drawEruption(C);
      drawPol();
      const n = sel ? countSel(E, sel) : null;
      const ms = host.querySelector(".map-sel");
      ms.innerHTML = sel ? `<b>${n}</b> of ${E.n} in your box <button class="mini" data-clear title="clear the selection">✕</button>` : `${E.n} quakes`;
      ms.title = sel ? "the Swarm hears only the quakes inside your box" : "the quakes on screen, fading with age before the cursor; drag a box to choose which ones the Swarm plays";
      const cl = host.querySelector("[data-clear]"); if (cl) cl.onclick = () => { box = null; bg.call(brush.move, null); ctx.setSelection(null); };
    }
    function countSel(E, sel) { let n = 0; for (let k = E.i0; k < E.i1; k++) if (sel(k)) n++; return n; }

    // MELH's polarization at the cursor (f10s): an axial, double-headed arrow; length = R (how locked it is)
    function drawPol() {
      const el = host.querySelector(".map-pol"), w = S.w[0] + S.w[1];
      const p = ctx.polAt(S.cursor);
      el.style.opacity = w > 0.02 ? Math.min(1, w).toFixed(2) : 0;
      el.style.pointerEvents = w > 0.5 ? "auto" : "none";
      const arrow = d3.select(el).select(".pol-arrow"), h1 = d3.select(el).select(".pol-h1"), h2 = d3.select(el).select(".pol-h2");
      // no direction here (no waveform): the whole arrow goes; resetting one end only left a stale half-arrow from the last minute
      if (!p) { arrow.attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 0); h1.attr("d", null); h2.attr("d", null); el.querySelector(".pol-txt").textContent = ctx.polText(null); el.title = ctx.polText(null); return; }
      const L = 28 * Math.max(0.15, p.R), a = (p.az * Math.PI) / 180, dx = Math.sin(a) * L, dy = -Math.cos(a) * L;
      arrow.attr("x1", -dx).attr("y1", -dy).attr("x2", dx).attr("y2", dy);
      const head = (sx, sy, ux, uy) => `M${sx},${sy} L${sx - ux * 7 - uy * 4},${sy - uy * 7 + ux * 4} L${sx - ux * 7 + uy * 4},${sy - uy * 7 - ux * 4} Z`;
      const ux = dx / (L || 1), uy = dy / (L || 1);
      h1.attr("d", head(dx, dy, ux, uy)); h2.attr("d", head(-dx, -dy, -ux, -uy));
      el.querySelector(".pol-txt").textContent = ctx.polText(p);
      el.title = ctx.polText(p);
    }

    function hover(e) {
      if (ctx.hoverOn && !ctx.hoverOn()) { hbox.style.display = "none"; return; }
      const [px, py] = d3.pointer(e, host);
      // the eruption's marks and the stations first (few, and what a hover there is for), then the nearest quake
      const near = (x, y) => (x - px) ** 2 + (y - py) ** 2 < 100;
      let lines = (eruHit.find((h) => near(h.x, h.y)) || {}).lines || null;
      if (!lines) { const st = stations().find((s) => { if (!s.placed) return false; const q = proj([s.lon, s.lat]); return q && near(q[0], q[1]); }); if (st) lines = stationLines(st); }
      if (!lines) {
        const [t0, t1] = S.view, E = ctx.src.events(t0, t1);
        let best = -1, bd = 64;
        for (let k = E.i0; k < E.i1; k++) {
          const q = proj([E.lon[k], E.lat[k]]); if (!q) continue;
          const d = (q[0] - px) ** 2 + (q[1] - py) ** 2; if (d < bd) { bd = d; best = k; }
        }
        const ll = proj.invert([px, py]);
        lines = best >= 0 ? ctx.eventLines(best) : [`<span class="dim">${ll[1].toFixed(3)}° N, ${(-ll[0]).toFixed(3)}° W</span>`];
      }
      hbox.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
      hbox.style.display = "block";
      const bw = hbox.offsetWidth, bh = hbox.offsetHeight;
      hbox.style.left = Math.max(2, px + 14 + bw > W ? px - bw - 14 : px + 14) + "px";
      hbox.style.top = Math.max(2, py + 14 + bh > H ? py - bh - 14 : py + 14) + "px";
    }

    // v0.14: the listener, one gold ear (gold = you): a ring with a small wedge toward where it faces (the activity, eased,
    // or north). Drag it to move; near a station it snaps onto it (the listener then follows that station's position).
    // Calm: no label, the name on hover
    const ear = top.select(".map-ear");
    function drawEar() {
      const L = ctx.listener ? ctx.listener() : null, q = L && proj([L.lon, L.lat]);
      ear.style("display", q && isNum(q[0]) ? null : "none");
      if (!q || !isNum(q[0])) return;
      ear.attr("transform", `translate(${q[0]},${q[1]})`);
      const F = ctx.facing ? ctx.facing() : { mode: "north", heading: 0 }, deg = (F.heading * 180) / Math.PI;
      ear.select(".ear-face").attr("transform", `rotate(${deg.toFixed(1)})`);
      const bearing = `${Math.round(((deg % 360) + 360) % 360)}°`;
      ear.select("title").text(`you listen from ${L.label}${L.approx ? " (an approx position)" : ""}, facing ${F.mode === "north" ? "north (east on the right)" : `the activity (${bearing} from north): it is in front`} · drag the ear to move it; facing and place in config · C`);
    }
    if (ctx.setListener) ear.call(d3.drag()
      .container(top.node())
      .on("start", () => ear.classed("drag", true))
      .on("drag", (e) => {
        const snap = stations().find((s) => { if (!s.placed) return false; const q = proj([s.lon, s.lat]); return q && (q[0] - e.x) ** 2 + (q[1] - e.y) ** 2 < 100; });
        const ll = proj.invert([e.x, e.y]);
        ctx.setListener(snap ? { station: snap.id } : { lat: ll[1], lon: ll[0] }, { dragging: true });
      })
      .on("end", () => { ear.classed("drag", false); ctx.setListener(ctx.listenerRaw()); }));   // once more, not dragging: the dock and legend follow

    fetch("geo/reykjanes_coast.geojson", { cache: "no-store" }).then((r) => r.json()).then((j) => { geo = j; resize(); });
    new ResizeObserver(() => resize()).observe(host);
    resize();
    return {
      redraw() { dirty = true; },
      frame() { draw(); },
      restyle() { drawStatic(); drawEar(); dirty = true; },
      earMoved() { drawEar(); },
      // pan for /svk_event: the epicentre's x in the map's frame, −1 … 1
      panOf(lon, lat) { const q = proj([lon, lat]); return q ? Math.max(-1, Math.min(1, (q[0] / W) * 2 - 1)) : 0; },
      clearBox() { box = null; bg.call(brush.move, null); },
      source() { return geo && geo.source; },
    };
  }
  return { create };
})();
