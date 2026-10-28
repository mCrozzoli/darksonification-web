// Uncanny Listening — playback of her own files (decoded by the browser from the File in memory; nothing leaves the page).
// play(song, {t0, t1, gain, meta}) plays the song from t0, and stops at t1 when given (a 10 s segment). One sound at a time.
// gain (≤ 1) scales the volume for this play (level matching); meta is handed to onPlay (the Live link reads it).
// ?mute=1 mutes the element (for silent checks on Miguel's machine); setQuiet(true) silences it while Live plays.
import { decodeFlac, flacHeader } from "../core/flac.js";
const listeners = [];
const el = new Audio(); el.preload = "auto";
let cur = null, url = null, stopAt = null, vol = 0.8, gain = 1, urlMute = false, userMute = false, quiet = false;
try { if (new URLSearchParams(location.search).get("mute") === "1") urlMute = true; } catch (_) {}
const applyMute = () => { el.muted = urlMute || userMute || quiet; };
applyMute(); el.volume = vol;
const emit = () => listeners.forEach((f) => { try { f(state()); } catch (e) { console.error(e); } });
export const state = () => ({ song: cur, t: el.currentTime, playing: !el.paused && !el.ended, t0: cur ? cur._t0 : 0, t1: stopAt });
export const onChange = (f) => listeners.push(f);
el.addEventListener("timeupdate", () => { if (stopAt != null && el.currentTime >= stopAt) { el.pause(); stopAt = null; } emit(); });
el.addEventListener("pause", emit); el.addEventListener("ended", emit); el.addEventListener("play", emit);
let missing = null, onPlayCb = null;
export const onPlay = (f) => { onPlayCb = f; };
export const onMissing = (f) => { missing = f; };
export async function play(song, { t0 = 0, t1 = null, keepWalk = false, gain: g = 1, meta = {} } = {}) {
  if (song && !song.file) { missing && missing(song); return; }
  if (!song) return;
  if (!keepWalk) endWalk();
  if (cur !== song) {
    if (url) URL.revokeObjectURL(url); cur = song;
    url = song._wav ? URL.createObjectURL(song._wav) : URL.createObjectURL(song.file); el.src = url;
    let ok = await loaded();
    if (!ok && !song._wav) {                                       // the browser cannot play this file (some FLACs): decode it here, play a WAV
      const buf = await song.file.arrayBuffer();
      if (flacHeader(new Uint8Array(buf, 0, Math.min(buf.byteLength, 1 << 22)))) { song._wav = wavMono(decodeFlac(buf, { mono: true })); URL.revokeObjectURL(url); url = URL.createObjectURL(song._wav); el.src = url; ok = await loaded(); }
    }
    if (!ok) { console.warn("cannot play", song.name); return; }
  }
  song._t0 = t0; stopAt = t1; el.currentTime = t0; gain = Math.max(0, Math.min(1, +g || 0)); el.volume = vol * gain;
  if (onPlayCb) try { onPlayCb(song, t0, t1 ?? song.duration, meta, gain); } catch (e) { console.error(e); }
  try { await el.play(); } catch (e) { console.warn("play", e); }
  emit();
}
function loaded() {
  return new Promise((res) => { const ok = () => { done(); res(true); }, bad = () => { done(); res(false); }, done = () => { el.removeEventListener("loadedmetadata", ok); el.removeEventListener("error", bad); };
    el.addEventListener("loadedmetadata", ok); el.addEventListener("error", bad); });
}
function wavMono({ y, sampleRate }) {                             // 16-bit mono WAV, for listening only
  const n = y.length, b = new ArrayBuffer(44 + 2 * n), v = new DataView(b), w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + 2 * n, true); w(8, "WAVE"); w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, 2 * sampleRate, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, "data"); v.setUint32(40, 2 * n, true);
  const pcm = new Int16Array(b, 44, n); for (let i = 0; i < n; i++) pcm[i] = Math.max(-32768, Math.min(32767, Math.round(y[i] * 32767)));
  return new Blob([b], { type: "audio/wav" });
}
export function stop() { endWalk(); el.pause(); stopAt = null; emit(); }
export function toggle() { if (!cur) return; if (el.paused) el.play().catch(() => {}); else el.pause(); }
export function setVolume(v) { vol = v; el.volume = v * gain; }
export const isMuted = () => el.muted;
export function setMuted(m) { userMute = !!m; applyMute(); emit(); }
export function setQuiet(q) { quiet = !!q; applyMute(); emit(); }
export const isQuiet = () => quiet;

function endWalk() { if (walkTok % 2 === 1) walkTok++; }
// A walk: play [{song, t0, t1, gain?, meta?, gap? (ms before the next, default 250)}] one after the other (10 s each,
// typically). Any other play or stop ends it.
let walkTok = 0;
export function walk(items, onStep = () => {}) {
  if (walkTok % 2 === 0) walkTok++; else walkTok += 2; const my = walkTok; let i = 0;
  const next = async () => {
    if (my !== walkTok) return;
    if (i >= items.length) { endWalk(); onStep(null); emit(); return; }
    const it = items[i++]; onStep(it, i - 1);
    await play(it.song, { t0: it.t0, t1: it.t1, keepWalk: true, gain: it.gain ?? 1, meta: it.meta || {} });
    const done = () => { if (my !== walkTok) return el.removeEventListener("pause", done); if (el.paused && !el.seeking) { el.removeEventListener("pause", done); setTimeout(next, it.gap ?? 250); } };
    el.addEventListener("pause", done);
  };
  next();
  return () => { if (my === walkTok) { endWalk(); el.pause(); onStep(null); } };
}
export const walking = () => walkTok % 2 === 1;
