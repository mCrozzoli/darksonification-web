/* hourview.js — the shared controller of the two HOUR-OF-DAY views, spectro.html and mfcc.html.
 *
 * The two views differ only in what a row is (a third-octave band, an MFCC coefficient) and how a
 * cell is coloured. Everything else is this module, so the two cannot drift apart again (they did:
 * mfcc sent no diel window at all while spectro did):
 *
 *   RESOLUTION  MONTH = the month's mean hour (L0), DAY = one day's own 24 hours (L1). Its own
 *               localStorage key: `rewild_resolution` belongs to the scatter and the biplot, and
 *               switching here must not flip them.
 *   SELECTION   ONE month at a time (Miguel 2026-09-26) — MonthBar.mount({single:true}) never
 *               touches the shared SHOWN filter — and, at DAY, one day from a calendar.
 *   DAY DATA    asked of the bridge one month at a time ({type:"spectral_day"}, ~110-190 kB),
 *               never shipped in init (~5 MB a channel). Replies echo channel+month+kind and a
 *               stale one is dropped.
 *   SOUND       a hovered HOUR names a diel window (diel.js), and that is all the sound hears:
 *                 MONTH  {type:"drv", level:0, mkey, win}  — the month × window point, or the
 *                        whole month where the index data has no such window (and says so)
 *                 DAY    {type:"drv", level:1, widx}       — that day's window, or, where the
 *                        index data has no such window that day, the day's NEAREST window
 *                        (there is no whole-day L1 point; the page says which one you hear)
 *               An unrecorded / dropout hour sends NOTHING — and nothing is not silence: the
 *               engine keeps playing the last point, so the page names it ("sound unchanged").
 *               then {type:"select"} for the room: year:Y, the L0 year or season for a month.
 *               Point FIRST, room second: one voicing, in the right room. (Room-then-point used
 *               to leave the new point in `all` for good - the bridge re-voiced its last point,
 *               which fell back and wrote `all` back. Since 2026-09-27, TASKS P20, a room the last
 *               point is not in RESTS the drone there instead, so either order is safe; this one
 *               still saves a voicing.) A room that did not change is a no-op.
 *   SUPPORT     how much recording stands behind a cell (the hover box and the FADE):
 *                 MONTH  nd days, nm minutes. Faded under 5 h of recording (under 2 h: fainter).
 *                        Minutes are the honest measure: 5 days of 4 minutes is not 5 hours. The
 *                        month mean is MINUTE-weighted (partial hours run +12..14 dB loud at <=5
 *                        min, measured 2026-09-26), so a 4-minute hour counts 4/60 of a full one.
 *                 DAY    nw of 60 minutes. Faded under 30 min, fainter at 5 min or less (a
 *                        <=5-minute hour sits 0.69-0.78 colour units from its peers; full hours
 *                        0.13-0.20). The 48-56-minute regime is normal and is NOT faded.
 *
 * cfg: { kind:"tol"|"mfcc", send(obj), channel(), months()->["YYYY-MM"], monthEntry(mk)->entry,
 *        onChange() (redraw), rowName:"frequency band"|"coefficient" }
 */
window.HourView = (function(){
  const LS_RES = "rewild_hour_res";
  // WHERE spectro and mfcc last were ("YYYY-MM" or "YYYY-MM-DD"): the two views share it, so
  // opening mfcc from spectro lands on the same month/day. They used to share it by way of
  // SHOWN, which the single-choice strip no longer writes.
  const LS_AT = "rewild_hour_at";
  const MON = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const WDAY = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
  const pad = n => String(n).padStart(2, "0");

  // WHICH ROOM a single month is heard in, at L0. Year BEFORE season, deliberately: sweeping
  // the month strip keeps one room for a whole year so the months are heard against each other.
  // 2026 has no L0 year subset, so its months fall back to a season, then to the deployment.
  function subsetL0(mk){
    const y = +mk.slice(0,4), m = +mk.slice(5,7);
    if (y >= 2023 && y <= 2025) return "year:" + y;
    if (m >= 5 && m <= 7) return "season:summer";
    if (m === 11 || m === 12 || m === 1) return "season:winter";
    return "all:2023-2026";
  }
  // at L1 every window is a member of its year's room (2023-2026, checked row by row). Never
  // diel:* — hovering into another window would fall out of it and collapse the room to `all`.
  const subsetL1 = dk => "year:" + dk.slice(0,4);

  function create(cfg){
    const S = { res: "month", monthKey: null, dayKey: null, wantDay: null,
                days: new Map(), daysMonth: null, dmeta: null, why: null, pending: null,
                voiceOnArrive: false, lastTag: null, lastWin: null, lastPoint: null };
    try { if (localStorage.getItem(LS_RES) === "day") S.res = "day"; } catch (e) {}
    const q = new URLSearchParams(location.search);
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.get("d") || "")) { S.res = "day"; S.dayKey = q.get("d"); S.monthKey = S.dayKey.slice(0,7); }
    else if (/^\d{4}-\d{2}$/.test(q.get("m") || "")) S.monthKey = q.get("m");
    let _fromStore = false;
    if (!S.monthKey) try {
      const v = localStorage.getItem(LS_AT) || "";
      // a stored DAY is only ever written at DAY resolution, so it brings that resolution back too
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) { S.monthKey = v.slice(0,7); S.dayKey = v; S.res = "day"; _fromStore = true; }
      else if (/^\d{4}-\d{2}$/.test(v)) { S.monthKey = v; _fromStore = true; }
    } catch (e) {}
    function remember(){
      if (!S.monthKey) return;
      try { localStorage.setItem(LS_AT, isDay() && S.dayKey ? S.dayKey : S.monthKey); } catch (e) {}
    }

    const send = o => cfg.send(o);
    const isDay = () => S.res === "day";

    // ---- what is on screen ----------------------------------------------------------------
    function entry(){ return isDay() ? (S.days.get(S.dayKey) || null) : cfg.monthEntry(S.monthKey); }
    function traceKey(){ return isDay() ? (S.dayKey ? "w:" + S.dayKey : null) : S.monthKey; }
    function label(e){
      e = e || entry(); if (!e) return "";
      if (e.day == null) return `${MON[e.month]} ${e.year}`;
      const wd = new Date(Date.UTC(e.year, e.month-1, e.day)).getUTCDay();
      return `${WDAY[wd]} ${e.day} ${MON[e.month]} ${e.year}`;
    }

    // what the engine is still playing: this page's last committed point, as a listener reads it
    function pointLabel(){
      const p = S.lastPoint; if (!p) return null;
      if (p.startsWith("w:")) {                       // "w:YYYY-MM-DD:win"
        const [, dk, w] = p.split(":"); const [y, m, d] = dk.split("-").map(Number);
        return `${WDAY[new Date(Date.UTC(y, m-1, d)).getUTCDay()]} ${d} ${MON[m]} ${y} · ${w}`;
      }
      const [mk, w] = p.split("|");                   // "YYYY-MM|win" or "YYYY-MM|month"
      return `${MON[+mk.slice(5,7)]} ${mk.slice(0,4)} · ${w === "month" ? "whole month" : w}`;
    }

    // ---- day data --------------------------------------------------------------------------
    // Rows as the bridge sends them (one per recorded hour) -> [row][24], the shape the month
    // entries already have, so a page draws a day exactly as it draws a month.
    function expand(d, meta){
      const at = h => d.hrs.indexOf(h);
      const grid = n => Array.from({ length: n }, () => new Array(24).fill(null));
      if (cfg.kind === "mfcc") {
        const nc = meta.n_coeffs || (d.v.find(Boolean) || []).length;
        d.mat = grid(nc); d.raw = grid(nc);
        d.hrs.forEach((h, i) => { if (!d.v[i]) return;
          for (let c = 0; c < nc; c++) { d.mat[c][h] = d.v[i][c]; d.raw[c][h] = d.raw_rows[i][c]; } });
      } else {
        const nb = (meta.bands_hz || []).length;
        d.tol = grid(nb); d.db = grid(nb);
        d.hrs.forEach((h, i) => { if (!d.v[i]) return;
          (meta.t_bands || []).forEach((b, j) => { d.tol[b][h] = d.v[i][j]; });
          (meta.d_bands || []).forEach((b, j) => { d.db[b][h] = d.raw_rows[i][j]; }); });
      }
      d.minutes = d.nw.reduce((a, n, h) => a + ((d.drop || []).includes(h) ? 0 : n), 0);   // dropouts are not recording
      return d;
    }
    function requestDays(mk){
      if (!mk) return;
      if (S.daysMonth === mk && S.daysChannel === cfg.channel() && S.days.size) { arrive(); return; }
      S.pending = mk; S.days = new Map(); S.daysMonth = null;
      send({ type: "spectral_day", channel: cfg.channel(), month: mk, kind: cfg.kind });
    }
    function arrive(){                               // choose the day, voice it if asked, redraw
      if (!S.days.has(S.dayKey)) {
        const keys = [...S.days.keys()];
        const want = S.wantDay && keys.find(k => +k.slice(8) === S.wantDay);
        S.dayKey = want || keys[0] || null;
      }
      S.wantDay = null; S.lastTag = null; remember();
      if (S.voiceOnArrive) { S.voiceOnArrive = false; voiceWin(S.lastWin); }
      cfg.onChange();
    }
    function onMessage(m){
      if (!m || m.type !== "spectral_day") return false;
      if (m.kind !== cfg.kind || m.channel !== cfg.channel() || m.month !== S.pending) return true;   // stale
      S.pending = null; S.dmeta = m.meta || {}; S.why = m.why || null;
      (m.days || []).forEach(d => { d.raw_rows = d.raw; delete d.raw; });
      S.days = new Map((m.days || []).map(d => [d.key, expand(d, S.dmeta)]));
      S.daysMonth = m.month; S.daysChannel = m.channel;
      if (isDay() && m.month === S.monthKey) arrive();
      return true;
    }

    // ---- sound -----------------------------------------------------------------------------
    function sendL0(win){
      const mk = S.monthKey; if (!mk) return;
      const tag = "m:" + mk + "|" + (win || "");
      if (tag === S.lastTag) return;
      S.lastTag = tag; if (win) S.lastWin = win;
      S.lastPoint = mk + "|" + (win || "month");
      send({ type: "drv", level: 0, mkey: mk, win: win || undefined, channel: cfg.channel() });
      send({ type: "select", level: 0, subset: subsetL0(mk) });            // point first, room second
    }
    function sendL1(widx, win){
      const dk = S.dayKey; if (!dk || widx == null) return;
      const tag = "d:" + dk + ":" + win;
      if (tag === S.lastTag) return;
      S.lastTag = tag; S.lastWin = win;
      S.lastPoint = "w:" + dk + ":" + win;
      send({ type: "drv", level: 1, widx, channel: cfg.channel() });
      send({ type: "select", level: 1, subset: subsetL1(dk) });            // point first, room second
    }
    // The day's own window nearest to `win` — itself, else the next, the previous, the opposite —
    // or its first. Never null for a recorded day (every one of the 736 air days has a window).
    // There is no whole-day L1 point, so this is the day's honest stand-in; dawn is missing on
    // 322 of 736 air days, and sending nothing there left the previous day (or year) playing.
    function dayWin(e, win){
      const has = w => !!w && !!e.widx && e.widx[w] != null;
      if (has(win)) return win;
      const i = DIEL.ORDER.indexOf(win);
      const cand = i < 0 ? DIEL.ORDER : [1, 3, 2].map(k => DIEL.ORDER[(i + k) % 4]);
      return cand.find(has) || null;
    }
    // voice the thing on screen at window `win` (a pick carries the window you were last on).
    // At DAY a stand-in window does not overwrite the one you carry: stepping on to a day that
    // has it goes back to it.
    function voiceWin(win){
      const e = entry(); if (!e) return;
      if (isDay()) {
        const w = dayWin(e, win);
        if (w) { const keep = S.lastWin; sendL1(e.widx[w], w); if (win && w !== win) S.lastWin = keep; }
      } else sendL0(DIEL.voiced(e, win) || null);
    }

    // ---- one hour: what it is, what it sounds, what stands behind it ------------------------
    function info(h){
      const e = entry(); if (!e) return null;
      const sun = DIEL.sunOf(e), win = sun ? DIEL.at(h, sun) : null;
      const out = { e, h, win, recorded: DIEL.recorded(e, h), drop: !!(e.drop && e.drop.includes(h)) };
      if (isDay()) {
        const fb = win ? dayWin(e, win) : null;
        out.widx = fb ? e.widx[fb] : undefined;
        out.sound = out.recorded && fb ? fb : null;
        out.why = out.recorded && fb && fb !== win ? `no ${win} window in the index data this day — you hear its ${fb}` : null;
        const n = e.nw ? e.nw[h] : null;
        out.minutes = n;
        out.fade = n == null || !out.recorded ? 1 : n <= 5 ? 0.22 : n < 30 ? 0.5 : 1;
        out.support = n == null ? "" : `${n} of 60 min recorded` + (n < 30 ? " — thin, read with care" : "");
        if (!out.recorded) out.still = pointLabel();
      } else {
        const vw = DIEL.voiced(e, win);
        out.sound = out.recorded ? (vw || "month") : null;
        out.why = out.recorded && !vw ? `no ${win} windows in the index data this month — you hear the whole month` : null;
        const nm = e.nm ? e.nm[h] : null, nd = e.nd ? e.nd[h] : null;
        out.minutes = nm;
        out.fade = nm == null || !out.recorded ? 1 : nm < 120 ? 0.3 : nm < 300 ? 0.55 : 1;
        // floor, not round: 297 min must not print "5.0 h" beside "thin, under 5 h"
        const amt = nm < 60 ? `${nm} min` : nm < 600 ? `${(Math.floor(nm / 6) / 10).toFixed(1)} h` : `${Math.floor(nm / 60)} h`;
        const dim = new Date(Date.UTC(e.year, e.month, 0)).getUTCDate();       // the calendar month, not its recorded days
        out.support = nm == null ? "" : `${nd} of ${dim} days · ${amt} recorded`
          + (nm < 300 ? " — thin, read with care" : "");
        if (!out.recorded) out.still = pointLabel();
      }
      return out;
    }
    function voiceHour(h){
      const i = info(h); if (!i || !i.recorded) return i;
      if (isDay()) { if (i.widx != null) sendL1(i.widx, i.sound); }
      else sendL0(i.sound === "month" ? null : i.sound);
      return i;
    }
    // the key's lines about hatching and fading, for the resolution on screen
    function supportKey(){
      return isDay()
        ? "Faded = under 30 min recorded in that hour (fainter at 5 min or less)."
        : "Faded = under 5 h of recording behind the cell — few days, or short hours (fainter under 2 h).";
    }
    function scaleNote(){
      return isDay()
        ? "Scaled over every DAY and hour of this recorder: one day swings wider than a month's average, so day colours compare with other days, not with the month view. The hover box gives the real value."
        : "Scaled over ALL months and hours: a colour means the same in every month, so compare months and read along a row. Rows are scaled separately — never compare one row's brightness with another's.";
    }

    // ---- picking ---------------------------------------------------------------------------
    function pickMonth(mk){
      if (!mk || !cfg.monthEntry(mk)) return;
      if (mk === S.monthKey) return;
      S.monthKey = mk; S.lastTag = null;
      if (isDay()) { S.wantDay = S.dayKey ? +S.dayKey.slice(8) : null; S.dayKey = null;
                     S.voiceOnArrive = true; requestDays(mk); }
      else voiceWin(S.lastWin);
      remember(); cfg.onChange();
    }
    function pickDay(dk){
      if (!dk || !S.days.has(dk) || dk === S.dayKey) return;
      S.dayKey = dk; S.lastTag = null;
      voiceWin(S.lastWin);
      remember(); cfg.onChange();
    }
    // A legend chip has already voiced an L0 MONTH. Follow it to month resolution without
    // sounding anything, and put the room in step (the chip's point first, this room second).
    function followChip(mk){
      if (!mk || !cfg.monthEntry(mk)) return;
      if (isDay()) setRes("month", { silent: true });
      S.monthKey = mk; S.lastTag = null; S.lastPoint = mk + "|month";
      send({ type: "select", level: 0, subset: subsetL0(mk) });
      remember(); cfg.onChange();
    }
    function setRes(r, o){
      o = o || {};
      if (r !== "day") r = "month";
      if (r === S.res) return;
      S.res = r; S.lastTag = null;
      try { localStorage.setItem(LS_RES, r); } catch (e) {}
      remember();
      // level mix defaults are the BRIDGE's: applied when this level's first point sounds, and
      // only until the listener has moved a fader (P26: this call no longer touches the mix)
      if (window.WC && WC.setLevelDefaults) WC.setLevelDefaults(r);
      if (r === "day") { S.voiceOnArrive = !o.silent; requestDays(S.monthKey); }
      else if (!o.silent) voiceWin(S.lastWin);
      renderControls(); cfg.onChange();
    }

    // ---- the month the view opens on ------------------------------------------------------
    // ?d= / ?m= first; then the month the view was already on (a channel re-init keeps it);
    // then where spectro/mfcc last were (LS_AT), then May of the first year. seedFromShown() is a ONE-SHOT after
    // WC.init: arriving from a view that SHOWS some months, open on the last of them that has
    // an image here. Never re-applied — this view no longer follows SHOWN.
    function ensureMonth(){
      const ms = cfg.months();
      if (S.monthKey && cfg.monthEntry(S.monthKey)) return;
      S.dayKey = null;
      // May of the first year: a spring month with the dawn chorus in it (not "the fullest" -
      // coverage varies; it is simply a month worth opening on)
      S.monthKey = ms.find(k => k.endsWith("-05")) || ms[0] || null;
    }
    let _seeded = false;
    function seedFromShown(){
      if (_seeded) return; _seeded = true;
      if (q.get("m") || q.get("d") || !window.WC || !WC.shownMonths) return;
      const sh = [...WC.shownMonths()].filter(k => cfg.monthEntry(k)).sort();
      if (_fromStore && (!sh.length || sh.includes(S.monthKey))) return;   // the sibling view's spot stands
      if (sh.length && sh[sh.length-1] !== S.monthKey) {
        S.monthKey = sh[sh.length-1];
        if (isDay()) { S.dayKey = null; requestDays(S.monthKey); }
        remember();
      }
    }
    // a (re)init: new data, maybe a new channel. Keep the month; at DAY, re-ask for its days.
    function onInit(){
      ensureMonth(); S.lastTag = null;
      // an init may be a NEW CHANNEL: never keep another channel's days (their widx are its rows)
      S.days = new Map(); S.daysMonth = null; S.daysChannel = null; S.pending = null; S.dmeta = null; S.why = null;
      if (isDay()) requestDays(S.monthKey);
      renderControls();
    }

    // ---- the controls: resolution toggle, month strip, day calendar --------------------------
    let _mbar = null, _dbar = null;
    function renderControls(){
      document.querySelectorAll("#res-toggle .wbtn").forEach(b =>
        b.classList.toggle("on", b.getAttribute("data-res") === S.res));
      if (!_mbar && window.MonthBar) _mbar = MonthBar.mount({ host: "#monthbar", single: true,
        months: () => cfg.months(), current: () => S.monthKey, onPick: pickMonth });
      if (!_dbar && window.MonthBar && document.getElementById("daybar")) _dbar = MonthBar.mountDays({ host: "#daybar",
        month: () => S.monthKey,
        days: () => [...S.days.values()].map(d => ({ key: d.key, minutes: d.minutes })),
        current: () => S.dayKey, onPick: pickDay });
      if (_mbar) _mbar.render();
      const db = document.getElementById("daybar");
      if (db) { db.style.display = isDay() ? "" : "none"; if (isDay() && _dbar) _dbar.render(); }
    }
    document.querySelectorAll("#res-toggle .wbtn").forEach(b =>
      b.addEventListener("click", () => setRes(b.getAttribute("data-res"))));

    return {
      get res(){ return S.res; }, get monthKey(){ return S.monthKey; }, get dayKey(){ return S.dayKey; },
      get dayMeta(){ return S.dmeta; }, get pending(){ return S.pending; }, get why(){ return S.why; },
      isDay, entry, traceKey, label, info, voiceHour, supportKey, scaleNote,
      pointKey: () => S.lastPoint, pointLabel,
      pickMonth, pickDay, followChip, setRes, onMessage, onInit, seedFromShown, renderControls,
      subsetL0,
    };
  }
  return { create };
})();
