// =============================================================================
//  dark_svartsengi — web build · the sound engine (hand-written). The page is view/index.html (viz/index.html,
//  patched by build/build_web.py); this module is loaded by web_page.js once the page is cross-origin isolated.
//
//  SuperCollider's own WebAssembly build runs sclang AND scsynth in this tab (projects/web/engines/sc-wasm-5d47207).
//  sclang runs the design's own code, built from sc/ without translation:
//    sc/web_boot.scd                  WEB ONLY: the server options (numWireBufs 256, memSize for the 16 MiB heap)
//                                     and ~svkReplyTo, the parser's one reply seam (A6)
//    sc/svk_synthdefs.scd             generated: W2's Array of 9 SynthDefs inlined, .add'ed, s.sync'ed
//    sc/parse_dark_svartsengi.scd     generated: W2's parser with sc/svk_cook.scd inlined in place of its read line,
//                                     its `var dir` line a literal; otherwise unmodified (the OSCdefs, the three
//                                     Ground rings, the want/fill bookkeeping, the persistent voices)
//
//  This file plays viz/bridge.py's part (CONTRACT v0.8 §5: a thin relay), line for line:
//    · page → SC: relay.js toOsc() = bridge.json_to_osc() over view/svk_messages.json, into sclang.sendOsc();
//    · SC → page: the parser answers through ~svkSend → ~svkReplyTo (= the server's address in this build), so its
//      five replies (/svk_want /svk_playhead /svk_ready /svk_bufinfo /svk_readout) arrive on the sclang → scsynth
//      wire; they are taken off it here (never forwarded to scsynth) and become page JSON (relay.js fromOsc() =
//      bridge.osc_to_json(): NaN → null). The playhead and readout come from scsynth's SendReplys (/svk_gpos, /svk_ro),
//      which go to the parser first, exactly as on the desktop (the parser keeps the ring bookkeeping);
//    · the Ground ring: the page's GroundFeeder answers each /svk_want (counts / manifest.wave[chan].peak, decoded
//      from view/data/wave/*.u16 in JS — never decodeAudioData, rule A10) and hands the block to upload(), the
//      desktop's {type:"setn"} carrier: /b_setn straight into this scsynth in ≤ 4,096-float messages (no UDP limit
//      here), only into a bufnum the engine announced with /svk_bufinfo (sclang allocated the rings);
//      the page then sends /svk_filled itself;
//    · the parser zeroes a ring with Buffer.zero (/b_zero, an ASYNCHRONOUS server command) before it wants the first
//      blocks: uploads for that buffer wait here for scsynth's /done /b_zero, so a fast in-tab answer can never be
//      wiped by the zeroing (on the desktop the UDP round trip hides this race).
//  Rule A11: view/index.html owns this engine for its whole life; nothing here reloads a page.
//  The /notify guard and the retired-pair restart are dark_ocean's (its PORTING_LOG §6), via darkpulsar.
// =============================================================================
import { oscMessage, setnMessage, parseOsc, oscAddress } from "./osc.js";
import { toOsc, fromOsc } from "./relay.js";

const ENGINE_DIR = new URL("./engine/", import.meta.url);
const SC_DIR = new URL("./sc/", import.meta.url);
const SCHEMA_URL = new URL("./view/svk_messages.json", import.meta.url);
const SC_FILES = ["web_boot.scd", "svk_synthdefs.scd", "parse_dark_svartsengi.scd"];
const SETN_CHUNK = 4096;                          // floats per /b_setn (the task's bound; re_wilding measured 4,096 exact)
const N_RINGS = 3;                                // Ground: Z, N, E
const ZERO_WAIT_MS = 1000;                        // uploads held for a /b_zero's /done at most this long
const FAIL_RE = /alloc failed|failed to allocate|interconnect buffers|FAILURE IN SERVER|not installed|ERROR:/;
const UNDERRUN_RE = /ground chan (\d) entered block (\d+) with no \/svk_filled since its want \(#(\d+)\)/;

// ?silent=1 — the checks' mode: scsynth reaches the speakers through a gain of exactly 0, so the audio thread runs at
// real time and levels() still measures it (it taps scsynth's node directly), but nothing is ever audible.
const SILENT = (() => { try { return new URLSearchParams(location.search).get("silent") === "1"; } catch (_) { return false; } })();
// This build's scsynth.getWorkletNode() throws (ocean PORTING_LOG §2, gotcha 2), so remember whichever
// AudioWorkletNode connects to the speakers: that is scsynth.
const toDestination = [];
const nativeConnect = AudioNode.prototype.connect;
AudioNode.prototype.connect = function (dest, ...rest) {
  if (dest instanceof AudioDestinationNode) {
    toDestination.push(this);
    if (SILENT) {
      const zero = dest.context.createGain();
      zero.gain.value = 0;
      nativeConnect.call(zero, dest);
      return nativeConnect.call(this, zero, ...rest);
    }
  }
  return nativeConnect.call(this, dest, ...rest);
};

const asBytes = (p) => (p instanceof Uint8Array ? p : new Uint8Array(p.buffer || p));
function notifyFlag(p) {                          // "/notify\0" ",i…" + int32 flag → the flag; anything else → null
  const b = asBytes(p);
  if (b.length < 16 || oscAddress(b) !== "/notify" || b[8] !== 0x2c || b[9] !== 0x69) return null;
  return (b[12] << 24) | (b[13] << 16) | (b[14] << 8) | b[15];
}

const STATUS = {
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
    this.schema = null; this.replyAddrs = new Set();
    this.bufnums = new Set();                     // announced by /svk_bufinfo (this scsynth): the only upload targets
    this.rings = {};                              // chan → {bufnum, frames}
    this.held = [];                               // SC's replies while it boots (its own closing /svk_hello)
    this.outbox = []; this._flushQueued = false;
    this.zeroPending = new Map();                 // bufnum → {n, queue, timer}: uploads waiting for /done /b_zero
    this.counts = this.freshCounts();
    this.info = {};
    this.attempt = 0;                             // start attempts; a superseded attempt stops at its next step
    this.bootAllowed = 0;                         // the attempt whose sclang may boot scsynth (window.bootServer)
    window.addEventListener("error", (ev) => {    // scsynth dying in a worker surfaces here too (see instantiate)
      const where = String(ev.filename || (ev.error && ev.error.filename) || "");
      if (this.crash && where.includes("/engine/scsynth.js")) this.crash(new Error(`scsynth stopped: ${ev.message}`));
    });
  }
  freshCounts() {
    return { fromPage: {}, toPage: {}, droppedBeforeReady: 0, relayErrors: 0, setnBlocks: 0, setnMsgs: 0, setnFloats: 0,
             setnRefused: 0, setnHeldForZero: 0, zeroWaitTimeouts: 0, underrunLines: 0, failures: [] };
  }

  // ------------------------------------------------------------------ status (the page's engine chip)
  setState(state, error) {
    this.state = state;
    if (error) this.error = error;
    this.toPage({ type: "status", status: `engine-${state}` });    // not "open": the page repaints its chip only
  }
  statusText() {
    const t = (STATUS[this.state] || this.state) + (SILENT ? " · silent (?silent=1)" : "");
    return this.state === "error" && this.error ? `${t} (${this.error})` : t;
  }
  firstGesture() {
    if (this._boot || this.state === "error") return;
    this.boot();
  }

  // ------------------------------------------------------------------ post window
  post(src, text) {
    for (const line of String(text).split("\n")) {
      if (!line) continue;
      this.log.push(`[${src}] ${line}`);
      if (this.log.length > 1500) this.log.splice(0, this.log.length - 1500);
      if (FAIL_RE.test(line)) { console.warn(`[SuperCollider] ${line}`); this.counts.failures.push(line); }
      if (UNDERRUN_RE.test(line)) this.counts.underrunLines++;
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
    // sclang → scsynth. THE REPLIES: the parser's five reply addresses are the page's, taken off this wire.
    // THE ZEROING: a /b_zero of a ring holds that ring's uploads until scsynth says /done.
    // THE SECOND /notify (ocean PORTING_LOG §6): this scsynth build dies on a repeated registration; a repeat is
    // answered here with scsynth's own first reply.
    let registered = false, notifyReply = null;
    lang.onOsc = (osc) => {
      if (!live()) return;
      const addr = oscAddress(osc);
      if (this.replyAddrs.has(addr)) { const m = parseOsc(osc); if (m) this.reply(m.address, m.args); return; }
      if (addr === "/b_zero") { const m = parseOsc(osc); if (m && this.bufnums.has(m.args[0])) this.holdUploads(m.args[0]); }
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
      if (oscAddress(r) === "/done") {
        const m = parseOsc(r);
        if (m && m.args[0] === "/b_zero") this.releaseUploads(m.args[1], "done");
        if (m && m.args[0] === "/notify" && !notifyReply) notifyReply = asBytes(r).slice();
      }
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
  preload() {
    if (this._preload) return this._preload;
    this._preload = (async () => {
      if (!self.crossOriginIsolated) throw new Error("this browser did not allow SharedArrayBuffer");
      const t0 = performance.now();
      const schema = fetch(SCHEMA_URL).then((r) => { if (!r.ok) throw new Error(`svk_messages.json: HTTP ${r.status}`); return r.json(); });
      const code = Promise.all(SC_FILES.map((n) => fetch(new URL(n, SC_DIR)).then((r) => {
        if (!r.ok) throw new Error(`${n}: HTTP ${r.status}`);
        return r.text();
      })));
      const [sch, c] = await Promise.all([schema, code, this.instantiate()]);
      this.schema = sch;
      this.replyAddrs = new Set(Object.keys(sch.engine_to_page));
      this.code = c;
      this.info.preload_s = +((performance.now() - t0) / 1000).toFixed(2);
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
          console.warn(`[dark_svartsengi] SuperCollider did not start (${e.message}); starting a fresh one`);
          this.retire();
          await this.instantiate();
        }
      }
    })().catch((e) => { console.error(e); this.setState("error", e.message); });
    return this._boot;
  }
  start() {                                       // one attempt: boot → synthdefs → parser → three rings → ready
    const my = ++this.attempt, alive = () => this.attempt === my;
    return new Promise((resolve, reject) => {
      this.crash = reject;
      (async () => {
        const t0 = performance.now();
        this.setState("booting");
        const [boot, synthdefs, parse] = this.code;
        this.held = []; this.bufnums.clear(); this.rings = {};
        this.bootAllowed = my;
        this.sclang.runCode(boot);                // s.waitForBoot → bootServer() → scsynth in an AudioWorklet
        await this.poll("~webBooted == true", 30000, 300, alive);
        if (!alive()) return;
        this.sclang.runCode(synthdefs);           // the 9 SynthDefs (W2's Array) .add + s.sync
        await this.poll("~webSynthsReady == true", 25000, 300, alive);
        if (!alive()) return;
        this.sclang.runCode(parse);               // svk_cook inlined + the OSCdefs, rings, voices; it says /svk_ready ×3
        await this.poll("OSCdef.all[\\svkTilt].notNil and: { ~svkVoices.notNil and: { ~svkVoices[\\spatial].notNil } }", 20000, 300, alive);
        if (!alive()) return;
        for (let k = 0; k < 50 && !this.ringsKnown(); k++) await new Promise((r) => setTimeout(r, 100));
        if (!this.ringsKnown()) throw new Error("the parser never announced its three Ground rings (/svk_bufinfo)");
        const opts = (await this.query("[s.options.numWireBufs, s.options.memSize, s.options.numBuffers, s.sampleRate, ~svkK[\\RING], ~svkK[\\BLOCK]]"))
          .replace(/[\[\]\s]/g, "").split(",").map(Number);
        [this.info.numWireBufs, this.info.memSize_kB, this.info.numBuffers, this.info.sampleRate, this.info.RING, this.info.BLOCK] = opts;
        for (let c = 0; c < N_RINGS; c++) {
          if (this.rings[c].frames !== this.info.RING) throw new Error(`ring ${c} has ${this.rings[c].frames} frames, ~svkK says ${this.info.RING}`);
        }
        const nodes = toDestination.filter((n) => n instanceof AudioWorkletNode);
        this.node = nodes[nodes.length - 1] || null;
        this.ctx = this.node ? this.node.context : null;
        if (this.ctx && this.ctx.state !== "running") { try { await this.ctx.resume(); } catch (_) {} }
        this.info.boot_s = +((performance.now() - t0) / 1000).toFixed(2);
        this.info.rings = JSON.parse(JSON.stringify(this.rings));
        this.state = "ready";
        const held = this.held; this.held = [];
        // SC's own first words (ready ×3, bufinfo ×3: an engine that has just booted), then the socket opens. The
        // page reads an unprompted /svk_ready "cook" as "the engine (re)booted": it replays its state and re-cues a
        // Ground that was meant to play (a play pressed while SC was starting), then it says hello on open.
        if (this.sock && !this.sock.opened) this.sock.open(held);
        else for (const m of held) this.toPage(m);
        this.setState("ready");
      })().then(resolve, reject);
    }).finally(() => { if (alive()) this.crash = null; });
  }
  ringsKnown() { for (let c = 0; c < N_RINGS; c++) if (!this.rings[c]) return false; return true; }
  retire() {                                      // silence a failed SuperCollider and cut its wires
    this.attempt++;
    this.crash = null;
    try { this.sclang.runCode("AppClock.clear; SystemClock.clear; TempoClock.default.clear;"); } catch (_) {}
    this.scsynth = this.sclang = null;
    for (const n of toDestination) { try { n.disconnect(); } catch (_) {} try { n.context.close(); } catch (_) {} }
    toDestination.length = 0;
    this.node = this.ctx = this._an = null;
    this.bufnums.clear(); this.rings = {};
    for (const z of this.zeroPending.values()) clearTimeout(z.timer);
    this.zeroPending.clear();
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
  }
  // page → SC (bridge.py relay(): json_to_osc, then sclang)
  fromPage(d) {
    if (!d || typeof d !== "object") return;
    const c = this.counts.fromPage;
    c[d.type] = (c[d.type] || 0) + 1;
    if (d.type === "setn") {                      // the desktop carrier, if a page ever sends it: same upload path
      const raw = atob(d.data_b64_f32 || ""), u8 = new Uint8Array(raw.length);
      for (let k = 0; k < raw.length; k++) u8[k] = raw.charCodeAt(k);
      this.upload(+d.bufnum, +d.ring_off, new Float32Array(u8.buffer));
      return;
    }
    if (this.state !== "ready") { this.counts.droppedBeforeReady++; return; }
    let m;
    try { m = toOsc(this.schema, d); }
    catch (e) { this.counts.relayErrors++; this.post("web", `relay error: ${e.message}`); return; }
    if (!m) return;                               // not a contract message (bridge.py drops it too)
    this.sclang.sendOsc(oscMessage(m[0], m[1]));
  }
  // SC → page (bridge.py osc_in(): osc_to_json, then the socket)
  reply(addr, args) {
    const m = fromOsc(this.schema, addr, args);
    if (m.type === "bufinfo" && Number.isInteger(m.bufnum)) {
      this.bufnums.add(m.bufnum);
      this.rings[m.chan] = { bufnum: m.bufnum, frames: m.frames };
    }
    if (this.state !== "ready") { this.held.push(m); if (this.held.length > 200) this.held.shift(); return; }
    this.toPage(m);
  }
  // to the page, never from inside a SuperCollider callback: the page answers synchronously (a want → an upload)
  toPage(m) {
    const c = this.counts.toPage;
    c[m.type] = (c[m.type] || 0) + 1;
    this.outbox.push(m);
    if (this._flushQueued) return;
    this._flushQueued = true;
    queueMicrotask(() => {
      this._flushQueued = false;
      const out = this.outbox; this.outbox = [];
      for (const x of out) { try { if (this.sock) this.sock.deliver(x); } catch (e) { console.warn("[dark_svartsengi] page handler", e); } }
    });
  }

  // ------------------------------------------------------------------ the Ground ring (the desktop's setn carrier)
  upload(bufnum, ringOff, f32) {
    if (this.state !== "ready" || !this.scsynth || !this.bufnums.has(bufnum)) {
      this.counts.setnRefused++;
      if ([1, 10, 100].includes(this.counts.setnRefused)) this.post("web", `upload refused #${this.counts.setnRefused}: bufnum ${bufnum} was never announced by /svk_bufinfo`);
      return;
    }
    const z = this.zeroPending.get(bufnum);
    if (z) { z.queue.push([ringOff, f32]); this.counts.setnHeldForZero++; return; }
    this.sendSetn(bufnum, ringOff, f32);
  }
  sendSetn(bufnum, ringOff, f32) {
    for (let o = 0; o < f32.length; o += SETN_CHUNK) {
      const n = Math.min(SETN_CHUNK, f32.length - o);
      this.scsynth.sendOsc(setnMessage(bufnum, ringOff + o, f32, o, n));
      this.counts.setnMsgs++;
    }
    this.counts.setnBlocks++;
    this.counts.setnFloats += f32.length;
  }
  holdUploads(bufnum) {
    let z = this.zeroPending.get(bufnum);
    if (!z) { z = { n: 0, queue: [], timer: null }; this.zeroPending.set(bufnum, z); }
    z.n++;
    clearTimeout(z.timer);
    z.timer = setTimeout(() => { this.counts.zeroWaitTimeouts++; this.releaseUploads(bufnum, "timeout", true); }, ZERO_WAIT_MS);
  }
  releaseUploads(bufnum, why, all = false) {
    const z = this.zeroPending.get(bufnum);
    if (!z) return;
    z.n = all ? 0 : z.n - 1;
    if (z.n > 0) return;
    clearTimeout(z.timer);
    this.zeroPending.delete(bufnum);
    if (!this.scsynth) return;
    for (const [off, f32] of z.queue) this.sendSetn(bufnum, off, f32);
  }

  // ------------------------------------------------------------------ measurement (the checks, debugging)
  get audioNodes() { return toDestination; }
  stats() {
    return { state: this.state, error: this.error, silent: SILENT, info: this.info, rings: this.rings, bufnums: [...this.bufnums],
             counts: JSON.parse(JSON.stringify(this.counts)), zeroPending: this.zeroPending.size };
  }
  async underruns() {                             // SC's own count per playing channel (the parser's g[\under])
    const t = await this.query("~svkG.collect { |g| if (g.isNil) { -1 } { g[\\under] } }");
    return t.replace(/[\[\]\s]/g, "").split(",").map(Number);
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
