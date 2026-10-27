// Uncanny Listening — linked maps (small multiples, D3 + SVG so any view exports as a figure).
// Every map shows the same songs; hovering, selecting, brushing or tracing in one lights the same songs in all of them.
// makeMaps(root, ctx) → {update(), setDefs(defs)}. ctx supplies the data and the state:
//   songs [{id, ...}], value(song, axis) ∈ [0, 1], colour(song), stroke(song) | null, label(axis), title(def),
//   sel: Set of ids, hover: id | null, trace: [ids], brushed: Set | null, field(def) → {nx, ny, p: Float32Array} | null (P2),
//   on: {hover(id), click(id, ev), brush(ids | null)}
const d3 = window.d3;
const NS = "http://www.w3.org/2000/svg";

export function makeMaps(root, ctx) {
  let defs = [], cells = [];
  // the width to lay out in: the maps' own, or (while they are hidden behind another view) their parent's
  const cw = () => root.clientWidth || (root.parentElement && root.parentElement.clientWidth) || 900;
  const W = () => Math.max(220, Math.min(420, Math.floor((cw() - 24) / Math.max(1, Math.min(defs.length, cols())))) - 12);
  const cols = () => cw() > 1250 ? 4 : cw() > 900 ? 3 : cw() > 560 ? 2 : 1;

  function build() {
    root.innerHTML = ""; cells = [];
    const big = defs[0] && defs[0].big;
    defs.forEach((def, i) => {
      const fig = document.createElement("figure"); fig.className = "map" + (big && i === 0 ? " big" : "");
      const cap = document.createElement("figcaption"); fig.appendChild(cap);
      const size = big && i === 0 ? Math.max(W(), Math.min(2 * W() + 12, cw() - 24)) : W(), m = { l: 42, r: 8, t: 6, b: 28 };
      const svg = d3.select(fig).append("svg").attr("viewBox", `0 0 ${size} ${size}`).attr("width", size).attr("height", size).attr("class", "mapsvg");
      const iw = size - m.l - m.r, ih = size - m.t - m.b, x = d3.scaleLinear().domain([-0.03, 1.03]).range([m.l, m.l + iw]), y = d3.scaleLinear().domain([-0.03, 1.03]).range([m.t + ih, m.t]);
      svg.append("rect").attr("class", "frame").attr("x", m.l).attr("y", m.t).attr("width", iw).attr("height", ih);
      const gField = svg.append("g").attr("class", "field"), gAx = svg.append("g").attr("class", "axes");
      gAx.append("g").attr("transform", `translate(0,${m.t + ih})`).call(d3.axisBottom(x).ticks(4).tickSize(3));
      gAx.append("g").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4).tickSize(3));
      const xl = gAx.append("text").attr("class", "axlabel").attr("x", m.l + iw).attr("y", size - 2).attr("text-anchor", "end");
      const yl = gAx.append("text").attr("class", "axlabel").attr("transform", `translate(10,${m.t}) rotate(-90)`).attr("text-anchor", "end");
      const gTrace = svg.append("g").attr("class", "trace"), gPts = svg.append("g").attr("class", "pts"), gTop = svg.append("g").attr("class", "top");
      const brush = d3.brush().extent([[m.l, m.t], [m.l + iw, m.t + ih]])
        .filter((ev) => !ev.button && ev.altKey !== true)
        .on("end", (ev) => {
          if (!ev.sourceEvent) return;
          if (!ev.selection) { ctx.on.brush(null); return; }
          const [[a, b], [c, d]] = ev.selection, ids = new Set();
          for (const s of ctx.songs()) { const px = x(ctx.value(s, def.x)), py = y(ctx.value(s, def.y)); if (px >= a && px <= c && py >= b && py <= d) ids.add(s.id); }
          gBrush.call(brush.move, null); ctx.on.brush(ids);
        });
      const gBrush = svg.insert("g", ".pts").attr("class", "brush").call(brush);
      cells.push({ def, fig, cap, svg, x, y, gField, gTrace, gPts, gTop, xl, yl, size });
      root.appendChild(fig);
    });
    update();
  }

  function update() {
    const songs = ctx.songs(), sel = ctx.sel(), hov = ctx.hover(), tr = ctx.trace(), br = ctx.brushed();
    for (const c of cells) {
      c.cap.innerHTML = ctx.title(c.def); c.xl.text(ctx.label(c.def.x)); c.yl.text(ctx.label(c.def.y));
      // P2: the model's probability field (one image per map) and its boundary contours, when the model is on
      const F = ctx.field ? ctx.field(c.def) : null;
      c.gField.selectAll("*").remove();
      if (F) {
        const [x0, x1] = c.x.range(), [y1, y0] = c.y.range(), cv = document.createElement("canvas"); cv.width = F.nx; cv.height = F.ny;
        const g = cv.getContext("2d"), img = g.createImageData(F.nx, F.ny);
        for (let j = 0; j < F.ny; j++) for (let i = 0; i < F.nx; i++) {
          const k = j * F.nx + i, rgb = d3.rgb(F.fill(k)), o = ((F.ny - 1 - j) * F.nx + i) * 4;
          img.data[o] = rgb.r; img.data[o + 1] = rgb.g; img.data[o + 2] = rgb.b; img.data[o + 3] = Math.round(255 * F.alpha(k));
        }
        g.putImageData(img, 0, 0);
        c.gField.append("image").attr("href", cv.toDataURL()).attr("x", x0).attr("y", y0).attr("width", x1 - x0).attr("height", y1 - y0).attr("preserveAspectRatio", "none").style("image-rendering", "auto");
        const dx = (x1 - x0) / F.nx, dy = (y1 - y0) / F.ny, tx = d3.geoTransform({ point(px, py) { this.stream.point(x0 + px * dx, y1 - py * dy); } });
        for (const C of F.contours || []) {
          const th = d3.contours().size([F.nx, F.ny]).thresholds([C.thr])(Array.from(C.p));
          c.gField.selectAll(null).data(th).join("path").attr("class", "bound").attr("d", d3.geoPath(tx));
        }
      }
      const pts = c.gPts.selectAll("circle").data(songs, (s) => s.id);
      pts.join((en) => en.append("circle").attr("r", 3.4)
          .on("pointerenter", (ev, s) => ctx.on.hover(s.id, ev)).on("pointerleave", () => ctx.on.hover(null))
          .on("click", (ev, s) => ctx.on.click(s.id, ev)))
        .attr("cx", (s) => c.x(ctx.value(s, c.def.x))).attr("cy", (s) => c.y(ctx.value(s, c.def.y)))
        .attr("fill", (s) => ctx.colour(s))
        .attr("stroke", (s) => ctx.stroke(s) || "none").attr("stroke-width", (s) => ctx.stroke(s) ? 1.4 : 0)
        .attr("opacity", (s) => br && !br.has(s.id) && !sel.has(s.id) ? 0.14 : 0.88)
        .attr("r", (s) => sel.has(s.id) ? 5.2 : 3.4);
      // the trace: a path of songs, numbered, the same in every map
      const tp = tr.map((id) => songs.find((s) => s.id === id)).filter(Boolean).map((s) => [c.x(ctx.value(s, c.def.x)), c.y(ctx.value(s, c.def.y))]);
      c.gTrace.selectAll("*").remove();
      if (tp.length > 1) c.gTrace.append("path").attr("d", d3.line()(tp));
      c.gTrace.selectAll("text").data(tp).join("text").attr("x", (p) => p[0] + 6).attr("y", (p) => p[1] - 5).text((p, i) => i + 1);
      // selected and hovered songs on top, ringed
      c.gTop.selectAll("*").remove();
      for (const id of new Set([...sel, ...(hov != null ? [hov] : [])])) {
        const s = songs.find((q) => q.id === id); if (!s) continue;
        c.gTop.append("circle").attr("class", id === hov ? "ring hov" : "ring").attr("cx", c.x(ctx.value(s, c.def.x))).attr("cy", c.y(ctx.value(s, c.def.y))).attr("r", id === hov ? 8 : 7);
      }
    }
  }
  let rt = null; new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(() => defs.length && root.clientWidth && build(), 150); }).observe(root);
  return { update, setDefs(d) { defs = d; build(); }, cells: () => cells };
}
