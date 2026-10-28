// Uncanny Listening — the Ableton Live link (brief §5, P5): the Dark Music Corpus Hub over a localhost WebSocket.
// Ported from projects/designs/dark_music_corpus/web_implementation/web_bridge.js (class Link, 2026-10-22) and its contract
// WS_CONTRACT.md v0.1: ws://127.0.0.1:9002/dmc, JSON {a, args} and batches {b: […]}, hello every 5 s until and after the
// ack, the schema as one batch (begin, key + info per key, end), rows rate-limited, /dmc/clip with a path relative to the
// folder opened in the page (set the same folder as DMC Corpus's root in Live).
// What this page sends (one schema block, "uncanny"): her descriptors for the 10 s segment (or the song) being played, the
// song's place on the PCA map, her label, k-means, the model's class and probability, agreement, nearness to the boundary.
// Browsers: Chrome asks once for local network access; Firefox links; Safari cannot link (mixed content) and says so.
// For the Live template (lab/LIVE_TEMPLATE.md, 2026-10-27): events go in a queue of their own, so a marker is never lost when
// a newer step replaces a pending one; a step may be a row only (no clip: the playhead entering the next segment of a song
// Live is already playing); the clip's gain carries the level matching of minimal pairs.
const IS_SAFARI = /^((?!chrome|chromium|crios|fxios|edg|opr|android).)*safari/i.test(navigator.userAgent);
const now = () => performance.now() / 1000;
const BLOCK = "uncanny", VERSION = "web-0.1";

export class Link {
  constructor(onStatus) {
    this.onStatus = onStatus; this.enabled = false; this.host = "127.0.0.1"; this.port = 9002; this.rate = 20; this.follow = false;
    this.ws = null; this.wsState = IS_SAFARI ? "safari" : "off"; this.lastAck = 0; this.hub = null; this.sent = []; this.pending = null;
    this.lastHello = 0; this.lastFull = 0; this.lastPred = null; this.schema = null; this.setId = "uncanny"; this.events = [];
    setInterval(() => this.pump(), 50); setInterval(() => this.onStatus(this.status()), 1000);
  }
  get connected() { return this.lastAck > 0 && now() - this.lastAck < 12; }
  configure({ enabled, port, rate, follow } = {}) {
    if (port != null && +port !== this.port) { this.port = +port; this.close(); this.lastAck = 0; if (this.enabled) this.open(); }
    if (rate != null) this.rate = Math.max(0.5, Math.min(60, +rate));
    if (follow != null) this.follow = !!follow;
    if (enabled != null) { this.enabled = !!enabled; if (this.enabled) { this.lastHello = 0; this.open(); } else { this.close(); this.events = []; this.pending = null; } }
    this.onStatus(this.status());
  }
  open() {
    if (this.ws) return;
    if (IS_SAFARI) { this.wsState = "safari"; return; }
    this.wsState = "connecting";
    let ws; try { ws = new WebSocket(`ws://${this.host}:${this.port}/dmc`); } catch (e) { this.wsState = "refused"; return; }
    this.ws = ws;
    ws.onopen = () => { this.wsState = "linked"; this.announce(); };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.a === "/dmc/ack") { const was = this.connected; this.lastAck = now(); if (!was) this.reannounce = true; }
      else if (m.a === "/dmc/hub") this.hub = { version: m.args[0], root_set: !!m.args[1] };
      else if (m.a === "/dmc/busy") this.wsState = "busy"; };
    ws.onclose = (e) => { this.ws = null; this.lastAck = 0;
      this.wsState = e.code === 4009 ? "busy" : e.code === 4003 ? "refused" : this.enabled ? "nohub" : "off";
      if (this.enabled) setTimeout(() => this.enabled && this.open(), 3000); };
    ws.onerror = () => {};
  }
  close() { if (this.ws) { try { this.ws.close(1000); } catch (_) {} } this.ws = null; this.wsState = IS_SAFARI ? "safari" : this.enabled ? "nohub" : "off"; }
  _send(a, args) { if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify({ a, args })); this.sent.push(now()); } }
  _batch(msgs) { if (this.ws && this.ws.readyState === 1 && msgs.length) { this.ws.send(JSON.stringify({ b: msgs })); for (let i = 0; i < msgs.length; i++) this.sent.push(now()); } }
  msgsPerS() { const t = now(); this.sent = this.sent.filter((x) => t - x < 1); return this.sent.length; }
  // the schema: keys [name, kind ("signal" | "symbol"), min, max, mean, std, n_classes, noise_class, family] + one info each
  setSchema(keys, infos, setId) { this.schema = { keys, infos }; this.setId = setId || this.setId; if (this.enabled) this.announce(); }
  announce() {
    if (!this.enabled) return;
    this._send("/dmc/hello", [this.setId, VERSION]);
    if (this.schema) {
      const b = [{ a: "/dmc/schema/begin", args: [BLOCK, this.schema.keys.length] }];
      for (const k of this.schema.keys) {
        b.push({ a: "/dmc/schema/key", args: [String(k[0]), String(k[1]), +k[2], +k[3], +k[4], +k[5], k[6] | 0, k[7] | 0, String(k[8] || "")] });
        b.push({ a: "/dmc/schema/info", args: [String(k[0]), String(this.schema.infos[k[0]] || "")] });
      }
      b.push({ a: "/dmc/schema/end", args: [BLOCK] }); this._batch(b);
    }
    this.lastHello = this.lastFull = now();
  }
  // one navigation step: {clipId, values: {key: value}, path (none: a row only), t0, t1, gain, cluster, pan, pred};
  // the last one wins at the row rate
  nav(step) { if (this.enabled) this.pending = step; }
  // an engine event (/dmc/event type key value clip_id), sent after the next row; never dropped (up to 64 queued)
  event(type, key, value, clipId) { if (this.enabled && this.events.length < 64) this.events.push([String(type), String(key), +value, String(clipId)]); }
  flush() {
    if (!this.enabled || !this.schema) return;
    if (!this.pending) { while (this.events.length) this._send("/dmc/event", this.events.shift()); return; }
    const s = this.pending; this.pending = null;
    const args = [BLOCK, String(s.clipId)];
    for (const k of this.schema.keys) { const v = s.values[k[0]]; args.push(k[0], k[1] === "symbol" ? Math.round(v ?? 0) : +(v ?? 0)); }
    this._send("/dmc/row", args);
    if (s.pred != null && s.pred !== this.lastPred) { this._send("/dmc/event", ["cluster_enter", `${BLOCK}.model`, s.pred, String(s.clipId)]); this.lastPred = s.pred; }
    while (this.events.length) this._send("/dmc/event", this.events.shift());
    if (s.path) this._send("/dmc/clip", [String(s.clipId), s.path, +s.t0, +s.t1, +(s.gain ?? 0.8), s.cluster | 0, +s.pan]);
  }
  pump() {
    const t = now();
    if (t - (this.lastFlush || 0) >= 1 / this.rate) { this.flush(); this.lastFlush = t; }
    if (!this.enabled || !this.ws || this.ws.readyState !== 1) return;
    if (this.reannounce) { this.reannounce = false; this.announce(); }
    else if (!this.connected && t - this.lastHello > 2) this.announce();
    else if (t - this.lastFull > 15) this.announce();
    else if (this.connected && t - this.lastHello > 5) { this._send("/dmc/hello", [this.setId, VERSION]); this.lastHello = t; }
  }
  status() { return { enabled: this.enabled, port: this.port, rate: this.rate, follow: this.follow, connected: this.connected, state: this.wsState, hub: this.hub, msgs: this.msgsPerS(), keys: this.schema ? this.schema.keys.length : 0 }; }
}
