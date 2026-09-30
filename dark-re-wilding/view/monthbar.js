/* monthbar.js — shared month-selector strip (a year × month sinebow grid).
 *
 * Replaces the per-view month dropdown with a compact grid: one row per year,
 * twelve month cells each, coloured with the same sinebow the scatter uses. Cells
 * for months with no data are dimmed and inert.
 *
 * THIS GRID CHOOSES WHAT YOU SEE, AND NOTHING ELSE. It writes the SHOWN set (WC.setShown /
 * WC.toggleShown) and lights the months in it. It does NOT trace: a month you are looking at
 * gets no ring and no aura, because a ring means "I am keeping an eye on this point", which
 * is a different act (Miguel 2026-09-24: "the selected months, which are the ones being
 * visible in the display, should be without the extra shiny circle"). It used to write the
 * one merged set, which is where the stray rings came from.
 *
 * An EMPTY shown set means every month is visible, so the grid simply lights nothing.
 *
 * ONE selection policy, shared by every view (Miguel 2026-09-23: "click selects... click on
 * the same unselects, and we can select many at the same time"). `MonthBar.pick(mk, cur)`
 * toggles the month in the shared SHOWN set and returns the month the view should show: the
 * one just added, or — when you deselect — another still-shown month, or the last one you
 * were on. Views used to each have their own policy; four different ones, which is what made
 * the control feel arbitrary.
 *
 * Dragging across cells shows a run of months in one gesture (one save, one redraw).
 *
 * SINGLE-CHOICE MODE — `mount({ single:true, ... })`, spectro and mfcc only (Miguel 2026-09-26:
 * "it is ok one month at a time... then for mfcc and spectro we should not be able to select
 * many months at the time"). A click puts the view on that month and does NOTHING else: no
 * SHOWN toggle, no drag-run, no gold glow — the white cursor is the whole selection. Those two
 * views used to share the toggle policy, so one click there narrowed the scatter, roses,
 * biplot and linear to a single month, and every further click lit another gold month while
 * the view still drew one. A deliberate partial reversal of the 09-23 shared policy, for the
 * two views that can only ever draw one month. The other four views pass nothing and are
 * byte-for-byte unchanged.
 *
 * DAY CALENDAR — `mountDays({...})`: the day picker of spectro/mfcc's DAY resolution. One
 * month as a Monday-first calendar (UTC); a day's fill fades with how much of it was recorded,
 * days with no recording are inert, traced days carry the trace dot, the white cursor is the
 * day on screen.
 *
 * Usage:
 *   const bar = MonthBar.mount({ host:"#monthbar", months:()=>months,
 *                                current:()=>monthKey, onPick:pickMonth });
 *   bar.render();   // call again whenever months / current / selection change
 *
 * MonthBar.MON and MonthBar.monthColor are exported so views can reuse them.
 */
window.MonthBar = (function(){
  const MON=["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const monthColor = m => d3.interpolateSinebow(((m-1)%12)/12);
  const HEAD=["J","F","M","A","M","J","J","A","S","O","N","D"];

  // inject the strip's CSS once, shared by every view that mounts a bar
  function ensureCSS(){
    if(document.getElementById("monthbar-css")) return;
    const s=document.createElement("style"); s.id="monthbar-css";
    s.textContent=`
      .mbgrid{ display:grid; grid-template-columns:18px repeat(12,1fr); gap:2px; align-items:center; }
      .mb-hd{ font-size:8px; text-align:center; color:var(--rw-mb-hd); }
      .mb-yl{ font-size:9px; color:var(--rw-mb-yl); text-align:right; padding-right:1px; }
      .mb-cell{ position:relative; height:15px; border-radius:2px; cursor:pointer; opacity:.8; border:1px solid transparent; box-sizing:border-box; }
      .mb-cell:hover{ opacity:1; }
      .mb-cell.gone{ background:var(--rw-mb-gone); cursor:default; opacity:.4; }
      .mb-cell.sel{ opacity:1; border-color:var(--rw-gold); box-shadow:0 0 7px 1px var(--rw-gold-glow); }
      .mb-cell.cur{ outline:2px solid var(--rw-cursor); outline-offset:-2px; }
      .mb-cell.drag{ opacity:1; border-color:var(--rw-gold); }
      .mb-cell.trc::after{ content:""; position:absolute; right:1px; top:1px; width:6px; height:6px;
        border-radius:50%; background:var(--tc,var(--rw-gold)); box-shadow:0 0 0 1.5px var(--rw-bg); }
      /* an ECHO (the same month/date as a trace, another year): the dot HOLLOW - a ring in the
         trace's colour - so a traced May marks every May down its column */
      /* a PARTIAL month (a time of day missing, or under half the usual hours): a half-filled badge,
         bottom left - the corner the trace/echo dot does not use */
      .mb-cell.part::before{ content:""; position:absolute; left:1px; bottom:1px; width:5px; height:5px;
        border-radius:50%; background:linear-gradient(90deg,var(--rw-half-fill) 50%,var(--rw-bg) 50%);
        box-shadow:0 0 0 1px var(--rw-bg); }
      .mb-cell.ech::after{ content:""; position:absolute; right:1px; top:1px; width:4px; height:4px;
        border-radius:50%; background:var(--rw-bg); box-shadow:0 0 0 1.5px var(--tc,var(--rw-gold)), 0 0 0 2.5px var(--rw-bg); }
      .mbgrid.single .mb-cell.cur{ opacity:1; box-shadow:0 0 6px 1px var(--rw-mb-glow); }
      .dbgrid{ display:grid; grid-template-columns:repeat(7,1fr); gap:2px; align-items:center; }
      .dbgrid .mb-cell{ height:17px; font-size:9px; line-height:15px; text-align:center; color:var(--rw-daylabel); font-weight:600; }
      .dbgrid .mb-cell.gone{ color:var(--rw-mb-gone-txt); font-weight:400; }
      .dbhead{ display:flex; justify-content:space-between; align-items:center; margin:2px 0 4px;
        font-size:10px; color:var(--rw-mb-yl); letter-spacing:.06em; }
      .dbhead button{ font:inherit; font-size:11px; padding:1px 7px; background:var(--rw-ctl); color:var(--rw-txt);
        border:1px solid var(--rw-ctl-line); border-radius:5px; cursor:pointer; }
      .dbhead button:disabled{ opacity:.35; cursor:default; }`;
    document.head.appendChild(s);
  }

  let drag = null;                                   // {run:Set<monthKey>, moved:bool} while a drag is live
  if (typeof window !== "undefined") {
    window.addEventListener("pointerup", () => {
      if (!drag) return;
      const run = drag.run, moved = drag.moved; drag = null;
      document.querySelectorAll(".mb-cell.drag").forEach(c => c.classList.remove("drag"));
      // a plain press is handled by the click above; only a real drag shows the run
      if (moved && window.WC && WC.setShown) WC.setShown([...run], "add");
    });
  }

  function mount(opts){
    ensureCSS();
    const host = d3.select(typeof opts.host==="string" ? opts.host : opts.host);
    const single = !!opts.single;                      // spectro / mfcc: see the header
    function render(){
      host.selectAll("*").remove();
      const months = opts.months() || [];
      const years  = [...new Set(months.map(m=>+m.split("-")[0]))].sort();
      // glow the SHOWN months. Empty = no filter = everything visible, so nothing glows:
      // the grid lights what you have singled out, not the default state of the world.
      // A single-choice strip lights nothing: SHOWN is not its business.
      const sel    = single ? new Set() : ((window.WC && WC.shownMonths) ? WC.shownMonths() : new Set());
      const cur    = opts.current && opts.current();
      const grid   = host.append("div").attr("class","mbgrid"+(single?" single":""));
      grid.append("div");                                             // empty corner
      HEAD.forEach(l=>grid.append("div").attr("class","mb-hd").text(l));
      years.forEach(y=>{
        grid.append("div").attr("class","mb-yl").text("'"+String(y).slice(2));
        for(let m=1;m<=12;m++){
          const mk=`${y}-${String(m).padStart(2,"0")}`, exists=months.includes(mk);
          // a TRACED month carries a dot in its trace's own colour. The strip still never
          // traces; it only reports, so a trace made in the scatter is findable from the
          // single-month views, where the plot frame shows it only while you are on it.
          const trc = exists && window.WC && WC.isTracedMonth && WC.isTracedMonth(mk);
          const ech = exists && !trc && window.WC && WC.isEchoMonth && WC.isEchoMonth(mk);
          const cov = exists && window.WC && WC.coverage ? WC.coverage(mk) : null, part = !!(cov && cov.partial);
          const cell = grid.append("div")
            .attr("class","mb-cell"+(exists?"":" gone")+(sel.has(mk)?" sel":"")+(mk===cur?" cur":"")+(trc?" trc":"")+(ech?" ech":"")+(part?" part":""))
            .style("background",exists?monthColor(m):null)
            .style("--tc",trc?(WC.traceColor(mk)||WC.GOLD):ech?(WC.echoColor(mk)||WC.GOLD):null)
            .attr("title",exists?`${MON[m]} ${y}${trc?" · traced":ech?` · echo of ${WC.label(WC.echoOf(mk))}`:""}${part?` · partial: ${cov.why}`:""}`:"");
          if(!exists) continue;          // `continue`, NOT return: return would exit the YEAR
          // single choice: a click and nothing else, so the module-level drag is never armed
          // here and the window pointerup listener can never write SHOWN from these pages
          if(single){ cell.on("click",()=>opts.onPick(mk)); continue; }
          // click = the shared toggle policy; drag across cells = show a run in one gesture
          cell.on("pointerdown",function(e){ e.preventDefault(); drag={run:new Set([mk]),moved:false};
                   this.classList.add("drag"); })
              .on("pointerenter",function(){ if(!drag) return; drag.moved=true; drag.run.add(mk);
                   this.classList.add("drag"); })
              .on("click",function(){ if(drag&&drag.moved) return; opts.onPick(mk); });
        }
      });
    }
    return { render };
  }

  // THE policy. Toggle the month in the shared SHOWN set; report which month the view should
  // put its cursor on. Single-month views (linear, spectro, mfcc) use the return value; the
  // multi-month views (scatter, biplot, roses) just redraw against the new filter.
  function pick(mk, cur){
    if(!mk) return cur;
    const WCm = window.WC;
    if(!WCm || !WCm.toggleShown) return mk;
    WCm.toggleShown(mk);
    const set = (WCm.shownMonths && WCm.shownMonths()) || new Set();
    if(set.has(mk)) return mk;                       // just shown -> go there
    if(set.size) { const left=[...set].sort(); return left[left.length-1]; }   // hidden -> fall back
    return cur || mk;                                // filter now empty (all shown) -> stay put
  }

  // THE DAY CALENDAR. opts: host, month:()=>"YYYY-MM", days:()=>[{key:"YYYY-MM-DD", hours, minutes}]
  // (recorded days only), current:()=>"YYYY-MM-DD", onPick(dk). Monday-first, UTC weekdays.
  const WD = ["M","T","W","T","F","S","S"];
  function mountDays(opts){
    ensureCSS();
    const host = d3.select(opts.host);
    function render(){
      host.selectAll("*").remove();
      const mk = opts.month && opts.month(); if(!mk) return;
      const [y, m] = mk.split("-").map(Number);
      const recs = new Map((opts.days() || []).map(d => [d.key, d]));
      const cur = opts.current && opts.current();
      const keys = [...recs.keys()].sort(), ci = keys.indexOf(cur);
      const head = host.append("div").attr("class","dbhead");
      const step = k => head.append("button").text(k<0?"◀":"▶").attr("title",k<0?"previous recorded day":"next recorded day")
        .property("disabled", ci<0 || !keys[ci+k]).on("click",()=>{ if(keys[ci+k]) opts.onPick(keys[ci+k]); });
      step(-1);
      head.append("span").text(`${MON[m]} ${y} · ${keys.length} day${keys.length===1?"":"s"} recorded`);
      step(1);
      const grid = host.append("div").attr("class","dbgrid");
      WD.forEach(l => grid.append("div").attr("class","mb-hd").text(l));
      const first = (new Date(Date.UTC(y, m-1, 1)).getUTCDay() + 6) % 7;     // Monday = 0
      for(let i=0;i<first;i++) grid.append("div");
      const nDays = new Date(Date.UTC(y, m, 0)).getUTCDate();
      for(let d=1; d<=nDays; d++){
        const dk = `${mk}-${String(d).padStart(2,"0")}`, r = recs.get(dk);
        const trc = r && window.WC && WC.isTraced && WC.isTraced("w:"+dk);
        const ech = r && !trc && window.WC && WC.isEcho && WC.isEcho("w:"+dk);
        const cell = grid.append("div").text(d)
          .attr("class","mb-cell"+(r?"":" gone")+(dk===cur?" cur":"")+(trc?" trc":"")+(ech?" ech":""))
          .style("background", r ? monthColor(m) : null)
          .style("opacity", r ? (dk===cur ? 1 : 0.35 + 0.6*Math.min(1, (r.minutes||0)/1440)) : null)
          .style("--tc", trc ? (WC.traceColor("w:"+dk)||WC.GOLD) : ech ? (WC.echoColor("w:"+dk)||WC.GOLD) : null)
          .attr("title", r ? `${d} ${MON[m]} ${y} · ${(r.minutes/60).toFixed(1)} h recorded${trc?" · traced":ech?` · echo of ${WC.label(WC.echoOf("w:"+dk))}`:""}`
                           : `${d} ${MON[m]} ${y} · no recording`);
        if(r) cell.on("click", () => opts.onPick(dk));
      }
    }
    return { render };
  }

  // The "all" affordance every view needs beside the grid: drop the filter, show everything.
  // Kept here so the six views spell it the same way.
  function showAll(){ if (window.WC && WC.showAll) WC.showAll(); }

  return { mount, mountDays, monthColor, MON, pick, showAll };
})();
