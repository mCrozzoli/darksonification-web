// dark_svartsengi · source.js — the browser DataSource (CONTRACT v0.2 §7). W3.
//
// One interface, two implementations:
//   StaticSource  fetches viz/data/** (or the dev mock): tiles, events, wave chunks, spectrogram tiles, the latent map.
//                 It also emulates replay-as-live: a replay clock moves now(), data after now() is not yet "arrived",
//                 and subscribe() receives the events and frames as the clock passes them.
//   LiveSource    a StaticSource for the backfill + a WebSocket to pipeline/live_server.py (ws :8821), whose pushes
//                 {type:"frames"|"wave"|"events"} are merged into the same caches. now() = the newest time seen.
//
//   const src = await SvkSource.open({mode: "archive"})
//   src.manifest() · src.tiles(tier, source, t0, t1) · src.events(t0, t1) · src.wave(chan, t0, n) · src.subscribe(cb) · src.now()
//   extras the display needs (not in CONTRACT §7 yet; requested): src.spec(chan, t0, t1), src.latent(station),
//   src.waveSpan(chan, t0, t1), src.dataRoot, src.isMock
//
// Every request stays inside what the manifest says exists (station coverage, tile lists), so a view never asks for
// a file that is not there: an absent file is a gap the display names, not a 404 in the console.
window.SvkSource = (function () {
  "use strict";
  const HOUR = 3600, DAY = 86400;

  const pad2 = (n) => String(n).padStart(2, "0");
  function ymd(t) { const d = new Date(t * 1000); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`; }
  function hh(t) { return pad2(new Date(t * 1000).getUTCHours()); }
  const lowerBound = (a, x) => { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; };

  async function getJSON(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  }
  async function getBytes(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.arrayBuffer();
  }

  // ------------------------------------------------------------------------------------------------ a spectrogram in the page
  // W1 §15.1 (spec_files false): the same tile shape as W1's spectrogram files (CONTRACT §4.2: frames × bins, uint8, log-f
  // bins 0.2–50 Hz, 10·log10 PSD in counts²/Hz, a Hann window of 10.24 s centred on each frame), at one frame per 2 s
  // (half W1's rate: an hour costs ~1800 FFTs of 1024 points). Frames touching a gap are left at 0 and listed.
  const SPEC_NFFT = 1024, SPEC_DT = 2, SPEC_BINS = 96, SPEC_FLO = 0.2, SPEC_FHI = 50;
  function fft(re, im) {                                  // in place, radix 2
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let len = 2; len <= n; len <<= 1) {
      const a = (-2 * Math.PI) / len, wr = Math.cos(a), wi = Math.sin(a);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const ur = re[i + k], ui = im[i + k], vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
          re[i + k] = ur + vr; im[i + k] = ui + vi; re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
          const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
        }
      }
    }
  }
  async function specFromWave(c, range) {
    const fs = c.fs, x = c.x, nf = Math.floor(x.length / (fs * SPEC_DT)), N = SPEC_NFFT, half = N / 2;
    const win = new Float64Array(N); let wss = 0;
    for (let i = 0; i < N; i++) { win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)); wss += win[i] * win[i]; }
    const edges = Array.from({ length: SPEC_BINS + 1 }, (_, k) => SPEC_FLO * (SPEC_FHI / SPEC_FLO) ** (k / SPEC_BINS));
    const df = fs / N, db = new Float32Array(nf * SPEC_BINS), bad = [];
    const re = new Float64Array(N), im = new Float64Array(N), psd = new Float64Array(half + 1);
    for (let f = 0; f < nf; f++) {
      if (f % 150 === 149) await new Promise((r) => setTimeout(r, 0));    // yield: an hour is ~1800 FFTs, never one long block
      const ctr = Math.round((f + 0.5) * SPEC_DT * fs), s0 = ctr - half;
      let ok = true, mean = 0;
      for (let i = 0; i < N; i++) { const v = x[s0 + i]; if (!Number.isFinite(v)) { ok = false; break; } mean += v; }
      if (!ok || s0 < 0 || s0 + N > x.length) { bad.push(f); db.fill(NaN, f * SPEC_BINS, (f + 1) * SPEC_BINS); continue; }
      mean /= N;
      for (let i = 0; i < N; i++) { re[i] = (x[s0 + i] - mean) * win[i]; im[i] = 0; }
      fft(re, im);
      for (let k = 0; k <= half; k++) psd[k] = ((re[k] * re[k] + im[k] * im[k]) / (fs * wss)) * (k > 0 && k < half ? 2 : 1);
      for (let b = 0; b < SPEC_BINS; b++) {
        const k0 = Math.ceil(edges[b] / df), k1 = Math.floor(edges[b + 1] / df);
        let p = 0, n = 0;
        for (let k = k0; k <= k1 && k <= half; k++) { p += psd[k]; n++; }
        if (!n) { const fc = Math.sqrt(edges[b] * edges[b + 1]) / df, k = Math.min(half - 1, Math.floor(fc)), w = fc - k; p = psd[k] * (1 - w) + psd[k + 1] * w; n = 1; }
        db[f * SPEC_BINS + b] = 10 * Math.log10(Math.max(1e-20, p / n));
      }
    }
    if (range.lo == null) {                                  // the channel's range, fixed by its first hour
      const v = Array.from(db).filter(Number.isFinite).sort((a, b) => a - b);
      if (v.length) { range.lo = v[Math.floor(v.length * 0.02)]; range.hi = v[Math.min(v.length - 1, Math.floor(v.length * 0.998))]; }
    }
    const lo = range.lo ?? 0, hi = range.hi ?? 1, bytes = new Uint8Array(db.length);
    for (let i = 0; i < db.length; i++) bytes[i] = Number.isFinite(db[i]) ? Math.max(0, Math.min(255, Math.round(((db[i] - lo) / Math.max(1e-9, hi - lo)) * 255))) : 0;
    return { meta: { chan: c.chan, t0: c.t0 + SPEC_DT / 2, dt: SPEC_DT, n_frames: nf, f_lo: SPEC_FLO, f_hi: SPEC_FHI, n_bins: SPEC_BINS, log_f: true, db_lo: lo, db_hi: hi,
                     win_s: N / fs, layout: "frames x bins, row-major, uint8", computed: "in the page, from the wave (spec_files false)", invalid_frames: bad }, bytes };
  }

  // ------------------------------------------------------------------------------------------------ StaticSource
  class StaticSource {
    constructor(root, manifest) {
      this.dataRoot = root;
      this._m = manifest;
      this.isMock = !!manifest.mock;
      this.kind = "static";
      this._tile = new Map();       // "tier/source/idx" → Promise<tile|null>
      this._wave = new Map();       // "chan/YYYY-MM-DD/HH" → Promise<chunk|null>
      this._spec = new Map();
      this._subs = new Set();
      this._ev = null;              // columnar events, sorted by t
      this._replay = null;          // {tStart, speed, wall0}
      this._liveExtra = { events: [] };
    }
    manifest() { return this._m; }

    // ----- the clock: archive → t_end; replay-as-live → the replay clock
    now() {
      const r = this._replay;
      if (!r) return this._m.t_end;
      return Math.min(this._m.t_end, r.tStart + ((performance.now() - r.wall0) / 1000) * r.speed);
    }
    replayStart(tStart, speed) {
      this._replay = { tStart, speed, wall0: performance.now(), lastEmit: tStart };
      this._emit({ type: "clock", now: this.now(), mode: "replay_live" });
    }
    replayStop() { this._replay = null; this._emit({ type: "clock", now: this.now(), mode: "archive" }); }
    get replaying() { return !!this._replay; }
    get _clip() { return !!this._replay || this.kind === "live"; }
    // called by the page each frame: emits the events the replay clock has just passed (as a live feed would push them)
    pump() {
      const r = this._replay;
      if (!r || !this._ev) return;
      const now = this.now();
      if (now <= r.lastEmit) return;
      const E = this._ev, a = lowerBound(E.t, r.lastEmit), b = lowerBound(E.t, now);
      r.lastEmit = now;
      if (b > a) this._emit({ type: "events", rows: { i0: a, i1: b }, now });
      this._emit({ type: "clock", now, mode: "replay_live" });
    }
    subscribe(cb) { this._subs.add(cb); return () => this._subs.delete(cb); }
    _emit(msg) { for (const cb of this._subs) { try { cb(msg); } catch (e) { console.warn("[source] subscriber", e); } } }

    // ----- what exists
    station(id) { return (this._m.stations || []).find((s) => s.id === id) || null; }
    coverage(source) {
      if (source === "eq" || source === "gnss") return [[this._m.t0, this._m.t_end]];
      const s = this.station(source);
      return (s && s.coverage) || [];
    }
    covered(source, t0, t1) { return this.coverage(source).some(([a, b]) => b > t0 && a < t1); }
    // ----- the window rule (W1 §15.1, manifest.windows): the finest tiers (window_tiers: f10s, f1m) and the raw wave ship
    // only around each timeline event; outside, they are ABSENT BY DESIGN (absent_means), never silence: read the finest
    // full-record tier (f10m) there, or the researcher's folder or server (?data=…, O1). null = no window rule (all ships)
    windows() { const w = this._m.windows; return w && Array.isArray(w.spans) ? w : null; }
    inWindow(t0, t1) { const w = this.windows(); return !w || w.spans.some(([a, b]) => b > t0 && a < t1); }
    // the parts of [t0, t1) outside every window span
    outsideWindows(t0, t1) {
      const w = this.windows(); if (!w) return [];
      const out = []; let cur = t0;
      for (const [a, b] of [...w.spans].sort((p, q) => p[0] - q[0])) { if (b <= cur || a >= t1) continue; if (a > cur) out.push([cur, a]); cur = Math.max(cur, b); }
      if (cur < t1) out.push([cur, t1]);
      return out;
    }
    // the finest full-record tier this station has tiles for (f10m before f1h before f1d), or null
    baseTier(source) {
      const w = this.windows(); if (!w) return null;
      const tiers = (w.full_record_tiers || ["f10m", "f1h", "f1d"]).slice().sort((a, b) => (this._m.tiers[a] || {}).step - (this._m.tiers[b] || {}).step);
      return tiers.find((tr) => this._m.tiers[tr] && this._tileExists(tr, source)) || null;
    }
    _tileListed(tier, source, idx) {
      const T = this._m.tiles;                       // W1's index {tier: {source: [indices]}} wins when present
      if (T) return !!(T[tier] && T[tier][source] && T[tier][source].includes(idx));
      const s = this.station(source);
      if (s && s.tiles && s.tiles[tier]) return s.tiles[tier].includes(idx);
      const tr = this._m.tiers[tier];
      if (!tr) return false;
      if (tr.tile_rows == null) return idx === 0;
      const span = tr.step * tr.tile_rows;
      return this.covered(source, this._m.t0 + idx * span, this._m.t0 + (idx + 1) * span);
    }
    _tileExists(tier, source) {
      // eq has f1d/f1h/f10m in the mock; gnss only f1d. A manifest may list them; else assume the contract's tiers.
      const m = this._m;
      if (m.tiles) return !!(m.tiles[tier] && m.tiles[tier][source]);
      if (m.tile_sources && m.tile_sources[tier]) return m.tile_sources[tier].includes(source);
      if (source === "gnss") return tier === "f1d";
      if (source === "eq") return ["f1d", "f1h", "f10m"].includes(tier);
      return !!this.station(source);
    }
    _fetchTile(tier, source, idx, rel) {
      const key = rel || `tiles/${tier}/${source}/${idx}`;
      if (!this._tile.has(key)) {
        this._tile.set(key, getJSON(`${this.dataRoot}${key}.json`).catch((e) => { console.info("[source] tile absent", key); return null; }));
      }
      return this._tile.get(key);
    }

    // ----- tiles(tier, source, t0, t1) → {t:Float64Array, cols:{name:Array}, step, tier, source}, rows inside [t0, t1)
    async tiles(tier, source, t0, t1) {
      const tr = this._m.tiers[tier];
      const out = { tier, source, step: tr ? tr.step : null, t: new Float64Array(0), cols: {} };
      if (!tr || !this._tileExists(tier, source)) return out;
      const r = await this._rows(out, tier, t0, t1, (k) => this._tileListed(tier, source, k), (k) => `tiles/${tier}/${source}/${k}`);
      return this._lean && this._lean.tiers.has(tier) && source === this._lean.sta ? this._lean.keep(r) : r;
    }
    // a wave hour the manifest lists (the window rule: only inside the windows for a continuous station)
    waveListed(chan, t) { return this._chunkListed(chan, Math.floor(t / HOUR) * HOUR); }
    // dev only (?lean=1): W1's window rule applied to MELH's own day, to try the lean layout before any continuous station
    // exists: f10s / f1m rows and the HHZ wave hours only inside manifest.windows.spans, no spectrogram files (computed here)
    _leanFixture() {
      const m = this._m, W = this.windows(), sta = (m.stations || []).find((st) => st.kind === "seismic");
      if (!W || !sta) return;
      const inW = (a, b) => W.spans.some(([p, q]) => q > a && p < b), raw = (W.raw && W.raw.channels) || ["HHZ"];
      for (const [chan, v] of Object.entries(m.wave || {})) if (chan.startsWith(sta.id))
        v.hours = raw.includes(chan.split(".")[3]) ? (v.hours || []).filter((h) => { const t = Date.parse(h.replace("/", "T") + ":00:00Z") / 1000; return inW(t, t + HOUR); }) : [];
      for (const [chan, v] of Object.entries(m.spec || {})) if (chan.startsWith(sta.id)) v.hours = [];
      W.raw = { ...(W.raw || {}), spec_files: false };
      const tiers = new Set(W.window_tiers || ["f10s", "f1m"]);
      this._lean = { sta: sta.id, tiers, keep: (r) => {
        const idx = []; for (let i = 0; i < r.t.length; i++) if (inW(r.t[i], r.t[i] + (r.step || 1))) idx.push(i);
        const cols = {}; for (const [k, a] of Object.entries(r.cols)) cols[k] = idx.map((i) => a[i]);
        return { ...r, t: Float64Array.from(idx, (i) => r.t[i]), cols };
      } };
      m._fixture = (m._fixture ? m._fixture + " + " : "") + "lean (W1's window rule applied to MELH's day)";
    }
    // ----- body v2 (CONTRACT v0.11 §9): per-point tables viz/data/body/<kind>/<tier>/<tile>.json (same tiling as §4.2)
    // and room identities viz/data/body/identity/<kind>_<id>.json. Requests stay inside the manifest's body index when it
    // has one ({tiles:{kind:{tier:[…]}}, identities:[…]}); otherwise inside the data's coverage
    async bodyRows(kind, tier, t0, t1) {
      const tr = this._m.tiers[tier], B = this._m.body || {};
      const out = { tier, source: `body/${kind}`, kind, step: tr ? tr.step : null, t: new Float64Array(0), cols: {} };
      if (!tr || !this._m.body) return out;                  // no body section in the manifest = no Body v2 data yet: ask for nothing
      const listed = (k) => {
        const T = B.tables && B.tables[kind];                  // W1's index: tables.<kind> = {tier, tiles:[…]}
        if (B.tables) return !!T && T.tier === tier && (T.tiles || []).includes(k);
        const L = B.tiles && B.tiles[kind] && B.tiles[kind][tier];
        if (L) return L.includes(k);
        if (B.tiles) return false;
        if (tr.tile_rows == null) return k === 0;
        const span = tr.step * tr.tile_rows, a = this._m.t0 + k * span;
        return kind === "regime" ? (this._m.stations || []).some((st) => st.kind === "seismic" && this.covered(st.id, a, a + span)) : true;
      };
      return this._rows(out, tier, t0, t1, listed, (k) => `body/${kind}/${tier}/${k}`);
    }
    bodyIdentity(kind, id) {
      const B = this._m.body, name = `${kind}_${id}`;
      if (!B) return Promise.resolve(null);
      // W1's index: identity = [{kind, id, file, label, t0, t1, comb_hz, …}]
      const entry = Array.isArray(B.identity) ? B.identity.find((e) => e.kind === kind && +e.id === +id) : null;
      if (Array.isArray(B.identity) && !entry) return Promise.resolve(null);
      // a plain list of names, with or without ".json" (W1 ships both forms), is only consulted without the entries
      if (!entry && Array.isArray(B.identities) && !B.identities.some((n) => n === name || n === `${name}.json`)) return Promise.resolve(null);
      if (!this._ident) this._ident = new Map();
      const file = (entry && entry.file) || `body/identity/${name}.json`;
      // a failed read (a 404 while W1 re-exports) is not remembered, so the next ask tries again
      if (!this._ident.has(name)) this._ident.set(name, getJSON(`${this.dataRoot}${file}`).then((j) => ({ ...j, label: j.label ?? (entry && entry.label) }))
        .catch(() => { this._ident.delete(name); return null; }));
      return this._ident.get(name);
    }
    async _rows(out, tier, t0, t1, listed, rel) {
      const tr = this._m.tiers[tier];
      const lim = this._clip ? Math.min(t1, this.now()) : t1;
      const lo = Math.max(t0, this._m.t0), hi = Math.min(lim, this._m.t_end);
      if (hi <= lo) return out;
      let idxs;
      if (tr.tile_rows == null) idxs = [0];
      else {
        const span = tr.step * tr.tile_rows;
        const a = Math.floor((lo - this._m.t0) / span), b = Math.floor((hi - 1e-6 - this._m.t0) / span);
        idxs = [];
        for (let k = a; k <= b; k++) if (listed(k)) idxs.push(k);
        if (idxs.length > 400) idxs = idxs.slice(0, 400);      // a guard, never reached at the level each tier serves
      }
      if (tr.tile_rows == null && !listed(0)) idxs = [];
      const tiles = (await Promise.all(idxs.map((k) => this._fetchTile(tier, null, k, rel(k))))).filter(Boolean);
      const ts = [], cols = {};
      for (const tl of tiles) {
        const i0 = Math.max(0, Math.floor((lo - tl.t0) / tl.step)), i1 = Math.min(tl.n, Math.ceil((hi - tl.t0) / tl.step));
        for (const c of tl.cols) if (!cols[c]) cols[c] = [];
        for (let i = i0; i < i1; i++) {
          ts.push(tl.t0 + i * tl.step);
          for (const c of tl.cols) cols[c].push(tl.data[c][i]);
        }
      }
      out.t = Float64Array.from(ts);
      out.cols = cols;
      return out;
    }

    // ----- events: all rows are loaded once (CONTRACT §4.2: 34,102 rows, columnar)
    async loadEvents() {
      if (this._ev) return this._ev;
      const j = await getJSON(`${this.dataRoot}events/eq.json`);
      const d = j.data || j, n = (d.t || []).length;
      const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => d.t[a] - d.t[b]);
      const pick = (c, F) => { const a = F ? new F(n) : new Array(n); for (let k = 0; k < n; k++) { const v = d[c] ? d[c][order[k]] : null; a[k] = F ? (v == null ? NaN : v) : v; } return a; };
      this._ev = { n, t: pick("t", Float64Array), mag: pick("mag", Float32Array), depth_km: pick("depth_km", Float32Array),
                   lat: pick("lat", Float32Array), lon: pick("lon", Float32Array), fc_hz: pick("fc_hz", Float32Array), id: pick("id") };
      return this._ev;
    }
    // ----- v0.13: the eruption timeline (events/eruptions.json) and its fountain series (events/fountains/<id>.json).
    // The list is read only when the manifest declares it (manifest.eruptions = {file} or an inline row array), so a
    // manifest without it asks for nothing. The rows land on the manifest as M._eruptions (cook.eruptionList reads them).
    // ?fixture=<dir> (dev only): rows and station positions from viz/dev_mock/<dir>/, never viz/data.
    async loadEruptions() {
      const m = this._m, fx = new URLSearchParams(location.search).get("fixture"), dec = m.eruptions || m.events_eruptions || (m.events && m.events.eruptions);
      const fxRoot = fx && /^[\w-]+$/.test(fx) ? `dev_mock/${fx}/` : null;
      let rows = null;
      if (fxRoot) {
        rows = await getJSON(`${fxRoot}eruptions.json`).catch(() => null);
        const st = await getJSON(`${fxRoot}stations.json`).catch(() => null);      // stand-in positions, to test the drawing
        if (st) for (const s of m.stations || []) { const o = (st.stations || st).find((x) => x.id === s.id); if (o) Object.assign(s, o); }
        m._fixture = fx;
      } else if (Array.isArray(dec)) rows = dec;
      else if (dec && dec.file) rows = await getJSON(`${this.dataRoot}${dec.file}`).catch((e) => { console.info("[source] eruptions absent", e.message); return null; });
      m._eruptionsCmp = (rows && !Array.isArray(rows) && rows.comparison) || null;   // W1's own matched / missed / false_alarms
      rows = rows && (rows.rows || rows.eruptions || rows.data || rows);
      m._eruptions = Array.isArray(rows) ? rows : null;
      return m._eruptions;
    }
    // one eruption's fountain series: only a file the manifest's fountains index names (ref = that entry, {id, file, …};
    // cook.eruptionList hands it over as e.fnt), never a guessed path, so never a 404
    fountains(ref) {
      if (!ref || !ref.file) return Promise.resolve(null);
      this._fnt = this._fnt || new Map();
      const url = `${this.dataRoot}${ref.file}`;
      if (!this._fnt.has(url)) this._fnt.set(url, getJSON(url).catch(() => null));
      return this._fnt.get(url);
    }
    // events(t0, t1) → {i0, i1, ...columns} (index range into the sorted columns; nothing is copied)
    events(t0, t1) {
      const E = this._ev;
      if (!E) return { i0: 0, i1: 0, n: 0 };
      const lim = this._clip ? Math.min(t1, this.now()) : t1;
      const i0 = lowerBound(E.t, t0), i1 = Math.max(i0, lowerBound(E.t, lim));
      return { i0, i1, n: i1 - i0, t: E.t, mag: E.mag, depth_km: E.depth_km, lat: E.lat, lon: E.lon, fc_hz: E.fc_hz, id: E.id };
    }

    // ----- waves: one-hour u16 chunks + sidecar (CONTRACT §4.2)
    _hours(kind, chan) {                            // W1: manifest.wave / manifest.spec = {chan: {hours: ["YYYY-MM-DD/HH", …]}}
      const idx = this._m[kind];
      if (idx && idx[chan]) return idx[chan].hours || [];
      if (idx) return [];
      return null;
    }
    _chunkListed(chan, t, kind = "wave") {
      const hrs = this._hours(kind, chan);
      if (hrs) return hrs.includes(`${ymd(t)}/${hh(t)}`);
      const sta = chan.split(".").slice(0, 3).join("."), s = this.station(sta);
      if (s && s.wave && s.wave[chan]) return s.wave[chan].includes(`${ymd(t)}/${hh(t)}`);
      if (!s || !(s.channels || []).includes(chan.split(".")[3])) return false;
      return this.covered(sta, Math.floor(t / HOUR) * HOUR, Math.floor(t / HOUR) * HOUR + HOUR);
    }
    hasWave(chan) {
      const hrs = this._hours("wave", chan);
      if (hrs) return hrs.length > 0;
      const sta = chan.split(".").slice(0, 3).join("."), s = this.station(sta);
      if (!s) return false;
      if (s.wave) return !!(s.wave[chan] && s.wave[chan].length);
      return (s.channels || []).includes(chan.split(".")[3]);
    }
    _chunk(chan, t) {
      const h = Math.floor(t / HOUR) * HOUR, key = `${chan}/${ymd(h)}/${hh(h)}`;
      if (!this._wave.has(key)) {
        if (!this._chunkListed(chan, h)) { this._wave.set(key, Promise.resolve(null)); return this._wave.get(key); }
        const base = `${this.dataRoot}wave/${chan}/${ymd(h)}/${hh(h)}`;
        this._wave.set(key, Promise.all([getJSON(base + ".json"), getBytes(base + ".u16")]).then(([meta, buf]) => {
          const u = new Uint16Array(buf), x = new Float32Array(u.length), sc = meta.scale;
          for (let i = 0; i < u.length; i++) x[i] = (u[i] / 32767.5 - 1) * sc;
          const gapMask = new Uint8Array(u.length);
          for (const [a, b] of meta.gaps || []) gapMask.fill(1, a, b);
          for (let i = 0; i < u.length; i++) if (gapMask[i]) x[i] = NaN;
          // a min/max pyramid at 1 s blocks, so a 3-hour waveform draws without touching 1M samples
          const B = Math.max(1, Math.round(meta.fs)), nb = Math.ceil(x.length / B), mn = new Float32Array(nb), mx = new Float32Array(nb);
          for (let k = 0; k < nb; k++) {
            let lo = Infinity, hi = -Infinity;
            for (let i = k * B, e = Math.min(x.length, i + B); i < e; i++) { const v = x[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
            mn[k] = lo === Infinity ? NaN : lo; mx[k] = hi === -Infinity ? NaN : hi;
          }
          return { ...meta, x, block: B, mn, mx };
        }).catch(() => null));
      }
      return this._wave.get(key);
    }
    // wave(chan, t0, n) → {data: Float32Array(n), t0, fs, gaps:[[i0,i1]...]}: NaN-free (gaps are zeros, and listed)
    async wave(chan, t0, n) {
      const first = await this._firstChunk(chan, t0);
      const fs = first ? first.fs : 100;
      const out = new Float32Array(n), gaps = [];
      let filled = 0, t = t0, gapStart = -1;
      const lim = this._clip ? this.now() : Infinity;
      while (filled < n) {
        const c = await this._chunk(chan, t);
        const chunkEnd = Math.floor(t / HOUR) * HOUR + HOUR;
        const take = Math.min(n - filled, Math.max(1, Math.round((chunkEnd - t) * fs)));
        for (let k = 0; k < take; k++) {
          const tk = t + k / fs;
          let v = NaN;
          if (c && tk <= lim) { const i = Math.round((tk - c.t0) * c.fs); if (i >= 0 && i < c.x.length) v = c.x[i]; }
          const idx = filled + k;
          if (Number.isFinite(v)) { out[idx] = v; if (gapStart >= 0) { gaps.push([gapStart, idx]); gapStart = -1; } }
          else { out[idx] = 0; if (gapStart < 0) gapStart = idx; }
        }
        filled += take; t += take / fs;
      }
      if (gapStart >= 0) gaps.push([gapStart, n]);
      return { data: out, t0, fs, gaps };
    }
    async _firstChunk(chan, t) { return this._chunk(chan, t); }
    // waveSpan(chan, t0, t1) → the loaded chunks overlapping [t0, t1) (for drawing; the page reads x / mn / mx itself)
    async waveSpan(chan, t0, t1) {
      if (!this.hasWave(chan)) return [];
      const out = [];
      for (let h = Math.floor(t0 / HOUR) * HOUR; h < t1; h += HOUR) {
        if (out.length > 30) break;
        const c = await this._chunk(chan, h);
        if (c) out.push(c);
      }
      return out;
    }
    // spec(chan, t0, t1) → hourly spectrogram tiles [{meta, bytes:Uint8Array}] (CONTRACT §4.2, frames × bins)
    async spec(chan, t0, t1) {
      const sta = chan.split(".").slice(0, 3).join("."), s = this.station(sta);
      const cha = chan.split(".")[3];
      const hrs = this._hours("spec", chan);
      // W1 §15.1: a continuous station ships no spectrogram files (windows.raw.spec_files false); the page computes them
      // from the wave hours it has. MELH keeps its files
      const W = this.windows(), compute = !!(W && W.raw && W.raw.spec_files === false && (!hrs || !hrs.length) && this.hasWave(chan));
      if (compute) {
        const out = [];
        for (let h = Math.floor(t0 / HOUR) * HOUR; h < t1 && out.length <= 30; h += HOUR) {
          if (!this._chunkListed(chan, h, "wave")) continue;
          const key = `${chan}/${ymd(h)}/${hh(h)}#page`;
          if (!this._spec.has(key)) this._spec.set(key, this._chunk(chan, h).then((c) => (c ? specFromWave(c, this._specRange(chan)) : null)).catch(() => null));
          const v = await this._spec.get(key);
          if (v) out.push(v);
        }
        return out;
      }
      if (!hrs && (!s || (s.spec && !s.spec.includes(cha)))) return [];
      const out = [];
      for (let h = Math.floor(t0 / HOUR) * HOUR; h < t1 && out.length <= 30; h += HOUR) {
        if (!this._chunkListed(chan, h, hrs ? "spec" : "wave")) continue;
        const key = `${chan}/${ymd(h)}/${hh(h)}`;
        if (!this._spec.has(key)) {
          const base = `${this.dataRoot}spec/${chan}/${ymd(h)}/${hh(h)}`;
          this._spec.set(key, Promise.all([getJSON(base + ".json"), getBytes(base + ".u8")])
            .then(([meta, buf]) => ({ meta, bytes: new Uint8Array(buf) })).catch(() => null));
        }
        const v = await this._spec.get(key);
        if (v) out.push(v);
      }
      return out;
    }
    // the dB range a computed spectrogram is scaled to, one per channel so hours match: the manifest's (ranges["spec:<chan>"])
    // when it says, else fixed by the first hour computed (its p2 … p99.8)
    _specRange(chan) {
      const r = (this._m.ranges || {})[`spec:${chan}`];
      if (r && isFinite(r.lo) && isFinite(r.hi)) return r;
      this._specR = this._specR || {};
      return this._specR[chan] || (this._specR[chan] = { lo: null, hi: null });
    }
    async latent(station) {
      const L = this._m.latent;
      if (L && !L[station]) return null;
      const file = (L && L[station] && L[station].file) || `latent/${station}_f1m.json`;
      try { return await getJSON(`${this.dataRoot}${file}`); } catch (_) { return null; }
    }
    // the Ground ring's absolute scale: the record's peak |x| for this channel. From the manifest when it says
    // (ranges["wave:<chan>"] or wave[chan].peak); otherwise the max of the listed hours' sidecar scales (fetched once)
    async waveNorm(chan) {
      const r = (this._m.ranges || {})[`wave:${chan}`], w = (this._m.wave || {})[chan];
      if (r && r.max > 0) return { norm: r.max, how: "manifest ranges" };
      if (w && w.peak > 0) return { norm: w.peak, how: "manifest wave index" };
      if (!this._norm) this._norm = {};
      if (!this._norm[chan]) {
        const hrs = this._hours("wave", chan) || [];
        this._norm[chan] = Promise.all(hrs.map((h) => getJSON(`${this.dataRoot}wave/${chan}/${h}.json`).catch(() => null)))
          .then((ms) => ({ norm: Math.max(1e-9, ...ms.filter(Boolean).map((m) => m.scale || 0)), how: `max of ${hrs.length} hourly sidecar scales (the manifest has no peak yet)` }));
      }
      return this._norm[chan];
    }
  }

  // ------------------------------------------------------------------------------------------------ LiveSource
  // Backfill from static + WS push from pipeline/live_server.py (CONTRACT §6 "Live push"). A working slot: it merges
  // {type:"frames", tier, source, rows, partial}, {type:"wave", chan, t0, fs, scale, data_b64_u16} and
  // {type:"events", rows} into the caches the StaticSource reads, and moves now() to the newest time it has seen.
  class LiveSource extends StaticSource {
    constructor(root, manifest, url) {
      super(root, manifest);
      this.kind = "live";
      this.url = url;
      this._live = { now: manifest.t_end, seen: false, frames: new Map(), waves: new Map() };
      this.status = "connecting";
      this._connect();
    }
    // the newest time the feed has delivered (a replay-as-live server's clock is in the past: that is fine)
    now() { return this._live.seen ? this._live.now : this._m.t_end; }
    // the sources panel's disconnect: no more retries
    close() { this._closed = true; try { this._ws && this._ws.close(); } catch (_) {} }
    _connect() {
      if (this._closed) return;
      let ws;
      try { ws = new WebSocket(this.url); } catch (e) { this.status = "failed"; return; }
      this._ws = ws;
      ws.onopen = () => { this.status = "open"; this._retry = 0; this._emit({ type: "status", status: "open" }); };
      // a feed that is down is retried with backoff (3 s … 60 s), so a dead feed does not flood the console
      ws.onclose = () => { this.status = this._closed ? "disconnected" : "closed"; this._emit({ type: "status", status: this.status }); if (this._closed) return;
        this._retry = (this._retry || 0) + 1; setTimeout(() => this._connect(), Math.min(60000, 3000 * 2 ** (this._retry - 1))); };
      ws.onerror = () => {};
      ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch (_) { return; }
        this._ingest(m);
        this._emit(m);
      };
    }
    _ingest(m) {
      if (m.type === "hello") { if (Number.isFinite(m.t_now)) { this._live.now = m.t_now; this._live.seen = true; } this.hello = m; return; }
      if (m.type === "frames" || m.type === "events" || m.type === "wave") this._live.seen = true;
      if (m.type === "frames" && Array.isArray(m.rows)) {
        const key = `${m.tier}/${m.source}`;
        if (!this._live.frames.has(key)) this._live.frames.set(key, new Map());
        const store = this._live.frames.get(key);
        for (const r of m.rows) { store.set(r.t, { ...r, partial: !!m.partial }); this._live.now = Math.max(this._live.now, r.t); }
      } else if (m.type === "events" && Array.isArray(m.rows) && this._ev) {
        // append to the sorted columns (live rows arrive in time order; anything older is inserted)
        for (const r of m.rows) this._appendEvent(r);
      } else if (m.type === "wave" && m.data_b64_u16) {
        const bin = atob(m.data_b64_u16), u = new Uint16Array(bin.length / 2);
        for (let i = 0; i < u.length; i++) u[i] = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
        const x = new Float32Array(u.length);
        for (let i = 0; i < u.length; i++) x[i] = (u[i] / 32767.5 - 1) * m.scale;
        if (!this._live.waves.has(m.chan)) this._live.waves.set(m.chan, []);
        this._live.waves.get(m.chan).push({ t0: m.t0, fs: m.fs, x });
        this._live.now = Math.max(this._live.now, m.t0 + u.length / m.fs);
      }
    }
    _appendEvent(r) {
      const E = this._ev, n = E.n + 1, i = lowerBound(E.t, r.t);
      const grow = (a, v, F) => { const b = F ? new F(n) : new Array(n); b.set ? (b.set(a.subarray(0, i), 0), b.set(a.subarray(i), i + 1)) : (a.slice(0, i).forEach((x, k) => (b[k] = x)), a.slice(i).forEach((x, k) => (b[i + 1 + k] = x))); b[i] = v; return b; };
      E.t = grow(E.t, r.t, Float64Array); E.mag = grow(E.mag, r.mag ?? NaN, Float32Array); E.depth_km = grow(E.depth_km, r.depth_km ?? NaN, Float32Array);
      E.lat = grow(E.lat, r.lat ?? NaN, Float32Array); E.lon = grow(E.lon, r.lon ?? NaN, Float32Array); E.fc_hz = grow(E.fc_hz, r.fc_hz ?? NaN, Float32Array);
      E.id = grow(E.id, r.id ?? "", null); E.n = n;
      this._live.now = Math.max(this._live.now, r.t);
    }
    _chunk(chan, t) {
      const pieces = this._live.waves.get(chan);
      if (!pieces || !pieces.length) return super._chunk(chan, t);
      return super._chunk(chan, t).then((c) => c || this._liveChunk(chan, Math.floor(t / HOUR) * HOUR));
    }
    _liveChunk(chan, h) {
      const ps = (this._live.waves.get(chan) || []).filter((p) => p.t0 < h + HOUR && p.t0 + p.x.length / p.fs > h);
      if (!ps.length) return null;
      const fs = ps[0].fs, x = new Float32Array(Math.round(HOUR * fs)).fill(NaN);
      for (const p of ps) { const o = Math.round((p.t0 - h) * fs); for (let i = 0; i < p.x.length; i++) if (o + i >= 0 && o + i < x.length) x[o + i] = p.x[i]; }
      const B = Math.max(1, Math.round(fs)), nb = Math.ceil(x.length / B), mn = new Float32Array(nb), mx = new Float32Array(nb);
      for (let k = 0; k < nb; k++) { let lo = Infinity, hi = -Infinity; for (let i = k * B; i < Math.min(x.length, (k + 1) * B); i++) { const v = x[i]; if (v < lo) lo = v; if (v > hi) hi = v; } mn[k] = lo === Infinity ? NaN : lo; mx[k] = hi === -Infinity ? NaN : hi; }
      return { chan, t0: h, fs, n: x.length, x, block: B, mn, mx, live: true };
    }
    hasWave(chan) { return super.hasWave(chan) || (this._live.waves.get(chan) || []).length > 0; }
    async tiles(tier, source, t0, t1) {
      const out = await super.tiles(tier, source, t0, t1);
      const store = this._live.frames.get(`${tier}/${source}`);
      if (!store || !store.size) return out;
      const ts = Array.from(out.t), cols = out.cols, have = new Set(ts);
      for (const [t, r] of [...store.entries()].sort((a, b) => a[0] - b[0])) {
        if (t < t0 || t >= t1 || have.has(t)) continue;
        ts.push(t);
        for (const c of Object.keys(r)) { if (c === "t") continue; if (!cols[c]) cols[c] = new Array(ts.length - 1).fill(null); }
        for (const c of Object.keys(cols)) cols[c].push(r[c] ?? null);
      }
      out.t = Float64Array.from(ts);
      return out;
    }
  }

  // ------------------------------------------------------------------------------------------------ open()
  // root: explicit opts.root → ?data= → window.SVK_CONFIG.dataRoot → the bridge's list of roots that exist → data/
  async function pickRoot(opts) {
    if (opts.root) return opts.root;
    const q = new URLSearchParams(location.search).get("data");
    if (q) return q.endsWith("/") ? q : q + "/";
    if (window.SVK_CONFIG && window.SVK_CONFIG.dataRoot) return window.SVK_CONFIG.dataRoot;
    if (opts.roots && opts.roots.length) return opts.roots[0];
    return "data/";
  }
  async function open(opts = {}) {
    const root = await pickRoot(opts);
    const m = await getJSON(`${root}manifest.json`);
    const mode = opts.mode || "archive";
    const src = mode === "live" && opts.url ? new LiveSource(root, m, opts.url) : new StaticSource(root, m);
    if (new URLSearchParams(location.search).get("lean") === "1") src._leanFixture();
    await src.loadEvents().catch((e) => console.warn("[source] events not loaded", e));
    await src.loadEruptions().catch((e) => console.warn("[source] eruptions not loaded", e));
    return src;
  }

  return { open, StaticSource, LiveSource, util: { ymd, hh, lowerBound, DAY, HOUR } };
})();
