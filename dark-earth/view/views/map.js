// dark_svartsengi · views/map.js — view B, the map (DESIGN §5 B). W3.
//
// D3 geo over a LOCAL coastline (geo/reykjanes_coast.geojson, Natural Earth 1:10m, public domain). No tile servers.
//   - the epicentres of the window on the timeline, fading with age before the cursor (after it: faint outlines);
//   - stations whose coordinates are pending (StationXML) are LISTED, never placed;
//   - a brush selects events by place: the timeline dims the rest and the Swarm hears only the selection;
//   - at the hours and minutes levels, a polarization arrow for MELH, in a compass inset (MELH itself is not placed:
//     its position is pending, and the direction is in the sensor's frame, ambiguous by 180°).
window.SvkMap = (function () {
  "use strict";
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);

  function create(host, ctx) {
    const { S } = ctx;
    host.classList.add("mapv");
    host.innerHTML = `<svg class="map-svg"><g class="map-grat"></g><path class="map-land"></path><path class="map-coast"></path>
        <g class="map-places"></g><g class="map-st"></g><g class="map-scale"></g><g class="map-brush"></g></svg>
      <canvas class="map-cv"></canvas>
      <div class="map-pol"><svg viewBox="-40 -40 80 80"><circle r="30" class="pol-ring"></circle><text y="-32" class="pol-n">N</text>
        <line class="pol-arrow" x1="0" y1="0" x2="0" y2="0"></line><path class="pol-h1"></path><path class="pol-h2"></path></svg>
        <div class="pol-txt"></div></div>
      <div class="map-pending"></div><div class="map-sel"></div><div class="hbox map-hbox"></div>`;
    const svg = d3.select(host).select(".map-svg"), cv = host.querySelector(".map-cv"), g = cv.getContext("2d");
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
      svg.attr("width", W).attr("height", H);
      cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px";
      brush.extent([[0, 0], [W, H]]); bg.call(brush);
      fit(); drawStatic(); dirty = true;
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
      // placed stations (only those with real coordinates from StationXML / FDSN)
      const placed = (S.M.stations || []).filter((s) => isNum(s.lat) && isNum(s.lon) && !s.pending);
      svg.select(".map-st").selectAll("g").data(placed).join((en) => { const gg = en.append("g"); gg.append("path"); gg.append("text"); return gg; })
        .attr("transform", (s) => `translate(${proj([s.lon, s.lat])})`)
        .call((gg) => { gg.select("path").attr("d", "M0,-6 L5,4 L-5,4 Z"); gg.select("text").attr("x", 7).attr("y", 4).text((s) => s.id); });
      const pend = (S.M.stations || []).filter((s) => !(isNum(s.lat) && isNum(s.lon)) || s.pending);
      // listed, never placed; one short line, the stations' names on hover (the calm page, 2026-10-22)
      const mp = host.querySelector(".map-pending");
      mp.textContent = pend.length ? `${pend.length} station${pend.length > 1 ? "s" : ""} not placed` : "";
      mp.title = pend.length ? `coordinates pending StationXML: ${pend.map((s) => s.label || s.id).join(" · ")}` : "";
      mp.style.display = pend.length ? "" : "none";
    }
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

    // epicentres of the window, fading with age (relative to the cursor)
    function draw() {
      if (!dirty) return; dirty = false;
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
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
      if (!p) { arrow.attr("x2", 0).attr("y2", 0); h1.attr("d", null); h2.attr("d", null); el.querySelector(".pol-txt").textContent = ctx.polText(null); return; }
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
      const [t0, t1] = S.view, E = ctx.src.events(t0, t1);
      let best = -1, bd = 64;
      for (let k = E.i0; k < E.i1; k++) {
        const q = proj([E.lon[k], E.lat[k]]); if (!q) continue;
        const d = (q[0] - px) ** 2 + (q[1] - py) ** 2; if (d < bd) { bd = d; best = k; }
      }
      const ll = proj.invert([px, py]);
      const lines = best >= 0 ? ctx.eventLines(best) : [`<span class="dim">${ll[1].toFixed(3)}° N, ${(-ll[0]).toFixed(3)}° W</span>`];
      hbox.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
      hbox.style.display = "block";
      const bw = hbox.offsetWidth, bh = hbox.offsetHeight;
      hbox.style.left = Math.max(2, px + 14 + bw > W ? px - bw - 14 : px + 14) + "px";
      hbox.style.top = Math.max(2, py + 14 + bh > H ? py - bh - 14 : py + 14) + "px";
    }

    fetch("geo/reykjanes_coast.geojson", { cache: "no-store" }).then((r) => r.json()).then((j) => { geo = j; resize(); });
    new ResizeObserver(() => resize()).observe(host);
    resize();
    return {
      redraw() { dirty = true; },
      frame() { draw(); },
      restyle() { drawStatic(); dirty = true; },
      // pan for /svk_event: the epicentre's x in the map's frame, −1 … 1
      panOf(lon, lat) { const q = proj([lon, lat]); return q ? Math.max(-1, Math.min(1, (q[0] / W) * 2 - 1)) : 0; },
      clearBox() { box = null; bg.call(brush.move, null); },
      source() { return geo && geo.source; },
    };
  }
  return { create };
})();
