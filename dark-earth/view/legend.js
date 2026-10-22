// dark_svartsengi · PERCEPTUAL LEGEND (manual C5 §19; modelled on dark_ocean/viz/legend.js). W3.
//
// A LEFT-DOCKED panel (key L, and its own edge tab) so the timeline stays in view while you listen.
// THE FACE IS A MAP LEGEND (Miguel 2026-10-22: "the legend: minimal", as dark_re_wilding's, DISPLAY_DESIGN §5 there): each row
// is NAME · plain meaning, at most one range line, then the chips. The layer's kind (measurement · inference · evidence) is
// said once, on its heading. Meaning lives in the (i): 2–3 plain sentences and "in the data: <column>", a popover (hover opens
// it, click pins it, Escape or a click outside closes it), written with textContent only. A layer with no chip has no row.
//
//   HEAR   HOLD a chip = your own point with ONE quantity pushed (DESIGN §4.6); let go = back to exactly your point.
//          Wire: {type:"legend", layer, qty, value, hold:1} on press and the same with hold:0 on release
//          (CONTRACT §5 /dark_legend; the qty numbers are W2's, sc/svk_cook.scd ~svkLegendRows, mirrored in svk_messages.json).
//          SC pushes the quantity on the state it already holds (one cooking function); the page touches nothing else.
//   GO TO  real moments picked from the loaded data (largest quake, busiest day, highest ground, …); click = go there.
//   SEE    one line per view, only the encodings that view has.
//
// Names of data quantities come from manifest.columns (labels) and their ranges from manifest.ranges; the layer
// names and what-you-hear lines are the sound design (DESIGN §4), kept here like dark_ocean keeps them.
window.DarkLegend = (function () {
  "use strict";
  let api = null, host = null, tab = null, HELD = null, PIN = null;
  const SLOP = 18, LS_OPEN = "svk_legend_open";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const hz = (f) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)} kHz` : `${Math.round(f)} Hz`);
  const brune = (m) => 0.37 * 3500 * Math.cbrt((16 * 3e6) / (7 * 10 ** (1.5 * m + 9.1)));     // CONTRACT §2.4

  // the rows: built from the manifest each render (labels, ranges, constants)
  function layers() {
    const M = api.manifest(), C = M.columns || {}, R = M.ranges || {}, TR = (M.constants && M.constants.TRANSPOSE) || 250;
    const lab = (k, fb) => (C[k] && C[k].label) || fb || k;
    const epi = (k, fb) => (C[k] && C[k].epistemic) || fb;
    const bands = (M.constants && M.constants.bands) || {};
    const endRF = api.lastRecharge ? api.lastRecharge() : null;
    const rf = R.recharge_frac || {};
    const melh = (M.stations || []).find((s) => s.kind === "seismic");
    const covTxt = api.coverageText ? api.coverageText() : "";
    // v0.11 Body v2 (layer 6): qty 0 θ, 1 pressure, 2 the bow, 10 + m one mode alone. Values from the current room
    const rn = api.roomNow ? api.roomNow() : {}, B2 = rn.body2, ident = rn.ident, BW = rn.bow;
    const top = ident && ident.modes ? ident.modes.map((m, k) => [m, k]).sort((p, q) => (q[0].amp || 0) - (p[0].amp || 0)).slice(0, 3) : [];
    const now = (v, d = 2) => (cooked2(v) ? [[`now ${v.toFixed(d)}`, v]] : []);
    const body2 = { layer: 6, name: "body", epi: "measurement",
      rows: [
        { key: "b2theta", qty: 0, name: "θ", to: "how long the ground has waited",
          chips: [["just after ◀", 0], ["the longest ▶", 1], ...now(B2 && B2.theta)],
          info: "How long the ground has waited since the last eruption, against the longest wait before it. As the wait grows the body's balance tips from its low modes to its high ones. In the vent's regime rooms it is the minute's place in its regime.",
          data: "theta (the body tables)" },
        { key: "b2press", qty: 1, name: "pressure", to: "how high the ground stands in this room",
          chips: [["lowest ◀", 0], ["highest ▶", 1], ...now(B2 && B2.pressure)],
          info: "Where the ground stands between its lowest and highest in this room. Higher presses the body harder: brighter, with a longer echo.",
          data: "pressure, from SKSH_u_ds" },
        { key: "b2bow", qty: 2, name: "bow", to: "how fast magma is arriving",
          range: "−30 dB at the slowest · 0 dB at the fastest",
          chips: [["slowest ◀", -30], ["fastest ▶", 0], ...(BW && Number.isFinite(BW.bow_db) ? [[`now ${BW.bow_db.toFixed(0)} dB`, BW.bow_db]] : [])],
          info: "The bow is the inflow: how fast magma is still arriving. It has been easing off since 2024. Where the inflow was not measured, the bow plays veiled at the room's usual level.",
          data: "bow_db = 20·log10(inflow_rel)" },
        { key: "b2modes", qty: null, name: "one mode", to: "the body taken apart",
          chips: top.map(([m, k]) => [`${m.sensor || m.comp || "mode"} · ${hz(SvkCook.heardHz(m))}`, 10 + k]),
          info: "Each mode is one sensor's own rhythm, found in the data and moved up to a pitch you can hear. Hold one to hear it alone; these are the room's three strongest.",
          data: "modes[] in body/identity/<room>.json" },
      ].filter((r) => r.chips.length) };
    const v1 = api.compareV1 && api.compareV1();
    const all = [
      { layer: 0, name: "tension", pair: "continuous", info: "the ground's height at SKSH against the last eruption's start, and the wait since the ground last fell",
        rows: (() => {
          const tn = api.tensionNow ? api.tensionNow() : null, f = (v, d = 2) => (v == null ? "?" : v.toFixed(d));
          const u = R.SKSH_u_mm || {}, sgn = (v) => (v == null ? "?" : `${v >= 0 ? "+" : ""}${Math.round(v)} mm`);
          const enc = api.tensionEncoding ? api.tensionEncoding() : "A";
          const rows = [
            { key: "height", qty: 5, name: lab("SKSH_u_mm"), to: "the pitch of a bowed tone (T-A)", epistemic: epi("SKSH_u_mm", "measurement"),
              range: u.min != null ? `${Math.round(u.min)} to ${Math.round(u.max)} mm over the record` : "",
              chips: [["low (0)", 0], ["high (1)", 1], ...(tn && tn.u_abs != null ? [[`now (${f(tn.u_abs)})`, tn.u_abs]] : [])],
              info: "How high the ground stands at SKSH, on the scale of the whole record: the voice climbs as the ground rises and glides down at every eruption's fall. The pitch is how high the ground stands, not a sound the ground makes. Where the GNSS file is a straight line (not measured, e.g. all of January 2024) the tone is veiled; a one-day spike in the file is never heard as a fall.",
              data: "SKSH_u_mm (spike days replaced by their neighbours); u_abs in /svk_tension" },
            { key: "above", qty: 4, name: lab("above_last_start_mm", "height above where the last eruption began"), to: "the interval to a quiet reference tone (T-A)", epistemic: "measurement",
              range: tn && tn.onsetMin != null ? `earlier eruptions began between ${sgn(tn.onsetMin)} and ${sgn(tn.onsetMax)} · now ${sgn(tn.above)}` : "",
              chips: [...(tn && tn.onsetMin != null ? [[`${sgn(tn.onsetMin)}`, tn.onsetMin]] : []), ["at the start level (0)", 0], ...(tn && tn.above != null ? [[`now ${sgn(tn.above)}`, tn.above]] : [])],
              info: "A quiet second tone holds at the level where the last eruption began; the interval between the two voices is how far the ground stands above or below it. Every earlier eruption began within a small interval of its reference. Where that reference eruption is unknown (early 2024) the reference tone is silent.",
              data: "above_last_start_mm = SKSH Up − U_start of the last magmatic event" + (tn && tn.derived.includes("above_last_start_mm") ? " (derived by the page until the pipeline's tile has it)" : "") },
            { key: "wait", qty: 3, name: lab("wait_rel", "the wait since the ground last fell"), to: "beating that turns rough past the longest wait (T-A)", epistemic: "measurement",
              range: tn && tn.days != null ? `now ${tn.days} days, the longest before ${tn.longest} days (${f(tn.wait_rel)}×)` : "",
              chips: [["just after a fall (0)", 0], ["the longest before (1)", 1], ...(tn && tn.wait_rel != null ? [[`now (${f(tn.wait_rel)})`, tn.wait_rel]] : [])],
              info: "The days since the ground last fell, divided by the longest wait between earlier eruptions. The voice slowly beats as the wait grows; past 1 it is longer than any wait before, and the beating turns rough.",
              data: "wait_rel = days_since_fall / the longest earlier wait" + (tn && tn.derived.includes("wait_rel") ? " (derived by the page until the pipeline's tile has it)" : "") },
            { key: "recharge", qty: 0, name: lab("recharge_frac"), to: "the pitch of a bowed tone (T-B)", epistemic: epi("recharge_frac", "measurement"),
              range: endRF != null ? `0 just after an eruption · 1 back at its level · ${endRF.toFixed(2)} at the end` : "",
              chips: [["just after (0)", 0], ["back at the level (1)", 1], ...(endRF != null ? [[`the end (${endRF.toFixed(2)})`, endRF]] : [])],
              info: "The v0 mapping, kept for comparison: how far the ground has risen back toward where the last eruption began, as an octave. Earlier eruptions began anywhere between about 0.9 and 2.2, so the octave is not a trigger. Heard only when the engine plays encoding T-B.",
              data: "recharge_frac (SKSH)" + (rf.max != null ? `; ranges ${rf.min?.toFixed?.(2)} to ${rf.max?.toFixed?.(2)}` : "") },
          ];
          // T-C, the deformation mode (v0.9.2): tension qty 6 = cycle_period_d (days), 7 = inflow_rel (0–1), 8 = re-strike
          // (value ignored). The shape has no qty, so its row carries no chips (a chip that cannot be held is worse than none)
          const dn = api.deformNow ? api.deformNow() : null, hz = (f) => (f == null ? "?" : f >= 100 ? `${Math.round(f)} Hz` : `${f.toFixed(1)} Hz`);
          rows.push(
            { key: "cycle", enc: "C", qty: 6, name: lab("cycle_period_d", "the eruption cycle's period").split(":")[0], to: `the pitch, ${dn ? dn.oct : 30} octaves up (T-C)`, epistemic: epi("cycle_period_d", "measurement"),
              range: dn && dn.period != null ? `earlier cycles ${dn.minI}–${dn.maxI} days → ${hz(dn.hzMax)}–${hz(dn.hzMin)} · now ${Math.round(dn.period)} days → ${hz(dn.hz)}` : "",
              chips: dn && dn.period != null ? [[`the shortest (${dn.minI} d)`, dn.minI], [`the longest before (${dn.maxI} d)`, dn.maxI], [`now (${Math.round(dn.period)} d)`, dn.period]] : [],
              info: `The time between eruptions, as a frequency moved up ${dn ? dn.oct : 30} octaves: short cycles are high, long ones low. While the ground waits, the period grows and the pitch glides down, an inverse chirp. Each eruption strikes the mode again. This pitch is the eruption cycle's frequency moved up ${dn ? dn.oct : 30} octaves: a property of the sequence, not a sound the ground makes.`,
              data: "cycle_period_d = max(the last completed interval, days since the last eruption); eruptions hidden in the GNSS (Jan/Feb 2024) count" + (dn && dn.derived.includes("cycle_period_d") ? " (derived by the page until the pipeline's tile has it)" : "") },
            { key: "shape", enc: "C", qty: null, name: "the cycle's shape", to: "the timbre: six harmonics (T-C)", epistemic: "measurement",
              range: dn && dn.h ? `now h2 ${dn.h[1].toFixed(2)} · h3 ${dn.h[2].toFixed(2)} · h4 ${dn.h[3].toFixed(2)} (h1 = 1)` : "",
              chips: [],
              info: "One cycle of the ground's rise and fall, decomposed into its first six harmonics, like the modes a black hole's ringdown is read by. A slow rise and a sudden fall make a bright, sawtooth-like tone. The last completed cycle is used until the current one has lasted longer.",
              data: "cyc_h1…cyc_h6 of SKSH_u_ds, detrended, 256 points" + (dn && dn.derived.some((d) => d.startsWith("cyc_h")) ? " (derived by the page until the pipeline's tile has them)" : "") },
            { key: "inflow", enc: "C", qty: 7, name: lab("inflow_rel", "the inflow, relative to its maximum"), to: "the loudness, a decaying ringdown (T-C)", epistemic: epi("inflow_rel", "measurement"),
              range: dn && dn.inflow != null ? `now ${dn.inflow.toFixed(2)} mm/day${dn.tau != null ? ` · decay time ≈ ${Math.round(dn.tau)} days` : ""} · the most ${dn.inflowMax.toFixed(1)} mm/day` : "",
              chips: dn && dn.inflowRel != null ? [["the fastest (1)", 1], ...(dn.rel2024 != null ? [[`2024's median (${dn.rel2024.toFixed(2)})`, dn.rel2024]] : []), [`now (${dn.inflowRel.toFixed(2)})`, dn.inflowRel]] : [],
              info: "How fast the ground is rising, measured over the last 60 days, relative to the fastest it ever rose. The tone fades as the inflow decays, a ringdown toward silence.",
              data: "inflow_rel = inflow_mm_d / its maximum; inflow_tau_d (info only)" + (dn && dn.derived.includes("inflow_mm_d") ? " (derived by the page until the pipeline's tile has them)" : "") },
            { key: "restrike", enc: "C", qty: 8, name: "an eruption", to: "strikes the mode again (T-C)", epistemic: "measurement",
              range: dn && dn.nFalls ? `${dn.nFalls} eruptions in the record, the last ${dn.lastFall}` : "",
              chips: [["strike it", 0]],
              info: "Each eruption strikes the deformation mode again, as a merger excites a black hole's ringdown: the tone restarts bright, then decays with the inflow. Hold the chip to hear one strike on the current cycle.",
              data: "the boundaries of cycle_period_d: magmatic and hidden_by_interpolation events" });
          // CONTRACT §5.1: offer only the rows the active Tension encoding reads (T-A: 5, 4, 3 · T-B: 0 · T-C: the deform rows)
          return rows.filter((r) => (enc === "C" ? r.enc === "C" : r.enc === "C" ? false : enc === "B" ? r.qty === 0 : r.qty !== 0));
        })() },
      { layer: 1, name: "body v1", pair: "continuous", info: "the ground's energy in four bands, a resonant body (the v1 voice, for comparison)",
        rows: Object.keys(bands).map((b, i) => {
          const [lo, hi] = bands[b], fc = Math.sqrt(lo * hi) * TR;
          return { key: `body_${b}`, qty: i, name: lab(`rsam_${b}`), to: `a resonance at ${hz(fc)}`, epistemic: epi(`rsam_${b}`, "measurement"),
            range: `${lo}–${hi} Hz × ${TR} · ${covTxt || "only where a waveform exists"}`, chips: [["push it up", 1]],
            info: `The ground's shaking between ${lo} and ${hi} Hz, measured at the vent station. Louder shaking in this band makes this resonance of the body stronger; the balance of the four tells you which kind of shaking dominates. Where no waveform was recorded the body is silent, and the timeline hatches it.`,
            data: `rsam_${b} (${melh ? melh.id : "seismic station"}, mean |velocity| in counts)` };
        }) },
      { layer: 2, name: "swarm", epi: epi("eq_n", "inference"),
        rows: [
          { key: "rate", qty: 0, name: "clicks", to: "the quakes, one click each",
            chips: [["a rhythm ◀", 4], ["a pitch", 200], ["a noise ▶", 2000]],
            info: "The quakes IMO located, at their true rate times the playback speed: a slow swarm is a rhythm, a dense one a pitch, the densest a noise. A box drawn on the map limits it to those quakes.",
            data: "eq_n · events/eq.json" },
          { key: "bells", qty: 4, name: "bells", to: "one per quake of M 2 or more",
            range: `M 2 ≈ ${hz(brune(2) * TR)} · M 4 ≈ ${hz(brune(4) * TR)}`,
            chips: [["M 2", 2], ["M 3", 3], ["M 4", 4]],
            info: "Each larger quake rings a bell: the bigger the quake, the lower the bell. Its pitch is the typical corner frequency for that magnitude, not one measured from the quake itself.",
            data: "mag, fc_hz (Brune)" }] },
      // v0.10 (DESIGN §4.7): two layers with data for the whole record. /dark_legend has no layer numbers for them yet, so
      // their rows explain the mapping and carry no chips
      // v0.10.3 legend layers 4 (array: qty 0–8 = the component in /svk_array order, value = a signed velocity −1…1) and
      // 5 (rumble: qty 0 logE_abs, 1 n_abs). v1 voices: shown only with "compare v1 layers" on
      { layer: 4, name: "array", pair: "continuous", info: "the three GNSS stations as a sensor array: nine deep voices, one per station and direction",
        rows: ["SKSH", "SENG", "THOB"].map((st, si) => ({ key: `array_${st}`, name: `${st}`, to: "its three voices (north, east, up)", epistemic: epi(`${st}_u_vel`, "measurement"),
          range: si === 0 ? "each on its own range: + = north / east / up, − = the other way" : "",
          // [label, value, qty]: qty = the component's index in /svk_array order (sksh_n … thob_u)
          chips: [["up, rising (+1)", 1, 3 * si + 2], ["up, falling (−1)", -1, 3 * si + 2], ["north (+1)", 1, 3 * si], ["east (+1)", 1, 3 * si + 1]],
          info: si === 0 ? "How fast each station moves, north, east and up, over the last week. Each of the nine is its own deep voice: rising ground brightens it, horizontal motion moves it in space, and the three stations sit at three places. Hold a chip to hear one voice alone at that speed; when all nine fall together you hear an eruption through the array." : `${st}'s three voices. Hold a chip to hear one of them alone.`,
          data: `${st}_{n,e,u}_vel (mm/day, trailing 7-day fit of the spike-free series), signed on its p01/p99` })) },
      { layer: 5, name: "rumble", pair: "discrete", info: "the catalogue's seismic energy as a sub-bass rumble",
        rows: [{ key: "rumble_e", qty: 0, name: lab("eq_logE", "seismic energy released"), to: "a sub-bass rumble, 25–90 Hz", epistemic: epi("eq_logE", "inference"),
          range: "the most active days roar; the ending is a near-silent floor",
          chips: [["a murmur (0.3)", 0.3], ["a roar (1)", 1]],
          info: "The energy released by the quakes IMO located, as a low rumble that roars in November 2023 and in each swarm and falls to a near-silent floor at the end. It is the layer you feel more than hear.",
          data: "eq_logE on the bin of the level you are at (a day, an hour, a minute)" },
          { key: "rumble_n", qty: 1, name: lab("eq_n"), to: "how dense the rumble is", epistemic: epi("eq_n", "inference"),
          range: "", chips: [["one quake (0)", 0], ["a swarm (1)", 1]],
          info: "How many quakes there are in the bin, on its own log range: a single quake barely thickens the rumble, a swarm fills it.",
          data: "eq_n (log) on the bin's range" }] },
      { layer: 3, name: "ground", epi: "evidence",
        rows: [{ key: "speed", qty: 0, name: "speed", to: "the recording itself, played faster",
          range: `${hz(0.1 * TR)} – ${hz(45 * TR)} at ${TR}×`,
          chips: [["50× ◀", 50], [`${TR}×`, TR], ["1000× ▶", 1000]],
          info: `The seismometer's own recording, sped up so you can hear it. Nothing is added. A faster speed raises everything in it together; it exists only where ${melh ? melh.id.split(".")[1] || melh.id : "the station"} recorded.`,
          data: `${melh ? melh.id : "seismic"} HHZ/HHN/HHE` }] },
    ];
    // v0.11: Body v2 replaces the tension, body v1, array and rumble voices in the default mix; they return to the
    // legend only with "compare v1 layers" on
    return v1 ? [body2, ...all] : [body2, ...all.filter((ly) => ly.name === "swarm" || ly.name === "ground")].filter((ly) => ly.rows.length);
  }
  const cooked2 = (v) => typeof v === "number" && isFinite(v);

  const SEE = () => [
    ["gold", "you: the cursor, and the room you are in (the band)"],
    ["faint grey", "not measured"],
    ["dashed line", "a straight line in the GNSS file: not measured"],
    ["◎", "a trace"],
    ["map", "the quakes on screen, fading with age"],
    ["latent map", "one dot per recorded minute · colour = group · ring = unusual"],
  ];

  // ── hold: one module-level hold, released on EVERY path (dark_ocean / re_wilding legend.js) ──
  function startHold(el, row, value) {
    if (HELD || !api) return;
    HELD = { el, layer: row.layer, qty: row.qty, value };
    el.classList.add("holding");
    host.querySelector(".lg-held").textContent = `◆ holding: ${row.name} → ${el.textContent}`;
    api.send("legend", { layer: row.layer, qty: row.qty, value, hold: 1 });
  }
  function releaseHold() {
    if (!HELD) return;
    const h = HELD; HELD = null;                      // cleared FIRST: exactly one release per hold
    h.el.classList.remove("holding");
    if (host) host.querySelector(".lg-held").textContent = "";
    if (api) api.send("legend", { layer: h.layer, qty: h.qty, value: h.value, hold: 0 });
  }
  function bindHold(el, row, value) {
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (_) {}
      startHold(el, row, value);
    });
    el.addEventListener("lostpointercapture", releaseHold);
    el.addEventListener("keydown", (e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); startHold(el, row, value); } });
    el.addEventListener("keyup", (e) => { if (e.key === " " || e.key === "Enter") releaseHold(); });
  }
  window.addEventListener("pointerup", releaseHold, true);
  window.addEventListener("pointercancel", releaseHold, true);
  window.addEventListener("blur", releaseHold);
  document.addEventListener("visibilitychange", () => { if (document.hidden) releaseHold(); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") { if (HELD) releaseHold(); else closeTip(); } }, true);
  window.addEventListener("pointermove", (e) => {
    if (!HELD) return;
    const r = HELD.el.getBoundingClientRect();
    if (e.clientX < r.left - SLOP || e.clientX > r.right + SLOP || e.clientY < r.top - SLOP || e.clientY > r.bottom + SLOP) releaseHold();
  }, true);

  // ── the (i) popover ──
  function openTip(btn, pin) {
    const tip = host.querySelector(`.ltip[data-k="${btn.dataset.k}"]`);
    host.querySelectorAll(".ltip.on").forEach((t) => t !== tip && t.classList.remove("on"));
    host.querySelectorAll(".linfo.on").forEach((t) => t !== btn && t.classList.remove("on"));
    tip.classList.add("on"); btn.classList.add("on");
    if (pin) PIN = btn.dataset.k;
  }
  function closeTip() { if (!host) return; PIN = null; host.querySelectorAll(".ltip.on,.linfo.on").forEach((t) => t.classList.remove("on")); }
  document.addEventListener("pointerdown", (e) => { if (PIN && host && !e.target.closest(".ltip") && !e.target.closest(".linfo")) closeTip(); });

  // ── panel ──
  function setOpen(open) {
    if (open && !isOpen()) render();                 // fresh "now" chips and the current room's modes, every time it opens
    document.body.classList.toggle("lg-open", open);
    try { localStorage.setItem(LS_OPEN, open ? "1" : "0"); } catch (_) {}
    if (!open) releaseHold();
    if (api && api.onToggle) api.onToggle(open);
  }
  const isOpen = () => document.body.classList.contains("lg-open");

  function render() {
    if (!host || !api) return;
    const L = layers();
    const rowHtml = (r) => `
        <div class="lrow" data-k="${r.key}">
          <div class="lhead"><span class="lname">${r.name === "θ" ? '<i class="sym">θ</i>' : esc(r.name)}</span><span class="lto">· ${esc(r.to)}</span>
            <button class="linfo" data-k="${r.key}" aria-label="what this means">i</button></div>
          ${r.range ? `<div class="lrange">${esc(r.range)}</div>` : ""}
          <div class="lchips">${r.chips.map((c, j) => `<button class="lchip" data-k="${r.key}" data-c="${j}">${esc(c[0])}</button>`).join("")}</div>
          <div class="ltip" data-k="${r.key}"></div>
        </div>`;
    const hear = L.map((ly) => `<div class="llay">${esc(ly.name.toUpperCase())}<span class="lepi" title="${esc(epiTitle(ly.epi || ""))}">${esc(ly.epi || ly.pair || "")}</span></div>${ly.rows.map(rowHtml).join("")}`).join("");
    const cat = api.catalogue ? api.catalogue() : [];
    const go = cat.length ? cat.map((c, j) => `<button class="lchip lgo-chip" data-j="${j}">${esc(c.label)}<small>${esc(c.sub || "")}</small></button>`).join("")
                          : `<span class="lrange">nothing loaded yet</span>`;
    host.innerHTML = `<div class="dock-h"><h2>PERCEPTUAL LEGEND</h2><button class="dock-x" id="lgp-close" title="close the legend (L)">✕ close (L)</button></div>
      <div class="lsec" data-sec="go">catalogue · real moments (click = go there)<span class="lchev">▾</span></div><div class="lbody"><div class="lgo">${go}</div></div>
      <div class="lsec" data-sec="hear">pick a moment, then hold a chip to hear the difference<span class="lchev">▾</span></div>
      <div class="lbody"><div class="lg-held" role="status" aria-live="polite"></div>${hear}</div>
      <div class="lsec" data-sec="see">see<span class="lchev">▾</span></div><div class="lbody lsee">${SEE().map((x) => `<div><b>${esc(x[0])}</b> <span>· ${esc(x[1])}</span></div>`).join("")}</div>`;
    // the popovers' text goes in with textContent only (C5 §19.6)
    for (const ly of L) for (const r of ly.rows) {
      const tip = host.querySelector(`.ltip[data-k="${r.key}"]`);
      tip.textContent = r.info;
      const d = document.createElement("div"); d.className = "ldata"; d.textContent = `in the data: ${r.data}`; tip.appendChild(d);
    }
    host.querySelector("#lgp-close").onclick = () => setOpen(false);
    host.querySelectorAll(".lsec").forEach((h) => {
      const k = "svk_lsec_" + h.dataset.sec;
      try { if (localStorage.getItem(k) === "1") h.classList.add("closed"); } catch (_) {}
      h.addEventListener("click", () => { h.classList.toggle("closed"); try { localStorage.setItem(k, h.classList.contains("closed") ? "1" : "0"); } catch (_) {} });
    });
    host.querySelectorAll(".linfo").forEach((b) => {
      b.addEventListener("mouseenter", () => { if (!PIN) openTip(b, false); });
      b.addEventListener("focus", () => { if (!PIN) openTip(b, false); });
      b.addEventListener("mouseleave", () => { if (!PIN) setTimeout(() => { const tip = host.querySelector(`.ltip[data-k="${b.dataset.k}"]`); if (!PIN && tip && !tip.matches(":hover")) { tip.classList.remove("on"); b.classList.remove("on"); } }, 250); });
      b.addEventListener("click", (e) => { e.stopPropagation(); PIN === b.dataset.k ? closeTip() : openTip(b, true); });
    });
    host.querySelectorAll(".ltip").forEach((t) => t.addEventListener("mouseleave", () => { if (!PIN) { t.classList.remove("on"); const b = host.querySelector(`.linfo[data-k="${t.dataset.k}"]`); b && b.classList.remove("on"); } }));
    host.querySelectorAll(".lrow .lchip").forEach((el) => {
      const row = L.flatMap((ly) => ly.rows.map((r) => ({ ...r, layer: ly.layer }))).find((r) => r.key === el.dataset.k);
      const v = row.chips[+el.dataset.c][1];
      // a single-mode chip: qty 10 + m, the mode at full strength (value 1)
      const qtyOf = row.chips[+el.dataset.c][2];              // a chip may carry its own qty (the array's components)
      if (row.key === "b2modes") bindHold(el, { ...row, qty: v }, 1);
      else if (qtyOf != null) bindHold(el, { ...row, qty: qtyOf }, v);
      else bindHold(el, row, v);
    });
    host.querySelectorAll(".lgo-chip").forEach((el) => el.addEventListener("click", () => { const c = cat[+el.dataset.j]; if (c && api.goto) api.goto(c); }));
  }
  function epiTitle(e) {
    return e === "measurement" ? "measured by an instrument (GNSS, seismometer)" : e === "inference" ? "a claim derived from measurements (IMO located it and estimated its size)"
      : e === "evidence" ? "the recording itself, played back" : "";
  }

  function init(opts) {
    api = opts;
    host = document.getElementById("lgp");
    if (!host) { host = document.createElement("div"); host.id = "lgp"; document.body.appendChild(host); }
    tab = document.getElementById("lgp-tab");
    if (!tab) { tab = document.createElement("div"); tab.id = "lgp-tab"; tab.textContent = "legend · L"; tab.title = "open the legend (L)"; document.body.appendChild(tab); }
    tab.onclick = () => setOpen(true);
    document.addEventListener("keydown", (e) => {
      if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
      if ((e.key === "l" || e.key === "L") && !e.metaKey && !e.ctrlKey && !e.altKey) setOpen(!isOpen());
    });
    render();
    let open = false; try { open = localStorage.getItem(LS_OPEN) === "1"; } catch (_) {}
    if (open) setOpen(true);
  }
  return { init, render, open: () => setOpen(true), close: () => setOpen(false), toggle: () => setOpen(!isOpen()), isOpen,
           release: releaseHold, isHolding: () => !!HELD, layers };
})();
