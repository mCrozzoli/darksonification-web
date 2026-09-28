// =============================================================================
//  dark_ocean — web build · runs INSIDE view/map.html (the desktop page, copied by build_web.py),
//  loaded right after d3 and before the page's own script.
//
//  1. data: the big JSON files are stored gzipped (GitHub Pages' 1 GB limit); d3.json fetches the
//     .gz and decompresses it here, and drops the page's "?_=<time>" cache-busters so browsers cache.
//  2. transport: exposes window.__darkWeb, which the patched connectBridge() uses instead of a
//     WebSocket. Messages go to the SuperCollider engine in the parent shell page (engine.js).
//  3. keeps the shell's address bar in step with this view, so a copied link reopens it.
//  Opened on its own (no shell), the map still works, silently.
// =============================================================================
(function () {
  let engine = null;
  try { engine = window.parent !== window ? window.parent.darkEngine || null : null; } catch (_) { engine = null; }

  const GZIPPED = /(^|\/)(cube_time|map_time|daily\/daily_\d{4}-\d{2})\.json$/;
  const d3json = d3.json;
  d3.json = function (url, init) {
    const clean = String(url).replace(/\?_=\d+$/, "");
    if (!GZIPPED.test(clean)) return d3json.call(this, clean, init);
    return fetch(clean + ".gz", init).then((r) => {
      if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${clean}.gz`);
      return new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).json();
    });
  };

  if (engine) {
    try { window.parent.history.replaceState(null, "", window.parent.location.pathname + location.search + location.hash); } catch (_) {}
  }

  window.__darkWeb = engine ? {
    attach(page) { engine.attachPage(page, window); },
    withAudio(stream) {
      const track = engine.audioTrack();
      if (track) stream.addTrack(track);
      return stream;
    },
  } : null;
})();
