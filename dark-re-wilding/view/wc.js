/* wc.js — dark_re_wilding shared WEB CONTROL layer (§B2.21).
 *
 * TWO INDEPENDENT SETS, and the whole interaction model is the difference between them.
 *
 *   SHOWN   which months are VISIBLE. Written by the month grid and the year buttons.
 *           Controls opacity / inclusion ONLY: it draws no ring and no aura. EMPTY MEANS
 *           EVERYTHING IS SHOWN — that is what an "all" button restores, and it is the
 *           starting state. localStorage key "rewild_shown".
 *   TRACED  which specific points are ANNOTATED. Written by the trace controls only — the
 *           ◎ button, shift-press on a point, the brush. Draws the ring + aura ONLY: it
 *           never changes anyone else's opacity and never removes anything from view.
 *           localStorage key "rewild_tracked" (kept, so existing traces survive).
 *
 * These used to be ONE set doing both jobs, so choosing a month to LOOK at also dimmed every
 * other month and put a trace ring on it, and tracing a single point hid everything else
 * (Miguel 2026-09-24: "when you trace a data point the other in selection should not
 * dissapear ... trace should be this selection over the visible data points"; and "that
 * aura/circle is for points being traced, not selected for visualization").
 *
 * A traced point whose month is not shown is simply not drawn. It stays in the set and comes
 * back when its month is shown again: tracing is an annotation on the DATA, not a view state.
 *
 * AND ITS ECHOES (2026-09-28). A trace is anchored in time, so the same time in every other
 * year is marked too - dashed, in the trace's colour - in every view. Echoes are DERIVED from
 * TRACED (see ECHOES below), never stored, never told to the GUI; the trace tab switches them off.
 *
 * AND BECAUSE NOTHING IS DIMMED ANY MORE, THERE ARE NO SHADOWS. If a point is drawn you can
 * hear it; if its month is filtered out it is not there at all. The old "hear shadowed
 * points" escape hatch had nothing left to escape and is gone.
 *
 * DUAL-MODE, as before:
 *   - standalone (no GUI): both sets live in localStorage and are shared across the six
 *     pages; fully testable without the desktop app.
 *   - GUI-connected (darkui 'web' controller): a single TRACE (◎, shift-press) also presses the
 *     navigator's "track" (its TRACKED_idx is the same idea) - named first (select_idx) where the
 *     page supplies idxOf (the biplot), else on the GUI's current point. A brush sweep or a clear
 *     replays each changed point only where the page supplies idxOf, and sends nothing elsewhere
 *     (P30; one paced queue, see guiTell). SHOWN is a local display filter and presses nothing —
 *     the GUI has no notion of "which months am I looking at".
 *
 * Requires web_control.js (DarkWebControl) loaded first. A page calls WC.init({...}) with
 * small callbacks, adds <div id="wc"></div> to its sidebar, filters its draw through
 * WC.isShown(key) and rings WC.isTraced(key). Never a header strip.
 */
window.WC = (function () {
  const LS_TRACED = "rewild_tracked";                 // the TRACED set (any resolution)
  const LS_SHOWN  = "rewild_shown";                   // the SHOWN month filter ([] = all)
  const LS_CHAN = "rewild_channel";                   // air|water preference (persists across views)
  function channelPref() { try { const v = localStorage.getItem(LS_CHAN); return (v && v !== "air+water") ? v : "air"; } catch (e) { return "air"; } }   // air+water hidden for now → air
  const LS_SND = "rewild_sound";                      // synth|corpus|both sound-mode (persists across views)
  function soundPref() { try { return localStorage.getItem(LS_SND) || "synth"; } catch (e) { return "synth"; } }
  const LS_LOOP = "rewild_loop";                      // "1"|"0" — loop the event layers (arp+corpus) or one-shot
  function loopPref() { try { return (localStorage.getItem(LS_LOOP) ?? "0") === "1"; } catch (e) { return false; } }
  // WHICH STATISTIC PUTS A ROW ON THE BODY. Two were built and both are shipped. They are
  // NOT two versions of one thing: each encodes a different property of the same month.
  //   gradient = how fast this month is changing (how far it sits from the month before it)
  //   variance = how internally varied it is
  // DEFAULT = gradient (Miguel 2026-09-24, final: "ok, keep gradient for the drone :)"). It was
  // moved to variance earlier the same afternoon and REVERSED; gradient never stopped shipping.
  //
  // WHAT THE DEFAULT COSTS, recorded rather than hidden: under gradient, subset year:2024 puts
  // March at theta 1.8151 rad and July at 1.8500 - 0.035 rad apart out of pi, HALF the median
  // gap between adjacent months (0.070), so two ecologically opposite months land at the same
  // latitude and the body cannot tell them apart. Under variance they are 0.122 rad apart,
  // 3.5x wider and above that reading's median gap (0.087). July->November: 0.617 rad under
  // gradient, 1.053 under variance. Miguel heard that pair as close at every contrast exponent
  // - "in all of them diff btw march and july is thin", which he confirmed means the DIFFERENCE
  // IS SMALL, not that the sound thins out. A listener who wants that pair separated switches
  // the reading below; that is what the option is for, and the legend says so.
  //
  // WHY GRADIENT STAYS ANYWAY: four synthesis slots draw on three near-independent statistics,
  // so whichever statistic sets theta is also read a second time by the clave. Under gradient
  // that second reading is the clave's METRE - with latitude, the two most perceptually
  // separated channels in the design. Under variance it would fall on the clave's TICK RATE, a
  // much closer pairing: latitude and rate move together. Keeping the two doubled channels far
  // apart beat widening one month pair. There is no free fix - three statistics over four slots
  // means a doubling is unavoidable and the only question is where it sits. See dev/README.md.
  const LS_STAT = "rewild_stat";
  // A listener who has explicitly chosen variance keeps variance; everything else is gradient.
  function statPref() { try { return localStorage.getItem(LS_STAT) === "variance" ? "variance" : "gradient"; } catch (e) { return "gradient"; } }
  const LS_BRUSH = "rewild_brush";                    // "1"|"0" — stroke over points to trace (brush.js)
  function brushPref() { try { return localStorage.getItem(LS_BRUSH) === "1"; } catch (e) { return false; } }
  // "1"|"0" — draw the ECHOES (a trace's same time in the other years). ON unless switched off:
  // Miguel asked for them, then for a way to turn them off in the trace tab (2026-09-28).
  const LS_ECHO = "rewild_echo";
  function echoPref() { try { return localStorage.getItem(LS_ECHO) !== "0"; } catch (e) { return true; } }
  // one fader per layer, in the order the engine reads them (/rw_mix)
  const LAYER_FADERS = [
    ["drone",  "drone",  "the bowed body of the current selection — acoustic indices, continuous"],
    ["clave",  "clave",  "the woodblock — this window's statistics as tempo, colour and metre"],
    ["arp",    "arp",    "one sustaining note per species BirdNET claims was here (an inference)"],
    ["corpus", "corpus", "the real Knepp recording of the top species, plus the month's returner (the evidence)"],
  ];
  const MIX_DEFAULTS = { month: [1, 1, 0, 0], day: [1, 1, 1, 1] };   // L0 / L1
  let mix = [1, 1, 1, 1];
  // MASTER volume + mute, as the bridge last echoed them ({type:"master", vol, mute} -> applyMaster).
  // The bridge owns them since 2026-10-01 (rw_core SOUND["master"]: what SC plays; an un-mute returns
  // to the volume before the mute, P51) and
  // echoes them when a page connects, after every change and on mixquery - so a view link no longer
  // restarts the slider at 0.8, unmuted, over an engine that is somewhere else. 0.8 / unmuted is only
  // what the panel shows until the first echo arrives.
  const master = { vol: 0.8, mute: false };
  const gold = () => RWLook.d.gold;   // the TRACE colour, per look (rewild_tokens.css --rw-gold); views add a glow+pulse so it shines out of the data
  // per-item palette, used twice over: once to colour a TRACED point's ring, once to colour a
  // SHOWN month in an overlay (linear's day-for-day comparison). Same wheel, two sets.
  const PALETTE = RWLook.palette;         // the eight slots, per look (--rw-t0…7), refilled in place by looks.js

  // THE TWO SETS.
  //   shown  — MONTH keys only ("YYYY-MM"). Empty = no filter = every month visible.
  //   traced — keys at WHATEVER RESOLUTION you traced at: "YYYY-MM", "w:YYYY-MM-DD",
  //            "w:YYYY-MM-DD:dawn". Never collapsed, so switching month <-> day keeps the
  //            finer traces; isTraced() resolves for display instead.
  let shown = new Set();
  let traced = new Set();
  let _echo = null;             // the echo index over `traced` (see ECHOES); null = stale
  let opts = {};
  let statusEl = null, clearBtn = null;

  function readSet(key) {
    const out = new Set();
    try { JSON.parse(localStorage.getItem(key) || "[]").forEach(v => out.add(v)); } catch (e) {}
    return out;
  }
  function load() {
    const raw = readSet(LS_TRACED);
    // A BARE DATE ("2025-05-12") is a legacy trace: an old scatter wrote one at day resolution
    // (index.html, hover()). isTracedMonth folds it (monthOf) but isTraced and the echoes do not,
    // so one month rang as traced in the biplot and as an echo in the roses (review 2026-09-28).
    // It becomes the whole-day key it meant - the old ◎ had lost which window - once, and stays so.
    const bare = k => typeof k === "string" && /^\d{4}-\d{2}-\d{2}$/.test(k);
    traced = new Set([...raw].map(k => bare(k) ? "w:" + k : k));
    shown  = readSet(LS_SHOWN);
    _echo = null;                                     // the trace index is built from `traced`
    if ([...raw].some(bare)) saveTraced();
  }
  // every TRACED mutation saves through here, so this is where the trace index goes stale
  function saveTraced() { _echo = null; try { localStorage.setItem(LS_TRACED, JSON.stringify([...traced])); } catch (e) {} }
  function saveShown()  { try { localStorage.setItem(LS_SHOWN,  JSON.stringify([...shown]));  } catch (e) {} }

  // ---- key arithmetic -----------------------------------------------------------------
  // Every key a view can hand us folds to a month: that is what the visibility filter tests.
  //   "2023-03"                -> "2023-03"
  //   "2023-03-23"             -> "2023-03"
  //   "w:2023-03-23:dawn"      -> "2023-03"
  //   "w:2023-03"              -> "2023-03"
  function monthOf(key) {
    if (typeof key !== "string" || !key) return null;
    const k = key.startsWith("w:") ? key.slice(2) : key;
    return /^\d{4}-\d{2}/.test(k) ? k.slice(0, 7) : null;
  }

  // ---- SHOWN: what is visible ---------------------------------------------------------
  // EMPTY MEANS EVERYTHING. A view never has to special-case "nothing selected yet".
  function isShownMonth(mk) { return !shown.size || (!!mk && shown.has(mk)); }
  // The per-datum predicate. Pass any key shape; anything that has no month in it (a
  // synthetic row, an aggregate) is shown, because the filter has nothing to say about it.
  function isShown(key) {
    if (!shown.size) return true;
    const mk = monthOf(key);
    return mk ? shown.has(mk) : true;
  }
  function toggleShown(mk) {
    if (!mk) return false;
    if (shown.has(mk)) shown.delete(mk); else shown.add(mk);
    saveShown(); fireChange();
    return shown.has(mk);
  }
  // SET-VALUED, for the month grid's drag. One mutation, one save, one redraw — not a loop
  // over toggleShown(), which would write localStorage and re-render once per month crossed.
  // mode: "add" (default) | "remove" | "set" (replace the whole filter)
  function setShown(keys, mode) {
    const list = (keys || []).filter(Boolean);
    const before = shown.size, had = [...shown].join("|");
    if (mode === "set") { shown = new Set(list); }
    else if (mode === "remove") { list.forEach(k => shown.delete(k)); }
    else { list.forEach(k => shown.add(k)); }
    if (shown.size === before && [...shown].join("|") === had) return 0;
    saveShown(); fireChange();
    return Math.abs(shown.size - before);
  }
  function showAll() {                       // the "all" button: drop the filter entirely
    if (!shown.size) return;
    shown.clear(); saveShown(); fireChange();
  }

  // ---- TRACED: the annotation ---------------------------------------------------------
  // The resolver. An exact key matches exactly. A MONTH key also matches when any WINDOW of
  // that month is traced, so tracing three days in March rings March in the month views while
  // the day view still rings exactly those three. Never collapses the stored traces.
  // The folds come from traceIndex() (built once per change, not a scan per call: the views ask
  // this for every point on every draw, and echoOf asks it again - review 2026-09-28).
  function isTraced(key) {
    if (!key) return false;
    if (traced.has(key)) return true;
    if (/^\d{4}-\d{2}$/.test(key)) return traceIndex().mfold.has(key);        // a MONTH: any of its days/windows
    if (/^w:\d{4}-\d{2}-\d{2}$/.test(key)) return traceIndex().dfold.has(key); // a DAY: any of its windows
    if (/^w:\d{4}-\d{2}-\d{2}:/.test(key)) return traced.has(key.slice(0, 12)); // a WINDOW: its whole day
    return false;
  }
  // the traces folded to MONTH keys, for views that ring per month. Folding is for DISPLAY
  // only — the stored traces keep their resolution.
  function tracedMonths() {
    const out = new Set();
    traced.forEach(k => { const mk = monthOf(k); if (mk) out.add(mk); });
    return out;
  }
  function isTracedMonth(mk) { return !!mk && tracedMonths().has(mk); }

  // ---- ECHOES: the same time, another year ---------------------------------------------
  // A trace is anchored in TIME, so it carries across the years as well as across the views
  // (Miguel 2026-09-28: "if the anchor is temporal, then we trace the points across grouping
  // and transformations (views)"). An ECHO is a traced key's calendar position in every OTHER
  // year, at the trace's own resolution:
  //   "2025-05"            echoes "2023-05", "2024-05", "2026-05"
  //   "w:2025-05-12"       echoes "w:2024-05-12", ...        a day: the same date
  //   "w:2025-05-12:dawn"  echoes "w:2024-05-12:dawn", ...   a window: same date, same window
  // and it RESOLVES the way a trace does (isTraced's folds, applied with the year taken out):
  // a traced day makes May 2024 an echo in the month views, as it rings May 2025 there.
  // Echoes are COMPUTED, never stored: the TRACED set, localStorage and the GUI replay (P30)
  // never see one, and untracing the source takes its echoes with it. A key that is itself
  // traced is never an echo. 29 Feb echoes nothing - no other year here has one.
  const yearless = k => (typeof k === "string") ? k.replace(/^(w:)?\d{4}-/, "$1*-") : null;
  const yearOf = k => { const m = /^(?:w:)?(\d{4})-/.exec(k || ""); return m ? +m[1] : null; };
  // THE TRACE INDEX, built once per change of TRACED (or of the echo switch) and read by every
  // predicate: `_echo`, declared with the sets, is dropped by load(), saveTraced() and the switch.
  //   pos / monthPos / dayPos   key -> the position of its FIRST trace (traceColor)
  //   mfold / dfold             the months / days that have a traced day or window (isTraced)
  //   exact / month / day       the traces by YEARLESS form, first trace wins (echoOf) - so an
  //                             echo takes the colour of the earliest trace it answers to
  //   on                        the echo switch, read once rather than from storage per point
  function traceIndex() {
    if (_echo) return _echo;
    const pos = new Map(), monthPos = new Map(), dayPos = new Map(), mfold = new Set(), dfold = new Set();
    const exact = new Map(), month = new Map(), day = new Map();
    let i = -1;
    for (const k of traced) {
      i++;
      if (typeof k !== "string") continue;
      if (!pos.has(k)) pos.set(k, i);
      const mk = monthOf(k); if (mk && !monthPos.has(mk)) monthPos.set(mk, i);
      if (/^w:\d{4}-\d{2}/.test(k)) mfold.add(k.slice(2, 9));
      if (/^w:\d{4}-\d{2}-\d{2}:/.test(k)) { const dk = k.slice(0, 12);
        dfold.add(dk); if (!dayPos.has(dk)) dayPos.set(dk, i); }
      const y = yearless(k); if (!y || y === k) continue;
      if (!exact.has(y)) exact.set(y, k);
      if (y.startsWith("w:")) {
        const ym = y.slice(2, 6);                         // "*-MM": a month, from any of its days
        if (!month.has(ym)) month.set(ym, k);
        if (y[9] === ":") { const yd = y.slice(0, 9);     // "w:*-MM-DD": a day, from any of its windows
          if (!day.has(yd)) day.set(yd, k); }
      }
    }
    return (_echo = { pos, monthPos, dayPos, mfold, dfold, exact, month, day, on: echoPref() });
  }
  // the traced key that `key` echoes (null if none, if `key` is traced itself, or if the echo
  // switch is off - which is therefore the ONE place that switch acts, for every view)
  function echoOf(key) {
    if (!key) return null;
    const ix = traceIndex();
    if (!ix.on || isTraced(key)) return null;
    const y = yearless(key); if (!y || y === key) return null;       // no year in it: nothing to echo
    if (ix.exact.has(y)) return ix.exact.get(y);
    if (/^\*-\d{2}$/.test(y)) return ix.month.get(y) || null;        // a MONTH: any day/window of it
    if (/^w:\*-\d{2}-\d{2}$/.test(y)) return ix.day.get(y) || null;  // a DAY: any of its windows
    if (/^w:\*-\d{2}-\d{2}:/.test(y)) return ix.exact.get(y.slice(0, 9)) || null;   // a WINDOW: its whole day
    return null;
  }
  const isEcho = key => !!echoOf(key);
  // the ring colour of the trace it echoes, so May 2024 wears May 2025's colour
  const echoColor = key => { const s = echoOf(key); return s ? traceColor(s) : null; };
  // `key` moved into another year - how a view finds the traced thing its echo answers to
  function withYear(key, y) {
    return (typeof key === "string" && y != null) ? key.replace(/^(w:)?\d{4}-/, `$1${y}-`) : key;
  }
  // THE HOVER BOXES' ONE LINE ABOUT TRACING, so every view says it the same way: "◎ traced",
  // or "◌ echo · May 2025 is traced" (the dashed ring, explained where you are pointing), or ""
  function traceNote(key) {
    if (!key) return "";
    if (isTraced(key)) return `<div style="color:${traceColor(key) || gold()}">\u25ce traced</div>`;
    const s = echoOf(key);
    return s ? `<div style="color:${traceColor(s) || gold()}">\u25cc echo \u00b7 ${label(s)} is traced</div>` : "";
  }
  // ---- PARTIAL MONTHS (Miguel 2026-09-28: "half-filled dot and text on hover") -----------
  // The bridge sends each month's coverage (month_coverage in bridge.py): hours per time of day,
  // and `partial` when a whole time of day is missing or the month holds under half the usual
  // hours. Every view that draws a month as one mark paints a partial one HALF-FILLED and names
  // why in its hover box, so Sep 2025 (daytime only) no longer looks like any other month.
  function coverage(key) {
    const mk = monthOf(key), cv = window.RW_COVERAGE;
    return (mk && cv && cv[mk]) || null;
  }
  const isPartial = key => { const c = coverage(key); return !!(c && c.partial); };
  function partialNote(key) {
    const c = coverage(key);
    return (c && c.partial) ? `<div class="k" style="color:var(--rw-partial)">\u25d0 partial month \u00b7 ${c.why}</div>` : "";
  }
  // A half-filled paint for an SVG mark: the left half in `col`, the right half empty. One
  // gradient per colour, in one hidden <svg> - url(#id) resolves across the document's inline
  // SVGs, so every view (and the scatter's four facets) shares them.
  const _half = new Map();
  function halfFill(col) {
    if (!col) return col;
    if (_half.has(col)) return _half.get(col);
    let defs = document.getElementById("wc-half-defs");
    if (!defs) {
      const sv = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      sv.setAttribute("width", "0"); sv.setAttribute("height", "0");
      sv.style.position = "absolute"; sv.style.width = "0"; sv.style.height = "0";
      defs = document.createElementNS("http://www.w3.org/2000/svg", "defs"); defs.id = "wc-half-defs";
      sv.appendChild(defs); document.body.appendChild(sv);
    }
    const id = "wc-half-" + _half.size, g = document.createElementNS("http://www.w3.org/2000/svg", "linearGradient");
    g.id = id; g.setAttribute("x1", "0"); g.setAttribute("x2", "1"); g.setAttribute("y1", "0"); g.setAttribute("y2", "0");
    [["0", 1], ["0.5", 1], ["0.5", 0], ["1", 0]].forEach(([o, a]) => {
      const st = document.createElementNS("http://www.w3.org/2000/svg", "stop");
      st.setAttribute("offset", o); st.setAttribute("stop-color", col); st.setAttribute("stop-opacity", a); g.appendChild(st); });
    defs.appendChild(g);
    const url = `url(#${id})`; _half.set(col, url); return url;
  }
  // ---- PROBABLE RECORDER FAULTS (P52, 2026-10-01; findings/14; Miguel, option b) ------------
  // The channel's fault days come in the bridge's init (`faults`; viz/gen_faults.py writes them from the notebook's
  // scan): [{date "YYYY-MM-DD", month, hours, heard, month_flag, note, month_note, month_flag_note}]. Only water has any. A view that
  // draws a day marks a fault day with a small × over its mark (faultX) and names it in its hover box and
  // INFORMATION panel (faultNote); a month that carries one says so (faultMonthNote). The values stay as measured.
  const faults = () => (Array.isArray(window.RW_FAULTS) ? window.RW_FAULTS : []);
  function dateOf(key) {
    const m = /^(?:w:)?(\d{4}-\d{2}-\d{2})/.exec(typeof key === "string" ? key : "");
    return m ? m[1] : null;
  }
  function faultOf(key) { const d = dateOf(key); return d ? (faults().find(f => f.date === d) || null) : null; }
  const isFault = key => !!faultOf(key);
  const faultsIn = key => { const mk = dateOf(key) ? null : monthOf(key); return mk ? faults().filter(f => f.month === mk) : []; };
  const escHTML = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const faultLine = t => `<div class="k wc-fault-note" style="margin-top:3px"><b style="color:var(--rw-fault)">\u00d7</b> ${escHTML(t)}</div>`;
  const faultText = key => { const f = faultOf(key); return f ? f.note : ""; };          // plain text (a title)
  const faultMonthText = key => faultsIn(key).map(f => f.month_note).join(" ");
  const faultNote = key => { const t = faultText(key); return t ? faultLine(t) : ""; };   // the day's line (HTML)
  const faultMonthNote = key => faultsIn(key).map(f => faultLine(f.month_note)).join("");   // the month's (HTML)
  // the same, where the month map's ANOMALY FLAG is drawn (the biplot): why the month is flagged (2026-10-01: a view
  // that draws no flag says only that the month includes a fault day, which raises its values)
  const faultMonthFlagNote = key => faultsIn(key).map(f => faultLine(f.month_flag_note || f.month_note)).join("");
  const faultKeyNote = key => faultNote(key) || faultMonthNote(key);   // a day or a month (the hour views' traceKey)
  // THE MARK: a small × over the point, on the casing the echo rings use, so it reads on any fill. `g` is an svg
  // group translated to the point, `r` the point's radius.
  function faultX(g, r) {
    const h = Math.max(3.5, (r || 0) * 0.85), d = `M${-h},${-h}L${h},${h}M${h},${-h}L${-h},${h}`;
    g.append("path").attr("class", "wc-fault-case").attr("d", d).attr("fill", "none").attr("stroke", "var(--rw-casing)")
      .attr("stroke-width", 3.4).attr("stroke-linecap", "round").attr("stroke-opacity", 0.85);
    g.append("path").attr("class", "wc-fault").attr("d", d).attr("fill", "none").attr("stroke", "var(--rw-fault)")
      .attr("stroke-width", 1.6).attr("stroke-linecap", "round");
    return g;
  }

  // a trace or echo key in words, for the hover boxes: "May 2025", "12 May 2025 · dawn"
  const MON3 = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  function label(key) {
    const m = /^(?:w:)?(\d{4})-(\d{2})(?:-(\d{2}))?(?::(\w+))?/.exec(key || "");
    if (!m) return key || "";
    const mon = MON3[+m[2] - 1] || m[2];
    return (m[3] ? `${+m[3]} ${mon} ${m[1]}` : `${mon} ${m[1]}`) + (m[4] ? ` · ${m[4]}` : "");
  }

  // NAVIGATION DOES NOT TRACE. Pressing or dragging a point moves the sonification to it and
  // changes nothing; tracing is its own gesture (the ◎ button, shift-press on a point, or the
  // brush). Plain press used to trace, which is how a listening session silently accumulated
  // dozens of rings nobody asked for.
  // A RING IS REMOVED WHERE YOU SEE IT. A month in a month view is ringed by the window/day
  // traces inside it (isTraced), so untracing it must remove THOSE - a toggle of the bare month key
  // added a key while the ring stayed, and an eraser over it removed nothing (review 2026-09-27).
  // covering(key) = the stored keys other than `key` that make it ring.
  function covering(key) {
    if (!key) return [];
    if (/^\d{4}-\d{2}$/.test(key)) return [...traced].filter(k => k !== key && monthOf(k) === key);
    if (/^w:\d{4}-\d{2}-\d{2}$/.test(key)) return [...traced].filter(k => typeof k === "string" && k.startsWith(key + ":"));
    if (/^w:\d{4}-\d{2}-\d{2}:/.test(key)) return traced.has(key.slice(0, 12)) ? [key.slice(0, 12)] : [];
    return [];
  }
  function toggleTrace(key) {
    if (!key) return false;
    let changed;
    if (traced.has(key)) { traced.delete(key); changed = [key]; }
    else if ((changed = covering(key)).length) changed.forEach(k => traced.delete(k));   // the ring goes
    else { traced.add(key); changed = [key]; }
    saveTraced(); fireChange();
    guiTell(changed);
    return isTraced(key);
  }
  // A non-toggling ADD. The legend's catalogue needs this shape for SHOWN too: eleven chips
  // resolve to seven months (May 2023 wins three of them), so a toggle would make the second
  // chip for a month undo the first.
  function addTrace(key) {
    if (!key || traced.has(key)) return;
    traced.add(key); saveTraced(); fireChange();
    guiTell([key]);
  }
  // SET-VALUED tracing, for the brush. Deliberately not a loop over toggleTrace(): a stroke
  // that picks up 300 points would then write localStorage 300 times and redraw every view 300
  // times. One mutation, one save, one redraw.
  // mode: "add" (default) | "remove"
  function setTraced(keys, mode) {
    const list = (keys || []).filter(Boolean);
    if (!list.length) return 0;
    // the points this stroke actually CHANGES - the only ones the GUI may be told about. An eraser
    // over a ring that another resolution's traces make (a month ringed by its windows) removes those.
    const want = mode === "remove"
      ? [...new Set(list.flatMap(k => traced.has(k) ? [k] : covering(k)))] : [...new Set(list)];
    const changed = want.filter(k => (mode === "remove") === traced.has(k));
    if (!changed.length) return 0;
    if (mode === "remove") changed.forEach(k => traced.delete(k));
    else changed.forEach(k => traced.add(k));
    saveTraced(); fireChange();
    guiReplay(changed);
    return changed.length;
  }
  // THE GUI'S TRACKED SET FOLLOWS A TRACE ONLY WHERE A POINT CAN BE NAMED TO IT (TASKS P30,
  // manual B2.21 §9.4 "standalone-first"). press("track") toggles the GUI's CURRENT point, so
  // the single press a sweep used to fire toggled a point the stroke may never have touched -
  // and fired on an eraser stroke too. A view that can map a key to the GUI's index
  // (opts.idxOf: the biplot's months, L0 rows) now names each point that CHANGED - select_idx,
  // then press - the nova/pulsar way; presses toggle, so only changed points are pressed. A view
  // that cannot map (every window view) sends a sweep nothing; its single traces (◎, shift-press)
  // keep the one press on the GUI's current point, which a GUI-driven session is standing on.
  //
  // ONE QUEUE, ONE PAIR AT A TIME (review 2026-09-27). The GUI's track has a ~10-frame cooldown
  // (~170-220 ms on its 45-60 fps frame thread) and silently drops a press inside it, so pairs go
  // out REPLAY_MS apart; a single FIFO means back-to-back strokes, a clear or a lone ◎ press can
  // never interleave with a replay and press the wrong point; each index is resolved when it is
  // QUEUED (a resolution change mid-replay cannot lose it); and each run starts with level_set 0,
  // because the indices are L0 rows and the GUI may be drilled into L1.
  const REPLAY_MS = 300;
  let _gq = [], _gBusy = false, _gRun = false;   // queue, a pair in flight, a run under way
  function guiTell(keys) {
    if (!guiConnected() || !keys || !keys.length) return;
    if (!opts.idxOf) { _gq.push({ press: true }); }                         // a single trace: press only
    else keys.forEach(k => { const idx = opts.idxOf(k);
      if (idx != null && idx >= 0) _gq.push({ idx }); });
    _gPump();
  }
  function guiReplay(keys) { if (opts.idxOf) guiTell(keys); }               // a sweep: named points only
  function _gPump() {
    if (_gBusy || !_gq.length) return;
    if (!guiConnected()) { _gq = []; _gRun = false; return; }               // never half-apply
    _gBusy = true;
    const job = _gq.shift();
    if (job.idx != null) {
      if (!_gRun) { DarkWebControl.set("level_set", 0); _gRun = true; }
      DarkWebControl.set("select_idx", job.idx);
    }
    setTimeout(() => { if (guiConnected()) DarkWebControl.press("track"); }, job.idx != null ? 35 : 0);
    setTimeout(() => { _gBusy = false; if (!_gq.length) _gRun = false; _gPump(); }, REPLAY_MS);
  }
  // a clear is a change too: the months it removes are replayed, or the GUI keeps tracking them
  // and the next brush over the same months toggles them OFF there (review 2026-09-27)
  function clearTraces() { if (!traced.size) return; const was = [...traced];
    traced.clear(); saveTraced(); fireChange(); guiReplay(was); }

  function fireChange() { updateSelBtn(); if (opts.onChange) opts.onChange(); }
  function updateSelBtn() {
    if (clearBtn) clearBtn.textContent = `◈ clear traces · ${traced.size}`;
  }

  // colour a TRACED key by its position in the traced set (null if not traced). Used for the
  // ring, so several traces are told apart rather than all being one gold.
  function traceColor(key) {
    if (!key) return null;
    const ix = traceIndex();
    let i = ix.pos.has(key) ? ix.pos.get(key) : -1;
    // `key` may be a MONTH ("2023-03") while the set holds a day-window of it
    // ("w:2023-03-23:day") — match on the window's month so colours stay stable.
    if (i < 0 && ix.monthPos.has(key)) i = ix.monthPos.get(key);
    // a DAY ("w:YYYY-MM-DD") takes the colour of its first traced window, as a month does
    if (i < 0 && /^w:\d{4}-\d{2}-\d{2}$/.test(key) && ix.dayPos.has(key)) i = ix.dayPos.get(key);
    // a WINDOW of a traced whole DAY takes the day's colour - it rings through the day
    // (isTraced), and its echoes wear the day's colour, so the two must match (review 2026-09-28)
    if (i < 0 && /^w:\d{4}-\d{2}-\d{2}:/.test(key) && ix.pos.has(key.slice(0, 12))) i = ix.pos.get(key.slice(0, 12));
    return i < 0 ? null : PALETTE[i % PALETTE.length];
  }
  // colour a SHOWN month by its position in the filter (null if the filter is empty or does
  // not hold it). This is linear's day-for-day overlay: one colour per month you are looking
  // at. Separate from traceColor on purpose — they answer different questions now.
  function shownColor(mk) {
    if (!shown.size || !mk) return null;
    const i = [...shown].sort().indexOf(mk);
    return i < 0 ? null : PALETTE[i % PALETTE.length];
  }

  // ---- GUI (dual-mode) helpers: no-op when the GUI web controller is absent ----
  function guiConnected() {
    return window.DarkWebControl && DarkWebControl.connected && DarkWebControl.connected();
  }
  function updateStatBtn() {
    const cur = statPref();
    document.querySelectorAll("#wc-stat .wbtn").forEach(b =>
      b.classList.toggle("on", b.getAttribute("data-stat") === cur));
  }
  function updateBrushBtn() {
    const on = brushPref();
    const b = document.querySelector("#wc-brush");
    if (b) { b.classList.toggle("on", on); b.textContent = `\u25eb brush to trace \u00b7 ${on ? "on" : "off"}`; }
    document.body.classList.toggle("brushing", on);
  }
  // alt arms the brush (and the roses' trace-drag) for as long as it is held, so the cursor
  // says so for as long as it is held: body.brush-alt, beside body.brushing. A blur drops it -
  // the keyup of an alt released in another window never arrives.
  // The pointer events carry the same e.altKey that RWBrush.armed() reads, so they correct the
  // class too: an alt pressed or released while another window had focus (no keydown/keyup here)
  // is set right on the next move (review 2026-09-28).
  (function altCue() {
    const set = on => { const b = document.body; if (b && b.classList.contains("brush-alt") !== on) b.classList.toggle("brush-alt", on); };
    window.addEventListener("keydown", e => { if (e.key === "Alt") set(true); }, true);
    window.addEventListener("keyup", e => { if (e.key === "Alt") set(false); }, true);
    window.addEventListener("pointermove", e => set(!!e.altKey), true);
    window.addEventListener("pointerdown", e => set(!!e.altKey), true);
    window.addEventListener("blur", () => set(false));
  })();
  function updateEchoBtn() {
    const on = echoPref(), b = document.querySelector("#wc-echo");
    if (b) { b.classList.toggle("on", on); b.textContent = `\u25cc echo in other years \u00b7 ${on ? "on" : "off"}`; }
  }
  // THE ARMED BRUSH MUST BE VISIBLE WHERE YOU ARE LOOKING (Miguel 2026-09-28). The switch lives
  // in the TRACE tab and it persists, so with the VIEW tab open nothing said it was on: the
  // plot kept its crosshair, a press traced instead of playing, shift-press untraced, and it
  // read as "hover and tracing are broken". Two cues now, both driven by body.brushing: the
  // brush cursor on every plot (brush.js / rose.html, --rw-brush-cursor below), and this chip
  // beside the header's connection chip, which is also the way out - one click disarms.
  // Only on a page that has something to brush (spectro/mfcc pass brush:false).
  function mountBrushChip() {
    if (opts.brush === false || document.getElementById("wc-brushchip")) return;
    const host = document.getElementById("chip");
    if (!host || !host.parentNode) return;
    const c = document.createElement("button");
    c.id = "wc-brushchip"; c.className = "wc-brushchip"; c.type = "button";
    c.textContent = "\u25eb brush on \u00b7 drag traces \u00b7 \u2715";
    c.title = "The brush is on: press-drag over points TRACES them instead of playing them "
      + "(hold shift to untrace). Click to turn it off - the same switch as \u25eb in the trace tab.";
    c.onclick = () => {
      try { localStorage.setItem(LS_BRUSH, "0"); } catch (e) {}
      updateBrushBtn();
      if (opts.onBrushMode) opts.onBrushMode(false);
    };
    host.parentNode.insertBefore(c, host.nextSibling);
  }
  // written to the tab strip's line (panel.js, #side-gui - always visible, P31); statusEl is the
  // fallback for a page laid out without panel.js
  function setStatus() {
    const el = document.getElementById("side-gui") || statusEl;
    if (!el) return;
    const s = (window.DarkWebControl && DarkWebControl.status) ? DarkWebControl.status() : "off";
    el.textContent = s === "connected" ? "gui · connected" : "gui · standalone";
    el.style.color = s === "connected" ? "var(--rw-ok)" : "var(--dim)";
  }

  const CSS = `
  .wc-seglabel{ color:var(--dim); font-size:11px; letter-spacing:.1em; margin:8px 0 6px; }
  .wcgrid{ display:grid; grid-template-columns:1fr 1fr; gap:5px; }
  .wcgrid3{ grid-template-columns:1fr 1fr 1fr; }
  .wbtn{ padding:5px 6px; border:1px solid var(--line); border-radius:7px; background:var(--panel);
    color:var(--dim); cursor:pointer; font:inherit; font-size:11px; text-align:center; }
  .wbtn:hover{ border-color:var(--rw-ctl-line-hi); color:var(--txt); }
  .wbtn.on{ color:var(--rw-gold); border-color:var(--rw-gold-line); }
  .wbtn.on2{ color:var(--rw-t0); border-color:var(--rw-on2-line); }
  .wvol{ width:100%; height:22px; accent-color:var(--rw-gold); background:transparent; cursor:pointer; align-self:center; }
  .wc-fader{ display:grid; grid-template-columns:44px 1fr 34px; gap:6px; align-items:center; margin:4px 0; }
  .wc-fname{ color:var(--dim); font-size:11px; }
  .wc-fval{ color:var(--dim); font-size:10px; text-align:right; }
  .wc-fader.na .wc-fname, .wc-fader.na .wc-fval{ opacity:.45; text-decoration:line-through; }
  .wc-hint{ font-size:10px; color:var(--dim); margin-top:5px; line-height:1.4; }
  /* the armed brush, where you are looking: a chip in the header and a brush-tip cursor
     (a gold ring with a centre dot) that brush.js and rose.html paint on their plots */
  /* --rw-brush-cursor: per look, in rewild_tokens.css */
  .wc-brushchip{ display:none; font:inherit; font-size:11px; padding:3px 9px; border-radius:11px;
    border:1px solid var(--rw-gold-line); background:var(--rw-gold-wash); color:var(--rw-gold); cursor:pointer; margin-left:8px; }
  body.brushing .wc-brushchip{ display:inline-flex; align-items:center; }
  .wc-brushchip:hover{ border-color:var(--rw-gold); }`;

  function updateChannelBtn() {
    const cur = opts.channel && opts.channel();
    document.querySelectorAll("#wc-chan .wbtn").forEach(b =>
      b.classList.toggle("on", b.getAttribute("data-ch") === cur));
    updateLayerAvail();
  }
  // ON WATER the arp and the corpus are silent: they are BirdNET, which ran on the air recorder
  // only (the tables are per channel since 2026-09-26). The faders stay settable - the mix is
  // the listener's and comes back on air - but say so. air+water plays air's tables.
  function updateLayerAvail() {
    const noBird = (opts.channel && opts.channel()) === "water";
    document.querySelectorAll("#wc-mix .wc-fader").forEach(f => {
      const inp = f.querySelector("input"); if (!inp) return;
      const k = inp.getAttribute("data-layer"), off = noBird && (k === "arp" || k === "corpus");
      const def = (LAYER_FADERS.find(x => x[0] === k) || [])[2] || "";
      f.classList.toggle("na", off);
      f.title = off ? `${k} is silent on water: BirdNET ran on the air recorder only` : def;
    });
  }
  function updateSoundBtn() {
    const cur = (opts.sound && opts.sound()) || soundPref();
    document.querySelectorAll("#wc-snd .wbtn").forEach(b =>
      b.classList.toggle("on", b.getAttribute("data-snd") === cur));
  }
  function updateLoopBtn() {
    const on = loopPref(), b = document.getElementById("wc-loop");
    if (b) { b.textContent = on ? "↻ loop · on" : "↻ loop · off (space)"; b.classList.toggle("on", on); }
  }
  // the MASTER controls from `master` (applyMaster sets it from the bridge's echo; a gesture sets it first)
  function paintMaster() {
    const b = document.getElementById("wc-mute"), v = document.getElementById("wc-vol");
    if (b) { b.textContent = master.mute ? "◼ muted" : "◼ mute"; b.classList.toggle("on2", master.mute); }
    if (v) v.value = master.vol;
  }

  function buildPanel(container) {
    const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
    const chans = ((opts.channels && opts.channels()) || []).filter(c => c !== "air+water");   // air+water hidden for now (code kept)
    const chanHtml = chans.length > 1     // air ↔ water switch (only if both exist)
      ? `<div class="wc-seglabel">CHANNEL</div><div class="wcgrid" id="wc-chan">`
        + chans.map(c => `<button class="wbtn" data-ch="${c}">${c}</button>`).join("") + `</div>`
      : "";
    // SOUND is a MIXER, not a strategy. synth / corpus / both made sense when the corpus was
    // an ALTERNATIVE to the synth; it is layer 4 now, always present, so the control is one
    // fader per layer. Defaults are level-dependent: at L0 a row is a month, whose species
    // list is a top-20 over thirty days, so the inference and evidence layers start silent
    // and the months give you the acoustic character alone.
    const sndHtml = `<div class="wc-seglabel">SOUND · LAYERS</div><div id="wc-mix">`
      + LAYER_FADERS.map(([k, lbl, tip]) =>
          `<div class="wc-fader" title="${tip}"><span class="wc-fname">${lbl}</span>`
        + `<input class="wvol" type="range" min="0" max="1" step="0.02" data-layer="${k}">`
        + `<span class="wc-fval" data-for="${k}">1.00</span></div>`).join("") + `</div>`;
    // WHICH READING OF THE DATA THE BODY IS UNDER. gradient and variance run over the same
    // rows and differ only in theta, pressure and the 35 mode gains (the identity is
    // byte-identical), so switching is a table swap and a re-voice - no retune. What they
    // are NOT is two versions of the same thing: they encode different properties of a
    // month, so the button labels are the real names, not nicknames (Miguel 2026-09-24).
    const statHtml = `<div class="wc-seglabel">SOUND \u00b7 DRONE READING</div><div class="wcgrid" id="wc-stat">`
      + `<button class="wbtn" data-stat="gradient" title="gradient \u2014 how fast this month is changing. A window's place on the body is how far it sits from the one before it in time. The default.">gradient</button>`
      + `<button class="wbtn" data-stat="variance" title="variance \u2014 how internally varied it is. A window's place on the body is its own spread, not its distance from its neighbour.">variance</button></div>`;
    const loopHtml = "";
    // MASTER: live playback volume + mute (SC /rw_master). Not persisted by the page: the bridge owns it
    // and echoes it, and the slider and button paint that echo (applyMaster).
    const masterHtml = `<div class="wc-seglabel">MASTER</div><div class="wcgrid" id="wc-master">`
      + `<button class="wbtn" id="wc-mute" style="grid-column:1/-1">◼ mute</button>`
      + `<input class="wvol" id="wc-vol" type="range" min="0" max="1" step="0.02" value="0.8" title="volume" style="grid-column:1/-1">` + `</div>`;
    // TRACE. Not "selection": choosing what to SEE is the month grid's job, over in VIEW, and
    // it is a different act. A trace rings one point and hides nothing.
    container.innerHTML = chanHtml + sndHtml + statHtml + loopHtml + masterHtml +
      `<div class="wc-seglabel">TRACE</div>
       <div class="wcgrid">
         <button class="wbtn" id="wc-trace" style="grid-column:1/-1" title="ring the point the sound is on, so you can keep an eye on it. Hides nothing.">◎ trace this point</button>
         <button class="wbtn" id="wc-brush" style="grid-column:1/-1" title="paint over the points to trace every one the stroke touches (hold shift to untrace; with this off, alt arms the brush and alt+shift untraces)">◫ brush to trace · off</button>
         <button class="wbtn" id="wc-echo" style="grid-column:1/-1" title="a dashed ring on the same time as each trace in every other year - trace May 2025 and May 2023, 2024 and 2026 are marked too. The same month, date or window, at the trace's own resolution. Draws only; nothing is added to your traces.">◌ echo in other years · on</button>
         <button class="wbtn" id="wc-clear" style="grid-column:1/-1">◈ clear traces · 0</button>
       </div>
       <div class="wc-hint">${opts.brush === false
           ? `hover a cell to <b>hear</b> its hour's window \u00b7 ◎ <b>traces</b> what is on screen \u2014 the month, or the day<br>`
           : `press or drag a point to <b>hear</b> it \u00b7 shift-press or ◎ to <b>trace</b> one \u00b7
         <b>◫</b> (or hold <b>alt</b>) to brush over many<br>`}
         a trace is a ring you carry into every view. It <b>hides nothing</b> \u2014 what you
         see is the month grid's business, under VIEW. A <b>dashed</b> ring is its <b>echo</b>:
         the same time, another year.</div>`;
    statusEl = container.querySelector("#wc-state");
    clearBtn = container.querySelector("#wc-clear");
    clearBtn.onclick = () => clearTraces();
    const traceBtn = container.querySelector("#wc-trace");
    if (traceBtn) traceBtn.onclick = () => toggleTrace(opts.current && opts.current());
    const echoBtn = container.querySelector("#wc-echo");
    if (echoBtn) echoBtn.onclick = () => {
      try { localStorage.setItem(LS_ECHO, echoPref() ? "0" : "1"); } catch (e) {}
      _echo = null;                                  // the index caches the switch
      updateEchoBtn(); fireChange();                 // every ring is redrawn by the page's onChange
    };
    const brushBtn = container.querySelector("#wc-brush");
    // a view with nothing to brush (spectro, mfcc: one month, cells not points) says so
    // rather than offering a button that does nothing
    if (brushBtn && opts.brush === false) brushBtn.style.display = "none";
    if (brushBtn) brushBtn.onclick = () => {
      const on = !brushPref();
      try { localStorage.setItem(LS_BRUSH, on ? "1" : "0"); } catch (e) {}
      updateBrushBtn();
      if (opts.onBrushMode) opts.onBrushMode(on);
    };
    container.querySelectorAll("#wc-stat .wbtn").forEach(b =>
      b.onclick = () => { const st = b.getAttribute("data-stat");
        try { localStorage.setItem(LS_STAT, st); } catch (e) {}      // persist across views
        updateStatBtn();
        if (opts.onStat) opts.onStat(st); });
    container.querySelectorAll("#wc-chan .wbtn").forEach(b =>
      b.onclick = () => { const ch = b.getAttribute("data-ch");
        try { localStorage.setItem(LS_CHAN, ch); } catch (e) {}      // persist across views
        if (opts.onChannel) opts.onChannel(ch); });
    // the faders
    container.querySelectorAll('#wc-mix input[type=range]').forEach((el, i) => {
      el.value = mix[i];
      const out = container.querySelector(`.wc-fval[data-for="${el.getAttribute("data-layer")}"]`);
      if (out) out.textContent = (+mix[i]).toFixed(2);
      el.oninput = () => {
        mix[i] = +el.value;
        if (out) out.textContent = (+el.value).toFixed(2);
        if (opts.onMix) opts.onMix({ drone: mix[0], clave: mix[1], arp: mix[2], corpus: mix[3] });
      };
    });
    container.querySelectorAll("#wc-snd .wbtn").forEach(b =>
      b.onclick = () => { const sd = b.getAttribute("data-snd");
        try { localStorage.setItem(LS_SND, sd); } catch (e) {}       // persist across views
        if (opts.onSound) opts.onSound(sd);
        updateSoundBtn(); });
    // MASTER volume + mute -> opts.onMaster({vol}|{mute}); the bridge's echo then paints what SC does
    const muteBtn = container.querySelector("#wc-mute"), volEl = container.querySelector("#wc-vol");
    if (muteBtn) muteBtn.onclick = () => { master.mute = !master.mute; paintMaster();
      if (opts.onMaster) opts.onMaster({ mute: master.mute ? 1 : 0 }); };
    if (volEl) volEl.oninput = () => { master.vol = +volEl.value;
      if (opts.onMaster) opts.onMaster({ vol: +volEl.value }); };
    paintMaster();                                  // an echo that arrived before the panel was built
    const loopBtn = container.querySelector("#wc-loop");
    if (loopBtn) loopBtn.onclick = () => { const on = !loopPref();
      try { localStorage.setItem(LS_LOOP, on ? "1" : "0"); } catch (e) {}
      if (opts.onLoop) opts.onLoop(on ? 1 : 0);
      updateLoopBtn(); };
    mountBrushChip();
    updateSelBtn(); updateChannelBtn(); updateSoundBtn(); updateLoopBtn(); updateStatBtn(); updateBrushBtn(); updateEchoBtn();
  }
  function backToL0() {
    if (guiConnected()) DarkWebControl.set("level_set", 0);
    location.href = "biplot.html";
  }

  function step(dir) {
    const months = (opts.months && opts.months()) || [];
    const cur = opts.current && opts.current();
    let i = months.indexOf(cur);
    i = Math.max(0, Math.min(months.length - 1, (i < 0 ? 0 : i) + dir));
    const key = months[i];
    if (key && opts.select) opts.select(key);
    const idx = opts.idxOf ? opts.idxOf(key) : null;           // null = not a GUI index: say nothing
    if (guiConnected() && idx != null) DarkWebControl.set("select_idx", idx);
    updateSelBtn();
  }
  function drill(key) {
    if (!key) return;
    if (guiConnected()) { DarkWebControl.set("level_set", 1);
      const idx = opts.idxOf ? opts.idxOf(key) : null; if (idx != null) DarkWebControl.set("select_idx", idx); }
    location.href = `linear.html?m=${key}`;
  }

  return {
    init(o) {
      opts = o || {};
      load();
      if (o.container) buildPanel(o.container);
      // sync across pages/tabs — either set
      window.addEventListener("storage", e => {
        if (e.key === LS_TRACED || e.key === LS_SHOWN) { load(); fireChange(); }
        // the brush switch is shared too: arm it in one tab and every tab shows it armed
        if (e.key === LS_BRUSH) { updateBrushBtn(); if (opts.onBrushMode) opts.onBrushMode(brushPref()); }
        if (e.key === LS_ECHO) { _echo = null; updateEchoBtn(); fireChange(); }
      });
      if (window.DarkWebControl && DarkWebControl.onstatus) DarkWebControl.onstatus(setStatus);
      setStatus();
      if (opts.onChange) opts.onChange();   // re-render now that both sets are loaded
    },
    // the page calls this on init.web_control and on {type:"web_control"} messages
    handleWebControl(info) {
      if (info && info.web_ws && window.DarkWebControl) DarkWebControl.configure(info.web_ws);
      setStatus();
    },

    // ---- SHOWN: which months are VISIBLE. Opacity/inclusion only, never a ring. ----------
    isShown,                                 // per-datum predicate; any key shape; true when the filter is empty
    isShownMonth,                            // same, for a bare "YYYY-MM"
    shownMonths() { return shown; },         // the raw filter (Set of "YYYY-MM"); EMPTY = all months
    shownCount() { return shown.size; },
    showingAll() { return shown.size === 0; },
    toggleShown,                             // month grid: click a month on/off -> bool (is it now shown)
    setShown,                                // set-valued: (keys, "add"|"remove"|"set") -> n changed
    showAll,                                 // the "all" button: drop the filter
    shownColor,                              // per-shown-month colour for an overlay (linear)

    // ---- TRACED: the annotation. Ring + aura only, never changes anyone's opacity. -------
    isTraced,                                // exact, or a month whose windows are traced
    isTracedMonth,                           // the traces folded to months, as a predicate
    traced() { return traced; },             // raw traces: month keys and/or "w:YYYY-MM-DD:win"
    tracedMonths,                            // the traces folded to MONTH keys (display only)
    traceCount() { return traced.size; },
    addTrace,                                // add without toggling (the legend catalogue)
    toggleTrace,                             // THE tracing gesture (◎, shift-press) -> bool
    setTraced,                               // set-valued, one redraw (the brush)
    clearTraces,                             // the "clear traces · N" button
    traceColor,                              // per-trace ring colour (null when not traced)
    // ---- ECHOES: the same time in another year (computed from TRACED, never stored) --------
    isEcho,                                  // key -> bool; never true for a traced key, false while switched off
    echoPref,                                // bool — the trace tab's ◌ echo switch (default on)
    echoOf,                                  // key -> the traced key it echoes (or null)
    echoColor,                               // key -> that trace's ring colour (or null)
    isEchoMonth: mk => /^\d{4}-\d{2}$/.test(mk || "") && isEcho(mk),   // month views
    withYear,                                // (key, year) -> the same key in that year
    yearOf,                                  // key -> its year (or null)
    label,                                   // key -> "May 2025" / "12 May 2025 · dawn"
    traceNote,                               // key -> the hover box's "◎ traced" / "◌ echo" line (HTML)
    // ---- PARTIAL MONTHS (coverage from the bridge's init) ----------------------------------
    coverage,                                // key -> {h, w:{dawn..}, missing, thin, partial, why} or null
    isPartial,                               // key -> bool: a time of day missing, or under half the usual hours
    partialNote,                             // key -> the hover box's "◐ partial month · ..." line (HTML)
    halfFill,                                // colour -> url(#gradient): the left half filled, the right empty
    // ---- PROBABLE RECORDER FAULTS (P52; the init's `faults`) ----------------------------------
    isFault, faultOf,                        // key (a day, "w:" day or window) -> bool / its entry
    faultNote, faultMonthNote, faultKeyNote, // key -> the hover box / INFORMATION line (HTML), day / month / either
    faultMonthFlagNote,                      // key -> the month's line where the map's anomaly flag is drawn (the biplot)
    faultText, faultMonthText,               // the same, plain text (a title)
    faultX,                                  // (svg group at the point, its radius) -> the × mark
    PALETTE,

    // level-dependent defaults, applied when the RESOLUTION changes (month <-> day)
    // Paint the faders from a mix the SERVER handed us. No onMix: this is the bridge telling
    // us where the mix already is, and echoing it back would be a feedback loop. The bridge
    // owns RW_MIX and pushes it whenever anything moves it - a level change applying its
    // defaults, the legacy soundmode preset - so the sliders stop being a guess.
    applyMix(p) {
      if (!p) return;
      const next = [p.drone, p.clave, p.arp, p.corpus];
      next.forEach((v, i) => { if (typeof v === "number") mix[i] = Math.max(0, Math.min(1, v)); });
      const host = document.querySelector("#wc-mix");
      if (host) host.querySelectorAll("input[type=range]").forEach((el, i) => {
        el.value = mix[i];
        const out = host.querySelector(`.wc-fval[data-for="${el.getAttribute("data-layer")}"]`);
        if (out) out.textContent = (+mix[i]).toFixed(2);
      });
    },
    // Paint MASTER from what the SERVER says ({type:"master", vol, mute}), as applyMix paints the
    // faders, and for the same reason: no onMaster, or the echo would bounce back as a gesture. The
    // volume and the mute are what SC plays (rw_core SOUND["master"]): a volume move un-mutes, and an
    // un-mute comes back at the volume you had before muting (P51: the bridge sends that volume, which
    // un-mutes SC by itself).
    applyMaster(p) {
      if (!p) return;
      if (typeof p.vol === "number") master.vol = Math.max(0, Math.min(1, p.vol));
      if (p.mute != null) master.mute = !!+p.mute;
      paintMaster();
    },
    // A RESOLUTION CHANGE NO LONGER TOUCHES THE MIX (P26, 2026-09-27). This used to paint the
    // level's defaults AND send them as a {type:"mix"} - the same message a listener's fader
    // move sends - so every month <-> day switch overwrote faders the listener had set, and
    // the bridge then took the defaults for the listener's own choice. The bridge owns the
    // level defaults: it applies them when a point of the new level sounds, ONLY while the
    // listener has not touched a fader (RW_MIX_USER), re-sends the listener's mix otherwise,
    // and pushes the result to every tab ({type:"mix"} -> applyMix). So the faders render
    // what the engine is doing, and change when it does. Kept as a no-op so callers need no
    // change; MIX_DEFAULTS stays as the documented page-side copy of the bridge's table.
    setLevelDefaults(res) { /* intentionally empty - see above */ },
    mix() { return { drone: mix[0], clave: mix[1], arp: mix[2], corpus: mix[3] }; },
    channelPref,                             // "air"|"water" persisted choice (read before init)
    soundPref,                               // "synth"|"corpus"|"both" persisted choice (read before init)
    loopPref,                                // bool — loop the event layers or one-shot (read before init)
    statPref,                                // "gradient"|"variance" — which reading the drone is under (default gradient)
    brushPref,                               // bool — is stroke-to-trace armed (the ◫ toggle)
    refreshStatus: setStatus,                // re-write the GUI state line (panel.js after a relayout)
    setBrushMode(on) { try { localStorage.setItem(LS_BRUSH, on ? "1" : "0"); } catch (e) {} updateBrushBtn(); },
    monthOf,                                 // key -> "YYYY-MM" (or null); the fold every view needs
    refresh() { updateSelBtn(); updateChannelBtn(); updateSoundBtn(); updateLoopBtn(); updateStatBtn(); updateBrushBtn(); updateEchoBtn(); },   // page calls after changing "current"
    get GOLD() { return gold(); },          // the look's trace gold (brush.js, diel.js, the views)
    step, drill, backToL0,
  };
})();
