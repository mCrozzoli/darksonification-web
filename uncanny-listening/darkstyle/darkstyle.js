// =============================================================================================
//  darkstyle.js — the three looks of Dark Sonification displays (kit v1, 2026-09-28): dark, light, paper
//
//  Load it in <head>, right after darkstyle.css and before anything that draws: it sets
//  <html data-theme> at once (URL ?theme=… wins and is remembered, then the last choice, then "dark"),
//  so the first paint is already in the right look. Then, from any page script:
//
//    DarkStyle.get() / set("paper") / cycle()     the look (every open page of the site follows)
//    DarkStyle.onChange(fn)                        repaint what you drew yourself (canvas, data colours)
//    DarkStyle.tok("--ds-land") / tokens()         token values for canvas code (cached per look)
//    DarkStyle.sets(look)                          validated identity colours: cat3, cat4, lines8
//    DarkStyle.ramp(stops) / paperRamps            continuous scales, interpolated in OKLab (256-step LUT)
//    DarkStyle.control(el, {btnClass}) / keys()    the dark · light · paper buttons, and the T key
//    DarkStyle.check.categorical(…) / .ramp(…)     the palette checks (README: the method)
//
//  Source of truth: projects/web/style/. Designs carry a copy (sync.py). No dependencies.
// =============================================================================================
window.DarkStyle = (function () {
  const LOOKS = ["dark", "light", "paper"];
  const KEY = "darkstyle.theme";
  const TITLES = {
    dark: "dark: the display as it has always been",
    light: "light: the same display on a light ground",
    paper: "paper: ink and watercolour, from Miguel's drawings",
  };
  const FONTS = "https://fonts.googleapis.com/css2?family=Karla:wght@400;500;600&family=Rubik:wght@300;400&display=swap";

  const listeners = [];
  let look = "dark", cache = {};

  function lsGet() { try { return localStorage.getItem(KEY); } catch (_) { return null; } }
  function lsSet(v) { try { localStorage.setItem(KEY, v); } catch (_) {} }
  function initial() {
    let q = null;
    try { q = new URLSearchParams(location.search).get("theme"); } catch (_) {}
    if (LOOKS.includes(q)) { lsSet(q); return q; }
    const s = lsGet();
    return LOOKS.includes(s) ? s : "dark";
  }

  // ---------------------------------------------------------------- the look
  function apply() {
    document.documentElement.setAttribute("data-theme", look);
    cache = {};
    if (look === "paper") { paperFonts(); paperDefs(); }
  }
  function notify() { for (const f of listeners.slice()) { try { f(look); } catch (e) { console.error(e); } } }
  function set(next) {
    if (!LOOKS.includes(next) || next === look) return;
    look = next; lsSet(next); apply(); notify();
  }
  function cycle() { set(LOOKS[(LOOKS.indexOf(look) + 1) % LOOKS.length]); }
  function onChange(fn) { listeners.push(fn); return () => { const k = listeners.indexOf(fn); if (k >= 0) listeners.splice(k, 1); }; }
  window.addEventListener("storage", (e) => {                     // another page of the site changed it
    if (e.key === KEY && LOOKS.includes(e.newValue) && e.newValue !== look) { look = e.newValue; apply(); notify(); }
  });

  // paper's fonts (Karla, Rubik: SIL Open Font License) load only when paper is chosen; the dark and light
  // looks make no request. crossorigin keeps them loadable in cross-origin-isolated pages.
  function paperFonts() {
    if (document.getElementById("ds-fonts")) return;
    const l = document.createElement("link");
    l.id = "ds-fonts"; l.rel = "stylesheet"; l.crossOrigin = "anonymous"; l.href = FONTS;
    document.head.appendChild(l);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { cache = {}; if (look === "paper") notify(); });
  }
  // the ink wobble (the landing page's filter) for drawn charts: --ds-ink-filter: url(#ds-ink)
  function paperDefs() {
    const add = () => {
      if (document.getElementById("ds-defs")) return;
      const box = document.createElement("div");
      box.innerHTML = '<svg id="ds-defs" width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>'
        + '<filter id="ds-ink" x="-5%" y="-5%" width="110%" height="110%"><feTurbulence type="fractalNoise" baseFrequency=".04" numOctaves="2" seed="4" result="n"/>'
        + '<feDisplacementMap in="SourceGraphic" in2="n" scale="2.2"/></filter></defs></svg>';
      document.body.appendChild(box.firstChild);
    };
    if (document.body) add(); else document.addEventListener("DOMContentLoaded", add, { once: true });
  }

  // ---------------------------------------------------------------- tokens for canvas code
  function tok(name) {
    if (!(name in cache)) cache[name] = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return cache[name];
  }
  const CANVAS = ["map-bg", "land", "coast", "graticule", "graticule-dash", "veil", "axis", "nb", "brush", "brush-path",
                  "ring", "ring-halo", "dim", "label", "txt", "font-canvas"];
  function tokens() {
    if (cache.__all) return cache.__all;
    const t = {};
    for (const k of CANVAS) t[k.replace(/-(.)/g, (_, c) => c.toUpperCase())] = tok("--ds-" + k);
    const d = t.graticuleDash;
    t.graticuleDash = d && d !== "none" ? d.split(/[\s,]+/).map(Number) : [];
    t.ringHalo = /^rgba?\(.*,\s*0\s*\)$|^transparent$/.test(t.ringHalo) ? null : t.ringHalo;
    return (cache.__all = t);
  }

  // ---------------------------------------------------------------- colour
  const hexLin = (h) => [1, 3, 5].map((i) => { const c = parseInt(h.slice(i, i + 2), 16) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const toHex = (rgb) => "#" + rgb.map((c) => { c = Math.max(0, Math.min(1, c)); c = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; return Math.round(c * 255).toString(16).padStart(2, "0"); }).join("");
  function labOf([r, g, b]) {
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  }
  function linOf([L, a, b]) {
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
    return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s];
  }
  // a continuous scale through `stops` (evenly spaced), interpolated in OKLab, as a 256-step lookup:
  // fast enough to colour every cell of a map on every frame
  function ramp(stops) {
    const P = stops.map((h) => labOf(hexLin(h))), lut = new Array(256);
    for (let k = 0; k < 256; k++) {
      const x = (k / 255) * (P.length - 1), i = Math.min(P.length - 2, Math.floor(x)), f = x - i;
      lut[k] = toHex(linOf(P[i].map((v, j) => v + (P[i + 1][j] - v) * f)));
    }
    const fn = (t) => lut[Math.max(0, Math.min(255, Math.round((+t || 0) * 255)))];
    fn.stops = stops.slice();
    return fn;
  }

  // Identity colours, per look, each set validated against its own look's ground (README → the checks).
  //   cat3   three identities that touch on a map (all pairs checked): e.g. water masses
  //   cat4   four identities on a map (all pairs): e.g. k-means clusters; hover labels carry them too
  //   lines8 eight outline colours, adjacent pairs checked, each drawn with its own label (traces)
  // dark = the originals of the house displays, unchanged.
  const SETS = {
    dark: { cat3: ["#2b6da8", "#46b0a4", "#e07b4f"], cat4: ["#fae41c", "#399199", "#a863e9", "#fb9f65"],
            lines8: ["#ffd166", "#4cc9f0", "#ef476f", "#06d6a0", "#f78c6b", "#c77dff", "#80ffdb", "#ffd6a5"] },
    light: { cat3: ["#2b6da8", "#35b2a5", "#e07b4f"], cat4: ["#cec731", "#229ba4", "#a863e9", "#f08a4b"],
             lines8: ["#a87400", "#0a73a8", "#cd1540", "#0f7a5f", "#7a45cc", "#c45a1e", "#15706a", "#784204"] },
    paper: { cat3: ["#277ca9", "#39b8aa", "#e3876b"], cat4: ["#ceac1b", "#1d99a0", "#8a5a9e", "#d9785c"],
             lines8: ["#9c6c12", "#1d5a80", "#c12740", "#3f6e5a", "#6b3c7a", "#a8502e", "#1f6f68", "#5a3a1e"] },
  };
  const GROUND = { dark: "#05070f", light: "#f4f6fa", paper: "#f3e5da" };   // the map ground each set was checked on
  // Paper's continuous scales, in Miguel's colours. Each runs monotone in lightness (coolWarm: each arm
  // toward its pale middle), its pale end sits 7–12 ΔE off the paper, and 10 steps stay ≥ 3 ΔE apart
  // under protanopia and deuteranopia. Dark and light keep the d3 schemes the designs already use.
  const paperRamps = {
    coolWarm: ["#1f4d6b", "#5e8fb0", "#ead394", "#e0957c", "#8e2a45"],   // cold ink-blue · butter · warm rose (temperature)
    lilac: ["#d6bfdb", "#b08fb8", "#7a5188", "#43234f"],                  // → aubergine ink (salinity)
    olive: ["#e3d47e", "#aab35a", "#6c8c3c", "#34512a"],                  // butter → olive (nutrients)
    ochre: ["#e9cf84", "#dba04a", "#b85a4b", "#4a2447"],                  // butter → ochre → rose → aubergine (anomaly)
    blue: ["#c6d8e0", "#8cb0c5", "#4f89ad", "#1d4a66"],
    teal: ["#c2dccb", "#80bba4", "#3f9187", "#1f5a57"],
    ink: ["#d8c5c4", "#b9a3ad", "#735c73", "#33203a"],
    gold: ["#e2d07e", "#bfa446", "#7c883a", "#3b5623"],
    rust: ["#ecc2a8", "#de9272", "#c0604a", "#7e3327"],
  };

  // ---------------------------------------------------------------- the checks (the dataviz method)
  // OKLab ΔE ×100; colour blindness simulated with Machado, Oliveira & Fernandes (2009) at severity 1.
  const MACHADO = {
    protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  };
  const simLin = (h, k) => { const c = hexLin(h); return k ? MACHADO[k].map((r) => Math.max(0, Math.min(1, r[0] * c[0] + r[1] * c[1] + r[2] * c[2]))) : c; };
  const dE = (a, b, k) => { const p = labOf(simLin(a, k)), q = labOf(simLin(b, k)); return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
  const lum = (h) => { const [r, g, b] = hexLin(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const L = (h) => labOf(hexLin(h))[0];
  const C = (h) => { const [, a, b] = labOf(hexLin(h)); return Math.hypot(a, b); };
  const check = {
    // identity sets: CVD separation (target ≥ 8, floor 6), normal vision (hard floor 15), contrast (≥ 3,
    // below that the identity must also be labelled), chroma (≥ 0.10). pairs: "all" for maps/scatters.
    categorical(pal, { ground, pairs = "adjacent" } = {}) {
      const n = pal.length, list = [];
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (pairs === "all" || j === i + 1) list.push([i, j]);
      const worst = (k) => list.reduce((m, [i, j]) => Math.min(m, dE(pal[i], pal[j], k)), Infinity);
      const cvd = Math.min(worst("protan"), worst("deutan")), nor = worst(), con = Math.min(...pal.map((c) => contrast(c, ground)));
      const low = pal.filter((c) => C(c) < 0.10);
      const rows = [
        ["colour-blind separation", cvd >= 8 ? "pass" : cvd >= 6 ? "warn" : "fail", `worst ${pairs} ΔE ${cvd.toFixed(1)} (target 8, floor 6)`],
        ["normal-vision separation", nor >= 15 ? "pass" : "fail", `worst ΔE ${nor.toFixed(1)} (floor 15)`],
        ["contrast with the ground", con >= 3 ? "pass" : "warn", `lowest ${con.toFixed(2)}:1` + (con >= 3 ? "" : " (label them: hover box, legend)")],
        ["chroma", low.length ? "warn" : "pass", low.length ? `below 0.10: ${low.join(" ")}` : "all ≥ 0.10"],
      ];
      return { ok: rows.every((r) => r[1] !== "fail"), rows };
    },
    // continuous scales: lightness in order (for a diverging scale, each arm toward the middle), steps apart
    // under colour blindness, the pale end visibly off the ground.
    ramp(stops, { ground, diverging = false, steps = 11 } = {}) {
      const f = ramp(stops), s = Array.from({ length: steps }, (_, k) => f(k / (steps - 1))), Ls = s.map(L), mid = (steps - 1) / 2;
      const up = (a) => a.every((v, k) => k === 0 || v >= a[k - 1] - 1e-9), down = (a) => a.every((v, k) => k === 0 || v <= a[k - 1] + 1e-9);
      const mono = diverging ? up(Ls.slice(0, mid + 1)) && down(Ls.slice(mid)) : up(Ls) || down(Ls);
      const step = (k) => Math.min(...s.slice(1).map((h, i) => dE(h, s[i], k)));
      const st = Math.min(step(), step("protan"), step("deutan"));
      const pale = s.reduce((a, b) => (L(a) > L(b) ? a : b)), off = dE(pale, ground);
      const rows = [
        ["lightness in order", mono ? "pass" : "fail", `L ${Ls[0].toFixed(2)} → ${Ls[steps - 1].toFixed(2)}` + (diverging ? " (each arm toward the middle)" : "")],
        ["steps apart", st >= 3 ? "pass" : st >= 2 ? "warn" : "fail", `smallest of ${steps - 1} steps ΔE ${st.toFixed(1)}, colour-blind included`],
        ["pale end off the ground", off >= 7 ? "pass" : "warn", `ΔE ${off.toFixed(1)}`],
      ];
      return { ok: rows.every((r) => r[1] !== "fail"), rows, samples: s };
    },
    contrast, dE,
  };

  // ---------------------------------------------------------------- the control
  function control(el, { btnClass = "" } = {}) {
    el.classList.add("ds-looks");
    el.innerHTML = LOOKS.map((t) => `<button type="button" class="${btnClass}" data-look="${t}" title="${TITLES[t]} (T cycles)">${t}</button>`).join("");
    el.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => set(b.dataset.look)));
    const paint = () => el.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.look === look));
    paint(); onChange(paint);
    return el;
  }
  let keysBound = false;
  function keys() {
    if (keysBound) return; keysBound = true;
    window.addEventListener("keydown", (e) => {
      if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      if ((e.key === "t" || e.key === "T") && !e.metaKey && !e.ctrlKey && !e.altKey) cycle();
    });
  }

  look = initial();
  apply();
  return { LOOKS, TITLES, get: () => look, set, cycle, onChange, tok, tokens, ramp, paperRamps,
           sets: (l) => SETS[l || look], ground: (l) => GROUND[l || look], check, control, keys, version: "1" };
})();
