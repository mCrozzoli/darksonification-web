// =============================================================================
//  dark_re_wilding — web build · runs INSIDE each view (view/*.html, the desktop pages copied by
//  build_web.py), loaded right after d3 and before the page's own script.
//
//  The page keeps every line of its WebSocket code; only `new WebSocket(...)` is replaced by the
//  socket below (build_web.py patch): readyState 1, send() goes to the engine in the parent shell,
//  the engine's messages arrive through onmessage exactly as the bridge's frames did. Replies whose
//  type starts with "legend_" are also handed to LEG.onBridge (the page never forwards them; on the
//  desktop legend.js sniffs them off WebSocket.prototype, which a fake socket bypasses).
//  The header chip shows the engine's state until the sound runs, then the page's own text.
//  The shell's address bar follows this view (?view=…&m=…&d=…) so a copied link reopens it.
//  Opened on its own (no shell), the page draws nothing — every dataset comes from the shell.
// =============================================================================
(function () {
  let engine = null;
  try { engine = window.parent !== window ? window.parent.darkEngine || null : null; } catch (_) { engine = null; }

  if (engine) {                                            // address bar: this view, this month/day
    try {
      const me = location.pathname.split("/").pop().replace(/\.html$/, "");
      const q = new URLSearchParams(location.search), out = new URLSearchParams();
      out.set("view", me === "index" ? "scatter" : me);
      for (const k of ["m", "d"]) if (q.get(k)) out.set(k, q.get(k));
      window.parent.history.replaceState(null, "", window.parent.location.pathname + "?" + out.toString() + location.hash);
      if (document.title) window.parent.document.title = document.title;
    } catch (_) {}
  }

  window.__darkWeb = engine ? {
    socket() {
      let lastPage = null, entry = null;
      const chip = () => document.getElementById("chip");
      const orig = window.setConn;                          // the page's own chip painter (declared before connect() runs)
      const paintPage = () => { if (orig && lastPage) orig(...lastPage); };
      if (orig && !orig.__web) {
        const w = (st, text) => { lastPage = [st, text]; if (engine.state === "ready") orig(st, text); };
        w.__web = true; window.setConn = w;
      }
      const sock = {
        readyState: 1, onopen: null, onclose: null, onerror: null, onmessage: null,
        send(json) { if (entry) engine.fromPage(entry, JSON.parse(json)); },
        close() {},
      };
      entry = engine.attachPage({
        deliver(m) {
          if (m && typeof m.type === "string" && m.type.indexOf("legend_") === 0 && window.LEG && LEG.onBridge) LEG.onBridge(m);
          if (sock.onmessage) sock.onmessage({ data: JSON.stringify(m) });
        },
        setChip(text, on) {                                  // the engine's state, or the page's text once it sounds
          const c = chip(); if (!c) return;
          if (on || text == null) { paintPage(); return; }
          c.className = "waiting"; c.textContent = text; c.title = engine.error || "";
        },
      }, window);
      setTimeout(() => { if (sock.onopen) sock.onopen(); engine.pageOpened(entry); }, 0);
      return sock;
    },
    pending() { return engine.pendingText(); },
    withAudio(stream) { const t = engine.audioTrack(); if (t) stream.addTrack(t); return stream; },
  } : null;
})();
