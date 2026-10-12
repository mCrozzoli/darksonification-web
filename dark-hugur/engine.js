// =============================================================================
//  dark_hugur — web build · the sound engine (lives in index.html, the design's own page, patched by build_web.py)
//
//  SuperCollider's own WebAssembly build runs sclang AND scsynth in this tab. sclang runs the design's own
//  sc/hugur_synths.scd (fork-wrapped, 0 substitutions) and sc/parse_hugur.scd (unmodified), so the six SynthDefs,
//  the cooking (~applyDrivers) and the nine OSCdefs are the desktop design's code, not a translation. Before them,
//  one web-only file, sc/web_boot.scd (the server options), replaces sc/hugur_boot.scd, whose path idioms have no
//  meaning in a tab. There are no buffers, tables or sound files in this design (lab/WEB_P1_DESIGN.md §1.3.2).
//
//  Around SuperCollider this file plays the part of viz/bridge.py AND of the process boundary around brain.py:
//    · the brain itself is core/hugur_brain.js (HugurBrain, lab/WEB_P1_DESIGN.md §2): brain.py's thirteen nav
//      commands, the query, the legend and the level machine. It runs from the page's first message whether or
//      not SuperCollider is up — the page's state machine never waits for sound (B2.21 dual mode);
//    · the brain's OSC (hooks.osc) goes into sclang with sclang.sendOsc() → the design's OSCdefs, but only while
//      SuperCollider is `ready`; replay() re-establishes master, mute, level, the current site's drivers and a
//      held legend preview on a (re)start;
//    · the brain's payloads to the page (hooks.deliver: state, hello, l1_info, l1_tick, query_result) go through
//      the page's socket (web_page.js) ONE MACROTASK LATER, as the desktop's wire would deliver them — never
//      synchronously inside the page's own send(): the page arms its 2.5 s surface fallback AFTER send()
//      (viz/index.html query()), so a synchronous query_result would be overwritten by it;
//    · the bridge's two sticky messages (state, then hello: its STICKY order) wait until the page has its data
//      (__darkWeb.pageData), and EVERY page message is held until the brain has all its tables — the query assets
//      included (brain.queryLoaded) — so the message order is the desktop's even while they download.
//  Differences, because this is a browser: a page plays nothing before the visitor's first gesture, so SuperCollider
//  starts on the first click or key press anywhere in the page (the site's rule since 2026-09-28). hugur's SC sends
//  nothing back (no SendReply), so onOscReply only feeds sclang. The /notify guard and the retired-pair restart are
//  dark_ocean's (its PORTING_LOG §6).
// =============================================================================
import { oscMessage, f, i, s } from "./osc.js";
import { HugurBrain } from "./core/hugur_brain.js";

const ENGINE_DIR = new URL("./engine/", import.meta.url);
const SC_DIR = new URL("./sc/", import.meta.url);
const DATA_DIR = new URL("./data/", import.meta.url);   // the brain reads data/ through window.__darkWeb (shared with the page)
const SC_FILES = ["web_boot.scd", "hugur_synths.scd", "parse_hugur.scd"];
// parse_hugur.scd has run: its first and its last OSCdef exist, and the three persistent voices were spawned
const PARSE_READY = "OSCdef.all[\\hugurDrivers].notNil and: { OSCdef.all[\\hugurMute].notNil and: { ~synths[\\whisper].notNil } }";

// This build's scsynth.getWorkletNode() throws (ocean PORTING_LOG §2, gotcha 2), so remember whichever
// AudioWorkletNode connects to the speakers: that is scsynth. (Guarded so the module also loads in Node for a smoke test.)
const toDestination = [];
const nativeConnect = typeof AudioNode !== "undefined" ? AudioNode.prototype.connect : null;
if (nativeConnect) {
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode) toDestination.push(this);
    return nativeConnect.call(this, dest, ...rest);
  };
}

// OSC packets as bytes, and the two the engine must recognise on the sclang → scsynth wire.
const asBytes = (p) => (p instanceof Uint8Array ? p : new Uint8Array(p.buffer || p));
const head = (p, n) => { const b = asBytes(p); let t = ""; for (let k = 0; k < Math.min(n, b.length); k++) t += String.fromCharCode(b[k]); return t; };
function notifyFlag(p) {                          // "/notify\0" ",i…" + int32 flag → the flag; anything else → null
  const b = asBytes(p);
  if (b.length < 16 || head(b, 8) !== "/notify\0" || !head(b, 10).endsWith(",i")) return null;
  return (b[12] << 24) | (b[13] << 16) | (b[14] << 8) | b[15];
}
const isDoneNotify = (p) => /^\/done\0+,s[^\0]*\0+\/notify\0/.test(head(p, 32));

// The header chip (#chip: the bridge's connection chip on the desktop): text per engine state. web_page.js paints it
// until the first `ready`, which fires the page's own ws.onopen → its chip() paints "live" (the gates read that).
const CHIP = {
  loading: "loading SuperCollider…",
  idle: "SuperCollider · starts at your first click",
  booting: "starting SuperCollider…",
  ready: "SuperCollider · in this tab",
  error: "sound did not start · reload the page to try again",
};

class DarkEngine {
  constructor() {
    this.state = "loading";
    this.error = null;
    this.sock = null;                             // the page's socket (web_page.js)
    this.log = [];                                // last post-window lines: darkEngine.log
    this.watchers = [];
    this.attempt = 0;                             // start attempts; a superseded attempt stops at its next step
    this.bootAllowed = 0;                         // the attempt whose sclang may boot scsynth (window.bootServer)
    this.inbox = [];                              // page messages held until the brain has ALL its tables (brain.queryLoaded); answered in order
    this.outbox = [];                             // brain payloads waiting for the page (its data, then one macrotask)
    this.pageReady = false;                       // window.__darkWeb.pageData resolved
    this.hold = null;                             // the legend preview still held (iso | site | solo), for replay()
    this.HugurBrain = HugurBrain;                 // for the gates: darkEngine.HugurBrain.fromData(darkEngine.brain.data, hooks)
    // The brain runs from the first message; its OSC reaches sclang only while SuperCollider is ready (replay() covers
    // the rest), its payloads reach the page through deliver() below.
    this.brain = new HugurBrain({
      osc: (addr, args) => {
        const ready = this.state === "ready";
        this.trace(ready ? "»" : "×", addr, args);
        if (ready) this.send(addr, args);
      },
      deliver: (m) => this.deliver(m),
      now: () => performance.now() / 1000,
      timer: (ms, fn) => setTimeout(fn, ms),
    });
    if (typeof window !== "undefined") {          // scsynth dying in a worker surfaces here too (see instantiate)
      window.addEventListener("error", (ev) => {
        const where = String(ev.filename || (ev.error && ev.error.filename) || "");
        if (this.crash && where.includes("/engine/scsynth.js")) this.crash(new Error(`scsynth stopped: ${ev.message}`));
      });
    }
  }

  // ------------------------------------------------------------------ status
  setState(state, error) {
    this.state = state;
    if (error) this.error = error;
    this.paintChip();
  }
  paintChip() {
    const text = CHIP[this.state] || this.state;
    if (this.sock) { try { this.sock.setChip(text, this.state === "ready"); } catch (_) {} }
  }
  // The first click or key press anywhere in the page starts SuperCollider (a browser plays nothing before it).
  firstGesture() {
    if (this._boot || this.state === "error") return;
    this.boot();
  }

  // ------------------------------------------------------------------ post window
  post(src, text) {
    for (const line of String(text).split("\n")) {
      if (!line) continue;
      this.log.push(`[${src}] ${line}`);
      if (this.log.length > 800) this.log.splice(0, this.log.length - 800);
      if (/ERROR|FAILURE|not installed/.test(line)) console.warn(`[SuperCollider] ${line}`);
      for (const w of [...this.watchers]) {
        if (w.re.test(line)) { this.watchers.splice(this.watchers.indexOf(w), 1); w.resolve(line); }
      }
    }
  }
  until(re, ms) {
    return new Promise((resolve, reject) => {
      const w = { re, resolve };
      this.watchers.push(w);
      setTimeout(() => {
        const k = this.watchers.indexOf(w);
        if (k >= 0) { this.watchers.splice(k, 1); reject(new Error(`timed out waiting for ${re}`)); }
      }, ms);
    });
  }
  // Ask sclang a question until it answers "true". Readiness is read from SuperCollider's own state,
  // never from the wording of its post lines (the design is free to reword those).
  async poll(expr, ms, every = 300, alive = () => true) {
    const end = performance.now() + ms;
    for (;;) {
      if (!alive()) throw new Error("superseded by a fresh SuperCollider");
      const tag = "DW" + Math.random().toString(36).slice(2, 8);
      const answer = this.until(new RegExp(`^${tag} (true|false)$`), every + 500).then((l) => l.endsWith("true"), () => false);
      try { this.sclang.runCode(`("${tag} " ++ (${expr}).asBoolean).postln;`); } catch (_) {}
      if (await answer) return;
      if (performance.now() > end) throw new Error(`SuperCollider never reported: ${expr}`);
      await new Promise((r) => setTimeout(r, every));
    }
  }
  async query(expr, ms = 4000) {                 // one value from sclang, as the string it prints
    const tag = "DQ" + Math.random().toString(36).slice(2, 8);
    const w = this.until(new RegExp(`^${tag} `), ms);
    this.sclang.runCode(`("${tag} " ++ (${expr}).asString).postln;`);
    return (await w).slice(tag.length + 1);
  }

  // ------------------------------------------------------------------ load (no audio yet)
  // One SuperCollider = one sclang + one scsynth instance wired only to each other, so a retired pair
  // (after a failed start, below) can never reach the fresh one.
  async instantiate() {
    const locateFile = (p) => new URL(p, ENGINE_DIR).href;   // sclang.data would otherwise resolve against the page
    const [{ default: ScSynth }, { default: ScLang }] = await Promise.all([
      import(new URL("scsynth.js", ENGINE_DIR).href), import(new URL("sclang.js", ENGINE_DIR).href),
    ]);
    let synth = null;
    const live = () => synth !== null && this.scsynth === synth;
    const printErr = (t) => {                                       // Emscripten's error channel: a worker dying
      console.error(t);
      if (!/worker sent an error/.test(t) || !live()) return;
      if (this.crash) this.crash(new Error(`scsynth stopped: ${t}`));
      else if (this.state === "ready") this.setState("error", `scsynth stopped: ${t}`);
    };
    synth = await ScSynth({ locateFile, printErr });
    this.scsynth = synth;
    const lang = await ScLang({ locateFile });
    this.sclang = lang;
    lang.printCallback = (t) => { if (live()) this.post("lang", t); };
    synth.onStdout = (t) => { if (live()) this.post("synth", t); };
    synth.onPrint = (t) => { if (live()) this.post("synth", t); };
    // THE SECOND /notify (ocean PORTING_LOG §6): this scsynth build dies on a repeated registration; a repeat is
    // answered here with scsynth's own first reply.
    let registered = false, notifyReply = null;
    lang.onOsc = (osc) => {                                         // sclang → scsynth
      if (!live()) return;
      this.trace("→", osc);
      const n = notifyFlag(osc);
      if (n === 1) {
        if (registered) {
          this.post("web", "a repeated /notify from sclang answered by the page (it stops this scsynth)");
          if (notifyReply) lang.sendOsc(notifyReply.slice());
          return;
        }
        registered = true;
      } else if (n === 0) registered = false;
      synth.sendOsc(osc);
    };
    synth.onOscReply = (r) => {                                     // scsynth → sclang (nothing here is for the page)
      if (!live()) return;
      this.trace("←", r);
      if (!notifyReply && isDoneNotify(r)) notifyReply = asBytes(r).slice();
      lang.sendOsc(r);
    };
    window.bootServer = (opts) => {               // Server:bootServerApp calls this. ONE global for every sclang,
      if (this.bootAllowed !== this.attempt) return;   // so only the running attempt may boot, once
      this.bootAllowed = 0;
      setTimeout(() => { if (live()) synth.boot(opts); }, 100);
    };
    lang.bootInterpreter();
    await this.poll("true", 45000, 400);                            // the interpreter answers = class library compiled
  }
  async loadData() {                              // the brain's tables, through the loader the page shares (§4.1)
    const web = typeof window !== "undefined" ? window.__darkWeb : null;
    if (!web || typeof web.json !== "function") throw new Error("window.__darkWeb is missing (web_page.js loads before engine.js)");
    web.pageData.then(() => { this.pageReady = true; this.pump(); }, () => {});
    await this.brain.load(web);
    if (!this.brain.loaded) throw new Error("the brain did not report loaded after load()");
    this.brain.announce();                        // state, then hello (brain.py main() push_state(); bridge.py STICKY order) — held in the outbox until pageData
    this.brain.queryReady.then(() => this.flushInbox());   // what the page said while the tables were downloading: in order, once ALL of them are in
    this.pump();
  }
  preload() {
    if (this._preload) return this._preload;
    this._preload = (async () => {
      if (!self.crossOriginIsolated) throw new Error("this browser did not allow SharedArrayBuffer");
      const code = Promise.all(SC_FILES.map((n) => fetch(new URL(n, SC_DIR)).then((r) => {
        if (!r.ok) throw new Error(`${n}: HTTP ${r.status}`);
        return r.text();
      })));
      await Promise.all([this.instantiate(), this.loadData(), code.then((c) => { this.code = c; })]);
      this.setState("idle");
    })().catch((e) => { console.error(e); this.setState("error", e.message); throw e; });
    return this._preload;
  }

  // ------------------------------------------------------------------ boot (a user gesture asked for sound)
  boot() {
    if (this._boot) return this._boot;
    this._boot = (async () => {
      await this.preload();
      for (let attempt = 1; ; attempt++) {
        try { await this.start(); return; }
        catch (e) {
          if (attempt >= 2) throw e;
          console.warn(`[dark_hugur] SuperCollider did not start (${e.message}); starting a fresh one`);
          this.retire();
          await this.instantiate();
        }
      }
    })().catch((e) => { console.error(e); this.setState("error", e.message); });
    return this._boot;
  }
  start() {                                       // one attempt: boot → synths → parser → state
    const my = ++this.attempt, alive = () => this.attempt === my;
    return new Promise((resolve, reject) => {
      this.crash = reject;
      (async () => {
        this.setState("booting");
        const [boot, synths, parse] = this.code;
        this.bootAllowed = my;
        this.sclang.runCode(boot);                // s.waitForBoot → bootServer() → scsynth in an AudioWorklet
        await this.poll("~webBooted == true", 30000, 300, alive);
        if (!alive()) return;
        this.sclang.runCode(synths);              // the six SynthDefs; fork-wrapped: s.sync, then ~webSynthsReady
        await this.poll("~webSynthsReady == true", 25000, 300, alive);
        if (!alive()) return;
        this.sclang.runCode(parse);               // the OSCdefs, ~applyDrivers, the three persistent voices (the bed sounds)
        await this.poll(PARSE_READY, 15000, 300, alive);
        if (!alive()) return;
        const nodes = toDestination.filter((n) => n instanceof AudioWorkletNode);
        this.node = nodes[nodes.length - 1] || null;
        this.ctx = this.node ? this.node.context : null;
        if (this.ctx && this.ctx.state !== "running") { try { await this.ctx.resume(); } catch (_) {} }
        this.state = "ready";
        this.replay();
        this.setState("ready");
      })().then(resolve, reject);
    }).finally(() => { if (alive()) this.crash = null; });
  }
  retire() {                                      // silence a failed SuperCollider and cut its wires
    this.attempt++;
    this.crash = null;
    try { this.sclang.runCode("AppClock.clear; SystemClock.clear; TempoClock.default.clear;"); } catch (_) {}
    this.scsynth = this.sclang = null;
    for (const n of toDestination) { try { n.disconnect(); } catch (_) {} try { n.context.close(); } catch (_) {} }
    toDestination.length = 0;
    this.node = this.ctx = null;
  }
  replay() {                                      // what the page said while SuperCollider was not there
    this.brain.replay();                          // /dark/master, /dark/mute if muted, /dark/level 1 if at L1, then the current site's drivers
    if (this.hold) this.brain.dispatch(this.hold);   // the legend preview still held (the brain's legend is stateless)
  }

  // ------------------------------------------------------------------ the page (bridge.py ws_handler + _relay_to_brain)
  attachPage(sock, win) {
    this.sock = sock;
    const gesture = () => {
      this.firstGesture();
      if (this.ctx && this.ctx.state !== "running") this.ctx.resume().catch(() => {});
    };
    win.document.addEventListener("pointerdown", gesture, true);
    win.document.addEventListener("keydown", gesture, true);
    this.pump();
    this.paintChip();
  }
  fromPage(d) {                                   // the page's {type: nav | query | legend, …}, as it sends it
    if (!d || typeof d !== "object") return;
    this.remember(d);
    if (!this.brain.queryLoaded) { this.inbox.push(d); return; }   // held until the brain has ALL its tables (the query assets too): the desktop's order
    this.flushInbox();                            // anything still held goes first
    this.brain.dispatch(d);
  }
  flushInbox() {                                  // the held page messages, in their order; only once the brain can answer every kind
    if (!this.brain.queryLoaded) return;
    for (const d of this.inbox.splice(0)) this.brain.dispatch(d);
    this.pump();
  }
  remember(d) {                                   // pulsar's SOUND.hold: the last legend iso | site | solo, until an end
    if (d.type !== "legend") return;
    const cmd = String(d.cmd ?? ""), has = (k) => d[k] !== undefined;
    if ((cmd === "iso" && has("field")) || (cmd === "site" && has("site")) || (cmd === "solo" && has("layer"))) this.hold = d;
    else if (cmd !== "demo") this.hold = null;    // `end`, an unknown cmd or a hold without its argument → the brain sends /dark/legend end
  }
  deliver(m) {                                    // brain → page: once the page has its data, one macrotask later, in order
    this.outbox.push(m);
    this.pump();
  }
  pump() {
    if (this._pump || !this.sock || !this.pageReady || !this.outbox.length) return;
    this._pump = setTimeout(() => {
      this._pump = null;
      for (const m of this.outbox.splice(0)) { try { this.sock.deliver(m); } catch (e) { console.error(e); } }
    }, 0);
  }
  send(address, args) { this.sclang.sendOsc(oscMessage(address, args)); }

  // ------------------------------------------------------------------ measurement (the gates, debugging)
  get audioNodes() { return toDestination; }
  get dataDir() { return DATA_DIR.href; }
  trace(dir, pkt, args) {                         // the OSC traffic of each start (darkEngine.oscTrace, append-only so a gate can slice it):
    if (!this.oscTrace) this.oscTrace = [];       //   » brain → sclang · × brain message dropped (not ready) · → sclang → scsynth · ← scsynth → sclang
    if (this.oscTrace.length >= 2000) return;     // (the boot alone is ≈ 200 packets: the system SynthDefs' d_recv + done)
    try {
      let t;
      if (typeof pkt === "string") {
        const show = (a) => (a && typeof a === "object" && "t" in a ? `${a.t}:${a.v}` : String(a));
        t = pkt + (args && args.length ? " " + args.map(show).join(" ") : "");
      } else {
        const b = asBytes(pkt);
        if (head(b, 8) === "/status\0" || head(b, 14) === "/status.reply\0") return;   // sclang's status poll (≈ 1.4/s) is noise here
        t = ""; for (let k = 0; k < Math.min(48, b.length); k++) { const c = b[k]; t += c >= 32 && c < 127 ? String.fromCharCode(c) : "."; }
      }
      this.oscTrace.push(`${(performance.now() / 1000).toFixed(2)} ${this.attempt} ${dir} ${t.slice(0, 160)}`);
    } catch (_) { this.oscTrace.push(`${dir} ?`); }
  }
  levels() {                                      // instantaneous peak / rms (dBFS) of what scsynth outputs
    if (!this.ctx || !this.node) return null;
    if (!this._an) { this._an = this.ctx.createAnalyser(); this._an.fftSize = 4096; nativeConnect.call(this.node, this._an); }
    const buf = new Float32Array(this._an.fftSize);
    this._an.getFloatTimeDomainData(buf);
    let peak = 0, sum = 0;
    for (const v of buf) { const a = Math.abs(v); if (a > peak) peak = a; sum += v * v; }
    return { peak: +peak.toFixed(4), rms_dBFS: +(10 * Math.log10(sum / buf.length || 1e-12)).toFixed(1) };
  }
}

export const darkEngine = new DarkEngine();
export { HugurBrain, f, i, s };
