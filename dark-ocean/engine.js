// =============================================================================
//  dark_ocean — web build · the sound engine (lives in the shell page, index.html)
//
//  SuperCollider's own WebAssembly build runs sclang AND scsynth in this tab. sclang loads the
//  design's own sc/dark_ocean_synths.scd and sc/parse_dark_ocean.scd (copied by build_web.py), so
//  the synths, the cooking and the OSCdefs are the desktop design's code, not a translation.
//
//  This file plays the part of viz/bridge.py (2026-09-27 contract), line for line where it can:
//    · relay(): its JSON → OSC relays (legend hold/release, tracked, master vol/mute, mix, frame,
//      dynamics); the OSC goes into sclang with sclang.sendOsc() → the design's OSCdefs;
//    · SOUND: it OWNS ♪ (mute), the master volume and the six layer faders, echoes every change to
//      every page (the page paints only from these echoes: onBridgeMessage), and replays master, mix,
//      the last frame and the last traced chord when SuperCollider (re)boots (replay_sc_state);
//    · a page that goes away while holding a legend chip is released (bridge.py does it on disconnect).
//  Differences, because this is a browser: ♪ is ON when the page opens (Miguel 2026-09-28), but a
//  browser plays nothing before the visitor's first gesture, so SuperCollider starts on the first
//  click or key press anywhere in the page (or on ♪, or a legend hold, D4); ♪ still turns it off.
//  `sc` in the master echo means "this tab's engine is usable".
//
//  The map (view/map.html, the desktop page) runs in an iframe and attaches through web_bridge.js.
//  Its drills reload the iframe only; this engine keeps sounding.
// =============================================================================
import { oscMessage, f, i, s } from "./osc.js";

const ENGINE_DIR = new URL("./engine/", import.meta.url);
const SC_DIR = new URL("./sc/", import.meta.url);
const SC_FILES = ["dark_ocean_synths.scd", "parse_dark_ocean.scd"];
const MIX_KEYS = ["drone", "bed", "rain", "bell", "chimes", "trace", "clock"];    // bridge.py MIX_KEYS (the clock: 2026-10-02)
// The web version's starting mix (Miguel 2026-09-29): the six SOUND-tab faders as a first listen in a browser should
// hear them. The desktop bridge keeps its own (all 1). A visitor's changes last until the page is reloaded.
// The clock (the seventh layer, DECISIONS (y), 2026-10-02) starts at 1 as on the desktop — its level was set against
// the design's full mix (dev/clock_beat); Miguel's ear decides its place in this quieter web mix.
const DEFAULT_MIX = { drone: 0.14, bed: 0.40, rain: 0.56, bell: 0.80, chimes: 0.14, trace: 1.00, clock: 1.00 };

// This build's scsynth.getWorkletNode() throws (lab/PORTING_LOG.md §2, gotcha 2), so remember
// whichever AudioWorkletNode connects to the speakers: that is scsynth.
const toDestination = [];
const nativeConnect = AudioNode.prototype.connect;
AudioNode.prototype.connect = function (dest, ...rest) {
  if (dest instanceof AudioDestinationNode) toDestination.push(this);
  return nativeConnect.call(this, dest, ...rest);
};

// OSC packets as bytes, and the two the start sequence needs to recognise (see instantiate()).
const asBytes = (p) => (p instanceof Uint8Array ? p : new Uint8Array(p.buffer || p));
const head = (p, n) => { const b = asBytes(p); let s = ""; for (let k = 0; k < Math.min(n, b.length); k++) s += String.fromCharCode(b[k]); return s; };
function notifyFlag(p) {                         // "/notify\0" ",i…" + int32 flag → the flag; anything else → null
  const b = asBytes(p);
  if (b.length < 16 || head(b, 8) !== "/notify\0" || !head(b, 10).endsWith(",i")) return null;
  return (b[12] << 24) | (b[13] << 16) | (b[14] << 8) | b[15];
}
const isDoneNotify = (p) => /^\/done\0+,s[^\0]*\0+\/notify\0/.test(head(p, 32));   // "/done" "/notify" …

const CHIP = {                                   // the header chip: the engine's own state
  loading: ["loading SuperCollider…", false],
  idle: ["SuperCollider · starts with ♪", false],
  armed: ["SuperCollider · starts at your first click", false],   // idle with ♪ on (the default)
  booting: ["starting SuperCollider…", false],
  ready: ["SuperCollider · in this tab", true],
  error: ["sound did not start · reload the page to try again", false],
};

class DarkEngine {
  constructor() {
    this.state = "loading";
    this.error = null;
    this.pages = new Set();                      // {page, win, holding}
    this.log = [];                               // last post-window lines: darkEngine.log
    this.watchers = [];
    // bridge.py SOUND, except ♪ starts ON here (Miguel 2026-09-28: "sound should be on by default") and the faders
    // start at DEFAULT_MIX; SuperCollider itself still boots muted and gets this state from replay()
    this.SOUND = { master: { vol: 1.0, mute: 0 }, mix: { ...DEFAULT_MIX },
                   frame: null, tracked: null };
    this.pendingHold = null;                     // a legend hold that arrived while SC was starting
    this.lastClock = { date: null, t: 0 };       // bridge.py _last_clock: two pages on the same date within 50 ms tick once
    this.attempt = 0;                            // start attempts; a superseded attempt stops at its next step
    this.bootAllowed = 0;                        // the attempt whose sclang may boot scsynth (window.bootServer)
    if (typeof document !== "undefined") {       // gestures on the shell itself count too (focus may sit there)
      for (const ev of ["pointerdown", "keydown"]) document.addEventListener(ev, () => this.firstGesture(), true);
    }
    if (typeof window !== "undefined") {         // scsynth dying in a worker surfaces here too (see instantiate)
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
    for (const p of this.pages) this.paintChip(p);
    this.broadcast(this.masterState());          // the status line follows: waiting, starting, sounding, or sc:false
  }
  paintChip(p) {
    const key = this.state === "idle" && !this.SOUND.master.mute ? "armed" : this.state;
    const [text, on] = CHIP[key] || [this.state, false];
    try { p.page.setChip(text, on); } catch (_) {}                          // the technical reason: darkEngine.error + console
  }
  // What the page's status line says while ♪ is on but nothing can sound yet (web_bridge.js pending()).
  // null = the page's own words apply (sounding, ♪ off, or the error).
  pendingText() {
    if (this.SOUND.master.mute) return null;
    if (this.state === "loading") return "sound on · SuperCollider is loading…";
    if (this.state === "idle") return "sound on · <b>click anywhere or press a key to start it</b>";
    if (this.state === "booting") return "sound on · starting SuperCollider…";
    return null;
  }
  // The first click or key press anywhere in a page starts SuperCollider when ♪ is on (the default).
  firstGesture() {
    if (this._boot || this.state === "error" || this.SOUND.master.mute) return;
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
      console.error(t);                                             //   ("worker sent an error!") ends this attempt,
      if (!/worker sent an error/.test(t) || !live()) return;       //   or, once sounding, the session (reload)
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
    // THE SECOND /notify (lab/PORTING_LOG.md §6). When sclang's status watcher misses the server for a
    // moment during the start, it registers for notifications again, and this scsynth build dies on the
    // repeated registration (an uncaught C++ exception in a worker; about 1 start in 4 on 2026-09-28).
    // Only the first `/notify 1` reaches scsynth; a repeat is answered here with scsynth's own first reply,
    // which is what a healthy server says to a client that is already registered.
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
      } else if (n === 0) registered = false;                       // an unregister: a later /notify 1 is real
      synth.sendOsc(osc);
    };
    synth.onOscReply = (r) => {                                     // scsynth → sclang
      if (!live()) return;
      this.trace("←", r);
      if (!notifyReply && isDoneNotify(r)) notifyReply = asBytes(r).slice();   // a copy: r may be reused
      lang.sendOsc(r);
    };
    window.bootServer = (opts) => {              // Server:bootServerApp calls this. ONE global for every sclang,
      if (this.bootAllowed !== this.attempt) return;   // so only the running attempt may boot, once: a retired
      this.bootAllowed = 0;                            // sclang's late request would boot the fresh scsynth early
      setTimeout(() => { if (live()) synth.boot(opts); }, 100);
    };
    lang.bootInterpreter();
    await this.poll("true", 45000, 400);                            // the interpreter answers = class library compiled
  }
  preload() {
    if (this._preload) return this._preload;
    this._preload = (async () => {
      if (!self.crossOriginIsolated) throw new Error("this browser did not allow SharedArrayBuffer");
      await this.instantiate();
      this.code = await Promise.all(SC_FILES.map((n) => fetch(new URL(n, SC_DIR)).then((r) => {
        if (!r.ok) throw new Error(`${n}: HTTP ${r.status}`);
        return r.text();
      })));
      this.setState("idle");
    })().catch((e) => { console.error(e); this.setState("error", e.message); throw e; });
    return this._preload;
  }

  // ------------------------------------------------------------------ boot (a user gesture asked for sound)
  // A safety net behind the /notify guard in instantiate() (the one known cause, lab/PORTING_LOG.md §6):
  // a start whose scsynth dies (an uncaught C++ exception in a worker) or stalls retires that
  // SuperCollider and starts a fresh one in the same page; the visitor's gesture has already unlocked
  // audio. Two tries, then the error.
  boot() {
    if (this._boot) return this._boot;
    this._boot = (async () => {
      await this.preload();
      for (let attempt = 1; ; attempt++) {
        try { await this.start(); return; }
        catch (e) {
          if (attempt >= 2) throw e;
          console.warn(`[dark_ocean] SuperCollider did not start (${e.message}); starting a fresh one`);
          this.retire();
          await this.instantiate();
        }
      }
    })().catch((e) => { console.error(e); this.setState("error", e.message); });
    return this._boot;
  }
  start() {                                      // one attempt: synths → node chain → parser → state
    const my = ++this.attempt, alive = () => this.attempt === my;
    return new Promise((resolve, reject) => {
      this.crash = reject;                       // printErr / window "error" from engine/scsynth.js end it at once
      (async () => {
        this.setState("booting");
        const [synths, parse] = this.code;
        this.bootAllowed = my;                   // this attempt's sclang may boot its scsynth (window.bootServer)
        this.sclang.runCode(synths);             // s.waitForBoot → bootServer() → scsynth in an AudioWorklet
        await this.poll("~widen.notNil and: { ~srcGroup.notNil }", 25000, 300, alive);   // the node chain is live
        if (!alive()) return;
        this.sclang.runCode(parse);              // the design's OSCdefs + default ocean voices
        await this.poll("OSCdef.all[\\darkFrame].notNil and: { OSCdef.all[\\darkMix].notNil }", 20000, 300, alive);
        if (!alive()) return;
        const nodes = toDestination.filter((n) => n instanceof AudioWorkletNode);
        this.node = nodes[nodes.length - 1] || null;           // this attempt's scsynth
        this.ctx = this.node ? this.node.context : null;
        if (this.ctx && this.ctx.state !== "running") { try { await this.ctx.resume(); } catch (_) {} }
        this.state = "ready";
        this.replay();                           // bridge.py replay_sc_state: SC booted muted, give it the state
        if (this.pendingHold) { this.send(...this.relay(this.pendingHold)); this.pendingHold = null; }
        this.setState("ready");                  // (setState echoes ♪ to every page: the status line updates)
      })().then(resolve, reject);
    }).finally(() => { if (alive()) this.crash = null; });
  }
  retire() {                                     // silence a failed SuperCollider and cut its wires
    this.attempt++;                              // its start() stops at the next step
    this.crash = null;
    try { this.sclang.runCode("AppClock.clear; SystemClock.clear; TempoClock.default.clear;"); } catch (_) {}  // its routines stop
    this.scsynth = this.sclang = null;           // its live() is false from now: a boot it scheduled never runs,
                                                 //   its OSC and its posts go nowhere
    for (const n of toDestination) { try { n.disconnect(); } catch (_) {} try { n.context.close(); } catch (_) {} }
    toDestination.length = 0;
    this.node = this.ctx = null;
  }
  replay() {
    const S = this.SOUND;
    this.send("/dark_mix", MIX_KEYS.map((k) => f(S.mix[k])));   // the mix FIRST, while SC is still muted: its own
    this.send("/dark_master", [s("vol"), f(S.master.vol)]);      //   default mix (all 1) must never be heard
    this.send("/dark_master", [s("mute"), f(S.master.mute)]);
    if (S.frame) this.send(...this.relay(S.frame));
    if (S.tracked) this.send(...this.relay(S.tracked));
  }

  // ------------------------------------------------------------------ pages (bridge.py ws_handler)
  masterState() { return { type: "master", ...this.SOUND.master, sc: this.state !== "error" }; }
  mixState() { return { type: "mix", ...this.SOUND.mix }; }
  broadcast(m) { for (const p of this.pages) { try { p.page.message(m); } catch (_) {} } }

  attachPage(page, win) {
    const entry = { page, win, holding: false };
    this.pages.add(entry);
    win.addEventListener("pagehide", () => {
      this.pages.delete(entry);
      if (entry.holding) this.fromPage({ type: "legend", cmd: "release" });   // a page that closes mid-hold
    });
    const gesture = () => {                                                      // autoplay: a gesture starts or resumes
      this.firstGesture();
      if (this.ctx && this.ctx.state !== "running") this.ctx.resume().catch(() => {});
    };
    win.document.addEventListener("pointerdown", gesture, true);
    win.document.addEventListener("keydown", gesture, true);
    page.bridge({ readyState: 1, send: (json) => this.fromPage(JSON.parse(json), entry) });
    page.message(this.masterState());            // a page PAINTS ♪ + volume from this …
    page.message(this.mixState());              // … and the sound-tab faders from this
    this.paintChip(entry);
  }

  fromPage(d, entry) {
    const S = this.SOUND, ready = this.state === "ready";
    let echo = null;
    switch (d.type) {
      case "legend":
        if (d.cmd === "hold") {
          if (entry) entry.holding = true;
          if (!ready) { this.pendingHold = d; this.boot(); return; }        // D4: the legend sounds with ♪ off
        } else if (d.cmd === "release" || d.cmd === "end") {
          if (entry) entry.holding = false;
          if (!ready) { this.pendingHold = null; return; }
        }
        break;
      case "tracked": S.tracked = d; break;
      case "master":
        if (d.cmd !== "vol" && d.cmd !== "mute") return;
        S.master[d.cmd] = d.cmd === "vol" ? Math.max(0, Math.min(1, +d.value || 0)) : (+d.value > 0.5 ? 1 : 0);
        if (d.cmd === "mute" && S.master.mute === 0 && !ready) this.boot();  // ♪ on: start SuperCollider (the
        echo = this.masterState();                                           //   status line says "starting" until it sounds)
        if (d.cmd === "mute" && !ready) for (const p of this.pages) this.paintChip(p);   // idle chip: "starts with ♪" ↔ "at your first click"
        break;
      case "mix":
        for (const k of MIX_KEYS) if (d[k] != null) S.mix[k] = Math.max(0, Math.min(1, +d[k]));
        echo = this.mixState();
        break;
      case "soundquery":
        if (entry) { entry.page.message(this.masterState()); entry.page.message(this.mixState()); }
        return;
      case "frame": S.frame = d; break;
      default: break;
    }
    if (ready) {
      const m = d.type === "mix" ? ["/dark_mix", MIX_KEYS.map((k) => f(S.mix[k]))]
              : d.type === "master" ? ["/dark_master", [s(d.cmd), f(S.master[d.cmd])]]
              : this.relay(d);
      if (m) this.send(m[0], m[1]);
    }
    if (echo) this.broadcast(echo);              // EVERY page, not just the one that acted
  }

  send(address, args) { this.sclang.sendOsc(oscMessage(address, args)); }

  // ------------------------------------------------------------------ viz/bridge.py relays, ported
  relay(d) {
    switch (d.type) {
      case "legend": {                                            // legend_relay
        if (d.cmd === "hold") {
          const cl = [...(d.clusters || []), 0, 0, 0, 0].slice(0, 4);
          return ["/dark_legend", [s("hold"), s(d.driver ?? ""), f(d.temp ?? 0.5), f(d.sal ?? 0.5),
            f(d.nut ?? 0.5), f(d.anom ?? 0.5), ...cl.map(f),
            f(d.clk ?? 0)]];                                        // the clock chip (2026-10-02): still 0 → changing 1
        }
        if (d.cmd === "release" || d.cmd === "end") return ["/dark_legend", [s("release")]];
        return null;
      }
      case "clock": {                                             // clock_relay (2026-10-02): one DATE on the clock
        // {date, accent, n, period, formant}, sent by the page once per date visited; not replayed state (a tick is an
        // event). Two pages on the same date within 50 ms tick once (bridge.py _last_clock).
        const now = performance.now() / 1000;
        if (d.date != null && d.date === this.lastClock.date && now - this.lastClock.t < 0.05) return null;
        this.lastClock = { date: d.date ?? null, t: now };
        return ["/dark_clock", [f(d.accent ?? 0), f(d.n ?? 1), f(d.period ?? 0.65), f(d.formant ?? 1500)]];
      }
      case "tracked": {                                           // tracked_relay
        const cl = d.clusters || [0, 0, 0, 0];
        return ["/dark_tracked", [i(d.n ?? 0), f(d.lat ?? 0), f(d.lon ?? 0),
          f(d.temp ?? 0), f(d.sal ?? 0), f(d.nut ?? 0), f(d.anom ?? 0), ...cl.slice(0, 4).map(f)]];
      }
      case "frame": {                                             // frame_relay
        const c = d.clusters || [0, 0, 0, 0];
        return ["/dark_frame", [f(d.temp ?? 0.5), f(d.sal ?? 0.5), f(d.nut ?? 0.5), f(d.anom ?? 0.5),
          ...c.slice(0, 4).map(f)]];
      }
      case "dynamics":                                            // dynamics_relay
        return ["/dark_dynamics", [s(d.dyn ?? "upwell"), f(d.intensity ?? 0.5), f(d.pan ?? 0), f(d.glide ?? 0)]];
      case "record":
        // desktop: SC records its output to a WAV for an offline mux. Here the page's own recorder
        // takes the engine's audio track instead (web_bridge.js withAudio), so there is nothing to send.
        return null;
      default:
        return null;
    }
  }

  // ------------------------------------------------------------------ recording + measurement
  audioTrack() {
    if (!this.ctx || !this.node) return null;
    if (!this._rec) { this._rec = this.ctx.createMediaStreamDestination(); nativeConnect.call(this.node, this._rec); }
    return this._rec.stream.getAudioTracks()[0] || null;
  }
  get audioNodes() { return toDestination; }     // debugging: the nodes that reached the speakers (their .context)
  trace(dir, pkt) {                              // debugging: the first OSC traffic of each start (darkEngine.oscTrace)
    if (!this.oscTrace) this.oscTrace = [];
    if (this.oscTrace.length >= 400) return;
    try {
      const b = pkt instanceof Uint8Array ? pkt : new Uint8Array(pkt.buffer || pkt);
      let s = ""; for (let k = 0; k < Math.min(48, b.length); k++) { const c = b[k]; s += c >= 32 && c < 127 ? String.fromCharCode(c) : "."; }
      this.oscTrace.push(`${(performance.now() / 1000).toFixed(2)} ${this.attempt} ${dir} ${s}`);
    } catch (_) { this.oscTrace.push(`${dir} ?`); }
  }
  levels() {                 // debugging: instantaneous peak / rms (dBFS) of what scsynth outputs
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
