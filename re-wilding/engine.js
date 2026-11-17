// =============================================================================
//  dark_re_wilding — web build · the sound engine (lives in the shell page, index.html)
//
//  A COPY of dark_ocean's engine.js, adapted (D8, Miguel 2026-09-30: every web deployment fully
//  independent). Source: projects/designs/dark_ocean/web_implementation/engine.js as of 2026-09-30
//  (sha256 fbd3…, see build/build_info.json "engine_js_source"). The design-agnostic part is kept as it
//  was — instantiate() with the /notify guard, preload/boot/retry/retire, firstGesture, poll, levels —
//  so a later fix to the guard is carried to both by hand.
//
//  SuperCollider's own WebAssembly build runs sclang AND scsynth in this tab. sclang runs the design's
//  own sc/dark_re_wilding_synths.scd, parse_dark_re_wilding.scd and rw_preview.scd (copied by
//  build_web.py, unmodified); the boot file is replaced by PRELUDE (it cannot run in a tab).
//
//  Unlike dark_ocean, the bridge here COOKS: viz/rw_core.py (the design's bridge core since web Phase 1,
//  viz/HANDOFF_WEB_2026-10-01.md) runs unchanged in Pyodide (core/rw_core.js, core/rw_web.py) and owns the
//  mix, the subset, the rooms, the last point, the legend's push tier AND the master volume/mute, which it
//  echoes to every page exactly as the desktop bridge does. This engine owns what the desktop shell does:
//  SuperCollider's life cycle, the replay after a boot, the baked init/spectral_day answers, the clips.
//  Sound starts at the visitor's first click or key press (ocean rule, D10); the first press sounds.
// =============================================================================
import { oscMessage, oscParse, f, i, s } from "./osc.js";
import { RwCore } from "./core/rw_core.js";

const BASE = new URL("./", import.meta.url);
const ENGINE_DIR = new URL("./engine/", import.meta.url);
const SC_DIR = new URL("./sc/", import.meta.url);
const DATA_DIR = new URL("./data/", import.meta.url);
const CORE_DIR = new URL("./core/", import.meta.url);
// the design's three runtime files (copied unmodified) + the web-only clip loader (sc/web_clips.scd, hand-written)
const SC_FILES = ["dark_re_wilding_synths.scd", "parse_dark_re_wilding.scd", "rw_preview.scd", "web_clips.scd"];
// The prelude that replaces sc/dark_re_wilding_boot.scd. memSize 2048: this build's scsynth heap is 16 MiB,
// fixed; the library's default pool (8192) leaves no room for one clip buffer and the desktop's 65536 does
// not boot (lab/PORTING_LOG.md §2.3).
const MEMSIZE_KB = 2048;
const PRELUDE = `s = Server.default; s.options.numOutputBusChannels = 2; s.options.numInputBusChannels = 0;
  s.options.numBuffers = 1024; s.options.memSize = ${MEMSIZE_KB}; s.waitForBoot { "[web] server booted".postln };`;
const CHANNELS = ["air", "water", "air+water"];  // baked init payloads: data/init_<channel>.json.gz
const CLIP_CHUNK = 4096;                         // floats per /b_setn (probe: 59 messages, 245 ms for a 5 s clip)
// The web's master start (D10: the page's slider started at 0.8, ♪ on). Seeded into the core before the first
// page attaches (rw_web.boot); the core owns and echoes the master from then on, by SC's own rule (handoff §4).
// Read here only for the seconds before the core is up. SC's own start is 1.0 (TASKS P51, Miguel's call).
const WEB_MASTER = { vol: 0.8, mute: 0 };

// This build's scsynth.getWorkletNode() throws (ocean PORTING_LOG §2, gotcha 2): remember whichever
// AudioWorkletNode connects to the speakers, that is scsynth.
const toDestination = [];
const nativeConnect = AudioNode.prototype.connect;
AudioNode.prototype.connect = function (dest, ...rest) {
  if (dest instanceof AudioDestinationNode) toDestination.push(this);
  return nativeConnect.call(this, dest, ...rest);
};

const asBytes = (p) => (p instanceof Uint8Array ? p : new Uint8Array(p.buffer || p));
const head = (p, n) => { const b = asBytes(p); let t = ""; for (let k = 0; k < Math.min(n, b.length); k++) t += String.fromCharCode(b[k]); return t; };
function notifyFlag(p) {                         // "/notify\0" ",i…" + int32 flag → the flag; anything else → null
  const b = asBytes(p);
  if (b.length < 16 || head(b, 8) !== "/notify\0" || !head(b, 10).endsWith(",i")) return null;
  return (b[12] << 24) | (b[13] << 16) | (b[14] << 8) | b[15];
}
const isDoneNotify = (p) => /^\/done\0+,s[^\0]*\0+\/notify\0/.test(head(p, 32));
const typedArgs = (args) => args.map(([t, v]) => (t === "f" ? f(v) : t === "i" ? i(v) : s(v)));
const gunzipJson = (r) => new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).json();

const CHIP = {                                   // the header chip while the engine is not sounding (web_bridge.js)
  loading: ["loading SuperCollider…", false],
  idle: ["sound: press ◼ mute to enable", false],
  armed: ["click anywhere to start the sound", false],
  booting: ["starting SuperCollider…", false],
  ready: [null, true],                           // the page's own chip text stands
  error: ["sound did not start · reload the page to try again", false],
};

// The corpus layer's clips (Phase 5). The desktop's ~rwGetClip reads a file; here sc/web_clips.scd asks the
// page (/rw_clip_want bufnum path) and the page fills the buffer: fetch (the build's Opus, or AAC where Opus
// does not decode) → decodeAudioData at the engine's rate → /b_alloc, wait for its /done, /b_setn in chunks →
// /rw_clip_ready. The bytes of the last few clips are prefetched the moment /rw_corpus names them (the
// parser asks for the clip ≈ 4–6 s later), so the fill is the only latency on the timeline.
class Clips {
  constructor(engine) {
    this.engine = engine;
    this.index = null; this.fmt = null;
    this.bytes = new Map();                      // basename → Promise<ArrayBuffer>
    this.pcm = new Map();                        // basename → Promise<Float32Array> (channel 0, engine rate)
    this.order = []; this.max = 8;
    this.waits = new Map();                      // bufnum → resolve, for /done /b_alloc
    this.stats = { index: 0, format: null, wants: [], failed: [] };
  }
  async loadIndex() {
    try { const r = await fetch(new URL("clips/index.json", BASE)); this.index = r.ok ? await r.json() : null; } catch (_) { this.index = null; }
    try { this.fmt = document.createElement("audio").canPlayType('audio/ogg; codecs="opus"') ? "opus" : "m4a"; } catch (_) { this.fmt = "m4a"; }
    this.stats.index = this.index ? Object.keys(this.index).length : 0;
    this.stats.format = this.fmt;
  }
  key(path) { return String(path).split("/").pop(); }
  url(path) { const e = this.index && this.index[this.key(path)]; return e ? new URL(`clips/${e.id}.${this.fmt}`, BASE) : null; }
  prefetch(path) {
    const k = this.key(path);
    if (!this.index || this.bytes.has(k)) return;
    const u = this.url(path);
    if (!u) return;
    this.bytes.set(k, fetch(u).then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); }));
    this.order.push(k);
    while (this.order.length > this.max) { const old = this.order.shift(); this.bytes.delete(old); this.pcm.delete(old); }
  }
  decoded(path) {
    const k = this.key(path);
    if (!this.pcm.has(k)) {
      this.prefetch(path);
      const p = this.bytes.get(k);
      if (!p) return Promise.reject(new Error("not in the clip index"));
      this.pcm.set(k, p.then((buf) => this.engine.ctx.decodeAudioData(buf.slice(0))).then((a) => a.getChannelData(0)));
    }
    return this.pcm.get(k);
  }
  allocated(bufnum) {                            // resolves on scsynth's /done /b_alloc <bufnum> (async command)
    return new Promise((res, rej) => {
      this.waits.set(bufnum, res);
      setTimeout(() => { if (this.waits.get(bufnum) === res) { this.waits.delete(bufnum); rej(new Error("/b_alloc never answered")); } }, 8000);
    });
  }
  onReply(p) {
    if (p.address === "/done" && p.args[0] && p.args[0].v === "/b_alloc" && p.args[1]) {
      const r = this.waits.get(p.args[1].v);
      if (r) { this.waits.delete(p.args[1].v); r(); }
    }
  }
  async want(bufnum, path) {
    const t0 = performance.now(), rec = { path: this.key(path), bufnum };
    try {
      const pcm = await this.decoded(path);
      rec.decoded_ms = Math.round(performance.now() - t0); rec.frames = pcm.length;
      const done = this.allocated(bufnum);
      this.engine.sendSynth("/b_alloc", [i(bufnum), i(pcm.length), i(1)]);
      await done;
      for (let o = 0; o < pcm.length; o += CLIP_CHUNK) {
        const n = Math.min(CLIP_CHUNK, pcm.length - o), args = [i(bufnum), i(o), i(n)];
        for (let k = 0; k < n; k++) args.push(f(pcm[o + k]));
        this.engine.sendSynth("/b_setn", args);
      }
      rec.ready_ms = Math.round(performance.now() - t0);
      this.engine.send("/rw_clip_ready", [i(bufnum), i(pcm.length), s(path)]);
    } catch (e) {
      rec.error = e.message;
      this.stats.failed.push(rec);
      this.engine.send("/rw_clip_fail", [s(path)]);
    }
    this.stats.wants.push(rec);
    if (this.stats.wants.length > 200) this.stats.wants.splice(0, this.stats.wants.length - 200);
  }
}

class DarkEngine {
  constructor() {
    this.clips = new Clips(this);
    this.state = "loading";
    this.error = null;
    this.pages = new Set();                      // {page, win, id, holding}
    this.log = [];
    this.watchers = [];
    this.attempt = 0;
    this.bootAllowed = 0;
    this.nextClient = 1;
    this.inits = {};                             // channel → the baked init payload (fetched once)
    this.oscLog = [];                            // the core's OSC as typed args, for the checks (last 2000)
    this.core = new RwCore({
      osc: (addr, args) => this.fromCore(addr, args),
      deliver: (client, m) => { for (const p of this.pages) if (p.id === client) this.deliver(p, m); },
      broadcast: (m) => this.broadcast(m),
      post: (t) => this.post("core", t),
      master: WEB_MASTER,
    });
    if (typeof document !== "undefined") {
      for (const ev of ["pointerdown", "keydown"]) document.addEventListener(ev, () => this.firstGesture(), true);
    }
    if (typeof window !== "undefined") {
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
  }
  // the master the core holds ({vol, mute}); before the core is up, the web's start
  master() { return (this.core.ready && this.core.master()) || WEB_MASTER; }
  paintChip(p) {
    const key = this.state === "idle" && !this.master().mute ? "armed" : this.state;
    const [text, on] = CHIP[key] || [this.state, false];
    try { p.page.setChip(text, on); } catch (_) {}
  }
  pendingText() {
    if (this.master().mute) return null;
    if (this.state === "loading") return "sound on · SuperCollider is loading…";
    if (this.state === "idle") return "sound on · click anywhere or press a key to start it";
    if (this.state === "booting") return "sound on · starting SuperCollider…";
    return null;
  }
  firstGesture() {
    if (this._boot || this.state === "error" || this.master().mute) return;
    this.boot();
  }

  // ------------------------------------------------------------------ post window
  post(src, text) {
    for (const line of String(text).split("\n")) {
      if (!line) continue;
      this.log.push(`[${src}] ${line}`);
      if (this.log.length > 800) this.log.splice(0, this.log.length - 800);
      if (/ERROR|FAILURE|not installed|failed/.test(line)) console.warn(`[${src}] ${line}`);
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
  // Readiness is read from SuperCollider's own state, never from the wording of its post lines.
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
  async instantiate() {
    const locateFile = (p) => new URL(p, ENGINE_DIR).href;
    const [{ default: ScSynth }, { default: ScLang }] = await Promise.all([
      import(new URL("scsynth.js", ENGINE_DIR).href), import(new URL("sclang.js", ENGINE_DIR).href),
    ]);
    let synth = null;
    const live = () => synth !== null && this.scsynth === synth;
    const printErr = (t) => {
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
    // THE SECOND /notify (ocean PORTING_LOG §6): this scsynth build dies on a repeated `/notify 1`.
    // Only the first reaches scsynth; a repeat is answered here with scsynth's own first reply.
    let registered = false, notifyReply = null;
    lang.onOsc = (osc) => {
      if (!live()) return;
      this.trace("→", osc);
      if (head(osc, 14) === "/rw_clip_want\0") {                // sc/web_clips.scd asks the page for a clip: never the server's
        const p = oscParse(osc);
        if (p && p.args.length >= 2) this.clips.want(p.args[0].v, p.args[1].v);
        return;
      }
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
    synth.onOscReply = (r) => {
      if (!live()) return;
      this.trace("←", r);
      if (!notifyReply && isDoneNotify(r)) notifyReply = asBytes(r).slice();
      if (head(r, 6) === "/done\0") { const p = oscParse(r); if (p) this.clips.onReply(p); }   // /b_alloc completions
      lang.sendOsc(r);
    };
    window.bootServer = (opts) => {
      if (this.bootAllowed !== this.attempt) return;
      this.bootAllowed = 0;
      setTimeout(() => { if (live()) synth.boot(opts); }, 100);
    };
    lang.bootInterpreter();
    await this.poll("true", 45000, 400);
  }
  preload() {
    if (this._preload) return this._preload;
    this._preload = (async () => {
      if (!self.crossOriginIsolated) throw new Error("this browser did not allow SharedArrayBuffer");
      const core = this.core.load(DATA_DIR, CORE_DIR).catch((e) => { this.setState("error", "the bridge core did not load: " + e.message); throw e; });
      this.clips.loadIndex();
      await this.instantiate();
      this.code = await Promise.all(SC_FILES.map((n) => fetch(new URL(n, SC_DIR)).then((r) => {
        if (!r.ok) throw new Error(`${n}: HTTP ${r.status}`);
        return r.text();
      })));
      this.setState("idle");
      await core;
    })().catch((e) => { console.error(e); if (this.state !== "error") this.setState("error", e.message); throw e; });
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
          console.warn(`[dark_re_wilding] SuperCollider did not start (${e.message}); starting a fresh one`);
          this.retire();
          await this.instantiate();
        }
      }
    })().catch((e) => { console.error(e); this.setState("error", e.message); });
    return this._boot;
  }
  start() {                                      // one attempt: server → synths → parser → preview → state
    const my = ++this.attempt, alive = () => this.attempt === my;
    return new Promise((resolve, reject) => {
      this.crash = reject;
      (async () => {
        this.setState("booting");
        const [synths, parse, preview, webClips] = this.code;
        this.bootAllowed = my;
        this.sclang.runCode(PRELUDE);            // s.waitForBoot → bootServer() → scsynth in an AudioWorklet
        await this.poll("s.serverRunning", 30000, 300, alive);
        if (!alive()) return;
        this.sclang.runCode(synths);
        this.sclang.runCode('~webSynced = false; fork { s.sync; ~webSynced = true };');
        await this.poll("~webSynced == true", 20000, 300, alive);            // the five SynthDefs are on the server
        if (!alive()) return;
        this.sclang.runCode(parse);              // after the server is up: parse:32 sets the master bus at load
        await this.poll("OSCdef.all[\\rwPoint].notNil and: { OSCdef.all[\\rwIdentity].notNil }", 20000, 300, alive);
        if (!alive()) return;
        this.sclang.runCode(preview);
        await this.poll("OSCdef.all[\\rwPreview].notNil", 20000, 300, alive);
        if (!alive()) return;
        this.sclang.runCode(webClips);           // web only: ~rwGetClip through the page (sc/web_clips.scd)
        await this.poll("OSCdef.all[\\rwClipReady].notNil", 10000, 300, alive);
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
  retire() {
    this.attempt++;
    this.crash = null;
    try { this.sclang.runCode("AppClock.clear; SystemClock.clear; TempoClock.default.clear;"); } catch (_) {}
    this.scsynth = this.sclang = null;
    for (const n of toDestination) { try { n.disconnect(); } catch (_) {} try { n.context.close(); } catch (_) {} }
    toDestination.length = 0;
    this.node = this.ctx = null;
  }
  // SuperCollider boots with its master bus at 1 and its own mix at 1 (WEB_PLAN §2.3): mute FIRST, then
  // the core's state (the mix, the last point with its identity), then the master the CORE holds, by SC's
  // own rule (parse:286-289): `vol` sets the bus and un-mutes, `mute 1` silences it keeping the volume,
  // `mute 0` would reset the volume to 1 — so the volume goes out, and mute 1 after it when the core says
  // muted. (Before Phase 1 the volume went last unconditionally and a boot under a muted slider — a legend
  // hold starts SuperCollider — left it playing; handoff §4.)
  replay() {
    const S = this.master();
    this.send("/rw_master", [s("mute"), i(1)]);
    this.core.replay();
    this.send("/rw_master", [s("vol"), f(S.vol)]);
    if (S.mute) this.send("/rw_master", [s("mute"), i(1)]);
  }

  // ------------------------------------------------------------------ pages (the desktop shell's ws_handler)
  broadcast(m) { for (const p of this.pages) this.deliver(p, m); }
  deliver(entry, m) { try { entry.page.deliver(m); } catch (e) { console.error(e); } }

  async init(channel) {
    const ch = CHANNELS.includes(channel) ? channel : "air";
    if (!this.inits[ch]) {
      this.inits[ch] = fetch(new URL(`init_${encodeURIComponent(ch)}.json.gz`, DATA_DIR)).then((r) => {
        if (!r.ok) throw new Error(`init ${ch}: HTTP ${r.status}`);
        return gunzipJson(r);
      }).catch((e) => { delete this.inits[ch]; throw e; });
    }
    return this.inits[ch];
  }
  // spectral_day_reply, baked: {type, channel, month, kind, meta, days[]} per month; air+water reads air's file
  // (the bridge's own fallback) with the requested channel written back so hourview's stale check passes.
  async spectralDay(d) {
    const ch = String(d.channel || "air"), src = ch === "air+water" ? "air" : ch;
    const kind = d.kind === "mfcc" ? "mfcc" : "tol", month = String(d.month || "");
    const key = `${src}/${month}_${kind}`;
    if (!this._sd) this._sd = new Map();
    if (!this._sd.has(key)) {
      this._sd.set(key, fetch(new URL(`spectral_day/${key}.json.gz`, DATA_DIR)).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return gunzipJson(r);
      }).catch((e) => { this._sd.delete(key); return { type: "spectral_day", channel: src, month, kind, days: [], why: `no day-level data for ${month} on the web (${e.message})` }; }));
    }
    const m = { ...(await this._sd.get(key)) };
    m.channel = ch;
    return m;
  }
  attachPage(page, win) {
    const entry = { page, win, id: this.nextClient++, holding: false };
    this.pages.add(entry);
    win.addEventListener("pagehide", () => this.detachPage(entry));
    const gesture = () => {
      this.firstGesture();
      if (this.ctx && this.ctx.state !== "running") this.ctx.resume().catch(() => {});
    };
    win.document.addEventListener("pointerdown", gesture, true);
    win.document.addEventListener("keydown", gesture, true);
    this.paintChip(entry);
    return entry;
  }
  // the fake socket opened: what the shell's ws_handler sends first — init("air") from the baked file, then the
  // core attaches the page (it takes the sound if nobody holds it, re-sends the identity, echoes the master)
  async pageOpened(entry) {
    try { this.deliver(entry, await this.init("air")); } catch (e) { this.post("web", `init: ${e.message}`); }
    this.core.attach(entry.id);
  }
  detachPage(entry) {                            // pagehide (or a check closing a fake page): rooms go, a held chip is released
    if (!this.pages.delete(entry)) return;
    this.core.detach(entry.id);
  }
  fromPage(entry, d) {
    switch (d.type) {
      case "channel":                              // air <-> water switch: a fresh init payload for that channel
        this.init(d.channel).then((init) => this.deliver(entry, init)).catch((e) => this.post("web", `init: ${e.message}`));
        return;
      case "spectral_day":                         // baked per (channel, month, kind) by build_data.py; requester only
        this.spectralDay(d).then((m) => this.deliver(entry, m));
        return;
      case "master": {                           // the core relays it as /rw_master, keeps the state, echoes it to every page
        const unmute = d.mute != null && !(+d.mute > 0.5);
        if (unmute && this.state !== "ready") this.boot();   // an un-mute asks for sound: start SuperCollider
        this.core.dispatch(entry.id, d);
        if (d.mute != null && this.state !== "ready") for (const p of this.pages) this.paintChip(p);
        return;
      }
      case "legend":
        if (d.cmd === "hold") { entry.holding = true; if (this.state !== "ready") this.boot(); }
        else if (d.cmd === "release" || d.cmd === "end") entry.holding = false;
        break;
      default: break;
    }
    this.core.dispatch(entry.id, d);
  }
  // OSC from the bridge core: recorded for the checks; sent when SuperCollider is ready, dropped before
  // (the core keeps the state and replay() re-sends it once SuperCollider is up, as bridge.py's UDP would be lost too)
  fromCore(addr, args) {
    if (addr === "/dark_loop") return;             // nothing in v2 listens
    this.oscLog.push([addr, args]);
    if (this.oscLog.length > 2000) this.oscLog.splice(0, this.oscLog.length - 2000);
    if (this.state === "ready") {
      if (addr === "/rw_corpus") for (const [, p] of args) this.clips.prefetch(p);   // the bytes, before the parser asks
      this.send(addr, typedArgs(args));
    }
  }
  send(address, args) { if (this.sclang) this.sclang.sendOsc(oscMessage(address, args)); }     // → sclang's OSCdefs
  sendSynth(address, args) { if (this.scsynth) this.scsynth.sendOsc(oscMessage(address, args)); }   // → scsynth directly (buffers)

  // ------------------------------------------------------------------ recording + measurement
  audioTrack() {
    if (!this.ctx || !this.node) return null;
    if (!this._rec) { this._rec = this.ctx.createMediaStreamDestination(); nativeConnect.call(this.node, this._rec); }
    return this._rec.stream.getAudioTracks()[0] || null;
  }
  get audioNodes() { return toDestination; }
  trace(dir, pkt) {
    if (!this.oscTrace) this.oscTrace = [];
    if (this.oscTrace.length >= 400) return;
    try {
      const b = pkt instanceof Uint8Array ? pkt : new Uint8Array(pkt.buffer || pkt);
      let t = ""; for (let k = 0; k < Math.min(48, b.length); k++) { const c = b[k]; t += c >= 32 && c < 127 ? String.fromCharCode(c) : "."; }
      this.oscTrace.push(`${(performance.now() / 1000).toFixed(2)} ${this.attempt} ${dir} ${t}`);
    } catch (_) { this.oscTrace.push(`${dir} ?`); }
  }
  levels() {
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
