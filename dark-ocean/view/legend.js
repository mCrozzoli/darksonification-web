// dark_ocean · PERCEPTUAL LEGEND — rebuilt 2026-09-27 on dark_re_wilding's model (manual C5 §19).
//
// A LEFT-DOCKED panel (key L, and its own edge tab) so the map stays in view while you listen.
// THE FACE IS A MAP LEGEND (Miguel's rule): each row is NAME → sound, one line of perceptual range,
// then the chips. Meaning lives in the (i): two or three plain sentences and one "in the data" line.
// Everything technical (ranges, levels, the audition policy, the old face verbatim) is in
// lab/LEGEND_REFERENCE.md, not here.
//
//   HEAR   HOLD a chip = THE DATE SHOWN with ONE driver pushed; let go = back to exactly the date shown.
//          The page builds the payload with the same function the timeline uses, and SuperCollider
//          cooks it with the same ~frameCook as playback (one cooking function). The legend sounds
//          even while ♪ is off (Miguel D4). This tier ADAPTS the old reference tier (Miguel D6): the
//          reference is always the date you are on.
//   GO TO  real dates computed from the loaded frames (coldest, warmest, a typical one, the water-mass
//          changes); click = go there, so the display shows it and the sound plays it.
//   SEE    one line per sound, so nothing you hear is unexplained.
//
// Wire contract: {type:"legend", cmd:"hold", driver, temp, sal, nut, anom, clusters} and
// {type:"legend", cmd:"release"}. The water-mass wire key stays "cluster" (shared by SC, the bridge,
// the web relay and the teaser conductor).
window.DarkLegend = (function () {
  const ROWS = [
    { key: "temp", name: "temperature", to: "pitch", range: "ten notes, 330 to 1100 Hz",
      chips: [["◀ colder", { temp: 0 }], ["warmer ▶", { temp: 1 }]],
      info: "How warm the water is, averaged over the region on the date shown. Warmer water plays a higher note, on a scale of ten steps. The scale is spread over the dates you are showing, so the warmest of them always plays the top note.",
      data: "thetao, region average" },
    { key: "salinity", name: "salinity", to: "space", range: "echo 0.1 to 0.35 seconds", field: "sal",
      chips: [["◀ fresher", { sal: 0 }], ["saltier ▶", { sal: 1 }]],
      info: "How salty the water is, averaged over the region on the date shown. Saltier open-ocean water gives the drops a longer echo in a wider space; fresher water keeps them close and dry. Listen to the drops, not the note.",
      data: "so, region average" },
    { key: "nutrients", name: "nutrients", to: "rain", range: "about 1 to 6 drops a second", field: "nut",
      chips: [["◀ poorer", { nut: 0 }], ["richer ▶", { nut: 1 }]],
      info: "How much nutrient the water carries, averaged over the region on the date shown. Richer water makes a busier, louder rain of drops; poorer water leaves a sparse, quiet patter. The echo on those same drops is salinity.",
      data: "total_nutrients, region average" },
    { key: "anomaly", name: "anomaly", to: "tremolo", range: "the note wavers about five times a second", field: "anom",
      chips: [["near its average", { anom: 0.5 }], ["far from it", { anom: 1 }]],
      info: "How far the water's temperature is from its own average over the whole record, warmer or colder. The note wavers more at either end of the dates you are showing and holds steady in the middle. Because that average covers every season, the warmest and coldest months waver most.",
      data: "thetao minus each place's average over the record" },
    { key: "cluster", name: "water mass", to: "bed and bell", range: null, categorical: true,
      info: "Which body of water covers most of the region on the date shown: Atlantic, Iceland/Polar or Arctic water. Each has its own low tone, the bed, under the other sounds. When a different one takes over, a clear bell rings, and its pitch names the water that arrives.",
      data: "water mass after Mastropole et al. 2017, the most common across the region" },
  ];
  const SEE = [
    ["the sound", "the whole region on the date shown; play or drag the timeline to hear it change"],
    ["pointing at the map", "rings a chime only where the water is upwelling or productive"],
    ["the place you picked", "rings on every date it is upwelling or productive"],
    ["chime", "upwelling: water colder than usual and rich in nutrients"],
    ["sparkle", "a productive front: plankton and nutrients both high"],
    ["chord", "the cells you are tracing"],
  ];

  const CSS = `
  #lgp{ position:fixed; top:0; left:0; width:430px; height:100%; z-index:40; display:none; box-sizing:border-box;
    background:#080b16; border-right:1px solid #1a2140; overflow:auto; padding:16px 20px 28px;
    font:13px/1.5 "SF Mono", ui-monospace, Menlo, monospace; color:var(--txt,#c8d0ee); }
  body.lg-open #lgp{ display:block; } body.lg-open #wrap{ margin-left:430px; }
  #lgp-tab{ position:fixed; top:50%; left:0; z-index:39; transform:translateY(-50%); writing-mode:vertical-rl;
    font:inherit; font-size:10px; letter-spacing:.14em; color:var(--dim,#5f6a8c); background:var(--panel,#0e1224);
    cursor:pointer; border:1px solid var(--line,#20264a); border-left:0; border-radius:0 5px 5px 0; padding:10px 3px; }
  #lgp-tab:hover{ color:var(--txt,#c8d0ee); } body.lg-open #lgp-tab{ display:none; }
  #lgp h2{ font-size:13px; letter-spacing:.2em; color:#fff; margin:0 0 4px; }
  #lgp .lsub{ color:var(--dim,#5f6a8c); font-size:11px; margin-bottom:6px; }
  #lgp-close{ position:absolute; top:12px; right:14px; background:#11162b; border:1px solid #2a3150; color:var(--dim,#5f6a8c);
    border-radius:6px; font:inherit; font-size:11px; padding:2px 8px; cursor:pointer; }
  #lgp-close:hover{ color:var(--txt,#c8d0ee); }
  #lgp .lsec{ font-size:10px; letter-spacing:.15em; text-transform:uppercase; color:var(--dim,#5f6a8c);
    margin:18px 0 8px; padding-top:11px; border-top:1px solid var(--line,#20264a); display:flex; align-items:center;
    cursor:pointer; user-select:none; }
  #lgp .lsec:hover{ color:var(--txt,#c8d0ee); }
  #lgp .lsec .lchev{ margin-left:auto; transition:transform .18s ease; opacity:.7; }
  #lgp .lsec.closed .lchev{ transform:rotate(-90deg); } #lgp .lsec.closed + .lbody{ display:none; }
  #lgp .lrow{ margin:0 0 14px; position:relative; }
  #lgp .lhead{ display:flex; align-items:center; gap:7px; font-size:12px; }
  #lgp .lname{ color:var(--txt,#c8d0ee); } #lgp .larrow{ color:var(--dim,#5f6a8c); } #lgp .lto{ color:var(--cur,#ffe08a); }
  #lgp .linfo{ margin-left:auto; width:18px; height:18px; border-radius:50%; border:1px solid #2a3150; background:#11162b;
    color:var(--dim,#5f6a8c); font:inherit; font-size:10px; line-height:16px; padding:0; cursor:pointer; }
  #lgp .linfo:hover, #lgp .linfo.on{ color:var(--txt,#c8d0ee); border-color:#4a5ad0; }
  #lgp .lswatch{ height:6px; border-radius:3px; margin:5px 0 2px; }
  #lgp .lrange{ font-size:10px; color:var(--dim,#5f6a8c); margin:2px 0 5px; }
  #lgp .lchips{ display:flex; flex-wrap:wrap; gap:7px; }
  #lgp .lchip{ background:#11162b; border:1px solid #2a3150; border-radius:7px; padding:5px 10px; font:inherit;
    font-size:11px; color:var(--txt,#c8d0ee); cursor:pointer; user-select:none; -webkit-user-select:none; touch-action:none; }
  #lgp .lchip:hover{ border-color:#4a5ad0; } #lgp .lchip .sw{ display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:6px; }
  #lgp .lchip.holding{ background:#1d2a4a; border-color:var(--cur,#ffe08a); color:#fff; }
  #lgp .ltip{ display:none; margin:7px 0 0; padding:9px 11px; background:#0e1328; border:1px solid #2a3150; border-radius:7px;
    font-size:11px; line-height:1.55; color:var(--txt,#c8d0ee); }
  #lgp .ltip.on{ display:block; } #lgp .ldata{ margin-top:6px; color:var(--dim,#5f6a8c); font-size:10px; }
  #lgp .lgo{ display:flex; flex-wrap:wrap; gap:7px; }
  #lgp .lgo .lchip small{ color:var(--dim,#5f6a8c); margin-left:6px; }
  #lgp .lsee div{ font-size:11px; margin:0 0 5px; } #lgp .lsee b{ color:var(--txt,#c8d0ee); font-weight:600; }
  #lgp .lsee span{ color:var(--dim,#5f6a8c); }`;

  let api = null, host = null, tab = null, HELD = null;
  const SLOP = 18, LS_OPEN = "ocean_legend_open";

  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  // ── hold: one module-level hold, released on EVERY path (re_wilding legend.js 388-465) ──
  function startHold(el, driver, push) {
    if (HELD || !api) return;                         // a second chip pressed during a hold is ignored
    const p = api.payload && api.payload();
    if (!p) return;
    HELD = { el };
    el.classList.add("holding");
    const msg = { type: "legend", cmd: "hold", driver,
      temp: p.temp, sal: p.sal, nut: p.nut, anom: p.anom, clusters: (p.clusters || [0, 0, 0, 0]).slice() };
    if (push.values) Object.assign(msg, push.values);
    if (push.clusters) msg.clusters = push.clusters.slice();
    api.send(msg);
  }
  function releaseHold() {
    if (!HELD) return;
    const h = HELD; HELD = null;                      // cleared FIRST, so exactly one release per hold
    h.el.classList.remove("holding");
    if (api) api.send({ type: "legend", cmd: "release" });
  }
  function bindHold(el, driver, push) {
    el.addEventListener("pointerdown", e => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      startHold(el, driver, push);
    });
    el.addEventListener("keydown", e => {             // keyboard: Space / Enter hold, key-up releases
      if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); startHold(el, driver, push); }
    });
    el.addEventListener("keyup", e => { if (e.key === " " || e.key === "Enter") releaseHold(); });
  }
  // capture phase: a handler that stops propagation cannot swallow the release
  window.addEventListener("pointerup", releaseHold, true);
  window.addEventListener("pointercancel", releaseHold, true);
  window.addEventListener("blur", releaseHold);                                   // focus left the window
  document.addEventListener("visibilitychange", () => { if (document.hidden) releaseHold(); });
  window.addEventListener("keydown", e => { if (e.key === "Escape") releaseHold(); }, true);
  window.addEventListener("pointermove", e => {                                   // the pointer left the chip
    if (!HELD) return;
    const r = HELD.el.getBoundingClientRect();
    if (e.clientX < r.left - SLOP || e.clientX > r.right + SLOP || e.clientY < r.top - SLOP || e.clientY > r.bottom + SLOP) releaseHold();
  }, true);

  // ── panel ──
  function setOpen(open) {
    document.body.classList.toggle("lg-open", open);
    try { localStorage.setItem(LS_OPEN, open ? "1" : "0"); } catch (_) {}
    if (!open) releaseHold();
    if (api && api.onToggle) api.onToggle(open);
  }
  function isOpen() { return document.body.classList.contains("lg-open"); }

  function gradient(key) {
    const f = api && api.scale ? api.scale(key) : null;
    if (!f) return "";
    const stops = []; for (let u = 0; u <= 1.0001; u += 0.1) stops.push(f(u));
    return `linear-gradient(90deg,${stops.join(",")})`;
  }

  function render() {
    if (!host) return;
    const masses = (api && api.waterMasses) ? api.waterMasses() : [];
    const rows = ROWS.map(r => {
      let chips;
      if (r.categorical) {
        chips = masses.map(m => `<button class="lchip" data-k="${r.key}" data-mass="${m.i}"><span class="sw" style="background:${m.color}"></span>${esc(m.name)}</button>`).join("");
      } else {
        chips = r.chips.map((c, j) => `<button class="lchip" data-k="${r.key}" data-c="${j}">${esc(c[0])}</button>`).join("");
      }
      const sw = r.categorical ? "" : `<div class="lswatch" style="background:${gradient(r.field || r.key)}"></div>`;
      return `<div class="lrow" data-k="${r.key}">
        <div class="lhead"><span class="lname">${esc(r.name)}</span><span class="larrow">→</span><span class="lto">${esc(r.to)}</span>
          <button class="linfo" data-k="${r.key}" title="what this means">i</button></div>
        ${sw}${r.range ? `<div class="lrange">${esc(r.range)}</div>` : ""}
        <div class="lchips">${chips}</div>
        <div class="ltip" data-k="${r.key}">${esc(r.info)}<div class="ldata">in the data: ${esc(r.data)}</div></div>
      </div>`;
    }).join("");
    const cat = (api && api.catalogue) ? api.catalogue() : [];
    const go = cat.length
      ? cat.map((c, j) => `<button class="lchip lgo-chip" data-j="${j}">${esc(c.label)}<small>${esc(c.sub || "")}</small></button>`).join("")
      : `<span class="lrange">no dates loaded yet</span>`;
    host.innerHTML = `<button id="lgp-close" title="close the legend (L)">✕</button>
      <h2>LEGEND</h2>
      <div class="lsub">hold a chip to hear one change; let go to return to the date shown</div>
      <div class="lsec">hear<span class="lchev">▾</span></div><div class="lbody">${rows}</div>
      <div class="lsec">go to a date<span class="lchev">▾</span></div><div class="lbody"><div class="lgo">${go}</div></div>
      <div class="lsec">see<span class="lchev">▾</span></div><div class="lbody lsee">${
        SEE.map(s => `<div><b>${esc(s[0])}</b> <span>· ${esc(s[1])}</span></div>`).join("")}</div>`;
    host.querySelector("#lgp-close").onclick = () => setOpen(false);
    host.querySelectorAll(".lsec").forEach(h => h.addEventListener("click", () => h.classList.toggle("closed")));
    host.querySelectorAll(".linfo").forEach(b => b.addEventListener("click", e => {
      e.stopPropagation();
      const tip = host.querySelector(`.ltip[data-k="${b.dataset.k}"]`), on = !tip.classList.contains("on");
      host.querySelectorAll(".ltip.on").forEach(t => t.classList.remove("on"));
      host.querySelectorAll(".linfo.on").forEach(t => t.classList.remove("on"));
      tip.classList.toggle("on", on); b.classList.toggle("on", on);
    }));
    host.querySelectorAll(".lrow .lchip").forEach(el => {
      const r = ROWS.find(x => x.key === el.dataset.k);
      if (r.categorical) {
        const i = +el.dataset.mass, cl = [0, 0, 0, 0]; cl[i] = 1;
        bindHold(el, r.key, { clusters: cl });
      } else {
        bindHold(el, r.key, { values: r.chips[+el.dataset.c][1] });
      }
    });
    host.querySelectorAll(".lgo-chip").forEach(el => el.addEventListener("click", () => {
      const c = cat[+el.dataset.j]; if (c && api.goto) api.goto(c.ti);
    }));
  }

  function init(opts) {
    api = opts;
    if (!document.getElementById("lgp-css")) {
      const st = document.createElement("style"); st.id = "lgp-css"; st.textContent = CSS; document.head.appendChild(st);
    }
    host = document.getElementById("lgp");
    if (!host) { host = document.createElement("div"); host.id = "lgp"; document.body.appendChild(host); }
    tab = document.getElementById("lgp-tab");
    if (!tab) { tab = document.createElement("div"); tab.id = "lgp-tab"; tab.textContent = "legend · L";
      tab.title = "open the legend (L)"; document.body.appendChild(tab); }
    tab.onclick = () => setOpen(true);
    document.addEventListener("keydown", e => {
      if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      if ((e.key === "l" || e.key === "L") && !e.metaKey && !e.ctrlKey && !e.altKey) setOpen(!isOpen());
    });
    render();
    let open = false; try { open = localStorage.getItem(LS_OPEN) === "1"; } catch (_) {}
    if (open) setOpen(true);
  }

  return { init, render, open: () => setOpen(true), close: () => setOpen(false), toggle: () => setOpen(!isOpen()),
           isOpen, release: releaseHold, isHolding: () => !!HELD, ROWS };
})();
