// Uncanny Listening — the song timeline (brief §4.3): one song's 10 s segments over time, her four descriptors (segment
// means, each scaled over every segment of the corpus), the model on each segment and where it crosses the boundary.
// Pressing and moving along it plays the segment under the pointer. drawTimeline(root, ctx) → {update()}
// ctx: {song(), lines: [{col, label, colour}], scale(col) → [lo, hi], classes, colours, thr, playing() → {t, song} | null,
//       play(song, seg), seek(song, t)}
const d3 = window.d3;
export function drawTimeline(root, ctx) {
  root.innerHTML = "";
  const W = Math.max(480, root.clientWidth - 8), H1 = 230, H2 = 70, m = { l: 46, r: 14, t: 10, b: 24 };
  const svg = d3.select(root).append("svg").attr("class", "tlsvg").attr("viewBox", `0 0 ${W} ${H1 + H2 + 40}`).attr("width", W).attr("height", H1 + H2 + 40);
  const s = ctx.song(); if (!s) { root.innerHTML = `<p class="k">${ctx.empty}</p>`; return { update() {} }; }
  const x = d3.scaleLinear().domain([0, s.duration]).range([m.l, W - m.r]), y = d3.scaleLinear().domain([0, 1]).range([H1 - m.b, m.t]);
  const y2 = d3.scaleLinear().domain([0, 1]).range([H1 + H2, H1 + 12]);
  const g = svg.append("g");
  g.append("g").attr("class", "axes").attr("transform", `translate(0,${H1 - m.b})`).call(d3.axisBottom(x).ticks(8).tickFormat((v) => `${Math.floor(v / 60)}:${String(Math.round(v % 60)).padStart(2, "0")}`));
  g.append("g").attr("class", "axes").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(4));
  // her descriptors, one line each (each 10 s segment drawn over its window)
  const mid = (r) => (r.window_start + r.window_end) / 2;
  for (const L of ctx.lines) {
    const [lo, hi] = ctx.scale(L.col), v = (r) => (r[L.col] - lo) / (hi - lo || 1);
    g.append("path").attr("class", "tl-line").attr("stroke", L.colour).attr("d", d3.line().x((r) => x(mid(r))).y((r) => y(v(r))).curve(d3.curveMonotoneX)(s.l1));
    const last = s.l1[s.l1.length - 1]; if (last) g.append("text").attr("class", "tl-lab").attr("x", x(mid(last)) + 4).attr("y", y(v(last))).attr("fill", L.colour).text(L.label);
  }
  // the model on each segment: P(second class) for 2 classes (the threshold drawn), else the winning class's probability
  if (s.segP) {
    const K = ctx.classes.length, pv = (i) => K === 2 ? s.segP[i][1] : Math.max(...s.segP[i]);
    g.append("text").attr("class", "tl-lab").attr("x", m.l).attr("y", H1 + 8).text(ctx.modelLabel);
    s.l1.forEach((r, i) => g.append("rect").attr("x", x(r.window_start)).attr("width", Math.max(1, x(r.window_end) - x(r.window_start)))
      .attr("y", y2(pv(i))).attr("height", y2(0) - y2(pv(i))).attr("fill", ctx.colours[s.segPred[i]]).attr("opacity", 0.75));
    if (K === 2) g.append("line").attr("class", "tl-thr").attr("x1", m.l).attr("x2", W - m.r).attr("y1", y2(ctx.thr)).attr("y2", y2(ctx.thr));
    // crossings: where the segment prediction changes class
    for (let i = 1; i < s.l1.length; i++) if (s.segPred[i] !== s.segPred[i - 1]) {
      const t = s.l1[i].window_start; g.append("line").attr("class", "tl-cross").attr("x1", x(t)).attr("x2", x(t)).attr("y1", m.t).attr("y2", y2(0));
    }
  }
  const head = g.append("line").attr("class", "tl-head").attr("y1", m.t).attr("y2", y2(0));
  const hov = g.append("rect").attr("class", "tl-hov").attr("y", m.t).attr("height", y2(0) - m.t);
  // press and move along it: the segment under the pointer plays
  let down = false, cur = -1;
  const segAt = (ev) => { const t = x.invert(d3.pointer(ev)[0]); let k = -1; s.l1.forEach((r, i) => { if (t >= r.window_start && t < r.window_end && (k < 0 || Math.abs(t - mid(r)) < Math.abs(t - mid(s.l1[k])))) k = i; }); return k; };
  svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", y2(0) - m.t).attr("fill", "transparent").style("cursor", "pointer")
    .on("pointermove", (ev) => { const k = segAt(ev); if (k >= 0) hov.attr("x", x(s.l1[k].window_start)).attr("width", x(s.l1[k].window_end) - x(s.l1[k].window_start)).attr("opacity", 1);
      if (down && k >= 0 && k !== cur) { cur = k; ctx.play(s, k); } })
    .on("pointerleave", () => hov.attr("opacity", 0))
    .on("pointerdown", (ev) => { down = true; ev.target.setPointerCapture(ev.pointerId); const k = segAt(ev); if (k >= 0) { cur = k; ctx.play(s, k); } })
    .on("pointerup", () => { down = false; cur = -1; });
  function update() { const p = ctx.playing(); if (p && p.song === s) head.attr("x1", x(p.t)).attr("x2", x(p.t)).attr("opacity", 1); else head.attr("opacity", 0); }
  update();
  return { update, svg: svg.node() };
}
