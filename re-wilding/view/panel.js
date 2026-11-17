/* panel.js — sidebar SECTIONS + collapse, shared by the six dark_re_wilding views.
 *
 * Each view writes its sidebar as a flat run of headings and controls, in whatever
 * order it grew. This module groups that run into named, collapsible sections in ONE
 * canonical order, so all six views read the same way round, and gives the sidebar an
 * edge tab (dark_hugur's idiom, key `i`) so a plot can take the full width.
 *
 * Progressive enhancement: it only ever MOVES existing nodes, never rebuilds them, so
 * every handler the views and wc.js attached keeps working. A view needs no markup
 * change to opt in — it just loads this after wc.js.
 */
(function () {
  const LS_SEC = "rewild_sec_", LS_SIDE = "rewild_side_open", LS_TAB = "rewild_tab";

  // The canonical order. A heading's TEXT decides where its controls land (see ROLE below).
  // Anything unrecognised is a per-view LIVE READOUT - WINDOW, PRESS A MONTH, SCRUB THE MONTH,
  // HOVER A CELL, PHASE - and belongs to the pinned INFORMATION block. The static keys that
  // DECODE a plot (CLUSTERS, VARIANCE, INTENSITY, COEFFICIENTS, FALSE-COLOUR, ENERGY) are not
  // readouts and are named in ROLE so they file under VIEW with the rest of the view's setup.
  // INFORMATION IS PINNED, NOT TABBED, and that is a considered exception to "one tab each".
  // It is the live scrub readout: every pointermove of a drag rewrites it, and the month bar
  // — the primary navigation control in linear/spectro/mfcc — lives in VIEW while its feedback
  // lands here. Under plain tabs a control in one tab would report into a tab you cannot see.
  // It is also the only layout that fits: the sidebar's content width is 212px on the scatter,
  // and five equal tabs of a monospace face leave 3 characters each. Four leave 5.
  const SECTIONS = [
    { id: "info",  title: "INFORMATION", pin: true },
    { id: "view",  title: "VIEW",               tab: "view" },
    { id: "lens",  title: "WEATHER · CHANNEL",  tab: "lens" },
    { id: "sound", title: "SOUND",              tab: "sound" },
    { id: "ctrl",  title: "CONTROLLER",         tab: "trace" },
  ];
  const ROLE = [
    [/^HOW TO READ/,               "drop"],     // deleted outright — it lives in the legend now
    // SHOWING is the biplot's heading for its year buttons + month grid (the scatter keeps the same
    // controls under RESOLUTION). Unmatched, it fell through to the pinned INFORMATION block, so
    // with INFORMATION folded the biplot had no visible year / month selection (Miguel 2026-09-27).
    [/^(VIEW|RESOLUTION|READING|SHOWING)/, "view"],
    [/^(WEATHER|CHANNEL)/,         "lens"],
    [/^(SOUND|MASTER)/,            "sound"],
    // TRACE is wc.js's own heading. SELECTION stays matched because it is what that block was
    // called before the two ideas were separated — a view still carrying the old word lands
    // in the same tab rather than falling through to the pinned readout.
    [/^(TRACE|SELECTION)/,         "ctrl"],
    [/^(CLUSTERS|VARIANCE|FALSE-COLOUR|ENERGY|INTENSITY|COEFFICIENTS)/, "view"],
  ];
  const roleOf = t => (ROLE.find(([re]) => re.test(t)) || [null, "info"])[1];

  const CSS = `
  .sec{ border-top:1px solid var(--line,#222948); }
  #side > .sec:first-child{ border-top:0; }
  .sec-h{ display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none;
    padding:9px 2px; color:var(--dim,#67708c); font-size:11px; letter-spacing:.14em; }
  .sec-h:hover{ color:var(--txt,#c8d0ee); }
  .sec-chev{ margin-left:auto; font-size:10px; transition:transform .18s ease; opacity:.7; }
  .sec.closed .sec-chev{ transform:rotate(-90deg); }
  .sec.closed .sec-b{ display:none; }
  .sec-b{ padding:0 0 10px; }
  /* tabbed sections: one visible at a time, and their own headings are redundant with the tab */
  .sec[data-tab]{ display:none; border-top:0; }
  .sec[data-tab].on{ display:block; }
  .sec[data-tab] > .sec-h{ display:none; }
  #side-tabs{ display:grid; grid-template-columns:repeat(var(--ntab,4),1fr); gap:4px;
    position:sticky; top:0; z-index:2; background:var(--panel,#10142a);
    padding:9px 0 10px; border-top:1px solid var(--line,#222948); }
  .stab{ font:inherit; font-size:10px; letter-spacing:.04em; padding:5px 3px; cursor:pointer;
    border:1px solid var(--line,#222948); border-radius:6px; background:var(--panel,#10142a);
    color:var(--dim,#67708c); text-align:center; white-space:nowrap; overflow:hidden; }
  .stab:hover{ color:var(--txt,#c8d0ee); border-color:var(--rw-ctl-line); }
  .stab.on{ color:var(--cur,#fff1a8); border-color:var(--rw-gold-line); background:var(--rw-ctl); }
  /* the GUI connection state, on the strip so no tab can hide it (P31) */
  .side-gui{ grid-column:1/-1; font-size:9.5px; letter-spacing:.06em; color:var(--dim,#67708c);
    text-align:right; margin:1px 2px -3px; }
  /* a sub-heading that just repeats its section's name is noise once grouped */
  .sec-b .sec-dupe{ display:none; }
  /* the sidebar itself is a grid column in every view, so collapsing zeroes it */
  body.side-closed #wrap{ grid-template-columns:1fr 0 !important; }
  body.side-closed #side{ padding:0 !important; border:0 !important; }
  #side-tab{ position:fixed; top:50%; right:var(--side-w,0px); z-index:20; transform:translateY(-50%);
    writing-mode:vertical-rl; font:inherit; font-size:10px; letter-spacing:.14em;
    color:var(--dim,#67708c); background:var(--panel,#10142a); cursor:pointer;
    border:1px solid var(--line,#222948); border-right:0; border-radius:5px 0 0 5px;
    padding:10px 3px; }
  #side-tab:hover{ color:var(--txt,#c8d0ee); }
  /* NAVIGATION IS A DRAG, so nothing in the page may start a text selection. It is not enough
     to protect the SVG: what decides is where the drag ANCHORS, and the facet captions, the
     month strip and the sidebar are all HTML sitting beside or on top of the plots. SVG text
     is named explicitly because inheritance into an SVG subtree is not reliable across
     engines. Form controls and the readout VALUES opt back in, so numbers stay copyable. */
  body{ -webkit-user-select:none; user-select:none; }
  svg, svg *{ -webkit-user-select:none; user-select:none; }
  input, textarea, select, option, [contenteditable]{ -webkit-user-select:auto; user-select:auto; }
  #side .v, #i-ax, #w-ax, #c-vals, #wx-corr, .copyable{ -webkit-user-select:text; user-select:text; }
  /* the ARMED-BRUSH cursor is brush.js's (a brush tip on every plot it is mounted on) and
     rose.html's (its own trace-drag): a crosshair here said nothing, every plot wears one */`;

  (function injectCSS() {
    const st = document.createElement("style"); st.id = "rw-panel-css"; st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  })();

  const isHead = el => el.nodeType === 1 &&
    (el.tagName === "H4" || el.classList.contains("wc-seglabel") || el.classList.contains("seglabel"));
  const headText = el => (el.textContent || "").trim().toUpperCase();

  function openState(id, dflt) {
    try { const v = localStorage.getItem(LS_SEC + id); if (v !== null) return v === "1"; } catch (e) {}
    return !dflt;
  }

  function build() {
    const side = document.getElementById("side");
    if (!side) return;
    // flatten: #wc is wc.js's own run of headings, so splice its children in place
    const flat = [];
    [...side.children].forEach(c => {
      if (c.classList && c.classList.contains("sec")) { flat.push({ sec: c }); return; }
      // #wc is wc.js's own container, filled only once the data lands. Take its children
      // but LEAVE the element: wc.js writes into it by reference, so removing it here
      // would send the whole sound panel to a detached node.
      if (c.id === "wc") { [...c.children].forEach(g => flat.push({ el: g })); return; }
      if (c.id === "side-tabs") return;              // our own chrome, never content
      flat.push({ el: c });
    });
    // already sectioned and nothing new arrived -> nothing to do. This guard is load-bearing:
    // the observer watches the subtree, so every readout write and every fader tick lands here.
    if (flat.every(f => f.sec || f.el.id === "wc")) return;

    const buckets = { drop: [] }; SECTIONS.forEach(s => buckets[s.id] = []);
    // reuse what a previous pass built, so a re-run after wc.js renders is additive
    flat.forEach(f => { if (f.sec) {
      const id = f.sec.getAttribute("data-sec");
      [...f.sec.querySelector(".sec-b").children].forEach(n => buckets[id].push(n));
      f.sec.remove();
    }});
    let cur = "info";
    flat.forEach(f => {
      if (!f.el || f.el.id === "wc") return;
      if (isHead(f.el)) { cur = roleOf(headText(f.el)); }
      buckets[cur].push(f.el);
    });

    buckets.drop.forEach(n => n.remove());         // HOW TO READ: gone, not hidden

    const built = [];
    SECTIONS.forEach(s => {
      const kids = buckets[s.id];
      if (!kids.length) return;
      const sec = document.createElement("div");
      sec.className = "sec"; sec.setAttribute("data-sec", s.id);
      if (s.tab) sec.setAttribute("data-tab", s.tab);
      const h = document.createElement("div");
      h.className = "sec-h";
      h.innerHTML = `<span>${s.title}</span><span class="sec-chev">▾</span>`;
      const b = document.createElement("div"); b.className = "sec-b";
      kids.forEach(k => {
        if (isHead(k) && headText(k) === s.title) k.classList.add("sec-dupe");
        b.appendChild(k);
      });
      sec.appendChild(h); sec.appendChild(b);
      if (s.pin) {                                  // the pinned readout still folds away
        if (!openState(s.id, false)) sec.classList.add("closed");
        h.onclick = () => {
          const closed = sec.classList.toggle("closed");
          try { localStorage.setItem(LS_SEC + s.id, closed ? "0" : "1"); } catch (e) {}
        };
      }
      side.appendChild(sec);
      built.push({ s, sec });
    });
    layOut(side, built);

    const wc = document.getElementById("wc");
    if (wc) { wc.style.display = "none"; side.appendChild(wc); }

    // the view switcher belongs WITH the view controls, not in the header
    const nav = document.getElementById("viewnav");
    const viewBody = side.querySelector('.sec[data-sec="view"] .sec-b');
    if (nav && viewBody && !viewBody.contains(nav)) {
      nav.style.marginBottom = "8px";
      viewBody.insertBefore(nav, viewBody.firstChild);
    }
  }

  // Pinned section on top, then the tab strip, then the tabbed sections. A tab whose section
  // is empty in this view is simply not offered, so the strip shrinks rather than lying.
  function layOut(side, built) {
    const pin = built.find(b => b.s.pin);
    const tabs = built.filter(b => b.s.tab);
    let strip = document.getElementById("side-tabs");
    if (!tabs.length) { if (strip) strip.remove(); return; }
    if (!strip) { strip = document.createElement("div"); strip.id = "side-tabs"; }
    strip.innerHTML = "";
    strip.style.setProperty("--ntab", String(tabs.length));

    let active = null;
    try { active = localStorage.getItem(LS_TAB); } catch (e) {}
    if (!tabs.some(t => t.s.id === active)) active = tabs[0].s.id;
    const show = id => {
      tabs.forEach(t => t.sec.classList.toggle("on", t.s.id === id));
      strip.querySelectorAll(".stab").forEach(b => b.classList.toggle("on", b.dataset.tab === id));
      try { localStorage.setItem(LS_TAB, id); } catch (e) {}
    };
    tabs.forEach(t => {
      const b = document.createElement("div");
      b.className = "stab"; b.dataset.tab = t.s.id; b.textContent = t.s.tab;
      b.title = t.s.title;
      b.onclick = () => show(t.s.id);
      strip.appendChild(b);
    });
    // THE GUI CONNECTION STATE, always in sight (TASKS P31, manual B2.21 §10.1). It lived in the
    // TRACE heading - inside one tab - and was invisible whenever another tab was open. wc.js
    // writes it; this is only its place. (The header's chip is the bridge's WS, a different thing.)
    const gui = document.createElement("div");
    gui.id = "side-gui"; gui.className = "side-gui"; gui.textContent = "gui · standalone";
    strip.appendChild(gui);
    if (window.WC && WC.refreshStatus) WC.refreshStatus();
    // order: pin, strip, tabbed sections
    if (pin) side.insertBefore(pin.sec, side.firstChild);
    side.insertBefore(strip, pin ? pin.sec.nextSibling : side.firstChild);
    tabs.forEach(t => side.appendChild(t.sec));
    show(active);
  }

  function mountTab() {
    if (document.getElementById("side-tab")) return;
    const tab = document.createElement("div");
    tab.id = "side-tab"; tab.title = "show / hide the controls (i)";
    document.body.appendChild(tab);
    const side = document.getElementById("side");
    const paint = () => {
      const closed = document.body.classList.contains("side-closed");
      tab.textContent = closed ? "controls · i" : "hide · i";
      // park the tab against the sidebar's inner edge, not over its contents
      const w = (!closed && side) ? side.getBoundingClientRect().width : 0;
      document.documentElement.style.setProperty("--side-w", Math.round(w) + "px");
    };
    window.addEventListener("resize", paint);
    const set = closed => {
      document.body.classList.toggle("side-closed", closed);
      try { localStorage.setItem(LS_SIDE, closed ? "0" : "1"); } catch (e) {}
      paint();
      // the plots size themselves off the wrapper, and collapsing fires no resize
      setTimeout(() => window.dispatchEvent(new Event("resize")), 0);
    };
    let closed = false;
    try { closed = localStorage.getItem(LS_SIDE) === "0"; } catch (e) {}
    document.body.classList.toggle("side-closed", closed); paint();
    tab.onclick = () => set(!document.body.classList.contains("side-closed"));
    tab.addEventListener("repaint", paint);
    document.addEventListener("keydown", e => {
      if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      if (e.key === "i") set(!document.body.classList.contains("side-closed"));
    });
  }

  function start() {
    mountTab(); build();
    requestAnimationFrame(() => { const t = document.getElementById("side-tab"); if (t) t.dispatchEvent(new Event("repaint")); });
    // wc.js fills #wc only once the data lands, so re-group when the sidebar grows
    const side = document.getElementById("side");
    if (!side) return;
    // subtree, because wc.js fills #wc (a CHILD of #side) once the data lands. build()
    // early-returns when everything is already grouped, so its own moves settle in one pass.
    let t = null;
    new MutationObserver(() => { clearTimeout(t); t = setTimeout(build, 30); })
      .observe(side, { childList: true, subtree: true });
  }
  if (document.readyState !== "loading") start();
  else document.addEventListener("DOMContentLoaded", start);

  window.SidePanel = { rebuild: build };
})();
