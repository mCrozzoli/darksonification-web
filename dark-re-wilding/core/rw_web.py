"""dark_re_wilding — web build · the bridge core's glue (runs INSIDE Pyodide; also importable natively for the gate).

viz/bridge.py runs here UNCHANGED (copied to core/bridge.py by build_web.py). This file does what the
desktop's process boundary did around it:
  · stubs the two socket libraries the module imports and pins its ports, so importing it in a browser
    has no side effects (bridge.py picks free ports at import time);
  · loads the state the loaders would have built with pandas on the Mac (rows, returner, raw series),
    baked by build/build_data.py, and the sound tables + push side files from the file system;
  · `handle(client, raw)` = the per-message body of bridge.py's ws_handler, synchronous, with the mix
    echo it keeps after each message — a mirror, line for line, until the design session's Phase 1
    hands the bridge its own dispatch() (WEB_PLAN.md §4 P1); then this file shrinks to the stubs;
  · OSC goes out through `rw_js.sendOsc(addr, typed_json)` with EXPLICIT types (python-osc sends a
    Python int as int32 and a float as float32; osc.js's untyped fallback would send 1.0 as an int).
"""
import json
import os
import sys
import types

# ---------------------------------------------------------------- import-time side effects, defused
os.environ.setdefault("HTTP_PORT_OVERRIDE", "1")      # bridge.py:194-200 would bind sockets at import
os.environ.setdefault("WS_PORT_OVERRIDE", "1")
os.environ.setdefault("VIZ_NO_DEATHWATCH", "1")
if "websockets" not in sys.modules:
    try:
        import websockets  # noqa: F401  (present natively; absent in Pyodide)
    except ImportError:
        sys.modules["websockets"] = types.ModuleType("websockets")
if "pythonosc.udp_client" not in sys.modules:
    try:
        from pythonosc.udp_client import SimpleUDPClient  # noqa: F401
    except ImportError:
        _po = types.ModuleType("pythonosc"); _uc = types.ModuleType("pythonosc.udp_client")

        class SimpleUDPClient:                                  # never used: sc_client is replaced below
            def __init__(self, *a, **k): pass

            def send_message(self, *a, **k): pass
        _uc.SimpleUDPClient = SimpleUDPClient; _po.udp_client = _uc
        sys.modules["pythonosc"] = _po; sys.modules["pythonosc.udp_client"] = _uc

ROOT = os.environ.get("RW_WEB_ROOT", "/rw")           # the file-system root the JS side writes into
sys.dont_write_bytecode = True
if os.path.join(ROOT, "viz") not in sys.path:
    sys.path.insert(0, os.path.join(ROOT, "viz"))
import bridge as B  # noqa: E402

rw_js = None                                           # set by the host: sendOsc(addr, json), deliver(client, json), broadcast(json)
MIX_KEYS = ("drone", "clave", "arp", "corpus")


def typed(v):
    if isinstance(v, bool):
        return ["i", int(v)]
    if isinstance(v, int):
        return ["i", v]
    if isinstance(v, float):
        return ["f", v]
    return ["s", str(v)]


class WebOSC:
    """bridge.py's sc_client: every message leaves with its types spelled out."""
    def send_message(self, addr, args):
        args = list(args) if isinstance(args, (list, tuple)) else [args]
        rw_js.sendOsc(addr, json.dumps([typed(a) for a in args]))


def _load(name):
    with open(os.path.join(ROOT, "data", name), "r", encoding="utf-8") as fh:
        return json.load(fh)


def boot():
    """What verify_rw_pages.py's boot() does, minus the pandas loaders (baked): rows for the channels,
    the returner map, the raw series, then the tables of both channels in both readings, the push side
    files, and the fake-socket client."""
    for ch in ("air", "water"):
        B.CHANNELS[ch] = {"rows": _load(f"rows_{ch}.json")}
    B.CHANNELS["air+water"] = {"rows": B.CHANNELS["air"]["rows"]}   # build_combined: the relationship view on air's rows
    ret = _load("returner.json")
    for ch in ret:
        if "l1" in ret[ch]:
            ret[ch]["l1"] = {int(k): v for k, v in ret[ch]["l1"].items()}
    B.RETURNER.clear(); B.RETURNER.update(ret)
    B._RW_RAW_SERIES.clear()
    for lvl, ch, v in _load("raw_series.json"):
        B._RW_RAW_SERIES[(lvl, ch)] = v
    B.load_rw("gradient"); B.load_rw("variance"); B.load_rw(B.RW_STAT_DEFAULT)
    for tch in ("water",):
        if B._rw_tables("gradient", tch) and B._rw_tables("variance", tch):
            B.RW_TABLE_CHANNELS.add(tch)
    B.load_rw_push()
    B.sc_client = WebOSC()
    B.RW_LAST_IDENT = None
    return json.dumps({"table_channels": sorted(B.RW_TABLE_CHANNELS), "push_ok": dict(B.RW_PUSH_OK),
                       "rows": {ch: len(B.CHANNELS[ch]["rows"]) for ch in ("air", "water")}})


def _mix_msg():
    return json.dumps({"type": "mix", "drone": B.RW_MIX[0], "clave": B.RW_MIX[1], "arp": B.RW_MIX[2], "corpus": B.RW_MIX[3]})


def client_new(client):
    """ws_handler's opening lines: the page takes the sound if nobody holds it; a fresh page means
    forget what the engine was told (bridge.py:3042-3054)."""
    B.clients.add(client)
    B.rw_client_new(client)
    B.RW_LAST_IDENT = None


def client_gone(client):
    """ws_handler's finally: its rooms go with it; a page that dies with a chip held sends no release."""
    B.clients.discard(client)
    B.rw_client_gone(client)
    if B.RW_PREVIEW is not None:
        B.rw_preview_release()


def handle(client, raw):
    """ONE page message, as ws_handler routes it (bridge.py:3057-3143). `init`/`channel` and
    `spectral_day` are answered by the host from baked files and never reach here."""
    try:
        m = json.loads(raw) if isinstance(raw, str) else dict(raw)
    except ValueError:
        return
    t = m.get("type")
    _mix_was = list(B.RW_MIX)
    if t == "hover" and m.get("idx") is not None:                    # legacy: idx into a channel's rows
        rws = (B.CHANNELS.get(m.get("channel", "air")) or {}).get("rows", [])
        i = int(m["idx"])
        if 0 <= i < len(rws):
            B.rw_navigate(1, str(m.get("channel", "air")), widx=i, client=client)
    elif t == "drv":                                                 # navigate to a point
        lvl = int(m.get("level", 1))
        ch = m.get("channel") or "air"
        if ch != B.RW_CHANNEL:
            B._RW_LEVEL_STATS.clear(); B._RW_RHO.clear()
        B.RW_CHANNEL = ch
        B.rw_navigate(lvl, ch, mkey=m.get("mkey"), widx=m.get("widx"), win=m.get("win"), client=client)
    elif t == "select":
        B.rw_client_select(client, m.get("level", 1), m.get("subset"))
    elif t == "mix":
        for _i, _k in enumerate(MIX_KEYS):
            if m.get(_k) is not None:
                B.RW_MIX[_i] = max(0.0, min(1.0, float(m[_k])))
        B.RW_MIX_USER = True
        B.rw_send_mix()
    elif t == "mixquery":
        pass
    elif t == "legend":
        reply = B.legend_relay(m)
        if reply is not None:
            rw_js.deliver(client, json.dumps(reply))
    elif t == "master":
        B.master_relay(m)
    elif t == "stat":
        B.rw_set_stat(m.get("stat"))
    elif t == "loop":                                                # /dark_loop: nothing in v2 listens
        pass
    if list(B.RW_MIX) != _mix_was or t == "mixquery":
        rw_js.broadcast(_mix_msg())


def replay():
    """After SuperCollider (re)boots: it has none of this state. The mix first (the engine's own mix is
    all 1), then the last point, whose identity is re-sent because RW_LAST_IDENT is cleared."""
    B.RW_LAST_IDENT = None
    B.rw_send_mix()
    lp = B.RW_LAST_POINT
    if lp:
        B.rw_send_point(*lp)


def state():
    """Read-back for the checks: what the bridge believes."""
    return json.dumps({"subset": dict(B.RW_SUBSET), "last_point": B.RW_LAST_POINT, "stat": B.RW_STAT,
                       "tchan": B.RW_TCHAN, "channel": B.RW_CHANNEL, "mix": list(B.RW_MIX), "mix_user": B.RW_MIX_USER,
                       "last_ident": list(B.RW_LAST_IDENT) if B.RW_LAST_IDENT else None,
                       "owner": B.RW_ROOM_OWNER, "rooms": {str(k): v for k, v in B._RW_CLIENT_ROOM.items()},
                       "preview": (B.RW_PREVIEW or {}).get("row") if B.RW_PREVIEW else None})
