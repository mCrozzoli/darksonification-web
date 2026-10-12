// =============================================================================
//  dark_hugur — web build · runs INSIDE index.html (the desktop page viz/index.html, patched by build_web.py),
//  loaded right after the vendored d3 and before the page's own script (darkpulsar's web_page.js adapted;
//  lab/WEB_P1_DESIGN.md §1.4). Three jobs:
//
//  1. isolation: hosts that cannot send headers (GitHub Pages) get COOP/COEP from a service worker (coi-sw.js),
//     which SuperCollider's WebAssembly build needs for SharedArrayBuffer; the first visit reloads once under it.
//  2. transport + data: window.__darkWeb.socket() is what the patched connect() uses instead of a WebSocket to
//     viz/bridge.py. It looks like one to the page (readyState, send, onmessage): the page's messages (nav, query,
//     legend) go to the in-tab brain (core/hugur_brain.js, owned by engine.js), which plays brain.py's part and
//     delivers state · l1_info · l1_tick · query_result · hello through onmessage exactly as the bridge would.
//     window.__darkWeb.json(path) is the gzip-aware, memoised loader that the page's three data fetches and the
//     brain share, so the brain boots from the SAME sites object the page draws; window.__darkWeb.pageData
//     resolves once those three files are in, and the brain's first two payloads wait for it.
//  3. the engine: loaded as a module once the page is isolated; its class library compiles while the visitor
//     reads the page, and SuperCollider starts at the first click or key press (the site's rule since 2026-09-28).
//     The header chip (#chip, the bridge's connection chip on the desktop) shows the engine's state until the
//     sound runs; then the page's own ws.onopen handler paints "live", exactly as on the desktop.
// =============================================================================
(function () {
  const queue = [];                                   // page → engine messages sent before the engine exists
  let engine = null, opened = false;
  const sock = {                                      // the page's `ws`
    readyState: 1,
    onopen: null, onclose: null, onerror: null, onmessage: null,
    send(json) { if (engine) engine.fromPage(JSON.parse(json)); else queue.push(json); },
    close() {},                                       // never fires onclose: the page's 2.5 s reconnect loop must not start
    // engine → page: the brain's payloads, through the page's own ws.onmessage handler
    deliver(m) { if (typeof this.onmessage === "function") this.onmessage({ data: JSON.stringify(m) }); },
    // the engine's state. The page has chip() reading S.connected (no setConn), so the chip is painted HERE until
    // the sound runs; the first `ready` fires the page's ws.onopen once (S.connected = true, "live", sendSagas),
    // after which the page owns the chip's text — unless the engine falls back to an error.
    // The sidebar's WEB CONTROL label (#wc-state, 250 px panel) echoes the chip's INSTRUCTION: the segment after the
    // last " · " ("SuperCollider · starts at your first click" → "· starts at your first click"); the whole text
    // wrapped the label to two lines and shifted the sidebar (review 2026-10-08; web_pixels.py's header snapshot).
    setChip(text, ready) {
      const chip = document.getElementById("chip"), wc = document.getElementById("wc-state");
      if (!ready || !opened) {
        if (chip) {
          chip.textContent = text;
          chip.title = (engine && engine.error) || "";
          if (opened) chip.classList.remove("live");    // the sound stopped after it had run
        }
        if (wc) wc.textContent = "· " + text.split(" · ").pop();
      }
      if (ready && !opened) { opened = true; if (typeof this.onopen === "function") this.onopen(); }
    },
  };

  // The gzip-aware, memoised loader (ocean's web_bridge.js pattern). These files ship only as .gz (build_web.py GZIP);
  // everything else is a plain fetch. One promise per path: the page and the brain get the same object.
  const GZIPPED = /(^|\/)(sites|tokens|bin|[^/]+\.(tokens|sentences))\.json$/;
  const memo = new Map();
  function json(path) {
    const key = String(path);
    if (!memo.has(key)) {
      const p = GZIPPED.test(key)
        ? fetch(key + ".gz").then((r) => {
            if (!r.ok) throw new Error(`${key}.gz: HTTP ${r.status}`);
            return new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).json();
          })
        : fetch(key).then((r) => { if (!r.ok) throw new Error(`${key}: HTTP ${r.status}`); return r.json(); });
      memo.set(key, p);
      p.then(() => settle(key), (e) => settle(key, e));
    }
    return memo.get(key);
  }
  // pageData: the page's three files requested AND delivered. The brain's hello/state wait for it (engine.js), so
  // they can never reach the page before its `sites = s` — that race exists on the desktop; the web closes it.
  const PAGE_FILES = ["data/meta.json", "data/sites.json", "data/tokens.json"];
  let resolvePage, rejectPage;
  const pageData = new Promise((res, rej) => { resolvePage = res; rejectPage = rej; });
  pageData.catch(() => {});                           // the page reports it (patch 6's text), the engine too
  const landed = new Set();
  function settle(key, err) {
    if (!PAGE_FILES.includes(key)) return;
    if (err) { rejectPage(err); return; }
    landed.add(key);
    if (PAGE_FILES.every((k) => landed.has(k))) {
      Promise.all(PAGE_FILES.map((k) => memo.get(k))).then(([meta, sites, tokens]) => resolvePage({ meta, sites, tokens }));
    }
  }
  // bytes(path): the raw files (the two .f32 vector tables), memoised like json() — the brain's loader.bytes and the
  // text tab share one ArrayBuffer per path (nobody transfers it).
  const bytesMemo = new Map();
  function bytes(path) {
    const key = String(path);
    if (!bytesMemo.has(key)) {
      const p = fetch(key).then((r) => { if (!r.ok) throw new Error(`${key}: HTTP ${r.status}`); return r.arrayBuffer(); });
      p.catch(() => bytesMemo.delete(key));
      bytesMemo.set(key, p);
    }
    return bytesMemo.get(key);
  }

  // ---- P2: the recompute (core/recompute_worker.js, a MODULE worker; lab/WEB_P2_DESIGN.md §5, WEB_PLAN.md §10.3) ----
  // window.__darkWeb.recompute(payload, onProgress) → Promise<result>. payload = the text tab's job ({sagas, lexicon,
  // knobs, layouts, manifest, debug}; dataBase / vendorBase default to data/ and vendor/ beside the page); onProgress
  // gets every {type:"progress", stage, done, total, pct, ms, label} message. The result is the worker's "done"
  // payload (sites, tokens, meta, vecs: Float32Array, siteCount, status, timings, knobs, sagas, vocab, listId, …);
  // result.late.tsne is a Promise of the deferred t-SNE ({coords, layout, label, ms} or null when it was skipped or
  // superseded) — the picture never waits for tsne-js (its measured cost: ≈ 40 s for the two sagas). A newer call
  // supersedes the running one (its promise rejects with e.cancelled === true); recompute.cancel() stops the running
  // one. Cancellation reaches the worker's synchronous loops through a SharedArrayBuffer flag when the page is
  // cross-origin isolated (it is, for SuperCollider), else at the next awaited step.
  const RC = { worker: null, flag: null, seq: 0, jobs: new Map(), sab: false };
  function rcSpawn() {
    if (RC.worker) return RC.worker;
    const w = new Worker(new URL("core/recompute_worker.js", document.baseURI), { type: "module" });
    RC.worker = w;
    if (typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated) {
      RC.flag = new Int32Array(new SharedArrayBuffer(4));
      w.postMessage({ type: "init", cancelFlag: RC.flag.buffer });
    } else w.postMessage({ type: "init" });
    w.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === "ready") { RC.sab = Boolean(m.sab); return; }
      const job = RC.jobs.get(m.jobId);
      if (!job) return;
      if (m.type === "progress") { try { if (typeof job.onProgress === "function") job.onProgress(m); } catch (e) { console.warn(e); } }
      else if (m.type === "warn") console.warn("[recompute]", m.text);
      else if (m.type === "done") {
        const pending = m.late && m.late.tsne === "pending";
        const lateTsne = pending ? new Promise((res, rej) => { job.late = { res, rej }; }) : Promise.resolve(null);
        lateTsne.catch(() => {});
        m.late = { ...(m.late || {}), tsne: lateTsne };
        job.resolve(m);
        if (!pending) RC.jobs.delete(m.jobId);
      }
      else if (m.type === "tsne") { if (job.late) job.late.res(m.tsne); RC.jobs.delete(m.jobId); }
      else if (m.type === "cancelled") {
        if (m.late) { if (job.late) job.late.res(null); }
        else { const e = new Error("cancelled"); e.cancelled = true; job.reject(e); }
        RC.jobs.delete(m.jobId);
      }
      else if (m.type === "error") {
        const e = new Error(m.message || "recompute failed"); e.stage = m.stage;
        if (m.late) { if (job.late) job.late.rej(e); } else job.reject(e);
        RC.jobs.delete(m.jobId);
      }
    };
    w.onerror = (ev) => {                              // the worker itself failed (a module error): everything pending fails, a fresh one next time
      const e = new Error("recompute worker failed: " + ((ev && ev.message) || "error"));
      for (const job of RC.jobs.values()) { if (!job.settled) job.reject(e); else if (job.late) job.late.rej(e); }
      RC.jobs.clear();
      try { w.terminate(); } catch (_) {}
      RC.worker = null; RC.flag = null;
    };
    return w;
  }
  function rcSupersede(reason) {
    for (const [id, job] of RC.jobs) {
      if (!job.settled) { const e = new Error(reason); e.cancelled = true; job.reject(e); }
      else if (job.late) job.late.res(null);
      RC.jobs.delete(id);
    }
  }
  function recompute(payload, onProgress) {
    const w = rcSpawn();
    const jobId = ++RC.seq;
    rcSupersede("cancelled: superseded by a newer recompute");
    if (RC.flag) Atomics.store(RC.flag, 0, jobId);
    const p = payload || {};
    const msg = { ...p, type: "recompute", jobId,
      dataBase: new URL(p.dataBase || "data/", document.baseURI).href,
      vendorBase: new URL(p.vendorBase || "vendor/", document.baseURI).href };
    return new Promise((resolve, reject) => {
      const job = { settled: false, onProgress, late: null,
        resolve: (r) => { job.settled = true; resolve(r); }, reject: (e) => { job.settled = true; reject(e); } };
      RC.jobs.set(jobId, job);
      w.postMessage(msg);
    });
  }
  recompute.cancel = () => {
    if (RC.flag) Atomics.store(RC.flag, 0, 0);
    if (RC.worker) RC.worker.postMessage({ type: "cancel" });
    rcSupersede("cancelled");
  };
  recompute.evict = (sagas) => { if (RC.worker) RC.worker.postMessage({ type: "evict", sagas: Array.from(sagas || []) }); };
  Object.defineProperty(recompute, "state", { get: () => ({ worker: Boolean(RC.worker), sab: RC.sab, pending: RC.jobs.size, seq: RC.seq }) });

  // engineReady: the in-tab engine (and its brain) once engine.js is imported; null when the page is not isolated or
  // the import failed (the page is silent then; the recompute still works). The text tab's apply awaits it, then the
  // brain's queryReady, before rebuilding (PORTING_LOG §5.7 F4).
  let resolveEngine;
  const engineReady = new Promise((res) => { resolveEngine = res; });
  window.__darkWeb = {
    socket() { return sock; },
    json,
    bytes,
    pageData,
    recompute,                                        // P2: the in-tab recompute (the text tab's apply)
    engineReady,
    text: null,                                       // the P2 text tab mounts its API here (viz/index.html textTabBoot)
  };

  let reloading = false;
  async function isolate() {
    if (self.crossOriginIsolated || !("serviceWorker" in navigator)) { sessionStorage.removeItem("darkHugurCoi"); return; }
    await navigator.serviceWorker.register("./coi-sw.js");
    if (!sessionStorage.getItem("darkHugurCoi")) {       // first visit: reload once under the service worker
      sessionStorage.setItem("darkHugurCoi", "1");
      await navigator.serviceWorker.ready;
      reloading = true;
      location.reload();
    }
  }
  async function start() {
    await isolate();
    if (reloading) return;
    if (!self.crossOriginIsolated) {
      sock.setChip("this browser did not allow SharedArrayBuffer · the page is silent", false);
      resolveEngine(null);
      return;
    }
    const { darkEngine } = await import("./engine.js");
    window.darkEngine = darkEngine;
    engine = darkEngine;
    resolveEngine(darkEngine);
    darkEngine.attachPage(sock, window);
    for (const json of queue.splice(0)) darkEngine.fromPage(JSON.parse(json));
    darkEngine.preload().catch(() => {});             // compile the class library now; sound starts at the first gesture
  }
  function onReady() {
    start().catch((e) => { console.error(e); resolveEngine(null); sock.setChip("sound did not start · reload the page to try again", false); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", onReady); else onReady();
})();
