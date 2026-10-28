// Uncanny Listening — the analysis queue: FLAC goes to the workers as bytes (core/flac.js decodes it there, exactly as
// libsndfile); other formats are decoded on the page (decodeAudioData lives there); features in a pool of workers.
// Songs are decoded one at a time and handed to the next free worker; a memory budget (samples in flight) keeps a folder of
// long files from filling the tab: a song waits while the songs in the workers already hold more than the budget.
import { decodeMono } from "./decode.js";
import { flacHeader } from "../core/flac.js";

export function analyseSongs(songs, { cfg = {}, workers = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 2)),
                                      budget = 3.2e8, onSong = () => {}, onProgress = () => {}, cancelled = () => false } = {}) {
  const url = new URL("../core/feature_worker.js", import.meta.url), pool = Array.from({ length: workers }, () => ({ w: new Worker(url, { type: "module" }), busy: null }));
  let inFlight = 0, next = 0, done = 0, failed = 0;
  const t0 = performance.now();
  return new Promise((resolve) => {
    const finish = () => { pool.forEach((p) => p.w.terminate()); resolve({ done, failed, seconds: (performance.now() - t0) / 1000 }); };
    const free = () => pool.find((p) => !p.busy);
    pool.forEach((p) => { p.w.onmessage = (ev) => {
      const m = ev.data, s = p.busy;
      if (m.type === "progress") { onProgress({ song: s.song, done: m.done, total: m.total, finished: done, n: songs.length }); return; }
      inFlight -= s.n; p.busy = null;
      if (m.type === "done") { done++; onSong(s.song, { duration: m.duration, sr_native: m.sr_native, peak: m.peak, l0: m.l0, l1: m.l1, ms: m.ms }); }
      else { failed++; onSong(s.song, { error: m.error }); }
      onProgress({ finished: done + failed, n: songs.length });
      pump();
    }; });
    let decoding = false;
    async function pump() {
      if (decoding) return;
      if (cancelled()) { if (pool.every((p) => !p.busy)) finish(); return; }
      if (next >= songs.length) { if (pool.every((p) => !p.busy)) finish(); return; }
      const p = free(); if (!p) return;
      decoding = true;
      const song = songs[next++];
      try {
        const buf = await song.file.arrayBuffer(), fh = flacHeader(new Uint8Array(buf, 0, Math.min(buf.byteLength, 1 << 22)));
        let msg, n;
        if (fh && fh.total) { n = fh.total; msg = { type: "song", id: song.id, flac: buf, cfg }; }
        else { const { y, sr } = await decodeMono(buf); if (!y.length) throw new Error("decoded 0 samples"); n = y.length; msg = { type: "song", id: song.id, y, sr, cfg }; }
        while (inFlight > 0 && inFlight + n > budget) await new Promise((r) => setTimeout(r, 200));
        const q = free() || p; q.busy = { song, n }; inFlight += n;
        q.w.postMessage(msg, [msg.flac || msg.y.buffer]);
      } catch (e) { failed++; onSong(song, { error: String(e && e.message || e) }); onProgress({ finished: done + failed, n: songs.length }); }
      decoding = false;
      pump();
    }
    if (!songs.length) finish(); else pump();
  });
}
