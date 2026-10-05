#!/usr/bin/env python3
"""dark_re_wilding - the bridge's COOKING, without its sockets (web Phase 1, 2026-10-01).

Plan: lab/WEB_PLAN.md (P1, section 3.3). Decision: lab/DECISIONS.md 2026-10-01. Hand-off to the web
session: viz/HANDOFF_WEB_2026-10-01.md.

What decides what SuperCollider hears and what the pages are told back, and the state it keeps: the
navigation (a press -> a precomputed point -> /rw_drone /rw_clave /rw_arp /rw_corpus /rw_point), the
identity (/rw_identity, re-sent when the room, the level or the table channel changes), the rooms of
each open view and their owner (P35), the silence of a channel without tables, the drone reading
(stat), the mix and its echo, the master and its echo, the legend's push tier (/rw_preview: hold,
release, probe) and the routing of the page protocol. It was viz/bridge.py's body until 2026-10-01;
the code moved here as it was (the transport calls aside), so the three harnesses still compare it
byte for byte. viz/bridge.py is now the SHELL around it (HTTP, the WebSocket loop, python-osc, the
loaders, the GUI link) and the web version runs this same file in the browser (Pyodide). Hence:

  * STANDARD LIBRARY ONLY (bisect, hashlib, json, math, time), and importing it does nothing: no
    file, no socket, no print. (hashlib + json since P54 V1, 2026-10-04: the push tier's load-time
    check fingerprints each room's mode table; both are in Pyodide's stdlib.)
  * THE TRANSPORT IS INJECTED, never imported:
        bind(send_osc, send_json=None, broadcast=None, osc_live=None)  -> the binding it replaced
            send_osc(addr, args)    python-osc style. Every arg keeps its Python type - a float stays
                                    a float, an int an int - because python-osc (and the web's shim)
                                    picks the OSC type from it.
            send_json(client, d)    a reply to ONE page (a dict; the transport serialises it)
            broadcast(d)            an echo to EVERY page; None = send_json to each attached client
            osc_live()              optional: is there an engine to send to (the desktop: sc_client set)
  * THE DATA IS HANDED OVER as plain data, never read here (the desktop's loaders are in bridge.py):
        load_channel(ch, payload)           rows / returner / raw_series of one display channel
        load_tables(ch, stat, level, d)     one rw_tables_<level>_<stat>.json, its corpus as clip IDS
        load_push(ch, level, d)             one rw_push_<level>.json
        provide(init_payload=, spectral_day=, tables=, push=)   optional sources the core calls on
                                            demand (the desktop binds its loaders; the web need not)
  * THE PAGE PROTOCOL, synchronous; `client` is any hashable object (a websocket, a page id):
        attach(client)        a page connected   -> to it: init (if a source is bound), the master echo
        dispatch(client, m)   one page message   -> OSC out; replies to it; echoes to every page
        detach(client)        a page went away   -> its rooms go; a held legend chip is released

CLIP IDS. A corpus clip is named by its path RELATIVE TO darkdata/corpus/, POSIX, e.g.
"turdus_merula/turdus_merula_2023_03_0.wav" - in the tables' corpus, in RETURNER, and in /rw_corpus as
it leaves here. The desktop's send_osc joins the corpus root back on for SC (bridge.clip_path); the
web maps the same ids to its Opus files.
"""
from __future__ import annotations
import bisect
import hashlib
import json
import math
import time

# ---------------------------------------------------------------------------
# shared with the loaders (bridge.py takes these two from here)
# ---------------------------------------------------------------------------
DIEL_ORDER = ["dawn", "day", "dusk", "night"]   # the TIME order of a key's last part
NSP_COL = "n_species_analysed"                  # BirdNET richness, the column the push tier names
                                                # (why this column: bridge.py, above AX_COLS)

# ============================================================================
# THE TRANSPORT AND THE DATA SOURCES - injected, never imported (see the docstring)
# ============================================================================
_SEND_OSC = None         # send_osc(addr, args)
_SEND_JSON = None        # send_json(client, dict)
_BROADCAST = None        # broadcast(dict); None = send_json to every attached client
_OSC_LIVE = None         # osc_live() -> bool; None = live whenever send_osc is bound
_INIT_PAYLOAD = None     # init_payload(channel) -> the `init` dict        (desktop: bridge.init_payload)
_SPECTRAL_DAY = None     # spectral_day(msg) -> the `spectral_day` reply   (desktop: bridge.spectral_day_reply)
_TABLES_SOURCE = None    # tables(ch, stat, level) -> a table dict, None if never built (bridge.read_rw_tables)
_PUSH_SOURCE = None      # push(ch, level) -> a side-file dict, None if never built     (bridge.read_rw_push)
CLIENTS: list = []       # the attached pages, oldest first (attach / detach)


def bind(send_osc, send_json=None, broadcast=None, osc_live=None) -> dict:
    """Inject the transport. Returns the binding it replaced, so a check can put it back:
    prev = bind(...); ...; bind(**prev)."""
    global _SEND_OSC, _SEND_JSON, _BROADCAST, _OSC_LIVE
    prev = {"send_osc": _SEND_OSC, "send_json": _SEND_JSON, "broadcast": _BROADCAST,
            "osc_live": _OSC_LIVE}
    _SEND_OSC, _SEND_JSON, _BROADCAST, _OSC_LIVE = send_osc, send_json, broadcast, osc_live
    return prev


def provide(init_payload=None, spectral_day=None, tables=None, push=None) -> dict:
    """Inject the data sources, all optional. Returns the ones it replaced: provide(**prev)."""
    global _INIT_PAYLOAD, _SPECTRAL_DAY, _TABLES_SOURCE, _PUSH_SOURCE
    prev = {"init_payload": _INIT_PAYLOAD, "spectral_day": _SPECTRAL_DAY,
            "tables": _TABLES_SOURCE, "push": _PUSH_SOURCE}
    _INIT_PAYLOAD, _SPECTRAL_DAY, _TABLES_SOURCE, _PUSH_SOURCE = init_payload, spectral_day, tables, push
    return prev


def _osc_ok() -> bool:
    """Is there an engine to send to? What `sc_client is not None` said before the split."""
    return _SEND_OSC is not None and (_OSC_LIVE is None or bool(_OSC_LIVE()))


def _reply(client, d: dict):
    """To ONE page: a legend reply, a spectral_day month, an init, the master on attach."""
    if _SEND_JSON is not None:
        _SEND_JSON(client, d)


def _broadcast(d: dict):
    """To EVERY page: the mix echo, the master echo."""
    if _BROADCAST is not None:
        _BROADCAST(d)
    elif _SEND_JSON is not None:
        for c in list(CLIENTS):
            _SEND_JSON(c, d)


# ============================================================================
# v2: the four-layer engine (drone + clave + arp + corpus).
# Replaces the v1 sends (/dark_nav bed+drone morph, /dark_arp ecological chord,
# /dark_corpus cloud, /dark_returner). Protocol and rationale: ../dev/README.md.
#
# Everything is PRECOMPUTED: dev/precompute/*.py writes one parquet per level, so the
# bridge only ever does dict lookups. That is what makes subsets a design-time decision
# rather than a navigation-time cost.
# ============================================================================
# THETA STATISTIC: which property of a month the drone's latitude encodes.
#   gradient = how fast this month is changing   variance = how internally varied it is
# DEFAULT = gradient (Miguel 2026-09-24, final: "ok, keep gradient for the drone :)"). A draft
# moved it to variance earlier the same afternoon and it was REVERSED; gradient never stopped
# shipping. variance stays fully selectable in SOUND - DRONE READING.
# WHAT THE DEFAULT COSTS, recorded rather than hidden: under gradient, subset year:2024 puts
# March at theta 1.8151 rad and July at 1.8500, 0.035 rad apart - HALF the median adjacent-month
# gap (0.070) - so two ecologically opposite months sit at the same latitude. Under variance they
# are 0.122 rad apart, 3.5x wider and above that reading's median gap (0.087). Miguel heard that
# pair as close at every contrast exponent ("in all of them diff btw march and july is thin" -
# confirmed to mean the DIFFERENCE IS SMALL, not that the sound thins out); a listener who wants
# it separated switches the reading, which is what the option is for.
# WHY GRADIENT STAYS ANYWAY: four slots over three near-independent statistics means the theta
# statistic is always read twice. Under gradient the doubling sits on the drone's LATITUDE and
# the clave's METRE - the two most perceptually separated channels. Under variance it would fall
# on latitude and TICK RATE, a much closer pairing. Keeping the doubled channels far apart beat
# widening one month pair; with three statistics and four slots there is no assignment without a
# doubling, only a choice of where it sits. Nothing else was re-assigned. See ../dev/README.md.
RW_STAT_DEFAULT = "gradient"              # the shipped default, kept separate from the live value
RW_STAT = RW_STAT_DEFAULT                 # theta statistic in force: gradient | variance
RW: dict = {}                             # level -> {"points","arp","corpus","ident"}
RW_SUBSET = {"L0": "all:2023-2026", "L1": "all:2023-2026"}
RW_LAST_IDENT = None                      # (table channel, level, subset, body key) actually sent
# THE TABLES ARE PER CHANNEL (2026-09-26). They used to be built from the AIR recorder only and
# RW had no channel, so navigating the WATER channel played air's drone, clave, BirdNET chord
# and bird clip for the same (date, window) - 2374 of 2379 water windows, a blackbird on water
# 2024-03. Air's tables stay exactly where they were (dev/data/); another channel's live in its
# own subfolder (dev/data/water/), built by the same precompute with `--channel water`.
# THE INVARIANT: the tables in force (RW and the push views) always belong to the channel of
# the LAST POINT PLAYED. They switch only inside rw_navigate, after the new point's key has
# resolved - never on a page's `channel` message - so select / stat / legend, which carry no
# channel, always act on the tables the listener is actually hearing.
RW_TCHAN = "air"                          # the channel whose tables are in force
RW_TABLE_CHANNELS = {"air"}               # channels with a complete set (both readings x both levels)


def _rw_table_channel(ch) -> str:
    """The TABLE channel a page channel plays. air+water is the relationship view built on
    air's rows (build_combined), so it plays air's tables, as spectral_day_reply already does."""
    ch = str(ch or "air")
    return ch if ch in ("air", "water") else "air"
# Level-dependent defaults (Miguel 2026-09-22): an L0 row is a month, so its species list
# is a top-20 over thirty days and its clip one recording standing for all of them. The
# months give you the acoustic character; the machine's claims arrive when you drill in.
RW_MIX_DEFAULTS = {"L1": [1.0, 1.0, 1.0, 1.0], "L0": [1.0, 1.0, 0.0, 0.0]}
RW_MIX = list(RW_MIX_DEFAULTS["L1"])
# Has the listener moved a fader? Level defaults are a SUGGESTION for a fresh session, not a
# rule that outranks a deliberate choice. Miguel set the clave to 0, changed the year, and the
# fader sprang back to 1 - because a level change re-applied the defaults over the top.
RW_MIX_USER = False


def _rw_level(lvl) -> str:
    return "L0" if int(lvl) == 0 else "L1"


_RW_CACHE: dict = {}                       # (channel, stat) -> the parsed tables, so a switch is a swap
_TABLE_DATA: dict = {}                     # (channel, stat, level) -> a table handed over (load_tables)
_PUSH_DATA: dict = {}                      # (channel, level) -> a push side file handed over (load_push)


def _rw_table_data(tch: str, stat: str, level: str):
    """One table as plain data: handed over (load_tables), else asked of the `tables` source
    (the desktop: bridge.read_rw_tables, which reads dev/data), else None (never built)."""
    t = _TABLE_DATA.get((tch, stat, level))
    if t is None and _TABLES_SOURCE is not None:
        t = _TABLES_SOURCE(tch, stat, level)
    return t


def _rw_tables(stat: str, tchan: str = None):
    """The parsed tables for ONE reading, cached, WITHOUT touching RW or RW_STAT.

    Split out of load_rw 2026-09-25 because the push tier needs to LOOK UP the reading the
    listener is not on - the drone row for the other statistic swaps one payload out of the
    other table - and doing that through load_rw would switch the live reading out from under
    them for the length of a hold. A read-only lookup must be a read-only lookup.

    STDLIB ONLY: the launcher resolves a Python that has websockets and python-osc but
    explicitly not pandas, so dev/precompute/rw_tables.py assembles these as JSON. Since
    2026-10-01 the JSON arrives as plain data (_rw_table_data: handed over with load_tables, or
    from the `tables` source - the desktop's bridge.read_rw_tables, its clip paths made ids).
    Returns None (and says so) if a table has not been built. `tchan` defaults to the channel
    in force, so every existing caller reads the tables the listener is hearing."""
    tch = tchan or RW_TCHAN
    if (tch, stat) in _RW_CACHE:
        return _RW_CACHE[(tch, stat)]
    # ATOMIC: build into a local and commit both levels or neither. A half-applied switch
    # would leave L0 on one statistic and L1 on the other, which is unfindable by ear.
    built = {}
    for level in ("L0", "L1"):
        t = _rw_table_data(tch, stat, level)
        if t is None:
            print(f"  [rw:{tch}:{level}] rw_tables_{level}_{stat}.json missing, layer silent (run "
                  f"dev/precompute/rw_tables.py{'' if tch == 'air' else ' --channel ' + tch})")
            return None
        arp, corpus = t["arp"], t["corpus"]
        if tch != "air" and (arp or corpus):
            # BirdNET exists only for the air recorder. A non-air table carrying chords or clips
            # was built by an older rw_tables.py that read air's parquets for every channel -
            # exactly the bug being fixed - so they are refused here, not played.
            print(f"  [rw:{tch}:{level}] *** {len(arp)} chords / {len(corpus)} clips in a {tch} "
                  f"table are AIR's BirdNET - dropped (rebuild with rw_tables.py --channel {tch})")
            arp, corpus = {}, {}
        built[level] = {"ident": t["ident"], "points": t["points"], "arp": arp, "corpus": corpus}
        print(f"  [rw:{tch}:{level}:{stat}] {len(t['ident'])} subsets · {len(t['points'])} points · "
              f"{len(arp)} chords · {len(corpus)} clips")
    _RW_CACHE[(tch, stat)] = built
    return built


def load_rw(stat: str = RW_STAT_DEFAULT, tchan: str = None):
    """Put one reading of one channel IN FORCE. Parses it if it has not been seen, then swaps.
    `tchan` defaults to the channel in force, so a stat switch keeps the listener's channel
    (it used to snap back to air - the only tables there were)."""
    global RW_STAT, RW_TCHAN
    tch = tchan or RW_TCHAN
    built = _rw_tables(stat, tch)
    if built is None:
        return False
    if tch != RW_TCHAN:
        # the observational caches are the in-force channel's: a channel switch empties them
        _RW_LEVEL_STATS.clear(); _RW_RHO.clear()
    RW.clear(); RW.update(built); RW_STAT = stat; RW_TCHAN = tch
    RW_TABLE_CHANNELS.add(tch)
    _rw_push_bind(tch)                   # the push views follow the tables in force
    _rw_apply_recipe()                   # ...and so do the body anchor + gates (P54, fix 2026-10-04)
    return True


def rw_send_identity(level: str, subset: str):
    """The subset's whole mode table, and the body it RESTS in. Sent ONLY when the
    selection changes.

    Since 2026-09-23 the message carries three arrays of n instead of two - freqs, amps and
    the subset's resting gains - with the mode count sent EXPLICITLY, because 6+2n and 6+3n
    collide for some n and a wrong guess would read the amps out of the middle of the freq
    block with no error anywhere. The resting gains are the per-mode geometric mean of the
    subset's own points, pinned (dev/precompute/sh_identity.py): the body a selection holds
    before any point inside it is committed, so landing on one is a rise out of how this
    selection typically rings rather than a redistribution inside a flat cube.

    THE ENGINE MUST BE RESTARTED after a table rebuild - an older `parse_dark_re_wilding.scd`
    infers the mode count from the message length and will refuse this message."""
    global RW_LAST_IDENT, RW_MIX
    if not _osc_ok() or level not in RW:
        return
    # THE CHANNEL IS PART OF THE IDENTITY: air's and water's `year:2024` are different bodies,
    # each tuned on its own channel's ruler (at L1 all:2023-2026's comb is 153.0 Hz on air and
    # 129.0 Hz on water; year:2024's 154.9 vs 93.9 Hz) - pitch compares within a channel only. Keyed on (level, subset) alone, the first water point
    # after an air one in the same room would play water's gains on AIR's mode table and comb.
    # THE READING'S BODY IS PART OF IT TOO (P54 V1, fix 2026-10-04). Pre-P54 the two readings of a
    # room shared one mode table and comb (only the resting gains differed), so (channel, level,
    # subset) named the body. Under V1 each reading has its OWN: the amps differ by up to ~295x
    # and the comb by up to 14 Hz (air L0), the freqs, base and clave base stay equal. Keyed
    # without it, a reading switch on a sounding point re-voiced the new reading's gains on the
    # OLD reading's amps, rings and comb until the room changed. So the key carries the body
    # (_rw_body_key: modes, comb, base, clave base - NOT the resting gains), and a reading change
    # whose body differs re-sends the room in the same burst as /rw_drone + /rw_point, as a room
    # change does. Where the two bodies are equal (every pre-P54 table, the archive rollback) the
    # key does not change and nothing extra is sent: the old stream, byte for byte.
    ident = RW[level]["ident"].get(subset)
    if ident is None:
        return
    body = _rw_body_key(ident)
    if (RW_TCHAN, level, subset, body) == RW_LAST_IDENT:
        return
    args = _rw_ident_args(level, subset, ident)
    try:
        _SEND_OSC("/rw_identity", args)
    except OSError:
        return
    if RW_LAST_IDENT is None or RW_LAST_IDENT[1] != level:
        # An L0 row is a month, so its species list is a top-20 over thirty days: the
        # inference and evidence layers start silent and the months give you the acoustic
        # character alone. SC holds the same table and would reach the same answer, but
        # SENDING it is what makes this side authoritative - two copies agreeing by
        # coincidence is how the browser's faders drifted out of step with the engine.
        # RW_MIX_USER decides what RW_MIX BECOMES, not whether SC is told: SC's identity
        # handler resets its mix to the level defaults on every level change
        # (parse_dark_re_wilding.scd ~198), so once the listener had moved a fader, a level
        # change left the engine on the defaults while the page showed the listener's values.
        # Re-sent AFTER the identity, so /rw_point reads the right mix.
        if not RW_MIX_USER:
            RW_MIX[:] = RW_MIX_DEFAULTS[level]
        rw_send_mix()
    RW_LAST_IDENT = (RW_TCHAN, level, subset, body)


def _rw_ident_args(level: str, subset: str, ident) -> list:
    """The /rw_identity arguments of one room's table ident - ONE copy of this arithmetic, used by
    rw_send_identity and by an off-reading hold's body load (P54 V1, rw_preview_hold), so a hold
    sends the other reading's room exactly as a reading switch would."""
    modes = ident["modes"]                       # [[freq, amp], ...]
    # An older table has no resting body; all-ones is exactly the previous behaviour, so the
    # fallback is silent and correct. Clamped like the point gains are, because a NaN in
    # setn(\gains, ...) corrupts the body for as long as it is held.
    rest = ident.get("rest") or [1.0] * len(modes)
    rest = [float(g) if isinstance(g, (int, float)) and g == g and abs(g) != float("inf")
            else 1.0 for g in rest][:len(modes)]
    rest += [1.0] * (len(modes) - len(rest))
    args = [level, subset, float(ident["comb"]),
            float(ident["base_freq"]), float(ident["clave_base"]), int(len(modes))]
    args += [float(m[0]) for m in modes] + [float(m[1]) for m in modes] + rest
    return args


def _rw_body_key(ident) -> str:
    """What a room's /rw_identity puts in the engine's BODY - its modes (freqs, amps; the rings
    follow from the amps), comb, base and clave base - as one short key. The resting gains are
    left out on purpose: they differ between the readings on every table (pre-P54 too) and only
    matter before a point is committed, which rw_set_stat's resting branch already handles."""
    blob = json.dumps([ident.get("modes"), ident.get("comb"), ident.get("base_freq"),
                       ident.get("clave_base")], separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


# WHICH LAYERS A LEGEND ROW IS ENTITLED TO SOUND - the table is RW_ROW_SPEC, further down.
# The locked layer contract (lab/, 2026-09-21; restated at the head of the SC engine) is:
# the CONTINUOUS pair (drone + clave) is the acoustic INDICES, and the DISCRETE pair
# (arp + corpus) is BIRDNET - an inference and its evidence. A legend row names ONE
# quantity and asks what it does to the sound, so it may only sound the layers that
# quantity actually drives.
# THE CORPUS IS IN NO ROW. It is a field recording: evidence for one specific window,
# not a mapping of anything. Worse, it is CONSTANT across the very A/B a row makes -
# both ends play the same focal clip and the same month's returner - so it contributes a
# large, salient difference that carries no information about the quantity named.
# Miguel, driving it: "there is corpus playing which should no be there".
# Since 2026-09-25 that is STRUCTURAL rather than a rule kept by hand: a preview no longer
# passes through this function at all, and /rw_preview has no corpus verb to misuse.


def rw_send_point(level: str, key: str):
    """The four state messages, then the commit. Order between them does not matter;
    /rw_point is what makes them sound, so a half-delivered point cannot be played.

    NAVIGATION ONLY since 2026-09-25. The legend's preview used to come through here with a
    `preview` flag that withheld layers; it now has its own delivery (/rw_preview) because
    this function RESTARTS THE NAVIGATION TIMELINE - ~rwClaveIn silences the tick for 2 s and
    the arp's first note lands 3.2-5.2 s in - so a hold on a clave or arp row was an A/B of
    two silences rather than of two ticks. See the push tier below for the full argument and
    for why a second DELIVERY of the same numbers is not a second cooking function."""
    if not _osc_ok() or level not in RW:
        return
    # A NAVIGATION ENDS ANY HOLD. Pressing a new point with a finger still down would
    # otherwise leave the preview chord ringing and a forced clave running under a point
    # that asked for neither. Sent BEFORE the state messages, so SC's preview cleanup cannot
    # land on top of the commit it is meant to precede.
    rw_preview_abort()
    subset = RW_SUBSET[level]
    tbl = RW[level]
    pt = tbl["points"].get(f"{subset}@{key}")
    if pt is None:                                  # fall back to the whole-dataset room
        subset = "all:2023-2026"
        pt = tbl["points"].get(f"{subset}@{key}")
        if pt is None:
            return
        # Write the fallback back, or the room flip-flops: RW_SUBSET is one process-global,
        # so a stale `year:2024` made every non-2024 point jump to `all` and every 2024 point
        # jump back, an unexplained retune mid-navigation that no user action asked for.
        print(f"  [rw] {level} {key} not in {RW_SUBSET[level]} -> falling back to {subset}")
        RW_SUBSET[level] = subset
        if level in (_RW_CLIENT_ROOM.get(RW_ROOM_OWNER) or {}):   # the playing view's room (P35)
            _RW_CLIENT_ROOM[RW_ROOM_OWNER][level] = subset
    rw_send_identity(level, subset)
    theta, pressure, rate, formant, accent = pt[0], pt[1], pt[2], pt[3], int(pt[4])
    # NaN reaching scsynth's setn(\gains, ...) corrupts the body for as long as it is held.
    # 26 L0 points ship with NaN gains (24-mode subsets padded to 35 with NaN, not 0).
    gains = [g if isinstance(g, (int, float)) and g == g and abs(g) != float("inf") else 0.0
             for g in pt[5:]]
    chord = tbl["arp"].get(f"{subset}@{key}")
    gap, notes = (chord[0], chord[1:]) if chord else (0.7, [])
    clip = tbl["corpus"].get(key)
    # The returner is the month's phenologically surprising species - a bird back after an
    # absence, or a first record. v1 gave it its own voice and the v2 port dropped it.
    # The returner is a MONTHLY concept: a species phenologically surprising across the
    # deployment, not within one diel window. So an L1 window inherits its month's returner,
    # which is the right reading - the news of that month, heard while you stand in one of
    # its windows.
    ret = None
    rm = (RETURNER.get(RW_TCHAN) or {}).get("l0") or {}          # the table channel's own
    parts = key.split("|")
    if len(parts) >= 2:
        ret = rm.get(f"{int(parts[0])}-{int(parts[1]):02d}")
    if ret == clip:
        ret = None                      # never double the same recording
    try:
        _SEND_OSC("/rw_drone", [theta, pressure] + gains)
        _SEND_OSC("/rw_clave", [rate, formant, accent])
        arp_args = [gap, len(notes)]
        for f, a, c in notes:
            arp_args += [f, a, c]
        _SEND_OSC("/rw_arp", arp_args)
        _SEND_OSC("/rw_corpus",                       # clip IDS; the desktop shell joins the root
                  ([clip] + ([ret] if ret else [])) if clip else [])
        _SEND_OSC("/rw_point", [])
    except OSError:
        pass
    _rw_unsilence()                     # a real commit ends a silenced (table-less) channel
    # WHEN this point committed, and the chord it committed - the only two things the
    # arp.beating row needs to decide between a gapless \cert set on the ringing chord and a
    # fresh preview chord. See _rw_chord_ringing.
    _rw_mark_commit(rate, accent, gap, len(notes))


def rw_navigate(lvl, channel, mkey=None, widx=None, win=None, client=None):
    """Resolve a browser hover to a precomputed point key and voice it - from the tables of
    the channel the point BELONGS TO. The tables switch here, after the key has resolved, and
    nowhere else (the invariant above RW_TCHAN). `client` = the view that pressed it: it takes
    the sound, and its rooms come into force - also only once the key has resolved, so a press
    that names no point hands nothing over (TASKS P35)."""
    global RW_LAST_POINT
    level = _rw_level(lvl)
    tch = _rw_table_channel(channel)
    T = _rw_tables(RW_STAT, tch) if tch in RW_TABLE_CHANNELS else None
    if T is None:
        # No tables for this channel: SILENT, with a reason - never air's point under a water
        # label, which is the bug this replaced.
        _rw_missing_channel(tch)
        _rw_silence()
        return
    if mkey is not None:                            # L0: "YYYY-MM" (+ optional diel window)
        try:
            y, m = str(mkey).split("-")
            key = f"{int(y)}|{int(m)}"
        except (ValueError, AttributeError):
            return
        # THE KEY COLLAPSE. The scatter opens at month resolution and draws 119 points -
        # every month's dawn, day, dusk and night, in four facets - but an L0 key was only
        # ever "year|month", so 85 of those 119 points sent a BIT-IDENTICAL drone, clave, arp
        # and corpus while the readout beside them showed visibly different indices. That is
        # the whole of "I don't hear a difference when I navigate the data points".
        # A view that knows which diel window it is on now says so, and gets its own point.
        if win:
            k2 = f"{key}|{str(win).strip().lower()}"
            if level in T and f"{RW_SUBSET[level]}@{k2}" in T[level]["points"]:
                key = k2
            elif level in T and f"all:2023-2026@{k2}" in T[level]["points"]:
                key = k2
    elif widx is not None:                          # L1: index into the channel's rows
        rws = (CHANNELS.get(channel) or {}).get("rows", [])
        i = int(widx)
        if not (0 <= i < len(rws)):
            return
        r = rws[i]
        key = f"{r['y']}|{r['m']}|{r['d']}|{r['win']}"
    else:
        return
    if client is not None:
        rw_client_point(client)
    if tch != RW_TCHAN:
        print(f"  [rw] tables -> {tch} ({RW_STAT})")
        load_rw(RW_STAT, tch)
    RW_LAST_POINT = (level, key)
    rw_send_point(level, key)


def _rw_in_room(level, key, subset=None):
    """Is the point `key` a member of the room in force at `level` (or of `subset`)?"""
    T = RW.get(level)
    return bool(T) and f"{subset or RW_SUBSET[level]}@{key}" in T["points"]


def rw_resting() -> bool:
    """THE DRONE IS RESTING IN A ROOM WITH NO POINT OF ITS OWN (TASKS P20): the selection moved
    to a room the standing point is not a member of, and nothing inside it has been pressed yet.
    What sounds is that room's resting body under the last point's clave, arp and corpus."""
    return RW_LAST_POINT is not None and not _rw_in_room(*RW_LAST_POINT)


def rw_select(lvl, subset):
    """A SELECTION change - which precomputed room is in force at a level.

    Subsets are a design-time decision, locked during navigation, so this only picks which
    precomputed identity is in force. The drone IS the selection (DISPLAY_DESIGN 8.1), so a
    change on the level the listener is standing on retunes the room NOW:
      - the standing point is a MEMBER of the new room -> it is re-voiced there. Re-voicing
        rather than only retuning, because a subset owns theta, pressure, all 35 gains, the
        clave triple and the arp chord, not just the comb.
      - it is NOT a member (a month of another year picked in linear, a year button in the
        scatter or biplot) -> the new room's IDENTITY alone: the drone retunes to the room and
        rests on its own body - the state /rw_identity's resting gains were built for, "the
        body a selection holds before any point inside it is committed" - and the next point
        lands in it. TASKS P20: this used to re-voice the point anyway, which fell back to
        all:2023-2026 AND wrote that back, so the room the listener chose was lost for good
        and every later point sounded in `all`.
      - an UNKNOWN room (no such identity in these tables, e.g. L0 year:2026) keeps the old
        behaviour: the re-voice falls back to all:2023-2026 and says so.
    Only the ACTIVE level is retuned. The scatter sends this for BOTH levels on every year
    click; an identity pushed at the other level reads as a level CHANGE and reset the mixer.
    Updating RW_SUBSET is enough for the level you are not on; it takes effect the moment you
    drill into it."""
    lv = _rw_level(lvl)
    new = str(subset or "all:2023-2026")
    if RW_SUBSET[lv] == new:
        return
    level, key = RW_LAST_POINT if RW_LAST_POINT else (None, None)
    on_active = lv in RW and lv == level
    resting = on_active and new in RW[lv]["ident"] and not _rw_in_room(lv, key, new)
    # A HOLD ENDS on any selection change: it is about a point inside a selection. When a
    # commit follows (the standing point re-voiced in its new room) that commit sets
    # everything, so the hold is simply aborted. When NONE follows - a room the point is not in,
    # or the level you are not on (TASKS P24: the pushed drone used to stay stranded) - it is
    # RELEASED, which gives back the listener's own drone and clave first. Before RW_SUBSET
    # moves, because the release looks the point up in the room it was held in.
    if on_active and not resting:
        rw_preview_abort()
    elif RW_PREVIEW is not None:
        rw_preview_release()
    RW_SUBSET[lv] = new
    print(f"  [rw] selection {lv} -> {new}")
    if not on_active:
        return
    if resting:
        print(f"  [rw] {lv} {key} is not in {new} -> resting in {new} until a point in it is pressed")
        rw_send_identity(lv, new)
        return
    rw_send_point(lv, key)


# EACH OPEN VIEW HAS ITS OWN ROOMS; THE VIEW WHOSE POINT IS SOUNDING OWNS THE DRONE (TASKS P35).
# RW_SUBSET is one room per level for the whole bridge, and every open page sends `select` - so
# with two views open in two tabs the LAST ONE TO SEND won, even from a tab nobody was looking at
# (a background linear re-sends its room on every SHOWN change made in another tab), and a page's
# own room dedupe went stale behind its back. The same answer as the channel's (DISPLAY_DESIGN
# 8.4, "the sound follows the channel of the last point played"): the room follows the VIEW of
# the last point played. A select from the owner - or from anyone while nobody owns the sound -
# retunes now (rw_select); a select from any other view is remembered for it, and comes into
# force the moment a point is pressed there. A PAGE THAT OPENS WHILE NOBODY OWNS THE SOUND TAKES
# IT: the design's own view links reload the page, so switching views in the playing tab closes
# the owner and opens its successor - which must inherit the sound, or for the moment until its
# first press any background tab's select (linear re-sends on every SHOWN change) would retune the
# drone again (review 2026-09-27). The first page to open after a start takes it the same way.
_RW_CLIENT_ROOM = {}         # client -> {"L0": subset, "L1": subset}: the rooms each view asked for
RW_ROOM_OWNER = None         # the client whose point is sounding; its rooms are RW_SUBSET


def rw_client_select(client, lvl, subset):
    """A `select` from one open view (see above)."""
    lv = _rw_level(lvl)
    new = str(subset or "all:2023-2026")
    _RW_CLIENT_ROOM.setdefault(client, {})[lv] = new
    if RW_ROOM_OWNER is None or RW_ROOM_OWNER is client:
        rw_select(lvl, new)
    elif RW_SUBSET[lv] != new:
        print(f"  [rw] selection {lv} -> {new} kept for a view that is not playing")


def rw_client_point(client):
    """A point from `client` is about to be voiced: it now owns the sound, and its rooms come
    into force first - assigned, not re-voiced, because the point that follows lands in them."""
    global RW_ROOM_OWNER
    RW_ROOM_OWNER = client
    for lv, sub in (_RW_CLIENT_ROOM.get(client) or {}).items():
        if RW_SUBSET.get(lv) != sub:
            print(f"  [rw] this view plays now: {lv} room -> {sub}")
            RW_SUBSET[lv] = sub


def rw_client_new(client):
    """A page opened (see above): it takes the sound if nobody holds it."""
    global RW_ROOM_OWNER
    if RW_ROOM_OWNER is None:
        RW_ROOM_OWNER = client


def rw_client_gone(client):
    """A closed page gives up the sound and its rooms. The page that opens next takes it
    (rw_client_new); if none does (the tab was closed), any remaining view's select retunes
    until one of them presses a point."""
    global RW_ROOM_OWNER
    _RW_CLIENT_ROOM.pop(client, None)
    if RW_ROOM_OWNER is client:
        RW_ROOM_OWNER = None


_RW_MISSING_SAID: set = set()
_RW_SILENCED = False


def _rw_silence():
    """A channel without tables must be HEARD as silent. Sending nothing is not silence: the
    drone is a persistent body and the corpus runs until the next commit, so the last AIR point
    kept sounding under the water cursor - and a select or a stat switch re-voiced it. The last
    point is dropped (select / stat / legend then have nothing of air's to act on) and SC gets a
    zero mix; the listener's own faders (RW_MIX) are untouched."""
    global RW_LAST_POINT, _RW_SILENCED
    RW_LAST_POINT = None
    if _RW_SILENCED:
        return
    rw_preview_abort()
    _RW_SILENCED = True
    rw_send_mix()


def _rw_unsilence():
    global _RW_SILENCED
    if _RW_SILENCED:
        _RW_SILENCED = False
        rw_send_mix()


def _rw_missing_channel(tch: str):
    if tch in _RW_MISSING_SAID:
        return
    _RW_MISSING_SAID.add(tch)
    print(f"  [rw] *** no {tch} tables - {tch} navigation is SILENT. Build them (dev/README.md): "
          f"sh_identity.py <gradient|variance> <L1|L0> --channel {tch} (all four), then "
          f"rw_tables.py --channel {tch}, then rw_push.py --channel {tch}.")



# ---- the perceptual legend, TIER 2: THE PUSH -------------------------------------------
# "For the point I am standing on, what would this ONE quantity do to the sound if it were
# pushed to its extreme?" Everything else is held at the listener's own values - their point,
# their selection, their level, their mix. EXACTLY ONE VARIABLE MOVES. (dark_skyr shipped the
# other convention, "all else neutral", and users were confused; it moved to "your current
# sound, one driver pushed" - dark_skyr/lab/WORKLOG.md:473-479.)
#
# WHY THE PREVIOUS TIER FAILED, measured. It offered "ONE INDEX, less/more" and answered by
# playing two REAL WINDOWS that differ in all sixteen indices. Worse, theta ranks a mean of
# |differences|, so pushing an index to EITHER extreme moves the body the SAME WAY: the axis
# is FOLDED in half. Sign test, 400 rows x 16 columns: theta 0.052 down / 0.981 up, folded on
# 16 of 16 columns. That is exactly why Miguel heard "less" and "more" as the same thing. The
# clave's colour escapes it because it ranks a MEAN, which is monotone in every term
# (0.994 / 0.999, SIGNED on 16 of 16).
#
# WHAT THE INSTRUMENT ACTUALLY READS - three row STATISTICS and one index, not sixteen:
#     drone  theta -> all 35 mode gains, comb decay, level .... rank of GRADIENT (shipped)
#     clave  tempo  (0.8-9 Hz) ............................... rank of VARIANCE
#     clave  colour (pulsaret formant, 841-1747 Hz) .......... rank of the MEAN of the sixteen
#     clave  metre  (accent every 2-7 ticks) ................. rank of GRADIENT (the twin)
#     arp    density (note gap, faster = richer) .............. n_species_analysed
#     arp    pitch   (200-2000 Hz, log) ...................... rarity WITHIN this selection
#     arp    beating (detune on an unsure note) .............. BirdNET confidence
# So the tier is grouped BY LAYER (Miguel 2026-09-25: "so it is clear what we need to listen
# to for the data point we have selected and would like to hear how a different data
# feature(s) would alter the sound design"), and every row NAMES ITS DATASET COLUMN, the way
# the index rows already said ACI and Ht - a researcher must be able to go from a row to a
# column. That is what `column` in the reply is for.
#
# INTERVENTION IS NOT OBSERVATION, and the (i) has to carry both or the tier lies. Pushing
# ACI brightens the tick by 187 Hz (and darkens it by 149 the other way, 335 Hz end to end;
# LEGEND_REFERENCE §3.3) - and ACI predicts the
# colour at rho +0.007. Both are true; they answer different questions. `rho` in the reply is
# the OBSERVATIONAL Spearman, computed here per selection so the page hard-codes nothing.
# The mirror of it matters too: interventionally all sixteen columns are near-equal (295-360
# Hz end to end, the whole spread), because the colour is the mean of sixteen equally
# weighted columns. The chips teach a MECHANISM - one of sixteen, signed, additive - not a
# privileged causal role for the named index.
#
# WHY IT HAS ITS OWN DELIVERY (/rw_preview) AND WHY THAT IS NOT A SECOND COOKING FUNCTION.
# Manual C5 §19.2 asks for ONE cooking function and no private sound path. The numbers below
# come from the same tables through the same arithmetic - that has not changed. What changed
# is DELIVERY: /rw_point restarts the navigation timeline (parse_dark_re_wilding.scd:257-364),
# which forces ~rwClaveOn=false and brings the tick back only after ~rwClaveIn = 2.0 s, and
# lands the arp's first note at 3.2-5.2 s. Ten of the fifteen rows are clave rows, so on the
# commit path a hold reads: tick -> 2 s of silence -> tick at the new rate -> release -> 2 s
# of silence -> tick at the old rate. That is an A/B of two silences. The drone rows DO work
# on the commit path, because gains and combDecay are set before the Routine - which is the
# trap, because a smoke test looks fine. /rw_preview is a second delivery of the same state
# that does not restart a timeline. Keep that distinction or someone will "simplify" it back.
# It also closes the §19.2 violation completely and for free: a preview now never touches
# ~rwState, ~rwMix, ~rwSubset, the identity, the level or the navigation timeline, so there is
# nothing to save and nothing to give back, and RW_LEGEND_SAVED - the bracket that existed
# only to survive rw_send_identity's level-default branch - is gone with the forced level="L1"
# that armed it.
RW_FEATURES = ["aci", "bright", "balance", "bioenergy", "anthroenergy", "nbpeaks", "nsp"]
RW_FEATURE_LABEL = {
    "aci": "ACI", "bright": "Ht", "balance": "NDSI", "bioenergy": "Bio",
    "anthroenergy": "Anthro", "nbpeaks": "NBPEAKS", "nsp": "n_species", "bi": "BI",
}
RW_LAST_POINT = None                   # (level, key): the point the listener is standing on
RW_CHANNEL = "air"                     # the DISPLAY channel of the last drv (air | water | air+water);
                                       # the sound's tables are RW_TCHAN, which follows the point
# (level, channel) -> {feature: [(RAW value, key), ...]}, filled by load_channel (bridge.load_rows). `drv` is
# clamped to the 1st-99th percentile and ties about two dozen windows at each end, so it
# cannot express which of its tied maxima is the real record-holder; the ranking has to see
# the unclamped number. Read here for the level-wide richness range and the point's own
# n_species_analysed (a window BirdNET analysed no minute of has no entry). Never serialised -
# init_payload names every key it sends.
_RW_RAW_SERIES: dict = {}

# ---- CONSTANTS DUPLICATED FROM THE PRECOMPUTE ------------------------------------------
# THE ONE REAL COUPLING in this tier, flagged on both sides. If any of these moves in
# dev/precompute/, it must move here in the same commit, and the load-time self-check will
# NOT catch it (it checks ranks, not the maps the ranks feed).
#   sh_identity.py:72-76      PULSAR_HZ, CLAVE_FORMANT_SWING, CLAVE_ACCENT_RANGE
#   arp_species.py:85-113     GESTURE_MAX, GAP_POOR, DENSITY_CONTRAST, GAP_CLAMP,
#                             RICHNESS_REF, CONF_GATE
RW_PULSAR_HZ = (0.8, 9.0)              # the clave's tempo window, ticks per second
RW_CLAVE_SWING = 0.70                  # the row shifts the formant +/-35% inside the register
RW_ACCENT_RANGE = (2, 7)               # accent every N ticks: fast-changing -> 2, stable -> 7
# THE GAP LAW, 2026-09-26. It used to be a BUILD WINDOW divided by (n-1), which held the
# chord's duration constant however many notes it had - and that division was exactly what
# stopped "complexity earning length" (Miguel: "5 secs max if many notes, depending on the
# complexity of the chord"). The division is gone; the gap is now a pure function of richness
# and a BUDGET does the safety job the division used to do. assembly = (n-1) * gap, so a
# 3-note chord really is 2/7 the length of an 8-note one at the same richness, and the
# poorest full-slot chord spends exactly ASSEMBLY_MAX.
#     ASSEMBLY_MAX = 5.0 - sustain 1.2 - release 0.4 = 3.40 s
#     GAP_POOR = ASSEMBLY_MAX / (K_SLOTS - 1)   GAP_RICH = GAP_POOR / DENSITY_CONTRAST
#     gap(rich) = GAP_POOR + (GAP_RICH - GAP_POOR) * min(rich / RICHNESS_REF, 1)
RW_GAP_POOR = {"L1": 3.40 / 7.0, "L0": 3.40 / 19.0}    # 0.485714 / 0.178947
RW_DENSITY_CONTRAST = {"L1": 2.86, "L0": 1.49}         # the ratio the density row reports
RW_GAP_CLAMP = (0.10, 0.60)            # a safety net only - INERT, gap is a convex combination
                                       # of GAP_POOR and GAP_RICH, both strictly inside it
# The density reference. 9.7 WAS the observed max of n_species_mean; the corrected richness
# (n_species_analysed, 2026-09-29) reaches 10.14 in one window, which clamps to GAP_RICH - where the
# richest window sat before. Kept on purpose (the fix's decision: the change stays the data's).
RW_RICHNESS_REF = 9.7                  # == arp_species.RICHNESS_REF: move both or neither
RW_CONF_GATE = 0.50                    # Alice's detection gate, already applied at extraction
# SC's navigation timeline, duplicated ONLY to guess whether the listener's own chord is still
# ringing (parse_dark_re_wilding.scd ~rwClaveIn / ~rwArpFloor / ~rwArpSustain, and \rwPoint).
# Wrong by a second costs a respawn, not a wrong sound - but it had drifted: the sustain was
# still 0.8 after SC's plateau went to 1.2 s (2026-09-25), so for the last 0.4 s of every chord a
# beating hold respawned a preview chord instead of setting the ringing one (TASKS P36). Now
# checked against the .scd by verify_rw_preview.py.
RW_SC_CLAVE_IN, RW_SC_ARP_FLOOR, RW_SC_ARP_SUSTAIN = 2.0, 1.2, 1.2
RW_SC_BAR_CLIP = (0.25, 1.6)

# THE ONE MEASURED LOUDNESS ANCHOR, and it is an ANCHOR, not a curve. Sweeping the body's
# whole axis (theta 0 -> pi) moved 5.90 dB rms with 37.5 of 40 ERB/roex filters over 3 dB.
# d_db_est below LINEARISES that single point. The body is a Legendre function of theta and
# is certainly not linear in it, so every UI string built from this number must carry "~".
RW_DB_PER_PI = 5.90
# P54 V1 (2026-10-04): RE-MEASURED, with the method above (dev/renders/legend_hear/README.md s3:
# drone alone, one held state per render, 12 s after an 11 s settle, 40 ERB/roex filters
# 40-2000 Hz, six bow seeds paired; the rebuilt script reproduces the shipped 5.90 as 5.901 and
# the 0.60 null as 0.58). Under V1 the drone is a function of the row too, so the axis is each
# row's OWN content at rank 0 vs rank n-1 (a drone row's lo -> hi push), over 12 rows of
# all:2023-2026 L1 spread by gradient rank: 8.07-8.19 dB, median 8.085 -> 8.09. The matched
# nulls on the V1 states: 0.41 dB drone alone (540 pairs, worst 1.25) and 0.49 dB in the full
# mix (render_legend_layer's colour-grid null on the V1 resting body, 675 pairs, worst 1.13;
# the same harness gives 0.776 on the shipped body, the quoted 0.78). Linearising is CRUDER
# under V1 and the "~" is load-bearing: a row's own state to an end of the axis (the 24 drone
# pushes of those 12 rows) measured a median 4.6 dB MORE than the line says, and up to 12.8 dB
# where it says ~2.4 - near either end the ring approaches a pole, where only the zonal (m = 0)
# tones survive, so the last steps are steep. The body gate therefore errs towards "inaudible".
# Record: dev/renders/p54_options/meas/axis.json + mixnull_*.json, made by
# dev/precompute/p54/meas/meas_body.py (its README gives the run recipe); lab/DECISIONS.md P54 V1.
# The anchor and the body gates follow the RECIPE of the side file in force (_rw_apply_recipe),
# so pre-P54 tables (and the RW_WEIGHT_MODE=archive rollback) keep 5.90 / 0.102 / 0.132 exactly.
RW_ANCHOR_BY_RECIPE = {
    "archive":  {"db_per_pi": 5.90, "null_solo_db": 0.60, "null_mix_db": 0.78,
                 "solo": 0.102, "mix": 0.132},
    "own_band": {"db_per_pi": 8.09, "null_solo_db": 0.41, "null_mix_db": 0.49,
                 "solo": 0.051, "mix": 0.060},
}
RW_RECIPE = "archive"                      # the drone recipe of the push side file in force
# AUDIBILITY GATES. `basis` is on the wire because risk 5 of the brief is that a convention
# gets quoted as a finding. The body gates are the matched null re-bowing ONE state: 0.60 dB
# rms drone-alone and 0.78 dB in the full mix, converted through RW_DB_PER_PI (pre-P54; under
# P54 V1 0.41 / 0.49 dB through 8.09 - RW_ANCHOR_BY_RECIPE, applied by _rw_apply_recipe).
RW_GATES = {
    "body_solo": {"threshold": 0.102, "unit": "rank01", "basis": "measured",
                  "note": "0.60 dB rms matched null, drone alone"},
    "body_mix":  {"threshold": 0.132, "unit": "rank01", "basis": "measured",
                  "note": "0.78 dB rms matched null, full mix"},
    "colour":    {"threshold": 100.0, "unit": "cents", "basis": "measured"},
    "arp_gap":   {"threshold": 0.05, "unit": "ratio", "basis": "measured"},
    "tempo":     {"threshold": 1.15, "unit": "ratio", "basis": "convention",
                  "note": "not yet measured at the ear"},
    "cert":      {"threshold": 0.05, "unit": "cert", "basis": "convention",
                  "note": "not yet measured at the ear"},
    "metre":     {"threshold": 1, "unit": "ticks", "basis": "convention",
                  "note": "any integer change; not yet measured at the ear"},
}


def _rw_side_recipe(side) -> str:
    """The drone recipe one push side file was built with ("recipe" absent = 'archive')."""
    return ((side or {}).get("recipe") or {}).get("content_weight_mode") or "archive"


def _rw_apply_recipe(recipe: str = None) -> str:
    """Put the body anchor and the two body gates of a drone recipe in force (P54 V1). Called
    whenever the push side files are (re)derived AND whenever load_rw puts a channel's tables in
    force (a water press switches the channel; fix 2026-10-04 - the anchor used to stay the boot
    channel's). The recipe is the in-force channel's: the one its side files AGREE on - those
    whose derive passed, else every one loaded. Not "any level": side files that disagree
    (only reachable by re-deriving one level by hand; load_rw_push refuses a mixed set) fall
    back to 'archive' and say so. In place, so a reply's `gates` and every reader of RW_GATES see
    the same dict; under 'archive' every value is exactly the pre-P54 one."""
    global RW_DB_PER_PI, RW_RECIPE
    if recipe is None:
        live = {_rw_side_recipe(sd) for lv, sd in RW_PUSH.items()
                if sd is not None and RW_PUSH_OK.get(lv)}
        seen = live or {_rw_side_recipe(sd) for sd in RW_PUSH.values() if sd is not None}
        recipe = next(iter(seen)) if len(seen) == 1 else "archive"
        if len(seen) > 1:
            print(f"  [rw:push:{RW_TCHAN}] *** the side files in force name different drone "
                  f"recipes - body anchor + gates fall back to the pre-P54 values")
    a = RW_ANCHOR_BY_RECIPE.get(recipe) or RW_ANCHOR_BY_RECIPE["archive"]
    RW_DB_PER_PI = a["db_per_pi"]
    RW_RECIPE = recipe if recipe in RW_ANCHOR_BY_RECIPE else "archive"
    tail = "" if RW_RECIPE == "archive" else " (P54 V1 re-measure)"
    RW_GATES["body_solo"].update(threshold=a["solo"],
                                 note=f"{a['null_solo_db']:.2f} dB rms matched null, drone alone{tail}")
    RW_GATES["body_mix"].update(threshold=a["mix"],
                                note=f"{a['null_mix_db']:.2f} dB rms matched null, full mix{tail}")
    return RW_RECIPE

# ---- THE ROW VOCABULARY ------------------------------------------------------------------
# A CLOSED vocabulary: fifteen ids, and an unknown one is printed and ignored rather than
# guessed at. `family` decides which fader can block the row and which OSC verbs it sends;
# `stat` is which of the three row statistics it pushes (None for the arp rows, which push a
# BirdNET quantity instead).
# ACI AND ANTHRO STAY, undimmed, with an (i) that says the instrument barely reads them.
# Under a PUSH they are alive - ACI moves the colour 335 Hz end to end, Anthro 298 Hz - and
# the dead thing is not the row but four specific DIRECTIONS (Bio lo, Anthro lo, and weakly
# NDSI lo and Ht hi), which are dimmed per chip, per point, out of this reply's own
# `audible`, rather than from a global caption.
RW_ROW_SPEC = {
    "drone.gradient": {"family": "drone", "kind": "stat", "stat": "gradient",
                       "dirs": ("lo", "hi"),
                       "label": "gradient · how fast this window is changing"},
    "drone.variance": {"family": "drone", "kind": "stat", "stat": "variance",
                       "dirs": ("lo", "hi"),
                       "label": "variance · how much its sixteen disagree"},
    "clave.tempo":    {"family": "clave", "kind": "stat", "stat": "variance",
                       "dirs": ("lo", "hi"), "label": "tempo · variance"},
    "clave.colour":   {"family": "clave", "kind": "stat", "stat": "mean",
                       "dirs": ("lo", "hi"), "label": "colour · mean"},
    "clave.metre":    {"family": "clave", "kind": "stat", "stat": "gradient",
                       "dirs": ("lo", "hi"), "label": "metre · gradient"},
    "arp.density":    {"family": "arp", "kind": "arp", "arp": "density", "stat": None,
                       "dirs": ("lo", "hi"), "label": "density · n_species_analysed"},
    "arp.pitch":      {"family": "arp", "kind": "arp", "arp": "pitch", "stat": None,
                       "dirs": ("only_lo", "only_hi"),
                       "label": "pitch · rarity here (an ISOLATE, not a push)"},
    "arp.beating":    {"family": "arp", "kind": "arp", "arp": "beating", "stat": None,
                       "dirs": ("lo", "hi"), "label": "beating · BirdNET confidence"},
}
for _f, _lab in (("aci", "ACI · Acoustic Complexity"),
                 ("bright", "Ht · temporal entropy"),
                 ("balance", "NDSI · biophony against anthrophony"),
                 ("bioenergy", "Bio · energy in the biophonic band"),
                 # Anthro was a row here until 2026-09-25 and is deliberately NOT one now
                 # (Miguel). Nothing in the instrument reads it - rho -0.115 against the tick,
                 # -0.120 against the body - and its quiet end is where 98.8% of windows
                 # already sit, so both chips were teaching the other fifteen indices. It is
                 # still a CATALOGUE chip, which plays a real record-holding month and is
                 # honest; the push tier is where it could not be.
                 ("nbpeaks", "NBPEAKS · count of distinct spectral peaks"),
                 ("bi", "BI · Bioacoustic Index")):
    RW_ROW_SPEC[f"clave.index.{_f}"] = {"family": "clave", "kind": "index", "feature": _f,
                                        "stat": None, "dirs": ("lo", "hi"), "label": _lab}
# ONE PUSH SEEN FROM TWO LAYERS. Four data slots over three near-independent statistics means
# the theta statistic is always read twice, and under the shipped gradient reading it is read
# by the body AND by the metre. WHERE THAT IS EXACT (corrected 2026-10-01, TASKS P48; restated in
# RANK form 2026-10-04, P54 V1): on every WINDOW point of every subset - air and water, L0 month x
# time of day and L1 - the accent is round(7 - 5*r/(n-1)) for the point's gradient rank r of n.
# THE RANK FORM IS THE INVARIANT. Before P54 the body sat on the linspace grid,
# theta = pi*r/(n-1), so it could also be written round(7 - 5*theta/pi); under V1 the body sits
# on the MIDPOINT grid, theta = pi*(r + 1/2)/n, and that theta form is NO LONGER the accent (the
# clave still comes from the time-ordered fit, whose rank is r). Recover r from a stored theta
# with the grid's own inverse (_rw_theta_rank: round(n*theta/pi - 1/2) on the midpoint grid,
# round(theta*(n-1)/pi) on linspace), never with the other grid's. It does NOT hold on the MONTH
# ROLL-UPS, the bare "year|month" L0 keys: their accent is the rounded mean of their times of
# day's accents (dev/precompute/sh_identity.py), so it differs from round(7 - 5*r/(n-1)) for any
# one rank on some roll-ups (12 of air's 202, 10 of water's 204 on the pre-P54 tables;
# lab/LEGEND_REFERENCE.md). The push tier never runs on a roll-up (_rw_row_block refuses a
# month), so the `twin` it reports is always the exact one. If the UI renders those as two
# unrelated rows, a reader hears one push twice and concludes the display is broken. Both rows
# carry `twin`.
RW_TWINS = {"gradient": ("drone.gradient", "clave.metre"),
            "variance": ("drone.variance", "clave.tempo")}

# ---- LAYER ISOLATION: WHAT A ROW IS ALLOWED TO SOUND -------------------------------------
# MIGUEL, 2026-09-25, at the display: "if i am changing values to hear the drone difference,
# dont play again the clave, just the drone. if i am changing values to hear the clave diff,
# just play the clave over the drone, and so on."
# So a preview sounds THE LAYER UNDER TEST plus the layers BENEATH it as a STILL bed:
#     drone row -> the drone alone            (the tick is MUTED for the length of the hold)
#     clave row -> the tick over a body PINNED at the listener's own point
#     arp   row -> the chord over a body and a tick pinned at the listener's own values
#     corpus    -> silent on every row, as before: /rw_preview has no corpus verb at all.
# WHY IT IS NOT COSMETIC. Measured over 400 real L1 points of all:2023-2026 by replaying this
# function: drone.variance lo/hi moved the body on 0 of 400 points and the tempo on 400 of 400
# - the row called "drone" was 100% clave, and the last verification caught it from the other
# end (3.299 dB of variance in the full mix against rms_solo 0.000 with the drone alone). A
# listener changing a drone value was hearing the tick's tempo change and crediting the body.
# THE BED IS STILL BY CONSTRUCTION - it is the listener's OWN payload, bit for bit the same
# one a release re-sends - so a layer that is only in the bed CANNOT carry this row's push.
# Its arithmetic is still computed and still reported, under `moves_held` and out of
# `audible`, because pinning the body on a clave row hides a real consequence and a chip that
# quietly drops it is the same dishonesty in the other direction.
RW_BED = {"drone": {"plays": "drone", "still": (), "muted": ("clave",),
                    "silent": ("arp", "corpus")},
          "clave": {"plays": "clave", "still": ("drone",), "muted": (),
                    "silent": ("arp", "corpus")},
          "arp":   {"plays": "arp", "still": ("drone", "clave"), "muted": (),
                    "silent": ("corpus",)}}
# The layers a row's own push can actually be HEARD in, given that bed. Derived, not
# declared: see `heard` in _rw_push_eval, which adds the clave triple only when a PUSHED
# clave was really sent (option (c) below is the one case where a drone row sends one).
#
# ONE PLACE THE RULE ADDS SOUND, and it is flagged rather than hidden: an arp row's bed
# forces the tick audible, so pressing an arp chip more than ~10.4 s after landing revives a
# clave the navigation timeline had already stopped on its downbeat. That is what "over a
# drone and clave that do not move" asks for. Set this False for the one-line alternative:
# the bed then re-states the tick's own rate/formant/accent without forcing it audible, and
# an arp chip pressed late is heard over silence.
RW_PREVIEW_BED_FORCE_CLAVE = True

# ---- THE ROW THAT GOES SILENT ONCE THE CLAVE IS MUTED, AND WHAT IS DONE ABOUT IT ----------
# THE GENERAL SHAPE, not a special case: the sick row is always "the drone row for the
# statistic you are NOT reading", which is also the row that carries the "= yours, other
# reading" chip. Measured mirror image, 400 points: under gradient, drone.variance moves the
# body 0/400 and only the tempo; under variance, drone.gradient moves the body 0/400 and only
# the metre. Mute the clave and both rows go silent while still reporting audible - a chip
# that lies, which is worse than one that is quiet.
#   "switch" (SHIPPED, option b) - the row previews the body AT THAT STATISTIC'S EXTREME
#       UNDER THAT STATISTIC'S READING, for the length of the hold: "if you read variance,
#       this is what low/high variance sounds like in the body". Measured over all 2,388
#       terrain rows of all:2023-2026: median |d theta| ~2.95 dB (p10 0.59, p90 5.31) and
#       2,144/2,388 = 89.8% clear the drone-alone gate, lo and hi alike, against 0.00 dB on
#       2,388/2,388 today (PRE-P54 figures, measured on the pre-P54 tables). UNDER P54 V1 the
#       two readings also have two BODIES (mode amps, rings, comb), so the hold loads the
#       other reading's body for its length - its /rw_identity - and gives yours back on
#       release (rw_preview_hold / rw_preview_release; decided 2026-10-04, fix round 3).
#       It is the only option where the row's three chips form ONE
#       statement - "same" is your own ranks under the other reading, lo/hi are that
#       reading's extremes - and the only one where the row teaches what its label says.
#       THE HONEST OBJECTION: the row then does two things at once (it switches the reading
#       AND pushes), so the reply's `reading` and `notes` must say so. Miguel's call.
#   "block"  (option a) - one line in _rw_row_block: lo/hi are refused with a reason and the
#       row is left with its "same" chip only (audible on 290/400 points).
#   "clave"  (option c) - one line in the `sends` list: the clave stays audible on that one
#       row and is labelled. It reinstates exactly the confound Miguel identified, on the one
#       row where it is 100% of the content.
RW_DRONE_OFFREADING = "switch"

# ---- THE SIDE FILE, AND WHAT IS DERIVED FROM IT ------------------------------------------
# dev/data/rw_push_<level>.json is the ONE thing the bridge does not already have: the row's
# sixteen normalised acoustic values, needed because three of the four data slots are row
# STATISTICS over them and the shipped tables carry only those statistics' outputs. Everything
# else is derived here, because three facts turned out to be exactly true (see rw_push.py):
#   1. the whole /rw_drone payload is a PURE FUNCTION of (subset, rank) - injection test,
#      max |d gains| = 0.000e+00 - so a modified row's drone payload IS the shipped payload of
#      whichever row currently holds the new rank. A rank -> key index is all that is needed.
#   2. all three of a row's ranks are recoverable from the shipped tables EXACTLY (wrong on
#      0 of 8355 L1 pairs), so the bridge never re-derives an unmodified rank and cannot drift
#      from the engine on numbers it already ships.
#   3. the clave triple is identical in both readings (max |d| = 0.000e+00 on all 11 subsets),
#      so "hold the other reading" is a pure drone-payload swap out of the other table.
#      (PRE-P54 ONLY in its second half: the swap was complete because the two readings shared
#      one body. Under V1 the clave triple is still identical but the bodies are not - see the
#      P54 notes below and _rw_reading_body_differs.)
# P54 V1 (2026-10-04) - FACT 1 NO LONGER HOLDS, FACT 2 DOES (on the right grid), FACT 3 ONLY FOR
# THE CLAVE (the two readings' bodies differ; fix 2026-10-04, see rw_set_stat / _rw_row_block):
#   * a row's drone is its OWN BAND (its sixteen values centred on the room's per-measure means,
#     at its ring) x the seesaw at its rank, so a payload is a function of (subset, row, rank),
#     not of (subset, rank). DECISION (Miguel's delegation, 2026-10-04): a pushed point's drone
#     is the listener's OWN content at the ring of its NEW rank, with the seesaw at that rank,
#     through the precompute's own post-processing (normalise, contrast k, pressure re-centred on
#     the level's stored strength range, the rendered-power pin). The only rows that SEND a
#     drone are the drone rows, and they move a rank, never a value, to rank 0 or n-1 of a
#     reading - a finite set - so rw_push.py precomputes exactly those two payloads per point
#     and reading (the side file's "drone"), checked there bit for bit against the tables on
#     every row at its own rank. `direction == "same"` is still a lookup (the row's own
#     payload in the other table) - but under V1 that payload is pinned on the OTHER reading's
#     body (its own mode amps and comb), and so are the off-reading lo/hi targets. So wherever
#     the two readings' bodies differ, a hold of the off-reading row first sends that reading's
#     room (/rw_identity, the bytes a reading switch sends) and its release sends yours back
#     before your own payload (2026-10-04, fix round 3: the interim refusal of fix round 2 is
#     gone). Holding the other reading on a row is then navigating that row under the other
#     reading, after the identity's 4 s glide. Why not compute it here: the loudness pin integrates the
#     whole transfer function on a 23,600-point grid - measured 0.8 s per press in stdlib
#     CPython, ~3.7 h to re-check air's 16,710 L1 points at load, and slower again in the web's
#     Pyodide.
#   * theta is on the MIDPOINT grid, pi*(r + 1/2)/n, so the rank inverse is round(n*theta/pi
#     - 1/2) (_rw_theta_rank). The linspace inverse round(theta*(n-1)/pi) lands only by a margin
#     of 1/(2n) there, which the tables' 5-decimal theta breaks on long rooms (1 row at n=904,
#     5 at 2388, 2 at 2379). Which grid is read off the side file's "recipe" and VERIFIED against
#     the tables' thetas, room by room, at load (_rw_push_derive_into).
# The load-time guard for the drone half: every room's mode table must hash to the side file's
# "drone_ident", every terrain point must carry both targets in both readings, each EXACTLY 1 + the
# room's mode count long, the two rows that already hold rank 0 and rank n-1 must get back EXACTLY
# their own table payload, and (fix round 3, 2026-10-04) THE SEAL must hold: the side file's
# "drone_sha256" / "tables_sha256" equal the hashes recomputed here from the drone half and from the
# tables in force - so an edited or rotted INTERIOR target, which the end-row identity cannot see,
# is caught too. Anything else disables the tier with a reason, as the rank self-check always has.
RW_PUSH: dict = {}          # level -> the parsed side file
RW_PUSH_DER: dict = {}      # (level, subset) -> the derived per-subset arithmetic
RW_PUSH_OK: dict = {}       # level -> did the load-time self-check pass?
RW_PUSH_WHY: dict = {}      # level -> why not, in one line, for the reply's `why`
# ONE SET PER CHANNEL. The four names above always point at the IN-FORCE channel's set
# (_rw_push_bind rebinds them), so every reader - and verify_rw_preview.py, which mutates
# RW_PUSH["L1"]["rows"] in place - keeps working unchanged. A channel never borrows another's
# side file: water's is built from the water CSV, beside water's tables, and its self-check
# guards it like air's.
_RW_PUSH_BY_CH: dict = {"air": (RW_PUSH, RW_PUSH_DER, RW_PUSH_OK, RW_PUSH_WHY)}


def _rw_push_slot(tch: str):
    if tch not in _RW_PUSH_BY_CH:
        _RW_PUSH_BY_CH[tch] = ({}, {}, {}, {})
    return _RW_PUSH_BY_CH[tch]


def _rw_push_bind(tch: str):
    global RW_PUSH, RW_PUSH_DER, RW_PUSH_OK, RW_PUSH_WHY
    RW_PUSH, RW_PUSH_DER, RW_PUSH_OK, RW_PUSH_WHY = _rw_push_slot(tch)


_RW_LEVEL_STATS: dict = {}  # level -> {"rich_max", "cert_lo", "cert_hi", "nsp": {key: v}} (in-force channel)
_RW_RHO: dict = {}          # (level, subset, reading) -> {column: {colour, tempo, body, metre}}
RW_PREVIEW = None           # the hold that is down, or None. FIRST one wins.
_RW_COMMIT = {"t": 0.0, "on": -1.0, "last": -1.0, "off": -1.0}   # when the listener's own chord rings


def _rw_diel_sort(key: str):
    """The TIME order, recoverable from the key alone - which is what makes the gradient a
    true temporal gradient. VERIFIED: pandas' own sort order == this key order at both
    levels, and there are 0 duplicate keys."""
    p = key.split("|")
    w = DIEL_ORDER.index(p[-1]) if p[-1] in DIEL_ORDER else 0
    return ((int(p[0]), int(p[1]), int(p[2]), w) if len(p) == 4
            else (int(p[0]), int(p[1]), w))


def _rw_theta_rank(theta: float, n: int, grid: str) -> int:
    """The rank a table theta stands for, on the grid the body was laid out on.
        'midpoint' (P54 V1, own_band):   theta = pi (r + 1/2) / n    ->  r = n theta / pi - 1/2
        'linspace' (pre-P54, archive):   theta = pi r / (n - 1)      ->  r = theta (n - 1) / pi
    Clamped to 0..n-1. Never use one grid's inverse on the other's thetas (pitfall 3)."""
    if grid == "midpoint":
        r = int(round(float(theta) * n / math.pi - 0.5))
    else:
        r = int(round(float(theta) * (n - 1) / math.pi))
    return max(0, min(n - 1, r))


def _rw_grid_residual(thetas, n: int, grid: str) -> float:
    """How far a room's table thetas sit off a grid, in rank units (worst row). On the right grid
    it is the 5-decimal rounding of theta, <= n * 0.5e-5 / pi (0.004 at n = 2388); on the wrong
    grid it is O(0.5) for most rooms."""
    worst = 0.0
    for th in thetas:
        x = float(th) * n / math.pi - 0.5 if grid == "midpoint" else float(th) * (n - 1) / math.pi
        worst = max(worst, abs(x - round(x)))
    return worst


def _ident_digest(ident_entry) -> str:
    """sha256[:16] of one room's table ident (its modes and comb), exactly as rw_push.py's
    ident_digest computes it from the same JSON."""
    blob = json.dumps([ident_entry["modes"], ident_entry["comb"]], separators=(",", ":"))
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


def _canon_sha(obj) -> str:
    """sha256 of the canonical JSON of `obj`, exactly as rw_push.py's canon_sha seals it (stdlib json
    round-trips every float, NaN included, so the bytes are the precompute's)."""
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _rank_against(sorted_vals, own, x, n):
    """Where x lands in a population the row's own value has been taken out of."""
    pos = bisect.bisect_left(sorted_vals, x)
    if own < x:
        pos -= 1
    return max(0, min(n - 1, pos))


def _rw_push_derive(level: str, tchan: str = None) -> bool:
    """Derive one level's push arithmetic for one channel (default: the channel in force).
    The four push names are bound to that channel's set for the duration and put back after,
    so deriving water at boot never disturbs air's."""
    tch = tchan or RW_TCHAN
    _rw_push_bind(tch)
    try:
        return _rw_push_derive_into(level, tch)
    finally:
        _rw_push_bind(RW_TCHAN)
        _rw_apply_recipe()                      # the in-force channel's recipe (P54)


def _rw_push_derive_into(level: str, tch: str) -> bool:
    """Per subset: the terrain rows in time order, their sixteen values, the three row
    statistics, sorted populations to rank against, and a rank -> key index per reading.

    MEASURED at 0.14 s for all 11 L1 subsets including the JSON read, so it is done eagerly
    at load rather than lazily per press.

    THE SELF-CHECK IS THE GUARD THAT MAKES THE 16-BIT SIDE FILE SAFE. It recomputes all three
    ranks here, in stdlib, and compares them against the ranks recovered from the shipped
    tables. Over tolerance means the side file and the tables were built from different data -
    print a loud line and DISABLE the tier, rather than serve wrong sound. Baseline drift from
    the quantisation plus stdlib summation order is a handful of ranks out of 2388
    (0.0024 rank01 = 0.0076 rad = ~0.014 dB linearised, 43x under the 0.60 dB null).

    P54 V1: the grid the ranks are read on comes from the side file's "recipe" (absent = the
    pre-P54 linspace grid) and is VERIFIED room by room against the tables' own thetas; the
    drone half ("drone", "drone_ident") gets its own exact check (_rw_push_check_drone). A side
    file and tables from two recipes disable the tier."""
    push = RW_PUSH.get(level)
    tg, tv = _rw_tables("gradient", tch), _rw_tables("variance", tch)
    if not push or tg is None or tv is None or level not in tg:
        RW_PUSH_OK[level] = False
        RW_PUSH_WHY[level] = "the push side file or the drone tables are missing"
        return False
    recipe = push.get("recipe") or {}
    grid = "midpoint" if recipe.get("lat_grid") == "midpoint" else "linspace"
    v1 = recipe.get("content_weight_mode") == "own_band"
    if v1 and not isinstance(push.get("drone"), dict):
        RW_PUSH_OK[level] = False
        RW_PUSH_WHY[level] = ("the push side file names the P54 drone but carries no drone half "
                              "(re-run dev/precompute/rw_push.py)")
        print(f"  [rw:push:{tch}:{level}] {RW_PUSH_WHY[level]} - tier disabled")
        return False
    scale = float(push["scale"])
    nc = len(push["columns"])
    rows = push["rows"]
    by_subset: dict = {}
    for kk in tg[level]["points"]:
        s, _, k = kk.partition("@")
        # TERRAIN ROWS ONLY. The 34 bare "year|month" keys at L0 are equal-power MEANS of a
        # month's diel rows, so their theta is off the rank grid (only 11 of 34 land on it,
        # and those are the months holding a single row). They are absent from the side file
        # and the tier is blocked on them.
        if k in rows:
            by_subset.setdefault(s, []).append(k)
    worst = {"gradient": 0, "variance": 0, "mean": 0}
    pairs = 0
    for s, ks in by_subset.items():
        ks = sorted(ks, key=_rw_diel_sort)
        n = len(ks)
        if n < 2 or s not in tg[level]["ident"]:
            continue
        V = [[x / scale for x in rows[k]] for k in ks]
        mean = [sum(v) / nc for v in V]
        var = [sum((x - m) ** 2 for x in v) / nc for v, m in zip(V, mean)]
        step = [sum(abs(a - b) for a, b in zip(V[i + 1], V[i])) / nc for i in range(n - 1)]
        if n > 2:
            grad = [step[0]] + [0.5 * (step[i - 1] + step[i]) for i in range(1, n - 1)] + [step[-1]]
        else:
            grad = [step[0], step[0]]
        cb = float(tg[level]["ident"][s]["clave_base"])
        # THE OWN RANKS COME FROM THE SHIPPED TABLES, never from the arithmetic above (fact 2),
        # so an unmodified row can never disagree with the engine.
        # THE GRID IS VERIFIED, not assumed (P54): the side file says which grid it was built
        # against; the room's own thetas must sit on it (5-decimal rounding only), in both
        # readings. Tables and side file from two recipes would read every rank off by up to
        # a row - refused here rather than served.
        pts_g = [tg[level]["points"][f"{s}@{k}"] for k in ks]
        pts_v = [tv[level]["points"][f"{s}@{k}"] for k in ks]
        off = max(_rw_grid_residual([p[0] for p in pts_g], n, grid),
                  _rw_grid_residual([p[0] for p in pts_v], n, grid))
        if off > 0.05:
            print(f"  [rw:push:{tch}:{level}] {s}: the tables' thetas are not on the {grid} grid "
                  f"the push side file was built for (worst {off:.3f} rank) - tier disabled")
            RW_PUSH_OK[level] = False
            RW_PUSH_WHY[level] = ("the drone tables and the push side file were built with two "
                                  "different drone recipes (re-run dev/precompute/rw_push.py)")
            return False
        rk = {"gradient": [0] * n, "variance": [0] * n, "mean": [0] * n}
        for i, k in enumerate(ks):
            pg, pv = pts_g[i], pts_v[i]
            rk["gradient"][i] = _rw_theta_rank(pg[0], n, grid)
            rk["variance"][i] = _rw_theta_rank(pv[0], n, grid)
            rk["mean"][i] = max(0, min(n - 1,
                                       int(round(((pg[3] / cb) - 0.65) / RW_CLAVE_SWING * (n - 1)))))
        rank_key = {r: [None] * n for r in ("gradient", "variance")}
        for r in rank_key:
            for i, k in enumerate(ks):
                rank_key[r][rk[r][i]] = k
        if any(x is None for r in rank_key for x in rank_key[r]):
            # theta takes exactly n values on the grid (pi*k/(n-1) linspace, pi*(k+1/2)/n
            # midpoint), one per row, so the ranks are a permutation. If they are not, the table
            # and the side file disagree about what this subset contains and the drone lookup
            # would land on the wrong row.
            print(f"  [rw:push:{tch}:{level}] {s}: table ranks are not a permutation - tier disabled")
            RW_PUSH_OK[level] = False
            RW_PUSH_WHY[level] = "the drone tables and the push side file disagree"
            return False
        # the self-check: stdlib arithmetic vs the tables' own ranks
        def _ranks(a):
            order = sorted(range(n), key=lambda i: (a[i], i))     # stable, as the library is
            out = [0] * n
            for pos, i in enumerate(order):
                out[i] = pos
            return out
        mine = {"gradient": _ranks(grad), "variance": _ranks(var), "mean": _ranks(mean)}
        for st in worst:
            worst[st] = max(worst[st], max(abs(a - b) for a, b in zip(mine[st], rk[st])))
        pairs += n
        RW_PUSH_DER[(level, s)] = {
            "keys": ks, "n": n, "nc": nc, "pos": {k: i for i, k in enumerate(ks)},
            "V": V, "mean": mean, "var": var, "grad": grad, "step": step,
            "sorted": {"gradient": sorted(grad), "variance": sorted(var), "mean": sorted(mean)},
            "rk": rk, "rank_key": rank_key, "clave_base": cb, "grid": grid, "v1": v1,
        }
    tol = max(4, 0.005 * len(rows))
    ok = all(w <= tol for w in worst.values())
    if ok and v1:
        why = _rw_push_check_drone(level, tch, push, tg, tv)
        if why:
            RW_PUSH_OK[level] = False
            RW_PUSH_WHY[level] = why
            print(f"  [rw:push:{tch}:{level}] *** DRONE-HALF CHECK FAILED *** {why}. "
                  f"THE PUSH TIER IS DISABLED.")
            return False
    RW_PUSH_OK[level] = ok
    if not ok:
        RW_PUSH_WHY[level] = ("the push side file is out of step with the drone tables "
                              "(re-run dev/precompute/rw_push.py)")
        print(f"  [rw:push:{tch}:{level}] *** SELF-CHECK FAILED *** worst rank drift "
              f"gradient {worst['gradient']}, variance {worst['variance']}, "
              f"mean {worst['mean']} against a tolerance of {tol:.0f} of {len(rows)}. "
              f"THE PUSH TIER IS DISABLED - re-run dev/precompute/rw_push.py alongside "
              f"dev/precompute/rw_tables.py.")
    else:
        print(f"  [rw:push:{tch}:{level}] {len(rows)} terrain rows · "
              f"{sum(1 for lv, _ in RW_PUSH_DER if lv == level)} subsets · {pairs} pairs · "
              f"self-check worst drift {max(worst.values())} rank(s) of {len(rows)}"
              + (" · P54 drone half: sealed, mode tables, completeness and the rank-0 / rank-n-1 "
                 "rows exact" if v1 else ""))
    return ok


def _rw_push_check_drone(level: str, tch: str, push: dict, tg: dict, tv: dict) -> str:
    """The drone half's load-time guard (P54 V1). Returns "" or why the tier must not run.

      1. every room's mode table (modes + comb, as THESE tables carry it) hashes to the side
         file's "drone_ident" for that reading - the side file was built against these rooms;
      2. every terrain point of every room has both targets (lo, hi) in both readings, each a
         pressure plus at most one gain per mode, all finite;
      3. EXACT IDENTITY: the row that already holds rank 0 gets back, as its "lo", precisely its
         own table payload (pressure and every gain), and the row at rank n-1 as its "hi" - the
         precompute's arithmetic and the tables' agree on the rows where they must coincide.
      0. THE SEAL (fix round 3, 2026-10-04): sha256 of the canonical JSON of drone[stat] equals the
         side file's "drone_sha256"[stat], and that of [ident, points] of the tables in force equals
         "tables_sha256"[stat] - the side file was built against exactly these tables, and not one
         target has changed since (an interior target edited, swapped, copied or truncated passed
         checks 1-3 and was played; tamper review 2026-10-04). ~0.3 s per channel.
    rw_push.py's build-time check is stronger (every row at its own rank, bit for bit, and the
    weights against the library's own); this one is what the bridge can afford at load and is
    what catches a side file and tables from two different builds."""
    drone = push.get("drone") or {}
    dig = push.get("drone_ident") or {}
    seal_d, seal_t = push.get("drone_sha256") or {}, push.get("tables_sha256") or {}
    for stat, tb in (("gradient", tg), ("variance", tv)):
        dd, dg = drone.get(stat), dig.get(stat) or {}
        if not isinstance(dd, dict):
            return f"the push side file has no {stat} drone targets"
        if not seal_d.get(stat) or not seal_t.get(stat):
            return (f"the push side file carries no seal for its {stat} drone targets (re-run "
                    f"dev/precompute/rw_push.py)")
        if _canon_sha(dd) != seal_d[stat]:
            return f"the {stat} drone targets do not match their seal (edited or damaged since the build)"
        if _canon_sha([tb[level]["ident"], tb[level]["points"]]) != seal_t[stat]:
            return (f"the {stat} drone targets were built against other {stat} tables than the ones in "
                    f"force (re-run dev/precompute/rw_push.py)")
        for s, ident in tb[level]["ident"].items():
            D = RW_PUSH_DER.get((level, s))
            if D is None:
                continue
            if dg.get(s) != _ident_digest(ident):
                return f"room {s}'s mode table differs from the one the {stat} drone targets were built on"
            nm = len(ident["modes"])
            for k in D["keys"]:
                pair = dd.get(f"{s}@{k}")
                if (not isinstance(pair, list) or len(pair) != 2
                        or any(not isinstance(t, list) or len(t) != nm + 1 for t in pair)
                        or any(not (isinstance(x, (int, float)) and x == x and abs(x) != float("inf"))
                               for t in pair for x in t)):
                    return f"{stat} drone targets missing or malformed for {s}@{k}"
            n = D["n"]
            for end, r in ((0, 0), (1, n - 1)):
                k = D["rank_key"][stat][r]
                own = tb[level]["points"][f"{s}@{k}"]
                got = dd[f"{s}@{k}"][end]
                g_tab = list(own[5:])
                g_side = list(got[1:]) + [0.0] * (len(g_tab) - (len(got) - 1))
                if float(got[0]) != float(own[1]) or g_side != g_tab:
                    return (f"{stat} {('lo', 'hi')[end]} target of {s}@{k} (rank {r}) is not its own "
                            f"table payload")
    return ""


def _rw_v1_drone(level: str, subset: str, key: str, reading: str, r_to: int, holder_pt):
    """P54 V1: THIS row's own content pressed at rank r_to (0 or n-1) under `reading`, from the side
    file's drone half, as a TABLE-SHAPED point - [theta, pressure, rate, formant, accent, g0..] -
    so everything downstream (d_theta, _rw_gains' pt[5:]) reads it as it reads a table row. theta
    is the ring of r_to: the theta of `holder_pt`, the row that holds r_to in that reading's table.
    Its rate / formant / accent ride along unread (the clave is computed from the ranks)."""
    D = RW_PUSH_DER[(level, subset)]
    end = 0 if r_to == 0 else 1 if r_to == D["n"] - 1 else None
    if end is None:
        raise ValueError(f"no precomputed drone at rank {r_to} of {D['n']}")
    t = RW_PUSH[level]["drone"][reading][f"{subset}@{key}"][end]
    width = len(holder_pt) - 5
    gains = [float(g) for g in t[1:]]
    gains += [0.0] * max(0, width - len(gains))
    return [float(holder_pt[0]), float(t[0])] + list(holder_pt[2:5]) + gains


def load_rw_push():
    """Read both side files of EVERY table channel and derive. Silent-but-disabled if they
    have not been built: the tier reports `audible:false` with a reason the page can print,
    rather than either throwing or playing something wrong."""
    for tch in sorted(RW_TABLE_CHANNELS):
        _rw_push_bind(tch)
        try:
            _rw_load_push_channel(tch)
        finally:
            _rw_push_bind(RW_TCHAN)
    _rw_push_refuse_mixed()
    _rw_apply_recipe()                          # the anchor + body gates of the recipe in force (P54)
    return any(RW_PUSH_OK.values())


def _rw_push_refuse_mixed():
    """ONE DRONE RECIPE OR NO TIER (fix 2026-10-04). The body anchor and gates are one set per
    recipe, and a pushed drone is built by its recipe; side files of two recipes - a partial swap,
    or one channel / one level rolled back - would give some replies the other recipe's dB
    estimate and audibility. Like the air/water build drift check, a mixed set is an error
    state: every level that derived OK is disabled with the reason, and nothing is guessed."""
    got = {}
    for tch in sorted(_RW_PUSH_BY_CH):
        push, _der, ok, _why = _RW_PUSH_BY_CH[tch]
        for lv, sd in push.items():
            if sd is not None and ok.get(lv):
                got[(tch, lv)] = _rw_side_recipe(sd)
    if len(set(got.values())) <= 1:
        return True
    said = ", ".join(f"{t} {lv} {r}" for (t, lv), r in sorted(got.items()))
    why = (f"the push side files were built with different drone recipes ({said}) - a partial "
           f"swap or rollback; rebuild every channel with one RW_WEIGHT_MODE")
    print(f"  [rw:push] *** {why}: push tier DISABLED")
    for (tch, lv) in got:
        _push, _der, ok, whyd = _RW_PUSH_BY_CH[tch]
        ok[lv] = False
        whyd[lv] = why
    return False


def _rw_load_push_channel(tch: str):
    for level in ("L1", "L0"):
        name = f"rw_push_{level}.json"
        try:
            side = _PUSH_DATA.get((tch, level))
            if side is None and _PUSH_SOURCE is not None:
                side = _PUSH_SOURCE(tch, level)      # bridge.read_rw_push: dev/data; None if never built
        except (OSError, ValueError) as e:
            RW_PUSH_OK[level] = False
            RW_PUSH_WHY[level] = f"the push side file could not be read ({e})"
            print(f"  [rw:push:{tch}:{level}] {name} unreadable: {e}")
            continue
        if side is None:
            RW_PUSH_OK[level] = False
            RW_PUSH_WHY[level] = ("the push side file has not been built "
                                  "(run dev/precompute/rw_push.py)")
            print(f"  [rw:push:{tch}:{level}] {name} missing, push tier disabled "
                  f"(run dev/precompute/rw_push.py{'' if tch == 'air' else ' --channel ' + tch})")
            continue
        RW_PUSH[level] = side
        _rw_push_derive_into(level, tch)


def _rw_level_stats(level: str) -> dict:
    """The two level-wide ranges the arp rows push to, read off what the bridge already
    holds: n_species_analysed from the loaded rows (the windows BirdNET analysed any minute of;
    the others have no richness and no entry), and the confidence range by scanning the
    chord table. Both are REAL observed extremes - nothing in this tier invents a value the
    dataset does not contain."""
    got = _RW_LEVEL_STATS.get(level)
    if got is not None:
        return got
    nsp = {}
    rich_max = 0.0
    raws = _RW_RAW_SERIES.get((level, RW_TCHAN))          # the channel in force, never another's
    if raws and raws.get("nsp"):
        for v, k in raws["nsp"]:
            nsp[k] = v
            rich_max = max(rich_max, v)
    # L0 has no raw per-terrain-row series, and it must NOT take its ceiling from the views'
    # l0months: their `nsp` WAS the ENGINE's normalised n_species_mean (max 1.0) on air - since
    # 2026-09-29 it is the month's n_species_analysed, but a whole month, not a terrain row - and 0.0
    # on water / air+water, never the raw richness the L0 chords were built against - with 1.0
    # as the ceiling, "richest" landed BELOW almost every month's own richness and SLOWED the
    # chord (115 of 116 L0 rows, pure air, since before 2026-09-26; air+water joined it when the
    # tables went per channel). The ceiling is the reference arp_species.py built every chord
    # against (RICHNESS_REF_BY_LEVEL). `your_raw` stays null at L0 rather than being guessed at.
    if rich_max <= 0:
        rich_max = RW_RICHNESS_REF
    clo, chi = 1.0, 0.0
    for row in (RW.get(level) or {}).get("arp", {}).values():
        for nt in row[1:]:
            clo = min(clo, float(nt[2])); chi = max(chi, float(nt[2]))
    if chi <= clo:
        clo, chi = RW_CONF_GATE, 0.999
    got = {"rich_max": rich_max, "cert_lo": clo, "cert_hi": chi, "nsp": nsp}
    _RW_LEVEL_STATS[level] = got
    return got


def _avg_ranks(xs):
    """Ranks with ties AVERAGED - the metre is a six-level integer, so tie handling is not
    optional here."""
    n = len(xs)
    order = sorted(range(n), key=lambda i: xs[i])
    out = [0.0] * n
    i = 0
    while i < n:
        j = i
        while j + 1 < n and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        avg = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            out[order[k]] = avg
        i = j + 1
    return out


def _pearson(a, b):
    n = len(a)
    if n < 3:
        return None
    ma, mb = sum(a) / n, sum(b) / n
    sa = sum((x - ma) ** 2 for x in a)
    sb = sum((y - mb) ** 2 for y in b)
    if sa <= 0 or sb <= 0:
        return None
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / math.sqrt(sa * sb)


def _rw_rho(level: str, subset: str) -> dict:
    """OBSERVATIONAL Spearman of every column against the four things the tick and body do,
    over THIS selection. Shipped so the (i) can print intervention and observation side by
    side without hard-coding a number in the page - and so the numbers move when the listener
    changes the selection, which is the whole point of a per-point tier."""
    ck = (level, subset, RW_STAT)
    got = _RW_RHO.get(ck)
    if got is not None:
        return got
    D = RW_PUSH_DER.get((level, subset))
    tbl = (RW.get(level) or {}).get("points") or {}
    if D is None:
        return {}
    ks, n, nc = D["keys"], D["n"], D["nc"]
    pts = [tbl.get(f"{subset}@{k}") for k in ks]
    if any(p is None for p in pts):
        return {}
    tgt = {"body": _avg_ranks([p[0] for p in pts]),
           "tempo": _avg_ranks([p[2] for p in pts]),
           "colour": _avg_ranks([p[3] for p in pts]),
           "metre": _avg_ranks([float(p[4]) for p in pts])}
    out = {}
    for j in range(nc):
        rj = _avg_ranks([D["V"][i][j] for i in range(n)])
        name = RW_PUSH[level]["columns"][j]
        out[name] = {t: (None if _pearson(rj, v) is None else round(_pearson(rj, v), 3))
                     for t, v in tgt.items()}
    # BirdNET richness, over the rows that HAVE one: a window BirdNET analysed no minute of has
    # no richness (not 0), so the correlation is taken on the others, with the four targets
    # re-ranked over the same rows. It used to need every row present, which after the fix
    # (40 such windows) would have silenced it in every room that holds one of them.
    nsp = _rw_level_stats(level)["nsp"]
    have = [i for i, k in enumerate(ks) if k in nsp]
    if nsp and len(have) >= 3:
        rn = _avg_ranks([nsp[ks[i]] for i in have])
        sub = {"body": [pts[i][0] for i in have], "tempo": [pts[i][2] for i in have],
               "colour": [pts[i][3] for i in have], "metre": [float(pts[i][4]) for i in have]}
        tg2 = tgt if len(have) == n else {t: _avg_ranks(v) for t, v in sub.items()}
        out[NSP_COL] = {t: (None if _pearson(rn, v) is None else round(_pearson(rn, v), 3))
                        for t, v in tg2.items()}
    _RW_RHO[ck] = out
    return out


# ---- the arithmetic, literally -----------------------------------------------------------
# THE GRADIENT / NEIGHBOUR CONVENTION, stated because a researcher is entitled to know which
# one is in force. ONE number in the whole matrix changes - T[row, col] - and the pushed row's
# own gradient is recomputed against its REAL temporal neighbours' real values. The
# neighbours' own gradients are NOT recomputed, and the population the new value is ranked
# against is the shipped, unmodified one. MEASURED cost of that freeze, over 7 chips x 2
# directions x 141 rows of all:2023-2026: max |rank01 frozen - rank01 moving| = 0.00084 =
# 0.0026 rad of theta = ~0.005 dB linearised, 120x under the 0.60 dB bow-noise null. It is the
# same sound for a thousandth of the work - two scalar updates and one bisect, against a full
# 2388x16 difference matrix and three re-sorts per press.
def _rw_chord(level: str, subset: str, key: str):
    row = (RW.get(level) or {}).get("arp", {}).get(f"{subset}@{key}")
    return (float(row[0]), [list(nt) for nt in row[1:]]) if row else (0.7, [])


def _rw_mark_commit(rate, accent, gap, n_notes):
    """Remember when the listener's own chord arrives and when it releases. SC's timeline,
    duplicated (see RW_SC_*). Used ONLY to choose between a gapless \\cert set on a ringing
    chord and a fresh preview chord, so being a second out costs a respawn, not a wrong sound."""
    bar = float(accent) / max(float(rate), 1e-6)
    bar_s = min(max(bar, RW_SC_BAR_CLIP[0]), RW_SC_BAR_CLIP[1])
    on = RW_SC_CLAVE_IN + max(RW_SC_ARP_FLOOR, bar_s * 2)
    off = on + max(n_notes - 1, 0) * float(gap) + RW_SC_ARP_SUSTAIN
    last = on + max(n_notes - 1, 0) * float(gap)                  # the last note is in
    _RW_COMMIT.update(t=time.monotonic(), on=(on if n_notes else -1.0),
                      last=(last if n_notes else -1.0), off=(off if n_notes else -1.0))


def _rw_chord_ringing() -> bool:
    """Any of the listener's own notes is sounding (the drone rows' "still ringing" note)."""
    if _RW_COMMIT["off"] <= 0:
        return False
    dt = time.monotonic() - _RW_COMMIT["t"]
    return _RW_COMMIT["on"] <= dt < _RW_COMMIT["off"]


def _rw_chord_settable() -> bool:
    """The listener's WHOLE chord is sounding and is still theirs - the only time a beating
    hold may set \\cert on it instead of spawning a chord of its own (TASKS P36). SC applies
    "cert" by LIST POSITION over ~rwArpNodes, so: not while the chord is still assembling (only
    the notes already in would move, the rest arrive at their own confidence), and never after
    a preview chord has replaced it this commit (rw_preview_hold marks that: SC gates the notes
    already in and, P38, drops the rest; a hold released before the first note is un-marked by
    rw_preview_release, because SC then plays the chord whole)."""
    if _RW_COMMIT["off"] <= 0:
        return False
    dt = time.monotonic() - _RW_COMMIT["t"]
    return _RW_COMMIT["last"] <= dt < _RW_COMMIT["off"]


def _rw_gains(pt):
    """NaN reaching scsynth's setn(\\gains, ...) corrupts the body for as long as it is held.
    26 L0 points ship with NaN gains (24-mode subsets padded to 35 with NaN, not 0)."""
    return [g if isinstance(g, (int, float)) and g == g and abs(g) != float("inf") else 0.0
            for g in pt[5:]]


def _rw_reading_body_differs(level, subset, reading) -> bool:
    """Does `reading`'s table give this room another BODY than the reading in force (the
    /rw_identity contents _rw_body_key covers)? False on every pre-P54 table and when either
    table cannot be read (the evaluation then fails on its own, with its own reason)."""
    if not level or not subset or reading == RW_STAT:
        return False
    a = ((RW.get(level) or {}).get("ident") or {}).get(subset)
    t = _rw_tables(reading)
    b = (((t or {}).get(level) or {}).get("ident") or {}).get(subset)
    if a is None or b is None:
        return False
    return _rw_body_key(a) != _rw_body_key(b)


def _rw_row_block(level, subset, key, row, direction=""):
    """Why this row cannot be played on this point, in one line, or "" if it can.

    REPORTED, NEVER WORKED AROUND. In particular the mixer belongs to the listener (the
    2026-09-24 lesson): at L0 the arp fader defaults to 0, so the arp rows are blocked there
    until the listener raises it - the bridge says so and the UI dims. It does not raise it."""
    spec = RW_ROW_SPEC.get(row)
    if spec is None:
        return "unknown row"
    if direction and direction not in spec["dirs"] and direction != "same":
        return f"{row} has no direction {direction!r}"
    if level is None or key is None:
        return "no point is selected yet"
    if len(key.split("|")) == 2:
        return ("this view sends a month, and a month is an average of its four windows "
                "— the push needs one real window.")
    if RW.get(level) and f"{subset}@{key}" not in RW[level]["points"]:
        # RESTING (TASKS P20): the selection moved to a room this point is not in
        return "the selection changed and no point in it has been played yet — press one"
    if not RW_PUSH_OK.get(level):
        return RW_PUSH_WHY.get(level, "the push tier is disabled")
    D = RW_PUSH_DER.get((level, subset))
    if D is None or key not in D["pos"]:
        return "this point is not a terrain row of the current selection"
    fam = spec["family"]
    if fam == "drone" and RW_MIX[0] <= 0:
        return "the drone fader is at 0"
    if fam == "clave" and RW_MIX[1] <= 0:
        return "the clave fader is at 0"
    if fam == "arp" and RW_MIX[2] <= 0:
        return "the arp fader is at 0"
    # (P54 V1: the off-reading drone row is NOT refused for having another body - its hold loads
    # that body, see rw_preview_hold. The interim refusal of fix round 2 was removed 2026-10-04.)
    if (RW_DRONE_OFFREADING == "block" and fam == "drone" and spec.get("stat")
            and spec["stat"] != RW_STAT and direction in ("lo", "hi")):
        return (f"under the {RW_STAT} reading this row moves only the clave, "
                f"which is muted here")
    if direction == "same":
        if fam != "drone":
            return "only a drone row can hold the other reading"
        if spec.get("stat") == RW_STAT:
            return "you are already on this reading"
    if spec["kind"] == "arp":
        _gap, notes = _rw_chord(level, subset, key)
        if not notes:
            return "this window has no BirdNET chord"
        # The 0.95 s ceiling used to swallow the density change on any chord of 4 notes or
        # fewer - 71 L1 chords whose density moved 0%. The new law's clamp is inert, so those
        # chords now carry the full contrast and this block no longer applies.
        if spec["arp"] == "pitch" and len(notes) < 2:
            return "this chord has one note — it is already the isolate"
    return ""


def _rw_push_eval(level, subset, key, row, direction):
    """The whole of it: the new ranks, what moves, whether it clears the floor, and the
    /rw_preview messages that carry it. Sends NOTHING - the caller decides."""
    spec = RW_ROW_SPEC[row]
    D = RW_PUSH_DER[(level, subset)]
    n, nc, i = D["n"], D["nc"], D["pos"][key]
    span = float(n - 1) if n > 1 else 1.0
    tg, tv = _rw_tables("gradient"), _rw_tables("variance")
    pt_own = RW[level]["points"][f"{subset}@{key}"]
    reading_from = RW_STAT
    reading_to = reading_from
    rg, rv, rm = D["rk"]["gradient"][i], D["rk"]["variance"][i], D["rk"]["mean"][i]
    rg2, rv2, rm2 = rg, rv, rm
    if direction == "same":
        # A DRONE ROW FOR THE READING YOU ARE NOT ON temporarily switches which statistic the
        # body reads and keeps all three of your ranks; releasing returns you to yours. Those
        # two rows are where the display teaches that choosing a reading is a real choice
        # (findings/08) - nothing else in the display does.
        reading_to = "variance" if reading_from == "gradient" else "gradient"
    elif spec["kind"] == "index":
        j = RW_PUSH[level]["chip_col"][spec["feature"]]
        t = 0.0 if direction == "lo" else 1.0
        v = D["V"][i]
        v2 = list(v)
        v2[j] = t
        mean2 = sum(v2) / nc
        var2 = sum((x - mean2) ** 2 for x in v2) / nc
        sp = sn = None
        if i > 0:
            sp = D["step"][i - 1] + (abs(t - D["V"][i - 1][j])
                                     - abs(v[j] - D["V"][i - 1][j])) / nc
        if i < n - 1:
            sn = D["step"][i] + (abs(D["V"][i + 1][j] - t)
                                 - abs(D["V"][i + 1][j] - v[j])) / nc
        grad2 = (sn if sp is None else sp if sn is None else 0.5 * (sp + sn))
        if grad2 is None:
            grad2 = D["grad"][i]
        rg2 = _rank_against(D["sorted"]["gradient"], D["grad"][i], grad2, n)
        rv2 = _rank_against(D["sorted"]["variance"], D["var"][i], var2, n)
        rm2 = _rank_against(D["sorted"]["mean"], D["mean"][i], mean2, n)
    elif spec["kind"] == "stat":
        r = 0 if direction == "lo" else n - 1
        if spec["stat"] == "gradient":
            rg2 = r
        elif spec["stat"] == "variance":
            rv2 = r
        else:
            rm2 = r
        # OPTION (b), and it is ONE CONDITION because `direction == "same"` above already
        # does "switch the reading, keep your ranks". A drone row for the statistic the body
        # is not reading previews the body UNDER THAT STATISTIC for the length of the hold;
        # everything downstream - tbl_to, dkey, pt_to, d_theta, the gate - composes unchanged.
        if (RW_DRONE_OFFREADING == "switch" and spec["family"] == "drone"
                and spec["stat"] != reading_from):
            reading_to = spec["stat"]
    # (the arp rows leave all three row statistics exactly where they are)

    r_from = rg if reading_from == "gradient" else rv
    r_to = rg2 if reading_to == "gradient" else rv2
    tbl_to = tg if reading_to == "gradient" else tv
    dkey = D["rank_key"][reading_to][r_to]
    pt_to = tbl_to[level]["points"][f"{subset}@{dkey}"]
    # P54 V1: the drone is no longer a function of (subset, rank) - `dkey`'s payload is ANOTHER
    # row's content at that ring. A drone row that really moves the rank sounds the listener's
    # OWN content at the ring of the new rank (the decision above the side file's notes), read
    # from the side file's drone half; theta stays the ring's, i.e. dkey's table theta. "same"
    # and an unmoved rank keep the lookup of the row's own payload in `reading_to`'s table (the
    # other reading's payload for "same" - pinned on THAT reading's body, which the hold loads:
    # `body_to` below). The clave and
    # arp rows pin the body, so for them pt_to only feeds the held body estimate (its theta).
    own_r_to = D["rk"][reading_to][i]
    if (D.get("v1") and spec["family"] == "drone" and direction in ("lo", "hi")
            and r_to != own_r_to):
        pt_to = _rw_v1_drone(level, subset, key, reading_to, r_to, pt_to)
    # THE OTHER READING'S BODY (P54 V1, fix round 3, 2026-10-04). A drone row held under the
    # reading you are NOT on plays a payload pinned on that reading's mode amps, rings and comb, so
    # the hold must load that BODY too - its room's /rw_identity, the same bytes rw_set_stat would
    # send - or SC renders the payload on the wrong body (measured: 0.5-2.6 dB median level error,
    # up to ~18 dB, and the wrong timbre). Only where the two bodies really differ, so on pre-P54
    # tables (one body per room) nothing extra is sent and the replies are unchanged.
    body_to = None
    if (spec["family"] == "drone" and reading_to != reading_from
            and _rw_reading_body_differs(level, subset, reading_to)):
        body_to = (tbl_to[level]["ident"][subset], reading_to)
    cb = D["clave_base"]
    # An unmoved rank re-uses the TABLE's own number rather than the formula, so "does not
    # move" is exact rather than exact-to-the-rounding, and a release gives back the
    # listener's own values bit for bit.
    rate_to = (pt_own[2] if rv2 == rv else
               min(max(RW_PULSAR_HZ[0] + (RW_PULSAR_HZ[1] - RW_PULSAR_HZ[0]) * rv2 / span,
                       RW_PULSAR_HZ[0]), RW_PULSAR_HZ[1]))
    form_to = (pt_own[3] if rm2 == rm else
               cb * (1.0 - RW_CLAVE_SWING / 2.0 + RW_CLAVE_SWING * rm2 / span))
    acc_to = (int(pt_own[4]) if rg2 == rg else
              int(round(RW_ACCENT_RANGE[1]
                        - (RW_ACCENT_RANGE[1] - RW_ACCENT_RANGE[0]) * rg2 / span)))

    fam = spec["family"]
    moves = {"body": None, "tempo": None, "colour": None, "metre": None, "arp": None}
    aud, near = [], []          # (layer, ok) and (layer, one line) - the layer decides which
    if r_to != r_from:
        d_theta = float(pt_to[0]) - float(pt_own[0])
        d01 = abs(r_to - r_from) / span
        # 0.60 dB is the matched null with the drone ALONE; 0.78 dB is the same state re-bowed
        # under the full mix. WHICH FLOOR APPLIES IS NOW A FACT ABOUT THE ROW, not about the
        # listener's mixer: under the isolation rule a drone row plays the drone ALONE, with
        # the tick muted and the chord not spawned, so the solo null is the one it is heard
        # against however high the other faders are. On any other row the body is pinned and
        # this number is an estimate of what is being WITHHELD, so the mix null is the fair
        # one to quote for it.
        thr = (RW_GATES["body_solo"]["threshold"] if fam == "drone"
               else RW_GATES["body_mix"]["threshold"])
        db = RW_DB_PER_PI * abs(d_theta) / math.pi
        moves["body"] = {"rank_from": r_from, "rank_to": r_to, "n": n,
                         "theta_from": round(float(pt_own[0]), 5),
                         "theta_to": round(float(pt_to[0]), 5),
                         "d_theta": round(d_theta, 5), "d_db_est": round(db, 3)}
        if reading_to != reading_from:
            # the two ranks are read off two different statistics, so say which is which
            # rather than letting "rank 12 -> 140 of 141" imply one ordering.
            moves["body"]["reading_from"] = reading_from
            moves["body"]["reading_to"] = reading_to
        if body_to is not None:
            # the ring estimate covers the theta move only; the body itself changes too (another
            # mode table and comb), for which no calibrated gate exists - so it is not called
            # inaudible (the same rule as a content-only change, below), and (fix 2026-10-04) it
            # carries NO dB figure either: the legend printed the ring-only number ("~0.04 dB")
            # on a hold whose timbre changes. The ring figure is kept, under its own name.
            moves["body"]["body_switch"] = True
            moves["body"]["d_db_ring"] = moves["body"]["d_db_est"]
            moves["body"]["d_db_est"] = None
            aud.append(("body", True))
        aud.append(("body", d01 >= thr))
        if d01 < thr and body_to is None:
            near.append(("body",
                         f"the body moves ~{db:.2f} dB, at or under the bow-noise floor"))
    elif D.get("v1") and fam == "drone":
        # P54 V1 (fix 2026-10-04): THE RANK IS NOT THE WHOLE STORY ANY MORE. A drone is the row's
        # own content at its ring, so a hold that lands on the SAME rank number under the OTHER
        # reading ("same", or an off-reading lo/hi whose end equals your live rank) still sends
        # a different payload - the other reading's content and pressure at the same ring
        # (d_theta = 0 on the midpoint grid). Decided from what is SENT, never from ranks read
        # off two different statistics. No calibrated gate exists for a content-only change
        # (the anchor measures the ring), so it carries no dB estimate and is not called
        # inaudible. On V1 tables "same" lands here on every point (with the other reading's
        # body loaded for the hold, `body_to`).
        sent_ = [float(pt_to[0]), float(pt_to[1])] + _rw_gains(pt_to)
        own_ = [float(pt_own[0]), float(pt_own[1])] + _rw_gains(pt_own)
        if sent_ != own_:
            moves["body"] = {"rank_from": r_from, "rank_to": r_to, "n": n,
                             "theta_from": round(float(pt_own[0]), 5),
                             "theta_to": round(float(pt_to[0]), 5),
                             "d_theta": round(float(pt_to[0]) - float(pt_own[0]), 5),
                             "d_db_est": None, "content_changes": True}
            if reading_to != reading_from:
                moves["body"]["reading_from"] = reading_from
                moves["body"]["reading_to"] = reading_to
            if body_to is not None:
                moves["body"]["body_switch"] = True
            aud.append(("body", True))
    if rv2 != rv:
        lo, hi = sorted((float(pt_own[2]), float(rate_to)))
        moves["tempo"] = {"hz_from": round(float(pt_own[2]), 4), "hz_to": round(float(rate_to), 4)}
        ok = (hi / lo if lo > 1e-9 else 99.0) >= RW_GATES["tempo"]["threshold"]
        aud.append(("tempo", ok))
        if not ok:
            near.append(("tempo",
                         f"the tempo moves {lo:.2f}->{hi:.2f} Hz, under the 1.15x convention"))
    if rm2 != rm:
        cents = 1200.0 * math.log(float(form_to) / float(pt_own[3]), 2.0)
        moves["colour"] = {"hz_from": round(float(pt_own[3]), 2),
                           "hz_to": round(float(form_to), 2), "cents": round(cents, 1)}
        ok = abs(cents) >= RW_GATES["colour"]["threshold"]
        aud.append(("colour", ok))
        if not ok:
            near.append(("colour", f"the colour moves {cents:+.0f} cents, under a semitone"))
    if acc_to != int(pt_own[4]):
        moves["metre"] = {"from": int(pt_own[4]), "to": int(acc_to)}
        aud.append(("metre", True))

    # THE LAYER UNDER TEST, PLUS THE LAYERS BENEATH IT AS A STILL BED (see RW_BED).
    # `own_*` is the listener's own payload, which is bit for bit what a release re-sends -
    # so the bed and the restore are the same two messages and there is no third copy of the
    # state to drift. `pushed_clave` is the one thing the audibility filter needs from here:
    # it is True only when a clave triple that actually MOVES went out.
    sends = []
    pushed_clave = False
    own_drone = ("drone", [float(pt_own[0]), float(pt_own[1])] + _rw_gains(pt_own))
    own_clave = ("clave", [float(pt_own[2]), float(pt_own[3]), int(pt_own[4]),
                           1 if RW_PREVIEW_BED_FORCE_CLAVE else 0])
    off_reading = (spec["kind"] == "stat" and spec.get("stat")
                   and spec["stat"] != reading_from and direction in ("lo", "hi"))
    if fam == "drone":
        sends.append(("drone", [float(pt_to[0]), float(pt_to[1])] + _rw_gains(pt_to)))
        if RW_DRONE_OFFREADING == "clave" and off_reading:
            # OPTION (c), one line: keep the tick on the one row whose whole content it is.
            sends.append(("clave", [float(rate_to), float(form_to), int(acc_to), 1]))
            pushed_clave = True
        else:
            # A DISTINCT VERB, and both halves of it are load-bearing (measured live):
            # /rw_mix clave=0 does mute the tick but it is the LISTENER's fader and a preview
            # must not drag it; /rw_preview ["clave", r, f, a, 0] rewrites rate/formant/accent
            # and leaves claveAmp alone, which on a drone row leaves the tick running AT THE
            # PUSHED TEMPO - worse than today. ["claveoff"] sets \claveAmp 0 AND ~rwClaveOn
            # false, because OSCdef(\rwMix) re-writes claveAmp whenever ~rwClaveOn is true and
            # a fader touch mid-hold would otherwise un-mute the row. The name is deliberately
            # NOT "clave": _rw_preview_own re-sends a clave for any hold whose verbs contain
            # "clave", which after a drone row would force the tick on as the finger lifts.
            sends.append(("claveoff", []))
    elif fam == "clave":
        sends.append(own_drone)          # pinned, rather than merely assumed still
        sends.append(("clave", [float(rate_to), float(form_to), int(acc_to), 1]))
        pushed_clave = True
    elif spec["kind"] == "arp":
        sends.append(own_drone)
        sends.append(own_clave)
        st = _rw_level_stats(level)
        gap_from, notes = _rw_chord(level, subset, key)
        certs = [float(nt[2]) for nt in notes]
        cert_from = sum(certs) / len(certs) if certs else 0.0
        out_notes, gap_to, cert_to = notes, gap_from, cert_from
        if spec["arp"] == "density":
            rich = 0.0 if direction == "lo" else st["rich_max"]
            # THE SAME LAW arp_species.py uses, and it no longer divides by the note count:
            # the gap is richness alone, so this must not reach for len(notes) either.
            _poor = RW_GAP_POOR[level]
            _rich = _poor / RW_DENSITY_CONTRAST[level]
            gap_to = _poor + (_rich - _poor) * min(rich / RW_RICHNESS_REF, 1.0)
            gap_to = min(max(gap_to, RW_GAP_CLAMP[0]), RW_GAP_CLAMP[1])
            ok = abs(gap_to / gap_from - 1.0) >= RW_GATES["arp_gap"]["threshold"] if gap_from else False
            aud.append(("arp", ok))
            if not ok:
                near.append(("arp", f"the gap moves {gap_from:.2f}->{gap_to:.2f} s, under 5%"))
        elif spec["arp"] == "pitch":
            # AN ISOLATE, NOT A PUSH, and that was checked rather than assumed: in
            # all:2023-2026, 145 species have exactly one distinct frequency each. Pitch is a
            # property of (species, selection), not of your row - your row only chooses WHICH
            # species - so there is no row-level quantity to push, and any chip that re-pitched
            # your notes would be inventing data. What sounds is exactly ONE of your own notes,
            # at its own pitch, amp and cert, with your own gap: a state navigation already
            # produces (46 L1 windows have no chord, many have one note).
            out_notes = [notes[0]] if direction == "only_lo" else [notes[-1]]
            cert_to = float(out_notes[0][2])
            aud.append(("arp", len(notes) > 1))
        else:                                            # beating
            cert_to = st["cert_lo"] if direction == "lo" else st["cert_hi"]
            out_notes = [[nt[0], nt[1], cert_to] for nt in notes]
            ok = abs(cert_to - cert_from) >= RW_GATES["cert"]["threshold"]
            aud.append(("arp", ok))
            if not ok:
                near.append(("arp", f"confidence moves {cert_from:.3f}->{cert_to:.3f}, "
                                    f"under the 0.05 convention"))
        hzs = [float(nt[0]) for nt in notes]
        moves["arp"] = {"notes": len(out_notes),
                        "gap_from": round(float(gap_from), 4), "gap_to": round(float(gap_to), 4),
                        "assembly_from": round(float(gap_from) * max(len(notes) - 1, 0), 3),
                        "assembly_to": round(float(gap_to) * max(len(out_notes) - 1, 0), 3),
                        "cert_from": round(cert_from, 4), "cert_to": round(float(cert_to), 4),
                        "hz_lo": round(min(hzs), 2) if hzs else None,
                        "hz_hi": round(max(hzs), 2) if hzs else None,
                        "note_hz": (round(float(out_notes[0][0]), 2)
                                    if spec["arp"] == "pitch" else None)}
        if spec["arp"] == "beating" and _rw_chord_settable():
            # THE ONE ARP CHANGE THAT IS A STEADY-STATE PROPERTY OF A RINGING NOTE: instant,
            # gapless, no respawn. Only worth it while the listener's own chord is actually
            # sounding; otherwise there is nothing to set and the chord has to be spawned.
            sends.append(("cert", [float(cert_to)] * max(len(notes), 1)))
        else:
            args = [float(gap_to), len(out_notes)]
            for nt in out_notes:
                args += [float(nt[0]), float(nt[1]), float(nt[2])]
            sends.append(("chord", args))

    # `column` NAMES THE DATASET COLUMN (Miguel 2026-09-25). Null for the row-statistic rows,
    # whose (i) names all sixteen - the reply carries `columns` at the top level for that.
    column = None
    if spec["kind"] == "index":
        j = RW_PUSH[level]["chip_col"][spec["feature"]]
        clo, chi = RW_PUSH[level]["col_range"][j]
        column = {"name": RW_PUSH[level]["columns"][j], "raw_lo": clo, "raw_hi": chi,
                  "your_raw": round(clo + D["V"][i][j] * (chi - clo), 6)}
    elif spec["kind"] == "arp":
        st = _rw_level_stats(level)
        if spec["arp"] == "density":
            column = {"name": NSP_COL, "raw_lo": 0.0,
                      "raw_hi": round(st["rich_max"], 3),
                      "your_raw": st["nsp"].get(key)}
        elif spec["arp"] == "pitch":
            column = {"name": "top_species_k*_common", "unit": "Hz",
                      "rank_by": "occurrence (how many windows a species appears in) "
                                 "within your selection",
                      "ties": "top_species_k*_n_det",
                      "raw_lo": moves["arp"]["hz_lo"], "raw_hi": moves["arp"]["hz_hi"],
                      "your_raw": moves["arp"]["note_hz"]}
        else:
            column = {"name": "top_species_k*_conf_mean",
                      "raw_lo": round(st["cert_lo"], 4), "raw_hi": round(st["cert_hi"], 4),
                      "your_raw": moves["arp"]["cert_from"],
                      "gate": RW_CONF_GATE}
    rho = None
    rr = _rw_rho(level, subset)
    if column and column.get("name") in rr:
        rho = rr[column["name"]]

    # WHAT THIS ROW SOUNDS, AND THEREFORE WHAT IT IS ALLOWED TO CLAIM. The bed is the
    # listener's own payload, so a layer that is only in the bed cannot carry this push:
    # `heard` is derived from what actually went out, never declared, so option (c) and a
    # False RW_PREVIEW_BED_FORCE_CLAVE stay honest without a second rule to keep in step.
    heard = {"body"} if fam == "drone" else {"arp"} if fam == "arp" else set()
    if pushed_clave:
        heard |= {"tempo", "colour", "metre"}
    held = {k: v for k, v in moves.items() if v is not None and k not in heard}
    moves = {k: (v if k in heard else None) for k, v in moves.items()}
    audible = any(ok for lay, ok in aud if lay in heard)
    near_heard = [t for lay, t in near if lay in heard]
    if audible:
        why = ""
    elif near_heard:
        why = "; ".join(near_heard)
    elif held:
        why = ("this push reaches only the " + ", ".join(sorted(held))
               + ", which this row holds still - nothing it plays moves on this point")
    else:
        why = "nothing moves on this point"
    twin = None
    # Against the reading the HOLD is under, not the live one: under option (b) a drone row
    # for the other statistic is twinned with that statistic's clave row, and saying so is
    # the only way the (i) can explain why its twin is silent.
    pair = RW_TWINS.get(reading_to)
    if pair and row in pair:
        twin = pair[1] if pair[0] == row else pair[0]
    bed = dict(RW_BED[fam])
    if fam == "drone" and pushed_clave:                      # option (c) only
        bed = {"plays": "drone", "still": (), "muted": (), "silent": ("arp", "corpus")}
    bed = {k: (list(v) if isinstance(v, tuple) else v) for k, v in bed.items()}
    bed["note"] = _rw_bed_note(fam, bed, held, twin, reading_from, reading_to, spec)
    notes = _rw_bed_notes(fam, held, twin, reading_from, reading_to, spec, direction)
    if body_to is not None:
        # V1 only, so the pre-P54 replies are unchanged byte for byte
        bed["note"] += (f"; under P54 the {reading_to} reading has its own body (its own mode "
                        f"table and comb), so that body is loaded for the hold and yours comes "
                        f"back on release")
    return {"moves": moves, "moves_held": held, "bed": bed, "notes": notes,
            "audible": audible, "why": why, "column": column, "rho": rho,
            "twin": twin, "reading": reading_to, "_sends": sends,
            "_verbs": tuple(v for v, _a in sends),
            "_body": (None if body_to is None else
                      (_rw_ident_args(level, subset, body_to[0]), _rw_body_key(body_to[0]),
                       body_to[1]))}


# ---- WHAT THE LISTENER IS HEARING, IN WORDS ----------------------------------------------
# ON THE WIRE RATHER THAN IN THE PAGE, deliberately. Two consequences of the isolation rule
# have to be SURFACED rather than papered over, and neither is visible from the sound:
#   * clave.metre no longer moves the body, so the verified twin (accent == round(7 - 5*r/(n-1))
#     for the gradient rank r on every WINDOW point - the only points this tier runs on; not on
#     the month roll-ups, see RW_TWINS, corrected 2026-10-01, rank form 2026-10-04) stops being
#     HEARD as one push arriving twice and
#     becomes a label. The reply has always carried `twin`; now it has to say it.
#   * clave.index.* genuinely move the body on ~398 of 400 points, and pinning it hides a real
#     consequence - so the dB estimate keeps being reported, with the reason it is not heard.
# legend.js prints `why` only when `audible` is false, so these sentences need one line in the
# page to appear (append reply.bed.note and reply.notes to the status line and the (i)). They
# are named fields rather than smuggled into `why` because a string that only shows up when a
# chip is inaudible is exactly the wrong channel for "this is what you ARE hearing".
_RW_LAYER_WORD = {"body": "the body", "tempo": "the tick's rate",
                  "colour": "the tick's colour", "metre": "the tick's metre",
                  "arp": "the chord"}


def _rw_bed_note(fam, bed, held, twin, reading_from, reading_to, spec):
    """One sentence: what is sounding, and what is holding still under it."""
    if fam == "drone":
        if bed["muted"]:
            s = ("the drone alone - the tick is muted for as long as you hold this, so what "
                 "moves is the body and nothing else")
        else:
            s = "the drone, with the tick left running (option c: this row is labelled)"
        if reading_to != reading_from:
            s += (f"; and for the length of the hold the body reads {reading_to} rather than "
                  f"{reading_from}, which is what makes this row audible at all")
        return s
    if fam == "clave":
        return ("the tick, over a body pinned at your own point - so what moves is the tick "
                "and nothing else")
    return ("the chord, over a body and a tick pinned at your own values - so what moves is "
            "the chord and nothing else")


def _rw_bed_notes(fam, held, twin, reading_from, reading_to, spec, direction):
    """The consequences of the bed, one line each, in the order they matter."""
    out = []
    if fam == "drone" and reading_to != reading_from:
        st = spec.get("stat")
        out.append(f"this row does two things at once: it switches the body to the "
                   f"{reading_to} reading AND pushes {reading_to} to its "
                   f"{'low' if direction == 'lo' else 'high'} extreme. Read it as 'if you "
                   f"read {st}, this is what {'low' if direction == 'lo' else 'high'} {st} "
                   f"sounds like in the body'.")
    b = held.get("body")
    if b:
        out.append(f"the body would also move ~{abs(b['d_db_est']):.2f} dB; it is held still "
                   f"here so you can hear the "
                   f"{'chord' if fam == 'arp' else 'tick'} alone.")
    for lay in ("tempo", "colour", "metre"):
        h = held.get(lay)
        if not h:
            continue
        if lay == "tempo":
            what = f"from {h['hz_from']:.2f} to {h['hz_to']:.2f} Hz"
        elif lay == "colour":
            what = f"by {h['cents']:+.0f} cents"
        else:
            what = f"from every {h['from']} to every {h['to']} ticks"
        out.append(f"{_RW_LAYER_WORD[lay]} would also move {what}; the tick is muted on this "
                   f"row, so you cannot hear it here.")
    if twin and any(held.get(k) for k in ("body", "tempo", "metre")):
        out.append(f"one push, two layers: this is the same push as {twin}. Under the "
                   f"isolation rule you hear it in one layer at a time, so the twin is a "
                   f"label on this row rather than something you can hear twice.")
    if fam == "drone" and _rw_chord_ringing():
        out.append("your own chord from the last point is still ringing under this; it "
                   "releases on its own in a moment.")
    return out


# ---- the four commands -------------------------------------------------------------------
def rw_preview_send(verb: str, args):
    """ONE new OSC address, and it never touches ~rwState, ~rwMix, ~rwSubset, the identity or
    the navigation timeline - which is the whole reason it exists."""
    if not _osc_ok():
        return
    try:
        _SEND_OSC("/rw_preview", [verb] + list(args))
    except OSError:
        pass


def _rw_preview_own(verbs):
    """Give back exactly what the listener had, as ordinary previews, for the verbs the hold
    actually used. The bridge re-sends them because it ALREADY HOLDS them (RW_LAST_POINT plus
    the table); duplicating that state in SC is how two copies drift. Only what the hold moved:
    re-sending a clave the hold never touched would force the tick on under an arp row.

    A DRONE ROW IS EXACTLY THAT CASE, which is why its mute is the verb "claveoff" and not a
    "clave" with on=0: "clave" is not in its verb set, so nothing here re-sends a tick, and
    rw_preview.scd's ~rwPreviewClear puts the tick back the way the hold FOUND it."""
    if RW_LAST_POINT is None:
        return
    level, key = RW_LAST_POINT
    pt = ((RW.get(level) or {}).get("points") or {}).get(f"{RW_SUBSET.get(level)}@{key}")
    if pt is None:
        return
    if "drone" in verbs:
        rw_preview_send("drone", [float(pt[0]), float(pt[1])] + _rw_gains(pt))
    if "clave" in verbs:
        rw_preview_send("clave", [float(pt[2]), float(pt[3]), int(pt[4]), 1])


def rw_preview_hold(row: str, direction: str) -> dict:
    """A1. Push ONE quantity to its extreme on the point the listener is standing on."""
    global RW_PREVIEW, RW_LAST_IDENT
    level, key = RW_LAST_POINT if RW_LAST_POINT else (None, None)
    subset = RW_SUBSET.get(level) if level else None
    spec = RW_ROW_SPEC.get(row)
    out = {"type": "legend_preview", "row": row, "dir": direction, "level": level,
           "key": key, "subset": subset, "reading": RW_STAT, "gates": RW_GATES,
           "columns": (RW_PUSH.get(level) or {}).get("columns") if level else None,
           "statistic": spec.get("stat") if spec else None,
           "label": spec.get("label") if spec else None,
           "audible": False, "why": "", "blocked": False, "ignored": False, "twin": None,
           "moves": {"body": None, "tempo": None, "colour": None, "metre": None, "arp": None},
           "moves_held": {}, "bed": None, "notes": [], "column": None, "rho": None}
    block = _rw_row_block(level, subset, key, row, direction)
    if block:
        out["blocked"] = True
        out["why"] = block
        return out
    try:
        ev = _rw_push_eval(level, subset, key, row, direction)
    except (KeyError, IndexError, TypeError, ValueError, ZeroDivisionError) as e:
        # A malformed table or side file must not take the socket down mid-show. Say so and
        # play nothing - the same failure path the self-check uses.
        print(f"  [rw] legend: {row}/{direction} could not be evaluated: {e!r}")
        out["blocked"] = True
        out["why"] = "this row could not be evaluated on this point"
        return out
    out.update({k: ev[k] for k in ("moves", "moves_held", "bed", "notes", "audible", "why",
                                   "column", "rho", "twin")})
    out["reading"] = ev["reading"]
    if RW_PREVIEW is not None:
        # NESTED HOLDS: the first one wins and later ones are ignored until a release, which is
        # the same rule the old bracket kept. The reply still carries the arithmetic, so the
        # (i) can show what this row WOULD do without a second finger changing the sound.
        out["ignored"] = True
        return out
    body = ev.get("_body")
    if body is not None:
        # THE OTHER READING'S BODY FIRST (P54 V1): /rw_identity sets the room's freqs, amps,
        # rings, comb and its resting gains; the drone preview after it puts the held payload's
        # gains and pressure on that body - in that order, exactly as a reading switch's
        # identity + /rw_drone + /rw_point do. RW_LAST_IDENT then names the body the engine
        # REALLY holds, so a hold ended without a release (a navigation, a stat switch, a dead
        # page) can never leave a later point of this room playing on the other reading's
        # body: the next rw_send_identity sees another key and re-sends the room.
        # EXCEPT WHEN NOTHING IS ON RECORD (fix 2026-10-04): None is attach()'s "forget what the
        # engine was told", and it is what makes the next rw_send_identity run the level branch
        # that re-sends the listener's mix to a restarted engine. Overwriting it with the held
        # key swallowed that reset (the release then re-sent the room but not /rw_mix). None
        # never equals a key, so the release, the next press or a stat switch still re-sends
        # the room - and the mix after it, in the order the engine's identity handler needs.
        if _osc_ok():
            try:
                _SEND_OSC("/rw_identity", list(body[0]))
                if RW_LAST_IDENT is not None:
                    RW_LAST_IDENT = (RW_TCHAN, level, subset, body[1])
            except OSError:
                pass
    for verb, args in ev["_sends"]:
        rw_preview_send(verb, args)
    RW_PREVIEW = {"row": row, "dir": direction, "verbs": set(ev["_verbs"]),
                  "t": time.monotonic(),
                  "body": (level, body[2]) if body is not None else None}
    # A PREVIEW CHORD REPLACES THE LISTENER'S (P36, P38): SC gates the notes already in, spawns
    # none of the rest while it is held, and once it has cut into the chord drops the rest of it
    # this commit. So from here the chord cannot be set by position - later beating holds spawn
    # their own and nothing restores certs onto it - UNLESS the hold is released before the first
    # note, in which case SC plays the chord whole and rw_preview_release un-marks it. `dt < off`,
    # not `on <= dt`: a chord that reaches SC just before the first note is covered too.
    if "chord" in ev["_verbs"] and _RW_COMMIT["off"] > 0 \
            and time.monotonic() - _RW_COMMIT["t"] < _RW_COMMIT["off"]:
        RW_PREVIEW["unmark"] = (_RW_COMMIT["t"], _RW_COMMIT["last"], _RW_COMMIT["off"])
        _RW_COMMIT["off"] = _RW_COMMIT["last"] = -1.0
    return out


def _rw_preview_own_cert():
    """THE LISTENER'S OWN CONFIDENCES BACK ON THEIR RINGING CHORD (TASKS P36). A beating hold
    on a ringing chord sets \\cert on the listener's OWN notes - there is no preview chord to
    stop - and `end` touches only preview notes, so the pushed confidence stayed on the chord
    until it released (~1.2 s). Sent AFTER `end`: "cert" goes to the preview notes while any
    exist, and `end` removes them, so from here it can only land on the listener's own. Notes
    already released are skipped in SC (~rwAlive)."""
    if RW_LAST_POINT is None:
        return
    level, key = RW_LAST_POINT
    _gap, notes = _rw_chord(level, RW_SUBSET.get(level), key)
    if notes:
        rw_preview_send("cert", [float(nt[2]) for nt in notes])


def rw_preview_release():
    """A2. RELEASE ORDER, exactly: own drone preview -> own clave preview -> end -> own
    confidences (only after a beating hold that set them on the ringing chord). `end` does not
    restore anything by itself, on purpose: the numbers come from here, where they already
    live. Tolerates an end without a start - a cached page must not be able to leave a preview
    stuck, so a bare `end` is still forwarded."""
    global RW_PREVIEW
    held = RW_PREVIEW
    RW_PREVIEW = None
    # a chord hold released BEFORE the first note: SC (P38) plays this commit's chord whole, in
    # spawn order, so it is settable again. 0.1 s of margin: a release that races the first note
    # stays "cut", which costs a respawn - the other error would send "cert" to no notes at all.
    if held is not None and held.get("unmark"):
        t0, last, off = held["unmark"]
        if _RW_COMMIT["t"] == t0 and time.monotonic() - t0 < _RW_COMMIT["on"] - 0.1:
            _RW_COMMIT["last"], _RW_COMMIT["off"] = last, off
    if held is not None and held.get("body"):
        # THE LISTENER'S OWN BODY BACK FIRST (P54 V1): the room in force under the reading in
        # force. rw_send_identity re-sends it because RW_LAST_IDENT names the held body; the
        # level is unchanged, so the level-default (mixer) branch does not fire - unless the
        # hold came straight after a page attach (RW_LAST_IDENT None), when it re-sends the
        # listener's mix after the identity, exactly as the press it stands in for would have.
        # Then the own payload, as for every hold, puts the gains and pressure back on it.
        lv = held["body"][0]
        if lv in RW:
            rw_send_identity(lv, RW_SUBSET[lv])
    if held is not None:
        _rw_preview_own(held["verbs"])
    rw_preview_send("end", [])
    if held is not None and "cert" in held["verbs"]:
        _rw_preview_own_cert()


def rw_preview_abort():
    """A navigation or a reading change ends a hold without restoring the OLD point - the
    commit that follows is about to set everything anyway. That includes an off-reading hold's
    BODY (P54 V1): RW_LAST_IDENT names the held body, so the commit's rw_send_identity re-sends
    the room unless the new reading's body IS the held one (a switch to that reading)."""
    global RW_PREVIEW
    if RW_PREVIEW is None:
        return
    RW_PREVIEW = None
    rw_preview_send("end", [])


def rw_preview_probe() -> dict:
    """A3. No sound: "for the point I am on, what would every row do?". One round trip instead
    of thirty, so the UI can print each row's REAL numbers for the point in front of the
    listener and dim the chips that cannot clear the floor."""
    level, key = RW_LAST_POINT if RW_LAST_POINT else (None, None)
    subset = RW_SUBSET.get(level) if level else None
    # `channel`: the tables in force - what the legend describes is what SOUNDS, not the page's
    # pick (after air -> water the air window plays on until a water point is pressed)
    out = {"type": "legend_probe", "level": level, "key": key, "subset": subset,
           "channel": RW_TCHAN if RW_LAST_POINT else None,
           "reading": RW_STAT, "gates": RW_GATES,
           "columns": (RW_PUSH.get(level) or {}).get("columns") if level else None,
           "twins": RW_TWINS.get(RW_STAT), "rows": {}, "blocked": {}}
    for rid, spec in RW_ROW_SPEC.items():
        dirs = list(spec["dirs"])
        if (spec["family"] == "drone" and spec.get("stat") != RW_STAT
                and not _rw_row_block(level, subset, key, rid, "same")):
            dirs.append("same")                  # only on the row for the reading you are NOT on
        blocked = _rw_row_block(level, subset, key, rid)
        if blocked:
            out["blocked"][rid] = blocked
            continue
        ent = {"label": spec["label"], "family": spec["family"],
               "statistic": spec.get("stat"), "dirs": dirs,
               "lo": None, "hi": None, "same": None, "only_lo": None, "only_hi": None,
               "audible": {}, "why": {}, "held": {}, "notes": {}, "bed": None,
               "column": None, "rho": None, "twin": None}
        for d in dirs:
            try:
                ev = _rw_push_eval(level, subset, key, rid, d)
            except (KeyError, IndexError, TypeError, ValueError, ZeroDivisionError) as e:
                out["blocked"][rid] = "this row could not be evaluated on this point"
                print(f"  [rw] legend: probe {rid}/{d} failed: {e!r}")
                ent = None
                break
            ent[d] = ev["moves"]
            ent["audible"][d] = ev["audible"]
            ent["why"][d] = ev["why"]
            ent["held"][d] = ev["moves_held"]
            ent["notes"][d] = ev["notes"]
            ent["bed"] = ev["bed"]
            ent["column"] = ev["column"]
            ent["rho"] = ev["rho"]
            ent["twin"] = ev["twin"] or ent["twin"]
        if ent is not None:
            out["rows"][rid] = ent
    return out


def rw_set_stat(stat: str):
    """Swap which reading of the data the body is under, live.

    gradient and variance are the same rows under two statistics. PRE-P54 they differed in
    EXACTLY the /rw_drone payload - theta, pressure, the 35 gains - and the resting gains: the
    subset identity (comb, base, clave base, all modes), the clave triple, the arp and the corpus
    were identical between them, so there was no retune and no page re-init.
    UNDER P54 V1 (fix 2026-10-04) THE BODY IS PER READING TOO: the two readings share the mode
    freqs, base and clave base, NOT the mode amps (so not the rings) and NOT the comb (up to
    ~295x and 14 Hz apart, air L0). The clave triple, arp and corpus are still identical. So on a
    sounding point the re-voice below re-sends the room's identity of the NEW reading in the same
    burst as /rw_drone + /rw_point - rw_send_identity keys on the body (_rw_body_key), not on
    the reading, so on tables whose two bodies are equal (pre-P54, archive) nothing extra goes.
    Still deliberately does NOT clear RW_LAST_IDENT on a sounding point: the level is unchanged,
    so the level-default branch in rw_send_identity (which would silently reset the four layer
    faders) cannot fire; only the body key differs."""
    global RW_LAST_IDENT
    stat = str(stat or RW_STAT_DEFAULT)
    if stat not in ("gradient", "variance") or stat == RW_STAT:
        return
    if not load_rw(stat, RW_TCHAN):
        return
    print(f"  [rw] drone reading -> {stat}")
    # The observational correlations are taken against THIS reading's theta, and which of the
    # two drone rows offers the "= yours, other reading" chip flips with it, so both caches go.
    _RW_RHO.clear()
    if rw_resting():
        # RESTING (P20): no point of this room is sounding, so re-voicing the last one would
        # fall back to `all` and lose the room. The resting gains ARE per reading (2-10% apart),
        # so the room's identity is re-sent - with the level unchanged, so the level-default
        # branch (and the listener's faders) are not touched. Only when there IS an identity to
        # get past: RW_LAST_IDENT is None after a display reload (attach), and then the
        # level branch is exactly what must run - it re-sends the listener's mix to an engine
        # that may have been restarted with its own defaults (review 2026-09-27).
        level = RW_LAST_POINT[0]
        if RW_LAST_IDENT is not None:
            RW_LAST_IDENT = (RW_TCHAN, level, None, None)
        rw_send_identity(level, RW_SUBSET[level])
    elif RW_LAST_POINT is not None:                # re-voice under the listener's hand
        rw_send_point(RW_LAST_POINT[0], RW_LAST_POINT[1])


def rw_send_mix():
    if _osc_ok():
        try:
            # SILENCED (a channel without tables is on screen): SC gets zeros, the listener's
            # RW_MIX - what the faders show - is untouched and comes back with the next point.
            _SEND_OSC("/rw_mix", [0.0] * len(RW_MIX) if _RW_SILENCED
                      else [float(x) for x in RW_MIX])
        except OSError:
            pass



_RW_ISO_WARNED = set()


def legend_relay(m: dict):
    """Browser -> legend. FOUR commands, and a reply for the two that have one to make.

        {cmd:"hold",    row:"<one of the fifteen>", dir:"lo"|"hi"|"same"|"only_lo"|"only_hi"}
        {cmd:"release"}                     ("end" stays an alias FOREVER - see below)
        {cmd:"probe"}                       no sound; what would every row do here?
        {cmd:"mute",    value:0|1}          unchanged, still /rw_master

    Returns the dict to send back to the REQUESTER, or None. The mix echo (dispatch) is
    untouched and a preview never triggers it - that absence is the guarantee that the faders
    do not twitch on a hold.

    DEPRECATED, ACCEPTED FOR ONE RELEASE: {cmd:"iso", feature, value} is what the shipped
    legend.js sends. It maps onto a hold. "end" is accepted as a release alias with no
    deprecation warning at all and no expiry date, because a page cached in someone's browser
    must never be able to leave a preview stuck on the engine."""
    cmd = m.get("cmd")
    if cmd == "iso":
        feature = str(m.get("feature") or m.get("driver") or "")
        try:
            value = float(m.get("value", 0.5))
        except (TypeError, ValueError):
            value = 0.5
        row = "arp.density" if feature == "nsp" else f"clave.index.{feature}"
        if row not in RW_ROW_SPEC:
            print(f"  [rw] legend: unknown deprecated feature {feature!r}, ignored")
            return None
        if feature not in _RW_ISO_WARNED:
            _RW_ISO_WARNED.add(feature)
            print(f"  [rw] legend: DEPRECATED {{cmd:'iso', feature:'{feature}'}} -> "
                  f"{{cmd:'hold', row:'{row}'}}; this page is a release behind")
        return rw_preview_hold(row, "lo" if value < 0.5 else "hi")
    if cmd == "hold":
        row = str(m.get("row") or "")
        direction = str(m.get("dir") or "")
        if row not in RW_ROW_SPEC:
            print(f"  [rw] legend: unknown row {row!r}, ignored")
            return None
        if direction not in RW_ROW_SPEC[row]["dirs"] and direction != "same":
            print(f"  [rw] legend: {row} has no direction {direction!r}, ignored")
            return None
        return rw_preview_hold(row, direction)
    if cmd in ("release", "end"):
        rw_preview_release()
        return None
    if cmd == "probe":
        return rw_preview_probe()
    if cmd == "mute":
        if _osc_ok():
            try:
                _rw_master_mute(int(m.get("value", 0)))   # an un-mute brings the volume back (P51)
            except OSError:
                pass                                      # the master echo follows (dispatch)
        return None
    if cmd:
        print(f"  [rw] legend: unknown command {cmd!r}, ignored")
    return None


def master_relay(m: dict):
    """Browser MASTER control -> SC /rw_master ['vol', 0..1] | ['mute', 0|1].

    This was still addressed to /dark_master after the v2 port, which nothing listens for,
    so the master fader and mute were silently dead. Since 2026-10-01 each message that went
    out also moves SOUND["master"] the way SC moves its bus (_rw_master_sent, below), an
    un-mute is sent as the volume the listener had (_rw_master_mute, P51), and dispatch
    echoes the result."""
    if not _osc_ok():
        return
    try:
        if m.get("vol") is not None:
            _vol = max(0.0, min(1.0, float(m["vol"])))
            _SEND_OSC("/rw_master", ["vol", _vol])
            _rw_master_sent("vol", _vol)
        if m.get("mute") is not None:
            _rw_master_mute(int(bool(m["mute"])))      # an un-mute brings the volume back (P51)
    except (OSError, TypeError, ValueError):
        pass


# ============================================================================
# THE CHANNELS' DATA THE COOKING READS - handed over with load_channel
# ============================================================================
# CHANNELS: display channel ("air", "water", "air+water") -> its bundle. The core reads ONLY
# bundle["rows"] - the L1 windows in index order, each with y, m, d and win - to turn a page's widx
# into a point key (rw_navigate); and a `channel` message is answered only for a channel listed here.
# The desktop keeps its whole view bundle in this dict (bridge.build_channel, put here by whoever
# boots it); the web hands over {"rows": ...} with load_channel.
CHANNELS: dict = {}
# RETURNER: table channel -> {"l0": {"YYYY-MM": clip id | None}, "l1": {widx: clip id | None}}: the
# month's phenological highlight (bridge.compute_returners), voiced beside the focal clip
# (rw_send_point reads "l0"). CLIP IDS, as in the tables (the module docstring).
RETURNER: dict = {}


def load_channel(ch: str, payload: dict):
    """What the cooking needs from one display channel, as plain data. Each key is optional and
    replaces only itself:
        rows        [{"y", "m", "d", "win", ...}, ...]  the L1 windows; index = widx (an init
                    payload's "rows" will do)
        returner    {"l0": {"YYYY-MM": clip id | None}, "l1": {widx: clip id | None}}
                    (for a TABLE channel, air or water; bridge.build_channel)
        raw_series  {"L1": {feature: [[raw value, key], ...] sorted by value}}  (bridge.load_rows):
                    the push tier's n_species_analysed per window and its ceiling (_rw_level_stats)
    The desktop's loaders call it for returner and raw_series; whoever boots the desktop puts the
    whole bundle in CHANNELS itself."""
    if "rows" in payload:
        b = CHANNELS.get(ch)
        if b is None:
            CHANNELS[ch] = {"rows": payload["rows"]}
        else:
            b["rows"] = payload["rows"]
    if payload.get("returner") is not None:
        RETURNER[ch] = payload["returner"]
    for lvl, series in (payload.get("raw_series") or {}).items():
        _RW_RAW_SERIES[(lvl, ch)] = series
        _RW_LEVEL_STATS.pop(lvl, None)             # a rebuild must not serve a stale ranking


def load_tables(ch: str, stat: str, level: str, table: dict):
    """Hand over one sound table: rw_tables_<level>_<stat>.json of table channel `ch` as parsed
    JSON, its corpus as clip IDS (bridge.read_rw_tables gives exactly that). Parsed on first use,
    both levels or neither (_rw_tables). A channel other than air is playable once both readings
    at both levels are in: the caller then adds it to RW_TABLE_CHANNELS, as bridge.py's __main__
    does, and calls load_rw_push."""
    _TABLE_DATA[(ch, stat, level)] = table
    _RW_CACHE.pop((ch, stat), None)


def load_push(ch: str, level: str, side: dict):
    """Hand over one push side file: rw_push_<level>.json of table channel `ch`. load_rw_push
    derives every table channel's (call it after the tables are in)."""
    _PUSH_DATA[(ch, level)] = side


# ============================================================================
# THE MASTER (2026-10-01, web Phase 1; lab/WEB_PLAN.md section 2.7 #1)
# ============================================================================
# The bridge relayed /rw_master and kept nothing, so every view link drew the slider at 0.8,
# unmuted, over an engine that could be anywhere: the UI disagreed with SC after any navigation.
# Now the bridge OWNS the master, as it owns the mix: SOUND["master"] is what SC is doing, echoed
# as {type:"master", vol, mute} to every page after each change, to a page when it attaches, and
# on mixquery; wc.js paints the slider and the mute button from it (applyMaster).
# SC KEEPS ONE BUS. OSCdef(\rwMaster) (sc/parse_dark_re_wilding.scd:286-289): `vol v` sets it to
# v - so moving the volume also un-mutes, the rule kept here - `mute 1` sets it to 0, and any
# other mute value sets it to 1.0 (the bridge sends none any more: an un-mute goes out as `vol`).
# _rw_master_sent applies that rule to each message that went out, so SOUND is what SC is doing
# after every one of them.
# AN UN-MUTE RETURNS TO THE VOLUME YOU HAD (Miguel 2026-10-01, TASKS P51), SENT AS THAT VOLUME
# ALONE: _rw_master_mute turns every un-mute - the MASTER button's or the legend's - into
# /rw_master vol <the volume before the mute>. SC's `vol` sets the bus, so it un-mutes by itself,
# straight from 0 to the volume. Not `mute 0` + `vol`: SC's `mute 0` sets the bus to 1.0, and an
# scsynth audio callback falling between the two would play it for ~11.6 ms, a bump through
# \rwLimiter's 0.05 s Lag (DECISIONS 2026-10-01). A volume of 0.0 un-mutes at silence: it is the
# volume you had, and the slider shows 0.00. A mute is still `mute 1`. Until 2026-10-01 an un-mute
# was SC's own `mute 0`, heard at 1.0 whatever the slider showed.
# The start, 1.0 and unmuted, is SC's own (parse:32 sets the bus to 1); SC sends nothing back, so
# a bridge restarted against an engine someone had muted shows it unmuted until the master is
# next touched. The web sets its own start (0.8, D10) before a page attaches.
SOUND = {"master": {"vol": 1.0, "mute": 0}}


def _rw_master_sent(verb: str, x):
    """SOUND["master"] after SC applied one /rw_master message (SC's rule, above)."""
    s = SOUND["master"]
    if verb == "vol":
        s["vol"], s["mute"] = float(x), 0
    elif int(x) == 1:
        s["mute"] = 1
    else:
        s["vol"], s["mute"] = 1.0, 0


def _rw_master_mute(x: int):
    """A MUTE (x == 1) is /rw_master mute 1. An UN-MUTE (any other x, as SC reads it) is sent as
    /rw_master vol <the volume before the mute> (P51): SC's `vol` un-mutes by itself, straight from
    0 to that volume, where its own un-mute would set 1.0. SOUND follows SC after the message."""
    if int(x) == 1:
        _SEND_OSC("/rw_master", ["mute", x])
        _rw_master_sent("mute", x)
    else:
        vol = float(SOUND["master"]["vol"])
        _SEND_OSC("/rw_master", ["vol", vol])
        _rw_master_sent("vol", vol)


def master_echo() -> dict:
    """{type:"master", vol, mute}: what the MASTER controls paint (wc.js applyMaster); mute 0 | 1."""
    return {"type": "master", "vol": SOUND["master"]["vol"], "mute": SOUND["master"]["mute"]}


# ============================================================================
# THE PAGE PROTOCOL: attach / dispatch / detach (bridge.py's ws_handler until 2026-10-01)
# ============================================================================
def attach(client):
    """A page connected (the desktop: its WebSocket opened; the web: the shell attached a view)."""
    global RW_LAST_IDENT
    if client not in CLIENTS:
        CLIENTS.append(client)
    rw_client_new(client)                        # takes the sound if nobody holds it (P35)
    # A FRESH PAGE MEANS FORGET WHAT THE ENGINE WAS TOLD. The identity is deduplicated on
    # (channel, level, subset, body), which is right while one engine runs behind one display - but the two
    # are separate processes with separate launchers, so restarting the sound alone leaves
    # this side certain it has already sent a mode table that the new engine never received.
    # The drone then sits on the SynthDef's flat defaults and every point sounds the same,
    # silently. Clearing here makes "reload the display" the honest remedy it looks like:
    # the next point press re-sends the whole body. The level-default branch in
    # rw_send_identity is safe to re-enter - it is guarded by RW_MIX_USER, so a fader the
    # listener has actually moved survives, and an untouched one is rewritten to the value
    # it already holds.
    RW_LAST_IDENT = None
    if _INIT_PAYLOAD is not None:                # the web's host answers init from its baked files
        _reply(client, _INIT_PAYLOAD("air"))
    _reply(client, master_echo())                # the MASTER controls paint the engine's state


def detach(client):
    """A page went away (the desktop: its WebSocket closed; the web: pagehide)."""
    if client in CLIENTS:
        CLIENTS.remove(client)
    rw_client_gone(client)                       # its rooms go with it; it gives up the sound (P35)
    # A PAGE THAT DIES WITH A CHIP HELD SENDS NO RELEASE. That was survivable while the
    # worst a stranded hold could leave behind was a tick forced ON; since the isolation
    # rule a drone row leaves it MUTED, and silence that outlives the finger is a live-show
    # hazard rather than a curiosity. Releasing here gives back the listener's own drone
    # and clave and lets rw_preview.scd's ~rwPreviewClear put the tick back the way the
    # hold found it. Unconditional on purpose: with two tabs open this can end a hold the
    # OTHER tab still has down, which costs that tab an early restore - and its own
    # finger-up then sends a second release, which is idempotent. The alternative, a
    # muted body under a dead page until the next navigation, is not recoverable by ear.
    if RW_PREVIEW is not None:
        rw_preview_release()


def dispatch(client, m: dict):
    """ONE page message: {type: channel | drv | select | mix | mixquery | legend | spectral_day |
    master | stat}. OSC goes out through send_osc; a reply goes to `client` (send_json); the mix and
    the master are echoed to every page (broadcast) when they changed, and on mixquery. The order is
    the order ws_handler sent them in before the split. `hover` (no page sends it) and `loop`
    (/dark_loop: nothing in SC v2 listens) are gone, and like any unknown type do nothing."""
    global RW_CHANNEL, RW_MIX_USER
    t = m.get("type")
    _mix_was = list(RW_MIX)
    _master_was = dict(SOUND["master"])
    if t == "channel":                                   # air <-> water switch
        ch = m.get("channel", "air")
        if ch in CHANNELS and _INIT_PAYLOAD is not None:
            _reply(client, _INIT_PAYLOAD(ch))
    elif t == "drv":                                     # navigate to a point
        # v2: four layers from the precomputed tables. The old path sent
        # /dark_nav + /dark_arp + /dark_corpus + /dark_returner; all of that is
        # replaced by the /rw_* protocol, which carries the subset's mode table
        # only when the SELECTION changes and a handful of floats per point.
        lvl = int(m.get("level", 1))
        ch = m.get("channel") or "air"
        if ch != RW_CHANNEL:
            # n_species_analysed and the chord table are per channel, and so are the
            # observational correlations taken over them.
            _RW_LEVEL_STATS.clear(); _RW_RHO.clear()
        RW_CHANNEL = ch
        # client: this view takes the sound, and its rooms with it (P35)
        rw_navigate(lvl, ch, mkey=m.get("mkey"), widx=m.get("widx"), win=m.get("win"),
                    client=client)
    elif t == "select":                                  # the current SELECTION
        # per view (P35): retunes only for the view that is playing - see rw_client_select
        rw_client_select(client, m.get("level", 1), m.get("subset"))
    elif t == "mix":                                     # the four faders
        for _i, _k in enumerate(("drone", "clave", "arp", "corpus")):
            if m.get(_k) is not None:
                RW_MIX[_i] = max(0.0, min(1.0, float(m[_k])))
        RW_MIX_USER = True                   # from here the faders are the listener's
        rw_send_mix()
    elif t == "mixquery":                                # a page asking where the mix is
        pass                                             # the echoes below answer it
    # `soundmode` (synth|corpus|both) is GONE. It was v1's model, where the corpus was
    # an ALTERNATIVE to the synthesis; v2 made it layer four of a ladder, and the four
    # faders are the control. What was left behind was a preset that overwrote RW_MIX
    # on every connect and every channel switch - and its default, "synth", is
    # [1, 1, 1, 0]. That is why the corpus could not be heard at any level: the page
    # silenced it a moment after loading, every time. Old pages sending it are ignored.
    elif t == "legend":                                  # perceptual legend preview
        # THE REPLY GOES TO THE REQUESTER ONLY. A preview is one listener's question
        # about the point under their own finger; broadcasting it would have a second
        # tab redraw its (i) for a point it is not on. The /rw_mix echo below stays a
        # broadcast, and a preview never triggers it.
        _reply_ = legend_relay(m)
        if _reply_ is not None:
            _reply(client, _reply_)
    elif t == "spectral_day":                            # spectro/mfcc DAY resolution
        # REQUESTER ONLY, like the legend: one page asking for one month of days. The
        # type must NOT start with "legend_" - legend.js routes those to itself.
        if _SPECTRAL_DAY is not None:
            _reply(client, _SPECTRAL_DAY(m))
    elif t == "master":                                  # MASTER volume / mute
        master_relay(m)
    elif t == "stat":                                    # which reading the drone is under
        rw_set_stat(m.get("stat"))

    # THE FADERS RENDER SERVER STATE. This side owns RW_MIX; the pages own only the
    # gesture. Anything that moved the mix without the user touching a fader - a level
    # change applying its defaults, the legacy soundmode preset - used to leave four
    # sliders reading 1.00 over an engine that had arp and corpus at 0, so "the
    # sliders don't work" was really "the sliders were never told". Echo to EVERY
    # client, not just the one that acted, or a second tab drifts the moment you
    # navigate in the first.
    if list(RW_MIX) != _mix_was or t == "mixquery":
        _broadcast({"type": "mix", "drone": RW_MIX[0], "clave": RW_MIX[1],
                    "arp": RW_MIX[2], "corpus": RW_MIX[3]})
    # THE MASTER, THE SAME WAY (2026-10-01): to every page after a change (the slider, the
    # mute, the legend's mute) and on mixquery - which every view sends once its init has
    # drawn - so a view link opens on the engine's volume and mute, not on 0.8 and unmuted.
    if SOUND["master"] != _master_was or t == "mixquery":
        _broadcast(master_echo())
