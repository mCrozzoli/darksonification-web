/* diel.js — the four diel windows on the hour-of-day views (spectro, mfcc), and their hover box.
 *
 * WHAT THE SOUND DOES ON THESE VIEWS. A cell's HOUR names a diel window, and the window is
 * all the sound hears: hovering voices the L0 point (this month × dawn|day|dusk|night), so a
 * month has exactly FOUR sounds here. The vertical axis — frequency band, MFCC coefficient —
 * changes nothing you hear. The strip this module draws above the plot is that fact made
 * visible: one colour per window, a line where the sound changes, and the sun events it was
 * cut from. It used to be two faint dashed lines at the sun events, which sit in the MIDDLE
 * of the dawn and dusk windows, not at an edge the sound ever changes on.
 *
 * THE CLOCK IS UTC. The recorder writes UTC file hours and the server's sunrise_hour /
 * sunset_hour are UTC (June sunrise 3.81). The bridge ships the data's own sun per month
 * (load_month_sun: mean + the month's range); the NOAA fallback below is UTC as well. Adding
 * BST here put every edge an hour late from April to October (measured 2026-09-26 on the
 * dawn chorus: −0.88 h vs UTC sunrise in BST months, −0.93 h in GMT months).
 *
 * THE RULE is the acoustic pipeline's ecological_window: dawn and dusk are ±1.5 h around the
 * sun events, day is between them, the rest is night. NOT ±1 h, which this file assumed until
 * 2026-09-26; fetch_weather.py::diel_of uses the same ±1.5 h UTC rule, on the L1 day's own sun,
 * since 2026-09-27 (TASKS P19). On the only two fully recorded days
 * (water 2023-10-22/23) the L1 minutes are dawn 180 · day 440/435 · dusk 180 · night 640/645
 * — exactly ±1.5 (439/436, 641/644), where ±1 predicts 120 · 499 · 120 · 701; and ±1.5 is
 * consistent with every day's L1 n_minutes on 736/736 air and 734/734 water days, ±1 on 68.
 * The ±1 strip disagreed with the window actually voiced on ~8% of hours. A CELL is a whole
 * hour, so it is filed by its CENTRE — every window is at least 3 h wide, so the centre's
 * window holds the majority of the hour's minutes.
 *
 * Colours are linear.html's PHASE_COLOR, so a window reads the same in every view.
 */
window.DIEL = (function(){
  const ORDER = ["dawn", "day", "dusk", "night"];
  const COLOR = RWLook.phase;                        // per look (looks.js), refilled in place
  const HALF  = 1.5;                                 // dawn/dusk half-width around the sun event, hours
  const KNEPP = [50.93, -0.37];                      // lat, lon (deg E)

  // NOAA solar geometry for the 15th, in UTC — only when the bridge sent no sun (no L1 CSV).
  function noaa(year, month){
    const doy = (Date.UTC(year, month-1, 15) - Date.UTC(year, 0, 1)) / 86400000 + 1;
    const g = 2*Math.PI/365*(doy-0.5);
    const eq = 229.18*(0.000075+0.001868*Math.cos(g)-0.032077*Math.sin(g)
                      -0.014615*Math.cos(2*g)-0.040849*Math.sin(2*g));
    const dec = 0.006918-0.399912*Math.cos(g)+0.070257*Math.sin(g)-0.006758*Math.cos(2*g)
               +0.000907*Math.sin(2*g)-0.002697*Math.cos(3*g)+0.00148*Math.sin(3*g);
    const lat = KNEPP[0]*Math.PI/180;
    const c = Math.cos(90.833*Math.PI/180)/(Math.cos(lat)*Math.cos(dec)) - Math.tan(lat)*Math.tan(dec);
    if (c < -1 || c > 1) return null;
    const ha = Math.acos(c)*180/Math.PI, noon = 720 - 4*KNEPP[1] - eq;
    const sr = (noon-4*ha)/60, ss = (noon+4*ha)/60;
    return { sr, ss, sr_lo:sr, sr_hi:sr, ss_lo:ss, ss_hi:ss, est:true };
  }
  function sunOf(entry){
    if (!entry) return null;
    return entry.sun || noaa(entry.year, entry.month);
  }
  function winAt(t, sun){                            // t = fractional UTC hour
    if (!sun) return null;
    if (t >= sun.sr-HALF && t < sun.sr+HALF) return "dawn";
    if (t >= sun.ss-HALF && t < sun.ss+HALF) return "dusk";
    if (t >= sun.sr+HALF && t < sun.ss-HALF) return "day";
    return "night";
  }
  const at = (h, sun) => winAt(h + 0.5, sun);        // a whole-hour CELL, by its centre

  const pad = n => String(n).padStart(2, "0");
  function fmt(t){                                   // 3.803 -> "03:48"
    let m = Math.round((((t % 24) + 24) % 24) * 60);
    if (m >= 1440) m -= 1440;
    return pad(Math.floor(m/60)) + ":" + pad(m % 60);
  }
  const hourSpan = h => `${pad(h)}:00–${pad((h+1)%24)}:00 UTC`;

  // contiguous runs of one window over the plotted hours: [{win, h0, h1}] with h1 exclusive
  function runs(hours, sun){
    const out = [];
    hours.forEach(h => {
      const w = at(h, sun), last = out[out.length-1];
      if (last && last.win === w && last.h1 === h) last.h1 = h + 1;
      else out.push({ win:w, h0:h, h1:h+1 });
    });
    return out;
  }

  // The traces that touch what is on screen, folded for the strip. `key` is a MONTH
  // ("YYYY-MM": the whole month, or which of its windows are traced, a traced day counting
  // once for every window) or a DAY ("w:YYYY-MM-DD": the whole day, or which of its windows).
  // `whole` is true when the thing on screen is traced as a whole.
  function traceSummary(key){
    return summaryOf(key) || echoSummary(key);
  }
  // ECHO (wc.js ECHOES): nothing on screen is traced, but the same month or date is, in another
  // year. The strip then shows THAT trace's windows - same shape, marked as an echo (a hollow
  // dashed bar, "◌ echo" in the key) - so the time of day you traced in May 2025 is findable
  // on May 2024's hours. `src` is the trace answered to, `at` its key in the trace's own year.
  function echoSummary(key){
    const W = window.WC; if (!W || !W.echoOf || !W.withYear || !key) return null;
    const src = W.echoOf(key); if (!src) return null;
    const at = W.withYear(key, W.yearOf(src)), ts = summaryOf(at);
    return ts ? Object.assign(ts, { echo: true, src, at,
                                    color: (W.traceColor && W.traceColor(src)) || ts.color }) : null;
  }
  function summaryOf(key){
    const W = window.WC; if (!W || !W.traced || !key) return null;
    const isDay = key.startsWith("w:");
    const wins = { dawn:0, day:0, dusk:0, night:0 }; let whole = false, n = 0;
    W.traced().forEach(k => {
      if (typeof k !== "string") return;
      if (k === key) { whole = true; return; }
      if (isDay) {
        if (!k.startsWith(key + ":")) return;
      } else if (!k.startsWith("w:" + key + "-")) return;
      const w = k.split(":")[2]; n++;
      if (w && w in wins) wins[w]++; else ORDER.forEach(o => wins[o]++);
    });
    if (!whole && !n) return null;
    return { whole, month: whole, n, wins, isDay,
             color: (W.traceColor && W.traceColor(key)) || W.GOLD || RWLook.d.gold };
  }

  /* The strip + the edges. o = { hours, x:(hour)->px, y0, y1 (plot top/bottom), stripY, stripH,
   * sun, month: the trace key on screen ("YYYY-MM" or "w:YYYY-MM-DD") }. Draws into `g`. */
  function draw(g, o){
    g.selectAll("*").remove();
    if (!o.sun) return;
    const rs = runs(o.hours, o.sun), ts = traceSummary(o.month);
    rs.forEach((r, i) => {
      const xa = o.x(r.h0), xb = o.x(r.h1);
      g.append("rect").attr("x", xa).attr("y", o.stripY).attr("width", Math.max(0, xb-xa-1))
        .attr("height", o.stripH).attr("rx", 2).attr("fill", COLOR[r.win]).attr("fill-opacity", 0.9)
        .append("title").text(`${r.win} · ${pad(r.h0)}:00–${pad(r.h1%24)}:00 UTC · one sound for all of it`);
      if (xb - xa > 30) g.append("text").attr("x", (xa+xb)/2).attr("y", o.stripY + o.stripH/2 + 3.5)
        .attr("text-anchor", "middle").attr("fill", RWLook.d.daylabel).attr("font-size", 9.5)
        .attr("font-weight", 600).attr("letter-spacing", ".06em").text(r.win);
      // a traced window: a bar in the trace's own colour under its segment (an ECHO's is hollow
      // and dashed - the same window, traced in another year)
      if (ts && (ts.whole || ts.wins[r.win])) {
        const bar = g.append("rect").attr("x", xa).attr("y", o.stripY + o.stripH + 2)
          .attr("width", Math.max(0, xb-xa-1)).attr("height", 3);
        if (ts.echo) bar.attr("class", "wc-echo").attr("fill", "none").attr("stroke", ts.color)
          .attr("stroke-width", 1).attr("stroke-dasharray", "3,2");
        else bar.attr("fill", ts.color);
      }
      // THE EDGE: where the sound changes. A full-height line, not a dashed guide.
      if (i > 0) g.append("line").attr("x1", xa).attr("x2", xa).attr("y1", o.stripY).attr("y2", o.y1)
        .attr("stroke", COLOR[r.win]).attr("stroke-opacity", 0.55).attr("stroke-width", 1.2);
    });
    // the sun events the windows were cut from, and how far they move within the month
    const yS = o.stripY + o.stripH + 8;
    [["sr", "↑ sunrise"], ["ss", "↓ sunset"]].forEach(([k, nm]) => {
      const t = o.sun[k], lo = o.sun[k+"_lo"], hi = o.sun[k+"_hi"];
      if (t == null) return;
      const gg = g.append("g"), spread = hi != null && lo != null && hi - lo > 0.01;
      gg.append("title").text(spread
        ? `${nm} ${fmt(t)} UTC (mean over the month; ${fmt(lo)}–${fmt(hi)} from its first to its last day)`
        : `${nm} ${fmt(t)} UTC`);
      if (spread) gg.append("line").attr("x1", o.x(lo)).attr("x2", o.x(hi)).attr("y1", yS).attr("y2", yS)
        .attr("stroke", RWLook.d.cur).attr("stroke-opacity", 0.55).attr("stroke-width", 2);
      gg.append("path").attr("d", `M${o.x(t)},${yS-4} l4,6 l-8,0 z`).attr("fill", RWLook.d.cur);
    });
  }

  // The key for the sidebar: four swatches, the sun, what the edges mean, and what the hatching
  // and fading mean. `key` is the trace key on screen (month or "w:YYYY-MM-DD").
  function keyHTML(sun, mk, rows, entry, extra){
    const what = mk && mk.startsWith("w:") ? "day" : "month";
    const sw = w => `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;`
                  + `background:${COLOR[w]};margin-right:5px;vertical-align:-1px"></span>`;
    const ts = traceSummary(mk);
    const which = ts && (ts.whole ? `the whole ${what}` : ORDER.filter(w => ts.wins[w]).map(w => `${w} ${ts.wins[w]}`).join(" · "));
    const tr = !ts ? "" : ts.echo
      ? `<div style="margin-top:6px;color:${ts.color}">◌ echo · ${window.WC.label(ts.at)} is traced · ${which}</div>`
      : `<div style="margin-top:6px;color:${ts.color}">◎ traced · ${which}</div>`;
    return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 8px;font-size:11px">`
      + ORDER.map(w => `<div>${sw(w)}${w}</div>`).join("") + `</div>`
      + (sun ? `<div class="k" style="margin-top:6px;font-size:11px;line-height:1.5">`
        + `sunrise ${fmt(sun.sr)} · sunset ${fmt(sun.ss)} UTC${sun.est ? " (estimated)" : ""}<br>`
        + `dawn/dusk = ±1.5 h around them. The sound changes only at the coloured edges — `
        + `every hour inside a window plays the same point, and the ${rows || "row"} you are on never changes it.</div>` : "")
      + (entry && entry.have && entry.have.length < 24
          ? `<div class="k" style="margin-top:6px;font-size:11px;line-height:1.5">▨ hatched hours were not recorded this ${what} `
            + `(${24 - entry.have.length} of 24) — nothing to see there, and hovering one leaves the sound where it was.</div>` : "")
      + (extra || "")
      + tr;
  }

  // THE HOVER BOX — the scatter's #tip, same look, placed in the host's own pixels and flipped
  // against its right/bottom edge so it never sits on the cell it describes.
  function tip(host){
    if (!document.getElementById("diel-tip-css")) {
      const s = document.createElement("style"); s.id = "diel-tip-css";
      s.textContent = `.dtip{ position:absolute; display:none; pointer-events:none; z-index:4; max-width:230px;
        background:var(--rw-pop); border:1px solid var(--rw-pop-line); border-radius:7px; padding:5px 8px;
        font-size:11px; line-height:1.45; box-shadow:var(--rw-pop-shadow); }
        .dtip .k{ color:var(--dim,#67708c); margin-right:5px; }`;
      document.head.appendChild(s);
    }
    const el = document.createElement("div"); el.className = "dtip"; host.appendChild(el);
    return {
      show(e, html){
        el.style.display = "block"; el.style.left = "0px"; el.style.top = "0px"; el.innerHTML = html;
        const b = el.getBoundingClientRect(), [mx, my] = d3.pointer(e, host);
        el.style.left = Math.max(0, (mx+14+b.width  > host.clientWidth ) ? mx-14-b.width  : mx+14) + "px";
        el.style.top  = Math.max(0, (my+12+b.height > host.clientHeight) ? my-12-b.height : my+12) + "px";
      },
      hide(){ el.style.display = "none"; },
    };
  }
  // Was this hour recorded? Older payloads carry no `have`, and then every hour counts.
  const recorded = (entry, h) => !entry || !entry.have || entry.have.includes(h);
  // the "no recording" hatch, defined once per svg
  function hatch(svg){
    if (!svg.select("#diel-nodata").empty()) {                 // re-ink an existing pattern: the look may have changed
      svg.select("#diel-nodata rect").attr("fill", RWLook.d.hatch); svg.select("#diel-nodata line").attr("stroke", RWLook.d.hatchLine);
      return "url(#diel-nodata)"; }
    const p = svg.append("defs").append("pattern").attr("id", "diel-nodata")
      .attr("patternUnits", "userSpaceOnUse").attr("width", 6).attr("height", 6)
      .attr("patternTransform", "rotate(45)");
    p.append("rect").attr("width", 6).attr("height", 6).attr("fill", RWLook.d.hatch);
    p.append("line").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 6)
      .attr("stroke", RWLook.d.hatchLine).attr("stroke-width", 2);
    return "url(#diel-nodata)";
  }
  // The window a cell actually VOICES: its own, when the index data has a point for it this
  // month; otherwise null, which the views send as the whole month (and say so).
  const voiced = (entry, win) => (!entry || !entry.wins || entry.wins.includes(win)) ? win : null;
  const dot = c => `<i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${c};margin-right:5px;vertical-align:0"></i>`;

  return { ORDER, COLOR, HALF, sunOf, winAt, at, fmt, hourSpan, runs, traceSummary, draw, keyHTML, tip, dot, recorded, hatch, voiced };
})();
