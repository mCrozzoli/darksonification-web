"""dark_re_wilding — web build · the bridge core's glue (runs INSIDE Pyodide; also importable natively for the gate).

viz/rw_core.py runs here UNCHANGED (copied to core/rw_core.py by build_web.py): the cooking, its state and the
page protocol attach / dispatch / detach (web Phase 1, viz/HANDOFF_WEB_2026-10-01.md). This file is what the
desktop shell (viz/bridge.py) is around the core, minus the sockets:
  · the transport (rw_core.bind): OSC leaves through `rw_js.sendOsc(addr, typed_json)` with EXPLICIT types — the
    core sends Python floats, ints and strs and python-osc tags f / i / s from the type, so does this (osc.js's
    untyped fallback would send 1.0 as an int); a reply to one page goes through `rw_js.deliver(client, json)`,
    an echo to every page through `rw_js.broadcast(json)`;
  · the data the shell's pandas loaders build on the Mac, baked by build/build_data.py: the channels' rows, the
    returner map and the raw series (load_channel), the sound tables and push side files as the dicts
    bridge.read_rw_tables / read_rw_push return — clip ids inside (load_tables / load_push) — then load_rw and
    load_rw_push exactly as bridge.py's __main__ does (handoff §2.2);
  · `init` and `spectral_day` stay unbound: the host (engine.js) answers them from the baked files, and
    dispatch() does nothing for those two types (handoff §2.1);
  · the master: the core owns and echoes it (handoff §4, one owner). The web's start is seeded before the first
    page attaches — WEB_MASTER, 0.8 unmuted (D10: the page's slider started at 0.8) — SC's own start is 1.0.
"""
import json
import os
import sys

ROOT = os.environ.get("RW_WEB_ROOT", "/rw")           # the file-system root the JS side writes into
sys.dont_write_bytecode = True
if os.path.join(ROOT, "core") not in sys.path:
    sys.path.insert(0, os.path.join(ROOT, "core"))
import rw_core as C  # noqa: E402  (standard library only; importing it does nothing)

rw_js = None                                           # set by the host: sendOsc(addr, json), deliver(client, json), broadcast(json)
WEB_MASTER = {"vol": 0.8, "mute": 0}                   # the web's start (D10); engine.js keeps the same literal for the seconds before the core is up


def typed(v):
    if isinstance(v, bool):
        return ["i", int(v)]
    if isinstance(v, int):
        return ["i", v]
    if isinstance(v, float):
        return ["f", v]
    return ["s", str(v)]


def send_osc(addr, args):
    """rw_core's send_osc: every message leaves with its types spelled out."""
    args = list(args) if isinstance(args, (list, tuple)) else [args]
    rw_js.sendOsc(addr, json.dumps([typed(a) for a in args]))


def send_json(client, d):
    rw_js.deliver(client, json.dumps(d))


def broadcast(d):
    rw_js.broadcast(json.dumps(d))


def _load(*parts):
    path = os.path.join(ROOT, "data", *parts)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def boot(master_json=None):
    """bridge.py __main__'s boot, with the baked data in place of the pandas loaders (handoff §2.2–2.3)."""
    C.bind(send_osc, send_json, broadcast)
    ret = _load("returner.json") or {}
    raw = {}
    for lvl, ch, v in _load("raw_series.json") or []:
        raw.setdefault(ch, {})[lvl] = v
    for ch in ("air", "water"):
        r = dict(ret.get(ch) or {})
        if "l1" in r:
            r["l1"] = {int(k): v for k, v in r["l1"].items()}
        C.load_channel(ch, {"rows": _load(f"rows_{ch}.json") or [], "returner": r, "raw_series": raw.get(ch, {})})
    C.load_channel("air+water", {"rows": C.CHANNELS["air"]["rows"]})   # build_combined: the relationship view on air's rows
    for tch in ("air", "water"):
        for st in ("gradient", "variance"):
            for lv in ("L0", "L1"):
                t = _load("tables", tch, f"rw_tables_{lv}_{st}.json")
                if t is not None:
                    C.load_tables(tch, st, lv, t)
        for lv in ("L0", "L1"):
            p = _load("push", tch, f"rw_push_{lv}.json")
            if p is not None:
                C.load_push(tch, lv, p)
    C.load_rw("gradient"); C.load_rw("variance"); C.load_rw(C.RW_STAT_DEFAULT)
    if C._rw_tables("gradient", "water") and C._rw_tables("variance", "water"):
        C.RW_TABLE_CHANNELS.add("water")                # as bridge.py __main__ does; the core does not add it itself
    C.load_rw_push()                                   # after the tables: every channel in RW_TABLE_CHANNELS
    seed = json.loads(master_json) if master_json else WEB_MASTER
    C.SOUND["master"].update(vol=float(seed["vol"]), mute=int(seed["mute"]))
    C.RW_LAST_IDENT = None
    return json.dumps({"table_channels": sorted(C.RW_TABLE_CHANNELS), "push_ok": dict(C.RW_PUSH_OK),
                       "rows": {ch: len(C.CHANNELS[ch]["rows"]) for ch in ("air", "water")},
                       "master": dict(C.SOUND["master"])})


def attach(client):
    """A page's socket opened: the core takes it on (rooms, the sound if nobody holds it) and echoes the master."""
    C.attach(client)


def detach(client):
    """A page went away: its rooms go, a held chip is released."""
    C.detach(client)


def dispatch(client, raw):
    """ONE page message. `channel` and `spectral_day` are answered by the host from baked files before this."""
    try:
        m = json.loads(raw) if isinstance(raw, str) else dict(raw)
    except ValueError:
        return
    C.dispatch(client, m)


handle = dispatch                                      # the pre-Phase-1 name, for the checks


def replay():
    """After SuperCollider (re)boots: it has none of this state. The mix first (the engine's own mix is
    all 1), then the last point, whose identity is re-sent because RW_LAST_IDENT is cleared."""
    C.RW_LAST_IDENT = None
    C.rw_send_mix()
    lp = C.RW_LAST_POINT
    if lp:
        C.rw_send_point(*lp)


def master():
    """The master the core holds: {vol, mute}; engine.js reads it for the chip, the first gesture and the replay."""
    return json.dumps(dict(C.SOUND["master"]))


def state():
    """Read-back for the checks: what the core believes."""
    return json.dumps({"subset": dict(C.RW_SUBSET), "last_point": C.RW_LAST_POINT, "stat": C.RW_STAT,
                       "tchan": C.RW_TCHAN, "channel": C.RW_CHANNEL, "mix": list(C.RW_MIX), "mix_user": C.RW_MIX_USER,
                       "last_ident": list(C.RW_LAST_IDENT) if C.RW_LAST_IDENT else None,
                       "owner": C.RW_ROOM_OWNER, "rooms": {str(k): v for k, v in C._RW_CLIENT_ROOM.items()},
                       "preview": (C.RW_PREVIEW or {}).get("row") if C.RW_PREVIEW else None,
                       "master": dict(C.SOUND["master"]), "clients": list(C.CLIENTS)})
