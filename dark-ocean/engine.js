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
//  Differences, because this is a browser: SuperCollider starts on the first gesture that asks for
//  sound (♪ on, or a legend hold, D4); `sc` in the master echo means "this tab's engine is usable".
//
//  The map (view/map.html, the desktop page) runs in an iframe and attaches through web_bridge.js.
//  Its drills reload the iframe only; this engine keeps sounding.
// =============================================================================
import { oscMessage, f, i, s } from "./osc.js";

const ENGINE_DIR = new URL("./engine/", import.meta.url);
const SC_DIR = new URL("./sc/", import.meta.url);
const SC_FILES = ["dark_ocean_synths.scd", "parse_dark_ocean.scd"];
const MIX_KEYS = ["drone", "bed", "rain", "bell", "chimes", "trace"];    // bridge.py MIX_KEYS

// This build's scsynth.getWorkletNode() throws (lab/PORTING_LOG.md §2, gotcha 2), so remember
// whichever AudioWorkletNode connects to the speakers: that is scsynth.
const toDestination = [];
const nativeConnect = AudioNode.prototype.connect;
AudioNode.prototype.connect = function (dest, ...rest) {
  if (dest instanceof AudioDestinationNode) toDestination.push(this);
  return nativeConnect.call(this, dest, ...rest);
};

const CHIP = {                                   // the header chip: the engine's own state
  loading: ["loading SuperCollider…", false],
  idle: ["SuperCollider · starts with ♪", false],
  booting: ["starting SuperCollider…", false],
  ready: ["SuperCollider · in this tab", true],
  error: ["sound unavailable", false],
};

class DarkEngine {
  constructor() {
    this.state = "loading";
    this.error = null;
    this.pages = new Set();                      // {page, win, holding}
    this.log = [];                               // last post-window lines: darkEngine.log
    this.watchers = [];
    // bridge.py SOUND: boots muted, like SuperCollider (♪ off)
    this.SOUND = { master: { vol: 1.0, mute: 1 }, mix: Object.fromEntries(MIX_KEYS.map((k) => [k, 1.0])),
                   frame: null, tracked: null };
    this.pendingHold = null;                     // a legend hold that arrived while SC was starting
    this.masterEchoOnReady = false;              // ♪ pressed before SC was ready: paint "on" when it is
  }

  // ------------------------------------------------------------------ status
  setState(state, error) {
    this.state = state;
    if (error) this.error = error;
    for (const p of this.pages) this.paintChip(p);
    if (state === "error") this.broadcast(this.masterState());          // the status line learns sc:false
  }
  paintChip(p) {
    const [text, on] = CHIP[this.state] || [this.state, false];
    try { p.page.setChip(this.state === "error" && this.error ? `sound unavailable: ${this.error}` : text, on); } catch (_) {}
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
  async poll(expr, ms, every = 300) {
    const end = performance.now() + ms;
    for (;;) {
      const tag = "DW" + Math.random().toString(36).slice(2, 8);
      const answer = this.until(new RegExp(`^${tag} (true|false)$`), every + 500).then((l) => l.endsWith("true"), () => false);
      try { this.sclang.runCode(`("${tag} " ++ (${expr}).asBoolean).postln;`); } catch (_) {}
      if (await answer) return;
      if (performance.now() > end) throw new Error(`SuperCollider never reported: ${expr}`);
      await new Promise((r) => setTimeout(r, every));
    }
  }

  // ------------------------------------------------------------------ load (no audio yet)
  preload() {
    if (this._preload) return this._preload;
    this._preload = (async () => {
      if (!self.crossOriginIsolated) throw new Error("this browser did not allow SharedArrayBuffer");
      const locateFile = (p) => new URL(p, ENGINE_DIR).href;   // sclang.data would otherwise resolve against the page
      const [{ default: ScSynth }, { default: ScLang }] = await Promise.all([
        import(new URL("scsynth.js", ENGINE_DIR).href), import(new URL("sclang.js", ENGINE_DIR).href),
      ]);
      this.scsynth = await ScSynth({ locateFile });
      this.sclang = await ScLang({ locateFile });
      this.sclang.printCallback = (t) => this.post("lang", t);
      this.scsynth.onStdout = (t) => this.post("synth", t);
      this.scsynth.onPrint = (t) => this.post("synth", t);
      this.sclang.onOsc = (osc) => this.scsynth.sendOsc(osc);       // sclang → scsynth
      this.scsynth.onOscReply = (r) => this.sclang.sendOsc(r);      // scsynth → sclang
      window.bootServer = (opts) => setTimeout(() => this.scsynth.boot(opts), 100);  // Server:bootServerApp calls this
      this.sclang.bootInterpreter();
      await this.poll("true", 45000, 400);                          // the interpreter answers = class library compiled
      this.code = await Promise.all(SC_FILES.map((n) => fetch(new URL(n, SC_DIR)).then((r) => {
        if (!r.ok) throw new Error(`${n}: HTTP ${r.status}`);
        return r.text();
      })));
      this.setState("idle");
    })().catch((e) => { console.error(e); this.setState("error", e.message); throw e; });
    return this._preload;
  }

  // ------------------------------------------------------------------ boot (a user gesture asked for sound)
  boot() {
    if (this._boot) return this._boot;
    this._boot = (async () => {
      await this.preload();
      this.setState("booting");
      const [synths, parse] = this.code;
      this.sclang.runCode(synths);                 // s.waitForBoot → bootServer() → scsynth in an AudioWorklet
      await this.poll("~widen.notNil and: { ~srcGroup.notNil }", 40000);   // the node chain is live
      this.sclang.runCode(parse);                  // the design's OSCdefs + default ocean voices
      await this.poll("OSCdef.all[\\darkFrame].notNil and: { OSCdef.all[\\darkMix].notNil }", 20000);
      this.node = toDestination.find((n) => n instanceof AudioWorkletNode) || null;
      this.ctx = this.node ? this.node.context : null;
      if (this.ctx && this.ctx.state !== "running") { try { await this.ctx.resume(); } catch (_) {} }
      this.state = "ready";
      this.replay();                               // bridge.py replay_sc_state: SC booted muted, give it the state
      if (this.pendingHold) { this.send(...this.relay(this.pendingHold)); this.pendingHold = null; }
      this.setState("ready");
      if (this.masterEchoOnReady) { this.masterEchoOnReady = false; this.broadcast(this.masterState()); }
    })().catch((e) => { console.error(e); this.setState("error", e.message); });
    return this._boot;
  }
  replay() {
    const S = this.SOUND;
    this.send("/dark_master", [s("vol"), f(S.master.vol)]);
    this.send("/dark_master", [s("mute"), f(S.master.mute)]);
    this.send("/dark_mix", MIX_KEYS.map((k) => f(S.mix[k])));
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
    win.document.addEventListener("pointerdown", () => {                        // autoplay: resume on a gesture
      if (this.ctx && this.ctx.state !== "running") this.ctx.resume().catch(() => {});
    }, true);
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
        if (d.cmd === "mute" && S.master.mute === 0 && !ready) {          // ♪ on: start SuperCollider;
          this.masterEchoOnReady = true;                                     // ♪ paints "on" when it sounds
          this.boot();
          return;
        }
        echo = this.masterState();
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
            f(d.nut ?? 0.5), f(d.anom ?? 0.5), ...cl.map(f)]];
        }
        if (d.cmd === "release" || d.cmd === "end") return ["/dark_legend", [s("release")]];
        return null;
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
