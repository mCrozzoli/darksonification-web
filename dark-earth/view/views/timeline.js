// dark_svartsengi · views/timeline.js — view A, the zoomable timeline with semantic zoom (DESIGN §3, §5 A). W3.
//
// One d3.zoom axis over 10 s ↔ the whole sequence. zoom = log10(span on screen) picks the level weights (cook.js);
// each level draws its own lanes, and two neighbouring levels crossfade over half a decade by those weights.
//   sequence  GNSS sawtooth (SKSH bold) + dashed threshold lines at each eruption's start level · quake density · waveform coverage
//   cycle     GNSS uplift + quakes (time × depth, size = magnitude, rings at M ≥ 2)
//   day       band-energy ribbons (4 bands) + quakes + tilt
//   hours     spectrogram + waveform + catalogue ticks over the station's own detections + tilt
//   minutes   waveform, three components + catalogue ticks + tilt (the particle motion is drawn in the side panel)
// Canvas for the marks, one SVG on top for the axis, the cursor/playhead (gold = you), the right edge (now) and input.
// Gaps are a faint grey band, named on hover (manual C5 §10.7; Miguel 2026-10-22: the red hatching was overwhelming);
// interpolated GNSS is dashed (CONTRACT v0.2). The calm page (2026-10-22): no text boxes over the plot; a strip of month
// blocks over the axis; the room you are in lit as a band; traces as rings; the lens adds the optional lanes.
window.SvkTimeline = (function () {
  "use strict";
  const DAY = 86400;
  const fmtSpan = (s) => s >= 365.25 * DAY * 0.95 ? `${(s / (365.25 * DAY)).toFixed(1)} yr` : s >= 2 * DAY ? `${Math.round(s / DAY)} d`
    : s >= 2 * 3600 ? `${(s / 3600).toFixed(1)} h` : s >= 120 ? `${Math.round(s / 60)} min` : `${s.toFixed(s < 20 ? 1 : 0)} s`;
  const utc = (t) => new Date(t * 1000);
  const fmtT = d3.utcFormat("%a %-d %b %Y %H:%M:%S");
  const fmtDay = d3.utcFormat("%-d %b %Y");
  const isNum = (v) => typeof v === "number" && Number.isFinite(v);

  function create(host, ctx) {
    const { S, D } = ctx;
    host.classList.add("tl");
    host.innerHTML = `<canvas class="tl-cv"></canvas><svg class="tl-ov"><g class="tl-labels"></g><g class="tl-axis"></g>
      <line class="tl-end"></line><text class="tl-endtxt"></text><g class="tl-cur"><line class="tl-curline"></line><path class="tl-head"></path></g>
      <g class="tl-ph"><line class="tl-phline"></line><path class="tl-phdot"></path></g><rect class="tl-hit"></rect><rect class="tl-ovhit"></rect></svg>
      <input type="date" class="tl-date" title="go to a date (day, month, year) at the zoom you are at"><div class="tl-detail"></div><div class="hbox tl-hbox"></div>`;
    const cv = host.querySelector(".tl-cv"), g = cv.getContext("2d");
    const svg = d3.select(host).select("svg"), hit = svg.select(".tl-hit"), hbox = host.querySelector(".tl-hbox");
    const AXIS_H = 22, PAD_T = 4, STRIP_H = 8, OV_H = 40, OV_X = 142;   // OV: the time-series stripe under the axis, OV_X its left edge
    let W = 300, H = 200, HM = 160, dpr = 1, dirty = true;              // HM: the bottom of the main plot (above the stripe)
    const x = d3.scaleLinear();     // epoch s → px (the view)
    const x0 = d3.scaleLinear();    // epoch s → px (the base: t0 … now)
    let ignoreZoom = false;
    const zoom = d3.zoom().on("zoom", (e) => {
      if (ignoreZoom) return;
      const nx = e.transform.rescaleX(x0);
      ctx.setView(nx.domain()[0], nx.domain()[1], { from: "zoom", user: !!e.sourceEvent });
    });
    hit.call(zoom).on("dblclick.zoom", null);
    // a click puts the cursor there; shift-click traces that moment instead (re_wilding 3.2: navigating never traces)
    hit.on("click", (e) => {
      const [px, py] = d3.pointer(e);
      if (e.shiftKey && ctx.traceAt) { ctx.traceAt(x.invert(px)); return; }
      // the "no seismometer recording here" strip goes to the recording
      if (ctx.gotoRecording && lastLanes.some((l) => l.key === "nomelh" && py >= l.y && py <= l.y + l.h)) { ctx.gotoRecording(); return; }
      ctx.setCursor(x.invert(px), { from: "timeline" });
    });
    hit.on("pointermove", (e) => hover(e)).on("pointerleave", () => { hbox.style.display = "none"; ctx.hoverT && ctx.hoverT(null); });

    function baseDomain() { return [S.M.t0, Math.max(S.M.t0 + 10, ctx.now())]; }
    function syncZoom() {
      // put the d3 transform where S.view is, without the zoom event echoing back
      const [b0, b1] = baseDomain();
      x0.domain([b0, b1]).range([0, W]);
      const k = (b1 - b0) / Math.max(1e-6, S.view[1] - S.view[0]);
      const tx = -x0(S.view[0]) * k;
      zoom.scaleExtent([Math.min(1, k), (b1 - b0) / 10]).translateExtent([[0, 0], [W, H]]).extent([[0, 0], [W, H]]);
      ignoreZoom = true;
      hit.call(zoom.transform, d3.zoomIdentity.translate(tx, 0).scale(k));
      ignoreZoom = false;
    }
    function resize() {
      const r = host.getBoundingClientRect();
      W = Math.max(200, r.width); H = Math.max(200, r.height); HM = H - OV_H; dpr = window.devicePixelRatio || 1;
      cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px";
      svg.attr("width", W).attr("height", H);
      hit.attr("x", 0).attr("y", 0).attr("width", W).attr("height", HM - AXIS_H);
      ovhit.attr("x", OV_X).attr("y", HM + 2).attr("width", Math.max(10, W - OV_X - 4)).attr("height", OV_H - 4);
      dateEl.style.top = `${HM + 9}px`;
      syncZoom(); dirty = true;
    }

    // ------------------------------------------------------------------------------------------ lanes per level
    // [key, height share]; the lanes of the two levels in a crossfade overlap and fade into each other
    const LAYOUT = {
      4: [["gnss", 0.47], ["cycle", 0.11], ["array", 0.17], ["density", 0.16], ["coverage", 0.09]],
      3: [["gnss", 0.34], ["array", 0.20], ["events", 0.37], ["coverage", 0.09]],
      2: [["ribbons", 0.42], ["events", 0.36], ["tilt", 0.22]],
      1: [["spec", 0.40], ["wave1", 0.28], ["ticks", 0.14], ["tilt", 0.18]],
      0: [["wave3", 0.70], ["ticks", 0.12], ["tilt", 0.18]],
    };
    // each level draws its own picture (DESIGN §3's Picture column): the sequence's sawtooth with its eruption levels, the cycle
    // length and the velocities; the cycle's uplift, velocities and quakes by depth; the day's four bands; the hours' spectrogram;
    // the minutes' three components. They are the level, not lens extras (Miguel 2026-10-22: the calm page had hidden them), and
    // two neighbouring levels crossfade their different layouts at the boundary
    // …but the vent station recorded only one day (14 Jan 2024). Where the window holds none of it, the day / hours / minutes
    // MELH lanes (four bands, spectrogram, waveform, tilt) collapse into one thin quiet strip, and the room goes to what exists
    // every day: the ground's height, its velocities (day) and the quakes by depth (Miguel 2026-10-22: the empty lanes "take
    // over the screen"). Both levels of a crossfade read the same window, so the crossfade stays one picture into another
    // one layout for the three levels, so a crossfade between them fades each quake in place (not two rows of the same dots)
    const NO_MELH_ROWS = [["gnss", 0.34], ["array", 0.20], ["events", 0.40], ["nomelh", 0.06]];
    const NO_MELH = { 2: NO_MELH_ROWS, 1: NO_MELH_ROWS, 0: NO_MELH_ROWS };
    const melhHere = () => { const s = ctx.seismic(); return !s || ctx.src.covered(s.id, S.view[0], S.view[1]); };
    const layoutOf = (level) => (level <= 2 && !melhHere() ? NO_MELH[level] : LAYOUT[level]);
    function lanesOf(level) {
      const top = PAD_T, avail = HM - AXIS_H - STRIP_H - PAD_T;
      let y = top;
      return layoutOf(level).map(([key, h]) => { const lane = { key, y, h: h * avail - 3, level }; y += h * avail; return lane; });
    }

    // not measured: an absence (Miguel 2026-10-22, point 7: "a faint grey band or just an absence"). Nothing is drawn but one
    // faint dotted line through the lane, so the gap is not read as a zero; the hover names it. (A grey fill read LIGHTER than
    // the measured ground in the dark look, i.e. highlighted: the opposite of what it means.)
    function hatch(x0p, x1p, y, h, why, alpha) {
      if (x1p <= x0p) return;
      g.save(); g.globalAlpha = alpha * 0.35; g.strokeStyle = ctx.tok("--ds-dim"); g.lineWidth = 1; g.setLineDash([1, 4]);
      g.beginPath(); g.moveTo(x0p, y + h / 2); g.lineTo(x1p, y + h / 2); g.stroke(); g.restore();
    }
    // hatch everything in [t0,t1] that a source's coverage leaves out; returns true when nothing is covered
    function hatchUncovered(source, lane, alpha, why) {
      const cov = ctx.src.coverage(source), [t0, t1] = S.view;
      let cur = t0, any = false;
      for (const [a, b] of cov) {
        if (b <= t0 || a >= t1) continue;
        any = true;
        if (a > cur) hatch(x(cur), x(a), lane.y, lane.h, why, alpha);
        cur = Math.max(cur, b);
      }
      if (cur < t1) hatch(x(cur), x(t1), lane.y, lane.h, why, alpha);
      return !any;
    }

    // ----- GNSS + thresholds (CONTRACT v0.2–v0.4)
    // runs of consecutive days where flag[i] is true → [[i0, i1], …] (i1 inclusive)
    function runs(flag, n) {
      const out = []; let a = -1;
      for (let i = 0; i <= n; i++) { const f = i < n && !!flag[i]; if (f && a < 0) a = i; else if (!f && a >= 0) { out.push([a, i - 1]); a = -1; } }
      return out;
    }
    // one dashed line per magmatic eruption at the level where it began, from that eruption to the next (to now for
    // the last). Only "magmatic" events make one, and never across a stale stretch (reference eruption unknown).
    function thresholds() {
      const G = SvkCook.gnssDerived(S.M, D.gnss);
      if (!G || !G.falls) return [];
      const st = G.cols.recharge_stale || [], n = G.t.length, T0 = G.t[0];
      const staleRuns = runs(st, n).map(([a, b]) => [T0 + a * DAY, T0 + (b + 1) * DAY]);
      const out = [];
      G.falls.forEach((f, k) => {
        if (!isNum(f.U)) return;
        const a = T0 + f.d * DAY, b = k + 1 < G.falls.length ? T0 + G.falls[k + 1].d * DAY : ctx.now();
        let pieces = [[a, b]];
        for (const [s0, s1] of staleRuns) pieces = pieces.flatMap(([p, q]) => (s1 <= p || s0 >= q ? [[p, q]] : [[p, s0], [s1, q]].filter(([u, v]) => v - u > DAY / 2)));
        for (const [p, q] of pieces) out.push({ t0: p, t1: q, U: f.U, e: f.e });
      });
      return out;
    }
    const SPIKE = new Set(["spike", "suspect_common_mode"]);     // v0.3 retired the second name; W1's v0.2 files still carry it
    function drawGnss(lane, alpha) {
      const G = SvkCook.gnssDerived(S.M, D.gnss);
      if (!G) return;
      const T = G, [t0, t1] = S.view, C = ctx.col();
      const i0 = Math.max(0, Math.floor((t0 - T.t[0]) / DAY) - 1), i1 = Math.min(T.t.length, Math.ceil((t1 - T.t[0]) / DAY) + 2);
      const stations = ctx.gnssStations();
      let lo = Infinity, hi = -Infinity;
      for (const s of stations) {
        const a = T.cols[`${s}_u_mm`], sp = T.cols[`${s}_spike`] || [];
        if (!a) continue;
        for (let i = i0; i < i1; i++) if (isNum(a[i]) && !sp[i]) { lo = Math.min(lo, a[i]); hi = Math.max(hi, a[i]); }
      }
      const th = thresholds().filter((r) => r.t1 > t0 && r.t0 < t1);
      for (const r of th) { lo = Math.min(lo, r.U); hi = Math.max(hi, r.U); }
      if (!(hi > lo)) { hi = lo + 1; lo -= 1; }
      const padv = (hi - lo) * 0.08, y = d3.scaleLinear().domain([lo - padv, hi + padv]).range([lane.y + lane.h, lane.y + 14]);
      lane.y_ = y;
      g.save(); g.globalAlpha = alpha;
      // the stale stretch: the reference eruption is unknown, so no threshold and no wait there (v0.4)
      const st = T.cols.recharge_stale || [];
      lane.stale = [];
      for (const [a, b] of runs(st, T.t.length)) {
        const xa = x(T.t[a]), xb = x(T.t[b] + DAY);
        if (xb < 0 || xa > W) continue;
        lane.stale.push([T.t[a], T.t[b] + DAY]);
        g.globalAlpha = alpha * 0.5; g.fillStyle = ctx.tok("--ds-raised"); g.fillRect(xa, lane.y + 12, xb - xa, lane.h - 12);
        g.globalAlpha = alpha;
      }
      // eruption marks. v0.13, with W1's eruption list: ▼ an eruption · ▿ an intrusion (dashed), at its onset; × a spike and
      // ? a one-station step stay (they explain the line). The trace tab's comparison adds, faintly: ◌ dotted = a GNSS fall with no eruption in
      // the list (detected, unconfirmed); ○ under a mark = an eruption the GNSS did not see (confirmed, undetected).
      // Without the list: the GNSS detection's own marks, as before: ▼ magmatic · ◇ hidden by interpolation · × a spike
      // (never a fall) · ? unknown
      const mk = (px, glyph, dash, a) => {
        g.globalAlpha = alpha * a; g.strokeStyle = ctx.tok("--ds-line"); g.setLineDash(dash || []); g.lineWidth = 1;
        if (dash !== null) { g.beginPath(); g.moveTo(px, lane.y + 12); g.lineTo(px, lane.y + lane.h); g.stroke(); }
        g.setLineDash([]); g.fillStyle = ctx.tok("--ds-dim"); g.font = `10px ${ctx.tok("--ds-font-canvas")}`; g.fillText(glyph, px - 3, lane.y + 10);
        g.globalAlpha = alpha;
      };
      const EL = ctx.eruptions ? ctx.eruptions() : [];
      if (EL.length && EL[0].from === "eruptions") {
        for (const e of EL) if (e.onset >= t0 && e.onset <= t1) mk(x(e.onset), e.kind === "intrusion" ? "▿" : "▼", e.kind === "intrusion" ? [2, 3] : [], 1);
        // the GNSS line's own notes stay: × a spike, ? a step at one station only (neither is an eruption); with the
        // comparison on, a step that is also a false alarm is drawn once, as ◌
        const X = ctx.mismatch && ctx.mismatch(), fa = new Set(X ? X.unconfirmed.map((u) => u.date) : []);
        for (const e of S.M.deflation_events || []) { const sp = SPIKE.has(e.kind); if ((!sp && e.kind !== "unknown") || fa.has(e.date_start)) continue; const te = Date.parse(e.date_start + "T00:00:00Z") / 1000; if (te >= t0 && te <= t1) mk(x(te + DAY / 2), sp ? "×" : "?", null, 1); }
        if (X) {
          for (const u of X.unconfirmed) if (u.t >= t0 - DAY && u.t <= t1) mk(x(u.t + DAY / 2), "◌", [1, 3], 0.6);
          g.strokeStyle = ctx.tok("--ds-dim"); g.lineWidth = 1; g.globalAlpha = alpha * 0.8;
          for (const e of X.undetected) if (e.onset >= t0 && e.onset <= t1) { g.beginPath(); g.arc(x(e.onset), lane.y + 16, 3, 0, 7); g.stroke(); }
          g.globalAlpha = alpha;
        }
      } else {
        for (const e of S.M.deflation_events || []) {
          const te = Date.parse(e.date_start + "T00:00:00Z") / 1000;
          if (te < t0 || te > t1) continue;
          const spike = SPIKE.has(e.kind);
          mk(x(te + DAY / 2), e.kind === "magmatic" ? "▼" : e.kind === "hidden_by_interpolation" ? "◇" : spike ? "×" : "?", spike ? null : e.kind === "magmatic" ? [] : [2, 3], 1);
        }
      }
      // threshold lines at each magmatic eruption's start level, in SKSH's colour, dashed
      g.strokeStyle = C.gnss.SKSH; g.lineWidth = 1; g.setLineDash([5, 4]); g.globalAlpha = alpha * 0.85;
      for (const r of th) { g.beginPath(); g.moveTo(Math.max(0, x(r.t0)), y(r.U)); g.lineTo(Math.min(W, x(r.t1)), y(r.U)); g.stroke(); }
      g.setLineDash([]); g.globalAlpha = alpha;
      // the stations: a segment touching an interpolated day is dashed; a spike day is left out and bridged dotted
      // (the line follows the neighbours' course) and its delivered value is a small marked point; a null breaks it
      for (const s of stations.slice().reverse()) {
        const a = T.cols[`${s}_u_mm`], ip = T.cols[`${s}_interp`] || [], sp = T.cols[`${s}_spike`] || [];
        if (!a) continue;
        const primary = s === stations[0];
        const ok = (i) => isNum(a[i]) && !sp[i];
        g.strokeStyle = C.gnss[s] || ctx.tok("--ds-txt"); g.lineWidth = primary ? 2.2 : 1.1; g.globalAlpha = alpha * (primary ? 1 : 0.75);
        for (const style of ["solid", "dashed", "dotted"]) {
          g.setLineDash(style === "dashed" ? [3, 3] : style === "dotted" ? [1, 3] : []); g.beginPath();
          let pen = false;
          for (let i = i0; i < i1 - 1; i++) {
            if (!ok(i)) { pen = false; continue; }
            let j = i + 1; while (j < i1 && j - i <= 3 && sp[j] && isNum(a[j])) j++;
            if (j >= i1 || !ok(j)) { pen = false; continue; }
            const kind = j - i > 1 ? "dotted" : ip[i] || ip[j] ? "dashed" : "solid";
            if (kind !== style) { pen = false; i = j - 1; continue; }
            if (!pen) { g.moveTo(x(T.t[i] + DAY / 2), y(a[i])); pen = true; }
            g.lineTo(x(T.t[j] + DAY / 2), y(a[j]));
            i = j - 1;
          }
          g.stroke();
        }
        g.setLineDash([]);
        g.lineWidth = 1;
        for (let i = i0; i < i1; i++) {
          if (!sp[i] || !isNum(a[i])) continue;
          const px = x(T.t[i] + DAY / 2), py = Math.max(lane.y + 14, Math.min(lane.y + lane.h, y(a[i])));
          g.beginPath(); g.arc(px, py, 2.6, 0, 7); g.stroke();
        }
        if (S.levelIdx === 3 && (t1 - t0) < 40 * DAY) {      // daily points at the cycle level
          g.fillStyle = C.gnss[s];
          for (let i = i0; i < i1; i++) if (ok(i) && !ip[i]) { g.beginPath(); g.arc(x(T.t[i] + DAY / 2), y(a[i]), primary ? 2.2 : 1.5, 0, 7); g.fill(); }
        }
      }
      g.restore();
      // y axis ticks (mm)
      axisLeft(lane, y, alpha, "mm");
    }
    function axisLeft(lane, y, alpha, unit) {
      if (lane.level !== S.levelIdx) return;          // a crossfade's fading level draws no scale of its own (one set of numbers)
      g.save(); g.globalAlpha = alpha * 0.9; g.fillStyle = ctx.tok("--ds-label"); g.font = `10px ${ctx.tok("--ds-font-canvas")}`;
      g.strokeStyle = ctx.tok("--ds-axis"); g.lineWidth = 1;
      for (const v of y.ticks(3)) { const py = y(v); if (py < lane.y + 16 || py > lane.y + lane.h - 6) continue; g.beginPath(); g.moveTo(0, py); g.lineTo(5, py); g.stroke(); g.fillText(`${d3.format("~s")(v)}${unit ? " " + unit : ""}`, 26, py + 3); }
      g.restore();
    }

    // ----- the eruption cycle's period (v0.9, T-C), log days, as a step line: the inverse chirp made visible
    function drawCycle(lane, alpha) {
      const G = SvkCook.gnssDerived(S.M, D.gnss);
      if (!G || !G.cols.cycle_period_d) return;
      const P = G.cols.cycle_period_d, [t0, t1] = S.view;
      let hi = 30; for (const v of P) if (isNum(v)) hi = Math.max(hi, v);
      const y = d3.scaleLog().domain([20, hi * 1.15]).range([lane.y + lane.h, lane.y + 13]).clamp(true);
      lane.y_ = y;
      const i0 = Math.max(0, Math.floor((t0 - G.t[0]) / DAY) - 1), i1 = Math.min(G.t.length, Math.ceil((t1 - G.t[0]) / DAY) + 1);
      g.save(); g.globalAlpha = alpha; g.strokeStyle = ctx.col().gnss.SKSH; g.lineWidth = 1.5;
      g.beginPath(); let pen = false;
      for (let i = i0; i < i1; i++) {
        const v = P[i]; if (!isNum(v)) { pen = false; continue; }
        const xa = x(G.t[i]), py = y(v);
        if (!pen) { g.moveTo(xa, py); pen = true; } else g.lineTo(xa, py);
        g.lineTo(x(G.t[i] + DAY), py);
      }
      g.stroke(); g.restore();
      // log ticks at 30 / 100 / 300 days (axisLeft reads y(v) and y.ticks())
      axisLeft(lane, Object.assign((v) => y(v), { ticks: () => [30, 100, 300].filter((v) => v <= hi * 1.15) }), alpha, "d");
    }
    // ----- the Array (v0.10): each station's velocity, north / east / up, signed on its own p01/p99 (what /svk_array sends)
    function drawArray(lane, alpha) {
      const G = SvkCook.gnssDerived(S.M, D.gnss);
      if (!G) return;
      const st = ctx.gnssStations(), C = ctx.col(), [t0, t1] = S.view, bh = (lane.h - 12) / st.length;
      const i0 = Math.max(0, Math.floor((t0 - G.t[0]) / DAY) - 1), i1 = Math.min(G.t.length, Math.ceil((t1 - G.t[0]) / DAY) + 1);
      g.save(); g.globalAlpha = alpha;
      st.forEach((s, k) => {
        const mid = lane.y + 12 + k * bh + bh / 2, half = bh / 2 - 1.5, ip = G.cols[`${s}_interp`] || [];
        g.strokeStyle = ctx.tok("--ds-axis"); g.lineWidth = 1; g.setLineDash([]); g.beginPath(); g.moveTo(0, mid); g.lineTo(W, mid); g.stroke();
        g.fillStyle = ctx.tok("--ds-dim"); g.font = `9px ${ctx.tok("--ds-font-canvas")}`; g.fillText(s, W - 34, mid - 2);
        for (const [c, dash, a] of [["e", [1, 2], 0.55], ["n", [4, 2], 0.7], ["u", [], 1]]) {
          const key = `${s}_${c}_vel`, v = G.cols[key];
          if (!v) continue;
          const r = SvkCook.velRange(S.M, G, key);
          g.strokeStyle = C.gnss[s] || ctx.tok("--ds-txt"); g.lineWidth = c === "u" ? 1.2 : 0.9; g.setLineDash(dash);
          g.globalAlpha = alpha * a; g.beginPath(); let pen = false;
          for (let i = i0; i < i1; i++) {
            const q = v[i], sv = isNum(q) && r ? (q >= 0 ? Math.min(1, q / r.p99) : Math.max(-1, q / -r.p01)) : null;
            if (sv == null || !isFinite(sv)) { pen = false; continue; }
            const px = x(G.t[i] + DAY / 2), py = mid - sv * half;
            if (!pen) { g.moveTo(px, py); pen = true; } else g.lineTo(px, py);
          }
          g.stroke();
        }
        // interpolated days: the velocity there is the file's straight line, so the band is shaded (CONTRACT v0.10)
        g.setLineDash([]); g.globalAlpha = alpha * 0.35; g.fillStyle = ctx.tok("--ds-raised");
        for (let i = i0; i < i1; i++) if (ip[i]) g.fillRect(x(G.t[i]), mid - half, Math.max(1, x(G.t[i] + DAY) - x(G.t[i])), 2 * half);
        g.globalAlpha = alpha;
      });
      g.restore();
    }
    // ----- quake density strip (f1d eq_n)
    function drawDensity(lane, alpha) {
      const T = D.eqDay;
      if (!T || !T.cols.eq_n) return;
      const [t0, t1] = S.view, n = T.cols.eq_n, ramp = ctx.col().densityRamp;
      const r = S.M.ranges && S.M.ranges.eq_n, top = Math.log10(1 + ((r && r.max) || 1000));
      g.save(); g.globalAlpha = alpha;
      const i0 = Math.max(0, Math.floor((t0 - T.t[0]) / DAY)), i1 = Math.min(T.t.length, Math.ceil((t1 - T.t[0]) / DAY));
      for (let i = i0; i < i1; i++) {
        if (!isNum(n[i])) continue;
        const xa = x(T.t[i]), xb = Math.max(xa + 1, x(T.t[i] + DAY));
        g.fillStyle = n[i] === 0 ? ctx.tok("--ds-raised") : ramp(Math.log10(1 + n[i]) / top);
        g.fillRect(xa, lane.y + 12, xb - xa + 0.4, lane.h - 12);
      }
      g.restore();
    }
    // ----- waveform coverage bar (where the Body and Ground layers can sound)
    function drawCoverage(lane, alpha) {
      const sta = ctx.seismic();
      if (!sta) return;
      const y0 = lane.y + 12, h = Math.max(6, lane.h - 14);
      hatch(0, W, y0, h, null, alpha * 0.55);
      g.save(); g.globalAlpha = alpha; g.fillStyle = ctx.col().bands.tremor;
      for (const [a, b] of sta.coverage || []) { if (b < S.view[0] || a > S.view[1]) continue; const xa = x(a), xb = Math.max(xa + 3, x(b)); g.fillRect(xa, y0, xb - xa, h); }
      g.restore();
    }
    // ----- quakes: time × depth, size = magnitude
    function depthScale(lane) {
      const r = S.M.ranges && S.M.ranges.depth_km, dmax = Math.ceil(((r && r.p99) || 9) + 1);
      return d3.scaleLinear().domain([0, dmax]).range([lane.y + 14, lane.y + lane.h - 10]).clamp(true);
    }
    function drawEvents(lane, alpha) {
      const [t0, t1] = S.view, E = ctx.src.events(t0, t1), C = ctx.col();
      const y = depthScale(lane); lane.y_ = y;
      const sel = ctx.selection(), many = E.n > 4000, dense = Math.min(1, Math.sqrt(1500 / Math.max(1, E.n)));
      g.save();
      // the "depth not measured" strip at the bottom
      g.globalAlpha = alpha * 0.4; g.fillStyle = ctx.tok("--ds-raised"); g.fillRect(0, lane.y + lane.h - 8, W, 8); g.globalAlpha = alpha;
      for (let k = E.i0; k < E.i1; k++) {
        const m = E.mag[k], d = E.depth_km[k], px = x(E.t[k]), py = Number.isFinite(d) ? y(d) : lane.y + lane.h - 4;
        const on = !sel || sel(k);
        const r = Math.max(0.8, 1.1 + 1.25 * (m + 0.5));
        g.globalAlpha = alpha * (on ? 0.85 * Math.max(0.12, dense) : 0.06);
        g.fillStyle = C.event;
        g.beginPath(); g.arc(px, py, many ? Math.min(r, 3) : r, 0, 7); g.fill();
        if (m >= 2 && S.levelIdx >= 2 && on) { g.strokeStyle = C.event; g.lineWidth = 1; g.globalAlpha = alpha * Math.max(0.3, dense); g.beginPath(); g.arc(px, py, r + 2.5, 0, 7); g.stroke(); }
      }
      // the events the scheduler has just sent flash once
      g.strokeStyle = ctx.tok("--ds-cur"); g.lineWidth = 1.2;
      for (const k of ctx.recentEvents()) { if (k < E.i0 || k >= E.i1) continue; const d = E.depth_km[k]; g.globalAlpha = alpha * 0.9; g.beginPath(); g.arc(x(E.t[k]), Number.isFinite(d) ? y(d) : lane.y + lane.h - 4, 5, 0, 7); g.stroke(); }
      g.restore();
      axisLeft(lane, y, alpha, "km");
    }
    // ----- band-energy ribbons (MELH f1m / f10s), log y, absolute scale (whole-record range)
    function bandScale(lane) {
      let lo = Infinity, hi = -Infinity;
      for (const b of SvkCook.BANDS) { const r = S.M.ranges && S.M.ranges[`rsam_${b}`]; if (r) { lo = Math.min(lo, r.p01); hi = Math.max(hi, r.max); } }
      if (!(hi > lo)) { lo = 1; hi = 1e6; }
      return d3.scaleLog().domain([Math.max(lo * 0.7, 1e-3), hi * 1.3]).range([lane.y + lane.h, lane.y + 14]).clamp(true);
    }
    function drawRibbons(lane, alpha) {
      const sta = ctx.seismic(); if (!sta) return;
      const none = hatchUncovered(sta.id, lane, alpha, ctx.noWaveText());
      const R = D.melh[S.levelIdx <= 1 ? "f10s" : "f1m"] || D.melh.f1m, B = D.melh.base;
      if (none || ((!R || !R.t.length) && !B)) return;
      const y = bandScale(lane); lane.y_ = y;
      g.save();
      if (R && R.t.length) bandRows(R, lane, y, alpha, null);
      // the window rule (W1 §15.1): where the finer rows are absent by design, the base tier's (f10m), the same bands, coarser
      if (B) {
        const has = (t0, t1) => { if (!R || !R.t.length) return false; const i = d3.bisectLeft(R.t, t0); return i < R.t.length && R.t[i] < t1; };
        // a base row stands unless the finer rows cover it end to end (no blank at a window's edge; a short overlap is fine)
        const ds = (R && R.step) || 60;
        bandRows(B, lane, y, alpha, (i) => !(has(B.t[i], B.t[i] + ds) && has(B.t[i] + B.step - ds, B.t[i] + B.step)));
      }
      g.restore();
      axisLeft(lane, y, alpha, "");
    }
    // one table's four band ribbons (a faint fill under each line); keep(i) = false leaves a row out (a break in the line)
    function bandRows(R, lane, y, alpha, keep) {
      const C = ctx.col(), step = R.step;
      for (const b of SvkCook.BANDS) {
        const a = R.cols[`rsam_${b}`]; if (!a) continue;
        const ok = (i) => isNum(a[i]) && a[i] > 0 && (!keep || keep(i));
        g.globalAlpha = alpha * 0.07; g.fillStyle = C.bands[b];
        let open = false; g.beginPath();
        const close = (xe) => { g.lineTo(xe, lane.y + lane.h); g.closePath(); g.fill(); g.beginPath(); open = false; };
        let lastX = 0;
        for (let i = 0; i < R.t.length; i++) {
          const px = x(R.t[i] + step / 2);
          if (!ok(i)) { if (open) close(lastX); continue; }
          if (!open) { g.moveTo(px, lane.y + lane.h); open = true; }
          g.lineTo(px, y(a[i])); lastX = px;
        }
        if (open) close(lastX);
        g.globalAlpha = alpha * 0.95; g.strokeStyle = C.bands[b]; g.lineWidth = 1.2; g.beginPath(); open = false;
        for (let i = 0; i < R.t.length; i++) { const px = x(R.t[i] + step / 2); if (!ok(i)) { open = false; continue; } if (!open) { g.moveTo(px, y(a[i])); open = true; } else g.lineTo(px, y(a[i])); }
        g.stroke();
      }
    }
    // ----- tilt (mass position): f1m at day, f10s at hours, raw 1 Hz at minutes; each trace demeaned, scaled to the window
    function drawTilt(lane, alpha) {
      const sta = ctx.seismic(); if (!sta) return;
      if (hatchUncovered(sta.id, lane, alpha, ctx.noWaveText())) return;
      const C = ctx.col(), series = [];
      if (S.levelIdx === 0 && D.wave.LMN && D.wave.LME && D.wave.LMN.length && D.wave.LME.length) {
        for (const [k, key] of [["n", "LMN"], ["e", "LME"]]) {
          const pts = [];
          for (const c of D.wave[key]) for (let i = 0; i < c.x.length; i++) { const t = c.t0 + i / c.fs; if (t >= S.view[0] - 2 && t <= S.view[1] + 2) pts.push([t, c.x[i]]); }
          series.push([k, pts]);
        }
      } else {
        const R = D.melh[S.levelIdx <= 1 ? "f10s" : "f1m"], B = S.levelIdx === 2 ? D.melh.base : null;
        if ((!R || !R.t.length) && !B) return;
        // the window rule: the base tier's tilt where the minute rows are absent by design, one line through both
        const has = (t0, t1) => { if (!R || !R.t.length) return false; const i = d3.bisectLeft(R.t, t0); return i < R.t.length && R.t[i] < t1; };
        for (const k of ["n", "e"]) {
          const a = R && R.cols[`tilt_${k}`], b = B && B.cols[`tilt_${k}`]; if (!a && !b) continue;
          const pts = a ? Array.from(R.t, (t, i) => [t + R.step / 2, a[i]]) : [];
          if (b) for (let i = 0; i < B.t.length; i++) if (!has(B.t[i], B.t[i] + B.step)) pts.push([B.t[i] + B.step / 2, b[i]]);
          series.push([k, pts.sort((p, q) => p[0] - q[0])]);
        }
      }
      g.save();
      series.forEach(([k, pts], j) => {
        const vals = pts.map((p) => p[1]).filter(isNum); if (!vals.length) return;
        const mean = d3.mean(vals), ext = d3.max(vals, (v) => Math.abs(v - mean)) || 1;
        const half = (lane.h - 14) / 2, mid = lane.y + 14 + half;
        g.strokeStyle = C.tilt[k]; g.lineWidth = 1.2; g.globalAlpha = alpha * 0.9; g.setLineDash(j ? [4, 2] : []);
        g.beginPath(); let open = false;
        for (const [t, v] of pts) { if (!isNum(v)) { open = false; continue; } const px = x(t), py = mid - ((v - mean) / ext) * half * 0.9; if (!open) { g.moveTo(px, py); open = true; } else g.lineTo(px, py); }
        g.stroke();
      });
      g.restore();
    }
    // ----- spectrogram (HHZ hourly tiles), log frequency
    const specCache = new Map();
    function specImage(tile, ramp) {
      const key = tile.meta.t0 + "|" + ramp.stops.join();
      if (specCache.has(key)) return specCache.get(key);
      const { n_frames: nf, n_bins: nb } = tile.meta, oc = document.createElement("canvas");
      oc.width = nf; oc.height = nb;
      const oc2 = oc.getContext("2d"), img = oc2.createImageData(nf, nb), lut = [];
      for (let v = 0; v < 256; v++) { const c = d3.rgb(ramp(v / 255)); lut.push([c.r, c.g, c.b]); }
      for (let f = 0; f < nf; f++) for (let b = 0; b < nb; b++) {
        const v = tile.bytes[f * nb + b], o = ((nb - 1 - b) * nf + f) * 4, c = lut[v];
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
      }
      oc2.putImageData(img, 0, 0);
      if (specCache.size > 40) specCache.delete(specCache.keys().next().value);
      specCache.set(key, oc);
      return oc;
    }
    function drawSpec(lane, alpha) {
      const sta = ctx.seismic(); if (!sta) return;
      if (hatchUncovered(sta.id, lane, alpha, ctx.noWaveText())) return;
      const ramp = ctx.col().specRamp;
      g.save(); g.globalAlpha = alpha; g.imageSmoothingEnabled = (S.view[1] - S.view[0]) > 1800;
      let meta = null;
      for (const tile of D.spec || []) {
        const m = tile.meta; meta = m;
        const xa = x(m.t0 - m.dt / 2), xb = x(m.t0 + (m.n_frames - 0.5) * m.dt);
        if (xb < 0 || xa > W) continue;
        g.drawImage(specImage(tile, ramp), xa, lane.y + 12, xb - xa, lane.h - 12);
      }
      g.restore();
      if (meta) {
        const y = d3.scaleLog().domain([meta.f_lo, meta.f_hi]).range([lane.y + lane.h, lane.y + 12]);
        lane.y_ = y; lane.meta = meta;
        g.save(); g.globalAlpha = alpha; g.fillStyle = ctx.tok("--ds-label"); g.font = `10px ${ctx.tok("--ds-font-canvas")}`;
        for (const f of [1, 5, 15, 45]) { const py = y(f); g.fillText(`${f} Hz`, 26, py + 3); }
        g.restore();
      }
    }
    // ----- waveform: per-pixel min/max from the 1-s pyramid, or the samples themselves when zoomed in
    function traceOf(chunks, t0, t1) {
      const n = Math.ceil(W), mn = new Float32Array(n).fill(NaN), mx = new Float32Array(n).fill(NaN);
      const spp = ((t1 - t0) / W) * (chunks[0] ? chunks[0].fs : 100);
      let peak = 0;
      const pts = [];
      for (const c of chunks) {
        if (spp > c.block * 2) {
          for (let k = 0; k < c.mn.length; k++) {
            const tk = c.t0 + (k * c.block) / c.fs; if (tk < t0 - 1 || tk > t1) continue;
            const px = Math.floor(x(tk)); if (px < 0 || px >= n) continue;
            const a = c.mn[k], b = c.mx[k]; if (!isNum(a)) continue;
            mn[px] = isNum(mn[px]) ? Math.min(mn[px], a) : a; mx[px] = isNum(mx[px]) ? Math.max(mx[px], b) : b;
          }
        } else {
          const i0 = Math.max(0, Math.floor((t0 - c.t0) * c.fs)), i1 = Math.min(c.x.length, Math.ceil((t1 - c.t0) * c.fs) + 1);
          for (let i = i0; i < i1; i++) {
            const v = c.x[i]; const px = x(c.t0 + i / c.fs);
            if (spp < 1.5) { pts.push([px, v]); continue; }
            const p = Math.floor(px); if (p < 0 || p >= n || !isNum(v)) continue;
            mn[p] = isNum(mn[p]) ? Math.min(mn[p], v) : v; mx[p] = isNum(mx[p]) ? Math.max(mx[p], v) : v;
          }
        }
      }
      for (let i = 0; i < n; i++) if (isNum(mx[i])) peak = Math.max(peak, Math.abs(mn[i]), Math.abs(mx[i]));
      for (const [, v] of pts) if (isNum(v)) peak = Math.max(peak, Math.abs(v));
      return { mn, mx, pts, peak: peak || 1 };
    }
    function drawTrace(chunks, y0, h, colour, alpha, label) {
      const tr = traceOf(chunks, S.view[0], S.view[1]), mid = y0 + h / 2, s = (h / 2 - 2) / tr.peak;
      g.save(); g.globalAlpha = alpha; g.strokeStyle = colour; g.fillStyle = colour; g.lineWidth = 1;
      if (tr.pts.length) {
        g.beginPath(); let open = false;
        for (const [px, v] of tr.pts) { if (!isNum(v)) { open = false; continue; } if (!open) { g.moveTo(px, mid - v * s); open = true; } else g.lineTo(px, mid - v * s); }
        g.stroke();
      } else {
        g.beginPath();
        for (let i = 0; i < tr.mn.length; i++) { if (!isNum(tr.mn[i])) continue; g.moveTo(i + 0.5, mid - tr.mx[i] * s); g.lineTo(i + 0.5, mid - tr.mn[i] * s + 0.5); }
        g.stroke();
      }
      g.fillStyle = ctx.tok("--ds-dim"); g.font = `10px ${ctx.tok("--ds-font-canvas")}`;
      // the component and its scale only (calm page); "raw counts, scaled to the window" is the lane's hover
      const lt = `${(label.match(/\b(HH|LM)[ZNE]\b/) || [label])[0]} · ±${d3.format(".2s")(tr.peak)}`;
      g.fillText(lt, W - g.measureText(lt).width - 8, y0 + 11);
      g.restore();
      return tr;
    }
    function drawWave1(lane, alpha) {
      const sta = ctx.seismic(); if (!sta) return;
      if (hatchUncovered(sta.id, lane, alpha, ctx.noWaveText())) return;
      if (D.wave.HHZ) lane.tr = drawTrace(D.wave.HHZ, lane.y + 12, lane.h - 12, ctx.col().wave.Z, alpha, ctx.chanLabel("HHZ"));
    }
    function drawWave3(lane, alpha) {
      const sta = ctx.seismic(); if (!sta) return;
      if (hatchUncovered(sta.id, lane, alpha, ctx.noWaveText())) return;
      const h = (lane.h - 12) / 3, C = ctx.col().wave;
      [["HHZ", "Z"], ["HHN", "N"], ["HHE", "E"]].forEach(([ch, k], j) => { if (D.wave[ch]) drawTrace(D.wave[ch], lane.y + 12 + j * h, h, C[k], alpha, ctx.chanLabel(ch)); });
    }
    // ----- catalogue ticks (IMO, inference) over the station's own detections (STA/LTA, measurement)
    function drawTicks(lane, alpha) {
      const [t0, t1] = S.view, E = ctx.src.events(t0, t1), C = ctx.col(), sel = ctx.selection();
      const mid = lane.y + 12 + (lane.h - 12) * 0.55;
      g.save(); g.globalAlpha = alpha;
      g.strokeStyle = ctx.tok("--ds-line"); g.beginPath(); g.moveTo(0, mid); g.lineTo(W, mid); g.stroke();
      for (let k = E.i0; k < E.i1; k++) {
        const on = !sel || sel(k);
        g.globalAlpha = alpha * (on ? 0.95 : 0.15); g.strokeStyle = C.event; g.lineWidth = E.mag[k] >= 2 ? 2 : 1;
        const hgt = Math.max(3, (mid - lane.y - 14) * Math.min(1, (E.mag[k] + 1) / 4));
        g.beginPath(); g.moveTo(x(E.t[k]), mid); g.lineTo(x(E.t[k]), mid - hgt); g.stroke();
      }
      const R = D.melh.f10s;
      if (R && R.cols.n_trig) {
        g.fillStyle = C.bands.vt; g.globalAlpha = alpha * 0.8;
        for (let i = 0; i < R.t.length; i++) { const v = R.cols.n_trig[i]; if (!(v > 0)) continue; const xa = x(R.t[i]), xb = Math.max(xa + 1, x(R.t[i] + R.step)); g.fillRect(xa, mid + 1, xb - xa, Math.min(lane.y + lane.h - mid - 1, 4 * v)); }
      }
      g.restore();
    }

    // the collapsed MELH lanes: one thin strip, an absence (the hover names the one recorded day)
    function drawNoMelh(lane, alpha) { hatch(0, W, lane.y + 12, Math.max(4, lane.h - 12), null, alpha); }
    const DRAW = { nomelh: drawNoMelh, gnss: drawGnss, cycle: drawCycle, array: drawArray, density: drawDensity, coverage: drawCoverage, events: drawEvents, ribbons: drawRibbons,
                   tilt: drawTilt, spec: drawSpec, wave1: drawWave1, wave3: drawWave3, ticks: drawTicks };
    let lastLanes = [];

    function laneLabel(lane, alpha) {
      const t = ctx.laneText(lane.key);
      if (!t) return;
      g.save(); g.globalAlpha = alpha; g.font = `11px ${ctx.tok("--ds-font-canvas")}`;
      const w = g.measureText(t.text).width;
      const L0 = 26;                                 // clear of the left edge tabs (legend, sources)
      g.fillStyle = ctx.tok("--ds-pop"); g.fillRect(L0 - 4, lane.y, w + 10, 13);
      g.fillStyle = ctx.tok("--ds-label"); g.fillText(t.text, L0, lane.y + 10);
      let kx = L0 + 6 + w;
      for (const [name, colour, dashed] of t.keys || []) {
        const kw = g.measureText(name).width;
        g.fillStyle = ctx.tok("--ds-pop"); g.fillRect(kx - 2, lane.y, kw + 22, 13);
        g.strokeStyle = colour; g.lineWidth = 2; g.setLineDash(dashed ? [3, 2] : []); g.beginPath(); g.moveTo(kx, lane.y + 6); g.lineTo(kx + 10, lane.y + 6); g.stroke(); g.setLineDash([]);
        g.fillStyle = ctx.tok("--ds-label"); g.fillText(name, kx + 13, lane.y + 10); kx += kw + 22;
      }
      g.restore();
    }

    // the room the body sounds, lit as a band (Miguel 2026-10-22, point 2: "highlight the space being navigated"): gold is you
    function drawRoom() {
      const r = ctx.roomSpan && ctx.roomSpan(); if (!r) return;
      const xa = Math.max(0, x(r.t0)), xb = Math.min(W, x(r.t1)); if (xb <= xa) return;
      const yb = HM - AXIS_H - STRIP_H;
      g.save(); g.globalAlpha = 0.055; g.fillStyle = ctx.tok("--ds-cur"); g.fillRect(xa, PAD_T, xb - xa, yb - PAD_T);
      g.globalAlpha = 0.45; g.strokeStyle = ctx.tok("--ds-cur"); g.lineWidth = 1;
      for (const xe of [x(r.t0), x(r.t1)]) if (xe > 1 && xe < W - 1) { g.beginPath(); g.moveTo(xe, PAD_T); g.lineTo(xe, yb); g.stroke(); }
      g.globalAlpha = 0.8; g.fillStyle = ctx.tok("--ds-cur"); g.fillRect(xa, yb - 2, xb - xa, 2);
      g.font = `10px ${ctx.tok("--ds-font-canvas")}`; const tw = g.measureText(r.label).width;
      if (xb - xa > tw + 12) { g.globalAlpha = 0.9; g.fillStyle = ctx.tok("--ds-cur-txt"); g.fillText(r.label, Math.max(xa, 0) + 22, yb - 6); }
      g.restore();
    }
    // the time strip over the axis (Miguel 2026-10-22, point 8; re_wilding's month strip): months in their own colours, the
    // years divided through the plot, so time reads in chunks at a glance; a finer span alternates days, hours or minutes
    const monthColor = (m0) => d3.interpolateSinebow(m0 / 12);
    function drawStrip() {
      const [t0, t1] = S.view, span = t1 - t0, y0 = HM - AXIS_H - STRIP_H;
      g.save(); g.font = `8px ${ctx.tok("--ds-font-canvas")}`;
      if (span > 60 * DAY) {
        for (let d = d3.utcMonth.floor(utc(t0)); +d / 1000 < t1; d = d3.utcMonth.offset(d, 1)) {
          const n = d3.utcMonth.offset(d, 1), xa = Math.max(0, x(+d / 1000)), xb = Math.min(W, x(+n / 1000));
          g.globalAlpha = 0.5; g.fillStyle = monthColor(d.getUTCMonth()); g.fillRect(xa, y0 + 1, Math.max(0, xb - xa - 1), STRIP_H - 2);
        }
      } else {
        const step = span > 2 * DAY ? DAY : span > 2 * 3600 ? 3600 : span > 120 ? 60 : 10;
        for (let tt = Math.floor(t0 / step) * step; tt < t1; tt += step) {
          const xa = Math.max(0, x(tt)), xb = Math.min(W, x(tt + step));
          g.globalAlpha = 1; g.fillStyle = ctx.tok(Math.floor(tt / step) % 2 ? "--ds-raised" : "--ds-line"); g.fillRect(xa, y0 + 1, Math.max(0, xb - xa), STRIP_H - 2);
        }
      }
      // the years (and at the day level and finer, the days) divided through the whole plot, faintly
      const div = span > 60 * DAY ? d3.utcYear : span > 2 * DAY ? d3.utcMonth : span > 2 * 3600 ? d3.utcDay : null;
      if (div) {
        g.globalAlpha = 0.5; g.strokeStyle = ctx.tok("--ds-axis"); g.lineWidth = 1;
        for (let d = div.ceil(utc(t0)); +d / 1000 < t1; d = div.offset(d, 1)) { const px = Math.round(x(+d / 1000)) + 0.5; g.beginPath(); g.moveTo(px, PAD_T); g.lineTo(px, y0 + STRIP_H); g.stroke(); }
      }
      g.restore();
    }
    // a trace: a ring at the top and a faint band of its minute, hour or day, in its own colour (re_wilding 3.10)
    function drawTraces() {
      const T = (ctx.traces && ctx.traces()) || []; if (!T.length) return;
      const yb = HM - AXIS_H - STRIP_H;
      g.save();
      for (const r of T) {
        const xa = x(r.t0), xb = x(r.t1); if (xb < -8 || xa > W + 8) continue;
        const xm = (xa + xb) / 2;
        if (xb - xa >= 2) { g.globalAlpha = 0.13; g.fillStyle = r.color; g.fillRect(xa, PAD_T, xb - xa, yb - PAD_T); }
        g.globalAlpha = 0.55; g.strokeStyle = r.color; g.lineWidth = 1; g.setLineDash([1, 3]); g.beginPath(); g.moveTo(xm, PAD_T + 13); g.lineTo(xm, yb); g.stroke(); g.setLineDash([]);
        g.globalAlpha = 1; g.lineWidth = 2; g.beginPath(); g.arc(xm, PAD_T + 7, 5, 0, 7); g.stroke();
      }
      g.restore();
    }

    // ------------------------------------------------------------------------- the time-series stripe (Miguel 2026-10-22)
    // Under the axis: the time AROUND the view, about 30× its span (the hour around a minutes view, the day and a bit around an
    // hours view, the month around a day view, the whole record from the cycle up), so it adapts to the resolution on screen.
    // Rows: where the seismometer recorded (the day / hours / minutes graphs' data), the GNSS days (the cycle / sequence graphs'
    // data), the quakes binned to its own pixels; ticks at the eruptions; the view you are in, gold (you). The row this level's
    // graphs read is bright, the other dim. Click or drag: go there at the zoom you are at (near the seismometer's data it snaps
    // onto it). When this level's data lies outside the stripe, an edge hint names it and goes there. At its left, a calendar
    const ovhit = svg.select(".tl-ovhit"), dateEl = host.querySelector(".tl-date");
    const xo = d3.scaleLinear();
    let ovHint = null;                              // {x0, x1} of the edge hint, for clicks
    let ovFrozen = null;                            // the stripe's range held still while you drag on it
    function ovRange() {
      if (ovFrozen) return ovFrozen;
      const T0 = S.M.t0, T1 = Math.max(T0 + 10, ctx.now()), [v0, v1] = S.view, span = v1 - v0;
      const cs = Math.min(T1 - T0, Math.max(span, span * 30)), c = (v0 + v1) / 2;
      let a = c - cs / 2, b = c + cs / 2;
      if (a < T0) { b += T0 - a; a = T0; } if (b > T1) { a -= b - T1; b = T1; }
      return [Math.max(T0, a), b];
    }
    function drawOverview() {
      const [a, b] = ovRange(), C = ctx.col(), y0 = HM + 4, seisY = y0 + 2, gY = y0 + 10, qY = y0 + 18, rowH = 6, x1 = W - 4;
      xo.domain([a, b]).range([OV_X, x1]);
      const melhLevel = S.levelIdx <= 2, s = ctx.seismic(), cov = (s && s.coverage) || [];
      g.save();
      g.fillStyle = ctx.tok("--ds-panel"); g.fillRect(0, HM, W, OV_H);
      g.strokeStyle = ctx.tok("--ds-line"); g.beginPath(); g.moveTo(0, HM + 0.5); g.lineTo(W, HM + 0.5); g.stroke();
      // months (or days) as faint blocks, so the stripe reads in time chunks too
      const span = b - a;
      if (span > 60 * DAY) for (let d = d3.utcMonth.floor(utc(a)); +d / 1000 < b; d = d3.utcMonth.offset(d, 1)) {
        const xa = Math.max(OV_X, xo(+d / 1000)), xb = Math.min(x1, xo(+d3.utcMonth.offset(d, 1) / 1000));
        g.globalAlpha = 0.16; g.fillStyle = monthColor(d.getUTCMonth()); g.fillRect(xa, y0, Math.max(0, xb - xa - 1), 26);
      } else {
        const step = span > 2 * DAY ? DAY : span > 2 * 3600 ? 3600 : 60;
        for (let tt = Math.floor(a / step) * step; tt < b; tt += step) {
          const xa = Math.max(OV_X, xo(tt)), xb = Math.min(x1, xo(tt + step));
          g.globalAlpha = Math.floor(tt / step) % 2 ? 0.5 : 0.25; g.fillStyle = ctx.tok("--ds-raised"); g.fillRect(xa, y0, Math.max(0, xb - xa), 26);
        }
      }
      // the seismometer's recording: the day / hours / minutes graphs' data (at least 6 px, so one day in three years shows)
      g.globalAlpha = melhLevel ? 1 : 0.35; g.fillStyle = C.bands.tremor;
      for (const [ca, cb] of cov) { if (cb < a || ca > b) continue; const xa = Math.max(OV_X, xo(ca)), xb = Math.min(x1, Math.max(xa + 6, xo(cb))); g.fillRect(xa, seisY, xb - xa, rowH - 1); }
      // the GNSS days: measured solid, a straight line in the file faint (the cycle / sequence graphs' data)
      const G = D.gnss, st = ctx.gnssStations()[0];
      if (G && st) {
        const u = G.cols[`${st}_u_mm`], ip = G.cols[`${st}_interp`] || [];
        const i0 = Math.max(0, Math.floor((a - G.t[0]) / DAY)), i1 = Math.min(G.t.length, Math.ceil((b - G.t[0]) / DAY) + 1);
        for (let i = i0; i < i1; i++) {
          if (!isNum(u[i])) continue;
          const xa = Math.max(OV_X, xo(G.t[i])), xb = Math.min(x1, Math.max(xa + 1, xo(G.t[i] + DAY)));
          g.globalAlpha = (melhLevel ? 0.35 : 0.9) * (ip[i] ? 0.35 : 1); g.fillStyle = C.gnss[st] || ctx.tok("--ds-txt"); g.fillRect(xa, gY, xb - xa, rowH - 2);
        }
      }
      // the quakes, binned to the stripe's pixels (log intensity)
      const E = ctx.src.events(a, b), px = Math.max(1, Math.round(x1 - OV_X)), bins = new Float32Array(px);
      for (let k = E.i0; k < E.i1; k++) { const j = Math.floor(xo(E.t[k]) - OV_X); if (j >= 0 && j < px) bins[j]++; }
      let top = 1; for (const v of bins) top = Math.max(top, v);
      const ramp = C.densityRamp;
      g.globalAlpha = 1;
      for (let j = 0; j < px; j++) if (bins[j] > 0) { g.fillStyle = ramp(0.25 + 0.75 * Math.log10(1 + bins[j]) / Math.log10(1 + top)); g.fillRect(OV_X + j, qY, 1, rowH); }
      // the eruptions
      g.globalAlpha = 0.8; g.fillStyle = ctx.tok("--ds-txt");
      for (const e of ctx.eruptions ? ctx.eruptions() : []) {          // v0.13: the eruption list's onsets (else the GNSS detection's days)
        const te = e.from === "gnss" ? e.t + DAY / 2 : e.onset; if (te < a || te > b) continue; const xe = xo(te); g.fillRect(xe - 0.5, y0, 1.5, 26); }
      // the view you are in (gold = you), at least 5 px wide
      const vx0 = xo(S.view[0]), vx1 = xo(S.view[1]), vw = Math.max(5, vx1 - vx0), vxa = (vx0 + vx1) / 2 - vw / 2;
      g.globalAlpha = 0.12; g.fillStyle = ctx.tok("--ds-cur"); g.fillRect(vxa, y0 - 2, vw, 30);
      g.globalAlpha = 1; g.strokeStyle = ctx.tok("--ds-cur"); g.lineWidth = 1.5; g.strokeRect(vxa, y0 - 2, vw, 30);
      // the ends of the stripe, and (at the seismometer's levels) a hint to its data when it lies outside
      g.font = `9px ${ctx.tok("--ds-font-canvas")}`; g.fillStyle = ctx.tok("--ds-dim"); g.globalAlpha = 0.9;
      const fmtEnd = span > 2 * DAY ? d3.utcFormat("%-d %b %Y") : d3.utcFormat("%-d %b %H:%M");
      const le = fmtEnd(utc(a)), re = fmtEnd(utc(b));
      g.fillText(le, OV_X + 2, HM + OV_H - 3); g.fillText(re, x1 - g.measureText(re).width - 2, HM + OV_H - 3);
      ovHint = null;
      if (melhLevel && cov.length && !cov.some(([ca, cb]) => cb >= a && ca <= b)) {
        const left = cov[0][1] < a, txt = left ? `◂ seismometer: ${d3.utcFormat("%-d %b %Y")(utc(cov[0][0]))}` : `seismometer: ${d3.utcFormat("%-d %b %Y")(utc(cov[0][0]))} ▸`;
        g.font = `10px ${ctx.tok("--ds-font-canvas")}`; const tw = g.measureText(txt).width, hx = left ? OV_X + 2 : x1 - tw - 2, hy = seisY + 7;
        g.globalAlpha = 0.92; g.fillStyle = ctx.tok("--ds-panel"); g.fillRect(hx - 3, seisY - 2, tw + 6, 12);
        g.globalAlpha = 1; g.fillStyle = C.bands.tremor; g.fillText(txt, hx, hy);
        ovHint = { x0: hx - 3, x1: hx + tw + 3 };
      }
      g.restore();
      // the calendar keeps the date you are at (unless you are typing in it)
      if (document.activeElement !== dateEl) {
        const t = S.cursor >= S.view[0] && S.cursor <= S.view[1] ? S.cursor : (S.view[0] + S.view[1]) / 2;
        dateEl.value = d3.utcFormat("%Y-%m-%d")(utc(t));
      }
      dateEl.min = d3.utcFormat("%Y-%m-%d")(utc(S.M.t0)); dateEl.max = d3.utcFormat("%Y-%m-%d")(utc(ctx.now()));
      dateEl.style.colorScheme = DarkStyle.get() === "dark" ? "dark" : "light";
    }
    let ovDrag = false;
    function ovGo(e, snap) {
      const [px] = d3.pointer(e, svg.node());
      if (snap && ovHint && px >= ovHint.x0 && px <= ovHint.x1 && ctx.gotoRecording) { ctx.gotoRecording(); return; }
      let t = xo.invert(px); const span = S.view[1] - S.view[0], s = ctx.seismic();
      if (snap && S.levelIdx <= 2) for (const [ca, cb] of (s && s.coverage) || []) {
        const xa = xo(ca), xb = Math.max(xa + 6, xo(cb));
        if (px >= xa - 8 && px <= xb + 8) { t = Math.min(Math.max(t, ca + Math.min(span, cb - ca) / 2), cb - Math.min(span, cb - ca) / 2); break; }
      }
      ctx.setView(t - span / 2, t + span / 2, { user: true }); ctx.setCursor(t, { from: "timeline" });
    }
    function ovHover(e) {
      if (ctx.hoverOn && !ctx.hoverOn()) { hbox.style.display = "none"; return; }
      const [px, py] = d3.pointer(e, svg.node()), t = xo.invert(px), s = ctx.seismic();
      const lines = [`<b>${d3.utcFormat(xo.domain()[1] - xo.domain()[0] > 2 * DAY ? "%a %-d %b %Y" : "%a %-d %b %Y %H:%M")(utc(t))}</b>`];
      if (ovHint && px >= ovHint.x0 && px <= ovHint.x1) lines.push(`click: go to the seismometer's recording (${ctx.noWaveText().replace(/^no waveform here · /, "")})`);
      else {
        lines.push(s && ctx.src.covered(s.id, t, t + 1) ? "the seismometer recorded here: the day, hours and minutes graphs are drawn" : `<span class="dim">no seismometer recording here</span>`);
        const G = D.gnss, st = ctx.gnssStations()[0], i = G ? Math.floor((t - G.t[0]) / DAY) : -1;
        if (G && st && i >= 0 && i < G.t.length) lines.push((G.cols[`${st}_interp`] || [])[i] ? `<span class="dim">GNSS: a straight line in the file (not measured)</span>` : isNum(G.cols[`${st}_u_mm`][i]) ? "GNSS: measured" : `<span class="dim">no GNSS</span>`);
        const w = (xo.domain()[1] - xo.domain()[0]) / Math.max(1, W - OV_X), E = ctx.src.events(t - w * 2, t + w * 2);
        lines.push(`${E.i1 - E.i0} quakes here`);
        lines.push(`<span class="dim">click or drag: go there at this zoom</span>`);
      }
      hbox.innerHTML = lines.map((l) => `<div>${l}</div>`).join(""); hbox.style.display = "block";
      const bw = hbox.offsetWidth, bh = hbox.offsetHeight;
      hbox.style.left = Math.max(2, Math.min(W - bw - 4, px - bw / 2)) + "px"; hbox.style.top = Math.max(2, HM - bh - 6) + "px";
    }
    ovhit.on("pointerdown", (e) => { ovDrag = true; ovFrozen = ovRange(); try { ovhit.node().setPointerCapture(e.pointerId); } catch (_) {} ovGo(e, true); })
      .on("pointermove", (e) => { if (ovDrag) ovGo(e, false); else ovHover(e); })
      .on("pointerup pointercancel", () => { ovDrag = false; ovFrozen = null; dirty = true; })
      .on("pointerleave", () => { if (!ovDrag) hbox.style.display = "none"; });
    dateEl.addEventListener("change", () => { if (dateEl.value && ctx.gotoDate) ctx.gotoDate(dateEl.value); });

    function draw() {
      if (!dirty) return;
      dirty = false;
      x.domain(S.view).range([0, W]);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const w = S.w;
      lastLanes = [];
      drawRoom();
      for (let lvl = 4; lvl >= 0; lvl--) {
        const a = w[lvl]; if (a < 0.02) continue;
        for (const lane of lanesOf(lvl)) {
          try { DRAW[lane.key](lane, a); } catch (e) { console.warn("[timeline]", lane.key, e); }
          if (lvl === S.levelIdx) laneLabel(lane, Math.max(a, 0.6));
          lane.alpha = a; lastLanes.push(lane);
        }
      }
      drawStrip();
      drawTraces();
      drawOverview();
      // the window rule's one quiet hint (W1 §15.1): the finest detail ships only around events; the why on hover
      const dh = ctx.detailHint ? ctx.detailHint() : null, de = host.querySelector(".tl-detail");
      de.style.display = dh ? "block" : "none"; if (dh) { de.textContent = dh.text; de.title = dh.title; }
      // axis
      const ax = d3.scaleUtc().domain(S.view.map(utc)).range([0, W]);
      const axis = d3.axisBottom(ax).ticks(Math.max(2, Math.floor(W / 120))).tickSizeOuter(0);
      svg.select(".tl-axis").attr("transform", `translate(0,${HM - AXIS_H})`).call(axis);
      // the right edge: now (replay/live) or the end of the data (archive)
      const tn = ctx.now(), xe = x(tn);
      svg.select(".tl-end").attr("x1", xe).attr("x2", xe).attr("y1", 0).attr("y2", HM - AXIS_H).style("display", xe >= -1 && xe <= W + 1 ? null : "none");
      svg.select(".tl-endtxt").attr("x", Math.min(W - 4, xe - 4)).attr("y", HM - AXIS_H - 6).attr("text-anchor", "end")
        .text(S.mode === "archive" ? `end of the data · ${fmtDay(utc(tn))}` : `now · ${fmtT(utc(tn))}`).style("display", xe >= 0 && xe <= W + 1 ? null : "none");
      // gold = you: the cursor, and the playhead while playing
      const xc = x(S.cursor);
      svg.select(".tl-cur").style("display", xc >= -2 && xc <= W + 2 ? null : "none");
      svg.select(".tl-curline").attr("x1", xc).attr("x2", xc).attr("y1", 0).attr("y2", HM - AXIS_H);
      svg.select(".tl-head").attr("d", `M${xc - 6},0 L${xc + 6},0 L${xc},8 Z`).classed("playing", S.playing);
      // the engine's own playhead (/svk_playhead), when the Ground is playing: what you hear, where it is
      const ph = S.enginePlayhead, xp = ph != null ? x(ph) : NaN, showPh = Number.isFinite(xp) && xp >= 0 && xp <= W && S.playing;
      svg.select(".tl-ph").style("display", showPh ? null : "none");
      if (showPh) {
        svg.select(".tl-phline").attr("x1", xp).attr("x2", xp).attr("y1", HM - AXIS_H - 10).attr("y2", HM - AXIS_H);
        svg.select(".tl-phdot").attr("d", `M${xp},${HM - AXIS_H - 14} l4,4 l-4,4 l-4,-4 Z`);
      }
    }

    // ------------------------------------------------------------------------------------------ the hover box
    function hover(e) {
      const [px, py] = d3.pointer(e);
      const t = x.invert(px);
      if (ctx.hoverOn && !ctx.hoverOn()) { hbox.style.display = "none"; ctx.hoverT && ctx.hoverT(null); return; }
      ctx.hoverT && ctx.hoverT(t);
      const lane = lastLanes.filter((l) => py >= l.y && py <= l.y + l.h).sort((a, b) => b.alpha - a.alpha)[0];
      const lines = [`<b>${fmtT(utc(t))} UTC</b>`];
      if (lane) {
        const extra = ctx.laneHover(lane, t, py, px, x);
        if (extra) lines.push(...extra);
      }
      const rs = ctx.roomSpan && ctx.roomSpan();
      if (rs && t >= rs.t0 && t < rs.t1) lines.push(`<span class="dim">the band: ${rs.label}, the room you are in</span>`);
      if (py > HM - AXIS_H - STRIP_H - 2 && !lane) lines.push(`<span class="dim">${d3.utcFormat("%B %Y")(utc(t))}</span>`);
      for (const r of (ctx.traces && ctx.traces()) || []) if (t >= r.t0 && t < r.t1 + (S.view[1] - S.view[0]) / 300) lines.push(`<span style="color:${r.color}">◎ traced</span> · ${r.label}`);
      hbox.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");
      hbox.style.display = "block";
      const r = host.getBoundingClientRect(), bw = hbox.offsetWidth, bh = hbox.offsetHeight;
      let lx = px + 14, ly = py + 14;
      if (lx + bw > r.width - 4) lx = px - bw - 14;
      if (ly + bh > r.height - 4) ly = py - bh - 14;
      hbox.style.left = Math.max(2, lx) + "px"; hbox.style.top = Math.max(2, ly) + "px";
    }

    window.addEventListener("resize", () => { resize(); });
    new ResizeObserver(() => resize()).observe(host);
    resize();
    return {
      redraw() { dirty = true; },
      frame() { draw(); },
      syncZoom,
      x: () => x,
      width: () => W,
      lanes: () => lastLanes,
      thresholds,
      depthScale,
      fmtSpan,
    };
  }
  return { create, fmtSpan };
})();
