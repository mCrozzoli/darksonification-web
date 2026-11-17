// =============================================================================
//  darkpulsar — web build · runs INSIDE index.html (the desktop page viz/index.html, patched by build_web.py),
//  loaded right after d3 and before the page's own script, in the place of web_control.js (the darkui GUI link,
//  which does not exist on the web). Three jobs:
//
//  1. isolation: hosts that cannot send headers (GitHub Pages) get COOP/COEP from a service worker (coi-sw.js),
//     which SuperCollider's WebAssembly build needs for SharedArrayBuffer; the first visit reloads once under it.
//  2. transport: window.__darkWeb.socket() is what the patched connect() uses instead of a WebSocket to
//     viz/bridge.py. It looks like one to the page (readyState, send, onmessage): the page's messages
//     (navsound, legend, master) go to the in-tab SuperCollider engine (engine.js), which plays bridge.py's part,
//     and the engine delivers the `init` message through onmessage exactly as the bridge would.
//  3. the engine: loaded as a module once the page is isolated; its class library compiles while the visitor
//     reads the page, and SuperCollider starts at the first click or key press (the site's rule since 2026-09-28).
//     The header chip (#chip, the bridge's connection chip on the desktop) shows the engine's state.
// =============================================================================
(function () {
  const queue = [];                                   // page → engine messages sent before the engine exists
  let engine = null, resolveEngine;
  const engineReady = new Promise((r) => { resolveEngine = r; });
  const sock = {                                      // the page's `ws`
    readyState: 1,
    onopen: null, onclose: null, onerror: null, onmessage: null,
    send(json) { if (engine) engine.fromPage(JSON.parse(json)); else queue.push(json); },
    close() {},
    // engine → page
    deliver(m) { if (typeof this.onmessage === "function") this.onmessage({ data: JSON.stringify(m) }); },
    setChip(cls, text) { if (typeof window.setConn === "function") window.setConn(cls, text); },
  };
  window.__darkWeb = {
    socket() { return sock; },
    profiles() { return engineReady.then((e) => e.profilesReady); },   // Float32Array, 1297 × 1024, decoded once
  };

  let reloading = false;
  async function isolate() {
    if (self.crossOriginIsolated || !("serviceWorker" in navigator)) { sessionStorage.removeItem("darkPulsarCoi"); return; }
    await navigator.serviceWorker.register("./coi-sw.js");
    if (!sessionStorage.getItem("darkPulsarCoi")) {        // first visit: reload once under the service worker
      sessionStorage.setItem("darkPulsarCoi", "1");
      await navigator.serviceWorker.ready;
      reloading = true;
      location.reload();
    }
  }
  async function start() {
    await isolate();
    if (reloading) return;
    if (!self.crossOriginIsolated) {
      sock.setChip("disconnected", "this browser did not allow SharedArrayBuffer · the page is silent");
      return;
    }
    const { darkEngine } = await import("./engine.js");
    window.darkEngine = darkEngine;
    engine = darkEngine;
    darkEngine.attachPage(sock, window);
    for (const json of queue.splice(0)) darkEngine.fromPage(JSON.parse(json));
    resolveEngine(darkEngine);
    darkEngine.preload().catch(() => {});              // compile the class library now; sound starts at the first gesture
  }
  function onReady() {
    for (const id of ["ctl", "side-gui"]) {              // the darkui GUI's chip / state line: meaningless on the web
      const el = document.getElementById(id);
      if (el) el.style.display = "none";
    }
    start();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", onReady); else onReady();
})();
