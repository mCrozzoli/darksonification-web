/* looks.js — the three looks' DATA colours for dark_re_wilding (style kit adoption, 2026-09-30).
 *
 * Loads after the kit (darkstyle.js) and d3, before the modules that draw. Every colour the JS draws with
 * comes from here, and everything scalar comes from rewild_tokens.css (one source): RWLook.d reads the
 * --rw-* tokens of the look in force; RWLook.phase (time of day), RWLook.palette (the eight trace slots)
 * and RWLook.lens (the weather ramps) are ONE object each, refilled IN PLACE when the look changes, so a
 * module that captured them at load (wc.js PALETTE, diel.js COLOR, linear's PHASE_COLOR) stays current.
 * What CSS cannot hold lives here: the continuous scales per look. dark = the d3 schemes the pages used;
 * light keeps them off the white end (the pale end must sit clear of the ground); paper draws in Miguel's
 * colours (the kit's paperRamps). Spectrograms recede toward the ground: dark low → black, light and paper
 * low → pale (kit README, rule 4).
 * After a look change the pages redraw on the resize event they all listen to (panel.js does the same).
 */
window.RWLook = (function () {
  const SCALARS = ["gold", "gold-hi", "cursor", "casing", "del", "warm", "partial", "air", "water", "nowx", "anom", "anom2", "anom-edge",
                   "corr-pos", "corr-neg", "daylabel", "dayband", "hatch", "hatch-line", "dim", "cur", "txt-hi", "label"];
  const camel = (k) => k.replace(/-(.)/g, (_, c) => c.toUpperCase());
  const tok = (name) => (window.DarkStyle ? DarkStyle.tok("--rw-" + name) : "") || "";

  const R = window.DarkStyle ? DarkStyle.ramp : null, P = window.DarkStyle ? DarkStyle.paperRamps : null;
  const LENS = {
    dark:  { rain: d3.interpolateBlues, wind: d3.interpolatePuBuGn, temp: d3.interpolateRdYlBu },
    // the pages reverse temp at use (RdYlBu(0) is red): keep that contract; rain/wind start off the white end
    light: { rain: (t) => d3.interpolateBlues(0.25 + 0.75 * t), wind: (t) => d3.interpolatePuBuGn(0.25 + 0.75 * t), temp: d3.interpolateRdYlBu },
    paper: R ? { rain: R(P.blue), wind: R(P.teal), temp: ((f) => (t) => f(1 - t))(R(P.coolWarm)) }   // coolWarm runs cold → warm; the pages pass 1 - t
             : { rain: d3.interpolateBlues, wind: d3.interpolatePuBuGn, temp: d3.interpolateRdYlBu },
  };
  const MAGMA = {
    dark: d3.interpolateMagma,
    light: (t) => d3.interpolateMagma(1 - t),
    paper: R ? R(P.ink) : d3.interpolateMagma,
  };

  const d = {};                                  // the scalars of the look in force (from the tokens)
  const phase = {};                              // dawn/day/dusk/night
  const palette = [];                            // the eight trace slots
  const years = {};                              // P56: the four calendar years (--rw-year-*), refilled in place
  const lens = {};                               // rain/wind/temp interpolators
  const listeners = [];

  function apply() {
    const look = window.DarkStyle ? DarkStyle.get() : "dark";
    for (const k of SCALARS) d[camel(k)] = tok(k);
    d.t0 = tok("t0");
    d.magma = MAGMA[look] || MAGMA.dark;
    d.cluster = d3.schemeTableau10;              // the biplot's clusters: designed for a light ground, kept in every look
    d.look = look;
    Object.assign(phase, { dawn: tok("dawn"), day: tok("day"), dusk: tok("dusk"), night: tok("night") });
    palette.splice(0, palette.length, ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => tok("t" + i)));
    for (const y of [2023, 2024, 2025, 2026]) years[y] = tok("year-" + y);
    Object.assign(lens, LENS[look] || LENS.dark);
  }
  apply();

  if (window.DarkStyle) {
    DarkStyle.onChange(() => {
      apply();
      for (const f of listeners.slice()) { try { f(d.look); } catch (e) { console.error(e); } }
      // the pages redraw on resize (their own listener); the legend re-keys itself
      setTimeout(() => { window.dispatchEvent(new Event("resize")); if (window.LEG && LEG.refresh) LEG.refresh(); }, 0);
    });
  }

  // The LOOK control at the end of the VIEW tab (kit rule 6). wc.js builds the sidebar's panel once the data
  // lands; this waits for it, appends a heading + the kit's three buttons to #wc, and panel.js files the block
  // under VIEW by its heading, after everything already there.
  function mount() {
    if (!window.DarkStyle || document.getElementById("rw-looks")) return;
    const wc = document.getElementById("wc");
    if (!wc || !document.querySelector("#wc-master")) return;
    const h = document.createElement("div"); h.className = "wc-seglabel"; h.id = "rw-looks-h"; h.textContent = "VIEW · LOOK";
    const g = document.createElement("div"); g.id = "rw-looks"; g.className = "wcgrid";
    wc.appendChild(h); wc.appendChild(g);
    DarkStyle.control(g, { btnClass: "wbtn" });
    DarkStyle.keys();
  }
  function watch() {
    const side = document.getElementById("side");
    if (!side) return;
    mount();
    if (document.getElementById("rw-looks")) return;
    const mo = new MutationObserver(() => { mount(); if (document.getElementById("rw-looks")) mo.disconnect(); });
    mo.observe(side, { childList: true, subtree: true });
  }
  if (document.readyState !== "loading") watch(); else document.addEventListener("DOMContentLoaded", watch);

  return { d, phase, palette, lens, years, onChange: (f) => { listeners.push(f); return () => { const k = listeners.indexOf(f); if (k >= 0) listeners.splice(k, 1); }; },
           look: () => d.look, version: "1" };
})();
