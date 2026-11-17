// dark_svartsengi · mseed/engine.js — the causal feature engine in the browser (CONTRACT 0.16, DESIGN §6.1 step 3). W3.
//
// A port of W1's FeatureEngine (pipeline/stream_features.py) and Pyramid (pipeline/pyramid.py), written to W1's spec
// (lab/notes/2026-10-25_W1_engine_spec.md) and checked against W1's golden fixtures (pipeline/tests/golden/; the
// harness is viz/tools/test_engine.mjs): decoded samples exact, features within 1e-6 relative, coverage / n_trig / t
// exact, nulls in the same places. Float64 throughout (the 0.1–1 Hz filter's poles sit very near z = 1).
//
//   - filters: Butterworth band-passes as second-order sections, direct form II transposed, the state carried across
//     pushes and restarted at zi_unit · x0 after a gap; the tables per sample rate are W1's (filters_fs<fs>.json);
//   - STA/LTA (0.5 s / 20 s), cft = 0 for the first 20 s of a segment, the 4.0 / 1.5 trigger: onsets counted per frame;
//   - 10-s frames on the T0 grid, closed on the watermark (the slowest live channel; stale ones after 120 s);
//   - per frame: rsam per band, fi, kurtosis, spectral centroid and flatness (a Hann window and a mixed-radix FFT),
//     polarization (the 3×3 covariance's largest eigenvector, Jacobi), tilt; a frame of equal raw Z samples is a dead
//     channel: its band features are null (0.16);
//   - the pyramid f1m → f10m → f1h → f1d with W1's private weights;
//   - state() / new FeatureEngine(id, {state}) in W1's JSON layout (spec §9), so a run resumes exactly.
//
// Plain script: in a worker or page it sets SvkEngine, in Node globalThis.SvkEngine.
(function (root) {
  "use strict";
  const T0 = 1685577600, FRAME_S = 10, STA_S = 0.5, LTA_S = 20.0, TRIG_ON = 4.0, TRIG_OFF = 1.5;
  const BANDS = ["micro", "tremor", "mid", "vt"], BB = [1.0, 45.0];
  const Z_FILTERS = ["micro", "tremor", "mid", "vt", "bb", "trig", "pol"], H_FILTERS = ["pol"];
  const DEFAULT_ROLES = { Z: "HHZ", N: "HHN", E: "HHE", tZ: "LMZ", tN: "LMN", tE: "LME" };
  const BUFFERED = { Z: ["micro", "tremor", "mid", "vt", "bb", "pol", "raw"], N: ["pol"], E: ["pol"], tZ: ["raw"], tN: ["raw"], tE: ["raw"] };
  const FEATURE_COLS = ["rsam_micro", "rsam_tremor", "rsam_mid", "rsam_vt", "rsam_vt_max", "fi", "centroid_hz", "flatness", "kurt", "kurt_max", "n_trig",
                        "pol_az", "pol_R", "pol_rect", "tilt_n", "tilt_e", "tilt_z", "coverage"];
  const TIERS = { f10s: 10, f1m: 60, f10m: 600, f1h: 3600, f1d: 86400 };
  const CHAIN = [["f1m", "f10s"], ["f10m", "f1m"], ["f1h", "f10m"], ["f1d", "f1h"]];
  const EPS = 2.220446049250313e-16;
  const fmod = (a, m) => ((a % m) + m) % m;                               // Python's % (floor)
  // Python's round(): half to even
  const roundHE = (x) => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; };

  // ---------------------------------------------------------------------------------------------- filters
  // filters: {fs, filters: {name: {sos: [[b0,b1,b2,a0,a1,a2] × n], zi_unit: [[z0,z1] × n]}}} (W1's filters_fs<fs>.json)
  const TABLES = new Map();
  // a table per rate holds only the bands that fit it (0.16: upper edge <= 0.9 × Nyquist); a band it does not hold is
  // not computed and the features it feeds stay null. W1's filters.json ({rates: {fs: table}}) or one filters_fs<fs>.json
  function addFilterTable(t) {
    if (t && t.rates) { for (const r of Object.values(t.rates)) addFilterTable(r); return; }
    TABLES.set(+t.fs, t.filters);
  }
  function filtersFor(fs) {
    const t = TABLES.get(+fs);
    if (!t) throw new Error(`no filter table for ${fs} Hz (the engine has ${[...TABLES.keys()].sort((a, b) => a - b).join(", ") || "none"} Hz)`);
    return t;
  }
  const rates = () => [...TABLES.keys()].sort((a, b) => a - b);
  // sections in order, DF2T; zi: [[z0, z1] × n], updated in place; returns y (Float64Array)
  function sosfilt(sos, x, zi) {
    const n = x.length, y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let v = x[i];
      for (let s = 0; s < sos.length; s++) {
        const q = sos[s], z = zi[s], yn = q[0] * v + z[0];
        z[0] = q[1] * v - q[4] * yn + z[1];
        z[1] = q[2] * v - q[5] * yn;
        v = yn;
      }
      y[i] = v;
    }
    return y;
  }

  // ---------------------------------------------------------------------------------------------- the FFT
  // mixed radix (any N; 1000 = 2³·5³ at 100 Hz), out of place, recursive; a table of the N-th roots of unity
  const PLANS = new Map();
  function plan(n) {
    if (PLANS.has(n)) return PLANS.get(n);
    const c = new Float64Array(n), s = new Float64Array(n);
    for (let j = 0; j < n; j++) { c[j] = Math.cos((2 * Math.PI * j) / n); s[j] = -Math.sin((2 * Math.PI * j) / n); }
    const p = { n, c, s, tr: new Float64Array(n), ti: new Float64Array(n) };
    PLANS.set(n, p);
    return p;
  }
  const smallestFactor = (n) => { for (const p of [4, 2, 3, 5, 7]) if (n % p === 0) return p; for (let p = 11; p * p <= n; p += 2) if (n % p === 0) return p; return n; };
  function fftRec(P, xr, xi, off, stride, n, or, oi, oo) {
    if (n === 1) { or[oo] = xr[off]; oi[oo] = xi[off]; return; }
    const p = smallestFactor(n), m = n / p, N = P.n;
    for (let r = 0; r < p; r++) fftRec(P, xr, xi, off + r * stride, stride * p, m, or, oi, oo + r * m);
    const yr = new Float64Array(p), yi = new Float64Array(p);
    for (let k = 0; k < m; k++) {
      for (let r = 0; r < p; r++) { yr[r] = or[oo + r * m + k]; yi[r] = oi[oo + r * m + k]; }
      for (let q = 0; q < p; q++) {
        let sr = 0, si = 0;
        const kk = k + q * m;
        for (let r = 0; r < p; r++) {
          const j = (stride * r * kk) % N, wr = P.c[j], wi = P.s[j];
          sr += yr[r] * wr - yi[r] * wi; si += yr[r] * wi + yi[r] * wr;
        }
        P.tr[q] = sr; P.ti[q] = si;
      }
      for (let q = 0; q < p; q++) { or[oo + q * m + k] = P.tr[q]; oi[oo + q * m + k] = P.ti[q]; }
    }
  }
  // |rfft(x)| for bins 0..floor(n/2)
  function rfftAbs(x) {
    const n = x.length, P = plan(n), xi = new Float64Array(n), or = new Float64Array(n), oi = new Float64Array(n);
    fftRec(P, x, xi, 0, 1, n, or, oi, 0);
    const nb = Math.floor(n / 2) + 1, out = new Float64Array(nb);
    for (let k = 0; k < nb; k++) out[k] = Math.hypot(or[k], oi[k]);
    return out;
  }

  // ---------------------------------------------------------------------------------------------- the eigen-solver
  // a symmetric 3×3 by cyclic Jacobi rotations → {w: ascending eigenvalues, v: columns = eigenvectors}
  function jacobi3(A0) {
    const A = A0.map((r) => r.slice()), V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 50; sweep++) {
      const off = Math.abs(A[0][1]) + Math.abs(A[0][2]) + Math.abs(A[1][2]);
      if (off < 1e-300 || off < 1e-17 * (Math.abs(A[0][0]) + Math.abs(A[1][1]) + Math.abs(A[2][2]))) break;
      for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
        if (A[p][q] === 0) continue;
        const th = (A[q][q] - A[p][p]) / (2 * A[p][q]), t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
        for (let k = 0; k < 3; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
        for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
      }
    }
    const order = [0, 1, 2].sort((a, b) => A[a][a] - A[b][b]);
    return { w: order.map((i) => A[i][i]), v: [0, 1, 2].map((r) => order.map((i) => V[r][i])) };
  }

  // ---------------------------------------------------------------------------------------------- a channel
  class Chan {
    constructor(role, fs, g0, d) {
      this.role = role; this.fs = +fs; this.g0 = +g0;
      this.W = Math.round(FRAME_S * this.fs);
      const off = (this.g0 - T0) * this.fs;
      this.off = Math.abs(off - roundHE(off)) < 1e-3 ? roundHE(off) : null;
      const every = role === "Z" ? Z_FILTERS : role === "N" || role === "E" ? H_FILTERS : [];
      const tab = every.length ? filtersFor(this.fs) : {};
      this.names = every.filter((k) => tab[k]);                     // 0.16: only the bands that fit this rate
      this.sos = {}; this.zu = {}; this.zi = {};
      for (const k of this.names) { this.sos[k] = tab[k].sos; this.zu[k] = tab[k].zi_unit; this.zi[k] = null; }
      this.next_k = 0; this.sta = 0.0; this.lta = 1e-99; this.n_warm = 0; this.triggered = false;
      this.run_val = null; this.run_len = 0;                          // 0.16: the current run of equal raw samples
      if (d) {
        this.next_k = +d.next_k;
        for (const [k, v] of Object.entries(d.zi || {})) this.zi[k] = v == null ? null : v.map((z) => [+z[0], +z[1]]);
        this.sta = +d.sta; this.lta = +d.lta; this.n_warm = +d.n_warm; this.triggered = !!d.triggered;
        this.run_val = d.run_val == null ? null : +d.run_val; this.run_len = +(d.run_len || 0);   // additive keys
      }
    }
    toDict() {
      return { role: this.role, fs: this.fs, g0: this.g0, next_k: this.next_k, zi: Object.fromEntries(Object.entries(this.zi).map(([k, v]) => [k, v == null ? null : v.map((z) => [z[0], z[1]])])),
               sta: this.sta, lta: this.lta, n_warm: this.n_warm, triggered: this.triggered, run_val: this.run_val, run_len: this.run_len };
    }
    // frame index and in-frame position of samples k0 .. k0 + n − 1
    framePos(k0, n) {
      const f = new Float64Array(n), p = new Int32Array(n), W = this.W;
      if (this.off !== null && W === FRAME_S * this.fs) {
        for (let i = 0; i < n; i++) { const a = this.off + k0 + i; f[i] = Math.floor(a / W); p[i] = a - f[i] * W; }
      } else {
        for (let i = 0; i < n; i++) {
          const x = ((this.g0 - T0) + (k0 + i) / this.fs) / FRAME_S, fi = Math.floor(x + 1e-9);
          f[i] = fi; p[i] = Math.min(W - 1, Math.floor((x - fi) * W + 1e-6));
        }
      }
      return { f, p };
    }
    tNext() { return this.g0 + this.next_k / this.fs; }
  }

  // ---------------------------------------------------------------------------------------------- the engine
  class FeatureEngine {
    constructor(stationId, { state = null, roles = null, hold_s = 0.0, stale_s = 120.0 } = {}) {
      this.station_id = stationId; this.roles = { ...(roles || DEFAULT_ROLES) };
      this.chanRole = Object.fromEntries(Object.entries(this.roles).map(([r, c]) => [c, r]));
      this.hold_s = +hold_s; this.stale_s = +stale_s;
      this.chans = {}; this.frames = new Map(); this.last_emitted = null; this.watermark = -Infinity;
      this.stats = { late_samples: 0, overlap_samples: 0, gaps: 0 };
      if (state) this._load(state);
    }
    state() {
      const frames = {};
      for (const [f, fr] of this.frames) frames[String(f)] = Object.fromEntries(Object.entries(fr).map(([k, v]) => [k, k === "trig" ? v : Array.from(v, (x) => (x !== x ? null : x))]));
      return { version: 1, station_id: this.station_id, roles: this.roles, hold_s: this.hold_s, stale_s: this.stale_s, last_emitted: this.last_emitted,
               watermark: this.watermark === -Infinity ? null : this.watermark, stats: { ...this.stats },
               chans: Object.fromEntries(Object.entries(this.chans).map(([c, ch]) => [c, ch.toDict()])), frames };
    }
    _load(s) {
      if (s.version !== 1) throw new Error("unknown engine state version");
      this.station_id = s.station_id; this.roles = { ...s.roles };
      this.chanRole = Object.fromEntries(Object.entries(this.roles).map(([r, c]) => [c, r]));
      this.hold_s = +s.hold_s; this.stale_s = s.stale_s == null ? 120 : +s.stale_s;
      this.last_emitted = s.last_emitted; this.watermark = s.watermark == null ? -Infinity : +s.watermark; this.stats = { ...s.stats };
      this.chans = Object.fromEntries(Object.entries(s.chans).map(([c, d]) => [c, new Chan(d.role, d.fs, d.g0, d)]));
      this.frames = new Map();
      for (const [f, fr] of Object.entries(s.frames)) this.frames.set(+f, Object.fromEntries(Object.entries(fr).map(([k, v]) => [k, k === "trig" ? +v : Float64Array.from(v, (x) => (x == null ? NaN : x))])));
    }
    _frame(f) { let fr = this.frames.get(f); if (!fr) { fr = { trig: 0 }; this.frames.set(f, fr); } return fr; }
    _scatter(ch, k0, signals) {
      const names = Object.keys(signals), n = signals[names[0]].length, { f, p } = ch.framePos(k0, n);
      let a = 0;
      while (a < n) {
        let b = a + 1; while (b < n && f[b] === f[a]) b++;
        const fi = f[a];
        if (this.last_emitted !== null && fi <= this.last_emitted) { this.stats.late_samples += b - a; a = b; continue; }
        const fr = this._frame(fi);
        for (const name of names) {
          const key = `${ch.role}:${name}`; let buf = fr[key];
          if (!buf) { buf = new Float64Array(ch.W).fill(NaN); fr[key] = buf; }
          const y = signals[name];
          for (let i = a; i < b; i++) buf[p[i]] = y[i];
        }
        a = b;
      }
    }
    // STA/LTA and the trigger, per sample (spec §4, with 0.16's stuck spans): x the raw Z samples, y the trig-filtered
    //  1. the run of equal raw samples: a value that differs after a run of >= W restarts STA/LTA (as after a gap);
    //  2. sta, lta; 3. cft = 0 in the warm-up (nlta samples) or while stuck (run >= W); 4. warm += 1; 5. the trigger
    _triggers(ch, k0, x, y) {
      const nsta = Math.floor(STA_S * ch.fs), nlta = Math.floor(LTA_S * ch.fs), cs = 1 / nsta, cl = 1 / nlta, n = y.length, W = ch.W;
      const onsets = [];
      let sta = ch.sta, lta = ch.lta, warm = ch.n_warm, trig = ch.triggered, rv = ch.run_val, rl = ch.run_len;
      for (let i = 0; i < n; i++) {
        if (rv !== null && x[i] === rv) rl += 1;
        else { if (rl >= W) { sta = 0.0; lta = 1e-99; warm = 0; trig = false; } rv = x[i]; rl = 1; }
        const sq = y[i] * y[i];
        sta = cs * sq + (1 - cs) * sta;
        lta = cl * sq + (1 - cl) * lta;
        const cft = warm < nlta || rl >= W ? 0 : sta / lta;
        warm += 1;
        if (!trig) { if (cft > TRIG_ON) { onsets.push(i); trig = true; } }
        else if (cft <= TRIG_OFF) trig = false;
      }
      ch.sta = sta; ch.lta = lta; ch.n_warm = warm; ch.triggered = trig; ch.run_val = rv; ch.run_len = rl;
      if (onsets.length) {
        const { f } = ch.framePos(k0, n);
        for (const o of onsets) { const fi = f[o]; if (this.last_emitted === null || fi > this.last_emitted) this._frame(fi).trig += 1; }
      }
    }
    // one trace: {cha, fs, start, data} (data: integers or floats; one channel, contiguous)
    _ingest(tr) {
      const code = tr.cha, role = this.chanRole[code];
      if (role === undefined) return;
      const fs = +tr.fs, t0 = +tr.start;
      let ch = this.chans[code];
      if (!ch) ch = this.chans[code] = new Chan(role, fs, t0);
      let k = roundHE((t0 - ch.g0) * fs), x = Float64Array.from(tr.data);
      if (k < ch.next_k) { const drop = ch.next_k - k; this.stats.overlap_samples += Math.min(drop, x.length); x = x.subarray(drop); k = ch.next_k; }
      if (!x.length) return;
      if (k > ch.next_k || ch.names.some((nm) => ch.zi[nm] == null)) {
        if (k > ch.next_k) this.stats.gaps += 1;
        for (const nm of ch.names) ch.zi[nm] = ch.zu[nm].map((z) => [z[0] * x[0], z[1] * x[0]]);
        ch.sta = 0.0; ch.lta = 1e-99; ch.n_warm = 0; ch.triggered = false; ch.run_val = null; ch.run_len = 0;
      }
      const signals = {};
      if (role.startsWith("t")) signals.raw = x;
      else {
        if (role === "Z") signals.raw = x;
        for (const nm of ch.names) {
          const y = sosfilt(ch.sos[nm], x, ch.zi[nm]);
          if (nm === "trig") this._triggers(ch, k, x, y); else signals[nm] = y;
        }
      }
      if (Object.keys(signals).length) this._scatter(ch, k, signals);   // a channel with no band that fits buffers nothing
      ch.next_k = k + x.length;
    }
    _watermarkNow() {
      const tn = Object.values(this.chans).map((c) => c.tNext());
      if (!tn.length) return -Infinity;
      const hi = Math.max(...tn);
      return Math.min(...tn.filter((t) => t >= hi - this.stale_s));
    }
    push(traces) {
      for (const tr of traces) this._ingest(tr);
      this.watermark = Math.max(this.watermark, this._watermarkNow());
      return this._close(this.watermark - this.hold_s);
    }
    flush() { return this._close(Infinity); }
    _close(upto) {
      const rows = [], fs = [...this.frames.keys()].sort((a, b) => a - b);
      for (const f of fs) {
        if (T0 + (f + 1) * FRAME_S > upto + 1e-9) break;
        if (this.last_emitted !== null) for (let g = this.last_emitted + 1; g < f; g++) rows.push(this._emptyRow(g));
        rows.push(this._row(f, this.frames.get(f)));
        this.frames.delete(f);
        this.last_emitted = f;
      }
      return rows;
    }
    _emptyRow(f) {
      const row = {}; for (const c of FEATURE_COLS) row[c] = null;
      row.t = T0 + f * FRAME_S; row.coverage = 0.0; row._rsam_bb = null; row._n_z = 0;
      return row;
    }
    _row(f, fr) {
      const row = this._emptyRow(f), z = this.chans[this.roles.Z], raw = fr["Z:raw"], bb = fr["Z:bb"];
      if (!z || (!raw && !bb)) return row;
      // presence from the raw samples (every rate has them), and bb's (a frame opened by a state saved before 0.16)
      const W = z.W, fs = z.fs, idx = [];
      for (let i = 0; i < W; i++) if ((raw && raw[i] === raw[i]) || (bb && bb[i] === bb[i])) idx.push(i);
      const nz = idx.length;
      row.coverage = nz / W; row._n_z = nz;
      if (!nz) return row;
      if (raw && nz >= 2) {                                    // 0.16: a dead (stuck) channel is absent: band features null
        let lo = Infinity, hi = -Infinity, nan = false;
        for (const i of idx) { const v = raw[i]; if (v !== v) { nan = true; break; } if (v < lo) lo = v; if (v > hi) hi = v; }
        if (!nan && hi === lo) { this._tilt(row, fr); return row; }
      }
      const meanAbs = (a) => { let s = 0; for (const i of idx) s += Math.abs(a[i]); return s / nz; };
      for (const b of BANDS) { const y = fr[`Z:${b}`]; if (y) row[`rsam_${b}`] = meanAbs(y); }   // a band that does not fit stays null
      row.rsam_vt_max = row.rsam_vt;
      if (row.rsam_vt != null && row.rsam_tremor != null && row.rsam_vt > 0 && row.rsam_tremor > 0) row.fi = Math.log10(row.rsam_vt / row.rsam_tremor);
      if (bb) {
        row._rsam_bb = meanAbs(bb);
        if (nz >= 4) {                                         // scipy.stats.kurtosis(fisher, bias): null for a constant frame
          let s = 0; for (const i of idx) s += bb[i]; const mean = s / nz;
          let m2 = 0, m4 = 0; for (const i of idx) { const d = bb[i] - mean, d2 = d * d; m2 += d2; m4 += d2 * d2; }
          m2 /= nz; m4 /= nz;
          if (!(m2 <= (EPS * mean) ** 2)) { const k = m4 / m2 ** 2 - 3; if (Number.isFinite(k)) row.kurt = row.kurt_max = k; }
        }
        if (nz >= Math.floor(W / 2)) {                          // centroid and flatness over 1–45 Hz
          const xs = new Float64Array(W);
          for (let i = 0; i < W; i++) xs[i] = (bb[i] === bb[i] ? bb[i] : 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (W - 1)));
          const X = rfftAbs(xs), val = 1.0 / (W * (1.0 / fs));
          let tot = 0, tf = 0, lg = 0, ns = 0;
          for (let k = 0; k < X.length; k++) { const fk = k * val; if (fk >= BB[0] && fk <= BB[1]) { tot += X[k]; tf += X[k] * fk; lg += Math.log(X[k] + 1e-12); ns++; } }
          if (tot > 0) { row.centroid_hz = tf / tot; row.flatness = Math.exp(lg / ns) / (tot / ns); }
        }
      }
      row.n_trig = z.names.includes("trig") ? fr.trig | 0 : null;
      const pz = fr["Z:pol"], pn = fr["N:pol"], pe = fr["E:pol"];
      if (pz && pn && pe) {
        const mm = []; for (let i = 0; i < W; i++) if (pz[i] === pz[i] && pn[i] === pn[i] && pe[i] === pe[i]) mm.push(i);
        if (mm.length >= Math.floor(W / 2)) {
          const R = [pe, pn, pz], mu = R.map((a) => { let s = 0; for (const i of mm) s += a[i]; return s / mm.length; });
          const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
          for (const i of mm) { const d = [pe[i] - mu[0], pn[i] - mu[1], pz[i] - mu[2]]; for (let a = 0; a < 3; a++) for (let b = a; b < 3; b++) C[a][b] += d[a] * d[b]; }
          for (let a = 0; a < 3; a++) for (let b = a; b < 3; b++) { C[a][b] /= mm.length - 1; C[b][a] = C[a][b]; }
          const { w, v } = jacobi3(C), pv = [v[0][2], v[1][2], v[2][2]];
          if (w[2] > 0) { row.pol_az = fmod((Math.atan2(pv[0], pv[1]) * 180) / Math.PI, 180); row.pol_rect = 1 - (w[1] + w[0]) / (2 * w[2]); row.pol_R = 1.0; }
        }
      }
      this._tilt(row, fr);
      return row;
    }
    _tilt(row, fr) {
      for (const [role, col] of [["tN", "tilt_n"], ["tE", "tilt_e"], ["tZ", "tilt_z"]]) {
        const b = fr[`${role}:raw`]; if (!b) continue;
        let s = 0, n = 0; for (let i = 0; i < b.length; i++) if (b[i] === b[i]) { s += b[i]; n++; }
        if (n) row[col] = s / n;
      }
    }
  }

  // ---------------------------------------------------------------------------------------------- the pyramid
  const MEAN_COLS = ["rsam_micro", "rsam_tremor", "rsam_mid", "rsam_vt", "flatness", "kurt", "pol_rect", "tilt_n", "tilt_e", "tilt_z"];
  const MAX_COLS = ["rsam_vt_max", "kurt_max"];
  function seedWeights(row) {
    const cov = row.coverage || 0;
    for (const c of MEAN_COLS) row[`_w_${c}`] = row[c] != null ? cov : 0;
    const bb = row._rsam_bb;
    row._w_centroid_hz = row.centroid_hz != null && bb ? cov * bb : 0;
    row._w_pol = row.pol_az != null ? row.pol_rect : 0;
    return row;
  }
  function aggregate(children, t, nExp) {
    const out = { t: +t };
    out.coverage = children.reduce((s, c) => s + (c.coverage || 0), 0) / nExp;
    for (const col of [...MEAN_COLS, "centroid_hz"]) {
      let sw = 0, sv = 0;
      for (const c of children) { const v = c[col], w = c[`_w_${col}`] || 0; if (v != null && w > 0) { sw += w; sv += w * v; } }
      out[col] = sw > 0 ? sv / sw : null; out[`_w_${col}`] = sw;
    }
    for (const col of MAX_COLS) { const vs = children.map((c) => c[col]).filter((v) => v != null); out[col] = vs.length ? Math.max(...vs) : null; }
    const tr = children.map((c) => c.n_trig).filter((v) => v != null);
    out.n_trig = tr.length ? tr.reduce((a, b) => a + b, 0) : null;
    const vt = out.rsam_vt, tm = out.rsam_tremor;
    out.fi = vt && tm && vt > 0 && tm > 0 ? Math.log10(vt / tm) : null;
    let sw = 0, vx = 0, vy = 0;
    for (const c of children) {
      const w = c._w_pol || 0; if (c.pol_az == null || w <= 0) continue;
      const a = (2 * c.pol_az * Math.PI) / 180, r = c.pol_R || 0;
      sw += w; vx += w * r * Math.cos(a); vy += w * r * Math.sin(a);
    }
    if (sw > 0) { out.pol_R = Math.hypot(vx, vy) / sw; out.pol_az = fmod((Math.atan2(vy, vx) * 180) / Math.PI / 2, 180); } else out.pol_R = out.pol_az = null;
    out._w_pol = sw;
    const rb = children.filter((c) => c._rsam_bb != null && (c.coverage || 0) > 0), cw = rb.reduce((s, c) => s + c.coverage, 0);
    out._rsam_bb = cw > 0 ? rb.reduce((s, c) => s + c.coverage * c._rsam_bb, 0) / cw : null;
    if (out.coverage === 0) for (const col of FEATURE_COLS) if (col !== "coverage") out[col] = null;
    return out;
  }
  class Pyramid {
    constructor(sourceId, state = null) {
      this.source_id = sourceId; this.open = { f1m: null, f10m: null, f1h: null, f1d: null };
      if (state) { this.source_id = state.source_id; this.open = JSON.parse(JSON.stringify(state.open)); }
    }
    state() { return { source_id: this.source_id, open: JSON.parse(JSON.stringify(this.open)) }; }
    _close(parent, child, out) {
      const o = this.open[parent]; if (!o) return;
      const row = aggregate(o.children, T0 + o.idx * TIERS[parent], TIERS[parent] / TIERS[child]);
      this.open[parent] = null;
      (out[parent] = out[parent] || []).push(row);
      const nxt = CHAIN.find(([, c]) => c === parent);
      if (nxt) this._add(nxt[0], parent, row, out);
    }
    _add(parent, child, row, out) {
      const ps = TIERS[parent], cs = TIERS[child], idx = Math.floor((row.t - T0) / ps);
      let o = this.open[parent];
      if (o && o.idx !== idx) { this._close(parent, child, out); o = null; }
      if (!o) o = this.open[parent] = { idx, children: [] };
      o.children.push(row);
      if (row.t + cs >= T0 + (idx + 1) * ps - 1e-9) this._close(parent, child, out);
    }
    push(rows) {
      const out = { f10s: [] };
      for (const r0 of rows) { const r = seedWeights({ ...r0 }); out.f10s.push(r); this._add("f1m", "f10s", r, out); }
      return out;
    }
    flush() { const out = {}; for (const [p, c] of CHAIN) this._close(p, c, out); return out; }
  }

  root.SvkEngine = { FeatureEngine, Pyramid, addFilterTable, filtersFor, rates, sosfilt, rfftAbs, jacobi3, seedWeights, aggregate, roundHE,
                     T0, FRAME_S, FEATURE_COLS, MEAN_COLS, TIERS, DEFAULT_ROLES };
})(typeof self !== "undefined" ? self : globalThis);
