// dark_svartsengi · PERCEPTUAL LEGEND (manual C5 §19; modelled on dark_ocean/viz/legend.js). W3.
//
// A LEFT-DOCKED panel (key L, and its own edge tab) so the timeline stays in view while you listen.
// THE FACE IS A MAP LEGEND: each row is NAME → what you hear, one line of range in the data, an epistemic tag
// (measurement · inference · evidence), then the chips. Meaning lives in the (i): a popover (hover opens it, click pins
// it, Escape or a click outside closes it), written with textContent only.
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
    const body2 = { layer: 6, name: "body", pair: "the volcano's own modes", info: "one bowed body whose 36 modes are found in the data of the room you are in",
      rows: [
        { key: "b2theta", qty: 0, name: "where in the cycle (θ)", to: "the balance across the modes: a seesaw", epistemic: "measurement",
          range: B2 && isFinite(B2.theta) ? (rn.room && rn.room.kind === "regime" ? `0 the regime's lowest frequency index · 1 its highest · now ${B2.theta.toFixed(2)}`
            : `0 just after a fall · 1 when the wait is longer than any before · now ${B2.theta.toFixed(2)}`) : "",
          chips: [["just after (0)", 0], ["halfway (0.5)", 0.5], ["full (1)", 1], ...(B2 && cooked2(B2.theta) ? [[`now (${B2.theta.toFixed(2)})`, B2.theta]] : [])],
          info: "How long the ground has waited since the last fall, as a seesaw across the body's modes: just after a fall the low modes lead; as the wait grows the balance tips. It is fully tipped only when the wait is longer than any before. In the vent's regime rooms it is the minute's place on the frequency index instead.",
          data: "theta = clip(days since the last eruption / the longest earlier interval) in deformation rooms (v0.11.3); the frame's rank on fi in regime rooms" },
        { key: "b2press", qty: 1, name: "how high the ground stands in this room (pressure)", to: "how hard the body is pressed: a brighter, longer room", epistemic: "measurement",
          range: B2 && isFinite(B2.pressure) ? `0 the room's lowest · 1 its highest · now ${B2.pressure.toFixed(2)}` : "",
          chips: [["lowest (0)", 0], ["highest (1)", 1], ...(B2 && cooked2(B2.pressure) ? [[`now (${B2.pressure.toFixed(2)})`, B2.pressure]] : [])],
          info: "Where the ground stands between its lowest and highest in this room. Higher pressure presses the body harder and lengthens the room's echo.",
          data: "pressure = (SKSH_u_ds − the room's min) / (max − min); the frame's energy in regime rooms" },
        { key: "b2bow", qty: 2, name: lab("inflow_rel", "the inflow"), to: "the bow: how hard the body is played", epistemic: "measurement",
          range: BW && Number.isFinite(BW.bow_db) ? `now ${BW.bow_db.toFixed(0)} dB (floor −30 dB)` : BW && BW.gap === 2 ? "now veiled (inflow not measured): the room's usual level" : "",
          chips: [["floor (−30 dB)", -30], ...(BW && Number.isFinite(BW.bow_db) ? [[`now (${BW.bow_db.toFixed(0)} dB)`, BW.bow_db]] : []), ["full (0 dB)", 0]],
          info: "The bow is the inflow: how fast magma is still arriving. Its decay since 2024 is heard as the bow easing off the body.",
          data: "bow_db = 20·log10(inflow_rel), floor −30 for measured low inflow; null where inflow_rel is unknown (sent as NaN, gap 2: veiled at the room's bow_neutral_db)" },
        { key: "b2modes", qty: null, name: "one mode alone", to: "the body taken apart", epistemic: "measurement",
          range: ident ? `${(ident.modes || []).length} modes · comb ${Math.round(SvkCook.combHeard(ident) || 0)} Hz heard` : "",
          chips: top.map(([m, k]) => [`${m.sensor || m.comp || "mode"} ${m.harm ? "h" + m.harm : ""} · ${hz(SvkCook.heardHz(m))}`, 10 + k]),
          info: "Each mode is one sensor's own rhythm found in the data (a GNSS station's direction, or a band of the vent's shaking), moved up to an audible pitch. Hold one to hear it alone. These are the room's three strongest.",
          data: "viz/data/body/identity/<kind>_<id>.json modes[] (freq_hz, amp, ring_s, detune); heard at freq_hz × (1 + detune), the comb octave-folded (comb_render_hz)" },
      ] };
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
      { layer: 2, name: "swarm", pair: "discrete", info: "IMO's catalogue: located, magnitude-estimated claims",
        rows: [
          { key: "rate", qty: 0, name: lab("eq_n"), to: "clicks: a rhythm, then a pitch, then a noise", epistemic: epi("eq_n", "inference"),
            range: R.eq_n ? `${R.eq_n.p50} a day typical · up to ${Math.round(R.eq_n.max)} a day` : "",
            chips: [["4 a second (rhythm)", 4], ["200 a second (pitch)", 200], ["2,000 a second (noise)", 2000]],
            info: "The quakes IMO located, played as clicks at their true rate times the playback speed. Slow swarms are a rhythm; when time is compressed enough the rhythm becomes a pitch; very dense swarms become a band of noise. Brushing the map limits it to the quakes you selected.",
            data: "eq_n, events/eq.json t; rate_play_hz = events per real second × speed" },
          { key: "bells", qty: 4, name: lab("mag", lab("eq_mmax", "magnitude")), to: "a bell per quake of M 2 or more", epistemic: epi("fc_hz", "inference"),
            range: `M2 ≈ ${hz(brune(2) * TR)} · M3 ≈ ${hz(brune(3) * TR)} · M4 ≈ ${hz(brune(4) * TR)}`,
            chips: [["M 2", 2], ["M 3", 3], ["M 4", 4]],
            info: `Each larger quake rings a bell at its corner frequency times ${TR}, so a bigger quake rings lower. The corner frequency is the typical one for that magnitude (an assumed 3 MPa stress drop, ML treated as Mw), not measured from this quake's own record.`,
            data: "mag, fc_hz (Brune, CONTRACT §2.4)" }] },
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
      { layer: 3, name: "ground", pair: "evidence", info: "the real ground motion, audified",
        rows: [{ key: "speed", qty: 0, name: "ground motion at the vent", to: "the recording itself, sped up", epistemic: "evidence",
          range: `0.1–45 Hz × ${TR} → ${hz(0.1 * TR)}–${hz(45 * TR)}; slower is lower, faster is higher · ${covTxt || "only where a waveform exists"}`,
          chips: [["50×", 50], [`${TR}×`, TR], ["1000×", 1000]],
          info: `The seismometer's own recording, played faster so it is audible: at ${TR}× a 2-second earthquake lasts 8 ms. Nothing is added: a gentle high-pass and a limiter only. Changing the speed changes the pitch of everything in it together.`,
          data: `${melh ? melh.id : "seismic"} HHZ/HHN/HHE, wave chunks (counts)` }] },
    ];
    // v0.11: Body v2 replaces the tension, body v1, array and rumble voices in the default mix; they return to the
    // legend only with "compare v1 layers" on
    return v1 ? [body2, ...all] : [body2, ...all.filter((ly) => ly.name === "swarm" || ly.name === "ground")];
  }
  const cooked2 = (v) => typeof v === "number" && isFinite(v);

  const SEE = () => [
    ["timeline", "drag to move, wheel or pinch to zoom; the span on screen picks the level; gold is you (cursor and playhead); hatching = no waveform; dashed = not measured"],
    ["sequence", "ground height at three GNSS stations (SKSH bold); dashed lines at the level each eruption began; small rings = one-day spikes in the file; quakes per day as a colour strip; WAIT = days since the ground last fell"],
    ["cycle · day", "quakes by time and depth, size = magnitude, rings at M 2 or more; the four bands of shaking; tilt"],
    ["hours · minutes", "spectrogram and waveform of the vent station; catalogue ticks above, the station's own detections below"],
    ["array", "the three GNSS stations' velocity, north (dashed) / east (dotted) / up (solid), each on its own range; shaded = not measured"],
    ["map", "quakes on screen, fading with age before the cursor; drag a box to choose which quakes the Swarm plays"],
    ["latent map", "one dot per recorded minute, placed by how its shaking sounds; colour = group, ring = unusual; click to hear that minute"],
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
    const body = L.map((ly) => `
      <div class="lsec" data-sec="${ly.name}">${esc(ly.name)}<span class="lpair">${esc(ly.pair)}</span><span class="lchev">▾</span></div>
      <div class="lbody"><div class="llay">${esc(ly.info)}</div>${ly.rows.map((r) => `
        <div class="lrow" data-k="${r.key}">
          <div class="lhead"><span class="lname">${esc(r.name)}</span><span class="larrow">→</span><span class="lto">${esc(r.to)}</span>
            <span class="lepi lepi-${esc(r.epistemic)}" title="${esc(epiTitle(r.epistemic))}">${esc(r.epistemic)}</span>
            <button class="linfo" data-k="${r.key}" aria-label="what this means">i</button></div>
          ${r.range ? `<div class="lrange">${esc(r.range)}</div>` : ""}
          <div class="lchips">${r.chips.map((c, j) => `<button class="lchip" data-k="${r.key}" data-c="${j}">${esc(c[0])}</button>`).join("")}</div>
          <div class="ltip" data-k="${r.key}"></div>
        </div>`).join("")}</div>`).join("");
    const cat = api.catalogue ? api.catalogue() : [];
    const go = cat.length ? cat.map((c, j) => `<button class="lchip lgo-chip" data-j="${j}">${esc(c.label)}<small>${esc(c.sub || "")}</small></button>`).join("")
                          : `<span class="lrange">nothing loaded yet</span>`;
    host.innerHTML = `<button id="lgp-close" title="close the legend (L)">✕</button>
      <h2>LEGEND</h2>
      <div class="lsub">hold a chip to hear one change on your own point; let go to return</div>
      <div class="lg-held" role="status" aria-live="polite"></div>
      ${body}
      <div class="lsec" data-sec="go">go to<span class="lchev">▾</span></div><div class="lbody"><div class="lgo">${go}</div></div>
      <div class="lsec" data-sec="see">see<span class="lchev">▾</span></div><div class="lbody lsee">${SEE().map((s) => `<div><b>${esc(s[0])}</b> <span>· ${esc(s[1])}</span></div>`).join("")}</div>`;
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
