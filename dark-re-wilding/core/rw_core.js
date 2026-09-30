// =============================================================================
//  dark_re_wilding — web build · the bridge core: viz/bridge.py running in Pyodide, in this tab
//  (WEB_PLAN.md §3.3 route A, D2; Phase 0 proof: lab/PORTING_LOG.md §2.1)
//
//  Loads Pyodide (vendored in ../pyodide/ when present, else the pinned CDN build), writes the
//  design's bridge.py, the glue (rw_web.py), the baked rows/returner/raw series and the sound tables
//  into Pyodide's file system, boots the core, then hands page messages to rw_web.handle(). Python
//  answers through three callbacks: sendOsc (typed args), deliver (to one page), broadcast.
//  Messages that arrive before the core is ready are queued in order.
// =============================================================================
const PYODIDE_VERSION = "314.0.7";
const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
// build_web.py writes core/pyodide_base.js: "../pyodide/" when the runtime is vendored beside this folder
// (the published build, D8), null in development (the pinned CDN build; every file carries CORP headers).
import { PYODIDE_BASE } from "./pyodide_base.js";

const gunzipText = (r) => new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text();

export class RwCore {
  constructor(hooks) {
    this.hooks = hooks;                         // { osc(addr, typedArgs), deliver(client, msg), broadcast(msg), post(text) }
    this.ready = false;
    this.error = null;
    this.queue = [];
    this.timing = {};
  }

  post(t) { try { this.hooks.post && this.hooks.post(t); } catch (_) {} }

  async pyodideBase(coreDir) {
    return PYODIDE_BASE ? new URL(PYODIDE_BASE, coreDir).href : CDN;
  }

  // dataDir: .../data/ (build_data.py's output) · coreDir: .../core/
  async load(dataDir, coreDir) {
    if (this._load) return this._load;
    this._load = (async () => {
      const t0 = performance.now();
      const base = await this.pyodideBase(coreDir);
      const { loadPyodide } = await import(base + "pyodide.mjs");
      const py = (this.py = await loadPyodide({ indexURL: base, stdout: (t) => this.post(t), stderr: (t) => this.post("stderr: " + t) }));
      this.timing.pyodide_ms = Math.round(performance.now() - t0);

      const files = [                            // [url, path in Pyodide's FS] — bridge.py's paths: viz/ and dev/data/
        [new URL("bridge.py", coreDir), "/rw/viz/bridge.py", false],
        [new URL("rw_web.py", coreDir), "/rw/core/rw_web.py", false],
        [new URL("core/rows_air.json.gz", dataDir), "/rw/data/rows_air.json", true],
        [new URL("core/rows_water.json.gz", dataDir), "/rw/data/rows_water.json", true],
        [new URL("core/returner.json.gz", dataDir), "/rw/data/returner.json", true],
        [new URL("core/raw_series.json.gz", dataDir), "/rw/data/raw_series.json", true],
      ];
      for (const tch of ["air", "water"]) {
        const sub = tch === "air" ? "" : "water/";
        for (const k of ["L0_gradient", "L0_variance", "L1_gradient", "L1_variance"])
          files.push([new URL(`core/tables/${tch}/rw_tables_${k}.json.gz`, dataDir), `/rw/dev/data/${sub}rw_tables_${k}.json`, true]);
        for (const l of ["L0", "L1"])
          files.push([new URL(`core/push/${tch}/rw_push_${l}.json.gz`, dataDir), `/rw/dev/data/${sub}rw_push_${l}.json`, true]);
      }
      const t1 = performance.now();
      const texts = await Promise.all(files.map(([u, , gz]) => fetch(u).then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${u}`);
        return gz ? gunzipText(r) : r.text();
      })));
      for (const d of ["/rw/viz", "/rw/core", "/rw/data", "/rw/dev/data/water"]) py.FS.mkdirTree(d);
      files.forEach(([, p], k) => py.FS.writeFile(p, texts[k]));
      this.timing.files_ms = Math.round(performance.now() - t1);
      this.timing.files_MB = +(texts.reduce((n, t) => n + t.length, 0) / 1e6).toFixed(1);

      const t2 = performance.now();
      py.globals.set("rw_js", {
        sendOsc: (addr, json) => this.hooks.osc(addr, JSON.parse(json)),
        deliver: (client, json) => this.hooks.deliver(client, JSON.parse(json)),
        broadcast: (json) => this.hooks.broadcast(JSON.parse(json)),
      });
      py.runPython('import sys; sys.path.insert(0, "/rw/core"); import rw_web; rw_web.rw_js = rw_js');
      this.mod = py.pyimport("rw_web");
      this.booted = JSON.parse(this.mod.boot());
      this.timing.boot_ms = Math.round(performance.now() - t2);
      this.timing.total_ms = Math.round(performance.now() - t0);
      this.ready = true;
      for (const [name, args] of this.queue.splice(0)) this.call(name, ...args);
    })().catch((e) => { this.error = e; this.post("core failed: " + e.message); throw e; });
    return this._load;
  }

  call(name, ...args) {
    if (!this.ready) { this.queue.push([name, args]); return; }
    try { return this.mod[name](...args); }
    catch (e) { this.post(`core ${name} failed: ${e.message}`); console.error(e); }
  }
  handle(client, msg) { this.call("handle", client, JSON.stringify(msg)); }
  clientNew(client) { this.call("client_new", client); }
  clientGone(client) { this.call("client_gone", client); }
  replay() { this.call("replay"); }
  state() { return this.ready ? JSON.parse(this.mod.state()) : null; }
}
