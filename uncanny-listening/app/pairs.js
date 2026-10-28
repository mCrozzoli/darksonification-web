// Uncanny Listening — minimal pairs and the Live link's derived values (lab/LIVE_TEMPLATE.md §3.5, §5.3b, §6; Miguel's
// choices 2026-10-27: minimal pairs + the difference voice, 5 s slices, level matched, in the page and in Live).
// Pure functions, no DOM: tested in node by probe/node_pairs.mjs.

// the features a pair can focus on: her four descriptors and brillo (the Live link's descriptor keys)
export const FOCUS = [["spectral_flux_mean", "flux", "complejidad"], ["rms_mean", "rms", "dinamica"], ["chroma_mean", "chroma", "armonia"],
  ["spectral_contrast_0_mean", "contrast", "timbre"], ["spectral_centroid_mean", "centroid", "brillo"]];

const quantile = (sorted, q) => sorted.length ? sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1))))] : NaN;

// segs: [{song, k, v}] (v: the segment's row), from 2 or more songs. Every column is z-scored over segs.
//  vary: among the pairs (different songs) whose distance in the other columns is in the lowest `rest` share, the largest
//        |Δ focus| first; A is the lower focus value, so A → B always goes up.
//  hold: among the pairs whose |Δ focus| is in the lowest `same` share, the largest distance in the other columns first.
// Greedy: a segment is used in one pair at most, and each pair of songs gets its share first (at most max(2, ⌈n / song
// pairs⌉) pairs), so with 3–4 songs the pairs spread over the songs; the rest is filled without the share when short.
// Returns [{a, b, df, dr}] (df, dr in z units).
export function minimalPairs(segs, focus, { cols = FOCUS.map((c) => c[0]), mode = "vary", n = 8, rest = 0.2, same = 0.1 } = {}) {
  const others = cols.filter((c) => c !== focus), all = [focus, ...others], N = segs.length;
  const mu = {}, sd = {};
  for (const c of all) { let m = 0; for (const s of segs) m += s.v[c]; m /= N || 1; let q = 0; for (const s of segs) q += (s.v[c] - m) ** 2; mu[c] = m; sd[c] = Math.sqrt(q / (N || 1)) || 1; }
  const Z = segs.map((s) => ({ f: (s.v[focus] - mu[focus]) / sd[focus], o: others.map((c) => (s.v[c] - mu[c]) / sd[c]) }));
  const P = [];
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    if (segs[i].song === segs[j].song) continue;
    let d = 0; for (let c = 0; c < others.length; c++) d += (Z[i].o[c] - Z[j].o[c]) ** 2;
    P.push({ i, j, df: Math.abs(Z[i].f - Z[j].f), dr: Math.sqrt(d) });
  }
  if (!P.length) return [];
  let cand;
  if (mode === "hold") { const t = quantile(P.map((p) => p.df).sort((a, b) => a - b), same); cand = P.filter((p) => p.df <= t).sort((a, b) => b.dr - a.dr || a.i - b.i || a.j - b.j); }
  else { const t = quantile(P.map((p) => p.dr).sort((a, b) => a - b), rest); cand = P.filter((p) => p.dr <= t).sort((a, b) => b.df - a.df || a.i - b.i || a.j - b.j); }
  const songs = [...new Set(segs.map((x) => x.song))], nsp = songs.length * (songs.length - 1) / 2, share = Math.max(2, Math.ceil(n / nsp));
  const used = new Set(), per = new Map(), out = [], taken = [];
  const songPair = (p) => { const a = songs.indexOf(segs[p.i].song), b = songs.indexOf(segs[p.j].song); return a < b ? a + "|" + b : b + "|" + a; };
  for (const capped of [true, false]) for (let c = 0; c < cand.length; c++) {
    if (out.length >= n) break;
    const p = cand[c]; if (taken[c] || used.has(p.i) || used.has(p.j)) continue;
    const sp = songPair(p); if (capped && (per.get(sp) || 0) >= share) continue;
    taken[c] = true; used.add(p.i); used.add(p.j); per.set(sp, (per.get(sp) || 0) + 1);
    let a = segs[p.i], b = segs[p.j];
    if (mode !== "hold" && a.v[focus] > b.v[focus]) [a, b] = [b, a];
    out.push({ a, b, df: p.df, dr: p.dr });
  }
  return out.sort((x, y) => (mode === "hold" ? y.dr - x.dr : y.df - x.df));   // the largest contrast first
}

// the part of a segment to play: `len` seconds centred in it (the whole segment when len ≥ its length)
export function sliceOf(row, len) {
  const a = row.window_start, b = row.window_end;
  if (!(len > 0) || len >= b - a) return [a, b];
  const m = (a + b) / 2; return [m - len / 2, m + len / 2];
}

// Level matching for a pair: her rms was measured on peak-normalised audio, so the file's level is rms × peak. Both play
// at the quieter one's level (gains ≤ 1, never a boost), at most `floorDb` down. capped: the floor was reached.
export function levelGains(rmsA, peakA, rmsB, peakB, floorDb = -12) {
  const ra = rmsA * (peakA || 1), rb = rmsB * (peakB || 1), lo = Math.pow(10, floorDb / 20);
  if (!(ra > 0) || !(rb > 0)) return { ga: 1, gb: 1, capped: false };
  const ref = Math.min(ra, rb), ga = Math.max(lo, ref / ra), gb = Math.max(lo, ref / rb);
  return { ga, gb, capped: ga === lo || gb === lo };
}

// p relative to the threshold: 0.5 exactly at the boundary, 0 / 1 at the extremes (2 classes, piecewise linear).
// More classes: 0.5 + half the winner's margin over the runner-up (0.5 at a tie).
export function pRel(p, thr = 0.5) {
  if (p.length === 2) { const x = p[1]; return x < thr ? 0.5 * x / thr : 0.5 + 0.5 * (x - thr) / (1 - thr); }
  const q = [...p].sort((a, b) => b - a); return 0.5 + 0.5 * (q[0] - q[1]);
}
// how sure: 0 on the boundary, 1 at the extremes
export function margin(p, thr = 0.5) {
  if (p.length === 2) return Math.abs(pRel(p, thr) - 0.5) * 2;
  const q = [...p].sort((a, b) => b - a); return q[0] - q[1];
}
// B − A of the focus (both 0–1), 0.5 when equal, ±0.5 at ±maxAbs
export function diffScaled(fa, fb, maxAbs) {
  if (!(maxAbs > 0)) return 0.5;
  return Math.max(0, Math.min(1, 0.5 + 0.5 * (fb - fa) / maxAbs));
}
