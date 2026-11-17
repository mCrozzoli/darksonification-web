// dark_svartsengi · views/zoom.js — zoom and pan for the map and the latent map (V1, Miguel 2026-11-02: "it would be
// great to be able to zoom into this two vis"). W3.
//
// One small helper both views use. Semantic zoom: the view redraws itself from the transform (onZoom), so marks, labels
// and the ear keep their screen size.
//   - the wheel / a trackpad pinch zooms around the pointer (1× … maxK×);
//   - a drag pans once zoomed in. At the full view there is nothing to pan, so a view's own drag gesture (the map's box)
//     keeps working there; panFilter(e) can refuse a drag (e.g. the map's shift-drag box);
//   - on a touch screen two fingers pinch and pan; one finger is left to the page (it scrolls), and a tap still clicks;
//   - double-click or ⟲ returns to the full view; + / − step. Calm: three tiny buttons in a corner, ⟲ only while zoomed.
// Not kept: a reload, or a new view size, starts from where it was or the full view; nothing is stored.
window.SvkZoom = (function () {
  "use strict";
  function attach(el, host, { maxK = 16, onZoom = () => {}, panFilter = () => true, corner = "br" } = {}) {
    let T = d3.zoomIdentity, W = 1, H = 1;
    const sel = d3.select(el);
    const zoom = d3.zoom().scaleExtent([1, maxK])
      .filter((e) => (e.type === "wheel" ? true : e.type.startsWith("touch") ? false : !e.button && !e.ctrlKey && T.k > 1.001 && panFilter(e)))
      .on("zoom", (e) => { T = e.transform; paint(); onZoom(T, e); });
    sel.call(zoom).on("dblclick.zoom", null).on("dblclick.svkzoom", () => reset());
    el.style.touchAction = "pan-x pan-y";                       // one finger scrolls the page; a pinch is ours, not the page zoom's
    const ext = () => [[0, 0], [W, H]];
    const set = (t, ms = 0) => { const c = zoom.constrain()(t, ext(), ext()); (ms ? sel.transition().duration(ms) : sel).call(zoom.transform, c); };
    function reset() { set(d3.zoomIdentity, 250); }
    // two fingers: the world point under their middle stays under it; the spread scales (the page never sees the pinch)
    let pin = null;
    const local = (t) => { const r = el.getBoundingClientRect(); return [t.clientX - r.left, t.clientY - r.top]; };
    const two = (e) => { const a = local(e.touches[0]), b = local(e.touches[1]); return { m: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1 }; };
    el.addEventListener("touchstart", (e) => { if (e.touches.length === 2) { const p = two(e); pin = { T0: T, w: T.invert(p.m), d0: p.d }; } }, { passive: true });
    el.addEventListener("touchmove", (e) => {
      if (!pin || e.touches.length !== 2) return;
      e.preventDefault();
      const p = two(e), k = Math.max(1, Math.min(maxK, pin.T0.k * (p.d / pin.d0)));
      set(d3.zoomIdentity.translate(p.m[0] - k * pin.w[0], p.m[1] - k * pin.w[1]).scale(k));
    }, { passive: false });
    el.addEventListener("touchend", (e) => { if (e.touches.length < 2) pin = null; }, { passive: true });
    el.addEventListener("touchcancel", () => (pin = null), { passive: true });
    // the corner: + − ⟲
    const box = document.createElement("div");
    box.className = `zctl zctl-${corner}`;
    box.innerHTML = `<button data-z="in" title="zoom in (or the wheel / a pinch)">+</button><button data-z="out" title="zoom out">−</button>`
      + `<button data-z="reset" title="back to the full view (or double-click)">⟲</button>`;
    host.appendChild(box);
    box.querySelectorAll("button").forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      const c = [W / 2, H / 2], w = T.invert(c), k = Math.max(1, Math.min(maxK, T.k * (b.dataset.z === "in" ? 2 : 0.5)));
      if (b.dataset.z === "reset") reset(); else set(d3.zoomIdentity.translate(c[0] - k * w[0], c[1] - k * w[1]).scale(k), 200);
    }));
    function paint() { box.querySelector('[data-z="reset"]').style.display = T.k > 1.001 ? "" : "none"; box.classList.toggle("zoomed", T.k > 1.001); }
    paint();
    return {
      get t() { return T; },
      size(w, h) { W = w; H = h; zoom.extent(ext()).translateExtent(ext()); if (T.k > 1.001) set(T); },
      reset,
    };
  }
  return { attach };
})();
