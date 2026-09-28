// dark_ocean · TIME WHEEL navigator — the wheel picks WHEN, the map shows WHERE.
// A compact year→month sunburst over the cube's frames: click a month → the map jumps
// to that frame; a playhead ring follows the scrub/play; arcs colour by a temporal
// signal (the current continuous field, else temperature). Standalone multiyear.html
// keeps the full year→month→day wheel; this docked one matches the cube's 33 months.
window.TimeWheel = (function () {
  const MON = ["", "J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"];
  const MONF = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  let R0 = 27, R1 = 56, R2 = 92, CX = 105, CY = 105;   // set from size in render()
  let g, root, monthByFrame = {}, dates = [], onSelect = () => {}, onDrill = null, valueOf = () => 0.5,
      colorFn = u => u, cur = 0, dailyMonths = new Set(), lastContainer = null, lastOpts = null;

  const arc = d3.arc()
    .startAngle(d => d.x0).endAngle(d => d.x1)
    .innerRadius(d => d.depth === 1 ? R0 : R1)
    .outerRadius(d => d.depth === 1 ? R1 : R2).padAngle(0.006);

  function build() {
    const recs = dates.map((d, i) => ({ d, i, y: +d.slice(0, 4), m: +d.slice(5, 7) }));
    const byYear = d3.group(recs, r => r.y);
    const tree = { children: [...byYear].sort((a, b) => a[0] - b[0]).map(([y, rs]) =>
      ({ name: "" + y, y, children: rs.sort((a, b) => a.m - b.m).map(r => ({ leaf: r })) })) };
    root = d3.hierarchy(tree).sum(d => d.leaf ? 1 : 0)
      .sort((a, b) => (a.data.leaf ? a.data.leaf.i : a.data.y) - (b.data.leaf ? b.data.leaf.i : b.data.y));
    d3.partition().size([2 * Math.PI, R2])(root);
    monthByFrame = {}; root.descendants().forEach(n => { if (n.data.leaf) monthByFrame[n.data.leaf.i] = n; });
  }

  function render(container, opts) {
    lastContainer = container; lastOpts = opts;
    dates = opts.dates; onSelect = opts.onSelect || onSelect; onDrill = opts.onDrill || onDrill;
    valueOf = opts.valueOf || valueOf; colorFn = opts.colorFn || colorFn; cur = opts.current || 0;
    dailyMonths = opts.dailyMonths || dailyMonths;
    const S = opts.size || 210;
    CX = CY = S / 2; R2 = S / 2 - 13; R1 = Math.round(R2 * 0.61); R0 = Math.round(R2 * 0.29);
    build();
    d3.select(container).selectAll("svg").remove();      // keep sibling controls (expand btn); replace only the wheel
    const svg = d3.select(container).append("svg").attr("width", S).attr("height", S);
    g = svg.append("g").attr("transform", `translate(${CX},${CY})`);
    // month arcs (outer) — click = jump; if daily data exists, dbl-click = drill into its days
    g.selectAll("path.tw-m").data(root.descendants().filter(d => d.depth === 2)).join("path")
      .attr("class", "tw-m").attr("d", arc)
      .attr("cursor", d => dailyMonths.has(dates[d.data.leaf.i]) ? "zoom-in" : "pointer")
      .style("stroke", "var(--ds-arc-gap, #0a0e1a)").attr("stroke-width", 0.5)
      .on("mousemove", (e, d) => center(d.data.leaf.i, true))
      .on("mouseleave", () => center(cur, false))
      .on("click", (e, d) => { onSelect(d.data.leaf.i); })
      .on("dblclick", (e, d) => { if (onDrill && dailyMonths.has(dates[d.data.leaf.i])) onDrill(dates[d.data.leaf.i]); });
    // year arcs (inner) — click = jump to that year's first month
    g.selectAll("path.tw-y").data(root.descendants().filter(d => d.depth === 1)).join("path")
      .attr("class", "tw-y").attr("d", arc).attr("cursor", "pointer")
      .style("fill", "var(--ds-wheel-fill, #141a34)").style("stroke", "var(--ds-arc-gap, #0a0e1a)").attr("stroke-width", 0.7)
      .on("click", (e, d) => { onSelect(d.leaves()[0].data.leaf.i); });
    g.selectAll("text.tw-yl").data(root.descendants().filter(d => d.depth === 1)).join("text")
      .attr("class", "tw-yl").style("fill", "var(--ds-label, #8a97c4)").attr("font-size", "8px").attr("text-anchor", "middle")
      .attr("transform", d => { const a = (d.x0 + d.x1) / 2 - Math.PI / 2, r = (R0 + R1) / 2;
        return `translate(${Math.cos(a) * r},${Math.sin(a) * r})`; })
      .attr("dy", ".35em").text(d => "'" + d.data.name.slice(2));
    g.append("circle").attr("class", "tw-play").attr("fill", "none")
      .style("stroke", "var(--ds-ring, #ffe08a)").attr("stroke-width", 2).attr("pointer-events", "none");
    g.append("text").attr("class", "tw-ctr").attr("text-anchor", "middle").attr("dy", "-.15em")
      .style("fill", "var(--ds-chart-txt, #c9d3ee)").attr("font-size", "12px");
    g.append("text").attr("class", "tw-sub").attr("text-anchor", "middle").attr("dy", "1.1em")
      .style("fill", "var(--ds-dim, #5f6a8c)").attr("font-size", "8px").text("time");
    // daily-available months → a small dot ("dbl-click to drill into days")
    g.selectAll("circle.tw-daily")
      .data(root.descendants().filter(d => d.depth === 2 && dailyMonths.has(dates[d.data.leaf.i]))).join("circle")
      .attr("class", "tw-daily").attr("r", 1.6).style("fill", "var(--ds-ring, #ffe08a)").attr("pointer-events", "none")
      .attr("cx", d => { const a = (d.x0 + d.x1) / 2 - Math.PI / 2; return Math.cos(a) * (R2 - 3); })
      .attr("cy", d => { const a = (d.x0 + d.x1) / 2 - Math.PI / 2; return Math.sin(a) * (R2 - 3); });
    recolor(); setCurrent(cur); applySelHi();
  }
  function resize(size) { if (lastContainer) render(lastContainer, Object.assign({}, lastOpts, { size, current: cur })); }
  let sel = null;
  function applySelHi() { if (g) g.selectAll("path.tw-m").attr("opacity", d => sel ? (sel.has(d.data.leaf.i) ? 1 : 0.22) : 1); }
  function setSelection(frames) { sel = frames ? new Set(frames) : null; applySelHi(); }

  function recolor() {
    if (!g) return;
    g.selectAll("path.tw-m").attr("fill", d => colorFn(valueOf(d.data.leaf.i)));
  }
  function center(i, hover) {
    if (!g) return;
    g.select("text.tw-ctr").text(dates[i]);
    g.select("text.tw-sub").text(hover ? MONF[+dates[i].slice(5)] : "time");
  }
  function setCurrent(i) {
    cur = i; if (!g) return;
    const n = monthByFrame[i]; if (!n) return;
    const a = (n.x0 + n.x1) / 2 - Math.PI / 2, r = (R1 + R2) / 2;
    g.select("circle.tw-play").attr("cx", Math.cos(a) * r).attr("cy", Math.sin(a) * r).attr("r", 3.5);
    g.selectAll("path.tw-m").attr("stroke-width", d => d.data.leaf.i === i ? 1.8 : 0.5)
      .style("stroke", d => d.data.leaf.i === i ? "var(--ds-ring, #ffe08a)" : "var(--ds-arc-gap, #0a0e1a)");
    center(i, false);
  }
  return { render, recolor, setCurrent, resize, setSelection };
})();
