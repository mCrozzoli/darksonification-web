/* legend.js — dark_re_wilding PERCEPTUAL LEGEND (how the data maps to sound, and how the plots
 * are encoded). Manual C5 §19, modelled on dark_skyr. A left-dockable panel over a dedicated
 * /dark_legend channel (the bridge relays {type:"legend",...}):
 *   Tier 1  catalogue — REAL exemplar months (argmax per index, per-season peak);
 *           click = hear + see + select that month through the normal pipeline. (cmd "drv".)
 *   Tier 2  HEAR · by layer — the tier rebuilt 2026-09-25, grouped DRONE / CLAVE / ARP so the
 *           listener knows what to attend to. HOLD a chip and you hear YOUR OWN POINT with
 *           EXACTLY ONE QUANTITY pushed to its extreme, everything else held at your values;
 *           release returns you. (cmds "hold" / "release" / "probe".)
 *   SEE     encodings — the static visual key (colour, size, rings, views).
 *
 * THE FACE IS A MAP LEGEND (Miguel, 2026-09-26: "too verbose ... too overly complicated ... if
 * one thinks about legend in maps, they are extremely clear, and minimalistic"). The audience is
 * GENERAL and the panel is for ANCHORING: re-centring ear and eye when they are saturated. So
 * every row reads the same way — NAME · plain meaning, at most ONE line of perceptual range
 * (Hz, ticks, seconds) where that anchors, then the chips, which are the symbols. No prose, no
 * column names, no statistics jargon on the face. Each (i) is two or three short sentences for a
 * listener — what it means in the soundscape, what you hear when it changes — and ends on ONE
 * small line "in the data: <column>", which is where the dataset column now lives (2026-09-25
 * asked that every row name its feature; 2026-09-26 moved it off the face into the (i)).
 * EVERYTHING TECHNICAL that used to be on the face or in an (i) — row definitions, measured
 * figures, "read twice", blocked conditions, the old (i) paragraphs verbatim — lives in
 * lab/LEGEND_REFERENCE.md, the researcher reference behind this panel. Put new measurements
 * THERE, not here.
 *
 * WHY TIER 2 WAS REBUILT. The old tier offered "one index, less ↔ more" and played two REAL
 * WINDOWS that differ in all sixteen indices, so a chip never isolated the thing it named.
 * Worse, the body's theta ranks a mean of |differences|, so pushing an index to EITHER extreme
 * moves the body the SAME WAY — the axis is folded in half, which is why "less" and "more"
 * sounded like the same thing. Measured (400 rows x 16 columns): the body's reading is FOLDED
 * on 16 of 16 columns (0.052 down / 0.981 up); the clave's pulsaret formant ranks a MEAN and is
 * therefore SIGNED on 16 of 16 (0.994 / 0.999).
 *
 * WHAT THE INSTRUMENT ACTUALLY READS — three row statistics and one index, not sixteen:
 *   drone  theta -> all 35 mode gains, comb decay, level ....... rank of GRADIENT (shipped)
 *   clave  tempo  (0.8–9 Hz) .................................. rank of VARIANCE
 *   clave  colour (841–1747 Hz pulsaret formant) ............... rank of the MEAN of sixteen
 *   clave  metre  (accent every 2–7 ticks) ..................... rank of GRADIENT (the twin)
 *   arp    density (note gap 0.49 -> 0.17 s at L1) ............. n_species_analysed
 *   arp    pitch   (200–2000 Hz, log) .......................... rarity WITHIN your selection
 *   arp    beating (detune on an unsure note) .................. BirdNET confidence
 *
 * EVERY ROW NAMES ITS DATASET COLUMN (Miguel, 2026-09-25: "the ARP could be more clear about
 * the data features like ACI Ht or the name in the dataset"). A researcher must be able to go
 * from a row in this panel to a column in data/wildnings_air_L1.csv. Since 2026-09-26 the
 * column is the LAST line of the row's (i) ("in the data: ..."), not a line on the face.
 *
 * INTERVENTION IS NOT OBSERVATION (the full per-row figures for both are in
 * lab/LEGEND_REFERENCE.md; the panel keeps only the plain consequence). Pushing ACI to its top brightens
 * the tick by 187 Hz, yet ACI PREDICTS the colour at rho +0.007. Both are true and they answer
 * different questions: "what if I pushed it" versus "what does a bright tick tell me". A row
 * that collapses to one of them lies. The mirror of it matters too: interventionally all sixteen
 * columns are near-equal (295–360 Hz end to end is the whole spread, because the colour is the
 * mean of sixteen equally weighted columns), so the chips teach a MECHANISM, not a privileged
 * cause. Nine of the sixteen have no chip; which seven do is findings/04's ecological choice.
 *
 * Page usage:  LEG.init({ send, months, current, channel, select, onToggle, soundBtn, onBridge })
 *   send(obj)      -> JSON over the page WS (the page owns the socket)
 *   months()       -> [{key,year,month,drv:{aci,...},nsp}] (L0 months, for the catalogue)
 *   current()      -> the key the sonification is on (used to re-probe when the point moves)
 *   select(key,o)  -> host shows + selects that month
 *   onBridge?      -> if the host routes {type:"legend_preview"|"legend_probe"} it may call
 *                     LEG.onBridge(m) itself; see hookSocket() for the fallback.
 */
window.LEG = (function () {
  const MON = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  // ---- tier 1 ---------------------------------------------------------------------------
  // The catalogue plays the REAL record-holding month per index. Unchanged: these keys are
  // the L0 month `drv` keys, not the tier-2 row ids.
  const CAT_FEATURES = [
    ["aci", "most restless"], ["bright", "most even"], ["balance", "most bird"],
    ["bioenergy", "fullest chorus"], ["anthroenergy", "loudest (human)"],
    ["nbpeaks", "most events"], ["nsp", "most species"],
  ];
  const SEASON = { spring: [3, 4, 5], summer: [6, 7, 8], autumn: [9, 10, 11], winter: [12, 1, 2] };

  // ---- tier 2: the rows, grouped by layer -----------------------------------------------
  // `id` IS the contract's row-id and the closed vocabulary the bridge accepts — 15 strings,
  // never guessed, never composed at the call site.
  // THE FACE of a row (map-legend rule, 2026-09-26): `name` · `what` (plain words), then at most
  // ONE small line `tag` — a perceptual range that anchors the ear (Hz, ticks, seconds) — then
  // the chips `lo` / `hi`, which are the legend's symbols. Nothing else is printed.
  // `info`  the (i): two or three short sentences for a general listener. A string, or a
  //         function of the drone reading ("gradient" | "variance") where the truth depends on it.
  // `data`  the dataset column(s), printed as the (i)'s last small line "in the data: ...".
  // `deaf`  the tick barely follows this column in normal listening (it does not PREDICT the
  //         colour), although a push still moves it. Ported from iris (viz/index.html, search
  //         "deaf"): the label block drops to .55 and the one-line tag says why; the CHIPS stay
  //         undimmed, because under a PUSH the row is alive.
  // `weak`  per-DIRECTION, record-wide: a direction that is barely audible across the record.
  //         Dims the chip and rides on its hover. A probe reply overrides it for the point in front
  //         of the reader.
  // `twin`  under that reading this row and its twin are ONE push heard in two layers
  //         (drone.gradient <-> clave.metre). No longer printed as a marker; kept as data and said
  //         in plain words in both (i)s.
  // The measured figures, the old (i) paragraphs and the removed face lines: lab/LEGEND_REFERENCE.md.
  const IDX16 = "the 16 acoustic index columns (ACI_mean … MED_mean)";

  const ROWS = [
    // ============================ DRONE ============================
    { id: "drone.gradient", layer: "drone", name: "gradient", what: "how fast this window is changing",
      twin: "gradient", lo: "slowest ◀", hi: "fastest ▶",
      info: s => "How quickly the soundscape is changing from one moment to the next. " +
        (s === "gradient"
          ? "The hum follows this: a fast-changing moment shifts which of its tones ring. " +
            "The tick's accents follow it too, so you hear both move."
          : "The tick's accents follow it; the hum follows it only on the gradient reading " +
            "(SOUND · DRONE READING). “= yours, other reading” plays your own moment with the " +
            "hum switched to it."),
      data: "change from the neighbouring windows, across " + IDX16 },
    // `what` is Miguel's kept line, word for word (screenshot markup 2026-09-26); the (i)'s
    // first sentence says what "its sixteen" are.
    { id: "drone.variance", layer: "drone", name: "variance", what: "how much its sixteen disagree",
      lo: "most alike ◀", hi: "most divided ▶", same: true,
      info: s => "How much this moment's sixteen acoustic measures disagree — some high, some low. " +
        "The tick's speed always follows it" +
        (s === "variance" ? ", and so does the hum." : "; the hum follows it only on the variance " +
          "reading (SOUND · DRONE READING). “= yours, other reading” plays your own moment " +
          "with the hum switched to it."),
      data: "spread across " + IDX16 },

    // ============================ CLAVE ============================
    { id: "clave.tempo", layer: "clave", name: "tempo", what: "variance",
      tag: "0.8 – 9.0 ticks per second", lo: "slowest ◀", hi: "fastest ▶",
      info: "How fast the woodblock ticks. It ticks slowly when this moment's measures agree and " +
        "fast when they disagree — the variance row above.",
      data: "spread across " + IDX16 },
    { id: "clave.colour", layer: "clave", name: "colour", what: "mean",
      tag: "841 – 1747 Hz", lo: "woodiest ◀", hi: "glassiest ▶",
      info: "The pitch of the tick, from woody to glassy. It follows the mean — the average of all " +
        "this moment's acoustic measures — so every measure pushes it the same way. Nothing else " +
        "in the sound follows it.",
      data: "average of " + IDX16 },
    { id: "clave.metre", layer: "clave", name: "metre", what: "gradient",
      tag: "accent every 2 – 7 ticks", twin: "gradient",
      lo: "loosest ◀ (7)", hi: "tightest ▶ (2)",
      info: s => "Which tick gets the accent — like a time signature. It follows how fast the " +
        "soundscape is changing" +
        (s === "gradient" ? ", the same thing the hum follows now, so a push here moves both." : "."),
      data: "change from the neighbouring windows, across " + IDX16 },

    // --- per index, under the clave's colour ---
    { id: "clave.index.aci", layer: "clave", index: true, name: "ACI", what: "how much the sound jumps around", deaf: true,
      // the one tag that is not a range: it says why the label is dimmed, and that the chips
      // still work (a hold moves the tick 335 Hz end to end - LEGEND_REFERENCE §3.3)
      tag: "barely heard unless you hold a chip",
      lo: "steadiest ◀", hi: "most restless ▶",
      info: "How much the sound jumps from instant to instant: a steady wash is low, constant change " +
        "is high. Holding a chip moves the tick's colour clearly, but in normal listening the tick " +
        "barely follows it.",
      data: "ACI_mean" },
    { id: "clave.index.bright", layer: "clave", index: true, name: "Ht", what: "evenness over time",
      lo: "most peaked ◀", hi: "most even ▶",
      weak: { hi: "barely audible: most moments already sit near the top" },
      info: "How evenly the sound is spread through time. Low = a few loud events against quiet; " +
        "high = an even, busy sound with nothing standing out.",
      data: "Ht_mean" },
    { id: "clave.index.balance", layer: "clave", index: true, name: "NDSI", what: "birds against machines",
      lo: "most machine ◀", hi: "most bird ▶",
      weak: { lo: "barely audible: most moments already sit near the bottom" },
      info: "The balance between nature and machines. Low = traffic and machines dominate; " +
        "high = birds and insects do.",
      data: "NDSI_mean" },
    { id: "clave.index.bioenergy", layer: "clave", index: true, name: "Bio", what: "energy in the birdsong range",
      hi: "fullest chorus ▶",
      // NO LOW CHIP - see dirList. Pushing Bio DOWN clears a semitone on 0.0% of points,
      // because 79.3% of windows already sit in the bottom 2% of that column.
      info: "How much sound sits in the birdsong range (about 1–10 kHz); the dawn chorus is at the " +
        "top. Almost every moment is already near the bottom, so there is only a “fullest chorus” chip.",
      data: "BioEnergy_mean" },
    { id: "clave.index.nbpeaks", layer: "clave", index: true, name: "NBPEAKS", what: "how many separate voices",
      lo: "fewest events ◀", hi: "most events ▶",
      info: "How many distinct peaks the sound has across its pitches — roughly, how many separate " +
        "voices. High = many separate calls rather than one wash.",
      data: "NBPEAKS_mean" },
    { id: "clave.index.bi", layer: "clave", index: true, name: "BI", what: "birdsong above the background",
      lo: "least ◀", hi: "most ▶",
      info: "How far sound in the birdsong range rises above the background. Of all the measures, " +
        "this is the one the tick's colour follows most closely.",
      data: "BI_mean" },

    // ============================ ARP ============================
    { id: "arp.density", layer: "arp", name: "density", what: "how many species",
      // qualitative on purpose: the note gap differs by level (0.49 -> 0.17 s by day, 0.18 -> 0.12 s
      // by month), so a seconds range would be false on half the views (LEGEND_REFERENCE §3.3)
      tag: "few species = slow notes · many = quick", lo: "sparsest ◀", hi: "richest ▶",
      info: "How many bird species BirdNET heard here, per minute of audio it could read. It sets how fast " +
        "the chord's notes arrive: more species, faster. Holding a chip changes only that speed; your notes stay yours.",
      // the corrected column (2026-09-29): n_species_mean counted every minute BirdNET could not
      // decode as a minute with no species (dev/precompute/birdnet_nsp_fix.py)
      data: "n_species_analysed" },
    { id: "arp.pitch", layer: "arp", name: "pitch", what: "how rare each species is", verb: "isolate",
      tag: "200 – 2000 Hz · rare = high",
      lo: "commonest note only ◀", hi: "rarest note only ▶",
      dirs: { lo: "only_lo", hi: "only_hi" },
      info: "Each species' note is set by how rare it is in your selection: rare species sound high, " +
        "common ones low. These chips play just one of your notes — the commonest or the rarest.",
      data: "top_species_k*_common, counted within your selection" },
    { id: "arp.beating", layer: "arp", name: "beating", what: "how sure BirdNET is",
      tag: "unsure notes waver · sure notes ring clean", lo: "least sure ◀", hi: "most sure ▶",
      info: "How confident BirdNET is about each species it names. An unsure note splits into a " +
        "wavering pair with a breath of noise; a sure one rings clean.",
      data: "top_species_k*_conf_mean" },
  ];

  // The three blocks, in Miguel's order. The face shows the NAME only; the (i) says, in a
  // sentence or two, what that layer is. (The old one-line subs and layer (i)s: LEGEND_REFERENCE.)
  const LAYERS = [
    { key: "drone", name: "DRONE",
      info: s => "The low, continuous hum under everything. It follows " +
        (s === "variance" ? "how much the soundscape's measures disagree" : "how fast the soundscape is changing") +
        " — listen for which of its tones ring, and how strongly." },
    { key: "clave", name: "CLAVE",
      info: "A woodblock tick beside the hum. Its speed, its pitch and its accents each follow a " +
        "different side of the soundscape." },
    { key: "arp", name: "ARP",
      info: "A chord of tuned bars, one note per bird species BirdNET detected. A note stands for a " +
        "species, not a single bird." },
  ];

  // THE VIEWS THAT CANNOT HOST THE TIER. biplot sends a bare "y|m" month key, which at L0
  // resolves to an equal-power MEAN of the month's four diel rows: not a terrain row, no
  // 16-vector, and a theta off the rank grid. The bridge blocks every row there and says so;
  // this is the same reason said client-side, so the panel is honest before the first round trip.
  // spectro and mfcc LEFT this list 2026-09-26: a hovered hour sends its month × diel window,
  // which is a real terrain row. Where a month has no index window for that hour (air: night
  // in Dec 2025 / Jan 2026) they send the bare month instead, and the bridge's own block — the
  // same sentence — covers it per point.
  const MONTHKEY_VIEWS = { "biplot.html": 1 };
  // Printed ONCE at the top of the tier on these views (and on each chip's hover), never per row.
  // The long form ("a month is an average of its four windows — the push needs one real
  // window") is the bridge's own block sentence and LEGEND_REFERENCE.md's.
  const MONTHKEY_WHY = "this view plays whole months — to hear one change, use any other view";
  // THE BRIDGE'S BLOCK SENTENCES, SAID PLAINLY ON THE FACE. bridge.py (_rw_row_block, RW_PUSH_WHY)
  // writes its reasons for a researcher - "not a terrain row", "the push side file is out of
  // step ... (re-run dev/precompute/rw_push.py)". Those must not be printed to a general
  // listener, and this file cannot change them at the source. So the FACE (the reason line and
  // the chip's hover) shows a short label, and the bridge's exact sentence stays on the chip as
  // data-why, untouched. Anything not listed here - "no point is selected yet", "the arp fader
  // is at 0", MONTHKEY_WHY - is already plain and passes through. The full table of sentence ->
  // label is in lab/LEGEND_REFERENCE.md §3.1.
  function plainWhy(w) {
    const s = String(w == null ? "" : w);
    // a bare "y|m" month key. On spectro / mfcc that means no hour is sounding yet, or the hour
    // under the cursor has no measured window (air, night, Dec 2025 / Jan 2026).
    if (/^this view sends a month\b/.test(s))
      return HOUR_VIEWS[here()] ? "hover an hour that has measurements" : "a whole month — pick one time of day";
    if (/not a terrain row|could not be evaluated/.test(s)) return "this point can't be played";
    if (/push side file|drone tables|push tier|^unknown row$|has no direction/.test(s)) return "sound preview unavailable";
    if (/has no BirdNET chord/.test(s)) return "no bird chord here";
    if (/chord has one note/.test(s)) return "only one note here";
    return s;
  }

  let opts = {}, open = false, muted = false, badgeEl = null, panel = null;
  let PROBE = null;                  // last {type:"legend_probe"} reply: per-row numbers + blocks
  // RESEARCHER MODE (TASKS P21). The minimal face (2026-09-26) dropped the per-point readout - what
  // each push does HERE, what the column predicts in this selection, the column's raw values at
  // your point - and LEGEND_REFERENCE §3.2 kept its wording "for a separate researcher mode, not
  // the (i)". This is that mode: off by default (the face is unchanged), one quiet toggle line,
  // remembered. Every number comes from the probe reply the bridge already sends.
  const LS_RESEARCH = "rewild_legend_research";
  let RESEARCH = false;
  try { RESEARCH = localStorage.getItem(LS_RESEARCH) === "1"; } catch (e) {}
  let LASTPREV = null;               // last {type:"legend_preview"} reply (kept for debugging)

  const CSS = `
  /* border-box (2026-10-01): 471 px wide as before (430 of content + 2 x 20 padding + 1 border), and the height is
     now the window's - with the padding outside it the panel was 40 px taller, and its last lines never scrolled
     into view */
  #rwleg{ position:fixed; top:0; left:0; box-sizing:border-box; width:471px; height:100%; z-index:40; display:none;
    background:var(--rw-legend-bg); border-right:1px solid var(--rw-legend-edge); overflow:auto; padding:16px 20px 24px;
    font:var(--ds-font-size)/1.5 var(--ds-font-ui); color:var(--txt,#c8d0ee); }
  /* the panel's whole width: 430 + 2 x 20 padding + 1 border. It was 430, and the first 41 px of every view
     sat under the docked legend (found with P44, 2026-09-30: the scatter's DAWN caption, the biplot's y axis) */
  #rwleg.open{ display:block; } body.rwleg-open #wrap{ margin-left:471px; }
  /* the legend's own edge tab, mirroring the sidebar's on the right: the panel is always
     reachable without hunting for a header button, and it says what it is */
  #rwleg-tab{ position:fixed; top:50%; left:0; z-index:39; transform:translateY(-50%);
    writing-mode:vertical-rl; font:inherit; font-size:10px; letter-spacing:.14em;
    color:var(--dim,#67708c); background:var(--panel,#10142a); cursor:pointer;
    border:1px solid var(--line,#222948); border-left:0; border-radius:0 5px 5px 0;
    padding:10px 3px; }
  #rwleg-tab:hover{ color:var(--txt,#c8d0ee); }
  body.rwleg-open #rwleg-tab{ display:none; }
  #rwleg h2{ font-size:13px; letter-spacing:.2em; color:var(--rw-txt-hi); margin:0 0 4px; }
  #rwleg .lsub{ color:var(--dim,#67708c); font-size:11px; margin-bottom:14px; }
  #rwleg .lsec{ font-size:10px; letter-spacing:.15em; text-transform:uppercase; color:var(--dim,#67708c);
    margin:16px 0 7px; cursor:pointer; user-select:none; display:flex; align-items:center; gap:8px;
    border-top:1px solid var(--line,#222948); padding-top:11px; }
  #rwleg .lsec:hover{ color:var(--txt,#c8d0ee); }
  #rwleg .lsec .lchev{ margin-left:auto; font-size:10px; opacity:.7; transition:transform .18s ease; }
  #rwleg .lsec.closed .lchev{ transform:rotate(-90deg); }
  #rwleg .lgrid{ display:flex; flex-wrap:wrap; gap:7px; }
  #rwleg .lchip{ background:var(--rw-chip); border:1px solid var(--rw-chip-line); border-radius:7px; padding:6px 9px;
    font-size:11px; color:var(--txt,#c8d0ee); cursor:pointer; user-select:none; -webkit-user-select:none; }
  #rwleg .lchip:hover{ border-color:var(--rw-chip-line-hi); } #rwleg .lchip small{ color:var(--dim,#67708c); }
  #rwleg .lchip.holding{ background:var(--rw-chip-hold); border-color:var(--rw-chip-hold-line); color:var(--rw-txt-hi); }

  /* ---- TIER 2, GROUPED BY LAYER -------------------------------------------------------
     A LAYER HEADING must read as a heading and not as another row: white, 12px, wide
     tracking, a rule above it, and its (i) - no sub line since 2026-09-26. Everything
     inside a block is 9.5-11.5px, so the hierarchy is legible at a glance rather than by
     reading. Nothing in here has a fixed pixel width: the label column is minmax(0,1fr) and
     the chips flex-wrap, so the tier reflows inside the 390px of content the docked panel
     has and NEVER scrolls sideways. */
  #rwleg .lhlayer{ display:grid; grid-template-columns:minmax(0,1fr) 16px; gap:7px;
    align-items:start; margin:16px 0 7px; padding-top:10px; border-top:1px solid var(--rw-ctl-line); }
  #rwleg .lhlayer .n{ font-weight:600; font-size:12px; letter-spacing:.24em; color:var(--rw-txt-hi); }
  #rwleg .lhlayer .s{ display:block; font-weight:400; font-size:10px; letter-spacing:0;
    color:var(--dim,#67708c); margin-top:2px; }
  #rwleg .lhsub{ font-weight:600; font-size:9.5px; letter-spacing:.12em; text-transform:uppercase;
    color:var(--rw-label); margin:12px 0 1px; }
  #rwleg .lhsubnote{ color:var(--dim,#67708c); font-size:10px; line-height:1.45; margin:0 0 5px; }
  #rwleg .lhrow{ margin:0 0 7px; padding:0 0 6px; border-bottom:1px solid var(--rw-row-line); }
  #rwleg .lhtop{ display:grid; grid-template-columns:minmax(0,1fr) 16px; gap:7px; align-items:start; }
  #rwleg .lhname{ font-size:11.5px; line-height:1.4; min-width:0; }
  #rwleg .lhname b{ font-weight:600; color:var(--rw-txt-hi); }
  #rwleg .lhname i{ font-style:normal; color:var(--txt,#c8d0ee); }
  /* .lhcol / .lhtwin / .lhverb / .lhnote / .lhsubnote are NO LONGER RENDERED (2026-09-26: the
     column moved to the (i)'s last line, the twin marker, the isolate badge and the prose notes
     left the face - see lab/LEGEND_REFERENCE.md). The rules stay so nothing that styles or
     queries them breaks. .lhtag is the row's ONE optional line (the perceptual range). */
  #rwleg .lhcol{ display:block; font-size:9.5px; line-height:1.45; color:var(--dim,#67708c);
    word-break:break-word; }
  #rwleg .lhtag{ display:block; font-size:9px; line-height:1.5; letter-spacing:.04em;
    color:var(--rw-label); word-break:break-word; }
  #rwleg .lhtwin{ display:block; font-size:9px; line-height:1.5; color:var(--rw-twin); }
  #rwleg .lhchips{ display:flex; flex-wrap:wrap; gap:5px; margin-top:5px; }
  #rwleg .lhchips .lchip{ font-size:10.5px; padding:4px 7px; border-radius:6px;
    touch-action:none; }        /* touch-action: a few px of drag must not scroll-cancel a hold */
  #rwleg .lhchips .lchip.mid{ border-style:dashed; }
  #rwleg .lhchips .lchip.iso{ border-color:var(--rw-iso-line); }
  /* a direction measured at or under the noise floor: dimmed per chip, per point, from the
     bridge's own reply where there is one and from the record-wide measurement until then.
     The question is never deleted and the difference is never faked. */
  #rwleg .lhchips .lchip.weak{ opacity:.5; }
  #rwleg .lhchips .lchip.blocked{ opacity:.32; border-style:dashed; cursor:not-allowed; }
  #rwleg .lhwhy{ display:block; font-size:9px; line-height:1.5; color:var(--rw-why); margin-top:3px; }
  /* A ROW NOTHING READS looks different, not just reads differently — iris's pattern
     (viz/index.html, search "deaf"): the label block drops to .55 and a marker names the
     reason. Ported rather than invented, with one change that the measurement forces: the
     CHIPS keep full opacity, because under a PUSH these rows are alive (ACI moves the tick
     335 Hz end to end). What is deaf is the observation, not the intervention. */
  #rwleg .lhrow[data-deaf="1"]{ border-left:2px dashed var(--rw-deaf); padding-left:8px; }
  #rwleg .lhrow[data-deaf="1"] .lhname{ opacity:.55; }
  #rwleg .lhrow[data-deaf="1"] .lhtag{ opacity:1; color:var(--rw-tag); }
  #rwleg .lhverb{ display:inline-block; font-size:8.5px; letter-spacing:.1em; text-transform:uppercase;
    border:1px solid var(--rw-tag-line); border-radius:3px; padding:0 3px; margin-left:5px; color:var(--rw-tag);
    vertical-align:1px; }
  #rwleg .lhnow{ font-size:10px; line-height:1.5; color:var(--rw-tag); background:var(--rw-hnow-bg);
    border:1px solid var(--rw-hnow-line); border-radius:6px; padding:6px 8px; margin:0 0 8px;
    word-break:break-word; min-height:1.5em; }
  #rwleg .lhnow.held{ color:var(--rw-held); border-color:var(--rw-held-line); }
  /* SCREEN-READER ONLY. The status line (#rwleg-hnow) left the face on 2026-09-26 - the held
     chip and the ◆ PREVIEW HELD badge are the visible feedback - but hold / release / probe
     still write to it, so it stays in the DOM as a polite live region nobody sees. */
  #rwleg .lsr{ position:absolute !important; width:1px; height:1px; margin:-1px; padding:0; border:0;
    overflow:hidden; clip:rect(0 0 0 0); clip-path:inset(50%); white-space:nowrap; }
  #rwleg .lhnote{ color:var(--dim,#67708c); font-size:10.5px; line-height:1.5; margin:0 0 8px; }
  #rwleg .lhblock{ color:var(--rw-block); font-size:10.5px; line-height:1.5; margin:0 0 8px; }
  /* researcher mode (P21): one quiet toggle line, and a small readout under each row when on */
  #rwleg .lres{ font-size:9.5px; letter-spacing:.06em; color:var(--dim,#67708c); cursor:pointer; margin:0 0 8px;
    text-align:right; user-select:none; }
  #rwleg .lres:hover{ color:var(--txt,#c8d0ee); } #rwleg .lres.on{ color:var(--rw-ok); }
  #rwleg .lresbox{ font-size:9.5px; line-height:1.45; color:var(--rw-why); margin:4px 0 2px;
    padding:4px 6px; border-left:2px solid var(--rw-ctl-line); background:var(--rw-resbox); }
  #rwleg .lresbox div + div{ margin-top:2px; }

  #rwleg .linfo{ color:var(--dim,#67708c); cursor:help; text-align:center; border-radius:4px;
    font-size:11px; line-height:1.4; }
  #rwleg .linfo:hover, #rwleg .linfo:focus-visible, #rwleg .linfo[aria-expanded="true"]{
    color:var(--txt,#c8d0ee); outline:1px solid var(--rw-chip-line-hi); outline-offset:1px; }
  /* THE (i) POPOVER. Was a native title= attribute, which waits about a second and then
     vanishes the moment the pointer moves - Miguel: "that info of ACI in this case only
     appears when i want to take a screen shot". This one opens on the first hover or focus
     with no delay, survives the trip from the (i) down onto itself, and can be PINNED with a
     click so it holds still for a screenshot. Absolutely positioned inside #rwleg, which is
     position:fixed and therefore the containing block - so it scrolls with the panel's
     content instead of floating away from its row. DO NOT regress this to a title=. */
  #rwleg .ltip{ position:absolute; z-index:3; width:330px; max-width:calc(100% - 24px);
    background:var(--panel,#10142a); border:1px solid var(--rw-tip-line); border-radius:8px;
    padding:10px 12px; font-size:11px; line-height:1.55; color:var(--txt,#c8d0ee);
    box-shadow:var(--rw-tip-shadow); }
  #rwleg .ltip b.lth{ display:block; font-size:10px; letter-spacing:.12em; text-transform:uppercase;
    color:var(--dim,#67708c); margin-bottom:6px; }
  #rwleg .ltip .ltl{ margin:0 0 6px; }
  #rwleg .ltip .ltl em{ display:block; font-style:normal; font-size:9px; letter-spacing:.09em;
    text-transform:uppercase; color:var(--rw-label); }
  #rwleg .ltip .ltl.ltdata{ font-size:9.5px; color:var(--dim,#67708c); margin-top:7px; word-break:break-word; }
  #rwleg .ltip .lpin{ display:block; margin-top:7px; font-size:10px; color:var(--dim,#67708c); }
  #rwleg .lnote{ color:var(--dim,#67708c); font-size:10.5px; line-height:1.5; margin:0 0 8px; }
  #rwleg .lrow{ margin:3px 0; font-size:11px; } #rwleg .lrow i{ display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:7px; vertical-align:-1px; }
  #rwleg .sw{ display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:6px; vertical-align:-1px; }
  /* THE HEADER ROW (2026-10-01): the title, the ◆ PREVIEW HELD badge and the close button in one flex row, so the
     badge can never sit on the button (both were placed absolutely, and overlapped); it wraps if a look's type is
     ever too wide */
  #rwleg-head{ display:flex; align-items:center; flex-wrap:wrap; gap:4px 12px; margin:0 0 4px; }
  #rwleg-head h2{ margin:0; }
  #rwleg-close{ margin-left:auto; background:var(--rw-chip); border:1px solid var(--rw-chip-line);
    border-radius:6px; color:var(--dim,#67708c); cursor:pointer; padding:3px 8px; font:inherit; }
  #rwleg-badge{ color:var(--rw-held); font-size:10px; letter-spacing:.15em; display:none; }`;

  function send(o) { if (opts.send) opts.send(Object.assign({ type: "legend" }, o)); }
  function badge(on) { if (badgeEl) badgeEl.style.display = on ? "block" : "none"; }
  function hnow(t, held) {
    const n = panel && panel.querySelector("#rwleg-hnow");
    if (n) { n.textContent = t; n.classList.toggle("held", !!held); }
  }
  const stat = () => (window.WC && WC.statPref) ? WC.statPref() : "gradient";
  // THE CHANNEL THE SOUND IS ON (2026-09-26: the tables are per channel). air+water plays AIR's
  // tables (bridge _rw_table_channel), so only "water" is water here.
  // the channel the legend describes is the one SOUNDING (the probe says which, review 2026-09-27):
  // after air -> water the air window plays on until a water point is pressed. The page's pick only
  // before any point has been played.
  const tchan = () => (((PROBE && PROBE.chan) || (opts.channel && opts.channel())) === "water") ? "water" : "air";
  // WHERE WATER'S SOUND DIFFERS FROM AIR'S, measured on the water tables (L1, whole record):
  // the tick's colour follows ACI at rho +0.661 on water (+0.007 on air, hence air's dimmed ACI
  // row); on water NDSI (+0.774) and Bio (+0.767) lead it, not BI (+0.698; +0.868 on air); water's
  // highest Bio moments are storm nights (2023-11-28, 2025-02-18), not a dawn chorus; and water's
  // tick sits lower (734-1524 Hz on the whole record, 841-1747 on air). Air's rows are untouched.
  const CHAN_ROWS = { water: {
    "clave.colour": { tag: "734 – 1524 Hz" },
    "clave.index.aci": { deaf: false, tag: "",
      info: "How much the sound jumps from instant to instant: a steady wash is low, constant " +
        "change is high. On the water channel the tick's colour follows it closely." },
    // 1–8 kHz, not 2–11 (corrected 2026-09-30): BioEnergy sums maad's 1-kHz bins from 1 kHz up, and the
    // hydrophone's index pipeline low-passes at 8 kHz (run_wildnings.py FILTER_CONFIGS). lab/LEGEND_REFERENCE §4.3
    "clave.index.bioenergy": { hi: "fullest ▶",
      info: "How much sound sits in the 1–8 kHz range. On the hydrophone its highest moments are " +
        "a few storm nights (late November 2023, February 2025), not a dawn chorus. Almost every " +
        "moment is already near the bottom, so there is only a “fullest” chip." },
    // 1–10 kHz, not 2–11 (corrected 2026-09-30): BI's band in scikit-maad, read from its source
    // (lab/LEGEND_REFERENCE.md §4.3); the picker's gloss names the same band
    "clave.index.bi": {
      info: "How far sound in the 1–10 kHz range rises above the background. On the water channel " +
        "the tick's colour follows NDSI and Bio a little more closely than this." },
  } };
  const chanRow = r => { const o = (CHAN_ROWS[tchan()] || {})[r.id]; return o ? Object.assign({}, r, o) : r; };
  const here = () => (location.pathname.split("/").pop() || "index.html") || "index.html";

  // ---- the hold gesture ------------------------------------------------------------------
  // WHAT THE OLD bindHold GOT WRONG, and what each line here is for. It bound pointerup and
  // pointercancel on window in the BUBBLE phase and nothing else, so:
  //   * a release over browser chrome, another window or the desktop never arrived and the
  //     chip stayed lit with the preview running - the stuck-on case. Fixed by window blur
  //     and document visibilitychange, and by Escape.
  //   * any handler between the chip and window that stopped propagation of pointerup would
  //     have swallowed the release. Fixed by listening in the CAPTURE phase, which runs
  //     before any target handler can stop anything.
  //   * on touch, a few pixels of drag inside a scrollable panel raises pointercancel, so the
  //     hold died on the smallest wobble. Fixed by touch-action:none on the chips plus
  //     setPointerCapture, and the pointer may now wander SLOP px past the chip's edge before
  //     it counts as having left.
  //   * two chips pressed at once each installed their own listeners and one release fired
  //     both. Fixed by ONE module-level hold: nested holds are ignored until a release, which
  //     is also the contract's rule (A1) and the bridge's.
  // A fast press-and-release is a normal release: nothing waits, nothing is debounced, and
  // exactly one {cmd:"release"} is sent per hold because releaseHold() clears HELD first.
  const SLOP = 18;
  let HELD = null;

  function onUp(e) {
    if (!HELD) return;
    if (HELD.ptr != null && e.pointerId != null && e.pointerId !== HELD.ptr) return;
    releaseHold();
  }
  function onMove(e) {
    if (!HELD || HELD.key) return;                       // a key-held chip has no pointer to track
    if (HELD.ptr != null && e.pointerId != null && e.pointerId !== HELD.ptr) return;
    const r = HELD.el.getBoundingClientRect();
    if (e.clientX < r.left - SLOP || e.clientX > r.right + SLOP ||
        e.clientY < r.top - SLOP || e.clientY > r.bottom + SLOP) releaseHold("pointer left the chip");
  }
  function onBlur() { releaseHold("focus left the window"); }
  function onVis() { if (document.hidden) releaseHold("tab hidden"); }

  function releaseHold(why) {
    const h = HELD; if (!h) return; HELD = null;         // cleared FIRST: exactly one release
    window.removeEventListener("pointerup", onUp, true);
    window.removeEventListener("pointercancel", onUp, true);
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("visibilitychange", onVis);
    try { if (h.ptr != null && h.el.hasPointerCapture && h.el.hasPointerCapture(h.ptr)) h.el.releasePointerCapture(h.ptr); } catch (e) {}
    h.el.classList.remove("holding"); badge(false);
    send({ cmd: "release" });
    hnow("released — back to your point" + (why ? " (" + why + ")" : "") + ".", false);
  }
  function startHold(el, e) {
    if (HELD) return;                                    // nested holds: the first one wins
    if (el.dataset.blocked === "1") { hnow("cannot play here · " + plainWhy(el.dataset.why || "blocked"), false); return; }
    HELD = { el, row: el.dataset.row, dir: el.dataset.dir, key: !e,
             ptr: (e && e.pointerId != null) ? e.pointerId : null };
    try { if (HELD.ptr != null && el.setPointerCapture) el.setPointerCapture(HELD.ptr); } catch (err) {}
    el.classList.add("holding"); badge(true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVis);
    send({ cmd: "hold", row: HELD.row, dir: HELD.dir });
    hnow("holding · " + el.dataset.label + " — " + (el.dataset.summary || "your point, this one quantity at its extreme"), true);
  }
  function bindHold(el) {
    el.addEventListener("pointerdown", e => { e.preventDefault(); startHold(el, e); });
    // capture loss (element re-rendered, gesture taken over) is a release, and it is safe to
    // call on the normal path too: releaseHold() is a no-op once HELD is cleared.
    el.addEventListener("lostpointercapture", () => { if (HELD && HELD.el === el) releaseHold(); });
    // keyboard: hold while the key is down. blur covers a keyup that never arrives.
    el.setAttribute("tabindex", "0"); el.setAttribute("role", "button");
    el.addEventListener("keydown", e => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault(); if (!HELD) startHold(el, null);
    });
    el.addEventListener("keyup", e => {
      if ((e.key === "Enter" || e.key === " ") && HELD && HELD.el === el) releaseHold();
    });
    el.addEventListener("blur", () => { if (HELD && HELD.el === el) releaseHold("focus left the chip"); });
  }

  // ---- tier 2 rendering ------------------------------------------------------------------
  // Which chips a row offers. "same" is rendered ONLY on the drone row for the reading you
  // are NOT on (contract, blocked case 5): on the row you are on it would be your own sound.
  function dirList(r) {
    const D = r.dirs || {}, iso = r.verb === "isolate" ? "iso" : "";
    // NO LABEL, NO CHIP. A row omits a direction when that direction is dead for ALL points,
    // not merely weak for this one - weakness is the probe's job and it dims per point. The
    // distinction matters: Bio's low chip cleared a semitone on 0.0% of points because 79.3%
    // of windows already sit in the bottom 2% of that column, so it was not a weak chip but
    // a false one. Anything still measurable somewhere keeps its chip and gets dimmed where
    // it is not.
    const out = [];
    if (r.lo) out.push({ dir: D.lo || "lo", label: r.lo, cls: iso });
    if (r.layer === "drone" && r.id !== "drone." + stat())
      out.push({ dir: "same", label: "= yours, other reading", cls: "mid" });
    if (r.hi) out.push({ dir: D.hi || "hi", label: r.hi, cls: iso });
    return out;
  }
  // Three sources of truth about one chip, most specific first: the VIEW (a month key cannot
  // host a push at all), then the bridge's reply for the point in front of the reader, then
  // the record-wide measurement - which is labelled "across the record" so it is never
  // mistaken for this point's own number.
  function chipState(r, d) {
    if (MONTHKEY_VIEWS[here()]) return { blocked: true, why: MONTHKEY_WHY };
    const b = PROBE && PROBE.blocked && PROBE.blocked[r.id];
    if (b) return { blocked: true, why: String(b) };
    const p = PROBE && PROBE.rows && PROBE.rows[r.id];
    if (p) {
      if (p[d.dir] == null) return { blocked: true, why: "not available at this point" };
      const aud = p.audible ? p.audible[d.dir] : undefined;
      if (aud === false) return { weak: true, why: (p.why && p.why[d.dir]) || "at this point it does not clear the noise floor" };
      return { sum: fmtMoves(p[d.dir]).join(" · ") };
    }
    const w = r.weak && r.weak[d.dir === "only_lo" ? "lo" : d.dir === "only_hi" ? "hi" : d.dir];
    if (w) return { weak: true, why: "across the record, " + w };
    return {};
  }

  // A reason that holds for EVERY row of `rs` — the view cannot host the tier, no point is
  // selected yet, a fader is at 0 — is printed ONCE above those rows instead of once per row
  // (the old face could repeat one sentence fifteen times). Returns that sentence, or "" - the
  // RAW sentence, so buildRow can compare it with chipState's; callers print plainWhy() of it.
  function sharedBlock(rs) {
    if (!rs.length) return "";
    if (MONTHKEY_VIEWS[here()]) return MONTHKEY_WHY;
    const bl = PROBE && PROBE.blocked; if (!bl) return "";
    const w = bl[rs[0].id];
    return (w && rs.every(r => bl[r.id] === w)) ? String(w) : "";
  }

  function buildHear() {
    const host = document.getElementById("rwleg-hear"); if (!host) return;
    const hadFocus = !!document.activeElement && document.activeElement.id === "rwleg-research";
    if (HELD) releaseHold("the panel was rebuilt");       // never orphan a live hold
    host.textContent = "";
    // NO INSTRUCTION PROSE AND NO STATUS LINE ON THE FACE (Miguel, 2026-09-26). The section
    // heading IS the one instruction; a hold shows on the chip itself and in the ◆ PREVIEW HELD
    // badge. #rwleg-hnow stays in the DOM, screen-reader only, because startHold / releaseHold /
    // onBridge still write to it through hnow().
    const now = document.createElement("div"); now.className = "lhnow lsr"; now.id = "rwleg-hnow";
    now.setAttribute("role", "status"); now.setAttribute("aria-live", "polite");
    now.textContent = MONTHKEY_VIEWS[here()] ? "this view cannot host the tier" : "nothing held";
    host.appendChild(now);
    const rt = document.createElement("div");
    rt.className = "lres" + (RESEARCH ? " on" : ""); rt.id = "rwleg-research";
    rt.setAttribute("role", "button"); rt.tabIndex = 0;
    rt.setAttribute("aria-pressed", RESEARCH ? "true" : "false");
    rt.textContent = "researcher readout · " + (RESEARCH ? "on" : "off");
    rt.title = "under each row, the numbers for the point you are on: what each push moves, what the "
      + "column predicts in this selection, and the column's raw values";
    const flip = () => { RESEARCH = !RESEARCH;
      try { localStorage.setItem(LS_RESEARCH, RESEARCH ? "1" : "0"); } catch (e) {}
      buildHear(); };
    rt.onclick = flip; rt.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } };
    host.appendChild(rt);
    if (hadFocus) rt.focus();                            // a rebuild must not drop keyboard focus
    const all = sharedBlock(ROWS);
    // researcher mode: the bridge's EXACT sentence for a shared block, said once where the plain
    // label is (the rows then skip it - LEGEND_REFERENCE §3.1, a shared reason is said once)
    const exact = s2 => { if (RESEARCH && s2 && plainWhy(s2) !== s2) {
      const bx = document.createElement("div"); bx.className = "lresbox";
      bx.textContent = "at your point — blocked: " + s2; host.appendChild(bx); } };
    if (all) {
      const b = document.createElement("div"); b.className = "lhblock"; b.textContent = plainWhy(all);
      host.appendChild(b); exact(all);
    }
    LAYERS.forEach(L => {
      const rs = ROWS.filter(r => r.layer === L.key).map(chanRow);
      const h = document.createElement("div"); h.className = "lhlayer";
      const n = document.createElement("span"); n.className = "n"; n.textContent = L.name;
      h.appendChild(n);
      infoButton(h.appendChild(document.createElement("span")), L.name, () => infoLines(L));
      host.appendChild(h);
      // on water the arp is silent by nature (no BirdNET on the hydrophone): say THAT, once,
      // rather than the per-point "no bird chord here"
      const noBird = L.key === "arp" && tchan() === "water";
      const lw = all ? "" : sharedBlock(rs);   // e.g. "the arp fader is at 0", said once (on water the
                                                // water sentence below replaces it; rows then skip it)
      if (noBird) { const w = document.createElement("div"); w.className = "lhwhy"; w.textContent = "silent on water — BirdNET ran on the air recorder only"; host.appendChild(w); }
      else if (lw) { const w = document.createElement("div"); w.className = "lhwhy"; w.textContent = plainWhy(lw); host.appendChild(w); exact(lw); }
      let didSub = false;
      rs.forEach(r => {
        if (r.index && !didSub) {                         // the per-index sub-group, named once
          didSub = true;
          const sh = document.createElement("div"); sh.className = "lhsub";
          sh.textContent = "each measure · shifts the tick's colour"; host.appendChild(sh);
        }
        host.appendChild(buildRow(r, all || lw));
      });
    });
  }

  // ONE ROW = one line of the map legend: NAME · meaning, at most one small line (the
  // perceptual range, or on a deaf row why it is dimmed), then the chips. `shown` is a block
  // reason already printed above this row, so it is not repeated under it.
  function buildRow(r, shown) {
    const row = document.createElement("div");
    row.className = "lhrow"; row.dataset.row = r.id;
    if (r.deaf) row.dataset.deaf = "1";
    const top = document.createElement("div"); top.className = "lhtop";
    const lab = document.createElement("span"); lab.className = "lhname";
    const b = document.createElement("b"); b.textContent = r.name; lab.appendChild(b);
    lab.appendChild(document.createTextNode(" · "));
    const it = document.createElement("i"); it.textContent = r.what; lab.appendChild(it);
    const tag = r.id === "clave.colour" ? colourTag(r) : r.tag;
    if (tag) { const t = document.createElement("small"); t.className = "lhtag"; t.textContent = tag; lab.appendChild(t); }
    top.appendChild(lab);
    infoButton(top.appendChild(document.createElement("span")), r.name + " · " + r.what, () => infoLines(r));
    row.appendChild(top);
    const chips = document.createElement("div"); chips.className = "lhchips";
    const whys = [], shownP = shown ? plainWhy(shown) : "";
    dirList(r).forEach(d => {
      const st = chipState(r, d);
      const c = document.createElement("div");
      c.className = "lchip" + (d.cls ? " " + d.cls : "") + (st.blocked ? " blocked" : "") + (st.weak ? " weak" : "");
      c.textContent = d.label;
      c.dataset.row = r.id; c.dataset.dir = d.dir;
      c.dataset.label = r.name + " · " + d.label;
      if (st.sum) c.dataset.summary = st.sum;
      if (st.blocked) { c.dataset.blocked = "1"; c.dataset.why = st.why; }
      // THE REASON RIDES ON THE CHIP: dimmed, and said on its hover. A BLOCKED reason is also
      // printed once, short, under the row - unless the panel or the layer already said it. A
      // weak chip still plays (it is only dimmed), so its reason stays on the hover alone.
      // Blocked reasons are shown as plainWhy() labels; data-why (above) keeps the exact one.
      if (st.why) c.title = st.blocked ? plainWhy(st.why) : st.why;
      if (st.blocked) {
        const p = plainWhy(st.why);
        if (p !== shownP && whys.indexOf(p) < 0) whys.push(p);
      }
      bindHold(c);
      chips.appendChild(c);
    });
    row.appendChild(chips);
    if (whys.length) {
      const w = document.createElement("span"); w.className = "lhwhy"; w.textContent = whys.join(" · ");
      row.appendChild(w);
    }
    if (RESEARCH) {
      const lines = researchLines(r, shown);
      if (lines.length) {
        const box = document.createElement("div"); box.className = "lresbox";
        lines.forEach(t => { const l = document.createElement("div"); l.textContent = t; box.appendChild(l); });
        row.appendChild(box);
      }
    }
    return row;
  }
  // The researcher readout for one row, from the probe (LEGEND_REFERENCE §3.2, its wording):
  // `at your point` per direction (or the bridge's EXACT block reason, not the plain label),
  // `observation, in this selection` (the observational Spearman of the row's column against
  // each layer), `the column, at your point` (the dataset column: yours, and where the push goes).
  // the tick's colour range is PER ROOM (clave_base x 0.65..1.35): read it off the probe's colour
  // row; with no probe (or the row blocked) the record-wide range, said as such (review 2026-09-27)
  function colourTag(r) {
    const p = PROBE && PROBE.rows && PROBE.rows["clave.colour"];
    const lo = p && p.lo && p.lo.colour, hi = p && p.hi && p.hi.colour;
    const a = lo ? lo.hz_to : hi ? hi.hz_from : null;
    const b = hi ? hi.hz_to : lo ? lo.hz_from : null;
    return (a != null && b != null) ? Math.round(a) + " – " + Math.round(b) + " Hz"
                                    : r.tag + " across the whole record";
  }
  function researchLines(r, shown) {
    if (MONTHKEY_VIEWS[here()]) return [];
    const b = PROBE && PROBE.blocked && PROBE.blocked[r.id];
    if (b) return (shown && String(b) === shown) ? [] : ["at your point — blocked: " + String(b)];
    const p = PROBE && PROBE.rows && PROBE.rows[r.id];
    if (!p) return [];
    const out = [];
    dirList(r).forEach(d => {
      const mv = p[d.dir]; if (mv == null) return;
      const m = fmtMoves(mv).join(" · ");
      const why = (p.why && p.why[d.dir]) || "";
      if (!m) {                                   // nothing this row plays moves: say so, and why
        const h = fmtMoves(p.held && p.held[d.dir]).join(" · ");
        out.push("at your point · " + d.label + " — " + (why || "nothing moves on this point")
          + (h ? " (held still: " + h + ")" : ""));
        return;
      }
      const under = (p.audible && p.audible[d.dir] === false) ? " — under the noise floor: " + why : "";
      out.push("at your point · " + d.label + " — " + m + under);
    });
    if (p.rho && typeof p.rho === "object") {
      const sg = x => (x > 0 ? "+" : x < 0 ? "−" : "±") + n3(Math.abs(x));   // the bridge sends 3 dp
      const o = ["colour", "tempo", "body", "metre"].filter(k => p.rho[k] != null).map(k => k + " " + sg(p.rho[k]));
      if (o.length) out.push("observation, in this selection — this column predicts " + o.join(" · ")
        + ". Prediction is not the same question as the push above.");
    }
    if (p.column && p.column.name) {
      const c = p.column, f = v => v == null ? "—" : (Math.abs(v) >= 100 ? n1(v) : n3(v));
      if (r.verb === "isolate") {             // arp.pitch: an ISOLATE of your own notes, not a push
        const nz = dd => (p[dd] && p[dd].arp) ? p[dd].arp.note_hz : null;
        out.push("the column, at your point — " + c.name + " (as Hz) · your chord spans "
          + f(c.raw_lo) + " – " + f(c.raw_hi) + " Hz; the chips play " + f(nz("only_lo"))
          + " or " + f(nz("only_hi")) + " Hz alone");
      } else {
        out.push("the column, at your point — " + c.name + " · yours " + f(c.your_raw) + ", pushed to "
          + f(c.raw_lo) + " or " + f(c.raw_hi) + (c.gate != null ? " (gate " + c.gate + ")" : ""));
      }
    }
    return out;
  }

  // ---- the bridge's reply ----------------------------------------------------------------
  // Numbers for THIS point. Since 2026-09-26 they are no longer printed in the (i) (the per-point
  // readout - moves, rho, the raw column - is described in lab/LEGEND_REFERENCE.md); they ride on
  // each chip's data-summary, are announced by the screen-reader status on a hold, and the
  // researcher mode (P21, researchLines) prints them under each row.
  // Nothing from the socket is ever written as markup: every value goes through textContent.
  const n1 = x => (Math.round(x * 10) / 10).toFixed(1);
  const n2 = x => (Math.round(x * 100) / 100).toFixed(2);
  const n3 = x => (Math.round(x * 1000) / 1000).toFixed(3);
  function fmtMoves(mv) {
    const o = []; if (!mv || typeof mv !== "object") return o;
    // a push across the two readings ranks in TWO orderings: say which is which (the bridge sends
    // reading_from / reading_to for exactly this) - "rank 656 → 0" read as one ordering is false
    if (mv.body) { const bd = mv.body, two = bd.reading_from && bd.reading_to && bd.reading_from !== bd.reading_to;
      o.push((two ? "body " + bd.reading_from + " rank " + bd.rank_from + " → " + bd.reading_to + " rank " + bd.rank_to
                  : "body rank " + bd.rank_from + " → " + bd.rank_to) + " of " + bd.n
        + (bd.d_db_est != null ? " ≈ " + n2(Math.abs(bd.d_db_est)) + " dB" : "")); }
    if (mv.tempo) o.push("tempo " + n1(mv.tempo.hz_from) + " → " + n1(mv.tempo.hz_to) + " Hz");
    if (mv.colour) o.push("colour " + Math.round(mv.colour.hz_from) + " → " + Math.round(mv.colour.hz_to) + " Hz"
      + (mv.colour.cents != null ? " (" + (mv.colour.cents > 0 ? "+" : "") + Math.round(mv.colour.cents) + " cents)" : ""));
    if (mv.metre) o.push("metre every " + mv.metre.from + " → " + mv.metre.to + " ticks");
    if (mv.arp) { const a = mv.arp, bits = [];
      if (a.notes != null) bits.push(a.notes + " note" + (a.notes === 1 ? "" : "s"));
      if (a.gap_from != null) bits.push("gap " + n2(a.gap_from) + " → " + n2(a.gap_to) + " s");
      if (a.assembly_from != null) bits.push("assembly " + n1(a.assembly_from) + " → " + n1(a.assembly_to) + " s");
      if (a.cert_from != null) bits.push("cert " + n3(a.cert_from) + " → " + n3(a.cert_to));
      o.push("chord " + bits.join(", ")); }
    return o;
  }
  // The contract's C1/C2. Preferred path: the host calls LEG.onBridge(m). Fallback: hookSocket().
  function onBridge(m) {
    if (!m || typeof m !== "object") return;
    if (m.type === "legend_probe") {
      PROBE = { rows: (m.rows && typeof m.rows === "object") ? m.rows : {},
                blocked: (m.blocked && typeof m.blocked === "object") ? m.blocked : {},
                chan: typeof m.channel === "string" ? m.channel : null };
      if (open) { buildHear(); buildSee(); }
      return;
    }
    if (m.type !== "legend_preview") return;
    LASTPREV = m;
    const s = fmtMoves(m.moves).join(" · ");
    const row = ROWS.filter(r => r.id === m.row)[0];
    const nm = row ? row.name + " · " + row.what : String(m.row);
    hnow("holding · " + nm + " · " + String(m.dir) + " — "
      + (m.audible === false ? "at or under the noise floor" + (m.why ? ": " + m.why : "")
                             : (s || "nothing moves")), !!HELD);
  }
  // RECEIVING AT ALL. The six pages route only mix / init / web_control off the socket and this
  // file does not own them, so the reply would be dropped. This installs a transparent,
  // idempotent accessor on WebSocket.prototype.onmessage: the page's own handler is stored and
  // invoked exactly as before, and ours is simply registered first, on the message event. It
  // reacts to nothing but a type beginning "legend_". DELETE IT the day a page forwards those
  // frames to LEG.onBridge, which is the documented path and takes precedence.
  function hookSocket() {
    try {
      const P = window.WebSocket && window.WebSocket.prototype;
      if (!P || P.__rwlegHook) return;
      const d = Object.getOwnPropertyDescriptor(P, "onmessage");
      if (!d || !d.set || !d.get) return;
      Object.defineProperty(P, "onmessage", {
        configurable: true, enumerable: d.enumerable,
        get() { return d.get.call(this); },
        set(fn) {
          if (!this.__rwlegSniff) {
            this.__rwlegSniff = true;
            this.addEventListener("message", ev => {
              let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
              if (m && typeof m.type === "string" && m.type.indexOf("legend_") === 0) onBridge(m);
            });
          }
          d.set.call(this, fn);
        },
      });
      P.__rwlegHook = true;
    } catch (e) {}
  }
  hookSocket();

  // ---- probing ---------------------------------------------------------------------------
  // "For the point I am on, what would every row do?" One round trip instead of thirty, asked
  // when the panel opens, when the reading or the data changes, and when the cursor moves.
  // The cursor is polled rather than hooked because the pages do not notify on hover and this
  // file does not own them; 500 ms is far under a listening gesture and the ask is debounced.
  let _probeT = 0, _pollT = 0, _lastPoint = null;
  function probe() {
    if (!open || MONTHKEY_VIEWS[here()]) return;
    clearTimeout(_probeT); _probeT = setTimeout(() => send({ cmd: "probe" }), 200);
  }
  function watchPoint() {
    clearInterval(_pollT); _pollT = 0;
    if (!open || !opts.current) return;
    // `point`, when a view supplies it, is finer than `current`: on spectro and mfcc the cursor
    // is a MONTH but the sound is a month × WINDOW, and moving dawn -> day must re-probe.
    const at = () => (opts.point ? opts.point() : opts.current());
    _lastPoint = at();                                  // adopt, do not re-ask: toggle() just probed
    _pollT = setInterval(() => {
      const k = at(); if (k === _lastPoint) return;
      _lastPoint = k; PROBE = null; probe();
    }, 500);
  }

  // ---- panel plumbing --------------------------------------------------------------------
  function buildPanel() {
    const st = document.createElement("style"); st.textContent = CSS; document.head.appendChild(st);
    panel = document.createElement("div"); panel.id = "rwleg";
    panel.innerHTML =
      `<div id="rwleg-head"><h2>PERCEPTUAL LEGEND</h2><span id="rwleg-badge">◆ PREVIEW HELD</span><button id="rwleg-close">✕ close (L)</button></div>
       <div class="lsec" data-sec="cat">catalogue — real months (click = hear + see + select)</div><div id="rwleg-cat" class="lgrid"></div>
       <div class="lsec" data-sec="hear">select a data point, then hold a chip to hear the difference</div><div id="rwleg-hear"></div>
       <div class="lsec" data-sec="see">see · how to read this view</div><div id="rwleg-see"></div>`;
    document.body.appendChild(panel);
    badgeEl = panel.querySelector("#rwleg-badge");
    panel.querySelector("#rwleg-close").onclick = () => toggle(false);
    const tab = document.createElement("div");
    tab.id = "rwleg-tab"; tab.textContent = "legend · L";
    tab.title = "the perceptual legend: what the sound means (L)";
    tab.onclick = () => toggle(true);
    document.body.appendChild(tab);
    foldTiers();
    buildHear(); buildSee();
  }

  // each tier folds away, so the legend reads as a contents list you open one part of
  // at a time. Same idiom as the sidebar's sections; the choice is remembered per tier.
  function foldTiers() {
    panel.querySelectorAll(".lsec").forEach((h, i) => {
      const body = h.nextElementSibling; if (!body) return;
      const chev = document.createElement("span"); chev.className = "lchev"; chev.textContent = "▾";
      h.appendChild(chev);
      const key = "rewild_legsec_" + (h.dataset.sec || i);
      const set = closed => { h.classList.toggle("closed", closed); body.style.display = closed ? "none" : ""; };
      let closed = false;
      try { closed = localStorage.getItem(key) === "0"; } catch (e) {}
      set(closed);
      h.onclick = () => { const c = !h.classList.contains("closed"); set(c);
        try { localStorage.setItem(key, c ? "0" : "1"); } catch (e) {} };
    });
  }

  function buildCatalogue() {
    const host = d3.select("#rwleg-cat"); if (host.empty()) return; host.selectAll("*").remove();
    const ms = (opts.months && opts.months()) || []; if (!ms.length) return;
    const chips = [];
    // n_species rides on the month itself; the six indices live in drv. A month BirdNET analysed
    // none of has nsp = null: unknown, so it takes no part (+null would be 0, "no species")
    const valOf = (m, k) => k === "nsp" ? (m.nsp == null ? NaN : +m.nsp) : (m.drv ? +m.drv[k] : NaN);
    CAT_FEATURES.forEach(([k, hi]) => {                          // the real record-holder per index
      let best = null, lo = null;
      ms.forEach(m => { const v = valOf(m, k); if (!Number.isFinite(v)) return;
        if (!best || v > valOf(best, k)) best = m;
        if (!lo || v < valOf(lo, k)) lo = m; });
      // a superlative among equals is noise: only offer the chip if the feature actually spreads
      if (best && lo && valOf(best, k) > valOf(lo, k)) chips.push({ t: hi, m: best });
    });
    // THE SEASON'S PEAK, not its typical month: the chip is the season's highest-Bio month, so it
    // used to be mislabelled "typical <season>" (on air that is the Bio record-holder; on water,
    // a storm event). Relabelled "<season> peak" (Miguel 2026-09-27); the pick is unchanged.
    Object.entries(SEASON).forEach(([s, mm]) => {                // the season's peak month (highest bio)
      const cand = ms.filter(m => mm.includes(m.month));
      let best = null; cand.forEach(m => { const v = m.drv ? +m.drv.bioenergy : NaN;
        if (Number.isFinite(v) && (!best || v > best.drv.bioenergy)) best = m; });
      if (best) chips.push({ t: s + " peak", m: best });
    });
    host.selectAll("div").data(chips).join("div").attr("class", "lchip")
      .html(c => `${c.t}<br><small>${MON[c.m.month]} ${c.m.year}</small>`)
      .on("click", (e, c) => {
        // HEAR it. The catalogue sends its own navigation rather than going through the host's
        // sound path, so a record-holder is audible even on a view that cannot yet sound itself.
        if (opts.send) opts.send({ type: "drv", level: 0, mkey: c.m.key,
                                   channel: opts.channel ? opts.channel() : undefined });
        // SEE it, and MEAN it: the host moves its cursor there and makes sure the month is
        // SHOWN, so a record-holder you have filtered out comes back into view. `show`, not a
        // toggle - eleven chips resolve to seven months, so a toggle would make the second
        // chip for a month hide what the first one revealed.
        // NOTE it does NOT trace: a chip is "look at this", not "keep an eye on this".
        if (opts.select) opts.select(c.m.key, { show: true, bring: true });
      });
  }

  // ---- the (i) popover -----------------------------------------------------
  // Immediate on hover OR keyboard focus; stays while the pointer is on the (i) or on the
  // popover; Escape or a click elsewhere closes it; click pins it open for a screenshot.
  // Clamped to the panel so it can never hang off the docked edge. Its body (2026-09-26) is two
  // or three short sentences for a listener, then ONE small last line "in the data: <column>".
  // The old labelled paragraphs (what it is / what reads it / measured / ...) are verbatim in
  // lab/LEGEND_REFERENCE.md. openTip() still takes a list of [label, text] pairs: label "" is
  // plain text, label DATA is the small data line, any other label renders as before.
  let tipEl = null, tipOwner = null, tipPinned = false, tipHide = 0;
  const DATA = "in the data";
  function infoLines(o) {
    const t = typeof o.info === "function" ? o.info(stat()) : o.info;
    const out = []; if (t) out.push(["", t]);
    if (o.data) out.push([DATA, o.data]);
    return out;
  }

  function closeTip() {
    clearTimeout(tipHide);
    if (tipEl) { tipEl.remove(); tipEl = null; }
    if (tipOwner) { tipOwner.setAttribute("aria-expanded", "false"); tipOwner = null; }
    tipPinned = false;
  }
  function openTip(el, title, ls) {
    if (tipOwner === el && tipEl) { clearTimeout(tipHide); return; }
    closeTip();
    tipOwner = el; el.setAttribute("aria-expanded", "true");
    tipEl = document.createElement("div");
    tipEl.className = "ltip"; tipEl.id = "rwleg-tip"; tipEl.setAttribute("role", "tooltip");
    const th = document.createElement("b"); th.className = "lth"; th.textContent = title;
    tipEl.appendChild(th);
    (ls || []).forEach(([lab, txt]) => {
      const p = document.createElement("div"); p.className = "ltl";
      if (lab === DATA) {                                              // textContent: these
        p.className = "ltl ltdata"; p.textContent = DATA + ": " + String(txt);   // strings are
      } else {                                                         // prose, never markup
        if (lab) { const em = document.createElement("em"); em.textContent = lab; p.appendChild(em); }
        p.appendChild(document.createTextNode(String(txt)));
      }
      tipEl.appendChild(p);
    });
    const pin = document.createElement("span");
    pin.className = "lpin"; pin.textContent = "click the ⓘ to pin · esc to close";
    tipEl.appendChild(pin);
    panel.appendChild(tipEl);
    // keep the pointer's round trip from the (i) to the popover alive
    tipEl.addEventListener("pointerenter", () => clearTimeout(tipHide));
    tipEl.addEventListener("pointerleave", () => { if (!tipPinned) tipHide = setTimeout(closeTip, 140); });
    place(el);
  }
  function place(el) {
    if (!tipEl) return;
    const pr = panel.getBoundingClientRect(), er = el.getBoundingClientRect();
    const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    // panel coordinates, plus its scroll offset: the popover rides with the content
    const x0 = er.left - pr.left + panel.scrollLeft, y0 = er.top - pr.top + panel.scrollTop;
    // CLAMP so it cannot fall off the docked panel's edges. The (i) sits in the last grid
    // column, hard against the right edge, so an unclamped popover is always cut off.
    const maxX = panel.clientWidth - w - 10;
    tipEl.style.left = Math.max(10, Math.min(x0 + er.width / 2 - w / 2, maxX)) + "px";
    // Flip above when there is no room below inside the VISIBLE part of the panel, and clamp
    // to the visible band either way - `top` is in CONTENT coordinates, so a bare Math.max(4)
    // would pin a flipped popover to the top of the whole scrolled document rather than to
    // the top of what the reader can actually see.
    const view0 = panel.scrollTop, view1 = panel.scrollTop + panel.clientHeight;
    const below = y0 + er.height + 7;
    let top = (view1 - (below + h) > 6) ? below : (y0 - h - 7);
    tipEl.style.top = Math.max(view0 + 4, Math.min(top, view1 - h - 4)) + "px";
  }
  // `ls` is a FUNCTION, so a popover opened after a probe reply prints this point's own
  // numbers rather than the ones that were true when the row was built.
  function infoButton(el, title, ls) {
    el.className = "linfo"; el.textContent = "ⓘ";
    // NO title= attribute: the native tooltip is the thing being replaced, and leaving one
    // here would pop a second, slower copy on top of this popover.
    el.setAttribute("tabindex", "0"); el.setAttribute("role", "button");
    el.setAttribute("aria-expanded", "false"); el.setAttribute("aria-describedby", "rwleg-tip");
    el.setAttribute("aria-label", title + " — what this means");
    const get = () => (typeof ls === "function" ? ls() : ls);
    el.addEventListener("pointerenter", () => openTip(el, title, get()));
    el.addEventListener("pointerleave", () => { if (!tipPinned) tipHide = setTimeout(closeTip, 140); });
    el.addEventListener("focus", () => openTip(el, title, get()));
    el.addEventListener("blur", () => { if (!tipPinned) tipHide = setTimeout(closeTip, 140); });
    el.addEventListener("click", e => {
      e.stopPropagation();
      if (tipOwner === el && tipPinned) { closeTip(); return; }
      openTip(el, title, get()); tipPinned = true; clearTimeout(tipHide);
    });
    el.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); el.click(); }
      else if (e.key === "Escape") { closeTip(); el.focus(); }
    });
  }
  // WHAT EACH VIEW IS — one line each. This prose used to be a HOW TO READ block in every
  // sidebar and then a paragraph here; since 2026-09-26 it is a map-legend key (the longer
  // versions, verbatim, are in lab/LEGEND_REFERENCE.md). Strings below are STATIC - no data
  // and nothing from the socket is ever interpolated into this markup.
  const VIEWS = {
    "index.html":  ["scatter", "each dot is one time of day (dawn, day, dusk or night) of a month, or of one day"],
    "rose.html":   ["roses", "one rose per month; its four spokes are dawn, day, dusk and night — press a spoke to hear it. Shaded: the middle half of the month's days, on the focused rose; its line is the average, which a few extreme days can pull outside the shading. At day resolution every rose is drawn that way, its line the median day, and the month opens below as a calendar of days. A hollow dot on a spoke = nothing recorded there; a faint stretch = fewer than 4 days behind it (on a calendar day, under 30 min recorded)"],
    // "similar MEASURES", never "sound alike": closeness is a PCA over seven measures, while the
    // sound follows the gradient / variance / mean ranks and BirdNET (review 2026-09-26)
    "biplot.html": ["biplot", "a similarity map: months that sit close have similar measures; arrows show which measures pull where"],
    "linear.html": ["linear", "one month, day by day, coloured by time of day; a gap is a recorder outage"],
    "spectro.html":["spectro", "frequency bands up the side (low to high), hour of day (UTC) across; brighter = louder"],
    "mfcc.html":   ["mfcc", "the sound's timbre through the day: each row one aspect of its shape (c0 loudness, c1 brightness …), hour of day (UTC) across; each row has its own colour scale"],
  };
  // The hour-of-day views: a coloured strip on top picks the sound, the height never does, and
  // the month strip picks ONE month (it is not the many-month filter it is on the dot views).
  const HOUR_VIEWS = { "spectro.html": "frequency band", "mfcc.html": "coefficient row" };
  // THE INDEX PICKER'S PLAIN GLOSSES (roses + linear, 2026-09-30, Miguel's design). AEI and BI joined
  // the picker, and each is explained wherever a view names it: the option's tooltip and the line
  // under the picker, the hover box, linear's axis label (its tooltip), and this key (INDEX_KEY below). AEI is drawn AS
  // MEASURED, higher = more uneven, so its gloss says which way is up; nothing flips it. BI's band is
  // what scikit-maad computes, read from its source (the pipeline's flim=(2000, 10000) never reaches
  // BI): the technical reading is lab/LEGEND_REFERENCE.md §4.3. On water the band is not called the
  // bird band (a hydrophone), as the HEAR rows avoid "birdsong" there. STATIC strings only.
  const GLOSS = {
    AEI: () => "AEI · acoustic evenness index: high when a few pitch bands hold most of the sound",
    BI: ch => ch === "water"
      ? "BI · bioacoustic index: how much sound there is in the 1–10 kHz band, above its quietest level"
      : "BI · bioacoustic index: how much sound there is in the bird band (1–10 kHz), above its quietest level",
  };
  const gloss = (k, ch) => Object.prototype.hasOwnProperty.call(GLOSS, k) ? GLOSS[k](ch) : null;
  // THE SCATTER'S AXES IN PLAIN WORDS (P44, 2026-09-30; Alice T2). "NAME · meaning", as GLOSS: the legend
  // face's own words where it has a row for the measure (ROWS name · what), GLOSS for AEI / BI, and the two
  // it has no row for: n_species (Miguel's "BirdNET species per minute", P45) and Anthro (maad's
  // AnthroEnergy band, 0–2 kHz: lab/LEGEND_REFERENCE.md §4.3). On water Bio names its band (the water (i):
  // 1–8 kHz), not "the birdsong range" - a hydrophone, as GLOSS's BI does. STATIC strings; null = none.
  // Separate from GLOSS on purpose: a GLOSS entry also glosses the roses' and linear's picker.
  const AXIS_ROW = { ACI: "clave.index.aci", Ht: "clave.index.bright", Bio: "clave.index.bioenergy",
                     NBPEAKS: "clave.index.nbpeaks" };
  const AXIS_WORDS = { n_species: "BirdNET species per minute", Anthro: "energy below about 2 kHz" };
  function axisName(k, ch) {
    if (k === "Bio" && ch === "water") return "Bio · energy in the 1–8 kHz range";
    if (Object.prototype.hasOwnProperty.call(AXIS_WORDS, k)) return k + " · " + AXIS_WORDS[k];
    const r = Object.prototype.hasOwnProperty.call(AXIS_ROW, k) ? ROWS.find(x => x.id === AXIS_ROW[k]) : null;
    return r ? r.name + " · " + r.what : gloss(k, ch);
  }
  // what the picked index IS on each view that has a picker (the SEE key's line, AEI / BI only)
  const INDEX_KEY = { "rose.html": "radius", "linear.html": "height" };
  // WHICH PROPERTY OF A MOMENT THE HUM FOLLOWS, in the words the sidebar uses (SOUND · DRONE
  // READING). Default = gradient (Miguel 2026-09-24: "keep gradient for the drone"). The old
  // STAT_NOTE / STAT_COST paragraphs (what "read twice" costs) are in LEGEND_REFERENCE.md.
  const STAT_LINE = {
    gradient: "the hum follows <b>gradient</b> — how fast the soundscape is changing",
    variance: "the hum follows <b>variance</b> — how much the soundscape's measures disagree",
  };
  // The time-of-day colours. diel.js owns them, but linear.html does not load diel.js, so this
  // falls back to the same four values (linear.html's PHASE_COLOR, which diel.js copies).
  const DIEL_FALLBACK = { ORDER: ["dawn", "day", "dusk", "night"],
    COLOR: RWLook.phase };                  // per look (looks.js), the same object diel.js uses
  function dielSwatches() {
    let D = window.DIEL;
    if (!D || !Array.isArray(D.ORDER) || !D.COLOR) D = DIEL_FALLBACK;
    return D.ORDER.map(w => `<span class="sw" style="background:${String(D.COLOR[w] || "#888").replace(/[^#0-9a-zA-Z]/g, "")}"></span>${w}`)
      .join(" &nbsp;");
  }
  function buildSee() {
    const view = here(), v = VIEWS[view] || null, hv = HOUR_VIEWS[view];
    const pageChan = () => (opts.channel ? opts.channel() : "air");   // the channel the page draws
    // P52 (2026-10-01): the hydrophone's probable recorder-fault days (findings/14) - one line, on water, with the mark
    const faultLine = pageChan() === "water" && (window.RW_FAULTS || []).length
      ? `<div class="lrow"><svg width="12" height="12" viewBox="-6 -6 12 12" style="vertical-align:-1px;margin-right:6px;overflow:visible">`
        + `<path d="M-3.5,-3.5L3.5,3.5M3.5,-3.5L-3.5,3.5" fill="none" stroke="var(--rw-casing)" stroke-width="3.4" stroke-linecap="round"/>`
        + `<path d="M-3.5,-3.5L3.5,3.5M3.5,-3.5L-3.5,3.5" fill="none" stroke="var(--rw-fault)" stroke-width="1.6" stroke-linecap="round"/></svg>`
        + `probable recorder fault (findings/14)</div>` : "";
    const s = stat();                                   // the shipped default — must track WC.statPref()
    const dim = 'style="color:var(--dim,#67708c)"';
    // THE KEY IS PER VIEW, because the views do not share an encoding (review 2026-09-26):
    // linear colours its dots by TIME OF DAY and its lines by month; roses have no size channel;
    // only scatter and biplot size a dot by species (r = rSize(nsp)). A trace is drawn in the
    // per-trace palette colour (WC.traceColor; first trace #9fb4e6) with a gold glow - gold is
    // not the ring itself, so the swatches below are palette-blue.
    const TRACE_BLUE = RWLook.d.t0;          // the first slot, per look
    // P56: colour by YEAR on the scatter and the biplot (rewild_colorby; the weather lens, when on, colours instead)
    const yearsOn = (view === "index.html" || view === "biplot.html") && (() => { try {
      return localStorage.getItem("rewild_colorby") === "years" && (localStorage.getItem("rewild_colormode") || "month") === "month";
    } catch (e) { return false; } })();
    const CL = RWLook.d.cluster || [];
    const colourKey = view === "linear.html"
      ? `<div class="lrow">${dielSwatches()}</div>
         <div class="lrow"><span class="sw" style="height:2px;vertical-align:3px;background:${TRACE_BLUE}"></span>line colour = one per <b>month</b> you compare</div>`
      : (yearsOn
          ? `<div class="lrow">colour = <b>year</b>${[2023, 2024, 2025, 2026].map(y => `<span class="sw" style="background:var(--rw-year-${y});border-radius:50%;margin:0 3px 0 7px"></span>${y}`).join("")}</div>`
          // the biplot's dots wear their GROUP (k-means or dbscan), never their month: the line said "month" until P56
          : view === "biplot.html"
            ? `<div class="lrow"><span class="sw" style="background:linear-gradient(90deg,${CL[0]} 0 33%,${CL[1]} 33% 66%,${CL[2]} 66%)"></span>colour = <b>group</b> (k-means or dbscan: the CLUSTERS list)</div>`
            : `<div class="lrow"><span class="sw" style="background:var(--rw-months)"></span>colour = <b>month</b> (seasons line up across years)</div>`) +
        // the SIZE is BirdNET species per minute (n_species_analysed since 2026-09-29), in the biplot's size key's
        // words (2026-10-01; it said "number of species"). Water has no BirdNET: its dots are one size and never
        // hollow, so neither line is claimed there (the page's channel: this is what the picture shows)
        ((view === "index.html" || view === "biplot.html") && pageChan() !== "water"
          ? `<div class="lrow">● small ▸ ● large = <b>BirdNET species per minute</b></div>` : "") +
        (view === "index.html" && pageChan() !== "water"
          ? `<div class="lrow"><i style="background:none;border:1.5px solid var(--rw-partial)"></i>hollow = <b>no species count</b> (BirdNET could not read that audio)</div>` : "");
    const key = hv
      // ---- hour-of-day views: spectro, mfcc ----
      ? `<div class="lrow">${dielSwatches()}</div>
         <div class="lrow" ${dim}>the strip on top = the time of day you hear — the only thing that changes the sound here</div>
         <div class="lrow">height (${hv}) = never changes the sound</div>
         <div class="lrow"><span class="sw" style="background:repeating-linear-gradient(45deg,var(--rw-hatch-key) 0 2px,transparent 2px 4px)"></span>hatched = not recorded</div>
         <div class="lrow"><span class="sw" style="background:var(--rw-why);opacity:.35"></span>faded = little recording behind that cell</div>
         <div class="lrow"><b>month strip</b> = picks the one month drawn</div>
         <div class="lrow"><b>month / day</b> = the month's average hours, or one day's own 24</div>
         <div class="lrow"><i style="background:none;border:2px solid ${TRACE_BLUE};border-radius:2px"></i>coloured frame = <b>traced</b> (this month or day)</div>
         <div class="lrow"><i style="background:none;border:2px dashed ${TRACE_BLUE};border-radius:2px"></i>dashed frame = <b>echo</b>: traced in another year</div>
         <div class="lrow"><i style="background:linear-gradient(90deg,var(--rw-partial) 50%,transparent 50%);border:1px solid var(--rw-partial)"></i>half-filled dot on the month strip = a <b>partial month</b></div>`
      // ---- dot views: scatter, roses, biplot, linear ----
      : colourKey +
        `<div class="lrow"><b>month grid</b> = which months you see · <b>all</b> = the whole record</div>
         <div class="lrow"><i style="background:none;border:2px solid ${TRACE_BLUE};box-shadow:0 0 5px var(--rw-gold)"></i>glowing ring = <b>traced</b> (shift-press to trace)</div>
         <div class="lrow"><i style="background:none;border:1.5px dashed ${TRACE_BLUE}"></i>dashed ring around ${view === "rose.html" ? "a rose" : "a dot"} = <b>echo</b>: the same time, another year</div>
         <div class="lrow"><i style="background:linear-gradient(90deg,var(--rw-partial) 50%,transparent 50%);border:1px solid var(--rw-partial)"></i>half-filled = a <b>partial month</b> (a time of day missing, or few hours)</div>${
           view === "rose.html" ? `
         <div class="lrow"><svg width="12" height="12" viewBox="-6 -6 12 12" style="vertical-align:-1px;margin-right:6px;overflow:visible"><circle r="3.8" fill="none" stroke="var(--dim,#67708c)" stroke-width="1"/><path d="M0,-2.3V0H1.9" fill="none" stroke="var(--dim,#67708c)" stroke-width="1" stroke-linecap="round"/></svg>clock beside a time of day = <b>worth opening hour by hour</b> (24 hours): its hours differ more than the times of day do</div>` : ""}${
           view === "linear.html" ? `
         <div class="lrow"><span class="sw" style="height:3px;vertical-align:3px;background:${TRACE_BLUE}"></span>a traced <b>month</b>: coloured frame (one month) or bold line (months compared) · dashed = its echo</div>` : ""}${
           view === "biplot.html" ? `
         <div class="lrow"><i style="background:var(--rw-anom-wash);border:1px dashed var(--rw-anom-edge)"></i>dashed edge on the dot itself = <b>anomaly</b> (fault)</div>` : ""}
         <div class="lrow"><i style="background:none;border:2px solid var(--rw-cursor)"></i><span class="lcurword"></span> = <b>cursor</b> — where the sound is</div>`;
    // the picked index, when it carries a gloss (AEI, BI): the name bold, the gloss's own words after
    // it - both from the static GLOSS table, never the key the page holds
    const ig = (INDEX_KEY[view] && opts.index) ? gloss(opts.index(), opts.channel ? opts.channel() : "air") : null;
    const cut = ig ? ig.indexOf(" · ") : -1;
    const indexLine = cut > 0
      ? `<div class="lrow" style="margin-bottom:8px">${INDEX_KEY[view]} = <b>${ig.slice(0, cut)}</b> · ${ig.slice(cut + 3)}</div>` : "";
    d3.select("#rwleg-see").html(
      (v ? `<div class="lrow" style="margin-bottom:8px"><b>${v[0]}</b> · ${v[1]}</div>` : "") + indexLine + key + faultLine +
      `<div class="lsub" style="margin:12px 0 4px">sound</div>
       <div class="lrow"><b>drone</b> · the low hum</div>
       <div class="lrow"><b>clave</b> · the woodblock tick</div>
       <div class="lrow"><b>arp</b> · a chord, one note per species</div>
       <div class="lrow"><b>corpus</b> · real recordings from Knepp</div>
       <div class="lrow" ${dim}>drone + clave follow the acoustic measures · arp + corpus follow BirdNET${tchan() === "water" ? " — air only, so silent on water" : ""}</div>
       <div class="lrow" style="margin-top:6px">${STAT_LINE[s]}</div>`);
  }
  function toggle(force) {
    closeTip();                                         // never leave a popover behind
    releaseHold("the panel was toggled");               // and never leave a preview running
    open = force !== undefined ? force : !open;
    panel.classList.toggle("open", open);
    document.body.classList.toggle("rwleg-open", open);
    if (open) { buildCatalogue(); buildHear(); buildSee(); probe(); }
    watchPoint();
    if (opts.onToggle) opts.onToggle(open);             // host reflows the viz
  }
  function toggleMute() {
    muted = !muted; send({ cmd: "mute", value: muted ? 1 : 0 });
    if (opts.soundBtn) { opts.soundBtn.textContent = muted ? "SOUND: OFF" : "SOUND: ON"; opts.soundBtn.classList.toggle("on", !muted); }
  }

  return {
    init(o) {
      opts = o || {}; buildPanel();
      window.addEventListener("keydown", e => {
        // Escape drops a live hold first, then a pinned popover - and only those. It must
        // never be the gesture that also shuts the panel out from under the reader.
        if (e.key === "Escape" && HELD) { e.stopPropagation(); releaseHold("escape"); return; }
        if (e.key === "Escape" && tipEl) { e.stopPropagation(); closeTip(); return; }
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        const t = e.target; if (t && /INPUT|SELECT|TEXTAREA/.test(t.tagName)) return;
        if (e.key === "l" || e.key === "L") toggle();
      });
      // a click anywhere off the (i) and off the popover dismisses a pinned one
      window.addEventListener("pointerdown", e => {
        if (!tipEl) return;
        if (tipEl.contains(e.target) || (tipOwner && tipOwner.contains(e.target))) return;
        closeTip();
      }, true);
      if (opts.soundBtn) { opts.soundBtn.textContent = "SOUND: ON"; opts.soundBtn.onclick = toggleMute; }
    },
    toggle, toggleMute, isOpen: () => open,
    onBridge,                                            // the host may route C1/C2 here
    // page calls after data / pins / prefs change. The reading may have moved, which changes
    // which drone row offers the middle chip and which two rows carry the twin marker.
    refresh() { if (open) { buildCatalogue(); buildHear(); buildSee(); probe(); } },
    // the SEE key alone, for a change that only moves the picture (the index picker): no probe, no
    // HEAR rebuild (which would release a held chip) - nothing is sent
    see() { if (open) buildSee(); },
    gloss,                                               // the index picker's plain words (GLOSS)
    axisName,                                            // the scatter's axes in plain words (P44)
  };
})();
