/* brush.js — STROKE over a plot to TRACE many points at once.
 *
 * Tracing was only ever a per-point gesture: shift-press one dot at a time. Miguel asked for
 * the obvious alternative — sweep many. The FIRST answer here was a d3-brush rectangle; this
 * is the second, and the right one: the path brush the rest of the house already uses
 * (darkpulsar / dark_nova `brushMode`, dark_ocean `brushStroke`, manual B2.21 §9.4). You
 * stroke over the plot and every point the stroke passes near is picked up, with a live trail.
 *
 * WHY A STROKE AND NOT A BOX. A rectangle answers "everything between these two corners",
 * which is not what the gesture said: dragging along a diagonal front in dark_ocean picked
 * ~4670 cells as a box against ~295 as a path ribbon — 16x too many, all of them points the
 * hand never went near (the path-brush feedback was Miguel's own, 2026-07-18 in dark_ocean,
 * after watching Björn's gesture; the 4670/295 figures are the assistant's measurement;
 * B2.21 §9.4). A stroke means "these points, along
 * this line", so that is what it traces. The stroke is NOT closed and nothing is taken by
 * enclosure: to trace a blob you scribble over it, which is exactly as predictable as it
 * sounds and never surprises you with an interior you could not see.
 *
 * WHAT WAS TAKEN FROM WHERE. The gesture is darkpulsar's (`brushPts` / `brushSeg` /
 * `drawBrush` / Esc, which dark_nova copies verbatim); the plumbing is dark_ocean's, which
 * had moved on — setPointerCapture so the stroke survives leaving the plot, pointercancel,
 * and a radius that is derived rather than a magic number. Both were fixed-pixel or
 * fixed-cell radii; see BRUSH RADIUS below for why six views with six densities need it
 * computed instead.
 *
 * THE ARMING IS LOAD-BEARING (unchanged from the rectangle). Plain press-drag is already
 * taken: it SCRUBS, moving the sonification to every point it passes. A brush that merely
 * coexisted with the scrub would fire ~50 sonification commits per sweep. So the brush is
 * live only when the sidebar's ◫ toggle is on, or while alt is held, and the host views
 * early-return from their own pointer handlers under the same test — `RWBrush.armed(e)`.
 * Exactly one of the two gestures is ever active, and a sweep sends the bridge no scrub commits.
 * (With the GUI connected, the biplot's P30 replay moves the GUI's point once per changed month -
 * that is the replay, wc.js, not a scrub.)
 *   The rectangle needed that guard because d3-brush binds MOUSEdown, not pointerdown, and
 *   so could not cancel the views' pointer handlers itself. This brush IS pointer-native, so
 *   it could have been dropped — but it is kept, because the views' handlers are registered
 *   FIRST on the same node and would run before anything this file could say. What the
 *   pointer-native rewrite buys instead is that `armed(e)` is now ALSO true for as long as a
 *   stroke is in flight: release alt in the middle of a sweep and the views stay quiet
 *   rather than suddenly scrubbing the rest of the gesture out from under it.
 *
 * Usage (every view mounts it the same way; linear and the biplot gate their pointer handlers on
 * RWBrush.armed too since 2026-09-27, P27):
 *   const b = RWBrush.mount({ svg, extent:()=>[[0,0],[W,H]], points:()=>[{key,x,y}],
 *                             reach: 26,   // optional: the hover box's reach, px - a dab takes the same
 *                             onCommit:(keys,mode)=>{ WC.setTraced(keys,mode); draw(); } });
 *   b.raise();   // at the END of every draw(), or later-appended layers cover the trail
 * `extent` was the rectangle's bounds; a stroke has none, so it is used to CLAMP the stroke
 * to the plot (drag off the edge and the trail runs along it, as the rectangle did).
 * `onCommit` fires ONCE per gesture with the whole set: one mutation, one save, one redraw. What
 * the GUI hears is WC's business (P30): a view that maps keys to GUI indices (the biplot's months)
 * replays each CHANGED point as select_idx + press("track"); every other view sends it nothing.
 */
window.RWBrush = (function () {
  // ---- BRUSH RADIUS — the ribbon's half-width in screen px --------------------------------
  // darkpulsar hard-codes 16 px. One number cannot serve six views here: the scatter's facets
  // pack a month's days into a few hundred px while the biplot spreads a filtered year over a
  // square plot, so 16 px is a fat crayon in one and a missed tap in the other. Instead the
  // radius is derived from the FIELD YOU ARE ABOUT TO BRUSH, once per gesture: the median
  // nearest-neighbour distance of the drawn points, doubled. For a Poisson field the median
  // NN distance is ~0.47/sqrt(density), so on darkpulsar's own scatter (1297 points in ~600²)
  // this formula lands on 15.6 px — i.e. it reproduces the house constant where the house
  // constant was tuned, and adapts everywhere else. The clamps keep it a brush: never finer
  // than a pointer can be aimed, never so broad that "along this line" stops being true.
  const R_MIN = 10, R_MAX = 28, R_K = 2.0;
  const R_SAMPLE = 150;        // points sampled for the median; the estimate is stable well below this
  const CLICK_SLOP = 4;        // px — under this the gesture is a dab, not a stroke (the views use 4 too)
  const MIN_STEP = 1.5;        // px — path simplification; sub-pixel samples add cost and no shape

  // The ONE stroke in flight, across every mount. Four facet brushes share this file, and a
  // second pointer must not start a second ribbon while one is live.
  let ACTIVE = null;

  // armed(e) — the views' gate. `ACTIVE` first: once a stroke has started it owns the
  // gesture even if the modifier is released mid-sweep (see header).
  const armed = e => !!ACTIVE
    || (window.WC && WC.brushPref && WC.brushPref())
    || (e && e.altKey);

  // The trail wears THE TRACE COLOUR, because that is what the stroke is about to make:
  // gold to add, and a muted red when shift turns the stroke into an eraser. Read late —
  // wc.js may not have evaluated when this file does.
  const ADD_COL = () => (window.WC && WC.GOLD) || RWLook.d.gold;
  const DEL_COL = () => RWLook.d.del;
  const CASING = () => RWLook.d.casing;    // the casing under the hairline (the ground's colour), so it reads over bright points

  // THE CURSOR IS THE ARMED STATE. The old rule here was `.rwbrush .overlay{cursor:inherit}`:
  // d3-brush painted crosshair on its overlay the moment it mounted, which told the user
  // tracing was live even when the brush was disarmed. The fix then was to paint crosshair
  // from body.brushing - but every plot already wears a crosshair, so an armed brush looked
  // exactly like a disarmed one, and with the switch persisted in a tab you were not looking
  // at, a press that traced (and a shift-press that untraced) read as a broken plot (Miguel
  // 2026-09-28). Armed now wears its own cursor, a brush tip (--rw-brush-cursor, wc.js):
  // under body.brushing (the ◫ switch) and body.brush-alt (alt held; both kept by wc.js). !important
  // because the biplot sets its crosshair inline. It also kills touch-scrolling mid-stroke.
  (function css() {
    if (document.getElementById("rwbrush-css")) return;
    const st = document.createElement("style"); st.id = "rwbrush-css";
    st.textContent = ".rwbrush{ pointer-events:none; }"
      + "body.brushing .rwbrush-host, body.brush-alt .rwbrush-host{"
      + " cursor:var(--rw-brush-cursor, cell) !important; touch-action:none; }";
    (document.head || document.documentElement).appendChild(st);
  })();


  const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);
  function distToSeg(qx, qy, ax, ay, bx, by) {      // point → segment distance (the whole brush)
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((qx - ax) * dx + (qy - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    return Math.hypot(qx - (ax + t * dx), qy - (ay + t * dy));
  }

  function mount(o) {
    if (!window.d3 || !o || !o.svg) return null;
    const svg = o.svg.node ? o.svg : d3.select(o.svg);
    if (svg.empty()) return null;
    const node = svg.node();
    svg.classed("rwbrush-host", true);

    // One inert layer for the trail. Four parts, in this order, because the point field
    // underneath is dark AND densely coloured: a wide translucent band showing the ribbon's
    // real reach, a dark casing under the hairline so the line never dissolves into a bright
    // cluster, the hairline itself (where the hand actually went), and the rings.
    const g = svg.append("g").attr("class", "rwbrush").style("pointer-events", "none");
    const band = g.append("path").attr("fill", "none").attr("stroke-opacity", 0.13)
      .attr("stroke-linecap", "round").attr("stroke-linejoin", "round");
    const casing = g.append("path").attr("fill", "none").attr("stroke", CASING())
      .attr("stroke-width", 4).attr("stroke-opacity", 0.5)
      .attr("stroke-linecap", "round").attr("stroke-linejoin", "round");
    const line = g.append("path").attr("fill", "none").attr("stroke-width", 1.6)
      .attr("stroke-opacity", 0.95)
      .attr("stroke-linecap", "round").attr("stroke-linejoin", "round");
    const rings = g.append("g");

    let S = null;                                    // this mount's stroke, === ACTIVE while live

    function bounds() {
      const ext = (o.extent && o.extent()) || null;
      if (ext && ext[0] && ext[1]) return ext;
      const b = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
      return b ? [[0, 0], [b.width, b.height]] : null;
    }
    function at(e) {                                 // event → svg pixels, clamped to the plot
      const p = d3.pointer(e, node), ex = bounds();
      return ex ? [clamp(p[0], ex[0][0], ex[1][0]), clamp(p[1], ex[0][1], ex[1][1])] : p;
    }

    // The point field is snapshotted ONCE, at press. Nothing redraws mid-gesture, and asking
    // the view to rebuild its point list on every pointermove would be the expensive part of
    // this file. It also means the radius is measured on the field you are actually brushing:
    // filter a year out and the brush widens to match what is left on screen.
    function snapshot() {
      const raw = (o.points && o.points()) || [], pts = [];
      for (const p of raw) {
        if (!p || p.key == null || p.x == null || p.y == null) continue;
        if (Number.isNaN(+p.x) || Number.isNaN(+p.y)) continue;
        pts.push(p);
      }
      let qt = null;
      try { qt = d3.quadtree().x(p => p.x).y(p => p.y).addAll(pts); } catch (e) { qt = null; }
      return { pts, qt, r: radiusFor(pts, qt) };
    }
    function radiusFor(pts, qt) {
      const n = pts.length;
      if (!n) return R_MIN;
      let med = 0;
      if (qt && n > 1) {
        // on a COPY: remove/add moves a point to the head of a coincident chain, which changes
        // which one find() - the dab - returns from the tree used for picking (review 2026-09-28)
        const t = qt.copy();
        const ds = [], step = Math.max(1, Math.floor(n / R_SAMPLE));
        for (let i = 0; i < n; i += step) {
          const p = pts[i];
          t.remove(p); const q = t.find(p.x, p.y); t.add(p);      // nearest OTHER point
          if (q) ds.push(Math.hypot(q.x - p.x, q.y - p.y));
        }
        if (ds.length) { ds.sort((a, b) => a - b); med = ds[ds.length >> 1]; }
      } else {
        const ex = bounds();                          // no quadtree: uniform-field estimate
        const W = ex ? ex[1][0] - ex[0][0] : 0, H = ex ? ex[1][1] - ex[0][1] : 0;
        med = (W > 0 && H > 0) ? 0.5 * Math.sqrt(W * H / n) : 8;
      }
      return clamp(R_K * med, R_MIN, R_MAX);
    }

    function take(s, p) {
      if (s.seen.has(p)) return;
      s.seen.add(p); s.picked.push(p);
    }
    // every point within r of the segment a→b joins the pending set. The quadtree prunes
    // whole quadrants outside the segment's reach, so a long stroke over a big field stays
    // cheap; without one it degrades to a scan, which is also correct.
    function pickSeg(s, a, b) {
      const r = s.r;
      const x0 = Math.min(a[0], b[0]) - r, x1 = Math.max(a[0], b[0]) + r;
      const y0 = Math.min(a[1], b[1]) - r, y1 = Math.max(a[1], b[1]) + r;
      const hit = p => { if (!s.seen.has(p) && distToSeg(p.x, p.y, a[0], a[1], b[0], b[1]) <= r) take(s, p); };
      if (s.qt) s.qt.visit((nd, nx0, ny0, nx1, ny1) => {
        if (nx0 > x1 || nx1 < x0 || ny0 > y1 || ny1 < y0) return true;     // out of reach
        if (!nd.length) { let q = nd; do { hit(q.data); } while ((q = q.next)); }
        return false;
      });
      else for (const p of s.pts) hit(p);
    }
    // A DAB — press and release without travelling — takes THE NEAREST point within the
    // radius, and only that one. Not darkpulsar's "everything within r of the press", because
    // while the ◫ toggle is on the views' own shift-press (their precise single-point trace)
    // is gated off by design: the brush has to be able to say "just this one" or that gesture
    // has no spelling at all. Press on empty space and nothing is traced — a stroke that
    // touched nothing commits nothing, which is also what a miss with the rectangle did.
    // The dab reaches exactly as far as the view's own hover box when the view says how far that
    // is (`o.reach`, px): the box stays up while the brush is armed so you can aim, and a dab that
    // looked less far (or further) than the box would trace something other than what it named
    // (review 2026-09-28). The ribbon of a real stroke keeps the derived radius.
    function pickNearest(s, a) {
      const R = (o.reach != null) ? o.reach : s.r;
      let best = null;
      if (s.qt) best = s.qt.find(a[0], a[1], R) || null;
      else { let bd = R; for (const p of s.pts) { const d = Math.hypot(p.x - a[0], p.y - a[1]); if (d <= bd) { bd = d; best = p; } } }
      if (best) take(s, best);
    }

    const dstr = path => path.length > 1
      ? "M" + path.map(p => p[0].toFixed(1) + "," + p[1].toFixed(1)).join("L") : null;
    // PICKED POINTS ARE RINGED AS THEY ARE PICKED, not at release — the immediacy is the whole
    // point of the gesture. Rings are appended incrementally (the set only grows) and the
    // trail is one attribute write, so a 500-point sweep does not rebuild 500 nodes a frame.
    function draw(s) {
      const col = s.mode === "remove" ? DEL_COL() : ADD_COL(), d = dstr(s.path);
      band.attr("d", d).attr("stroke", col).attr("stroke-width", s.r * 2);
      casing.attr("d", d).attr("stroke", CASING());
      line.attr("d", d).attr("stroke", col);
      for (let i = s.drawn; i < s.picked.length; i++) {
        const p = s.picked[i];
        rings.append("circle").attr("cx", p.x).attr("cy", p.y).attr("r", 6.5)
          .attr("fill", "none").attr("stroke", col).attr("stroke-width", 2);
      }
      s.drawn = s.picked.length;
      if (s.mode !== s.drawnMode) {                  // shift flipped mid-stroke: recolour once
        rings.selectAll("circle").attr("stroke", col);
        s.drawnMode = s.mode;
      }
    }
    function schedule(s) {
      if (s.raf) return;
      s.raf = requestAnimationFrame(() => { s.raf = 0; if (S === s) draw(s); });
    }

    function onDown(e) {
      if (ACTIVE || e.button || !armed(e)) return;   // primary button only, one stroke at a time
      const f = snapshot();
      if (!f.pts.length) return;                     // nothing drawn — let the view have the event
      e.preventDefault();
      S = ACTIVE = {
        pts: f.pts, qt: f.qt, r: f.r, id: e.pointerId,
        path: [], seen: new Set(), picked: [], drawn: 0, drawnMode: null,
        mode: e.shiftKey ? "remove" : "add", down: [e.clientX, e.clientY], moved: false, raf: 0
      };
      const p = at(e);
      S.path.push(p);
      pickNearest(S, p);                             // the dab; the ribbon takes over on move
      try { node.setPointerCapture(e.pointerId); } catch (_) {}
      // listened for on WINDOW, in the capture phase: the stroke must keep its shape when the
      // pointer leaves the plot (capture retargets, but a lost capture must not strand it).
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", onAbort, true);
      window.addEventListener("keydown", onKey, true);
      draw(S);
    }
    function onMove(e) {
      const s = S; if (!s || (s.id != null && e.pointerId !== s.id)) return;
      s.mode = e.shiftKey ? "remove" : "add";        // live, so the trail shows which it is
      if (!s.moved) {
        if (Math.hypot(e.clientX - s.down[0], e.clientY - s.down[1]) <= CLICK_SLOP) return schedule(s);
        s.moved = true;                              // past the slop: this is a stroke
        // the press took the DAB's pick (out to `reach`); a stroke takes only what its ribbon
        // covers, so the start is re-taken at the ribbon's radius (review 2026-09-28)
        s.seen.clear(); s.picked.length = 0; s.drawn = 0; rings.selectAll("circle").remove();
        pickSeg(s, s.path[0], s.path[0]);
      }
      const p = at(e), q = s.path[s.path.length - 1];
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) < MIN_STEP) return;
      pickSeg(s, q, p); s.path.push(p); schedule(s);
    }
    function onUp(e) {
      const s = S; if (!s || (s.id != null && e.pointerId !== s.id)) return;
      // the rectangle read shift at the END of the gesture, so this does too: the modifier
      // you are holding when you let go is the one that decides add vs remove.
      const mode = e.shiftKey ? "remove" : "add";
      const keys = [...new Set(s.picked.map(p => p.key))];
      finish(s);
      if (keys.length && o.onCommit) o.onCommit(keys, mode);   // ONE commit for the whole sweep
    }
    function onAbort() { if (S) finish(S); }         // pointercancel: abandon, commit nothing
    function onKey(e) {
      if (!S || e.key !== "Escape") return;
      finish(S);                                     // Esc mid-stroke abandons — nothing is traced
      e.stopPropagation(); e.preventDefault();       // ...and Esc means only that, not the view's escape
    }
    function finish(s) {
      if (s.raf) cancelAnimationFrame(s.raf);
      try { if (s.id != null) node.releasePointerCapture(s.id); } catch (_) {}
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onAbort, true);
      window.removeEventListener("keydown", onKey, true);
      band.attr("d", null); casing.attr("d", null); line.attr("d", null);
      rings.selectAll("circle").remove();
      if (ACTIVE === s) ACTIVE = null;
      if (S === s) S = null;
    }

    // NAMESPACED, so it sits beside the view's own `.on("pointerdown")` instead of replacing
    // it — the view's handler is registered first, sees armed(e), and steps aside.
    svg.on("pointerdown.rwbrush", onDown);

    const api = {
      raise() { g.raise(); return api; },            // keep the trail above later-appended layers
      // the rectangle had to be re-fitted to the plot on every draw; a stroke reads its
      // bounds per gesture, so all this owes the views is the layer still being there —
      // cheap insurance against a redraw that clears the svg out from under it.
      resize() { if (g.node() && g.node().parentNode !== node) node.appendChild(g.node()); return api; },
      clear() { if (S) finish(S); return api; },
      destroy() {
        if (S) finish(S);
        svg.on("pointerdown.rwbrush", null);
        svg.classed("rwbrush-host", false);
        g.remove();
      },
    };
    return api;
  }
  // stroking() — a stroke is in flight. The views hide their hover box for THIS, not for
  // armed(): an armed brush that is only hovering still names the point under it, which is
  // how you aim a dab (Miguel 2026-09-28: the box vanished whenever the switch was on).
  const stroking = () => !!ACTIVE;
  return { mount, armed, stroking };
})();
