// =============================================================================
//  darkpulsar — web build · the sound engine (lives in index.html, the design's own page, patched by build_web.py)
//
//  SuperCollider's own WebAssembly build runs sclang AND scsynth in this tab. sclang runs the design's own
//  sc/darkpulsar_synths.scd (two path lines replaced, fork-wrapped) and sc/parse_darkpulsar.scd (unmodified), so the
//  synths, the cooking and the OSCdefs are the desktop design's code, not a translation. Around them, three web-only
//  files (sc/): web_boot.scd (the server options), web_tables.scd (the four small asset tables as literals, generated)
//  and web_buffers.scd (~wt and the one L1 table are filled by THIS file with /b_setn: the engine has no sound-file
//  reader, lab/PORTING_LOG.md §1).
//
//  This file plays the part of viz/bridge.py (the 2026-10-04 contract, lab/WEB_HANDOFF.md §2.2), line for line:
//    · relay(): its JSON → OSC relays (navsound → /dark_nav, legend → /dark_legend, master → /dark_master); the OSC
//      goes into sclang with sclang.sendOsc() → the design's OSCdefs;
//    · the `init` message (baked by build_data.py with the bridge's own functions) reaches the page through its socket;
//    · the L1 voices' phase reports (scsynth's /dp_l1ph SendReply, 20/s per voice) reach the page as {type:"l1phase"},
//      read from the server's replies here (the desktop relays them sclang → UDP → bridge.py → the socket);
//    · state for a (re)start: the master, the last L0 navigation, a legend hold still held (replay()).
//  Differences, because this is a browser: a page plays nothing before the visitor's first gesture, so SuperCollider
//  starts on the first click or key press anywhere in the page (the site's rule since 2026-09-28); the profiles come
//  as uint16 (data/profiles.u16) and are decoded once, for the page's profile panel and for the buffers alike.
//  The /notify guard and the retired-pair restart are dark_ocean's (its PORTING_LOG §6).
// =============================================================================
import { oscMessage, f, i, s } from "./osc.js";

const ENGINE_DIR = new URL("./engine/", import.meta.url);
const SC_DIR = new URL("./sc/", import.meta.url);
const DATA_DIR = new URL("./data/", import.meta.url);
const SC_FILES = ["web_boot.scd", "darkpulsar_synths.scd", "web_tables.scd", "parse_darkpulsar.scd", "web_buffers.scd"];
// bridge.py L0_NAV_COLS: the no-manifest fallback; at startup the bridge takes the first six legend drivers' columns
const L0_NAV_COLS = ["period_s", "spindown_lum", "dm_pccm3", "b_surface_g", "char_age_yr", "flux_1400mhz"];
const N_BINS = 1024;

// This build's scsynth.getWorkletNode() throws (ocean PORTING_LOG §2, gotcha 2), so remember whichever
// AudioWorkletNode connects to the speakers: that is scsynth.
const toDestination = [];
const nativeConnect = AudioNode.prototype.connect;
AudioNode.prototype.connect = function (dest, ...rest) {
  if (dest instanceof AudioDestinationNode) toDestination.push(this);
  return nativeConnect.call(this, dest, ...rest);
};

// OSC packets as bytes, and the three the engine must recognise on the sclang → scsynth wire.
const asBytes = (p) => (p instanceof Uint8Array ? p : new Uint8Array(p.buffer || p));
const head = (p, n) => { const b = asBytes(p); let t = ""; for (let k = 0; k < Math.min(n, b.length); k++) t += String.fromCharCode(b[k]); return t; };
function notifyFlag(p) {                          // "/notify\0" ",i…" + int32 flag → the flag; anything else → null
  const b = asBytes(p);
  if (b.length < 16 || head(b, 8) !== "/notify\0" || !head(b, 10).endsWith(",i")) return null;
  return (b[12] << 24) | (b[13] << 16) | (b[14] << 8) | b[15];
}
const isDoneNotify = (p) => /^\/done\0+,s[^\0]*\0+\/notify\0/.test(head(p, 32));
function l1Phase(p) {                             // "/dp_l1ph" ",iif" node idx phase (SendReply, 20/s per L1 voice) → {idx, phase}
  const b = asBytes(p);
  if (b.length < 32 || head(b, 9) !== "/dp_l1ph\0") return null;       // address 9 bytes → padded to 12
  if (head(b, 16).slice(12, 16) !== ",iif") return null;               // typetags ",iif\0" → bytes 12..19
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { node: dv.getInt32(20, false), idx: dv.getInt32(24, false), phase: dv.getFloat32(28, false) };
}
function firstNumber(p) {                         // /addr ,i|f <value>: the first argument of a one-number message
  const b = asBytes(p), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let k = 0; while (k < b.length && b[k] !== 0) k++; k = Math.ceil((k + 1) / 4) * 4;
  if (b[k] !== 0x2c) return null;
  const tag = String.fromCharCode(b[k + 1]);
  let e = k; while (e < b.length && b[e] !== 0) e++; e = Math.ceil((e + 1) / 4) * 4;
  if (e + 4 > b.length) return null;
  return tag === "i" ? dv.getInt32(e, false) : tag === "f" ? dv.getFloat32(e, false) : null;
}
const gunzipJson = (r) => { if (!r.ok) throw new Error(`${r.url}: HTTP ${r.status}`); return new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).json(); };
const u16ToF32 = (buf) => { const U = new Uint16Array(buf), F = new Float32Array(U.length); for (let k = 0; k < U.length; k++) F[k] = U[k] / 65535 * 2 - 1; return F; };

// The header chip (#chip: the bridge's connection chip on the desktop): class + text per engine state
const CHIP = {
  loading: ["waiting", "loading SuperCollider…"],
  idle: ["waiting", "SuperCollider · starts at your first click"],
  booting: ["waiting", "starting SuperCollider…"],
  ready: ["streaming", "SuperCollider · in this tab"],
  error: ["disconnected", "sound did not start · reload the page to try again"],
};

class DarkEngine {
  constructor() {
    this.state = "loading";
    this.error = null;
    this.sock = null;                             // the page's socket (web_page.js)
    this.log = [];                                // last post-window lines: darkEngine.log
    this.watchers = [];
    // bridge.py has no sound state of its own for this design (SC keeps ~masterVol 0.8 and the page's Vol slider
    // starts at 0.80, unmuted); the engine remembers what the page sent so a (re)started SuperCollider gets it back
    this.SOUND = { master: { vol: 0.8, mute: 0 }, nav: null, lastLevel: "l0", hold: null, legendMute: 0 };
    this.curIdx = -1;                             // the parser's ~curIdx: the last pulsar swapped into ~wt
    this.filled = new Set();                      // pulsars whose L1 block is in ~profAA (this scsynth)
    this.wtBuf = this.aaBuf = this.aaFrames = this.aaStride = null;
    this.init = null; this.navCols = L0_NAV_COLS;
    this.profiles = null; this.blocks = null; this.blockIndex = null;
    this.profilesReady = new Promise((r) => { this._profilesResolve = r; });
    this.attempt = 0;                             // start attempts; a superseded attempt stops at its next step
    this.bootAllowed = 0;                         // the attempt whose sclang may boot scsynth (window.bootServer)
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
    const [cls, text] = CHIP[this.state] || ["waiting", this.state];
    if (this.sock) { try { this.sock.setChip(cls, text); } catch (_) {} }
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
    // answered here with scsynth's own first reply. THE PROFILE REQUEST: web_buffers.scd's ~swapWt sends
    // /dp_wt_want idx towards the server; it is for the page (fill ~wt with that pulsar's profile), never forwarded.
    let registered = false, notifyReply = null;
    lang.onOsc = (osc) => {                                         // sclang → scsynth
      if (!live()) return;
      this.trace("→", osc);
      if (head(osc, 12) === "/dp_wt_want\0") { this.wantWt(firstNumber(osc)); return; }
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
    synth.onOscReply = (r) => {                                     // scsynth → sclang
      if (!live()) return;
      const ph = l1Phase(r);                                        // an L1 voice's phase report: for the page, not sclang
      if (ph) { this.l1phCount = (this.l1phCount || 0) + 1; this.l1phLast = ph; if (this.sock) this.sock.deliver({ type: "l1phase", idx: ph.idx, phase: ph.phase }); return; }
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
  async loadData() {
    const [init, prof, blk, idx] = await Promise.all([
      fetch(new URL("init.json.gz", DATA_DIR)).then(gunzipJson),
      fetch(new URL("profiles.u16", DATA_DIR)).then((r) => { if (!r.ok) throw new Error(`profiles.u16: HTTP ${r.status}`); return r.arrayBuffer(); }),
      fetch(new URL("aa_blocks.u16", DATA_DIR)).then((r) => { if (!r.ok) throw new Error(`aa_blocks.u16: HTTP ${r.status}`); return r.arrayBuffer(); }),
      fetch(new URL("aa_blocks.json", DATA_DIR)).then((r) => { if (!r.ok) throw new Error(`aa_blocks.json: HTTP ${r.status}`); return r.json(); }),
    ]);
    this.init = init;
    if (Array.isArray(init.legend_drivers) && init.legend_drivers.length >= 6) {   // bridge.py startup: the manifest's join
      this.navCols = init.legend_drivers.slice(0, 6).map((d) => d.column);
    }
    this.profiles = u16ToF32(prof);
    this.blocks = u16ToF32(blk);
    this.blockIndex = idx;
    if (this.profiles.length !== init.n_pulsars * (init.n_bins || N_BINS)) throw new Error("profiles.u16 does not match init.json");
    this._profilesResolve(this.profiles);
    this.maybeInit();
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
          console.warn(`[darkpulsar] SuperCollider did not start (${e.message}); starting a fresh one`);
          this.retire();
          await this.instantiate();
        }
      }
    })().catch((e) => { console.error(e); this.setState("error", e.message); });
    return this._boot;
  }
  start() {                                       // one attempt: boot → synths → tables → parser → buffers → state
    const my = ++this.attempt, alive = () => this.attempt === my;
    return new Promise((resolve, reject) => {
      this.crash = reject;
      (async () => {
        this.setState("booting");
        const [boot, synths, tables, parse, buffers] = this.code;
        this.bootAllowed = my;
        this.sclang.runCode(boot);                // s.waitForBoot → bootServer() → scsynth in an AudioWorklet
        await this.poll("~webBooted == true", 30000, 300, alive);
        if (!alive()) return;
        this.sclang.runCode(synths);              // the design's SynthDefs + ~grainVoice (its six Buffer.reads fail: no libsndfile)
        await this.poll("~webSynthsReady == true", 25000, 300, alive);
        if (!alive()) return;
        this.sclang.runCode(tables);              // the four small tables as literals + the derived period positions
        await this.poll("~webTablesReady == true", 10000, 300, alive);
        if (!alive()) return;
        this.sclang.runCode(parse);               // the design's OSCdefs, cooking, cleanup routine
        await this.poll("OSCdef.all[\\darkPulsarNav].notNil and: { OSCdef.all[\\darkLegend].notNil and: { OSCdef.all[\\darkMaster].notNil } }", 15000, 300, alive);
        if (!alive()) return;
        this.sclang.runCode(buffers);             // ~profAA as one table; ~swapWt asks the page for profiles
        await this.poll("~webBuffersReady == true", 15000, 300, alive);
        if (!alive()) return;
        const nums = (await this.query("[~wt.bufnum, ~profAA.bufnum, ~profAA.numFrames, ~aaStride]")).replace(/[\[\]\s]/g, "").split(",").map(Number);
        if (nums.length !== 4 || nums.some((v) => !Number.isFinite(v))) throw new Error(`buffer numbers unreadable: ${nums}`);
        [this.wtBuf, this.aaBuf, this.aaFrames, this.aaStride] = nums;
        if (this.aaFrames !== this.init.n_pulsars * this.aaStride) throw new Error(`~profAA has ${this.aaFrames} frames, expected ${this.init.n_pulsars} × ${this.aaStride}`);
        this.filled.clear();                      // a fresh scsynth has empty buffers
        if (this.curIdx >= 0) this.wantWt(this.curIdx);   // the swap that happened while booting
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
    this.wtBuf = this.aaBuf = null;
    this.filled.clear();
  }
  replay() {                                      // what the page said while SuperCollider was not there yet
    const S = this.SOUND;
    this.send("/dark_master", [s("vol"), f(S.master.vol)]);
    this.send("/dark_master", [s("mute"), i(S.master.mute)]);
    if (S.legendMute) this.send("/dark_legend", [s("mute"), i(1)]);
    if (S.nav && S.lastLevel !== "l1") this.relaySend(S.nav);    // the pulsar under the cursor sounds (at L1 the
    if (S.hold) this.relaySend(S.hold);                           //   page's keepalive restarts the voices itself)
  }

  // ------------------------------------------------------------------ the page (bridge.py ws_handler)
  attachPage(sock, win) {
    this.sock = sock;
    const gesture = () => {
      this.firstGesture();
      if (this.ctx && this.ctx.state !== "running") this.ctx.resume().catch(() => {});
    };
    win.document.addEventListener("pointerdown", gesture, true);
    win.document.addEventListener("keydown", gesture, true);
    this.maybeInit();
    this.paintChip();
  }
  maybeInit() {                                   // the `init` message, once both the page and the data are here
    if (!this.sock || !this.init || this._initSent) return;
    this._initSent = true;
    this.sock.deliver(this.init);
  }
  fromPage(d) {
    if (!d || typeof d !== "object") return;
    const S = this.SOUND, ready = this.state === "ready";
    switch (d.type) {
      case "navsound":
        if (d.level === "l1") { S.lastLevel = "l1"; }
        else { S.lastLevel = "l0"; S.nav = d; }
        if (Number.isInteger(+d.idx) && +d.idx >= 0) this.curIdx = +d.idx;   // the parser's ~swapWt will ask for it
        break;
      case "legend":
        if (d.cmd === "iso" || d.cmd === "row" || d.cmd === "solo") S.hold = d;
        else if (d.cmd === "end") S.hold = null;
        else if (d.cmd === "mute") S.legendMute = +d.value > 0.5 ? 1 : 0;
        break;
      case "master":
        if (d.cmd === "vol") S.master.vol = Math.max(0, Math.min(1, +d.value || 0));
        else if (d.cmd === "mute") S.master.mute = +d.value > 0.5 ? 1 : 0;
        else return;
        break;
      default:
        return;
    }
    if (ready) this.relaySend(d);
  }
  relaySend(d) {
    const m = this.relay(d);
    if (!m) return;
    if (d.type === "navsound" && d.level === "l1") this.ensureBlock(+d.idx);
    if (d.type === "legend" && d.cmd === "solo" && String(d.layer) === "pulse") this.ensureBlock(this.curIdx >= 0 ? this.curIdx : 0);
    this.send(m[0], m[1]);
  }
  send(address, args) { this.sclang.sendOsc(oscMessage(address, args)); }

  // ------------------------------------------------------------------ viz/bridge.py relays, ported
  relay(d) {
    switch (d.type) {
      case "navsound": {                                            // nav_relay
        const idx = Math.trunc(+d.idx);
        if (d.level === "l1") return ["/dark_nav", [s("l1"), i(idx), f(d.phase ?? 0)]];
        const rows = this.init ? this.init.pulsars : [];
        if (!(idx >= 0 && idx < rows.length)) return null;
        const p = rows[idx];
        return ["/dark_nav", [s("l0"), i(idx), ...this.navCols.map((c) => f(p[c] == null ? 0.5 : +p[c]))]];
      }
      case "legend": {                                              // legend_relay
        const cmd = String(d.cmd ?? "");
        if (cmd === "iso") return ["/dark_legend", [s("iso"), s(d.driver ?? ""), f(d.value ?? 0.5)]];
        if (cmd === "row") {
          const drv = Array.isArray(d.drivers) ? d.drivers : [];
          if (drv.length !== this.navCols.length) return null;    // exactly the 6 driver floats
          return ["/dark_legend", [s("row"), ...drv.map((x) => f(x)), s(d.label ?? "")]];
        }
        if (cmd === "solo") return ["/dark_legend", [s("solo"), s(d.layer ?? "all")]];
        if (cmd === "mute") return ["/dark_legend", [s("mute"), i(d.value ?? 0)]];
        if (cmd === "end") return ["/dark_legend", [s("end")]];
        return null;
      }
      case "master": {                                              // master_relay
        const cmd = String(d.cmd ?? "");
        if (cmd === "vol") return ["/dark_master", [s("vol"), f(d.value ?? 0.8)]];
        if (cmd === "mute") return ["/dark_master", [s("mute"), i(d.value ?? 0)]];
        return null;
      }
      default:
        return null;
    }
  }

  // ------------------------------------------------------------------ the buffers scsynth cannot read itself
  profile(idx) { return this.profiles.subarray(idx * N_BINS, idx * N_BINS + N_BINS); }
  block(idx) {                                    // the 1,032-frame L1 block (aa_blocks.json "rule")
    const I = this.blockIndex, k = I.band_limited.indexOf(idx);
    if (k >= 0) return this.blocks.subarray(k * I.stride, (k + 1) * I.stride);
    const out = new Float32Array(I.stride), p = this.profile(idx);
    out.set(p, 0);
    for (let w = 0; w < I.wrap; w++) out[N_BINS + w] = p[w];
    return out;
  }
  setn(bufnum, offset, arr, chunk = 1032) {       // /b_setn straight to scsynth, in order with sclang's own messages
    for (let o = 0; o < arr.length; o += chunk) {
      const n = Math.min(chunk, arr.length - o), args = [i(bufnum), i(offset + o), i(n)];
      for (let k = 0; k < n; k++) args.push(f(arr[o + k]));
      this.scsynth.sendOsc(oscMessage("/b_setn", args));
    }
  }
  wantWt(idx) {                                   // ~swapWt (web_buffers.scd): this pulsar's profile into ~wt
    if (idx == null || !(idx >= 0) || !this.profiles || idx * N_BINS >= this.profiles.length) return;
    this.curIdx = idx;
    if (this.wtBuf == null || !this.scsynth) return;
    this.setn(this.wtBuf, 0, this.profile(idx));
  }
  ensureBlock(idx) {                              // this pulsar's L1 block into ~profAA, once per scsynth
    if (!(idx >= 0) || this.aaBuf == null || this.filled.has(idx) || !this.blockIndex || idx >= this.blockIndex.n_pulsars) return;
    this.setn(this.aaBuf, idx * this.aaStride, this.block(idx));
    this.filled.add(idx);
  }

  // ------------------------------------------------------------------ measurement (the gates, debugging)
  get audioNodes() { return toDestination; }
  trace(dir, pkt) {                               // the first OSC traffic of each start (darkEngine.oscTrace)
    if (!this.oscTrace) this.oscTrace = [];
    if (this.oscTrace.length >= 400) return;
    try {
      const b = asBytes(pkt);
      let t = ""; for (let k = 0; k < Math.min(48, b.length); k++) { const c = b[k]; t += c >= 32 && c < 127 ? String.fromCharCode(c) : "."; }
      this.oscTrace.push(`${(performance.now() / 1000).toFixed(2)} ${this.attempt} ${dir} ${t}`);
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
