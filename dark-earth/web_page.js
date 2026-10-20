// =============================================================================
//  dark_svartsengi — web build · runs INSIDE view/index.html (the desktop page viz/index.html, patched by
//  build/build_web.py), loaded before the page's own app.js in the place of the desktop's dev_mock/fake_engine.js.
//  Hand-written. Three jobs:
//
//  1. isolation: hosts that cannot send headers (GitHub Pages) get COOP/COEP from a service worker (../coi-sw.js,
//     scoped to web_implementation/, so engine/ is inside it: dark_ocean PORTING_LOG §2 gotcha 3), which
//     SuperCollider's WebAssembly build needs for SharedArrayBuffer; the first visit reloads once under it, before
//     any engine exists (rule A11 is about the document that owns a running engine: that one never reloads).
//  2. transport: window.__darkWeb.socket() is what the patched cook.js BridgeTransport opens instead of a WebSocket
//     to viz/bridge.py. It looks like one to the page (readyState, send, onopen, onmessage). Page messages go to the
//     in-tab engine (engine.js plays bridge.py's part); the Ground ring blocks arrive through sock.setn(), the
//     engine's own upload (the desktop's local {type:"setn"} carrier, base64 over the WebSocket, is not needed).
//     The socket OPENS when SuperCollider is ready, as a bridge with SC behind it would; before that the engine
//     drops what the page sends (the page replays its state on open, and on SC's own /svk_ready "cook").
//  3. the engine: loaded as a module once the page is isolated; its class library compiles while the visitor
//     reads the page, and SuperCollider starts at the first click or key press (the site's rule since 2026-09-28).
// =============================================================================
(function () {
  "use strict";
  const BASE = document.currentScript ? new URL("./", document.currentScript.src) : new URL("../", location.href);   // web_implementation/
  const COI_KEY = "darkSvartsengiCoi";
  let engine = null, unavailable = false;
  const sock = {                                      // the page's `ws` (one per document: the page opens it once)
    readyState: 1,                                    // OPEN from the start, so the page never queues stale messages
    onopen: null, onclose: null, onerror: null, onmessage: null,
    claimed: false, opened: false, openPending: false,
    send(json) {
      if (!engine) return;
      let m; try { m = JSON.parse(json); } catch (_) { return; }
      engine.fromPage(m);
    },
    setn(bufnum, ringOff, f32) { if (engine) engine.upload(bufnum, ringOff, f32); },
    close() {},
    // engine → page
    deliver(m) { if (typeof this.onmessage === "function") this.onmessage({ data: JSON.stringify(m) }); },
    // the engine is ready: SC's own first replies (held while it booted), then the socket's open event. Called from
    // engine.js's start(), a promise job (never inside a SuperCollider callback), so the page may answer at once.
    open(held) {
      if (!this.claimed) { this.openPending = held || []; return; }
      for (const m of held || []) this.deliver(m);
      if (!this.opened) {
        this.opened = true;
        if (typeof this.onopen === "function") this.onopen({});
      }
    },
  };
  window.__darkWeb = {
    socket() {
      sock.claimed = true;
      if (sock.openPending) { const h = sock.openPending; sock.openPending = false; setTimeout(() => sock.open(h), 0); }   // after the caller set its handlers
      return sock;
    },
    status() {
      if (engine) return engine.statusText();
      return unavailable ? "this browser did not allow SharedArrayBuffer · display only, no sound" : "loading SuperCollider…";
    },
    engine: () => engine,
  };

  let reloading = false;
  async function isolate() {
    if (self.crossOriginIsolated || !("serviceWorker" in navigator)) { try { sessionStorage.removeItem(COI_KEY); } catch (_) {} return; }
    await navigator.serviceWorker.register(new URL("coi-sw.js", BASE).href);
    let tried = null; try { tried = sessionStorage.getItem(COI_KEY); } catch (_) {}
    if (!tried) {                                    // first visit: reload once under the service worker
      try { sessionStorage.setItem(COI_KEY, "1"); } catch (_) {}
      await navigator.serviceWorker.ready;
      reloading = true;
      location.reload();
    }
  }
  async function start() {
    if (new URLSearchParams(location.search).get("engine") === "off") return;   // the page's silent mode: no engine at all
    await isolate();
    if (reloading) return;
    if (!self.crossOriginIsolated) {
      unavailable = true;
      sock.deliver({ type: "status", status: "engine-unavailable" });   // the page repaints its engine chip
      return;
    }
    const { darkEngine } = await import(new URL("engine.js", BASE).href);
    window.darkEngine = darkEngine;
    engine = darkEngine;
    darkEngine.attachPage(sock, window);
    darkEngine.preload().catch(() => {});             // compile the class library now; sound starts at the first gesture
  }
  start().catch((e) => console.error("[web] engine could not load", e));
})();
