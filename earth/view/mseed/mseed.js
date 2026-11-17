// dark_svartsengi · mseed/mseed.js — raw miniSEED in the browser (CONTRACT 0.16, DESIGN §6.1 step 3, TASKS O1). W3.
//
// Our own decoder, written from the SEED 2.4 manual (no third-party code): the fixed header, blockettes 1000 (encoding,
// word order, record length) and 1001 (µs), the time correction, STEIM1 and STEIM2, plus the plain int16 / int32 /
// float32 / float64 encodings. Integer data come back as Int32Array, floats as Float32Array / Float64Array.
//
// Seeking: a big file (one channel per year) is never read whole. Records are fixed-length and time-ordered within a
// file, so the record holding t is found by bisection on record start times (a header read each step, File.slice), then
// blocks of records are read forward — as W1's MiniSEEDStream does (pipeline/sources.py).
//
// Merging: as obspy's Stream.merge(method=-1), which W1's sources use: per channel, traces that are exactly contiguous
// (the next start within 1% of a sample of where the last ended) are joined, overlaps with identical samples are
// joined without the repeat, and everything else (gaps, non-identical overlaps) stays a separate segment.
//
// Plain script: in a page it sets window.SvkMseed, in a worker self.SvkMseed, in Node globalThis.SvkMseed.
(function (root) {
  "use strict";

  // ---------------------------------------------------------------------------------------------- the fixed header
  const ENC = { 1: "int16", 3: "int32", 4: "float32", 5: "float64", 10: "steim1", 11: "steim2" };
  const ascii = (u8, a, n) => { let s = ""; for (let i = 0; i < n; i++) s += String.fromCharCode(u8[a + i]); return s.trim(); };
  function rate(f, m) {
    if (!f || !m) return 0;
    if (f > 0 && m > 0) return f * m;
    if (f > 0 && m < 0) return -f / m;
    if (f < 0 && m > 0) return -m / f;
    return 1 / (f * m);
  }
  // BTIME → whole epoch seconds and 0.0001 s ticks, kept apart so the start can be formed exactly (below)
  function btime(dv, o, le) {
    const year = dv.getUint16(o, le), doy = dv.getUint16(o + 2, le), h = dv.getUint8(o + 4), mi = dv.getUint8(o + 5), s = dv.getUint8(o + 6), tk = dv.getUint16(o + 8, le);
    return { year, doy, sec: Date.UTC(year, 0, 1, h, mi, s) / 1000 + (doy - 1) * 86400, tk };
  }
  // a record's header at byte 0 of `buf` (an ArrayBuffer of at least 48 bytes; 64+ to see blockette 1000)
  function parseHeader(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    if (buf.byteLength < 48) throw new Error("not miniSEED: shorter than a fixed header");
    const q = String.fromCharCode(u8[6]);
    if (!"DRQM".includes(q)) throw new Error("not miniSEED: no data quality indicator (D, R, Q or M) at byte 6");
    // the byte order: the year read big-endian must be plausible, else little-endian
    let le = false; { const y = dv.getUint16(20, false); if (y < 1900 || y > 2100) le = true; }
    const bt = btime(dv, 20, le);
    if (bt.year < 1900 || bt.year > 2100 || bt.doy < 1 || bt.doy > 366) throw new Error("not miniSEED: the start time is not a date");
    const h = {
      seq: ascii(u8, 0, 6), quality: q, sta: ascii(u8, 8, 5), loc: ascii(u8, 13, 2), cha: ascii(u8, 15, 3), net: ascii(u8, 18, 2),
      start: 0, nsamp: dv.getUint16(30, le), fs: rate(dv.getInt16(32, le), dv.getInt16(34, le)),
      activity: dv.getUint8(36), nblk: dv.getUint8(39), tcorr: dv.getInt32(40, le), dataOff: dv.getUint16(44, le), blkOff: dv.getUint16(46, le),
      le, encoding: null, wordBig: null, reclen: null, us: 0,
    };
    // the blockettes: 1000 (encoding, word order, record length) and 1001 (µs)
    let o = h.blkOff, guard = 0;
    while (o && o + 4 <= buf.byteLength && guard++ < 16) {
      const type = dv.getUint16(o, le), next = dv.getUint16(o + 2, le);
      if (type === 1000 && o + 8 <= buf.byteLength) { h.encoding = dv.getUint8(o + 4); h.wordBig = dv.getUint8(o + 5) === 1; h.reclen = 2 ** dv.getUint8(o + 6); }
      else if (type === 1001 && o + 8 <= buf.byteLength) h.us = dv.getInt8(o + 5);
      if (!next || next <= o) break;
      o = next;
    }
    // time: + the correction when "applied" (activity bit 1) is not set; + blockette 1001's µs. Formed as one integer of µs
    // (< 2^53) divided once, so the double is the correctly rounded start, the same one obspy's ns/1e9 gives
    h.startUs = bt.sec * 1e6 + bt.tk * 100 + ((h.activity & 0x02) ? 0 : h.tcorr * 100) + h.us;
    h.start = h.startUs / 1e6;
    h.nslc = `${h.net}.${h.sta}.${h.loc}.${h.cha}`;
    return h;
  }

  // ---------------------------------------------------------------------------------------------- the data
  const sx = (v, bits) => (v << (32 - bits)) >> (32 - bits);       // sign-extend the low `bits` bits
  // STEIM1 / STEIM2: 64-byte frames of 16 words; word 0 holds 16 two-bit codes; frame 0's words 1 and 2 are the forward
  // (x0) and reverse (xn) integration constants. Differences are integrated from x0; x[n-1] must equal xn
  function steim(dv, off, end, n, big, v2) {
    const out = new Int32Array(n), d = [];
    let x0 = 0, xn = 0;
    for (let f = off, k = 0; f + 64 <= end && d.length < n; f += 64, k++) {
      const ctl = dv.getUint32(f, !big);
      for (let w = 1; w < 16; w++) {
        const c = (ctl >>> (30 - 2 * w)) & 3, word = dv.getInt32(f + 4 * w, !big);
        if (k === 0 && w === 1) { x0 = word; continue; }
        if (k === 0 && w === 2) { xn = word; continue; }
        if (c === 0) continue;
        if (c === 1) { for (let b = 0; b < 4; b++) d.push(sx(word >>> (24 - 8 * b), 8)); continue; }
        if (!v2) {
          if (c === 2) { d.push(sx(word >>> 16, 16)); d.push(sx(word, 16)); }
          else d.push(word);
          continue;
        }
        const dn = (word >>> 30) & 3;
        if (c === 2) {
          if (dn === 1) d.push(sx(word, 30));
          else if (dn === 2) { d.push(sx(word >>> 15, 15)); d.push(sx(word, 15)); }
          else if (dn === 3) { for (let b = 0; b < 3; b++) d.push(sx(word >>> (20 - 10 * b), 10)); }
          else throw new Error("STEIM2: a bad sub-code (dnib 0 under code 2)");
        } else {
          if (dn === 0) { for (let b = 0; b < 5; b++) d.push(sx(word >>> (24 - 6 * b), 6)); }
          else if (dn === 1) { for (let b = 0; b < 6; b++) d.push(sx(word >>> (25 - 5 * b), 5)); }
          else if (dn === 2) { for (let b = 0; b < 7; b++) d.push(sx(word >>> (24 - 4 * b), 4)); }
          else throw new Error("STEIM2: a bad sub-code (dnib 3 under code 3)");
        }
      }
    }
    if (d.length < n) throw new Error(`STEIM${v2 ? 2 : 1}: ${d.length} differences for ${n} samples`);
    out[0] = x0;
    for (let i = 1; i < n; i++) out[i] = out[i - 1] + d[i];
    if (n && out[n - 1] !== xn) throw new Error(`STEIM${v2 ? 2 : 1}: the last sample ${out[n - 1]} is not the reverse integration constant ${xn}`);
    return out;
  }
  // one record (an ArrayBuffer of exactly one record) → {h, data}
  function decodeRecord(buf, hdr) {
    const h = hdr || parseHeader(buf), dv = new DataView(buf), n = h.nsamp, off = h.dataOff, end = h.reclen ? Math.min(buf.byteLength, h.reclen) : buf.byteLength;
    if (h.encoding == null) throw new Error(`${h.nslc}: no blockette 1000 (the encoding is unknown)`);
    const big = h.wordBig !== false;
    let data;
    switch (h.encoding) {
      case 10: data = steim(dv, off, end, n, big, false); break;
      case 11: data = steim(dv, off, end, n, big, true); break;
      case 1: data = new Int32Array(n); for (let i = 0; i < n; i++) data[i] = dv.getInt16(off + 2 * i, !big); break;
      case 3: data = new Int32Array(n); for (let i = 0; i < n; i++) data[i] = dv.getInt32(off + 4 * i, !big); break;
      case 4: data = new Float32Array(n); for (let i = 0; i < n; i++) data[i] = dv.getFloat32(off + 4 * i, !big); break;
      case 5: data = new Float64Array(n); for (let i = 0; i < n; i++) data[i] = dv.getFloat64(off + 8 * i, !big); break;
      default: throw new Error(`${h.nslc}: encoding ${h.encoding} (${ENC[h.encoding] || "unknown"}) is not read here`);
    }
    return { h, data };
  }
  // a buffer of whole records of one length → [{h, data}] (records of no samples, e.g. log records, are skipped)
  function decodeRecords(buf, reclen, from = 0) {
    const out = [];
    for (let o = from; o + 48 <= buf.byteLength; o += reclen) {
      const one = buf.slice(o, o + reclen), h = parseHeader(one);
      if (!h.nsamp || !h.fs) continue;
      out.push(decodeRecord(one, h));
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------- merging (obspy -1)
  // records (in file order) → segments per channel {nslc, t0, fs, data}, as obspy.read + Stream.merge(method=-1) give them:
  //  1. reading (libmseed): a record that starts within half a sample of where its channel's current trace ends joins it
  //     (on the trace's own sample grid); anything else starts a new trace;
  //  2. cleanup (obspy Stream._cleanup, misalignment 0.01): traces sorted by start; a start within 1% of a sample of the
  //     grid is aligned to it; an overlap on aligned samples joins when the common samples are identical (the repeat is
  //     dropped); an exactly adjacent trace joins; everything else stays a separate segment
  const concat = (parts, n) => { const d = new parts[0].constructor(n); let k = 0; for (const p of parts) { d.set(p, k); k += p.length; } return d; };
  function mergeRecords(recs) {
    const traces = [], cur = new Map();
    for (const r of recs) {
      const id = r.h.nslc, fs = r.h.fs, dt = 1 / fs, s = cur.get(id);
      if (s && s.fs === fs && Math.abs(r.h.start - (s.t0 + s.n * dt)) <= 0.5 * dt) { s.parts.push(r.data); s.n += r.data.length; continue; }
      const ns = { nslc: id, t0: r.h.start, fs, parts: [r.data], n: r.data.length };
      traces.push(ns); cur.set(id, ns);
    }
    return mergeSegments(traces.map((t) => ({ nslc: t.nslc, t0: t.t0, fs: t.fs, data: concat(t.parts, t.n) })));
  }
  // stage 2 alone, for segments from several files of one channel (SDS days, loose files)
  function mergeSegments(segs) {
    const by = new Map();
    for (const tr of segs) { if (!by.has(tr.nslc)) by.set(tr.nslc, []); by.get(tr.nslc).push(tr); }
    const out = [];
    for (const [, list] of by) {
      list.sort((a, b) => a.t0 - b.t0 || (a.t0 + a.data.length / a.fs) - (b.t0 + b.data.length / b.fs));
      let c = list[0];
      for (let k = 1; k < list.length; k++) {
        const t = list[k];
        if (t.fs !== c.fs) { out.push(c); c = t; continue; }
        const dt = 1 / c.fs, endC = c.t0 + (c.data.length - 1) * dt;
        let ts = t.t0;
        const gap = ts - (endC + dt);
        if (gap <= 0.01 * dt) {
          const mis = ((gap % dt) + dt) % dt;
          if (mis !== 0 && (mis / dt <= 0.01 || mis / dt >= 0.99)) ts = c.t0 + Math.round((ts - c.t0) / dt) * dt;
        }
        let sub = ((((ts - c.t0) % dt) + dt) % dt) / dt; sub = Math.min(sub, 1 - sub);
        const endT = ts + (t.data.length - 1) * dt, eps = 1e-3 * dt;
        if (ts <= endC + eps && sub < 0.01) {
          const i0 = Math.round((ts - c.t0) / dt), n = Math.round((Math.min(endC, endT) - ts) / dt) + 1;
          let same = true; for (let i = 0; same && i < n; i++) if (c.data[i0 + i] !== t.data[i]) same = false;
          if (same) { if (t.data.length > n) c = { ...c, data: concat([c.data, t.data.subarray(n)], c.data.length + t.data.length - n) }; }
          else { out.push(c); c = { ...t, t0: ts }; }
        } else if (Math.abs(ts - (endC + dt)) <= eps) c = { ...c, data: concat([c.data, t.data], c.data.length + t.data.length) };
        else { out.push(c); c = { ...t, t0: ts }; }
      }
      out.push(c);
    }
    return out.sort((a, b) => (a.nslc < b.nslc ? -1 : a.nslc > b.nslc ? 1 : a.t0 - b.t0));
  }

  // ---------------------------------------------------------------------------------------------- a file, seekable
  // blob: a File / Blob (a picked folder's file), or anything with .size and .slice(a, b).arrayBuffer()
  class MseedFile {
    constructor(blob, name) { this.blob = blob; this.name = name || blob.name || "?"; this.reclen = null; this.nrec = 0; this.first = null; this._t = new Map(); }
    async _bytes(a, b) { return this.blob.slice(a, b).arrayBuffer(); }
    async open() {
      const head = await this._bytes(0, Math.min(this.blob.size, 4096));
      const h = parseHeader(head);
      if (!h.reclen) throw new Error(`${this.name}: no blockette 1000 (the record length is unknown)`);
      this.reclen = h.reclen; this.nrec = Math.floor(this.blob.size / h.reclen); this.first = h;
      this.nslc = h.nslc; this.fs = h.fs; this.encoding = ENC[h.encoding] || h.encoding;
      return this;
    }
    async recTime(i) {
      if (!this._t.has(i)) this._t.set(i, parseHeader(await this._bytes(i * this.reclen, i * this.reclen + Math.min(this.reclen, 128))).start);
      return this._t.get(i);
    }
    // the index of the last record starting at or before t (bisection: ~log2(nrec) header reads)
    async recordAt(t) {
      let lo = 0, hi = this.nrec - 1;
      if ((await this.recTime(lo)) >= t) return 0;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if ((await this.recTime(mid)) <= t) lo = mid; else hi = mid - 1; }
      return lo;
    }
    async span() {
      const last = await this._bytes((this.nrec - 1) * this.reclen, this.nrec * this.reclen), h = parseHeader(last);
      return [await this.recTime(0), h.start + h.nsamp / h.fs];
    }
    // the samples in [t0, t1): the records holding them, read in blocks (never the whole file), merged as obspy -1, then
    // cut by index arithmetic (a sample at t belongs where t0 <= t < t1, as W1's sources cut chunks)
    async read(t0, t1, { blockRecords = 4096, signal } = {}) {
      const i0 = await this.recordAt(t0), recs = [];
      for (let i = i0; i < this.nrec; i += blockRecords) {
        if (signal && signal.aborted) throw new DOMException("cancelled", "AbortError");
        const n = Math.min(blockRecords, this.nrec - i), buf = await this._bytes(i * this.reclen, (i + n) * this.reclen);
        const got = decodeRecords(buf, this.reclen);
        recs.push(...got);
        if (!got.length || got[got.length - 1].h.start >= t1) break;
      }
      return cut(mergeRecords(recs), t0, t1);
    }
  }
  // W1's slice_trace (pipeline/sources.py), the same arithmetic: samples with time in [t0, t1), an exact partition
  function cut(segs, t0, t1) {
    const out = [];
    for (const s of segs) {
      const a = t0 === -Infinity ? 0 : Math.max(0, Math.ceil((t0 - s.t0) * s.fs - 1e-6)), b = t1 === Infinity ? s.data.length : Math.min(s.data.length, Math.ceil((t1 - s.t0) * s.fs - 1e-6));
      if (b > a) out.push({ nslc: s.nslc, t0: s.t0 + a / s.fs, fs: s.fs, data: s.data.subarray(a, b) });
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------- what a folder holds
  // SDS (YEAR/NET/STA/CHA.D/NET.STA.LOC.CHA.D.YEAR.DOY), one file per channel-year, or loose files: every file is opened
  // by its first header (not by its name), so a folder's layout only matters for the label
  async function scanFiles(files, { onStep } = {}) {
    const found = [], skipped = [];
    let n = 0;
    for (const f of files) {
      n++;
      if (onStep && n % 25 === 0) onStep(n, files.length);
      if (f.size < 128 || /(^|\/)\./.test(f.webkitRelativePath || f.relPath || f.name)) { skipped.push(f); continue; }
      try { found.push(await new MseedFile(f, f.webkitRelativePath || f.relPath || f.name).open()); } catch (_) { skipped.push(f); }
    }
    const sds = found.length > 0 && found.every((m) => /\d{4}\/[^/]+\/[^/]+\/[^/]+\.D\/[^/]+\.D\.\d{4}\.\d{3}$/.test(m.name));
    const byChan = new Map();
    for (const m of found) { if (!byChan.has(m.nslc)) byChan.set(m.nslc, []); byChan.get(m.nslc).push(m); }
    return { files: found, skipped: skipped.length, layout: sds ? "SDS" : found.length && found.every((m) => m.nrec * m.reclen > 200e6) ? "year files" : "loose files", channels: byChan };
  }

  root.SvkMseed = { parseHeader, decodeRecord, decodeRecords, mergeRecords, mergeSegments, cut, MseedFile, scanFiles, rate, ENC };
})(typeof self !== "undefined" ? self : globalThis);
