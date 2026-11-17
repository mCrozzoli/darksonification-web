// dark_ocean · SUNBURST — the year→month→day time wheel (shared by multiyear.html
// AND the map's expanded time-navigator). Renders the nested-ring sunburst over the
// region-mean daily record, coloured by a selectable variable; emits hover/select
// events with rich node info so the host decides what to do (readout, strip, or —
// in the map — switch the display's resolution: month→monthly, day→daily).
//
// Interaction (2026-07-18):
//   • HOVER-HOLD — hovering a day HOLDS its whole month block lit (a playhead marks the
//     exact day) instead of the single arc darting around as you sweep.
//   • DRAG-SELECT — press-drag along a ring selects a contiguous span; the ring you drag
//     on sets the RESOLUTION (day-ring → daily, month-ring → monthly, year-ring → years),
//     and starting a drag on another ring REPLACES the previous selection. The span stays
//     highlighted (persistent) until cleared. A single click selects one node; clicking the
//     same node again clears.
//   • ADD / REMOVE (2026-10-02, Miguel: "if i select a couple of months … and want to select another
//     area the prev selection is deleted"): Shift/⌘-drag on the SAME ring ADDS a span to the selection
//     (it can now be several spans); Shift/⌘-click on a selected piece removes it. A plain drag still
//     starts afresh; the host's "clear" empties it. getSelection() reports the spans as `runs`.
//   • AVAILABILITY — pass availableMonths (["YYYY-MM"]) and months WITHOUT per-gridpoint
//     daily are greyed (shown, not hidden) with a marker on the ones that do have it.
//   • The host reads getSelection() (single node OR {kind:"span",resolution,dates,…}) to
//     commit to the display; the wheel never navigates on its own.
window.Sunburst = (function () {
  const VARC = {
    thetao: u => d3.interpolateRdYlBu(1 - u), so: u => d3.interpolateBuPu(0.12 + 0.88 * u),
    chl: u => d3.interpolateYlGn(0.1 + 0.9 * u), o2: u => d3.interpolateGnBu(0.1 + 0.85 * u),
    no3: u => d3.interpolatePuBuGn(0.1 + 0.85 * u), ph: u => d3.interpolateCividis(u),
    nppv: u => d3.interpolateViridis(0.05 + 0.9 * u), phyc: u => d3.interpolateYlOrBr(0.1 + 0.85 * u),
  };
  const MON = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const RINGS = ["year", "month", "day"];
  let meta = null, days = [], root = null, VAR = "thetao", g = null, container = null, opts = null;
  let hoverNode = null, sel = null, availDaySet = null, availMonthSet = null;   // sel: null | {kind,ords,span,nodes,single}
  let dragging = null, dragStart = null, dragMoved = false, preSel = null, seasonal = false;
  const byKind = { year: [], month: [], day: [] };          // nodes per ring, chronological (_ord)
  const arc = d3.arc().startAngle(d => d.x0).endAngle(d => d.x1)
    .innerRadius(d => d.y0).outerRadius(d => d.y1).padAngle(0.002);

  // ── availability ──
  function ymOf(n) {
    if (n.data.kind === "day") return n.data.rec.d.slice(0, 7);
    if (n.data.kind === "month") return n.data.y + "-" + String(n.data.m).padStart(2, "0");
    return null;
  }
  function isAvail(n) {
    if (n.data.kind === "day") return availDaySet ? availDaySet.has(n.data.rec.d) : (availMonthSet ? availMonthSet.has(ymOf(n)) : true);
    if (n.data.kind === "month") return availMonthSet ? availMonthSet.has(ymOf(n)) : true;
    return true;                                   // years are never a daily-drill target
  }

  function build() {
    const byY = d3.group(days, d => d.y, d => d.m);
    const tree = { name: "all", children: [] };
    for (const [y, months] of [...byY].sort((a, b) => a[0] - b[0])) {
      const yn = { name: "" + y, kind: "year", key: y, children: [] };
      for (const [m, recs] of [...months].sort((a, b) => a[0] - b[0]))
        yn.children.push({ name: "" + m, kind: "month", key: y * 100 + m, y, m,
          children: recs.map(r => ({ name: r.d, kind: "day", rec: r })) });
      tree.children.push(yn);
    }
    root = d3.hierarchy(tree).sum(d => d.children ? 0 : 1).sort((a, b) => (a.data.key ?? 0) - (b.data.key ?? 0));
    root.each(n => {
      const lv = n.leaves(); n._means = {};
      meta.vars.forEach(v => n._means[v] = d3.mean(lv, l => l.data.rec.v[v]));
      n._wm = [0, 1, 2].map(k => d3.mean(lv, l => l.data.rec.wm[k])); n._n = lv.length;
    });
    // chronological ordinal per ring → contiguous span selection by _ord range
    byKind.year = []; byKind.month = []; byKind.day = [];
    root.descendants().forEach(n => { if (byKind[n.data.kind]) byKind[n.data.kind].push(n); });
    const keyOf = n => n.data.kind === "year" ? +n.data.name
      : n.data.kind === "month" ? n.data.y * 100 + n.data.m : n.data.rec.d;   // 'YYYY-MM-DD' sorts chronologically
    for (const k of RINGS) {
      byKind[k].sort((a, b) => keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0);
      byKind[k].forEach((n, i) => n._ord = i);
    }
  }

  function layoutAndDraw() {
    const w = container.clientWidth, h = container.clientHeight,
          R = Math.max(90, Math.min(w, h) / 2 - 18), cx = w / 2, cy = h / 2;
    d3.partition().size([2 * Math.PI, R])(root);
    d3.select(container).selectAll("svg").remove();
    const svg = d3.select(container).append("svg").attr("width", "100%").attr("height", "100%")
      .style("touch-action", "none")
      .on("pointerleave", () => { if (!dragging) { hoverNode = null; markSel(); emit("onHover", currentInfo()); } });
    g = svg.append("g").attr("transform", `translate(${cx},${cy})`);
    g.selectAll("path.sb-arc").data(root.descendants().filter(d => d.depth > 0)).join("path")
      .attr("class", "sb-arc").attr("d", arc).style("stroke", "var(--ds-arc-gap-overlay, #080b14)").attr("stroke-width", 0.4)
      .style("cursor", d => RINGS.includes(d.data.kind) ? "pointer" : "default")
      .attr("fill", d => VARC[VAR](d._means[VAR]))
      .on("pointerdown", (e, d) => startDrag(e, d))
      .on("pointerenter", (e, d) => {
        hoverNode = d;
        if (dragging && d.data.kind === dragging.kind) extendDrag(d);
        markSel(); emit("onHover", currentInfo());
      });
    g.selectAll("text.sb-yl").data(root.descendants().filter(d => d.depth === 1)).join("text")
      .attr("class", "sb-yl").style("fill", "var(--ds-label, #8a97c4)").attr("font-size", Math.min(13, R * 0.06) + "px")
      .attr("text-anchor", "middle").attr("dy", ".35em").attr("pointer-events", "none")
      .attr("transform", d => { const a = (d.x0 + d.x1) / 2 - Math.PI / 2, r = (d.y0 + d.y1) / 2;
        return `translate(${Math.cos(a) * r},${Math.sin(a) * r})`; })
      .text(d => d.data.name);
    // GREEN outer ring over the days that HAVE per-gridpoint daily data — the drill-able days.
    // Contiguous available days merge into one arc (Nov 1–10 → a single green line at the top).
    if (availDaySet) {
      const av = byKind.day.filter(n => availDaySet.has(n.data.rec.d)).sort((a, b) => a._ord - b._ord), runs = [];
      for (const n of av) {
        const last = runs[runs.length - 1];
        if (last && n._ord === last._o + 1) { last.x1 = n.x1; last._o = n._ord; }
        else runs.push({ x0: n.x0, x1: n.x1, _o: n._ord });
      }
      const ring = d3.arc().innerRadius(R + 3).outerRadius(R + 6).startAngle(d => d.x0).endAngle(d => d.x1).cornerRadius(2);
      g.selectAll("path.sb-avail-ring").data(runs).join("path").attr("class", "sb-avail-ring")
        .attr("d", ring).style("fill", "var(--ds-avail, #34d399)").attr("pointer-events", "none");
    }
    g.append("text").attr("class", "sb-ctr").attr("text-anchor", "middle").attr("dy", "-.1em")
      .style("fill", "var(--ds-chart-txt, #c9d3ee)").attr("font-size", "16px").attr("pointer-events", "none");
    g.append("text").attr("class", "sb-sub").attr("text-anchor", "middle").attr("dy", "1.4em")
      .style("fill", "var(--ds-dim, #5f6a8c)").attr("font-size", "10px").attr("pointer-events", "none");
    markSel();
  }

  // ── drag-select ──
  function startDrag(e, d) {
    if (!RINGS.includes(d.data.kind)) return;
    e.preventDefault();
    // Shift/⌘ on the ring already selected = ADD to it (on another ring it starts afresh, as a plain drag)
    const add = (e.shiftKey || e.metaKey || e.ctrlKey) && !!sel && sel.kind === d.data.kind;
    preSel = sel; dragStart = d; dragMoved = false;
    dragging = { kind: d.data.kind, a: d._ord, b: d._ord, add, base: add ? new Set(sel.ords) : null };
    setSelFromDrag(); markSel();
  }
  function extendDrag(d) { if (d !== dragStart) dragMoved = true; dragging.b = d._ord; setSelFromDrag(); markSel(); }
  function setSelFromDrag() {
    const { kind, a, b, base } = dragging, lo = Math.min(a, b), hi = Math.max(a, b);
    const ords = new Set(base || []);
    for (let o = lo; o <= hi; o++) ords.add(o);
    setSel(kind, ords);
  }
  function setSel(kind, ords) {                       // the selection = a set of positions on one ring
    if (!ords.size) { sel = null; return; }
    const span = byKind[kind].filter(n => ords.has(n._ord));
    sel = { kind, ords, span, nodes: span, single: span.length === 1 };
    if (kind === "month") sel.monthNums = [...new Set(span.map(n => n.data.m))];
    applySeasonal();
  }
  function runsOf(nodes) {                            // contiguous runs along the ring: [[first, last], …]
    const out = [];
    for (const n of nodes) { const L = out[out.length - 1]; if (L && n._ord === L[1]._ord + 1) L[1] = n; else out.push([n, n]); }
    return out;
  }
  // SEASONAL cross-cut: a month selection expands to the SAME month(s) in EVERY year
  // (Jun–Aug → all summers). Folded in from the old month-of-year strip. Toggle re-derives
  // from the drag's month-numbers (on → all years, off → the original contiguous span).
  function applySeasonal() {
    if (!sel) return;
    if (seasonal && sel.kind === "month" && sel.monthNums) {
      const set = new Set(sel.monthNums);
      sel.nodes = byKind.month.filter(n => set.has(n.data.m)); sel.seasonal = true;
    } else { sel.nodes = sel.span || sel.nodes; sel.seasonal = false; }
  }
  function setSeasonal(on) { seasonal = on; if (sel) applySeasonal(); markSel(); emit("onSelect", selInfo()); }
  function endDrag() {
    if (!dragging) return;
    if (!dragMoved && dragging.add && dragging.base.has(dragStart._ord)) {           // Shift/⌘-click a selected piece: remove it
      const left = new Set(dragging.base); left.delete(dragStart._ord); setSel(dragging.kind, left);
      dragging = null; dragStart = null; markSel(); emit("onSelect", sel ? selInfo() : info(null)); return;
    }
    if (!dragMoved && !dragging.add && preSel && preSel.single && (preSel.span || preSel.nodes)[0] === dragStart) {
      sel = null; dragging = null; dragStart = null; markSel(); emit("onSelect", info(null)); return;  // re-click clears
    }
    dragging = null; dragStart = null; markSel(); emit("onSelect", selInfo());
  }
  window.addEventListener("pointerup", endDrag);

  // ── highlight (hover-hold + persistent selection + availability greying) ──
  function isRel(d, s) { return d === s || d.ancestors().includes(s) || s.ancestors().includes(d); }
  function selHiSet() {
    if (!sel) return null;
    const set = new Set();
    for (const n of sel.nodes) { n.ancestors().forEach(a => set.add(a)); n.descendants().forEach(dd => set.add(dd)); }
    return set;
  }
  function markSel() {
    if (!g) return;
    // when hovering a DAY, HOLD its whole month block (fixes the "lights jump" feel).
    // during a drag the span itself is the highlight — don't let hover wobble it.
    const hold = (hoverNode && !dragging) ? (hoverNode.data.kind === "day" ? hoverNode.parent : hoverNode) : null;
    const selHi = selHiSet(), active = selHi || hold;
    g.selectAll("path.sb-arc")
      .attr("opacity", d => {
        let o = isAvail(d) ? 1 : 0.4;
        if (active) o *= ((selHi && selHi.has(d)) || (hold && isRel(d, hold))) ? 1 : 0.3;
        return o;
      })
      .attr("stroke-width", d => d === hoverNode ? 1.8 : (sel && sel.nodes.includes(d) ? 1.2 : 0.4))
      .style("stroke", d => d === hoverNode ? "var(--ds-txt-hi, #fff)" : (sel && sel.nodes.includes(d) ? "var(--ds-ring, #ffe08a)" : "var(--ds-arc-gap-overlay, #080b14)"));
    const [lab, sub] = centerLabel();
    g.select("text.sb-ctr").text(lab.length > 15 ? lab.slice(0, 15) : lab); g.select("text.sb-sub").text(sub);
  }
  function centerLabel() {
    if (hoverNode) return lbl(hoverNode);
    if (sel) {
      if (sel.nodes.length === 1) return lbl(sel.nodes[0]);
      if (sel.seasonal) return [[...new Set(sel.nodes.map(n => MON[n.data.m]))].join("/"), "all years · " + sel.nodes.length + " mo"];
      const k = runsOf(sel.nodes).length;
      if (k > 1) return [k + " spans", sel.nodes.length + " " + sel.kind + "s"];
      return [spanLabel(sel), sel.kind + " span · " + sel.nodes.length];
    }
    return lbl(null);
  }
  function lbl(d) {
    if (!d) return [meta.range ? meta.range[0].slice(0, 4) + "–" + meta.range[1].slice(0, 4) : "", "the whole record"];
    if (d.data.kind === "year") return [d.data.name, "year"];
    if (d.data.kind === "month") return [MON[d.data.m] + " " + d.data.y, "month" + (isAvail(d) ? "" : " · monthly only")];
    if (d.data.kind === "day") return [d.data.rec.d, "day" + (isAvail(d) ? "" : " · not pulled")];
    return [d.data.name, ""];
  }
  function runLabel(kind, a, b) {
    const one = n => kind === "day" ? n.data.rec.d : kind === "month" ? MON[n.data.m] + " " + n.data.y : n.data.name;
    return a === b ? one(a) : one(a) + " … " + one(b);
  }
  function spanLabel(s) {
    const runs = runsOf(s.nodes);
    if (runs.length === 1) return runLabel(s.kind, runs[0][0], runs[0][1]);
    const parts = runs.slice(0, 3).map(([a, b]) => runLabel(s.kind, a, b));
    return parts.join(" + ") + (runs.length > 3 ? ` + ${runs.length - 3} more` : "");
  }

  // ── info objects the host acts on ──
  function info(d) {
    if (!d) return { kind: "all", label: "the whole record", n: root._n, means: root._means, wm: root._wm, dates: [], available: true, node: root };
    const [label, sub] = lbl(d), lv = d.leaves();
    return { kind: d.data.kind, label, sub,
      year: d.data.kind === "year" ? +d.data.name : (d.data.y ?? null), month: d.data.m ?? null,
      dayDate: d.data.kind === "day" ? d.data.rec.d : null, dates: lv.map(l => l.data.rec.d),
      months: [...new Set(lv.map(l => l.data.rec.d.slice(0, 7)))],
      n: d._n, means: d._means, wm: d._wm, available: isAvail(d), node: d };
  }
  function spanInfo(s) {
    const lv = []; s.nodes.forEach(n => lv.push(...n.leaves()));
    const means = {}; meta.vars.forEach(v => means[v] = d3.mean(lv, l => l.data.rec.v[v]));
    const wm = [0, 1, 2].map(k => d3.mean(lv, l => l.data.rec.wm[k]));
    const dates = lv.map(l => l.data.rec.d).sort();
    const months = [...new Set(dates.map(d => d.slice(0, 7)))].sort();
    const label = s.seasonal ? [...new Set(s.nodes.map(n => MON[n.data.m]))].join("/") + " · all years" : spanLabel(s);
    const runs = runsOf(s.nodes).map(([a, b]) => { const la = a.leaves(), lb = b.leaves();
      return [la[0].data.rec.d, lb[lb.length - 1].data.rec.d]; });                    // each span's first and last day
    return { kind: "span", resolution: s.kind, seasonal: !!s.seasonal, label, runs,
      sub: s.seasonal ? "seasonal · " + s.nodes.length + " months" : s.kind + " span · " + s.nodes.length,
      dates, months, years: [...new Set(dates.map(d => d.slice(0, 4)))], first: dates[0], last: dates[dates.length - 1],
      availMonths: months.filter(m => !availMonthSet || availMonthSet.has(m)),
      n: lv.length, means, wm, available: months.every(m => !availMonthSet || availMonthSet.has(m)), node: s.nodes[0] };
  }
  function selInfo() { return !sel ? info(null) : (sel.nodes.length === 1 ? info(sel.nodes[0]) : spanInfo(sel)); }
  function currentInfo() { return hoverNode ? info(hoverNode) : selInfo(); }
  function emit(name, i) { if (opts && opts[name]) opts[name](i); }

  function render(cont, o) {
    container = cont; opts = o; days = o.days; meta = o.meta; VAR = o.variable || "thetao";
    availDaySet = o.availableDays ? new Set(o.availableDays) : null;   // day-level (from the manifest's real dates)
    availMonthSet = availDaySet ? new Set([...availDaySet].map(d => d.slice(0, 7)))
      : (o.availableMonths ? new Set(o.availableMonths) : null);
    sel = null; hoverNode = null; dragging = null; seasonal = false;
    build(); layoutAndDraw(); return api;
  }
  function setVariable(v) { VAR = v; if (g) g.selectAll("path.sb-arc").attr("fill", d => VARC[VAR](d._means[VAR])); }
  function setAvailable(days) { availDaySet = days ? new Set(days) : null;
    availMonthSet = availDaySet ? new Set([...availDaySet].map(d => d.slice(0, 7))) : null; if (g) layoutAndDraw(); }
  function clearSelection() { sel = null; hoverNode = null; markSel(); }
  function getSelection() { return sel ? selInfo() : null; }
  function resize() { if (container && root) layoutAndDraw(); }
  // the look's scales (style kit): null = the originals above
  const ORIG = Object.assign({}, VARC);
  function setScales(o) { Object.assign(VARC, ORIG, o || {}); if (g) g.selectAll("path.sb-arc").attr("fill", d => VARC[VAR](d._means[VAR])); }
  const api = { render, setVariable, setAvailable, setSeasonal, setScales, clearSelection, getSelection, resize, VARC, MON, get variable() { return VAR; } };
  return api;
})();
