// dark_svartsengi · views/plot.js — panel C's plot: one plot per "listen for" choice, over the timeline's window, the cursor
// as a gold playhead (DECISIONS 2026-11-25; Leif: "show a graphical plot of each one in the space occupied by Latents").
// W3.
//   inflation · deflation: the vertical GNSS (U) at the body's stations (SKSH, SENG, ELDC, FEFC), the sawtooth.
//   swarms: quakes per bin (the bin follows the level: day, hour, 10 min, 1 min) and, above, every M ≥ 2 as a stem at its
//     magnitude. Two panes sharing time, never two y-axes.
//   drop ↔ fountain: Leif's fountain-height plot (data/raw/…/Lava fountains/fountain_heights_overview.png): the height per
//     segment, observed solid with its samples, simulated dashed; the segments on a ramp of the fissure's colour, south
//     (light) → north (deep), the order the fountain voice pitches them. Under it SKSH's U, the ground's drop (daily: the
//     GNSS has one solution a day). Outside every fountain it names the nearest, a click away.
// Every plot marks the onsets as the timeline does (▼ eruption · ▿ intrusion, neutral ink). Two canvases: the plot (drawn
// again only when what it shows changes) and the playhead + hover (every frame). The hover reads the values at the
// pointer; a click moves the cursor there. Data: viz/data only (the gnss tile, the catalogue, the fountain files).
window.SvkPlot = (function () {
  "use strict";
  const DAY = 86400, isNum = (v) => typeof v === "number" && Number.isFinite(v);
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  // the swarm's bin by level (0 minutes … 4 sequence)
  const BINS = [[60, "minute"], [600, "10 min"], [3600, "hour"], [DAY, "day"], [DAY, "day"]];
  const fmtD = d3.utcFormat("%-d %b %Y"), fmtDT = d3.utcFormat("%-d %b %Y %H:%M"), fmtHM = d3.utcFormat("%H:%M");
  const utc = (t) => new Date(t * 1000);
  const sgn = (v, d = 0) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(d)}`;

  function create(host, ctx) {
    const { S, D } = ctx;
    host.classList.add("pltv");
    host.innerHTML = `<canvas class="plt-cv"></canvas><canvas class="plt-top"></canvas><div class="plt-msg"></div><div class="hbox plt-hbox"></div>`;
    const cv = host.querySelector(".plt-cv"), tp = host.querySelector(".plt-top"), g = cv.getContext("2d"), gt = tp.getContext("2d");
    const msg = host.querySelector(".plt-msg"), hbox = host.querySelector(".plt-hbox");
    let W = 300, H = 200, dpr = 1, drawn = "", ver = 0, X0 = 0, X1 = 1, panes = [], ptr = null, hot = null, topKey = "";
    const PAD_L = 42, AX_H = 27;                             // the foot: the onsets' row, then the dates
    let padR = 12;
    const fnt = new Map();                                     // fountain file → series (null while loading)

    function resize() {
      const r = host.getBoundingClientRect();
      W = Math.max(160, r.width); H = Math.max(120, r.height); dpr = window.devicePixelRatio || 1;
      for (const c of [cv, tp]) { c.width = W * dpr; c.height = H * dpr; c.style.width = W + "px"; c.style.height = H + "px"; }
      drawn = ""; topKey = "";
    }
    const tok = (k) => ctx.tok(k), font = (px = 9) => `${px}px ${tok("--ds-font-canvas")}`;
    const x = (t) => PAD_L + ((t - S.view[0]) / Math.max(1e-9, S.view[1] - S.view[0])) * (W - PAD_L - padR);
    const tAt = (px) => S.view[0] + ((px - PAD_L) / Math.max(1, W - PAD_L - padR)) * (S.view[1] - S.view[0]);
    const mode = () => (["inflation", "swarms", "deflation"].includes(S.listenFor) ? S.listenFor : "inflation");
    const onsets = () => (ctx.eruptions ? ctx.eruptions() : []).filter((e) => e.from === "eruptions" && isNum(e.onset));

    // ----- the fountain series (each file once; a failed read is asked again on the next draw)
    function series(e) {
      if (!e.fnt || !ctx.src.fountains) return null;
      const k = e.fnt.file;
      if (!fnt.has(k)) {
        fnt.set(k, null);
        ctx.src.fountains(e.fnt).then((F) => {
          if (!F) { fnt.delete(k); return; }
          const t = F.t || []; F._t1 = Math.max(F.end_utc ? Date.parse(F.end_utc) / 1000 : -Infinity, t.length ? t[t.length - 1] : -Infinity);
          // south → north, the fountain voice's order (its pos, app.js fountainNow)
          const cols = F.cols || Object.keys(F.data || {}), lat = F.seg_lat || [];
          const ord = cols.map((c, k) => [c, isNum(lat[k]) ? lat[k] : k]).sort((a, b) => a[1] - b[1]).map(([c]) => c);
          F._rank = new Map(ord.map((c, i) => [c, ord.length > 1 ? i / (ord.length - 1) : 0.5]));
          fnt.set(k, F); ver++;
        }).catch(() => fnt.delete(k));
      }
      return fnt.get(k);
    }
    const fountains = () => onsets().filter((e) => e.fnt);
    function fountainSpan(e) { const F = series(e), a = e.onset; return [a, F && isNum(F._t1) ? F._t1 : isNum(e.t1) ? e.t1 : a + 6 * 3600]; }
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
    // the segments' ramp, in the fissure's hue: south light → north deep (in the light looks, the other way round, so both
    // ends stay clear of the page)
    function segCol(p) {
      const C = ctx.col(), base = d3.hsl(C.fissure || "#ff7b39"), dark = DarkStyle.get() === "dark";
      const a = dark ? base.brighter(0.8) : base.brighter(0.35), b = dark ? base.darker(0.45) : base.darker(0.9);
      return d3.interpolateLab(a.formatHex(), b.formatHex())(Math.max(0, Math.min(1, p)));
    }

    // ----- the GNSS: daily U at a station, at midday (as the timeline draws it); a spike day is not a value
    function uSeries(T, id) {
      const u = T && T.cols[`${id}_u_mm`], sp = (T && T.cols[`${id}_spike`]) || [];
      return u ? { t: T.t, v: (i) => (isNum(u[i]) && !sp[i] ? u[i] : null) } : null;
    }
    function dayRange(T, t0, t1) {
      if (!T || !T.t.length) return [0, -1];
      const i0 = Math.max(0, Math.floor((t0 - T.t[0]) / DAY) - 1), i1 = Math.min(T.t.length - 1, Math.ceil((t1 - T.t[0]) / DAY) + 1);
      return [i0, i1];
    }

    // ----- layout: panes stacked, sharing the time axis at the foot
    function layout(spec) {
      const top = 6, bot = H - AX_H, avail = bot - top - 6 * (spec.length - 1);
      let y = top;
      panes = spec.map((p) => { const h = Math.max(30, avail * p.f); const q = { ...p, y0: y, y1: y + h }; y += h + 6; return q; });
    }
    function yScale(p, lo, hi, nice = true) {
      const s = d3.scaleLinear().domain([lo, hi]).range([p.y1 - 2, p.y0 + 16]);
      return nice ? s.nice(6) : s;
    }
    function axisY(p, y, fmt = (v) => d3.format("~s")(v)) {
      g.save(); g.font = font(9); g.textAlign = "right"; g.textBaseline = "middle";
      for (const v of y.ticks(3)) {
        const py = y(v); if (py < p.y0 + 12 || py > p.y1) continue;
        g.globalAlpha = 0.5; g.strokeStyle = tok("--ds-axis"); g.lineWidth = 1; g.beginPath(); g.moveTo(PAD_L, Math.round(py) + 0.5); g.lineTo(W - padR, Math.round(py) + 0.5); g.stroke();
        g.globalAlpha = 1; g.fillStyle = tok("--ds-dim"); g.fillText(fmt(v), PAD_L - 5, py);
      }
      g.restore();
    }
    // a pane's head: its name, then its keys [label, colour, kind] (kind: "line" | "dash" | "bar" | "stem" | "ramp" | "glyph")
    function head(p, name, keys = []) {
      g.save(); g.font = font(9); g.textBaseline = "alphabetic";
      let kx = PAD_L + 2; const ky = p.y0 + 10;
      g.fillStyle = tok("--ds-dim"); g.fillText(name, kx, ky); kx += g.measureText(name).width + 12;
      for (const [lab, col, kind] of keys) {
        if (kx > W - padR - 40) break;
        g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1.6; g.setLineDash(kind === "dash" ? [3, 2] : []);
        if (kind === "ramp") { for (let i = 0; i < 14; i++) { g.fillStyle = segCol(i / 13); g.fillRect(kx + i, ky - 6, 1.2, 6); } kx += 18; }
        else if (kind === "bar") { g.fillRect(kx, ky - 6, 6, 6); kx += 10; }
        else if (kind === "stem") { g.beginPath(); g.moveTo(kx + 3, ky); g.lineTo(kx + 3, ky - 6); g.stroke(); g.beginPath(); g.arc(kx + 3, ky - 6, 1.8, 0, 7); g.fill(); kx += 10; }
        else if (kind === "glyph") { g.fillStyle = tok("--ds-dim"); g.font = font(10); g.fillText(col, kx, ky + 1); g.font = font(9); kx += 11; }
        else { g.beginPath(); g.moveTo(kx, ky - 3); g.lineTo(kx + 12, ky - 3); g.stroke(); kx += 16; }
        g.setLineDash([]); g.fillStyle = tok("--ds-label"); g.fillText(lab, kx, ky); kx += g.measureText(lab).width + 12;
      }
      g.restore();
    }
    function axisX() {
      const [t0, t1] = S.view, span = t1 - t0, n = Math.max(2, Math.floor((W - PAD_L - padR) / 90));
      const sc = d3.scaleUtc().domain([utc(t0), utc(t1)]), dm = d3.utcFormat("%-d %b");
      const f = span > 400 * DAY ? d3.utcFormat("%b %Y") : span > 2.5 * DAY ? dm : (d) => (d.getUTCHours() || d.getUTCMinutes() ? fmtHM(d) : dm(d));
      g.save(); g.font = font(9); g.fillStyle = tok("--ds-dim"); g.textBaseline = "alphabetic";
      const day0 = span <= 2.5 * DAY ? fmtD(utc(t0)) : null, xMin = day0 ? 4 + g.measureText(day0).width + 22 : PAD_L + 14;
      if (day0) g.fillText(day0, 4, H - 4);                    // the window's first day
      g.textAlign = "center";
      for (const d of sc.ticks(n)) { const px = x(d.getTime() / 1000); if (px < xMin || px > W - padR - 14) continue; g.fillText(f(d), px, H - 4); }
      g.restore();
    }
    // the onsets (as the timeline): ▼ eruption, solid · ▿ intrusion, dashed; a faint line through every pane, the glyph in
    // the row above the dates (clear of the panes' names)
    function drawOnsets() {
      const [t0, t1] = S.view;
      g.save();
      for (const e of onsets()) {
        if (e.onset < t0 || e.onset > t1) continue;
        const px = Math.round(x(e.onset)) + 0.5, intr = e.kind === "intrusion";
        g.globalAlpha = 0.55; g.strokeStyle = tok("--ds-line"); g.lineWidth = 1; g.setLineDash(intr ? [2, 3] : []);
        for (const p of panes) { g.beginPath(); g.moveTo(px, p.y0 + 14); g.lineTo(px, p.y1); g.stroke(); }
        g.setLineDash([]); g.globalAlpha = 1; g.fillStyle = tok("--ds-dim"); g.font = font(10); g.textAlign = "center";
        g.fillText(intr ? "▿" : "▼", px, H - AX_H + 10);
      }
      g.restore();
    }
    // a daily line (U), broken at missing days; its samples as dots when few
    function dayLine(p, y, Sx, col, i0, i1, lw = 1.5) {
      const [t0, t1] = S.view, n = Math.max(1, i1 - i0), dots = (W - PAD_L - padR) / n > 6;
      g.save(); g.beginPath(); g.rect(PAD_L, p.y0, W - PAD_L - padR, p.y1 - p.y0); g.clip();
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = lw; g.lineJoin = "round";
      let pen = false; g.beginPath();
      if (x(DAY) - x(0) >= 160) {
        // zoomed in to hours: each day's solution as its own level across its day, unjoined (a daily solution cannot time
        // a change within the day, so no line suggests one)
        for (let i = i0; i <= i1; i++) { const v = Sx.v(i); if (v != null) { g.moveTo(x(Sx.t[i]) + 3, y(v)); g.lineTo(x(Sx.t[i] + DAY) - 3, y(v)); } }
        g.stroke(); g.restore(); return;
      }
      for (let i = i0; i <= i1; i++) {
        const v = Sx.v(i), tt = Sx.t[i] + DAY / 2;
        if (v == null) { pen = false; continue; }
        if (!pen) { g.moveTo(x(tt), y(v)); pen = true; } else g.lineTo(x(tt), y(v));
      }
      g.stroke();
      if (dots) for (let i = i0; i <= i1; i++) { const v = Sx.v(i), tt = Sx.t[i] + DAY / 2; if (v != null && tt >= t0 - DAY && tt <= t1 + DAY) { g.beginPath(); g.arc(x(tt), y(v), 2, 0, 7); g.fill(); } }
      g.restore();
    }
    function note(p, text) { g.save(); g.font = font(11); g.fillStyle = tok("--ds-dim"); g.textAlign = "center"; g.fillText(text, (PAD_L + W - padR) / 2, (p.y0 + p.y1) / 2 + 4); g.restore(); }

    // ----- inflation · deflation: U at the body's stations
    function drawInflation() {
      padR = 40;
      layout([{ f: 1, key: "u" }]);
      const p = panes[0], [t0, t1] = S.view, B = ctx.gnssBody ? ctx.gnssBody() : null, C = ctx.col();
      const st = ((B && B.stations) || []).map((s) => ({ id: s.id, col: s.col || tok("--ds-txt"), U: uSeries(s.T || D.gnss, s.id), T: s.T || D.gnss })).filter((s) => s.U);
      let lo = Infinity, hi = -Infinity;
      for (const s of st) { const [i0, i1] = dayRange(s.T, t0, t1); s.i0 = i0; s.i1 = i1; for (let i = i0; i <= i1; i++) { const v = s.U.v(i); if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } } }
      head(p, "up · mm", st.map((s) => [s.id, s.col, "line"]));
      if (!st.length || !(hi >= lo)) { note(p, "no GNSS in this window"); drawOnsets(); axisX(); hitInfo = { kind: "inflation", st, y: null, p }; return; }
      if (hi - lo < 2) { lo -= 1; hi += 1; }
      const pad = (hi - lo) * 0.06, y = yScale(p, lo - pad, hi + pad);
      axisY(p, y);
      drawOnsets();
      for (const s of st) dayLine(p, y, s.U, s.col, s.i0, s.i1);
      // direct labels at the right edge, by the last value in view, pushed apart
      const lab = st.map((s) => { let v = null; for (let i = Math.min(s.i1, Math.floor((t1 - s.T.t[0]) / DAY)); i >= s.i0; i--) { v = s.U.v(i); if (v != null) break; } return v == null ? null : { s, py: y(v) }; }).filter(Boolean).sort((a, b) => a.py - b.py);
      for (let k = 1; k < lab.length; k++) if (lab[k].py - lab[k - 1].py < 10) lab[k].py = lab[k - 1].py + 10;
      g.save(); g.font = font(9); g.textBaseline = "middle";
      for (const l of lab) { g.fillStyle = tok("--ds-label"); g.fillText(l.s.id, W - padR + 5, Math.min(p.y1 - 2, l.py)); g.fillStyle = l.s.col; g.fillRect(W - padR + 1, Math.min(p.y1 - 2, l.py) - 1, 3, 2); }
      g.restore();
      axisX();
      hitInfo = { kind: "inflation", st, y, p };
    }

    // ----- swarms: quakes per bin, M ≥ 2 stems above
    function drawSwarms() {
      padR = 12;
      const [bin, bname] = BINS[Math.max(0, Math.min(4, S.levelIdx ?? 3))], [t0, t1] = S.view, C = ctx.col(), col = C.event || tok("--ds-txt");
      layout([{ f: 0.38, key: "m" }, { f: 0.62, key: "n" }]);
      const [pm, pn] = panes, E = ctx.src.events(t0 - bin, t1 + bin), sel = ctx.selection ? ctx.selection() : null;
      const b0 = Math.floor((t0 - bin) / bin), nb = Math.max(1, Math.ceil((t1 + bin) / bin) - b0), cnt = new Int32Array(nb), mx = new Float32Array(nb).fill(-Infinity), big = [];
      let tot = 0;
      for (let k = E.i0; k < E.i1; k++) {
        if (sel && !sel(k)) continue;
        const b = Math.floor(E.t[k] / bin) - b0; if (b < 0 || b >= nb) continue;
        cnt[b]++; tot++; const m = E.mag[k]; if (isNum(m)) { if (m > mx[b]) mx[b] = m; if (m >= 2 && E.t[k] >= t0 && E.t[k] <= t1) big.push(k); }
      }
      head(pm, "M ≥ 2", [["magnitude", col, "stem"]]);
      head(pn, `quakes per ${bname}`, [[sel ? "in view" : "all", col, "bar"]]);
      drawOnsets();
      if (!tot) { note(pn, "no quakes in this window"); axisX(); hitInfo = null; return; }
      // the counts: one bar per bin; narrower than a pixel, each pixel column shows its busiest bin (the axis stays per bin)
      let cmax = 1; const i0 = Math.max(0, Math.floor(t0 / bin) - b0), i1 = Math.min(nb - 1, Math.floor(t1 / bin) - b0);
      for (let i = i0; i <= i1; i++) cmax = Math.max(cmax, cnt[i]);
      const yn = yScale(pn, 0, cmax); axisY(pn, yn, (v) => d3.format("~d")(v));
      g.save(); g.beginPath(); g.rect(PAD_L, pn.y0, W - PAD_L - padR, pn.y1 - pn.y0); g.clip(); g.fillStyle = col; g.globalAlpha = 0.8;
      const bw = x(bin) - x(0);
      if (bw >= 1.5) {
        const gap = bw >= 4 ? 1 : 0;
        for (let i = i0; i <= i1; i++) if (cnt[i]) { const xa = x((i + b0) * bin), h = yn(0) - yn(cnt[i]); g.fillRect(xa + gap / 2, yn(cnt[i]), Math.max(1, bw - gap), h); }
      } else {
        const col1 = new Int32Array(Math.ceil(W));
        for (let i = i0; i <= i1; i++) { const px = Math.floor(x((i + b0) * bin)); if (px >= 0 && px < col1.length && cnt[i] > col1[px]) col1[px] = cnt[i]; }
        for (let px = 0; px < col1.length; px++) if (col1[px]) g.fillRect(px, yn(col1[px]), 1, yn(0) - yn(col1[px]));
      }
      g.restore();
      // the stems: every M ≥ 2 at its magnitude
      const mTop = Math.max(4, ...big.map((k) => E.mag[k])), ym = yScale(pm, 2, Math.ceil(mTop * 2) / 2, false);
      axisY(pm, ym, (v) => `M${v}`);
      g.save(); g.beginPath(); g.rect(PAD_L, pm.y0, W - PAD_L - padR, pm.y1 - pm.y0); g.clip();
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1;
      const thin = big.length > 400;
      for (const k of big) {
        const px = x(E.t[k]), py = ym(E.mag[k]);
        g.globalAlpha = thin ? 0.45 : 0.75; g.beginPath(); g.moveTo(px, ym(2)); g.lineTo(px, py); g.stroke();
        g.globalAlpha = 0.95; g.beginPath(); g.arc(px, py, thin ? 1.6 : 2.4, 0, 7); g.fill();
      }
      g.restore();
      axisX();
      hitInfo = { kind: "swarms", bin, bname, b0, cnt, mx, big, E, ym, yn, pm, pn, sel };
    }

    // ----- drop ↔ fountain: Leif's fountain plot over SKSH's drop
    function drawFountain() {
      padR = 12;
      layout([{ f: 0.64, key: "h" }, { f: 0.36, key: "u" }]);
      const [ph, pu] = panes, [t0, t1] = S.view, C = ctx.col(), L = fountains();
      const inWin = L.filter((e) => { const [a, b] = fountainSpan(e); return a <= t1 && b >= t0; });
      const loaded = inWin.map((e) => ({ e, F: series(e) })).filter((r) => r.F);
      const anySim = loaded.some((r) => r.F.kind === "simulated"), anyObs = loaded.some((r) => r.F.kind !== "simulated");
      head(ph, "fountain · m", [...(anyObs || !loaded.length ? [["observed", tok("--ds-dim"), "line"]] : []), ...(anySim ? [["simulated", tok("--ds-dim"), "dash"]] : []), ["south → north", null, "ramp"]]);
      head(pu, "SKSH up · mm · daily", []);
      // the fountains
      let hTop = 140;
      for (const { F } of loaded) for (const c of F.cols || []) for (const v of (F.data || {})[c] || []) if (isNum(v) && v > hTop) hTop = v;
      const yh = yScale(ph, 0, hTop); axisY(ph, yh, (v) => d3.format("~d")(v));
      msg.innerHTML = ""; msg.style.display = "none";
      if (!inWin.length || !loaded.length) {
        if (inWin.length) note(ph, "loading the fountain heights…");
        else nearest(ph, L);
      }
      g.save(); g.beginPath(); g.rect(PAD_L, ph.y0 + 12, W - PAD_L - padR, ph.y1 - ph.y0 - 12); g.clip(); g.lineJoin = "round";
      const segs = [];
      for (const { e, F } of loaded) {
        const sim = F.kind === "simulated", ts = F.t || [];
        let a = 0; while (a < ts.length && ts[a] < t0) a++; a = Math.max(0, a - 1);
        let b = ts.length - 1; while (b > 0 && ts[b] > t1) b--; b = Math.min(ts.length - 1, b + 1);
        const perPx = (b - a + 1) / Math.max(1, x(ts[b] ?? t1) - x(ts[a] ?? t0));
        for (const c of F.cols || []) segs.push({ e, F, c, sim, a, b, perPx, col: segCol(F._rank ? F._rank.get(c) : 0.5) });
      }
      const order = hot ? [...segs.filter((s) => !(s.F === hot.F && s.c === hot.c)), ...segs.filter((s) => s.F === hot.F && s.c === hot.c)] : segs;
      for (const s of order) {
        const hs = (s.F.data || {})[s.c] || [], ts = s.F.t, isHot = hot && s.F === hot.F && s.c === hot.c;
        g.strokeStyle = s.col; g.fillStyle = s.col; g.globalAlpha = hot ? (isHot ? 1 : 0.3) : 0.9; g.lineWidth = isHot ? 2.2 : s.sim ? 1.4 : 1.2;
        g.setLineDash(s.sim ? [4, 3] : []);
        g.beginPath();
        const GAP = 600;
        if (s.perPx > 2) {
          // many samples a pixel: each column's range, joined (a fountain is spiky; its peaks stay)
          let cx = null, lo = 0, hi = 0, last = -Infinity, pen = false;
          const flush = () => { if (cx == null) return; if (!pen) { g.moveTo(cx + 0.5, yh(lo)); pen = true; } else g.lineTo(cx + 0.5, yh(lo)); if (hi > lo) g.lineTo(cx + 0.5, yh(hi)); };
          for (let i = s.a; i <= s.b; i++) {
            const v = hs[i]; if (!isNum(v)) continue;
            if (ts[i] - last > GAP) { flush(); cx = null; pen = false; }
            last = ts[i];
            const px = Math.floor(x(ts[i])); if (px !== cx) { flush(); cx = px; lo = hi = v; } else { lo = Math.min(lo, v); hi = Math.max(hi, v); }
          }
          flush();
        } else {
          let pen = false, last = -Infinity;
          for (let i = s.a; i <= s.b; i++) {
            const v = hs[i]; if (!isNum(v)) continue;
            if (ts[i] - last > GAP) pen = false;
            last = ts[i];
            if (!pen) { g.moveTo(x(ts[i]), yh(v)); pen = true; } else g.lineTo(x(ts[i]), yh(v));
          }
        }
        g.stroke(); g.setLineDash([]);
        // Leif's observed samples as small dots, when they stand apart
        if (!s.sim && s.perPx < 0.25) for (let i = s.a; i <= s.b; i++) { const v = hs[i]; if (isNum(v)) { g.beginPath(); g.arc(x(ts[i]), yh(v), isHot ? 1.9 : 1.3, 0, 7); g.fill(); } }
      }
      g.restore();
      // the ground's drop: SKSH U, daily
      const U = uSeries(D.gnss, "SKSH"), [i0, i1] = dayRange(D.gnss, t0, t1);
      let lo = Infinity, hi = -Infinity;
      if (U) for (let i = i0; i <= i1; i++) { const v = U.v(i); if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
      let yu = null;
      if (U && hi >= lo) {
        if (hi - lo < 2) { lo -= 1; hi += 1; }
        yu = yScale(pu, lo - (hi - lo) * 0.08, hi + (hi - lo) * 0.08); axisY(pu, yu);
        dayLine(pu, yu, U, (C.gnss || {}).SKSH || tok("--ds-txt"), i0, i1);
      } else note(pu, "no GNSS in this window");
      drawOnsets();
      axisX();
      hitInfo = { kind: "deflation", segs, yh, yu, U, ph, pu };
    }
    // outside every fountain: the nearest one, by its onset, a click away (the view Leif's plot uses: 0–6 h after onset)
    function nearest(p, L) {
      const c = (S.view[0] + S.view[1]) / 2;
      const e = L.slice().sort((a, b) => Math.abs(a.onset - c) - Math.abs(b.onset - c))[0];
      if (!e) { note(p, "no fountain heights in this data"); return; }
      const kind = e.fountain_kind === 2 || (e.fnt && e.fnt.kind === 2) ? "simulated" : "observed";
      msg.innerHTML = `<div>no fountain in this window</div><button class="plt-go" title="show the first six hours of this eruption">nearest: ${esc(fmtD(utc(e.onset)))} · ${kind} ›</button>`;
      msg.style.display = "block"; msg.style.top = `${Math.round((p.y0 + p.y1) / 2 - 18)}px`;
      msg.querySelector(".plt-go").onclick = () => { ctx.setView(e.onset - 0.25 * 3600, e.onset + 6.25 * 3600); ctx.setCursor(e.onset); };
    }

    let hitInfo = null;
    function draw() {
      if (!host.offsetParent) return;                          // hidden (the latents shown): nothing to draw
      const E = ctx.src && ctx.src.events ? ctx.src.events(-Infinity, Infinity) : { n: 0 };
      const sel = ctx.selection ? (S.box ? JSON.stringify(S.box) : "") + (S.hearMap && S.region ? JSON.stringify(S.region) : "") : "";
      const key = [mode(), S.view[0], S.view[1], W, H, DarkStyle.get(), ver, !!D.gnss, S.levelIdx, E.n, sel, hot ? `${hot.c}@${hot.F.id}` : "", S.bodySet].join("|");
      if (key !== drawn) {
        drawn = key; topKey = "";
        g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
        hitInfo = null; if (mode() !== "deflation") { msg.innerHTML = ""; msg.style.display = "none"; }
        ({ inflation: drawInflation, swarms: drawSwarms, deflation: drawFountain })[mode()]();
      }
      // the playhead (gold = you) and the hover's crosshair
      const tk = [drawn, S.cursor, ptr ? ptr.join(",") : ""].join("|");
      if (tk === topKey) return; topKey = tk;
      gt.setTransform(dpr, 0, 0, dpr, 0, 0); gt.clearRect(0, 0, W, H);
      const yT = panes.length ? panes[0].y0 + 14 : 0, yB = panes.length ? panes[panes.length - 1].y1 + 12 : H - AX_H;
      const pc = x(S.cursor);
      if (pc >= PAD_L - 1 && pc <= W - padR + 1) { gt.strokeStyle = tok("--ds-cur"); gt.lineWidth = 1.5; gt.beginPath(); gt.moveTo(Math.round(pc) + 0.5, yT); gt.lineTo(Math.round(pc) + 0.5, yB); gt.stroke(); }
      if (ptr && ptr[0] >= PAD_L && ptr[0] <= W - padR) { gt.strokeStyle = tok("--ds-dim"); gt.globalAlpha = 0.6; gt.lineWidth = 1; gt.setLineDash([2, 3]); gt.beginPath(); gt.moveTo(Math.round(ptr[0]) + 0.5, yT); gt.lineTo(Math.round(ptr[0]) + 0.5, yB); gt.stroke(); gt.setLineDash([]); gt.globalAlpha = 1; }
    }

    // ----- hover: the values at the pointer's time; a click moves the cursor there
    function hoverLines(px, py) {
      const t = tAt(px), I = hitInfo, out = [];
      const near = onsets().find((e) => e.onset >= S.view[0] && e.onset <= S.view[1] && Math.abs(x(e.onset) - px) <= 4);
      if (!I) return near ? [onsetLine(near)] : null;
      if (I.kind === "inflation") {
        out.push(`<b>${fmtD(utc(t))}</b> · up, since 2023-06-17`);
        for (const s of I.st) { const i = Math.floor((t - s.T.t[0]) / DAY), v = i >= 0 ? s.U.v(i) : null; out.push(`<span style="color:${s.col}">━</span> ${s.id} ${v == null ? "no solution that day" : `${sgn(v)} mm`}`); }
      } else if (I.kind === "swarms") {
        const b = Math.floor(t / I.bin) - I.b0, n = I.cnt[b] || 0, m = I.mx[b];
        const a = (b + I.b0) * I.bin, f = I.bin >= DAY ? fmtD(utc(a)) : `${fmtDT(utc(a))}–${fmtHM(utc(a + I.bin))} UTC`;
        // a stem under the pointer first
        let best = null, bd = 49;
        if (py <= I.pm.y1) for (const k of I.big) { const d = (x(I.E.t[k]) - px) ** 2 + (I.ym(I.E.mag[k]) - py) ** 2; if (d < bd) { bd = d; best = k; } }
        if (best != null) out.push(`<b>M ${I.E.mag[best].toFixed(1)}</b> · ${fmtDT(utc(I.E.t[best]))} UTC${isNum(I.E.depth_km[best]) ? ` · ${I.E.depth_km[best].toFixed(1)} km deep` : ""}`);
        out.push(`${best != null ? "" : "<b>"}${f}${best != null ? "" : "</b>"} · ${n} quake${n === 1 ? "" : "s"}${n && isNum(m) && m > -Infinity ? ` · largest M ${m.toFixed(1)}` : ""}${I.sel ? " · in view" : ""}`);
      } else {
        const on = [];
        for (const s of I.segs) { const h = hAt(s.F, s.c, t); if (isNum(h) && h > 0) on.push([s, h]); }
        on.sort((u, v) => v[1] - u[1]);
        const e = I.segs.length ? I.segs.find((s) => t >= s.e.onset - 600 && t <= fountainSpan(s.e)[1] + 600) : null;
        out.push(`<b>${fmtDT(utc(t))} UTC</b>${e ? ` · ${sgn((t - e.e.onset) / 3600, 1)} h from the onset` : ""}`);
        if (hot) { const h = hAt(hot.F, hot.c, t); out.push(`<span style="color:${hot.col}">━</span> <b>segment ${esc(hot.c)}</b> · ${isNum(h) ? `${Math.round(h)} m` : "no fountain"} · ${hot.sim ? "simulated" : "observed"}`); }
        else if (on.length) out.push(on.slice(0, 5).map(([s, h]) => `<span style="color:${s.col}">━</span> ${esc(s.c)} ${Math.round(h)} m`).join(" · ") + (on.length > 5 ? ` · +${on.length - 5}` : ""));
        else if (I.segs.length) out.push(`<span class="dim">no fountain at this moment</span>`);
        if (I.U) { const i = Math.floor((t - D.gnss.t[0]) / DAY), v = i >= 0 ? I.U.v(i) : null; out.push(`SKSH up ${v == null ? "—" : `${sgn(v)} mm`} <span class="dim">(that day's solution)</span>`); }
      }
      if (near) out.push(onsetLine(near));
      out.push(`<span class="dim">click: move the cursor here</span>`);
      return out;
    }
    function onsetLine(e) { return `${e.kind === "intrusion" ? "▿" : "▼"} ${e.kind}${e.imo_n ? ` ${e.imo_n}` : ""} · onset ${e.onset_approx ? "≈ " : ""}${fmtDT(utc(e.onset))} UTC`; }
    // the fountain line nearest the pointer (≤ 8 px), lit while hovered
    function pickSeg(px, py) {
      const I = hitInfo; if (!I || I.kind !== "deflation" || py < I.ph.y0 || py > I.ph.y1) return null;
      const t = tAt(px); let best = null, bd = 8;
      for (const s of I.segs) { const h = hAt(s.F, s.c, t); if (!isNum(h)) continue; const d = Math.abs(I.yh(h) - py); if (d < bd) { bd = d; best = s; } }
      return best;
    }
    tp.addEventListener("pointermove", (e) => {
      const r = tp.getBoundingClientRect(), px = e.clientX - r.left, py = e.clientY - r.top;
      ptr = [px, py];
      const s = pickSeg(px, py); if ((s ? `${s.c}@${s.F.id}` : null) !== (hot ? `${hot.c}@${hot.F.id}` : null)) hot = s;
      if ((ctx.hoverOn && !ctx.hoverOn()) || px < PAD_L || px > W - padR) { hbox.style.display = "none"; return; }
      const L = hoverLines(px, py); if (!L) { hbox.style.display = "none"; return; }
      hbox.innerHTML = L.map((l) => `<div>${l}</div>`).join(""); hbox.style.display = "block";
      const bw = hbox.offsetWidth, bh = hbox.offsetHeight;
      hbox.style.left = Math.max(2, px + 14 + bw > W ? px - bw - 14 : px + 14) + "px";
      hbox.style.top = Math.max(2, py + 14 + bh > H ? py - bh - 14 : py + 14) + "px";
    });
    tp.addEventListener("pointerleave", () => { hbox.style.display = "none"; ptr = null; hot = null; });
    tp.addEventListener("click", (e) => {
      const r = tp.getBoundingClientRect(), px = e.clientX - r.left;
      if (px < PAD_L || px > W - padR) return;
      ctx.setCursor(Math.max(S.view[0], Math.min(S.view[1], tAt(px))));
    });

    new ResizeObserver(() => resize()).observe(host);
    resize();
    return {
      frame() { draw(); },
      redraw() { drawn = ""; },
      restyle() { drawn = ""; },
      reload() { fnt.clear(); ver++; drawn = ""; },
      info: () => ({ mode: mode(), panes: panes.map((p) => p.key), hit: hitInfo && hitInfo.kind, bin: hitInfo && hitInfo.bname, fountains: [...fnt.values()].filter(Boolean).length }),
    };
  }
  return { create };
})();
